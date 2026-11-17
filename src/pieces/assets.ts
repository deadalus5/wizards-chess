import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// BASE_URL is '/' in dev and the Pages sub-path in builds; it always ends with a slash.
export const ASSETS = `${import.meta.env.BASE_URL}assets`;

const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
const textureLoader = new THREE.TextureLoader();

const gltfCache = new Map<string, Promise<GLTF>>();

export function loadGLTF(url: string): Promise<GLTF> {
  let p = gltfCache.get(url);
  if (!p) {
    p = gltfLoader.loadAsync(url);
    gltfCache.set(url, p);
  }
  return p;
}

export interface TextureOptions {
  srgb?: boolean;
  repeat?: boolean;
  /** glTF UVs expect unflipped images. */
  flipY?: boolean;
  anisotropy?: number;
}

const textureCache = new Map<string, Promise<THREE.Texture>>();

export function loadTexture(url: string, opts: TextureOptions = {}): Promise<THREE.Texture> {
  const key = url + JSON.stringify(opts);
  let p = textureCache.get(key);
  if (!p) {
    p = textureLoader.loadAsync(url).then((tex) => {
      tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.flipY = opts.flipY ?? true;
      if (opts.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = opts.anisotropy ?? 8;
      tex.needsUpdate = true;
      return tex;
    });
    textureCache.set(key, p);
  }
  return p;
}

export interface ClipInfo {
  name: string;
  file: string;
  loop: boolean;
  root_motion: boolean;
  duration: number;
  frame_count: number;
  tags: string[];
}

let manifestPromise: Promise<ClipInfo[]> | null = null;

/** The animation library's index: every human clip with its duration and loop flag. */
export function loadClipManifest(): Promise<ClipInfo[]> {
  manifestPromise ??= fetch(`${ASSETS}/anim/manifest.json`)
    .then((r) => r.json())
    .then((m) => m.rigs.human.animations as ClipInfo[]);
  return manifestPromise;
}

export async function loadSourceClip(info: ClipInfo): Promise<THREE.AnimationClip> {
  const file = info.file.split('/').pop()!;
  const gltf = await loadGLTF(`${ASSETS}/anim/human/${file}`);
  const clip = gltf.animations[0];
  if (!clip) throw new Error(`no animation in ${file}`);
  return clip;
}

/** Collect the bones of the first skeleton found under `root`. */
export function findSkeleton(root: THREE.Object3D): THREE.Skeleton | null {
  let skeleton: THREE.Skeleton | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!skeleton && m.isSkinnedMesh) skeleton = m.skeleton;
  });
  return skeleton;
}

export function findSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
  });
  return out;
}
