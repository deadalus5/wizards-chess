#!/usr/bin/env node
// Dev helper: record what the desktop game looks like and loads, so that a later change can be
// checked against it pixel for pixel.
//
//   node scripts/regress.mjs capture <dir>     stills, the HUD's markup and what was requested
//   node scripts/regress.mjs compare <a> <b>   say what differs between two captures
//
// Stills are taken with the game's clock stopped (window.__sw.manual), the post-processing
// clocks set to a fixed value and performance.now frozen (the ambient-occlusion pass draws its
// noise from it), so the same build gives the same pixels every time. Capture twice before a
// change to confirm that on the day; then any difference afterwards is the change.
//
// Uses the test browser on CDP 9333 (CDP_URL to change), at 1600 x 860.

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const CDP = process.env.CDP_URL ?? 'http://localhost:9333';
const BASE = process.env.GAME_URL ?? 'http://localhost:5173';
const [cmd, a, b] = process.argv.slice(2);
const W = 1600;
const H = 860;

async function connect() {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const pages = context.pages().filter((p) => !p.url().startsWith('devtools://'));
  const page = pages.find((p) => /localhost:(9222|5173)/.test(p.url())) ?? pages[0] ?? (await context.newPage());
  return { context, page };
}

async function resize(context, page) {
  const session = await context.newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  for (let pass = 0; pass < 4; pass++) {
    const inner = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight }));
    if (inner.w === W && inner.h === H) break;
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: inner.ow + (W - inner.w), height: inner.oh + (H - inner.h) } });
    await page.waitForTimeout(300);
  }
  await session.detach();
  const size = await page.evaluate(() => [innerWidth, innerHeight]);
  if (size[0] !== W || size[1] !== H) throw new Error(`window is ${size.join('x')}, wanted ${W}x${H}`);
}

async function load(page, query) {
  await page.goto(`${BASE}/${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__swReady === true, null, { timeout: 90000 });
  // The loading screen fades and is removed 1.2 s after the game is ready.
  await page.waitForTimeout(2200);
}

/** Stop every clock, then render one frame twice at a fixed time (the second settles temporal state). */
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

async function shot(page, dir, name, setup = '') {
  await page.evaluate(`(async () => { ${FREEZE} ${setup}; window.__still(); window.__still(); })()`);
  // CSS transitions in the HUD run on real time.
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(dir, `${name}.png`), scale: 'css' });
  console.log(`  ${name}`);
}

async function capture(dir) {
  await mkdir(dir, { recursive: true });
  const { context, page } = await connect();
  await resize(context, page);
  const state = {};

  // The title screen.
  await load(page, '');
  state.title = await page.evaluate(() => ({ html: document.querySelector('#title')?.outerHTML ?? null, hudClass: document.querySelector('#hud').className }));
  await shot(page, dir, 'title', 'sw.rig.setOrbit(0.9, 0.3665, 15.5, true)');
  await page.evaluate(THAW);

  // The board as it opens.
  await load(page, '?dev');
  state.page = await page.evaluate(() => {
    const sw = window.__sw;
    const rect = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    const canvas = document.querySelector('canvas');
    return {
      htmlClass: document.documentElement.className,
      viewport: document.querySelector('meta[name=viewport]')?.content ?? null,
      metas: [...document.head.querySelectorAll('meta')].map((m) => m.outerHTML),
      bodyChildren: [...document.body.children].map((e) => `${e.tagName}#${e.id}.${e.className}`),
      hud: document.querySelector('#hud').outerHTML,
      rects: Object.fromEntries(['.wordmark', '.turn', '.leftcol', '.opponent', '.options', '.moves', '.captured', '.actions', '.hint'].map((s) => [s, rect(s)])),
      canvas: { css: [canvas.clientWidth, canvas.clientHeight], pixels: [canvas.width, canvas.height], style: canvas.getAttribute('style'), touchAction: getComputedStyle(canvas).touchAction },
      info: sw.info(),
      memory: { ...sw.pipeline.renderer.info.memory },
      programs: sw.pipeline.renderer.info.programs.length,
      shadowMap: [sw.lights.key.shadow.mapSize.x, sw.lights.key.shadow.mapSize.y],
      camera: { fov: sw.camera.fov, aspect: +sw.camera.aspect.toFixed(4), rig: [sw.rig.azimuth, sw.rig.elevation, sw.rig.distance, sw.rig.fov].map((v) => +v.toFixed(4)) },
      loop: { auto: sw.loop.auto, targetFps: sw.loop.targetFps },
      resources: performance
        .getEntriesByType('resource')
        .map((e) => e.name.replace(location.origin, ''))
        .filter((n) => !n.includes('/@vite') && !n.includes('/node_modules/') && !n.includes('/src/'))
        .sort(),
      localKeys: Object.keys(localStorage).sort(),
    };
  });

  await shot(page, dir, 'seat-ivory', 'sw.free(); sw.orbit(0, 44, 19.5)');
  await shot(page, dir, 'seat-obsidian', 'sw.free(); sw.orbit(Math.PI, 44, 19.5)');
  await shot(page, dir, 'low', 'sw.free(); sw.orbit(0.7, 20, 12)');
  await shot(page, dir, 'high', 'sw.free(); sw.orbit(-0.4, 78, 26)');
  const views = ['3.6,2.0,5.8, 0,1.0,0, 30', '-2.3,1.55,2.6, -0.75,1.25,0, 26', '2.3,1.55,2.6, 0.75,1.25,0, 26', '-1.5,1.74,1.15, -0.76,1.6,0.03, 20'];
  for (let i = 0; i < views.length; i++) await shot(page, dir, `look-${i}`, `sw.look(${views[i]})`);

  // HUD states.
  await shot(page, dir, 'hud-options', `sw.free(); sw.orbit(0, 44, 19.5); document.querySelector('#hud .options .head').click()`);
  await page.evaluate(`document.querySelector('#hud .options .head').click()`);
  await shot(page, dir, 'hud-selected', `sw.click('e2')`);
  await page.evaluate(`window.__sw.click(null)`);
  state.selected = await page.evaluate(() => document.querySelector('#hud').outerHTML.length);
  await page.evaluate(THAW);

  // A capture through its cinematic, on a clock of our own from a fresh load.
  await load(page, '?dev');
  await page.evaluate(`(async () => { ${FREEZE} sw.free(); sw.load('4k3/8/8/n7/8/8/8/R3K3 w - - 0 1'); window.__t = 100; for (let i = 0; i < 6; i++) window.__still(1 / 60, (window.__t += 1 / 60)); sw.begin('a1a5'); })()`);
  let at = 0;
  for (const t of [1.0, 4.0, 6.2, 6.6, 7.4, 9.0, 11.0]) {
    const frames = Math.round((t - at) * 60);
    await page.evaluate(`(() => { for (let i = 0; i < ${frames}; i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
    at = t;
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(dir, `capture-${t.toFixed(1)}.png`), scale: 'css' });
    console.log(`  capture-${t.toFixed(1)}`);
  }
  state.capture = await page.evaluate(() => ({ busy: window.__sw.busy(), fen: window.__sw.fen(), last: window.__sw.lastCapture }));
  await page.evaluate(`(() => { for (let i = 0; i < 600 && window.__sw.busy(); i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
  state.afterCapture = await page.evaluate(() => ({ busy: window.__sw.busy(), consistent: window.__sw.consistent() }));

  // The promotion card and the game-over card.
  await page.evaluate(`(async () => { const sw = window.__sw; sw.load('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1'); sw.click('a7'); sw.click('a8'); })()`);
  await shot(page, dir, 'promotion', 'sw.free(); sw.orbit(0, 44, 19.5)');
  await page.evaluate(`document.querySelector('#hud .choices button').click()`);
  await page.evaluate(`(() => { for (let i = 0; i < 900 && window.__sw.busy(); i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
  await page.evaluate(`(async () => { const sw = window.__sw; sw.load('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'); sw.begin('f7g7'); for (let i = 0; i < 1500 && sw.busy(); i++) window.__still(1 / 60, (window.__t += 1 / 60)); })()`);
  await shot(page, dir, 'game-over', 'sw.free(); sw.orbit(0, 44, 19.5)');
  state.gameOver = await page.evaluate(() => document.querySelector('#hud .overlay.show')?.textContent ?? null);
  await page.evaluate(`window.__sw.load()`);
  await page.evaluate(THAW);

  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 1));
  console.log(`captured to ${dir}`);
}

/** How far apart two stills are (ffmpeg prints the PSNR on stderr). */
function metric(fileA, fileB) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-i', fileA, '-i', fileB, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /average:([\d.a-z]+)/i.exec(String(run.stderr ?? ''));
  return m ? `PSNR ${m[1]} dB` : 'could not compare';
}

async function compare(dirA, dirB) {
  let different = 0;
  const files = (await readdir(dirA)).filter((f) => f.endsWith('.png')).sort();
  for (const f of files) {
    const [x, y] = await Promise.all([readFile(path.join(dirA, f)), readFile(path.join(dirB, f)).catch(() => null)]);
    if (!y) {
      console.log(`MISSING   ${f}`);
      different++;
    } else if (x.equals(y)) console.log(`identical ${f}`);
    else {
      console.log(`DIFFERENT ${f}  ${metric(path.join(dirA, f), path.join(dirB, f))}`);
      different++;
    }
  }
  const [sa, sb] = await Promise.all([readFile(path.join(dirA, 'state.json'), 'utf8'), readFile(path.join(dirB, 'state.json'), 'utf8')]).then((s) => s.map((t) => JSON.parse(t)));
  const walk = (x, y, where) => {
    if (typeof x !== typeof y || Array.isArray(x) !== Array.isArray(y)) return [`${where}: ${JSON.stringify(x)?.slice(0, 80)} -> ${JSON.stringify(y)?.slice(0, 80)}`];
    if (x && typeof x === 'object') return [...new Set([...Object.keys(x), ...Object.keys(y ?? {})])].flatMap((k) => walk(x[k], y?.[k], `${where}.${k}`));
    if (x === y) return [];
    if (typeof x === 'string' && x.length > 200) {
      let i = 0;
      while (i < x.length && x[i] === y[i]) i++;
      return [`${where}: differs at character ${i}: …${x.slice(Math.max(0, i - 40), i + 80)}… -> …${String(y).slice(Math.max(0, i - 40), i + 80)}…`];
    }
    return [`${where}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`];
  };
  const diffs = walk(sa, sb, 'state');
  for (const d of diffs) console.log(`STATE     ${d}`);
  console.log(`${files.length} stills, ${different} different; ${diffs.length} state difference(s)`);
  process.exitCode = different || diffs.length ? 1 : 0;
}

try {
  if (cmd === 'capture' && a) await capture(path.resolve(a));
  else if (cmd === 'compare' && a && b) await compare(path.resolve(a), path.resolve(b));
  else {
    console.error('usage: regress.mjs capture <dir> | compare <dirA> <dirB>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(String(err?.stack ?? err).slice(0, 3000));
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
