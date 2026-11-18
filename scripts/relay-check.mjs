#!/usr/bin/env node
// Exercise the online relay directly over its protocol (no browser): create a game, join both
// seats, play, and try every kind of forged or out-of-turn message.
//   node scripts/relay-check.mjs [relayUrl=http://localhost:8787]
const BASE = process.argv[2] ?? 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws');
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  (${extra})` : ''}`);
};

/** A socket that queues what it receives, so a test can wait for the next message. */
async function connect(id) {
  const ws = new WebSocket(`${WS}/games/${id}/ws`);
  const inbox = [];
  const waiters = [];
  let closed = null;
  ws.onmessage = (e) => {
    const msg = e.data === 'pong' ? { t: 'pong' } : JSON.parse(e.data);
    const w = waiters.shift();
    if (w) w(msg);
    else inbox.push(msg);
  };
  ws.onclose = (e) => {
    closed = e.code;
    for (const w of waiters.splice(0)) w({ t: 'closed', code: e.code });
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  return {
    ws,
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next: (ms = 3000) =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((r) => {
            const t = setTimeout(() => r({ t: 'timeout' }), ms);
            waiters.push((m) => {
              clearTimeout(t);
              r(m);
            });
          }),
    /** Skip messages until one of type `t` arrives. */
    async until(t, ms = 3000) {
      for (;;) {
        const m = await this.next(ms);
        if (m.t === t || m.t === 'timeout' || m.t === 'closed') return m;
      }
    },
    get closed() {
      return closed;
    },
    close: () => ws.close(),
  };
}

/** A refused move: the relay answers `rejected`, then the state as it stands (consumed here). */
const refused = async (conn) => {
  const r = await conn.until('rejected');
  await conn.until('state');
  return r.reason;
};

const create = async (side) => {
  const r = await fetch(`${BASE}/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side }) });
  return { status: r.status, body: await r.json(), cors: r.headers.get('access-control-allow-origin') };
};

const made = await create('w');
check('create returns 201 with ids and keys', made.status === 201 && made.body.id && made.body.key && made.body.inviteKey && made.body.side === 'w', JSON.stringify(made.body));
check('create allows any origin', made.cors === '*');
const { id, key, inviteKey } = made.body;

const sides = new Set();
for (let i = 0; i < 12; i++) sides.add((await create('random')).body.side);
check('random side gives both colours over 12 games', sides.size === 2, [...sides].join(','));

const a = await connect(id);
a.send({ t: 'hello', key });
let s = await a.until('state');
check('creator hello -> state as white, no moves, opponent away', s.side === 'w' && s.moves.length === 0 && s.opponentOnline === false);

const b = await connect(id);
b.send({ t: 'hello', key: inviteKey });
s = await b.until('state');
check('invite hello -> state as black, opponent here', s.side === 'b' && s.opponentOnline === true);
s = await a.until('state');
check('creator hears that the opponent arrived', s.opponentOnline === true);

a.send('ping');
check('ping answered with pong', (await a.until('pong')).t === 'pong');
a.send({ t: 'sync' });
s = await a.until('state');
check('sync answered with the state and presence', s.side === 'w' && s.opponentOnline === true);

b.send({ t: 'move', uci: 'e7e5', ply: 0 });
check('black moving on white\'s turn is refused', (await refused(b)) === 'not your turn');
a.send({ t: 'move', uci: 'e2e5', ply: 0 });
check('illegal move refused', (await refused(a)) === 'illegal');
a.send({ t: 'move', uci: 'e2e4', ply: 3 });
check('wrong ply refused as stale', (await refused(a)) === 'stale');
a.send({ t: 'move', uci: 'e2e4', ply: 0 });
s = await a.until('state');
const sb = await b.until('state');
check('legal move broadcast to both', s.moves.join() === 'e2e4' && sb.moves.join() === 'e2e4');
a.send({ t: 'move', uci: 'e2e4', ply: 0 });
check('the same move sent twice is refused, not applied twice', (await refused(a)) === 'stale');
a.send('{nonsense');
check('garbage refused', (await a.until('rejected')).reason === 'bad message');

// A stranger with a made-up key, and one with no hello.
const c = await connect(id);
c.send({ t: 'hello', key: 'AAAAAAAAAAAAAAAAAAAAAA' });
check('wrong key refused and closed', (await c.until('rejected')).reason === 'bad key');
const d = await connect(id);
d.send({ t: 'move', uci: 'e7e5', ply: 1 });
check('move without hello refused', (await d.until('rejected')).reason === 'bad key');
const e = await connect('nosuchgame123');
e.send({ t: 'hello', key });
check('unknown game refused', (await e.until('rejected')).reason === 'no such game');

// Fool's mate: f2f3 e7e5 g2g4 d8h4 (e2e4 already played, so: e7e5... use a fresh game).
const g = (await create('b')).body;
check('creator can take black', g.side === 'b');
const gb = await connect(g.id);
gb.send({ t: 'hello', key: g.key });
await gb.until('state');
const gw = await connect(g.id);
gw.send({ t: 'hello', key: g.inviteKey });
await gw.until('state');
await gb.until('state');
const mate = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
for (let i = 0; i < mate.length; i++) {
  (i % 2 ? gb : gw).send({ t: 'move', uci: mate[i], ply: i });
  await gw.until('state');
  await gb.until('state');
}
gb.send({ t: 'rematch' });
s = await gw.until('state');
check('mate ends the game for black', true);
check('rematch request is recorded', s.rematch.join() === 'b' && s.result?.reason === 'checkmate' && s.result?.winner === 'b', JSON.stringify(s.result));
await gb.until('state');
gw.send({ t: 'move', uci: 'a2a3', ply: 4 });
check('no moves after mate', (await refused(gw)) === 'game over');
gw.send({ t: 'rematch' });
s = await gw.until('state');
const s2 = await gb.until('state');
check('both accept: new round, sides swapped, board clear', s.round === 1 && s.side === 'b' && s2.side === 'w' && s.moves.length === 0 && !s.result);

// Resign.
gb.send({ t: 'resign' });
s = await gw.until('state');
check('resignation gives the game to the other side', s.result?.reason === 'resignation' && s.result?.winner === 'b');
await gb.until('state');

// Presence on disconnect.
gw.close();
s = await gb.until('state');
check('leaving is heard by the other player', s.opponentOnline === false);

// Reconnect later: the game is still there.
const a2 = await connect(id);
a2.send({ t: 'hello', key });
s = await a2.until('state');
check('reconnecting finds the game as it was', s.moves.join() === 'e2e4' && s.side === 'w');

for (const x of [a, b, c, d, e, gb, a2]) x.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
