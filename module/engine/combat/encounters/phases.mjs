/** @layer engine/combat/encounters */
import {
  BANNER_VARIANTS,
  ENCOUNTER_DECAY_FLAGS,
  ENCOUNTER_PHASE_TIMING,
  ENCOUNTER_PHASES,
  OBJECTIVE_CHECK_KINDS,
  OBJECTIVE_FLAGS,
  OBJECTIVE_END_REASONS,
  bannerPresentationMessage,
  phaseCameraPresentationMessage
} from '../../../contracts/domains/combat.mjs';
import { RESULT_CODES } from '../../../contracts/results.mjs';
import { DAMAGE_POLICIES, DEFEAT_STATUSES } from '../../../contracts/domains/damage.mjs';
import { collectEffectDefeats, settleClaimedDefeat, settleEffectDefeats } from '../defeat.mjs';
import { clampTickDamage, planPhaseStartTicks, planStatusTicks } from '../../../game/effects/statuses.mjs';
import {
  nextEncounterPhase,
  phaseCameraGroups,
  phaseParticipants,
  phaseRosterProgress,
  planPausedEncounter,
  planPhaseTurnUpdates,
  planRallyRecordReset,
  planSummonExpiry
} from '../../../game/combat/phases.mjs';
import {
  announceOutcome,
  queueObjectiveEnd,
  resolveObjectiveEnd,
  runObjectiveCheck,
  snapshotObjectiveTargets
} from './objectives.mjs';
import { effectContext, effectRuntime } from '../../effects/request.mjs';
import { recordDiagnostic } from '../../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Encounter lifecycle                         */
/* -------------------------------------------- */

/** Create the one Scene-linked encounter, leaving it unstarted for the GM to set up. */
export async function createEncounter(snapshot, services) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board) return { ok: false, code: RESULT_CODES.SCENE_NOT_FOUND };
  if (board.gridless) return { ok: false, code: RESULT_CODES.ENCOUNTER_GRID_REQUIRED };
  if (board.combatId) {
    // This refusal is there to show the GM the encounter they already have, so the activation is kept out of the
    // command's undo data and stays when the command refuses.
    await services.encounters.activateEncounter?.(snapshot.sceneUuid);
    return { ok: false, code: RESULT_CODES.ENCOUNTER_ALREADY_RUNNING };
  }
  if (!await services.encounters.createEncounter(snapshot.sceneUuid, services.operation ?? null)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  return { ok: true, phase: '', round: 0 };
}

/**
 * Start the encounter through FoundryEncounterRepository and reset participant turns.
 * A new encounter resolves its objective targets once and clears the map's Rally records. A resumed one keeps its
 * saved roster, progress and Rally records.
 * A new encounter then opens its first Player Phase's passives, which a resumed one ran before it was paused.
 * Creating and starting the Combat write through `context.operation` like every later stage, so a refusal here or
 * a host reload before the command commits leaves the map with the encounter it had, started or not.
 */
export async function beginEncounter(snapshot, services, { restore = null } = {}) {
  if (snapshot.phase) return { ok: false, code: RESULT_CODES.ENCOUNTER_ALREADY_RUNNING };
  let board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board) return { ok: false, code: RESULT_CODES.SCENE_NOT_FOUND };
  if (board.otherRunningSceneUuid) return { ok: false, code: RESULT_CODES.ENCOUNTER_OTHER_RUNNING };
  if (board.gridless) return { ok: false, code: RESULT_CODES.ENCOUNTER_GRID_REQUIRED };
  const operation = services.operation ?? null;
  if (!board.combatId && !await services.encounters.createEncounter(snapshot.sceneUuid, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  if (!await services.encounters.startEncounter(snapshot.sceneUuid, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  await services.encounters.setExploration(snapshot.sceneUuid, false, operation);

  const phase = ENCOUNTER_PHASES.PLAYER;
  if (!await services.encounters.setPhase(snapshot.sceneUuid, phase, 1, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!await restoreObjectiveState(snapshot.sceneUuid, board, restore, services)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  await services.terrain.resetSpawnState(snapshot.sceneUuid, operation);
  if (!restore && !await clearRallyRecords(snapshot.sceneUuid, services)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  if (!await applyPhaseTurns(snapshot, phase, services, { encounterStart: true })) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  await announceBanner(services, BANNER_VARIANTS.GENERIC, 'Combat Start!');
  if (!restore) {
    const opened = await openFirstPhase(snapshot.sceneUuid, phase, services);
    if (opened.ok !== true) return opened;
  }
  return { ok: true, phase, round: 1 };
}

/**
 * Run the first Player Phase's onPhaseBegin passives, as `openIncomingPhase` runs them at every later opening, from
 * a fresh read of the map once the turns are set. Phase-begin decay does not run here: no phase has passed inside the
 * encounter yet, so a status a unit carried in keeps its full count.
 */
async function openFirstPhase(sceneUuid, phase, services) {
  const context = { sceneUuid, services, incoming: phase, opening: null };
  const opening = await openingSnapshot(context);
  if (!opening) return TRANSITION_FAILED;
  const opened = phaseParticipants(opening.units, phase)
    .filter(unit => (unit.passiveEntries ?? []).some(entry => entry?.trigger === 'onPhaseBegin'));
  if (!opened.length) return TRANSITION_OK;
  await services.wait(ENCOUNTER_PHASE_TIMING.bannerHold);
  for (const unit of opened) {
    const passives = await settleUnitPassive(unit, 'onPhaseBegin', opening, context);
    if (!passives.ok) return passives;
  }
  return TRANSITION_OK;
}

/**
 * Clear the records of the Rallies each unit on the map cast before this encounter (planRallyRecordReset), through
 * FoundryEncounterRepository.clearRallyRecords under the starting command's operation, so every caster's per-unit
 * limits start fresh. A resumed encounter keeps them, as its pause cleared nothing.
 */
async function clearRallyRecords(sceneUuid, services) {
  const board = await services.encounters.getAftermathSnapshot?.(sceneUuid);
  const actorUuids = planRallyRecordReset(board?.units ?? []);
  if (!actorUuids.length) return true;
  return await services.encounters.clearRallyRecords(actorUuids, services.operation ?? null) === true;
}

/** Discard an encounter that has not started, the undo for encounter setup. */
export async function cancelEncounter(snapshot, services) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board?.combatId) return { ok: false, code: RESULT_CODES.ENCOUNTER_MISSING };
  if (board.started) return { ok: false, code: RESULT_CODES.ENCOUNTER_ALREADY_RUNNING };
  if (!await services.encounters.deleteEncounter(snapshot.sceneUuid, services.operation ?? null)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  return { ok: true, phase: '', round: 0 };
}

/**
 * Turn the phase over in one command. Every stage writes through `context.operation`, so a refusal or a host reload
 * before the command commits puts the map back where Advance found it and the GM simply advances again.
 */
export async function advanceEncounterPhase(snapshot, services, intent = {}) {
  if (!snapshot.phase) return { ok: false, code: RESULT_CODES.ENCOUNTER_NOT_RUNNING };
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  const stale = staleAdvance(intent.expected, board);
  if (stale) return stale;
  if (board?.hasPendingEnd) return { ok: false, code: RESULT_CODES.OBJECTIVES_END_LOCKED };
  return settlePhaseTransition(openTransitionContext(snapshot, services));
}

/**
 * Refuse an advance named against an encounter, phase or round the map no longer shows.
 * @param {{combatId: string, phase: string, round: number}|null|undefined} expected What the caller saw.
 * @param {object|null} board The objective state as just read.
 * @returns {object|null} A stale refusal, or null when nothing was named or everything named still stands.
 */
function staleAdvance(expected, board) {
  if (!expected) return null;
  const current = Object.freeze({
    combatId: String(board?.combatId ?? ''),
    phase: String(board?.phase ?? ''),
    round: Number(board?.round) || 0
  });
  const standing = current.combatId === expected.combatId && current.phase === expected.phase
    && current.round === expected.round;
  if (standing) return null;
  return {
    ok: false,
    code: RESULT_CODES.ENCOUNTER_ADVANCE_STALE,
    data: { expected, current }
  };
}

/**
 * Persist a GM-requested ending through queueObjectiveEnd so every end runs the same teardown. `pausing` is set
 * only by `pauseEncounter`, whose teardown keeps the map's statuses and summons for the resume.
 */
export async function endEncounter(snapshot, services, intent = {}, { pausing = false } = {}) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board?.combatId) return { ok: false, code: RESULT_CODES.ENCOUNTER_MISSING };
  const reason = DECLARED_REASONS[intent.outcome ?? 'none'];

  if (!board.started) {
    if (!await services.encounters.deleteEncounter(snapshot.sceneUuid, services.operation ?? null)) {
      return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
    }
    await announceOutcome(reason, services);
    return { ok: true, phase: '', round: snapshot.round };
  }

  if (!board.hasPendingEnd && !await queueObjectiveEnd(board, reason, services)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  const resolution = await resolveObjectiveEnd(snapshot.sceneUuid, services, { pausing });
  if (resolution.status !== 'ended') return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  return { ok: true, phase: '', round: snapshot.round };
}

/**
 * Save the paused round, objective state and auto-advance switch before Foundry encounter teardown removes their
 * live records. Remove the pause record if ending refuses. An encounter with a pending outcome cannot be paused.
 * Units keep their statuses and summons across the pause.
 */
export async function pauseEncounter(snapshot, services) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board?.combatId) return { ok: false, code: RESULT_CODES.ENCOUNTER_MISSING };
  if (!board.started) return { ok: false, code: RESULT_CODES.ENCOUNTER_NOT_RUNNING };
  if (board.hasPendingEnd) return { ok: false, code: RESULT_CODES.OBJECTIVES_END_LOCKED };
  const record = planPausedEncounter({
    round: board.round ?? snapshot.round,
    phase: board.phase ?? snapshot.phase,
    pausedAt: services.clock(),
    targets: board.targets,
    progress: board.progress,
    autoAdvance: board.autoAdvance
  });
  const operation = services.operation ?? null;
  if (!await services.encounters.writePausedEncounter(snapshot.sceneUuid, record, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  const ended = await endEncounter(snapshot, services, {}, { pausing: true });
  if (ended.ok !== true) {
    await services.encounters.clearPausedEncounter(snapshot.sceneUuid, operation);
    return ended;
  }
  return { ok: true, phase: '', round: record.round };
}

/**
 * Open a paused map again with its round, its target roster, its objective progress and its auto-advance switch.
 * The saved phase is not restored: it always reopens on the Player Phase of the saved round, and both sides' turns
 * refill as at the start of an encounter. beginEncounter creates a new Combat, which would read auto-advance as on,
 * so the paused record's switch is written onto it before the pause record is cleared.
 */
export async function resumeEncounter(snapshot, services) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board) return { ok: false, code: RESULT_CODES.SCENE_NOT_FOUND };
  if (!board.paused) return { ok: false, code: RESULT_CODES.ENCOUNTER_PAUSE_MISSING };
  if (board.combatId) return { ok: false, code: RESULT_CODES.ENCOUNTER_ALREADY_RUNNING };
  const round = board.paused.round;
  const operation = services.operation ?? null;
  const began = await beginEncounter(snapshot, services, { restore: board.paused });
  if (began.ok !== true) return began;
  if (!await services.encounters.setEncounterFlag(snapshot.sceneUuid, OBJECTIVE_FLAGS.AUTO_ADVANCE,
    board.paused.autoAdvance, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  if (!await services.encounters.setPhase(snapshot.sceneUuid, began.phase, round, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  if (!await services.encounters.clearPausedEncounter(snapshot.sceneUuid, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  return { ok: true, phase: began.phase, round };
}

/** Throw a paused encounter away. Once an encounter is paused, this is the only way to end it. */
export async function discardPausedEncounter(snapshot, services) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board) return { ok: false, code: RESULT_CODES.SCENE_NOT_FOUND };
  if (!board.paused) return { ok: false, code: RESULT_CODES.ENCOUNTER_PAUSE_MISSING };
  if (!await services.encounters.clearPausedEncounter(snapshot.sceneUuid, services.operation ?? null)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  return { ok: true, phase: '', round: 0 };
}

/** Store the phase-music switch, so a GM can silence one battle without rescoring the map. */
export async function setCombatMusic(snapshot, services, intent = {}) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board?.combatId) return { ok: false, code: RESULT_CODES.ENCOUNTER_MISSING };
  if (!await services.encounters.setEncounterFlag(snapshot.sceneUuid, OBJECTIVE_FLAGS.COMBAT_MUSIC, intent.enabled,
    services.operation ?? null)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  return { ok: true, phase: board.phase ?? '', round: board.round ?? snapshot.round };
}

/** Store the automatic-advance switch, which decides whether a finished side turns the phase over. */
export async function setAutoAdvance(snapshot, services, intent = {}) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board?.combatId) return { ok: false, code: RESULT_CODES.ENCOUNTER_MISSING };
  if (!await services.encounters.setEncounterFlag(snapshot.sceneUuid, 'autoAdvance', intent.enabled,
    services.operation ?? null)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  return { ok: true, phase: board.phase ?? '', round: board.round ?? snapshot.round };
}

/**
 * Set the round a running encounter is on. The phase and every unit's turn stay as they are, so the correction
 * starts no phase and ticks nothing; the next round's deadline check reads the new count.
 */
export async function setEncounterRound(snapshot, services, intent = {}) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board?.combatId) return { ok: false, code: RESULT_CODES.ENCOUNTER_MISSING };
  if (!board.started || !snapshot.phase) return { ok: false, code: RESULT_CODES.ENCOUNTER_NOT_RUNNING };
  if (!await services.encounters.setPhase(snapshot.sceneUuid, snapshot.phase, intent.round,
    services.operation ?? null)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  return { ok: true, phase: snapshot.phase, round: intent.round };
}

const DECLARED_REASONS = Object.freeze({
  victory: OBJECTIVE_END_REASONS.DECLARED_VICTORY,
  defeat: OBJECTIVE_END_REASONS.DECLARED_DEFEAT,
  none: OBJECTIVE_END_REASONS.DECLARED_STOP
});

/* -------------------------------------------- */
/*  Phase transition                            */
/* -------------------------------------------- */

const TRANSITION_OK = Object.freeze({ ok: true });
const TRANSITION_FAILED = Object.freeze({ ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED });
const TRANSITION_STALE = Object.freeze({ ok: false, code: RESULT_CODES.ENCOUNTER_STALE });

/** The working state of one phase change. Stages add their fresh reads of the map to it. */
function openTransitionContext(snapshot, services) {
  const transition = nextEncounterPhase(snapshot.phase, snapshot.round);
  return {
    sceneUuid: snapshot.sceneUuid,
    snapshot,
    services,
    outgoing: transition.outgoing,
    outgoingRound: snapshot.round,
    incoming: transition.incoming,
    round: transition.round,
    expiry: null,
    opening: null
  };
}

/** The stages one phase change runs, in order, each a plain step of the same command. */
const TRANSITION_STAGES = Object.freeze([
  closeOutPhase,
  checkOutgoingObjectives,
  fireOutgoingSpawns,
  expireOutgoingTerrain,
  expireOutgoingSummons,
  writeIncomingPhase,
  armIncomingTurns,
  openIncomingPhase,
  settleIncomingTicks,
  stopAutoAdvanceOnEmptyEnemyPhase
]);

/**
 * Finish any half-done defeats and save undo data for what the whole change will write, then run every stage in
 * order, recording newly placed actors before each.
 * checkOutgoingObjectives may decide the encounter is over. Its writes stand, so the change accepts under
 * OBJECTIVES_END_QUEUED without writing the incoming phase, and foundry/hooks/scene.mjs resolves the queued end as
 * its own command.
 */
async function settlePhaseTransition(context) {
  const { services, incoming, round, outgoing } = context;
  if (!await finishStrandedDefeats(context)) return TRANSITION_FAILED;
  if (!await capturePhaseOpening(context)) return TRANSITION_FAILED;
  for (const stage of TRANSITION_STAGES) {
    if (!await services.holdsPlacedActors()) return TRANSITION_STALE;
    const outcome = await stage(context);
    if (outcome.queued === true) {
      return { ok: true, code: RESULT_CODES.OBJECTIVES_END_QUEUED, phase: outgoing, round: context.outgoingRound };
    }
    if (outcome.ok !== true) return outcome;
  }
  return { ok: true, phase: incoming, round, previousPhase: outgoing };
}

/**
 * Finish a defeat an earlier command left half done: a unit still on the board at 0 HP whose Token still has its
 * defeat pending, for example because removing the Token failed. Damage can't defeat a unit already at 0 HP, so
 * nothing else would remove it. A unit at 0 HP with no pending defeat is left alone. A failure here is recorded and
 * the phase change goes on, and the next change tries again.
 */
async function finishStrandedDefeats(context) {
  const { services, snapshot } = context;
  const fallen = (snapshot.units ?? []).filter(unit => unit.tokenUuid && !(Number(unit.hp) > 0));
  if (!fallen.length) return true;
  const pipeline = {
    defeats: services.defeats,
    objects: services.objects,
    presentation: { broadcast: message => services.presentation(message) },
    events: services.events,
    wait: services.wait,
    diagnostics: services.diagnostics
  };
  const attribution = {
    requestId: String(services.requestId ?? ''),
    userId: String(services.userId ?? ''),
    operation: services.operation ?? null
  };
  for (const unit of fallen) {
    try {
      await settleClaimedDefeat(pipeline, {
        actorUuid: unit.actorUuid,
        tokenUuid: unit.tokenUuid,
        actorName: unit.actorName,
        actorType: unit.actorType,
        defeatStatus: DEFEAT_STATUSES.CLAIMED
      }, attribution);
    } catch (diagnosticError) {
      recordDiagnostic(services?.diagnostics, {
        sourcePath: import.meta.url, error: diagnosticError, detail: 'finishStrandedDefeats'
      });
    }
  }
  // The later stages read this board, so drop any unit the sweep removed.
  context.snapshot = await services.encounters.getSnapshot(context.sceneUuid);
  return Boolean(context.snapshot);
}

/**
 * Before writing anything, save undo data for the Scene's phase, round and the timed terrain the expiry will
 * rewrite, plus every unit's turn. Health, effect, spawn and defeat writers, and the summon expiry, save their own
 * undo data right before they write.
 */
async function capturePhaseOpening(context) {
  const { services, sceneUuid, snapshot, outgoing } = context;
  context.expiry = await services.terrain.projectTimedExpiry(sceneUuid, outgoing);
  if (context.expiry.ok !== true) return false;
  return await services.encounters.capturePhaseChange(sceneUuid, {
    operation: services.operation ?? null,
    actorUuids: (snapshot.units ?? []).map(unit => String(unit.actorUuid)),
    terrain: context.expiry
  }) !== false;
}

/** Read the map again once the incoming phase is written, and keep that read for every opening stage. */
async function openingSnapshot(context) {
  context.opening ??= await context.services.encounters.getSnapshot(context.sceneUuid);
  return context.opening;
}

/* -------------------------------------------- */
/*  Closing stages                              */
/* -------------------------------------------- */

/** What an outgoing unit decays as its phase ends: its own phase-end effects and those that end with any phase. */
const OUTGOING_DECAY_FLAGS = Object.freeze([ENCOUNTER_DECAY_FLAGS.PHASE_END, ENCOUNTER_DECAY_FLAGS.ANY_PHASE_END]);

/**
 * Every unit outside the outgoing side first sheds the effects that end with any phase, read from the map as the
 * change found it, before any phase-end passive writes. The outgoing side then decays both kinds in one plan and runs
 * its onPhaseEnd passives, unit by unit, each unit's decay planned from its effects as they stand after the passives
 * before it. An Actor standing behind several Tokens decays once.
 */
async function closeOutPhase(context) {
  const { snapshot, outgoing } = context;
  const participants = phaseParticipants(snapshot.units, outgoing);
  const decayed = new Set(participants.map(unit => unit.actorUuid));
  for (const unit of snapshot.units ?? []) {
    if (decayed.has(unit.actorUuid)) continue;
    decayed.add(unit.actorUuid);
    if (!await settleUnitDecay(unit, ENCOUNTER_DECAY_FLAGS.ANY_PHASE_END, context)) return TRANSITION_FAILED;
  }
  const board = decayBoard(snapshot);
  const outgoingDecayed = new Set();
  for (const unit of participants) {
    if (!outgoingDecayed.has(unit.actorUuid)) {
      outgoingDecayed.add(unit.actorUuid);
      if (!await settleCurrentDecay(unit, OUTGOING_DECAY_FLAGS, board, context)) return TRANSITION_FAILED;
    }
    const passives = await settleUnitPassive(unit, 'onPhaseEnd', snapshot, context);
    if (!passives.ok) return passives;
    markPassiveRan(unit, board);
  }
  return TRANSITION_OK;
}

/** Run the phase-end objective check once. A queued end stops the change, and its writes so far stand. */
async function checkOutgoingObjectives(context) {
  const { sceneUuid, services, outgoing, outgoingRound } = context;
  const queued = await runObjectiveCheck(sceneUuid, services, {
    kind: OBJECTIVE_CHECK_KINDS.PHASE_END,
    phase: outgoing,
    roundEnded: outgoingRound
  });
  return queued ? { ok: true, queued: true } : TRANSITION_OK;
}

/** Fire the outgoing phase's terrain spawns, recording each arriving actor on the command before its Token exists. */
async function fireOutgoingSpawns(context) {
  const { sceneUuid, services, outgoing, outgoingRound } = context;
  const fired = await services.terrain.firePhaseEndSpawns(sceneUuid, outgoing, outgoingRound, {
    resources: services.resources,
    operation: services.operation ?? null
  });
  if (fired.busy === true) return TRANSITION_STALE;
  return fired.ok === false ? TRANSITION_FAILED : TRANSITION_OK;
}

/** Expire the timed terrain edits whose undo data was saved when the change began. */
async function expireOutgoingTerrain(context) {
  const { sceneUuid, services, outgoing } = context;
  const swept = await services.terrain.expireTimedEdits(sceneUuid, outgoing, services.operation ?? null);
  return swept.ok === true ? TRANSITION_OK : TRANSITION_FAILED;
}

/**
 * Count down the timed summons that tick on the outgoing phase and remove those whose time ran out. It runs after
 * the side's phase-end passives and the objective check, and before the incoming phase is written, so an expired
 * summon is never armed for the next phase. The writer saves undo data for every summon, then writes the counters in
 * one Token update.
 */
async function expireOutgoingSummons(context) {
  const { sceneUuid, services, outgoing } = context;
  const board = await services.encounters.getAftermathSnapshot?.(sceneUuid);
  const plan = planSummonExpiry(board?.units, outgoing);
  if (!plan.expiredTokenUuids.length && !plan.counters.length) return TRANSITION_OK;
  return await services.encounters.expireSummons(sceneUuid, plan, services.operation ?? null)
    ? TRANSITION_OK
    : TRANSITION_FAILED;
}

/* -------------------------------------------- */
/*  Opening stages                              */
/* -------------------------------------------- */

async function writeIncomingPhase(context) {
  const { sceneUuid, services, incoming, round } = context;
  return await services.encounters.setPhase(sceneUuid, incoming, round, services.operation ?? null)
    ? TRANSITION_OK
    : TRANSITION_FAILED;
}

async function armIncomingTurns(context) {
  const opening = await openingSnapshot(context);
  if (!opening) return TRANSITION_FAILED;
  return await applyPhaseTurns(opening, context.incoming, context.services) ? TRANSITION_OK : TRANSITION_FAILED;
}

/**
 * Show the incoming phase banner through presentation, then run passives and phase-begin decay. Each unit's decay
 * is planned from its effects as they stand after its passives. An Actor standing behind several Tokens decays once.
 * settleIncomingTicks handles damage afterward.
 */
async function openIncomingPhase(context) {
  const { services, incoming } = context;
  const opening = await openingSnapshot(context);
  if (!opening) return TRANSITION_FAILED;
  await announcePhase(services, incoming);
  await services.wait(ENCOUNTER_PHASE_TIMING.bannerHold);
  const board = decayBoard(opening);
  const decayed = new Set();
  for (const unit of phaseParticipants(opening.units, incoming)) {
    const passives = await settleUnitPassive(unit, 'onPhaseBegin', opening, context);
    if (!passives.ok) return passives;
    markPassiveRan(unit, board);
    if (decayed.has(unit.actorUuid)) continue;
    decayed.add(unit.actorUuid);
    if (!await settleCurrentDecay(unit, ENCOUNTER_DECAY_FLAGS.PHASE_BEGIN, board, context)) return TRANSITION_FAILED;
  }
  return TRANSITION_OK;
}

async function settleIncomingTicks(context) {
  if (!await openingSnapshot(context)) return TRANSITION_FAILED;
  return runPhaseTicks(context);
}

/** The GM's warning when an Enemy Phase opens with nothing left to act. */
const EMPTY_ENEMY_PHASE_NOTICE = 'There are no enemies on the scene. Auto-Advance has been disabled.';

/**
 * An Enemy Phase with no living enemy can never finish, because `phaseRosterProgress` only reports a phase
 * complete once at least one unit has acted. Auto-advance would then sit on a side that cannot end its turn, so
 * it is switched off and the GM is told why. The flag is saved, and the GM turns it back on in the combat
 * tracker. The write goes through this change's operation, so a refused phase change puts it back.
 */
async function stopAutoAdvanceOnEmptyEnemyPhase(context) {
  const { services, incoming, sceneUuid } = context;
  if (incoming !== ENCOUNTER_PHASES.ENEMY) return TRANSITION_OK;
  // The objective read is the one that carries both the roster and the saved auto-advance flag.
  const board = await services.encounters.getObjectiveSnapshot(sceneUuid);
  if (!board) return TRANSITION_FAILED;
  if (board.autoAdvance !== true) return TRANSITION_OK;
  if (phaseRosterProgress(board.units, incoming).total > 0) return TRANSITION_OK;
  if (!await services.encounters.setEncounterFlag(sceneUuid, OBJECTIVE_FLAGS.AUTO_ADVANCE, false,
    services.operation ?? null)) {
    return TRANSITION_FAILED;
  }
  services.notify('warn', EMPTY_ENEMY_PHASE_NOTICE);
  return TRANSITION_OK;
}

/**
 * Apply status ticks and terrain hazards one camera group at a time. The map is read again after each camera pan,
 * so a cure, heal, move or removal during the pause changes what is charged.
 */
async function runPhaseTicks(context) {
  const { services, incoming } = context;
  const opening = await openingSnapshot(context);
  const visited = phaseParticipants(opening.units, incoming)
    .filter(unit => planPhaseStartTicks(unit).length > 0 || unit.terrain?.scan);
  for (const group of phaseCameraGroups(visited)) {
    await panPhaseCamera(group, services);
    const owed = await currentTickUnits(group, context);
    if (!owed) return TRANSITION_FAILED;
    if (!owed.length) continue;
    if (!await applyPhaseStartTicks(owed, context)) return TRANSITION_FAILED;
    // A tick may have defeated a unit, so the hazards land on the units still standing.
    const standing = await currentTickUnits(owed, context);
    if (!standing) return TRANSITION_FAILED;
    if (!await settlePhaseStartHazards(standing, context)) return TRANSITION_FAILED;
  }
  if (incoming === ENCOUNTER_PHASES.PLAYER) await focusPhaseStart(services);
  return TRANSITION_OK;
}

/** Read the map again, replacing the read the earlier opening stages used. */
async function currentOpening(context) {
  context.opening = await context.services.encounters.getSnapshot(context.sceneUuid);
  return context.opening;
}

/** One camera group's units as they are now, leaving out any no longer on the map. */
async function currentTickUnits(group, context) {
  const current = await currentOpening(context);
  if (!current) return null;
  const units = new Map(phaseParticipants(current.units, context.incoming).map(unit => [unit.actorUuid, unit]));
  return group.map(unit => units.get(unit.actorUuid)).filter(Boolean);
}

/* -------------------------------------------- */
/*  Unit consequences                           */
/* -------------------------------------------- */

/**
 * Decay one unit's effects under one decay flag or several through the encounter writer, which saves undo data for
 * the effects it changes or removes. An effect carrying several of the flags counts down once (planStatusTicks).
 */
async function settleUnitDecay(unit, flagKeys, context) {
  const { services } = context;
  const plan = planStatusTicks(unit.effects ?? [], [flagKeys].flat());
  if (!plan.removeIds.length && !plan.durations.length && !plan.stacks.length) return true;
  return await services.encounters.applyEffectDecay(unit.actorUuid, plan, services.operation ?? null) === true;
}

/**
 * The board a stage's decay reads. A phase passive can remove, refresh or add effects on any unit, so once one has
 * run the next decay reads the board again.
 */
function decayBoard(snapshot) {
  return { current: snapshot, stale: false };
}

function markPassiveRan(unit, board) {
  if ((unit.passiveEntries ?? []).length) board.stale = true;
}

/** Decay one unit as the board shows it now. A unit no longer on the board has nothing left to decay. */
async function settleCurrentDecay(unit, flagKeys, board, context) {
  if (board.stale) {
    board.current = await context.services.encounters.getSnapshot(context.sceneUuid);
    board.stale = false;
    if (!board.current) return false;
  }
  const current = (board.current.units ?? []).find(entry => entry.actorUuid === unit.actorUuid);
  return current ? settleUnitDecay(current, flagKeys, context) : true;
}

/** Run a unit's phase passives through EffectExecutionService, then finish the defeats their steps claimed. */
async function settleUnitPassive(unit, trigger, snapshot, context) {
  const { services } = context;
  if (!(unit.passiveEntries ?? []).length) return TRANSITION_OK;
  const ran = await runUnitPassive(unit, trigger, snapshot, services);
  if (ran.interrupted) {
    return ran.interrupted.code === RESULT_CODES.COMMAND_RESOURCE_BUSY ? TRANSITION_STALE : TRANSITION_FAILED;
  }
  if (!ran.ok) return TRANSITION_FAILED;
  await settlePassiveDefeats(unit, snapshot, ran.outcomes, context);
  return TRANSITION_OK;
}

async function runUnitPassive(unit, trigger, snapshot, services) {
  try {
    const outcome = await services.effects.run({
      entries: unit.passiveEntries ?? [],
      triggers: [trigger],
      runtime: effectRuntime({
        sceneUuid: snapshot.sceneUuid, operation: services.operation ?? null, self: unit, healEchoes: unit.healEchoes
      }),
      context: effectContext(unit.conditionSelf, null, null),
      resources: services.resources
    });
    const outcomes = outcome.outcomes;
    return { ok: !outcomes.some(entry => entry?.ok === false), outcomes, interrupted: outcome.interrupted };
  } catch (diagnosticError) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'runUnitPassive' });
    return { ok: false, outcomes: [] };
  }
}

/**
 * Finish the defeats a phase passive's steps claimed, the way a tick or an attack finishes them. A failure is
 * recorded and the phase change goes on; the next phase change finishes the unit.
 */
async function settlePassiveDefeats(unit, snapshot, outcomes, context) {
  const { services } = context;
  const units = new Map((snapshot.units ?? []).map(entry => [entry.actorUuid, entry]));
  const claims = collectEffectDefeats(outcomes, actorUuid => units.get(actorUuid)?.actorType
    ?? (actorUuid === unit.actorUuid ? unit.actorType : ''));
  if (!claims.length) return;
  try {
    await settleEffectDefeats({
      defeats: services.defeats,
      objects: services.objects,
      presentation: { broadcast: message => services.presentation(message) },
      events: services.events,
      wait: services.wait,
      diagnostics: services.diagnostics
    }, claims, {
      requestId: String(services.requestId ?? ''),
      userId: String(services.userId ?? ''),
      operation: services.operation ?? null
    });
  } catch (diagnosticError) {
    recordDiagnostic(services?.diagnostics, {
      sourcePath: import.meta.url, error: diagnosticError, detail: 'settlePassiveDefeats'
    });
  }
}

/* -------------------------------------------- */
/*  Phase-opening ticks and camera              */
/* -------------------------------------------- */

async function panPhaseCamera(group, services) {
  const tokenUuids = group.filter(unit => unit.cell).map(unit => String(unit.tokenUuid ?? '')).filter(Boolean);
  if (!tokenUuids.length) return;
  await presentSafely(services, phaseCameraPresentationMessage({ tokenUuids }));
  await services.wait(ENCOUNTER_PHASE_TIMING.cameraPan + ENCOUNTER_PHASE_TIMING.cameraSettle);
}

async function focusPhaseStart(services) {
  await presentSafely(services, phaseCameraPresentationMessage({ focus: true }));
  await services.wait(ENCOUNTER_PHASE_TIMING.focusPan);
}

/** Bleeding, Poison and Corpse Rot land unit by unit, each unit's ticks rolled as they are charged. */
async function applyPhaseStartTicks(group, context) {
  const { services } = context;
  let first = true;
  for (const unit of group) {
    const ticks = planPhaseStartTicks(unit);
    if (!ticks.length) continue;
    if (!first) await services.wait(ENCOUNTER_PHASE_TIMING.tickUnitStagger);
    first = false;
    if (!await settleUnitTicks(unit, ticks, context)) return false;
  }
  return true;
}

/**
 * Charge one unit's ticks in order, shedding each tick's stacks once its damage has landed. A tick that defeats the
 * unit ends its charges, since its Token is already gone.
 */
async function settleUnitTicks(unit, ticks, context) {
  const { services } = context;
  let remaining = Math.max(0, Number(unit.hp) || 0);
  for (const [index, tick] of ticks.entries()) {
    if (index > 0) await services.wait(ENCOUNTER_PHASE_TIMING.tickEffectStagger);
    const charged = await chargeUnitTick(unit, tick, remaining, context);
    if (!charged.ok) return false;
    if (charged.defeated) return true;
    remaining = charged.remaining;
    if (tick.shed
      && await services.encounters.applyEffectDecay(unit.actorUuid, tick.shed, services.operation ?? null) !== true) {
      return false;
    }
  }
  return true;
}

/** Roll one tick and apply it with the damage command, which saves undo data for the unit before it writes. */
async function chargeUnitTick(unit, tick, remaining, context) {
  const { services } = context;
  const rolled = Number(await services.dice.roll(tick.formula)) || 0;
  const amount = clampTickDamage(rolled, remaining, tick.lethal);
  if (amount <= 0 && !(tick.stanceDamage > 0)) return { ok: true, remaining };
  const result = await services.impacts.applyDamage({
    actorUuid: unit.actorUuid,
    tokenUuid: unit.tokenUuid,
    amount,
    damageType: tick.damageType,
    stanceAmount: tick.stanceDamage,
    policy: DAMAGE_POLICIES.DAMAGE_OVER_TIME,
    unpreventable: tick.unpreventable,
    canKillPlayer: tick.canKillPlayer
  });
  if (result?.ok === false) return { ok: false, remaining };
  return {
    ok: true,
    defeated: result?.data?.defeated === true,
    remaining: Number.isFinite(result?.data?.hpAfter) ? result.data.hpAfter : Math.max(0, remaining - amount)
  };
}

/** Terrain hazards land unit by unit through the same health commands the ticks use. */
async function settlePhaseStartHazards(group, context) {
  const { services } = context;
  for (const unit of group) {
    const applied = await services.terrain.applyPhaseStartImpacts([unit]);
    if (applied.ok === false) return false;
  }
  return true;
}

/* -------------------------------------------- */
/*  Shared writes and presentation              */
/* -------------------------------------------- */

async function presentSafely(services, message) {
  try {
    await services.presentation(message);
    return true;
  } catch (diagnosticError) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'presentSafely' });
    return false;
  }
}

/** Give the opening encounter its objective roster and progress: a resumed map's kept pair, or a fresh resolution. */
async function restoreObjectiveState(sceneUuid, board, restore, services) {
  if (!restore) {
    await snapshotObjectiveTargets(board, services, { resetProgress: true });
    return true;
  }
  const operation = services.operation ?? null;
  if (!await services.encounters.writeObjectiveTargets(sceneUuid, restore.targets,
    { resetProgress: true, operation })) {
    return false;
  }
  return await services.encounters.writeObjectiveProgress(sceneUuid, restore.progress, operation) === true;
}

/**
 * Arm every participant's turn for the phase that is opening. The Scene-wide plan reset runs first so no unit keeps
 * a stale preview. If the command is refused, its operation restores both.
 */
async function applyPhaseTurns(snapshot, phase, services, options = {}) {
  const plan = planPhaseTurnUpdates(snapshot.units, phase, options);
  if (!plan.length) return true;
  const operation = services.operation ?? null;
  const recovered = await services.movements.recoverScenePlans(snapshot.sceneUuid, operation);
  if (recovered && recovered.ok !== true) return false;
  return await services.encounters.applyTurnUpdates(snapshot.sceneUuid, plan, operation) === true;
}

async function announcePhase(services, phase) {
  const variant = phase === ENCOUNTER_PHASES.ENEMY ? BANNER_VARIANTS.ENEMY : BANNER_VARIANTS.PLAYER;
  return announceBanner(services, variant, phase + ' Phase');
}

async function announceBanner(services, variant, text) {
  return presentSafely(services, bannerPresentationMessage(variant, text));
}
