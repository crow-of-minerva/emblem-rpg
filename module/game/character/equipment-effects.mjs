/** @layer game/character */
import { EQUIPMENT_EFFECT_IDS, EQUIPMENT_EFFECT_KINDS } from '../../contracts/domains/items.mjs';
import { compileCharacterData } from './compilation.mjs';

/* -------------------------------------------- */
/*  Equipment effect vocabulary                 */
/* -------------------------------------------- */
const MOUNT_UNIT_TYPES = Object.freeze(['infantry', 'cavalry', 'flying', 'dragon', 'beast', 'monster', 'undead']);
const MOUNT_STAT_KEYS = Object.freeze(['mov', 'hp', 'stn', 'eva', 'atk', 'spd', 'acc', 'crit']);
/** The item fields that mark a piece of gear as in use, which also switches on its equipped-only modifiers. */
const EQUIP_FLAGS = Object.freeze(['isWielded', 'isWorn', 'isEquipped']);

/* -------------------------------------------- */
/*  Reconciliation planning                     */
/* -------------------------------------------- */
/**
 * The wield, armor and mount effects a unit should carry for the gear it has in use: which stray or duplicate
 * effects to delete and which missing ones to create. Called by engine/character/commands.mjs when it reconciles a
 * Character's equipment effects, and by the other planners in this file. FoundryActorRepository
 * (foundry/adapters/document-writes/characters.mjs) writes the plan.
 * @param {object} actor Inventory facts from FoundryActorRepository.getInventorySnapshot.
 * @returns {{deleteIds: string[], createIntents: object[]}}
 */
export function planEquipmentEffectReconciliation(actor) {
  const items = plainArray(actor.items);
  const effects = plainArray(actor.effects);
  const deleteIds = new Set();
  const createIntents = [];

  const armament = actor.armament?.armament === true ? actor.armament : null;
  planFixedEffect({
    current: armament ?? items.find(isWieldedItem) ?? null,
    effects: effects.filter(effect => effectKind(effect) === EQUIPMENT_EFFECT_KINDS.WIELD),
    fixedId: EQUIPMENT_EFFECT_IDS.WIELD,
    kind: EQUIPMENT_EFFECT_KINDS.WIELD,
    matches: (effect, item) => (item?.armament === true
      ? String(effect?.origin ?? '') === String(item.uuid ?? '')
      : effectItemId(effect) === itemId(item))
  }, deleteIds, createIntents);
  planFixedEffect({
    current: items.find(isWornArmor) ?? null,
    effects: effects.filter(effect => effectKind(effect) === EQUIPMENT_EFFECT_KINDS.ARMOR),
    fixedId: EQUIPMENT_EFFECT_IDS.ARMOR,
    kind: EQUIPMENT_EFFECT_KINDS.ARMOR,
    matches: (effect, item) => effectItemId(effect) === itemId(item)
  }, deleteIds, createIntents);
  planMountEffect(items, effects, deleteIds, createIntents);

  return effectPlan(deleteIds, createIntents);
}

/**
 * The effect and resource changes that follow an equipment toggle planned by buildEquipmentToggle. Called by
 * engine/character/commands.mjs for a toggle and for items whose requirements have lapsed.
 * Stn follows one rule for every piece of gear, measured by stanceGrantChange. A piece coming off takes back the max
 * Stn it granted, never going below 0. A piece going on then adds the max Stn it grants, unless the unit is
 * stance-broken, because any Stn would lift the break (compileCharacterData still raises its max). A mount that
 * becomes active also adds its HP. Wielding a carried weapon clears the borrowed Armament reference.
 * FoundryActorRepository.settleEquipmentToggle writes the resulting `resourceValues`.
 * @param {object} actor Inventory facts from FoundryActorRepository.getInventorySnapshot, with the unit's detached
 *   compile source as `stanceSource` (FoundryActorRepository.getStanceSource) when Stn is to be measured.
 * @param {object[]} updates The toggle's item updates.
 * @returns {{effects: object, resourceValues: Record<string, number>}}
 */
export function planEquipmentToggleConsequences(actor, updates) {
  const previousItems = plainArray(actor.items);
  const nextItems = applyItemUpdates(previousItems, updates);
  const values = { hp: resourceValue(actor, 'hp'), stn: resourceValue(actor, 'stn') };
  const stance = stanceGrantChange(actor.stanceSource, updates);
  values.stn = Math.max(0, values.stn - stance.lost);
  const previousMount = previousItems.find(isActiveMount) ?? null;
  const nextMount = nextItems.find(isActiveMount) ?? null;
  if (!previousMount && nextMount) values.hp += positiveNumber(nextMount.system?.mountData?.stats?.hp);
  if (actor.system?.statuses?.stanceBroken !== true) values.stn += stance.gained;
  const wieldsOwnWeapon = updates.some(update => update['system.isWielded'] === true);
  return {
    effects: planEquipmentEffectReconciliation({
      ...actor, items: nextItems, armament: wieldsOwnWeapon ? null : actor.armament ?? null
    }),
    resourceValues: changedResourceValues(actor, values)
  };
}

/**
 * The equipment-effect changes the giving unit needs once an item leaves it. With `move` false the item is copied
 * rather than moved, so nothing changes. Called by engine/character/commands.mjs for transfers and capacity moves.
 */
export function planEquipmentTransferConsequences(actor, itemIdToRemove, { move = true } = {}) {
  if (!move) return effectPlan(new Set(), []);
  const items = plainArray(actor.items).filter(item => itemId(item) !== String(itemIdToRemove ?? ''));
  return planEquipmentEffectReconciliation({ ...actor, items });
}

/**
 * The Stn a unit keeps when a piece of its gear leaves it (an inventory transfer or a capacity move): the piece comes
 * off first, so it takes back the max Stn it granted, never below 0. Nothing changes for gear that was not in use.
 * @param {object} actor Inventory facts with `stanceSource`, as for planEquipmentToggleConsequences.
 * @param {string} itemIdToRemove The departing Item.
 * @returns {Record<string, number>} `{stn}` when the value changes, else empty.
 */
export function planEquipmentDepartureResources(actor, itemIdToRemove) {
  const id = String(itemIdToRemove ?? '');
  const leaving = Object.fromEntries(EQUIP_FLAGS.map(flag => [`system.${flag}`, false]));
  const stance = stanceGrantChange(actor.stanceSource, [{ _id: id, ...leaving }]);
  return changedResourceValues(actor, { stn: Math.max(0, resourceValue(actor, 'stn') - stance.lost) });
}

/* -------------------------------------------- */
/*  Stance grants                               */
/* -------------------------------------------- */
/**
 * Measure what a change of equip flags does to a unit's max Stn by compiling its detached source three ways: as it
 * stands, with only the pieces coming off removed, and with the whole change applied. The pieces coming off take
 * back the first difference and the pieces going on grant the second, so a swap takes the old piece's Stn before it
 * adds the new one's. Anything that raises the max counts: armor, shields, mounts and equipped-only item modifiers.
 * With no source (a Convoy, or a caller that measures nothing), nothing is lost or gained.
 * @param {object|null} source Detached compile source from projectCharacterSource.
 * @param {object[]} updates Item updates keyed `system.isWielded`, `system.isWorn` or `system.isEquipped`.
 * @returns {{lost: number, gained: number}}
 */
function stanceGrantChange(source, updates) {
  if (!source || !Array.isArray(source.items)) return { lost: 0, gained: 0 };
  const changes = plainArray(updates).map(update => ({
    id: String(update._id ?? ''),
    flags: Object.fromEntries(EQUIP_FLAGS
      .filter(flag => typeof update[`system.${flag}`] === 'boolean')
      .map(flag => [flag, update[`system.${flag}`]]))
  })).filter(change => Object.keys(change.flags).length);
  if (!changes.length) return { lost: 0, gained: 0 };
  const removals = changes.map(change => ({
    id: change.id,
    flags: Object.fromEntries(Object.entries(change.flags).filter(([, value]) => value === false))
  }));
  const before = compiledStanceMax(source, []);
  const afterRemovals = compiledStanceMax(source, removals);
  const after = compiledStanceMax(source, changes);
  return { lost: Math.max(0, before - afterRemovals), gained: Math.max(0, after - afterRemovals) };
}

function compiledStanceMax(source, changes) {
  const byId = new Map(changes.map(change => [change.id, change.flags]));
  const items = source.items.map(item => (byId.has(String(item?.id ?? '')) ? { ...item, ...byId.get(String(item.id)) }
    : item));
  return Math.max(0, Number(compileCharacterData({ ...source, items }).resources?.stn?.max) || 0);
}

function changedResourceValues(actor, values) {
  const changed = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== resourceValue(actor, key)) changed[key] = value;
  }
  return changed;
}

/* -------------------------------------------- */
/*  Planning helpers                            */
/* -------------------------------------------- */
function planFixedEffect(policy, deleteIds, createIntents) {
  if (!policy.current) {
    for (const effect of policy.effects) addEffectId(deleteIds, effect);
    return;
  }
  const matching = policy.effects.filter(effect => policy.matches(effect, policy.current));
  const canonical = matching.find(effect => effectId(effect) === policy.fixedId) ?? null;
  for (const effect of policy.effects) if (effect !== canonical) addEffectId(deleteIds, effect);
  if (!canonical) createIntents.push(buildEffectIntent(policy.kind, policy.current));
}

function planMountEffect(items, effects, deleteIds, createIntents) {
  const mount = items.find(isActiveMount) ?? null;
  const mountEffects = effects.filter(effect => effectKind(effect) === EQUIPMENT_EFFECT_KINDS.MOUNT);
  if (!mount) {
    for (const effect of mountEffects) addEffectId(deleteIds, effect);
    return;
  }
  const matching = mountEffects.filter(effect => effectItemId(effect) === itemId(mount));
  const retained = matching[0] ?? null;
  for (const effect of mountEffects) if (effect !== retained) addEffectId(deleteIds, effect);
  if (!retained) createIntents.push(buildEffectIntent(EQUIPMENT_EFFECT_KINDS.MOUNT, mount));
}

function buildEffectIntent(kind, item) {
  const intent = {
    kind,
    item: {
      id: itemId(item),
      uuid: String(item?.uuid ?? ''),
      name: String(item?.name ?? ''),
      img: String(item?.img ?? '')
    }
  };
  if (kind !== EQUIPMENT_EFFECT_KINDS.MOUNT) return intent;
  const sourceStats = item?.system?.mountData?.stats ?? {};
  const sourceTypes = item?.system?.mountData?.unitTypes ?? {};
  return {
    ...intent,
    mount: {
      stats: Object.fromEntries(MOUNT_STAT_KEYS.map(key => [key, Number(sourceStats[key]) || 0])),
      unitTypes: Object.fromEntries(MOUNT_UNIT_TYPES.map(key => [key, sourceTypes[key] === true]))
    }
  };
}

function applyItemUpdates(items, updates) {
  const byId = new Map(plainArray(updates).map(update => [String(update._id ?? ''), update]));
  return items.map(item => {
    const update = byId.get(itemId(item));
    if (!update) return item;
    const system = structuredClone(item?.system ?? {});
    for (const [path, value] of Object.entries(update)) {
      if (!path.startsWith('system.')) continue;
      setPath(system, path.slice(7), value);
    }
    return { ...item, system };
  });
}

function setPath(root, path, value) {
  const parts = path.split('.');
  let node = root;
  for (const part of parts.slice(0, -1)) node = node[part] ??= {};
  node[parts.at(-1)] = value;
}

function isWieldedItem(item) {
  const itemType = String(item?.system?.itemType ?? '');
  return item?.system?.isWielded === true
    && ((item?.type === 'Equipment' && ['Weapon', 'Staff'].includes(itemType))
      || (item?.type === 'Spell' && itemType === 'Attack'));
}

function isWornArmor(item) {
  return item?.type === 'Equipment' && item?.system?.itemType === 'Armor' && item?.system?.isWorn === true;
}

function isActiveMount(item) {
  return item?.type === 'Ability' && item?.system?.itemType === 'Mount' && item?.system?.isEquipped === true;
}

function effectKind(effect) {
  return String(effect?.equipmentKind ?? '');
}

function effectItemId(effect) {
  return String(effect?.equipmentItemId ?? '');
}

function resourceValue(actor, key) {
  return Math.max(0, Number(actor.system?.resources?.[key]?.value) || 0);
}

function positiveNumber(value) {
  return Math.max(0, Number(value) || 0);
}

function effectId(effect) {
  return String(effect?.id ?? effect?._id ?? '');
}

function itemId(item) {
  return String(item?.id ?? item?._id ?? '');
}

function addEffectId(ids, effect) {
  const id = effectId(effect);
  if (id) ids.add(id);
}

function effectPlan(deleteIds, createIntents) {
  return { deleteIds: [...deleteIds], createIntents: [...createIntents] };
}

function plainArray(value) {
  return Array.isArray(value) ? [...value] : [];
}
