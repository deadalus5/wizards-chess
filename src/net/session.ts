// One online game as seen from this browser: the socket to the relay, and keeping the board
// in line with the relay's copy. Moves arrive as full states; `syncPlan` decides whether to
// play the newest one out (with its cinematic), wait, or set the position up afresh.
import type { ChessGame } from '../chess/game';
import type { GameController } from '../game/controller';
import { socketUrl } from './config';
import { markSeen, seenPlies } from './myGames';
import { PONG, SYNC_EVERY_MS, turnAfter, type ClientMessage, type GameLink, type RejectReason, type RoomView, type ServerMessage, type Side } from './protocol';
import { syncPlan, type SyncStep } from './sync';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'gone';

export interface SessionDeps {
  controller: GameController;
  game: ChessGame;
  /** Resolves once the player can watch (the title screen is gone): moves are not played out before. */
  ready: Promise<void>;
  /** Something the interface shows changed: connection, side, opponent, result, rematch. */
  changed(session: OnlineSession): void;
  /** The opponent has just made a move (for the tab-title alert). */
  opponentMoved(session: OnlineSession): void;
  /** The relay refused something; `fatal` when the link itself is no good. */
  refused(reason: RejectReason, fatal: boolean): void;
}

/** If a sync goes unanswered this long, the line is taken to be dead and reopened. */
const ANSWER_WITHIN_MS = 10_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
/** The pause before a move missed while away is played out, after the board appears. */
const REPLAY_PAUSE_MS = 1500;

export class OnlineSession {
  connection: Connection = 'connecting';
  /** The relay's latest state, or null before the first. */
  view: RoomView | null = null;
  /** Every step taken, newest last (debugging). */
  readonly log: string[] = [];

  private ws: WebSocket | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private first = true;
  private isReady = false;
  private closed = false;
  private inFlight: { ply: number; uci: string } | null = null;
  /** A missed move is replayed no sooner than this (performance.now() ms): a moment to look first. */
  private replayAt = 0;
  private lastPlies = -1;
  private lastRound = -1;
  private readonly unhook: (() => void)[];
  private readonly onWake = (): void => {
    this.reconnectSoon(true);
  };

  constructor(
    readonly link: GameLink,
    private readonly d: SessionDeps,
  ) {
    this.unhook = [
      d.controller.onSettled(() => this.reconcile()),
      d.controller.onMove((event, ply) => this.localMove(ply, `${event.from}${event.to}${event.promotion ?? ''}`, event.color as Side)),
    ];
    d.ready.then(() => {
      this.isReady = true;
      // The camera may still be coming round from the title: let it arrive.
      this.replayAt = Math.max(this.replayAt, performance.now() + REPLAY_PAUSE_MS);
      this.reconcile();
    });
    addEventListener('online', this.onWake);
    document.addEventListener('visibilitychange', this.onWake);
    this.connect();
  }

  /** The side this link plays (null until the relay has said). */
  get side(): Side | null {
    return this.view?.side ?? null;
  }

  /** Whether clicks may move this player's pieces now. */
  get canMove(): boolean {
    return this.connection === 'live' && !!this.view && !this.view.result && !this.inFlight && this.inStep();
  }

  /** Whether the board shows exactly the relay's game. */
  private inStep(): boolean {
    if (!this.view) return false;
    const local = this.d.game.historyUci();
    return local.length === this.view.moves.length && local.every((m, i) => m === this.view!.moves[i]);
  }

  resign(): void {
    this.send({ t: 'resign' });
  }

  rematch(): void {
    this.send({ t: 'rematch' });
  }

  /** Leave for good (the game stays on the relay). */
  close(): void {
    this.closed = true;
    this.connection = 'gone';
    for (const off of this.unhook) off();
    removeEventListener('online', this.onWake);
    document.removeEventListener('visibilitychange', this.onWake);
    this.stopTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'left');
    this.ws = null;
  }

  /** Drop the socket as a network fault would (tests): it reconnects by itself. */
  drop(): void {
    this.ws?.close(4000, 'dropped by test');
  }

  private note(s: string): void {
    this.log.push(`${new Date().toISOString().slice(11, 23)} ${s}`);
    if (this.log.length > 200) this.log.shift();
  }

  private connect(): void {
    if (this.closed) return;
    this.note('connect');
    const ws = new WebSocket(socketUrl(this.link.id));
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.send({ t: 'hello', key: this.link.key });
      this.pingTimer = setInterval(() => this.ping(), SYNC_EVERY_MS);
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      if (e.data === PONG) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'state') this.onState(msg);
      else if (msg.t === 'rejected') this.onRejected(msg.reason, msg.detail);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.stopTimers();
      if (this.closed || this.connection === 'gone') return;
      this.connection = 'reconnecting';
      this.d.changed(this);
      this.reconnectSoon(false);
    };
  }

  private ping(): void {
    if (!this.send({ t: 'sync' })) return;
    if (!this.pongTimer) this.pongTimer = setTimeout(() => this.ws?.close(4001, 'no answer'), ANSWER_WITHIN_MS);
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
  }

  private reconnectSoon(now: boolean): void {
    if (this.closed || this.connection === 'gone' || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const wait = now ? 0 : BACKOFF_MS[Math.min(this.retries, BACKOFF_MS.length - 1)];
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private onState(view: RoomView): void {
    const was = this.view;
    this.view = view;
    this.connection = 'live';
    this.retries = 0;
    this.note(`state r${view.round} ${view.side} ${view.moves.length} plies${view.result ? ` ${view.result.reason}` : ''}${view.opponentOnline ? '' : ' (opponent away)'}`);
    // Our move made it (or a fresh state shows it did not and we will be put right).
    if (this.inFlight && (view.moves.length > this.inFlight.ply || view.round !== was?.round)) this.inFlight = null;
    // A move we sent while the line was down: send it again (the relay refuses it if it is stale).
    if (this.inFlight && view.moves.length === this.inFlight.ply) this.send({ t: 'move', ...this.inFlight });
    // A new move by the other side, in the round this browser was already following.
    const n = view.moves.length;
    const theirs = n > 0 && n !== this.lastPlies && view.round === this.lastRound && turnAfter(n - 1) !== view.side;
    this.lastPlies = view.moves.length;
    this.lastRound = view.round;
    if (theirs && !this.first) this.d.opponentMoved(this);
    // The interface first (the seat, so the camera is behind this player before anything plays).
    this.d.changed(this);
    this.reconcile();
  }

  private onRejected(reason: RejectReason, detail?: string): void {
    this.note(`rejected: ${reason}${detail ? ` (${detail})` : ''}`);
    const fatal = reason === 'bad key' || reason === 'no such game';
    if (fatal) {
      this.connection = 'gone';
      this.close();
    }
    // A refused move: forget it; the state that follows puts the board right.
    if (reason !== 'not over') this.inFlight = null;
    this.d.refused(reason, fatal);
    this.d.changed(this);
  }

  /** A move was made on the board. If it is ours and the relay does not have it yet, send it. */
  private localMove(ply: number, uci: string, color: Side): void {
    const view = this.view;
    if (!view || color !== view.side || ply < view.moves.length) return;
    this.inFlight = { ply, uci };
    this.note(`send ${uci} as ply ${ply}`);
    // If the line is down, the move goes when it comes back (see onState).
    this.send({ t: 'move', uci, ply });
    this.d.changed(this);
  }

  /** Bring the board into line with the relay's state, one step at a time. */
  private reconcile(): void {
    const view = this.view;
    const { controller, game } = this.d;
    if (!view || this.closed || controller.isBusy) return;
    const step: SyncStep = syncPlan(game.historyUci(), view.moves, {
      first: this.first,
      side: view.side,
      seen: seenPlies(this.link.id, view.round),
      inFlight: this.inFlight,
    });
    this.first = false;
    switch (step.kind) {
      case 'none':
        markSeen(this.link.id, view.round, view.moves.length);
        this.applyResult(view);
        break;
      case 'wait':
        break;
      case 'play': {
        // Moves are only played out where someone can see them; until then the board waits.
        if (!this.isReady) return;
        const wait = this.replayAt - performance.now();
        if (wait > 0) {
          setTimeout(() => this.reconcile(), wait + 10);
          return;
        }
        this.note(`play ${step.uci}`);
        controller.playUci(step.uci).catch((err) => {
          console.error(err);
          this.resync();
        });
        break;
      }
      case 'load':
        if (step.then) this.replayAt = Math.max(this.replayAt, performance.now() + REPLAY_PAUSE_MS);
        this.note(`load ${step.moves.length} plies${step.then ? `, then play ${step.then}` : ''}`);
        try {
          // loadMoves settles, which runs reconcile again: with `then`, that plays the last move.
          controller.loadMoves(step.moves);
        } catch (err) {
          console.error(err);
          controller.loadMoves([]);
        }
        break;
    }
    this.d.changed(this);
  }

  /** Something went wrong: take the relay's game as it stands. */
  private resync(): void {
    if (!this.view || this.d.controller.isBusy) return;
    this.d.controller.loadMoves(this.view.moves);
  }

  /** A resignation is not something chess.js can see; show it once the board has the game. */
  private applyResult(view: RoomView): void {
    const r = view.result;
    if (r?.reason === 'resignation' && r.winner && !this.d.game.status().resigned) {
      this.d.controller.resign(r.winner === 'w' ? 'b' : 'w');
    }
  }
}
