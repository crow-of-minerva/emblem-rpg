/** @layer foundry/adapters/document-writes */
import { BG3_HUD_CORE_ID } from '../../../contracts/domains/bg3-hud.mjs';
import { DOWNTIME_FLAG } from '../../../contracts/domains/downtime.mjs';
import { CONVOY_INBOUND_FLAG, ECONOMY_SETTLEMENT_OUTCOMES } from '../../../contracts/domains/economy.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { RESULT_CODES } from '../../../contracts/results.mjs';
import { areFactionsFriendly, areFactionsHostile, characterAvatarScale } from '../../../game/character/rules.mjs';
import {
  VENDOR_BUYBACK_FLAG, VENDOR_SOLD_FLAG, hasVendorTags, matchingResourceStack, vendorTags
} from '../../../game/character/inventory.mjs';
import { downtimeCommitment } from '../../../game/downtime/rules.mjs';
import { FALLBACK_COINPURSE, carriedGold, isCoinpurseItem } from '../../../game/economy/coinpurse.mjs';
import { effectiveDisposition, haggleEntries, haggleEntry, haggleKey } from '../../../game/economy/haggle.mjs';
import { isInboundItem, partitionConvoyItems, planConvoyDelivery } from '../../../game/economy/inbound.mjs';
import {
  clampDisposition, isShelfEntry, isShopGood, purchasedTags, shelvedTags
} from '../../../game/economy/vendor.mjs';
import { isStealAbility } from '../../../game/economy/trade.mjs';
import { fixtureHidden } from '../../../game/objects/rules.mjs';
import { projectActivationExperience, projectExperienceFacts } from '../projections/items.mjs';
import { recordActivationExperienceUse } from './effect-execution.mjs';
import {
  projectLinkedConvoys,
  projectPurchaseDestination,
  projectShopConvoy,
  projectShopReach,
  projectTradeItem,
  projectTradeSide,
  projectVendorItem
} from '../projections/economy.mjs';
import { isAirborneActor } from '../projections/combat-context.mjs';
import { encounterUnderway, findSceneCombat, sceneExplorationActive } from '../projections/encounters.mjs';
import { projectActorPartyId } from '../projections/parties.mjs';
import { collectionValues, finite, structurallyEqual } from '../../../lib/core/runtime.mjs';
import {
  forcedDeletion, resolveActor, resolveToken, tokenFootprintCells as footprintCells
} from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/** Where a Vendor keeps each party's haggle with it (game/economy/haggle.mjs). */
const VENDOR_HAGGLES_PATH = 'system.haggles';

/** Where a unit's downtime commitment lives, the flag every downtime activity spends. */
const DOWNTIME_COMMITMENT_PATH = `flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`;

/* -------------------------------------------- */
/*  Trade repository                            */
/* -------------------------------------------- */

/**
 * Reads and writes for engine/economy: trades and thefts between units, Convoy deposits, withdrawals and
 * deliveries, coinpurses, and vendor shops with their haggles.
 *
 * Each write re-reads what it planned on and gives up as stale if it changed, saves the old values of everything it
 * will change on the command's operation (its undo record), then writes. CommandDispatcher keeps the changes when
 * the command succeeds and puts the documents back when it doesn't, so nothing here has to undo its own writes.
 */
export class FoundryTradeRepository {
  constructor({ movements, parties = null }) {
    this.movements = movements;
    this.parties = parties;
  }

  /** The Convoys a unit may send to: the one linked to the party of any player who owns it. */
  async linkedConvoys(actorUuid) {
    const actor = await resolveActor(actorUuid);
    return actor ? projectLinkedConvoys(actor, this.parties) : Object.freeze([]);
  }

  /** One Convoy as the deposit sees it. */
  async convoyView(convoyUuid) {
    return this.convoyViewSync(convoyUuid);
  }

  convoyViewSync(convoyUuid) {
    const convoy = this.parties?.resolveConvoy?.(String(convoyUuid ?? '')) ?? null;
    if (!convoy) return null;
    return Object.freeze({ uuid: String(convoy.uuid), actorUuid: String(convoy.uuid), name: String(convoy.name ?? 'Convoy') });
  }

  /** The giving unit's possessions and turn, the Convoys it may reach, and whether an encounter is underway. */
  async getConvoySnapshot(intent) {
    const actor = await resolveActor(intent.sourceActorUuid);
    if (!actor || actor.type !== 'Character') return null;
    const convoys = await this.linkedConvoys(String(actor.uuid));
    return Object.freeze({
      source: Object.freeze({
        actorUuid: String(actor.uuid),
        name: String(actor.name ?? ''),
        items: Object.freeze(collectionValues(actor.items).map(projectTradeItem)),
        turn: Object.freeze({
          actionAvailable: actor.system?.turn?.actionAvailable === true,
          movementAvailable: actor.system?.turn?.movementAvailable === true
        })
      }),
      convoys,
      convoy: convoys.find(entry => entry.uuid === intent.convoyUuid) ?? null,
      encounterActive: encounterUnderway()
    });
  }

  /** The purses a unit or Convoy holds, for the coinpurse tidy-up. An undelivered purse isn't the Convoy's yet. */
  async getCoinpurseSnapshot(actorUuid) {
    const actor = await resolveActor(actorUuid);
    if (!actor) return null;
    const purses = storedItems(actor).map(projectTradeItem).filter(isCoinpurseItem);
    return Object.freeze({
      actorUuid: String(actor.uuid),
      name: String(actor.name ?? ''),
      kind: String(actor.type ?? ''),
      gp: Math.max(0, Math.floor(Number(actor.system?.gp) || 0)),
      purses: Object.freeze(purses.map(purse => Object.freeze({ id: purse.id, cost: purse.cost })))
    });
  }

  /** Apply a purse plan: dissolve the purses into Convoy gold, or grow the first purse and delete the rest. */
  async settleCoinpurse(snapshot, plan, context) {
    const actor = await resolveActor(snapshot.actorUuid);
    if (!actor) return stale('economy.aggregate-missing');
    if (!structurallyEqual(await this.getCoinpurseSnapshot(snapshot.actorUuid), snapshot)) {
      return stale('economy.facts-stale');
    }
    const ids = plan.data.deleteIds ?? [];
    const spends = plan.data.gpAfter !== undefined;
    const keep = plan.data.keepId && plan.data.costChanged ? actor.items.get(plan.data.keepId) : null;
    await context.operation?.capture({
      documents: [...(spends ? [actor] : []), ...(keep ? [keep] : [])],
      deleting: ids.map(id => actor.items.get(id)).filter(Boolean)
    });
    return settleWrites(async () => {
      if (spends) await actor.update({ 'system.gp': plan.data.gpAfter }, { emblemCoinpurseSettlement: true });
      if (ids.length) await actor.deleteEmbeddedDocuments('Item', [...ids], { emblemCoinpurseSettlement: true });
      if (keep) await keep.update({ 'system.cost': plan.data.total }, { emblemCoinpurseSettlement: true });
    });
  }

  /** The unit receiving gold, its purse, the Convoy paying, and the Convoys the unit's party may draw on. */
  async getWithdrawalSnapshot(intent) {
    const target = await resolveActor(intent.targetActorUuid);
    const convoy = await resolveActor(intent.convoyUuid);
    if (!target || target.type !== 'Character' || !convoy || convoy.type !== 'Convoy') return null;
    const purse = collectionValues(target.items).map(projectTradeItem).find(isCoinpurseItem) ?? null;
    const linked = await this.linkedConvoys(String(target.uuid));
    return Object.freeze({
      target: Object.freeze({
        actorUuid: String(target.uuid), name: String(target.name ?? ''),
        purse: purse ? Object.freeze({ id: purse.id, cost: purse.cost }) : null
      }),
      convoy: Object.freeze({
        actorUuid: String(convoy.uuid), name: String(convoy.name ?? 'Convoy'),
        gp: Math.max(0, Math.floor(Number(convoy.system?.gp) || 0))
      }),
      linkedConvoyUuids: Object.freeze(linked.map(entry => entry.actorUuid)),
      encounterActive: encounterUnderway()
    });
  }

  /** Debit the Convoy, then grow the unit's purse or give it one. */
  async withdrawGold(snapshot, plan, context) {
    const target = await resolveActor(snapshot.target.actorUuid);
    const convoy = await resolveActor(snapshot.convoy.actorUuid);
    if (!target || !convoy) return stale('economy.aggregate-missing');
    if (!structurallyEqual(await this.getWithdrawalSnapshot({
      targetActorUuid: snapshot.target.actorUuid, convoyUuid: snapshot.convoy.actorUuid
    }), snapshot)) return stale('economy.facts-stale');
    const purse = snapshot.target.purse ? target.items.get(snapshot.target.purse.id) : null;
    const mintedId = purse ? '' : claimedDocumentId();
    const payload = purse ? null : await coinpurseTemplate(plan.purseAfter, mintedId);
    await context.operation?.capture({
      documents: [convoy, ...(purse ? [purse] : [])],
      creating: payload ? [{ parent: target, documentName: 'Item', ids: [mintedId] }] : []
    });
    return settleWrites(async () => {
      await convoy.update({ 'system.gp': plan.balanceAfter }, { emblemCoinpurseSettlement: true });
      if (purse) await purse.update({ 'system.cost': plan.purseAfter }, { emblemCoinpurseSettlement: true });
      else await target.createEmbeddedDocuments('Item', [payload], { keepId: true, emblemTransfer: true });
    });
  }

  /**
   * Deliver a Convoy's inbound content for convoyDeliver in engine/economy/trade.mjs, planned by planConvoyDelivery
   * from the Convoy as it is now: the gold moves from `system.inboundGp` into `system.gp`, and each Item loses its
   * inbound flag and joins the stored inventory. A Resource that matches a stored stack, or one delivered before it
   * in the same batch (matchingResourceStack, vendor tags included), folds into that stack and is deleted. Both gold
   * fields, each kept Item's flag, each grown stack's amount and each folded Item are saved for undo before the
   * first write. A selection that finds nothing inbound returns CONVOY_DELIVERY_EMPTY and writes nothing.
   * @param {string} convoyUuid The Convoy.
   * @param {object} intent A normalizeConvoyDeliveryIntent result.
   * @param {{operation?: object}} context The command context whose operation saves the writes for undo.
   * @returns {Promise<?object>} null if the UUID isn't a Convoy, otherwise the result.
   */
  async deliverInbound(convoyUuid, intent, context = {}) {
    const convoy = await resolveActor(convoyUuid);
    if (!convoy || convoy.type !== 'Convoy') return null;
    const convoyName = String(convoy.name ?? 'Convoy');
    const inboundGp = wholeGold(convoy._source?.system?.inboundGp ?? convoy.system?.inboundGp);
    const plan = planConvoyDelivery({
      inboundGp, inboundItems: partitionConvoyItems(collectionValues(convoy.items)).inbound, intent
    });
    const gold = wholeGold(plan.gold);
    const items = plan.itemIds.map(id => convoy.items.get(id)).filter(Boolean);
    if (gold <= 0 && !items.length) {
      return {
        ok: false, code: RESULT_CODES.CONVOY_DELIVERY_EMPTY, data: { convoyName }
      };
    }
    const flagPath = `flags.${SYSTEM_ID}.${CONVOY_INBOUND_FLAG}`;
    const { kept, folded, grown } = planInboundMerge(storedItems(convoy), items);
    await context.operation?.capture({
      documents: [
        ...(gold > 0 ? [{ document: convoy, paths: ['system.gp', 'system.inboundGp'] }] : []),
        ...kept.map(item => ({ document: item, paths: grown.has(item) ? [flagPath, 'system.amount'] : [flagPath] })),
        ...[...grown.keys()].filter(stack => !kept.includes(stack))
          .map(stack => ({ document: stack, paths: ['system.amount'] }))
      ],
      deleting: folded
    });
    const settled = await settleWrites(async () => {
      if (gold > 0) {
        await convoy.update({
          'system.gp': wholeGold(convoy._source?.system?.gp ?? convoy.system?.gp) + gold,
          'system.inboundGp': inboundGp - gold
        }, { emblemCoinpurseSettlement: true });
      }
      for (const [stack, added] of grown) {
        await stack.update({ 'system.amount': (Number(stack.system?.amount) || 0) + added }, { emblemTransfer: true });
      }
      for (const item of kept) await item.update(forcedDeletion(flagPath), { emblemTransfer: true });
      if (folded.length) {
        await convoy.deleteEmbeddedDocuments('Item', folded.map(item => String(item.id)), { emblemTransfer: true });
      }
    });
    if (settled.ok !== true) return settled;
    return {
      ok: true, code: RESULT_CODES.CONVOY_DELIVERED,
      data: { convoyName, gold, itemCount: items.length }
    };
  }

  /** The unit whose possession a GM is shelving, and the Vendor taking it. */
  async getVendorStockSnapshot(intent) {
    const source = await resolveActor(intent.sourceActorUuid);
    const vendor = await resolveActor(intent.vendorUuid);
    if (!source || !vendor || vendor.type !== 'Vendor') return null;
    return Object.freeze({
      source: Object.freeze({
        actorUuid: String(source.uuid),
        name: String(source.name ?? ''),
        items: Object.freeze(collectionValues(source.items).map(projectTradeItem))
      }),
      vendor: Object.freeze({ actorUuid: String(vendor.uuid), name: String(vendor.name ?? 'Vendor') })
    });
  }

  /** A Coinpurse becomes Convoy gold: the purse is deleted and its worth is added to the Convoy's gold. */
  async depositGold(source, convoy, itemId, gold, context) {
    const giver = await resolveActor(source.actorUuid);
    const receiver = await resolveActor(convoy.actorUuid);
    const purse = giver?.items.get(itemId) ?? null;
    if (!giver || !receiver || !purse) return stale('economy.aggregate-missing');
    const worth = wholeGold(gold);
    const projected = projectTradeItem(purse);
    if (!isCoinpurseItem(projected) || wholeGold(projected.cost) !== worth) return stale('economy.purse-stale');
    await context.operation?.capture({ documents: [receiver], deleting: [purse] });
    return settleWrites(async () => {
      await receiver.update({ 'system.gp': wholeGold(receiver.system?.gp) + worth });
      await giver.deleteEmbeddedDocuments('Item', [itemId]);
    });
  }

  /** Lock keys: the shared movement lock (`movement:board`) and the Scenes, Tokens and Actors the command may write. */
  async resourceKeys(payload = {}) {
    const keys = ['movement:board'];
    for (const tokenUuid of [payload.sourceTokenUuid, payload.targetTokenUuid]) {
      const uuid = String(tokenUuid ?? '');
      const scene = uuid.split('.Token.')[0];
      if (scene) keys.push(`scene:${scene}`);
      if (uuid) keys.push(`token:${uuid}`);
      const actorUuid = uuid ? String((await resolveToken(uuid))?.actor?.uuid ?? '') : '';
      if (actorUuid) keys.push(`actor:${actorUuid}`);
    }
    return [...new Set(keys)].sort();
  }

  /** The acting unit, whatever stands across from it, and the distance, elevation and factions the trade depends on. */
  async getTradeSnapshot(intent) {
    const sourceToken = await resolveToken(intent.sourceTokenUuid);
    const targetToken = await resolveToken(intent.targetTokenUuid);
    const sourceActor = sourceToken?.actor;
    const targetActor = targetToken?.actor;
    if (!sourceActor || sourceActor.type !== 'Character' || !targetActor) return null;
    const scene = sourceToken.parent;
    if (!scene || targetToken.parent !== scene) return null;
    const gridSize = scene.grid.size;
    const sourceCells = footprintCells(sourceToken, gridSize);
    const targetCells = footprintCells(targetToken, gridSize);
    const movement = await this.movements.getSnapshot(sourceToken.uuid);
    const sourceFaction = String(sourceActor.system?.faction?.role ?? 'Neutral');
    const targetFaction = String(targetActor.system?.faction?.role ?? 'Neutral');
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      encounterRunning: findSceneCombat(scene)?.started === true,
      exploring: sceneExplorationActive(scene) === true,
      source: projectTradeSide(sourceToken, sourceActor, movement ?? null),
      target: projectTradeSide(targetToken, targetActor, null),
      distance: cellDistance(sourceCells, targetCells),
      sameElevation: (Number(sourceToken.elevation) || 0) === (Number(targetToken.elevation) || 0),
      sourceAirborne: isAirborneActor(sourceActor),
      targetAirborne: isAirborneActor(targetActor),
      targetHidden: targetToken.hidden === true,
      friendly: areFactionsFriendly(sourceFaction, targetFaction),
      hostile: areFactionsHostile(sourceFaction, targetFaction),
      stealExperience: projectStealExperience(sourceActor, targetActor, scene)
    });
  }

  /**
   * Count one XP-granting theft on the thief's activation XP counter, with undo through the steal command's
   * operation; the counter is the one item activation keeps (recordActivationExperienceUse in
   * document-writes/effect-execution.mjs).
   */
  recordExperienceUse(snapshot, use) {
    return recordActivationExperienceUse(snapshot.source.actorUuid, use, snapshot.operation ?? null);
  }

  /**
   * Move items between units for a trade or a theft. Each move creates the item on the receiver, or adds to its
   * Resource stack, then deletes it from the giver. A counted Resource (`amounts[itemId]`) moves that many units
   * and leaves the rest with the giver. The writes carry the combat marker (`emblemCombatSettlement`), so the
   * item-arrival hook leaves each moved item's uses as they were.
   */
  async transferItems(from, to, itemIds, { amounts = null, operation = null } = {}) {
    const plan = await planTransfer(from, to, itemIds, amounts, false);
    if (!plan) return false;
    await captureTransfer(plan.moves, operation);
    const last = await applyTransfer(plan.moves, { emblemCombatSettlement: true });
    return amounts ? { ...last } : true;
  }

  /** Send a unit's items to a Convoy or a Vendor's shelf. Gives up as stale if an item changed since it was read. */
  async storeItems(from, to, itemIds, { amounts = null } = {}, context = {}) {
    const plan = await planTransfer(from, to, itemIds, amounts, true);
    if (!plan) return stale('economy.transfer-stale');
    await captureTransfer(plan.moves, context.operation ?? null);
    return settleWrites(() => applyTransfer(plan.moves, { emblemTransfer: true }));
  }

  /** A trade during an encounter costs the bonus action. The plan stays open where it stands, with movement spent. */
  async spendBonusAction(snapshot, resolution) {
    const movement = snapshot.source.movement;
    if (movement?.movementPlanning === true && !await this.movements.commit(movement, resolution,
      { resume: true, endTurn: false, anchor: true, operation: snapshot.operation ?? null })) return false;
    const actor = await resolveActor(snapshot.source.actorUuid);
    if (!actor) return false;
    await snapshot.operation?.capture({ documents: [actor] });
    await actor.update({
      'system.turn.bonusActionAvailable': false,
      'system.turn.movementAvailable': false,
      'system.turn.traded': true
    }, { emblemCombatSettlement: true });
    return true;
  }

  /** A theft is the unit's action and ends the turn where it stands. */
  spendTurn(snapshot, resolution) {
    return this.movements.commit(snapshot.source.movement, resolution,
      { resume: false, endTurn: true, operation: snapshot.operation ?? null });
  }

  /** Looting an open container fixes the square the unit walked to and lets its turn continue. */
  commitSquare(snapshot, resolution) {
    return this.movements.commit(snapshot.source.movement, resolution,
      { resume: true, endTurn: false, operation: snapshot.operation ?? null });
  }

  /* -------------------------------------------- */
  /*  Vendor shop                                 */
  /* -------------------------------------------- */

  /**
   * Both sides of a shop as the two Tokens stand, with the buyer's Convoys, for inspectShop in
   * engine/economy/trade.mjs. `disposition` is what the buyer's party sees and pays after its haggle, beside the
   * Vendor's own `baseDisposition`; `haggle` and the buyer's downtime state decide the shop's Haggle button.
   */
  async getShopSnapshot(intent) {
    const counter = await this.#shopCounter(intent.buyerTokenUuid, intent.vendorTokenUuid);
    if (!counter) return null;
    const { buyer, vendor } = counter;
    const entry = haggleEntry(haggleEntries(vendor.system?.haggles), this.#haggleKey(buyer));
    return Object.freeze({
      disposition: this.#dispositionFor(vendor, buyer),
      baseDisposition: clampDisposition(vendor.system?.disposition),
      buyerKey: this.#haggleKey(buyer),
      haggle: Object.freeze({ haggled: entry !== null, bonus: entry?.bonus ?? 0 }),
      reach: counter.reach,
      exploring: counter.exploring,
      buyer: Object.freeze({
        actorUuid: String(buyer.uuid),
        tokenUuid: String(counter.buyerToken.uuid),
        name: String(buyer.name ?? ''),
        image: String(buyer.img ?? ''),
        purseGp: carriedGold(collectionValues(buyer.items).map(projectTradeItem)),
        goods: Object.freeze(collectionValues(buyer.items).map(projectVendorItem).filter(isShopGood)),
        actorType: String(buyer.system.faction.role ?? ''),
        ...downtimeStanding(buyer)
      }),
      vendor: Object.freeze({
        actorUuid: String(vendor.uuid),
        tokenUuid: String(counter.vendorToken.uuid),
        name: String(vendor.name ?? 'Vendor'),
        image: String(vendor.img ?? ''),
        gp: wholeGold(vendor.system?.gp),
        accepted: Object.freeze({ ...(vendor.system?.acceptedMerchandise ?? {}) }),
        stock: Object.freeze(collectionValues(vendor.items).map(projectVendorItem).filter(isShelfEntry))
      }),
      convoys: await this.#shopConvoys(String(buyer.uuid))
    });
  }

  /**
   * The unit at the counter and the Vendor across it, resolved from their placed Tokens on one Scene. A Vendor whose
   * Token is hidden is absent (fixtureHidden), so its shop view, purchases, sales and haggles are all unavailable.
   */
  async #shopCounter(buyerTokenUuid, vendorTokenUuid) {
    const buyerToken = await resolveToken(buyerTokenUuid);
    const vendorToken = await resolveToken(vendorTokenUuid);
    const buyer = buyerToken?.actor;
    const vendor = vendorToken?.actor;
    if (!buyer || buyer.type !== 'Character' || !vendor || vendor.type !== 'Vendor') return null;
    if (fixtureHidden({ documentType: vendor.type, hidden: vendorToken.hidden })) return null;
    const scene = buyerToken.parent;
    if (!scene || vendorToken.parent !== scene) return null;
    const gridSize = scene.grid.size;
    const distance = cellDistance(footprintCells(buyerToken, gridSize), footprintCells(vendorToken, gridSize));
    return Object.freeze({
      buyerToken, vendorToken, buyer, vendor,
      reach: projectShopReach(buyerToken, vendorToken, distance),
      exploring: sceneExplorationActive(scene) === true
    });
  }

  /**
   * The key a unit's haggles are stored under on a Vendor: its party's, or its own when no party holds it
   * (projectActorPartyId, reading the party repository's state when one is wired).
   */
  #haggleKey(actor) {
    const partyId = projectActorPartyId(actor, this.parties?.readState?.());
    return haggleKey({ partyId, actorUuid: String(actor.uuid) });
  }

  /**
   * The disposition a unit's party sees and pays at a Vendor, its haggle included. getShopSnapshot, getPurchaseFacts
   * and getSaleFacts all read it here, so the values read again before a purchase or sale match the planned ones.
   */
  #dispositionFor(vendor, unit) {
    return effectiveDisposition(vendor.system?.disposition, haggleEntries(vendor.system?.haggles),
      this.#haggleKey(unit));
  }

  /**
   * The Convoys a buyer may pool gold with and sell through, each with the goods it may offer. A Convoy's inbound
   * items can't be sold until the GM delivers them.
   */
  async #shopConvoys(buyerUuid) {
    const convoys = [];
    for (const entry of await this.linkedConvoys(buyerUuid)) {
      const convoy = this.parties?.resolveConvoy?.(entry.actorUuid) ?? null;
      if (!convoy) continue;
      const projected = projectShopConvoy(convoy);
      const inbound = new Set(partitionConvoyItems(collectionValues(convoy.items)).inbound.map(item => item.id));
      convoys.push(Object.freeze({
        ...projected, goods: Object.freeze(projected.goods.filter(good => isShopGood(good) && !inbound.has(good.id)))
      }));
    }
    return Object.freeze(convoys);
  }

  /** Everything a purchase is re-derived from: the buyer, the vendor, where it lands and what pays for it. */
  async getPurchaseFacts(intent) {
    const counter = await this.#shopCounter(intent.buyerTokenUuid, intent.vendorTokenUuid);
    if (!counter) return null;
    const { buyer, vendor } = counter;
    if (String(buyer.uuid) !== String(intent.buyerActorUuid) || String(vendor.uuid) !== String(intent.vendorUuid)) {
      return null;
    }
    const item = vendor.items.get(String(intent.itemId ?? ''));
    if (!item) return null;
    const destination = intent.destinationUuid ? await resolveActor(intent.destinationUuid) : buyer;
    if (!destination || (intent.destinationUuid && destination.type !== 'Convoy')) return null;
    if (intent.destinationUuid) {
      const linked = await this.linkedConvoys(String(buyer.uuid));
      if (!linked.some(entry => entry.actorUuid === String(destination.uuid))) return null;
    }
    const projected = projectVendorItem(item);
    const stack = projected.type === 'Resource'
      ? matchingResourceStack(storedItems(destination), item, purchasedTags(vendorTags(item), vendor.uuid))
      : null;
    const purse = collectionValues(buyer.items).map(projectTradeItem).find(isCoinpurseItem) ?? null;
    return Object.freeze({
      buyer: Object.freeze({
        uuid: String(buyer.uuid), tokenUuid: String(counter.buyerToken.uuid),
        name: String(buyer.name ?? ''), image: String(buyer.img ?? ''),
        avatarScale: characterAvatarScale(buyer.system?.art), purseId: purse?.id ?? '',
        haggleKey: this.#haggleKey(buyer)
      }),
      vendor: Object.freeze({
        uuid: String(vendor.uuid), tokenUuid: String(counter.vendorToken.uuid), name: String(vendor.name ?? 'Vendor'),
        image: String(vendor.img ?? ''),
        disposition: this.#dispositionFor(vendor, buyer), gp: wholeGold(vendor.system?.gp)
      }),
      reach: counter.reach,
      exploring: counter.exploring,
      destination: projectPurchaseDestination(destination, stack),
      funding: Object.freeze({
        purseGp: purse ? purse.cost : 0,
        convoyGp: intent.destinationUuid ? wholeGold(destination.system?.gp) : 0
      }),
      item: projected,
      convoyFunded: Boolean(intent.destinationUuid)
    });
  }

  /**
   * Deliver the goods, charge the purse then the Convoy, credit the vendor, and take the shelf down. The delivered
   * copy names this Vendor among its sellers and leaves the shelf's buyback behind (purchasedTags).
   */
  async settlePurchase(facts, plan, context) {
    const vendor = await resolveActor(facts.vendor.uuid);
    const destination = await resolveActor(facts.destination.uuid);
    const buyer = await resolveActor(facts.buyer.uuid);
    const item = vendor?.items.get(facts.item.id);
    if (!vendor || !destination || !buyer || !item) return stale('economy.aggregate-missing');
    if (!structurallyEqual(await this.getPurchaseFacts({
      buyerActorUuid: facts.buyer.uuid, buyerTokenUuid: facts.buyer.tokenUuid,
      vendorUuid: facts.vendor.uuid, vendorTokenUuid: facts.vendor.tokenUuid, itemId: facts.item.id,
      destinationUuid: facts.convoyFunded ? facts.destination.uuid : ''
    }), facts)) return stale('economy.facts-stale');
    const purse = plan.fromPurse > 0 ? buyer.items.get(facts.buyer.purseId) ?? null : null;
    if (plan.fromPurse > 0 && !purse) return stale('economy.payment-source-missing');
    const stack = plan.destinationStackId ? destination.items.get(plan.destinationStackId) ?? null : null;
    if (plan.destinationStackId && !stack) return stale('economy.destination-stack-missing');
    const deliveredId = stack ? '' : claimedDocumentId();
    await context.operation?.capture({
      documents: [stack, purse, plan.fromConvoy > 0 ? destination : null, plan.total > 0 ? vendor : null,
        plan.stockAfter !== null ? item : null].filter(Boolean),
      creating: stack ? [] : [{ parent: destination, documentName: 'Item', ids: [deliveredId] }]
    });
    return settleWrites(async () => {
      if (stack) {
        await stack.update({ 'system.amount': plan.destinationStackBefore + plan.units },
          { emblemTransfer: true });
      } else {
        await destination.createEmbeddedDocuments('Item', [purchasedItemData(item, plan, deliveredId, vendor.uuid)],
          { keepId: true, emblemTransfer: true });
      }
      if (purse) await purse.update({ 'system.cost': plan.purseAfter });
      if (plan.fromConvoy > 0) await destination.update({ 'system.gp': plan.convoyAfter });
      if (plan.total > 0) await vendor.update({ 'system.gp': plan.vendorGpAfter });
      if (plan.stockAfter !== null) await item.update({ [stockPath(plan.isResource)]: plan.stockAfter });
    });
  }

  /** Everything a sale is re-derived from: the seller, the vendor and where the coin is banked. */
  async getSaleFacts(intent) {
    const counter = await this.#shopCounter(intent.buyerTokenUuid, intent.vendorTokenUuid);
    if (!counter) return null;
    const { buyer: seller, vendor } = counter;
    if (String(seller.uuid) !== String(intent.sellerActorUuid) || String(vendor.uuid) !== String(intent.vendorUuid)) {
      return null;
    }
    const source = intent.sourceUuid ? await resolveActor(intent.sourceUuid) : seller;
    if (!source || (intent.sourceUuid && source.type !== 'Convoy')) return null;
    if (intent.sourceUuid) {
      const linked = await this.linkedConvoys(String(seller.uuid));
      if (!linked.some(entry => entry.actorUuid === String(source.uuid))) return null;
    }
    const item = source.items.get(String(intent.itemId ?? ''));
    if (!item || isInboundItem(item)) return null;
    const projected = projectVendorItem(item);
    const purse = collectionValues(seller.items).map(projectTradeItem).find(isCoinpurseItem) ?? null;
    return Object.freeze({
      seller: Object.freeze({
        uuid: String(seller.uuid), tokenUuid: String(counter.buyerToken.uuid),
        name: String(seller.name ?? ''), image: String(seller.img ?? ''),
        avatarScale: characterAvatarScale(seller.system?.art), purseId: purse?.id ?? '',
        haggleKey: this.#haggleKey(seller)
      }),
      vendor: Object.freeze({
        uuid: String(vendor.uuid), tokenUuid: String(counter.vendorToken.uuid), name: String(vendor.name ?? 'Vendor'),
        image: String(vendor.img ?? ''),
        disposition: this.#dispositionFor(vendor, seller), gp: wholeGold(vendor.system?.gp),
        accepted: Object.freeze({ ...(vendor.system?.acceptedMerchandise ?? {}) })
      }),
      reach: counter.reach,
      exploring: counter.exploring,
      source: Object.freeze({
        uuid: String(source.uuid),
        name: String(source.name ?? ''),
        isConvoy: source.type === 'Convoy',
        gp: wholeGold(source.system?.gp),
        purseGp: purse ? purse.cost : 0
      }),
      item: projected
    });
  }

  /**
   * Shelve the goods with the vendor, debit its purse, and bank what it paid at the source. The shelved copy carries
   * the plan's buyback for the seller's party (shelvedTags), and a Resource joins only the shelf stack whose tags
   * match it exactly.
   */
  async settleSale(facts, plan, context) {
    const vendor = await resolveActor(facts.vendor.uuid);
    const source = await resolveActor(facts.source.uuid);
    const seller = await resolveActor(facts.seller.uuid);
    const item = source?.items.get(facts.item.id);
    if (!vendor || !source || !seller || !item) return stale('economy.aggregate-missing');
    if (!structurallyEqual(await this.getSaleFacts({
      sellerActorUuid: facts.seller.uuid, buyerTokenUuid: facts.seller.tokenUuid,
      vendorUuid: facts.vendor.uuid, vendorTokenUuid: facts.vendor.tokenUuid, itemId: facts.item.id,
      sourceUuid: facts.source.isConvoy ? facts.source.uuid : ''
    }), facts)) return stale('economy.facts-stale');
    const tags = shelvedTags(vendorTags(item), plan.buyback ?? null);
    const stack = plan.isResource ? matchingResourceStack(storedItems(vendor), item, tags) : null;
    const purse = facts.seller.purseId ? seller.items.get(facts.seller.purseId) ?? null : null;
    const banksToPurse = plan.paid > 0 && !facts.source.isConvoy;
    const shelvedId = stack ? '' : claimedDocumentId();
    const mintedId = banksToPurse && !purse ? claimedDocumentId() : '';
    const payload = mintedId ? await coinpurseTemplate(plan.balanceAfter, mintedId) : null;
    await context.operation?.capture({
      documents: [stack, plan.removeSourceItem ? null : item, plan.paid > 0 ? vendor : null,
        plan.paid > 0 && facts.source.isConvoy ? source : null, banksToPurse ? purse : null].filter(Boolean),
      deleting: plan.removeSourceItem ? [item] : [],
      creating: [
        ...(stack ? [] : [{ parent: vendor, documentName: 'Item', ids: [shelvedId] }]),
        ...(payload ? [{ parent: seller, documentName: 'Item', ids: [mintedId] }] : [])
      ]
    });
    return settleWrites(async () => {
      if (stack) {
        await stack.update({ 'system.amount': wholeGold(stack.system?.amount) + plan.units },
          { emblemTransfer: true });
      } else {
        await vendor.createEmbeddedDocuments('Item', [soldItemData(item, plan, shelvedId, tags)],
          { keepId: true, emblemTransfer: true });
      }
      if (plan.removeSourceItem) await source.deleteEmbeddedDocuments('Item', [item.id]);
      else await item.update({ 'system.amount': plan.sourceAmountAfter });
      if (plan.paid > 0) await vendor.update({ 'system.gp': plan.vendorGpAfter });
      if (plan.paid > 0 && facts.source.isConvoy) {
        await source.update({ 'system.gp': plan.balanceAfter }, { emblemCoinpurseSettlement: true });
      } else if (banksToPurse && purse) {
        await purse.update({ 'system.cost': plan.balanceAfter }, { emblemCoinpurseSettlement: true });
      } else if (banksToPurse) {
        await seller.createEmbeddedDocuments('Item', [payload], { keepId: true, emblemTransfer: true });
      }
    });
  }

  /**
   * Everything a haggle is worked out from, for haggle in engine/economy/trade.mjs: the unit at the counter with its
   * attributes, skills and downtime commitment, the Vendor with its own disposition and stored haggles, the key the
   * unit's party haggles under, and how the two stand on the map. Null when the pair no longer stands together as
   * the request names it.
   */
  async getHaggleFacts(intent) {
    const counter = await this.#shopCounter(intent.buyerTokenUuid, intent.vendorTokenUuid);
    if (!counter) return null;
    const { buyer, vendor } = counter;
    if (String(buyer.uuid) !== String(intent.buyerActorUuid) || String(vendor.uuid) !== String(intent.vendorUuid)) {
      return null;
    }
    const side = projectTradeSide(counter.buyerToken, buyer, null);
    return Object.freeze({
      buyer: Object.freeze({
        uuid: String(buyer.uuid), tokenUuid: String(counter.buyerToken.uuid), name: side.name, image: side.image,
        avatarScale: side.avatarScale, actorType: side.actorType, attributes: side.attributes, skills: side.skills,
        blessed: side.blessed, ...downtimeStanding(buyer)
      }),
      vendor: Object.freeze({
        uuid: String(vendor.uuid), tokenUuid: String(counter.vendorToken.uuid), name: String(vendor.name ?? 'Vendor'),
        image: String(vendor.img ?? ''), baseDisposition: clampDisposition(vendor.system?.disposition),
        haggles: haggleEntries(vendor.system?.haggles)
      }),
      key: this.#haggleKey(buyer),
      reach: counter.reach,
      exploring: counter.exploring
    });
  }

  /**
   * Save a rolled haggle: spend the unit's Downtime Action and store the Vendor's haggles with the party's new
   * entry. Everything is read again first, and if anything changed it gives up as stale before writing; the unit's
   * system flags and the Vendor's haggles are then saved for undo.
   * @param {object} facts The getHaggleFacts result the haggle was planned on.
   * @param {{commitment: object, haggles: Array<{key: string, bonus: number}>}} settlement The downtime
   *   commitment (actionLaneSpend) and every haggle the Vendor keeps (planHaggleOutcome).
   * @param {{operation?: object}} context The command context whose operation saves the writes for undo.
   * @returns {Promise<object>} The settleWrites result.
   */
  async settleHaggle(facts, { commitment, haggles }, context = {}) {
    const buyer = await resolveActor(facts.buyer.uuid);
    const vendor = await resolveActor(facts.vendor.uuid);
    if (!buyer || !vendor) return stale('economy.aggregate-missing');
    if (!structurallyEqual(await this.getHaggleFacts({
      buyerActorUuid: facts.buyer.uuid, buyerTokenUuid: facts.buyer.tokenUuid,
      vendorUuid: facts.vendor.uuid, vendorTokenUuid: facts.vendor.tokenUuid
    }), facts)) return stale('economy.facts-stale');
    await context.operation?.capture({ documents: [
      { document: buyer, paths: [`flags.${SYSTEM_ID}`] },
      { document: vendor, paths: [VENDOR_HAGGLES_PATH] }
    ] });
    return settleWrites(async () => {
      await buyer.update({ [DOWNTIME_COMMITMENT_PATH]: { ...commitment } }, { emblemDowntimeSettlement: true });
      await vendor.update({
        [VENDOR_HAGGLES_PATH]: haggles.map(entry => ({ key: String(entry.key), bonus: entry.bonus }))
      }, { emblemDowntimeSettlement: true });
    });
  }

  /** Write the goods a vendor buys from players in one update. */
  async setMerchandise(vendorUuid, changes) {
    const vendor = await resolveActor(vendorUuid);
    if (!vendor || vendor.type !== 'Vendor') return null;
    try {
      await vendor.update({ ...changes });
      return { vendorName: String(vendor.name ?? 'Vendor') };
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'setMerchandise');
      return null;
    }
  }

  /**
   * Remove a drop bag once it has been emptied. A world bag has its HUD state cleared and every placed Token
   * removed, then the Actor is deleted. An unlinked bag deletes only its own Token. If a removal is already running
   * for the same bag, this does nothing. The deletes pass `noHook`, which skips the `preDeleteToken` and
   * `preDeleteActor` hooks (the documents' own `_preDelete` still runs), so no module's hook can stop the bag
   * being removed part-way.
   */
  async removeEmptiedContainer(actorUuid, operation = null) {
    const actor = await resolveActor(actorUuid);
    if (!actor || actor.type !== 'Object' || actor.system?.objectType !== 'Loot') return false;
    if (actor.system?.isDropChest !== true || collectionValues(actor.items).length) return false;
    const key = actor.isToken ? `token:${actor.token?.id ?? ''}` : `actor:${actor.id}`;
    if (DROP_BAG_SWEEPS.has(key)) return false;
    DROP_BAG_SWEEPS.add(key);
    try {
      if (actor.isToken) {
        await operation?.capture({ deleting: [actor.token].filter(Boolean) });
        await actor.token?.delete({ noHook: true });
        return true;
      }
      const placements = collectionValues(game.scenes)
        .flatMap(scene => collectionValues(scene.tokens).filter(entry => entry.actorId === actor.id));
      await operation?.capture({ deleting: [...placements, actor] });
      await actor.unsetFlag(BG3_HUD_CORE_ID, BG3_HUD_STATE_FLAG);
      await new Promise(resolve => setTimeout(resolve, DROP_BAG_FLAG_SETTLE_MS));
      for (const token of placements) await token.delete({ noHook: true });
      await actor.delete({ noHook: true });
      return true;
    } finally {
      DROP_BAG_SWEEPS.delete(key);
    }
  }
}

/* -------------------------------------------- */
/*  Drop bag sweep                              */
/* -------------------------------------------- */

/** The bags a removal is already running for, so emptying a bag's last two rows at once can't delete it twice. */
const DROP_BAG_SWEEPS = new Set();

/** How long the HUD's own listener is given to see the cleared state before the Actor is taken away. */
const DROP_BAG_FLAG_SETTLE_MS = 50;

const BG3_HUD_STATE_FLAG = 'hudState';

/* -------------------------------------------- */
/*  Write results                               */
/* -------------------------------------------- */

/**
 * Run one command's writes, once the old values are saved for undo. A failed write returns REVERTED, and
 * CommandDispatcher puts back everything the command wrote before engine/economy/trade.mjs turns it into the
 * caller's code.
 * @param {Function} writes The ordered document writes, returning any extra result fields.
 * @returns {Promise<object>} The write result.
 */
async function settleWrites(writes) {
  try {
    return { ok: true, code: ECONOMY_SETTLEMENT_OUTCOMES.SETTLED, ...(await writes() ?? {}) };
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'settleWrites');
    return { ok: false, code: ECONOMY_SETTLEMENT_OUTCOMES.REVERTED,
      reasonCode: String(error?.message ?? 'economy.write-failed') };
  }
}

/** What an Actor holds that play can use: a Convoy's undelivered Items stay out until the GM delivers them. */
function storedItems(actor) {
  return collectionValues(actor?.items).filter(item => !isInboundItem(item));
}

/** Nothing was written: what the plan was built on has changed. */
function stale(reasonCode) {
  return { ok: false, code: ECONOMY_SETTLEMENT_OUTCOMES.STALE, reasonCode };
}

/** A new document id, made before the create so the operation knows what to remove if the command is undone. */
function claimedDocumentId() {
  return foundry.utils.randomID();
}

/* -------------------------------------------- */
/*  Coinpurse template                          */
/* -------------------------------------------- */

/**
 * The pack holding the shipped Coinpurse, searched before any other pack. A Coinpurse among the world's own items
 * is used first, any Item pack with one will do, and a world with none at all falls back to FALLBACK_COINPURSE.
 */
const PREFERRED_PACK = 'emblem-rpg-content.items';

/** Item data for a new Coinpurse holding a given amount, built from the shipped purse when one can be found. */
async function coinpurseTemplate(amount, id) {
  const source = await findPackCoinpurse();
  if (!source) {
    reportFoundryError(import.meta.url, new Error('economy.coinpurse-template-missing'), 'coinpurseTemplate');
  }
  const data = source ?? structuredClone(FALLBACK_COINPURSE);
  data._id = id;
  data.system ??= {};
  data.system.cost = amount;
  data.system.itemType = 'Coinpurse';
  return data;
}

async function findPackCoinpurse() {
  const isPurse = item => isCoinpurseItem({ type: item?.type, itemType: item?.system?.itemType });
  const world = collectionValues(game.items).find(isPurse);
  if (world) return world.toObject();
  const packs = collectionValues(game.packs).filter(pack => pack.documentName === 'Item');
  packs.sort((left, right) => (left.collection === PREFERRED_PACK ? -1 : right.collection === PREFERRED_PACK ? 1 : 0));
  for (const pack of packs) {
    let index;
    try { index = await pack.getIndex(); } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'findPackCoinpurse');
      continue;
    }
    for (const entry of index) {
      if (entry.type !== 'Miscellaneous' || !/coinpurse/i.test(entry.name ?? '')) continue;
      let document = null;
      try { document = await pack.getDocument(entry._id); } catch (diagnosticError) {
        reportFoundryError(import.meta.url, diagnosticError, 'findPackCoinpurse');
        continue;
      }
      if (document && isPurse(document)) return document.toObject();
    }
  }
  return null;
}

/* -------------------------------------------- */
/*  Inbound merge                               */
/* -------------------------------------------- */

/**
 * Sort a delivery's Items into those kept as stored entries and those folded into a stack, for deliverInbound. A
 * Resource folds into the stored stack it matches (matchingResourceStack), or into a Resource kept earlier in the
 * same delivery, and `grown` sums what each such stack gains.
 * @param {object[]} stored The Convoy's stored Items.
 * @param {object[]} delivered The inbound Items being delivered, in order.
 * @returns {{kept: object[], folded: object[], grown: Map<object, number>}}
 */
function planInboundMerge(stored, delivered) {
  const kept = [];
  const folded = [];
  const grown = new Map();
  for (const item of delivered) {
    const stack = item.type === 'Resource' ? matchingResourceStack([...stored, ...kept], item) : null;
    if (!stack) {
      kept.push(item);
      continue;
    }
    folded.push(item);
    grown.set(stack, (grown.get(stack) ?? 0) + wholeGold(item.system?.amount));
  }
  return { kept, folded, grown };
}

/* -------------------------------------------- */
/*  Transfers                                   */
/* -------------------------------------------- */

/**
 * Turn each moving item into one move. Returns null if an item has changed since it was read (checked when
 * `verify` is set) or is undelivered (inbound), since undelivered items never leave their Convoy. A Resource merges
 * only into a stored stack.
 */
async function planTransfer(from, to, itemIds, amounts, verify) {
  const giver = await resolveActor(from.actorUuid);
  const receiver = await resolveActor(to.actorUuid);
  if (!giver || !receiver) return null;
  const moves = [];
  for (const itemId of itemIds) {
    const item = giver.items.get(itemId);
    if (!item || isInboundItem(item)) return null;
    const known = verify ? from.items?.find?.(entry => entry.id === itemId) : null;
    if (known && !structurallyEqual(projectTradeItem(item), known)) return null;
    const held = Number(item.system?.amount) || 0;
    const counted = item.type === 'Resource' && Number.isFinite(Number(amounts?.[itemId]))
      ? Math.min(held, Math.max(0, Math.floor(Number(amounts[itemId])))) : null;
    moves.push({
      giver, receiver, item, counted,
      moving: counted ?? held,
      stack: item.type === 'Resource' ? matchingResourceStack(storedItems(receiver), item) : null,
      remaining: counted !== null && counted < held ? held - counted : null,
      createdId: ''
    });
  }
  return { giver: String(giver.uuid), receiver: String(receiver.uuid), moves };
}

/**
 * Choose each arriving Item's id ahead and save both sides' old values for undo in one call, so a command that
 * fails mid-transfer knows exactly which new items to remove and which departed items to put back.
 */
async function captureTransfer(moves, operation) {
  if (!operation) return;
  const documents = [];
  const deleting = [];
  const creating = [];
  for (const move of moves) {
    if (move.stack) documents.push(move.stack);
    else {
      move.createdId = claimedDocumentId();
      creating.push({ parent: move.receiver, documentName: 'Item', ids: [move.createdId] });
    }
    if (move.remaining === null) deleting.push(move.item);
    else documents.push(move.item);
  }
  await operation.capture({ documents, deleting, creating });
}

/** Every move is a stack update or a create on the receiver, then an amount update or a delete on the giver. */
async function applyTransfer(moves, options) {
  let last = null;
  for (const move of moves) {
    if (move.stack) {
      const total = (Number(move.stack.system?.amount) || 0) + move.moving;
      await move.stack.update({ 'system.amount': total }, { ...options });
      last = { total, stacked: true };
    } else {
      const data = transferredItemData(move);
      await move.receiver.createEmbeddedDocuments('Item', [data],
        data._id ? { ...options, keepId: true } : { ...options });
      last = { total: move.item.type === 'Resource' ? move.moving : null, stacked: false };
    }
    if (move.remaining !== null) await move.item.update({ 'system.amount': move.remaining }, { ...options });
    else await move.giver.deleteEmbeddedDocuments('Item', [move.item.id], { ...options });
  }
  return last;
}

/** The item data a move creates on the receiver. A counted Resource carries only the units that move. */
function transferredItemData(move) {
  const data = detachedItemData(move.item, move.createdId);
  if (move.counted !== null) data.system.amount = move.moving;
  return data;
}

/** An Item's data as it arrives somewhere new: unequipped, under the id chosen for it ahead of the create, if any. */
function detachedItemData(item, id = '') {
  const data = item.toObject();
  if (id) data._id = id;
  else delete data._id;
  data.system ??= {};
  data.system.isWielded = false;
  data.system.isWorn = false;
  data.system.isEquipped = false;
  return data;
}

/* -------------------------------------------- */
/*  Vendor writes                               */
/* -------------------------------------------- */

function purchasedItemData(item, plan, id, vendorUuid) {
  const data = withVendorTags(detachedItemData(item, id), purchasedTags(vendorTags(item), vendorUuid));
  if (plan.isResource) data.system.amount = plan.units;
  delete data.flags[SYSTEM_ID].stock;
  delete data.flags[SYSTEM_ID].vendorLocked;
  return data;
}

function soldItemData(item, plan, id, tags) {
  const data = withVendorTags(detachedItemData(item, id), tags);
  if (plan.isResource) data.system.amount = plan.units;
  else data.flags[SYSTEM_ID].stock = 1;
  delete data.flags[SYSTEM_ID].vendorLocked;
  return data;
}

/** Write a copy's vendor tags (vendorTags in game/character/inventory.mjs) into its item data, dropping empty ones. */
function withVendorTags(data, tags) {
  data.flags ??= {};
  const flags = data.flags[SYSTEM_ID] ??= {};
  if (tags.sold.length) flags[VENDOR_SOLD_FLAG] = [...tags.sold];
  else delete flags[VENDOR_SOLD_FLAG];
  if (tags.buyback) flags[VENDOR_BUYBACK_FLAG] = { ...tags.buyback };
  else delete flags[VENDOR_BUYBACK_FLAG];
  return data;
}

/* -------------------------------------------- */
/*  Vendor tag reset                            */
/* -------------------------------------------- */

/** The flag paths the vendor tags live at, which the GM's Reset Downtime saves for undo and deletes. */
const VENDOR_TAG_PATHS = Object.freeze([VENDOR_SOLD_FLAG, VENDOR_BUYBACK_FLAG].map(key => `flags.${SYSTEM_ID}.${key}`));

/**
 * Every Actor in the world holding an Item with a vendor tag, with those Items, for the GM's Reset Downtime
 * (FoundryDowntimeRepository.resetDowntime and its resource keys): world Actors and each Scene's unlinked Token
 * Actors, whether units, Convoys or Vendors.
 * @returns {Array<{actor: object, items: object[]}>}
 */
export function vendorTagHolders() {
  const actors = new Map();
  const consider = actor => {
    if (actor && !actors.has(String(actor.uuid))) actors.set(String(actor.uuid), actor);
  };
  for (const actor of collectionValues(game.actors)) consider(actor);
  for (const scene of collectionValues(game.scenes)) {
    for (const token of collectionValues(scene.tokens)) if (token.actor?.isToken === true) consider(token.actor);
  }
  return [...actors.values()]
    .map(actor => ({ actor, items: collectionValues(actor.items).filter(hasVendorTags) }))
    .filter(holder => holder.items.length);
}

/** The undo entries (for operation.capture) for a vendor tag reset: each tagged Item with the tag paths it holds. */
export function vendorTagCaptures(holders) {
  return holders.flatMap(({ items }) => items.map(item => ({ document: item, paths: heldTagPaths(item) })));
}

/** Strip both vendor tags from every Item listed, one embedded update per actor. */
export async function stripVendorTags(holders, options = {}) {
  for (const { actor, items } of holders) {
    await actor.updateEmbeddedDocuments('Item', items.map(item => Object.assign({ _id: String(item.id) },
      ...heldTagPaths(item).map(path => forcedDeletion(path)))), { ...options });
  }
}

function heldTagPaths(item) {
  return VENDOR_TAG_PATHS.filter(path => foundry.utils.getProperty(item, path) !== undefined);
}

function stockPath(isResource) {
  return isResource ? 'system.amount' : `flags.${SYSTEM_ID}.stock`;
}

function wholeGold(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * What a haggle checks about the unit at the counter (actionLaneBlock in game/downtime/social.mjs): its downtime
 * commitment, and whether it is down at 0 HP, read the way projections/downtime.mjs reads them for an activity
 * roster.
 */
function downtimeStanding(actor) {
  const flag = actor.getFlag?.(SYSTEM_ID, DOWNTIME_FLAG) ?? actor.flags?.[SYSTEM_ID]?.[DOWNTIME_FLAG];
  return { commitment: downtimeCommitment(flag), defeated: finite(actor.system.resources.hp.value) < 1 };
}

/**
 * What a theft is graded on in engine/economy/trade.mjs: the activation XP entry, encounter and use count for the
 * thief's Steal Ability, read exactly as an item use reads its own (projectActivationExperience), with the thief's
 * level and its mark's level, pools and kind.
 */
function projectStealExperience(thief, mark, scene) {
  const ability = collectionValues(thief.items).find(item => isStealAbility(item)) ?? { name: '' };
  return Object.freeze({
    ...projectActivationExperience(thief, ability, scene),
    casterLevel: projectExperienceFacts(thief.system).level,
    mark: Object.freeze({ objectTarget: mark.type !== 'Character', ...projectExperienceFacts(mark.system) })
  });
}

function cellDistance(left, right) {
  let distance = Infinity;
  for (const mine of left) {
    for (const other of right) {
      distance = Math.min(distance, Math.max(Math.abs(mine.x - other.x), Math.abs(mine.y - other.y)));
    }
  }
  return Number.isFinite(distance) ? distance : Infinity;
}
