import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findContact, solveStrike, type StrikeTrack, type StrikeZone } from '../src/sequence/strike';

/**
 * A weapon path to plan against, without a statue: an overhead blow. The hands are at
 * shoulder height a little in front of the body, and a weapon 1.2 m long swings over from
 * straight up to pointing at the floor ahead between 0.4 and 0.8 s, fastest in the middle.
 * `aim` tilts the whole swing up (as raising the arms would).
 */
function overhead(aim = 0): StrikeTrack {
  const grip = new THREE.Vector3(0, 1.45, 0.3);
  const length = 1.2;
  const angle = (t: number): number => {
    const u = Math.min(Math.max((t - 0.4) / 0.4, 0), 1);
    // From 95 degrees above the horizon to 40 below it, easing in and out.
    return ((95 - 135 * u * u * (3 - 2 * u)) * Math.PI) / 180 + aim;
  };
  const point = (time: number, along: number, out = new THREE.Vector3()): THREE.Vector3 => {
    const a = angle(time);
    return out.set(0, grip.y + Math.sin(a) * length * along, grip.z + Math.cos(a) * length * along);
  };
  return {
    aim,
    point,
    windupTop: () => 0.4,
    velocity: (time: number, along: number, out = new THREE.Vector3()) => out.subVectors(point(time + 0.01, along), point(time - 0.01, along)).multiplyScalar(50),
  } as unknown as StrikeTrack;
}

const head: StrikeZone = { radius: 0.07, bottom: 1.5, top: 2.1, forward: 0, sweet: [1.7, 2.1], body: 0.17 };

describe('strike planning', () => {
  it('finds the moment a weapon enters a zone, and reports honestly when it never does', () => {
    const track = overhead();
    const hit = findContact(track, 0.6, 0.95, 0, 1.3, head);
    expect(hit.found).toBe(true);
    expect(hit.point.y).toBeGreaterThan(head.bottom);
    expect(hit.point.y).toBeLessThan(head.top);
    expect(Math.hypot(hit.point.x, hit.point.z - 1.3)).toBeLessThan(head.radius);
    // Out of the weapon's reach altogether.
    expect(findContact(track, 0.6, 0.95, 0, 3, head).found).toBe(false);
  });

  it('stands the attacker where the blow comes down on the head, not on the chest', () => {
    const s = solveStrike(overhead, [0.6], 0.95, head, [0], 2.3);
    expect(s.lands).toBe(true);
    const c = s.contacts[0];
    expect(c.point.y).toBeGreaterThanOrEqual(head.bottom);
    expect(c.point.y).toBeLessThanOrEqual(head.top);
    // Near the moment the weapon is fastest, with its outer part.
    expect(Math.abs(c.time - 0.6)).toBeLessThan(0.12);
    expect(c.along).toBeGreaterThan(0.6);
    // The same blow against the whole body stands farther off and lands lower: the old behaviour.
    const body: StrikeZone = { radius: 0.075, bottom: 0.04, top: 2.1, forward: 0 };
    const low = solveStrike(overhead, [0.6], 0.95, body, [0], 2.3);
    expect(low.distance).toBeGreaterThan(s.distance - 1e-6);
  });

  it('never takes a limit farther than the attacker already stands', () => {
    for (const limit of [1.25, 1.75, 2.3]) {
      const s = solveStrike(overhead, [0.6], 0.95, head, [0], limit);
      expect(s.distance).toBeLessThanOrEqual(limit + 1e-9);
    }
  });

  it('uses an aim only when it has to, the least that reaches, and says which it used', () => {
    // A thrust goes out level at 1.2 m; raising the arms tilts it up. The head is above that.
    const thrust = (aim = 0): StrikeTrack => {
      const point = (time: number, along: number, out = new THREE.Vector3()): THREE.Vector3 => {
        const reach = 0.5 * Math.min(Math.max((time - 0.3) / 0.3, 0), 1);
        return out.set(0, 1.2 + Math.sin(aim) * 1.2 * along, 0.3 + reach + Math.cos(aim) * 1.2 * along);
      };
      return { aim, point, windupTop: () => 0.3 } as unknown as StrikeTrack;
    };
    const throat: StrikeZone = { radius: 0.07, bottom: 1.5, top: 1.9, forward: 0 };
    const level = solveStrike(thrust, [0.5], 1, throat, [0], 2.3);
    const aimed = solveStrike(thrust, [0.5], 1, throat, [0, 0.15, 0.3, 0.45], 2.3);
    expect(level.lands).toBe(false);
    expect(aimed.lands).toBe(true);
    expect(aimed.aim).toBe(0.3);
    expect(aimed.track.aim).toBe(0.3);
    expect(aimed.contacts[0].point.y).toBeGreaterThan(throat.bottom);
    // An overhead blow sweeps every height on its way down: no aim is used though it is on offer.
    expect(solveStrike(overhead, [0.6], 0.95, head, [0, 0.2, 0.4], 2.3).aim).toBe(0);
  });

  it('allows for a head that is not over the feet', () => {
    const bowed: StrikeZone = { ...head, forward: 0.3 };
    const upright = solveStrike(overhead, [0.6], 0.95, head, [0], 2.3);
    const leaning = solveStrike(overhead, [0.6], 0.95, bowed, [0], 2.3);
    // The victim's head is 0.3 m nearer the attacker, so the attacker stands that much farther from its feet.
    expect(leaning.distance - upright.distance).toBeCloseTo(0.3, 1);
  });
});
