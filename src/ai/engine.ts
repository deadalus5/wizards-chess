// A thin wrapper round a UCI chess engine running in a Web Worker (Stockfish.js, lite,
// single-threaded, vendored in public/engine). The engine does all the thinking off the main
// thread; this file only sends commands and matches each `bestmove` to the request it answers.

export type Level = 'easy' | 'medium' | 'hard' | 'max';

export interface SearchOptions {
  /** Stockfish `Skill Level`, 0 (weakest) to 20 (full strength). */
  skill: number;
  /** Thinking time in milliseconds (`go movetime`). */
  movetime: number;
}

export const LEVELS: Record<Level, SearchOptions> = {
  easy: { skill: 1, movetime: 250 },
  medium: { skill: 6, movetime: 500 },
  hard: { skill: 13, movetime: 1000 },
  max: { skill: 20, movetime: 2000 },
};

/** The parts of the worker the wrapper uses (a fake stands in for it in tests). */
export interface WorkerLike {
  postMessage(message: string): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

export const ENGINE_URL = `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;

const defaultWorker = (): WorkerLike => new Worker(ENGINE_URL) as unknown as WorkerLike;

/** The move in a `bestmove` line, or null for `(none)` (no legal move); undefined if not a `bestmove` line. */
export function parseBestMove(line: string): string | null | undefined {
  if (!line.startsWith('bestmove')) return undefined;
  const move = line.split(/\s+/)[1];
  if (!move || move === '(none)' || move === '0000') return null;
  return move;
}

export interface UciParts {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

/** Split a coordinate move such as `e2e4` or `e7e8q`; null if it is not one. */
export function uciParts(uci: string): UciParts | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci.trim().toLowerCase());
  if (!m) return null;
  const parts: UciParts = { from: m[1], to: m[2] };
  if (m[3]) parts.promotion = m[3] as UciParts['promotion'];
  return parts;
}

interface Search {
  fen: string;
  opts: SearchOptions;
  resolve(move: string | null): void;
  reject(err: unknown): void;
  /** Sent to the engine with `go` (so a `bestmove` is owed for it). */
  sent: boolean;
  /** Superseded or stopped: its answer is thrown away. */
  cancelled: boolean;
  started: number;
}

/**
 * One engine, one search at a time. UCI answers every `go` with exactly one `bestmove`, even
 * after `stop`, so a request that arrives while another is searching stops that one and waits
 * for its (now unwanted) answer before starting: an answer is never matched to the wrong
 * position.
 */
export class Engine {
  private worker: WorkerLike | null = null;
  private ready: Promise<void> | null = null;
  private waiters: { token: string; resolve(): void; reject(err: unknown): void }[] = [];
  /** The search owed a `bestmove` (sent), if any. */
  private current: Search | null = null;
  /** The next search, waiting for the current one to answer. */
  private next: Search | null = null;
  private skill = -1;
  private failed: unknown = null;
  /** Milliseconds each answered (not cancelled) search took, most recent last. */
  readonly times: number[] = [];
  /** Raw lines from the engine are passed here too (debugging). */
  onLine: ((line: string) => void) | null = null;

  constructor(private readonly makeWorker: () => WorkerLike = defaultWorker) {}

  get thinking(): boolean {
    return (this.current !== null && !this.current.cancelled) || this.next !== null;
  }

  get loaded(): boolean {
    return this.worker !== null && this.failed === null;
  }

  /** Start the worker and complete the UCI handshake (safe to call more than once). */
  init(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.ready) return this.ready;
    const w = this.makeWorker();
    this.worker = w;
    w.onmessage = (e) => this.receive(String(e.data));
    w.onerror = (e) => this.fail(e instanceof Error ? e : new Error(`engine worker error: ${String((e as { message?: string })?.message ?? e)}`));
    this.ready = (async () => {
      await this.command('uci', 'uciok');
      await this.command('isready', 'readyok');
    })();
    return this.ready;
  }

  /** Tell the engine a new game starts (clears its hash and history). */
  async newGame(): Promise<void> {
    await this.init();
    this.stop();
    this.post('ucinewgame');
    await this.command('isready', 'readyok');
  }

  /**
   * The engine's choice of move in `fen`, as UCI (`e2e4`, `e7e8q`), or null if there is none or
   * the request was superseded / stopped before it answered.
   */
  async bestMove(fen: string, opts: SearchOptions): Promise<string | null> {
    await this.init();
    return new Promise<string | null>((resolve, reject) => {
      const search: Search = { fen, opts, resolve, reject, sent: false, cancelled: false, started: 0 };
      // Anything still waiting to start is replaced outright.
      if (this.next) {
        this.next.cancelled = true;
        this.next.resolve(null);
      }
      this.next = search;
      if (this.current) this.cancelCurrent();
      else this.startNext();
    });
  }

  /** Cancel whatever is searching or waiting; its answer will be ignored. */
  stop(): void {
    if (this.next) {
      this.next.cancelled = true;
      this.next.resolve(null);
      this.next = null;
    }
    if (this.current) this.cancelCurrent();
  }

  dispose(): void {
    const err = new Error('engine disposed');
    this.rejectAll(err);
    if (this.worker) {
      try {
        this.worker.postMessage('quit');
      } catch {
        /* already gone */
      }
      this.worker.terminate();
    }
    this.worker = null;
    this.ready = null;
    this.failed = err;
  }

  private cancelCurrent(): void {
    const c = this.current;
    if (!c || c.cancelled) return;
    c.cancelled = true;
    c.resolve(null);
    this.post('stop');
  }

  private startNext(): void {
    const s = this.next;
    if (!s) return;
    this.next = null;
    this.current = s;
    if (s.opts.skill !== this.skill) {
      this.post(`setoption name Skill Level value ${Math.round(s.opts.skill)}`);
      this.skill = s.opts.skill;
    }
    this.post(`position fen ${s.fen}`);
    this.post(`go movetime ${Math.max(1, Math.round(s.opts.movetime))}`);
    s.sent = true;
    s.started = now();
  }

  private receive(line: string): void {
    this.onLine?.(line);
    if (line.startsWith('info')) return;
    const best = parseBestMove(line);
    if (best !== undefined) {
      const c = this.current;
      this.current = null;
      if (c && !c.cancelled) {
        this.times.push(now() - c.started);
        if (this.times.length > 500) this.times.shift();
        c.resolve(best);
      }
      this.startNext();
      return;
    }
    const w = this.waiters.findIndex((x) => line.startsWith(x.token));
    if (w >= 0) this.waiters.splice(w, 1)[0].resolve();
  }

  private command(cmd: string, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ token, resolve, reject });
      this.post(cmd);
    });
  }

  private post(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  private fail(err: unknown): void {
    this.failed = err;
    this.rejectAll(err);
    this.worker?.terminate();
    this.worker = null;
  }

  private rejectAll(err: unknown): void {
    for (const s of [this.current, this.next]) if (s && !s.cancelled) s.reject(err);
    this.current = this.next = null;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
