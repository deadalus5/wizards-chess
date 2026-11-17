# Stonewake

A cinematic chess game for two players at one screen. The pieces are living stone statues: they
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

Every push to `main` is tested, built and deployed to GitHub Pages by
`.github/workflows/deploy.yml`. The CC0 assets in `public/assets` are committed, so CI does not
download them.

## Play

- Click a statue, then one of the glowing squares. Drag to orbit, scroll to zoom.
- Hold **Space** to hurry a move along.
- Buttons, bottom right: sound, cinematic captures (off keeps your own camera and skips the
  slow motion), follow the side to move, flip the view, undo, new game.

Rules are chess.js; rendering is three.js; debris physics is Rapier. All models, animations and
textures are CC0 (see `CREDITS.md`). Every sound is synthesised in the browser.

Notes for anyone working on the code are in `DEVNOTES.md`.
