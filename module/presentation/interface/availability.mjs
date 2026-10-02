/** @layer presentation/interface */

/* -------------------------------------------- */
/*  Cursor modes                                */
/* -------------------------------------------- */

/**
 * What this client's canvas pointer is being used for, which the cursor shows. DRAG means the player is moving a
 * unit, and PICK means a targeting grid is waiting for a square or unit. resolveBoardCursorMode in
 * ui/controls/board-cursor.mjs chooses the mode.
 */
export const BOARD_CURSOR_MODES = Object.freeze({ NONE: 'none', DRAG: 'drag', PICK: 'pick' });

const BOARD_MODE_CLASSES = Object.freeze({
  [BOARD_CURSOR_MODES.DRAG]: 'emblem-board-drag',
  [BOARD_CURSOR_MODES.PICK]: 'emblem-board-pick'
});

const PAUSE_FREEZE_CLASS = 'emblem-pause-frozen';
const SCENE_LOCK_CLASS = 'emblem-scene-locked';

/* -------------------------------------------- */
/*  Body classes                                */
/* -------------------------------------------- */

/**
 * Put the class for this cursor mode on the page body, so the stylesheet shows the matching cursor.
 * @param {string} mode One of {@link BOARD_CURSOR_MODES}. Anything else clears the cursor classes.
 * @returns {string} The mode that was marked.
 */
export function markBoardCursorMode(mode) {
  const marked = Object.hasOwn(BOARD_MODE_CLASSES, mode) ? mode : BOARD_CURSOR_MODES.NONE;
  const classes = bodyClasses();
  for (const [candidate, className] of Object.entries(BOARD_MODE_CLASSES)) {
    classes?.toggle(className, candidate === marked);
  }
  return marked;
}

/**
 * Mark the page body while the game is paused and this user is frozen, so the stylesheet shows a not-allowed cursor
 * over the map and the hotbar. init/hooks.mjs passes localUserFrozenByPause(), which never freezes a GM.
 * @param {boolean} frozen Whether the local user is frozen.
 * @returns {boolean} The state that was marked.
 */
export function markPauseFreeze(frozen) {
  const held = frozen === true;
  bodyClasses()?.toggle(PAUSE_FREEZE_CLASS, held);
  return held;
}

/**
 * Mark the page body while the encounter scene lock is on, so the scene navigation shows a locked cursor on every
 * other scene. The encounter scene lock built in init/hooks.mjs calls it.
 * @param {boolean} locked Whether the lock is in force.
 * @returns {boolean} The state that was marked.
 */
export function markSceneLock(locked) {
  const held = locked === true;
  bodyClasses()?.toggle(SCENE_LOCK_CLASS, held);
  return held;
}

/* -------------------------------------------- */
/*  Document access                             */
/* -------------------------------------------- */

/** The page body's class list, or null when there is no page. */
function bodyClasses() {
  return globalThis.document?.body?.classList ?? null;
}
