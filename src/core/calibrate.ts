// Taking the timings that choose a phone's or tablet's level (see quality.ts). The drawing
// itself is behind `Bench`, so the order of measurements can be tested without a GPU.
import type { Timings } from './quality';

/** The picture, as far as measuring it goes. */
export interface Bench {
  /** Rebuild every buffer for a picture of this many megapixels. */
  resize(megapixels: number): void;
  setMirror(on: boolean): void;
  setAo(on: boolean): void;
  /** Milliseconds to draw one frame of the heaviest ordinary kind, flat out. */
  time(): number;
}

/**
 * Time the frame four ways: everything on at a low size and at a high one (which gives the
 * cost per pixel and the cost that does not depend on size), and at the low size without the
 * mirror, then without the ambient occlusion either. Two changes of size in all.
 *
 * `high` is the largest picture any level asks for (or the screen has); when that is hardly
 * more than `low` (a small, low-density screen) the one size is all there is to learn.
 */
export function measure(bench: Bench, low: number, high: number): Timings {
  bench.resize(low);
  bench.setMirror(true);
  bench.setAo(true);
  const fullLow = bench.time();
  bench.setMirror(false);
  const noMirrorLow = bench.time();
  bench.setAo(false);
  const bareLow = bench.time();
  bench.setAo(true);
  bench.setMirror(true);
  if (high < low * 1.15) return { low, high: low, fullLow, fullHigh: fullLow, noMirrorLow, bareLow };
  bench.resize(high);
  return { low, high, fullLow, fullHigh: bench.time(), noMirrorLow, bareLow };
}

/**
 * Time `frames` frames drawn back to back: `draw` issues one, `finish` blocks until the GPU
 * has really done them (reading a pixel back does). The first, after buffers were rebuilt or
 * a setting changed, is thrown away, and the better of two runs kept: a phone's GPU takes a
 * few frames to come up to speed.
 */
export function timeFrames(draw: () => void, finish: () => void, now: () => number = () => performance.now()): number {
  const run = (frames: number): number => {
    const start = now();
    for (let i = 0; i < frames; i++) draw();
    finish();
    return (now() - start) / frames;
  };
  run(2);
  const first = run(3);
  // A device this slow has told us enough; do not make it wait for more.
  if (first > 45) return first;
  return Math.min(first, run(6));
}
