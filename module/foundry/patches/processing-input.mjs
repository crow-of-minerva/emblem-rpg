/** @layer foundry/patches */
import { PROCESSING_INPUTS } from '../adapters/services/processing-blocker.mjs';
import { localUserIsStaff } from '../adapters/services/host.mjs';

const CHAT = '#chat-form, #chat-message, .chat-input';
/**
 * Match tab buttons, not their panels. ProcessingBlocker allows inspection but must still block gameplay controls
 * inside a panel.
 */
const TABS = 'button[data-tab], a[data-tab], [data-action="tab"], [data-action="setTab"]';
const INSPECTION = `${TABS}, [data-action="close"], [data-action="minimize"], .window-title, .document-name, .entry-name`;
/** Allow directory search fields through ProcessingBlocker because they change only the local view. */
const SEARCH = 'input[type="search"], [name="search"], .directory-header input';
const SEARCH_EVENTS = new Set(['input', 'change', 'keydown']);
/** Fields a keystroke is typed into rather than sent to the canvas. */
const FORM_FIELDS = 'input, textarea, select, [contenteditable="true"]';
/**
 * Allow staff segment-stop controls through ProcessingBlocker. They request a safe stop from CommandDispatcher
 * without taking execution.
 */
const STAFF_CONTROLS = '[data-emblem-processing-control="segment-stop"]';
const STAFF_CONTROL_KEYS = new Set(['Enter', ' ']);
const CAMERA_KEYS = new Set([' ', '+', '-', '=', 'PageUp', 'PageDown', 'Home', 'End']);
const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const INPUT_EVENTS = Object.freeze(['pointerdown', 'click', 'submit', 'change', 'input', 'drop', 'keydown']);
/** Refused only while ProcessingBlocker reports startup. A processing hold leaves these to the camera and browser. */
const STARTUP_EVENTS = Object.freeze(['wheel', 'contextmenu', 'dblclick', 'dragstart']);
const NATIVE_DOCUMENTS = Object.freeze(['Scene', 'Token', 'Wall', 'Tile', 'Drawing', 'AmbientLight', 'AmbientSound',
  'MeasuredTemplate', 'Region', 'RegionBehavior', 'Combat', 'Combatant', 'JournalEntry', 'JournalEntryPage',
  'Folder', 'Playlist', 'PlaylistSound', 'Macro', 'RollTable', 'TableResult', 'Cards', 'Card']);

/**
 * Sort one captured local input event into a PROCESSING_INPUTS kind. Canvas control and drag are guarded separately,
 * by the token wrappers in patches/token-drag.mjs.
 * @param {Event} event The captured input event.
 * @param {{staff?: boolean, controlling?: boolean}} [options] Whether this client's user is staff, whose marked stop
 *   controls pass, and whether it controls a token, in which case an unmodified pan key would move that token instead.
 * @returns {string} One of {@link PROCESSING_INPUTS}.
 */
function processingInputKind(event, { staff = false, controlling = false } = {}) {
  const inside = selector => Boolean(event.target?.closest?.(selector));
  if (inside(CHAT)) return PROCESSING_INPUTS.CHAT;
  if (staff === true && inside(STAFF_CONTROLS) && pressesControl(event)) return PROCESSING_INPUTS.INSPECT;
  if (SEARCH_EVENTS.has(event.type) && inside(SEARCH)) return PROCESSING_INPUTS.INSPECT;
  if (event.type === 'pointerdown') {
    if (!inside('canvas')) return PROCESSING_INPUTS.INSPECT;
    return event.button === 2 ? PROCESSING_INPUTS.CAMERA : PROCESSING_INPUTS.GAMEPLAY;
  }
  if (event.type === 'submit' || event.type === 'change' || event.type === 'input') return PROCESSING_INPUTS.SAVE;
  if (event.type === 'drop') return PROCESSING_INPUTS.ADMIN;
  if (event.type === 'keydown') {
    const key = String(event.key ?? '');
    if (['Escape', 'Tab', 'F5'].includes(key)) return PROCESSING_INPUTS.INSPECT;
    if (CAMERA_KEYS.has(key)) return PROCESSING_INPUTS.CAMERA;
    if (PAN_KEYS.has(key.toLowerCase()) && (modified(event) || (!controlling && !inside(FORM_FIELDS)))) {
      return PROCESSING_INPUTS.CAMERA;
    }
    return PROCESSING_INPUTS.GAMEPLAY;
  }
  if (inside(INSPECTION)) return PROCESSING_INPUTS.INSPECT;
  if (inside('button, a, input, select, [role="button"], [data-action], .context-item, [data-menu-index]')) {
    return PROCESSING_INPUTS.ADMIN;
  }
  return PROCESSING_INPUTS.INSPECT;
}

/**
 * Install the capture-phase input guard, from init/system.mjs. While processing runs it refuses the input kinds
 * ProcessingBlocker holds, on native and system forms alike, the GM's included. While ProcessingBlocker still reports
 * startup it refuses every input unclassified, except the browser's reload and developer-tools keys. A page coming
 * back into view resyncs with the host (`sync`).
 */
export function installProcessingInputGuards({ document = globalThis.document, blocker, sync, inspectCanvas = null,
  isStaff = localUserIsStaff, controlsTokens = localTokensControlled }) {
  const input = event => {
    if (blocker.starting() === true) {
      if (!browserKey(event)) refuseInput(event);
      return;
    }
    if (!INPUT_EVENTS.includes(event.type)) return;
    const kind = processingInputKind(event, { staff: isStaff() === true, controlling: controlsTokens() === true });
    if (blocker.admitInput(kind)) return;
    if (event.type === 'pointerdown' && event.target?.closest?.('canvas')) inspectCanvas?.();
    refuseInput(event);
  };
  const visible = () => { if (document.visibilityState === 'visible') void sync(); };
  for (const name of [...INPUT_EVENTS, ...STARTUP_EVENTS]) {
    document.addEventListener(name, input, { capture: true, passive: name === 'wheel' });
  }
  document.addEventListener('visibilitychange', visible);
}

/** Stop an event before Foundry's handlers. The wheel listener is passive, so it only stops propagation. */
function refuseInput(event) {
  if (event.type !== 'wheel') event.preventDefault?.();
  event.stopImmediatePropagation?.();
}

/** A reload or developer-tools key, which stays usable so a stalled load can be reloaded or examined. */
function browserKey(event) {
  if (event.type !== 'keydown') return false;
  const key = String(event.key ?? '');
  if (key === 'F5' || key === 'F12') return true;
  return key.toLowerCase() === 'r' && Boolean(event.ctrlKey || event.metaKey);
}

/** Recheck non-host native edits when Foundry is about to submit them, including forms opened before processing. */
export function installProcessingNativeGuards({ hooks = globalThis.Hooks, blocker }) {
  const guard = () => blocker.admitNativeWrite() ? undefined : false;
  for (const documentName of NATIVE_DOCUMENTS) {
    for (const action of ['Create', 'Update', 'Delete']) hooks.on(`pre${action}${documentName}`, guard);
  }
}

/** A press of a marked control: a click, a pointer press, or a key that activates a focused button. */
function pressesControl(event) {
  if (event.type === 'click' || event.type === 'pointerdown') return true;
  return event.type === 'keydown' && STAFF_CONTROL_KEYS.has(String(event.key ?? ''));
}

/** Whether a keystroke carries a modifier, which makes a pan key a camera key even inside a field. */
function modified(event) {
  return Boolean(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey);
}

/** Whether this client controls a token on its canvas, so an arrow or WASD key would move it rather than pan. */
function localTokensControlled() {
  return (Number(globalThis.canvas?.tokens?.controlled?.length) || 0) > 0;
}
