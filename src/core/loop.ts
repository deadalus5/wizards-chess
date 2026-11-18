/**
 * requestAnimationFrame loop with explicit frame pacing.
 *
 * Two things make motion look uneven even when every frame is on time, and this loop deals
 * with both:
 *
 * - On a 120 Hz display a scene that costs between 8.3 and 16.7 ms alternates between one and
 *   two refresh intervals per frame, which reads as judder. The loop renders on every
 *   callback or on every second one, never a mixture. With `auto` on it uses the display's
 *   full rate when that is 100 Hz or more, and drops to an even 60 for the rest of the
 *   session if the machine cannot keep that up: steady and slower beats fast and uneven.
 *
 * - The browser's callback timestamps jitter by several milliseconds even while frames are
 *   being shown at perfectly regular intervals. Stepping the game by the measured time would
 *   copy that jitter into every movement. So the game is stepped by whole refresh intervals.
 *   A single missed frame is simply forgiven (the picture holds for one refresh and carries
 *   on from where it was, which is less visible than a jump); only when real time has run
 *   more than a frame and a half ahead, as it does when the machine is struggling, does a
 *   step grow longer to catch up.
 */
export type FrameFn = (dt: number, nowSeconds: number) => void;

export class FrameLoop {
  /** Frames per second to render at. */
  targetFps = 60;
  /** Choose between the display's full rate and 60 automatically. */
  auto = true;
  /**
   * Phones and tablets: never draw more frames a second than this (60, or an even 30), whatever
   * the display runs at. It replaces `targetFps` and `auto`, and may be changed at any time (the
   * game idles at 30) without the change being taken for a missed frame. Null, as on the
   * desktop, leaves the loop exactly as it was.
   */
  cap: number | null = null;
  /** Median interval between rAF callbacks, in milliseconds. */
  displayInterval = 1000 / 60;
  /**
   * Refreshes missed since start: callbacks that arrived a whole interval late, less those
   * that then arrived early (a late timestamp followed by an early one is jitter, not a miss).
   */
  missed = 0;

  private handle = 0;
  private lastRender = -1;
  private lastCallback = -1;
  private readonly intervals: number[] = [];
  private running = false;
  private callbacks = 0;
  /** How far real time has run ahead of the time the game has been stepped by, in ms. */
  private debt = 0;
  /** Set once the full rate has proved too much; the loop then stays at 60. */
  private gaveUpFullRate = false;
  private windowFrames = 0;
  private windowMissed = 0;
  /** How many callbacks went to a frame last time (only followed under `cap`). */
  private lastEvery = 0;

  constructor(private readonly fn: FrameFn) {}

  get displayHz(): number {
    return 1000 / this.displayInterval;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastRender = -1;
    this.lastCallback = -1;
    this.debt = 0;
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    if (this.lastCallback >= 0) {
      const interval = now - this.lastCallback;
      if (interval > 1 && interval < 100) {
        this.intervals.push(interval);
        if (this.intervals.length > 31) this.intervals.shift();
        const sorted = [...this.intervals].sort((a, b) => a - b);
        this.displayInterval = sorted[sorted.length >> 1];
        if (this.auto && this.intervals.length >= 20) {
          const hz = 1000 / this.displayInterval;
          this.targetFps = hz >= 100 && !this.gaveUpFullRate ? Math.round(hz) : 60;
        }
      }
    }
    this.lastCallback = now;

    // Render on every callback, or on every n-th when the display is faster than the target.
    // (Under a cap: the fewest callbacks to a frame that keeps within it. Rounding up, less a
    // little, so that a 90 Hz display sits steadily at every second callback: rounding to the
    // nearest lands exactly between one and two there and flips with the jitter.)
    const every = this.cap === null ? Math.max(1, Math.round(1000 / this.targetFps / this.displayInterval)) : Math.max(1, Math.ceil(1000 / this.cap / this.displayInterval - 0.3));
    if (++this.callbacks % every !== 0) return;
    if (this.lastRender < 0) {
      this.lastRender = now;
      this.lastEvery = every;
      return;
    }
    const elapsed = now - this.lastRender;
    this.lastRender = now;

    const unit = this.displayInterval * every;
    let step = unit;
    if (this.cap !== null && every !== this.lastEvery) {
      // The pace has just been changed: this frame's interval belongs to neither pace, so it
      // is neither late nor early, and nothing is owed.
      this.lastEvery = every;
      this.debt = 0;
      this.fn(Math.min(Math.max(elapsed, this.displayInterval), unit, 100) / 1000, now / 1000);
      return;
    }
    if (elapsed > 250) {
      // Back from a hidden tab or a breakpoint: carry on from here rather than catching up.
      this.debt = 0;
    } else {
      // The debt leaks away over a few seconds, so an odd missed frame is forgiven and a
      // refresh rate that is not exactly the estimate never adds up to anything.
      this.debt = this.debt * 0.995 + (elapsed - unit);
      while (this.debt > unit * 1.5) {
        step += unit;
        this.debt -= unit;
      }
      if (this.debt < -unit * 1.5) this.debt = 0;
    }
    // Symmetric about one interval, so a late callback and the early one after it cancel.
    const late = elapsed > unit * 1.5 ? 1 : elapsed < unit * 0.5 ? -1 : 0;
    this.missed += late;

    // Watch the full rate: if more than one frame in eight is missed over a few seconds,
    // this machine cannot hold it.
    if (this.auto && this.targetFps > 60) {
      this.windowFrames++;
      this.windowMissed += late;
      if (this.windowFrames >= 360) {
        if (this.windowMissed > this.windowFrames / 8) {
          this.gaveUpFullRate = true;
          this.targetFps = 60;
        }
        this.windowFrames = this.windowMissed = 0;
      }
    }

    this.fn(Math.min(step, 100) / 1000, now / 1000);
  };
}
