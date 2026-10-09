/** @layer engine/combat/encounters */
import {
  BANNER_VARIANTS,
  ENCOUNTER_PHASES,
  OBJECTIVE_CHECK_KINDS,
  OBJECTIVE_END_OUTCOMES,
  OBJECTIVE_END_REASONS,
  OBJECTIVE_END_RECORD_VERSION,
  ROUT_FACTIONS,
  bannerPresentationMessage
} from '../../../contracts/domains/combat.mjs';
import { RESULT_CODES } from '../../../contracts/results.mjs';
import { EVENT_IDS } from '../../../contracts/events.mjs';
import {
  OBJECTIVE_END_RETRY_STATUSES,
  arrivalObjectiveSet,
  authoritativeEndReason,
  checkpointFor,
  evaluateObjectives,
  livingPlayerUnits,
  newArrivals,
  objectiveSetupWarnings,
  planObjectiveEndRetry,
  resolveObjectiveTargets,
  unaccountedRosterIds
} from '../../../game/combat/objectives.mjs';
import { planEncounterAftermath } from '../../../game/combat/phases.mjs';
import { recordDiagnostic, requirePorts } from '../../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Objective authoring                         */
/* -------------------------------------------- */

const END_BANNERS = Object.freeze({
  victory: Object.freeze({ variant: BANNER_VARIANTS.VICTORY, text: 'Map Cleared!' }),
  defeat: Object.freeze({ variant: BANNER_VARIANTS.DEFEAT, text: 'Defeat' })
});

/**
 * Save objective edits through the encounter writer and resolve current targets.
 * Retain the initial rout roster and earned progress so mid-encounter edits do not reset kills or arrivals.
 */
export async function authorObjectives(intent, services) {
  const board = await services.encounters.getObjectiveSnapshot(intent.sceneUuid);
  if (!board) return { ok: false, code: RESULT_CODES.SCENE_NOT_FOUND };
  if (board.pendingEnd?.commit) return { ok: false, code: RESULT_CODES.OBJECTIVES_END_LOCKED };

  const spec = {
    objectives: intent.objectives.map(entry => ({ ...entry })),
    roundLimit: intent.roundLimit,
    loss: { ...intent.loss, protectedUnits: [...intent.loss.protectedUnits] }
  };
  if (!await services.encounters.writeObjectiveConfig(intent.sceneUuid, spec, services.operation ?? null)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }

  const refreshed = await services.encounters.getObjectiveSnapshot(intent.sceneUuid);
  const warnings = await snapshotObjectiveTargets(refreshed, services, { resetProgress: false });
  if (refreshed?.started) await runObjectiveCheck(refreshed.sceneUuid, services, { kind: OBJECTIVE_CHECK_KINDS.IMMEDIATE });
  return { ok: true, warnings };
}

/** Resolve every authored reference to concrete units, warning about anything unsatisfiable. */
export async function snapshotObjectiveTargets(board, services, { resetProgress = false } = {}) {
  if (!board?.started) return Object.freeze([]);
  const { snapshot, unresolved } = resolveObjectiveTargets(board.units, board.spec);
  const targets = { ...snapshot };
  if (!resetProgress && board.targets.enemies.length) targets.enemies = [...board.targets.enemies];
  await services.encounters.writeObjectiveTargets(board.sceneUuid, targets,
    { resetProgress, operation: services.operation ?? null });
  const warnings = objectiveSetupWarnings(board.spec, board, unresolved);
  for (const warning of warnings) services.notify('warn', warning);
  return warnings;
}

/* -------------------------------------------- */
/*  Progress                                    */
/* -------------------------------------------- */

/**
 * Count a defeated enemy toward a rout objective, from a defeat event whose command has committed. The Token is
 * gone, so use the faction the event carries or, failing that, the enemy roster saved when the encounter began.
 * Ignore repeats and Tokens still on the map.
 */
async function recordObjectiveKill(board, trigger, services) {
  const tokenId = String(trigger.defeatedTokenId ?? '');
  if (!board?.started || !tokenId) return false;
  if (board.units.some(entry => entry.tokenId === tokenId)) return false;
  const faction = String(trigger.defeatedActorType ?? '');
  const enemy = faction ? ROUT_FACTIONS.includes(faction) : board.targets.enemies.includes(tokenId);
  if (!enemy || board.progress.kills.includes(tokenId)) return false;
  return services.encounters.writeObjectiveProgress(board.sceneUuid, {
    kills: [...board.progress.kills, tokenId],
    arrivals: [...board.progress.arrivals]
  }, services.operation ?? null);
}

/** Record every unit that newly reached an arrival point, and report which ones the write kept. */
async function recordArrivals(board, units, services) {
  const landed = newArrivals(units, board, board.progress);
  if (!landed.length) return [];
  const written = await services.encounters.writeObjectiveProgress(board.sceneUuid, {
    kills: [...board.progress.kills],
    arrivals: [...board.progress.arrivals, ...landed]
  }, services.operation ?? null);
  return written ? landed : [];
}

/**
 * Withdraw non-winning arrivals through the Foundry encounter writer after recording progress.
 * Only Arrive objectives withdraw units. Terrain markers alone never delete Tokens.
 */
async function withdrawArrivals(board, landed, services) {
  if (!landed.length || !arrivalObjectiveSet(board.spec)) return false;
  const tokenUuids = board.units
    .filter(unit => landed.includes(unit.tokenId))
    .map(unit => String(unit.tokenUuid ?? ''))
    .filter(Boolean);
  if (!tokenUuids.length) return false;
  if (await services.encounters.withdrawUnits(board.sceneUuid, tokenUuids,
    services.operation ?? null) === true) return true;
  services.notify('warn', 'A unit that reached an Arrival Point could not be taken off the map. '
    + 'Its arrival still counts. Remove the Token by hand.');
  return false;
}

/* -------------------------------------------- */
/*  Checks                                      */
/* -------------------------------------------- */

/**
 * Evaluate game/combat/objectives.mjs rules for an event and queue any encounter end.
 * Record arrivals before evaluation, then withdraw only non-winning arrivals. Turn-end checks
 * cover the acting unit, and Player Phase end checks sweep all units.
 */
export async function runObjectiveCheck(sceneUuid, services, trigger = {}) {
  let board = await services.encounters.getObjectiveSnapshot(sceneUuid);
  if (!board?.started || board.hasPendingEnd) return null;

  if (trigger.kind === OBJECTIVE_CHECK_KINDS.RECONCILE) {
    const missing = unaccountedRosterIds(board.spec, board.targets, board.progress, board);
    if (missing.length) services.notify('warn',
      `A counted rout may have lost a kill during an interruption. Check these missing roster units: ${missing.join(', ')}. No kills were added.`);
  }
  if (trigger.defeatedTokenId && await recordObjectiveKill(board, trigger, services)) {
    board = await services.encounters.getObjectiveSnapshot(sceneUuid);
  }
  let landed = [];
  if (trigger.kind === OBJECTIVE_CHECK_KINDS.TURN_END) {
    const acting = livingPlayerUnits(board.units).filter(unit => unit.actorUuid === trigger.actorUuid);
    landed = await recordArrivals(board, acting, services);
  } else if (trigger.kind === OBJECTIVE_CHECK_KINDS.PHASE_END && trigger.phase === ENCOUNTER_PHASES.PLAYER) {
    landed = await recordArrivals(board, livingPlayerUnits(board.units), services);
  }
  if (landed.length) board = await services.encounters.getObjectiveSnapshot(sceneUuid);
  if (!board?.started || board.hasPendingEnd) return null;

  const reason = evaluateObjectives(board.spec, board.targets, board.progress, board, trigger);
  if (!reason) {
    await withdrawArrivals(board, landed, services);
    return null;
  }
  return queueObjectiveEnd(board, reason, services, trigger);
}

/* -------------------------------------------- */
/*  Ending the map                              */
/* -------------------------------------------- */

/**
 * Save a pending end on the encounter instead of interrupting what is resolving now.
 *
 * This flag is real game state, not crash-recovery data: while it is set the GM can't advance, pause or re-check
 * the map. `resolveObjectiveEnd` checks the map again once the remaining XP, level-up and effect work is done;
 * foundry/hooks/scene.mjs runs that as its own command.
 */
export async function queueObjectiveEnd(board, reason, services, trigger = {}) {
  if (!board?.started || board.hasPendingEnd) return null;
  const now = services.clock();
  const request = {
    version: OBJECTIVE_END_RECORD_VERSION,
    requestId: services.identifier(),
    combatId: board.combatId,
    sceneId: board.sceneId,
    reason,
    checkpoint: checkpointFor(reason),
    fingerprint: endFingerprint(board),
    phase: board.phase ?? trigger.phase ?? '',
    round: board.round ?? null,
    roundEnded: trigger.roundEnded ?? null,
    createdAt: now,
    updatedAt: now,
    commit: null
  };
  if (!await services.encounters.writePendingEnd(board.sceneUuid, request, services.operation ?? null)) return null;
  services.events.publish(EVENT_IDS.ENCOUNTER_OBJECTIVE_END_QUEUED, {
    sceneUuid: board.sceneUuid,
    reason,
    requestId: request.requestId
  });
  return request;
}

/**
 * Finish a pending end inside a command. The decided outcome is written before it is announced,
 * then the map is torn down. Deleting the encounter is what prevents a second completion. A pause also runs
 * through this path, deleting the encounter, but leaves the map's statuses and summons for the resume.
 * @param {string} sceneUuid The map whose end is pending.
 * @param {object} services The encounter services, carrying the command's operation.
 * @param {{pausing?: boolean}} [options] Whether `pauseEncounter` is pausing the encounter rather than ending it.
 */
export async function resolveObjectiveEnd(sceneUuid, services, { pausing = false } = {}) {
  const queued = await services.encounters.getObjectiveSnapshot(sceneUuid);
  const pending = queued?.pendingEnd ?? null;
  if (!queued?.started || !pending) return { status: 'missing', requestId: '' };
  const operation = services.operation ?? null;

  let reason = pending.commit?.reason ?? null;
  if (!reason) {
    const board = await services.encounters.getObjectiveSnapshot(sceneUuid);
    if (!board?.started || board.pendingEnd?.requestId !== pending.requestId) {
      return { status: 'missing', requestId: pending.requestId };
    }
    if (pending.fingerprint !== endFingerprint(board)) {
      await services.encounters.clearPendingEnd(sceneUuid, operation);
      return { status: 'cancelled-stale', requestId: pending.requestId };
    }
    reason = declaredReason(pending)
      ?? authoritativeEndReason(board.spec, board.targets, board.progress, board, pending);
    if (!reason) {
      await services.encounters.clearPendingEnd(sceneUuid, operation);
      return { status: 'cancelled-stale', requestId: pending.requestId };
    }
    if (!await services.encounters.commitPendingEnd(sceneUuid, pending.requestId, reason, services.clock(),
      operation)) {
      return { status: 'commit-contended', requestId: pending.requestId };
    }
  }

  if (!await completeTeardown(sceneUuid, services, { pausing })) {
    return { status: 'teardown-failed', requestId: pending.requestId };
  }
  if (!await services.encounters.deleteEncounter(sceneUuid, operation)) {
    return { status: 'teardown-failed', requestId: pending.requestId };
  }
  await announceOutcome(reason, services);
  services.events.publish(EVENT_IDS.ENCOUNTER_OBJECTIVE_END_COMMITTED, {
    sceneUuid,
    reason,
    requestId: pending.requestId
  });
  return { status: 'ended', reason, requestId: pending.requestId };
}

/**
 * Finish timed-terrain cleanup before the encounter writer deletes its record, and on a real end make every kept
 * retractable item use final and clear the encounter's aftermath too. Use the requested Scene, including off-canvas
 * scenes. A successful no-op is not a cleanup failure.
 * @param {string} sceneUuid The Scene whose encounter is ending or pausing.
 * @param {object} services The encounter services.
 * @param {{pausing?: boolean}} [options] Whether the encounter is only being paused.
 * @returns {Promise<boolean>} Whether every required cleanup landed.
 */
async function completeTeardown(sceneUuid, services, { pausing = false } = {}) {
  const operation = services.operation ?? null;
  const reverted = await services.terrain.revertTimedEdits(sceneUuid, operation);
  if (reverted.ok !== true) return false;
  if (!pausing && await services.encounters.commitRetractions(sceneUuid, operation) !== true) return false;
  if (!pausing && !await clearAftermath(sceneUuid, services)) return false;
  return await services.encounters.clearPhase(sceneUuid, operation) === true;
}

/**
 * The one cleanup every ending shares, whether an objective decided it or the GM ended the map: every Guard bond
 * breaks, every status the map's units wear goes, every unit's record of the Rallies it cast this map clears, and
 * every summoned Token leaves, all through FoundryEncounterRepository under the ending command's operation, so a
 * refused end puts them back. Which effects count as statuses is `isEncounterStatus` in game/effects/statuses.mjs.
 */
async function clearAftermath(sceneUuid, services) {
  const board = await services.encounters.getAftermathSnapshot?.(sceneUuid);
  if (!board) return true;
  const plan = planEncounterAftermath(board.units);
  if (!plan.bondedTokenUuids.length && !plan.statuses.length && !plan.ralliedActorUuids.length
    && !plan.summonTokenUuids.length) return true;
  return await services.encounters.clearEncounterAftermath(sceneUuid, plan, services.operation ?? null) === true;
}

/* -------------------------------------------- */
/*  Retries and outcome banners                 */
/* -------------------------------------------- */

/** Notification text used when createObjectiveEndRetries reaches its retry limit. */
const OBJECTIVE_END_GIVE_UP_MESSAGE =
  'The encounter could not finish while the board was busy. End it from the encounter controls when it is free.';

/**
 * Retry pending ends using game/combat/objectives.mjs retry timing.
 * After the attempt limit, the queued end stays on the encounter and the table is told it needs the GM.
 * @param {{wait: Function, run: Function, notify: Function}} ports The delay, the rerun of the end, the warning.
 */
export function createObjectiveEndRetries({ wait, run, notify }) {
  requirePorts('createObjectiveEndRetries', { wait, run, notify });
  const outstanding = new Map();
  return Object.freeze({
    clear(sceneUuid) { outstanding.delete(sceneUuid); },
    async scheduleRetry(sceneUuid, requestId, status) {
      if (!OBJECTIVE_END_RETRY_STATUSES.includes(status)) { outstanding.delete(sceneUuid); return false; }
      const previous = outstanding.get(sceneUuid);
      const attempts = (previous?.requestId === requestId ? previous.attempts : 0) + 1;
      const plan = planObjectiveEndRetry(attempts);
      if (!plan.retry) {
        outstanding.delete(sceneUuid);
        notify('warn', OBJECTIVE_END_GIVE_UP_MESSAGE);
        return false;
      }
      outstanding.set(sceneUuid, { requestId, attempts });
      await wait(plan.delayMs);
      const current = outstanding.get(sceneUuid);
      if (current?.requestId !== requestId || current.attempts !== attempts) return false;
      await run(sceneUuid);
      return true;
    }
  });
}

/** Announce the map's outcome to every client, or nothing at all for a plain stop. */
export async function announceOutcome(reason, services) {
  const banner = END_BANNERS[OBJECTIVE_END_OUTCOMES[reason] ?? 'none'];
  if (!banner) return false;
  try {
    await services.presentation(bannerPresentationMessage(banner.variant, banner.text));
    return true;
  } catch (diagnosticError) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'announceOutcome' });
    return false;
  }
}

/* -------------------------------------------- */
/*  Local helpers                               */
/* -------------------------------------------- */

function declaredReason(pending) {
  return [
    OBJECTIVE_END_REASONS.DECLARED_VICTORY,
    OBJECTIVE_END_REASONS.DECLARED_DEFEAT,
    OBJECTIVE_END_REASONS.DECLARED_STOP
  ].includes(pending.reason) ? pending.reason : null;
}

/**
 * Fingerprint objective definitions and resolved targets for resolveObjectiveEnd.
 * Exclude live condition values, which game/combat/objectives.mjs checks again when the end is resolved.
 */
function endFingerprint(board) {
  return JSON.stringify({
    spec: board.spec,
    targets: board.targets,
    points: Object.entries(board.terrainGrid ?? {})
      .filter(([, entry]) => entry?.objectivePoint)
      .map(([key, entry]) => `${key}:${entry.objectivePoint}`)
      .sort()
  });
}
