import * as THREE from 'three';
import { Rng } from '../core/math';

/**
 * A tileable 3D noise texture with four independent fractal gradient-noise fields (RGBA).
 * Sampling it in bind-pose space gives "solid" marble: veins are sheets through the volume,
 * so they stay put under animation and continue across broken faces.
 */
export function createNoise3D(size = 64, seed = 7): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  const octaves = [4, 8, 16, 32].filter((p) => p <= size / 2);
  const field = new Float32Array(size * size * size);
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

  for (let channel = 0; channel < 4; channel++) {
    field.fill(0);
    const rng = new Rng(seed * 101 + channel * 977 + 13);
    let amplitude = 1;
    for (const period of octaves) {
      // Random unit gradients on a periodic lattice.
      const count = period * period * period;
      const gx = new Float32Array(count);
      const gy = new Float32Array(count);
      const gz = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const z = rng.range(-1, 1);
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(1 - z * z);
        gx[i] = r * Math.cos(a);
        gy[i] = r * Math.sin(a);
        gz[i] = z;
      }
      const cell = size / period;
      // Per-axis lattice indices and fractions are the same for x, y and z.
      const i0 = new Int32Array(size);
      const i1 = new Int32Array(size);
      const fr = new Float32Array(size);
      const fd = new Float32Array(size);
      for (let v = 0; v < size; v++) {
        const u = v / cell;
        const fl = Math.floor(u);
        i0[v] = fl % period;
        i1[v] = (fl + 1) % period;
        fr[v] = u - fl;
        fd[v] = fade(u - fl);
      }
      const dot = (ix: number, iy: number, iz: number, dx: number, dy: number, dz: number): number => {
        const g = (iz * period + iy) * period + ix;
        return gx[g] * dx + gy[g] * dy + gz[g] * dz;
      };
      let o = 0;
      for (let z = 0; z < size; z++) {
        const z0 = i0[z];
        const z1 = i1[z];
        const fz = fr[z];
        const wz = fd[z];
        for (let y = 0; y < size; y++) {
          const y0 = i0[y];
          const y1 = i1[y];
          const fy = fr[y];
          const wy = fd[y];
          for (let x = 0; x < size; x++, o++) {
            const x0 = i0[x];
            const x1 = i1[x];
            const fx = fr[x];
            const wx = fd[x];
            const a = dot(x0, y0, z0, fx, fy, fz);
            const b = dot(x1, y0, z0, fx - 1, fy, fz);
            const c = dot(x0, y1, z0, fx, fy - 1, fz);
            const d = dot(x1, y1, z0, fx - 1, fy - 1, fz);
            const e = dot(x0, y0, z1, fx, fy, fz - 1);
            const f = dot(x1, y0, z1, fx - 1, fy, fz - 1);
            const g = dot(x0, y1, z1, fx, fy - 1, fz - 1);
            const h = dot(x1, y1, z1, fx - 1, fy - 1, fz - 1);
            const ab = a + (b - a) * wx;
            const cd = c + (d - c) * wx;
            const ef = e + (f - e) * wx;
            const gh = g + (h - g) * wx;
            const abcd = ab + (cd - ab) * wy;
            const efgh = ef + (gh - ef) * wy;
            field[o] += (abcd + (efgh - abcd) * wz) * amplitude;
          }
        }
      }
      amplitude *= 0.5;
    }
    // Normalise so the median sits at 0.5 (iso-surfaces at 0.5 then have even coverage) and
    // the values use the full byte range.
    const sorted = Float32Array.from(field).sort();
    const median = sorted[sorted.length >> 1];
    const lo = sorted[Math.floor(sorted.length * 0.002)];
    const hi = sorted[Math.floor(sorted.length * 0.998)];
    const half = Math.max(median - lo, hi - median);
    for (let i = 0; i < field.length; i++) {
      const v = 0.5 + (0.5 * (field[i] - median)) / half;
      data[i * 4 + channel] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }

  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  tex.name = 'stone-noise-3d';
  return tex;
}
