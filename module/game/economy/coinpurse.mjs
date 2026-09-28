/** @layer game/economy */
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';

/* -------------------------------------------- */
/*  Coinpurse vocabulary                        */
/* -------------------------------------------- */

/**
 * Item data for a new Coinpurse when neither the world nor any pack holds one (coinpurseTemplate in
 * foundry/adapters/document-writes/economy.mjs).
 */
export const FALLBACK_COINPURSE = Object.freeze({
  name: 'Coinpurse',
  type: 'Miscellaneous',
  img: 'icons/svg/coins.svg',
  system: Object.freeze({ itemType: 'Coinpurse', cost: 0 })
});

/** Whether an item's facts describe a Coinpurse, the Miscellaneous item whose cost is the gold it holds. */
export function isCoinpurseItem(item) {
  return String(item?.type ?? '') === 'Miscellaneous' && String(item?.itemType ?? '') === 'Coinpurse';
}

/** The gold a unit carries: the value of its first Coinpurse. */
export function carriedGold(items = []) {
  const purse = items.find(isCoinpurseItem);
  return purse ? Math.max(0, Math.floor(Number(purse.cost) || 0)) : 0;
}

/* -------------------------------------------- */
/*  Arrival reconciliation                      */
/* -------------------------------------------- */

/**
 * Plan how a carrier's purses fold together after one lands, for reconcileCoinpurse in engine/economy/trade.mjs.
 * A Convoy turns every purse into gp and deletes them. Any other carrier merges all the value into its first purse.
 * @param {{kind: string, gp?: number, purses: Array<{id: string, cost: number}>}} facts Carrier facts.
 * @returns {{ok: boolean, code: string, data: object}}
 */
export function planCoinpurseReconciliation(facts = {}) {
  const purses = (facts.purses ?? []).map(purse => ({ id: String(purse.id), cost: whole(purse.cost) }));
  if (String(facts.kind ?? '') === 'Convoy') {
    if (!purses.length) return accept(RESULT_CODES.COINPURSE_UNCHANGED);
    const gold = purses.reduce((sum, purse) => sum + purse.cost, 0);
    return accept(RESULT_CODES.COINPURSE_DISSOLVED, {
      deleteIds: Object.freeze(purses.map(purse => purse.id)),
      gold,
      gpAfter: whole(facts.gp) + gold
    });
  }
  if (purses.length < 2) return accept(RESULT_CODES.COINPURSE_UNCHANGED);
  const [keep, ...rest] = purses;
  const total = purses.reduce((sum, purse) => sum + purse.cost, 0);
  return accept(RESULT_CODES.COINPURSE_MERGED, {
    keepId: keep.id,
    deleteIds: Object.freeze(rest.map(purse => purse.id)),
    total,
    costChanged: keep.cost !== total
  });
}

/* -------------------------------------------- */
/*  Convoy withdrawals                          */
/* -------------------------------------------- */

/**
 * Calculate the Convoy and purse balances for convoyWithdraw in engine/economy/trade.mjs, refusing invalid or
 * unfunded amounts.
 * @param {{amount: number, convoyGp: number, purseValue: number}} facts Withdrawal facts.
 * @returns {{ok: boolean, code: string, data: object}}
 */
export function planConvoyWithdrawal({ amount, convoyGp, purseValue } = {}) {
  if (!Number.isSafeInteger(amount) || amount < 1) return refuse(RESULT_CODES.CONVOY_WITHDRAWAL_INVALID);
  if (!Number.isSafeInteger(convoyGp) || convoyGp < 0) return refuse(RESULT_CODES.CONVOY_WITHDRAWAL_INVALID);
  if (!Number.isSafeInteger(purseValue) || purseValue < 0) return refuse(RESULT_CODES.CONVOY_WITHDRAWAL_INVALID);
  if (amount > convoyGp) return refuse(RESULT_CODES.CONVOY_INSUFFICIENT_GOLD, { convoyGp });
  const purseAfter = purseValue + amount;
  if (!Number.isSafeInteger(purseAfter)) return refuse(RESULT_CODES.CONVOY_WITHDRAWAL_INVALID);
  return accept(RESULT_CODES.CONVOY_WITHDRAWN, {
    amount,
    balanceBefore: convoyGp,
    balanceAfter: convoyGp - amount,
    purseBefore: purseValue,
    purseAfter
  });
}

function whole(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}
