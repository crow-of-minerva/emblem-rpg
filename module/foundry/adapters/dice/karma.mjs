/** @layer foundry/adapters/dice */
import { HIT_CHANCE_MODELS } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { HIT_CHANCE_MODEL_SETTING, KARMA_LEDGER_SETTING } from '../../../config/settings.mjs';
import { planKarmaBookings } from '../../../game/rolls/checks.mjs';
import { isActiveGm } from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/** The ledger entry naming the model its debts were earned under. Every other entry is one faction group's debt. */
const LEDGER_MODEL_KEY = 'model';

let ledgerTurns = Promise.resolve();

/* -------------------------------------------- */
/*  Karma ledger                                */
/* -------------------------------------------- */

/**
 * A detached copy of the world's karma debts by faction group, beside the model they were earned under. A positive
 * debt means the group is owed good luck after unlikely failures; a negative one, bad luck after unlikely successes.
 */
export function readKarmaLedger() {
  const value = game.settings.get(SYSTEM_ID, KARMA_LEDGER_SETTING);
  return value && typeof value === 'object' ? structuredClone(value) : {};
}

/** The world's hit-chance model, read as Karmic while the setting holds no model it knows. */
export function currentHitChanceModel() {
  const value = String(game.settings.get(SYSTEM_ID, HIT_CHANCE_MODEL_SETTING) ?? '');
  return Object.values(HIT_CHANCE_MODELS).includes(value) ? value : HIT_CHANCE_MODELS.KARMIC;
}

/**
 * Run ledger reads, rolls and writes on the host one at a time, so each check sees the debt the previous one left.
 * @param {Function} work The queued step: it may read the ledger, roll, and write the ledger.
 * @returns {Promise<*>} What the step returns. A failed step rejects for its caller and lets the next one run.
 */
export function takeKarmaTurn(work) {
  const turn = ledgerTurns.then(() => work());
  ledgerTurns = turn.catch(error => { reportFoundryError(import.meta.url, error, 'karma-ledger-turn', null, false); });
  return turn;
}

/**
 * Save the whole ledger with the model its debts were earned under. Only called inside takeKarmaTurn, so the ledger
 * it read can't have changed since.
 * @param {Record<string, number>} ledger Debts by faction group.
 * @param {string} [model] The model the debts were earned under: the world's current model, unless the caller names
 *   the model a karmic roll was decided under.
 * @returns {Promise<void>}
 */
export async function writeKarmaLedger(ledger, model = currentHitChanceModel()) {
  await game.settings.set(SYSTEM_ID, KARMA_LEDGER_SETTING, { ...ledger, [LEDGER_MODEL_KEY]: model });
}

/**
 * Apply a command's karma results in order to the current ledger and save it. When the world's model is no longer
 * Karmic, nothing is written and the results come back with `booked: false`. The caller records the ledger's old
 * value for undo.
 * @param {ReadonlyArray<object>} bookings The command's `KarmaBooking`s (game/rolls/checks.mjs), in order.
 * @returns {Promise<ReadonlyArray<object>>} Each booking with the debt it read and left, marked `booked`.
 */
export async function bookKarmaSequence(bookings = []) {
  if (!bookings?.length) return Object.freeze([]);
  return takeKarmaTurn(async () => {
    const ledger = readKarmaLedger();
    const plan = planKarmaBookings(ledger, bookings);
    const booked = currentHitChanceModel() === HIT_CHANCE_MODELS.KARMIC;
    if (booked) await writeKarmaLedger({ ...ledger, ...plan.debts }, HIT_CHANCE_MODELS.KARMIC);
    return Object.freeze(plan.bookings.map(booking => Object.freeze({ ...booking, booked })));
  });
}

/**
 * Clear the luck earned under the old hit-chance model, on the host client.
 *
 * The ledger is a world setting, so only the host clears it and the other clients receive the change. The cleared
 * ledger records the current model.
 * @returns {Promise<boolean>} Whether this client cleared it.
 */
export async function resetKarmaLedger() {
  if (!isActiveGm()) return false;
  return takeKarmaTurn(async () => {
    await writeKarmaLedger({});
    return true;
  });
}

/**
 * At host startup, clear karma earned under another hit-chance model, or one the ledger doesn't record.
 * @returns {Promise<boolean>} Whether this client cleared the ledger.
 */
export async function reconcileKarmaLedgerModel() {
  if (!isActiveGm()) return false;
  return takeKarmaTurn(async () => {
    const model = currentHitChanceModel();
    if (readKarmaLedger()[LEDGER_MODEL_KEY] === model) return false;
    await writeKarmaLedger({}, model);
    return true;
  });
}
