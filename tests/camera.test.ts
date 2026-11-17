import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { chooseShot, type Obstacle } from '../src/cinema/cinema';

const attacker = new THREE.Vector3(0, 0, 1);
const victim = new THREE.Vector3(0, 0, -0.5);
const viewer = new THREE.Vector3(6, 12, 14);

/** Whether the sight line from the camera to a point passes through an obstacle. */
function blocked(camera: THREE.Vector3, point: THREE.Vector3, o: Obstacle): boolean {
  const dx = point.x - camera.x;
  const dz = point.z - camera.z;
  const s = Math.min(Math.max(((o.x - camera.x) * dx + (o.z - camera.z) * dz) / (dx * dx + dz * dz), 0), 1);
  const d = Math.hypot(camera.x + dx * s - o.x, camera.z + dz * s - o.z);
  return d < o.radius && camera.y + (point.y - camera.y) * s < o.height;
}

describe('chooseShot', () => {
  it('frames the pair in profile from the viewer\'s side when nothing is in the way', () => {
    const { pose } = chooseShot(attacker, victim, viewer, 2, 2, 2, 1.86, []);
    // The line between the two runs along z, so a profile camera sits out along x, on the
    // viewer's (+x) side, level with the pair's midpoint.
    expect(pose.position.x).toBeGreaterThan(4);
    expect(Math.abs(pose.position.z - 0.25)).toBeLessThan(0.5);
    expect(pose.position.y).toBeGreaterThan(0.5);
    expect(pose.position.y).toBeLessThan(2.5);
  });

  it('keeps the whole height in frame, including a raised weapon', () => {
    const low = chooseShot(attacker, victim, viewer, 2, 2, 2, 1.86, []);
    const high = chooseShot(attacker, victim, viewer, 2, 2, 3, 1.86, []);
    const distance = (s: typeof low): number => s.pose.position.distanceTo(s.pose.target);
    expect(distance(high)).toBeGreaterThan(distance(low) * 1.2);
  });

  it('moves off the ideal position rather than shoot through a statue', () => {
    const ideal = chooseShot(attacker, victim, viewer, 2, 2, 2, 1.86, []).pose.position;
    // A wall of statues between the ideal camera and the pair.
    const wall: Obstacle[] = [-1.5, -0.75, 0, 0.75, 1.5].map((z) => ({ x: ideal.x * 0.45, z: z + 0.25, radius: 0.34, height: 2.1 }));
    const { pose } = chooseShot(attacker, victim, viewer, 2, 2, 2, 1.86, wall);
    expect(pose.position.distanceTo(ideal)).toBeGreaterThan(0.5);
    for (const target of [new THREE.Vector3(0, 1.24, 1), new THREE.Vector3(0, 1.24, -0.5)]) {
      for (const o of wall) expect(blocked(pose.position, target, o)).toBe(false);
    }
  });

  it('never puts the camera inside a statue or out among the pillars', () => {
    const crowd: Obstacle[] = [];
    for (let x = -4; x <= 4; x += 1.25) for (let z = -4; z <= 4; z += 1.25) if (Math.hypot(x, z - 0.25) > 1.6) crowd.push({ x, z, radius: 0.34, height: 2 });
    const { pose } = chooseShot(attacker, victim, viewer, 2, 2, 2, 1.86, crowd);
    expect(Math.hypot(pose.position.x, pose.position.z)).toBeLessThanOrEqual(14.2);
    for (const o of crowd) {
      const inside = Math.hypot(o.x - pose.position.x, o.z - pose.position.z) < o.radius + 0.5 && pose.position.y < o.height + 0.3;
      expect(inside).toBe(false);
    }
  });
});
