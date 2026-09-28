/** @layer ui/controls */

/* -------------------------------------------- */
/*  States and events                           */
/* -------------------------------------------- */

/**
 * The states of this client's item targeting, which ui/controls/targeting.mjs drives. Aiming an attack, collecting
 * an activation's targets, sending it and waiting for a placement square are each a state, and every change goes
 * through {@link advanceTargeting}.
 */
export const TARGETING_STATES = Object.freeze({
  /** Nothing is aimed, so canvas clicks go to movement. */
  IDLE: 'idle',
  /** An attack Item is staged and its grid waits for a Token click. */
  AIMING: 'aiming',
  /** The combat or Destructible preview for the clicked target is open. */
  PREVIEWING: 'previewing',
  /** An activation is collecting its targets, its aim or its confirmation. */
  SELECTING: 'selecting',
  /** The collected activation is being reprojected, confirmed and sent. */
  RESOLVING: 'resolving',
  /** The activation's geometry step waits for one of its candidate squares. */
  PLACING: 'placing'
});

/** Everything that moves targeting between the states above. Any other input in a state is ignored. */
export const TARGETING_EVENTS = Object.freeze({
  AIM: 'aim',
  ACTIVATE: 'activate',
  OPEN: 'open',
  CLOSE: 'close',
  PLACE: 'place',
  PLACED: 'placed',
  PLACEMENT_CANCELLED: 'placement-cancelled',
  LEAVE: 'leave'
});

const S = TARGETING_STATES;
const E = TARGETING_EVENTS;

/**
 * Every legal transition, state by state. Every state accepts `aim` and `activate`, which replace whatever was
 * aimed, so a second hotbar press swaps the item. Every other event only steps the frame that is already open.
 */
export const TARGETING_TRANSITIONS = Object.freeze({
  [S.IDLE]: Object.freeze({ [E.AIM]: S.AIMING, [E.ACTIVATE]: S.SELECTING }),
  [S.AIMING]: Object.freeze({
    [E.AIM]: S.AIMING, [E.ACTIVATE]: S.SELECTING, [E.OPEN]: S.PREVIEWING, [E.LEAVE]: S.IDLE
  }),
  [S.PREVIEWING]: Object.freeze({
    [E.AIM]: S.AIMING, [E.ACTIVATE]: S.SELECTING, [E.CLOSE]: S.AIMING, [E.LEAVE]: S.IDLE
  }),
  [S.SELECTING]: Object.freeze({
    [E.AIM]: S.AIMING, [E.ACTIVATE]: S.SELECTING, [E.OPEN]: S.RESOLVING, [E.LEAVE]: S.IDLE
  }),
  [S.RESOLVING]: Object.freeze({
    [E.AIM]: S.AIMING, [E.ACTIVATE]: S.SELECTING, [E.CLOSE]: S.SELECTING, [E.PLACE]: S.PLACING, [E.LEAVE]: S.IDLE
  }),
  [S.PLACING]: Object.freeze({
    [E.AIM]: S.AIMING,
    [E.ACTIVATE]: S.SELECTING,
    [E.PLACED]: S.RESOLVING,
    [E.PLACEMENT_CANCELLED]: S.SELECTING,
    [E.CLOSE]: S.SELECTING,
    [E.LEAVE]: S.IDLE
  })
});

/** The states in which a preview, a resolution or a placement is already running, so a further click is ignored. */
const OPENING_STATES = Object.freeze(new Set([S.PREVIEWING, S.RESOLVING, S.PLACING]));
/** The states belonging to an activation rather than an attack. */
const ACTIVATION_STATES = Object.freeze(new Set([S.SELECTING, S.RESOLVING, S.PLACING]));

/** The state an event leads to, or the current one when this state doesn't take it. */
export function nextTargetingState(name, event) {
  return TARGETING_TRANSITIONS[name]?.[event] ?? name;
}

/* -------------------------------------------- */
/*  Current targeting                           */
/* -------------------------------------------- */

const EMPTY = Object.freeze({ name: S.IDLE, frame: null, placement: null, generation: 0 });
let control = EMPTY;

/** The state targeting is in on this client. */
export function targetingStateName() {
  return control.name;
}

/** The staged targeting frame, or null when nothing is aimed. */
export function activeTargeting() {
  return control.frame;
}

/** The waiting placement stage and its resolver, or null outside the placement state. */
export function activePlacement() {
  return control.placement;
}

/** How many times targeting has been entered or left on this client. Nothing in the system reads it. */
export function targetingGeneration() {
  return control.generation;
}

/**
 * The single writer of targeting state. Entering, opening a preview, stepping into and out of placement and
 * leaving all pass through here, so what a click can do next is answered by {@link TARGETING_TRANSITIONS}.
 * @param {string} event A value of {@link TARGETING_EVENTS}.
 * @param {object} [payload] `frame` for an entry, `placement` for the placement stage.
 * @returns {{name: string, frame: object|null, placement: object|null}} The state after the event.
 */
export function advanceTargeting(event, { frame = null, placement = null } = {}) {
  const next = TARGETING_TRANSITIONS[control.name]?.[event];
  if (!next) return control;
  const entering = event === E.AIM || event === E.ACTIVATE;
  const leaving = event === E.LEAVE;
  control = Object.freeze({
    name: next,
    frame: entering ? frame : leaving ? null : control.frame,
    placement: event === E.PLACE ? placement : null,
    generation: entering || leaving ? control.generation + 1 : control.generation
  });
  return control;
}

/* -------------------------------------------- */
/*  Reading the state                           */
/* -------------------------------------------- */

/** Whether a preview, a resolution or a placement is already running. */
export function targetingIsOpening(name = control.name) {
  return OPENING_STATES.has(name);
}

/** Whether the open frame is an activation rather than an attack. */
export function targetingIsActivation(name = control.name) {
  return ACTIVATION_STATES.has(name);
}

/** Whether a placement stage is waiting for its square. */
export function targetingIsPlacing(name = control.name) {
  return name === S.PLACING;
}
