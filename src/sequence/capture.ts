import * as THREE from 'three';
import type { BakedClip } from '../anim/bake';
import type { MoveEvent } from '../chess/game';
import type { Obstacle } from '../cinema/cinema';
import { angleDelta, clamp, clamp01, ease } from '../core/math';
import { homeYaw, squareCentre, yawTowards } from '../game/squares';
import type { Actor, PoseLayer } from '../pieces/actor';
import type { PieceType } from '../pieces/regalia';
import { ATTACKS, REACT, type AttackSpec } from './attacks';
import { baseLayers, planStepOn, planTravel, planTurn, setBase, turnDuration, type Stage } from './moves';
import { planPromotion } from './special';
import { findContact, solveStrike, StrikeTrack, strikeTrack, type Contact, type StrikeSolution } from './strike';
import { Timeline } from './timeline';

/** Seconds before the first blow at which the victim starts to raise its guard. */
const GUARD_LEAD = 0.4;

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
}

/**
 * Play a set of overlapping clips on a statue standing ready at `position` with heading `yaw`
 * (it has already risen, if it is one that rises). Wherever no clip has weight its standing
 * pose shows through.
 */
function planSegments(tl: Timeline, actor: Actor, position: THREE.Vector3, yaw: number, segments: Segment[], t0: number, t1: number): void {
  const at = position.clone();
  const layers: PoseLayer[] = [...baseLayers(actor), ...segments.map((s) => ({ clip: s.clip, time: 0, weight: 0 }))];
  tl.at(t0, () => {
    actor.planter.release();
    actor.planter.enabled = true;
  });
  tl.span(t0, t1 - t0, (local, dt) => {
    const t = t0 + local;
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
      layer.time = Math.min(Math.max(s.offset + into * s.rate, 0), s.clip.duration);
      total += layer.weight;
    });
    setBase(layers, Math.max(0, 1 - total), 1);
    actor.root.position.copy(at);
    actor.root.rotation.set(0, yaw, 0);
    actor.animate(layers, dt, false);
  });
}

/**
 * The cylinder a weapon must enter to count as striking a statue. It is deliberately narrower
 * than the torso, so the weapon is some way into the body at the moment of the blow rather
 * than touching its surface.
 */
function strikeTarget(victim: Actor): { radius: number; height: number } {
  return { radius: 0.075 * victim.design.scale, height: victim.height * 0.98 };
}

const solutions = new Map<string, StrikeSolution>();

/** The (cached) placing of one kind of attacker against one kind of victim. */
export function strikeFor(stage: Stage, attacker: Actor, victim: Actor, spec: AttackSpec, maxDistance: number, exactly?: number): StrikeSolution {
  // Captures come from one of a few distances, so the limit can be part of the key.
  const limit = Math.round(Math.min(maxDistance, 3) * 20) / 20;
  const key = `${attacker.type}>${victim.type}@${exactly === undefined ? limit : `=${exactly.toFixed(3)}`}`;
  let s = solutions.get(key);
  if (!s) {
    const track = strikeTrack(attacker, stage.cast.clip(attacker.body, spec.clip), spec.weapon ?? 0);
    const { radius, height } = strikeTarget(victim);
    s = exactly === undefined ? solveStrike(track, spec.hits, spec.along, radius, height, limit) : solveStrike(track, spec.hits, spec.along, radius, height, exactly, exactly);
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
  /** When the attacker is in place (the camera cut is timed off this). */
  arrive: number;
  /** When the victim should first notice and start turning. */
  notice: number;
  /** One per blow: when it lands, and where the weapon meets the victim in the attacker's frame. */
  hitTimes: number[];
  contacts: Contact[];
  /** The stretch of the timeline over which the attack clip plays, and the clip time within it. */
  strikeStart: number;
  strikeEnd: number;
  clipTime(t: number): number;
  /** When the attacker is back in its frozen pose and can walk on. */
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
  /** How long the victim needs to turn and face the attacker. */
  turnTime: number;
}

/**
 * The usual strike: come within reach on foot (or by gliding), square up, and attack from a
 * standing start.
 */
function planStandingStrike({ tl, stage, attacker, spec, strike, A, P, home, faceYaw, turnTime }: StrikeSetup): StrikePlan {
  const { cast } = stage;
  const rate = spec.rate ?? 1;

  let t = 0.16;
  if (A.distanceTo(P) > 0.12) {
    t = planTravel(tl, stage, attacker, A, P, t, { finalYaw: faceYaw, handOff: true });
    // A statue that drifts without turning squares up to its victim once it has landed.
    if (attacker.design.glide && !attacker.design.glide.turns) t = planTurn(tl, stage, attacker, P, t, home, faceYaw);
  } else {
    t = planTurn(tl, stage, attacker, P, t, home, faceYaw, { rise: true });
  }
  const arrive = t;
  const notice = Math.max(0.1, arrive - 0.45 - turnTime);
  const faced = notice + turnTime;

  const attack = cast.clip(attacker.body, spec.clip);
  const firstContact = strike.contacts[0].time / rate;
  const last = strike.contacts[strike.contacts.length - 1];
  const segments: Segment[] = [];
  // The first blow waits for the victim to have turned and begun to guard.
  const drawTime = spec.draw ? spec.draw.until : 0;
  const begin = Math.max(arrive + 0.04, faced + GUARD_LEAD - firstContact - drawTime);
  let strikeStart = begin;
  if (spec.draw) {
    // Reach over the shoulder, close the hand on the hilt, bring the blade round.
    const draw = cast.clip(attacker.body, spec.draw.clip);
    segments.push({ clip: draw, start: begin, end: begin + spec.draw.until + 0.2, rate: 1, offset: 0, fadeIn: 0.16, fadeOut: 0.2 });
    tl.at(begin + spec.draw.grab, () => attacker.drawWeapons(true));
    strikeStart = begin + spec.draw.until;
  }
  const strikeEnd = strikeStart + Math.min(attack.duration, last.time + spec.followThrough) / rate;
  segments.push({ clip: attack, start: strikeStart, end: strikeEnd, rate, offset: 0, fadeIn: 0.16, fadeOut: 0.34 });
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
  planSegments(tl, attacker, P, faceYaw, segments, arrive, recovered);

  return {
    arrive,
    notice,
    hitTimes: strike.contacts.map((c) => strikeStart + c.time / rate),
    contacts: strike.contacts,
    strikeStart,
    strikeEnd,
    clipTime: (time) => (time - strikeStart) * rate,
    recovered,
  };
}

/**
 * A strike made from the air: the piece springs from where it stands and brings its weapon
 * down as it lands beside the victim. The jump-attack clip leaps on the spot; its take-off
 * and landing are stretched over the piece's own flight across the board.
 */
function planLeapStrike({ tl, stage, attacker, victim, spec, strike, A, P, home, faceYaw, turnTime }: StrikeSetup): StrikePlan {
  const leap = spec.leap!;
  const jump = stage.cast.clip(attacker.body, spec.clip);
  const track = strikeTrack(attacker, jump, spec.weapon ?? 0);
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
  const { radius, height } = strikeTarget(victim);
  const tx = strike.distance * Math.sin(strike.bearing);
  const tz = strike.distance * Math.cos(strike.bearing);
  const contacts = strike.contacts.map((c) => findContact(track, c.time, c.along, tx, tz, radius, height, StrikeTrack.STEP, 0.1, 0.22, offset));

  // The victim must have turned and begun to guard before the first blow; if the leap is
  // too quick for that, it waits a moment before springing.
  let t0 = 0.16;
  const need = turnTime + GUARD_LEAD + 0.05;
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

  return { arrive: touchdown, notice: hitTimes[0] - need, hitTimes, contacts, strikeStart: t0, strikeEnd: recovered, clipTime, recovered };
}

/**
 * A capture, start to finish: the attacker comes within reach and strikes; the victim turns
 * to face it and guards; the blow lands with a beat of hit-stop and slow motion and the
 * victim breaks; the attacker steps through the rubble onto the square.
 */
export function planCapture(stage: Stage, event: MoveEvent): Timeline {
  const { cast, shatter } = stage;
  if (!event.capturedSquare) throw new Error('capture without a captured square');
  const attacker = cast.at(event.from);
  const victim = cast.at(event.capturedSquare);
  if (!attacker || !victim) throw new Error(`capture ${event.san}: statues missing`);

  const tl = new Timeline();
  const spec = ATTACKS[attacker.type];
  const A = squareCentre(event.from);
  const V = squareCentre(event.capturedSquare);
  const T = squareCentre(event.to);
  const home = homeYaw(attacker.side);
  const victimHome = homeYaw(victim.side);

  // Where the attacker strikes from: as far back as its weapon reaches, never farther away
  // than where it already stands, turned so that the weapon passes through the victim.
  const apart = A.distanceTo(V);
  let strike = strikeFor(stage, attacker, victim, spec, apart);
  // A shuffle of a few inches reads as a twitch, not an approach: if the weapon reaches
  // from where the attacker already stands, strike from there.
  if (!spec.leap && apart - strike.distance < 0.45) {
    const fromHere = strikeFor(stage, attacker, victim, spec, apart, apart);
    if (fromHere.lands && fromHere.contacts[fromHere.contacts.length - 1].along >= 0.55) strike = fromHere;
  }
  const direct = A.clone().sub(V).setY(0).normalize();
  const P = strike.distance >= apart - 0.02 ? A.clone() : standingPoint(stage, attacker, victim, V, direct, strike.distance);
  const faceYaw = yawTowards(P, V) - strike.bearing;
  const victimFace = yawTowards(V, P);
  // How long the victim needs to come round to its attacker (and to stand, if it is crouched).
  const turnTime = turnDuration(victim, angleDelta(victimHome, victimFace), { rise: true });

  // ---------------------------------------------------------------- the attacker
  tl.at(0, () => attacker.wake(1.6, 5.5));
  const setup: StrikeSetup = { tl, stage, attacker, victim, spec, strike, A, P, V, home, faceYaw, turnTime };
  const plan = spec.leap && A.distanceTo(P) > 0.8 ? planLeapStrike(setup) : planStandingStrike(setup);
  const { hitTimes, contacts, recovered } = plan;
  const finalHit = hitTimes[hitTimes.length - 1];

  // ---------------------------------------------------------------- the victim
  // It wakes as the attacker closes, turns to face it and throws up a guard.
  tl.at(plan.notice, () => victim.wake(1.0, 4.5));
  const faced = planTurn(tl, stage, victim, V, plan.notice, victimHome, victimFace, { rise: true });
  const guard = cast.clip(victim.body, REACT.guard);
  const flinch = cast.clip(victim.body, REACT.flinch);
  const guardStart = Math.max(faced, hitTimes[0] - GUARD_LEAD);
  const victimSegments: Segment[] = [{ clip: guard, start: guardStart, end: finalHit + 1, rate: 1, offset: 0, fadeIn: 0.16, fadeOut: 0 }];
  for (const h of hitTimes.slice(0, -1)) {
    victimSegments.push({ clip: flinch, start: h, end: h + 0.36, rate: 1, offset: 0, fadeIn: 0.05, fadeOut: 0.16 });
  }
  // The victim's track stops at the final blow: from then on it is rubble.
  if (finalHit > guardStart) planSegments(tl, victim, V, victimFace, victimSegments, guardStart, finalHit);

  // ---------------------------------------------------------------- the blows land
  const up = new THREE.Vector3(0, 1, 0);
  const attack = cast.clip(attacker.body, spec.clip);
  const track = strikeTrack(attacker, attack, spec.weapon ?? 0);
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
      shatter.shatter(victim, { point, direction, power: spec.power });
    });
  });

  // ---------------------------------------------------------------- the arcs the weapons leave
  const trailWeapons = spec.trails ?? [spec.weapon ?? 0];
  const trailTracks = trailWeapons.map((w) => strikeTrack(attacker, attack, w));
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

  // ---------------------------------------------------------------- stepping onto the square
  // A beat to take in the wreckage, then through it.
  const stepOff = recovered + 0.12;
  tl.at(stepOff, () => shatter.setPusher(attacker));
  let end = planStepOn(tl, stage, attacker, P, T, stepOff, faceYaw, home);
  tl.at(end, () => {
    shatter.setPusher(null);
    cast.relocate(attacker, event.to);
    attacker.wake(0, 0);
  });

  // ---------------------------------------------------------------- camera
  // Cut to a two-shot shortly before the attacker arrives; cut back once the wreckage has
  // had its moment.
  const cutIn = Math.max(0.05, Math.min(plan.arrive - 1.15, plan.notice - 0.1));
  tl.at(cutIn, () => {
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
  const cutBack = Math.max(finalHit + 1.2, stepOff + 0.3);
  tl.at(cutBack, () => stage.cinema.release());

  if (event.promotion) end = planPromotion(tl, stage, attacker, event.promotion as PieceType, event.to, Math.max(end, cutBack) + 0.15);
  tl.extend(Math.max(end, cutBack) + 0.12);
  return tl;
}
