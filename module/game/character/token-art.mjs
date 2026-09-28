/** @layer game/character */
import {
  ON_CAST_CONDITION,
  SPECIFIC_ITEM_CONDITION,
  STEADY_TOKEN_CONDITIONS,
  TOKEN_CONDITIONS,
  TOKEN_ENTRY_REFERENCE_FIELDS,
  USING_ABILITY_CONDITION,
  readTokenEntryGuards,
  readTokenEntryReferences,
  readTokenEntryTriggers,
  tokenEntryReferenceMatches
} from '../../contracts/domains/tokens.mjs';

/*
 * Which token art a Character shows: its steady art, the temporary art a fired condition swaps in, and the vertical
 * offset of the active variant. foundry/adapters/document-writes/tokens.mjs projects the facts these rules read and
 * applies what they select.
 */

/* -------------------------------------------- */
/*  Selection vocabulary                        */
/* -------------------------------------------- */
const TRANSIENT_CONDITIONS = new Set(
  TOKEN_CONDITIONS.filter(condition => !STEADY_TOKEN_CONDITIONS.includes(condition))
);
const MAGIC_REQUIREMENTS = new Set(['Arcane', 'Divine', 'Occult', 'Elemental']);
const WIELDABLE_TYPES = new Set(['Weapon', 'Staff', 'Attack']);
const WIELDING_TESTS = Object.freeze({
  'Wielding: Blade': item => weaponRequirement(item) === 'blade',
  'Wielding: Polearm': item => weaponRequirement(item) === 'polearm',
  'Wielding: Heavy': item => weaponRequirement(item) === 'heavy',
  'Wielding: Brawling': item => weaponRequirement(item) === 'brawling',
  'Wielding: Covert': item => weaponRequirement(item) === 'covert',
  'Wielding: Bow': item => weaponRequirement(item) === 'bow',
  'Wielding: Magic': item => MAGIC_REQUIREMENTS.has(item?.weaponRequirement)
});

/* -------------------------------------------- */
/*  Public selection                            */
/* -------------------------------------------- */
/** Resolve the persistent token art a Character should show now. */
export function selectActiveTokenArt(facts) {
  const baseline = selectBaselineTokenArt(facts);
  const tab = tokenTabForClass(facts);
  const entry = tab ? findActiveSteadyEntry(facts, tab, baseline.slotKey) : null;
  const overridePath = String(entry?.tokens?.[baseline.slotKey] ?? '').trim();
  return {
    path: overridePath || baseline.path,
    scale: baseline.scale,
    slotKey: baseline.slotKey,
    baselinePath: baseline.path,
    baselineScale: baseline.scale,
    isOverride: Boolean(overridePath)
  };
}

/**
 * The temporary art for a condition that just fired, or null if none applies. An entry naming the used item wins
 * over one that names none. A 'Using Ability' entry naming nothing fires for every Active ability, and an 'On Cast'
 * entry naming no spell fires for every cast.
 */
export function selectTransientTokenArt(facts, conditionName, options = {}) {
  const abilityFire = conditionName === USING_ABILITY_CONDITION;
  if (!facts || (!TRANSIENT_CONDITIONS.has(conditionName) && !abilityFire)) return null;
  const baseline = selectBaselineTokenArt(facts);
  const tab = tokenTabForClass(facts);
  if (!tab) return null;
  const usedItem = objectItem(options.usedItem) ?? objectItem(facts.activeItem);
  let entry = usedItem
    ? findTransientEntry(facts, tab, baseline.slotKey, USING_ABILITY_CONDITION, usedItem)
    : null;
  let effectiveCondition = conditionName;
  if (!entry && !abilityFire) {
    entry = findTransientEntry(facts, tab, baseline.slotKey, conditionName, usedItem);
  }
  if (!entry && TRANSIENT_CONDITIONS.has(options.fallback)) {
    entry = findTransientEntry(facts, tab, baseline.slotKey, options.fallback, usedItem);
    if (entry) effectiveCondition = options.fallback;
  }
  const path = String(entry?.tokens?.[baseline.slotKey] ?? '').trim();
  if (!path) return null;
  return { path, scale: baseline.scale, slotKey: baseline.slotKey, condition: effectiveCondition };
}

/** Resolve the active variant's vertical offset in grid units. */
export function activeTokenOffsetY(facts) {
  const slotKey = chooseTokenSlotKey(facts);
  const tab = tokenTabForClass(facts);
  const tabValue = Number(tab?.tokenOffsetsY?.[slotKey]);
  const raw = Number.isFinite(tabValue) ? tabValue : Number(slotKey === 'default' ? facts?.offsets?.default : 0);
  return Number.isFinite(raw) ? Math.max(-0.5, Math.min(1, raw)) : 0;
}

/** Resolve the art slot from flight, the Mount status, and armor. */
function chooseTokenSlotKey(facts) {
  if (facts?.airborne === true) return 'flying';
  const unitType = facts?.unitType ?? {};
  const mounted = facts?.mounted === true;
  if (mounted && unitType.armored === true) return 'armoredCavalry';
  if (mounted) return 'cavalry';
  if (unitType.armored === true) return 'armored';
  return 'default';
}

/** Find the art tab whose name matches the Character's embedded Class. */
function tokenTabForClass(facts) {
  const className = String(facts?.className ?? '').trim().toLowerCase();
  if (!className) return null;
  return (facts?.tabs ?? [])
    .find(tab => String(tab?.name ?? '').trim().toLowerCase() === className) ?? null;
}

/* -------------------------------------------- */
/*  Baseline and condition helpers              */
/* -------------------------------------------- */
function selectBaselineTokenArt(facts) {
  const slotKey = chooseTokenSlotKey(facts);
  const tab = tokenTabForClass(facts);
  let path = String(tab?.tokens?.[slotKey] ?? '').trim();
  let scale = Number(tab?.tokenScales?.[slotKey]);
  if (!path && slotKey === 'default') {
    path = String(facts?.paths?.default ?? '').trim();
    scale = Number(facts?.scales?.default);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  return { path, scale, slotKey };
}

function findActiveSteadyEntry(actor, tab, slotKey) {
  return findEntryByPriority(tab.entries ?? [], entry => {
    if (!entry?.tokens?.[slotKey]) return false;
    const triggers = readTokenEntryTriggers(entry);
    const fires = triggers.some(trigger => !TRANSIENT_CONDITIONS.has(trigger)
      && isSteadyConditionTrue(actor, trigger, entry));
    return fires && guardsPass(actor, entry);
  });
}

function findTransientEntry(actor, tab, slotKey, conditionName, usedItem) {
  return findEntryByPriority(tab.entries ?? [], entry => {
    if (!entry?.tokens?.[slotKey] || !readTokenEntryTriggers(entry).includes(conditionName)) return false;
    if (conditionName === USING_ABILITY_CONDITION && !usedItemMatches(entry, conditionName, usedItem)) return false;
    if (conditionName === ON_CAST_CONDITION && !usedItemMatches(entry, conditionName, usedItem)) return false;
    return guardsPass(actor, entry, usedItem);
  });
}

/** Entries naming Items are tried before entries that name none, so a named pose beats a catch-all. */
function findEntryByPriority(entries, predicate) {
  for (const named of [true, false]) {
    const found = entries.find(entry => entryNamesItems(entry) === named && predicate(entry));
    if (found) return found;
  }
  return null;
}

function guardsPass(actor, entry, usedItem = null) {
  return readTokenEntryGuards(entry)
    .every(guard => isSteadyConditionTrue(actor, guard, entry, usedItem));
}

function isSteadyConditionTrue(actor, condition, entry, usedItem = null) {
  if (!condition || TRANSIENT_CONDITIONS.has(condition)) return false;
  if (condition === SPECIFIC_ITEM_CONDITION) {
    const references = entryReferences(entry, condition);
    return references.length > 0
      && wieldedItems(actor).some(item => tokenEntryReferenceMatches(item, references));
  }
  if (condition === USING_ABILITY_CONDITION) return usedItemMatches(entry, condition, usedItem);
  if (condition === 'Unarmed') {
    return !wieldedItems(actor).some(item => ['Weapon', 'Staff'].includes(item?.itemType));
  }
  const test = WIELDING_TESTS[condition];
  return test ? wieldedItems(actor).some(test) : false;
}

/**
 * Whether the item being used meets an entry's item-naming condition. A list of names matches any of them. An empty
 * 'Using Ability' list matches any Active ability, and an empty 'On Cast' list matches any cast.
 */
function usedItemMatches(entry, condition, usedItem) {
  const references = entryReferences(entry, condition);
  if (references.length) return tokenEntryReferenceMatches(usedItem, references);
  if (condition === USING_ABILITY_CONDITION) return usedItem?.itemType === 'Active';
  return condition === ON_CAST_CONDITION;
}

function entryReferences(entry, condition) {
  return readTokenEntryReferences(entry?.[TOKEN_ENTRY_REFERENCE_FIELDS[condition]]);
}

function entryNamesItems(entry) {
  return [...readTokenEntryTriggers(entry), ...readTokenEntryGuards(entry)]
    .some(condition => condition in TOKEN_ENTRY_REFERENCE_FIELDS && entryReferences(entry, condition).length > 0);
}

/* -------------------------------------------- */
/*  Item helpers                                */
/* -------------------------------------------- */
function wieldedItems(facts) {
  return (facts?.items ?? []).filter(item => item?.isWielded === true
    && WIELDABLE_TYPES.has(item?.itemType));
}

function weaponRequirement(item) {
  return String(item?.weaponRequirement ?? '').toLowerCase();
}

function objectItem(value) {
  return value && typeof value === 'object' ? value : null;
}
