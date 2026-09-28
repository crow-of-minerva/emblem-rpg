/** @layer foundry/adapters/dice */
import { HIT_CHANCE_MODELS } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { HIT_CHANCE_MODEL_SETTING, KARMA_LEDGER_SETTING } from '../../../config/settings.mjs';
import { planKarmaBookings } from '../../../game/rolls/checks.mjs';
import { isActiveGm } from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/** The ledger entry naming the model its debts were earned under. Every other entry is a karma group. */
const LEDGER_MODEL_KEY = 'model';

let ledgerTurns = Promise.resolve();

/* -------------------------------------------- */
/*  Karma ledger                                */
/* -------------------------------------------- */

/** A detached copy of the world's karma debts by faction group, beside the model they were earned under. */
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
 * Run karma reads, rolls and bookings on the host one at a time, so each check sees the previous booking's debt.
 * @param {Function} work The turn: it may read the ledger, roll, and write the ledger.
 * @returns {Promise<*>} What the turn returns. A failed turn rejects for its caller and frees the next turn.
 */
export function takeKarmaTurn(work) {
  const turn = ledgerTurns.then(() => work());
  ledgerTurns = turn.catch(error => { reportFoundryError(import.meta.url, error, 'karma-ledger-turn', null, false); });
  return turn;
}

/**
 * Persist the whole ledger with the model its debts were earned under. Only a karma turn writes it, so nothing it
 * read has changed underneath it.
 * @param {Record<string, number>} ledger Debts by karma group.
 * @param {string} [model] The model the debts were earned under: the world's current model, unless a karmic booking
 *   names the Karmic model it was decided under.
 * @returns {Promise<void>}
 */
export async function writeKarmaLedger(ledger, model = currentHitChanceModel()) {
  await game.settings.set(SYSTEM_ID, KARMA_LEDGER_SETTING, { ...ledger, [LEDGER_MODEL_KEY]: model });
}

/**
 * Book the operation's karma in order over the current ledger. Nothing is written, and the bookings come back
 * unbooked, when the world's model is no longer Karmic. The caller saves the ledger's old value:
 * FoundryCombatSettlementRepository.captureExchange already names the ledger setting in the exchange's opening
 * capture.
 * @param {ReadonlyArray<object>} bookings The operation's `KarmaBooking`s (game/rolls/checks.mjs), in order.
 * @returns {Promise<ReadonlyArray<object>>} Each booking with the debt it read and left over the ledger as it stood,
 *   marked `booked`.
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
 * Clear the luck earned under the old hit-chance model, on the command host.
 *
 * A world setting's change reaches every client, so every other client leaves the shared ledger alone. The cleared
 * ledger names the model it accrues under from now on.
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
