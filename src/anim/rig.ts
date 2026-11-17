import * as THREE from 'three';

/** Bone names differ only by case between the animation rig (`head`) and the bodies (`Head`). */
export const canon = (name: string): string => name.toLowerCase();

/**
 * Rest-pose description of a skeleton, in a form convenient for retargeting:
 * bones are stored parents-first so world rotations can be accumulated in one pass.
 */
export interface Rig {
  names: string[];
  index: Map<string, number>;
  parent: Int16Array;
  /** Local rest rotation, 4 floats per bone. */
  restRot: Float32Array;
  /** Local rest position, 3 floats per bone. */
  restPos: Float32Array;
  /** Rest rotation accumulated from the root bone, 4 floats per bone. */
  restWorldRot: Float32Array;
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/**
 * Build a Rig from bone objects in their rest pose. Call before anything animates them.
 * `bones` may be in any order; the result is ordered parents-first.
 */
export function rigFromBones(bones: readonly THREE.Object3D[]): { rig: Rig; ordered: THREE.Object3D[] } {
  const set = new Set(bones);
  const ordered: THREE.Object3D[] = [];
  const visit = (b: THREE.Object3D): void => {
    if (ordered.includes(b)) return;
    if (b.parent && set.has(b.parent)) visit(b.parent);
    ordered.push(b);
  };
  bones.forEach(visit);

  const n = ordered.length;
  const names = ordered.map((b) => canon(b.name));
  const index = new Map(names.map((name, i) => [name, i]));
  const parent = new Int16Array(n);
  const restRot = new Float32Array(n * 4);
  const restPos = new Float32Array(n * 3);
  const restWorldRot = new Float32Array(n * 4);

  for (let i = 0; i < n; i++) {
    const b = ordered[i];
    parent[i] = b.parent && set.has(b.parent) ? ordered.indexOf(b.parent) : -1;
    b.quaternion.toArray(restRot, i * 4);
    b.position.toArray(restPos, i * 3);
    if (parent[i] < 0) {
      b.quaternion.toArray(restWorldRot, i * 4);
    } else {
      qa.fromArray(restWorldRot, parent[i] * 4);
      qb.copy(b.quaternion);
      qa.multiply(qb).toArray(restWorldRot, i * 4);
    }
  }
  return { rig: { names, index, parent, restRot, restPos, restWorldRot }, ordered };
}
