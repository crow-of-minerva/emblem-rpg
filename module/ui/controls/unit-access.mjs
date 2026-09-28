/** @layer ui/controls */
import {
  MOVEMENT_INPUT_KINDS,
  resolveMovementInputPermission
} from '../../game/movement/input-policy.mjs';
import {
  activeMovementPlan,
  movementAcceptsInput,
  movementPlanForToken
} from './movement-state.mjs';
import { hasPathedDragContext } from './drag-route.mjs';
import { isActivationTargetingActive, isAttackTargetingActive } from './targeting.mjs';
import { isInteractionPickActive, isTradeInteractionActive } from './interaction.mjs';
import { localUserFrozenByPause, worldPaused } from '../../foundry/adapters/services/host.mjs';

/* -------------------------------------------- */
/*  Who may command a unit                      */
/* -------------------------------------------- */

/*
 * Whether this client may select a unit or move the one it holds, answered from live table state. movement.mjs
 * hands these checks to foundry/patches/token-drag.mjs for its Token wrappers, and inspect-click.mjs uses them to
 * decide whether a click inspects or selects. The movement gesture rules live in game/movement/input-policy.mjs,
 * and this file gathers the facts they judge.
 */

/** The table-wide control lock, or null when nobody holds one. */
export function currentLock() {
  const lock = game.emblemRpg.api.movement.getLock();
  return lock?.holderId && lock.tokenUuid ? lock : null;
}

/** Whether a command holds world execution, which freezes gameplay input on every client. */
export function processingActive() {
  return game.emblemRpg.api.protocol.execution()?.owner != null;
}

/** The driven hold an encounter is running, or null. */
export function currentDrivenHold() {
  return game.emblemRpg.api.encounters.driven.current() ?? null;
}

/** Whether an encounter currently drives the board itself. */
export function drivenHoldActive() {
  return Boolean(currentDrivenHold());
}

/** Whether a targeting grid or an interaction pick is waiting for the player to click a unit. */
export function tokenPickAwaitingClick() {
  return isAttackTargetingActive() || isInteractionPickActive();
}

/**
 * Whether this client may control the token now. The Token wrappers in foundry/patches/token-drag.mjs ask this
 * before control, clicks and HUD binds. While the control lock is held, only its holder may control, and only the
 * locked token. `restore` asks whether that holder may take back the unit it is moving. Otherwise processing, a
 * driven hold or a pause refuses everyone. Then `acquire` (a plan about to start), the unit already being moved,
 * or a GM while no lock is held may control.
 */
export function tokenControlAllowed(token, { restore = false, acquire = false } = {}) {
  const lock = currentLock();
  const tokenUuid = token?.document?.uuid ?? token?.uuid;
  if (lock && (lock.holderId !== game.user.id || lock.tokenUuid !== tokenUuid)) return false;
  if (restore) return Boolean(lock && movementPlanForToken(token));
  if (processingActive() || currentDrivenHold() || localUserFrozenByPause()) return false;
  return acquire || Boolean(movementPlanForToken(token)) || (!lock && game.user.isGM);
}

/** Whether this client could open a plan on this unit at all. */
export function canPlanFor(token) {
  return tokenControlAllowed(token, { acquire: true }) && ownsUnit(token);
}

/** Whether this unit is the user's to command, before the control lock, processing or a pause is weighed. */
export function ownsUnit(token) {
  const actor = token?.actor;
  if (!actor || actor.type !== 'Character') return false;
  if (game.user.isGM) return true;
  return actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) === true;
}

/* -------------------------------------------- */
/*  Movement input permission                   */
/* -------------------------------------------- */

/**
 * Gather the facts resolveMovementInputPermission judges one movement gesture on.
 * @param {object} token The placed Token the gesture names.
 * @param {string} kind A value of MOVEMENT_INPUT_KINDS.
 * @param {object} [plan] The active plan for that Token, looked up when the caller has not already.
 * @returns {{allowed: boolean, reason: string}} The policy's verdict.
 */
export function movementInputPermission(token, kind, plan = movementPlanForToken(token)) {
  const userId = String(game.user.id ?? '');
  const turn = token?.actor?.system?.turn ?? plan?.token?.actor?.system?.turn ?? {};
  const lock = currentLock();
  return resolveMovementInputPermission({
    kind,
    userIsGm: game.user.isGM,
    paused: worldPaused(),
    processing: processingActive(),
    lockHeld: Boolean(lock),
    drivenHold: Boolean(currentDrivenHold()),
    trading: isTradeInteractionActive(),
    targeting: isAttackTargetingActive() || isActivationTargetingActive(),
    planMatches: Boolean(plan),
    planAcceptsInput: Boolean(plan) && movementAcceptsInput(),
    graphReady: Boolean(plan?.graph),
    actorPlanning: turn.movementPlanning === true,
    controllerMatches: String(turn.movementControllerId ?? '') === userId,
    lockMatches: lock?.holderId === userId
      && lock?.tokenUuid === (token?.uuid ?? token?.document?.uuid ?? plan?.snapshot?.tokenUuid),
    tokenEngaged: Boolean(plan && (
      plan.token?.controlled || plan.dragging || hasPathedDragContext(plan.token)
    ))
  });
}

/** Whether a marquee drag may select on the canvas while a plan or a command holds the board. */
export function canvasMarqueePermission() {
  return resolveMovementInputPermission({
    kind: MOVEMENT_INPUT_KINDS.MARQUEE_SELECT,
    userIsGm: game.user.isGM,
    planActive: Boolean(activeMovementPlan()),
    processing: processingActive(),
    lockHeld: Boolean(currentLock()),
    lockMatches: false
  });
}
