import * as THREE from 'three';
import type { BakedClip } from '../anim/bake';
import { Pose, sampleClip } from '../anim/pose';
import { canon } from '../anim/rig';
import type { Side } from '../game/squares';
import { createStoneMaterial, IVORY, OBSIDIAN, type StoneLook } from '../render/stoneMaterial';
import { Actor } from './actor';
import { armorParts, cutAway, drape, landmarks, pteruges, restJoints } from './armor';
import { buildTemplate, LAYER, REGION, type PieceTemplate } from './buildPiece';
import { backShield, toeCaps } from './fittings';
import { headPiece, horseHead, measureHead, PIECE_TYPES, type ChessSet, type PieceType } from './regalia';
import { DESIGNS } from './roster';
import type { BodyKind, StatueKit } from './statueKit';
import { loadPropGeometry } from './weapons';

/** A chess.js board: rank 8 first, each cell a piece or null. */
export type BoardArray = ({ square: string; type: PieceType; color: Side } | null)[][];

/**
 * All the statues: builds one template per piece type, stamps out actors for a position, and
 * keeps the square -> actor map. It also owns the retargeted clip bank so playback code can
 * fetch clips synchronously.
 */
export class Cast {
  readonly actors: Actor[] = [];
  readonly looks: Record<Side, StoneLook> = { w: { ...IVORY }, b: { ...OBSIDIAN } };
  private readonly bySquare = new Map<string, Actor>();
  private readonly clips = new Map<string, BakedClip>();
  private readonly restPoses = {} as Record<PieceType, Pose>;
  private readonly props = new Map<string, THREE.BufferGeometry>();
  private seed = 1;

  private constructor(
    readonly kit: StatueKit,
    readonly templates: Record<PieceType, PieceTemplate>,
    /** Scene group the statues live in. */
    readonly group: THREE.Group,
  ) {}

  static async create(kit: StatueKit, chess: ChessSet, clipNames: readonly string[]): Promise<Cast> {
    const templates = {} as Record<PieceType, PieceTemplate>;
    for (const type of PIECE_TYPES) templates[type] = Cast.buildDesign(type, kit, chess);
    const group = new THREE.Group();
    group.name = 'cast';
    const cast = new Cast(kit, templates, group);

    // Retarget every clip the game uses for both body types up front, so nothing loads mid-move.
    const names = new Set<string>(clipNames);
    for (const type of PIECE_TYPES) names.add(DESIGNS[type].rest.clip);
    const kinds: BodyKind[] = ['male', 'female'];
    await Promise.all(
      kinds.flatMap((kind) =>
        [...names].map(async (name) => {
          cast.clips.set(`${kind}:${name}`, await kit.clip(kind, name));
        }),
      ),
    );
    const propNames = new Set(PIECE_TYPES.flatMap((t) => DESIGNS[t].weapons.map((w) => w.prop)));
    await Promise.all([...propNames].map(async (p) => cast.props.set(p, await loadPropGeometry(p))));

    for (const type of PIECE_TYPES) {
      const design = DESIGNS[type];
      const pose = new Pose(templates[type].rig.names.length).setRest(templates[type].rig);
      sampleClip(cast.clip(design.body, design.rest.clip), design.rest.time, pose);
      cast.restPoses[type] = pose;
    }
    return cast;
  }

  /** Body + head-piece + fitted armour and clothes + skirt + fittings, merged and pre-fractured. */
  private static buildDesign(type: PieceType, kit: StatueKit, chess: ChessSet): PieceTemplate {
    const design = DESIGNS[type];
    let parts = kit.bodyParts(design.body, design.hair);
    const body = parts.find((p) => p.layer === LAYER.male || p.layer === LAYER.female);
    if (!body) throw new Error('body part not found');
    // Armour is cut from the whole body, whatever is done to the head below.
    const skin = body.geometry;
    const skeleton = kit.skeleton(design.body);
    const rig = kit.rig(design.body);
    const marks = landmarks(rig);
    const boneIndex = (name: string): number => skeleton.bones.findIndex((b) => canon(b.name) === name);

    if (design.horse) {
      // The head comes off at the neck (with its eyes and brows) and the horse's goes on.
      const cut = marks.neckY + 0.03;
      body.geometry = cutAway(skin, { nx: 0, ny: -1, nz: 0, d: cut }, (x) => Math.abs(x) < 0.2);
      parts = parts.filter((p) => p === body);
      parts.push(...horseHead(chess, { base: new THREE.Vector3(0, marks.neckY - 0.022, marks.neckZ + 0.012), size: design.horse }));
    } else {
      parts.push(...headPiece(type, chess, measureHead(body, skeleton), skin));
    }
    for (const piece of design.armor) parts.push(...armorParts(skin, piece, marks, body.layer));
    if (design.skirt > 0) parts.push({ geometry: pteruges(skin, marks, boneIndex, design.skirt), layer: LAYER.flat, region: REGION.plate });
    for (const d of design.drapes ?? []) parts.push({ geometry: drape(skin, marks, boneIndex, d), layer: LAYER.flat, region: d.metal ? REGION.trim : REGION.plate });
    if (design.shield) {
      // Between the shoulder blades, clear of the back.
      const y = marks.chestY + 0.02;
      parts.push(backShield({ radius: design.shield, centre: new THREE.Vector3(0, y, Cast.backOf(skin, y) - 0.05), lean: -0.07 }));
    }
    if (design.toeCaps) {
      const joints = restJoints(rig);
      parts.push(...toeCaps(joints.get('ball_l')!, joints.get('ball_leaf_l')!));
    }
    return buildTemplate(parts, skeleton, { seed: type.charCodeAt(0) });
  }

  /** How far back the body reaches near the spine at a height (bind pose). */
  private static backOf(body: THREE.BufferGeometry, y: number): number {
    const pos = body.getAttribute('position');
    let z = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - y) < 0.1 && Math.abs(pos.getX(i)) < 0.14) z = Math.min(z, pos.getZ(i));
    }
    return z;
  }

  /** A retargeted clip for a body type. Throws if it was not preloaded. */
  clip(kind: BodyKind, name: string): BakedClip {
    const c = this.clips.get(`${kind}:${name}`);
    if (!c) throw new Error(`clip "${name}" was not preloaded`);
    return c;
  }

  hasClip(kind: BodyKind, name: string): boolean {
    return this.clips.has(`${kind}:${name}`);
  }

  at(square: string): Actor | undefined {
    return this.bySquare.get(square);
  }

  /** Create a statue (or revive a hidden one of the same kind) on a square. */
  spawn(type: PieceType, side: Side, square: string): Actor {
    let actor = this.actors.find((a) => !a.alive && !a.breaking && a.type === type && a.side === side);
    if (!actor) {
      const design = DESIGNS[type];
      this.seed++;
      const material = createStoneMaterial(this.kit.shared, this.looks[side], new THREE.Vector3(this.seed * 1.37, this.seed * 2.11, this.seed * 0.73));
      actor = new Actor(type, side, design, this.templates[type], material, this.restPoses[type]);
      this.group.add(actor.root);
      // Weapons are fitted while the skeleton is still in its bind pose.
      this.group.updateMatrixWorld(true);
      for (const w of design.weapons) actor.addWeapon(w, this.props.get(w.prop)!);
      this.actors.push(actor);
    }
    actor.alive = true;
    actor.restoreAfterShatter();
    actor.setVisible(true);
    actor.setLife(0, 0);
    actor.placeOn(square);
    this.bySquare.set(square, actor);
    return actor;
  }

  /** Take a statue off the board (it is hidden and kept for reuse). */
  remove(actor: Actor): void {
    if (this.bySquare.get(actor.square) === actor) this.bySquare.delete(actor.square);
    actor.alive = false;
    actor.setVisible(false);
  }

  /**
   * Take a statue out of the game but leave it standing: it is about to be broken, and the
   * shatter system hides it when the rubble has gone.
   */
  detach(actor: Actor): void {
    if (this.bySquare.get(actor.square) === actor) this.bySquare.delete(actor.square);
    actor.alive = false;
    actor.breaking = true;
  }

  /** Record that a statue now stands on another square (does not move it visually). */
  relocate(actor: Actor, square: string): void {
    if (this.bySquare.get(actor.square) === actor) this.bySquare.delete(actor.square);
    actor.square = square;
    this.bySquare.set(square, actor);
  }

  /**
   * Make the statues match a position exactly. Statues already on the right square stay;
   * others are moved, revived or hidden. Used for new games, undo and after every move as a
   * safety net.
   */
  setPosition(board: BoardArray): void {
    const wanted = new Map<string, { type: PieceType; side: Side }>();
    for (const row of board) for (const cell of row) if (cell) wanted.set(cell.square, { type: cell.type, side: cell.color });

    // Keep statues that are already correct.
    const settled = new Set<Actor>();
    for (const [square, want] of wanted) {
      const a = this.bySquare.get(square);
      if (a && a.alive && a.type === want.type && a.side === want.side) {
        settled.add(a);
        // Whatever a move left it doing (glowing, faded, hidden after a checkmate), it stands
        // on its square again as plain stone.
        a.restoreAfterShatter();
        a.setVisible(true);
        a.setLife(0, 0);
        a.placeOn(square);
        wanted.delete(square);
      }
    }
    // Everything else comes off, then the remaining squares are filled.
    for (const a of this.actors) if (a.alive && !settled.has(a)) this.remove(a);
    this.bySquare.clear();
    for (const a of settled) this.bySquare.set(a.square, a);
    for (const [square, want] of wanted) this.spawn(want.type, want.side, square);
  }

  /** True if the statues agree with the position (used to verify sequences end consistent). */
  matches(board: BoardArray): boolean {
    let count = 0;
    for (const row of board) {
      for (const cell of row) {
        if (!cell) continue;
        count++;
        const a = this.bySquare.get(cell.square);
        if (!a || !a.alive || a.type !== cell.type || a.side !== cell.color) return false;
      }
    }
    return count === this.actors.filter((a) => a.alive).length;
  }

  living(): Actor[] {
    return this.actors.filter((a) => a.alive);
  }
}
