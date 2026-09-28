/** @layer foundry/adapters/dice */
import { HIT_CHANCE_MODELS } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { KARMA_LEDGER_SETTING } from '../../../config/settings.mjs';
import {
  checkKarmaGroup,
  checkKarmicPull,
  checkRollFormula,
  checkSuccessChance,
  nextCheckKarmaDebt,
  resolveCheckTotals
} from '../../../game/rolls/checks.mjs';
import {
  currentHitChanceModel, readKarmaLedger, resetKarmaLedger, takeKarmaTurn, writeKarmaLedger
} from './karma.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

const MAX_STORED_ROLLS = 100;
let rollSequence = 0;

/* -------------------------------------------- */
/*  Character check rolling                     */
/* -------------------------------------------- */
/**
 * Roll characters' checks with Foundry dice on the host and return plain facts. The Roll objects stay here under
 * their rollReference until the chat card writer (document-writes/chat-output.mjs) takes them with takeRolls.
 */
export class FoundryCharacterCheckService {
  #storedRolls = new Map();

  /**
   * Roll one declared check on the host.
   *
   * A karmic check reads its debt, rolls and books the ledger in one karma turn, so the next check, from this
   * operation or any other, decides from the debt this one left. Its returned booking is marked as already booked.
   * @param {string} actorUuid The rolling Actor.
   * @param {object} check The declared check from game/rolls/checks.mjs.
   * @param {{requestId?: string, operation?: object|null}} [context] The command's dispatcher operation, which
   *   captures the karma ledger setting before a karmic booking rewrites it.
   */
  async roll(actorUuid, check, { requestId = '', operation = null } = {}) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') throw new Error('Actor no longer exists.');
    const model = Number.isFinite(check.dc) ? currentHitChanceModel() : HIT_CHANCE_MODELS.TRUE_RANDOM;
    const chance = checkSuccessChance(check);
    const { attempt, karmaBooking } = model === HIT_CHANCE_MODELS.KARMIC && chance > 0 && chance < 1
      ? await takeKarmaTurn(() => karmicAttempt(check, model, chance, operation))
      : { attempt: await declaredAttempt(check, model), karmaBooking: null };

    const rollReference = `${String(requestId || 'check').slice(0, 160)}:${++rollSequence}`;
    this.#storedRolls.set(rollReference, presentedRolls(attempt.rolls, attempt.summaries, model));
    while (this.#storedRolls.size > MAX_STORED_ROLLS) {
      this.#storedRolls.delete(this.#storedRolls.keys().next().value);
    }
    return Object.freeze({
      actorUuid,
      actorName: actor.name,
      model,
      rolls: Object.freeze(attempt.summaries),
      chosenIndex: attempt.resolution.chosenIndex,
      natural: attempt.summaries[attempt.resolution.chosenIndex].natural,
      total: attempt.resolution.total,
      success: attempt.resolution.success,
      rollReference,
      karmaBooking
    });
  }

  takeRolls(reference) {
    const rolls = this.#storedRolls.get(reference) ?? [];
    this.#storedRolls.delete(reference);
    return rolls;
  }
}

async function declaredAttempt(check, model) {
  const rolls = [];
  const summaries = [];
  for (let index = 0; index < check.rollCount; index += 1) {
    const roll = await new Roll(checkRollFormula(check, model, Math.random())).evaluate();
    rolls.push(roll);
    summaries.push(summarizeRoll(roll, check));
  }
  const resolution = resolveCheckTotals(summaries.map(entry => entry.total), check.mode, check.dc);
  return { rolls, summaries, resolution };
}

function summarizeRoll(roll, check) {
  const extras = roll.dice.slice(1).map(die => Number(die.total) || 0);
  const total = Number(roll.total) || 0;
  return Object.freeze({
    total,
    natural: total - extras.reduce((sum, value) => sum + value, 0) - check.flatModifier,
    extraDice: Object.freeze(extras)
  });
}

function presentedRolls(rolls, summaries, model) {
  if (model !== HIT_CHANCE_MODELS.TWO_RANDOM_NUMBERS) return rolls;
  return rolls.map((roll, index) => {
    const clone = Roll.fromJSON(JSON.stringify(roll.toJSON()));
    const die = clone.dice?.[0];
    if (!die) return roll;
    die.number = 1;
    die.results = [{ result: Math.min(20, Math.max(1, Math.round(summaries[index].natural))), active: true }];
    return clone;
  });
}

/**
 * Decide one karmic check from the debt the ledger holds now, roll it, and book the result, all in one karma turn.
 * The draws keep their original order: the declared attempt, then the pull, then any pulled attempts.
 */
async function karmicAttempt(check, model, chance, operation) {
  const ledger = readKarmaLedger();
  const key = checkKarmaGroup(check.actorType);
  const debt = Number(ledger[key]) || 0;
  let attempt = await declaredAttempt(check, model);
  const pull = checkKarmicPull(debt, Math.random());
  for (let index = 0; index < pull.attempts; index += 1) {
    const next = await declaredAttempt(check, model);
    const wins = pull.keep === 'high'
      ? next.resolution.total > attempt.resolution.total
      : next.resolution.total < attempt.resolution.total;
    if (wins) attempt = next;
  }
  const success = attempt.resolution.success === true;
  const after = roundedDebt(nextCheckKarmaDebt(debt, chance, success));
  await captureKarmaLedger(operation);
  await writeKarmaLedger({ ...ledger, [key]: after }, model);
  return { attempt, karmaBooking: Object.freeze({ key, chance, success, before: debt, after, booked: true }) };
}

/**
 * Save the ledger's current value in the command's operation before a booking rewrites it. A command that already
 * captured the setting when it opened (a movement crossing or a downtime activity, in document-writes/movement.mjs
 * and downtime.mjs) adds nothing here and performs no extra save.
 */
function captureKarmaLedger(operation) {
  return operation?.capture({ settings: [KARMA_LEDGER_SETTING] });
}

function roundedDebt(debt) {
  return Math.round(debt * 1000) / 1000;
}

/** Clear luck earned under the old model when the world's hit-chance model changes. Only the host clears it. */
export async function onHitChanceModelChanged() {
  try {
    await resetKarmaLedger();
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | failed to clear the karma ledger after a model change.`);
  }
}
