import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyPose, bonesTo, Pose, poseJoints, sampleClip } from '../src/anim/pose';
import { rigFromBones, type Rig } from '../src/anim/rig';
import { aimBones, aimPose, composePose, createJoints, groupMask, plantFeet, staticClip, turnBone } from '../src/anim/sculpt';

/**
 * A small figure with the same conventions as the real rigs: the root bone is turned so its
 * local z is up, and everything hangs off it. Standing in a T-pose, facing +z, left at +x.
 */
function figure(): { rig: Rig; bones: THREE.Object3D[] } {
  const all: THREE.Bone[] = [];
  const bone = (name: string, parent: THREE.Bone | null, x: number, y: number, z: number): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent?.add(b);
    all.push(b);
    return b;
  };
  // Under the root, x is left, -y is forward, z is up.
  const root = bone('root', null, 0, 0, 0);
  root.rotation.x = -Math.PI / 2;
  const pelvis = bone('pelvis', root, 0, 0, 0.95);
  const s1 = bone('spine_01', pelvis, 0, 0, 0.12);
  const s2 = bone('spine_02', s1, 0, 0, 0.14);
  const s3 = bone('spine_03', s2, 0, 0, 0.14);
  const neck = bone('neck_01', s3, 0, 0, 0.16);
  bone('head', neck, 0, 0, 0.09);
  for (const [side, sign] of [['l', 1], ['r', -1]] as const) {
    const clavicle = bone(`clavicle_${side}`, s3, sign * 0.04, 0, 0.1);
    const upper = bone(`upperarm_${side}`, clavicle, sign * 0.13, 0, 0);
    const lowerArm = bone(`lowerarm_${side}`, upper, sign * 0.28, 0, 0);
    bone(`hand_${side}`, lowerArm, sign * 0.26, 0, 0);
    const thigh = bone(`thigh_${side}`, pelvis, sign * 0.09, 0, -0.04);
    const calf = bone(`calf_${side}`, thigh, 0, -0.03, -0.42);
    const foot = bone(`foot_${side}`, calf, 0, 0.03, -0.41);
    bone(`ball_${side}`, foot, 0, -0.14, -0.07);
  }
  root.updateMatrixWorld(true);
  const { rig, ordered } = rigFromBones(all);
  return { rig, bones: ordered };
}

/** Joint positions as three.js itself computes them, to check the pose maths against. */
function worldPositions(pose: Pose, rig: Rig, bones: THREE.Object3D[]): Float32Array {
  applyPose(pose, bones, rig.index.get('pelvis') ?? -1);
  bones[0].updateMatrixWorld(true);
  const out = new Float32Array(bones.length * 3);
  const v = new THREE.Vector3();
  bones.forEach((b, i) => b.getWorldPosition(v).toArray(out, i * 3));
  return out;
}

const at = (pos: Float32Array, rig: Rig, name: string): THREE.Vector3 => new THREE.Vector3().fromArray(pos, rig.index.get(name)! * 3);

describe('pose tools', () => {
  it('agree with three.js about where the joints are', () => {
    const { rig, bones } = figure();
    const pose = new Pose(rig.names.length).setRest(rig);
    turnBone(pose, rig, rig.index.get('thigh_l')!, new THREE.Vector3(1, 0, 0), -0.4);
    turnBone(pose, rig, rig.index.get('spine_02')!, new THREE.Vector3(0, 1, 0), 0.3);
    const joints = createJoints(rig);
    poseJoints(pose, rig, joints.pos, joints.rot);
    const real = worldPositions(pose, rig, bones);
    for (let i = 0; i < real.length; i++) expect(joints.pos[i]).toBeCloseTo(real[i], 5);
    // The figure really is the right way up, facing +z, with its left at +x.
    expect(at(joints.pos, rig, 'head').y).toBeGreaterThan(1.5);
    expect(at(joints.pos, rig, 'hand_l').x).toBeGreaterThan(0.5);
  });

  it('works out a limb alone exactly as it works out the whole figure', () => {
    const { rig } = figure();
    const pose = new Pose(rig.names.length).setRest(rig);
    turnBone(pose, rig, rig.index.get('spine_02')!, new THREE.Vector3(0, 1, 0), 0.3);
    turnBone(pose, rig, rig.index.get('upperarm_r')!, new THREE.Vector3(1, 0, 0), -0.7);
    const whole = createJoints(rig);
    poseJoints(pose, rig, whole.pos, whole.rot);
    const hand = rig.index.get('hand_r')!;
    const only = bonesTo(rig, [hand, rig.index.get('upperarm_l')!]);
    // The hand, the other shoulder and what they hang from: not the legs, not the head.
    expect(only.length).toBeLessThan(rig.names.length);
    expect([...only]).toContain(rig.index.get('spine_03')!);
    expect([...only]).not.toContain(rig.index.get('thigh_l')!);
    for (let i = 1; i < only.length; i++) expect(only[i]).toBeGreaterThan(only[i - 1]);
    const part = createJoints(rig);
    poseJoints(pose, rig, part.pos, part.rot, only);
    for (const b of only) {
      for (let k = 0; k < 3; k++) expect(part.pos[b * 3 + k]).toBeCloseTo(whole.pos[b * 3 + k], 9);
      for (let k = 0; k < 4; k++) expect(part.rot[b * 4 + k]).toBeCloseTo(whole.rot[b * 4 + k], 9);
    }
    // Aiming gives the same pose whether it measures the whole figure or only the shoulders.
    const bones = aimBones(rig)!;
    const a = new Pose(rig.names.length).copy(pose);
    const b = new Pose(rig.names.length).copy(pose);
    aimPose(a, rig, bones, 0.3, createJoints(rig));
    aimPose(b, rig, bones, 0.3, createJoints(rig), bonesTo(rig, [hand, ...bones.arms]));
    for (let i = 0; i < a.rot.length; i++) expect(b.rot[i]).toBeCloseTo(a.rot[i], 9);
  });

  it('turnBone turns a bone, and what hangs from it, about an axis in the figure\'s frame', () => {
    const { rig } = figure();
    const pose = new Pose(rig.names.length).setRest(rig);
    const joints = createJoints(rig);
    poseJoints(pose, rig, joints.pos, joints.rot);
    const shoulder = at(joints.pos, rig, 'upperarm_l');
    const hand = at(joints.pos, rig, 'hand_l');
    const axis = new THREE.Vector3(0, 0, 1);
    turnBone(pose, rig, rig.index.get('upperarm_l')!, axis, 0.5);
    poseJoints(pose, rig, joints.pos, joints.rot);
    const expected = hand.clone().sub(shoulder).applyAxisAngle(axis, 0.5).add(shoulder);
    const got = at(joints.pos, rig, 'hand_l');
    expect(got.distanceTo(expected)).toBeLessThan(1e-5);
    // Nothing else moved.
    expect(at(joints.pos, rig, 'hand_r').distanceTo(new THREE.Vector3(-hand.x, hand.y, hand.z))).toBeLessThan(1e-5);
  });

  it('aimPose lifts what both hands hold, keeping the hands the same distance apart', () => {
    const { rig } = figure();
    const pose = new Pose(rig.names.length).setRest(rig);
    // Arms forward, as if holding a shaft out in front.
    turnBone(pose, rig, rig.index.get('upperarm_l')!, new THREE.Vector3(0, 1, 0), -Math.PI / 2 + 0.2);
    turnBone(pose, rig, rig.index.get('upperarm_r')!, new THREE.Vector3(0, 1, 0), Math.PI / 2 - 0.2);
    const joints = createJoints(rig);
    poseJoints(pose, rig, joints.pos, joints.rot);
    const l0 = at(joints.pos, rig, 'hand_l');
    const r0 = at(joints.pos, rig, 'hand_r');
    expect(l0.z).toBeGreaterThan(0.4);

    const bones = aimBones(rig)!;
    const raised = new Pose(rig.names.length).copy(pose);
    aimPose(raised, rig, bones, 0.3, createJoints(rig));
    poseJoints(raised, rig, joints.pos, joints.rot);
    const l1 = at(joints.pos, rig, 'hand_l');
    const r1 = at(joints.pos, rig, 'hand_r');
    expect(l1.y).toBeGreaterThan(l0.y + 0.1);
    expect(r1.y).toBeGreaterThan(r0.y + 0.1);
    expect(l1.distanceTo(r1)).toBeCloseTo(l0.distanceTo(r0), 5);

    const lowered = new Pose(rig.names.length).copy(pose);
    aimPose(lowered, rig, bones, -0.3, createJoints(rig));
    poseJoints(lowered, rig, joints.pos, joints.rot);
    expect(at(joints.pos, rig, 'hand_l').y).toBeLessThan(l0.y - 0.1);
    // The legs are not part of it.
    const foot = at(joints.pos, rig, 'ball_l');
    poseJoints(pose, rig, joints.pos, joints.rot);
    expect(foot.distanceTo(at(joints.pos, rig, 'ball_l'))).toBeLessThan(1e-6);
  });

  it('plantFeet puts both soles flat on the floor, the asked distance apart, toes out', () => {
    const { rig, bones } = figure();
    const rest = new Pose(rig.names.length).setRest(rig);
    const joints = createJoints(rig);
    poseJoints(rest, rig, joints.pos, joints.rot);
    const ballY = at(joints.pos, rig, 'ball_l').y;
    const ankleY = at(joints.pos, rig, 'foot_l').y;
    const headY = at(joints.pos, rig, 'head').y;

    const pose = new Pose(rig.names.length).setRest(rig);
    plantFeet(pose, rig, { width: 0.62, toeOut: 0.2, drop: 0.03 });
    const real = worldPositions(pose, rig, bones);
    for (const [side, sign] of [['l', 1], ['r', -1]] as const) {
      const ball = at(real, rig, `ball_${side}`);
      const ankle = at(real, rig, `foot_${side}`);
      expect(ball.x).toBeCloseTo(sign * 0.31, 4);
      expect(ball.y).toBeCloseTo(ballY, 4);
      expect(ankle.y).toBeCloseTo(ankleY, 4);
      // Toes out: the foot points forward and to its own side.
      const toe = ball.clone().sub(ankle);
      expect(Math.atan2(sign * toe.x, toe.z)).toBeCloseTo(0.2, 3);
    }
    expect(at(real, rig, 'ball_l').z).toBeCloseTo(at(real, rig, 'ball_r').z, 5);
    // The hips came down by at least what was asked, and the body with them.
    expect(at(real, rig, 'head').y).toBeLessThanOrEqual(headY - 0.03 + 1e-6);
    // Knees still bend forwards.
    expect(at(real, rig, 'calf_l').z).toBeGreaterThan(at(real, rig, 'thigh_l').z - 0.02);
  });

  it('composes a pose from frames by bone group, and wraps a pose as a clip that holds still', () => {
    const { rig } = figure();
    const standing = new Pose(rig.names.length).setRest(rig);
    const bent = new Pose(rig.names.length).setRest(rig);
    turnBone(bent, rig, rig.index.get('thigh_l')!, new THREE.Vector3(1, 0, 0), -0.6);
    turnBone(bent, rig, rig.index.get('upperarm_l')!, new THREE.Vector3(0, 0, 1), -0.8);
    const a = staticClip('standing', standing);
    const b = staticClip('bent', bent);

    const sampled = new Pose(rig.names.length);
    for (const t of [0, 0.37, 1, 5]) {
      sampleClip(b, t, sampled);
      for (let i = 0; i < sampled.rot.length; i++) expect(sampled.rot[i]).toBeCloseTo(bent.rot[i], 6);
    }

    const mixed = composePose(rig, [
      { clip: a, time: 0 },
      { clip: b, time: 0, group: 'legs' },
    ]);
    const thigh = rig.index.get('thigh_l')! * 4;
    const arm = rig.index.get('upperarm_l')! * 4;
    for (let k = 0; k < 4; k++) {
      expect(mixed.rot[thigh + k]).toBeCloseTo(bent.rot[thigh + k], 6);
      expect(mixed.rot[arm + k]).toBeCloseTo(standing.rot[arm + k], 6);
    }
    expect(Array.from(groupMask(rig, 'armL')).filter((w) => w > 0)).toHaveLength(4);
  });
});
