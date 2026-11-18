import type { BoneGroup } from '../anim/sculpt';
import type { PieceType } from '../pieces/regalia';
import type { Tempo } from './pacing';

/**
 * How a piece strikes. Only the clip, its nominal hit times and its pacing are given here;
 * where the attacker stands, how the blow is aimed and the exact moment of contact are solved
 * from the weapon's real path through the clip (see strike.ts).
 */
export interface AttackSpec {
  /** A name for reports and for telling a piece's attacks apart. */
  name: string;
  clip: string;
  /**
   * Moments, in seconds into the clip, at which the weapon is moving fastest (measured on the
   * statue with `__sw.weaponPath`). The last one breaks the victim; any earlier ones land
   * with a lighter effect.
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
  /** Seconds of the clip to keep after the final hit before returning to the standing pose. */
  followThrough: number;
  /**
   * What sort of blow it is, which decides where on the head it should land and how far it
   * may be re-aimed: an overhead blow comes down on the crown and needs no aiming; a swing or
   * a thrust goes for the neck and face, and the arms may be raised or lowered to find them.
   */
  kind: 'overhead' | 'swing' | 'thrust';
  /** How far this blow may be re-aimed, radians, where the limit for its kind does not suit it. */
  aim?: number;
  /** The pacing of the final blow: wind-up slowed, a held beat at its top, the blow near full speed, the follow-through slowed. */
  tempo: Tempo;
  /** Clip time of the top of the wind-up, where the weapon's own path does not show it. */
  apex?: number;
  /** Clip time before which the clip plays at its own speed: a flourish that comes before the wind-up proper. */
  lead?: number;
  /** Bones that keep the frozen pose through the attack (a shield arm held in guard while the other strikes). */
  keep?: BoneGroup;
  /** A sword carried on the back is drawn first: clip, the moment the hand closes on the hilt, and where to hand over to the attack. */
  draw?: { clip: string; grab: number; until: number };
  /**
   * The clip is a jumping attack, struck while landing from the piece's own leap: the clip
   * times at which the feet leave the ground and come back down, and where to cut the clip.
   */
  leap?: { launch: number; land: number; until: number };
}

/** How far a blow may be re-aimed, radians, by kind. */
export const AIM_LIMIT: Record<AttackSpec['kind'], number> = { overhead: 0, swing: 0.27, thrust: 0.44 };

/** The pacing most blows share: about as long from first motion to contact as the knight's leap. */
const HEAVY: Tempo = { windup: 0.7, hold: 0.18, swing: 0.9, follow: 0.75 };
/** A thrust gathers, hangs a little longer, and goes in at full speed. */
const DRIVEN: Tempo = { windup: 0.62, hold: 0.22, swing: 1, follow: 0.7 };
/** The king takes his time: a slower wind-up and a longer held moment over a kneeling victim. */
const SOLEMN: Tempo = { windup: 0.6, hold: 0.34, swing: 0.9, follow: 0.7 };

const KINGS_DRAW = { clip: 'Weapon_Draw', grab: 0.3, until: 0.95 };

/**
 * Each piece's attacks. A capture chooses among them: one whose weapon reaches the victim's
 * head, preferring any that does not sweep through a bystander, and not the one this pairing
 * used last time (see `chooseAttack` in capture.ts).
 */
export const ATTACKS: Record<PieceType, AttackSpec[]> = {
  p: [
    // A lunge with the spear angled up into the throat.
    { name: 'lunge', clip: 'Spear_Thrust', hits: [0.45], along: 1, power: 4.2, followThrough: 0.62, trailFrom: 0.72, kind: 'thrust', aim: 0.86, apex: 0.25, tempo: DRIVEN },
    // The spear brought over and down one-handed, the shield kept up.
    { name: 'overhand', clip: 'Two_Handed_Overhead_Slam', hits: [0.7], along: 0.95, power: 4.4, followThrough: 0.7, trailFrom: 0.6, kind: 'overhead', keep: 'armL', tempo: HEAVY },
  ],
  n: [
    { name: 'leaping cut', clip: 'Attack_Jump', hits: [1.21], along: 0.85, power: 5, followThrough: 0.6, kind: 'overhead', tempo: HEAVY, leap: { launch: 0.6, land: 1.22, until: 2.3 } },
    // The same leap, landed beside the victim, and then a cut over the shoulder with a deep lunge.
    { name: 'landing cut', clip: 'Sword_Attack', hits: [0.52], along: 0.85, power: 5, followThrough: 0.5, kind: 'overhead', tempo: HEAVY },
  ],
  b: [
    { name: 'sweep', clip: 'Two_Handed_Horizontal_Swing', hits: [0.6], along: 0.9, power: 5, followThrough: 0.7, trailFrom: 0.5, kind: 'swing', aim: 0.5, tempo: HEAVY },
    { name: 'slam', clip: 'Two_Handed_Overhead_Slam', hits: [0.7], along: 0.95, power: 5.2, followThrough: 0.75, trailFrom: 0.5, kind: 'overhead', tempo: HEAVY },
  ],
  r: [
    { name: 'slam', clip: 'Two_Handed_Overhead_Slam', hits: [0.73], along: 0.95, power: 5.8, followThrough: 0.75, trailFrom: 0.55, kind: 'overhead', tempo: HEAVY },
    { name: 'sweep', clip: 'Two_Handed_Horizontal_Swing', hits: [0.6], along: 0.95, power: 5.8, followThrough: 0.7, trailFrom: 0.55, kind: 'swing', aim: 0.36, tempo: HEAVY },
  ],
  q: [
    { name: 'cross cut', clip: 'Dual_Wield_Cross_Slash', hits: [0.5], along: 0.85, power: 4.8, followThrough: 0.7, trails: [0, 1], kind: 'swing', tempo: HEAVY },
    // Two passes of the blades in front of her, then both driven home together.
    { name: 'combination', clip: 'Dual_Wield_Combo', hits: [1.21], along: 0.9, power: 4.8, followThrough: 0.6, trails: [0, 1], kind: 'thrust', lead: 0.84, apex: 1.11, tempo: DRIVEN },
  ],
  k: [
    { name: 'sweep', clip: 'Two_Handed_Horizontal_Swing', hits: [0.6], along: 0.8, power: 5.4, followThrough: 0.7, kind: 'swing', aim: 0.4, tempo: SOLEMN, draw: KINGS_DRAW },
    { name: 'execution', clip: 'Two_Handed_Overhead_Slam', hits: [0.7], along: 0.85, power: 5.6, followThrough: 0.75, kind: 'overhead', tempo: SOLEMN, draw: KINGS_DRAW },
  ],
};

export const ATTACK_CLIPS: string[] = [
  ...new Set(
    Object.values(ATTACKS)
      .flat()
      .flatMap((a) => [a.clip, ...(a.draw ? [a.draw.clip] : [])]),
  ),
];
