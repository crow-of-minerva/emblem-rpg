/** @layer foundry/patches */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { statusKeyForId } from '../../config/statuses.mjs';
import { captureScrollPositions, restoreScrollPositions } from '../../lib/dom/scroll.mjs';
import { installWrapperGroup } from '../../external/host.mjs';
import { adjustAppliedStatus, projectAppliedStatus } from '../adapters/document-writes/effect-execution.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Global UI vocabulary                        */
/* -------------------------------------------- */
const CURSOR_PATH = `systems/${SYSTEM_ID}/assets/ui/cursor/`;

/** Every system cursor, by --cursor-* name: [file in CURSOR_PATH, hotspot x, hotspot y, fallback keyword]. */
const CURSORS = Object.freeze({
  default: ['pointer.svg', 6, 5, 'default'],
  'default-down': ['pointer.svg', 6, 5, 'default'],
  pointer: ['pointer-2.svg', 8, 4, 'pointer'],
  'pointer-down': ['pointer-2.svg', 8, 4, 'pointer'],
  grab: ['hand-open.svg', 12, 12, 'grab'],
  'grab-down': ['hand-grab.svg', 12, 12, 'grabbing'],
  text: ['bracket_a_vertical.svg', 12, 12, 'text'],
  'text-down': ['bracket_a_vertical.svg', 12, 12, 'text'],
  wait: ['busy_hourglass_outline_detail.svg', 12, 12, 'wait'],
  context: ['cursor-context.svg', 2, 2, 'context-menu'],
  'context-menu': ['cursor-context.svg', 2, 2, 'context-menu'],
  help: ['help.svg', 6, 5, 'help'],
  progress: ['busy_hourglass_outline_detail.svg', 12, 12, 'progress'],
  'not-allowed': ['disabled.svg', 6, 5, 'not-allowed'],
  'no-drop': ['disabled.svg', 6, 5, 'no-drop'],
  copy: ['copy.svg', 6, 5, 'copy'],
  alias: ['copy.svg', 6, 5, 'alias'],
  crosshair: ['crosshair.svg', 12, 12, 'crosshair'],
  cell: ['crosshair.svg', 12, 12, 'cell'],
  move: ['move.svg', 12, 12, 'move'],
  'all-scroll': ['move.svg', 12, 12, 'all-scroll'],
  'zoom-in': ['zoom-in.svg', 11, 11, 'zoom-in'],
  'zoom-out': ['zoom-out.svg', 11, 11, 'zoom-out'],
  'vertical-text': ['bracket_a_vertical.svg', 12, 12, 'vertical-text'],
  'ns-resize': ['resize-ns.svg', 12, 12, 'ns-resize'],
  'n-resize': ['resize-ns.svg', 12, 12, 'n-resize'],
  's-resize': ['resize-ns.svg', 12, 12, 's-resize'],
  'row-resize': ['resize-ns.svg', 12, 12, 'row-resize'],
  'ew-resize': ['resize-ew.svg', 12, 12, 'ew-resize'],
  'e-resize': ['resize-ew.svg', 12, 12, 'e-resize'],
  'w-resize': ['resize-ew.svg', 12, 12, 'w-resize'],
  'col-resize': ['resize-ew.svg', 12, 12, 'col-resize'],
  'nwse-resize': ['resize-nwse.svg', 12, 12, 'nwse-resize'],
  'nw-resize': ['resize-nwse.svg', 12, 12, 'nw-resize'],
  'se-resize': ['resize-nwse.svg', 12, 12, 'se-resize'],
  'nesw-resize': ['resize-nesw.svg', 12, 12, 'nesw-resize'],
  'ne-resize': ['resize-nesw.svg', 12, 12, 'ne-resize'],
  'sw-resize': ['resize-nesw.svg', 12, 12, 'sw-resize'],
  // Cursors the stylesheet shows while the host is busy, while picking a target and while moving a unit.
  locked: ['locked.svg', 6, 5, 'not-allowed'],
  target: ['target.svg', 16, 16, 'crosshair'],
  walk: ['boot.svg', 3, 19, 'move']
});

/** The --cursor-* variable each CSS cursor keyword is rewritten to. `auto` becomes the text cursor everywhere. */
const KEYWORD_VARIABLES = Object.freeze({
  auto: 'text',
  default: 'default',
  pointer: 'pointer',
  text: 'text',
  'vertical-text': 'vertical-text',
  grab: 'grab',
  grabbing: 'grab-down',
  wait: 'wait',
  progress: 'progress',
  help: 'help',
  'context-menu': 'context',
  'not-allowed': 'not-allowed',
  'no-drop': 'no-drop',
  copy: 'copy',
  alias: 'alias',
  crosshair: 'crosshair',
  cell: 'cell',
  move: 'move',
  'all-scroll': 'all-scroll',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  'n-resize': 'n-resize',
  's-resize': 's-resize',
  'e-resize': 'e-resize',
  'w-resize': 'w-resize',
  'ne-resize': 'ne-resize',
  'nw-resize': 'nw-resize',
  'se-resize': 'se-resize',
  'sw-resize': 'sw-resize',
  'ns-resize': 'ns-resize',
  'ew-resize': 'ew-resize',
  'nesw-resize': 'nesw-resize',
  'nwse-resize': 'nwse-resize',
  'row-resize': 'row-resize',
  'col-resize': 'col-resize'
});

const FADE_IN_MS = 200;
const FADE_OUT_MS = 200;
const REMOVED_TOKEN_HUD_SELECTORS = Object.freeze([
  '[data-action="togglePalette"][data-palette="movementActions"]',
  '.palette.movement-actions',
  '[data-action="target"]',
  '[data-action="combat"]'
]);

let initialized = false;
const pendingCloses = new WeakMap();
const SILENT_SOUNDS = Object.freeze({ expand() {}, collapse() {}, tabClick() {} });
let sounds = SILENT_SOUNDS;
const PLACEABLES_FILTER_GROUP = 'placeables-filter-broadcast';
let filterPass = null;
const settledFilters = new WeakMap();

/* -------------------------------------------- */
/*  Public lifecycle                            */
/* -------------------------------------------- */
/**
 * Install the system cursors, the fade transitions on Foundry windows and the page-wide sheet behaviours (select
 * auto-blur and the tab click sound). Called from the `init` hook in init/hooks.mjs with the interface sounds.
 */
export function initializeUiInterventions({ sounds: cues = null } = {}) {
  initialized = true;
  sounds = { ...SILENT_SOUNDS, ...(cues ?? {}) };
  installCursors();
  patchLegacyApplication();
  patchApplicationV2();
  installGlobalSelectAutoBlur();
  installSheetTabSound();
}

/** Point the loaded stylesheets at the system cursors, and watch for new ones. Called from the `ready` hook. */
export function readyUiInterventions() {
  if (!initialized || typeof document === 'undefined') return;
  normalizeStylesheetCursors();
  watchStylesheets();
}

/**
 * Stop the Tokens sidebar tab re-flagging every Token when a filter pass leaves the visible set as it was.
 *
 * Core re-renders that tab on every Token write and ends each pass with a state refresh of the whole layer,
 * which is a no-op unless an entry became hidden or visible.
 */
export function installPlaceablesFilterGate() {
  installWrapperGroup({
    id: PLACEABLES_FILTER_GROUP,
    required: false,
    wrappers: [
      {
        target: 'foundry.applications.sidebar.tabs.TokenTab.prototype._applyFilters',
        fn: rememberedFilterPass,
        type: 'WRAPPER'
      },
      {
        target: 'foundry.canvas.layers.TokenLayer.prototype.setAllRenderFlags',
        fn: gatedStateBroadcast,
        type: 'MIXED'
      }
    ]
  });
}

/** Remove core Token HUD controls replaced by Emblem interaction workflows, and take over the status palette. */
export function onRenderTokenHud(hud, html) {
  const root = typeof html?.querySelectorAll === 'function' ? html : html?.[0];
  if (!root) return;
  for (const selector of REMOVED_TOKEN_HUD_SELECTORS) {
    for (const element of root.querySelectorAll(selector)) {
      (element.closest?.('.attribute') ?? element).remove?.();
    }
  }
  const palette = root.querySelector('.palette.status-effects');
  if (palette) installStatusPalette(hud, palette);
}

/**
 * Handle Token HUD status clicks before Foundry's own toggle, through adjustAppliedStatus. A left-click adds a stack
 * or toggles the status, and a right-click removes a stack or the status. A status with two or more stacks shows
 * its count.
 */
function installStatusPalette(hud, palette) {
  const actor = hud?.actor;
  for (const control of palette.querySelectorAll('[data-action="effect"]')) {
    const key = statusKeyForId(control.dataset.statusId);
    const applied = key ? projectAppliedStatus(actor, key) : null;
    if (!applied?.stackable || applied.stacks < 2) continue;
    const slot = document.createElement('span');
    slot.className = 'emblem-status-slot';
    control.replaceWith(slot);
    const count = document.createElement('span');
    count.className = 'emblem-status-count';
    count.textContent = String(applied.stacks);
    slot.append(control, count);
    control.setAttribute('data-tooltip-text', `${applied.definition.label} ×${applied.stacks}`);
  }
  const handOut = event => {
    const control = event.target?.closest?.('[data-action="effect"]');
    if (!control) return;
    event.preventDefault();
    event.stopPropagation();
    const key = statusKeyForId(control.dataset.statusId);
    if (!key || !actor?.isOwner) return;
    adjustAppliedStatus(actor, key, { shed: event.type === 'contextmenu' })
      .then(() => { if (hud.rendered && hud.actor === actor) return hud.render(); })
      .catch(error => reportFoundryError(import.meta.url, error, 'installStatusPalette'));
  };
  palette.addEventListener('click', handOut, true);
  palette.addEventListener('contextmenu', handOut, true);
}

/* -------------------------------------------- */
/*  Cursor installation                         */
/* -------------------------------------------- */
/**
 * Register every system cursor in CONFIG.cursors and have core write the --cursor-* variables. Each entry is the
 * finished CSS value, which core writes as given, so the cursor keeps its own fallback keyword, and getRoute puts
 * the route prefix on its image.
 */
function installCursors() {
  for (const [name, [file, x, y, fallback]] of Object.entries(CURSORS)) {
    CONFIG.cursors[name] = `url("${foundry.utils.getRoute(`${CURSOR_PATH}${file}`)}") ${x} ${y}, ${fallback}`;
  }
  game.configureCursors();
}

/* -------------------------------------------- */
/*  Cursor stylesheet coverage                  */
/* -------------------------------------------- */
/**
 * Replace the cursor keywords in every loaded stylesheet with the matching --cursor-* variable, which
 * game.configureCursors fills from CONFIG.cursors, so Foundry's and modules' rules show the system cursors.
 */
function normalizeStylesheetCursors() {
  const visited = new Set();
  for (const sheet of document.styleSheets) normalizeStylesheet(sheet, visited);
}

/** Walk one stylesheet. A cross-origin sheet doesn't give up its rules and is skipped. */
function normalizeStylesheet(sheet, visited) {
  if (!sheet || visited.has(sheet)) return;
  visited.add(sheet);
  let rules;
  try {
    rules = sheet.cssRules;
  } catch {
    return;
  }
  if (rules) normalizeRules(rules, visited);
}

function normalizeRules(rules, visited) {
  for (const rule of rules) {
    if (rule.styleSheet) {
      normalizeStylesheet(rule.styleSheet, visited);
      continue;
    }
    if (rule.style) normalizeCursorDeclaration(rule.style);
    if (rule.cssRules?.length) normalizeRules(rule.cssRules, visited);
  }
}

function normalizeCursorDeclaration(style) {
  const value = style.getPropertyValue('cursor');
  if (!value) return;
  const keyword = value.split(',')[0].trim().toLowerCase();
  const variable = KEYWORD_VARIABLES[keyword];
  if (variable) style.setProperty('cursor', `var(--cursor-${variable})`, style.getPropertyPriority('cursor'));
}

/** Rewrite stylesheets that applications or modules load after startup. */
function watchStylesheets() {
  if (typeof MutationObserver === 'undefined') return;
  let scheduled = false;
  const requestFrame = typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : callback => setTimeout(callback, 0);
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      normalizeStylesheetCursors();
    });
  };
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName === 'STYLE') schedule();
        else if (node.nodeName === 'LINK' && node.rel === 'stylesheet') {
          node.addEventListener('load', schedule, { once: true });
          schedule();
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
}

/* -------------------------------------------- */
/*  Placeables filter broadcast                 */
/* -------------------------------------------- */
function rememberedFilterPass(wrapped, ...args) {
  const previous = filterPass;
  filterPass = { tab: this, visible: settledFilters.get(this) ?? null };
  try {
    const result = wrapped(...args);
    const settled = visibleEntrySignature(this);
    if (settled === null) settledFilters.delete(this);
    else settledFilters.set(this, settled);
    return result;
  } finally {
    filterPass = previous;
  }
}

function gatedStateBroadcast(wrapped, ...args) {
  const pass = filterPass;
  if (pass && pass.tab?.layer === this && pass.visible !== null && stateOnly(args[0])
      && visibleEntrySignature(pass.tab) === pass.visible) {
    return undefined;
  }
  return wrapped(...args);
}

function visibleEntrySignature(tab) {
  const visible = tab?._filterState?.visible;
  if (!visible || typeof visible[Symbol.iterator] !== 'function') return null;
  return [...visible].map(entry => String(entry?.id ?? entry?.uuid ?? '')).sort().join(',');
}

function stateOnly(flags) {
  if (!flags || typeof flags !== 'object') return false;
  const raised = Object.keys(flags).filter(flag => flags[flag]);
  return raised.length === 1 && raised[0] === 'refreshState';
}

/* -------------------------------------------- */
/*  Application transitions                     */
/* -------------------------------------------- */
/** Fade legacy Application windows in on their first render and out before they close. */
function patchLegacyApplication() {
  const LegacyApplication = globalThis.Application;
  if (!LegacyApplication?.prototype) return;

  patchMethod(LegacyApplication.prototype, 'close', original => function (options = {}) {
    const element = this.element;
    if (element?.length > 0 && typeof element.addClass === 'function') {
      element.addClass('fade-out');
      return closeAfterFade(this, () => original.call(this, options));
    }
    return original.call(this, options);
  });

  patchMethod(LegacyApplication.prototype, 'render', original => function (force = false, options = {}) {
    if (force === true) abandonPendingClose(this);
    const isInitial = !this.rendered;
    const result = original.call(this, force, options);
    if (isInitial && this.element?.length > 0) addFadeIn(this.element[0]);
    return result;
  });
}

/**
 * The same fades for ApplicationV2 windows. A re-render keeps its scroll positions, and Actor and Item sheets play
 * the expand and collapse sounds. Render arguments reach Foundry exactly as given, so the legacy
 * `render(force, options)` form keeps its options (the page a journal link opens, a document's render context).
 *
 * `render` and `close` are replaced on the ApplicationV2 prototype itself, not through libWrapper, so every window
 * from core and every module gets them. A close waits FADE_OUT_MS and then runs with core's own close animation off.
 * This runs at `init`, so a libWrapper wrapper registered afterwards wraps this replacement.
 */
function patchApplicationV2() {
  const ApplicationV2 = foundry.applications.api.ApplicationV2;

  patchMethod(ApplicationV2.prototype, 'close', original => function (options = {}) {
    const close = () => original.call(this, { ...options, animate: false });
    if (!this.element?.classList) return close();
    if (isDocumentSheet(this)) sounds.collapse();
    this.element.classList.add('fade-out');
    return closeAfterFade(this, close);
  });

  patchMethod(ApplicationV2.prototype, 'render', original => function (...args) {
    if (forcedRender(args[0])) abandonPendingClose(this);
    const isInitial = !this.rendered;
    const savedScroll = isInitial ? null : captureScrollPositions(this.element);
    const result = original.apply(this, args);
    if (!isInitial) {
      if (savedScroll) settleRender(result, () => restoreScrollPositions(this.element, savedScroll));
      return result;
    }

    if (isDocumentSheet(this)) sounds.expand();
    settleRender(result, () => addFadeIn(this.element), 10);
    return result;
  });
}

/* -------------------------------------------- */
/*  Global sheet behaviours                     */
/* -------------------------------------------- */
/** Drop focus from a select as soon as its value changes, so the next keypress reaches the sheet. */
function installGlobalSelectAutoBlur() {
  listenOnDocument('change', event => {
    if (event.target?.tagName === 'SELECT') event.target.blur?.();
  });
}

/** Click sound for document-sheet tabs, in the capture phase and silent on the tab already showing. */
function installSheetTabSound() {
  listenOnDocument('click', event => {
    const button = event.target?.closest?.('button[data-tab]');
    if (!button || isActiveTabButton(button)) return;
    const root = button.closest('.application');
    if (!root) return;
    if (!isDocumentSheet(foundry.applications.instances.get(root.id))) return;
    sounds.tabClick();
  }, true);
}

function listenOnDocument(type, listener, options = false) {
  const target = globalThis.document;
  if (typeof target?.addEventListener !== 'function') return;
  target.addEventListener(type, listener, options);
}

function isActiveTabButton(button) {
  return button.classList.contains('active')
    || button.getAttribute('aria-selected') === 'true'
    || button.getAttribute('aria-pressed') === 'true';
}

/** Whether an application is an Actor or Item sheet, the windows whose opening and closing are voiced. */
function isDocumentSheet(application) {
  const sheets = foundry.applications.sheets;
  if (!application) return false;
  return application instanceof sheets.ActorSheetV2 || application instanceof sheets.ItemSheetV2;
}

function patchMethod(prototype, method, createReplacement) {
  const original = prototype[method];
  if (typeof original !== 'function') return;
  prototype[method] = createReplacement(original);
}

function closeAfterFade(application, close) {
  const pending = pendingCloses.get(application);
  if (pending) return pending.promise;
  const fade = { promise: null, abandon: null };
  fade.promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => Promise.resolve().then(close).then(resolve, reject), FADE_OUT_MS);
    fade.abandon = () => {
      clearTimeout(timer);
      resolve(application);
    };
  }).finally(() => { if (pendingCloses.get(application) === fade) pendingCloses.delete(application); });
  pendingCloses.set(application, fade);
  return fade.promise;
}

/** Whether a render call forces the window open, in either the `render(true)` or the `render({force: true})` form. */
function forcedRender(options) {
  return options === true || options?.force === true;
}

/** A forced render during the fade keeps the window: the close never runs and the fade is undone. */
function abandonPendingClose(application) {
  const pending = pendingCloses.get(application);
  if (!pending) return false;
  pendingCloses.delete(application);
  pending.abandon();
  const element = application.element;
  if (element?.classList) element.classList.remove('fade-out');
  else if (typeof element?.removeClass === 'function') element.removeClass('fade-out');
  return true;
}

function settleRender(result, apply, synchronousDelay = 0) {
  if (result && typeof result.then === 'function') {
    result.then(apply, () => {});
    return;
  }
  if (synchronousDelay > 0) setTimeout(apply, synchronousDelay);
  else apply();
}

function addFadeIn(element) {
  if (!element?.classList || isCombatPreview(element)) return;
  element.classList.add('fade-in');
  setTimeout(() => element?.classList?.remove?.('fade-in'), FADE_IN_MS);
}

function isCombatPreview(element) {
  return element.classList.contains('window-combat-preview')
    || element.closest?.('.window-combat-preview') != null;
}
