import type * as THREE from 'three';
import type { PieceSymbol } from 'chess.js';
import type { ChessGame, MoveEvent, Target } from '../chess/game';
import type { CameraRig } from '../cinema/cameraRig';
import type { Picker } from '../input/picker';
import type { Cast, BoardArray } from '../pieces/cast';
import type { PieceType } from '../pieces/regalia';
import type { Markers } from '../render/markers';
import { Hud } from '../ui/hud';
import type { Side } from './squares';

/** Plays a move out on the board. The controller waits for it before accepting input. */
export interface Presenter {
  present(event: MoveEvent): Promise<void>;
  /** Drop anything still playing out (debris, effects) before the board is rebuilt. */
  reset?(): void;
}

const GLOW: Record<Side, number> = { w: 0xffa23a, b: 0x39b8ff };
const CAPTURE_COLOR = 0xff4a22;
const CHECK_COLOR = 0xff3018;
const LAST_COLOR = 0xd9c9a3;

export interface ControllerDeps {
  game: ChessGame;
  cast: Cast;
  markers: Markers;
  hud: Hud;
  picker: Picker;
  rig: CameraRig;
  dom: HTMLElement;
  presenter: Presenter;
  /** Sounds the controller itself is responsible for. */
  sound?: { select(position?: THREE.Vector3): void; check(): void };
}

/**
 * Turns clicks into chess moves: selection, legal-move markers, promotion, undo and new
 * game. chess.js decides what is legal; the presenter decides how a move looks.
 */
export class GameController {
  private selected: string | null = null;
  private targets: Target[] = [];
  private hovered: string | null = null;
  private busy = false;
  private readonly events: MoveEvent[] = [];
  private readonly settled: (() => void)[] = [];
  private readonly moved: ((event: MoveEvent, ply: number) => void)[] = [];
  private gen = 0;
  followTurn: boolean;
  /** Sides whose moves are made by clicking (the computer's side is left out). */
  inputSides = new Set<Side>(['w', 'b']);
  /** If set, the camera stays on this side's seat instead of following the turn (vs computer). */
  seat: Side | null = null;

  constructor(private readonly d: ControllerDeps) {
    this.followTurn = localStorage.getItem('stonewake.follow') !== '0';
    d.dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || d.rig.consumedClick()) return;
      void this.click(d.picker.squareAt(e.clientX, e.clientY, d.cast.living()));
    });
    d.dom.addEventListener('pointermove', (e) => {
      if (d.rig.isDragging) return;
      this.hover(d.picker.squareAt(e.clientX, e.clientY, d.cast.living()));
    });
    d.dom.addEventListener('pointerleave', () => this.hover(null));
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.select(null);
    });
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Bumped whenever the position changes (move, undo, new game): stale work compares it. */
  get generation(): number {
    return this.gen;
  }

  /** Called whenever the board comes to rest: after a new game, an undo, or a move has played out. */
  onSettled(listener: () => void): () => void {
    this.settled.push(listener);
    return () => this.settled.splice(this.settled.indexOf(listener) >>> 0, 1);
  }

  /**
   * Called as each move is made, before it plays out on the board: by a click, the computer or
   * an online opponent alike. `ply` is the move's index from the start of the game.
   */
  onMove(listener: (event: MoveEvent, ply: number) => void): () => void {
    this.moved.push(listener);
    return () => this.moved.splice(this.moved.indexOf(listener) >>> 0, 1);
  }

  private notifySettled(): void {
    for (const l of [...this.settled]) l();
  }

  /** Swing to the side to move, or to the human's seat when playing the computer. */
  private seatCamera(instant = false): void {
    if (this.seat) this.d.rig.viewFor(this.seat, instant);
    else if (this.followTurn) this.d.rig.viewFor(this.d.game.turn(), instant);
  }

  private get inputOpen(): boolean {
    return this.inputSides.has(this.d.game.turn() as Side);
  }

  /** Set up the starting position (or any FEN). */
  start(fen?: string): void {
    const { game, cast, hud } = this.d;
    this.gen++;
    if (fen) game.load(fen);
    else game.reset();
    this.events.length = 0;
    this.select(null);
    this.d.presenter.reset?.();
    cast.setPosition(game.board() as BoardArray);
    hud.hideGameOver();
    this.refresh();
    this.seatCamera();
    this.notifySettled();
  }

  private hover(square: string | null): void {
    if (square === this.hovered) return;
    this.hovered = square;
    const { markers, game, cast, dom } = this.d;
    markers.clear('hover');
    let pointer = false;
    if (square && !this.busy && this.inputOpen) {
      const isTarget = this.targets.some((t) => t.to === square);
      const own = cast.at(square)?.side === game.turn() && !game.status().over;
      if (isTarget || own) {
        pointer = true;
        if (square !== this.selected) markers.add('hover', square, GLOW[game.turn() as Side], 0.9);
      }
    }
    dom.style.cursor = pointer ? 'pointer' : 'default';
  }

  /** Select a piece (showing where it can go) or clear the selection. */
  select(square: string | null): void {
    const { markers, cast, game } = this.d;
    if (this.selected) cast.at(this.selected)?.wake(0, 0);
    markers.clear('select', 'move', 'capture', 'hover');
    this.selected = null;
    this.targets = [];
    if (!square) return;
    const targets = game.targets(square);
    if (!targets.length) return;
    this.selected = square;
    this.targets = targets;
    const side = game.turn() as Side;
    markers.add('select', square, GLOW[side], 1.6);
    for (const t of targets) markers.add(t.capture ? 'capture' : 'move', t.to, t.capture ? CAPTURE_COLOR : GLOW[side], t.capture ? 2.2 : 1.5);
    // The chosen statue stirs: veins and eyes light up.
    cast.at(square)?.wake(1.6, 5);
    this.d.sound?.select(cast.at(square)?.root.position);
  }

  /** Handle a click on a square (also used by the debug API). */
  async click(square: string | null): Promise<void> {
    const { game, cast } = this.d;
    if (this.busy || game.status().over) return;
    if (!square || !this.inputOpen) return this.select(null);
    const target = this.targets.find((t) => t.to === square);
    if (this.selected && target) {
      let promotion: PieceSymbol | undefined;
      if (target.promotion) {
        this.busy = true;
        promotion = await this.d.hud.askPromotion(game.turn() as Side);
        this.busy = false;
      }
      return this.move(this.selected, square, promotion);
    }
    if (cast.at(square)?.side === game.turn()) this.select(square === this.selected ? null : square);
    else this.select(null);
  }

  /** Play a move and wait for it to finish on the board. Throws if the move is illegal. */
  async move(from: string, to: string, promotion?: PieceSymbol): Promise<void> {
    const { game, cast, hud, presenter } = this.d;
    if (this.busy) throw new Error('a move is already playing');
    const event = game.play(from, to, promotion);
    this.gen++;
    this.events.push(event);
    const ply = game.history().length - 1;
    for (const l of [...this.moved]) l(event, ply);
    this.busy = true;
    hud.setBusy(true);
    this.d.markers.clear();
    cast.at(from)?.wake(0, 0);
    this.selected = null;
    this.targets = [];
    try {
      await presenter.present(event);
    } finally {
      // Whatever happened on screen, the statues end where chess.js says they are.
      if (!cast.matches(game.board() as BoardArray)) {
        console.warn(`board view disagreed with the position after ${event.san}; resynchronising`);
        cast.setPosition(game.board() as BoardArray);
      }
      this.busy = false;
      hud.setBusy(false);
      this.refresh();
      const status = game.status();
      if (status.check && !status.checkmate) this.d.sound?.check();
      if (!status.over) this.seatCamera();
      this.notifySettled();
    }
  }

  /**
   * Play a move given in coordinate notation (`e2e4`, `e7e8q`), as the computer does. chess.js
   * must find it legal in the current position first; otherwise it throws and nothing changes.
   * From there it takes exactly the path a clicked move takes.
   */
  async playUci(uci: string): Promise<void> {
    const move = this.d.game.legalUci(uci);
    if (!move) throw new Error(`illegal move ${uci} in ${this.d.game.fen()}`);
    this.select(null);
    return this.move(move.from, move.to, move.promotion);
  }

  /**
   * Set up the position after `moves` (coordinate notation) from the start, at once, with no
   * move played out: an online game being joined or put right. Throws if a move is illegal,
   * leaving the opening position.
   */
  loadMoves(moves: readonly string[]): void {
    const { game, cast, hud } = this.d;
    this.gen++;
    game.reset();
    this.events.length = 0;
    try {
      for (const uci of moves) {
        const m = game.legalUci(uci);
        if (!m) throw new Error(`illegal move ${uci} at ply ${this.events.length}`);
        this.events.push(game.play(m.from, m.to, m.promotion));
      }
    } catch (err) {
      game.reset();
      this.events.length = 0;
      throw err;
    } finally {
      this.select(null);
      this.d.presenter.reset?.();
      cast.setPosition(game.board() as BoardArray);
      hud.hideGameOver();
      this.refresh();
      this.seatCamera();
      this.notifySettled();
    }
  }

  /** `side` resigns (online play): the game is over and the result shown. */
  resign(side: Side): void {
    if (this.d.game.status().resigned) return;
    this.d.game.resign(side);
    this.select(null);
    this.refresh();
  }

  /** Take back up to `plies` moves (ignored while a move is playing). Returns how many were taken back. */
  async undo(plies = 1): Promise<number> {
    const { game, cast } = this.d;
    if (this.busy) return 0;
    let taken = 0;
    while (taken < plies && game.undo()) {
      this.events.pop();
      taken++;
    }
    if (!taken) return 0;
    this.gen++;
    this.select(null);
    this.d.presenter.reset?.();
    cast.setPosition(game.board() as BoardArray);
    this.d.hud.hideGameOver();
    this.refresh();
    this.seatCamera();
    this.notifySettled();
    return taken;
  }

  setFollow(on: boolean): void {
    this.followTurn = on;
    localStorage.setItem('stonewake.follow', on ? '1' : '0');
    if (on && !this.seat) this.d.rig.viewFor(this.d.game.turn());
  }

  /** Re-apply the camera rule (after the seat changes); `instant` jumps rather than swings. */
  reseat(instant = false): void {
    if (!this.busy) this.seatCamera(instant);
  }

  /** Re-check hover markers and selection after the sides open to input change. */
  inputChanged(): void {
    if (!this.inputOpen) this.select(null);
    const h = this.hovered;
    this.hovered = null;
    this.hover(h);
  }

  get moveCount(): number {
    return this.events.length;
  }

  /** Bring the HUD and the persistent markers in line with the position. */
  private refresh(): void {
    const { game, hud, markers } = this.d;
    const status = game.status();
    hud.setTurn(status.turn as Side, status.check && !status.checkmate);
    hud.setMoves(game.history());
    const lost: Record<Side, PieceType[]> = { w: [], b: [] };
    for (const e of this.events) if (e.captured) lost[e.color === 'w' ? 'b' : 'w'].push(e.captured);
    hud.setCaptured(lost);

    markers.clear('last', 'check');
    const last = this.events[this.events.length - 1];
    if (last) {
      markers.add('last', last.from, LAST_COLOR, 0.8);
      markers.add('last', last.to, LAST_COLOR, 1.1);
    }
    if (status.checkedKing) markers.add('check', status.checkedKing, CHECK_COLOR, 2.4);

    if (status.resigned) {
      const winner = status.resigned === 'w' ? 'b' : 'w';
      hud.showGameOver('RESIGNATION', `${Hud.sideName(status.resigned as Side)} lays down arms. ${Hud.sideName(winner)} takes the board.`);
    } else if (status.checkmate) {
      const winner = status.turn === 'w' ? 'b' : 'w';
      hud.showGameOver('CHECKMATE', `${Hud.sideName(winner)} takes the board.`);
    } else if (status.draw) {
      hud.showGameOver('DRAW', `By ${status.draw}.`);
    }
  }
}
