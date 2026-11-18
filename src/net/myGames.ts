// The online games this browser has opened, kept in localStorage so a player can find them
// again days later without the link. Nothing here leaves the browser.
import type { Side } from './protocol';

export interface MyGame {
  id: string;
  key: string;
  side: Side;
  /** The link to share: known only to the browser that created the game. */
  inviteKey?: string;
  plies: number;
  round: number;
  /** 'your move' | 'their move' | a short result. */
  status: string;
  /** When this browser last heard about the game (ms since epoch). */
  updated: number;
}

const KEY = 'stonewake.online.games';
const MAX = 24;

export function loadGames(): MyGame[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as MyGame[];
    return Array.isArray(list) ? list.filter((g) => g && typeof g.id === 'string' && typeof g.key === 'string') : [];
  } catch {
    return [];
  }
}

function store(list: MyGame[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* private window: the list lasts until reload */
  }
}

/** Add or update a game (matched by id), most recent first. */
export function rememberGame(game: Partial<MyGame> & Pick<MyGame, 'id' | 'key'>): MyGame {
  const list = loadGames();
  const old = list.find((g) => g.id === game.id);
  const merged: MyGame = { side: 'w', plies: 0, round: 0, status: '', updated: Date.now(), ...old, ...game, inviteKey: game.inviteKey ?? old?.inviteKey };
  store([merged, ...list.filter((g) => g.id !== game.id)]);
  return merged;
}

export function forgetGame(id: string): void {
  store(loadGames().filter((g) => g.id !== id));
}

/** How many moves of a round this browser has shown (so a missed move can be replayed). */
export function seenPlies(id: string, round: number): number {
  try {
    const [r, n] = (localStorage.getItem(`stonewake.online.seen.${id}`) ?? '').split(':').map(Number);
    return r === round && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function markSeen(id: string, round: number, plies: number): void {
  try {
    localStorage.setItem(`stonewake.online.seen.${id}`, `${round}:${plies}`);
  } catch {
    /* not remembered: the last move may be replayed next time */
  }
}
