/** @layer game/character */
import {
  FACTION_GROUPS,
  GROWTH_KEYS,
  PROFICIENCIES as VOCAB_PROFICIENCIES,
  SKILLS as VOCAB_SKILLS,
  STATS,
  UNIT_TYPES as VOCAB_UNIT_TYPES
} from '../../contracts/domains/characters.mjs';

import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { EQUIPMENT_EFFECT_KINDS } from '../../contracts/domains/items.mjs';
import { FLIGHT_STATUS_MARKERS } from '../../config/statuses.mjs';
import { clampSkillRank } from '../progression/rules.mjs';

const CORE_STAT_KEYS = Object.freeze([
  'hpMax', 'stnMax', 'mov', 'bld', 'mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res'
]);

/* -------------------------------------------- */
/*  Character vocabulary                        */
/* -------------------------------------------- */
export const CORE_STATS = Object.freeze(
  STATS.filter(entry => CORE_STAT_KEYS.includes(entry.key)).map(entry => Object.freeze({
    key: entry.key, label: entry.short ?? entry.label, growth: entry.growth
  }))
);

/** The stats a sheet groups under combat, in display order. */
export const COMBAT_STATS = Object.freeze(
  STATS.filter(entry => !CORE_STAT_KEYS.includes(entry.key)).map(entry => Object.freeze({
    key: entry.key, label: entry.short ?? entry.label
  }))
);

export const GROWTH_STATS = GROWTH_KEYS;

export const CRITICAL_MULTIPLIER_BASE = 2;
export const CRITICAL_MULTIPLIER_PER_WIT = 0.05;

export const SKILLS = VOCAB_SKILLS;

export const SKILL_BY_KEY = Object.freeze(Object.fromEntries(SKILLS.map(skill => [skill.key, skill])));
export const SKILL_RANK_DICE = Object.freeze([0, 4, 6, 8, 10]);

export const PROFICIENCIES = VOCAB_PROFICIENCIES;

export const UNIT_TYPES = VOCAB_UNIT_TYPES;

/** Portrait zoom limits shared by the Character sheet and portrait projection. */
const AVATAR_SCALE_BOUNDS = Object.freeze({ min: 0.5, max: 3, default: 1.25 });

/** Clamp the portrait zoom read by the Character sheet and portrait projection. */
export function resolveAvatarScale(rawScale) {
  const raw = Number(rawScale);
  if (!Number.isFinite(raw) || raw <= 0) return AVATAR_SCALE_BOUNDS.default;
  return Math.max(AVATAR_SCALE_BOUNDS.min, Math.min(AVATAR_SCALE_BOUNDS.max, raw));
}

/* -------------------------------------------- */
/*  Faction relations                           */
/* -------------------------------------------- */

/**
 * Each authored faction's relation group by lowercase name, indexed once because pathfinding occupancy and the threat
 * and aura projections ask for every pair of units.
 */
const FACTION_GROUP_BY_NAME = indexFactionGroups(FACTION_GROUPS);

/** Resolve the relation group an authored faction belongs to, or null when it names no combatant side. */
export function factionGroup(faction) {
  return FACTION_GROUP_BY_NAME.get(String(faction ?? '').toLowerCase()) ?? null;
}

/** Two factions are friendly when both are known and share a group. */
export function areFactionsFriendly(a, b) {
  const group = factionGroup(a);
  return group !== null && group === factionGroup(b);
}

/** Two factions are hostile when both are known and their groups differ, so a Neutral is hostile to both sides. */
export function areFactionsHostile(a, b) {
  const left = factionGroup(a);
  const right = factionGroup(b);
  return left !== null && right !== null && left !== right;
}

/**
 * Two factions are allied when they share a group other than neutral, so two Neutrals are friendly but not allied.
 * Used to find an Outflank partner (findCombatOutflanker in game/combat/exchange.mjs).
 */
export function areFactionsAllied(a, b) {
  const group = factionGroup(a);
  return group !== null && group !== 'neutral' && group === factionGroup(b);
}

/**
 * Two factions are opposed when both are on a side and the sides differ. A Neutral is never opposed to anyone. Used
 * by Outflank (game/combat/exchange.mjs) and by the hostile flag in engine/items/activation.mjs.
 */
export function areFactionsOpposed(a, b) {
  const left = factionGroup(a);
  const right = factionGroup(b);
  return left !== null && right !== null
    && left !== 'neutral' && right !== 'neutral' && left !== right;
}

/**
 * Whether an Item's authored target type admits a unit of one faction: a Friendly pick asks areFactionsFriendly, a
 * Hostile pick and every attack ask areFactionsHostile, and any other type admits every faction. A faction outside
 * the six roles is nobody's friend or foe, so a Friendly or Hostile pick refuses it. Used by item activation, its
 * area shapes in game/targeting/shapes.mjs, the attack grid and the exchange's own faction check.
 * @param {string} targetType The authored target type: Any, Self, Friendly, Hostile or Ground.
 * @param {string} sourceFaction The acting unit's faction role.
 * @param {string} targetFaction The candidate's faction role.
 * @returns {boolean}
 */
export function targetTypeAdmits(targetType, sourceFaction, targetFaction) {
  const type = String(targetType ?? 'Any');
  if (type === 'Friendly') return areFactionsFriendly(sourceFaction, targetFaction);
  if (type === 'Hostile') return areFactionsHostile(sourceFaction, targetFaction);
  return true;
}

/** Index the authored factions by lowercase name. Where two groups list the same name, the first group keeps it. */
function indexFactionGroups(groups) {
  const byName = new Map();
  for (const [group, members] of Object.entries(groups)) {
    for (const member of members) {
      const name = member.toLowerCase();
      if (!byName.has(name)) byName.set(name, group);
    }
  }
  return byName;
}

/* -------------------------------------------- */
/*  Special resources                           */
/* -------------------------------------------- */
/** Adjust a special-pool maximum for Character authoring while keeping previously full pools full. */
export function adjustSpecialPool(pool, delta, maximum = Number.POSITIVE_INFINITY) {
  const oldMax = Math.max(0, Math.floor(Number(pool?.max) || 0));
  const oldValue = Math.max(0, Math.min(oldMax, Math.floor(Number(pool?.value) || 0)));
  const nextMax = Math.max(0, Math.min(maximum, oldMax + Math.trunc(Number(delta) || 0)));
  const nextValue = nextMax > oldMax && oldValue === oldMax ? nextMax : Math.min(oldValue, nextMax);
  return { value: nextValue, max: nextMax };
}

/** Resolve an Extra Life heart click from the Character sheet into a new pool value. */
export function toggleExtraLife(pool, heartIndex) {
  const max = Math.max(0, Math.floor(Number(pool?.max) || 0));
  const value = Math.max(0, Math.min(max, Math.floor(Number(pool?.value) || 0)));
  const position = Math.floor(Number(heartIndex)) + 1;
  if (position < 1 || position > max) return { value, max };
  return { value: position <= value ? position - 1 : position, max };
}

/* -------------------------------------------- */
/*  Standard actions                            */
/* -------------------------------------------- */
/**
 * Return the action-spend verdict used by engine Character commands.
 * @param {{standardAvailable: boolean}} state
 * @returns {{ok: boolean, code: string, data: object}}
 */
export function spendStandardAction(state) {
  if (!state.standardAvailable) return refuse(RESULT_CODES.ACTION_ALREADY_SPENT);
  return accept(RESULT_CODES.ACTION_SPENT, { standardAvailable: false });
}

/**
 * Return the action-restoration verdict used by engine Character commands.
 * @param {{standardAvailable: boolean}} state
 * @returns {{ok: boolean, code: string, data: object}}
 */
export function restoreStandardAction(state) {
  if (state.standardAvailable) return refuse(RESULT_CODES.ACTION_ALREADY_AVAILABLE);
  return accept(RESULT_CODES.ACTION_RESTORED, { standardAvailable: true });
}

/* -------------------------------------------- */
/*  Skill checks                                */
/* -------------------------------------------- */
/** The skill-check bonus a stat value gives, from 0 at 3 or less up to 6 above 25. */
export function statBonus(statValue) {
  const value = Number(statValue) || 0;
  if (value <= 3) return 0;
  if (value <= 6) return 1;
  if (value <= 9) return 2;
  if (value <= 14) return 3;
  if (value <= 19) return 4;
  if (value <= 25) return 5;
  return 6;
}

export { clampSkillRank as skillRank };

/** A skill rank's die label, such as d6, or '' for rank 0. */
export function skillRankLabel(rank) {
  const die = SKILL_RANK_DICE[clampSkillRank(rank)];
  return die ? `d${die}` : '';
}

/* -------------------------------------------- */
/*  GM restoration                              */
/* -------------------------------------------- */
/** The markers a development restore leaves standing: worn, wielded, mounted, and the flight state. */
const RESET_RETAINED_EFFECT_KINDS = Object.freeze(Object.values(EQUIPMENT_EFFECT_KINDS));

const RESET_RETAINED_STATUSES = Object.freeze([
  FLIGHT_STATUS_MARKERS.airborne.id,
  FLIGHT_STATUS_MARKERS.grounded.id
]);

/** Whether an effect describes equipment or flight rather than something a reset should sweep away. */
function resetRetainsEffect(effect) {
  if (RESET_RETAINED_EFFECT_KINDS.includes(String(effect?.kind ?? ''))) return true;
  return (effect?.statuses ?? []).some(status => RESET_RETAINED_STATUSES.includes(String(status)));
}

/**
 * Plan one unit's full restore for FoundryDevelopmentRepository.restoreUnits: resources and special pools to their
 * maximum, the turn reopened, refreshing Items topped up, every effect the restore does not retain swept, and the
 * record of the Rallies it cast this map cleared (`clearRallies`), so it may Rally every unit again.
 * @param {object} source One projected unit from the development snapshot.
 * @returns {object} The resolution the writer applies.
 */
export function buildFullCharacterReset(source = {}) {
  const special = Object.fromEntries(Object.entries(source.special ?? {}).map(([key, pool]) => [
    key,
    { value: nonNegative(pool?.max), max: nonNegative(pool?.max) }
  ]));
  const items = spentItemUses(source.items, item => item?.refreshes === true);
  const removeEffectIds = (source.effects ?? [])
    .filter(effect => !resetRetainsEffect(effect))
    .map(effect => String(effect?.id ?? ''))
    .filter(Boolean);
  return {
    actorUuid: String(source.actorUuid ?? ''),
    actorName: String(source.actorName ?? 'Character'),
    resources: {
      hp: nonNegative(source.resources?.hp?.max),
      stn: nonNegative(source.resources?.stn?.max),
      shields: 0
    },
    special,
    items,
    removeEffectIds,
    clearRallies: source.rallied === true,
    turn: {
      actionAvailable: true,
      bonusActionAvailable: true,
      movementAvailable: true,
      movementSpent: 0,
      movementBonus: 0,
      extraActionUsed: false,
      traded: false,
      continuationPending: '',
      continuationRequestId: '',
      continuationCanters: false,
      movementPlanning: false,
      movementControllerId: '',
      movementAnchorX: 0,
      movementAnchorY: 0,
      movementPlanStartedAt: 0
    }
  };
}

/**
 * Plan one unit's Item repair for FoundryDevelopmentRepository.repairItems. Repair ignores the Refreshes switch a
 * restore honours: every Item that has uses and is not already full comes back to its maximum.
 * @param {object} source One projected unit from the development snapshot.
 * @returns {object} The resolution the writer applies.
 */
export function buildCharacterItemRepair(source = {}) {
  return {
    actorUuid: String(source.actorUuid ?? ''),
    actorName: String(source.actorName ?? 'Character'),
    items: spentItemUses(source.items, () => true)
  };
}

/** The items a restore or repair tops up: those with a use maximum, spent below it, and accepted by `admits`. */
function spentItemUses(items, admits) {
  return (items ?? [])
    .filter(item => admits(item))
    .map(item => ({
      id: String(item?.id ?? ''),
      uses: nonNegative(item?.uses?.max),
      spent: nonNegative(item?.uses?.current) !== nonNegative(item?.uses?.max)
    }))
    .filter(item => item.id && item.uses > 0 && item.spent)
    .map(item => ({ id: item.id, uses: item.uses }));
}

function nonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

/* -------------------------------------------- */
/*  World difficulty                            */
/* -------------------------------------------- */
export const DEFAULT_DIFFICULTY = 'normal';

/** The stats a tier raises flat, before the first totalization. */
export const DIFFICULTY_FLAT_STATS = Object.freeze(['atk', 'acc', 'spd', 'stnMax', 'def', 'res']);

const DIFFICULTY_TIERS = Object.freeze({
  normal: Object.freeze({ label: 'Normal', hpPercent: 0, atk: 0, acc: 0, spd: 0, stnMax: 0, def: 0, res: 0 }),
  veteran: Object.freeze({ label: 'Veteran', hpPercent: 0.10, atk: 2, acc: 2, spd: 0, stnMax: 1, def: 1, res: 1 }),
  extreme: Object.freeze({ label: 'Extreme', hpPercent: 0.15, atk: 3, acc: 3, spd: 2, stnMax: 1, def: 2, res: 2 }),
  lunatic: Object.freeze({ label: 'Lunatic', hpPercent: 0.25, atk: 4, acc: 4, spd: 4, stnMax: 1, def: 3, res: 3 })
});

/** The tier a setting value names, falling back to Normal for an unknown or removed one. */
export function difficultyTier(key) {
  return DIFFICULTY_TIERS[String(key ?? '')] ?? DIFFICULTY_TIERS[DEFAULT_DIFFICULTY];
}

/** Whether the world difficulty buffs a faction: the hostile sides only. */
export function isDifficultyTarget(faction) {
  return FACTION_GROUPS.enemy.includes(String(faction ?? ''));
}

/* -------------------------------------------- */
/*  Knowledge                                   */
/* -------------------------------------------- */
/** Plan Observer grants for the Foundry journal writer from a Character's player owners. */
export function planJournalAccessGrant(owners = [], observerLevel = 2) {
  return Object.freeze((owners ?? [])
    .filter(owner => owner && owner.isGM !== true && (Number(owner.level) || -1) < observerLevel)
    .map(owner => String(owner.userId)));
}

/** Which growth stats have reached their cap, for the Character sheet. Class contributions don't count toward it. */
export function zenithStats({ stats = {}, caps = {}, growthKeys = [], unplayable = false } = {}) {
  return Object.fromEntries(growthKeys.map(key => {
    if (unplayable) return [key, false];
    const limit = Number(caps[key]?.total) || 0;
    if (limit <= 0) return [key, false];
    const node = stats[key === 'hp' ? 'hpMax' : key] ?? {};
    return [key, (Number(node.base) || 0) >= limit - (Number(node.class) || 0)];
  }));
}

/* -------------------------------------------- */
/*  Free targeting                              */
/* -------------------------------------------- */

/**
 * Flag key, in this system's scope on the Actor, for the staff override that frees a unit from line of sight.
 * It is staff administration rather than a status: no effect grants it, preparation never derives it, and it
 * carries no marker. foundry/adapters/document-writes/characters.mjs writes it and the targeting projections
 * read it back through `unitIgnoresLineOfSight`.
 */
export const UNIT_FREE_TARGETING_FLAG = 'freeTargeting';

/** Whether this system's Actor flags carry the override. */
export function unitIgnoresLineOfSight(systemFlags) {
  return systemFlags?.[UNIT_FREE_TARGETING_FLAG] === true;
}

/**
 * The line-of-sight rule one action actually runs under. The override replaces whatever the item authored, so every
 * reader of an authored `losRule` (the attack grid, activation targeting, the sight projections and the exchange's
 * check) gets the unit's rule from here.
 * @param {string} [losRule] The Item's authored rule.
 * @param {boolean} [freeTargeting] Whether the acting unit holds the override.
 * @returns {string} One of the authored rules, or `'ignoreLoS'` when the override applies.
 */
export function resolveActionLosRule(losRule, freeTargeting) {
  return freeTargeting === true ? 'ignoreLoS' : String(losRule ?? 'normal');
}

/** The penalty shown beside a stat: encumbrance plus the harmful half of any aura, never a helpful one. */
export function statPenalty(node) {
  if (!node) return 0;
  return (Number(node.penalty) || 0) + Math.min(0, Number(node.aura) || 0);
}
