import { describe, expect, it } from 'vitest';
import { Timeline } from '../src/sequence/timeline';

describe('Timeline', () => {
  it('fires cues in time order, once each, whatever the step size', () => {
    for (const step of [0.001, 0.016, 0.1, 5]) {
      const tl = new Timeline();
      const fired: string[] = [];
      tl.at(0.5, () => fired.push('b'));
      tl.at(0.2, () => fired.push('a'));
      tl.at(0.5, () => fired.push('c'));
      tl.at(1.0, () => fired.push('d'));
      let guard = 0;
      while (!tl.update(step) && guard++ < 10000);
      expect(fired).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('calls a span every frame and exactly once more at its end', () => {
    const tl = new Timeline();
    const seen: number[] = [];
    tl.span(0.1, 0.3, (local) => seen.push(+local.toFixed(3)));
    tl.extend(1);
    while (!tl.update(0.07));
    expect(seen[0]).toBeGreaterThanOrEqual(0);
    expect(seen[seen.length - 1]).toBe(0.3);
    expect(seen.filter((v) => v === 0.3)).toHaveLength(1);
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1])).toBe(true);
  });

  it('runs a span before a cue at the same moment', () => {
    const tl = new Timeline();
    const order: string[] = [];
    tl.at(0.5, () => order.push('cue'));
    tl.span(0, 0.5, (local) => {
      if (local === 0.5) order.push('span-end');
    });
    while (!tl.update(0.2));
    expect(order).toEqual(['span-end', 'cue']);
  });

  it('runs clean-up when abandoned part-way, and not when it finished', () => {
    const partial = new Timeline();
    let cleaned = 0;
    partial.onAbort(() => cleaned++);
    partial.extend(1);
    partial.update(0.4);
    partial.abort();
    partial.abort();
    expect(cleaned).toBe(1);

    const done = new Timeline();
    done.onAbort(() => cleaned++);
    done.extend(1);
    done.update(2);
    done.abort();
    expect(cleaned).toBe(1);
  });
});
