import * as THREE from 'three';
import { ChunkField } from '../fx/chunkField';
import type { Effects } from '../fx/effects';
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
}

// One set of shatter materials is kept for good: a compiled program is thrown away when the
// last material using it is disposed, and every break disposes its own.
const keepers: ShatterMaterials[] = [];

/**
 * Exercise, behind the loading screen, everything that would otherwise be set up at the
 * moment it is first needed, which is always the worst moment: the shader variants a
 * breaking statue uses (and their shadow versions), the particle shaders, the depth-of-field
 * and particle passes, the markers, and the weapon-reach solutions for every pairing.
 */
export function warmUp({ pipeline, cast, fx, markers, stage }: WarmUpDeps): void {
  // Where every kind of attacker stands against every kind of victim.
  for (const a of PIECE_TYPES) {
    const attacker = cast.actors.find((x) => x.type === a);
    if (!attacker) continue;
    for (const v of PIECE_TYPES) {
      const victim = cast.actors.find((x) => x.type === v && x.side !== attacker.side);
      if (!victim) continue;
      for (const reach of [1.25, 1.77, 3]) strikeFor(stage, attacker, victim, ATTACKS[a], reach);
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
