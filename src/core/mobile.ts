// Everything a phone or tablet needs that the desktop does not, in one place:
//
//   - the page set up for fingers, and the touch interface (ui/touchChrome.ts);
//   - the camera seated so the whole board fits the screen, whichever way it is held;
//   - the picture sized to what the device can draw: a level chosen from timings taken behind
//     the loading screen (quality.ts, calibrate.ts), held at an even pace, eased off further
//     if the device heats and slows, and rested while nothing on the board moves;
//   - a phone's habits: sound that starts on a finger lifting and stops when the page is left,
//     a game that survives the page being thrown away, a screen kept awake while the computer
//     plays itself, a picture the system may take back at any moment.
//
// main.ts loads this file only on a touch device: on the desktop none of it runs or is fetched.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { Opponent } from '../ai/opponent';
import type { GameAudio } from '../audio/audio';
import type { ChessGame } from '../chess/game';
import type { CameraRig } from '../cinema/cameraRig';
import { TALL_SHOT, WIDE_SHOT, type Cinema } from '../cinema/cinema';
import { seatFor } from '../cinema/seat';
import type { Effects } from '../fx/effects';
import type { ShatterSystem } from '../fx/shatter';
import type { GameController } from '../game/controller';
import { decodeSaved, encodeSaved, SAVED_KEY, shouldRestore, type SavedMode } from '../game/saved';
import type { Side } from '../game/squares';
import type { Picker } from '../input/picker';
import { parseLink } from '../net/protocol';
import { configureAssets, withRetries } from '../pieces/assets';
import type { Pipeline } from '../render/pipeline';
import type { BoardReflection } from '../render/reflection';
import type { Director } from '../sequence/director';
import type { Hud, OnlineView } from '../ui/hud';
import { installTouchChrome, type TouchChrome } from '../ui/touchChrome';
import { measure, timeFrames, type Bench } from './calibrate';
import { TOUCH_RENDER, type Profile } from './device';
import type { FrameLoop } from './loop';
import { AFTER_A_DEATH, BUDGET_MS, cameLate, chooseLevel, Governor, ladder, pixelRatioFor, type AoMode, type Level, type Timings } from './quality';

/** Colour of the browser's own furniture round the page (the status bar, the toolbar). */
const THEME = '#06070a';
/** Megapixels drawn until the device has been measured: the least any buffer need be. */
const START_PIXELS = 0.7;
/** Frames a second while nothing on the board moves. */
const IDLE_FPS = 30;
/** The level used when the device cannot be measured (the page was opened in the background). */
const UNMEASURED_LEVEL = 2;

const ALIVE_KEY = 'stonewake.alive';
const DEATHS_KEY = 'stonewake.deaths';
const QUALITY_KEY = 'stonewake.quality';
/** A measurement is trusted for this long before the device is measured again. */
const QUALITY_KEEP_MS = 3 * 24 * 3600 * 1000;

/** Visits in a row that ended with the page being killed while it was on screen. */
let deaths = 0;

/**
 * iOS Safari kills a page that uses too much memory and loads it again, with no event first;
 * do that twice and it gives up on the page. So a marker is kept while the page is on screen
 * and cleared when it is hidden or left: finding it still set means the last visit died in
 * view, and this one starts lighter.
 */
function noteLastVisit(): void {
  try {
    deaths = localStorage.getItem(ALIVE_KEY) === '1' ? Math.min(3, Number(localStorage.getItem(DEATHS_KEY) ?? 0) + 1) : 0;
    localStorage.setItem(DEATHS_KEY, String(deaths));
    const mark = (): void => {
      try {
        if (document.visibilityState === 'visible') localStorage.setItem(ALIVE_KEY, '1');
        else localStorage.removeItem(ALIVE_KEY);
      } catch {
        /* storage blocked: every visit counts as a clean one */
      }
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    addEventListener('pagehide', () => {
      try {
        localStorage.removeItem(ALIVE_KEY);
      } catch {
        /* as above */
      }
    });
  } catch {
    deaths = 0;
  }
}

/**
 * Make the page one for fingers, before anything is drawn: the classes the touch stylesheet
 * hangs on, a viewport that runs under the notch (the interface keeps clear of it by itself),
 * and no pinching of the page from Safari's own gesture.
 */
export function prepareTouchPage(profile: Profile): void {
  document.documentElement.classList.add('touch', profile.kind);
  const viewport = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
  if (viewport) viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  const theme = document.createElement('meta');
  theme.name = 'theme-color';
  theme.content = THEME;
  document.head.append(theme);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault());
  // A phone's connection drops requests; one lost file should not end the loading.
  configureAssets({ retries: 3 });
  noteLastVisit();
  // After a death, the smallest shadow map as well (it is fixed when the lights are made).
  if (deaths > 0) profile.render = { ...TOUCH_RENDER, shadowMapSize: 1024, shadowRadius: 0.65 };
}

/**
 * The game could not start. Say so in plain words, with a way to try again: on a phone a
 * stack trace is no use to anyone, and the likeliest causes are a dropped connection or a
 * browser too old to draw the game.
 */
export function showFailure(err: unknown): void {
  const detail = String((err as { message?: unknown })?.message ?? err).slice(0, 240);
  const cannotDraw = /webgl|context|render target|half-float/i.test(detail);
  document.getElementById('loading')?.remove();
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:28px;box-sizing:border-box;background:#06070a;color:#e9e2d2;text-align:center;font:16px/1.5 "Iowan Old Style",Palatino,Georgia,serif';
  const title = document.createElement('div');
  title.textContent = cannotDraw ? 'THIS BROWSER CANNOT SHOW THE HALL' : 'THE HALL COULD NOT BE REACHED';
  title.style.cssText = 'font:500 18px/1.4 Cinzel,"Times New Roman",serif;letter-spacing:0.22em';
  const text = document.createElement('div');
  text.textContent = cannotDraw ? 'The game needs a recent browser with WebGL 2 (Safari on iOS 16.4 or later, or a current Chrome).' : 'Something was lost on the way. Check the connection and try again.';
  text.style.cssText = 'max-width:30em;color:rgba(233,226,210,0.7)';
  const again = document.createElement('button');
  again.textContent = 'TRY AGAIN';
  again.style.cssText = 'min-height:48px;padding:0 28px;background:transparent;border:1px solid #e3b866;border-radius:10px;color:#e3b866;font:500 12px Cinzel,"Times New Roman",serif;letter-spacing:0.26em';
  again.onclick = () => location.reload();
  const small = document.createElement('div');
  small.textContent = detail;
  small.style.cssText = 'max-width:34em;font:11px/1.4 ui-monospace,Menlo,monospace;color:rgba(233,226,210,0.32);overflow-wrap:anywhere';
  box.append(title, text, again, small);
  document.body.append(box);
}

/** The lighting environment, fetched with the same patience as the other files. */
export function loadEnvironment(url: string): Promise<THREE.DataTexture> {
  return withRetries(() => new HDRLoader().loadAsync(url));
}

/**
 * Let the page draw between two long pieces of loading work: `show` updates the loading
 * screen, and the promise resolves once the browser has had a frame to paint it in (or, in a
 * background tab that is given no frames, after a moment).
 */
export function pauseForLoading(show: () => void): Promise<void> {
  show();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 120);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 0),
    );
  });
}

/** How many pixels main.ts draws (it reads these whenever it sizes the picture). */
export interface Sizing {
  pixelRatio(): number;
  /** Whether the board mirror's buffer is kept at size. */
  mirror: boolean;
}

/** Until the device has been measured, draw as little as any level would: nothing is seen of it yet. */
export function startSmall(sizing: Sizing): void {
  sizing.pixelRatio = () => pixelRatioFor(START_PIXELS, innerWidth, innerHeight, devicePixelRatio);
}

export interface MobileDeps {
  profile: Profile;
  rig: CameraRig;
  picker: Picker;
  director: Director;
  controller: GameController;
  game: ChessGame;
  opponent: Opponent;
  hud: Hud;
  audio: GameAudio;
  pipeline: Pipeline;
  reflection: BoardReflection | null;
  /** Strength of the board's mirror when it is on. */
  mirrorStrength: number;
  loop: FrameLoop;
  cinema: Cinema;
  shatter: ShatterSystem;
  fx: Effects;
  sizing: Sizing;
  /** Resize the picture to the window (main.ts's own). */
  fit(): void;
}

/** What the touch profile is doing, for the `?stats` line and the debug API. */
export interface MobileState {
  /** The level drawn at, counted from 1 (the fullest), of how many. */
  level: number;
  levels: number;
  settings: Level;
  /** How it was arrived at. */
  source: 'measured' | 'remembered' | 'unmeasured' | 'forced';
  timings: Timings | null;
  /** Levels given up since: because the device slowed, and because the last visit died. */
  steppedDown: number;
  deaths: number;
  fps: number;
  /** Share of recent frames in motion that came late. */
  late: number;
  idle: boolean;
  shadowsHeld: boolean;
}

export interface Mobile {
  readonly chrome: TouchChrome;
  /**
   * Behind the loading screen, once everything is built and warmed up: choose the level to
   * draw at, and put back a game that was left unfinished. `say` names what is going on.
   */
  begin(say?: (what: string) => void): Promise<void>;
  /** Every frame, after the game has moved on and before it is drawn. */
  beforeRender(): void;
  /** Every frame, after it has been drawn. */
  afterFrame(dt: number): void;
  /** The seat to look from when the title lifts. */
  openingSide(): Side;
  state(): MobileState;
  /** Draw at a given level (from 1), as `?level=` does. For testing. */
  setLevel(level: number): void;
  /** Measure again, now (the picture jumps while it does). `load` draws every frame that many times, to stand in for a slower device. */
  calibrate(load?: number): MobileState;
  /** Whether the shadow map is redrawn only while something that casts a shadow moves. For testing. */
  shadowCache: boolean;
  /**
   * For testing. With the clock stopped (the debug API stepping by hand) the shadow map is
   * normally redrawn with every frame, since anything may have been moved; set this to leave
   * it held, so that a still can show what the held map looks like.
   */
  holdShadowsWhenStopped: boolean;
  /** For testing: draw every measured frame this many times, to stand in for a slower device. */
  load: number;
}

interface Remembered {
  v: 1;
  key: string;
  index: number;
  at: number;
}

export function installMobile(d: MobileDeps): Mobile {
  const { rig, director, controller, game, opponent, hud, audio, pipeline, loop, cinema, shatter, fx } = d;
  const renderer = pipeline.renderer;
  const chrome = installTouchChrome({ onHurry: () => director.hurry() });
  const query = new URLSearchParams(location.search);
  const kind = d.profile.kind === 'tablet' ? 'tablet' : 'phone';
  const levels = ladder(kind);

  // ------------------------------------------------------------------ the level drawn at
  let index = Math.min(UNMEASURED_LEVEL, levels.length - 1);
  let megapixels = START_PIXELS;
  let source: MobileState['source'] = 'unmeasured';
  let timings: Timings | null = null;
  let steppedDown = 0;
  let aoMode: AoMode = 'Medium';
  // The ambient occlusion's half-size depth pass draws to a float target; without that
  // ability it would draw garbage, so it is left out.
  const floatTargets = renderer.extensions.has('EXT_color_buffer_float');
  // The whole picture is drawn into half-float buffers: without those there is none to show.
  if (!floatTargets && !renderer.extensions.has('EXT_color_buffer_half_float')) throw new Error('This device cannot draw to half-float render targets, which the picture is built from.');
  d.sizing.pixelRatio = () => pixelRatioFor(megapixels, innerWidth, innerHeight, devicePixelRatio);

  const setMirror = (on: boolean): void => {
    d.sizing.mirror = on;
    // (Strength 0, not merely "disabled": the board would go on showing the last image drawn.)
    if (d.reflection) d.reflection.strength = on ? d.mirrorStrength : 0;
  };
  const setAo = (mode: AoMode): void => {
    const on = floatTargets && mode !== 'off';
    pipeline.ao.enabled = on;
    if (on && mode !== aoMode) {
      pipeline.ao.setQualityMode(mode);
      aoMode = mode;
    }
  };
  const apply = (to: number): void => {
    index = Math.max(0, Math.min(levels.length - 1, to));
    const level = levels[index];
    megapixels = level.pixels;
    setMirror(level.mirror);
    setAo(level.ao);
    pipeline.dofAllowed = level.dof;
    d.fit();
  };

  // ------------------------------------------------------------------ measuring
  const pixel = new Uint8Array(4);
  const gl = renderer.getContext();
  const finish = (): void => {
    // Reading a pixel back does not return until everything asked for has been drawn.
    renderer.setRenderTarget(null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  };
  /** (Testing: every frame measured is drawn this many times, as a slower device would feel.) */
  let load = 1;
  const drawOnce = (): void => {
    for (let i = 0; i < load; i++) {
      d.reflection?.render(renderer);
      pipeline.render(0);
    }
  };
  /** Put the heaviest ordinary frame on the stage: a close shot with depth of field and the particle layer on. */
  const stage = (): (() => void) => {
    const was = { override: rig.override, overlay: pipeline.overlayPass.enabled, dof: pipeline.dofAllowed, shadows: renderer.shadowMap.autoUpdate };
    rig.override = { position: new THREE.Vector3(2.3, 1.55, 2.6), target: new THREE.Vector3(0.75, 1.25, 0), fov: 26 };
    rig.update(0);
    pipeline.focus.set(0.75, 1.25, 0);
    pipeline.dofAllowed = true;
    pipeline.setDepthOfField(7.5, 3.6);
    pipeline.overlayPass.enabled = true;
    // A move redraws the shadow map every frame.
    renderer.shadowMap.autoUpdate = true;
    return () => {
      rig.override = was.override;
      rig.update(0);
      pipeline.dofAllowed = was.dof;
      pipeline.setDepthOfField(0);
      pipeline.overlayPass.enabled = was.overlay;
      renderer.shadowMap.autoUpdate = was.shadows;
    };
  };
  const take = (): Timings => {
    const native = (innerWidth * innerHeight * devicePixelRatio * devicePixelRatio) / 1e6;
    const high = Math.min(levels[0].pixels, native);
    const low = Math.min(START_PIXELS, high * 0.6);
    const bench: Bench = {
      resize: (mp) => {
        megapixels = mp;
        d.fit();
      },
      setMirror,
      setAo: (on) => (pipeline.ao.enabled = on && floatTargets),
      time: () => timeFrames(drawOnce, finish),
    };
    const unstage = stage();
    try {
      return measure(bench, low, high);
    } finally {
      unstage();
    }
  };

  const cacheKey = (): string => `${kind}:${devicePixelRatio}:${Math.max(innerWidth, innerHeight)}x${Math.min(innerWidth, innerHeight)}:${floatTargets ? 'f' : 'h'}`;
  const remembered = (): number | null => {
    try {
      const r = JSON.parse(localStorage.getItem(QUALITY_KEY) ?? 'null') as Remembered | null;
      if (!r || r.v !== 1 || r.key !== cacheKey() || Date.now() - r.at > QUALITY_KEEP_MS || !(r.index >= 0 && r.index < levels.length)) return null;
      return r.index;
    } catch {
      return null;
    }
  };
  const remember = (i: number): void => {
    try {
      const r: Remembered = { v: 1, key: cacheKey(), index: i, at: Date.now() };
      localStorage.setItem(QUALITY_KEY, JSON.stringify(r));
    } catch {
      /* measured again next time */
    }
  };

  // ------------------------------------------------------------------ the picture and the seat follow the screen
  let seen = `${innerWidth}x${innerHeight}`;
  // A picture whose size changes with the level and the way the device is held: the blur of a
  // shot is sized by the scene, not by its pixels.
  cinema.blurByFrame = true;
  const reseat = (immediate: boolean): void => {
    rig.setSeat(seatFor(innerWidth, innerHeight, chrome.insets()), immediate);
    // Held upright, the cinematic shots are composed for a tall frame.
    cinema.style = innerWidth < innerHeight ? TALL_SHOT : WIDE_SHOT;
  };
  // A rotation arrives as a flurry of resizes, and every one of them would rebuild every buffer.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const later = (): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      const size = `${innerWidth}x${innerHeight}`;
      if (size === seen) return;
      seen = size;
      d.fit();
      reseat(false);
    }, 140);
  };
  addEventListener('resize', later);
  addEventListener('orientationchange', later);
  window.visualViewport?.addEventListener('resize', later);
  reseat(true);

  // ------------------------------------------------------------------ a move the player has zoomed away from is not played out of sight
  controller.onMove((event) => {
    if (rig.zoomed < 0.08) return;
    const margin = 24;
    const hidden = [event.from, event.to].some((square) => {
      const p = d.picker.screenOf(square, 0.9);
      return !p || p.x < margin || p.x > innerWidth - margin || p.y < margin || p.y > innerHeight - margin;
    });
    if (hidden) rig.recentre();
  });

  // ------------------------------------------------------------------ sound
  // A finger coming down is not a gesture the browser will start sound on; its lifting is.
  // And a phone suspends sound whenever the page is left.
  const wake = (): void => audio.unlock();
  for (const type of ['pointerup', 'touchend', 'click']) addEventListener(type, wake, { passive: true });

  // ------------------------------------------------------------------ the invite link, for the menu's SEND button
  const setOnline = hud.setOnline.bind(hud);
  hud.setOnline = (view: OnlineView): void => {
    setOnline(view);
    chrome.setInviteLink(view.game?.inviteLink ?? null);
  };

  // ------------------------------------------------------------------ a game that survives the page being thrown away
  const save = (): void => {
    try {
      if (opponent.mode === 'online') return;
      const moves = game.historyUci();
      if (opponent.mode === 'auto' || !game.standardStart || !moves.length || game.status().over) localStorage.removeItem(SAVED_KEY);
      else localStorage.setItem(SAVED_KEY, encodeSaved(opponent.mode as SavedMode, opponent.humanSide, moves, Date.now()));
    } catch {
      /* storage blocked: the game lasts as long as the page */
    }
  };
  const restore = (): void => {
    // An online game named in the address comes from the relay, not from here.
    if (parseLink(location.hash)) return;
    let saved = null;
    try {
      saved = decodeSaved(localStorage.getItem(SAVED_KEY), Date.now());
    } catch {
      return;
    }
    if (!shouldRestore(saved, opponent.mode, opponent.humanSide)) return;
    try {
      controller.loadMoves(saved.moves);
    } catch {
      localStorage.removeItem(SAVED_KEY);
    }
  };

  // ------------------------------------------------------------------ the screen stays awake while the computer plays itself
  let lock: WakeLockSentinel | null = null;
  let asking = false;
  const tendWakeLock = (): void => {
    const want = opponent.mode === 'auto' && !opponent.paused && document.visibilityState === 'visible';
    if (want && !lock && !asking && 'wakeLock' in navigator) {
      asking = true;
      navigator.wakeLock
        .request('screen')
        .then(
          (sentinel) => {
            lock = sentinel;
            sentinel.addEventListener('release', () => (lock = null));
          },
          () => {
            /* refused (low battery, not allowed): the screen dims as usual */
          },
        )
        .finally(() => (asking = false));
    } else if (!want && lock) {
      void lock.release();
      lock = null;
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      audio.unlock();
      tendWakeLock();
    }
  });

  // ------------------------------------------------------------------ the picture can be taken away
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    loop.stop();
    chrome.showNotice('THE HALL WENT DARK', 'The device took the picture back for something else. Your game is kept.', 'RETURN TO THE BOARD', () => location.reload());
  });

  // ------------------------------------------------------------------ pacing, frame by frame
  const governor = new Governor();
  const shadowMap = renderer.shadowMap;
  let shadowCache = true;
  let holdShadowsWhenStopped = false;
  /** Frames the shadow map is still redrawn for after the last thing moved. */
  let tail = 4;
  let quiet = 0;
  let idle = false;
  let lastMissed = 0;
  let lastFrameAt = performance.now();
  let begun = false;
  controller.onSettled(() => (tail = 4));

  // Figures for the stats line and the debug API, over the last second or so.
  const showStats = query.has('stats');
  let statFrames = 0;
  let statLate = 0;
  let statMoving = 0;
  let statSince = performance.now();
  let fps = 0;
  let lateShare = 0;
  let sinceTend = 0;

  const state = (): MobileState => ({ level: index + 1, levels: levels.length, settings: levels[index], source, timings, steppedDown, deaths, fps, late: lateShare, idle, shadowsHeld: begun && shadowCache && !shadowMap.autoUpdate && tail === 0 });

  return {
    chrome,

    async begin(say): Promise<void> {
      loop.auto = false;
      const forced = Number(query.get('level'));
      let chosen: number;
      const known = query.has('calibrate') ? null : remembered();
      if (forced >= 1 && forced <= levels.length) {
        chosen = forced - 1;
        source = 'forced';
      } else if (known !== null) {
        chosen = known;
        source = 'remembered';
      } else if (document.visibilityState !== 'visible') {
        // Opened in the background, where a browser draws slowly if at all: not the time to judge.
        chosen = Math.min(UNMEASURED_LEVEL, levels.length - 1);
        source = 'unmeasured';
      } else {
        say?.('Measuring the light');
        await new Promise<void>((r) => setTimeout(r, 30));
        timings = take();
        chosen = chooseLevel(levels, timings);
        source = 'measured';
        remember(chosen);
      }
      steppedDown = source === 'forced' ? 0 : deaths * AFTER_A_DEATH;
      apply(chosen + steppedDown);
      steppedDown = index - chosen;

      // From here the shadow map is redrawn when asked (see beforeRender); the warm-up before
      // this needed it drawn with every frame, to compile the breaking statues' shadows.
      shadowMap.autoUpdate = false;
      shadowMap.needsUpdate = true;
      loop.cap = levels[index].fps;

      // The game left unfinished, then the hooks that keep it (in that order: the board set up
      // at boot must not be saved over it).
      restore();
      controller.onMove(save);
      controller.onSettled(save);
      begun = true;
    },

    beforeRender(): void {
      if (!begun) return;
      if (!shadowCache) {
        shadowMap.needsUpdate = true;
        return;
      }
      // Statues move only in a move being played out, as rubble, or when the board is set up
      // afresh (which settles the controller); chips fly a little longer. With the clock
      // stopped (the debug API stepping by hand) anything may have been moved.
      const moving = (!loop.isRunning && !holdShadowsWhenStopped) || director.playing || shatter.active || fx.shards.alive > 0;
      if (moving) tail = 4;
      else if (tail > 0) tail--;
      if (moving || tail > 0) shadowMap.needsUpdate = true;
    },

    afterFrame(dt: number): void {
      if (!begun) return;
      // HURRY is offered only while there is something worth hurrying.
      chrome.setHurry(director.playing && !director.hurried && director.remaining > 1.5);

      // Full pace while anything moves; at rest, half of it (the fires flicker and the dust
      // drifts as well at 30, and a phone that is not hot stays fast).
      const level = levels[index];
      const moving = director.playing || shatter.active || fx.shards.alive > 0 || cinema.active || rig.moving;
      quiet = moving ? 0 : quiet + dt;
      const wasIdle = idle;
      idle = quiet > 0.6;
      loop.cap = idle ? Math.min(level.fps, IDLE_FPS) : level.fps;

      // Frames that came late while something moved: by the loop's own count (a refresh
      // missed), or by the clock (the pace wanted is not being reached at all).
      const now = performance.now();
      const missed = loop.missed - lastMissed;
      lastMissed = loop.missed;
      const late = missed > 0 || cameLate(now - lastFrameAt, level.fps) ? 1 : missed;
      lastFrameAt = now;
      if (moving && !wasIdle) {
        governor.frame(late);
        statMoving++;
        statLate += Math.max(0, late);
      }
      // Between moves, if it has been struggling: look again at what a frame costs, and if it
      // really is over budget, draw less. If it is not (the display itself is running slowly,
      // as in a phone's low power mode, or the device was busy with something else), leave the
      // picture alone, and do not look again for a good while.
      if (governor.struggling && !director.playing && !cinema.active) {
        if (index < levels.length - 1 && timeFrames(drawOnce, finish) > BUDGET_MS[level.fps] * 0.85) {
          apply(index + 1);
          steppedDown++;
          loop.cap = levels[index].fps;
          governor.settle();
        } else governor.settle(3600);
        lastFrameAt = performance.now();
      }

      statFrames++;
      sinceTend += dt;
      if (sinceTend > 1) {
        sinceTend = 0;
        tendWakeLock();
        fps = Math.round((statFrames * 1000) / Math.max(1, now - statSince));
        lateShare = statMoving ? statLate / statMoving : 0;
        statFrames = statMoving = statLate = 0;
        statSince = now;
        if (showStats) {
          const size = pipeline.renderSize;
          const cost = timings ? ` · ${timings.fullLow.toFixed(1)}/${timings.fullHigh.toFixed(1)} ms` : '';
          chrome.setStats(`${d.profile.kind} · L${index + 1}/${levels.length} ${source}${steppedDown ? ` -${steppedDown}` : ''} · ${size.width}x${size.height} · ${fps} fps${idle ? ' idle' : ''} · late ${(lateShare * 100).toFixed(0)}%${cost}`);
        }
      }
    },

    openingSide(): Side {
      // A game taken up again in pass and play opens from the side to move, as it was left.
      return controller.seat ?? (controller.followTurn ? (game.turn() as Side) : 'w');
    },

    state,

    setLevel(level: number): void {
      apply(level - 1);
      source = 'forced';
      steppedDown = 0;
      loop.cap = levels[index].fps;
      governor.settle();
    },

    calibrate(times = load): MobileState {
      const was = load;
      load = Math.max(1, Math.round(times));
      try {
        timings = take();
      } finally {
        load = was;
      }
      const chosen = chooseLevel(levels, timings);
      source = 'measured';
      steppedDown = 0;
      apply(chosen);
      loop.cap = levels[index].fps;
      shadowMap.needsUpdate = true;
      governor.settle();
      return state();
    },

    get shadowCache(): boolean {
      return shadowCache;
    },
    set shadowCache(on: boolean) {
      shadowCache = on;
      tail = 4;
    },
    get holdShadowsWhenStopped(): boolean {
      return holdShadowsWhenStopped;
    },
    set holdShadowsWhenStopped(on: boolean) {
      holdShadowsWhenStopped = on;
    },
    get load(): number {
      return load;
    },
    set load(times: number) {
      load = Math.max(1, Math.round(times));
    },
  };
}
