import * as THREE from 'three';

const T = new THREE.Vector3();
const dir = new THREE.Vector3();
const pole = new THREE.Vector3();
const K2 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();

/**
 * Analytic two-bone IK for a limb with joints `H` (hip), `K` (knee) and `A` (ankle): finds the
 * turns that carry the ankle to `target`, bending in the plane the limb already bends in.
 * `upper` is the turn of the upper bone; `lower` is the further turn of the lower bone on top
 * of it. Both are in the frame the joints are given in, and the lower bone's new orientation
 * is `lower * upper * old`. `fallbackPole` says which way a perfectly straight limb should
 * bend. Returns false if there is nothing to solve.
 */
export function solveTwoBone(H: THREE.Vector3, K: THREE.Vector3, A: THREE.Vector3, target: THREE.Vector3, fallbackPole: THREE.Vector3, upper: THREE.Quaternion, lower: THREE.Quaternion): boolean {
  const l1 = K.distanceTo(H);
  const l2 = A.distanceTo(K);
  if (l1 < 1e-5 || l2 < 1e-5) return false;
  T.copy(target).sub(H);
  let d = T.length();
  if (d < 1e-5) return false;
  dir.copy(T).divideScalar(d);
  // Keep the limb from locking perfectly straight or folding flat.
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 0.002), (l1 + l2) * 0.9995);

  // The knee keeps pointing where it was pointing.
  pole.copy(K).sub(H);
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-8) {
    pole.copy(fallbackPole);
    pole.addScaledVector(dir, -pole.dot(dir));
  }
  pole.normalize();

  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  K2.copy(H).addScaledVector(dir, cosA * l1).addScaledVector(pole, sinA * l1);

  // Upper bone: swing so the knee lands on K2.
  v1.copy(K).sub(H).normalize();
  v2.copy(K2).sub(H).normalize();
  upper.setFromUnitVectors(v1, v2);
  // Lower bone: after that swing, aim the shin at the target.
  v1.copy(A).sub(K).normalize().applyQuaternion(upper);
  v2.copy(H).addScaledVector(dir, d).sub(K2).normalize();
  lower.setFromUnitVectors(v1, v2);
  return true;
}
