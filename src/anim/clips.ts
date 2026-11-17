/**
 * Every clip from the animation library the game plays, by role. The cast retargets all of
 * them for both body types while the loading screen is up, so nothing is fetched mid-move.
 */
export const LOCOMOTION = ['Walk', 'Walk_Formal', 'Walk_Large', 'Walk_Female', 'Jog', 'Run_Female', 'Polearm_Run', 'Walk_Backwards'] as const;

export const LEAP = { start: 'NinjaJump_Start', air: 'NinjaJump_Idle', land: 'NinjaJump_Land' } as const;
export const GLIDE = 'Levitate Idle';

export const ALL_CLIPS: readonly string[] = [...LOCOMOTION, LEAP.start, LEAP.air, LEAP.land, GLIDE];
