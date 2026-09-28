/** @layer ui/controls */
import { activateBg3HotbarSlot } from '../../external/bg3-hud/character-hud.mjs';
import { BG3_HOTBAR_KEYBINDINGS, KEYBINDING_IDS } from '../../config/keybindings.mjs';
import { TERRAIN_TIPS_MODE_SETTING } from '../../config/settings.mjs';
import { readSetting } from '../../foundry/adapters/services/host.mjs';
import { topActionWindow } from '../dialogs.mjs';
import {
  clearInspectedReaches,
  dismissBg3HudInspection,
  selectOrConfirmMovement,
  stepCancelMovement,
  inspectMovementPlan,
  resumeMovementAfterTargeting,
  settleMovementAfterInteraction,
  suspendMovementForTargeting
} from './movement.mjs';
import {
  advanceInspectedAttackPreview, cancelInteraction, runInteract, runTrade, setInspectModifierHeld
} from './interaction.mjs';
import { activateAttackItemFromHotbar, confirmActivationTargeting } from './targeting.mjs';
import { cycleUnitSelection } from './unit-cycle.mjs';
import { setTerrainVisualizationVisible } from '../../presentation/canvas/terrain.mjs';

/* -------------------------------------------- */
/*  Terrain tips state                          */
/* -------------------------------------------- */
const TERRAIN_TIPS_TOGGLE_MODE = 'toggle';
let terrainTipsToggled = false;

/* -------------------------------------------- */
/*  Double-click cancel                         */
/* -------------------------------------------- */
const DOUBLE_CLICK_WINDOW_MS = 250;
let doubleClickHandler = null;
let doubleClickView = null;

/**
 * Make a double-click on empty canvas cancel, the mouse equivalent of Shift.
 *
 * Clicks over a Token are left alone. init/hooks.mjs installs this on every canvasReady and removes it on
 * canvasTearDown.
 * @returns {boolean} Whether a listener is now installed.
 */
export function installCanvasDoubleClickCancel() {
  disposeCanvasDoubleClickCancel();
  const view = globalThis.canvas?.app?.view;
  if (typeof view?.addEventListener !== 'function') return false;
  let clicks = 0;
  let timer = null;
  doubleClickHandler = event => {
    if (event.button !== 0 || globalThis.canvas?.tokens?.hover) return;
    clicks += 1;
    if (clicks === 1) {
      timer = setTimeout(() => { clicks = 0; }, DOUBLE_CLICK_WINDOW_MS);
      return;
    }
    clearTimeout(timer);
    clicks = 0;
    event.preventDefault?.();
    event.stopPropagation?.();
    onCancel({ key: 'DoubleClick' });
  };
  view.addEventListener('click', doubleClickHandler, true);
  doubleClickView = view;
  return true;
}

/** Remove the double-click listener from whichever canvas view carried it. */
export function disposeCanvasDoubleClickCancel() {
  if (doubleClickHandler) doubleClickView?.removeEventListener?.('click', doubleClickHandler, true);
  doubleClickHandler = null;
  doubleClickView = null;
}

/* -------------------------------------------- */
/*  Handler map                                 */
/* -------------------------------------------- */
/**
 * The handler for each binding in KEYBINDING_DEFINITIONS (config/keybindings.mjs), keyed by binding id.
 * registerKeybindings in init/registrations.mjs registers them with Foundry.
 * @returns {object} Frozen map of binding id to a handler function, or to a `{down, up}` pair for held keys.
 */
export function createCanvasKeybindingHandlers() {
  const handlers = {
    [KEYBINDING_IDS.CONFIRM]: onConfirm,
    [KEYBINDING_IDS.CANCEL]: onCancel,
    [KEYBINDING_IDS.CYCLE_UNITS]: cycleUnitSelection,
    [KEYBINDING_IDS.TRADE]: onTrade,
    [KEYBINDING_IDS.INTERACT]: onInteract,
    [KEYBINDING_IDS.ZOOM_OUT]: onZoomOut,
    [KEYBINDING_IDS.SHOW_TOKEN_TOOLTIP]: {
      down: () => setInspectModifierHeld(true),
      up: () => setInspectModifierHeld(false)
    },
    [KEYBINDING_IDS.PREVIEW_TOOLTIP_ATTACK]: advanceInspectedAttackPreview,
    [KEYBINDING_IDS.SHOW_TERRAIN_TIPS]: {
      down: onShowTerrainTips,
      up: onReleaseTerrainTips
    }
  };
  for (const definition of BG3_HOTBAR_KEYBINDINGS) {
    handlers[definition.id] = () => activateBg3HotbarSlot(definition.bg3GridIndex, definition.bg3SlotIndex);
  }
  return Object.freeze(handlers);
}

/* -------------------------------------------- */
/*  Confirm and cancel                          */
/* -------------------------------------------- */
function onConfirm() {
  const captured = topActionWindow();
  if (captured) {
    captured.confirm();
    return true;
  }

  if (confirmActivationTargeting()) return true;

  const active = globalThis.document?.activeElement;
  if (isFormField(active)) return false;
  if (active
      && active !== globalThis.document?.body
      && active !== globalThis.canvas?.app?.view
      && typeof active.blur === 'function') active.blur();

  const tokens = globalThis.canvas?.tokens;
  if ((tokens?.controlled?.length ?? 0) > 1) {
    tokens.releaseAll();
    return true;
  }
  selectOrConfirmMovement();
  return true;
}

function onCancel(context) {
  if (cancelInteraction()) return true;
  const captured = topActionWindow();
  if (captured) {
    captured.cancel();
    return true;
  }
  if (stepCancelMovement()) return true;
  if (context.key === 'Escape') return false;
  if (dismissBg3HudInspection()) return true;

  const active = globalThis.document?.activeElement;
  if (active?.closest?.('.dialog, .dialog-button, .app.actor-sheet, .app.item-sheet')) {
    active.blur?.();
    return false;
  }

  const tokens = globalThis.canvas?.tokens;
  if (!tokens) return false;
  tokens.releaseAll();
  globalThis.game?.user?._onUpdateTokenTargets?.();
  clearInspectedReaches();
  return true;
}

function isFormField(element) {
  return Boolean(element?.tagName
    && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable));
}

/* -------------------------------------------- */
/*  Camera                                      */
/* -------------------------------------------- */
function onZoomOut() {
  const canvas = globalThis.canvas;
  const scene = canvas?.ready ? canvas.scene : null;
  if (!scene) return false;

  const padding = scene.dimensions.paddingX || scene.dimensions.paddingY || 100;
  const sceneWidth = scene.dimensions.sceneWidth + (padding * 2);
  const sceneHeight = scene.dimensions.sceneHeight + (padding * 2);
  const targetZoom = Math.min(
    canvas.app.screen.width / sceneWidth,
    canvas.app.screen.height / sceneHeight
  );
  canvas.animatePan({
    x: scene.dimensions.sceneX + (scene.dimensions.sceneWidth / 2),
    y: scene.dimensions.sceneY + (scene.dimensions.sceneHeight / 2),
    scale: Math.max(targetZoom, 0.1) * 1.1,
    duration: 2000
  });
  return true;
}

/* -------------------------------------------- */
/*  Terrain tips                                */
/* -------------------------------------------- */
/**
 * Reveal the terrain annotations, either for the length of the press or until the next one.
 * @returns {boolean} True, since the gesture is always consumed.
 */
function onShowTerrainTips() {
  if (terrainTipsMode() !== TERRAIN_TIPS_TOGGLE_MODE) {
    setTerrainVisualizationVisible(true);
    return true;
  }
  terrainTipsToggled = !terrainTipsToggled;
  setTerrainVisualizationVisible(terrainTipsToggled);
  return true;
}

/**
 * Hide the terrain annotations again, unless the reveal is a toggle rather than a hold.
 * @returns {boolean} True, since the gesture is always consumed.
 */
function onReleaseTerrainTips() {
  if (terrainTipsMode() === TERRAIN_TIPS_TOGGLE_MODE) return true;
  setTerrainVisualizationVisible(false);
  return true;
}

function terrainTipsMode() {
  const mode = readSetting(TERRAIN_TIPS_MODE_SETTING, TERRAIN_TIPS_TOGGLE_MODE);
  return typeof mode === 'string' ? mode : TERRAIN_TIPS_TOGGLE_MODE;
}

/* -------------------------------------------- */
/*  Trade and interact                          */
/* -------------------------------------------- */
function onTrade() {
  void runTrade(inspectMovementPlan(), {
    inspect: inspectMovementPlan,
    suspend: suspendMovementForTargeting,
    resume: resumeMovementAfterTargeting,
    release: settleMovementAfterInteraction
  });
  return true;
}

function onInteract() {
  void runInteract(inspectMovementPlan(), {
    attack: activateAttackItemFromHotbar, resume: resumeMovementAfterTargeting,
    suspend: suspendMovementForTargeting, release: settleMovementAfterInteraction
  });
  return true;
}
