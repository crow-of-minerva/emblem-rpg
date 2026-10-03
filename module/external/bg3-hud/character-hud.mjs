/** @layer external/bg3-hud */
import { BG3_HUD_NOTICES, bg3HudCellAddress } from '../../contracts/domains/bg3-hud.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import {
  clearViewOnlyHud,
  initializeEmblemBg3Core,
  onRenderedEmblemBg3Hud,
  restoreActingHudForToken,
  showGmHudForTokenHud,
  showViewOnlyHudForToken,
  viewOnlyHudShows,
  viewOnlyInspectionOpen,
  withGmLeftClickHudControlSuppressed
} from './core-runtime.mjs';
import { isInnateCharacterItem } from '../../game/character/inventory.mjs';
import { isDroppableItem } from '../../game/objects/rules.mjs';
import { emitBg3HudAction, showBg3EffectDescription } from './components.mjs';
import { bg3ItemLocked, hydrateBg3Cell, projectBg3Cell, projectBg3Tooltip } from './document-projection.mjs';
import {
  EmblemBg3AutoPopulate,
  EmblemBg3AutoSort,
  isBg3HotbarItem,
  refreshBg3HudGrids,
  resyncBg3HudState
} from './hotbar.mjs';
import { readSetting } from '../../foundry/adapters/services/host.mjs';
import { escapeHtml } from '../../lib/dom/html.mjs';
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';

const reportedUnconfiguredPorts = new Set();
/**
 * Record a diagnostic once if a cell is drawn, clicked or given a tooltip before init/system.mjs has called
 * configureBg3HudAdapter. It records rather than throws, because these run inside Core's click handling and cell
 * rendering.
 */
function warnUnconfiguredAdapterPort(port) {
  if (reportedUnconfiguredPorts.has(port)) return;
  reportedUnconfiguredPorts.add(port);
  reportFoundryError(import.meta.url,
    new Error(`external/bg3-hud/character-hud.mjs: ${port} was used before init/system.mjs called `
      + 'configureBg3HudAdapter.'),
    'configureBg3HudAdapter');
}
const fallbackPresentation = Object.freeze({
  decorateCell: async () => { warnUnconfiguredAdapterPort('presentation'); },
  renderTooltip: async () => { warnUnconfiguredAdapterPort('presentation'); return null; },
  updateDepletion: () => warnUnconfiguredAdapterPort('presentation'),
  notify: () => warnUnconfiguredAdapterPort('presentation')
});
let presentation = fallbackPresentation;
const fallbackActivation = Object.freeze({
  activateItem: async () => { warnUnconfiguredAdapterPort('activation'); return false; }
});
let activation = fallbackActivation;
const HOTBAR_KEY_COOLDOWN_MS = 350;
let lastHotbarKeyAt = 0;

/* -------------------------------------------- */
/*  BG3 HUD adapter                             */
/* -------------------------------------------- */
/**
 * The system adapter BG3 HUD Core asks about Emblem units: which actors get a HUD, what each cell shows and does,
 * the portrait's stat rows, and a cell's context menu. Registered by onBg3HudReady.
 */
export class EmblemBg3Adapter {
  constructor() {
    this.MODULE_ID = SYSTEM_ID;
    this.systemId = SYSTEM_ID;
    this.name = 'Emblem RPG Adapter';
    this.autoSort = new EmblemBg3AutoSort();
    this.autoPopulate = new EmblemBg3AutoPopulate();
    this.autoPopulate.setAutoSort(this.autoSort);
    this.tooltipRenderer = async data => presentation.renderTooltip(await projectBg3Tooltip(data));
  }

  isCompatible(actor) {
    if (actor?.type !== 'Character') return false;
    if (game.user.isGM && !ui.BG3HUD_APP) {
      return actor.system?.turn?.movementPlanning === true;
    }
    return true;
  }
  isPlayerCharacter(actor) { return actor?.type === 'Character' && actor.hasPlayerOwner; }

  /** What BG3 HUD prints on each cell: item uses if this client chose them, never item names. */
  getDisplaySettings() {
    return { showItemUses: readSetting('bg3ShowItemUses', true) };
  }

  getPortraitDataDefaults() {
    return [
      { path: 'system.stats.def.total', icon: 'fas fa-shield-alt', color: '#4a90d9' },
      { path: 'system.stats.mov.total', icon: 'fas fa-running', color: '#2ecc71' },
      { path: 'system.stats.res.total', icon: 'fas fa-magic', color: '#9b59b6' },
      { path: 'system.stats.spd.total', icon: 'fas fa-bolt', color: '#f1c40f' },
      { path: '', icon: '', color: '#ffffff' },
      { path: '', icon: '', color: '#ffffff' }
    ];
  }

  async transformItemToCellData(item) { return projectBg3Cell(item); }
  async decorateCellElement(element, cellData) {
    const cell = await hydrateBg3Cell(cellData);
    await presentation.decorateCell(element, cell?.uuid ? { ...cell, _emblemLocked: bg3ItemLocked(cell.uuid) } : cell);
  }
  updateCellDepletionStates() { presentation.updateDepletion(ui.BG3HUD_APP, bg3ItemLocked); }
  shouldAutoAddItem(item) { return isBg3HotbarItem(item); }
  resolveHotbarMembershipOnItemUpdate(item) { return isBg3HotbarItem(item) ? 'add' : 'remove'; }

  resolveActorUpdatePlan(changes) {
    const system = changes?.system ?? {};
    return {
      health: Boolean(system.resources?.hp || system.stats?.hpMax),
      attributes: Boolean(system.stats || system.combat || system.progression || system.faction),
      items: Array.isArray(changes?.items),
      depletion: Boolean(system.resources || system.turn),
      lateDepletion: true
    };
  }

  /** The cell context menu's Drop Item entry, offered when the user owns the item and it can be dropped. */
  async getCellMenuItems(cell) {
    const uuid = String(cell?.data?.uuid ?? '');
    const item = uuid ? await fromUuid(uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'item'); return null; }) : null;
    const actor = item?.parent;
    if (!item || actor?.documentName !== 'Actor' || actor.isOwner !== true) return [];
    if (!isDroppableItem({ type: item.type, innate: isInnateCharacterItem({ innateGrant: Boolean(item.getFlag?.(SYSTEM_ID, 'innateGrant')) }) })) return [];
    return [{
      label: 'Drop Item',
      icon: 'fas fa-hand',
      onClick: () => emitBg3HudAction('drop-item', ui.BG3HUD_APP, { itemId: String(item.id) })
    }];
  }

  /**
   * Activate the item in a clicked cell, or one picked by hotkey (activateBg3HotbarSlot), through the activation
   * function init/system.mjs supplies. Does nothing while a trade window is open, and shows a notice while the HUD is
   * inspecting a unit.
   */
  async onCellClick(cell, event) {
    event?.preventDefault?.();
    if (cell?.data?.type !== 'Item' || !cell.data.uuid) return false;
    if (isTradeWindowOpen()) return false;
    if (viewOnlyInspectionOpen()) {
      presentation.notify(BG3_HUD_NOTICES.INSPECTING_UNIT);
      return false;
    }
    return activation.activateItem(String(cell.data.uuid), bg3HudCellAddress(cell));
  }

  /**
   * Clear the shown unit's hotbar and rebuild it from its current items, after a confirm dialog. Only a GM or the
   * unit's owner can do it. Called by the Resync button that patchBg3ControlRow (core-runtime.mjs) adds to Core's
   * control row.
   */
  async resyncHotbar(hotbarApp) {
    const actor = hotbarApp?.currentActor;
    if (!actor) {
      presentation.notify(BG3_HUD_NOTICES.RESYNC_SELECT_TOKEN);
      return false;
    }
    const token = hotbarApp.currentToken;
    if (!isBg3LocalUserGm() && !(token?.isOwner ?? actor.isOwner)) {
      presentation.notify(BG3_HUD_NOTICES.RESYNC_NOT_OWNED);
      return false;
    }
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Resync Hotbar' },
      content: `<p>Purge ${escapeHtml(actor.name)}'s hotbar and rebuild it from their current items?</p>`
    });
    if (!confirmed) return false;
    await resyncBg3HudState(actor, hotbarApp.persistenceManager);
    await refreshBg3HudGrids(hotbarApp);
    return true;
  }
}

/** Whether a trade, loot or steal window is open, found by the trade app's window class. */
function isTradeWindowOpen() {
  return Boolean(globalThis.document?.querySelector?.('.window-trade-menu'));
}

/* -------------------------------------------- */
/*  Integration lifecycle                       */
/* -------------------------------------------- */
/**
 * Hand the adapter its presentation functions (cell decoration, tooltips, depletion, notices) and its item
 * activation. init/system.mjs calls it, because external/ may not import presentation/ or ui/.
 */
export function configureBg3HudAdapter(configuration = {}) {
  presentation = Object.freeze({ ...fallbackPresentation, ...(configuration.presentation ?? {}) });
  activation = Object.freeze({ ...fallbackActivation, ...(configuration.activation ?? {}) });
  lastHotbarKeyAt = 0;
}

/* -------------------------------------------- */
/*  Key activation                              */
/* -------------------------------------------- */
/**
 * Activate one shown BG3 hotbar slot the same way a click does. Called by the hotbar keybindings
 * (ui/controls/keybindings.mjs). A press within 350 ms of the last one is swallowed.
 * @param {number} gridIndex Zero-based BG3 grid index.
 * @param {number} slotIndex Zero-based visible cell index.
 * @returns {boolean} Whether this key press belongs to the displayed hotbar.
 */
export function activateBg3HotbarSlot(gridIndex, slotIndex) {
  const app = ui.BG3HUD_APP;
  if (!app?.rendered || !app.currentActor || !hasControlledCharacter()) return false;

  const now = Date.now();
  if (now - lastHotbarKeyAt < HOTBAR_KEY_COOLDOWN_MS) return true;
  lastHotbarKeyAt = now;

  // A missing or empty slot on the first grid still claims the plain number key, so Foundry's own macro bar
  // binding for that key doesn't run.
  const grid = app.components?.hotbar?.gridContainers?.[gridIndex];
  if (!grid) return gridIndex === 0;
  const cell = grid.getCellByIndex?.(slotIndex) ?? grid.cells?.[slotIndex];
  if (!cell?.data) return gridIndex === 0;
  if (typeof app.interactionCoordinator?.handleClick !== 'function') return false;

  const dispatch = app.interactionCoordinator.handleClick(cell, createHotbarKeyEvent());
  void Promise.resolve(dispatch).catch(error => {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | BG3 hotbar key activation failed');
  });
  return true;
}

/** Handle Core's bg3HudReady hook: register the adapter at once, then start initializeEmblemBg3Core. */
export function onBg3HudReady(api) {
  if (globalThis.game?.system?.id !== SYSTEM_ID) return;
  const adapter = new EmblemBg3Adapter();
  api.registerAdapter(adapter);
  void initializeEmblemBg3Core(api, adapter);
}

/**
 * Handle the renderBG3Hotbar hook, which Foundry fires when Core's HUD app renders. init/hooks.mjs passes the app,
 * its HTML and a hook API wrapping Hooks.on and Hooks.off.
 */
export function onRenderBg3Hotbar(appOrHookApi, html = null, maybeHookApi = null) {
  const legacyCall = !appOrHookApi?.element && appOrHookApi?.on && appOrHookApi?.off;
  const app = legacyCall ? ui.BG3HUD_APP : appOrHookApi;
  const hookApi = legacyCall ? appOrHookApi : maybeHookApi;
  onRenderedEmblemBg3Hud(app, html, hookApi);
}

/** Refresh Core display settings after a registered client setting changes. */
export function refreshBg3DisplaySettings() {
  ui.BG3HUD_APP?.updateDisplaySettings?.();
}

export {
  clearViewOnlyHud,
  restoreActingHudForToken,
  showGmHudForTokenHud,
  showViewOnlyHudForToken,
  viewOnlyHudShows,
  withGmLeftClickHudControlSuppressed
};

function hasControlledCharacter() {
  return (globalThis.canvas?.tokens?.controlled ?? [])
    .filter(token => token?.actor?.type === 'Character').length === 1;
}

function createHotbarKeyEvent() {
  if (typeof globalThis.MouseEvent === 'function') return new MouseEvent('click');
  return { type: 'click', preventDefault() {} };
}

/* -------------------------------------------- */
/*  BG3 HUD interactions                        */
/* -------------------------------------------- */
export async function openBg3EffectDescription(effectUuid) {
  const effect = await fromUuid(effectUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'effect'); return null; });
  if (effect) await showBg3EffectDescription(effect);
}

/** Open the sheet of whichever document a modifier row points at. */
export async function openBg3DocumentSheet(uuid) {
  const document = await fromUuid(String(uuid ?? '')).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'document'); return null; });
  document?.sheet?.render?.(true);
}

/** Fill the shown unit's empty HUD cells (auto-populate in hotbar.mjs). Returns the notice to show, or null. */
export async function populateBg3Hud(app) {
  const actor = app?.currentActor;
  if (!actor) return BG3_HUD_NOTICES.NO_ACTOR;
  const persistenceManager = app.persistenceManager;
  if (!persistenceManager) return BG3_HUD_NOTICES.PERSISTENCE_UNAVAILABLE;
  const adapter = ui.BG3HOTBAR?.registry?.activeAdapter;
  if (!adapter?.autoPopulate?.populateHotbar) return BG3_HUD_NOTICES.AUTO_POPULATE_UNAVAILABLE;
  const added = await adapter.autoPopulate.populateHotbar(actor, persistenceManager);
  if (!added) return BG3_HUD_NOTICES.HOTBAR_COMPLETE;
  await refreshBg3HudGrids(app);
  return null;
}

export { emitBg3HudAction };

export function isBg3LocalUserGm() {
  return game.user.isGM;
}

export async function showBg3InstantTooltip(cell, uuid) {
  const manager = ui.BG3HOTBAR?.tooltipManager;
  if (!uuid || !manager || manager.currentTarget === cell || manager.pendingTarget === cell) return;
  clearTimeout(manager.hoverTimeout);
  manager.hoverTimeout = null;
  manager.pendingTarget = null;
  if (manager.pinnedTooltipsByUuid?.has?.(uuid) || document.body.classList.contains('dragging-active')) return;
  const document = await fromUuid(uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'document'); return null; });
  if (document && cell.matches(':hover')) {
    await manager.showRichTooltip(cell, document, game.system.id, {}, uuid);
  }
}
