import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameLoop } from '../src/core/loop';

// A hand-cranked requestAnimationFrame.
let pending: ((t: number) => void) | null = null;
function crank(loop: FrameLoop, times: number[]): void {
  for (const t of times) {
    const cb = pending;
    pending = null;
    cb?.(t);
  }
  void loop;
}

beforeEach(() => {
  pending = null;
  (globalThis as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame = (cb) => {
    pending = cb;
    return 1;
  };
  (globalThis as unknown as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame = () => {
    pending = null;
  };
});
afterEach(() => {
  pending = null;
});

function run(times: number[], configure?: (loop: FrameLoop) => void): { steps: number[]; loop: FrameLoop } {
  const steps: number[] = [];
  const loop = new FrameLoop((dt) => steps.push(+(dt * 1000).toFixed(2)));
  configure?.(loop);
  loop.start();
  crank(loop, times);
  return { steps, loop };
}

describe('FrameLoop', () => {
  it('steps by whole refresh intervals even when callback times jitter', () => {
    const times: number[] = [];
    for (let i = 0; i < 120; i++) times.push(1000 + i * 16.667 + (i % 7 === 3 ? 9 : 0) - (i % 5 === 2 ? 3 : 0));
    const { steps, loop } = run(times);
    const settled = steps.slice(40);
    expect(settled.length).toBeGreaterThan(60);
    for (const s of settled) expect(Math.abs(s - 16.67)).toBeLessThan(0.3);
    expect(loop.missed).toBe(0);
  });

  it('forgives a single missed frame: counts it, renders every callback, and does not jump', () => {
    const times: number[] = [];
    let t = 1000;
    for (let i = 0; i < 100; i++) {
      t += i === 70 ? 33.333 : 16.667;
      times.push(t);
    }
    const { steps, loop } = run(times);
    // One callback is used to start the clock; every other one renders.
    expect(steps.length).toBe(times.length - 1);
    expect(loop.missed).toBe(1);
    expect(steps.filter((s) => s > 30)).toHaveLength(0);
  });

  it('does not count a late callback followed by an early one as a miss', () => {
    const times: number[] = [];
    let t = 1000;
    for (let i = 0; i < 100; i++) {
      t += i === 60 ? 29.2 : i === 61 ? 4.133 : 16.667;
      times.push(t);
    }
    const { steps, loop } = run(times);
    expect(loop.missed).toBe(0);
    for (const s of steps.slice(40)) expect(Math.abs(s - 16.67)).toBeLessThan(0.3);
  });

  it('catches up when it keeps falling behind, so the game keeps pace with the clock', () => {
    const times: number[] = [];
    let t = 1000;
    for (let i = 0; i < 400; i++) {
      // Every third frame takes two refreshes.
      t += i > 60 && i % 3 === 0 ? 33.333 : 16.667;
      times.push(t);
    }
    const { steps } = run(times);
    const stepped = steps.reduce((a, b) => a + b, 0);
    const real = times[times.length - 1] - times[1];
    expect(Math.abs(stepped - real)).toBeLessThan(60);
    expect(steps.filter((s) => s > 30).length).toBeGreaterThan(50);
  });

  it('renders every second callback at an even pace on a 120 Hz display held to 60', () => {
    const times: number[] = [];
    for (let i = 0; i < 200; i++) times.push(1000 + i * 8.333);
    const { steps } = run(times, (loop) => {
      loop.auto = false;
      loop.targetFps = 60;
    });
    const settled = steps.slice(30);
    expect(settled.length).toBeGreaterThan(60);
    expect(settled.length).toBeLessThan(90);
    for (const s of settled) expect(Math.abs(s - 16.67)).toBeLessThan(0.3);
  });

  it('uses the full rate of a fast display when left to choose', () => {
    const times: number[] = [];
    for (let i = 0; i < 200; i++) times.push(1000 + i * 8.333);
    const { steps, loop } = run(times);
    expect(loop.targetFps).toBe(120);
    const settled = steps.slice(-60);
    for (const s of settled) expect(Math.abs(s - 8.33)).toBeLessThan(0.3);
  });
});
