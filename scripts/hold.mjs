#!/usr/bin/env node
// Keep a CDP connection open to each test browser while a two-player online test runs.
// Without one, macOS throttles a test window that is not frontmost to a few frames a second
// (rAF), and a move takes a minute to play out. Run it in the background; stop it afterwards.
//   node scripts/hold.mjs 9333 9334
import { chromium } from 'playwright-core';

const held = [];
for (const port of process.argv.slice(2)) {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  for (const page of browser.contexts()[0].pages()) {
    if (/localhost:(9222|5173)/.test(page.url())) {
      await page.bringToFront();
      held.push(page);
    }
  }
}
console.log(`holding ${held.length} game page(s)`);
setInterval(() => {}, 1 << 30);
