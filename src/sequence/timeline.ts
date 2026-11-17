/**
 * A planned sequence: spans that drive state as a function of time, and one-shot events.
 *
 * Everything a move does is laid out on a timeline before it starts, so durations are known
 * up front (the camera can anticipate a hit) and playback is deterministic at any time scale.
 * Events fire when time crosses them, never on equality, so no frame rate can skip one.
 */
export type SpanFn = (local: number, dt: number) => void;

interface Span {
  start: number;
  end: number;
  fn: SpanFn;
  ended: boolean;
}

interface Cue {
  time: number;
  fn: () => void;
  fired: boolean;
  order: number;
}

export class Timeline {
  duration = 0;
  time = 0;
  private readonly spans: Span[] = [];
  private readonly cues: Cue[] = [];
  private readonly cleanups: Array<() => void> = [];
  private sorted = false;

  /**
   * Call `fn(local, dt)` every frame from `start` for `duration` seconds, with `local` the
   * time since `start`. It is always called one final time with `local === duration`, so the
   * end state is applied exactly even on a long frame.
   */
  span(start: number, duration: number, fn: SpanFn): this {
    this.spans.push({ start, end: start + duration, fn, ended: false });
    this.duration = Math.max(this.duration, start + duration);
    return this;
  }

  /** Fire `fn` once when playback reaches `time`. */
  at(time: number, fn: () => void): this {
    this.cues.push({ time, fn, fired: false, order: this.cues.length });
    this.duration = Math.max(this.duration, time);
    this.sorted = false;
    return this;
  }

  /**
   * Register something to undo if the sequence is abandoned part-way (a new game started
   * while it plays): anything that leaves a statue in a state the board reset would not fix.
   */
  onAbort(fn: () => void): this {
    this.cleanups.push(fn);
    return this;
  }

  /** Abandon the sequence. Does nothing if it already ran to the end. */
  abort(): void {
    if (this.finished) return;
    for (const fn of this.cleanups) fn();
    this.cleanups.length = 0;
  }

  /** Make the timeline last at least until `time`. */
  extend(time: number): this {
    this.duration = Math.max(this.duration, time);
    return this;
  }

  get finished(): boolean {
    return this.time >= this.duration;
  }

  /** Advance by `dt` seconds. Returns true once the end has been reached. */
  update(dt: number): boolean {
    if (!this.sorted) {
      this.cues.sort((a, b) => a.time - b.time || a.order - b.order);
      this.sorted = true;
    }
    this.time = Math.min(this.time + dt, this.duration);
    const t = this.time;
    for (const s of this.spans) {
      if (s.ended || t < s.start) continue;
      if (t >= s.end) {
        s.fn(s.end - s.start, dt);
        s.ended = true;
      } else {
        s.fn(t - s.start, dt);
      }
    }
    for (const c of this.cues) {
      if (c.fired) continue;
      if (c.time > t) break;
      c.fired = true;
      c.fn();
    }
    return this.finished;
  }
}
