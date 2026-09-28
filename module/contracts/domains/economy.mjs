/** @layer contracts/domains */
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
export const TRADE_MODES = Object.freeze({ TRADE: 'trade', LOOT: 'loot', STEAL: 'steal' });

/** The skill a theft is rolled with, and the one the thief gains experience in (engine/economy/trade.mjs). */
export const STEAL_SKILL_KEY = 'finesse';

/** The skill a haggle is rolled with, and the one the haggling unit gains experience in (engine/economy/trade.mjs). */
export const HAGGLE_SKILL_KEY = 'trading';

/** Item name used by the hotbar and theft command to identify Steal. */
export const STEAL_ABILITY_NAME = 'Steal';

/** How a convoy's gold marks itself on the drag it starts, so a sheet can tell a handful of currency from an item. */
export const CONVOY_GOLD_DRAG_TYPE = 'EmblemConvoyGold';

/**
 * The Item flag marking a Convoy's inbound Item, `flags['emblem-rpg'].inbound === true`: owned by the Convoy but not
 * yet delivered, so no gameplay reader of Convoy items sees it until staff deliver it (game/economy/inbound.mjs).
 */
export const CONVOY_INBOUND_FLAG = 'inbound';

/** Maximum stack quantity accepted by economy request normalizers. */
const MAX_TRANSFER_QUANTITY = 9999;

/**
 * The resource key trade commands list with their actors' keys (engine/economy/trade.mjs). Like every resource key,
 * it only records what the command touches. There is no ledger behind it.
 */
export const ECONOMY_LEDGER_RESOURCE_KEY = 'economy:ledger';

/** Not read anywhere: no economy ledger records exist. */
export const ECONOMY_LEDGER_STATES = Object.freeze({
  SETTLING: 'settling',
  COMMITTED: 'committed',
  RECOVERY_REQUIRED: 'recovery-required'
});

/**
 * What an economy settlement write reports (foundry/adapters/document-writes/economy.mjs): settled, stale (nothing
 * written) or reverted (undone after a failed write). No writer produces `blocked` or `recovery-required`.
 */
export const ECONOMY_SETTLEMENT_OUTCOMES = Object.freeze({
  SETTLED: 'settled',
  STALE: 'stale',
  BLOCKED: 'blocked',
  REVERTED: 'reverted',
  RECOVERY_REQUIRED: 'recovery-required'
});

/** Not read anywhere: there is no economy ledger to cap. */
export const ECONOMY_LEDGER_CAPACITY = 64;

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
/** Maximum items per side accepted by the trade and theft request normalizers. */
const TRADE_MAX_ITEMS = 24;
const MAX_UUID_LENGTH = 512;
const TRADE_INTENT_KEYS = ['sourceTokenUuid', 'targetTokenUuid', 'giveItemIds', 'takeItemIds'];
const STEAL_INTENT_KEYS = ['sourceTokenUuid', 'targetTokenUuid', 'itemIds'];
const CONVOY_DEPOSIT_INTENT_KEYS = ['sourceActorUuid', 'itemId', 'convoyUuid'];
const CONVOY_WITHDRAWAL_INTENT_KEYS = ['targetActorUuid', 'convoyUuid', 'amount'];
const VENDOR_STOCK_INTENT_KEYS = ['sourceActorUuid', 'itemId', 'vendorUuid'];
const VENDOR_PURCHASE_INTENT_KEYS = [
  'buyerActorUuid', 'buyerTokenUuid', 'vendorUuid', 'vendorTokenUuid', 'itemId', 'destinationUuid', 'quantity'
];
const VENDOR_SALE_INTENT_KEYS = [
  'sellerActorUuid', 'buyerTokenUuid', 'vendorUuid', 'vendorTokenUuid', 'itemId', 'sourceUuid', 'quantity'
];
const SHOP_INTENT_KEYS = ['buyerTokenUuid', 'vendorTokenUuid'];
const VENDOR_MERCHANDISE_INTENT_KEYS = ['vendorUuid', 'changes'];
const MERCHANDISE_PATH = /^system\.(acceptedMerchandise|disposition)(\.[A-Za-z]+){0,3}$/;
const DOCUMENT_ID = /^[A-Za-z0-9]{8,32}$/;

/** Bound one trade or loot request: two placed Tokens and the embedded Item ids leaving each side. */
export function normalizeTradeIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, TRADE_INTENT_KEYS)) return null;
  const sourceTokenUuid = tokenUuid(payload.sourceTokenUuid);
  const targetTokenUuid = tokenUuid(payload.targetTokenUuid);
  const giveItemIds = idList(payload.giveItemIds);
  const takeItemIds = idList(payload.takeItemIds);
  if (!sourceTokenUuid || !targetTokenUuid || !giveItemIds || !takeItemIds) return null;
  if (sourceTokenUuid === targetTokenUuid) return null;
  if (giveItemIds.length + takeItemIds.length === 0) return null;
  return Object.freeze({ sourceTokenUuid, targetTokenUuid, giveItemIds, takeItemIds });
}

/** Bound the two placed Tokens a trade view is read for, before anything is selected. */
export function normalizeTradePair(payload) {
  if (!plainRecord(payload)) return null;
  const sourceTokenUuid = tokenUuid(payload.sourceTokenUuid);
  const targetTokenUuid = tokenUuid(payload.targetTokenUuid);
  if (!sourceTokenUuid || !targetTokenUuid || sourceTokenUuid === targetTokenUuid) return null;
  return Object.freeze({ sourceTokenUuid, targetTokenUuid });
}

/** Bound one steal request: the thief, the mark, and what is reached for. */
export function normalizeStealIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, STEAL_INTENT_KEYS)) return null;
  const sourceTokenUuid = tokenUuid(payload.sourceTokenUuid);
  const targetTokenUuid = tokenUuid(payload.targetTokenUuid);
  const itemIds = idList(payload.itemIds);
  if (!sourceTokenUuid || !targetTokenUuid || !itemIds?.length) return null;
  if (sourceTokenUuid === targetTokenUuid) return null;
  return Object.freeze({ sourceTokenUuid, targetTokenUuid, itemIds });
}

/** Bound one convoy deposit: the unit giving, the Item leaving it, the Convoy it goes to, and how many units. */
export function normalizeConvoyDepositIntent(payload) {
  if (!plainRecord(payload)) return null;
  const { amount: rawAmount, ...rest } = payload;
  if (!exactKeys(rest, CONVOY_DEPOSIT_INTENT_KEYS)) return null;
  const sourceActorUuid = actorUuid(payload.sourceActorUuid);
  const convoyUuid = actorUuid(payload.convoyUuid);
  const itemId = String(payload.itemId ?? '');
  if (!sourceActorUuid || !convoyUuid || sourceActorUuid === convoyUuid || !DOCUMENT_ID.test(itemId)) return null;
  const amount = optionalQuantity(rawAmount);
  if (amount === undefined) return null;
  return Object.freeze({ sourceActorUuid, itemId, convoyUuid, amount });
}

const CONVOY_DELIVERY_INTENT_KEYS = ['convoyUuid', 'itemIds', 'gold', 'all'];

/**
 * Bound one staff delivery of a Convoy's inbound content: the Convoy, the inbound Item ids chosen, whether the
 * inbound gold goes too, and whether everything goes. An empty selection passes here. planConvoyDelivery in
 * game/economy/inbound.mjs then finds nothing to deliver, and the command refuses it as empty.
 */
export function normalizeConvoyDeliveryIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, CONVOY_DELIVERY_INTENT_KEYS)) return null;
  const convoyUuid = actorUuid(payload.convoyUuid);
  const itemIds = idList(payload.itemIds ?? []);
  if (!convoyUuid || !itemIds) return null;
  for (const key of ['gold', 'all']) {
    if (payload[key] !== undefined && typeof payload[key] !== 'boolean') return null;
  }
  return Object.freeze({ convoyUuid, itemIds, gold: payload.gold === true, all: payload.all === true });
}

/** Bound one vendor stocking: a GM moving one of a unit's possessions onto a Vendor's shelf, optionally counted. */
export function normalizeVendorStockIntent(payload) {
  if (!plainRecord(payload)) return null;
  const { amount: rawAmount, ...rest } = payload;
  if (!exactKeys(rest, VENDOR_STOCK_INTENT_KEYS)) return null;
  const sourceActorUuid = actorUuid(payload.sourceActorUuid);
  const vendorUuid = actorUuid(payload.vendorUuid);
  const itemId = String(payload.itemId ?? '');
  if (!sourceActorUuid || !vendorUuid || sourceActorUuid === vendorUuid || !DOCUMENT_ID.test(itemId)) return null;
  const amount = optionalQuantity(rawAmount);
  if (amount === undefined) return null;
  return Object.freeze({ sourceActorUuid, itemId, vendorUuid, amount });
}

/** Bound one convoy withdrawal: the unit receiving, the Convoy paying, and a whole number of gold of at least 1. */
export function normalizeConvoyWithdrawalIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, CONVOY_WITHDRAWAL_INTENT_KEYS)) return null;
  const targetActorUuid = actorUuid(payload.targetActorUuid);
  const convoyUuid = actorUuid(payload.convoyUuid);
  const amount = payload.amount;
  if (!targetActorUuid || !convoyUuid || targetActorUuid === convoyUuid) return null;
  if (!Number.isSafeInteger(amount) || amount < 1) return null;
  return Object.freeze({ targetActorUuid, convoyUuid, amount });
}

/** Bound the two placed Tokens a shop is read for: the unit at the counter and the Vendor it stands beside. */
export function normalizeShopIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, SHOP_INTENT_KEYS)) return null;
  const buyerTokenUuid = tokenUuid(payload.buyerTokenUuid);
  const vendorTokenUuid = tokenUuid(payload.vendorTokenUuid);
  if (!buyerTokenUuid || !vendorTokenUuid || buyerTokenUuid === vendorTokenUuid) return null;
  return Object.freeze({ buyerTokenUuid, vendorTokenUuid });
}

/**
 * Bound one purchase: the buyer and its Token, the shop and its Token, the shelf entry, how many, and the Convoy
 * it may be delivered to. The Tokens are named so the host can check that the two still stand together.
 */
export function normalizeVendorPurchaseIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, VENDOR_PURCHASE_INTENT_KEYS)) return null;
  const buyerActorUuid = actorUuid(payload.buyerActorUuid);
  const vendorUuid = actorUuid(payload.vendorUuid);
  const buyerTokenUuid = tokenUuid(payload.buyerTokenUuid);
  const vendorTokenUuid = tokenUuid(payload.vendorTokenUuid);
  const itemId = String(payload.itemId ?? '');
  const destinationUuid = payload.destinationUuid ? actorUuid(payload.destinationUuid) : '';
  if (!buyerActorUuid || !vendorUuid || buyerActorUuid === vendorUuid || !DOCUMENT_ID.test(itemId)) return null;
  if (!buyerTokenUuid || !vendorTokenUuid || buyerTokenUuid === vendorTokenUuid) return null;
  if (payload.destinationUuid && !destinationUuid) return null;
  const quantity = requiredQuantity(payload.quantity);
  if (quantity === undefined) return null;
  return Object.freeze({
    buyerActorUuid, buyerTokenUuid, vendorUuid, vendorTokenUuid, itemId, destinationUuid, quantity
  });
}

/** Bound one sale: the seller and its Token, the shop and its Token, where the goods come from, the Item, how many. */
export function normalizeVendorSaleIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, VENDOR_SALE_INTENT_KEYS)) return null;
  const sellerActorUuid = actorUuid(payload.sellerActorUuid);
  const vendorUuid = actorUuid(payload.vendorUuid);
  const buyerTokenUuid = tokenUuid(payload.buyerTokenUuid);
  const vendorTokenUuid = tokenUuid(payload.vendorTokenUuid);
  const itemId = String(payload.itemId ?? '');
  const sourceUuid = payload.sourceUuid ? actorUuid(payload.sourceUuid) : '';
  if (!sellerActorUuid || !vendorUuid || sellerActorUuid === vendorUuid || !DOCUMENT_ID.test(itemId)) return null;
  if (!buyerTokenUuid || !vendorTokenUuid || buyerTokenUuid === vendorTokenUuid) return null;
  if (payload.sourceUuid && !sourceUuid) return null;
  const quantity = requiredQuantity(payload.quantity);
  if (quantity === undefined) return null;
  return Object.freeze({
    sellerActorUuid, buyerTokenUuid, vendorUuid, vendorTokenUuid, itemId, sourceUuid, quantity
  });
}

const VENDOR_CHECKOUT_INTENT_KEYS = [
  'mode', 'buyerActorUuid', 'buyerTokenUuid', 'vendorUuid', 'vendorTokenUuid', 'holdingUuid', 'lines'
];
const VENDOR_CHECKOUT_LINE_KEYS = ['itemId', 'quantity'];
export const VENDOR_CHECKOUT_MODES = Object.freeze({ BUY: 'buy', SELL: 'sell' });
const VENDOR_CHECKOUT_MAX_LINES = TRADE_MAX_ITEMS;

/** Bound one basket: the mode, the pair at the counter, the Convoy paying or supplying, and its distinct lines. */
export function normalizeVendorCheckoutIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, VENDOR_CHECKOUT_INTENT_KEYS)) return null;
  if (!Object.values(VENDOR_CHECKOUT_MODES).includes(payload.mode)) return null;
  const buyerActorUuid = actorUuid(payload.buyerActorUuid);
  const vendorUuid = actorUuid(payload.vendorUuid);
  const buyerTokenUuid = tokenUuid(payload.buyerTokenUuid);
  const vendorTokenUuid = tokenUuid(payload.vendorTokenUuid);
  const holdingUuid = payload.holdingUuid ? actorUuid(payload.holdingUuid) : '';
  if (!buyerActorUuid || !vendorUuid || buyerActorUuid === vendorUuid) return null;
  if (!buyerTokenUuid || !vendorTokenUuid || buyerTokenUuid === vendorTokenUuid) return null;
  if (payload.holdingUuid && !holdingUuid) return null;
  const lines = checkoutLines(payload.lines);
  if (!lines) return null;
  return Object.freeze({
    mode: payload.mode, buyerActorUuid, buyerTokenUuid, vendorUuid, vendorTokenUuid, holdingUuid, lines
  });
}

/** The single-line payload one basket line settles through, shaped as the purchase or sale command reads it. */
export function vendorCheckoutLinePayload(intent, itemId, quantity) {
  const counter = {
    buyerTokenUuid: intent.buyerTokenUuid, vendorUuid: intent.vendorUuid, vendorTokenUuid: intent.vendorTokenUuid,
    itemId, quantity
  };
  return intent.mode === VENDOR_CHECKOUT_MODES.SELL
    ? { sellerActorUuid: intent.buyerActorUuid, sourceUuid: intent.holdingUuid, ...counter }
    : { buyerActorUuid: intent.buyerActorUuid, destinationUuid: intent.holdingUuid, ...counter };
}

function checkoutLines(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > VENDOR_CHECKOUT_MAX_LINES) return null;
  const lines = [];
  for (const entry of value) {
    if (!plainRecord(entry) || !exactKeys(entry, VENDOR_CHECKOUT_LINE_KEYS)) return null;
    const itemId = String(entry.itemId ?? '');
    const quantity = requiredQuantity(entry.quantity);
    if (!DOCUMENT_ID.test(itemId) || quantity === undefined || lines.some(line => line.itemId === itemId)) return null;
    lines.push(Object.freeze({ itemId, quantity }));
  }
  return Object.freeze(lines);
}

const HAGGLE_INTENT_KEYS = ['buyerActorUuid', 'buyerTokenUuid', 'vendorUuid', 'vendorTokenUuid'];

/**
 * Bound one haggle: the unit at the counter and its Token, and the Vendor and its Token. The Tokens are named so the
 * host can check that the two still stand together, as a basket does.
 */
export function normalizeHaggleIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, HAGGLE_INTENT_KEYS)) return null;
  const buyerActorUuid = actorUuid(payload.buyerActorUuid);
  const vendorUuid = actorUuid(payload.vendorUuid);
  const buyerTokenUuid = tokenUuid(payload.buyerTokenUuid);
  const vendorTokenUuid = tokenUuid(payload.vendorTokenUuid);
  if (!buyerActorUuid || !vendorUuid || buyerActorUuid === vendorUuid) return null;
  if (!buyerTokenUuid || !vendorTokenUuid || buyerTokenUuid === vendorTokenUuid) return null;
  return Object.freeze({ buyerActorUuid, buyerTokenUuid, vendorUuid, vendorTokenUuid });
}

/** Bound a merchandise-settings write: a Vendor and the flat dot-path changes the dialog produced. */
export function normalizeVendorMerchandiseIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, VENDOR_MERCHANDISE_INTENT_KEYS)) return null;
  const vendorUuid = actorUuid(payload.vendorUuid);
  if (!vendorUuid || !plainRecord(payload.changes)) return null;
  const changes = {};
  for (const [path, value] of Object.entries(payload.changes)) {
    if (!MERCHANDISE_PATH.test(path)) return null;
    if (typeof value !== 'boolean' && typeof value !== 'string' && !Number.isFinite(Number(value))) return null;
    changes[path] = typeof value === 'boolean' || typeof value === 'string' ? value : Number(value);
  }
  if (!Object.keys(changes).length) return null;
  return Object.freeze({ vendorUuid, changes: Object.freeze(changes) });
}

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */
/** Theft timings: the wait for the dice, and the pause on the verdict. The engine waits on its own clock. */
export const STEAL_ATTEMPT_TIMING = Object.freeze({ diceSettleHold: 2600, verdictHold: 500 });

/** Haggle timing: the wait for the Trading check's dice before the shift settles. The engine waits on its own clock. */
export const HAGGLE_TIMING = Object.freeze({ diceSettleHold: 2600 });

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
const MAX_PRESENTATION_MESSAGE_LENGTH = 8192;

export const ECONOMY_PRESENTATION_KIND = 'economy-exchange';

export const ECONOMY_PRESENTATION_EVENTS = Object.freeze({
  STEAL_SUCCEEDED: 'steal-succeeded',
  STEAL_FAILED: 'steal-failed',
  SHOP_SETTLED: 'shop-settled',
  HAGGLE_SETTLED: 'haggle-settled'
});

/** Build the verdict the active GM broadcasts: a theft's cue and card, a basket's receipt, or a haggle's card. */
export function economyPresentationMessage(event, data = {}) {
  if (!Object.values(ECONOMY_PRESENTATION_EVENTS).includes(event)) {
    throw new TypeError(`Unknown economy presentation event: ${event}`);
  }
  return Object.freeze({ kind: ECONOMY_PRESENTATION_KIND, event, ...structuredClone(data) });
}

/**
 * Accept only bounded economy feedback at the presentation socket. A theft or a receipt carries its item list; a
 * haggle's card carries the numbers EconomyOutcomePresentation prints instead (presentation/interface/chat-cards.mjs).
 */
export function isEconomyPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== ECONOMY_PRESENTATION_KIND) return false;
  if (!Object.values(ECONOMY_PRESENTATION_EVENTS).includes(value.event)) return false;
  if (!actorUuid(value.actorUuid)) return false;
  const bounded = value.event === ECONOMY_PRESENTATION_EVENTS.HAGGLE_SETTLED
    ? haggleCardBounded(value)
    : itemsBounded(value.items);
  if (!bounded) return false;
  try { return JSON.stringify(value).length <= MAX_PRESENTATION_MESSAGE_LENGTH; } catch { return false; }
}

const MAX_CARD_TEXT = 1024;
const HAGGLE_CARD_TEXT = ['actorName', 'actorImage', 'vendorName', 'vendorImage'];
const HAGGLE_CARD_NUMBERS = ['avatarScale', 'total', 'dispositionBefore', 'dispositionAfter'];

/** The disposition shifts a haggle can produce, the ends of the band table in game/economy/haggle.mjs. */
const HAGGLE_SHIFT_RANGE = Object.freeze({ min: -1, max: 7 });

function itemsBounded(items) {
  if (!Array.isArray(items) || items.length > TRADE_MAX_ITEMS) return false;
  return !items.some(item => !plainRecord(item) || !boundedText(String(item.name ?? ''), MAX_UUID_LENGTH));
}

/** A haggle card's texts are optional strings, its numbers finite, and its shift a whole step the band table allows. */
function haggleCardBounded(value) {
  if (!HAGGLE_CARD_TEXT.every(key => optionalCardText(value[key]))) return false;
  if (!HAGGLE_CARD_NUMBERS.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))) return false;
  const { shift } = value;
  return Number.isInteger(shift) && shift >= HAGGLE_SHIFT_RANGE.min && shift <= HAGGLE_SHIFT_RANGE.max;
}

function optionalCardText(value) {
  return value === undefined || value === '' || boundedText(value, MAX_CARD_TEXT);
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
/** A purchase, sale or basket-line quantity: a whole number from 1 to the ceiling. A missing quantity counts as 1. */
function requiredQuantity(value) {
  if (value === undefined || value === null) return 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSFER_QUANTITY) return undefined;
  return value;
}

/** A missing quantity means the whole stack (null). A present one must be a whole number from 1 to the ceiling. */
function optionalQuantity(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSFER_QUANTITY) return undefined;
  return value;
}

function actorUuid(value) {
  const uuid = String(value ?? '');
  if (!boundedText(uuid, MAX_UUID_LENGTH)) return '';
  return uuid.startsWith('Actor.') || uuid.includes('.Actor.') ? uuid : '';
}

function tokenUuid(value) {
  const uuid = String(value ?? '');
  return boundedText(uuid, MAX_UUID_LENGTH) && uuid.includes('.Token.') ? uuid : '';
}

function idList(value) {
  if (!Array.isArray(value) || value.length > TRADE_MAX_ITEMS) return null;
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !DOCUMENT_ID.test(entry)) return null;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return Object.freeze(ids);
}
