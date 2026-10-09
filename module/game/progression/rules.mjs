/** @layer game/progression */
import {
  BUDDING_TALENT,
  BUDDING_TALENT_ACTIONS,
  CHARACTER_EXPERIENCE_ACTOR_TYPES,
  CHARACTER_EXPERIENCE_THRESHOLD,
  CHARACTER_MAX_LEVEL,
  LEVEL_UP_STAT_KEYS,
  LEVEL_UP_VOICE_QUALITIES
} from '../../contracts/domains/progression.mjs';
import { PROFICIENCY_RANK_LETTERS, WEAPON_PROFICIENCIES } from '../../contracts/domains/items.mjs';
import { clamp, finite as finiteNumber, whole } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Progression rules                           */
/* -------------------------------------------- */
/**
 * Skill and proficiency rank limits, and the XP each skill rank costs. The Character and Class data models,
 * game/character/compilation.mjs and the character and class sheets read them.
 */
export const SKILL_RANK_MAX = 4;
export const SKILL_RANK_XP = Object.freeze([40, 60, 80, 100]);
export const PROFICIENCY_RANK_MAX = 6;

/**
 * Whether a unit holds the rank an Item asks for in one proficiency, for weapons, Spells and Armaments alike.
 * No proficiency, "None" or a rank of zero or less always passes. `totals` holds the unit's total for each
 * proficiency the caller knows about. A proficiency missing from it returns `unknown`, which the caller supplies.
 * @param {Readonly<Record<string, number>>} totals The unit's totals by lowercase proficiency key.
 * @param {unknown} required The proficiency the Item asks for, as authored.
 * @param {number} rank The rank it asks for, as the caller reads the authored value.
 * @param {*} [unknown] What to return for a proficiency missing from `totals`.
 * @returns {boolean|*} Whether the rank is held, or `unknown`.
 */
export function holdsProficiencyRank(totals, required, rank, unknown = false) {
  const key = String(required ?? '').trim().toLowerCase();
  if (!key || key === 'none' || !(rank > 0)) return true;
  if (!Object.hasOwn(totals ?? {}, key)) return unknown;
  return (Number(totals[key]) || 0) >= rank;
}

/** A skill rank as a whole number from 0 to SKILL_RANK_MAX; anything that isn't a number reads as 0. */
export function clampSkillRank(value) {
  return Math.max(0, Math.min(SKILL_RANK_MAX, Math.floor(Number(value) || 0)));
}

/* -------------------------------------------- */
/*  Skill experience                            */
/* -------------------------------------------- */

/**
 * Skill XP for one skill roll, whatever its result. grantSkillExperience in engine/character/progression.mjs awards
 * it when a GRANT_SKILL_EXPERIENCE request names no amount or fraction.
 */
export const SKILL_EXPERIENCE_PER_ROLL = 1;

/**
 * Add skill XP and climb every rank it pays for. XP left over at the top rank is dropped.
 * @param {object} skill Detached `{base, total, xp}` values. `base` is the earned rank the world stores, without
 *   class and passive bonuses.
 * @param {number} [amount] Points granted.
 * @returns {Readonly<{base: number, total: number, xp: number, ranksGained: number}>|null} Null at the top rank,
 *   where there is nothing left to earn and nothing is written.
 */
export function planSkillExperienceGrant(skill = {}, amount = SKILL_EXPERIENCE_PER_ROLL) {
  let total = clampSkillRank(skill.total);
  if (total >= SKILL_RANK_MAX) return null;
  let base = Math.max(0, Math.floor(Number(skill.base) || 0));
  let xp = Math.max(0, Math.floor(Number(skill.xp) || 0)) + Math.max(0, Math.floor(Number(amount) || 0));
  let ranksGained = 0;
  while (total < SKILL_RANK_MAX && xp >= SKILL_RANK_XP[total]) {
    xp -= SKILL_RANK_XP[total];
    total += 1;
    base += 1;
    ranksGained += 1;
  }
  if (total >= SKILL_RANK_MAX) xp = 0;
  return Object.freeze({ base, total, xp, ranksGained });
}

/**
 * A fraction of the skill's current rank bar, in points, so a caller can award "a quarter of a rank" without
 * knowing the curve. At least 1 while the skill can still advance, and 0 at the top rank.
 * @param {object} skill Detached `{total}` values.
 * @param {number} fraction Fraction of the bar.
 * @returns {number}
 */
export function skillBarExperience(skill = {}, fraction) {
  const total = clampSkillRank(skill.total);
  if (total >= SKILL_RANK_MAX) return 0;
  const bar = SKILL_RANK_XP[total];
  return Math.max(1, Math.round(bar * Math.max(0, Number(fraction) || 0)));
}

/* -------------------------------------------- */
/*  Weapon experience                           */
/* -------------------------------------------- */

const THRESHOLDS = Object.freeze(['maxE', 'maxD', 'maxC', 'maxB', 'maxA', 'maxS']);

/**
 * Calculate per-strike proficiency XP for the combat exchange and item activation engines: a landed strike is worth
 * two points and a miss one, scaled by the caller's multiplier through planProficiencyExperienceGrant.
 * @param {{proficiency: object, hit: boolean, multiplier?: number}} input
 * @returns {Readonly<object>|null} Null when nothing is awarded.
 */
export function resolveWeaponExperience({ proficiency, hit, multiplier = 1 }) {
  if (!proficiency || typeof proficiency !== 'object') return null;
  return planProficiencyExperienceGrant({ ...proficiency, multiplier }, hit ? 2 : 1);
}

/**
 * Work out a weapon proficiency XP award, for strikes and item uses (through resolveWeaponExperience) and for the
 * trainee of a downtime training session. The award is the amount scaled by the proficiency's own multiplier
 * (never below 1). The threshold comes from the displayed total rank. Crossing it climbs one rank at most, raises
 * only the earned base rank, empties the bar and drops the overflow. At total rank 5 the points keep adding up
 * without a rank-up. A missing or zero threshold earns nothing.
 * @param {object} proficiency Detached `{key, base, total, xp, multiplier, maxE..maxS}` values.
 * @param {number} amount Points before the multiplier.
 * @returns {Readonly<object>|null} Null when nothing is awarded.
 */
export function planProficiencyExperienceGrant(proficiency, amount) {
  const key = String(proficiency?.key ?? '').toLowerCase();
  if (!WEAPON_PROFICIENCIES.includes(key)) return null;
  const rank = Math.max(0, Math.floor(Number(proficiency.total) || 0));
  const earned = Number.isFinite(Number(proficiency.base)) ? Math.max(0, Math.floor(Number(proficiency.base))) : null;
  const current = Math.max(0, Math.floor(Number(proficiency.xp) || 0));
  const scale = Math.max(1, Number(proficiency.multiplier) || 1);
  const awarded = Math.max(0, Math.round((Number(amount) || 0) * scale));
  if (awarded <= 0) return null;
  const threshold = Math.floor(Number(proficiency[THRESHOLDS[rank]]) || 0);
  if (threshold <= 0) return null;
  const total = current + awarded;
  // Weapon XP never ranks a unit up past A (rank 5).
  const rankedUp = total >= threshold && rank < 5;
  return Object.freeze({
    key,
    awarded,
    rankedUp,
    rank: rankedUp ? rank + 1 : rank,
    total: rankedUp ? rank + 1 : rank,
    base: earned === null ? null : rankedUp ? earned + 1 : earned,
    rankLetter: rankedUp ? PROFICIENCY_RANK_LETTERS[rank] : null,
    xp: rankedUp ? 0 : total,
    threshold
  });
}

/* -------------------------------------------- */
/*  Experience awards                           */
/* -------------------------------------------- */
/** Whether this Character faction participates in level progression. */
export function earnsCharacterExperience(actorType) {
  return CHARACTER_EXPERIENCE_ACTOR_TYPES.includes(String(actorType ?? ''));
}

/** Apply Actor and world XP multipliers for engine Character experience awards. */
export function scaleCharacterExperience(rawExperience, actorMultiplierPercent = 100, worldMultiplier = 1) {
  const raw = finiteNumber(rawExperience);
  const actorMultiplier = finiteNumber(actorMultiplierPercent, 100) / 100;
  const requestedCampaignMultiplier = finiteNumber(worldMultiplier, 1);
  const campaignMultiplier = requestedCampaignMultiplier >= 0 ? requestedCampaignMultiplier : 1;
  return Math.floor(raw * actorMultiplier * campaignMultiplier);
}

/** Resolve one Character XP award for engine progression, stopping at the next level boundary. */
export function resolveCharacterExperienceAward({
  currentExperience,
  experienceThreshold = CHARACTER_EXPERIENCE_THRESHOLD,
  currentLevel,
  maxLevel = CHARACTER_MAX_LEVEL,
  requestedExperience
}) {
  const threshold = Math.max(1, whole(experienceThreshold) || CHARACTER_EXPERIENCE_THRESHOLD);
  const level = Math.max(1, whole(currentLevel) || 1);
  const levelCap = Math.max(1, whole(maxLevel) || CHARACTER_MAX_LEVEL);
  const requested = whole(requestedExperience);

  if (level >= levelCap) {
    return frozen({
      awarded: 0,
      discarded: requested,
      remainingExperience: 0,
      levelsGained: 0,
      atLevelCap: true
    });
  }

  const awarded = Math.min(requested, threshold);
  const discarded = requested - awarded;
  const total = whole(currentExperience) + awarded;
  const levelsGained = total >= threshold ? 1 : 0;
  return frozen({
    awarded,
    discarded,
    remainingExperience: levelsGained ? total - threshold : total,
    levelsGained,
    atLevelCap: false
  });
}

/** Calculate XP for damaging or defeating one opponent. */
function computeKillExperience(actorLevel, opponentLevel, opponentSlain) {
  const levelDifference = finiteNumber(opponentLevel) - finiteNumber(actorLevel);
  if (levelDifference <= -5) return 0;
  return opponentSlain
    ? clamp(20 + (4 * levelDifference), 3, 100)
    : clamp(3 + levelDifference, 1, 20);
}

/**
 * Raw level XP one unit earns from sparring with a partner in a downtime training session: what surviving a bout
 * against that level pays. The combat progression service (createCombatProgressionService in
 * engine/character/progression.mjs) scales it by the unit's and the world's multipliers.
 */
export function computeSparExperience(actorLevel, opponentLevel) {
  return computeKillExperience(actorLevel, opponentLevel, false);
}

/**
 * XP for one attack on one opponent, for the end of a combat exchange and activation XP's kill bonus: the
 * computeKillExperience amount, doubled up to 100 for slaying a boss. An attacker who started the exchange against
 * an opponent that survived and could not counter gets 5 at most.
 */
export function computeAttackExperience(
  actorLevel,
  opponentLevel,
  opponentSlain,
  { opponentIsBoss = false, isInitiator = false, opponentCouldCounter = false } = {}
) {
  let experience = computeKillExperience(actorLevel, opponentLevel, opponentSlain);
  if (opponentSlain && opponentIsBoss) experience = Math.min(100, experience * 2);
  else if (!opponentSlain && isInitiator && !opponentCouldCounter) experience = Math.min(experience, 5);
  return experience;
}

/* -------------------------------------------- */
/*  Level growth                                */
/* -------------------------------------------- */
/**
 * One level's stat gains and Budding Talent change, for engine/character/progression.mjs. The growth rolls come
 * from FoundryProgressionRepository.rollGrowths, and `statUpdates` goes back to that repository to write.
 */
export function resolveCharacterLevelUp({
  currentLevel,
  maxLevel = CHARACTER_MAX_LEVEL,
  stats,
  growthRolls,
  hasBuddingTalent = false
}) {
  const previousLevel = Math.max(1, whole(currentLevel) || 1);
  const levelCap = Math.max(1, whole(maxLevel) || CHARACTER_MAX_LEVEL);
  if (previousLevel >= levelCap) {
    return frozen({
      leveled: false,
      previousLevel,
      level: previousLevel,
      statUpdates: Object.freeze([]),
      stats: Object.freeze({}),
      buddingTalent: Object.freeze({ action: BUDDING_TALENT_ACTIONS.KEEP, reason: null }),
      voiceQuality: LEVEL_UP_VOICE_QUALITIES.BAD,
      reconcileClassFeatures: false
    });
  }

  const results = {};
  const statUpdates = [];
  for (const statKey of LEVEL_UP_STAT_KEYS) {
    const stat = normalizeGrowthStat(stats?.[statKey], statKey);
    const roll = growthRoll(growthRolls?.[statKey], statKey);
    const ceiling = stat.cap > 0 ? stat.cap - stat.classContribution : 0;
    const alreadyAtCap = stat.cap > 0 && stat.value >= ceiling;
    const growthChance = stat.growthRate + (hasBuddingTalent ? BUDDING_TALENT.growthBonus : 0);
    const increased = !alreadyAtCap && roll <= growthChance;
    const zenith = alreadyAtCap || (increased && stat.cap > 0 && stat.value + 1 >= ceiling);
    if (increased) statUpdates.push(Object.freeze({ statKey, value: stat.value + 1 }));
    results[statKey] = Object.freeze({
      oldValue: stat.total,
      newValue: increased ? stat.total + 1 : stat.total,
      increased,
      zenith,
      roll,
      growthChance
    });
  }

  const increasedStats = LEVEL_UP_STAT_KEYS.filter(statKey => results[statKey].increased);
  const meaningfulGrowths = increasedStats.filter(statKey => statKey !== 'hp');
  let buddingAction = BUDDING_TALENT_ACTIONS.KEEP;
  let buddingReason = null;
  if (!meaningfulGrowths.length && increasedStats.length <= 1 && !hasBuddingTalent) {
    buddingAction = BUDDING_TALENT_ACTIONS.GAIN;
    buddingReason = increasedStats.length ? 'only HP increased' : 'no stats increased';
  } else if (meaningfulGrowths.length && hasBuddingTalent) {
    buddingAction = BUDDING_TALENT_ACTIONS.REMOVE;
  }

  return frozen({
    leveled: true,
    previousLevel,
    level: previousLevel + 1,
    statUpdates: Object.freeze(statUpdates),
    stats: Object.freeze(results),
    buddingTalent: Object.freeze({ action: buddingAction, reason: buddingReason }),
    voiceQuality: meaningfulGrowths.length >= 2
      ? LEVEL_UP_VOICE_QUALITIES.GOOD
      : LEVEL_UP_VOICE_QUALITIES.BAD,
    reconcileClassFeatures: true
  });
}

/* -------------------------------------------- */
/*  Rule helpers                                */
/* -------------------------------------------- */
function normalizeGrowthStat(value, statKey) {
  if (!value || typeof value !== 'object') throw new TypeError(`Missing level-up state for ${statKey}.`);
  return {
    value: finiteNumber(value.value),
    total: finiteNumber(value.total),
    classContribution: finiteNumber(value.classContribution),
    cap: finiteNumber(value.cap),
    growthRate: finiteNumber(value.growthRate)
  };
}

function growthRoll(value, statKey) {
  const roll = Number(value);
  if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
    throw new RangeError(`Level-up roll for ${statKey} must be an integer from 1 to 100.`);
  }
  return roll;
}

function frozen(value) {
  return Object.freeze(value);
}
