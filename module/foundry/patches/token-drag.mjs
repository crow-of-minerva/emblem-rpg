/** @layer foundry/patches */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { isAirborneActor } from '../adapters/projections/combat-context.mjs';
import { coreKeybindingAllowed, verticalMovementActionIds } from '../../game/movement/input-policy.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Installation                                */
/* -------------------------------------------- */

/** The targets of the Foundry Token wrappers registered for the movement controls, which tokenDragPatchCount counts. */
const registered = [];

/**
 * Install the selection, drag, ruler and keyboard wrappers the movement controls need. Called once by
 * ui/controls/movement.mjs, which passes its handlers.
 * @param {object} handlers Movement-control handlers, called with the placeable as `this` where relevant.
 * @returns {boolean} Whether libWrapper was present to register them.
 */
export function installTokenDragPatches(handlers) {
  if (!globalThis.libWrapper) {
    reportFoundryError(import.meta.url, null, 'Emblem RPG | libWrapper is required for player Token movement controls.');
    return false;
  }
  globalThis.libWrapper.ignore_conflicts?.(
    SYSTEM_ID,
    'fxmaster',
    'CONFIG.Token.rulerClass.prototype._getGridHighlightStyle'
  );
  registerSelectionPatches(handlers);
  registerAirbornePatches();
  registerPathedDragPatches(handlers);
  registerKeyboardPatches();
  return true;
}

/* -------------------------------------------- */
/*  Selection and targeting                     */
/* -------------------------------------------- */

/** Control, click, marquee and HUD binding: who may pick a unit up, and what picking it up means. */
function registerSelectionPatches(handlers) {
  register('foundry.canvas.placeables.Token.prototype.control', function (wrapped, options = {}) {
    if (!handlers.tokenControlAllowed(this, { restore: options.bypassBlock === true })) return false;
    if (game.user.isGM) {
      const result = wrapped(options);
      if (options.bypassBlock !== true) handlers.playSelectionBlip();
      return result;
    }
    if (options.bypassBlock !== true || !handlers.activePlanForToken(this)) return false;
    return wrapped({ ...options, releaseOthers: true });
  }, 'MIXED');

  register('foundry.canvas.placeables.Token.prototype._refreshBorder', function () {
    if (!this.border) return;
    this.border.clear?.();
    this.border.visible = false;
  }, 'OVERRIDE');

  register('foundry.canvas.placeables.Token.prototype._refreshTarget', function () {
    for (const graphic of [this.targetArrows, this.targetPips]) {
      if (!graphic) continue;
      graphic.clear?.();
      graphic.visible = false;
    }
  }, 'OVERRIDE');

  register('foundry.canvas.placeables.Token.prototype._onClickLeft', function (wrapped, event) {
    if (handlers.processingActive()) {
      handlers.onTokenClickInspect(this);
      return undefined;
    }
    if (handlers.isActivationTargetingActive()
      && handlers.onCanvasClickActivationTargeting(canvasGridCell(event))) {
      handlers.clearCanvasSelectionGesture();
      return undefined;
    }
    if (handlers.onTokenClickInteraction(this) || handlers.onTokenClickAttackTargeting(this)) {
      handlers.clearCanvasSelectionGesture();
      return undefined;
    }
    if (game.user.isGM && handlers.tokenControlAllowed(this)) {
      return handlers.withGmLeftClickHudControlSuppressed(() => wrapped(event));
    }
    handlers.onTokenClickInspect(this);
    return undefined;
  }, 'MIXED');

  // Foundry asks _canControl before _onClickLeft runs, and a player may control no token outside their own plan. A
  // target-picking click still gets through, so _onClickLeft can route it. The click handler enforces the planning
  // control lock.
  register('foundry.canvas.placeables.Token.prototype._canControl', function (wrapped, user, event) {
    if (!event) return user?.isGM ? handlers.tokenControlAllowed(this) && wrapped(user, event) : wrapped(user, event);
    if (handlers.activePlanForToken(this)) return wrapped(user, event);
    if (event.type === 'pointerdown' && this.layer?.active === true && handlers.tokenPickAwaitingClick()) return true;
    return user?.isGM === true && handlers.tokenControlAllowed(this) && wrapped(user, event);
  }, 'MIXED');

  register('foundry.canvas.layers.TokenLayer.prototype._onClickLeft', function (wrapped, event) {
    if (handlers.processingActive()) return undefined;
    if (handlers.isActivationTargetingActive()
      && handlers.onCanvasClickActivationTargeting(canvasGridCell(event))) {
      handlers.clearCanvasSelectionGesture();
      return undefined;
    }
    return wrapped(event);
  }, 'MIXED');

  register('foundry.canvas.layers.TokenLayer.prototype.selectObjects', function (wrapped, ...args) {
    if (handlers.isAttackTargetingActive() || !handlers.canvasMarqueePermission().allowed) {
      handlers.clearCanvasSelectionGesture();
      return false;
    }
    return wrapped(...args);
  }, 'MIXED');

  register('foundry.canvas.layers.ControlsLayer.prototype.drawSelect', function (wrapped, ...args) {
    if (handlers.isAttackTargetingActive() || !handlers.canvasMarqueePermission().allowed) {
      handlers.clearCanvasSelectionGesture();
      return undefined;
    }
    return wrapped(...args);
  }, 'MIXED');

  register('foundry.applications.hud.TokenHUD.prototype.bind', function (wrapped, token, ...args) {
    if (game.user.isGM && handlers.tokenControlAllowed(token)) {
      handlers.showGmHudForTokenHud(token);
      return wrapped(token, ...args);
    }
    if (handlers.canPlanFor(token)) void handlers.selectTokenFromPointer(token);
    else if (!handlers.onTokenClickInspect(token)) handlers.playSelectionBlip();
    return false;
  }, 'MIXED');
}

/* -------------------------------------------- */
/*  Airborne wall exemption                     */
/* -------------------------------------------- */

/** A unit in the air is over the walls, so Foundry's own collision and path constraint stop applying to it. */
function registerAirbornePatches() {
  register('foundry.canvas.placeables.Token.prototype.checkCollision', function (wrapped, destination, options = {}) {
    if (isAirborneActor((this.document ?? this).actor)) return false;
    return wrapped(destination, options);
  }, 'MIXED');

  register('foundry.canvas.placeables.Token.prototype.constrainMovementPath',
    function (wrapped, waypoints, options = {}) {
      if (isAirborneActor((this.document ?? this).actor)) options.ignoreWalls = true;
      return wrapped(waypoints, options);
    }, 'WRAPPER');
}

/* -------------------------------------------- */
/*  Pathed drag                                 */
/* -------------------------------------------- */

/** Route Foundry drag and ruler calls to the injected movement-control handlers. */
function registerPathedDragPatches(handlers) {
  register('foundry.canvas.placeables.Token.prototype._canDrag', function (wrapped, user, event) {
    if (handlers.isAttackTargetingActive() || !handlers.movementInputPermission(this, 'mouse-drag').allowed) return false;
    if (user?.isGM || handlers.activePlanForToken(this)) return wrapped(user, event);
    return false;
  }, 'MIXED');

  register('foundry.canvas.placeables.Token.prototype._canDragLeftStart',
    function (wrapped, user, event, options) {
      if (handlers.isAttackTargetingActive() || !handlers.movementInputPermission(this, 'mouse-drag').allowed) return false;
      if (user?.isGM || handlers.activePlanForToken(this)) return wrapped(user, event, options);
      return false;
    }, 'MIXED');

  register('foundry.canvas.placeables.Token.prototype._initializeDragLeft',
    handlers.initializePathedDrag, 'WRAPPER');
  register('foundry.canvas.placeables.Token.prototype._updateDragDestination',
    handlers.updatePathedDrag, 'MIXED');
  register('foundry.canvas.placeables.Token.prototype._addDragWaypoint',
    handlers.addPathedDragWaypoint, 'MIXED');
  register('foundry.canvas.placeables.Token.prototype._finalizeDragLeft',
    handlers.finalizePathedDrag, 'WRAPPER');
  register('foundry.canvas.placeables.Token.prototype._onDragLeftDrop',
    handlers.holdPathedDragRuler, 'WRAPPER');
  register('foundry.canvas.placeables.Token.prototype._refreshRuler',
    handlers.refreshPathedDragRuler, 'MIXED');
  register('foundry.canvas.placeables.Token.prototype._refreshState',
    handlers.refreshPathedDragState, 'WRAPPER');

  register('CONFIG.Token.rulerClass.prototype._getSegmentStyle', handlers.stylePathedDragPath, 'WRAPPER');
  register('CONFIG.Token.rulerClass.prototype._getWaypointStyle', handlers.stylePathedDragPath, 'WRAPPER');
  register('CONFIG.Token.rulerClass.prototype._getGridHighlightStyle', handlers.stylePathedDragGrid, 'WRAPPER');
}

/* -------------------------------------------- */
/*  Keyboard actions                            */
/* -------------------------------------------- */

/** Core's own vertical-movement bindings are dropped while a unit is controlled, so they cannot fight the plan. */
function registerKeyboardPatches() {
  register('foundry.helpers.interaction.KeyboardManager._getMatchingActions', function (wrapped, context) {
    const actions = wrapped(context);
    if (!Array.isArray(actions) || !actions.length) return actions;
    const verticalIds = verticalMovementActionIds(registeredKeybindingActions());
    const tokenControlled = (globalThis.canvas?.tokens?.controlled?.length ?? 0) > 0;
    return actions.filter(action => coreKeybindingAllowed({
      id: `${action?.namespace ?? ''}.${action?.action ?? ''}`, verticalIds, tokenControlled
    }));
  }, 'WRAPPER');
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/** How many Foundry wrappers are registered here, for the movement controls' state report (wrapperCount). */
export function tokenDragPatchCount() {
  return registered.length;
}

function register(target, handler, type) {
  globalThis.libWrapper.register(SYSTEM_ID, target, handler, type);
  registered.push(target);
}

/** Every registered keybinding action as `{id, name}`, read fresh each time so a rebind takes effect at once. */
function registeredKeybindingActions() {
  return [...game.keybindings.actions.entries()]
    .map(([id, action]) => ({ id: String(id), name: String(action?.name ?? '') }));
}

function canvasGridCell(event) {
  const origin = event?.interactionData?.origin ?? event?.data?.origin ?? null;
  const gridSize = Math.max(1, Number(globalThis.canvas?.grid?.size) || 1);
  if (!origin) return null;
  return { x: Math.floor(Number(origin.x) / gridSize), y: Math.floor(Number(origin.y) / gridSize) };
}

/**
 * Stop a token's running Foundry movement on this client before the host moves it back, when a plan is cancelled
 * (cancelPlan in ui/controls/movement.mjs). Returns false when the token isn't moving.
 */
export function interruptFoundryTokenMovement(token) {
  if (!token?.movementAnimationPromise) return false;
  token.document?.stopMovement?.();
  return true;
}
