// Where the player's camera sits on a touch device: chosen so that the whole board is on screen
// whichever way the device is held, inside the space the interface leaves free. (The desktop
// keeps its one seat, `DESKTOP_SEAT`, and never calls `seatFor`.)
import { clamp, smoothstep } from '../core/math';
import { BOARD_HALF, SQUARE } from '../game/squares';

export interface Seat {
  /** Vertical field of view, in degrees. */
  fov: number;
  /** Angle above the board, in radians. */
  elevation: number;
  /** Metres from the middle of the board. */
  distance: number;
  /** How near and how far the player may zoom. */
  distanceMin: number;
  distanceMax: number;
  /**
   * Metres short of the board's middle that the camera aims, towards itself: it tips the view
   * down and so lifts the board on screen (negative lowers it). Centres the board between a
   * tall top bar and a short bottom margin without stepping back.
   */
  aim: number;
}

/** The seat the game has always had. */
export const DESKTOP_SEAT: Seat = { fov: 30, elevation: (44 * Math.PI) / 180, distance: 19.5, distanceMin: 8, distanceMax: 30, aim: 0 };

/** CSS pixels the interface (and the device's own furniture) takes at each edge of the screen. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Height of the point the camera orbits (the rig's target). */
const TARGET_Y = 0.3;
/** Outer edge of the board's frame. */
const FRAME = BOARD_HALF + 0.55;
/** Centre of the outer files and ranks. */
const EDGE_RANK = SQUARE * 3.5;
/** Outer side of a statue standing on the a or h file. */
const EDGE_FILE = EDGE_RANK + 0.42;
/** Top of a corner statue (a rook's turret), and of the tallest (the king's cross). */
const CORNER_HEAD = 2.25;
const CROWN = 2.65;

const MAX_FOV = 62;
const TO_RAD = Math.PI / 180;

export type SeatView = Pick<Seat, 'fov' | 'elevation' | 'distance' | 'aim'>;

/**
 * Where a point given in the board's frame lands on screen, seen from a seat behind Ivory:
 * x and y from -1 to 1 across the screen (y up).
 */
export function projectFromSeat(seat: SeatView, aspect: number, x: number, y: number, z: number): [number, number] {
  const cy = TARGET_Y + seat.distance * Math.sin(seat.elevation);
  const cz = seat.distance * Math.cos(seat.elevation);
  // Forward: from the camera to the point it aims at.
  let fy = TARGET_Y - cy;
  let fz = seat.aim - cz;
  const len = Math.hypot(fy, fz);
  fy /= len;
  fz /= len;
  const vy = y - cy;
  const vz = z - cz;
  const depth = vy * fy + vz * fz;
  const tan = Math.tan((seat.fov * TO_RAD) / 2);
  // Up on screen is (0, -fz, fy); right is +x.
  return [x / (depth * tan * aspect), (vy * -fz + vz * fy) / (depth * tan)];
}

/** How much of the available half-width the board and its corner statues need (1 = exactly fits). */
function widthNeeded(seat: SeatView, aspect: number, limit: number): number {
  const frame = projectFromSeat(seat, aspect, FRAME, 0, FRAME)[0] / 0.96;
  const head = projectFromSeat(seat, aspect, EDGE_FILE, CORNER_HEAD, EDGE_RANK)[0] / 0.94;
  return Math.max(frame, head) / limit;
}

/** Bottom and top of the board on screen: the near edge of its frame and the far rank's crowns. */
function heightUsed(seat: SeatView, aspect: number): [number, number] {
  return [projectFromSeat(seat, aspect, 0, 0, FRAME)[1], projectFromSeat(seat, aspect, 0, CROWN, -EDGE_RANK)[1]];
}

/** Smallest value in [lo, hi] at which `ok` holds, given that it holds at `hi` and from there up. */
function least(lo: number, hi: number, ok: (v: number) => boolean): number {
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The seat for a screen of `width` x `height` CSS pixels whose edges are taken up by `insets`.
 * A wide screen gets the lens, height and distance of the desktop seat; a narrow one a wider
 * lens and a higher seat, since stepping back far enough to fit the board would put it deep in
 * the hall's fog.
 */
export function seatFor(width: number, height: number, insets: Insets): Seat {
  const aspect = width / height;
  const wide = smoothstep(0.5, 1.3, aspect);
  const seat: Seat = { fov: DESKTOP_SEAT.fov, elevation: (54 - 10 * wide) * TO_RAD, distance: 23 - 3.5 * wide, distanceMin: DESKTOP_SEAT.distanceMin, distanceMax: DESKTOP_SEAT.distanceMax, aim: 0 };
  const limitX = Math.max(0.2, 1 - (2 * Math.max(insets.left, insets.right)) / width);
  const yLo = -1 + (2 * insets.bottom) / height;
  const yHi = 1 - (2 * insets.top) / height;

  const fitsWidth = (): boolean => widthNeeded(seat, aspect, limitX) <= 1;
  /** The aim that puts the board midway between the top and bottom of the free space. */
  const centred = (distance: number): number => {
    const trial: SeatView = { ...seat, distance };
    let lo = -6;
    let hi = 6;
    for (let i = 0; i < 40; i++) {
      trial.aim = (lo + hi) / 2;
      const [bottom, top] = heightUsed(trial, aspect);
      // Aiming nearer tips the camera down, which raises everything on screen.
      if ((bottom + top) / 2 < (yLo + yHi) / 2) lo = trial.aim;
      else hi = trial.aim;
    }
    return (lo + hi) / 2;
  };
  const fitsHeight = (distance: number, aim: number): boolean => {
    const [bottom, top] = heightUsed({ ...seat, distance, aim }, aspect);
    return bottom >= yLo - 1e-4 && top <= yHi + 1e-4;
  };

  // Width and height each move the other a little (the aim changes every depth), so settle them twice.
  for (let pass = 0; pass < 2; pass++) {
    if (!fitsWidth()) {
      const base = seat.fov;
      seat.fov = MAX_FOV;
      if (fitsWidth()) seat.fov = least(base, MAX_FOV, (fov) => widthNeeded({ ...seat, fov }, aspect, limitX) <= 1);
      else seat.distance = least(seat.distance, 120, (distance) => widthNeeded({ ...seat, distance }, aspect, limitX) <= 1);
    }
    if (!fitsHeight(seat.distance, seat.aim)) {
      if (!fitsHeight(seat.distance, centred(seat.distance))) seat.distance = least(seat.distance, 120, (distance) => fitsHeight(distance, centred(distance)));
      seat.aim = centred(seat.distance);
    }
  }
  seat.distanceMax = Math.max(DESKTOP_SEAT.distanceMax, seat.distance * 1.3);
  return seat;
}

/**
 * How far from the middle of the board the player may slide the view, in metres, at a zoom
 * distance: nothing from the seat itself (the whole board is in view there), the whole board
 * when zoomed right in.
 */
export function slideLimit(seat: Pick<Seat, 'distance' | 'distanceMin'>, distance: number): number {
  const zoomed = clamp((seat.distance - distance) / Math.max(1e-6, seat.distance - seat.distanceMin), 0, 1);
  return BOARD_HALF * zoomed;
}
