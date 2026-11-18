// Who moves which side: the player(s) by clicking, or the engine. The engine's moves go through
// GameController.playUci, the same path as a click, so every move plays its full cinematic.
import type { ChessGame } from '../chess/game';
import type { GameController } from '../game/controller';
import type { Side } from '../game/squares';
import type { Hud } from '../ui/hud';
import { LEVELS, type Engine, type Level, type SearchOptions } from './engine';

export type Mode = 'pass' | 'computer' | 'auto' | 'online';

/** The modes kept in localStorage (online is chosen by the link in the address, never stored). */
const MODES: Mode[] = ['pass', 'computer', 'auto'];

/** An online game, as far as who may click is concerned (src/net/session.ts). */
export interface OnlineSeat {
  /** The side this browser plays, once the relay has said. */
  readonly side: Side | null;
  /** Whether this player may move now (connected, in step with the relay, game not over). */
  readonly canMove: boolean;
}
const LEVEL_NAMES = Object.keys(LEVELS) as Level[];

/**
 * How many moves an undo takes back. Against the computer it returns the turn to the human:
 * on your turn it takes back the computer's reply and your move; while the computer is to move
 * (thinking) only your move. Otherwise one move.
 */
export function undoPlies(mode: Mode, humanSide: Side, turn: Side, played: number): number {
  if (played <= 0 || mode === 'online') return 0;
  if (mode !== 'computer') return 1;
  if (turn !== humanSide) return 1;
  // Your turn: the computer's reply and your move. If the computer's opening move is all there
  // is, taking it back would only make it play again.
  return played >= 2 ? 2 : 0;
}

export interface OpponentDeps {
  controller: GameController;
  game: ChessGame;
  engine: Engine;
  hud: Hud;
  /** The game's playback speed for tests (`director.baseSpeed`): pauses shrink with it. */
  speed(): number;
}

export interface OpponentStats {
  requests: number;
  applied: number;
  /** Replies that arrived for a position that no longer stood, and were thrown away. */
  stale: number;
  errors: number;
  games: number;
  lastMove: string | null;
  results: string[];
}

/** Persisted choices, like the HUD's toggles. */
const KEY = { mode: 'stonewake.mode', side: 'stonewake.side', level: 'stonewake.level' };

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export class Opponent {
  mode: Mode;
  humanSide: Side;
  level: Level;
  paused = false;
  /** Auto-play: start a new game when one ends. */
  restart = true;
  /** Auto-play: give up on a game after this many moves (engine-vs-engine shuffles). */
  maxPlies = 300;
  /** Overrides the level's search settings (tests). */
  custom: Partial<SearchOptions> | null = null;
  /** Fixed pause before the computer's move, ms (null: the natural pause). */
  pauseMs: number | null = null;
  /** Seconds the result stays up in auto-play before the next game. */
  resultHoldMs = 6000;
  readonly stats: OpponentStats = { requests: 0, applied: 0, stale: 0, errors: 0, games: 0, lastMove: null, results: [] };
  /** Called after each engine move has played out (tests). */
  onMoved: ((uci: string) => void) | null = null;
  /** Called when an auto-play game ends (tests). */
  onGameOver: ((result: string) => void) | null = null;

  /** Bumped by anything that makes an outstanding request worthless. */
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private searching = false;
  private ended = -1;
  /** Off until `apply()`: nothing moves while the game is still loading. */
  private live = false;
  /** The online game being played, if any. */
  private online: OnlineSeat | null = null;
  /** The mode to go back to when leaving an online game. */
  private offlineMode: Mode = 'pass';
  private onlineSeat: Side | null = null;

  constructor(private readonly d: OpponentDeps) {
    this.mode = stored(KEY.mode, MODES, 'pass');
    this.humanSide = stored<Side>(KEY.side, ['w', 'b'], 'w');
    this.level = stored(KEY.level, LEVEL_NAMES, 'medium');
    d.controller.onSettled(() => this.poke());
  }

  get thinking(): boolean {
    return this.searching;
  }

  /** The sides the engine plays. */
  engineSides(): Side[] {
    if (this.mode === 'auto') return ['w', 'b'];
    if (this.mode === 'computer') return [this.humanSide === 'w' ? 'b' : 'w'];
    return [];
  }

  isEngineTurn(): boolean {
    return this.engineSides().includes(this.d.game.turn() as Side);
  }

  /** Apply the current mode to input, camera and HUD (call once after construction). */
  apply(): void {
    const { controller, hud } = this.d;
    this.live = true;
    if (this.mode === 'online') {
      this.onlineSeat = null;
      this.syncOnline();
      hud.setOpponent({ mode: this.mode, side: this.humanSide, level: this.level, paused: false });
      return;
    }
    const engine = this.engineSides();
    controller.inputSides = new Set((['w', 'b'] as Side[]).filter((s) => !engine.includes(s)));
    controller.seat = this.mode === 'computer' ? this.humanSide : null;
    controller.inputChanged();
    controller.reseat();
    hud.setOpponent({ mode: this.mode, side: this.humanSide, level: this.level, paused: this.paused });
    if (this.mode !== 'pass') {
      this.d.engine.init().catch((err) => this.fail(err));
    }
    this.poke();
  }

  /** Play an online game: input and the camera follow the session from now on. */
  enterOnline(seat: OnlineSeat): void {
    this.cancel();
    if (this.mode !== 'online') this.offlineMode = this.mode;
    this.online = seat;
    this.mode = 'online';
    this.paused = false;
    this.apply();
  }

  /** Back to the mode played before the online game (or `mode`), with a fresh board. */
  leaveOnline(mode?: Mode): void {
    if (this.mode !== 'online') return;
    this.online = null;
    this.onlineSeat = null;
    this.mode = mode && mode !== 'online' ? mode : this.offlineMode;
    save(KEY.mode, this.mode);
    this.apply();
    this.newGame();
  }

  /** Online: open clicks to this player's side when they may move, and keep the camera at their seat. */
  syncOnline(): void {
    const { controller } = this.d;
    if (this.mode !== 'online' || !this.online) return;
    const side = this.online.side;
    controller.inputSides = new Set(side && this.online.canMove ? [side] : []);
    controller.inputChanged();
    if (side !== this.onlineSeat) {
      // Only when the seat changes (joining, a rematch): otherwise leave a dragged camera be.
      // On joining, be there at once: a missed move may be about to play.
      const joining = this.onlineSeat === null;
      this.onlineSeat = side;
      controller.seat = side;
      controller.reseat(joining);
    }
  }

  setMode(mode: Mode, paused = false): void {
    if (mode === 'online') return;
    if (this.mode === 'online') return this.leaveOnline(mode);
    if (mode === this.mode && paused === this.paused) return;
    this.cancel();
    this.mode = mode;
    this.paused = paused;
    save(KEY.mode, mode);
    this.apply();
  }

  setSide(side: Side): void {
    if (side === this.humanSide) return;
    this.cancel();
    this.humanSide = side;
    save(KEY.side, side);
    this.apply();
  }

  setLevel(level: Level): void {
    if (level === this.level) return;
    this.cancel();
    this.level = level;
    save(KEY.level, level);
    this.apply();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.cancel();
    this.paused = paused;
    this.apply();
  }

  newGame(fen?: string): void {
    // An online game has no new game: there is rematch once it is over.
    if (this.mode === 'online') return;
    this.cancel();
    this.ended = -1;
    if (this.mode !== 'pass' && this.d.engine.loaded) void this.d.engine.newGame().catch((err) => this.fail(err));
    this.d.controller.start(fen);
  }

  async undo(): Promise<void> {
    const { controller, game } = this.d;
    if (controller.isBusy) return;
    const n = undoPlies(this.mode, this.humanSide, game.turn() as Side, game.history().length);
    if (!n) return;
    this.cancel();
    if (this.mode === 'auto' && !this.paused) {
      this.paused = true;
      this.d.hud.setOpponent({ mode: this.mode, side: this.humanSide, level: this.level, paused: true });
    }
    this.ended = -1;
    await controller.undo(n);
  }

  /** Drop any request in flight and any pending restart. */
  cancel(): void {
    this.token++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.searching) this.d.engine.stop();
    this.setSearching(false);
  }

  /** The board has come to rest (or the mode changed): ask for a move if it is the engine's turn. */
  poke(): void {
    const { controller, game, engine } = this.d;
    // Whatever was outstanding belonged to an earlier position.
    this.cancel();
    if (this.mode === 'pass' || this.mode === 'online' || !this.live) return;
    const status = game.status();
    if (status.over) return this.gameOver(status.checkmate ? `${status.turn === 'w' ? 'black' : 'white'} mates` : `draw: ${status.draw}`);
    if (this.mode === 'auto' && game.history().length >= this.maxPlies) return this.gameOver(`stopped after ${this.maxPlies} moves`, true);
    if (this.paused || controller.isBusy || !this.isEngineTurn()) return;

    const token = this.token;
    const gen = controller.generation;
    const fen = game.fen();
    const speed = Math.max(1, this.d.speed());
    const base = LEVELS[this.level];
    const opts: SearchOptions = { skill: this.custom?.skill ?? base.skill, movetime: this.custom?.movetime ?? base.movetime };
    // A natural pause after the last move settles; the search runs during it.
    const pause = (this.pauseMs ?? (this.mode === 'auto' ? 1000 : 700 + Math.random() * 500)) / speed;
    this.stats.requests++;
    this.setSearching(true);
    // (Not cleared on cancel: it only delays the check below, which drops a stale reply.)
    const waited = new Promise<void>((r) => setTimeout(r, pause));
    Promise.all([engine.bestMove(fen, opts), waited]).then(
      ([uci]) => {
        // Only a reply for the very position still on the board, untouched, may move a piece.
        if (token !== this.token || gen !== controller.generation || fen !== game.fen() || controller.isBusy || !this.isEngineTurn() || this.paused) {
          this.stats.stale++;
          return;
        }
        this.setSearching(false);
        if (!uci) return;
        if (!game.legalUci(uci)) {
          this.stats.errors++;
          console.warn(`engine proposed ${uci}, which chess.js rejects in ${fen}`);
          return;
        }
        this.stats.applied++;
        this.stats.lastMove = uci;
        controller.playUci(uci).then(
          () => this.onMoved?.(uci),
          (err) => console.error(err),
        );
      },
      (err) => {
        if (token === this.token) this.fail(err);
      },
    );
  }

  private gameOver(result: string, capped = false): void {
    const { controller, hud } = this.d;
    // Count each finished game once (poke runs again after an undo, a mode change, a resume).
    const gen = controller.generation;
    if (this.ended !== gen) {
      this.ended = gen;
      if (this.mode === 'auto') {
        this.stats.games++;
        this.stats.results.push(result);
        if (this.stats.results.length > 50) this.stats.results.shift();
        this.onGameOver?.(result);
      }
      if (capped) hud.showGameOver('STILLNESS', `${this.maxPlies} moves and no end in sight.`);
    }
    if (this.mode !== 'auto' || this.paused || !this.restart) return;
    const token = this.token;
    this.timer = setTimeout(() => {
      if (token === this.token && this.mode === 'auto' && !this.paused && !controller.isBusy) this.newGame();
    }, this.resultHoldMs / Math.max(1, this.d.speed()));
  }

  private setSearching(on: boolean): void {
    if (on === this.searching) return;
    this.searching = on;
    this.d.hud.setThinking(on ? (this.d.game.turn() as Side) : null);
  }

  private fail(err: unknown): void {
    console.error('chess engine failed', err);
    this.stats.errors++;
    this.cancel();
    this.d.hud.flash('THE ENGINE IS SILENT');
    this.mode = 'pass';
    this.paused = false;
    this.apply();
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window: the choice lasts until reload */
  }
}
