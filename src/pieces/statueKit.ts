import * as THREE from 'three';
import { bakeClip, type BakedClip } from '../anim/bake';
import { rigFromBones, type Rig } from '../anim/rig';
import { createNoise3D } from '../render/noise3d';
import { createNormalArray } from '../render/normalArray';
import type { StoneShared } from '../render/stoneMaterial';
import { ASSETS, LITE_ASSETS, findSkeleton, loadClipManifest, loadGLTF, loadSourceClip, type ClipInfo } from './assets';
import { LAYER, REGION, skinnedPartsOf, type PiecePart } from './buildPiece';

export type BodyKind = 'male' | 'female';

interface BodySource {
  scene: THREE.Object3D;
  skeleton: THREE.Skeleton;
  rig: Rig;
}

const HAIR_FILES = ['Hair_Beard', 'Hair_Buns', 'Hair_Buzzed', 'Hair_BuzzedFemale', 'Hair_Long', 'Hair_SimpleParted', 'Eyebrows_Regular', 'Eyebrows_Female'] as const;
export type HairName = (typeof HAIR_FILES)[number];

/**
 * Loaded source assets for building statues: the two bodies, hair meshes, the animation
 * library's rig and clip index, and the textures every stone material shares.
 */
export class StatueKit {
  private readonly clipCache = new Map<string, Promise<BakedClip>>();

  private constructor(
    readonly shared: StoneShared,
    readonly sourceRig: Rig,
    private readonly bodies: Record<BodyKind, BodySource>,
    private readonly hair: Map<string, THREE.Object3D>,
    readonly manifest: ClipInfo[],
  ) {}

  /**
   * `lite` loads the smaller copies of the normal maps made for phones and tablets (assets/lite)
   * and lets go of the array's CPU copy once it is uploaded.
   */
  static async load(normalSize = 2048, lite = false): Promise<StatueKit> {
    const sh = `${ASSETS}/models/superhero`;
    const small = `${LITE_ASSETS}/models`;
    const [male, female, mannequin, manifest, normals, ...hairScenes] = await Promise.all([
      loadGLTF(`${sh}/Superhero_Male_FullBody.gltf`),
      loadGLTF(`${sh}/Superhero_Female_FullBody.gltf`),
      loadGLTF(`${ASSETS}/models/m2m-human.glb`),
      loadClipManifest(),
      // Order must match LAYER (index 0 is the built-in flat layer).
      createNormalArray(
        lite
          ? [
              `${small}/superhero/T_Superhero_Male_Normal.jpg`,
              `${small}/superhero/T_Superhero_Female_Normal.jpg`,
              `${small}/superhero/T_Hair_1_Normal.jpg`,
              `${small}/superhero/T_Hair_2_Normal.jpg`,
              `${small}/chess_set/textures/chess_set_pieces_white_nor_gl_1k.jpg`,
            ]
          : [
              `${sh}/T_Superhero_Male_Normal.png`,
              `${sh}/T_Superhero_Female_Normal.png`,
              `${sh}/T_Hair_1_Normal.png`,
              `${sh}/T_Hair_2_Normal.png`,
              `${ASSETS}/models/chess_set/textures/chess_set_pieces_white_nor_gl_2k.jpg`,
            ],
        normalSize,
        lite,
      ),
      ...HAIR_FILES.map((h) => loadGLTF(`${sh}/${h}.gltf`)),
    ]);

    const sourceSkeleton = findSkeleton(mannequin.scene);
    if (!sourceSkeleton) throw new Error('animation rig has no skeleton');
    const { rig: sourceRig } = rigFromBones(sourceSkeleton.bones);

    const body = (scene: THREE.Object3D): BodySource => {
      const skeleton = findSkeleton(scene);
      if (!skeleton) throw new Error('body has no skeleton');
      return { scene, skeleton, rig: rigFromBones(skeleton.bones).rig };
    };

    const shared: StoneShared = {
      tNoise: { value: createNoise3D(64, 7) },
      tNormals: { value: normals },
      uTime: { value: 0 },
    };
    const hair = new Map<string, THREE.Object3D>(HAIR_FILES.map((h, i) => [h, hairScenes[i].scene]));
    return new StatueKit(shared, sourceRig, { male: body(male.scene), female: body(female.scene) }, hair, manifest);
  }

  skeleton(kind: BodyKind): THREE.Skeleton {
    return this.bodies[kind].skeleton;
  }

  /** Body, eyes and eyebrows of one body type, plus any hair meshes, as parts to merge. */
  bodyParts(kind: BodyKind, hair: readonly HairName[] = []): PiecePart[] {
    const source = this.bodies[kind];
    const hairLayer = (name: string): number => (/Hair_2/i.test(name) ? LAYER.hair2 : LAYER.hair1);
    const parts = skinnedPartsOf(source.scene, source.skeleton, (mesh) => {
      const material = (mesh.material as THREE.Material).name;
      if (/Eyes/i.test(material)) return { layer: LAYER.flat, region: REGION.eye };
      if (/Hair/i.test(material)) return { layer: hairLayer(material), region: REGION.stone };
      return { layer: kind === 'male' ? LAYER.male : LAYER.female, region: REGION.stone, fracture: 'body' as const };
    });
    for (const name of hair) {
      const scene = this.hair.get(name);
      if (!scene) throw new Error(`unknown hair ${name}`);
      parts.push(
        ...skinnedPartsOf(scene, source.skeleton, (mesh) => ({
          layer: hairLayer((mesh.material as THREE.Material).name),
          region: REGION.stone,
        })),
      );
    }
    return parts;
  }

  rig(kind: BodyKind): Rig {
    return this.bodies[kind].rig;
  }

  /** A clip from the animation library, retargeted to one body type's rig (cached). */
  clip(kind: BodyKind, name: string): Promise<BakedClip> {
    const key = `${kind}:${name}`;
    let p = this.clipCache.get(key);
    if (!p) {
      const info = this.manifest.find((c) => c.name === name);
      if (!info) throw new Error(`unknown clip ${name}`);
      p = loadSourceClip(info).then((source) => bakeClip(source, this.sourceRig, this.bodies[kind].rig, { loop: info.loop, name }));
      this.clipCache.set(key, p);
    }
    return p;
  }
}
