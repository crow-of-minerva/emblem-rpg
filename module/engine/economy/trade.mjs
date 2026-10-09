/** @layer engine/economy */
import { COMMAND_IDS, INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { KARMA_LEDGER_RESOURCE_KEY } from '../../contracts/domains/combat.mjs';
import {
  DIAGNOSTIC_SEVERITIES, DIAGNOSTIC_SOURCES, recordDiagnostic, requirePorts
} from '../../contracts/protocol.mjs';
import {
  ECONOMY_LEDGER_RESOURCE_KEY,
  ECONOMY_PRESENTATION_EVENTS,
  ECONOMY_SETTLEMENT_OUTCOMES,
  HAGGLE_SKILL_KEY,
  HAGGLE_TIMING,
  STEAL_ATTEMPT_TIMING,
  STEAL_SKILL_KEY,
  TRADE_MODES,
  VENDOR_CHECKOUT_MODES,
  economyPresentationMessage,
  normalizeConvoyDeliveryIntent,
  normalizeConvoyDepositIntent,
  normalizeConvoyWithdrawalIntent,
  normalizeHaggleIntent,
  normalizeShopIntent,
  normalizeStealIntent,
  normalizeVendorCheckoutIntent,
  normalizeVendorMerchandiseIntent,
  normalizeVendorPurchaseIntent,
  normalizeVendorSaleIntent,
  normalizeVendorStockIntent,
  normalizeTradeIntent,
  normalizeTradePair,
  vendorCheckoutLinePayload
} from '../../contracts/domains/economy.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import { SKILL_BY_KEY } from '../../game/character/rules.mjs';
import { handoverLockedByEncounter } from '../../game/character/inventory.mjs';
import { actionLaneSpend } from '../../game/downtime/rules.mjs';
import { planCoinpurseReconciliation, planConvoyWithdrawal } from '../../game/economy/coinpurse.mjs';
import { planHaggle, planHaggleOutcome, resolveHaggleStanding } from '../../game/economy/haggle.mjs';
import {
  isStealableItem,
  isTakeOnlyTarget,
  isTradeableItem,
  planConvoyDeposit,
  planSteal,
  planVendorStock,
  planTrade,
  resolveTradeMode,
  stealItemDC,
  tradeItemTab
} from '../../game/economy/trade.mjs';
import {
  planVendorPurchase,
  planVendorSale,
  resolveVendorReach,
  sellPrice,
  shelfPrice,
  soldByVendor,
  vendorAcceptsItem
} from '../../game/economy/vendor.mjs';
import { groundsOnInteraction } from '../../game/movement/input-policy.mjs';
import { resolveStandingDestination, standsOverObstacle } from '../../game/movement/pathfinding.mjs';
import { fixtureHidden } from '../../game/objects/rules.mjs';
import { buildSkillCheck } from '../../game/rolls/checks.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { CombatPersistenceError } from '../recovery/errors.mjs';
import { grantSkillExperience } from '../character/skill-experience.mjs';
import { cardRequester, presentSafely, recordAbsorbed } from '../feedback.mjs';
import { unitImpact } from '../effects/execution.mjs';
import { experienceTarget, settleTableExperience } from '../items/activation.mjs';
import { earnsCharacterExperience } from '../../game/progression/rules.mjs';

const MOVEMENT_BOARD_KEY = 'movement:board';

/* -------------------------------------------- */
/*  Economy commands                            */
/* -------------------------------------------- */

/**
 * The trade, theft, Convoy, vendor, haggle and coinpurse command definitions init/system.mjs registers with
 * CommandDispatcher.
 */
export function createEconomyCommandContribution({
  trades, movements, checks, checkPresentation, presentation, skills, progression, events, diagnostics, authority,
  random, wait
}) {
  requirePorts('createEconomyCommandContribution', { trades, movements, checks, checkPresentation, presentation,
    skills, progression, events, diagnostics, random, wait });
  const services = {
    trades, movements, checks, checkPresentation, presentation, skills, progression, events, diagnostics, authority,
    random, wait
  };
  const authorize = createCommandAuthorization(authority);
  return [
    {
      id: COMMAND_IDS.ECONOMY.TRADE,
      authorize: authorize.tokenController(payload => payload.sourceTokenUuid),
      concurrencyKeys: context => trades.resourceKeys(context.payload),
      handler: context => trade(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.STEAL,
      authorize: authorize.tokenController(payload => payload.sourceTokenUuid),
      // The steal check has a DC, so it may be karmic and write the world's karma ledger.
      concurrencyKeys: async context => [...await trades.resourceKeys(context.payload), KARMA_LEDGER_RESOURCE_KEY],
      handler: context => steal(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.CONVOY_DEPOSIT,
      authorize: authorize.actorOwner(payload => payload.sourceActorUuid),
      concurrencyKeys: context => economyKeys(context.payload?.sourceActorUuid, context.payload?.convoyUuid),
      handler: context => convoyDeposit(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.CONVOY_WITHDRAW,
      authorize: authorize.actorOwner(payload => payload.targetActorUuid),
      concurrencyKeys: context => economyKeys(context.payload?.targetActorUuid, context.payload?.convoyUuid),
      handler: context => convoyWithdraw(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.CONVOY_DELIVER,
      authorize: authorize.gm(),
      concurrencyKeys: context => economyKeys(context.payload?.convoyUuid),
      handler: context => convoyDeliver(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.VENDOR_STOCK,
      authorize: authorize.gm(),
      concurrencyKeys: context => economyKeys(context.payload?.sourceActorUuid, context.payload?.vendorUuid),
      handler: context => vendorStock(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.VENDOR_PURCHASE,
      authorize: authorize.actorOwner(payload => payload.buyerActorUuid),
      concurrencyKeys: context => shopKeys(context.payload?.buyerActorUuid, context.payload?.vendorUuid,
        context.payload?.destinationUuid),
      handler: context => vendorPurchase(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.VENDOR_SELL,
      authorize: authorize.actorOwner(payload => payload.sellerActorUuid),
      concurrencyKeys: context => shopKeys(context.payload?.sellerActorUuid, context.payload?.vendorUuid,
        context.payload?.sourceUuid),
      handler: context => vendorSell(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.VENDOR_CHECKOUT,
      authorize: authorize.actorOwner(payload => payload.buyerActorUuid),
      concurrencyKeys: context => shopKeys(context.payload?.buyerActorUuid, context.payload?.vendorUuid,
        context.payload?.holdingUuid),
      handler: context => vendorCheckout(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.HAGGLE,
      authorize: authorize.all(
        authorize.tokenController(payload => payload.buyerTokenUuid),
        authorize.actorOwner(payload => payload.buyerActorUuid)
      ),
      concurrencyKeys: context => shopKeys(context.payload?.buyerActorUuid, context.payload?.vendorUuid),
      handler: context => haggle(context, services)
    },
    {
      id: COMMAND_IDS.ECONOMY.VENDOR_MERCHANDISE,
      authorize: authorize.gm(),
      concurrencyKeys: context => actorKeys(context.payload?.vendorUuid),
      handler: context => vendorMerchandise(context, services)
    },
    {
      id: INTERNAL_COMMAND_IDS.ECONOMY.RECONCILE_COINPURSE,
      authorize: authorize.activeGm(),
      concurrencyKeys: context => economyKeys(context.payload?.actorUuid),
      handler: context => reconcileCoinpurse(context, services)
    },

  ];
}

/** One resource key per named actor. A blank optional side names no actor and adds no key. */
function actorKeys(...uuids) {
  return [...new Set(uuids.map(uuid => String(uuid ?? '')).filter(Boolean).map(uuid => `actor:${uuid}`))].sort();
}

/** Keys for a Convoy, vendor or coinpurse change: every actor it writes, plus the shared economy ledger key. */
function economyKeys(...uuids) {
  return [...actorKeys(...uuids), ECONOMY_LEDGER_RESOURCE_KEY];
}

/**
 * Keys for a shop line or a haggle: the economy keys plus the movement key, because a flying unit at the counter
 * may be landed (settleShopVisit). Its movement plan stays open.
 */
function shopKeys(...uuids) {
  return [...economyKeys(...uuids), MOVEMENT_BOARD_KEY];
}

/* -------------------------------------------- */
/*  Settlement outcomes                         */
/* -------------------------------------------- */

/**
 * Turn a failed save into a refusal. Out-of-date data means nothing was written; a write that failed part-way is
 * logged, and the dispatcher undoes what it wrote.
 */
function refuseSettlement(services, outcome, code) {
  const reasonCode = outcome.reasonCode ?? outcome.code;
  if (outcome.code === ECONOMY_SETTLEMENT_OUTCOMES.STALE) return refuse(code, { reasonCode });
  const diagnostic = outcome.diagnostic ?? recordDiagnostic(services.diagnostics, {
    sourcePath: 'foundry/adapters/document-writes/economy.mjs', source: DIAGNOSTIC_SOURCES.ECONOMY,
    severity: DIAGNOSTIC_SEVERITIES.WARNING, detail: `${outcome.code}:${reasonCode}`
  });
  return refuse(code, { reasonCode, diagnostic });
}

/** Whether a save failed part-way, so the whole basket is abandoned and undone. */
function settlementFailed(outcome) {
  return outcome?.code === ECONOMY_SETTLEMENT_OUTCOMES.REVERTED;
}

/* -------------------------------------------- */
/*  Coinpurse arrival                           */
/* -------------------------------------------- */

/**
 * Merge an actor's coinpurses after a new one arrives (planCoinpurseReconciliation). A unit keeps a single purse,
 * and a Convoy folds its purses into its gold total.
 */
async function reconcileCoinpurse(context, services) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const snapshot = actorUuid ? await services.trades.getCoinpurseSnapshot(actorUuid) : null;
  if (!snapshot) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
  const plan = planCoinpurseReconciliation(snapshot);
  if (plan.code === RESULT_CODES.COINPURSE_UNCHANGED) return plan;
  const settled = await services.trades.settleCoinpurse(snapshot, plan, context);
  if (settled.ok !== true) return refuseSettlement(services, settled, RESULT_CODES.CONVOY_STALE);
  return accept(plan.code, { ...plan.data, actorName: snapshot.name, actorUuid: snapshot.actorUuid });
}

/* -------------------------------------------- */
/*  Convoy withdrawals                          */
/* -------------------------------------------- */

/** Pay gold out of a Convoy into a unit's purse. The purse grows, or a new one is created if the unit has none. */
async function convoyWithdraw(context, services) {
  const intent = normalizeConvoyWithdrawalIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.CONVOY_WITHDRAWAL_INVALID);
  const snapshot = await services.trades.getWithdrawalSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.CONVOY_WITHDRAWAL_UNAVAILABLE);
  // The GM can withdraw during an encounter, and from a Convoy the unit's party isn't linked to.
  const gm = services.authority.isGm(context.userId) === true;
  if (handoverLockedByEncounter({ inCombat: snapshot.encounterActive, isGM: gm })) {
    return refuse(RESULT_CODES.CONVOY_LOCKED_IN_COMBAT, { convoyName: snapshot.convoy.name });
  }
  if (!gm && !snapshot.linkedConvoyUuids.includes(snapshot.convoy.actorUuid)) {
    return refuse(RESULT_CODES.CONVOY_NOT_LINKED, { targetName: snapshot.target.name });
  }
  if (snapshot.convoy.gp <= 0) return refuse(RESULT_CODES.CONVOY_EMPTY, { convoyName: snapshot.convoy.name });
  const plan = planConvoyWithdrawal({
    amount: intent.amount,
    convoyGp: snapshot.convoy.gp,
    purseValue: snapshot.target.purse?.cost ?? 0
  });
  if (!plan.ok) return plan;
  const settled = await services.trades.withdrawGold(snapshot, plan.data, context);
  if (settled.ok !== true) return refuseSettlement(services, settled, RESULT_CODES.CONVOY_STALE);
  const outcome = {
    targetActorUuid: snapshot.target.actorUuid,
    targetName: snapshot.target.name,
    convoyUuid: snapshot.convoy.actorUuid,
    convoyName: snapshot.convoy.name,
    amount: plan.data.amount,
    purseTotal: plan.data.purseAfter,
    newConvoyGp: plan.data.balanceAfter,
    requestId: context.requestId,
    userId: context.userId
  };
  services.events.publish(EVENT_IDS.CONVOY_WITHDRAWN, outcome);
  return accept(RESULT_CODES.CONVOY_WITHDRAWN, outcome);
}

/* -------------------------------------------- */
/*  Convoy deliveries                           */
/* -------------------------------------------- */

/**
 * The GM's command behind the Convoy sheet's Inbound view: deliver everything inbound, the chosen inbound items, or
 * the inbound gold. FoundryTradeRepository.deliverInbound reads the Convoy fresh and moves the gold into
 * `system.gp` and the items into its stored inventory. A selection that finds nothing inbound is refused before
 * anything is written.
 */
async function convoyDeliver(context, services) {
  const intent = normalizeConvoyDeliveryIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.CONVOY_INPUT_INVALID);
  const delivered = await services.trades.deliverInbound(intent.convoyUuid, intent, context);
  if (!delivered) return refuse(RESULT_CODES.CONVOY_UNAVAILABLE);
  if (delivered.code === RESULT_CODES.CONVOY_DELIVERY_EMPTY) {
    return refuse(RESULT_CODES.CONVOY_DELIVERY_EMPTY, { convoyName: delivered.data?.convoyName ?? '' });
  }
  if (delivered.ok !== true) return refuseSettlement(services, delivered, RESULT_CODES.CONVOY_STALE);
  const outcome = {
    convoyUuid: intent.convoyUuid,
    convoyName: delivered.data.convoyName,
    gold: delivered.data.gold,
    itemCount: delivered.data.itemCount,
    requestId: context.requestId,
    userId: context.userId
  };
  services.events.publish(EVENT_IDS.CONVOY_DELIVERED, outcome);
  return accept(RESULT_CODES.CONVOY_DELIVERED, outcome);
}

/* -------------------------------------------- */
/*  Vendor stocking                             */
/* -------------------------------------------- */

/** A GM puts one of a unit's items on a Vendor's shelf. Part of a Resource may go, joining a matching stack. */
async function vendorStock(context, services) {
  const intent = normalizeVendorStockIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.VENDOR_STOCK_INPUT_INVALID);
  const snapshot = await services.trades.getVendorStockSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.VENDOR_STOCK_UNAVAILABLE);
  const item = snapshot.source.items.find(entry => entry.id === intent.itemId) ?? null;
  const plan = planVendorStock({ item, gm: services.authority.isGm(context.userId) === true, amount: intent.amount });
  if (!plan.ok) return refuse(plan.code, plan.data);
  const moved = await services.trades.storeItems(snapshot.source, snapshot.vendor, [intent.itemId], {
    amounts: plan.amount === null ? null : { [intent.itemId]: plan.amount }
  }, context);
  if (moved.ok !== true) return refuseSettlement(services, moved, RESULT_CODES.VENDOR_STOCK_STALE);
  const outcome = {
    sourceActorUuid: snapshot.source.actorUuid,
    vendorUuid: snapshot.vendor.actorUuid,
    vendorName: snapshot.vendor.name,
    itemId: intent.itemId,
    itemName: item.name,
    amount: plan.amount,
    total: moved.total ?? null,
    stacked: moved.stacked === true,
    requestId: context.requestId,
    userId: context.userId
  };
  return accept(item.type === 'Resource' ? RESULT_CODES.VENDOR_RESOURCE_STOCKED : RESULT_CODES.VENDOR_STOCKED, outcome);
}

/* -------------------------------------------- */
/*  Convoy deposits                             */
/* -------------------------------------------- */

/** Send one possession to the party's Convoy, a Coinpurse arriving as gold instead of as an Item. */
async function convoyDeposit(context, services) {
  const intent = normalizeConvoyDepositIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.CONVOY_INPUT_INVALID);
  const snapshot = await services.trades.getConvoySnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.CONVOY_UNAVAILABLE);
  const item = snapshot.source.items.find(entry => entry.id === intent.itemId) ?? null;
  const plan = planConvoyDeposit({
    item,
    turn: snapshot.source.turn,
    linkedConvoyUuids: snapshot.convoys.map(convoy => convoy.uuid),
    convoyUuid: intent.convoyUuid,
    encounterActive: snapshot.encounterActive,
    gm: services.authority.isGm(context.userId) === true,
    amount: intent.amount
  });
  if (!plan.ok) return refuse(plan.code, plan.data);
  const convoy = snapshot.convoy ?? await services.trades.convoyView(intent.convoyUuid);
  if (!convoy) return refuse(RESULT_CODES.CONVOY_UNAVAILABLE);
  const moved = plan.gold > 0
    ? await services.trades.depositGold(snapshot.source, convoy, intent.itemId, plan.gold, context)
    : await services.trades.storeItems(snapshot.source, convoy, [intent.itemId], {
      amounts: plan.amount === null ? null : { [intent.itemId]: plan.amount }
    }, context);
  if (moved.ok !== true) return refuseSettlement(services, moved, RESULT_CODES.CONVOY_STALE);
  const outcome = {
    sourceActorUuid: snapshot.source.actorUuid,
    actorName: snapshot.source.name,
    convoyUuid: convoy.actorUuid,
    convoyName: convoy.name,
    itemId: intent.itemId,
    itemName: item.name,
    gold: plan.gold,
    amount: plan.amount,
    total: moved.total ?? null,
    stacked: moved.stacked === true,
    requestId: context.requestId,
    userId: context.userId
  };
  services.events.publish(EVENT_IDS.CONVOY_DEPOSITED, outcome);
  const code = plan.gold > 0 ? RESULT_CODES.CONVOY_DEPOSITED
    : item.type === 'Resource' ? RESULT_CODES.CONVOY_RESOURCE_STORED : RESULT_CODES.CONVOY_ITEM_STORED;
  return accept(code, outcome);
}

/* -------------------------------------------- */
/*  Trade and loot                              */
/* -------------------------------------------- */

/** Move what each side set down across to the other, then charge the acting unit's turn for the trade. */
async function trade(context, services) {
  const intent = normalizeTradeIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.TRADE_INPUT_INVALID);
  const snapshot = await services.trades.getTradeSnapshot(intent);
  if (!snapshot || targetAbsent(snapshot)) return refuse(RESULT_CODES.TRADE_UNAVAILABLE);
  const give = pickItems(snapshot.source.items, intent.giveItemIds);
  const take = pickItems(snapshot.target.items, intent.takeItemIds);
  if (!give || !take) return refuse(RESULT_CODES.TRADE_ITEM_MISSING);
  const standing = standingFacts(snapshot);
  const plan = planTrade({ ...tradeFacts(snapshot, standing), give, take });
  if (!plan.ok) return refuse(plan.code, plan.data);

  const operation = context.operation ?? null;
  try {
    const owned = { operation };
    if (give.length && !await services.trades.transferItems(snapshot.source, snapshot.target, intent.giveItemIds, owned)) {
      throw new CombatPersistenceError('economy.transfer-failed');
    }
    if (take.length && !await services.trades.transferItems(snapshot.target, snapshot.source, intent.takeItemIds, owned)) {
      throw new CombatPersistenceError('economy.transfer-failed');
    }
    await settleTradeTurn(services, Object.freeze({ ...snapshot, operation }), plan, standing);
  } catch (error) {
    const diagnostic = recordDiagnostic(services?.diagnostics, {
      sourcePath: 'foundry/adapters/document-writes/economy.mjs', error: error, detail: 'trade'
    });
    return refuse(RESULT_CODES.TRADE_STALE, {
      reasonCode: error instanceof CombatPersistenceError ? error.code : 'economy.trade-failed', diagnostic
    });
  }
  // A loot drop chest left with nothing in it is removed from the map.
  const emptied = plan.mode === TRADE_MODES.LOOT && snapshot.target.isDropChest === true
    && take.length >= snapshot.target.items.length;
  if (emptied) await services.trades.removeEmptiedContainer(snapshot.target.actorUuid, operation);
  const landed = await landInteractingUnit(services, plan.grounds, snapshot.source.actorUuid, 'trade', operation);
  const outcome = Object.freeze({
    mode: plan.mode,
    landed,
    sourceActorUuid: snapshot.source.actorUuid,
    sourceTokenUuid: snapshot.source.tokenUuid,
    sourceName: snapshot.source.name,
    targetActorUuid: snapshot.target.actorUuid,
    targetTokenUuid: snapshot.target.tokenUuid,
    targetName: snapshot.target.name,
    given: Object.freeze(give.map(item => item.name)),
    taken: Object.freeze(take.map(item => item.name)),
    bonusActionSpent: plan.spendsBonusAction === true,
    containerRemoved: emptied,
    requestId: context.requestId,
    userId: context.userId
  });
  services.events.publish(EVENT_IDS.TRADE_COMPLETED, outcome);
  return accept(RESULT_CODES.TRADE_COMPLETED, outcome);
}

/**
 * Charge the acting unit's turn for a trade: its bonus action for a trade in an encounter (spendBonusAction), or,
 * for looting outside free exploration, fix the square it walked to while its turn goes on (commitSquare).
 */
async function settleTradeTurn(services, snapshot, plan, standing) {
  if (!plan.spendsBonusAction && !(plan.commitsSquare && standing.planning)) return;
  const settled = plan.spendsBonusAction
    ? await services.trades.spendBonusAction(snapshot, standing.resolution)
    : await services.trades.commitSquare(snapshot, standing.resolution);
  if (settled !== true) throw new CombatPersistenceError('economy.turn-settlement-failed');
}

/* -------------------------------------------- */
/*  Steal                                       */
/* -------------------------------------------- */

/** The steal command: roll Finesse against the combined DC of the chosen items, which move only on a success. */
async function steal(context, services) {
  const intent = normalizeStealIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.STEAL_INPUT_INVALID);
  const snapshot = await services.trades.getTradeSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.TRADE_UNAVAILABLE);
  const items = pickItems(snapshot.target.items, intent.itemIds);
  if (!items) return refuse(RESULT_CODES.TRADE_ITEM_MISSING);
  const standing = standingFacts(snapshot);
  const plan = planSteal({ ...tradeFacts(snapshot, standing), items });
  if (!plan.ok) return refuse(plan.code, plan.data);

  return attemptSteal(context, services,
    { snapshot: Object.freeze({ ...snapshot, operation: context.operation ?? null }), plan, standing, intent, items });
}

/**
 * Roll the theft check and post its card, wait STEAL_ATTEMPT_TIMING.diceSettleHold, then grant the skill XP, move
 * the items on a success, award the Steal Ability's level XP (settleStealExperience), show the verdict and end the
 * turn when the plan says so. The level XP card plays after the theft's event is published.
 */
async function attemptSteal(context, services, { snapshot, plan, standing, intent, items }) {
  let roll;
  let check;
  let experience = null;
  try {
    check = unitSkillCheck(snapshot.source, STEAL_SKILL_KEY, plan.dc);
    roll = await services.checks.roll(snapshot.source.actorUuid, check,
      { requestId: context.requestId, operation: snapshot.operation });
    await presentUnitCheck(services, context, snapshot.source,
      { check, roll, effectName: 'Steal', targetName: snapshot.target.name, detail: 'steal-card' });
    await services.wait(STEAL_ATTEMPT_TIMING.diceSettleHold);
    await grantSkillExperience(services, snapshot.source.actorUuid, STEAL_SKILL_KEY, undefined, context);
    if (roll.success === true && !await services.trades.transferItems(snapshot.target, snapshot.source, intent.itemIds,
      { operation: snapshot.operation })) {
      throw new CombatPersistenceError('economy.transfer-failed');
    }
    experience = await settleStealExperience(services, snapshot, roll.success === true);
    await presentStealVerdict(services, snapshot, roll, items, context);
    await services.wait(STEAL_ATTEMPT_TIMING.verdictHold);
    if (plan.endsTurn) await settleStealTurn(services, snapshot, standing);
  } catch (error) {
    const diagnostic = recordDiagnostic(services?.diagnostics, {
      sourcePath: 'foundry/adapters/document-writes/economy.mjs', error: error, detail: 'attemptSteal'
    });
    return refuse(RESULT_CODES.TRADE_STALE, {
      reasonCode: error instanceof CombatPersistenceError ? error.code : RESULT_CODES.STEAL_FAILED, diagnostic
    });
  }
  const landed = await landInteractingUnit(services, plan.grounds, snapshot.source.actorUuid, 'attemptSteal',
    snapshot.operation);
  const outcome = Object.freeze({
    succeeded: roll.success === true,
    landed,
    sourceActorUuid: snapshot.source.actorUuid,
    sourceTokenUuid: snapshot.source.tokenUuid,
    sourceName: snapshot.source.name,
    targetActorUuid: snapshot.target.actorUuid,
    targetTokenUuid: snapshot.target.tokenUuid,
    targetName: snapshot.target.name,
    taken: Object.freeze(roll.success === true ? items.map(item => item.name) : []),
    dc: check.dc,
    total: roll.total,
    turnEnded: plan.endsTurn === true,
    requestId: context.requestId,
    userId: context.userId
  });
  services.events.publish(EVENT_IDS.STEAL_ATTEMPTED, outcome);
  if (experience?.settlements.length) {
    await services.progression.publishCombatExperience({ settlements: experience.settlements, context });
  }
  return accept(roll.success === true ? RESULT_CODES.STEAL_SUCCEEDED : RESULT_CODES.STEAL_FAILED, outcome);
}

/**
 * Award Steal's level XP with the same rules and per-encounter counter as an item use (settleTableExperience):
 * Lords and Retainers only, and nothing outside a running encounter. Steal runs no effect steps, so a successful
 * theft counts as a harmful status on the target; a missed theft counts nothing, though a flat XP entry still pays.
 * Both writes are undone if the steal fails.
 */
async function settleStealExperience(services, snapshot, stolen) {
  const table = snapshot.stealExperience;
  if (!table?.entry || !earnsCharacterExperience(snapshot.source.actorType)) return null;
  const source = {
    actorUuid: snapshot.source.actorUuid, actorType: snapshot.source.actorType, level: table.casterLevel
  };
  const mark = { actorUuid: snapshot.target.actorUuid, actorType: snapshot.target.actorType, ...table.mark };
  const impacts = stolen ? [unitImpact(mark.actorUuid, { harmful: { status: true } })] : [];
  return settleTableExperience({
    progression: services.progression,
    recordUse: use => services.trades.recordExperienceUse(snapshot, use)
  }, {
    table,
    source,
    targets: [experienceTarget(source, mark, impacts)],
    operation: snapshot.operation,
    failureCode: 'economy.experience-failed'
  });
}

/** Present the theft verdict using the requester’s roll visibility. */
function presentStealVerdict(services, snapshot, roll, items, context) {
  const succeeded = roll.success === true;
  return presentSafely(services, economyPresentationMessage(
    succeeded ? ECONOMY_PRESENTATION_EVENTS.STEAL_SUCCEEDED : ECONOMY_PRESENTATION_EVENTS.STEAL_FAILED,
    {
      actorUuid: snapshot.source.actorUuid,
      actorName: snapshot.source.name,
      actorImage: snapshot.source.image,
      avatarScale: snapshot.source.avatarScale ?? 1,
      items: items.map(item => ({ name: item.name, image: item.image })),
      requester: context.requester
        ?? { userId: String(context.userId ?? ''), messageMode: String(context.messageMode ?? 'public') }
    }
  ));
}

/** A theft ends the turn whether or not it lands, so it takes every remaining slot with it. */
async function settleStealTurn(services, snapshot, standing) {
  // A unit with no movement plan has no turn to end here.
  if (!snapshot.source.movement) return;
  if (!standing.resolution) throw new CombatPersistenceError('economy.turn-settlement-failed');
  if (await services.trades.spendTurn(snapshot, standing.resolution) !== true) {
    throw new CombatPersistenceError('economy.turn-settlement-failed');
  }
}

/* -------------------------------------------- */
/*  Skill checks                                */
/* -------------------------------------------- */

/**
 * Post a rolled check's card through checkPresentation.presentSkill, for a theft or a haggle. A card that fails is
 * recorded and the command goes on.
 * @param {object} unit The rolling unit: `actorUuid`, `name`, `image` and `avatarScale`.
 */
async function presentUnitCheck(services, context, unit, { check, roll, effectName, targetName, detail }) {
  try {
    await services.checkPresentation.presentSkill({
      requester: context.requester ?? { userId: context.userId, messageMode: context.messageMode },
      actorUuid: unit.actorUuid,
      actorName: unit.name,
      actorImage: unit.image,
      avatarScale: unit.avatarScale,
      dc: check.dc,
      natural: roll.natural,
      total: roll.total,
      success: roll.success,
      effectName,
      targetName,
      check,
      roll
    });
  } catch (error) {
    recordAbsorbed(services, error, detail, DIAGNOSTIC_SOURCES.ECONOMY);
  }
}

/** The check a unit rolls with one of its skills (buildSkillCheck), from its skill ranks and attributes. */
function unitSkillCheck(unit, skillKey, dc) {
  const skill = SKILL_BY_KEY[skillKey];
  return buildSkillCheck({
    skillKey,
    mode: 'standard',
    dc,
    rank: unit.skills?.[skillKey],
    statValue: unit.attributes?.[skill.stat],
    actorType: unit.actorType,
    blessed: unit.blessed
  });
}

/* -------------------------------------------- */
/*  Shared facts                                */
/* -------------------------------------------- */

/**
 * Where the acting unit stands. With an open plan, resolveStandingDestination finds its square. A square it
 * shares with another unit resolves to none, which `squareShared` reports.
 */
function standingFacts(snapshot) {
  const movement = snapshot.source.movement;
  const planning = movement?.movementPlanning === true;
  const resolution = movement ? resolveStandingDestination(movement) : null;
  return { planning, resolution, squareShared: planning && !resolution };
}

function tradeFacts(snapshot, standing = standingFacts(snapshot)) {
  return {
    source: snapshot.source,
    target: snapshot.target,
    squareShared: standing.squareShared,
    friendly: snapshot.friendly === true,
    hostile: snapshot.hostile === true,
    distance: snapshot.distance,
    sameElevation: snapshot.sameElevation !== false,
    sourceAirborne: snapshot.sourceAirborne === true,
    targetAirborne: snapshot.targetAirborne === true,
    sourceLandingBlocked: standsOverObstacle(snapshot.source.movement),
    targetHidden: snapshot.targetHidden === true,
    encounterRunning: snapshot.encounterRunning === true,
    exploring: snapshot.exploring === true
  };
}

/** Whether the trade's target is a hidden fixture (a Loot pile or a Chest), which isn't there to trade with. */
function targetAbsent(snapshot) {
  return fixtureHidden({ documentType: snapshot.target?.kind, hidden: snapshot.targetHidden });
}

/** The named Items in the order named, or null when the side no longer carries one of them. */
function pickItems(items, ids) {
  const picked = [];
  for (const id of ids) {
    const item = items.find(entry => entry.id === id);
    if (!item) return null;
    picked.push(item);
  }
  return picked;
}

/* -------------------------------------------- */
/*  Vendor shop                                 */
/* -------------------------------------------- */

/**
 * Buy one line from a vendor. FoundryTradeRepository.settlePurchase delivers the goods to the buyer or its Convoy,
 * charges the purse and then the Convoy, and credits the vendor.
 */
async function vendorPurchase(context, services) {
  const intent = normalizeVendorPurchaseIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.VENDOR_PURCHASE_UNAVAILABLE);
  return (await settleVendorPurchase(intent, services, context)).result;
}

/** Sell one carried Item, or a quantity of a Resource. A vendor short of coin still buys and pays what it has. */
async function vendorSell(context, services) {
  const intent = normalizeVendorSaleIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.VENDOR_SALE_UNAVAILABLE);
  return (await settleVendorSale(intent, services, context)).result;
}

async function settleVendorPurchase(intent, services, context) {
  const facts = await services.trades.getPurchaseFacts(intent);
  if (!facts) return { result: refuse(RESULT_CODES.VENDOR_PURCHASE_UNAVAILABLE), facts: null, plan: null };
  const plan = planVendorPurchase({ ...facts, quantity: intent.quantity });
  if (!plan.ok) return { result: refuse(plan.code, plan.data), facts, plan: null };
  const settled = await services.trades.settlePurchase(facts, plan.data, context);
  if (settled.ok !== true) {
    return { result: refuseSettlement(services, settled, RESULT_CODES.VENDOR_SETTLEMENT_STALE), facts, plan: null,
      failed: settlementFailed(settled) };
  }
  await settleShopVisit(services, facts, facts.buyer, 'vendorPurchase', context.operation ?? null);
  const outcome = Object.freeze({ ...plan.data, boughtElsewhere: facts.convoyFunded, requestId: context.requestId });
  services.events.publish(EVENT_IDS.VENDOR_TRADED, outcome);
  return { result: accept(RESULT_CODES.VENDOR_PURCHASED, outcome), facts, plan: plan.data };
}

async function settleVendorSale(intent, services, context) {
  const facts = await services.trades.getSaleFacts(intent);
  if (!facts) return { result: refuse(RESULT_CODES.VENDOR_SALE_UNAVAILABLE), facts: null, plan: null };
  const plan = planVendorSale({
    seller: facts.seller, vendor: facts.vendor, source: facts.source, item: facts.item, reach: facts.reach,
    quantity: intent.quantity
  });
  if (!plan.ok) return { result: refuse(plan.code, plan.data), facts, plan: null };
  const settled = await services.trades.settleSale(facts, plan.data, context);
  if (settled.ok !== true) {
    return { result: refuseSettlement(services, settled, RESULT_CODES.VENDOR_SETTLEMENT_STALE), facts, plan: null,
      failed: settlementFailed(settled) };
  }
  await settleShopVisit(services, facts, facts.seller, 'vendorSell', context.operation ?? null);
  const outcome = Object.freeze({ ...plan.data, requestId: context.requestId });
  services.events.publish(EVENT_IDS.VENDOR_TRADED, outcome);
  return { result: accept(RESULT_CODES.VENDOR_SOLD, outcome), facts, plan: plan.data };
}

/* -------------------------------------------- */
/*  Vendor checkout                             */
/* -------------------------------------------- */

/** Settle a shop basket line by line (settleBasket), then post one receipt card for the whole basket. */
async function vendorCheckout(context, services) {
  const intent = normalizeVendorCheckoutIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.VENDOR_CHECKOUT_UNAVAILABLE);
  const receipt = await settleBasket(intent, services, context);
  if (receipt.aborted || !receipt.lines.length) {
    return receipt.refusal ?? refuse(RESULT_CODES.VENDOR_CHECKOUT_UNAVAILABLE);
  }
  await presentSafely(services, shopReceiptMessage(intent, receipt));
  return accept(RESULT_CODES.VENDOR_CHECKOUT_SETTLED, Object.freeze({
    mode: intent.mode,
    units: receipt.units,
    gold: receipt.gold,
    failed: receipt.failed.length,
    lines: Object.freeze(receipt.lines.map(line => Object.freeze({ ...line }))),
    requestId: context.requestId
  }));
}

/**
 * Buy or sell a discrete good one unit at a time, and a Resource stack in one go. A line's first refusal ends that
 * line, and the basket keeps what already went through. A line whose writes failed part-way abandons the whole
 * basket instead, because every line is undone together when the command fails.
 */
async function settleBasket(intent, services, context) {
  const selling = intent.mode === VENDOR_CHECKOUT_MODES.SELL;
  const receipt = { lines: [], failed: [], units: 0, gold: 0, first: null, last: null, refusal: null, aborted: false };
  let sequence = 0;
  for (const line of intent.lines) {
    let remaining = line.quantity;
    while (remaining > 0 && !receipt.aborted) {
      const payload = vendorCheckoutLinePayload(intent, line.itemId, remaining);
      const lineIntent = selling ? normalizeVendorSaleIntent(payload) : normalizeVendorPurchaseIntent(payload);
      const lineContext = { ...context, requestId: `${context.requestId}:${sequence += 1}` };
      const settled = lineIntent
        ? await (selling ? settleVendorSale : settleVendorPurchase)(lineIntent, services, lineContext)
        : { result: refuse(RESULT_CODES.VENDOR_CHECKOUT_UNAVAILABLE), facts: null, plan: null };
      if (!settled.plan) {
        receipt.failed.push({ itemId: line.itemId, name: settled.facts?.item?.name ?? '', code: settled.result.code });
        receipt.refusal ??= settled.result;
        receipt.aborted = settled.failed === true;
        break;
      }
      recordBasketLine(receipt, settled, line.itemId, selling);
      // A Resource line goes through in one pass; a discrete good goes one unit per pass.
      remaining -= Math.max(1, Number(settled.plan.units) || 1);
    }
    if (receipt.aborted) break;
  }
  return receipt;
}

function recordBasketLine(receipt, settled, itemId, selling) {
  const units = Number(settled.plan.units) || 1;
  const gold = Number(selling ? settled.plan.paid : settled.plan.total) || 0;
  const entry = receipt.lines.find(line => line.itemId === itemId);
  if (entry) {
    entry.units += units;
    entry.gold += gold;
  } else {
    receipt.lines.push({ itemId, name: settled.facts.item.name, image: settled.facts.item.image, units, gold });
  }
  receipt.units += units;
  receipt.gold += gold;
  receipt.first ??= settled;
  receipt.last = settled;
}

/** The shop receipt card: who traded with whom, the goods, the gold moved, and both purses before and after. */
function shopReceiptMessage(intent, receipt) {
  const selling = intent.mode === VENDOR_CHECKOUT_MODES.SELL;
  const first = receipt.first.facts;
  const last = receipt.last.plan;
  const unit = selling ? first.seller : first.buyer;
  const convoy = selling ? first.source.isConvoy : first.convoyFunded;
  const holding = selling ? first.source : first.destination;
  const purseBefore = selling
    ? (convoy ? first.source.gp : first.source.purseGp)
    : first.funding.purseGp + first.funding.convoyGp;
  const purseAfter = selling ? last.balanceAfter : last.purseAfter + last.convoyAfter;
  return economyPresentationMessage(ECONOMY_PRESENTATION_EVENTS.SHOP_SETTLED, {
    actorUuid: unit.uuid,
    actorName: unit.name,
    actorImage: unit.image,
    avatarScale: unit.avatarScale ?? 1,
    vendorName: first.vendor.name,
    vendorImage: first.vendor.image,
    mode: intent.mode,
    holdingName: convoy ? String(holding.name ?? 'Convoy') : '',
    items: receipt.lines.map(line => ({ name: line.name, image: line.image, units: line.units, gold: line.gold })),
    units: receipt.units,
    gold: receipt.gold,
    failed: receipt.failed.length,
    purse: { before: purseBefore, after: purseAfter },
    vendor: { before: first.vendor.gp, after: last.vendorGpAfter }
  });
}

/**
 * Land a flying unit that reached down to the counter, once its purchase, sale or haggle is done. Its movement plan
 * stays open until it leaves the shop (ui/controls/interaction.mjs), so it keeps its movement lock while it shops.
 */
async function settleShopVisit(services, facts, unit, detail, operation = null) {
  const grounded = groundsOnInteraction({
    sourceAirborne: facts.reach?.buyerAirborne, targetAirborne: facts.reach?.vendorAirborne, committed: true
  });
  await landInteractingUnit(services, grounded, unit.uuid, detail, operation);
}

/** Land a flying unit that reached down to interact. A refused landing is recorded and reported as `false`. */
async function landInteractingUnit(services, grounded, actorUuid, detail, operation = null) {
  if (!grounded) return null;
  const landed = await services.movements.setActorGrounded(actorUuid, true, operation) === true;
  if (!landed) recordAbsorbed(services, new Error('economy.landing-refused'), detail, DIAGNOSTIC_SOURCES.ECONOMY);
  return landed;
}

/** Write which goods a vendor buys from players. */
async function vendorMerchandise(context, services) {
  const intent = normalizeVendorMerchandiseIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.VENDOR_STOCK_INPUT_INVALID);
  const settled = await services.trades.setMerchandise(intent.vendorUuid, intent.changes);
  if (!settled) return refuse(RESULT_CODES.VENDOR_STOCK_UNAVAILABLE);
  return accept(RESULT_CODES.VENDOR_MERCHANDISE_SET, Object.freeze({ ...settled, requestId: context.requestId }));
}

/* -------------------------------------------- */
/*  Haggle                                      */
/* -------------------------------------------- */

/**
 * Haggle at a vendor during free exploration (the vendor shop's Haggle button): the unit at the counter spends its
 * Downtime Action and rolls Trading with no DC. The total shifts this vendor's prices for the unit's party, or the
 * unit alone if it has none, until the GM's Reset Downtime clears it.
 */
async function haggle(context, services) {
  const intent = normalizeHaggleIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.VENDOR_HAGGLE_UNAVAILABLE);
  const facts = await services.trades.getHaggleFacts(intent);
  if (!facts) return refuse(RESULT_CODES.VENDOR_HAGGLE_UNAVAILABLE);
  const plan = planHaggle(facts);
  if (!plan.ok) return plan;
  const rolled = await rollHaggle(context, services, facts);
  if (rolled.refusal) return rolled.refusal;
  const planned = planHaggleOutcome({ vendor: facts.vendor, key: facts.key, total: rolled.roll.total });
  const settled = await services.trades.settleHaggle(facts, {
    commitment: actionLaneSpend(`Haggle: ${facts.vendor.name}`), haggles: planned.haggles
  }, context);
  if (settled.ok !== true) return refuseSettlement(services, settled, RESULT_CODES.VENDOR_SETTLEMENT_STALE);
  await grantSkillExperience(services, facts.buyer.uuid, HAGGLE_SKILL_KEY, { amount: planned.experience }, context);
  await settleShopVisit(services, facts, facts.buyer, 'haggle', context.operation ?? null);
  await presentSafely(services, haggleCardMessage(facts, rolled.roll, planned, context));
  const outcome = Object.freeze({
    buyerActorUuid: facts.buyer.uuid,
    vendorUuid: facts.vendor.uuid,
    vendorName: facts.vendor.name,
    total: rolled.roll.total,
    shift: planned.shift,
    experience: planned.experience,
    dispositionBefore: planned.dispositionBefore,
    dispositionAfter: planned.dispositionAfter,
    requestId: context.requestId
  });
  services.events.publish(EVENT_IDS.VENDOR_HAGGLED, outcome);
  return accept(RESULT_CODES.VENDOR_HAGGLED, outcome);
}

/**
 * Roll the haggling unit's Trading check with no DC through services.checks, post its check card, then wait
 * HAGGLE_TIMING.diceSettleHold before anything is written. A check that cannot be rolled refuses the haggle with a
 * diagnostic, and nothing has been written by then.
 * @returns {Promise<{roll?: object, refusal?: object}>}
 */
async function rollHaggle(context, services, facts) {
  const unit = { ...facts.buyer, actorUuid: facts.buyer.uuid };
  try {
    const check = unitSkillCheck(unit, HAGGLE_SKILL_KEY, null);
    const roll = await services.checks.roll(unit.actorUuid, check,
      { requestId: context.requestId, operation: context.operation ?? null });
    await presentUnitCheck(services, context, unit,
      { check, roll, effectName: 'Haggle', targetName: facts.vendor.name, detail: 'haggle-card' });
    await services.wait(HAGGLE_TIMING.diceSettleHold);
    return { roll };
  } catch (error) {
    const diagnostic = recordDiagnostic(services.diagnostics, {
      sourcePath: 'engine/economy/trade.mjs', source: DIAGNOSTIC_SOURCES.ECONOMY, error, detail: 'rollHaggle'
    });
    const data = { reasonCode: 'economy.haggle-roll-failed', diagnostic };
    return { refusal: refuse(RESULT_CODES.VENDOR_HAGGLE_UNAVAILABLE, data) };
  }
}

/** The haggle's result card for EconomyOutcomePresentation: who haggled with which Vendor, and what it moved. */
function haggleCardMessage(facts, roll, planned, context) {
  return economyPresentationMessage(ECONOMY_PRESENTATION_EVENTS.HAGGLE_SETTLED, {
    actorUuid: facts.buyer.uuid,
    actorName: facts.buyer.name,
    actorImage: facts.buyer.image,
    avatarScale: facts.buyer.avatarScale ?? 1,
    vendorName: facts.vendor.name,
    vendorImage: facts.vendor.image,
    total: roll.total,
    shift: planned.shift,
    dispositionBefore: planned.dispositionBefore,
    dispositionAfter: planned.dispositionAfter,
    requester: cardRequester(context)
  });
}

/* -------------------------------------------- */
/*  Economy queries                             */
/* -------------------------------------------- */

/**
 * Read-only Convoy, shop and trade views for the menus (the economy API in api/facade.mjs). Shop prices follow the
 * disposition the buyer's party sees, except that items the party sold here can be bought back for what it got
 * (shelfPrice). Goods this vendor sold are shown as not accepted (`soldHere`). The shop view also says whether the
 * Haggle button is available.
 */
export function createEconomyQueries({ trades }) {
  return Object.freeze({
    inspectConvoys: actorUuid => trades.linkedConvoys(String(actorUuid ?? '')),
    async inspectShop(intent = {}) {
      const normalized = normalizeShopIntent({
        buyerTokenUuid: intent.buyerTokenUuid, vendorTokenUuid: intent.vendorTokenUuid
      });
      if (!normalized) return null;
      const snapshot = await trades.getShopSnapshot(normalized);
      if (!snapshot) return null;
      const reach = resolveVendorReach(snapshot.reach);
      const vendorUuid = snapshot.vendor.actorUuid;
      const offered = item => Object.freeze({
        ...item,
        price: sellPrice(item, snapshot.disposition),
        accepted: vendorAcceptsItem(snapshot.vendor.accepted, item) && !soldByVendor(item, vendorUuid),
        soldHere: soldByVendor(item, vendorUuid)
      });
      const pricing = { disposition: snapshot.disposition, vendorUuid, key: snapshot.buyerKey };
      return Object.freeze({
        refusal: reach.ok ? '' : reach.code,
        refusalData: reach.data ?? Object.freeze({}),
        disposition: snapshot.disposition,
        baseDisposition: snapshot.baseDisposition,
        haggleBonus: snapshot.haggle.bonus,
        haggle: resolveHaggleStanding({
          exploring: snapshot.exploring, haggled: snapshot.haggle.haggled, buyer: snapshot.buyer
        }),
        exploring: snapshot.exploring,
        convoys: Object.freeze(snapshot.convoys.map(convoy => Object.freeze({
          ...convoy, goods: Object.freeze(convoy.goods.map(offered))
        }))),
        buyer: Object.freeze({ ...snapshot.buyer, goods: Object.freeze(snapshot.buyer.goods.map(offered)) }),
        vendor: Object.freeze({
          ...snapshot.vendor,
          stock: Object.freeze(snapshot.vendor.stock
            .map(item => Object.freeze({ ...item, price: shelfPrice(item, pricing) })))
        })
      });
    },
    async inspectTrade(intent = {}) {
      const mode = String(intent.mode ?? TRADE_MODES.TRADE);
      const normalized = normalizeTradePair({
        sourceTokenUuid: intent.sourceTokenUuid,
        targetTokenUuid: intent.targetTokenUuid
      });
      if (!normalized) return null;
      const snapshot = await trades.getTradeSnapshot(normalized);
      if (!snapshot || targetAbsent(snapshot)) return null;
      const stealing = mode === TRADE_MODES.STEAL;
      const takeOnly = !stealing && isTakeOnlyTarget(snapshot.target);
      const probe = stealing
        ? planSteal({ ...tradeFacts(snapshot), items: [] })
        : planTrade({ ...tradeFacts(snapshot), give: [], take: [] });
      const resolvedMode = stealing ? TRADE_MODES.STEAL : resolveTradeMode(snapshot.target);
      const refusal = probe.ok || probe.code === RESULT_CODES.TRADE_NOTHING_SELECTED ? '' : probe.code;
      return Object.freeze({
        mode: resolvedMode ?? TRADE_MODES.TRADE,
        takeOnly,
        refusal,
        refusalData: probe.data ?? Object.freeze({}),
        source: sideView(snapshot.source,
          stealing || takeOnly ? [] : snapshot.source.items.filter(isTradeableItem), false),
        target: sideView(snapshot.target, stealing
          ? snapshot.target.items.filter(isStealableItem)
          : snapshot.target.items.filter(isTradeableItem), stealing)
      });
    }
  });
}

function sideView(side, items, stealing) {
  return Object.freeze({
    actorUuid: side.actorUuid,
    tokenUuid: side.tokenUuid,
    name: side.name,
    image: side.image,
    pixelArt: side.pixelArt === true,
    kind: side.kind,
    owned: side.owned === true,
    room: side.kind === 'Character' ? Object.freeze({
      equipmentCount: side.equipmentCount,
      pocketCount: side.pocketCount,
      equipmentCapacity: side.equipmentCapacity,
      pocketCapacity: side.pocketCapacity,
      carriesArmor: side.carriesArmor === true
    }) : null,
    items: Object.freeze(items.map(item => Object.freeze({
      id: item.id,
      name: item.name,
      image: item.image,
      type: item.type,
      itemType: item.itemType,
      tab: side.kind === 'Object' ? 'all' : tradeItemTab(item),
      quantity: quantityLabel(item),
      cost: Number(item.cost) || 0,
      isEquipped: item.isEquipped === true,
      stealDc: stealing ? stealItemDC(item) : 0
    })))
  });
}

function quantityLabel(item) {
  if (item.type === 'Resource') return `×${Number(item.amount) || 0}`;
  if (Number(item.usesMax) > 0) return `${Number(item.usesCurrent) || 0}/${Number(item.usesMax) || 0}`;
  return '1';
}
