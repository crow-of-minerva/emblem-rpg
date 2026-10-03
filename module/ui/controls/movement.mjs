/** @layer ui/controls */
import { withPlanInputHeld } from './input-hold.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import {
  clearViewOnlyHud,
  showGmHudForTokenHud,
  withGmLeftClickHudControlSuppressed
} from '../../external/bg3-hud/character-hud.mjs';
import {
  projectFoundryMovementInput,
  projectFoundryMovementPosition
} from '../../foundry/adapters/projections/board.mjs';
import { sceneCombatActive, sceneExplorationActive } from '../../foundry/adapters/projections/encounters.mjs';
import {
  MOVEMENT_INPUT_KINDS,
  MOVEMENT_INPUT_REASONS,
  MOVEMENT_PROMPTS,
  UNIT_SELECTION_OUTCOMES,
  UNIT_SELECTION_REASONS,
  canAdoptMovementPlan,
  crossingOfferAllowed,
  planCrossingAttempt,
  planMovementSettlement,
  resolveUnitSelection
} from '../../game/movement/input-policy.mjs';
import {
  buildMovementGraph,
  canTraverseMovementTranslation,
  collectCrossingOptions,
  crossingCandidates,
  movementStranded,
  planMovementHints,
  resolveMovementDestination,
  resolveMovementPreview
} from '../../game/movement/pathfinding.mjs';
import {
  clearGreyMovementGrid,
  clearGreyMovementGrids,
  clearMovementPlan,
  drawGreyMovementGrid,
  drawMovementHints,
  drawMovementPlan,
  hasGreyMovementGrid
} from '../../presentation/canvas/cell-overlays.mjs';
import {
  clearFacadeSelection,
  holdPathfindingIndicator,
  stopTokenFootstepAnimation
} from '../../presentation/token/rendering.mjs';
import {
  clearCrossingArrows,
  clearReachableTeleports,
  drawCrossingArrows,
  showReachableTeleports
} from '../../presentation/canvas/terrain.mjs';
import { SOUND_IDS } from '../../presentation/audio/sound-database.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../presentation/interface/notifications.mjs';
import { openBlockingDialog } from '../dialogs.mjs';
import {
  MOVEMENT_EVENTS,
  MOVEMENT_STATES,
  activeMovementPlan,
  advanceMovement,
  createMovementPlan,
  movementAcceptsInput,
  movementHoldIsCurrent,
  movementInputHold,
  movementIsSettling,
  movementIsSuspended,
  movementPlanForToken,
  movementStateName
} from './movement-state.mjs';
import {
  installMovementKeyBlocker,
  movementKeyHeld,
  releaseHeldMovementKeys,
  takeFreshMovementPress
} from './movement-keys.mjs';
import {
  addPathedDragWaypoint,
  finalizePathedDrag,
  hasPathedDragContext,
  holdPathedDragRuler,
  initializePathedDrag,
  refreshPathedDragRuler,
  refreshPathedDragState,
  scheduleDragControlRecovery,
  stylePathedDragGrid,
  stylePathedDragPath,
  updatePathedDrag
} from './drag-route.mjs';
import {
  disposeCanvasInspectClick,
  installCanvasInspectClick,
  onTokenClickInspect,
  playSelectionBlip,
  pseudoSelectedToken
} from './inspect-click.mjs';
import {
  canPlanFor,
  canvasMarqueePermission,
  currentLock,
  drivenHoldActive,
  movementInputPermission,
  ownsUnit,
  processingActive,
  tokenControlAllowed,
  tokenPickAwaitingClick
} from './unit-access.mjs';
import { crossingDialog } from './crossing-offer.mjs';
import { hoveredCanvasToken, onTokenClickInteraction } from './interaction.mjs';
import {
  isActivationTargetingActive,
  isAttackTargetingActive,
  onCanvasClickActivationTargeting,
  onTokenClickAttackTargeting,
  stepCancelAttackTargeting
} from './targeting.mjs';
import {
  installTokenDragPatches,
  interruptFoundryTokenMovement,
  tokenDragPatchCount
} from '../../foundry/patches/token-drag.mjs';
import { playUiSound } from '../../presentation/audio/service.mjs';
import { TELEPORT_COSTS } from '../../contracts/domains/terrain.mjs';
import { teleportPadAt } from '../../game/terrain/rules.mjs';
import { playMountFlourish } from '../../external/sequencer/animation-dispatch.mjs';
import { reportFoundryError, FoundryDiagnostics } from '../../foundry/adapters/services/diagnostics.mjs';
import { localUserFrozenByPause, localUserIsStaff, worldPaused } from '../../foundry/adapters/services/host.mjs';

export { inspectHoveredMovementToken, inspectMovementToken } from './inspect-click.mjs';
export { isHeldMovementRepeating } from './movement-keys.mjs';

/* -------------------------------------------- */
/*  Planning state                              */
/* -------------------------------------------- */

/*
 * The movement plan lifecycle on this client: begin, step, confirm, roll back and cancel. The plan and its state
 * live in ui/controls/movement-state.mjs and change only through advanceMovement. The input around it lives in
 * the files beside this one: movement-keys.mjs for held keys, drag-route.mjs for the token drag along the path,
 * crossing-offer.mjs for the crossing dialog, inspect-click.mjs for read-only inspection, and unit-access.mjs for
 * whether this client may command a unit. Every refused command is shown through NotificationService, except a
 * plain cancel by the user.
 */
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });
const MOVEMENT_SETTLE_TIMEOUT_MS = 2000;
const REFUSALS_WITH_CUE = new Set([
  MOVEMENT_INPUT_REASONS.TRADE_ACTIVE,
  MOVEMENT_INPUT_REASONS.TARGETING_ACTIVE
]);
let controlsInitialized = false;

/* -------------------------------------------- */
/*  Canvas lifecycle                            */
/* -------------------------------------------- */
/**
 * Install the Token input wrappers (foundry/patches/token-drag.mjs) and the movement key listeners
 * (movement-keys.mjs). init/hooks.mjs calls this once, during setup.
 */
export function initializeMovementControls() {
  controlsInitialized = true;
  installMovementWrappers();
  installMovementKeyBlocker();
}

/** On canvasReady, clear the movement drawings and bind click-to-inspect to the new canvas. */
export function onCanvasReadyMovementControls() {
  clearMovementPlan();
  clearReachableTeleports();
  clearCrossingArrows();
  installCanvasInspectClick();
}

/** On canvasTearDown, cancel an open plan and clear the inspection views before the canvas is replaced. */
export function onCanvasTearDownMovementControls() {
  if (activeMovementPlan()) void cancelPlan({ release: false });
  disposeCanvasInspectClick();
  clearFacadeSelection();
  clearViewOnlyHud({ refresh: false });
}

/* -------------------------------------------- */
/*  Hook handlers                               */
/* -------------------------------------------- */
/**
 * On controlToken, cancel the plan when something else deselects its unit. A suspended plan is left to the
 * workflow holding it, and a deselect in the middle of a drag takes control back instead.
 */
export function onControlTokenMovement(token, controlled) {
  if (token.isPreview) return;
  const plan = movementPlanForToken(token);
  if (controlled || !plan || movementIsSuspended()) return;
  if (plan.dragging || hasPathedDragContext(token)) {
    plan.restoreControlAfterDrag = true;
    scheduleDragControlRecovery(plan);
    return;
  }
  void cancelPlan({ release: false });
}

/**
 * preUpdateToken check for every token move: refuse the moves movementInputPermission rejects, and keep the
 * planned unit on its movement graph. A step off the graph may offer a terrain crossing instead (offerCrossing).
 * A step refused because the unit is stranded (it can't take a move of its own; see movementStranded in
 * game/movement/pathfinding.mjs) says so here, before any command is sent, once per key press rather than on
 * every repeat of a held key.
 *
 * Writes made through the API (`method: "api"`) and the system's own restore writes skip every check. A move
 * Foundry doesn't mark as a drag or a key press, such as an edit in Token Config or a Ctrl+Z undo, is refused
 * without a message, even for a GM.
 * @returns {boolean|undefined} False vetoes the Foundry Token update.
 */
export function onPreUpdateTokenMovement(tokenDocument, changes, options = {}) {
  const moved = (changes.x !== undefined && changes.x !== tokenDocument.x)
    || (changes.y !== undefined && changes.y !== tokenDocument.y);
  if (!moved) return;

  const kind = projectFoundryMovementInput(tokenDocument, options);
  const plan = movementPlanForToken(tokenDocument);
  const permission = movementInputPermission(tokenDocument, kind, plan);
  if (!permission.allowed) {
    if (REFUSALS_WITH_CUE.has(permission.reason)) playMovementSound(SOUND_IDS.UI_ERROR);
    return false;
  }
  if (kind === MOVEMENT_INPUT_KINDS.RESTORE || kind === MOVEMENT_INPUT_KINDS.SYSTEM) return;
  if (!plan) return;

  const gridSize = plan.snapshot.gridSize;
  const destination = {
    x: Math.floor(Number(changes.x ?? tokenDocument.x) / gridSize),
    y: Math.floor(Number(changes.y ?? tokenDocument.y) / gridSize)
  };
  const freshPress = kind === MOVEMENT_INPUT_KINDS.KEYBOARD ? takeFreshMovementPress() : false;
  const resolution = resolveMovementPreview(plan.graph, destination);
  if (!resolution) {
    if (movementStranded(plan.snapshot)) {
      if (kind !== MOVEMENT_INPUT_KINDS.KEYBOARD || freshPress || !movementKeyHeld()) {
        notifications.show(NOTIFICATION_IDS.MOVEMENT_STRANDED);
      }
    } else if (crossingOfferAllowed({ kind, freshPress })) offerCrossing(plan, destination);
    return false;
  }
  if (kind === MOVEMENT_INPUT_KINDS.KEYBOARD
      && !canTraverseMovementTranslation(plan.graph, plan.current, destination)) return false;
  return true;
}

/** Keep the local preview position synchronized with Foundry's real TokenDocument. */
export function onUpdateTokenMovement(tokenDocument, changes) {
  const plan = activeMovementPlan();
  if (!plan || plan.tokenId !== tokenDocument.id) return;
  if (changes.x === undefined && changes.y === undefined) return;
  plan.current = {
    x: Math.floor(Number(changes.x ?? tokenDocument.x) / plan.snapshot.gridSize),
    y: Math.floor(Number(changes.y ?? tokenDocument.y) / plan.snapshot.gridSize)
  };
}

/** Resynchronize the local preview with the finished move's end point, which Foundry chains its next step from. */
export function onMoveTokenMovement(tokenDocument, movement) {
  const plan = activeMovementPlan();
  if (!plan || plan.tokenId !== tokenDocument.id) return;
  const position = projectFoundryMovementPosition(tokenDocument, movement);
  if (!position) return;
  plan.current = {
    x: Math.floor(position.x / plan.snapshot.gridSize),
    y: Math.floor(position.y / plan.snapshot.gridSize)
  };
}

/** Drop the local plan when the host ends it (the Actor's movementPlanning turns false). */
export function onUpdateActorMovement(actor, changes) {
  const plan = activeMovementPlan();
  if (!plan || plan.snapshot.actorUuid !== actor.uuid) return;
  const planning = changes.system?.turn?.movementPlanning;
  if (planning === false) clearLocalPlan();
}

/** Cancel the plan when its token is destroyed, so the control lock isn't left behind. */
export function onDestroyTokenMovement(token) {
  if (token.isPreview) return;
  if (movementPlanForToken(token)) void cancelPlan({ release: false });
}

/**
 * renderTokenHUD handler: for a player who may plan for the unit, start a plan and close the HUD. The
 * TokenHUD#bind wrapper in foundry/patches/token-drag.mjs already refuses every player bind, so the HUD only
 * renders for a GM, whom this skips.
 */
export function onRenderMovementTokenHud(hud) {
  if (game.user.isGM) return false;
  const token = hud.object;
  if (!canPlanFor(token)) return false;
  void selectTokenFromPointer(token);
  void hud.close({ animate: false });
  return true;
}

/* -------------------------------------------- */
/*  Semantic actions                            */
/* -------------------------------------------- */
/**
 * The Confirm key's movement step (keybindings.mjs): confirm the open plan, or else start a plan for the
 * inspected, hovered or controlled Character, or show the reach of one this user can't command.
 */
export function selectOrConfirmMovement() {
  if (processingActive()) return false;
  const hovered = hoveredCanvasToken();
  const plan = activeMovementPlan();
  if (plan) {
    if (hovered && hovered.id !== plan.tokenId) return true;
    void confirmPlan();
    return true;
  }
  const token = pseudoSelectedToken() ?? hovered ?? globalThis.canvas?.tokens?.controlled?.[0] ?? null;
  if (!token || movementStateName() === MOVEMENT_STATES.OPENING) return false;
  const selection = resolveUnitSelection(unitSelectionFacts(token));
  if (selection.reason === UNIT_SELECTION_REASONS.TABLE_PAUSED) {
    notifications.show(NOTIFICATION_IDS.COMMAND_TABLE_PAUSED);
  }
  if (selection.outcome === UNIT_SELECTION_OUTCOMES.PLAN) void beginPlan(token);
  else if (selection.outcome === UNIT_SELECTION_OUTCOMES.INSPECT_REACH) void toggleInspectedReach(token);
  return true;
}

/** Clear inspected movement grids and play the selection cue if any were visible. */
export function clearInspectedReaches() {
  if (!clearGreyMovementGrids()) return false;
  playMovementSound(SOUND_IDS.UI_UNSELECT);
  return true;
}

/**
 * Rebuild the open plan's grid and any inspected reaches when another unit on this Scene moves (the overlay
 * refresh in init/hooks.mjs).
 */
export async function refreshMovementOverlays({ sceneUuid, tokenUuids }, valid) {
  const plan = activeMovementPlan();
  if (plan?.snapshot.sceneUuid === sceneUuid && tokenUuids.some(uuid => uuid !== plan.snapshot.tokenUuid)) {
    const snapshot = await liveSnapshot(plan);
    if (snapshot && activeMovementPlan() === plan && valid()) {
      plan.snapshot = snapshot;
      plan.graph = buildMovementGraph(snapshot);
      if (!movementIsSuspended()) {
        drawPlanField(snapshot, plan.graph);
        showReachableTeleports(snapshot.terrainTeleports, plan.graph.walkableTiles.map(cell => `${cell.x},${cell.y}`));
        drawCrossingArrows(offeredCrossings(snapshot, plan.graph));
      }
    }
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (!hasGreyMovementGrid(token.id)) continue;
    const snapshot = await game.emblemRpg.api.movement.getPlan(token.document.uuid);
    if (snapshot?.sceneUuid === sceneUuid && valid() && hasGreyMovementGrid(token.id)) {
      drawGreyMovementGrid(token.id, snapshot, buildMovementGraph(snapshot));
    }
  }
}

/**
 * The Cancel key's movement step (keybindings.mjs): back out of attack targeting first, else step the plan back
 * one stage. While a plan is open this always keeps the press, even when the plan can't step back right now.
 */
export function stepCancelMovement() {
  if (isAttackTargetingActive()) {
    clearCanvasSelectionGesture();
    if (stepCancelAttackTargeting()) return true;
  }
  if (!activeMovementPlan()) return false;
  releaseHeldMovementKeys();
  void stepCancelPlan();
  return true;
}

/** Close a non-owner BG3 inspect view when Cancel has no movement step to consume. */
export function dismissBg3HudInspection() {
  if (!clearViewOnlyHud()) return false;
  clearFacadeSelection();
  return true;
}

/** A frozen, read-only copy of the open plan's state for the other controls, or null. */
export function inspectMovementPlan() {
  const plan = activeMovementPlan();
  if (!plan) return null;
  return Object.freeze({
    tokenUuid: plan.snapshot.tokenUuid,
    anchor: plan.snapshot.start,
    current: Object.freeze({ ...plan.current }),
    allowance: plan.snapshot.allowance,
    kind: plan.kind,
    dragging: plan.dragging,
    tradeAvailable: plan.snapshot.tradeAvailable !== false,
    squareShared: !resolveMovementDestination(plan.graph, plan.current),
    moving: Boolean(plan.token?.movementAnimationPromise?.then),
    inputReady: controlsInitialized && movementAcceptsInput(),
    suspended: movementIsSuspended() && !movementIsSettling(),
    wrapperCount: tokenDragPatchCount()
  });
}

/**
 * The BG3 HUD's movement actions for the open plan: `confirm` commits the move, `end` commits it and ends the
 * turn, and `flight` asks to take off or land. onBg3HudAction in init/hooks.mjs passes on every action it
 * doesn't handle itself.
 */
export function onBg3HudMovementAction(action) {
  const plan = activeMovementPlan();
  if (!plan || !movementAcceptsInput()) return false;
  const settlement = planSettlement(plan.snapshot);
  if (action === 'confirm') {
    playMovementSound(SOUND_IDS.UI_SELECT_ALT);
    void commitPlan(plan, settlement.resume);
  } else if (action === 'end') {
    playMovementSound(SOUND_IDS.UI_CONFIRM);
    void commitPlan(plan, false);
  } else if (action === 'flight') void toggleFlight(plan);
  else return false;
  return true;
}

/* -------------------------------------------- */
/*  Flight                                      */
/* -------------------------------------------- */
/** Ask to land or take off (either ends the turn), play the mount flourish, then call api.movement.toggleFlight. */
async function toggleFlight(plan) {
  const landing = plan.snapshot.airborne === true;
  const confirmed = await openBlockingDialog({
    title: landing ? 'Land' : 'Ascend',
    content: landing ? 'Land and end turn?' : 'Ascend and end turn?',
    buttons: [
      {
        action: 'confirm',
        label: 'Yes',
        default: true,
        callback: () => {
          playMovementSound(SOUND_IDS.UI_CONFIRM);
          return true;
        }
      }
    ]
  });
  if (confirmed !== true || activeMovementPlan() !== plan || movementIsSettling()) return;
  advanceMovement(MOVEMENT_EVENTS.SETTLE);
  try {
    await playMountFlourish(plan.token?.actor, { dismount: landing });
    const result = await game.emblemRpg.api.movement.toggleFlight(plan.snapshot.tokenUuid);
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    if (activeMovementPlan() === plan) clearLocalPlan();
  } finally {
    if (activeMovementPlan() === plan) advanceMovement(MOVEMENT_EVENTS.SETTLED);
  }
}

/* -------------------------------------------- */
/*  Handing the plan over                       */
/* -------------------------------------------- */
/**
 * Hide the movement grid and hold the plan while targeting, an interaction pick or the promotion window uses the
 * unit.
 *
 * It returns true for a plan that is already suspended, whichever of those suspended it, so swapping the targeted
 * Item doesn't fail.
 * @param {string} tokenUuid Token whose plan is being handed to targeting.
 * @returns {boolean} Whether the plan is now suspended.
 */
export function suspendMovementForTargeting(tokenUuid) {
  const plan = activeMovementPlan();
  if (!plan || plan.snapshot.tokenUuid !== tokenUuid || movementIsSettling()) return false;
  if (movementIsSuspended()) return true;
  if (!movementAcceptsInput()) return false;
  advanceMovement(MOVEMENT_EVENTS.SUSPEND);
  try {
    clearMovementPlan();
    clearReachableTeleports();
    clearCrossingArrows();
    return true;
  } catch (error) {
    advanceMovement(MOVEMENT_EVENTS.SUSPEND_FAILED);
    reportFoundryError(import.meta.url, error, 'suspendMovementForTargeting');
    return false;
  }
}

/** Wait for the plan's Token to finish its movement animation, so targeting opens once the unit has stopped. */
export async function settleMovementAnimation(tokenUuid) {
  const plan = activeMovementPlan();
  if (!plan || plan.snapshot.tokenUuid !== tokenUuid) return false;
  const animation = plan.token?.movementAnimationPromise;
  if (!animation?.then) return true;
  await Promise.race([
    Promise.resolve(animation).catch((diagnosticError) => {
      reportFoundryError(import.meta.url, diagnosticError, 'settleMovementAnimation');
      return null;
    }),
    new Promise(resolve => setTimeout(resolve, MOVEMENT_SETTLE_TIMEOUT_MS))
  ]);
  return activeMovementPlan() === plan;
}

/**
 * Read the plan again from the host (api.movement.getPlan) and redraw its grid when targeting or a pick hands
 * the unit back. With no local plan for that token, open a canter the exchange may have granted instead
 * (openCanterFromState).
 * @param {string} tokenUuid Token whose plan is being handed back.
 * @param {object} [options]
 * @param {boolean} [options.announce] Sound the selection, as a hand-back after a spent action or a trade does.
 * @returns {Promise<boolean>} Whether the plan is open here again.
 */
export async function resumeMovementAfterTargeting(tokenUuid, { announce = false } = {}) {
  const plan = activeMovementPlan();
  if (!plan || plan.snapshot.tokenUuid !== tokenUuid) return openCanterFromState(tokenUuid);
  if (movementIsSettling()) return false;
  advanceMovement(MOVEMENT_EVENTS.RESUME);
  const current = movementInputHold(plan);
  return withPlanInputHeld(current, movementHoldIsCurrent, async () => {
    try {
      const snapshot = await game.emblemRpg.api.movement.getPlan(tokenUuid);
      if (activeMovementPlan() !== plan) return false;
      if (!canAdoptMovementPlan({ lock: currentLock(), snapshot, tokenUuid, userId: game.user.id })) {
        clearLocalPlan({ release: false });
        return false;
      }
      const opensCanter = snapshot.canterPathfinding === true && plan.kind !== 'canter';
      installPlan(plan.token, snapshot, plan.kind);
      if (opensCanter) openCanter(plan.token);
      else {
        if (!plan.token.controlled) plan.token.control({ releaseOthers: true, bypassBlock: true });
        if (announce) playMovementSound(SOUND_IDS.UI_SELECT);
      }
      return true;
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'Emblem RPG | Could not restore movement after targeting');
      if (activeMovementPlan() === plan) drawPlanField(plan.snapshot, plan.graph);
      return false;
    }
  });
}

/** Hold or release the plan's arrow while another workflow owns the unit, controlled or not. */
export function holdMovementIndicator(tokenUuid, held) {
  const token = canvasTokenFor(tokenUuid);
  if (token) holdPathfindingIndicator(token, held);
  return Boolean(token);
}

/** Close the movement plan at its current square after a completed interaction. */
export async function settleMovementAfterInteraction(tokenUuid) {
  const plan = activeMovementPlan();
  if (!plan || plan.snapshot.tokenUuid !== tokenUuid || movementIsSettling()) return false;
  await commitPlan(plan, false);
  return activeMovementPlan() !== plan;
}

/**
 * Cancel a suspended plan because its token was deselected mid-targeting (targeting's `movement.cancel` helper).
 *
 * A refused cancel leaves the plan standing in `SUSPENDED_RELEASED`, which takes player input again while the
 * movement grid is still hidden. The `finally` then hands the plan back through resumeMovementAfterTargeting,
 * which moves on to PLANNING and redraws the grid.
 */
export async function cancelSuspendedMovement(tokenUuid) {
  const plan = activeMovementPlan();
  if (!plan || plan.snapshot.tokenUuid !== tokenUuid || !movementIsSuspended()) return false;
  try {
    await cancelPlan({ release: false });
    return activeMovementPlan() !== plan;
  } finally {
    if (activeMovementPlan() === plan) await resumeMovementAfterTargeting(tokenUuid);
  }
}

/** Paint the plan the way its kind is drawn: a canter without reach, exploration without any grid at all. */
function drawPlanField(snapshot, graph) {
  if (snapshot.exploring === true) {
    clearMovementPlan();
    return;
  }
  drawMovementPlan(snapshot, graph, { attackReach: snapshot.canterPathfinding !== true });
  drawMovementHints(planMovementHints(snapshot), snapshot.gridSize);
}

function planSettlement(snapshot, resume) {
  return planMovementSettlement({ canter: snapshot.canterPathfinding, exploring: snapshot.exploring, resume });
}

/** Select the token again for its canter, centre the camera on it and play the cue. Callers install the plan first. */
function openCanter(token) {
  token.control({ releaseOthers: true, bypassBlock: true });
  centerOnToken(token);
  playMovementSound(SOUND_IDS.UI_SELECT);
}

/**
 * Open a canter from the unit's saved turn data when a combat exchange granted one and this client has no plan.
 * @param {string} tokenUuid Token the exchange resolved.
 * @returns {Promise<boolean>} Whether a canter is now open here.
 */
async function openCanterFromState(tokenUuid) {
  if (movementStateName() !== MOVEMENT_STATES.IDLE) return false;
  try {
    const snapshot = await game.emblemRpg.api.movement.getPlan(tokenUuid);
    if (activeMovementPlan() || snapshot?.movementPlanning !== true || snapshot.canterPathfinding !== true) {
      return false;
    }
    const userId = String(game.user.id ?? '');
    if (snapshot.movementControllerId !== userId) return false;
    const token = canvasTokenFor(tokenUuid);
    if (!token) return false;
    installPlan(token, snapshot, 'canter');
    openCanter(token);
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Could not open the canter the exchange armed');
    return false;
  }
}

/** The placed Token with this uuid, found on the canvas without an asynchronous lookup. */
function canvasTokenFor(tokenUuid) {
  const placeables = globalThis.canvas?.tokens?.placeables ?? [];
  return placeables.find(token => token.document.uuid === tokenUuid) ?? null;
}

/* -------------------------------------------- */
/*  Player input                                */
/* -------------------------------------------- */
/**
 * A right-click on an owned unit (through the TokenHUD#bind wrapper) starts a plan for it. Right-clicking the unit
 * already being moved confirms its plan instead, the same as the Confirm key.
 */
async function selectTokenFromPointer(token) {
  if (movementStateName() === MOVEMENT_STATES.OPENING) return true;
  const plan = activeMovementPlan();
  if (plan?.tokenId === token?.id) {
    await confirmPlan();
    return true;
  }
  if (plan?.kind === 'committed') {
    await stepCancelPlan();
    return false;
  }
  if (plan) await cancelPlan();
  if (activeMovementPlan()) return false;
  return beginPlan(token);
}

/* -------------------------------------------- */
/*  Beginning a move                            */
/* -------------------------------------------- */
async function beginPlan(token) {
  if (movementStateName() !== MOVEMENT_STATES.IDLE || !canPlanFor(token)) return false;
  advanceMovement(MOVEMENT_EVENTS.OPEN);
  clearGreyMovementGrids();
  const tokenUuid = token.document.uuid;
  let acquired = false;
  try {
    const result = await game.emblemRpg.api.movement.begin(tokenUuid);
    const uncertain = result.code === RESULT_CODES.COMMAND_OUTCOME_UNKNOWN;
    if (!result.ok && !uncertain) {
      notifications.showResult(result);
      return false;
    }
    acquired = result.ok;
    const snapshot = await game.emblemRpg.api.movement.getPlan(tokenUuid);
    if (!canAdoptMovementPlan({ lock: currentLock(), snapshot, tokenUuid, userId: game.user.id })) {
      if (uncertain) notifications.showResult(result);
      return false;
    }
    installPlan(token, snapshot, 'initial');
    token.control({ releaseOthers: true, bypassBlock: true });
    centerOnToken(token);
    playMovementSound(SOUND_IDS.UI_SELECT);
    acquired = false;
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Could not install movement preview');
    return false;
  } finally {
    try {
      if (acquired) {
        const released = await game.emblemRpg.api.movement.cancel(tokenUuid);
        if (!released.ok) notifications.showResult(released);
        if (activeMovementPlan()?.snapshot.tokenUuid === tokenUuid) clearLocalPlan();
      }
    } finally { advanceMovement(MOVEMENT_EVENTS.OPEN_FAILED); }
  }
}

function installPlan(token, snapshot, kind) {
  clearFacadeSelection();
  const graph = buildMovementGraph(snapshot);
  advanceMovement(MOVEMENT_EVENTS.INSTALL, createMovementPlan({ token, snapshot, graph, kind }));
  drawPlanField(snapshot, graph);
  showReachableTeleports(snapshot.terrainTeleports, graph.walkableTiles.map(cell => `${cell.x},${cell.y}`));
  drawCrossingArrows(offeredCrossings(snapshot, graph));
}

/**
 * The crossing arrows the plan can show: every crossing this unit could attempt, each with its odds and odds band.
 * Empty when planCrossingAttempt rules out crossing at all.
 */
function offeredCrossings(snapshot, graph) {
  const eligibility = planCrossingAttempt({
    exploring: snapshot.exploring,
    airborne: snapshot.airborne,
    stranded: movementStranded(snapshot),
    mounted: snapshot.mounted,
    stance: snapshot.stance,
    actionAvailable: snapshot.standardAvailable,
    movementRemaining: snapshot.allowance
  });
  if (!eligibility.ok) return [];
  return collectCrossingOptions(snapshot, graph);
}

/* -------------------------------------------- */
/*  Committing                                  */
/* -------------------------------------------- */
async function confirmPlan() {
  const plan = activeMovementPlan();
  if (!plan || !movementAcceptsInput()) return;
  if (localUserFrozenByPause()) {
    notifications.show(NOTIFICATION_IDS.COMMAND_TABLE_PAUSED);
    playMovementSound(SOUND_IDS.UI_ERROR);
    return;
  }
  const current = movementInputHold(plan);
  return withPlanInputHeld(current, movementHoldIsCurrent, async () => {
    const snapshot = await liveSnapshot(plan);
    if (!snapshot || activeMovementPlan() !== plan) return;
    const graph = buildMovementGraph(snapshot, { attackReach: false, keyboardDiagonals: false });
    const resolution = resolveMovementDestination(graph, snapshot.current);
    if (!resolution) {
      notifications.show(NOTIFICATION_IDS.MOVEMENT_DESTINATION_INVALID, {
        occupied: Boolean(resolveMovementPreview(graph, snapshot.current)), actorName: snapshot.actorName
      });
      return;
    }
    const pad = usableTransitionUnderfoot(snapshot);
    if (pad && snapshot.exploring === true) return useTransition(plan);
    const settlement = planSettlement(snapshot);
    if (settlement.prompt === MOVEMENT_PROMPTS.NONE) return commitPlan(plan, settlement.resume);
    const atAnchor = sameCell(snapshot.current, snapshot.start);
    const action = settlement.prompt === MOVEMENT_PROMPTS.END_TURN
      ? await endTurnPrompt(atAnchor)
      : atAnchor && !pad ? await endTurnPrompt() : await movementPrompt(plan, pad);
    if (action && activeMovementPlan() === plan) await commitPlan(plan, action === 'confirm');
  });
}

async function commitPlan(plan, resume) {
  advanceMovement(MOVEMENT_EVENTS.SETTLE);
  try {
    const result = await game.emblemRpg.api.movement.commit({
      tokenUuid: plan.snapshot.tokenUuid,
      resume
    });
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    if (activeMovementPlan() !== plan) return;
    if (!resume) {
      clearLocalPlan();
      return;
    }
    const snapshot = await game.emblemRpg.api.movement.getPlan(plan.snapshot.tokenUuid);
    if (snapshot?.movementPlanning && activeMovementPlan() === plan) {
      installPlan(plan.token, snapshot, 'committed');
    } else if (activeMovementPlan() === plan) {
      await releaseUnusablePlan(plan);
    }
  } finally {
    if (activeMovementPlan() === plan) advanceMovement(MOVEMENT_EVENTS.SETTLED);
  }
}

/* -------------------------------------------- */
/*  Cancelling                                  */
/* -------------------------------------------- */
/**
 * The Cancel key on an open plan. A retractable item use the unit hasn't moved since is taken back first. Otherwise
 * the plan rolls back to where it started, or closes when it can't. While a use is kept, a moved unit rolls back
 * rather than closing its plan, so a second Cancel can take the use back.
 */
async function stepCancelPlan() {
  const plan = activeMovementPlan();
  if (!plan || !movementAcceptsInput()) return;
  const current = movementInputHold(plan);
  return withPlanInputHeld(current, movementHoldIsCurrent, async () => {
    if (plan.token?.movementAnimationPromise) return cancelPlan();
    const snapshot = await liveSnapshot(plan);
    if (!snapshot || activeMovementPlan() !== plan) return;
    if (snapshot.retraction?.pending === true && snapshot.retraction.moved !== true) return retractUse(plan, snapshot);
    const rollsBack = plan.kind === 'committed'
      || (snapshot.retraction?.pending === true && !sameCell(snapshot.current, snapshot.start));
    if (!planSettlement(snapshot).rollback || !rollsBack) return cancelPlan();
    if (sameCell(snapshot.current, snapshot.start)) {
      const action = await endTurnPrompt();
      if (action === 'end' && activeMovementPlan() === plan) await commitPlan(plan, false);
      return;
    }
    advanceMovement(MOVEMENT_EVENTS.ROLLBACK);
    try {
      const result = await game.emblemRpg.api.movement.rollback(snapshot.tokenUuid);
      if (!result.ok) {
        notifications.showResult(result);
        return;
      }
      if (activeMovementPlan() !== plan) return;
      const restored = await game.emblemRpg.api.movement.getPlan(snapshot.tokenUuid);
      if (restored?.movementPlanning && activeMovementPlan() === plan) {
        installPlan(plan.token, restored, 'committed');
        playMovementSound(SOUND_IDS.UI_UNSELECT);
      } else if (activeMovementPlan() === plan) await releaseUnusablePlan(plan);
    } finally { advanceMovement(MOVEMENT_EVENTS.ROLLED_BACK); }
  });
}

/** Take back the unit's retractable item use (api.items.retract), then redraw the plan as a rollback does. */
async function retractUse(plan, snapshot) {
  advanceMovement(MOVEMENT_EVENTS.ROLLBACK);
  try {
    const result = await game.emblemRpg.api.items.retract(snapshot.tokenUuid);
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    if (activeMovementPlan() !== plan) return;
    const restored = await game.emblemRpg.api.movement.getPlan(snapshot.tokenUuid);
    if (restored?.movementPlanning && activeMovementPlan() === plan) {
      installPlan(plan.token, restored, plan.kind);
      playMovementSound(SOUND_IDS.UI_UNSELECT);
    } else if (activeMovementPlan() === plan) await releaseUnusablePlan(plan);
  } finally { advanceMovement(MOVEMENT_EVENTS.ROLLED_BACK); }
}

async function cancelPlan({ release = true } = {}) {
  const plan = activeMovementPlan();
  if (!plan || movementIsSettling()) return;
  advanceMovement(MOVEMENT_EVENTS.SETTLE);
  try {
    interruptFoundryTokenMovement(plan.token);
    stopTokenFootstepAnimation(plan.token);
    const result = await game.emblemRpg.api.movement.cancel(plan.snapshot.tokenUuid);
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    const held = activeMovementPlan();
    if (held === plan || held === null) {
      clearLocalPlan({ release });
      playMovementSound(SOUND_IDS.UI_UNSELECT);
    }
  } finally {
    if (activeMovementPlan() === plan) advanceMovement(MOVEMENT_EVENTS.SETTLED);
  }
}

async function releaseUnusablePlan(plan) {
  const result = await game.emblemRpg.api.movement.cancel(plan.snapshot.tokenUuid);
  if (!result.ok) {
    notifications.showResult(result);
    return;
  }
  if (activeMovementPlan() === plan) clearLocalPlan();
}

function clearLocalPlan({ release = true } = {}) {
  const plan = activeMovementPlan();
  advanceMovement(MOVEMENT_EVENTS.CLEAR);
  if (plan?.controlRecoveryTimer != null) clearTimeout(plan.controlRecoveryTimer);
  clearMovementPlan();
  clearReachableTeleports();
  clearCrossingArrows();
  if (release && plan?.token.controlled) plan.token.release();
}

async function liveSnapshot(plan) {
  const snapshot = await game.emblemRpg.api.movement.getPlan(plan.snapshot.tokenUuid);
  if (!snapshot?.movementPlanning) {
    if (activeMovementPlan() === plan) clearLocalPlan({ release: false });
    return null;
  }
  return snapshot;
}

/* -------------------------------------------- */
/*  Terrain crossings                           */
/* -------------------------------------------- */

/**
 * Offer the crossings a refused step leads to, rather than only refusing it.
 *
 * A step off the movement grid onto another level isn't an illegal move, so the step is vetoed and the player is
 * asked about the crossing instead. ui/controls/crossing-offer.mjs shows the dialog. This function decides
 * whether there is a crossing to offer, and promptCrossing sends the player's answer.
 * @param {object} plan The active plan.
 * @param {{x: number, y: number}} destination The square the step aimed at.
 * @returns {boolean} Whether a crossing was offered.
 */
function offerCrossing(plan, destination) {
  if (movementStateName() !== MOVEMENT_STATES.PLANNING) return false;
  const snapshot = plan.snapshot;
  const eligibility = planCrossingAttempt({
    exploring: snapshot.exploring,
    airborne: snapshot.airborne,
    stranded: movementStranded(snapshot),
    mounted: snapshot.mounted,
    stance: snapshot.stance,
    actionAvailable: snapshot.standardAvailable,
    movementRemaining: snapshot.allowance - (plan.graph.costByCell[`${plan.current.x},${plan.current.y}`] ?? 0)
  });
  if (!eligibility.ok) return false;
  const options = crossingCandidates(snapshot, plan.current, destination);
  if (!options.length) return false;
  advanceMovement(MOVEMENT_EVENTS.OFFER_CROSSING);
  void promptCrossing(plan, options);
  return true;
}

async function promptCrossing(plan, options) {
  try {
    const chosen = await crossingDialog(plan.snapshot, options);
    if (!chosen || activeMovementPlan() !== plan) return;
    advanceMovement(MOVEMENT_EVENTS.SETTLE);
    const result = await game.emblemRpg.api.movement.cross({
      tokenUuid: plan.snapshot.tokenUuid,
      destinationX: chosen.to.x,
      destinationY: chosen.to.y
    });
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    if (activeMovementPlan() === plan) clearLocalPlan();
  } finally {
    if (activeMovementPlan() === plan) advanceMovement(MOVEMENT_EVENTS.CROSSING_DONE);
  }
}

/* -------------------------------------------- */
/*  Movement prompts                            */
/* -------------------------------------------- */
function endTurnPrompt(atAnchor = true) {
  return movementDialog({
    content: atAnchor ? 'End turn?' : 'Move and end turn?',
    buttons: [
      {
        action: 'confirm',
        label: 'Yes',
        default: true,
        callback: () => {
          playMovementSound(SOUND_IDS.UI_CONFIRM);
          return 'end';
        }
      }
    ]
  });
}

/**
 * The transition square under the unit, when it is one this unit may actually step off. A stranded unit steps off
 * none, so confirmPlan offers it the end of its turn rather than a hop the host would refuse.
 */
function usableTransitionUnderfoot(snapshot) {
  if (movementStranded(snapshot)) return null;
  const pad = teleportPadAt(snapshot.terrainTeleports, snapshot.current);
  return pad && !pad.restricted ? pad : null;
}

/** How a pad's activation cost reads in the offer. */
function transitionCostLabel(pad) {
  if (pad.cost === TELEPORT_COSTS.MOVEMENT) return `${pad.movementCost} Movement`;
  if (pad.cost === TELEPORT_COSTS.BONUS) return 'Bonus Action';
  return 'Action';
}

/**
 * Use the transition square under the unit (api.movement.teleport).
 *
 * A hop paid with Movement, or made while exploring, reopens the plan on the far side. So does a hop paid with a
 * bonus action, but it uses up the unit's movement (resolveTeleportCost in game/terrain/rules.mjs). A hop paid
 * with an action ends the turn, and the plan is released rather than redrawn.
 */
async function useTransition(plan) {
  advanceMovement(MOVEMENT_EVENTS.SETTLE);
  try {
    const result = await game.emblemRpg.api.movement.teleport(plan.snapshot.tokenUuid);
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    if (activeMovementPlan() !== plan) return;
    if (result.data.resumed !== true) {
      clearLocalPlan();
      return;
    }
    const snapshot = await game.emblemRpg.api.movement.getPlan(plan.snapshot.tokenUuid);
    if (snapshot?.movementPlanning && activeMovementPlan() === plan) installPlan(plan.token, snapshot, plan.kind);
    else if (activeMovementPlan() === plan) await releaseUnusablePlan(plan);
  } finally {
    if (activeMovementPlan() === plan) advanceMovement(MOVEMENT_EVENTS.SETTLED);
  }
}

function movementPrompt(plan, pad = null) {
  return movementDialog({
    content: pad
      ? `<div class="movement-transition-offer">
            <div class="transition-title">Use Transition Square?</div>
            <div class="transition-detail">${pad.letter}: ${transitionCostLabel(pad)}</div>
            <button type="button" class="transition-confirm" data-action="useTransition">Confirm</button>
          </div>`
      : 'Move',
    vertical: !pad,
    transition: Boolean(pad),
    onOpen: pad ? dialog => {
      dialog.element.querySelector('.transition-confirm')?.addEventListener('click', async () => {
        playMovementSound(SOUND_IDS.UI_SELECT_ALT);
        await dialog.close();
        await useTransition(plan);
      });
    } : null,
    buttons: [
      {
        action: 'confirm',
        label: 'Confirm Move',
        default: true,
        callback: () => {
          playMovementSound(SOUND_IDS.UI_SELECT_ALT);
          return 'confirm';
        }
      },
      {
        action: 'endTurn',
        label: 'Move and End',
        callback: () => {
          playMovementSound(SOUND_IDS.UI_CONFIRM);
          return 'end';
        }
      }
    ]
  });
}

function movementDialog({ content, buttons, vertical = false, transition = false, onOpen = null }) {
  return openBlockingDialog({
    title: 'Movement Confirmation',
    content,
    buttons,
    onOpen,
    dialogClass: transition ? 'confirm-movement-transition' : vertical ? 'confirm-movement-vertical' : null
  });
}

function playMovementSound(soundId) {
  playUiSound(soundId);
}

/* -------------------------------------------- */
/*  Foundry drag boundary                       */
/* -------------------------------------------- */
/** Inject movement handlers into foundry/patches/token-drag.mjs, which owns wrapper registration. */
function installMovementWrappers() {
  return installTokenDragPatches({
    activePlanForToken: movementPlanForToken,
    tokenControlAllowed,
    processingActive,
    movementInputPermission,
    drivenHoldActive,
    isActivationTargetingActive,
    onCanvasClickActivationTargeting,
    clearCanvasSelectionGesture,
    onTokenClickInteraction,
    onTokenClickAttackTargeting,
    tokenPickAwaitingClick,
    withGmLeftClickHudControlSuppressed,
    isAttackTargetingActive,
    canvasMarqueePermission,
    initializePathedDrag,
    updatePathedDrag,
    addPathedDragWaypoint,
    finalizePathedDrag,
    playSelectionBlip,
    holdPathedDragRuler,
    refreshPathedDragRuler,
    refreshPathedDragState,
    stylePathedDragPath,
    stylePathedDragGrid,
    showGmHudForTokenHud,
    canPlanFor,
    selectTokenFromPointer,
    onTokenClickInspect
  });
}

function clearCanvasSelectionGesture() {
  const selection = globalThis.canvas?.controls?.select;
  if (!selection) return;
  selection.active = false;
  selection.clear?.();
}

/* -------------------------------------------- */
/*  Map helpers                                 */
/* -------------------------------------------- */
function unitSelectionFacts(token) {
  const turn = token.actor?.system?.turn ?? {};
  const scene = token.document.parent ?? globalThis.canvas?.scene ?? null;
  return {
    playing: sceneCombatActive(scene) === true || sceneExplorationActive(scene) === true,
    isUnit: token.actor?.type === 'Character',
    controllable: canPlanFor(token),
    owned: ownsUnit(token),
    standardAvailable: turn.actionAvailable !== false,
    movementAvailable: turn.movementAvailable !== false,
    otherUnitControlled: (globalThis.canvas?.tokens?.controlled?.length ?? 0) > 0,
    paused: worldPaused(),
    userIsGm: localUserIsStaff()
  };
}

async function toggleInspectedReach(token) {
  if (clearGreyMovementGrid(token.id)) {
    playMovementSound(SOUND_IDS.UI_UNSELECT);
    return;
  }
  try {
    const snapshot = await game.emblemRpg.api.movement.getPlan(token.document.uuid);
    if (!snapshot?.supportedGrid || hasGreyMovementGrid(token.id)) return;
    if (!drawGreyMovementGrid(token.id, snapshot, buildMovementGraph(snapshot))) return;
    playMovementSound(SOUND_IDS.UI_CLICK);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Could not draw the inspected movement reach');
  }
}

function centerOnToken(token) {
  const center = token.center;
  if (!center || !globalThis.canvas?.animatePan) return;
  void canvas.animatePan({ x: center.x, y: center.y, duration: 325 });
}

function sameCell(left, right) {
  return left?.x === right?.x && left?.y === right?.y;
}
