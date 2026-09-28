/** @layer contracts/domains */
import { FACTION_ROLES } from './characters.mjs';
import { plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Scopes                                      */
/* -------------------------------------------- */

/**
 * How wide a GM restore or repair reaches. `scene` covers one Scene's placed units, `world` every unit the world
 * holds, and `selection` the units the caller named. `FoundryDevelopmentRepository.getSnapshot` resolves each one.
 * @type {Readonly<{SCENE: string, WORLD: string, SELECTION: string}>}
 */
export const DEVELOPMENT_SCOPES = Object.freeze({ SCENE: 'scene', WORLD: 'world', SELECTION: 'selection' });

const SCOPE_VALUES = Object.freeze(Object.values(DEVELOPMENT_SCOPES));
const MAX_SELECTED_UNITS = 512;
const MAX_UUID_LENGTH = 512;

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
const RESTORE_INTENT_KEYS = new Set(['scope', 'sceneUuid', 'actorUuids', 'excludeRoles']);
const REPAIR_INTENT_KEYS = new Set(['scope', 'sceneUuid', 'actorUuids']);

/**
 * Validate and detach a full-restore request raised through `api.development.restoreUnits`.
 * `createDevelopmentCommandContribution` re-reads every unit from fresh state, so this only bounds the reach.
 * @param {object} payload The caller's intent.
 * @returns {Readonly<object>|null} The detached intent, or null when the payload is malformed.
 */
export function normalizeRestoreUnitsIntent(payload = {}) {
  const base = normalizeScope(payload, RESTORE_INTENT_KEYS);
  if (!base) return null;
  const excludeRoles = boundedList(payload.excludeRoles, FACTION_ROLES.length);
  if (!excludeRoles || excludeRoles.some(role => !FACTION_ROLES.includes(role))) return null;
  return Object.freeze({ ...base, excludeRoles: Object.freeze(excludeRoles) });
}

/**
 * Validate and detach an item-repair request raised through `api.development.repairItems`. Repair carries no role
 * filter: every Character unit in reach comes back to full uses.
 * @param {object} payload The caller's intent.
 * @returns {Readonly<object>|null} The detached intent, or null when the payload is malformed.
 */
export function normalizeRepairItemsIntent(payload = {}) {
  const base = normalizeScope(payload, REPAIR_INTENT_KEYS);
  return base ? Object.freeze(base) : null;
}

/**
 * Validate and detach a terrain-clearing request raised through `api.development.clearTerrainEffects`. Terrain
 * belongs to one map, so this intent names a Scene and nothing else.
 * @param {object} payload The caller's intent.
 * @returns {Readonly<object>|null} The detached intent, or null when the payload is malformed.
 */
export function normalizeClearTerrainIntent(payload = {}) {
  if (!plainRecord(payload) || Object.keys(payload).some(key => key !== 'sceneUuid')) return null;
  const sceneUuid = String(payload.sceneUuid ?? '');
  if (!sceneUuid || sceneUuid.length > MAX_UUID_LENGTH) return null;
  return Object.freeze({ sceneUuid });
}

/** The scope, Scene and named units both development intents share. */
function normalizeScope(payload, allowedKeys) {
  if (!plainRecord(payload) || Object.keys(payload).some(key => !allowedKeys.has(key))) return null;
  const scope = String(payload.scope ?? '');
  if (!SCOPE_VALUES.includes(scope)) return null;
  const sceneUuid = String(payload.sceneUuid ?? '');
  if (sceneUuid.length > MAX_UUID_LENGTH) return null;
  if (scope === DEVELOPMENT_SCOPES.SCENE && !sceneUuid) return null;
  const actorUuids = boundedList(payload.actorUuids, MAX_SELECTED_UNITS);
  if (!actorUuids || actorUuids.some(uuid => uuid.length > MAX_UUID_LENGTH)) return null;
  if (scope === DEVELOPMENT_SCOPES.SELECTION && !actorUuids.length) return null;
  return { scope, sceneUuid, actorUuids: Object.freeze(actorUuids) };
}

/** An absent list counts as empty. Anything else that isn't an array, or is too long, gives null. */
function boundedList(value, maximum) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) return null;
  return [...new Set(value.map(entry => String(entry ?? '')).filter(Boolean))];
}
