/** @layer ui/controls */
import { MOVEMENT_HOLD_REPEAT_DELAY_MS } from '../../config/constants.mjs';
import { MOVEMENT_INPUT_KINDS } from '../../game/movement/input-policy.mjs';
import { movementInputPermission } from './unit-access.mjs';

/* -------------------------------------------- */
/*  Held directional keys                       */
/* -------------------------------------------- */

/*
 * The window-level keyboard side of movement, with two jobs. It swallows a core pan or move key whose gesture
 * movementInputPermission refuses, before Foundry's own KeyboardManager sees it. And it fills the gap before the
 * browser's own auto-repeat starts, so a held key steps at a steady pace. ui/controls/movement.mjs installs this
 * with the rest of its wrappers, and reads takeFreshMovementPress and movementKeyHeld in onPreUpdateTokenMovement
 * to tell a fresh press from a repeat.
 */
const movementRepeatBridges = new Map();
const repeatingMovementKeys = new Set();
const freshMovementPresses = new Set();
const CORE_MOVEMENT_KEYS = new WeakMap();

/** Install the capture-phase key guards and the repeat bridge they drive. */
export function installMovementKeyBlocker() {
  const browserWindow = globalThis.window;
  if (typeof browserWindow?.addEventListener !== 'function') return;
  const onKeydown = event => {
    if (isFormField(globalThis.document?.activeElement)) return;
    const controlled = globalThis.canvas?.tokens?.controlled ?? [];
    if (controlled.length !== 1 || !coreMovementKeys().has(String(event.code ?? '').toLowerCase())) return;
    const permission = movementInputPermission(controlled[0], MOVEMENT_INPUT_KINDS.KEYBOARD);
    if (permission.allowed) {
      if (event.repeat === true) {
        repeatingMovementKeys.add(event.code);
        stopMovementRepeatBridge(event.code);
      }
      else {
        freshMovementPresses.add(event.code);
        startMovementRepeatBridge(event);
      }
      return;
    }
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  };
  const onKeyup = event => {
    repeatingMovementKeys.delete(event.code);
    freshMovementPresses.delete(event.code);
    stopMovementRepeatBridge(event.code);
  };
  browserWindow.addEventListener('keydown', onKeydown, true);
  browserWindow.addEventListener('keyup', onKeyup, true);
  browserWindow.addEventListener('blur', releaseHeldMovementKeys, true);
  browserWindow.addEventListener('visibilitychange', releaseHeldMovementKeys, true);
}

/** Report whether Foundry is currently processing a held directional key. */
export function isHeldMovementRepeating() {
  return repeatingMovementKeys.size > 0;
}

/** Drop every held key and its bridge, as a lost focus or a cancelled step does. */
export function releaseHeldMovementKeys() {
  repeatingMovementKeys.clear();
  freshMovementPresses.clear();
  for (const code of [...movementRepeatBridges.keys()]) stopMovementRepeatBridge(code);
}

/** Whether a step came from a fresh press rather than a repeat, which decides if a crossing may be offered. */
export function takeFreshMovementPress() {
  const fresh = freshMovementPresses.size > 0;
  freshMovementPresses.clear();
  return fresh;
}

/** Whether a directional key is down, so a keyboard step that arrives with none held came from a macro or module. */
export function movementKeyHeld() {
  return freshMovementPresses.size > 0 || repeatingMovementKeys.size > 0 || movementRepeatBridges.size > 0;
}

/* -------------------------------------------- */
/*  Repeat bridge                               */
/* -------------------------------------------- */

/**
 * The key codes bound to Foundry's core pan and move actions. The set is cached per `activeKeys` Map, which
 * Foundry builds afresh whenever bindings change, so a rebind starts a new cache and other keypresses skip the
 * walk over every action.
 */
function coreMovementKeys() {
  const index = game.keybindings.activeKeys;
  const cached = CORE_MOVEMENT_KEYS.get(index);
  if (cached) return cached;
  const keys = new Set();
  for (const [actionId, action] of game.keybindings.actions) {
    if (!actionId.startsWith('core.pan') && !actionId.startsWith('core.move')) continue;
    for (const binding of [...(action.editable ?? []), ...(action.uneditable ?? [])]) {
      if (binding?.key) keys.add(String(binding.key).toLowerCase());
    }
  }
  CORE_MOVEMENT_KEYS.set(index, keys);
  return keys;
}

function startMovementRepeatBridge(event) {
  const delay = Math.max(0, Number(MOVEMENT_HOLD_REPEAT_DELAY_MS) || 0);
  const code = String(event?.code ?? '');
  if (!code || !delay || movementRepeatBridges.has(code)) return;
  const bridge = {
    code,
    altKey: event.altKey === true,
    ctrlKey: event.ctrlKey === true || event.metaKey === true,
    shiftKey: event.shiftKey === true,
    timer: null
  };
  const repeat = () => {
    if (movementRepeatBridges.get(code) !== bridge) return;
    if (!movementRepeatAllowed(code)) {
      stopMovementRepeatBridge(code);
      return;
    }
    const KeyboardManager = coreKeyboardManager();
    if (typeof KeyboardManager?.emulateKeypress !== 'function') {
      stopMovementRepeatBridge(code);
      return;
    }
    repeatingMovementKeys.add(code);
    KeyboardManager.emulateKeypress(false, code, {
      altKey: bridge.altKey,
      ctrlKey: bridge.ctrlKey,
      shiftKey: bridge.shiftKey,
      repeat: true
    });
    if (movementRepeatBridges.get(code) !== bridge) return;
    game.keyboard.downKeys.add(code);
    bridge.timer = setTimeout(repeat, delay);
  };
  bridge.timer = setTimeout(repeat, delay);
  movementRepeatBridges.set(code, bridge);
}

function movementRepeatAllowed(code) {
  if (!game.keyboard.downKeys.has(code)) return false;
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  return controlled.length === 1
    && movementInputPermission(controlled[0], MOVEMENT_INPUT_KINDS.KEYBOARD).allowed;
}

function stopMovementRepeatBridge(code) {
  const key = String(code ?? '');
  const bridge = movementRepeatBridges.get(key);
  if (!bridge) return false;
  clearTimeout(bridge.timer);
  movementRepeatBridges.delete(key);
  return true;
}

function coreKeyboardManager() {
  const liveManager = globalThis.game?.keyboard?.constructor;
  if (typeof liveManager?.emulateKeypress === 'function') return liveManager;
  const helperManager = globalThis.foundry?.helpers?.interaction?.KeyboardManager;
  return typeof helperManager?.emulateKeypress === 'function' ? helperManager : null;
}

function isFormField(element) {
  return Boolean(element?.tagName
    && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable));
}
