import * as THREE from 'three';
import { Rng } from '../core/math';
import { BOARD_HALF } from '../game/squares';
import { loadPbrMaterial, TILE_HEIGHT, type TextureQuality } from './board';
const FRAME_WIDTH = 0.55;
const STEP_HEIGHT = 0.22;
/** Height of the hall floor relative to the top of the board. */
export const FLOOR_Y = -(TILE_HEIGHT + STEP_HEIGHT * 2);

export interface Hall {
  group: THREE.Group;
  /** Where the four braziers stand; the light rig puts its warm lights here. */
  brazierPositions: THREE.Vector3[];
  /** Emissive coal beds, whose brightness flickers with the lights. */
  coals: THREE.Mesh[];
}

/** Scale a geometry's UVs so a texture repeats every `metres` regardless of the mesh size. */
function uvInMetres(g: THREE.BufferGeometry, metres: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    // Planar projection along the dominant axis of the face normal.
    if (ay >= ax && ay >= az) uv.setXY(i, pos.getX(i) / metres, pos.getZ(i) / metres);
    else if (ax >= az) uv.setXY(i, pos.getZ(i) / metres, pos.getY(i) / metres);
    else uv.setXY(i, pos.getX(i) / metres, pos.getY(i) / metres);
  }
  uv.needsUpdate = true;
  return g;
}

/** A square ring (picture frame) of the given inner and outer half-size, top at y = 0. */
function squareRing(inner: number, outer: number, height: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-outer, -outer);
  shape.lineTo(outer, -outer);
  shape.lineTo(outer, outer);
  shape.lineTo(-outer, outer);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-inner, -inner);
  hole.lineTo(-inner, inner);
  hole.lineTo(inner, inner);
  hole.lineTo(inner, -inner);
  hole.closePath();
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2 });
  g.rotateX(Math.PI / 2); // extrude downwards, top face at y = 0
  return g;
}

function pillarGeometry(height: number, radius: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const add = (r: number, y: number): number => pts.push(new THREE.Vector2(r, y));
  // Plinth, torus base, shaft with a slight swell, capital.
  add(0, 0);
  add(radius * 1.55, 0);
  add(radius * 1.55, 0.32);
  add(radius * 1.32, 0.36);
  add(radius * 1.38, 0.52);
  add(radius * 1.12, 0.66);
  const shaftBase = 0.7;
  const shaftTop = height - 1.1;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    add(radius * (1.0 + 0.045 * Math.sin(t * Math.PI) - 0.1 * t), shaftBase + (shaftTop - shaftBase) * t);
  }
  add(radius * 1.02, height - 1.0);
  add(radius * 1.3, height - 0.82);
  add(radius * 1.2, height - 0.7);
  add(radius * 1.62, height - 0.36);
  add(radius * 1.7, height - 0.3);
  add(radius * 1.7, height);
  add(0, height);
  const g = new THREE.LatheGeometry(pts, 28);
  const uv = g.getAttribute('uv');
  const pos = g.getAttribute('position');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 4, pos.getY(i) / 1.6);
  uv.needsUpdate = true;
  return g;
}

function brazierGeometry(): { stand: THREE.BufferGeometry; coals: THREE.BufferGeometry } {
  const pts: THREE.Vector2[] = [];
  const add = (r: number, y: number): number => pts.push(new THREE.Vector2(r, y));
  add(0, 0);
  add(0.34, 0);
  add(0.3, 0.06);
  add(0.1, 0.14);
  add(0.07, 0.6);
  add(0.11, 0.66);
  add(0.07, 0.72);
  add(0.07, 1.2);
  add(0.16, 1.3);
  add(0.42, 1.52);
  add(0.5, 1.72);
  add(0.52, 1.74);
  add(0.46, 1.74);
  add(0.4, 1.6);
  add(0, 1.56);
  const stand = new THREE.LatheGeometry(pts, 24);
  const coals = new THREE.SphereGeometry(0.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  coals.scale(1, 0.32, 1);
  coals.translate(0, 1.6, 0);
  return { stand, coals };
}

/**
 * A window-tracery cookie for the key light: the board sits in a pool of moonlight crossed by
 * the soft shadows of stone mullions.
 */
export function createTraceryCookie(size = 1024, soften?: 'filter' | 'shadow'): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // Safari's canvas has no filters. There the soft bars are drawn as the blurred shadows of
  // bars that are themselves drawn off the canvas. (`soften` forces one way, for comparing.)
  const filtered = soften ? soften === 'filter' : typeof ctx.filter === 'string';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const c = size / 2;
  // Pool of light, brightest in the middle, fading to nothing at the cone's edge.
  const pool = ctx.createRadialGradient(c, c, size * 0.05, c, c, size * 0.5);
  pool.addColorStop(0, '#ffffff');
  pool.addColorStop(0.55, '#e8e8e8');
  pool.addColorStop(0.82, '#7a7a7a');
  pool.addColorStop(1, '#000000');
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, size, size);
  // Mullions: soft dark bars and the arcs of a rose window.
  if (filtered) {
    ctx.filter = `blur(${size * 0.012}px)`;
    ctx.strokeStyle = 'rgba(0,0,0,0.62)';
  } else {
    ctx.strokeStyle = '#000';
    ctx.shadowColor = 'rgba(0,0,0,0.62)';
    // A shadow's blur is twice the standard deviation a blur filter is given.
    ctx.shadowBlur = size * 0.024;
    ctx.shadowOffsetX = size * 2;
    ctx.translate(-size * 2, 0);
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = size * 0.022;
  for (const x of [-0.3, -0.1, 0.1, 0.3]) {
    ctx.beginPath();
    ctx.moveTo(c + x * size, 0);
    ctx.lineTo(c + x * size, size);
    ctx.stroke();
  }
  ctx.lineWidth = size * 0.016;
  for (const y of [-0.26, 0.02, 0.3]) {
    ctx.beginPath();
    ctx.moveTo(0, c + y * size);
    ctx.lineTo(size, c + y * size);
    ctx.stroke();
  }
  ctx.lineWidth = size * 0.018;
  ctx.beginPath();
  ctx.arc(c, c - size * 0.1, size * 0.24, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * size * 0.12, c - size * 0.1 + Math.sin(a) * size * 0.12, size * 0.12, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (filtered) ctx.filter = 'none';
  else {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = 'transparent';
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.name = 'tracery-cookie';
  return tex;
}

/** The hall around the board: frame, stepped dais, floor, a ring of pillars and four braziers. */
export async function createHall(quality: TextureQuality = {}): Promise<Hall> {
  const [frameMat, stepMat, floorMat, pillarMat] = await Promise.all([
    loadPbrMaterial('Marble006', 'ambientcg', { roughness: 0.75 }, quality),
    loadPbrMaterial('medieval_blocks_05', 'polyhaven', { color: 0x6f6a66 }, quality),
    loadPbrMaterial('monastery_stone_floor', 'polyhaven', { color: 0x6a665f }, quality),
    loadPbrMaterial('medieval_blocks_05', 'polyhaven', { color: 0x8a847c }, quality),
  ]);
  const group = new THREE.Group();
  group.name = 'hall';

  const frameOuter = BOARD_HALF + FRAME_WIDTH;
  const frame = new THREE.Mesh(uvInMetres(squareRing(BOARD_HALF + 0.004, frameOuter, TILE_HEIGHT), 2.2), frameMat);
  frame.name = 'board-frame';
  frame.receiveShadow = true;
  group.add(frame);

  // Two masonry steps under the board.
  const steps: Array<[number, number]> = [
    [frameOuter + 0.75, -TILE_HEIGHT],
    [frameOuter + 1.6, -TILE_HEIGHT - STEP_HEIGHT],
  ];
  for (const [half, top] of steps) {
    const g = uvInMetres(new THREE.BoxGeometry(half * 2, STEP_HEIGHT, half * 2), 2.4);
    const step = new THREE.Mesh(g, stepMat);
    step.position.y = top - STEP_HEIGHT / 2;
    step.receiveShadow = true;
    step.name = 'dais-step';
    group.add(step);
  }

  const floorGeo = new THREE.CircleGeometry(60, 64);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(uvInMetres(floorGeo, 3.2), floorMat);
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  floor.name = 'hall-floor';
  group.add(floor);

  // Ring of pillars, slightly irregular so it does not read as a perfect circle.
  const pillarCount = 14;
  const pillarHeight = 13;
  const pillars = new THREE.InstancedMesh(pillarGeometry(pillarHeight, 0.62), pillarMat, pillarCount);
  pillars.name = 'pillars';
  const rng = new Rng(5);
  const m = new THREE.Matrix4();
  for (let i = 0; i < pillarCount; i++) {
    const a = ((i + 0.5) / pillarCount) * Math.PI * 2;
    const r = 15.5 + rng.range(-0.4, 0.4);
    m.makeRotationY(rng.range(0, Math.PI * 2));
    m.setPosition(Math.cos(a) * r, FLOOR_Y, Math.sin(a) * r);
    pillars.setMatrixAt(i, m);
  }
  pillars.receiveShadow = true;
  group.add(pillars);

  // Braziers at the corners of the dais.
  const iron = new THREE.MeshStandardMaterial({ color: 0x1b1a1a, roughness: 0.55, metalness: 0.85 });
  const coalMat = new THREE.MeshStandardMaterial({ color: 0x120805, emissive: new THREE.Color(1.0, 0.33, 0.07), emissiveIntensity: 5, roughness: 1 });
  const { stand, coals: coalGeo } = brazierGeometry();
  const d = frameOuter + 1.6 + 0.75;
  const brazierPositions: THREE.Vector3[] = [];
  const coals: THREE.Mesh[] = [];
  for (const [sx, sz] of [
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ]) {
    const b = new THREE.Group();
    b.position.set(sx * d, FLOOR_Y, sz * d);
    const s = new THREE.Mesh(stand, iron);
    s.castShadow = false;
    s.receiveShadow = true;
    const c = new THREE.Mesh(coalGeo, coalMat);
    b.add(s, c);
    b.name = 'brazier';
    group.add(b);
    coals.push(c);
    brazierPositions.push(new THREE.Vector3(sx * d, FLOOR_Y + 2.15, sz * d));
  }

  return { group, brazierPositions, coals };
}
