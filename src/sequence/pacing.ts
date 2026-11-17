/**
 * How fast things go: the speed of a statue crossing the board, and the playback rate of an
 * attack clip around its blow. Pure arithmetic, planned up front like everything on a timeline.
 */

/**
 * Distance along a speed profile: ramp up over `ramp` seconds, cruise, ramp down. With `soft`
 * the ramps themselves ease in and out, so there is no jolt as the statue sets off or stops;
 * the distance covered and the duration are the same either way.
 */
export class SpeedProfile {
  readonly duration: number;
  private readonly cruise: number;
  private readonly peak: number;
  private readonly ramp: number;

  constructor(
    readonly distance: number,
    speed: number,
    ramp: number,
    private readonly soft = false,
  ) {
    const rampDistance = speed * ramp; // both ramps together
    if (rampDistance >= distance) {
      // Too short to reach full speed: a triangle.
      this.peak = Math.sqrt((distance * speed) / ramp);
      this.ramp = this.peak / (speed / ramp);
      this.cruise = 0;
    } else {
      this.peak = speed;
      this.ramp = ramp;
      this.cruise = (distance - rampDistance) / speed;
    }
    this.duration = this.ramp * 2 + this.cruise;
  }

  /** Distance covered `t` seconds into a ramp. */
  private ramped(t: number): number {
    const { ramp, peak } = this;
    if (!this.soft) return (0.5 * peak * t * t) / ramp;
    const u = t / ramp;
    return peak * ramp * u * u * u * (1 - 0.5 * u);
  }

  /** Distance travelled after `t` seconds. */
  at(t: number): number {
    const { ramp, cruise, peak } = this;
    if (t <= 0) return 0;
    if (t >= this.duration) return this.distance;
    if (t < ramp) return this.ramped(t);
    if (t < ramp + cruise) return 0.5 * peak * ramp + peak * (t - ramp);
    return this.distance - this.ramped(this.duration - t);
  }

  /** Speed as a fraction of the peak, for blending a gait or a lean in and out. */
  fraction(t: number): number {
    const { ramp, cruise } = this;
    if (t <= 0 || t >= this.duration) return 0;
    const u = t < ramp ? t / ramp : t < ramp + cruise ? 1 : (this.duration - t) / ramp;
    return this.soft ? u * u * (3 - 2 * u) : u;
  }
}

/**
 * The pacing of a blow. A clip slowed evenly makes the blow itself float; a blow reads as heavy
 * when the wind-up takes its time, hangs for a beat at the top, and then the weapon comes
 * through at close to its own speed.
 */
export interface Tempo {
  /** Playback rate up to the top of the wind-up. */
  windup: number;
  /** Seconds held at the top (the clip creeps rather than freezing). */
  hold: number;
  /** Rate from there through the blow. */
  swing: number;
  /** Rate once the blow has landed. */
  follow: number;
}

/** Rate at which the clip creeps during the held beat. */
const CREEP = 0.07;
/** Half the time over which one rate gives way to the next, seconds. */
const BLEND = 0.05;
/** Clip seconds past the blow before the follow-through rate takes over, so contact is at full speed. */
const THROUGH = 0.06;

/**
 * Timeline time against clip time for one attack: a table built once, with the rate changing
 * smoothly between its four phases so the motion never jerks. Monotonic, so every clip time
 * has exactly one moment on the timeline.
 */
export class TimeWarp {
  static readonly STEP = 1 / 240;
  /** Timeline seconds needed to reach the end of the clip range. */
  readonly duration: number;
  private readonly table: Float32Array;

  /**
   * @param apex clip time of the top of the wind-up
   * @param hit clip time of the blow
   * @param end clip time at which playback stops
   */
  constructor(apex: number, hit: number, end: number, tempo: Tempo) {
    const top = Math.min(Math.max(apex, 0), hit);
    const crept = Math.min(CREEP * tempo.hold, Math.max(0, hit - top));
    // Where each phase ends, in timeline seconds.
    const t1 = top / tempo.windup;
    const t2 = t1 + (crept > 0 ? tempo.hold : 0);
    const t3 = t2 + Math.max(0, hit + THROUGH - top - crept) / tempo.swing;
    const held = crept > 0 ? crept / tempo.hold : tempo.swing;
    /** Clip seconds played by timeline time `x`, before smoothing. */
    const played = (x: number): number => {
      if (x <= 0) return x * tempo.windup;
      let c = Math.min(x, t1) * tempo.windup;
      if (x > t1) c += (Math.min(x, t2) - t1) * held;
      if (x > t2) c += (Math.min(x, t3) - t2) * tempo.swing;
      if (x > t3) c += (x - t3) * tempo.follow;
      return c;
    };
    const step = TimeWarp.STEP;
    const values: number[] = [0];
    let clip = 0;
    for (let i = 0; clip < end && i < 240 * 30; i++) {
      // The rate at the middle of this step, averaged over the blend window.
      const x = (i + 0.5) * step;
      clip += ((played(x + BLEND) - played(x - BLEND)) / (2 * BLEND)) * step;
      values.push(clip);
    }
    this.table = Float32Array.from(values);
    this.duration = this.when(end);
  }

  /** Clip time `seconds` into the attack. */
  at(seconds: number): number {
    const t = this.table;
    const f = Math.min(Math.max(seconds / TimeWarp.STEP, 0), t.length - 1);
    const i = Math.min(Math.floor(f), t.length - 2);
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  }

  /** Seconds into the attack at which the clip reaches `clip`. */
  when(clip: number): number {
    const t = this.table;
    if (clip <= 0) return 0;
    if (clip >= t[t.length - 1]) return (t.length - 1) * TimeWarp.STEP;
    let lo = 0;
    let hi = t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= clip) lo = mid;
      else hi = mid;
    }
    const span = t[hi] - t[lo];
    return (lo + (span > 0 ? (clip - t[lo]) / span : 0)) * TimeWarp.STEP;
  }
}
