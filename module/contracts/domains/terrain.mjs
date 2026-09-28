/** @layer contracts/domains */
import { DAMAGE_TYPES } from './damage.mjs';
import { exactKeys, plainRecord } from '../protocol.mjs';
import { FACTION_GROUPS } from './characters.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
export const TERRAIN_GRID_FLAG = 'terrainGrid';
export const TERRAIN_ZONES_FLAG = 'terrainZones';
export const TERRAIN_EDIT_RECORDS_FLAG = 'terrainEffectEdits';

export const TERRAIN_CELL_DEFAULTS = Object.freeze({
  movementCost: 1,
  evasionMod: 0,
  defMod: 0,
  resMod: 0,
  obstacle: false,
  impassable: false
});

export const CROSSING_DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
export const CROSSING_DC_MULT_DEFAULT = 5;

/** What a square may say about the skill an elevation boundary is crossed with. */
export const CROSSING_SKILLS = Object.freeze({
  DISABLED: 'disabled',
  ATHLETICS: 'athletics',
  FINESSE: 'finesse',
  EITHER: 'either'
});

/** The column and row step of each crossing direction. */
export const CROSSING_DIRECTION_STEPS = Object.freeze({
  up: Object.freeze([0, -1]),
  down: Object.freeze([0, 1]),
  left: Object.freeze([-1, 0]),
  right: Object.freeze([1, 0])
});

/**
 * The possible results of forcing a unit one step: level ground it's simply moved onto, a drop it must cross, or a
 * square it can't be put on, named by what stops it (a climb, another unit, or a blocked landing).
 */
export const FORCED_STEP_OUTCOMES = Object.freeze({
  WALK: 'walk',
  DESCENT: 'descent',
  ASCENT: 'ascent',
  OCCUPIED: 'occupied',
  BLOCKED: 'blocked'
});

/** How far a leap may land from its origin, and how many bridging squares one walk may pass through. */
export const MAX_BRIDGE_SPAN = 8;
export const MAX_BRIDGE_NETWORK = 64;

/** How badly a descent must be missed before the whole fall is taken. */
export const FALL_MARGIN = 10;

/** Base fall damage as a fraction of maximum health, by levels descended. Beyond the table it grows linearly. */
export const FALL_BASE_FRACTIONS = Object.freeze({ 1: 0.25, 2: 0.5, 3: 1, 4: 1.5 });

/** What a teleport pad charges the unit that steps off it. */
export const TELEPORT_COSTS = Object.freeze({
  STANDARD: 'standard',
  BONUS: 'bonus',
  MOVEMENT: 'movement'
});

/**
 * What a teleport hop's settlement reports (foundry/adapters/document-writes/movement-settlements.mjs): settled,
 * stale (nothing written) or reverted (undone after a failed write). No writer produces `blocked` or
 * `recovery-required`.
 */
export const TELEPORT_SETTLEMENT_OUTCOMES = Object.freeze({
  SETTLED: 'settled',
  STALE: 'stale',
  BLOCKED: 'blocked',
  REVERTED: 'reverted',
  RECOVERY_REQUIRED: 'recovery-required'
});

export const TILE_EFFECT_TYPES = Object.freeze(['healing', ...DAMAGE_TYPES]);
export const EXCEPTION_SELECTORS = Object.freeze([
  Object.freeze({ value: 'unitType', label: 'Unit Type' }),
  Object.freeze({ value: 'faction', label: 'Faction Type' }),
  Object.freeze({ value: 'name', label: 'Name' }),
  Object.freeze({ value: 'actorId', label: 'Actor ID' })
]);
export const EXCEPTION_FACTIONS = Object.freeze(Object.keys(FACTION_GROUPS).map(group => Object.freeze({
  value: group,
  label: `${group[0].toUpperCase()}${group.slice(1)}`
})));
export const TERRAIN_UNIT_TYPES = Object.freeze([
  'infantry', 'armored', 'cavalry', 'flying', 'dragon', 'beast', 'monster', 'undead'
]);
export const SPAWN_BEHAVIORS = Object.freeze([
  Object.freeze({ value: '', label: 'None' }),
  Object.freeze({ value: 'pursue', label: 'Pursuant' }),
  Object.freeze({ value: 'freeRoam', label: 'Roaming' }),
  Object.freeze({ value: 'seize', label: 'Seizing' })
]);
export const SPAWN_BEHAVIOR_VALUES = Object.freeze(SPAWN_BEHAVIORS.map(entry => entry.value));
export const SPAWN_BEHAVIOR_FACTIONS = Object.freeze([...FACTION_GROUPS.enemy, ...FACTION_GROUPS.neutral]);

export const TERRAIN_STAT_FLAGS = Object.freeze({
  eva: 'terrainEvasionMod',
  def: 'terrainDefMod',
  res: 'terrainResMod'
});
export const TERRAIN_STAT_FIELDS = Object.freeze({
  evasionMod: TERRAIN_STAT_FLAGS.eva,
  defMod: TERRAIN_STAT_FLAGS.def,
  resMod: TERRAIN_STAT_FLAGS.res
});
export const TERRAIN_SPAWN_STATE_FLAG = 'terrainSpawnState';
export const TERRAIN_SPAWN_BEHAVIOR_FLAG = 'spawnBehavior';

/** The stage a spawn square's arrival record carries once the arrival completed and the square is on cooldown. */
export const TERRAIN_SPAWN_STAGES = Object.freeze({
  COMPLETED: 'completed'
});

/** The codes a terrain persistence sweep may return, which a caller must tell apart. */
export const TERRAIN_PERSISTENCE_CODES = Object.freeze({
  MISSING_SCENE: 'missing-scene',
  NO_OP: 'no-op',
  APPLIED: 'applied',
  STALE: 'stale',
  WRITE_FAILED: 'write-failed'
});

export const MAX_SPAWN_DISPLACEMENT = 10;

/** Encode grid coordinates as the row-column Scene flag key used by terrain writers and projections. */
export function terrainKey(x, y) {
  return `${y}-${x}`;
}

/** Decode a terrain cell key into canvas grid coordinates. */
export function parseTerrainKey(key) {
  const text = String(key);
  const dash = text.indexOf('-');
  return { y: Number(text.slice(0, dash)), x: Number(text.slice(dash + 1)) };
}

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */
/**
 * Crossing timings: the wait for the dice, and the pause after a failed climb. The engine waits on its own clock,
 * not on Dice So Nice.
 */
export const CROSSING_ATTEMPT_TIMING = Object.freeze({ diceSettleHold: 2600, failedAscentHold: 1200 });

/**
 * How long a driven walk may wait for the Token it moved. Only SETTLE_MAX_MS is read: the wait is worked out from the
 * walk's animation speed and capped at it (movement.mjs and effect-execution.mjs in foundry/adapters/document-writes).
 */
export const DRIVEN_WALK_TIMING = Object.freeze({
  POLL_MS: 50,
  SETTLE_BASE_MS: 1200,
  SETTLE_PER_STEP_MS: 700,
  SETTLE_MAX_MS: 15000
});

export const TERRAIN_SPAWN_FADE_MS = 500;
export const TERRAIN_SPAWN_SETTLE_MS = 500;

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
export const TERRAIN_SPAWN_PRESENTATION_KIND = 'terrain-spawn';

const TERRAIN_SPAWN_MESSAGE_KEYS = Object.freeze(['kind', 'x', 'y']);

/** Build the arrival message that pings every client where a spawn square fired. */
export function terrainSpawnPresentationMessage(data) {
  return Object.freeze({
    kind: TERRAIN_SPAWN_PRESENTATION_KIND,
    x: Number(data?.x) || 0,
    y: Number(data?.y) || 0
  });
}

/** Check a bounded spawn-arrival message before it crosses the presentation socket. */
export function isTerrainSpawnPresentationMessage(value) {
  if (!plainRecord(value) || !exactKeys(value, TERRAIN_SPAWN_MESSAGE_KEYS)) return false;
  if (value.kind !== TERRAIN_SPAWN_PRESENTATION_KIND) return false;
  return typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y);
}
