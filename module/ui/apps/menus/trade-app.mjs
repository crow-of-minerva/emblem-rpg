/** @layer ui/apps/menus */
import { TRADE_MODES } from '../../../contracts/domains/economy.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { playMenuSound, playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../presentation/interface/notifications.mjs';
import { resolveActor } from '../../../foundry/adapters/services/host.mjs';
import { captureForDialog, runDropItemFlow } from '../../dialogs.mjs';
import { SHEET_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';
import { FoundryDiagnostics } from '../../../foundry/adapters/services/diagnostics.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/trade-menu.hbs`;
const TAB_ICONS = `systems/${SYSTEM_ID}/assets/ui/table-tabs`;
const TRADE_TABS = Object.freeze([
  Object.freeze({ key: 'equipment', label: 'Equipment', icon: `${TAB_ICONS}/equipment.png` }),
  Object.freeze({ key: 'pockets', label: 'Pockets', icon: `${TAB_ICONS}/inventory.png` })
]);
const CONTAINER_TABS = Object.freeze([Object.freeze({ key: 'all', label: 'All', icon: `${TAB_ICONS}/inventory.png` })]);
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });
const NO_CHOICE = Object.freeze({ confirmed: false, giveItemIds: Object.freeze([]), takeItemIds: Object.freeze([]) });

/** Where an Item sheet opened from a menu row is held, above the window that opened it. */
const PINNED_SHEET_Z = 100002;

/** The parts of a row that inspect the Item rather than pick it: its portrait and its name. */
const ROW_INSPECT_SELECTOR = '.trade-item-icon, .trade-item-name';

/* -------------------------------------------- */
/*  Trade window                                */
/* -------------------------------------------- */

/**
 * Show the api.economy.inspectTrade view as a trade, loot or theft window. openTradeFor in
 * ui/controls/interaction.mjs opens it and acts on the returned choice.
 * @param {object} view The economy query's trade view.
 * @param {{confirm?: Function, resume?: Function, refresh?: Function}} [handlers] `confirm` runs the ticked
 *   exchange, and the window closes only once it returns true. `resume` is called after a row is dropped on the
 *   ground, so the unit's movement plan is worked out again. `refresh` reads the trade view again after the host
 *   refuses an exchange, so the window shows the goods as they now stand.
 * @returns {Promise<{confirmed: boolean, giveItemIds: string[], takeItemIds: string[]}>}
 */
export async function openTradeWindow(view, { confirm = null, resume = null, refresh = null } = {}) {
  if (globalThis.document?.querySelector?.('.window-trade-menu')) return NO_CHOICE;
  const context = prepareTradeView(view);
  const content = await globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, context);
  const state = { outcome: NO_CHOICE, processing: false, handle: null };
  await globalThis.foundry.applications.api.DialogV2.wait({
    window: { title: context.title, resizable: false },
    classes: [SYSTEM_ID, 'window-trade-menu', 'trade-menu-dialog'],
    position: { width: context.isSteal || context.takeOnly ? 500 : 800, height: 600 },
    content,
    buttons: [
      { action: 'confirm', label: context.confirmLabel },
      { action: 'cancel', label: 'Cancel' }
    ],
    render: (_event, dialog) => {
      const root = dialog.element;
      const handlers = { confirm, resume, refresh };
      wireTradeWindow(root.querySelector('.trade-menu-container') ?? root, context, {
        confirm: () => confirmTrade(dialog, root, handlers, state),
        cancel: () => dialog.close(),
        resume
      });
      state.handle = captureForDialog(dialog, {
        mode: 'shaped',
        openSound: SOUND_IDS.UI_SELECT_ALT,
        onConfirm: () => {
          const button = root.querySelector('.trade-confirm-btn');
          if (!button || button.disabled) return false;
          button.click();
          return true;
        }
      });
    }
  });
  return state.outcome;
}

/** Send the ticked rows through the caller's `confirm`. A refusal leaves the window open to be corrected. */
async function confirmTrade(dialog, root, handlers, state) {
  if (state.processing) return false;
  const choices = readTradeChoices(root);
  if (!choices.giveItemIds.length && !choices.takeItemIds.length) {
    notifications.show(NOTIFICATION_IDS.TRADE_NOTHING_SELECTED);
    return false;
  }
  state.processing = true;
  let accepted = false;
  try {
    accepted = await settleTradeConfirmation({
      choices,
      confirm: handlers.confirm,
      refresh: handlers.refresh,
      rerender: view => rerenderTradeWindow(dialog, root, view, handlers, state),
      close: () => dialog.close()
    });
  } finally {
    state.processing = false;
  }
  if (!accepted) return false;
  state.outcome = Object.freeze({ confirmed: true, ...choices });
  playTradeSound(SOUND_IDS.UI_CONFIRM);
  state.handle?.resolve?.();
  await dialog.close();
  return true;
}

/**
 * Run `confirm` on the ticked rows. If it refuses and a `refresh` is given, read the trade view again and rebuild
 * the window, or close it when the trade is no longer possible. Without a `refresh`, as for a theft's carrying-room
 * check, the window and its ticks stay as they are.
 * @param {object} input The ticked `choices`, the `confirm` sender, and the `refresh`, `rerender` and `close` steps.
 * @returns {Promise<boolean>} Whether the exchange was accepted.
 */
async function settleTradeConfirmation({ choices, confirm = null, refresh = null, rerender, close }) {
  if (!confirm || await confirm(choices) === true) return true;
  if (typeof refresh !== 'function') return false;
  const fresh = await refresh();
  if (!fresh || fresh.refusal) await close(fresh);
  else await rerender(fresh);
  return false;
}

/** Rebuild the window's body from a fresh trade view beside the old one, so the window keeps its place. */
async function rerenderTradeWindow(dialog, root, view, handlers, state) {
  const holder = root.querySelector('.trade-menu-container');
  if (!holder) return;
  const context = prepareTradeView(view);
  holder.insertAdjacentHTML('afterend',
    await globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, context));
  holder.remove();
  wireTradeWindow(root.querySelector('.trade-menu-container'), context, {
    confirm: () => confirmTrade(dialog, root, handlers, state),
    cancel: () => dialog.close(),
    resume: handlers.resume
  });
}

/** Map the economy trade projection into the trade template. */
function prepareTradeView(view) {
  const isSteal = view.mode === TRADE_MODES.STEAL;
  const takeOnly = view.takeOnly === true;
  const container = view.target.kind === 'Object';
  const rows = (items, side) => items.map(item => Object.freeze({
    id: item.id,
    name: item.name,
    img: item.image,
    type: item.type,
    itemType: item.itemType,
    tab: item.tab,
    quantity: item.quantity,
    cost: item.cost,
    stealDc: item.stealDc,
    isEquipped: item.isEquipped,
    side
  }));
  return Object.freeze({
    isSteal,
    takeOnly,
    title: isSteal
      ? `Steal: ${view.source.name} → ${view.target.name}`
      : `Trade: ${view.source.name} ⇄ ${view.target.name}`,
    sourceActor: Object.freeze({ name: view.source.name, img: view.source.image, pixelArt: view.source.pixelArt }),
    targetActor: Object.freeze({ name: view.target.name, img: view.target.image, pixelArt: view.target.pixelArt }),
    sourceTabs: TRADE_TABS,
    targetTabs: container ? CONTAINER_TABS : TRADE_TABS,
    confirmLabel: isSteal ? 'Steal Items' : (container ? 'Confirm' : 'Complete Trade'),
    dropTooltip: getTooltip(SHEET_TOOLTIP_IDS.DROP_ITEM),
    sourceCanDrop: !isSteal && !takeOnly && view.source.owned === true,
    targetCanDrop: !isSteal && !container && view.target.owned === true,
    sourceTokenUuid: view.source.tokenUuid,
    targetTokenUuid: view.target.tokenUuid,
    sourceActorUuid: view.source.actorUuid,
    targetActorUuid: view.target.actorUuid,
    sourceItems: Object.freeze(isSteal || takeOnly ? [] : rows(view.source.items, 'source')),
    targetItems: Object.freeze(rows(view.target.items, 'target'))
  });
}

/** Read which rows are ticked on each side. */
function readTradeChoices(root) {
  const giveItemIds = [];
  const takeItemIds = [];
  for (const box of root.querySelectorAll('.trade-item-checkbox:checked')) {
    const id = String(box.dataset.itemId ?? '');
    if (!id) continue;
    if (box.dataset.side === 'source') giveItemIds.push(id);
    else takeItemIds.push(id);
  }
  return Object.freeze({ giveItemIds: Object.freeze(giveItemIds), takeItemIds: Object.freeze(takeItemIds) });
}

/** Calculate the selected theft rows’ combined difficulty for the live preview. */
function stealDifficultyOf(root) {
  let total = 0;
  for (const box of root.querySelectorAll('.trade-item-checkbox:checked')) {
    const row = box.closest('.trade-item-row');
    total += Number(row?.dataset.itemStealDc) || 0;
  }
  return total;
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */
function wireTradeWindow(root, context, { confirm, cancel, resume }) {
  for (const side of root.querySelectorAll('.trade-left-side, .trade-right-side')) wireTabs(side);
  const refreshDifficulty = stealDifficultyRefresh(root, context);
  const onPicked = () => {
    refreshDifficulty();
    playMenuSound(SOUND_IDS.UI_BLIP_1);
  };
  for (const row of root.querySelectorAll('.trade-item-row')) {
    row.addEventListener('click', event => {
      if (event.target?.closest?.('.trade-item-checkbox, .trade-item-drop')) return;
      event.preventDefault();
      if (event.target?.closest?.(ROW_INSPECT_SELECTOR)) {
        const actorUuid = row.dataset.side === 'source' ? context.sourceActorUuid : context.targetActorUuid;
        void openRowItemSheet(actorUuid, String(row.dataset.itemId ?? ''));
        return;
      }
      toggleRowSelection(row, onPicked);
    });
  }
  let dropPromptOpen = false;
  for (const button of root.querySelectorAll('.trade-item-drop')) {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (dropPromptOpen) return;
      dropPromptOpen = true;
      try {
        const row = button.closest('.trade-item-row');
        const tokenUuid = button.dataset.side === 'source' ? context.sourceTokenUuid : context.targetTokenUuid;
        const result = await runDropItemFlow({ tokenUuid, itemId: String(button.dataset.itemId ?? ''), resume });
        if (result?.ok) row?.remove();
      } finally {
        dropPromptOpen = false;
      }
    });
  }
  root.addEventListener('change', () => onPicked());
  root.querySelector('.trade-confirm-btn')?.addEventListener('click', () => { void confirm(); });
  root.querySelector('.trade-cancel-btn')?.addEventListener('click', () => { void cancel(); });
}

/** Tick or untick a row when it's clicked. An equipped item's row has a disabled box and can't be picked. */
function toggleRowSelection(row, onPicked) {
  const checkbox = row.querySelector('.trade-item-checkbox');
  if (!checkbox || checkbox.disabled) return false;
  checkbox.checked = !checkbox.checked;
  onPicked();
  return true;
}

/** Keep the live steal difficulty in step with the ticked rows, however they came to be ticked. */
function stealDifficultyRefresh(root, context) {
  if (!context.isSteal) return () => false;
  const display = root.querySelector('.steal-dc-value');
  return () => {
    if (display) display.textContent = String(stealDifficultyOf(root));
    return true;
  };
}

function wireTabs(side) {
  const buttons = [...side.querySelectorAll('.trade-tab-button')];
  const rows = [...side.querySelectorAll('.trade-item-row')];
  const show = key => {
    for (const button of buttons) button.classList.toggle('active', button.dataset.tab === key);
    for (const row of rows) row.hidden = key !== 'all' && row.dataset.tab !== key;
  };
  for (const button of buttons) {
    button.addEventListener('click', () => {
      show(button.dataset.tab);
      playMenuSound(SOUND_IDS.UI_BLIP_1);
    });
  }
  const opening = buttons.find(button => tabHoldsRows(rows, button.dataset.tab)) ?? buttons[0];
  if (opening) show(opening.dataset.tab);
}

/** A side opens on the first tab that actually holds something, so an empty Equipment never hides a full Pocket. */
function tabHoldsRows(rows, key) {
  return rows.some(row => key === 'all' || row.dataset.tab === key);
}

/* -------------------------------------------- */
/*  Row inspection                              */
/* -------------------------------------------- */

/** Open an inventory row's Item sheet above the menu it came from: the trade window or the vendor shop. */
export async function openRowItemSheet(actorUuid, itemId) {
  const actor = await resolveActor(String(actorUuid ?? ''));
  const item = actor?.items.get(String(itemId ?? ''));
  if (!item?.sheet) return false;
  await item.sheet.render(true);
  raiseSheetAbove(item.sheet, PINNED_SHEET_Z);
  return true;
}

/** Hold a rendered sheet above the menu it was opened from, without touching the application's own methods. */
function raiseSheetAbove(sheet, zIndex) {
  if (!sheet) return;
  if (sheet.position) sheet.position.zIndex = zIndex;
  if (sheet.element) sheet.element.style.zIndex = String(zIndex);
}

function playTradeSound(id) {
  playUiSound(id);
}
