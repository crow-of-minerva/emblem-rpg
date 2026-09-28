/** @layer ui/controls */
import { resolveUnitCycle } from '../../game/movement/input-policy.mjs';
import { facadeSelectedTokenId } from '../../presentation/token/rendering.mjs';
import { inspectMovementToken } from './movement.mjs';
import { isAttackTargetingActive } from './targeting.mjs';
import { isInteractionPickActive } from './interaction.mjs';

/* -------------------------------------------- */
/*  Cycle state                                 */
/* -------------------------------------------- */
const PAN_MS = 250;
let lap = { tokenId: '', visited: [], rule: null };

/* -------------------------------------------- */
/*  Cycle key                                   */
/* -------------------------------------------- */
/**
 * The Cycle Units key (wired in keybindings.mjs): pan to the next visible unit that resolveUnitCycle picks. A GM
 * takes control of it, and a player opens its read-only inspection instead. An open targeting grid or interaction
 * pick keeps the press, so the cycle never moves away from it. A press while the unit the last press reached is
 * still selected continues that lap: it skips the units already visited and keeps the lap's choice of which
 * units to walk. Anything else starts a new lap.
 * @returns {boolean} Whether the press was consumed, which keeps Foundry's own token cycling from also running.
 */
export function cycleUnitSelection() {
  if (isAttackTargetingActive() || isInteractionPickActive()) return true;
  const currentTokenId = cycleStandsOn();
  const continuing = lap.tokenId !== '' && lap.tokenId === currentTokenId;
  const cycle = resolveUnitCycle({
    units: boardUnits(),
    currentTokenId,
    visitedTokenIds: continuing ? lap.visited : [],
    lapRule: continuing ? lap.rule : null,
    origin: viewCentre(),
    userIsGm: game.user.isGM
  });
  const token = cycle.tokenId ? globalThis.canvas?.tokens?.get?.(cycle.tokenId) ?? null : null;
  if (!token) return true;
  lap = {
    tokenId: cycle.tokenId,
    visited: [...cycle.visited],
    rule: { scope: cycle.scope, family: cycle.family, ready: cycle.ready }
  };
  panToUnit(token);
  if (game.user.isGM) token.control({ releaseOthers: true });
  else inspectMovementToken(token);
  return true;
}

/* -------------------------------------------- */
/*  Board reading                               */
/* -------------------------------------------- */
/**
 * Every Character token on the canvas, as the plain facts resolveUnitCycle reads. `visible` is this client's own
 * view, so the cycle skips units this user can't see, and panning to them can't reveal a hidden unit.
 */
function boardUnits() {
  return (globalThis.canvas?.tokens?.placeables ?? [])
    .filter(token => token.id && token.actor?.type === 'Character')
    .map(token => ({
      tokenId: token.id,
      x: Number(token.center?.x ?? token.x) || 0,
      y: Number(token.center?.y ?? token.y) || 0,
      faction: String(token.actor.system?.faction?.role ?? ''),
      owned: token.actor.isOwner === true,
      ready: unitHasTurnLeft(token.actor.system?.turn),
      visible: token.visible !== false
    }));
}

/** A unit has a turn left until both its action and its movement are spent. */
function unitHasTurnLeft(turn) {
  return turn?.actionAvailable !== false || turn?.movementAvailable !== false;
}

/**
 * The unit the cycle starts from: the one this user is inspecting (the facade selection), or else the token this
 * client controls.
 */
function cycleStandsOn() {
  return String(facadeSelectedTokenId() ?? globalThis.canvas?.tokens?.controlled?.[0]?.id ?? '');
}

/** Where to measure from when no unit is selected: the centre of the current view. */
function viewCentre() {
  const pivot = globalThis.canvas?.stage?.pivot;
  return { x: Number(pivot?.x) || 0, y: Number(pivot?.y) || 0 };
}

function panToUnit(token) {
  const centre = token.center;
  if (!centre || !globalThis.canvas?.animatePan) return;
  void canvas.animatePan({ x: centre.x, y: centre.y, duration: PAN_MS });
}
