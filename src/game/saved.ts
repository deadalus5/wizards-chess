// A game in progress on this device, kept so that it survives the page being reloaded: a phone
// throws a page away whenever it wants the memory, and brings it back as if new. Only a game
// against the computer or passed between two players; an online game lives on the relay, and
// one the computer plays against itself is not anyone's to lose. Pure: the storage is mobile.ts's.
import type { Side } from './squares';

export type SavedMode = 'pass' | 'computer';

export interface SavedGame {
  v: 1;
  mode: SavedMode;
  /** The side the player has against the computer. */
  side: Side;
  /** The moves from the starting position, in coordinate notation. */
  moves: string[];
  /** When it was saved, in milliseconds since the epoch. */
  at: number;
}

export const SAVED_KEY = 'stonewake.game';
/** A game left this long is not taken up again. */
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export function encodeSaved(mode: SavedMode, side: Side, moves: readonly string[], now: number): string {
  const game: SavedGame = { v: 1, mode, side, moves: [...moves], at: now };
  return JSON.stringify(game);
}

/** The game a stored string holds, or null if it holds none worth taking up. */
export function decodeSaved(text: string | null, now: number): SavedGame | null {
  if (!text) return null;
  let g: Partial<SavedGame>;
  try {
    g = JSON.parse(text) as Partial<SavedGame>;
  } catch {
    return null;
  }
  if (!g || g.v !== 1) return null;
  if (g.mode !== 'pass' && g.mode !== 'computer') return null;
  if (g.side !== 'w' && g.side !== 'b') return null;
  if (!Array.isArray(g.moves) || g.moves.length === 0 || g.moves.length > 1200 || !g.moves.every((m) => typeof m === 'string' && MOVE.test(m))) return null;
  if (typeof g.at !== 'number' || now - g.at > KEEP_MS || g.at > now + 60000) return null;
  return { v: 1, mode: g.mode, side: g.side, moves: g.moves, at: g.at };
}

/**
 * Whether a saved game is the one to put back on the board, given how the player has the game
 * set now: the same kind of game, and against the computer the same side.
 */
export function shouldRestore(saved: SavedGame | null, mode: string, side: Side): saved is SavedGame {
  if (!saved || saved.mode !== mode) return false;
  return mode !== 'computer' || saved.side === side;
}
