#!/usr/bin/env node
// Dev helper: drive the test browser over the Chrome DevTools Protocol.
// The browser is a separate "Chrome for Testing" instance started with --remote-debugging-port=9333
// (see `npm run browser`), so it never touches the everyday browser profile.
//
//   node scripts/browser.mjs goto <url>
//   node scripts/browser.mjs shot <file.png> [--w=1600 --h=900 --dpr=1]
//   node scripts/browser.mjs eval "<js expression or async body>"
//   node scripts/browser.mjs click <x> <y>
//   node scripts/browser.mjs key <Key>
//   node scripts/browser.mjs console            print console errors/warnings seen since the last call
//   node scripts/browser.mjs place <x> <y> <w> <h>   move and size the window (outer, screen points)
//
// A second test browser (another profile, so its own localStorage: a second player online) is
// driven the same way with CDP_URL=http://localhost:9334.
//
// `eval` wraps the code in an async function; use `return` to get a value back (printed as JSON).

import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const CDP = process.env.CDP_URL ?? 'http://localhost:9333';
const [cmd, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const args = rest.filter((a) => !a.startsWith('--'));

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
const pages = context.pages().filter((p) => !p.url().startsWith('devtools://'));
const page = pages.find((p) => /localhost:(9222|5173)/.test(p.url())) ?? pages[0] ?? (await context.newPage());

async function sized(fn) {
  const w = Number(flags.w ?? 0);
  const h = Number(flags.h ?? 0);
  if (!w || !h) return fn();
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: Number(flags.dpr ?? 1), mobile: false });
  try {
    // let the app see the resize and render a couple of frames at the new size
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    return await fn();
  } finally {
    if (!flags.keep) await session.send('Emulation.clearDeviceMetricsOverride');
    await session.detach();
  }
}

try {
  switch (cmd) {
    case 'goto': {
      await page.goto(args[0], { waitUntil: 'load' });
      console.log(page.url());
      break;
    }
    case 'shot': {
      const file = path.resolve(args[0]);
      await mkdir(path.dirname(file), { recursive: true });
      await sized(() => page.screenshot({ path: file, scale: flags.device ? 'device' : 'css', type: file.endsWith('.jpg') ? 'jpeg' : 'png', quality: file.endsWith('.jpg') ? 88 : undefined }));
      console.log(file);
      break;
    }
    case 'eval': {
      const body = args[0];
      const result = await sized(() => page.evaluate(`(async () => { ${/\breturn\b/.test(body) ? body : `return (${body})`} })()`));
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1));
      break;
    }
    case 'click': {
      await page.mouse.click(Number(args[0]), Number(args[1]));
      break;
    }
    case 'move': {
      await page.mouse.move(Number(args[0]), Number(args[1]));
      break;
    }
    case 'key': {
      await page.keyboard.press(args[0]);
      break;
    }
    case 'resize': {
      // Resize the real browser window so the page's viewport is w x h CSS pixels. Unlike a
      // device-metrics override this persists after this helper disconnects.
      const session = await context.newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      const want = { w: Number(args[0]), h: Number(args[1]) };
      for (let pass = 0; pass < 3; pass++) {
        const inner = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight }));
        if (inner.w === want.w && inner.h === want.h) break;
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: inner.ow + (want.w - inner.w), height: inner.oh + (want.h - inner.h) } });
        await page.waitForTimeout(250);
      }
      console.log(JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))));
      break;
    }
    case 'place': {
      // Put the window at x y (screen points) with outer size w h: two test browsers side by side.
      const session = await context.newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      const [left, top, width, height] = args.map(Number);
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', left, top, width, height } });
      await page.waitForTimeout(250);
      console.log(JSON.stringify(await page.evaluate(() => ({ x: screenX, y: screenY, w: innerWidth, h: innerHeight }))));
      break;
    }
    case 'console': {
      const logs = await page.evaluate(() => (window.__consoleLog ?? []).splice(0));
      console.log(logs.length ? logs.join('\n') : '(no console output captured)');
      break;
    }
    default:
      console.error('usage: browser.mjs goto|shot|eval|click|move|key|resize|place|console ...');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(String(err?.message ?? err).slice(0, 2000));
  process.exitCode = 1;
}
// Exit without closing anything: the browser and its tabs stay open for the next call.
process.exit(process.exitCode ?? 0);
