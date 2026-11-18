import * as THREE from 'three';
import { Pose, poseJoints } from '../anim/pose';
import type { Rig } from '../anim/rig';
import { LAYER, REGION, type PiecePart } from './buildPiece';

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
  /**
   * Convex regions cut out of the plate (a neckline, an armhole): the surface inside every
   * half-space of any one set is dropped.
   */
  exclude?: ClipPlane[][];
  /** How far the plate stands off the skin, metres: one value, or a function of the bind-pose position. */
  thickness: number | ((x: number, y: number, z: number) => number);
  /** Extra stand-off at the plate's borders, for a rolled edge. */
  rim?: number;
  /** Width of the rolled edge, metres. */
  rimWidth?: number;
  /** Mirror the region across x = 0 as well (for limbs). */
  mirror?: boolean;
  /** Divides the width of the gilded edge band (2 = half as wide, 0 = no band). */
  bandNarrow?: number;
  /** Passes of smoothing over the offset surface, so cloth does not show every muscle beneath it. */
  smooth?: number;
}

const flipped = (p: ClipPlane): ClipPlane => ({ nx: -p.nx, ny: -p.ny, nz: -p.nz, d: -p.d });

/** Distance from a point to a segment. */
function segmentDistance(px: number, py: number, pz: number, a: SkinVert, b: SkinVert): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const ez = b.z - a.z;
  const len2 = ex * ex + ey * ey + ez * ez;
  const t = len2 < 1e-14 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * ex + (py - a.y) * ey + (pz - a.z) * ez) / len2));
  return Math.hypot(a.x + ex * t - px, a.y + ey * t - py, a.z + ez * t - pz);
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

  const mirrorX = (p: ClipPlane): ClipPlane => ({ nx: -p.nx, ny: p.ny, nz: p.nz, d: p.d });
  const exclude = options.exclude ?? [];
  const planeSets: { planes: ClipPlane[]; exclude: ClipPlane[][] }[] = [{ planes: options.planes, exclude }];
  if (options.mirror) planeSets.push({ planes: options.planes.map(mirrorX), exclude: exclude.map((set) => set.map(mirrorX)) });

  const tris: SkinVert[] = [];
  const borderDist: number[] = [];
  for (const set of planeSets) {
    const { planes } = set;
    for (let t = 0; t < triCount; t++) {
      let poly = [0, 1, 2].map((k) => source(index ? index.getX(t * 3 + k) : t * 3 + k));
      for (const plane of planes) {
        if (poly.length < 3) break;
        poly = clip(poly, plane);
      }
      if (poly.length < 3) continue;
      // Cut-outs: split along every plane of the cut-out (on both sides, so neighbouring
      // triangles still meet edge to edge) and drop the pieces that fall inside it.
      let pieces = [poly];
      for (const hole of set.exclude) {
        for (const plane of hole) {
          const back = flipped(plane);
          pieces = pieces.flatMap((p) => [clip(p, plane), clip(p, back)]).filter((p) => p.length >= 3);
        }
        pieces = pieces.filter((p) => {
          const c = { x: 0, y: 0, z: 0 };
          for (const v of p) {
            c.x += v.x / p.length;
            c.y += v.y / p.length;
            c.z += v.z / p.length;
          }
          return !hole.every((plane) => plane.nx * c.x + plane.ny * c.y + plane.nz * c.z + plane.d >= 0);
        });
      }
      for (const piece of pieces) {
        for (let k = 1; k + 1 < piece.length; k++) {
          for (const v of [piece[0], piece[k], piece[k + 1]]) {
            tris.push(v);
            let d = Infinity;
            for (const plane of planes) d = Math.min(d, dist(plane, v));
            borderDist.push(d);
          }
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

  // Border edges: used by exactly one triangle.
  const edgeUse = new Map<string, number>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const e = edgeKey(ids[t + k], ids[t + ((k + 1) % 3)]);
      edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1);
    }
  }

  // Welded neighbours, for smoothing.
  const neighbours: Set<number>[] = [];
  if (options.smooth) {
    for (let i = 0; i < unique; i++) neighbours.push(new Set<number>());
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = ids[t + k];
        const b = ids[t + ((k + 1) % 3)];
        if (a === b) continue;
        neighbours[a].add(b);
        neighbours[b].add(a);
      }
    }
    // A thick plate magnifies every wobble in the direction it is pushed out along (the
    // slivers left by the clip planes have poor normals), so even those out first.
    const next = new Float32Array(unique * 3);
    for (let pass = 0; pass < 3; pass++) {
      for (let id = 0; id < unique; id++) {
        let x = dir[id * 3] * 2;
        let y = dir[id * 3 + 1] * 2;
        let z = dir[id * 3 + 2] * 2;
        for (const o of neighbours[id]) {
          x += dir[o * 3];
          y += dir[o * 3 + 1];
          z += dir[o * 3 + 2];
        }
        const len = Math.hypot(x, y, z) || 1;
        next[id * 3] = x / len;
        next[id * 3 + 1] = y / len;
        next[id * 3 + 2] = z / len;
      }
      dir.set(next);
    }
  }

  // With cut-outs the border is no longer just the clip planes: measure to the real outline.
  if (exclude.length) {
    const border: [SkinVert, SkinVert][] = [];
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const ia = t + k;
        const ib = t + ((k + 1) % 3);
        if (ids[ia] !== ids[ib] && edgeUse.get(edgeKey(ids[ia], ids[ib])) === 1) border.push([tris[ia], tris[ib]]);
      }
    }
    const byId = new Float32Array(unique).fill(-1);
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      if (byId[id] < 0) {
        const v = tris[i];
        let d = Infinity;
        for (const [a, b] of border) d = Math.min(d, segmentDistance(v.x, v.y, v.z, a, b));
        byId[id] = d;
      }
      borderDist[i] = byId[id];
    }
  }

  /** The planes each vertex of the outline was cut by. */
  const cutPlanes = new Map<number, ClipPlane[]>();
  /** For each vertex of the outline, its neighbours along the outline (as indices into `tris`). */
  const alongOutline = new Map<number, number[]>();
  if (options.smooth) {
    // A thick plate should end in a clean cut: along its outline, push it out within the
    // plane that cut it, so the edge stays straight instead of following every normal.
    // A plane cuts the outline where an edge of the outline lies in it. (A cut-out's planes
    // also pass through the outline elsewhere, where they only split triangles.)
    const cutters = planeSets.flatMap((set) => [...set.planes, ...set.exclude.flat()]);
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const ia = t + k;
        const ib = t + ((k + 1) % 3);
        if (ids[ia] === ids[ib] || edgeUse.get(edgeKey(ids[ia], ids[ib])) !== 1) continue;
        for (const plane of cutters) {
          if (Math.abs(dist(plane, tris[ia])) > 2e-5 || Math.abs(dist(plane, tris[ib])) > 2e-5) continue;
          for (const id of [ids[ia], ids[ib]]) {
            const list = cutPlanes.get(id);
            if (!list) cutPlanes.set(id, [plane]);
            else if (!list.includes(plane)) list.push(plane);
          }
        }
      }
    }
    // The two neighbours of each outline vertex along the outline, to know which way it runs.
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const ia = t + k;
        const ib = t + ((k + 1) % 3);
        if (ids[ia] === ids[ib] || edgeUse.get(edgeKey(ids[ia], ids[ib])) !== 1) continue;
        for (const [from, to] of [
          [ia, ib],
          [ib, ia],
        ]) {
          const list = alongOutline.get(ids[from]);
          if (list) list.push(to);
          else alongOutline.set(ids[from], [to]);
        }
      }
    }
    const seen = new Uint8Array(unique);
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      if (seen[id] || borderDist[i] > 1e-5) continue;
      seen[id] = 1;
      const on = cutPlanes.get(id) ?? [];
      let x = dir[id * 3];
      let y = dir[id * 3 + 1];
      let z = dir[id * 3 + 2];
      for (const plane of on) {
        const along = x * plane.nx + y * plane.ny + z * plane.nz;
        x -= along * plane.nx;
        y -= along * plane.ny;
        z -= along * plane.nz;
      }
      // ...and square to the outline itself, so the edge of the plate is the outline moved
      // out parallel to itself.
      const beside = alongOutline.get(id);
      if (beside?.length === 2 && on.length === 1) {
        // Look a little way along the outline each side: the nearest vertex may be a
        // hair's breadth off, and no guide to its direction.
        const walk = (first: number): SkinVert => {
          let from = id;
          let at = first;
          for (let step = 0; step < 12; step++) {
            const v = tris[at];
            if (Math.hypot(v.x - tris[i].x, v.y - tris[i].y, v.z - tris[i].z) > 0.012) break;
            const onward = alongOutline.get(ids[at]);
            const next = onward?.length === 2 ? onward.find((o) => ids[o] !== from) : undefined;
            if (next === undefined) break;
            from = ids[at];
            at = next;
          }
          return tris[at];
        };
        const a = walk(beside[0]);
        const b = walk(beside[1]);
        let tx = b.x - a.x;
        let ty = b.y - a.y;
        let tz = b.z - a.z;
        const tl = Math.hypot(tx, ty, tz);
        if (tl > 1e-9) {
          tx /= tl;
          ty /= tl;
          tz /= tl;
          const along = x * tx + y * ty + z * tz;
          x -= along * tx;
          y -= along * ty;
          z -= along * tz;
        }
      }
      // Every vertex of the outline is treated alike, or the edge would zigzag between
      // those that were turned and those that were not.
      const len = Math.hypot(x, y, z);
      if (len < 0.05) continue;
      dir[id * 3] = x / len;
      dir[id * 3 + 1] = y / len;
      dir[id * 3 + 2] = z / len;
    }
    // Even the directions out along the outline, each staying in its own cutting plane.
    const evened = new Float32Array(unique * 3);
    for (let pass = 0; pass < 4; pass++) {
      evened.set(dir);
      for (const [id, beside] of alongOutline) {
        if (beside.length !== 2) continue;
        let x = dir[id * 3] * 2;
        let y = dir[id * 3 + 1] * 2;
        let z = dir[id * 3 + 2] * 2;
        for (const o of beside) {
          x += dir[ids[o] * 3];
          y += dir[ids[o] * 3 + 1];
          z += dir[ids[o] * 3 + 2];
        }
        for (const plane of cutPlanes.get(id) ?? []) {
          const along = x * plane.nx + y * plane.ny + z * plane.nz;
          x -= along * plane.nx;
          y -= along * plane.ny;
          z -= along * plane.nz;
        }
        const len = Math.hypot(x, y, z);
        if (len < 0.05) continue;
        evened[id * 3] = x / len;
        evened[id * 3 + 1] = y / len;
        evened[id * 3 + 2] = z / len;
      }
      dir.set(evened);
    }
  }

  const rim = options.rim ?? 0;
  const rimWidth = options.rimWidth ?? 0.03;
  const thicknessAt = options.thickness;
  // Offset per welded vertex, so the plate stays closed across UV seams.
  const offset = new Float32Array(unique * 3);
  const placed = new Uint8Array(unique);
  const onBorder = new Uint8Array(unique);
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    if (placed[id]) continue;
    placed[id] = 1;
    const v = tris[i];
    const edge = 1 - THREE.MathUtils.smoothstep(borderDist[i], 0, rimWidth);
    const off = (typeof thicknessAt === 'number' ? thicknessAt : thicknessAt(v.x, v.y, v.z)) + rim * edge;
    offset[id * 3] = v.x + dir[id * 3] * off;
    offset[id * 3 + 1] = v.y + dir[id * 3 + 1] * off;
    offset[id * 3 + 2] = v.z + dir[id * 3 + 2] * off;
    if (borderDist[i] < 1e-5) onBorder[id] = 1;
  }
  if (options.smooth) {
    // Laplacian smoothing of the offset surface. The outline moves only within the planes
    // that cut it, so it settles with the surface but keeps its shape.
    const next = new Float32Array(unique * 3);
    for (let pass = 0; pass < options.smooth; pass++) {
      for (let id = 0; id < unique; id++) {
        const around = neighbours[id];
        const planes = onBorder[id] ? cutPlanes.get(id) : undefined;
        if ((onBorder[id] && !planes?.length) || around.size === 0) {
          next.set(offset.subarray(id * 3, id * 3 + 3), id * 3);
          continue;
        }
        let x = 0;
        let y = 0;
        let z = 0;
        for (const o of around) {
          x += offset[o * 3];
          y += offset[o * 3 + 1];
          z += offset[o * 3 + 2];
        }
        let dx = (x / around.size - offset[id * 3]) * 0.5;
        let dy = (y / around.size - offset[id * 3 + 1]) * 0.5;
        let dz = (z / around.size - offset[id * 3 + 2]) * 0.5;
        for (const plane of planes ?? []) {
          const along = dx * plane.nx + dy * plane.ny + dz * plane.nz;
          dx -= along * plane.nx;
          dy -= along * plane.ny;
          dz -= along * plane.nz;
        }
        next[id * 3] = offset[id * 3] + dx;
        next[id * 3 + 1] = offset[id * 3 + 1] + dy;
        next[id * 3 + 2] = offset[id * 3 + 2] + dz;
      }
      offset.set(next);
    }
    // Then along the outline alone, to take out the kinks left where it crosses a groove
    // in the body (the spine, the breastbone) and the plate folds over itself.
    for (let pass = 0; pass < 4; pass++) {
      next.set(offset);
      for (const [id, beside] of alongOutline) {
        const planes = cutPlanes.get(id);
        if (beside.length !== 2 || !planes?.length) continue;
        const a = ids[beside[0]] * 3;
        const b = ids[beside[1]] * 3;
        let dx = ((offset[a] + offset[b]) / 2 - offset[id * 3]) * 0.5;
        let dy = ((offset[a + 1] + offset[b + 1]) / 2 - offset[id * 3 + 1]) * 0.5;
        let dz = ((offset[a + 2] + offset[b + 2]) / 2 - offset[id * 3 + 2]) * 0.5;
        for (const plane of planes) {
          const along = dx * plane.nx + dy * plane.ny + dz * plane.nz;
          dx -= along * plane.nx;
          dy -= along * plane.ny;
          dz -= along * plane.nz;
        }
        next[id * 3] = offset[id * 3] + dx;
        next[id * 3 + 1] = offset[id * 3 + 1] + dy;
        next[id * 3 + 2] = offset[id * 3 + 2] + dz;
      }
      offset.set(next);
    }
    // Normals of the smoothed surface.
    dir.fill(0);
    for (let t = 0; t < n; t += 3) {
      const a = ids[t] * 3;
      const b = ids[t + 1] * 3;
      const c = ids[t + 2] * 3;
      const ux = offset[b] - offset[a];
      const uy = offset[b + 1] - offset[a + 1];
      const uz = offset[b + 2] - offset[a + 2];
      const vx = offset[c] - offset[a];
      const vy = offset[c + 1] - offset[a + 1];
      const vz = offset[c + 2] - offset[a + 2];
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      for (const id of [a, b, c]) {
        dir[id] += fx;
        dir[id + 1] += fy;
        dir[id + 2] += fz;
      }
    }
    for (let i = 0; i < unique; i++) {
      const len = Math.hypot(dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2]) || 1;
      dir[i * 3] /= len;
      dir[i * 3 + 1] /= len;
      dir[i * 3 + 2] /= len;
    }
  }
  const outer: SkinVert[] = tris.map((v, i) => {
    const id = ids[i];
    return { ...v, x: offset[id * 3], y: offset[id * 3 + 1], z: offset[id * 3 + 2], nx: dir[id * 3], ny: dir[id * 3 + 1], nz: dir[id * 3 + 2] };
  });

  const all: SkinVert[] = [...outer];
  const narrow = options.bandNarrow ?? 1;
  // A band distance of 1 m is "no band" to the shader.
  const bands: number[] = borderDist.map((d) => (narrow > 0 ? d * narrow : 1));
  const inset = 0.0006;
  // The wall round the edge of a thick plate is wide enough to show its facets: shade it smoothly.
  const wallNormal = options.smooth ? new Float32Array(unique * 3) : null;
  const walls: { quad: SkinVert[]; ids: number[]; n: [number, number, number] }[] = [];
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
      const ex = ob.x - oa.x;
      const ey = ob.y - oa.y;
      const ez = ob.z - oa.z;
      // The rim faces out of the plate: to the right of the edge as its triangle winds,
      // seen from outside. (The triangle's third vertex is no guide: clipping leaves
      // slivers whose third vertex all but lies on the edge.)
      const ux = dir[ids[ia] * 3] + dir[ids[ib] * 3];
      const uy = dir[ids[ia] * 3 + 1] + dir[ids[ib] * 3 + 1];
      const uz = dir[ids[ia] * 3 + 2] + dir[ids[ib] * 3 + 2];
      let mx = ey * uz - ez * uy;
      let my = ez * ux - ex * uz;
      let mz = ex * uy - ey * ux;
      if (mx * mx + my * my + mz * mz < 1e-16) {
        mx = (oa.x + ob.x) / 2 - outer[ic].x;
        my = (oa.y + ob.y) / 2 - outer[ic].y;
        mz = (oa.z + ob.z) / 2 - outer[ic].z;
      }
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
      const quad = flip ? [oa, a0, ob, ob, a0, b0] : [oa, ob, a0, ob, b0, a0];
      const ida = ids[ia];
      const idb = ids[ib];
      walls.push({ quad, ids: flip ? [ida, ida, idb, idb, ida, idb] : [ida, idb, ida, idb, idb, ida], n: [fx / len, fy / len, fz / len] });
      if (wallNormal) {
        for (const id of [ida, idb]) {
          wallNormal[id * 3] += fx / len;
          wallNormal[id * 3 + 1] += fy / len;
          wallNormal[id * 3 + 2] += fz / len;
        }
      }
    }
  }
  for (const wall of walls) {
    wall.quad.forEach((v, k) => {
      const id = wall.ids[k];
      const nrm = wallNormal ? [wallNormal[id * 3], wallNormal[id * 3 + 1], wallNormal[id * 3 + 2]] : wall.n;
      all.push({ ...v, nx: nrm[0], ny: nrm[1], nz: nrm[2] });
      bands.push(narrow > 0 ? 0 : 1);
    });
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
  /** Middle of the spine (spine_02). */
  waistY: number;
  chestY: number;
  neckY: number;
  /** The joint the head turns about. */
  headY: number;
  /** Where the neck stands, front to back. */
  neckZ: number;
  shoulderX: number;
  shoulderY: number;
  elbowX: number;
  wristX: number;
  hipX: number;
  kneeY: number;
  ankleY: number;
  /** How far forward the joint is that the toes bend at. */
  ballZ: number;
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
    waistY: get('spine_02').y,
    chestY: get('spine_03').y,
    neckY: get('neck_01').y,
    headY: get('head').y,
    neckZ: get('neck_01').z,
    shoulderX: Math.abs(get('upperarm_l').x),
    shoulderY: get('upperarm_l').y,
    elbowX: Math.abs(get('lowerarm_l').x),
    wristX: Math.abs(get('hand_l').x),
    hipX: Math.abs(get('thigh_l').x),
    kneeY: get('calf_l').y,
    ankleY: get('foot_l').y,
    ballZ: get('ball_l').z,
  };
}

export type ArmorPiece =
  | 'cuirass'
  | 'pauldrons'
  | 'heavyPauldrons'
  | 'bracers'
  | 'greaves'
  | 'belt'
  | 'gorget'
  // Heavy plate, all metal (the rook).
  | 'breastplate'
  | 'plateCollar'
  | 'platePauldrons'
  | 'gauntlets'
  | 'boots'
  // Vestments (the bishop).
  | 'vestment'
  | 'cincture'
  // Wrapped clothes (the knight).
  | 'gi'
  | 'sash'
  | 'trousers'
  | 'armWraps'
  | 'legWraps'
  | 'collar'
  // The strap a shield hangs from (the queen).
  | 'baldric';

/** A plane containing the front-to-back axis, through two points of the front view; `inside` is a point on the side to keep. */
function through(x1: number, y1: number, x2: number, y2: number, insideX: number, insideY: number): ClipPlane {
  let nx = y2 - y1;
  let ny = x1 - x2;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  let d = -(nx * x1 + ny * y1);
  if (nx * insideX + ny * insideY + d < 0) {
    nx = -nx;
    ny = -ny;
    d = -d;
  }
  return { nx, ny, nz: 0, d };
}

/**
 * An upright prism round the neck: the hole a neck comes through, wider across the shoulders
 * (`across`) than front to back (`deep`). Convex, so it can be cut out of a plate. Only its
 * sides should meet the body's surface (its floor is set well down inside the chest), so the
 * neckline it leaves dips at the throat and rides up over the shoulders.
 */
function neckHole(m: Landmarks, across: number, deep: number, sides = 12): ClipPlane[] {
  const cz = m.neckZ + 0.005;
  const planes: ClipPlane[] = [above(m.neckY - 0.12)];
  for (let k = 0; k < sides; k++) {
    const a = ((k + 0.5) / sides) * Math.PI * 2;
    // Tangent plane of the ellipse whose outward normal points along `a`.
    const reach = Math.hypot(across * Math.cos(a), deep * Math.sin(a));
    planes.push({ nx: -Math.cos(a), ny: 0, nz: -Math.sin(a), d: reach + Math.sin(a) * cz });
  }
  return planes;
}

/** A plate cut from the body surface. */
function shell(body: THREE.BufferGeometry, layer: number, region: number, options: ShellOptions): PiecePart {
  return { geometry: buildShell(body, options), layer, region };
}

/**
 * The parts of one item of the armour kit, as regions of the body. Stone plates carry the
 * body's own carved detail; metal plate and cloth are smooth.
 */
export function armorParts(body: THREE.BufferGeometry, piece: ArmorPiece, m: Landmarks, bodyLayer: number): PiecePart[] {
  const plate = (options: ShellOptions): PiecePart[] => [shell(body, bodyLayer, REGION.plate, options)];
  const metal = (options: ShellOptions): PiecePart[] => [shell(body, LAYER.flat, REGION.trim, options)];
  const cloth = (options: ShellOptions): PiecePart[] => [shell(body, LAYER.flat, REGION.plate, options)];
  // Heavy plate in the army's stone, smooth, with a broad metal border.
  const heavy = (options: ShellOptions): PiecePart[] => [shell(body, LAYER.flat, REGION.plate, { bandNarrow: 0.5, ...options })];
  const torso = [leftOf(m.shoulderX - 0.022), rightOf(-(m.shoulderX - 0.022))];
  switch (piece) {
    case 'cuirass':
      return plate({ planes: [above(m.pelvisY + 0.045), below(m.neckY - 0.004), ...torso], thickness: 0.013, rim: 0.009, rimWidth: 0.028 });
    case 'gorget':
      return plate({ planes: [above(m.neckY - 0.035), below(m.neckY + 0.045), leftOf(m.shoulderX - 0.06), rightOf(-(m.shoulderX - 0.06))], thickness: 0.02, rim: 0.006, rimWidth: 0.02 });
    case 'pauldrons':
      return plate({ planes: [rightOf(m.shoulderX - 0.03), leftOf(m.shoulderX + 0.115), above(m.shoulderY - 0.078)], thickness: 0.022, rim: 0.01, rimWidth: 0.025, mirror: true });
    case 'heavyPauldrons':
      return plate({ planes: [rightOf(m.shoulderX - 0.035), leftOf(m.shoulderX + 0.15), above(m.shoulderY - 0.1)], thickness: 0.034, rim: 0.012, rimWidth: 0.03, mirror: true });
    case 'bracers':
      return plate({ planes: [rightOf(m.elbowX + 0.045), leftOf(m.wristX - 0.02)], thickness: 0.011, rim: 0.007, rimWidth: 0.022, mirror: true });
    case 'greaves':
      return plate({ planes: [above(m.ankleY + 0.04), below(m.kneeY - 0.015)], thickness: 0.012, rim: 0.007, rimWidth: 0.025 });
    case 'belt':
      return plate({ planes: [above(m.pelvisY - 0.005), below(m.pelvisY + 0.062), leftOf(m.shoulderX + 0.1), rightOf(-(m.shoulderX + 0.1))], thickness: 0.021 });

    // ------------------------------------------------------------ heavy plate
    case 'breastplate': {
      // A thick breast and back plate with a round neck, and a second plate lapped over the
      // belly: the layers are what make it read as heavy.
      const neck = neckHole(m, 0.142, 0.116);
      return [
        ...heavy({ planes: [above(m.pelvisY + 0.04), below(m.neckY + 0.035), ...torso], exclude: [neck], thickness: 0.03, rim: 0.012, rimWidth: 0.034, smooth: 5 }),
        ...heavy({ planes: [above(m.pelvisY + 0.05), below(m.waistY + 0.03), ...torso], thickness: 0.043, rim: 0.007, rimWidth: 0.02, smooth: 2 }),
      ];
    }
    case 'plateCollar':
      // A standing collar round the neck opening of the breastplate.
      return metal({
        planes: [above(m.neckY - 0.075), below(m.neckY + 0.035), leftOf(0.165), rightOf(-0.165)],
        exclude: [neckHole(m, 0.122, 0.096)],
        thickness: 0.044,
        rim: 0.01,
        rimWidth: 0.024,
        smooth: 6,
      });
    case 'platePauldrons':
      return [
        ...heavy({ planes: [rightOf(m.shoulderX - 0.035), leftOf(m.shoulderX + 0.17), above(m.shoulderY - 0.09)], thickness: 0.044, rim: 0.012, rimWidth: 0.03, mirror: true, smooth: 2 }),
        // A second lame over the top of the shoulder.
        ...heavy({ planes: [rightOf(m.shoulderX - 0.05), leftOf(m.shoulderX + 0.08), above(m.shoulderY - 0.02)], thickness: 0.06, rim: 0.008, rimWidth: 0.02, mirror: true, smooth: 2 }),
      ];
    case 'gauntlets': {
      // A flared cuff at the elbow end, narrowing to the wrist.
      const from = m.elbowX + 0.03;
      const to = m.wristX - 0.012;
      return metal({
        planes: [rightOf(from), leftOf(to)],
        thickness: (x) => 0.016 + 0.016 * (1 - THREE.MathUtils.smoothstep(Math.abs(x), from, from + 0.07)),
        rim: 0.008,
        rimWidth: 0.022,
        mirror: true,
        smooth: 1,
      });
    }
    case 'boots': {
      // Shaft from under the knee to the sole, thick at the turned-down cuff and over the ankle.
      const top = m.kneeY - 0.035;
      return [
        ...metal({
          planes: [above(0.024), below(top), behind(m.ballZ + 0.03)],
          thickness: (_x, y) => 0.024 + 0.02 * THREE.MathUtils.smoothstep(y, top - 0.075, top - 0.045) + 0.01 * (1 - THREE.MathUtils.smoothstep(y, m.ankleY + 0.02, m.ankleY + 0.1)),
          rim: 0.01,
          rimWidth: 0.02,
          smooth: 1,
        }),
        // Knee plate.
        ...metal({ planes: [above(m.kneeY - 0.07), below(m.kneeY + 0.075), inFrontOf(-0.045)], thickness: 0.04, rim: 0.008, rimWidth: 0.025, smooth: 1 }),
      ];
    }

    // ------------------------------------------------------------ vestments
    case 'vestment': {
      // A long-sleeved robe: close at the shoulder, widening to a bell at the wrist.
      const cuff = m.wristX - 0.03;
      const robe = buildShell(body, {
        planes: [above(m.pelvisY + 0.03), below(m.neckY + 0.035), leftOf(cuff), rightOf(-cuff)],
        exclude: [neckHole(m, 0.134, 0.09)],
        thickness: (x) => 0.03 + 0.016 * THREE.MathUtils.smoothstep(Math.abs(x), m.shoulderX - 0.04, m.shoulderX + 0.1) + 0.022 * THREE.MathUtils.smoothstep(Math.abs(x), m.shoulderX + 0.1, cuff),
        rim: 0.004,
        rimWidth: 0.02,
        smooth: 12,
      });
      // The cross on the back is raised from the robe itself, so it follows every fold of it.
      const armY = m.chestY + 0.03;
      const bar = 0.032;
      const arm = 0.14;
      const cross = buildShell(robe, {
        planes: [behind(-0.02), above(m.pelvisY + 0.075), below(armY + bar + 0.085), leftOf(arm), rightOf(-arm)],
        exclude: [
          [rightOf(bar), above(armY + bar)],
          [leftOf(-bar), above(armY + bar)],
          [rightOf(bar), below(armY - bar)],
          [leftOf(-bar), below(armY - bar)],
        ],
        thickness: 0.009,
        smooth: 1,
      });
      return [
        { geometry: robe, layer: LAYER.flat, region: REGION.plate },
        { geometry: cross, layer: LAYER.flat, region: REGION.trim },
      ];
    }
    case 'cincture':
      return metal({ planes: [above(m.pelvisY - 0.005), below(m.pelvisY + 0.05), leftOf(m.shoulderX + 0.1), rightOf(-(m.shoulderX + 0.1))], thickness: 0.036, smooth: 5 });

    // ------------------------------------------------------------ wrapped clothes
    case 'gi': {
      // A short-sleeved jacket crossed over at the front: a V at the neck, and the edge of
      // the upper flap running on down to the opposite hip.
      const sleeve = m.elbowX - 0.075;
      const neck = m.neckY + 0.004;
      const apexY = m.chestY + 0.055;
      const apexX = -0.012;
      const side = 0.082;
      const jacket = buildShell(body, {
        planes: [above(m.pelvisY + 0.04), below(neck), leftOf(sleeve), rightOf(-sleeve)],
        exclude: [[inFrontOf(m.neckZ + 0.03), through(side, neck, apexX, apexY, 0, neck), through(-side, neck, apexX, apexY, 0, neck)]],
        thickness: 0.013,
        rim: 0.006,
        rimWidth: 0.018,
        smooth: 1,
      });
      // The flap's edge: a band continuing the left side of the V down across the body.
      const dx = apexX - side;
      const dy = apexY - neck;
      const endY = m.pelvisY + 0.05;
      const endX = side + (dx * (endY - neck)) / dy;
      const half = 0.011;
      const nx = -dy / Math.hypot(dx, dy);
      const ny = dx / Math.hypot(dx, dy);
      const flap = buildShell(jacket, {
        planes: [
          inFrontOf(m.neckZ + 0.03),
          below(apexY + 0.012),
          above(endY),
          through(side + nx * half, neck + ny * half, endX + nx * half, endY + ny * half, side, neck),
          through(side - nx * half, neck - ny * half, endX - nx * half, endY - ny * half, side, neck),
        ],
        thickness: 0.005,
      });
      return [
        { geometry: jacket, layer: LAYER.flat, region: REGION.plate },
        { geometry: flap, layer: LAYER.flat, region: REGION.trim },
      ];
    }
    case 'sash':
      return cloth({ planes: [above(m.pelvisY - 0.012), below(m.pelvisY + 0.078), leftOf(m.shoulderX + 0.1), rightOf(-(m.shoulderX + 0.1))], thickness: 0.026, bandNarrow: 0, smooth: 1 });
    case 'trousers':
      // Loose in the thigh, gathered into the bindings below the knee.
      return cloth({
        planes: [below(m.pelvisY + 0.02), above(m.kneeY - 0.075)],
        thickness: (_x, y) => 0.013 + 0.022 * THREE.MathUtils.smoothstep(y, m.kneeY - 0.075, m.kneeY + 0.09),
        bandNarrow: 0,
        smooth: 4,
      });
    case 'armWraps': {
      // Bindings from wrist to elbow: lapped bands, each thicker at its upper edge.
      const from = m.elbowX + 0.035;
      const to = m.wristX - 0.012;
      const count = 5;
      const width = (to - from) / count;
      const out: PiecePart[] = [];
      for (let i = 0; i < count; i++) {
        const x0 = from + i * width;
        out.push(...cloth({ planes: [rightOf(x0), leftOf(x0 + width)], thickness: (x) => 0.013 - 0.007 * ((Math.abs(x) - x0) / width), bandNarrow: 0, mirror: true }));
      }
      return out;
    }
    case 'legWraps': {
      const from = m.kneeY - 0.045;
      const to = m.ankleY + 0.012;
      const count = 7;
      const height = (from - to) / count;
      const out: PiecePart[] = [];
      for (let i = 0; i < count; i++) {
        const y1 = from - i * height;
        out.push(...cloth({ planes: [below(y1), above(y1 - height)], thickness: (_x, y) => 0.014 - 0.008 * ((y1 - y) / height), bandNarrow: 0 }));
      }
      // The foot is bound too, down to the sole.
      out.push(...cloth({ planes: [below(to), above(0.02)], thickness: 0.008, bandNarrow: 0 }));
      return out;
    }
    case 'collar':
      return metal({ planes: [above(m.neckY - 0.05), below(m.neckY + 0.03), leftOf(m.shoulderX - 0.045), rightOf(-(m.shoulderX - 0.045))], thickness: 0.022, rim: 0.008, rimWidth: 0.02, smooth: 1 });

    // ------------------------------------------------------------ strap
    case 'baldric': {
      // From the right shoulder to the left hip, over the cuirass.
      const x1 = -(m.shoulderX - 0.07);
      const y1 = m.neckY + 0.02;
      const x2 = m.hipX + 0.03;
      const y2 = m.pelvisY + 0.07;
      const half = 0.019;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const nx = -(y2 - y1) / len;
      const ny = (x2 - x1) / len;
      return metal({
        planes: [
          above(m.pelvisY + 0.062),
          leftOf(m.shoulderX - 0.03),
          rightOf(-(m.shoulderX - 0.03)),
          through(x1 + nx * half, y1 + ny * half, x2 + nx * half, y2 + ny * half, x1, y1),
          through(x1 - nx * half, y1 - ny * half, x2 - nx * half, y2 - ny * half, x1, y1),
        ],
        thickness: 0.031,
        smooth: 1,
      });
    }
  }
}

/**
 * The body with part of it cut cleanly away: everything on the far side of `keep` among the
 * triangles `within` selects (by centroid). Used to take the head off at the neck. Skin
 * weights are interpolated along the cut, and the result stays indexed.
 */
export function cutAway(body: THREE.BufferGeometry, keep: ClipPlane, within: (x: number, y: number, z: number) => boolean): THREE.BufferGeometry {
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

  const verts: SkinVert[] = [];
  const remap = new Map<number, number>();
  const original = (i: number): number => {
    let id = remap.get(i);
    if (id === undefined) {
      id = verts.length;
      verts.push(source(i));
      remap.set(i, id);
    }
    return id;
  };
  // One new vertex per cut edge, shared by the triangles on either side of it.
  const cuts = new Map<string, number>();
  const cutVertex = (a: number, b: number): number => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let id = cuts.get(key);
    if (id === undefined) {
      const lo = source(Math.min(a, b));
      const hi = source(Math.max(a, b));
      const dl = dist(keep, lo);
      const dh = dist(keep, hi);
      id = verts.length;
      verts.push(lerpVert(lo, hi, dl / (dl - dh)));
      cuts.set(key, id);
    }
    return id;
  };

  const out: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const tri = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
    const cx = (pos.getX(tri[0]) + pos.getX(tri[1]) + pos.getX(tri[2])) / 3;
    const cy = (pos.getY(tri[0]) + pos.getY(tri[1]) + pos.getY(tri[2])) / 3;
    const cz = (pos.getZ(tri[0]) + pos.getZ(tri[1]) + pos.getZ(tri[2])) / 3;
    if (!within(cx, cy, cz)) {
      out.push(original(tri[0]), original(tri[1]), original(tri[2]));
      continue;
    }
    const inside = tri.map((i) => keep.nx * pos.getX(i) + keep.ny * pos.getY(i) + keep.nz * pos.getZ(i) + keep.d >= 0);
    const count = inside.filter(Boolean).length;
    if (count === 0) continue;
    if (count === 3) {
      out.push(original(tri[0]), original(tri[1]), original(tri[2]));
      continue;
    }
    const poly: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      if (inside[k]) poly.push(original(a));
      if (inside[k] !== inside[(k + 1) % 3]) poly.push(cutVertex(a, b));
    }
    for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
  }

  const n = verts.length;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = verts[i];
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
  g.setIndex(out);
  return g;
}

export interface DrapeOptions {
  /** Length below the belt line, metres. */
  length: number;
  /**
   * The spans of the circle the cloth covers, radians: 0 is the front, positive towards the
   * statue's left. Default: all the way round. Gaps between spans are slits.
   */
  spans?: [number, number][];
  /** How far the hem swings out beyond a straight fall, metres. */
  flare?: number;
  /** Clearance from the body, metres. */
  standoff?: number;
  /** Number of folds round the whole circle, and how deep they are at the hem, metres. */
  folds?: number;
  foldDepth?: number;
  /** How far the cloth below the knee goes with the shin instead of the thigh, 0..1. */
  shin?: number;
  /** Thickness of the cloth, metres. */
  thickness?: number;
  /** Width of the gilded band along the hem and the slits, metres (0 for none). */
  hem?: number;
}

/**
 * Hanging cloth below the belt: a robe, or the tails of a jacket. It falls from the widest
 * part of the body above each point (as cloth does), in carved folds, and follows the legs:
 * mostly the nearer thigh, and below the knee the shin, so a stride pushes it out and a
 * raised knee lifts it, without the leg coming through.
 */
export function drape(body: THREE.BufferGeometry, m: Landmarks, boneIndex: (name: string) => number, options: DrapeOptions): THREE.BufferGeometry {
  const length = options.length;
  const flare = options.flare ?? 0.06;
  const standoff = options.standoff ?? 0.026;
  const folds = options.folds ?? 0;
  const foldDepth = options.foldDepth ?? 0.012;
  const shin = options.shin ?? 0.55;
  const thick = options.thickness ?? 0.012;
  const hem = options.hem ?? 0.012;
  const spans = options.spans ?? [[-Math.PI, Math.PI]];
  const whole = !options.spans;

  const top = m.pelvisY + 0.012;
  const rows = Math.max(3, Math.round(length / 0.035));
  const rowHeight = length / rows;
  const sectors = 72;

  // The envelope of the body in each direction, at the belt and then never narrowing downwards.
  const pos = body.getAttribute('position');
  const envelope = new Float32Array((rows + 1) * sectors);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    if (y > top + 0.03 || y < top - length - 0.02 || Math.abs(x) > m.hipX + 0.16) continue;
    const z = pos.getZ(i);
    const s = Math.floor(((Math.atan2(x, z) + Math.PI) / (Math.PI * 2)) * sectors) % sectors;
    const r = Math.hypot(x, z);
    const row = Math.min(rows, Math.max(0, Math.round((top - y) / rowHeight)));
    if (r > envelope[row * sectors + s]) envelope[row * sectors + s] = r;
  }
  for (let row = 0; row <= rows; row++) {
    for (let s = 0; s < sectors; s++) {
      const at = row * sectors + s;
      if (row > 0) envelope[at] = Math.max(envelope[at], envelope[at - sectors]);
      if (envelope[at] === 0) envelope[at] = 0.14;
    }
  }
  // Round off the outline so the cloth does not show every sector.
  const blurred = new Float32Array(envelope.length);
  for (let pass = 0; pass < 10; pass++) {
    for (let row = 0; row <= rows; row++) {
      for (let s = 0; s < sectors; s++) {
        const at = row * sectors;
        const a = envelope[at + ((s + sectors - 1) % sectors)];
        const b = envelope[at + s];
        const c = envelope[at + ((s + 1) % sectors)];
        // Never inside the body: the blur may only push outwards.
        blurred[at + s] = Math.max(b, (a + 2 * b + c) / 4);
      }
    }
    envelope.set(blurred);
  }
  const radiusAt = (angle: number, row: number): number => {
    const f = ((angle + Math.PI) / (Math.PI * 2)) * sectors - 0.5;
    const s0 = ((Math.floor(f) % sectors) + sectors) % sectors;
    const s1 = (s0 + 1) % sectors;
    const t = f - Math.floor(f);
    const k = row / rows;
    const r0 = Math.min(rows, Math.max(0, Math.floor(row)));
    const r1 = Math.min(rows, r0 + 1);
    const u = Math.min(1, Math.max(0, row - r0));
    const along = (r: number): number => envelope[r * sectors + s0] * (1 - t) + envelope[r * sectors + s1] * t;
    const base = along(r0) * (1 - u) + along(r1) * u;
    // Close to the body where it is gathered under the belt, standing off below.
    const gather = 0.3 + 0.7 * THREE.MathUtils.smoothstep(row * rowHeight, 0, 0.09);
    return base + standoff * gather + flare * k * k + (folds ? foldDepth * k * (0.5 + 0.5 * Math.cos(folds * angle)) : 0);
  };

  const pelvis = boneIndex('pelvis');
  const thighL = boneIndex('thigh_l');
  const thighR = boneIndex('thigh_r');
  const calfL = boneIndex('calf_l');
  const calfR = boneIndex('calf_r');

  const positions: number[] = [];
  const normals: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const bandOut: number[] = [];
  type P3 = [number, number, number];

  const weightsAt = (angle: number, row: number): { idx: number[]; w: number[] } => {
    const below = row * rowHeight;
    const y = top - below;
    const legs = THREE.MathUtils.smoothstep(below, 0.03, 0.34) * 0.86;
    const side = THREE.MathUtils.clamp(Math.sin(angle) / 0.35, -1, 1);
    const centre = 1 - Math.abs(side);
    const share = legs * (1 - centre * 0.45);
    const l = share * (Math.max(0, side) + centre * 0.5);
    const r = share * (Math.max(0, -side) + centre * 0.5);
    // Below the knee the cloth on one side goes with that leg's shin; between the legs it
    // does not, which also keeps every point to four bones.
    const c = THREE.MathUtils.smoothstep(m.kneeY + 0.04 - y, 0, 0.3) * shin * THREE.MathUtils.smoothstep(Math.abs(side), 0, 0.6);
    const left = side >= 0;
    const near = left ? l : r;
    return {
      idx: [pelvis, thighL, thighR, left ? calfL : calfR],
      w: [1 - l - r, left ? l * (1 - c) : l, left ? r : r * (1 - c), near * c],
    };
  };

  for (const [a0, a1] of spans) {
    const columns = Math.max(2, Math.round(((a1 - a0) / (Math.PI * 2)) * 96));
    const angleAt = (c: number): number => a0 + ((a1 - a0) * c) / columns;
    const point = (c: number, row: number, depth: number): P3 => {
      const a = angleAt(c);
      const r = radiusAt(a, row) - depth;
      return [Math.sin(a) * r, top - row * rowHeight, Math.cos(a) * r];
    };
    // Outward normal of the cloth at a grid point, from its neighbours.
    const normalAt = (c: number, row: number): P3 => {
      const p0 = point(c - 0.5, row, 0);
      const p1 = point(c + 0.5, row, 0);
      const q0 = point(c, Math.max(0, row - 0.5), 0);
      const q1 = point(c, Math.min(rows, row + 0.5), 0);
      const ux = p1[0] - p0[0];
      const uy = p1[1] - p0[1];
      const uz = p1[2] - p0[2];
      const vx = q1[0] - q0[0];
      const vy = q1[1] - q0[1];
      const vz = q1[2] - q0[2];
      // Columns run towards the statue's left and rows downwards, so this points outwards.
      let nx = uz * vy - uy * vz;
      let ny = ux * vz - uz * vx;
      let nz = uy * vx - ux * vy;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const a = angleAt(c);
      if (nx * Math.sin(a) + nz * Math.cos(a) < 0) return [-nx, -ny, -nz];
      return [nx, ny, nz];
    };
    const bandAt = (c: number, row: number): number => {
      if (hem <= 0) return 1;
      let d = (rows - row) * rowHeight;
      if (!whole) {
        const r = radiusAt(angleAt(c), row);
        d = Math.min(d, ((a1 - a0) * Math.min(c, columns - c) * r) / columns);
      }
      // The shader gilds where this is below the stone look's band width (about 11 mm).
      return (d * 0.011) / hem;
    };
    const push = (p: P3, nrm: P3, c: number, row: number, band = bandAt(c, row)): void => {
      positions.push(...p);
      normals.push(...nrm);
      const s = weightsAt(angleAt(c), row);
      skinIndex.push(...s.idx);
      skinWeight.push(...s.w);
      bandOut.push(band);
    };
    const flip = (n: P3): P3 => [-n[0], -n[1], -n[2]];
    for (let c = 0; c < columns; c++) {
      for (let row = 0; row < rows; row++) {
        const n00 = normalAt(c, row);
        const n10 = normalAt(c + 1, row);
        const n01 = normalAt(c, row + 1);
        const n11 = normalAt(c + 1, row + 1);
        // Outer face.
        push(point(c, row, 0), n00, c, row);
        push(point(c, row + 1, 0), n01, c, row + 1);
        push(point(c + 1, row, 0), n10, c + 1, row);
        push(point(c + 1, row, 0), n10, c + 1, row);
        push(point(c, row + 1, 0), n01, c, row + 1);
        push(point(c + 1, row + 1, 0), n11, c + 1, row + 1);
        // Inner face.
        push(point(c, row, thick), flip(n00), c, row, 1);
        push(point(c + 1, row, thick), flip(n10), c + 1, row, 1);
        push(point(c, row + 1, thick), flip(n01), c, row + 1, 1);
        push(point(c + 1, row, thick), flip(n10), c + 1, row, 1);
        push(point(c + 1, row + 1, thick), flip(n11), c + 1, row + 1, 1);
        push(point(c, row + 1, thick), flip(n01), c, row + 1, 1);
      }
      // The hem's lower edge.
      const down: P3 = [0, -1, 0];
      push(point(c, rows, 0), down, c, rows);
      push(point(c, rows, thick), down, c, rows);
      push(point(c + 1, rows, 0), down, c + 1, rows);
      push(point(c + 1, rows, 0), down, c + 1, rows);
      push(point(c, rows, thick), down, c, rows);
      push(point(c + 1, rows, thick), down, c + 1, rows);
    }
    if (!whole) {
      // The edges of a slit.
      for (const [c, sign] of [
        [0, -1],
        [columns, 1],
      ] as const) {
        const a = angleAt(c);
        const edge: P3 = [Math.cos(a) * sign, 0, -Math.sin(a) * sign];
        for (let row = 0; row < rows; row++) {
          const o0 = point(c, row, 0);
          const o1 = point(c, row + 1, 0);
          const i0 = point(c, row, thick);
          const i1 = point(c, row + 1, thick);
          const quad = sign > 0 ? [o0, o1, i0, i0, o1, i1] : [o0, i0, o1, o1, i0, i1];
          const at = [row, row + 1, row, row, row + 1, row + 1];
          const atFlipped = [row, row, row + 1, row + 1, row, row + 1];
          quad.forEach((p, k) => push(p, edge, c, (sign > 0 ? at : atFlipped)[k]));
        }
      }
    }
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
