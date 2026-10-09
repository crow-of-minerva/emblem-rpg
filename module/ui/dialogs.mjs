/** @layer ui */
import { SYSTEM_ID } from '../contracts/protocol.mjs';
import { DROP_ACTIONS } from '../contracts/domains/objects.mjs';
import { escapeHtml } from '../lib/dom/html.mjs';
import { KEYBINDING_IDS } from '../config/keybindings.mjs';
import { SOUND_IDS } from '../presentation/audio/sound-database.mjs';
import { canCurrentUserAuthor } from './apps/sheets/base.mjs';
import { CHECK_ROLL_MODES } from '../game/rolls/checks.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../presentation/interface/notifications.mjs';
import { playUiSound } from '../presentation/audio/service.mjs';
import { reportFoundryError, FoundryDiagnostics } from '../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Action vocabulary                           */
/* -------------------------------------------- */
const ACTION_IDS = Object.freeze({
  [`${SYSTEM_ID}.${KEYBINDING_IDS.CONFIRM}`]: 'confirm',
  [`${SYSTEM_ID}.${KEYBINDING_IDS.CANCEL}`]: 'cancel'
});
const FIELD_TAGS = Object.freeze(['INPUT', 'SELECT', 'TEXTAREA']);
const Z_ACTION_OVERLAY = 100000;
const Z_STEP = 10;

/* -------------------------------------------- */
/*  Window stack                                */
/* -------------------------------------------- */
const actionWindows = [];

/** The topmost open action window (one that blocks the canvas and takes the keyboard), or `null`. */
export function topActionWindow() {
  return actionWindows[actionWindows.length - 1] ?? null;
}

/* -------------------------------------------- */
/*  Semantic key matching                       */
/* -------------------------------------------- */
/**
 * Resolve a keyboard event through Foundry's live keybindings.
 * @param {KeyboardEvent} event Event to classify.
 * @returns {'confirm'|'cancel'|null}
 */
function actionFor(event) {
  const KeyboardManager = keyboardManager();
  if (!KeyboardManager || !event) return null;
  const context = KeyboardManager.getKeyboardEventContext(event, event.type === 'keyup');
  const matches = KeyboardManager._getMatchingActions(context) ?? [];
  for (const match of matches) {
    const action = ACTION_IDS[match.action];
    if (action) return action;
  }
  return null;
}

/* -------------------------------------------- */
/*  Blocking action windows                     */
/* -------------------------------------------- */
/**
 * Block the canvas under an action window and send keys to it until it is released. An overlay covers the canvas,
 * keys are matched through Foundry's live keybindings, and only the topmost open window takes them.
 * @param {object} options
 * @param {HTMLElement} options.root The window element to raise and focus.
 * @param {Application|null} [options.app] The application whose bringToFront keeps it at this stack position.
 * @param {Function|null} [options.onConfirm] Runs on Confirm. Returning `false` refuses it.
 * @param {Function|null} [options.onCancel] Runs on Cancel, Escape, or a click on the overlay.
 * @param {Function|null} [options.onRelease] Runs once when the window is released.
 * @param {'blackout'|'shaped'} [options.mode] What happens to other keys. 'shaped' lets modifier chords and
 *   named keys other than the arrows and Tab through, and 'blackout' swallows them all.
 * @param {boolean} [options.overlay] Whether to cover the canvas with the overlay.
 * @param {boolean} [options.outsideClickCancels] Whether a click on the overlay cancels. Shop menus turn it off.
 * @param {string|null} [options.openSound] Sound ID played when the window opens.
 * @param {string|null} [options.cancelSound] Sound ID played when it is released unresolved.
 * @returns {object} The handle that confirms, cancels or releases the window.
 */
function captureBoard({
  root,
  app = null,
  onConfirm = null,
  onCancel = null,
  onRelease = null,
  mode = 'blackout',
  overlay = true,
  outsideClickCancels = true,
  openSound = 'ui.select',
  cancelSound = 'ui.unselect'
} = {}) {
  const depth = actionWindows.length;
  const zOverlay = Z_ACTION_OVERLAY + (depth * Z_STEP);
  const zWindow = zOverlay + 1;
  const handle = {
    root,
    overlay: null,
    depth,
    mode,
    resolved: false,
    released: false,
    zWindow,
    zOverlay
  };

  if (overlay) handle.overlay = createOverlay(handle, depth, zOverlay, outsideClickCancels);

  handle.pin = () => {
    if (handle.released || !handle.root) return;
    if (handle.root.style) handle.root.style.zIndex = String(zWindow);
  };
  handle.resolve = () => { handle.resolved = true; };
  handle.confirm = () => {
    if (handle.released || !onConfirm) return false;
    const accepted = onConfirm(handle);
    if (accepted !== false) handle.resolved = true;
    return accepted !== false;
  };
  handle.cancel = () => {
    if (!handle.released) onCancel?.(handle);
  };

  focusWindow(handle);
  const originalBringToFront = app?.bringToFront ?? null;
  if (app) app.bringToFront = () => handle.pin();

  const onKey = event => captureKey(event, handle);
  globalThis.document?.addEventListener?.('keydown', onKey, true);
  globalThis.document?.addEventListener?.('keyup', onKey, true);

  handle.release = () => {
    if (handle.released) return;
    handle.released = true;
    globalThis.document?.removeEventListener?.('keydown', onKey, true);
    globalThis.document?.removeEventListener?.('keyup', onKey, true);
    handle.overlay?.remove?.();
    handle.overlay = null;
    if (app) app.bringToFront = originalBringToFront;
    const index = actionWindows.indexOf(handle);
    if (index !== -1) actionWindows.splice(index, 1);
    try {
      onRelease?.(handle);
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'Emblem RPG | Action-window release failed');
    }
    if (!handle.resolved) playInterfaceSound(cancelSound);
    refocusBoard();
  };

  actionWindows.push(handle);
  playInterfaceSound(openSound);
  return handle;
}

/* -------------------------------------------- */
/*  Blocking window helpers                     */
/* -------------------------------------------- */
function keyboardManager() {
  const liveManager = globalThis.game?.keyboard?.constructor;
  if (typeof liveManager?.getKeyboardEventContext === 'function'
      && typeof liveManager?._getMatchingActions === 'function') return liveManager;
  const helperManager = globalThis.foundry?.helpers?.interaction?.KeyboardManager;
  return typeof helperManager?.getKeyboardEventContext === 'function'
    && typeof helperManager?._getMatchingActions === 'function'
    ? helperManager
    : null;
}

function createOverlay(handle, depth, zOverlay, outsideClickCancels) {
  const element = globalThis.document?.createElement?.('div');
  if (!element) return null;
  element.className = depth > 0 ? 'confirm-overlay confirm-overlay-nested' : 'confirm-overlay';
  element.style.cssText = `position:fixed;inset:0;z-index:${zOverlay};pointer-events:all;`;
  element.addEventListener('mousedown', () => { if (outsideClickCancels) handle.cancel(); });
  globalThis.document?.body?.appendChild?.(element);
  return element;
}

function focusWindow(handle) {
  if (!handle.root) return;
  handle.root.setAttribute?.('tabindex', '-1');
  if (handle.root.dataset) handle.root.dataset.keyboardFocus = 'false';
  handle.pin();
  handle.root.focus?.();
  globalThis.requestAnimationFrame?.(handle.pin);
}

function captureKey(event, handle) {
  if (handle.released || topActionWindow() !== handle || event.isComposing) return;
  const action = event.key === 'Escape' ? 'cancel' : actionFor(event);
  const inField = isFormField(event.target) && (!handle.root || handle.root.contains?.(event.target));

  if (action === 'cancel') {
    swallow(event);
    if (event.type === 'keydown') handle.cancel();
    return;
  }
  if (inField) return;
  if (action === 'confirm') {
    swallow(event);
    if (event.type === 'keydown') handle.confirm();
    return;
  }
  if (modePassesEvent(event, handle.mode)) return;
  swallow(event);
}

function modePassesEvent(event, mode) {
  if (mode !== 'shaped') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  return Boolean(event.key
    && event.key.length > 1
    && !event.key.startsWith('Arrow')
    && event.key !== 'Tab');
}

function isFormField(target) {
  return Boolean(target?.tagName
    && (FIELD_TAGS.includes(target.tagName) || target.isContentEditable === true));
}

function swallow(event) {
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
}

function refocusBoard() {
  globalThis.document?.activeElement?.blur?.();
  const next = topActionWindow();
  if (next) next.root?.focus?.();
  else globalThis.canvas?.app?.view?.focus?.();
}

function playInterfaceSound(soundId) {
  if (!soundId) return;
  playUiSound(soundId);
}

/* -------------------------------------------- */
/*  Dialog vocabulary                           */
/* -------------------------------------------- */
const CANCEL_ACTIONS = Object.freeze(['cancel', 'no', 'close', 'dismiss']);

/* -------------------------------------------- */
/*  Blocking DialogV2 windows                   */
/* -------------------------------------------- */
/** Find the button a dialog's confirm action should press. */
function findConfirmButton(root, action = null, label = null) {
  if (!root) return null;
  const byAction = action ? root.querySelector?.(`button[data-action="${action}"]`) : null;
  if (byAction) return byAction;
  if (!label) return null;
  return Array.from(root.querySelectorAll?.('button') ?? [])
    .find(button => button.textContent?.trim() === label) ?? null;
}

/**
 * Block the canvas and take the keyboard while this rendered DialogV2 is open. Confirm presses its confirm
 * button, and Cancel or Escape closes it. A click on an action button that isn't one of `cancelActions` counts as
 * resolving it, so closing afterwards plays no cancel sound. Call it from the DialogV2 render callback.
 * @param {DialogV2} dialog The dialog to block for.
 * @param {object} [options]
 * @param {HTMLElement|null} [options.root] The element to raise, instead of the dialog's own.
 * @param {string|null} [options.confirmAction] The `data-action` of the button Confirm presses.
 * @param {string|null} [options.confirmLabel] That button's label, used when no button has the action.
 * @param {Function|null} [options.onConfirm] Runs on Confirm instead of pressing a button.
 * @param {Function|null} [options.onCancel] Runs when the dialog closes without being resolved.
 * @param {Function|null} [options.onRelease] Runs when the dialog is released, resolved or not.
 * @param {string[]} [options.cancelActions] Button actions that don't count as resolving the dialog.
 * @param {'blackout'|'shaped'} [options.mode] What happens to other keys (see captureBoard).
 * @param {boolean} [options.outsideClickCancels] Whether a click off the window closes it. Escape always does.
 * @param {string|null} [options.openSound] Sound ID played when the dialog opens.
 * @param {string|null} [options.cancelSound] Sound ID played when it closes unresolved.
 * @returns {object} The handle from captureBoard.
 */
export function captureForDialog(dialog, {
  root = null,
  confirmAction = 'confirm',
  confirmLabel = null,
  onConfirm = null,
  onCancel = null,
  onRelease = null,
  cancelActions = CANCEL_ACTIONS,
  mode = 'blackout',
  outsideClickCancels = true,
  openSound = SOUND_IDS.UI_SELECT,
  cancelSound = SOUND_IDS.UI_UNSELECT
} = {}) {
  const element = root ?? dialog.element;
  let handle;
  handle = captureBoard({
    root: element,
    app: dialog,
    mode,
    outsideClickCancels,
    openSound,
    cancelSound,
    onConfirm: onConfirm ?? (() => {
      const button = findConfirmButton(element, confirmAction, confirmLabel);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    }),
    onCancel: () => { void dialog.close(); },
    onRelease: released => {
      if (!handle.resolved) onCancel?.(released);
      onRelease?.(released);
    }
  });

  element?.addEventListener?.('click', event => {
    const button = event.target?.closest?.('button[data-action]');
    if (button && !cancelActions.includes(button.dataset.action)) handle.resolve();
  }, true);

  const originalClose = dialog.close.bind(dialog);
  dialog.close = function (...args) {
    handle.release();
    return originalClose(...args);
  };
  return handle;
}

/* -------------------------------------------- */
/*  Blocking dialogs                            */
/* -------------------------------------------- */
/**
 * Open a small fixed-size prompt in the movement dialogs' style. While it is open it blocks the canvas and takes
 * the keyboard (captureForDialog).
 * @param {object} [options]
 * @param {number|string} [options.height] A fixed height, or 'auto' to fit the content.
 * @param {string} [options.content] The prompt's inner markup.
 * @param {object[]} [options.buttons] DialogV2 button descriptors.
 * @param {string|null} [options.dialogClass] An extra CSS class for the dialog.
 * @param {Function|null} [options.onOpen] Runs after render, given the dialog and its handle from captureForDialog.
 * @param {Function|null} [options.onDismiss] Runs when the dialog closes unresolved: dismissed, or closed by a
 *   cancel button.
 * @param {string|null} [options.confirmAction] The button Confirm presses (the default button when left out), or
 *   null when nothing should confirm.
 * @param {'blackout'|'shaped'} [options.mode] What happens to other keys (see captureBoard).
 * @returns {Promise<*>} What the pressed button's callback returned, or the button's action id when it returned
 *   nothing; null when the dialog was closed without a button.
 */
export function openBlockingDialog({
  title = 'Confirmation',
  width = 300,
  height = 150,
  content = '',
  buttons = [],
  dialogClass = null,
  onOpen = null,
  onDismiss = null,
  confirmAction = undefined,
  mode = 'blackout',
  openSound = SOUND_IDS.UI_SELECT,
  cancelSound = SOUND_IDS.UI_UNSELECT
} = {}) {
  const defaultAction = confirmAction !== undefined
    ? confirmAction
    : buttons.find(button => button.default)?.action ?? buttons[0]?.action;
  const classes = dialogClass ? ['confirm-movement', dialogClass] : ['confirm-movement'];

  return foundry.applications.api.DialogV2.wait({
    window: { title, resizable: false },
    position: { width, height },
    classes,
    content: `${content ? `<div class="movement-dialog-confirm">${content}</div>` : ''}
              <div class="confirm-shadow-backdrop"></div>`,
    buttons: buttons.map(({ action, label, default: isDefault, callback }) => ({
      action,
      label,
      default: Boolean(isDefault),
      callback
    })),
    rejectClose: false,
    close: () => {},
    render: (_event, dialog) => {
      const html = dialog.element;
      html.classList.add('confirm-movement');
      if (dialogClass) html.classList.add(dialogClass);
      const application = html.closest('.application') ?? html;
      application.classList.add('confirm-movement-app');
      const capture = captureForDialog(dialog, {
        root: application,
        confirmAction: defaultAction,
        mode,
        openSound,
        cancelSound,
        onCancel: () => onDismiss?.()
      });
      onOpen?.(dialog, capture);
    }
  });
}

/* -------------------------------------------- */
/*  Editor shell                                */
/* -------------------------------------------- */
/** What the Save callback returns when `gather` refuses, so openEditor's submit handler keeps the dialog open. */
const REFUSED_SAVE = Symbol('refused-save');

/**
 * The shared frame for authoring dialogs: Save and Cancel buttons, and a save that writes only after `gather`
 * succeeds. The dialog edits a detached copy. A `gather` that refuses shows its own error and returns undefined,
 * and the dialog then stays open with the author's entries. The promise resolves with what `apply` returns, or
 * with the gathered value when there is no `apply`. If that is null or undefined, DialogV2 gives the confirm
 * action id instead. Cancel resolves `'cancel'`, and closing the window resolves null. A user who may not author
 * the document gets null and no dialog.
 */
export async function openEditor({
  document,
  title,
  icon = null,
  classes = [],
  content = '',
  position = null,
  width,
  height,
  resizable = false,
  wire = null,
  gather = null,
  apply = null,
  ctx = null,
  confirm = true,
  confirmAction = 'save',
  confirmLabel = 'Save',
  confirmIcon = 'fas fa-save',
  cancelLabel = 'Cancel',
  cancelIcon = 'fas fa-times'
} = {}) {
  if (!canCurrentUserAuthor(document)) return null;
  const window = { title, resizable };
  if (icon) window.icon = icon;
  const size = {};
  if (width !== undefined) size.width = width;
  if (height !== undefined) size.height = height;
  const saveButton = {
    action: confirmAction, label: confirmLabel, default: true,
    callback: async (_event, _button, dialog) => {
      const data = gather ? await gather(dialog.element, ctx, dialog) : undefined;
      if (data === undefined && gather) return REFUSED_SAVE;
      return apply ? apply(data, ctx, dialog) : data;
    }
  };
  if (confirmIcon) saveButton.icon = confirmIcon;
  const cancelButton = { action: 'cancel', label: cancelLabel };
  if (cancelIcon) cancelButton.icon = cancelIcon;
  const config = {
    window,
    classes: [SYSTEM_ID, 'dialog-editor', ...classes],
    content: typeof content === 'function' ? await content() : await content,
    buttons: [...(confirm ? [saveButton] : []), cancelButton],
    form: { closeOnSubmit: false }
  };
  const placement = { ...size, ...position };
  if (Object.keys(placement).length) config.position = placement;
  return new Promise(resolve => {
    config.submit = (result, dialog) => {
      if (result === REFUSED_SAVE) return undefined;
      resolve(result);
      return dialog.close({ submitted: true });
    };
    const dialog = new foundry.applications.api.DialogV2(config);
    dialog.addEventListener('close', () => resolve(null), { once: true });
    dialog.addEventListener('render', () => wire?.(dialog.element, ctx, dialog));
    dialog.render({ force: true });
  });
}

/**
 * Whether a dialog resolved with a submitted record rather than a cancel or a dismissal.
 * Foundry resolves a button press to its `action` string whenever the callback yields nothing.
 */
export function isDialogSubmission(value) {
  return Boolean(value) && typeof value === 'object';
}

/* -------------------------------------------- */
/*  Skill checks                                */
/* -------------------------------------------- */
/**
 * Ask how to roll a skill check started from the character sheet (sheets/character/sheet.mjs). Resolves to one of
 * CHECK_ROLL_MODES, or null when the dialog is dismissed.
 */
export async function chooseSkillRollMode(skillLabel) {
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/dialogs/skill-roll.hbs`,
    { skillLabel }
  );
  const result = await openBlockingDialog({
    title: `${skillLabel} Skill Check`,
    width: 320,
    height: 'auto',
    dialogClass: 'dialog-skill-roll',
    openSound: SOUND_IDS.UI_BLIP_5,
    cancelSound: SOUND_IDS.UI_BLIP_2,
    content,
    buttons: [
      {
        action: 'roll',
        label: 'Roll',
        default: true,
        callback: (_event, button) => {
          playUiSound(SOUND_IDS.UI_CONFIRM_ALT);
          return button.form.elements.mode.value;
        }
      },
      { action: 'cancel', label: 'Cancel' }
    ]
  }).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'result'); return null; });
  return CHECK_ROLL_MODES.includes(result) ? result : null;
}

/* -------------------------------------------- */
/*  Drop options                                */
/* -------------------------------------------- */
const DROP_OPTIONS_TEMPLATE = `systems/${SYSTEM_ID}/templates/dialogs/drop-item-options.hbs`;

/**
 * Ask runDropItemFlow's question: send the item to a Convoy, drop it on the ground, or discard it. The ground
 * option needs a token on the viewed Scene. Resolves to the choice, or null when dismissed. The dialog blocks the
 * canvas and opens above any action window already open.
 */
async function openDropItemOptionsDialog({ itemName, convoys = [], placed = false }) {
  const content = await globalThis.foundry.applications.handlebars.renderTemplate(DROP_OPTIONS_TEMPLATE, {
    itemName, convoys, placed
  });
  let choice = null;
  await openBlockingDialog({
    title: 'Drop Item',
    width: 300,
    height: 'auto',
    content,
    dialogClass: 'dialog-drop-item-options',
    confirmAction: null,
    mode: 'shaped',
    openSound: SOUND_IDS.UI_BLIP_2,
    cancelSound: SOUND_IDS.UI_UNSELECT,
    buttons: [{ action: 'cancel', label: 'Cancel' }],
    onOpen: (dialog, capture) => {
      const root = dialog.element;
      const pick = value => {
        choice = value;
        capture.resolve();
        playUiSound(SOUND_IDS.UI_CONFIRM_ALT);
        void dialog.close();
      };
      root.querySelector('.drop-convoy-btn')?.addEventListener('click', event => {
        const chosen = root.querySelector('.drop-convoy-select')?.value ?? event.currentTarget.dataset.convoyUuid;
        pick({ action: 'convoy', convoyUuid: String(chosen ?? '') });
      });
      root.querySelector('.drop-ground-btn')?.addEventListener('click', () => pick('ground'));
      root.querySelector('.drop-delete-btn')?.addEventListener('click', () => pick('discard'));
    }
  });
  return choice;
}

/**
 * The Drop Item flow shared by the character sheet, the trade window and the BG3 HUD's drop action. It asks where
 * the item goes (a Convoy, the ground or the bin), then sends the matching command. A ground drop puts loot on
 * the unit's square and, outside free exploration, commits the unit's move to that square, so it then calls the
 * caller's `resume` to reload the unit's movement.
 * @param {object} input `actor` (a live document) or `tokenUuid` to reach it, the `itemId`, and `resume`.
 * @returns {Promise<object|null>} The command result, or null when nothing was chosen.
 */
export async function runDropItemFlow({ actor = null, tokenUuid = '', itemId, resume = null }) {
  const { api } = game.emblemRpg;
  const token = tokenUuid ? (await fromUuid(tokenUuid)) ?? null : null;
  const owner = actor ?? token?.actor ?? null;
  const item = owner?.items?.get?.(String(itemId ?? '')) ?? null;
  if (!owner || !item) return null;
  const convoys = await api.economy.inspectConvoys(owner.uuid);
  const placed = placedTokenUuid(owner, token);
  const choice = await openDropItemOptionsDialog({ itemName: item.name, convoys, placed: placed !== '' });
  return settleDropChoice({ api, owner, item, choice, placed, resume });
}

/**
 * Send the chosen drop through the host API. Without a placed Token, a discard names the Actor instead, and a
 * ground drop is refused with a notice.
 * @param {object} input The system API, the unit carrying the item, the Item, the choice, the token's uuid, and
 *   `resume`.
 * @returns {Promise<object|null>} The command result, or null when nothing was chosen or nothing can be done.
 */
export async function settleDropChoice({ api, owner, item, choice, placed = '', resume = null }) {
  if (!choice) return null;
  if (choice.action === 'convoy') {
    return api.economy.convoyDeposit({ sourceActorUuid: owner.uuid, itemId: item.id, convoyUuid: choice.convoyUuid });
  }
  if (!placed) {
    if (choice === DROP_ACTIONS.DISCARD) {
      return api.objects.dropItem({ sourceActorUuid: owner.uuid, itemId: item.id, action: DROP_ACTIONS.DISCARD });
    }
    dropNotifications.show(NOTIFICATION_IDS.DROP_UNAVAILABLE, { actorName: owner.name });
    return null;
  }
  const result = await api.objects.dropItem({ sourceTokenUuid: placed, itemId: item.id, action: choice });
  if (result?.ok && choice === DROP_ACTIONS.GROUND && typeof resume === 'function') await resume(placed);
  return result;
}

/** The uuid of the unit's token on the viewed scene, or '' when it has none there. */
function placedTokenUuid(owner, token) {
  const board = globalThis.canvas?.scene ?? null;
  const onBoard = candidate => !!candidate && (!board || candidate.parent === board);
  const standing = token ?? owner.getActiveTokens?.(true, true)?.find(onBoard) ?? null;
  return onBoard(standing) ? String(standing.uuid ?? '') : '';
}

const dropNotifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Amount prompts                              */
/* -------------------------------------------- */
const AMOUNT_TEMPLATE = `systems/${SYSTEM_ID}/templates/dialogs/resource-amount.hbs`;

/**
 * Ask for a whole amount, with step buttons on either side of the field. A ceiling (`max`) limits both the step
 * buttons and the confirmed value.
 * @param {{title: string, prompt: string, steps?: number[], initial?: number, max?: number|null}} options What to ask.
 * @returns {Promise<number|null>} The amount, or null when dismissed.
 */
async function openAmountDialog({ title, prompt, steps = [1, 5], initial = 0, max = null } = {}) {
  const magnitudes = steps.filter(step => Number.isFinite(step) && step > 0);
  const content = await globalThis.foundry.applications.handlebars.renderTemplate(AMOUNT_TEMPLATE, {
    prompt, initial, max, decrements: [...magnitudes].reverse(), increments: magnitudes
  });
  const clamp = value => {
    const amount = Math.max(0, Math.floor(Number(value) || 0));
    return max === null ? amount : Math.min(amount, max);
  };
  return new Promise(resolve => {
    let resolved = false;
    const done = value => { resolved = true; resolve(value); };
    void globalThis.foundry.applications.api.DialogV2.wait({
      window: { title },
      classes: [SYSTEM_ID, 'dialog-resource-amount'],
      content,
      render: (_event, dialog) => {
        const root = dialog.element;
        const input = root.querySelector('.resource-amt-input');
        if (!input) return;
        for (const button of root.querySelectorAll('.resource-amt-btn')) {
          button.addEventListener('click', () => {
            input.value = clamp((parseInt(input.value, 10) || 0) + parseInt(button.dataset.delta, 10));
          });
        }
      },
      buttons: [
        {
          action: 'confirm', label: 'Confirm', default: true,
          callback: (_event, _button, dialog) => done(clamp(dialog.element.querySelector('.resource-amt-input')?.value))
        },
        { action: 'cancel', label: 'Cancel', callback: () => done(null) }
      ],
      close: () => { if (!resolved) resolve(null); }
    });
  });
}

/** Ask how many of a resource to add. A stack moved from another unit passes its size as the ceiling. */
export function openResourceAmountDialog(resourceName, available = null) {
  const max = available === null ? null : Math.max(0, Math.floor(Number(available) || 0));
  return openAmountDialog({
    title: 'Add Resource',
    prompt: `How much <strong>${escapeHtml(resourceName)}</strong> is being added?`
      + (max === null ? '' : `<br />${max} available.`),
    max
  });
}

/** Ask how much Energy a part-way crafter recovers, up to what it has spent. */
export function openEnergyRestoreDialog(unitName, missing) {
  const spent = Math.max(0, Math.floor(Number(missing) || 0));
  return openAmountDialog({
    title: 'Restore Energy',
    prompt: `How much Energy does <strong>${escapeHtml(unitName)}</strong> recover?`
      + `<br />${spent} spent.`,
    initial: Math.min(1, spent),
    max: spent
  });
}

/** Ask how much gold to draw out of a convoy, up to its balance, with larger steps. */
export function openGoldAmountDialog(convoyName, unitName, available) {
  return openAmountDialog({
    title: 'Withdraw Gold',
    prompt: `How much gold goes from <strong>${escapeHtml(convoyName)}</strong> to <strong>${escapeHtml(unitName)}</strong>?`
      + `<br />${Number(available) || 0} GP available.`,
    steps: [1, 10, 100],
    max: Math.max(0, Math.floor(Number(available) || 0))
  });
}

/* -------------------------------------------- */
/*  Merchandise settings                        */
/* -------------------------------------------- */
const MERCHANDISE_LABELS = Object.freeze({
  weapon: 'Weapon', staff: 'Staff', armor: 'Armor', shield: 'Shield', accessory: 'Accessory',
  potion: 'Potion', bomb: 'Bomb', booster: 'Booster', promotion: 'Promotion',
  material: 'Material', textile: 'Textile', reagent: 'Reagent', ingredient: 'Ingredient',
  miscellaneous: 'Miscellaneous'
});
/**
 * Author which goods a vendor buys from players, returning the flat changes the GM command writes.
 * @param {Actor} vendor The Vendor whose settings are being edited.
 * @returns {Promise<object|null>} The dot-path changes, or null when the dialog was cancelled.
 */
export function openMerchandiseSettings(vendor) {
  return new Promise(resolve => {
    let resolved = false;
    const done = value => { if (!resolved) { resolved = true; resolve(value); } };
    void globalThis.foundry.applications.handlebars
      .renderTemplate(`systems/${SYSTEM_ID}/templates/dialogs/merchandise-settings.hbs`,
        merchandiseContext(vendor))
      .then(content => globalThis.foundry.applications.api.DialogV2.wait({
        window: { title: 'Merchandise Settings', icon: 'fas fa-tags' },
        classes: [SYSTEM_ID, 'dialog-merchandise-settings'],
        position: { width: 620 },
        content,
        render: (_event, dialog) => {
          const root = dialog.element;
          for (const button of root.querySelectorAll('.merchandise-bulk')) {
            button.addEventListener('click', () => {
              for (const box of root.querySelectorAll('.merchandise-grid input[type="checkbox"]')) {
                box.checked = button.dataset.checked === 'true';
              }
            });
          }
        },
        buttons: [
          {
            action: 'confirm', label: 'Save', default: true,
            callback: (_event, _button, dialog) => done(readMerchandiseChanges(dialog.element))
          },
          { action: 'cancel', label: 'Cancel', callback: () => done(null) }
        ],
        close: () => done(null)
      }));
  });
}

/** The vendor's current settings in the shape the merchandise template reads. */
function merchandiseContext(vendor) {
  const accepted = vendor?.system?.acceptedMerchandise ?? {};
  return {
    vendorName: String(vendor?.name ?? 'Vendor'),
    accepted: Object.entries(MERCHANDISE_LABELS)
      .map(([key, label]) => ({ key, label, on: accepted[key] !== false }))
  };
}

/** Read every accepted-merchandise checkbox back as the flat dot-path changes the vendor command accepts. */
function readMerchandiseChanges(root) {
  const changes = {};
  for (const field of root?.querySelectorAll?.('input[type="checkbox"][data-path]') ?? []) {
    const path = String(field.dataset.path ?? '');
    if (path) changes[path] = field.checked === true;
  }
  return changes;
}
