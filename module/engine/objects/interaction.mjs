/** @layer engine/objects */
import { COMMAND_IDS } from '../../contracts/commands.mjs';
import { KARMA_LEDGER_RESOURCE_KEY } from '../../contracts/domains/combat.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import {
  DIAGNOSTIC_SEVERITIES, DIAGNOSTIC_SOURCES, recordDiagnostic, requirePorts
} from '../../contracts/protocol.mjs';
import {
  DROP_ACTIONS,
  DROP_SETTLEMENT_OUTCOMES,
  LOCK_METHODS,
  LOCKTOUCH_SKILL_KEY,
  normalizeArmamentReleaseIntent,
  normalizeArmamentWieldIntent,
  normalizeItemDropIntent,
  normalizeLockOpenIntent,
  OBJECT_PRESENTATION_EVENTS,
  objectPresentationMessage,
  LOCK_ATTEMPT_TIMING
} from '../../contracts/domains/objects.mjs';
import { PROFICIENCY_RANK_LETTERS } from '../../contracts/domains/items.mjs';
import { SKILL_BY_KEY } from '../../game/character/rules.mjs';
import { planForcedLanding } from '../../game/movement/input-policy.mjs';
import { resolveStandingDestination, standsOverObstacle } from '../../game/movement/pathfinding.mjs';
import { planArmamentWield, planItemDrop, planLockOpening, successChanceBand } from '../../game/objects/rules.mjs';
import { buildSkillCheck, checkSuccessChance } from '../../game/rolls/checks.mjs';
import { CombatPersistenceError } from '../recovery/errors.mjs';
import { grantSkillExperience } from '../character/skill-experience.mjs';
import { presentSafely } from '../feedback.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { holdsResources } from '../dispatcher.mjs';
import { accept, refuse, RESULT_CODES } from '../../contracts/results.mjs';

/* -------------------------------------------- */
/*  Lock opening                                */
/* -------------------------------------------- */

/**
 * The lock-opening command: open a lock with its key or pick it with Locktouch, then spend what the attempt costs.
 * createObjectCommandContribution registers it.
 */
async function openLock(context, services) {
  const intent = normalizeLockOpenIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.OBJECT_LOCK_INPUT_INVALID);
  const snapshot = await services.objects.getLockSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.OBJECT_LOCK_UNAVAILABLE);
  const plan = planLockOpening(lockFacts(snapshot, intent.method));
  if (!plan.ok) return refuse(plan.code, lockRefusalData(snapshot));
  const landing = planForcedLanding({
    grounds: snapshot.claimsAction === true && snapshot.sourceAirborne === true,
    landingBlocked: standsOverObstacle(snapshot.source.movement)
  });
  if (!landing.ok) return refuse(landing.code);
  if (!lockAttemptPlanned(snapshot, context.userId)) return refuse(RESULT_CODES.MOVEMENT_PLAN_REQUIRED);
  if (!holdsResources(context, await services.objects.resourceKeys(intent))) {
    return refuse(RESULT_CODES.OBJECT_LOCK_STALE, { reasonCode: 'objects.lock-resources-busy' });
  }

  const operation = context.operation ?? null;
  await services.objects.captureLockWrites(snapshot, plan, operation);
  let outcome;
  try {
    outcome = await settleLock(services, Object.freeze({ ...snapshot, operation }), plan, context);
  } catch (error) {
    const diagnostic = recordDiagnostic(services?.diagnostics, {
      sourcePath: 'foundry/adapters/document-writes/objects.mjs', error: error, detail: 'openLock'
    });
    return refuse(RESULT_CODES.OBJECT_LOCK_STALE, {
      reasonCode: error instanceof CombatPersistenceError ? error.code : 'objects.lock-failed', diagnostic
    });
  }
  if (outcome.turnEnded && snapshot.sourceAirborne === true) {
    await services.movements.setActorGrounded(snapshot.source.actorUuid, true, operation);
  }
  services.events.publish(EVENT_IDS.OBJECT_LOCK_ATTEMPTED, outcome);
  return accept(outcome.opened ? RESULT_CODES.OBJECT_LOCK_OPENED : RESULT_CODES.OBJECT_LOCK_HELD, outcome);
}

/**
 * Roll the Locktouch check when the plan needs one and wait for its card, then unlock through
 * FoundryObjectRepository and use up the key if the plan says so. The turn is spent inside the same operation,
 * which openLock captured through before the first write.
 */
async function settleLock(services, snapshot, plan, context) {
  let opened = true;
  let roll = null;
  let check = null;
  if (plan.rollsCheck) {
    check = lockpickCheck(snapshot);
    roll = await services.checks.roll(snapshot.source.actorUuid, check,
      { requestId: context.requestId, operation: context.operation ?? null });
    await presentLockpick(services, snapshot, check, roll, context);
    await services.wait(LOCK_ATTEMPT_TIMING.diceSettleHold);
    await grantSkillExperience(services, snapshot.source.actorUuid, LOCKTOUCH_SKILL_KEY, undefined, context);
    opened = roll.success === true;
  }
  if (opened && !await services.objects.unlock(snapshot, { hold: keys => holdsResources(context, keys) })) {
    throw new CombatPersistenceError('objects.unlock-failed');
  }
  if (plan.consumesKey && !await services.objects.consumeKey(snapshot)) {
    throw new CombatPersistenceError('objects.key-consumption-failed');
  }
  if (!opened) {
    await presentSafely(services, objectPresentationMessage(OBJECT_PRESENTATION_EVENTS.LOCKPICK_FAILED, {
      tokenUuid: snapshot.lock.tokenUuid
    }));
    await services.wait(LOCK_ATTEMPT_TIMING.failureHold);
  }
  await settleTurn(services, snapshot);
  return Object.freeze({
    opened,
    method: plan.method,
    objectType: snapshot.lock.objectType,
    lockActorUuid: snapshot.lock.actorUuid,
    lockTokenUuid: snapshot.lock.tokenUuid,
    lockName: snapshot.lock.name,
    sourceActorUuid: snapshot.source.actorUuid,
    sourceTokenUuid: snapshot.source.tokenUuid,
    keyName: plan.consumesKey ? snapshot.lock.keyName : '',
    dc: check?.dc ?? null,
    total: roll?.total ?? null,
    turnEnded: snapshot.claimsAction === true,
    requestId: context.requestId,
    userId: context.userId
  });
}

/** Spend the turn an attempt costs in an encounter, or only fix the square a free interaction stood on. */
async function settleTurn(services, snapshot) {
  const movement = snapshot.source.movement;
  if (!movement) return;
  if (!snapshot.claimsAction && !snapshot.commitsSquare) return;
  const resolution = resolveStandingDestination(movement);
  if (!resolution) throw new CombatPersistenceError('objects.turn-settlement-failed');
  const settled = snapshot.claimsAction
    ? await services.objects.spendTurn(snapshot, resolution)
    : await services.objects.commitSquare(snapshot, resolution);
  if (settled !== true) throw new CombatPersistenceError('objects.turn-settlement-failed');
}

async function presentLockpick(services, snapshot, check, roll, context) {
  const presenter = services.checkPresentation;
  try {
    await presenter.presentSkill({
      requester: context.requester ?? { userId: context.userId, messageMode: context.messageMode },
      actorUuid: snapshot.source.actorUuid,
      actorName: snapshot.source.actorName,
      actorImage: snapshot.source.actorImage,
      avatarScale: snapshot.source.avatarScale,
      dc: check.dc,
      natural: roll.natural,
      total: roll.total,
      success: roll.success,
      effectName: 'Locktouch',
      targetName: snapshot.lock.name,
      check,
      roll
    });
  } catch (error) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: error, detail: 'presentLockpick' });
    await presentSafely(services, objectPresentationMessage(OBJECT_PRESENTATION_EVENTS.LOCKPICK_FAILED, {
      tokenUuid: snapshot.lock.tokenUuid,
      detail: String(error?.message ?? '')
    }));
  }
}

/* -------------------------------------------- */
/*  Armament take-up and release                */
/* -------------------------------------------- */

/**
 * Take up an Armament. FoundryObjectRepository.wieldArmament records the Armament on the unit and unwields its own
 * weapon, remembering it so releaseArmament can wield it again.
 */
async function wieldArmament(context, services) {
  const intent = normalizeArmamentWieldIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.ARMAMENT_INPUT_INVALID);
  const snapshot = await services.objects.getArmamentSnapshot(intent);
  if (!snapshot?.armament) return refuse(RESULT_CODES.ARMAMENT_UNAVAILABLE);
  const plan = planArmamentWield(armamentFacts(snapshot));
  if (!plan.ok) return refuse(plan.code, armamentRefusalData(snapshot));
  if (!await services.objects.wieldArmament(snapshot, context.operation ?? null)) {
    return refuse(RESULT_CODES.ARMAMENT_STALE);
  }
  const outcome = Object.freeze({
    sourceActorUuid: snapshot.source.actorUuid,
    sourceTokenUuid: snapshot.source.tokenUuid,
    armamentActorUuid: snapshot.armament.actorUuid,
    armamentTokenUuid: snapshot.armament.tokenUuid,
    armamentName: snapshot.armament.name,
    previousWieldedItemId: snapshot.source.armamentTokenUuid
      ? snapshot.source.previousWieldedItemId : snapshot.source.wieldedItemId,
    requestId: context.requestId,
    userId: context.userId
  });
  services.events.publish(EVENT_IDS.ARMAMENT_WIELDED, outcome);
  return accept(RESULT_CODES.ARMAMENT_WIELDED, outcome);
}

/** Let go of an Armament and, when asked, wield the remembered weapon again if the unit still carries it. */
async function releaseArmament(context, services) {
  const intent = normalizeArmamentReleaseIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.ARMAMENT_INPUT_INVALID);
  const snapshot = await services.objects.getArmamentSnapshot({
    sourceTokenUuid: intent.sourceTokenUuid,
    armamentTokenUuid: ''
  });
  if (!snapshot?.source.armamentTokenUuid) return refuse(RESULT_CODES.ARMAMENT_UNAVAILABLE);
  if (!await services.objects.releaseArmament(snapshot,
    { restore: intent.restore, operation: context.operation ?? null })) {
    return refuse(RESULT_CODES.ARMAMENT_STALE);
  }
  const outcome = Object.freeze({
    sourceActorUuid: snapshot.source.actorUuid,
    sourceTokenUuid: snapshot.source.tokenUuid,
    armamentTokenUuid: snapshot.source.armamentTokenUuid,
    restored: intent.restore && Boolean(snapshot.source.previousWieldedItemId),
    requestId: context.requestId,
    userId: context.userId
  });
  services.events.publish(EVENT_IDS.ARMAMENT_RELEASED, outcome);
  return accept(RESULT_CODES.ARMAMENT_RELEASED, outcome);
}

function armamentFacts(snapshot) {
  return {
    objectType: snapshot.armament.objectType,
    exploring: snapshot.exploring === true,
    inReach: snapshot.inReach === true,
    mounted: snapshot.source.mounted === true,
    requiredProficiency: snapshot.armament.requiredProficiency,
    requiredRank: snapshot.armament.requiredRank,
    proficiencies: snapshot.source.proficiencies,
    durability: snapshot.armament.durability
  };
}

function armamentRefusalData(snapshot) {
  const proficiency = String(snapshot.armament.requiredProficiency ?? '');
  return {
    actorName: snapshot.source.actorName,
    armamentName: snapshot.armament.name,
    proficiencyLabel: proficiency ? proficiency.charAt(0).toUpperCase() + proficiency.slice(1) : '',
    rankLabel: PROFICIENCY_RANK_LETTERS[Math.min(6, Math.max(1, Number(snapshot.armament.requiredRank) || 1)) - 1]
  };
}

/* -------------------------------------------- */
/*  Item drops                                  */
/* -------------------------------------------- */

/**
 * Drop an item on the ground as loot or discard it, through FoundryObjectRepository. A drop that plans a square
 * commit also closes the unit's plan on its square.
 */
async function dropItem(context, services) {
  const intent = normalizeItemDropIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DROP_INPUT_INVALID);
  const snapshot = await services.objects.getDropSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.DROP_UNAVAILABLE);
  const plan = planItemDrop({
    item: snapshot.item,
    action: intent.action,
    placed: snapshot.placed === true,
    exploring: snapshot.exploring === true,
    movementPlanning: snapshot.source.movement?.movementPlanning === true
  });
  if (!plan.ok) return refuse(plan.code, { actorName: snapshot.source.actorName, itemName: snapshot.item?.name });
  if (plan.action === DROP_ACTIONS.GROUND) {
    const outcome = await services.objects.dropItemAsLoot(snapshot, context);
    if (outcome?.ok !== true) return refuseDropSettlement(services, outcome);
  } else if (!await services.objects.discardItem(snapshot, context.operation ?? null)) {
    return refuse(RESULT_CODES.DROP_STALE);
  }
  if (plan.commitsSquare) await settleDropSquare(services, snapshot, context);
  const outcome = Object.freeze({
    action: plan.action,
    sourceActorUuid: snapshot.source.actorUuid,
    sourceTokenUuid: snapshot.source.tokenUuid,
    actorName: snapshot.source.actorName,
    itemId: snapshot.item.id,
    itemName: snapshot.item.name,
    requestId: context.requestId,
    userId: context.userId
  });
  services.events.publish(EVENT_IDS.ITEM_DROPPED, outcome);
  return accept(plan.action === DROP_ACTIONS.GROUND ? RESULT_CODES.ITEM_DROPPED : RESULT_CODES.ITEM_DISCARDED, outcome);
}

/**
 * Refuse a ground drop the writer could not finish: stale facts before anything was written, or a failed write
 * whose partial effects CommandDispatcher puts back before the refusal reaches the caller.
 */
function refuseDropSettlement(services, outcome) {
  const code = String(outcome?.code ?? DROP_SETTLEMENT_OUTCOMES.STALE);
  const reasonCode = outcome?.reasonCode || code;
  if (code === DROP_SETTLEMENT_OUTCOMES.STALE) return refuse(RESULT_CODES.DROP_STALE, { reasonCode });
  const diagnostic = outcome?.diagnostic ?? recordDiagnostic(services.diagnostics, {
    sourcePath: 'foundry/adapters/document-writes/objects.mjs', source: DIAGNOSTIC_SOURCES.OBJECTS,
    severity: DIAGNOSTIC_SEVERITIES.WARNING, detail: `${code}:${reasonCode}`
  });
  return refuse(RESULT_CODES.DROP_SETTLEMENT_FAILED, { reasonCode, diagnostic });
}

/** Close the unit's open plan on the square it stands on, after the item has been dropped. */
async function settleDropSquare(services, snapshot, context) {
  const movement = snapshot.source.movement;
  if (!movement) return;
  const resolution = resolveStandingDestination(movement);
  if (!resolution) return;
  await services.objects.commitSquare({ ...snapshot, operation: context.operation ?? null }, resolution);
}

/* -------------------------------------------- */
/*  Lock facts                                  */
/* -------------------------------------------- */

function lockFacts(snapshot, method) {
  return {
    method,
    objectType: snapshot.lock.objectType,
    locked: snapshot.lock.locked,
    keyName: snapshot.lock.keyName,
    carriesKey: snapshot.source.carriesKey,
    hasLocktouch: snapshot.source.hasLocktouch,
    difficultyClass: snapshot.lock.difficultyClass,
    inReach: snapshot.inReach,
    visible: snapshot.visible,
    claimsAction: snapshot.claimsAction,
    standardAvailable: snapshot.source.standardAvailable
  };
}

/** The notice data for a lock attempt planLockOpening refused. */
function lockRefusalData(snapshot) {
  return {
    actorName: snapshot.source.actorName,
    lockName: snapshot.lock.name,
    keyName: snapshot.lock.keyName,
    hasLocktouch: snapshot.source.hasLocktouch === true
  };
}

/**
 * Whether the caller holds the unit's open movement plan, which an attempt that spends the turn or commits the
 * square needs before anything rolls or unlocks, so the turn can be settled through that plan.
 */
function lockAttemptPlanned(snapshot, userId) {
  if (snapshot.claimsAction !== true && snapshot.commitsSquare !== true) return true;
  const movement = snapshot.source.movement;
  return movement?.movementPlanning === true && String(movement.movementControllerId ?? '') === String(userId ?? '');
}

function lockpickCheck(snapshot) {
  const skill = SKILL_BY_KEY[LOCKTOUCH_SKILL_KEY];
  return buildSkillCheck({
    skillKey: LOCKTOUCH_SKILL_KEY,
    mode: 'standard',
    dc: snapshot.lock.difficultyClass,
    rank: snapshot.source.skills?.[LOCKTOUCH_SKILL_KEY],
    statValue: snapshot.source.attributes?.[skill.stat],
    actorType: snapshot.source.actorType,
    blessed: snapshot.source.blessed
  });
}

/* -------------------------------------------- */
/*  Lock inspection                             */
/* -------------------------------------------- */

/**
 * Read-only lock views for the object API in api/facade.mjs: whether the unit can use the key or pick the lock, and
 * its chance. The lock command checks costs and reach again before writing.
 */
export function createObjectQueries({ objects }) {
  return Object.freeze({
    async inspectLock(intent = {}) {
      const normalized = normalizeLockOpenIntent({
        sourceTokenUuid: intent.sourceTokenUuid,
        lockTokenUuid: intent.lockTokenUuid,
        method: LOCK_METHODS.KEY
      });
      if (!normalized) return null;
      const snapshot = await objects.getLockSnapshot(normalized);
      if (!snapshot || snapshot.visible !== true) return null;
      const offered = method => ({ ...lockFacts(snapshot, method), inReach: true, claimsAction: false });
      const keyPlan = planLockOpening(offered(LOCK_METHODS.KEY));
      const pickPlan = planLockOpening(offered(LOCK_METHODS.LOCKTOUCH));
      const successPercent = pickPlan.ok
        ? Math.round(checkSuccessChance(lockpickCheck(snapshot)) * 100) : 0;
      return Object.freeze({
        lockName: snapshot.lock.name,
        lockImage: snapshot.lock.image,
        objectType: snapshot.lock.objectType,
        locked: snapshot.lock.locked,
        keyName: snapshot.lock.keyName,
        canUseKey: keyPlan.ok,
        canPick: pickPlan.ok,
        refusal: keyPlan.ok || pickPlan.ok ? '' : pickPlan.code,
        difficultyClass: snapshot.lock.difficultyClass,
        skillLabel: SKILL_BY_KEY[LOCKTOUCH_SKILL_KEY].label,
        successPercent,
        chanceBand: successChanceBand(successPercent),
        claimsAction: snapshot.claimsAction === true,
        exploring: snapshot.exploring === true
      });
    }
  });
}

/* -------------------------------------------- */
/*  Object commands                             */
/* -------------------------------------------- */

/**
 * The object command definitions init/system.mjs registers with CommandDispatcher: opening locks, taking up and
 * releasing Armaments, and dropping items.
 */
export function createObjectCommandContribution({
  objects, movements, checks, checkPresentation, skills, presentation, events, diagnostics, authority, wait
}) {
  requirePorts('createObjectCommandContribution', { objects, movements, checks, checkPresentation, skills,
    presentation, events, diagnostics, wait });
  const services = { objects, movements, checks, checkPresentation, skills, presentation, events, diagnostics, wait };
  const authorize = createCommandAuthorization(authority);
  return [
    {
      id: COMMAND_IDS.OBJECTS.OPEN_LOCK,
      authorize: authorize.tokenController(payload => payload.sourceTokenUuid),
      concurrencyKeys: async context => [...await objects.resourceKeys(context.payload), KARMA_LEDGER_RESOURCE_KEY],
      handler: context => openLock(context, services)
    },
    {
      id: COMMAND_IDS.OBJECTS.WIELD_ARMAMENT,
      authorize: authorize.tokenController(payload => payload.sourceTokenUuid),
      concurrencyKeys: context => objects.resourceKeys(context.payload),
      handler: context => wieldArmament(context, services)
    },
    {
      id: COMMAND_IDS.OBJECTS.RELEASE_ARMAMENT,
      authorize: authorize.tokenController(payload => payload.sourceTokenUuid),
      concurrencyKeys: context => objects.resourceKeys(context.payload),
      handler: context => releaseArmament(context, services)
    },
    {
      id: COMMAND_IDS.OBJECTS.DROP_ITEM,
      authorize: context => (Object.hasOwn(context.payload ?? {}, 'sourceActorUuid')
        ? authorize.actorOwner(payload => payload.sourceActorUuid)
        : authorize.tokenController(payload => payload.sourceTokenUuid))(context),
      concurrencyKeys: context => objects.resourceKeys(context.payload),
      handler: context => dropItem(context, services)
    },

  ];
}
