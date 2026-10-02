/** @layer ui/controls */
import {
  restoreActingHudForToken,
  showViewOnlyHudForToken,
  viewOnlyHudShows
} from '../../external/bg3-hud/character-hud.mjs';
import {
  clearFacadeSelection,
  facadeSelectedTokenId,
  showFacadeSelection
} from '../../presentation/token/rendering.mjs';
import { movementPlanForToken } from './movement-state.mjs';
import { processingActive, tokenControlAllowed, tokenPickAwaitingClick } from './unit-access.mjs';
import { hoveredCanvasToken } from './interaction.mjs';
import { SOUND_IDS } from '../../presentation/audio/sound-database.mjs';
import { playUiSound } from '../../presentation/audio/service.mjs';

/* -------------------------------------------- */
/*  Click-to-inspect                            */
/* -------------------------------------------- */

/*
 * A player's left click on a unit opens its read-only BG3 HUD and draws the system's own selection frame around it
 * (presentation/token/rendering.mjs), because a player can't control a unit just to look at it.
 * movement.mjs installs the canvas listener on every canvasReady, and hands onTokenClickInspect to
 * foundry/patches/token-drag.mjs for the clicks its Token wrappers see first.
 */
let inspectPointerView = null;

/**
 * Listen for a player's click on the canvas element itself, because Foundry refuses a click on a unit the player
 * doesn't own before any Token patch can see it. PIXI put its own capture listener on the same element first, so
 * Foundry has already handled the click when this runs, and stopping the event here does not stop Foundry.
 * movement.mjs calls this on every canvasReady and drops the old listener first.
 */
export function installCanvasInspectClick() {
  disposeCanvasInspectClick();
  const view = globalThis.canvas?.app?.view;
  if (typeof view?.addEventListener !== 'function') return false;
  view.addEventListener('pointerdown', onInspectPointerDown, true);
  inspectPointerView = view;
  return true;
}

/** Drop the listener from whichever canvas view carried it. */
export function disposeCanvasInspectClick() {
  inspectPointerView?.removeEventListener?.('pointerdown', onInspectPointerDown, true);
  inspectPointerView = null;
}

/**
 * Answer a left click that foundry/patches/token-drag.mjs didn't route anywhere else. Its Token#_onClickLeft
 * wrapper calls this after targeting and interaction picks have had the click (or at once while a command is
 * processing), and its TokenHUD#bind wrapper calls it for a unit this user can't plan for. A click on the unit
 * this client is moving gives it back its acting HUD. Any other unit opens read-only.
 */
export function onTokenClickInspect(token) {
  if (movementPlanForToken(token) && !processingActive()) return restoreActingHud(token);
  return inspectMovementToken(token);
}

/**
 * Keep left-click inspection working while a command is processing. The processing input guard
 * (installProcessingInputGuards, set up in init/system.mjs) blocks canvas clicks then, and calls this instead.
 */
export function inspectHoveredMovementToken() {
  const token = hoveredCanvasToken();
  if (!token) return false;
  return viewOnlyHudShows(token) || inspectMovementToken(token);
}

/**
 * Open a unit's read-only BG3 HUD and draw the selection frame around it. The Cycle Units key uses this
 * for players too (unit-cycle.mjs).
 * @param {object} token The placed Token to look at.
 * @returns {boolean} Whether it opened. A unit whose read-only HUD is already showing is left alone.
 */
export function inspectMovementToken(token) {
  if (viewOnlyHudShows(token) || !showViewOnlyHudForToken(token)) return false;
  showFacadeSelection(token);
  playSelectionBlip();
  return true;
}

/**
 * The token inside the system's selection frame, or null. selectOrConfirmMovement in movement.mjs prefers it over the
 * hovered token when the Confirm key is pressed.
 */
export function pseudoSelectedToken() {
  const tokenId = facadeSelectedTokenId();
  return tokenId ? globalThis.canvas?.tokens?.get?.(tokenId) ?? null : null;
}

/** Give the unit this user is moving its acting HUD back, and clear the selection frame. */
function restoreActingHud(token) {
  if (!restoreActingHudForToken(token)) return false;
  clearFacadeSelection();
  playSelectionBlip();
  return true;
}

function onInspectPointerDown(event) {
  if (event.button !== 0) return;
  if (!processingActive() && tokenPickAwaitingClick()) return;
  const token = hoveredCanvasToken();
  if (!token || (game.user.isGM && tokenControlAllowed(token))) return;
  // A GM who may control the unit selects it the normal way. A click on the unit this client is moving only gets
  // its acting HUD back and carries on, since it may be the start of a drag.
  if (movementPlanForToken(token) && !processingActive()) {
    restoreActingHud(token);
    return;
  }
  if (!inspectMovementToken(token)) return;
  event.stopPropagation();
  event.preventDefault();
}

/* -------------------------------------------- */
/*  Selection cue                               */
/* -------------------------------------------- */
const SELECTION_BLIP_WINDOW_MS = 50;
let lastSelectionBlipAt = 0;

/** Play the selection blip at most once per short window: one click reaches `control` several times. */
export function playSelectionBlip() {
  const now = globalThis.performance?.now?.() ?? Date.now();
  if (now - lastSelectionBlipAt < SELECTION_BLIP_WINDOW_MS) return false;
  lastSelectionBlipAt = now;
  playUiSound(SOUND_IDS.UI_BLIP_1);
  return true;
}
