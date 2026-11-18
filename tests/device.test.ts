import { describe, expect, it } from 'vitest';
import { classifyDevice, DESKTOP_RENDER, profileFor, type DeviceEnv } from '../src/core/device';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const IPAD_OLD = 'Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const env = (patch: Partial<DeviceEnv>): DeviceEnv => ({ userAgent: MAC, maxTouchPoints: 0, coarse: false, noHover: false, screenShort: 1117, search: '', ...patch });
const finger = { maxTouchPoints: 5, coarse: true, noHover: true };

describe('classifyDevice', () => {
  it('leaves desktops alone', () => {
    expect(classifyDevice(env({}))).toBe('desktop');
    expect(classifyDevice(env({ userAgent: MAC_SAFARI }))).toBe('desktop');
    expect(classifyDevice(env({ userAgent: WINDOWS }))).toBe('desktop');
    expect(classifyDevice(env({ userAgent: LINUX }))).toBe('desktop');
  });

  it('keeps a laptop with a touch screen on the desktop profile: its main pointer is a mouse', () => {
    expect(classifyDevice(env({ userAgent: WINDOWS, maxTouchPoints: 10, coarse: false, noHover: false }))).toBe('desktop');
    expect(classifyDevice(env({ userAgent: LINUX, maxTouchPoints: 10 }))).toBe('desktop');
  });

  it('knows phones', () => {
    expect(classifyDevice(env({ userAgent: IPHONE, ...finger, screenShort: 393 }))).toBe('phone');
    expect(classifyDevice(env({ userAgent: ANDROID_PHONE, ...finger, screenShort: 360 }))).toBe('phone');
  });

  it('knows tablets, including an iPad that calls itself a Mac', () => {
    expect(classifyDevice(env({ userAgent: IPAD_OLD, ...finger, screenShort: 768 }))).toBe('tablet');
    expect(classifyDevice(env({ userAgent: MAC_SAFARI, ...finger, screenShort: 820 }))).toBe('tablet');
    expect(classifyDevice(env({ userAgent: ANDROID_TABLET, ...finger, screenShort: 800 }))).toBe('tablet');
  });

  it('takes an iPad with a trackpad attached for a tablet still', () => {
    expect(classifyDevice(env({ userAgent: MAC_SAFARI, maxTouchPoints: 5, coarse: false, noHover: false, screenShort: 820 }))).toBe('tablet');
  });

  it('goes by the pointer and the screen when the user agent says nothing', () => {
    // A tablet asking for desktop sites, a touch-only Windows slate.
    expect(classifyDevice(env({ userAgent: LINUX, ...finger, screenShort: 800 }))).toBe('tablet');
    expect(classifyDevice(env({ userAgent: WINDOWS, ...finger, screenShort: 720 }))).toBe('tablet');
    expect(classifyDevice(env({ userAgent: LINUX, ...finger, screenShort: 412 }))).toBe('phone');
    // A finger that can hover (a stylus-first device) is not enough.
    expect(classifyDevice(env({ userAgent: LINUX, maxTouchPoints: 5, coarse: true, noHover: false }))).toBe('desktop');
  });

  it('can be forced from the address, for testing', () => {
    expect(classifyDevice(env({ search: '?profile=phone' }))).toBe('phone');
    expect(classifyDevice(env({ search: '?dev&profile=tablet' }))).toBe('tablet');
    expect(classifyDevice(env({ userAgent: IPHONE, ...finger, search: '?profile=desktop' }))).toBe('desktop');
    expect(classifyDevice(env({ search: '?profile=toaster' }))).toBe('desktop');
  });
});

describe('profileFor', () => {
  it('gives the desktop the constants the game has always used', () => {
    const p = profileFor('desktop');
    expect(p.touch).toBe(false);
    expect(p.render).toBe(DESKTOP_RENDER);
    expect(p.render).toEqual({ lite: false, normalSize: 2048, releaseNormals: false, shadowMapSize: 4096, shadowRadius: 2.5, anisotropy: 16, cookieSize: 1024, antialias: 'smaa', bloomLuminanceScale: 1 });
  });

  it('gives phones and tablets the lighter build', () => {
    for (const kind of ['phone', 'tablet'] as const) {
      const p = profileFor(kind);
      expect(p.touch).toBe(true);
      expect(p.render.lite).toBe(true);
      expect(p.render.shadowMapSize).toBeLessThan(4096);
    }
  });
});
