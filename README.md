# Stonewake

A cinematic chess game for two players at one screen or online, or one player against the computer. The pieces are living stone statues: they
walk, leap and glide to their squares, and when one takes another it closes in, strikes, and the
loser shatters.

**Play it:** https://deadalus5.github.io/wizards-chess/ (desktop browser with WebGL 2; checked in Chromium)

## Run

```
npm install
npm run assets   # first time only: downloads the CC0 models, animations and textures (about 150 MB)
npm run dev      # then open http://localhost:5173
```

`npm run build` makes a production build in `dist/`; `npm test` runs the tests.

Online play needs the relay in `server/` (a Cloudflare Worker): `npm --prefix server install`
once, then `npm run relay` runs it locally on port 8787 alongside `npm run dev`. To put it
online: `npx wrangler login` once (in `server/`), `npm run relay:deploy`, then set `DEPLOYED` in
`src/net/config.ts` to the URL it prints. Until then the ONLINE choice is hidden in builds.

Every push to `main` is tested, built and deployed to GitHub Pages by
`.github/workflows/deploy.yml`. The CC0 assets in `public/assets` are committed, so CI does not
download them.

## Play

- Click a statue, then one of the glowing squares. Drag to orbit, scroll to zoom.
- Hold **Space** to hurry a move along.
- **Opponent**, top left: pass-and-play (two people, one screen), vs computer (choose Ivory or
  Obsidian and a level: easy, medium, hard, max; the camera stays on your side and undo takes
  back the computer's reply with your move), or auto-play (the computer plays both sides; pause
  and resume). Remembered between visits. The computer is Stockfish (GPL v3), running in a
  background worker; see `CREDITS.md`.
- **Online** (in the same panel): play someone on another computer, with no accounts. Pick a
  colour (or random) and create the game: you get two links, one to send and your own. Whoever
  opens the link you send plays the other colour; your own link always plays your side, on any
  device, so bookmark it. The game is kept on a small relay, so it can be played over days: open
  your link any time to carry on, and if your opponent moved while you were away, their move
  plays out when you arrive. Each camera stays behind its own army; you can only move on your
  turn; there is no undo (RESIGN instead, then REMATCH, which swaps the colours and keeps the
  links). When your opponent moves while the tab is in the background its title says
  "● Your move". MY GAMES lists the online games this browser has opened.
- **Options**, under the opponent panel (click to open): sound, cinematic captures (off keeps
  your own camera and skips the slow motion), follow the side to move, flip the view.
- Bottom right: undo, new game.

## The pieces

Each statue wears the top of its chess piece on its head, large enough to tell the pieces apart
from the player's seat. The metal is gold for Ivory and pale steel for Obsidian.

| Piece | Look | Weapon and movement |
|---|---|---|
| Pawn | Helmet with the pawn's ball on top, cuirass and greaves | Spear; walks |
| Knight | A metal horse's head in place of a human one, on a body in wrapped clothes: crossed jacket, sash, loose trousers, bound forearms and shins | Sword; leaps, and strikes as it lands |
| Bishop | Tall mitre, belted robe to the shins, a cross raised on the back | Staff; glides |
| Rook | Turret on the head and full plate: breastplate, collar, pauldrons, gauntlets, boots | War hammer; walks |
| Queen | Coronet, cuirass, and a round shield on her back whose ring and one stroke make a Q | Two swords; walks |
| King | Crown and cross, the heaviest pauldrons | Great sword carried on his back and drawn to strike; walks |

Rules are chess.js; rendering is three.js; debris physics is Rapier. All models, animations and
textures are CC0 (see `CREDITS.md`). Every sound is synthesised in the browser.

Notes for anyone working on the code are in `DEVNOTES.md`.
