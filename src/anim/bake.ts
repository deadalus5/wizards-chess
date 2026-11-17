import * as THREE from 'three';
import { canon, type Rig } from './rig';

/**
 * A clip retargeted to one rig and resampled to uniform frames.
 * Sampling it is plain index arithmetic plus cubic interpolation (see pose.ts), which keeps
 * motion smooth under slow motion where linearly interpolated keys would show velocity kinks.
 */
export interface BakedClip {
  name: string;
  duration: number;
  fps: number;
  frames: number;
  loop: boolean;
  boneCount: number;
  /** Local rotations, frames * boneCount * 4. */
  rot: Float32Array;
  /** Pelvis local position, frames * 3. */
  pelvis: Float32Array;
  /** Root displacement since frame 0 in actor space (root-motion clips only), frames * 3. */
  rootMotion: Float32Array | null;
}

const _a = new THREE.Quaternion();
const _b = new THREE.Quaternion();
const _c = new THREE.Quaternion();

/** Sample a keyframe track at time t (seconds) with linear / spherical interpolation. */
function sampleTrack(track: THREE.KeyframeTrack, t: number, out: number[]): void {
  const times = track.times;
  const values = track.values;
  const stride = values.length / times.length;
  const n = times.length;
  let i1 = 0;
  if (t <= times[0]) i1 = 0;
  else if (t >= times[n - 1]) i1 = n - 1;
  else {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    i1 = lo;
  }
  const i2 = Math.min(i1 + 1, n - 1);
  const span = times[i2] - times[i1];
  const s = span > 0 ? Math.min(Math.max((t - times[i1]) / span, 0), 1) : 0;
  if (stride === 4) {
    _a.fromArray(values, i1 * 4);
    _b.fromArray(values, i2 * 4);
    _a.slerp(_b, s).toArray(out);
  } else {
    for (let k = 0; k < stride; k++) out[k] = values[i1 * stride + k] + (values[i2 * stride + k] - values[i1 * stride + k]) * s;
  }
}

export interface BakeOptions {
  loop: boolean;
  fps?: number;
  name?: string;
}

/**
 * Retarget `clip` (authored for `src`) onto `dst`.
 *
 * The two rigs share bone names and axis conventions but not rest poses (shoulders, neck and
 * fingers differ by up to ~15 degrees), so rotations are transferred as world-space deltas
 * from rest: each destination bone turns from its own rest orientation by the same world
 * rotation the source bone turned from its rest orientation. Both rigs rest in a T-pose, so
 * rest maps to rest exactly and the destination keeps its own proportions.
 */
export function bakeClip(clip: THREE.AnimationClip, src: Rig, dst: Rig, opts: BakeOptions): BakedClip {
  const fps = opts.fps ?? 24;
  const duration = clip.duration;
  const frames = Math.max(2, Math.round(duration * fps) + 1);
  const nS = src.names.length;
  const nD = dst.names.length;

  const rotTracks = new Array<THREE.KeyframeTrack | undefined>(nS);
  const posTracks = new Array<THREE.KeyframeTrack | undefined>(nS);
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
    const i = src.index.get(canon(nodeName));
    if (i === undefined) continue;
    if (propertyName === 'quaternion') rotTracks[i] = track;
    else if (propertyName === 'position') posTracks[i] = track;
  }

  const dstToSrc = new Int16Array(nD);
  for (let d = 0; d < nD; d++) dstToSrc[d] = src.index.get(dst.names[d]) ?? -1;

  const srcPelvis = src.index.get('pelvis') ?? -1;
  const dstPelvis = dst.index.get('pelvis') ?? -1;
  const srcRoot = src.index.get('root') ?? -1;
  // Hip height ratio; the root bone carries a -90 degree X rotation so local Z is up.
  let hipRatio = 1;
  if (srcPelvis >= 0 && dstPelvis >= 0) {
    const sLen = Math.hypot(src.restPos[srcPelvis * 3], src.restPos[srcPelvis * 3 + 1], src.restPos[srcPelvis * 3 + 2]);
    const dLen = Math.hypot(dst.restPos[dstPelvis * 3], dst.restPos[dstPelvis * 3 + 1], dst.restPos[dstPelvis * 3 + 2]);
    if (sLen > 1e-5) hipRatio = dLen / sLen;
  }

  const rot = new Float32Array(frames * nD * 4);
  const pelvis = new Float32Array(frames * 3);
  let rootMotion: Float32Array | null = null;
  const rootTrack = srcRoot >= 0 ? posTracks[srcRoot] : undefined;
  if (rootTrack) {
    const v = rootTrack.values;
    let moved = 0;
    for (let i = 3; i < v.length; i += 3) moved = Math.max(moved, Math.hypot(v[i] - v[0], v[i + 1] - v[1], v[i + 2] - v[2]));
    if (moved > 0.02) rootMotion = new Float32Array(frames * 3);
  }

  const srcWorld = new Float32Array(nS * 4);
  const dstWorld = new Float32Array(nD * 4);
  const tmp: number[] = [0, 0, 0, 1];
  const root0: number[] = [0, 0, 0];

  for (let f = 0; f < frames; f++) {
    const t = Math.min(f / fps, duration);

    // Source world rotations for this frame.
    for (let s = 0; s < nS; s++) {
      const track = rotTracks[s];
      if (track) {
        sampleTrack(track, t, tmp);
        _a.set(tmp[0], tmp[1], tmp[2], tmp[3]).normalize();
      } else {
        _a.fromArray(src.restRot, s * 4);
      }
      const p = src.parent[s];
      if (p >= 0) {
        _b.fromArray(srcWorld, p * 4);
        _b.multiply(_a).toArray(srcWorld, s * 4);
      } else {
        _a.toArray(srcWorld, s * 4);
      }
    }

    // Destination world rotations: same world-space delta from rest.
    for (let d = 0; d < nD; d++) {
      const s = dstToSrc[d];
      const p = dst.parent[d];
      if (s >= 0) {
        _a.fromArray(srcWorld, s * 4);
        _b.fromArray(src.restWorldRot, s * 4).invert();
        _a.multiply(_b); // delta = srcWorld * inverse(srcRestWorld)
        _c.fromArray(dst.restWorldRot, d * 4);
        _a.multiply(_c).toArray(dstWorld, d * 4);
      } else if (p >= 0) {
        _a.fromArray(dstWorld, p * 4);
        _b.fromArray(dst.restRot, d * 4);
        _a.multiply(_b).toArray(dstWorld, d * 4);
      } else {
        dstWorld.set(dst.restRot.subarray(d * 4, d * 4 + 4), d * 4);
      }

      // Back to a local rotation.
      _a.fromArray(dstWorld, d * 4);
      if (p >= 0) {
        _b.fromArray(dstWorld, p * 4).invert();
        _b.multiply(_a);
      } else {
        _b.copy(_a);
      }
      _b.normalize();
      const o = (f * nD + d) * 4;
      if (f > 0) {
        // Keep consecutive frames in the same hemisphere so component-wise interpolation is valid.
        const q = (o - nD * 4) | 0;
        if (rot[q] * _b.x + rot[q + 1] * _b.y + rot[q + 2] * _b.z + rot[q + 3] * _b.w < 0) _b.set(-_b.x, -_b.y, -_b.z, -_b.w);
      }
      _b.toArray(rot, o);
    }

    // Pelvis translation, scaled by hip height.
    if (dstPelvis >= 0) {
      const o = f * 3;
      const track = srcPelvis >= 0 ? posTracks[srcPelvis] : undefined;
      for (let k = 0; k < 3; k++) pelvis[o + k] = dst.restPos[dstPelvis * 3 + k];
      if (track) {
        sampleTrack(track, t, tmp);
        for (let k = 0; k < 3; k++) pelvis[o + k] += (tmp[k] - src.restPos[srcPelvis * 3 + k]) * hipRatio;
      }
    }

    if (rootMotion && rootTrack) {
      sampleTrack(rootTrack, t, tmp);
      if (f === 0) for (let k = 0; k < 3; k++) root0[k] = tmp[k];
      for (let k = 0; k < 3; k++) rootMotion[f * 3 + k] = (tmp[k] - root0[k]) * hipRatio;
    }
  }

  return { name: opts.name ?? clip.name, duration, fps, frames, loop: opts.loop, boneCount: nD, rot, pelvis, rootMotion };
}
