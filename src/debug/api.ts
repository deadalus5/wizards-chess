// window.__sw: a scripting surface for look-dev, verification and performance measurement.
// The game does not depend on it.
import * as THREE from 'three';
import type { PieceSymbol } from 'chess.js';
import { analyzeGait } from '../anim/gait';
import type { ChessGame } from '../chess/game';
import type { CameraRig } from '../cinema/cameraRig';
import type { Cinema } from '../cinema/cinema';
import type { FrameLoop } from '../core/loop';
import { ChunkField } from '../fx/chunkField';
import type { GameController } from '../game/controller';
import type { Director } from '../sequence/director';
import type { ShatterSystem } from '../fx/shatter';
import { squareCentre, type Side } from '../game/squares';
import type { Actor } from '../pieces/actor';
import type { Cast } from '../pieces/cast';
import { openEdgesPerChunk } from '../pieces/fracture';
import { PIECE_TYPES } from '../pieces/regalia';
import { ATTACKS } from '../sequence/attacks';
import { strikeFor } from '../sequence/capture';
import { strikeTrack } from '../sequence/strike';
import type { StatueKit } from '../pieces/statueKit';
import type { LightRig } from '../render/lighting';
import type { Markers } from '../render/markers';
import type { Look, Pipeline } from '../render/pipeline';
import { DEFAULT_LOOK } from '../render/pipeline';
import { applyStoneLook, createShatterMaterials, type StoneLook } from '../render/stoneMaterial';
import { audioReport } from './audioReport';
import type { PerfRecorder } from './perf';

export interface DebugDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pipeline: Pipeline;
  lights: LightRig;
  cast: Cast;
  kit: StatueKit;
  loop: FrameLoop;
  rig: CameraRig;
  game: ChessGame;
  controller: GameController;
  markers: Markers;
  perf: PerfRecorder;
  stress: { repeat: number };
  director: Director;
  /** Run one frame of the game by hand. */
  frame: (dt: number, now: number) => void;
  shatter: ShatterSystem;
  cinema: Cinema;
  reflection: { strength: number; enabled: boolean } | null;
}

export function installDebugApi(d: DebugDeps): void {
  const { pipeline, cast, loop, rig, game, controller, perf, stress } = d;
  let look: Look = { ...DEFAULT_LOOK };
  const exploded = new Map<Actor, ChunkField>();
  const pick = (code: string, n = 0): Actor => {
    const a = cast.living().filter((x) => x.side + x.type === code)[n];
    if (!a) throw new Error(`no statue ${code}[${n}]`);
    return a;
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let manualNow = performance.now() / 1000;

  const api = {
    ...d,
    THREE,

    // ---------------------------------------------------------------- game
    fen: () => game.fen(),
    status: () => game.status(),
    /** Load a position. */
    load(fen?: string): string {
      controller.start(fen);
      return game.fen();
    },
    /** Play a move in coordinate notation, e.g. "e2e4" or "a7a8q", and wait for it to finish. */
    async move(uci: string): Promise<string> {
      await controller.move(uci.slice(0, 2), uci.slice(2, 4), (uci[4] as PieceSymbol | undefined) || undefined);
      return game.fen();
    },
    /** Play a list of moves in order. */
    async play(moves: string[]): Promise<string> {
      for (const m of moves) await api.move(m);
      return game.fen();
    },
    /**
     * Play whole games quickly and check after every move that the statues agree with
     * chess.js. Each game is a list of coordinate moves, optionally starting from a FEN.
     */
    async verify(games: { fen?: string; moves: string[] }[], speed = 25): Promise<unknown> {
      const before = d.director.baseSpeed;
      d.director.baseSpeed = speed;
      const problems: string[] = [];
      let played = 0;
      try {
        for (const [g, gameSpec] of games.entries()) {
          controller.start(gameSpec.fen);
          for (const m of gameSpec.moves) {
            try {
              await api.move(m);
            } catch (e) {
              problems.push(`game ${g} move ${m}: ${String(e)}`);
              break;
            }
            played++;
            if (!api.consistent()) problems.push(`game ${g} after ${m}: statues disagree with the position`);
            const stray = cast.living().filter((a) => {
              const c = squareCentre(a.square);
              return Math.hypot(a.root.position.x - c.x, a.root.position.z - c.z) > 0.01 || Math.abs(a.root.position.y) > 0.01;
            });
            if (stray.length) problems.push(`game ${g} after ${m}: ${stray.length} statue(s) off their square`);
          }
        }
      } finally {
        d.director.baseSpeed = before;
      }
      return { games: games.length, moves: played, problems };
    },
    /** Simulate a click on a square. */
    click: (square: string | null) => controller.click(square),
    /** True if every statue is where chess.js says it should be. */
    consistent: () => cast.matches(game.board() as Parameters<Cast['matches']>[0]),

    // ---------------------------------------------------------------- stepping
    /**
     * Take over the clock: the game stops advancing on its own and moves only when `step` is
     * called, so any instant of a sequence can be held and photographed.
     */
    manual(on = true): void {
      if (on) loop.stop();
      else loop.start();
    },
    /** Advance the game by `seconds` in fixed sub-steps and render. */
    step(seconds: number, hz = 60): number {
      const dt = 1 / hz;
      const n = Math.max(1, Math.round(seconds * hz));
      for (let i = 0; i < n; i++) {
        manualNow += dt;
        d.frame(dt, manualNow);
      }
      return manualNow;
    },
    /** Start a move without waiting for it (use with `manual` and `step`). */
    begin(uci: string): void {
      void controller.move(uci.slice(0, 2), uci.slice(2, 4), (uci[4] as PieceSymbol | undefined) || undefined).catch((e) => console.error(e));
    },
    busy: () => controller.isBusy,
    /**
     * Play a move under fine manual stepping and measure how far each foot slides while it is
     * planted: the honest test of whether the gait matches the ground speed.
     */
    async footDrift(uci: string, hz = 240): Promise<unknown> {
      const actor = cast.at(uci.slice(0, 2));
      if (!actor) throw new Error(`no statue on ${uci.slice(0, 2)}`);
      loop.stop();
      api.begin(uci);
      const feet = ['ball_l', 'ball_r'].map((n) => actor.instance.byName.get(n)!);
      const samples: { t: number; p: THREE.Vector3[] }[] = [];
      let t = 0;
      for (let guard = 0; guard < 20000 && controller.isBusy; guard++) {
        api.step(1 / hz, hz);
        t += 1 / hz;
        actor.root.updateMatrixWorld(true);
        samples.push({ t, p: feet.map((b) => b.getWorldPosition(new THREE.Vector3())) });
        if (guard % 16 === 0) await Promise.resolve();
      }
      loop.start();
      const report = feet.map((_, f) => {
        const minY = Math.min(...samples.map((s) => s.p[f].y));
        let worst = 0;
        let worstAt = 0;
        let stances = 0;
        let start: THREE.Vector3 | null = null;
        let startT = 0;
        let planted = 0;
        for (const s of samples) {
          const down = s.p[f].y < minY + 0.02;
          if (down) {
            if (!start) {
              start = s.p[f].clone();
              startT = s.t;
              stances++;
            }
            planted++;
            const drift = Math.hypot(s.p[f].x - start.x, s.p[f].z - start.z);
            if (drift > worst) {
              worst = drift;
              worstAt = startT;
            }
          } else start = null;
        }
        return { foot: f === 0 ? 'left' : 'right', stances, plantedSeconds: +(planted / hz).toFixed(2), worstDriftCm: +(worst * 100).toFixed(1), worstStanceStarts: +worstAt.toFixed(2) };
      });
      return { move: uci, seconds: +t.toFixed(2), feet: report };
    },

    // ---------------------------------------------------------------- camera
    /**
     * Fix the camera at (px,py,pz) looking at (tx,ty,tz), and stop cinematic shots taking it
     * over. Call `free()` to return to the orbit and to normal cinematics.
     */
    look(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 30): void {
      d.cinema.release();
      d.cinema.enabled = false;
      rig.override = { position: new THREE.Vector3(px, py, pz), target: new THREE.Vector3(tx, ty, tz), fov };
      pipeline.focus.set(tx, ty, tz);
    },
    free(): void {
      rig.override = null;
      d.cinema.enabled = true;
      pipeline.setDepthOfField(0);
    },
    /** Frame one piece: `at('wk')` is the white king. Angles are relative to the way it faces. */
    at(code: string, n = 0, distance = 4, azimuth = 0.6, height = 1.5, fov = 26, aim = 1.25): void {
      const s = pick(code, n);
      const p = s.root.position;
      const a = s.root.rotation.y + azimuth;
      const k = s.root.scale.x;
      api.look(p.x + Math.sin(a) * distance, height * k, p.z + Math.cos(a) * distance, p.x, aim * k, p.z, fov);
    },
    orbit(azimuth: number, elevationDeg: number, distance: number): void {
      rig.override = null;
      d.cinema.enabled = true;
      rig.setOrbit(azimuth, THREE.MathUtils.degToRad(elevationDeg), distance, true);
    },

    // ---------------------------------------------------------------- look
    /** Vein glow and eye glow for every statue. */
    life(vein: number, eye: number): void {
      for (const a of cast.living()) a.setLife(vein, eye);
    },
    /** Patch one army's stone look and re-apply it. */
    stone(side: Side, patch: Partial<StoneLook>): StoneLook {
      Object.assign(cast.looks[side], patch);
      for (const a of cast.actors) if (a.side === side) applyStoneLook(a.material, cast.looks[side]);
      return cast.looks[side];
    },
    grade(patch: Partial<Look>): Look {
      look = { ...look, ...patch };
      pipeline.applyLook(look);
      return look;
    },
    dof(bokeh: number, range = 6): void {
      pipeline.setDepthOfField(bokeh, range);
    },
    env(intensity: number, rotationY = 0): void {
      d.scene.environmentIntensity = intensity;
      d.scene.environmentRotation.set(0, rotationY, 0);
    },

    // ---------------------------------------------------------------- fracture
    /** Break a statue with a blow from in front (for testing the shatter on its own). */
    smash(code: string, n = 0, power = 4.5, height = 1.2): void {
      const s = pick(code, n);
      const yaw = s.root.rotation.y;
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const point = s.root.position.clone().addScaledVector(forward, 0.2);
      point.y = height * s.design.scale;
      cast.detach(s);
      d.shatter.shatter(s, { point, direction: forward.clone().negate().setY(-0.25), power });
    },

    /** Pull one statue's chunks apart (0 = intact) to inspect the pre-fracture. */
    explode(code: string, n = 0, amount = 0.5): number {
      const s = pick(code, n);
      let field = exploded.get(s);
      if (!field) {
        field = new ChunkField(s.template.chunks.length);
        const mats = createShatterMaterials(s.material, field.uniform);
        s.instance.mesh.geometry = s.template.shatterGeometry;
        s.instance.mesh.material = mats.color;
        s.instance.mesh.customDepthMaterial = mats.depth;
        exploded.set(s, field);
      }
      const centre = s.template.geometry.boundingBox!.getCenter(new THREE.Vector3());
      const m = new THREE.Matrix4();
      for (const c of s.template.chunks) {
        m.makeTranslation((c.centroid[0] - centre.x) * amount, (c.centroid[1] - centre.y) * amount * 0.6, (c.centroid[2] - centre.z) * amount);
        field.setMatrix(c.id, m);
      }
      field.commit();
      return s.template.chunks.length;
    },
    /** Chunk counts and watertightness of every design's pre-fracture. */
    fractureReport(): unknown {
      return PIECE_TYPES.map((type) => {
        const t = cast.templates[type];
        const open = openEdgesPerChunk(
          { position: t.geometry.getAttribute('position').array, chunk: t.geometry.getAttribute('aChunk').array, surfaceIndex: t.geometry.index!.array, fullIndex: t.shatterGeometry.index!.array },
          t.bodyTriangles,
        );
        const leaky = [...open.entries()].filter(([, n]) => n > 0);
        return {
          type,
          chunks: t.chunks.length,
          vertices: t.geometry.getAttribute('position').count,
          surfaceTris: t.geometry.index!.count / 3,
          capTris: (t.shatterGeometry.index!.count - t.geometry.index!.count) / 3,
          openChunks: leaky.length,
          openEdges: leaky.reduce((s, [, n]) => s + n, 0),
        };
      });
    },

    // ---------------------------------------------------------------- sound
    /** Render every sound offline, measure it, and draw spectrograms over the page. */
    audioReport,
    hideAudioReport(): void {
      document.getElementById('audio-report')?.remove();
    },

    // ---------------------------------------------------------------- strikes
    /**
     * Check the planned weapon paths. For each piece type: how far the planner's forward
     * kinematics is from where the weapon mesh really is at the hit (should be millimetres),
     * and where it would stand, and when the blow lands, against each kind of victim.
     */
    strikes(side: Side = 'w'): unknown {
      const up = new THREE.Vector3(0, 1, 0);
      return PIECE_TYPES.map((type) => {
        const a = cast.living().find((x) => x.side === side && x.type === type);
        if (!a) return { type, missing: true };
        const spec = ATTACKS[type];
        const clip = cast.clip(a.body, spec.clip);
        const track = strikeTrack(a, clip, spec.weapon ?? 0);
        const hit = spec.hits[spec.hits.length - 1];
        a.drawWeapons(true);
        a.animate([{ clip, time: hit, weight: 1 }]);
        a.root.updateMatrixWorld(true);
        const w = a.weapons[spec.weapon ?? 0];
        const box = w.mesh.geometry.boundingBox!;
        const c = box.getCenter(new THREE.Vector3());
        const real = w.mesh.localToWorld(new THREE.Vector3(c.x, box.max.y, c.z));
        const planned = track.point(hit, 1).applyAxisAngle(up, a.root.rotation.y).add(a.root.position);
        const tip = track.point(hit, 1);
        a.rest();
        const versus = PIECE_TYPES.map((v) => {
          const victim = cast.living().find((x) => x.side !== side && x.type === v);
          if (!victim) return `${v}: none`;
          return [1.25, 1.77, 3].map((limit) => {
            const s = strikeFor(d.director.stage, a, victim, spec, limit);
            const last = s.contacts[s.contacts.length - 1];
            return `${v}@${limit}: d=${s.distance.toFixed(2)} turn=${((s.bearing * 180) / Math.PI).toFixed(0)} t=${s.contacts.map((k) => k.time.toFixed(2)).join('/')} along=${last.along.toFixed(1)} y=${last.point.y.toFixed(2)}${s.lands ? '' : ' MISS'}`;
          }).join(' | ');
        });
        return { type, clip: spec.clip, fkErrorMm: +(real.distanceTo(planned) * 1000).toFixed(1), tipAtHit: tip.toArray().map((n) => +n.toFixed(2)), weaponBox: [box.min.y, box.max.y].map((n) => +n.toFixed(2)), versus };
      });
    },

    // ---------------------------------------------------------------- animation
    /** Measured ground speed, cycle length and foot contacts for locomotion clips. */
    async gaits(names: string[], kind: 'male' | 'female' = 'male'): Promise<unknown> {
      const out = [];
      for (const name of names) {
        const g = analyzeGait(await d.kit.clip(kind, name), d.kit.rig(kind));
        out.push(`${name}: speed ${g.speed.toFixed(2)} m/s  dir [${g.dir[0].toFixed(2)}, ${g.dir[1].toFixed(2)}]  cycle ${g.cycle.toFixed(2)} m  dur ${g.clip.duration.toFixed(2)} s  passing ${g.passing.toFixed(2)}  contacts L${g.contacts[0].toFixed(2)} R${g.contacts[1].toFixed(2)}`);
      }
      return out;
    },

    // ---------------------------------------------------------------- performance
    /** Frame-time statistics over `seconds`; optionally at a forced internal width in pixels. */
    async perf(seconds = 3, renderWidth?: number, fps?: number): Promise<unknown> {
      const before = pipeline.renderSize.width;
      const beforeFps = loop.targetFps;
      const beforeAuto = loop.auto;
      if (renderWidth) pipeline.setRenderPixels(renderWidth);
      if (fps) {
        loop.auto = false;
        loop.targetFps = fps;
      }
      await sleep(400);
      const report = await perf.measure(seconds);
      const size = pipeline.renderSize;
      if (renderWidth) pipeline.setRenderPixels(before);
      loop.targetFps = beforeFps;
      loop.auto = beforeAuto;
      return { size, displayHz: Math.round(loop.displayHz), ...report };
    },
    /**
     * Frame-time statistics while a list of moves plays out in real time: the test for
     * hitches at an impact. Optionally at a forced internal width in pixels.
     */
    async perfMoves(moves: string[], renderWidth?: number): Promise<unknown> {
      const before = pipeline.renderSize.width;
      if (renderWidth) pipeline.setRenderPixels(renderWidth);
      await sleep(300);
      perf.start();
      const slow: { at: number; move: number; interval: number; cpu: number }[] = [];
      const t0 = performance.now();
      const push = perf.push.bind(perf);
      perf.push = (s) => {
        // Frames that took long on the CPU, or arrived late, with where in the move they fell.
        if (s.cpu > 5 || s.interval > (1000 / loop.targetFps) * 1.4) slow.push({ at: +((performance.now() - t0) / 1000).toFixed(2), move: +d.director.time.toFixed(2), interval: +s.interval.toFixed(1), cpu: +s.cpu.toFixed(1) });
        push(s);
      };
      try {
        for (const m of moves) await api.move(m);
        await sleep(600);
      } finally {
        perf.push = push;
      }
      const report = perf.stop();
      const size = pipeline.renderSize;
      if (renderWidth) pipeline.setRenderPixels(before);
      return { size, displayHz: Math.round(loop.displayHz), ...report, slow };
    },
    /**
     * How many times the whole frame can be rendered per display refresh before frames drop:
     * the honest measure of headroom (timer queries mislead while the GPU is clocked down).
     */
    async headroom(max = 16): Promise<unknown> {
      const results: string[] = [];
      let best = 1;
      const base = 1000 / loop.displayHz;
      for (const n of [1, 2, 3, 4, 6, 8, 12, 16].filter((v) => v <= max)) {
        stress.repeat = n;
        await sleep(300);
        const r = await perf.measure(1.2);
        results.push(`x${n}: interval ${r.interval.median} ms, cpu ${r.cpu.median} ms`);
        if (r.interval.median < base * 1.25) best = n;
        else break;
      }
      stress.repeat = 1;
      return { size: pipeline.renderSize, refreshMs: +base.toFixed(2), rendersPerRefresh: best, approxFrameMs: +(base / best).toFixed(2), results };
    },
    info(): unknown {
      return {
        size: pipeline.renderSize,
        calls: pipeline.renderer.info.render.calls,
        triangles: pipeline.renderer.info.render.triangles,
        displayHz: Math.round(loop.displayHz),
        statues: cast.living().length,
        turn: game.turn(),
      };
    },
  };
  const w = window as unknown as { __sw: typeof api; __swReady: boolean };
  w.__sw = api;
  w.__swReady = true;
}
