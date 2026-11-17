import * as THREE from 'three';
import { ChunkField } from '../fx/chunkField';
import type { Effects } from '../fx/effects';
import { GROUP, type Physics } from '../fx/physics';
import { SQUARE } from '../game/squares';
import type { Cast } from '../pieces/cast';
import { PIECE_TYPES } from '../pieces/regalia';
import type { Markers } from '../render/markers';
import type { Pipeline } from '../render/pipeline';
import { createShatterMaterials, type ShatterMaterials } from '../render/stoneMaterial';
import { ATTACKS } from '../sequence/attacks';
import { strikeFor } from '../sequence/capture';
import type { Stage } from '../sequence/moves';

export interface WarmUpDeps {
  pipeline: Pipeline;
  cast: Cast;
  fx: Effects;
  markers: Markers;
  stage: Stage;
  physics: Physics;
}

/** Distances a capture is made from: the next square, the next diagonal, and anything farther than a weapon reaches. */
const NEXT_SQUARE = [SQUARE, SQUARE * Math.SQRT2];
const REACHES = [...NEXT_SQUARE, 3];

// One set of shatter materials is kept for good: a compiled program is thrown away when the
// last material using it is disposed, and every break disposes its own.
const keepers: ShatterMaterials[] = [];

/**
 * The physics engine is slow the first time it is handed a pile of bodies (measured: a single
 * step of about 22 ms on some first captures, 2 ms ever after). Hand it a pile now: as many
 * boxes as a statue breaks into, set down among a few fixed capsules, let go a few at a time
 * as a break does, stepped until they have fallen and met the floor, then cleared away.
 */
function rehearseBreak(physics: Physics): void {
  const { R, world } = physics;
  const bodies: ReturnType<typeof world.createRigidBody>[] = [];
  const pieces: typeof bodies = [];
  for (let i = 0; i < 52; i++) {
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(40 + (i % 4) * 0.12, 0.3 + Math.floor(i / 4) * 0.13, 40 + ((i * 7) % 5) * 0.1)
        .setLinearDamping(0.08)
        .setAngularDamping(0.35)
        .setEnabled(false),
    );
    world.createCollider(R.ColliderDesc.cuboid(0.07, 0.06, 0.05).setDensity(2.6).setFriction(0.85).setRestitution(0.1).setCollisionGroups(GROUP.FRAGMENT_FRESH), body);
    bodies.push(body);
    pieces.push(body);
  }
  for (let i = 0; i < 6; i++) {
    const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(39 + i * 0.5, 0.85, 41));
    world.createCollider(R.ColliderDesc.capsule(0.55, 0.27).setCollisionGroups(GROUP.SOLID), body);
    bodies.push(body);
  }
  for (let step = 0; step < 90; step++) {
    // A few more let go every step, and after a while they may strike one another.
    for (let i = step * 4; i < Math.min(pieces.length, step * 4 + 4); i++) {
      pieces[i].setEnabled(true);
      pieces[i].setLinvel({ x: (i % 3) - 1, y: 1, z: ((i * 5) % 3) - 1 }, true);
      pieces[i].setAngvel({ x: 3, y: -2, z: 1 }, true);
    }
    if (step === 30) for (const p of pieces) p.collider(0).setCollisionGroups(GROUP.FRAGMENT);
    world.step();
  }
  for (const body of bodies) world.removeRigidBody(body);
}

/**
 * Exercise, behind the loading screen, everything that would otherwise be set up at the
 * moment it is first needed, which is always the worst moment: the shader variants a
 * breaking statue uses (and their shadow versions), the particle shaders, the depth-of-field
 * and particle passes, the markers, and the weapon-reach solutions for every pairing.
 */
export function warmUp({ pipeline, cast, fx, markers, stage, physics }: WarmUpDeps): void {
  rehearseBreak(physics);

  // Where every kind of attacker stands, and how it aims, against every kind of victim, for
  // each of its attacks: from the next square (straight or diagonal, exactly), from the
  // farthest its weapon reaches, and from those two distances as limits.
  for (const a of PIECE_TYPES) {
    const attacker = cast.actors.find((x) => x.type === a);
    if (!attacker) continue;
    for (const v of PIECE_TYPES) {
      const victim = cast.actors.find((x) => x.type === v && x.side !== attacker.side);
      if (!victim) continue;
      for (const spec of ATTACKS[a]) {
        for (const reach of REACHES) strikeFor(stage, attacker, victim, spec, reach);
        for (const reach of NEXT_SQUARE) strikeFor(stage, attacker, victim, spec, reach, 'stand', reach);
      }
    }
  }

  // One statue of each design in its breaking form, so every geometry and program is uploaded.
  const undo: (() => void)[] = [];
  for (const type of PIECE_TYPES) {
    const actor = cast.actors.find((x) => x.type === type);
    if (!actor) continue;
    const field = new ChunkField(actor.template.chunks.length);
    const materials = createShatterMaterials(actor.material, field.uniform);
    const mesh = actor.instance.mesh;
    mesh.geometry = actor.template.shatterGeometry;
    mesh.material = materials.color;
    mesh.customDepthMaterial = materials.depth;
    const keep = keepers.length === 0;
    if (keep) keepers.push(materials);
    undo.push(() => {
      actor.restoreAfterShatter();
      if (!keep) {
        field.dispose();
        materials.color.dispose();
        materials.depth.dispose();
      }
    });
  }

  const point = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3(0, 0, 1);
  fx.impact(point, direction, 1, 'w');
  fx.collapse(point, 1.8, direction, 'b');
  fx.landing(point, 1);
  fx.embers(point, 0.5, 'w', 4);
  const still = { point: (_t: number, along: number, out = new THREE.Vector3()) => out.set(along, 1, 0) };
  fx.trail(0, still, point, 0, 0, 0, 'w', 1);
  fx.update(1 / 60);
  markers.add('move', 'a1', 0xffffff);
  markers.update(1 / 60);
  pipeline.setDepthOfField(4, 4);
  pipeline.overlayPass.enabled = true;

  pipeline.render(0);
  pipeline.render(0);

  for (const f of undo) f();
  fx.clear();
  markers.clear();
  markers.update(1);
  pipeline.setDepthOfField(0);
  pipeline.overlayPass.enabled = false;
}
