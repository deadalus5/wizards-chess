import type { PieceType } from '../pieces/regalia';

/**
 * How each piece strikes. Only the clip and its nominal hit times are given here; where the
 * attacker stands and the exact moment of contact are solved from the weapon's real path
 * through the clip (see strike.ts).
 */
export interface AttackSpec {
  clip: string;
  /**
   * Moments, in seconds into the clip, at which the weapon is moving fastest (measured in the
   * clip lab). The last one breaks the victim; earlier ones stagger it.
   */
  hits: number[];
  /** The part of the weapon meant to land: 0 = grip, 1 = far end. */
  along: number;
  /** Which of the design's weapons strikes (default: the first). */
  weapon?: number;
  /** Weapons that leave an arc in the air (default: the striking one), and from how far along the blade. */
  trails?: number[];
  trailFrom?: number;
  /** Speed given to the nearest fragments, metres per second. */
  power: number;
  rate?: number;
  /** Seconds of the clip to keep after the final hit before returning to the frozen pose. */
  followThrough: number;
  /** A sword carried on the back is drawn first: clip, the moment the hand closes on the hilt, and where to hand over to the attack. */
  draw?: { clip: string; grab: number; until: number };
  /**
   * The clip is a jumping attack, struck while landing from the piece's own leap: the clip
   * times at which the feet leave the ground and come back down, and where to cut the clip.
   */
  leap?: { launch: number; land: number; until: number };
}

export const ATTACKS: Record<PieceType, AttackSpec> = {
  p: { clip: 'Spear_Thrust', hits: [0.45], along: 1, power: 4.2, followThrough: 0.62, trailFrom: 0.72 },
  n: { clip: 'Attack_Jump', hits: [1.21], along: 0.85, power: 5, followThrough: 0.6, leap: { launch: 0.6, land: 1.22, until: 2.3 } },
  b: { clip: 'Staff_Combo', hits: [0.52, 1.2], along: 0.9, power: 4.8, followThrough: 0.6 },
  r: { clip: 'Two_Handed_Overhead_Slam', hits: [0.73], along: 0.95, power: 5.8, followThrough: 0.75, trailFrom: 0.55 },
  q: { clip: 'Dual_Wield_Cross_Slash', hits: [0.5], along: 0.85, power: 4.8, followThrough: 0.7, trails: [0, 1] },
  k: {
    clip: 'Two_Handed_Horizontal_Swing',
    hits: [0.6],
    along: 0.8,
    power: 5.4,
    followThrough: 0.7,
    draw: { clip: 'Weapon_Draw', grab: 0.3, until: 0.95 },
  },
};

/** Clips the victim plays. */
export const REACT = { guard: 'Defend', flinch: 'Hit_Chest' } as const;

export const ATTACK_CLIPS: string[] = [...new Set([...Object.values(ATTACKS).flatMap((a) => [a.clip, ...(a.draw ? [a.draw.clip] : [])]), REACT.guard, REACT.flinch])];
