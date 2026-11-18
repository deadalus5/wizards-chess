import { describe, expect, it } from 'vitest';
import { measure, timeFrames, type Bench } from '../src/core/calibrate';
import { ChessGame } from '../src/chess/game';
import { decodeSaved, encodeSaved, shouldRestore } from '../src/game/saved';

const NOW = 1_800_000_000_000;

describe('a saved game', () => {
  it('comes back as it was stored', () => {
    const text = encodeSaved('computer', 'b', ['e2e4', 'e7e5', 'g1f3'], NOW);
    expect(decodeSaved(text, NOW + 5000)).toEqual({ v: 1, mode: 'computer', side: 'b', moves: ['e2e4', 'e7e5', 'g1f3'], at: NOW });
  });

  it('is not taken up when it is empty, old, from the future, or not a game at all', () => {
    expect(decodeSaved(null, NOW)).toBeNull();
    expect(decodeSaved('', NOW)).toBeNull();
    expect(decodeSaved('not json', NOW)).toBeNull();
    expect(decodeSaved(encodeSaved('pass', 'w', [], NOW), NOW)).toBeNull();
    expect(decodeSaved(encodeSaved('pass', 'w', ['e2e4'], NOW), NOW + 31 * 24 * 3600 * 1000)).toBeNull();
    expect(decodeSaved(encodeSaved('pass', 'w', ['e2e4'], NOW + 3600_000), NOW)).toBeNull();
    expect(decodeSaved(JSON.stringify({ v: 2, mode: 'pass', side: 'w', moves: ['e2e4'], at: NOW }), NOW)).toBeNull();
    expect(decodeSaved(JSON.stringify({ v: 1, mode: 'auto', side: 'w', moves: ['e2e4'], at: NOW }), NOW)).toBeNull();
    expect(decodeSaved(JSON.stringify({ v: 1, mode: 'pass', side: 'w', moves: ['e2e4', 'castle'], at: NOW }), NOW)).toBeNull();
    expect(decodeSaved(JSON.stringify({ v: 1, mode: 'pass', side: 'x', moves: ['e2e4'], at: NOW }), NOW)).toBeNull();
  });

  it('keeps promotions', () => {
    expect(decodeSaved(encodeSaved('pass', 'w', ['a7a8q', 'h2h1n'], NOW), NOW)?.moves).toEqual(['a7a8q', 'h2h1n']);
  });

  it('is restored only into the same kind of game, and against the computer the same side', () => {
    const pass = decodeSaved(encodeSaved('pass', 'w', ['e2e4'], NOW), NOW);
    const computer = decodeSaved(encodeSaved('computer', 'b', ['e2e4'], NOW), NOW);
    expect(shouldRestore(pass, 'pass', 'w')).toBe(true);
    expect(shouldRestore(pass, 'pass', 'b')).toBe(true);
    expect(shouldRestore(pass, 'computer', 'w')).toBe(false);
    expect(shouldRestore(pass, 'auto', 'w')).toBe(false);
    expect(shouldRestore(computer, 'computer', 'b')).toBe(true);
    expect(shouldRestore(computer, 'computer', 'w')).toBe(false);
    expect(shouldRestore(null, 'pass', 'w')).toBe(false);
  });
});

describe('ChessGame.standardStart', () => {
  it('knows a game that began from the ordinary position, whose moves alone describe it', () => {
    const game = new ChessGame();
    expect(game.standardStart).toBe(true);
    game.play('e2', 'e4');
    game.play('e7', 'e5');
    expect(game.standardStart).toBe(true);
    game.undo();
    expect(game.standardStart).toBe(true);
  });

  it('knows one set up from another position', () => {
    const game = new ChessGame();
    game.load('4k3/8/8/n7/8/8/8/R3K3 w - - 0 1');
    expect(game.standardStart).toBe(false);
    game.play('a1', 'a5');
    expect(game.standardStart).toBe(false);
    game.reset();
    expect(game.standardStart).toBe(true);
  });
});

describe('measure', () => {
  /** A picture that costs 4 ms + 5 ms a megapixel, 3 ms for the mirror, and 1.5 ms a megapixel for the AO. */
  function fake(): Bench & { log: string[] } {
    let mp = 0;
    let mirror = true;
    let ao = true;
    const log: string[] = [];
    return {
      log,
      resize: (megapixels) => {
        mp = megapixels;
        log.push(`size ${megapixels}`);
      },
      setMirror: (on) => (mirror = on),
      setAo: (on) => (ao = on),
      time: () => {
        log.push(`time ${mirror ? 'mirror' : '-'} ${ao ? 'ao' : '-'}`);
        return 4 + 3.5 * mp + (mirror ? 3 : 0) + (ao ? 1.5 * mp : 0);
      },
    };
  }

  it('times the frame four ways with two changes of size, and leaves everything switched on', () => {
    const bench = fake();
    const t = measure(bench, 0.7, 1.5);
    expect(bench.log).toEqual(['size 0.7', 'time mirror ao', 'time - ao', 'time - -', 'size 1.5', 'time mirror ao']);
    expect(t.low).toBe(0.7);
    expect(t.high).toBe(1.5);
    expect(t.fullLow).toBeCloseTo(4 + 5 * 0.7 + 3, 6);
    expect(t.fullHigh).toBeCloseTo(4 + 5 * 1.5 + 3, 6);
    expect(t.fullLow - t.noMirrorLow).toBeCloseTo(3, 6);
    expect(t.noMirrorLow - t.bareLow).toBeCloseTo(1.5 * 0.7, 6);
  });

  it('does not resize again when the screen has no more pixels to give', () => {
    const bench = fake();
    const t = measure(bench, 0.6, 0.62);
    expect(bench.log.filter((l) => l.startsWith('size'))).toEqual(['size 0.6']);
    expect(t.high).toBe(0.6);
    expect(t.fullHigh).toBe(t.fullLow);
  });
});

describe('timeFrames', () => {
  it('throws away the first frames and keeps the better of two runs', () => {
    // A clock advanced by each frame: slow while the GPU wakes, then steady.
    let clock = 0;
    let drawn = 0;
    const costs = [40, 30, 14, 12, 12, 10, 10, 10, 10, 10, 10];
    const ms = timeFrames(
      () => (clock += costs[Math.min(drawn++, costs.length - 1)]),
      () => {},
      () => clock,
    );
    expect(drawn).toBe(11);
    expect(ms).toBeCloseTo(10, 6);
  });

  it('stops early on a device too slow to be worth timing twice', () => {
    let clock = 0;
    let drawn = 0;
    const ms = timeFrames(
      () => {
        clock += 60;
        drawn++;
      },
      () => {},
      () => clock,
    );
    expect(drawn).toBe(5);
    expect(ms).toBe(60);
  });
});
