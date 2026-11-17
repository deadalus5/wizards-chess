import * as THREE from 'three';
import { Pose, poseJoints } from '../anim/pose';
import { canon, rigFromBones, type Rig } from '../anim/rig';
import { fractureMesh, type BoneInfo, type ChunkInfo, type FractureMode, type MeshData, type PartRange } from './fracture';

/** Layers of the shared normal-map array. */
export const LAYER = { flat: 0, male: 1, female: 2, hair1: 3, hair2: 4, chess: 5 } as const;
/** Surface regions the stone shader distinguishes. */
export const REGION = { stone: 0, trim: 1, eye: 2, plate: 3 } as const;

/** One ingredient of a statue: a piece of geometry in bind-pose (armature) space. */
export interface PiecePart {
  geometry: THREE.BufferGeometry;
  layer: number;
  region: number;
  /** Rigid parts name the bone they follow; skinned parts carry skinIndex / skinWeight. */
  bone?: string;
  /**
   * How the part breaks: 'body' is partitioned into chunks, 'own' falls away as a single
   * chunk (a crown), and the default 'attach' rides on the body chunk beneath it.
   */
  fracture?: FractureMode;
}

/** Everything needed to stamp out statues of one design. */
export interface PieceTemplate {
  /** Pre-fractured geometry; its index draws the intact surface only. */
  geometry: THREE.BufferGeometry;
  /** Same vertex buffers with an index that adds the interior faces of every chunk. */
  shatterGeometry: THREE.BufferGeometry;
  chunks: ChunkInfo[];
  /** Number of body triangles at the start of the surface index (the part that is partitioned). */
  bodyTriangles: number;
  /** Rest-pose bone hierarchy, cloned per statue. */
  rootBone: THREE.Bone;
  /** Bone names in skeleton (skin index) order. */
  boneNames: string[];
  boneInverses: THREE.Matrix4[];
  /** Parents-first description used by the animation code. */
  rig: Rig;
  /** rig index -> skeleton index */
  rigToSkeleton: Int16Array;
}

export interface PieceInstance {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  /** Bones in rig (parents-first) order. */
  bones: THREE.Bone[];
  byName: Map<string, THREE.Bone>;
}

/**
 * Collect the skinned meshes under `root` as parts, with joint indices remapped onto
 * `reference` (hair files ship their own copy of the skeleton).
 */
export function skinnedPartsOf(
  root: THREE.Object3D,
  reference: THREE.Skeleton,
  classify: (mesh: THREE.SkinnedMesh) => { layer: number; region: number; fracture?: FractureMode } | null,
): PiecePart[] {
  const refIndex = new Map(reference.bones.map((b, i) => [canon(b.name), i]));
  const parts: PiecePart[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const kind = classify(m);
    if (!kind) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.bindMatrix);
    if (m.skeleton !== reference) {
      const map = m.skeleton.bones.map((b) => {
        const i = refIndex.get(canon(b.name));
        if (i === undefined) throw new Error(`bone ${b.name} missing from the reference skeleton`);
        return i;
      });
      const skin = g.getAttribute('skinIndex');
      const remapped = new Uint16Array(skin.count * 4);
      for (let i = 0; i < skin.count; i++) {
        remapped[i * 4] = map[skin.getX(i)];
        remapped[i * 4 + 1] = map[skin.getY(i)];
        remapped[i * 4 + 2] = map[skin.getZ(i)];
        remapped[i * 4 + 3] = map[skin.getW(i)];
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(remapped, 4));
    }
    parts.push({ geometry: g, layer: kind.layer, region: kind.region, fracture: kind.fracture });
  });
  return parts;
}

/** Concatenate parts into flat arrays, the body first. */
function mergeParts(parts: readonly PiecePart[], boneIndex: Map<string, number>): { mesh: MeshData; ranges: PartRange[] } {
  const ordered = [...parts].sort((a, b) => Number(b.fracture === 'body') - Number(a.fracture === 'body'));
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of ordered) {
    const pos = p.geometry.getAttribute('position');
    vertexCount += pos.count;
    indexCount += p.geometry.index ? p.geometry.index.count : pos.count;
  }
  const mesh: MeshData = {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    skinIndex: new Uint16Array(vertexCount * 4),
    skinWeight: new Float32Array(vertexCount * 4),
    part: new Float32Array(vertexCount * 4),
    index: new Uint32Array(indexCount),
  };
  const ranges: PartRange[] = [];
  let v0 = 0;
  let i0 = 0;
  for (const p of ordered) {
    const g = p.geometry;
    const pos = g.getAttribute('position');
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const nor = g.getAttribute('normal');
    const tex = g.getAttribute('uv');
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    // Optional per-vertex distance to the edge of an armour plate (drives the gilded edge band).
    const band = g.getAttribute('band');
    const rigidBone = p.bone !== undefined ? boneIndex.get(canon(p.bone)) : undefined;
    if (p.bone !== undefined && rigidBone === undefined) throw new Error(`unknown bone ${p.bone}`);
    if (rigidBone === undefined && (!si || !sw)) throw new Error('part has neither skin weights nor a bone');

    for (let i = 0; i < pos.count; i++) {
      const v = v0 + i;
      mesh.position[v * 3] = pos.getX(i);
      mesh.position[v * 3 + 1] = pos.getY(i);
      mesh.position[v * 3 + 2] = pos.getZ(i);
      mesh.normal[v * 3] = nor.getX(i);
      mesh.normal[v * 3 + 1] = nor.getY(i);
      mesh.normal[v * 3 + 2] = nor.getZ(i);
      if (tex) {
        mesh.uv[v * 2] = tex.getX(i);
        mesh.uv[v * 2 + 1] = tex.getY(i);
      }
      if (rigidBone !== undefined) {
        mesh.skinIndex[v * 4] = rigidBone;
        mesh.skinWeight[v * 4] = 1;
      } else {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          mesh.skinIndex[v * 4 + k] = si.getComponent(i, k);
          const w = sw.getComponent(i, k);
          mesh.skinWeight[v * 4 + k] = w;
          sum += w;
        }
        if (sum > 1e-6) for (let k = 0; k < 4; k++) mesh.skinWeight[v * 4 + k] /= sum;
        else mesh.skinWeight[v * 4] = 1;
      }
      mesh.part[v * 4] = p.layer;
      mesh.part[v * 4 + 1] = p.region;
      mesh.part[v * 4 + 2] = 0;
      mesh.part[v * 4 + 3] = band ? band.getX(i) : 1;
    }
    const triStart = i0 / 3;
    if (g.index) {
      const src = g.index;
      for (let i = 0; i < src.count; i++) mesh.index[i0 + i] = src.getX(i) + v0;
      i0 += src.count;
    } else {
      for (let i = 0; i < pos.count; i++) mesh.index[i0 + i] = v0 + i;
      i0 += pos.count;
    }
    ranges.push({ triStart, triCount: i0 / 3 - triStart, mode: p.fracture ?? 'attach' });
    v0 += pos.count;
  }
  return { mesh, ranges };
}

export interface TemplateOptions {
  /** Number of chunks the body breaks into. */
  chunks?: number;
  seed?: number;
}

/** Merge parts into one pre-fractured skinned geometry and capture the skeleton to clone per statue. */
export function buildTemplate(parts: readonly PiecePart[], reference: THREE.Skeleton, options: TemplateOptions = {}): PieceTemplate {
  const boneNames = reference.bones.map((b) => b.name);
  const boneIndex = new Map(boneNames.map((n, i) => [canon(n), i]));
  const { rig, ordered } = rigFromBones(reference.bones);
  const rigToSkeleton = Int16Array.from(ordered, (b) => reference.bones.indexOf(b as THREE.Bone));

  // Bind-pose joint positions and parents in skeleton order, for placing the interior faces.
  const jointsRig = new Float32Array(rig.names.length * 3);
  poseJoints(new Pose(rig.names.length).setRest(rig), rig, jointsRig);
  const bones: BoneInfo = { position: new Float32Array(boneNames.length * 3), parent: new Int16Array(boneNames.length).fill(-1), names: boneNames.map(canon) };
  for (let r = 0; r < rig.names.length; r++) {
    const s = rigToSkeleton[r];
    bones.position.set(jointsRig.subarray(r * 3, r * 3 + 3), s * 3);
    bones.parent[s] = rig.parent[r] >= 0 ? rigToSkeleton[rig.parent[r]] : -1;
  }

  const { mesh, ranges } = mergeParts(parts, boneIndex);
  const fractured = fractureMesh(mesh, ranges, bones, { chunks: options.chunks ?? 46, seed: options.seed ?? 1 });
  const d = fractured.data;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(d.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(d.skinWeight, 4));
  geometry.setAttribute('aPart', new THREE.BufferAttribute(d.part, 4));
  geometry.setAttribute('aChunk', new THREE.BufferAttribute(fractured.chunk, 1));
  geometry.setIndex(new THREE.BufferAttribute(fractured.surfaceIndex, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Shares every vertex buffer; only the index differs.
  const shatterGeometry = new THREE.BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) shatterGeometry.setAttribute(name, geometry.getAttribute(name));
  shatterGeometry.setIndex(new THREE.BufferAttribute(fractured.fullIndex, 1));
  shatterGeometry.boundingBox = geometry.boundingBox;
  shatterGeometry.boundingSphere = geometry.boundingSphere;

  const top = reference.bones.find((b) => !(b.parent as THREE.Bone | null)?.isBone);
  if (!top) throw new Error('skeleton has no root bone');

  return {
    geometry,
    shatterGeometry,
    chunks: fractured.chunks,
    bodyTriangles: ranges[0].mode === 'body' ? ranges[0].triCount : 0,
    rootBone: top.clone(true) as THREE.Bone,
    boneNames,
    boneInverses: reference.boneInverses.map((m) => m.clone()),
    rig,
    rigToSkeleton,
  };
}

const IDENTITY = new THREE.Matrix4();

/** Create one statue from a template: its own bones and skeleton, shared geometry. */
export function instantiatePiece(template: PieceTemplate, material: THREE.Material): PieceInstance {
  const rootBone = template.rootBone.clone(true) as THREE.Bone;
  const byName = new Map<string, THREE.Bone>();
  rootBone.traverse((o) => {
    if ((o as THREE.Bone).isBone) byName.set(canon(o.name), o as THREE.Bone);
  });
  const skeletonBones = template.boneNames.map((n) => {
    const b = byName.get(canon(n));
    if (!b) throw new Error(`bone ${n} missing after clone`);
    return b;
  });
  const skeleton = new THREE.Skeleton(skeletonBones, template.boneInverses);
  const mesh = new THREE.SkinnedMesh(template.geometry, material);
  mesh.name = 'statue';
  // Skinned bounds are computed once in bind pose and never follow the animation, so a lunge or
  // a leap would be culled while still on screen.
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const root = new THREE.Group();
  root.add(rootBone);
  root.add(mesh);
  mesh.bind(skeleton, IDENTITY);

  const bones = Array.from(template.rigToSkeleton, (i) => skeletonBones[i]);
  return { root, mesh, skeleton, bones, byName };
}
