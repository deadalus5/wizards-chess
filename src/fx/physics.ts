import type RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

/** Collision groups: scenery and statues collide with everything; fragments start by ignoring each other. */
export const GROUP = {
  /** Board, floor, standing statues. */
  SOLID: (0x0001 << 16) | 0xffff,
  /** A fragment in the first instant of a break: touches scenery only, so overlapping neighbours do not fling each other apart. */
  FRAGMENT_FRESH: (0x0002 << 16) | 0x0001,
  /** A fragment once it has separated: touches scenery and other fragments. */
  FRAGMENT: (0x0002 << 16) | 0x0003,
} as const;

/**
 * The rigid-body world for debris. It advances in fixed steps on game time (a varying step
 * destabilises the solver) and exposes the leftover fraction so rendering can interpolate,
 * which keeps debris smooth through slow motion.
 */
export class Physics {
  static readonly STEP = 1 / 120;
  readonly world: RAPIER.World;
  /** How far the render time is past the last simulated state, as a fraction of a step. */
  alpha = 1;
  /** Called before every fixed step (to snapshot transforms and drive kinematic bodies). */
  readonly beforeStep: Array<() => void> = [];
  /** Called after every fixed step. */
  readonly afterStep: Array<() => void> = [];
  private accumulator = 0;

  private constructor(readonly R: Rapier) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = Physics.STEP;
  }

  static async create(): Promise<Physics> {
    const R = (await import('@dimforge/rapier3d-compat')).default;
    await R.init();
    return new Physics(R);
  }

  /** A fixed box whose top face is at `top`. */
  addSlab(halfX: number, halfZ: number, top: number, thickness = 1): void {
    const { R, world } = this;
    const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, top - thickness / 2, 0));
    world.createCollider(R.ColliderDesc.cuboid(halfX, thickness / 2, halfZ).setFriction(0.9).setRestitution(0.08).setCollisionGroups(GROUP.SOLID), body);
  }

  update(dt: number): void {
    this.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (this.accumulator >= Physics.STEP && steps < 10) {
      for (const f of this.beforeStep) f();
      this.world.step();
      for (const f of this.afterStep) f();
      this.accumulator -= Physics.STEP;
      steps++;
    }
    if (steps === 10) this.accumulator = 0;
    this.alpha = this.accumulator / Physics.STEP;
  }
}
