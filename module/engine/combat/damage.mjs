/** @layer engine/combat */
import {
  COMMAND_IDS,
  MAX_SETTLEMENT_ATTEMPTS
} from '../../contracts/commands.mjs';
import { accept, refuse, RESULT_CODES } from '../../contracts/results.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import {
  DAMAGE_POLICIES,
  DEFEAT_PRESENTATION_TIMING,
  DEFEAT_STATUSES,
  HEALTH_CHANGE_TYPES,
  healthPresentationMessage,
  isDamagePolicy,
  STANCE_BREAK_OUTCOMES,
  STANCE_BREAK_PRESENTATION_KIND,
  DAMAGE_TYPES
} from '../../contracts/domains/damage.mjs';
import { resolveDamage, resolveHealing, resolveStanceBreak } from '../../game/combat/damage.mjs';
import { recordDiagnostic, diagnosticData, requirePorts } from '../../contracts/protocol.mjs';
import { settleClaimedDefeat } from './defeat.mjs';

/* -------------------------------------------- */
/*  Health commands                             */
/* -------------------------------------------- */
const DAMAGE_TYPE_SET = new Set(DAMAGE_TYPES);

/**
 * The GM-only damage and healing command definitions behind api.combat.applyDamage and applyHealing, which
 * init/system.mjs registers with CommandDispatcher. `objects` drops a slain unit's loot, as an attack does, and
 * StanceBreakService applies or clears Stance Break after the hit or heal.
 */
export function createHealthCommandContribution({ health, presentation, events, stanceBreaks, objects, authority,
  wait }) {
  requirePorts('createHealthCommandContribution', { health, presentation, events, stanceBreaks, objects, wait });
  const gm = createCommandAuthorization(authority).gm();
  const actorKey = context => `actor:${String(context.payload?.actorUuid ?? '')}`;
  return [
    {
      id: COMMAND_IDS.COMBAT.APPLY_DAMAGE,
      authorize: gm,
      concurrencyKey: actorKey,
      handler: context => damageActor(context, health, presentation, events, stanceBreaks, wait, objects)
    },
    {
      id: COMMAND_IDS.COMBAT.APPLY_HEALING,
      authorize: gm,
      concurrencyKey: actorKey,
      handler: context => healActor(context, health, presentation, events, stanceBreaks)
    }
  ];
}

/* -------------------------------------------- */
/*  Damage settlement                           */
/* -------------------------------------------- */
async function damageActor(context, health, presentation, events, stanceBreaks, wait, objects) {
  const intent = damageIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DAMAGE_INPUT_INVALID);

  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const snapshot = await health.getSnapshot(intent.actorUuid, intent.tokenUuid);
    if (!snapshot) return refuse(RESULT_CODES.ACTOR_OR_TOKEN_REQUIRED);
    const resolution = resolveDamage({
      policy: intent.policy,
      damage: intent.amount,
      damageType: intent.damageType,
      stanceDamage: intent.stanceAmount,
      unpreventable: intent.unpreventable,
      canKillPlayer: intent.canKillPlayer,
      critical: false,
      target: snapshot.target
    });
    const committed = await health.commitDamage(snapshot, resolution, settlementContext(context));
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) return persistenceFailure(committed);
    const stanceBreak = await settleStanceMechanics(stanceBreaks, snapshot.actorUuid, context.operation ?? null);
    if (stanceBreak.outcome === STANCE_BREAK_OUTCOMES.FAILED) return stanceSettlementFailure(snapshot, stanceBreak);

    const hpAfter = Number.isFinite(committed.hpAfter) ? committed.hpAfter : resolution.hpAfter;
    const stanceAfter = Number.isFinite(committed.stanceAfter) ? committed.stanceAfter : resolution.stanceAfter;
    const defeatStatus = committed.defeatStatus ?? null;
    const outcome = {
      actorUuid: snapshot.actorUuid,
      actorName: snapshot.actorName,
      tokenUuid: snapshot.tokenUuid,
      damageType: resolution.damageType,
      requestedAmount: intent.amount,
      requestedStanceAmount: intent.stanceAmount,
      amount: resolution.amount,
      stanceAmount: resolution.stanceAmount,
      absorbed: resolution.absorbed,
      hpBefore: resolution.hpBefore,
      hpAfterDamage: resolution.hpAfter,
      hpAfter,
      stanceAfter,
      armorCurrent: committed.armorCurrent,
      protectionApplied: resolution.protectionApplied,
      vulnerabilityApplied: resolution.vulnerabilityApplied,
      lethal: resolution.defeated,
      defeated: defeatStatus === DEFEAT_STATUSES.CLAIMED,
      extraLifeTriggered: defeatStatus === DEFEAT_STATUSES.EXTRA_LIFE,
      defeatStatus,
      stanceBreak: stanceBreak.outcome,
      requestId: context.requestId,
      userId: context.userId
    };
    events.publish(EVENT_IDS.ACTOR_DAMAGED, outcome);
    const hitPresentation = presentSafely(presentation, damageMessage(snapshot, resolution));
    const stancePresentation = presentStanceSafely(stanceBreaks, stanceBreak);
    const defeat = await settleLethalDamage({
      health, objects, presentation, events, wait, snapshot, committed, context
    });
    const [hitPresentationComplete, stancePresentationComplete] = await Promise.all([
      hitPresentation,
      stancePresentation
    ]);
    return accept(RESULT_CODES.ACTOR_DAMAGED, {
      ...outcome,
      ...defeat,
      presentationComplete: hitPresentationComplete && stancePresentationComplete && defeat.presentationComplete
    });
  }
  return refuse(RESULT_CODES.HEALTH_STATE_STALE);
}

/* -------------------------------------------- */
/*  Defeat settlement                           */
/* -------------------------------------------- */

/**
 * Finish a claimed defeat through the shared defeat pipeline after the pause that follows a lethal hit.
 * The loot drop and the Token removal capture into this command's operation, and the defeat event waits for that
 * operation to commit so a restored defeat cannot count toward objectives.
 */
async function settleLethalDamage({ health, objects, presentation, events, wait, snapshot, committed, context }) {
  const status = committed.defeatStatus ?? null;
  if (!status) return { defeatComplete: false, presentationComplete: true };

  await wait(DEFEAT_PRESENTATION_TIMING.continuationDelay);
  const services = { defeats: health, objects, presentation, events, wait, diagnostics: presentation.diagnostics };
  return settleClaimedDefeat(services, {
    actorUuid: snapshot.actorUuid,
    actorName: snapshot.actorName,
    tokenUuid: snapshot.tokenUuid,
    actorType: String(snapshot.target?.actorType ?? ''),
    defeatStatus: status,
    extraLivesAfter: committed.extraLivesAfter
  }, { requestId: context.requestId, userId: context.userId, operation: context.operation ?? null });
}

/* -------------------------------------------- */
/*  Healing settlement                          */
/* -------------------------------------------- */
async function healActor(context, health, presentation, events, stanceBreaks) {
  const intent = healthIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.HEAL_INPUT_INVALID);

  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const snapshot = await health.getSnapshot(intent.actorUuid, intent.tokenUuid);
    if (!snapshot) return refuse(RESULT_CODES.ACTOR_OR_TOKEN_REQUIRED);
    const resolution = resolveHealing({
      amount: intent.amount,
      stanceAmount: intent.stanceAmount,
      target: snapshot.target
    });
    const committed = await health.commitHealing(snapshot, resolution, settlementContext(context));
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) return persistenceFailure(committed);
    const stanceBreak = await settleStanceMechanics(stanceBreaks, snapshot.actorUuid, context.operation ?? null);
    if (stanceBreak.outcome === STANCE_BREAK_OUTCOMES.FAILED) return stanceSettlementFailure(snapshot, stanceBreak);

    const outcome = Object.freeze({
      actorUuid: snapshot.actorUuid,
      actorName: snapshot.actorName,
      tokenUuid: snapshot.tokenUuid,
      requestedAmount: resolution.requestedAmount,
      requestedStanceAmount: resolution.requestedStanceAmount,
      amount: resolution.amount,
      stanceAmount: resolution.stanceAmount,
      hpBefore: resolution.hpBefore,
      hpAfter: resolution.hpAfter,
      healingBlocked: resolution.healingBlocked,
      stanceBreak: stanceBreak.outcome,
      requestId: context.requestId,
      userId: context.userId
    });
    events.publish(EVENT_IDS.ACTOR_HEALED, outcome);
    const [healingPresented, stancePresented] = await Promise.all([
      presentSafely(presentation, healingMessage(snapshot, resolution)),
      presentStanceSafely(stanceBreaks, stanceBreak)
    ]);
    const presentationComplete = healingPresented && stancePresented;
    return accept(RESULT_CODES.ACTOR_HEALED, { ...outcome, presentationComplete });
  }
  return refuse(RESULT_CODES.HEALTH_STATE_STALE);
}

/* -------------------------------------------- */
/*  Presentation transcripts                    */
/* -------------------------------------------- */
function damageMessage(snapshot, resolution) {
  return healthPresentationMessage({
    tokenUuid: snapshot.tokenUuid,
    change: HEALTH_CHANGE_TYPES.DAMAGE,
    resolution,
    physicalVariant: 'alt',
    lastHit: resolution.hpAfter <= 0
  });
}

function healingMessage(snapshot, resolution) {
  return healthPresentationMessage({
    tokenUuid: snapshot.tokenUuid,
    change: HEALTH_CHANGE_TYPES.HEAL,
    resolution
  });
}

async function presentSafely(presentation, message) {
  try {
    return await presentation.broadcast(message) !== false;
  } catch (diagnosticError) {
    recordDiagnostic(presentation.diagnostics, { sourcePath: import.meta.url, error: diagnosticError,
      detail: 'presentSafely' });
    return false;
  }
}

async function settleStanceMechanics(stanceBreaks, actorUuid, operation = null) {
  return stanceBreaks.settleMechanics(actorUuid, { operation });
}

async function presentStanceSafely(stanceBreaks, result) {
  if (result?.outcome !== STANCE_BREAK_OUTCOMES.APPLIED) return true;
  try { return await stanceBreaks.present(result) !== false; } catch (diagnosticError) {
    recordDiagnostic(stanceBreaks.diagnostics, { sourcePath: import.meta.url, error: diagnosticError,
      detail: 'presentStanceSafely' });
    return false;
  }
}

/* -------------------------------------------- */
/*  Command validation                          */
/* -------------------------------------------- */
function damageIntent(payload) {
  const common = healthIntent(payload);
  const damageType = String(payload?.damageType ?? '');
  // Direct damage defaults to the ability mitigation policy. Terrain callers pass a policy that avoids applying
  // their defenses twice.
  const policy = payload?.policy === undefined ? DAMAGE_POLICIES.ABILITY : payload.policy;
  // Typeless damage is valid only under DAMAGE_OVER_TIME, for phase ticks such as Bleeding.
  const typeKnown = DAMAGE_TYPE_SET.has(damageType)
    || (damageType === '' && policy === DAMAGE_POLICIES.DAMAGE_OVER_TIME);
  if (!common || !typeKnown || !isDamagePolicy(policy)) return null;
  return Object.freeze({
    ...common, damageType, policy,
    unpreventable: payload?.unpreventable === true,
    canKillPlayer: payload?.canKillPlayer !== false
  });
}

function healthIntent(payload) {
  const actorUuid = String(payload?.actorUuid ?? '');
  const tokenUuid = String(payload?.tokenUuid ?? '');
  const amount = Number(payload?.amount);
  const stanceAmount = Number(payload?.stanceAmount ?? 0);
  if (!actorUuid || !tokenUuid || !Number.isFinite(amount) || amount < 0
    || !Number.isFinite(stanceAmount) || stanceAmount < 0 || (amount === 0 && stanceAmount === 0)) return null;
  return Object.freeze({ actorUuid, tokenUuid, amount, stanceAmount });
}

/** The health write's attribution and the operation FoundryHealthRepository captures its before-images through. */
function settlementContext(context) {
  return {
    requestId: context.requestId,
    userId: context.userId,
    operation: context.operation ?? null
  };
}

/**
 * Refuse the whole command when a required Stance Break could not be written, so CommandDispatcher puts the
 * health write back with it.
 */
function stanceSettlementFailure(snapshot, stanceBreak) {
  return refuse(RESULT_CODES.STANCE_BREAK_FAILED, { ...diagnosticData(stanceBreak),
    actorUuid: snapshot.actorUuid,
    tokenUuid: snapshot.tokenUuid
  });
}

function persistenceFailure(committed) {
  return refuse(RESULT_CODES.COMMAND_FAILED, { ...diagnosticData(committed), reasonCode: committed?.code });
}

/* -------------------------------------------- */
/*  Stance-break lifecycle                      */
/* -------------------------------------------- */
/**
 * Apply game/combat/damage.mjs stance plans through the Foundry stance writer, then publish events and
 * presentation.
 */
export class StanceBreakService {
  constructor({ diagnostics, stances, events, presentation }) {
    requirePorts('StanceBreakService', { diagnostics, stances, events, presentation });
    this.diagnostics = diagnostics;
    this.stances = stances;
    this.events = events;
    this.presentation = presentation;
    this.queues = new Map();
  }

  /** Serialize repeated updates for one Actor and return the final lifecycle outcome. */
  settle(actorUuid) {
    return this.#enqueue(actorUuid, true);
  }

  /**
   * Apply stance mechanics without presenting them, under the caller's operation when it has one. The damage and
   * healing commands show the break alongside their own hit or heal.
   */
  settleMechanics(actorUuid, { operation = null } = {}) {
    return this.#enqueue(actorUuid, false, operation);
  }

  /** Present the committed stance result through the injected presenter without repeating writes or events. */
  async present(result) {
    if (result?.outcome !== STANCE_BREAK_OUTCOMES.APPLIED || !result.tokenUuid) return true;
    try {
      return await this.presentation.show(Object.freeze({
        kind: STANCE_BREAK_PRESENTATION_KIND,
        tokenUuid: result.tokenUuid
      })) !== false;
    } catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'present' });
      return false;
    }
  }

  #enqueue(actorUuid, present, operation = null) {
    const key = String(actorUuid ?? '');
    if (!key) return Promise.resolve(Object.freeze({ outcome: STANCE_BREAK_OUTCOMES.NONE }));
    const previous = this.queues.get(key) ?? Promise.resolve();
    const task = previous.catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'task' }); }).then(() => this.#settleFresh(key, present, operation));
    this.queues.set(key, task);
    void task.finally(() => {
      if (this.queues.get(key) === task) this.queues.delete(key);
    }).catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'enqueue' }); });
    return task;
  }

  async #settleFresh(actorUuid, present, operation = null) {
    for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
      const snapshot = await this.stances.getSnapshot(actorUuid);
      if (!snapshot) return Object.freeze({ outcome: STANCE_BREAK_OUTCOMES.NONE });
      const transition = resolveStanceBreak(snapshot);
      if (!transition.createBreakEffect && transition.deleteEffectIds.length === 0) {
        return Object.freeze({ outcome: transition.outcome });
      }

      const committed = await this.stances.commit(snapshot, transition, { operation });
      if (committed?.stale === true) continue;
      if (committed?.ok !== true) {
        return Object.freeze({ ...diagnosticData(committed), outcome: STANCE_BREAK_OUTCOMES.FAILED });
      }
      this.#publishCommitted(snapshot, transition, committed);
      const result = Object.freeze({
        outcome: transition.outcome,
        actorUuid: snapshot.actorUuid,
        tokenUuid: committed.tokenUuid ?? snapshot.tokenUuid
      });
      if (!present) return result;
      await this.present(result);
      return Object.freeze({ outcome: transition.outcome });
    }
    return Object.freeze({ outcome: STANCE_BREAK_OUTCOMES.STALE });
  }

  #publishCommitted(snapshot, transition, committed) {
    const eventId = transition.outcome === STANCE_BREAK_OUTCOMES.APPLIED ? EVENT_IDS.STANCE_BREAK_APPLIED
      : transition.outcome === STANCE_BREAK_OUTCOMES.CLEARED ? EVENT_IDS.STANCE_BREAK_CLEARED : null;
    if (!eventId) return;
    this.events.publish(eventId, {
      actorUuid: snapshot.actorUuid,
      actorName: snapshot.actorName,
      tokenUuid: committed.tokenUuid ?? snapshot.tokenUuid,
      outcome: transition.outcome
    });
  }
}
