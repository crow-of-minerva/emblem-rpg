/** @layer game/character */
import { RALLY_GRANT_KEY, SUPPORT_ELIGIBLE_ACTOR_TYPES } from '../../contracts/domains/progression.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { UNIT_TYPE_KEYS } from '../../contracts/domains/characters.mjs';
import { structurallyEqual } from '../../lib/core/runtime.mjs';
import { buildRallyAbility, isRallyAbilityName, rallyAbilityName } from '../support/rally-ability.mjs';

/* -------------------------------------------- */
/*  Grant definitions                           */
/* -------------------------------------------- */
export const INNATE_GRANT_FLAG = 'innateGrant';

/** Unit types that fight unarmed when they have nothing in hand. */
const UNARMED_UNIT_TYPES = Object.freeze(['infantry', 'armored']);

/**
 * The items a Character is given automatically while it qualifies. Used by planInnateGrants and INNATE_SOURCE_NAMES
 * here, and by getInnateGrantSnapshot in foundry/adapters/document-writes/characters.mjs, which finds a grant's
 * source item by `itemName` in the world or a compendium, or makes it with `build` from the unit's affinity and the
 * affinity table. `qualifies` is checked again on every sync. `adopts` lets an item the unit already carries become
 * the grant. With `refresh`, changes to the source are copied onto the granted item, keeping the unit's icon,
 * equipment state and spent uses. A built grant's `name` is the name `build` would give it; a unit holding its grant
 * under that name is not synced at all (innateGrantsHeld), so a refresh reaches a held grant only through a rename.
 */
export const INNATE_GRANTS = Object.freeze([
  Object.freeze({
    key: 'infantry-unarmed',
    itemName: 'Unarmed Attack',
    qualifies: unit => soleUnitTypeIsOneOf(unit.unitType, UNARMED_UNIT_TYPES)
  }),
  Object.freeze({
    key: RALLY_GRANT_KEY,
    build: buildRallyAbility,
    name: rallyAbilityName,
    qualifies: unit => SUPPORT_ELIGIBLE_ACTOR_TYPES.includes(String(unit.actorType ?? '')),
    adopts: item => item.type === 'Ability' && isRallyAbilityName(item.name),
    refresh: true
  })
]);

/**
 * The lowercased names of the source items grants find by name. invalidateInnateSource (document-writes/characters.mjs)
 * uses them to recognise an edit to a source item by name alone.
 */
export const INNATE_SOURCE_NAMES = Object.freeze(new Set(INNATE_GRANTS
  .filter(grant => grant.itemName).map(grant => grant.itemName.toLowerCase())));

/**
 * Per-unit state a refresh must preserve: a refresh replaces the granted item's whole system block from the source,
 * which would otherwise unwield it and refill its uses.
 */
const REFRESH_STATE_PATHS = Object.freeze(['isWielded', 'isWorn', 'isEquipped', 'uses.current']);

/* -------------------------------------------- */
/*  Sync planning                               */
/* -------------------------------------------- */
/**
 * Decide which innate items to create, refresh, adopt or delete for one Character. Called by reconcileInnateGrants
 * in engine/character/commands.mjs, whose writer (settleInnateGrants) applies updates, then deletions, then
 * creations. When the unit holds more than one copy of a grant, the first is kept and the rest are deleted.
 * @param {object} unit Detached unit facts: `type`, `actorType`, `unitType`, `items` (each with `innateGrant`).
 * @param {Record<string, object|null>} sources Grant key to the source item's detached data, null when unresolved.
 * @returns {{updates: object[], deleteIds: string[], creates: object[]}}
 */
export function planInnateGrants(unit, sources = {}) {
  const empty = { updates: [], deleteIds: [], creates: [] };
  if (!unit || unit.type !== 'Character') return empty;
  const items = unit.items ?? [];
  const updates = [];
  const deleteIds = [];
  const creates = [];

  for (const grant of INNATE_GRANTS) {
    let owned = items.filter(item => item.innateGrant === grant.key);
    if (!grant.qualifies(unit)) {
      deleteIds.push(...owned.map(item => item.id));
      continue;
    }
    let adopted = false;
    if (!owned.length && grant.adopts) {
      owned = items.filter(item => !item.innateGrant && grant.adopts(item));
      adopted = owned.length > 0;
    }
    if (owned.length > 1) deleteIds.push(...owned.slice(1).map(item => item.id));
    const source = sources[grant.key] ?? null;
    if (!owned.length) {
      if (source) creates.push(buildGrantData(grant, source));
      continue;
    }
    const refresh = grant.refresh && source ? planInnateRefresh(owned[0], buildGrantData(grant, source)) : null;
    if (refresh) updates.push(refresh);
    else if (adopted) updates.push(...owned.map(item => planInnateAdoption(item, grant)));
  }
  return { updates, deleteIds, creates };
}

/**
 * Creation data for a new grant: a copy of the source item without its `_id`, `_stats`, sort, folder or ownership,
 * unequipped, and flagged with the grant's key.
 */
function buildGrantData(grant, source) {
  const data = structuredClone(source);
  for (const field of ['_id', '_stats', 'sort', 'folder', 'ownership']) delete data[field];
  data.system = data.system ?? {};
  data.system.isWielded = false;
  data.system.isWorn = false;
  data.system.isEquipped = false;
  data.flags = data.flags ?? {};
  data.flags[SYSTEM_ID] = { ...(data.flags[SYSTEM_ID] ?? {}) };
  data.flags[SYSTEM_ID][INNATE_GRANT_FLAG] = grant.key;
  return data;
}

/**
 * The update that copies the source item onto a granted item, or null when nothing differs. The icon, equipment
 * state and spent uses stay the unit's own: the icon is set only when the grant is created. System data and flags
 * are replaced whole, so fields removed from the source go too.
 * @param {object} current The granted item as detached data: `id`, `name`, `system` and its flags.
 * @param {object} data Freshly built grant data.
 * @returns {object|null}
 */
function planInnateRefresh(current, data) {
  const system = structuredClone(data.system ?? {});
  for (const path of REFRESH_STATE_PATHS) {
    const value = readPath(current.system ?? {}, path);
    if (value !== undefined) writePath(system, path, value);
  }
  const flags = data.flags?.[SYSTEM_ID] ?? {};
  const stale = current.name !== data.name
    || !structurallyEqual(current.system ?? {}, system)
    || !structurallyEqual(current.flags?.[SYSTEM_ID] ?? {}, flags);
  if (!stale) return null;
  return { kind: 'refresh', itemId: current.id, name: data.name, system, flags: { ...flags } };
}

/** Build the adoption update for planInnateGrants, which marks an item the unit already carries as the grant. */
function planInnateAdoption(item, grant) {
  return { kind: 'adopt', itemId: item.id, grantKey: grant.key };
}

/* -------------------------------------------- */
/*  Triggers                                    */
/* -------------------------------------------- */
/**
 * Whether a Character already holds what planInnateGrants would leave it with: one flagged copy of each grant it
 * qualifies for, carrying the grant's current `name` when it has one, and no copy of a grant it doesn't qualify for.
 * foundry/hooks/innate-grants.mjs skips the sync for such a unit without building any source.
 * @param {object} unit Detached unit facts, as planInnateGrants reads them.
 * @param {Record<string, string>} names Grant key to the name its `name` gives this unit now.
 * @returns {boolean}
 */
export function innateGrantsHeld(unit, names = {}) {
  const items = unit.items ?? [];
  return INNATE_GRANTS.every(grant => {
    const owned = items.filter(item => item.innateGrant === grant.key);
    if (!grant.qualifies(unit)) return owned.length === 0;
    return owned.length === 1 && (!grant.name || owned[0].name === names[grant.key]);
  });
}

/** Tell foundry/hooks/innate-grants.mjs whether an Item change requires a grant sync. */
export function innateGrantsAffectedByItemChange(item, changedPaths = []) {
  if (item?.type === 'Class') return true;
  const watched = ['system.isWorn', 'system.armor.req', 'system.unitType', 'system.mountData.unitTypes'];
  return changedPaths.some(path => watched.some(prefix => path === prefix || path.startsWith(`${prefix}.`)));
}

/** Tell foundry/hooks/innate-grants.mjs whether an Actor change affects grant eligibility or a built grant's data. */
export function innateGrantsAffectedByActorChange(changedPaths = []) {
  const watched = ['system.innateUnitType', 'system.unitType', 'system.faction.role', 'system.support.affinity'];
  return changedPaths.some(path => watched.some(prefix => path === prefix || path.startsWith(`${prefix}.`)));
}

/** Tell foundry/hooks/innate-grants.mjs whether an ActiveEffect changes fields used by grant conditions. */
export function innateGrantsAffectedByEffectChange(changes = []) {
  return innateGrantsAffectedByActorChange(changes.map(change => String(change?.key ?? '')));
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
/** Whether the unit has exactly one unit type and it is in `allowed`. A unit with mixed types doesn't qualify. */
function soleUnitTypeIsOneOf(unitType, allowed) {
  if (!unitType) return false;
  const active = UNIT_TYPE_KEYS.filter(key => unitType[key] === true);
  return active.length === 1 && allowed.includes(active[0]);
}

function readPath(record, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), record);
}

function writePath(record, path, value) {
  const keys = path.split('.');
  let cursor = record;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
}
