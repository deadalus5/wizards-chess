import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { chooseShot, TALL_SHOT, type Obstacle } from '../src/cinema/cinema';

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

/** Where a point lands in a shot's frame: x and y from -1 to 1. */
function inFrame(shot: { pose: { position: THREE.Vector3; target: THREE.Vector3; fov: number } }, aspect: number, point: THREE.Vector3): THREE.Vector3 {
  const camera = new THREE.PerspectiveCamera(shot.pose.fov, aspect, 0.2, 150);
  camera.position.copy(shot.pose.position);
  camera.lookAt(shot.pose.target);
  camera.updateMatrixWorld();
  return point.clone().project(camera);
}

describe('chooseShot on a tall screen', () => {
  const phone = 393 / 852;
  const tablet = 820 / 1180;
  const pairs: [string, THREE.Vector3, THREE.Vector3][] = [
    ['along a file', new THREE.Vector3(0.625, 0, 1.875), new THREE.Vector3(0.625, 0, 0.625)],
    ['on a diagonal', new THREE.Vector3(-1.875, 0, 0.625), new THREE.Vector3(-0.625, 0, -0.625)],
    ['at the edge', new THREE.Vector3(4.375, 0, -1.875), new THREE.Vector3(4.375, 0, -3.125)],
    ['from two squares off', new THREE.Vector3(-3.125, 0, 3.125), new THREE.Vector3(-3.125, 0, 0.625)],
  ];

  it('holds both figures, head to foot, between the bars', () => {
    for (const aspect of [phone, tablet]) {
      for (const [name, a, v] of pairs) {
        for (const obstacles of [[], crowdRound().filter((o) => Math.hypot(o.x - a.x, o.z - a.z) > 0.8 && Math.hypot(o.x - v.x, o.z - v.z) > 0.8)]) {
          const shot = chooseShot(a, v, viewer, 2.2, 2.0, 2.9, aspect, obstacles, TALL_SHOT);
          const limit = 1 - 2 * TALL_SHOT.bar;
          for (const [what, p] of [
            ['the attacker\'s feet', a.clone().setY(0)],
            ['the attacker\'s head', a.clone().setY(2.2)],
            ['the raised weapon', a.clone().setY(2.9)],
            ['the victim\'s feet', v.clone().setY(0)],
            ['the victim\'s head', v.clone().setY(2.0)],
          ] as [string, THREE.Vector3][]) {
            const f = inFrame(shot, aspect, p);
            expect(Math.abs(f.x), `${name} at ${aspect.toFixed(2)}: ${what} across`).toBeLessThan(0.99);
            expect(Math.abs(f.y), `${name} at ${aspect.toFixed(2)}: ${what} up and down`).toBeLessThan(limit + 0.01);
          }
        }
      }
    }
  });

  it('stands much nearer than the wide shot could on the same screen, so the figures fill more of it', () => {
    for (const [, a, v] of pairs) {
      const wide = chooseShot(a, v, viewer, 2.2, 2.0, 2.9, phone, []);
      const tall = chooseShot(a, v, viewer, 2.2, 2.0, 2.9, phone, [], TALL_SHOT);
      const size = (s: typeof tall): number => {
        const top = inFrame(s, phone, v.clone().setY(2.0));
        const foot = inFrame(s, phone, v.clone().setY(0));
        return Math.abs(top.y - foot.y) / 2;
      };
      // The victim, head to foot, as a share of the frame's height (the attacker, nearer, is larger).
      expect(size(tall)).toBeGreaterThan(size(wide) * 1.35);
      expect(size(tall)).toBeGreaterThan(0.2);
    }
  });

  it('never lets the attacker stand in front of its victim', () => {
    for (const aspect of [phone, tablet]) {
      for (const [name, a, v] of pairs) {
        for (const obstacles of [[], crowdRound().filter((o) => Math.hypot(o.x - a.x, o.z - a.z) > 0.8 && Math.hypot(o.x - v.x, o.z - v.z) > 0.8)]) {
          const { pose } = chooseShot(a, v, viewer, 2.2, 2.0, 2.9, aspect, obstacles, TALL_SHOT);
          // The sight line to the victim's chest clears the attacker's body by its width.
          const to = new THREE.Vector3(v.x - pose.position.x, 0, v.z - pose.position.z);
          const along = ((a.x - pose.position.x) * to.x + (a.z - pose.position.z) * to.z) / to.lengthSq();
          const off = Math.hypot(pose.position.x + to.x * along - a.x, pose.position.z + to.z * along - a.z);
          expect(off, `${name} at ${aspect.toFixed(2)}`).toBeGreaterThan(0.5);
        }
      }
    }
  });

  it('looks past the attacker at the victim when nothing is in the way', () => {
    for (const [name, a, v] of pairs) {
      const shot = chooseShot(a, v, viewer, 2.2, 2.0, 2.9, phone, [], TALL_SHOT);
      const axis = new THREE.Vector3().subVectors(v, a).setY(0).normalize();
      const mid = new THREE.Vector3().addVectors(a, v).multiplyScalar(0.5);
      const along = new THREE.Vector3().subVectors(shot.pose.position, mid).setY(0).dot(axis);
      // Behind the attacker: on its side of the middle, measured along the line of the blow.
      expect(along, name).toBeLessThan(-1);
      // And the frame leans towards the one about to break.
      expect(new THREE.Vector3().subVectors(shot.pose.target, mid).setY(0).dot(axis), name).toBeGreaterThan(0.1);
    }
  });

  it('stays inside the hall and out of the statues', () => {
    for (const [name, a, v] of pairs) {
      const crowd = crowdRound().filter((o) => Math.hypot(o.x - a.x, o.z - a.z) > 0.8 && Math.hypot(o.x - v.x, o.z - v.z) > 0.8);
      const { pose } = chooseShot(a, v, viewer, 2.2, 2.0, 2.9, phone, crowd, TALL_SHOT);
      expect(Math.hypot(pose.position.x, pose.position.z), name).toBeLessThanOrEqual(14.2);
      for (const o of crowd) {
        const inside = Math.hypot(o.x - pose.position.x, o.z - pose.position.z) < o.radius + 0.5 && pose.position.y < o.height + 0.3;
        expect(inside, name).toBe(false);
      }
    }
  });
});

/** A crowd round the pair: every other square of the middle of the board. */
function crowdRound(): Obstacle[] {
  const crowd: Obstacle[] = [];
  for (let x = -4.375; x <= 4.376; x += 1.25) for (let z = -4.375; z <= 4.376; z += 2.5) if (Math.hypot(x, z - 0.25) > 1.4) crowd.push({ x, z, radius: 0.34, height: 2 });
  return crowd;
}

describe('chooseShot', () => {
  // Taken from the chooser before it learnt a second style: the desktop's shots, to the
  // millimetre, must stay what they were.
  it('still chooses the shots it always chose', () => {
    const cases: [string, THREE.Vector3, THREE.Vector3, THREE.Vector3, number, number, number, number, Obstacle[]][] = [
      ['open, 16:9', attacker, victim, viewer, 2, 2, 2, 1.86, []],
      ['open, taller top', attacker, victim, viewer, 2.2, 1.7, 3.1, 1.86, []],
      ['diagonal in a crowd', new THREE.Vector3(1.875, 0, 0.625), new THREE.Vector3(3.125, 0, -0.625), new THREE.Vector3(-4, 13, 14), 2.6, 2.2, 3.2, 1.78, crowdRound()],
      ['at the edge, seen from Obsidian', new THREE.Vector3(-4.375, 0, -3.125), new THREE.Vector3(-4.375, 0, -4.375), new THREE.Vector3(2, 13, -14), 2.2, 1.7, 2.9, 2.2, crowdRound()],
      ['a narrow window', attacker, victim, viewer, 2, 2, 2, 1.1, crowdRound()],
    ];
    const got = cases.map(([name, a, v, eye, hA, hV, top, aspect, obstacles]) => {
      const s = chooseShot(a, v, eye, hA, hV, top, aspect, obstacles);
      const r = (n: number): number => Math.round(n * 1000) / 1000;
      return `${name}: at ${r(s.pose.position.x)}, ${r(s.pose.position.y)}, ${r(s.pose.position.z)} looking at ${r(s.pose.target.x)}, ${r(s.pose.target.y)}, ${r(s.pose.target.z)} fov ${s.pose.fov} focus ${r(s.focus.x)}, ${r(s.focus.y)}, ${r(s.focus.z)}`;
    });
    expect(got).toMatchInlineSnapshot(`
      [
        "open, 16:9: at 7.003, 1.56, 0.25 looking at 0, 0.93, 0.25 fov 26 focus 0, 1.2, 0.25",
        "open, taller top: at 10.123, 1.716, 0.25 looking at 0, 1.48, 0.25 fov 26 focus 0, 1.32, 0.25",
        "diagonal in a crowd: at 10.891, 7.54, -1.329 looking at 2.5, 1.53, 0 fov 26 focus 2.5, 1.56, 0",
        "at the edge, seen from Obsidian: at -13.464, 1.716, -0.797 looking at -4.375, 1.38, -3.75 fov 26 focus -4.375, 1.32, -3.75",
        "a narrow window: at 7.868, 5.8, 0.25 looking at 0, 0.93, 0.25 fov 26 focus 0, 1.2, 0.25",
      ]
    `);
  });

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
