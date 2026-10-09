/** @layer game/rolls */
import { COMBAT_HIT_RESULTS, HIT_CHANCE_MODELS } from '../../contracts/domains/combat.mjs';
import { factionGroup, SKILL_BY_KEY, SKILL_RANK_DICE, skillRank, statBonus } from '../character/rules.mjs';
import { clamp, finite, finite as number } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Check vocabulary                            */
/* -------------------------------------------- */
/** The roll modes a check can be made in. */
export const CHECK_ROLL_MODES = Object.freeze(['standard', 'advantage', 'disadvantage']);

const ATTRIBUTE_KEYS = Object.freeze({
  might: 'mgt', mgt: 'mgt',
  agility: 'agi', agi: 'agi',
  technique: 'tqn', tqn: 'tqn',
  wit: 'wit',
  charisma: 'cha', cha: 'cha',
  def: 'def', defense: 'def',
  res: 'res', resistance: 'res'
});
const SAVE_DC_ATTRIBUTE_KEYS = Object.freeze({ mgt: 'mgt', agi: 'agi', tqn: 'tqn', wit: 'wit', cha: 'cha' });

/**
 * Statuses that take an attribute's own value out of the saving throws made with it. Restrained adds no Agi to Agi
 * saves, as it already adds no Agi to Evasion in game/character/compilation.mjs.
 */
const SAVE_ATTRIBUTES_WITHHELD_BY_STATUS = Object.freeze({ restrained: Object.freeze(['agi']) });

/* -------------------------------------------- */
/*  Skill checks                                */
/* -------------------------------------------- */
/** Calculate an authored skill-check DC from detached target attributes. */
export function calculateSkillCheckDifficulty(attributes, baseDc, targetAttribute = 'None') {
  const key = attributeKey(targetAttribute);
  return finite(baseDc) + (key ? finite(attributes?.[key]) : 0);
}

/** Build a skill-check plan for the Foundry dice adapter without rolling or reading live documents. */
export function buildSkillCheck(input = {}) {
  const skill = SKILL_BY_KEY[String(input.skillKey ?? '').toLowerCase()];
  if (!skill) return null;
  const mode = CHECK_ROLL_MODES.includes(input.mode) ? input.mode : 'standard';
  const rank = skillRank(input.rank);
  const rankDie = SKILL_RANK_DICE[rank];
  const bonus = statBonus(input.statValue);
  return checkPlan({
    kind: 'skill',
    skillKey: skill.key,
    skillLabel: skill.label,
    statKey: skill.stat,
    rank,
    rankDie,
    statBonus: bonus,
    actorType: String(input.actorType ?? 'Neutral'),
    blessed: input.blessed === true,
    mode,
    dc: nullableDc(input.dc)
  });
}

/* -------------------------------------------- */
/*  Saving throws                               */
/* -------------------------------------------- */
/** Resolve a supported save attribute to its Character schema key. */
function savingThrowAttributeKey(value) {
  if (!value || String(value).toLowerCase() === 'none') return null;
  return attributeKey(value);
}

/** Calculate an effect's saving-throw DC from detached caster attributes. */
export function calculateSavingThrowDifficulty(attributes, savingThrowDc = {}) {
  const rawAttribute = String(savingThrowDc.attribute ?? '').toLowerCase();
  const key = SAVE_DC_ATTRIBUTE_KEYS[rawAttribute] ?? null;
  return finite(savingThrowDc.base) + (key ? finite(attributes?.[key]) : 0);
}

/**
 * Shape a prepared unit's saving-throw modifiers from its flat `system.saves` bonuses and its `system.statuses`.
 * Each save key keeps its flat bonus, and `withheld` lists the attributes whose own value the unit adds to no save.
 * Item activation builds each target's `saveModifiers` here, so an activation's save and the confirm
 * window's forecast read the same modifiers.
 * @param {Record<string, number>} [saves] Flat save bonuses by attribute key.
 * @param {Record<string, boolean>} [statuses] The unit's compiled status flags.
 * @returns {Readonly<Record<string, number> & {withheld: ReadonlyArray<string>}>}
 */
export function projectSavingThrowModifiers(saves = {}, statuses = {}) {
  const modifiers = {};
  for (const [key, value] of Object.entries(saves ?? {})) modifiers[key] = finite(value);
  const withheld = new Set();
  for (const [status, attributes] of Object.entries(SAVE_ATTRIBUTES_WITHHELD_BY_STATUS)) {
    if (statuses?.[status] !== true) continue;
    for (const attribute of attributes) withheld.add(attribute);
  }
  modifiers.withheld = Object.freeze([...withheld]);
  return Object.freeze(modifiers);
}

/**
 * Build a saving-throw plan for the Foundry dice adapter from detached data. The attribute's own value is left out
 * when `saveModifiers.withheld` names it. Its flat save bonus and the advantage mode still apply.
 */
export function buildSavingThrow(input = {}) {
  const targetAttribute = String(input.targetAttribute ?? 'None');
  const attribute = savingThrowAttributeKey(targetAttribute);
  const withheld = Array.isArray(input.saveModifiers?.withheld) && input.saveModifiers.withheld.includes(attribute);
  const modifier = attribute
    ? (withheld ? 0 : finite(input.attributes?.[attribute])) + finite(input.saveModifiers?.[attribute])
    : 0;
  return checkPlan({
    kind: 'save',
    targetAttribute,
    attribute,
    modifier,
    actorType: String(input.actorType ?? 'Neutral'),
    blessed: input.blessed === true,
    mode: input.hasAdvantage === true ? 'advantage' : 'standard',
    dc: nullableDc(input.dc)
  });
}

/* -------------------------------------------- */
/*  Roll planning                               */
/* -------------------------------------------- */
/** Build the Foundry dice formula for a check under the selected hit-chance model. */
export function checkRollFormula(check, model = HIT_CHANCE_MODELS.TRUE_RANDOM, twoRnBump = 0) {
  const head = model === HIT_CHANCE_MODELS.TWO_RANDOM_NUMBERS
    ? `floor((2d20 + ${Number(twoRnBump) >= 0.5 ? 1 : 0}) / 2)`
    : '1d20';
  const dice = check.extraDice.map(faces => `1d${faces}`);
  const modifier = check.flatModifier
    ? (check.flatModifier < 0 ? ` - ${Math.abs(check.flatModifier)}` : ` + ${check.flatModifier}`)
    : '';
  return [head, ...dice].join(' + ') + modifier;
}

/** Pick the declared roll retained by standard, advantage, or disadvantage. */
function chooseCheckRoll(totals, mode) {
  if (totals.length < 2 || mode === 'standard') return 0;
  return mode === 'disadvantage'
    ? (totals[1] < totals[0] ? 1 : 0)
    : (totals[1] > totals[0] ? 1 : 0);
}

/** Resolve the Foundry dice adapter's totals using advantage mode and the strict DC comparison. */
export function resolveCheckTotals(totals, mode, dc = null) {
  const chosenIndex = chooseCheckRoll(totals, mode);
  const total = finite(totals[chosenIndex]);
  return Object.freeze({
    chosenIndex,
    total,
    success: Number.isFinite(dc) ? total > dc : null
  });
}

/**
 * The chance a check succeeds as declared, before any karma. It assumes a plain d20, even when the world uses the
 * two-random-numbers model. The dice adapter (foundry/adapters/dice/checks.mjs) books it on the karma ledger, and
 * the lock, crossing and item-activation previews show it.
 */
export function checkSuccessChance(check) {
  if (!Number.isFinite(check.dc)) return 0;
  const base = sumAtLeast([20, ...check.extraDice], check.dc + 1 - check.flatModifier);
  if (check.mode === 'advantage') return 1 - Math.pow(1 - base, 2);
  if (check.mode === 'disadvantage') return Math.pow(base, 2);
  return base;
}

/** The karma group a check books under, for foundry/adapters/dice/checks.mjs. An ungrouped faction is neutral. */
export function checkKarmaGroup(actorType) {
  return factionGroup(actorType) ?? 'neutral';
}

/** Decide how many hidden Karmic repetitions apply to one declared attempt. */
export function checkKarmicPull(debt, fractionalRoll) {
  const value = clamp(finite(debt), -3, 3);
  const magnitude = Math.abs(value);
  const attempts = Math.floor(magnitude) + (finite(fractionalRoll) < magnitude % 1 ? 1 : 0);
  return { attempts, keep: value < 0 ? 'low' : 'high' };
}

/** Calculate the next ledger debt for the Foundry check adapter after a meaningful roll. */
export function nextCheckKarmaDebt(currentDebt, chance, success) {
  const surprise = clamp(finite(chance), 0, 1) - (success ? 1 : 0);
  return clamp((finite(currentDebt) + surprise) * 0.75, -3, 3);
}

function checkPlan(data) {
  const extraDice = [];
  if (data.blessed) extraDice.push(4);
  if (data.rankDie) extraDice.push(data.rankDie);
  const flatModifier = data.kind === 'skill' ? data.statBonus : data.modifier;
  const plan = {
    ...data,
    extraDice: Object.freeze(extraDice),
    flatModifier,
    rollCount: data.mode === 'standard' ? 1 : 2
  };
  return Object.freeze({
    ...plan,
    formula: checkRollFormula(plan)
  });
}

/* -------------------------------------------- */
/*  Probability helpers                         */
/* -------------------------------------------- */
function sumAtLeast(diceSizes, threshold) {
  const minimum = diceSizes.length;
  const maximum = diceSizes.reduce((sum, faces) => sum + faces, 0);
  if (threshold <= minimum) return 1;
  if (threshold > maximum) return 0;

  let distribution = new Map([[0, 1]]);
  for (const faces of diceSizes) {
    const next = new Map();
    for (const [sum, probability] of distribution) {
      for (let face = 1; face <= faces; face += 1) {
        next.set(sum + face, (next.get(sum + face) ?? 0) + (probability / faces));
      }
    }
    distribution = next;
  }
  let probability = 0;
  for (const [sum, value] of distribution) {
    if (sum >= threshold) probability += value;
  }
  return probability;
}

function attributeKey(value) {
  return ATTRIBUTE_KEYS[String(value ?? '').toLowerCase()] ?? null;
}

/** A DC input as the rules read it: absent means no DC, a non-number means an invalid one. */
export function nullableDc(value) {
  if (value === null || value === undefined || value === '') return null;
  const dc = Number(value);
  return Number.isFinite(dc) ? dc : Number.NaN;
}

/* -------------------------------------------- */
/*  Attack checks                               */
/* -------------------------------------------- */

/** Resolve a d20 attack from dice already rolled, for rollAttack in projections/combat-exchange.mjs. */
export function resolveAttackCheck({
  accuracy,
  evasion,
  critChance,
  attempts,
  critRoll,
  advantage = false,
  disadvantage = false,
  blessed = false,
  model = HIT_CHANCE_MODELS.TRUE_RANDOM
}) {
  const rolls = normalizeAttempts(attempts, blessed);
  const opposed = advantage === true && disadvantage === true;
  const useAdvantage = advantage === true && !opposed;
  const useDisadvantage = disadvantage === true && !opposed;
  const totals = rolls.map(roll => roll.natural + roll.blessed + number(accuracy));
  const chosenIndex = chooseIndex(totals, useAdvantage, useDisadvantage);
  const natural = rolls[chosenIndex].natural;
  const total = totals[chosenIndex];
  const hit = total > number(evasion);
  const criticalChance = clamp(number(critChance), 0, 100);
  const criticalNatural = clamp(Math.floor(number(critRoll) || 100), 1, 100);
  const critical = hit && criticalNatural <= criticalChance;
  const chance = attackSuccessChance({ accuracy, evasion, blessed, advantage: useAdvantage,
    disadvantage: useDisadvantage });
  return Object.freeze({
    result: critical ? COMBAT_HIT_RESULTS.CRITICAL : hit ? COMBAT_HIT_RESULTS.HIT : COMBAT_HIT_RESULTS.MISS,
    natural,
    total,
    chosenIndex,
    naturals: Object.freeze(rolls.map(roll => roll.natural)),
    totals: Object.freeze(totals),
    blessedRolls: Object.freeze(rolls.map(roll => roll.blessed)),
    criticalNatural,
    hitChance: Math.round(chance * 100),
    promisedChance: chance,
    critChance: criticalChance,
    advantage: useAdvantage,
    disadvantage: useDisadvantage,
    blessed: blessed === true,
    model
  });
}

/** The chance of beating Evasion with a d20, Accuracy and an optional Blessed d4, assuming a plain d20 roll. */
function attackSuccessChance({ accuracy, evasion, blessed = false, advantage = false, disadvantage = false }) {
  const threshold = number(evasion) + 1 - number(accuracy);
  const dice = blessed === true ? [20, 4] : [20];
  let chance = sumAtLeast(dice, threshold);
  if (advantage === true && disadvantage !== true) chance = 1 - ((1 - chance) ** 2);
  else if (disadvantage === true && advantage !== true) chance **= 2;
  return chance;
}

/** Convert the dice adapter's two d20 rolls and rounding bump into the displayed natural result. */
export function twoRandomNumberNatural(first, second, bump) {
  const left = clamp(Math.floor(number(first) || 1), 1, 20);
  const right = clamp(Math.floor(number(second) || 1), 1, 20);
  const parityBump = number(bump) >= 0.5 ? 1 : 0;
  return Math.floor((left + right + parityBump) / 2);
}

/* -------------------------------------------- */
/*  Karmic model                                */
/* -------------------------------------------- */

/**
 * The next faction debt after an attack, for the booking rollAttack (foundry/adapters/projections/combat-exchange.mjs)
 * makes and for planKarmaBookings.
 */
export function nextKarmaDebt(currentDebt, promisedChance, success) {
  const surprise = clamp(number(promisedChance), 0, 1) - (success ? 1 : 0);
  return clamp((number(currentDebt) + surprise) * 0.75, -3, 3);
}

/**
 * One karmic roll's booking on the karma ledger. An exchange keeps its attacks' bookings in order
 * (engine/combat/exchanges/blows.mjs) until it commits, when bookKarmaSequence in foundry/adapters/dice/karma.mjs
 * writes them. A skill check (foundry/adapters/dice/checks.mjs) books its own as it rolls. `before` and `after` are
 * reported in the result. If the action is rolled back, the saved ledger is restored as a whole.
 * @typedef {object} KarmaBooking
 * @property {string} key The karma group booked: `player`, `enemy` or `neutral`.
 * @property {number} chance The success chance the attempt was promised, from 0 to 1.
 * @property {boolean} success Whether the attempt succeeded.
 * @property {number} before The group's debt the booking read.
 * @property {number} after The group's debt the booking left.
 * @property {boolean} [booked] True once the ledger holds the booking, false when it was refused.
 */

/**
 * Replay an exchange's bookings in order over the ledger as it stands now, for bookKarmaSequence in
 * foundry/adapters/dice/karma.mjs when the exchange commits. Each booking reads the debt the one before it left.
 * @param {Record<string, number>} ledger Persisted debts by karma group.
 * @param {ReadonlyArray<KarmaBooking>} bookings The exchange's bookings, in order.
 * @returns {Readonly<{debts: Readonly<Record<string, number>>, bookings: ReadonlyArray<KarmaBooking>}>} The groups
 *   the bookings touched at their replayed debt, and each booking with the debt it read and left in that replay.
 */
export function planKarmaBookings(ledger = {}, bookings = []) {
  const debts = {};
  const planned = [];
  for (const booking of bookings ?? []) {
    const key = String(booking?.key ?? '');
    if (!key) continue;
    const before = Object.hasOwn(debts, key) ? debts[key] : finite(ledger?.[key]);
    debts[key] = nextKarmaDebt(before, booking.chance, booking.success === true);
    planned.push(Object.freeze({ ...booking, key, before, after: debts[key] }));
  }
  return Object.freeze({ debts: Object.freeze(debts), bookings: Object.freeze(planned) });
}

/**
 * The debts planKarmaBookings leaves for the groups the bookings touch.
 * foundry/adapters/projections/combat-exchange.mjs reads them so each attack rolls against the debt the exchange's
 * earlier attacks left.
 */
export function replayKarmaBookings(ledger = {}, bookings = []) {
  return planKarmaBookings(ledger, bookings).debts;
}

/* -------------------------------------------- */
/*  Value helpers                               */
/* -------------------------------------------- */

function normalizeAttempts(value, blessed) {
  const supplied = Array.isArray(value) ? value : [value];
  const attempts = supplied.filter(entry => entry !== undefined).map(entry => {
    const object = entry && typeof entry === 'object' ? entry : { natural: entry };
    return {
      natural: clamp(Math.floor(number(object.natural) || 1), 1, 20),
      blessed: blessed === true ? clamp(Math.floor(number(object.blessed) || 1), 1, 4) : 0
    };
  });
  return attempts.length ? attempts : [{ natural: 1, blessed: blessed ? 1 : 0 }];
}

function chooseIndex(totals, advantage, disadvantage) {
  if (totals.length < 2) return 0;
  if (advantage) return totals[1] > totals[0] ? 1 : 0;
  if (disadvantage) return totals[1] < totals[0] ? 1 : 0;
  return 0;
}
