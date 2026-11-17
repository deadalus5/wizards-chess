import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Rng } from '../core/math';
import type { Actor } from '../pieces/actor';
import type { Cast } from '../pieces/cast';
import type { ChunkInfo } from '../pieces/fracture';
import { createShatterMaterials, type ShatterMaterials } from '../render/stoneMaterial';
import { ChunkField } from './chunkField';
import type { Effects } from './effects';
import { GROUP, Physics } from './physics';

export interface Blow {
  /** Where the weapon lands, world space. */
  point: THREE.Vector3;
  /** Direction the weapon is travelling, world space (need not be unit length). */
  direction: THREE.Vector3;
  /** Speed imparted to the nearest fragments, metres per second. */
  power: number;
}

interface Piece {
  body: RAPIER.RigidBody;
  /** Chunk ids carried by this body (empty for a loose weapon). */
  chunks: number[];
  /** Inverse of the body's transform at the moment of breaking. */
  inverse0: THREE.Matrix4;
  /** Seconds after the blow at which this piece comes loose. */
  release: number;
  released: boolean;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  prevPos: THREE.Vector3;
  prevRot: THREE.Quaternion;
  pos: THREE.Vector3;
  rot: THREE.Quaternion;
  /** A weapon mesh driven directly by this body. */
  loose?: THREE.Object3D;
}

interface Break {
  actor: Actor;
  field: ChunkField;
  materials: ShatterMaterials;
  pieces: Piece[];
  /** Temporary colliders for the statues standing nearby. */
  bystanders: RAPIER.RigidBody[];
  age: number;
  meshWorld: THREE.Matrix4;
  meshWorldInverse: THREE.Matrix4;
  /** Age at which the rubble starts to dissolve. */
  dissolveAt: number;
  mingled: boolean;
  /** How many bursts of embers the dissolve has given off. */
  embers: number;
}

const SETTLE = 2.6;
const DISSOLVE = 1.3;
/** Seconds for freshly broken faces to stop glowing. */
const HEAT = 0.95;

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Vector3();

/**
 * Breaks statues. The statue's geometry is already split into closed chunks; breaking it
 * means freezing its pose, giving every chunk (or cluster of chunks) a rigid body, and from
 * then on writing each body's motion into the chunk-matrix texture the shader reads.
 */
export class ShatterSystem {
  private readonly breaks: Break[] = [];
  private readonly rng = new Rng(1234);
  private pusher: { body: RAPIER.RigidBody; actor: Actor } | null = null;

  constructor(
    private readonly physics: Physics,
    private readonly cast: Cast,
    private readonly scene: THREE.Scene,
    private readonly fx: Effects,
  ) {
    physics.beforeStep.push(() => {
      for (const b of this.breaks) {
        for (const p of b.pieces) {
          p.prevPos.copy(p.pos);
          p.prevRot.copy(p.rot);
        }
      }
      if (this.pusher) {
        const r = this.pusher.actor.root.position;
        this.pusher.body.setNextKinematicTranslation({ x: r.x, y: 0.75 * this.pusher.actor.design.scale, z: r.z });
      }
    });
    physics.afterStep.push(() => {
      for (const b of this.breaks) {
        for (const p of b.pieces) {
          if (!p.released) continue;
          const t = p.body.translation();
          const r = p.body.rotation();
          p.pos.set(t.x, t.y, t.z);
          p.rot.set(r.x, r.y, r.z, r.w);
        }
      }
    });
  }

  get active(): boolean {
    return this.breaks.length > 0;
  }

  /**
   * Let a statue shoulder through the rubble (the attacker stepping onto the square).
   * Pass null to stop.
   */
  setPusher(actor: Actor | null): void {
    const { R, world } = this.physics;
    if (this.pusher) {
      world.removeRigidBody(this.pusher.body);
      this.pusher = null;
    }
    if (!actor) return;
    const k = actor.design.scale;
    const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(actor.root.position.x, 0.75 * k, actor.root.position.z));
    world.createCollider(R.ColliderDesc.capsule(0.45 * k, 0.26 * k).setCollisionGroups(GROUP.SOLID).setFriction(0.4), body);
    this.pusher = { body, actor };
  }

  /** Break a statue apart under a blow. The actor is taken off the board by the caller. */
  shatter(actor: Actor, blow: Blow): void {
    const { R, world } = this.physics;
    const rng = this.rng;
    const template = actor.template;
    const mesh = actor.instance.mesh;
    actor.root.updateMatrixWorld(true);
    const meshWorld = mesh.matrixWorld.clone();
    const scale = actor.root.scale.x;

    // Switch the statue to its shatter variant. At this instant every chunk matrix is the
    // identity, so nothing visibly changes.
    const field = new ChunkField(template.chunks.length);
    const materials = createShatterMaterials(actor.material, field.uniform);
    mesh.geometry = template.shatterGeometry;
    mesh.material = materials.color;
    mesh.customDepthMaterial = materials.depth;

    // Where each chunk is right now: bind-space box carried by its dominant bone.
    const bones = actor.instance.skeleton.bones;
    const inverses = actor.instance.skeleton.boneInverses;
    const centres: THREE.Vector3[] = [];
    const rotations: THREE.Quaternion[] = [];
    const halves: THREE.Vector3[] = [];
    for (const c of template.chunks) {
      _m.multiplyMatrices(bones[c.bone].matrixWorld, inverses[c.bone]);
      const centre = new THREE.Vector3((c.min[0] + c.max[0]) / 2, (c.min[1] + c.max[1]) / 2, (c.min[2] + c.max[2]) / 2).applyMatrix4(_m);
      _m.decompose(_p, _q, _s);
      centres.push(centre);
      rotations.push(_q.clone());
      halves.push(new THREE.Vector3(Math.max(0.02, ((c.max[0] - c.min[0]) / 2) * scale * 0.78), Math.max(0.02, ((c.max[1] - c.min[1]) / 2) * scale * 0.78), Math.max(0.02, ((c.max[2] - c.min[2]) / 2) * scale * 0.78)));
    }

    // Hops from the chunk that took the blow: the break spreads outwards from there.
    const chunks = template.chunks;
    const bodyChunks = chunks.filter((c) => c.kind === 'body');
    let struck = bodyChunks[0];
    let best = Infinity;
    for (const c of bodyChunks) {
      const d = centres[c.id].distanceToSquared(blow.point);
      if (d < best) {
        best = d;
        struck = c;
      }
    }
    const hop = new Int32Array(chunks.length).fill(-1);
    hop[struck.id] = 0;
    const queue = [struck.id];
    for (let i = 0; i < queue.length; i++) {
      for (const n of chunks[queue[i]].neighbors) {
        if (hop[n] < 0) {
          hop[n] = hop[queue[i]] + 1;
          queue.push(n);
        }
      }
    }
    for (const c of chunks) {
      if (hop[c.id] >= 0) continue;
      // Not connected through the body surface (a head-piece): follows the chunk it sits on.
      let near = struck;
      let nd = Infinity;
      for (const b of bodyChunks) {
        if (hop[b.id] < 0) continue;
        const d = centres[c.id].distanceToSquared(centres[b.id]);
        if (d < nd) {
          nd = d;
          near = b;
        }
      }
      hop[c.id] = hop[near.id] + 1;
    }

    // Near the blow every chunk is its own fragment; farther away chunks hold together in
    // growing lumps that topple rather than fly.
    const assigned = new Int32Array(chunks.length).fill(-1);
    const clusters: ChunkInfo[][] = [];
    const order = [...chunks].sort((a, b) => hop[a.id] - hop[b.id]);
    for (const c of order) {
      if (assigned[c.id] >= 0) continue;
      const cluster = [c];
      assigned[c.id] = clusters.length;
      const limit = c.kind === 'own' || hop[c.id] <= 1 ? 1 : Math.min(4, 1 + Math.floor(hop[c.id] / 2));
      for (let i = 0; i < cluster.length && cluster.length < limit; i++) {
        for (const n of cluster[i].neighbors) {
          if (cluster.length >= limit) break;
          if (assigned[n] >= 0 || chunks[n].kind === 'own' || hop[n] < hop[c.id]) continue;
          assigned[n] = clusters.length;
          cluster.push(chunks[n]);
        }
      }
      clusters.push(cluster);
    }

    const dir = blow.direction.clone().setY(blow.direction.y * 0.5).normalize();
    const pieces: Piece[] = [];
    for (const cluster of clusters) {
      const origin = new THREE.Vector3();
      for (const c of cluster) origin.add(centres[c.id]);
      origin.divideScalar(cluster.length);
      const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(origin.x, origin.y, origin.z).setLinearDamping(0.08).setAngularDamping(0.35).setCcdEnabled(false).setEnabled(false));
      for (const c of cluster) {
        const rel = centres[c.id].clone().sub(origin);
        const h = halves[c.id];
        const q = rotations[c.id];
        world.createCollider(
          R.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(rel.x, rel.y, rel.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setDensity(2.6).setFriction(0.85).setRestitution(0.1).setCollisionGroups(GROUP.FRAGMENT_FRESH),
          body,
        );
      }
      const h = Math.min(...cluster.map((c) => hop[c.id]));
      const falloff = 1 / (1 + h * 0.5);
      const radial = origin.clone().sub(blow.point);
      radial.y *= 0.4;
      if (radial.lengthSq() > 1e-6) radial.normalize();
      const velocity = new THREE.Vector3()
        .addScaledVector(dir, blow.power * falloff * rng.range(0.7, 1.15))
        .addScaledVector(radial, blow.power * 0.45 * falloff * rng.range(0.6, 1.2))
        .add(new THREE.Vector3(rng.range(-0.4, 0.4), rng.range(0.3, 1.5) * falloff + 0.2, rng.range(-0.4, 0.4)));
      const spin = new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).multiplyScalar(6 * falloff + 0.6);
      pieces.push({
        body,
        chunks: cluster.map((c) => c.id),
        inverse0: new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z),
        release: h * 0.007 + rng.range(0, 0.006),
        released: false,
        velocity,
        spin,
        prevPos: origin.clone(),
        prevRot: new THREE.Quaternion(),
        pos: origin.clone(),
        rot: new THREE.Quaternion(),
      });
    }

    // Weapons fall from the hands as bodies of their own.
    for (const w of actor.weapons) {
      const obj = w.mesh;
      this.scene.attach(obj);
      obj.updateMatrixWorld(true);
      obj.matrixWorld.decompose(_p, _q, _s);
      const geo = w.mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const box = geo.boundingBox!;
      const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).multiply(_s);
      const centreLocal = box.getCenter(new THREE.Vector3()).multiply(_s);
      const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(_p.x, _p.y, _p.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setAngularDamping(0.4).setEnabled(false));
      world.createCollider(
        R.ColliderDesc.cuboid(Math.max(0.015, Math.abs(half.x)), Math.max(0.015, Math.abs(half.y)), Math.max(0.015, Math.abs(half.z)))
          .setTranslation(centreLocal.x, centreLocal.y, centreLocal.z)
          .setDensity(3)
          .setFriction(0.7)
          .setRestitution(0.2)
          .setCollisionGroups(GROUP.FRAGMENT_FRESH),
        body,
      );
      const velocity = new THREE.Vector3().addScaledVector(dir, blow.power * 0.35).add(new THREE.Vector3(rng.range(-0.6, 0.6), rng.range(0.6, 1.6), rng.range(-0.6, 0.6)));
      pieces.push({
        body,
        chunks: [],
        inverse0: new THREE.Matrix4(),
        release: 0.05 + rng.range(0, 0.04),
        released: false,
        velocity,
        spin: new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).multiplyScalar(5),
        prevPos: _p.clone(),
        prevRot: _q.clone(),
        pos: _p.clone(),
        rot: _q.clone(),
        loose: obj,
      });
    }

    // The statues standing nearby are obstacles for the rubble.
    const bystanders: RAPIER.RigidBody[] = [];
    for (const other of this.cast.living()) {
      if (other === actor || other === this.pusher?.actor) continue;
      const o = other.root.position;
      if (Math.hypot(o.x - actor.root.position.x, o.z - actor.root.position.z) > 3.6) continue;
      const k = other.design.scale;
      const b = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(o.x, 0.85 * k, o.z));
      world.createCollider(R.ColliderDesc.capsule(0.55 * k, 0.27 * k).setCollisionGroups(GROUP.SOLID).setFriction(0.5).setRestitution(0.15), b);
      bystanders.push(b);
    }

    this.breaks.push({
      actor,
      field,
      materials,
      pieces,
      bystanders,
      age: 0,
      meshWorld,
      meshWorldInverse: meshWorld.clone().invert(),
      dissolveAt: SETTLE + rng.range(0, 0.3),
      mingled: false,
      embers: 0,
    });
  }

  /** Advance on game time. Physics itself is stepped by the caller before this. */
  update(dt: number): void {
    const alpha = this.physics.alpha;
    for (let i = this.breaks.length - 1; i >= 0; i--) {
      const b = this.breaks[i];
      b.age += dt;

      for (const p of b.pieces) {
        if (!p.released && b.age >= p.release) {
          p.released = true;
          p.body.setEnabled(true);
          p.body.setLinvel({ x: p.velocity.x, y: p.velocity.y, z: p.velocity.z }, true);
          p.body.setAngvel({ x: p.spin.x, y: p.spin.y, z: p.spin.z }, true);
        }
      }
      // Once the pieces have parted they may collide with one another and pile up.
      if (!b.mingled && b.age > 0.28) {
        b.mingled = true;
        for (const p of b.pieces) {
          for (let c = 0; c < p.body.numColliders(); c++) p.body.collider(c).setCollisionGroups(GROUP.FRAGMENT);
        }
      }

      for (const p of b.pieces) {
        if (!p.released) continue;
        _p.lerpVectors(p.prevPos, p.pos, alpha);
        _q.slerpQuaternions(p.prevRot, p.rot, alpha);
        if (p.loose) {
          p.loose.position.copy(_p);
          p.loose.quaternion.copy(_q);
          continue;
        }
        _m.compose(_p, _q, _one).multiply(p.inverse0);
        _m2.multiplyMatrices(b.meshWorldInverse, _m).multiply(b.meshWorld);
        for (const c of p.chunks) b.field.setMatrix(c, _m2);
      }
      b.field.commit();

      // The life goes out of the stone: eyes and veins die, the broken faces glow and cool.
      const life = b.actor.material.userData.stone.uLife.value;
      const fade = Math.exp(-dt * 5);
      life.x *= fade;
      life.y *= fade;
      const heat = Math.max(0, 1 - b.age / HEAT);
      life.w = 1.5 * heat * heat;

      // Rubble crumbles away, giving off motes as it goes.
      if (b.age > b.dissolveAt) {
        life.z = Math.min(1, (b.age - b.dissolveAt) / DISSOLVE);
        if (life.z > 0.55) b.actor.instance.mesh.castShadow = false;
        const due = Math.floor(((b.age - b.dissolveAt) / DISSOLVE) * 5) + 1;
        while (b.embers < Math.min(due, 5)) {
          b.embers++;
          this.rubbleCentre(b, _c);
          this.fx.embers(_c, 0.75, b.actor.side, 9);
        }
      }
      if (b.age > b.dissolveAt + DISSOLVE) {
        this.finish(b);
        this.breaks.splice(i, 1);
      }
    }
  }

  /** Middle of where the fragments have come to rest. */
  private rubbleCentre(b: Break, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    let n = 0;
    for (const p of b.pieces) {
      if (p.loose) continue;
      out.add(p.pos);
      n++;
    }
    return n ? out.multiplyScalar(1 / n) : out.copy(b.actor.root.position);
  }

  private finish(b: Break): void {
    const { world } = this.physics;
    for (const p of b.pieces) {
      world.removeRigidBody(p.body);
      if (p.loose) p.loose.visible = false;
    }
    for (const s of b.bystanders) world.removeRigidBody(s);
    b.actor.setVisible(false);
    b.actor.restoreAfterShatter();
    b.field.dispose();
    b.materials.color.dispose();
    b.materials.depth.dispose();
  }

  /** Clear everything at once (new game, undo). */
  reset(): void {
    for (const b of this.breaks) this.finish(b);
    this.breaks.length = 0;
    this.setPusher(null);
  }
}
