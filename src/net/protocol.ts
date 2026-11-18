// Online play: what travels between the browser and the relay (server/), and the shape of a
// game link. Shared by both ends; nothing here touches the DOM or the Workers runtime.

export type Side = 'w' | 'b';

/** How a game ended. `winner` is null for a draw. */
export interface GameResult {
  winner: Side | null;
  reason: 'checkmate' | 'resignation' | 'stalemate' | 'repetition' | 'insufficient material' | 'fifty-move rule';
}

/** One player's view of a game, as the relay sends it. */
export interface RoomView {
  /** The side this link plays (it swaps on a rematch). */
  side: Side;
  /** Every move so far in coordinate notation (`e2e4`, `e7e8q`). */
  moves: string[];
  result: GameResult | null;
  /** 0 for the first game on these links, +1 per rematch. */
  round: number;
  opponentOnline: boolean;
  /** Sides that have asked for a rematch since the game ended. */
  rematch: Side[];
}

export type ClientMessage =
  | { t: 'hello'; key: string }
  | { t: 'move'; uci: string; ply: number }
  | { t: 'resign' }
  | { t: 'rematch' }
  /** "I am still here; how does the game stand?" Sent every half minute: it keeps presence true. */
  | { t: 'sync' };

export type RejectReason = 'no such game' | 'bad key' | 'not your turn' | 'stale' | 'illegal' | 'game over' | 'not over' | 'bad message';

export type ServerMessage = ({ t: 'state' } & RoomView) | { t: 'rejected'; reason: RejectReason; detail?: string };

/** Plain-text keep-alive the relay answers without waking the game (older clients; tests). */
export const PING = 'ping';
export const PONG = 'pong';

/** A socket not heard from for this long no longer counts as the player being present. */
export const STALE_MS = 75_000;
/** How often a client says it is still there. */
export const SYNC_EVERY_MS = 30_000;

export interface CreateRequest {
  side: Side | 'random';
}
export interface CreateResponse {
  id: string;
  /** The creator's key. */
  key: string;
  /** The key for the link the creator shares. */
  inviteKey: string;
  /** The creator's side (resolved if `random` was asked for). */
  side: Side;
}

const ID = /^[A-Za-z0-9_-]{8,32}$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

export function validId(id: string): boolean {
  return ID.test(id);
}
export function validKey(key: string): boolean {
  return KEY.test(key);
}

/** A game link: `#play=<id>.<key>` after the page address. The key decides which side it plays. */
export interface GameLink {
  id: string;
  key: string;
}

/** The game a location hash names, or null. */
export function parseLink(hash: string): GameLink | null {
  const m = /(?:^#|&)play=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(hash);
  if (!m || !validId(m[1]) || !validKey(m[2])) return null;
  return { id: m[1], key: m[2] };
}

/** The full link for a seat, on the page `base` (any hash or query on it is dropped). */
export function formatLink(base: string, link: GameLink): string {
  const page = base.split('#')[0].split('?')[0];
  return `${page}#play=${link.id}.${link.key}`;
}

/** Random URL-safe text with `bytes` bytes of entropy (16 bytes gives 22 characters). */
export function randomToken(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function other(side: Side): Side {
  return side === 'w' ? 'b' : 'w';
}

/** Which side is to move after `plies` moves from the start. */
export function turnAfter(plies: number): Side {
  return plies % 2 === 0 ? 'w' : 'b';
}
