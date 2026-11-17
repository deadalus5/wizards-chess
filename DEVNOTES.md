# Stonewake — developer notes

Working notes for whoever continues this build (human or agent). The approved plan is at
`~/.claude/plans/golden-kindling-moth.md`; this file records what exists, how to verify it, the
numbers already measured, and what is left. Update it when any of that changes.

## Ground rules from the owner

- Cinematic 3D "living statue" chess, local pass-and-play on desktop. Visual quality and motion
  come first; movement and captures must be smooth and film-like, never janky.
- On a capture the attacker physically moves in, attacks, and destroys the captured piece.
- Chess rules come from chess.js; do not hand-roll rules.
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
- Test-browser gotcha: if the Chrome for Testing window is behind other windows, rAF stops and a
  move never finishes (only screenshots force frames). `osascript -e 'tell application "Google
  Chrome for Testing" to activate'` first, and check `__sw.loop.callbacks` advances ~60/s.

## Run and check

```
npm run dev        # Vite on http://localhost:5173 (strict port); game at /, clip lab at /clip-lab.html
npm run assets     # re-download CC0 assets into public/assets (idempotent; archives cached in .cache/)
npm run typecheck  # tsc --noEmit
npm test           # vitest: rules wrapper, timeline, shot chooser, frame loop (23 tests)
npm run build      # tsc + vite build into dist/ (checked: `vite preview` loads and plays captures)
```

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
- K + minor piece v K is a draw and puts the result dialog over the shot: give lookdev positions
  a pawn each (`4k3/7p/8/8/3N4/8/P7/4K3 w - - 0 1`). The interface is `#hud`; the lookdev scripts
  hide it with `visibility: hidden` while they shoot.
- Handy capture positions: pawn `4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1` e4d5; rook
  `4k3/8/8/n7/8/8/8/R3K3 w - - 0 1` a1a5; queen `4k3/8/3b4/8/8/8/8/3QK3 w - - 0 1` d1d6; king
  `4k3/8/8/8/8/8/4r3/4K3 w - - 0 1` e1e2; bishop `4k3/8/8/8/5p2/8/8/2B1K3 w - - 0 1` c1f4; knight
  `4k3/8/8/8/8/5p2/8/4K1N1 w - - 0 1` g1f3.
- `window.__sw` (src/debug/api.ts): `load(fen?)`, `move('e2e4')`, `play([...])`, `click(sq)`,
  `consistent()`, `verify(games, speed)`, `manual(on)`, `step(seconds, hz)`, `begin(uci)`, `busy()`,
  `footDrift(uci)`, `look(px,py,pz,tx,ty,tz,fov)`, `free()`, `at(code,n,dist,azimuth,height,fov,aim)`,
  `orbit(az,elDeg,dist)`, `life(vein,eye)`, `stone(side,patch)`, `grade(patch)`, `dof(bokeh,range)`,
  `env(i,rotY)`, `explode(code,n,amount)`, `smash(code,n,power,height)`, `fractureReport()`,
  `strikes(side)` (weapon-reach solutions for every pairing, plus the error between planned and
  real weapon positions), `gaits(names,kind)`, `perf(seconds,width,fps)`, `perfMoves([uci],width)`
  (frame times while moves play in real time, listing any frame over 5 ms of CPU), `headroom(max)`,
  `info()`. Piece codes are side + type, e.g. `'wk'`, `'bp'`. `look()` also switches cinematic
  cuts off so a fixed view stays put; `free()` or `orbit()` switches them back on.
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
   `MISS`, and `fkErrorMm` should stay at a few millimetres. The cylinder a weapon must enter
   is 0.98 of the victim's height (`strikeTarget`, head-piece included), so a taller head-piece
   moves some contacts; diff the strings against the run before the change and read each
   difference.
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
    longer covers everything; not looked into.
- Attack clips, hit times in seconds (reach of the weapon tip in metres at scale 1):
  Spear_Thrust 0.45 (1.76 with spear_A x1.15); Two_Handed_Overhead_Slam 0.73 (1.05, hammer_B);
  Sword_Attack 0.54 (1.5, sword_C); Staff_Combo hits at 0.52 and 1.2 (about 1.5, staff_B);
  Dual_Wield_Cross_Slash 0.5 (1.0-1.26, sword_B); Two_Handed_Horizontal_Swing 0.6 (1.78, sword_E);
  Weapon_Draw: hand reaches the hilt at about 0.3, sword overhead 0.55-0.7.
  Leap: NinjaJump_Start crouch at 0, airborne by about 0.3; NinjaJump_Land feet down at 0.17.

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
  scale, weapons, armour, cloth, fittings, rest pose, mover, gaits), `buildPiece.ts` +
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
  - Rook: all-metal plate: breast and back plate with a lapped belly plate, standing collar,
    two-lame pauldrons, flared gauntlets, boots with a cuff, knee plates and rigid toe caps.
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
  `footPlanter.ts` pins the ball of a planted foot with two-bone IK and takes real steps.
- **Game** (`src/game`, `src/chess`, `src/input`, `src/ui`): `ChessGame` wraps chess.js into
  `MoveEvent`s; `GameController` handles selection, markers, promotion, undo, new game, follow-turn
  camera; `Picker` is analytic (board plane + per-statue cylinders); `Hud` is DOM.
- **Sequencing** (`src/sequence`): `Timeline` (spans + cues), `moves.ts` (`planWalk`, `planLeap`,
  `planGlide`, `planTurn`, castling, promotion swap), `Director` (plays a timeline on game time;
  Space fast-forwards; `baseSpeed` for tests; owns the hit-stop / slow-motion beat; `reset()`
  abandons a move in flight).
- **Captures** (`attacks.ts`, `strike.ts`, `capture.ts`): each piece type has one attack clip with
  nominal hit times. `StrikeTrack` runs forward kinematics over the clip for the weapon's grip and
  far end; `solveStrike` searches stand-off distance and a small body turn so the final blow
  passes through a narrow cylinder at the victim (narrow so the weapon is visibly inside the body
  on the hit frame); `findContact` gives the exact contact time. `planCapture` then lays out:
  approach (handing straight into the strike), victim turns and guards (`Defend`), earlier hits
  stagger (`Hit_Chest`), final hit = impact effects + slow motion + `cast.detach` +
  `shatter.shatter`, recover (king sheathes by playing the draw backwards), walk onto the square
  pushing rubble (`shatter.setPusher`), camera cut in and back. Stand-off spots swing round the
  victim if another statue is in the way; if the weapon reaches from the attacker's own square
  it strikes from there.
- **Camera** (`src/cinema`): `CameraRig` (player orbit, override pose, shake), `cinema.ts`
  (`Cinema`: cut / release, letterbox, depth of field, slow push-in; `chooseShot`: candidate
  two-shots scored for occlusion, background clutter, looking across the board rather than out
  into the hall, staying on the player's side, low height first).
- **Effects** (`src/fx`): `physics.ts` (Rapier, fixed 1/120 s step with interpolation),
  `shatter.ts` (breaks a pre-fractured statue into rigid bodies released in a wave from the hit,
  drops weapons, fades the glow, heats then cools the broken faces, dissolves the rubble with
  embers), `particles.ts` (`Dust` soft lit wisps, `Sparks` additive streaks and flashes, `Shards`
  instanced chips with bounce), `effects.ts` (`impact`, `collapse`, `landing`, `footstep`,
  `embers`, a pulsed point light at the blow, camera shake).
- **Particle layer:** dust and sparks are not in the main scene. `Pipeline.overlay` is rendered
  into its own half-float buffer after depth of field (`OverlayEffect`) and laid over the picture
  before bloom; the particle shaders test and soften themselves against the scene depth texture.
  Drawn in the main pass they took on the blur and ambient occlusion of whatever was behind them.
  The pass is enabled only while particles are alive.
- **Knight:** its capture is a leaping strike (`planLeapStrike`): the jump-attack clip leaps on
  the spot, and its take-off and landing are stretched over the knight's own flight to a clear
  spot beside the victim; the contact time is solved with the body's position during the fall
  taken into account; the camera booms up to follow (`Cinema.lift`).
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
- **Interface:** title screen (`Hud.showTitle`), toggles for sound, cinematic captures (off:
  no cut, no slow motion) and follow-turn, all remembered in localStorage.
- **Warm-up** (`src/core/warmup.ts`): behind the loading screen it solves weapon reach for every
  pairing and renders two frames with a statue of each design in its shatter variant, every
  particle type, a marker, and the depth-of-field and particle passes on. One set of shatter
  materials is kept alive for good, otherwise three.js frees the program when a break disposes
  the last material using it.
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

1. **Capture variety:** one attack per piece type. Not done: second attack variants, victim
   reactions other than the crouching guard, cracks spreading before the final blow, a second
   camera angle on the hit.
2. **Polish not done:** light shaft, head look-at, quality presets for slower machines (render
   scale is fixed at the device pixel ratio, capped at 2; the reflection and depth of field
   have no off switch in the interface), tests for fracture closedness, a layout for windows
   narrower than about 1000 px (the buttons wrap over the board).
3. **Not verified:** Safari and Firefox (everything was checked in Chromium only); a real
   120 Hz display (the pacing logic is unit-tested, the test browser runs at 60 Hz); how any of
   the sound actually sounds. Since the 2026-11-17 redesign the knight's, rook's and bishop's
   captures and the knight, bishop, rook and queen breaking were watched frame by frame; the
   queen's and king's captures only went through the scripted run and `strikes()`.
4. Known rough edges:
   - The first capture after a load can hitch for one frame (see "Measured").
   - Thick plates still fold a little where their outline crosses the spine groove, and the
     rook's pauldrons are ragged under the arm (a horizontal cut through the armpit).
   - The bishop's feet are bare under the robe.
   - Obsidian's plate, horse head and cross are pale steel, because they use the army's trim;
     gold on both sides would mean changing `OBSIDIAN`'s trim colour in `stoneMaterial.ts`.
   - Planted-foot drift is above the 2 cm target (see "Measured").
   - A statue that walks onto the rubble pushes it with a capsule, so chips can remain under
     its feet until they dissolve.
   - A horizontal sword swing can pass through a bystander on a crowded board.
   - The mated king stays in the cast, invisible, after its stone has gone (so undo can
     restore it).
