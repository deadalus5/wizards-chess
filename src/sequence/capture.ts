import * as THREE from 'three';
import type { BakedClip } from '../anim/bake';
import { Pose, poseJoints, sampleClip } from '../anim/pose';
import { aimBones, aimPose, createJoints, turnBone } from '../anim/sculpt';
import type { MoveEvent } from '../chess/game';
import type { Obstacle } from '../cinema/cinema';
import { angleDelta, clamp, clamp01, ease, smoothstep } from '../core/math';
import { homeYaw, squareCentre, yawTowards } from '../game/squares';
import type { Actor, PoseLayer } from '../pieces/actor';
import type { PieceType } from '../pieces/regalia';
import { AIM_LIMIT, ATTACKS, REACT, type AttackSpec } from './attacks';
import { baseLayers, planStepOn, planTravel, planTurn, setBase, turnDuration, type Stage } from './moves';
import { TimeWarp } from './pacing';
import { planPromotion } from './special';
import { findContact, solveStrike, StrikeTrack, strikeTrack, type Contact, type StrikeSolution, type StrikeZone } from './strike';
import { Timeline } from './timeline';

/** Seconds before the first blow at which a victim of the old kind starts to raise its guard. */
const GUARD_LEAD = 0.4;
/** How long before the attacker is in place the shot cuts in, when there is that long. */
const CUT_LEAD = 1.15;
/** How soon after the cut the victim stirs. */
const NOTICE = 0.12;
/** The least time a victim has stood ready before the blow reaches it. */
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

const ACROSS = new THREE.Vector3(1, 0, 0);

/** Choices open to adjustment, so that they can be compared on the same capture. */
export const captureTuning = {
  /** A statue that slides keeps its feet in its stance through the blow as well (false: it steps as the attack clip steps). */
  plantedStrike: true,
};

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
  const layers: PoseLayer[] = [...baseLayers(actor), ...segments.map((s) => ({ clip: s.clip, time: 0, weight: 0 }))];
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

const zones = new Map<string, StrikeZone>();

/**
 * The part of the victim the killing blow must enter: its head and neck, placed from its real
 * joints in the pose it will be holding, from the base of the neck to most of the way up its
 * head-piece. A blow from overhead should come down on the crown; a swing or a thrust should
 * find the neck or the face. (For an attack of the old kind: anywhere on the body.)
 */
export function strikeZone(victim: Actor, spec: AttackSpec, posture: Posture): StrikeZone {
  const scale = victim.design.scale;
  if (spec.old) return { radius: 0.075 * scale, bottom: 0.04, top: victim.height * 0.98, forward: 0, low: victim.height * 0.22 };
  const key = `${victim.type}/${posture}/${spec.kind}`;
  let zone = zones.get(key);
  if (!zone) {
    const rig = victim.template.rig;
    const neck = rig.index.get('neck_01');
    const head = rig.index.get('head');
    if (neck === undefined || head === undefined) throw new Error('rig has no head');
    const joints = createJoints(rig);
    const pose = new Pose(rig.names.length);
    sampleClip(victim.upright, 0, pose);
    poseJoints(pose, rig, joints.pos, joints.rot);
    // The head-piece rides on the head: as far above it, whatever the pose, as when the statue stands.
    const crest = victim.height - joints.pos[head * 3 + 1] * scale;
    const neckY = joints.pos[neck * 3 + 1] * scale;
    const headY = joints.pos[head * 3 + 1] * scale;
    const forward = joints.pos[head * 3 + 2] * scale;
    const top = headY + crest * 0.9;
    zone = {
      radius: 0.07 * scale,
      bottom: neckY - 0.02 * scale,
      top,
      forward,
      body: 0.17 * scale,
      sweet: spec.kind === 'overhead' ? [headY + 0.05 * scale, top] : [neckY, headY + 0.17 * scale],
    };
    zones.set(key, zone);
  }
  return zone;
}

/** The aims worth trying for a blow: none, and a few either side of what its unaimed path suggests. */
function aimsFor(spec: AttackSpec, track: StrikeTrack, zone: StrikeZone): number[] {
  const limit = spec.old ? 0 : AIM_LIMIT[spec.kind];
  if (limit <= 0 || !zone.sweet) return [0];
  const p = track.point(spec.hits[spec.hits.length - 1], spec.along);
  const want = (zone.sweet[0] + zone.sweet[1]) / 2;
  const guess = Math.atan2(want - p.y, Math.max(0.4, Math.hypot(p.x, p.z)));
  const aims = new Set<number>([0]);
  for (const a of [guess - 0.07, guess, guess + 0.07]) aims.add(+clamp(a, -limit, limit).toFixed(3));
  return [...aims];
}

const solutions = new Map<string, StrikeSolution>();

/** The (cached) placing of one kind of attacker, making one of its attacks, against one kind of victim. */
export function strikeFor(stage: Stage, attacker: Actor, victim: Actor, spec: AttackSpec, maxDistance: number, posture: Posture = 'stand', exactly?: number): StrikeSolution {
  // Captures come from one of a few distances, and beyond the longest reach they are all one.
  const limit = Math.round(Math.min(maxDistance, 2.3) * 20) / 20;
  const key = `${attacker.type}:${spec.name}>${victim.type}/${posture}@${exactly === undefined ? limit : `=${exactly.toFixed(3)}`}`;
  let s = solutions.get(key);
  if (!s) {
    const clip = stage.cast.clip(attacker.body, spec.clip);
    const trackAt = (aim: number): StrikeTrack => strikeTrack(attacker, clip, spec.weapon ?? 0, aim);
    const zone = strikeZone(victim, spec, posture);
    const aims = aimsFor(spec, trackAt(0), zone);
    const solve = (z: StrikeZone, a: readonly number[]): StrikeSolution => (exactly === undefined ? solveStrike(trackAt, spec.hits, spec.along, z, a, limit) : solveStrike(trackAt, spec.hits, spec.along, z, a, exactly, exactly));
    s = solve(zone, aims);
    if (!s.lands && !spec.old) {
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
function standingPoint(stage: Stage, attacker: Actor, victim: Actor, V: THREE.Vector3, towardsAttacker: THREE.Vector3, distance: number): THREE.Vector3 {
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
interface StrikeSetup {
  tl: Timeline;
  stage: Stage;
  attacker: Actor;
  victim: Actor;
  spec: AttackSpec;
  strike: StrikeSolution;
  /** Where the attacker starts, where it strikes from, and where the victim stands. */
  A: THREE.Vector3;
  P: THREE.Vector3;
  V: THREE.Vector3;
  home: number;
  faceYaw: number;
  /** How long the victim needs, from first stirring, to be ready for the blow. */
  lead: number;
  zone: StrikeZone;
}

/**
 * The usual strike: come within reach in the manner of the attacker's kind, square up, and
 * attack from a standing start. The blow is paced by the attack's tempo and aimed as the
 * solution says; it does not land until the victim has had time to be ready for it.
 */
function planStandingStrike({ tl, stage, attacker, spec, strike, A, P, home, faceYaw, lead }: StrikeSetup): StrikePlan {
  const { cast } = stage;
  const rig = attacker.template.rig;

  let t = 0.16;
  if (A.distanceTo(P) > 0.12) {
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
  const rate = spec.rate ?? 1;
  const warp = spec.tempo ? new TimeWarp(apex, last.time, endClip, spec.tempo) : null;
  /** Seconds into the attack at which the clip reaches a clip time, and the other way about. */
  const whenClip = (clip: number): number => (warp ? warp.when(clip) : clip / rate);
  const clipAt = (seconds: number): number => (warp ? warp.at(seconds) : seconds * rate);
  const firstBlow = whenClip(strike.contacts[0].time);
  const drawTime = spec.draw ? spec.draw.until : 0;

  // When the shot opens, when the victim stirs, and so the earliest the first blow may land.
  let cutIn: number;
  let notice: number;
  let begin: number;
  if (spec.old) {
    notice = Math.max(0.1, arrive - 0.45 - lead);
    cutIn = Math.max(0.05, Math.min(arrive - CUT_LEAD, notice - 0.1));
    begin = Math.max(arrive + 0.04, notice + lead + GUARD_LEAD - firstBlow - drawTime);
  } else {
    cutIn = Math.max(0.05, arrive - CUT_LEAD);
    notice = cutIn + NOTICE;
    begin = Math.max(arrive + 0.04, notice + lead + READY - firstBlow - drawTime);
  }

  const segments: Segment[] = [];
  let strikeStart = begin;
  if (spec.draw) {
    // Reach over the shoulder, close the hand on the hilt, bring the blade round.
    const draw = cast.clip(attacker.body, spec.draw.clip);
    segments.push({ clip: draw, start: begin, end: begin + spec.draw.until + 0.2, rate: 1, offset: 0, fadeIn: 0.16, fadeOut: 0.2 });
    tl.at(begin + spec.draw.grab, () => attacker.drawWeapons(true));
    strikeStart = begin + spec.draw.until;
  }
  const strikeEnd = strikeStart + whenClip(endClip);
  segments.push({ clip: attack, start: strikeStart, end: strikeEnd, rate, offset: 0, fadeIn: 0.16, fadeOut: 0.34, warp: warp ? (into) => warp.at(into) : undefined });
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
          const c = clipAt(time - strikeStart);
          const k = smoothstep(last.time - 0.55, last.time - 0.32, c) * (1 - smoothstep(last.time + 0.2, last.time + 0.5, c));
          if (k > 0) aimPose(pose, rig, aimed, strike.aim * k, scratch);
        }
      : undefined;
  planSegments(tl, attacker, P, faceYaw, segments, arrive, recovered, { planted: captureTuning.plantedStrike && attacker.design.slide !== undefined && !spec.old, adjust });

  return {
    arrive,
    cutIn,
    notice,
    hitTimes: strike.contacts.map((c) => strikeStart + whenClip(c.time)),
    contacts: strike.contacts,
    strikeStart,
    strikeEnd,
    clipTime: (time) => clipAt(time - strikeStart),
    top: strikeStart + whenClip(apex),
    recovered,
  };
}

/**
 * A strike made from the air: the piece springs from where it stands and brings its weapon
 * down as it lands beside the victim. The jump-attack clip leaps on the spot; its take-off
 * and landing are stretched over the piece's own flight across the board.
 */
function planLeapStrike({ tl, stage, attacker, spec, strike, A, P, home, faceYaw, lead, zone }: StrikeSetup): StrikePlan {
  const leap = spec.leap!;
  const jump = stage.cast.clip(attacker.body, spec.clip);
  const track = strike.track;
  const distance = A.distanceTo(P);
  const crouch = 0.3;
  const flight = 0.62 + 0.08 * distance;
  // Lower than a plain leap: the clip adds a jump of its own.
  const apex = (0.34 + 0.1 * distance) * attacker.design.scale;
  // How far the camera rises to keep the leap in frame.
  const boom = 0.5 * (apex + 0.7 * attacker.design.scale);
  const airClip = leap.land - leap.launch;
  /** Seconds after take-off at which the clip reaches `clip`. */
  const sinceLaunch = (clip: number): number => (clip <= leap.land ? ((clip - leap.launch) / airClip) * flight : flight + (clip - leap.land));
  /** Where the body is `s` seconds after take-off. */
  const rootAt = (s: number, out: THREE.Vector3): THREE.Vector3 => {
    const u = clamp01(s / flight);
    out.lerpVectors(A, P, ease.inOutSine(u) * 0.35 + u * 0.65);
    out.y = apex * 4 * u * (1 - u);
    return out;
  };

  // The blow falls just before the feet touch down, while the body is still a little short
  // of its landing place and above the floor: find the real moment of contact with that
  // taken into account.
  const cosYaw = Math.cos(faceYaw);
  const sinYaw = Math.sin(faceYaw);
  const scratch = new THREE.Vector3();
  const offset = (clip: number, out: THREE.Vector3): void => {
    rootAt(sinceLaunch(clip), scratch).sub(P);
    out.set(scratch.x * cosYaw - scratch.z * sinYaw, scratch.y, scratch.x * sinYaw + scratch.z * cosYaw);
  };
  const reach = strike.distance - zone.forward;
  const tx = reach * Math.sin(strike.bearing);
  const tz = reach * Math.cos(strike.bearing);
  const contacts = strike.contacts.map((c) => findContact(track, c.time, c.along, tx, tz, zone, StrikeTrack.STEP, 0.1, 0.22, offset));

  // The victim must be ready before the first blow; if the leap is too quick for that, it
  // waits a moment before springing.
  let t0 = 0.16;
  const need = lead + (spec.old ? GUARD_LEAD + 0.05 : NOTICE + READY);
  const available = t0 + crouch + sinceLaunch(contacts[0].time) - 0.1;
  if (need > available) t0 += need - available;
  const launch = t0 + crouch;
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
    attacker.root.rotation.set(0, home + turn * ease.inOutCubic(clamp01((time - t0) / (crouch + flight * 0.3))), 0);
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

  const notice = hitTimes[0] - need;
  return { arrive: touchdown, cutIn: Math.max(0.05, Math.min(touchdown - CUT_LEAD, notice - 0.1)), notice, hitTimes, contacts, strikeStart: t0, strikeEnd: recovered, clipTime, top: launch, recovered };
}

/**
 * A victim that meets its end standing. It wakes as the shot opens and comes round to face
 * its attacker, in the manner of its kind and without hurry (a crouched pawn rises as it
 * turns). Then it stands its ground: over the last moments its weight goes back a little and
 * its chin comes up, and it is upright when the blow lands. A blow that is not the last one
 * staggers it without bringing it down.
 */
function planStandingVictim(tl: Timeline, stage: Stage, victim: Actor, V: THREE.Vector3, P: THREE.Vector3, notice: number, fromYaw: number, toYaw: number, hitTimes: readonly number[]): void {
  const rig = victim.template.rig;
  const finalHit = hitTimes[hitTimes.length - 1];
  const faced = planTurn(tl, stage, victim, V, notice, fromYaw, toYaw, { rise: true, rate: VICTIM_TURN });
  const start = Math.min(faced, finalHit);
  if (finalHit - start < 1e-3) return;

  const flinch = stage.cast.clip(victim.body, REACT.flinch);
  const layers: PoseLayer[] = [...baseLayers(victim), { clip: flinch, time: 0, weight: 0 }];
  const at = V.clone();
  // Away from the attacker, along the floor.
  const back = V.clone().sub(P).setY(0);
  if (back.lengthSq() > 1e-8) back.normalize();
  const head = rig.index.get('head');
  let brace = 0;
  tl.at(start, () => {
    if (victim.design.slide) victim.planter.hold(victim.stance);
    else {
      victim.planter.release();
      victim.planter.enabled = true;
    }
    if (head !== undefined) victim.adjust = (pose) => turnBone(pose, rig, head, ACROSS, -BRACE_CHIN * brace);
  });
  tl.span(start, finalHit - start, (local, dt) => {
    const t = start + local;
    brace = smoothstep(finalHit - BRACE_TIME, finalHit - 0.06, t);
    // The earlier blows, if there are any, each knock it for a moment.
    let knocked = 0;
    for (const h of hitTimes) {
      if (h >= finalHit || t < h || t > h + 0.36) continue;
      const w = clamp01((t - h) / 0.05) * clamp01((h + 0.36 - t) / 0.16);
      knocked = Math.max(knocked, w * w * (3 - 2 * w) * 0.55);
      layers[2].time = t - h;
    }
    layers[2].weight = knocked;
    setBase(layers, 1 - knocked, 1);
    victim.root.position.copy(at).addScaledVector(back, BRACE_SHIFT * victim.design.scale * brace);
    victim.root.rotation.set(0, toYaw, 0);
    // Not "settled": the shift of weight is not something to step after.
    victim.animate(layers, dt, false);
  });
}

/** A victim of the old kind: it turns to face its attacker and crouches behind a guard. */
function planGuardingVictim(tl: Timeline, stage: Stage, victim: Actor, V: THREE.Vector3, notice: number, fromYaw: number, toYaw: number, hitTimes: readonly number[]): void {
  const finalHit = hitTimes[hitTimes.length - 1];
  const faced = planTurn(tl, stage, victim, V, notice, fromYaw, toYaw, { rise: true });
  const guard = stage.cast.clip(victim.body, REACT.guard);
  const flinch = stage.cast.clip(victim.body, REACT.flinch);
  const guardStart = Math.max(faced, hitTimes[0] - GUARD_LEAD);
  const segments: Segment[] = [{ clip: guard, start: guardStart, end: finalHit + 1, rate: 1, offset: 0, fadeIn: 0.16, fadeOut: 0 }];
  for (const h of hitTimes.slice(0, -1)) {
    segments.push({ clip: flinch, start: h, end: h + 0.36, rate: 1, offset: 0, fadeIn: 0.05, fadeOut: 0.16 });
  }
  // The victim's track stops at the final blow: from then on it is rubble.
  if (finalHit > guardStart) planSegments(tl, victim, V, toYaw, segments, guardStart, finalHit);
}

/**
 * A capture, start to finish: the attacker comes within reach and strikes; the victim turns
 * to face it and stands its ground; the blow lands on its head with a beat of hit-stop and
 * slow motion and the victim breaks; the attacker takes the square through the rubble.
 */
export function planCapture(stage: Stage, event: MoveEvent): Timeline {
  const { cast, shatter } = stage;
  if (!event.capturedSquare) throw new Error('capture without a captured square');
  const attacker = cast.at(event.from);
  const victim = cast.at(event.capturedSquare);
  if (!attacker || !victim) throw new Error(`capture ${event.san}: statues missing`);

  const tl = new Timeline();
  const spec = ATTACKS[attacker.type][0];
  const posture: Posture = 'stand';
  const A = squareCentre(event.from);
  const V = squareCentre(event.capturedSquare);
  const T = squareCentre(event.to);
  const home = homeYaw(attacker.side);
  const victimHome = homeYaw(victim.side);

  // Where the attacker strikes from: as far back as its weapon reaches, never farther away
  // than where it already stands, turned and aimed so that the weapon lands where it should.
  const apart = A.distanceTo(V);
  let strike = strikeFor(stage, attacker, victim, spec, apart, posture);
  // A shuffle of a few inches reads as a twitch, not an approach: if the weapon reaches
  // from where the attacker already stands, strike from there.
  if (!spec.leap && apart - strike.distance < 0.45) {
    const fromHere = strikeFor(stage, attacker, victim, spec, apart, posture, apart);
    if (fromHere.lands && !fromHere.short && fromHere.contacts[fromHere.contacts.length - 1].along >= 0.55) strike = fromHere;
  }
  const zone = strikeZone(victim, spec, posture);
  const direct = A.clone().sub(V).setY(0).normalize();
  const P = strike.distance >= apart - 0.02 ? A.clone() : standingPoint(stage, attacker, victim, V, direct, strike.distance);
  const faceYaw = yawTowards(P, V) - strike.bearing;
  const victimFace = yawTowards(V, P);
  // How long the victim needs to come round to its attacker (and to stand, if it is crouched).
  const lead = turnDuration(victim, angleDelta(victimHome, victimFace), spec.old ? { rise: true } : { rise: true, rate: VICTIM_TURN });

  // ---------------------------------------------------------------- the attacker
  tl.at(0, () => attacker.wake(1.6, 5.5));
  const setup: StrikeSetup = { tl, stage, attacker, victim, spec, strike, A, P, V, home, faceYaw, lead, zone };
  const plan = spec.leap && A.distanceTo(P) > 0.8 ? planLeapStrike(setup) : planStandingStrike(setup);
  const { hitTimes, contacts, recovered } = plan;
  const finalHit = hitTimes[hitTimes.length - 1];

  // ---------------------------------------------------------------- the victim
  tl.at(plan.notice, () => victim.wake(1.0, 4.5));
  if (spec.old) planGuardingVictim(tl, stage, victim, V, plan.notice, victimHome, victimFace, hitTimes);
  else planStandingVictim(tl, stage, victim, V, P, plan.notice, victimHome, victimFace, hitTimes);

  // ---------------------------------------------------------------- the blows land
  const up = new THREE.Vector3(0, 1, 0);
  const attack = cast.clip(attacker.body, spec.clip);
  const track = strike.track;
  // Where the weapon goes on after the killing blow, so the stone can give way before it.
  const sweep: { at: number; point: THREE.Vector3 }[] = [];
  if (!spec.old) {
    for (let after = 0; after <= FOLLOW; after += 0.008) {
      const clipTime = plan.clipTime(finalHit + after);
      for (const along of [0.6, 0.8, 1]) sweep.push({ at: after, point: track.point(clipTime, along).applyAxisAngle(up, faceYaw).add(P) });
    }
  }
  contacts.forEach((contact, i) => {
    const point = contact.point.clone().applyAxisAngle(up, faceYaw).add(P);
    const direction = track.velocity(contact.time, contact.along).applyAxisAngle(up, faceYaw);
    if (!contact.found) {
      // The weapon does not reach: put the blow on the near side of the victim at chest height.
      point.copy(V).addScaledVector(P.clone().sub(V).normalize(), 0.12);
      point.y = victim.height * 0.62;
      if (direction.lengthSq() < 1) direction.copy(V).sub(P).normalize();
    }
    const last = i === contacts.length - 1;
    tl.at(hitTimes[i] - 0.2, () => stage.fx.swing(point, last ? 1 : 0.75));
    tl.at(hitTimes[i], () => {
      stage.fx.impact(point, direction, last ? 1 : 0.45, victim.side);
      if (!last) return;
      stage.slowMotion();
      stage.fx.collapse(V, victim.height, direction, victim.side);
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
  const stepOff = spec.old ? recovered + 0.12 : Math.max(recovered + 0.12, finalHit + STAND_OVER);
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
  const cutBack = Math.max(finalHit + (spec.old ? 1.2 : AFTERMATH), stepOff + 0.3);
  tl.at(cutBack, () => stage.cinema.release());

  Object.assign(tl.marks, { cutIn: plan.cutIn, notice: plan.notice, arrive: plan.arrive, strike: plan.strikeStart, top: plan.top, blow: finalHit, stepOff, cutBack });

  if (event.promotion) end = planPromotion(tl, stage, attacker, event.promotion as PieceType, event.to, Math.max(end, cutBack) + 0.15);
  tl.extend(Math.max(end, cutBack) + 0.12);
  return tl;
}
