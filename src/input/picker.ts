import * as THREE from 'three';
import { squareAt, squareCentre } from '../game/squares';
import type { Actor } from '../pieces/actor';
import type { RayHit } from './tapTarget';

/**
 * Finds the board square under the pointer analytically: the ray is tested against a vertical
 * cylinder around each statue (so clicking a tall figure selects it, not the square behind
 * it) and against the board plane. No mesh raycasting, which would be slow and wrong for
 * skinned geometry.
 */
export class Picker {
  private readonly ray = new THREE.Ray();
  private readonly ndc = new THREE.Vector2();
  private readonly origin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly point = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
  ) {}

  squareAt(clientX: number, clientY: number, actors: readonly Actor[]): string | null {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.origin.setFromMatrixPosition(this.camera.matrixWorld);
    this.dir.set(this.ndc.x, this.ndc.y, 0.5).unproject(this.camera).sub(this.origin).normalize();
    this.ray.set(this.origin, this.dir);

    let bestT = Infinity;
    let best: string | null = null;

    // Board plane y = 0.
    if (this.dir.y < -1e-5) {
      const t = -this.origin.y / this.dir.y;
      const sq = squareAt(this.origin.x + this.dir.x * t, this.origin.z + this.dir.z * t);
      if (sq) {
        bestT = t;
        best = sq;
      }
    }

    // Statues: infinite vertical cylinder, then clamp to the figure's height.
    for (const a of actors) {
      if (!a.alive) continue;
      const cx = a.root.position.x;
      const cz = a.root.position.z;
      const ox = this.origin.x - cx;
      const oz = this.origin.z - cz;
      const dx = this.dir.x;
      const dz = this.dir.z;
      const A = dx * dx + dz * dz;
      if (A < 1e-9) continue;
      const B = 2 * (ox * dx + oz * dz);
      const C = ox * ox + oz * oz - a.radius * a.radius;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t <= 0 || t >= bestT) continue;
      const y = this.origin.y + this.dir.y * t;
      if (y < 0 || y > a.restHeight) continue;
      bestT = t;
      best = a.square;
    }
    return best;
  }

  /**
   * Everything the pointer's line of sight passes through, nearest first: each statue whose
   * cylinder it enters, then the board square it lands on. For reading a finger's tap
   * (`resolveTap`), which cannot aim round a statue as a mouse can.
   */
  hitsAt(clientX: number, clientY: number, actors: readonly Actor[]): RayHit[] {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.origin.setFromMatrixPosition(this.camera.matrixWorld);
    this.dir.set(this.ndc.x, this.ndc.y, 0.5).unproject(this.camera).sub(this.origin).normalize();
    const { origin, dir } = this;
    const found: { t: number; hit: RayHit }[] = [];

    if (dir.y < -1e-5) {
      const t = -origin.y / dir.y;
      const square = squareAt(origin.x + dir.x * t, origin.z + dir.z * t);
      if (square) found.push({ t, hit: { square, statue: false, offAxis: 0 } });
    }
    const A = dir.x * dir.x + dir.z * dir.z;
    if (A > 1e-9) {
      for (const a of actors) {
        if (!a.alive) continue;
        const ox = origin.x - a.root.position.x;
        const oz = origin.z - a.root.position.z;
        const B = 2 * (ox * dir.x + oz * dir.z);
        const C = ox * ox + oz * oz - a.radius * a.radius;
        const disc = B * B - 4 * A * C;
        if (disc < 0) continue;
        const t = (-B - Math.sqrt(disc)) / (2 * A);
        if (t <= 0) continue;
        const y = origin.y + dir.y * t;
        if (y < 0 || y > a.restHeight) continue;
        // How near the statue's axis the line passes, seen from above.
        const closest = Math.sqrt(Math.max(0, ox * ox + oz * oz - (B * B) / (4 * A)));
        found.push({ t, hit: { square: a.square, statue: true, offAxis: closest / a.radius } });
      }
    }
    return found.sort((p, q) => p.t - q.t).map((f) => f.hit);
  }

  /** Where a point `up` metres above the middle of a square is on screen, in client pixels (null behind the camera). */
  screenOf(square: string, up = 0): { x: number; y: number } | null {
    squareCentre(square, this.point);
    this.point.y = up;
    this.point.project(this.camera);
    if (this.point.z > 1) return null;
    const rect = this.dom.getBoundingClientRect();
    return { x: rect.left + ((this.point.x + 1) / 2) * rect.width, y: rect.top + ((1 - this.point.y) / 2) * rect.height };
  }
}
