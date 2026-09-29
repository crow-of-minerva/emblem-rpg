/** @layer external/bg3-hud */
import {
  BG3_HUD_CORE_ID,
  BG3_HUD_CORE_VERSION,
  BG3_HUD_CORE_VERSION_CEILING,
  BG3_HUD_INTENTS,
  BG3_HUD_MAX_ROWS,
  INSPECT_TOKEN_HOOK,
  bg3HudKind,
  bg3HudTransition,
  isSupportedBg3HudCoreVersion
} from '../../contracts/domains/bg3-hud.mjs';
import { ENFORCED_BG3_HUD_SETTINGS } from '../../config/enforced-settings.mjs';
import { FLIGHT_STATUS_MARKERS } from '../../config/statuses.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import {
  createEmblemBg3Components, normalizeBg3HudScale, observeEmblemBg3Effects, takeRenderTurn
} from './components.mjs';
import {
  isBg3HudUnit, pruneGmHotbarNonMacroCells, reconcileDisplayedBg3Hud, rememberLoadedLayoutRevision,
  saveHudStateThroughHost
} from './hotbar.mjs';
import { reportFoundryError, reportFoundryProbe } from '../../foundry/adapters/services/diagnostics.mjs';
import { isActiveGm } from '../../foundry/adapters/services/host.mjs';

/* -------------------------------------------- */
/*  Compatibility registration                  */
/* -------------------------------------------- */
const SUPERSEDED_REFRESH = Symbol('superseded refresh');
const BG3_HUD_TOGGLE_TOOL = 'toggleBG3UI';
let capabilitiesPromise = null;
let registrationPromise = null;
let lateRegistrationTimer = null;
const reportedUnconfiguredPorts = new Set();
/**
 * Record a diagnostic, once per port, when the HUD calls decorateHud or enforceVisibility before init/system.mjs
 * has called configureEmblemBg3Core, so the HUD isn't left undecorated without a trace. Both run inside Core's
 * refresh, where a throw could break Core in ways this system can't predict, so it records instead of throwing.
 */
function warnUnconfiguredCorePort(port) {
  if (reportedUnconfiguredPorts.has(port)) return;
  reportedUnconfiguredPorts.add(port);
  reportFoundryError(import.meta.url,
    new Error(`external/bg3-hud/core-runtime.mjs: ${port} was used before init/system.mjs called `
      + 'configureEmblemBg3Core.'),
    'configureEmblemBg3Core');
}
const unconfiguredDecorateHud = () => warnUnconfiguredCorePort('decorateHud');
const unconfiguredEnforceVisibility = () => warnUnconfiguredCorePort('enforceVisibility');
let decorateHud = unconfiguredDecorateHud;
let enforceVisibility = unconfiguredEnforceVisibility;

/**
 * Hand this file the two presentation functions its HUD patches call: decorateHud (built on decorateEmblemBg3Hud
 * in presentation/interface/bg3-hud.mjs) after each render and refresh, and enforceVisibility after a token is
 * selected or deselected. init/system.mjs calls it, because external/ may not import presentation/.
 */
export function configureEmblemBg3Core(configuration = {}) {
  decorateHud = configuration.decorateHud ?? unconfiguredDecorateHud;
  enforceVisibility = configuration.enforceVisibility ?? unconfiguredEnforceVisibility;
}

/**
 * Register this system's parts of the HUD with BG3 HUD Core. Nothing is patched or registered until Core's version
 * checks out and every private Core class the patches need has been imported. Then it patches those classes and
 * registers the portrait and passives containers and the tooltip renderer. Fires bg3HudRegistrationComplete
 * whether or not that worked. Called once, from onBg3HudReady.
 */
export function initializeEmblemBg3Core(api, adapter) {
  if (registrationPromise) return registrationPromise;
  if (!globalThis.game?.modules?.get) {
    Hooks.callAll('bg3HudRegistrationComplete', adapter);
    return Promise.resolve(false);
  }
  registrationPromise = (async () => {
    assertCoreVersion();
    const capabilities = await preflightCapabilities();
    const components = await createEmblemBg3Components(importRequiredExport);
    await enforceCanonicalCoreLock();
    installPrototypePatches(capabilities);
    api.registerPortraitContainer(components.PortraitContainer);
    api.registerPassivesContainer(components.PassivesContainer);
    api.registerTooltipRenderer(SYSTEM_ID, adapter.tooltipRenderer);
    await enforceBg3HudSettingPolicy();
    Hooks.callAll('bg3HudRegistrationComplete', adapter);
    refreshAfterLateRegistration();
    return true;
  })().catch(error => {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | BG3 HUD Core 0.6.0 compatibility preflight failed');
    Hooks.callAll('bg3HudRegistrationComplete', adapter);
    return false;
  });
  return registrationPromise;
}

/**
 * Import one export from a Core script, named by its path under the data folder. getRoute adds the route prefix and
 * gives the same URL Core's own imports resolve to, so the patches reach the classes Core runs. The error names the
 * file or export that's missing.
 */
async function importRequiredExport(modulePath, exportName) {
  let imported;
  try { imported = await import(foundry.utils.getRoute(modulePath)); }
  catch (error) {
    reportFoundryError(import.meta.url, error, 'importRequiredExport', null, false);
    throw new Error(`BG3 HUD compatibility import failed: ${modulePath}`, { cause: error });
  }
  if (typeof imported?.[exportName] !== 'function') {
    throw new Error(`BG3 HUD compatibility export missing: ${modulePath}#${exportName}`);
  }
  return imported[exportName];
}

/* -------------------------------------------- */
/*  Runtime instance patches                    */
/* -------------------------------------------- */
/**
 * Run on every render of Core's HUD (the renderBG3Hotbar hook, through onRenderBg3Hotbar): patch the app instance
 * where it isn't patched yet, then decorate the HUD, watch its effect icons and tidy the shown unit's layout.
 */
export function onRenderedEmblemBg3Hud(app, html, hookApi) {
  if (globalThis.game?.system?.id !== SYSTEM_ID || !app) return;
  patchRefresh(app);
  patchControlCoordinator(app, hookApi);
  normalizeInitialGmIntent(app);
  patchItemUpdates(app);
  patchInteraction(app);
  patchTooltipPosition();
  patchRowControls(app);
  if (app.persistenceManager?.DEFAULT_GRID_CONFIG) app.persistenceManager.DEFAULT_GRID_CONFIG.rows = 2;
  decorateHud(app, html);
  const root = html?.[0] ?? html ?? app.element;
  observeEmblemBg3Effects(root?.closest?.('.bg3-hud') ?? root);
  void reconcileDisplayedBg3Hud(app);
}

/**
 * Run a GM's left-click token selection without switching the HUD to that token: the patched controlToken handler
 * ignores the selection while the flag is set. A GM opens a unit's HUD by right-clicking instead
 * (showGmHudForTokenHud). Called from foundry/patches/token-drag.mjs and ui/controls/movement.mjs.
 */
export function withGmLeftClickHudControlSuppressed(selectToken) {
  const app = ui.BG3HUD_APP;
  if (!game.user.isGM || !app) return selectToken();
  const previous = app._emblemSuppressLeftClickControl;
  app._emblemSuppressLeftClickControl = true;
  try { return selectToken(); }
  finally { app._emblemSuppressLeftClickControl = previous ?? false; }
}

/** Show a Character's HUD for a GM who right-clicks its token, without waiting for the token to be controlled. */
export function showGmHudForTokenHud(token) {
  if (!game.user.isGM || token?.actor?.type !== 'Character') return;
  showTokenHud(token, BG3_HUD_INTENTS.TOKEN_ACTIVE);
}

/**
 * Show a player a read-only HUD for any Character token they inspect, their own units included. Inspecting isn't
 * selecting, so an owned unit acts only after its owner selects it (restoreActingHudForToken). Called from
 * ui/controls/inspect-click.mjs.
 */
export function showViewOnlyHudForToken(token) {
  if (game.user.isGM || token?.actor?.type !== 'Character') return false;
  const app = ui.BG3HUD_APP;
  if (!app) return false;
  app._viewOnlyInspect = true;
  app._viewOnlyToken = token;
  app._viewOnlyActor = token.actor;
  showTokenHud(token, BG3_HUD_INTENTS.TOKEN_VIEW_ONLY);
  Hooks.callAll(INSPECT_TOKEN_HOOK, token);
  return true;
}

/** Close a player's read-only inspection without changing which token is controlled. */
export function clearViewOnlyHud({ refresh = true } = {}) {
  const app = ui.BG3HUD_APP;
  if (!app?._viewOnlyInspect) return false;
  app._viewOnlyInspect = false;
  app._viewOnlyToken = null;
  app._viewOnlyActor = null;
  app.currentToken = null;
  app.currentActor = null;
  app._emblemHudIntent = BG3_HUD_INTENTS.PLAYER_HIDDEN;
  app._emblemHudTokenUuid = '';
  if (refresh && app.rendered) void app.refresh?.({ tokenSwap: true });
  Hooks.callAll(INSPECT_TOKEN_HOOK, null);
  return true;
}

/** Whether the HUD is already showing this Token as a read-only inspection. */
export function viewOnlyHudShows(token) {
  const app = ui.BG3HUD_APP;
  return Boolean(app?._viewOnlyInspect && token && app._viewOnlyToken?.id === token.id);
}

/** Whether the HUD is showing another unit read-only, so none of its cells may act. */
export function viewOnlyInspectionOpen() {
  return ui.BG3HUD_APP?._viewOnlyInspect === true;
}

/** Hand a player's HUD back to the owned unit they are acting with, ending the inspection opened over it. */
export function restoreActingHudForToken(token) {
  const app = ui.BG3HUD_APP;
  if (!app?._viewOnlyInspect || token?.actor?.type !== 'Character' || token.actor.isOwner !== true) return false;
  app._viewOnlyInspect = false;
  app._viewOnlyToken = null;
  app._viewOnlyActor = null;
  showTokenHud(token, BG3_HUD_INTENTS.TOKEN_ACTIVE);
  Hooks.callAll(INSPECT_TOKEN_HOOK, null);
  return true;
}

function showTokenHud(token, intent) {
  const app = ui.BG3HUD_APP;
  if (!app) return;
  app.overrideGMHotbar = false;
  app.currentToken = token;
  app.currentActor = token.actor;
  app._emblemHudIntent = intent;
  app._emblemHudTokenUuid = String(token?.document?.uuid ?? token?.uuid ?? '');
  if (app.rendered) void app.refresh?.({ tokenSwap: true });
}

/**
 * Wrap Core's app.refresh so bursts of refreshes collapse into one. A token swap Core can do in place
 * (_canSoftTokenRefresh) runs as a soft swap, queued per token. Any other call waits 10 ms and joins one shared
 * refresh (coalescedRefresh), which runs only the newest request. Every caller gets that refresh's promise.
 */
function patchRefresh(app) {
  if (app._emblemRefreshPatched || typeof app.refresh !== 'function') return;
  const original = app.refresh;
  const state = { sequence: 0, timer: null, inFlight: null, waiting: null, latest: null, softSwap: null };
  if (app._emblemHudKind === undefined) {
    app._emblemHudKind = runtimeHudKind(app);
    app._emblemHudTokenId = app.currentToken?.id ?? null;
  }
  app.refresh = function (options = {}) {
    if (!this.rendered) return Promise.resolve(undefined);
    const previous = { kind: this._emblemHudKind ?? 'hidden', tokenId: this._emblemHudTokenId ?? null };
    const next = { kind: runtimeHudKind(this), tokenId: this.currentToken?.id ?? null };
    const sequence = ++state.sequence;
    clearTimeout(state.timer);
    this._emblemFadeOutCleanup?.();
    const swapping = state.softSwap ? true : previous.kind === 'actor' && previous.tokenId !== next.tokenId;
    if (!options.forceFull && options.tokenSwap === true && next.kind === 'actor' && swapping
        && this._canSoftTokenRefresh?.()) {
      const superseded = state.waiting;
      state.waiting = null;
      state.latest = queuedSoftSwap(this, original, options, next.tokenId, state);
      if (superseded) state.latest.then(superseded.resolve, superseded.reject);
      return state.latest;
    }
    const waiting = state.waiting ?? (state.waiting = deferredRefresh());
    state.latest = waiting.promise;
    state.timer = setTimeout(() => {
      if (state.waiting === waiting) state.waiting = null;
      coalescedRefresh(this, original, options, previous, next, sequence, state).then(waiting.resolve, waiting.reject);
    }, 10);
    return waiting.promise;
  };
  app._emblemRefreshPatched = true;
}

/**
 * A refresh promise the coalesced run settles later, so every caller that joins before it runs shares one. It is
 * marked handled, so a caller that drops it (`void app.refresh()`) raises no unhandled rejection.
 */
function deferredRefresh() {
  let resolve;
  let reject;
  const promise = new Promise((fulfil, fail) => { resolve = fulfil; reject = fail; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Remember a running refresh so the next coalesced one waits for it, and forget it when it settles. */
function trackInFlight(state, run) {
  state.inFlight = run;
  return run.finally(() => { if (state.inFlight === run) state.inFlight = null; });
}

/** Queue a soft swap. A repeat for the token the last swap is for reuses it, and another token waits its turn. */
function queuedSoftSwap(app, original, options, tokenId, state) {
  const tail = state.softSwap;
  if (tail?.tokenId === tokenId) return tail.run;
  const run = tail
    ? tail.run.catch(() => {}).then(() => softSwapRefresh(app, original, options))
    : softSwapRefresh(app, original, options);
  const swap = { tokenId, run: trackInFlight(state, run) };
  const release = () => { if (state.softSwap === swap) state.softSwap = null; };
  swap.run.then(release, release);
  state.softSwap = swap;
  return swap.run;
}

async function softSwapRefresh(app, original, options) {
  app._emblemRefreshInFlight = true;
  try {
    const result = await original.call(app, { ...options, tokenSwap: true });
    decorateHud(app);
    revealHudImmediately(app.element);
    return result;
  } finally {
    app._emblemRefreshInFlight = false;
    app._emblemHudKind = runtimeHudKind(app);
    app._emblemHudTokenId = app.currentToken?.id ?? null;
  }
}

/**
 * Run one coalesced refresh after any refresh still in flight. If a newer request arrived meanwhile, it returns
 * that request's promise instead. A forced full refresh doesn't wait for a running soft swap.
 */
async function coalescedRefresh(app, original, options, previous, next, sequence, state) {
  const fallback = options.forceFull && state.softSwap;
  if (state.inFlight && !fallback) await state.inFlight.catch(() => {});
  if (sequence !== state.sequence) return state.latest;
  const result = await trackInFlight(state, performRefresh(app, original, options, previous, next, sequence, state));
  return result === SUPERSEDED_REFRESH ? state.latest : result;
}

/**
 * Carry out one refresh. A forced refresh or a switch between units rebuilds the HUD out of sight. Otherwise
 * bg3HudTransition decides: showing more (a hidden HUD appearing, or the GM bar giving way to a unit) fades in,
 * and showing less fades out first. When nothing changed it only shows or hides the HUD and decorates it again.
 */
async function performRefresh(app, original, options, previous, next, sequence, state) {
  const root = app.element;
  const settleView = () => {
    decorateHud(app);
    revealHudImmediately(app.element);
  };
  app._emblemRefreshInFlight = true;
  try {
    if (options.forceFull) {
      hideHudForRebuild(root);
      await renderBg3Hud(app, original, options);
      settleView();
      return undefined;
    }
    if (previous.kind === next.kind && previous.tokenId === next.tokenId) {
      if (next.kind === 'hidden') hideHudImmediately(root);
      else revealHudImmediately(root);
      decorateHud(app);
      return undefined;
    }
    if (previous.kind === 'actor' && next.kind === 'actor') {
      hideHudForRebuild(root);
      await renderBg3Hud(app, original, options);
      settleView();
      return undefined;
    }
    const transition = bg3HudTransition(previous, next);
    if (transition === 'fade-out') {
      await fadeHudOut(app, root);
      if (sequence !== state.sequence) return SUPERSEDED_REFRESH;
      if (next.kind === 'hidden') {
        hideHudImmediately(app.element);
        return undefined;
      }
      await renderBg3Hud(app, original, options);
      settleView();
      return undefined;
    }
    if (transition === 'fade-in') {
      hideHudForRebuild(root);
      await renderBg3Hud(app, original, options);
      decorateHud(app);
      fadeHudIn(app, app.element);
      return undefined;
    }
    hideHudForRebuild(root);
    await renderBg3Hud(app, original, options);
    settleView();
    return undefined;
  } finally {
    app._emblemRefreshInFlight = false;
    app._emblemHudKind = runtimeHudKind(app);
    app._emblemHudTokenId = app.currentToken?.id ?? null;
  }
}

function runtimeHudKind(app) {
  return bg3HudKind(app, game.user.isGM);
}

async function renderBg3Hud(app, original, options) {
  if (typeof app.render === 'function') return app.render(false);
  return original.call(app, { ...options, tokenSwap: false });
}

function hideHudForRebuild(root) {
  if (!root) return;
  root.classList.remove('emblem-fade-active', 'emblem-instant-show', 'bg3-hud-visible', 'bg3-hud-fading-out', 'bg3-hud-hidden');
  root.style.transition = 'opacity 0s';
  root.style.opacity = '0';
  root.style.display = '';
}

function hideHudImmediately(root) {
  if (!root) return;
  root.classList.remove('emblem-fade-active', 'emblem-instant-show', 'bg3-hud-visible', 'bg3-hud-fading-out');
  root.style.display = 'none';
  root.style.removeProperty?.('transition');
  root.style.removeProperty?.('opacity');
}

function revealHudImmediately(root) {
  if (!root) return;
  root.classList.remove('emblem-fade-active', 'emblem-instant-show', 'bg3-hud-building', 'bg3-hud-hidden', 'bg3-hud-fading-out');
  root.classList.add('bg3-hud-visible');
  root.style.display = '';
  root.style.removeProperty?.('transition');
  root.style.removeProperty?.('opacity');
}

function fadeHudOut(app, root) {
  if (!root) return Promise.resolve();
  root.classList.add('emblem-fade-active', 'bg3-hud-fading-out');
  root.classList.remove('emblem-instant-show', 'bg3-hud-visible', 'bg3-hud-hidden', 'bg3-hud-building');
  if (typeof root.addEventListener !== 'function') return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      root.removeEventListener('transitionend', onEnd);
      if (app._emblemFadeOutCleanup === finish) delete app._emblemFadeOutCleanup;
      resolve();
    };
    const onEnd = event => {
      if (event.target === root && event.propertyName === 'opacity') finish();
    };
    root.addEventListener('transitionend', onEnd);
    const timer = setTimeout(finish, 400);
    app._emblemFadeOutCleanup = finish;
  });
}

function fadeHudIn(app, root) {
  if (!root) return;
  root.classList.remove('emblem-instant-show', 'bg3-hud-fading-out', 'bg3-hud-hidden', 'bg3-hud-building');
  root.classList.add('emblem-fade-active');
  root.style.display = '';
  root.style.transition = 'opacity 0s';
  root.style.opacity = '0';
  void root.offsetWidth;
  root.style.transition = 'opacity 300ms ease-in-out';
  root.style.opacity = '1';
  root.classList.add('bg3-hud-visible');
  clearTimeout(app._emblemFadeCleanupTimer);
  app._emblemFadeCleanupTimer = setTimeout(() => {
    if (app.element !== root) return;
    root.style.removeProperty?.('transition');
    root.style.removeProperty?.('opacity');
    root.classList.remove('emblem-fade-active');
  }, 400);
}

/**
 * Replace Core's controlToken handler. Selecting a token points the HUD at that unit, deselecting the shown token
 * sends a GM back to the GM bar (and a player to no HUD), and a GM's suppressed left-click is ignored. After Core's
 * own handler runs, enforceVisibility applies the system's visibility rules.
 */
function patchControlCoordinator(app, hookApi) {
  const coordinator = app.updateCoordinator;
  if (!coordinator || coordinator._emblemLeftClickGuardPatched || !hookApi?.on || !hookApi?.off) return;
  const oldHookId = coordinator._hookIds?.get?.('controlToken');
  if (oldHookId !== undefined) hookApi.off('controlToken', oldHookId);
  const original = coordinator._onControlToken.bind(coordinator);
  const callback = async (token, controlled) => {
    if (game.user.isGM && controlled && app._emblemSuppressLeftClickControl) return;
    if (controlled) {
      app._viewOnlyInspect = false;
      app._emblemHudIntent = BG3_HUD_INTENTS.TOKEN_ACTIVE;
      app._emblemHudTokenUuid = String(token?.document?.uuid ?? token?.uuid ?? '');
    } else if (app.currentToken === token || app.currentToken?.id === token?.id) {
      app._emblemHudIntent = game.user.isGM
        ? BG3_HUD_INTENTS.GM_BAR : BG3_HUD_INTENTS.PLAYER_HIDDEN;
      app._emblemHudTokenUuid = '';
    }
    await original(token, controlled);
    enforceVisibility(app);
  };
  const newHookId = hookApi.on('controlToken', callback);
  coordinator._hookIds?.set?.('controlToken', newHookId);
  coordinator._emblemLeftClickGuardPatched = true;
  patchCanvasCoordinator(app, coordinator, hookApi);
}

/**
 * After Core's canvasReady handler, put a GM's HUD back on the GM bar, unless the GM was showing that token on
 * purpose or the unit is in the middle of a move.
 */
function patchCanvasCoordinator(app, coordinator, hookApi) {
  if (coordinator._emblemCanvasIntentPatched || typeof coordinator._onCanvasReady !== 'function') return;
  const oldHookId = coordinator._hookIds?.get?.('canvasReady');
  if (oldHookId === undefined) return;
  hookApi.off('canvasReady', oldHookId);
  const original = coordinator._onCanvasReady.bind(coordinator);
  const callback = async (...args) => {
    await original(...args);
    if (!game.user.isGM) return;
    const current = app.currentToken;
    const intended = String(app._emblemHudTokenUuid ?? '');
    const currentUuid = String(current?.document?.uuid ?? current?.uuid ?? '');
    const mechanical = current?.actor?.system?.turn?.movementPlanning === true;
    if (mechanical) {
      app._emblemHudIntent = BG3_HUD_INTENTS.TOKEN_ACTIVE;
      app._emblemHudTokenUuid = currentUuid;
      return;
    }
    if (app._emblemHudIntent === BG3_HUD_INTENTS.TOKEN_ACTIVE && intended && intended === currentUuid) return;
    app.currentToken = null;
    app.currentActor = null;
    app._emblemHudIntent = BG3_HUD_INTENTS.GM_BAR;
    app._emblemHudTokenUuid = '';
    await app.refresh?.({ tokenSwap: true });
  };
  const newHookId = hookApi.on('canvasReady', callback);
  coordinator._hookIds?.set?.('canvasReady', newHookId);
  coordinator._emblemCanvasIntentPatched = true;
}

/**
 * On the first render a GM's HUD opens on the GM bar rather than on whichever token was controlled, unless that
 * unit is in the middle of a move.
 */
function normalizeInitialGmIntent(app) {
  if (!game.user.isGM || !app.currentToken || app._emblemHudIntent) return;
  if (app.currentActor?.system?.turn?.movementPlanning === true) {
    app._emblemHudIntent = BG3_HUD_INTENTS.TOKEN_ACTIVE;
    app._emblemHudTokenUuid = String(app.currentToken?.document?.uuid ?? app.currentToken?.uuid ?? '');
    return;
  }
  app.currentToken = null;
  app.currentActor = null;
  app._emblemHudIntent = BG3_HUD_INTENTS.GM_BAR;
  void app.refresh?.({ tokenSwap: true });
}

/**
 * While the HUD shows a unit, a click on an item cell goes to the adapter's onCellClick instead of Core's handler,
 * and a click on any other cell does nothing. On the GM bar, anything but a Macro dropped from outside is refused
 * with a warning.
 */
function patchInteraction(app) {
  const coordinator = app.interactionCoordinator;
  if (!coordinator || coordinator._emblemActorClicksPatched || typeof coordinator.handleClick !== 'function') return;
  const original = coordinator.handleClick;
  const externalDrop = coordinator._handleExternalDrop;
  coordinator.handleClick = async function (cell, event) {
    if (this.hotbarApp?.currentActor) {
      event?.preventDefault?.();
      if (cell?.data?.type === 'Item' && typeof this.adapter?.onCellClick === 'function') {
        return this.adapter.onCellClick(cell, event);
      }
      return false;
    }
    return original.call(this, cell, event);
  };
  coordinator._emblemActorClicksPatched = true;
  if (typeof externalDrop === 'function') {
    coordinator._handleExternalDrop = async function (targetCell, event) {
      if (this.persistenceManager?.isGMHotbarMode?.()) {
        const result = await this._getDocumentFromDragData?.(event);
        if (result?.type !== 'Macro') {
          ui.notifications.warn('Only Macros can be placed on the GM hotbar.');
          return;
        }
      }
      return externalDrop.call(this, targetCell, event);
    };
  }
}

/**
 * Patch Core's ItemUpdateManager: a new item goes to the grid the adapter's auto-populate picks, an actor's update
 * waits for a running rebuild of its HUD (rebuildBg3HudState in hotbar.mjs), and removing or updating a cell
 * tolerates stored state with missing grids.
 */
function patchItemUpdates(app) {
  const manager = app.itemUpdateManager;
  if (!manager || manager._emblemGridPolicyPatched) return;
  if (typeof manager._findAppropriateGrid === 'function') {
    const original = manager._findAppropriateGrid;
    manager._findAppropriateGrid = function (item) {
      const adapter = this._getAdapter?.();
      return adapter?.autoPopulate?.getGridIndexForItem?.(item) ?? original.call(this, item);
    };
  }
  if (typeof manager._updateHotbarForActor === 'function') {
    const original = manager._updateHotbarForActor;
    manager._updateHotbarForActor = async function (actor, ...args) {
      if (actor?._bg3RebuildInFlight) await actor._bg3RebuildInFlight.catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'patchItemUpdates'); });
      if (app.persistenceManager) app.persistenceManager._lastSaveTimestamp = Date.now();
      return original.call(this, actor, ...args);
    };
  }
  for (const method of ['_removeItemFromActorHotbar', '_updateItemInActorHotbar']) {
    const original = manager[method];
    if (typeof original !== 'function') continue;
    manager[method] = function (persistenceManager, state, ...args) {
      normalizeCoreHudState(state);
      return original.call(this, persistenceManager, state, ...args);
    };
  }
  manager._emblemGridPolicyPatched = true;
}

function normalizeCoreHudState(state) {
  state.hotbar ??= { grids: [] };
  state.hotbar.grids = Array.isArray(state.hotbar.grids) ? state.hotbar.grids : [];
  state.weaponSets ??= { sets: [] };
  state.weaponSets.sets = Array.isArray(state.weaponSets.sets) ? state.weaponSets.sets : [];
  state.quickAccess ??= { grids: [] };
  state.quickAccess.grids = Array.isArray(state.quickAccess.grids) ? state.quickAccess.grids : [];
  return state;
}

/** Keep the hotbar grids between 2 and BG3_HUD_MAX_ROWS rows when Core's add and remove row buttons are used. */
function patchRowControls(app) {
  const controls = app.components?.controls;
  if (!controls || controls._emblemRowsPatched) return;
  const add = controls._addRow;
  const remove = controls._removeRow;
  if (typeof add === 'function') controls._addRow = async function (...args) {
    const state = await app.persistenceManager?.loadState?.();
    const maximum = Math.max(...(state?.hotbar?.grids ?? []).map(grid => Number(grid.rows) || 1), 1);
    if (maximum >= BG3_HUD_MAX_ROWS) return;
    return add.apply(this, args);
  };
  if (typeof remove === 'function') controls._removeRow = async function (...args) {
    const state = await app.persistenceManager?.loadState?.();
    const rows = (state?.hotbar?.grids ?? []).map(grid => Number(grid.rows) || 1);
    if (!rows.length) return;
    const minimum = Math.min(...rows);
    if (minimum <= 2) return;
    return remove.apply(this, args);
  };
  controls._emblemRowsPatched = true;
}

/**
 * Place a Core tooltip positioned `DOWN` below its target, kept 8 px inside the window, or above the target when
 * there's no room below.
 */
function patchTooltipPosition() {
  const manager = ui.BG3HOTBAR?.tooltipManager;
  if (!manager || manager._emblemDownPatched || typeof manager._positionTooltip !== 'function') return;
  const original = manager._positionTooltip;
  manager._positionTooltip = function (target, direction = 'UP') {
    if (direction !== 'DOWN') return original.call(this, target, direction);
    const targetRect = target?.getBoundingClientRect?.();
    const tooltip = this.tooltipElement;
    if (!targetRect || !tooltip) return original.call(this, target, direction);
    const rect = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(targetRect.left + targetRect.width / 2 - rect.width / 2, window.innerWidth - rect.width - 8));
    let top = targetRect.bottom + 10;
    if (top + rect.height > window.innerHeight - 8) top = targetRect.top - rect.height - 10;
    Object.assign(tooltip.style, { position: 'fixed', left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
  };
  manager._emblemDownPatched = true;
}

/* -------------------------------------------- */
/*  Prototype patches                           */
/* -------------------------------------------- */
/** Import every Core class the prototype patches need, once, so a missing one stops registration before any patch. */
async function preflightCapabilities() {
  capabilitiesPromise ??= Promise.all([
    importRequiredExport('modules/bg3-hud-core/scripts/components/containers/ActiveEffectsContainer.js', 'ActiveEffectsContainer'),
    importRequiredExport('modules/bg3-hud-core/scripts/managers/PersistenceManager.js', 'PersistenceManager'),
    importRequiredExport('modules/bg3-hud-core/scripts/components/containers/ControlContainer.js', 'ControlContainer'),
    importRequiredExport('modules/bg3-hud-core/scripts/components/ui/ContextMenu.js', 'ContextMenu'),
    importRequiredExport('modules/bg3-hud-core/scripts/components/ui/SlotContextMenu.js', 'SlotContextMenu'),
    importRequiredExport('modules/bg3-hud-core/scripts/utils/settings.js', 'updateUIScale')
  ]).then(([ActiveEffectsContainer, PersistenceManager, ControlContainer, ContextMenu, SlotContextMenu, updateUIScale]) =>
    ({ ActiveEffectsContainer, PersistenceManager, ControlContainer, ContextMenu, SlotContextMenu, updateUIScale }));
  return capabilitiesPromise;
}

function installPrototypePatches(capabilities) {
  patchEffectTemporality(capabilities.ActiveEffectsContainer);
  patchPersistencePolicy(capabilities.PersistenceManager);
  patchBg3ControlRow(capabilities.ControlContainer, capabilities.ContextMenu, capabilities.updateUIScale);
  patchBg3ContextMenuPlacement(capabilities.ContextMenu);
  patchBg3SlotMenu(capabilities.SlotContextMenu);
  silenceHotbarDeprecations();
}

/**
 * Patch Core's effect strip. Renders take turns (takeRenderTurn), effects that carry a status show alongside
 * temporary ones, duplicates are dropped, and a grounded flier gets its Grounded marker, which is its take-off
 * control. An airborne unit gets no marker.
 */
function patchEffectTemporality(ActiveEffectsContainer) {
  const prototype = ActiveEffectsContainer.prototype;
  if (prototype._emblemStatusAware) return;
  const render = prototype.render;
  prototype.render = function (...args) { return takeRenderTurn(this, () => render.apply(this, args)); };
  prototype.getActiveEffects = function () {
    if (!this.actor) return [];
    const all = typeof this.actor.allApplicableEffects === 'function'
      ? [...this.actor.allApplicableEffects()] : [...(this.actor.effects?.contents ?? [])];
    let showPassive = false;
    try { showPassive = game.settings.get(BG3_HUD_CORE_ID, 'showPassiveActiveEffects') === true; } catch (diagnosticError) {
      reportFoundryProbe(import.meta.url, diagnosticError, 'patchEffectTemporality', /is not a registered game setting$/.test(String(diagnosticError?.message ?? '')));
    }
    const seen = new Set();
    const shown = (showPassive ? all : all.filter(effect => effect.isTemporary || effect.statuses?.size > 0))
      .filter(effect => {
        const key = this._getEffectKey?.(effect) ?? effect.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const marker = this.actor.flyingStatusMarker;
    if (marker?.name !== FLIGHT_STATUS_MARKERS.grounded.id) return shown;
    const represented = shown.some(effect => effect.statuses?.has?.(marker.name) || effect.name === marker.name);
    return represented ? shown : [...shown, marker];
  };
  prototype._emblemStatusAware = true;
}

/**
 * Patch Core's PersistenceManager. A unit's layout is saved through the host (saveHudStateThroughHost in
 * hotbar.mjs), and loading one records its revision. The GM bar holds only Macros: other cells are pruned when it
 * loads, and only a GM saves it. Actors that aren't units get Core's default state and nothing is saved for them.
 * Core's ItemUpdateManager creates a temporary PersistenceManager for any Actor an item lands on, so a Convoy,
 * Vendor or Object reaches loadState and saveState here too.
 */
function patchPersistencePolicy(PersistenceManager) {
  const prototype = PersistenceManager.prototype;
  if (prototype._emblemPersistencePolicyPatched) return;
  const loadState = prototype.loadState;
  const saveState = prototype.saveState;

  if (typeof loadState === 'function' && typeof saveState === 'function') {
    prototype.loadState = async function (...args) {
      if (this.currentActor && !isBg3HudUnit(this.currentActor)) return this._getDefaultState?.() ?? null;
      const state = await loadState.apply(this, args);
      if (!this.isGMHotbarMode?.()) {
        rememberLoadedLayoutRevision(this.currentActor);
        return state;
      }
      if (!state) return state;
      const safeState = clone(state);
      if (!pruneGmHotbarNonMacroCells(safeState)) return state;
      await saveState.call(this, safeState);
      return this.state ?? safeState;
    };
  }

  for (const method of ['saveState', 'queueSaveState']) {
    const original = prototype[method];
    if (typeof original !== 'function') continue;
    prototype[method] = async function (state, ...rest) {
      if (this.currentActor && !isBg3HudUnit(this.currentActor)) return;
      if (this.isGMHotbarMode?.() !== true) {
        if (method === 'saveState' && this.currentActor) return saveHudStateThroughHost(this, state);
        return original.call(this, state, ...rest);
      }
      if (!game.user.isGM) {
        if (state) this.state = clone(state);
        return;
      }
      const safeState = state ? clone(state) : state;
      if (safeState) pruneGmHotbarNonMacroCells(safeState);
      return original.call(this, safeState, ...rest);
    };
  }
  prototype._emblemPersistencePolicyPatched = true;
}

/**
 * Put the HUD Scale button, and the Resync button while a unit is shown, before Core's control buttons. The lock
 * button only locks drag and drop, because enforceCanonicalCoreLock resets Core's other lock options first.
 */
function patchBg3ControlRow(ControlContainer, ContextMenu, updateUIScale) {
  const prototype = ControlContainer.prototype;
  if (prototype._emblemScalePatched) return;
  const original = prototype._getButtons;
  prototype._getButtons = function () {
    const buttons = original.call(this);
    const container = this;
    const lock = buttons.find(button => button.key === 'control-lock');
    if (lock) {
      lock.tooltip = 'Lock / unlock hotbar drag and drop';
      lock.onClick = async event => {
        await enforceCanonicalCoreLock();
        await container._toggleLock?.(event);
      };
      delete lock.onRightClick;
    }
    const resync = this.hotbarApp?.currentActor ? [{
      key: 'control-resync', classes: ['hotbar-control-button'], icon: 'fas fa-arrows-rotate', tooltip: 'Resync Hotbar',
      onClick: async () => {
        const adapter = ui.BG3HOTBAR?.registry?.activeAdapter;
        await adapter?.resyncHotbar?.(container.hotbarApp);
      }
    }] : [];
    return [{
      key: 'control-scale', classes: ['hotbar-control-button'], icon: 'fas fa-magnifying-glass', tooltip: 'HUD Scale',
      onClick: event => {
        if (document.querySelector('.emblem-hud-scale-item')) return;
        const row = event?.currentTarget?.closest?.('.bg3-control-container') ?? null;
        return openScaleMenu(ContextMenu, updateUIScale, event, row);
      }
    }, ...resync, ...buttons];
  };
  prototype._emblemScalePatched = true;
}

/** Position every Core context menu again once it's in the document, where its real size can be measured. */
function patchBg3ContextMenuPlacement(ContextMenu) {
  const prototype = ContextMenu.prototype;
  if (prototype._emblemPlacementPatched || typeof prototype.render !== 'function') return;
  const original = prototype.render;
  prototype.render = async function (...args) {
    const element = await original.apply(this, args);
    if (this.element?.isConnected && this.event) this._positionMenu?.();
    return element;
  };
  prototype._emblemPlacementPatched = true;
}

/** Build a slot's context menu without Core's container entries (sort, clear, auto-populate). Resync replaces them. */
function patchBg3SlotMenu(SlotContextMenu) {
  const prototype = SlotContextMenu.prototype;
  if (prototype._emblemSlotMenuPatched || typeof prototype._buildMenuItems !== 'function') return;
  const original = prototype._buildMenuItems;
  prototype._buildMenuItems = function (cell) {
    return original.call(this, cell, null);
  };
  prototype._emblemSlotMenuPatched = true;
}

/** Open the scale slider beside the control row, holding the row visible and the menu open while the slider is used. */
async function openScaleMenu(ContextMenu, updateUIScale, event, row) {
  const current = normalizeBg3HudScale(updateUIScale());
  const menu = new ContextMenu({
    event,
    items: [{
      label: 'Scale', icon: 'fas fa-magnifying-glass', class: 'emblem-hud-scale-item', keepOpen: true,
      custom: `<input type="range" min="0.5" max="1" step="0.01" value="${current.toFixed(2)}">`
        + `<span class="emblem-hud-scale-value">${current.toFixed(2)}</span>`
    }]
  });
  await menu.render();
  row?.classList?.add?.('emblem-menu-open');
  const destroy = typeof menu.destroy === 'function' ? menu.destroy.bind(menu) : null;
  menu.destroy = () => {
    row?.classList?.remove?.('emblem-menu-open');
    destroy?.();
  };
  menu.element?.querySelector?.('.bg3-context-menu-custom')
    ?.addEventListener?.('click', click => click.stopPropagation());
  const slider = menu.element?.querySelector?.('input[type="range"]');
  const readout = menu.element?.querySelector?.('.emblem-hud-scale-value');
  slider?.addEventListener?.('input', () => {
    const value = normalizeBg3HudScale(slider.value);
    if (readout) readout.textContent = value.toFixed(2);
    ui.BG3HUD_APP?.element?.querySelector?.('#bg3-hotbar-container')?.style
      ?.setProperty?.('--bg3-scale-ui', String(value));
  });
  slider?.addEventListener?.('change', async () => {
    const value = normalizeBg3HudScale(slider.value);
    await game.settings.set(BG3_HUD_CORE_ID, 'uiScale', Math.round(value * 100));
    if (game.settings.get(BG3_HUD_CORE_ID, 'autoScale')) {
      await globalThis.game.settings.set(BG3_HUD_CORE_ID, 'autoScale', false);
    }
  });
  slider?.focus?.();
  return menu;
}

function silenceHotbarDeprecations() {
  const prototype = foundry.applications.ui.Hotbar.prototype;
  if (prototype._emblemCollapseSilenced) return;
  prototype.collapse = function () {};
  prototype.expand = function () {};
  prototype._emblemCollapseSilenced = true;
}

/* -------------------------------------------- */
/*  Enforced Core settings and controls         */
/* -------------------------------------------- */
/**
 * Set the Core settings the system's hotbar relies on (ENFORCED_BG3_HUD_SETTINGS): always collapse Foundry's macro
 * bar on this client, and turn on the GM hotbar, a world setting only the active GM writes. Called during
 * registration (initializeEmblemBg3Core).
 * @returns {Promise<number>} How many settings this client wrote.
 */
export async function enforceBg3HudSettingPolicy() {
  const settings = game.settings;
  const registry = settings.settings;
  let written = 0;
  for (const policy of ENFORCED_BG3_HUD_SETTINGS) {
    if (!registry.has(`${BG3_HUD_CORE_ID}.${policy.key}`)) continue;
    if (policy.scope === 'world' && !isActiveGm()) continue;
    try {
      if (settings.get(BG3_HUD_CORE_ID, policy.key) === policy.value) continue;
      await settings.set(BG3_HUD_CORE_ID, policy.key, policy.value);
      written += 1;
    } catch (error) {
      reportFoundryError(import.meta.url, error,
        `Emblem RPG | Could not enforce ${BG3_HUD_CORE_ID}.${policy.key}`);
    }
  }
  return written;
}

/**
 * Remove Core's HUD toggle from the token scene controls (getSceneControlButtons in init/hooks.mjs), because
 * selecting and inspecting tokens decide when the HUD shows.
 * @param {object} controls Foundry's scene control record, keyed by group name.
 * @returns {boolean} Whether the tool was present and removed.
 */
export function removeBg3HudToggleControl(controls) {
  const tools = controls?.tokens?.tools;
  if (!tools || !(BG3_HUD_TOGGLE_TOOL in tools)) return false;
  delete tools[BG3_HUD_TOGGLE_TOOL];
  return true;
}

/** Reset Core's lock settings so the lock button locks drag and drop only. */
async function enforceCanonicalCoreLock() {
  const current = game.settings.get(BG3_HUD_CORE_ID, 'lockSettings') ?? {};
  if (current.deselect === false && current.opacity === false && current.dragDrop === true
      && Object.keys(current).length === 3) return;
  await game.settings.set(BG3_HUD_CORE_ID, 'lockSettings', {
    deselect: false,
    opacity: false,
    dragDrop: true
  });
}

/**
 * Force a full refresh once Core's app has rendered, checking every 50 ms for up to a second, so a HUD drawn
 * before registration finished picks up the new containers.
 */
function refreshAfterLateRegistration(attempt = 0) {
  clearTimeout(lateRegistrationTimer);
  const app = ui.BG3HUD_APP;
  if (app?.rendered) {
    void app.refresh?.({ forceFull: true });
    lateRegistrationTimer = null;
    return;
  }
  if (attempt >= 20) return;
  lateRegistrationTimer = setTimeout(() => refreshAfterLateRegistration(attempt + 1), 50);
}

function assertCoreVersion() {
  const module = game.modules.get(BG3_HUD_CORE_ID);
  const compare = foundry.utils.isNewerVersion;
  if (module?.version && !isSupportedBg3HudCoreVersion(module.version, compare)) {
    throw new Error(`Expected ${BG3_HUD_CORE_ID} ${BG3_HUD_CORE_VERSION} `
      + `up to ${BG3_HUD_CORE_VERSION_CEILING}; found ${module.version}`);
  }
}

function clone(value) {
  return foundry.utils.deepClone(value);
}
