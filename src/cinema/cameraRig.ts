import * as THREE from 'three';
import { angleDelta, clamp, damp, ease } from '../core/math';
import type { Side } from '../game/squares';

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

const ELEVATION_MIN = THREE.MathUtils.degToRad(16);
const ELEVATION_MAX = THREE.MathUtils.degToRad(82);
const DISTANCE_MIN = 8;
const DISTANCE_MAX = 30;

/**
 * The camera: a damped orbit around the board that the player controls, plus an override
 * pose for cinematic shots and trauma-based shake applied on top of either.
 *
 * Azimuth 0 looks at the board from White's side (+z); pi is Black's side.
 */
export class CameraRig {
  readonly target = new THREE.Vector3(0, 0.3, 0);
  azimuth = 0;
  elevation = THREE.MathUtils.degToRad(44);
  distance = 19.5;
  fov = 30;

  private goalAzimuth = 0;
  private goalElevation = this.elevation;
  private goalDistance = this.distance;

  /** When set, the camera uses this pose instead of the orbit (cinematic shots). */
  override: CameraPose | null = null;
  /** 0..1, decays over time; shake amplitude is trauma squared. */
  trauma = 0;
  private shakeTime = 0;

  private dragging = false;
  private dragMoved = false;
  private lastX = 0;
  private lastY = 0;
  /** True while the pointer is down and has moved far enough to count as an orbit drag. */
  get isDragging(): boolean {
    return this.dragging && this.dragMoved;
  }
  /** Set to false to ignore player input (during cinematics). */
  inputEnabled = true;
  /** Radians per second of slow turning on its own (the title screen). */
  drift = 0;
  /** A swing round to the other player's seat in progress (eased, so it never whips). */
  private swing: { from: number; to: number; time: number; duration: number } | null = null;

  private readonly look = new THREE.Vector3();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      this.dragMoved = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (!this.dragMoved && Math.hypot(dx, dy) < 5) return;
      this.dragMoved = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (!this.inputEnabled) return;
      // The player takes over: stop any swing where it is.
      if (this.swing) {
        this.swing = null;
        this.goalAzimuth = this.azimuth;
      }
      this.goalAzimuth -= dx * 0.0052;
      this.goalElevation = clamp(this.goalElevation + dy * 0.0042, ELEVATION_MIN, ELEVATION_MAX);
    });
    addEventListener('pointerup', () => {
      this.dragging = false;
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!this.inputEnabled) return;
        this.goalDistance = clamp(this.goalDistance * Math.exp(e.deltaY * 0.0011), DISTANCE_MIN, DISTANCE_MAX);
      },
      { passive: false },
    );
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Whether the last pointer press turned into a drag (so it should not count as a click). */
  consumedClick(): boolean {
    return this.dragMoved;
  }

  /** Swing round to look from one side's seat. */
  viewFor(side: Side, immediate = false): void {
    const want = side === 'w' ? 0 : Math.PI;
    // Go the short way round from wherever the player has dragged the camera.
    const to = this.azimuth + angleDelta(this.azimuth, want);
    if (immediate) {
      this.swing = null;
      this.azimuth = this.goalAzimuth = to;
      return;
    }
    const turn = Math.abs(to - this.azimuth);
    if (turn < 0.02) {
      this.swing = null;
      this.goalAzimuth = to;
      return;
    }
    // A half-turn of the board takes a couple of seconds, starting and stopping gently.
    this.swing = { from: this.azimuth, to, time: 0, duration: 0.7 + 0.42 * turn };
  }

  /** Which side's seat the camera is nearer to. */
  nearestSide(): Side {
    return Math.abs(angleDelta(this.azimuth, 0)) < Math.PI / 2 ? 'w' : 'b';
  }

  setOrbit(azimuth: number, elevation: number, distance: number, immediate = true): void {
    this.swing = null;
    this.goalAzimuth = azimuth;
    this.goalElevation = clamp(elevation, ELEVATION_MIN, ELEVATION_MAX);
    this.goalDistance = clamp(distance, DISTANCE_MIN, DISTANCE_MAX);
    if (immediate) {
      this.azimuth = this.goalAzimuth;
      this.elevation = this.goalElevation;
      this.distance = this.goalDistance;
    }
  }

  /** The orbit camera's current pose (ignoring any override). */
  orbitPose(out: CameraPose): CameraPose {
    const ce = Math.cos(this.elevation);
    out.position.set(this.target.x + Math.sin(this.azimuth) * ce * this.distance, this.target.y + Math.sin(this.elevation) * this.distance, this.target.z + Math.cos(this.azimuth) * ce * this.distance);
    out.target.copy(this.target);
    out.fov = this.fov;
    return out;
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  private readonly scratch: CameraPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 30 };

  /** `dt` is real time for the orbit feel; `gameDt` (scaled) drives shake so it slows with slow motion. */
  update(dt: number, gameDt = dt): void {
    this.goalAzimuth += this.drift * dt;
    if (this.swing) {
      const s = this.swing;
      s.time += dt;
      const k = ease.inOutCubic(Math.min(1, s.time / s.duration));
      this.azimuth = this.goalAzimuth = s.from + (s.to - s.from) * k;
      if (s.time >= s.duration) this.swing = null;
    } else {
      this.azimuth = damp(this.azimuth, this.goalAzimuth, 5.5, dt);
    }
    this.elevation = damp(this.elevation, this.goalElevation, 7, dt);
    this.distance = damp(this.distance, this.goalDistance, 7, dt);

    const pose = this.override ?? this.orbitPose(this.scratch);
    const cam = this.camera;
    cam.position.copy(pose.position);
    this.look.copy(pose.target);
    if (cam.fov !== pose.fov) {
      cam.fov = pose.fov;
      cam.updateProjectionMatrix();
    }
    cam.lookAt(this.look);

    // Shake: smooth pseudo-noise from layered sines; rotation only, so nothing swims in depth.
    this.trauma = Math.max(0, this.trauma - gameDt * 1.6);
    if (this.trauma > 0.001) {
      this.shakeTime += gameDt;
      const s = this.trauma * this.trauma;
      const t = this.shakeTime;
      const n = (a: number, b: number): number => Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.7) * 0.4;
      cam.rotateX(n(41.3, 67.1) * 0.012 * s);
      cam.rotateY(n(37.7, 59.9) * 0.012 * s);
      cam.rotateZ(n(29.1, 51.3) * 0.016 * s);
    }
  }
}
