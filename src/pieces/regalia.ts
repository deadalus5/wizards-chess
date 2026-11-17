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

/** Height at which the knight is cut to take its horse (neck and head) off the pedestal, in king heights. */
const HORSE_CUT = 0.172;

export interface ChessSet {
  /** Top of each piece, base ring at y = 0 with radius 1, centred on the y axis. */
  tops: Record<PieceType, THREE.BufferGeometry>;
  /** Whole pieces, base at y = 0, scaled so the king is 1 unit tall. */
  whole: Record<PieceType, THREE.BufferGeometry>;
  /** The knight's horse from the collar up: base at y = 0 on the y axis, facing +z, in king heights. */
  horse: THREE.BufferGeometry;
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
  const horse = sliceAboveY(whole.n, HORSE_CUT);
  horse.translate(0, -HORSE_CUT, 0);
  return { tops, whole, horse };
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
  /** Height relative to width (1 = as the chess piece is). */
  tall?: number;
  /** How much wider the top is made than the foot (0 = as the chess piece is). */
  flare?: number;
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

// Sized to read from across the board: each is the top of its chess piece, worn large.
export const HEAD_PIECES: Record<PieceType, HeadPieceOptions> = {
  p: { fit: 0.6, lift: -0.012, helm: true },
  // The knight wears no head-piece: its head is a horse's (see horseHead).
  n: { fit: 0.78, lift: -0.016, helm: true },
  b: { fit: 1.12, lift: -0.065, pitch: -0.06, tall: 1.25 },
  r: { fit: 1.22, lift: -0.075, flare: 0.3, tall: 1.2 },
  q: { fit: 1.02, lift: -0.045, pitch: -0.1, flare: 0.25, tall: 1.2 },
  k: { fit: 1.05, lift: -0.05, pitch: -0.1, flare: 0.15, tall: 1.2 },
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
  if (o.flare) {
    // Widen towards the top, leaving the foot the size of the head it sits on.
    top.computeBoundingBox();
    const height = top.boundingBox!.max.y || 1;
    const pos = top.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = 1 + o.flare * Math.min(1, Math.max(0, pos.getY(i) / height));
      pos.setX(i, pos.getX(i) * k);
      pos.setZ(i, pos.getZ(i) * k);
    }
  }
  const s = m.radius * o.fit;
  const matrix = new THREE.Matrix4()
    .makeTranslation(m.centre.x, baseY, m.centre.z + (o.forward ?? 0))
    .multiply(new THREE.Matrix4().makeRotationX(o.pitch ?? 0))
    .multiply(new THREE.Matrix4().makeRotationY(o.yaw ?? 0))
    .multiply(new THREE.Matrix4().makeScale(s, s * (o.tall ?? 1), s));
  top.applyMatrix4(matrix);
  // A stretched piece needs its normals put right again.
  if (o.tall && o.tall !== 1) fixNormals(top, 1 / o.tall);
  parts.push(tagged(top, LAYER.chess, region));
  return parts;
}

/** After a non-uniform scale along y: rescale the normals' y by `k` and renormalise. */
function fixNormals(g: THREE.BufferGeometry, k: number): void {
  const nor = g.getAttribute('normal');
  for (let i = 0; i < nor.count; i++) {
    const x = nor.getX(i);
    const y = nor.getY(i) * k;
    const z = nor.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    nor.setXYZ(i, x / len, y / len, z / len);
  }
}

export interface HorseHeadOptions {
  /** Where the foot of the horse's neck goes, in bind-pose space. */
  base: THREE.Vector3;
  /** Metres per king height: the horse is about 0.62 of that tall, 0.29 wide and 0.48 long. */
  size: number;
  /** Tip the muzzle down (positive), radians. */
  nod?: number;
}

/** Eyes of the horse in its own units: height above the foot of the neck, half-spacing, forward. */
const HORSE_EYE = { y: 0.455, x: 0.066, z: 0.1, rx: 0.02, ry: 0.019, rz: 0.03 };

/**
 * A horse's head in place of the statue's own: the chess knight's horse at heroic size, set
 * on the neck and carried by the head bone, with eyes that light like any other statue's.
 * It breaks away whole.
 */
export function horseHead(set: ChessSet, options: HorseHeadOptions): PiecePart[] {
  const horse = set.horse.clone();
  const count = horse.getAttribute('position').count;
  const regions = new Float32Array(count).fill(REGION.trim);
  const layers = new Float32Array(count).fill(LAYER.chess);

  // Eyes: shallow lenses set into the sides of the head.
  const e = HORSE_EYE;
  const eyes: number[] = [];
  const eyeNormals: number[] = [];
  const rings = 8;
  const segments = 14;
  for (const side of [1, -1]) {
    const at = (i: number, j: number): { p: number[]; n: number[] } => {
      const phi = (i / rings) * Math.PI;
      const theta = (j / segments) * Math.PI * 2;
      const d = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      const n = [d[0] / e.rx, d[1] / e.ry, d[2] / e.rz];
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      return { p: [side * e.x + d[0] * e.rx, e.y + d[1] * e.ry, e.z + d[2] * e.rz], n: [n[0] / len, n[1] / len, n[2] / len] };
    };
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segments; j++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        for (const v of i === 0 ? [a, c, b] : i === rings - 1 ? [a, d, b] : [a, c, b, a, d, c]) {
          eyes.push(...v.p);
          eyeNormals.push(...v.n);
        }
      }
    }
  }
  const eyeCount = eyes.length / 3;
  const merged = new THREE.BufferGeometry();
  const join = (name: string, size: number, extra: ArrayLike<number>): void => {
    const src = horse.getAttribute(name).array;
    const out = new Float32Array(src.length + extra.length);
    out.set(src, 0);
    out.set(extra, src.length);
    merged.setAttribute(name, new THREE.BufferAttribute(out, size));
  };
  join('position', 3, eyes);
  join('normal', 3, eyeNormals);
  join('uv', 2, new Float32Array(eyeCount * 2));
  const region = new Float32Array(count + eyeCount).fill(REGION.eye);
  region.set(regions, 0);
  const layer = new Float32Array(count + eyeCount).fill(LAYER.flat);
  layer.set(layers, 0);
  merged.setAttribute('region', new THREE.BufferAttribute(region, 1));
  merged.setAttribute('layer', new THREE.BufferAttribute(layer, 1));

  const s = options.size;
  merged.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(options.base.x, options.base.y, options.base.z)
      .multiply(new THREE.Matrix4().makeRotationX(options.nod ?? 0))
      .multiply(new THREE.Matrix4().makeScale(s, s, s)),
  );
  return [tagged(merged, LAYER.chess, REGION.trim)];
}
