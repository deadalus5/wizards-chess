// What a finger meant. A mouse click takes the first statue under the pointer (the picker's
// `squareAt`); a fingertip covers several squares and cannot aim round a tall statue, so a tap
// is read along its whole line of sight and with a little forgiveness. Pure: the picker gathers
// what the line passes through, the controller says what is playable.

/** One thing the tap's line of sight passes through. */
export interface RayHit {
  square: string;
  /** A statue (its picking cylinder) rather than the bare board. */
  statue: boolean;
  /** For a statue: how far from its axis the line passes, 0 through the middle, 1 at the edge. */
  offAxis: number;
}

export interface TapContext {
  /** A square the selected piece may move to. */
  isTarget(square: string): boolean;
  /** A square holding a piece the player may pick up now. */
  isOwn(square: string): boolean;
  /** Every playable square near the tap, with its distance from it on screen in pixels. */
  nearby(): { square: string; distance: number }[];
}

/** A tap that hits nothing playable is given to a playable square this close, if only one is. */
export const SNAP_PX = 24;
/** Beyond this share of a statue's radius the line only grazes it. */
const GRAZE = 0.6;

/**
 * The square a tap is for, or whatever lies first under it when nothing playable does (which
 * clears the selection, as a click on nothing does). `hits` are nearest first.
 */
export function resolveTap(hits: readonly RayHit[], ctx: TapContext): string | null {
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (ctx.isTarget(hit.square)) return hit.square;
    if (!ctx.isOwn(hit.square)) continue;
    // Square on, a statue of one's own is what was meant. Clipped at its edge, with a legal
    // square showing behind it, the square was.
    if (hit.statue && hit.offAxis > GRAZE && hits.slice(i + 1).some((later) => ctx.isTarget(later.square))) continue;
    return hit.square;
  }

  const near = ctx
    .nearby()
    .filter((n) => n.distance <= SNAP_PX)
    .sort((x, y) => x.distance - y.distance);
  // Only when there is no doubt which: a move made by mistake cannot always be taken back.
  if (near.length === 1 || (near.length > 1 && near[0].distance < near[1].distance * 0.6)) return near[0].square;
  return hits[0]?.square ?? null;
}
