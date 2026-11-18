// What the page has been opened on, decided once at load: a desktop (the game as it has always
// been), or a phone or tablet, which get the touch interface, lighter assets and a picture
// sized to what the device can draw. Nothing here is chosen by the player.

export type DeviceKind = 'desktop' | 'phone' | 'tablet';

/** The facts the decision is made from (gathered by `readDeviceEnv`; given directly in tests). */
export interface DeviceEnv {
  userAgent: string;
  maxTouchPoints: number;
  /** The primary pointer is a finger: `(pointer: coarse)`. */
  coarse: boolean;
  /** The primary pointer cannot hover: `(hover: none)`. */
  noHover: boolean;
  /** The shorter side of the screen, in CSS pixels. */
  screenShort: number;
  /** `location.search`: `?profile=desktop|phone|tablet` forces the answer (for testing). */
  search: string;
}

const KINDS: readonly DeviceKind[] = ['desktop', 'phone', 'tablet'];
/** Below this shorter side a touch device of unknown make is taken for a phone. */
const TABLET_SHORT_SIDE = 600;

export function classifyDevice(env: DeviceEnv): DeviceKind {
  const forced = new URLSearchParams(env.search).get('profile');
  if (forced && (KINDS as readonly string[]).includes(forced)) return forced as DeviceKind;

  const ua = env.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (/iPad/.test(ua)) return 'tablet';
  // iPadOS asks for desktop sites by default and calls itself a Mac; no Mac has a touch screen.
  if (/Macintosh/.test(ua) && env.maxTouchPoints > 1) return 'tablet';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'phone' : 'tablet';

  // Anything else: a device whose main pointer is a finger. A laptop with a touch screen has a
  // fine primary pointer and stays a desktop.
  if (env.maxTouchPoints > 0 && env.coarse && env.noHover) return env.screenShort < TABLET_SHORT_SIDE ? 'phone' : 'tablet';
  return 'desktop';
}

export function readDeviceEnv(): DeviceEnv {
  const match = (query: string): boolean => typeof matchMedia === 'function' && matchMedia(query).matches;
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    coarse: match('(pointer: coarse)'),
    noHover: match('(hover: none)'),
    screenShort: Math.min(screen.width, screen.height),
    search: location.search,
  };
}

/** What is built differently for the picture. The desktop values are the game's own constants. */
export interface RenderSettings {
  /** Load the smaller textures and environment in `assets/lite`. */
  lite: boolean;
  /** Side of each layer of the statues' normal-map array, in pixels. */
  normalSize: number;
  /** Let go of the normal array's CPU copy once it is on the GPU. */
  releaseNormals: boolean;
  shadowMapSize: number;
  /** Blur of the shadow's edge, in texels of the shadow map. */
  shadowRadius: number;
  /** Anisotropy of the board and hall textures. */
  anisotropy: number;
  /** Side of the key light's window-tracery pattern, in pixels. */
  cookieSize: number;
  antialias: 'smaa' | 'fxaa';
  /** Scale of the bloom's bright-pass buffer (its only full-size pass). */
  bloomLuminanceScale: number;
}

export const DESKTOP_RENDER: RenderSettings = {
  lite: false,
  normalSize: 2048,
  releaseNormals: false,
  shadowMapSize: 4096,
  shadowRadius: 2.5,
  anisotropy: 16,
  cookieSize: 1024,
  antialias: 'smaa',
  bloomLuminanceScale: 1,
};

export const TOUCH_RENDER: RenderSettings = {
  lite: true,
  normalSize: 1024,
  releaseNormals: true,
  shadowMapSize: 2048,
  // Half the texels across the same ground: half the radius keeps the edge as soft.
  shadowRadius: 1.25,
  anisotropy: 4,
  cookieSize: 512,
  antialias: 'fxaa',
  bloomLuminanceScale: 0.5,
};

export interface Profile {
  kind: DeviceKind;
  /** A phone or tablet. */
  touch: boolean;
  render: RenderSettings;
}

export function profileFor(kind: DeviceKind): Profile {
  const touch = kind !== 'desktop';
  return { kind, touch, render: touch ? TOUCH_RENDER : DESKTOP_RENDER };
}
