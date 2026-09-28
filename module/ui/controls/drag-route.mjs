/** @layer ui/controls */
import {
  activateMovementRuler,
  applyMovementRulerGridStyle,
  applyMovementRulerPathStyle,
  movementRulerRefreshMode,
  scheduleMovementRulerCleanup
} from '../../presentation/canvas/cell-overlays.mjs';
import { activeMovementPlan, movementPlanForToken } from './movement-state.mjs';
import { movementStranded, resolveMovementPreviewFrom } from '../../game/movement/pathfinding.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../presentation/interface/notifications.mjs';
import { reportFoundryError, FoundryDiagnostics } from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Pathed Token drag                           */
/* -------------------------------------------- */

/*
 * Make Foundry's own Token drag follow the movement graph. ui/controls/movement.mjs hands these functions to
 * foundry/patches/token-drag.mjs, which registers them as libWrapper wrappers, so each runs with the dragged
 * placeable as `this` and Foundry's own method as `wrapped`. They read the plan held in
 * ui/controls/movement-state.mjs and rewrite the drag's waypoints. They never write the document.
 */
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/** Mark the drag as the plan's and open the movement ruler on every pathed context. */
export function initializePathedDrag(wrapped, event) {
  const plan = movementPlanForToken(this);
  if (plan) {
    plan.dragging = true;
    plan.dragOrigin = { ...plan.current };
    plan.restoreControlAfterDrag = false;
  }

  let result;
  try {
    result = wrapped.call(this, event);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'initializePathedDrag');
    finishPathedDrag(plan);
    throw error;
  }
  const contexts = event?.interactionData?.contexts ?? {};
  for (const context of Object.values(contexts)) {
    if (!movementPlanForToken(context.token)) continue;
    context.emblemMovementPath = true;
    activateMovementRuler(context.token);
  }
  return result;
}

/** Route every pathed context through the graph. Contexts without a plan keep Foundry's own drag. */
export function updatePathedDrag(wrapped, point, options = {}) {
  const contexts = Object.values(this.mouseInteractionManager?.interactionData?.contexts ?? {});
  const pathed = contexts.filter(context => context.emblemMovementPath && movementPlanForToken(context.token));
  if (!pathed.length) return wrapped.call(this, point, options);

  let result;
  if (pathed.length !== contexts.length) result = wrapped.call(this, point, options);
  for (const context of pathed) updatePathedContext(context, point, options);
  return result;
}

/** Let Foundry settle the drag, then drop the drag mark and schedule the ruler's cleanup. */
export function finalizePathedDrag(wrapped, event) {
  const plan = movementPlanFromContexts(event) ?? movementPlanForToken(this);
  const tokens = movementTokensFromContexts(event);
  for (const token of tokens) activateMovementRuler(token);
  let result;
  try {
    result = wrapped.call(this, event);
  } finally {
    finishPathedDrag(plan);
  }
  for (const token of tokens) scheduleMovementRulerCleanup(token);
  return result;
}

/**
 * Keep the ruler drawn through the drop, which Foundry would otherwise clear. A stranded unit's drag draws no
 * route, so Foundry sends no move for onPreUpdateTokenMovement to refuse. Instead, a drop that updatePathedContext
 * marked as stranded shows the stranded notice here, unless addPathedDragWaypoint already showed it for a waypoint
 * added in this drag.
 */
export function holdPathedDragRuler(wrapped, event) {
  const contexts = Object.values(event?.interactionData?.contexts ?? {});
  for (const token of movementTokensFromContexts(event)) activateMovementRuler(token);
  const result = wrapped.call(this, event);
  if (event?.interactionData?.dropped === true
    && contexts.some(context => context.emblemStranded === true && context.emblemStrandedShown !== true)) {
    notifications.show(NOTIFICATION_IDS.MOVEMENT_STRANDED);
  }
  return result;
}

/** Freeze or clear the native ruler refresh while the movement ruler owns the drawn path. */
export function refreshPathedDragRuler(wrapped, ...args) {
  const mode = movementRulerRefreshMode(this);
  if (mode === 'freeze') return;
  if (mode === 'clear') {
    this.ruler.refresh({ passedWaypoints: [], pendingWaypoints: [], plannedMovement: {} });
    return;
  }
  return wrapped.call(this, ...args);
}

/** Hide the ruler from Foundry's own state refresh while it is frozen. */
export function refreshPathedDragState(wrapped, ...args) {
  if (movementRulerRefreshMode(this) !== 'freeze' || !this.ruler) return wrapped.call(this, ...args);
  const ruler = this.ruler;
  this.ruler = null;
  try {
    return wrapped.call(this, ...args);
  } finally {
    this.ruler = ruler;
  }
}

/**
 * Route an added waypoint through the movement graph. A waypoint out of range is refused with a notice, and the
 * drag goes on. Contexts without a plan are left to Foundry.
 */
export function addPathedDragWaypoint(wrapped, point, options = {}) {
  const contexts = Object.values(this.mouseInteractionManager?.interactionData?.contexts ?? {});
  const pathed = contexts.filter(context => context.emblemMovementPath && movementPlanForToken(context.token));
  if (!pathed.length) return wrapped.call(this, point, options);
  for (const context of pathed) {
    const plan = movementPlanForToken(context.token);
    const gridSize = plan.snapshot.gridSize;
    const cell = { x: Math.floor(Number(point.x) / gridSize), y: Math.floor(Number(point.y) / gridSize) };
    const resolution = resolveMovementPreviewFrom(plan.graph, dragLegOrigin(plan, context, gridSize), cell);
    if (!resolution) {
      const stranded = movementStranded(plan.snapshot);
      if (stranded) context.emblemStrandedShown = true;
      notifications.show(stranded ? NOTIFICATION_IDS.MOVEMENT_STRANDED : NOTIFICATION_IDS.MOVEMENT_OUT_OF_AREA);
      continue;
    }
    context.waypoints = [
      ...context.waypoints,
      ...routeWaypoints(context.token, context, resolution.path.slice(1), gridSize, options)
    ];
    updateFoundryDragPreview(context.token, context, context.destination);
  }
  if (pathed.length !== contexts.length) return wrapped.call(this, point, options);
  return undefined;
}

/** Draw the dragged path in the movement ruler's own style. */
export function stylePathedDragPath(wrapped, ...args) {
  return applyMovementRulerPathStyle(this, wrapped.call(this, ...args));
}

/** Draw the dragged grid highlight in the movement ruler's own style. */
export function stylePathedDragGrid(wrapped, ...args) {
  return applyMovementRulerGridStyle(this, wrapped.call(this, ...args));
}

/* -------------------------------------------- */
/*  Drag bookkeeping                            */
/* -------------------------------------------- */

/** Whether this Token still carries a pathed drag context, which keeps a released plan alive until it settles. */
export function hasPathedDragContext(token) {
  const tokenId = token?.document?.id ?? token?.id;
  const contexts = token?.mouseInteractionManager?.interactionData?.contexts ?? {};
  return Object.values(contexts).some(context => context.emblemMovementPath
    && (context.token?.document?.id ?? context.token?.id) === tokenId);
}

/**
 * Take control back on the next tick after a drag released it, so the plan keeps the unit instead of cancelling.
 *
 * ui/controls/movement.mjs calls this from onControlTokenMovement when Foundry deselects a Token mid-drag, and
 * finishPathedDrag calls it when that drag ends.
 */
export function scheduleDragControlRecovery(plan) {
  if (!plan || activeMovementPlan() !== plan || plan.controlRecoveryTimer !== null) return;
  plan.controlRecoveryTimer = setTimeout(() => {
    plan.controlRecoveryTimer = null;
    if (activeMovementPlan() !== plan) return;
    plan.restoreControlAfterDrag = false;
    if (!plan.token.controlled) {
      plan.token.control({ releaseOthers: true, bypassBlock: true });
    }
  }, 0);
}

function movementPlanFromContexts(event) {
  const contexts = event?.interactionData?.contexts ?? {};
  for (const context of Object.values(contexts)) {
    const plan = movementPlanForToken(context.token);
    if (plan && context.emblemMovementPath) return plan;
  }
  return null;
}

function movementTokensFromContexts(event) {
  const contexts = event?.interactionData?.contexts ?? {};
  return Object.values(contexts)
    .filter(context => context.emblemMovementPath && movementPlanForToken(context.token))
    .map(context => context.token);
}

function finishPathedDrag(plan) {
  if (!plan || activeMovementPlan() !== plan) return;
  plan.dragging = false;
  if (!plan.restoreControlAfterDrag) return;
  scheduleDragControlRecovery(plan);
}

/* -------------------------------------------- */
/*  Waypoints                                   */
/* -------------------------------------------- */

function updatePathedContext(context, point, options) {
  const plan = movementPlanForToken(context.token);
  if (!plan) return;
  const gridSize = plan.snapshot.gridSize;
  const destinationCell = {
    x: Math.floor(Number(point.x) / gridSize),
    y: Math.floor(Number(point.y) / gridSize)
  };
  const origin = context.origin ?? plan.token?.document ?? {};
  const originCell = { x: Math.floor(Number(origin.x) / gridSize), y: Math.floor(Number(origin.y) / gridSize) };
  const token = context.token;
  const inputs = previewInputs(plan, token, originCell, destinationCell, options);
  if (previewUnchanged(context, inputs)) {
    context.emblemStranded = false;
    return;
  }
  const resolution = dragRouteResolution(context, plan.graph, originCell, destinationCell);
  context.emblemStranded = !resolution && movementStranded(plan.snapshot);
  if (!resolution) return;

  context.waypoints = routeWaypoints(token, context, resolution.path.slice(1), gridSize, options);

  const finalWorldPoint = {
    x: resolution.destination.x * gridSize,
    y: resolution.destination.y * gridSize
  };
  const destination = token._getDragWaypointPosition(context.destination, finalWorldPoint, options);
  if (!destination) return;
  destination.action = undefined;
  Object.assign(context.destination, destination);
  updateFoundryDragPreview(token, context, destination);
  context.emblemPreview = {
    inputs,
    waypointList: context.waypoints,
    waypoints: context.waypoints.map(waypoint => ({ ...waypoint })),
    destination: { ...context.destination }
  };
}

/**
 * Everything a pathed drag's preview is drawn from. Foundry's own drag skips a pointer move that leaves its
 * destination where it was. These inputs let updatePathedContext do the same, since a move within one square
 * changes none of them.
 */
function previewInputs(plan, token, originCell, destinationCell, options) {
  const document = token?.document ?? {};
  return [
    plan.graph, plan.snapshot.gridSize, originCell.x, originCell.y, destinationCell.x, destinationCell.y,
    options?.snap === true, document.width, document.height, document.shape, document.elevation,
    token?._getDragMovementAction?.()
  ];
}

/**
 * Whether the preview this context shows was drawn from these same inputs and nothing has touched it since. Waypoints
 * are compared by content as well as by list, because Foundry edits the list in place: a right-click pops the last
 * waypoint, an added one is pushed, and a resize mid-drag moves each one.
 */
function previewUnchanged(context, inputs) {
  const last = context.emblemPreview;
  if (!last || last.waypointList !== context.waypoints) return false;
  if (!inputs.every((value, index) => Object.is(value, last.inputs[index]))) return false;
  if (context.waypoints.length !== last.waypoints.length) return false;
  return context.waypoints.every((waypoint, index) => sameFields(waypoint, last.waypoints[index]))
    && sameFields(context.destination ?? {}, last.destination);
}

function sameFields(current, recorded) {
  const keys = Object.keys(current ?? {});
  return keys.length === Object.keys(recorded).length && keys.every(key => Object.is(current[key], recorded[key]));
}

/** The route for a drag leg, re-queried only when the graph or either cell has changed since the last move. */
function dragRouteResolution(context, graph, originCell, destinationCell) {
  const originKey = `${originCell.x},${originCell.y}`;
  const destinationKey = `${destinationCell.x},${destinationCell.y}`;
  const last = context.emblemRoute;
  if (last && last.graph === graph && last.originKey === originKey && last.destinationKey === destinationKey) {
    return last.resolution;
  }
  const resolution = resolveMovementPreviewFrom(graph, originCell, destinationCell);
  context.emblemRoute = { graph, originKey, destinationKey, resolution };
  return resolution;
}

/** Where the next leg starts: the last waypoint already laid down, else the square the drag began on. */
function dragLegOrigin(plan, context, gridSize) {
  const origin = context.waypoints.at(-1) ?? context.origin ?? plan.token?.document ?? {};
  return { x: Math.floor(Number(origin.x) / gridSize), y: Math.floor(Number(origin.y) / gridSize) };
}

function routeWaypoints(token, context, route, gridSize, options) {
  const waypoints = [];
  for (const [index, cell] of route.entries()) {
    const worldPoint = { x: cell.x * gridSize, y: cell.y * gridSize };
    const waypoint = token._getDragWaypointPosition(context.destination, worldPoint, { snap: !options.snap });
    if (!waypoint) continue;
    waypoint.action = token._getDragMovementAction?.();
    waypoint.explicit = false;
    waypoint.checkpoint = index === route.length - 1;
    waypoint.intermediate = index < route.length - 1;
    waypoint.width ||= token.document.width;
    waypoint.height ||= token.document.height;
    waypoint.shape ||= token.document.shape;
    waypoint.elevation ??= token.document.elevation;
    waypoint.terrain ??= null;
    waypoint.ray = null;
    waypoints.push(waypoint);
  }
  return waypoints;
}

function updateFoundryDragPreview(token, context, destination) {
  const TokenClass = globalThis.foundry?.canvas?.placeables?.Token;
  if (typeof TokenClass?.updateDragPreview === 'function') {
    TokenClass.updateDragPreview(context.clonedToken, destination);
  } else if (context.clonedToken?.document) {
    context.clonedToken.document.x = destination.x;
    context.clonedToken.document.y = destination.y;
    context.clonedToken.renderFlags?.set?.({ refreshPosition: true });
  }
  try {
    if (typeof TokenClass?.recalculatePlannedMovementPath === 'function') {
      TokenClass.recalculatePlannedMovementPath(context);
    } else token.recalculatePlannedMovementPath?.();
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Could not refresh the Token movement route.');
  }
}
