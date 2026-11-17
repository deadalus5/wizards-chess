import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Rng } from '../core/math';
import { SQUARE } from '../game/squares';
import { ASSETS, loadTexture } from '../pieces/assets';
import { reflectionUniforms } from './reflection';

export const TILE_HEIGHT = 0.16;
const TILE_GAP = 0.014;
/** Metres of stone one repeat of a marble texture covers. */
const MARBLE_SPAN = 2.6;

export type PbrSource = 'ambientcg' | 'polyhaven';

/** A PBR material from one of the downloaded texture sets. */
export async function loadPbrMaterial(id: string, source: PbrSource, params: THREE.MeshStandardMaterialParameters = {}): Promise<THREE.MeshStandardMaterial> {
  const base = `${ASSETS}/textures/${id}`;
  const [map, normalMap, packed] = await Promise.all([
    loadTexture(`${base}/diff.jpg`, { srgb: true, repeat: true, anisotropy: 16 }),
    loadTexture(`${base}/nor_gl.jpg`, { repeat: true, anisotropy: 16 }),
    loadTexture(`${base}/${source === 'ambientcg' ? 'rough' : 'arm'}.jpg`, { repeat: true, anisotropy: 16 }),
  ]);
  const material = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap: packed, roughness: 1, metalness: 0, ...params });
  if (source === 'polyhaven') material.aoMap = packed;
  material.name = id;
  return material;
}

/** A bevelled tile whose top is UV-mapped in metres with a per-tile offset and quarter turn. */
function tileGeometry(rng: Rng): THREE.BufferGeometry {
  const side = SQUARE - TILE_GAP;
  const g = new RoundedBoxGeometry(side, TILE_HEIGHT, side, 3, 0.012);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const ox = rng.range(0, 1);
  const oz = rng.range(0, 1);
  const turn = rng.int(0, 3);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let z = pos.getZ(i);
    for (let t = 0; t < turn; t++) [x, z] = [-z, x];
    uv.setXY(i, x / MARBLE_SPAN + ox, z / MARBLE_SPAN + oz);
  }
  uv.needsUpdate = true;
  return g;
}

export interface BoardMaterials {
  light: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
}

const DIRECT_SPECULAR = 'vec3 specularBRDF = BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );';

/**
 * Polished stone mirrors a point light as a pinprick thousands of times brighter than
 * anything around it, which blooms into a star: the braziers looked like candles standing on
 * the board. Real flames have size. So highlights from the lights are computed as if the
 * surface were a little rougher, while reflections of the surroundings keep the full polish.
 */
function softenLightHighlights(material: THREE.MeshStandardMaterial, floor = 0.48): void {
  material.onBeforeCompile = (shader) => {
    const need = (src: string, token: string): void => {
      if (!src.includes(token)) throw new Error(`board material: shader chunk ${token} not found`);
    };
    const pars = THREE.ShaderChunk.lights_physical_pars_fragment;
    need(pars, DIRECT_SPECULAR);
    need(shader.fragmentShader, '#include <lights_physical_pars_fragment>');
    need(shader.fragmentShader, '#include <lights_fragment_end>');
    need(shader.vertexShader, '#include <begin_vertex>');
    need(shader.vertexShader, '#include <common>');
    need(shader.fragmentShader, '#include <common>');
    Object.assign(shader.uniforms, reflectionUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uReflectionMatrix;\nvarying vec4 vReflection;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvReflection = uReflectionMatrix * ( modelMatrix * vec4( transformed, 1.0 ) );');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tReflection;\nuniform float uReflection;\nvarying vec4 vReflection;')
      .replace(
        '#include <lights_physical_pars_fragment>',
        pars.replace(DIRECT_SPECULAR, `PhysicalMaterial boardDirect = material;\n\tboardDirect.roughness = max( material.roughness, ${floor.toFixed(3)} );\n\tvec3 specularBRDF = BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, boardDirect );`),
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
	if ( uReflection > 0.0 && vReflection.w > 0.0 ) {
		// The mirror image of what stands on the board: rippled a little by the stone's own
		// relief, blurred where it is rougher, and weighted by the angle it is seen at.
		vec2 mirrorUv = vReflection.xy / vReflection.w + ( normal.xy - nonPerturbedNormal.xy ) * 0.05;
		float mirrorBlur = 0.5 + material.roughness * 9.0;
		vec3 mirrorColor = textureLod( tReflection, mirrorUv, mirrorBlur ).rgb;
		float mirrorFresnel = pow( 1.0 - saturate( dot( normal, geometryViewDir ) ), 5.0 );
		float mirrorGloss = 1.0 - smoothstep( 0.12, 0.6, material.roughness );
		reflectedLight.indirectSpecular += mirrorColor * mix( 0.075, 1.0, mirrorFresnel ) * mirrorGloss * uReflection;
	}`,
      );
  };
  material.customProgramCacheKey = () => `board-v3-${floor}`;
}

export async function loadBoardMaterials(): Promise<BoardMaterials> {
  const [light, dark] = await Promise.all([
    loadPbrMaterial('Marble014', 'ambientcg', { roughness: 0.55 }),
    loadPbrMaterial('Marble009', 'ambientcg', { roughness: 0.5 }),
  ]);
  softenLightHighlights(light);
  softenLightHighlights(dark);
  return { light, dark };
}

/**
 * A size x size patch of board tiles centred on the origin, top surface at y = 0.
 * (a1 is dark, so the square at file 0 / rank 0 is dark.)
 */
export function createTiles(size: number, materials: BoardMaterials, seed = 11): THREE.Group {
  const group = new THREE.Group();
  group.name = 'board-tiles';
  const rng = new Rng(seed);
  const half = (size - 1) / 2;
  for (let rank = 0; rank < size; rank++) {
    for (let file = 0; file < size; file++) {
      const dark = (file + rank) % 2 === 0;
      const mesh = new THREE.Mesh(tileGeometry(rng), dark ? materials.dark : materials.light);
      mesh.position.set((file - half) * SQUARE, -TILE_HEIGHT / 2, (half - rank) * SQUARE);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = `tile-${file}-${rank}`;
      group.add(mesh);
    }
  }
  return group;
}
