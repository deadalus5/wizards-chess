import * as THREE from 'three';
import type { BakedClip } from '../anim/bake';
import { Pose, poseJoints, sampleClip } from '../anim/pose';
import type { Rig } from '../anim/rig';
import { aimBones, aimPose, createJoints, groupMask, layPose, turnBone } from '../anim/sculpt';
import type { MoveEvent } from '../chess/game';
import type { Obstacle } from '../cinema/cinema';
import { angleDelta, clamp, clamp01, ease, smoothstep } from '../core/math';
import { homeYaw, squareCentre, yawTowards } from '../game/squares';
import type { Actor, PoseLayer } from '../pieces/actor';
import type { PieceType } from '../pieces/regalia';
import { AIM_LIMIT, ATTACKS, type AttackSpec } from './attacks';
import { baseLayers, leapShape, planStepOn, planTravel, planTurn, setBase, turnDuration, type Stage } from './moves';
import { TimeWarp } from './pacing';
import { planPromotion, SPECIAL_CLIPS } from './special';
import { findContact, solveStrike, StrikeTrack, strikeTrack, zoneCentre, type BodyOffset, type Contact, type StrikeSolution, type StrikeZone } from './strike';
import { Timeline } from './timeline';

/** How long before the attacker is in place the shot cuts in, when there is that long. */
const CUT_LEAD = 1.15;
/** How soon after the cut the victim stirs. */
const NOTICE = 0.12;
/** The least time a standing victim has stood ready before the blow reaches it. */
const READY = 0.2;
/** Radians per second at which a victim comes round to face its attacker: unhurried. */
const VICTIM_TURN = 3.6;
/** A standing victim braces over this long before the blow: its weight goes back this far, its chin up this much. */
const BRACE_TIME = 0.4;
const BRACE_SHIFT = 0.022;
const BRACE_CHIN = 0.07;
/** Game seconds after the blow for which the camera stays on the break, and before which the attacker does not move on. */
const AFTERMATH = 1.3;
const STAND_OVER = 1.15;
/** Seconds after the blow for which the weapon's onward path is given to the break. */
const FOLLOW = 0.3;
/** How long a leaping attacker gathers itself before it springs. */
const LEAP_GATHER = 0.4;

/**
 * The king's kill. Whatever he takes goes down on one knee before him: slowly, from the moment
 * the shot opens, and is kneeling still with its head bowed before the blow comes.
 */
const KNEEL = {
  clip: SPECIAL_CLIPS[0],
  /** The part of the clip used: from where the knees begin to give to the full kneel. */
  from: 1.0,
  down: 1.95,
  /** Seconds the descent is drawn out over, and for which the victim then kneels still. */
  time: 2.3,
  held: 0.5,
  /** How much farther the head is bowed than the clip bows it, radians. */
  bow: 0.2,
  /** The king's draw is slowed to this rate, so that he is not standing idle while the victim goes down. */
  draw: 0.75,
};
/**
 * Statues whose arms keep their own standing pose as they kneel, where the clip's arms would
 * put what they hold through themselves or out at the king's legs: a pawn and a bishop kneel
 * with spear and staff upright, grounded beside them; the queen keeps her blades as she holds them.
 */
const KNEELS_WITH_OWN_ARMS: ReadonlySet<PieceType> = new Set<PieceType>(['p', 'b', 'q']);

const ACROSS = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

/** For looking at one attack at a time: stills, timings, comparisons. */
export const captureTuning = {
  /** Make every capture use this one of the attacker's attacks (its place in the list); null lets the capture choose. */
  variant: null as number | null,
};

/** What the capture planned last chose, for reports. */
export const lastCapture = { attack: '', options: [] as string[] };

/** One clip on a statue's track: when it plays, how fast, and how it fades in and out. */
interface Segment {
  clip: BakedClip;
  start: number;
  end: number;
  /** Clip seconds per timeline second; negative plays backwards. */
  rate: number;
  /** Clip time at `start`. */
  offset: number;
  fadeIn: number;
  fadeOut: number;
  /** Clip time against seconds into the segment, where the pacing is not one constant rate. */
  warp?: (into: number) => number;
}

interface SegmentOptions {
  /** Keep the feet in the frozen stance throughout: a statue that never takes a step. */
  planted?: boolean;
  /** Bones that take the frozen pose, not the clips, while a clip plays (1 = wholly). */
  keep?: Float32Array | null;
  /** A last touch to the blended pose each frame, given the time on the timeline. */
  adjust?: (pose: Pose, time: number) => void;
}

/**
 * Play a set of overlapping clips on a statue standing ready at `position` with heading `yaw`
 * (it has already risen, if it is one that rises). Wherever no clip has weight its standing
 * pose shows through.
 */
function planSegments(tl: Timeline, actor: Actor, position: THREE.Vector3, yaw: number, segments: Segment[], t0: number, t1: number, options: SegmentOptions = {}): void {
  const at = position.clone();
  const keep = options.keep ?? null;
  const free = keep ? keep.map((w) => 1 - w) : null;
  const layers: PoseLayer[] = [...baseLayers(actor), ...segments.map((s) => ({ clip: s.clip, time: 0, weight: 0, mask: free }))];
  const kept: PoseLayer | null = keep ? { clip: actor.frozen, time: 0, weight: 0, mask: keep } : null;
  if (kept) layers.push(kept);
  let now = t0;
  tl.at(t0, () => {
    if (options.planted) actor.planter.hold(actor.stance);
    else {
      actor.planter.release();
      actor.planter.enabled = true;
    }
    const adjust = options.adjust;
    if (adjust) actor.adjust = (pose) => adjust(pose, now);
  });
  tl.span(t0, t1 - t0, (local, dt) => {
    const t = t0 + local;
    now = t;
    let total = 0;
    segments.forEach((s, i) => {
      const layer = layers[i + 2];
      if (t < s.start || t > s.end) {
        layer.weight = 0;
        return;
      }
      const into = t - s.start;
      const w = clamp01(s.fadeIn > 0 ? into / s.fadeIn : 1) * clamp01(s.fadeOut > 0 ? (s.end - t) / s.fadeOut : 1);
      // Smoothstep so fades have no visible start or stop.
      layer.weight = w * w * (3 - 2 * w);
      layer.time = Math.min(Math.max(s.warp ? s.warp(into) : s.offset + into * s.rate, 0), s.clip.duration);
      total += layer.weight;
    });
    setBase(layers, Math.max(0, 1 - total), 1);
    if (kept) kept.weight = Math.min(1, total);
    actor.root.position.copy(at);
    actor.root.rotation.set(0, yaw, 0);
    actor.animate(layers, dt, false);
  });
  if (options.adjust) {
    tl.at(t1, () => {
      actor.adjust = null;
    });
  }
}

/** What the victim is doing when the blow lands. */
export type Posture = 'stand' | 'kneel';

/** Bow the head: a turn forwards shared between the neck and the head. */
function bowHead(pose: Pose, rig: Rig, angle: number): void {
  if (angle === 0) return;
  const neck = rig.index.get('neck_01');
  const head = rig.index.get('head');
  if (neck !== undefined) turnBone(pose, rig, neck, ACROSS, angle * 0.4);
  if (head !== undefined) turnBone(pose, rig, head, ACROSS, angle * 0.6);
}

const kneeling = new Map<PieceType, Pose>();

/** The pose a victim holds once it has knelt, exactly as its track will leave it. */
function kneelingPose(stage: Stage, victim: Actor): Pose {
  let pose = kneeling.get(victim.type);
  if (!pose) {
    const rig = victim.template.rig;
    pose = new Pose(rig.names.length);
    sampleClip(stage.cast.clip(victim.body, KNEEL.clip), KNEEL.down, pose);
    if (KNEELS_WITH_OWN_ARMS.has(victim.type)) {
      const own = new Pose(rig.names.length);
      sampleClip(victim.upright, 0, own);
      layPose(pose, own, victim.armMask, -1);
    }
    bowHead(pose, rig, KNEEL.bow);
    kneeling.set(victim.type, pose);
  }
  return pose;
}

const zones = new Map<string, StrikeZone>();
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * The part of the victim the killing blow must enter: its head and neck, placed from its real
 * joints in the pose it will be holding, from the base of the neck to most of the way up its
 * head-piece. A blow from overhead should come down on the crown; a swing or a thrust should
 * find the neck or the face.
 */
export function strikeZone(stage: Stage, victim: Actor, spec: AttackSpec, posture: Posture): StrikeZone {
  const key = `${victim.type}/${posture}/${spec.kind}`;
  let zone = zones.get(key);
  if (!zone) {
    const scale = victim.design.scale;
    const rig = victim.template.rig;
    const neck = rig.index.get('neck_01');
    const head = rig.index.get('head');
    if (neck === undefined || head === undefined) throw new Error('rig has no head');
    const joints = createJoints(rig);
    const standing = new Pose(rig.names.length);
    sampleClip(victim.upright, 0, standing);
    poseJoints(standing, rig, joints.pos, joints.rot);
    // The head-piece rides on the head: as far above it, along the head's own axis, as when the statue stands.
    const crest = victim.height - joints.pos[head * 3 + 1] * scale;
    _q.fromArray(joints.rot, head * 4).invert();
    if (posture === 'kneel') poseJoints(kneelingPose(stage, victim), rig, joints.pos, joints.rot);
    // Which way the top of the head points now.
    _v.set(0, 1, 0).applyQuaternion(_r.fromArray(joints.rot, head * 4).multiply(_q));
    const neckY = joints.pos[neck * 3 + 1] * scale;
    const headY = joints.pos[head * 3 + 1] * scale;
    // The middle of the skull is a little way up that axis from the joint at its base.
    const skull = 0.1 * scale;
    const top = headY + crest * 0.9 * Math.max(0.5, _v.y);
    zone = {
      radius: 0.07 * scale,
      bottom: neckY - 0.02 * scale,
      top,
      forward: joints.pos[head * 3 + 2] * scale + _v.z * skull,
      side: joints.pos[head * 3] * scale + _v.x * skull,
      body: 0.17 * scale,
      sweet: spec.kind === 'overhead' ? [headY + 0.05 * scale, top] : [neckY, headY + 0.17 * scale],
    };
    zones.set(key, zone);
  }
  return zone;
}

/** The grid aims are taken from, radians (2.6 degrees). */
const AIM_STEP = 0.045;

/**
 * The aims worth trying for a blow: none, and a few either side of what its unaimed path
 * suggests. With `wide`, when those have not found the head: every other step of the grid on
 * that side, out to the limit. On a grid so that the same few weapon paths serve every kind
 * of victim.
 */
function aimsFor(spec: AttackSpec, track: StrikeTrack, zone: StrikeZone, wide = false): number[] {
  const limit = spec.aim ?? AIM_LIMIT[spec.kind];
  if (limit <= 0 || !zone.sweet) return [0];
  const p = track.point(spec.hits[spec.hits.length - 1], spec.along);
  const want = (zone.sweet[0] + zone.sweet[1]) / 2;
  const guess = Math.atan2(want - p.y, Math.max(0.4, Math.hypot(p.x, p.z)));
  const most = Math.floor(limit / AIM_STEP + 1e-6);
  const step = (a: number): number => clamp(Math.round(a / AIM_STEP), -most, most);
  const steps = new Set<number>([0, step(guess - AIM_STEP), step(guess), step(guess + AIM_STEP)]);
  if (wide) for (let k = step(guess) + (guess > 0 ? 2 : -2); Math.abs(k) <= most; k += guess > 0 ? 2 : -2) steps.add(k);
  return [...steps].map((k) => +(k * AIM_STEP).toFixed(3));
}

/** The flight of a strike made from the air, which lands `distance` metres from where it springs. */
interface Flight {
  flight: number;
  apex: number;
  /** Seconds after take-off at which the clip reaches a clip time. */
  sinceLaunch(clip: number): number;
  /** How far along its way the body is, 0..1, and how high, `s` seconds after take-off. */
  along(s: number): number;
  height(s: number): number;
}

function leapFlight(leap: NonNullable<AttackSpec['leap']>, scale: number, distance: number): Flight {
  const flight = 0.62 + 0.08 * distance;
  // Lower than a plain leap: the clip adds a jump of its own.
  const apex = (0.34 + 0.1 * distance) * scale;
  const airClip = leap.land - leap.launch;
  const u = (s: number): number => clamp01(s / flight);
  return {
    flight,
    apex,
    sinceLaunch: (clip) => (clip <= leap.land ? ((clip - leap.launch) / airClip) * flight : flight + (clip - leap.land)),
    along: (s) => ease.inOutSine(u(s)) * 0.35 + u(s) * 0.65,
    height: (s) => apex * 4 * u(s) * (1 - u(s)),
  };
}

/** How long before and after its nominal moment a blow struck from the air may meet its victim, seconds of the clip. */
const LEAP_WINDOW = { before: 0.1, after: 0.22 };

const solutions = new Map<string, StrikeSolution>();

/**
 * The (cached) placing of one kind of attacker, making one of its attacks, against one kind of
 * victim in one posture. `apart` is how far apart the two stand before the capture: the
 * attacker never backs away to strike. With `exactly`, the placing from that distance and no other.
 */
export function strikeFor(stage: Stage, attacker: Actor, victim: Actor, spec: AttackSpec, apart: number, posture: Posture = 'stand', exactly?: number): StrikeSolution {
  // Captures come from one of a few distances, and beyond the longest reach they are all one.
  const limit = Math.round(Math.min(apart, 2.3) * 20) / 20;
  // A leap is shaped by how far it has to go, so its placing depends on that too.
  const from = spec.leap ? `~${apart.toFixed(2)}` : '';
  const key = `${attacker.type}:${spec.name}>${victim.type}/${posture}@${exactly === undefined ? limit : `=${exactly.toFixed(3)}`}${from}`;
  let s = solutions.get(key);
  if (!s) {
    const clip = stage.cast.clip(attacker.body, spec.clip);
    const trackAt = (aim: number): StrikeTrack => strikeTrack(attacker, clip, spec.weapon ?? 0, aim);
    const zone = strikeZone(stage, victim, spec, posture);
    const aims = aimsFor(spec, trackAt(0), zone);
    const leap = spec.leap;
    const moving = leap
      ? (distance: number, bearing: number): BodyOffset => {
          const flight = leapFlight(leap, attacker.design.scale, apart - distance);
          const sin = Math.sin(bearing);
          const cos = Math.cos(bearing);
          return (clipTime, out) => {
            const since = flight.sinceLaunch(clipTime);
            const short = (apart - distance) * (1 - flight.along(since));
            out.set(-short * sin, flight.height(since), -short * cos);
          };
        }
      : undefined;
    const solve = (z: StrikeZone, a: readonly number[]): StrikeSolution =>
      solveStrike(trackAt, spec.hits, spec.along, z, { aims: a, maxDistance: exactly ?? limit, minDistance: exactly, moving, ...(leap ? LEAP_WINDOW : {}) });
    s = solve(zone, aims);
    // Not found near the aim it seemed to want: look farther that way before giving up on the head.
    if (!s.lands) s = solve(zone, aimsFor(spec, trackAt(0), zone, true));
    if (!s.lands) {
      // The head is out of this weapon's reach from anywhere: land the highest blow it can on
      // the body instead, and let the solution say so.
      const body = solve({ radius: zone.radius, bottom: 0.04, top: zone.top, forward: 0, sweet: [zone.bottom, zone.top], low: zone.bottom * 0.3 }, aims);
      if (body.lands) s = { ...body, short: true };
    }
    solutions.set(key, s);
  }
  return s;
}

/**
 * Where to stand to strike: `distance` from the victim, on the side the attacker comes from
 * if there is room there, otherwise swung round to the nearest clear spot.
 */
export function standingPoint(stage: Stage, attacker: Actor, victim: Actor, V: THREE.Vector3, towardsAttacker: THREE.Vector3, distance: number): THREE.Vector3 {
  const others = stage.cast.living().filter((a) => a !== attacker && a !== victim);
  const base = Math.atan2(towardsAttacker.x, towardsAttacker.z);
  let best = new THREE.Vector3();
  let bestClearance = -Infinity;
  for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const a = base + (step * 20 * Math.PI) / 180;
    const p = new THREE.Vector3(V.x + Math.sin(a) * distance, 0, V.z + Math.cos(a) * distance);
    let clearance = Infinity;
    for (const o of others) clearance = Math.min(clearance, Math.hypot(o.root.position.x - p.x, o.root.position.z - p.z) - o.radius - attacker.radius);
    // Prefer the direct line: only swing round if it buys real room.
    const scored = Math.min(clearance, 0.14) - Math.abs(step) * 1e-3;
    if (scored > bestClearance) {
      bestClearance = scored;
      best = p;
    }
    if (clearance >= 0.14) break;
  }
  return best;
}

/** One of the attacker's attacks, placed for this capture. */
export interface Placing {
  spec: AttackSpec;
  strike: StrikeSolution;
  zone: StrikeZone;
  /** Where the attacker strikes from and the heading it strikes on. */
  P: THREE.Vector3;
  faceYaw: number;
  /** How many samples of the weapon's sweep fall inside a statue that is no part of the fight. */
  touches: number;
}

/** How much of a bystander counts as in the way of a weapon: a little less than the whole of its outline. */
const BYSTANDER = 0.82;
const _w = new THREE.Vector3();

/**
 * How far a weapon's sweep passes through statues standing by: the number of samples, taken
 * along the outer half of the weapon through the whole of the attack as it will be seen, that
 * fall inside one of them.
 */
export function sweepTouches(stage: Stage, attacker: Actor, victim: Actor, spec: Pick<AttackSpec, 'followThrough' | 'leap'>, strike: StrikeSolution, P: THREE.Vector3, faceYaw: number): number {
  const others = stage.cast.living().filter((a) => a !== attacker && a !== victim);
  if (others.length === 0) return 0;
  const last = strike.contacts[strike.contacts.length - 1];
  const until = last.time + spec.followThrough;
  let touches = 0;
  for (let t = spec.leap ? spec.leap.launch : 0; t <= until; t += 1 / 60) {
    for (const along of [0.5, 0.75, 1]) {
      strike.track.point(t, along, _w).applyAxisAngle(UP, faceYaw).add(P);
      for (const o of others) {
        if (_w.y < o.height && Math.hypot(o.root.position.x - _w.x, o.root.position.z - _w.z) < o.radius * BYSTANDER) touches++;
      }
    }
  }
  return touches;
}

/** Place one attack for this capture: where the attacker stands, how it faces and aims, what its weapon passes through. */
export function placeAttack(stage: Stage, attacker: Actor, victim: Actor, spec: AttackSpec, A: THREE.Vector3, V: THREE.Vector3, posture: Posture): Placing {
  // As far back as the weapon reaches, never farther away than where the attacker already stands.
  const apart = A.distanceTo(V);
  let strike = strikeFor(stage, attacker, victim, spec, apart, posture);
  // A shuffle of a few inches reads as a twitch, not an approach: if the weapon reaches
  // from where the attacker already stands, strike from there.
  if (!spec.leap && apart - strike.distance < 0.45) {
    const fromHere = strikeFor(stage, attacker, victim, spec, apart, posture, apart);
    if (fromHere.lands && !fromHere.short && fromHere.contacts[fromHere.contacts.length - 1].along >= 0.55) strike = fromHere;
  }
  const zone = strikeZone(stage, victim, spec, posture);
  const direct = A.clone().sub(V).setY(0).normalize();
  const P = strike.distance >= apart - 0.02 ? A.clone() : standingPoint(stage, attacker, victim, V, direct, strike.distance);
  const faceYaw = yawTowards(P, V) - strike.bearing;
  return { spec, strike, zone, P, faceYaw, touches: sweepTouches(stage, attacker, victim, spec, strike, P, faceYaw) };
}

/** Which attack each pairing used last, so that it does not use the same one twice running. */
const lastUsed = new Map<string, string>();

/** What the choice between attacks is made on. */
export interface AttackOption {
  name: string;
  /** Whether its weapon reaches the victim's head. */
  lands: boolean;
  /** How much of its sweep passes through bystanders. */
  touches: number;
}

/**
 * The rule by which a capture picks its attack. Of the options, those whose weapon reaches the
 * victim's head (all of them, if none does); of those, the ones that pass through no bystander,
 * or failing that the ones that pass through least; and of those, the first that is not the
 * one this pairing used the last time.
 */
export function pickAttack<T extends AttackOption>(options: readonly T[], previous: string | undefined): T {
  const landing = options.filter((o) => o.lands);
  let pool = landing.length > 0 ? landing : options;
  const least = Math.min(...pool.map((o) => o.touches));
  pool = pool.filter((o) => o.touches === least);
  return pool.find((o) => o.name !== previous) ?? pool[0];
}

/** Choose and place the attack for this capture (see `pickAttack`), and remember it for the pairing. */
export function chooseAttack(stage: Stage, attacker: Actor, victim: Actor, A: THREE.Vector3, V: THREE.Vector3, posture: Posture): Placing {
  const specs = ATTACKS[attacker.type];
  const forced = captureTuning.variant;
  const all = (forced === null ? specs : [specs[Math.min(Math.max(forced, 0), specs.length - 1)]]).map((spec) => placeAttack(stage, attacker, victim, spec, A, V, posture));
  const options = all.map((placing) => ({ name: placing.spec.name, lands: placing.strike.lands && !placing.strike.short, touches: placing.touches, placing }));
  const pairing = `${attacker.side}${attacker.type}>${victim.type}`;
  const choice = pickAttack(options, lastUsed.get(pairing));
  lastUsed.set(pairing, choice.name);
  lastCapture.attack = choice.name;
  lastCapture.options = options.map((o) => `${o.name}: ${o.lands ? 'head' : o.placing.strike.lands ? 'body' : 'miss'}, bystander samples ${o.touches}`);
  return choice.placing;
}

/** How the blows of a planned strike fall on the timeline. */
interface StrikePlan {
  /** When the attacker is in place. */
  arrive: number;
  /** When the shot cuts in, and when the victim first stirs. */
  cutIn: number;
  notice: number;
  /** One per blow: when it lands, and where the weapon meets the victim in the attacker's frame. */
  hitTimes: number[];
  contacts: Contact[];
  /** The stretch of the timeline over which the attack clip plays, and the clip time within it. */
  strikeStart: number;
  strikeEnd: number;
  clipTime(t: number): number;
  /** When the weapon is at the top of its wind-up. */
  top: number;
  /** When the attacker is back in its standing pose and can move on. */
  recovered: number;
}

/** What both kinds of strike are planned from. */
interface StrikeSetup extends Placing {
  tl: Timeline;
  stage: Stage;
  attacker: Actor;
  victim: Actor;
  /** Where the attacker starts and where the victim stands. */
  A: THREE.Vector3;
  V: THREE.Vector3;
  home: number;
  posture: Posture;
  /** How long after it first stirs the victim is ready for the blow. */
  ready: number;
}

/**
 * The usual strike: come within reach in the manner of the attacker's kind, square up, and
 * attack from a standing start. The blow is paced by the attack's tempo and aimed as the
 * placing says; it does not land until the victim is ready for it.
 */
function planStandingStrike({ tl, stage, attacker, spec, strike, A, P, home, faceYaw, ready, posture }: StrikeSetup): StrikePlan {
  const { cast } = stage;
  const rig = attacker.template.rig;
  const leaps = attacker.design.mover === 'leap';

  let t = 0.16;
  if (A.distanceTo(P) > 0.12) {
    if (leaps) {
      // The camera rises with a leap, as it does when the blow is struck from the air.
      const shape = leapShape(A.distanceTo(P), attacker.design.scale, true);
      const boom = 0.8 * shape.apex;
      tl.span(t + shape.crouch, shape.flight, (local) => {
        const u = clamp01(local / shape.flight);
        stage.cinema.lift(boom * 4 * u * (1 - u));
      });
    }
    t = planTravel(tl, stage, attacker, A, P, t, { finalYaw: faceYaw, handOff: true });
    // A statue that drifts without turning squares up to its victim once it has landed.
    if (attacker.design.glide && !attacker.design.glide.turns) t = planTurn(tl, stage, attacker, P, t, home, faceYaw);
  } else {
    t = planTurn(tl, stage, attacker, P, t, home, faceYaw, { rise: true });
  }
  const arrive = t;

  const attack = cast.clip(attacker.body, spec.clip);
  const last = strike.contacts[strike.contacts.length - 1];
  const apex = spec.apex ?? strike.track.windupTop(spec.hits[spec.hits.length - 1]);
  const endClip = Math.min(attack.duration, last.time + spec.followThrough);
  const warp = new TimeWarp(apex, last.time, endClip, spec.tempo, spec.lead ?? 0);
  const firstBlow = warp.when(strike.contacts[0].time);
  const drawRate = spec.draw && posture === 'kneel' ? KNEEL.draw : 1;
  const drawTime = spec.draw ? spec.draw.until / drawRate : 0;

  // The shot opens before the attacker is in place (a leap is watched from its start), the
  // victim stirs a moment later, and the first blow may not land before the victim is ready.
  const cutIn = leaps ? 0.05 : Math.max(0.05, arrive - CUT_LEAD);
  const notice = cutIn + NOTICE;
  const begin = Math.max(arrive + 0.04, notice + ready - firstBlow - drawTime);

  const segments: Segment[] = [];
  let strikeStart = begin;
  if (spec.draw) {
    // Reach over the shoulder, close the hand on the hilt, bring the blade round.
    const draw = cast.clip(attacker.body, spec.draw.clip);
    segments.push({ clip: draw, start: begin, end: begin + drawTime + 0.2, rate: drawRate, offset: 0, fadeIn: 0.16, fadeOut: 0.2 });
    tl.at(begin + spec.draw.grab / drawRate, () => attacker.drawWeapons(true));
    strikeStart = begin + drawTime;
  }
  const strikeEnd = strikeStart + warp.when(endClip);
  segments.push({ clip: attack, start: strikeStart, end: strikeEnd, rate: 1, offset: 0, fadeIn: 0.16, fadeOut: 0.34, warp: (into) => warp.at(into) });
  let recovered = strikeEnd;
  if (spec.draw) {
    // Sheathe: the draw played backwards, letting go of the hilt at the same point.
    const draw = cast.clip(attacker.body, spec.draw.clip);
    const speed = 1.15;
    const start = strikeEnd - 0.28;
    const length = spec.draw.until / speed;
    segments.push({ clip: draw, start, end: start + length, rate: -speed, offset: spec.draw.until, fadeIn: 0.26, fadeOut: 0.18 });
    tl.at(start + (spec.draw.until - spec.draw.grab) / speed, () => attacker.drawWeapons(false));
    recovered = start + length;
  }

  // The aim comes on through the wind-up, is whole from before the blow until after it, and
  // goes again in the follow-through: the same aim the weapon's path was planned with.
  const aimed = strike.aim !== 0 ? aimBones(rig) : null;
  const scratch = aimed ? createJoints(rig) : null;
  const adjust =
    aimed && scratch
      ? (pose: Pose, time: number): void => {
          if (time < strikeStart) return;
          const c = warp.at(time - strikeStart);
          const k = smoothstep(last.time - 0.55, last.time - 0.32, c) * (1 - smoothstep(last.time + 0.2, last.time + 0.5, c));
          if (k > 0) aimPose(pose, rig, aimed, strike.aim * k, scratch);
        }
      : undefined;
  planSegments(tl, attacker, P, faceYaw, segments, arrive, recovered, {
    // A statue that slides keeps its feet in its stance through the blow as well: it never takes a step.
    planted: attacker.design.slide !== undefined,
    keep: spec.keep ? groupMask(rig, spec.keep) : null,
    adjust,
  });

  return {
    arrive,
    cutIn,
    notice,
    hitTimes: strike.contacts.map((c) => strikeStart + warp.when(c.time)),
    contacts: strike.contacts,
    strikeStart,
    strikeEnd,
    clipTime: (time) => warp.at(time - strikeStart),
    top: strikeStart + warp.when(apex),
    recovered,
  };
}

/**
 * A strike made from the air: the piece springs from where it stands and brings its weapon
 * down as it lands beside the victim. The jump-attack clip leaps on the spot; its take-off
 * and landing are stretched over the piece's own flight across the board.
 */
function planLeapStrike({ tl, stage, attacker, spec, strike, zone, A, P, home, faceYaw, ready }: StrikeSetup): StrikePlan {
  const leap = spec.leap!;
  const jump = stage.cast.clip(attacker.body, spec.clip);
  const track = strike.track;
  const { flight, apex, sinceLaunch, along, height } = leapFlight(leap, attacker.design.scale, A.distanceTo(P));
  // How far the camera rises to keep the leap in frame.
  const boom = 0.5 * (apex + 0.7 * attacker.design.scale);
  const airClip = leap.land - leap.launch;
  /** Where the body is `s` seconds after take-off. */
  const rootAt = (s: number, out: THREE.Vector3): THREE.Vector3 => {
    out.lerpVectors(A, P, along(s));
    out.y = height(s);
    return out;
  };

  // The blow falls just before the feet touch down, while the body is still a little short
  // of its landing place and above the floor: find the real moment of contact from where the
  // body really is (the placing allowed for this, along the straight line to the victim).
  const cosYaw = Math.cos(faceYaw);
  const sinYaw = Math.sin(faceYaw);
  const scratch = new THREE.Vector3();
  const offset: BodyOffset = (clip, out) => {
    rootAt(sinceLaunch(clip), scratch).sub(P);
    out.set(scratch.x * cosYaw - scratch.z * sinYaw, scratch.y, scratch.x * sinYaw + scratch.z * cosYaw);
  };
  const { x: tx, z: tz } = zoneCentre(zone, strike.distance, strike.bearing);
  const contacts = strike.contacts.map((c) => findContact(track, c.time, c.along, tx, tz, zone, StrikeTrack.STEP, LEAP_WINDOW.before, LEAP_WINDOW.after, offset));

  // The shot opens at once, so the whole leap is seen. The victim must be ready before the
  // first blow; if the leap is too quick for that, the attacker waits a moment before springing.
  const cutIn = 0.05;
  const notice = cutIn + NOTICE;
  const t0 = Math.max(0.16, notice + ready - LEAP_GATHER - sinceLaunch(contacts[0].time));
  const launch = t0 + LEAP_GATHER;
  const touchdown = launch + flight;
  const hitTimes = contacts.map((c) => launch + sinceLaunch(c.time));
  const recovered = touchdown + (leap.until - leap.land);
  const clipTime = (time: number): number => (time < launch ? leap.launch - (launch - time) : leap.launch + (time < touchdown ? ((time - launch) / flight) * airClip : airClip + (time - touchdown)));

  const layers: PoseLayer[] = [
    { clip: attacker.frozen, time: 0, weight: 1 },
    { clip: jump, time: 0, weight: 0 },
  ];
  const turn = angleDelta(home, faceYaw);
  tl.span(t0, recovered - t0, (local) => {
    const time = t0 + local;
    rootAt(time - launch, attacker.root.position);
    // Wind up towards the victim while crouching and finish the turn early in the flight.
    attacker.root.rotation.set(0, home + turn * ease.inOutCubic(clamp01((time - t0) / (LEAP_GATHER + flight * 0.3))), 0);
    const fadeIn = clamp01(local / 0.2);
    const fadeOut = clamp01((recovered - time) / 0.36);
    const w = fadeIn * fadeIn * (3 - 2 * fadeIn) * fadeOut * fadeOut * (3 - 2 * fadeOut);
    layers[0].weight = 1 - w;
    layers[1].weight = w;
    layers[1].time = clamp(clipTime(time), 0, jump.duration);
    attacker.animate(layers);
    const u = clamp01((time - launch) / flight);
    stage.cinema.lift(boom * 4 * u * (1 - u));
  });
  tl.at(touchdown, () => stage.fx.landing(P, attacker.design.heft));

  return { arrive: touchdown, cutIn, notice, hitTimes, contacts, strikeStart: t0, strikeEnd: recovered, clipTime, top: launch, recovered };
}

/**
 * A victim that meets its end standing. It wakes as the shot opens and comes round to face
 * its attacker, in the manner of its kind and without hurry (a crouched pawn rises as it
 * turns). Then it stands its ground: over the last moments its weight goes back a little and
 * its chin comes up, and it is upright when the blow lands.
 */
function planStandingVictim(tl: Timeline, stage: Stage, victim: Actor, V: THREE.Vector3, P: THREE.Vector3, notice: number, fromYaw: number, toYaw: number, finalHit: number): void {
  const rig = victim.template.rig;
  const faced = planTurn(tl, stage, victim, V, notice, fromYaw, toYaw, { rise: true, rate: VICTIM_TURN });
  const start = Math.min(faced, finalHit);
  if (finalHit - start < 1e-3) return;

  const layers = baseLayers(victim);
  const at = V.clone();
  // Away from the attacker, along the floor.
  const back = V.clone().sub(P).setY(0);
  if (back.lengthSq() > 1e-8) back.normalize();
  const neck = rig.index.get('neck_01');
  const head = rig.index.get('head');
  // A statue that stands at an angle to its attacker looks at it all the same.
  const look = -angleDelta(yawTowards(V, P), toYaw);
  let brace = 0;
  let looking = 0;
  tl.at(start, () => {
    if (victim.design.slide) victim.planter.hold(victim.stance);
    else {
      victim.planter.release();
      victim.planter.enabled = true;
    }
    if (head === undefined || neck === undefined) return;
    victim.adjust = (pose) => {
      if (look !== 0) {
        turnBone(pose, rig, neck, UP, look * 0.4 * looking);
        turnBone(pose, rig, head, UP, look * 0.6 * looking);
      }
      turnBone(pose, rig, head, ACROSS, -BRACE_CHIN * brace);
    };
  });
  tl.span(start, finalHit - start, (local, dt) => {
    brace = smoothstep(finalHit - BRACE_TIME, finalHit - 0.06, start + local);
    looking = smoothstep(0, 0.45, local);
    setBase(layers, 1, 1);
    victim.root.position.copy(at).addScaledVector(back, BRACE_SHIFT * victim.design.scale * brace);
    victim.root.rotation.set(0, toYaw, 0);
    // Not "settled": the shift of weight is not something to step after.
    victim.animate(layers, dt, false);
  });
  tl.at(finalHit, () => {
    victim.adjust = null;
  });
}

/** How a victim's turn towards the king and its going down are laid end to end, in seconds after it first stirs. */
function kneelTimes(victim: Actor, delta: number): { turn: number; start: number; apart: boolean } {
  if (Math.abs(delta) < 0.03) return { turn: 0, start: 0, apart: false };
  // A statue that grinds round, or lifts to turn, does that first and then goes down.
  if (victim.design.slide || victim.design.glide?.turns) {
    const turn = turnDuration(victim, delta);
    return { turn, start: turn, apart: true };
  }
  // One that turns on its feet sinks as it turns; a large turn is mostly made before it goes down.
  const turn = 0.18 + Math.abs(delta) / VICTIM_TURN;
  return { turn, start: Math.max(0, turn - 0.55), apart: false };
}

/**
 * A victim of the king. From the moment the shot opens it turns to him and goes down on one
 * knee: slowly, the whole descent drawn out with a gentle start and a gentle finish, the head
 * bowing at the last. It is kneeling still for a held moment before the blow. A crouched pawn
 * goes from its crouch straight into the kneel.
 */
function planKneelingVictim(tl: Timeline, stage: Stage, victim: Actor, V: THREE.Vector3, notice: number, fromYaw: number, toYaw: number, finalHit: number): void {
  const rig = victim.template.rig;
  const delta = angleDelta(fromYaw, toYaw);
  const { turn, start, apart } = kneelTimes(victim, delta);
  const begin = apart ? planTurn(tl, stage, victim, V, notice, fromYaw, toYaw) : notice;
  const down = notice + start;
  if (finalHit - begin < 1e-3) return;

  const kneel = stage.cast.clip(victim.body, KNEEL.clip);
  const ownArms = KNEELS_WITH_OWN_ARMS.has(victim.type);
  const crouched = victim.upright !== victim.frozen;
  // Body and arms apart: the arms end in the kneel's own pose or in the statue's standing one.
  const layers: PoseLayer[] = [
    { clip: victim.frozen, time: 0, weight: 1, mask: victim.bodyMask },
    { clip: kneel, time: KNEEL.from, weight: 0, mask: victim.bodyMask },
    { clip: victim.frozen, time: 0, weight: 1, mask: victim.armMask },
    { clip: ownArms ? victim.upright : kneel, time: KNEEL.from, weight: 0, mask: victim.armMask },
  ];
  const at = V.clone();
  let bow = 0;
  tl.at(begin, () => {
    victim.planter.release();
    victim.planter.enabled = true;
    victim.adjust = (pose) => bowHead(pose, rig, KNEEL.bow * bow);
  });
  tl.span(begin, finalHit - begin, (local, dt) => {
    const t = begin + local;
    const u = clamp01((t - down) / KNEEL.time);
    // Out of its own pose and into the kneel: early for a statue that stands, and for one that
    // crouches only once the kneel has come down to meet it, so that it never rises first.
    const w = crouched ? smoothstep(0, 0.55, u) : smoothstep(0, 0.22, u);
    bow = smoothstep(0.45, 1, u);
    // Gentle at both ends, but going down the whole time: never waiting, never dropping.
    const clipTime = KNEEL.from + (KNEEL.down - KNEEL.from) * (0.4 * u + 0.6 * ease.inOutSine(u));
    layers[0].weight = 1 - w;
    layers[1].weight = w;
    layers[1].time = clipTime;
    layers[2].weight = 1 - w;
    layers[3].weight = w;
    layers[3].time = ownArms ? 0 : clipTime;
    victim.root.position.copy(at);
    victim.root.rotation.set(0, apart || turn === 0 ? toYaw : fromYaw + delta * ease.inOutCubic(clamp01((t - notice) / turn)), 0);
    victim.animate(layers, dt, false);
  });
  tl.at(finalHit, () => {
    victim.adjust = null;
  });
}

/**
 * A capture, start to finish: the attacker comes within reach and strikes; the victim turns
 * to face it and stands its ground (or, before the king, kneels); the blow lands on its head
 * with a beat of hit-stop and slow motion and the victim breaks; the attacker takes the
 * square through the rubble.
 */
export function planCapture(stage: Stage, event: MoveEvent): Timeline {
  const { cast, shatter } = stage;
  if (!event.capturedSquare) throw new Error('capture without a captured square');
  const attacker = cast.at(event.from);
  const victim = cast.at(event.capturedSquare);
  if (!attacker || !victim) throw new Error(`capture ${event.san}: statues missing`);

  const tl = new Timeline();
  const posture: Posture = attacker.type === 'k' ? 'kneel' : 'stand';
  const A = squareCentre(event.from);
  const V = squareCentre(event.capturedSquare);
  const T = squareCentre(event.to);
  const home = homeYaw(attacker.side);
  const victimHome = homeYaw(victim.side);

  const placing = chooseAttack(stage, attacker, victim, A, V, posture);
  const { spec, strike, zone, P, faceYaw } = placing;
  // The victim turns to its attacker: one that stands to be struck may stand at an angle to it.
  const victimFace = yawTowards(V, P) + (posture === 'stand' ? victim.design.quarter ?? 0 : 0);
  const victimTurn = angleDelta(victimHome, victimFace);
  // How long the victim needs, from first stirring, to be ready: round to its attacker and
  // standing, or down on its knee and still.
  const ready = posture === 'kneel' ? kneelTimes(victim, victimTurn).start + KNEEL.time + KNEEL.held : turnDuration(victim, victimTurn, { rise: true, rate: VICTIM_TURN }) + READY;

  // ---------------------------------------------------------------- the attacker
  tl.at(0, () => attacker.wake(1.6, 5.5));
  const setup: StrikeSetup = { ...placing, tl, stage, attacker, victim, A, V, home, posture, ready };
  const plan = spec.leap && A.distanceTo(P) > 0.8 ? planLeapStrike(setup) : planStandingStrike(setup);
  const { hitTimes, contacts, recovered } = plan;
  const finalHit = hitTimes[hitTimes.length - 1];

  // ---------------------------------------------------------------- the victim
  tl.at(plan.notice, () => victim.wake(1.0, 4.5));
  if (posture === 'kneel') planKneelingVictim(tl, stage, victim, V, plan.notice, victimHome, victimFace, finalHit);
  else planStandingVictim(tl, stage, victim, V, P, plan.notice, victimHome, victimFace, finalHit);

  // ---------------------------------------------------------------- the blows land
  const attack = cast.clip(attacker.body, spec.clip);
  const track = strike.track;
  // Where the weapon goes on after the killing blow, so the stone can give way before it.
  const sweep: { at: number; point: THREE.Vector3 }[] = [];
  for (let after = 0; after <= FOLLOW; after += 0.008) {
    const clipTime = plan.clipTime(finalHit + after);
    for (const along of [0.6, 0.8, 1]) sweep.push({ at: after, point: track.point(clipTime, along).applyAxisAngle(UP, faceYaw).add(P) });
  }
  // What is left standing of the victim to fall: lower if it kneels.
  const tall = posture === 'kneel' ? zone.top : victim.height;
  contacts.forEach((contact, i) => {
    const point = contact.point.clone().applyAxisAngle(UP, faceYaw).add(P);
    const direction = track.velocity(contact.time, contact.along).applyAxisAngle(UP, faceYaw);
    if (!contact.found) {
      // The weapon does not reach: put the blow on the near side of the victim's head.
      point.copy(V).addScaledVector(P.clone().sub(V).normalize(), zone.forward + 0.1);
      point.y = (zone.bottom + zone.top) / 2;
      if (direction.lengthSq() < 1) direction.copy(V).sub(P).normalize();
    }
    const last = i === contacts.length - 1;
    tl.at(hitTimes[i] - 0.2, () => stage.fx.swing(point, last ? 1 : 0.75));
    tl.at(hitTimes[i], () => {
      stage.fx.impact(point, direction, last ? 1 : 0.45, victim.side);
      if (!last) return;
      stage.slowMotion(posture === 'kneel');
      stage.fx.collapse(V, tall, direction, victim.side);
      cast.detach(victim);
      shatter.shatter(victim, { point, direction, power: spec.power, sweep });
    });
  });

  // ---------------------------------------------------------------- the arcs the weapons leave
  const trailWeapons = spec.trails ?? [spec.weapon ?? 0];
  const trailTracks = trailWeapons.map((w) => (w === (spec.weapon ?? 0) ? track : strikeTrack(attacker, attack, w, strike.aim)));
  const trailFrom = spec.trailFrom ?? 0.35;
  tl.span(plan.strikeStart, plan.strikeEnd - plan.strikeStart, (local) => {
    const clipTime = plan.clipTime(plan.strikeStart + local);
    // Each arc swells into its blow and dies away after it.
    let strength = 0;
    for (const hit of spec.hits) {
      const x = clipTime - hit;
      const rise = clamp01((x + 0.2) / 0.14);
      const fall = 1 - clamp01((x - 0.05) / 0.16);
      strength = Math.max(strength, rise * rise * (3 - 2 * rise) * fall * fall);
    }
    if (local >= plan.strikeEnd - plan.strikeStart) strength = 0;
    const root = attacker.root;
    trailTracks.forEach((path, slot) => stage.fx.trail(slot, path, root.position, root.rotation.y, clipTime, trailFrom, attacker.side, strength));
  });

  // ---------------------------------------------------------------- taking the square
  // It stands over the wreckage until the pieces have come to rest, then goes through it.
  const stepOff = Math.max(recovered + 0.12, finalHit + STAND_OVER);
  tl.at(stepOff, () => shatter.setPusher(attacker));
  let end = planStepOn(tl, stage, attacker, P, T, stepOff, faceYaw, home);
  tl.at(end, () => {
    shatter.setPusher(null);
    cast.relocate(attacker, event.to);
    attacker.wake(0, 0);
  });

  // ---------------------------------------------------------------- camera
  // Cut to a two-shot shortly before the attacker arrives; cut back once the break has been
  // seen through.
  tl.at(plan.cutIn, () => {
    const obstacles: Obstacle[] = cast
      .living()
      .filter((a) => a !== attacker && a !== victim)
      .map((a) => ({ x: a.root.position.x, z: a.root.position.z, radius: a.radius, height: a.height }));
    // Keep a weapon raised overhead mostly in frame, without pulling back so far for it
    // that the figures shrink.
    const reach = track.apex(contacts[contacts.length - 1].time + spec.followThrough);
    const top = Math.max(attacker.height, victim.height, Math.min(reach, attacker.height * 1.2));
    stage.cinema.cut(stage.cinema.twoShot(P, V, stage.viewerPosition(), attacker.height, victim.height, top, obstacles));
  });
  const cutBack = Math.max(finalHit + AFTERMATH, stepOff + 0.3);
  tl.at(cutBack, () => stage.cinema.release());

  Object.assign(tl.marks, { cutIn: plan.cutIn, notice: plan.notice, arrive: plan.arrive, strike: plan.strikeStart, top: plan.top, blow: finalHit, stepOff, cutBack });

  if (event.promotion) end = planPromotion(tl, stage, attacker, event.promotion as PieceType, event.to, Math.max(end, cutBack) + 0.15);
  tl.extend(Math.max(end, cutBack) + 0.12);
  return tl;
}
