import * as THREE from 'three';
import { Pose, poseJoints } from '../anim/pose';
import type { Rig } from '../anim/rig';

/**
 * Fitted plate armour generated from the body itself.
 *
 * A region of the body surface is clipped out with planes (clean straight edges), pushed out
 * along the surface normal, and closed with a rim back to the skin. The shell keeps the body's
 * skin weights, so it deforms exactly with the figure and cannot poke through: the classical
 * "muscle cuirass" was sculpted this way too.
 */

interface SkinVert {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
  bones: number[];
  weights: number[];
}

/** Half-space n.p + d >= 0. */
export interface ClipPlane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

export const above = (y: number): ClipPlane => ({ nx: 0, ny: 1, nz: 0, d: -y });
export const below = (y: number): ClipPlane => ({ nx: 0, ny: -1, nz: 0, d: y });
export const rightOf = (x: number): ClipPlane => ({ nx: 1, ny: 0, nz: 0, d: -x });
export const leftOf = (x: number): ClipPlane => ({ nx: -1, ny: 0, nz: 0, d: x });
export const inFrontOf = (z: number): ClipPlane => ({ nx: 0, ny: 0, nz: 1, d: -z });
export const behind = (z: number): ClipPlane => ({ nx: 0, ny: 0, nz: -1, d: z });

const dist = (p: ClipPlane, v: SkinVert): number => p.nx * v.x + p.ny * v.y + p.nz * v.z + p.d;

function lerpVert(a: SkinVert, b: SkinVert, t: number): SkinVert {
  const bones: number[] = [];
  const weights: number[] = [];
  const add = (bs: number[], ws: number[], k: number): void => {
    for (let i = 0; i < bs.length; i++) {
      if (ws[i] <= 0) continue;
      const at = bones.indexOf(bs[i]);
      if (at >= 0) weights[at] += ws[i] * k;
      else {
        bones.push(bs[i]);
        weights.push(ws[i] * k);
      }
    }
  };
  add(a.bones, a.weights, 1 - t);
  add(b.bones, b.weights, t);
  const m = (p: number, q: number): number => p + (q - p) * t;
  return { x: m(a.x, b.x), y: m(a.y, b.y), z: m(a.z, b.z), nx: m(a.nx, b.nx), ny: m(a.ny, b.ny), nz: m(a.nz, b.nz), u: m(a.u, b.u), v: m(a.v, b.v), bones, weights };
}

function clip(poly: SkinVert[], plane: ClipPlane): SkinVert[] {
  const out: SkinVert[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = dist(plane, a);
    const db = dist(plane, b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) out.push(lerpVert(a, b, da / (da - db)));
  }
  return out;
}

export interface ShellOptions {
  /** Keep the surface inside all of these half-spaces. */
  planes: ClipPlane[];
  /** How far the plate stands off the skin, metres. */
  thickness: number;
  /** Extra stand-off at the plate's borders, for a rolled edge. */
  rim?: number;
  /** Width of the rolled edge, metres. */
  rimWidth?: number;
  /** Mirror the region across x = 0 as well (for limbs). */
  mirror?: boolean;
}

/** Top four influences, normalised. */
function packSkin(v: SkinVert, index: Uint16Array, weight: Float32Array, at: number): void {
  const order = v.bones.map((_, i) => i).sort((i, j) => v.weights[j] - v.weights[i]).slice(0, 4);
  let sum = 0;
  for (const i of order) sum += v.weights[i];
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    index[at * 4 + k] = i === undefined ? 0 : v.bones[i];
    weight[at * 4 + k] = i === undefined || sum <= 0 ? 0 : v.weights[i] / sum;
  }
  if (sum <= 0) weight[at * 4] = 1;
}

/** Build a plate from the skinned body geometry (bind pose). */
export function buildShell(body: THREE.BufferGeometry, options: ShellOptions): THREE.BufferGeometry {
  const pos = body.getAttribute('position');
  const nor = body.getAttribute('normal');
  const uv = body.getAttribute('uv');
  const si = body.getAttribute('skinIndex');
  const sw = body.getAttribute('skinWeight');
  const index = body.index;
  const triCount = (index ? index.count : pos.count) / 3;

  const source = (i: number): SkinVert => ({
    x: pos.getX(i),
    y: pos.getY(i),
    z: pos.getZ(i),
    nx: nor.getX(i),
    ny: nor.getY(i),
    nz: nor.getZ(i),
    u: uv ? uv.getX(i) : 0,
    v: uv ? uv.getY(i) : 0,
    bones: [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)],
    weights: [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)],
  });

  const planeSets: ClipPlane[][] = [options.planes];
  if (options.mirror) planeSets.push(options.planes.map((p) => ({ nx: -p.nx, ny: p.ny, nz: p.nz, d: p.d })));

  const tris: SkinVert[] = [];
  const borderDist: number[] = [];
  for (const planes of planeSets) {
    for (let t = 0; t < triCount; t++) {
      let poly = [0, 1, 2].map((k) => source(index ? index.getX(t * 3 + k) : t * 3 + k));
      for (const plane of planes) {
        if (poly.length < 3) break;
        poly = clip(poly, plane);
      }
      for (let k = 1; k + 1 < poly.length; k++) {
        for (const v of [poly[0], poly[k], poly[k + 1]]) {
          tris.push(v);
          let d = Infinity;
          for (const plane of planes) d = Math.min(d, dist(plane, v));
          borderDist.push(d);
        }
      }
    }
  }
  const n = tris.length;
  if (n === 0) throw new Error('armour region selects no geometry');

  // Weld by position so the offset direction is shared across UV seams and the open
  // border of the region can be found.
  const key = (v: SkinVert): string => `${Math.round(v.x * 20000)}_${Math.round(v.y * 20000)}_${Math.round(v.z * 20000)}`;
  const idOf = new Map<string, number>();
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = key(tris[i]);
    let id = idOf.get(k);
    if (id === undefined) {
      id = idOf.size;
      idOf.set(k, id);
    }
    ids[i] = id;
  }
  const unique = idOf.size;
  const dir = new Float32Array(unique * 3);
  for (let t = 0; t < n; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    // Area-weighted face normal.
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) {
      const id = ids[t + k];
      dir[id * 3] += fx;
      dir[id * 3 + 1] += fy;
      dir[id * 3 + 2] += fz;
    }
  }
  for (let i = 0; i < unique; i++) {
    const len = Math.hypot(dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2]) || 1;
    dir[i * 3] /= len;
    dir[i * 3 + 1] /= len;
    dir[i * 3 + 2] /= len;
  }

  const rim = options.rim ?? 0;
  const rimWidth = options.rimWidth ?? 0.03;
  const outer: SkinVert[] = tris.map((v, i) => {
    const id = ids[i];
    const edge = 1 - THREE.MathUtils.smoothstep(borderDist[i], 0, rimWidth);
    const off = options.thickness + rim * edge;
    return { ...v, x: v.x + dir[id * 3] * off, y: v.y + dir[id * 3 + 1] * off, z: v.z + dir[id * 3 + 2] * off, nx: dir[id * 3], ny: dir[id * 3 + 1], nz: dir[id * 3 + 2] };
  });

  // Border edges: used by exactly one triangle.
  const edgeUse = new Map<string, number>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const e = edgeKey(ids[t + k], ids[t + ((k + 1) % 3)]);
      edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1);
    }
  }

  const all: SkinVert[] = [...outer];
  const bands: number[] = borderDist.slice();
  const inset = 0.0006;
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const ia = t + k;
      const ib = t + ((k + 1) % 3);
      const ic = t + ((k + 2) % 3);
      if (ids[ia] === ids[ib]) continue;
      if (edgeUse.get(edgeKey(ids[ia], ids[ib])) !== 1) continue;
      const oa = outer[ia];
      const ob = outer[ib];
      const inner = (i: number): SkinVert => {
        const v = tris[i];
        const id = ids[i];
        return { ...v, x: v.x + dir[id * 3] * inset, y: v.y + dir[id * 3 + 1] * inset, z: v.z + dir[id * 3 + 2] * inset };
      };
      const a0 = inner(ia);
      const b0 = inner(ib);
      // The rim faces away from the triangle's third vertex.
      const mx = (oa.x + ob.x) / 2 - outer[ic].x;
      const my = (oa.y + ob.y) / 2 - outer[ic].y;
      const mz = (oa.z + ob.z) / 2 - outer[ic].z;
      const ex = ob.x - oa.x;
      const ey = ob.y - oa.y;
      const ez = ob.z - oa.z;
      const dx = a0.x - oa.x;
      const dy = a0.y - oa.y;
      const dz = a0.z - oa.z;
      let fx = ey * dz - ez * dy;
      let fy = ez * dx - ex * dz;
      let fz = ex * dy - ey * dx;
      const flip = fx * mx + fy * my + fz * mz < 0;
      if (flip) {
        fx = -fx;
        fy = -fy;
        fz = -fz;
      }
      const len = Math.hypot(fx, fy, fz) || 1;
      const withN = (v: SkinVert): SkinVert => ({ ...v, nx: fx / len, ny: fy / len, nz: fz / len });
      const quad = flip ? [oa, a0, ob, ob, a0, b0] : [oa, ob, a0, ob, b0, a0];
      for (const v of quad) {
        all.push(withN(v));
        bands.push(0);
      }
    }
  }

  const count = all.length;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const v = all[i];
    position.set([v.x, v.y, v.z], i * 3);
    const len = Math.hypot(v.nx, v.ny, v.nz) || 1;
    normal.set([v.nx / len, v.ny / len, v.nz / len], i * 3);
    uvs.set([v.u, v.v], i * 2);
    packSkin(v, skinIndex, skinWeight, i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setAttribute('band', new THREE.Float32BufferAttribute(bands, 1));
  return g;
}

/** Joint positions of a rig in its rest pose (armature space), by bone name. */
export function restJoints(rig: Rig): Map<string, THREE.Vector3> {
  const pose = new Pose(rig.names.length).setRest(rig);
  const out = new Float32Array(rig.names.length * 3);
  poseJoints(pose, rig, out);
  return new Map(rig.names.map((name, i) => [name, new THREE.Vector3(out[i * 3], out[i * 3 + 1], out[i * 3 + 2])]));
}

/** Body landmarks in the T-pose bind pose, read from the rig. */
export interface Landmarks {
  pelvisY: number;
  chestY: number;
  neckY: number;
  shoulderX: number;
  shoulderY: number;
  elbowX: number;
  wristX: number;
  hipX: number;
  kneeY: number;
  ankleY: number;
}

export function landmarks(rig: Rig): Landmarks {
  const j = restJoints(rig);
  const get = (name: string): THREE.Vector3 => {
    const v = j.get(name);
    if (!v) throw new Error(`rig has no ${name}`);
    return v;
  };
  return {
    pelvisY: get('pelvis').y,
    chestY: get('spine_03').y,
    neckY: get('neck_01').y,
    shoulderX: Math.abs(get('upperarm_l').x),
    shoulderY: get('upperarm_l').y,
    elbowX: Math.abs(get('lowerarm_l').x),
    wristX: Math.abs(get('hand_l').x),
    hipX: Math.abs(get('thigh_l').x),
    kneeY: get('calf_l').y,
    ankleY: get('foot_l').y,
  };
}

export type ArmorPiece = 'cuirass' | 'mantle' | 'pauldrons' | 'heavyPauldrons' | 'bracers' | 'greaves' | 'belt' | 'gorget';

/** The plates of the armour kit, as regions of the body. */
export function armorShell(body: THREE.BufferGeometry, piece: ArmorPiece, m: Landmarks): THREE.BufferGeometry {
  switch (piece) {
    case 'cuirass':
      return buildShell(body, {
        planes: [above(m.pelvisY + 0.045), below(m.neckY - 0.004), leftOf(m.shoulderX - 0.022), rightOf(-(m.shoulderX - 0.022))],
        thickness: 0.013,
        rim: 0.009,
        rimWidth: 0.028,
      });
    case 'mantle':
      return buildShell(body, {
        planes: [above(m.chestY - 0.045), below(m.neckY + 0.02), leftOf(m.shoulderX + 0.085), rightOf(-(m.shoulderX + 0.085))],
        thickness: 0.016,
        rim: 0.01,
        rimWidth: 0.03,
      });
    case 'gorget':
      return buildShell(body, {
        planes: [above(m.neckY - 0.035), below(m.neckY + 0.045), leftOf(m.shoulderX - 0.06), rightOf(-(m.shoulderX - 0.06))],
        thickness: 0.02,
        rim: 0.006,
        rimWidth: 0.02,
      });
    case 'pauldrons':
      return buildShell(body, {
        planes: [rightOf(m.shoulderX - 0.03), leftOf(m.shoulderX + 0.115), above(m.shoulderY - 0.078)],
        thickness: 0.022,
        rim: 0.01,
        rimWidth: 0.025,
        mirror: true,
      });
    case 'heavyPauldrons':
      return buildShell(body, {
        planes: [rightOf(m.shoulderX - 0.035), leftOf(m.shoulderX + 0.15), above(m.shoulderY - 0.1)],
        thickness: 0.034,
        rim: 0.012,
        rimWidth: 0.03,
        mirror: true,
      });
    case 'bracers':
      return buildShell(body, {
        planes: [rightOf(m.elbowX + 0.045), leftOf(m.wristX - 0.02)],
        thickness: 0.011,
        rim: 0.007,
        rimWidth: 0.022,
        mirror: true,
      });
    case 'greaves':
      return buildShell(body, {
        planes: [above(m.ankleY + 0.04), below(m.kneeY - 0.015)],
        thickness: 0.012,
        rim: 0.007,
        rimWidth: 0.025,
      });
    case 'belt':
      return buildShell(body, {
        planes: [above(m.pelvisY - 0.005), below(m.pelvisY + 0.062), leftOf(m.shoulderX + 0.1), rightOf(-(m.shoulderX + 0.1))],
        thickness: 0.021,
      });
  }
}

/**
 * Pteruges: a skirt of hanging plates below the belt. Each plate hangs from the pelvis and
 * mostly follows the nearer thigh, so the skirt opens with the stride instead of being pierced.
 */
export function pteruges(body: THREE.BufferGeometry, m: Landmarks, boneIndex: (name: string) => number, length = 0.3, count = 14): THREE.BufferGeometry {
  // Hip outline: widest body radius in each angular sector just below the belt.
  const pos = body.getAttribute('position');
  const sectors = 48;
  const radius = new Float32Array(sectors);
  const y0 = m.pelvisY - 0.03;
  const y1 = m.pelvisY + 0.03;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    if (y < y0 || y > y1 || Math.abs(x) > m.hipX + 0.16) continue;
    const z = pos.getZ(i);
    const a = Math.atan2(x, z);
    const s = Math.floor(((a + Math.PI) / (Math.PI * 2)) * sectors) % sectors;
    radius[s] = Math.max(radius[s], Math.hypot(x, z));
  }
  const radiusAt = (a: number): number => {
    const f = ((a + Math.PI) / (Math.PI * 2)) * sectors;
    const s0 = ((Math.floor(f) % sectors) + sectors) % sectors;
    const s1 = (s0 + 1) % sectors;
    const t = f - Math.floor(f);
    return (radius[s0] || 0.14) * (1 - t) + (radius[s1] || 0.14) * t;
  };

  const pelvis = boneIndex('pelvis');
  const thighL = boneIndex('thigh_l');
  const thighR = boneIndex('thigh_r');
  const top = m.pelvisY + 0.012;
  const positions: number[] = [];
  const normals: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const bandOut: number[] = [];
  const thick = 0.011;
  const rows = 4;

  for (let i = 0; i < count; i++) {
    const a = ((i + 0.5) / count) * Math.PI * 2 - Math.PI;
    const r = radiusAt(a) + 0.024;
    const sx = Math.sin(a);
    const cz = Math.cos(a);
    // Plate width follows the circumference so neighbours nearly touch.
    const half = Math.min(0.06, (Math.PI * r) / count) * 0.92;
    const tx = cz;
    const tz = -sx;
    // Which thigh the plate follows; plates at the very front and back split between both.
    const side = THREE.MathUtils.clamp(sx / 0.35, -1, 1);
    const wl = Math.max(0, side);
    const wr = Math.max(0, -side);
    const centre = 1 - Math.abs(side);

    const ring = (row: number, depth: number): [number, number, number][] => {
      const f = row / rows;
      const y = top - f * length;
      const flare = 0.045 * f * f;
      const taper = 1 - 0.18 * f;
      const rr = r + flare - depth;
      const cx = sx * rr;
      const cz2 = cz * rr;
      return [
        [cx - tx * half * taper, y, cz2 - tz * half * taper],
        [cx + tx * half * taper, y, cz2 + tz * half * taper],
      ];
    };
    const weightsAt = (row: number): { idx: number[]; w: number[] } => {
      const f = THREE.MathUtils.smoothstep(row / rows, 0.05, 1) * 0.8;
      const thigh = f * (1 - centre * 0.45);
      const l = thigh * (wl + centre * 0.5);
      const rgt = thigh * (wr + centre * 0.5);
      return { idx: [pelvis, thighL, thighR, 0], w: [1 - l - rgt, l, rgt, 0] };
    };
    type P3 = [number, number, number];
    const push = (p: P3, nrm: P3, row: number): void => {
      positions.push(...p);
      normals.push(...nrm);
      const s = weightsAt(row);
      skinIndex.push(...s.idx);
      skinWeight.push(...s.w);
      // Distance from the plate's lower edge, scaled so the gilded tip is about twice the band width.
      bandOut.push(((rows - row) / rows) * length * 0.5);
    };
    // Emit a triangle wound so that it faces along `nrm`.
    const tri = (a0: P3, ra: number, b0: P3, rb: number, c0: P3, rc: number, nrm: P3): void => {
      const ux = b0[0] - a0[0];
      const uy = b0[1] - a0[1];
      const uz = b0[2] - a0[2];
      const vx = c0[0] - a0[0];
      const vy = c0[1] - a0[1];
      const vz = c0[2] - a0[2];
      const facing = (uy * vz - uz * vy) * nrm[0] + (uz * vx - ux * vz) * nrm[1] + (ux * vy - uy * vx) * nrm[2];
      push(a0, nrm, ra);
      if (facing >= 0) {
        push(b0, nrm, rb);
        push(c0, nrm, rc);
      } else {
        push(c0, nrm, rc);
        push(b0, nrm, rb);
      }
    };
    // a0,b0 lie on row ra; c0,d0 on row rb.
    const quad = (a0: P3, b0: P3, c0: P3, d0: P3, nrm: P3, ra: number, rb: number): void => {
      tri(a0, ra, b0, ra, c0, rb, nrm);
      tri(b0, ra, d0, rb, c0, rb, nrm);
    };
    const out: [number, number, number] = [sx, 0.12, cz];
    const back: [number, number, number] = [-sx, 0, -cz];
    for (let row = 0; row < rows; row++) {
      const [fl, fr] = ring(row, 0);
      const [fl2, fr2] = ring(row + 1, 0);
      const [bl, br] = ring(row, thick);
      const [bl2, br2] = ring(row + 1, thick);
      quad(fr, fl, fr2, fl2, out, row, row + 1); // front face
      quad(bl, br, bl2, br2, back, row, row + 1); // back face
      quad(fl, bl, fl2, bl2, [-tx, 0, -tz], row, row + 1); // left edge
      quad(br, fr, br2, fr2, [tx, 0, tz], row, row + 1); // right edge
    }
    const [el, er] = ring(rows, 0);
    const [ebl, ebr] = ring(rows, thick);
    quad(er, el, ebr, ebl, [0, -1, 0], rows, rows); // bottom edge
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  g.setAttribute('band', new THREE.Float32BufferAttribute(bandOut, 1));
  return g;
}
