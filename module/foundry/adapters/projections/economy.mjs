/** @layer foundry/adapters/projections */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { resolveAvatarScale } from '../../../game/character/rules.mjs';
import {
  CHARACTER_INVENTORY_LIMITS,
  characterEquipmentCapacity,
  characterEquipmentCount,
  characterPocketCount,
  vendorTags
} from '../../../game/character/inventory.mjs';
import { hasStealAbility } from '../../../game/economy/trade.mjs';
import { collectionValues, whole } from '../../../lib/core/runtime.mjs';
import { isAirborneActor, projectActorStatusKeys } from './combat-context.mjs';
import { projectAttributeTotals, projectSkillRanks } from './items.mjs';
import { projectLandingBlocked } from './terrain.mjs';

/* -------------------------------------------- */
/*  Trade side                                  */
/* -------------------------------------------- */

/**
 * One side of a trade between two placed tokens, for FoundryTradeRepository (document-writes/economy.mjs): the
 * unit, the actions it has left this turn, its items and how much more it can carry.
 */
export function projectTradeSide(token, actor, movement) {
  const system = actor.system ?? {};
  const items = collectionValues(actor.items).map(projectTradeItem);
  const character = actor.type === 'Character';
  const statuses = projectActorStatusKeys(actor);
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    name: String(actor.name ?? token.name ?? ''),
    image: String(actor.img ?? token.texture?.src ?? ''),
    avatarScale: resolveAvatarScale(system.art?.avatarScale),
    pixelArt: actor.type === 'Object' || actor.getFlag?.(SYSTEM_ID, 'pixelArt') === true,
    owned: actor.isOwner === true,
    kind: String(actor.type ?? ''),
    objectType: String(system.objectType ?? ''),
    isDropChest: system.isDropChest === true,
    locked: system.locked !== false,
    actorType: String(system.faction?.role ?? 'Neutral'),
    attributes: character ? projectAttributeTotals(system) : Object.freeze({}),
    skills: character ? projectSkillRanks(system) : Object.freeze({}),
    blessed: statuses.has('blessed') || system.statuses?.blessed === true,
    standardAvailable: system.turn?.actionAvailable !== false,
    bonusActionAvailable: system.turn?.bonusActionAvailable !== false,
    traded: system.turn?.traded === true,
    hasStealAbility: character && hasStealAbility(items),
    items: Object.freeze(items),
    equipmentCount: character ? characterEquipmentCount(items) : 0,
    pocketCount: character ? characterPocketCount(items) : 0,
    equipmentCapacity: character ? characterEquipmentCapacity(actor.system?.equipment?.slots) : Infinity,
    pocketCapacity: character ? CHARACTER_INVENTORY_LIMITS.pockets : Infinity,
    carriesArmor: items.some(item => item.itemType === 'Armor'),
    movement
  });
}

/** One item as a trade sees it: its value, amount and uses, and whether it may leave its carrier. */
export function projectTradeItem(item) {
  const system = item.system ?? {};
  const cost = system.cost && typeof system.cost === 'object' ? system.cost.total : system.cost;
  return Object.freeze({
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    image: String(item.img ?? ''),
    type: String(item.type ?? ''),
    itemType: String(system.itemType ?? ''),
    cost: Number(cost) || 0,
    amount: Number(system.amount) || 0,
    usesCurrent: Number(system.uses?.current) || 0,
    usesMax: Number(system.uses?.max) || 0,
    isEquipped: system.isWielded === true || system.isWorn === true || system.isEquipped === true,
    innate: Boolean(item.getFlag?.(SYSTEM_ID, 'innateGrant')),
    innateGrant: Boolean(item.getFlag?.(SYSTEM_ID, 'innateGrant')),
    tradeDisabled: system.tradeDisabled === true,
    stealableFlag: String(system.stealable?.flag ?? ''),
    stealableDc: Number.isFinite(Number(system.stealable?.dc)) ? Number(system.stealable.dc) : null
  });
}

/* -------------------------------------------- */
/*  Vendor shelf                                */
/* -------------------------------------------- */

/**
 * One item as a shop prices it: the price inputs, its stock count, whether the Vendor has locked it, and its vendor
 * tags (vendorTags): the Vendors that sold it (`soldBy`) and the buyback its seller's party pays (`buyback`).
 */
export function projectVendorItem(item) {
  const system = item.system ?? {};
  const cost = system.cost && typeof system.cost === 'object' ? system.cost.total : system.cost;
  const stock = item.getFlag?.(SYSTEM_ID, 'stock');
  const tags = vendorTags(item);
  return Object.freeze({
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    image: String(item.img ?? ''),
    type: String(item.type ?? ''),
    itemType: String(system.itemType ?? ''),
    resourceType: String(system.resourceType ?? ''),
    weaponFamily: String(system.weapon?.req ?? ''),
    weaponRank: Number(system.weapon?.rank) || 0,
    armorClass: String(system.armor?.req ?? ''),
    cost: Number(cost) || 0,
    perUnitCost: Number(system.cost?.perUnit) || 0,
    amount: Number(system.amount) || 0,
    usesCurrent: Number(system.uses?.current) || 0,
    usesMax: Number(system.uses?.max) || 0,
    usesType: String(system.uses?.type ?? ''),
    stock: stock === undefined ? null : stock,
    locked: item.getFlag?.(SYSTEM_ID, 'vendorLocked') === true,
    isEquipped: system.isWielded === true || system.isWorn === true || system.isEquipped === true,
    innate: Boolean(item.getFlag?.(SYSTEM_ID, 'innateGrant')),
    tradeDisabled: system.tradeDisabled === true,
    soldBy: tags.sold,
    buyback: tags.buyback
  });
}

/**
 * The Convoys a unit can use: the one linked to the party of each player who owns it. Read by the trade and
 * downtime writers and by the Convoy withdrawal check in services/authority.mjs.
 */
export function projectLinkedConvoys(actor, parties) {
  const state = parties?.readState?.();
  if (!actor || !state) return Object.freeze([]);
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const convoys = new Map();
  for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
    if (userId === 'default' || Number(level) < owner) continue;
    const user = globalThis.game?.users?.get?.(userId);
    if (!user || user.isGM) continue;
    const party = state.parties.find(entry => entry.id === state.membership[userId]);
    const convoy = party?.convoyUuid ? parties.resolveConvoy?.(String(party.convoyUuid)) : null;
    if (convoy) {
      convoys.set(String(convoy.uuid), Object.freeze({
        uuid: String(convoy.uuid), actorUuid: String(convoy.uuid), name: String(convoy.name ?? 'Convoy')
      }));
    }
  }
  return Object.freeze([...convoys.values()]);
}

/** A Convoy as a shop sees it: the gold it pools with the buyer and the goods it may sell through them. */
export function projectShopConvoy(convoy) {
  return Object.freeze({
    uuid: String(convoy.uuid),
    actorUuid: String(convoy.uuid),
    name: String(convoy.name ?? 'Convoy'),
    gp: whole(convoy.system?.gp),
    goods: Object.freeze(collectionValues(convoy.items).map(projectVendorItem))
  });
}

/**
 * The board facts between the unit at the counter and the Vendor: how far, how high, who is flying, and whether the
 * buyer hangs over an obstacle it could not be set down on.
 */
export function projectShopReach(buyerToken, vendorToken, distance) {
  const buyerAirborne = isAirborneActor(buyerToken.actor);
  return Object.freeze({
    distance,
    sameElevation: (Number(buyerToken.elevation) || 0) === (Number(vendorToken.elevation) || 0),
    buyerAirborne,
    vendorAirborne: isAirborneActor(vendorToken.actor),
    buyerLandingBlocked: buyerAirborne && projectLandingBlocked(buyerToken)
  });
}

/** Where a purchase lands: the room it has left and the stack a Resource would join. */
export function projectPurchaseDestination(destination, stack) {
  const items = collectionValues(destination.items).map(projectTradeItem);
  const character = destination.type === 'Character';
  return Object.freeze({
    uuid: String(destination.uuid),
    name: String(destination.name ?? ''),
    equipmentCount: character ? characterEquipmentCount(items) : 0,
    equipmentCapacity: character ? characterEquipmentCapacity(destination.system?.equipment?.slots) : Infinity,
    pocketCount: character ? characterPocketCount(items) : 0,
    pocketCapacity: character ? CHARACTER_INVENTORY_LIMITS.pockets : Infinity,
    hasArmor: items.some(item => item.itemType === 'Armor'),
    resourceStackId: stack?.id ?? '',
    resourceStackAmount: whole(stack?.system?.amount)
  });
}
