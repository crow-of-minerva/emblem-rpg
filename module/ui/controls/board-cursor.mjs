/** @layer ui/controls */
import { BOARD_CURSOR_MODES, markBoardCursorMode } from '../../presentation/interface/availability.mjs';

/* -------------------------------------------- */
/*  Board cursor mode                           */
/* -------------------------------------------- */

/**
 * The gestures after which the cursor is worked out again. Key releases count too, because a pick can open
 * without the pointer moving.
 */
const REFRESH_EVENTS = Object.freeze(['pointermove', 'pointerdown', 'pointerup', 'keyup']);

/** Recheck pointer and key releases next frame, after Foundry finishes settling the drag or plan. */
const SETTLING_EVENTS = new Set(['pointerup', 'keyup']);

/**
 * Choose the board cursor from the control facts. An open targeting grid or interaction pick wins over a drag,
 * just as the canvas input gives a click to the open grid before the move underneath it.
 * @param {{picking?: boolean, dragging?: boolean}} [facts] Whether a grid or pick is waiting for a click, and
 *   whether this client is dragging a unit along its movement path.
 * @returns {string} One of {@link BOARD_CURSOR_MODES}.
 */
export function resolveBoardCursorMode(facts = {}) {
  if (facts.picking === true) return BOARD_CURSOR_MODES.PICK;
  if (facts.dragging === true) return BOARD_CURSOR_MODES.DRAG;
  return BOARD_CURSOR_MODES.NONE;
}

/**
 * Keep the board cursor in step with the controls. init/hooks.mjs installs this once during setup, with
 * readBoardCursorFacts as `readFacts`. The listeners run in the capture phase on the document.
 * @param {object} ports
 * @param {Function} ports.readFacts Returns the facts {@link resolveBoardCursorMode} decides from.
 * @param {object} [ports.host] Holds the document to listen on (the browser window by default).
 * @param {Function} [ports.frame] Schedules the second reading after a release (the next animation frame by
 *   default).
 */
export function installBoardCursor({ readFacts, host = globalThis, frame = null }) {
  const target = host?.document ?? null;
  const defer = frame ?? (callback => (host?.requestAnimationFrame ?? setTimeout)(callback, 0));
  let marked = markBoardCursorMode(BOARD_CURSOR_MODES.NONE);
  let deferred = false;
  const refresh = () => {
    const mode = resolveBoardCursorMode(readFacts());
    if (mode !== marked) marked = markBoardCursorMode(mode);
    return marked;
  };
  const onInput = event => {
    refresh();
    if (deferred || !SETTLING_EVENTS.has(String(event?.type ?? ''))) return;
    deferred = true;
    defer(() => {
      deferred = false;
      refresh();
    });
  };
  for (const event of REFRESH_EVENTS) target?.addEventListener?.(event, onInput, { capture: true, passive: true });
}
