# Stonewake — developer notes

Working notes for whoever continues this build (human or agent). The approved plan is at
`~/.claude/plans/golden-kindling-moth.md` (the movement and captures session of 2026-11-17 had
its own: `~/.claude/plans/pasted-content-id-af0a-read-devnotes-md-temporal-spring.md`; the
computer opponent: `~/.claude/plans/add-a-computer-opponent-wiggly-metcalfe.md`; online play:
`~/.claude/plans/read-devnotes-md-add-two-player-calm-chipmunk.md`); this file
records what exists, how to verify it, the numbers already measured, and what is left. Update it
when any of that changes.

## Ground rules from the owner

- Cinematic 3D "living statue" chess on desktop: local pass-and-play, against the computer,
  the computer against itself, or two players online with no accounts (everything lives on the
  game's links). Visual quality and motion
  come first; movement and captures must be smooth and film-like, never janky.
- On a capture the attacker physically moves in, attacks, and destroys the captured piece.
- Chess rules come from chess.js; do not hand-roll rules. Do not write a chess engine: the
  computer is Stockfish (see "Computer opponent"), and every move it proposes is checked by
  chess.js before it is played.
- Original design: own title ("Stonewake", working), setting and piece designs. No names, looks or
  characters from existing games or films.
- Look at what is built (screenshots, frame strips) and measure frame rate; iterate until it is
  genuinely good.
- Git: repo at https://github.com/deadalus5/wizards-chess (public). Commit / push only when asked.

## Hosting

- Live at https://deadalus5.github.io/wizards-chess/ via GitHub Pages (source: GitHub Actions).
  `.github/workflows/deploy.yml` runs `npm ci`, `npm test`, `npm run build` and deploys `dist/` on
  every push to `main`.
- Vite's `base` is `/wizards-chess/` for builds only (dev stays at `/`); `ASSETS` in
  `src/pieces/assets.ts` is built from `import.meta.env.BASE_URL`. Any new runtime URL must do the
  same, or it 404s on Pages. `npm run preview` now serves at `/wizards-chess/`.
- `public/assets` (about 140 MB, largest file 6.8 MB) is committed rather than fetched in CI:
  the itch.io / Poly Haven / ambientCG downloads are the least reliable step. Keep single files well
  under GitHub's 100 MB limit.
- The online relay is live at https://stonewake-online.rbwcontent.workers.dev (the owner's
  Cloudflare account; `DEPLOYED` in `src/net/config.ts`). It is a separate deployment: a
  Cloudflare Worker with one Durable Object per
  game (`server/`, see "Online play"). Free plan: SQLite-backed Durable Objects, 5 GB storage
  per account, 100k requests a day; a game is a few KB. Deploy: in `server/`, `npx wrangler
  login` once (the owner's Cloudflare account), then `npm run relay:deploy` from the root (a
  push to `main` does not deploy the relay; only the page). If the address changes, update
  `DEPLOYED` and push. With `DEPLOYED` empty a build hides the ONLINE choice. Pages
  and the relay are on different origins: the relay answers CORS `*` (no credentials) for
  `POST /games`; the socket is not subject to CORS.
- Test-browser gotcha: if the Chrome for Testing window is behind other windows, rAF stops and a
  move never finishes (only screenshots force frames). `osascript -e 'tell application "Google
  Chrome for Testing" to activate'` first, and check `__sw.loop.callbacks` advances ~60/s.

## Run and check

```
npm run dev        # Vite on http://localhost:5173 (strict port); game at /, clip lab at /clip-lab.html
npm run assets     # re-download CC0 assets into public/assets (idempotent; archives cached in .cache/)
npm run typecheck  # tsc --noEmit
npm test           # vitest: rules wrapper, timeline, shot chooser, frame loop, pacing, pose tools,
                   # strike planning, the choice between attacks, the engine wrapper (worker
                   # mocked: UCI parsing, promotion suffix, stale replies), undo rule, online
                   # links / referee / sync plan (95 tests)
npm run build      # tsc + vite build into dist/ (checked: `vite preview` loads and plays captures)
npm run relay      # the online relay on http://localhost:8787 (wrangler dev; needs `npm --prefix server install` once)
npm run relay:check  # 25 protocol checks against a running relay (forged keys, wrong turn, stale ply, rematch...)
node scripts/verify.mjs [passes=2] [speed=20]   # 30 scripted games in the test browser (see below)
```

Testing the computer opponent (in the test browser, `?dev`): `__sw.staleTest()` (every
`appliedLate` 0), `__sw.autoVerify({ games: 3, speed: 20, level: 'easy' })` (`problems` empty),
`__sw.perfAuto(14, { level: 'hard' })` (`searchSlow` 0), then `__sw.ai('computer', { side: 'w' })`
and play with `__sw.click(sq)` in real time. Each helper leaves the opponent in pass-and-play
with its default settings.

Add `?dev` to the address to skip the title screen (the test scripts all do; without it the
camera drifts round the hall until a click). The debug API `window.__sw` is always installed.

## Verification tooling (important: Playwright MCP does not work here)

- The Playwright MCP cannot launch: it wants Google Chrome, which is not installed (Brave and
  Safari are). Workaround in use: a separate "Chrome for Testing" from the Playwright cache,
  driven over CDP by `scripts/browser.mjs`. Start it with:
  ```
  "$HOME/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    --user-data-dir=<scratch>/chrome-profile --remote-debugging-port=9333 --no-first-run --no-default-browser-check \
    --window-size=1600,1000 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
    --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion --hide-crash-restore-bubble \
    "http://localhost:9222/"
  ```
- The three.js devtools MCP proxies the dev server at **http://localhost:9222** (use `set_dev_port 5173`
  if it points elsewhere). Always open the game through 9222 so its bridge is injected. Its overlay
  is suppressed by `src/debug/consoleTap.ts`. `perf_monitor` timed out the one time it was tried.
- `scripts/browser.mjs`: `goto <url>`, `shot <file> [--w --h]`, `eval "<js>"` (async body, `return`
  a value), `click x y`, `key K`, `resize w h` (real window resize, persistent), `console` (prints
  captured warnings/errors).
  - `shot --w --h` uses a per-shot device-metrics override, which clears the canvas; it only works
    while the render loop is running. Under manual stepping use `resize w h` first, then plain `shot`,
    and `resize 1600 860` afterwards.
- Contact sheets: `scripts/sheet.sh out.png <cols> img...` (ffmpeg; this build has no `drawtext`).
- Helpers: `scripts/lineup.sh out [w|b]` (all six piece types of one side in a row, from the front
  and from behind), `scripts/piecesheet.sh out wq` (four views of one statue on its own: front,
  three-quarter, side, back; framed by the statue's height), `scripts/lookdev.sh` (four fixed views),
  `scripts/clipsheet.sh` (frames of one clip in the clip lab), `scripts/movesheet.sh` (frames of
  one chess move under manual stepping), `scripts/seqsheet.sh` (frames of any setup + trigger),
  `scripts/capsheet.sh out fen uci [frames dt cols w h lead]` (one move through the game's own
  cinematic camera, tiled), `scripts/keyframes.sh prefix fen uci w h t1 t2...` (full-size stills at
  given real-time seconds into a move; env `SETUP` adds JS such as a fixed `sw.look(...)`).
  Set `SHOT_DIR` to a scratch folder. zsh aborts on unmatched globs: delete with `find -delete`.
  Stills are stepped manually, so CSS transitions (HUD fade) appear mid-way in them; that is an
  artefact of stepping faster than real time.
- `scripts/verify.mjs [passes] [speed]`: plays 30 scripted games (60 moves) through
  `__sw.verify` and checks after every move that the statues agree with chess.js and stand on
  their squares: captures by every piece for both sides, en passant both sides, promotion (quiet,
  by capture, to a knight), both castles both sides, the king taking each kind of victim, a
  capture that mates, fool's mate. Two passes by default so that each pairing plays both of its
  attacks. Prints the renderer's geometry / texture / program counts before and after.
- Editing any file in the module graph reloads the page: never edit while a browser-driven job
  (a sheet, a verify run) is still going.
- K + minor piece v K is a draw and puts the result dialog over the shot: give lookdev positions
  a pawn each (`4k3/7p/8/8/3N4/8/P7/4K3 w - - 0 1`). The interface is `#hud`; the lookdev scripts
  hide it with `visibility: hidden` while they shoot.
- Handy capture positions: pawn `4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1` e4d5; rook
  `4k3/8/8/n7/8/8/8/R3K3 w - - 0 1` a1a5; queen `4k3/8/3b4/8/8/8/8/3QK3 w - - 0 1` d1d6; king
  `4k3/8/8/8/8/8/4r3/4K3 w - - 0 1` e1e2; bishop `4k3/8/8/8/5p2/8/8/2B1K3 w - - 0 1` c1f4; knight
  `4k3/8/8/8/8/5p2/8/4K1N1 w - - 0 1` g1f3. Also: en passant `4k3/7p/8/3pP3/8/8/P7/4K3 w - d6 0 1`
  e5d6; the king's kill with the victim behind him `4k3/7p/8/8/8/8/P3K3/4n3 w - - 0 1` e2e1 and
  beside him `4k3/7p/8/8/8/8/P7/3rK3 w - - 0 1` e1d1; a capture that mates
  `3r2k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1` d1d8; a king's capture in a crowd
  `r4rk1/ppp2ppp/8/8/8/8/PPP2nPP/R4RK1 w - - 0 1` g1f2; rook sideways
  `4k3/7p/8/8/8/8/8/n2R3K w - - 0 1` d1a1 and backward `4k3/8/8/8/R7/8/8/n3K3 w - - 0 1` a4a1.
- `window.__sw` (src/debug/api.ts): `load(fen?)`, `move('e2e4')`, `play([...])`, `click(sq)`,
  `consistent()`, `verify(games, speed)`, `manual(on)`, `step(seconds, hz)`, `begin(uci)`, `busy()`,
  `footDrift(uci)`, `look(px,py,pz,tx,ty,tz,fov)`, `free()`, `at(code,n,dist,azimuth,height,fov,aim)`,
  `orbit(az,elDeg,dist)`, `life(vein,eye)`, `stone(side,patch)`, `grade(patch)`, `dof(bokeh,range)`,
  `env(i,rotY)`, `explode(code,n,amount)`, `smash(code,n,power,height)`, `fractureReport()`,
  `strikes(side, only?)` (for each attack of each piece against each kind of victim: the head zone,
  where the attacker stands, the aim, when and how high the blow lands, the error between planned
  and real weapon positions; an entry ending `BODY` or `MISS` did not reach the head),
  `gaits(names,kind)`, `perf(seconds,width,fps)`, `perfMoves([uci],width)`
  (frame times while moves play in real time, listing any frame over 5 ms of CPU), `headroom(max)`,
  `info()`. Piece codes are side + type, e.g. `'wk'`, `'bp'`. `look()` also switches cinematic
  cuts off so a fixed view stays put; `free()` or `orbit()` switches them back on.
  - Added for movement and captures: `timing(cases)` (plays moves undrawn under manual stepping
    and gives, in real seconds, the cut in, the blow, the cut back, the total and every mark the
    timeline names: `cutIn`, `notice`, `arrive`, `strike`, `top`, `blow`, `stepOff`, `cutBack`);
    `pose(code, n, spec)` (try a held pose on one statue; `{clip, time}` shows
    any library frame on the real statue with its weapon); `weaponPath(code, clip, weapon, hits)`
    (speed peaks of the weapon's far end = candidate hit times, its speed every sixtieth of a
    second, and the wind-up top the planner would use); `placings(uci)` (each attack as it would
    be placed for that capture); `bystanders()` (for every capture open in the position: weapon
    samples inside bystanders for each attack, which is chosen, and the count for the attack that
    piece had before there was a choice); `captureTuning.variant = 0 | 1` (make every capture use
    that attack; `null` lets it choose); `lastCapture` (what the last capture chose, and from
    what); `boot` (`warmUpMs`, `strikesMs`).
  - Stills of one attack: set `captureTuning.variant`, read `timing()` for `marks.top` and
    `marks.blow`, then `scripts/keyframes.sh` at top, blow + 0.04, blow + 0.3, blow + 0.95.
  - Added for the computer opponent: `ai(mode, opts)` (mode `'pass' | 'computer' | 'auto'`;
    opts `side`, `level` `'easy' | 'medium' | 'hard' | 'max'`, `skill` / `movetime` to override
    the level (null clears), `pauseMs` (null: the natural pause), `restart`, `maxPlies`,
    `resultHoldMs`, `paused`); `aiState()` (mode, generation, thinking, requests / applied /
    stale / errors, finished games and results, search times); `autoVerify({games, speed, level,
    movetime, maxPlies, fen})` (engine plays itself at speed, the board checked after every
    move as `verify` does, plus renderer memory before and after); `perfAuto(plies, {level,
    movetime, renderWidth, fen})` (frame times while the engine plays itself in real time;
    `searchFrames` / `searchSlow` count frames, and slow frames, while a search was running);
    `staleTest(movetime)` (new game, undo, mode switch and side switch while the engine is
    thinking: `appliedLate` must be 0; also a superseded raw request). `engine` and `opponent`
    are exposed too. `verify` switches the opponent to pass-and-play first.
- Added for online play: `online.create(side)`, `online.state()` (side, connection, whether
  this player may move, the relay's view, the board's own move list, input sides, seat, the last
  30 lines of the session's log), `online.drop()` (cut the socket as a network fault would),
  `online.leave()`, `online.controller` (the `Online` object).
- **Testing online with two players.** Two test browsers, so each has its own localStorage
  (MY GAMES, what has been seen): the usual one on CDP 9333 and a second one with another
  profile on 9334 (same command line, `--user-data-dir=<scratch>/chrome-b
  --remote-debugging-port=9334`; give it a few seconds after launch before connecting, or
  Playwright fails with "Browser context management is not supported"). Drive it with
  `CDP_URL=http://localhost:9334 node scripts/browser.mjs ...`; `browser.mjs place x y w h`
  puts the two windows side by side (864 x 1000 each on this screen). Run `node
  scripts/hold.mjs 9333 9334` in the background for the whole test: without a CDP client
  attached, a window that is not frontmost is throttled by macOS to 2-3 frames a second and a
  move takes a minute to play out (the old `osascript activate` only reaches one of two
  instances, and System Events scripting is not permitted here). A side effect: with a CDP
  client attached the page always reports itself visible, so test the tab-title alert by
  overriding `document.visibilityState` in the page.
- `wrangler dev` (local relay) does not see a browser socket close when the page navigates
  away (a clean `close()` from script and a killed process are both seen at once). The relay
  treats a socket not heard from for 75 s as gone, so presence comes right within about 75-105
  s; whether production Cloudflare passes the navigation close on is not yet known.
- `window.__lab` (clip lab): `show(clip,t,prop)`, `look(...)`, `setTime(t)`, `tipTrack()` (weapon
  tip speed peaks = candidate hit times), `state`.
- **Frame cost:** WebGL timer queries are misleading on this GPU (it clocks down under light load
  and reported ~11 ms for a ~2 ms frame). Use `__sw.headroom()`, which renders the frame N times
  per refresh until frames drop.
- **Missed frames:** `__sw.loop.missed` counts refreshes genuinely missed (late callbacks net of
  the early ones that follow jitter). Take the difference across a measurement. The test
  browser on this machine sometimes drops about one frame a second for minutes at a time with
  the game idle and 6x headroom, then stops; it coincided with other load on the machine and
  not with anything in the game (audio, motes and HUD were each switched off without effect).
  Re-measure before believing a bad number.
- **Sound** cannot be heard from here. `__sw.audioReport()` renders every sound offline, returns
  peak / RMS / timing / spectral centroid, and draws spectrograms over the page (screenshot it,
  then `__sw.hideAudioReport()`).

### After changing a statue's shape

Head-pieces, armour and fittings change a statue's height and outline, which the capture planner
and the fracture both read. Run these before and after, and compare:

1. Look: `scripts/lineup.sh out.png w` and `b` (the row, front and back), then
   `scripts/piecesheet.sh out.png wn` for each piece changed. Check one view from the player's
   normal camera too; a piece has to read from there, not only close up.
2. Weapon reach: `__sw.strikes('w')` and `__sw.strikes('b')`. No entry in `versus` may end in
   `MISS` or `BODY`, and `fkErrorMm` / `fkErrorAimedMm` should stay at a few millimetres. The
   zone a weapon must enter is the victim's head and neck (`strikeZone`: from the base of the
   neck to nine tenths of the way up the head-piece, placed from its joints), so a taller
   head-piece or a different standing pose moves contacts; diff the strings against the run
   before the change and read each difference. A change to how a statue kneels (`KNEEL`,
   `KNEELS_WITH_OWN_ARMS` in capture.ts) moves the king's rows the same way.
3. Fracture: `__sw.fractureReport()`: `openChunks` and `openEdges` must be 0 for every type.
   Then break each changed piece and watch it (`__sw.smash('wn')` under `manual(true)` +
   `step`, or `scripts/seqsheet.sh`): a part marked `fracture: 'own'` falls as one chunk,
   `'attach'` parts ride on the nearest body chunk.
4. Captures: `scripts/capsheet.sh` with the positions listed above, for each changed piece as
   attacker and as victim; the weapon should be inside the body on the hit frame.
5. Rules and leaks: `__sw.verify(games, 20)` over games that use every capture type, en passant,
   promotion and both castles. Before and after, read `__sw.pipeline.renderer.info.memory`
   (geometries, textures) and `__sw.pipeline.renderer.info.programs.length`; they should not grow.
6. Frame cost: `__sw.headroom()` against the build before the change, taken the same day
   (`git stash push -- src`, reload, measure, `git stash pop`). Vertex count per design is in
   `fractureReport()`; generated parts are indexed by `mergeParts`, so a jump there usually means
   a part is being built with unshared vertices on purpose (a hard edge) or by accident.

## Measured so far

- Machine: Apple M5 Max, 3456x2234 panel; the test browser delivers 60 Hz rAF.
- Full army (32 statues), shadows, full post chain at 3200x1714: holds 6 renders per 60 Hz refresh,
  about 2.8 ms per frame; CPU about 1.3 ms per frame with nothing animating.
- Gaits (m/s at scale 1, cycle length m): Walk 0.79 / 1.28, Walk_Formal 0.79 / 1.28, Walk_Large
  0.66 / 0.94, Walk_Female 0.96 / 1.28, Jog 5.00 / 5.83, Sprint 7.66 / 6.06, Run_Female 3.72 / 3.10,
  Polearm_Run 3.74 / 2.96, Walk_Backwards 0.59 / 0.56, strafes about 0.35.
- Planted-foot drift after the foot planter: mostly 1-4 cm, up to 8 cm on a turning sidestep,
  concentrated at lift-off. Target was 2 cm; not met.
- Fracture: 47-48 chunks per design; female body watertight; male body has one non-manifold edge
  in one chunk (from the source mesh). After the 2026-11-17 redesign: 47 chunks each, 48 for the
  queen (her shield is one of its own), no open chunks; vertices per design 21-33 thousand
  (they were 30-44 thousand: generated parts now share identical vertices), triangles 20-34 thousand.
- Scripted games: 47 moves over six games (both castles, en passant, promotion, mate, stalemate)
  ended consistent with chess.js. (One entry in that list was an illegal move of mine: `a2a1n`
  while in check.) After captures were added: 45 more moves over seven games at 20x speed
  (captures by every piece type, en passant, promotion by capture, both castles, king captures)
  all consistent; undo straight after a capture restores the victim intact; a new game started
  0.7 / 1.7 / 2.6 / 3.6 s into a capture leaves 32 statues, no cinematic, nothing busy.
- Captures in real time at 3200x1720, 60 Hz: after the warm-up step, three different first-time
  captures peaked at 3.1 / 3.8 / 4.2 ms of CPU per frame with no frame over 5 ms. Before the
  warm-up the first capture had a single 21.6 ms frame (shader variants compiling) and the
  second a 15.8 ms one (weapon-reach solve for a new pairing).
- Weapon-reach planning: forward kinematics agrees with the real weapon meshes to 0-7 mm.
- With sound, motes, trails and the leaping knight in: a rook capture ran 414 frames with none
  missed (CPU max 3.4 ms); six moves from the opening with three captures ran 1,363 frames with
  none missed (CPU max 4.5 ms); 3200x1720 at 60 Hz. Headroom still 6 renders per refresh.
- Later scripted runs: 52 moves over seven games at 20x (promotion by capture and by quiet move,
  under-promotion, checkmate finale, en passant, both castles) consistent; a new game started
  part-way through a promotion or a checkmate finale leaves 32 plain statues.
- With the board reflection added: headroom 4 renders per refresh (it was 6), CPU median about
  2.5 ms per frame at idle.
- Long run: 97 moves with 49 captures at 25x left WebGL geometries (99), textures (101),
  programs (52) and physics bodies (4) exactly where they started; JS heap 578 -> 584 MB.
- Sound levels rendered offline (dBFS peak): footstep -18 (light) / -14 (heavy), landing -10,
  whoosh -17, staggering blow -8, killing blow -4, shatter -16 before a later +4 dB, select -23,
  check bell -19, finale -8, ambience -23 peak / -36 RMS. Nothing clips.
- After the 2026-11-17 redesign (bigger head-pieces, horse-headed knight, robed bishop, plated
  rook, queen's shield), compared with the build before it on the same day:
  - `strikes()` for both sides: 216 placements, none a miss, forward-kinematics error unchanged
    (0-2.3 mm); 8 placements differ, all because a victim's head-piece is taller (the rook's slam
    from the next square meets pawn, bishop and queen 6-16 cm higher at the same moment; the
    queen's slash meets a pawn 0.01 s sooner). Statue heights: pawn 1.73 m (was 1.67), knight
    2.01 (2.01), bishop 2.27 (2.12), rook 2.22 (2.18), queen 2.21 (2.11), king 2.61 (2.46).
  - 55 moves over 15 scripted games at 20x (every capture type, en passant, promotion by capture
    and to a knight, both castles, mate) consistent; geometries, textures and programs flat
    over repeated runs (100 / 101 / 52).
  - Frame cost is level: three full renders fit in a 60 Hz refresh before and after (four take
    25 ms in both); idle CPU 2.3 ms a frame (2.4 before). Four captures in real time: none missed.
  - The first capture after a page load can have one frame of about 25 ms of CPU at the blow.
    The build before the redesign does the same (23.7 ms in one of two runs), so the warm-up no
    longer covers everything. (Found and fixed in the session below: it was the physics engine.)
- Movement and captures session (2026-11-17), against the build before it on the same day:
  - Moves, real seconds, before -> after: pawn e2e4 1.90 -> 2.25, e2e3 2.50 -> 2.85 (it rises
    and settles); queen d1d2 2.05 -> 2.48, d1d5 2.15 -> 3.33, d1h5 2.78 -> 3.80 (she floats);
    rook a1a2 2.40 -> 1.93, a1d1 2.45 -> 2.83, a1a5 2.22 -> 3.27, a1a8 3.12 -> 4.55 (it slides);
    castling 3.47, unchanged. Bishop, knight and king follow the same paths as before, step
    for step.
  - Rook slides and castling (`slideCheck`): 0 steps, 0.0 mm of foot stray, lift and sole tip;
    lean 2.6 degrees at full speed. A pivot takes 0.35 s + angle / 1.9 rad/s: 1.2 s for a quarter
    turn, 2.0 s for a half turn (kept slow by the owner's choice).
  - The grind: -19.2 dBFS peak, -34.9 RMS, between the footsteps and the ambience.
  - (The slide, its check and the grind were removed on 2026-11-18, when the rook was given a
    walk: see the next entry. The three lines above describe the build before that.)
- Rook's walk and marble plate (2026-11-18), against the slide before it:
  - Moves, real seconds: a1a2 1.93 -> 3.0, a1a3 4.7, a1d1 2.83 -> about 7.5 (two quarter
    turns), a1a8 4.55 -> 9.9, a retreat a3a2 3.6 (walked backwards), a5a1 about 10 (two half
    turns), castling 3.47 -> 7.3. Rook captures: a1a5 11.6 total (blow at 6.4), d1a1 11.6
    (blow at 5.7). King takes rook 8.05, unchanged. Turn figures were taken at 1.9 rad/s; the
    rate is now 2.4.
  - `footDrift`: 0.8-1.0 cm worst planted-foot drift walking forward, 2.2 cm walking backwards.
  - `strikes('w', 'r')`: every placing reaches the head, forward-kinematics error 2.3 mm.
    `scripts/verify.mjs`: 120 moves over 60 games consistent; geometries 99 -> 100, textures
    and programs flat. Headroom at 3200 x 1720: 2.3 ms of CPU a frame.
  - `Walk_Large` measures 0.66 m/s with a 0.94 m cycle at scale 1.
  - Captures, total real seconds on the standard positions, before -> now (first attack /
    second attack): pawn 5.57 -> 6.93 / 7.25; knight 5.27 -> 5.53 / 6.65; bishop 7.98 -> 8.18 /
    8.33; rook 6.30 -> 7.52 / 7.40; queen 5.52 -> 7.88 / 8.72; king 6.28 -> 8.05 / 8.27. The
    longest are the king taking a queen behind him (10.35 s) and a rook taking backward (9.10 s).
  - From the first motion of the attack to the blow: pawn 0.85 / 1.08 (was 0.45); knight 1.13
    (about 1.0) / 0.81 once landed; bishop 0.96 / 1.08; rook 1.08 (0.73) / 0.95; queen 0.83
    (0.50) / 1.65 with its flourish; king 1.20 / 1.35 after a 1.27 s draw (0.60 after 0.95).
  - The beat at the blow: 0.08 s stop, 0.75 s held at 0.25x, 0.6 s back to speed (it was 0.07,
    0.5 at 0.28x, 0.5); the king's: 0.1, 1.0 at 0.21x, 0.8. The shot stays on the break about
    2.3 s real after the blow (1.8).
  - Contact: all 60 pairings a game can produce (two attacks, six attackers, five victims), for
    both sides and every distance, land inside the victim's head zone. Before: pawn 0.68-0.83 m
    (hip), bishop about 1.0 (waist), rook 1.10-1.27 from two squares or more (chest), king
    1.42-1.46, knight 1.33-1.56, queen 1.61-1.65. Aims used, degrees: pawn's lunge 26 (pawn), 31
    (knight), 34 (bishop, queen), 49 (rook); bishop's sweep 0-28; rook's sweep 0-18; queen's
    cross cut -10 to 8, combination 0-23; king's sweep 0 to -21 (down at a kneeling head).
    Head zones, m: standing pawn 1.25-1.69, knight 1.38-1.95, bishop 1.48-2.20, rook 1.61-2.17,
    queen 1.52-2.15, king 1.67-2.53; kneeling pawn 0.85-1.20, knight 0.95-1.42, bishop 1.01-1.58,
    rook 1.13-1.60, queen 1.04-1.58. Forward kinematics against the real weapon: 0-3.8 mm, with
    and without an aim on.
  - Weapons through bystanders (`bystanders()`: samples of the weapon inside a statue that is no
    part of the fight): five king captures on crowded boards, 79 with the old single swing, 0
    with the attack now chosen. 41 other captures over 15 crowded middlegame positions: 0
    before, 0 now, and both attacks were open in 24 of them (pawn 7 of 7, knight 3 of 12, bishop
    6 of 11, rook 2 of 2, queen 5 of 8, king 1 of 1).
  - Checks: `verify.mjs`, two passes, consistent; geometries / textures / programs 100 / 101 /
    52; a new game started every 0.45 s through 19 kinds of capture (352 starts) always left 32
    statues at rest, no shot, no grind, nothing busy; undo after 11 kinds of capture restores
    the victim in its frozen pose, and is ignored during one; Space held: 1.07-1.40 s a capture;
    cinematic off: 4.7-7.3 s, no shot cut to.
  - Frame cost at 3200x1720: headroom 4 renders per refresh before and after; idle CPU median
    2.5 ms (2.4); the 13-move opening with three captures ran 3073 frames in 51.5 s (2560 in
    43 s before), CPU median 2.5 / p99 3.9 / max 4.9 ms, none missed, none over 5 ms.
  - First capture after a fresh load, twelve loads (one per attack): worst frame 3.4-7.6 ms,
    none missed. Before, every piece had one frame of 23.6-28.5 ms at the blow. It was the
    physics engine's first step with a pile of bodies (22.5 ms measured in `physics.update`),
    not shaders; the warm-up now rehearses a break. What remains over 5 ms: 5.2-6.2 ms at the
    blow (pawn overhand, both knight attacks, both queen attacks, king's sweep) and 7.1 / 7.6 ms
    about 0.7 s later as a pawn's pieces land.
  - Warm-up: about 830 ms before, 860-920 ms now. Planning every attack against every victim is
    125-155 ms of it; it was 400 ms until the search stopped working out the weapon's window
    afresh for each candidate placing (`SweepWindow`) and the weapon path stopped working out
    the whole skeleton (`bonesTo`).
- Computer opponent session (2026-11-17):
  - Engine start (worker, WASM compile, UCI handshake): 37-39 ms, three loads. Search times are
    the level's `movetime` (250 / 500 / 1000 / 2000 ms) to within 2 ms; a forced reply comes
    back in about 2 ms.
  - Auto-play at 20x, easy, board checked after every move (`autoVerify`): 858 engine moves
    over seven games, all ending in mate (81-159 plies), 153 captures, 13 castles, 5
    promotions, no problems, no move proposed that chess.js rejected. En passant did not come
    up in these games; it is covered by the scripted games and by `legalUci` tests.
  - Frame cost while the engine plays itself in real time (`perfAuto(14)`, hard, 3200x1720,
    60 Hz): 3397 frames in 56.6 s, none missed, CPU median 2.4 / p99 3.9 / max 5.3 ms (the one
    frame over 5 ms fell during a capture, with no search running). 840 frames fell during a
    search; none of them was over 5 ms or late. The engine stays off the main thread.
  - Late replies (`staleTest`): new game, undo, mode switch and side switch each made while the
    engine was mid-search: 0 moves applied late, 4 replies dropped; a superseded raw request
    resolves null and the next one still answers.
  - Renderer memory: geometries and programs flat (100 / 52). Textures 101 on a fresh load,
    102-104 after auto-play runs, 103 again after scripted games on the same page: it moves by
    one or two and comes back, so not a per-move leak, but not explained either (see "Not done").
  - Seen in real time vs computer (stills): the turn bar's "OBSIDIAN IS THINKING", the camera
    staying behind the human (both sides), the computer's rook capture through its cinematic,
    the computer's promotion with check, undo taking back two moves, clicks on the computer's
    statues ignored on its turn, auto-play restarting after mate, pause and resume.
- Online play session (2026-11-18), local relay (`wrangler dev`), two test browsers side by
  side at 864 x 857:
  - Relay protocol (`relay:check`): 25 of 25, including a forged key, a move with no hello, an
    unknown game, a move out of turn, an illegal move, a stale ply, the same move twice,
    garbage, a move after mate; mate, rematch (sides swapped, board clear), resignation,
    presence on leaving, reconnecting to a stored game.
  - In the two windows: creating as Ivory and joining from the invite (Obsidian, camera behind
    Obsidian); clicks on the wrong turn ignored; a move reaches the other window in about 3 ms
    (local) and plays its full cinematic there; a pawn capture seen in both windows at the
    same moment, each from its own side; the queen's recapture; promotion by both sides
    through the dialog (queen, and a knight); fool's mate with the mated king's finale in both;
    resignation through the confirm card; rematch requested, shown to the other side as
    ACCEPT REMATCH, accepted: colours swapped, cameras swung; the board consistent with
    chess.js in both (`consistent()`).
  - Away and back: a move made while the other window was gone was set up one move short on
    return and played out after the pause, the camera already behind the returning player.
    The relay stopped: both turn bars said RECONNECTING… and input closed; restarted: both
    back within 8 s with the 13-move game intact. A's own link opened in the other browser
    plays Ivory. Second game created: the first appears in MY GAMES and reopens from there.
    LEAVE GAME: back to pass-and-play, address cleared, the other side sees "away" at once.
  - Regression in the same session: `verify.mjs 1 20` 60 moves over 30 games consistent
    (geometries 99 -> 100, textures 103, programs 52); `staleTest` 0 applied late.
  - Deployed relay (`https://stonewake-online.rbwcontent.workers.dev`, version
    451f8783): `relay:check` 25 of 25.
  - Not measured: frame cost with a socket open (idle sockets and one small message every
    30 s; nothing on the frame path); two real machines.
- Attack clips as used now: hit time and top of the wind-up in seconds, from `weaponPath` on
  the real statues. Spear_Thrust 0.45, top set by hand at 0.25 (the spear is still until 0.2,
  the drive is 0.3-0.45, the fast part at 0.52 is the recovery). Two_Handed_Overhead_Slam
  0.70-0.73, top 0.43-0.44. Two_Handed_Horizontal_Swing 0.60, top 0.35-0.37 (between 0.4 and
  0.55 the weapon comes back round at 11-19 m/s: not a place to hold it). Sword_Attack 0.52, top
  0.22. Attack_Jump 1.21 (launch 0.6, land 1.22). Dual_Wield_Cross_Slash 0.50, top 0.30 (the
  blades are fastest at 0.42, overhead, and land as they slow). Dual_Wield_Combo: two passes
  that do not reach (to 0.84), blades drawn back by 1.11, double thrust at 1.21. Weapon_Draw:
  hand on the hilt at about 0.3, handed over at 0.95. Kneel: the knees give from 1.0, down and
  bowed at 1.95 (the clip is 2.92 long). Leap: NinjaJump_Start crouch at 0, airborne by about
  0.3; NinjaJump_Land feet down at 0.17.
  - Retired: Staff_Combo (its far end never rises above 1.28 m, so it cannot reach a head),
    Defend, Hit_Chest. Tried and not used: Dagger Stab driven with the spear (an overhand jab
    at 1.15-1.44 m, but slow and with no step), Sword_Attack_Air_Vertical (reach 0.7 m: the
    statues would overlap).
  - Where standing statues carry their weapons (own frame, m: left, up, forward): rook's mace
    head at about (-0.4, 0.45, 0.7); queen's blades to (-0.18, 1.29, 0.54) and (-0.09, 1.20,
    0.63); knight's sword tip (-0.29, 0.34, 0.69); pawn's spear and bishop's staff upright at
    0.2-0.3 forward.

## What exists

- **Assets** (all CC0, `scripts/fetch-assets.mjs`, `CREDITS.md`): Mesh2Motion clips and weapon props
  (pinned commit), Quaternius Universal Base Characters from itch.io (GitHub mirror fallback),
  Poly Haven chess set / HDRI / textures, ambientCG marbles. No audio downloaded yet.
- **Render** (`src/render`): `pipeline.ts` (HalfFloat composer, no MSAA: scene, N8AO half-res with
  transparency auto-detect off, DoF in its own pass, bloom + AgX tone map + grade + vignette + sRGB
  encode, then SMAA + grain + shader letterbox), `stoneMaterial.ts`, `lighting.ts` (static
  shadow-casting spot key with a tracery cookie, rims, brazier point lights, hemisphere fill; all
  lights exist from the start), `hall.ts` (frame, stepped dais, floor, pillars, braziers),
  `board.ts` (bevelled tiles, Marble014 light / Marble009 dark), `markers.ts`, `noise3d.ts`,
  `normalArray.ts`.
- **Stone material:** `MeshStandardMaterial` patched with `onBeforeCompile`. Vertex attribute
  `aPart` = (normal-map layer, region, interior flag, band distance). Regions: 0 stone, 1 metal
  trim, 2 eye, 3 carved plate (stone with a metal edge band). `uLife` = (vein glow, eye glow,
  dissolve). Wrap-diffuse "SSS", curvature patina / edge wear, solid veining from a 3D noise
  texture sampled in bind-pose space. Shatter variant (`STONE_SHATTER`) reads per-chunk matrices
  from a float texture (`fx/chunkField.ts`) and has a matching depth material. Looks: `IVORY`,
  `OBSIDIAN`. Program cache keys are `stone-v4*`; bump them when the shader text changes.
- **Statues** (`src/pieces`): `statueKit.ts` (bodies, hair, rigs, clip retargeting cache),
  `regalia.ts` (chess-piece tops as head-pieces, fitted helmet, the knight's horse head),
  `armor.ts` (plates and clothes generated from the body surface as offset shells that keep the
  skin weights; hanging skirt plates; hanging cloth), `fittings.ts` (rigid sculpted fittings:
  the queen's shield, the rook's toe caps), `roster.ts` (one design per piece type: body, hair,
  scale, weapons, armour, cloth, fittings, frozen pose, standing pose, mover and its settings,
  gaits), `buildPiece.ts` +
  `fracture.ts` (merge into one skinned geometry, pre-fracture, caps), `actor.ts`, `cast.ts`
  (`buildDesign` assembles a design), `weapons.ts`.
- **What each piece wears** (all in the two existing materials: the army's stone, and its metal
  trim, which is gold for Ivory and pale steel for Obsidian):
  - Head-pieces are the tops of the chess pieces worn large (`HEAD_PIECES`: `fit` to the skull,
    `tall` stretches, `flare` widens the top and leaves the foot head-sized). Pawn: ball on a
    helmet. Bishop: tall mitre. Rook: flared turret. Queen: coronet. King: crown and cross.
  - Knight: the head is cut off the body at the neck (`cutAway`) and the chess knight's horse,
    from the collar up, is set on the head bone at 0.98 m per king height (`horseHead`), with
    eyes that take the eye glow. Wrapped clothes: crossed jacket with a gilt edge (`gi`), sash
    with hanging ends, loose trousers, bound forearms and shins.
  - Bishop: long-sleeved robe with bell cuffs (`vestment`), a cross raised from the robe's own
    surface on the back, gilt belt, and a pleated robe to the shins (`drape`).
  - Rook: heavy plate. Breast and back plate with a lapped belly plate and two-lame pauldrons
    are the army's stone, smooth, with a broad metal border (`heavy` in `armorParts`:
    `bandNarrow: 0.5`, about 22 mm). All metal: standing collar, flared gauntlets, boots with
    a cuff, knee plates and rigid toe caps.
  - Queen: round shield on the back (rigid on `spine_03`, breaks away whole) whose raised ring
    and one stroke make a Q; a baldric over the cuirass.
- **Shells** (`buildShell`): besides clip planes, `exclude` cuts convex holes (necklines, the
  arms of the cross are what is left after four corners are cut away), `thickness` may be a
  function of position (bell sleeves, boot cuffs), `smooth` evens the offset surface and makes
  the plate end in a clean cut (its outline is moved out within the planes that cut it, parallel
  to itself), `bandNarrow: 0` drops the gilt edge (cloth). A shell can be cut from another shell
  (the cross from the robe, the jacket's flap from the jacket). Pieces written before the
  redesign do not use `smooth` and are built as they were.
  - A cut-out is made by splitting every triangle along every plane of the hole, on both sides,
    so that neighbours still meet edge to edge; cutting only inside the hole leaves T-junctions,
    which read as outline. Those planes therefore pass through the outline elsewhere too: a
    plane counts as cutting the outline only where an outline edge lies in it.
  - The wall round a plate's edge is oriented from the triangle's winding, not from its third
    vertex (clipping leaves slivers whose third vertex all but lies on the edge).
  - Neck holes are elliptical prisms whose floor is deep inside the chest, so only their sides
    meet the surface; a horizontal cut across the trapezius is nearly parallel to it and ragged.
- **Cloth** (`drape`): falls from the widest part of the body above each point, in spans (gaps
  are slits), skinned to the pelvis, the nearer thigh and, below the knee and away from the
  middle, that leg's shin: never more than four bones, and the same four on both sides of the
  seam at the back (five, with ties broken differently, opened a crack there).
- **Parts** can carry per-vertex `region` and `layer` attributes (a fitting of stone and metal,
  the horse's eyes); a material boundary must not share vertices, or the region interpolates
  through the eye value between them. `mergeParts` indexes every generated part
  (`shareVertices`), which draws the same and costs the vertex shader far less.
- **Animation** (`src/anim`): clips are retargeted by world-space rest-pose deltas and baked to
  uniform frames (`bake.ts`); `pose.ts` samples with Catmull-Rom and blends layers with per-bone
  masks (three's AnimationMixer is not used); `gait.ts` measures ground speed and footfalls;
  `footPlanter.ts` pins the ball of a planted foot with two-bone IK and takes real steps;
  `ik.ts` is the two-bone solve it uses.
- **Held poses** (`anim/sculpt.ts`): a pose is built from clip frames laid over groups of bones
  (`composePose`), wrapped as a clip that holds still (`staticClip`) so it layers like any
  other, and shaped by hand: `turnBone` (one bone about an axis in the figure's frame),
  `plantFeet` (legs re-placed in a planted stance), `aimPose` (both arms raised or lowered about
  the line of the shoulders, a quarter of it taken by the upper spine). A statue has a frozen
  pose and a standing pose (`actor.frozen` / `actor.upright`: the same clip unless the design
  gives a `stand`); `baseLayers` + `setBase(layers, weight, risen)` blend between them, and
  `actor.adjust` is a last touch to the blended pose before it goes to the bones (an aim, a
  bowed head), cleared whenever the statue freezes.
- **How each piece moves** (`mover` in the roster, `planTravel` in `moves.ts`):
  - Pawn: frozen in a braced half-crouch (legs and a third of the trunk from `Sword_Block`,
    shield arm from `Idle_Shield`, the rest `Polearm Idle`). It rises into its first stride
    (0.45 s) and settles back once it has arrived (0.5 s), stepping into the stance.
  - Knight: leaps (`planLeap`). King: walks. Bishop: floats (`planGlide`), turning on its feet
    after it lands; unchanged.
  - Queen: floats on the same mover with her own `glide` spec: a slow lift, a held beat,
    upright, no bob, a slow descent and a soft landing; hands lifted from her sides with the
    palms turned out (`hands`, an arms-only layer); she turns in the air, so a turn on the spot
    is a small lift; she takes a captured square with a short float (`floatsOn`), never on foot.
  - Rook: walks, heavily (`strut` in the roster, read by `planWalk`). It turns to face its
    path (2.4 rad/s, a big turn all but finished before it sets off and begun only as it
    stops), walks it on `Walk_Large`, and turns back to face the enemy. The gait quickens with
    distance (`walk.rate` at one square to `run.rate` at six). `stagger`: the travel runs on a
    clock that slows at each footfall and quickens between, so the body checks and surges while
    the gait's phase still follows distance covered. `lean` into the motion, `sway` over the
    planted foot, a thud and dust at each footfall and as it stops. A retreat of up to two
    squares is walked backwards, as for any walker. On the spot it turns on its feet like the
    other walkers, never faster than its own rate.
  - `planStepOn` is how a piece takes the square it has cleared; `planTurn` turns one on the
    spot in the manner of its kind, and with `rise` stands a crouched one up.
- **Game** (`src/game`, `src/chess`, `src/input`, `src/ui`): `ChessGame` wraps chess.js into
  `MoveEvent`s; `GameController` handles selection, markers, promotion, undo, new game, follow-turn
  camera; `Picker` is analytic (board plane + per-statue cylinders); `Hud` is DOM.
- **Sequencing** (`src/sequence`): `Timeline` (spans + cues, plus named `marks` for the debug
  timings), `moves.ts` (`planWalk`, `planLeap`, `planGlide`, `planTurn`,
  `planStepOn`, castling, promotion swap), `pacing.ts` (`SpeedProfile`: travel with hard or eased
  ramps; `TimeWarp`: the playback of an attack clip, see Captures), `Director` (plays a timeline
  on game time; Space fast-forwards; `baseSpeed` for tests; owns the hit-stop / slow-motion beat,
  ordinary or `grand`; `reset()` abandons a move in flight).
- **Captures** (`attacks.ts`, `strike.ts`, `capture.ts`). Each piece has two attacks
  (`ATTACKS`): pawn lunge / overhand, knight leaping cut / landing cut, bishop sweep / slam, rook
  slam / sweep, queen cross cut / combination, king sweep / execution (both after the draw).
  - Placing. `StrikeTrack` runs forward kinematics (only the bones that lead to the weapon hand)
    over the clip for the weapon's grip and far end. `strikeZone` is the victim's head and
    neck, from its joints in the pose it will hold. `solveStrike` searches stand-off distance,
    a small turn of the body and, where the blow allows it, an aim, for the placing at which
    the blow enters the zone nearest its fastest moment, with the outer part of the weapon,
    without passing through the body on the way; an overhead blow should land on the crown, a
    swing or thrust on the neck or face. The aim is `aimPose`, the same function in the plan
    and on the statue. If the head cannot be reached the blow lands as high on the body as it
    can and the solution says `short`. `strikeFor` caches by attack, victim, posture and
    distance; the warm-up fills the cache.
  - Choosing (`chooseAttack`, rule in `pickAttack`): both attacks are placed; only those that
    reach the head are kept; of those, the ones whose sweep passes through no bystander
    (`sweepTouches`), or the least; of those, not the one this pairing used last time.
  - Pacing: `TimeWarp` plays the wind-up slower, holds a beat at its top (the last moment the
    weapon is all but still, `windupTop`, or `apex` by hand), puts the blow through at close to
    its own speed and slows the follow-through; `lead` leaves a flourish before the wind-up at
    its own speed (the queen's combination). Hit times, the whoosh and the trail all go through
    the warp.
  - The victim (`planStandingVictim`): wakes 0.12 s after the cut, comes round to its attacker
    without hurry in the manner of its kind (a crouched pawn rises as it turns), stands, and
    over the last 0.4 s shifts its weight back a little and lifts its chin. There is no guard.
    A rook stands about 30 degrees past square-on with its mace side back (`quarter` in the
    roster) and looks at its attacker over its shoulder: square-on, its mace is where a close
    attacker plants its feet.
  - The king's kill (`planKneelingVictim`, only when the attacker is the king): the victim goes
    down on one knee over 2.3 s from the moment it stirs, going down the whole time, head bowing
    over the second half, and is still for 0.5 s before the blow. Pawn, knight and bishop sink
    as they turn; a rook sinks as it turns too, and a queen lifts and turns first. A pawn goes from its
    crouch straight into the kneel. Pawn and bishop keep spear and staff upright and the queen
    keeps her arms (`KNEELS_WITH_OWN_ARMS`); the clip's arms would lay them out at the king's
    feet or through her. The blow is planned against the kneeling head; the king's draw is
    slowed so he is not idle; the break gets the `grand` beat.
  - `planCapture` lays out: approach (handing straight into the strike), the victim's track, the blow (impact effects, slow motion,
    `cast.detach`, `shatter.shatter` with the weapon's onward path so stone gives way as it is
    reached), standing over the break until the pieces have come down, taking the square through
    the rubble (`shatter.setPusher`), camera cut in and back. Stand-off spots swing round the
    victim if another statue is in the way; if the weapon reaches from the attacker's own square
    it strikes from there; it never backs away to strike.
- **Camera** (`src/cinema`): `CameraRig` (player orbit, override pose, shake), `cinema.ts`
  (`Cinema`: cut / release, letterbox, depth of field, slow push-in; `chooseShot`: candidate
  two-shots scored for occlusion, background clutter, looking across the board rather than out
  into the hall, staying on the player's side, low height first).
- **Effects** (`src/fx`): `physics.ts` (Rapier, fixed 1/120 s step with interpolation),
  `shatter.ts` (breaks a pre-fractured statue into rigid bodies released in a wave from the hit,
  or sooner where the weapon's onward path reaches them; throws them outward, level, from the
  line of the blow; drops weapons, fades the glow, heats then cools the broken faces, dissolves
  the rubble with embers; `tuning` holds the wave delay and the outward share), `particles.ts`
  (`Dust` soft lit wisps, `Sparks` additive streaks and flashes, `Shards` instanced chips with
  bounce), `effects.ts` (`impact`, `collapse`, `landing`, `footstep`, `embers`, `settle`, a pulsed point light at the blow, camera shake).
- **Particle layer:** dust and sparks are not in the main scene. `Pipeline.overlay` is rendered
  into its own half-float buffer after depth of field (`OverlayEffect`) and laid over the picture
  before bloom; the particle shaders test and soften themselves against the scene depth texture.
  Drawn in the main pass they took on the blur and ambient occlusion of whatever was behind them.
  The pass is enabled only while particles are alive.
- **Knight:** its own capture is a leaping strike (`planLeapStrike`): the jump-attack clip leaps
  on the spot, and its take-off and landing are stretched over the knight's own flight to a clear
  spot beside the victim; where it lands and the moment of contact are both solved with the
  body's position during the fall taken into account (`moving` in `solveStrike`); the camera
  booms up to follow (`Cinema.lift`). Its second attack is a plain leap to the same spot, a
  quick rise out of the landing, and `Sword_Attack` from a standing start; its swing is wide,
  so it is only chosen in the open.
- **Weapon trails** (`fx/trails.ts`): a ribbon built each frame from the planned weapon path
  over the last 0.11 s of clip time, not from past frames, so it is smooth at any frame rate
  and in slow motion.
- **Motes** (`Motes` in `particles.ts`): dust in the air, animated in the vertex shader, drawn
  in the particle layer; each grows into a bokeh disc by its distance from the plane of focus.
- **Promotion and checkmate** (`sequence/special.ts`): the pawn dissolves while the new piece
  forms (the dissolve uniform run both ways); at checkmate the mated king kneels and breaks
  while the victors' eyes burn. `Timeline.onAbort` cleans up if a new game interrupts.
- **Sound** (`src/audio`): everything is synthesised (`synth.ts`: filtered noise, sine partials,
  a generated hall impulse response); `audio.ts` places events by screen position and distance.
  Starts on the click that dismisses the title. Toggle in the HUD, remembered.
- **Frame loop** (`core/loop.ts`): steps the game by whole refresh intervals (callback
  timestamps jitter), forgives single missed frames, catches up only under sustained slowness,
  uses the display's full rate when it is 100 Hz or more and falls back to an even 60.
- **Computer opponent** (`src/ai`): Stockfish.js 19.0.1 "lite single-threaded", vendored
  unmodified in `public/engine/` (28 KB JS + 1.8 MB WASM + `Copying.txt`; GPL v3, credited in
  CREDITS.md). Single-threaded needs no SharedArrayBuffer, so no COOP/COEP headers: it runs on
  GitHub Pages as is. Its URL is built from `BASE_URL` (`ENGINE_URL` in `engine.ts`). Not an npm
  dependency: the package is 205 MB with the full networks. To update it, fetch
  `bin/stockfish-<v>-lite-single.{js,wasm}` and `Copying.txt` from the npm tarball and change
  `ENGINE_URL`.
  - `engine.ts` (`Engine`): worker wrapper. `init()` (uci / uciok, isready / readyok, lazy),
    `newGame()` (ucinewgame), `bestMove(fen, {skill, movetime})` resolves UCI or null, `stop()`,
    `dispose()`. One search at a time: UCI answers every `go` with one `bestmove`, even after
    `stop`, so a new request stops the current one and is only sent once the stale answer has
    come back (which is thrown away). `info` lines are skipped unparsed. Levels (`LEVELS`):
    easy skill 1 / 250 ms, medium 6 / 500, hard 13 / 1000, max 20 / 2000.
  - `opponent.ts` (`Opponent`): the mode (pass-and-play / vs computer with the human's side /
    auto-play with pause), remembered in localStorage (`stonewake.mode`, `.side`, `.level`).
    `GameController.onSettled` (after a new game, an undo, or a move has played out, busy
    cleared, so never during a cinematic or the promotion dialog) calls `poke()`, which asks
    for a move if it is the engine's turn. The search runs during a natural pause (0.7-1.2 s
    vs computer, 1.0 s in auto-play, divided by `director.baseSpeed`); the move is played when
    both are done, and only if the request's token, `controller.generation` (bumped by every
    move, undo and new game) and the FEN all still match. Anything else counts as `stale`.
    Moves are checked by `ChessGame.legalUci` (chess.js) and played by
    `GameController.playUci`, which calls the same `move()` a click does: every cinematic
    plays. Undo (`undoPlies`): vs computer on your turn takes back its reply and your move,
    while it thinks only your move; auto-play pauses and takes back one. Auto-play leaves the
    result up for 6 s, then starts a new game (`restart`), and calls a game off at 300 plies.
    If the engine fails, the turn bar says THE ENGINE IS SILENT and the mode drops to
    pass-and-play.
  - Controller: `inputSides` (clicks and hover markers only for the human's side), `seat`
    (vs computer the camera stays behind the human; follow-turn does not swing to the
    computer), `generation`, `undo(plies)`.
  - HUD: OPPONENT panel top left (mode; side and level vs computer; level and pause in
    auto-play); the turn bar says "OBSIDIAN IS THINKING" with a pulsing chip during a search.
- **Online play** (`src/net`, `server/`). No accounts: a game is an id plus two seat keys, and
  a link is `<page>#play=<id>.<key>` (in the hash, so Pages never receives it). The key alone
  decides the side; "my link" and the invite link look alike. Creating a game puts the
  creator's own link in the address bar (`history.replaceState`), so a bookmark or reload comes
  back to the same seat; the share card shows both links.
  - Relay (`server/src/worker.ts`, `gameRoom.ts`): `POST /games {side}` makes the game (side
    `random` is drawn on the relay); `GET /games/<id>/ws` is the socket to its Durable Object
    (`idFromName(id)`), WebSocket Hibernation API, state in the object's storage, an alarm that
    deletes a game after 120 days untouched. The key goes in the first message (`hello`), not
    the URL. Every message is checked by `src/net/referee.ts` (pure, shared with the tests):
    seat, turn, `ply === moves.length` (so a move sent against a position that has changed, or
    sent twice, is refused, never applied to the wrong one), chess.js legality, result on mate
    or draw, resignation, rematch (both must ask; the sides swap, the keys stay, `round` + 1).
    After any change each socket gets the whole game from its own side (`state`); a refusal is
    followed by the state as it stands, so a client always has something to put itself right
    with. Presence: a socket counts while it is open and has been heard from in the last 75 s
    (clients send `sync` every 30 s; `getWebSocketAutoResponseTimestamp` covers plain `ping`);
    a silent one is closed.
  - Client (`session.ts`, `OnlineSession`): one socket, reconnecting with backoff (1-30 s, at
    once on `online` / `visibilitychange`); a `sync` unanswered for 10 s reopens the line.
    `syncPlan` (`sync.ts`, pure) compares the board's moves with the relay's: one behind,
    play it out (`controller.playUci`, the full cinematic); our own move in flight, wait; equal,
    nothing; anything else, `controller.loadMoves` (set up at once). On opening a link, if the
    opponent's last move has not been shown in this browser (`stonewake.online.seen.<id>` =
    `round:plies`), the board is set up one move short and that move is played after a 1.5 s
    pause (also after the title screen). A move that arrives during a cinematic waits for
    `onSettled`. A move made by clicking goes out from `controller.onMove` when it is ours and
    the relay does not have it yet; if the line is down it is sent again on reconnecting.
    Input is open only while connected, in step with the relay and the game not over
    (`canMove`); `Opponent` mode `online` (never stored) takes `inputSides` and `seat` from it,
    placing the camera at once on joining and swinging it on a rematch. Undo is off
    (`undoPlies` 0) and NEW GAME is a no-op online.
  - `online.ts` (`Online`): create / open / leave / resign (with a confirm card) / rematch,
    `hashchange` (pasting another link joins it), the tab-title alert ("● Your move —
    Stonewake" and the check bell when the opponent moves while the tab is hidden; cleared on
    return), MY GAMES (`stonewake.online.games` in localStorage: id, key, side, invite key for
    the creator, plies, status). Leaving returns to the mode played before, with a fresh board.
  - HUD: ONLINE in the OPPONENT panel (hidden with no relay); lobby (PLAY AS ivory / obsidian /
    random, CREATE ONLINE GAME); in a game: your side, the opponent here / away, COPY INVITE
    LINK (creator's browser only), COPY MY LINK, LEAVE GAME, MY GAMES. The turn bar reads YOUR
    MOVE / WAITING FOR OBSIDIAN / RECONNECTING… / THE GAME IS OVER. Online, UNDO, NEW GAME,
    FLIP and FOLLOW TURN are hidden and RESIGN shown; the game-over card offers REMATCH
    (ACCEPT REMATCH when the other side has asked) and VIEW THE BOARD (all modes).
  - `ChessGame` gained `historyUci()`, `resign(side)` (in `status().resigned`, cleared by
    reset / load / undo) and `uciOf`; `GameController` gained `loadMoves`, `onMove`,
    `resign`, and disposers from `onSettled` / `onMove`.
- **Interface:** title screen (`Hud.showTitle`), toggles for sound, cinematic captures (off:
  no cut, no slow motion) and follow-turn, all remembered in localStorage. The toggles and FLIP
  sit in a collapsible OPTIONS panel under OPPONENT (both in `.leftcol`, top left; open state
  in `stonewake.options`, collapsed by default); UNDO and NEW GAME stay bottom right.
- **Warm-up** (`src/core/warmup.ts`): behind the loading screen it rehearses a break in the
  physics engine (its first step with a pile of bodies is slow), places every attack of every
  piece against every victim in the posture it will meet (from the next square exactly, and with
  each distance as a limit; a leap from a knight's move away), and renders two frames with a
  statue of each design in its shatter variant, every particle type, a marker, and the
  depth-of-field and particle passes on. One set of shatter materials is kept alive for good,
  otherwise three.js frees the program when a break disposes the last material using it.
- Board tiles compute highlights from the lights as if slightly rougher (`softenLightHighlights`
  in `board.ts`): a point light mirrored in polished stone bloomed into a star on the board.
- **Board reflection** (`render/reflection.ts`): the scene is rendered once more each frame
  from a camera mirrored through the board (oblique near plane, half size, mip chain, last
  frame's shadow map); the tile shader adds it by Fresnel, blurred by roughness. Tiles and
  markers are hidden in that pass. `__sw.reflection.strength = 0` switches it off.
- The camera's swing to the other seat (`CameraRig.viewFor`) is an eased turn of up to two
  seconds; dragging cancels it.
- Conventions: square = 1.25 m; files along +x; White's back rank at +z, White faces -z (yaw pi).

## Not done yet (in the order planned)

1. **Capture variety:** each piece has two attacks, chosen per capture. Not done: cracks
   spreading before the final blow, a second camera angle on the hit. The library has only two
   heavy two-handed clips (overhead and side swing); between them they serve the pawn, bishop,
   rook and king, so more variety than this needs new clips.
2. **Polish not done:** light shaft, head look-at, quality presets for slower machines (render
   scale is fixed at the device pixel ratio, capped at 2; the reflection and depth of field
   have no off switch in the interface), tests for fracture closedness, a layout for windows
   narrower than about 1000 px (the buttons wrap over the board).
3. **Online, not done:** not yet tried across two machines or through real networks (the
   deployed relay passes `relay:check`; the two-window tests ran against `wrangler dev`). No clocks, no spectators, no draw
   offers, no chat. Anyone holding a link plays that seat (by design: the link is the
   identity; lost links cannot be recovered or revoked). The your-move alert only works while
   the tab is open (a closed tab would need a service worker and Web Push). No rate limiting
   on `POST /games` beyond Cloudflare's own and the free plan's daily quota. Resignation has
   no cinematic of its own (the card only).
4. **Not verified:** Safari and Firefox (everything was checked in Chromium only); a real
   120 Hz display (the pacing logic is unit-tested, the test browser runs at 60 Hz); how any of
   the sound actually sounds (none of it has been heard, only measured). In the movement
   and captures session every attack was looked at as stills and every kind of victim was seen
   struck, about 30 of the 60 pairings; the rest are checked by number only (`strikes()`).
5. Known rough edges:
   - The knight's second attack (leap, land, cut) is the weakest of the twelve: two beats with
     a landing between them, and a swing so wide that it is shut out whenever anyone stands near.
   - Variation thins out in a crowd. An attack whose weapon would pass through a bystander is
     not used, so on a crowded board about half the captures have only one attack open. If both
     would pass through someone, the one that does so least is used.
   - The pawn's lunge has to be aimed up 49 degrees to reach a rook's throat (26-34 for the
     others).
   - Before the king, a queen that is not facing him turns first (up to 2.2 s for a half turn)
     and only then goes down. A queen turns by lifting whenever she is
     any piece's victim too, and the attacker waits for her.
   - Taking straight ahead, the king strikes with the middle of his blade and his hands come
     close to the victim's head: his sword is longer than a square and he does not back away.
   - In a profile shot a victim's weapon can overlap the attacker in the frame while being half
     a metre nearer the camera (a knight landing by a rook is the clearest case).
   - The rook's walk has been looked at as stills only, not in motion at speed, and its long
     moves are slow (about 10 s across the board; Space fast-forwards).
   - The queen's gaits in the roster (`walk`, `run`, `back`, `carry`) are no
     longer used by anything.
   - `bystanders()` in the debug API carries a copy of the attacks as they were before there
     were two, for the before and after count.
   - Thick plates still fold a little where their outline crosses the spine groove, and the
     rook's pauldrons are ragged under the arm (a horizontal cut through the armpit).
   - The bishop's feet are bare under the robe.
   - Obsidian's plate, horse head and cross are pale steel, because they use the army's trim;
     gold on both sides would mean changing `OBSIDIAN`'s trim colour in `stoneMaterial.ts`.
   - Planted-foot drift is above the 2 cm target (see "Measured").
   - A statue that walks onto the rubble pushes it with a capsule, so chips can remain under
     its feet until they dissolve.
   - The mated king stays in the cast, invisible, after its stone has gone (so undo can
     restore it).
   - Computer opponent: the renderer's texture count drifts by one or two over long auto-play
     runs and comes back (see "Measured"); not traced. The engine has no opening variety
     beyond what low skill levels add, so auto-play games at max level can repeat.
     `npm run preview` serves at `/` with this Vite (the `base` is only applied on build), so
     check Pages paths in the built bundle, not through preview. Stockfish is GPL v3: keep
     `public/engine/Copying.txt` and the CREDITS entry with it.
