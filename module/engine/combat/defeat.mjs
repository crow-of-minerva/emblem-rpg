/** @layer engine/combat */
import { EVENT_IDS } from '../../contracts/events.mjs';
import {
  DEFEAT_PRESENTATION_KIND,
  DEFEAT_PRESENTATION_TIMING,
  DEFEAT_PRESENTATION_TYPES,
  DEFEAT_STATUSES
} from '../../contracts/domains/damage.mjs';
import { recordDiagnostic } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Defeat pipeline                             */
/* -------------------------------------------- */

/**
 * Finish one claimed defeat the way an attack finishes it, whatever dealt the last point of damage: recheck the
 * claim, fade the Token, drop its loot, remove it and publish the defeat. An Extra Life presents and publishes its
 * own animation and event instead. Every source of damage funnels through here. If finishing fails partway, the
 * unit stays on the map at 0 HP with its defeat pending: within an encounter the next phase change finishes it, and
 * outside one it stays.
 *
 * @param {{
 *   defeats: {revalidateDefeat: Function, finishDefeat: Function},
 *   objects: {dropDefeatedLoot: Function},
 *   presentation: {broadcast: Function},
 *   events: {publish: Function},
 *   wait: Function,
 *   diagnostics?: object|null
 * }} services The services the pipeline writes and presents through.
 * @param {{
 *   actorUuid: string, tokenUuid: string, actorName?: string, actorType?: string,
 *   defeatStatus: string|null, extraLivesAfter?: number
 * }} defeat The claim the damage write returned.
 * @param {{requestId?: string, userId?: string, operation?: *}} context Attribution and the dispatcher operation
 *   the loot drop, the Token removal and the defeat event belong to.
 * @returns {Promise<{defeatComplete: boolean, defeatStatus: string|null, presentationComplete: boolean,
 *   defeatRecoveryPending: boolean}>}
 */
export async function settleClaimedDefeat(services, defeat, context = {}) {
  const status = defeat.defeatStatus ?? null;
  const { actorUuid, tokenUuid } = defeat;
  const attribution = { requestId: context.requestId, userId: context.userId };
  const operation = context.operation ?? null;

  if (status === DEFEAT_STATUSES.EXTRA_LIFE) {
    services.events.publish(EVENT_IDS.ACTOR_EXTRA_LIFE_TRIGGERED, {
      actorUuid, tokenUuid, extraLivesAfter: defeat.extraLivesAfter, ...attribution
    });
    const presentationComplete = await presentDefeat(services, tokenUuid, DEFEAT_PRESENTATION_TYPES.EXTRA_LIFE);
    return defeatResult({ defeatStatus: status, presentationComplete });
  }
  if (status !== DEFEAT_STATUSES.CLAIMED) return defeatResult({ defeatStatus: status });

  const revalidated = await services.defeats.revalidateDefeat(actorUuid, tokenUuid, { operation });
  if (revalidated?.ok === false || revalidated?.status !== DEFEAT_STATUSES.CLAIMED) {
    return defeatResult({
      defeatComplete: revalidated?.status === DEFEAT_STATUSES.ALREADY_DEFEATED,
      defeatStatus: revalidated?.status ?? status,
      defeatRecoveryPending: revalidated?.ok === false
    });
  }

  const [fadePresented] = await Promise.all([
    presentDefeat(services, tokenUuid, DEFEAT_PRESENTATION_TYPES.FADE),
    services.wait(
      DEFEAT_PRESENTATION_TIMING.fadeLeadIn
      + DEFEAT_PRESENTATION_TIMING.fadeDuration
      + DEFEAT_PRESENTATION_TIMING.fadeSettle
    )
  ]);
  await services.objects.dropDefeatedLoot(actorUuid, tokenUuid, operation);
  const finished = await services.defeats.finishDefeat(actorUuid, tokenUuid, { operation });
  const fadeCleared = await presentDefeat(services, tokenUuid, DEFEAT_PRESENTATION_TYPES.CLEAR_FADE);
  const defeatComplete = finished?.removed === true;
  if (defeatComplete) {
    services.events.publish(EVENT_IDS.ACTOR_DEFEATED, {
      actorUuid,
      actorName: String(defeat.actorName ?? ''),
      tokenUuid,
      actorType: String(defeat.actorType ?? ''),
      ...attribution
    }, { operation });
  }
  return defeatResult({
    defeatComplete,
    defeatStatus: finished?.status ?? status,
    presentationComplete: fadePresented && fadeCleared,
    defeatRecoveryPending: finished?.ok === false
  });
}

/**
 * Finish every defeat a run of effect steps claimed, after the pause that follows a lethal blow.
 * @param {object} services See `settleClaimedDefeat`.
 * @param {ReadonlyArray<object>} defeats Claims from `collectEffectDefeats`.
 * @param {object} context See `settleClaimedDefeat`.
 * @returns {Promise<object[]>} One result per claim, in order.
 */
export async function settleEffectDefeats(services, defeats, context = {}) {
  const results = [];
  if (!defeats.length) return results;
  await services.wait(DEFEAT_PRESENTATION_TIMING.continuationDelay);
  for (const defeat of defeats) results.push(await settleClaimedDefeat(services, defeat, context));
  return results;
}

/* -------------------------------------------- */
/*  Effect outcomes                             */
/* -------------------------------------------- */

/**
 * Pick the defeat claims out of effect step outcomes, nested outcomes included. A unit hit more than once keeps
 * its latest claim, and `actorTypeOf` supplies the faction the defeat event must retain after Token removal.
 * @param {ReadonlyArray<object>} outcomes An effect run's outcomes.
 * @param {(actorUuid: string) => string} [actorTypeOf] Faction lookup by Actor.
 * @returns {object[]} Claims for `settleEffectDefeats`.
 */
export function collectEffectDefeats(outcomes, actorTypeOf = () => '') {
  const claims = new Map();
  collectInto(outcomes, claims, actorTypeOf);
  return [...claims.values()];
}

function collectInto(outcomes, claims, actorTypeOf) {
  for (const outcome of outcomes) {
    if (Array.isArray(outcome?.outcomes)) collectInto(outcome.outcomes, claims, actorTypeOf);
    if (!outcome?.health || !outcome.defeatStatus || !outcome.actorUuid) continue;
    const actorUuid = String(outcome.actorUuid);
    claims.set(actorUuid, {
      actorUuid,
      tokenUuid: String(outcome.tokenUuid ?? ''),
      actorType: String(actorTypeOf(actorUuid) ?? ''),
      defeatStatus: outcome.defeatStatus,
      extraLivesAfter: outcome.extraLivesAfter
    });
  }
}

/* -------------------------------------------- */
/*  Presentation                                */
/* -------------------------------------------- */

async function presentDefeat(services, tokenUuid, change) {
  try {
    return await services.presentation.broadcast(Object.freeze({
      kind: DEFEAT_PRESENTATION_KIND, change, tokenUuid
    })) !== false;
  } catch (diagnosticError) {
    recordDiagnostic(services.diagnostics ?? services.presentation?.diagnostics ?? null, {
      sourcePath: import.meta.url, error: diagnosticError, detail: `presentDefeat:${change}`
    });
    return false;
  }
}

function defeatResult({
  defeatComplete = false, defeatStatus = null, presentationComplete = true, defeatRecoveryPending = false
}) {
  return { defeatComplete, defeatStatus, presentationComplete, defeatRecoveryPending };
}
