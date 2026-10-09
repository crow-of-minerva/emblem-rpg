/** @layer game/combat */
import { COMBAT_CONTINUATIONS } from '../../contracts/domains/combat.mjs';
import { isEmpty as conditionIsEmpty } from '../../contracts/dsl/conditions.mjs';
import {
  DAMAGE_POLICIES, DAMAGE_TYPES, MAGICAL_DAMAGE_TYPES, PHYSICAL_DAMAGE_TYPES
} from '../../contracts/domains/damage.mjs';
import { evaluate as evaluateCondition } from '../effects/conditions.mjs';
import { rangeReachesEngagement } from '../targeting/attack-grid.mjs';
import { resolveDamage, stanceBreakAfterMitigation } from './damage.mjs';
import { clamp, finite as number } from '../../lib/core/runtime.mjs';
import { areFactionsAllied, areFactionsOpposed, CRITICAL_MULTIPLIER_BASE } from '../character/rules.mjs';

/* -------------------------------------------- */
/*  Combat vocabulary                           */
/* -------------------------------------------- */

const PHYSICAL_TYPES = new Set(PHYSICAL_DAMAGE_TYPES);
const MAGICAL_TYPES = new Set(MAGICAL_DAMAGE_TYPES);

/* -------------------------------------------- */
/*  Rule constants                              */
/* -------------------------------------------- */

/** Every combat chance is a percentage, so the clamp and the advantage curve both work on this scale. */
const CHANCE_MIN = 0;
const CHANCE_MAX = 100;

/**
 * Hit chance starts at 100, loses 5 for each point of the defender's Evasion and gains 5 for each point of the
 * attacker's Accuracy. Blessed adds 12.5. This is a linear estimate of the real roll, a d20 plus a d4 when Blessed,
 * which attackSuccessChance in game/rolls/checks.mjs works out exactly; the two differ slightly near 0% and 100%.
 */
const HIT_CHANCE_BASE = 100;
const HIT_CHANCE_PER_EVASION = 5;
const HIT_CHANCE_PER_ACCURACY = 5;
const HIT_CHANCE_BLESSED_BONUS = 12.5;

/** The speed leads that earn one or two extra attacks. speedAdvantageBand counts them negative for the slower side. */
const SPEED_LEAD_FOR_ONE_BLOW = 4;
const SPEED_LEAD_FOR_TWO_BLOWS = 8;

/** An attacker with more attacks than the defender, and at least this many, opens with two before the defender's. */
const DOUBLE_OPENING_MIN_BLOWS = 4;
const DOUBLE_OPENING_BLOWS = 2;

/**
 * Effectiveness scales every die and constant of the attack formula before mitigation is subtracted: doubled
 * against an effective target, or 1.35 when that target is Impervious.
 */
const EFFECTIVE_DAMAGE_MULTIPLIER = 2;
const IMPERVIOUS_DAMAGE_MULTIPLIER = 1.35;
const PLAIN_DAMAGE_MULTIPLIER = 1;

/** A critical from an attacker that breaks Def halves physical mitigation, the odd point going to the attacker. */
const CRIT_DEFENSE_BREAK_DIVISOR = 2;

/** A flanked defender gives advantage only to an attacker at this distance, standing right beside it. */
const FLANKING_DISTANCE = 1;

/** What an ally's Mark on the defender is worth to every other attacker. */
const MARKED_ATTACK_BONUS = 3;
const MARKED_SPEED_BONUS = 3;
const MARKED_CRIT_BONUS = 10;

/* -------------------------------------------- */
/*  Exchange planning                           */
/* -------------------------------------------- */

/**
 * The order of attacks in an exchange, such as A1, D1, A2. A defender with First Strike goes first unless the
 * attacker has it too.
 */
export function buildCombatSequence(attackerInput, defenderInput, defenderCanRespond = true) {
  const attacker = combatant(attackerInput);
  const defender = combatant(defenderInput);
  if (defender.firstStrike && !attacker.firstStrike && defenderCanRespond) {
    return swapLabels(buildSequenceInternal(defender, attacker, true));
  }
  return buildSequenceInternal(attacker, defender, defenderCanRespond);
}

/** How many attacks a side makes, from speed and weapon traits. */
export function combatAttackCount(attackerInput, defenderInput, defenderSpeedDelta = 0) {
  return attackCount(combatant(attackerInput), combatant(defenderInput), defenderSpeedDelta);
}

/** The extra attacks a speed lead earns (0, 1 or 2), negative for the slower side. Shown by projections/tokens.mjs. */
export function speedAdvantageBand(difference) {
  const value = Number(difference) || 0;
  if (value >= SPEED_LEAD_FOR_TWO_BLOWS) return 2;
  if (value >= SPEED_LEAD_FOR_ONE_BLOW) return 1;
  if (value <= -SPEED_LEAD_FOR_TWO_BLOWS) return -2;
  if (value <= -SPEED_LEAD_FOR_ONE_BLOW) return -1;
  return 0;
}

/**
 * What an ally's Mark on the defender is worth to this attacker. withMarkedBonus in
 * foundry/adapters/projections/combat-context.mjs finds the Mark and adds these four fields to the attacker's combat
 * stats, which calculateCombatSide and combatAttackCount then read.
 * @param {boolean} applied Whether a Mark placed by an ally applies to this attacker.
 * @returns {Readonly<object>} The four Mark fields, all zero or false when no Mark applies.
 */
export function projectMarkedBonus(applied) {
  const marked = applied === true;
  return Object.freeze({
    markedAttackBonus: marked ? MARKED_ATTACK_BONUS : 0,
    markedSpeedBonus: marked ? MARKED_SPEED_BONUS : 0,
    markedCritBonus: marked ? MARKED_CRIT_BONUS : 0,
    markedAdvantage: marked
  });
}

/**
 * Merge a Weapon Art's traits into its weapon's for the attacker's combat stats, by the same rules as
 * applyWeaponArt in game/character/compilation.mjs. An Art only ever adds: its Breaker and Effectiveness flags join
 * the weapon's and never switch one off. Extra attacks are the exception, because either the weapon or the Art
 * disabling them turns them off for both.
 */
export function combineWeaponArtTraits(weaponInput = {}, artInput = null) {
  const weapon = weaponInput ?? {};
  const art = artInput ?? null;
  const extrasDisabled = weapon.noExtraAttacks === true || art?.noExtraAttacks === true;
  const extraAttacks = extrasDisabled ? 0 : number(weapon.extraAttacks) + number(art?.extraAttacks);
  const effectiveAgainst = { ...(weapon.effectiveAgainst ?? {}) };
  for (const [key, active] of Object.entries(art?.effectiveAgainst ?? {})) {
    if (active === true) effectiveAgainst[key] = true;
  }
  const breaker = { ...(weapon.breaker ?? {}) };
  for (const [key, active] of Object.entries(art?.breaker ?? {})) {
    if (active === true) breaker[key] = true;
  }
  return Object.freeze({
    extraAttacks,
    noExtraAttacks: extrasDisabled,
    effectiveAgainst: Object.freeze(effectiveAgainst),
    breaker: Object.freeze(breaker)
  });
}

/**
 * One side's damage formula, hit and crit chances, stance damage and advantage against the other.
 */
export function calculateCombatSide(attackerInput, defenderInput, options = {}) {
  const attacker = combatant(attackerInput);
  const defender = combatant(defenderInput);
  const validDamageTypes = damageTypesFor(attacker, defender);
  const damageType = attacker.randomizeDamageType && validDamageTypes.length
    ? validDamageTypes[randomIndex(options.damageTypeRoll, validDamageTypes.length)]
    : chooseCombatDamageType(attacker, defender, options.damageType);
  const effectiveness = combatEffectiveness(attacker, defender);
  const attack = addFormulaBonus(attacker.attack, attacker.markedAttackBonus);
  const reduction = mitigation(defender, damageType);
  const criticalReduction = criticalMitigation(attacker, reduction, damageType);
  // Immunity is absolute rather than a mitigation: an immune defender takes no HP damage of this type, and
  // combatBreakDamage below already returns nothing for it.
  const immune = defender.immunities.has(damageType);
  const formula = defender.destructible || immune
    ? '0' : attackDamageFormula(attack, reduction, effectiveness.multiplier);
  const criticalFormula = defender.destructible || immune || criticalReduction === reduction ? formula
    : attackDamageFormula(attack, criticalReduction, effectiveness.multiplier);
  const affinity = immune
    ? 'immune' : defender.protections.has(damageType)
      ? 'ineffective' : defender.vulnerabilities.has(damageType) ? 'effective' : null;
  const advantage = combatAdvantage(attacker, defender, Number(options.distance) || 0);
  const baseHitChance = combatHitChance(attacker, defender);
  return Object.freeze({
    damageType,
    damageFormula: formula,
    criticalDamageFormula: criticalFormula,
    attackFormula: attack,
    mitigation: reduction,
    criticalMitigation: criticalReduction,
    effectivenessMultiplier: effectiveness.multiplier,
    effective: effectiveness.effective,
    impervious: effectiveness.impervious,
    affinity,
    breakDamage: combatBreakDamage(attacker, defender, damageType),
    hitChance: advantage > 0 ? advantagedHitChance(baseHitChance)
      : advantage < 0 ? disadvantagedHitChance(baseHitChance) : baseHitChance,
    critChance: defender.destructible ? 0
      : Math.max(0, attacker.crit - defender.armor.critReduction - defender.charisma) + attacker.markedCritBonus,
    advantage: advantage > 0,
    disadvantage: advantage < 0
  });
}

/** The damage a landed hit deals, from its rolled damage and hit check. Called by engine/combat/exchanges/blows.mjs. */
export function resolveCombatBlow({ attacker, defender, side, check, rolledDamage, damageType }) {
  const critical = check.result === 'crit';
  const resolution = resolveDamage({
    policy: DAMAGE_POLICIES.WEAPON,
    damage: Math.max(0, Number(rolledDamage) || 0),
    damageType,
    stanceDamage: Math.max(0, Number(attacker.breakDamage) || 0),
    critical,
    criticalMultiplier: Number(attacker.criticalMultiplier) || CRITICAL_MULTIPLIER_BASE,
    target: defender
  });
  return Object.freeze({ side, check, critical, damageType, resolution });
}

/* -------------------------------------------- */
/*  Turn continuation                           */
/* -------------------------------------------- */

/**
 * What the attacker's turn does after an exchange: end, return to exploration, Multiattack, offer an Extra Action,
 * or Canter. A turn whose Action an effect gave back (`turnRefreshed`) ends, keeping the restored slots. Called by
 * engine/combat/exchanges/resolution.mjs.
 */
export function resolveCombatContinuation(input = {}) {
  if (input.sourceDefeated === true) return turnContinuation(COMBAT_CONTINUATIONS.END_TURN);
  if (input.explorationActive === true) return turnContinuation(COMBAT_CONTINUATIONS.EXPLORATION);
  if (input.turnRefreshed === true) return turnContinuation(COMBAT_CONTINUATIONS.END_TURN);
  if (input.hasMultiAttack === true && input.bonusAvailable === true) {
    return turnContinuation(COMBAT_CONTINUATIONS.MULTIATTACK);
  }
  if (input.extraActionUsed !== true && Math.max(0, number(input.extraActionsRemaining)) > 0) {
    return turnContinuation(COMBAT_CONTINUATIONS.EXTRA_ACTION_CHOICE);
  }
  if (input.hasCanter === true && Math.max(0, number(input.movementRemaining)) > 0) {
    return turnContinuation(COMBAT_CONTINUATIONS.CANTER);
  }
  return turnContinuation(COMBAT_CONTINUATIONS.END_TURN);
}

/**
 * The continuation once the player answers the Extra Action choice: take the Extra Action, or decline it and Canter
 * or end the turn. Declining Canters only when the action that offered the choice allows it (`cantersAfter`: an
 * attack, a Spell or a staff). null means the answer isn't allowed. Called by engine/combat/exchanges/resolution.mjs.
 */
export function resolveCombatContinuationChoice(input = {}) {
  if (input.decision === COMBAT_CONTINUATIONS.EXTRA_ACTION) {
    if (input.sourceDefeated === true || input.extraActionUsed === true
      || Math.max(0, number(input.extraActionsRemaining)) < 1) return null;
    return turnContinuation(COMBAT_CONTINUATIONS.EXTRA_ACTION);
  }
  if (input.decision !== COMBAT_CONTINUATIONS.END_TURN) return null;
  if (input.sourceDefeated !== true && input.cantersAfter === true && input.hasCanter === true
    && Math.max(0, number(input.movementRemaining)) > 0) {
    return turnContinuation(COMBAT_CONTINUATIONS.CANTER);
  }
  return turnContinuation(COMBAT_CONTINUATIONS.END_TURN);
}

/**
 * The actions effects gave back to the attacker during the exchange, which its end of turn keeps. null when none
 * were given back.
 * @param {object[]} restores What each restore gave back, one record per unit.
 * @param {string} actorUuid The attacker.
 * @returns {{action: boolean, bonus: boolean, movement: boolean}|null} `action` is the standard action.
 */
export function keptTurnSlots(restores, actorUuid) {
  const own = (restores ?? []).filter(record => record?.actorUuid === actorUuid);
  if (!own.length) return null;
  const kept = slot => own.some(record => record[slot] === true);
  return Object.freeze({ action: kept('action'), bonus: kept('bonus'), movement: kept('movement') });
}

/** Build the continuation flags read by the engine and movement UI. */
export function turnContinuation(kind) {
  const resumesMovement = [
    COMBAT_CONTINUATIONS.EXPLORATION,
    COMBAT_CONTINUATIONS.MULTIATTACK,
    COMBAT_CONTINUATIONS.EXTRA_ACTION,
    COMBAT_CONTINUATIONS.CANTER,
    COMBAT_CONTINUATIONS.BONUS_ACTION,
    COMBAT_CONTINUATIONS.MOVEMENT
  ].includes(kind);
  return Object.freeze({
    kind,
    resumesMovement,
    reselects: resumesMovement && kind !== COMBAT_CONTINUATIONS.MOVEMENT,
    requiresChoice: kind === COMBAT_CONTINUATIONS.EXTRA_ACTION_CHOICE,
    turnEnded: kind === COMBAT_CONTINUATIONS.END_TURN
  });
}

/* -------------------------------------------- */
/*  Damage rules                                */
/* -------------------------------------------- */

/**
 * The damage type to use when the player hasn't picked a valid one. Immune types are dropped unless nothing would
 * remain. Then a type the defender is vulnerable to wins, then a neutral one, then a protected one.
 */
function chooseCombatDamageType(attacker, defender, selected = '') {
  const valid = damageTypesFor(attacker, defender);
  if (selected && valid.includes(selected)) return selected;
  const unblocked = valid.filter(type => !defender.immunities.has(type));
  const allowed = unblocked.length ? unblocked : valid;
  return allowed.find(type => defender.vulnerabilities.has(type))
    ?? allowed.find(type => !defender.protections.has(type) && !defender.vulnerabilities.has(type))
    ?? allowed.find(type => defender.protections.has(type))
    ?? allowed[0]
    ?? 'none';
}

/** Filter combat damage types using the wielded item's target conditions before calculateCombatSide chooses one. */
export function combatDamageTypes(attackerInput, defenderInput) {
  return damageTypesFor(combatant(attackerInput), combatant(defenderInput));
}

/**
 * The damage-type roll that lands a side rolling its type at random on `damageType`, so the Combat Preview can show
 * a type the player picked as the one rolled (projectFoundryCombatPreview). The exchange still rolls for real.
 * @returns {number|undefined} The roll, or undefined when the side could never roll that type here.
 */
export function damageTypeRollFor(attackerInput, defenderInput, damageType) {
  const types = combatDamageTypes(attackerInput, defenderInput);
  const index = types.indexOf(damageType);
  return index < 0 ? undefined : (index + 0.5) / types.length;
}

/** Apply effectiveness to every dice count and constant before mitigation. A negative reduction gives `1d8--2`. */
function attackDamageFormula(formula, reduction, multiplier = PLAIN_DAMAGE_MULTIPLIER) {
  const scaled = scaleFormula(String(formula ?? '0'), multiplier);
  return Number(reduction) ? `${scaled}-${Number(reduction)}` : scaled;
}

/** Calculate exchange stance damage: nothing against immunity, otherwise stanceBreakAfterMitigation in damage.mjs. */
function combatBreakDamage(attacker, defender, damageType) {
  if (defender.immunities.has(damageType)) return 0;
  return stanceBreakAfterMitigation({
    incoming: attacker.breakDamage,
    reduction: defender.armor.breakReduction,
    protectedAgainst: defender.protections.has(damageType),
    vulnerableTo: defender.vulnerabilities.has(damageType)
  });
}

/* -------------------------------------------- */
/*  Hit and counter rules                       */
/* -------------------------------------------- */

/** The linear hit-chance estimate described at HIT_CHANCE_BASE. */
function combatHitChance(attacker, defender) {
  return clamp(HIT_CHANCE_BASE - (defender.evasion * HIT_CHANCE_PER_EVASION)
    + (attacker.accuracy * HIT_CHANCE_PER_ACCURACY)
    + (attacker.blessed ? HIT_CHANCE_BLESSED_BONUS : 0), CHANCE_MIN, CHANCE_MAX);
}

/** Advantage rolls twice and keeps the better, so the miss chance is squared. Disadvantage squares the hit chance. */
function advantagedHitChance(chance) {
  return Math.round(clamp(CHANCE_MAX - (((CHANCE_MAX - chance) ** 2) / CHANCE_MAX), CHANCE_MIN, CHANCE_MAX));
}

function disadvantagedHitChance(chance) {
  return Math.round(clamp((chance ** 2) / CHANCE_MAX, CHANCE_MIN, CHANCE_MAX));
}

/** Whether the defender can counterattack with its current weapon, uses and range, for buildCombatSequence. */
export function defenderCanCounter(defenderInput, distance, attackerInput = {}, engagement = '') {
  const defender = combatant(defenderInput);
  const attacker = combatant(attackerInput);
  if (!defender.weapon.present || defender.hp.value < 1 || defender.stance.value < 1) return false;
  if (defender.silenced && defender.weapon.magic) return false;
  if (defender.cannotCounter || attacker.counterlock) return false;
  if (!combatWeaponHasUses(defender.weapon)) return false;
  return rangeReachesEngagement(defender.weapon.range, distance, engagement, defender.airborne);
}

/**
 * Whether a side is down, which ends the exchange's attacks (engine/combat/exchanges/blows.mjs): a unit at 0 HP, or
 * a Destructible at 0 Integrity.
 */
export function sideDown(side = {}) {
  if ((Number(side.hp?.value) || 0) <= 0) return true;
  return side.destructible === true && (Number(side.stance?.value) || 0) <= 0;
}

/**
 * Whether the weapon has a use left after the uses this exchange has already spent. It accepts the item's raw
 * `uses.type` as well as the cleaned-up `uses.infinite`, so callers may pass either.
 */
export function combatWeaponHasUses(weapon = {}, pendingUses = 0) {
  if (weapon.uses?.infinite === true || weapon.uses?.type === 'infinite') return true;
  return Math.max(0, number(weapon.uses?.current) - Math.max(0, number(pendingUses))) > 0;
}

/* -------------------------------------------- */
/*  Rule helpers                                */
/* -------------------------------------------- */

/** Count one normalized side's attacks. combatAttackCount normalizes the input for callers outside this file. */
function attackCount(attacker, defender, defenderSpeedDelta = 0) {
  if (attacker.hp.value <= 0 || attacker.stance.value <= 0) return 0;
  let count = 1 + (attacker.noExtraAttacks ? 0 : attacker.extraAttacks);
  if (!attacker.destructible && !defender.destructible) {
    const difference = attacker.speed + attacker.markedSpeedBonus - defender.speed - defenderSpeedDelta;
    count += Math.max(0, speedAdvantageBand(difference));
  }
  return attacker.noExtraAttacks ? Math.min(count, 1) : count;
}

function buildSequenceInternal(attacker, defender, defenderCanRespond) {
  const attackerCount = attackCount(attacker, defender);
  const defenderCount = defenderCanRespond ? attackCount(defender, attacker) : 0;
  const sequence = [];
  let a = 0;
  let d = 0;
  // With at least four attacks and more than the defender, the attacker opens with two before the defender answers.
  if (attackerCount > defenderCount && attackerCount >= DOUBLE_OPENING_MIN_BLOWS && defenderCount > 0) {
    while (a < DOUBLE_OPENING_BLOWS) sequence.push(`A${++a}`);
    while (a < attackerCount || d < defenderCount) {
      if (d < defenderCount) sequence.push(`D${++d}`);
      if (a < attackerCount) sequence.push(`A${++a}`);
    }
    return Object.freeze(sequence);
  }
  while (a < attackerCount || d < defenderCount) {
    if (a < attackerCount) sequence.push(`A${++a}`);
    if (d < defenderCount) sequence.push(`D${++d}`);
  }
  return Object.freeze(sequence);
}

function swapLabels(sequence) {
  return Object.freeze(sequence.map(label => label.startsWith('A') ? `D${label.slice(1)}` : `A${label.slice(1)}`));
}

function combatEffectiveness(attacker, defender) {
  const effective = [...defender.unitTypes].some(type => attacker.effectiveAgainst.has(type));
  const impervious = effective && defender.impervious;
  const multiplier = impervious ? IMPERVIOUS_DAMAGE_MULTIPLIER
    : effective ? EFFECTIVE_DAMAGE_MULTIPLIER : PLAIN_DAMAGE_MULTIPLIER;
  return { effective, impervious, multiplier };
}

/** Halve a crit's physical mitigation, rounding down, for an attacker that breaks Def. */
function criticalMitigation(attacker, reduction, damageType) {
  if (!attacker.critDefenseBreak || !PHYSICAL_TYPES.has(damageType) || reduction <= 0) return reduction;
  return Math.floor(reduction / CRIT_DEFENSE_BREAK_DIVISOR);
}

function mitigation(defender, damageType) {
  if (PHYSICAL_TYPES.has(damageType)) {
    return defender.defense + (defender.protections.has(damageType) ? defender.armor.defense : 0);
  }
  if (MAGICAL_TYPES.has(damageType)) {
    return defender.resistance + (defender.protections.has(damageType) ? defender.armor.resistance : 0);
  }
  return 0;
}

function scaleFormula(formula, multiplier) {
  if (multiplier === PLAIN_DAMAGE_MULTIPLIER) return formula;
  return formula.replace(/(\d+)d(\d+)|(?<![d\d])(\d+)(?![d\d])/gi, (_match, count, size, constant) => {
    if (count !== undefined) return `${Math.ceil(Number(count) * multiplier)}d${size}`;
    return String(Math.ceil(Number(constant) * multiplier));
  });
}

/**
 * One attack's net advantage: 1, 0 or -1. The defender's Dexterity counts against it rather than overriding it, so
 * truestrike, a Mark or a favourable weapon triangle can cancel it out. The defender spends the Dexterity point
 * either way, which engine/combat/exchanges/blows.mjs deducts for each attack.
 */
function combatAdvantage(attacker, defender, distance) {
  const hasAdvantage = attacker.truestrike || defender.shine || attacker.markedAdvantage
    || attacker.weaponAdvantages.has(defender.weapon.proficiency)
    || (defender.flanked && distance === FLANKING_DISTANCE);
  const hasDisadvantage = attacker.blinded || attacker.flanked
    || defender.weaponAdvantages.has(attacker.weapon.proficiency);
  return Math.sign((hasAdvantage ? 1 : 0) - (hasDisadvantage ? 1 : 0) - (defender.dexterity > 0 ? 1 : 0));
}

const COMBATANTS = new WeakMap();

/**
 * @typedef {object} CombatSide One unit's combat stats after cleanup: every field present, every number finite,
 * every trait a boolean, every trait list a Set except `damageTypes` (an array), and the weapon proficiency in
 * lowercase, so a weapon advantage lookup matches an authored 'Heavy' as well as 'heavy'. The exported functions
 * build one; the helpers in this file assume this shape.
 */

/**
 * Clean up one unit's combat stats into a CombatSide, cached per input object for repeated preview calculations. A
 * cached input must not be changed afterwards, so engine/combat/exchanges/ passes a new object after each attack.
 * @param {object} [value] Raw combat stats from the preview, the Enemy AI or the exchange.
 * @returns {CombatSide}
 */
function combatant(value = {}) {
  const cached = COMBATANTS.get(value);
  if (cached) return cached;
  const weapon = value.weapon ?? {};
  const shaped = {
    hp: track(value.hp),
    stance: track(value.stance),
    shield: number(value.shield),
    defense: number(value.defense),
    resistance: number(value.resistance),
    evasion: number(value.evasion),
    accuracy: number(value.accuracy),
    crit: number(value.crit),
    charisma: number(value.charisma),
    speed: number(value.speed),
    attack: String(value.attack ?? '0'),
    breakDamage: number(value.breakDamage),
    criticalMultiplier: number(value.criticalMultiplier) || CRITICAL_MULTIPLIER_BASE,
    extraAttacks: Math.max(0, Math.floor(number(value.extraAttacks))),
    noExtraAttacks: value.noExtraAttacks === true,
    firstStrike: value.firstStrike === true,
    cannotCounter: value.cannotCounter === true,
    counterlock: value.counterlock === true,
    destructible: value.destructible === true,
    impervious: value.impervious === true,
    critDefenseBreak: value.critDefenseBreak === true,
    blessed: value.blessed === true,
    blinded: value.blinded === true,
    flanked: value.flanked === true,
    truestrike: value.truestrike === true,
    shine: value.shine === true,
    silenced: value.silenced === true,
    airborne: value.airborne === true,
    markedAdvantage: value.markedAdvantage === true,
    markedAttackBonus: number(value.markedAttackBonus),
    markedCritBonus: number(value.markedCritBonus),
    markedSpeedBonus: number(value.markedSpeedBonus),
    dexterity: Math.max(0, number(value.dexterity)),
    armor: {
      defense: number(value.armor?.defense),
      resistance: number(value.armor?.resistance),
      breakReduction: number(value.armor?.breakReduction),
      critReduction: number(value.armor?.critReduction)
    },
    unitTypes: trueSet(value.unitTypes),
    protections: trueSet(value.protections),
    vulnerabilities: trueSet(value.vulnerabilities),
    immunities: trueSet(value.immunities),
    effectiveAgainst: trueSet(value.effectiveAgainst),
    weaponAdvantages: trueSet(value.weaponAdvantages),
    damageTypes: DAMAGE_TYPES.filter(type => value.damageTypes?.includes?.(type) || value.damageTypes?.[type] === true),
    damageTypeConditions: value.damageTypeConditions ?? {},
    randomizeDamageType: value.randomizeDamageType === true,
    conditionSelf: value.conditionSelf ?? Object.freeze({ system: Object.freeze({}) }),
    conditionItem: value.conditionItem ?? Object.freeze({ system: Object.freeze({}) }),
    weapon: {
      present: weapon.present !== false && Boolean(weapon.id || weapon.uuid || weapon.name),
      magic: weapon.magic === true,
      proficiency: String(weapon.proficiency ?? '').trim().toLowerCase(),
      range: String(weapon.range ?? '1'),
      uses: {
        current: Math.max(0, number(weapon.uses?.current)),
        maximum: Math.max(0, number(weapon.uses?.maximum ?? weapon.uses?.max)),
        infinite: weapon.uses?.infinite === true || weapon.uses?.type === 'infinite'
      }
    }
  };
  COMBATANTS.set(value, shaped);
  return shaped;
}

/** Filter a normalized attacker's damage types. combatDamageTypes normalizes for callers outside this file. */
function damageTypesFor(attacker, defender) {
  return attacker.damageTypes.filter(type => damageTypeConditionPasses(
    attacker.damageTypeConditions[type],
    attacker,
    defender
  ));
}

function damageTypeConditionPasses(tree, attacker, defender) {
  if (conditionIsEmpty(tree)) return true;
  try {
    return evaluateCondition(tree, {
      ...attacker.conditionSelf,
      self: attacker.conditionSelf,
      target: defender.conditionSelf,
      actor: attacker.conditionSelf,
      item: attacker.conditionItem
    }) === true;
  } catch {
    return false;
  }
}

function randomIndex(roll, length) {
  const value = Number(roll);
  const bounded = Number.isFinite(value) ? Math.max(0, Math.min(0.999999999999, value)) : 0;
  return Math.floor(bounded * length);
}

function addFormulaBonus(formula, bonus) {
  const value = String(formula ?? '0').trim() || '0';
  if (!bonus) return value;
  return bonus > 0 ? `${value}+${bonus}` : `${value}${bonus}`;
}

function trueSet(value) {
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set(Object.entries(value ?? {}).filter(([, active]) => active === true).map(([key]) => key));
}

function track(value = {}) {
  return { value: Math.max(0, number(value.value)), max: Math.max(0, number(value.max)) };
}

/* -------------------------------------------- */
/*  Flanking geometry                           */
/* -------------------------------------------- */

const ADJACENT_CELLS = Object.freeze([
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1]
]);

/**
 * The adjacent Outflank unit that flanks a single-cell defender: opposed to the defender's faction, with an ally of
 * its own directly opposite. Used by projections/combat-context.mjs.
 */
export function findCombatOutflanker({ x, y, faction, occupantAt }) {
  for (const [dx, dy] of ADJACENT_CELLS) {
    const outflanker = occupantAt(x + dx, y + dy);
    if (!outflanker?.hasOutflank || !areFactionsOpposed(faction, outflanker.faction)) continue;
    const partner = occupantAt(x - dx, y - dy);
    if (!partner || partner.tokenUuid === outflanker.tokenUuid) continue;
    if (areFactionsAllied(outflanker.faction, partner.faction)) return outflanker;
  }
  return null;
}
