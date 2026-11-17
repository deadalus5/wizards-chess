import * as THREE from 'three';
import { solveTwoBone } from './ik';

/**
 * Keeps planted feet planted.
 *
 * Clips are blended, the body turns, a statue settles from a stride into its frozen pose: in
 * all of these the animated foot would glide across the floor. The planter pins a foot's ankle
 * where it touched down and bends the leg to reach it (two-bone IK). When the pose has moved
 * too far from the pinned spot it takes a real step there, lifting the foot. Turning on the
 * spot therefore becomes a shuffle of small steps instead of a frictionless swivel.
 *
 * A statue that is dragged rather than walks uses the other mode, `hold`: its feet are held
 * where its frozen stance puts them relative to the statue itself, soles flat, and never step.
 */

/** Where a statue's frozen stance puts one foot, in the statue's own ground frame at scale 1. */
export interface FootHold {
  /** The ball of the foot: x to the statue's left, y above the floor, z ahead. */
  ball: THREE.Vector3;
  /** The foot's orientation in the armature's frame. */
  rotation: THREE.Quaternion;
}

interface Held {
  stance: readonly [FootHold, FootHold];
  /** Where each foot was when the hold began: the same frame, but in metres. */
  from: { ball: THREE.Vector3; rotation: THREE.Quaternion }[];
  time: number;
  ease: number;
}

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
const pole = new THREE.Vector3();
const ahead = new THREE.Vector3();
const pin = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const qYaw = new THREE.Quaternion();
const qSole = new THREE.Quaternion();
const qPelvis = new THREE.Quaternion();
const qThigh = new THREE.Quaternion();
const qCalf = new THREE.Quaternion();
const qFoot = new THREE.Quaternion();
const d1 = new THREE.Quaternion();
const d2 = new THREE.Quaternion();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/**
 * Bend thigh and calf so the ankle reaches `target`, keeping the knee's direction. The foot
 * keeps its world orientation, or takes `sole` if one is given.
 */
function solveLeg(f: Foot, target: THREE.Vector3, sole?: THREE.Quaternion): void {
  f.thigh.getWorldPosition(H);
  f.calf.getWorldPosition(K);
  f.foot.getWorldPosition(A);
  f.thigh.parent!.getWorldQuaternion(qPelvis);
  f.thigh.getWorldQuaternion(qThigh);
  f.calf.getWorldQuaternion(qCalf);
  f.foot.getWorldQuaternion(qFoot);
  // A perfectly straight leg bends forwards relative to the foot.
  pole.set(0, 0, 1).applyQuaternion(qFoot);
  if (!solveTwoBone(H, K, A, target, pole, d1, d2)) return;

  // New world rotations, converted back to local.
  qa.copy(d1).multiply(qThigh); // thigh world
  f.thigh.quaternion.copy(qPelvis).invert().multiply(qa);
  qb.copy(d2).multiply(d1).multiply(qCalf); // calf world
  f.calf.quaternion.copy(qa).invert().multiply(qb);
  f.foot.quaternion.copy(qb).invert().multiply(sole ?? qFoot);
}

export class FootPlanter {
  enabled = false;
  /** Steps taken since the last reset (for checking that a slide takes none). */
  steps = 0;
  private readonly feet: Foot[];
  private held: Held | null = null;

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

  /** Forget all pins and any hold (call when the statue is frozen or teleported). */
  reset(): void {
    this.held = null;
    this.steps = 0;
    for (const f of this.feet) {
      f.locked = false;
      f.stepping = false;
      f.weight = 0;
    }
  }

  /** True while the feet are held to the statue's stance rather than pinned to the floor. */
  get holding(): boolean {
    return this.held !== null;
  }

  /**
   * Hold the feet where the frozen stance puts them relative to the statue itself: flat on the
   * floor, sliding and turning with it, never stepping. `ease` seconds are taken to bring them
   * there from wherever they are now, so nothing jumps.
   */
  hold(stance: readonly [FootHold, FootHold], ease = 0.25): void {
    this.enabled = true;
    this.root.updateMatrixWorld(true);
    qYaw.setFromAxisAngle(UP, -this.heading());
    const from = this.feet.map((f) => {
      f.locked = false;
      f.stepping = false;
      f.weight = 1;
      const ball = f.ball.getWorldPosition(new THREE.Vector3());
      ball.x -= this.root.position.x;
      ball.z -= this.root.position.z;
      ball.applyQuaternion(qYaw);
      return { ball, rotation: f.foot.getWorldQuaternion(new THREE.Quaternion()).premultiply(qYaw) };
    });
    this.held = { stance, from, time: 0, ease };
  }

  /** Stop holding: the feet go back to being pinned where they touch down. */
  release(): void {
    if (!this.held) return;
    this.held = null;
    for (const f of this.feet) {
      f.locked = false;
      f.stepping = false;
    }
  }

  /** The way the statue faces on the ground, whatever its lean. */
  private heading(): number {
    ahead.set(0, 0, 1).transformDirection(this.root.matrixWorld);
    return Math.atan2(ahead.x, ahead.z);
  }

  private updateHeld(dt: number): void {
    const held = this.held!;
    held.time += dt;
    const u = held.ease > 0 ? Math.min(1, held.time / held.ease) : 1;
    const k = u * u * (3 - 2 * u);
    const scale = this.root.scale.x;
    qYaw.setFromAxisAngle(UP, this.heading());
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const want = held.stance[i];
      const from = held.from[i];
      // Where the ball of the foot belongs and how the sole sits, in the statue's ground frame.
      pin.copy(want.ball).multiplyScalar(scale).sub(from.ball).multiplyScalar(k).add(from.ball);
      pin.applyQuaternion(qYaw);
      pin.x += this.root.position.x;
      pin.z += this.root.position.z;
      qSole.copy(from.rotation).slerp(want.rotation, k).premultiply(qYaw);
      // The ankle goes wherever puts the ball there with the sole lying as it should.
      T.copy(f.ball.position).multiplyScalar(scale).applyQuaternion(qSole);
      T.subVectors(pin, T);
      solveLeg(f, T, qSole);
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
    if (this.held) {
      this.updateHeld(dt);
      return;
    }
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
            this.steps++;
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
