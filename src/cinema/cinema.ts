import * as THREE from 'three';
import type { Pipeline } from '../render/pipeline';
import type { Hud } from '../ui/hud';
import type { CameraPose, CameraRig } from './cameraRig';

/** Something that can stand between the camera and its subjects: a statue, a brazier. */
export interface Obstacle {
  x: number;
  z: number;
  radius: number;
  height: number;
}

export interface Shot {
  pose: CameraPose;
  focus: THREE.Vector3;
}

/**
 * Cinematic shots: cuts the camera to a framed pose for a capture and back, and eases the
 * letterbox bars and depth of field that go with it. Film grammar, so cuts rather than
 * fly-throughs: a camera flying between statues clips through them and feels like a drone.
 */
export class Cinema {
  /** Off = the choreography plays but the camera is left alone (for inspecting it from fixed views). */
  enabled = true;
  /** Fixed scenery the camera must not sit inside or shoot through. */
  scenery: Obstacle[] = [];
  private letterbox = 0;
  private letterboxGoal = 0;
  private bokeh = 0;
  private readonly push = new THREE.Vector3();
  /** The shot as framed (the slow push-in moves this); the boom is added on top each frame. */
  private base: CameraPose | null = null;
  private boom = 0;
  private boomGoal = 0;

  constructor(
    private readonly rig: CameraRig,
    private readonly pipeline: Pipeline,
    private readonly hud: Hud,
  ) {}

  get active(): boolean {
    return this.letterboxGoal > 0;
  }

  /** Frame an attacker standing at `attacker` and a victim at `victim`. */
  twoShot(attacker: THREE.Vector3, victim: THREE.Vector3, viewer: THREE.Vector3, attackerHeight: number, victimHeight: number, top: number, statues: Obstacle[]): Shot {
    return chooseShot(attacker, victim, viewer, attackerHeight, victimHeight, top, this.pipeline.camera.aspect, [...statues, ...this.scenery]);
  }

  /** Cut to a shot. */
  cut(shot: Shot, bokeh = 7.5): void {
    if (!this.enabled) return;
    this.base = { position: shot.pose.position.clone(), target: shot.pose.target.clone(), fov: shot.pose.fov };
    this.boom = this.boomGoal = 0;
    this.rig.override = { position: shot.pose.position.clone(), target: shot.pose.target.clone(), fov: shot.pose.fov };
    this.rig.inputEnabled = false;
    this.pipeline.focus.copy(shot.focus);
    this.letterboxGoal = 1;
    // Depth of field comes on with the cut rather than easing in over a visible focus pull.
    this.bokeh = bokeh;
    this.hud.setCinema(true);
  }

  /** Cut back to the player's camera. */
  release(): void {
    if (!this.active) return;
    this.base = null;
    this.rig.override = null;
    this.rig.inputEnabled = true;
    this.letterboxGoal = 0;
    this.bokeh = 0;
    this.hud.setCinema(false);
  }

  /** `dt` is real time (bars and the slow push-in do not slow down with the action). */
  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 7);
    this.letterbox += (this.letterboxGoal - this.letterbox) * k;
    if (Math.abs(this.letterbox - this.letterboxGoal) < 0.002) this.letterbox = this.letterboxGoal;
    this.pipeline.letterbox.amount = this.letterbox;
    if (this.enabled) this.pipeline.setDepthOfField(this.bokeh, 3.6);

    const base = this.active ? this.base : null;
    const shot = this.rig.override;
    if (base && shot) {
      // A slow push-in keeps a held shot alive.
      this.push.copy(base.target).sub(base.position);
      const distance = this.push.length();
      if (distance > 2.2) base.position.addScaledVector(this.push, (0.12 * dt) / distance);
      // The boom rises and settles without ever snapping.
      this.boom += (this.boomGoal - this.boom) * (1 - Math.exp(-dt * 9));
      shot.position.copy(base.position);
      shot.position.y += this.boom;
      shot.target.copy(base.target);
      shot.target.y += this.boom * 0.92;
    }
  }

  /**
   * Raise the camera by `height` metres to follow something that leaves the floor (a leap).
   * Call every frame while it applies; 0 brings it back down.
   */
  lift(height: number): void {
    this.boomGoal = height;
  }
}

/**
 * How much stands on the sight line from the camera to a point: 1 for each obstacle in front
 * of it (hiding it), a fraction for each one close behind it (cluttering its outline).
 */
function blockers(cx: number, cy: number, cz: number, qx: number, qy: number, qz: number, obstacles: Obstacle[]): number {
  const dx = qx - cx;
  const dz = qz - cz;
  const len2 = dx * dx + dz * dz || 1;
  const len = Math.sqrt(len2);
  let count = 0;
  for (const o of obstacles) {
    const along = ((o.x - cx) * dx + (o.z - cz) * dz) / len2;
    // Up to four metres beyond the point still counts, as background clutter.
    const s = Math.min(Math.max(along, 0), 1 + 4 / len);
    const d = Math.hypot(cx + dx * s - o.x, cz + dz * s - o.z);
    if (d < o.radius + 0.1 && cy + (qy - cy) * s < o.height + 0.08) count += along <= 1 ? 1 : 0.2;
  }
  return count;
}

const FOV = 26;
/** Fraction of the frame height hidden by each letterbox bar. */
const BAR = 0.115;

/**
 * Pick a two-shot of attacker and victim: a profile view on a long lens, a little above eye
 * level so the board recedes behind the pair. It prefers to look across the board rather than
 * out into the dark hall, and to stay on the player's side of the line between the two (so
 * the cut does not flip left and right). From the ideal it swings round and rises until
 * nothing stands in front of the pair; a high view over everyone's heads is the last resort.
 *
 * `top` is the highest thing that must stay in frame (a raised weapon, or the taller head).
 */
export function chooseShot(attacker: THREE.Vector3, victim: THREE.Vector3, viewer: THREE.Vector3, attackerHeight: number, victimHeight: number, top: number, aspect: number, obstacles: Obstacle[]): Shot {
  const mid = new THREE.Vector3().addVectors(attacker, victim).multiplyScalar(0.5);
  const axis = new THREE.Vector3().subVectors(victim, attacker).setY(0);
  const span = axis.length();
  if (span > 1e-4) axis.multiplyScalar(1 / span);
  else axis.set(0, 0, 1);
  const side = new THREE.Vector3(-axis.z, 0, axis.x);
  if (side.dot(new THREE.Vector3().subVectors(viewer, mid).setY(0)) < 0) side.negate();
  const h = Math.max(attackerHeight, victimHeight);

  // Frame from a little below the floor line to a little above the highest point, inside the
  // letterbox, and wide enough for the pair plus the room the wreckage needs.
  const floorMargin = 0.32;
  const headroom = 0.18;
  const tall = top + headroom + floorMargin;
  const tanHalf = Math.tan((FOV * Math.PI) / 360);
  const visible = 1 - 2 * BAR;
  const wide = span + 3.2;
  const distance = Math.max(tall / (2 * tanHalf * visible), wide / (2 * tanHalf * aspect));
  const targetY = (top + headroom - floorMargin) / 2;

  const points: [number, number, number][] = [
    [attacker.x, attackerHeight * 0.62, attacker.z],
    [attacker.x, attackerHeight * 0.92, attacker.z],
    [victim.x, victimHeight * 0.62, victim.z],
    [victim.x, victimHeight * 0.92, victim.z],
    [mid.x, h * 0.6, mid.z],
    [victim.x, 0.15, victim.z],
  ];

  // How far out from the middle of the board the pair is, and in which direction.
  const out = new THREE.Vector3(mid.x, 0, mid.z);
  const outward = Math.min(1, out.length() / 4.4);
  if (out.lengthSq() > 1e-6) out.normalize();

  let best: THREE.Vector3 | null = null;
  let bestScore = Infinity;
  const p = new THREE.Vector3();
  const view = new THREE.Vector3();
  // Camera height as a multiple of the taller figure: just above eye level first.
  const heights = [0.78, 1.25, 1.9, 2.9];
  for (const sideSign of [1, -1]) {
    for (const azimuth of [0, 18, -18, 36, -36, 54, -54]) {
      for (let e = 0; e < heights.length; e++) {
        const y = h * heights[e];
        const horizontal = Math.sqrt(Math.max(distance * distance - (y - targetY) * (y - targetY), 4));
        const a = (azimuth * Math.PI) / 180;
        // Positive angles swing round behind the attacker, looking past it at the victim.
        p.copy(mid)
          .addScaledVector(side, sideSign * Math.cos(a) * horizontal)
          .addScaledVector(axis, -Math.sin(a) * horizontal);
        p.y = y;
        let score = Math.abs(azimuth) * 0.03 + e * 1.5 + (sideSign < 0 ? 1.2 : 0);
        // Looking outwards from near the edge of the board puts the pair against a void.
        view.set(mid.x - p.x, 0, mid.z - p.z).normalize();
        score += Math.max(0, view.dot(out)) * outward * 3;
        for (const q of points) score += blockers(p.x, p.y, p.z, q[0], q[1], q[2], obstacles) * 4;
        // A statue close to the lens fills a slab of the frame with blur.
        const range = Math.hypot(mid.x - p.x, mid.z - p.z);
        for (const o of obstacles) {
          const ox = o.x - p.x;
          const oz = o.z - p.z;
          const forward = ox * view.x + oz * view.z;
          if (forward < 0.3 || forward > range * 0.8 || y > o.height + 1) continue;
          const sideways = Math.abs(ox * view.z - oz * view.x);
          if (sideways < forward * tanHalf * aspect * 1.1 + o.radius) score += 1.5 + (6 * o.radius) / forward;
        }
        // Never inside or brushing a statue, and never out among the pillars.
        for (const o of obstacles) if (Math.hypot(o.x - p.x, o.z - p.z) < o.radius + 0.75 && y < o.height + 0.4) score += 100;
        if (Math.hypot(p.x, p.z) > 14.2) score += 100;
        if (score < bestScore) {
          bestScore = score;
          best = p.clone();
        }
      }
    }
  }
  const position = best ?? mid.clone().addScaledVector(side, distance).setY(h * 1.7);
  const target = mid.clone().setY(targetY);
  return { pose: { position, target, fov: FOV }, focus: mid.clone().setY(h * 0.6) };
}
