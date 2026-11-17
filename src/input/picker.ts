import * as THREE from 'three';
import { squareAt } from '../game/squares';
import type { Actor } from '../pieces/actor';

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
}
