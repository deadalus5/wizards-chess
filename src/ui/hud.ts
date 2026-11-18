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
  /** Online: create a game playing this side. */
  onOnlineCreate(side: Side | 'random'): void;
  /** Online: open one of this browser's games (by id). */
  onOnlineOpen(id: string): void;
  onOnlineLeave(): void;
  onResign(): void;
  onRematch(): void;
}

export type OpponentMode = 'pass' | 'computer' | 'auto' | 'online';

/** What the interface shows of online play. */
export interface OnlineView {
  /** False when no relay is configured: the ONLINE choice is not offered. */
  available: boolean;
  /** The ONLINE choice is open (a game or the lobby is shown in the panel). */
  open: boolean;
  /** A game being created (the CREATE button waits). */
  creating: boolean;
  game: null | {
    side: Side | null;
    connection: 'connecting' | 'live' | 'reconnecting' | 'gone';
    opponentOnline: boolean;
    myLink: string;
    inviteLink: string | null;
    over: boolean;
    rematch: { mine: boolean; theirs: boolean };
  };
  /** This browser's other online games, most recent first. */
  games: { id: string; side: Side; status: string; plies: number; current: boolean }[];
}
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
  private readonly onlineButton: HTMLButtonElement;
  private readonly onlineLobby: HTMLElement;
  private readonly onlineGame: HTMLElement;
  private readonly onlineSide: HTMLElement;
  private readonly onlineStatus: HTMLElement;
  private readonly inviteButton: HTMLButtonElement;
  private readonly myLinkButton: HTMLButtonElement;
  private readonly createButton: HTMLButtonElement;
  private readonly createSides = new Map<Side | 'random', HTMLButtonElement>();
  private readonly gamesList: HTMLElement;
  private readonly gamesBox: HTMLElement;
  private readonly againButton: HTMLButtonElement;
  private readonly rematchButton: HTMLButtonElement;
  private readonly rematchNote: HTMLElement;
  private readonly share: HTMLElement;
  private readonly shareText: HTMLElement;
  private readonly shareInvite: HTMLInputElement;
  private readonly shareMine: HTMLInputElement;
  private readonly confirmBox: HTMLElement;
  private readonly confirmTitle: HTMLElement;
  private readonly confirmText: HTMLElement;
  private readonly confirmYes: HTMLButtonElement;
  private readonly confirmNo: HTMLButtonElement;
  private createSide: Side | 'random' = 'w';
  private lastOpponent: OpponentView = { mode: 'pass', side: 'w', level: 'medium', paused: false };
  private online: OnlineView = { available: false, open: false, creating: false, game: null, games: [] };
  private onlineCallbacks: HudCallbacks | null = null;
  private turnSide: Side = 'w';
  private turnCheck = false;
  private thinking: Side | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, callbacks: HudCallbacks, settings: HudSettings) {
    const root = el('div');
    root.id = 'hud';
    this.root = root;

    root.append(el('div', 'wordmark chrome', 'WIZARDS CHESS'));

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

    // Online: two players, two links, no accounts.
    choice(modes, this.modeButtons, 'online', 'ONLINE', 'Play someone on another computer: share a link', callbacks.onMode);
    this.onlineButton = this.modeButtons.get('online')!;
    const online = group('online');
    this.onlineLobby = el('div', 'lobby');
    const playAs = el('div', 'playas');
    playAs.append(el('span', 'label', 'PLAY AS'));
    for (const [v, name] of [['w', 'IVORY'], ['b', 'OBSIDIAN'], ['random', 'RANDOM']] as [Side | 'random', string][]) {
      const b = el('button', undefined, name);
      b.title = v === 'random' ? 'Draw lots for the colours' : `You play ${name.toLowerCase()}`;
      b.onclick = () => {
        this.createSide = v;
        this.renderOnline();
      };
      this.createSides.set(v, b);
      playAs.append(b);
    }
    this.createButton = el('button', 'go', 'CREATE ONLINE GAME');
    this.createButton.title = 'Make a game and a link to send to your opponent';
    this.createButton.onclick = () => callbacks.onOnlineCreate(this.createSide);
    this.onlineLobby.append(playAs, this.createButton);
    this.onlineGame = el('div', 'ingame');
    this.onlineSide = el('div', 'who');
    this.onlineStatus = el('div', 'status');
    this.inviteButton = el('button', undefined, 'COPY INVITE LINK');
    this.inviteButton.title = 'The link to send your opponent';
    this.inviteButton.onclick = () => this.copy(this.online.game?.inviteLink ?? '', this.inviteButton);
    this.myLinkButton = el('button', undefined, 'COPY MY LINK');
    this.myLinkButton.title = 'Your own link: open it on any device to play your side';
    this.myLinkButton.onclick = () => this.copy(this.online.game?.myLink ?? '', this.myLinkButton);
    const leave = el('button', undefined, 'LEAVE GAME');
    leave.title = 'Back to this computer. The game waits on its links; come back any time.';
    leave.onclick = () => callbacks.onOnlineLeave();
    this.onlineGame.append(this.onlineSide, this.onlineStatus, this.inviteButton, this.myLinkButton, leave);
    this.gamesBox = el('div', 'mine');
    this.gamesBox.append(el('span', 'label', 'MY GAMES'));
    this.gamesList = el('div', 'list');
    this.gamesBox.append(this.gamesList);
    online.append(this.onlineLobby, this.onlineGame, this.gamesBox);
    this.onlineCallbacks = callbacks;
    // The opponent panel and, under it, the collapsible options share one column on the left.
    const leftcol = el('div', 'leftcol');
    const options = el('div', 'options panel chrome');
    const optionsHead = el('button', 'head', 'OPTIONS');
    const optionsBody = el('div', 'body');
    const setOpen = (open: boolean): void => {
      options.classList.toggle('open', open);
      optionsHead.setAttribute('aria-expanded', String(open));
    };
    let optionsOpen = false;
    try {
      optionsOpen = localStorage.getItem('stonewake.options') === '1';
    } catch {
      /* storage blocked: start collapsed */
    }
    setOpen(optionsOpen);
    optionsHead.title = 'Show or hide the options';
    optionsHead.onclick = () => {
      const open = !options.classList.contains('open');
      setOpen(open);
      try {
        localStorage.setItem('stonewake.options', open ? '1' : '0');
      } catch {
        /* the choice lasts until reload */
      }
    };
    options.append(optionsHead, optionsBody);
    leftcol.append(this.opponent, options);
    root.append(leftcol);

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
    this.followButton.classList.add('follow');
    const flip = el('button', 'flip', 'FLIP');
    flip.title = 'Look from the other side';
    flip.onclick = () => callbacks.onFlip();
    this.undoButton = el('button', 'undo', 'UNDO');
    this.undoButton.onclick = () => callbacks.onUndo();
    const fresh = el('button', 'newgame', 'NEW GAME');
    fresh.onclick = () => callbacks.onNewGame();
    const resign = el('button', 'resign', 'RESIGN');
    resign.title = 'Give up this online game';
    resign.onclick = () => callbacks.onResign();
    optionsBody.append(sound, cinema, this.followButton, flip);
    actions.append(this.undoButton, fresh, resign);
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
    this.againButton = el('button', 'primary again', 'NEW GAME');
    this.againButton.onclick = () => callbacks.onNewGame();
    this.rematchNote = el('p', 'note');
    this.rematchButton = el('button', 'primary rematch', 'REMATCH');
    this.rematchButton.title = 'Play again on the same links, colours swapped';
    this.rematchButton.onclick = () => callbacks.onRematch();
    const look = el('button', 'secondary', 'VIEW THE BOARD');
    look.onclick = () => this.gameOver.classList.remove('show');
    overCard.append(this.gameOverTitle, this.gameOverText, this.rematchNote, this.againButton, this.rematchButton, look);
    this.gameOver.append(overCard);
    root.append(this.gameOver);

    // After creating an online game: the links.
    this.share = el('div', 'overlay scrim share');
    const shareCard = el('div', 'card panel');
    this.shareText = el('p');
    this.shareInvite = el('input');
    this.shareMine = el('input');
    const linkRow = (label: string, input: HTMLInputElement): HTMLElement => {
      const row = el('div', 'linkrow');
      input.readOnly = true;
      input.onfocus = () => input.select();
      const b = el('button', 'secondary', 'COPY');
      b.onclick = () => this.copy(input.value, b, input);
      row.append(el('span', 'label', label), input, b);
      return row;
    };
    const shareDone = el('button', 'primary', 'TO THE BOARD');
    shareDone.onclick = () => this.share.classList.remove('show');
    shareCard.append(el('h2', undefined, 'THE BOARD IS SET'), this.shareText, linkRow('SEND TO YOUR OPPONENT', this.shareInvite), linkRow('YOUR OWN LINK — KEEP IT', this.shareMine), shareDone);
    this.share.append(shareCard);
    root.append(this.share);

    // A yes / no question (resigning).
    this.confirmBox = el('div', 'overlay scrim confirm');
    const confirmCard = el('div', 'card panel');
    this.confirmTitle = el('h2');
    this.confirmText = el('p');
    this.confirmYes = el('button', 'primary');
    this.confirmNo = el('button', 'secondary');
    const confirmRow = el('div', 'buttons');
    confirmRow.append(this.confirmYes, this.confirmNo);
    confirmCard.append(this.confirmTitle, this.confirmText, confirmRow);
    this.confirmBox.append(confirmCard);
    root.append(this.confirmBox);

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
    const game = this.online.game;
    if (game && game.side) {
      // Online: whose move it is from this player's chair, or that the line is down.
      const mine = this.turnSide === game.side;
      const down = game.connection !== 'live';
      this.chip.className = `chip ${this.turnSide}${!mine || down ? ' thinking' : ''}`;
      if (!this.flashTimer) {
        this.turnText.textContent = down ? 'RECONNECTING…' : game.over ? 'THE GAME IS OVER' : mine ? 'YOUR MOVE' : `WAITING FOR ${SIDE_NAME[this.turnSide].toUpperCase()}`;
      }
      this.checkText.textContent = this.turnCheck && !game.over ? 'CHECK' : '';
      return;
    }
    const side = this.thinking ?? this.turnSide;
    this.chip.className = `chip ${side}${this.thinking ? ' thinking' : ''}`;
    if (!this.flashTimer) this.turnText.textContent = `${SIDE_NAME[side].toUpperCase()} ${this.thinking ? 'IS THINKING' : 'TO MOVE'}`;
    this.checkText.textContent = this.turnCheck ? 'CHECK' : '';
  }

  /** Show online play as it stands (the panel, the turn bar, the buttons that change online). */
  setOnline(v: OnlineView): void {
    this.online = v;
    this.renderOnline();
    this.renderTurn();
  }

  private renderOnline(): void {
    const v = this.online;
    const g = v.game;
    this.onlineButton.hidden = !v.available;
    this.root.classList.toggle('online-game', !!g);
    this.root.classList.toggle('online-over', !!g?.over);
    this.opponent.dataset.mode = v.open || g ? 'online' : this.lastOpponent.mode;
    for (const [m, b] of this.modeButtons) b.setAttribute('aria-pressed', String(v.open || g ? m === 'online' : m === this.lastOpponent.mode));
    this.onlineLobby.hidden = !!g;
    this.onlineGame.hidden = !g;
    for (const [side, b] of this.createSides) b.setAttribute('aria-pressed', String(side === this.createSide));
    this.createButton.disabled = v.creating;
    this.createButton.textContent = v.creating ? 'CREATING…' : 'CREATE ONLINE GAME';
    if (g) {
      this.onlineSide.textContent = g.side ? `YOU PLAY ${SIDE_NAME[g.side].toUpperCase()}` : 'JOINING…';
      this.onlineSide.className = `who ${g.side ?? ''}`;
      this.onlineStatus.textContent =
        g.connection === 'live' ? (g.opponentOnline ? 'Your opponent is here.' : 'Your opponent is away.') : g.connection === 'gone' ? 'This game is closed.' : g.connection === 'connecting' ? 'Reaching the hall…' : 'Connection lost. Reconnecting…';
      this.onlineStatus.classList.toggle('here', g.connection === 'live' && g.opponentOnline);
      this.inviteButton.hidden = !g.inviteLink;
    }
    // Rematch in the game-over card.
    const rm = g?.rematch;
    this.rematchButton.disabled = !!rm?.mine;
    this.rematchButton.textContent = rm?.theirs && !rm.mine ? 'ACCEPT REMATCH' : 'REMATCH';
    const opp = g?.side ? SIDE_NAME[g.side === 'w' ? 'b' : 'w'] : 'Your opponent';
    this.rematchNote.textContent = !g ? '' : rm?.mine ? `Waiting for ${opp} to accept…` : rm?.theirs ? `${opp} asks for a rematch, colours swapped.` : 'A rematch swaps the colours; the links stay the same.';
    // This browser's games.
    const others = v.games;
    this.gamesBox.hidden = others.length === 0;
    this.gamesList.replaceChildren();
    for (const game of others.slice(0, 8)) {
      const b = el('button', game.current ? 'current' : undefined);
      b.append(el('i', `dot ${game.side}`), el('span', undefined, `${game.status}`), el('span', 'n', game.plies ? ` · move ${Math.ceil(game.plies / 2)}` : ''));
      b.title = game.current ? 'The game on the board' : `Open this game (you play ${SIDE_NAME[game.side]})`;
      b.onclick = () => this.onlineCallbacks?.onOnlineOpen(game.id);
      this.gamesList.append(b);
    }
  }

  /** After creating an online game: show both links. */
  showShare(inviteLink: string, myLink: string, mySide: Side): void {
    this.shareText.textContent = `Send the first link to your opponent; whoever opens it plays ${SIDE_NAME[mySide === 'w' ? 'b' : 'w']}. You play ${SIDE_NAME[mySide]}: your own link is in the address bar — bookmark it, or keep the second link, to come back to this game on any device.`;
    this.shareInvite.value = inviteLink;
    this.shareMine.value = myLink;
    this.share.classList.add('show');
  }

  /** A yes / no question in a card over the board. */
  confirm(title: string, text: string, yes: string, no: string): Promise<boolean> {
    this.confirmTitle.textContent = title;
    this.confirmText.textContent = text;
    this.confirmYes.textContent = yes;
    this.confirmNo.textContent = no;
    this.confirmBox.classList.add('show');
    return new Promise((resolve) => {
      const done = (answer: boolean): void => {
        this.confirmBox.classList.remove('show');
        resolve(answer);
      };
      this.confirmYes.onclick = () => done(true);
      this.confirmNo.onclick = () => done(false);
    });
  }

  /** Copy text to the clipboard, saying so on the button; or offer it to copy by hand. */
  private copy(text: string, button: HTMLButtonElement, input?: HTMLInputElement): void {
    if (!text) return;
    const label = button.dataset.label ?? button.textContent ?? '';
    button.dataset.label = label;
    const said = (what: string): void => {
      button.textContent = what;
      setTimeout(() => (button.textContent = label), 1600);
    };
    const byHand = (): void => {
      if (input) {
        input.focus();
        input.select();
        said('PRESS ⌘C');
      } else prompt('Copy this link:', text);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => said('COPIED'), byHand);
    else byHand();
  }

  /** Show the opponent choices as they stand. */
  setOpponent(v: OpponentView): void {
    this.lastOpponent = v;
    for (const [m, b] of this.modeButtons) b.setAttribute('aria-pressed', String(m === v.mode));
    for (const [s, b] of this.sideButtons) b.setAttribute('aria-pressed', String(s === v.side));
    for (const [l, b] of this.levelButtons) b.setAttribute('aria-pressed', String(l === v.level));
    this.opponent.dataset.mode = v.mode;
    this.pauseButton.dataset.paused = v.paused ? '1' : '0';
    this.pauseButton.textContent = v.paused ? 'RESUME' : 'PAUSE';
    this.pauseButton.setAttribute('aria-pressed', String(!v.paused));
    this.renderOnline();
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
    title.append(el('h1', undefined, 'WIZARDS CHESS'), el('p', 'tag', 'Two armies of living stone. One board.'), el('p', 'begin', 'CLICK TO BEGIN'));
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
    this.root.append(el('h1', undefined, 'WIZARDS CHESS'));
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
