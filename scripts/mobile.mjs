#!/usr/bin/env node
// Dev helper: see and play the game as a phone or tablet would, in the test browser.
//
//   node scripts/mobile.mjs devices                         list the devices
//   node scripts/mobile.mjs hold <device> [--landscape] [--cpu=4] [--url=...] [--title]
//        make the test browser a phone (viewport, pixel ratio, touch, user agent, safe areas),
//        reload the game and stay attached. Run it in the background and stop it when done:
//        the emulation lasts only as long as this process. browser.mjs (eval, shot without
//        --w/--h, console) works on the emulated page meanwhile.
//   node scripts/mobile.mjs tap <x> <y>                     real touch events (CSS pixels)
//   node scripts/mobile.mjs drag <x1> <y1> <x2> <y2> [ms=300]
//   node scripts/mobile.mjs pinch <cx> <cy> <fromSpan> <toSpan> [ms=400]
//   node scripts/mobile.mjs shots <dir> [device ...]        the standard screens, tiled per device
//   node scripts/mobile.mjs check [device ...]              layout and touch play, each device both ways up:
//        the profile detected, every control on screen, in the safe area, big enough and off the
//        board; a move, a near miss, turning, pinching and sliding by real touch events; the menu;
//        HURRY; a reload that brings the game back; rotation; the lost-picture card
//   node scripts/mobile.mjs quality                         how the picture's level is chosen and kept:
//        measured, remembered, lower for a slower device, forced; idle pace; the held shadow map
//        against a fresh one; stepping down under load, between moves only
//   node scripts/mobile.mjs webkit [device ...] [--out=dir] [--headed]
//        the same game in Safari's engine, as Playwright's own devices ("iPhone 15 Pro",
//        "iPad Pro 11 landscape", ...): starts with no console errors, a tapped move, the menu,
//        a capture. Needs `npx playwright-core install webkit` once. One finger only.
//   node scripts/mobile.mjs capture <out.png> <device> <portrait|landscape> <fen> <uci> [variant=0]
//        five stills of one capture through the game's own cinematic camera, tiled
//
// The game is opened on the dev server (GAME_URL to change) with ?dev unless --title is given.
// Uses the test browser on CDP 9333 (CDP_URL to change).

import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const CDP = process.env.CDP_URL ?? 'http://localhost:9333';
const BASE = process.env.GAME_URL ?? 'http://localhost:5173';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Portrait sizes in CSS pixels; `safe` is [top, right, bottom, left] in portrait and in landscape. */
export const DEVICES = {
  iphone: { w: 393, h: 852, dpr: 3, ua: IPHONE_UA, platform: 'iPhone', safe: { portrait: [59, 0, 34, 0], landscape: [0, 59, 21, 59] } },
  'iphone-se': { w: 375, h: 667, dpr: 2, ua: IPHONE_UA, platform: 'iPhone', safe: { portrait: [20, 0, 0, 0], landscape: [0, 0, 0, 0] } },
  android: { w: 360, h: 800, dpr: 3, ua: ANDROID_UA, platform: 'Linux armv81', safe: { portrait: [0, 0, 0, 0], landscape: [0, 0, 0, 0] } },
  ipad: { w: 820, h: 1180, dpr: 2, ua: IPAD_UA, platform: 'MacIntel', safe: { portrait: [24, 0, 20, 0], landscape: [24, 0, 20, 0] } },
  'ipad-pro': { w: 1024, h: 1366, dpr: 2, ua: IPAD_UA, platform: 'MacIntel', safe: { portrait: [24, 0, 20, 0], landscape: [24, 0, 20, 0] } },
  'android-tablet': { w: 800, h: 1280, dpr: 2, ua: ANDROID_TABLET_UA, platform: 'Linux armv81', safe: { portrait: [0, 0, 0, 0], landscape: [0, 0, 0, 0] } },
};


export async function connect() {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const pages = context.pages().filter((p) => !p.url().startsWith('devtools://'));
  const page = pages.find((p) => /localhost:(9222|517\d)/.test(p.url())) ?? pages[0] ?? (await context.newPage());
  const session = await context.newCDPSession(page);
  return { page, session };
}

/** Make the page a device. Lasts while `session` stays attached. */
export async function emulate(session, name, landscape = false, cpu = 1) {
  const d = DEVICES[name];
  if (!d) throw new Error(`unknown device ${name}; one of ${Object.keys(DEVICES).join(', ')}`);
  const [width, height] = landscape ? [d.h, d.w] : [d.w, d.h];
  await session.send('Emulation.setUserAgentOverride', { userAgent: d.ua, platform: d.platform });
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: d.dpr,
    mobile: true,
    screenWidth: width,
    screenHeight: height,
    screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
  });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const [top, right, bottom, left] = landscape ? d.safe.landscape : d.safe.portrait;
  let safeAreas = true;
  try {
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, right, bottom, left } });
  } catch {
    safeAreas = false;
  }
  await session.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  return { width, height, safe: { top, right, bottom, left }, safeAreas };
}

export async function clearEmulation(session) {
  for (const [method, params] of [
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setUserAgentOverride', { userAgent: '' }],
    ['Emulation.setCPUThrottlingRate', { rate: 1 }],
    ['Emulation.setSafeAreaInsetsOverride', { insets: {} }],
  ]) {
    await session.send(method, params).catch(() => {});
  }
}

export async function open(page, query = '?dev') {
  await page.goto(`${BASE}/${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__swReady === true, null, { timeout: 120000 });
  await page.waitForTimeout(1800);
}

const point = (x, y, id) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: 8, radiusY: 8, force: 1 });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function tap(session, x, y) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(x, y, 0)] });
  await pause(40);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

export async function drag(session, x1, y1, x2, y2, ms = 300) {
  const steps = Math.max(4, Math.round(ms / 16));
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(x1, y1, 0)] });
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, 0)] });
    await pause(ms / steps);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Two fingers on a horizontal line through (cx, cy), their distance going from one span to another; `shift` slides both. */
export async function pinch(session, cx, cy, fromSpan, toSpan, ms = 400, shift = [0, 0]) {
  const steps = Math.max(6, Math.round(ms / 16));
  const at = (k) => {
    const span = fromSpan + (toSpan - fromSpan) * k;
    const x = cx + shift[0] * k;
    const y = cy + shift[1] * k;
    return [point(x - span / 2, y, 0), point(x + span / 2, y, 1)];
  };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)[0]] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let i = 1; i <= steps; i++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i / steps) });
    await pause(ms / steps);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [at(1)[0]] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Where a square (its centre, or `up` metres above it) is on screen, in CSS pixels. */
export const SCREEN_OF = `(square, up = 0) => {
  const sw = window.__sw;
  const file = square.charCodeAt(0) - 97, rank = square.charCodeAt(1) - 49;
  const v = new sw.THREE.Vector3((file - 3.5) * 1.25, up, (3.5 - rank) * 1.25).project(sw.camera);
  return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight];
}`;

export async function tapSquare(page, session, square, up = 0) {
  const [x, y] = await page.evaluate(`(${SCREEN_OF})(${JSON.stringify(square)}, ${up})`);
  await tap(session, x, y);
  return [x, y];
}

const FREEZE = `
  const sw = window.__sw;
  sw.manual(true);
  if (!window.__realNow) window.__realNow = performance.now.bind(performance);
  performance.now = () => 1e6;
  window.__still = (dt = 0, now = 100) => {
    const p = sw.pipeline;
    for (const pass of [p.dofPass, p.overlayPass, p.gradePass, p.finalPass]) pass.fullscreenMaterial.time = 1;
    sw.frame(dt, now);
  };
`;
const THAW = `if (window.__realNow) performance.now = window.__realNow; window.__sw.manual(false);`;

async function still(page, file, setup = '') {
  await page.evaluate(`(async () => { ${FREEZE} ${setup}; window.__still(); window.__still(); })()`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: file, scale: 'css' });
}

function sheet(out, cols, files) {
  spawnSync(path.join(HERE, 'sheet.sh'), [out, String(cols), ...files], { stdio: 'ignore' });
}

/** The standard screens of one device in one orientation. */
async function screens(page, session, dir, name, landscape) {
  const tag = `${name}-${landscape ? 'land' : 'port'}`;
  const files = [];
  const save = async (label, setup = '') => {
    const f = path.join(dir, `${tag}-${label}.png`);
    await still(page, f, setup);
    files.push(f);
  };
  await emulate(session, name, landscape);

  await open(page, '');
  await save('title');
  await page.evaluate(THAW);

  await open(page, '?dev');
  await save('board');
  // (The markers fade in over a few frames.)
  await save('selected', `sw.click('g1'); for (let i = 0; i < 40; i++) window.__still(1 / 60, 100 + i / 60)`);
  await page.evaluate(`window.__sw.click(null)`);
  // The menu, if this build has one.
  const hasMenu = await page.evaluate(() => {
    const b = document.querySelector('#hud .menu-button');
    if (!b) return false;
    b.click();
    return true;
  });
  if (hasMenu) {
    await save('menu');
    await page.evaluate(() => {
      const sheet = document.querySelector('#hud .sheet');
      if (sheet) sheet.scrollTop = sheet.scrollHeight;
    });
    await save('menu-end');
    await page.evaluate(() => document.querySelector('#hud .sheet-scrim')?.click());
  }
  await page.evaluate(`(async () => { const sw = window.__sw; sw.load('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1'); sw.click('a7'); sw.click('a8'); })()`);
  await save('promotion');
  await page.evaluate(`document.querySelector('#hud .choices button').click()`);
  await page.evaluate(`(() => { window.__t = 200; for (let i = 0; i < 900 && window.__sw.busy(); i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
  await page.evaluate(`(async () => { const sw = window.__sw; sw.load('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'); sw.begin('f7g7'); for (let i = 0; i < 1500 && sw.busy(); i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
  await save('game-over');
  await page.evaluate(`window.__sw.load()`);

  // A capture through its cinematic.
  await page.evaluate(`(async () => { const sw = window.__sw; sw.free(); sw.load('4k3/8/8/n7/8/8/8/R3K3 w - - 0 1'); for (let i = 0; i < 6; i++) window.__still(1 / 60, (window.__t += 1 / 60)); sw.begin('a1a5'); })()`);
  let at = 0;
  for (const t of [4.0, 6.2, 6.6, 7.4]) {
    const frames = Math.round((t - at) * 60);
    await page.evaluate(`(() => { for (let i = 0; i < ${frames}; i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
    at = t;
    await page.waitForTimeout(700);
    const f = path.join(dir, `${tag}-capture-${t.toFixed(1)}.png`);
    await page.screenshot({ path: f, scale: 'css' });
    files.push(f);
  }
  await page.evaluate(`(() => { for (let i = 0; i < 900 && window.__sw.busy(); i++) window.__still(1 / 60, (window.__t += 1 / 60)); window.__sw.load(); })()`);
  await page.evaluate(THAW);

  const out = path.join(dir, `sheet-${tag}.png`);
  sheet(out, landscape ? 3 : 6, files);
  console.log(out);
}

// ---------------------------------------------------------------------------- check

/** In the page: where everything is on screen. */
const LAYOUT = `(() => {
  const sw = window.__sw;
  const T = sw.THREE;
  const rect = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return { sel, shown: false, missing: true };
    const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return { sel, x: r.left, y: r.top, w: r.width, h: r.height, shown: s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.width > 0 };
  };
  const project = (x, y, z) => {
    const v = new T.Vector3(x, y, z).project(sw.camera);
    return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight];
  };
  const frame = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) frame.push(project(sx * 5.55, 0, sz * 5.55));
  const cos = Math.cos(sw.rig.azimuth);
  const sin = Math.sin(sw.rig.azimuth);
  const statues = sw.cast.living().map((a) => {
    const p = a.root.position;
    const pts = [];
    for (const side of [-a.radius, a.radius]) for (const y of [0, a.restHeight]) pts.push(project(p.x + side * cos, y, p.z - side * sin));
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);right:env(safe-area-inset-right,0px);bottom:env(safe-area-inset-bottom,0px);left:env(safe-area-inset-left,0px);visibility:hidden';
  document.body.append(probe);
  const pr = probe.getBoundingClientRect();
  probe.remove();
  const a = project(-0.625, 0, 0);
  const b = project(0.625, 0, 0);
  return {
    w: innerWidth,
    h: innerHeight,
    safe: { top: pr.top, left: pr.left, right: innerWidth - pr.right, bottom: innerHeight - pr.bottom },
    controls: ['#hud .menu-button', '#hud .turn', '#hud .actions .undo', '#hud .hint', '#hud .hurry'].map(rect),
    frame,
    statues,
    square: Math.hypot(b[0] - a[0], b[1] - a[1]),
    seat: { fov: +sw.rig.fov.toFixed(1), distance: +sw.rig.distance.toFixed(2), elevation: +((sw.rig.elevation * 180) / Math.PI).toFixed(1), aim: +sw.rig.aim.toFixed(2) },
    render: sw.info().size,
  };
})()`;

const centreOf = (page, selector) =>
  page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }, selector);

/** Problems with where things are on screen. */
function layoutProblems(l) {
  const problems = [];
  const inside = (r, pad = 0.75) => r.x >= l.safe.left - pad && r.y >= l.safe.top - pad && r.x + r.w <= l.w - l.safe.right + pad && r.y + r.h <= l.h - l.safe.bottom + pad;
  const byName = Object.fromEntries(l.controls.map((c) => [c.sel.split(' ').pop(), c]));
  for (const name of ['.menu-button', '.turn', '.undo']) {
    const c = byName[name];
    if (!c || !c.shown) {
      problems.push(`${name} is not on screen`);
      continue;
    }
    if (!inside(c)) problems.push(`${name} [${Math.round(c.x)}, ${Math.round(c.y)}, ${Math.round(c.w)} x ${Math.round(c.h)}] is outside the safe area`);
    if (name !== '.turn' && (c.w < 44 || c.h < 44)) problems.push(`${name} is ${Math.round(c.w)} x ${Math.round(c.h)}: smaller than 44 px`);
    const hit = l.statues.find((s) => c.x < s[2] && c.x + c.w > s[0] && c.y < s[3] && c.y + c.h > s[1]);
    if (hit) problems.push(`${name} lies over a statue at [${hit.map(Math.round)}]`);
  }
  for (const [x, y] of l.frame) if (x < -1 || x > l.w + 1 || y < -1 || y > l.h + 1) problems.push(`a corner of the board is off screen at (${Math.round(x)}, ${Math.round(y)})`);
  for (const s of l.statues) if (s[0] < -1 || s[2] > l.w + 1 || s[1] < -1 || s[3] > l.h + 1) problems.push(`a statue is off screen at [${s.map(Math.round)}]`);
  if (l.square < 30) problems.push(`squares are ${l.square.toFixed(0)} px wide`);
  return problems;
}

async function checkDevice(page, session, name, landscape) {
  const problems = [];
  const expect = (ok, what) => {
    if (!ok) problems.push(what);
    return ok;
  };
  const sw = (code) => page.evaluate(`(() => { const sw = window.__sw; return ${code}; })()`);
  await emulate(session, name, landscape);
  // (No game left over from an earlier run.)
  await page.evaluate(() => localStorage.removeItem('stonewake.game')).catch(() => {});
  await open(page, '?dev');

  // --- the profile, with nothing in the address to force it
  const kind = /ipad|tablet/.test(name) ? 'tablet' : 'phone';
  const profile = await page.evaluate(() => ({ kind: window.__sw.profile?.kind, html: document.documentElement.className }));
  expect(profile.kind === kind, `the profile is ${profile.kind}, not ${kind}`);
  expect(/\btouch\b/.test(profile.html), '<html> has no touch class');

  // --- layout
  const layout = await page.evaluate(LAYOUT);
  problems.push(...layoutProblems(layout));
  const { w, h } = layout;

  // --- a move by tapping
  await tapSquare(page, session, 'e2', 0.8);
  await page.waitForTimeout(300);
  expect(await sw(`sw.markers.has('select', 'e2')`), 'tapping the e2 pawn did not select it');
  await tapSquare(page, session, 'e4');
  await page.waitForFunction(() => !window.__sw.busy() && window.__sw.game.history().length === 1, null, { timeout: 25000 }).catch(() => {});
  expect((await sw(`sw.game.history().join(' ')`)) === 'e4', `tapping e2 then e4 played "${await sw(`sw.game.history().join(' ')`)}"`);
  expect(await sw(`sw.consistent()`), 'the statues disagree with the position after the tapped move');
  // Sound starts on a finger lifting (its coming down is not a gesture a browser will start sound on).
  const sound = await sw(`sw.director.stage.fx.audio?.synth?.ctx.state ?? 'none'`);
  expect(sound === 'running', `after two taps the sound is ${sound}`);
  // (Pass and play: the camera swings to the other seat. Let it arrive.)
  await page.waitForTimeout(2600);

  // --- the page thrown away and brought back: the game is still on the board
  await open(page, '?dev');
  expect((await sw(`sw.game.history().join(' ')`)) === 'e4', `after a reload the game was "${await sw(`sw.game.history().join(' ')`)}", not "e4"`);
  expect(await sw(`sw.consistent()`), 'the statues disagree with the position after a reload');
  expect((await sw(`sw.game.turn()`)) === 'b', 'after a reload it is not Obsidian to move');

  // --- a near miss still lands: a rook alone on its file, and a tap just off the edge of the
  //     board beside a5 (on a phone that is outside the square; nothing else playable is near)
  await page.evaluate(() => {
    window.__sw.load('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    window.__sw.director.baseSpeed = 6;
  });
  await page.waitForTimeout(2600);
  await tapSquare(page, session, 'a1', 1.0);
  await page.waitForTimeout(250);
  if (expect(await sw(`sw.markers.has('select', 'a1')`), 'tapping the a1 rook did not select it')) {
    const [cx, cy] = await page.evaluate(`(${SCREEN_OF})('a5', 0)`);
    const offBoard = await page.evaluate(`(${SCREEN_OF})('a5', 0)[0] < (${SCREEN_OF})('b5', 0)[0] ? -1 : 1`);
    await tap(session, cx + offBoard * Math.min(layout.square * 0.5 + 5, 23), cy);
    await page.waitForFunction(() => !window.__sw.busy() && window.__sw.game.history().length === 1, null, { timeout: 25000 }).catch(() => {});
    expect((await sw(`sw.game.history().join(' ')`)) === 'Ra5', `a tap just beside a5 played "${await sw(`sw.game.history().join(' ')`)}"`);
  }
  await page.evaluate(() => {
    window.__sw.director.baseSpeed = 1;
    window.__sw.load();
  });
  await page.waitForTimeout(2600);
  const played = await sw(`sw.game.history().length`);

  // --- one finger turns the view
  const az0 = await sw(`sw.rig.azimuth`);
  await drag(session, w * 0.5, h * 0.5, w * 0.5 + Math.min(140, w * 0.3), h * 0.5 + 6, 260);
  await page.waitForTimeout(700);
  const az1 = await sw(`sw.rig.azimuth`);
  expect(Math.abs(az1 - az0) > 0.25, `a one-finger drag turned the view by ${(az1 - az0).toFixed(3)} rad`);
  expect((await sw(`sw.game.history().length`)) === played, 'a drag made a move');

  // --- two fingers zoom, slide, and come back to the whole board
  const seatDistance = await sw(`sw.rig.distance`);
  await pinch(session, w * 0.5, h * 0.5, 70, Math.min(260, w * 0.7), 380);
  await page.waitForTimeout(900);
  const near = await sw(`sw.rig.distance`);
  expect(near < seatDistance * 0.75, `pinching out zoomed from ${seatDistance.toFixed(1)} m only to ${near.toFixed(1)} m`);
  await pinch(session, w * 0.5, h * 0.5, 130, 130, 300, [Math.min(70, w * 0.18), 0]);
  await page.waitForTimeout(700);
  const slid = await sw(`Math.hypot(sw.rig.target.x, sw.rig.target.z)`);
  expect(slid > 0.25, `sliding two fingers moved the view ${slid.toFixed(2)} m`);
  for (let i = 0; i < 3; i++) await pinch(session, w * 0.5, h * 0.5, Math.min(260, w * 0.7), 50, 300);
  await page.waitForTimeout(1300);
  const back = await sw(`[sw.rig.distance, Math.hypot(sw.rig.target.x, sw.rig.target.z)]`);
  expect(back[0] >= seatDistance - 0.05 && back[1] < 0.05, `pinching in again left the view at ${back[0].toFixed(1)} m, ${back[1].toFixed(2)} m off centre`);
  expect((await sw(`sw.game.history().length`)) === played && !(await sw(`'abcdefgh'.split('').some((f) => [1, 2, 7, 8].some((r) => sw.markers.has('select', f + r)))`)), 'the two-finger gestures selected or moved something');

  // --- the menu
  const menuAt = await centreOf(page, '#hud .menu-button');
  await tap(session, ...menuAt);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.querySelector('#hud').classList.contains('menu-open')), 'tapping the menu button did not open the menu');
  const sheet = await page.evaluate(() => {
    const r = document.querySelector('#hud .sheet').getBoundingClientRect();
    const small = [...document.querySelectorAll('#hud .sheet button')].filter((b) => b.offsetParent && getComputedStyle(b).pointerEvents !== 'none' && b.getBoundingClientRect().height < 43.5).map((b) => `${b.textContent.trim()} ${Math.round(b.getBoundingClientRect().height)}`);
    return { x: r.left, y: r.top, w: r.width, h: r.height, small };
  });
  expect(sheet.x >= -1 && sheet.y >= -1 && sheet.x + sheet.w <= w + 1 && sheet.y + sheet.h <= h + 1, `the menu is partly off screen: [${[sheet.x, sheet.y, sheet.w, sheet.h].map(Math.round)}]`);
  expect(sheet.small.length === 0, `menu buttons shorter than 44 px: ${sheet.small.join(', ')}`);
  const computer = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#hud .sheet .modes button')].find((x) => x.textContent.includes('COMPUTER'));
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
  await tap(session, ...computer);
  await page.waitForTimeout(400);
  expect((await sw(`sw.opponent.mode`)) === 'computer', 'tapping VS COMPUTER in the menu did not choose it');
  // Outside the sheet: the scrim closes it, and that touch does not reach the board.
  const outside = landscape ? [w - 40, h * 0.5] : [w * 0.5, layout.safe.top + 30];
  await tap(session, ...outside);
  await page.waitForTimeout(600);
  expect(!(await page.evaluate(() => document.querySelector('#hud').classList.contains('menu-open'))), 'tapping outside the menu did not close it');
  await page.evaluate(() => window.__sw.ai('pass'));

  // --- HURRY cuts a long move short
  await page.evaluate(() => window.__sw.load('4k3/7p/8/8/8/8/P7/R3K3 w - - 0 1'));
  await page.waitForTimeout(900);
  await tapSquare(page, session, 'a1', 1.0);
  await page.waitForTimeout(250);
  await tapSquare(page, session, 'd1');
  const started = Date.now();
  const offered = await page
    .waitForFunction(() => document.querySelector('#hud').classList.contains('hurry-on'), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (expect(offered, 'HURRY was not offered during a long rook move')) {
    await page.waitForTimeout(500);
    const hurryAt = await centreOf(page, '#hud .hurry');
    const hurry = (await page.evaluate(LAYOUT)).controls.find((c) => c.sel.endsWith('.hurry'));
    expect(hurry.w >= 44 && hurry.h >= 44, `HURRY is ${Math.round(hurry.w)} x ${Math.round(hurry.h)}`);
    await tap(session, ...hurryAt);
    await page.waitForFunction(() => !window.__sw.busy(), null, { timeout: 20000 }).catch(() => {});
    const took = (Date.now() - started) / 1000;
    expect(took < 5.5, `a hurried rook move still took ${took.toFixed(1)} s`);
    expect(await sw(`sw.consistent()`), 'the statues disagree with the position after a hurried move');
  }

  // --- turn the device round: everything still fits
  await page.evaluate(() => window.__sw.load());
  await emulate(session, name, !landscape);
  await page.waitForTimeout(1600);
  problems.push(...layoutProblems(await page.evaluate(LAYOUT)).map((p) => `after rotating: ${p}`));
  await emulate(session, name, landscape);
  await page.waitForTimeout(600);

  const errors = await page.evaluate(() => (window.__consoleLog ?? []).splice(0));
  for (const e of errors) problems.push(`console: ${e.slice(0, 160)}`);

  // --- the device takes the picture away: a card says so, with a way back
  await page.evaluate(() => window.__sw.pipeline.renderer.forceContextLoss());
  await page.waitForTimeout(700);
  const notice = await page.evaluate(() => {
    const card = document.querySelector('#hud .notice.show .card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { text: card.textContent, fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, button: card.querySelector('button')?.getBoundingClientRect().height ?? 0 };
  });
  expect(notice && /RETURN/.test(notice.text), 'losing the picture showed no card');
  if (notice) expect(notice.fits && notice.button >= 44, 'the lost-picture card does not fit the screen, or its button is small');
  await page.evaluate(() => (window.__consoleLog ?? []).splice(0));
  return { problems, layout };
}

/** The level a device is drawn at, and how it is chosen and kept: on one emulated phone. */
async function checkQuality(page, session) {
  const problems = [];
  const expect = (ok, what) => {
    if (!ok) problems.push(what);
    return ok;
  };
  const sw = (code) => page.evaluate(`(() => { const sw = window.__sw; return ${code}; })()`);
  await emulate(session, 'iphone', false);

  // --- measured at load
  await open(page, '?dev&calibrate');
  const first = await sw(`sw.mobile.state()`);
  expect(first.source === 'measured' && first.timings, `the level was ${first.source}, not measured`);
  console.log(`     measured: level ${first.level}/${first.levels}, ${JSON.stringify(first.timings && Object.fromEntries(Object.entries(first.timings).map(([k, v]) => [k, +v.toFixed(2)])))}`);
  // --- remembered on the next visit
  await open(page, '?dev');
  expect((await sw(`sw.mobile.state().source`)) === 'remembered', 'the measurement was not remembered for the next visit');

  // --- a slower device is given less, never more
  let last = 0;
  const rows = [];
  for (const load of [1, 4, 8, 14, 24, 40]) {
    const s = await page.evaluate((k) => {
      const state = window.__sw.mobile.calibrate(k);
      return { level: state.level, fps: state.settings.fps, mirror: state.settings.mirror, ao: state.settings.ao, size: window.__sw.info().size, cap: window.__sw.loop.cap };
    }, load);
    rows.push(`x${load}: L${s.level} ${s.size.width}x${s.size.height}@${s.fps}${s.mirror ? ' mirror' : ''} ao ${s.ao}`);
    expect(s.level >= last, `at ${load} times the load the level rose from ${last} to ${s.level}`);
    last = s.level;
  }
  console.log(`     ${rows.join('  |  ')}`);
  expect(last === first.levels, `the heaviest load still chose level ${last} of ${first.levels}`);
  await page.evaluate(() => window.__sw.mobile.calibrate(1));

  // --- a level can be forced from the address, and the lightest does without the costly things
  await open(page, '?dev&level=8');
  const forced = await sw(`({ s: sw.mobile.state(), ao: sw.pipeline.ao.enabled, dof: sw.pipeline.dofAllowed, mirror: sw.reflection.strength, mirrorSize: [sw.reflection.target.width, sw.reflection.target.height], cap: sw.loop.cap, size: sw.info().size })`);
  expect(forced.s.level === 8 && forced.s.source === 'forced', `?level=8 gave level ${forced.s.level} (${forced.s.source})`);
  expect(!forced.ao && !forced.dof && forced.mirror === 0 && forced.mirrorSize[0] <= 2, `the lightest level still has ${JSON.stringify({ ao: forced.ao, dof: forced.dof, mirror: forced.mirror, mirrorSize: forced.mirrorSize })}`);
  expect(forced.size.width * forced.size.height < 0.75e6, `the lightest level draws ${forced.size.width} x ${forced.size.height}`);

  // --- at rest the pace halves and the shadow map is held; a finger brings the pace back
  await open(page, '?dev&level=2');
  await page.waitForTimeout(2200);
  let s = await sw(`({ ...sw.mobile.state(), cap: sw.loop.cap })`);
  expect(s.idle && s.cap === 30, `at rest the pace is ${s.cap} (idle: ${s.idle})`);
  expect(s.shadowsHeld, 'at rest the shadow map is still being redrawn');
  const size = await page.evaluate(() => [innerWidth, innerHeight]);
  const dragging = drag(session, size[0] * 0.5, size[1] * 0.5, size[0] * 0.5 + 100, size[1] * 0.5, 900);
  await page.waitForTimeout(500);
  s = await sw(`({ ...sw.mobile.state(), cap: sw.loop.cap })`);
  expect(!s.idle && s.cap === 60, `with a finger turning the view the pace is ${s.cap}`);
  await dragging;
  await page.waitForTimeout(2200);
  s = await sw(`({ ...sw.mobile.state(), cap: sw.loop.cap })`);
  expect(s.idle && s.cap === 30, `after the finger lifted the pace stayed at ${s.cap}`);

  // --- zoomed in on one corner, a move played in another is not missed: the view comes back
  await pinch(session, size[0] * 0.5, size[1] * 0.5, 70, 250, 380);
  await pinch(session, size[0] * 0.5, size[1] * 0.5, 130, 130, 300, [-80, 60]);
  await page.waitForTimeout(900);
  const zoomedIn = await sw(`sw.rig.zoomed`);
  expect(zoomedIn > 0.3, `pinching zoomed in only ${zoomedIn.toFixed(2)} of the way`);
  await page.evaluate(() => {
    window.__sw.director.baseSpeed = 4;
    return window.__sw.move('h7h6').catch(() => window.__sw.move('h2h3'));
  });
  await page.waitForTimeout(1500);
  expect((await sw(`sw.rig.zoomed`)) < 0.05, `after a move elsewhere the view stayed zoomed in (${(await sw(`sw.rig.zoomed`)).toFixed(2)})`);
  await page.evaluate(() => {
    window.__sw.director.baseSpeed = 1;
    window.__sw.load();
  });

  // --- the screen is kept awake while the computer plays itself, and let go when it stops
  await page.evaluate(() => {
    window.__wake = { asked: 0, released: 0 };
    const request = navigator.wakeLock.request.bind(navigator.wakeLock);
    navigator.wakeLock.request = async (type) => {
      window.__wake.asked++;
      const sentinel = await request(type);
      sentinel.addEventListener('release', () => window.__wake.released++);
      return sentinel;
    };
    window.__sw.ai('auto', { pauseMs: 4000 });
  });
  await page.waitForTimeout(2600);
  let wake = await page.evaluate(() => window.__wake);
  expect(wake.asked >= 1 && wake.released === 0, `in auto-play the screen lock was asked for ${wake.asked} time(s), released ${wake.released}`);
  await page.evaluate(() => window.__sw.ai('pass'));
  await page.waitForTimeout(2600);
  wake = await page.evaluate(() => window.__wake);
  expect(wake.released >= 1, 'back in pass and play the screen lock was not let go');
  await page.evaluate(() => window.__sw.load());

  // --- the held shadow map is the right one: after a capture, an undo and a new game, a still
  //     drawn with it matches one drawn with the map redrawn
  const sameShadows = async (label) => {
    await page.waitForFunction(() => !window.__sw.busy() && window.__sw.mobile.state().shadowsHeld, null, { timeout: 30000 }).catch(() => {});
    const held = await sw(`sw.mobile.state().shadowsHeld`);
    if (!expect(held, `${label}: the shadow map never came to rest`)) return;
    // (The interface is hidden: its own transitions run on real time and are not the picture's.)
    await page.evaluate(`(() => { ${FREEZE} document.querySelector('#hud').style.visibility = 'hidden'; sw.mobile.holdShadowsWhenStopped = true; sw.free(); sw.orbit(0.6, 38, 15); window.__still(); window.__still(); })()`);
    const a = await page.screenshot({ scale: 'css' });
    await page.evaluate(`(() => { const sw = window.__sw; sw.mobile.holdShadowsWhenStopped = false; window.__still(); window.__still(); })()`);
    const b = await page.screenshot({ scale: 'css' });
    expect(a.equals(b), `${label}: the held shadow map differs from a fresh one`);
    // And the comparison can tell: with a statue moved and the map still held, the stills differ.
    if (label === 'after a capture') {
      // (A few frames first: the map is still redrawn for a moment after anything has moved.)
      await page.evaluate(`(() => { const sw = window.__sw; sw.mobile.holdShadowsWhenStopped = true; for (let i = 0; i < 6; i++) window.__still(); const a = sw.cast.living().find((x) => x.type === 'p'); a.root.position.x += 1.25; window.__still(); window.__still(); })()`);
      const moved = await page.screenshot({ scale: 'css' });
      await page.evaluate(`(() => { const sw = window.__sw; sw.mobile.holdShadowsWhenStopped = false; window.__still(); window.__still(); })()`);
      const redrawn = await page.screenshot({ scale: 'css' });
      expect(!moved.equals(redrawn), 'the stills cannot tell a stale shadow map from a fresh one');
      await page.evaluate(`(() => { const sw = window.__sw; sw.cast.living().find((x) => x.type === 'p').root.position.x -= 1.25; window.__still(); })()`);
    }
    await page.evaluate(`(() => { document.querySelector('#hud').style.visibility = ''; ${THAW} })()`);
  };
  await page.evaluate(() => {
    window.__sw.director.baseSpeed = 5;
    window.__sw.load('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  });
  await page.evaluate(() => window.__sw.move('e4d5'));
  await sameShadows('after a capture');
  await page.evaluate(() => window.__sw.controller.undo());
  await sameShadows('after an undo');
  await page.evaluate(() => window.__sw.load());
  await sameShadows('after a new game');
  await page.evaluate(() => (window.__sw.director.baseSpeed = 1));

  // --- a device that has slowed down: frames come late while pieces move, and between moves
  //     (never during one) the picture is made lighter
  await open(page, '?dev&level=2');
  // (Every frame is drawn many times over, as a device a fraction of the speed would feel.)
  await page.evaluate(() => {
    const sw = window.__sw;
    sw.mobile.load = 36;
    sw.stress.repeat = 36;
    window.__levels = [];
    const watch = () => {
      window.__levels.push([sw.mobile.state().level, sw.busy()]);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    sw.load('4k3/7p/8/8/8/8/P7/R6K w - - 0 1');
  });
  for (const uci of ['a1g1', 'e8d8', 'g1b1', 'd8e8', 'b1f1', 'e8d8']) {
    await page.evaluate((m) => window.__sw.move(m), uci).catch(() => {});
    if ((await sw(`sw.mobile.state().level`)) > 2) break;
  }
  await page.waitForTimeout(1500);
  const after = await sw(`({ level: sw.mobile.state().level, down: sw.mobile.state().steppedDown, late: sw.mobile.state().late, seen: window.__levels })`);
  console.log(`     under load: level 2 -> ${after.level} (${after.down} step(s) down), ${after.seen.length} frames watched`);
  expect(after.level > 2 && after.down >= 1, `frames were late throughout and the level stayed at ${after.level}`);
  let changedInMove = false;
  for (let i = 1; i < after.seen.length; i++) if (after.seen[i][0] !== after.seen[i - 1][0] && after.seen[i][1] && after.seen[i - 1][1]) changedInMove = true;
  expect(!changedInMove, 'the level changed in the middle of a move');
  await page.evaluate(() => {
    window.__sw.stress.repeat = 1;
    window.__sw.mobile.load = 1;
  });

  const errors = await page.evaluate(() => (window.__consoleLog ?? []).splice(0));
  for (const e of errors) problems.push(`console: ${e.slice(0, 160)}`);
  // Leave the next visit to measure for itself.
  await page.evaluate(() => localStorage.removeItem('stonewake.quality'));
  return problems;
}

/**
 * The same game in Safari's engine: Playwright's own WebKit, as one of its iPhone or iPad
 * descriptors. It shares the engine with Safari on iOS (the canvas and bitmap APIs, the WebGL
 * extensions, the style sheet's support) but not a phone's GPU or its memory limits.
 */
async function checkWebKit(browser, descriptor, name, outDir) {
  const problems = [];
  const expect = (ok, what) => {
    if (!ok) problems.push(what);
    return ok;
  };
  const context = await browser.newContext({ ...descriptor });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => errors.push(`[uncaught] ${String(e.message).slice(0, 200)}`));
  try {
    const started = Date.now();
    await page.goto(`${BASE}/?dev&stats&calibrate`, { waitUntil: 'load' });
    const ready = await page
      .waitForFunction(() => window.__swReady === true, null, { timeout: 180000 })
      .then(() => true)
      .catch(() => false);
    if (!expect(ready, `the game did not start: ${(await page.evaluate(() => document.body.innerText)).slice(0, 300)}`)) return { problems: [...problems, ...errors], info: null };
    const loadSeconds = (Date.now() - started) / 1000;
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => {
      const sw = window.__sw;
      const gl = sw.pipeline.renderer.getContext();
      const s = sw.mobile?.state();
      return {
        profile: sw.profile.kind,
        html: document.documentElement.className,
        level: s && `${s.level}/${s.levels} ${s.source}`,
        timings: s?.timings && Object.fromEntries(Object.entries(s.timings).map(([k, v]) => [k, +v.toFixed(1)])),
        size: sw.info().size,
        fps: s?.fps,
        has: {
          offscreenCanvas: typeof OffscreenCanvas === 'function',
          canvasFilter: typeof document.createElement('canvas').getContext('2d').filter === 'string',
          floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
          halfFloatTargets: !!gl.getExtension('EXT_color_buffer_half_float'),
          share: typeof navigator.share === 'function',
          wakeLock: 'wakeLock' in navigator,
          touchPoints: navigator.maxTouchPoints,
        },
        ao: sw.pipeline.ao.enabled,
        stats: document.querySelector('#hud .stats')?.textContent ?? null,
      };
    });
    info.loadSeconds = +loadSeconds.toFixed(1);
    expect(info.profile !== 'desktop' && /\btouch\b/.test(info.html), `the profile is ${info.profile}`);

    const layout = await page.evaluate(LAYOUT);
    problems.push(...layoutProblems(layout));

    // A move by touch (one finger; this WebKit has no way to send two).
    const at = async (square, up = 0) => page.evaluate(`(${SCREEN_OF})(${JSON.stringify(square)}, ${up})`);
    await page.touchscreen.tap(...(await at('e2', 0.8)));
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => window.__sw.markers.has('select', 'e2')), 'tapping the e2 pawn did not select it');
    await page.touchscreen.tap(...(await at('e4')));
    await page
      .waitForFunction(() => !window.__sw.busy() && window.__sw.game.history().length === 1, null, { timeout: 30000 })
      .catch(() => {});
    expect((await page.evaluate(() => window.__sw.game.history().join(' '))) === 'e4', 'tapping e2 then e4 did not play e4');
    // The menu.
    const menu = await centreOf(page, '#hud .menu-button');
    await page.touchscreen.tap(...menu);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => document.querySelector('#hud').classList.contains('menu-open')), 'tapping the menu button did not open the menu');
    if (outDir) await page.screenshot({ path: path.join(outDir, `webkit-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-menu.png`), scale: 'css' });
    await page.evaluate(() => document.querySelector('#hud .sheet-scrim').click());
    await page.waitForTimeout(2600);
    if (outDir) await page.screenshot({ path: path.join(outDir, `webkit-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`), scale: 'css' });
    // A capture through its cinematic, in real time.
    await page.evaluate(() => {
      window.__sw.director.baseSpeed = 3;
      window.__sw.load('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
      return window.__sw.move('e4d5');
    });
    expect(await page.evaluate(() => window.__sw.consistent()), 'the statues disagree with the position after a capture');
    return { problems: [...problems, ...errors.filter((e) => !/favicon/.test(e)).map((e) => `console: ${e}`)], info };
  } finally {
    await context.close();
  }
}

/** Stills of one capture through the game's own cinematic camera, at its own moments, tiled. */
async function captureSheet(page, session, out, name, landscape, fen, uci, variant = 0) {
  await emulate(session, name, landscape);
  await open(page, '?dev');
  const timing = await page.evaluate(
    async ([f, u, v]) => {
      const sw = window.__sw;
      sw.captureTuning.variant = v;
      const [row] = await sw.timing([{ fen: f, uci: u }]);
      return row;
    },
    [fen, uci, variant],
  );
  const times = [timing.cutIn + 0.5, timing.marks.top ?? timing.blow - 0.4, timing.blow + 0.04, timing.blow + 0.35, timing.blow + 1.0].map((t) => +t.toFixed(2));
  await page.evaluate(`(() => { ${FREEZE} sw.free(); sw.load(${JSON.stringify(fen)}); window.__t = 100; for (let i = 0; i < 12; i++) window.__still(1 / 60, (window.__t += 1 / 60)); sw.begin(${JSON.stringify(uci)}); })()`);
  const files = [];
  let at = 0;
  for (const t of times) {
    const frames = Math.max(0, Math.round((t - at) * 60));
    await page.evaluate(`(() => { for (let i = 0; i < ${frames}; i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
    at = t;
    await page.waitForTimeout(600);
    const f = out.replace(/\.png$/, `-${files.length}.png`);
    await page.screenshot({ path: f, scale: 'css' });
    files.push(f);
  }
  const attack = await page.evaluate(() => window.__sw.lastCapture?.attack);
  await page.evaluate(`(() => { for (let i = 0; i < 1500 && window.__sw.busy(); i++) window.__still(1 / 60, (window.__t += 1 / 60)); window.__sw.captureTuning.variant = null; ${THAW} window.__sw.load(); })()`);
  sheet(out, files.length, files);
  console.log(`${out}  (${attack}; stills at ${times.join(', ')} s of ${timing.total})`);
}

export async function runChecks(page, session, names) {
  let failed = 0;
  for (const name of names) {
    for (const landscape of [false, true]) {
      const tag = `${name} ${landscape ? 'landscape' : 'portrait'}`;
      try {
        const { problems, layout } = await checkDevice(page, session, name, landscape);
        failed += problems.length;
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${tag.padEnd(26)} seat ${JSON.stringify(layout.seat)}  square ${layout.square.toFixed(0)} px  render ${layout.render.width} x ${layout.render.height}`);
        for (const p of problems) console.log(`       ${p}`);
      } catch (err) {
        failed++;
        console.log(`FAIL ${tag}: ${String(err?.message ?? err).slice(0, 300)}`);
      }
    }
  }
  return failed;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(rest.filter((x) => x.startsWith('--')).map((x) => x.slice(2).split('=')));
  const args = rest.filter((x) => !x.startsWith('--'));
  try {
    switch (cmd) {
      case 'devices': {
        for (const [name, d] of Object.entries(DEVICES)) console.log(`${name.padEnd(16)} ${d.w} x ${d.h} @${d.dpr}  ${d.platform}`);
        break;
      }
      case 'hold': {
        const { page, session } = await connect();
        const landscape = 'landscape' in flags;
        const state = await emulate(session, args[0], landscape, Number(flags.cpu ?? 1));
        await page.goto(flags.url ?? `${BASE}/${'title' in flags ? '' : '?dev'}`, { waitUntil: 'load' });
        await page.bringToFront().catch(() => {});
        console.log(`holding ${args[0]} ${state.width} x ${state.height}${state.safeAreas ? '' : ' (no safe-area emulation in this browser)'}; stop this process to end it`);
        const end = async () => {
          await clearEmulation(session);
          process.exit(0);
        };
        process.on('SIGINT', end);
        process.on('SIGTERM', end);
        setInterval(() => {}, 1 << 30);
        await new Promise(() => {});
        break;
      }
      case 'tap': {
        const { session } = await connect();
        await tap(session, Number(args[0]), Number(args[1]));
        break;
      }
      case 'drag': {
        const { session } = await connect();
        await drag(session, ...args.slice(0, 4).map(Number), Number(args[4] ?? 300));
        break;
      }
      case 'pinch': {
        const { session } = await connect();
        await pinch(session, ...args.slice(0, 4).map(Number), Number(args[4] ?? 400));
        break;
      }
      case 'shots': {
        const dir = path.resolve(args[0]);
        await mkdir(dir, { recursive: true });
        const { page, session } = await connect();
        const names = args.length > 1 ? args.slice(1) : ['iphone', 'ipad'];
        try {
          for (const name of names) for (const landscape of [false, true]) await screens(page, session, dir, name, landscape);
        } finally {
          await clearEmulation(session);
        }
        break;
      }
      case 'check': {
        const { page, session } = await connect();
        let failed = 0;
        try {
          failed = await runChecks(page, session, args.length ? args : ['iphone', 'iphone-se', 'android', 'ipad', 'android-tablet']);
        } finally {
          await clearEmulation(session);
        }
        process.exitCode = failed ? 1 : 0;
        break;
      }
      case 'quality': {
        const { page, session } = await connect();
        let problems = [];
        try {
          problems = await checkQuality(page, session);
        } finally {
          await clearEmulation(session);
        }
        console.log(problems.length ? 'FAIL quality' : 'ok   quality');
        for (const p of problems) console.log(`       ${p}`);
        process.exitCode = problems.length ? 1 : 0;
        break;
      }
      case 'webkit': {
        // Needs Playwright's WebKit once: npx playwright-core install webkit
        const { webkit, devices } = await import('playwright-core');
        const outDir = flags.out ? path.resolve(flags.out) : null;
        if (outDir) await mkdir(outDir, { recursive: true });
        const names = args.length ? args : ['iPhone 15 Pro', 'iPhone 15 Pro landscape', 'iPad Pro 11', 'iPad Pro 11 landscape'];
        const browser = await webkit.launch({ headless: !('headed' in flags) });
        let failed = 0;
        try {
          for (const name of names) {
            if (!devices[name]) throw new Error(`Playwright has no device called "${name}"`);
            const { problems, info } = await checkWebKit(browser, devices[name], name, outDir);
            failed += problems.length;
            console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}  ${info ? JSON.stringify(info) : ''}`);
            for (const p of problems) console.log(`       ${p}`);
          }
        } finally {
          await browser.close();
        }
        process.exitCode = failed ? 1 : 0;
        break;
      }
      case 'capture': {
        const [out, name, orient, fen, uci, variant] = args;
        const { page, session } = await connect();
        await mkdir(path.dirname(path.resolve(out)), { recursive: true });
        try {
          await captureSheet(page, session, path.resolve(out), name, orient === 'landscape', fen, uci, Number(variant ?? 0));
        } finally {
          await clearEmulation(session);
        }
        break;
      }
      default:
        console.error('usage: mobile.mjs devices | hold <device> | tap x y | drag x1 y1 x2 y2 | pinch cx cy from to | shots <dir> [device ...] | check [device ...] | quality | capture <out.png> <device> <portrait|landscape> <fen> <uci> [variant]');
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(String(err?.stack ?? err).slice(0, 3000));
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
