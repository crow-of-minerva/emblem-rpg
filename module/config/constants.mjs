/** @layer config */

export const SYSTEM_TITLE = 'Emblem RPG';
export const SYSTEM_VERSION = '1.0.3';

/**
 * World schema version stored in the `schemaVersion` setting: the game version with its dots removed (1.0.3 is 103),
 * raised together with SYSTEM_VERSION on every release. `stampWorldSchema` in
 * `foundry/adapters/services/settings-policy.mjs` stamps it on a fresh world and reports a world behind or ahead, and
 * a world behind it is brought up to date by `init/migrate-world.mjs` on the host's next load.
 */
export const SCHEMA_VERSION = 103;
export const ACTOR_TYPES = Object.freeze({
  CHARACTER: 'Character', CONVOY: 'Convoy', OBJECT: 'Object', VENDOR: 'Vendor'
});
export const ITEM_TYPES = Object.freeze([
  'Class', 'Equipment', 'Consumable', 'Ability', 'Spell', 'Miscellaneous', 'Resource'
]);
