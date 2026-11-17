import * as THREE from 'three';
import type { BakedClip } from './bake';
import { solveTwoBone } from './ik';
import { Pose, poseJoints, sampleClip } from './pose';
import type { Rig } from './rig';

/**
 * Shaping poses by hand. The animation library gives clips; a statue's frozen pose, the pose it
 * braces in, or the few degrees by which a blow is aimed higher are none of them a clip. These
 * build such poses from clip frames and small turns of single bones, and wrap the result as a
 * clip so it goes through the same layering as everything else.
 *
 * Axes and positions are in the armature's own frame: x to the figure's left, y up, z the way it
 * faces, in model units (before the statue's scale).
 */

/** Groups of bones a pose can be laid over. */
export type BoneGroup = 'all' | 'legs' | 'trunk' | 'arms' | 'armL' | 'armR';

const ARM = /^(clavicle|upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)/;
const IN_GROUP: Record<BoneGroup, (name: string) => boolean> = {
  all: () => true,
  // Hips and legs: the same split the walk uses between lower and upper body.
  legs: (n) => /^(root|pelvis|thigh|calf|foot|ball)/.test(n),
  trunk: (n) => /^(spine|neck|head)/.test(n),
  arms: (n) => ARM.test(n),
  armL: (n) => ARM.test(n) && n.endsWith('_l'),
  armR: (n) => ARM.test(n) && n.endsWith('_r'),
};

/** A per-bone mask: `weight` for the bones of a group, 0 elsewhere. */
export function groupMask(rig: Rig, group: BoneGroup, weight = 1): Float32Array {
  const inGroup = IN_GROUP[group];
  return Float32Array.from(rig.names, (n) => (inGroup(n) ? weight : 0));
}

/** Move `target` towards `source`, bone by bone, by the weight the mask gives each bone. */
export function layPose(target: Pose, source: Pose, mask: Float32Array, pelvis: number): void {
  const a = target.rot;
  const b = source.rot;
  for (let i = 0; i < mask.length; i++) {
    const w = mask[i];
    if (w <= 0) continue;
    const k = i * 4;
    const s = a[k] * b[k] + a[k + 1] * b[k + 1] + a[k + 2] * b[k + 2] + a[k + 3] * b[k + 3] < 0 ? -1 : 1;
    const x = a[k] + (b[k] * s - a[k]) * w;
    const y = a[k + 1] + (b[k + 1] * s - a[k + 1]) * w;
    const z = a[k + 2] + (b[k + 2] * s - a[k + 2]) * w;
    const q = a[k + 3] + (b[k + 3] * s - a[k + 3]) * w;
    const inv = 1 / Math.hypot(x, y, z, q);
    a[k] = x * inv;
    a[k + 1] = y * inv;
    a[k + 2] = z * inv;
    a[k + 3] = q * inv;
  }
  if (pelvis >= 0 && mask[pelvis] > 0) {
    for (let k = 0; k < 3; k++) target.pelvis[k] += (source.pelvis[k] - target.pelvis[k]) * mask[pelvis];
  }
}

/** One clip frame, for the whole figure or laid over one group of its bones. */
export interface PosePart {
  clip: BakedClip;
  time: number;
  group?: BoneGroup;
  /** How far the group moves to this frame (default all the way). */
  weight?: number;
}

/** A pose made of clip frames: the first gives the whole figure, each later one is laid over its group. */
export function composePose(rig: Rig, parts: readonly PosePart[]): Pose {
  const n = rig.names.length;
  const out = new Pose(n).setRest(rig);
  const frame = new Pose(n);
  const pelvis = rig.index.get('pelvis') ?? -1;
  parts.forEach((part, i) => {
    sampleClip(part.clip, part.time, frame);
    if (i === 0) out.copy(frame);
    else layPose(out, frame, groupMask(rig, part.group ?? 'all', part.weight ?? 1), pelvis);
  });
  out.rootMotion.fill(0);
  return out;
}

/** A pose as a clip that never moves, so it can be layered and blended like any other. */
export function staticClip(name: string, pose: Pose): BakedClip {
  const n = pose.boneCount;
  const rot = new Float32Array(n * 8);
  rot.set(pose.rot, 0);
  rot.set(pose.rot, n * 4);
  const pelvis = new Float32Array(6);
  pelvis.set(pose.pelvis, 0);
  pelvis.set(pose.pelvis, 3);
  return { name, duration: 1, fps: 1, frames: 2, loop: false, boneCount: n, rot, pelvis, rootMotion: null };
}

const chain = new Int16Array(64);
const _q = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
const _out = new THREE.Quaternion();

/** A bone's orientation in the armature's frame: its own rotation on top of all its parents'. */
export function boneRotation(pose: Pose, rig: Rig, bone: number, out: THREE.Quaternion): THREE.Quaternion {
  let n = 0;
  for (let i = bone; i >= 0 && n < chain.length; i = rig.parent[i]) chain[n++] = i;
  out.identity();
  while (n > 0) out.multiply(_q.fromArray(pose.rot, chain[--n] * 4));
  return out;
}

/** Turn one bone (and so everything it carries) by `angle` about `axis`, a unit vector in the armature's frame. */
export function turnBone(pose: Pose, rig: Rig, bone: number, axis: THREE.Vector3, angle: number): void {
  if (angle === 0) return;
  const p = rig.parent[bone];
  if (p >= 0) boneRotation(pose, rig, p, _parent);
  else _parent.identity();
  _turn.setFromAxisAngle(axis, angle);
  // local' = parent^-1 * turn * parent * local
  _q.fromArray(pose.rot, bone * 4);
  _out.copy(_parent).invert().multiply(_turn).multiply(_parent).multiply(_q).normalize();
  _out.toArray(pose.rot, bone * 4);
}

/** Move the hips by an offset given in the armature's frame. */
export function shiftPelvis(pose: Pose, rig: Rig, offset: THREE.Vector3): void {
  const pelvis = rig.index.get('pelvis');
  if (pelvis === undefined) return;
  const p = rig.parent[pelvis];
  if (p >= 0) boneRotation(pose, rig, p, _parent);
  else _parent.identity();
  _v.copy(offset).applyQuaternion(_parent.invert());
  pose.pelvis[0] += _v.x;
  pose.pelvis[1] += _v.y;
  pose.pelvis[2] += _v.z;
}

/** Working arrays for forward kinematics, sized for one rig. */
export interface Joints {
  pos: Float32Array;
  rot: Float32Array;
}

export function createJoints(rig: Rig): Joints {
  return { pos: new Float32Array(rig.names.length * 3), rot: new Float32Array(rig.names.length * 4) };
}

/** The bones an aimed blow turns. */
export interface AimBones {
  spine: [number, number];
  arms: [number, number];
}

export function aimBones(rig: Rig): AimBones | null {
  const need = ['spine_02', 'spine_03', 'upperarm_l', 'upperarm_r'].map((n) => rig.index.get(n));
  if (need.some((i) => i === undefined)) return null;
  const [s2, s3, l, r] = need as number[];
  return { spine: [s2, s3], arms: [l, r] };
}

/** How much of an aim the upper spine takes; the arms take the rest. */
const SPINE_SHARE = 0.25;
const _axis = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Aim what the hands carry higher (positive `angle`, radians) or lower: both arms turn together
 * about the line of the shoulders, with part of the angle taken by the upper spine, so two
 * hands on one shaft stay on it. The strike planner runs this on the poses it measures and the
 * statue runs it on the pose it shows, with the same angle, so the weapon goes where it was
 * planned to go.
 */
export function aimPose(pose: Pose, rig: Rig, bones: AimBones, angle: number, joints: Joints): void {
  if (Math.abs(angle) < 1e-6) return;
  poseJoints(pose, rig, joints.pos, joints.rot);
  const l = bones.arms[0] * 3;
  const r = bones.arms[1] * 3;
  const p = joints.pos;
  _axis.set(p[l] - p[r], p[l + 1] - p[r + 1], p[l + 2] - p[r + 2]);
  if (_axis.lengthSq() < 1e-10) return;
  _axis.normalize();
  // About an axis pointing to the figure's left, a negative turn lifts whatever is in front.
  const each = (-angle * SPINE_SHARE) / bones.spine.length;
  for (const bone of bones.spine) turnBone(pose, rig, bone, _axis, each);
  for (const bone of bones.arms) turnBone(pose, rig, bone, _axis, -angle * (1 - SPINE_SHARE));
}

/** Where the feet of a planted stance go. */
export interface Stance {
  /** Distance between the balls of the feet, model units. */
  width: number;
  /** How far each foot is turned outward, radians. */
  toeOut: number;
  /** How far the hips drop, model units (bends the knees). */
  drop: number;
}

const H = new THREE.Vector3();
const K = new THREE.Vector3();
const A = new THREE.Vector3();
const forward = new THREE.Vector3();
const upper = new THREE.Quaternion();
const lower = new THREE.Quaternion();
const hip = new THREE.Quaternion();
const thigh = new THREE.Quaternion();
const calf = new THREE.Quaternion();
const yaw = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
/** The most of a leg's full length a planted stance may use. */
const KNEES_OFF_STRAIGHT = 0.985;

/**
 * Re-place the legs of a pose in a symmetrical planted stance: both soles flat on the floor,
 * the given distance apart, toes turned out, hips lowered. Everything above the hips is left
 * as it was (it simply rides lower).
 */
export function plantFeet(pose: Pose, rig: Rig, stance: Stance): void {
  const rest = new Pose(rig.names.length).setRest(rig);
  const restJoints = createJoints(rig);
  poseJoints(rest, rig, restJoints.pos, restJoints.rot);
  const joints = createJoints(rig);
  shiftPelvis(pose, rig, _v.set(0, -stance.drop, 0));
  poseJoints(pose, rig, joints.pos, joints.rot);

  // Keep the feet where they were front to back, on average, so the balance does not change.
  const ballL = rig.index.get('ball_l');
  const ballR = rig.index.get('ball_r');
  if (ballL === undefined || ballR === undefined) throw new Error('rig has no feet');
  const z = (joints.pos[ballL * 3 + 2] + joints.pos[ballR * 3 + 2]) / 2;

  const legs = (['l', 'r'] as const).map((side) => {
    const index = (name: string): number => {
      const i = rig.index.get(`${name}_${side}`);
      if (i === undefined) throw new Error(`rig has no ${name}_${side}`);
      return i;
    };
    const leg = { thigh: index('thigh'), calf: index('calf'), foot: index('foot'), ball: index('ball'), ankle: new THREE.Vector3(), sole: new THREE.Quaternion() };
    const sign = side === 'l' ? 1 : -1;
    // The sole is flat in the bind pose: the planted foot is that orientation, turned out.
    yaw.setFromAxisAngle(UP, sign * stance.toeOut);
    leg.sole.fromArray(restJoints.rot, leg.foot * 4).premultiply(yaw);
    // From the ankle to the ball of the foot, in that orientation.
    _v.fromArray(restJoints.pos, leg.ball * 3).sub(A.fromArray(restJoints.pos, leg.foot * 3));
    _v.applyQuaternion(yaw);
    leg.ankle.set((sign * stance.width) / 2, restJoints.pos[leg.ball * 3 + 1], z).sub(_v);
    return leg;
  });

  // Lower the hips until both ankles are within reach with the knees just off straight.
  for (let guard = 0; guard < 80; guard++) {
    const reaches = legs.every((leg) => {
      H.fromArray(joints.pos, leg.thigh * 3);
      K.fromArray(joints.pos, leg.calf * 3);
      A.fromArray(joints.pos, leg.foot * 3);
      return H.distanceTo(leg.ankle) <= (H.distanceTo(K) + K.distanceTo(A)) * KNEES_OFF_STRAIGHT;
    });
    if (reaches) break;
    shiftPelvis(pose, rig, _v.set(0, -0.004, 0));
    poseJoints(pose, rig, joints.pos, joints.rot);
  }

  for (const leg of legs) {
    H.fromArray(joints.pos, leg.thigh * 3);
    K.fromArray(joints.pos, leg.calf * 3);
    A.fromArray(joints.pos, leg.foot * 3);
    forward.set(0, 0, 1);
    if (!solveTwoBone(H, K, A, leg.ankle, forward, upper, lower)) continue;

    hip.fromArray(joints.rot, rig.parent[leg.thigh] * 4);
    thigh.fromArray(joints.rot, leg.thigh * 4).premultiply(upper);
    calf.fromArray(joints.rot, leg.calf * 4).premultiply(upper).premultiply(lower);
    // Back to local rotations, parents first.
    _q.copy(hip).invert().multiply(thigh).normalize().toArray(pose.rot, leg.thigh * 4);
    _q.copy(thigh).invert().multiply(calf).normalize().toArray(pose.rot, leg.calf * 4);
    _q.copy(calf).invert().multiply(leg.sole).normalize().toArray(pose.rot, leg.foot * 4);
    for (let k = 0; k < 4; k++) pose.rot[leg.ball * 4 + k] = rig.restRot[leg.ball * 4 + k];
  }
}
