import * as THREE from 'three';
import type { BakedClip } from '../anim/bake';
import { Pose, poseJoints, sampleClip } from '../anim/pose';
import type { Actor } from '../pieces/actor';

/**
 * Where a weapon is through the whole of an attack clip, worked out ahead of time by forward
 * kinematics. Everything about a blow is planned from this: how far away the attacker must
 * stand for the weapon to land in the victim, which way to face, and the exact moment the
 * weapon enters the victim's body.
 *
 * Positions are in the attacker's own frame (x towards its own left, y up, z the way it
 * faces), in metres at the statue's real size.
 */
export class StrikeTrack {
  static readonly STEP = 1 / 120;
  readonly count: number;
  /** The hand on the grip, per sample. */
  private readonly grip: Float32Array;
  /** The far end of the weapon, per sample. */
  private readonly tip: Float32Array;

  constructor(actor: Actor, clip: BakedClip, weaponIndex: number) {
    const rig = actor.template.rig;
    const weapon = actor.weapons[weaponIndex];
    if (!weapon) throw new Error(`${actor.type} has no weapon ${weaponIndex}`);
    const hand = rig.index.get(`hand_${weapon.spec.hand}`);
    if (hand === undefined) throw new Error(`rig has no hand_${weapon.spec.hand}`);

    // The weapon's grip and far end in the hand bone's frame.
    const geometry = weapon.mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const centre = box.getCenter(new THREE.Vector3());
    const mount = weapon.hand;
    const inHand = (y: number): THREE.Vector3 => new THREE.Vector3(centre.x, y, centre.z).multiply(mount.scale).applyQuaternion(mount.quaternion).add(mount.position);
    const gripInHand = inHand(0);
    const tipInHand = inHand(box.max.y);

    const n = rig.names.length;
    const pose = new Pose(n).setRest(rig);
    const positions = new Float32Array(n * 3);
    const rotations = new Float32Array(n * 4);
    const scale = actor.design.scale;
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    this.count = Math.max(2, Math.floor(clip.duration / StrikeTrack.STEP) + 1);
    this.grip = new Float32Array(this.count * 3);
    this.tip = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      sampleClip(clip, Math.min(i * StrikeTrack.STEP, clip.duration), pose);
      poseJoints(pose, rig, positions, rotations);
      q.fromArray(rotations, hand * 4);
      const hx = positions[hand * 3];
      const hy = positions[hand * 3 + 1];
      const hz = positions[hand * 3 + 2];
      v.copy(gripInHand).applyQuaternion(q);
      this.grip.set([(v.x + hx) * scale, (v.y + hy) * scale, (v.z + hz) * scale], i * 3);
      v.copy(tipInHand).applyQuaternion(q);
      this.tip.set([(v.x + hx) * scale, (v.y + hy) * scale, (v.z + hz) * scale], i * 3);
    }
  }

  /** The point a fraction `along` the weapon (0 = grip, 1 = far end) at a clip time. */
  point(time: number, along: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = Math.min(Math.max(time / StrikeTrack.STEP, 0), this.count - 1);
    const i = Math.min(Math.floor(f), this.count - 2);
    const k = f - i;
    const a = i * 3;
    const b = a + 3;
    const { grip, tip } = this;
    for (let c = 0; c < 3; c++) {
      const g = grip[a + c] + (grip[b + c] - grip[a + c]) * k;
      const t = tip[a + c] + (tip[b + c] - tip[a + c]) * k;
      out.setComponent(c, g + (t - g) * along);
    }
    return out;
  }

  /** The highest the far end of the weapon gets up to a clip time (for framing the shot). */
  apex(until: number): number {
    const n = Math.min(this.count, Math.ceil(until / StrikeTrack.STEP) + 1);
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, this.tip[i * 3 + 1], this.grip[i * 3 + 1]);
    return top;
  }

  /** Velocity of that point, metres per second. */
  velocity(time: number, along: number, out = new THREE.Vector3()): THREE.Vector3 {
    const h = StrikeTrack.STEP * 2;
    this.point(time + h, along, out);
    return out.sub(this.point(time - h, along, _a)).multiplyScalar(1 / (2 * h));
  }
}

const _a = new THREE.Vector3();
const _p = new THREE.Vector3();
const _o = new THREE.Vector3();
const tracks = new Map<string, StrikeTrack>();

/** The (cached) track of one of a statue's weapons through a clip. */
export function strikeTrack(actor: Actor, clip: BakedClip, weaponIndex = 0): StrikeTrack {
  const key = `${actor.type}:${clip.name}:${weaponIndex}`;
  let t = tracks.get(key);
  if (!t) {
    t = new StrikeTrack(actor, clip, weaponIndex);
    tracks.set(key, t);
  }
  return t;
}

export interface Contact {
  /** Clip time at which the weapon enters the target. */
  time: number;
  /** Where on the weapon it meets (0 = grip, 1 = far end). */
  along: number;
  /** Meeting point in the attacker's frame. */
  point: THREE.Vector3;
  /** Whether the weapon really passes through the target (false = nominal time used). */
  found: boolean;
}

/** Where the attacker's body is, relative to where it will stand, at a clip time (for a strike made while still moving). */
export type BodyOffset = (clipTime: number, out: THREE.Vector3) => void;

/**
 * The first moment, around a nominal hit time, at which the weapon is inside a standing
 * cylinder (the victim's torso) placed at (`tx`, `tz`) in the attacker's frame. Tested along
 * the outer part of the weapon, so a victim standing closer than the blade is long is still
 * struck, by the middle of the blade. With `offset`, the attacker is still in motion (landing
 * from a leap) and the weapon is displaced by wherever its body is at each moment.
 */
export function findContact(
  track: StrikeTrack,
  nominal: number,
  along: number,
  tx: number,
  tz: number,
  radius: number,
  height: number,
  step = StrikeTrack.STEP,
  before = 0.3,
  after = 0.14,
  offset?: BodyOffset,
): Contact {
  for (let t = Math.max(0, nominal - before); t <= nominal + after; t += step) {
    if (offset) offset(t, _o);
    // From the far end inwards: the outermost part of the weapon inside the body wins.
    for (let a = 1; a >= 0.29; a -= 0.1) {
      track.point(t, a, _p);
      if (offset) _p.add(_o);
      if (_p.y > 0.04 && _p.y < height && Math.hypot(_p.x - tx, _p.z - tz) < radius) {
        return { time: t, along: a, point: _p.clone(), found: true };
      }
    }
  }
  track.point(nominal, along, _p);
  if (offset) {
    offset(nominal, _o);
    _p.add(_o);
  }
  return { time: nominal, along, point: _p.clone(), found: false };
}

/** Where an attacker must stand, and when its blows land, for its weapon to go into the victim. */
export interface StrikeSolution {
  /** Distance between attacker and victim, metres. */
  distance: number;
  /** How far round to the attacker's left of straight ahead the victim stands, radians. */
  bearing: number;
  /** One per nominal hit: when and where the weapon meets the victim. */
  contacts: Contact[];
  /** Whether the final blow really passes through the victim. */
  lands: boolean;
}

/**
 * Search stand-off distances and small turns of the body for the placing at which the final
 * blow meets the victim's torso nearest the moment the weapon is moving fastest, struck with
 * the outer part of the weapon, from as far back as the weapon allows.
 */
export function solveStrike(track: StrikeTrack, hits: readonly number[], along: number, radius: number, height: number, maxDistance: number, minDistance = 0.6): StrikeSolution {
  const last = hits[hits.length - 1];
  let best: { d: number; bearing: number } | null = null;
  let bestScore = Infinity;
  for (let d = Math.min(maxDistance, 2.3); d >= minDistance - 1e-6; d -= 0.04) {
    for (let k = -6; k <= 6; k++) {
      const bearing = (k * 5 * Math.PI) / 180;
      const c = findContact(track, last, along, d * Math.sin(bearing), d * Math.cos(bearing), radius, height, 1 / 60);
      if (!c.found) continue;
      let score = Math.abs(c.time - last) * 3 + Math.abs(bearing) * 0.8 + (1 - c.along) * 0.6 - d * 0.25;
      // A blow to the shins does not read as a blow.
      if (c.point.y < height * 0.22) score += 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = { d, bearing };
      }
    }
  }
  if (!best) {
    // The weapon cannot be made to pass through the victim: stand at its reach and strike anyway.
    const p = track.point(last, along);
    const d = Math.min(Math.max(Math.hypot(p.x, p.z), minDistance), maxDistance);
    return { distance: d, bearing: 0, contacts: hits.map((h) => ({ time: h, along, point: track.point(h, along).clone(), found: false })), lands: false };
  }
  const tx = best.d * Math.sin(best.bearing);
  const tz = best.d * Math.cos(best.bearing);
  const contacts = hits.map((h) => findContact(track, h, along, tx, tz, radius, height));
  return { distance: best.d, bearing: best.bearing, contacts, lands: contacts[contacts.length - 1].found };
}
