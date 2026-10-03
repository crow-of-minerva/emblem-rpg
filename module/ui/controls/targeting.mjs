/** @layer ui/controls */
import {
  clearFoundryActiveItem,
  projectFoundryAttackItem,
  projectFoundryAttackGrid,
  projectFoundryAttackTarget,
  projectFoundryCombatPreview,
  projectFoundryDestructiblePreview,
  projectHotbarAttackActivation,
  restoreFoundryAimFacing,
  stageFoundryActiveItem,
  turnFoundryAimFacing
} from '../../foundry/adapters/projections/attack-targeting.mjs';
import {
  activationRequiredProficiency,
  activationRequirements,
  activationTargetFactionAllowed,
  buildActivationTargetingGrid,
  explorationAllowsItem,
  validateActivationLegality,
  validateActivationParams,
  validateActivationReach,
  validateActivationRequirements,
  validateActivationTargets,
  validateForcedMovementSquare,
  validateGroundPlacement,
  validateMountActivation
} from '../../game/items/activation.mjs';
import {
  projectActivationAim,
  projectActivationGrid,
  projectActivationPreview,
  projectActivationRay,
  projectActivationTargetFacts,
  projectCaughtUnits,
  projectHotbarActivation
} from '../../foundry/adapters/projections/items.mjs';
import {
  buildAttackTargetingGrid,
  validateAttackActivation,
  validateAttackSnapshot,
  validateAttackTarget
} from '../../game/targeting/attack-grid.mjs';
import {
  clearActivationAreaOverlay,
  clearAttackTargetingGrid,
  clearRallySupportBadges,
  disposeAttackTargetingPresentation,
  drawActivationAreaOverlay,
  drawAttackTargetingGrid,
  drawRallySupportBadges,
  markTargetedTokens,
  PLACEMENT_GRID_COLOR,
  targetingGridColor
} from '../../presentation/canvas/cell-overlays.mjs';
import { findPromptGeometryStep, normalizeGeometry } from '../../contracts/dsl/terrain-geometry.mjs';
import { isMagicItem } from '../../game/effects/requirements.mjs';
import { geometryPlacementBudget, resolveGeometryPlacements } from '../../game/targeting/shapes.mjs';
import { footprintCells } from '../../lib/core/geometry.mjs';
import { areFactionsFriendly } from '../../game/character/rules.mjs';
import { EQUIPMENT_NOTICES, isEquipOnlyItem } from '../../game/character/inventory.mjs';
import {
  canRallyTarget,
  rallyCasterFacts,
  rallyRankFor,
  rallyTargetBlocker,
  supportRankLetter
} from '../../game/support/rules.mjs';
import { playUiSound } from '../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../presentation/audio/sound-database.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../presentation/interface/notifications.mjs';
import { openCombatPreview, openDestructiblePreview, openEffectPreview } from '../apps/menus/previews.mjs';
import { isStealAbility } from '../../game/economy/trade.mjs';
import { localUserFrozenByPause, resolveItem } from '../../foundry/adapters/services/host.mjs';
import { sceneExplorationActive } from '../../foundry/adapters/projections/encounters.mjs';
import { redirectFoundryFixtureToken } from '../../foundry/adapters/projections/tokens.mjs';
import { projectForcedMovementBoards, projectGeometryResolver } from '../../foundry/adapters/projections/movement.mjs';
import { projectGeometrySight } from '../../foundry/adapters/projections/terrain.mjs';
import { runSteal } from './interaction.mjs';
import { openBlockingDialog } from '../dialogs.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { reportFoundryError, FoundryDiagnostics } from '../../foundry/adapters/services/diagnostics.mjs';
import {
  TARGETING_EVENTS,
  TARGETING_STATES,
  activePlacement,
  activeTargeting,
  advanceTargeting,
  targetingIsActivation,
  targetingIsOpening,
  targetingIsPlacing,
  targetingStateName
} from './targeting-state.mjs';

/* -------------------------------------------- */
/*  Targeting state                             */
/* -------------------------------------------- */

/*
 * Attack and activation targeting: ready the Item, draw its grid, collect the target or square, and send the
 * command. Which step this client is on lives in ui/controls/targeting-state.mjs. init/system.mjs plugs in the
 * movement, combat and path-arrow helpers below through configureAttackTargetingControls; until then they throw.
 */
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });
const PORT_METHODS = Object.freeze({
  movement: Object.freeze(['inspect', 'settle', 'suspend', 'resume', 'cancel']),
  combat: Object.freeze(['snapshot']),
  indicator: Object.freeze(['hold'])
});
let movement = unconfiguredPort('movement');
let combat = unconfiguredPort('combat');
let indicator = unconfiguredPort('indicator');

/** Whether any targeting (an attack or an activation) is open and owns canvas clicks. */
export function isAttackTargetingActive() {
  return targetingStateName() !== TARGETING_STATES.IDLE;
}

/* -------------------------------------------- */
/*  Composition                                 */
/* -------------------------------------------- */
/**
 * Plug in the helpers targeting needs: the movement plan controls, the combat data for previews, and the unit's
 * path arrow. init/system.mjs calls this once at start-up. Movement comes in this way because movement.mjs imports
 * this file.
 */
export function configureAttackTargetingControls(configuration = {}) {
  movement = configuredPort('movement', configuration.movement);
  combat = configuredPort('combat', configuration.combat);
  indicator = configuredPort('indicator', configuration.indicator);
}

/** A stand-in whose methods all throw, so missing wiring shows up as an error rather than as a refused gesture. */
function unconfiguredPort(name) {
  return Object.freeze(Object.fromEntries(PORT_METHODS[name].map(method => [method, () => {
    throw new Error(`ui/controls/targeting.mjs: ${name}.${method} was used before `
      + 'init/system.mjs called configureAttackTargetingControls.');
  }])));
}

/** The supplied helpers, with any method left out still throwing rather than giving a false answer. */
function configuredPort(name, supplied) {
  return Object.freeze({ ...unconfiguredPort(name), ...supplied });
}

/* -------------------------------------------- */
/*  Activation                                  */
/* -------------------------------------------- */
/**
 * Enter attack targeting with an Item when the live state still allows it. Called by activateHotbarItem, and with
 * an Armament after takeUpArmament in interaction.mjs.
 *
 * A unit standing on another unit's square is refused here, before the Item is readied: it could not end its move
 * there, so the host would refuse the exchange anyway.
 * @param {string} itemUuid UUID of the Item in the pressed BG3 hotbar cell, or of the Armament token the unit has
 *   just taken up.
 * @param {string} [cellId] Address of the activated cell, so one Item in several slots marks only the used one.
 * @returns {Promise<boolean>} Whether targeting was entered or was already active for this Item.
 */
export async function activateAttackItemFromHotbar(itemUuid, cellId = '') {
  const current = activeTargeting();
  if (current?.activationItemUuid === itemUuid && current.cellId === cellId && !targetingIsOpening()) return true;
  const localPlan = movement.inspect();
  if (localPlan?.squareShared === true) return refuseTargeting('square-shared');
  let entry = await projectAttackEntry(itemUuid, localPlan);
  if (entry.reason) return refuseTargeting(entry.reason, entry.payload);

  const swapping = Boolean(current);
  const swapTokenUuid = entry.activation.tokenUuid;
  if (current) await leaveAttackTargeting(current, { resume: false, clearItem: true });
  if (entry.activation.needsWield) {
    const result = await game.emblemRpg.api.character.inventory.toggleEquipment({
      actorUuid: entry.activation.actorUuid,
      itemId: entry.activation.itemId
    });
    if (!result.ok) {
      notifications.showResult(result);
      return abandonEntry(swapping, swapTokenUuid);
    }
    entry = await projectAttackEntry(itemUuid, movement.inspect());
    if (entry.reason) return abandonEntry(swapping, swapTokenUuid, entry.reason);
  }

  const entered = await enterAttackFrame(entry.activation, cellId);
  if (entered.reason === 'movement-plan-required') return refuseTargeting(entered.reason);
  if (entered.reason) return abandonEntry(swapping, swapTokenUuid, entered.reason);
  playTargetingSound(SOUND_IDS.UI_SELECT);
  return true;
}

/**
 * Read an attack Item and judge it as a hotbar press does, without readying or writing anything. The hotbar press
 * uses it before and after wielding, and the Combat Preview uses it to judge each weapon in its list.
 * @param {string} itemUuid The pressed Item: a weapon or a Weapon Art.
 * @param {object|null} plan The movement plan open on this client.
 * @param {string} [weaponId] A carried weapon to judge a Weapon Art with in place of the wielded one.
 * @returns {Promise<{activation: object|null, reason: string, payload: object|null}>} `reason` is empty when the
 *   Item may attack.
 */
async function projectAttackEntry(itemUuid, plan, weaponId = '') {
  const activation = await projectHotbarAttackActivation(itemUuid, plan, { weaponId });
  if (!activation) return { activation: null, reason: 'item-missing', payload: null };
  const verdict = validateAttackActivation(activation.facts);
  return { activation, reason: verdict.ok ? '' : verdict.reason, payload: activation.notificationData };
}

/**
 * Make a judged attack the unit's active Item, draw its grid and open it as the targeting frame. The hotbar press
 * aims through here, and so does a weapon picked in the Combat Preview (swapPreviewWeapon).
 * @param {object} activation projectHotbarAttackActivation's answer, already judged by projectAttackEntry.
 * @param {string} cellId The hotbar cell that aimed, or empty for a preview pick.
 * @returns {Promise<{frame?: object, reason?: string}>} The open frame, or why none opened.
 */
async function enterAttackFrame(activation, cellId) {
  const context = Object.freeze({
    tokenUuid: activation.tokenUuid,
    actorUuid: activation.actorUuid,
    itemUuid: activation.itemUuid,
    itemId: activation.itemId,
    activationItemUuid: activation.activationItemUuid,
    weaponArtUuid: activation.weaponArtUuid,
    weaponArtId: activation.weaponArtId,
    cellId: String(cellId ?? ''),
    armament: activation.armament === true
  });
  if (!await stageFoundryActiveItem(context)) return { reason: 'item-missing' };

  const snapshot = await game.emblemRpg.api.movement.getPlan(context.tokenUuid);
  const projection = await projectFoundryAttackGrid(context, snapshot);
  const grid = projection ? buildAttackTargetingGrid(projection) : null;
  if (!snapshot?.movementPlanning || !projection || !grid) {
    await clearFoundryActiveItem(context);
    return { reason: 'range-invalid' };
  }
  if (!movement.suspend(context.tokenUuid)) {
    await clearFoundryActiveItem(context);
    return { reason: 'movement-plan-required' };
  }

  const frame = {
    ...context,
    source: Object.freeze({ ...projection.source }),
    grid: Object.freeze({
      gridSize: projection.gridSize,
      color: targetingGridColor(projection.gridColor),
      targetableCells: grid.targetableCells,
      targetableKeys: grid.targetableKeys,
      flyersOnlyKeys: grid.flyersOnlyKeys
    })
  };
  advanceTargeting(TARGETING_EVENTS.AIM, { frame });
  drawAttackTargetingGrid(frame.grid);
  return { frame };
}

/**
 * Route a pressed BG3 hotbar cell (through the BG3 HUD adapter set up in init/system.mjs), or an Item used from
 * the character sheet, to the targeting mode its Item belongs to. Gear that is only worn takes no aim and equips
 * in place instead.
 * @param {string} itemUuid UUID of the Item in the pressed cell.
 * @param {string} [cellId] Address of the activated cell, forwarded to whichever targeting mode takes it.
 * @returns {Promise<boolean>} Whether a targeting mode was entered or the press equipped the Item.
 */
export async function activateHotbarItem(itemUuid, cellId = '') {
  if (localUserFrozenByPause()) return refuseTargeting(RESULT_CODES.COMMAND_TABLE_PAUSED);
  await movement.settle(movement.inspect()?.tokenUuid ?? '');
  const item = await resolveItem(itemUuid);
  if (isEquipOnlyItem(item)) return toggleHotbarEquipment(item);
  if (explorationForbids(item)) {
    notifications.show(NOTIFICATION_IDS.ITEM_ACTIVATION_EXPLORATION_FORBIDDEN);
    return true;
  }
  const stealItem = stealAbility(item);
  if (stealItem) {
    const { inspect, suspend, resume } = movement;
    const plan = inspect();
    return runSteal(plan, { inspect, suspend, resume, activation: stealActivation(plan, stealItem, cellId) });
  }
  const activation = await projectHotbarActivation(itemUuid);
  return activation
    ? activateEffectItemFromHotbar(itemUuid, cellId)
    : activateAttackItemFromHotbar(itemUuid, cellId);
}

/**
 * Put on or take off the gear a hotbar cell shows. A shield or accessory has no targeting of its own, so its cell
 * is an equip toggle, which character.inventory.toggleEquipment holds to the unit's owner and its running turn.
 * Equipping a shield can free the hand a two-handed weapon needed, which ends any aim that weapon had opened.
 * @param {object} item The live Item the pressed cell shows.
 * @returns {Promise<boolean>} Whether the unit's equipment changed.
 */
async function toggleHotbarEquipment(item) {
  const actorUuid = String(item?.actor?.uuid ?? '');
  if (!actorUuid) return refuseTargeting('item-missing');
  const result = await game.emblemRpg.api.character.inventory.toggleEquipment({
    actorUuid,
    itemId: String(item.id ?? '')
  });
  if (!result?.ok) {
    notifications.showResult(result);
    return false;
  }
  if (result.data?.notices?.includes(EQUIPMENT_NOTICES.TWO_HANDED_UNWIELDED)) {
    notifications.show(NOTIFICATION_IDS.INVENTORY_TWO_HANDED_UNWIELDED);
    if (isAttackTargetingActive()) await cancelAttackTargeting();
  }
  playTargetingSound(SOUND_IDS.UI_BLIP_1);
  return true;
}

/* -------------------------------------------- */
/*  Target clicks                               */
/* -------------------------------------------- */
/**
 * Take a token left-click while attack or activation targeting is open. The Token#_onClickLeft wrapper in
 * foundry/patches/token-drag.mjs asks this. A click on scenery is refused with the error cue alone.
 */
export function onTokenClickAttackTargeting(targetToken) {
  const current = activeTargeting();
  if (!current || targetingIsOpening()) return Boolean(current);
  if (redirectFoundryFixtureToken(targetToken).refused) return refuseTargeting('target-fixture') || true;
  if (targetingIsActivation()) {
    if (current.envelope.aimed) return true;
    void collectActivationTarget(current, targetToken);
    return true;
  }
  advanceTargeting(TARGETING_EVENTS.OPEN);
  void openPreviewForTarget(current, targetToken);
  return true;
}

/**
 * Redraw open targeting when other tokens on its Scene move (the overlay refresh in init/hooks.mjs), without
 * replaying the activation or changing a confirmed request.
 */
export async function refreshTargetingOverlays({ sceneUuid, tokenUuids }, valid) {
  const current = activeTargeting();
  if (!current || targetingIsOpening() || !current.tokenUuid.startsWith(`${sceneUuid}.Token.`)
    || !tokenUuids.some(uuid => uuid !== current.tokenUuid)) return false;
  if (targetingIsActivation()) {
    const fresh = await projectActivationGrid(current);
    if (!fresh || activeTargeting() !== current || !valid()) return false;
    const context = { ...current, ...fresh };
    const selected = [];
    for (const previous of current.selected) {
      const target = await projectActivationTargetFacts(context, { uuid: previous.tokenUuid });
      if (activeTargeting() !== current || targetingIsOpening() || !valid()) return false;
      if (!target) continue;
      const reach = validateActivationReach({ envelope: context.envelope, source: context.source,
        footprint: context.source.footprint, columns: context.columns, rows: context.rows, sight: context.sight,
        targets: [target] });
      const selection = [...selected, target];
      if (reach.ok && validateActivationTargets(context.envelope, context.actorUuid, selection, context.source).ok) {
        selected.push(target);
      }
    }
    current.units = fresh.units;
    current.source = fresh.source;
    current.columns = fresh.columns;
    current.rows = fresh.rows;
    current.sight = fresh.sight;
    current.grid = activationGrid(fresh);
    current.selected = selected;
    drawAttackTargetingGrid(current.grid);
    if (current.envelope.rally) drawRallySupportBadges(rallyBadgeEntries(current));
    markSelectedTargets(current);
    return true;
  }
  const snapshot = await game.emblemRpg.api.movement.getPlan(current.tokenUuid);
  const projection = snapshot ? await projectFoundryAttackGrid(current, snapshot) : null;
  if (!projection || activeTargeting() !== current || !valid()) return false;
  const grid = buildAttackTargetingGrid(projection);
  current.grid = Object.freeze({ gridSize: projection.gridSize, color: targetingGridColor(projection.gridColor),
    targetableCells: grid.targetableCells, targetableKeys: grid.targetableKeys, flyersOnlyKeys: grid.flyersOnlyKeys });
  drawAttackTargetingGrid(current.grid);
  return true;
}


/** Leave targeting and send the confirmed exchange. The host's answer says whether the unit may move on afterwards. */
async function commitConfirmedExchange(current, targetTokenUuid, { damageType, skippedAttacks, previewFingerprint }) {
  await leaveAttackTargeting(current, { resume: false, clearItem: false });
  try {
    await indicator.hold(current.tokenUuid, true);
    const result = await game.emblemRpg.api.combat.resolveExchange({
      sourceTokenUuid: current.tokenUuid,
      targetTokenUuid,
      itemUuid: current.itemUuid,
      damageType,
      skippedAttacks,
      previewFingerprint,
      weaponArtUuid: current.weaponArtUuid
    });
    await restoreFoundryAimFacing(current.tokenUuid);
    if (!result.ok) {
      await clearFoundryActiveItem(current);
      await movement.resume(current.tokenUuid);
      notifications.showResult(result);
      return;
    }
    const continuation = await settleTurnContinuation(current, result.data?.continuation);
    await clearFoundryActiveItem(current);
    if (continuation?.resumesMovement === true) {
      await movement.resume(current.tokenUuid, { announce: continuation.reselects === true });
    }
  } finally { await indicator.hold(current.tokenUuid, false); }
}

/**
 * Turn the aiming unit toward its target on this client only. It turns back to its saved facing when targeting ends
 * without an attack, and as soon as the host answers one, since the host sets the real facing.
 */
function faceAimedTarget(current, targetTokenUuid) {
  void turnFoundryAimFacing(current.tokenUuid, targetTokenUuid).catch((diagnosticError) => {
    reportFoundryError(import.meta.url, diagnosticError, 'faceAimedTarget');
    return false;
  });
}

/**
 * Open the Combat or Destructible preview for a clicked target, once the grid is confirmed to be current. In the
 * Combat Preview the player can switch weapon or damage type through refreshCombatPreview, which may aim with a new
 * frame, so `view.frame` is the frame the preview belongs to now. A confirmed preview sends the exchange through
 * commitConfirmedExchange.
 */
async function openPreviewForTarget(current, targetToken) {
  const view = {
    frame: current, tokenUuid: current.tokenUuid, actorUuid: current.actorUuid, weaponId: current.itemId,
    itemUuid: current.itemUuid, weaponArtUuid: current.weaponArtUuid, targetToken, targetTokenUuid: '',
    targetableKeys: null, snapshot: null, refusal: null, closed: false
  };
  let confirmedExchange = false;
  try {
    const snapshot = await game.emblemRpg.api.movement.getPlan(current.tokenUuid);
    const projection = await projectFoundryAttackGrid(current, snapshot);
    const freshGrid = projection ? buildAttackTargetingGrid(projection) : null;
    if (!snapshot?.movementPlanning || !projection || !freshGrid || !sameCell(current.source, projection.source)) {
      if (activeTargeting() === current) await cancelAttackTargeting();
      refuseTargeting('targeting-stale');
      return;
    }
    const target = await projectFoundryAttackTarget(current, targetToken);
    const verdict = validateAttackTarget({
      ...target,
      targetableKeys: freshGrid.targetableKeys
    });
    if (!verdict.ok) {
      refuseTargeting(verdict.reason);
      return;
    }

    const targetTokenUuid = String(target?.targetTokenUuid ?? '');
    Object.assign(view, { targetTokenUuid, targetableKeys: freshGrid.targetableKeys });
    faceAimedTarget(current, targetTokenUuid);
    if (target.targetObject === true) {
      const objectSnapshot = await combat.snapshot({
        sourceTokenUuid: current.tokenUuid,
        targetTokenUuid,
        itemUuid: current.itemUuid,
        damageType: '',
        weaponArtUuid: current.weaponArtUuid
      });
      const objectPreview = await projectFoundryDestructiblePreview(objectSnapshot);
      if (!objectPreview) {
        refuseTargeting('preview-unavailable');
        return;
      }
      const objectChoice = await openDestructiblePreview(objectPreview);
      if (!objectChoice?.confirmed) return;
      confirmedExchange = true;
      await commitConfirmedExchange(current, targetTokenUuid, {
        damageType: objectPreview.damageType,
        skippedAttacks: [],
        previewFingerprint: objectSnapshot.fingerprint ?? ''
      });
      return;
    }
    view.snapshot = await combat.snapshot({
      sourceTokenUuid: current.tokenUuid,
      targetTokenUuid,
      itemUuid: current.itemUuid,
      damageType: '',
      weaponArtUuid: current.weaponArtUuid
    });
    const judged = validateAttackSnapshot(view.snapshot);
    if (!judged.ok) {
      refuseTargeting(judged.reason, snapshotNames(view.snapshot));
      return;
    }
    const preview = await projectFoundryCombatPreview(view.snapshot);
    if (!preview) {
      refuseTargeting('preview-unavailable');
      return;
    }
    const choice = await openCombatPreview(await withUsableWeapons(view, preview), {
      resolvePreview: choices => refreshCombatPreview(view, choices)
    });
    view.closed = true;
    if (!choice?.confirmed || !view.frame) return;
    confirmedExchange = true;
    await commitConfirmedExchange(view.frame, targetTokenUuid, {
      damageType: choice.damageType,
      skippedAttacks: choice.skippedAttacks,
      previewFingerprint: view.snapshot?.fingerprint ?? ''
    });
  } catch (error) {
    if (confirmedExchange) {
      await clearFoundryActiveItem(view.frame);
      await restoreFoundryAimFacing(view.tokenUuid);
      await movement.resume(view.tokenUuid);
    }
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Attack targeting failed');
  } finally {
    view.closed = true;
    await settleClosedPreview(view, confirmedExchange);
  }
}

/**
 * Answer a weapon or damage type picked in the open Combat Preview. openCombatPreview (ui/apps/menus/previews.mjs)
 * renders the answer in place: `restore` when the pick changed nothing, otherwise the new `preview` and a `notice`.
 * A notice is why the host would refuse this attack, and the window keeps Attack disabled while it shows. If a
 * failure ended the preview's targeting, its frame is dropped, so closing the window still hands the unit back.
 * @param {object} view The open preview's state from openPreviewForTarget.
 * @param {{weaponId: string|null, damageType: string}} choices What the window shows picked.
 * @returns {Promise<{restore?: boolean, preview?: object|null, notice?: string}>}
 */
async function refreshCombatPreview(view, choices) {
  try {
    if (choices.weaponId && choices.weaponId !== view.weaponId && !await swapPreviewWeapon(view, choices.weaponId)) {
      return { restore: true };
    }
    return await previewForFrame(view, choices.damageType);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Refresh combat preview');
    if (view.frame && activeTargeting() !== view.frame) {
      view.frame = null;
      if (view.closed) await settleClosedPreview(view, false);
    }
    return { preview: null, notice: targetingMessage('preview-unavailable') };
  }
}

/**
 * Switch the open Combat Preview to a weapon picked in it, as a hotbar press would: judge it, wield it, then aim
 * with it, keeping any Weapon Art in use. The old frame is marked `swapping` while its weapon is put away, so
 * onTargetingSourceChanged doesn't end this aim. If the unit then can't aim with the new weapon, `view.refusal`
 * says why.
 * @returns {Promise<boolean>} Whether the unit now holds the picked weapon.
 */
async function swapPreviewWeapon(view, weaponId) {
  const selected = await projectFoundryAttackItem(view.actorUuid, weaponId);
  if (!selected) return refuseTargeting('item-missing');
  const activationUuid = view.weaponArtUuid || selected.itemUuid;
  const check = await projectAttackEntry(activationUuid, movement.inspect(), selected.itemId);
  if (check.reason) return refuseTargeting(check.reason, check.payload);
  const previous = view.frame;
  if (!selected.wielded) {
    if (previous) previous.swapping = true;
    let result;
    try {
      result = await game.emblemRpg.api.character.inventory.toggleEquipment({
        actorUuid: view.actorUuid,
        itemId: selected.itemId
      });
    } finally {
      if (previous) previous.swapping = false;
    }
    if (!result.ok) {
      notifications.showResult(result);
      return false;
    }
  }
  Object.assign(view, { weaponId: selected.itemId, itemUuid: selected.itemUuid, refusal: null });
  if (previous) {
    await leaveAttackTargeting(previous, { resume: false, clearItem: false });
    await clearFoundryActiveItem(previous);
  }
  const entry = await projectAttackEntry(activationUuid, movement.inspect());
  const entered = entry.reason ? entry : await enterAttackFrame(entry.activation, '');
  view.frame = entered.frame ?? null;
  if (view.frame) {
    view.targetableKeys = view.frame.grid.targetableKeys;
    if (!view.closed) advanceTargeting(TARGETING_EVENTS.OPEN);
  } else {
    view.refusal = { reason: entered.reason, payload: entered.payload ?? null };
    if (view.closed) await settleClosedPreview(view, false);
  }
  return true;
}

/**
 * Work out the exchange with the weapon the unit now holds, for refreshCombatPreview. The clicked target is judged
 * against the frame's grid as a click is, then the combat data as the host will judge it. The first refusal becomes
 * the notice, and the numbers still show, so a weapon that can't reach says why.
 */
async function previewForFrame(view, damageType) {
  let refusal = view.refusal;
  if (view.frame) {
    const target = await projectFoundryAttackTarget(view.frame, view.targetToken);
    const verdict = validateAttackTarget({ ...target, targetableKeys: view.targetableKeys });
    if (!verdict.ok) refusal = { reason: verdict.reason, payload: null };
  }
  view.snapshot = await combat.snapshot({
    sourceTokenUuid: view.tokenUuid,
    targetTokenUuid: view.targetTokenUuid,
    itemUuid: view.itemUuid,
    damageType,
    weaponArtUuid: view.weaponArtUuid
  });
  const judged = validateAttackSnapshot(view.snapshot);
  if (!refusal && !judged.ok) refusal = { reason: judged.reason, payload: snapshotNames(view.snapshot) };
  const preview = await projectFoundryCombatPreview(view.snapshot, damageType);
  if (!preview) return { preview: null, notice: targetingMessage('preview-unavailable') };
  return {
    preview: await withUsableWeapons(view, preview),
    notice: refusal ? targetingMessage(refusal.reason, refusal.payload) : ''
  };
}

/**
 * Keep in the preview's weapon list only the weapons a hotbar press would accept for this attack, judged by
 * projectAttackEntry with the frame's Weapon Art when one is in use. calculateAttackPreview has already kept the
 * weapons that reach and that the unit has the rank for. The weapon in hand always stays.
 */
async function withUsableWeapons(view, preview) {
  const plan = movement.inspect();
  const usable = [];
  for (const weapon of preview.attacker.validWeapons) {
    if (weapon.id === view.weaponId || await weaponUsable(view, weapon.id, plan)) usable.push(weapon);
  }
  return { ...preview, attacker: { ...preview.attacker, validWeapons: usable } };
}

/** Whether a carried weapon passes projectAttackEntry for this attack, with the frame's Weapon Art if any. */
async function weaponUsable(view, weaponId, plan) {
  const item = await projectFoundryAttackItem(view.actorUuid, weaponId);
  if (!item) return false;
  const entry = await projectAttackEntry(view.weaponArtUuid || item.itemUuid, plan, item.itemId);
  return !entry.reason;
}

/**
 * Step targeting back once the Combat Preview has closed without an exchange: to aiming with the frame it ended on,
 * or, when a weapon picked in it could not aim, out of targeting with the unit turned back and its plan resumed.
 */
async function settleClosedPreview(view, confirmed) {
  if (view.frame) {
    if (activeTargeting() === view.frame) advanceTargeting(TARGETING_EVENTS.CLOSE);
  } else if (!confirmed) {
    await restoreFoundryAimFacing(view.tokenUuid);
    await movement.resume(view.tokenUuid);
  }
}

/** The weapon and Weapon Art names targetingMessage uses to word a refusal from the combat data. */
function snapshotNames(snapshot) {
  return {
    itemName: String(snapshot?.source?.weapon?.name ?? ''),
    weaponArtName: String(snapshot?.source?.weaponArt?.name ?? '')
  };
}

async function settleTurnContinuation(current, continuation) {
  if (continuation?.requiresChoice !== true) return continuation ?? null;
  const choice = await openBlockingDialog({
    title: 'Extra Action',
    content: 'Use Extra Action?',
    dialogClass: 'confirm-movement-vertical',
    buttons: [
      {
        action: 'extraAction',
        label: 'Use Extra Action',
        default: true,
        callback: () => {
          playTargetingSound(SOUND_IDS.UI_CONFIRM);
          return 'extra-action';
        }
      },
      {
        action: 'endTurn',
        label: 'End Turn',
        callback: () => 'end-turn'
      }
    ]
  });
  const result = await game.emblemRpg.api.combat.resolveContinuation({
    sourceTokenUuid: current.tokenUuid,
    exchangeRequestId: continuation.exchangeRequestId,
    decision: choice === 'extra-action' ? 'extra-action' : 'end-turn'
  });
  if (!result.ok) {
    notifications.showResult(result);
    return null;
  }
  return result.data?.continuation ?? null;
}

/* -------------------------------------------- */
/*  Activation targeting                        */
/* -------------------------------------------- */
/**
 * Enter effect targeting for the hotbar Item. A self-targeted Item goes straight to confirmation. Other Items
 * collect a square, units or a line first. A unit sharing another unit's square is refused before the Item is
 * readied.
 * @param {string} itemUuid UUID of the Item in the pressed cell.
 * @param {string} [cellId] Address of the activated cell, so one Item in several slots marks only the used one.
 * @returns {Promise<boolean>} Whether targeting was entered, or the activation already resolved.
 */
async function activateEffectItemFromHotbar(itemUuid, cellId = '') {
  const current = activeTargeting();
  if (targetingIsActivation() && current.itemUuid === itemUuid
      && current.cellId === cellId && !targetingIsOpening()) return true;
  if (movement.inspect()?.squareShared === true) return refuseTargeting('square-shared');
  const projected = await projectHotbarActivation(itemUuid);
  const context = projected ? Object.freeze({ ...projected, cellId: String(cellId ?? '') }) : null;
  if (!context) return refuseTargeting('item-missing');
  const verdict = validateActivationLegality({
    envelope: context.envelope,
    controlled: true,
    turnOver: context.source.turnOver,
    standardAvailable: context.source.standardAvailable,
    bonusAvailable: context.source.bonusAvailable,
    magicBlocked: context.source.magicBlocked,
    magical: isMagicItem({
      type: context.source.conditionItem?.type,
      requiredProficiency: activationRequiredProficiency(context.source.conditionItem)
    }),
    stanceAvailable: context.source.stanceAvailable,
    item: context.source.conditionItem,
    proficiencyTotal: context.source.proficiency?.total,
    locked: context.source.lockedItems.includes(context.itemUuid)
  });
  if (!verdict.ok) return refuseTargeting(verdict.code, verdict.data);
  const authored = validateActivationRequirements({
    requirements: activationRequirements(context.source.conditionItem),
    itemType: context.source.conditionItem?.type,
    requiredProficiency: activationRequiredProficiency(context.source.conditionItem),
    source: context.source,
    resolveTerrainGeometry: activationGeometryResolver(context)
  });
  if (!authored.ok) return refuseTargeting(authored.code);
  const swapping = Boolean(current);
  if (current) await leaveAttackTargeting(current, { resume: false, clearItem: true });
  if (!await stageFoundryActiveItem(context)) return abandonEntry(swapping, context.tokenUuid, 'item-missing');
  if (!movement.suspend(context.tokenUuid)) {
    await clearFoundryActiveItem(context);
    return refuseTargeting('movement-plan-required');
  }

  const grid = activationGrid(context);
  const state = { ...context, grid, selected: [] };
  if (context.envelope.selfTargeted) {
    advanceTargeting(TARGETING_EVENTS.ACTIVATE, { frame: state });
    void resolveActivation(state, { targets: [context.source], aimUuids: [context.source.tokenUuid] });
    return true;
  }
  advanceTargeting(TARGETING_EVENTS.ACTIVATE, { frame: state });
  drawAttackTargetingGrid(grid);
  if (context.envelope.rally) drawRallySupportBadges(rallyBadgeEntries(state));
  playTargetingSound(SOUND_IDS.UI_SELECT);
  return true;
}

/**
 * Label every ally this Rally could actually reach with the rank it would land at: the bond's rank, or the
 * unranked letter for a party member without one. An ally Rallied this round, or as often this map as its tier
 * allows, gets no badge.
 *
 * A caster with no affinity can rally nobody, so it gets no badges and no ally looks eligible.
 */
function rallyBadgeEntries(state) {
  const caster = rallyCasterFacts(state.source);
  if (!state.source.support?.affinity) return [];
  const identity = unit => ({
    uuid: unit.actorUuid, actorId: unit.baseActorId, partyId: unit.partyId, rallied: unit.rallied === true
  });
  return (state.units ?? [])
    .filter(unit => unit.tokenUuid !== state.source.tokenUuid
      && areFactionsFriendly(state.source.actorType, unit.faction)
      && unit.cells.some(cell => state.grid.targetableKeys.has(`${cell.x},${cell.y}`))
      && canRallyTarget(caster, identity(unit)))
    .map(unit => ({
      tokenUuid: unit.tokenUuid,
      letter: supportRankLetter(rallyRankFor(caster, identity(unit)))
    }));
}

/**
 * Take a canvas square click while an aimed activation waits for its square or a placement waits for its spot.
 * The Token and TokenLayer click wrappers in foundry/patches/token-drag.mjs ask this.
 */
export function onCanvasClickActivationTargeting(cell) {
  const current = activeTargeting();
  if (targetingIsPlacing()) return pickPlacementSquare(current, cell);
  if (!targetingIsActivation() || targetingIsOpening() || !current.envelope.aimed) return false;
  const aim = { x: Math.floor(Number(cell?.x) || 0), y: Math.floor(Number(cell?.y) || 0) };
  if (!current.grid.targetableKeys.has(`${aim.x},${aim.y}`)) {
    refuseTargeting(RESULT_CODES.ITEM_TARGET_OUT_OF_RANGE);
    return true;
  }
  advanceTargeting(TARGETING_EVENTS.OPEN);
  void resolveActivation(current, { aim });
  return true;
}

/** Confirm the targets picked so far for a multi-target activation. The Confirm key calls this (keybindings.mjs). */
export function confirmActivationTargeting() {
  const current = activeTargeting();
  if (!targetingIsActivation() || targetingIsOpening()) return false;
  if (current.envelope.aimed || current.selected.length === 0) return false;
  advanceTargeting(TARGETING_EVENTS.OPEN);
  void resolveActivation(current, {
    targets: current.selected,
    aimUuids: current.selected.map(target => target.tokenUuid)
  });
  return true;
}

/** Whether an activation is currently collecting targets. */
export function isActivationTargetingActive() {
  return targetingIsActivation();
}

async function collectActivationTarget(current, targetToken) {
  const target = await projectActivationTargetFacts(current, targetToken);
  if (!target) {
    refuseTargeting('target-missing');
    return;
  }
  const reach = validateActivationReach({
    envelope: current.envelope,
    source: current.source,
    footprint: current.source.footprint,
    columns: current.columns,
    rows: current.rows,
    sight: current.sight,
    targets: [target]
  });
  if (!reach.ok) {
    refuseTargeting(reach.code);
    return;
  }
  const forced = validateForcedMovementSquare({
    envelope: current.envelope,
    source: current.source,
    target,
    boards: projectForcedMovementBoards(current.source.tokenUuid, target.tokenUuid),
    classicFlyers: current.classicFlyers,
    flightForbidden: current.flightForbidden
  });
  if (!forced.ok) {
    refuseTargeting(forced.code, { ability: forced.ability });
    return;
  }
  if (!activationTargetFactionAllowed(current.envelope, current.source, target)) {
    refuseTargeting(RESULT_CODES.ITEM_TARGET_FACTION, {
      itemName: current.envelope.itemName,
      targetType: current.envelope.targetType
    });
    return;
  }
  if (current.envelope.areaWide) {
    advanceTargeting(TARGETING_EVENTS.OPEN);
    faceAimedTarget(current, target.tokenUuid);
    void resolveActivation(current, { aim: null, areaWide: true });
    return;
  }
  if (current.envelope.lineTargeting) {
    advanceTargeting(TARGETING_EVENTS.OPEN);
    faceAimedTarget(current, target.tokenUuid);
    void resolveActivation(current, { aimUuids: [target.tokenUuid], line: target });
    return;
  }
  // A click on a unit already picked confirms the picks so far.
  if (current.selected.some(entry => entry.tokenUuid === target.tokenUuid)) {
    openActivationConfirm(current, current.selected);
    return;
  }
  // Rally's own refusal comes before the general activation-target check.
  if (current.envelope.rally) {
    const blocker = rallyTargetBlocker(
      rallyCasterFacts(current.source),
      {
        name: target.actorName,
        uuid: target.actorUuid,
        actorId: target.baseActorId,
        partyId: target.partyId,
        rallied: target.rallied === true
      }
    );
    if (blocker) {
      notifications.show(NOTIFICATION_IDS.TARGETING_WARNING, { message: blocker });
      playTargetingSound(SOUND_IDS.UI_ERROR);
      return;
    }
  }
  const selection = [...current.selected, target];
  const verdict = validateActivationTargets(current.envelope, current.actorUuid, selection, current.source);
  if (!verdict.ok) {
    refuseTargeting(verdict.code, verdict.data ?? null);
    return;
  }
  current.selected = selection;
  markSelectedTargets(current);
  if (selection.length >= current.envelope.maxTargets) openActivationConfirm(current, selection, true);
}

/**
 * Open the effect window over the units picked so far.
 *
 * `completesSelection` marks a window opened by the pick that filled the last slot. Backing out of that window
 * removes that last pick again. A window opened by clicking a unit already picked keeps every pick.
 */
function openActivationConfirm(current, selection, completesSelection = false) {
  advanceTargeting(TARGETING_EVENTS.OPEN);
  faceAimedTarget(current, selection[0].tokenUuid);
  void resolveActivation(current, {
    targets: selection,
    aimUuids: selection.map(entry => entry.tokenUuid),
    completesSelection
  });
}

function markSelectedTargets(current) {
  if (!current.envelope.multiTargeting) return;
  markTargetedTokens(current.selected.map(entry => entry.tokenUuid));
}

/** Step a backed-out activation back one pick: the target that completed the selection is released again. */
function undoCompletingSelection(current, request) {
  if (request.completesSelection !== true || activeTargeting() !== current) return;
  current.selected = current.selected.slice(0, -1);
  markSelectedTargets(current);
}

async function resolveActivation(current, request) {
  let confirmedActivation = false;
  try {
    const fresh = await projectActivationGrid(current);
    if (!fresh || !sameCell(current.source, fresh.source)) {
      if (activeTargeting() === current) await cancelAttackTargeting();
      refuseTargeting('targeting-stale');
      return;
    }
    const resolved = await planActivationDelivery(fresh, request);
    if (!resolved.ok) {
      refuseTargeting(resolved.code);
      return;
    }
    const authored = validateActivationRequirements({
      requirements: activationRequirements(fresh.source.conditionItem),
      itemType: fresh.source.conditionItem?.type,
      requiredProficiency: activationRequiredProficiency(fresh.source.conditionItem),
      source: fresh.source,
      targets: resolved.targets,
      targetLocation: request.aim ?? null,
      resolveTerrainGeometry: activationGeometryResolver(fresh)
    });
    if (!authored.ok) {
      refuseTargeting(authored.code);
      return;
    }
    const saddle = validateMountActivation({ envelope: fresh.envelope, source: fresh.source });
    if (!saddle.ok) {
      refuseTargeting(saddle.code);
      return;
    }
    const confirmed = await confirmActivation(current, fresh, resolved, request);
    if (!confirmed) return;
    const { placement, choice } = confirmed;
    const params = validateActivationParams(fresh.source.conditionItem, choice.params ?? {});
    if (!params.ok) {
      refuseTargeting(params.code);
      return;
    }
    await leaveAttackTargeting(current, { resume: false, clearItem: false });
    confirmedActivation = true;
    await indicator.hold(current.tokenUuid, true);
    const result = await game.emblemRpg.api.items.activate({
      sourceTokenUuid: current.tokenUuid,
      itemUuid: current.itemUuid,
      targetTokenUuids: resolved.aimUuids,
      aim: request.aim ?? null,
      placement: placement.placement ?? null,
      params: choice.params ?? {},
      cinematicCategory: current.cinematicCategory
    });
    await restoreFoundryAimFacing(current.tokenUuid);
    if (!result.ok) {
      await clearFoundryActiveItem(current);
      await movement.resume(current.tokenUuid);
      notifications.showResult(result);
      return;
    }
    const continuation = await settleTurnContinuation(current, result.data?.continuation);
    await clearFoundryActiveItem(current);
    if (continuation?.resumesMovement === true) {
      await movement.resume(current.tokenUuid, { announce: continuation.reselects === true });
    }
  } catch (error) {
    clearActivationAreaOverlay();
    if (confirmedActivation) {
      await clearFoundryActiveItem(current);
      await restoreFoundryAimFacing(current.tokenUuid);
      await movement.resume(current.tokenUuid);
    }
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Item activation failed');
  } finally {
    if (confirmedActivation) await indicator.hold(current.tokenUuid, false);
    if (activeTargeting() === current) advanceTargeting(TARGETING_EVENTS.CLOSE);
    if (!confirmedActivation && activeTargeting() === current && current.envelope?.selfTargeted) {
      await leaveAttackTargeting(current, { resume: true, clearItem: true });
    }
  }
}

async function planActivationDelivery(fresh, request) {
  const envelope = fresh.envelope;
  if (envelope.aimed) {
    const area = await projectActivationAim(fresh, request.aim);
    if (!area.ok) return delivery(false, area.code);
    const placement = validateGroundPlacement(
      envelope, request.aim, fresh.units, fresh.source.tokenUuid
    );
    if (!placement.ok) return delivery(false, placement.code);
    return delivery(true, RESULT_CODES.ITEM_ACTIVATED, area.units, [...area.cells].map(parseCell), []);
  }
  if (request.areaWide === true) {
    const units = await projectCaughtUnits(fresh, activationGrid(fresh).targetableKeys);
    if (!units.length) return delivery(false, RESULT_CODES.ITEM_TARGET_INVALID);
    return delivery(true, RESULT_CODES.ITEM_ACTIVATED, units, [], []);
  }
  if (request.line) {
    const ray = await projectActivationRay(fresh, activationGrid(fresh), request.line);
    if (!ray.ok || !ray.units.length) return delivery(false, RESULT_CODES.ITEM_TARGET_INVALID);
    return delivery(true, RESULT_CODES.ITEM_ACTIVATED, ray.units, [...ray.cells].map(parseCell), request.aimUuids);
  }
  return delivery(true, RESULT_CODES.ITEM_ACTIVATED, request.targets ?? [], [], request.aimUuids ?? []);
}

function delivery(ok, code, targets = [], cells = [], aimUuids = []) {
  return { ok, code, targets, cells, aimUuids };
}

function activationGrid(context) {
  const grid = buildActivationTargetingGrid({
    envelope: context.envelope,
    source: context.source,
    footprint: context.source.footprint,
    columns: context.columns,
    rows: context.rows,
    sight: context.sight
  });
  return {
    gridSize: context.gridSize,
    color: targetingGridColor(context.gridColor),
    targetableCells: grid.targetableCells,
    targetableKeys: grid.targetableKeys,
    flyersOnlyKeys: grid.flyersOnlyKeys
  };
}

function parseCell(key) {
  const [x, y] = String(key).split(',').map(Number);
  return { x, y };
}

/* -------------------------------------------- */
/*  Pre-confirm placement                       */
/* -------------------------------------------- */
/** The placement resolver an activation's authored geometry requirements are judged with. */
function activationGeometryResolver(context) {
  return projectGeometryResolver({
    sourceTokenUuid: context.source.tokenUuid,
    effectRange: String(context.envelope?.range?.maxRange ?? '')
  });
}

const NO_PLACEMENT = Object.freeze({ status: 'none' });
const ABANDONED_PLACEMENT = Object.freeze({ status: 'abandoned' });

/**
 * Show the confirm window for what the activation will do, stepping a declined window back one stage.
 *
 * Declining returns to the square pick when there was a choice of squares, and to target selection otherwise.
 * @param {object} current The targeting frame.
 * @param {object} fresh The activation data, read again.
 * @param {object} resolved The units and squares this activation will reach.
 * @param {object} request The aim or targets the player chose.
 * @returns {Promise<{placement: object, choice: object}|null>} The confirmed placement and answer, or null.
 */
async function confirmActivation(current, fresh, resolved, request) {
  let placement = await promptGeometryPlacement(current, fresh, resolved, request);
  for (;;) {
    if (placement.status === 'abandoned' || activeTargeting() !== current) return null;
    if (placement.status === 'cancelled') {
      undoCompletingSelection(current, request);
      return null;
    }
    drawConfirmHighlight(fresh, resolved, placement);
    const location = placement.placement ?? request.aim ?? null;
    const choice = await openEffectPreview(projectActivationPreview(fresh, resolved.targets, location));
    if (choice?.confirmed) return { placement, choice };
    clearActivationAreaOverlay();
    if (activeTargeting() !== current) return null;
    if (!(placement.stage?.placements.length > 1)) {
      if (placement.stage) drawAttackTargetingGrid(placement.stage.grid);
      undoCompletingSelection(current, request);
      return null;
    }
    placement = await enterPlacementStage(placement.stage);
  }
}

/** Highlight what the confirm window commits: the aimed area, or a picked square over its candidate squares. */
function drawConfirmHighlight(fresh, resolved, placement) {
  if (placement.stage) drawAttackTargetingGrid(placementGrid(placement.stage));
  const cells = [...resolved.cells, ...(placement.cells ?? [])];
  if (!cells.length) return;
  drawActivationAreaOverlay({
    gridSize: fresh.gridSize,
    color: placement.cells ? PLACEMENT_GRID_COLOR : targetingGridColor(fresh.gridColor),
    cells
  });
}

/**
 * Run geometry placement between target selection and confirmation. A sole candidate is picked at once.
 * Otherwise wait for a square click or Cancel. Without a prompted step, effect execution places the unit.
 * @param {object} current The targeting frame raising the stage.
 * @param {object} fresh The activation data, read again.
 * @param {object} resolved The units and squares this activation will reach.
 * @param {object} request The aim or targets the player chose.
 * @returns {Promise<{status: string, placement?: {x: number, y: number}, cells?: object[], stage?: object}>}
 */
async function promptGeometryPlacement(current, fresh, resolved, request) {
  const found = findPromptGeometryStep(fresh.source.conditionItem?.system?.effects);
  if (!found) return NO_PLACEMENT;
  const geometry = normalizeGeometry(found.step.geometry);
  const target = resolved.targets?.[0] ?? null;
  const mover = found.step.target === 'target' ? target
    : found.step.target === 'self' ? fresh.source
    : null;
  if (!mover?.tokenUuid) return NO_PLACEMENT;
  const anchor = geometryAnchorRect(geometry, fresh, target, mover, request.aim ?? null);
  if (!anchor) return NO_PLACEMENT;

  const plan = await game.emblemRpg.api.movement.getPlan(mover.tokenUuid);
  if (!plan?.supportedGrid) return NO_PLACEMENT;
  const budget = geometryPlacementBudget(geometry, {
    totalMovement: plan.totalMovement,
    effectRange: Number(fresh.envelope?.range?.maxRange) || 0
  });
  const sight = projectGeometrySight(plan, anchor, plan.footprint, geometry);
  const placements = resolveGeometryPlacements({ ...plan, sight }, anchor, geometry, budget);
  if (!placements.length) return NO_PLACEMENT;
  if (activeTargeting() !== current) return ABANDONED_PLACEMENT;
  const stage = {
    placements,
    width: Math.max(1, Math.floor(Number(plan.footprint?.width) || 1)),
    height: Math.max(1, Math.floor(Number(plan.footprint?.height) || 1)),
    gridSize: plan.gridSize,
    grid: activationGrid(fresh)
  };
  return placements.length === 1 ? pickedPlacement(placements[0], stage) : enterPlacementStage(stage);
}

/** The rectangle a geometry step measures from, or null when this activation does not supply one. */
function geometryAnchorRect(geometry, fresh, target, mover, aim) {
  if (geometry.anchor === 'targetLocation') {
    return aim ? { x: Math.floor(Number(aim.x)), y: Math.floor(Number(aim.y)), width: 1, height: 1 } : null;
  }
  const facts = geometry.anchor === 'self' ? fresh.source : target;
  if (!facts || facts.tokenUuid === mover.tokenUuid) return null;
  return {
    x: Math.floor(Number(facts.x)),
    y: Math.floor(Number(facts.y)),
    width: Math.max(1, Math.floor(Number(facts.footprint?.width) || 1)),
    height: Math.max(1, Math.floor(Number(facts.footprint?.height) || 1))
  };
}

/** Enter the placement stage: the targeting grid shows the candidate squares until settlePlacementStage ends it. */
function enterPlacementStage(stage) {
  return new Promise(resolve => {
    advanceTargeting(TARGETING_EVENTS.PLACE, { placement: { stage, resolve } });
    drawAttackTargetingGrid(placementGrid(stage));
    playTargetingSound(SOUND_IDS.UI_SELECT);
  });
}

/** The candidate squares as a targeting grid, each square once however many candidates share it. */
function placementGrid(stage) {
  const cells = new Map();
  for (const placement of stage.placements) {
    for (const cell of footprintCells(placement.x, placement.y, stage.width, stage.height)) {
      cells.set(`${cell.x},${cell.y}`, cell);
    }
  }
  return {
    gridSize: stage.gridSize,
    color: PLACEMENT_GRID_COLOR,
    targetableCells: [...cells.values()],
    targetableKeys: new Set(cells.keys()),
    flyersOnlyKeys: new Set()
  };
}

/** A finished pick: the square the unit lands on, the cells its footprint covers there, and the stage it left. */
function pickedPlacement(placement, stage) {
  return {
    status: 'picked',
    placement: { x: placement.x, y: placement.y },
    cells: footprintCells(placement.x, placement.y, stage.width, stage.height),
    stage
  };
}

/** Resolve a waiting placement stage as picked, cancelled or abandoned. A pick keeps the candidate squares drawn. */
function settlePlacementStage(current, outcome) {
  const waiting = activeTargeting() === current ? activePlacement() : null;
  if (!waiting) return false;
  const cancelled = outcome.status === 'cancelled';
  advanceTargeting(cancelled ? TARGETING_EVENTS.PLACEMENT_CANCELLED : TARGETING_EVENTS.PLACED);
  if (outcome.status === 'abandoned') clearAttackTargetingGrid();
  if (cancelled) {
    drawAttackTargetingGrid(waiting.stage.grid);
    playTargetingSound(SOUND_IDS.UI_UNSELECT);
  }
  waiting.resolve(outcome);
  return true;
}

/** Pick the candidate a square click landed on, or answer a miss with the refusal cue and stay on the stage. */
function pickPlacementSquare(current, cell) {
  const { stage } = activePlacement();
  const hit = placementAtCell(stage.placements, stage.width, stage.height, cell);
  if (!hit) {
    playTargetingSound(SOUND_IDS.UI_ERROR);
    return true;
  }
  settlePlacementStage(current, pickedPlacement(hit, stage));
  return true;
}

/** Which candidate covers a clicked square: where several overlap, the one whose centre is nearest it. */
function placementAtCell(placements, width, height, cell) {
  const column = Math.floor(Number(cell?.x));
  const row = Math.floor(Number(cell?.y));
  if (!Number.isFinite(column) || !Number.isFinite(row)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const placement of placements) {
    if (column < placement.x || column >= placement.x + width) continue;
    if (row < placement.y || row >= placement.y + height) continue;
    const distance = ((column + 0.5 - placement.x - (width / 2)) ** 2)
      + ((row + 0.5 - placement.y - (height / 2)) ** 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = placement;
    }
  }
  return best;
}

/* -------------------------------------------- */
/*  Cancellation and lifecycle                  */
/* -------------------------------------------- */
/** Cancel the active targeting frame and restore its movement preview. */
async function cancelAttackTargeting() {
  const current = activeTargeting();
  if (!current) return false;
  await leaveAttackTargeting(current, { resume: true, clearItem: true });
  await releaseHeldArmament(current);
  playTargetingSound(SOUND_IDS.UI_UNSELECT);
  return true;
}

/**
 * Step targeting back for the Cancel key (through stepCancelMovement) or the BG3 HUD's cancel action. A
 * placement steps back to target selection, and any other stage leaves targeting.
 */
export function stepCancelAttackTargeting() {
  const current = activeTargeting();
  if (!current) return false;
  if (settlePlacementStage(current, { status: 'cancelled' })) return true;
  void cancelAttackTargeting();
  return true;
}

/** Put down an Armament the unit picked up for this attack, and say so when the host refuses. */
async function releaseHeldArmament(current) {
  if (!current.armament) return;
  const result = await game.emblemRpg.api.objects.releaseArmament({
    sourceTokenUuid: current.tokenUuid, restore: true
  });
  if (!result?.ok) notifications.showResult(result);
}

/** Free Exploration refuses every hotbar press but the few uses it allows, before any targeting mode opens. */
function explorationForbids(item) {
  if (item?.documentName !== 'Item' || sceneExplorationActive(globalThis.canvas?.scene) !== true) return false;
  return !explorationAllowsItem({ type: item.type, subtype: item.system?.itemType });
}

/** Identify the Steal Ability by name before routing its hotbar click to interaction targeting. */
function stealAbility(item) {
  return item?.documentName === 'Item' && isStealAbility(item) ? item : null;
}

/** The pressed cell, marked as the thief's active item so Steal shows as pending like every other aimed Item. */
function stealActivation(plan, item, cellId) {
  const actorUuid = String(item.actor?.uuid ?? '');
  if (!plan || !actorUuid) return null;
  return Object.freeze({
    tokenUuid: String(plan.tokenUuid),
    actorUuid,
    itemUuid: String(item.uuid),
    cellId: String(cellId ?? '')
  });
}

/** Clear targeting before the Canvas is discarded. */
export function onCanvasTearDownAttackTargeting() {
  const current = activeTargeting();
  if (!current) return;
  settlePlacementStage(current, ABANDONED_PLACEMENT);
  advanceTargeting(TARGETING_EVENTS.LEAVE);
  disposeAttackTargetingPresentation();
  void clearFoundryActiveItem(current);
}

/**
 * On controlToken, when the aiming unit is deselected: leave targeting, put down an Armament it picked up for
 * this attack, and cancel the movement plan targeting suspended.
 */
export function onControlTokenAttackTargeting(token, controlled) {
  const current = activeTargeting();
  if (controlled || !current) return;
  const uuid = String(token.document.uuid ?? '');
  if (uuid === current.tokenUuid) void abandonAttackTargeting();
}

async function abandonAttackTargeting() {
  const current = activeTargeting();
  if (!current) return false;
  await leaveAttackTargeting(current, { resume: false, clearItem: true });
  await releaseHeldArmament(current);
  await movement.cancel(current.tokenUuid);
  return true;
}

/**
 * Leave targeting when its source changes under it. init/hooks.mjs calls this from updateToken, destroyToken,
 * updateActor, updateItem and deleteItem. Targeting ends when the source token moves or is destroyed, when the
 * aimed Item updates or is deleted, or when the Actor's movement plan ends. The plan is resumed afterwards unless
 * it ended; when the token is destroyed, movement.mjs cancels the plan itself. A frame marked `swapping` keeps its
 * aim while the Combat Preview puts its weapon away for one picked there (swapPreviewWeapon), which then aims with
 * a new frame.
 */
export function onTargetingSourceChanged(document, changes = null) {
  const current = activeTargeting();
  if (!current) return;
  const uuid = String(document?.uuid ?? document?.document?.uuid ?? '');
  const planning = changes?.system?.turn?.movementPlanning;
  const sourceMoved = uuid === current.tokenUuid
    && (changes === null || changes?.x !== undefined || changes?.y !== undefined);
  const itemChanged = uuid === current.itemUuid && current.swapping !== true;
  if (!sourceMoved && !itemChanged && !(uuid === current.actorUuid && planning === false)) return;
  const destroyedToken = sourceMoved && changes === null && document?.documentName === 'Token';
  void leaveAttackTargeting(current, {
    resume: planning !== false && !destroyedToken,
    clearItem: true
  });
}

/** Restore the suspended movement plan when a targeting swap fails after its old frame was torn down. */
async function abandonEntry(swapping, tokenUuid, reason = '') {
  if (swapping) await movement.resume(tokenUuid);
  return reason ? refuseTargeting(reason) : false;
}

/**
 * Leave the targeting frame. `clearItem` is set whenever it is left without a confirmed exchange or activation:
 * the unit's active Item is cleared and it turns back to its saved facing. A confirmed one keeps both until the
 * host answers (commitConfirmedExchange, resolveActivation).
 */
async function leaveAttackTargeting(current, { resume, clearItem }) {
  settlePlacementStage(current, ABANDONED_PLACEMENT);
  if (activeTargeting() === current) advanceTargeting(TARGETING_EVENTS.LEAVE);
  clearAttackTargetingGrid();
  clearActivationAreaOverlay();
  clearRallySupportBadges();
  markTargetedTokens([]);
  if (clearItem) {
    await clearFoundryActiveItem(current);
    await restoreFoundryAimFacing(current.tokenUuid);
  }
  if (resume) await movement.resume(current.tokenUuid);
}

/* -------------------------------------------- */
/*  Feedback                                    */
/* -------------------------------------------- */
/**
 * Refusals the notification catalog words itself, shown under their own id with the payload. Most of them name
 * the ability, Item or target from that payload. targetingMessage words every other reason.
 */
const CATALOG_REFUSALS = new Set([
  RESULT_CODES.COMMAND_TABLE_PAUSED,
  RESULT_CODES.ITEM_TARGET_FACTION,
  RESULT_CODES.ITEM_TARGET_SANCTUARY,
  RESULT_CODES.ITEM_SPELL_RANK_REQUIRED,
  RESULT_CODES.ITEM_LOCKED_THIS_PHASE,
  RESULT_CODES.ITEM_FORCED_TARGET_AIRBORNE,
  RESULT_CODES.ITEM_FORCED_SQUARE_OCCUPIED,
  RESULT_CODES.ITEM_FORCED_SQUARE_BLOCKED,
  RESULT_CODES.ITEM_FORCED_SQUARE_ABOVE,
  RESULT_CODES.ITEM_FORCED_BOARD_REQUIRED
]);

function refuseTargeting(reason, payload = null) {
  const message = CATALOG_REFUSALS.has(reason) ? null : targetingMessage(reason, payload);
  if (CATALOG_REFUSALS.has(reason)) notifications.show(reason, payload ?? {});
  else if (message) notifications.show(NOTIFICATION_IDS.TARGETING_WARNING, { message });
  playTargetingSound(SOUND_IDS.UI_ERROR);
  return false;
}

function targetingMessage(reason, payload = null) {
  const messages = {
    'source-not-controlled': 'Control one Character before using an Item.',
    'movement-plan-required': 'Start moving this Character before attacking.',
    'item-owner-mismatch': 'That Item does not belong to the controlled Character.',
    'item-not-attack': 'Only weapons, attack spells, and combat staves enter attack targeting here.',
    'standard-action-required': 'That Character has no Standard Action remaining.',
    'stance-broken': 'A Stance Broken Character cannot attack.',
    'item-depleted': 'That Item is depleted.',
    'weapon-proficiency-required': 'That Character lacks the proficiency required for this weapon.',
    'weapon-art-mismatch': `${payload?.weaponArtName || 'That Weapon Art'} cannot be used with ${payload?.itemName || 'the equipped weapon'}!`,
    'weapon-art-depleted': `${payload?.weaponArtName || 'That Weapon Art'} has no uses left!`,
    'weapon-art-durability': `${payload?.itemName || 'The equipped weapon'} lacks the durability for ${payload?.weaponArtName || 'that Weapon Art'}!`,
    'item-missing': 'That hotbar Item is no longer available.',
    'range-invalid': 'That Item does not have a usable attack range.',
    'target-self': 'An attack cannot target its source.',
    'target-missing': 'That target is no longer available.',
    'target-fixture': '',
    'target-destroyed': 'That target is already defeated.',
    'object-destroyed': 'That object is already destroyed.',
    'line-of-sight-blocked': 'There is no line of sight to that target.',
    'target-faction-invalid': 'That Item cannot target this faction.',
    'target-sanctuary': 'That unit is under Sanctuary and cannot be targeted.',
    'target-airborne': 'That unit is airborne, so melee cannot reach it.',
    'target-out-of-range': 'That target is out of range!',
    'square-shared': 'A Character sharing another unit\u2019s square must step off before acting.',
    'targeting-stale': 'The board changed. Activate the Item again.',
    'preview-unavailable': 'The combat preview could not be prepared.',
    [RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED]: 'That item is not activated through the effect window.',
    [RESULT_CODES.ITEM_ACTIVATION_UNAVAILABLE]: 'That item cannot be used right now.',
    [RESULT_CODES.ITEM_ACTIVATION_STALE]: 'The board changed before the activation could settle. Try again.',
    [RESULT_CODES.ITEM_ACTIVATION_FAILED]: 'The activation could not be written and was rolled back.',
    [RESULT_CODES.ITEM_ACTION_UNAVAILABLE]: 'This unit has no action left for that item.',
    [RESULT_CODES.ITEM_USES_EXHAUSTED]: 'That item has no uses left.',
    [RESULT_CODES.ITEM_TARGET_INVALID]: 'That item cannot be aimed at those units.',
    [RESULT_CODES.ITEM_TARGET_OBJECT]: 'Objects are only struck by attacks and damaging effects.',
    [RESULT_CODES.ITEM_TARGET_SCENERY]: 'That is scenery, not a target.',
    [RESULT_CODES.ITEM_TARGET_DESTROYED]: 'That object is already destroyed.',
    [RESULT_CODES.ITEM_CASTER_REQUIREMENTS_UNMET]: 'This unit does not meet this item\u2019s requirements.',
    [RESULT_CODES.ITEM_TARGET_REQUIREMENTS_UNMET]: 'A target does not meet this item\u2019s requirements.',
    [RESULT_CODES.ITEM_TARGET_OUT_OF_RANGE]: 'That target is out of range for this item.',
    [RESULT_CODES.ITEM_TARGET_SIGHT_BLOCKED]: 'There is no line of sight to that target.',
    [RESULT_CODES.ITEM_TARGET_ELEVATION_UNREACHABLE]: 'That target is out of reach at that elevation.',
    [RESULT_CODES.ITEM_AIM_INVALID]: 'That is not a square this item can be aimed at.',
    [RESULT_CODES.ITEM_GROUND_OCCUPIED]: 'Ground targeting requires an empty square.',
    [RESULT_CODES.ITEM_PARAM_INVALID]: 'That is not a choice this item offers.',
    [RESULT_CODES.ITEM_MOUNTS_FORBIDDEN]: 'Mounts are not permitted on this map.',
    [RESULT_CODES.OWNER_REQUIRED]: 'Control one Character before using an Item.'
  };
  return messages[reason] ?? 'That target is not valid.';
}

function playTargetingSound(soundId) {
  playUiSound(soundId);
}

function sameCell(left, right) {
  return Number(left?.x) === Number(right?.x) && Number(left?.y) === Number(right?.y);
}
