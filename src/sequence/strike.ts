import * as THREE from 'three';
import type { BakedClip } from '../anim/bake';
import { Pose, poseJoints, sampleClip } from '../anim/pose';
import { aimBones, aimPose, createJoints } from '../anim/sculpt';
import type { Actor } from '../pieces/actor';

/**
 * Where a weapon is through the whole of an attack clip, worked out ahead of time by forward
 * kinematics. Everything about a blow is planned from this: how far away the attacker must
 * stand for the weapon to land in the victim, which way to face, how high to aim, and the
 * exact moment the weapon enters the victim.
 *
 * Positions are in the attacker's own frame (x towards its own left, y up, z the way it
 * faces), in metres at the statue's real size. A track is for one `aim` (see `aimPose`): the
 * statue's arms are raised or lowered by that angle through the blow, and the same function
 * shapes the poses measured here.
 */
export class StrikeTrack {
  static readonly STEP = 1 / 120;
  readonly count: number;
  /** The hand on the grip, per sample. */
  private readonly grip: Float32Array;
  /** The far end of the weapon, per sample. */
  private readonly tip: Float32Array;
  private readonly tops = new Map<number, number>();

  constructor(
    actor: Actor,
    clip: BakedClip,
    weaponIndex: number,
    readonly aim = 0,
  ) {
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
    const joints = createJoints(rig);
    const aimed = aim !== 0 ? aimBones(rig) : null;
    const scratch = aimed ? createJoints(rig) : null;
    const scale = actor.design.scale;
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    this.count = Math.max(2, Math.floor(clip.duration / StrikeTrack.STEP) + 1);
    this.grip = new Float32Array(this.count * 3);
    this.tip = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      sampleClip(clip, Math.min(i * StrikeTrack.STEP, clip.duration), pose);
      if (aimed && scratch) aimPose(pose, rig, aimed, aim, scratch);
      poseJoints(pose, rig, joints.pos, joints.rot);
      q.fromArray(joints.rot, hand * 4);
      const hx = joints.pos[hand * 3];
      const hy = joints.pos[hand * 3 + 1];
      const hz = joints.pos[hand * 3 + 2];
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

  /**
   * The top of the wind-up before a blow at clip time `hit`: the moment, in the half second
   * or so before it, at which the far end of the weapon is moving slowest.
   */
  windupTop(hit: number): number {
    let top = this.tops.get(hit);
    if (top === undefined) {
      top = Math.max(0, hit - 0.6);
      let slowest = Infinity;
      for (let t = top; t <= hit - 0.1; t += StrikeTrack.STEP) {
        const speed = this.velocity(t, 1, _p).lengthSq();
        if (speed < slowest) {
          slowest = speed;
          top = t;
        }
      }
      this.tops.set(hit, top);
    }
    return top;
  }
}

const _a = new THREE.Vector3();
const _p = new THREE.Vector3();
const _o = new THREE.Vector3();
const tracks = new Map<string, StrikeTrack>();

/** The (cached) track of one of a statue's weapons through a clip, for one aim. */
export function strikeTrack(actor: Actor, clip: BakedClip, weaponIndex = 0, aim = 0): StrikeTrack {
  const key = `${actor.type}:${clip.name}:${weaponIndex}:${aim.toFixed(4)}`;
  let t = tracks.get(key);
  if (!t) {
    t = new StrikeTrack(actor, clip, weaponIndex, aim);
    tracks.set(key, t);
  }
  return t;
}

/**
 * The part of a victim a blow must enter: a standing cylinder, deliberately narrower than what
 * it stands for, so the weapon is some way into the stone at the moment of the blow rather
 * than touching its surface.
 */
export interface StrikeZone {
  radius: number;
  /** Bottom and top of the cylinder, metres above the floor. */
  bottom: number;
  top: number;
  /** How far towards the attacker the zone stands from the victim's own centre (a bowed head), metres. */
  forward: number;
  /** Heights between which the blow should land for preference. */
  sweet?: [number, number];
  /** A height below which a contact scarcely reads as a blow (the shins). */
  low?: number;
  /** Radius of the body below the zone, which the weapon should not pass through on its way there. */
  body?: number;
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
 * The first moment, around a nominal hit time, at which the weapon is inside a zone standing
 * at (`tx`, `tz`) in the attacker's frame. Tested along the outer part of the weapon, so a
 * victim standing closer than the blade is long is still struck, by the middle of the blade.
 * With `offset`, the attacker is still in motion (landing from a leap) and the weapon is
 * displaced by wherever its body is at each moment.
 */
export function findContact(track: StrikeTrack, nominal: number, along: number, tx: number, tz: number, zone: StrikeZone, step = StrikeTrack.STEP, before = 0.3, after = 0.14, offset?: BodyOffset): Contact {
  for (let t = Math.max(0, nominal - before); t <= nominal + after; t += step) {
    if (offset) offset(t, _o);
    // From the far end inwards: the outermost part of the weapon inside the zone wins.
    for (let a = 1; a >= 0.29; a -= 0.1) {
      track.point(t, a, _p);
      if (offset) _p.add(_o);
      if (_p.y > zone.bottom && _p.y < zone.top && Math.hypot(_p.x - tx, _p.z - tz) < zone.radius) {
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

/** Whether the weapon passes through the victim's body, below the zone, between two clip times. */
function throughBody(track: StrikeTrack, from: number, until: number, tx: number, tz: number, zone: StrikeZone): boolean {
  const radius = zone.body ?? 0;
  if (radius <= 0) return false;
  for (let t = from; t < until - 1e-6; t += 1 / 60) {
    for (let a = 1; a >= 0.29; a -= 0.1) {
      track.point(t, a, _p);
      if (_p.y > 0.25 && _p.y < zone.bottom - 0.06 && Math.hypot(_p.x - tx, _p.z - tz) < radius) return true;
    }
  }
  return false;
}

/** Where an attacker must stand, how it must aim, and when its blows land, for its weapon to go into the victim. */
export interface StrikeSolution {
  /** Distance between attacker and victim, metres. */
  distance: number;
  /** How far round to the attacker's left of straight ahead the victim stands, radians. */
  bearing: number;
  /** How far the arms are raised (or, negative, lowered) through the killing blow, radians. */
  aim: number;
  /** The weapon's path with that aim: what the killing blow, its trail and its effects follow. */
  track: StrikeTrack;
  /** One per nominal hit: when and where the weapon meets the victim. */
  contacts: Contact[];
  /** Whether the final blow really passes through the zone. */
  lands: boolean;
  /** Set when the zone asked for was out of reach and the blow has been landed on the body below it instead. */
  short?: boolean;
}

/** What each radian of aim costs against the other things a placing is scored on: the less re-aiming the better. */
const AIM_COST = 1.4;

/**
 * Search stand-off distances, small turns of the body and (where the blow allows it) a few
 * aims for the placing at which the final blow enters the zone nearest the moment the weapon
 * is moving fastest, struck with the outer part of the weapon, from as far back as the weapon
 * allows, at a height the blow should prefer, without passing through the body on the way.
 * `trackAt` gives the weapon's path for an aim; earlier blows are placed with no aim.
 */
export function solveStrike(trackAt: (aim: number) => StrikeTrack, hits: readonly number[], along: number, zone: StrikeZone, aims: readonly number[], maxDistance: number, minDistance = 0.6): StrikeSolution {
  const last = hits[hits.length - 1];
  let best: { d: number; bearing: number; aim: number } | null = null;
  let bestScore = Infinity;
  for (const aim of aims) {
    const track = trackAt(aim);
    const top = track.windupTop(last);
    for (let d = Math.min(maxDistance, 2.3); d >= minDistance - 1e-6; d -= 0.04) {
      const reach = d - zone.forward;
      for (let k = -6; k <= 6; k++) {
        const bearing = (k * 5 * Math.PI) / 180;
        const tx = reach * Math.sin(bearing);
        const tz = reach * Math.cos(bearing);
        const c = findContact(track, last, along, tx, tz, zone, 1 / 60);
        if (!c.found) continue;
        let score = Math.abs(c.time - last) * 3 + Math.abs(bearing) * 0.8 + (1 - c.along) * 0.6 - d * 0.25 + Math.abs(aim) * AIM_COST;
        // A blow to the shins does not read as a blow.
        if (zone.low !== undefined && c.point.y < zone.low) score += 0.5;
        if (zone.sweet) score += Math.max(0, zone.sweet[0] - c.point.y, c.point.y - zone.sweet[1]) * 3;
        if (score >= bestScore) continue;
        if (throughBody(track, top, c.time, tx, tz, zone)) continue;
        bestScore = score;
        best = { d, bearing, aim };
      }
    }
  }
  if (!best) {
    // The weapon cannot be made to pass through the zone: stand at its reach and strike anyway.
    const track = trackAt(0);
    const p = track.point(last, along);
    const d = Math.min(Math.max(Math.hypot(p.x, p.z), minDistance), maxDistance);
    return { distance: d, bearing: 0, aim: 0, track, contacts: hits.map((h) => ({ time: h, along, point: track.point(h, along).clone(), found: false })), lands: false };
  }
  const track = trackAt(best.aim);
  const reach = best.d - zone.forward;
  const tx = reach * Math.sin(best.bearing);
  const tz = reach * Math.cos(best.bearing);
  // Earlier blows are struck before the aim comes on, and may land anywhere on the figure.
  const anywhere: StrikeZone = { radius: zone.radius, bottom: 0.04, top: zone.top, forward: zone.forward };
  const contacts = hits.map((h, i) => (i === hits.length - 1 ? findContact(track, h, along, tx, tz, zone) : findContact(trackAt(0), h, along, tx, tz, anywhere)));
  return { distance: best.d, bearing: best.bearing, aim: best.aim, track, contacts, lands: contacts[contacts.length - 1].found };
}
