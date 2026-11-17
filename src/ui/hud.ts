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
    this.chip.className = `chip ${side}`;
    this.turnText.textContent = `${SIDE_NAME[side].toUpperCase()} TO MOVE`;
    this.checkText.textContent = check ? 'CHECK' : '';
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
