// The interface on a phone or tablet. It is the same Hud, built exactly as on the desktop (hud.ts
// is not involved in any of this); here its elements are re-homed for a small screen and fingers:
// the board keeps the screen, with only whose turn it is, the fallen pieces, UNDO and HURRY on
// it, and everything else moves into a sheet behind one menu button. All styling is in
// hud.touch.css, under `html.touch`. Never called on the desktop.
import './hud.touch.css';
import type { Insets } from '../cinema/seat';

export interface TouchChromeCallbacks {
  /** The HURRY button: play the rest of the move in flight quickly. */
  onHurry(): void;
}

export interface TouchChrome {
  /** CSS pixels the interface takes at each edge of the screen in its current arrangement. */
  insets(): Insets;
  /** Show or hide the HURRY button (a move with some way to go is playing). */
  setHurry(on: boolean): void;
  setMenu(open: boolean): void;
  readonly menuOpen: boolean;
  /** What online play shows now: the invite link, so it can be sent from the menu. */
  setInviteLink(link: string | null): void;
  /** One line of figures along the bottom of the screen (`?stats`), or null to remove it. */
  setStats(text: string | null): void;
  /** A card over everything with one button (the picture was lost and the page must reload). */
  showNotice(title: string, text: string, button: string, action: () => void): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const HINT = 'Tap a statue, then a glowing square.  Drag to turn, pinch to zoom.';
const SHARE_TITLE = 'Wizards Chess';
const SHARE_TEXT = 'Play me at Wizards Chess. This link is your seat:';

/** Whether the system's share sheet is there to be used. */
const canShare = (): boolean => typeof navigator.share === 'function';

function share(url: string): void {
  if (!url) return;
  // The player closing the sheet is not an error.
  navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT, url }).catch(() => {});
}

export function installTouchChrome(callbacks: TouchChromeCallbacks): TouchChrome {
  const root = document.getElementById('hud');
  if (!root) throw new Error('the HUD has not been built');
  const find = <T extends HTMLElement>(selector: string): T => {
    const e = root.querySelector<T>(selector);
    if (!e) throw new Error(`the HUD has no ${selector}`);
    return e;
  };
  const leftcol = find('.leftcol');
  const turn = find('.turn');
  const captured = find('.captured');
  const actions = find('.actions');
  const moves = find('.moves');
  const hint = find('.hint');
  const fresh = find<HTMLButtonElement>('.actions .newgame');
  const resign = find<HTMLButtonElement>('.actions .resign');

  // ---- on the board: a menu button, whose turn it is, the fallen, UNDO; and HURRY ----
  const menu = el('button', 'menu-button chrome');
  menu.setAttribute('aria-label', 'Menu');
  menu.setAttribute('aria-expanded', 'false');
  menu.append(el('i'), el('i'), el('i'));
  // One group, so that a phone on its side can stand them in a column down its left edge.
  const rail = el('div', 'rail');
  rail.append(menu, turn, captured, actions);
  const hurry = el('button', 'hurry', 'HURRY');
  hurry.setAttribute('aria-label', 'Hurry this move along');
  hurry.append(el('i', undefined, '▸▸'));
  hurry.onclick = () => callbacks.onHurry();
  hint.textContent = HINT;

  // ---- the menu: a sheet holding everything else ----
  const sheet = leftcol;
  sheet.classList.add('sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Menu');
  const head = el('div', 'sheet-head');
  const close = el('button', 'sheet-close', 'CLOSE');
  head.append(el('span', 'grip'), el('span', 'name', 'WIZARDS CHESS'), close);
  const game = el('div', 'sheet-game');
  game.append(fresh, resign);
  sheet.prepend(head, game);
  sheet.append(moves);
  const scrim = el('div', 'sheet-scrim');

  // What the board is left: measured from this box's padding, which the stylesheet sets for
  // each arrangement (it can resolve the device's safe areas; script cannot).
  const free = el('div', 'free-area');
  root.append(rail, hurry, scrim, free);
  // The sheet comes last so that it lies over the scrim.
  root.append(sheet);

  let open = false;
  const setMenu = (on: boolean): void => {
    if (on === open) return;
    open = on;
    root.classList.toggle('menu-open', on);
    menu.setAttribute('aria-expanded', String(on));
    if (on) sheet.scrollTop = 0;
  };
  // Opened and closed on click (after the finger has lifted), so the same touch cannot go on
  // to land on the board underneath.
  menu.addEventListener('click', () => setMenu(!open));
  close.addEventListener('click', () => setMenu(false));
  scrim.addEventListener('click', () => setMenu(false));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(false);
  });
  // Choices that leave the menu for the board close it behind them.
  sheet.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.newgame, .resign, .flip, .online .go, .online .mine button, .online .leave')) setTimeout(() => setMenu(false), 0);
  });

  // ---- sending an online game's link with the system's share sheet ----
  let inviteLink: string | null = null;
  const send = el('button', 'send', 'SEND INVITE LINK');
  send.hidden = true;
  send.onclick = () => share(inviteLink ?? '');
  const ingame = root.querySelector('.online .ingame');
  const copyInvite = ingame?.querySelector('button');
  if (ingame && copyInvite && canShare()) ingame.insertBefore(send, copyInvite);
  // LEAVE GAME is the last button of that panel; it has no class of its own to close the menu by.
  ingame?.querySelector('button:last-of-type')?.classList.add('leave');
  if (canShare()) {
    root.querySelectorAll<HTMLElement>('.share .linkrow').forEach((row, index) => {
      const input = row.querySelector('input');
      if (!input || index > 0) return;
      const b = el('button', 'secondary send', 'SEND');
      b.onclick = () => share(input.value);
      row.append(b);
      row.classList.add('with-send');
    });
  }

  // ---- the title is built later, by Hud.showTitle: reword its invitation when it appears ----
  new MutationObserver(() => {
    const begin = root.querySelector('#title .begin');
    if (begin && begin.textContent !== 'TAP TO BEGIN') begin.textContent = 'TAP TO BEGIN';
  }).observe(root, { childList: true });

  let stats: HTMLElement | null = null;
  const px = (v: string): number => Number.parseFloat(v) || 0;
  return {
    insets(): Insets {
      const s = getComputedStyle(free);
      return { top: px(s.paddingTop), right: px(s.paddingRight), bottom: px(s.paddingBottom), left: px(s.paddingLeft) };
    },
    setHurry(on: boolean): void {
      root.classList.toggle('hurry-on', on);
    },
    setMenu,
    get menuOpen(): boolean {
      return open;
    },
    setInviteLink(link: string | null): void {
      inviteLink = link;
      send.hidden = !link;
    },
    setStats(text: string | null): void {
      if (text === null) {
        stats?.remove();
        stats = null;
        return;
      }
      if (!stats) {
        stats = el('div', 'stats');
        root.append(stats);
      }
      if (stats.textContent !== text) stats.textContent = text;
    },
    showNotice(title: string, text: string, button: string, action: () => void): void {
      const overlay = el('div', 'overlay scrim notice show');
      const card = el('div', 'card panel');
      const b = el('button', 'primary', button);
      b.onclick = action;
      card.append(el('h2', undefined, title), el('p', undefined, text), b);
      overlay.append(card);
      root.append(overlay);
    },
  };
}
