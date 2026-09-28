/** @layer foundry/adapters/projections */
import { doorSightBlocked, doorSightLine } from '../../../game/objects/rules.mjs';
import { DOOR_WALL_FLAG } from '../../../contracts/domains/objects.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { projectActorPartyId, projectUserPartyId } from './parties.mjs';
import { projectActorStatusKeys } from './combat-context.mjs';
import { sceneExplorationActive } from './encounters.mjs';
import { resolveSync, tokenFootprintCells } from '../services/host.mjs';

/* -------------------------------------------- */
/*  Sight facts                                 */
/* -------------------------------------------- */

/**
 * Whether a unit can see the near face of a Door, tested against the Wall documents of their Scene, so it works on
 * a Scene no client is viewing. Returns false when it can't be tested, such as a Door on another Scene. Called by
 * the lock projection in document-writes/objects.mjs and, through projectDoorVisibilityByUuid, by the interaction
 * controls.
 * @param {TokenDocument} sourceToken The acting unit.
 * @param {TokenDocument} doorToken The Door.
 * @returns {boolean}
 */
export function projectDoorVisibility(sourceToken, doorToken) {
  const scene = sourceToken?.parent;
  if (!scene || !doorToken || doorToken.parent !== scene) return false;
  const gridSize = Number(scene.grid?.size) || 0;
  if (!(gridSize > 0)) return false;
  const unitCells = tokenFootprintCells(sourceToken, gridSize);
  const doorCells = tokenFootprintCells(doorToken, gridSize);
  if (!unitCells.length || !doorCells.length) return false;
  const line = doorSightLine({ unitCells, doorCells, gridSize });
  if (!line) return true;
  return !doorSightBlocked({ line, walls: sceneSightWalls(scene, doorToken) });
}

/** The Scene's sight-blocking wall segments, leaving out open doors, see-through walls and the Door's own walls. */
function sceneSightWalls(scene, doorToken) {
  const unrestricted = CONST.EDGE_SENSE_TYPES.NONE;
  const open = CONST.WALL_DOOR_STATES.OPEN;
  const ownTokenId = String(doorToken.id ?? '');
  const segments = [];
  for (const wall of collectionValues(scene.walls)) {
    const source = wall?._source ?? wall;
    if (Number(source.sight ?? 0) === unrestricted) continue;
    if ((Number(source.door) || 0) && (Number(source.ds) || 0) === open) continue;
    if (ownTokenId && String(wall.getFlag?.(SYSTEM_ID, DOOR_WALL_FLAG) ?? '') === ownTokenId) continue;
    const coordinates = Array.isArray(source.c) ? source.c.slice(0, 4).map(Number) : [];
    if (coordinates.length === 4 && coordinates.every(Number.isFinite)) segments.push(coordinates);
  }
  return segments;
}

/** projectDoorVisibility by Token uuids, for ui/controls/interaction.mjs, which holds board data, not documents. */
export function projectDoorVisibilityByUuid(sourceTokenUuid, doorTokenUuid) {
  return projectDoorVisibility(resolveSync(sourceTokenUuid, 'Token'), resolveSync(doorTokenUuid, 'Token'));
}

/**
 * One unit's faction and party, which the party sight pool in foundry/patches/vision.mjs compares.
 * @returns {{actorType: string, partyId: string|null}}
 */
export function projectPartySightFacts(actor) {
  const system = actor?.system ?? {};
  return {
    actorType: String(system.faction?.role ?? ''),
    partyId: projectActorPartyId(actor)
  };
}

/**
 * Whether the local user is a GM, their party, and the faction and party of each token they have selected, for
 * the party sight pool in foundry/patches/vision.mjs.
 * @returns {{isGM: boolean, userPartyId: string|null, controlled: object[]}}
 */
export function projectSightPoolContext() {
  const controlled = (globalThis.canvas?.tokens?.controlled ?? [])
    .map(token => projectPartySightFacts(token?.actor));
  return {
    isGM: game.user?.isGM === true,
    userPartyId: projectUserPartyId(String(game.user?.id ?? '')),
    controlled
  };
}

/** Whether an actor is blinded, by an effect's status or by its compiled `system.statuses.blinded`. */
export function projectSightBlinded(actor) {
  if (!actor) return false;
  return projectActorStatusKeys(actor).has('blinded') || actor.system?.statuses?.blinded === true;
}

/** The extra sight range an actor's modifiers grant, in squares. */
export function projectSightBonusSquares(actor) {
  const bonus = Number(actor?.system?.stats?.sight?.total);
  return Number.isFinite(bonus) ? bonus : 0;
}

/**
 * The facts that decide where a unit's vision is measured from. While it plans a move, vision stays at the movement
 * anchor so a previewed step can't reveal new ground, but during exploration moves are committed at once and vision
 * follows the token. committedSightAnchor (game/vision/sight.mjs) makes that choice for foundry/patches/vision.mjs.
 * @returns {{planning: boolean, exploring: boolean, anchor: {x: number, y: number}}}
 */
export function projectSightAnchorFacts(tokenDocument) {
  const turn = tokenDocument?.actor?.system?.turn ?? {};
  return {
    planning: turn.movementPlanning === true,
    exploring: sceneExplorationActive(tokenDocument?.parent),
    anchor: {
      x: Number(turn.movementAnchorX) || 0,
      y: Number(turn.movementAnchorY) || 0
    }
  };
}

/**
 * Plain-value vision inputs for one token: its anchor facts, blindness, light, footprint and vision source data.
 * foundry/patches/vision.mjs compares them with the last set it saw and skips re-initializing the token's vision
 * source when nothing changed.
 * @param {Token} token The Token placeable.
 * @param {{deleted?: boolean, sourceId?: number|null, invalidation?: number}} [context]
 * @returns {Readonly<object>}
 */
export function projectSightReinitializationFacts(token, { deleted = false, sourceId = null, invalidation = 0 } = {}) {
  const document = token?.document;
  const anchor = projectSightAnchorFacts(document);
  const light = document?.light ?? {};
  const blinded = { ...(token?._getVisionBlindedStates?.() ?? {}), emblem: projectSightBlinded(document?.actor) };
  return Object.freeze({
    deleted: deleted === true,
    preview: token?.isPreview === true,
    emitsLight: Number(light.dim) > 0 || Number(light.bright) > 0,
    planning: anchor.planning,
    exploring: anchor.exploring,
    eligible: token?._isVisionSource?.() === true,
    sourceId: sourceId ?? null,
    invalidation: Number(invalidation) || 0,
    visible: token?.visible === true,
    data: Object.freeze(primitiveRecord({
      ...(token?._getVisionSourceData?.() ?? {}),
      footprintWidth: Number(document?.width) || 1,
      footprintHeight: Number(document?.height) || 1
    })),
    blinded: Object.freeze(primitiveRecord(blinded))
  });
}

function primitiveRecord(record) {
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === 'object') out[key] = String(value.id ?? value.valueOf?.() ?? value);
    else out[key] = value;
  }
  return out;
}
