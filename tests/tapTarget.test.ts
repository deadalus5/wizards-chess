import { describe, expect, it } from 'vitest';
import { resolveTap, type RayHit, type TapContext } from '../src/input/tapTarget';

const statue = (square: string, offAxis = 0.2): RayHit => ({ square, statue: true, offAxis });
const board = (square: string): RayHit => ({ square, statue: false, offAxis: 0 });

function ctx(targets: string[], own: string[], nearby: [string, number][] = []): TapContext {
  return {
    isTarget: (s) => targets.includes(s),
    isOwn: (s) => own.includes(s),
    nearby: () => nearby.map(([square, distance]) => ({ square, distance })),
  };
}

describe('resolveTap', () => {
  it('takes a tap on the bare board for that square', () => {
    expect(resolveTap([board('e4')], ctx(['e4'], ['e2']))).toBe('e4');
    expect(resolveTap([board('e2')], ctx([], ['e2']))).toBe('e2');
  });

  it('takes a tap on a statue for that statue', () => {
    // An own piece to pick up; an enemy on a square the selected piece may take.
    expect(resolveTap([statue('g1'), board('g3')], ctx([], ['g1']))).toBe('g1');
    expect(resolveTap([statue('d5'), board('d7')], ctx(['d5'], ['e4']))).toBe('d5');
  });

  it('reaches a legal square that shows behind a statue which cannot be played', () => {
    // An enemy pawn that cannot be taken stands between the camera and the knight's square.
    expect(resolveTap([statue('e5'), board('f6')], ctx(['f6'], ['g4']))).toBe('f6');
  });

  it('prefers the legal square behind when a statue of one\'s own is only clipped at its edge', () => {
    expect(resolveTap([statue('d2', 0.85), board('d4')], ctx(['d4'], ['d2', 'd1']))).toBe('d4');
    // Through the middle of it, the statue itself was meant.
    expect(resolveTap([statue('d2', 0.3), board('d4')], ctx(['d4'], ['d2', 'd1']))).toBe('d2');
    // Clipped, but with nothing playable behind: still the statue.
    expect(resolveTap([statue('d2', 0.85), board('d3')], ctx([], ['d2']))).toBe('d2');
  });

  it('gives a near miss to the one playable square beside it', () => {
    expect(resolveTap([board('h6')], ctx(['g5'], ['f3'], [['g5', 15]]))).toBe('g5');
    expect(resolveTap([], ctx(['a8'], ['a1'], [['a8', 20]]))).toBe('a8');
  });

  it('does not guess between two playable squares, or reach for a far one', () => {
    expect(resolveTap([board('h6')], ctx(['g5', 'g6'], ['f3'], [['g5', 15], ['g6', 18]]))).toBe('h6');
    expect(resolveTap([board('h6')], ctx(['g5'], ['f3'], [['g5', 40]]))).toBe('h6');
    // One clearly nearer than the other is not a guess.
    expect(resolveTap([board('h6')], ctx(['g5', 'g6'], ['f3'], [['g5', 6], ['g6', 22]]))).toBe('g5');
  });

  it('falls back to what is first under the finger, or nothing', () => {
    expect(resolveTap([statue('e7'), board('e8')], ctx([], ['e2']))).toBe('e7');
    expect(resolveTap([], ctx([], ['e2']))).toBeNull();
  });
});
