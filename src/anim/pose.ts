import * as THREE from 'three';
import type { BakedClip } from './bake';
import type { Rig } from './rig';

/** Local rotations for every bone plus the pelvis position. */
export class Pose {
  readonly rot: Float32Array;
  readonly pelvis = new Float32Array(3);
  /** Root displacement in actor space for root-motion clips (zero otherwise). */
  readonly rootMotion = new Float32Array(3);

  constructor(readonly boneCount: number) {
    this.rot = new Float32Array(boneCount * 4);
    for (let i = 0; i < boneCount; i++) this.rot[i * 4 + 3] = 1;
  }

  copy(other: Pose): this {
    this.rot.set(other.rot);
    this.pelvis.set(other.pelvis);
    this.rootMotion.set(other.rootMotion);
    return this;
  }

  setRest(rig: Rig): this {
    this.rot.set(rig.restRot);
    const p = rig.index.get('pelvis');
    if (p !== undefined) this.pelvis.set(rig.restPos.subarray(p * 3, p * 3 + 3));
    this.rootMotion.fill(0);
    return this;
  }
}

/**
 * Sample a baked clip at `time` seconds with Catmull-Rom interpolation between frames.
 * Looping clips wrap (their last frame repeats the first); others clamp at both ends.
 */
export function sampleClip(clip: BakedClip, time: number, out: Pose): void {
  const last = clip.frames - 1;
  let u = time * clip.fps;
  if (clip.loop) u = ((u % last) + last) % last;
  else u = u < 0 ? 0 : u > last ? last : u;

  const i1 = Math.min(Math.floor(u), last - 1);
  const s = u - i1;
  const i2 = i1 + 1;
  let i0 = i1 - 1;
  let i3 = i2 + 1;
  if (clip.loop) {
    if (i0 < 0) i0 = last - 1;
    if (i3 > last) i3 = 1;
  } else {
    if (i0 < 0) i0 = 0;
    if (i3 > last) i3 = last;
  }

  const s2 = s * s;
  const s3 = s2 * s;
  const w0 = -0.5 * s3 + s2 - 0.5 * s;
  const w1 = 1.5 * s3 - 2.5 * s2 + 1;
  const w2 = -1.5 * s3 + 2 * s2 + 0.5 * s;
  const w3 = 0.5 * s3 - 0.5 * s2;

  const n = clip.boneCount;
  const src = clip.rot;
  const dst = out.rot;
  const o0 = i0 * n * 4;
  const o1 = i1 * n * 4;
  const o2 = i2 * n * 4;
  const o3 = i3 * n * 4;
  for (let b = 0; b < n; b++) {
    const k = b * 4;
    const x1 = src[o1 + k];
    const y1 = src[o1 + k + 1];
    const z1 = src[o1 + k + 2];
    const q1 = src[o1 + k + 3];
    const x2 = src[o2 + k];
    const y2 = src[o2 + k + 1];
    const z2 = src[o2 + k + 2];
    const q2 = src[o2 + k + 3];
    // Neighbouring frames are stored hemisphere-aligned, but a loop wrap may not be.
    const f0 = src[o0 + k] * x1 + src[o0 + k + 1] * y1 + src[o0 + k + 2] * z1 + src[o0 + k + 3] * q1 < 0 ? -w0 : w0;
    const g2 = x2 * x1 + y2 * y1 + z2 * z1 + q2 * q1 < 0 ? -1 : 1;
    const f2 = w2 * g2;
    const f3 = (src[o3 + k] * x2 + src[o3 + k + 1] * y2 + src[o3 + k + 2] * z2 + src[o3 + k + 3] * q2 < 0 ? -w3 : w3) * g2;
    let x = src[o0 + k] * f0 + x1 * w1 + x2 * f2 + src[o3 + k] * f3;
    let y = src[o0 + k + 1] * f0 + y1 * w1 + y2 * f2 + src[o3 + k + 1] * f3;
    let z = src[o0 + k + 2] * f0 + z1 * w1 + z2 * f2 + src[o3 + k + 2] * f3;
    let w = src[o0 + k + 3] * f0 + q1 * w1 + q2 * f2 + src[o3 + k + 3] * f3;
    const inv = 1 / Math.hypot(x, y, z, w);
    x *= inv;
    y *= inv;
    z *= inv;
    w *= inv;
    dst[k] = x;
    dst[k + 1] = y;
    dst[k + 2] = z;
    dst[k + 3] = w;
  }

  const p = clip.pelvis;
  for (let k = 0; k < 3; k++) {
    out.pelvis[k] = p[i0 * 3 + k] * w0 + p[i1 * 3 + k] * w1 + p[i2 * 3 + k] * w2 + p[i3 * 3 + k] * w3;
  }
  const rm = clip.rootMotion;
  if (rm) {
    for (let k = 0; k < 3; k++) {
      out.rootMotion[k] = rm[i0 * 3 + k] * w0 + rm[i1 * 3 + k] * w1 + rm[i2 * 3 + k] * w2 + rm[i3 * 3 + k] * w3;
    }
  } else {
    out.rootMotion.fill(0);
  }
}

/**
 * Weighted blend of several poses with optional per-bone masks.
 * Bones that receive no weight keep whatever `fallback` holds for them.
 */
export class PoseBlender {
  private readonly acc: Float32Array;
  private readonly weight: Float32Array;
  private readonly pelvisAcc = new Float32Array(3);
  private pelvisWeight = 0;

  constructor(
    private readonly boneCount: number,
    private readonly pelvisIndex: number,
  ) {
    this.acc = new Float32Array(boneCount * 4);
    this.weight = new Float32Array(boneCount);
  }

  begin(): void {
    this.acc.fill(0);
    this.weight.fill(0);
    this.pelvisAcc.fill(0);
    this.pelvisWeight = 0;
  }

  add(pose: Pose, weight: number, mask?: Float32Array | null): void {
    if (weight <= 0) return;
    const acc = this.acc;
    const src = pose.rot;
    for (let b = 0; b < this.boneCount; b++) {
      const w = mask ? weight * mask[b] : weight;
      if (w <= 0) continue;
      const k = b * 4;
      // Blend in the hemisphere of what has been accumulated so far.
      const dot = acc[k] * src[k] + acc[k + 1] * src[k + 1] + acc[k + 2] * src[k + 2] + acc[k + 3] * src[k + 3];
      const sw = dot < 0 ? -w : w;
      acc[k] += src[k] * sw;
      acc[k + 1] += src[k + 1] * sw;
      acc[k + 2] += src[k + 2] * sw;
      acc[k + 3] += src[k + 3] * sw;
      this.weight[b] += w;
    }
    const pw = mask ? weight * mask[this.pelvisIndex] : weight;
    if (pw > 0) {
      this.pelvisAcc[0] += pose.pelvis[0] * pw;
      this.pelvisAcc[1] += pose.pelvis[1] * pw;
      this.pelvisAcc[2] += pose.pelvis[2] * pw;
      this.pelvisWeight += pw;
    }
  }

  end(out: Pose, fallback: Pose): void {
    const acc = this.acc;
    for (let b = 0; b < this.boneCount; b++) {
      const k = b * 4;
      if (this.weight[b] <= 1e-6) {
        out.rot[k] = fallback.rot[k];
        out.rot[k + 1] = fallback.rot[k + 1];
        out.rot[k + 2] = fallback.rot[k + 2];
        out.rot[k + 3] = fallback.rot[k + 3];
        continue;
      }
      const len = Math.hypot(acc[k], acc[k + 1], acc[k + 2], acc[k + 3]);
      if (len < 1e-8) {
        out.rot[k] = fallback.rot[k];
        out.rot[k + 1] = fallback.rot[k + 1];
        out.rot[k + 2] = fallback.rot[k + 2];
        out.rot[k + 3] = fallback.rot[k + 3];
        continue;
      }
      const inv = 1 / len;
      out.rot[k] = acc[k] * inv;
      out.rot[k + 1] = acc[k + 1] * inv;
      out.rot[k + 2] = acc[k + 2] * inv;
      out.rot[k + 3] = acc[k + 3] * inv;
    }
    if (this.pelvisWeight > 1e-6) {
      const inv = 1 / this.pelvisWeight;
      out.pelvis[0] = this.pelvisAcc[0] * inv;
      out.pelvis[1] = this.pelvisAcc[1] * inv;
      out.pelvis[2] = this.pelvisAcc[2] * inv;
    } else {
      out.pelvis.set(fallback.pelvis);
    }
  }
}

/** Write a pose onto bone objects (ordered as in the rig). */
export function applyPose(pose: Pose, bones: readonly THREE.Object3D[], pelvisIndex: number): void {
  const r = pose.rot;
  for (let i = 0; i < bones.length; i++) {
    const k = i * 4;
    bones[i].quaternion.set(r[k], r[k + 1], r[k + 2], r[k + 3]);
  }
  if (pelvisIndex >= 0) bones[pelvisIndex].position.set(pose.pelvis[0], pose.pelvis[1], pose.pelvis[2]);
}

const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Forward kinematics in model space (the armature's frame): joint positions and,
 * optionally, accumulated rotations. Used for clip analysis and for planning.
 */
export function poseJoints(pose: Pose, rig: Rig, outPos: Float32Array, outRot?: Float32Array): void {
  const n = rig.names.length;
  const worldRot = outRot ?? new Float32Array(n * 4);
  const pelvis = rig.index.get('pelvis') ?? -1;
  for (let i = 0; i < n; i++) {
    const p = rig.parent[i];
    _q.fromArray(pose.rot, i * 4);
    if (i === pelvis) _v.set(pose.pelvis[0], pose.pelvis[1], pose.pelvis[2]);
    else _v.fromArray(rig.restPos, i * 3);
    if (p >= 0) {
      _p.fromArray(worldRot, p * 4);
      _v.applyQuaternion(_p);
      _v.x += outPos[p * 3];
      _v.y += outPos[p * 3 + 1];
      _v.z += outPos[p * 3 + 2];
      _p.multiply(_q).toArray(worldRot, i * 4);
    } else {
      _q.toArray(worldRot, i * 4);
    }
    _v.toArray(outPos, i * 3);
  }
}
