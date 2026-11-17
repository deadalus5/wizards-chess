import * as THREE from 'three';
import type { Obstacle } from '../cinema/cinema';
import { squareCentre, type Side } from '../game/squares';
import type { Actor, PoseLayer } from '../pieces/actor';
import type { PieceType } from '../pieces/regalia';
import type { Stage } from './moves';
import type { Timeline } from './timeline';

/** Clips used by the special presentations (preloaded with the attack clips). */
export const SPECIAL_CLIPS = ['Kneel'] as const;

const life = (a: Actor): THREE.Vector4 => a.material.userData.stone.uLife.value;

function statuesExcept(stage: Stage, ...except: Actor[]): Obstacle[] {
  return stage.cast
    .living()
    .filter((a) => !except.includes(a))
    .map((a) => ({ x: a.root.position.x, z: a.root.position.z, radius: a.radius, height: a.height }));
}

/**
 * A pawn that has crossed the board is remade: its stone crumbles away while the new piece
 * forms out of the same light, on the same square. Returns when it is over.
 */
export function planPromotion(tl: Timeline, stage: Stage, pawn: Actor, type: PieceType, square: string, t0: number): number {
  const { cast, fx, cinema } = stage;
  const at = squareCentre(square);
  const OUT = 0.85;
  const IN = 0.95;
  const swap = t0 + 0.45;
  const end = swap + IN + 0.5;
  let promoted: Actor | null = null;

  tl.at(t0, () => {
    pawn.wake(3, 8);
    fx.embers(at, 0.45, pawn.side, 14);
    // A shot of its own: the board's quietest move with the largest consequence.
    const tall = pawn.height * 1.35;
    cinema.cut(cinema.twoShot(at, at, stage.viewerPosition(), tall, tall, tall, statuesExcept(stage, pawn)));
  });
  tl.at(swap, () => {
    cast.detach(pawn);
    promoted = cast.spawn(type, pawn.side, square);
    promoted.setLife(2.6, 7);
    life(promoted).z = 1;
    promoted.instance.mesh.castShadow = false;
    fx.embers(at, 0.5, pawn.side, 18);
    fx.audio?.ascend(at);
  });
  tl.span(swap, OUT, (local) => {
    const k = local / OUT;
    life(pawn).z = k;
    if (k > 0.5) pawn.instance.mesh.castShadow = false;
  });
  tl.span(swap, IN, (local) => {
    if (!promoted) return;
    const k = 1 - local / IN;
    life(promoted).z = k;
    if (k < 0.5) promoted.instance.mesh.castShadow = true;
  });
  const retirePawn = (): void => {
    pawn.setVisible(false);
    pawn.restoreAfterShatter();
  };
  tl.at(swap + OUT, retirePawn);
  tl.at(swap + IN, () => promoted?.wake(0, 0));
  tl.at(end - 0.1, () => cinema.release());
  tl.onAbort(() => {
    if (pawn.breaking) retirePawn();
    if (promoted) {
      life(promoted).z = 0;
      promoted.instance.mesh.castShadow = true;
    }
  });
  return end;
}

/**
 * Checkmate. The king that cannot be saved kneels, and the magic that held it together lets
 * go: it breaks where it kneels, while the victors' eyes burn. Returns when it is over.
 *
 * The king stays in the cast (the position still has a king on that square, and undo must
 * bring it back); it is only its stone that is gone.
 */
export function planCheckmate(tl: Timeline, stage: Stage, loser: Side, t0: number): number {
  const { cast, fx, cinema, shatter } = stage;
  const king = cast.living().find((a) => a.type === 'k' && a.side === loser);
  if (!king) return t0;
  const at = king.root.position.clone();
  const yaw = king.root.rotation.y;
  const kneel = cast.clip(king.body, SPECIAL_CLIPS[0]);
  const rest = cast.clip(king.body, king.design.rest.clip);
  const winners = cast.living().filter((a) => a.side !== loser);

  const start = t0 + 0.5;
  // The clip stands a while before going down; skip most of that and hold the bowed pose.
  const from = 0.7;
  const down = 1.95;
  const fall = start + (down - from) + 0.75;
  const end = fall + 2.7;

  tl.at(t0, () => {
    for (const a of winners) a.wake(0.9, 3.4);
    king.wake(2.2, 7);
    const tall = king.height;
    cinema.cut(cinema.twoShot(at, at, stage.viewerPosition(), tall, tall, tall, statuesExcept(stage, king)));
  });

  const layers: PoseLayer[] = [
    { clip: rest, time: king.design.rest.time, weight: 1 },
    { clip: kneel, time: from, weight: 0 },
  ];
  tl.at(start, () => {
    king.planter.enabled = true;
  });
  tl.span(start, fall - start, (local, dt) => {
    const w = Math.min(1, local / 0.3);
    layers[0].weight = 1 - w * w * (3 - 2 * w);
    layers[1].weight = 1 - layers[0].weight;
    layers[1].time = Math.min(from + local, down);
    king.root.position.copy(at);
    king.root.rotation.set(0, yaw, 0);
    king.animate(layers, dt, false);
  });
  // Its light gutters as it kneels.
  tl.at(fall - 0.55, () => king.wake(4, 10));
  tl.at(fall, () => {
    const chest = at.clone().setY(king.height * 0.42);
    const downwards = new THREE.Vector3(Math.sin(yaw) * 0.25, -1, Math.cos(yaw) * 0.25);
    fx.impact(chest, downwards, 1, loser);
    fx.collapse(at, king.height * 0.6, downwards, loser);
    fx.audio?.finale();
    stage.slowMotion();
    shatter.shatter(king, { point: chest, direction: downwards, power: 3.2 });
  });
  tl.at(end - 0.35, () => {
    cinema.release();
    for (const a of winners) a.wake(0, 0);
  });
  tl.onAbort(() => {
    for (const a of winners) a.wake(0, 0);
  });
  return end;
}
