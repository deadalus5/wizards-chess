import * as THREE from 'three';
import type { BakedClip } from '../anim/bake';
import { FootPlanter } from '../anim/footPlanter';
import { applyPose, Pose, PoseBlender, poseJoints, sampleClip } from '../anim/pose';
import { groupMask } from '../anim/sculpt';
import { homeYaw, squareCentre, type Side } from '../game/squares';
import type { StoneMaterial } from '../render/stoneMaterial';
import { instantiatePiece, type PieceInstance, type PieceTemplate } from './buildPiece';
import type { PieceType } from './regalia';
import type { PieceDesign, WeaponSpec } from './roster';
import type { BodyKind } from './statueKit';
import { gripTransform } from './weapons';

/** One clip sampled at a time, with a weight and an optional per-bone mask. */
export interface PoseLayer {
  clip: BakedClip;
  time: number;
  weight: number;
  mask?: Float32Array | null;
}

/** The held poses of one piece type, built once by the cast and shared by its statues. */
export interface StatuePoses {
  /** The frozen pose. */
  rest: Pose;
  /** The frozen pose as a clip that holds still, so it can be layered like any other. */
  frozen: BakedClip;
  /** The standing pose a statue rises to before it acts (the frozen clip itself if that is upright). */
  upright: BakedClip;
  /** Hands lifted from the sides, for a statue that floats with a flourish. */
  hands: BakedClip | null;
  /** How much lower the head is in the frozen pose than standing, model units. */
  stoop: number;
}

interface Mount {
  parent: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/** A weapon and the two places it can sit: in the hand, or slung on the back. */
export interface Weapon {
  spec: WeaponSpec;
  mesh: THREE.Mesh;
  hand: Mount;
  back: Mount | null;
  inHand: boolean;
}

interface Scratch {
  blender: PoseBlender;
  poses: Pose[];
}
const scratchByBones = new Map<number, Scratch>();

/** A statue on the board: the sculpt instance plus its game identity and visual state. */
export class Actor {
  private static nextId = 1;
  readonly id = Actor.nextId++;
  readonly instance: PieceInstance;
  readonly root: THREE.Group;
  readonly pose: Pose;
  readonly weapons: Weapon[] = [];
  readonly body: BodyKind;
  private readonly pelvis: number;
  /** Bone masks for layering: legs and pelvis versus everything above. */
  readonly lowerMask: Float32Array;
  readonly upperMask: Float32Array;
  /** Both arms, and everything but the arms. */
  readonly armMask: Float32Array;
  readonly bodyMask: Float32Array;
  /** The frozen pose this statue holds at rest. */
  readonly restPose: Pose;
  /** The frozen pose and the standing pose as layers (one and the same for an upright statue). */
  readonly frozen: BakedClip;
  readonly upright: BakedClip;
  /** Hands lifted from the sides (only a statue that floats with a flourish has this). */
  readonly hands: BakedClip | null;
  /**
   * A last touch to the blended pose before it goes to the bones (aiming a blow, bowing a
   * head). Set by the choreography while it applies; cleared when the statue freezes.
   */
  adjust: ((pose: Pose) => void) | null = null;
  /** Pins planted feet while the statue moves (enabled by the choreography). */
  readonly planter: FootPlanter;

  private vein = 0;
  private eye = 0;
  private veinGoal = 0;
  private eyeGoal = 0;

  square = 'a1';
  /** False once captured (the actor is then hidden and can be recycled). */
  alive = true;
  /** True while the statue is breaking apart; it must not be recycled until that ends. */
  breaking = false;

  constructor(
    readonly type: PieceType,
    readonly side: Side,
    readonly design: PieceDesign,
    readonly template: PieceTemplate,
    readonly material: StoneMaterial,
    private readonly poses: StatuePoses,
  ) {
    this.restPose = poses.rest;
    this.frozen = poses.frozen;
    this.upright = poses.upright;
    this.hands = poses.hands;
    this.body = design.body;
    this.instance = instantiatePiece(template, material);
    this.root = this.instance.root;
    this.root.scale.setScalar(design.scale);
    this.root.rotation.y = homeYaw(side);
    this.root.name = `${side}${type}#${this.id}`;
    const rig = template.rig;
    this.pose = new Pose(rig.names.length).setRest(rig);
    this.pelvis = rig.index.get('pelvis') ?? -1;

    const lower = /^(root|pelvis|thigh|calf|foot|ball)/;
    this.lowerMask = Float32Array.from(rig.names, (n) => (lower.test(n) ? 1 : 0));
    this.upperMask = Float32Array.from(rig.names, (n) => (lower.test(n) ? 0 : 1));
    this.armMask = groupMask(rig, 'arms');
    this.bodyMask = this.armMask.map((w) => 1 - w);

    // Height of the ball of the foot in the bind pose, for telling when a foot is on the ground.
    const joints = new Float32Array(rig.names.length * 3);
    poseJoints(new Pose(rig.names.length).setRest(rig), rig, joints);
    const ball = rig.index.get('ball_l') ?? 0;
    this.planter = new FootPlanter(this.root, (name) => this.instance.byName.get(name), joints[ball * 3 + 1]);
  }

  /** Height of the figure standing, including its head-piece, in metres. */
  get height(): number {
    return (this.template.geometry.boundingBox?.max.y ?? 1.9) * this.design.scale;
  }

  /** Its height as it stands frozen on its square (lower than `height` for a crouching statue). */
  get restHeight(): number {
    return this.height - this.poses.stoop * this.design.scale;
  }

  /** Radius of the cylinder used for picking and for keeping the camera clear. */
  get radius(): number {
    return 0.34 * this.design.scale;
  }

  /** Attach weapon meshes. Must be called while the bones are still in their rest pose. */
  addWeapon(spec: WeaponSpec, geometry: THREE.BufferGeometry): void {
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.name = spec.prop;
    const handBone = this.instance.byName.get(`hand_${spec.hand}`);
    if (!handBone) throw new Error(`no hand_${spec.hand} bone`);
    gripTransform(this.template.rig, spec.hand, mesh);
    mesh.scale.multiplyScalar(spec.scale ?? 1);
    const hand: Mount = { parent: handBone, position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone() };
    let back: Mount | null = null;
    if (spec.sheathed) {
      // Slung across the back, grip above the right shoulder. Solved in the rest pose and
      // stored relative to the upper spine so it follows the torso.
      const spine = this.instance.byName.get('spine_03');
      if (!spine) throw new Error('no spine_03 bone');
      this.root.updateMatrixWorld(true);
      mesh.position.set(-0.2, 1.62, -0.17);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.42, -0.9, -0.03).normalize());
      mesh.scale.setScalar(spec.scale ?? 1);
      this.root.add(mesh);
      this.root.updateMatrixWorld(true);
      spine.attach(mesh);
      back = { parent: spine, position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone() };
    }
    const weapon: Weapon = { spec, mesh, hand, back, inHand: !back };
    this.weapons.push(weapon);
    this.mount(weapon, !back);
  }

  /** Move a weapon between the hand and the back. */
  mount(weapon: Weapon, inHand: boolean): void {
    const m = inHand || !weapon.back ? weapon.hand : weapon.back;
    m.parent.add(weapon.mesh);
    weapon.mesh.position.copy(m.position);
    weapon.mesh.quaternion.copy(m.quaternion);
    weapon.mesh.scale.copy(m.scale);
    weapon.inHand = inHand || !weapon.back;
  }

  drawWeapons(inHand: boolean): void {
    for (const w of this.weapons) if (w.back) this.mount(w, inHand);
  }

  /** Put the statue on a square, facing the enemy, in its frozen pose. */
  placeOn(square: string): void {
    this.square = square;
    squareCentre(square, this.root.position);
    // The whole rotation, not only the heading: a move abandoned mid-lean must not leave a tilt.
    this.root.rotation.set(0, homeYaw(this.side), 0);
    this.rest();
  }

  /** Return to the frozen pose. */
  rest(): void {
    this.adjust = null;
    this.planter.enabled = false;
    this.planter.reset();
    this.pose.copy(this.restPose);
    applyPose(this.pose, this.instance.bones, this.pelvis);
    this.drawWeapons(false);
  }

  /**
   * Evaluate a stack of clip layers into the skeleton. Weights are normalised per bone, so a
   * lower-body and an upper-body layer with disjoint masks each apply fully to their own bones.
   */
  animate(layers: readonly PoseLayer[], dt = 0, settled = false): void {
    const n = this.pose.boneCount;
    let scratch = scratchByBones.get(n);
    if (!scratch) {
      scratch = { blender: new PoseBlender(n, this.pelvis), poses: Array.from({ length: 12 }, () => new Pose(n)) };
      scratchByBones.set(n, scratch);
    }
    const { blender, poses } = scratch;
    blender.begin();
    let used = 0;
    for (const layer of layers) {
      if (layer.weight <= 0.0001 || used >= poses.length) continue;
      const p = poses[used++];
      sampleClip(layer.clip, layer.time, p);
      blender.add(p, layer.weight, layer.mask);
    }
    blender.end(this.pose, this.restPose);
    this.adjust?.(this.pose);
    applyPose(this.pose, this.instance.bones, this.pelvis);
    this.planter.update(dt, settled);
  }

  /** Brightness of the glowing veins and of the eyes (0 = dormant stone), applied at once. */
  setLife(vein: number, eye: number): void {
    this.vein = this.veinGoal = vein;
    this.eye = this.eyeGoal = eye;
    const life = this.material.userData.stone.uLife.value;
    life.x = vein;
    life.y = eye;
  }

  /** Ask the statue to wake (or go dormant); the glow eases towards these values. */
  wake(vein: number, eye: number): void {
    this.veinGoal = vein;
    this.eyeGoal = eye;
  }

  /** Ease the glow towards its goal. Returns true while it is still changing. */
  updateLife(dt: number): boolean {
    if (this.vein === this.veinGoal && this.eye === this.eyeGoal) return false;
    const k = 1 - Math.exp(-dt * 5);
    this.vein += (this.veinGoal - this.vein) * k;
    this.eye += (this.eyeGoal - this.eye) * k;
    if (Math.abs(this.vein - this.veinGoal) < 0.002) this.vein = this.veinGoal;
    if (Math.abs(this.eye - this.eyeGoal) < 0.002) this.eye = this.eyeGoal;
    const life = this.material.userData.stone.uLife.value;
    life.x = this.vein;
    life.y = this.eye;
    return true;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Undo everything a shatter did to this statue, so it can stand on the board again. */
  restoreAfterShatter(): void {
    const mesh = this.instance.mesh;
    mesh.geometry = this.template.geometry;
    mesh.material = this.material;
    mesh.customDepthMaterial = undefined;
    mesh.castShadow = true;
    const life = this.material.userData.stone.uLife.value;
    life.z = 0;
    life.w = 0;
    for (const w of this.weapons) {
      w.mesh.visible = true;
      this.mount(w, !w.back);
    }
    this.breaking = false;
  }
}
