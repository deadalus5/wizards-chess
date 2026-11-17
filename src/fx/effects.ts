import * as THREE from 'three';
import type { GameAudio } from '../audio/audio';
import type { CameraRig } from '../cinema/cameraRig';
import { Rng } from '../core/math';
import type { Side } from '../game/squares';
import type { StoneLook } from '../render/stoneMaterial';
import type { OverlayUniforms } from '../render/pipeline';
import { Dust, Motes, Shards, Sparks, type DustLight, type GroundFn } from './particles';
import { WeaponTrail, type WeaponPath } from './trails';

export interface EffectsOptions {
  /** The key light, for lighting dust. */
  light: DustLight;
  fog: THREE.FogExp2 | null;
  ground: GroundFn;
  /** Each army's stone, for the colour of its dust, chips and magic. */
  looks: Record<Side, StoneLook>;
  /** Scene depth, which the particle layer tests itself against. */
  depth: OverlayUniforms;
  audio?: GameAudio;
}

interface Palette {
  dust: THREE.Color;
  chip: THREE.Color;
  glow: THREE.Color;
}

interface Pending {
  at: number;
  run: () => void;
}

/** Dust kicked up from the floor itself (footfalls, landings) rather than from a statue. */
const FLOOR_DUST = new THREE.Color(0.52, 0.5, 0.47);

/**
 * World effects triggered by the choreography: footfalls, landings, blows and the dust,
 * chips, sparks, light and camera shake that go with them. Everything runs on game time, so
 * it slows with the action.
 */
export class Effects {
  /** Lit, solid things that belong in the scene itself: chips and the flash light. */
  readonly group = new THREE.Group();
  /** Dust and sparks, which are drawn in the particle layer over the finished scene. */
  readonly overlay = new THREE.Group();
  readonly dust: Dust;
  readonly sparks: Sparks;
  readonly shards: Shards;
  /** A light that pulses at the point of a blow. It always exists; only its intensity changes. */
  readonly flash: THREE.PointLight;
  /** One arc per weapon in a strike (a statue has at most two). */
  readonly trails: WeaponTrail[];
  /** Dust hanging in the air of the hall. */
  readonly motes: Motes;
  private flashLevel = 0;
  readonly audio: GameAudio | undefined;
  private readonly palettes: Record<Side, Palette>;
  private readonly rng = new Rng(2024);
  private readonly pending: Pending[] = [];
  private clock = 0;

  constructor(
    private readonly rig: CameraRig,
    options: EffectsOptions,
  ) {
    this.group.name = 'effects';
    this.audio = options.audio;
    this.dust = new Dust(options.light, options.fog, options.ground, options.depth);
    this.sparks = new Sparks(options.ground, options.depth);
    this.shards = new Shards(options.ground);
    this.flash = new THREE.PointLight(0xffffff, 0, 5.5, 2);
    this.flash.name = 'impact-flash';
    this.group.add(this.shards.mesh, this.flash);
    this.trails = [new WeaponTrail(options.depth), new WeaponTrail(options.depth)];
    this.motes = new Motes(340, new THREE.Vector3(-7.5, 0.25, -7.5), new THREE.Vector3(7.5, 5.2, 7.5), options.light, options.depth);
    this.overlay.name = 'effects-overlay';
    this.overlay.add(this.motes.points, this.dust.mesh, this.sparks.mesh, ...this.trails.map((t) => t.mesh));

    const palette = (look: StoneLook): Palette => {
      const base = new THREE.Color(look.base);
      // Pale stone makes pale dust; black stone makes a dark smoke that still catches the light.
      const dust = base.clone().multiplyScalar(0.9).lerp(new THREE.Color(0.17, 0.17, 0.19), base.r < 0.2 ? 1 : 0);
      return { dust, chip: base.clone(), glow: new THREE.Color(look.glow) };
    };
    this.palettes = { w: palette(options.looks.w), b: palette(options.looks.b) };
  }

  /** A foot coming down. `heft` 0..1 is how heavy the statue is. */
  footstep(position: THREE.Vector3, heft: number): void {
    this.rig.addTrauma(0.035 * heft);
    this.audio?.footstep(position, heft);
    if (heft < 0.3) return;
    const rng = this.rng;
    for (let i = 0; i < 2; i++) {
      const a = rng.range(0, Math.PI * 2);
      this.dust.emit(position.x, 0.03, position.z, Math.cos(a) * 0.35, 0.12, Math.sin(a) * 0.35, {
        size: 0.05,
        grow: 0.16 + 0.12 * heft,
        life: rng.range(0.7, 1.1),
        alpha: 0.1 + 0.1 * heft,
        color: FLOOR_DUST,
        drag: 3,
        rise: 0.05,
      });
    }
  }

  /** A statue landing from a leap or settling from a glide: a ring of dust along the floor. */
  landing(position: THREE.Vector3, heft: number): void {
    this.rig.addTrauma(0.12 + 0.3 * heft);
    this.audio?.landing(position, heft);
    const rng = this.rng;
    const n = Math.round(6 + 12 * heft);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const speed = rng.range(1.1, 2.4) * (0.5 + heft);
      this.dust.emit(position.x + Math.cos(a) * 0.18, 0.04, position.z + Math.sin(a) * 0.18, Math.cos(a) * speed, rng.range(0.05, 0.35), Math.sin(a) * speed, {
        size: 0.08,
        grow: rng.range(0.3, 0.5) * (0.6 + heft),
        life: rng.range(0.9, 1.5),
        alpha: 0.2 + 0.14 * heft,
        color: FLOOR_DUST,
        drag: 3.4,
        rise: 0.08,
      });
    }
  }

  /**
   * A weapon striking a statue of `side`. `strength` 1 is the blow that breaks it; less is a
   * blow that only staggers it. `direction` is the way the weapon is travelling.
   */
  impact(point: THREE.Vector3, direction: THREE.Vector3, strength: number, side: Side): void {
    const rng = this.rng;
    const { dust, chip, glow } = this.palettes[side];
    const dir = _d.copy(direction);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    dir.normalize();
    this.rig.addTrauma(0.25 + 0.45 * strength);
    this.audio?.impact(point, strength);

    // The flash: a round glow at the point, and a pulse of light on everything near it.
    this.sparks.emit(point.x, point.y, point.z, 0, 0, 0, 0.09 + 0.08 * strength, 0.07, glow, 2.5 + 3.5 * strength, 0, 0, 2.2);
    this.flash.position.copy(point).addScaledVector(dir, -0.3);
    this.flash.position.y += 0.35;
    this.flash.color.copy(glow);
    this.flashLevel = Math.max(this.flashLevel, 2.5 + 4.5 * strength);

    // Sparks thrown back off the surface and out to the sides.
    const sparks = Math.round(8 + 18 * strength);
    for (let i = 0; i < sparks; i++) {
      randomUnit(rng, _r);
      const v = _r.multiplyScalar(rng.range(0.8, 6)).addScaledVector(dir, -rng.range(0.5, 2.5) + (rng.next() < 0.35 ? rng.range(2, 5) : 0));
      v.y += rng.range(0.3, 2.4);
      this.sparks.emit(point.x, point.y, point.z, v.x, v.y, v.z, rng.range(0.0025, 0.0055), rng.range(0.2, 0.75), glow, rng.range(1.6, 4), 0.8, 1.5);
    }

    // Chips sprayed along the blow.
    const chips = Math.round(8 + 50 * strength);
    for (let i = 0; i < chips; i++) {
      randomUnit(rng, _r);
      const v = _r.multiplyScalar(rng.range(0.4, 2.2)).addScaledVector(dir, rng.range(0.8, 3 + 4 * strength));
      v.y += rng.range(0.4, 2.6);
      this.shards.emit(point.x + rng.range(-0.07, 0.07), point.y + rng.range(-0.1, 0.1), point.z + rng.range(-0.07, 0.07), v.x, v.y, v.z, rng.range(0.011, 0.034), rng.range(2.6, 4.6), chip);
    }

    // A burst of dust driven along the blow.
    const puffs = Math.round(3 + 8 * strength);
    for (let i = 0; i < puffs; i++) {
      randomUnit(rng, _r);
      const v = _r.multiplyScalar(rng.range(0.3, 1.3)).addScaledVector(dir, rng.range(0.4, 2.6));
      this.dust.emit(point.x, point.y, point.z, v.x, v.y + 0.3, v.z, {
        size: rng.range(0.05, 0.09),
        grow: rng.range(0.2, 0.38),
        life: rng.range(0.9, 1.7),
        alpha: rng.range(0.2, 0.36),
        color: dust,
        drag: 2.6,
        rise: -0.35,
      });
    }
  }

  /**
   * A statue of `side` standing at `position`, `height` tall, coming apart: dust shaken out
   * of the whole figure, then more thrown up as the rubble meets the floor.
   */
  collapse(position: THREE.Vector3, height: number, direction: THREE.Vector3, side: Side): void {
    const rng = this.rng;
    const { dust, chip } = this.palettes[side];
    this.audio?.shatter(position);
    const dir = _d.copy(direction).setY(0);
    if (dir.lengthSq() > 1e-8) dir.normalize();
    const x = position.x;
    const z = position.z;
    for (let i = 0; i < 18; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, 0.28);
      const y = rng.range(0.1, 0.9) * height;
      const out = rng.range(0.3, 1.2);
      this.dust.emit(x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a) * out + dir.x * 0.9, rng.range(-0.5, 0.3), Math.sin(a) * out + dir.z * 0.9, {
        size: rng.range(0.06, 0.11),
        grow: rng.range(0.24, 0.42),
        life: rng.range(1.2, 2.2),
        alpha: rng.range(0.16, 0.3),
        color: dust,
        drag: 2.2,
        rise: -0.5,
      });
    }
    for (let i = 0; i < 36; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0.05, 0.3);
      randomUnit(rng, _r);
      const v = _r.multiplyScalar(rng.range(0.3, 1.8)).addScaledVector(dir, rng.range(0, 2));
      this.shards.emit(x + Math.cos(a) * r, rng.range(0.2, 1) * height, z + Math.sin(a) * r, v.x, v.y + rng.range(0, 1.6), v.z, rng.range(0.012, 0.04), rng.range(2.8, 5), chip);
    }
    // The rubble lands: dust rolls out along the floor.
    const cx = x + dir.x * 0.35;
    const cz = z + dir.z * 0.35;
    this.after(0.42, () => {
      for (let i = 0; i < 18; i++) {
        const a = rng.range(0, Math.PI * 2);
        const speed = rng.range(0.8, 2.3);
        this.dust.emit(cx + Math.cos(a) * 0.25, 0.06, cz + Math.sin(a) * 0.25, Math.cos(a) * speed, rng.range(0.05, 0.4), Math.sin(a) * speed, {
          size: rng.range(0.07, 0.12),
          grow: rng.range(0.3, 0.5),
          life: rng.range(1.5, 2.6),
          alpha: rng.range(0.16, 0.28),
          color: dust,
          drag: 2.8,
          rise: -0.04,
        });
      }
      this.rig.addTrauma(0.16);
    });
  }

  /** A weapon starting its swing (the sound of it; the arc is drawn by `trail`). */
  swing(position: THREE.Vector3, intensity: number): void {
    this.audio?.whoosh(position, intensity);
  }

  /**
   * Draw the arc a weapon of `side` is sweeping (see WeaponTrail.show). `strength` 0..1
   * fades it in and out around the blow; 0 hides it.
   */
  trail(slot: number, path: WeaponPath, origin: THREE.Vector3, yaw: number, time: number, from: number, side: Side, strength: number): void {
    const trail = this.trails[slot];
    if (!trail) return;
    if (strength <= 0.003) trail.hide();
    else trail.show(path, origin, yaw, time, 0.11, from, this.palettes[side].glow, strength * 2.2);
  }

  /** Motes of magic rising from rubble as it dissolves. */
  embers(position: THREE.Vector3, radius: number, side: Side, count = 20): void {
    this.audio?.dissolve(position);
    const rng = this.rng;
    const { glow } = this.palettes[side];
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * radius;
      this.sparks.emit(position.x + Math.cos(a) * r, rng.range(0.03, 0.3), position.z + Math.sin(a) * r, rng.range(-0.15, 0.15), rng.range(0.35, 1.1), rng.range(-0.15, 0.15), rng.range(0.007, 0.014), rng.range(0.9, 1.9), glow, rng.range(2.5, 6), -0.035, 0.5);
    }
  }

  private after(seconds: number, run: () => void): void {
    this.pending.push({ at: this.clock + seconds, run });
  }

  update(dt: number): void {
    this.clock += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= this.clock) this.pending.splice(i, 1)[0].run();
    }
    this.flashLevel *= Math.exp(-dt * 16);
    if (this.flashLevel < 0.02) this.flashLevel = 0;
    this.flash.intensity = this.flashLevel;
    this.dust.update(dt);
    this.sparks.update(dt);
    this.shards.update(dt);
  }

  /** Whether there is any dust or spark to draw this frame. */
  get overlayActive(): boolean {
    return this.motes.visible || this.dust.alive + this.sparks.alive > 0 || this.trails.some((t) => t.visible);
  }

  /** Drop everything in flight (new game, undo). */
  clear(): void {
    this.pending.length = 0;
    for (const t of this.trails) t.hide();
    this.flashLevel = 0;
    this.flash.intensity = 0;
    this.dust.clear();
    this.sparks.clear();
    this.shards.clear();
  }
}

const _d = new THREE.Vector3();
const _r = new THREE.Vector3();

/** A uniformly random direction. */
function randomUnit(rng: Rng, out: THREE.Vector3): THREE.Vector3 {
  const y = rng.range(-1, 1);
  const a = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - y * y);
  return out.set(Math.cos(a) * r, y, Math.sin(a) * r);
}
