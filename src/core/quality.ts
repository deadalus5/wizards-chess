// How much picture a phone or tablet draws. A ladder of levels from the full look down to the
// lightest; a few timings taken behind the loading screen choose the highest one the device can
// hold at an even pace, and a governor steps down later if frames keep arriving late (a phone
// that has grown hot). The desktop uses none of this.
//
// Pure: the timing itself, and applying a level, are in calibrate.ts and mobile.ts.

export type AoMode = 'Medium' | 'Performance' | 'off';

export interface Level {
  /** Megapixels rendered (the screen shows them scaled to fit). */
  pixels: number;
  /** The board's mirror image of what stands on it: a second drawing of the whole scene. */
  mirror: boolean;
  ao: AoMode;
  /** Depth of field in the cinematic shots. */
  dof: boolean;
  /** Frames a second aimed for: 60, or an even 30. Never a mixture. */
  fps: 60 | 30;
}

/**
 * Megapixels at each rung. Every render target is sized from this, at about 100 bytes a
 * pixel, so the top rung is also a memory budget.
 */
const PIXELS: Record<'phone' | 'tablet', [number, number, number, number]> = {
  phone: [1.5, 1.2, 0.95, 0.7],
  tablet: [2.2, 1.7, 1.3, 0.9],
};

/**
 * The levels, best first. At 60 the mirror goes first (it costs a third of the frame and shows
 * least from the player's seat), then pixels, then the quality of the ambient occlusion; then
 * the same again at an even 30, where the picture can be fuller.
 */
export function ladder(kind: 'phone' | 'tablet'): Level[] {
  const [a, b, c, d] = PIXELS[kind];
  return [
    { pixels: a, mirror: true, ao: 'Medium', dof: true, fps: 60 },
    { pixels: a, mirror: false, ao: 'Medium', dof: true, fps: 60 },
    { pixels: b, mirror: false, ao: 'Medium', dof: true, fps: 60 },
    { pixels: c, mirror: false, ao: 'Performance', dof: true, fps: 60 },
    { pixels: a, mirror: false, ao: 'Medium', dof: true, fps: 30 },
    { pixels: b, mirror: false, ao: 'Performance', dof: true, fps: 30 },
    { pixels: c, mirror: false, ao: 'Performance', dof: true, fps: 30 },
    { pixels: d, mirror: false, ao: 'off', dof: false, fps: 30 },
  ];
}

/** The pixel ratio that renders `megapixels` on a screen of this CSS size: never more than the device has. */
export function pixelRatioFor(megapixels: number, cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  return Math.max(0.75, Math.min(devicePixelRatio, Math.sqrt((megapixels * 1e6) / Math.max(1, cssWidth * cssHeight))));
}

/**
 * Milliseconds to draw the heaviest ordinary frame (a cinematic shot: depth of field and
 * particles on), measured four ways. From these the cost of any level is worked out, rather
 * than resizing every buffer to try each one.
 */
export interface Timings {
  /** The two sizes timed, in megapixels. */
  low: number;
  high: number;
  /** Everything on, at each size. */
  fullLow: number;
  fullHigh: number;
  /** At the low size: without the mirror, and without the mirror or the ambient occlusion. */
  noMirrorLow: number;
  bareLow: number;
}

/** Share of the ambient occlusion's cost that its 'Performance' mode saves (half the samples). */
const AO_PERFORMANCE_SAVING = 0.45;

/** What a frame at this level should cost, in milliseconds. */
export function predict(t: Timings, level: Pick<Level, 'pixels' | 'mirror' | 'ao'>): number {
  // A frame costs a fixed amount (the statues' vertices, drawn in every scene pass) plus an
  // amount per pixel (shading and the post-processing chain).
  const perMegapixel = Math.max(0, (t.fullHigh - t.fullLow) / Math.max(1e-6, t.high - t.low));
  const fixed = Math.max(0, t.fullLow - perMegapixel * t.low);
  let ms = fixed + perMegapixel * level.pixels;
  // The mirror's cost is taken as it was measured at the low size: it grows a little with
  // size, so this errs towards the lighter level.
  if (!level.mirror) ms -= Math.max(0, t.fullLow - t.noMirrorLow);
  const ao = Math.max(0, t.noMirrorLow - t.bareLow) * (level.pixels / t.low);
  if (level.ao === 'Performance') ms -= ao * AO_PERFORMANCE_SAVING;
  else if (level.ao === 'off') ms -= ao;
  return Math.max(0, ms);
}

/**
 * Time a measured frame may take at each pace. Short of the whole interval (16.7 and 33.3 ms):
 * the measurement is of drawing alone, flat out, and a real frame also runs the game and
 * shares the device.
 */
export const BUDGET_MS: Record<60 | 30, number> = { 60: 12.5, 30: 26 };

/** Index of the best level the timings say the device can hold; the last one if none fits. */
export function chooseLevel(levels: readonly Level[], t: Timings): number {
  for (let i = 0; i < levels.length; i++) if (predict(t, levels[i]) <= BUDGET_MS[levels[i].fps]) return i;
  return levels.length - 1;
}

/** Levels to give up when the last visit ended with the page being killed while on screen. */
export const AFTER_A_DEATH = 2;

export interface GovernorOptions {
  /** Frames in motion judged together. */
  window: number;
  /** Share of them late that makes a window a bad one. */
  share: number;
  /** Bad windows in a row before the device is called struggling. */
  strikes: number;
  /** Frames left uncounted after a step (buffers are rebuilt, the picture settles). */
  rest: number;
}

/**
 * Watches frames while the game is in motion and says when they have been late for long
 * enough that the picture should be made lighter. It only ever asks for less: headroom cannot
 * be seen from frame times, which stop at the display's rate.
 */
export class Governor {
  private frames = 0;
  private late = 0;
  private bad = 0;
  private resting = 0;
  private readonly o: GovernorOptions;

  constructor(options: Partial<GovernorOptions> = {}) {
    this.o = { window: 180, share: 0.15, strikes: 2, rest: 300, ...options };
  }

  /** One frame drawn while something was moving. `late` is 1 if it missed its refresh, -1 if it came early, else 0. */
  frame(late: number): void {
    if (this.resting > 0) {
      this.resting--;
      return;
    }
    this.frames++;
    this.late += late;
    if (this.frames < this.o.window) return;
    this.bad = this.late > this.frames * this.o.share ? this.bad + 1 : 0;
    this.frames = 0;
    this.late = 0;
  }

  get struggling(): boolean {
    return this.bad >= this.o.strikes;
  }

  /**
   * A step was taken, or looked into and declined: count afresh once things have settled
   * (after `rest` frames in motion; longer when the lateness turned out not to be the picture's
   * doing, so that it is not looked into again and again).
   */
  settle(rest = this.o.rest): void {
    this.frames = 0;
    this.late = 0;
    this.bad = 0;
    this.resting = rest;
  }
}

/**
 * Whether a frame came late for the pace being aimed at: it took well over its interval to
 * arrive. Judged against the pace wanted, not against the display's measured rate: a device
 * that takes two refreshes over every frame looks, to the frame loop, exactly like a display
 * running at half speed, and is paced evenly as one; only here does it show as falling short.
 */
export function cameLate(intervalMs: number, fps: number): boolean {
  return intervalMs > (1000 / fps) * 1.4;
}
