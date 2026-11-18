// Online play as the player meets it: creating a game, opening one from its link, leaving,
// resigning, rematches, the tab-title alert and this browser's list of games. The game on the
// board is an OnlineSession; the Opponent hands it the clicks.
import type { Mode, Opponent, OnlineSeat } from '../ai/opponent';
import type { ChessGame } from '../chess/game';
import type { GameController } from '../game/controller';
import type { Hud, OnlineView } from '../ui/hud';
import { ONLINE_URL } from './config';
import { loadGames, rememberGame, type MyGame } from './myGames';
import { formatLink, parseLink, type CreateResponse, type GameLink, type Side } from './protocol';
import { OnlineSession } from './session';
import { gameStatus } from './sync';

export interface OnlineDeps {
  controller: GameController;
  game: ChessGame;
  hud: Hud;
  opponent: Opponent;
  /** The bell (the check sound) for the your-move alert. */
  sound: { check(): void };
  /** Resolves when the title screen is gone. */
  ready: Promise<void>;
}

const ALERT_TITLE = '● Your move — Wizards Chess';

export class Online {
  session: OnlineSession | null = null;
  /** The ONLINE choice is open in the panel (with or without a game). */
  private open = false;
  private creating = false;
  private readonly baseTitle = document.title;
  /** The seat the Opponent reads; it always speaks for the current session. */
  private readonly seat: OnlineSeat;

  constructor(private readonly d: OnlineDeps) {
    const self = this;
    this.seat = {
      get side() {
        return self.session?.side ?? null;
      },
      get canMove() {
        return self.session?.canMove ?? false;
      },
    };
    addEventListener('hashchange', () => this.fromAddress());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && document.title === ALERT_TITLE) document.title = this.baseTitle;
    });
  }

  get available(): boolean {
    return ONLINE_URL !== '';
  }

  /** Join the game the address names, if it names one (on boot, and when the hash changes). */
  fromAddress(): void {
    const link = parseLink(location.hash);
    if (!link) {
      if (this.session) this.leave();
      return;
    }
    if (this.session && this.session.link.id === link.id && this.session.link.key === link.key) return;
    if (!this.available) {
      this.d.hud.flash('ONLINE PLAY IS NOT SET UP HERE');
      return;
    }
    this.join(link);
  }

  /** A mode was picked in the panel. */
  chooseMode(mode: Mode): void {
    if (mode === 'online') {
      this.open = true;
      return this.render();
    }
    this.open = false;
    if (this.session) this.leave(mode);
    else this.d.opponent.setMode(mode);
    this.render();
  }

  async create(side: Side | 'random'): Promise<void> {
    if (this.creating || !this.available) return;
    this.creating = true;
    this.render();
    try {
      const res = await fetch(`${ONLINE_URL}/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side }) });
      if (!res.ok) throw new Error(`relay answered ${res.status}`);
      const made = (await res.json()) as CreateResponse;
      const mine: GameLink = { id: made.id, key: made.key };
      rememberGame({ id: made.id, key: made.key, inviteKey: made.inviteKey, side: made.side, status: made.side === 'w' ? 'your move' : 'their move' });
      // The address bar now holds this player's own link (a bookmark or reload comes back here).
      history.replaceState(null, '', this.address(mine));
      this.join(mine);
      this.d.hud.showShare(formatLink(this.page(), { id: made.id, key: made.inviteKey }), formatLink(this.page(), mine), made.side);
    } catch (err) {
      console.error('could not create an online game', err);
      this.d.hud.flash('THE HALL CANNOT BE REACHED');
    } finally {
      this.creating = false;
      this.render();
    }
  }

  /** Open one of this browser's games. */
  openGame(id: string): void {
    const g = loadGames().find((x) => x.id === id);
    if (!g || this.session?.link.id === id) return;
    history.pushState(null, '', this.address(g));
    this.fromAddress();
  }

  /** The LEAVE GAME button: back to the mode played before, panel closed. */
  leaveGame(): void {
    this.open = false;
    this.leave();
  }

  /** Leave the online game (it stays on the relay) and go back to playing on this computer. */
  leave(mode?: Mode): void {
    this.session?.close();
    this.session = null;
    if (parseLink(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    if (document.title === ALERT_TITLE) document.title = this.baseTitle;
    this.d.opponent.leaveOnline(mode);
    this.render();
  }

  async resign(): Promise<void> {
    const s = this.session;
    if (!s?.view || s.view.result) return;
    if (await this.d.hud.confirm('RESIGN?', 'Your opponent will be given the game.', 'RESIGN', 'PLAY ON')) s.resign();
  }

  rematch(): void {
    this.session?.rematch();
  }

  private join(link: GameLink): void {
    this.session?.close();
    this.open = true;
    const session = new OnlineSession(link, {
      controller: this.d.controller,
      game: this.d.game,
      ready: this.d.ready,
      changed: (s) => this.changed(s),
      opponentMoved: () => {
        if (document.visibilityState === 'hidden') {
          document.title = ALERT_TITLE;
          this.d.sound.check();
        }
      },
      refused: (reason, fatal) => {
        if (fatal) {
          this.d.hud.flash(reason === 'bad key' ? 'THAT LINK OPENS NO SEAT' : 'THAT GAME IS GONE');
          this.leave();
        } else if (reason === 'stale' || reason === 'illegal' || reason === 'not your turn') {
          this.d.hud.flash('THE BOARD WAS PUT RIGHT');
        }
      },
    });
    this.session = session;
    rememberGame({ id: link.id, key: link.key });
    this.d.opponent.enterOnline(this.seat);
    this.render();
  }

  private changed(s: OnlineSession): void {
    if (s !== this.session) return;
    this.d.opponent.syncOnline();
    const v = s.view;
    if (v) rememberGame({ id: s.link.id, key: s.link.key, side: v.side, plies: v.moves.length, round: v.round, status: gameStatus(v), updated: Date.now() });
    this.render();
  }

  /** The page's own address without hash (and, for links to share, without query). */
  private page(): string {
    return location.origin + location.pathname;
  }

  private address(link: GameLink | MyGame): string {
    return `${location.pathname}${location.search}#play=${link.id}.${link.key}`;
  }

  render(): void {
    const s = this.session;
    const v = s?.view;
    const id = s?.link.id;
    const stored = id ? loadGames().find((g) => g.id === id) : undefined;
    const view: OnlineView = {
      available: this.available,
      open: this.open || !!s,
      creating: this.creating,
      game: s
        ? {
            side: s.side,
            connection: s.connection,
            opponentOnline: !!v?.opponentOnline,
            myLink: formatLink(this.page(), s.link),
            inviteLink: stored?.inviteKey ? formatLink(this.page(), { id: s.link.id, key: stored.inviteKey }) : null,
            over: !!v?.result,
            rematch: { mine: !!v && v.rematch.includes(v.side), theirs: !!v && v.rematch.some((x) => x !== v.side) },
          }
        : null,
      games: loadGames()
        .filter((g) => g.id !== id)
        .map((g) => ({ id: g.id, side: g.side, status: g.status || 'opened', plies: g.plies, current: false })),
    };
    this.d.hud.setOnline(view);
  }
}
