// window.__sw: a scripting surface for look-dev, verification and performance measurement.
// The game does not depend on it.
import * as THREE from 'three';
import type { PieceSymbol } from 'chess.js';
import { analyzeGait } from '../anim/gait';
import { poseJoints } from '../anim/pose';
import type { ChessGame } from '../chess/game';
import type { CameraRig } from '../cinema/cameraRig';
import type { Cinema } from '../cinema/cinema';
import type { FrameLoop } from '../core/loop';
import { ChunkField } from '../fx/chunkField';
import type { GameController } from '../game/controller';
import type { Director } from '../sequence/director';
import type { ShatterSystem } from '../fx/shatter';
import { squareCentre, type Side } from '../game/squares';
import type { BakedClip } from '../anim/bake';
import { aimBones, aimPose, createJoints, staticClip } from '../anim/sculpt';
import type { Actor } from '../pieces/actor';
import { buildPose, type Cast } from '../pieces/cast';
import type { PoseSpec } from '../pieces/roster';
import { openEdgesPerChunk } from '../pieces/fracture';
import { PIECE_TYPES } from '../pieces/regalia';
import { ATTACKS } from '../sequence/attacks';
import { captureTuning, lastCapture, pickAttack, placeAttack, standingPoint, strikeFor, strikeZone, sweepTouches } from '../sequence/capture';
import { solveStrike, strikeTrack, type StrikeSolution, type StrikeZone } from '../sequence/strike';
import { yawTowards } from '../game/squares';
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
  /** How long things took while the loading screen was up. */
  boot: { warmUpMs: number; strikesMs: number };
}

/** How far the ankle sits above the ball of the foot in a statue's frozen stance, metres. */
function ankleRise(actor: Actor, foot: number): number {
  const rig = actor.template.rig;
  const side = foot === 0 ? 'l' : 'r';
  const joints = new Float32Array(rig.names.length * 3);
  poseJoints(actor.restPose, rig, joints);
  const ankle = rig.index.get(`foot_${side}`) ?? 0;
  const ball = rig.index.get(`ball_${side}`) ?? 0;
  return (joints[ankle * 3 + 1] - joints[ball * 3 + 1]) * actor.design.scale;
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
    /** `captureTuning.variant = 0 | 1` makes every capture use that one of the attacker's attacks; null lets it choose. */
    captureTuning,
    /** Which attack the capture planned last chose, and what it chose from. */
    lastCapture,

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

    /**
     * Play a move under fine manual stepping and measure how well a dragged statue's feet keep
     * their stance: how far the ball of each foot strays from its place under the statue, how
     * far it leaves the floor, how far the sole tips, and whether the planter took any step.
     * `watch` is the square of the statue to measure (default: the one that moves).
     */
    async slideCheck(uci: string, watch = uci.slice(0, 2), hz = 240): Promise<unknown> {
      const actor = cast.at(watch);
      if (!actor) throw new Error(`no statue on ${watch}`);
      const k = actor.design.scale;
      const rise = [ankleRise(actor, 0), ankleRise(actor, 1)];
      loop.stop();
      stress.repeat = 0; // measure without drawing: thousands of steps
      api.begin(uci);
      const balls = ['ball_l', 'ball_r'].map((n) => actor.instance.byName.get(n)!);
      const ankles = ['foot_l', 'foot_r'].map((n) => actor.instance.byName.get(n)!);
      const v = new THREE.Vector3();
      const ahead = new THREE.Vector3();
      let stray = 0;
      let lift = 0;
      let tip = 0;
      let lean = 0;
      let steps = 0;
      let t = 0;
      let travelled = 0;
      const last = actor.root.position.clone();
      for (let guard = 0; guard < 40000 && controller.isBusy; guard++) {
        api.step(1 / hz, hz);
        t += 1 / hz;
        const root = actor.root;
        root.updateMatrixWorld(true);
        travelled += Math.hypot(root.position.x - last.x, root.position.z - last.z);
        last.copy(root.position);
        steps = Math.max(steps, actor.planter.steps);
        // Let the move's own bookkeeping run, or it can never be seen to finish.
        if (guard % 8 === 0) await Promise.resolve();
        if (!actor.planter.holding) continue;
        ahead.set(0, 0, 1).transformDirection(root.matrixWorld);
        const yaw = Math.atan2(ahead.x, ahead.z);
        lean = Math.max(lean, Math.acos(Math.min(1, new THREE.Vector3(0, 1, 0).transformDirection(root.matrixWorld).y)));
        for (let f = 0; f < 2; f++) {
          const want = actor.stance[f].ball;
          balls[f].getWorldPosition(v);
          const ankleY = ankles[f].getWorldPosition(new THREE.Vector3()).y;
          lift = Math.max(lift, Math.abs(v.y - want.y * k));
          // The sole is flat when the ankle sits as far above the ball as it does in the stance.
          tip = Math.max(tip, Math.abs(ankleY - v.y - rise[f]));
          v.x -= root.position.x;
          v.z -= root.position.z;
          v.applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
          stray = Math.max(stray, Math.hypot(v.x - want.x * k, v.z - want.z * k));
        }
      }
      await Promise.resolve();
      stress.repeat = 1;
      loop.start();
      const mm = (x: number): number => +(x * 1000).toFixed(1);
      return { move: uci, watched: watch, seconds: +t.toFixed(2), travelledM: +travelled.toFixed(2), stepsTaken: steps, footStrayMm: mm(stray), footLiftMm: mm(lift), soleTipMm: mm(tip), maxLeanDeg: +((lean * 180) / Math.PI).toFixed(2) };
    },
    /**
     * How long moves take, in real seconds, played under manual stepping with the cinematic on:
     * for a capture also when the shot cuts in, when the blow lands and when it cuts back.
     */
    async timing(cases: { name?: string; fen?: string; uci: string }[]): Promise<unknown> {
      const wasSlow = d.director.slowMotionEnabled;
      const wasCinema = d.cinema.enabled;
      loop.stop();
      api.free();
      d.director.slowMotionEnabled = true;
      d.cinema.enabled = true;
      stress.repeat = 0; // time without drawing
      const out = [];
      try {
        for (const c of cases) {
          controller.start(c.fen);
          // A move cut short by that start is only let go of once its promise has settled.
          await sleep(0);
          api.step(0.2);
          api.begin(c.uci);
          const marks: Record<string, number> = {};
          const row: Record<string, unknown> = { name: c.name ?? c.uci, marks };
          let t = 0;
          let cut = false;
          let hit = false;
          let back = false;
          for (let i = 0; i < 6000 && controller.isBusy; i++) {
            api.step(1 / 60, 60);
            t += 1 / 60;
            if (!cut && d.cinema.active) {
              cut = true;
              row.cutIn = +t.toFixed(2);
            }
            if (!hit && d.shatter.active) {
              hit = true;
              row.blow = +t.toFixed(2);
            }
            if (hit && !back && !d.cinema.active) {
              back = true;
              row.cutBack = +t.toFixed(2);
            }
            for (const [name, at] of Object.entries(d.director.marks)) {
              if (!(name in marks) && d.director.time >= at) marks[name] = +t.toFixed(2);
            }
            await null;
            await null;
            await null;
          }
          row.total = +t.toFixed(2);
          out.push(row);
        }
      } finally {
        controller.start();
        d.director.slowMotionEnabled = wasSlow;
        d.cinema.enabled = wasCinema;
        stress.repeat = 1;
        loop.start();
      }
      return out;
    },
    /**
     * Try a held pose on one statue without changing its design: `spec` as in the roster. It
     * lasts until the statue next freezes; with no spec the statue goes back to its own pose.
     */
    async pose(code: string, n = 0, spec?: PoseSpec): Promise<void> {
      const s = pick(code, n);
      if (!spec) return s.rest();
      const clips = new Map<string, BakedClip>();
      for (const name of [spec.clip, ...(spec.over ?? []).map((o) => o.clip)]) clips.set(name, await d.kit.clip(s.body, name));
      const pose = buildPose(s.template.rig, spec, (name) => clips.get(name)!);
      s.animate([{ clip: staticClip('trial', pose), time: 0, weight: 1 }]);
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
    strikes(side: Side = 'w', only?: string): unknown {
      const up = new THREE.Vector3(0, 1, 0);
      const stage = d.director.stage;
      const out: unknown[] = [];
      for (const type of PIECE_TYPES) {
        if (only && !only.includes(type)) continue;
        const a = cast.living().find((x) => x.side === side && x.type === type);
        if (!a) {
          out.push({ type, missing: true });
          continue;
        }
        const posture = type === 'k' ? 'kneel' : 'stand';
        // The distances a capture by this piece is made from.
        const limits = a.design.mover === 'leap' ? [2.795] : [1.25, 1.77, 3];
        for (const spec of ATTACKS[type]) {
          const clip = cast.clip(a.body, spec.clip);
          const hit = spec.hits[spec.hits.length - 1];
          const w = a.weapons[spec.weapon ?? 0];
          const box = w.mesh.geometry.boundingBox!;
          const c = box.getCenter(new THREE.Vector3());
          /** How far the planner's weapon tip is from the real one at the blow, with a given aim on. */
          const fkError = (aim: number): number => {
            const track = strikeTrack(a, clip, spec.weapon ?? 0, aim);
            const bones = aimBones(a.template.rig);
            const joints = createJoints(a.template.rig);
            a.drawWeapons(true);
            a.adjust = aim !== 0 && bones ? (pose) => aimPose(pose, a.template.rig, bones, aim, joints) : null;
            a.animate([{ clip, time: hit, weight: 1 }]);
            a.root.updateMatrixWorld(true);
            const real = w.mesh.localToWorld(new THREE.Vector3(c.x, box.max.y, c.z));
            const planned = track.point(hit, 1).applyAxisAngle(up, a.root.rotation.y).add(a.root.position);
            a.rest();
            return +(real.distanceTo(planned) * 1000).toFixed(1);
          };
          const tip = strikeTrack(a, clip, spec.weapon ?? 0).point(hit, 1);
          let worstAim = 0;
          const problems: string[] = [];
          const versus = PIECE_TYPES.map((v) => {
            const victim = cast.living().find((x) => x.side !== side && x.type === v);
            if (!victim) return `${v}: none`;
            const zone = strikeZone(stage, victim, spec, posture);
            return (
              `${v} [zone ${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}${posture === 'kneel' ? `, head ${zone.forward.toFixed(2)} fwd ${(zone.side ?? 0).toFixed(2)} left` : ''}]: ` +
              limits
                .map((limit) => {
                  let s = strikeFor(stage, a, victim, spec, limit, posture);
                  // As a capture does: from the next square it strikes from where it stands, if the weapon reaches.
                  let here = '';
                  if (!spec.leap && limit - s.distance < 0.45) {
                    const exact = strikeFor(stage, a, victim, spec, limit, posture, limit);
                    if (exact.lands && !exact.short && exact.contacts[exact.contacts.length - 1].along >= 0.55) {
                      s = exact;
                      here = '=';
                    }
                  }
                  const last = s.contacts[s.contacts.length - 1];
                  if (Math.abs(s.aim) > Math.abs(worstAim)) worstAim = s.aim;
                  const flag = s.lands ? (s.short ? ' BODY' : '') : ' MISS';
                  if (flag) problems.push(`${v}@${limit}${flag}`);
                  return `@${limit}${here}: d=${s.distance.toFixed(2)} turn=${((s.bearing * 180) / Math.PI).toFixed(0)} aim=${((s.aim * 180) / Math.PI).toFixed(0)} t=${s.contacts.map((k) => k.time.toFixed(2)).join('/')} along=${last.along.toFixed(1)} y=${last.point.y.toFixed(2)}${flag}`;
                })
                .join(' | ')
            );
          });
          out.push({
            type,
            attack: spec.name,
            clip: spec.clip,
            fkErrorMm: fkError(0),
            fkErrorAimedMm: worstAim !== 0 ? fkError(worstAim) : undefined,
            worstAimDeg: +((worstAim * 180) / Math.PI).toFixed(0),
            tipAtHit: tip.toArray().map((n) => +n.toFixed(2)),
            problems,
            versus,
          });
        }
      }
      return out;
    },

    /**
     * For the capture `uci` in the current position: each of the attacker's attacks as it would
     * be placed, whether it reaches the head, and how much of its sweep passes through bystanders.
     */
    placings(uci: string): unknown {
      const stage = d.director.stage;
      const attacker = cast.at(uci.slice(0, 2));
      const victim = cast.at(uci.slice(2, 4));
      if (!attacker || !victim) throw new Error(`no capture ${uci}`);
      const A = squareCentre(attacker.square);
      const V = squareCentre(victim.square);
      return ATTACKS[attacker.type].map((spec) => {
        const p = placeAttack(stage, attacker, victim, spec, A, V, attacker.type === 'k' ? 'kneel' : 'stand');
        const last = p.strike.contacts[p.strike.contacts.length - 1];
        return { attack: spec.name, lands: p.strike.lands && !p.strike.short, distance: +p.strike.distance.toFixed(2), aimDeg: +((p.strike.aim * 180) / Math.PI).toFixed(0), contactY: +last.point.y.toFixed(2), bystanderSamples: p.touches };
      });
    },

    /**
     * How much weapon sweeps pass through bystanders in the position on the board. For every
     * capture the side to move could make: each of the attacker's attacks as it would be
     * placed (does it reach the head; how many samples of its sweep fall inside other statues),
     * which one the capture would choose, and the same count for the attack that piece made
     * before there was a choice, placed as it was then.
     */
    async bystanders(): Promise<unknown> {
      const stage = d.director.stage;
      // The attacks as they were: one each, landing anywhere on the body.
      const before: Record<string, { clip: string; hits: number[]; along: number; followThrough: number; leap?: { launch: number; land: number; until: number } }> = {
        p: { clip: 'Spear_Thrust', hits: [0.45], along: 1, followThrough: 0.62 },
        n: { clip: 'Attack_Jump', hits: [1.21], along: 0.85, followThrough: 0.6, leap: { launch: 0.6, land: 1.22, until: 2.3 } },
        b: { clip: 'Staff_Combo', hits: [0.52, 1.2], along: 0.9, followThrough: 0.6 },
        r: { clip: 'Two_Handed_Overhead_Slam', hits: [0.73], along: 0.95, followThrough: 0.75 },
        q: { clip: 'Dual_Wield_Cross_Slash', hits: [0.5], along: 0.85, followThrough: 0.7 },
        k: { clip: 'Two_Handed_Horizontal_Swing', hits: [0.6], along: 0.8, followThrough: 0.7 },
      };
      const rows = [];
      for (const attacker of cast.living().filter((a) => a.side === game.turn())) {
        for (const target of game.targets(attacker.square)) {
          // (An en passant capture has nothing on the square it moves to: left out.)
          const victim = cast.at(target.to);
          if (!target.capture || !victim) continue;
          const A = squareCentre(attacker.square);
          const V = squareCentre(victim.square);
          const apart = A.distanceTo(V);
          const posture = attacker.type === 'k' ? 'kneel' : 'stand';
          const now = ATTACKS[attacker.type].map((spec) => {
            const p = placeAttack(stage, attacker, victim, spec, A, V, posture);
            return { name: spec.name, lands: p.strike.lands && !p.strike.short, touches: p.touches };
          });

          const old = before[attacker.type];
          const clip = await d.kit.clip(attacker.body, old.clip);
          const scale = victim.design.scale;
          const zone: StrikeZone = { radius: 0.075 * scale, bottom: 0.04, top: victim.height * 0.98, forward: 0, low: victim.height * 0.22 };
          const solve = (max: number, min?: number): StrikeSolution => solveStrike(() => strikeTrack(attacker, clip, 0), old.hits, old.along, zone, { maxDistance: max, minDistance: min });
          let strike = solve(Math.round(Math.min(apart, 2.3) * 20) / 20);
          if (!old.leap && apart - strike.distance < 0.45) {
            const here = solve(apart, apart);
            if (here.lands && here.contacts[here.contacts.length - 1].along >= 0.55) strike = here;
          }
          const P = strike.distance >= apart - 0.02 ? A.clone() : standingPoint(stage, attacker, victim, V, A.clone().sub(V).setY(0).normalize(), strike.distance);
          const was = sweepTouches(stage, attacker, victim, old, strike, P, yawTowards(P, V) - strike.bearing);

          rows.push({
            capture: `${attacker.side}${attacker.type} ${attacker.square}x${victim.square} (${victim.type})`,
            before: was,
            attacks: now.map((o) => `${o.name}: ${o.lands ? 'head' : 'not head'}, ${o.touches}`).join(' | '),
            chosen: pickAttack(now, undefined).name,
            after: pickAttack(now, undefined).touches,
            choice: now.filter((o) => o.lands && o.touches === Math.min(...now.filter((x) => x.lands).map((x) => x.touches))).length,
          });
        }
      }
      return rows;
    },

    /**
     * Measure any library clip as an attack for one piece: the moments its weapon moves fastest
     * (candidate hit times), where the far end of the weapon is at each, and the top of the
     * wind-up before it. What the hit times in attacks.ts are taken from.
     */
    async weaponPath(code: string, clipName: string, weapon = 0, hits: number[] = []): Promise<unknown> {
      const a = pick(code);
      const clip = await d.kit.clip(a.body, clipName);
      const track = strikeTrack(a, clip, weapon);
      const step = 1 / 120;
      const speed: number[] = [];
      for (let t = 0; t <= clip.duration; t += step) speed.push(track.velocity(t, 1).length());
      const smooth = speed.map((_, i) => {
        let sum = 0;
        let n = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(speed.length - 1, i + 3); j++, n++) sum += speed[j];
        return sum / n;
      });
      const peaks: number[] = [];
      for (let i = 2; i < smooth.length - 2; i++) if (smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1] && smooth[i] > 4 * a.design.scale) peaks.push(i);
      peaks.sort((x, y) => smooth[y] - smooth[x]);
      const kept: number[] = [];
      for (const i of peaks) if (kept.every((j) => Math.abs(i - j) * step > 0.14)) kept.push(i);
      const f = (n: number): number => +n.toFixed(2);
      return {
        clip: clipName,
        seconds: f(clip.duration),
        // The top of the wind-up the planner would use for a blow at each of the given times.
        tops: hits.map((h) => f(track.windupTop(h))),
        // Speed of the far end, metres per second, every sixtieth of a second.
        speeds: speed.filter((_, i) => i % 2 === 0).map((v) => +v.toFixed(1)),
        peaks: kept
          .slice(0, 5)
          .sort((x, y) => x - y)
          .map((i) => {
            const t = i * step;
            const tip = track.point(t, 1);
            const dir = track.velocity(t, 1).normalize();
            return `t=${f(t)} v=${f(smooth[i])} tip=(${f(tip.x)},${f(tip.y)},${f(tip.z)}) going (${f(dir.x)},${f(dir.y)},${f(dir.z)}) wind-up top ${f(track.windupTop(t))}`;
          }),
      };
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
