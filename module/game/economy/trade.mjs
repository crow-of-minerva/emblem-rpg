/** @layer game/economy */
import { STEAL_ABILITY_NAME, TRADE_MODES } from '../../contracts/domains/economy.mjs';
import { OWNED_UNIT_FACTIONS } from '../../contracts/domains/characters.mjs';
import { CHARACTER_INVENTORY_LIMITS } from '../character/inventory.mjs';
import { areFactionsHostile } from '../character/rules.mjs';
import { unitTurnComplete } from '../combat/phases.mjs';
import { groundsOnInteraction, planForcedLanding } from '../movement/input-policy.mjs';
import { defeatedLootPayloads, isDroppableItem, isDroppableItem as isTradeableItem } from '../objects/rules.mjs';
import { isCoinpurseItem } from './coinpurse.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';

/* -------------------------------------------- */
/*  Trade vocabulary                            */
/* -------------------------------------------- */
const POCKET_ITEM_TYPES = new Set(['Consumable', 'Miscellaneous', 'Resource']);

/** Which side of the window an Item sits on, mirroring the sheet's Equipment / Pockets split. */
export function tradeItemTab(item) {
  return item?.type === 'Equipment' ? 'equipment' : 'pockets';
}

/** Whether an Item may change hands at all: a carried possession, never a class feature or an innate grant. */
export { isTradeableItem };

/** Whether an Item is in hand, worn or equipped, and so stays where it is until it is set down. */
function isHeldItem(item) {
  return item?.isEquipped === true;
}

/** Whether a unit may open a trade: its bonus action is unspent, or a trade is what spent it. */
export function tradeActionAvailable(turn = {}) {
  return turn.bonusActionAvailable !== false || turn.traded === true;
}

/* -------------------------------------------- */
/*  Steal eligibility                           */
/* -------------------------------------------- */

/** Whether an Item is the Steal Ability, which a unit needs to attempt a theft. */
export function isStealAbility(item) {
  return item?.type === 'Ability' && String(item?.name ?? '') === STEAL_ABILITY_NAME;
}

/** Whether a unit carries the Steal Ability among its possessions. */
export function hasStealAbility(items = []) {
  return items.some(isStealAbility);
}

/* -------------------------------------------- */
/*  Steal difficulty                            */
/* -------------------------------------------- */

/** Whether a thief may take this Item: flagged Stealable outright, or Drops with a real difficulty authored. */
export function isStealableItem(item) {
  if (!isTradeableItem(item)) return false;
  const flag = String(item?.stealableFlag ?? '');
  if (flag === 'Stealable') return true;
  return flag === 'Drops' && (Number(item?.stealableDc) || 0) > 0;
}

/**
 * Whether a unit's goods count as loot to the party, which is true only for a faction hostile to it. The Character
 * sheet marks such goods as loot.
 */
export function exposesLootToParty(faction) {
  return areFactionsHostile(OWNED_UNIT_FACTIONS[0], faction);
}

/** What a unit carries that a player might want: goods a thief may lift, goods it leaves when defeated, or both. */
export function carriedLootKind(items = []) {
  const steal = items.some(isStealableItem);
  const drops = defeatedLootPayloads(items).length > 0;
  if (steal && drops) return 'both';
  if (steal) return 'steal';
  return drops ? 'drops' : null;
}

/**
 * The base of stealItemDC by kind of item: Equipment is hardest, then Consumables, then anything else. A Coinpurse
 * starts at 0 and a promotion item far below it.
 */
function stealBaseDC(item) {
  const itemType = String(item?.itemType ?? '');
  const type = String(item?.type ?? '');
  if (itemType === 'Coinpurse') return 0;
  if (itemType === 'Promotion') return -50;
  if (type === 'Equipment') return 5;
  if (type === 'Consumable') return 4;
  return 3;
}

/** The value component: the more something is worth, the harder it is to take. */
function stealDynamicDC(cost) {
  return Math.round((Number(cost) || 0) / 150);
}

/** An Item's full steal DC. An authored DC always wins, even 0 or a negative one. */
export function stealItemDC(item) {
  const explicit = authoredStealDC(item);
  if (explicit !== null) return explicit;
  return stealBaseDC(item) + stealDynamicDC(item?.cost);
}

/** The difficulty the GM wrote on the Item, or null where none was written at all. */
function authoredStealDC(item) {
  const raw = item?.stealableDc;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Sum item DCs for planSteal's single all-or-nothing check. */
function stealTotalDC(items) {
  return items.reduce((total, item) => total + stealItemDC(item), 0);
}

/* -------------------------------------------- */
/*  Trade mode                                  */
/* -------------------------------------------- */

/** What the window is for, by what stands on the other side. A Vendor has its own menu and is not a trade. */
export function resolveTradeMode(target = {}) {
  if (target.kind === 'Character') return TRADE_MODES.TRADE;
  if (target.kind !== 'Object') return null;
  const objectType = String(target.objectType ?? '');
  if (isTakeOnlyTarget(target)) return TRADE_MODES.LOOT;
  if (objectType === 'Chest' && target.locked === false) return TRADE_MODES.LOOT;
  return null;
}

/** A dropped bag and a Loot pile are take-only. An unlocked Chest keeps both sides, so a unit may stow into it. */
export function isTakeOnlyTarget(target = {}) {
  return String(target.objectType ?? '') === 'Loot' || target.isDropChest === true;
}

/* -------------------------------------------- */
/*  Trade planning                              */
/* -------------------------------------------- */

/**
 * Check a trade or a loot before any inventory is written, for trade and the trade view in
 * engine/economy/trade.mjs. Reach comes first, then the items, then room counted after the swap, so two full units
 * can still swap. In an encounter a trade spends the bonus action and movement, while looting a container only
 * commits the square. A flier reaching down to a unit on the ground lands (`grounds`), and is refused over an
 * obstacle.
 * @param {object} facts Trade facts.
 * @returns {{ok: boolean, code?: string, data?: object, mode?: string, spendsBonusAction?: boolean,
 *   commitsSquare?: boolean, grounds?: boolean}}
 */
export function planTrade(facts) {
  const mode = resolveTradeMode(facts.target);
  if (!mode) return refusal(RESULT_CODES.TRADE_TARGET_INVALID);
  if (mode === TRADE_MODES.TRADE && facts.friendly !== true) return refusal(RESULT_CODES.TRADE_TARGET_INVALID);
  const board = boardRefusal(facts);
  if (board) return board;
  const inEncounter = facts.encounterRunning === true && facts.exploring !== true;
  const spendsBonusAction = mode === TRADE_MODES.TRADE && inEncounter;
  const grounds = groundsOnInteraction({
    sourceAirborne: facts.sourceAirborne,
    targetAirborne: facts.targetAirborne,
    committed: mode !== TRADE_MODES.LOOT || spendsBonusAction
  });
  const landing = planForcedLanding({ grounds, landingBlocked: facts.sourceLandingBlocked });
  if (!landing.ok) return refusal(landing.code);
  if (mode === TRADE_MODES.TRADE && inEncounter && !tradeActionAvailable(facts.source)) {
    return refusal(RESULT_CODES.TRADE_BONUS_ACTION_UNAVAILABLE);
  }
  const give = facts.give ?? [];
  const take = facts.take ?? [];
  const takeOnly = mode === TRADE_MODES.LOOT && isTakeOnlyTarget(facts.target);
  if (takeOnly && give.length) return refusal(RESULT_CODES.TRADE_ITEM_REFUSED, { itemName: give[0].name });
  if (!give.length && !take.length) return refusal(RESULT_CODES.TRADE_NOTHING_SELECTED);
  const refused = [...give, ...take].find(item => !isTradeableItem(item));
  if (refused) return refusal(RESULT_CODES.TRADE_ITEM_REFUSED, { itemName: refused.name });
  const held = [...give, ...take].find(isHeldItem);
  if (held) return refusal(RESULT_CODES.TRADE_ITEM_EQUIPPED, { itemName: held.name });
  const sourceRoom = roomRefusal(facts.source, give, take);
  if (sourceRoom) return sourceRoom;
  if (mode === TRADE_MODES.TRADE) {
    const targetRoom = roomRefusal(facts.target, take, give);
    if (targetRoom) return targetRoom;
  }
  return {
    ok: true,
    mode,
    spendsBonusAction,
    commitsSquare: mode === TRADE_MODES.LOOT && facts.exploring !== true,
    grounds
  };
}

/**
 * Check a theft before the skill roll, for steal and the trade view in engine/economy/trade.mjs.
 * Require Steal, a visible adjacent hostile, a valid movement plan and capacity for every item.
 * Free Exploration forbids theft. The combined DC uses one roll, and the attempt ends the turn even on failure.
 * A thief reaching down from the air lands (`grounds`), and is refused over an obstacle.
 * @param {object} facts Steal facts.
 * @returns {{ok: boolean, code?: string, data?: object, dc?: number, endsTurn?: boolean, grounds?: boolean}}
 */
export function planSteal(facts) {
  if (facts.source?.hasStealAbility !== true) {
    return refusal(RESULT_CODES.STEAL_ABILITY_REQUIRED, { actorName: facts.source?.name ?? '' });
  }
  if (facts.target?.kind !== 'Character' || facts.hostile !== true) return refusal(RESULT_CODES.STEAL_TARGET_INVALID);
  if (facts.targetHidden === true) return refusal(RESULT_CODES.STEAL_TARGET_INVALID);
  const board = boardRefusal(facts);
  if (board) return board;
  const grounds = groundsOnInteraction({ sourceAirborne: facts.sourceAirborne, targetAirborne: facts.targetAirborne });
  const landing = planForcedLanding({ grounds, landingBlocked: facts.sourceLandingBlocked });
  if (!landing.ok) return refusal(landing.code);
  if (facts.exploring === true) return refusal(RESULT_CODES.ITEM_ACTIVATION_EXPLORATION_FORBIDDEN);
  if (facts.source?.standardAvailable !== true) return refusal(RESULT_CODES.TRADE_ACTION_UNAVAILABLE);
  if (facts.source?.movement && facts.source.movement.movementPlanning !== true) {
    return refusal(RESULT_CODES.MOVEMENT_PLAN_REQUIRED);
  }
  const items = facts.items ?? [];
  if (!items.length) return refusal(RESULT_CODES.TRADE_NOTHING_SELECTED);
  const unstealable = items.find(item => !isStealableItem(item));
  if (unstealable) return refusal(RESULT_CODES.STEAL_ITEM_UNSTEALABLE, { itemName: unstealable.name });
  const room = resolveStealRoom(facts.source, items);
  if (!room.ok) return room;
  return { ok: true, dc: stealTotalDC(items), endsTurn: true, grounds };
}

/**
 * Whether the thief has room for everything it reached for, with at most one Armor. Used by planSteal, and by the
 * Steal window in ui/controls/interaction.mjs before it closes.
 * @param {object} thief The thief's side facts.
 * @param {object[]} items The Items reached for.
 * @returns {{ok: boolean, code?: string, data?: object}}
 */
export function resolveStealRoom(thief, items = []) {
  return roomRefusal(thief, [], items, { oneArmor: true }) ?? { ok: true };
}

function boardRefusal(facts) {
  if (facts.squareShared === true) return refusal(RESULT_CODES.TRADE_SQUARE_SHARED);
  if (!(Number(facts.distance) <= 1)) return refusal(RESULT_CODES.TRADE_OUT_OF_REACH);
  if (facts.sameElevation === false) return refusal(RESULT_CODES.TRADE_ELEVATION);
  if (facts.targetAirborne === true && facts.sourceAirborne !== true) return refusal(RESULT_CODES.TRADE_AIRBORNE);
  return null;
}

/** Whether a side still fits what it ends up holding, counted as what it gains minus what it gives. */
function roomRefusal(side, outgoing, incoming, { oneArmor = false } = {}) {
  if (!side || side.kind !== 'Character') return null;
  const equipmentCapacity = Number.isFinite(Number(side.equipmentCapacity))
    ? Number(side.equipmentCapacity) : CHARACTER_INVENTORY_LIMITS.equipment;
  const pocketCapacity = Number.isFinite(Number(side.pocketCapacity))
    ? Number(side.pocketCapacity) : CHARACTER_INVENTORY_LIMITS.pockets;
  const count = (items, predicate) => items.filter(predicate).length;
  const isEquipment = item => item.type === 'Equipment';
  const isPocket = item => POCKET_ITEM_TYPES.has(String(item.type ?? ''));
  const equipment = (Number(side.equipmentCount) || 0) - count(outgoing, isEquipment) + count(incoming, isEquipment);
  const pockets = (Number(side.pocketCount) || 0) - count(outgoing, isPocket) + count(incoming, isPocket);
  if (oneArmor && incoming.some(item => item.itemType === 'Armor') && side.carriesArmor === true) {
    return refusal(RESULT_CODES.TRADE_ARMOR_FULL, { actorName: side.name });
  }
  if (equipment > equipmentCapacity) {
    return refusal(RESULT_CODES.TRADE_EQUIPMENT_FULL, { actorName: side.name, limit: equipmentCapacity });
  }
  if (pockets > pocketCapacity) return refusal(RESULT_CODES.TRADE_POCKETS_FULL, { actorName: side.name, limit: pocketCapacity });
  return null;
}

function refusal(code, data = {}) {
  return { ok: false, code, data: Object.freeze({ ...data }) };
}

/* -------------------------------------------- */
/*  Container stocking                          */
/* -------------------------------------------- */

/** What a Convoy or Vendor shelves: every Equipment subtype, Consumables, Miscellaneous goods and Resources. */
const CONTAINER_EQUIPMENT_SUBTYPES = new Set(['Weapon', 'Armor', 'Staff', 'Staff (U)', 'Shield', 'Accessory']);
const CONTAINER_ITEM_TYPES = new Set(['Consumable', 'Miscellaneous', 'Resource']);

/** Whether an Item is a kind a container stocks at all, whatever else may stop this particular one. */
export function isContainerStockable(item) {
  if (CONTAINER_ITEM_TYPES.has(String(item?.type ?? ''))) return true;
  return String(item?.type ?? '') === 'Equipment' && CONTAINER_EQUIPMENT_SUBTYPES.has(String(item?.itemType ?? ''));
}

/** How many units travel: a Resource may move part of its stack, anything else moves whole. */
function transferAmount(item, requested) {
  if (item.type !== 'Resource') return { ok: true, amount: null };
  const held = Math.max(0, Math.floor(Number(item.amount) || 0));
  const amount = requested === null || requested === undefined ? held : Math.min(held, Math.floor(Number(requested)));
  if (amount < 1) return { ok: false, code: RESULT_CODES.RESOURCE_AMOUNT_REQUIRED };
  return { ok: true, amount };
}

/**
 * Plan a Convoy deposit for convoyDeposit in engine/economy/trade.mjs. A player needs one of their linked Convoys,
 * and in an encounter a unit with some turn left (unitTurnComplete in game/combat/phases.mjs), since only taking
 * from a Convoy is locked there. A Coinpurse arrives as gold, and a partial Resource transfer is capped at the
 * amount held.
 * @param {object} facts `item`, `turn`, `linkedConvoyUuids`, `convoyUuid`, `encounterActive`, `gm`, `amount`.
 * @returns {{ok: boolean, code?: string, data?: object, gold?: number, amount?: number|null}}
 */
export function planConvoyDeposit(facts = {}) {
  if (!facts.item) return { ok: false, code: RESULT_CODES.TRADE_ITEM_MISSING };
  if (facts.gm !== true && facts.encounterActive === true && unitTurnComplete(facts.turn)) {
    return { ok: false, code: RESULT_CODES.CONVOY_TURN_OVER };
  }
  const linked = (facts.linkedConvoyUuids ?? []).includes(String(facts.convoyUuid ?? ''));
  if (!linked && facts.gm !== true) return { ok: false, code: RESULT_CODES.CONVOY_UNAVAILABLE };
  if (!isContainerStockable(facts.item)) {
    return { ok: false, code: RESULT_CODES.CONVOY_ITEM_TYPE_REFUSED, data: { itemName: facts.item.name } };
  }
  if (!isDroppableItem(facts.item)) return { ok: false, code: RESULT_CODES.CONVOY_ITEM_REFUSED };
  const gold = isCoinpurseItem(facts.item) ? Math.max(0, Math.floor(Number(facts.item.cost) || 0)) : 0;
  const units = transferAmount(facts.item, facts.amount);
  if (!units.ok) return units;
  return { ok: true, gold, amount: units.amount };
}

/**
 * Plan a GM's move of a unit's item onto a Vendor's shelf, for vendorStock in engine/economy/trade.mjs. Any good a
 * container stocks is accepted except a Coinpurse, and a Resource may go in part.
 * @param {object} facts `item`, `gm`, `amount`.
 * @returns {{ok: boolean, code?: string, data?: object, amount?: number|null}}
 */
export function planVendorStock(facts = {}) {
  if (facts.gm !== true) return { ok: false, code: RESULT_CODES.GM_REQUIRED };
  if (!facts.item) return { ok: false, code: RESULT_CODES.TRADE_ITEM_MISSING };
  if (!isContainerStockable(facts.item) || isCoinpurseItem(facts.item)) {
    return { ok: false, code: RESULT_CODES.VENDOR_ITEM_TYPE_REFUSED, data: { itemName: facts.item.name } };
  }
  if (!isDroppableItem(facts.item)) {
    return { ok: false, code: RESULT_CODES.VENDOR_ITEM_TYPE_REFUSED, data: { itemName: facts.item.name } };
  }
  const units = transferAmount(facts.item, facts.amount);
  if (!units.ok) return units;
  return { ok: true, amount: units.amount };
}
