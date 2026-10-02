/** @layer contracts/domains */

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
/**
 * The resource key the door sight update claims (engine/board.mjs). Resource keys lock nothing, since commands
 * already run one at a time; they record what a running command touches.
 */
export const DOOR_SIGHT_RESOURCE_KEY = 'vision:doors';

/** The resource key for aura values on the whole map. */
const AURA_BOARD_RESOURCE_KEY = 'auras:board';

/** The resource key for terrain modifier values on the whole map. */
const TERRAIN_BOARD_RESOURCE_KEY = 'terrain:board';

/** Aura and terrain values land in one write per unit, so the command that refreshes them claims both keys. */
export const MODIFIER_BOARD_RESOURCE_KEYS = Object.freeze([
  AURA_BOARD_RESOURCE_KEY,
  TERRAIN_BOARD_RESOURCE_KEY
]);

/** Which panel inspecting a token shows: its name only, a lock, an armament, a destructible object, or a unit. */
export const INSPECTION_KINDS = Object.freeze({
  NAME_ONLY: 'name-only',
  LOCK: 'lock',
  ARMAMENT: 'armament',
  DESTRUCTIBLE: 'destructible',
  UNIT: 'unit'
});

