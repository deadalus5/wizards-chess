import { describe, expect, it } from 'vitest';
import { Engine, LEVELS, parseBestMove, uciParts, type WorkerLike } from '../src/ai/engine';

/** Stands in for the Stockfish worker: records what is sent, and answers when told to. */
class FakeWorker implements WorkerLike {
  sent: string[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  /** Answer the handshake by itself. */
  auto = true;
  postMessage(m: string): void {
    this.sent.push(m);
    if (!this.auto) return;
    if (m === 'uci') queueMicrotask(() => this.emit('id name Fake', 'uciok'));
    if (m === 'isready') queueMicrotask(() => this.emit('readyok'));
  }
  emit(...lines: string[]): void {
    for (const l of lines) this.onmessage?.({ data: l });
  }
  terminate(): void {
    this.terminated = true;
  }
  count(prefix: string): number {
    return this.sent.filter((s) => s.startsWith(prefix)).length;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function setup(): { engine: Engine; w: FakeWorker } {
  const w = new FakeWorker();
  return { engine: new Engine(() => w), w };
}

describe('UCI parsing', () => {
  it('reads the move from a bestmove line', () => {
    expect(parseBestMove('bestmove e2e4')).toBe('e2e4');
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4');
    expect(parseBestMove('bestmove e7e8q ponder d8e8')).toBe('e7e8q');
    expect(parseBestMove('bestmove (none)')).toBeNull();
    expect(parseBestMove('info depth 10 score cp 31 pv e2e4')).toBeUndefined();
    expect(parseBestMove('readyok')).toBeUndefined();
  });

  it('splits coordinate moves, keeping the promotion piece', () => {
    expect(uciParts('e2e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(uciParts('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(uciParts('a2a1n')).toEqual({ from: 'a2', to: 'a1', promotion: 'n' });
    expect(uciParts('e1g1')).toEqual({ from: 'e1', to: 'g1' });
    expect(uciParts('e7e8k')).toBeNull();
    expect(uciParts('(none)')).toBeNull();
    expect(uciParts('i2i4')).toBeNull();
  });

  it('has four levels, weakest to strongest', () => {
    const l = [LEVELS.easy, LEVELS.medium, LEVELS.hard, LEVELS.max];
    for (let i = 1; i < l.length; i++) {
      expect(l[i].skill).toBeGreaterThan(l[i - 1].skill);
      expect(l[i].movetime).toBeGreaterThanOrEqual(l[i - 1].movetime);
    }
    expect(LEVELS.max.skill).toBe(20);
  });
});

describe('Engine', () => {
  it('does the UCI handshake once', async () => {
    const { engine, w } = setup();
    await Promise.all([engine.init(), engine.init()]);
    expect(w.sent).toEqual(['uci', 'isready']);
    expect(engine.loaded).toBe(true);
  });

  it('starts a new game with ucinewgame and waits for readyok', async () => {
    const { engine, w } = setup();
    await engine.newGame();
    expect(w.sent).toContain('ucinewgame');
    expect(w.sent.at(-1)).toBe('isready');
  });

  it('sends the skill, the position and the search, and resolves the best move', async () => {
    const { engine, w } = setup();
    const p = engine.bestMove(START, { skill: 6, movetime: 500 });
    await tick();
    expect(w.sent.slice(2)).toEqual(['setoption name Skill Level value 6', `position fen ${START}`, 'go movetime 500']);
    expect(engine.thinking).toBe(true);
    w.emit('info depth 1 score cp 20 pv e2e4', 'bestmove e2e4 ponder e7e5');
    expect(await p).toBe('e2e4');
    expect(engine.thinking).toBe(false);
    expect(engine.times.length).toBe(1);
  });

  it('only resends the skill when it changes', async () => {
    const { engine, w } = setup();
    const a = engine.bestMove(START, { skill: 6, movetime: 100 });
    await tick();
    w.emit('bestmove e2e4');
    await a;
    const b = engine.bestMove(AFTER_E4, { skill: 6, movetime: 100 });
    await tick();
    w.emit('bestmove e7e5');
    await b;
    expect(w.count('setoption name Skill Level')).toBe(1);
    const c = engine.bestMove(START, { skill: 20, movetime: 100 });
    await tick();
    w.emit('bestmove d2d4');
    await c;
    expect(w.count('setoption name Skill Level')).toBe(2);
  });

  it('passes a promotion through with its piece', async () => {
    const { engine, w } = setup();
    const p = engine.bestMove('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', LEVELS.max);
    await tick();
    w.emit('bestmove a7a8q ponder e8d7');
    expect(await p).toBe('a7a8q');
  });

  it('resolves null when there is no move', async () => {
    const { engine, w } = setup();
    const p = engine.bestMove('7k/5QQ1/8/8/8/8/8/4K3 b - - 0 1', LEVELS.easy);
    await tick();
    w.emit('bestmove (none)');
    expect(await p).toBeNull();
  });

  it('never gives a superseded search the next search\'s answer', async () => {
    const { engine, w } = setup();
    const a = engine.bestMove(START, { skill: 20, movetime: 3000 });
    await tick();
    const b = engine.bestMove(AFTER_E4, { skill: 20, movetime: 3000 });
    await tick();
    // The first search is stopped; the second does not start until the first has answered.
    expect(w.sent.at(-1)).toBe('stop');
    expect(w.count('go ')).toBe(1);
    expect(await a).toBeNull();
    // The stopped search's late answer (a White move) must not reach the second request.
    w.emit('bestmove d2d4');
    await tick();
    expect(w.count('go ')).toBe(2);
    expect(w.sent.at(-2)).toBe(`position fen ${AFTER_E4}`);
    w.emit('bestmove e7e5');
    expect(await b).toBe('e7e5');
  });

  it('of three quick requests, only the last is searched after the stop', async () => {
    const { engine, w } = setup();
    const a = engine.bestMove(START, LEVELS.hard);
    await tick();
    const b = engine.bestMove(AFTER_E4, LEVELS.hard);
    const c = engine.bestMove(START, LEVELS.hard);
    await tick();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    w.emit('bestmove e2e4');
    await tick();
    expect(w.count('go ')).toBe(2);
    w.emit('bestmove g1f3');
    expect(await c).toBe('g1f3');
  });

  it('drops a reply that arrives after stop()', async () => {
    const { engine, w } = setup();
    const p = engine.bestMove(START, LEVELS.hard);
    await tick();
    engine.stop();
    expect(w.sent.at(-1)).toBe('stop');
    expect(await p).toBeNull();
    const before = w.sent.length;
    w.emit('bestmove e2e4');
    await tick();
    expect(w.sent.length).toBe(before);
    expect(engine.thinking).toBe(false);
    expect(engine.times.length).toBe(0);
    // And the engine still answers the next request.
    const q = engine.bestMove(AFTER_E4, LEVELS.hard);
    await tick();
    w.emit('bestmove c7c5');
    expect(await q).toBe('c7c5');
  });

  it('rejects what is pending and terminates on dispose', async () => {
    const { engine, w } = setup();
    const p = engine.bestMove(START, LEVELS.hard);
    await tick();
    engine.dispose();
    await expect(p).rejects.toThrow('disposed');
    expect(w.terminated).toBe(true);
    expect(w.sent).toContain('quit');
    await expect(engine.bestMove(START, LEVELS.easy)).rejects.toThrow();
  });

  it('rejects when the worker fails, including during the handshake', async () => {
    const w = new FakeWorker();
    w.auto = false;
    const engine = new Engine(() => w);
    const init = engine.init();
    w.onerror?.(new Error('wasm failed'));
    await expect(init).rejects.toThrow('wasm failed');
    expect(engine.loaded).toBe(false);

    const { engine: e2, w: w2 } = setup();
    const p = e2.bestMove(START, LEVELS.easy);
    await tick();
    w2.onerror?.({ message: 'crash' });
    await expect(p).rejects.toThrow('crash');
  });
});
