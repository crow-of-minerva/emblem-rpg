/** @layer contracts/domains */

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
/**
 * The resource key the door sight reconciliation lists (engine/board.mjs). Resource keys only record what a command
 * touches (holdsResources in engine/dispatcher.mjs). They serialize nothing, since world execution already runs one
 * command at a time.
 */
export const DOOR_SIGHT_RESOURCE_KEY = 'vision:doors';

/** The resource key for aura values on the whole board. */
const AURA_BOARD_RESOURCE_KEY = 'auras:board';

/** The resource key for terrain modifier values on the whole board. */
const TERRAIN_BOARD_RESOURCE_KEY = 'terrain:board';

/** Aura and terrain values land in one write per unit, so the modifier reconciliation lists both board keys. */
export const MODIFIER_BOARD_RESOURCE_KEYS = Object.freeze([
  AURA_BOARD_RESOURCE_KEY,
  TERRAIN_BOARD_RESOURCE_KEY
]);

export const INSPECTION_KINDS = Object.freeze({
  NAME_ONLY: 'name-only',
  LOCK: 'lock',
  ARMAMENT: 'armament',
  DESTRUCTIBLE: 'destructible',
  UNIT: 'unit'
});

