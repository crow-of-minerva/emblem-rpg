/** @layer engine/combat/exchanges */
import {
  COMBAT_CONTINUATIONS,
  COMBAT_EXCHANGE_TIMING,
  normalizeCombatContinuationIntent,
  normalizeCombatExchangeIntent
} from '../../../contracts/domains/combat.mjs';
import { COMMAND_IDS } from '../../../contracts/commands.mjs';
import {
  keptTurnSlots, resolveCombatContinuation, resolveCombatContinuationChoice
} from '../../../game/combat/exchange.mjs';
import { resolveSettledStanding, resolveStandingDestination } from '../../../game/movement/pathfinding.mjs';
import { addUse, drawnExchangeReads, objectDelay, proficiencyUpdates, runCombatSequence } from './blows.mjs';
import { CombatPersistenceError, StaleCombatError } from '../../recovery/errors.mjs';
import { cardRequester, presentSafely, runSafely, runSafelyAsync } from '../../feedback.mjs';
import { requireOpeningExchangeSnapshot, requireSettlementSnapshot, validateSnapshot } from './gates.mjs';
import { endMessage, rankUpMessage, startMessage, weaponArtMessage } from './receipts.mjs';
import {
  collectRestores,
  eventsAfterCommit,
  publishCombatExperience,
  publishStanceBreaks,
  recordStanceBreak,
  exchangeSlain,
  revalidateEffectDefeats,
  runActiveTriggers,
  settleCombatExperience,
  settleDefeatPresentations,
  settleDeferredEndTurn
} from './settlement.mjs';
import { createCommandAuthorization } from '../../authorization.mjs';
import { accept, refuse, RESULT_CODES } from '../../../contracts/results.mjs';
import {
  createDiagnostic, diagnosticPayload, recordDiagnostic, requirePorts, DIAGNOSTIC_SEVERITIES
} from '../../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Exchange orchestration                      */
/* -------------------------------------------- */

/**
 * The attack command: check the attack, run the blows, write the results, then show them.
 *
 * The whole command is one operation: the blows, the closing writes, the defeats it finishes at the end, the XP
 * and what the attacker does next. Every write saves undo data on `context.operation`; the host client keeps the
 * writes if this handler accepts, and undoes them if it refuses or throws.
 */
async function resolveExchange(context, services) {
  const intent = normalizeCombatExchangeIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.COMBAT_EXCHANGE_INPUT_INVALID);
  const snapshot = await services.combatState.getSnapshot(intent);
  const refusal = validateSnapshot(snapshot, intent, context.userId);
  if (refusal) return refusal;
  if (!resolveStandingDestination(snapshot.movement)) {
    return refuse(RESULT_CODES.MOVEMENT_DESTINATION_INVALID);
  }

  const exchange = createExchangeState(snapshot, intent, context);
  try {
    await openExchange(services, exchange);
    await runCombatSequence(services, exchange);
    await commitExchange(services, exchange);
    return await publishExchange(services, exchange);
  } catch (error) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: error, detail: 'resolveExchange',
      severity: error instanceof StaleCombatError ? DIAGNOSTIC_SEVERITIES.DEBUG : DIAGNOSTIC_SEVERITIES.ERROR });
    return failExchange(services, exchange, error);
  }
}

/** The distance and engagement as the map stands, which a pre-combat trigger reads before any move it makes. */
function boardFacts(snapshot) {
  return {
    distance: snapshot.boardDistance ?? snapshot.distance,
    engagement: snapshot.boardEngagement ?? snapshot.engagement
  };
}

/** The working state one attack carries from its opening to its last animation. */
function createExchangeState(snapshot, intent, context) {
  return {
    intent,
    context,
    sceneUuid: snapshot.sceneUuid,
    operation: context.operation ?? null,
    snapshot,
    transcript: [],
    useLedger: {},
    karmaBookings: [],
    bookedKarma: [],
    modifierChances: null,
    proficiencyAwards: new Map(),
    effectHealth: [],
    restores: [],
    brokenItems: new Set(),
    stanceBreaks: [],
    preCombatEffectIndex: 0,
    defenderCouldCounterAtStart: false,
    defenderCountered: false,
    cinematicStarted: false,
    progressionSettlement: null,
    walked: null,
    rankUps: [],
    outcome: null
  };
}

/* -------------------------------------------- */
/*  Opening                                     */
/* -------------------------------------------- */

/**
 * Open the attack after the preview check: roll its chance modifiers, read the map again, save undo data for
 * everything an attack always writes in one go, then land the attacker if attacking grounds it, and run the
 * pre-combat animation and effects.
 */
async function openExchange(services, exchange) {
  const { intent, context } = exchange;
  exchange.modifierChances = await services.combatState.drawModifierChances(exchange.snapshot);
  const snapshot = await requireOpeningExchangeSnapshot(
    drawnExchangeReads(services.combatState, exchange.modifierChances, exchange.operation, context.userId), intent,
    context.userId
  );
  exchange.snapshot = snapshot;
  exchange.walked = resolveStandingDestination(snapshot.movement);
  if (!exchange.walked) throw new StaleCombatError();
  await services.settlement.captureExchange(snapshot, exchange.operation);
  await services.settlement.settleGrounding(snapshot.source, exchange.operation);
  await services.settlement.prepareExchange(snapshot, exchange.operation);
  await presentSafely(services, startMessage(snapshot));
  exchange.cinematicStarted = snapshot.cinematic === true;
  await services.wait(objectDelay(snapshot)
    ? COMBAT_EXCHANGE_TIMING.objectLeadIn : COMBAT_EXCHANGE_TIMING.characterLeadIn);
  if (snapshot.source.weaponArt) {
    // A Weapon Art costs its weapon this many uses once per attack. The Art's own uses are counted per blow in
    // settleBlow (blows.mjs).
    addUse(exchange.useLedger, snapshot.source.weapon.uuid, snapshot.sourceWeaponArtCost);
    await presentSafely(services, weaponArtMessage(snapshot));
    await services.wait(COMBAT_EXCHANGE_TIMING.weaponArtFlourish);
  }
  exchange.preCombatEffectIndex = exchange.effectHealth.length;
  if (objectDelay(snapshot)) return;
  await runActiveTriggers(
    services, snapshot.source, snapshot.target, snapshot, ['preCombat'],
    boardFacts(snapshot), exchange.effectHealth
  );
  await revalidateEffectDefeats(services, exchange.effectHealth, exchange.preCombatEffectIndex, exchange.operation);
  await services.wait(COMBAT_EXCHANGE_TIMING.preCombatTail);
}

/* -------------------------------------------- */
/*  Commit                                      */
/* -------------------------------------------- */

/**
 * Write item uses, weapon proficiency and XP, switch an Adaptive weapon, save what the attacker does next, run the
 * postCombat triggers, clean up and book karma, all under the command's operation.
 */
async function commitExchange(services, exchange) {
  const { intent, context } = exchange;
  const reads = drawnExchangeReads(
    services.combatState, exchange.modifierChances, exchange.operation, context.userId, true
  );
  let snapshot = await requireSettlementSnapshot(reads, intent);
  await services.settlement.commitItemUses(exchange.useLedger, exchange.operation);
  const proficiency = proficiencyUpdates(exchange.proficiencyAwards);
  await services.settlement.commitProgression(proficiency.updates, exchange.operation);
  exchange.rankUps = proficiency.rankUps;
  const attackDefeat = {
    sourceDefeated: snapshot.source.hp.value <= 0,
    targetDefeated: snapshot.target.hp.value <= 0
  };
  exchange.progressionSettlement = await settleCombatExperience(
    services.progression, snapshot, attackDefeat, exchange.defenderCouldCounterAtStart
  );
  if (exchange.progressionSettlement.ok !== true) {
    throw new CombatPersistenceError(exchange.progressionSettlement.code ?? 'combat.experience-settlement-failed');
  }
  snapshot = await requireSettlementSnapshot(reads, intent);
  await services.settlement.settleAdaptive(snapshot.target, exchange.defenderCountered, exchange.operation);
  const movementResolution = resolveSettledStanding(exchange.walked, snapshot.movement);
  if (!movementResolution) throw new StaleCombatError();
  const continuation = resolveCombatContinuation({
    sourceDefeated: snapshot.source.hp.value <= 0,
    explorationActive: snapshot.explorationActive,
    hasMultiAttack: snapshot.source.hasMultiAttack,
    bonusAvailable: snapshot.source.bonusAvailable,
    extraActionsRemaining: snapshot.source.extraActionsRemaining,
    extraActionUsed: snapshot.source.extraActionUsed,
    hasCanter: snapshot.source.hasCanter,
    movementRemaining: Math.max(0, snapshot.movement.allowance - movementResolution.cost),
    turnRefreshed: keptTurnSlots(exchange.restores, snapshot.sourceActorUuid)?.action === true
  });
  if (!await services.settlement.settleSourceContinuation(
    snapshot, movementResolution, continuation, context.requestId, { cantersAfter: true }
  )) throw new StaleCombatError();

  const postCombatSnapshot = await requireSettlementSnapshot(reads, intent);
  const postCombatEffectIndex = exchange.effectHealth.length;
  const runsPostCombat = !objectDelay(snapshot);
  // With no postCombat entry to plan, nothing below writes or waits, so the post-combat read is still current.
  const postCombatMayWrite = runsPostCombat
    && postCombatSnapshot.source.effects.some(entry => entry?.trigger === 'postCombat');
  if (runsPostCombat) {
    collectRestores(await runActiveTriggers(services, postCombatSnapshot.source, postCombatSnapshot.target,
      postCombatSnapshot, ['postCombat'], {
        targetSlain: attackDefeat.targetDefeated,
        slainActorUuids: exchangeSlain(exchange.transcript, exchange.effectHealth)
      }, exchange.effectHealth), exchange.restores);
    await revalidateEffectDefeats(services, exchange.effectHealth, postCombatEffectIndex, exchange.operation);
  }
  const finalSnapshot = postCombatMayWrite ? await requireSettlementSnapshot(reads, intent) : postCombatSnapshot;
  await services.settlement.cleanupExchange(finalSnapshot.source, finalSnapshot.target, exchange.operation);
  exchange.bookedKarma = await services.settlement.commitKarma(exchange.karmaBookings) ?? [];
  exchange.outcome = exchangeOutcome(exchange, snapshot, finalSnapshot, movementResolution, continuation);
}

function exchangeOutcome(exchange, snapshot, finalSnapshot, movementResolution, continuation) {
  const { context } = exchange;
  return Object.freeze({
    sourceTokenUuid: snapshot.sourceTokenUuid,
    targetTokenUuid: snapshot.targetTokenUuid,
    sourceActorUuid: snapshot.sourceActorUuid,
    targetActorUuid: snapshot.targetActorUuid,
    itemUuid: snapshot.sourceItemUuid,
    sequence: Object.freeze(exchange.transcript),
    effectHealth: Object.freeze(exchange.effectHealth),
    movementCost: movementResolution.cost,
    continuation: Object.freeze({
      ...continuation,
      exchangeRequestId: context.requestId,
      keptSlots: keptTurnSlots(exchange.restores, snapshot.sourceActorUuid)
    }),
    sourceDefeated: finalSnapshot.source.hp.value <= 0,
    targetDefeated: finalSnapshot.target.hp.value <= 0,
    requestId: context.requestId,
    userId: context.userId,
    cinematic: snapshot.cinematic,
    objectTarget: snapshot.target.destructible === true,
    modifierChances: exchange.modifierChances,
    karmaBookings: Object.freeze([...exchange.bookedKarma])
  });
}

/* -------------------------------------------- */
/*  Publication                                 */
/* -------------------------------------------- */

/**
 * Finish the defeats the blows claimed, hold the attack's events until the command commits, and send the closing
 * feedback. A failure in this step (an animation, a Token removal or loot drop, or the deferred end of turn) is
 * listed in the accepted result and never turns the attack into a refusal, so the writes still stand and the held
 * events are delivered. A defeat that fails here leaves its unit at 0 HP with the defeat pending, and the next
 * phase change of the encounter finishes it.
 */
async function publishExchange(services, exchange) {
  const { outcome, context, transcript, effectHealth, operation } = exchange;
  for (const consequence of effectHealth) recordStanceBreak(exchange.stanceBreaks, consequence.stanceBreak);
  const failures = [];
  const holdEvents = () => eventsAfterCommit(services.events, outcome, transcript, effectHealth, operation);
  if (!runSafely(services, holdEvents, 'events')) failures.push('events');
  if (!await runSafelyAsync(services, () => publishStanceBreaks(services, exchange.stanceBreaks, context), 'stances')) {
    failures.push('stances');
  }
  if (!await runSafelyAsync(services, () => settleDefeatPresentations(
    services, [...transcript, ...effectHealth], exchange.snapshot, context
  ), 'defeat')) failures.push('defeat');
  if (!outcome.objectTarget) await services.wait(COMBAT_EXCHANGE_TIMING.postSequence);
  if (!await runSafelyAsync(services, () => publishCombatExperience(
    services.progression, exchange.progressionSettlement, context, services.wait
  ), 'progression')) failures.push('progression');
  const requester = cardRequester(context);
  for (const rankUp of exchange.rankUps) await presentSafely(services, rankUpMessage(rankUp, requester));
  if (!await presentSafely(services, endMessage(outcome))) failures.push('presentation');
  if (!await runSafelyAsync(services, () => settleDeferredEndTurn(services, outcome, exchange.operation),
    'continuation')) failures.push('continuation');
  await services.wait(COMBAT_EXCHANGE_TIMING.cinematicTail);
  exchange.cinematicStarted = false;
  return accept(RESULT_CODES.COMBAT_EXCHANGE_RESOLVED, {
    ...outcome,
    postCommitComplete: failures.length === 0,
    postCommitFailures: Object.freeze(failures)
  });
}

/**
 * Close an opened cinematic and answer with the refusal the interruption calls for.
 * Nothing is undone here: CommandDispatcher undoes the command's writes when it sees this refusal.
 */
async function failExchange(services, exchange, error) {
  if (exchange.cinematicStarted) {
    await presentSafely(services, endMessage({
      cinematic: true,
      objectTarget: exchange.snapshot?.target?.destructible === true,
      sourceTokenUuid: exchange.snapshot?.sourceTokenUuid,
      targetTokenUuid: exchange.snapshot?.targetTokenUuid
    }));
  }
  if (error instanceof StaleCombatError) return refuse(RESULT_CODES.COMBAT_EXCHANGE_STALE);
  return refuse(RESULT_CODES.COMMAND_FAILED, {
    reasonCode: error instanceof CombatPersistenceError ? error.code : RESULT_CODES.COMBAT_EXCHANGE_FAILED,
    diagnostic: diagnosticPayload(createDiagnostic({
      sourcePath: import.meta.url, error, detail: `Exchange ${exchange.context?.requestId ?? ''} interrupted`
    }))
  });
}

/* -------------------------------------------- */
/*  Combat commands                             */
/* -------------------------------------------- */

/** The attack and Extra Action choice command definitions init/system.mjs registers with CommandDispatcher. */
export function createCombatCommandContribution({
  combatState, settlement, effects, presentation, events, progression, stances, objects, diagnostics, authority, wait
}) {
  requirePorts('createCombatCommandContribution', { combatState, settlement, effects, presentation, events,
    progression, stances, objects, diagnostics, wait });
  const services = {
    combatState, settlement, effects, presentation, events, progression, stances, objects, diagnostics,
    wait
  };
  const authorize = createCommandAuthorization(authority);
  const sourceController = authorize.tokenController(payload => payload.sourceTokenUuid);
  return [
    {
      id: COMMAND_IDS.COMBAT.RESOLVE_EXCHANGE,
      authorize: sourceController,
      concurrencyKeys: context => combatState.resourceKeys(context.payload),
      handler: context => resolveExchange(context, services)
    },
    {
      id: COMMAND_IDS.COMBAT.RESOLVE_CONTINUATION,
      authorize: sourceController,
      concurrencyKeys: context => combatState.continuationResourceKeys(context.payload),
      handler: context => resolvePendingContinuation(context, services)
    },

  ];
}

/* -------------------------------------------- */
/*  Continuation choice                         */
/* -------------------------------------------- */

/** Apply the player's Extra Action answer to the pending continuation the attack saved. */
async function resolvePendingContinuation(context, services) {
  const intent = normalizeCombatContinuationIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.COMBAT_CONTINUATION_UNAVAILABLE);
  const snapshot = await services.combatState.getContinuationSnapshot(intent.sourceTokenUuid);
  if (!snapshot || snapshot.continuationPending !== COMBAT_CONTINUATIONS.EXTRA_ACTION_CHOICE) {
    return refuse(RESULT_CODES.COMBAT_CONTINUATION_UNAVAILABLE);
  }
  if (snapshot.continuationRequestId !== intent.exchangeRequestId
    || !services.combatState.canUserOwnContinuation(snapshot, context.userId)) {
    return refuse(RESULT_CODES.COMBAT_CONTINUATION_STALE);
  }
  const continuation = resolveCombatContinuationChoice({
    decision: intent.decision,
    sourceDefeated: snapshot.sourceDefeated,
    extraActionsRemaining: snapshot.extraActionsRemaining,
    extraActionUsed: snapshot.extraActionUsed,
    cantersAfter: snapshot.continuationCanters,
    hasCanter: snapshot.hasCanter,
    movementRemaining: snapshot.movementRemaining
  });
  if (!continuation) return refuse(RESULT_CODES.COMBAT_CONTINUATION_UNAVAILABLE);
  if (!await services.settlement.settlePendingContinuation(snapshot, continuation, context.operation ?? null)) {
    return refuse(RESULT_CODES.COMBAT_CONTINUATION_STALE);
  }
  return accept(RESULT_CODES.COMBAT_CONTINUATION_RESOLVED, {
    sourceTokenUuid: snapshot.sourceTokenUuid,
    sourceActorUuid: snapshot.sourceActorUuid,
    exchangeRequestId: intent.exchangeRequestId,
    continuation,
    requestId: context.requestId,
    userId: context.userId
  });
}
