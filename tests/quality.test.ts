import { describe, expect, it } from 'vitest';
import { BUDGET_MS, cameLate, chooseLevel, Governor, ladder, pixelRatioFor, predict, type Timings } from '../src/core/quality';

/** A device whose frame costs `fixed` + `perMp` x megapixels, with a mirror and AO of the given cost at 0.8 MP. */
function device(fixed: number, perMp: number, mirror: number, ao: number): Timings {
  const low = 0.8;
  const high = 1.4;
  const full = (mp: number): number => fixed + perMp * mp;
  return { low, high, fullLow: full(low), fullHigh: full(high), noMirrorLow: full(low) - mirror, bareLow: full(low) - mirror - ao };
}

describe('ladder', () => {
  it('gets lighter rung by rung at each pace, and ends at the lightest picture', () => {
    for (const kind of ['phone', 'tablet'] as const) {
      const levels = ladder(kind);
      for (const fps of [60, 30] as const) {
        const group = levels.filter((l) => l.fps === fps);
        for (let i = 1; i < group.length; i++) expect(group[i].pixels).toBeLessThanOrEqual(group[i - 1].pixels);
      }
      expect(levels[0]).toMatchObject({ mirror: true, ao: 'Medium', dof: true, fps: 60 });
      expect(levels.filter((l) => l.mirror)).toHaveLength(1);
      const last = levels[levels.length - 1];
      expect(last).toMatchObject({ mirror: false, ao: 'off', dof: false, fps: 30 });
      expect(Math.min(...levels.map((l) => l.pixels))).toBe(last.pixels);
    }
    // A tablet's bigger screen gets more pixels, but stays inside a memory budget.
    expect(ladder('tablet')[0].pixels).toBeGreaterThan(ladder('phone')[0].pixels);
    expect(ladder('tablet')[0].pixels).toBeLessThanOrEqual(2.5);
  });
});

describe('pixelRatioFor', () => {
  it('renders the asked number of pixels, but never more than the screen has', () => {
    const ratio = pixelRatioFor(1.5, 393, 852, 3);
    expect(ratio * ratio * 393 * 852).toBeCloseTo(1.5e6, -2);
    expect(pixelRatioFor(1.5, 360, 640, 2)).toBe(2);
    expect(pixelRatioFor(0.2, 1366, 1024, 2)).toBe(0.75);
  });
});

describe('predict', () => {
  const t = device(4, 5, 3, 1.2);

  it('gives back what was measured', () => {
    expect(predict(t, { pixels: 0.8, mirror: true, ao: 'Medium' })).toBeCloseTo(t.fullLow, 6);
    expect(predict(t, { pixels: 1.4, mirror: true, ao: 'Medium' })).toBeCloseTo(t.fullHigh, 6);
    expect(predict(t, { pixels: 0.8, mirror: false, ao: 'Medium' })).toBeCloseTo(t.noMirrorLow, 6);
    expect(predict(t, { pixels: 0.8, mirror: false, ao: 'off' })).toBeCloseTo(t.bareLow, 6);
  });

  it('charges by the pixel between and beyond the sizes timed', () => {
    expect(predict(t, { pixels: 1.1, mirror: true, ao: 'Medium' })).toBeCloseTo(4 + 5 * 1.1, 6);
    expect(predict(t, { pixels: 2.2, mirror: true, ao: 'Medium' })).toBeCloseTo(4 + 5 * 2.2, 6);
    // Lighter occlusion saves part of its cost, which itself grows with the picture.
    const medium = predict(t, { pixels: 1.6, mirror: false, ao: 'Medium' });
    const light = predict(t, { pixels: 1.6, mirror: false, ao: 'Performance' });
    const none = predict(t, { pixels: 1.6, mirror: false, ao: 'off' });
    expect(light).toBeLessThan(medium);
    expect(none).toBeLessThan(light);
    expect(medium - none).toBeCloseTo(1.2 * 2, 6);
  });

  it('never predicts less than nothing from noisy timings', () => {
    const noisy: Timings = { low: 0.8, high: 1.4, fullLow: 6, fullHigh: 5.5, noMirrorLow: 6.4, bareLow: 6.6 };
    expect(predict(noisy, { pixels: 2, mirror: false, ao: 'off' })).toBeGreaterThanOrEqual(0);
    expect(predict(noisy, { pixels: 1.5, mirror: true, ao: 'Medium' })).toBeCloseTo(6, 6);
  });
});

describe('chooseLevel', () => {
  const levels = ladder('phone');

  it('gives a fast device the full look', () => {
    expect(chooseLevel(levels, device(2, 3, 2, 0.6))).toBe(0);
  });

  it('drops the mirror before anything else', () => {
    const t = device(5.5, 5.5, 3.2, 1);
    expect(predict(t, levels[0])).toBeGreaterThan(BUDGET_MS[60]);
    expect(chooseLevel(levels, t)).toBe(1);
  });

  it('then trades pixels for pace, and takes an even 30 only when 60 cannot be had', () => {
    const mid = chooseLevel(levels, device(7, 7, 3, 1.5));
    expect(levels[mid].fps).toBe(60);
    expect(levels[mid].pixels).toBeLessThan(levels[0].pixels);
    const slow = chooseLevel(levels, device(12, 9, 4, 2));
    expect(levels[slow].fps).toBe(30);
    // At 30 the picture is fuller again than the last rung at 60.
    expect(levels[slow].pixels).toBeGreaterThanOrEqual(levels[3].pixels);
  });

  it('settles on the lightest picture when nothing fits', () => {
    expect(chooseLevel(levels, device(40, 30, 10, 5))).toBe(levels.length - 1);
  });

  it('chooses lower as the device gets slower, never higher', () => {
    let last = 0;
    for (let k = 1; k <= 12; k += 0.5) {
      const index = chooseLevel(levels, device(2 * k, 2.5 * k, 1.5 * k, 0.5 * k));
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
    expect(last).toBe(levels.length - 1);
  });
});

describe('cameLate', () => {
  it('judges a frame against the pace wanted, whatever the display runs at', () => {
    // On time at 60 on a 60 Hz display, and on the paces the cap settles at on 90 and 144 Hz ones.
    for (const ms of [16.7, 22.2, 20.8, 13.3]) expect(cameLate(ms, 60)).toBe(false);
    // Two refreshes over a frame: late for 60, exactly right for 30.
    expect(cameLate(33.3, 60)).toBe(true);
    expect(cameLate(33.3, 30)).toBe(false);
    expect(cameLate(50, 30)).toBe(true);
  });
});

describe('Governor', () => {
  const feed = (g: Governor, frames: number, everyNthLate: number): void => {
    for (let i = 0; i < frames; i++) g.frame(everyNthLate && i % everyNthLate === 0 ? 1 : 0);
  };

  it('is untroubled by the odd late frame', () => {
    const g = new Governor({ window: 100, share: 0.15, strikes: 2, rest: 0 });
    feed(g, 1000, 20);
    expect(g.struggling).toBe(false);
  });

  it('calls it struggling only after frames have been late for two windows running', () => {
    const g = new Governor({ window: 100, share: 0.15, strikes: 2, rest: 0 });
    feed(g, 100, 3);
    expect(g.struggling).toBe(false);
    feed(g, 100, 3);
    expect(g.struggling).toBe(true);
  });

  it('forgets one bad window if the next is good', () => {
    const g = new Governor({ window: 100, share: 0.15, strikes: 2, rest: 0 });
    feed(g, 100, 3);
    feed(g, 100, 0);
    feed(g, 100, 3);
    expect(g.struggling).toBe(false);
  });

  it('does not count a late frame that the next one makes up for', () => {
    const g = new Governor({ window: 100, share: 0.15, strikes: 1, rest: 0 });
    // Late, early, late, early: jitter, not a slow device.
    for (let i = 0; i < 400; i++) g.frame(i % 2 === 0 ? 1 : -1);
    expect(g.struggling).toBe(false);
  });

  it('can be told to rest for longer, when the lateness was not the picture\'s doing', () => {
    const g = new Governor({ window: 100, share: 0.15, strikes: 1, rest: 100 });
    feed(g, 100, 2);
    g.settle(1000);
    feed(g, 1000, 2);
    expect(g.struggling).toBe(false);
    feed(g, 100, 2);
    expect(g.struggling).toBe(true);
  });

  it('rests after a step before it judges again', () => {
    const g = new Governor({ window: 100, share: 0.15, strikes: 1, rest: 250 });
    feed(g, 100, 2);
    expect(g.struggling).toBe(true);
    g.settle();
    expect(g.struggling).toBe(false);
    feed(g, 300, 2);
    expect(g.struggling).toBe(false);
    feed(g, 100, 2);
    expect(g.struggling).toBe(true);
  });
});
