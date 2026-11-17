import { Rng } from '../core/math';

/**
 * Pre-fracture of a statue, done once per design in bind pose.
 *
 * The body surface is partitioned into connected chunks (a geodesic Voronoi over triangle
 * adjacency, so a chunk never bridges two limbs), every chunk is closed with interior faces so
 * it reads as solid stone, and loose parts (armour plates, hair, skirt plates) ride on the
 * chunk beneath them. The statue is always rendered from this geometry: alive, only the
 * surface triangles are drawn; shattering just switches on the interior faces and moves each
 * chunk by its own rigid matrix in the vertex shader. Nothing is rebuilt on the impact frame.
 */

export interface MeshData {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** layer, region, interior flag, band distance */
  part: Float32Array;
  index: Uint32Array;
}

export type FractureMode = 'body' | 'attach' | 'own';

export interface PartRange {
  /** First triangle and triangle count of this part in MeshData.index. */
  triStart: number;
  triCount: number;
  mode: FractureMode;
}

export interface BoneInfo {
  /** Bind-pose joint positions in skeleton order, 3 per bone. */
  position: Float32Array;
  /** Parent bone in skeleton order, -1 for the root. */
  parent: Int16Array;
  names: string[];
}

export interface ChunkInfo {
  id: number;
  kind: 'body' | 'own';
  /** Bone that carries most of the chunk (skeleton index). */
  bone: number;
  /** Bind-space centroid and bounds. */
  centroid: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** Chunks sharing a border with this one. */
  neighbors: number[];
}

export interface Fractured {
  data: MeshData;
  /** Chunk id per vertex. */
  chunk: Float32Array;
  /** Triangles of the intact surface. */
  surfaceIndex: Uint32Array;
  /** Surface plus the interior faces that close every chunk. */
  fullIndex: Uint32Array;
  chunks: ChunkInfo[];
}

export interface FractureOptions {
  /** Number of body chunks. */
  chunks: number;
  seed: number;
}

// ------------------------------------------------------------------ helpers

class MinHeap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Weld vertices by quantised position; returns an id per vertex. */
function weld(position: Float32Array): Int32Array {
  const n = position.length / 3;
  const ids = new Int32Array(n);
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(position[i * 3] * 20000)}_${Math.round(position[i * 3 + 1] * 20000)}_${Math.round(position[i * 3 + 2] * 20000)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = map.size;
      map.set(key, id);
    }
    ids[i] = id;
  }
  return ids;
}

const edgeKey = (a: number, b: number): number => (a < b ? a * 4194304 + b : b * 4194304 + a);

/** Cheap deterministic hash in [0, 1). */
function hash01(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ fracture

export function fractureMesh(mesh: MeshData, ranges: readonly PartRange[], bones: BoneInfo, options: FractureOptions): Fractured {
  const { position, index } = mesh;
  const welded = weld(position);
  const rng = new Rng(options.seed);

  const bodyRange = ranges.find((r) => r.mode === 'body');
  if (!bodyRange) throw new Error('fracture: no body part');
  const nBody = bodyRange.triCount;
  const bodyTri = (t: number, k: number): number => index[(bodyRange.triStart + t) * 3 + k];

  // Triangle centroids and adjacency over the welded body surface.
  const centroid = new Float32Array(nBody * 3);
  for (let t = 0; t < nBody; t++) {
    for (let k = 0; k < 3; k++) {
      const v = bodyTri(t, k);
      centroid[t * 3] += position[v * 3] / 3;
      centroid[t * 3 + 1] += position[v * 3 + 1] / 3;
      centroid[t * 3 + 2] += position[v * 3 + 2] / 3;
    }
  }
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < nBody; t++) {
    for (let k = 0; k < 3; k++) {
      const a = welded[bodyTri(t, k)];
      const b = welded[bodyTri(t, (k + 1) % 3)];
      if (a === b) continue;
      const key = edgeKey(a, b);
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  const adjacent = new Int32Array(nBody * 3).fill(-1);
  for (let t = 0; t < nBody; t++) {
    for (let k = 0; k < 3; k++) {
      const a = welded[bodyTri(t, k)];
      const b = welded[bodyTri(t, (k + 1) % 3)];
      if (a === b) continue;
      const list = edgeTris.get(edgeKey(a, b))!;
      for (const other of list) {
        if (other !== t) {
          adjacent[t * 3 + k] = other;
          break;
        }
      }
    }
  }

  // Dominant bone per body triangle, and a density scale: finer chunks on head and torso.
  const dominantBone = (v: number): number => {
    let best = 0;
    let bw = -1;
    for (let k = 0; k < 4; k++) {
      if (mesh.skinWeight[v * 4 + k] > bw) {
        bw = mesh.skinWeight[v * 4 + k];
        best = mesh.skinIndex[v * 4 + k];
      }
    }
    return best;
  };
  const fine = new Set<number>();
  bones.names.forEach((name, i) => {
    if (/^(head|neck|spine|pelvis|clavicle)/i.test(name)) fine.add(i);
  });
  const scale = new Float32Array(nBody);
  for (let t = 0; t < nBody; t++) scale[t] = fine.has(dominantBone(bodyTri(t, 0))) ? 0.72 : 1;

  // Seeds by farthest-point sampling.
  const K = Math.min(options.chunks, nBody);
  const seeds: number[] = [];
  const minDist = new Float32Array(nBody).fill(Infinity);
  let next = Math.floor(rng.next() * nBody);
  for (let s = 0; s < K; s++) {
    seeds.push(next);
    const sx = centroid[next * 3];
    const sy = centroid[next * 3 + 1];
    const sz = centroid[next * 3 + 2];
    let best = -1;
    let bestD = -1;
    for (let t = 0; t < nBody; t++) {
      const d = Math.hypot(centroid[t * 3] - sx, centroid[t * 3 + 1] - sy, centroid[t * 3 + 2] - sz);
      if (d < minDist[t]) minDist[t] = d;
      const score = minDist[t] / scale[t];
      if (score > bestD) {
        bestD = score;
        best = t;
      }
    }
    next = best;
  }

  // Geodesic Voronoi: multi-source Dijkstra across triangle adjacency with jittered step costs
  // so borders wander like real fractures.
  const label = new Int32Array(nBody).fill(-1);
  const dist = new Float32Array(nBody).fill(Infinity);
  const heap = new MinHeap();
  seeds.forEach((t, s) => {
    dist[t] = 0;
    label[t] = s;
    heap.push(0, t);
  });
  while (heap.size) {
    const [d, t] = heap.pop();
    if (d > dist[t]) continue;
    for (let k = 0; k < 3; k++) {
      const o = adjacent[t * 3 + k];
      if (o < 0) continue;
      const step = Math.hypot(centroid[t * 3] - centroid[o * 3], centroid[t * 3 + 1] - centroid[o * 3 + 1], centroid[t * 3 + 2] - centroid[o * 3 + 2]);
      const nd = d + step * (0.7 + 0.9 * hash01(Math.min(t, o) + options.seed * 7919, Math.max(t, o)));
      if (nd < dist[o]) {
        dist[o] = nd;
        label[o] = label[t];
        heap.push(nd, o);
      }
    }
  }
  // Islands the flood never reached (detached shells inside the body) join the nearest seed.
  for (let t = 0; t < nBody; t++) {
    if (label[t] >= 0) continue;
    let best = 0;
    let bd = Infinity;
    seeds.forEach((s, i) => {
      const d = Math.hypot(centroid[t * 3] - centroid[s * 3], centroid[t * 3 + 1] - centroid[s * 3 + 1], centroid[t * 3 + 2] - centroid[s * 3 + 2]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    label[t] = best;
  }
  // Smooth: a triangle surrounded on two sides by another chunk joins it.
  for (let pass = 0; pass < 2; pass++) {
    for (let t = 0; t < nBody; t++) {
      const n0 = adjacent[t * 3] >= 0 ? label[adjacent[t * 3]] : -1;
      const n1 = adjacent[t * 3 + 1] >= 0 ? label[adjacent[t * 3 + 1]] : -1;
      const n2 = adjacent[t * 3 + 2] >= 0 ? label[adjacent[t * 3 + 2]] : -1;
      const l = label[t];
      if (n0 >= 0 && n0 !== l && (n0 === n1 || n0 === n2)) label[t] = n0;
      else if (n1 >= 0 && n1 !== l && n1 === n2) label[t] = n1;
    }
  }
  // Keep each chunk in one piece: stray islands join a neighbouring chunk.
  {
    const comp = new Int32Array(nBody).fill(-1);
    const compLabel: number[] = [];
    const compSize: number[] = [];
    const stack: number[] = [];
    for (let t = 0; t < nBody; t++) {
      if (comp[t] >= 0) continue;
      const c = compLabel.length;
      compLabel.push(label[t]);
      let size = 0;
      comp[t] = c;
      stack.push(t);
      while (stack.length) {
        const x = stack.pop()!;
        size++;
        for (let k = 0; k < 3; k++) {
          const o = adjacent[x * 3 + k];
          if (o >= 0 && comp[o] < 0 && label[o] === label[x]) {
            comp[o] = c;
            stack.push(o);
          }
        }
      }
      compSize.push(size);
    }
    const biggest = new Map<number, number>();
    compLabel.forEach((l, c) => {
      const cur = biggest.get(l);
      if (cur === undefined || compSize[c] > compSize[cur]) biggest.set(l, c);
    });
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let t = 0; t < nBody; t++) {
        if (biggest.get(label[t]) === comp[t]) continue;
        for (let k = 0; k < 3; k++) {
          const o = adjacent[t * 3 + k];
          if (o >= 0 && biggest.get(label[o]) === comp[o]) {
            label[t] = label[o];
            comp[t] = comp[o];
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }
  }
  // Compact labels (some seeds may have lost all their triangles).
  const remap = new Map<number, number>();
  for (let t = 0; t < nBody; t++) {
    if (!remap.has(label[t])) remap.set(label[t], remap.size);
    label[t] = remap.get(label[t])!;
  }
  let chunkCount = remap.size;

  // Spatial hash of body triangle centroids, for loose parts to find the chunk beneath them.
  const CELL = 0.06;
  const grid = new Map<string, number[]>();
  const cellOf = (x: number, y: number, z: number): [number, number, number] => [Math.floor(x / CELL), Math.floor(y / CELL), Math.floor(z / CELL)];
  for (let t = 0; t < nBody; t++) {
    const [cx, cy, cz] = cellOf(centroid[t * 3], centroid[t * 3 + 1], centroid[t * 3 + 2]);
    const key = `${cx}_${cy}_${cz}`;
    const list = grid.get(key);
    if (list) list.push(t);
    else grid.set(key, [t]);
  }
  const nearestBodyTri = (x: number, y: number, z: number): number => {
    const [cx, cy, cz] = cellOf(x, y, z);
    let best = -1;
    let bd = Infinity;
    for (let ring = 1; ring <= 6 && best < 0; ring++) {
      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        for (let iy = cy - ring; iy <= cy + ring; iy++) {
          for (let iz = cz - ring; iz <= cz + ring; iz++) {
            const list = grid.get(`${ix}_${iy}_${iz}`);
            if (!list) continue;
            for (const t of list) {
              const d = (centroid[t * 3] - x) ** 2 + (centroid[t * 3 + 1] - y) ** 2 + (centroid[t * 3 + 2] - z) ** 2;
              if (d < bd) {
                bd = d;
                best = t;
              }
            }
          }
        }
      }
    }
    if (best < 0) {
      for (let t = 0; t < nBody; t++) {
        const d = (centroid[t * 3] - x) ** 2 + (centroid[t * 3 + 1] - y) ** 2 + (centroid[t * 3 + 2] - z) ** 2;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
    }
    return best;
  };

  // Chunk id for every triangle of the mesh.
  const triTotal = index.length / 3;
  const triChunk = new Int32Array(triTotal).fill(-1);
  const ownChunks: number[] = [];
  for (const range of ranges) {
    if (range.mode === 'body') {
      for (let t = 0; t < range.triCount; t++) triChunk[range.triStart + t] = label[t];
    } else if (range.mode === 'own') {
      const id = chunkCount++;
      ownChunks.push(id);
      for (let t = 0; t < range.triCount; t++) triChunk[range.triStart + t] = id;
    } else {
      // Loose parts: group connected triangles (one plate, one lock of hair) and send each
      // group, whole, to the chunk under its centre when it is small; large surfaces such as a
      // cuirass split along the chunk borders beneath them.
      for (let t = 0; t < range.triCount; t++) {
        const g = range.triStart + t;
        let x = 0;
        let y = 0;
        let z = 0;
        for (let k = 0; k < 3; k++) {
          const v = index[g * 3 + k];
          x += position[v * 3] / 3;
          y += position[v * 3 + 1] / 3;
          z += position[v * 3 + 2] / 3;
        }
        triChunk[g] = label[nearestBodyTri(x, y, z)];
      }
    }
  }

  // ---------------------------------------------------------------- rebuild vertices per chunk
  const outPos: number[] = [];
  const outNor: number[] = [];
  const outUv: number[] = [];
  const outSi: number[] = [];
  const outSw: number[] = [];
  const outPart: number[] = [];
  const outChunk: number[] = [];
  const vertexOf = new Map<number, number>();
  const surface: number[] = [];
  const copyVertex = (v: number, chunk: number): number => {
    const key = v * 1024 + chunk;
    let id = vertexOf.get(key);
    if (id !== undefined) return id;
    id = outChunk.length;
    vertexOf.set(key, id);
    outPos.push(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]);
    outNor.push(mesh.normal[v * 3], mesh.normal[v * 3 + 1], mesh.normal[v * 3 + 2]);
    outUv.push(mesh.uv[v * 2], mesh.uv[v * 2 + 1]);
    for (let k = 0; k < 4; k++) {
      outSi.push(mesh.skinIndex[v * 4 + k]);
      outSw.push(mesh.skinWeight[v * 4 + k]);
      outPart.push(mesh.part[v * 4 + k]);
    }
    outChunk.push(chunk);
    return id;
  };
  for (let t = 0; t < triTotal; t++) {
    const c = triChunk[t];
    for (let k = 0; k < 3; k++) surface.push(copyVertex(index[t * 3 + k], c));
  }

  // ---------------------------------------------------------------- chunk statistics
  const chunks: ChunkInfo[] = [];
  const boneWeight: Float64Array[] = [];
  for (let c = 0; c < chunkCount; c++) {
    chunks.push({ id: c, kind: ownChunks.includes(c) ? 'own' : 'body', bone: 0, centroid: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], neighbors: [] });
    boneWeight.push(new Float64Array(bones.names.length));
  }
  const counts = new Float64Array(chunkCount);
  for (let i = 0; i < outChunk.length; i++) {
    const c = outChunk[i];
    const info = chunks[c];
    for (let k = 0; k < 3; k++) {
      const p = outPos[i * 3 + k];
      info.centroid[k] += p;
      if (p < info.min[k]) info.min[k] = p;
      if (p > info.max[k]) info.max[k] = p;
    }
    counts[c]++;
    for (let k = 0; k < 4; k++) boneWeight[c][outSi[i * 4 + k]] += outSw[i * 4 + k];
  }
  for (let c = 0; c < chunkCount; c++) {
    const info = chunks[c];
    const n = Math.max(1, counts[c]);
    info.centroid = [info.centroid[0] / n, info.centroid[1] / n, info.centroid[2] / n];
    let best = 0;
    for (let b = 1; b < boneWeight[c].length; b++) if (boneWeight[c][b] > boneWeight[c][best]) best = b;
    info.bone = best;
  }

  // ---------------------------------------------------------------- caps
  // Closest point to p on the segment from a bone to its first child (the bone's axis).
  const childOf = new Int32Array(bones.names.length).fill(-1);
  for (let b = 0; b < bones.parent.length; b++) {
    const p = bones.parent[b];
    if (p >= 0 && childOf[p] < 0) childOf[p] = b;
  }
  const closestOnBone = (bone: number, p: [number, number, number]): [number, number, number] => {
    const a: [number, number, number] = [bones.position[bone * 3], bones.position[bone * 3 + 1], bones.position[bone * 3 + 2]];
    const child = childOf[bone];
    if (child < 0) return a;
    const b: [number, number, number] = [bones.position[child * 3], bones.position[child * 3 + 1], bones.position[child * 3 + 2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    if (len2 < 1e-10) return a;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2));
    return [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  };

  const caps: number[] = [];
  const neighborSets: Set<number>[] = chunks.map(() => new Set<number>());
  // Directed border half-edges per body chunk: welded start -> { end, source vertex ids }.
  interface HalfEdge {
    from: number;
    to: number;
    vFrom: number;
    vTo: number;
    used: boolean;
  }
  const borders: HalfEdge[][] = chunks.map(() => []);
  for (let t = 0; t < nBody; t++) {
    const c = label[t];
    for (let k = 0; k < 3; k++) {
      const o = adjacent[t * 3 + k];
      const other = o < 0 ? -1 : label[o];
      if (other === c) continue;
      const vFrom = bodyTri(t, k);
      const vTo = bodyTri(t, (k + 1) % 3);
      if (welded[vFrom] === welded[vTo]) continue;
      borders[c].push({ from: welded[vFrom], to: welded[vTo], vFrom, vTo, used: false });
      if (other >= 0) neighborSets[c].add(other);
    }
  }

  const pushCapVertex = (p: [number, number, number], n: [number, number, number], skinFrom: number[], chunk: number): number => {
    const id = outChunk.length;
    outPos.push(p[0], p[1], p[2]);
    outNor.push(n[0], n[1], n[2]);
    outUv.push(0, 0);
    // Blend the skin of the given source vertices (one for rim points, the whole loop for the apex).
    const acc = new Map<number, number>();
    for (const v of skinFrom) {
      for (let k = 0; k < 4; k++) {
        const w = mesh.skinWeight[v * 4 + k];
        if (w > 0) acc.set(mesh.skinIndex[v * 4 + k], (acc.get(mesh.skinIndex[v * 4 + k]) ?? 0) + w);
      }
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, e) => s + e[1], 0) || 1;
    for (let k = 0; k < 4; k++) {
      outSi.push(top[k] ? top[k][0] : 0);
      outSw.push(top[k] ? top[k][1] / sum : k === 0 && !top.length ? 1 : 0);
    }
    // Interior stone: no normal map, stone region, interior flag, no edge band.
    outPart.push(0, 0, 1, 1);
    outChunk.push(chunk);
    return id;
  };

  for (let c = 0; c < chunkCount; c++) {
    const edges = borders[c];
    if (!edges.length) continue;
    const startAt = new Map<number, HalfEdge[]>();
    for (const e of edges) {
      const list = startAt.get(e.from);
      if (list) list.push(e);
      else startAt.set(e.from, [e]);
    }
    const info = chunks[c];
    for (const first of edges) {
      if (first.used) continue;
      // Walk the loop.
      const loop: HalfEdge[] = [];
      let e: HalfEdge | undefined = first;
      while (e && !e.used) {
        e.used = true;
        loop.push(e);
        const nextList: HalfEdge[] | undefined = startAt.get(e.to);
        e = nextList?.find((x) => !x.used);
      }
      if (loop.length < 3) continue;
      const lc: [number, number, number] = [0, 0, 0];
      for (const h of loop) {
        lc[0] += position[h.vFrom * 3] / loop.length;
        lc[1] += position[h.vFrom * 3 + 1] / loop.length;
        lc[2] += position[h.vFrom * 3 + 2] / loop.length;
      }
      let radius = 0;
      for (const h of loop) radius += Math.hypot(position[h.vFrom * 3] - lc[0], position[h.vFrom * 3 + 1] - lc[1], position[h.vFrom * 3 + 2] - lc[2]) / loop.length;
      // Apex: the loop centre pulled towards the bone's axis, so the chunk is a wedge of stone.
      const axis = closestOnBone(info.bone, lc);
      const toAxis: [number, number, number] = [axis[0] - lc[0], axis[1] - lc[1], axis[2] - lc[2]];
      const axisDist = Math.hypot(toAxis[0], toAxis[1], toAxis[2]);
      let apex = lc;
      if (axisDist > radius * 0.3) {
        const depth = Math.min(0.6 * radius, 0.9 * axisDist) / axisDist;
        apex = [lc[0] + toAxis[0] * depth, lc[1] + toAxis[1] * depth, lc[2] + toAxis[2] * depth];
      }
      // A little roughness so broken faces are not perfect cones.
      apex = [apex[0] + rng.range(-0.006, 0.006), apex[1] + rng.range(-0.006, 0.006), apex[2] + rng.range(-0.006, 0.006)];
      const loopVerts = loop.map((h) => h.vFrom);
      // Solid interior reference point for orienting the faces: between surface centroid and apex.
      const inside: [number, number, number] = [(info.centroid[0] + apex[0]) / 2, (info.centroid[1] + apex[1]) / 2, (info.centroid[2] + apex[2]) / 2];
      for (const h of loop) {
        const a: [number, number, number] = [position[h.vFrom * 3], position[h.vFrom * 3 + 1], position[h.vFrom * 3 + 2]];
        const b: [number, number, number] = [position[h.vTo * 3], position[h.vTo * 3 + 1], position[h.vTo * 3 + 2]];
        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];
        const vx = apex[0] - a[0];
        const vy = apex[1] - a[1];
        const vz = apex[2] - a[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) continue;
        nx /= len;
        ny /= len;
        nz /= len;
        const mx = (a[0] + b[0] + apex[0]) / 3 - inside[0];
        const my = (a[1] + b[1] + apex[1]) / 3 - inside[1];
        const mz = (a[2] + b[2] + apex[2]) / 3 - inside[2];
        const outward = nx * mx + ny * my + nz * mz >= 0;
        const n: [number, number, number] = outward ? [nx, ny, nz] : [-nx, -ny, -nz];
        const ia = pushCapVertex(a, n, [h.vFrom], c);
        const ib = pushCapVertex(b, n, [h.vTo], c);
        const ic = pushCapVertex(apex, n, loopVerts, c);
        if (outward) caps.push(ia, ib, ic);
        else caps.push(ib, ia, ic);
      }
    }
  }
  chunks.forEach((info, c) => {
    info.neighbors = [...neighborSets[c]];
  });

  const data: MeshData = {
    position: new Float32Array(outPos),
    normal: new Float32Array(outNor),
    uv: new Float32Array(outUv),
    skinIndex: new Uint16Array(outSi),
    skinWeight: new Float32Array(outSw),
    part: new Float32Array(outPart),
    index: new Uint32Array(surface),
  };
  const fullIndex = new Uint32Array(surface.length + caps.length);
  fullIndex.set(surface, 0);
  fullIndex.set(caps, surface.length);
  return { data, chunk: new Float32Array(outChunk), surfaceIndex: data.index, fullIndex, chunks };
}

/**
 * For tests: the number of edges of each chunk's closed solid (body triangles plus caps)
 * that are not shared by exactly two triangles. Zero means every body chunk is watertight.
 */
export function openEdgesPerChunk(
  f: { position: ArrayLike<number>; chunk: ArrayLike<number>; surfaceIndex: ArrayLike<number>; fullIndex: ArrayLike<number> },
  bodyTriangles: number,
): Map<number, number> {
  const welded = weld(Float32Array.from(f.position));
  const perChunk = new Map<number, Map<number, number>>();
  const add = (i0: number, i1: number, i2: number): void => {
    const c = f.chunk[i0];
    let edges = perChunk.get(c);
    if (!edges) {
      edges = new Map();
      perChunk.set(c, edges);
    }
    const ids = [welded[i0], welded[i1], welded[i2]];
    for (let k = 0; k < 3; k++) {
      const a = ids[k];
      const b = ids[(k + 1) % 3];
      if (a === b) continue;
      const key = edgeKey(a, b);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  };
  for (let t = 0; t < bodyTriangles; t++) add(f.surfaceIndex[t * 3], f.surfaceIndex[t * 3 + 1], f.surfaceIndex[t * 3 + 2]);
  for (let i = f.surfaceIndex.length; i < f.fullIndex.length; i += 3) add(f.fullIndex[i], f.fullIndex[i + 1], f.fullIndex[i + 2]);
  const result = new Map<number, number>();
  for (const [c, edges] of perChunk) {
    let open = 0;
    for (const count of edges.values()) if (count !== 2) open++;
    result.set(c, open);
  }
  return result;
}
