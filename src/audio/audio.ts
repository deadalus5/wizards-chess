import * as THREE from 'three';
import { Synth } from './synth';

const LEVEL = 0.7;

/**
 * The game's sound: a synth on a live audio context, with each event placed in the stereo
 * field by where it is on screen and made quieter with distance from the camera.
 *
 * Browsers only let sound start from a user gesture, so nothing plays until `unlock` has
 * been called from one (the click that dismisses the title).
 */
export class GameAudio {
  private synth: Synth | null = null;
  private ambience: { stop(): void } | null = null;
  private enabled: boolean;
  private readonly last = new Map<string, number>();
  private readonly right = new THREE.Vector3();
  private readonly toward = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.Camera,
    /** Where the braziers stand, for their crackle. */
    private readonly fires: THREE.Vector3[],
  ) {
    this.enabled = localStorage.getItem('stonewake.sound') !== '0';
  }

  get on(): boolean {
    return this.enabled;
  }

  /** Start the audio engine. Must be called from a user gesture; safe to call again. */
  unlock(): void {
    if (this.synth) {
      void (this.synth.ctx as AudioContext).resume();
      return;
    }
    const Ctx: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.synth = new Synth(ctx);
    this.synth.master.gain.value = this.enabled ? LEVEL : 0;
    this.ambience = this.synth.ambience(ctx.currentTime + 0.05);
    window.setInterval(() => this.crackles(), 260);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    localStorage.setItem('stonewake.sound', on ? '1' : '0');
    const s = this.synth;
    if (s) s.master.gain.setTargetAtTime(on ? LEVEL : 0, s.ctx.currentTime, 0.08);
  }

  /** The synth, if sound may play now and this kind of sound has not just played. */
  private ready(kind: string, gap: number): Synth | null {
    const s = this.synth;
    if (!s || !this.enabled || s.ctx.state !== 'running') return null;
    const now = s.ctx.currentTime;
    if ((this.last.get(kind) ?? -10) + gap > now) return null;
    this.last.set(kind, now);
    return s;
  }

  /** Pan and level for something happening at a point in the world. */
  private place(position?: THREE.Vector3): { pan: number; level: number } {
    if (!position) return { pan: 0, level: 1 };
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.toward.subVectors(position, this.camera.position);
    const d = this.toward.length();
    const pan = d > 1e-3 ? Math.max(-0.75, Math.min(0.75, (this.toward.dot(this.right) / d) * 1.8)) : 0;
    // A blow seen from a close cinematic shot is louder than the same blow from the player's seat.
    return { pan, level: 0.45 + 0.55 * Math.min(1, 8 / Math.max(d, 8)) };
  }

  /** A few brazier crackles over the next stretch of time. */
  private crackles(): void {
    const s = this.synth;
    if (!s || !this.enabled || s.ctx.state !== 'running') return;
    for (const fire of this.fires) {
      if (Math.random() > 0.55) continue;
      const p = this.place(fire);
      s.crackle(s.ctx.currentTime + Math.random() * 0.25, p.pan);
    }
  }

  footstep(position: THREE.Vector3, heft: number): void {
    const s = this.ready('step', 0.05);
    if (!s) return;
    const p = this.place(position);
    s.footstep(s.ctx.currentTime, heft, p.pan, p.level);
  }

  landing(position: THREE.Vector3, heft: number): void {
    const s = this.ready('landing', 0.1);
    if (!s) return;
    const p = this.place(position);
    s.landing(s.ctx.currentTime, heft, p.pan, p.level);
  }

  whoosh(position: THREE.Vector3, intensity: number): void {
    const s = this.ready('whoosh', 0.12);
    if (!s) return;
    const p = this.place(position);
    s.whoosh(s.ctx.currentTime, intensity, p.pan, p.level);
  }

  impact(position: THREE.Vector3, strength: number): void {
    const s = this.ready('impact', 0.06);
    if (!s) return;
    const p = this.place(position);
    s.impact(s.ctx.currentTime, strength, p.pan, p.level);
  }

  shatter(position: THREE.Vector3): void {
    const s = this.ready('shatter', 0.3);
    if (!s) return;
    const p = this.place(position);
    s.shatter(s.ctx.currentTime, p.pan, p.level);
  }

  dissolve(position: THREE.Vector3): void {
    const s = this.ready('dissolve', 1.2);
    if (!s) return;
    const p = this.place(position);
    s.dissolve(s.ctx.currentTime, p.pan, p.level);
  }

  select(position?: THREE.Vector3): void {
    const s = this.ready('select', 0.08);
    if (s) s.select(s.ctx.currentTime, this.place(position).pan);
  }

  check(): void {
    const s = this.ready('bell', 0.5);
    if (s) s.bell(s.ctx.currentTime + 0.05);
  }

  finale(): void {
    const s = this.ready('finale', 1);
    if (s) s.finale(s.ctx.currentTime);
  }

  ascend(position?: THREE.Vector3): void {
    const s = this.ready('ascend', 0.5);
    if (s) s.ascend(s.ctx.currentTime, this.place(position).pan);
  }

  stop(): void {
    this.ambience?.stop();
    this.ambience = null;
  }
}
