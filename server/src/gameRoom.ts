// One online game: its stored state and the players' sockets. Uses the WebSocket Hibernation
// API, so an idle game costs nothing while both players keep a socket open for days.
import { DurableObject } from 'cloudflare:workers';
import { PING, PONG, STALE_MS, validKey, type ClientMessage, type ServerMessage, type Side } from '../../src/net/protocol';
import { applyMove, createRoom, requestRematch, resign, sideOf, viewFor, type Outcome, type Room } from '../../src/net/referee';

export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
}

/** A game nobody has touched for this long is deleted. */
const EXPIRES_MS = 120 * 24 * 3600 * 1000;

/** What each socket remembers across hibernation: the key it said hello with, and when it last spoke. */
interface Attachment {
  key: string;
  at: number;
}

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private async load(): Promise<Room | null> {
    return (await this.ctx.storage.get<Room>('room')) ?? null;
  }

  private async save(room: Room): Promise<void> {
    await this.ctx.storage.put('room', room);
    await this.ctx.storage.setAlarm(room.updated + EXPIRES_MS);
  }

  async create(id: string, side: Side, keys: [string, string]): Promise<boolean> {
    if (await this.load()) return false;
    await this.save(createRoom(id, side, keys, Date.now()));
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as ClientMessage;
    } catch {
      return send(ws, { t: 'rejected', reason: 'bad message' });
    }
    const room = await this.load();
    if (!room) {
      send(ws, { t: 'rejected', reason: 'no such game' });
      return ws.close(4004, 'no such game');
    }
    const now = Date.now();
    const known = ws.deserializeAttachment() as Attachment | null;
    if (known) ws.serializeAttachment({ key: known.key, at: now } satisfies Attachment);

    if (msg.t === 'hello') {
      if (typeof msg.key !== 'string' || !validKey(msg.key) || !sideOf(room, msg.key)) {
        send(ws, { t: 'rejected', reason: 'bad key' });
        return ws.close(4003, 'bad key');
      }
      ws.serializeAttachment({ key: msg.key, at: now } satisfies Attachment);
      // Everyone hears that this player is here.
      return this.broadcast(room);
    }

    // Anything else needs a hello first; the side is looked up afresh (a rematch swaps them).
    const side = known ? sideOf(room, known.key) : null;
    if (!side) {
      send(ws, { t: 'rejected', reason: 'bad key' });
      return ws.close(4003, 'hello first');
    }
    // Still here: the game as it stands, with the opponent's presence as it is now.
    if (msg.t === 'sync') return this.sendState(ws, room);
    let outcome: Outcome;
    switch (msg.t) {
      case 'move':
        outcome = typeof msg.uci === 'string' && Number.isInteger(msg.ply) ? applyMove(room, side, msg.ply, msg.uci, now) : { ok: false, reason: 'bad message' };
        break;
      case 'resign':
        outcome = resign(room, side, now);
        break;
      case 'rematch':
        outcome = requestRematch(room, side, now);
        break;
      default:
        outcome = { ok: false, reason: 'bad message' };
    }
    if (!outcome.ok) {
      send(ws, { t: 'rejected', reason: outcome.reason, detail: outcome.detail });
      // And the state as it stands, so the client can put itself right.
      return this.sendState(ws, room);
    }
    await this.save(outcome.room);
    this.broadcast(outcome.room);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
    const room = await this.load();
    if (room) this.broadcast(room, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }

  async alarm(): Promise<void> {
    const room = await this.load();
    if (!room) return;
    if (Date.now() - room.updated >= EXPIRES_MS) {
      for (const ws of this.ctx.getWebSockets()) ws.close(4004, 'expired');
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(room.updated + EXPIRES_MS);
    }
  }

  /**
   * Sockets that have said hello, are open and have been heard from lately, with the key each
   * uses. A socket can stay open with nobody behind it (a laptop asleep, a network that went
   * away without a word): one silent for `STALE_MS` is closed and no longer counts.
   */
  private players(except?: WebSocket): { ws: WebSocket; key: string }[] {
    const out: { ws: WebSocket; key: string }[] = [];
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.key) continue;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(a.at ?? 0, pinged) > STALE_MS) {
        try {
          ws.close(4002, 'silent too long');
        } catch {
          /* already gone */
        }
        continue;
      }
      out.push({ ws, key: a.key });
    }
    return out;
  }

  private sendState(ws: WebSocket, room: Room, except?: WebSocket): void {
    const key = (ws.deserializeAttachment() as Attachment | null)?.key;
    const side = key ? sideOf(room, key) : null;
    if (!key || !side) return;
    const opponentOnline = this.players(except).some((p) => p.key !== key);
    send(ws, { t: 'state', ...viewFor(room, side, opponentOnline) });
  }

  /** Each player gets the game from their own side. */
  private broadcast(room: Room, except?: WebSocket): void {
    for (const p of this.players(except)) this.sendState(p.ws, room, except);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* closed under us: the close handler tells the other player */
  }
}
