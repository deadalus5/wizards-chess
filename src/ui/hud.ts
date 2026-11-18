import '@fontsource/cinzel/500.css';
import './hud.css';
import type { Side } from '../game/squares';
import type { PieceType } from '../pieces/regalia';

export interface HudCallbacks {
  onUndo(): void;
  onNewGame(): void;
  onFlip(): void;
  onToggleFollow(on: boolean): void;
  onToggleSound(on: boolean): void;
  onToggleCinema(on: boolean): void;
  onMode(mode: OpponentMode): void;
  onSide(side: Side): void;
  onLevel(level: OpponentLevel): void;
  onPause(paused: boolean): void;
}

export type OpponentMode = 'pass' | 'computer' | 'auto';
export type OpponentLevel = 'easy' | 'medium' | 'hard' | 'max';
export interface OpponentView {
  mode: OpponentMode;
  side: Side;
  level: OpponentLevel;
  paused: boolean;
}

/** How the toggles start out. */
export interface HudSettings {
  follow: boolean;
  sound: boolean;
  cinema: boolean;
}

const SIDE_NAME: Record<Side, string> = { w: 'Ivory', b: 'Obsidian' };
const GLYPH: Record<PieceType, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const PIECE_NAME: Record<PieceType, string> = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
const ORDER: PieceType[] = ['q', 'r', 'b', 'n', 'p'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The on-screen interface: plain DOM over the canvas. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly turnText: HTMLElement;
  private readonly checkText: HTMLElement;
  private readonly moveList: HTMLOListElement;
  private readonly capturedRows: Record<Side, HTMLElement>;
  private readonly undoButton: HTMLButtonElement;
  private readonly followButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly promotion: HTMLElement;
  private readonly promotionChoices: HTMLElement;
  private readonly gameOver: HTMLElement;
  private readonly gameOverTitle: HTMLElement;
  private readonly gameOverText: HTMLElement;
  private readonly opponent: HTMLElement;
  private readonly modeButtons = new Map<OpponentMode, HTMLButtonElement>();
  private readonly sideButtons = new Map<Side, HTMLButtonElement>();
  private readonly levelButtons = new Map<OpponentLevel, HTMLButtonElement>();
  private readonly pauseButton: HTMLButtonElement;
  private turnSide: Side = 'w';
  private turnCheck = false;
  private thinking: Side | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, callbacks: HudCallbacks, settings: HudSettings) {
    const root = el('div');
    root.id = 'hud';
    this.root = root;

    root.append(el('div', 'wordmark chrome', 'STONEWAKE'));

    const turn = el('div', 'turn chrome');
    this.chip = el('span', 'chip w');
    this.turnText = el('span', undefined, 'IVORY TO MOVE');
    this.checkText = el('span', 'check');
    turn.append(this.chip, this.turnText, this.checkText);
    root.append(turn);

    // Who plays: pass-and-play, against the computer, or the computer against itself.
    this.opponent = el('div', 'opponent panel chrome');
    this.opponent.append(el('h3', undefined, 'OPPONENT'));
    const group = (cls: string): HTMLElement => {
      const g = el('div', `seg ${cls}`);
      this.opponent.append(g);
      return g;
    };
    const choice = <T>(parent: HTMLElement, map: Map<T, HTMLButtonElement>, value: T, label: string, title: string, pick: (v: T) => void): void => {
      const b = el('button', undefined, label);
      b.title = title;
      b.onclick = () => pick(value);
      map.set(value, b);
      parent.append(b);
    };
    const modes = group('modes');
    choice(modes, this.modeButtons, 'pass', 'PASS & PLAY', 'Two players at one board', callbacks.onMode);
    choice(modes, this.modeButtons, 'computer', 'VS COMPUTER', 'Play against the engine', callbacks.onMode);
    choice(modes, this.modeButtons, 'auto', 'AUTO-PLAY', 'Watch the engine play itself', callbacks.onMode);
    const sides = group('sides');
    choice(sides, this.sideButtons, 'w', 'PLAY IVORY', 'You play Ivory; the computer plays Obsidian', callbacks.onSide);
    choice(sides, this.sideButtons, 'b', 'PLAY OBSIDIAN', 'You play Obsidian; the computer plays Ivory', callbacks.onSide);
    const levels = group('levels');
    for (const [lv, name] of [['easy', 'EASY'], ['medium', 'MEDIUM'], ['hard', 'HARD'], ['max', 'MAX']] as [OpponentLevel, string][]) {
      choice(levels, this.levelButtons, lv, name, `Engine strength: ${name.toLowerCase()}`, callbacks.onLevel);
    }
    const pause = group('pause');
    this.pauseButton = el('button', undefined, 'PAUSE');
    this.pauseButton.onclick = () => callbacks.onPause(this.pauseButton.dataset.paused !== '1');
    pause.append(this.pauseButton);
    root.append(this.opponent);

    const moves = el('div', 'moves panel chrome');
    moves.append(el('h3', undefined, 'MOVES'));
    this.moveList = el('ol');
    moves.append(this.moveList);
    root.append(moves);

    const captured = el('div', 'captured panel chrome');
    captured.append(el('h3', undefined, 'FALLEN'));
    this.capturedRows = { w: el('div', 'row w'), b: el('div', 'row b') };
    captured.append(this.capturedRows.b, this.capturedRows.w);
    root.append(captured);

    const actions = el('div', 'actions chrome');
    const toggle = (label: string, title: string, on: boolean, changed: (on: boolean) => void): HTMLButtonElement => {
      const b = el('button', undefined, label);
      b.title = title;
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => {
        const now = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(now));
        changed(now);
      };
      return b;
    };
    const sound = toggle('SOUND', 'Sound on or off', settings.sound, callbacks.onToggleSound);
    const cinema = toggle('CINEMATIC', 'Cut to a close shot and slow the killing blow (off: captures play from your seat)', settings.cinema, callbacks.onToggleCinema);
    this.followButton = toggle('FOLLOW TURN', 'Swing the camera round to the side to move', settings.follow, callbacks.onToggleFollow);
    const flip = el('button', undefined, 'FLIP');
    flip.title = 'Look from the other side';
    flip.onclick = () => callbacks.onFlip();
    this.undoButton = el('button', undefined, 'UNDO');
    this.undoButton.onclick = () => callbacks.onUndo();
    const fresh = el('button', undefined, 'NEW GAME');
    fresh.onclick = () => callbacks.onNewGame();
    actions.append(sound, cinema, this.followButton, flip, this.undoButton, fresh);
    root.append(actions);

    this.hint = el('div', 'hint chrome', 'Click a statue, then a glowing square.  Drag to orbit, scroll to zoom.  Hold Space to hurry a move along.');
    root.append(this.hint);

    // Promotion picker.
    this.promotion = el('div', 'overlay scrim');
    const promoCard = el('div', 'card panel');
    promoCard.append(el('h2', undefined, 'ASCEND'), el('p', undefined, 'The pawn has crossed the board. What does it become?'));
    this.promotionChoices = el('div', 'choices');
    promoCard.append(this.promotionChoices);
    this.promotion.append(promoCard);
    root.append(this.promotion);

    // Game over.
    this.gameOver = el('div', 'overlay scrim');
    const overCard = el('div', 'card panel');
    this.gameOverTitle = el('h2');
    this.gameOverText = el('p');
    const again = el('button', 'primary', 'NEW GAME');
    again.onclick = () => callbacks.onNewGame();
    overCard.append(this.gameOverTitle, this.gameOverText, again);
    this.gameOver.append(overCard);
    root.append(this.gameOver);

    parent.append(root);
    this.setMoves([]);
  }

  setTurn(side: Side, check: boolean): void {
    this.turnSide = side;
    this.turnCheck = check;
    this.renderTurn();
  }

  /** Show that the computer is choosing a move for `side` (null: it is not). */
  setThinking(side: Side | null): void {
    this.thinking = side;
    this.renderTurn();
  }

  /** A short message in the turn bar for a few seconds. */
  flash(message: string): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.turnText.textContent = message;
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.renderTurn();
    }, 4000);
  }

  private renderTurn(): void {
    const side = this.thinking ?? this.turnSide;
    this.chip.className = `chip ${side}${this.thinking ? ' thinking' : ''}`;
    if (!this.flashTimer) this.turnText.textContent = `${SIDE_NAME[side].toUpperCase()} ${this.thinking ? 'IS THINKING' : 'TO MOVE'}`;
    this.checkText.textContent = this.turnCheck ? 'CHECK' : '';
  }

  /** Show the opponent choices as they stand. */
  setOpponent(v: OpponentView): void {
    for (const [m, b] of this.modeButtons) b.setAttribute('aria-pressed', String(m === v.mode));
    for (const [s, b] of this.sideButtons) b.setAttribute('aria-pressed', String(s === v.side));
    for (const [l, b] of this.levelButtons) b.setAttribute('aria-pressed', String(l === v.level));
    this.opponent.dataset.mode = v.mode;
    this.pauseButton.dataset.paused = v.paused ? '1' : '0';
    this.pauseButton.textContent = v.paused ? 'RESUME' : 'PAUSE';
    this.pauseButton.setAttribute('aria-pressed', String(!v.paused));
  }

  setMoves(san: readonly string[]): void {
    this.moveList.replaceChildren();
    if (!san.length) {
      this.moveList.append(el('li', 'empty', 'No moves yet'));
      this.undoButton.disabled = true;
      return;
    }
    this.undoButton.disabled = false;
    for (let i = 0; i < san.length; i += 2) {
      const li = el('li');
      li.append(el('span', 'n', `${i / 2 + 1}.`));
      const w = el('span', i === san.length - 1 ? 'last' : undefined, san[i]);
      const b = el('span', i + 1 === san.length - 1 ? 'last' : undefined, san[i + 1] ?? '');
      li.append(w, b);
      this.moveList.append(li);
    }
    this.moveList.scrollTop = this.moveList.scrollHeight;
    this.hint.style.opacity = '0';
  }

  /** `lost[side]` is the list of that side's pieces that have been destroyed. */
  setCaptured(lost: Record<Side, PieceType[]>): void {
    for (const side of ['w', 'b'] as Side[]) {
      const sorted = [...lost[side]].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
      this.capturedRows[side].textContent = sorted.map((t) => GLYPH[t]).join('');
    }
  }

  /** Controls are disabled while a move is playing out. */
  setBusy(busy: boolean): void {
    this.undoButton.disabled = busy || this.moveList.querySelector('.empty') !== null;
  }

  /**
   * The title, shown over the hall before the first game. Resolves when the player clicks
   * to begin (that click is also the gesture that lets sound start).
   */
  showTitle(): Promise<void> {
    const title = el('div');
    title.id = 'title';
    title.append(el('h1', undefined, 'STONEWAKE'), el('p', 'tag', 'Two armies of living stone. One board.'), el('p', 'begin', 'CLICK TO BEGIN'));
    this.root.classList.add('intro');
    this.root.append(title);
    requestAnimationFrame(() => title.classList.add('show'));
    return new Promise((resolve) => {
      const begin = (): void => {
        title.removeEventListener('pointerdown', begin);
        removeEventListener('keydown', key);
        title.classList.remove('show');
        this.root.classList.remove('intro');
        setTimeout(() => title.remove(), 1400);
        resolve();
      };
      const key = (e: KeyboardEvent): void => {
        if (e.key === 'Enter' || e.key === ' ') begin();
      };
      title.addEventListener('pointerdown', begin);
      addEventListener('keydown', key);
    });
  }

  /** Hide the chrome during cinematic shots. */
  setCinema(on: boolean): void {
    this.root.classList.toggle('cinema', on);
  }

  askPromotion(side: Side): Promise<PieceType> {
    return new Promise((resolve) => {
      this.promotionChoices.replaceChildren();
      for (const type of ['q', 'r', 'b', 'n'] as PieceType[]) {
        const b = el('button');
        b.style.color = side === 'w' ? 'var(--ivory)' : '#aab1c4';
        b.append(GLYPH[type]);
        b.append(el('span', undefined, PIECE_NAME[type].toUpperCase()));
        b.onclick = () => {
          this.promotion.classList.remove('show');
          resolve(type);
        };
        this.promotionChoices.append(b);
      }
      this.promotion.classList.add('show');
    });
  }

  showGameOver(title: string, text: string): void {
    this.gameOverTitle.textContent = title;
    this.gameOverText.textContent = text;
    this.gameOver.classList.add('show');
  }

  hideGameOver(): void {
    this.gameOver.classList.remove('show');
  }

  static sideName(side: Side): string {
    return SIDE_NAME[side];
  }
}

/** The loading screen shown while assets download and the statues are built. */
export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly what: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div');
    this.root.id = 'loading';
    this.root.append(el('h1', undefined, 'STONEWAKE'));
    const bar = el('div', 'bar');
    this.bar = el('i');
    bar.append(this.bar);
    this.what = el('div', 'what', 'Waking the hall');
    this.root.append(bar, this.what);
    parent.append(this.root);
  }

  progress(fraction: number, what: string): void {
    this.bar.style.width = `${Math.round(fraction * 100)}%`;
    this.what.textContent = what;
  }

  done(): void {
    this.root.classList.add('done');
    setTimeout(() => this.root.remove(), 1200);
  }
}
