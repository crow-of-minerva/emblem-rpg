/** @layer ui/controls */

/* -------------------------------------------- */
/*  Interaction pick states                     */
/* -------------------------------------------- */

/**
 * The states of this client's interaction pick: the door, trade, steal or socialize ring that
 * ui/controls/interaction.mjs draws. Open windows (a station menu, trade window, shop or social menu) are not
 * states. They are counted separately and read through {@link interactionHoldsBoard}, because a window can be
 * open with no pick behind it, and a pick can be reopened while the window it opened is still settling.
 */
export const PICK_STATES = Object.freeze({
  /** No pick is drawn and no answered pick is still settling. */
  IDLE: 'idle',
  /** The door ring is drawn and waiting for its click. */
  DOORS: 'doors',
  /** The trade, steal or socialize ring is drawn and waiting for its click. */
  UNITS: 'units',
  /** The click a pick took is being answered by its window or command. */
  SETTLING: 'settling'
});

/** Everything that moves a pick between the states above. Any other input in a state is ignored. */
export const PICK_EVENTS = Object.freeze({
  OPEN_DOORS: 'open-doors',
  OPEN_UNITS: 'open-units',
  REFRESH: 'refresh',
  CLOSE: 'close',
  SETTLE_START: 'settle-start',
  SETTLE_END: 'settle-end',
  WINDOW_OPENED: 'window-opened',
  WINDOW_CLOSED: 'window-closed',
  STAGE_ACTIVATION: 'stage-activation',
  CLEAR_ACTIVATION: 'clear-activation'
});

const S = PICK_STATES;
const E = PICK_EVENTS;

/**
 * Every legal transition, state by state.
 *
 * A unit pick can reopen from SETTLING: when its window closes with nothing spent, the pick is drawn again while
 * the workflow that opened the window is still running. Window and activation events never change the state name.
 */
export const PICK_TRANSITIONS = Object.freeze({
  [S.IDLE]: Object.freeze({
    [E.OPEN_DOORS]: S.DOORS,
    [E.OPEN_UNITS]: S.UNITS,
    [E.SETTLE_START]: S.SETTLING,
    [E.WINDOW_OPENED]: S.IDLE,
    [E.WINDOW_CLOSED]: S.IDLE,
    [E.STAGE_ACTIVATION]: S.IDLE,
    [E.CLEAR_ACTIVATION]: S.IDLE
  }),
  [S.DOORS]: Object.freeze({
    [E.CLOSE]: S.IDLE,
    [E.REFRESH]: S.DOORS,
    [E.SETTLE_END]: S.DOORS,
    [E.WINDOW_OPENED]: S.DOORS,
    [E.WINDOW_CLOSED]: S.DOORS,
    [E.STAGE_ACTIVATION]: S.DOORS,
    [E.CLEAR_ACTIVATION]: S.DOORS
  }),
  [S.UNITS]: Object.freeze({
    [E.CLOSE]: S.IDLE,
    [E.REFRESH]: S.UNITS,
    [E.SETTLE_END]: S.UNITS,
    [E.WINDOW_OPENED]: S.UNITS,
    [E.WINDOW_CLOSED]: S.UNITS,
    [E.STAGE_ACTIVATION]: S.UNITS,
    [E.CLEAR_ACTIVATION]: S.UNITS
  }),
  [S.SETTLING]: Object.freeze({
    [E.OPEN_DOORS]: S.DOORS,
    [E.OPEN_UNITS]: S.UNITS,
    [E.SETTLE_START]: S.SETTLING,
    [E.SETTLE_END]: S.IDLE,
    [E.WINDOW_OPENED]: S.SETTLING,
    [E.WINDOW_CLOSED]: S.SETTLING,
    [E.STAGE_ACTIVATION]: S.SETTLING,
    [E.CLEAR_ACTIVATION]: S.SETTLING
  })
});

/**
 * The state an event leads to by the table alone, or the current one when this state doesn't take it.
 * {@link advanceInteractionPick} also keeps a closed pick in SETTLING while its click is still being answered.
 */
export function nextPickState(name, event) {
  return PICK_TRANSITIONS[name]?.[event] ?? name;
}

/* -------------------------------------------- */
/*  Current pick                                */
/* -------------------------------------------- */

const EMPTY = Object.freeze({ name: S.IDLE, pick: null, activation: null, settling: 0, windows: 0 });
let control = EMPTY;

/** The state this client's interaction pick is in. */
export function pickStateName() {
  return control.name;
}

/** The drawn pick, or null when none is waiting for a click. */
export function activePick() {
  return control.pick;
}

/** The hotbar Ability staged as the picking unit's activation, or null. */
export function stagedPickActivation() {
  return control.activation;
}

/** Whether a door or unit pick owns the canvas: drawn and awaiting its click, or settling the click it took. */
export function pickOwnsCanvas() {
  return control.name !== S.IDLE;
}

/** Whether this client is mid-interaction: a pick is drawn or settling, or an interaction window is open. */
export function interactionHoldsBoard() {
  return control.name !== S.IDLE || control.windows > 0;
}

/**
 * The single writer of interaction-pick state. Opening, answering, reopening and closing a pick, counting the
 * windows a pick handed off to and marking the staged Ability all pass through here.
 * @param {string} event A value of {@link PICK_EVENTS}.
 * @param {object} [payload] `pick` for an opening, `activation` for the staged Ability.
 * @returns {object} The state after the event.
 */
export function advanceInteractionPick(event, { pick = null, activation = null } = {}) {
  const settling = event === E.SETTLE_START ? control.settling + 1
    : event === E.SETTLE_END ? Math.max(0, control.settling - 1)
    : control.settling;
  const stepped = PICK_TRANSITIONS[control.name]?.[event];
  if (!stepped) return control;
  const next = stepped === S.IDLE && settling > 0 ? S.SETTLING : stepped;
  const opening = event === E.OPEN_DOORS || event === E.OPEN_UNITS || event === E.REFRESH;
  control = Object.freeze({
    name: next,
    pick: opening ? pick : event === E.CLOSE ? null : control.pick,
    activation: event === E.STAGE_ACTIVATION ? activation
      : event === E.CLEAR_ACTIVATION ? null : control.activation,
    settling,
    windows: event === E.WINDOW_OPENED ? control.windows + 1
      : event === E.WINDOW_CLOSED ? Math.max(0, control.windows - 1) : control.windows
  });
  return control;
}

/* -------------------------------------------- */
/*  Unit inspection states                      */
/* -------------------------------------------- */

/**
 * The states of this client's unit inspection: whether the tooltip key is held, and whether the description shows
 * one of the unit's other attacks instead of the one it wields. The hovered Token is tracked in every
 * state, because the tooltip opens on whatever the pointer is over when the key goes down.
 */
export const INSPECT_STATES = Object.freeze({
  IDLE: 'idle',
  DESCRIBING: 'describing',
  PREVIEWING: 'previewing'
});

/** Everything that moves inspection between the states above. */
export const INSPECT_EVENTS = Object.freeze({
  HOLD: 'hold',
  RELEASE: 'release',
  HOVER: 'hover',
  REHOVER: 'rehover',
  UNHOVER: 'unhover',
  PREVIEW_ATTACK: 'preview-attack',
  PREVIEW_CLEARED: 'preview-cleared'
});

const I = INSPECT_STATES;
const IE = INSPECT_EVENTS;

/**
 * Every legal inspection transition. Moving the pointer to a different unit drops any attack preview but keeps
 * the key held. Returning to the unit already described keeps the attack it was stepped to.
 */
export const INSPECT_TRANSITIONS = Object.freeze({
  [I.IDLE]: Object.freeze({
    [IE.HOLD]: I.DESCRIBING, [IE.RELEASE]: I.IDLE, [IE.HOVER]: I.IDLE, [IE.REHOVER]: I.IDLE, [IE.UNHOVER]: I.IDLE
  }),
  [I.DESCRIBING]: Object.freeze({
    [IE.HOLD]: I.DESCRIBING,
    [IE.RELEASE]: I.IDLE,
    [IE.HOVER]: I.DESCRIBING,
    [IE.REHOVER]: I.DESCRIBING,
    [IE.UNHOVER]: I.DESCRIBING,
    [IE.PREVIEW_ATTACK]: I.PREVIEWING,
    [IE.PREVIEW_CLEARED]: I.DESCRIBING
  }),
  [I.PREVIEWING]: Object.freeze({
    [IE.HOLD]: I.PREVIEWING,
    [IE.RELEASE]: I.IDLE,
    [IE.HOVER]: I.DESCRIBING,
    [IE.REHOVER]: I.PREVIEWING,
    [IE.UNHOVER]: I.DESCRIBING,
    [IE.PREVIEW_ATTACK]: I.PREVIEWING,
    [IE.PREVIEW_CLEARED]: I.DESCRIBING
  })
});

/** The inspection state an event leads to, or the current one when this state doesn't take it. */
export function nextInspectState(name, event) {
  return INSPECT_TRANSITIONS[name]?.[event] ?? name;
}

const NO_INSPECTION = Object.freeze({ name: I.IDLE, token: null, attackIndex: null });
let inspection = NO_INSPECTION;

/** The state unit inspection is in on this client. */
export function inspectStateName() {
  return inspection.name;
}

/** The Token currently under the pointer, which every hover-driven gesture reads. */
export function inspectedToken() {
  return inspection.token;
}

/** Which of the hovered unit's attacks the description shows, or null for the one it wields. */
export function inspectedAttackIndex() {
  return inspection.attackIndex;
}

/**
 * The single writer of inspection state: the modifier going down and up, the pointer arriving and leaving, and
 * the attack the description steps through.
 * @param {string} event A value of {@link INSPECT_EVENTS}.
 * @param {object} [payload] `token` for a hover, `attackIndex` for a preview step.
 * @returns {object} The state after the event.
 */
export function advanceInspection(event, { token = null, attackIndex = null } = {}) {
  const next = INSPECT_TRANSITIONS[inspection.name]?.[event];
  if (!next) return inspection;
  const arriving = event === IE.HOVER || event === IE.REHOVER;
  inspection = Object.freeze({
    name: next,
    token: arriving ? token : event === IE.UNHOVER ? null : inspection.token,
    attackIndex: event === IE.PREVIEW_ATTACK ? attackIndex : next === I.PREVIEWING ? inspection.attackIndex : null
  });
  return inspection;
}
