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
import type { BodyKind } from '../pieces/statueKit';
import { planPromotion } from './special';
import { Timeline } from './timeline';

/** What the choreography can reach. */
export interface Stage {
  cast: Cast;
  fx: Effects;
  shatter: ShatterSystem;
  cinema: Cinema;
  gait(kind: BodyKind, clip: string): Gait;
  /** Begin the beat of hit-stop and slow motion that marks a killing blow. */
  slowMotion(): void;
  /** Where the player's own camera is (whatever shot is on screen). */
  viewerPosition(): THREE.Vector3;
}

/** Radians per second for turning on the spot. */
export const TURN_RATE = 5.2;
const _v = new THREE.Vector3();

/** Distance along a trapezoidal speed profile: ramp up over `ramp` seconds, cruise, ramp down. */
class SpeedProfile {
  readonly duration: number;
  private readonly cruise: number;
  private readonly peak: number;

  constructor(
    readonly distance: number,
    speed: number,
    private readonly ramp: number,
  ) {
    const rampDistance = speed * ramp; // both ramps together
    if (rampDistance >= distance) {
      // Too short to reach full speed: a triangle.
      this.peak = Math.sqrt((distance * speed) / ramp);
      this.ramp = this.peak / (speed / ramp);
      this.cruise = 0;
    } else {
      this.peak = speed;
      this.cruise = (distance - rampDistance) / speed;
    }
    this.duration = this.ramp * 2 + this.cruise;
  }

  /** Distance travelled after `t` seconds. */
  at(t: number): number {
    const { ramp, cruise, peak } = this;
    if (t <= 0) return 0;
    if (t >= this.duration) return this.distance;
    if (t < ramp) return (0.5 * peak * t * t) / ramp;
    if (t < ramp + cruise) return 0.5 * peak * ramp + peak * (t - ramp);
    const r = this.duration - t;
    return this.distance - (0.5 * peak * r * r) / ramp;
  }

  /** Speed as a fraction of the peak, for blending the gait in and out. */
  fraction(t: number): number {
    const { ramp, cruise } = this;
    if (t <= 0 || t >= this.duration) return 0;
    if (t < ramp) return t / ramp;
    if (t < ramp + cruise) return 1;
    return (this.duration - t) / ramp;
  }
}

function restLayers(stage: Stage, actor: Actor): { clip: PoseLayer['clip']; time: number } {
  return { clip: stage.cast.clip(actor.body, actor.design.rest.clip), time: actor.design.rest.time };
}

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
}

/**
 * Walk or run from `from` to `to`. The statue turns towards its path as it sets off and back
 * to its final heading as it arrives; only for large turns does it pivot before moving. The
 * gait's phase is driven by distance covered, so the planted foot stays where it was put.
 * Returns the time at which the statue has arrived and settled.
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
  const startTravel = t0 + (Math.abs(turnIn) > 0.9 ? tIn * 0.6 : 0);
  const arrive = startTravel + profile.duration;
  const startOut = arrive - Math.min(tOut * 0.45, profile.duration * 0.35);
  const still = Math.max(arrive, startOut + tOut);
  // Time for the feet to step into the frozen stance.
  const end = still + (options.handOff ? 0.06 : 0.42);

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

  const rest = restLayers(stage, actor);
  const layers: PoseLayer[] = [
    { clip: rest.clip, time: rest.time, weight: 1, mask: actor.lowerMask },
    { clip: rest.clip, time: rest.time, weight: 1, mask: actor.upperMask },
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
    if (tIn > 0) yaw += turnIn * ease.inOutCubic(clamp01((t - t0) / tIn));
    else yaw += turnIn;
    if (tOut > 0) yaw += turnOut * ease.inOutCubic(clamp01((t - startOut) / tOut));
    else if (t >= arrive) yaw += turnOut;
    actor.root.rotation.y = yaw;

    const w = weightAt(tt);
    const phase = phaseAt(tt);
    const clipTime = (phase - Math.floor(phase)) * gait.clip.duration;
    layers[0].weight = 1 - w;
    layers[1].weight = 1 - design.carry * w;
    layers[2].weight = w;
    layers[2].time = clipTime;
    layers[3].weight = design.carry * w;
    layers[3].time = clipTime;
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

  const crouch = 0.3;
  const flight = 0.62 + 0.08 * distance;
  const recover = 0.62;
  const apex = (1.0 + 0.2 * distance) * design.scale;
  const launch = t0 + crouch;
  const touchdown = launch + flight;
  const end = touchdown + recover;

  const rest = restLayers(stage, actor);
  const start = stage.cast.clip(actor.body, LEAP.start);
  const air = stage.cast.clip(actor.body, LEAP.air);
  const land = stage.cast.clip(actor.body, LEAP.land);
  const LAND_CONTACT = 0.17; // seconds into the landing clip at which the feet meet the ground
  const layers: PoseLayer[] = [
    { clip: rest.clip, time: rest.time, weight: 1 },
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

/**
 * A bishop's move: it does not walk. It rises a hand's breadth off the board, drifts along
 * the diagonal without turning, leaning into the motion, and settles.
 */
export function planGlide(tl: Timeline, stage: Stage, actor: Actor, from: THREE.Vector3, to: THREE.Vector3, t0: number): number {
  const design = actor.design;
  const a = from.clone();
  const b = to.clone();
  const distance = a.distanceTo(b);
  const yaw = actor.root.rotation.y;
  const rise = 0.36;
  const travel = 0.55 + distance / 4.8;
  const settle = 0.4;
  const hover = 0.3 * design.scale;
  const startTravel = t0 + rise * 0.6;
  const arrive = startTravel + travel;
  const end = arrive + settle;

  // Lean in the statue's own frame so it tips towards where it is going.
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const localX = (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / len;
  const localZ = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / len;

  const rest = restLayers(stage, actor);
  const float = stage.cast.clip(actor.body, GLIDE);
  const layers: PoseLayer[] = [
    { clip: rest.clip, time: rest.time, weight: 1 },
    { clip: float, time: 0, weight: 0 },
  ];

  tl.span(t0, end - t0, (local) => {
    const t = t0 + local;
    const u = ease.inOutCubic(clamp01((t - startTravel) / travel));
    const lift = ease.outCubic(clamp01((t - t0) / rise)) * (1 - ease.inOutCubic(clamp01((t - arrive) / settle)));
    actor.root.position.lerpVectors(a, b, u);
    actor.root.position.y = hover * lift + Math.sin(t * 2.6) * 0.018 * lift;
    // Speed of the eased glide, 0..1, for the lean.
    const k = clamp01((t - startTravel) / travel);
    const speed = Math.sin(Math.PI * k);
    actor.root.rotation.set(0.11 * speed * localZ, yaw, -0.11 * speed * localX, 'YXZ');
    layers[0].weight = 1 - lift;
    layers[1].weight = lift;
    layers[1].time = t - t0;
    actor.animate(layers);
  });

  tl.at(arrive + settle * 0.75, () => stage.fx.landing(b, design.heft * 0.3));
  tl.at(end, () => {
    actor.root.position.copy(b);
    actor.root.rotation.set(0, yaw, 0);
    actor.rest();
  });
  return end;
}

/**
 * Turn on the spot from one heading to another. The pose is held and the foot planter turns
 * the swivel into a shuffle of steps. Returns the time the turn (and the last step) is done.
 */
export function planTurn(tl: Timeline, stage: Stage, actor: Actor, at: THREE.Vector3, t0: number, fromYaw: number, toYaw: number): number {
  const delta = angleDelta(fromYaw, toYaw);
  if (Math.abs(delta) < 0.03) return t0;
  const position = at.clone();
  const turn = 0.18 + Math.abs(delta) / TURN_RATE;
  const end = t0 + turn + 0.3;
  const rest = restLayers(stage, actor);
  const layers: PoseLayer[] = [{ clip: rest.clip, time: rest.time, weight: 1 }];
  tl.at(t0, () => {
    actor.planter.enabled = true;
  });
  tl.span(t0, end - t0, (local, dt) => {
    actor.root.position.copy(position);
    actor.root.rotation.set(0, fromYaw + delta * ease.inOutCubic(clamp01(local / turn)), 0);
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
      return planGlide(tl, stage, actor, from, to, t0);
    default:
      return planWalk(tl, stage, actor, from, to, t0, options);
  }
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
    const rookEnd = planWalk(tl, stage, rook, squareCentre(event.castle.rookFrom), squareCentre(event.castle.rookTo), t0 + 0.12, {
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
