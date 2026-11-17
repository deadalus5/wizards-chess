import type { BakedClip } from './bake';
import { Pose, poseJoints, sampleClip } from './pose';
import type { Rig } from './rig';

/**
 * What a locomotion clip does to the ground, measured from the motion itself.
 * The clips are in place (the body stays at the origin while the feet slide back), so the
 * speed the body must travel for the planted foot not to slide is the speed the foot moves
 * backwards while it is on the ground.
 */
export interface Gait {
  clip: BakedClip;
  /** Ground speed in metres per second at clip rate 1 and model scale 1. */
  speed: number;
  /** Direction of travel in model space (x, z), unit length: +z is forward. */
  dir: [number, number];
  /** Distance covered by one full cycle of the clip, metres. */
  cycle: number;
  /** Phase (0..1) of a passing pose: one foot planted under the body, the other swinging by. */
  passing: number;
  /** Phases (0..1) at which the left and right foot touch down. */
  contacts: [number, number];
}

const SAMPLES = 96;

export function analyzeGait(clip: BakedClip, rig: Rig): Gait {
  const left = rig.index.get('ball_l') ?? rig.index.get('foot_l');
  const right = rig.index.get('ball_r') ?? rig.index.get('foot_r');
  if (left === undefined || right === undefined) throw new Error('rig has no foot bones');
  const n = rig.names.length;
  const pose = new Pose(n);
  const joints = new Float32Array(n * 3);
  const feet = [left, right];
  // x, y, z per sample per foot
  const track = feet.map(() => new Float32Array(SAMPLES * 3));
  for (let i = 0; i < SAMPLES; i++) {
    sampleClip(clip, (i / SAMPLES) * clip.duration, pose);
    poseJoints(pose, rig, joints);
    feet.forEach((bone, f) => track[f].set(joints.subarray(bone * 3, bone * 3 + 3), i * 3));
  }

  const dt = clip.duration / SAMPLES;
  let vx = 0;
  let vz = 0;
  let count = 0;
  const contacts: [number, number] = [0, 0.5];
  const stance = feet.map(() => new Uint8Array(SAMPLES));
  feet.forEach((_, f) => {
    const t = track[f];
    let minY = Infinity;
    for (let i = 0; i < SAMPLES; i++) minY = Math.min(minY, t[i * 3 + 1]);
    for (let i = 0; i < SAMPLES; i++) stance[f][i] = t[i * 3 + 1] < minY + 0.03 ? 1 : 0;
    for (let i = 0; i < SAMPLES; i++) {
      const prev = (i + SAMPLES - 1) % SAMPLES;
      const next = (i + 1) % SAMPLES;
      if (stance[f][i] && stance[f][prev] && stance[f][next]) {
        // The planted foot moves opposite to the direction of travel.
        vx -= (t[next * 3] - t[prev * 3]) / (2 * dt);
        vz -= (t[next * 3 + 2] - t[prev * 3 + 2]) / (2 * dt);
        count++;
      }
      if (stance[f][i] && !stance[f][prev]) contacts[f] = i / SAMPLES;
    }
  });
  if (count > 0) {
    vx /= count;
    vz /= count;
  }
  const speed = Math.hypot(vx, vz);
  const dir: [number, number] = speed > 1e-4 ? [vx / speed, vz / speed] : [0, 1];

  // Passing pose: the feet are level along the direction of travel.
  let passing = 0;
  let best = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const dx = track[0][i * 3] - track[1][i * 3];
    const dz = track[0][i * 3 + 2] - track[1][i * 3 + 2];
    const along = Math.abs(dx * dir[0] + dz * dir[1]);
    if (along < best) {
      best = along;
      passing = i / SAMPLES;
    }
  }
  return { clip, speed, dir, cycle: speed * clip.duration, passing, contacts };
}
