import type { BoneGroup, Stance } from '../anim/sculpt';
import type { ArmorPiece, DrapeOptions } from './armor';
import type { PieceType } from './regalia';
import type { BodyKind, HairName } from './statueKit';

export interface WeaponSpec {
  prop: string;
  hand: 'r' | 'l';
  scale?: number;
  /** Carried on the back while at rest and drawn over the shoulder for a capture. */
  sheathed?: boolean;
}

/**
 * A held pose: one frame of a clip, optionally with frames of other clips laid over groups of
 * bones (in order), and then the legs re-placed in a planted stance.
 */
export interface PoseSpec {
  clip: string;
  time: number;
  over?: { clip: string; time: number; bones: BoneGroup; weight?: number }[];
  stance?: Stance;
}

/** How a statue that floats does it. */
export interface GlideSpec {
  /** Seconds to lift off, and how high the statue hangs, metres at scale 1 (the float clip adds its own height). */
  rise: number;
  hover: number;
  /** A beat held in the air before setting off, seconds. */
  poise: number;
  /** Travel time: `base` seconds plus the distance over `speed`. */
  base: number;
  speed: number;
  /** Lean into the motion at full speed, radians, and the height of the bob, metres. */
  lean: number;
  bob: number;
  /** Seconds to come down, and how hard it lands (scales the dust and the sound). */
  settle: number;
  land: number;
  /** Lifts, drifts and sinks on gentle eases, held steady, rather than springing up and bobbing. */
  calm?: boolean;
  /** Turns to its final heading in the air, rather than on its feet after landing. */
  turns?: boolean;
  /** Takes a captured square by floating onto it, rather than on foot. */
  floatsOn?: boolean;
  /**
   * Hands lifted from the sides while aloft: how far the arms come away from the body, how
   * much the elbows bend, and how far the forearms turn the palms outward, radians.
   */
  hands?: { lift: number; bend: number; turn: number };
}

/** How a statue that is dragged across the board does it. */
export interface SlideSpec {
  /** Cruising speed, metres per second, and the seconds taken to reach it and to stop. */
  speed: number;
  ramp: number;
  /** Lean into the direction of travel at full speed, radians. */
  lean: number;
  /** Radians per second through the middle of a pivot. */
  pivot: number;
}

/** The sculpt of one piece type: which body, hair and weapons, how large, and its frozen pose. */
export interface PieceDesign {
  name: string;
  body: BodyKind;
  hair: HairName[];
  /** Uniform scale of the whole statue (1 = a 1.8 m figure). */
  scale: number;
  weapons: WeaponSpec[];
  /** Fitted plates and clothes generated from the body. */
  armor: ArmorPiece[];
  /** Hanging plates below the belt: length in metres (0 for none). */
  skirt: number;
  /** Hanging cloth below the belt (a robe, the tails of a jacket); `metal` makes it gilt. */
  drapes?: (DrapeOptions & { metal?: boolean })[];
  /** A horse's head in place of the statue's own, with its size in metres per king height. */
  horse?: number;
  /** A round shield slung on the back: its radius in metres. */
  shield?: number;
  /** Rounded metal toe caps (worn with boots). */
  toeCaps?: boolean;
  /** The pose the statue holds while frozen. */
  rest: PoseSpec;
  /**
   * The upright pose it rises to before it moves or fights, for a statue whose frozen pose is
   * not upright, with the seconds it takes to rise out of the frozen pose and to settle back.
   */
  stand?: PoseSpec;
  rise?: number;
  settle?: number;
  /** How the piece crosses the board. */
  mover: 'walk' | 'leap' | 'glide' | 'slide';
  glide?: GlideSpec;
  slide?: SlideSpec;
  /** Gaits: clip and playback rate (below 1 reads as heavier). */
  walk: GaitSpec;
  run: GaitSpec;
  back: GaitSpec;
  /** How much of the gait's upper-body motion shows through the weapon-carrying pose, 0..1. */
  carry: number;
  /** Weight of the figure, 0..1: scales footfall dust, thud and camera shake. */
  heft: number;
}

export interface GaitSpec {
  clip: string;
  rate: number;
}

export const DESIGNS: Record<PieceType, PieceDesign> = {
  p: {
    name: 'Pawn',
    body: 'male',
    hair: [],
    scale: 0.84,
    weapons: [
      { prop: 'spear_A', hand: 'r', scale: 1.15 },
      { prop: 'shield_A', hand: 'l' },
    ],
    armor: ['cuirass', 'greaves', 'belt'],
    skirt: 0.2,
    // A soldier waiting in the line: a braced half-crouch, shield up, spear tilted forward.
    rest: {
      clip: 'Polearm Idle',
      time: 0.2,
      over: [
        { clip: 'Sword_Block', time: 0.6, bones: 'legs' },
        { clip: 'Sword_Block', time: 0.6, bones: 'trunk', weight: 0.35 },
        { clip: 'Idle_Shield', time: 0.5, bones: 'armL' },
      ],
    },
    stand: { clip: 'Polearm Idle', time: 0.2 },
    rise: 0.45,
    settle: 0.5,
    mover: 'walk',
    walk: { clip: 'Walk', rate: 1.3 },
    run: { clip: 'Polearm_Run', rate: 0.9 },
    back: { clip: 'Walk_Backwards', rate: 1.5 },
    carry: 0.22,
    heft: 0.35,
  },
  n: {
    name: 'Knight',
    body: 'female',
    hair: [],
    scale: 0.97,
    weapons: [{ prop: 'sword_C', hand: 'r' }],
    armor: ['gi', 'collar', 'trousers', 'sash', 'armWraps', 'legWraps'],
    skirt: 0,
    // The tails of the jacket, slit at the hips, and the ends of the sash.
    drapes: [
      { length: 0.16, spans: [[-1.25, 1.25]], flare: 0.015, standoff: 0.04, hem: 0.01 },
      { length: 0.16, spans: [[Math.PI - 1.25, Math.PI + 1.25]], flare: 0.015, standoff: 0.04, hem: 0.01 },
      { length: 0.36, spans: [[0.5, 0.7]], flare: 0.02, standoff: 0.056, hem: 0, thickness: 0.014 },
      { length: 0.3, spans: [[0.72, 0.9]], flare: 0.02, standoff: 0.054, hem: 0, thickness: 0.014 },
    ],
    horse: 0.98,
    rest: { clip: 'One Hand Weapon Idle', time: 0.9 },
    mover: 'leap',
    walk: { clip: 'Walk_Female', rate: 1.2 },
    run: { clip: 'Run_Female', rate: 1.0 },
    back: { clip: 'Walk_Backwards', rate: 1.5 },
    carry: 0.4,
    heft: 0.5,
  },
  b: {
    name: 'Bishop',
    body: 'male',
    hair: ['Hair_Buzzed'],
    scale: 1.0,
    weapons: [{ prop: 'staff_B', hand: 'r', scale: 1.15 }],
    armor: ['vestment', 'cincture'],
    skirt: 0,
    drapes: [{ length: 0.74, flare: 0.085, folds: 14, foldDepth: 0.02, hem: 0.03 }],
    rest: { clip: 'Polearm Idle', time: 1.2 },
    mover: 'glide',
    glide: { rise: 0.36, hover: 0.3, poise: 0, base: 0.55, speed: 4.8, lean: 0.11, bob: 0.018, settle: 0.4, land: 0.3 },
    walk: { clip: 'Walk_Formal', rate: 1.2 },
    run: { clip: 'Polearm_Run', rate: 0.9 },
    back: { clip: 'Walk_Backwards', rate: 1.4 },
    carry: 0.2,
    heft: 0.4,
  },
  r: {
    name: 'Rook',
    body: 'male',
    hair: ['Hair_Buzzed', 'Hair_Beard'],
    scale: 1.12,
    weapons: [{ prop: 'hammer_B', hand: 'r', scale: 1.7 }],
    armor: ['breastplate', 'plateCollar', 'platePauldrons', 'gauntlets', 'boots', 'belt'],
    skirt: 0.3,
    toeCaps: true,
    // Upper body and mace as they were; the legs planted broad and braced.
    rest: { clip: 'One Hand Weapon Idle', time: 0.5, stance: { width: 0.6, toeOut: 0.21, drop: 0.03 } },
    mover: 'slide',
    slide: { speed: 2.9, ramp: 0.75, lean: 0.045, pivot: 1.9 },
    walk: { clip: 'Walk_Large', rate: 1.25 },
    run: { clip: 'Jog', rate: 0.74 },
    back: { clip: 'Walk_Backwards', rate: 1.25 },
    carry: 0.45,
    heft: 1.0,
  },
  q: {
    name: 'Queen',
    body: 'female',
    hair: ['Hair_Long'],
    scale: 1.06,
    weapons: [
      { prop: 'sword_B', hand: 'r' },
      { prop: 'sword_B', hand: 'l' },
    ],
    armor: ['cuirass', 'baldric', 'pauldrons', 'bracers', 'greaves', 'belt'],
    skirt: 0.42,
    shield: 0.27,
    rest: { clip: 'Idle_A', time: 1.4 },
    mover: 'glide',
    glide: {
      rise: 0.7,
      hover: 0.2,
      poise: 0.12,
      base: 0.7,
      speed: 4.4,
      lean: 0.035,
      bob: 0,
      settle: 0.75,
      land: 0.1,
      calm: true,
      turns: true,
      floatsOn: true,
      hands: { lift: 0.2, bend: 0.12, turn: 0.78 },
    },
    walk: { clip: 'Walk_Female', rate: 1.25 },
    run: { clip: 'Run_Female', rate: 1.08 },
    back: { clip: 'Walk_Backwards', rate: 1.6 },
    carry: 0.5,
    heft: 0.45,
  },
  k: {
    name: 'King',
    body: 'male',
    hair: ['Hair_SimpleParted', 'Hair_Beard'],
    scale: 1.14,
    weapons: [{ prop: 'sword_E', hand: 'r', sheathed: true }],
    armor: ['cuirass', 'heavyPauldrons', 'bracers', 'greaves', 'belt'],
    skirt: 0.34,
    rest: { clip: 'Idle_FoldArms', time: 0.6 },
    mover: 'walk',
    walk: { clip: 'Walk_Formal', rate: 1.2 },
    run: { clip: 'Walk_Formal', rate: 1.45 },
    back: { clip: 'Walk_Backwards', rate: 1.35 },
    carry: 0.12,
    heft: 0.8,
  },
};
