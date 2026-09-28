/** @layer game/movement */
import { pauseFreezesUser } from '../../contracts/protocol.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { factionGroup } from '../character/rules.mjs';
import { resolveStandingDestination } from './pathfinding.mjs';

/* -------------------------------------------- */
/*  Input vocabulary                            */
/* -------------------------------------------- */
export const MOVEMENT_INPUT_KINDS = Object.freeze({
  KEYBOARD: 'keyboard',
  MARQUEE_SELECT: 'marquee-select',
  MOUSE_DRAG: 'mouse-drag',
  RESTORE: 'restore',
  SYSTEM: 'system',
  UNKNOWN: 'unknown'
});

export const UNIT_SELECTION_OUTCOMES = Object.freeze({
  PLAN: 'plan',
  INSPECT_REACH: 'inspect-reach',
  NONE: 'none'
});

/** Let ui/controls/movement.mjs adopt an unknown begin outcome only when the persisted lock and plan match. */
export function canAdoptMovementPlan({ lock, snapshot, userId, tokenUuid }) {
  return Boolean(lock && snapshot && userId && tokenUuid)
    && lock.holderId === userId && lock.tokenUuid === tokenUuid
    && snapshot.movementPlanning === true && snapshot.movementControllerId === userId;
}

export const UNIT_SELECTION_REASONS = Object.freeze({
  BOARD_ENGAGED: 'unit-selection.board-engaged',
  NOT_A_UNIT: 'unit-selection.not-a-unit',
  NOT_PLAYING: 'unit-selection.not-playing',
  NOT_OWNED: 'unit-selection.not-owned',
  OWNED_AND_ACTIVE: 'unit-selection.owned-and-active',
  TABLE_PAUSED: 'unit-selection.table-paused',
  TURN_OVER: 'unit-selection.turn-over'
});

export const MOVEMENT_INPUT_REASONS = Object.freeze({
  ACTIVE_CONTROL: 'movement-input.active-control',
  ACTOR_NOT_PLANNING: 'movement-input.actor-not-planning',
  BOARD_DRIVEN: 'movement-input.board-driven',
  PROCESSING: 'movement-input.processing',
  CONTROLLER_MISMATCH: 'movement-input.controller-mismatch',
  GM_DRAG: 'movement-input.gm-drag',
  GM_MARQUEE: 'movement-input.gm-marquee',
  GRAPH_MISSING: 'movement-input.graph-missing',
  LOCK_MISMATCH: 'movement-input.lock-mismatch',
  MOVEMENT_PLAN_MARQUEE_BLOCKED: 'movement-input.movement-plan-marquee-blocked',
  PLAN_INACTIVE: 'movement-input.plan-inactive',
  PLAN_MISMATCH: 'movement-input.plan-mismatch',
  PLAYER_MARQUEE_BLOCKED: 'movement-input.player-marquee-blocked',
  SYSTEM_WRITE: 'movement-input.system-write',
  TABLE_PAUSED: 'movement-input.table-paused',
  TARGETING_ACTIVE: 'movement-input.targeting-active',
  TOKEN_NOT_ENGAGED: 'movement-input.token-not-engaged',
  TRADE_ACTIVE: 'movement-input.trade-active',
  UNKNOWN_INPUT: 'movement-input.unknown'
});

/* -------------------------------------------- */
/*  Input policy                                */
/* -------------------------------------------- */
/**
 * Whether a movement input may go ahead, for movementInputPermission and canvasMarqueePermission in
 * ui/controls/unit-access.mjs. It gates each Token position update before ui/controls/movement.mjs resolves the
 * step, and every marquee selection.
 * @param {object} facts Plain movement-control facts.
 * @param {string} [facts.kind] Semantic input kind.
 * @param {boolean} [facts.userIsGm] Whether the authenticated user is a GM.
 * @param {boolean} [facts.planActive] Whether this client is controlling an active movement plan.
 * @param {boolean} [facts.planMatches] Whether the local plan belongs to this Token.
 * @param {boolean} [facts.planAcceptsInput] Whether the plan is outside prompts and settlement.
 * @param {boolean} [facts.graphReady] Whether the local movement graph exists.
 * @param {boolean} [facts.actorPlanning] Whether persisted Actor planning is active.
 * @param {boolean} [facts.controllerMatches] Whether the Actor controller matches the user.
 * @param {boolean} [facts.lockMatches] Whether the world lock matches the user and Token.
 * @param {boolean} [facts.tokenEngaged] Whether the Token is controlled or in a verified drag handoff.
 * @param {boolean} [facts.trading] Whether this unit is in a trade. No user input may move it then.
 * @param {boolean} [facts.targeting] Whether this unit is aiming. Keyboard and drag input may not move it then,
 *   except a GM's drag while no movement lock is held.
 * @param {boolean} [facts.drivenHold] Whether a module holds the board. Keyboard and drag input are refused then.
 * @param {boolean} [facts.paused] Whether Foundry's world pause is on, which freezes everyone but staff.
 * @returns {{allowed: boolean, reason: string}} Immutable policy result.
 */
export function resolveMovementInputPermission(facts = {}) {
  const kind = Object.values(MOVEMENT_INPUT_KINDS).includes(facts.kind)
    ? facts.kind
    : MOVEMENT_INPUT_KINDS.UNKNOWN;

  if (kind === MOVEMENT_INPUT_KINDS.RESTORE || kind === MOVEMENT_INPUT_KINDS.SYSTEM) {
    return result(true, MOVEMENT_INPUT_REASONS.SYSTEM_WRITE);
  }
  if (pauseFreezesUser({ paused: facts.paused, isGm: facts.userIsGm })) {
    return result(false, MOVEMENT_INPUT_REASONS.TABLE_PAUSED);
  }
  if (facts.processing === true) return result(false, MOVEMENT_INPUT_REASONS.PROCESSING);
  if (facts.lockHeld === true && facts.lockMatches !== true) {
    return result(false, MOVEMENT_INPUT_REASONS.LOCK_MISMATCH);
  }
  if (facts.drivenHold === true
    && (kind === MOVEMENT_INPUT_KINDS.KEYBOARD || kind === MOVEMENT_INPUT_KINDS.MOUSE_DRAG)) {
    return result(false, MOVEMENT_INPUT_REASONS.BOARD_DRIVEN);
  }
  if (kind === MOVEMENT_INPUT_KINDS.MARQUEE_SELECT) {
    if (facts.planActive === true) {
      return result(false, MOVEMENT_INPUT_REASONS.MOVEMENT_PLAN_MARQUEE_BLOCKED);
    }
    return facts.userIsGm === true
      ? result(true, MOVEMENT_INPUT_REASONS.GM_MARQUEE)
      : result(false, MOVEMENT_INPUT_REASONS.PLAYER_MARQUEE_BLOCKED);
  }
  if (facts.trading === true) return result(false, MOVEMENT_INPUT_REASONS.TRADE_ACTIVE);
  if (kind === MOVEMENT_INPUT_KINDS.MOUSE_DRAG && facts.userIsGm === true && facts.lockHeld !== true) {
    return result(true, MOVEMENT_INPUT_REASONS.GM_DRAG);
  }
  if (kind !== MOVEMENT_INPUT_KINDS.KEYBOARD && kind !== MOVEMENT_INPUT_KINDS.MOUSE_DRAG) {
    return result(false, MOVEMENT_INPUT_REASONS.UNKNOWN_INPUT);
  }
  if (facts.targeting === true) return result(false, MOVEMENT_INPUT_REASONS.TARGETING_ACTIVE);
  if (facts.planMatches !== true) return result(false, MOVEMENT_INPUT_REASONS.PLAN_MISMATCH);
  if (facts.planAcceptsInput !== true) return result(false, MOVEMENT_INPUT_REASONS.PLAN_INACTIVE);
  if (facts.graphReady !== true) return result(false, MOVEMENT_INPUT_REASONS.GRAPH_MISSING);
  if (facts.actorPlanning !== true) return result(false, MOVEMENT_INPUT_REASONS.ACTOR_NOT_PLANNING);
  if (facts.controllerMatches !== true) return result(false, MOVEMENT_INPUT_REASONS.CONTROLLER_MISMATCH);
  if (facts.lockMatches !== true) return result(false, MOVEMENT_INPUT_REASONS.LOCK_MISMATCH);
  if (facts.tokenEngaged !== true) return result(false, MOVEMENT_INPUT_REASONS.TOKEN_NOT_ENGAGED);
  return result(true, MOVEMENT_INPUT_REASONS.ACTIVE_CONTROL);
}

/* -------------------------------------------- */
/*  Core keybinding policy                      */
/* -------------------------------------------- */
const VERTICAL_MOVEMENT_ACTIONS = Object.freeze(['core.ascend', 'core.descend']);
const DUAL_PURPOSE_ZOOM_ACTIONS = Object.freeze(['core.zoomIn', 'core.zoomOut']);

/**
 * The ids of Foundry's elevation keybindings, which the KeyboardManager patch in foundry/patches/token-drag.mjs
 * drops because this system has no manual vertical movement. Known ids and any id or name mentioning elevation
 * both match, to cover different core versions.
 * @param {ReadonlyArray<{id: string, name?: string}>} actions Every registered action.
 * @returns {readonly string[]} The ids to neutralize.
 */
export function verticalMovementActionIds(actions = []) {
  return Object.freeze(actions
    .filter(action => VERTICAL_MOVEMENT_ACTIONS.includes(String(action?.id ?? ''))
      || /elevat/i.test(String(action?.id ?? '')) || /elevat/i.test(String(action?.name ?? '')))
    .map(action => String(action.id)));
}

/**
 * Whether a core key action may run, for the KeyboardManager patch in foundry/patches/token-drag.mjs. Elevation
 * actions never run. When core has no separate elevation binding, the zoom keys are blocked while a Token is
 * controlled, because they would change its elevation.
 * @param {object} facts Plain facts: the action `id`, the `verticalIds` the registry carries, `tokenControlled`.
 * @returns {boolean}
 */
export function coreKeybindingAllowed(facts = {}) {
  const id = String(facts.id ?? '');
  const verticalIds = Array.isArray(facts.verticalIds) ? facts.verticalIds : [];
  if (verticalIds.includes(id)) return false;
  if (verticalIds.length === 0 && DUAL_PURPOSE_ZOOM_ACTIONS.includes(id)) return facts.tokenControlled !== true;
  return true;
}

/* -------------------------------------------- */
/*  Unit selection policy                       */
/* -------------------------------------------- */
/**
 * Choose movement planning or read-only inspection for ui/controls/movement.mjs.
 * With neither an encounter nor Free Exploration, selection does nothing.
 * @param {object} facts Plain selection facts.
 * @param {boolean} [facts.playing] Whether an encounter is running or Free Exploration is on.
 * @param {boolean} [facts.isUnit] Whether the Token carries a turn-taking unit.
 * @param {boolean} [facts.controllable] Whether the authenticated user may command it.
 * @param {boolean} [facts.owned] Whether the unit is the user's to command when nothing is holding them back.
 * @param {boolean} [facts.standardAvailable] Whether its standard action is unspent.
 * @param {boolean} [facts.movementAvailable] Whether its movement action is unspent.
 * @param {boolean} [facts.otherUnitControlled] Whether the board already holds a controlled Token.
 * @param {boolean} [facts.paused] Whether Foundry's world pause is on, which freezes everyone but staff.
 * @param {boolean} [facts.userIsGm] Whether the authenticated user is staff, whom a pause leaves free to act.
 * @returns {{outcome: string, reason: string}} Policy result.
 */
export function resolveUnitSelection(facts = {}) {
  if (facts.isUnit !== true) {
    return selection(UNIT_SELECTION_OUTCOMES.NONE, UNIT_SELECTION_REASONS.NOT_A_UNIT);
  }
  if (facts.playing !== true) {
    return selection(UNIT_SELECTION_OUTCOMES.NONE, UNIT_SELECTION_REASONS.NOT_PLAYING);
  }
  if (pauseFreezesUser({ paused: facts.paused, isGm: facts.userIsGm })) {
    return selection(UNIT_SELECTION_OUTCOMES.INSPECT_REACH, facts.owned === true
      ? UNIT_SELECTION_REASONS.TABLE_PAUSED
      : UNIT_SELECTION_REASONS.NOT_OWNED);
  }
  const turnOver = facts.standardAvailable === false && facts.movementAvailable === false;
  if (facts.controllable === true && !turnOver) {
    return selection(UNIT_SELECTION_OUTCOMES.PLAN, UNIT_SELECTION_REASONS.OWNED_AND_ACTIVE);
  }
  if (facts.otherUnitControlled === true) {
    return selection(UNIT_SELECTION_OUTCOMES.NONE, UNIT_SELECTION_REASONS.BOARD_ENGAGED);
  }
  return selection(
    UNIT_SELECTION_OUTCOMES.INSPECT_REACH,
    facts.controllable === true ? UNIT_SELECTION_REASONS.TURN_OVER : UNIT_SELECTION_REASONS.NOT_OWNED
  );
}

/* -------------------------------------------- */
/*  Unit cycle policy                           */
/* -------------------------------------------- */
/** Which units the cycle key walks: the presser's own, one faction family, or every unit on the board. */
const UNIT_CYCLE_SCOPES = Object.freeze({ OWNED: 'owned', FAMILY: 'family', ANY: 'any' });

const CYCLE_ORIGIN = Object.freeze({ x: 0, y: 0 });

/**
 * Choose the next visible unit for ui/controls/unit-cycle.mjs. Visit each eligible unit once, nearest-first.
 * With nobody named, players walk their own units and GMs every unit, preferring units with a turn left.
 * Standing on a unit walks that unit's faction family: only units with a turn left if it has one, otherwise all.
 * A continuing lap keeps the rule it started with, so a walk from nothing is not narrowed by the unit it lands on.
 * Return updated lap state so the next press skips visited units.
 * @param {object} facts Plain cycle facts.
 * @param {Array<object>} [facts.units] `{tokenId, x, y, faction, owned, ready, visible}` for every unit on the board.
 * @param {string} [facts.currentTokenId] The unit the cycle stands on, selected or pretend-selected.
 * @param {Array<string>} [facts.visitedTokenIds] Units this lap has already reached.
 * @param {{scope: string, family: ?string, ready: boolean}} [facts.lapRule] The rule of the lap being continued.
 * @param {{x: number, y: number}} [facts.origin] Where to measure from when no unit is named: the view centre.
 * @param {boolean} [facts.userIsGm] Whether the presser is staff, who walk every unit from nothing.
 * @returns {{tokenId: ?string, scope: string, family: ?string, ready: boolean, visited: ReadonlyArray<string>}}
 */
export function resolveUnitCycle(facts = {}) {
  const units = (facts.units ?? []).filter(unit => unit?.tokenId && unit.visible !== false);
  const currentId = String(facts.currentTokenId ?? '');
  const current = units.find(unit => unit.tokenId === currentId) ?? null;
  const rule = cycleRule(facts.lapRule, current, facts.userIsGm === true);
  const inScope = units.filter(unit => cycleAdmits(rule, unit));
  const readyScope = inScope.filter(unit => unit.ready !== false);
  const ready = rule.ready && readyScope.some(unit => unit.tokenId !== currentId);
  const walkable = ready ? readyScope : inScope;
  const candidates = walkable.filter(unit => unit.tokenId !== currentId);
  if (!candidates.length) return cycleResult(null, rule, false, []);
  const lap = (facts.visitedTokenIds ?? []).map(String)
    .filter(tokenId => walkable.some(unit => unit.tokenId === tokenId));
  const walked = candidates.every(unit => lap.includes(unit.tokenId)) ? [] : lap;
  const next = nearestUnit(candidates.filter(unit => !walked.includes(unit.tokenId)), current ?? facts.origin);
  return cycleResult(next.tokenId, rule, ready, [...walked, next.tokenId]);
}

/** Keep a continuing lap's rule. Otherwise walk from nothing, or from the named unit's family and turn state. */
function cycleRule(lapRule, current, userIsGm) {
  if (Object.values(UNIT_CYCLE_SCOPES).includes(lapRule?.scope)) {
    return { scope: lapRule.scope, family: lapRule.family ?? null, ready: lapRule.ready === true };
  }
  if (!current) return { scope: userIsGm ? UNIT_CYCLE_SCOPES.ANY : UNIT_CYCLE_SCOPES.OWNED, family: null, ready: true };
  return { scope: UNIT_CYCLE_SCOPES.FAMILY, family: factionGroup(current.faction), ready: current.ready !== false };
}

function cycleAdmits(rule, unit) {
  if (rule.scope === UNIT_CYCLE_SCOPES.OWNED) return unit.owned === true;
  if (rule.scope === UNIT_CYCLE_SCOPES.FAMILY) return factionGroup(unit.faction) === rule.family;
  return true;
}

/** Closest by straight line, and by token id where two units are equally close, so the walk never wavers. */
function nearestUnit(units, anchor) {
  const from = anchor ?? CYCLE_ORIGIN;
  return units.reduce((nearest, unit) => {
    const gap = cycleDistance(unit, from);
    const best = cycleDistance(nearest, from);
    if (gap < best) return unit;
    return gap === best && unit.tokenId < nearest.tokenId ? unit : nearest;
  });
}

function cycleDistance(unit, from) {
  return ((Number(unit.x) || 0) - (Number(from.x) || 0)) ** 2 + ((Number(unit.y) || 0) - (Number(from.y) || 0)) ** 2;
}

/** `ready` records whether this press walked only units with a turn left, which a continuing lap then keeps. */
function cycleResult(tokenId, rule, ready, visited) {
  return Object.freeze({ tokenId, scope: rule.scope, family: rule.family, ready, visited: Object.freeze(visited) });
}

/* -------------------------------------------- */
/*  Plan settlement                             */
/* -------------------------------------------- */
/** How Space closes a plan: the options prompt, the one-button end-turn confirmation, or nothing at all. */
export const MOVEMENT_PROMPTS = Object.freeze({ OPTIONS: 'options', END_TURN: 'end-turn', NONE: 'none' });

/**
 * Choose how closing a plan confirms, rolls back and ends the turn, for ui/controls/movement.mjs and
 * engine/movement/commands.mjs. Exploration closes without costs or prompts. A Canter can only end the turn already
 * spent, and cancelling it forfeits its remaining movement. An ordinary plan that ends the turn rests the unit,
 * which restores stance, but a Canter never does.
 * @param {object} facts Plain plan facts.
 * @param {boolean} [facts.canter] Whether the plan is the post-exchange canter.
 * @param {boolean} [facts.exploring] Whether the map is in free exploration.
 * @param {boolean} [facts.resume] Whether the caller asked to keep planning after the commit.
 * @returns {{prompt: string, resume: boolean, endTurn: boolean, rollback: boolean, forfeits: boolean,
 *   charges: boolean, restoresAnchor: boolean, rests: boolean}}
 */
export function planMovementSettlement(facts = {}) {
  if (facts.exploring === true) {
    return settlement({
      prompt: MOVEMENT_PROMPTS.NONE, resume: false, endTurn: false, charges: false, restoresAnchor: false
    });
  }
  if (facts.canter === true) {
    return settlement({ prompt: MOVEMENT_PROMPTS.END_TURN, resume: false, endTurn: true, forfeits: true });
  }
  const resume = facts.resume !== false;
  return settlement({ prompt: MOVEMENT_PROMPTS.OPTIONS, resume, endTurn: !resume, rollback: true, rests: !resume });
}

function settlement({
  prompt, resume, endTurn, rollback = false, forfeits = false, charges = true, restoresAnchor = true, rests = false
}) {
  return { prompt, resume, endTurn, rollback, forfeits, charges, restoresAnchor, rests };
}

/**
 * The movement spent after a commit, for the movement writers in foundry/adapters/document-writes/movement.mjs and
 * movement-settlements.mjs, and for resolveStandingMovementSpent. Every commit adds its leg to the legs before it,
 * a post-action remainder plan included, so the remainder is what the turn has left. Exploration adds nothing.
 * @param {object} facts Plain commit facts.
 * @param {number} [facts.priorSpent] Movement spent before this commit.
 * @param {number} [facts.legCost] The cost of the leg being committed.
 * @param {boolean} [facts.charges] Whether movement is charged at all.
 * @returns {number}
 */
export function planMovementSpend(facts = {}) {
  const prior = Math.max(0, Number(facts.priorSpent) || 0);
  const leg = Math.max(0, Number(facts.legCost) || 0);
  if (facts.charges === false) return prior;
  return prior + leg;
}

/** The squares a unit has moved this turn, counting the leg its open plan currently ends on. */
export function resolveStandingMovementSpent(movement) {
  const priorSpent = Math.max(0, Number(movement?.movementSpent) || 0);
  if (movement?.movementPlanning !== true) return priorSpent;
  return planMovementSpend({ priorSpent, legCost: resolveStandingDestination(movement)?.cost });
}

/**
 * The effects to delete when a movement plan is cancelled, picked by their `removeWhenPathfindingEnds` flag, for
 * foundry/adapters/document-writes/movement-settlements.mjs. A confirmed plan keeps them.
 * @param {ReadonlyArray<{id: string, removeWhenPathfindingEnds?: boolean}>} effects Detached effect facts.
 * @returns {string[]} The ids to delete.
 */
export function planMovementCancelEffects(effects = []) {
  return effects
    .filter(effect => effect?.removeWhenPathfindingEnds === true && effect.id)
    .map(effect => String(effect.id));
}

/* -------------------------------------------- */
/*  Movement permissions                        */
/* -------------------------------------------- */
export const MOVEMENT_PERMISSIONS = Object.freeze({
  ALLOWED: 'allowed',
  NO_FLYING: 'noFlying',
  NO_MOUNTS: 'noMounts'
});

/** The Scene flag a map's movement permission is stored under. An absent flag reads as Allowed. */
export const MOVEMENT_PERMISSION_FLAG = 'movementPermission';

export const MOVEMENT_PERMISSION_LABELS = Object.freeze({
  [MOVEMENT_PERMISSIONS.ALLOWED]: 'Allowed',
  [MOVEMENT_PERMISSIONS.NO_FLYING]: 'No Flying',
  [MOVEMENT_PERMISSIONS.NO_MOUNTS]: 'No Mounts'
});

/** Read any stored value as one permission, Allowed when it names none. */
export function normalizeMovementPermission(value) {
  const permission = String(value ?? '');
  return Object.values(MOVEMENT_PERMISSIONS).includes(permission) ? permission : MOVEMENT_PERMISSIONS.ALLOWED;
}

/** Whether a map's permission forbids flight, which grounds every flier on it that does not levitate. */
export function flyingForbidden(permission) {
  return normalizeMovementPermission(permission) === MOVEMENT_PERMISSIONS.NO_FLYING;
}

/** Whether a map's permission bars riding, which refuses a mount at its confirmation and dismounts arrivals. */
export function mountsForbidden(permission) {
  return normalizeMovementPermission(permission) === MOVEMENT_PERMISSIONS.NO_MOUNTS;
}

/**
 * Plan the grounding and dismounting a map's movement permission forces, for engine/movement/commands.mjs. A map
 * without flight grounds every flier on it that does not levitate, wherever it stands. That landing is not a stance
 * break, so it strands nobody.
 * @param {object[]} units Detached facts: `actorUuid`, `flying`, `grounded`, `levitating`, `mountItemId`.
 * @param {string} permission The Scene's permission.
 * @returns {object[]} One `{actorUuid, ground}` or `{actorUuid, dismountItemId}` per unit to settle.
 */
export function planPermissionEnforcement(units = [], permission) {
  const plan = [];
  const seen = new Set();
  for (const unit of units) {
    const actorUuid = String(unit?.actorUuid ?? '');
    if (!actorUuid || seen.has(actorUuid)) continue;
    seen.add(actorUuid);
    if (flyingForbidden(permission) && unit.flying === true && unit.grounded !== true && unit.levitating !== true) {
      plan.push({ actorUuid, ground: true });
    }
    if (mountsForbidden(permission) && unit.mountItemId) {
      plan.push({ actorUuid, dismountItemId: String(unit.mountItemId) });
    }
  }
  return plan;
}

/* -------------------------------------------- */
/*  Move scaling                                */
/* -------------------------------------------- */
export const MOVE_SCALINGS = Object.freeze({
  SLOWED: 'slowed',
  NONE: 'none',
  BOOSTED: 'boosted',
  ACCELERATED: 'accelerated'
});

/** The Scene flag a map's move scaling is stored under. An absent flag reads as None. */
export const MOVE_SCALING_FLAG = 'moveScaling';

/** The Actor flag the board settles a placed unit's map scaling onto, cleared once the unit leaves the map. */
export const UNIT_MOVE_SCALING_FLAG = 'sceneMoveScaling';

export const MOVE_SCALING_LABELS = Object.freeze({
  [MOVE_SCALINGS.SLOWED]: 'Slowed',
  [MOVE_SCALINGS.NONE]: 'None',
  [MOVE_SCALINGS.BOOSTED]: 'Boosted',
  [MOVE_SCALINGS.ACCELERATED]: 'Accelerated'
});

/** Read any stored value as one move scaling, None when it names none. */
export function normalizeMoveScaling(value) {
  const scaling = String(value ?? '');
  return Object.values(MOVE_SCALINGS).includes(scaling) ? scaling : MOVE_SCALINGS.NONE;
}

/** How far a map's scaling moves one unit's total: Slowed never takes a unit below 1, and a rider accelerates by 3. */
export function resolveMoveScalingDelta(scaling, { total = 0, mounted = false } = {}) {
  switch (normalizeMoveScaling(scaling)) {
    case MOVE_SCALINGS.SLOWED: return Number(total) > 1 ? -1 : 0;
    case MOVE_SCALINGS.BOOSTED: return 1;
    case MOVE_SCALINGS.ACCELERATED: return mounted === true ? 3 : 2;
    default: return 0;
  }
}

/**
 * Plan the move-scaling flag each unit on the board should carry, for engine/board.mjs. A unit that has left the
 * map goes back to None.
 */
export function planMoveScalingFields(board) {
  const owed = normalizeMoveScaling(board.moveScaling);
  const plans = [];
  const planned = new Set();
  for (const unit of Array.isArray(board.units) ? board.units : []) {
    const actorUuid = String(unit?.actorUuid ?? '');
    if (!actorUuid || planned.has(actorUuid)) continue;
    planned.add(actorUuid);
    const scaling = unit.placed === true ? owed : MOVE_SCALINGS.NONE;
    if (normalizeMoveScaling(unit.moveScaling) === scaling) continue;
    plans.push({ actorUuid, fields: { [UNIT_MOVE_SCALING_FLAG]: scaling } });
  }
  return plans;
}

/* -------------------------------------------- */
/*  Flight                                      */
/* -------------------------------------------- */
/**
 * The Actor flag a stance break sets when it grounds a flier, and taking off clears. While the unit stands grounded
 * on an obstacle it is stranded (movementStranded in pathfinding.mjs), and the Enemy AI reads it to take the unit
 * back into the air once its stance recovers.
 */
export const GROUNDED_BY_STANCE_BREAK_FLAG = 'groundedByStanceBreak';

/**
 * Validate the staff flight control on the Token HUD, which writes the flight state and nothing else. It spends no
 * action and ends no turn, so it checks only that the unit's flight is its own to change and that the map allows
 * flight. Like the flight action, it never sets a flier down on an obstacle. A request that matches the current
 * state is accepted and writes nothing.
 * @param {object} facts Plain flight facts.
 * @param {boolean} [facts.flying] Whether the unit is a flier at all.
 * @param {boolean} [facts.levitating] Whether an effect holds it aloft regardless.
 * @param {boolean} [facts.grounded] Whether it is currently on the ground.
 * @param {string} [facts.permission] The map's movement permission.
 * @param {boolean} [facts.landingBlocked] Whether an obstacle lies under its footprint.
 * @param {boolean} [facts.requested] The grounded state the control asked for.
 * @returns {{ok: boolean, code?: string, grounded?: boolean}}
 */
export function planFlightAuthoring(facts = {}) {
  if (facts.flying !== true || facts.levitating === true) return refusal(RESULT_CODES.FLIGHT_UNAVAILABLE);
  const grounded = facts.requested === true;
  if (!grounded && flyingForbidden(facts.permission)) return refusal(RESULT_CODES.FLIGHT_FORBIDDEN);
  if (grounded && facts.grounded !== true && facts.landingBlocked === true) {
    return refusal(RESULT_CODES.FLIGHT_LANDING_BLOCKED);
  }
  return { ok: true, grounded };
}

/**
 * Validate the engine's flight action. Landing remains allowed on no-flying maps, but not on obstacle cells, and a
 * unit whose stance is broken cannot take off until it recovers.
 * @param {object} facts Plain flight facts.
 * @param {boolean} [facts.flying] Whether the unit is a flier at all.
 * @param {boolean} [facts.levitating] Whether an effect holds it aloft regardless.
 * @param {boolean} [facts.grounded] Whether it is currently on the ground.
 * @param {string} [facts.permission] The map's movement permission.
 * @param {boolean} [facts.stanceBroken] Whether its stance is broken.
 * @param {boolean} [facts.actionAvailable] Whether its standard action is unspent.
 * @param {boolean} [facts.landingBlocked] Whether an obstacle lies under its footprint.
 * @returns {{ok: boolean, code?: string, landing?: boolean, grounded?: boolean}}
 */
export function planFlightToggle(facts = {}) {
  if (facts.flying !== true || facts.levitating === true) return refusal(RESULT_CODES.FLIGHT_UNAVAILABLE);
  const landing = facts.grounded !== true;
  if (!landing && flyingForbidden(facts.permission)) return refusal(RESULT_CODES.FLIGHT_FORBIDDEN);
  if (!landing && facts.stanceBroken === true) return refusal(RESULT_CODES.FLIGHT_STANCE_BROKEN);
  if (facts.actionAvailable !== true) return refusal(RESULT_CODES.FLIGHT_ACTION_REQUIRED);
  if (landing && facts.landingBlocked === true) return refusal(RESULT_CODES.FLIGHT_LANDING_BLOCKED);
  return { ok: true, landing, grounded: landing };
}

/**
 * Validate free takeoff from the Grounded marker for engine movement commands.
 * It is free outside combat and for GMs, but players in combat must spend the flight action. Nobody lifts a unit
 * whose stance is broken until it recovers.
 * @param {object} facts Plain flight facts.
 * @param {boolean} [facts.flying] Whether the unit is a flier at all.
 * @param {boolean} [facts.levitating] Whether an effect holds it aloft regardless.
 * @param {boolean} [facts.grounded] Whether it is currently on the ground.
 * @param {string} [facts.permission] The map's movement permission.
 * @param {boolean} [facts.stanceBroken] Whether its stance is broken.
 * @param {boolean} [facts.encounterActive] Whether an encounter is running on its Scene.
 * @param {boolean} [facts.userIsGm] Whether the authenticated user is a GM.
 * @returns {{ok: boolean, code?: string, grounded?: boolean}}
 */
export function planFreeTakeOff(facts = {}) {
  if (facts.flying !== true || facts.levitating === true || facts.grounded !== true) {
    return refusal(RESULT_CODES.FLIGHT_UNAVAILABLE);
  }
  if (flyingForbidden(facts.permission)) return refusal(RESULT_CODES.FLIGHT_FORBIDDEN);
  if (facts.stanceBroken === true) return refusal(RESULT_CODES.FLIGHT_STANCE_BROKEN);
  if (facts.encounterActive === true && facts.userIsGm !== true) {
    return refusal(RESULT_CODES.FLIGHT_COMBAT_ACTION_REQUIRED);
  }
  return { ok: true, grounded: false };
}

/**
 * Whether an interaction sets its flier down: trade, theft, touch casting or paid container access. Free container
 * inspection neither commits movement nor lands the unit. The trade, steal, shop and item-activation checks ask it.
 * @param {object} facts Plain interaction facts.
 * @param {boolean} [facts.sourceAirborne] Whether the acting unit is in the air.
 * @param {boolean} [facts.targetAirborne] Whether what it reached for is too.
 * @param {boolean} [facts.committed] Whether the interaction cost the unit its position.
 * @returns {boolean}
 */
export function groundsOnInteraction(facts = {}) {
  return facts.sourceAirborne === true && facts.targetAirborne !== true && facts.committed !== false;
}

/**
 * Whether an action that would set its flier down may go ahead. Only a stance break lands a unit on a square it
 * could not land on (resolveStanceBreak in game/combat/damage.mjs), so trade, theft, touch casting, a lock attempt,
 * a shop visit and Armament use are refused while the flier they would ground is over one.
 * @param {object} facts Plain landing facts.
 * @param {boolean} [facts.grounds] Whether the action sets the unit down.
 * @param {boolean} [facts.landingBlocked] Whether an obstacle lies under its footprint.
 * @returns {{ok: boolean, code?: string}}
 */
export function planForcedLanding(facts = {}) {
  if (facts.grounds === true && facts.landingBlocked === true) return refusal(RESULT_CODES.FORCED_LANDING_BLOCKED);
  return { ok: true };
}

/**
 * Validate a crossing offer for movement UI and engine commands. Require an action, spare movement
 * at the edge and a grounded, unmounted unit with stance. Exploration has no crossing actions, and a stranded unit
 * (movementStranded in pathfinding.mjs) takes no move of its own until it takes off.
 * @param {object} facts Plain turn and unit facts.
 * @returns {{ok: boolean, code?: string}}
 */
export function planCrossingAttempt(facts = {}) {
  if (facts.exploring === true || facts.airborne === true || facts.mounted === true) {
    return refusal(RESULT_CODES.CROSSING_UNAVAILABLE);
  }
  if (facts.stranded === true) return refusal(RESULT_CODES.MOVEMENT_STRANDED);
  if (Math.max(0, Number(facts.stance) || 0) < 1) return refusal(RESULT_CODES.CROSSING_STANCE_REQUIRED);
  if (facts.actionAvailable !== true) return refusal(RESULT_CODES.CROSSING_ACTION_REQUIRED);
  if (Math.max(0, Number(facts.movementRemaining) || 0) < 1) {
    return refusal(RESULT_CODES.CROSSING_MOVEMENT_REQUIRED);
  }
  return { ok: true };
}

/**
 * Gate crossing prompts in ui/controls/movement.mjs. A held key stops at the border, and only a fresh keyboard
 * press may offer the crossing.
 * @param {object} facts Plain input facts.
 * @param {string} [facts.kind] Semantic input kind.
 * @param {boolean} [facts.freshPress] Whether a keyboard step came from a press rather than a hold's repeat.
 * @returns {boolean}
 */
export function crossingOfferAllowed(facts = {}) {
  return facts.kind !== MOVEMENT_INPUT_KINDS.KEYBOARD || facts.freshPress === true;
}

/* -------------------------------------------- */
/*  Results                                     */
/* -------------------------------------------- */
function refusal(code) {
  return { ok: false, code };
}

function result(allowed, reason) {
  return Object.freeze({ allowed, reason });
}

function selection(outcome, reason) {
  return { outcome, reason };
}
