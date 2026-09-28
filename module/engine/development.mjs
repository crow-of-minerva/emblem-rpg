/** @layer engine */
import { COMMAND_IDS } from '../contracts/commands.mjs';
import {
  DEVELOPMENT_SCOPES,
  normalizeClearTerrainIntent,
  normalizeRepairItemsIntent,
  normalizeRestoreUnitsIntent
} from '../contracts/domains/development.mjs';
import { EVENT_IDS } from '../contracts/events.mjs';
import { buildCharacterItemRepair, buildFullCharacterReset } from '../game/character/rules.mjs';
import { diagnosticData, recordDiagnostic, requirePorts } from '../contracts/protocol.mjs';
import { accept, refuse, RESULT_CODES } from '../contracts/results.mjs';
import { TERRAIN_PERSISTENCE_CODES } from '../contracts/domains/terrain.mjs';
import { createCommandAuthorization } from './authorization.mjs';
import { recoverStaleMovement } from './movement/commands.mjs';

/* -------------------------------------------- */
/*  Development commands                        */
/* -------------------------------------------- */

/**
 * The GM restore, repair and clear-terrain command definitions init/system.mjs registers with CommandDispatcher.
 * The GM Macros compendium is their only first-party caller. Restore and repair read one snapshot from
 * FoundryDevelopmentRepository, plan each unit through `game/character/rules.mjs`, and write the results in one
 * pass under the command's operation. Clearing terrain effects runs, through TerrainPhaseService, the same sweep an
 * encounter's end runs.
 * @param {object} ports The development and movement repositories, TerrainPhaseService, event bus, authority and
 *   diagnostics.
 * @returns {object[]} Command definitions for CommandDispatcher.
 */
export function createDevelopmentCommandContribution({
  diagnostics, development, movements, events, authority, terrain
}) {
  requirePorts('createDevelopmentCommandContribution', { diagnostics, development, movements, events, terrain });
  const authorize = createCommandAuthorization(authority).gm();
  const ports = { diagnostics, development, movements, events, terrain };
  return [
    {
      id: COMMAND_IDS.DEVELOPMENT.RESTORE_UNITS,
      authorize,
      concurrencyKeys: context => developmentKeys(normalizeRestoreUnitsIntent(context.payload), development),
      handler: context => restoreUnits(context, ports)
    },
    {
      id: COMMAND_IDS.DEVELOPMENT.REPAIR_ITEMS,
      authorize,
      concurrencyKeys: context => developmentKeys(normalizeRepairItemsIntent(context.payload), development),
      handler: context => repairItems(context, ports)
    },
    {
      id: COMMAND_IDS.DEVELOPMENT.CLEAR_TERRAIN_EFFECTS,
      authorize,
      concurrencyKeys: context => terrainKeys(normalizeClearTerrainIntent(context.payload)),
      handler: context => clearTerrainEffects(context, ports)
    }
  ];
}

/** Clearing terrain rewrites one Scene's grid, which every unit's movement reads. */
function terrainKeys(intent) {
  return intent ? ['movement:board', `scene:${intent.sceneUuid}`] : ['movement:board'];
}

/** The board, plus every Scene and Actor the intent reaches. A malformed intent reaches only the board. */
async function developmentKeys(intent, development) {
  if (!intent) return ['movement:board'];
  return ['movement:board', ...await development.resourceKeys(intent)];
}

/**
 * Restore every unit in reach to full resources, an open turn, refreshed Item uses and no temporary effects.
 * The table-wide movement lock is released first, whichever units are in reach, by the forced recoverStaleMovement
 * that `/release` also runs, without a chat announcement. It sends the unit the lock names back to the anchor its
 * plan recorded, closes that plan and drops the lock together. A plan the lock did not start is closed where its
 * Token stands. Other open plans on the Scenes in reach are then snapped back to their anchors so the sweep does not
 * fight a live preview.
 */
async function restoreUnits(context, ports) {
  const intent = normalizeRestoreUnitsIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.COMMAND_FAILED, { reasonCode: 'development.intent-invalid' });
  const released = await recoverStaleMovement(context, ports.movements, { force: true });
  if (!released.ok) return released;
  return runDevelopmentWrite(context, ports, {
    intent,
    plan: buildFullCharacterReset,
    write: (development, resolutions, operation) => development.restoreUnits(resolutions, operation),
    failureCode: 'development.restore-failed',
    eventId: EVENT_IDS.UNITS_RESTORED,
    resultCode: RESULT_CODES.UNITS_RESTORED
  });
}

/** Bring every Item in reach back to its maximum uses, leaving resources, turn state and effects untouched. */
async function repairItems(context, ports) {
  const intent = normalizeRepairItemsIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.COMMAND_FAILED, { reasonCode: 'development.intent-invalid' });
  return runDevelopmentWrite(context, ports, {
    intent,
    plan: buildCharacterItemRepair,
    write: (development, resolutions, operation) => development.repairItems(resolutions, operation),
    failureCode: 'development.repair-failed',
    eventId: EVENT_IDS.ITEMS_REPAIRED,
    resultCode: RESULT_CODES.ITEMS_REPAIRED
  });
}

/**
 * Put every timed terrain edit on one map back to the square it replaced, the sweep an encounter's end runs
 * through TerrainPhaseService.revertTimedEdits. Edits authored with no duration stand. The scene-update hooks in
 * `init/hooks.mjs` redraw the board from the rewritten grid.
 */
async function clearTerrainEffects(context, { terrain, events }) {
  const intent = normalizeClearTerrainIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.COMMAND_FAILED, { reasonCode: 'development.intent-invalid' });
  const swept = await terrain.revertTimedEdits(intent.sceneUuid);
  if (swept.code === TERRAIN_PERSISTENCE_CODES.MISSING_SCENE) return refuse(RESULT_CODES.SCENE_NOT_FOUND);
  if (!swept.ok) {
    return refuse(RESULT_CODES.COMMAND_FAILED, {
      reasonCode: 'development.terrain-clear-failed', terrainCode: swept.code
    });
  }
  const outcome = Object.freeze({
    sceneUuid: intent.sceneUuid,
    cells: swept.cells,
    requestId: context.requestId,
    userId: context.userId
  });
  events.publish(EVENT_IDS.TERRAIN_EFFECTS_CLEARED, outcome);
  return accept(RESULT_CODES.TERRAIN_EFFECTS_CLEARED, outcome);
}

/* -------------------------------------------- */
/*  Shared settlement                           */
/* -------------------------------------------- */

/**
 * The settlement both commands share: read the snapshot, release the movement plans in reach, persist, then
 * publish. Every write captures through `context.operation`, so a refusal restores the whole sweep.
 */
async function runDevelopmentWrite(context, { diagnostics, development, movements, events }, task) {
  const snapshot = await development.getSnapshot(task.intent);
  if (!snapshot) return refuse(RESULT_CODES.SCENE_NOT_FOUND);
  const resolutions = snapshot.units.map(task.plan);
  const released = await releasePlans(snapshot, task.intent, movements, context.operation);
  if (!released.ok) {
    return refuse(RESULT_CODES.COMMAND_FAILED, { ...diagnosticData(released.failure),
      reasonCode: released.failure?.code ?? 'movement.plan-release-failed'
    });
  }
  let persisted;
  try {
    persisted = await task.write(development, resolutions, context.operation);
  } catch (error) {
    recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: task.failureCode });
    return refuse(RESULT_CODES.COMMAND_FAILED, { ...diagnosticData(error), reasonCode: task.failureCode });
  }
  const outcome = Object.freeze({
    scope: snapshot.scope,
    scopeName: snapshot.scopeName,
    sceneUuid: snapshot.sceneUuid,
    unitNames: Object.freeze(snapshot.units.map(unit => unit.actorName)),
    ...persisted,
    requestId: context.requestId,
    userId: context.userId
  });
  events.publish(task.eventId, outcome);
  return accept(task.resultCode, outcome);
}

/**
 * Snap every open movement plan on the Scenes in reach back to its anchor and drop the board lock, through
 * FoundryMovementRepository.recoverScenePlans, which captures each Token and the lock setting into this command's
 * operation. A refusal later in the sweep is restored by CommandDispatcher, so the first failure only has to stop.
 */
async function releasePlans(snapshot, intent, movements, operation) {
  for (const sceneUuid of scenesInReach(snapshot, intent)) {
    const receipt = await movements.recoverScenePlans(sceneUuid, operation);
    if (!receipt.ok) return { ok: false, failure: receipt };
  }
  return { ok: true };
}

/** The Scenes a plan could be open on: the one a Scene intent names, else wherever the reached units stand. */
function scenesInReach(snapshot, intent) {
  if (intent.scope === DEVELOPMENT_SCOPES.SCENE) return [snapshot.sceneUuid];
  const scenes = new Set();
  for (const unit of snapshot.units) {
    for (const tokenUuid of unit.tokenUuids) {
      const sceneUuid = tokenUuid.split('.Token.')[0];
      if (sceneUuid && sceneUuid !== tokenUuid) scenes.add(sceneUuid);
    }
  }
  return [...scenes];
}
