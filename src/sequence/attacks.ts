import type { PieceType } from '../pieces/regalia';
import type { Tempo } from './pacing';

/**
 * How a piece strikes. Only the clip, its nominal hit times and its pacing are given here;
 * where the attacker stands, how the blow is aimed and the exact moment of contact are solved
 * from the weapon's real path through the clip (see strike.ts).
 */
export interface AttackSpec {
  /** A name for reports and for telling variants apart. */
  name: string;
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
  /**
   * What sort of blow it is, which decides where on the head it should land and how far it
   * may be re-aimed: an overhead blow comes down on the crown and needs no aiming; a swing or
   * a thrust goes for the neck and face, and the arms may be raised or lowered to find them.
   */
  kind: 'overhead' | 'swing' | 'thrust';
  /**
   * The pacing of the final blow: wind-up slowed, a held beat at its top, the blow near full
   * speed, the follow-through slowed. Without it the clip plays at `rate`.
   */
  tempo?: Tempo;
  /** Clip time of the top of the wind-up, where the weapon's own path does not show it. */
  apex?: number;
  /** A sword carried on the back is drawn first: clip, the moment the hand closes on the hilt, and where to hand over to the attack. */
  draw?: { clip: string; grab: number; until: number };
  /**
   * The clip is a jumping attack, struck while landing from the piece's own leap: the clip
   * times at which the feet leave the ground and come back down, and where to cut the clip.
   */
  leap?: { launch: number; land: number; until: number };
  /**
   * Not yet brought up to the new captures: the blow may land anywhere on the body and the
   * victim crouches behind a guard, as before. (Goes when every piece has been converted.)
   */
  old?: boolean;
}

/** How far a blow may be re-aimed, radians, by kind. */
export const AIM_LIMIT: Record<AttackSpec['kind'], number> = { overhead: 0, swing: 0.27, thrust: 0.44 };

/** The pacing most blows share: about as long from first motion to contact as the knight's leap. */
const HEAVY: Tempo = { windup: 0.7, hold: 0.18, swing: 0.9, follow: 0.75 };

/** Each piece's attacks. The first is its own; a capture chooses among them. */
export const ATTACKS: Record<PieceType, AttackSpec[]> = {
  p: [{ name: 'thrust', clip: 'Spear_Thrust', hits: [0.45], along: 1, power: 4.2, followThrough: 0.62, trailFrom: 0.72, kind: 'thrust', old: true }],
  n: [{ name: 'leaping cut', clip: 'Attack_Jump', hits: [1.21], along: 0.85, power: 5, followThrough: 0.6, kind: 'swing', leap: { launch: 0.6, land: 1.22, until: 2.3 }, old: true }],
  b: [{ name: 'staff combination', clip: 'Staff_Combo', hits: [0.52, 1.2], along: 0.9, power: 4.8, followThrough: 0.6, kind: 'swing', old: true }],
  r: [{ name: 'slam', clip: 'Two_Handed_Overhead_Slam', hits: [0.73], along: 0.95, power: 5.8, followThrough: 0.75, trailFrom: 0.55, kind: 'overhead', tempo: HEAVY }],
  q: [{ name: 'cross cut', clip: 'Dual_Wield_Cross_Slash', hits: [0.5], along: 0.85, power: 4.8, followThrough: 0.7, trails: [0, 1], kind: 'swing', old: true }],
  k: [
    {
      name: 'sweep',
      clip: 'Two_Handed_Horizontal_Swing',
      hits: [0.6],
      along: 0.8,
      power: 5.4,
      followThrough: 0.7,
      kind: 'swing',
      draw: { clip: 'Weapon_Draw', grab: 0.3, until: 0.95 },
      old: true,
    },
  ],
};

/** Clips the victim plays. */
export const REACT = { guard: 'Defend', flinch: 'Hit_Chest' } as const;

export const ATTACK_CLIPS: string[] = [
  ...new Set([
    ...Object.values(ATTACKS)
      .flat()
      .flatMap((a) => [a.clip, ...(a.draw ? [a.draw.clip] : [])]),
    REACT.guard,
    REACT.flinch,
  ]),
];
