/** @layer game/economy */
import { CONVOY_INBOUND_FLAG } from '../../contracts/domains/economy.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Inbound Items                               */
/* -------------------------------------------- */
/**
 * Whether a Convoy Item, or an item-like record carrying its flags, is inbound: owned by the Convoy but not yet
 * delivered. Every gameplay reader of Convoy items skips these, and only a GM delivers them.
 * @param {{flags?: object}} item The Item, or a plain record carrying its flags.
 * @returns {boolean}
 */
export function isInboundItem(item) {
  return item?.flags?.[SYSTEM_ID]?.[CONVOY_INBOUND_FLAG] === true;
}

/**
 * Split a Convoy's Items into the stored inventory gameplay reads and the inbound Items a GM delivers, each in the
 * order given.
 * @param {Iterable<object>} items The Convoy's Items, or item-like records carrying their flags.
 * @returns {{stored: object[], inbound: object[]}}
 */
export function partitionConvoyItems(items = []) {
  const stored = [];
  const inbound = [];
  for (const item of items ?? []) (isInboundItem(item) ? inbound : stored).push(item);
  return { stored, inbound };
}

/* -------------------------------------------- */
/*  Delivery                                    */
/* -------------------------------------------- */
/**
 * Plan what one GM delivery moves. With `all`, that is every inbound Item and all the inbound gold. Otherwise it is
 * the named ids that belong to inbound Items, plus the gold only when asked for. A plan with no gold and no ids has
 * nothing to deliver and is refused as CONVOY_DELIVERY_EMPTY.
 * @param {{inboundGp?: number, inboundItems?: Iterable<object>, intent?: object}} facts The Convoy's
 *   `system.inboundGp`, its inbound Items (from partitionConvoyItems), and a normalizeConvoyDeliveryIntent result.
 * @returns {{gold: number, itemIds: string[]}}
 */
export function planConvoyDelivery({ inboundGp = 0, inboundItems = [], intent = {} } = {}) {
  const available = Number.isFinite(Number(inboundGp)) ? Math.max(0, Number(inboundGp)) : 0;
  const inboundIds = [...new Set([...inboundItems ?? []].map(itemId).filter(Boolean))];
  if (intent?.all === true) return delivery(available, inboundIds);
  const inbound = new Set(inboundIds);
  const named = Array.isArray(intent?.itemIds) ? intent.itemIds.map(id => String(id ?? '')) : [];
  const itemIds = [...new Set(named)].filter(id => inbound.has(id));
  return delivery(intent?.gold === true ? available : 0, itemIds);
}

function delivery(gold, itemIds) {
  return { gold, itemIds };
}

function itemId(item) {
  return String(item?.id ?? item?._id ?? '');
}
