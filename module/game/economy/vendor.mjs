/** @layer game/economy */
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { groundsOnInteraction, planForcedLanding } from '../movement/input-policy.mjs';

/* -------------------------------------------- */
/*  Merchandise vocabulary                      */
/* -------------------------------------------- */

const EQUIPMENT_MERCHANDISE = Object.freeze({
  Weapon: 'weapon', Staff: 'staff', 'Staff (U)': 'staff', Armor: 'armor', Shield: 'shield', Accessory: 'accessory'
});
const CONSUMABLE_MERCHANDISE = Object.freeze({
  Potion: 'potion', Bomb: 'bomb', Booster: 'booster', Promotion: 'promotion'
});
const RESOURCE_MERCHANDISE = Object.freeze({
  Material: 'material', Textile: 'textile', Reagent: 'reagent', Ingredient: 'ingredient'
});

/** The merchandise category an Item falls under, or an empty string for something no vendor deals in. */
function merchandiseKey(item) {
  const subtype = String(item.itemType ?? '');
  switch (String(item.type ?? '')) {
    case 'Equipment': return EQUIPMENT_MERCHANDISE[subtype] ?? '';
    case 'Consumable': return CONSUMABLE_MERCHANDISE[subtype] ?? '';
    case 'Resource': return RESOURCE_MERCHANDISE[String(item.resourceType ?? '')] ?? '';
    case 'Miscellaneous': return subtype === 'Coinpurse' ? '' : 'miscellaneous';
    default: return '';
  }
}

/** Whether a vendor deals in an Item at all. A category is accepted unless the vendor marks it refused. */
export function vendorAcceptsItem(accepted = {}, item = {}) {
  if (item.tradeDisabled === true) return false;
  const key = merchandiseKey(item);
  return Boolean(key) && accepted[key] !== false;
}

/** Whether a Vendor's possession is a shelf entry at all: currency and untradeable goods are never for sale. */
export function isShelfEntry(item = {}) {
  return item.tradeDisabled !== true && String(item.itemType ?? '') !== 'Coinpurse';
}

/** Whether a unit's possession may be offered to a shop: goods of a traded type, not currency, not innate. */
export function isShopGood(item = {}) {
  return VENDOR_ITEM_TYPES.includes(String(item.type ?? '')) && isShelfEntry(item) && item.innate !== true;
}

/* -------------------------------------------- */
/*  Reach                                       */
/* -------------------------------------------- */

/** The answer when the two Tokens can trade. Callers read only `ok` from it. */
const WITHIN_REACH = Object.freeze({ ok: true, data: Object.freeze({}) });

/**
 * Check adjacency, elevation and flight between a buyer and a Vendor. A flier buying from a Vendor on the ground
 * lands when it trades, so it is refused over an obstacle.
 * @param {object} reach Distance, elevation and flight between the two Tokens.
 * @returns {{ok: boolean, code?: string, data: object}} A refusal, or an answer with no code when within reach.
 */
export function resolveVendorReach(reach = {}) {
  if (!(Number(reach.distance) <= 1)) return refuse(RESULT_CODES.TRADE_OUT_OF_REACH);
  if (reach.sameElevation === false) return refuse(RESULT_CODES.TRADE_ELEVATION);
  if (reach.vendorAirborne === true && reach.buyerAirborne !== true) return refuse(RESULT_CODES.TRADE_AIRBORNE);
  const landing = planForcedLanding({
    grounds: groundsOnInteraction({
      sourceAirborne: reach.buyerAirborne, targetAirborne: reach.vendorAirborne, committed: true
    }),
    landingBlocked: reach.buyerLandingBlocked
  });
  if (!landing.ok) return refuse(landing.code);
  return WITHIN_REACH;
}

/* -------------------------------------------- */
/*  Appraisal                                   */
/* -------------------------------------------- */

/** Clamp a vendor disposition to the range the pricing curves are defined over. */
export function clampDisposition(disposition) {
  return Math.max(-10, Math.min(10, Math.round(Number(disposition) || 0)));
}

/**
 * Calculate the vendor's offer multiplier for sellPrice: +5% per positive disposition point, -4% per negative
 * point. It never exceeds the lowest price any vendor charges, so a party cannot buy goods from one vendor and sell
 * them to another at a profit.
 */
function vendorBuyFraction(disposition) {
  const value = clampDisposition(disposition);
  return Math.min(value >= 0 ? 0.5 + 0.05 * value : 0.5 + 0.04 * value, vendorSellMultiplier(10));
}

/**
 * Calculate the buyer's price multiplier for purchasePrice. Hostility raises prices faster than goodwill lowers
 * them.
 */
function vendorSellMultiplier(disposition) {
  const value = clampDisposition(disposition);
  return value >= 0 ? 1 - 0.04 * value : 1 - 0.10 * value;
}

/** How much of an Item's value survives its wear: a full charge is worth all of it, an empty one a twentieth. */
function conditionMultiplier(fraction) {
  const kept = Math.max(0, Math.min(1, Number(fraction) || 0));
  return (0.5 * kept * kept) + (0.45 * kept) + 0.05;
}

/** The remaining charge of an Item, as a fraction. Anything but a limited item with a maximum counts as full. */
function usesFraction(item) {
  if (String(item.type ?? '') === 'Resource') return 1;
  if (String(item.usesType ?? '') !== 'limited' || !(Number(item.usesMax) > 0)) return 1;
  return Math.max(0, Math.min(1, Number(item.usesCurrent) / Number(item.usesMax)));
}

/** The unit value an appraisal starts from: a Resource prices per unit, everything else by its own cost. */
function baseUnitValue(item) {
  return String(item.type ?? '') === 'Resource'
    ? Math.max(0, Number(item.perUnitCost) || 0)
    : Math.max(0, Number(item.cost) || 0);
}

/** What a vendor would pay per unit: value by disposition, and for discrete goods by their condition. */
export function sellPrice(item = {}, disposition = 0) {
  if (item.tradeDisabled === true) return 0;
  const base = baseUnitValue(item) * vendorBuyFraction(disposition);
  return Math.max(0, Math.round(base * conditionMultiplier(usesFraction(item))));
}

/** What a buyer pays per unit for a vendor's stock. */
export function purchasePrice(item = {}, disposition = 0) {
  return Math.max(0, Math.round(baseUnitValue(item) * vendorSellMultiplier(disposition)));
}

/**
 * What one buyer pays per unit for a shelf entry. The party that sold the entry to this Vendor buys it back at the
 * per-unit gold it was paid, whatever the disposition or haggle; everyone else pays purchasePrice.
 * @param {object} item The shelf entry, carrying its `buyback`.
 * @param {{disposition?: number, vendorUuid?: string, key?: string}} buyer The disposition the buyer's party sees,
 *   the Vendor, and the buyer's haggle key (haggleKey in ./haggle.mjs).
 * @returns {number}
 */
export function shelfPrice(item = {}, { disposition = 0, vendorUuid = '', key = '' } = {}) {
  return buybackFor(item, vendorUuid, key)?.unitPrice ?? purchasePrice(item, disposition);
}

/** The entry's buyback when it is this buyer's own sale to this Vendor, else null. */
function buybackFor(item, vendorUuid, key) {
  const buyback = item?.buyback ?? null;
  if (!buyback || !key || buyback.key !== key || buyback.vendorUuid !== String(vendorUuid ?? '')) return null;
  return buyback;
}

/** Whether a Vendor sold this possession, so it refuses to buy it back until the next Reset Downtime. */
export function soldByVendor(item = {}, vendorUuid = '') {
  return Boolean(vendorUuid) && (item.soldBy ?? []).includes(String(vendorUuid));
}

/**
 * The vendor tags a purchased copy carries (vendorTags in game/character/inventory.mjs): the Vendor joins the
 * sellers, and the shelf's buyback stays behind on the shelf.
 */
export function purchasedTags(tags = {}, vendorUuid = '') {
  const sold = [...new Set([...(tags.sold ?? []), String(vendorUuid ?? '')].filter(Boolean))].sort();
  return Object.freeze({ sold: Object.freeze(sold), buyback: null });
}

/** The vendor tags a sold copy carries on the Vendor's shelf: its sellers as they were, and the seller's buyback. */
export function shelvedTags(tags = {}, buyback = null) {
  return Object.freeze({
    sold: Object.freeze([...(tags.sold ?? [])]), buyback: buyback ? Object.freeze({ ...buyback }) : null
  });
}

/* -------------------------------------------- */
/*  Purchases and sales                         */
/* -------------------------------------------- */

/** Quantity limit enforced by the vendor purchase and sale planners. */
export const MAX_VENDOR_QUANTITY = 9999;

const VENDOR_ITEM_TYPES = Object.freeze(['Equipment', 'Consumable', 'Miscellaneous', 'Resource']);

/**
 * Plan a purchase from freshly read shop data. Prices, stock and funds come from saved data, never from the
 * player's request. The purse pays before Convoy funds, and the destination must have room. Resources transfer by
 * quantity, and other goods one at a time.
 * @param {object} facts The buyer, the vendor, the destination, the funds, the shelf entry and the quantity.
 * @returns {{ok: boolean, code?: string, data: object}}
 */
export function planVendorPurchase(facts = {}) {
  const { buyer, vendor, destination, funding, item, quantity, reach } = facts;
  if (!buyer || !vendor || !destination || !funding || !item || !VENDOR_ITEM_TYPES.includes(String(item.type))) {
    return refuse(RESULT_CODES.VENDOR_PURCHASE_UNAVAILABLE);
  }
  if (reach) {
    const standing = resolveVendorReach(reach);
    if (!standing.ok) return standing;
  }
  if (item.tradeDisabled === true || merchandiseKey(item) === '') {
    return refuse(RESULT_CODES.VENDOR_ITEM_UNTRADEABLE, { itemName: item.name });
  }
  const isResource = String(item.type) === 'Resource';
  const stock = availableStock(item);
  if (isResource && stock === null) return refuse(RESULT_CODES.VENDOR_STOCK_INVALID, { itemName: item.name });
  if (stock !== null && stock <= 0) return refuse(RESULT_CODES.VENDOR_OUT_OF_STOCK, { itemName: item.name });
  const units = isResource ? Math.min(whole(quantity), stock ?? whole(quantity)) : 1;
  if (!Number.isInteger(units) || units <= 0 || units > MAX_VENDOR_QUANTITY) {
    return refuse(RESULT_CODES.VENDOR_QUANTITY_INVALID);
  }
  const buyback = buybackFor(item, vendor.uuid, buyer.haggleKey);
  const unitPrice = buyback ? buyback.unitPrice : purchasePrice(item, vendor.disposition);
  const total = unitPrice * units;
  const purse = whole(funding.purseGp);
  const convoy = whole(funding.convoyGp);
  if (purse + convoy < total) {
    return refuse(RESULT_CODES.VENDOR_FUNDS_SHORT, { actorName: buyer.name, itemName: item.name, total });
  }
  const room = purchaseRoomRefusal(destination, item, isResource);
  if (room) return room;
  const fromPurse = Math.min(purse, total);
  return accept(RESULT_CODES.VENDOR_PURCHASED, {
    itemId: item.id,
    itemName: item.name,
    actorName: buyer.name,
    destinationName: destination.name,
    isResource,
    units,
    unitPrice,
    boughtBack: buyback !== null,
    total,
    fromPurse,
    fromConvoy: total - fromPurse,
    purseAfter: purse - fromPurse,
    convoyAfter: convoy - (total - fromPurse),
    vendorGpAfter: whole(vendor.gp) + total,
    stockAfter: stock === null ? null : stock - (isResource ? units : 1),
    destinationStackId: destination.resourceStackId ?? null,
    destinationStackBefore: whole(destination.resourceStackAmount)
  });
}

function purchaseRoomRefusal(destination, item, isResource) {
  const equipmentCount = whole(destination.equipmentCount);
  const equipmentCapacity = limit(destination.equipmentCapacity);
  const pocketCount = whole(destination.pocketCount);
  const pocketCapacity = limit(destination.pocketCapacity);
  if (!isResource && String(item.type) === 'Equipment') {
    if (Number.isFinite(equipmentCapacity) && item.itemType === 'Armor' && destination.hasArmor === true) {
      return refuse(RESULT_CODES.VENDOR_ARMOR_OCCUPIED, { actorName: destination.name });
    }
    if (equipmentCount >= equipmentCapacity) {
      return refuse(RESULT_CODES.VENDOR_EQUIPMENT_FULL, { actorName: destination.name, limit: equipmentCapacity });
    }
    return null;
  }
  if (isResource && destination.resourceStackId) return null;
  if (pocketCount >= pocketCapacity) {
    return refuse(RESULT_CODES.VENDOR_POCKETS_FULL, { actorName: destination.name, limit: pocketCapacity });
  }
  return null;
}

/**
 * Plan a sale from freshly read shop data. A vendor short of gold still buys and pays what it has. A Vendor never
 * buys back what it sold (soldByVendor), and the plan's `buyback` is the tag the shelved copy carries: the seller's
 * haggle key and the per-unit gold actually paid, rounded up so buying the goods back never costs less than the
 * vendor paid.
 * @param {object} facts The seller (with its `haggleKey`), the vendor, the source of the goods, the Item and the
 *   quantity.
 * @returns {{ok: boolean, code?: string, data: object}}
 */
export function planVendorSale(facts = {}) {
  const { seller, vendor, source, item, quantity, reach } = facts;
  if (!seller || !vendor || !source || !item || !VENDOR_ITEM_TYPES.includes(String(item.type))) {
    return refuse(RESULT_CODES.VENDOR_SALE_UNAVAILABLE);
  }
  if (reach) {
    const standing = resolveVendorReach(reach);
    if (!standing.ok) return standing;
  }
  if (item.innate === true || !vendorAcceptsItem(vendor.accepted ?? {}, item)) {
    return refuse(RESULT_CODES.VENDOR_ITEM_REFUSED, { vendorName: vendor.name, itemName: item.name });
  }
  if (soldByVendor(item, vendor.uuid)) {
    return refuse(RESULT_CODES.VENDOR_BUYBACK_REFUSED, { vendorName: vendor.name, itemName: item.name });
  }
  const isResource = String(item.type) === 'Resource';
  const held = isResource ? whole(item.amount) : 1;
  if (held <= 0) return refuse(RESULT_CODES.VENDOR_ITEM_UNAVAILABLE, { itemName: item.name });
  const units = isResource ? Math.min(whole(quantity), held) : 1;
  if (!Number.isInteger(units) || units <= 0 || units > MAX_VENDOR_QUANTITY) {
    return refuse(RESULT_CODES.VENDOR_QUANTITY_INVALID);
  }
  const unitPrice = sellPrice(item, vendor.disposition);
  const total = unitPrice * units;
  const vendorGp = whole(vendor.gp);
  const paid = Math.min(total, vendorGp);
  const balance = whole(source.isConvoy ? source.gp : source.purseGp);
  return accept(RESULT_CODES.VENDOR_SOLD, {
    itemId: item.id,
    itemName: item.name,
    vendorName: vendor.name,
    actorName: seller.name,
    isResource,
    units,
    unitPrice,
    total,
    paid,
    vendorGpAfter: vendorGp - paid,
    balanceAfter: balance + paid,
    sourceAmountAfter: isResource && units < held ? held - units : null,
    removeSourceItem: !isResource || units >= held,
    buyback: seller.haggleKey ? Object.freeze({
      vendorUuid: String(vendor.uuid ?? ''), key: String(seller.haggleKey), unitPrice: Math.ceil(paid / units)
    }) : null
  });
}

/** Read remaining stock for vendor planners. Null means unlimited stock, including a missing stock flag. */
function availableStock(entry) {
  if (String(entry.type ?? '') === 'Resource') {
    const amount = Number(entry.amount);
    return Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : null;
  }
  const stock = entry.stock;
  if (stock === null || stock === undefined || stock === '') return null;
  const number = Number(stock);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

function whole(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function limit(value) {
  return Number.isFinite(Number(value)) ? whole(value) : Infinity;
}
