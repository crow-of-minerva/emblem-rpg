/** @layer config */

/* -------------------------------------------- */
/*  System configuration                        */
/* -------------------------------------------- */
export const SYSTEM_TITLE = 'Emblem RPG';
export const SYSTEM_VERSION = '1.0.2a';

/**
 * World schema version stored in the `schemaVersion` setting. `stampWorldSchema` in
 * `foundry/adapters/services/settings-policy.mjs` stamps it on a fresh world and reports a world behind or ahead.
 * A world behind it is brought up to date by `init/migrate-world.mjs` on the host's next load, so raise it whenever
 * the Migrate World Content macro gains work that existing worlds need.
 */
export const SCHEMA_VERSION = 4;

/** Milliseconds between the steps a held movement key repeats until the browser's own key repeat takes over. */
export const MOVEMENT_HOLD_REPEAT_DELAY_MS = 125;

/**
 * Grid types a Scene may use: gridless (0) and square (1). The Scene guards in foundry/hooks/scene.mjs and the Scene
 * config grid list (ui/apps/foundry/scene-config.mjs) read it. game/ movement rules use square cells.
 */
export const SUPPORTED_GRID_TYPES = Object.freeze([0, 1]);

/** Sprite magnification the Foundry token adapters apply on top of the scale set in the Actor Control Panel. */
export const TOKEN_BASE_MAGNIFICATION = 2;

/** The prototype sight a new unit is created with, in grid units. The Actor Control Panel's sight fields change it. */
export const DEFAULT_UNIT_SIGHT_RANGE = 5;

export const ACTOR_TYPES = Object.freeze({
  CHARACTER: 'Character',
  CONVOY: 'Convoy',
  OBJECT: 'Object',
  VENDOR: 'Vendor'
});

export const ITEM_TYPES = Object.freeze([
  'Class',
  'Equipment',
  'Consumable',
  'Ability',
  'Spell',
  'Miscellaneous',
  'Resource'
]);
