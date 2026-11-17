#!/usr/bin/env node
// Dev helper: play a fixed set of scripted games in the test browser at speed and check, after
// every move, that the statues agree with chess.js and stand on their squares (window.__sw.verify).
// The set covers captures by every piece type for both sides, en passant, promotion (quiet,
// by capture, under-promotion), both castles for both sides, king captures of every victim
// type, a capture that mates, and a plain checkmate.
//
//   node scripts/verify.mjs [passes=2] [speed=20]
//
// Two passes by default, so that each matchup plays both of its attack variants. Also reports
// the renderer's geometry / texture / program counts before and after (they should not grow).

import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const passes = Number(process.argv[2] ?? 2);
const speed = Number(process.argv[3] ?? 20);
const G = (moves, fen) => ({ fen, moves: moves.split(' ') });

export const GAMES = [
  // An opening with pawn, queen and bishop captures and a castle.
  G('e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 c7c6 g1f3 c8g4 f1e2 g4f3 e2f3 e7e6 e1g1 g8f6'),
  // En passant, each side.
  G('e2e4 a7a6 e4e5 d7d5 e5d6'),
  G('a2a3 e7e5 a3a4 e5e4 d2d4 e4d3'),
  // Promotion: by capture (each side), quiet, and to a knight.
  G('a7b8q', '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1'),
  G('h2g1q', '4k3/8/8/8/8/8/7p/4K1N1 b - - 0 1'),
  G('a7a8q h2h1n', '8/P6k/8/8/8/8/7p/K7 w - - 0 1'),
  // Castling: king's side and queen's side, for both.
  G('e1g1 e8c8', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1'),
  G('e1c1 e8g8', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1'),
  // Rook: forward, sideways, backward, and from the next square.
  G('a1a5', '4k3/8/8/n7/8/8/8/R3K3 w - - 0 1'),
  G('a1d1', '4k3/8/8/8/8/8/8/R2nK3 w - - 0 1'),
  G('a4a1', '4k3/8/8/8/R7/8/8/n3K3 w - - 0 1'),
  G('a1a2', '4k3/8/8/8/8/8/p7/R3K3 w - - 0 1'),
  // The other white pieces.
  G('g1f3', '4k3/8/8/8/8/5p2/8/4K1N1 w - - 0 1'),
  G('d1d6', '4k3/8/3b4/8/8/8/8/3QK3 w - - 0 1'),
  G('d1d2', '4k3/8/8/8/8/8/3p4/3QK3 w - - 0 1'),
  G('c1f4', '4k3/8/8/8/5p2/8/8/2B1K3 w - - 0 1'),
  G('e4d5', '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1'),
  // The king takes each kind of victim.
  G('e1e2', '4k3/8/8/8/8/8/4r3/4K3 w - - 0 1'),
  G('e1e2', '4k3/8/8/8/8/8/4p3/4K3 w - - 0 1'),
  G('e1d2', '4k3/8/8/8/8/8/3n4/4K3 w - - 0 1'),
  G('e1f2', '4k3/8/8/8/8/8/5b2/4K3 w - - 0 1'),
  G('e1e2', '4k3/8/8/8/8/8/4q3/4K3 w - - 0 1'),
  // Black's pieces.
  G('e8e7', '4k3/4R3/8/8/8/8/8/4K3 b - - 0 1'),
  G('a8a4', 'r3k3/8/8/8/N7/8/8/4K3 b - - 0 1'),
  G('d8d3', '3qk3/8/8/8/8/3B4/8/4K3 b - - 0 1'),
  G('g8f6', '4k1n1/8/5P2/8/8/8/8/4K3 b - - 0 1'),
  G('c8f5', '2b1k3/8/8/5P2/8/8/8/4K3 b - - 0 1'),
  G('e5d4', '4k3/8/8/4p3/3P4/8/8/4K3 b - - 0 1'),
  // A capture that mates, and a mate without one.
  G('d1d8', '3r2k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'),
  G('f2f3 e7e5 g2g4 d8h4'),
];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://localhost:9333');
  const context = browser.contexts()[0];
  const pages = context.pages().filter((p) => !p.url().startsWith('devtools://'));
  const page = pages.find((p) => /localhost:(9222|5173)/.test(p.url())) ?? pages[0];
  let failed = false;
  try {
    const result = await page.evaluate(
      async ({ games, passes, speed }) => {
        const t0 = performance.now();
        while (!window.__swReady) {
          await new Promise((r) => setTimeout(r, 200));
          if (performance.now() - t0 > 60000) throw new Error('game not ready');
        }
        const sw = window.__sw;
        const counts = () => ({ ...sw.pipeline.renderer.info.memory, programs: sw.pipeline.renderer.info.programs.length });
        sw.manual(false);
        sw.free();
        sw.load();
        await new Promise((r) => setTimeout(r, 300));
        const before = counts();
        const runs = [];
        for (let i = 0; i < passes; i++) runs.push(await sw.verify(games, speed));
        sw.load();
        await new Promise((r) => setTimeout(r, 300));
        return { runs, before, after: counts() };
      },
      { games: GAMES, passes, speed },
    );
    for (const [i, r] of result.runs.entries()) {
      console.log(`pass ${i + 1}: ${r.moves} moves over ${r.games} games, ${r.problems.length ? `${r.problems.length} PROBLEMS` : 'all consistent'}`);
      for (const p of r.problems) console.log(`  ${p}`);
      if (r.problems.length) failed = true;
    }
    console.log(`renderer before ${JSON.stringify(result.before)}`);
    console.log(`renderer after  ${JSON.stringify(result.after)}`);
  } catch (err) {
    console.error(String(err?.message ?? err).slice(0, 2000));
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}
