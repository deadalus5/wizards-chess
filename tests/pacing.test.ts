import { describe, expect, it } from 'vitest';
import { SpeedProfile, TimeWarp, type Tempo } from '../src/sequence/pacing';

describe('SpeedProfile', () => {
  it('covers exactly its distance, never going backwards, with hard or soft ramps', () => {
    for (const soft of [false, true]) {
      for (const distance of [0.3, 1.25, 2.5, 8.75]) {
        const p = new SpeedProfile(distance, 2.9, 0.75, soft);
        expect(p.at(0)).toBe(0);
        expect(p.at(p.duration)).toBeCloseTo(distance, 6);
        let prev = 0;
        for (let t = 0; t <= p.duration; t += p.duration / 200) {
          const s = p.at(t);
          expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = s;
        }
      }
    }
  });

  it('takes the same time with soft ramps as with hard ones', () => {
    for (const distance of [0.6, 1.25, 5]) {
      expect(new SpeedProfile(distance, 2.9, 0.75, true).duration).toBeCloseTo(new SpeedProfile(distance, 2.9, 0.75).duration, 9);
    }
  });

  it('is symmetrical: the second half mirrors the first', () => {
    const p = new SpeedProfile(5, 2.9, 0.75, true);
    for (const t of [0.1, 0.4, 0.9, 1.5]) expect(p.at(t) + p.at(p.duration - t)).toBeCloseTo(5, 6);
  });

  it('starts and stops without a jolt when soft', () => {
    const p = new SpeedProfile(5, 2.9, 0.75, true);
    const h = 1e-3;
    // Acceleration at the very start is (nearly) nothing; a hard ramp starts at full acceleration.
    const softAccel = (p.at(2 * h) - 2 * p.at(h) + p.at(0)) / (h * h);
    const hard = new SpeedProfile(5, 2.9, 0.75);
    const hardAccel = (hard.at(2 * h) - 2 * hard.at(h) + hard.at(0)) / (h * h);
    expect(softAccel).toBeLessThan(hardAccel * 0.05);
    expect(p.fraction(0.75)).toBeCloseTo(1, 6);
    expect(p.fraction(p.duration)).toBe(0);
  });

  it('copes with no distance at all', () => {
    const p = new SpeedProfile(0, 2.9, 0.75, true);
    expect(p.duration).toBe(0);
    expect(p.at(1)).toBe(0);
    expect(p.fraction(0.5)).toBe(0);
  });
});

describe('TimeWarp', () => {
  const tempo: Tempo = { windup: 0.7, hold: 0.18, swing: 0.9, follow: 0.75 };

  it('plays the clip unchanged at a tempo of one', () => {
    const w = new TimeWarp(0.44, 0.73, 1.48, { windup: 1, hold: 0, swing: 1, follow: 1 });
    for (const t of [0, 0.2, 0.44, 0.73, 1.2]) expect(w.at(t)).toBeCloseTo(t, 3);
    expect(w.duration).toBeCloseTo(1.48, 2);
  });

  it('never runs the clip backwards', () => {
    const w = new TimeWarp(0.44, 0.73, 1.48, tempo);
    let prev = -1;
    for (let t = 0; t <= w.duration; t += 1 / 300) {
      const c = w.at(t);
      expect(c).toBeGreaterThan(prev - 1e-6);
      prev = c;
    }
  });

  it('puts every clip time at exactly one moment (the blow lands when the cue says)', () => {
    const w = new TimeWarp(0.44, 0.73, 1.48, tempo);
    for (const clip of [0.1, 0.44, 0.6, 0.7, 0.73, 0.9, 1.4]) expect(w.at(w.when(clip))).toBeCloseTo(clip, 3);
  });

  it('lengthens the wind-up and leaves the blow near full speed', () => {
    const w = new TimeWarp(0.44, 0.73, 1.48, tempo);
    // The blow comes later than in the clip: slower wind-up plus the held beat.
    const hit = w.when(0.73);
    expect(hit).toBeGreaterThan(0.44 / 0.7 + 0.18 + 0.2);
    expect(hit).toBeLessThan(1.3);
    // Rate just before contact is the swing rate.
    const h = 0.02;
    expect((w.at(hit) - w.at(hit - h)) / h).toBeCloseTo(0.9, 1);
    // Rate in the middle of the held beat is a crawl.
    const top = 0.44 / 0.7 + 0.09;
    expect((w.at(top + h) - w.at(top - h)) / (2 * h)).toBeLessThan(0.2);
    // And the whole thing ends where the clip range ends.
    expect(w.at(w.duration)).toBeCloseTo(1.48, 2);
  });

  it('changes rate smoothly: no step in speed between phases', () => {
    const w = new TimeWarp(0.44, 0.73, 1.48, tempo);
    const h = 1 / 240;
    let worst = 0;
    for (let t = 2 * h; t < w.duration - 2 * h; t += h) {
      const before = (w.at(t) - w.at(t - h)) / h;
      const after = (w.at(t + h) - w.at(t)) / h;
      worst = Math.max(worst, Math.abs(after - before));
    }
    // The largest change of rate between adjacent 240ths is a small fraction of the rate itself.
    expect(worst).toBeLessThan(0.06);
  });

  it('handles a clip with no wind-up to speak of', () => {
    const w = new TimeWarp(0.01, 0.45, 1.07, tempo);
    expect(w.at(w.when(0.45))).toBeCloseTo(0.45, 3);
    expect(w.duration).toBeGreaterThan(1.07);
  });

  it('plays a flourish at its own speed and slows only the wind-up after it', () => {
    // A combination: two passes of the blades up to 0.84, then draw back (top at 1.11) and thrust at 1.21.
    const w = new TimeWarp(1.11, 1.21, 1.8, tempo, 0.84);
    // The flourish is untouched.
    for (const t of [0.1, 0.4, 0.7]) expect(w.at(t)).toBeCloseTo(t, 2);
    expect(w.when(0.84)).toBeCloseTo(0.84, 1);
    // From there to the top takes longer than the clip does, and the blow later still.
    expect(w.when(1.11) - w.when(0.84)).toBeCloseTo((1.11 - 0.84) / 0.7, 1);
    expect(w.when(1.21)).toBeGreaterThan(0.84 + 0.27 / 0.7 + 0.18);
    expect(w.at(w.when(1.21))).toBeCloseTo(1.21, 3);
    // Never backwards, across the join.
    let prev = -1;
    for (let t = 0; t < w.duration; t += 1 / 120) {
      expect(w.at(t)).toBeGreaterThanOrEqual(prev);
      prev = w.at(t);
    }
    // With no flourish the same call is the plain pacing.
    expect(new TimeWarp(0.44, 0.73, 1.48, tempo, 0).when(0.73)).toBeCloseTo(new TimeWarp(0.44, 0.73, 1.48, tempo).when(0.73), 9);
  });
});
