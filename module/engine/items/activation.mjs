/** @layer engine/items */
import { COMMAND_IDS } from '../../contracts/commands.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import {
  ITEM_ACTIVATION_PRESENTATION_BEATS,
  ITEM_ACTIVATION_TIMING,
  ITEM_USE_PROFICIENCY_HIT_RATIO,
  itemActivationPresentationMessage,
  normalizeItemActivationIntent
} from '../../contracts/domains/items.mjs';
import { COMBAT_CONTINUATIONS, KARMA_LEDGER_RESOURCE_KEY } from '../../contracts/domains/combat.mjs';
import { CombatPersistenceError } from '../recovery/errors.mjs';
import { collectEffectDefeats, settleEffectDefeats } from '../combat/defeat.mjs';
import { effectContext, effectRuntime } from '../effects/request.mjs';
import { unitImpact } from '../effects/execution.mjs';
import { grantSkillExperience } from '../character/skill-experience.mjs';
import { cardRequester, presentSafely, recordAbsorbed, requesterAudience } from '../feedback.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { SKILL_BY_KEY, areFactionsFriendly, areFactionsOpposed } from '../../game/character/rules.mjs';
import { resolveSettledStanding, resolveStandingDestination } from '../../game/movement/pathfinding.mjs';
import {
  activationAllowsCanter,
  activationCastCondition,
  activationHoldsCastArt,
  activationTriggers,
  boosterGainLine,
  planBoosterGains,
  resolveActivationContinuation,
  resolveActivationActionSpend,
  resolveActivationConsumption,
  resolveActivationDelivery,
  resolveActivationLanded,
  resolveSaveAdvantage,
  activationRequiredProficiency,
  activationRequirements,
  explorationAllowsItem,
  isMountActivation,
  validateActivationLegality,
  validateActivationRequirements,
  validateActivationParams,
  validateActivationReach,
  validateActivationTargets,
  validateForcedMovementSquare,
  validateGroundPlacement,
  validateMountActivation
} from '../../game/items/activation.mjs';
import { activationCheckFailed, rememberedCheck } from '../../game/items/retraction.mjs';
import {
  buildSavingThrow,
  buildSkillCheck,
  calculateSavingThrowDifficulty,
  calculateSkillCheckDifficulty
} from '../../game/rolls/checks.mjs';
import { earnsCharacterExperience, resolveWeaponExperience } from '../../game/progression/rules.mjs';
import { resolveActivationExperience } from '../../game/progression/activation-experience.mjs';
import { isStealAbility } from '../../game/economy/trade.mjs';
import {
  groundsOnInteraction, planForcedLanding, planMovementSettlement
} from '../../game/movement/input-policy.mjs';
import {
  canRallyTarget, planRallyEffect, rallyCasterFacts, ralliesOn, rallyRankFor
} from '../../game/support/rules.mjs';
import { RALLY_SUPPORT_XP } from '../../contracts/domains/progression.mjs';
import { resolveGuardBond } from '../../game/effects/planning.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { recordDiagnostic, requirePorts, DIAGNOSTIC_SEVERITIES } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Activation commands                         */
/* -------------------------------------------- */

/**
 * The ITEMS.ACTIVATE and ITEMS.RETRACT commands, registered with CommandDispatcher from init/system.mjs. A use
 * arrives through the public API's `items.activate` (api/facade.mjs), from the targeting controls
 * (ui/controls/targeting.mjs) and the Enemy AI. Taking a use back arrives through `items.retract`, which the Cancel
 * key calls from ui/controls/movement.mjs.
 */
export function createItemActivationCommandContribution({
  diagnostics, activations, settlement, retractions, effects, checks, continuations, presentation,
  checkPresentation, skills, support, events, progression, movements, inventory, defeats, objects, authority, wait
}) {
  requirePorts('createItemActivationCommandContribution', { diagnostics, activations, settlement, retractions,
    effects, checks, continuations, presentation, checkPresentation, skills, support, events, progression,
    movements, inventory, defeats, objects, wait });
  const services = { diagnostics,
    activations, settlement, retractions, effects, checks, continuations, presentation, checkPresentation, skills,
    support, events, progression, movements, inventory, defeats, objects, wait
  };
  const authorize = createCommandAuthorization(authority);
  return [
    {
      id: COMMAND_IDS.ITEMS.ACTIVATE,
      authorize: authorize.tokenController(payload => payload.sourceTokenUuid),
      // A karmic check writes the world's karma ledger, so the use lists that key among the things it writes.
      concurrencyKeys: async context => [...await activations.resourceKeys(context.payload), KARMA_LEDGER_RESOURCE_KEY],
      handler: context => activateItem(context, services)
    },
    {
      id: COMMAND_IDS.ITEMS.RETRACT,
      authorize: authorize.tokenController(payload => payload.tokenUuid, { requirePlan: true }),
      concurrencyKeys: context => movements.resourceKeys(String(context.payload?.tokenUuid ?? '')),
      handler: context => retractItem(context, services)
    }
  ];
}

/* -------------------------------------------- */
/*  Activation orchestration                    */
/* -------------------------------------------- */

async function activateItem(context, services) {
  const intent = normalizeItemActivationIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.ITEM_ACTIVATION_INPUT_INVALID);
  const snapshot = await services.activations.getSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.ITEM_ACTIVATION_INPUT_INVALID);
  if (snapshot.unsupported === true) return refuse(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);
  if (snapshot.explorationActive === true && !explorationAllowsItem(snapshot.item)) {
    return refuse(RESULT_CODES.ITEM_ACTIVATION_EXPLORATION_FORBIDDEN);
  }
  const refusal = validateActivationRequest(snapshot, intent, services.activations.geometryResolver(snapshot));
  if (refusal) return refusal;

  // The item-use data plus this command's operation, which records every write so a failed use can be undone.
  const owned = { ...snapshot, operation: context.operation ?? null };
  return deliverActivatedItem(context, services, owned, intent);
}

/**
 * Run one item use on the host client: the opening animation, on-use passives, effects on each target, costs, XP
 * and what the unit does next. Then remove the units it defeated, pause for the animation, and end the turn if the
 * use ends it. If the handler refuses or throws, every change the use made is undone.
 *
 * A retractable item (`envelope.retractable`) leaves the movement plan open, with no XP, closing pause or turn end.
 * Its use is kept on the unit with the undo record of everything it wrote, so Cancel can take it back (retractItem),
 * and the item's uses are spent only when the use becomes final. Any other use makes a kept use final first.
 */
async function deliverActivatedItem(context, services, snapshot, intent) {
  const retractable = snapshot.envelope.retractable === true;
  // A unit keeps one use at most, so a retractable use made while another is kept is final straight away.
  const keepsUse = retractable && snapshot.source.retraction.pending !== true
    && typeof context.operation?.retain === 'function';
  const remembered = keepsUse ? snapshot.source.retraction.memory : null;
  const rolls = keepsUse ? { replay: remembered?.rolls ?? {}, journal: {} } : null;
  const cinematic = intent.cinematic === true && snapshot.item.skipCinematic !== true;
  const deliveries = [];
  const claims = [];
  const impacts = [];
  let experience = null;
  let continuation = null;
  let cinematicStarted = false;
  try {
    if (!await services.activations.stillCurrent(snapshot)) {
      throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_STALE);
    }
    if (!keepsUse) await services.retractions.commit(snapshot.source.actorUuid, snapshot.operation);
    const walked = retractable ? null : await resolveWalkedLeg(services, snapshot);
    cinematicStarted = cinematic;
    await presentSafely(services, leadInMessage(snapshot, intent, cinematic));
    await services.settlement.captureUse(snapshot);
    await settleSanctuary(services.settlement, snapshot);
    await runUseItemPassives(services, snapshot, intent, context, claims, rolls);
    await presentSafely(services, castMessage(snapshot, intent));
    await settleMountToggle(services, snapshot);

    const shared = await rollSharedSkillCheck(services, snapshot, context);
    deliveries.push(...await deliverActivation(services, snapshot, intent, context, shared,
      { claims, impacts, rolls, remembered }));
    const kept = keepsUse && !activationCheckFailed(deliveries);
    if (await settleActivationCosts(services, snapshot, deliveries, context, { kept }) !== true) {
      throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
    }
    await settleRallySupport(services, snapshot, deliveries, context);
    await settleAdjacentGrounding(services, snapshot);
    if (retractable) {
      continuation = resolveActivationContinuation({ retractable: true });
      await settleRetraction(services, snapshot, context, deliveries, { kept, rolls });
    } else {
      experience = await settleActivationExperience(services, snapshot, impacts);
      await settleItemProficiency(services, snapshot, context);
      continuation = await settleActivationContinuation(services, snapshot, context, walked);
    }
  } catch (error) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: error, detail: 'deliverActivatedItem',
      severity: error instanceof CombatPersistenceError && error.code === RESULT_CODES.ITEM_ACTIVATION_STALE
        ? DIAGNOSTIC_SEVERITIES.DEBUG : DIAGNOSTIC_SEVERITIES.ERROR });
    if (cinematicStarted) await presentSafely(services, endMessage(snapshot, true));
    return refuse(error instanceof CombatPersistenceError ? error.code : RESULT_CODES.COMMAND_FAILED);
  }

  const outcome = activationOutcome(snapshot, deliveries, continuation, context);
  services.events.publish(EVENT_IDS.ITEM_ACTIVATION_COMMITTED, outcome, { operation: context.operation ?? null });
  await settleActivationDefeats(services, claims, context);
  if (!retractable) await services.wait(ITEM_ACTIVATION_TIMING.settleTail);
  await publishActivationExperience(services, experience, context);
  await presentSafely(services, endMessage(snapshot, cinematic));
  if (!retractable) await settleDeferredEndTurn(services, outcome, context.operation ?? null);
  return accept(RESULT_CODES.ITEM_ACTIVATED, outcome);
}

/**
 * Finish a retractable use. A failed skill check locks the item for the rest of the phase. A kept use is saved on
 * the unit with a copy of the undo record, taken here after every other write the use made.
 */
async function settleRetraction(services, snapshot, context, deliveries, { kept, rolls }) {
  if (activationCheckFailed(deliveries)) {
    await services.retractions.lock(snapshot.source.actorUuid, snapshot.envelope.itemUuid, snapshot.operation);
    return;
  }
  if (!kept) return;
  const record = await context.operation.retain();
  await services.retractions.keep(snapshot.source.tokenUuid, {
    record,
    itemUuid: snapshot.envelope.itemUuid,
    landed: deliveries.some(delivery => delivery.landed === true),
    check: rememberedCheck(deliveries),
    rolls: { ...rolls.replay, ...rolls.journal }
  }, snapshot.operation);
}

/**
 * Take back the unit's kept retractable use (ITEMS.RETRACT): every write it made is undone, which gives its bonus
 * action back. A unit that walked on from the use in the same open plan is first put back on the use's square, in
 * the same undo record. It is refused when nothing is kept or the unit has moved in a way this can't undo. What the
 * use rolled stays remembered, so using the item again this turn rolls the same.
 */
async function retractItem(context, services) {
  const tokenUuid = String(context.payload?.tokenUuid ?? '');
  const standing = await services.retractions.getStanding(tokenUuid);
  if (!standing?.pending) return refuse(RESULT_CODES.ITEM_RETRACTION_NONE);
  if (standing.moved && !standing.returnable) return refuse(RESULT_CODES.ITEM_RETRACTION_MOVED);
  try {
    if (standing.moved && !await returnToUseSquare(services.movements, tokenUuid, context.operation ?? null)) {
      return refuse(RESULT_CODES.ITEM_RETRACTION_MOVED);
    }
    if (await services.retractions.retract(tokenUuid, context.operation ?? null) !== true) {
      return refuse(RESULT_CODES.ITEM_RETRACTION_FAILED);
    }
  } catch (error) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error, detail: 'retractItem' });
    return refuse(RESULT_CODES.ITEM_RETRACTION_FAILED);
  }
  return accept(RESULT_CODES.ITEM_RETRACTED, {
    tokenUuid, actorUuid: standing.actorUuid, itemUuid: standing.itemUuid,
    requestId: context.requestId, userId: context.userId
  });
}

/**
 * Put the unit back on the square of its kept use, as movement.rollback puts it back on its anchor, with the plan
 * left open. False when it can't: the walk since the use is committed, or the plan is a canter or exploration.
 */
async function returnToUseSquare(movements, tokenUuid, operation) {
  const snapshot = await movements.getSnapshot(tokenUuid);
  const use = snapshot?.retraction;
  if (use?.returnable !== true) return false;
  if (!planMovementSettlement({ canter: snapshot.canterPathfinding, exploring: snapshot.exploring }).rollback) {
    return false;
  }
  return movements.cancel(snapshot, { keepPlanning: true, restoreAnchor: true, position: use.position, operation });
}

function validateActivationRequest(snapshot, intent, resolveTerrainGeometry) {
  const envelope = snapshot.envelope;
  const legality = validateActivationLegality({
    envelope,
    controlled: true,
    turnOver: snapshot.source.turnOver,
    standardAvailable: snapshot.source.standardAvailable,
    bonusAvailable: snapshot.source.bonusAvailable,
    magicBlocked: snapshot.source.magicBlocked,
    magical: snapshot.item.magical,
    stanceAvailable: snapshot.source.stanceAvailable,
    item: snapshot.source.conditionItem,
    proficiencyTotal: snapshot.source.proficiency?.total,
    locked: snapshot.source.lockedItems.includes(snapshot.envelope.itemUuid)
  });
  if (!legality.ok) return refuse(legality.code, legality.data);
  const landing = planForcedLanding({
    grounds: touchGrounds(snapshot), landingBlocked: snapshot.source.landingBlocked
  });
  if (!landing.ok) return refuse(landing.code);
  const saddle = validateMountActivation({ envelope, source: snapshot.source });
  if (!saddle.ok) return refuse(saddle.code);
  const targets = validateActivationTargets(
    envelope, snapshot.source.actorUuid, snapshot.aimTargets, snapshot.source
  );
  if (!targets.ok) return refuse(targets.code, targets.data);
  const params = validateActivationParams(snapshot.source.conditionItem, intent.params);
  if (!params.ok) return refuse(params.code);
  const authored = validateActivationRequirements({
    requirements: activationRequirements(snapshot.source.conditionItem),
    itemType: snapshot.source.conditionItem?.type,
    requiredProficiency: activationRequiredProficiency(snapshot.source.conditionItem),
    source: snapshot.source,
    targets: snapshot.targets,
    targetLocation: intent.aim ?? null,
    resolveTerrainGeometry
  });
  if (!authored.ok) return refuse(authored.code, authored.data);
  const reach = validateActivationReach({
    envelope,
    source: snapshot.source,
    footprint: snapshot.source.footprint,
    columns: snapshot.columns,
    rows: snapshot.rows,
    sight: snapshot.sight,
    aim: intent.aim,
    targets: snapshot.aimTargets
  });
  if (!reach.ok) return refuse(reach.code);
  const forced = validateForcedMovementSquare({
    envelope,
    source: snapshot.source,
    target: snapshot.aimTargets[0] ?? null,
    boards: snapshot.forcedMovementBoards,
    classicFlyers: snapshot.classicFlyers,
    flightForbidden: snapshot.flightForbidden
  });
  if (!forced.ok) return refuse(forced.code, { ability: forced.ability });
  for (const bond of snapshot.guardBonds) {
    const guard = resolveGuardBond(bond);
    if (!guard.ok) return refuse(guard.code, { actorName: guard.actorName });
  }
  const placement = validateGroundPlacement(
    envelope, intent.aim, snapshot.units, snapshot.source.tokenUuid
  );
  return placement.ok ? null : refuse(placement.code);
}

/* -------------------------------------------- */
/*  Delivery                                    */
/* -------------------------------------------- */

/**
 * Apply the use to each target in turn, or once when it has no target. `reach` collects the units the effects
 * defeated (`claims`) and what each unit took or gained (`impacts`), which the XP award reads. For a kept
 * retractable use it also carries the run's `rolls` and what the item `remembered` from a use taken back.
 */
async function deliverActivation(services, snapshot, intent, context, shared, reach) {
  const deliveries = [];
  if (snapshot.targets.length === 0) {
    deliveries.push(await deliverToTarget(services, snapshot, intent, context, null, shared, reach));
    return deliveries;
  }
  for (const target of snapshot.targets) {
    deliveries.push(await deliverToTarget(services, snapshot, intent, context, target, shared, reach));
  }
  return deliveries;
}

async function deliverToTarget(services, snapshot, intent, context, target, shared,
  { claims, impacts, rolls = null, remembered = null }) {
  const envelope = snapshot.envelope;
  if (envelope.rally) return deliverRally(services, snapshot, target, impacts);
  if (envelope.booster) return deliverBooster(services, snapshot, context);
  const delivery = resolveActivationDelivery({
    envelope,
    sourceFaction: snapshot.source.actorType,
    targetFaction: target?.actorType,
    targetDestructible: target?.objectTarget === true,
    hasTarget: Boolean(target)
  });
  const savingThrow = delivery.kind === 'save'
    ? await rollActivationSave(services, snapshot, context, target, delivery)
    : null;
  const skillCheck = delivery.kind === 'check'
    ? await resolveActivationCheck(services, snapshot, context, target, delivery, shared, remembered)
    : null;
  const landed = resolveActivationLanded({ kind: delivery.kind, savingThrow, skillCheck });

  const result = await services.effects.run(activationEffectRequest({
    snapshot,
    intent,
    target,
    savingThrow,
    skillCheck,
    audience: requesterAudience(context),
    rolls
  }));
  if (result.outcomes.some(outcome => outcome?.ok === false)) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
  claims.push(...collectEffectDefeats(result.outcomes, activationFactionOf(snapshot)));
  impacts.push(...collectImpacts(result.outcomes));
  await presentEffectDamage(services, snapshot, result.outcomes, context);
  return Object.freeze({
    targetActorUuid: target?.actorUuid ?? '',
    targetTokenUuid: target?.tokenUuid ?? '',
    delivery: delivery.kind,
    savingThrow,
    skillCheck,
    landed
  });
}

/**
 * Rally one ally: the caster's affinity and the ally's Rally rank set the bonus (planRallyEffect). Rally runs no
 * effect steps, so a newly rallied ally is counted here as a helpful status for XP.
 */
async function deliverRally(services, snapshot, target, impacts) {
  const landed = target ? await settleRally(services, snapshot, target) : false;
  if (landed) impacts.push(unitImpact(target.actorUuid, { helpful: { status: true } }));
  return Object.freeze({
    targetActorUuid: target?.actorUuid ?? '',
    targetTokenUuid: target?.tokenUuid ?? '',
    delivery: 'rally',
    savingThrow: null,
    skillCheck: null,
    landed
  });
}

/**
 * Write one Rally. settleActivationCosts adds it to the caster's count of Rallies on this map, which limits how often
 * each unit can be rallied (rallyTargetBlocker), in the same write as the use's action spend.
 */
async function settleRally(services, snapshot, target) {
  const caster = rallyCasterFacts(snapshot.source);
  const identity = {
    uuid: target.actorUuid, actorId: target.baseActorId, partyId: target.partyId, rallied: target.rallied === true
  };
  if (!canRallyTarget(caster, identity)) return false;
  const rank = rallyRankFor(caster, identity);
  const intent = planRallyEffect({ table: snapshot.affinities, caster, target: { actorUuid: target.actorUuid }, rank });
  if (!intent) return false;
  if (await services.settlement.applyRally(target.actorUuid, intent, snapshot) !== true) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
  return true;
}

/**
 * Give RALLY_SUPPORT_XP to the support bond between the caster and each ally rallied for the first time on this
 * map, creating the bond if they had none. The SUPPORT.GRANT_XP command runs inside this one, so its writes are
 * undone with the use. A thrown error is logged and a refused grant is ignored; either way the Rally stands. Each
 * support rank reached is shown to the player who used the item.
 */
async function settleRallySupport(services, snapshot, deliveries, context) {
  if (!snapshot.envelope.rally) return;
  const partnerActorUuids = [...new Set(deliveries
    .filter(delivery => delivery.delivery === 'rally' && delivery.landed === true
      && ralliesOn(snapshot.source.support.rallies, delivery.targetActorUuid) === 0)
    .map(delivery => delivery.targetActorUuid))];
  if (!partnerActorUuids.length) return;
  try {
    const result = await services.support.grant({
      sourceActorUuid: snapshot.source.actorUuid, partnerActorUuids, amount: RALLY_SUPPORT_XP, autoCreate: true
    }, context);
    for (const rankUp of result?.ok === true ? result.data?.rankUps ?? [] : []) {
      await presentNotice(services, itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.NOTICE, {
        notice: 'support',
        actorUuid: snapshot.source.actorUuid,
        message: `${rankUp.a} & ${rankUp.b}: Support ${rankUp.from} → ${rankUp.to}!`
      }), requesterAudience(context));
    }
  } catch (error) {
    recordAbsorbed(services, error, 'settleRallySupport');
  }
}

/**
 * Write a Booster's permanent stat gains (planBoosterGains) and send the user a notice of what rose. When caps
 * block every increase, nothing is written and the notice says so.
 */
async function deliverBooster(services, snapshot, context) {
  const source = snapshot.source;
  const plan = planBoosterGains({ item: source.conditionItem, source });
  if (plan.landed && await services.settlement.applyBooster(source.actorUuid, plan, snapshot) !== true) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
  await presentNotice(services, itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.NOTICE, {
    notice: 'booster', actorUuid: source.actorUuid, message: boosterGainLine(source.actorName, plan)
  }), requesterAudience(context));
  return Object.freeze({
    targetActorUuid: source.actorUuid,
    targetTokenUuid: source.tokenUuid,
    delivery: 'booster',
    savingThrow: null,
    skillCheck: null,
    landed: plan.landed
  });
}

/**
 * Roll one target's saving throw against the caster's DC and show its roll card. A Destructible fails and an exempt
 * friendly target passes automatically (resolveActivationDelivery), with no roll, Willpower spend or card.
 */
async function rollActivationSave(services, snapshot, context, target, delivery) {
  if (!target) return null;
  if (delivery.autoFail) return Object.freeze({ success: false, total: 0, autoFailed: true });
  if (delivery.autoSucceed) return Object.freeze({ success: true, total: 999, autoSucceeded: true });
  const envelope = snapshot.envelope;
  const dc = calculateSavingThrowDifficulty(snapshot.source.attributes, {
    base: envelope.savingThrow.base,
    attribute: envelope.savingThrow.attribute
  });
  const advantage = resolveSaveAdvantage({
    magicSaveAdvantage: target.magicSaveAdvantage,
    magical: snapshot.item.magical,
    willpowerRemaining: target.willpowerRemaining
  });
  if (advantage.spendsWillpower && !await services.settlement.spendWillpower(target.actorUuid, snapshot)) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
  const check = buildSavingThrow({
    targetAttribute: envelope.savingThrow.targetAttribute,
    dc,
    attributes: target.attributes,
    saveModifiers: target.saveModifiers,
    actorType: target.actorType,
    blessed: target.blessed,
    hasAdvantage: advantage.hasAdvantage
  });
  const roll = await services.checks.roll(target.actorUuid, check,
    { requestId: context.requestId, operation: context.operation });
  await presentCheck(services, snapshot, target, check, roll, 'save', context);
  await services.wait(ITEM_ACTIVATION_TIMING.diceSettleHold);
  if (!await services.settlement
    .consumeSavingThrowEffects(target.actorUuid, envelope.savingThrow.targetAttribute, snapshot)) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
  return Object.freeze({ success: roll.success === true, total: roll.total, natural: roll.natural, dc });
}

/**
 * Roll the caster's skill check against one target, or reuse the shared roll. A retractable item used again after
 * being taken back reuses its remembered passed check, with no new roll or card.
 */
async function resolveActivationCheck(services, snapshot, context, target, delivery, shared, remembered = null) {
  if (delivery.autoSucceed) return Object.freeze({ success: true, total: 999, autoSucceeded: true });
  const envelope = snapshot.envelope;
  const dc = target
    ? calculateSkillCheckDifficulty(target.attributes, envelope.skillCheck.base, envelope.skillCheck.targetAttribute)
    : envelope.skillCheck.base;
  if (shared) {
    return Object.freeze({
      success: Number(shared.total) > dc,
      total: shared.total,
      natural: shared.natural,
      dc,
      shared: true
    });
  }
  const check = activationSkillCheck(snapshot, envelope, dc);
  if (!check) return null;
  if (remembered?.check?.success === true) {
    // Taking the use back also took back the skill experience it earned, so the reused check earns it again.
    await grantSkillExperience(services, snapshot.source.actorUuid, check.skillKey);
    return Object.freeze({ ...remembered.check });
  }
  const roll = await services.checks.roll(snapshot.source.actorUuid, check,
    { requestId: context.requestId, operation: context.operation });
  await presentCheck(services, snapshot, target, check, roll, 'skill', context);
  await services.wait(ITEM_ACTIVATION_TIMING.diceSettleHold);
  await grantSkillExperience(services, snapshot.source.actorUuid, check.skillKey);
  return Object.freeze({ success: roll.success === true, total: roll.total, natural: roll.natural, dc });
}

async function rollSharedSkillCheck(services, snapshot, context) {
  const envelope = snapshot.envelope;
  if (!envelope.skillCheck?.required || snapshot.targets.length < 2) return null;
  const everyTargetExempt = envelope.skillCheck.ignoreForFriendly
    && snapshot.targets.every(target => areFactionsFriendly(snapshot.source.actorType, target.actorType));
  if (everyTargetExempt) return null;
  const check = activationSkillCheck(snapshot, envelope, null);
  if (!check) return null;
  const roll = await services.checks.roll(snapshot.source.actorUuid, check,
    { requestId: context.requestId, operation: context.operation });
  await presentCheck(services, snapshot, null, check, roll, 'skill', context);
  await services.wait(ITEM_ACTIVATION_TIMING.diceSettleHold);
  await grantSkillExperience(services, snapshot.source.actorUuid, check.skillKey);
  return { total: roll.total, natural: roll.natural };
}

function activationSkillCheck(snapshot, envelope, dc) {
  const skillKey = String(envelope.skillCheck.skill ?? '').toLowerCase();
  const skill = SKILL_BY_KEY[skillKey];
  if (!skill) return null;
  return buildSkillCheck({
    skillKey,
    mode: 'standard',
    dc,
    rank: snapshot.source.skills?.[skillKey],
    statValue: snapshot.source.attributes?.[skill.stat],
    actorType: snapshot.source.actorType,
    blessed: snapshot.source.blessed
  });
}

/* -------------------------------------------- */
/*  Effect requests                             */
/* -------------------------------------------- */

function activationEffectRequest({ snapshot, intent, target, savingThrow, skillCheck, audience, rolls = null }) {
  const selfActor = snapshot.source.conditionSelf;
  const targetActor = target?.conditionSelf ?? null;
  return {
    entries: snapshot.entries,
    triggers: activationTriggers(),
    runtime: activationRuntime(snapshot, intent, target),
    context: effectContext(selfActor, targetActor, snapshot.source.conditionItem, {
      selectedParams: intent.params,
      targetLocation: intent.aim,
      savingThrowResult: savingThrow,
      skillCheckResult: skillCheck,
      savingThrowRequired: Boolean(snapshot.envelope.savingThrow?.required),
      skillCheckRequired: Boolean(snapshot.envelope.skillCheck?.required)
    }),
    activatedItem: snapshot.source.conditionItem,
    audience,
    rolls
  };
}

function activationRuntime(snapshot, intent, target) {
  return effectRuntime({
    sceneUuid: snapshot.sceneUuid,
    operation: snapshot.operation,
    self: snapshot.source,
    target,
    targetLocation: intent.aim,
    effectTiles: snapshot.effectCells,
    prePickedPlacement: intent.placement,
    effectRange: snapshot.envelope.range.maxRange,
    healEchoes: snapshot.healEchoes,
    activatedItemUuid: snapshot.envelope.itemUuid
  });
}

async function runUseItemPassives(services, snapshot, intent, context, claims, rolls = null) {
  if (!snapshot.passiveEntries.length) return;
  const result = await services.effects.run({
    entries: snapshot.passiveEntries,
    triggers: ['onUseItem'],
    runtime: activationRuntime(snapshot, intent, null),
    context: effectContext(snapshot.source.conditionSelf, null, snapshot.source.conditionItem),
    activatedItem: snapshot.source.conditionItem,
    audience: requesterAudience(context),
    rolls
  });
  if (result.outcomes.some(outcome => outcome?.ok === false)) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
  claims.push(...collectEffectDefeats(result.outcomes, activationFactionOf(snapshot)));
}

/** The faction of a unit the activation reached, for the defeat event that outlives its Token. */
function activationFactionOf(snapshot) {
  return actorUuid => {
    if (actorUuid === snapshot.source.actorUuid) return snapshot.source.actorType ?? '';
    return snapshot.targets.find(target => target.actorUuid === actorUuid)?.actorType ?? '';
  };
}

/**
 * After the use, remove the units its effects defeated, the same way an attack does. A unit defeated twice is
 * handled once. An error here is logged and the use still stands. The removals are undone with the use if a later
 * step fails.
 */
async function settleActivationDefeats(services, claims, context) {
  if (!claims.length) return;
  const latest = new Map(claims.map(claim => [claim.actorUuid, claim]));
  try {
    await settleEffectDefeats({
      defeats: services.defeats,
      objects: services.objects,
      presentation: services.presentation,
      events: services.events,
      wait: services.wait,
      diagnostics: services.diagnostics
    }, [...latest.values()], {
      requestId: context.requestId, userId: context.userId, operation: context.operation ?? null
    });
  } catch (error) {
    recordAbsorbed(services, error, 'settleActivationDefeats');
  }
}

/* -------------------------------------------- */
/*  Settlement                                  */
/* -------------------------------------------- */

async function settleSanctuary(settlement, snapshot) {
  if (!snapshot.source.sanctuary || !snapshot.source.sanctuaryEffectId) return;
  if (snapshot.envelope.targetType === 'Friendly') return;
  if (!await settlement.removeSanctuary(snapshot.source.actorUuid, snapshot.source.sanctuaryEffectId, snapshot)) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
}

/**
 * Mount or dismount when the used item is a Mount, through the TOGGLE_EQUIPMENT command. No parent is passed:
 * `dispatcher.invokeWithin` runs it inside whatever command is running, which is this use, so its writes are undone
 * with the use.
 */
async function settleMountToggle(services, snapshot) {
  if (!isMountActivation(snapshot.item)) return;
  const toggled = await services.inventory.toggleEquipment({
    actorUuid: snapshot.source.actorUuid,
    itemId: snapshot.item.id
  });
  if (toggled?.ok !== true) throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
}

/**
 * Spend the use's charge and action, and count each ally it Rallied in the caster's record of this map's Rallies, in
 * the order they were Rallied so several targets each add their own. A `kept` retractable use spends only its
 * action; its charge is spent when the use becomes final.
 */
async function settleActivationCosts(services, snapshot, deliveries, context, { kept = false } = {}) {
  const landed = deliveries.some(delivery => delivery.landed === true);
  const consumption = kept
    ? { consume: false, remaining: snapshot.envelope.usesCurrent, destroy: false }
    : resolveActivationConsumption({ envelope: snapshot.envelope, landed });
  return services.settlement.settleActivation(snapshot, {
    consumption,
    actionSpend: resolveActivationActionSpend(snapshot.envelope.actionType),
    ralliedActorUuids: deliveries
      .filter(delivery => delivery.delivery === 'rally' && delivery.landed === true)
      .map(delivery => delivery.targetActorUuid),
    requestId: context.requestId
  });
}

/**
 * Read where the unit's movement plan has it standing, before any effect step can move it.
 * settleActivationContinuation measures the movement already spent from here. No plan means the use is out of date.
 */
async function resolveWalkedLeg(services, snapshot) {
  const state = await services.continuations.getSnapshot(snapshot.source.tokenUuid);
  const walked = state ? resolveStandingDestination(state.movement) : null;
  if (!walked) throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_STALE);
  return walked;
}

/**
 * Decide what the caster does next (end its turn, keep moving, and so on) and save it. After a Spell or a Staff, a
 * unit with Canter may spend its leftover movement, as it may after an attack.
 */
async function settleActivationContinuation(services, snapshot, context, walked) {
  const state = await services.continuations.getSnapshot(snapshot.source.tokenUuid);
  if (!state) throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_STALE);
  const resolution = resolveSettledStanding(walked, state.movement);
  if (!resolution) throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_STALE);
  const cantersAfter = activationAllowsCanter(snapshot.item);
  const continuation = resolveActivationContinuation({
    actionType: snapshot.envelope.actionType,
    sourceDefeated: state.sourceDefeated,
    explorationActive: state.explorationActive,
    extraActionsRemaining: state.extraActionsRemaining,
    extraActionUsed: state.extraActionUsed,
    cantersAfter,
    hasCanter: state.hasCanter,
    movementRemaining: Math.max(0, (Number(state.movement?.allowance) || 0) - resolution.cost)
  });
  if (!await services.settlement.settleContinuation(state, resolution, continuation, context.requestId,
    snapshot.operation, { cantersAfter })) {
    throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  }
  return continuation;
}

async function settleDeferredEndTurn(services, outcome, operation = null) {
  if (outcome.continuation?.kind !== COMBAT_CONTINUATIONS.END_TURN) return false;
  const state = await services.continuations.getSnapshot(outcome.sourceTokenUuid);
  if (!state
    || state.sourceDefeated === true
    || state.continuationPending !== COMBAT_CONTINUATIONS.END_TURN
    || state.continuationRequestId !== outcome.requestId) return false;
  return await services.settlement.settlePendingContinuation(state, outcome.continuation, operation) === true;
}

/**
 * Award level XP from the item's entry in the activation XP table, based on what the use actually did to each unit:
 * a target that resisted or saved scores nothing. The award and the caster's use counter are undone if the use
 * fails. Steal earns its XP only through the steal command (engine/economy/trade.mjs), not when used as an item.
 */
async function settleActivationExperience(services, snapshot, impacts) {
  if (isMountActivation(snapshot.item) || isStealAbility(snapshot.item)) return null;
  if (!earnsCharacterExperience(snapshot.source.actorType)) return null;
  const table = snapshot.experience;
  if (!table?.entry) return null;
  return settleTableExperience({
    progression: services.progression,
    recordUse: use => services.settlement.recordExperienceUse(snapshot, use)
  }, {
    table,
    source: snapshot.source,
    targets: await activationExperienceTargets(services, snapshot, impacts),
    operation: snapshot.operation,
    failureCode: RESULT_CODES.ITEM_ACTIVATION_FAILED
  });
}

/**
 * Grade one use against its activation XP entry, count it toward the per-encounter limit when it should count, and
 * award the XP through the same progression service attacks use (unit and world multipliers, the cap, level-ups).
 * Item use and Steal both come here, so they share one counter and one set of rules. `table` holds the entry, the
 * running encounter and the caster's uses of it so far.
 * @param {{progression: object, recordUse: function(object): Promise<boolean>}} ports
 * @param {{table: object, source: object, targets: object[], operation: *, failureCode: string}} use
 * @returns {Promise<object|null>} The progression service's result, which can report `ok: false`, or null when the
 *   use earned nothing.
 */
export async function settleTableExperience({ progression, recordUse }, { table, source, targets, operation,
  failureCode }) {
  const verdict = resolveActivationExperience({
    entry: table.entry,
    casterLevel: source.level,
    targets,
    encounterRunning: table.encounterRunning,
    usesThisEncounter: table.usesThisEncounter
  });
  if (verdict.countsTowardLimit && await recordUse({ encounterId: table.encounterId, key: table.key }) !== true) {
    throw new CombatPersistenceError(failureCode);
  }
  if (verdict.experience <= 0) return null;
  return progression.settleCombatExperience({
    operation,
    awards: [
      { actorUuid: source.actorUuid, experience: verdict.experience, side: 'source' }
    ]
  });
}

/**
 * One record per unit the use reached, for the XP rules: every aimed target and every unit an effect touched, with
 * what it took or gained summed across steps. The caster counts as friendly to itself for what it heals or gains,
 * but moving the caster never counts: a Swap or a Retrieve is graded on the other unit alone. Objects and Neutrals
 * are on neither side. A unit that was not read at the start of the use, such as an ally caught in an area around
 * the caster, is read through getReachedUnits.
 */
async function activationExperienceTargets(services, snapshot, impacts) {
  const units = new Map([snapshot.source, ...snapshot.targets].map(unit => [unit.actorUuid, unit]));
  const reached = [...new Set([...snapshot.targets, ...impacts].map(entry => entry.actorUuid))];
  const unknown = reached.filter(actorUuid => !units.has(actorUuid));
  if (unknown.length) {
    for (const unit of await services.activations.getReachedUnits(unknown)) units.set(unit.actorUuid, unit);
  }
  return reached.filter(actorUuid => units.has(actorUuid)).map(actorUuid => experienceTarget(
    snapshot.source, units.get(actorUuid), impacts.filter(impact => impact.actorUuid === actorUuid)
  ));
}

/**
 * One unit's record for the XP rules, from what the use did to it; see activationExperienceTargets. Steal grades
 * its target here too.
 * @param {{actorUuid: string, actorType: string}} source The caster.
 * @param {object} unit The unit's side, level and pools, with `objectTarget` or `scenery` set for an Object.
 * @param {object[]} impacts What each effect step did to it (unitImpact in effects/execution.mjs).
 * @returns {object}
 */
export function experienceTarget(source, unit, impacts) {
  const character = unit.objectTarget !== true && unit.scenery !== true;
  const self = unit.actorUuid === source.actorUuid;
  return {
    friendly: character && (self || areFactionsFriendly(source.actorType, unit.actorType)),
    hostile: character && !self && areFactionsOpposed(source.actorType, unit.actorType),
    level: unit.level,
    isBoss: unit.actorType === 'Boss',
    hpMax: unit.hpMax,
    stnMax: unit.stnMax,
    harmful: summedImpact(impacts, 'harmful'),
    helpful: summedImpact(impacts, 'helpful'),
    moved: !self && impacts.some(impact => impact.moved === true),
    slain: impacts.some(impact => impact.slain === true)
  };
}

function summedImpact(impacts, half) {
  return {
    hp: impacts.reduce((total, impact) => total + impact[half].hp, 0),
    stn: impacts.reduce((total, impact) => total + impact[half].stn, 0),
    status: impacts.some(impact => impact[half].status === true)
  };
}

/** Every unit impact an effect run reported, nested health outcomes included (unitImpact in effects/execution.mjs). */
function collectImpacts(outcomes, impacts = []) {
  for (const outcome of outcomes) {
    if (Array.isArray(outcome?.outcomes)) collectImpacts(outcome.outcomes, impacts);
    if (Array.isArray(outcome?.impacts)) impacts.push(...outcome.impacts);
  }
  return impacts;
}

/**
 * Award weapon proficiency XP for the use, counted as a landed strike scaled by ITEM_USE_PROFICIENCY_HIT_RATIO, and
 * show the rank-up card on a rank-up. FoundryItemActivationSettlement.commitProgression writes it.
 */
async function settleItemProficiency(services, snapshot, context) {
  const proficiency = snapshot.source.proficiency;
  if (!proficiency?.key || isMountActivation(snapshot.item) || !earnsCharacterExperience(snapshot.source.actorType)) {
    return false;
  }
  const award = resolveWeaponExperience({
    proficiency,
    hit: true,
    multiplier: Math.max(1, Number(proficiency.multiplier) || 1) * ITEM_USE_PROFICIENCY_HIT_RATIO
  });
  if (!award) return false;
  const base = award.base ?? Math.max(0, Math.floor(Number(proficiency.base) || 0));
  const written = await services.settlement.commitProgression({
    [snapshot.source.actorUuid]: {
      [`system.prof.${award.key}.base`]: base,
      [`system.prof.${award.key}.xp`]: award.xp
    }
  }, snapshot);
  if (written !== true) throw new CombatPersistenceError(RESULT_CODES.ITEM_ACTIVATION_FAILED);
  if (award.rankedUp) await presentSafely(services, rankUpMessage(snapshot, award, cardRequester(context)));
  return true;
}

async function publishActivationExperience(services, settled, context) {
  const progression = services.progression;
  if (!settled?.settlements.length) return;
  await progression.publishCombatExperience({ settlements: settled.settlements, context });
}

/* -------------------------------------------- */
/*  Presentation and outcomes                   */
/* -------------------------------------------- */

function leadInMessage(snapshot, intent, cinematic) {
  return itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.LEAD_IN, {
    sourceTokenUuid: snapshot.source.tokenUuid,
    sourceActorUuid: snapshot.source.actorUuid,
    targetTokenUuids: snapshot.targets.map(target => target.tokenUuid),
    targetLocation: intent.aim,
    cinematic
  });
}

function rankUpMessage(snapshot, award, requester = null) {
  return itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.RANK_UP, {
    actorUuid: snapshot.source.actorUuid,
    actorName: snapshot.source.actorName,
    actorImage: snapshot.source.actorImage,
    avatarScale: snapshot.source.avatarScale,
    proficiencyKey: award.key,
    rankLetter: award.rankLetter,
    rank: award.rank,
    ...(requester ? { requester } : {})
  });
}

function endMessage(snapshot, cinematic) {
  return itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.END, {
    sourceTokenUuid: snapshot.source.tokenUuid,
    sourceActorUuid: snapshot.source.actorUuid,
    cinematic
  });
}

function castMessage(snapshot, intent) {
  return itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.CAST, {
    sourceTokenUuid: snapshot.source.tokenUuid,
    sourceActorUuid: snapshot.source.actorUuid,
    targetTokenUuids: snapshot.targets.map(target => target.tokenUuid),
    targetLocation: intent.aim,
    item: Object.freeze({
      uuid: snapshot.item.uuid,
      name: snapshot.item.name,
      img: snapshot.item.img,
      type: snapshot.item.type,
      subtype: snapshot.item.subtype
    }),
    castCondition: activationCastCondition(snapshot.item),
    castHeld: activationHoldsCastArt({ item: snapshot.item, entries: snapshot.entries }),
    activationAnimation: snapshot.item.activationAnimation,
    attackAnimation: snapshot.item.attackAnimation,
    distance: snapshot.distance
  });
}

/** Send one notice to the named users. A presentation failure is recorded and never reaches the mechanics. */
async function presentNotice(services, message, audience) {
  if (!audience.length) return false;
  try {
    return await services.presentation.broadcast(message, { audience: [...audience] }) !== false;
  } catch (error) {
    recordAbsorbed(services, error, String(message?.beat ?? message?.kind ?? ''));
    return false;
  }
}

async function presentEffectDamage(services, snapshot, outcomes, context) {
  const rows = collectDamageRows(outcomes);
  if (!rows.length) return;
  const requester = cardRequester(context);
  await presentSafely(services, itemActivationPresentationMessage(
    ITEM_ACTIVATION_PRESENTATION_BEATS.DAMAGE_CARD,
    {
      sourceActorUuid: snapshot.source.actorUuid,
      item: Object.freeze({ name: snapshot.item.name, img: snapshot.item.img }),
      rows: Object.freeze(rows),
      ...(requester ? { requester } : {})
    }
  ));
}

function collectDamageRows(outcomes, rows = []) {
  for (const outcome of outcomes) {
    if (Array.isArray(outcome?.outcomes)) collectDamageRows(outcome.outcomes, rows);
    if (outcome?.health?.change !== 'damage') continue;
    rows.push(Object.freeze({
      tokenUuid: String(outcome.tokenUuid ?? ''),
      formula: String(outcome.formula ?? ''),
      rolled: outcome.rolled === true,
      total: Number(outcome.amount) || 0,
      dealt: Math.max(0, Number(outcome.hpDealt) || 0),
      stanceDealt: Math.max(0, Number(outcome.stanceDealt) || 0),
      damageType: String(outcome.damageType ?? 'none'),
      critical: outcome.critical === true
    }));
  }
  return rows;
}

async function presentCheck(services, snapshot, target, check, roll, kind, context) {
  const presenter = services.checkPresentation;
  const roller = kind === 'save' ? target : snapshot.source;
  const card = {
    requester: context.requester ?? { userId: context.userId, messageMode: context.messageMode },
    actorUuid: roller.actorUuid ?? '',
    actorName: roller.actorName ?? '',
    actorImage: roller.actorImage ?? '',
    avatarScale: roller.avatarScale ?? 1.25,
    dc: check.dc,
    natural: roll.natural,
    total: roll.total,
    success: roll.success,
    effectName: snapshot.item.name,
    check,
    roll
  };
  try {
    if (kind === 'save') await presenter.presentSave({ ...card, sourceImg: snapshot.item.img });
    else await presenter.presentSkill({ ...card, skillKey: check.skillKey, targetName: target?.actorName ?? '' });
  } catch (diagnosticError) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'presentCheck' });
    if ((card.requester.messageMode ?? 'public') === 'public') {
      await presentSafely(services, itemActivationPresentationMessage(
        ITEM_ACTIVATION_PRESENTATION_BEATS.NOTICE,
        { notice: kind, actorUuid: card.actorUuid, total: card.total, success: card.success }
      ));
    }
  }
}

/** Reaching down from the air to touch something on the ground puts the caster on the ground with it. */
async function settleAdjacentGrounding(services, snapshot) {
  if (!touchGrounds(snapshot)) return;
  await services.movements.setActorGrounded(snapshot.source.actorUuid, true, snapshot.operation ?? null);
}

/** Whether a use is a touch from the air on a unit on the ground: one target, Single range type, range 1. */
function touchGrounds(snapshot) {
  const envelope = snapshot.envelope;
  const target = snapshot.targets.length === 1 ? snapshot.targets[0] : null;
  if (!target || envelope.rngType !== 'Single' || Number(envelope.range?.maxRange) !== 1) return false;
  return groundsOnInteraction({ sourceAirborne: snapshot.source.airborne, targetAirborne: target.airborne });
}

function activationOutcome(snapshot, deliveries, continuation, context) {
  return {
    sourceActorUuid: snapshot.source.actorUuid,
    sourceTokenUuid: snapshot.source.tokenUuid,
    sceneUuid: snapshot.sceneUuid,
    itemUuid: snapshot.envelope.itemUuid,
    itemName: snapshot.item.name,
    actionType: snapshot.envelope.actionType,
    landed: deliveries.some(delivery => delivery.landed === true),
    deliveries: Object.freeze(deliveries),
    continuation: Object.freeze({ ...continuation, exchangeRequestId: context.requestId }),
    requestId: context.requestId,
    userId: context.userId
  };
}
