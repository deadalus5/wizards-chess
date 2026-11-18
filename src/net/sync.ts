// How a browser brings its board into line with the relay's copy of an online game. Pure, so
// every case is unit-tested (tests/online.test.ts).
import { turnAfter, type RoomView, type Side } from './protocol';

/** How a game stands for this player, in a few words (the MY GAMES list). */
export function gameStatus(view: Pick<RoomView, 'result' | 'side' | 'moves'>): string {
  const r = view.result;
  if (r) return r.winner === null ? 'drawn' : r.winner === view.side ? 'won' : 'lost';
  return turnAfter(view.moves.length) === view.side ? 'your move' : 'their move';
}

export type SyncStep =
  /** Nothing to do: the board already shows the game. */
  | { kind: 'none' }
  /** Our own move is on its way to the relay: leave the board alone until it answers. */
  | { kind: 'wait' }
  /** One move behind: play it out, cinematic and all. */
  | { kind: 'play'; uci: string }
  /** Set the position up at once; then, if `then` is given, play that move out. */
  | { kind: 'load'; moves: string[]; then?: string };

export interface SyncContext {
  /** True for the first state after opening the link (the board shows nothing of this game yet). */
  first: boolean;
  /** The side this browser plays. */
  side: Side;
  /** How many moves of this round this browser has already shown (from storage; 0 if none). */
  seen: number;
  /** A move of ours sent to the relay and not yet acknowledged, if any. */
  inFlight: { ply: number; uci: string } | null;
}

function startsWith(a: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= a.length && prefix.every((m, i) => a[i] === m);
}

export function syncPlan(local: readonly string[], server: readonly string[], ctx: SyncContext): SyncStep {
  const n = server.length;
  if (ctx.first) {
    // Opening the link: if the opponent has moved since this browser last looked, set up the
    // position before that move and play it, so the player sees what was done.
    const missed = n > 0 && turnAfter(n - 1) !== ctx.side && ctx.seen < n;
    if (missed) return { kind: 'load', moves: server.slice(0, n - 1), then: server[n - 1] };
    if (local.length === n && startsWith(local, server)) return { kind: 'none' };
    return { kind: 'load', moves: [...server] };
  }
  if (local.length === n && startsWith(local, server)) return { kind: 'none' };
  // One move behind (the opponent's move, or ours made in another tab).
  if (n === local.length + 1 && startsWith(server, local)) return { kind: 'play', uci: server[n - 1] };
  // One move ahead with our own move still in flight.
  if (local.length === n + 1 && startsWith(local, server) && ctx.inFlight && ctx.inFlight.ply === n && ctx.inFlight.uci === local[n]) return { kind: 'wait' };
  // Anything else (a refused move, a rematch, a long absence in another tab): the relay is right.
  return { kind: 'load', moves: [...server] };
}
