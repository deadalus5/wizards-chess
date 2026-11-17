import * as THREE from 'three';

interface Vert {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
}

function vertAt(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, nor: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, i: number): Vert {
  return {
    x: pos.getX(i),
    y: pos.getY(i),
    z: pos.getZ(i),
    nx: nor ? nor.getX(i) : 0,
    ny: nor ? nor.getY(i) : 1,
    nz: nor ? nor.getZ(i) : 0,
    u: uv ? uv.getX(i) : 0,
    v: uv ? uv.getY(i) : 0,
  };
}

const mix = (a: Vert, b: Vert, t: number): Vert => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
  nx: a.nx + (b.nx - a.nx) * t,
  ny: a.ny + (b.ny - a.ny) * t,
  nz: a.nz + (b.nz - a.nz) * t,
  u: a.u + (b.u - a.u) * t,
  v: a.v + (b.v - a.v) * t,
});

function build(verts: Vert[]): THREE.BufferGeometry {
  const n = verts.length;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = verts[i];
    position.set([p.x, p.y, p.z], i * 3);
    const len = Math.hypot(p.nx, p.ny, p.nz) || 1;
    normal.set([p.nx / len, p.ny / len, p.nz / len], i * 3);
    uv.set([p.u, p.v], i * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Keep the part of a mesh above the plane y = cut, splitting triangles that straddle it and
 * closing the opening with a flat cap so the result is a solid. Returns non-indexed geometry.
 */
export function sliceAboveY(source: THREE.BufferGeometry, cut: number): THREE.BufferGeometry {
  const pos = source.getAttribute('position');
  const nor = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const index = source.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const out: Vert[] = [];
  const rim: Array<[Vert, Vert]> = [];

  for (let t = 0; t < triCount; t++) {
    const tri = [0, 1, 2].map((k) => vertAt(pos, nor, uv, index ? index.getX(t * 3 + k) : t * 3 + k));
    const inside = tri.map((v) => v.y >= cut);
    const count = inside.filter(Boolean).length;
    if (count === 0) continue;
    if (count === 3) {
      out.push(...tri);
      continue;
    }
    // Clip the triangle against the plane, keeping winding order.
    const poly: Vert[] = [];
    const crossings: Vert[] = [];
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      if (inside[k]) poly.push(a);
      if (inside[k] !== inside[(k + 1) % 3]) {
        const c = mix(a, b, (cut - a.y) / (b.y - a.y));
        c.y = cut;
        poly.push(c);
        crossings.push(c);
      }
    }
    for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
    if (crossings.length === 2) rim.push([crossings[0], crossings[1]]);
  }

  if (rim.length) {
    let cx = 0;
    let cz = 0;
    for (const [a, b] of rim) {
      cx += a.x + b.x;
      cz += a.z + b.z;
    }
    cx /= rim.length * 2;
    cz /= rim.length * 2;
    const centre: Vert = { x: cx, y: cut, z: cz, nx: 0, ny: -1, nz: 0, u: 0.5, v: 0.5 };
    for (const [a, b] of rim) {
      // Wind each cap triangle so it faces down.
      const cross = (a.z - cz) * (b.x - cx) - (a.x - cx) * (b.z - cz);
      const first = cross < 0 ? a : b;
      const second = cross < 0 ? b : a;
      out.push(centre, { ...first, nx: 0, ny: -1, nz: 0 }, { ...second, nx: 0, ny: -1, nz: 0 });
    }
  }
  return build(out);
}

/** Apply a transform to a geometry in place and return it. */
export function transformed(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(m);
  return g;
}

/** Radius of the widest ring of vertices within a horizontal band, measured from the y axis. */
export function ringRadius(g: THREE.BufferGeometry, yMin: number, yMax: number): number {
  const pos = g.getAttribute('position');
  let r = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < yMin || y > yMax) continue;
    r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)));
  }
  return r;
}

/** Concatenate non-indexed or indexed geometries (position, normal, uv) into one non-indexed geometry. */
export function mergeSimple(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const verts: Vert[] = [];
  for (const g of geometries) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const index = g.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i++) verts.push(vertAt(pos, nor, uv, index ? index.getX(i) : i));
  }
  return build(verts);
}
