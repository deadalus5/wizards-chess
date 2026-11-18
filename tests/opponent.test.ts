import { describe, expect, it } from 'vitest';
import { undoPlies } from '../src/ai/opponent';

describe('undo against the computer', () => {
  it('takes back the computer\'s reply and your move on your turn', () => {
    expect(undoPlies('computer', 'w', 'w', 6)).toBe(2);
    expect(undoPlies('computer', 'b', 'b', 5)).toBe(2);
  });
  it('takes back only your move while the computer is thinking', () => {
    expect(undoPlies('computer', 'w', 'b', 5)).toBe(1);
    expect(undoPlies('computer', 'b', 'w', 2)).toBe(1);
  });
  it('does nothing at the start, or when only the computer\'s opening move stands', () => {
    expect(undoPlies('computer', 'w', 'w', 0)).toBe(0);
    expect(undoPlies('computer', 'b', 'b', 1)).toBe(0);
  });
  it('takes back one move in pass-and-play and auto-play', () => {
    expect(undoPlies('pass', 'w', 'b', 3)).toBe(1);
    expect(undoPlies('auto', 'w', 'w', 8)).toBe(1);
    expect(undoPlies('auto', 'w', 'w', 0)).toBe(0);
  });
});
