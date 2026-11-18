import { describe, expect, it } from 'vitest';
import { DESKTOP_SEAT, projectFromSeat, seatFor, slideLimit, type Insets } from '../src/cinema/seat';

const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Every point that has to stay on screen: the frame's corners, the corner statues, the tallest crowns. */
const MUST_SHOW: [number, number, number][] = [];
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) {
    MUST_SHOW.push([sx * 5.55, 0, sz * 5.55], [sx * 4.795, 2.25, sz * 4.375], [sx * 4.795, 0, sz * 4.375]);
  }
}
MUST_SHOW.push([0, 2.65, -4.375], [0, 2.65, 4.375], [0, 0, 5.55], [0, 0, -5.55]);

const SCREENS: [string, number, number, Insets][] = [
  ['phone portrait', 393, 852, { top: 123, right: 0, bottom: 98, left: 0 }],
  ['small phone portrait', 360, 640, { top: 64, right: 0, bottom: 64, left: 0 }],
  ['tall narrow phone', 360, 880, { top: 100, right: 0, bottom: 90, left: 0 }],
  ['phone landscape', 852, 393, { top: 8, right: 59, bottom: 29, left: 59 }],
  ['phone landscape in a browser', 844, 340, { top: 8, right: 59, bottom: 29, left: 59 }],
  ['tablet portrait', 820, 1180, { top: 88, right: 0, bottom: 84, left: 0 }],
  ['tablet landscape', 1180, 820, { top: 84, right: 0, bottom: 28, left: 0 }],
  ['4:3 tablet landscape', 1024, 768, { top: 84, right: 0, bottom: 28, left: 0 }],
  ['a fold, nearly square', 880, 800, { top: 70, right: 0, bottom: 70, left: 0 }],
];

describe('seatFor', () => {
  it('keeps the whole board and its tallest statues inside the free space on every screen', () => {
    for (const [name, w, h, insets] of SCREENS) {
      const seat = seatFor(w, h, insets);
      for (const [x, y, z] of MUST_SHOW) {
        const [nx, ny] = projectFromSeat(seat, w / h, x, y, z);
        const px = ((nx + 1) / 2) * w;
        const py = ((1 - ny) / 2) * h;
        expect(px, `${name}: x of (${x}, ${y}, ${z})`).toBeGreaterThanOrEqual(insets.left - 0.5);
        expect(px, `${name}: x of (${x}, ${y}, ${z})`).toBeLessThanOrEqual(w - insets.right + 0.5);
        expect(py, `${name}: y of (${x}, ${y}, ${z})`).toBeGreaterThanOrEqual(insets.top - 0.5);
        expect(py, `${name}: y of (${x}, ${y}, ${z})`).toBeLessThanOrEqual(h - insets.bottom + 0.5);
      }
    }
  });

  it('is the desktop seat on a wide screen with nothing in the way', () => {
    for (const [w, h] of [
      [1600, 860],
      [1920, 1080],
      [1440, 900],
    ]) {
      const seat = seatFor(w, h, NONE);
      expect(seat.fov).toBe(DESKTOP_SEAT.fov);
      expect(seat.elevation).toBeCloseTo(DESKTOP_SEAT.elevation, 9);
      expect(seat.distance).toBeCloseTo(DESKTOP_SEAT.distance, 9);
      expect(seat.aim).toBe(0);
      expect(seat.distanceMin).toBe(DESKTOP_SEAT.distanceMin);
      expect(seat.distanceMax).toBe(DESKTOP_SEAT.distanceMax);
    }
  });

  it('opens the lens for a narrow screen rather than backing into the fog', () => {
    const phone = seatFor(393, 852, { top: 123, right: 0, bottom: 98, left: 0 });
    const tablet = seatFor(820, 1180, { top: 88, right: 0, bottom: 84, left: 0 });
    expect(phone.fov).toBeGreaterThan(55);
    expect(phone.fov).toBeLessThanOrEqual(62);
    expect(phone.distance).toBeLessThan(27);
    expect(tablet.fov).toBeGreaterThan(40);
    expect(tablet.fov).toBeLessThan(phone.fov);
    // A higher seat on a tall screen: less of each rank hides behind the one in front.
    expect(phone.elevation).toBeGreaterThan(DESKTOP_SEAT.elevation);
  });

  it('keeps the squares big enough to touch', () => {
    for (const [name, w, h, insets] of SCREENS) {
      const seat = seatFor(w, h, insets);
      const left = ((projectFromSeat(seat, w / h, -0.625, 0, 0)[0] + 1) / 2) * w;
      const right = ((projectFromSeat(seat, w / h, 0.625, 0, 0)[0] + 1) / 2) * w;
      expect(right - left, name).toBeGreaterThan(w < 500 ? 30 : 34);
    }
  });

  it('uses the height of a phone on its side by tipping the view, not by stepping far back', () => {
    const seat = seatFor(852, 393, { top: 8, right: 59, bottom: 29, left: 59 });
    expect(seat.fov).toBe(30);
    expect(seat.distance).toBeLessThan(20.5);
    expect(seat.aim).not.toBe(0);
  });

  it('lets the player zoom out a little past the seat', () => {
    const seat = seatFor(393, 852, { top: 123, right: 0, bottom: 98, left: 0 });
    expect(seat.distanceMax).toBeGreaterThan(seat.distance * 1.2);
    expect(seat.distanceMin).toBe(8);
  });
});

describe('slideLimit', () => {
  it('holds the view on the middle of the board at the seat and frees it as the player zooms in', () => {
    const seat = { distance: 24, distanceMin: 8 };
    expect(slideLimit(seat, 24)).toBe(0);
    expect(slideLimit(seat, 30)).toBe(0);
    expect(slideLimit(seat, 16)).toBeCloseTo(2.5, 6);
    expect(slideLimit(seat, 8)).toBe(5);
  });
});
