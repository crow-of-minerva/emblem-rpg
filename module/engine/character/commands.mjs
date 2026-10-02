/** @layer engine/character */
import { MAX_SETTLEMENT_ATTEMPTS, COMMAND_IDS, INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { EQUIPMENT_REFUSALS } from '../../contracts/domains/items.mjs';
import {
  HOTBAR_LAYOUT_OUTCOMES, normalizeHotbarLayoutIntent, pruneForeignHudCells
} from '../../contracts/domains/bg3-hud.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { KARMA_LEDGER_RESOURCE_KEY } from '../../contracts/domains/combat.mjs';
import {
  SKILL_BY_KEY,
  planJournalAccessGrant,
  restoreStandardAction,
  spendStandardAction
} from '../../game/character/rules.mjs';
import { CHECK_ROLL_MODES, buildSkillCheck, nullableDc } from '../../game/rolls/checks.mjs';
import {
  buildEquipmentToggle,
  characterActorItemDropAllowed,
  characterItemAdmission,
  characterItemTransfers,
  handoverLockedByEncounter,
  planEquipmentOverflow,
  planRequirementUnequips
} from '../../game/character/inventory.mjs';
import {
  planEquipmentDepartureResources,
  planEquipmentEffectReconciliation,
  planEquipmentTransferConsequences,
  planEquipmentToggleConsequences
} from '../../game/character/equipment-effects.mjs';
import { planInnateGrants } from '../../game/character/innate-grants.mjs';
import { planPacifistChange } from '../../game/character/counter-mode.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { recordDiagnostic, diagnosticData, requirePorts } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Character commands                          */
/* -------------------------------------------- */
/**
 * The character command definitions init/system.mjs registers with CommandDispatcher: standard actions, skill
 * checks, equipping and item transfers, journal access, free targeting, the counterattack mode, the hotbar layout,
 * and the equipment and innate-grant clean-up jobs that foundry/hooks/actors.mjs and foundry/hooks/innate-grants.mjs
 * submit.
 */
export function createCharacterCommandContribution(ports) {
  const { diagnostics, actors, events, checks, checkPresentation, journals, presentation } = ports;
  requirePorts('createCharacterCommandContribution', { diagnostics, actors, events, checks, checkPresentation,
    journals, presentation });
  const actions = createStandardActionHandlers(ports);
  const inventory = createCharacterInventoryHandlers(ports);
  const innateGrants = context => reconcileInnateGrants(context, ports);
  const authorize = createCommandAuthorization(ports.authority);
  const owner = authorize.actorOwner(payload => payload.actorUuid);
  return [
    characterDefinition(COMMAND_IDS.CHARACTER.ACTIONS.SPEND_STANDARD, actions.spend, owner),
    characterDefinition(COMMAND_IDS.CHARACTER.ACTIONS.RESTORE_STANDARD, actions.restore, authorize.gm()),
    characterDefinition(COMMAND_IDS.CHARACTER.SKILLS.ROLL, createSkillCheckHandler(ports), owner,
      [KARMA_LEDGER_RESOURCE_KEY]),
    characterDefinition(COMMAND_IDS.CHARACTER.INVENTORY.TOGGLE_EQUIPMENT, inventory.toggle, owner),
    characterDefinition(COMMAND_IDS.CHARACTER.INVENTORY.TRANSFER, inventory.transfer, authorize.all(
      authorize.actorOwner(payload => payload.targetActorUuid), ownedSourceOrPartyConvoy(ports.authority))),
    characterDefinition(INTERNAL_COMMAND_IDS.CHARACTER.INVENTORY.RECONCILE_EFFECTS, inventory.reconcileEffects,
      authorize.activeGm()),
    characterDefinition(COMMAND_IDS.CHARACTER.KNOWLEDGE.GRANT_JOURNAL_ACCESS,
      context => grantJournalAccess(context, ports), authorize.actorAuthor(payload => payload.actorUuid)),
    characterDefinition(COMMAND_IDS.CHARACTER.TARGETING.SET_FREE_TARGETING,
      context => setFreeTargeting(context, ports), authorize.gm()),
    characterDefinition(COMMAND_IDS.CHARACTER.COUNTER.SET_PACIFIST, context => setPacifist(context, ports), owner),
    characterDefinition(COMMAND_IDS.CHARACTER.HOTBAR.SAVE_LAYOUT, createHotbarLayoutHandler(ports), owner),
    characterDefinition(INTERNAL_COMMAND_IDS.CHARACTER.INNATE_GRANTS.RECONCILE, innateGrants,
      authorize.activeGm())
  ];
}

/**
 * The transfer's check on the source: the requester owns it, or it is a Convoy the recipient's party links
 * (authority.canUserDrawFromConvoy). The definition checks the recipient's ownership separately.
 */
function ownedSourceOrPartyConvoy(authority) {
  return async context => {
    const source = String(context.payload?.sourceActorUuid ?? '');
    if (await authority.canUserOwnActor(source, context.userId)) return null;
    const target = String(context.payload?.targetActorUuid ?? '');
    return await authority.canUserDrawFromConvoy(source, target, context.userId) === true
      ? null : refuse(RESULT_CODES.OWNER_REQUIRED);
  };
}

function characterDefinition(id, handler, authorize, sharedKeys = []) {
  return {
    id,
    authorize,
    handler,
    concurrencyKeys: context => [
      context.payload?.actorUuid,
      context.payload?.sourceActorUuid,
      context.payload?.targetActorUuid
    ].map(value => String(value ?? '')).filter(Boolean).map(uuid => `actor:${uuid}`).concat(sharedKeys).sort()
  };
}

/* -------------------------------------------- */
/*  Standard actions                            */
/* -------------------------------------------- */
function createStandardActionHandlers({ actors, events }) {
  return {
    spend: context => changeStandardAction(context, { actors, events, restore: false }),
    restore: context => changeStandardAction(context, { actors, events, restore: true })
  };
}

/**
 * Spend or restore one unit's standard action. The write does not go through `context.operation`, so it is not
 * recorded for undo; it is the handler's last write, so a refusal never leaves half a change.
 */
async function changeStandardAction(context, { actors, events, restore }) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  let actor;
  let resolution;
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    actor = await actors.getSnapshot(actorUuid);
    if (!actor) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
    if (actor.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
    resolution = restore
      ? restoreStandardAction({ standardAvailable: actor.standardAvailable })
      : spendStandardAction({ standardAvailable: actor.standardAvailable });
    if (!resolution.ok) return resolution;
    const committed = await actors.update(actor, {
      'system.turn.actionAvailable': resolution.data.standardAvailable
    });
    if (committed?.stale !== true) break;
    actor = null;
  }
  if (!actor || !resolution) return refuse(RESULT_CODES.COMMAND_FAILED, { reasonCode: 'character.state-changed' });

  events.publish(restore ? EVENT_IDS.STANDARD_ACTION_RESTORED : EVENT_IDS.STANDARD_ACTION_SPENT, {
    actorUuid,
    actorName: actor.name,
    requestId: context.requestId,
    userId: context.userId
  });
  return accept(resolution.code, {
    actorUuid,
    actorName: actor.name,
    standardAvailable: resolution.data.standardAvailable
  });
}

/* -------------------------------------------- */
/*  Free targeting                              */
/* -------------------------------------------- */
/**
 * Set the GM override that frees one unit's actions from line of sight (the Token HUD control). It is table
 * administration, not a gameplay action: it spends nothing. A request that matches the unit's current state writes
 * nothing and still accepts.
 */
async function setFreeTargeting(context, { actors }) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const actor = await actors.getSnapshot(actorUuid);
  if (!actor) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
  if (actor.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
  const enabled = context.payload?.enabled === true;
  const changed = enabled !== (actor.freeTargeting === true);
  if (changed && !await actors.setFreeTargeting(actorUuid, enabled, context.operation)) {
    return refuse(RESULT_CODES.COMMAND_FAILED, { reasonCode: 'character.state-changed' });
  }
  return accept(RESULT_CODES.FREE_TARGETING_SET, {
    actorUuid, actorName: actor.name, freeTargeting: enabled, changed
  });
}

/* -------------------------------------------- */
/*  Counterattack mode                          */
/* -------------------------------------------- */
/**
 * Set whether one unit counterattacks, for the swords-and-dove toggle on the BG3 HUD (api.character.setPacifist).
 * A pacifist unit gets the `cannotCounter` combat rule, set in foundry/adapters/projections/combat-context.mjs.
 * planPacifistChange refuses a non-GM once the unit's turn is spent in a started encounter. A request that matches
 * the current mode writes nothing and still accepts.
 */
async function setPacifist(context, { actors, authority }) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const actor = await actors.getSnapshot(actorUuid);
  if (!actor) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
  if (actor.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
  const pacifist = context.payload?.pacifist === true;
  const plan = planPacifistChange({
    gm: authority.isGm(context.userId) === true,
    encounterActive: actor.encounterActive,
    turn: actor.turn,
    current: actor.pacifist,
    requested: pacifist
  });
  if (!plan.ok) return refuse(plan.code, { actorUuid, actorName: actor.name });
  if (plan.changed && !await actors.setPacifist(actorUuid, pacifist, context.operation)) {
    return refuse(RESULT_CODES.COMMAND_FAILED, { reasonCode: 'character.state-changed' });
  }
  return accept(RESULT_CODES.PACIFIST_SET, { actorUuid, actorName: actor.name, pacifist, changed: plan.changed });
}

/* -------------------------------------------- */
/*  Character inventory                        */
/* -------------------------------------------- */
function createCharacterInventoryHandlers({ actors, events, authority, presentation }) {
  return {
    toggle: context => toggleCharacterItem(context, actors, events, authority),
    transfer: context => transferCharacterItem(context, actors, events, authority),
    reconcileEffects: context => reconcileCharacterEquipment(context, actors, presentation)
  };
}

async function toggleCharacterItem(context, actors, events, authority) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const itemId = String(context.payload?.itemId ?? '');
  let actor;
  let item;
  let result;
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    actor = await actors.getInventorySnapshot(actorUuid);
    if (!actor) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
    if (actor.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
    item = actor.items.find(entry => entry.id === itemId);
    if (!item) return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: 'inventory.item-missing' });
    result = buildEquipmentToggle(actor, item, {
      isGM: authority.isGm(context.userId),
      inCombat: actor.inCombat
    });
    if (!result.ok) return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: result.code, ...result });
    const consequences = planEquipmentToggleConsequences(await withStanceSource(actors, actor), result.updates);
    const committed = await actors.settleEquipmentToggle(actor, {
      itemUpdates: result.updates,
      ...consequences,
      operation: context.operation ?? null
    });
    if (committed?.stale !== true) {
      if (committed?.ok !== true) return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { ...diagnosticData(committed),
        reasonCode: committed?.code ?? 'inventory.equipment-settlement-failed'
      });
      break;
    }
    actor = null;
  }
  if (!actor || !item || !result) {
    return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: 'inventory.state-changed' });
  }
  const outcome = {
    actorUuid,
    actorName: actor.name,
    itemId,
    itemName: item.name,
    enabled: result.enabled,
    notices: result.notices
  };
  events.publish(EVENT_IDS.INVENTORY_EQUIPMENT_UPDATED, {
    ...outcome,
    requestId: context.requestId,
    userId: context.userId
  });
  return accept(RESULT_CODES.INVENTORY_EQUIPMENT_UPDATED, outcome);
}

/**
 * The equipment clean-up job foundry/hooks/actors.mjs submits on the host after an actor, effect or item change.
 * Equipment effects and lapsed requirements are applied first, since unequipping changes what the capacity step
 * would move. Then the surplus of a unit that outgrew its slots goes to its Convoy. The capacity result is the one
 * reported when it has something to say.
 */
async function reconcileCharacterEquipment(context, actors, presentation) {
  const effects = await reconcileCharacterEquipmentEffects(context, actors);
  if (!effects.ok) return effects;
  const capacity = await reconcileEquipmentCapacity(context, actors, presentation);
  return capacity ?? effects;
}

/**
 * Send the equipment a unit no longer has slots for to the Convoy linked to its owner's party, newest idle pieces
 * first. With no Convoy linked nothing moves and the outcome tells the GM instead. Returns null when the unit fits
 * its slots and there is nothing to report.
 */
async function reconcileEquipmentCapacity(context, actors, presentation) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const operation = context.operation ?? null;
  const actor = await actors.getInventorySnapshot(actorUuid);
  if (actor?.type !== 'Character') return null;
  const overflow = planEquipmentOverflow(actor);
  if (!overflow.overflowing) return null;
  if (!await actors.getLinkedConvoySnapshot(actorUuid)) {
    return accept(RESULT_CODES.INVENTORY_CAPACITY_UNSTORED, {
      actorUuid, actorName: actor.name, capacity: overflow.capacity, carried: overflow.carried
    });
  }
  const moved = [];
  let convoyName = '';
  for (const itemId of overflow.itemIds) {
    const stored = await storeSurplusEquipment(actors, actorUuid, itemId, operation);
    if (stored.refusal) return stored.refusal;
    if (!stored.itemName) continue;
    moved.push(stored.itemName);
    convoyName = stored.convoyName;
  }
  if (!moved.length) return null;
  const outcome = { actorUuid, actorName: actor.name, convoyName, itemNames: Object.freeze([...moved]) };
  await presentCapacityMove(presentation, actors, actorUuid, outcome);
  return accept(RESULT_CODES.INVENTORY_CAPACITY_STORED, outcome);
}

/**
 * Move one surplus piece to the Convoy through the same writer the inventory transfer uses, so it arrives
 * unequipped and its equipment effects come off the unit. A move that finds either side changed re-reads and
 * retries. If the unit or Convoy has since gone, it reports nothing.
 */
async function storeSurplusEquipment(actors, actorUuid, itemId, operation = null) {
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const [source, convoy] = await Promise.all([
      actors.getInventorySnapshot(actorUuid),
      actors.getLinkedConvoySnapshot(actorUuid)
    ]);
    const item = source?.items.find(entry => entry.id === itemId);
    if (!source || !convoy || !item) return {};
    const committed = await actors.receiveInventoryItem({
      source,
      target: convoy,
      itemId,
      move: true,
      sourceEffects: planEquipmentTransferConsequences(source, itemId, { move: true }),
      sourceResourceValues: await departureResources(actors, source, item),
      operation
    });
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) {
      return { refusal: refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { ...diagnosticData(committed),
        reasonCode: committed?.code ?? 'inventory.capacity-settlement-failed'
      }) };
    }
    return { itemName: item.name, convoyName: convoy.name };
  }
  return {};
}

/** Tell the unit's owners what left their unit. The GM hears it from this job's own result. */
async function presentCapacityMove(presentation, actors, actorUuid, outcome) {
  const audience = await actors.getOwnerUserIds(actorUuid);
  if (!audience.length) return;
  try {
    await presentation.presentCapacityMove(outcome, { audience: [...audience] });
  } catch (error) {
    recordDiagnostic(presentation.diagnostics,
      { sourcePath: import.meta.url, error, detail: 'Present an equipment capacity move' });
  }
}

async function reconcileCharacterEquipmentEffects(context, actors) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const operation = context.operation ?? null;
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const actor = await actors.getInventorySnapshot(actorUuid);
    if (!actor) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
    if (actor.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
    // Unequip items whose requirements lapsed before equipment-effects.mjs updates their modifiers. Like any
    // piece coming off, a lapsed one takes back the Stance (Stn) it granted.
    const lapsed = planRequirementUnequips(actor);
    const consequences = lapsed.updates.length
      ? planEquipmentToggleConsequences(await withStanceSource(actors, actor), lapsed.updates)
      : null;
    const plan = consequences?.effects ?? planEquipmentEffectReconciliation(actor);
    if (!lapsed.updates.length && !plan.deleteIds.length && !plan.createIntents.length) {
      return accept(RESULT_CODES.INVENTORY_EFFECTS_RECONCILED, { actorUuid, changed: false });
    }
    const committed = lapsed.updates.length
      ? await actors.settleEquipmentToggle(actor, {
        itemUpdates: lapsed.updates, effects: plan, resourceValues: consequences.resourceValues, operation
      })
      : await actors.reconcileEquipmentEffects(actor, plan, operation);
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { ...diagnosticData(committed),
      reasonCode: committed?.code ?? 'inventory.equipment-settlement-failed'
    });
    if (lapsed.unequipped.length) {
      return accept(RESULT_CODES.INVENTORY_REQUIREMENTS_UNEQUIPPED, {
        actorUuid, actorName: actor.name, changed: true, unequipped: lapsed.unequipped
      });
    }
    return accept(RESULT_CODES.INVENTORY_EFFECTS_RECONCILED, { actorUuid, changed: true });
  }
  return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: 'inventory.state-changed' });
}

async function transferCharacterItem(context, actors, events, authority) {
  const sourceActorUuid = String(context.payload?.sourceActorUuid ?? '');
  const targetActorUuid = String(context.payload?.targetActorUuid ?? '');
  const itemId = String(context.payload?.itemId ?? '');
  if (!sourceActorUuid || !targetActorUuid || sourceActorUuid === targetActorUuid) {
    return refuse(RESULT_CODES.INVENTORY_TRANSFER_FAILED);
  }
  let source;
  let target;
  let item;
  let admission;
  let amount = null;
  let moved = false;
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    [source, target] = await Promise.all([
      actors.getInventorySnapshot(sourceActorUuid),
      actors.getInventorySnapshot(targetActorUuid)
    ]);
    if (!source || !target) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
    if (target.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
    if (handoverLockedByEncounter({ inCombat: source.inCombat, isGM: authority.isGm(context.userId) === true })) {
      if (source.type === 'Convoy') return refuse(RESULT_CODES.CONVOY_LOCKED_IN_COMBAT, { convoyName: source.name });
      return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: EQUIPMENT_REFUSALS.HANDOVER_IN_COMBAT });
    }
    item = source.items.find(entry => entry.id === itemId);
    if (!item) return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: 'inventory.item-missing' });
    if (item.inbound === true) {
      return refuse(RESULT_CODES.CONVOY_INBOUND_LOCKED, { itemName: item.name, convoyName: source.name });
    }
    if (!characterActorItemDropAllowed(item)) {
      return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: 'inventory.innate-transfer' });
    }
    admission = characterItemAdmission(target, item);
    if (!admission.ok) return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, {
      reasonCode: admission.code,
      ...admission
    });
    amount = null;
    if (item.type === 'Resource') {
      const available = Math.max(1, Number(item.system?.amount) || 1);
      amount = Math.max(1, Math.min(available, Number(context.payload?.amount) || 1));
    }
    moved = characterItemTransfers(item);
    const sourceEffects = planEquipmentTransferConsequences(source, itemId, { move: moved });
    const committed = await actors.receiveInventoryItem({
      source,
      target,
      itemId,
      amount,
      stackId: admission.stackId ?? null,
      move: moved,
      sourceEffects,
      sourceResourceValues: moved ? await departureResources(actors, source, item) : {},
      operation: context.operation ?? null
    });
    if (committed?.stale !== true) {
      if (committed?.ok !== true) return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { ...diagnosticData(committed),
        reasonCode: committed?.code ?? 'inventory.transfer-settlement-failed'
      });
      break;
    }
    source = null;
    target = null;
  }
  if (!source || !target || !item || !admission) {
    return refuse(RESULT_CODES.INVENTORY_CHANGE_REFUSED, { reasonCode: 'inventory.state-changed' });
  }
  const outcome = {
    sourceActorUuid,
    sourceActorName: source.name,
    targetActorUuid,
    targetActorName: target.name,
    itemId,
    itemName: item.name,
    amount,
    moved
  };
  events.publish(EVENT_IDS.INVENTORY_ITEM_TRANSFERRED, {
    ...outcome,
    requestId: context.requestId,
    userId: context.userId
  });
  return accept(RESULT_CODES.INVENTORY_ITEM_RECEIVED, outcome);
}

/**
 * Add the unit's Stance source data, so the equipment rules in game/character/equipment-effects.mjs can tell
 * whether a gear change alters its Stance (Stn).
 */
async function withStanceSource(actors, actor) {
  return { ...actor, stanceSource: await actors.getStanceSource(actor.uuid) };
}

/** The Stance the giver keeps when a piece it has in use leaves by transfer or capacity move, or {} otherwise. */
async function departureResources(actors, source, item) {
  const system = item.system ?? {};
  if (system.isWielded !== true && system.isWorn !== true && system.isEquipped !== true) return {};
  return planEquipmentDepartureResources(await withStanceSource(actors, source), item.id);
}

/* -------------------------------------------- */
/*  Knowledge                                   */
/* -------------------------------------------- */
/**
 * Grant journal access only when the requester can already read the linked JournalEntry. The unit link grants no
 * authority.
 */
async function grantJournalAccess(context, { journals, authority }) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const journalUuid = String(context.payload?.journalUuid ?? '');
  const snapshot = await journals.getAccessSnapshot(actorUuid, journalUuid, context.userId);
  if (!snapshot) return refuse(RESULT_CODES.JOURNAL_NOT_FOUND, { actorUuid, journalUuid });
  if (snapshot.linked !== true) {
    return refuse(RESULT_CODES.JOURNAL_NOT_LINKED, { actorUuid, journalUuid, actorName: snapshot.actorName });
  }
  if (authority.isGm(context.userId) !== true && snapshot.requesterCanObserve !== true) {
    return refuse(RESULT_CODES.JOURNAL_ACCESS_DENIED, { actorUuid, journalUuid, actorName: snapshot.actorName });
  }
  const userIds = planJournalAccessGrant(snapshot.owners, snapshot.observerLevel);
  const committed = await journals.grantObserver(snapshot, userIds);
  if (committed?.ok !== true) return refuse(RESULT_CODES.COMMAND_FAILED, { reasonCode: 'character.journal-access-failed' });
  return accept(RESULT_CODES.JOURNAL_ACCESS_GRANTED, {
    actorUuid,
    journalUuid: snapshot.journalUuid,
    journalName: snapshot.journalName,
    userIds,
    changed: committed.changed === true
  });
}

/* -------------------------------------------- */
/*  Hotbar layout                               */
/* -------------------------------------------- */
/**
 * Run hotbar saves for one Actor one after another, before comparing and writing the layout revision. Saves are
 * inspect commands, which run outside the command slot, so this queue is what stops two saves from interleaving.
 * @param {object} ports The character contribution's ports.
 * @returns {Function} The command handler.
 */
function createHotbarLayoutHandler(ports) {
  const turns = new Map();
  return context => {
    const key = String(context.payload?.actorUuid ?? '');
    const run = (turns.get(key) ?? Promise.resolve()).then(() => saveHotbarLayout(context, ports));
    const settled = run.then(() => undefined, () => undefined);
    turns.set(key, settled);
    void settled.then(() => { if (turns.get(key) === settled) turns.delete(key); });
    return run;
  };
}

/**
 * Save an owned Actor’s shared hotbar layout. Reject stale revisions and remove references to items the Actor no
 * longer carries.
 */
async function saveHotbarLayout(context, { actors }) {
  const intent = normalizeHotbarLayoutIntent(context.payload);
  if (!intent) return refuse(HOTBAR_LAYOUT_OUTCOMES.INVALID);
  const snapshot = await actors.getHotbarLayoutSnapshot(intent.actorUuid);
  if (!snapshot) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
  if (snapshot.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
  if (snapshot.revision !== intent.expectedRevision) {
    return refuse(HOTBAR_LAYOUT_OUTCOMES.STALE, { actorUuid: snapshot.actorUuid, revision: snapshot.revision });
  }
  const removed = pruneForeignHudCells(intent.state, snapshot.itemUuids);
  const saved = await actors.saveHotbarLayout(snapshot, intent.state);
  if (saved?.stale === true) {
    return refuse(HOTBAR_LAYOUT_OUTCOMES.STALE, { actorUuid: snapshot.actorUuid, revision: saved.revision });
  }
  if (saved?.ok !== true) {
    return refuse(RESULT_CODES.COMMAND_FAILED, { actorUuid: snapshot.actorUuid, reasonCode: 'hotbar.layout-write-failed' });
  }
  return accept(HOTBAR_LAYOUT_OUTCOMES.SAVED, { actorUuid: snapshot.actorUuid, revision: saved.revision, removed });
}

/* -------------------------------------------- */
/*  Skill checks                                */
/* -------------------------------------------- */
function createSkillCheckHandler({ diagnostics, actors, events, checks, checkPresentation }) {
  return async context => {
    const actorUuid = String(context.payload?.actorUuid ?? '');
    const skillKey = String(context.payload?.skillKey ?? '').toLowerCase();
    const mode = String(context.payload?.mode ?? 'standard');
    const dc = nullableDc(context.payload?.dc);
    const actor = await actors.getSnapshot(actorUuid);
    if (!actor) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
    if (actor.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
    if (!SKILL_BY_KEY[skillKey]) return refuse(RESULT_CODES.SKILL_REQUIRED);
    if (!CHECK_ROLL_MODES.includes(mode)) return refuse(RESULT_CODES.ROLL_MODE_INVALID);
    if (Number.isNaN(dc)) return refuse(RESULT_CODES.CHECK_DC_INVALID);

    const statKey = SKILL_BY_KEY[skillKey].stat;
    const check = buildSkillCheck({
      skillKey,
      mode,
      dc,
      rank: actor.skills[skillKey],
      statValue: actor.attributes[statKey],
      actorType: actor.actorType,
      blessed: actor.blessed
    });
    const roll = await checks.roll(actorUuid, check, { requestId: context.requestId, operation: context.operation });
    const outcome = {
      actorUuid,
      actorName: actor.name,
      skillKey,
      mode,
      dc,
      natural: roll.natural,
      total: roll.total,
      success: roll.success,
      requestId: context.requestId,
      userId: context.userId
    };
    events.publish(EVENT_IDS.SKILL_CHECK_ROLLED, outcome);
    try {
      await checkPresentation.presentSkill({
        requester: context.requester ?? { userId: context.userId, messageMode: context.messageMode },
        ...outcome,
        actorImage: actor.img,
        avatarScale: actor.avatarScale,
        effectName: boundedText(context.payload?.effectName),
        targetName: boundedText(context.payload?.targetName),
        check,
        roll
      });
    } catch (diagnosticError) {
      recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'createSkillCheckHandler' });
    }
    return accept(RESULT_CODES.SKILL_ROLLED, {
      actorUuid,
      actorName: actor.name,
      skillKey,
      mode,
      dc,
      natural: roll.natural,
      total: roll.total,
      success: roll.success
    });
  };
}

function boundedText(value) {
  return String(value ?? '').slice(0, 512);
}

/* -------------------------------------------- */
/*  Innate grants                               */
/* -------------------------------------------- */
/**
 * Bring one Character's innate grants up to date: create missing grants from their source items, refresh or adopt
 * existing ones, and remove duplicates and grants the unit no longer qualifies for. planInnateGrants decides the
 * changes, and the character writer's settleInnateGrants applies them in one batch recorded for undo. The hook in
 * foundry/hooks/innate-grants.mjs submits this command to MaintenanceScheduler.
 */
async function reconcileInnateGrants(context, { actors, events }) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const snapshot = await actors.getInnateGrantSnapshot(actorUuid);
  if (!snapshot) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
  if (snapshot.type !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
  const plan = planInnateGrants(snapshot, snapshot.sources);
  const changed = plan.updates.length + plan.deleteIds.length + plan.creates.length;
  if (!changed) {
    return accept(RESULT_CODES.INNATE_GRANTS_RECONCILED, { actorUuid, actorName: snapshot.name, changed: 0 });
  }
  const settled = await actors.settleInnateGrants(snapshot, plan, context.operation ?? null);
  if (!settled.ok) {
    return refuse(RESULT_CODES.INNATE_GRANT_SETTLEMENT_FAILED, { ...diagnosticData(settled),
      actorUuid, actorName: snapshot.name, reasonCode: settled.code, stale: settled.stale === true
    });
  }
  const outcome = {
    actorUuid,
    actorName: snapshot.name,
    changed,
    created: plan.creates.map(data => data.name),
    deletedIds: [...plan.deleteIds],
    updatedIds: plan.updates.map(update => update.itemId),
    requestId: context.requestId,
    userId: context.userId
  };
  events.publish(EVENT_IDS.INNATE_GRANTS_RECONCILED, outcome);
  return accept(RESULT_CODES.INNATE_GRANTS_RECONCILED, outcome);
}
