/** @layer game/character */
import {
  ALL_UNIT_TYPE_KEYS,
  CLASS_UNIT_TYPE_KEYS,
  COMBAT_FLAG_KEYS,
  GROWTH_KEYS,
  PROFICIENCIES,
  SAVE_KEYS,
  SKILLS,
  SPECIAL_POOLS,
  STATS,
  STATUS_KEYS,
  resolveTarget
} from '../../contracts/domains/characters.mjs';
import {
  CRITICAL_MULTIPLIER_BASE,
  CRITICAL_MULTIPLIER_PER_TQN,
  DIFFICULTY_FLAT_STATS,
  difficultyTier,
  isDifficultyTarget
} from './rules.mjs';
import { resolveMoveScalingDelta } from '../movement/input-policy.mjs';
import {
  PROFICIENCY_RANK_MAX,
  SKILL_RANK_MAX,
  SKILL_RANK_XP
} from '../progression/rules.mjs';
import { chanceNodePaths, evaluate as evaluateConditionTree } from '../effects/conditions.mjs';
import { isInMeleeRange, resolveEngagement } from '../targeting/attack-grid.mjs';
import { WEAPON_PROFICIENCIES } from '../../contracts/domains/items.mjs';
import {
  hasConditionTree,
  isEmpty as conditionIsEmpty,
  validate as validateConditionTree
} from '../../contracts/dsl/conditions.mjs';
import { CHARACTER_INVENTORY_LIMITS } from './inventory.mjs';
import { isStealableItem } from '../economy/trade.mjs';
import { energyCapacity } from '../downtime/rules.mjs';
import { SafeEval } from '../../lib/core/safe-eval.mjs';
import { clamp, finite as number } from '../../lib/core/runtime.mjs';
import { DAMAGE_TYPES } from '../../contracts/domains/damage.mjs';

/* -------------------------------------------- */
/*  Character compilation                       */
/* -------------------------------------------- */
const CLASS_STAT_KEYS = Object.freeze({
  hp: 'hpMax', stn: 'stnMax', mvmt: 'mov', mov: 'mov', bld: 'bld', mgt: 'mgt', agi: 'agi',
  tqn: 'tqn', wit: 'wit', cha: 'cha', def: 'def', res: 'res', spd: 'spd', eva: 'eva', acc: 'acc', crit: 'crit'
});
const MOUNT_STAT_KEYS = Object.freeze({
  mov: 'mov', hp: 'hpMax', stn: 'stnMax', eva: 'eva', spd: 'spd', acc: 'acc', crit: 'crit'
});
const ATTACK_STAT_KEYS = Object.freeze({ Might: 'mgt', Wit: 'wit', Technique: 'tqn' });
const PHYSICAL_WEAPON_FAMILIES = Object.freeze(new Set(['brawling', 'blade', 'polearm', 'heavy', 'bow', 'covert']));
const MAGE_ARMOR_DEFENSE_FLOOR = 5;
/** Lowest active effect change priority at which an effect's protection, vulnerability or immunity change counts. */
const PROTECTION_OVERRIDE_PRIORITY = 99;
const OVERRIDABLE_PROTECTIONS = Object.freeze(['prots', 'vulns', 'imms']);
/** The damage-type flags where an effect's override outranks an item modifier. For immunity, the modifier wins. */
const EFFECT_RANKED_PROTECTIONS = Object.freeze(['prots', 'vulns']);
const SIMPLE_TARGET = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
/** Groups of on/off flags: a modifier switches one of these on or off instead of adding to it. */
const BOOLEAN_FAMILIES = Object.freeze(['combat', 'statuses', 'unitType']);

/**
 * Work out a Character's derived stats, statuses and equipment from its stored data and carried items. Used by
 * actor data preparation (prepareCharacterData) and by previews. Reads and writes no documents.
 * @param {object} source A detached copy of the Character's data, built by projectCharacterSource in
 *   foundry/adapters/projections/characters.mjs.
 * @returns {object}
 */
export function compileCharacterData(source) {
  const system = source.system ?? {};
  const items = source.items ?? [];
  const classItem = items.find(item => item.type === 'Class') ?? null;
  const weapon = items.find(item => item.isWielded && ['Weapon', 'Staff', 'Attack'].includes(item.itemType)) ?? null;
  const armor = items.find(item => item.isWorn && item.itemType === 'Armor') ?? null;
  const shield = items.find(item => item.isEquipped && item.itemType === 'Shield') ?? null;
  const mount = items.find(item => item.isEquipped && item.itemType === 'Mount') ?? null;
  const stanceBroken = source.statuses?.stanceBreak === true;
  const compiled = emptyCompilation(system, { weapon, armor, shield, mount, classItem, stanceBroken, items });

  applyClass(compiled, classItem);
  applyWeapon(compiled, weapon);
  applyWeaponArt(compiled, weapon, source.modifierContext?.activeItem);
  applyArmor(compiled, armor, stanceBroken, source.mageArmor === true);
  applyShield(compiled, shield, stanceBroken);
  applyProtectionOverrides(compiled, source.protectionOverrides);
  applyMount(compiled, mount);
  applyEffectUnitTypes(compiled, source.effectUnitTypes);
  applyEffectCombatFlags(compiled, source.effectCombatFlags);
  finalizeUnitTypes(compiled);
  applyStatuses(compiled, system, source, { mount, stanceBroken });

  applyTerrainModifiers(compiled, source.terrainModifiers);
  applyRallyModifiers(compiled, source.rallyModifiers);
  applyEffectModifiers(compiled, source.effectModifiers);
  const difficulty = isDifficultyTarget(system.faction?.role) ? difficultyTier(source.difficulty) : null;
  applyDifficulty(compiled, difficulty);
  // Unconditional item modifiers read the totals from before any item modifier, conditional ones the totals after the
  // unconditional ones. Difficulty HP and then an effect's max HP override come after them, and current HP and Stn
  // are clamped to the final maximums last.
  const modifiers = collectModifiers(items);
  if (modifiers.unconditional.length) totalizeCharacter(compiled, source);
  applyModifierBucket(compiled, modifiers.unconditional, source);
  totalizeCharacter(compiled, source);
  applyConditionalModifiers(compiled, modifiers.conditional, source);
  totalizeCharacter(compiled, source);
  applyDifficultyHealth(compiled, difficulty);
  applyMaxHpOverride(compiled, source.effectOverrides?.['stats.hpMax.total']);
  clampPools(compiled, system);
  return compiled;
}

/* -------------------------------------------- */
/*  Empty compilation                           */
/* -------------------------------------------- */
function emptyCompilation(system, gear) {
  const { weapon, armor, stanceBroken } = gear;
  return {
    stats: Object.fromEntries(STATS.map(entry => [entry.key, statNode(entry, system.stats?.[entry.key])])),
    growth: Object.fromEntries(GROWTH_KEYS.map(key => [key, numericNode(system.growth?.[key])])),
    caps: Object.fromEntries(GROWTH_KEYS.map(key => [key, numericNode(system.caps?.[key])])),
    skills: Object.fromEntries(SKILLS.map(({ key }) => [key, {
      base: number(system.skills?.[key]?.base), class: 0, passive: 0,
      xp: number(system.skills?.[key]?.xp), total: 0, xpMax: SKILL_RANK_XP[0]
    }])),
    prof: Object.fromEntries(PROFICIENCIES.map(({ key }) => [key, {
      base: number(system.prof?.[key]?.base), class: 0, passive: 0, total: 0,
      xp: number(system.prof?.[key]?.xp),
      maxE: number(system.prof?.[key]?.maxE) || 50,
      maxD: number(system.prof?.[key]?.maxD) || 50,
      maxC: number(system.prof?.[key]?.maxC) || 75,
      maxB: number(system.prof?.[key]?.maxB) || 100,
      maxA: number(system.prof?.[key]?.maxA) || 125,
      maxS: number(system.prof?.[key]?.maxS) || 150,
      xpMax: 50
    }])),
    saves: Object.fromEntries(SAVE_KEYS.map(key => [key, 0])),
    unitType: trueMap(ALL_UNIT_TYPE_KEYS, system.innateUnitType),
    statuses: Object.fromEntries(STATUS_KEYS.map(key => [key, false])),
    combat: Object.fromEntries(COMBAT_FLAG_KEYS.map(key => [key, false])),
    resources: {
      hp: { value: Math.max(0, number(system.resources?.hp?.value)), max: 0 },
      stn: { value: Math.max(0, number(system.resources?.stn?.value)), max: 0 },
      energy: {
        value: Math.max(0, number(system.resources?.energy?.value)),
        mod: number(system.resources?.energy?.mod),
        max: 0
      },
      shields: { value: Math.max(0, number(system.resources?.shields?.value)) }
    },
    special: Object.fromEntries(SPECIAL_POOLS.map(pool => [pool.key, {
      max: Math.max(0, number(system.special?.[pool.key]?.max))
    }])),
    equipment: {
      slots: CHARACTER_INVENTORY_LIMITS.equipment,
      weaponId: weapon?.id ?? '', armorId: armor?.id ?? '', shieldId: gear.shield?.id ?? '',
      mountId: gear.mount?.id ?? '', classId: gear.classItem?.id ?? '',
      atkStat: weapon?.weapon?.atkStat ?? '',
      extraAttacks: number(weapon?.weapon?.extraAttacks),
      noExtraAttacks: weapon?.weapon?.noExtraAttacks === true,
      damageTypes: trueMap(DAMAGE_TYPES, weapon?.weapon?.dmgTypes),
      effectiveAgainst: trueMap(ALL_UNIT_TYPE_KEYS, weapon?.weapon?.effectiveAgainst),
      breaker: trueMap(WEAPON_PROFICIENCIES, weapon?.weapon?.breaker),
      prots: trueMap(DAMAGE_TYPES, stanceBroken ? null : armor?.armor?.prots),
      vulns: trueMap(DAMAGE_TYPES, stanceBroken ? null : armor?.armor?.vulns),
      imms: trueMap(DAMAGE_TYPES, null)
    },
    facts: carryFacts(gear.items ?? []),
    modifierDiagnostics: []
  };
}

/**
 * Count the physical weapon families the unit carries and whether it holds anything stealable, for item modifier
 * conditions. Only the unit's own Equipment Weapons count: armor and shields carry a `weapon.req` too, innate
 * weapons such as Unarmed Attack are skipped, and an Armament the unit is operating is not one of its items.
 */
function carryFacts(items) {
  const families = new Set();
  for (const item of items) {
    if (item.innateGrant === true || item.type !== 'Equipment' || item.itemType !== 'Weapon') continue;
    const family = String(item.weapon?.req ?? '').trim().toLowerCase();
    if (PHYSICAL_WEAPON_FAMILIES.has(family)) families.add(family);
  }
  return {
    physicalWeaponTypesCarried: families.size,
    hasStealables: items.some(item => isStealableItem({
      type: item.type,
      innate: item.innateGrant === true,
      stealableFlag: item.stealableFlag ?? '',
      stealableDc: item.stealableDc ?? 0
    }))
  };
}

function statNode(entry, source = {}) {
  if (entry.kind === 'formula') return formulaNode(source, entry.key === 'rng' ? '1' : '0');
  if (entry.kind === 'ratio') return multiplierNode(source);
  return numericNode(source);
}

/* -------------------------------------------- */
/*  Gear and class                              */
/* -------------------------------------------- */
function applyClass(compiled, classItem) {
  if (!classItem) return;
  const classData = classItem.classData ?? {};
  const classStats = classData.baseStats ?? {};
  for (const [sourceKey, targetKey] of Object.entries(CLASS_STAT_KEYS)) {
    if (classStats[sourceKey] === undefined) continue;
    compiled.stats[targetKey].class = number(classStats[sourceKey]);
  }
  const playable = classData.tier !== 'Unplayable';
  for (const key of GROWTH_KEYS) {
    compiled.growth[key].class = playable ? number(classData.baseGrowths?.[key]) : 0;
    compiled.caps[key].class = playable ? number(classData.baseCaps?.[key]) : 0;
  }
  for (const { key } of SKILLS) compiled.skills[key].class = number(classData.skills?.[key]);
  for (const { key } of PROFICIENCIES) {
    if (key === 'riding') {
      compiled.prof[key].class = classData.proficiencies?.flying ? 2 : classData.proficiencies?.riding ? 1 : 0;
    } else {
      compiled.prof[key].class = number(classData.proficiencies?.[key]);
    }
  }
  for (const key of CLASS_UNIT_TYPE_KEYS) {
    if (classData.unitType?.[key]) compiled.unitType[key] = true;
  }
}

function applyWeapon(compiled, weapon) {
  if (!weapon) return;
  if (weapon.type === 'Spell') compiled.unitType.magic = true;
  compiled.stats.atk.item = String(weapon.weapon?.atk ?? '0');
  compiled.stats.rng.item = String(weapon.weapon?.rng ?? '1');
  compiled.stats.acc.item += number(weapon.weapon?.acc);
  compiled.stats.brk.item += number(weapon.weapon?.brk);
  compiled.stats.crit.item += number(weapon.weapon?.crit);
  compiled.stats.wgt.item += number(weapon.wgt);
}

function applyArmor(compiled, armor, stanceBroken, mageArmor = false) {
  if (!armor) return;
  compiled.stats.stnMax.item += number(armor.armor?.stn);
  if (!stanceBroken) {
    const defense = number(armor.armor?.def);
    compiled.stats.def.item += mageArmor ? Math.max(MAGE_ARMOR_DEFENSE_FLOOR, defense) : defense;
    compiled.stats.res.item += number(armor.armor?.res);
    compiled.stats.eva.item += number(armor.armor?.eva);
    compiled.stats.wgt.item += number(armor.wgt);
    compiled.stats.critRed.item += number(armor.armor?.critRed);
    compiled.stats.brkRed.item += number(armor.armor?.brkRed);
  }
  if (armor.armor?.req === 'Heavy') compiled.unitType.armored = true;
}

/**
 * Merge the active Weapon Art into the wielded weapon's traits. An Art only ever adds: its effectiveness and breaker
 * flags join the weapon's and are never switched off. Extra attacks are the exception, because either the weapon or
 * the Art disabling them turns them off for both. combineWeaponArtTraits in game/combat/exchange.mjs does the same
 * merge for combat.
 */
function applyWeaponArt(compiled, weapon, activeItem) {
  const art = activeItem?.system?.itemType === 'Weapon Art' ? activeItem.system.weapon : null;
  if (!weapon || !art) return;
  const equipment = compiled.equipment;
  for (const key of ALL_UNIT_TYPE_KEYS) {
    if (art.effectiveAgainst?.[key] === true) equipment.effectiveAgainst[key] = true;
  }
  for (const key of WEAPON_PROFICIENCIES) {
    if (art.breaker?.[key] === true) equipment.breaker[key] = true;
  }
  const extrasDisabled = weapon.weapon?.noExtraAttacks === true || art.noExtraAttacks === true;
  equipment.extraAttacks = extrasDisabled ? 0 : number(weapon.weapon?.extraAttacks) + number(art.extraAttacks);
  equipment.noExtraAttacks = extrasDisabled;
}

/**
 * Apply the protection, vulnerability and immunity overrides that effects set, over what worn armor grants. Armor
 * grants no immunities, so they come only from these overrides and from item modifiers (applyAtSchemaPath).
 * compileCharacterData runs it after the equipment pass. applyModifier runs it again for protections and
 * vulnerabilities after a modifier sets one, so the effect's override outranks the modifier. Only effect changes at
 * priority 99 or higher count; lower ones are ignored.
 * @param {object} compiled Character under compilation.
 * @param {object[]} [overrides] The effect changes projectCharacterSource collects as `protectionOverrides`.
 * @param {ReadonlyArray<string>} [groups] Which of `prots`, `vulns` and `imms` to apply.
 */
function applyProtectionOverrides(compiled, overrides, groups = OVERRIDABLE_PROTECTIONS) {
  for (const override of overrides ?? []) {
    if (number(override.priority) < PROTECTION_OVERRIDE_PRIORITY) continue;
    if (!groups.includes(override.group)) continue;
    const table = compiled.equipment[override.group];
    if (!table || !(override.type in table)) continue;
    table[override.type] = truthy(override.value);
  }
}

/**
 * A shield's Stn raises the unit's max even while its stance is broken, as armor's does. Its Def, Res and weight
 * count only while the stance holds. planEquipmentToggleConsequences adds the Stn it grants when it's equipped and
 * takes it back when it comes off.
 */
function applyShield(compiled, shield, stanceBroken) {
  if (!shield) return;
  compiled.stats.stnMax.item += number(shield.armor?.stn);
  if (stanceBroken) return;
  compiled.stats.def.item += number(shield.armor?.def);
  compiled.stats.res.item += number(shield.armor?.res);
  compiled.stats.wgt.item += number(shield.wgt);
}

function applyMount(compiled, mount) {
  if (!mount) return;
  const stats = mount.mountData?.stats ?? {};
  for (const [sourceKey, targetKey] of Object.entries(MOUNT_STAT_KEYS)) {
    compiled.stats[targetKey].item += number(stats[sourceKey]);
  }
  compiled.stats.atk.mod += number(stats.atk);
  for (const [key, active] of Object.entries(mount.mountData?.unitTypes ?? {})) {
    if (active && key in compiled.unitType) compiled.unitType[key] = true;
  }
}

function applyEffectUnitTypes(compiled, granted) {
  for (const [key, active] of Object.entries(granted ?? {})) {
    if (active === true && key in compiled.unitType) compiled.unitType[key] = true;
  }
}

/** Levitation makes a unit a flier, and an armored, cavalry or flying unit is no longer infantry. */
function finalizeUnitTypes(compiled) {
  if (compiled.combat.levitation === true) compiled.unitType.flying = true;
  if (compiled.unitType.armored || compiled.unitType.cavalry || compiled.unitType.flying) {
    compiled.unitType.infantry = false;
  }
}

/* -------------------------------------------- */
/*  Statuses                                    */
/* -------------------------------------------- */

/** Raise the combat flags an effect grants. These flags overwrite whatever active effects wrote to the actor. */
function applyEffectCombatFlags(compiled, flags) {
  for (const [key, raised] of Object.entries(flags ?? {})) {
    if (raised === true && key in compiled.combat) compiled.combat[key] = true;
  }
}

function applyStatuses(compiled, system, source, context) {
  for (const [key, raised] of Object.entries(source.effectStatuses ?? {})) {
    if (raised === true && key in compiled.statuses) compiled.statuses[key] = true;
  }
  compiled.statuses.grounded = system.statuses?.grounded === true;
  compiled.statuses.mounted = Boolean(context.mount);
  compiled.statuses.stanceBroken = context.stanceBroken === true;
  compiled.statuses.airborne = isAirborne(compiled);
}

/**
 * The airborne rule: a levitating unit is always aloft, and any other flier is aloft until it lands. Everything that
 * asks whether a Character is in the air reads the result as `system.statuses.airborne`.
 */
function isAirborne(compiled) {
  return compiled.combat.levitation === true
    || (compiled.unitType.flying === true && compiled.statuses.grounded !== true);
}

/* -------------------------------------------- */
/*  Detached modifier sources                   */
/* -------------------------------------------- */
function applyTerrainModifiers(compiled, terrain) {
  compiled.stats.eva.mod += number(terrain?.eva);
  compiled.stats.def.mod += number(terrain?.def);
  compiled.stats.res.mod += number(terrain?.res);
}

function applyRallyModifiers(compiled, rally) {
  for (const [key, value] of Object.entries(rally ?? {})) {
    const node = compiled.stats[key];
    if (node) node.mod += number(value);
  }
}

function applyEffectModifiers(compiled, modifiers) {
  for (const modifier of modifiers ?? []) {
    applyAtSchemaPath(compiled, String(modifier.target ?? '').replace(/^system\./, ''), number(modifier.value));
  }
}

/* -------------------------------------------- */
/*  World difficulty                            */
/* -------------------------------------------- */
function applyDifficulty(compiled, tier) {
  if (!tier) return;
  for (const key of DIFFICULTY_FLAT_STATS) compiled.stats[key].mod += number(tier[key]);
}

/** Apply difficulty HP after totalizeCharacter so its percentage uses the final maximum. */
function applyDifficultyHealth(compiled, tier) {
  const bonus = tier ? Math.floor(compiled.stats.hpMax.total * number(tier.hpPercent)) : 0;
  if (bonus <= 0) return;
  compiled.stats.hpMax.mod += bonus;
  compiled.stats.hpMax.total += bonus;
  compiled.resources.hp.max = compiled.stats.hpMax.total;
}

function applyEffectLeafOverrides(compiled, overrides) {
  for (const [path, value] of Object.entries(overrides ?? {})) {
    if (!Number.isFinite(value)) continue;
    const parts = path.split('.');
    if (parts.length === 2 && parts[0] === 'saves' && typeof compiled.saves[parts[1]] === 'number') {
      compiled.saves[parts[1]] = value;
    } else if (parts.length === 3 && parts[0] === 'stats' && parts[2] !== 'total') {
      const node = compiled.stats[parts[1]];
      if (node && typeof node[parts[2]] === 'number') node[parts[2]] = value;
    }
  }
}

/** Set an effect's override of max HP again after difficulty HP, so the override is the final maximum. */
function applyMaxHpOverride(compiled, override) {
  if (!Number.isFinite(override)) return;
  compiled.stats.hpMax.total = override;
  compiled.resources.hp.max = Math.max(0, override);
}

/* -------------------------------------------- */
/*  Character totalization                      */
/* -------------------------------------------- */
function totalizeCharacter(compiled, source = {}) {
  const stats = compiled.stats;
  applyEffectLeafOverrides(compiled, source.effectOverrides);
  // An effect that overrides a stat total (source.effectOverrides) replaces it as soon as it is worked out, so the
  // stats built from it afterwards use the overridden value.
  const total = (key, computed) => {
    const override = source.effectOverrides?.[`stats.${key}.total`];
    stats[key].total = Number.isFinite(override) ? override : computed;
    return stats[key].total;
  };
  for (const key of ['mgt', 'tqn', 'wit', 'cha', 'def', 'res', 'stnMax', 'stnRegen', 'sight', 'expMultiplier']) {
    total(key, totalNumeric(stats[key]));
  }
  // Clamp movement at 0 before pathfinding reads it, because terrain and Rally penalties can exceed base movement.
  const movement = Math.max(0, totalNumeric(stats.mov));
  total('mov', movement + resolveMoveScalingDelta(source.moveScaling, {
    total: movement, mounted: compiled.statuses.mounted === true
  }));
  total('bld', totalNumeric(stats.bld) + Math.floor(stats.mgt.total / 4));
  total('hpMax', totalNumeric(stats.hpMax) + stats.mgt.total);

  total('wgtRed', totalNumeric(stats.wgtRed));
  total('wgt', Math.max(0, totalNumeric(stats.wgt) - stats.wgtRed.total));
  const encumbrance = Math.max(0, stats.wgt.total - stats.bld.total);
  total('agi', totalNumeric(stats.agi) - encumbrance);

  total('spd', totalNumeric(stats.spd) + stats.agi.total);
  total('eva', totalNumeric(stats.eva) + evasionFromAgility(stats.agi.total, compiled.statuses));
  total('acc', totalNumeric(stats.acc) + stats.tqn.total);
  total('crit', totalNumeric(stats.crit) + stats.wit.total);
  total('critDmg', totalNumeric(stats.critDmg) + (Math.floor(stats.tqn.total) * CRITICAL_MULTIPLIER_PER_TQN));
  total('brk', totalNumeric(stats.brk));
  total('critRed', totalNumeric(stats.critRed));
  total('brkRed', totalNumeric(stats.brkRed));

  stats.atk.total = stats.atk.override.trim()
    || addFormula(stats.atk.item, formulaStatContribution(compiled, 'atk', source));
  stats.rng.total = stats.rng.override.trim() || addRange(stats.rng.item, formulaStatContribution(compiled, 'rng'));

  for (const key of GROWTH_KEYS) {
    totalNumeric(compiled.growth[key]);
    totalNumeric(compiled.caps[key]);
  }
  for (const { key } of SKILLS) {
    const skill = compiled.skills[key];
    skill.total = clamp(Math.floor(skill.base + skill.class + skill.passive), 0, SKILL_RANK_MAX);
    skill.xpMax = skill.total >= SKILL_RANK_MAX ? 0 : SKILL_RANK_XP[skill.total];
  }
  for (const { key, misc } of PROFICIENCIES) {
    const proficiency = compiled.prof[key];
    proficiency.total = clamp(Math.floor(proficiency.base + proficiency.class + proficiency.passive),
      0, PROFICIENCY_RANK_MAX);
    const thresholdKeys = ['maxE', 'maxD', 'maxC', 'maxB', 'maxA', 'maxS'];
    proficiency.xpMax = misc || proficiency.total >= PROFICIENCY_RANK_MAX ? 0 : proficiency[thresholdKeys[proficiency.total]];
  }

  compiled.resources.hp.max = Math.max(0, stats.hpMax.total);
  compiled.resources.stn.max = Math.max(0, stats.stnMax.total);
  clampPools(compiled, source.system ?? {});
  compiled.resources.energy.max = energyCapacity(compiled.resources.energy.mod);
  compiled.resources.energy.value = Math.min(compiled.resources.energy.value, compiled.resources.energy.max);
}

/** Clamp current HP and Stn from the stored values, so a later pass can raise them again when the max grows. */
function clampPools(compiled, system) {
  const { hp, stn } = compiled.resources;
  hp.value = Math.min(Math.max(0, number(system.resources?.hp?.value)), hp.max);
  stn.value = Math.min(Math.max(0, number(system.resources?.stn?.value)), stn.max);
}

/**
 * The number totalizeCharacter adds to an attack or range formula: the stat's own parts, plus the attack stat for
 * `atk`. An override skips it. Also used by statModifierDeltas (game/character/modifier-deltas.mjs).
 * @param {object} compiled A compiled result, or one mid-totalization.
 * @param {'atk'|'rng'} key The formula stat.
 * @param {object} [source] The compile source, for the combat distance a Hybrid weapon resolves against.
 * @returns {number}
 */
export function formulaStatContribution(compiled, key, source = {}) {
  const node = compiled.stats[key];
  if (!node || String(node.override ?? '').trim()) return 0;
  const own = number(node.base) + number(node.class) + number(node.mod)
    + number(node.penalty) + number(node.aura) + number(node.passive);
  if (key !== 'atk') return own;
  const atkStat = resolveAttackStat(compiled.equipment.atkStat, source.modifierContext?.combatDistance);
  return own + (atkStat ? number(compiled.stats[atkStat]?.total) : 0);
}

/** Unbalanced loses the Agility half of Evasion. Restrained loses it when it's positive, but a negative one applies. */
function evasionFromAgility(agility, statuses) {
  const half = statuses.unbalanced === true ? 0 : Math.floor(agility / 2);
  if (half >= 0) return statuses.restrained === true ? 0 : half;
  return half;
}

/**
 * Choose the scaling stat for character compilation. Hybrid uses Wit at range and Might in melee or without a
 * target.
 * @param {string} atkStat Authored name: Might, Wit, Technique, Hybrid or empty.
 * @param {number} [distance] Squares to the current foe, 0 when there is none.
 * @returns {'mgt'|'wit'|'tqn'|null}
 */
function resolveAttackStat(atkStat, distance = 0) {
  if (atkStat === 'Hybrid') return number(distance) > 1 ? 'wit' : 'mgt';
  return ATTACK_STAT_KEYS[atkStat] ?? null;
}

/* -------------------------------------------- */
/*  Compilation helpers                         */
/* -------------------------------------------- */

function numericNode(source = {}) {
  return {
    base: number(source.base), class: 0, mod: number(source.mod), penalty: number(source.penalty),
    aura: number(source.aura), item: 0, passive: 0, total: 0
  };
}

function multiplierNode(source = {}) {
  const node = numericNode(source);
  // A partial source without a base gets the Character schema's default crit multiplier.
  if (source.base === undefined || source.base === null) node.base = CRITICAL_MULTIPLIER_BASE;
  return node;
}

function formulaNode(source = {}, fallback = '0') {
  return { ...numericNode(source), item: fallback, override: '', total: fallback };
}

function trueMap(keys, source = {}) {
  return Object.fromEntries(keys.map(key => [key, source?.[key] === true]));
}

function totalNumeric(node) {
  node.total = number(node.base) + number(node.class) + number(node.item)
    + number(node.passive) + number(node.mod) + number(node.penalty) + number(node.aura);
  return node.total;
}

function addFormula(base, delta) {
  const text = String(base ?? '0').trim() || '0';
  if (!delta) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return String(number(text) + delta);
  return delta > 0 ? `${text}+${delta}` : `${text}${delta}`;
}

function addRange(base, delta) {
  const text = String(base ?? '1').trim() || '1';
  if (!delta) return text;
  if (/^\d+$/.test(text)) return String(Math.max(0, number(text) + delta));
  if (/^\d+-\d+$/.test(text)) {
    const [near, far] = text.split('-').map(number);
    return `${near}-${far + delta}`;
  }
  return delta > 0 ? `(${text})+${delta}` : `(${text})${delta}`;
}

/* -------------------------------------------- */
/*  Item modifier collection                    */
/* -------------------------------------------- */
/**
 * Split item modifiers into unconditional and gated groups. Aura modifiers are left to game/effects/auras.mjs, and
 * a modifier that needs its item equipped is left out while the item is not.
 * @param {object[]} items The items from the compile source.
 * @returns {{unconditional: object[], conditional: object[]}}
 */
function collectModifiers(items) {
  const unconditional = [];
  const conditional = [];
  for (const item of items) {
    for (const [index, modifier] of (item.modifiers ?? []).entries()) {
      if (!modifier || modifier.kind === 'aura') continue;
      if (modifier.requiresEquipped && !isEquipped(item)) continue;
      const conditionTree = hasConditionTree(modifier.conditionTree) ? modifier.conditionTree : null;
      const requiresActivation = modifier.requiresActivation === true;
      const entry = { ...modifier, conditionTree, requiresActivation, modifierIndex: index, sourceItem: item };
      if (conditionTree || requiresActivation) conditional.push(entry);
      else unconditional.push(entry);
    }
  }
  return { unconditional, conditional };
}

function isEquipped(item) {
  return item.isWielded || item.isWorn || item.isEquipped;
}

/* -------------------------------------------- */
/*  Modifier application                        */
/* -------------------------------------------- */
/** Apply the unconditional item modifiers, then recompute any unit types they changed. */
function applyModifierBucket(compiled, modifiers, source) {
  for (const modifier of modifiers) applyModifier(compiled, modifier, source);
  settleModifiedUnitTypes(compiled);
}

/** Apply the conditional item modifiers whose conditions hold. Conditions see the unit types left by the others. */
function applyConditionalModifiers(compiled, modifiers, source) {
  for (const modifier of modifiers) {
    if (modifier.requiresActivation && source.modifierContext?.activeItemId !== modifier.sourceItem.id) continue;
    const hasTree = hasConditionTree(modifier.conditionTree);
    if (hasTree) {
      const validation = validateConditionTree(modifier.conditionTree);
      if (!validation.valid) {
        recordModifierDiagnostic(compiled, modifier, 'invalid-condition');
        continue;
      }
      // Nothing rolls a chance for a modifier: chance belongs to effect entries and if steps. A modifier whose
      // condition has one never applies.
      if (chanceNodePaths(modifier.conditionTree).length) {
        recordModifierDiagnostic(compiled, modifier, 'chance-condition');
        continue;
      }
    }
    let context = null;
    if (hasTree && !conditionIsEmpty(modifier.conditionTree)) {
      try {
        context = modifierEvaluationContext(compiled, modifier, source);
        if (!evaluateConditionTree(modifier.conditionTree, context)) continue;
      } catch {
        recordModifierDiagnostic(compiled, modifier, 'condition-evaluation-failed');
        continue;
      }
    }
    applyModifier(compiled, modifier, source, context);
  }
  settleModifiedUnitTypes(compiled);
}

/**
 * Recompute flying, infantry and airborne after item modifiers change unit types, since finalizeUnitTypes and
 * applyStatuses ran before any modifier. Levitation grants flight, an armored, cavalry or flying unit is no longer
 * infantry, and `airborne` follows the flight and levitation the modifiers left.
 * @param {object} compiled Character under compilation.
 */
function settleModifiedUnitTypes(compiled) {
  finalizeUnitTypes(compiled);
  compiled.statuses.airborne = isAirborne(compiled);
}

function applyModifier(compiled, modifier, source, evaluated = null) {
  const name = String(modifier.target ?? '').trim();
  if (!name || modifier.quantity === undefined) return;
  let quantity;
  try {
    quantity = resolveModifierQuantity(
      modifier.quantity,
      () => evaluated ?? modifierEvaluationContext(compiled, modifier, source)
    );
  } catch {
    recordModifierDiagnostic(compiled, modifier, 'expression-evaluation-failed');
    return;
  }
  let path;
  try {
    path = resolveModifierTarget(name, () => evaluated ?? modifierEvaluationContext(compiled, modifier, source));
  } catch {
    recordModifierDiagnostic(compiled, modifier, 'expression-evaluation-failed');
    return;
  }
  if (!path) {
    recordModifierDiagnostic(compiled, modifier, 'unknown-target', { target: name });
    return;
  }
  if (!applyAtSchemaPath(compiled, path, quantity)) {
    recordModifierDiagnostic(compiled, modifier, 'target-unavailable', { target: name });
    return;
  }
  // An effect's override of a protection or vulnerability outranks the modifier that just set one. It is applied
  // again at once, so a later modifier's condition already reads the flag the effect decides.
  const [root, group] = path.split('.');
  if (root === 'equipment' && EFFECT_RANKED_PROTECTIONS.includes(group)) {
    applyProtectionOverrides(compiled, source.protectionOverrides, [group]);
  }
}

/**
 * Apply a resolved modifier at a compiled system path. Called by applyModifier for both item modifier buckets, and
 * by applyEffectModifiers. Returns false when the path can't take the value.
 * @param {object} compiled Character under compilation.
 * @param {string} path Schema path such as `stats.mgt.passive`, `combat.canter` or `unitType.cavalry`.
 * @param {number|string|boolean} value Value to add or set.
 * @returns {boolean}
 */
function applyAtSchemaPath(compiled, path, value) {
  const parts = String(path ?? '').split('.');
  if (parts.length === 2 && BOOLEAN_FAMILIES.includes(parts[0])) {
    const family = compiled[parts[0]];
    if (!Object.hasOwn(family, parts[1])) return false;
    family[parts[1]] = truthy(value);
    return true;
  }
  // A special-pool max is a minimum: granting one Extra Life doesn't lower an existing three.
  if (parts.length === 3 && parts[0] === 'special' && parts[2] === 'max') {
    const pool = compiled.special[parts[1]];
    if (!pool || typeof value === 'string') return false;
    pool.max = Math.max(pool.max, number(value));
    return true;
  }
  // Under the derived `equipment` node only the slot count and the damage-type flags below can be written. A passive
  // such as Armed to the Teeth adds to the capacity characterEquipmentCapacity reads, and can subtract, but not
  // below 0.
  if (parts.length === 2 && parts[0] === 'equipment' && parts[1] === 'slots') {
    if (typeof value === 'string') return false;
    compiled.equipment.slots = Math.max(0, compiled.equipment.slots + number(value));
    return true;
  }
  // Item modifiers set a damage-type protection, vulnerability or immunity on or off here, over what worn armor
  // grants. This runs after applyProtectionOverrides, so an immunity modifier outranks an effect's override. For a
  // protection or vulnerability, applyModifier applies the effect's override again, so the effect outranks it.
  if (parts.length === 3 && parts[0] === 'equipment' && OVERRIDABLE_PROTECTIONS.includes(parts[1])) {
    const table = compiled.equipment[parts[1]];
    if (!(parts[2] in table)) return false;
    table[parts[2]] = truthy(value);
    return true;
  }
  if (parts.length === 2 && parts[0] === 'saves') {
    if (!(parts[1] in compiled.saves) || typeof value === 'string') return false;
    compiled.saves[parts[1]] += number(value);
    return true;
  }
  if (parts.length === 3 && ['stats', 'growth', 'caps', 'skills', 'prof'].includes(parts[0])) {
    return applyNodeLeaf(compiled[parts[0]][parts[1]], parts[2], value);
  }
  return false;
}

function applyNodeLeaf(node, leaf, value) {
  if (!node || !Object.hasOwn(node, leaf)) return false;
  if (typeof value === 'string') {
    if (typeof node[leaf] !== 'string') return false;
    node[leaf] = value;
    return true;
  }
  if (typeof node[leaf] !== 'number') return false;
  node[leaf] += number(value);
  return true;
}

function truthy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  return text !== '' && text !== 'false' && text !== '0';
}

function recordModifierDiagnostic(compiled, modifier, code, extra = {}) {
  compiled.modifierDiagnostics.push({
    code,
    itemId: modifier.sourceItem.id ?? null,
    modifierIndex: modifier.modifierIndex ?? null,
    ...extra
  });
}

/** A plain name is looked up with resolveTarget. Anything else is an expression that yields the name. */
function resolveModifierTarget(name, evaluationContext) {
  if (SIMPLE_TARGET.test(name)) return resolveTarget(name);
  const evaluated = SafeEval.evaluate(name, evaluationContext());
  return typeof evaluated === 'string' ? resolveTarget(evaluated) : null;
}

/** A modifier's value: a number, boolean or quoted string. The unit's values are built only for an expression. */
function resolveModifierQuantity(rawQuantity, evaluationContext) {
  if (typeof rawQuantity === 'number') return Number.isFinite(rawQuantity) ? rawQuantity : 0;
  if (typeof rawQuantity === 'boolean') return rawQuantity;
  const quantity = String(rawQuantity ?? '').trim();
  if (!quantity) return 0;
  if (quantity.length >= 2) {
    const first = quantity[0];
    const last = quantity.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return quantity.slice(1, -1);
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(quantity)) return Number(quantity);
  if (quantity === 'true' || quantity === 'false') return quantity === 'true';
  const evaluated = SafeEval.evaluate(quantity, evaluationContext());
  if (typeof evaluated === 'string' || typeof evaluated === 'boolean') return evaluated;
  const numberValue = Number(evaluated);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

/* -------------------------------------------- */
/*  Condition context                           */
/* -------------------------------------------- */

/**
 * Build the flat record of a unit's values (level, HP, stats, gear, turn state) that authored conditions and
 * expressions read (game/effects/conditions.mjs), from compiled or prepared Character data.
 * @param {object} unit A unit-shaped system: the compiled result during preparation, the live system elsewhere.
 * @param {object} [extras] Values that live outside the system, such as the name, token size and gear items.
 * @returns {object}
 */
export function buildUnitFacts(unit, extras = {}) {
  const system = unit && typeof unit === 'object' ? unit : {};
  const turn = system.turn ?? {};
  const gear = extras.gear ?? {};
  const facts = {
    name: String(extras.name ?? ''),
    uuid: String(extras.uuid ?? ''),
    statuses: Array.isArray(extras.statuses) ? [...extras.statuses] : [],
    faction: system.faction?.role ?? 'Neutral',
    size: number(extras.size) || 1,
    level: number(system.progression?.level),
    exp: number(system.progression?.experience),
    hp: number(system.resources?.hp?.value),
    maxHp: number(system.resources?.hp?.max),
    stn: number(system.resources?.stn?.value),
    maxStn: number(system.resources?.stn?.max),
    shields: number(system.resources?.shields?.value),
    stats: system.stats ?? {},
    skills: mapTotals(system.skills),
    prof: mapTotals(system.prof),
    growth: mapTotals(system.growth),
    caps: mapTotals(system.caps),
    saves: { ...(system.saves ?? {}) },
    combat: { ...(system.combat ?? {}) },
    prots: { ...(system.equipment?.prots ?? {}) },
    vulns: { ...(system.equipment?.vulns ?? {}) },
    imms: { ...(system.equipment?.imms ?? {}) },
    weapon: gearFacts(gear.weapon, 'weapon'),
    armor: gearFacts(gear.armor, 'armor'),
    shield: gearFacts(gear.shield, 'shield'),
    mount: gearFacts(gear.mount, 'mount'),
    class: gearFacts(gear.class, 'class'),
    equipmentSlots: number(system.equipment?.slots),
    physicalWeaponTypesCarried: number(system.facts?.physicalWeaponTypesCarried),
    hasStealables: system.facts?.hasStealables === true,
    attackIndex: number(turn.attackIndex),
    movementSpent: number(turn.movementSpent),
    hasAction: turn.actionAvailable !== false,
    hasBonusAction: turn.bonusActionAvailable !== false,
    hasMovement: turn.movementAvailable !== false,
    hasMoved: number(turn.movementSpent) > 0,
    usedExtraAction: turn.extraActionUsed === true
  };
  for (const entry of STATS) facts[entry.key] = system.stats?.[entry.key]?.total ?? 0;
  for (const key of ALL_UNIT_TYPE_KEYS) facts[key] = system.unitType?.[key] === true;
  for (const key of STATUS_KEYS) facts[key] = system.statuses?.[key] === true;
  for (const pool of SPECIAL_POOLS) {
    facts[pool.key] = number(system.special?.[pool.key]?.value);
    facts[pool.max] = number(system.special?.[pool.key]?.max);
  }
  return facts;
}

/**
 * Add `inMeleeRange` to a unit's buildUnitFacts record, so conditions on either side of a fight can read it.
 * @param {object|null} facts A unit's record, or null when there is no such unit.
 * @param {boolean} inMeleeRange Whether the two units stand within reach of each other.
 * @returns {object|null}
 */
export function withMeleeReach(facts, inMeleeRange) {
  return facts ? Object.freeze({ ...facts, inMeleeRange: inMeleeRange === true }) : null;
}

function mapTotals(family) {
  return Object.fromEntries(Object.entries(family ?? {}).map(([key, node]) => [key, number(node?.total)]));
}

/**
 * Summarise one gear slot for authored conditions, nested under buildUnitFacts (for example `weapon.type`).
 * @param {object|null} item An item from the compile source, or `{name, system}` from combat, or null.
 * @param {'weapon'|'armor'|'shield'|'mount'|'class'} slot The gear slot the item fills.
 * @returns {object|null}
 */
function gearFacts(item, slot) {
  if (!item) return null;
  const system = item.system ?? item;
  const tier = system.tier ?? item.classData?.tier ?? '';
  return {
    name: String(item.name ?? ''),
    type: gearType(system, slot, tier),
    itemType: system.itemType ?? item.itemType ?? '',
    tier,
    twoHanded: system.weapon?.twoHanded === true,
    wgt: number(system.wgt ?? item.wgt)
  };
}

/**
 * The `type` gearFacts reports for one slot: a weapon's family on `weapon.req`, an armor or shield weight class on
 * `armor.req`, a Class's tier. Armor and shields carry a `weapon.req` of their own, and the compile source gives a
 * Class one too, so the slot decides which field is read.
 */
function gearType(system, slot, tier) {
  if (slot === 'armor' || slot === 'shield') return system.armor?.req ?? '';
  if (slot === 'class') return tier;
  return system.weapon?.req ?? system.armor?.req ?? system.tier ?? '';
}

function modifierEvaluationContext(compiled, modifier, source) {
  const state = source.modifierContext ?? {};
  const inMeleeRange = state.combatInMeleeRange ?? isInMeleeRange({ distance: state.combatDistance });
  const self = withMeleeReach(buildUnitFacts({ ...(source.system ?? {}), ...compiled }, {
    name: source.name, uuid: source.uuid, size: state.size, gear: gearFor(source), statuses: source.statusKeys
  }), inMeleeRange);
  return {
    self,
    ...self,
    item: modifier.sourceItem ?? null,
    activeItem: state.activeItem ?? null,
    target: withMeleeReach(state.target ?? null, inMeleeRange),
    caster: self,
    distance: number(state.combatDistance),
    engagement: String(state.combatEngagement ?? '') || resolveEngagement({ distance: state.combatDistance }),
    attacking: state.isAttacking === true,
    defending: state.isDefending === true,
    usingWeaponArt: state.isUsingWeaponArt === true
  };
}

const GEAR_BY_ITEM_LIST = new WeakMap();

/**
 * The worn, wielded and ridden gear of one item list, which no modifier can change mid-preparation. It is cached
 * per item array, so an array must not be changed after it has been compiled; a what-if compile passes a new array.
 */
function gearFor(source) {
  const items = source.items ?? [];
  const cached = GEAR_BY_ITEM_LIST.get(items);
  if (cached) return cached;
  const find = predicate => items.find(predicate) ?? null;
  const gear = {
    weapon: find(item => item.isWielded && ['Weapon', 'Staff', 'Attack'].includes(item.itemType)),
    armor: find(item => item.isWorn && item.itemType === 'Armor'),
    shield: find(item => item.isEquipped && item.itemType === 'Shield'),
    mount: find(item => item.isEquipped && item.itemType === 'Mount'),
    class: find(item => item.type === 'Class')
  };
  GEAR_BY_ITEM_LIST.set(items, gear);
  return gear;
}
