import * as THREE from 'three';
import { GLIDE, LEAP } from '../anim/clips';
import type { Gait } from '../anim/gait';
import type { MoveEvent } from '../chess/game';
import type { Cinema } from '../cinema/cinema';
import { angleDelta, clamp01, ease, smoothstep } from '../core/math';
import type { Effects } from '../fx/effects';
import type { ShatterSystem } from '../fx/shatter';
import { homeYaw, SQUARE, squareCentre, yawTowards } from '../game/squares';
import type { Actor, PoseLayer } from '../pieces/actor';
import type { Cast } from '../pieces/cast';
import type { PieceType } from '../pieces/regalia';
import type { GlideSpec, SlideSpec } from '../pieces/roster';
import type { BodyKind } from '../pieces/statueKit';
import { SpeedProfile } from './pacing';
import { planPromotion } from './special';
import { Timeline } from './timeline';

/** What the choreography can reach. */
export interface Stage {
  cast: Cast;
  fx: Effects;
  shatter: ShatterSystem;
  cinema: Cinema;
  gait(kind: BodyKind, clip: string): Gait;
  /** Begin the beat of hit-stop and slow motion that marks a killing blow (`grand`: a longer, slower one). */
  slowMotion(grand?: boolean): void;
  /** Where the player's own camera is (whatever shot is on screen). */
  viewerPosition(): THREE.Vector3;
}

/** Radians per second for turning on the spot. */
export const TURN_RATE = 5.2;
const _v = new THREE.Vector3();

/**
 * The pose a statue holds when nothing else is moving it: its frozen pose and, for a statue
 * that rises before it acts, its standing pose. Two layers, weighted together by `setBase`.
 */
export function baseLayers(actor: Actor, mask?: Float32Array | null): [PoseLayer, PoseLayer] {
  return [
    { clip: actor.frozen, time: 0, weight: 1, mask },
    { clip: actor.upright, time: 0, weight: 0, mask },
  ];
}

/**
 * Share `weight` between the two base layers found at `at`: `risen` 0 is the frozen pose, 1 is
 * standing ready. (For a statue whose frozen pose is upright the two are the same pose.)
 */
export function setBase(layers: PoseLayer[], weight: number, risen: number, at = 0): void {
  layers[at].weight = weight * (1 - risen);
  layers[at + 1].weight = weight * risen;
}

/** How much of the rise is done before a statue sets off: it comes up into its first stride. */
const RISE_LEAD = 0.6;

export interface WalkOptions {
  /** World-space sideways bulge of the path (zero at both ends), used so castling pieces pass each other. */
  bulge?: THREE.Vector3;
  /**
   * Heading the statue has when this leg starts. Moves are planned in full before they play,
   * so a later leg cannot read the heading off the statue; defaults to its current heading.
   */
  startYaw?: number;
  /** Heading to finish on; defaults to facing the enemy. */
  finalYaw?: number;
  /**
   * The statue goes straight into another action on arrival (a strike): it does not pause to
   * settle into its frozen pose, and its planted feet are left exactly where they are.
   */
  handOff?: boolean;
  /** It is already standing ready (it has just fought), so it does not rise out of its frozen pose first. */
  risen?: boolean;
  /** A short hop onto a square just cleared, for a statue that floats: quicker and lower than a journey. */
  hop?: boolean;
}

/**
 * Walk or run from `from` to `to`. The statue turns towards its path as it sets off and back
 * to its final heading as it arrives; only for large turns does it pivot before moving. The
 * gait's phase is driven by distance covered, so the planted foot stays where it was put.
 * A statue whose frozen pose is not upright rises out of it into its first stride and settles
 * back into it once it has arrived. Returns the time at which it has arrived and settled.
 */
export function planWalk(tl: Timeline, stage: Stage, actor: Actor, from: THREE.Vector3, to: THREE.Vector3, t0: number, options: WalkOptions = {}): number {
  const design = actor.design;
  const scale = design.scale;
  const a = from.clone();
  const b = to.clone();
  const distance = a.distanceTo(b);
  const yaw0 = options.startYaw ?? actor.root.rotation.y;
  const yawEnd = options.finalYaw ?? homeYaw(actor.side);
  let travelYaw = yawTowards(a, b);

  // Rising and settling only mean anything to a statue with a standing pose of its own.
  const crouches = actor.upright !== actor.frozen;
  const rise = crouches && !options.risen ? design.rise ?? 0 : 0;
  const settle = crouches && !options.handOff ? design.settle ?? 0 : 0;
  /** When it starts to turn and travel. */
  const go = t0 + rise * RISE_LEAD;

  // Short retreats are walked backwards, still facing the enemy.
  let spec = distance > SQUARE * 1.6 ? design.run : design.walk;
  if (Math.abs(angleDelta(yaw0, travelYaw)) > 2.2 && distance <= SQUARE * 2.05) {
    spec = design.back;
    travelYaw += Math.PI;
  }
  const gait = stage.gait(actor.body, spec.clip);
  const speed = gait.speed * scale * spec.rate;
  const profile = new SpeedProfile(distance, speed, spec === design.run ? 0.3 : 0.34);

  const stride = gait.cycle * scale;

  const turnIn = angleDelta(yaw0, travelYaw);
  const turnOut = angleDelta(travelYaw, yawEnd);
  const tIn = Math.abs(turnIn) < 0.02 ? 0 : 0.16 + Math.abs(turnIn) / TURN_RATE;
  const tOut = Math.abs(turnOut) < 0.02 ? 0 : 0.16 + Math.abs(turnOut) / TURN_RATE;
  // Big turns are mostly made on the spot; small ones are made on the move.
  const startTravel = go + (Math.abs(turnIn) > 0.9 ? tIn * 0.6 : 0);
  const arrive = startTravel + profile.duration;
  const startOut = arrive - Math.min(tOut * 0.45, profile.duration * 0.35);
  const still = Math.max(arrive, startOut + tOut);
  // Time for the feet to step into the frozen stance.
  const end = still + (options.handOff ? 0.06 : Math.max(0.42, settle));

  // Gait phase against travel time. The gait is blended in by weight w, which shortens the
  // stride the legs actually take to w * stride, so the phase must advance faster by 1 / w
  // for the planted foot to keep pace with the ground.
  const STEP = 1 / 240;
  const weightAt = (tt: number): number => smoothstep(0, 0.45, profile.fraction(tt));
  const phases = [gait.passing];
  for (let tt = 0; tt < profile.duration; tt += STEP) {
    const ds = profile.at(tt + STEP) - profile.at(tt);
    phases.push(phases[phases.length - 1] + ds / (stride * Math.max(0.4, weightAt(tt + STEP * 0.5))));
  }
  const phaseAt = (tt: number): number => {
    const f = Math.min(Math.max(tt / STEP, 0), phases.length - 1);
    const i = Math.min(Math.floor(f), phases.length - 2);
    return phases[i] + (phases[i + 1] - phases[i]) * (f - i);
  };
  /** How far out of its frozen pose it is: up as it sets off, down again once it has stopped. */
  const risenAt = (t: number): number => {
    if (!crouches) return 0;
    const up = rise > 0 ? ease.inOutCubic(clamp01((t - t0) / rise)) : 1;
    const down = settle > 0 ? ease.inOutCubic(clamp01((t - still) / settle)) : 0;
    return up * (1 - down);
  };

  const layers: PoseLayer[] = [
    ...baseLayers(actor, actor.lowerMask),
    ...baseLayers(actor, actor.upperMask),
    { clip: gait.clip, time: 0, weight: 0, mask: actor.lowerMask },
    { clip: gait.clip, time: 0, weight: 0, mask: actor.upperMask },
  ];

  tl.at(t0, () => {
    actor.planter.reset();
    actor.planter.enabled = true;
  });
  tl.span(t0, end - t0, (local, dt) => {
    const t = t0 + local;
    const tt = t - startTravel;
    const s = profile.at(tt);
    const u = distance > 1e-6 ? s / distance : 1;
    actor.root.position.lerpVectors(a, b, u);
    if (options.bulge) actor.root.position.addScaledVector(options.bulge, Math.sin(Math.PI * u));

    let yaw = yaw0;
    if (tIn > 0) yaw += turnIn * ease.inOutCubic(clamp01((t - go) / tIn));
    else yaw += turnIn;
    if (tOut > 0) yaw += turnOut * ease.inOutCubic(clamp01((t - startOut) / tOut));
    else if (t >= arrive) yaw += turnOut;
    actor.root.rotation.y = yaw;

    const w = weightAt(tt);
    const phase = phaseAt(tt);
    const clipTime = (phase - Math.floor(phase)) * gait.clip.duration;
    const risen = risenAt(t);
    setBase(layers, 1 - w, risen, 0);
    setBase(layers, 1 - design.carry * w, risen, 2);
    layers[4].weight = w;
    layers[4].time = clipTime;
    layers[5].weight = design.carry * w;
    layers[5].time = clipTime;
    actor.animate(layers, dt, t >= still);
  });

  // Footfalls: find when the gait phase crosses each foot's contact phase.
  const step = STEP;
  let prev = gait.passing;
  for (let tt = step; tt < profile.duration; tt += step) {
    const phase = phaseAt(tt);
    for (let foot = 0; foot < 2; foot++) {
      const c = gait.contacts[foot];
      if (Math.floor(phase - c) > Math.floor(prev - c) && profile.fraction(tt) > 0.25) {
        const bone = foot === 0 ? 'ball_l' : 'ball_r';
        tl.at(startTravel + tt, () => {
          actor.instance.byName.get(bone)?.getWorldPosition(_v);
          stage.fx.footstep(_v, design.heft);
        });
      }
    }
    prev = phase;
  }

  tl.at(end, () => {
    actor.root.position.copy(b);
    actor.root.rotation.set(0, yawEnd, 0);
    if (!options.handOff) actor.rest();
  });
  return end;
}

/**
 * The timing and height of a leap across `distance` metres of floor by a statue of a given
 * scale. One that goes straight into a strike (`handOff`) comes up out of its landing sooner.
 */
export function leapShape(distance: number, scale: number, handOff = false): { crouch: number; flight: number; recover: number; apex: number } {
  return { crouch: 0.3, flight: 0.62 + 0.08 * distance, recover: handOff ? 0.42 : 0.62, apex: (1.0 + 0.2 * distance) * scale };
}

/**
 * A knight's move: crouch, spring in a high arc over whatever stands between, land in a
 * crouch and rise. Turning happens in the air, where there are no feet to slide.
 */
export function planLeap(tl: Timeline, stage: Stage, actor: Actor, from: THREE.Vector3, to: THREE.Vector3, t0: number, options: WalkOptions = {}): number {
  const design = actor.design;
  const a = from.clone();
  const b = to.clone();
  const distance = a.distanceTo(b);
  const yaw0 = options.startYaw ?? actor.root.rotation.y;
  const yawEnd = options.finalYaw ?? homeYaw(actor.side);
  const travelYaw = yawTowards(a, b);
  const turnIn = angleDelta(yaw0, travelYaw);
  const turnOut = angleDelta(travelYaw, yawEnd);

  const { crouch, flight, recover, apex } = leapShape(distance, design.scale, options.handOff);
  const launch = t0 + crouch;
  const touchdown = launch + flight;
  const end = touchdown + recover;

  const start = stage.cast.clip(actor.body, LEAP.start);
  const air = stage.cast.clip(actor.body, LEAP.air);
  const land = stage.cast.clip(actor.body, LEAP.land);
  const LAND_CONTACT = 0.17; // seconds into the landing clip at which the feet meet the ground
  const layers: PoseLayer[] = [
    { clip: actor.frozen, time: 0, weight: 1 },
    { clip: start, time: 0, weight: 0 },
    { clip: air, time: 0, weight: 0 },
    { clip: land, time: 0, weight: 0 },
  ];

  tl.span(t0, end - t0, (local) => {
    const t = t0 + local;
    const u = clamp01((t - launch) / flight);
    actor.root.position.lerpVectors(a, b, ease.inOutSine(u) * 0.35 + u * 0.65);
    actor.root.position.y = apex * 4 * u * (1 - u);

    // Wind up towards the target while crouching, finish the turn in the first part of the
    // flight, and come round to the final heading before landing.
    const inK = ease.inOutCubic(clamp01((t - t0) / (crouch + flight * 0.3)));
    const outK = ease.inOutCubic(clamp01((t - (launch + flight * 0.45)) / (flight * 0.5)));
    actor.root.rotation.y = yaw0 + turnIn * inK + turnOut * outK;

    const tf = t - launch; // time since launch (negative while crouching)
    const tr = t - touchdown; // time since touchdown
    let wStart = 0;
    let wAir = 0;
    let wLand = 0;
    if (tf < 0) {
      wStart = ease.outCubic(clamp01((t - t0) / (crouch * 0.8)));
      layers[1].time = 0;
    } else if (tr < 0) {
      wLand = smoothstep(flight - LAND_CONTACT - 0.06, flight - 0.03, tf);
      wAir = smoothstep(0.26, 0.42, tf) * (1 - wLand);
      wStart = (1 - smoothstep(0.26, 0.42, tf)) * (1 - wLand);
      layers[1].time = Math.min(0.02 + tf * 1.2, 0.5);
      layers[2].time = tf;
      layers[3].time = Math.max(0, tf - (flight - LAND_CONTACT));
    } else {
      // Rise from the landing crouch, then settle into the frozen pose.
      const settle = smoothstep(recover - 0.3, recover, tr);
      wLand = 1 - settle;
      layers[3].time = LAND_CONTACT + tr * 1.25;
    }
    layers[0].weight = Math.max(0, 1 - wStart - wAir - wLand);
    layers[1].weight = wStart;
    layers[2].weight = wAir;
    layers[3].weight = wLand;
    actor.animate(layers);
  });

  tl.at(touchdown, () => stage.fx.landing(b, design.heft));
  tl.at(end, () => {
    actor.root.position.copy(b);
    actor.root.rotation.set(0, yawEnd, 0);
    actor.rest();
  });
  return end;
}

/** The timing of one glide, worked out the same way wherever it is needed. */
function glideTimes(spec: GlideSpec, distance: number, turn: number, hop: boolean): { rise: number; travel: number; settle: number; startTravel: number; arrive: number; descend: number; end: number } {
  const calm = spec.calm === true;
  const rise = spec.rise * (hop ? 0.7 : 1);
  const settle = spec.settle * (hop ? 0.85 : 1);
  // Turning where it hangs takes as long as the turn needs; otherwise the distance decides.
  const travel = distance < 0.05 ? Math.max(0.35, Math.abs(turn) / 2.6) : spec.base * (hop ? 0.8 : 1) + distance / spec.speed;
  const startTravel = rise * (calm ? 0.8 : 0.6) + (hop ? 0 : spec.poise);
  const arrive = startTravel + travel;
  // A calm statue is already sinking as it comes to rest; the other stops, then drops.
  const descend = arrive - (calm ? settle * 0.3 : 0);
  return { rise, travel, settle, startTravel, arrive, descend, end: descend + settle };
}

/**
 * A move through the air, for a statue that does not walk: it lifts off the board, drifts to
 * its square leaning into the motion, and settles. How it does so is its design's `glide`:
 * the bishop springs up, bobs and drops; the queen rises slowly, hands lifting from her sides
 * as if by will, travels upright and sinks to her square as her hands come down. A statue
 * that `turns` comes round to `finalYaw` in the air; the others keep their heading.
 */
export function planGlide(tl: Timeline, stage: Stage, actor: Actor, from: THREE.Vector3, to: THREE.Vector3, t0: number, options: WalkOptions = {}): number {
  const design = actor.design;
  const spec = design.glide;
  if (!spec) throw new Error(`${design.name} does not glide`);
  const a = from.clone();
  const b = to.clone();
  const distance = a.distanceTo(b);
  const yaw0 = options.startYaw ?? actor.root.rotation.y;
  const yawEnd = spec.turns ? options.finalYaw ?? yaw0 : yaw0;
  const turn = angleDelta(yaw0, yawEnd);
  const calm = spec.calm === true;
  const hop = options.hop === true;
  const times = glideTimes(spec, distance, turn, hop);
  const { rise, travel, settle } = times;
  const startTravel = t0 + times.startTravel;
  const arrive = t0 + times.arrive;
  const descend = t0 + times.descend;
  const end = t0 + times.end;
  // Turning on the spot it barely leaves the floor; a hop is lower than a journey.
  const onSpot = distance < 0.05;
  const hover = spec.hover * design.scale * (onSpot ? Math.min(1, 0.35 + Math.abs(turn) / 1.6) : hop ? 0.75 : 1);
  // It comes round over the last part of the flight and the start of the descent.
  const turnStart = onSpot ? t0 + rise * 0.45 : arrive - travel * 0.55;
  const turnTime = (onSpot ? descend + settle * 0.35 : arrive + settle * 0.3) - turnStart;

  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const up = calm ? ease.inOutCubic : ease.outCubic;
  const along = calm ? ease.inOutSine : ease.inOutCubic;

  const float = stage.cast.clip(actor.body, GLIDE);
  const hands = actor.hands;
  // With a flourish of the hands, body and arms are layered apart so the arms can do their own thing.
  const layers: PoseLayer[] = hands
    ? [
        { clip: actor.frozen, time: 0, weight: 1, mask: actor.bodyMask },
        { clip: float, time: 0, weight: 0, mask: actor.bodyMask },
        { clip: actor.frozen, time: 0, weight: 1, mask: actor.armMask },
        { clip: float, time: 0, weight: 0, mask: actor.armMask },
        { clip: hands, time: 0, weight: 0, mask: actor.armMask },
      ]
    : [
        { clip: actor.frozen, time: 0, weight: 1 },
        { clip: float, time: 0, weight: 0 },
      ];

  // In the air there are no feet to pin: let go of any the last action left pinned.
  tl.at(t0, () => {
    actor.planter.reset();
    actor.planter.enabled = false;
  });
  tl.span(t0, end - t0, (local) => {
    const t = t0 + local;
    const k = clamp01((t - startTravel) / travel);
    const lift = up(clamp01((t - t0) / rise)) * (1 - ease.inOutCubic(clamp01((t - descend) / settle)));
    actor.root.position.lerpVectors(a, b, along(k));
    actor.root.position.y = hover * lift + Math.sin(t * 2.6) * spec.bob * lift;
    const yaw = turn === 0 ? yaw0 : yaw0 + turn * ease.inOutCubic(clamp01((t - turnStart) / turnTime));
    // Lean in the statue's own frame so it tips towards where it is going: most at full speed.
    const speed = Math.sin(Math.PI * k);
    const localX = (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / len;
    const localZ = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / len;
    actor.root.rotation.set(spec.lean * speed * localZ, yaw, -spec.lean * speed * localX, 'YXZ');
    // The float clip sways; a calm statue is held nearly still in it.
    const floatTime = calm ? (t - t0) * 0.3 : t - t0;
    layers[0].weight = 1 - lift;
    layers[1].weight = lift;
    layers[1].time = floatTime;
    if (hands) {
      // The hands lead the lift a little on the way up and are down before the feet are.
      const h = smoothstep(t0, t0 + rise * 0.9, t) * (1 - smoothstep(descend, descend + settle * 0.8, t));
      layers[2].weight = (1 - lift) * (1 - h);
      layers[3].weight = lift * (1 - h);
      layers[3].time = floatTime;
      layers[4].weight = h;
    }
    actor.animate(layers);
  });

  if (calm) tl.at(descend + settle * 0.85, () => stage.fx.settle(b, spec.land));
  else tl.at(arrive + settle * 0.75, () => stage.fx.landing(b, design.heft * spec.land));
  tl.at(end, () => {
    actor.root.position.copy(b);
    actor.root.rotation.set(0, yawEnd, 0);
    actor.rest();
  });
  return end;
}

/** Seconds a slider takes to pivot through `delta` radians: eased, so the middle is the fastest part. */
function pivotDuration(spec: SlideSpec, delta: number): number {
  return Math.abs(delta) < 0.03 ? 0 : 0.35 + Math.abs(delta) / spec.pivot;
}

/** Seconds a slider takes to rock back and settle its weight once it has stopped. */
const SLIDE_SETTLE = 0.5;
const _dir = new THREE.Vector3();
const _heading = new THREE.Vector3();

/**
 * A move for a statue that neither walks nor floats: it is dragged across the board as if by
 * an unseen hand, feet flat on the stone the whole way, in the stance it stands frozen in.
 * Slow to start, steady, slow to stop; it leans a little into the way it is going and its
 * weight rocks back and settles when it arrives. It does not turn to face its path. If it
 * has to end on another heading it pivots, feet planted: before setting off when it is
 * closing on a victim (`handOff`), as it goes otherwise.
 */
export function planSlide(tl: Timeline, stage: Stage, actor: Actor, from: THREE.Vector3, to: THREE.Vector3, t0: number, options: WalkOptions = {}): number {
  const design = actor.design;
  const spec = design.slide;
  if (!spec) throw new Error(`${design.name} does not slide`);
  const a = from.clone();
  const b = to.clone();
  const distance = a.distanceTo(b);
  const yaw0 = options.startYaw ?? actor.root.rotation.y;
  const yawEnd = options.finalYaw ?? yaw0;
  const turn = angleDelta(yaw0, yawEnd);
  const pivot = pivotDuration(spec, turn);
  if (distance < 1e-4 && pivot === 0) return t0;
  const profile = new SpeedProfile(distance, spec.speed, spec.ramp, true);
  const handOff = options.handOff === true;
  const startTravel = t0 + (handOff ? pivot * 0.85 : 0);
  const arrive = startTravel + profile.duration;
  const turnTime = handOff ? pivot : Math.max(pivot, profile.duration * 0.9);
  const still = Math.max(arrive, t0 + turnTime);
  const end = still + (handOff ? 0.06 : SLIDE_SETTLE);
  const scale = design.scale;
  const bulge = options.bulge;
  const layers = baseLayers(actor);
  let puff = 0;
  let lastYaw = yaw0;

  tl.at(t0, () => {
    actor.planter.hold(actor.stance);
    stage.fx.grind(a, still - t0, design.heft);
  });
  tl.onAbort(() => stage.fx.grindStop());
  tl.span(t0, end - t0, (local, dt) => {
    const t = t0 + local;
    const tt = t - startTravel;
    const u = distance > 1e-6 ? profile.at(tt) / distance : 1;
    const root = actor.root;
    root.position.lerpVectors(a, b, u);
    // The way it is travelling at this moment (a castling rook swings out round the king).
    _heading.subVectors(b, a);
    if (bulge) {
      root.position.addScaledVector(bulge, Math.sin(Math.PI * u));
      _heading.addScaledVector(bulge, Math.PI * Math.cos(Math.PI * u));
    }
    _heading.y = 0;
    const len = _heading.length();
    const yaw = turnTime > 0 ? yaw0 + turn * ease.inOutCubic(clamp01((t - t0) / turnTime)) : yaw0;

    // Lean into the motion; once stopped, rock back a little and let the weight settle.
    const moving = profile.fraction(tt);
    let lean = spec.lean * moving;
    let dip = 0;
    const after = t - still;
    if (!handOff && after > 0) {
      const onset = smoothstep(0, 0.08, after);
      lean -= spec.lean * 0.45 * onset * Math.exp(-after * 8) * Math.sin(after * 15);
      dip = 0.014 * scale * onset * Math.exp(-after * 7) * Math.sin(after * 11);
    }
    const lx = len > 1e-6 ? (_heading.x * Math.cos(yaw) - _heading.z * Math.sin(yaw)) / len : 0;
    const lz = len > 1e-6 ? (_heading.x * Math.sin(yaw) + _heading.z * Math.cos(yaw)) / len : 0;
    root.position.y = -dip;
    root.rotation.set(lean * lz, yaw, -lean * lx, 'YXZ');
    setBase(layers, 1, 0);
    actor.animate(layers, dt, false);

    // Dust where the feet scrape: more of it the faster they go, or turn.
    const turning = dt > 0 ? Math.min(1, Math.abs(yaw - lastYaw) / dt / spec.pivot) * 0.6 : 0;
    lastYaw = yaw;
    const scraping = Math.max(moving, turning);
    puff += dt * scraping;
    if (puff > 0.085 && scraping > 0.08) {
      puff = 0;
      if (len > 1e-6) _dir.copy(_heading).divideScalar(len);
      else _dir.set(0, 0, 0);
      for (const bone of ['ball_l', 'ball_r']) {
        actor.instance.byName.get(bone)?.getWorldPosition(_v);
        stage.fx.scrape(_v, _dir, scraping);
      }
    }
  });
  tl.at(still, () => {
    stage.fx.grindStop();
    if (!handOff) stage.fx.settle(b, design.heft * 0.6);
  });
  tl.at(end, () => {
    actor.root.position.copy(b);
    actor.root.rotation.set(0, yawEnd, 0);
    if (handOff) actor.planter.release();
    else actor.rest();
  });
  return end;
}

export interface TurnOptions {
  /** Rise out of the frozen pose while turning: a statue about to fight, or to be fought. */
  rise?: boolean;
  /** Radians per second for a statue that turns on its feet (default: a brisk turn). */
  rate?: number;
}

/** How long `planTurn` takes, so a planner can allow for it before laying it down. */
export function turnDuration(actor: Actor, delta: number, options: TurnOptions = {}): number {
  const design = actor.design;
  const size = Math.abs(delta);
  const rising = options.rise && actor.upright !== actor.frozen ? (design.rise ?? 0) + 0.1 : 0;
  if (size < 0.03) return rising;
  if (design.slide) return pivotDuration(design.slide, delta) + 0.06;
  if (design.glide?.turns) return glideTimes(design.glide, 0, delta, true).end;
  return Math.max(0.18 + size / (options.rate ?? TURN_RATE) + 0.3, rising);
}

/**
 * Turn on the spot from one heading to another, in the manner of the statue's kind: a walker
 * holds its pose and the foot planter turns the swivel into a shuffle of steps; a slider
 * grinds round on planted feet; a statue that turns in the air lifts a little and comes round.
 * With `rise`, a statue whose frozen pose is not upright stands up as it turns (and does so
 * even if there is no turn to make). Returns the time it is done.
 */
export function planTurn(tl: Timeline, stage: Stage, actor: Actor, at: THREE.Vector3, t0: number, fromYaw: number, toYaw: number, options: TurnOptions = {}): number {
  const design = actor.design;
  const delta = angleDelta(fromYaw, toYaw);
  const total = turnDuration(actor, delta, options);
  if (total <= 0) return t0;
  const turns = Math.abs(delta) >= 0.03;
  if (turns && design.slide) return planSlide(tl, stage, actor, at, at, t0, { startYaw: fromYaw, finalYaw: toYaw, handOff: true });
  if (turns && design.glide?.turns) return planGlide(tl, stage, actor, at, at, t0, { startYaw: fromYaw, finalYaw: toYaw, hop: true });

  const position = at.clone();
  const turn = turns ? 0.18 + Math.abs(delta) / (options.rate ?? TURN_RATE) : 0;
  const rise = options.rise && actor.upright !== actor.frozen ? design.rise ?? 0 : 0;
  const end = t0 + total;
  const layers = baseLayers(actor);
  tl.at(t0, () => {
    actor.planter.release();
    actor.planter.enabled = true;
  });
  tl.span(t0, end - t0, (local, dt) => {
    actor.root.position.copy(position);
    actor.root.rotation.set(0, fromYaw + (turns ? delta * ease.inOutCubic(clamp01(local / turn)) : 0), 0);
    setBase(layers, 1, rise > 0 ? ease.inOutCubic(clamp01(local / rise)) : 0);
    actor.animate(layers, dt, local >= turn);
  });
  return end;
}

/** Plan how one piece crosses the board in the manner of its kind. */
export function planTravel(tl: Timeline, stage: Stage, actor: Actor, from: THREE.Vector3, to: THREE.Vector3, t0: number, options: WalkOptions = {}): number {
  switch (actor.design.mover) {
    case 'leap':
      return planLeap(tl, stage, actor, from, to, t0, options);
    case 'glide':
      return planGlide(tl, stage, actor, from, to, t0, options);
    case 'slide':
      return planSlide(tl, stage, actor, from, to, t0, options);
    default:
      return planWalk(tl, stage, actor, from, to, t0, options);
  }
}

/**
 * How a statue takes the square it has just cleared, from where it struck: a slider is
 * dragged onto it, a statue that floats onto squares lifts over the rubble, and the rest go
 * on foot (they are already standing, so they do not rise again first).
 */
export function planStepOn(tl: Timeline, stage: Stage, actor: Actor, from: THREE.Vector3, to: THREE.Vector3, t0: number, fromYaw: number, toYaw: number): number {
  const design = actor.design;
  if (design.slide) return planSlide(tl, stage, actor, from, to, t0, { startYaw: fromYaw, finalYaw: toYaw });
  if (design.glide?.floatsOn) return planGlide(tl, stage, actor, from, to, t0, { startYaw: fromYaw, finalYaw: toYaw, hop: true });
  return planWalk(tl, stage, actor, from, to, t0, { startYaw: fromYaw, finalYaw: toYaw, risen: true });
}

/** The whole of a move that does not involve a fight: travel, castling, promotion. */
export function planQuietMove(stage: Stage, event: MoveEvent): Timeline {
  const { cast } = stage;
  const tl = new Timeline();
  const mover = cast.at(event.from);
  if (!mover) throw new Error(`no statue on ${event.from}`);
  const from = squareCentre(event.from);
  const to = squareCentre(event.to);

  tl.at(0, () => mover.wake(1.3, 4.5));
  const t0 = 0.16;
  let end: number;

  if (event.castle) {
    const rook = cast.at(event.castle.rookFrom);
    if (!rook) throw new Error(`no rook on ${event.castle.rookFrom}`);
    // The two pass each other: the king swings towards the middle of the board, the rook
    // behind him along the back edge.
    const forward = mover.side === 'w' ? -1 : 1;
    const kingEnd = planWalk(tl, stage, mover, from, to, t0, { bulge: new THREE.Vector3(0, 0, forward * SQUARE * 0.44) });
    tl.at(0.1, () => rook.wake(1.1, 3.5));
    const rookEnd = planTravel(tl, stage, rook, squareCentre(event.castle.rookFrom), squareCentre(event.castle.rookTo), t0 + 0.12, {
      bulge: new THREE.Vector3(0, 0, -forward * SQUARE * 0.4),
    });
    tl.at(rookEnd, () => {
      cast.relocate(rook, event.castle!.rookTo);
      rook.wake(0, 0);
    });
    end = Math.max(kingEnd, rookEnd);
  } else {
    end = planTravel(tl, stage, mover, from, to, t0);
  }

  tl.at(end, () => {
    cast.relocate(mover, event.to);
    mover.wake(0, 0);
  });
  if (event.promotion) end = planPromotion(tl, stage, mover, event.promotion as PieceType, event.to, end + 0.1);
  tl.extend(end + 0.12);
  return tl;
}
