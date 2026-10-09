/** @layer foundry/adapters/document-writes */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { DOOR_WALL_FLAG } from '../../../contracts/domains/objects.mjs';
import { newSceneFogDefaults, resolveMapVisibleFold } from '../../../game/vision/sight.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Scene fog interception                      */
/* -------------------------------------------- */

/**
 * preUpdateScene handler (wired in init/hooks.mjs). When the Map Visible flag changes, add the settings it needs
 * to the same Scene update. Turning it on switches on token vision, and fog exploration if it was off. Turning it
 * off writes a new `fog.reset` timestamp, meant to clear what was explored while it was on. The v14 client doesn't
 * act on that field (fog is cleared by canvas.fog.reset()), so the explored fog may stay revealed.
 * @param {Scene} scene The scene being updated.
 * @param {object} changed The pending update.
 */
export function onPreUpdateSceneMapVisible(scene, changed) {
  const enabled = foundry.utils.getProperty(changed, `flags.${SYSTEM_ID}.mapVisible`);
  if (enabled === undefined) return;
  const disabledMode = CONST.FOG_EXPLORATION_MODES.DISABLED;
  const mode = foundry.utils.getProperty(changed, 'fog.mode') ?? scene.fog?.mode;
  const fold = resolveMapVisibleFold({
    enabled: !!enabled,
    explorationDisabled: (mode ?? disabledMode) === disabledMode
  });
  if (fold.enableExploration) {
    foundry.utils.setProperty(changed, 'fog.mode', CONST.FOG_EXPLORATION_MODES.INDIVIDUAL);
  }
  if (fold.forceTokenVision) foundry.utils.setProperty(changed, 'tokenVision', true);
  if (fold.resetFog) foundry.utils.setProperty(changed, 'fog.reset', Date.now());
}

/**
 * preCreateScene handler (wired in init/hooks.mjs). A new Scene starts with token vision and fog exploration
 * off, and a GM turns them on where needed (enabling Map Visible does both).
 * @param {Scene} scene The scene about to be created.
 */
export function onPreCreateSceneFogDefaults(scene) {
  const defaults = newSceneFogDefaults({
    tokenVision: scene.tokenVision,
    explorationDisabled: scene.fog?.mode === CONST.FOG_EXPLORATION_MODES.DISABLED
  });
  const updates = {};
  if (defaults.disableTokenVision) updates.tokenVision = false;
  if (defaults.disableExploration) updates['fog.mode'] = CONST.FOG_EXPLORATION_MODES.DISABLED;
  if (Object.keys(updates).length) scene.updateSource(updates);
}

/* -------------------------------------------- */
/*  Door sight walls                            */
/* -------------------------------------------- */

/**
 * Reads Doors and writes the sight-only Wall documents that make a locked Door block sight. Used by the door-sight
 * command, reconcileDoorSight in engine/board.mjs.
 */
export class FoundryDoorSightRepository {
  /** Every Scene's UUID, for a pass over the whole world (at ready, or when a world Door actor's lock changes). */
  sceneUuids() {
    return collectionValues(game.scenes).map(scene => String(scene.uuid));
  }

  /**
   * Every Door on a Scene with its lock state and footprint, plus the walls already tagged for one.
   * @param {string} sceneUuid Scene to read, or the empty string for the viewed Scene.
   * @returns {Promise<object|null>}
   */
  async getDoorBoard(sceneUuid) {
    const scene = sceneUuid
      ? await globalThis.fromUuid(String(sceneUuid))
      : globalThis.canvas?.scene ?? null;
    if (scene?.documentName !== 'Scene') return null;
    const gridSize = scene.grid.size;

    const doors = [];
    for (const tokenDocument of collectionValues(scene.tokens)) {
      const actor = tokenDocument.actor;
      if (actor?.type !== 'Object' || String(actor.system?.objectType ?? '') !== 'Door') continue;
      const system = actor.system;
      doors.push({
        tokenId: String(tokenDocument.id),
        locked: system.locked !== false,
        x: Number(tokenDocument.x) || 0,
        y: Number(tokenDocument.y) || 0,
        width: Number(tokenDocument.width) || 1,
        height: Number(tokenDocument.height) || 1,
        gridSize
      });
    }

    const taggedWalls = [];
    for (const wall of collectionValues(scene.walls)) {
      const tokenId = wall.getFlag(SYSTEM_ID, DOOR_WALL_FLAG);
      if (!tokenId) continue;
      taggedWalls.push({
        wallId: String(wall.id), tokenId: String(tokenId), c: [...(wall.c ?? [])].map(Number)
      });
    }

    return {
      sceneUuid: String(scene.uuid),
      doors,
      taggedWalls,
      walledTokenIds: [...new Set(taggedWalls.map(wall => wall.tokenId))]
    };
  }

  /**
   * Apply one Scene's door-wall plan: delete the walls that no longer belong, then build a box of walls around each
   * locked Door. The new wall ids are picked here and recorded in the command's undo record (`operation`), so undo
   * removes exactly the walls created here.
   *
   * Deletions run first. If a write fails partway, a missing wall is rebuilt by the next door-sight pass, but a
   * stale wall left standing could block sight through a door that should be open.
   * @param {string} sceneUuid Scene whose door walls are being updated.
   * @param {object} plan The build, teardown and orphan sets.
   * @param {object|null} operation The command's undo record, or null outside a command.
   * @returns {Promise<object>}
   */
  async settleDoorWalls(sceneUuid, plan, operation = null) {
    const scene = await globalThis.fromUuid(String(sceneUuid));
    if (scene?.documentName !== 'Scene') return { ok: false };

    const removeIds = [...plan.orphanWallIds];
    for (const tokenId of plan.removeTokenIds) removeIds.push(...wallIdsForDoor(scene, tokenId));
    const builds = plan.build.map(door => ({
      tokenId: door.tokenId,
      data: door.segments.map(c => ({ ...doorWallData(c, door.tokenId), _id: foundry.utils.randomID() }))
    }));
    await operation?.capture({
      deleting: removeIds.map(id => scene.walls.get(id)).filter(Boolean),
      creating: builds.length
        ? [{ parent: scene, documentName: 'Wall', ids: builds.flatMap(door => door.data.map(wall => wall._id)) }]
        : []
    });
    try {
      if (removeIds.length) await scene.deleteEmbeddedDocuments('Wall', removeIds);
      for (const door of builds) await scene.createEmbeddedDocuments('Wall', door.data, { keepId: true });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'settleDoorWalls');
      return { ok: false };
    }
    return { ok: true };
  }
}

/** One sight-only segment of a locked Door's box, tagged so the next door-sight pass recognizes it. */
function doorWallData(c, tokenId) {
  return {
    c,
    move: CONST.WALL_MOVEMENT_TYPES.NONE,
    sight: CONST.EDGE_SENSE_TYPES.NORMAL,
    light: CONST.EDGE_SENSE_TYPES.NONE,
    sound: CONST.EDGE_SENSE_TYPES.NONE,
    flags: { [SYSTEM_ID]: { [DOOR_WALL_FLAG]: tokenId } }
  };
}

function wallIdsForDoor(scene, tokenId) {
  return collectionValues(scene.walls)
    .filter(wall => String(wall.getFlag(SYSTEM_ID, DOOR_WALL_FLAG) ?? '') === String(tokenId))
    .map(wall => String(wall.id));
}
