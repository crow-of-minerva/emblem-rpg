/** @layer game/items */
import { DAMAGE_TYPES } from '../../contracts/domains/damage.mjs';
import { capitalize } from '../../lib/dom/html.mjs';
import { SafeEval } from '../../lib/core/safe-eval.mjs';

/* -------------------------------------------- */
/*  Item Preparation                            */
/* -------------------------------------------- */
const REFINEMENT_TIER_PATTERN = /\s*\(\+(\d+)\)\s*$/;
const WEAPON_FIELDS = new Set(['Weapon', 'Staff', 'Staff (U)', 'Attack', 'Utility']);
const ARMOR_FIELDS = new Set(['Armor', 'Shield']);
const WEAPON_ART_PROFICIENCIES = ['brawling', 'blade', 'polearm', 'heavy', 'bow', 'covert'];
const VALUE_MULTIPLIERS = [1, 1.25, 1.5, 2, 2.5, 3];
const REFINEMENT_TIER_COUNT = 5;
const DEFAULT_FORGE_MULT = 1;
const DEFAULT_FORGE_SKILL = 'Handicraft';
const ARMOR_DURABILITY_DEFAULTS = Object.freeze({ Light: 50, Medium: 75, Heavy: 100 });
const DEFAULT_DURABILITY = 30;

const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;

/** The refinement tier a name's "(+N)" suffix shows, from 0 to 5. */
export function refinementTier(name) {
  return Math.max(0, Math.min(5, Number(String(name ?? '').match(REFINEMENT_TIER_PATTERN)?.[1]) || 0));
}

/** The name without its "(+N)" refinement suffix. */
export function baseItemName(name) {
  return String(name ?? '').replace(REFINEMENT_TIER_PATTERN, '').trim();
}

function refinementName(baseName, tier) {
  const base = baseItemName(baseName);
  return tier > 0 ? `${base} (+${tier})` : base;
}

/**
 * Whether an item's name and forging XP are allowed where it's stored. Only a copy a unit carries can have a
 * "(+N)" name or forging XP, never a world or compendium item. EmblemItem (foundry/documents/items.mjs) refuses
 * the write otherwise.
 */
export function databaseRefinementAllowed({ embedded, name, forgingXP = 0 }) {
  return embedded || (refinementTier(name) === 0 && !(numeric(forgingXP) > 0));
}

/** Plan the Foundry Item reset when a refined embedded copy is renamed to a different base item. */
export function refinementRenameReset({ documentType, embedded, oldName, newName, baseSystem }) {
  if (documentType !== 'Equipment' || !embedded || !refinementTier(oldName) || !baseSystem) return null;
  if (baseItemName(oldName) === baseItemName(newName)) return null;
  return {
    system: {
      weapon: baseSystem.weapon,
      armor: baseSystem.armor,
      wgt: baseSystem.wgt,
      uses: { max: baseSystem.uses?.max ?? 0 }
    },
    baseName: baseItemName(newName),
    refined: refinementTier(newName) > 0
  };
}

function addAttackBonus(base, bonus) {
  const amount = numeric(bonus);
  const current = String(base ?? '').trim();
  if (!amount) return base;
  if (/^-?\d+$/.test(current)) return String(parseInt(current, 10) + amount);
  const tail = current.match(/^(.+?)([+-]\d+)$/);
  if (tail) {
    const folded = parseInt(tail[2], 10) + amount;
    return folded === 0 ? tail[1] : folded > 0 ? `${tail[1]}+${folded}` : `${tail[1]}${folded}`;
  }
  return amount > 0 ? `${current}+${amount}` : `${current}${amount}`;
}

/* -------------------------------------------- */
/*  Forging                                     */
/* -------------------------------------------- */

/**
 * The values an item's type fixes, as flattened `system.*` changes, or null when the item already holds them: a
 * Booster is always a Standard Action, and an Armor without a durability maximum gets its armor class default, full.
 * @param {object} system The system data as it will be stored.
 * @returns {Record<string, *>|null}
 */
export function settleItemTypeRules(system) {
  const changes = {};
  if (system?.itemType === 'Booster' && system.actionType !== 'Standard Action') {
    changes['system.actionType'] = 'Standard Action';
  }
  if (system?.itemType === 'Armor' && system.uses?.type !== 'infinite' && !(numeric(system.uses?.max) > 0)) {
    const maximum = baseDurability(system);
    Object.assign(changes, { 'system.uses.max': maximum, 'system.uses.current': maximum, 'system.uses.type': 'limited' });
  }
  return Object.keys(changes).length ? changes : null;
}

/** The durability a copy is authored with: its maximum, else the armor class default, else the clothing default. */
export function baseDurability(system) {
  const maximum = numeric(system?.uses?.max);
  if (maximum > 0) return maximum;
  return (system?.itemType === 'Armor' && ARMOR_DURABILITY_DEFAULTS[system?.armor?.req]) || DEFAULT_DURABILITY;
}

/** The forgingXP a tier at this index requires when nothing was authored: one full repair per tier. */
export function seedTierXpRequirement(index, durability) {
  return (index + 1) * (numeric(durability) > 0 ? numeric(durability) : DEFAULT_DURABILITY);
}

/** The tiers a copy can hold, in order: every enabled tier up to the first disabled one. */
export function reachableTiers(crafting) {
  const tiers = crafting?.refinement?.tiers ?? [];
  const reachable = [];
  for (let index = 0; index < Math.min(tiers.length, REFINEMENT_TIER_COUNT); index++) {
    if (tiers[index]?.enabled !== true) break;
    reachable.push({ index, xpReq: Math.max(0, numeric(tiers[index].xpReq)) });
  }
  return reachable;
}

/** The tier a copy's forgingXP tally has reached: the last reachable tier whose requirement the tally meets. */
export function forgingTier(crafting) {
  const tally = Math.max(0, numeric(crafting?.forgingXP));
  let tier = 0;
  for (const entry of reachableTiers(crafting)) {
    if (tally < entry.xpReq) break;
    tier = entry.index + 1;
  }
  return tier;
}

/** Where the forging XP tally stops growing: the top reachable tier's requirement, or null while none is reachable. */
function forgingXpCap(crafting) {
  const reachable = reachableTiers(crafting);
  return reachable.length ? Math.max(...reachable.map(entry => entry.xpReq)) : null;
}

/** The tally after a forge restored this much durability: capped, and never lowered. */
export function forgingXpAfter(crafting, restored) {
  const current = Math.max(0, numeric(crafting?.forgingXP));
  const cap = forgingXpCap(crafting);
  if (cap === null || !crafting?.forging?.enabled) return current;
  return Math.max(current, Math.min(cap, current + Math.max(0, Math.floor(numeric(restored)))));
}

/** What forging costs at the held tier: each tier up to it overrides the multiplier, skill and materials beneath. */
export function forgingTerms(crafting, tier = forgingTier(crafting)) {
  const forging = crafting?.forging ?? {};
  let forgeMult = numeric(forging.forgeMult) > 0 ? numeric(forging.forgeMult) : DEFAULT_FORGE_MULT;
  let skillCheck = forging.skillCheck || DEFAULT_FORGE_SKILL;
  let materials = forging.materials ?? [];
  const tiers = crafting?.refinement?.tiers ?? [];
  for (let index = 0; index < tier; index++) {
    const entry = tiers[index];
    if (!entry) continue;
    if (numeric(entry.forgeMult) > 0) forgeMult = numeric(entry.forgeMult);
    if (entry.skillCheck) skillCheck = entry.skillCheck;
    if (entry.materials?.length) materials = entry.materials;
  }
  return { enabled: forging.enabled === true, forgeMult, skillCheck, materials };
}

/**
 * Bring a carried copy's "(+N)" name and forging XP into agreement, for EmblemItem's create and update checks
 * (foundry/documents/items.mjs). With suffixWins, the XP is first set from the tier the name shows.
 */
export function reconcileRefinement({ name, crafting, suffixWins = false }) {
  const named = refinementTier(name);
  let forgingXP = Math.max(0, numeric(crafting?.forgingXP));
  if (suffixWins) forgingXP = named ? Math.max(0, numeric(crafting?.refinement?.tiers?.[named - 1]?.xpReq)) : 0;
  const tier = forgingTier({ ...crafting, forgingXP });
  return { name: refinementName(name, tier), forgingXP, tier };
}

function refinedValue(base, tier) {
  const value = numeric(base);
  if (value <= 0) return value;
  const price = value * VALUE_MULTIPLIERS[Math.max(0, Math.min(5, tier))];
  const quantum = price >= 2000 ? 100 : 25;
  return Math.min(99999, Math.max(25, Math.round(price / quantum) * quantum));
}

/** Normalize subtype fields for Foundry Item base preparation without mutating the supplied source. */
export function prepareItemBaseData(documentType, source) {
  const prepared = clonePlain(source);
  if (!prepared || ['Class', 'Resource'].includes(documentType)) return prepared;
  if (!WEAPON_FIELDS.has(prepared.itemType) && prepared.weapon) prepared.weapon.req = '';
  if (!ARMOR_FIELDS.has(prepared.itemType) && prepared.armor) prepared.armor.req = '';
  if (prepared.weapon) {
    if (!/^-?\d+(?:d\d+(?:[+-]\d+)?)?$/.test(String(prepared.weapon.atk ?? ''))) prepared.weapon.atk = '0';
    if (!/^\d+(?:-\d+)?$/.test(String(prepared.weapon.rng ?? ''))) prepared.weapon.rng = '1';
    if (!prepared.weapon.atkStat) prepared.weapon.atkStat = prepared.itemType === 'Weapon' ? 'Might'
      : ['Attack', 'Staff'].includes(prepared.itemType) ? 'Wit' : '';
  }
  if (prepared.itemType === 'Armor' && prepared.armor) {
    for (const type of DAMAGE_TYPES) {
      if (prepared.armor.prots?.[type] && prepared.armor.vulns?.[type]) prepared.armor.vulns[type] = false;
    }
  }
  return prepared;
}

function scaleFactor(ownerSystem, scaling) {
  const system = ownerSystem ?? {};
  switch (scaling?.factor) {
    case 'Level': return numeric(system.progression?.level);
    case 'Proficiency': return numeric(system.prof?.[scaling.subject]?.total);
    case 'Stat': {
      const node = system.stats?.[scaling.subject];
      return numeric(node?.base) + numeric(node?.class);
    }
    case 'Skill': return numeric(system.skills?.[scaling.subject]?.total);
    default: return 0;
  }
}

/** Whether an authored scaling rule does anything: it names a factor and a type, and a subject where one is needed. */
export function isScalingActive(scaling) {
  if (!scaling?.factor || scaling.factor === 'None' || !scaling.type) return false;
  return !['Proficiency', 'Stat', 'Skill'].includes(scaling.factor) || Boolean(scaling.subject);
}

/**
 * Apply an authored scaling rule (Additive, Multiple, Threshold or Formula) to `base`, using the owner's level,
 * proficiency, stat or skill. An inactive rule returns `base` unchanged.
 */
export function evaluateScaling(ownerSystem, base, scaling, item = null) {
  if (!isScalingActive(scaling)) return base;
  const factor = scaleFactor(ownerSystem, scaling);
  if (scaling.type === 'Additive') return base + factor;
  if (scaling.type === 'Multiple') {
    const result = factor * numeric(scaling.multiplier);
    return scaling.addToBase ? base + result : result;
  }
  if (scaling.type === 'Threshold') {
    let matched = null;
    for (const row of [...(scaling.thresholds ?? [])].sort((a, b) => numeric(a.at) - numeric(b.at))) {
      if (factor >= numeric(row.at)) matched = numeric(row.uses); else break;
    }
    return matched === null ? base : scaling.addToBase ? base + matched : matched;
  }
  if (scaling.type === 'Formula') {
    const result = evaluateFormula(scaling.formula, ownerSystem, item, factor);
    return result === null ? base : scaling.roundDown ? Math.floor(result) : Math.ceil(result);
  }
  return base;
}

/** Run an authored scaling formula over the owner's and the item's facts, or null when it's blank or fails. */
function evaluateFormula(formula, ownerSystem, item, scaleFactor) {
  const expression = String(formula ?? '').trim();
  if (!expression) return null;
  try {
    const result = SafeEval.evaluate(expression, {
      actor: ownerSystem ? { name: '', system: ownerSystem } : null,
      item,
      system: item?.system ?? null,
      scaleFactor
    });
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Derived item fields for EmblemItem's data preparation and for game/downtime/crafting.mjs: a Weapon Art's valid
 * weapon types, consumables never equipped, potions self-targeted, the refinement tier and broken armor applied, and
 * stored uses capped at the maximum.
 */
export function prepareItemDerivedData({ documentType, system: source }) {
  const system = clonePlain(source);
  if (!system || ['Class', 'Resource'].includes(documentType)) return { system, tier: 0, brokenArmor: false };
  if (system.itemType === 'Weapon Art' && system.wepArtData) {
    system.wepArtData.validTypes = WEAPON_ART_PROFICIENCIES.filter(key => system.wepArtData[key]).map(capitalize);
  }
  if (documentType === 'Consumable' || documentType === 'Miscellaneous') {
    system.isEquipped = false; system.isWorn = false; system.isWielded = false;
  }
  if (system.itemType === 'Potion' && system.effectData) system.effectData.targetType = 'Self';

  const { tier, brokenArmor } = applyRefinementAndBreakage(documentType, system);

  if (system.uses && system.uses.type !== 'conditional') {
    system.uses.current = Math.min(numeric(system.uses.current), numeric(system.uses.max));
  }
  return { system, tier, brokenArmor };
}

/**
 * The corrections an Item write must carry so persisted state stays legal: stored uses never above the most the copy
 * can hold, and no wield, equip or wear state on an Item outside an Actor. EmblemItem._preCreate and _preUpdate in
 * foundry/documents/items.mjs apply the result to the data they are about to write.
 * @param {object} input
 * @param {string} input.documentType Item document type.
 * @param {boolean} input.embedded Whether the Item belongs to an Actor.
 * @param {object} input.system The system data as it will be stored, with the write merged in.
 * @param {object|null} [input.ownerSystem] The owning Actor's prepared system, which conditional uses scale with.
 * @param {string} [input.name] Item name, for scaling formulas.
 * @returns {Record<string, *>|null} Flattened `system.*` changes, or null when nothing needs correcting.
 */
export function settleStoredItemState({ documentType, embedded, system, ownerSystem = null, name = '' }) {
  if (!system || ['Class', 'Resource'].includes(documentType)) return null;
  const changes = {};
  const ceiling = storedUsesCeiling(documentType, system, ownerSystem, name);
  if (ceiling !== null && numeric(system.uses?.current) > ceiling) changes['system.uses.current'] = ceiling;
  if (!embedded) {
    for (const key of ['isWielded', 'isEquipped', 'isWorn']) if (system[key] === true) changes[`system.${key}`] = false;
  }
  return Object.keys(changes).length ? changes : null;
}

/**
 * The most uses a copy may store: its maximum plus the held refinement tier's durability, as prepareItemDerivedData
 * derives it. Conditional uses scale with the owner as EmblemItem.getEffectiveMaxUses does, and without an owner
 * they have no ceiling.
 */
function storedUsesCeiling(documentType, system, ownerSystem, name) {
  const uses = system.uses;
  if (!uses) return null;
  if (uses.type === 'conditional') {
    if (!ownerSystem) return null;
    const base = Math.max(1, numeric(uses.max) || 1);
    return Math.max(0, Math.floor(evaluateScaling(ownerSystem, base, uses.scaling, { name, system: uses })));
  }
  const tier = documentType === 'Equipment' ? forgingTier(system.craftingData) : 0;
  const durability = tier ? system.craftingData.refinement.tiers[tier - 1].modifiers?.durability : null;
  return numeric(uses.max) + (durability === null || durability === undefined ? 0 : numeric(durability));
}

/**
 * Project the weapon, armor and weight an Equipment copy fights with once its refinement tier and armor breakage
 * apply. `projectCharacterSource` builds the Character compiler's input from persisted Item data, so it calls this
 * to give combat the same values `prepareItemDerivedData` shows on the Item sheet.
 * @param {{documentType: string, system: object}} input Item document type and persisted system data.
 * @returns {{weapon?: object, armor?: object, wgt?: number}} Replacement fields, empty when nothing applies.
 */
export function projectEquipmentStats({ documentType, system: source }) {
  if (documentType !== 'Equipment' || !source) return {};
  const system = {
    itemType: source.itemType,
    weapon: clonePlain(source.weapon),
    armor: clonePlain(source.armor),
    wgt: source.wgt,
    cost: source.cost,
    uses: clonePlain(source.uses),
    craftingData: source.craftingData
  };
  const { tier, brokenArmor } = applyRefinementAndBreakage(documentType, system);
  if (!tier && !brokenArmor) return {};
  return { weapon: system.weapon, armor: system.armor, wgt: system.wgt };
}

/**
 * Apply the held refinement tier's modifiers, then halve broken armor, on a detached system the caller owns.
 * Broken armor loses its protections, and every damage type it did not protect against becomes a vulnerability.
 * Shared by `prepareItemDerivedData` and `projectEquipmentStats`. It reads `craftingData` without changing it.
 */
function applyRefinementAndBreakage(documentType, system) {
  const tier = documentType === 'Equipment' ? forgingTier(system.craftingData) : 0;
  const modifiers = tier ? system.craftingData.refinement.tiers[tier - 1].modifiers : null;
  if (modifiers) {
    system.cost = refinedValue(system.cost, tier);
    if (system.itemType === 'Armor' && system.armor) {
      for (const key of ['def', 'res', 'stn']) if (modifiers[key] !== null && modifiers[key] !== undefined) system.armor[key] = numeric(system.armor[key]) + numeric(modifiers[key]);
      if (modifiers.wgtRed !== null && modifiers.wgtRed !== undefined) system.wgt = Math.max(0, numeric(system.wgt) - numeric(modifiers.wgtRed));
      for (const [type, granted] of Object.entries(modifiers.prots ?? {})) if (granted && type in (system.armor.prots ?? {})) {
        system.armor.prots[type] = true; if (system.armor.vulns) system.armor.vulns[type] = false;
      }
    } else if (system.weapon) {
      if (modifiers.atk !== null && modifiers.atk !== undefined) system.weapon.atk = addAttackBonus(system.weapon.atk, modifiers.atk);
      for (const key of ['acc', 'brk', 'crit']) if (modifiers[key] !== null && modifiers[key] !== undefined) system.weapon[key] = numeric(system.weapon[key]) + numeric(modifiers[key]);
      if (modifiers.wgt !== null && modifiers.wgt !== undefined) system.wgt = Math.max(0, numeric(system.wgt) - numeric(modifiers.wgt));
      for (const type of DAMAGE_TYPES) if (modifiers.dmgTypes?.[type] && system.weapon.dmgTypes) system.weapon.dmgTypes[type] = true;
    }
    if (modifiers.durability !== null && modifiers.durability !== undefined && system.uses) system.uses.max = numeric(system.uses.max) + numeric(modifiers.durability);
  }

  const brokenArmor = system.itemType === 'Armor' && system.uses?.type !== 'infinite'
    && numeric(system.uses?.max) > 0 && numeric(system.uses?.current) <= 0;
  if (brokenArmor && system.armor) {
    system.armor.def = Math.ceil(numeric(system.armor.def) / 2);
    system.armor.res = Math.ceil(numeric(system.armor.res) / 2);
    for (const type of DAMAGE_TYPES) {
      const protectedBeforeBreak = system.armor.prots?.[type] === true;
      if (system.armor.prots && type in system.armor.prots) system.armor.prots[type] = false;
      if (system.armor.vulns && type in system.armor.vulns) system.armor.vulns[type] = !protectedBeforeBreak;
    }
  }
  return { tier, brokenArmor };
}

/* -------------------------------------------- */
/*  Private Helpers                             */
/* -------------------------------------------- */

function clonePlain(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}
