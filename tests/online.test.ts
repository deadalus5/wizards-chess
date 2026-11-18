import { describe, expect, it } from 'vitest';
import { undoPlies } from '../src/ai/opponent';
import { formatLink, parseLink, randomToken, turnAfter } from '../src/net/protocol';
import { applyMove, createRoom, replay, requestRematch, resign, sideOf, viewFor, type Room } from '../src/net/referee';
import { gameStatus, syncPlan, type SyncContext } from '../src/net/sync';

const KEYS: [string, string] = ['creatorKey_0123456789ab', 'inviteKey_0123456789abc'];
const T = 1_700_000_000_000;

/** Play moves alternately, each by the side whose turn it is; fails the test on a refusal. */
function play(room: Room, moves: string[]): Room {
  for (const uci of moves) {
    const r = applyMove(room, turnAfter(room.moves.length), room.moves.length, uci, T);
    if (!r.ok) throw new Error(`${uci}: ${r.reason}`);
    room = r.room;
  }
  return room;
}

describe('game links', () => {
  it('round-trips an id and key through the hash', () => {
    const link = { id: randomToken(9), key: randomToken(16) };
    expect(link.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(link.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const url = formatLink('https://example.org/wizards-chess/?dev#old', link);
    expect(url).toBe(`https://example.org/wizards-chess/#play=${link.id}.${link.key}`);
    expect(parseLink(new URL(url).hash)).toEqual(link);
  });
  it('rejects hashes that are not game links', () => {
    expect(parseLink('')).toBeNull();
    expect(parseLink('#play=short.key')).toBeNull();
    expect(parseLink('#play=abcdefghij')).toBeNull();
    expect(parseLink('#play=abcdefghij.<script>alert(1)</script>')).toBeNull();
  });
  it('gives fresh tokens each time', () => {
    expect(new Set(Array.from({ length: 50 }, () => randomToken(16))).size).toBe(50);
  });
});

describe('the referee', () => {
  const fresh = (side: 'w' | 'b' = 'w') => createRoom('game12345678', side, KEYS, T);

  it('seats the creator on the chosen side and the invite on the other', () => {
    expect(sideOf(fresh('w'), KEYS[0])).toBe('w');
    expect(sideOf(fresh('w'), KEYS[1])).toBe('b');
    expect(sideOf(fresh('b'), KEYS[0])).toBe('b');
    expect(sideOf(fresh(), 'someoneElse_0123456789')).toBeNull();
  });
  it('accepts a legal move on your turn at the right ply', () => {
    const r = applyMove(fresh(), 'w', 0, 'e2e4', T + 5);
    expect(r.ok && r.room.moves).toEqual(['e2e4']);
    expect(r.ok && r.room.updated).toBe(T + 5);
  });
  it('refuses the wrong side, a stale ply, an illegal move and nonsense', () => {
    expect(applyMove(fresh(), 'b', 0, 'e7e5', T)).toMatchObject({ ok: false, reason: 'not your turn' });
    expect(applyMove(fresh(), 'w', 1, 'e2e4', T)).toMatchObject({ ok: false, reason: 'stale' });
    expect(applyMove(fresh(), 'w', 0, 'e2e5', T)).toMatchObject({ ok: false, reason: 'illegal' });
    expect(applyMove(fresh(), 'w', 0, 'e2e4q', T)).toMatchObject({ ok: false, reason: 'illegal' });
    expect(applyMove(fresh(), 'w', 0, 'hello', T)).toMatchObject({ ok: false, reason: 'illegal' });
  });
  it('does not apply the same move twice', () => {
    const room = play(fresh(), ['e2e4']);
    expect(applyMove(room, 'w', 0, 'e2e4', T)).toMatchObject({ ok: false, reason: 'stale' });
  });
  it('needs the promotion piece, and takes it', () => {
    let room = fresh();
    room = { ...room, moves: [] };
    // A pawn walks to the eighth rank: a2a4 ... a7 takes b8 knight.
    room = play(room, ['a2a4', 'h7h6', 'a4a5', 'h6h5', 'a5a6', 'h5h4', 'a6b7', 'h4h3']);
    expect(applyMove(room, 'w', 8, 'b7a8', T)).toMatchObject({ ok: false, reason: 'illegal' });
    const r = applyMove(room, 'w', 8, 'b7a8n', T);
    expect(r.ok).toBe(true);
    expect(r.ok && replay(r.room.moves).get('a8')).toEqual({ type: 'n', color: 'w' });
  });
  it('ends the game at mate and refuses moves after it', () => {
    const room = play(fresh(), ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(room.result).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(applyMove(room, 'w', 4, 'a2a3', T)).toMatchObject({ ok: false, reason: 'game over' });
  });
  it('knows a draw by repetition', () => {
    const room = play(fresh(), ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
    expect(room.result).toEqual({ winner: null, reason: 'repetition' });
  });
  it('gives the game to the other side on resignation, once', () => {
    const r = resign(play(fresh(), ['e2e4']), 'b', T);
    expect(r.ok && r.room.result).toEqual({ winner: 'w', reason: 'resignation' });
    expect(r.ok && resign(r.room, 'w', T)).toMatchObject({ ok: false, reason: 'game over' });
  });
  it('starts a rematch only when both ask, with the sides swapped and the keys kept', () => {
    const over = play(fresh('w'), ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(requestRematch(fresh(), 'w', T)).toMatchObject({ ok: false, reason: 'not over' });
    const one = requestRematch(over, 'b', T);
    expect(one.ok && one.room.rematch).toEqual(['b']);
    expect(one.ok && one.room.moves.length).toBe(4);
    const again = one.ok ? requestRematch(one.room, 'b', T) : one;
    expect(again.ok && again.room.rematch).toEqual(['b']);
    const both = one.ok ? requestRematch(one.room, 'w', T) : one;
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.room.round).toBe(1);
    expect(both.room.moves).toEqual([]);
    expect(both.room.result).toBeNull();
    expect(sideOf(both.room, KEYS[0])).toBe('b');
    expect(sideOf(both.room, KEYS[1])).toBe('w');
  });
  it('shows each player the game from their own side', () => {
    const room = play(fresh('b'), ['e2e4']);
    expect(viewFor(room, 'b', true)).toEqual({ side: 'b', moves: ['e2e4'], result: null, round: 0, opponentOnline: true, rematch: [] });
  });
});

describe('bringing the board into line with the relay', () => {
  const ctx = (o: Partial<SyncContext> = {}): SyncContext => ({ first: false, side: 'w', seen: 0, inFlight: null, ...o });

  it('replays the opponent\'s move missed while away, on opening the link', () => {
    expect(syncPlan([], ['e2e4', 'e7e5'], ctx({ first: true, side: 'w', seen: 1 }))).toEqual({ kind: 'load', moves: ['e2e4'], then: 'e7e5' });
  });
  it('does not replay what this browser has seen, or our own last move', () => {
    expect(syncPlan([], ['e2e4', 'e7e5'], ctx({ first: true, side: 'w', seen: 2 }))).toEqual({ kind: 'load', moves: ['e2e4', 'e7e5'] });
    expect(syncPlan([], ['e2e4'], ctx({ first: true, side: 'w', seen: 0 }))).toEqual({ kind: 'load', moves: ['e2e4'] });
  });
  it('does nothing for an empty game', () => {
    expect(syncPlan([], [], ctx({ first: true }))).toEqual({ kind: 'none' });
  });
  it('plays a move that arrives live', () => {
    expect(syncPlan(['e2e4'], ['e2e4', 'e7e5'], ctx())).toEqual({ kind: 'play', uci: 'e7e5' });
  });
  it('waits while our own move is in flight, but not for a move the relay never had', () => {
    expect(syncPlan(['e2e4', 'e7e5'], ['e2e4'], ctx({ side: 'b', inFlight: { ply: 1, uci: 'e7e5' } }))).toEqual({ kind: 'wait' });
    expect(syncPlan(['e2e4', 'e7e5'], ['e2e4'], ctx({ side: 'b' }))).toEqual({ kind: 'load', moves: ['e2e4'] });
  });
  it('takes the relay\'s game when the two disagree, or after a rematch', () => {
    expect(syncPlan(['e2e4', 'e7e5'], ['e2e4', 'c7c5'], ctx())).toEqual({ kind: 'load', moves: ['e2e4', 'c7c5'] });
    expect(syncPlan(['f2f3', 'e7e5', 'g2g4', 'd8h4'], [], ctx())).toEqual({ kind: 'load', moves: [] });
    expect(syncPlan(['e2e4'], ['e2e4', 'e7e5', 'g1f3'], ctx())).toEqual({ kind: 'load', moves: ['e2e4', 'e7e5', 'g1f3'] });
  });
  it('is idle when in step', () => {
    expect(syncPlan(['e2e4'], ['e2e4'], ctx())).toEqual({ kind: 'none' });
  });
});

describe('online odds and ends', () => {
  it('has no undo online', () => {
    expect(undoPlies('online', 'w', 'w', 6)).toBe(0);
    expect(undoPlies('online', 'b', 'w', 3)).toBe(0);
  });
  it('says how a game stands for each player', () => {
    expect(gameStatus({ side: 'w', moves: [], result: null })).toBe('your move');
    expect(gameStatus({ side: 'b', moves: [], result: null })).toBe('their move');
    expect(gameStatus({ side: 'b', moves: ['e2e4'], result: null })).toBe('your move');
    expect(gameStatus({ side: 'b', moves: [], result: { winner: 'b', reason: 'resignation' } })).toBe('won');
    expect(gameStatus({ side: 'w', moves: [], result: { winner: 'b', reason: 'checkmate' } })).toBe('lost');
    expect(gameStatus({ side: 'w', moves: [], result: { winner: null, reason: 'stalemate' } })).toBe('drawn');
  });
});
