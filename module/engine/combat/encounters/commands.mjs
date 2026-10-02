/** @layer engine/combat/encounters */
import {
  BANNER_VARIANTS,
  bannerPresentationMessage,
  ENCOUNTER_PHASES,
  KARMA_LEDGER_RESOURCE_KEY,
  normalizeEncounterEndIntent,
  normalizeEncounterIntent,
  normalizeEncounterRoundIntent,
  normalizeEncounterToggleIntent,
  normalizeObjectiveAuthoringIntent,
  normalizeObjectiveCheckIntent,
  OBJECTIVE_CHECK_KINDS
} from '../../../contracts/domains/combat.mjs';
import { COMMAND_IDS, INTERNAL_COMMAND_IDS } from '../../../contracts/commands.mjs';
import { EVENT_IDS } from '../../../contracts/events.mjs';
import { authorObjectives, resolveObjectiveEnd, runObjectiveCheck } from './objectives.mjs';
import {
  advanceEncounterPhase,
  beginEncounter,
  cancelEncounter,
  createEncounter,
  discardPausedEncounter,
  endEncounter,
  pauseEncounter,
  resumeEncounter,
  setAutoAdvance,
  setCombatMusic,
  setEncounterRound
} from './phases.mjs';
import { createCommandAuthorization } from '../../authorization.mjs';
import { holdsResources } from '../../dispatcher.mjs';
import {
  phaseRosterProgress,
  planExplorationTurnUpdates,
  unitTurnComplete
} from '../../../game/combat/phases.mjs';
import { stanceRecoveryAmount } from '../../../game/combat/damage.mjs';
import { accept, refuse, RESULT_CODES } from '../../../contracts/results.mjs';
import { recordDiagnostic, requirePorts } from '../../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Encounter commands                          */
/* -------------------------------------------- */

/**
 * The encounter, objective and turn command definitions init/system.mjs registers with CommandDispatcher. The GM
 * runs the encounter commands, END_TURN needs control of the token, and the internal checks and turn completions
 * run as the active GM. Every service but `clock` comes from init/system.mjs.
 */
export function createEncounterCommandContribution({
  diagnostics, encounters, terrain, movements, effects, dice, impacts, rests, presentation, events, notify,
  identifier, authority, endRetries, defeats, objects, continuations, wait, clock = () => Date.now()
}) {
  requirePorts('createEncounterCommandContribution', { diagnostics, encounters, terrain, movements, effects, dice,
    impacts, rests, presentation, events, notify, identifier, endRetries, defeats, objects, continuations, wait });
  const services = { diagnostics,
    encounters, terrain, movements, effects, dice, impacts, rests, presentation, events, notify, clock, identifier,
    endRetries, defeats, objects, continuations, wait
  };
  const gm = createCommandAuthorization(authority).gm();
  const activeGm = createCommandAuthorization(authority).activeGm();
  const concurrencyKeys = context => encounters.resourceKeys(context.payload);
  const karmicKeys = async context => [...await concurrencyKeys(context), KARMA_LEDGER_RESOURCE_KEY];
  const holdingMap = handler => async context => (
    await holdsPlacedActors(commandResources(context), services, context.payload?.sceneUuid)
      ? handler(context)
      : refuse(RESULT_CODES.ENCOUNTER_STALE)
  );
  let autoAdvanceSequence = 0;
  const advance = (sceneUuid, expected, context) => settlePhase(
    {
      ...context,
      payload: expected ? { sceneUuid, expected } : { sceneUuid },
      userId: String(context.userId ?? ''),
      requestId: `hook:auto-advance:phase-complete:${autoAdvanceSequence += 1}`
    },
    services,
    advanceEncounterPhase,
    RESULT_CODES.ENCOUNTER_PHASE_ADVANCED,
    EVENT_IDS.ENCOUNTER_PHASE_ADVANCED,
    normalizeAdvanceIntent
  );

  const phaseCommand = (id, run, code, eventId, normalize, keys = concurrencyKeys) => ({
    id,
    authorize: gm,
    concurrencyKeys: keys,
    handler: context => settlePhase(context, services, run, code, eventId, normalize)
  });

  return [
    phaseCommand(COMMAND_IDS.ENCOUNTERS.CREATE, createEncounter, RESULT_CODES.ENCOUNTER_CREATED,
      EVENT_IDS.ENCOUNTER_BEGAN),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.BEGIN, beginEncounter, RESULT_CODES.ENCOUNTER_BEGAN,
      EVENT_IDS.ENCOUNTER_BEGAN),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.ADVANCE_PHASE, advanceEncounterPhase,
      RESULT_CODES.ENCOUNTER_PHASE_ADVANCED, EVENT_IDS.ENCOUNTER_PHASE_ADVANCED, normalizeAdvanceIntent, karmicKeys),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.END, endEncounter, RESULT_CODES.ENCOUNTER_ENDED,
      EVENT_IDS.ENCOUNTER_ENDED, normalizeEncounterEndIntent),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.CANCEL, cancelEncounter, RESULT_CODES.ENCOUNTER_CANCELLED,
      EVENT_IDS.ENCOUNTER_ENDED),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.PAUSE, pauseEncounter, RESULT_CODES.ENCOUNTER_PAUSED,
      EVENT_IDS.ENCOUNTER_ENDED),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.RESUME, resumeEncounter, RESULT_CODES.ENCOUNTER_RESUMED,
      EVENT_IDS.ENCOUNTER_BEGAN),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.DISCARD_PAUSE, discardPausedEncounter,
      RESULT_CODES.ENCOUNTER_PAUSE_DISCARDED, EVENT_IDS.ENCOUNTER_ENDED),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.SET_AUTO_ADVANCE, setAutoAdvance,
      RESULT_CODES.ENCOUNTER_OPTION_SET, null, normalizeEncounterToggleIntent),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.SET_COMBAT_MUSIC, setCombatMusic,
      RESULT_CODES.ENCOUNTER_OPTION_SET, null, normalizeEncounterToggleIntent),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.SET_EXPLORATION, setExploration,
      RESULT_CODES.ENCOUNTER_EXPLORATION_SET, null, normalizeEncounterToggleIntent),
    phaseCommand(COMMAND_IDS.ENCOUNTERS.SET_ROUND, setEncounterRound,
      RESULT_CODES.ENCOUNTER_OPTION_SET, null, normalizeEncounterRoundIntent),
    {
      id: COMMAND_IDS.ENCOUNTERS.END_TURN,
      authorize: createCommandAuthorization(authority).tokenController(payload => payload.tokenUuid),
      concurrencyKeys: context => movements.resourceKeys(String(context.payload?.tokenUuid ?? '')),
      handler: context => settleUnitTurnEnd(context, services)
    },
    {
      id: COMMAND_IDS.ENCOUNTERS.OBJECTIVES.AUTHOR,
      authorize: gm,
      concurrencyKeys,
      handler: holdingMap(context => settleAuthoring(context, services))
    },
    {
      id: INTERNAL_COMMAND_IDS.ENCOUNTERS.CHECK_OBJECTIVES,
      authorize: activeGm,
      concurrencyKeys,
      handler: holdingMap(context => settleCheck(context, services))
    },
    {
      id: INTERNAL_COMMAND_IDS.ENCOUNTERS.RESOLVE_OBJECTIVE_END,
      authorize: activeGm,
      concurrencyKeys,
      handler: holdingMap(context => settleEnd(context, services))
    },
    {
      id: INTERNAL_COMMAND_IDS.ENCOUNTERS.FINISH_CONTINUATION,
      authorize: activeGm,
      concurrencyKeys,
      handler: holdingMap(context => settleLostContinuation(context, services))
    },
    {
      id: INTERNAL_COMMAND_IDS.ENCOUNTERS.COMPLETE_TURN,
      authorize: activeGm,
      concurrencyKeys: karmicKeys,
      handler: holdingMap(context => settleTurn(context, services, advance))
    }
  ];
}

/* -------------------------------------------- */
/*  Command handlers                            */
/* -------------------------------------------- */

/**
 * A `hold(keys)` function for the running command, so the phase code and the terrain and health writers can record
 * each new actor they reach on it (see holdsResources).
 */
function commandResources(context) {
  return Object.freeze({ hold: keys => holdsResources(context, keys) });
}

/**
 * Whether an encounter command holds every actor on its map before it writes, including units placed or spawned
 * since its keys were taken. See holdsResources.
 */
async function holdsPlacedActors(resources, services, sceneUuid) {
  if (!sceneUuid) return true;
  const actorUuids = await services.encounters.getWritableActorUuids(String(sceneUuid));
  return resources.hold(actorUuids.map(actorUuid => `actor:${actorUuid}`));
}

/**
 * Run one encounter command's phase code with the command's actor keys and operation. The phase code re-reads the
 * map and records newly reached actors, spawned reinforcements included, before each stage.
 *
 * The command's event waits until the command commits, so its listeners (the encounter hooks in
 * foundry/hooks/scene.mjs and the Enemy AI) never hear of a change that was undone.
 * The auto-advance, combat music and exploration switches only store a setting and pass no event. A phase change
 * that queued an encounter end carries its own code: those writes are meant to stand, so the command accepts under
 * that code and publishes no phase-advanced event.
 */
async function settlePhase(context, services, run, code, eventId, normalize = normalizeEncounterIntent) {
  const intent = normalize(context.payload);
  if (!intent) return refuse(RESULT_CODES.SCENE_NOT_FOUND);
  const resources = commandResources(context);
  const scoped = {
    ...services,
    resources,
    operation: context.operation ?? null,
    requestId: String(context.requestId ?? ''),
    userId: String(context.userId ?? ''),
    impacts: services.impacts.withResources(resources),
    terrain: services.terrain.withResources(resources),
    holdsPlacedActors: () => holdsPlacedActors(resources, services, intent.sceneUuid)
  };
  if (!await scoped.holdsPlacedActors()) return refuse(RESULT_CODES.ENCOUNTER_STALE);
  const snapshot = await services.encounters.getSnapshot(intent.sceneUuid);
  if (!snapshot) return refuse(RESULT_CODES.SCENE_NOT_FOUND);

  const result = await run(snapshot, scoped, intent);
  if (result.ok !== true) return refuse(result.code, result.data);
  const outcome = {
    sceneUuid: intent.sceneUuid,
    phase: result.phase,
    round: result.round,
    previousPhase: result.previousPhase ?? '',
    requestId: context.requestId,
    userId: context.userId
  };
  if (result.code) return accept(result.code, outcome);
  if (eventId) services.events.publish(eventId, outcome, { operation: context.operation ?? null });
  return accept(code, outcome);
}

/**
 * Validate the expected encounter, phase and round passed by api.encounters.advancePhase or an automatic advance.
 * Malformed expectations refuse instead of being ignored.
 * @param {object} [payload] The request payload.
 * @returns {Readonly<{sceneUuid: string, expected?: object}>|null}
 */
function normalizeAdvanceIntent(payload = {}) {
  const intent = normalizeEncounterIntent(payload);
  if (!intent || payload?.expected === undefined) return intent;
  const expected = normalizeExpectedEncounter(payload.expected);
  return expected ? Object.freeze({ sceneUuid: intent.sceneUuid, expected }) : null;
}

function normalizeExpectedEncounter(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const combatId = String(raw.combatId ?? '');
  const phase = String(raw.phase ?? '');
  const round = Number(raw.round);
  if (!/^[A-Za-z0-9]{1,64}$/.test(combatId) || !Object.values(ENCOUNTER_PHASES).includes(phase)) return null;
  if (!Number.isInteger(round) || round < 1 || round > 1_000_000) return null;
  return Object.freeze({ combatId, phase, round });
}

/** The services an objective command runs with: the shared ones plus the operation its writes save undo data on. */
function scopedServices(context, services) {
  return { ...services, operation: context.operation ?? null };
}

async function settleAuthoring(context, services) {
  const intent = normalizeObjectiveAuthoringIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.OBJECTIVES_INPUT_INVALID);
  const result = await authorObjectives(intent, scopedServices(context, services));
  if (result.ok !== true) return refuse(result.code);
  const outcome = { sceneUuid: intent.sceneUuid, warnings: result.warnings, requestId: context.requestId };
  services.events.publish(EVENT_IDS.ENCOUNTER_OBJECTIVES_AUTHORED, outcome);
  return accept(RESULT_CODES.OBJECTIVES_AUTHORED, outcome);
}

async function settleCheck(context, services) {
  const intent = normalizeObjectiveCheckIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.OBJECTIVES_INPUT_INVALID);
  const queued = await runObjectiveCheck(intent.sceneUuid, scopedServices(context, services), intent);
  return accept(RESULT_CODES.OBJECTIVES_CHECKED, {
    sceneUuid: intent.sceneUuid,
    reason: queued?.reason ?? '',
    queued: Boolean(queued)
  });
}

/**
 * Finish a queued encounter end. An end an objective decided is an end like the GM's, so once its operation commits
 * it publishes "encounter ended" too, and the Enemy AI clears its aggression marks and battle memory.
 */
async function settleEnd(context, services) {
  const intent = normalizeEncounterIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.SCENE_NOT_FOUND);
  const snapshot = await services.encounters.getSnapshot(intent.sceneUuid);
  const resolution = await resolveObjectiveEnd(intent.sceneUuid, scopedServices(context, services));
  void services.endRetries.scheduleRetry(intent.sceneUuid, resolution.requestId ?? '', resolution.status);
  if (resolution.status === 'ended') {
    services.events.publish(EVENT_IDS.ENCOUNTER_ENDED, {
      sceneUuid: intent.sceneUuid,
      phase: '',
      round: snapshot?.round,
      previousPhase: '',
      requestId: context.requestId,
      userId: context.userId
    }, { operation: context.operation ?? null });
  }
  return accept(RESULT_CODES.OBJECTIVES_END_COMMITTED, {
    sceneUuid: intent.sceneUuid,
    status: resolution.status,
    reason: resolution.reason ?? ''
  });
}

/**
 * Close a turn whose end-of-turn prompt was lost when the host reloaded.
 *
 * The attack that set `system.turn.continuationPending` was saved, so this just finishes that unit's turn.
 * completeInterruptedTurns in init/system.mjs sends one of these per unit still carrying the marker at startup.
 * The turn is closed through FoundryCombatSettlementRepository's own writer, and the usual turn-end objective check
 * follows. The phase never advances by itself at startup.
 */
async function settleLostContinuation(context, services) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  const sceneUuid = String(context.payload?.sceneUuid ?? '');
  const scoped = scopedServices(context, services);
  const pending = (await services.encounters.getPendingContinuations())
    .find(entry => entry.actorUuid === actorUuid);
  if (!pending || pending.requestId !== String(context.payload?.requestId ?? '')) {
    return refuse(RESULT_CODES.ENCOUNTER_STALE, { actorUuid });
  }
  if (await services.continuations.settle(actorUuid, context.operation ?? null) !== true) {
    return refuse(RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED, { actorUuid });
  }
  await runObjectiveCheck(sceneUuid, scoped, { kind: OBJECTIVE_CHECK_KINDS.TURN_END, actorUuid });
  return accept(RESULT_CODES.ENCOUNTER_TURN_COMPLETED, { sceneUuid, actorUuid, advanced: false });
}

/**
 * Handle one finished turn: run its objective checks and, once the side is done, the automatic phase change. If
 * that change fails, refuse under its code. The turn was written by the command that ended it, so it stays complete.
 */
async function settleTurn(context, services, advance) {
  const intent = normalizeObjectiveCheckIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.OBJECTIVES_INPUT_INVALID);
  const result = await completeUnitTurn(intent, scopedServices(context, services),
    (sceneUuid, expected) => advance(sceneUuid, expected, context));
  if (result.ok !== true) {
    return refuse(result.code, { sceneUuid: intent.sceneUuid, phaseChangeStopped: result.phaseChangeStopped === true });
  }
  return accept(RESULT_CODES.ENCOUNTER_TURN_COMPLETED, {
    sceneUuid: intent.sceneUuid,
    advanced: result.advanced === true
  });
}

/* -------------------------------------------- */
/*  Ending a turn                               */
/* -------------------------------------------- */

async function settleUnitTurnEnd(context, services) {
  const tokenUuid = String(context.payload?.tokenUuid ?? '');
  if (!tokenUuid) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const result = await endUnitTurn(
    { tokenUuid, restoreStance: context.payload?.restoreStance === true, userId: context.userId },
    { movements: services.movements, impacts: services.rests, operation: context.operation ?? null }
  );
  if (result.ok !== true) return refuse(result.code, result.details);
  return accept(RESULT_CODES.ENCOUNTER_TURN_ENDED, {
    tokenUuid: result.tokenUuid,
    actorUuid: result.actorUuid,
    ended: result.ended,
    stanceRestored: result.stanceRestored,
    requestId: context.requestId,
    userId: context.userId
  });
}

/**
 * End a unit's turn through the movement plan-close writer, opening a plan first if needed.
 * This keeps plan-end effects and Guard checks in the normal path. The resting stance comes back only
 * after the close succeeds, so a failed write never grants a rest.
 * @param {{tokenUuid: string, restoreStance: boolean, userId: string}} intent The unit, whether it rests, who asks.
 * @param {{movements: object, impacts: object, operation?: object|null}} services The movement writer, the healing
 *   command, and the operation both save undo data on.
 * @returns {Promise<object>} `{ok, ended, stanceRestored}`, or `{ok: false, code}`.
 */
export async function endUnitTurn({ tokenUuid, restoreStance, userId },
  { movements, impacts, operation = null }) {
  const found = await movements.getSnapshot(String(tokenUuid ?? ''));
  if (!found) return { ok: false, code: RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND };
  if (found.actorType !== 'Character') return { ok: false, code: RESULT_CODES.CHARACTER_REQUIRED };
  const identity = { tokenUuid: found.tokenUuid, actorUuid: found.actorUuid };
  if (unitTurnComplete({
    actionAvailable: found.standardAvailable, movementAvailable: found.movementAvailable
  })) {
    return { ok: true, ...identity, ended: false, stanceRestored: 0 };
  }
  const opened = await openStandingPlan(movements, found, userId, operation);
  if (opened.ok !== true) return opened;
  const snapshot = opened.snapshot;
  const standing = {
    destination: snapshot.current,
    cost: 0,
    path: Object.freeze([snapshot.current])
  };
  if (!await movements.commit(snapshot, standing, { resume: false, endTurn: true, operation })) {
    return { ok: false, code: RESULT_CODES.MOVEMENT_STATE_STALE };
  }
  const stanceRestored = await restoreRestingStance(snapshot, restoreStance, impacts);
  return { ok: true, ...identity, ended: true, stanceRestored };
}

/** The movement plan to close the turn on where the unit stands: the one already open, or one opened now. */
async function openStandingPlan(movements, snapshot, userId, operation = null) {
  if (snapshot.movementPlanning) return { ok: true, snapshot };
  const started = await movements.begin(snapshot, String(userId ?? ''), operation);
  if (started.ok !== true) {
    if (started.lock) {
      return { ok: false, code: RESULT_CODES.MOVEMENT_LOCKED, details: { holderName: started.lock.holderName } };
    }
    return { ok: false, code: RESULT_CODES.MOVEMENT_STATE_STALE };
  }
  const fresh = await movements.getSnapshot(snapshot.tokenUuid);
  if (!fresh) return { ok: false, code: RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND };
  return { ok: true, snapshot: fresh };
}

/**
 * Restore the stance a unit that spent its turn resting gets back, and say how much that was.
 * @returns {Promise<number>} The stance restored, zero when the unit is down, full, or the heal was refused.
 */
export async function restoreRestingStance(snapshot, restoreStance, impacts) {
  if (restoreStance !== true || Number(snapshot.hp) <= 0) return 0;
  const amount = stanceRecoveryAmount({
    value: snapshot.stance, max: snapshot.stanceMax, regen: snapshot.stanceRegen
  });
  if (amount <= 0) return 0;
  const healed = await impacts.applyHealing({
    actorUuid: snapshot.actorUuid,
    tokenUuid: snapshot.tokenUuid,
    amount: 0,
    stanceAmount: amount
  });
  return healed?.ok === false ? 0 : amount;
}

/* -------------------------------------------- */
/*  Unit turn lifecycle                         */
/* -------------------------------------------- */

/** Pause between the last unit finishing and the phase turning over, so the table sees the action end. */
const AUTO_ADVANCE_DELAY = 800;

/**
 * Run objective checks after a turn and, once the side is done, advance the phase after a short pause.
 * Re-read the map after waiting. Return a failed phase change without undoing the finished turn.
 * Startup recovery leaves interrupted automatic advances for the GM to trigger.
 */
async function completeUnitTurn(intent, services, advance) {
  const board = await services.encounters.getObjectiveSnapshot(intent.sceneUuid);
  if (!board?.started) return { ok: false, code: RESULT_CODES.ENCOUNTER_NOT_RUNNING };

  await runObjectiveCheck(intent.sceneUuid, services, {
    kind: OBJECTIVE_CHECK_KINDS.TURN_END,
    phase: board.phase,
    actorUuid: intent.actorUuid
  });

  if (!board.autoAdvance || intent.autoAdvance === false) return { ok: true, advanced: false };
  if (!phaseComplete(board)) return { ok: true, advanced: false };

  await services.wait(AUTO_ADVANCE_DELAY);
  const settled = await services.encounters.getObjectiveSnapshot(intent.sceneUuid);
  if (!settled?.started || settled.hasPendingEnd) return { ok: true, advanced: false };
  if (settled.phase !== board.phase || !settled.autoAdvance || !phaseComplete(settled)) {
    return { ok: true, advanced: false };
  }
  const advanced = await advance(intent.sceneUuid, expectedEncounter(settled));
  // A change that queued the encounter's end accepts under its own code, and the phase deliberately did not turn.
  if (advanced.code === RESULT_CODES.OBJECTIVES_END_QUEUED) return { ok: true, advanced: false };
  if (advanced.ok === true) return { ok: true, advanced: true };
  if (advanced.code === RESULT_CODES.ENCOUNTER_ADVANCE_STALE) return { ok: true, advanced: false };
  return { ok: false, code: advanced.code ?? RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED, phaseChangeStopped: true };
}

/** The encounter, phase and round an automatic advance was decided on, so a phase already turned over refuses it. */
function expectedEncounter(board) {
  if (!board.combatId) return null;
  return { combatId: String(board.combatId), phase: String(board.phase ?? ''), round: Number(board.round) };
}

/** Whether every living unit of the acting side has spent its turn. Hidden tokens don't count. */
function phaseComplete(board) {
  if (!board.phase) return false;
  const visible = board.units.filter(unit => !unit.hidden);
  return phaseRosterProgress(visible, board.phase).complete;
}

/* -------------------------------------------- */
/*  Free exploration                            */
/* -------------------------------------------- */

/**
 * Apply exploration turn state through the Foundry writers without changing encounter records.
 * The UI keeps exploration and encounters mutually exclusive. Stored objective data stays on the Scene.
 */
async function setExploration(snapshot, services, intent = {}) {
  const board = await services.encounters.getObjectiveSnapshot(snapshot.sceneUuid);
  if (!board) return { ok: false, code: RESULT_CODES.SCENE_NOT_FOUND };
  const enabled = intent.enabled === true;
  const operation = services.operation ?? null;
  if (!await services.encounters.setExploration(snapshot.sceneUuid, enabled, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  const plan = planExplorationTurnUpdates(board.units, enabled);
  if (plan.length && !await services.encounters.applyTurnUpdates(snapshot.sceneUuid, plan, operation)) {
    return { ok: false, code: RESULT_CODES.ENCOUNTER_SETTLEMENT_FAILED };
  }
  if (enabled) await announceExploration(services);
  return { ok: true, phase: ENCOUNTER_PHASES.PLAYER, round: board.round ?? 1, exploration: enabled };
}

async function announceExploration(services) {
  try {
    await services.presentation(bannerPresentationMessage(BANNER_VARIANTS.EXPLORATION, 'Free Exploration'));
    return true;
  } catch (diagnosticError) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'announceExploration' });
    return false;
  }
}
