// Stonewake online relay. Two routes:
//   POST /games            {side: 'w'|'b'|'random'} -> {id, key, inviteKey, side}
//   GET  /games/<id>/ws    WebSocket to that game (the first message must be {t:'hello', key})
// Players have no accounts: a game's two keys, carried in its links, are the only identity.
import { randomToken, validId, type CreateRequest, type CreateResponse, type Side } from '../../src/net/protocol';
import type { Env } from './gameRoom';

export { GameRoom } from './gameRoom';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/games' && request.method === 'POST') {
      let body: Partial<CreateRequest> = {};
      try {
        body = (await request.json()) as Partial<CreateRequest>;
      } catch {
        /* no body: random side */
      }
      const asked = body.side;
      const side: Side = asked === 'w' || asked === 'b' ? asked : crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 'b' : 'w';
      // Collisions at 72 bits are not a practical worry, but `create` refuses to overwrite anyway.
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = randomToken(9);
        const key = randomToken(16);
        const inviteKey = randomToken(16);
        const room = env.ROOMS.get(env.ROOMS.idFromName(id));
        if (await room.create(id, side, [key, inviteKey])) return json({ id, key, inviteKey, side } satisfies CreateResponse, 201);
      }
      return json({ error: 'could not create a game' }, 500);
    }

    const ws = /^\/games\/([^/]+)\/ws$/.exec(url.pathname);
    if (ws && request.method === 'GET') {
      if (!validId(ws[1])) return json({ error: 'bad game id' }, 400);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected a websocket' }, 426);
      return env.ROOMS.get(env.ROOMS.idFromName(ws[1])).fetch(request);
    }

    if (url.pathname === '/') return new Response('Stonewake online relay\n', { headers: { 'Content-Type': 'text/plain', ...CORS } });
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
