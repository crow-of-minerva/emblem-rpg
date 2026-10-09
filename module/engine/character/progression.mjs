/** @layer engine/character */
import { requesterAudience } from '../feedback.mjs';
import { COMMAND_IDS, INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import {
  LEVEL_UP_VOICE_QUALITIES,
  PROGRESSION_PRESENTATION_BEATS,
  PROGRESSION_PRESENTATION_TIMING,
  PROMOTION_FLOURISH_TIMING,
  normalizePromotionIntent,
  progressionPresentationMessage
} from '../../contracts/domains/progression.mjs';
import { ITEM_ACTIVATION_PRESENTATION_BEATS, itemActivationPresentationMessage } from '../../contracts/domains/items.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { holdsResources } from '../dispatcher.mjs';
import {
  classBundleReopenRefusal,
  classReplacementRemovalIds,
  resolveAutomaticClassFeatureGrant,
  resolveClassFeatureSelection
} from '../../game/classes/rules.mjs';
import {
  planPromotionItemConsumption,
  promotionStatResults,
  resolvePromotionOptions
} from '../../game/classes/promotion.mjs';
import {
  planSkillExperienceGrant,
  resolveCharacterExperienceAward,
  resolveCharacterLevelUp,
  scaleCharacterExperience,
  skillBarExperience,
  SKILL_EXPERIENCE_PER_ROLL
} from '../../game/progression/rules.mjs';
import { SKILL_BY_KEY } from '../../game/character/rules.mjs';
import { accept, refuse, RESULT_CODES } from '../../contracts/results.mjs';
import { recordDiagnostic, diagnosticData, requirePorts } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Class commands                              */
/* -------------------------------------------- */
/**
 * The Class command definitions init/system.mjs registers with CommandDispatcher: assigning a Class, choosing
 * features from a bundle, a GM reopening a bundle, promotion, and the feature clean-up job the actor hooks in
 * foundry/hooks/actors.mjs submit as maintenance.
 */
export function createClassCommandContribution({
  diagnostics, classFeatures, events, authority, presentation, inventory, movements, progression, wait
}) {
  requirePorts('createClassCommandContribution', { diagnostics, classFeatures, events, presentation, inventory,
    movements, progression, wait });
  const authorize = createCommandAuthorization(authority);
  const classActor = payload => classFeatures.actorUuidForClass(String(payload.classUuid ?? ''));
  const actorKey = context => {
    const classUuid = String(context.payload?.classUuid ?? '');
    return `actor:${classFeatures.actorUuidForClass(classUuid) || classUuid}`;
  };
  const ports = { diagnostics, classFeatures, events, presentation, inventory, movements, progression, wait };
  return [
    {
      id: COMMAND_IDS.CHARACTER.CLASSES.ASSIGN,
      authorize: authorize.actorAuthor(payload => payload.actorUuid),
      concurrencyKey: context => `actor:${String(context.payload?.actorUuid ?? '')}`,
      handler: createClassReplacementHandler(ports)
    },
    {
      id: COMMAND_IDS.CHARACTER.CLASSES.SELECT_FEATURES,
      authorize: authorize.actorOwner(classActor),
      concurrencyKey: actorKey,
      handler: createClassFeatureSelectionHandler({ classFeatures, events })
    },
    {
      id: COMMAND_IDS.CHARACTER.CLASSES.REOPEN_BUNDLE,
      authorize: authorize.gm(),
      concurrencyKey: actorKey,
      handler: createBundleReopenHandler(ports)
    },
    {
      id: COMMAND_IDS.CHARACTER.CLASSES.PROMOTE,
      authorize: authorize.all(
        authorize.actorOwner(payload => payload.actorUuid),
        authorize.gmOption(payload => payload.bypassItem === true),
        authorize.gmOption(payload => payload.bypassRequirements === true),
        authorize.tokenController(payload => (payload.tokenUuid ? [payload.tokenUuid] : []))
      ),
      concurrencyKeys: context => promotionKeys(context, movements),
      handler: context => promoteCharacter(context, ports)
    },
    {
      id: INTERNAL_COMMAND_IDS.CHARACTER.CLASSES.RECONCILE_FEATURES,
      authorize: authorize.activeGm(),
      concurrencyKey: actorKey,
      handler: createClassFeatureReconciliationHandler(ports)
    },

  ];
}

/** The promoted Actor, plus the movement keys and every Actor that ending a named Token's move touches. */
async function promotionKeys(context, movements) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const tokenUuid = String(context.payload?.tokenUuid ?? '');
  const keys = new Set([`actor:${actorUuid}`]);
  if (tokenUuid) {
    for (const key of await movements.resourceKeys(tokenUuid)) keys.add(key);
  }
  return [...keys];
}

/* -------------------------------------------- */
/*  Character Class Replacement                */
/* -------------------------------------------- */

function createClassReplacementHandler({ classFeatures, events, presentation }) {
  return async context => {
    const actorUuid = String(context.payload?.actorUuid ?? '');
    const classData = context.payload?.classData;
    if (!actorUuid || !classData || classData.type !== 'Class') {
      return refuse(RESULT_CODES.CLASS_UPDATE_FAILED);
    }
    const snapshot = await classFeatures.getClassReplacementSnapshot(actorUuid, classData);
    if (!snapshot) return refuse(RESULT_CODES.CHARACTER_REQUIRED);
    const removalIds = classReplacementRemovalIds(
      snapshot.actorItems,
      snapshot.oldClass,
      snapshot.newClassData.name
    );
    const committed = await classFeatures.commitClassReplacement({
      actorUuid,
      expectedFingerprint: snapshot.fingerprint,
      oldClassId: snapshot.oldClass?.id ?? '',
      removalIds,
      newClassData: snapshot.newClassData,
      operation: context.operation
    });
    if (!committed.ok) return refuse(RESULT_CODES.CLASS_UPDATE_FAILED, { ...diagnosticData(committed),
      reasonCode: committed.code
    });
    await presentRemovedFeatures(presentation, committed, snapshot.oldClass?.name, requesterAudience(context));
    events.publish(EVENT_IDS.CHARACTER_CLASS_ASSIGNED, {
      actorUuid,
      classUuid: committed.classUuid,
      className: committed.className,
      removedFeatureNames: committed.removedFeatureNames,
      requestId: context.requestId,
      userId: context.userId
    });
    return accept(RESULT_CODES.CLASS_ASSIGNED, {
      actorUuid,
      actorName: committed.actorName,
      classUuid: committed.classUuid,
      label: `Class "${committed.className}"`,
      removedFeatureNames: committed.removedFeatureNames
    });
  };
}

/* -------------------------------------------- */
/*  Feature selection                           */
/* -------------------------------------------- */
function createClassFeatureSelectionHandler({ classFeatures, events }) {
  return async context => {
    const classUuid = String(context.payload?.classUuid ?? '');
    const bundleId = String(context.payload?.bundleId ?? '');
    const selectedIndices = Array.isArray(context.payload?.selectedIndices) ? context.payload.selectedIndices : [];
    const snapshot = await classFeatures.getSelectionSnapshot(classUuid, bundleId, selectedIndices);
    if (!snapshot) return refuse(RESULT_CODES.CLASS_BUNDLE_NOT_FOUND);

    const resolution = resolveClassFeatureSelection(snapshot);
    if (!resolution.ok) return resolution;
    const committed = await classFeatures.commitSelection({ ...resolution.data, operation: context.operation });
    if (!committed.ok) return refuse(RESULT_CODES.COMMAND_FAILED, { ...diagnosticData(committed),
      reasonCode: committed.code
    });
    const featureNames = committed.featureNames;
    events.publish(EVENT_IDS.CLASS_FEATURES_SELECTED, {
      actorUuid: committed.actorUuid,
      classUuid: committed.classUuid,
      bundleId,
      featureNames,
      requestId: context.requestId,
      userId: context.userId
    });
    return accept(RESULT_CODES.CLASS_FEATURES_SELECTED, {
      actorUuid: committed.actorUuid,
      actorName: committed.actorName,
      featureNames
    });
  };
}

/* -------------------------------------------- */
/*  Feature reconciliation                      */
/* -------------------------------------------- */
function createClassFeatureReconciliationHandler({ classFeatures, events, presentation }) {
  return async context => {
    const classUuid = String(context.payload?.classUuid ?? '');
    const result = await reconcileAutomaticClassFeatures(classUuid, classFeatures, context.operation);
    if (!result.ok) return result;
    const eventData = result.data;
    events.publish(EVENT_IDS.CLASS_FEATURES_RECONCILED, {
      ...eventData,
      requestId: context.requestId,
      userId: context.userId
    });
    await presentFeatureChanges(presentation, eventData, requesterAudience(context));
    return accept(result.code, eventData);
  };
}

/**
 * A GM reopens an automatic bundle that closed without granting an upgrade: its record is cleared and the Class's
 * automatic features are granted again at once, so the upgrade lands now if the unit owns what it replaces.
 */
function createBundleReopenHandler({ classFeatures, events, presentation }) {
  return async context => {
    const classUuid = String(context.payload?.classUuid ?? '');
    const bundleId = String(context.payload?.bundleId ?? '');
    const snapshot = await classFeatures.getAutomaticGrantSnapshot(classUuid);
    if (!snapshot) return refuse(RESULT_CODES.CLASS_BUNDLE_NOT_FOUND);
    const refusal = classBundleReopenRefusal(snapshot, bundleId);
    if (refusal) return refusal;
    const cleared = await classFeatures.clearBundleRecord({
      classUuid, bundleId, expectedFingerprint: snapshot.fingerprint, operation: context.operation
    });
    if (!cleared.ok) return refuse(RESULT_CODES.COMMAND_FAILED, { ...diagnosticData(cleared),
      reasonCode: cleared.code
    });
    const result = await reconcileAutomaticClassFeatures(classUuid, classFeatures, context.operation);
    if (!result.ok) return result;
    events.publish(EVENT_IDS.CLASS_FEATURES_RECONCILED, {
      ...result.data,
      requestId: context.requestId,
      userId: context.userId
    });
    await presentFeatureChanges(presentation, result.data, requesterAudience(context));
    return accept(result.code, result.data);
  };
}

/**
 * Show one feature update's "gained", "lost (replaced)" and "no longer exists" notices to the users in `audience`
 * only (requesterAudience in engine/feedback.mjs): the user who asked for the change, or the host GM for a
 * maintenance job.
 */
async function presentFeatureChanges(presentation, settlement, audience = []) {
  if (!settlement || !audience.length) return;
  const gained = settlement.featureNames ?? [];
  const replaced = settlement.replacedFeatureNames ?? [];
  const missing = settlement.unresolvedFeatureNames ?? [];
  if (!gained.length && !replaced.length && !missing.length) return;
  await presentSafely(() => presentation.presentFeatureChanges({
    actorName: settlement.actorName ?? '',
    gained,
    replaced,
    missing: missing.length ? { className: settlement.className ?? '', names: missing } : null
  }, { audience: [...audience] }), presentation.diagnostics);
}

/** The "no longer exists" notice for the unique features a Class replacement removed, told to `audience` alone. */
async function presentRemovedFeatures(presentation, committed, className, audience) {
  if (!committed.removedFeatureNames?.length || !audience.length) return;
  await presentSafely(() => presentation.presentFeatureChanges({
    actorName: committed.actorName,
    uniqueRemoved: { className: className ?? '', names: committed.removedFeatureNames }
  }, { audience: [...audience] }), presentation.diagnostics);
}

/* -------------------------------------------- */
/*  Promotion                                   */
/* -------------------------------------------- */
/**
 * The promotion command. It closes the unit's open move, then deliverPromotion swaps the Class, adds its features,
 * spends the promotion item, ends the turn last and publishes the events. Every document write goes through
 * `context.operation`, so a refusal anywhere undoes the promotion's game data; notices, the flourish and events
 * already sent are not taken back.
 */
async function promoteCharacter(context, ports) {
  const intent = normalizePromotionIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.PROMOTION_UNAVAILABLE);
  const { classFeatures, movements } = ports;
  const snapshot = await classFeatures.getPromotionSnapshot(intent.actorUuid, {
    usedItemId: intent.usedItemId, tokenUuid: intent.tokenUuid
  });
  if (!snapshot) return refuse(RESULT_CODES.CHARACTER_REQUIRED);
  if (snapshot.tokenForeign) return refuse(RESULT_CODES.PROMOTION_UNAVAILABLE, { message: 'That Token is not this unit.' });
  const tokenUuid = snapshot.tokenUuid;
  if (snapshot.turnOver && !intent.bypassRequirements) {
    return refuse(RESULT_CODES.PROMOTION_UNAVAILABLE, { message: 'Turn is over.' });
  }
  const resolution = resolvePromotionOptions(snapshot,
    { bypassItem: intent.bypassItem, bypassRequirements: intent.bypassRequirements });
  const option = resolution.options.find(entry => entry.id === intent.promotionId);
  if (!option?.selectable) {
    return refuse(RESULT_CODES.PROMOTION_UNAVAILABLE, { message: resolution.refusal ?? 'That promotion is unavailable.' });
  }
  const newClassData = await classFeatures.getClassSourceData(option.classUuid);
  if (!newClassData) return refuse(RESULT_CODES.PROMOTION_UNAVAILABLE, { message: 'The promotion Class could not be loaded.' });

  if (snapshot.movementPlanning && tokenUuid) {
    const movement = await ownMovement(movements, tokenUuid, intent.actorUuid);
    if (movement && !await holdsMovementReach(context, movements, tokenUuid)) {
      return refuse(RESULT_CODES.PROMOTION_UNAVAILABLE, { reasonCode: 'promotion.movement-resources-busy' });
    }
    if (movement) {
      await movements.commit(movement, { cost: 0 },
        { resume: true, endTurn: false, operation: context.operation });
    }
  }
  const staged = { intent, snapshot, option, newClassData, tokenUuid };
  return deliverPromotion(context, ports, staged);
}

/**
 * Play the promotion between the item-use intro and outro: flourish, Class swap, stat panel. The outro plays before
 * the turn is spent and the events are published.
 */
async function deliverPromotion(context, ports, { intent, snapshot, option, newClassData, tokenUuid }) {
  const { classFeatures, events, presentation } = ports;
  const bracket = promotionBracket(snapshot, intent);
  let bracketClosed = false;
  const close = async () => {
    if (bracketClosed) return;
    bracketClosed = true;
    await presentSafely(() => presentation.broadcast(bracket.end), presentation.diagnostics);
  };
  await presentSafely(() => presentation.broadcast(bracket.leadIn), presentation.diagnostics);
  try {
    // Runs the Class swap at most once. A thrown error is recorded and comes back as null.
    let settlement = null;
    const swapClass = () => {
      settlement ??= settlePromotion(snapshot, option, newClassData, intent, context, ports).catch(error => {
        recordDiagnostic(ports.diagnostics, { sourcePath: import.meta.url, error, detail: 'swapClass' });
        return null;
      });
      return settlement;
    };
    const flourishPlayed = await presentSafely(() => presentation.playPromotionFlourish(tokenUuid),
      presentation.diagnostics);
    if (flourishPlayed) await ports.wait(PROMOTION_FLOURISH_TIMING.burst);
    const swap = await swapClass();
    if (!swap) {
      await close();
      return refuse(RESULT_CODES.PROMOTION_FAILED, { reasonCode: 'promotion.settlement-error' });
    }
    if (!swap.ok) {
      await close();
      return refuse(RESULT_CODES.PROMOTION_FAILED, { ...diagnosticData(swap), reasonCode: swap.code });
    }

    const outcome = Object.freeze({
      actorUuid: intent.actorUuid,
      actorName: snapshot.actorName,
      tokenUuid,
      previousClassName: snapshot.classItem?.name ?? '',
      classUuid: swap.classUuid,
      className: swap.className,
      featureNames: swap.featureNames,
      requestId: context.requestId,
      userId: context.userId
    });
    const voiceClip = await promotionVoiceClip(ports, intent.actorUuid);
    if (flourishPlayed) await ports.wait(PROMOTION_FLOURISH_TIMING.total - PROMOTION_FLOURISH_TIMING.burst);
    const presentationComplete = await presentSafely(() => presentation.broadcast(progressionPresentationMessage(
      PROGRESSION_PRESENTATION_BEATS.PROMOTION_STATS,
      {
        actorName: snapshot.actorName,
        actorImage: swap.actorImage,
        avatarScale: swap.avatarScale,
        statResults: promotionStatResults(snapshot.classItem?.baseStats ?? {}, option.baseStats),
        voiceClip
      }
    )), presentation.diagnostics);
    await close();
    const finished = await finishPromotionTurn(intent.actorUuid, tokenUuid, snapshot, context, ports);
    if (!finished.ok) return refuse(RESULT_CODES.PROMOTION_FAILED, { reasonCode: finished.code });
    publishPromotionEvents(events, swap.reconciled, outcome, ports.diagnostics);
    return accept(RESULT_CODES.CLASS_PROMOTED, {
      ...outcome, flourishPlayed, presentationComplete, turnEnded: finished.ended
    });
  } catch (error) {
    recordDiagnostic(ports.diagnostics, { sourcePath: import.meta.url, error, detail: 'deliverPromotion' });
    return refuse(RESULT_CODES.PROMOTION_FAILED, { reasonCode: 'promotion.settlement-error' });
  } finally { await close(); }
}

/** The voice clip for the stat panel. A failed lookup is recorded and gives no clip, and the promotion goes on. */
async function promotionVoiceClip(ports, actorUuid) {
  try { return await ports.progression.levelVoiceClip(actorUuid, LEVEL_UP_VOICE_QUALITIES.GOOD) ?? null; }
  catch (error) {
    recordDiagnostic(ports.diagnostics, { sourcePath: import.meta.url, error, detail: 'voiceClip' });
    return null;
  }
}

/**
 * Publish the feature and promotion events once every promotion write has landed. CommandDispatcher commits the
 * undo record afterwards. A listener that throws is recorded and doesn't fail the promotion.
 */
function publishPromotionEvents(events, reconciled, outcome, diagnostics) {
  for (const [type, data] of [[EVENT_IDS.CLASS_FEATURES_RECONCILED, reconciled], [EVENT_IDS.CHARACTER_PROMOTED, outcome]]) {
    try { events.publish(type, data); }
    catch (error) { recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'promotion-event' }); }
  }
}

/** The item-use intro and outro a promotion shares with every other Consumable, shown on the promoting unit alone. */
function promotionBracket(snapshot, intent) {
  const source = { sourceTokenUuid: snapshot.tokenUuid, sourceActorUuid: snapshot.actorUuid };
  return {
    leadIn: itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.LEAD_IN, {
      ...source, targetTokenUuids: [], targetLocation: null, cinematic: intent.cinematic
    }),
    end: itemActivationPresentationMessage(ITEM_ACTIVATION_PRESENTATION_BEATS.END, {
      ...source, cinematic: intent.cinematic
    })
  };
}

/** Spend the turn a promotion owes: through the unit's open move, or on the Actor when it has none. */
async function finishPromotionTurn(actorUuid, tokenUuid, snapshot, context, { classFeatures, movements }) {
  if (snapshot.encounterRunning !== true) return promotionTurn(true, '', false);
  const movement = tokenUuid ? await ownMovement(movements, tokenUuid, actorUuid) : null;
  if (movement?.movementPlanning === true) {
    if (!await holdsMovementReach(context, movements, tokenUuid)) {
      return promotionTurn(false, 'promotion.turn-resources-busy');
    }
    return promotionTurn(await commitPlanEndTurn(movements, movement, context), 'promotion.turn-failed');
  }
  const spent = await classFeatures.spendPromotionTurn(actorUuid, context.operation);
  return promotionTurn(spent.ok === true, spent.code ?? '');
}

function promotionTurn(ok, code = '', ended = ok) {
  return { ok, code: ok ? '' : code, ended };
}

/** End the turn through the open move, treating a refusal and a thrown error alike. */
async function commitPlanEndTurn(movements, movement, context) {
  try {
    const closed = await movements.commit(movement, { cost: 0 },
      { resume: false, endTurn: true, operation: context.operation });
    return closed === true || closed?.ok === true;
  } catch (diagnosticError) {
    recordDiagnostic(movements.diagnostics, { sourcePath: import.meta.url, error: diagnosticError,
      detail: 'commitPlanEndTurn' });
    return false;
  }
}

/** The Token's current movement state, or null when the Token no longer stands for the promoted Actor. */
async function ownMovement(movements, tokenUuid, actorUuid) {
  const movement = await movements.getSnapshot(tokenUuid);
  return movement && String(movement.actorUuid ?? '') === actorUuid ? movement : null;
}

/**
 * Add the movement keys and every actor a move by this token touches, as they stand now, to the command's resource
 * keys before the promotion writes through the move. When the claim is refused, the caller writes nothing.
 */
async function holdsMovementReach(context, movements, tokenUuid) {
  return holdsResources(context, await movements.resourceKeys(tokenUuid)) === true;
}

/**
 * Write one promotion: the Class replacement, the features the new Class owes, the Mount it grants and the
 * promotion item it spends all go through `context.operation`, so a failed write undoes all of them.
 */
async function settlePromotion(snapshot, option, newClassData, intent, context, ports) {
  const { classFeatures } = ports;
  const replacement = await classFeatures.getClassReplacementSnapshot(snapshot.actorUuid, newClassData);
  if (!replacement) return promotionRefusal(RESULT_CODES.CHARACTER_REQUIRED);
  const sealPlan = intent.bypassItem ? null : planPromotionItemConsumption(snapshot.usedItem);
  const settled = await commitPromotionWrites({ snapshot, replacement, sealPlan, ports,
    operation: context.operation, audience: requesterAudience(context) });
  if (!settled.ok) return settled;
  const refreshed = await classFeatures.getPromotionSnapshot(snapshot.actorUuid, {});
  return {
    ok: true,
    classUuid: settled.classUuid,
    className: settled.className,
    featureNames: settled.reconciled.featureNames,
    reconciled: settled.reconciled,
    actorImage: refreshed?.actorImage ?? '',
    avatarScale: refreshed?.avatarScale ?? 1.25
  };
}

/** Apply the Class, feature, Mount and item writes, each after the one it depends on. */
async function commitPromotionWrites({ snapshot, replacement, sealPlan, ports, operation, audience }) {
  const { classFeatures, presentation } = ports;
  const actorUuid = snapshot.actorUuid;
  const removalIds = classReplacementRemovalIds(replacement.actorItems, replacement.oldClass, replacement.newClassData.name);
  const committed = await classFeatures.commitClassReplacement({
    actorUuid,
    expectedFingerprint: replacement.fingerprint,
    oldClassId: replacement.oldClass?.id ?? '',
    removalIds,
    newClassData: replacement.newClassData,
    operation
  });
  if (!committed.ok) return promotionRefusal(committed.code);
  await presentRemovedFeatures(presentation, committed, replacement.oldClass?.name, audience);
  const reconciled = await reconcileAutomaticClassFeatures(committed.classUuid, classFeatures, operation);
  if (!reconciled.ok) return promotionRefusal(reconciled.data?.reasonCode ?? reconciled.code);
  await presentFeatureChanges(presentation, reconciled.data, audience);
  const mounted = await equipGrantedMount(actorUuid, reconciled.data.grantedMountItemId, ports);
  if (!mounted.ok) return mounted;
  const spent = sealPlan ? await classFeatures.consumePromotionItem(actorUuid, sealPlan, operation) : { ok: true };
  if (!spent.ok) return promotionRefusal(spent.code);
  return {
    ok: true,
    classUuid: committed.classUuid,
    className: committed.className,
    reconciled: reconciled.data
  };
}

/** Ride the Mount a promotion granted, through the equipment command that owns wielding and wearing. */
async function equipGrantedMount(actorUuid, itemId, { inventory }) {
  if (!itemId) return { ok: true };
  return await toggleMount(inventory, actorUuid, itemId)
    ? { ok: true }
    : promotionRefusal('promotion.mount-failed');
}

/** Ride or dismount through the equipment command, treating a refusal and a thrown error alike. */
async function toggleMount(inventory, actorUuid, itemId) {
  try {
    return (await inventory.toggleEquipment({ actorUuid, itemId }))?.ok === true;
  } catch (diagnosticError) {
    recordDiagnostic(inventory.diagnostics, { sourcePath: import.meta.url, error: diagnosticError,
      detail: 'toggleMount' });
    return false;
  }
}

function promotionRefusal(code) {
  return { ok: false, code };
}

/**
 * Grant the automatic features a Class owes the unit through classFeatures.commitAutomaticGrant. Used after a
 * level-up, by promotion and by the RECONCILE_FEATURES maintenance command.
 */
async function reconcileAutomaticClassFeatures(classUuid, classFeatures, operation = null) {
  const snapshot = await classFeatures.getAutomaticGrantSnapshot(classUuid);
  if (!snapshot) return refuse(RESULT_CODES.CLASS_BUNDLE_NOT_FOUND);
  const plan = resolveAutomaticClassFeatureGrant(snapshot);
  if (!plan.bundleIds.length) {
    return accept(RESULT_CODES.CLASS_FEATURES_RECONCILED, {
      actorUuid: snapshot.actorUuid,
      classUuid,
      featureNames: [],
      resolvedBundles: []
    });
  }
  const committed = await classFeatures.commitAutomaticGrant({
    actorUuid: snapshot.actorUuid,
    classUuid: snapshot.classUuid,
    classId: snapshot.classId,
    expectedFingerprint: snapshot.fingerprint,
    featureRefs: plan.featureRefs,
    bundleIds: plan.bundleIds,
    operation
  });
  if (!committed.ok) return refuse(RESULT_CODES.COMMAND_FAILED, { ...diagnosticData(committed),
    reasonCode: committed.code
  });
  return accept(RESULT_CODES.CLASS_FEATURES_RECONCILED, {
    actorUuid: committed.actorUuid,
    actorName: committed.actorName,
    classUuid: committed.classUuid,
    className: committed.className,
    featureNames: committed.featureNames,
    replacedFeatureNames: committed.replacedFeatureNames ?? [],
    unresolvedFeatureNames: committed.unresolvedFeatureNames ?? [],
    grantedMountItemId: committed.grantedMountItemId ?? '',
    resolvedBundles: committed.resolvedBundles
  });
}

/* -------------------------------------------- */
/*  Progression commands                        */
/* -------------------------------------------- */
/**
 * The GM progression command definitions init/system.mjs registers with CommandDispatcher: granting XP, a direct
 * level-up and granting skill XP. They use the same code as awards earned in play.
 */
export function createProgressionCommandContribution({
  progression, presentation, events, classFeatures, authority, wait
}) {
  requirePorts('createProgressionCommandContribution', { progression, presentation, events, classFeatures, wait });
  const authorize = createCommandAuthorization(authority);
  const actorKey = context => `actor:${String(context.payload?.actorUuid ?? '')}`;
  return [
    {
      id: COMMAND_IDS.CHARACTER.PROGRESSION.GRANT_EXPERIENCE,
      authorize: authorize.gm(),
      concurrencyKey: actorKey,
      handler: context => grantCharacterExperienceUseCase(
        context, progression, presentation, events, classFeatures, wait
      )
    },
    {
      id: COMMAND_IDS.CHARACTER.PROGRESSION.LEVEL_UP,
      authorize: authorize.gm(),
      concurrencyKey: actorKey,
      handler: context => levelUpCharacter(context, progression, presentation, events, classFeatures, wait)
    },
    {
      id: COMMAND_IDS.CHARACTER.PROGRESSION.GRANT_SKILL_EXPERIENCE,
      authorize: authorize.gm(),
      /**
       * Only a direct GM request computes this key. Skill grants earned in play run as child commands
       * (engine/character/skill-experience.mjs) inside their caller's run and use its keys.
       */
      concurrencyKey: context => `skills:${String(context.payload?.actorUuid ?? '')}`,
      handler: context => grantSkillExperience(context, progression, presentation, events)
    }
  ];
}

/* -------------------------------------------- */
/*  Skill experience                            */
/* -------------------------------------------- */

/** Grant skill XP through progression.commitSkillExperience, taking every rank the award crosses. */
async function grantSkillExperience(context, progression, presentation, events) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const skillKey = String(context.payload?.skillKey ?? '').toLowerCase();
  const skill = SKILL_BY_KEY[skillKey];
  if (!skill) return refuse(RESULT_CODES.SKILL_UNKNOWN);
  const snapshot = await progression.getSkillSnapshot(actorUuid, skillKey);
  if (!snapshot) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);
  const fraction = context.payload?.fraction;
  const amount = fraction !== undefined
    ? skillBarExperience(snapshot.skill, Number(fraction))
    : Number(context.payload?.amount ?? SKILL_EXPERIENCE_PER_ROLL);
  const plan = planSkillExperienceGrant(snapshot.skill, amount);
  if (!plan) {
    return accept(RESULT_CODES.SKILL_RANK_MAXIMUM, {
      actorUuid, actorName: snapshot.actorName, skillKey, skillLabel: skill.label
    });
  }
  if (!await progression.commitSkillExperience(actorUuid, skillKey, plan, { operation: context.operation })) {
    return refuse(RESULT_CODES.COMMAND_FAILED);
  }
  const outcome = {
    actorUuid,
    actorName: snapshot.actorName,
    skillKey,
    skillLabel: skill.label,
    ...plan,
    requestId: context.requestId
  };
  events.publish(EVENT_IDS.SKILL_EXPERIENCE_GRANTED, outcome);
  if (plan.ranksGained > 0) {
    events.publish(EVENT_IDS.SKILL_RANK_GAINED, outcome);
    try { await presentation.createSkillRankUp(outcome); } catch (diagnosticError) {
      recordDiagnostic(presentation.diagnostics, { sourcePath: import.meta.url, error: diagnosticError,
        detail: 'grantSkillExperience' });
    }
  }
  return accept(RESULT_CODES.SKILL_EXPERIENCE_GRANTED, outcome);
}

/**
 * The level XP service init/system.mjs gives the combat exchange, item activation and training.
 * settleCombatExperience writes each award and any level-up, and publishCombatExperience publishes and presents
 * them afterwards. An award the multipliers or the level cap bring to 0 is written but not returned, so nothing
 * presents it.
 */
export function createCombatProgressionService({ progression, presentation, events, classFeatures, wait }) {
  requirePorts('createCombatProgressionService', { progression, presentation, events, classFeatures, wait });
  return Object.freeze({
    async settleCombatExperience({ awards, operation = null }) {
      const settlements = [];
      for (const award of awards ?? []) {
        if (!(Number(award?.experience) > 0)) continue;
        const settled = await settleCharacterExperienceAward({
          actorUuid: String(award.actorUuid ?? ''),
          requestedExperience: Number(award.experience), operation
        }, progression, classFeatures);
        if (!settled.ok) return { ...settled, settlements };
        if (settled.experience.awarded > 0 || settled.levelUp?.leveled) {
          settlements.push({ ...settled, side: String(award.side ?? '') });
        }
      }
      return { ok: true, settlements };
    },

    async publishCombatExperience({ settlements, context }) {
      const outcomes = [];
      for (const settlement of settlements ?? []) {
        outcomes.push(await completeCharacterExperienceSettlement(
          settlement,
          context,
          progression,
          presentation,
          events,
          wait
        ));
      }
      return outcomes;
    }
  });
}

/* -------------------------------------------- */
/*  Experience awards                           */
/* -------------------------------------------- */
async function grantCharacterExperienceUseCase(
  context,
  progression,
  presentation,
  events,
  classFeatures,
  wait
) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const requestedExperience = Number(context.payload?.experience);
  if (!Number.isInteger(requestedExperience) || requestedExperience <= 0) {
    return refuse(RESULT_CODES.CHARACTER_EXPERIENCE_REQUIRED);
  }
  const settlement = await settleCharacterExperienceAward({ actorUuid, requestedExperience,
    operation: context.operation }, progression, classFeatures);
  if (!settlement.ok) {
    if (settlement.code === RESULT_CODES.CHARACTER_REQUIRED) return refuse(RESULT_CODES.CHARACTER_REQUIRED);
    return persistenceFailure(settlement);
  }
  if (settlement.maximum) {
    return accept(RESULT_CODES.CHARACTER_LEVEL_MAXIMUM, actorResult(settlement.snapshot));
  }
  const outcome = await completeCharacterExperienceSettlement(
    settlement,
    context,
    progression,
    presentation,
    events,
    wait
  );
  return accept(RESULT_CODES.CHARACTER_EXPERIENCE_GRANTED, outcome);
}

/**
 * Scale and write one XP award, with any level-up and the Class features it brings. Nothing is published or
 * presented here. completeCharacterExperienceSettlement does that.
 */
async function settleCharacterExperienceAward(
  { actorUuid, requestedExperience, operation = null },
  progression,
  classFeatures = null
) {
  const snapshot = await progression.getCharacterSnapshot(actorUuid);
  if (!snapshot) return { ok: false, code: RESULT_CODES.CHARACTER_REQUIRED };
  // Every figure reported from here on is the multiplied award, so a Character's own XP rate reads consistently.
  const scaled = scaleCharacterExperience(requestedExperience, snapshot.experienceMultiplier,
    snapshot.worldExperienceMultiplier);
  const experience = resolveCharacterExperienceAward({
    currentExperience: snapshot.currentExperience,
    experienceThreshold: snapshot.experienceThreshold,
    currentLevel: snapshot.currentLevel,
    maxLevel: snapshot.maxLevel,
    requestedExperience: scaled
  });
  if (experience.atLevelCap) {
    const committed = await progression.commitSettlement({ snapshot, experience: 0, operation });
    return committed.ok
      ? {
        ok: true,
        maximum: true,
        snapshot,
        requestedExperience: scaled,
        experience,
        levelUp: null,
        reconciliation: { ok: true, settlements: [] }
      }
      : committed;
  }

  const levelUp = experience.levelsGained ? await buildLevelUp(snapshot, progression) : null;
  const committed = await progression.commitSettlement({
    snapshot,
    experience: experience.remainingExperience,
    levelUp, operation
  });
  if (!committed.ok) return committed;
  const reconciliation = levelUp?.leveled
    ? await reconcileCharacterClasses(snapshot, classFeatures, operation)
    : { ok: true, settlements: [] };
  if (!reconciliation.ok) return { ok: false, code: 'progression.class-reconciliation-failed' };
  return {
    ok: true,
    maximum: false,
    snapshot,
    requestedExperience: scaled,
    experience,
    levelUp,
    reconciliation
  };
}

/** Publish the events for an award settleCharacterExperienceAward has written, then present it. */
async function completeCharacterExperienceSettlement(
  settlement,
  context,
  progression,
  presentation,
  events,
  wait
) {
  const { snapshot, requestedExperience, experience, levelUp, reconciliation } = settlement;
  publishClassReconciliationEvents(reconciliation.settlements, events, context);
  for (const classSettlement of reconciliation.settlements) {
    await presentFeatureChanges(presentation, classSettlement, requesterAudience(context));
  }
  const outcome = Object.freeze({
    ...actorResult(snapshot),
    requestedExperience,
    awardedExperience: experience.awarded,
    discardedExperience: experience.discarded,
    previousExperience: snapshot.currentExperience,
    experience: experience.remainingExperience,
    previousLevel: snapshot.currentLevel,
    level: levelUp?.level ?? snapshot.currentLevel,
    leveled: levelUp?.leveled === true,
    classReconciliationComplete: true,
    requestId: context.requestId,
    userId: context.userId
  });
  events.publish(EVENT_IDS.CHARACTER_EXPERIENCE_GRANTED, outcome);
  if (levelUp?.leveled) events.publish(EVENT_IDS.CHARACTER_LEVEL_GAINED, levelOutcome(outcome, levelUp));
  const presentationComplete = await presentProgression(presentation, progression, snapshot, experience, levelUp, wait);
  return { ...outcome, presentationComplete };
}

/* -------------------------------------------- */
/*  Direct level-up                             */
/* -------------------------------------------- */
/**
 * Raise one unit a level outside the XP path, for the GM Macros compendium's Level Up Unit and Quick Level Up
 * Unit(s). A quiet request still writes the level, updates Class features and publishes its events. It only skips
 * presentLevel, so the splash, stat panel and voice clip never play. The outcome carries each stat's roll so a
 * caller can report the growths itself.
 */
async function levelUpCharacter(context, progression, presentation, events, classFeatures, wait) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const quiet = context.payload?.quiet === true;
  const snapshot = await progression.getCharacterSnapshot(actorUuid);
  if (!snapshot) return refuse(RESULT_CODES.CHARACTER_REQUIRED);
  if (snapshot.currentLevel >= snapshot.maxLevel) {
    return accept(RESULT_CODES.CHARACTER_LEVEL_MAXIMUM, actorResult(snapshot));
  }

  const levelUp = await buildLevelUp(snapshot, progression);
  const committed = await progression.commitSettlement({
    snapshot,
    experience: snapshot.currentExperience,
    levelUp, operation: context.operation
  });
  if (!committed.ok) return persistenceFailure(committed);
  const reconciliation = await reconcileCharacterClasses(snapshot, classFeatures, context.operation);
  if (!reconciliation.ok) return persistenceFailure({ code: 'progression.class-reconciliation-failed' });
  publishClassReconciliationEvents(reconciliation.settlements, events, context);
  for (const classSettlement of reconciliation.settlements) {
    await presentFeatureChanges(presentation, classSettlement, requesterAudience(context));
  }
  const outcome = {
    ...actorResult(snapshot),
    previousLevel: snapshot.currentLevel,
    level: levelUp.level,
    stats: levelUp.stats,
    statsIncreased: levelUp.statUpdates.map(update => update.statKey),
    classReconciliationComplete: true,
    requestId: context.requestId,
    userId: context.userId
  };
  events.publish(EVENT_IDS.CHARACTER_LEVEL_GAINED, levelOutcome(outcome, levelUp));
  const presentationComplete = quiet
    ? true : await presentLevel(presentation, progression, snapshot, levelUp, wait);
  return accept(RESULT_CODES.CHARACTER_LEVEL_GAINED, { ...outcome, quiet, presentationComplete });
}

/* -------------------------------------------- */
/*  Level-up helpers                            */
/* -------------------------------------------- */
async function buildLevelUp(snapshot, progression) {
  return resolveCharacterLevelUp({
    currentLevel: snapshot.currentLevel,
    maxLevel: snapshot.maxLevel,
    stats: snapshot.stats,
    growthRolls: await progression.rollGrowths(),
    hasBuddingTalent: snapshot.hasBuddingTalent
  });
}

async function reconcileCharacterClasses(snapshot, classFeatures, operation = null) {
  if (!snapshot.classUuids?.length) {
    return { ok: true, settlements: [] };
  }
  const settlements = [];
  for (const classUuid of snapshot.classUuids) {
    const result = await reconcileAutomaticClassFeatures(classUuid, classFeatures, operation);
    if (!result.ok) {
      return { ok: false, settlements, failure: result };
    }
    settlements.push(result.data);
  }
  return { ok: true, settlements };
}

function publishClassReconciliationEvents(settlements, events, context) {
  for (const settlement of settlements) {
    events.publish(EVENT_IDS.CLASS_FEATURES_RECONCILED, {
      ...settlement,
      requestId: context.requestId,
      userId: context.userId
    });
  }
}

/**
 * Broadcast the XP bar through UnitPresentationGateway, waiting no longer than
 * PROGRESSION_PRESENTATION_TIMING.experienceBarCap, then present the level-up if the award crossed a level. An
 * award of 0 shows no bar.
 */
async function presentProgression(presentation, progression, snapshot, experience, levelUp, wait) {
  let complete = experience.awarded > 0
    ? await presentExperienceBar(presentation, snapshot, experience, wait)
    : true;
  if (levelUp?.leveled) complete = await presentLevel(presentation, progression, snapshot, levelUp, wait) && complete;
  return complete;
}

async function presentExperienceBar(presentation, snapshot, experience, wait) {
  const bar = presentSafely(() => presentation.broadcast(progressionPresentationMessage(
    PROGRESSION_PRESENTATION_BEATS.EXPERIENCE,
    {
      actorName: snapshot.actorName,
      currentLevel: snapshot.currentLevel,
      maxLevel: snapshot.maxLevel,
      currentExperience: snapshot.currentExperience,
      experienceThreshold: snapshot.experienceThreshold,
      awardedExperience: experience.awarded
    }
  )), presentation.diagnostics);
  return Promise.race([bar, wait(PROGRESSION_PRESENTATION_TIMING.experienceBarCap).then(() => true)]);
}

/**
 * Broadcast the level splash, wait PROGRESSION_PRESENTATION_TIMING.splashToPanel, then show the stat panel and
 * any Budding Talent notice.
 */
async function presentLevel(presentation, progression, snapshot, levelUp, wait) {
  const voiceClip = await progression.levelVoiceClip(snapshot.actorUuid, levelUp.voiceQuality).catch((diagnosticError) => { recordDiagnostic(presentation?.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'voiceClip' }); return null; });
  const splash = presentSafely(() => presentation.broadcast(progressionPresentationMessage(
    PROGRESSION_PRESENTATION_BEATS.SPLASH, {}
  )), presentation.diagnostics);
  const [splashComplete] = await Promise.all([splash, wait(PROGRESSION_PRESENTATION_TIMING.splashToPanel)]);
  let complete = splashComplete;
  complete = await presentSafely(() => presentation.broadcast(progressionPresentationMessage(
    PROGRESSION_PRESENTATION_BEATS.STATS,
    {
      actorName: snapshot.actorName,
      actorImage: snapshot.actorImage,
      avatarScale: snapshot.avatarScale,
      stats: Object.fromEntries(Object.entries(snapshot.stats).map(([key, value]) => [key, value.total])),
      statResults: levelUp.stats,
      voiceClip
    }
  )), presentation.diagnostics) && complete;
  if (levelUp.buddingTalent?.action !== 'keep') {
    complete = await presentSafely(() => presentation.presentBuddingTalent({
      actorUuid: snapshot.actorUuid,
      actorName: snapshot.actorName,
      actorImage: snapshot.actorImage,
      avatarScale: snapshot.avatarScale,
      notice: levelUp.buddingTalent
    }), presentation.diagnostics) && complete;
  }
  return complete;
}

async function presentSafely(callback, diagnostics = null) {
  try {
    return (await callback()) !== false;
  } catch (error) {
    recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'Present progression feedback' });
    return false;
  }
}

function actorResult(snapshot) {
  return { actorUuid: snapshot.actorUuid, actorName: snapshot.actorName };
}

function levelOutcome(outcome, levelUp) {
  return Object.freeze({
    actorUuid: outcome.actorUuid,
    actorName: outcome.actorName,
    previousLevel: outcome.previousLevel,
    level: outcome.level,
    stats: levelUp.stats,
    buddingTalent: levelUp.buddingTalent,
    requestId: outcome.requestId,
    userId: outcome.userId
  });
}

function persistenceFailure(committed) {
  return refuse(RESULT_CODES.COMMAND_FAILED, { ...diagnosticData(committed), reasonCode: committed.code });
}
