import * as THREE from 'three';
import { canon } from '../anim/rig';
import { ASSETS, loadGLTF } from './assets';
import { LAYER, REGION, type PiecePart } from './buildPiece';
import { buildShell } from './armor';
import { mergeSimple, ringRadius, sliceAboveY } from './geometryTools';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export const PIECE_TYPES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];

/** Which chess-set mesh each type comes from and the height (metres, model scale) to cut it at. */
const TOP_SPEC: Record<PieceType, { node: string; cut: number }> = {
  p: { node: 'piece_pawn_white_01', cut: 0.0365 },
  r: { node: 'piece_rook_white_01', cut: 0.0435 },
  n: { node: 'piece_knight_white_01', cut: 0.0185 },
  b: { node: 'piece_bishop_white_01', cut: 0.0535 },
  q: { node: 'piece_queen_white', cut: 0.066 },
  k: { node: 'piece_king_white', cut: 0.066 },
};

export interface ChessSet {
  /** Top of each piece, base ring at y = 0 with radius 1, centred on the y axis. */
  tops: Record<PieceType, THREE.BufferGeometry>;
  /** Whole pieces, base at y = 0, scaled so the king is 1 unit tall. */
  whole: Record<PieceType, THREE.BufferGeometry>;
}

export async function loadChessSet(): Promise<ChessSet> {
  const gltf = await loadGLTF(`${ASSETS}/models/chess_set/chess_set.gltf`);
  const tops = {} as Record<PieceType, THREE.BufferGeometry>;
  const whole = {} as Record<PieceType, THREE.BufferGeometry>;
  let kingHeight = 0.095;
  // A piece may be one mesh or (the bishop) a group of several primitives.
  const geometryOf = (name: string): THREE.BufferGeometry => {
    const o = gltf.scene.getObjectByName(name);
    if (!o) throw new Error(`chess set: ${name} not found`);
    const found: THREE.BufferGeometry[] = [];
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) found.push((c as THREE.Mesh).geometry);
    });
    if (!found.length) throw new Error(`chess set: ${name} has no geometry`);
    return mergeSimple(found);
  };
  {
    const k = geometryOf(TOP_SPEC.k.node);
    k.computeBoundingBox();
    kingHeight = k.boundingBox!.max.y;
  }
  for (const type of PIECE_TYPES) {
    const spec = TOP_SPEC[type];
    const source = geometryOf(spec.node);
    const top = sliceAboveY(source, spec.cut);
    top.translate(0, -spec.cut, 0);
    const r = ringRadius(top, -1e-6, 0.0015) || 0.01;
    top.scale(1 / r, 1 / r, 1 / r);
    tops[type] = top;
    const w = source.clone();
    w.scale(1 / kingHeight, 1 / kingHeight, 1 / kingHeight);
    whole[type] = w;
  }
  return { tops, whole };
}

/** Where a body's head is in bind pose, measured from the vertices the head bone drives. */
export interface HeadMetrics {
  /** Top of the skull. */
  top: number;
  /** Centre of the skull. */
  centre: THREE.Vector3;
  /** Skull radius at brow height. */
  radius: number;
  /** Radius of the sphere, centred on `centre`, that just encloses the top of the skull. */
  dome: number;
}

export function measureHead(body: PiecePart, skeleton: THREE.Skeleton): HeadMetrics {
  const head = skeleton.bones.findIndex((b) => canon(b.name) === 'head');
  if (head < 0) throw new Error('skeleton has no head bone');
  const g = body.geometry;
  const pos = g.getAttribute('position');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const headVerts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === head) w += sw.getComponent(i, k);
    if (w < 0.85) continue;
    v.fromBufferAttribute(pos, i);
    box.expandByPoint(v);
    headVerts.push(v.clone());
  }
  const top = box.max.y;
  // The skull is the upper part of the head-weighted region (the jaw and neck sit lower and forward).
  const skull = headVerts.filter((p) => p.y > top - 0.13);
  const sbox = new THREE.Box3().setFromPoints(skull);
  const centre = new THREE.Vector3((sbox.min.x + sbox.max.x) / 2, top - 0.105, (sbox.min.z + sbox.max.z) / 2);
  let radius = 0;
  for (const p of skull) {
    if (p.y < top - 0.085 || p.y > top - 0.045) continue;
    radius = Math.max(radius, Math.hypot(p.x - centre.x, p.z - centre.z));
  }
  let dome = 0;
  for (const p of skull) if (p.y >= centre.y - 0.02) dome = Math.max(dome, p.distanceTo(centre));
  return { top, centre, radius: radius || 0.1, dome: dome || 0.11 };
}

/** Head-pieces are rigid on the head bone and break away as chunks of their own. */
function tagged(g: THREE.BufferGeometry, layer: number, region: number): PiecePart {
  return { geometry: g, layer, region, bone: 'Head', fracture: 'own' };
}

const HELM_THICKNESS = 0.013;

/**
 * A helmet fitted to the skull: the scalp above a brow line (higher at the front, lower at
 * the nape), pushed out like the armour plates so it follows the head exactly.
 */
function helmet(body: THREE.BufferGeometry, m: HeadMetrics): THREE.BufferGeometry {
  const slope = 0.3;
  const browY = m.top - 0.092;
  return buildShell(body, {
    planes: [{ nx: 0, ny: 1, nz: -slope, d: -browY + slope * m.centre.z }],
    thickness: HELM_THICKNESS,
    rim: 0.007,
    rimWidth: 0.02,
  });
}

export interface HeadPieceOptions {
  /** Radius of the head-piece's base ring relative to the skull radius. */
  fit: number;
  /** Height of the base ring relative to the top of the skull, metres. */
  lift: number;
  /** Turn about the vertical axis, radians. */
  yaw?: number;
  /** Lean back (negative) or forward, radians. */
  pitch?: number;
  /** Shift along model-forward, metres. */
  forward?: number;
  /** Wear a fitted helmet under the head-piece. */
  helm?: boolean;
  region?: number;
}

export const HEAD_PIECES: Record<PieceType, HeadPieceOptions> = {
  p: { fit: 0.42, lift: -0.004, helm: true },
  n: { fit: 0.78, lift: -0.016, helm: true },
  b: { fit: 0.98, lift: -0.05, pitch: -0.06 },
  r: { fit: 1.14, lift: -0.062 },
  q: { fit: 0.86, lift: -0.028, pitch: -0.1 },
  k: { fit: 0.9, lift: -0.032, pitch: -0.1 },
};

/** The head-piece for one piece type, positioned on a measured head, as rigid parts on the head bone. */
export function headPiece(type: PieceType, set: ChessSet, m: HeadMetrics, body: THREE.BufferGeometry, overrides: Partial<HeadPieceOptions> = {}): PiecePart[] {
  const o = { ...HEAD_PIECES[type], ...overrides };
  const region = o.region ?? REGION.trim;
  const parts: PiecePart[] = [];
  let baseY = m.top + o.lift;
  if (o.helm) {
    // Skinned to the head like the skin beneath it, so it rides on the head's chunks when the statue breaks.
    parts.push({ geometry: helmet(body, m), layer: LAYER.flat, region });
    baseY += HELM_THICKNESS;
  }
  const top = set.tops[type].clone();
  const s = m.radius * o.fit;
  const matrix = new THREE.Matrix4()
    .makeTranslation(m.centre.x, baseY, m.centre.z + (o.forward ?? 0))
    .multiply(new THREE.Matrix4().makeRotationX(o.pitch ?? 0))
    .multiply(new THREE.Matrix4().makeRotationY(o.yaw ?? 0))
    .multiply(new THREE.Matrix4().makeScale(s, s, s));
  top.applyMatrix4(matrix);
  parts.push(tagged(top, LAYER.chess, region));
  return parts;
}
