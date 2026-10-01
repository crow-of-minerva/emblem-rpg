/** @layer game/combat */
import {
  DAMAGE_POLICIES, DEFEAT_STATUSES, isDamagePolicy, MAGICAL_DAMAGE_TYPES, PHYSICAL_DAMAGE_TYPES, STANCE_BREAK_OUTCOMES
} from '../../contracts/domains/damage.mjs';
import { OWNED_UNIT_FACTIONS } from '../../contracts/domains/characters.mjs';
import { CRITICAL_MULTIPLIER_BASE } from '../character/rules.mjs';
import { finite, finite as finiteNumber, roundToHalf, whole } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Damage vocabulary                          */
/* -------------------------------------------- */
const PHYSICAL_TYPES = new Set(PHYSICAL_DAMAGE_TYPES);
const MAGICAL_TYPES = new Set(MAGICAL_DAMAGE_TYPES);
const PLAYER_UNIT_TYPES = new Set(OWNED_UNIT_FACTIONS);

/** A defeat that stood after its re-check: only this fires onKill and onDeath and counts the unit as slain. */
export function isConfirmedKill(defeatStatus) {
  return defeatStatus === DEFEAT_STATUSES.CLAIMED;
}

/** Whether a defeat ends its exchange: a kill, an Extra Life spent, or a unit already gone. A healed one does not. */
export function defeatEndsExchange(defeatStatus) {
  return [DEFEAT_STATUSES.CLAIMED, DEFEAT_STATUSES.EXTRA_LIFE, DEFEAT_STATUSES.ALREADY_DEFEATED].includes(defeatStatus);
}

/* -------------------------------------------- */
/*  Rule constants                              */
/* -------------------------------------------- */

/** The lowest HP damage can leave: 0, or 1 for a spared Lord or Retainer (hpFloor). */
const DEFEAT_HP_FLOOR = 0;
const SPARED_HP_FLOOR = 1;

/** Last Stand leaves a unit on this much HP when a hit would otherwise defeat it. */
const LAST_STAND_HP_FLOOR = 1;

/** A crit multiplier is never below 1, so a crit never lowers damage. An unreadable one falls back to 2. */
const MIN_CRITICAL_MULTIPLIER = 1;

/** A scaled multiplier is rounded to millionths, so floating-point error can't push a rounded-up total up a point. */
const CRITICAL_MULTIPLIER_PRECISION = 1e6;

/** Protection doubles the armor part of an ability's damage reduction, and a vulnerability doubles stance damage. */
const PROTECTED_ARMOR_MULTIPLIER = 2;
const VULNERABLE_BREAK_MULTIPLIER = 2;

/** Stance damage against a protected target is capped at 1, and exactly 1 is halved. */
const PROTECTED_BREAK_CAP = 1;
const PROTECTED_BREAK_HALVED = 0.5;

/** Armor uses lost to a hit that gets through, doubled when the armor is vulnerable to the damage type. */
const ARMOR_WEAR_PER_BLOW = 1;
const VULNERABLE_ARMOR_WEAR_PER_BLOW = 2;

/** What stance recovery restores when a unit has no regeneration value of its own. */
const DEFAULT_STANCE_REGENERATION = 3;

/* -------------------------------------------- */
/*  Lethality                                   */
/* -------------------------------------------- */
/**
 * The lowest HP resolveDamage can leave. Only an explicit `canKillPlayer === false` spares a Lord or Retainer at
 * 1 HP. An omitted value keeps the floor at 0, so callers must pass the value they mean. The phase-opening ticks
 * (game/effects/statuses.mjs) and terrain hazards (game/terrain/effects.mjs) use it too.
 */
export function hpFloor(actorType, canKillPlayer) {
  const spared = canKillPlayer === false && PLAYER_UNIT_TYPES.has(String(actorType ?? ''));
  return spared ? SPARED_HP_FLOOR : DEFEAT_HP_FLOOR;
}

/* -------------------------------------------- */
/*  Damage resolution                          */
/* -------------------------------------------- */
/**
 * The HP, stance and shield damage one hit deals, from the target's health snapshot. Called by
 * engine/combat/damage.mjs, effect execution (engine/effects/execution.mjs) and resolveCombatBlow in exchange.mjs.
 * The totals go to FoundryHealthRepository.commitDamage.
 */
export function resolveDamage(input) {
  const policy = input?.policy;
  if (!isDamagePolicy(policy)) throw new TypeError(`Unknown damage policy: ${String(policy)}`);

  const target = input.target ?? {};
  const hpBefore = whole(target.hp);
  const hpMax = whole(target.hpMax);
  const stanceBefore = roundToHalf(target.stance);
  const shieldBefore = whole(target.shield);
  const damageType = typeof input.damageType === 'string' ? input.damageType : '';
  const protections = stringSet(target.protections);
  const vulnerabilities = stringSet(target.vulnerabilities);
  const authoredVulnerabilities = stringSet(target.authoredVulnerabilities);
  const immunities = stringSet(target.immunities);

  let amount = nonNegative(input.damage);
  let stanceAmount = roundToHalf(input.stanceDamage);

  if (target.destructible === true) amount = 0;
  if (input.critical === true) amount = Math.ceil(amount * criticalMultiplierAgainst(input.criticalMultiplier, target));

  // Immunity outranks every policy below: an immune target takes neither HP nor Brk damage of that type, damage
  // over time and unpreventable ticks included. Protection, which only reduces damage, is handled separately.
  if (damageType && immunities.has(damageType)) {
    amount = 0;
    stanceAmount = 0;
  } else if (policy === DAMAGE_POLICIES.ABILITY) {
    stanceAmount = stanceBreakAfterMitigation({
      incoming: nonNegative(stanceAmount),
      reduction: nonNegative(target.breakReduction),
      protectedAgainst: protections.has(damageType),
      vulnerableTo: vulnerabilities.has(damageType)
    });
    let reduction = 0;
    if (PHYSICAL_TYPES.has(damageType)) reduction = finite(target.defenseTotal) - finite(target.defenseArmor);
    else if (MAGICAL_TYPES.has(damageType)) {
      reduction = finite(target.resistanceTotal) - finite(target.resistanceArmor);
    }
    reduction = Math.max(0, reduction);

    if (target.hasArmor === true) {
      let armor = 0;
      if (PHYSICAL_TYPES.has(damageType)) armor = nonNegative(target.armorDefense);
      else if (MAGICAL_TYPES.has(damageType)) armor = nonNegative(target.armorResistance);
      if (protections.has(damageType)) armor *= PROTECTED_ARMOR_MULTIPLIER;
      reduction += armor;
    }
    amount = Math.max(0, amount - reduction);
  } else if (policy === DAMAGE_POLICIES.DAMAGE_OVER_TIME) {
    if (input.unpreventable !== true && damageType && protections.has(damageType)) {
      amount = Math.max(0, amount - nonNegative(target.resistanceTotal));
      stanceAmount = 0;
    }
    if (damageType && authoredVulnerabilities.has(damageType)) stanceAmount *= VULNERABLE_BREAK_MULTIPLIER;
  }

  amount = Math.max(0, Math.round(amount));
  stanceAmount = roundToHalf(stanceAmount);
  const lastStand = applyLastStand(amount, hpBefore, target.lastStand === true);
  amount = lastStand.amount;

  const bypassPrevention = policy === DAMAGE_POLICIES.DAMAGE_OVER_TIME && input.unpreventable === true;
  const absorbed = bypassPrevention ? 0 : Math.min(amount, shieldBefore);
  amount -= absorbed;
  if (absorbed > 0 && amount === 0) stanceAmount = 0;
  amount = Math.min(amount, Math.max(0, hpBefore - hpFloor(target.actorType, input.canKillPlayer)));

  const hpAfter = Math.max(0, hpBefore - amount);
  const stanceAfter = Math.max(0, roundToHalf(stanceBefore - stanceAmount));
  const shieldAfter = Math.max(0, shieldBefore - absorbed);
  return Object.freeze({
    policy,
    damageType,
    amount,
    stanceAmount,
    absorbed,
    hpBefore,
    hpAfter,
    hpMax,
    stanceBefore,
    stanceAfter,
    shieldBefore,
    shieldAfter,
    protectionApplied: protections.has(damageType),
    vulnerabilityApplied: vulnerabilities.has(damageType),
    lastStandTriggered: lastStand.triggered,
    defeated: hpBefore > 0 && hpAfter <= 0,
    presentation: Object.freeze({
      allowSoftHit: policy === DAMAGE_POLICIES.WEAPON || policy === DAMAGE_POLICIES.DAMAGE_OVER_TIME
    })
  });
}

/**
 * The crit multiplier a hit applies to this target. Against a Lord or Retainer, only the bonus above normal damage
 * is scaled by the target's `criticalBonusScale`, which FoundryHealthRepository.getSnapshot reads from the world
 * setting. At a scale of 0.5, 2.25 becomes 1.625. Used by resolveDamage and by the exchange's damage receipt
 * (engine/combat/exchanges/receipts.mjs).
 * @param {number} multiplier The attacker's full critical multiplier, 2 by default.
 * @param {object} [target] The health target of the unit being struck.
 * @returns {number}
 */
export function criticalMultiplierAgainst(multiplier, target = {}) {
  const full = Math.max(MIN_CRITICAL_MULTIPLIER, finite(multiplier, CRITICAL_MULTIPLIER_BASE));
  const scale = finite(target?.criticalBonusScale, 1);
  if (!PLAYER_UNIT_TYPES.has(String(target?.actorType ?? '')) || !(scale >= 0 && scale < 1)) return full;
  return Math.round((1 + ((full - 1) * scale)) * CRITICAL_MULTIPLIER_PRECISION) / CRITICAL_MULTIPLIER_PRECISION;
}

/**
 * Stance damage after the target's break reduction. A protected target takes at most 1, and half a point when
 * exactly 1 gets through. A vulnerable one takes the incoming value doubled before the reduction. resolveDamage
 * applies it to an ability's stance damage, and combatBreakDamage in exchange.mjs to a weapon's Brk. Neither calls
 * it for an immune target. resolveDamage clamps both values at zero first, while the exchange passes its sides' Brk
 * and break reduction as they are.
 * @param {{incoming: number, reduction: number, protectedAgainst: boolean, vulnerableTo: boolean}} input
 * @returns {number}
 */
export function stanceBreakAfterMitigation({ incoming, reduction, protectedAgainst, vulnerableTo }) {
  const reduced = Math.max(0, incoming - reduction);
  if (protectedAgainst) {
    if (reduced > PROTECTED_BREAK_CAP) return PROTECTED_BREAK_CAP;
    return reduced === PROTECTED_BREAK_CAP ? PROTECTED_BREAK_HALVED : reduced;
  }
  if (vulnerableTo) return Math.max(0, (VULNERABLE_BREAK_MULTIPLIER * incoming) - reduction);
  return reduced;
}

/** Calculate the armor-use total saved by FoundryHealthRepository.commitDamage after HP damage gets through. */
export function resolveArmorWear({ damage, damageType, armor }) {
  const current = whole(armor?.current);
  const maximum = whole(armor?.maximum);
  if (!(damage > 0) || armor?.limited !== true || maximum <= 0 || current <= 0) return current;
  const loss = armor?.vulnerabilities?.includes?.(damageType)
    ? VULNERABLE_ARMOR_WEAR_PER_BLOW : ARMOR_WEAR_PER_BLOW;
  return Math.max(0, current - loss);
}

/* -------------------------------------------- */
/*  Healing resolution                         */
/* -------------------------------------------- */
/**
 * The HP and stance a heal restores, capped at each maximum. A target with `healingBlocked` gets no HP back.
 * Called by engine/combat/damage.mjs and effect execution. The totals go to FoundryHealthRepository.commitHealing.
 */
export function resolveHealing(input) {
  const hpBefore = whole(input?.target?.hp);
  const hpMax = whole(input?.target?.hpMax);
  const stanceBefore = roundToHalf(input?.target?.stance);
  const stanceMax = roundToHalf(input?.target?.stanceMax);
  const requestedAmount = whole(input?.amount);
  const requestedStanceAmount = roundToHalf(input?.stanceAmount);
  const allowedAmount = input?.target?.healingBlocked === true ? 0 : requestedAmount;
  const hpAfter = Math.min(hpMax, hpBefore + allowedAmount);
  const stanceAfter = Math.min(stanceMax, stanceBefore + requestedStanceAmount);
  return Object.freeze({
    requestedAmount,
    requestedStanceAmount,
    amount: Math.max(0, hpAfter - hpBefore),
    stanceAmount: Math.max(0, roundToHalf(stanceAfter - stanceBefore)),
    hpBefore,
    hpAfter,
    hpMax,
    stanceBefore,
    stanceAfter,
    healingBlocked: input?.target?.healingBlocked === true
  });
}

/* -------------------------------------------- */
/*  Numeric helpers                             */
/* -------------------------------------------- */
function applyLastStand(amount, hp, enabled) {
  if (!enabled || hp <= LAST_STAND_HP_FLOOR || amount < hp) return { amount, triggered: false };
  return { amount: Math.max(0, hp - LAST_STAND_HP_FLOOR), triggered: true };
}

function nonNegative(value) {
  return Math.max(0, finite(value));
}

function stringSet(value) {
  return new Set(Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : []);
}

/* -------------------------------------------- */
/*  Stance-break settlement                     */
/* -------------------------------------------- */
/**
 * What the unit's stance means for its Stance Break effect: apply it at 0 stance, clear it above 0, or repair it,
 * with the effects to delete and whether a new break grounds a flier. Called by StanceBreakService
 * (engine/combat/damage.mjs), exchange settlement and effect execution. The stance writer
 * (document-writes/stances.mjs) applies the changes in one capture.
 *
 * A freshly applied break grounds a flier in the air unless it levitates. A repaired or lingering break grounds
 * nobody.
 * @param {object} snapshot The stance snapshot, with its `airborne` and `levitating` facts.
 * @returns {object}
 */
export function resolveStanceBreak(snapshot) {
  const hp = finiteNumber(snapshot?.hp);
  const stance = finiteNumber(snapshot?.stance);
  const breakEffectIds = uniqueIds(snapshot?.breakEffectIds);
  const removeOnBreakEffectIds = uniqueIds(snapshot?.removeOnBreakEffectIds);
  const repairBreakEffectIds = uniqueIds(snapshot?.repairBreakEffectIds);
  if (hp <= 0) return transition(STANCE_BREAK_OUTCOMES.NONE);

  if (stance === 0) {
    const deleteEffectIds = [...new Set([...removeOnBreakEffectIds, ...repairBreakEffectIds])];
    const removed = new Set(deleteEffectIds);
    const stillBroken = breakEffectIds.some(id => !removed.has(id));
    // A repair is reported even when another break effect still applies, so StanceBreakService replaces the stale
    // effect definitions.
    const outcome = repairBreakEffectIds.length ? STANCE_BREAK_OUTCOMES.REPAIRED
      : stillBroken ? STANCE_BREAK_OUTCOMES.NONE
        : STANCE_BREAK_OUTCOMES.APPLIED;
    const grounds = outcome === STANCE_BREAK_OUTCOMES.APPLIED && groundsOnStanceBreak(snapshot);
    return transition(outcome, deleteEffectIds, !stillBroken, grounds);
  }
  if (stance > 0 && breakEffectIds.length) return transition(STANCE_BREAK_OUTCOMES.CLEARED, breakEffectIds);
  return transition(STANCE_BREAK_OUTCOMES.NONE);
}

/* -------------------------------------------- */
/*  Stance recovery                             */
/* -------------------------------------------- */
/**
 * The stance a resting unit gets back (restoreRestingStance in engine/combat/encounters/commands.mjs). The board
 * projection also reports it as `stanceRegen`. A stance-broken unit comes back to full. Stance-broken means an empty
 * pool, because resolveStanceBreak applies the break at exactly zero and clears it above zero. Any other unit
 * recovers its regeneration, up to its max.
 * @param {{value:number, max:number, regen?:number}} resource
 * @returns {number}
 */
export function stanceRecoveryAmount(resource) {
  const value = Number(resource?.value);
  const maximum = Number(resource?.max);
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || value >= maximum) return 0;
  if (value <= 0) return maximum;
  const rawRegeneration = Number(resource?.regen);
  const regeneration = Number.isFinite(rawRegeneration)
    ? Math.max(0, rawRegeneration) : DEFAULT_STANCE_REGENERATION;
  return Math.min(maximum - value, regeneration);
}

/* -------------------------------------------- */
/*  Rule helpers                                */
/* -------------------------------------------- */
/** A flier in the air falls when its stance breaks, unless it levitates. */
function groundsOnStanceBreak(snapshot) {
  return snapshot?.airborne === true && snapshot?.levitating !== true;
}

function transition(outcome, deleteEffectIds = [], createBreakEffect = false, grounds = false) {
  return {
    outcome,
    deleteEffectIds: [...deleteEffectIds],
    createBreakEffect,
    grounds
  };
}

function uniqueIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value ?? '')).filter(Boolean))];
}
