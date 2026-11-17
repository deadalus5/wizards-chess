import * as THREE from 'three';
import { LAYER, REGION, type PiecePart } from './buildPiece';
import { sliceAboveY } from './geometryTools';

/**
 * Sculpted fittings that are not cut from the body: a shield slung on the back, the toe caps
 * of heavy boots. Each is rigid on one bone. A fitting can be made of more than one material
 * (a stone field with a metal rim), which is recorded per vertex.
 */

type V3 = [number, number, number];

/** Collects triangles with a normal and a surface region per vertex. */
class Sculpt {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly region: number[] = [];

  vertex(p: V3, n: V3, region: number): void {
    this.position.push(p[0], p[1], p[2]);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    this.normal.push(n[0] / len, n[1] / len, n[2] / len);
    this.region.push(region);
  }

  /** A triangle given counter-clockwise as seen from outside; skipped if it has no area. */
  triangle(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, region: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-12) return;
    this.vertex(a, na, region);
    this.vertex(b, nb, region);
    this.vertex(c, nc, region);
  }

  /** A triangle shaded flat. */
  flat(a: V3, b: V3, c: V3, region: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    this.triangle(a, b, c, n, n, n, region);
  }

  /**
   * A surface of revolution about the z axis. The profile runs from the centre of the outer
   * face outwards, round the rim and back to the centre of the inner face; each point names
   * the region of the stretch that follows it.
   */
  lathe(profile: readonly { r: number; z: number; region: number }[], segments: number): void {
    const count = profile.length;
    // Normal of each stretch in the (r, z) plane.
    const flatN: [number, number][] = [];
    for (let i = 0; i + 1 < count; i++) {
      const dr = profile[i + 1].r - profile[i].r;
      const dz = profile[i + 1].z - profile[i].z;
      const len = Math.hypot(dr, dz) || 1;
      flatN.push([-dz / len, dr / len]);
    }
    // Shade smoothly across a joint unless it is a real corner.
    const crease = Math.cos((38 * Math.PI) / 180);
    const at = (i: number, stretch: number): [number, number] => {
      const own = flatN[stretch];
      const other = flatN[i === stretch ? stretch - 1 : stretch + 1];
      if (!other || own[0] * other[0] + own[1] * other[1] < crease) return own;
      return [own[0] + other[0], own[1] + other[1]];
    };
    for (let i = 0; i + 1 < count; i++) {
      const p0 = profile[i];
      const p1 = profile[i + 1];
      const n0 = at(i, i);
      const n1 = at(i + 1, i);
      for (let j = 0; j < segments; j++) {
        const t0 = (j / segments) * Math.PI * 2;
        const t1 = ((j + 1) / segments) * Math.PI * 2;
        const place = (p: { r: number; z: number }, t: number): V3 => [p.r * Math.cos(t), p.r * Math.sin(t), p.z];
        const norm = (n: [number, number], t: number): V3 => [n[0] * Math.cos(t), n[0] * Math.sin(t), n[1]];
        const a = place(p0, t0);
        const b = place(p1, t0);
        const c = place(p1, t1);
        const d = place(p0, t1);
        this.triangle(a, b, c, norm(n0, t0), norm(n1, t0), norm(n1, t1), p0.region);
        this.triangle(a, c, d, norm(n0, t0), norm(n1, t1), norm(n0, t1), p0.region);
      }
    }
  }

  /** A strip between two rows of points, facing the side from which `right` runs clockwise of `left`. */
  strip(right: readonly V3[], left: readonly V3[], region: number): void {
    for (let i = 0; i + 1 < right.length; i++) {
      this.flat(right[i], right[i + 1], left[i + 1], region);
      this.flat(right[i], left[i + 1], left[i], region);
    }
  }

  build(): THREE.BufferGeometry {
    const count = this.position.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    g.setAttribute('region', new THREE.Float32BufferAttribute(this.region, 1));
    return g;
  }
}

export interface ShieldOptions {
  radius: number;
  /** Centre of the shield's rim plane in bind-pose space. */
  centre: THREE.Vector3;
  /** Lean of the top towards the body, radians. */
  lean?: number;
}

/**
 * A round shield carried on the back, face outwards. Its ornament is a raised ring and a
 * single stroke running out of the ring towards the lower right: together, the letter Q.
 *
 * Built facing +z with x to the viewer's right, then turned to face the statue's back.
 */
export function backShield(options: ShieldOptions): PiecePart {
  const R = options.radius;
  const s = new Sculpt();
  const stone = REGION.plate;
  const gold = REGION.trim;

  const bulge = 0.16 * R;
  const thick = 0.058 * R;
  const dome = (r: number): number => bulge * (1 - (r / R) ** 2);

  // The ring: the bowl of the Q.
  const ringR = 0.5 * R;
  const ringHalf = 0.024 * R;
  const bevel = 0.014 * R;
  const raised = 0.02 * R;
  // The rolled rim.
  const rimIn = 0.875 * R;

  const profile: { r: number; z: number; region: number }[] = [];
  const field = (from: number, to: number): void => {
    const steps = Math.max(1, Math.round((to - from) / (0.08 * R)));
    for (let i = 0; i < steps; i++) {
      const r = from + ((to - from) * i) / steps;
      profile.push({ r, z: dome(r), region: stone });
    }
  };
  field(0, ringR - ringHalf - bevel);
  profile.push({ r: ringR - ringHalf - bevel, z: dome(ringR - ringHalf - bevel), region: gold });
  profile.push({ r: ringR - ringHalf, z: dome(ringR - ringHalf) + raised, region: gold });
  profile.push({ r: ringR + ringHalf, z: dome(ringR + ringHalf) + raised, region: gold });
  field(ringR + ringHalf + bevel, rimIn);
  profile.push({ r: rimIn, z: dome(rimIn), region: gold });
  profile.push({ r: rimIn + 0.025 * R, z: dome(rimIn) + 0.034 * R, region: gold });
  profile.push({ r: R - 0.03 * R, z: dome(rimIn) + 0.034 * R, region: gold });
  profile.push({ r: R, z: 0.012 * R, region: gold });
  profile.push({ r: R, z: -thick, region: gold });
  // The hollow inner face.
  const inner = (r: number): number => dome(r) * 0.8 - thick;
  profile.push({ r: R - 0.05 * R, z: inner(R - 0.05 * R), region: stone });
  for (let i = 1; i <= 6; i++) {
    const r = (R - 0.05 * R) * (1 - i / 6);
    profile.push({ r, z: inner(r), region: stone });
  }
  s.lathe(profile, 72);

  // The tail: a stroke from inside the ring, across it, out towards the rim.
  const p0: [number, number] = [0.2 * R, -0.3 * R];
  const p1: [number, number] = [0.4 * R, -0.5 * R];
  const p2: [number, number] = [0.68 * R, -0.5 * R];
  const samples = 28;
  const tailHalf = 0.03 * R;
  const tailRaised = raised + 0.008 * R;
  const rows: { lb: V3; lt: V3; rt: V3; rb: V3 }[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = (1 - t) ** 2 * p0[0] + 2 * t * (1 - t) * p1[0] + t * t * p2[0];
    const y = (1 - t) ** 2 * p0[1] + 2 * t * (1 - t) * p1[1] + t * t * p2[1];
    const dx = 2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
    const dy = 2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    const len = Math.hypot(dx, dy) || 1;
    // To the left of the direction of travel.
    const nx = -dy / len;
    const ny = dx / len;
    // Pointed at both ends, fullest two-thirds of the way out.
    const w = tailHalf * Math.max(0, 1 - Math.abs((t - 0.6) / (t < 0.6 ? 0.6 : 0.4)) ** 2.4);
    const on = (side: number, lift: number): V3 => {
      const px = x + nx * side;
      const py = y + ny * side;
      return [px, py, dome(Math.hypot(px, py)) + lift];
    };
    rows.push({ lb: on(w + bevel, -0.004 * R), lt: on(w, tailRaised), rt: on(-w, tailRaised), rb: on(-w - bevel, -0.004 * R) });
  }
  s.strip(
    rows.map((r) => r.rt),
    rows.map((r) => r.lt),
    gold,
  );
  s.strip(
    rows.map((r) => r.lt),
    rows.map((r) => r.lb),
    gold,
  );
  s.strip(
    rows.map((r) => r.rb),
    rows.map((r) => r.rt),
    gold,
  );

  const g = s.build();
  // Turn it to face backwards (x stays to the right of someone looking at it), lean it, place it.
  const m = new THREE.Matrix4()
    .makeTranslation(options.centre.x, options.centre.y, options.centre.z)
    .multiply(new THREE.Matrix4().makeRotationX(options.lean ?? 0))
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI));
  g.applyMatrix4(m);
  return { geometry: g, layer: LAYER.flat, region: stone, bone: 'spine_03', fracture: 'own' };
}

/** A smooth ellipsoid, non-indexed, with true normals. */
function ellipsoid(centre: V3, radii: V3, rings = 14, segments = 22): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const at = (i: number, j: number): { p: V3; n: V3 } => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segments) * Math.PI * 2;
    const d: V3 = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
    const n: V3 = [d[0] / radii[0], d[1] / radii[1], d[2] / radii[2]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return { p: [centre[0] + d[0] * radii[0], centre[1] + d[1] * radii[1], centre[2] + d[2] * radii[2]], n: [n[0] / len, n[1] / len, n[2] / len] };
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      // Wound to face outwards.
      for (const v of i === 0 ? [a, c, b] : i === rings - 1 ? [a, d, b] : [a, c, b, a, d, c]) {
        position.push(...v.p);
        normal.push(...v.n);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((position.length / 3) * 2), 2));
  return g;
}

/**
 * Rounded metal toe caps for heavy boots, one on each foot, flat on the sole. `ball` is the
 * joint the toes bend at (left foot, bind pose) and `toe` the tip of the toes.
 */
export function toeCaps(ball: THREE.Vector3, toe: THREE.Vector3): PiecePart[] {
  const parts: PiecePart[] = [];
  const length = toe.z - ball.z;
  for (const side of ['l', 'r'] as const) {
    const x = side === 'l' ? ball.x : -ball.x;
    // The foot is widest at the ball and a little outward of the joint.
    const cx = x + (side === 'l' ? 0.014 : -0.014);
    const cap = ellipsoid([cx, 0.014, ball.z + length * 0.36], [0.074, 0.066, length * 0.5 + 0.062]);
    const cut = sliceAboveY(cap, 0.003);
    parts.push({ geometry: cut, layer: LAYER.flat, region: REGION.trim, bone: `ball_${side}` });
  }
  return parts;
}
