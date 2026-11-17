import * as THREE from 'three';

/**
 * Keeps planted feet planted.
 *
 * Clips are blended, the body turns, a statue settles from a stride into its frozen pose: in
 * all of these the animated foot would glide across the floor. The planter pins a foot's ankle
 * where it touched down and bends the leg to reach it (two-bone IK). When the pose has moved
 * too far from the pinned spot it takes a real step there, lifting the foot. Turning on the
 * spot therefore becomes a shuffle of small steps instead of a frictionless swivel.
 */

interface Foot {
  thigh: THREE.Object3D;
  calf: THREE.Object3D;
  foot: THREE.Object3D;
  /** The ball of the foot: the point that stays on the ground through heel-lift. */
  ball: THREE.Object3D;
  /** Rest height of the ball above the ground, model units. */
  ballHeight: number;
  locked: boolean;
  /** Pinned position of the ball of the foot in world space. */
  pin: THREE.Vector3;
  stepping: boolean;
  stepFrom: THREE.Vector3;
  stepTime: number;
  stepDuration: number;
  /** 0..1 blend of the IK correction. */
  weight: number;
}

const H = new THREE.Vector3();
const K = new THREE.Vector3();
const A = new THREE.Vector3();
const B = new THREE.Vector3();
const T = new THREE.Vector3();
const dir = new THREE.Vector3();
const pole = new THREE.Vector3();
const K2 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const qPelvis = new THREE.Quaternion();
const qThigh = new THREE.Quaternion();
const qCalf = new THREE.Quaternion();
const qFoot = new THREE.Quaternion();
const d1 = new THREE.Quaternion();
const d2 = new THREE.Quaternion();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/** Analytic two-bone IK: bend thigh and calf so the ankle reaches `target`, keeping the knee's direction and the foot's world orientation. */
function solveLeg(f: Foot, target: THREE.Vector3): void {
  f.thigh.getWorldPosition(H);
  f.calf.getWorldPosition(K);
  f.foot.getWorldPosition(A);
  const l1 = K.distanceTo(H);
  const l2 = A.distanceTo(K);
  if (l1 < 1e-5 || l2 < 1e-5) return;
  T.copy(target).sub(H);
  let d = T.length();
  if (d < 1e-5) return;
  dir.copy(T).divideScalar(d);
  // Keep the leg from locking perfectly straight or folding flat.
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 0.002), (l1 + l2) * 0.9995);

  // The knee keeps pointing where the animation had it pointing.
  pole.copy(K).sub(H);
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-8) {
    // Straight leg: bend forwards relative to the foot.
    f.foot.getWorldQuaternion(qa);
    pole.set(0, 0, 1).applyQuaternion(qa);
    pole.addScaledVector(dir, -pole.dot(dir));
  }
  pole.normalize();

  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  K2.copy(H).addScaledVector(dir, cosA * l1).addScaledVector(pole, sinA * l1);

  f.thigh.parent!.getWorldQuaternion(qPelvis);
  f.thigh.getWorldQuaternion(qThigh);
  f.calf.getWorldQuaternion(qCalf);
  f.foot.getWorldQuaternion(qFoot);

  // Thigh: swing so the knee lands on K2.
  v1.copy(K).sub(H).normalize();
  v2.copy(K2).sub(H).normalize();
  d1.setFromUnitVectors(v1, v2);
  // Calf: after the thigh's swing, aim the shin at the target.
  v1.copy(A).sub(K).normalize().applyQuaternion(d1);
  v2.copy(H).addScaledVector(dir, d).sub(K2).normalize();
  d2.setFromUnitVectors(v1, v2);

  // New world rotations, converted back to local.
  qa.copy(d1).multiply(qThigh); // thigh world
  f.thigh.quaternion.copy(qPelvis).invert().multiply(qa);
  qb.copy(d2).multiply(d1).multiply(qCalf); // calf world
  f.calf.quaternion.copy(qa).invert().multiply(qb);
  f.foot.quaternion.copy(qb).invert().multiply(qFoot); // foot keeps its world orientation
}

export class FootPlanter {
  enabled = false;
  private readonly feet: Foot[];

  constructor(
    private readonly root: THREE.Object3D,
    bones: (name: string) => THREE.Object3D | undefined,
    /** Rest height of the ball of the foot in model units. */
    ballHeight: number,
  ) {
    this.feet = (['l', 'r'] as const).map((side) => {
      const thigh = bones(`thigh_${side}`);
      const calf = bones(`calf_${side}`);
      const foot = bones(`foot_${side}`);
      const ball = bones(`ball_${side}`);
      if (!thigh || !calf || !foot || !ball) throw new Error('rig has no leg bones');
      return { thigh, calf, foot, ball, ballHeight, locked: false, pin: new THREE.Vector3(), stepping: false, stepFrom: new THREE.Vector3(), stepTime: 0, stepDuration: 0.18, weight: 0 };
    });
  }

  /** Forget all pins (call when the statue is frozen or teleported). */
  reset(): void {
    for (const f of this.feet) {
      f.locked = false;
      f.stepping = false;
      f.weight = 0;
    }
  }

  /**
   * Call after the pose has been written to the bones.
   * `settled` means the body is neither travelling nor turning, so even small offsets are
   * worth stepping out (the statue shuffles its feet into its final stance).
   */
  update(dt: number, settled: boolean): void {
    if (!this.enabled) return;
    this.root.updateMatrixWorld(true);
    const scale = this.root.scale.x;
    const stepAt = (settled ? 0.012 : 0.06) * scale;
    const forceAt = 0.15 * scale;
    const lift = 0.055 * scale;

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const other = this.feet[1 - i];
      f.ball.getWorldPosition(B);
      const planted = B.y - f.ballHeight * scale < 0.03 * scale;
      if (planted) {
        if (!f.locked) {
          f.locked = true;
          f.stepping = false;
          f.pin.copy(B);
        } else if (f.stepping) {
          f.stepTime += dt;
          const u = Math.min(1, f.stepTime / f.stepDuration);
          const e = u * u * (3 - 2 * u);
          f.pin.lerpVectors(f.stepFrom, B, e);
          f.pin.y = B.y + Math.sin(Math.PI * u) * lift;
          if (u >= 1) {
            f.stepping = false;
            f.pin.copy(B);
          }
        } else {
          const drift = Math.hypot(f.pin.x - B.x, f.pin.z - B.z);
          if (drift > stepAt && (!other.stepping || drift > forceAt)) {
            f.stepping = true;
            f.stepFrom.copy(f.pin);
            f.stepTime = 0;
            f.stepDuration = Math.min(0.24, 0.13 + (drift / scale) * 0.5);
          }
        }
        f.weight = Math.min(1, f.weight + dt * 14);
      } else {
        f.locked = false;
        f.stepping = false;
        f.weight = Math.max(0, f.weight - dt * 16);
      }
    }
    // Solve after both feet have been classified, since each solve changes bone rotations.
    for (const f of this.feet) {
      if (f.weight <= 0.001) continue;
      // Move the ankle by whatever brings the ball of the foot onto its pin; the foot keeps
      // its animated orientation, so heel-lift and toe-off still read.
      f.foot.getWorldPosition(A);
      f.ball.getWorldPosition(B);
      T.copy(f.pin).sub(B).multiplyScalar(f.weight).add(A);
      solveLeg(f, T);
    }
  }
}
