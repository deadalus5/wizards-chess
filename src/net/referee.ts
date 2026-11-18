// The rules authority for an online game: pure functions over the stored game, run by the relay
// (server/src/gameRoom.ts) on every message and unit-tested here. chess.js decides legality.
import { Chess, type Square } from 'chess.js';
import { other, type GameResult, type RejectReason, type RoomView, type Side } from './protocol';

export interface Seat {
  key: string;
  side: Side;
}

/** Everything the relay stores for one game. */
export interface Room {
  id: string;
  /** [creator, invited]. Each key keeps its seat; the sides swap on a rematch. */
  seats: [Seat, Seat];
  moves: string[];
  result: GameResult | null;
  round: number;
  rematch: Side[];
  created: number;
  updated: number;
}

export type Outcome = { ok: true; room: Room } | { ok: false; reason: RejectReason; detail?: string };

export function createRoom(id: string, creatorSide: Side, keys: [string, string], now: number): Room {
  return {
    id,
    seats: [
      { key: keys[0], side: creatorSide },
      { key: keys[1], side: other(creatorSide) },
    ],
    moves: [],
    result: null,
    round: 0,
    rematch: [],
    created: now,
    updated: now,
  };
}

/** The side a key plays in this game, or null if it is not one of the game's keys. */
export function sideOf(room: Room, key: string): Side | null {
  return room.seats.find((s) => s.key === key)?.side ?? null;
}

/** The position after `moves`, replayed from the start (so repetition is known). Throws on an illegal move. */
export function replay(moves: readonly string[]): Chess {
  const chess = new Chess();
  for (const uci of moves) {
    const m = parseUci(uci);
    if (!m) throw new Error(`bad move ${uci}`);
    chess.move(m);
  }
  return chess;
}

export function parseUci(uci: string): { from: Square; to: Square; promotion?: string } | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!m) return null;
  return { from: m[1] as Square, to: m[2] as Square, promotion: m[3] };
}

/** How the game stands after the last move, if it is over. */
export function resultOf(chess: Chess): GameResult | null {
  if (chess.isCheckmate()) return { winner: other(chess.turn()), reason: 'checkmate' };
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'repetition' };
  if (chess.isDrawByFiftyMoves()) return { winner: null, reason: 'fifty-move rule' };
  return null;
}

/**
 * `side` plays `uci` as move number `ply` (zero-based: the number of moves already made). It
 * must be that side's turn, `ply` must match (so a move made against a position that has
 * since changed is refused rather than applied to the wrong one), and chess.js must accept it.
 */
export function applyMove(room: Room, side: Side, ply: number, uci: string, now: number): Outcome {
  if (room.result) return { ok: false, reason: 'game over' };
  if (ply !== room.moves.length) return { ok: false, reason: 'stale', detail: `ply ${ply}, game at ${room.moves.length}` };
  const chess = replay(room.moves);
  if (chess.turn() !== side) return { ok: false, reason: 'not your turn' };
  const m = parseUci(uci);
  if (!m) return { ok: false, reason: 'illegal', detail: uci };
  const legal = chess.moves({ square: m.from, verbose: true }).find((x) => x.to === m.to && (x.promotion ?? undefined) === (m.promotion ?? undefined));
  if (!legal) return { ok: false, reason: 'illegal', detail: uci };
  chess.move(legal);
  return { ok: true, room: { ...room, moves: [...room.moves, uci], result: resultOf(chess), rematch: [], updated: now } };
}

export function resign(room: Room, side: Side, now: number): Outcome {
  if (room.result) return { ok: false, reason: 'game over' };
  return { ok: true, room: { ...room, result: { winner: other(side), reason: 'resignation' }, rematch: [], updated: now } };
}

/** Ask for a rematch once the game is over; when both sides have asked, a new game starts with the sides swapped. */
export function requestRematch(room: Room, side: Side, now: number): Outcome {
  if (!room.result) return { ok: false, reason: 'not over' };
  const rematch = room.rematch.includes(side) ? room.rematch : [...room.rematch, side];
  if (rematch.length < 2) return { ok: true, room: { ...room, rematch, updated: now } };
  const seats = room.seats.map((s) => ({ key: s.key, side: other(s.side) })) as [Seat, Seat];
  return { ok: true, room: { ...room, seats, moves: [], result: null, round: room.round + 1, rematch: [], updated: now } };
}

export function viewFor(room: Room, side: Side, opponentOnline: boolean): RoomView {
  return { side, moves: [...room.moves], result: room.result, round: room.round, opponentOnline, rematch: [...room.rematch] };
}
