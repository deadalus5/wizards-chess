import * as THREE from 'three';

/** Side of one board square, in metres. */
export const SQUARE = 1.25;
export const BOARD_HALF = SQUARE * 4;

export type Side = 'w' | 'b';
export const FILES = 'abcdefgh';

/** 'e4' -> [4, 3] (file, rank), both zero-based. */
export function squareToFR(square: string): [number, number] {
  return [square.charCodeAt(0) - 97, square.charCodeAt(1) - 49];
}

export function frToSquare(file: number, rank: number): string {
  return FILES[file] + String(rank + 1);
}

/**
 * Centre of a square in world space. Files run along +x; ranks run along -z, so White's
 * back rank is at +z and White looks down -z.
 */
export function squareCentre(square: string, out = new THREE.Vector3()): THREE.Vector3 {
  const [file, rank] = squareToFR(square);
  return out.set((file - 3.5) * SQUARE, 0, (3.5 - rank) * SQUARE);
}

/** The square under a point on the board plane, or null if it is off the board. */
export function squareAt(x: number, z: number): string | null {
  const file = Math.floor(x / SQUARE + 4);
  const rank = Math.floor(4 - z / SQUARE);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return frToSquare(file, rank);
}

/** Heading (rotation about +y) a piece of this side has when facing the enemy. */
export const homeYaw = (side: Side): number => (side === 'w' ? Math.PI : 0);

/** Heading that faces from one point towards another (model forward is +z). */
export function yawTowards(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export const opposite = (side: Side): Side => (side === 'w' ? 'b' : 'w');
