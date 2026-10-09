/** @layer engine */
import {
  INTERNAL_COMMAND_IDS,
  MAX_SETTLEMENT_ATTEMPTS
} from '../contracts/commands.mjs';
import { planAuraFields } from '../game/effects/auras.mjs';
import { planTerrainStatFields } from '../game/terrain/rules.mjs';
import { planMoveScalingFields } from '../game/movement/input-policy.mjs';
import { createCommandAuthorization } from './authorization.mjs';
import { planDoorSightReconciliation } from '../game/objects/rules.mjs';
import { accept, refuse, RESULT_CODES } from '../contracts/results.mjs';
import { DOOR_SIGHT_RESOURCE_KEY, MODIFIER_BOARD_RESOURCE_KEYS } from '../contracts/domains/board.mjs';
import { diagnosticData, requirePorts } from '../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Modifier commands                           */
/* -------------------------------------------- */

/**
 * The RECONCILE_MODIFIERS command definition. The hooks in foundry/hooks/board.mjs submit it as maintenance
 * after Token, Item, Actor and Scene changes.
 */
export function createModifierCommandContribution({ actors, authority }) {
  requirePorts('createModifierCommandContribution', { actors });
  return [{
    id: INTERNAL_COMMAND_IDS.BOARD.RECONCILE_MODIFIERS,
    authorize: createCommandAuthorization(authority).activeGm(),
    handler: context => reconcileBoardModifiers(context, actors),
    concurrencyKeys: () => [...MODIFIER_BOARD_RESOURCE_KEYS]
  }];
}

/**
 * Update aura, terrain and movement modifiers for the requested Scene from the game/ plans, with one write per
 * actor. If the scene's auras or terrain changed before the write lands, it reads them again, so separate hook
 * triggers can't overwrite each other's changes. The requested scene is always the one read, never the one the
 * host is viewing.
 */
async function reconcileBoardModifiers(context, actors) {
  const sceneUuid = String(context.payload?.sceneUuid ?? '');
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const auras = await actors.getAuraBoardSnapshot(sceneUuid);
    const terrain = await actors.getTerrainBoardSnapshot(sceneUuid);
    if (!auras || !terrain) return refuse(RESULT_CODES.BOARD_UNAVAILABLE);
    const plans = mergeModifierPlans(planAuraFields(auras), planTerrainStatFields(terrain), planMoveScalingFields(terrain));
    if (!plans.length) return accept(RESULT_CODES.BOARD_MODIFIERS_RECONCILED, { sceneUuid, changed: 0 });
    const committed = await actors.settleModifierFields({
      sceneUuid,
      auraFingerprint: auras.fingerprint,
      terrainFingerprint: terrain.fingerprint
    }, plans, context.operation ?? null);
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) {
      return refuse(RESULT_CODES.BOARD_MODIFIER_SETTLEMENT_FAILED, diagnosticData(committed));
    }
    return accept(RESULT_CODES.BOARD_MODIFIERS_RECONCILED, { changed: plans.length });
  }
  return refuse(RESULT_CODES.BOARD_MODIFIER_SETTLEMENT_FAILED, { reasonCode: 'board.changed' });
}

/** Gather what each unit is owed from auras, terrain and the map's movement scaling, so every unit is written once. */
function mergeModifierPlans(auraPlans, terrainPlans, movementPlans = []) {
  const merged = new Map();
  const entry = actorUuid => {
    if (!merged.has(actorUuid)) merged.set(actorUuid, { actorUuid, aura: null, terrain: null, movement: null });
    return merged.get(actorUuid);
  };
  for (const plan of auraPlans) entry(plan.actorUuid).aura = plan.fields;
  for (const plan of terrainPlans) entry(plan.actorUuid).terrain = plan.fields;
  for (const plan of movementPlans) entry(plan.actorUuid).movement = plan.fields;
  return Object.freeze([...merged.values()].map(plan => Object.freeze(plan)));
}

/* -------------------------------------------- */
/*  Door sight commands                         */
/* -------------------------------------------- */

/**
 * The RECONCILE_DOORS command definition. The vision hooks in foundry/hooks/scene.mjs submit it as maintenance
 * after Object, Token and Scene changes.
 */
export function createDoorSightCommandContribution({ doors, authority }) {
  requirePorts('createDoorSightCommandContribution', { doors });
  return [{
    id: INTERNAL_COMMAND_IDS.VISION.RECONCILE_DOORS,
    authorize: createCommandAuthorization(authority).activeGm(),
    handler: context => reconcileDoorSight(context, doors),
    concurrencyKeys: () => [DOOR_SIGHT_RESOURCE_KEY]
  }];
}

/**
 * Apply game/objects/rules.mjs door-wall plans through the Foundry vision writer.
 * Closed doors need Wall documents for sight blocking. Each scene is handled on its own, including walls left
 * by deleted doors, and one failed scene does not stop the others.
 */
async function reconcileDoorSight(context, doors) {
  const sceneUuids = context.payload?.everyScene === true
    ? await doors.sceneUuids()
    : [String(context.payload?.sceneUuid ?? '')];
  let changed = 0;
  let failure = null;
  let read = false;
  for (const sceneUuid of sceneUuids) {
    const board = await doors.getDoorBoard(sceneUuid);
    if (!board) continue;
    read = true;
    const plan = planDoorSightReconciliation(board);
    const planned = plan.build.length + plan.removeTokenIds.length + plan.orphanWallIds.length;
    if (!planned) continue;
    const settled = await doors.settleDoorWalls(board.sceneUuid, plan, context.operation ?? null);
    if (settled?.ok === true) changed += planned;
    else failure ??= settled;
  }
  if (!read) return refuse(RESULT_CODES.BOARD_UNAVAILABLE);
  if (failure) return refuse(RESULT_CODES.VISION_DOOR_SETTLEMENT_FAILED, { ...diagnosticData(failure), changed });
  return accept(RESULT_CODES.VISION_DOORS_RECONCILED, { changed });
}
