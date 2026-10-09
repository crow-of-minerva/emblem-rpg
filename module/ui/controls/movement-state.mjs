/** @layer ui/controls */

/* -------------------------------------------- */
/*  States and events                           */
/* -------------------------------------------- */

/**
 * The states of this client's movement plan. ui/controls/movement.mjs moves the plan between them through
 * {@link advanceMovement}, and drag-route.mjs, inspect-click.mjs and unit-access.mjs read the plan and its state
 * through the functions below. A suspended plan has its own waiting and released states, because targeting can
 * hand the plan back from any of them.
 */
export const MOVEMENT_STATES = Object.freeze({
  /** No plan on this client, so the map is free for selecting. */
  IDLE: 'idle',
  /** `movement.begin` is in flight and no plan is installed yet. */
  OPENING: 'opening',
  /** A plan is installed and taking pointer and keyboard input. */
  PLANNING: 'planning',
  /** A short local step (reading the plan from the host, or an open prompt) holds input. */
  HOLDING: 'holding',
  /** A crossing offer is open and holds input for its dialog. */
  CROSSING: 'crossing',
  /** The crossing the player confirmed is in flight. */
  CROSSING_SETTLING: 'crossing-settling',
  /** A plan command (commit, cancel, transition, flight) is waiting for the host's answer, called settling here. */
  SETTLING: 'settling',
  /** Targeting or an interaction pick owns the unit and the movement grid is hidden. */
  SUSPENDED: 'suspended',
  /** A plan command is in flight on a plan targeting still holds. */
  SUSPENDED_SETTLING: 'suspended-settling',
  /**
   * The host refused a command on a suspended plan: the plan still stands and takes input, but its grid isn't
   * redrawn yet. After a refused cancel, `cancelSuspendedMovement` calls resumeMovementAfterTargeting, which moves
   * on to PLANNING at once and redraws the grid when getPlan answers.
   */
  SUSPENDED_RELEASED: 'suspended-released'
});

/** Everything that moves a plan between the states above. Any other input in a state is ignored. */
export const MOVEMENT_EVENTS = Object.freeze({
  OPEN: 'open',
  OPEN_FAILED: 'open-failed',
  INSTALL: 'install',
  CLEAR: 'clear',
  HOLD: 'hold',
  RELEASE: 'release',
  SUSPEND: 'suspend',
  SUSPEND_FAILED: 'suspend-failed',
  RESUME: 'resume',
  SETTLE: 'settle',
  SETTLED: 'settled',
  ROLLBACK: 'rollback',
  ROLLED_BACK: 'rolled-back',
  OFFER_CROSSING: 'offer-crossing',
  CROSSING_DONE: 'crossing-done'
});

const S = MOVEMENT_STATES;
const E = MOVEMENT_EVENTS;

/**
 * Every legal transition, state by state. An event a state does not list leaves that state untouched, which is how
 * a press that arrives while a command waits for the host, or while the plan is suspended, is dropped rather than
 * half-applied.
 */
export const MOVEMENT_TRANSITIONS = Object.freeze({
  [S.IDLE]: Object.freeze({ [E.OPEN]: S.OPENING, [E.INSTALL]: S.PLANNING }),
  [S.OPENING]: Object.freeze({ [E.OPEN_FAILED]: S.IDLE, [E.INSTALL]: S.PLANNING }),
  [S.PLANNING]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.HOLD]: S.HOLDING,
    [E.SUSPEND]: S.SUSPENDED,
    [E.SETTLE]: S.SETTLING,
    [E.OFFER_CROSSING]: S.CROSSING
  }),
  [S.HOLDING]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.HOLD]: S.HOLDING,
    [E.RELEASE]: S.PLANNING,
    [E.SETTLE]: S.SETTLING,
    [E.ROLLBACK]: S.SETTLING
  }),
  [S.CROSSING]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.SETTLE]: S.CROSSING_SETTLING,
    [E.CROSSING_DONE]: S.PLANNING
  }),
  [S.CROSSING_SETTLING]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.SETTLED]: S.CROSSING,
    [E.CROSSING_DONE]: S.PLANNING
  }),
  [S.SETTLING]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.SETTLED]: S.PLANNING,
    [E.ROLLED_BACK]: S.HOLDING
  }),
  [S.SUSPENDED]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.SUSPEND_FAILED]: S.PLANNING,
    [E.RESUME]: S.HOLDING,
    [E.SETTLE]: S.SUSPENDED_SETTLING
  }),
  [S.SUSPENDED_SETTLING]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.SETTLED]: S.SUSPENDED_RELEASED
  }),
  [S.SUSPENDED_RELEASED]: Object.freeze({
    [E.INSTALL]: S.PLANNING,
    [E.CLEAR]: S.IDLE,
    [E.HOLD]: S.SUSPENDED,
    [E.RESUME]: S.PLANNING,
    [E.SETTLE]: S.SUSPENDED_SETTLING
  })
});

/** The states that take player input. Every other state holds it. */
const ACCEPTS_INPUT = Object.freeze(new Set([S.PLANNING, S.SUSPENDED_RELEASED]));
/** The states with a plan command in flight. */
const SETTLING_STATES = Object.freeze(new Set([S.SETTLING, S.CROSSING_SETTLING, S.SUSPENDED_SETTLING]));
/** The states in which targeting or a pick holds the plan. */
const SUSPENDED_STATES = Object.freeze(new Set([S.SUSPENDED, S.SUSPENDED_SETTLING, S.SUSPENDED_RELEASED]));
/** The states with a crossing offer open. */
const CROSSING_STATES = Object.freeze(new Set([S.CROSSING, S.CROSSING_SETTLING]));

/** The state an event leads to, or the current one when this state doesn't take it. */
export function nextMovementState(name, event) {
  return MOVEMENT_TRANSITIONS[name]?.[event] ?? name;
}

/* -------------------------------------------- */
/*  Current plan                                */
/* -------------------------------------------- */

const EMPTY = Object.freeze({ name: S.IDLE, plan: null });
let control = EMPTY;

/** The state this client's movement plan is in. */
export function movementStateName() {
  return control.name;
}

/** The plan record this client holds, or null when there is none. */
export function activeMovementPlan() {
  return control.plan;
}

/** Whether this client's plan is dragging its unit right now. False when there is no plan. */
export function movementPlanDragging() {
  return control.plan?.dragging === true;
}

/** The plan record for a placed Token, when that Token is the one being moved here. */
export function movementPlanForToken(token) {
  const tokenId = token?.document?.id ?? token?.id ?? token?._id;
  const plan = control.plan;
  return plan && plan.tokenId === tokenId ? plan : null;
}

/**
 * Apply one event to the movement state and return the result. Every change to the plan's state goes through
 * here, and {@link MOVEMENT_TRANSITIONS} lists what each state accepts. An event the current state doesn't list
 * changes nothing.
 * @param {string} event A value of {@link MOVEMENT_EVENTS}.
 * @param {object} [plan] The plan record `install` adopts. Every other event ignores it.
 * @returns {{name: string, plan: object|null}} The state after the event.
 */
export function advanceMovement(event, plan = null) {
  const next = MOVEMENT_TRANSITIONS[control.name]?.[event];
  if (!next) return control;
  control = Object.freeze({
    name: next,
    plan: event === E.INSTALL ? plan : next === S.IDLE ? null : control.plan
  });
  return control;
}

/**
 * Build the plan record that INSTALL stores: the unit, the host's movement data for it (`snapshot`), its movement
 * graph, and any drag in progress.
 */
export function createMovementPlan({ token, snapshot, graph, kind }) {
  return {
    tokenId: token.id,
    token,
    snapshot,
    graph,
    current: { ...snapshot.current },
    kind: snapshot.canterPathfinding === true ? 'canter' : kind,
    dragging: false,
    dragOrigin: null,
    restoreControlAfterDrag: false,
    controlRecoveryTimer: null
  };
}

/* -------------------------------------------- */
/*  Reading the state                           */
/* -------------------------------------------- */

/** Whether the plan takes pointer and keyboard input right now. */
export function movementAcceptsInput(name = control.name) {
  return ACCEPTS_INPUT.has(name);
}

/** Whether a plan command is in flight. */
export function movementIsSettling(name = control.name) {
  return SETTLING_STATES.has(name);
}

/** Whether targeting or an interaction pick holds the plan. */
export function movementIsSuspended(name = control.name) {
  return SUSPENDED_STATES.has(name);
}

/** Whether a crossing offer is open. */
export function movementIsCrossing(name = control.name) {
  return CROSSING_STATES.has(name);
}

/**
 * A handle for `withPlanInputHeld` (ui/controls/input-hold.mjs) over the current state. Its flags read this
 * state, and setting `inputEnabled` sends HOLD or RELEASE.
 * @param {object} plan The plan record the hold belongs to.
 * @returns {object} The hold handle.
 */
export function movementInputHold(plan) {
  return {
    plan,
    get suspended() { return movementIsSuspended(); },
    get settling() { return movementIsSettling(); },
    get inputEnabled() { return movementAcceptsInput(); },
    set inputEnabled(open) { advanceMovement(open ? E.RELEASE : E.HOLD); }
  };
}

/** Whether the hold still belongs to the plan this client holds. Passed to `withPlanInputHeld` as its check. */
export function movementHoldIsCurrent(held) {
  return control.plan !== null && control.plan === held?.plan;
}
