import * as THREE from 'three';
import { angleDelta, clamp, damp, ease } from '../core/math';
import type { Side } from '../game/squares';
import { TouchGestures, type GestureDelta } from '../input/gestures';
import { DESKTOP_SEAT, slideLimit, type Seat } from './seat';

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

const ELEVATION_MIN = THREE.MathUtils.degToRad(16);
const ELEVATION_MAX = THREE.MathUtils.degToRad(82);
const DISTANCE_MIN = 8;
const DISTANCE_MAX = 30;

export interface CameraRigOptions {
  /**
   * A phone or tablet: fingers turn, zoom and slide the view (mouse and pen keep working as
   * they always have). Off, touch pointers are treated like any other, as before.
   */
  touch?: boolean;
}

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
  /** How near and how far the player may zoom. */
  distanceMin = DISTANCE_MIN;
  distanceMax = DISTANCE_MAX;
  /**
   * Metres short of the target that the camera aims, towards itself (see `Seat.aim`). Always
   * 0 on the desktop.
   */
  aim = 0;

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

  // ---- touch (phones and tablets only) ----
  private readonly touch: boolean;
  private readonly gestures = new TouchGestures(10);
  private seat: Seat = DESKTOP_SEAT;
  /** Where the player has slid the view to, across the board from its middle (x, z), and where it is easing to. */
  private readonly slide = new THREE.Vector2();
  private readonly slideGoal = new THREE.Vector2();
  /** Called when a finger taps the board, with where (client coordinates). */
  onTap: ((clientX: number, clientY: number) => void) | null = null;
  /** Called whenever a finger comes down on the board or moves it. */
  onTouch: (() => void) | null = null;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    options: CameraRigOptions = {},
  ) {
    this.touch = options.touch === true;
    dom.addEventListener('pointerdown', (e) => {
      if (this.touch && e.pointerType === 'touch') {
        this.gestures.down(e.pointerId, e.clientX, e.clientY);
        this.onTouch?.();
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      this.dragMoved = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    addEventListener('pointermove', (e) => {
      if (this.touch && e.pointerType === 'touch') {
        const delta = this.gestures.move(e.pointerId, e.clientX, e.clientY);
        if (delta) this.applyGesture(delta);
        return;
      }
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
    addEventListener('pointerup', (e) => {
      if (this.touch && e.pointerType === 'touch') {
        const end = this.gestures.up(e.pointerId);
        if (end?.tap) this.onTap?.(end.x, end.y);
        return;
      }
      this.dragging = false;
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!this.inputEnabled) return;
        this.goalDistance = clamp(this.goalDistance * Math.exp(e.deltaY * 0.0011), this.distanceMin, this.distanceMax);
      },
      { passive: false },
    );
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    if (this.touch) {
      // The browser may take a finger away (a system gesture, a call coming in).
      addEventListener('pointercancel', (e) => {
        if (e.pointerType === 'touch') this.gestures.cancel(e.pointerId);
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.gestures.reset();
      });
    }
  }

  /** A finger's movement, as the recogniser reads it: one finger turns the view, two zoom and slide it. */
  private applyGesture(delta: GestureDelta): void {
    this.onTouch?.();
    // Fingers are followed even while input is off (a cinematic shot, the title), so that the
    // view does not jump when it comes back; they just move nothing meanwhile.
    if (!this.inputEnabled) return;
    if (delta.kind === 'orbit') {
      if (this.swing) {
        this.swing = null;
        this.goalAzimuth = this.azimuth;
      }
      // Half a turn of the board for a swipe across the screen, within sensible limits.
      const rate = clamp(Math.PI / Math.max(1, innerWidth), 0.0045, 0.009);
      this.goalAzimuth -= delta.dx * rate;
      this.goalElevation = clamp(this.goalElevation + delta.dy * 0.0042, ELEVATION_MIN, ELEVATION_MAX);
      return;
    }
    const before = this.goalDistance;
    this.goalDistance = clamp(before / delta.scale, this.distanceMin, this.distanceMax);
    // Metres of board plane to a pixel of screen at the target, across and (foreshortened) in depth.
    const across = (2 * this.distance * Math.tan((this.fov * Math.PI) / 360)) / Math.max(1, innerHeight);
    const deep = across / Math.max(0.2, Math.sin(this.elevation));
    // What is under the fingers stays under them: as the view grows or shrinks about its
    // middle, slide it by how far from the middle they are.
    const grew = 1 - this.goalDistance / before;
    const right = (delta.x - innerWidth / 2) * grew - delta.dx;
    const down = (delta.y - innerHeight / 2) * grew - delta.dy;
    const sin = Math.sin(this.azimuth);
    const cos = Math.cos(this.azimuth);
    // On the board, "right" on screen is (cos, -sin) and "down" (towards the camera) is (sin, cos).
    this.slideGoal.x += right * across * cos + down * deep * sin;
    this.slideGoal.y += -right * across * sin + down * deep * cos;
    this.limitSlide();
  }

  /** Keep the slid view within what the zoom allows: nothing at the seat, the whole board close in. */
  private limitSlide(): void {
    const limit = slideLimit(this.seat, this.goalDistance);
    const length = this.slideGoal.length();
    if (length > limit) this.slideGoal.multiplyScalar(length > 1e-6 ? limit / length : 0);
  }

  /** Take a seat: the lens, height and distance the whole board is seen from on this screen. */
  setSeat(seat: Seat, immediate = false): void {
    this.seat = seat;
    this.fov = seat.fov;
    this.aim = seat.aim;
    this.distanceMin = seat.distanceMin;
    this.distanceMax = seat.distanceMax;
    this.goalElevation = clamp(seat.elevation, ELEVATION_MIN, ELEVATION_MAX);
    this.goalDistance = seat.distance;
    this.slideGoal.set(0, 0);
    if (immediate) {
      this.elevation = this.goalElevation;
      this.distance = this.goalDistance;
      this.slide.set(0, 0);
    }
  }

  /** Ease back to the whole board from wherever the player has zoomed and slid to. */
  recentre(): void {
    this.slideGoal.set(0, 0);
    if (this.goalDistance < this.seat.distance) this.goalDistance = this.seat.distance;
  }

  /** How far in the player has zoomed from the seat: 0 at the seat, 1 at the nearest. */
  get zoomed(): number {
    return clamp((this.seat.distance - this.goalDistance) / Math.max(1e-6, this.seat.distance - this.distanceMin), 0, 1);
  }

  /** Whether the view is still on its way somewhere (a swing, a drift, an ease) or a finger is on it. */
  get moving(): boolean {
    return (
      this.swing !== null ||
      this.drift !== 0 ||
      this.dragging ||
      this.gestures.count > 0 ||
      this.trauma > 0.001 ||
      Math.abs(this.goalAzimuth - this.azimuth) > 1e-3 ||
      Math.abs(this.goalElevation - this.elevation) > 1e-3 ||
      Math.abs(this.goalDistance - this.distance) > 1e-2 ||
      this.slideGoal.distanceToSquared(this.slide) > 1e-4
    );
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
    this.goalDistance = clamp(distance, this.distanceMin, this.distanceMax);
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
    if (this.aim !== 0) {
      out.target.x += Math.sin(this.azimuth) * this.aim;
      out.target.z += Math.cos(this.azimuth) * this.aim;
    }
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
    if (this.touch) {
      // Zooming out draws the slid view back to the middle of the board.
      this.limitSlide();
      this.slide.x = damp(this.slide.x, this.slideGoal.x, 9, dt);
      this.slide.y = damp(this.slide.y, this.slideGoal.y, 9, dt);
      this.target.x = this.slide.x;
      this.target.z = this.slide.y;
    }

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
