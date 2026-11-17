import * as THREE from 'three';

/** Textures and clock shared by every stone material. */
export interface StoneShared {
  tNoise: THREE.IUniform<THREE.Data3DTexture | null>;
  tNormals: THREE.IUniform<THREE.DataArrayTexture | null>;
  uTime: THREE.IUniform<number>;
}

/** The look of one kind of stone (one per army). */
export interface StoneLook {
  base: THREE.ColorRepresentation;
  /** Second tone the base drifts towards in broad clouds. */
  base2: THREE.ColorRepresentation;
  vein: THREE.ColorRepresentation;
  /** Vein half-width in noise units (0.02 hairline .. 0.1 bold). */
  veinWidth: number;
  /** Soft discolouration around the main veins, 0..1. */
  veinHalo: number;
  /** How strongly veins tint the stone, 0..1. */
  veinAmount: number;
  /** Added roughness on veins (calcite veins polish differently from the body). */
  veinRoughness: number;
  /** 0 = veins everywhere, 1 = only in a few patches. */
  veinSparsity: number;
  /** Strength of the finer secondary veining, 0..1. */
  veinFine: number;
  roughness: number;
  roughnessVariation: number;
  /** Fine surface relief. */
  bump: number;
  normalScale: number;
  /** How far diffuse light wraps past the terminator (a cheap stand-in for subsurface scatter). */
  sssWrap: number;
  /** Colour of the light that scatters through the stone near the terminator. */
  sssTint: THREE.ColorRepresentation;
  /** Strength of patina in crevices, 0..1. */
  cavity: number;
  /** Colour the stone is multiplied by in crevices. */
  cavityColor: THREE.ColorRepresentation;
  /** Brightening and polish on worn convex edges. */
  edgeWear: number;
  /** Tint of carved armour plates relative to the body stone. */
  plateTint: THREE.ColorRepresentation;
  /** Roughness multiplier for armour plates (below 1 = more polished than the body). */
  platePolish: number;
  /** Width of the metal edge band on armour plates, metres. */
  plateBand: number;
  trim: THREE.ColorRepresentation;
  trimRoughness: number;
  /** Multiplier on environment reflections for metal trim (a dark hall leaves metal with little to reflect). */
  trimEnv: number;
  glow: THREE.ColorRepresentation;
  /** Noise tiling: larger means smaller features. */
  scale: number;
}

export const IVORY: StoneLook = {
  base: new THREE.Color(0.8, 0.79, 0.765),
  base2: new THREE.Color(0.7, 0.705, 0.71),
  vein: new THREE.Color(0.4, 0.42, 0.45),
  veinWidth: 0.022,
  veinHalo: 0.5,
  veinAmount: 0.7,
  veinRoughness: 0.06,
  veinSparsity: 0.25,
  veinFine: 0.5,
  roughness: 0.36,
  roughnessVariation: 0.05,
  bump: 0.1,
  normalScale: 1.0,
  sssWrap: 0.32,
  sssTint: new THREE.Color(1.0, 0.8, 0.62),
  cavity: 0.7,
  cavityColor: new THREE.Color(0.6, 0.55, 0.5),
  edgeWear: 0.07,
  plateTint: new THREE.Color(0.93, 0.9, 0.84),
  platePolish: 0.7,
  plateBand: 0.011,
  trim: new THREE.Color(1.0, 0.78, 0.42),
  trimRoughness: 0.28,
  trimEnv: 3.0,
  glow: new THREE.Color(1.0, 0.56, 0.12),
  scale: 1.0,
};

export const OBSIDIAN: StoneLook = {
  base: new THREE.Color(0.014, 0.015, 0.018),
  base2: new THREE.Color(0.034, 0.036, 0.042),
  vein: new THREE.Color(0.6, 0.62, 0.66),
  veinWidth: 0.02,
  veinHalo: 0.04,
  veinAmount: 0.8,
  veinRoughness: 0.2,
  veinSparsity: 0.58,
  veinFine: 0.4,
  roughness: 0.15,
  roughnessVariation: 0.04,
  bump: 0.12,
  normalScale: 1.0,
  sssWrap: 0.0,
  sssTint: new THREE.Color(1, 1, 1),
  cavity: 0.0,
  cavityColor: new THREE.Color(1, 1, 1),
  edgeWear: 0.0,
  plateTint: new THREE.Color(1.9, 1.9, 2.0),
  platePolish: 1.0,
  plateBand: 0.011,
  trim: new THREE.Color(0.86, 0.88, 0.92),
  trimRoughness: 0.24,
  trimEnv: 3.0,
  glow: new THREE.Color(0.1, 0.72, 1.0),
  scale: 1.0,
};

export interface StoneUniforms {
  [uniform: string]: THREE.IUniform;
  tNoise: THREE.IUniform;
  tNormals: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uBase: THREE.IUniform<THREE.Color>;
  uBase2: THREE.IUniform<THREE.Color>;
  uVeinColor: THREE.IUniform<THREE.Color>;
  /** x width, y halo, z amount, w roughness added on veins */
  uVein: THREE.IUniform<THREE.Vector4>;
  /** x sparsity, y fine-vein strength */
  uVein2: THREE.IUniform<THREE.Vector4>;
  /** x roughness, y roughness variation, z bump, w normal-map scale */
  uSurface: THREE.IUniform<THREE.Vector4>;
  /** rgb scatter tint, a wrap amount */
  uSss: THREE.IUniform<THREE.Vector4>;
  /** x curvature scale, y patina strength, z edge wear, w trim environment boost */
  uCavity: THREE.IUniform<THREE.Vector4>;
  uCavityColor: THREE.IUniform<THREE.Color>;
  /** rgb tint of armour plates, a roughness multiplier */
  uPlate: THREE.IUniform<THREE.Vector4>;
  /** Width of the metal edge band on plates, metres. */
  uBand: THREE.IUniform<number>;
  uTrim: THREE.IUniform<THREE.Color>;
  uTrimRough: THREE.IUniform<number>;
  uGlowColor: THREE.IUniform<THREE.Color>;
  /** x vein glow, y eye glow, z dissolve, w heat of freshly broken faces */
  uLife: THREE.IUniform<THREE.Vector4>;
  uSeed: THREE.IUniform<THREE.Vector3>;
  uScale: THREE.IUniform<number>;
}

const VERTEX_PARS = /* glsl */ `
attribute vec4 aPart;
varying vec3 vStonePos;
varying vec4 vPart;
varying vec2 vStoneUv;
`;

// Shatter variant: every chunk of the pre-fractured statue moves by its own rigid matrix,
// applied after skinning, read from a float texture (one row of four texels per chunk).
const CHUNK_PARS = /* glsl */ `
#ifdef STONE_SHATTER
attribute float aChunk;
uniform highp sampler2D tChunks;
mat4 stoneChunkMatrix() {
  int row = int( aChunk + 0.5 );
  return mat4(
    texelFetch( tChunks, ivec2( 0, row ), 0 ),
    texelFetch( tChunks, ivec2( 1, row ), 0 ),
    texelFetch( tChunks, ivec2( 2, row ), 0 ),
    texelFetch( tChunks, ivec2( 3, row ), 0 ) );
}
#endif
`;
const CHUNK_BASE = /* glsl */ `
#ifdef STONE_SHATTER
  mat4 stoneCM = stoneChunkMatrix();
#endif
`;
const CHUNK_NORMAL = /* glsl */ `
#ifdef STONE_SHATTER
  objectNormal = mat3( stoneCM ) * objectNormal;
#endif
`;
const CHUNK_POSITION = /* glsl */ `
#ifdef STONE_SHATTER
  transformed = ( stoneCM * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

/** Add the per-chunk transform to a vertex shader (used by the colour and depth materials). */
function patchChunkVertex(vertexShader: string, withNormals: boolean): string {
  const need = (token: string): void => {
    if (!vertexShader.includes(token)) throw new Error(`stone material: vertex chunk ${token} not found`);
  };
  need('#include <common>');
  need('#include <skinbase_vertex>');
  need('#include <skinning_vertex>');
  let v = vertexShader.replace('#include <common>', `#include <common>\n${CHUNK_PARS}`);
  v = v.replace('#include <skinbase_vertex>', `#include <skinbase_vertex>\n${CHUNK_BASE}`);
  if (withNormals) {
    need('#include <skinnormal_vertex>');
    v = v.replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>\n${CHUNK_NORMAL}`);
  }
  return v.replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${CHUNK_POSITION}`);
}

// Bind-pose position: captured before skinning so the stone pattern is locked to the sculpt.
const VERTEX_BEGIN = /* glsl */ `
vStonePos = position;
vPart = aPart;
vStoneUv = uv;
`;

const FRAGMENT_PARS = /* glsl */ `
uniform highp sampler3D tNoise;
uniform highp sampler2DArray tNormals;
uniform float uTime;
uniform vec3 uBase;
uniform vec3 uBase2;
uniform vec3 uVeinColor;
uniform vec4 uVein;
uniform vec4 uVein2;
uniform vec4 uSurface;
uniform vec4 uSss;
uniform vec4 uCavity;
uniform vec3 uCavityColor;
uniform vec4 uPlate;
uniform float uBand;
uniform vec3 uTrim;
uniform float uTrimRough;
uniform vec3 uGlowColor;
uniform vec4 uLife;
uniform vec3 uSeed;
uniform float uScale;
varying vec3 vStonePos;
varying vec4 vPart;
varying vec2 vStoneUv;

// Read by the patched direct-lighting function; set in main().
vec4 stoneSss = vec4( 1.0, 1.0, 1.0, 0.0 );

// Tangent frame from screen-space derivatives (no vertex tangents needed).
mat3 stoneTangentFrame( vec3 eyePos, vec3 surfNorm, vec2 uv ) {
  vec3 q0 = dFdx( eyePos );
  vec3 q1 = dFdy( eyePos );
  vec2 st0 = dFdx( uv );
  vec2 st1 = dFdy( uv );
  vec3 q1perp = cross( q1, surfNorm );
  vec3 q0perp = cross( surfNorm, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, surfNorm );
}

vec3 stoneBump( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sigmaX = normalize( dFdx( surfPos ) );
  vec3 sigmaY = normalize( dFdy( surfPos ) );
  vec3 r1 = cross( sigmaY, surfNorm );
  vec3 r2 = cross( surfNorm, sigmaX );
  float det = dot( sigmaX, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}
`;

// Replaces <map_fragment>: solid marble from the 3D noise field.
const FRAGMENT_COLOR = /* glsl */ `
vec3 stoneP = vStonePos * uScale + uSeed;
vec4 stoneLow = texture( tNoise, stoneP * 0.23 );
vec3 stoneWarp = stoneLow.xyz - 0.5;
vec4 stoneMain = texture( tNoise, stoneP * 0.52 + stoneWarp * 0.42 );
vec4 stoneFine = texture( tNoise, stoneP * 1.73 + stoneWarp * 0.9 + 0.31 );
vec4 stoneGrain = texture( tNoise, stoneP * 9.1 );

// Veins are the 0.5 iso-surfaces of the noise fields: sheets through the stone that show as
// lines where they meet the surface, wider where they meet it at a shallow angle.
float stoneD1 = abs( stoneMain.r - 0.5 ) * 2.0;
float stoneAA1 = fwidth( stoneD1 ) * 1.25 + 1e-4;
// Veins gather in patches rather than covering the stone evenly.
float stoneSparse = smoothstep( uVein2.x - 0.12, uVein2.x + 0.12, stoneLow.b );
float stoneVein1 = ( 1.0 - smoothstep( uVein.x - stoneAA1, uVein.x + stoneAA1, stoneD1 ) ) * mix( 1.0, stoneSparse, step( 0.001, uVein2.x ) );
float stoneD2 = abs( stoneFine.g - 0.5 ) * 2.0;
float stoneAA2 = fwidth( stoneD2 ) * 1.25 + 1e-4;
float stoneVein2 = ( 1.0 - smoothstep( uVein.x * 0.5 - stoneAA2, uVein.x * 0.5 + stoneAA2, stoneD2 ) ) * smoothstep( 0.5, 0.7, stoneLow.a ) * uVein2.y;
float stoneVein = clamp( stoneVein1 + stoneVein2, 0.0, 1.0 );
float stoneHalo = ( 1.0 - smoothstep( 0.0, uVein.x * 7.0, stoneD1 ) ) * uVein.y * stoneSparse;

// Dissolve: rubble crumbles away along the stone's own grain.
float stoneDissolveN = stoneFine.b * 0.55 + stoneGrain.g * 0.45;
float stoneDissolveAt = uLife.z * 1.2 - 0.1;
if ( uLife.z > 0.0 && stoneDissolveN < stoneDissolveAt ) discard;

float stoneRegion = floor( vPart.y + 0.5 );
float stoneIsPlate = step( 2.5, stoneRegion );
// Armour plates are carved stone with a metal band along their edges.
float stoneBandAA = fwidth( vPart.w ) + 1e-5;
float stoneIsBand = stoneIsPlate * ( 1.0 - smoothstep( uBand - stoneBandAA, uBand + stoneBandAA, vPart.w ) );
float stoneIsTrim = max( step( 0.5, stoneRegion ) * ( 1.0 - step( 1.5, stoneRegion ) ), stoneIsBand );
float stoneIsEye = step( 1.5, stoneRegion ) * ( 1.0 - step( 2.5, stoneRegion ) );
float stoneIsInterior = step( 0.5, vPart.z );

vec3 stoneColor = mix( uBase, uBase2, smoothstep( 0.32, 0.68, stoneLow.g ) );
stoneColor = mix( stoneColor, uVeinColor, clamp( stoneVein * uVein.z + stoneHalo, 0.0, 1.0 ) );
stoneColor *= 0.98 + 0.04 * stoneGrain.b;
float stoneRough = clamp( uSurface.x + uSurface.y * ( stoneGrain.a - 0.5 ) * 2.0 + stoneVein * uVein.w, 0.04, 1.0 );

// Carved armour: the same stone, tinted and polished differently so it reads against the body.
stoneColor = mix( stoneColor, stoneColor * uPlate.rgb, stoneIsPlate );
stoneRough = mix( stoneRough, clamp( stoneRough * uPlate.a, 0.04, 1.0 ), stoneIsPlate );

// Freshly broken faces: rough and a little lighter.
stoneColor = mix( stoneColor, stoneColor * 1.15 + 0.03, stoneIsInterior );
stoneRough = mix( stoneRough, 0.92, stoneIsInterior );

// Metal trim.
stoneColor = mix( stoneColor, uTrim * ( 0.94 + 0.12 * stoneLow.g ), stoneIsTrim );
stoneRough = mix( stoneRough, clamp( uTrimRough + 0.12 * ( stoneMain.a - 0.5 ), 0.05, 1.0 ), stoneIsTrim );
float stoneMetal = stoneIsTrim;

diffuseColor.rgb = stoneColor;
`;

// Replaces <normal_fragment_maps>: carved detail from the normal-map array plus fine grain.
const FRAGMENT_NORMAL = /* glsl */ `
{
  float stoneLayer = floor( vPart.x + 0.5 );
  vec3 stoneMapN = texture( tNormals, vec3( vStoneUv, stoneLayer ) ).xyz * 2.0 - 1.0;
  // Green is flipped because the UVs follow the glTF convention and tangents come from derivatives.
  stoneMapN.xy *= vec2( uSurface.w, -uSurface.w );
  mat3 stoneTbn = stoneTangentFrame( - vViewPosition, normal, vStoneUv );
  #ifdef DOUBLE_SIDED
    stoneTbn[0] *= faceDirection;
    stoneTbn[1] *= faceDirection;
  #endif
  normal = normalize( stoneTbn * stoneMapN );

  // Curvature of the carved surface from screen-space derivatives: positive on convex edges,
  // negative in crevices. Crevices hold patina and stay rough; edges are worn brighter and smoother.
  vec3 stoneDpx = dFdx( vViewPosition );
  vec3 stoneDpy = dFdy( vViewPosition );
  float stoneCurv = - ( dot( dFdx( normal ), stoneDpx ) + dot( dFdy( normal ), stoneDpy ) ) / max( dot( stoneDpx, stoneDpx ) + dot( stoneDpy, stoneDpy ), 1e-9 );
  float stoneCrevice = smoothstep( 0.0, 1.0, - stoneCurv * uCavity.x ) * ( 1.0 - stoneIsTrim ) * ( 1.0 - stoneIsInterior );
  float stoneEdge = smoothstep( 0.0, 1.0, stoneCurv * uCavity.x ) * ( 1.0 - stoneIsInterior );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uCavityColor, stoneCrevice * uCavity.y );
  diffuseColor.rgb *= 1.0 + stoneEdge * uCavity.z;
  roughnessFactor = clamp( roughnessFactor + stoneCrevice * uCavity.y * 0.4 - stoneEdge * uCavity.z, 0.04, 1.0 );

  float stoneH = ( stoneGrain.r - 0.5 ) * uSurface.z * ( 1.0 - stoneIsTrim );
  normal = stoneBump( - vViewPosition, normal, vec2( dFdx( stoneH ), dFdy( stoneH ) ), faceDirection );
  stoneSss = vec4( uSss.rgb, uSss.a * ( 1.0 - stoneIsTrim ) );
}
`;

// Replaces <emissivemap_fragment>: the magic that animates the statue runs through its veins.
const FRAGMENT_EMISSIVE = /* glsl */ `
{
  float stonePulse = 0.72 + 0.28 * sin( uTime * 2.2 + dot( stoneP, vec3( 2.1, 3.7, 1.3 ) ) );
  float stoneVeinGlow = stoneVein * ( 1.0 - stoneIsTrim ) * ( 1.0 - stoneIsInterior );
  totalEmissiveRadiance += uGlowColor * ( stoneVeinGlow * uLife.x * stonePulse + stoneIsEye * uLife.y );
  // Freshly broken faces glow with the escaping magic, then cool.
  totalEmissiveRadiance += uGlowColor * uLife.w * stoneIsInterior * ( 0.2 + 1.6 * smoothstep( 0.4, 0.75, stoneGrain.r ) + 1.2 * smoothstep( 0.45, 0.6, stoneFine.a ) );
  // The edge of the dissolve glows as the magic leaves the stone.
  totalEmissiveRadiance += uGlowColor * 4.0 * step( 0.0001, uLife.z ) * ( 1.0 - smoothstep( stoneDissolveAt, stoneDissolveAt + 0.07, stoneDissolveN ) );
}
`;

/** Maps surface curvature (1/m) to the 0..1 crevice and edge masks. */
const CURVATURE_SCALE = 0.012;

function plateVector(look: StoneLook): THREE.Vector4 {
  const c = new THREE.Color(look.plateTint);
  return new THREE.Vector4(c.r, c.g, c.b, look.platePolish);
}

function sssVector(look: StoneLook): THREE.Vector4 {
  const c = new THREE.Color(look.sssTint);
  return new THREE.Vector4(c.r, c.g, c.b, look.sssWrap);
}

// Direct diffuse with light wrapping a little past the terminator, tinted by the stone.
const DIRECT_DIFFUSE = 'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );';
const DIRECT_DIFFUSE_WRAPPED = /* glsl */ `
	float stoneWrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + stoneSss.a ) / ( 1.0 + stoneSss.a ) );
	vec3 stoneScatter = max( stoneWrapNL - dotNL, 0.0 ) * directLight.color * stoneSss.rgb;
	reflectedLight.directDiffuse += ( irradiance + stoneScatter ) * diffuseBRDF * ( 1.0 - F );
`;

function patch(shader: THREE.WebGLProgramParametersWithUniforms): void {
  const replace = (src: string, token: string, by: string): string => {
    if (!src.includes(token)) throw new Error(`stone material: shader chunk ${token} not found`);
    return src.replace(token, by);
  };
  shader.vertexShader = replace(shader.vertexShader, '#include <common>', `#include <common>\n${VERTEX_PARS}`);
  shader.vertexShader = replace(shader.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BEGIN}`);
  shader.vertexShader = patchChunkVertex(shader.vertexShader, true);

  let f = shader.fragmentShader;
  f = replace(f, '#include <common>', `#include <common>\n${FRAGMENT_PARS}`);
  f = replace(f, '#include <map_fragment>', FRAGMENT_COLOR);
  f = replace(f, '#include <roughnessmap_fragment>', 'float roughnessFactor = stoneRough;');
  f = replace(f, '#include <metalnessmap_fragment>', 'float metalnessFactor = stoneMetal;');
  f = replace(f, '#include <normal_fragment_maps>', FRAGMENT_NORMAL);
  f = replace(f, '#include <emissivemap_fragment>', FRAGMENT_EMISSIVE);
  const lightsPars = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!lightsPars.includes(DIRECT_DIFFUSE)) throw new Error('stone material: direct diffuse line not found in lights_physical_pars_fragment');
  f = replace(f, '#include <lights_physical_pars_fragment>', lightsPars.replace(DIRECT_DIFFUSE, DIRECT_DIFFUSE_WRAPPED));
  f = replace(f, '#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n#ifdef USE_ENVMAP\n\tradiance *= mix( 1.0, uCavity.w, stoneIsTrim );\n#endif');
  shader.fragmentShader = f;
}

export type StoneMaterial = THREE.MeshStandardMaterial & { userData: { stone: StoneUniforms } };

/** Colour and shadow-depth materials for a statue while it is breaking apart. */
export interface ShatterMaterials {
  color: StoneMaterial;
  depth: THREE.MeshDepthMaterial;
}

/**
 * The shatter variant of an existing stone material: it shares every uniform object with the
 * original, so the stone pattern and glow are identical at the moment of the switch, and adds
 * the per-chunk matrices. The depth material keeps the shadow in step with the chunks.
 */
export function createShatterMaterials(base: StoneMaterial, chunkTexture: THREE.IUniform<THREE.Texture | null>): ShatterMaterials {
  const uniforms = { ...base.userData.stone, tChunks: chunkTexture } as StoneUniforms;
  const color = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }) as StoneMaterial;
  color.userData.stone = uniforms;
  color.defines = { ...(color.defines ?? {}), STONE_SHATTER: '' };
  color.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patch(shader);
  };
  color.customProgramCacheKey = () => 'stone-v5-shatter';
  color.name = 'stone-shatter';

  const depth = new THREE.MeshDepthMaterial();
  depth.defines = { STONE_SHATTER: '' };
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.tChunks = chunkTexture;
    shader.vertexShader = patchChunkVertex(shader.vertexShader, false);
  };
  depth.customProgramCacheKey = () => 'stone-depth-shatter';
  depth.name = 'stone-shatter-depth';
  return { color, depth };
}

/**
 * A stone material instance. Instances share one compiled program; each has its own
 * uniform values (seed, glow), and the look uniforms can be edited live.
 */
export function createStoneMaterial(shared: StoneShared, look: StoneLook, seed = new THREE.Vector3()): StoneMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }) as StoneMaterial;
  const uniforms: StoneUniforms = {
    tNoise: shared.tNoise,
    tNormals: shared.tNormals,
    uTime: shared.uTime,
    uBase: { value: new THREE.Color(look.base) },
    uBase2: { value: new THREE.Color(look.base2) },
    uVeinColor: { value: new THREE.Color(look.vein) },
    uVein: { value: new THREE.Vector4(look.veinWidth, look.veinHalo, look.veinAmount, look.veinRoughness) },
    uVein2: { value: new THREE.Vector4(look.veinSparsity, look.veinFine, 0, 0) },
    uSurface: { value: new THREE.Vector4(look.roughness, look.roughnessVariation, look.bump, look.normalScale) },
    uSss: { value: sssVector(look) },
    uCavity: { value: new THREE.Vector4(CURVATURE_SCALE, look.cavity, look.edgeWear, look.trimEnv) },
    uCavityColor: { value: new THREE.Color(look.cavityColor) },
    uPlate: { value: plateVector(look) },
    uBand: { value: look.plateBand },
    uTrim: { value: new THREE.Color(look.trim) },
    uTrimRough: { value: look.trimRoughness },
    uGlowColor: { value: new THREE.Color(look.glow) },
    uLife: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSeed: { value: seed.clone() },
    uScale: { value: look.scale },
  };
  material.userData.stone = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patch(shader);
  };
  material.customProgramCacheKey = () => 'stone-v5';
  material.name = 'stone';
  return material;
}

/** Copy look values into an existing material (for live tuning). */
export function applyStoneLook(material: StoneMaterial, look: StoneLook): void {
  const u = material.userData.stone;
  u.uBase.value.set(look.base);
  u.uBase2.value.set(look.base2);
  u.uVeinColor.value.set(look.vein);
  u.uVein.value.set(look.veinWidth, look.veinHalo, look.veinAmount, look.veinRoughness);
  u.uVein2.value.set(look.veinSparsity, look.veinFine, 0, 0);
  u.uSurface.value.set(look.roughness, look.roughnessVariation, look.bump, look.normalScale);
  u.uSss.value.copy(sssVector(look));
  u.uCavity.value.set(CURVATURE_SCALE, look.cavity, look.edgeWear, look.trimEnv);
  u.uCavityColor.value.set(look.cavityColor);
  u.uPlate.value.copy(plateVector(look));
  u.uBand.value = look.plateBand;
  u.uTrim.value.set(look.trim);
  u.uTrimRough.value = look.trimRoughness;
  u.uGlowColor.value.set(look.glow);
  u.uScale.value = look.scale;
}
