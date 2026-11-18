import type { MoveEvent } from '../chess/game';
import { smoothstep } from '../core/math';
import type { Presenter } from '../game/controller';
import { planCapture } from './capture';
import { planQuietMove, type Stage } from './moves';
import { planCheckmate } from './special';
import type { Timeline } from './timeline';

/** What the director needs: the stage minus the hooks it provides itself. */
export type StageDeps = Omit<Stage, 'slowMotion'>;

// The beat at a killing blow, in real seconds: the picture all but freezes on the frame the
// weapon lands, then the break plays out slowed down (long enough to watch the statue come
// apart and its pieces fly), then time eases back to normal.
interface Beat {
  stop: number;
  hold: number;
  ease: number;
  /** Time scale while slowed (1 = real time). */
  scale: number;
}
const BLOW: Beat = { stop: 0.08, hold: 0.75, ease: 0.6, scale: 0.25 };
/** A longer, slower beat for a death that is meant to be dwelt on. */
const GRAND: Beat = { stop: 0.1, hold: 1.0, ease: 0.8, scale: 0.21 };
const HIT_STOP_SCALE = 0.02;

/**
 * Plays each move out on the board. A move is planned as a timeline, then advanced every
 * frame on game time, which can run slower (impact slow motion) or faster (skipping).
 */
export class Director implements Presenter {
  /** Slow-motion factor set by the choreography (1 = real time). */
  timeScale = 1;
  /** Playback speed chosen by the player; holding Space fast-forwards. */
  speed = 1;
  /** Speed every move starts at (raised by tests to run whole games quickly). */
  baseSpeed = 1;
  /** Set false to play killing blows at full speed. */
  slowMotionEnabled = true;
  readonly stage: Stage;
  private timeline: Timeline | null = null;
  private finish: (() => void) | null = null;
  private fail: ((err: unknown) => void) | null = null;
  /** Real seconds since the killing blow, or -1 when time is running normally. */
  private beat = -1;
  private pace: Beat = BLOW;

  constructor(deps: StageDeps) {
    this.stage = { ...deps, slowMotion: (grand) => this.slowMotion(grand) };
    addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.timeline) {
        e.preventDefault();
        this.hurry();
      }
    });
  }

  /** Play the rest of the move in flight quickly (the Space key; the HURRY button on a touch screen). */
  hurry(): void {
    if (this.timeline) this.speed = Math.max(6, this.baseSpeed);
  }

  get playing(): boolean {
    return this.timeline !== null;
  }

  /** Seconds of the move in flight still to play (0 when idle). */
  get remaining(): number {
    return this.timeline ? Math.max(0, this.timeline.duration - this.timeline.time) : 0;
  }

  /** Whether the move in flight is being hurried along. */
  get hurried(): boolean {
    return this.timeline !== null && this.speed > Math.max(1.01, this.baseSpeed);
  }

  /** Seconds into the move being played (0 when idle). */
  get time(): number {
    return this.timeline?.time ?? 0;
  }

  /**
   * Stop whatever is playing and clear debris and effects left over from earlier moves. The
   * board is about to be rebuilt (new game, undo), so a move still in flight is abandoned.
   */
  reset(): void {
    const done = this.end();
    this.stage.shatter.reset();
    this.stage.fx.clear();
    this.beat = -1;
    this.timeScale = 1;
    done?.();
  }

  private slowMotion(grand = false): void {
    // Not while the player is skipping ahead.
    if (!this.slowMotionEnabled || this.speed > 1.01) return;
    this.pace = grand ? GRAND : BLOW;
    this.beat = 0;
  }

  /** Named moments of the move being played, in seconds on its timeline (for measuring and for stills). */
  get marks(): Readonly<Record<string, number>> {
    return this.timeline?.marks ?? {};
  }

  present(event: MoveEvent): Promise<void> {
    const tl = event.captured && event.capturedSquare ? planCapture(this.stage, event) : planQuietMove(this.stage, event);
    if (event.checkmate) tl.extend(planCheckmate(tl, this.stage, event.color === 'w' ? 'b' : 'w', tl.duration + 0.25));
    this.timeline = tl;
    this.speed = this.baseSpeed;
    return new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
  }

  /** Advance the current move. Returns the game-time step for systems that follow slow motion. */
  update(dt: number): number {
    if (this.beat >= 0) {
      this.beat += dt;
      const b = this.beat;
      const { stop, hold, ease, scale } = this.pace;
      if (this.speed > 1.01 || b >= stop + hold + ease) {
        this.beat = -1;
        this.timeScale = 1;
      } else if (b < stop) {
        this.timeScale = HIT_STOP_SCALE;
      } else {
        this.timeScale = scale + (1 - scale) * smoothstep(stop + hold, stop + hold + ease, b);
      }
    }
    const gameDt = dt * this.timeScale * this.speed;
    const tl = this.timeline;
    if (!tl) return gameDt;
    try {
      if (tl.update(gameDt)) this.end()?.();
    } catch (err) {
      // A choreography bug must never leave the game stuck: stop the move and let the
      // controller resynchronise the board from chess.js.
      const fail = this.fail;
      this.end();
      this.stage.shatter.setPusher(null);
      console.error(err);
      fail?.(err);
    }
    return gameDt;
  }

  /** Stop playing; returns the callback that reports the move finished. */
  private end(): (() => void) | null {
    const done = this.finish;
    this.timeline?.abort();
    this.timeline = null;
    this.finish = this.fail = null;
    this.speed = 1;
    this.stage.cinema.release();
    return done;
  }
}
