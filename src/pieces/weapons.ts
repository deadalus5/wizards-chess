import * as THREE from 'three';
import type { Rig } from '../anim/rig';
import { ASSETS, loadGLTF } from './assets';
import { LAYER, REGION } from './buildPiece';

const _q = new THREE.Quaternion();

/**
 * Local transform that seats a prop in a hand the way the animation library expects:
 * grip (the prop's +Y) along model-forward with the palm facing down in the rest pose.
 */
export function gripTransform(rig: Rig, side: 'r' | 'l', target: THREE.Object3D): void {
  const hand = rig.index.get(`hand_${side}`);
  if (hand === undefined) throw new Error(`rig has no hand_${side}`);
  _q.fromArray(rig.restWorldRot, hand * 4).invert();
  const down = new THREE.Vector3(0, -1, 0).applyQuaternion(_q);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(_q);
  const up = down.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, up);
  target.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, forward, up));
  target.position.set(0, 0.09, 0).addScaledVector(down, 0.035);
  target.scale.set(side === 'l' ? -1 : 1, 1, 1);
}

const propCache = new Map<string, Promise<THREE.BufferGeometry>>();

/**
 * A weapon prop as a single geometry tagged for the stone shader (rendered as metal trim).
 * The prop's own palette texture is not used.
 */
export function loadPropGeometry(name: string, region: number = REGION.trim): Promise<THREE.BufferGeometry> {
  const key = `${name}:${region}`;
  let p = propCache.get(key);
  if (!p) {
    p = loadGLTF(`${ASSETS}/props/${name}.glb`).then((gltf) => {
      gltf.scene.updateWorldMatrix(true, true);
      const positions: number[] = [];
      const normals: number[] = [];
      const indices: number[] = [];
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        const pos = g.getAttribute('position');
        const nor = g.getAttribute('normal');
        const base = positions.length / 3;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          positions.push(v.x, v.y, v.z);
          if (nor) n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
          else n.set(0, 1, 0);
          normals.push(n.x, n.y, n.z);
        }
        if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + base);
        else for (let i = 0; i < pos.count; i++) indices.push(base + i);
      });
      const out = new THREE.BufferGeometry();
      const count = positions.length / 3;
      out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
      const part = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        part[i * 4] = LAYER.flat;
        part[i * 4 + 1] = region;
        part[i * 4 + 3] = 0.37;
      }
      out.setAttribute('aPart', new THREE.BufferAttribute(part, 4));
      out.setIndex(indices);
      out.computeBoundingSphere();
      return out;
    });
    propCache.set(key, p);
  }
  return p;
}
