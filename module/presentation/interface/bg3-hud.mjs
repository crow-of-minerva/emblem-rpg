/** @layer presentation/interface */
import { DAMAGE_TYPES } from '../../contracts/domains/damage.mjs';
import {
  BG3_HUD_INTENTS,
  BG3_HUD_NOTICES,
  bg3HudCellAddress,
  bg3HudKind,
  bg3HudTransition
} from '../../contracts/domains/bg3-hud.mjs';
import { SYSTEM_ID , recordDiagnostic } from '../../contracts/protocol.mjs';
import { capitalize, escapeHtml, sanitizeHtml } from '../../lib/dom/html.mjs';
import { cachedTrimmedImage, trimContainerSprites } from '../../lib/dom/image-trim.mjs';
import { targetingGridColor } from '../canvas/cell-overlays.mjs';
import { NOTIFICATION_IDS, NotificationService } from './notifications.mjs';

/* -------------------------------------------- */
/*  Render composition                          */
/* -------------------------------------------- */
const GRID_LABELS = Object.freeze([{ index: 0, prefix: '' }, { index: 1, prefix: 'Alt+' }, { index: 2, prefix: 'Ctrl+' }]);
const observerByApp = new WeakMap();
let modifierTray = null;
let modifierTrayDismissBound = false;
let activeCellFacts = null;
let flightFacts = null;
let turnFacts = null;
const NOTICE_IDS = Object.freeze({
  [BG3_HUD_NOTICES.NO_ACTOR]: NOTIFICATION_IDS.BG3_NO_ACTOR,
  [BG3_HUD_NOTICES.PERSISTENCE_UNAVAILABLE]: NOTIFICATION_IDS.BG3_PERSISTENCE_UNAVAILABLE,
  [BG3_HUD_NOTICES.AUTO_POPULATE_UNAVAILABLE]: NOTIFICATION_IDS.BG3_AUTO_POPULATE_UNAVAILABLE,
  [BG3_HUD_NOTICES.HOTBAR_COMPLETE]: NOTIFICATION_IDS.BG3_HOTBAR_COMPLETE,
  [BG3_HUD_NOTICES.RESYNC_SELECT_TOKEN]: NOTIFICATION_IDS.BG3_RESYNC_SELECT_TOKEN,
  [BG3_HUD_NOTICES.RESYNC_NOT_OWNED]: NOTIFICATION_IDS.BG3_RESYNC_NOT_OWNED,
  [BG3_HUD_NOTICES.INSPECTING_UNIT]: NOTIFICATION_IDS.BG3_INSPECTING_UNIT
});
const reportedUnconfiguredPorts = new Set();
/**
 * Report once per session that configureBg3HudPresentation was never called, instead of leaving every hotbar
 * button and GM/player check silently dead. It can't record a diagnostic: `presentation/` may not import the
 * `foundry/` diagnostics adapter, and `interactions.diagnostics` only exists after the configure call. So it writes
 * to the console and shows an error notification. It never throws, because the fallbacks below run inside BG3
 * Core's own refresh and click handlers, and this system can't tell how Core copes with a throw there.
 */
function warnUnconfiguredInteractions() {
  if (reportedUnconfiguredPorts.has('interactions')) return;
  reportedUnconfiguredPorts.add('interactions');
  const message = 'presentation/interface/bg3-hud.mjs: interactions was used before init/system.mjs called '
    + 'configureBg3HudPresentation.';
  globalThis.console?.error?.(message);
  globalThis.ui?.notifications?.error?.(message);
}
const fallbackInteractions = Object.freeze({
  emitAction: () => warnUnconfiguredInteractions(),
  isLocalGm: () => { warnUnconfiguredInteractions(); return false; },
  openEffect: async () => warnUnconfiguredInteractions(),
  openSheet: async () => warnUnconfiguredInteractions(),
  populateHud: async () => warnUnconfiguredInteractions(),
  showInstantTooltip: async () => warnUnconfiguredInteractions()
});
let interactions = fallbackInteractions;

/**
 * init/system.mjs calls this once with the external/bg3-hud functions this file needs (emitting an action button,
 * the GM check, opening sheets and effects, populating the hotbar, the instant tooltip) and diagnostics.
 * `presentation/` may not import `external/` or read live documents, so they come in here.
 */
export function configureBg3HudPresentation(configuration = {}) {
  interactions = Object.freeze({ ...fallbackInteractions, ...configuration });
}

/** Resolve a BG3 adapter notice through the notification catalog. */
export function notifyBg3HudNotice(notice) {
  const id = NOTICE_IDS[notice];
  if (id) new NotificationService({ diagnostics: interactions.diagnostics }).show(id);
  return Boolean(id);
}

/**
 * Add the Emblem parts of the HUD after BG3 Core renders or refreshes it: the stats bar, action buttons, the
 * counterattack toggle, key labels, cell markers, read-only guards and instant tooltips. Called through the
 * `decorateHud` function init/system.mjs hands to external/bg3-hud/core-runtime.mjs, with the view
 * projectBg3HudView builds.
 */
export function decorateEmblemBg3Hud(app, html = null, view = { actor: null }) {
  const root = hudRoot(app, html);
  if (!root) return;
  activeCellFacts = view.activeItem ?? null;
  flightFacts = view.flight ?? null;
  turnFacts = view.turn ?? null;
  cleanupCells(root);
  const readOnly = syncReadOnly(root, view.readOnly === true);
  stampHudKind(root, app);
  enforceBg3HudVisibility(app);
  const multiSelect = view.multiSelect === true;
  injectStats(root, multiSelect ? null : view.actor);
  injectActionButtons(root, app, readOnly || multiSelect || activeCellFacts !== null);
  if (!multiSelect) injectPopulateButton(root, app, readOnly);
  injectCounterMode(root, app, view.counterMode ?? null);
  stampKeyLabels(app);
  pixelateHudSprites(root);
  decorateAllCells(app);
  installInstantTooltips(root);
  installMutationRefresh(root, app);
}

/**
 * Show, hide or fade the HUD when what it should show changes: nothing, a unit's hotbar, or the GM bar.
 * bg3HudTransition (contracts/domains/bg3-hud.mjs) picks the transition. Runs after each decoration, from this
 * file's mutation observer, and from core-runtime.mjs when a token is selected or deselected.
 */
export function enforceBg3HudVisibility(app) {
  const root = hudRoot(app);
  const container = root?.matches?.('#bg3-hotbar-container') ? root : root?.querySelector?.('#bg3-hotbar-container');
  if (!root || !container) return;
  clearLegacyNoFadeStyles(app, root, container);
  const nextKind = hudKindFor(app);
  const nextTokenId = app?.currentToken?.id ?? null;
  const previousKind = app?._emblemHudKind ?? null;
  const previousTokenId = app?._emblemHudTokenId ?? null;
  if (app?._emblemRefreshInFlight) {
    app._emblemHudKind = nextKind;
    app._emblemHudTokenId = nextTokenId;
    return;
  }
  app._emblemHudKind = nextKind;
  app._emblemHudTokenId = nextTokenId;
  app._emblemFadeOutToken = (app._emblemFadeOutToken ?? 0) + 1;

  const transition = bg3HudTransition({ kind: previousKind ?? 'hidden', tokenId: previousTokenId },
    { kind: nextKind, tokenId: nextTokenId });
  if (transition === 'settle' || transition === 'rebuild') {
    settleHudKind(root, nextKind);
    return;
  }
  if (transition === 'fade-in') {
    root.classList.add('emblem-fade-active', 'bg3-hud-hidden');
    root.classList.remove('bg3-hud-visible', 'bg3-hud-fading-out', 'bg3-hud-building');
    root.style.display = '';
    void root.offsetWidth;
    root.classList.remove('bg3-hud-hidden');
    root.classList.add('bg3-hud-visible');
    return;
  }
  if (transition === 'fade-out') {
    root.classList.add('emblem-fade-active', 'bg3-hud-fading-out');
    root.classList.remove('bg3-hud-visible', 'bg3-hud-hidden', 'bg3-hud-building');
    const fadeToken = app._emblemFadeOutToken;
    if (app._emblemVisibilityTimer) clearTimeout(app._emblemVisibilityTimer);
    app._emblemVisibilityTimer = setTimeout(() => {
      if (fadeToken === app._emblemFadeOutToken) settleHudKind(root, nextKind);
    }, 400);
    return;
  }
  settleHudKind(root, nextKind);
}

function hudKindFor(app) {
  return bg3HudKind(app, interactions.isLocalGm() === true);
}

function settleHudKind(root, kind) {
  root.classList.remove('emblem-fade-active', 'emblem-instant-show', 'bg3-hud-building', 'bg3-hud-fading-out');
  if (kind === 'hidden') {
    root.classList.remove('bg3-hud-visible');
    root.style.display = 'none';
    return;
  }
  root.classList.remove('bg3-hud-hidden');
  root.classList.add('bg3-hud-visible');
  root.style.display = '';
}

function clearLegacyNoFadeStyles(app, root, container) {
  if (app._emblemLegacyNoFadeCleared) return;
  app._emblemLegacyNoFadeCleared = true;
  root.style.removeProperty?.('opacity');
  root.style.removeProperty?.('transition');
  container.style.removeProperty?.('opacity');
  container.style.removeProperty?.('transition-property');
  container.style.removeProperty?.('transition-duration');
}

/** Restore equipped, active-art, and depletion markers after Core replaces a cell. */
export async function decorateBg3Cell(element, cellData, activeItem = undefined, cellId = '') {
  if (!element || !cellData) return;
  const facts = cellData;
  const equipped = facts._emblemIsWielded || facts._emblemIsWorn || facts._emblemIsEquipped;
  element.dataset.itemType = facts._emblemDocType ?? '';
  element.dataset.emblemItemType = facts._emblemItemType ?? '';
  element.dataset.actionType = facts._emblemActionType ?? '';
  element.dataset.weaponReq = facts._emblemWeaponReq ?? '';
  element.classList.toggle('emblem-equipped', Boolean(equipped));
  const isActive = activeItem === undefined
    ? facts._emblemIsActiveItem === true
    : activeItem !== null && activeItem.uuid === facts.uuid
      && (!activeItem.cellId || activeItem.cellId === cellId);
  const colorName = activeItem === undefined ? facts._emblemActiveColorName : activeItem?.colorName ?? null;
  element.classList.toggle('emblem-active-item', isActive);
  if (isActive && typeof colorName === 'string') {
    element.style.setProperty?.('--emblem-active-color',
      `#${targetingGridColor(colorName).toString(16).padStart(6, '0')}`);
  } else {
    element.style.removeProperty?.('--emblem-active-color');
  }
  element.classList.toggle('emblem-active-weapon-art', facts._emblemIsActiveWepArt === true);
  element.classList.toggle('emblem-depleted', facts.depleted === true || facts.uses?.value === 0);
  element.dataset.equipped = equipped ? 'true' : 'false';
  element.querySelectorAll('img, video').forEach(image => image.style.imageRendering = 'pixelated');
}

/** Update depletion without requesting a full HUD rebuild. */
export function updateBg3CellDepletionStates(app) {
  for (const cell of allGridCells(app)) {
    const uses = cell?.data?.uses;
    const depleted = Boolean(cell?.data?.depleted || (uses?.max > 0 && uses.value <= 0));
    cell?.element?.classList?.toggle('emblem-depleted', depleted);
    cell?.element?.querySelector?.('.hotbar-item-uses')?.classList?.toggle('depleted', depleted);
  }
}

/* -------------------------------------------- */
/*  Rich tooltips                               */
/* -------------------------------------------- */
/**
 * Build the BG3 hotbar tooltip for an Item, Macro or status effect. The adapter in external/bg3-hud/character-hud.mjs
 * passes a copy of the document made by projectBg3Tooltip.
 */
export async function renderEmblemBg3Tooltip(data) {
  if (!data) return null;
  if (data.documentName === 'Macro') return tooltip(`<div class="emblem-tooltip emblem-tooltip--macro"><div class="emblem-tooltip-name">${escapeHtml(data.name || 'Macro')}</div></div>`, 'DOWN');
  if (data.documentName === 'ActiveEffect') {
    const duration = data.flags?.[SYSTEM_ID]?.duration;
    let html = `<div class="emblem-tooltip"><div class="emblem-tooltip-name">${escapeHtml(data.name || data.label || 'Effect')}</div>`;
    if (data.description) html += `<div class="emblem-tooltip-desc">${sanitizeHtml(data.description)}</div>`;
    if (duration !== undefined && duration !== null) {
      html += `<div class="emblem-tooltip-duration"><i class="fas fa-hourglass-half"></i> ${Number(duration)} phase${Number(duration) === 1 ? '' : 's'}</div>`;
    }
    return tooltip(`${html}</div>`, 'UP');
  }
  if (data.documentName !== 'Item') return null;

  const system = data.system ?? {};
  const subtype = system.itemType;
  let html = `<div class="emblem-tooltip"><div class="emblem-tooltip-name">${escapeHtml(data.name || 'Item')}</div>`;
  if (data.type === 'Ability' && subtype === 'Weapon Art' && system.wepArtData?.cost !== undefined) {
    html += `<div class="emblem-tooltip-art-cost"><i class="fas fa-hammer"></i> Durability Cost: ${Number(system.wepArtData.cost) || 0}</div>`;
  }
  if (system.description) html += `<div class="emblem-tooltip-desc">${sanitizeHtml(system.description)}</div>`;
  if ((data.type === 'Equipment' && ['Weapon', 'Staff', 'Staff (U)'].includes(subtype))
      || (data.type === 'Spell' && subtype === 'Attack')) {
    const weapon = system.weapon ?? {};
    html += statsMarkup([['Atk', weapon.atk], ['Brk', weapon.brk], ['Acc', weapon.acc], ['Crit', weapon.crit]]);
    html += damageTypeMarkup(weapon.dmgTypes);
  }
  if (data.type === 'Equipment' && subtype === 'Armor') {
    const armor = system.armor ?? {};
    html += statsMarkup([['Def', armor.def], ['Res', armor.res], ['Stn', armor.stn]]);
    html += damageTypeMarkup(armor.prots, 'protected');
    html += damageTypeMarkup(armor.vulns, 'vulnerable');
  }
  if ((data.type === 'Ability' && ['Active', 'Weapon Art'].includes(subtype))
      || (data.type === 'Spell' && subtype === 'Utility') || data.type === 'Consumable') {
    const action = String(system.actionType ?? '');
    if (action) {
      const bonus = action === 'Bonus Action';
      const style = bonus ? 'action-bonus' : action === 'Standard Action' ? 'action-standard' : 'action-default';
      html += `<div class="emblem-tooltip-action ${style}"><i class="fas ${bonus ? 'fa-triangle' : 'fa-circle'}"></i> ${escapeHtml(action)}</div>`;
    }
  }
  return tooltip(`${html}</div>`, 'UP');
}

function tooltip(content, direction) {
  return { content, classes: ['emblem-tooltip-wrapper'], direction };
}

function statsMarkup(values) {
  return `<div class="emblem-tooltip-stats">${values.map(([label, value]) => `<span class="emblem-tooltip-stat"><b>${label}</b> ${escapeHtml(value ?? 0)}</span>`).join('')}</div>`;
}

function damageTypeMarkup(source, kind = '') {
  const active = DAMAGE_TYPES.filter(type => source?.[type]);
  if (!active.length) return '';
  const label = kind ? `<span class="emblem-tooltip-dmg-label emblem-tooltip-dmg-label--${kind}"><i class="fas ${kind === 'protected' ? 'fa-shield-alt' : 'fa-heart-broken'}"></i></span>` : '';
  return `<div class="emblem-tooltip-dmg">${label}${active.map(type => `<img src="systems/${SYSTEM_ID}/assets/ui/dmg-types/${type}.png" alt="${type}" data-tooltip="${escapeHtml(kind ? `${kind}: ${capitalize(type)}` : capitalize(type))}" class="emblem-tooltip-dmg-icon emblem-pixel-art">`).join('')}</div>`;
}

/* -------------------------------------------- */
/*  Stats and controls                          */
/* -------------------------------------------- */
const STATS = Object.freeze([
  ['atk', 'Atk', 'stats.atk.total'], ['brk', 'Brk', 'stats.brk.total'], ['spd', 'Spd', 'stats.spd.total'],
  ['acc', 'Acc', 'stats.acc.total'], ['crit', 'Crit', 'stats.crit.total'], ['eva', 'Eva', 'stats.eva.total'],
  ['def', 'Def', 'stats.def.total'], ['res', 'Res', 'stats.res.total']
]);
function injectStats(root, actor) {
  const container = root.querySelector('.bg3-hud-region-center .bg3-hotbar-container');
  if (!container) return;
  let bar = container.querySelector(':scope > .emblem-stats-bar');
  if (!actor) {
    if (modifierTray?.bar === bar) closeModifierTray();
    bar?.remove();
    return;
  }
  bar ??= document.createElement('div');
  bar.className = 'emblem-stats-bar';
  if (!bar.querySelector('.emblem-stat-cell')) {
    bar.innerHTML = `<div class="emblem-stats-row">${STATS.map(([key, label]) =>
      `<div class="emblem-stat-cell" data-stat="${key}"><span class="emblem-stat-label">${label}</span>`
      + '<span class="emblem-stat-value">--</span></div>').join('')}</div>`;
  }
  if (bar.parentElement !== container) container.insertBefore(bar, container.querySelector(':scope > .bg3-passives-container') ?? container.firstChild);
  updateStats(bar, actor);
}

function updateStats(bar, actor) {
  const sources = {};
  for (const [key, label, path] of STATS) {
    const cell = bar.querySelector(`.emblem-stat-cell[data-stat="${key}"]`);
    const rows = actor.modifierRows?.[key] ?? [];
    const measured = actor.modifierDeltas?.[key];
    const delta = typeof measured === 'number' ? measured : rows.reduce((sum, row) => sum + row.value, 0);
    if (rows.length) sources[key] = { label, rows };
    cell?.classList.toggle('emblem-stat-buffed', delta > 0);
    cell?.classList.toggle('emblem-stat-debuffed', delta < 0);
    cell?.classList.toggle('emblem-stat-clickable', rows.length > 0);
    if (!rows.length) cell?.classList.remove('emblem-stat-open');
    const value = cell?.querySelector('.emblem-stat-value');
    if (value) value.textContent = String(readPath(actor.system, path) ?? '--');
    cell?.removeAttribute('data-tooltip');
  }
  bar._emblemStatSources = sources;
  if (!bar._emblemStatTrayWired) {
    bar.addEventListener('click', event => {
      const cell = event.target.closest?.('.emblem-stat-cell');
      if (!cell || !bar.contains(cell)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleModifierTray(cell, bar._emblemStatSources?.[cell.dataset.stat]);
    });
    bar._emblemStatTrayWired = true;
  }
  refreshModifierTray(bar, sources);
}

/* -------------------------------------------- */
/*  Modifier tray                               */
/* -------------------------------------------- */
function toggleModifierTray(cell, entry) {
  const key = cell?.dataset?.stat;
  const wasOpen = modifierTray?.key === key && modifierTray?.bar === cell?.closest?.('.emblem-stats-bar');
  closeModifierTray();
  if (wasOpen || !entry?.rows?.length || !cell?.isConnected) return;
  const bar = cell.closest('.emblem-stats-bar');
  if (!bar) return;
  const tray = document.createElement('div');
  tray.className = 'emblem-mod-tray';
  tray.innerHTML = modifierTrayMarkup(entry);
  tray.addEventListener('click', onModifierTrayClick);
  bar.append(tray);
  trimContainerSprites(tray);
  modifierTray = { key, bar, cell, element: tray };
  cell.classList.add('emblem-stat-open');
  positionModifierTray();
  bindModifierTrayDismiss();
}

function refreshModifierTray(bar, sources) {
  if (!modifierTray) return;
  if (modifierTray.bar !== bar) { closeModifierTray(); return; }
  const entry = sources?.[modifierTray.key];
  const cell = bar.querySelector(`.emblem-stat-cell[data-stat="${modifierTray.key}"]`);
  if (!entry?.rows?.length || !cell) { closeModifierTray(); return; }
  modifierTray.cell = cell;
  modifierTray.element.innerHTML = modifierTrayMarkup(entry);
  trimContainerSprites(modifierTray.element);
  cell.classList.add('emblem-stat-open');
  positionModifierTray();
}

function closeModifierTray() {
  modifierTray?.element?.remove();
  modifierTray?.bar?.querySelectorAll?.('.emblem-stat-open')?.forEach(cell => cell.classList.remove('emblem-stat-open'));
  modifierTray = null;
  if (modifierTrayDismissBound) {
    document.removeEventListener('pointerdown', dismissModifierTray, true);
    document.removeEventListener('keydown', dismissModifierTray, true);
    modifierTrayDismissBound = false;
  }
}

function modifierTrayMarkup(entry) {
  return '<div class="emblem-mod-tray-head">Active Modifiers</div><ul class="emblem-mod-tray-list">'
    + entry.rows.map(modifierRowMarkup).join('')
    + '</ul>';
}

function modifierRowMarkup(row) {
  const value = `<span class="emblem-mod-tray-value ${row.value > 0 ? 'is-up' : 'is-down'}">`
    + `${row.type === 'terrain' ? `(${signed(row.value)})` : `${row.via ? `${escapeHtml(row.via)} ` : ''}${signed(row.value)}`}</span>`;
  if (row.type === 'terrain') {
    return '<li class="emblem-mod-tray-row"><i class="fas fa-mountain-sun emblem-mod-tray-glyph"></i>'
      + `<span class="emblem-mod-tray-name">${escapeHtml(row.source)}</span>${value}</li>`;
  }
  if (row.type === 'aura') return auraRowMarkup(row, value);
  const icon = `<img class="emblem-mod-tray-sprite emblem-pixel-art" src="${escapeHtml(row.icon)}"`
    + ` alt="${escapeHtml(row.source)}" data-tooltip="${escapeHtml(row.source)}">`;
  const name = row.uuid
    ? `<span class="emblem-mod-tray-name is-link" data-effect-uuid="${escapeHtml(row.uuid)}">${escapeHtml(row.source)}</span>`
    : `<span class="emblem-mod-tray-name">${escapeHtml(row.source)}</span>`;
  return `<li class="emblem-mod-tray-row">${icon}<span class="emblem-mod-tray-sep">:</span>${name}${value}</li>`;
}

function auraRowMarkup(row, value) {
  const source = cachedTrimmedImage(row.icon) ?? row.icon;
  const linked = Boolean(row.actorUuid);
  const sprite = `<img class="emblem-mod-tray-sprite emblem-pixel-art${linked ? ' is-link' : ''}"`
    + (linked ? ` data-actor-uuid="${escapeHtml(row.actorUuid)}"` : '')
    + ` src="${escapeHtml(source)}" data-sprite-src="${escapeHtml(row.icon)}"`
    + ` alt="${escapeHtml(row.actorName)}" data-tooltip="${escapeHtml(row.actorName)}">`;
  const name = row.uuid
    ? `<span class="emblem-mod-tray-name is-link" data-item-uuid="${escapeHtml(row.uuid)}">${escapeHtml(row.source)}</span>`
    : `<span class="emblem-mod-tray-name">${escapeHtml(row.source)}</span>`;
  return `<li class="emblem-mod-tray-row">${sprite}<span class="emblem-mod-tray-sep">:</span>${name}${value}</li>`;
}

async function onModifierTrayClick(event) {
  const effect = event.target.closest?.('[data-effect-uuid]');
  if (effect) {
    event.preventDefault();
    event.stopPropagation();
    await interactions.openEffect(effect.dataset.effectUuid);
    return;
  }
  // The aura's sprite opens the unit that emits it, and its name opens the emitting Item.
  const sheet = event.target.closest?.('[data-actor-uuid]') ?? event.target.closest?.('[data-item-uuid]');
  if (!sheet) return;
  event.preventDefault();
  event.stopPropagation();
  await interactions.openSheet(sheet.dataset.actorUuid ?? sheet.dataset.itemUuid);
}

function positionModifierTray() {
  const { bar, cell, element } = modifierTray ?? {};
  if (!bar || !cell?.isConnected || !element) return;
  const barRect = bar.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const width = element.offsetWidth;
  const left = Math.max(8, Math.min(cellRect.left + cellRect.width / 2 - width / 2, window.innerWidth - width - 8));
  element.style.left = `${left - barRect.left}px`;
  element.style.bottom = `${barRect.height + 8}px`;
}

function bindModifierTrayDismiss() {
  if (modifierTrayDismissBound) return;
  document.addEventListener('pointerdown', dismissModifierTray, true);
  document.addEventListener('keydown', dismissModifierTray, true);
  modifierTrayDismissBound = true;
}

function dismissModifierTray(event) {
  if (event.type === 'keydown') {
    if (event.key === 'Escape') closeModifierTray();
    return;
  }
  if (modifierTray?.element?.contains?.(event.target) || event.target?.closest?.('.emblem-stat-cell')) return;
  closeModifierTray();
}

function signed(value) { return value > 0 ? `+${value}` : String(value); }

function injectActionButtons(root, app, readOnly) {
  root.querySelector('.emblem-action-buttons')?.remove();
  const actor = app?.currentActor;
  if (!actor || !app?.currentToken || readOnly || actor.system?.turn?.movementPlanning !== true) return;
  const region = root.querySelector('.bg3-hud-region-right');
  if (!region) return;
  region.classList.add('emblem-anchor');
  const column = document.createElement('div');
  column.className = 'emblem-action-buttons';
  for (const definition of actionButtonDefinitions(flightFacts, turnFacts)) {
    const button = document.createElement('button');
    button.className = 'emblem-action-btn';
    button.textContent = definition[0];
    button.dataset.tooltip = definition[1];
    button.dataset.emblemAction = definition[2];
    if (definition[3] === true) button.classList.add('disabled');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.classList.contains('disabled')) return;
      interactions.emitAction(definition[2], app);
    });
    column.append(button);
  }
  region.append(column);
}

/**
 * The buttons of the action column. A flier also gets Ascend or Land between Interact and End Turn. Trade is
 * disabled without the bonus action, and both flight buttons without the whole action. Ascend is also disabled
 * while the unit's stance is broken or the map forbids flight.
 */
function actionButtonDefinitions(flight = null, turn = null) {
  const definitions = [
    ['Move', 'Confirm movement without ending turn', 'confirm'],
    ['Trade', 'Open trade targeting (requires bonus action)', 'trade', turn?.tradeAvailable === false],
    ['Interact', 'Interact with object on this tile', 'interact']
  ];
  if (flight?.canFly === true) {
    definitions.push(flight.airborne === true
      ? ['Land', 'Touch down on the ground (uses your whole action)', 'flight', flight.actionAvailable !== true]
      : ['Ascend', 'Take to the air (uses your whole action)', 'flight',
        flight.actionAvailable !== true || flight.stanceBroken === true || flight.flightForbidden === true]);
  }
  definitions.push(['End Turn', 'Confirm movement and end turn', 'end']);
  return definitions;
}

function injectPopulateButton(root, app, readOnly) {
  const views = root.querySelector('.bg3-views-container');
  root.querySelectorAll('.emblem-populate-button').forEach(button => {
    if (!views?.contains(button)) button.remove();
  });
  if (!views || views.querySelector('.emblem-populate-button') || readOnly || !app?.currentActor) return;
  const button = document.createElement('button');
  button.className = 'emblem-populate-button';
  button.dataset.tooltip = 'Populate Hotbar';
  button.innerHTML = '<i class="fas fa-magic"></i>';
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    notifyBg3HudNotice(await interactions.populateHud(app));
  });
  views.insertBefore(button, views.firstChild);
}

/* -------------------------------------------- */
/*  Counterattack toggle                        */
/* -------------------------------------------- */
const COUNTER_MODE_BUTTONS = Object.freeze([
  Object.freeze({ pacifist: false, part: 'swords', icon: 'fas fa-swords', tooltip: 'Counterattack' }),
  Object.freeze({ pacifist: true, part: 'dove', icon: 'fas fa-dove', tooltip: 'No counterattack' })
]);

/**
 * Keep the swords and dove pair under the first hotbar block in step with the view's counterMode
 * (projectBg3HudView), and remove it when that is null. The pair is updated in place rather than rebuilt, so a
 * redraw after the mode changes keeps its hover and fade. Its buttons carry Core's control-button classes, and
 * styles/emblem-rpg.css puts the pair on the line of Core's control row and reveals it with that row.
 */
function injectCounterMode(root, app, counterMode) {
  const container = counterMode ? root.querySelector('.bg3-hud-region-center .bg3-hotbar-container') : null;
  let pair = container?.querySelector(':scope > .emblem-counter-mode') ?? null;
  root.querySelectorAll('.emblem-counter-mode').forEach(stale => { if (stale !== pair) stale.remove(); });
  if (!container) return;
  if (!pair) {
    pair = buildCounterModePair(app);
    container.append(pair);
  }
  const locked = counterMode.locked === true;
  pair.classList.toggle('is-locked', locked);
  for (const button of pair.querySelectorAll('button[data-pacifist]')) {
    const active = (button.dataset.pacifist === 'true') === (counterMode.pacifist === true);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-disabled', String(locked));
  }
  if (!pair.style.getPropertyValue('--emblem-counter-anchor')) anchorCounterMode(pair, container);
}

/**
 * Build the pair once per hotbar. A press on the inactive button emits the `counter-mode` action with the mode it
 * asks for, and onBg3HudAction in init/hooks.mjs hands that to ui/controls/counter-mode.mjs. The active button and
 * a locked pair ignore presses; they are never disabled, because a disabled button would lose its tooltip.
 */
function buildCounterModePair(app) {
  const pair = document.createElement('div');
  pair.className = 'emblem-counter-mode';
  pair.dataset.bg3Ui = 'true';
  for (const definition of COUNTER_MODE_BUTTONS) {
    const button = document.createElement('button');
    const icon = document.createElement('i');
    button.type = 'button';
    button.className = `bg3-button hotbar-control-button emblem-counter-${definition.part}`;
    button.dataset.bg3Ui = 'true';
    button.dataset.pacifist = String(definition.pacifist);
    button.dataset.tooltip = definition.tooltip;
    button.dataset.tooltipDirection = 'UP';
    button.setAttribute('aria-label', definition.tooltip);
    icon.className = `bg3-button-icon ${definition.icon}`;
    button.append(icon);
    pair.append(button);
  }
  pair.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-pacifist]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    if (pair.classList.contains('is-locked') || button.classList.contains('is-active')) return;
    interactions.emitAction('counter-mode', app, { pacifist: button.dataset.pacifist === 'true' });
  });
  return pair;
}

/**
 * Centre the pair under the first hotbar column, which holds the first block's bottom-left cell at any row count.
 * Layout offsets ignore Core's `scale`, so one measurement holds through the scale menu, and a Core rebuild brings
 * a fresh pair that is measured again. Until a measurement lands, the stylesheet's fallback offset places the pair.
 */
function anchorCounterMode(pair, container) {
  const grid = [...container.querySelectorAll(':scope > .bg3-grid-container')].find(entry => entry.offsetWidth > 0);
  const cell = grid?.querySelector(':scope > .bg3-grid-cell');
  if (!cell || cell.offsetParent !== container) return;
  pair.style.setProperty('--emblem-counter-anchor', `${cell.offsetLeft + cell.offsetWidth / 2}px`);
}

/* -------------------------------------------- */
/*  DOM guards and labels                       */
/* -------------------------------------------- */
function syncReadOnly(root, readOnly) {
  root.classList.toggle('bg3-hud-readonly', readOnly);
  for (const cell of root.querySelectorAll('.bg3-grid-cell.filled')) {
    if (readOnly) cell.removeAttribute('draggable');
    else cell.setAttribute('draggable', 'true');
  }
  if (!root._emblemReadOnlyGuard) {
    for (const eventName of ['dragstart', 'drop', 'dragover', 'dragenter', 'contextmenu']) {
      root.addEventListener(eventName, event => {
        if (!root.classList.contains('bg3-hud-readonly')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }
    root._emblemReadOnlyGuard = true;
  }
  return readOnly;
}

function stampHudKind(root, app) {
  const container = root.matches('#bg3-hotbar-container') ? root : root.querySelector('#bg3-hotbar-container');
  if (!container) return;
  const kind = hudKindFor(app);
  const wasGm = container.classList.contains('emblem-gm-hotbar');
  container.dataset.emblemHudKind = kind;
  container.classList.toggle('emblem-token-hotbar', kind === 'actor');
  container.classList.toggle('emblem-gm-hotbar', kind === 'gm');
  if (kind === 'gm' && !wasGm) landIdleOpacity(container);
  container.dataset.emblemIntent = app?._emblemHudIntent ?? (kind === 'actor'
    ? BG3_HUD_INTENTS.TOKEN_ACTIVE : kind === 'gm' ? BG3_HUD_INTENTS.GM_BAR : BG3_HUD_INTENTS.PLAYER_HIDDEN);
}

/**
 * Land a returning GM bar on its idle opacity instead of letting it dim a beat after it appears. Core fades
 * #bg3-hotbar-container on a delay borrowed from the interface fade, so a bar arriving from a Character HUD would
 * otherwise sit at full opacity until that delay elapsed. Dropping the transition for one frame commits the idle
 * value at once, and Core's own :hover rule still resolves to full opacity under the cursor.
 */
function landIdleOpacity(container) {
  container.style.transition = 'none';
  void container.offsetWidth;
  container.style.removeProperty('transition');
}

function stampKeyLabels(app) {
  const grids = app?.components?.hotbar?.gridContainers ?? [];
  for (const { index, prefix } of GRID_LABELS) {
    const grid = grids[index];
    for (let slot = 0; slot < Math.min(grid?.cells?.length ?? 0, 10); slot += 1) {
      const element = grid.cells[slot]?.element;
      if (!element || element.querySelector('.emblem-keybind-label')) continue;
      const label = document.createElement('span');
      label.className = 'emblem-keybind-label';
      label.textContent = `${prefix}${slot === 9 ? 0 : slot + 1}`;
      element.append(label);
    }
  }
}

function cleanupCells(root) {
  root.querySelectorAll('.bg3-grid-cell.dragging, .bg3-grid-cell.drag-over').forEach(cell => cell.classList.remove('dragging', 'drag-over'));
  root.querySelectorAll('.bg3-grid-cell.empty .hotbar-item.depleted')
    .forEach(image => image.classList.remove('depleted'));
  root.querySelectorAll('.bg3-grid-cell.empty.hover').forEach(cell => cell.classList.remove('hover'));
  if (!root.querySelector('.bg3-grid-cell.dragging')) document.body.classList.remove('dragging-active');
  if (!root._emblemEmptyHoverGuard) {
    root.addEventListener('mouseenter', event => {
      const cell = event.target?.closest?.('.bg3-grid-cell.empty');
      if (cell) queueMicrotask(() => cell.classList.remove('hover'));
    }, true);
    root._emblemEmptyHoverGuard = true;
  }
}

/** Clear every equipped, active and weapon-art marker first, so a cell the shown unit left empty carries none. */
function clearCellMarkers(root) {
  const marked = '.bg3-grid-cell.emblem-equipped, .bg3-grid-cell.emblem-active-item, .bg3-grid-cell.emblem-active-weapon-art';
  root.querySelectorAll(marked).forEach(cell => {
    cell.classList.remove('emblem-equipped', 'emblem-active-item', 'emblem-active-weapon-art');
    if (cell.dataset?.equipped) cell.dataset.equipped = 'false';
  });
}

function decorateAllCells(app, root = hudRoot(app)) {
  if (root) clearCellMarkers(root);
  for (const cell of allGridCells(app)) {
    if (cell?.element?.isConnected && cell.data) {
      void decorateBg3Cell(cell.element, cell.data, activeCellFacts, bg3HudCellAddress(cell));
    }
  }
}

function pixelateHudSprites(root) {
  root.querySelectorAll('.hotbar-item, .passive-icon, .active-effect-icon, .nameplate-faction-icon, .nameplate-class-icon, img').forEach(element => {
    element.style.imageRendering = 'pixelated';
  });
}

function installMutationRefresh(root, app) {
  if (root._emblemPresentationObserver) return;
  const previous = observerByApp.get(app);
  if (previous && previous.root !== root) previous.observer.disconnect();
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      stampKeyLabels(app);
      pixelateHudSprites(root);
      installInstantTooltips(root);
      enforceBg3HudVisibility(app);
      decorateAllCells(app);
    });
  });
  observer.observe(root, { childList: true, subtree: true });
  root._emblemPresentationObserver = observer;
  observerByApp.set(app, { root, observer });
}

function installInstantTooltips(root) {
  for (const cell of root.querySelectorAll('.bg3-grid-cell')) {
    if (cell._emblemInstantTooltip) continue;
    cell._emblemInstantTooltip = true;
    cell.addEventListener('mouseenter', async () => {
      const uuid = cell.dataset?.uuid;
      try {
        await interactions.showInstantTooltip(cell, uuid);
      } catch (error) {
        recordDiagnostic(interactions.diagnostics, { sourcePath: import.meta.url, error: error, detail: 'Emblem RPG | BG3 HUD tooltip failed' });
      }
    }, true);
  }
}

function allGridCells(app) {
  const cells = [];
  for (const key of ['hotbar', 'weaponSets', 'quickAccess']) {
    for (const grid of app?.components?.[key]?.gridContainers ?? []) cells.push(...(grid?.cells ?? []));
  }
  return cells;
}

function hudRoot(app, html = null) {
  const element = html?.[0] ?? html ?? app?.element ?? null;
  return element?.closest?.('.bg3-hud') ?? element;
}

function readPath(object, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], object);
}
