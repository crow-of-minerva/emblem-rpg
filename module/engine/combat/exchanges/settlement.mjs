/** @layer engine/combat/exchanges */
import {
  COMBAT_CONTINUATIONS,
  COMBAT_EXCHANGE_TIMING
} from '../../../contracts/domains/combat.mjs';
import { EVENT_IDS } from '../../../contracts/events.mjs';
import {
  DEFEAT_STATUSES,
  HEALTH_CHANGE_TYPES,
  STANCE_BREAK_OUTCOMES,
  STANCE_BREAK_PRESENTATION_KIND,
  STANCE_BREAK_STATUS_ID
} from '../../../contracts/domains/damage.mjs';
import { defeatEndsExchange, isConfirmedKill, resolveStanceBreak } from '../../../game/combat/damage.mjs';
import { settleClaimedDefeat } from '../defeat.mjs';
import { computeAttackExperience, earnsCharacterExperience } from '../../../game/progression/rules.mjs';
import { CombatPersistenceError, StaleCombatError } from '../../recovery/errors.mjs';
import { effectContext, effectRuntime } from '../../effects/request.mjs';
import { presentSafely } from '../../feedback.mjs';
import { MAX_SETTLEMENT_ATTEMPTS } from '../../../contracts/commands.mjs';
import { DIAGNOSTIC_SEVERITIES, recordDiagnostic } from '../../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Trigger sequencing                          */
/* -------------------------------------------- */

/** Run `self`'s item effects for the named triggers (onHit, onMiss and so on) against `target`. */
export async function runActiveTriggers(services, self, target, snapshot, triggers, context = {}, effectHealth = null) {
  return runGroupedEffects(services, self.effects, self, target, snapshot, triggers, context, effectHealth);
}

/**
 * Run the effects a landed blow sets off and return the defeat status the blow ends with.
 * The striker's on-hit effects run first, then the struck unit's On Struck, from its weapon and then its Passives.
 * A unit the blow dropped is not yet defeated, so either side's effects still reach it and a heal can save it.
 * The defeat is then checked again. If it holds, the dead unit's On Death and the striker's On Kill run, neither
 * targeting the body, and turn slots On Kill gives back go to `restores`. A saved unit sets off nothing more.
 * Effect conditions see the struck unit's HP and stance as the blow left them (struckAfterBlow), so "puts the
 * target into Stance Break" reads `targetStn <= 0`.
 */
export async function runHitTriggers(services, acting, defending, snapshot, blow, effectHealth, restores = null) {
  const struck = struckAfterBlow(defending, blow);
  const activeTriggers = blow.critical ? ['onCrit', 'onHitOrCrit'] : ['onHit', 'onHitOrCrit'];
  const context = { dmg: blow.rolledDamage, isCrit: blow.critical, combat: blow };
  await runActiveTriggers(services, acting, struck, snapshot, activeTriggers, context, effectHealth);
  await runActiveTriggers(services, struck, acting, snapshot, ['onStruck'], context, effectHealth);
  await runGroupedEffects(
    services, struck.passiveEffects, struck, acting, snapshot, ['onStruck'], context, effectHealth
  );
  if (blow.defeatStatus !== DEFEAT_STATUSES.CLAIMED) return blow.defeatStatus ?? null;
  const finalStatus = await recheckDefeat(services, struck.actorUuid, struck.tokenUuid, snapshot.operation);
  if (!isConfirmedKill(finalStatus)) return finalStatus;
  const slainContext = { ...context, slainActorUuids: [struck.actorUuid] };
  await runGroupedEffects(
    services, struck.passiveEffects, struck, acting, snapshot, ['onDeath'], slainContext, effectHealth
  );
  collectRestores(
    await runActiveTriggers(services, acting, struck, snapshot, ['onKill'], slainContext, effectHealth), restores
  );
  collectRestores(await runGroupedEffects(
    services, acting.passiveEffects, acting, struck, snapshot, ['onKill'], slainContext, effectHealth
  ), restores);
  return finalStatus;
}

/**
 * Copy the struck unit so effect conditions see its HP and stance as the blow left them, both as the striker's
 * `target` and as its own `self`. A unit left standing at 0 stance also reads as Stance Broken, as
 * resolveStanceBreak in game/combat/damage.mjs decides.
 * @param {object} side The struck unit as read before the blow.
 * @param {object} blow The landed blow record.
 * @returns {object} The side itself when there is nothing to change.
 */
function struckAfterBlow(side, blow) {
  const facts = side.conditionSelf;
  const hp = finiteOrNull(blow.hpAfter);
  const stn = finiteOrNull(blow.stanceAfter);
  if (!facts || typeof facts !== 'object' || (hp === null && stn === null)) return side;
  const overlay = {};
  if (hp !== null) overlay.hp = hp;
  if (stn !== null) overlay.stn = stn;
  if (stn !== null && stn <= 0 && (hp ?? Number(facts.hp)) > 0) {
    const breakKey = STANCE_BREAK_STATUS_ID.toLowerCase();
    const statuses = Array.isArray(facts.statuses) ? facts.statuses : [];
    overlay.stanceBroken = true;
    overlay.statuses = Object.freeze(statuses.includes(breakKey) ? [...statuses] : [...statuses, breakKey]);
  }
  const unit = facts.self && typeof facts.self === 'object' ? Object.freeze({ ...facts.self, ...overlay }) : null;
  const nested = unit ? { self: unit, caster: facts.caster === facts.self ? unit : facts.caster } : {};
  return Object.freeze({ ...side, conditionSelf: Object.freeze({ ...facts, ...overlay, ...nested }) });
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Run the missed-blow trigger family: the swinging side's miss, then the struck-at side's evasion. */
export async function runMissTriggers(services, acting, defending, snapshot, check, effectHealth) {
  await runActiveTriggers(services, acting, defending, snapshot, ['onMiss'], { check }, effectHealth);
  await runActiveTriggers(services, defending, acting, snapshot, ['onEvade'], { check }, effectHealth);
  await runGroupedEffects(
    services, defending.passiveEffects, defending, acting, snapshot, ['onEvade'], { check }, effectHealth
  );
}

/**
 * The EffectExecutionService request for one item's trigger entries in an attack. The combat numbers (protections,
 * immunities, maximums) go beside the runtime, not inside it: damage and heal steps use them as the attack read
 * them, and the runtime, which is sent to every client with the animations, stays free of them.
 */
function effectRequest(entries, self, target, snapshot, triggers, context = {}, activatedItem = null) {
  const selfActor = self.conditionSelf ?? self;
  const targetActor = target.conditionSelf ?? target;
  return {
    entries,
    triggers,
    combatContext: snapshot.combatContext,
    runtime: effectRuntime({
      sceneUuid: snapshot.sceneUuid,
      operation: snapshot.operation,
      self,
      target,
      targetLocation: context.targetLocation ?? null,
      effectTiles: context.effectTiles ?? null,
      prePickedPlacement: context.prePickedPlacement ?? null,
      effectRange: self.tokenUuid === snapshot.sourceTokenUuid ? snapshot.effectRange : 0,
      healEchoes: self.healEchoes,
      activatedItemUuid: activatedItem?.uuid,
      slainActorUuids: context.slainActorUuids ?? null
    }),
    context: effectContext(selfActor, targetActor, activatedItem ?? self.conditionItem ?? self.weapon, context),
    activatedItem,
    audience: snapshot.audience
  };
}

/**
 * Run `entries` one item at a time. After each item, any unit its steps killed gets its On Death run, which can
 * kill again and recurse. `deathClaims` holds the units whose On Death has started, so it never runs twice.
 */
async function runGroupedEffects(
  services, entries, self, target, snapshot, triggers, context, effectHealth, deathClaims = new Set()
) {
  const results = [];
  for (const group of groupEntriesByItem(entries)) {
    const firstHealthIndex = Array.isArray(effectHealth) ? effectHealth.length : 0;
    results.push(await runEffects(
      services.effects,
      effectRequest(group.entries, self, target, snapshot, triggers, context, group.item),
      effectHealth
    ));
    await runEffectDeathTriggers(
      services,
      Array.isArray(effectHealth) ? effectHealth.slice(firstHealthIndex) : [],
      self, target, snapshot, context, effectHealth, deathClaims
    );
  }
  return results;
}

/** Run On Death for each unit an effect step killed, once a second check confirms the kill. It skips the body. */
async function runEffectDeathTriggers(
  services, consequences, self, target, snapshot, context, effectHealth, deathClaims
) {
  for (const consequence of consequences) {
    if (consequence.defeatStatus !== DEFEAT_STATUSES.CLAIMED) continue;
    const victim = consequence.targetActorUuid === self.actorUuid ? self
      : consequence.targetActorUuid === target.actorUuid ? target : null;
    if (!victim || deathClaims.has(victim.actorUuid)) continue;
    deathClaims.add(victim.actorUuid);
    if (!isConfirmedKill(await recheckDefeat(services, victim.actorUuid, consequence.targetTokenUuid,
      snapshot.operation))) continue;
    const other = victim.actorUuid === self.actorUuid ? target : self;
    const slainContext = { ...context, slainActorUuids: [...(context.slainActorUuids ?? []), victim.actorUuid] };
    await runGroupedEffects(
      services, victim.passiveEffects, victim, other, snapshot, ['onDeath'], slainContext, effectHealth, deathClaims
    );
  }
}

/**
 * Check each claimed defeat again, so a heal or Extra Life that landed during the effects is honoured.
 * Releasing a claim writes the unit's Token, so that write saves undo data on the attack's operation.
 */
export async function revalidateEffectDefeats(services, consequences, startIndex, operation = null) {
  for (let index = Math.max(0, startIndex); index < consequences.length; index += 1) {
    const consequence = consequences[index];
    if (consequence.defeatStatus !== DEFEAT_STATUSES.CLAIMED) continue;
    consequences[index] = Object.freeze({
      ...consequence,
      defeatStatus: await recheckDefeat(services, consequence.targetActorUuid, consequence.targetTokenUuid, operation)
    });
  }
}

/**
 * Re-read one claimed defeat. SURVIVED means a heal brought the unit back above 0 HP. A failed re-check logs a
 * warning and also counts as SURVIVED.
 */
async function recheckDefeat(services, actorUuid, tokenUuid, operation = null) {
  const status = await services.settlement.defeatStatus(actorUuid, tokenUuid, { operation });
  if (status?.ok === true && status.status) return status.status;
  recordDiagnostic(services.diagnostics, {
    sourcePath: import.meta.url,
    severity: DIAGNOSTIC_SEVERITIES.WARNING,
    detail: `Defeat re-check for ${actorUuid} failed (${status?.code ?? 'no status'}); counted as survived`,
    notify: false
  });
  return DEFEAT_STATUSES.SURVIVED;
}

/** Add the turn slots each restoreAction step in `results` gave back to `restores`. */
export function collectRestores(results, restores) {
  if (!Array.isArray(restores)) return;
  const collect = outcomes => {
    for (const outcome of outcomes) {
      if (Array.isArray(outcome?.refreshed)) restores.push(...outcome.refreshed);
      if (Array.isArray(outcome?.outcomes)) collect(outcome.outcomes);
    }
  };
  for (const result of results ?? []) collect(result?.outcomes ?? []);
}

/** The units the attack's blows and effects killed, after each defeat's second check. postCombat effects skip them. */
export function exchangeSlain(transcript, effectHealth) {
  return [...new Set([...transcript, ...effectHealth]
    .filter(record => isConfirmedKill(record.defeatStatus))
    .map(record => record.targetActorUuid))];
}

/** Whether effect damage recorded after `startIndex` ended the exchange: a unit was defeated or spent an Extra Life. */
export function effectEndedExchange(consequences, startIndex) {
  return consequences.slice(Math.max(0, startIndex)).some(consequence => defeatEndsExchange(consequence.defeatStatus));
}

function groupEntriesByItem(entries = []) {
  const groups = [];
  const byUuid = new Map();
  for (const entry of entries) {
    const uuid = String(entry?.sourceItemUuid ?? '');
    let group = byUuid.get(uuid);
    if (!group) {
      group = { item: entry?.sourceItem ?? null, entries: [] };
      byUuid.set(uuid, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

async function runEffects(effects, request, effectHealth = null) {
  if (!request.entries.length) return null;
  const result = await effects.run(request);
  if (result.outcomes.some(outcome => outcome?.ok === false)) {
    throw new CombatPersistenceError('combat.effect-settlement-failed');
  }
  if (Array.isArray(effectHealth)) collectEffectHealth(result.outcomes, effectHealth);
  return result;
}

function collectEffectHealth(outcomes, target) {
  for (const outcome of outcomes) {
    if (outcome?.health) {
      target.push(Object.freeze({
        targetActorUuid: outcome.actorUuid,
        targetTokenUuid: outcome.tokenUuid,
        result: outcome.health.change,
        amount: outcome.amount ?? outcome.health.amount,
        stanceAmount: outcome.stanceAmount ?? outcome.health.stanceAmount,
        stanceBreak: outcome.stanceBreak ?? null,
        defeatStatus: outcome.defeatStatus ?? null,
        extraLivesAfter: outcome.extraLivesAfter,
        health: outcome.health
      }));
    }
    if (Array.isArray(outcome?.outcomes)) collectEffectHealth(outcome.outcomes, target);
  }
}

/* -------------------------------------------- */
/*  Stance Break                                */
/* -------------------------------------------- */

/**
 * Apply or clear Stance Break after a strike, from a fresh read of the unit (resolveStanceBreak), and retry when the
 * write finds the unit changed. Its effect writes save undo data on the attack's operation.
 */
export async function settleCombatStance(stances, actorUuid, operation = null) {
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const snapshot = await stances.getSnapshot(actorUuid);
    if (!snapshot) return null;
    const transition = resolveStanceBreak(snapshot);
    if (!transition.createBreakEffect && transition.deleteEffectIds.length === 0) {
      return Object.freeze({ outcome: transition.outcome, actorUuid, tokenUuid: snapshot.tokenUuid });
    }
    const committed = await stances.commit(snapshot, transition, { operation });
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) throw new CombatPersistenceError('combat.stance-break-settlement-failed');
    return Object.freeze({
      outcome: transition.outcome,
      actorUuid,
      actorName: snapshot.actorName,
      tokenUuid: committed.tokenUuid ?? snapshot.tokenUuid
    });
  }
  throw new StaleCombatError();
}

/** Keep a Stance Break that was applied or cleared, for publishStanceBreaks at the end of the exchange. */
export function recordStanceBreak(records, result) {
  if ([STANCE_BREAK_OUTCOMES.APPLIED, STANCE_BREAK_OUTCOMES.CLEARED].includes(result?.outcome)
    && result.actorUuid) records.push(Object.freeze({
    ...result,
    presented: result.presented === true
  }));
}

/** Start a strike's impact presentation and, for a new Stance Break, its break animation at the same time. */
export async function presentCombatImpact(services, records, stanceBreak, message) {
  const impactPresentation = presentSafely(services, message);
  if (stanceBreak?.outcome !== STANCE_BREAK_OUTCOMES.APPLIED || !stanceBreak.tokenUuid) {
    recordStanceBreak(records, stanceBreak);
    return impactPresentation;
  }
  const breakPresentation = presentSafely(services, Object.freeze({
    kind: STANCE_BREAK_PRESENTATION_KIND,
    tokenUuid: stanceBreak.tokenUuid
  }));
  const [impactPresented, breakPresented] = await Promise.all([impactPresentation, breakPresentation]);
  recordStanceBreak(records, { ...stanceBreak, presented: breakPresented });
  return impactPresented;
}

/**
 * Publish the attack's Stance Break events straight away (they are not held until the command commits), and play
 * the break animation for any applied break that presentCombatImpact didn't already show.
 */
export async function publishStanceBreaks(services, records, context) {
  for (const result of records) {
    const eventId = result.outcome === STANCE_BREAK_OUTCOMES.APPLIED
      ? EVENT_IDS.STANCE_BREAK_APPLIED : EVENT_IDS.STANCE_BREAK_CLEARED;
    services.events.publish(eventId, {
      actorUuid: result.actorUuid,
      actorName: result.actorName,
      tokenUuid: result.tokenUuid,
      outcome: result.outcome,
      requestId: context.requestId,
      userId: context.userId
    });
    if (result.outcome === STANCE_BREAK_OUTCOMES.APPLIED && result.tokenUuid && result.presented !== true) {
      await presentSafely(services, Object.freeze({
        kind: STANCE_BREAK_PRESENTATION_KIND,
        tokenUuid: result.tokenUuid
      }));
    }
  }
}

/* -------------------------------------------- */
/*  Defeat and progression                      */
/* -------------------------------------------- */

/**
 * Finish every defeat the attack's blows and effect steps claimed through the shared defeat pipeline.
 * The defeat event takes its faction from the attack's opening read, since the Token is gone by then; a unit that
 * is neither the attacker nor the target gets the target's faction. The loot drop, the Token removal and the
 * defeat event are all part of the attack's command, so the event waits for it to commit.
 */
export async function settleDefeatPresentations(services, transcript, initial, context) {
  const defeats = new Map();
  for (const blow of transcript) {
    if (blow.defeatStatus) defeats.set(blow.targetActorUuid, blow);
  }
  const pipeline = {
    defeats: {
      revalidateDefeat: (actorUuid, tokenUuid, options) =>
        services.settlement.defeatStatus(actorUuid, tokenUuid, options),
      finishDefeat: (actorUuid, tokenUuid, options) =>
        services.settlement.finishDefeat(actorUuid, tokenUuid, options)
    },
    objects: services.objects,
    presentation: services.presentation,
    events: services.events,
    wait: services.wait,
    diagnostics: services.diagnostics
  };
  for (const blow of defeats.values()) {
    const targetWasSource = blow.targetActorUuid === initial.sourceActorUuid;
    const tokenUuid = blow.targetTokenUuid
      ?? (targetWasSource ? initial.sourceTokenUuid : initial.targetTokenUuid);
    await settleClaimedDefeat(pipeline, {
      actorUuid: blow.targetActorUuid,
      tokenUuid,
      actorType: String((targetWasSource ? initial.source : initial.target)?.actorType ?? ''),
      defeatStatus: blow.defeatStatus,
      extraLivesAfter: blow.extraLivesAfter
    }, { requestId: context.requestId, userId: context.userId, operation: context.operation ?? null });
  }
}

/**
 * Award both sides' level XP from the map as it stands after the blows. A slain side earns nothing, and an attack
 * on a Destructible earns no XP.
 */
export async function settleCombatExperience(progression, snapshot, defeat, defenderCouldCounterAtStart) {
  if (snapshot.target.destructible === true) {
    return { ok: true, settlements: [] };
  }
  const sourceSlain = defeat.sourceDefeated;
  const targetSlain = defeat.targetDefeated;
  const sourceExperience = !sourceSlain && earnsCharacterExperience(snapshot.source.actorType)
    ? computeAttackExperience(snapshot.source.level, snapshot.target.level, targetSlain, {
      opponentIsBoss: snapshot.target.actorType === 'Boss',
      isInitiator: true,
      opponentCouldCounter: defenderCouldCounterAtStart
    }) : 0;
  const targetExperience = !targetSlain && earnsCharacterExperience(snapshot.target.actorType)
    ? computeAttackExperience(snapshot.target.level, snapshot.source.level, sourceSlain, {
      opponentIsBoss: snapshot.source.actorType === 'Boss',
      isInitiator: false,
      opponentCouldCounter: true
    }) : 0;
  return progression.settleCombatExperience({
    operation: snapshot.operation,
    awards: [
      { actorUuid: snapshot.source.actorUuid, experience: sourceExperience, side: 'source' },
      { actorUuid: snapshot.target.actorUuid, experience: targetExperience, side: 'target' }
    ]
  });
}

/** Publish and present each written XP award in turn, each after COMBAT_EXCHANGE_TIMING.experienceLeadIn. */
export async function publishCombatExperience(progression, settlement, context, wait) {
  if (!settlement.settlements.length) return true;
  for (const entry of settlement.settlements) {
    await wait(COMBAT_EXCHANGE_TIMING.experienceLeadIn);
    await progression.publishCombatExperience({ settlements: [entry], context });
  }
  return true;
}

/* -------------------------------------------- */
/*  Committed events and continuation           */
/* -------------------------------------------- */

/**
 * Hand the exchange's damage events and its "exchange committed" event to the exchange's operation.
 * FoundryEventPublisher (foundry/adapters/services/committed-events.mjs) holds them until CommandDispatcher commits
 * that operation and drops them when it restores instead, so a subscriber such as the Enemy AI, which writes its
 * aggression marks from "exchange committed", never hears of an exchange that was undone.
 */
export function eventsAfterCommit(events, outcome, transcript, effectHealth = [], operation = null) {
  for (const blow of transcript) {
    if (blow.result === 'miss') continue;
    events.publish(EVENT_IDS.ACTOR_DAMAGED, { ...blow, requestId: outcome.requestId, userId: outcome.userId },
      { operation });
  }
  for (const consequence of effectHealth) {
    if (consequence.result !== HEALTH_CHANGE_TYPES.DAMAGE) continue;
    events.publish(EVENT_IDS.ACTOR_DAMAGED, {
      ...consequence,
      requestId: outcome.requestId,
      userId: outcome.userId
    }, { operation });
  }
  events.publish(EVENT_IDS.COMBAT_EXCHANGE_COMMITTED, outcome, { operation });
}

/** Apply the end of turn the attack saved as pending on the attacker, once its last animation has played. */
export async function settleDeferredEndTurn(services, outcome, operation = null) {
  if (outcome.continuation.kind !== COMBAT_CONTINUATIONS.END_TURN || outcome.sourceDefeated) return true;
  const snapshot = await services.combatState.getContinuationSnapshot(outcome.sourceTokenUuid);
  if (!snapshot
    || snapshot.continuationPending !== COMBAT_CONTINUATIONS.END_TURN
    || snapshot.continuationRequestId !== outcome.requestId) return false;
  if (!await services.settlement.settlePendingContinuation(snapshot, outcome.continuation, operation)) {
    throw new CombatPersistenceError('combat.deferred-end-turn-failed');
  }
  return true;
}
