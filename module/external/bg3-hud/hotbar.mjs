/** @layer external/bg3-hud */
import {
  BG3_HUD_CORE_ID, BG3_HUD_LAYOUT_REVISION_FLAG, BG3_HUD_MAX_ROWS, HOTBAR_LAYOUT_OUTCOMES, bg3HudCellGroups,
  pruneForeignHudCells
} from '../../contracts/domains/bg3-hud.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { isActiveGm, readSetting } from '../../foundry/adapters/services/host.mjs';
import {
  reportFoundryError, reportFoundryNotice, reportFoundryProbe
} from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Item membership                             */
/* -------------------------------------------- */
const TYPE_ORDER = Object.freeze({ Equipment: 1, Spell: 2, Ability: 3, Consumable: 4, Miscellaneous: 5 });
const WIELDABLE_SUBTYPES = Object.freeze(['Weapon', 'Staff', 'Attack']);
const SUBTYPE_ORDER = Object.freeze({
  Weapon: 1, Staff: 2, Attack: 3, Utility: 4, Active: 5, Mount: 5.5,
  Passive: 6, Armor: 7, Shield: 8, Accessory: 9
});

/** Whether an Emblem Item belongs on an activatable BG3 grid. */
export function isBg3HotbarItem(item) {
  if (['Consumable', 'Spell', 'Miscellaneous'].includes(item?.type)) return true;
  const itemType = item?.system?.itemType;
  if (item?.type === 'Ability') return ['Active', 'Weapon Art', 'Mount'].includes(itemType);
  if (item?.type === 'Equipment') {
    return ['Weapon', 'Attack', 'Staff (U)', 'Staff', 'Shield', 'Accessory'].includes(itemType);
  }
  return false;
}

/** Select the attack, utility or fallback BG3 grid for an Item. */
function bg3GridIndexForItem(item) {
  const itemType = item?.system?.itemType;
  if (item?.type === 'Equipment' && ['Weapon', 'Staff'].includes(itemType)) return 0;
  if (item?.type === 'Spell' && itemType === 'Attack') return 0;
  if (item?.type === 'Equipment' && itemType === 'Staff (U)') return 1;
  if (item?.type === 'Spell' && itemType === 'Utility') return 1;
  if (item?.type === 'Ability' && ['Active', 'Weapon Art'].includes(itemType)) return 1;
  return 2;
}

/** A sorted copy of the items: by type, then subtype, then name. */
function sortBg3HotbarItems(items) {
  return [...(items ?? [])].sort((left, right) => {
    const typeDifference = (TYPE_ORDER[left?.type] ?? 99) - (TYPE_ORDER[right?.type] ?? 99);
    if (typeDifference) return typeDifference;
    const subtypeDifference = (SUBTYPE_ORDER[left?.system?.itemType] ?? 99)
      - (SUBTYPE_ORDER[right?.system?.itemType] ?? 99);
    if (subtypeDifference) return subtypeDifference;
    return String(left?.name ?? '').localeCompare(String(right?.name ?? ''));
  });
}

/** Select Actor Items matching the configured BG3 grid filter. */
function bg3ItemsForFilter(actor, filter) {
  const items = [...(actor?.items ?? [])];
  return items.filter(item => {
    const subtype = item?.system?.itemType;
    if (filter === 'weapon') return item.type === 'Equipment' && WIELDABLE_SUBTYPES.includes(subtype);
    if (filter === 'spell-attack') return item.type === 'Spell' && subtype === 'Attack';
    if (filter === 'spell-utility') return item.type === 'Spell' && subtype === 'Utility';
    if (filter === 'ability-active') {
      return item.type === 'Ability' && ['Active', 'Weapon Art', 'Mount'].includes(subtype);
    }
    if (filter === 'ability-utility') {
      return item.type === 'Ability' && ['Utility', 'Staff (U)'].includes(subtype);
    }
    if (filter === 'consumable') return item.type === 'Consumable';
    if (filter === 'miscellaneous') return item.type === 'Miscellaneous';
    if (filter === 'equipped') {
      return item.system?.isWielded || item.system?.isWorn || item.system?.isEquipped;
    }
    return false;
  });
}

/* -------------------------------------------- */
/*  Additive placement                          */
/* -------------------------------------------- */
/** Put eligible items the grids don't have yet into empty cells, leaving placed cells alone. Returns how many. */
function addItemsToBg3State(actor, state, configuredFilters = null) {
  const grids = state?.hotbar?.grids;
  if (!actor || !Array.isArray(grids)) return 0;
  const existing = new Set(grids.flatMap(grid => Object.values(grid?.items ?? {})).map(cell => cell?.uuid).filter(Boolean));
  const buckets = [[], [], []];

  if (configuredFilters) {
    for (let index = 0; index < buckets.length; index += 1) {
      const selected = (configuredFilters[`grid${index}`] ?? []).flatMap(filter => bg3ItemsForFilter(actor, filter));
      buckets[index] = sortBg3HotbarItems([...new Map(selected.map(item => [item.uuid, item])).values()])
        .filter(item => !existing.has(item.uuid));
    }
  } else {
    for (const item of sortBg3HotbarItems([...actor.items].filter(isBg3HotbarItem))) {
      if (!existing.has(item.uuid)) buckets[bg3GridIndexForItem(item)].push(item);
    }
  }

  buckets[2].sort((left, right) => {
    const order = item => item?.system?.itemType === 'Mount' ? 0
      : item?.type === 'Consumable' ? 1 : item?.type === 'Miscellaneous' ? 3 : 2;
    return order(left) - order(right) || String(left?.name ?? '').localeCompare(String(right?.name ?? ''));
  });

  let added = 0;
  for (let index = 0; index < Math.min(grids.length, buckets.length); index += 1) {
    const grid = grids[index];
    grid.items ??= {};
    let itemIndex = 0;
    for (let row = 0; row < (Number(grid.rows) || 1) && itemIndex < buckets[index].length; row += 1) {
      for (let column = 0; column < (Number(grid.cols) || 12) && itemIndex < buckets[index].length; column += 1) {
        const key = `${column}-${row}`;
        if (grid.items[key]) continue;
        const item = buckets[index][itemIndex++];
        if (existing.has(item.uuid)) continue;
        grid.items[key] = { uuid: item.uuid, name: item.name, img: item.img, type: 'Item' };
        existing.add(item.uuid);
        added += 1;
      }
    }
  }
  return added;
}

/* -------------------------------------------- */
/*  Core adapter contributions                  */
/* -------------------------------------------- */
export class EmblemBg3AutoSort {
  sortItems(items) { return sortBg3HotbarItems(items); }
  getSortOptions() { return { groupByType: true, alphabetize: true }; }
}

export class EmblemBg3AutoPopulate {
  constructor() { this.autoSort = new EmblemBg3AutoSort(); }
  setAutoSort(autoSort) { this.autoSort = autoSort; }
  isHotbarItem(item) { return isBg3HotbarItem(item); }
  getGridIndexForItem(item) { return bg3GridIndexForItem(item); }
  getAllHotbarItems(actor) { return [...(actor?.items ?? [])].filter(isBg3HotbarItem); }
  getItemsForType(actor, filter) { return bg3ItemsForFilter(actor, filter); }
  applyItemsToState(actor, state) { return addItemsToBg3State(actor, state); }

  async populateHotbar(actor, persistenceManager) {
    if (!actor || !canWriteActor(actor)) return 0;
    const state = await loadDetachedState(actor, persistenceManager);
    const added = addItemsToBg3State(actor, state);
    if (added) await saveDetachedState(actor, state, persistenceManager);
    return added;
  }

  async populateContainer(_container, actor, persistenceManager) {
    const added = await this.populateHotbar(actor, persistenceManager);
    const notifications = ui.notifications;
    if (!actor) notifications.warn('No actor selected.');
    else notifications.info(added
      ? `Added ${added} item${added === 1 ? '' : 's'} to the hotbar.`
      : 'All eligible items are already on the hotbar.');
  }

  async populateOnTokenCreation(actor, configuration, persistenceManager) {
    if (!actor || !configuration || !canWriteActor(actor)) return;
    if (actor._bg3RebuildInFlight) {
      await actor._bg3RebuildInFlight.catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'populateOnTokenCreation'); });
      return;
    }
    await serializeActorState(actor, async () => {
      const state = await loadDetachedState(actor, persistenceManager);
      if (actor._bg3RebuildInFlight) {
        await actor._bg3RebuildInFlight.catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'populateOnTokenCreation'); });
        return;
      }
      if (addItemsToBg3State(actor, state, configuration)) {
        await saveDetachedState(actor, state, persistenceManager);
      }
    });
  }
}

function canWriteActor(actor) {
  return game.user.isGM || actor?.isOwner === true;
}

async function loadDetachedState(actor, persistenceManager) {
  let state = actor.getFlag?.('bg3-hud-core', 'hudState');
  if (!state && persistenceManager) {
    const previous = persistenceManager.currentToken ?? persistenceManager.currentActor ?? null;
    try {
      await persistenceManager.setToken?.(actor);
      state = await persistenceManager.loadState?.();
    } finally {
      await persistenceManager.setToken?.(previous);
    }
  }
  return foundry.utils.deepClone(state ?? {});
}

async function saveDetachedState(actor, state, persistenceManager) {
  const saved = await persistHudLayout(actor, state);
  if (sameActor(persistenceManager?.currentActor, actor)) {
    persistenceManager.state = foundry.utils.deepClone(state);
  }
  return saved.ok;
}

/** Only the active GM, or a player who owns the unit, saves a tidied layout. Other clients only redraw it. */
function canPersistReconcile(actor) {
  if (isActiveGm()) return true;
  return !game.user.isGM && actor?.isOwner === true;
}

/* -------------------------------------------- */
/*  Shared layout persistence                   */
/* -------------------------------------------- */
/**
 * Whether this actor gets a HUD. Only Characters have a hotbar, so core-runtime.mjs keeps Core from loading or
 * saving state for any other actor (a Convoy, Vendor or Object), and the lifecycle handlers below skip them.
 */
export function isBg3HudUnit(actor) {
  return actor?.type === 'Character';
}

/** The revision of a unit's shared layout, which each save through the host advances. */
function hotbarLayoutRevision(actor) {
  return Number(actor?.getFlag?.(SYSTEM_ID, BG3_HUD_LAYOUT_REVISION_FLAG)) || 0;
}

/**
 * This client's save queue and last known layout revision for each unit, keyed by actor uuid. Core saves a unit's
 * whole layout from several places that don't know about each other: the shown HUD's PersistenceManager, the
 * temporary one its ItemUpdateManager creates for each item change, and this file's own fills and rebuilds. Every
 * save names the revision it replaces, so they all go through one queue per unit, and each sends the revision the
 * host returned for the save before it. A stale refusal then always means another client changed the layout.
 */
const layoutSaves = new Map();

/** How many units' records a session keeps before idle ones are forgotten. */
const TRACKED_LAYOUT_LIMIT = 500;

/**
 * Save a unit's layout on the host through api.character.hotbar.saveLayout, in place of Core's own save (the
 * PersistenceManager patch in core-runtime.mjs). The actor, and whether this user owns it, are captured when Core
 * asks, and the save waits behind this client's other saves for the unit. If the host refuses it as stale, the
 * stored layout is reloaded. A user who doesn't own the unit, such as one inspecting it, changes only the local
 * copy.
 * @param {object} manager Core's persistence manager showing the unit.
 * @param {object} state The complete HUD state Core would save.
 * @returns {Promise<boolean>} Whether the host saved it.
 */
export function saveHudStateThroughHost(manager, state) {
  const actor = manager?.currentActor ?? null;
  if (!actor || !state) return Promise.resolve(false);
  const actorUuid = String(actor.uuid ?? '');
  const record = layoutSaveRecord(actorUuid);
  const request = Object.freeze({ actor, actorUuid, owner: actor.isOwner === true,
    generation: record.generation, record, state });
  record.pending += 1;
  const run = record.queue.then(() => sendManagedLayout(manager, request));
  record.queue = run.catch(error => reportFoundryProbe(import.meta.url, error, 'saveHudStateThroughHost', true));
  return run;
}

/**
 * Send one queued layout save. A save queued before a stale refusal is dropped, because it was arranged from the
 * same out-of-date layout. After a refusal the layout is reloaded, but only if the HUD still shows the unit.
 */
async function sendManagedLayout(manager, request) {
  const { actor, actorUuid, record, state } = request;
  try {
    if (!request.owner) {
      if (showsActor(manager, actorUuid)) manager.state = clone(state);
      return false;
    }
    if (request.generation !== record.generation) return false;
    if (showsActor(manager, actorUuid)) {
      manager._lastSaveTimestamp = Date.now();
      manager._syncCurrentStateToActiveView?.(state);
    }
    const saved = await sendLayoutSave(actor, state, record);
    if (!showsActor(manager, actorUuid)) return saved.ok;
    if (saved.stale) {
      reloadAfterStale(manager, actorUuid);
      return false;
    }
    manager.state = clone(state);
    return saved.ok;
  } finally {
    record.pending -= 1;
  }
}

/**
 * Send one layout with the revision this client believes is stored, then keep whatever revision the host reports,
 * even on a refusal. The record holds the revision the host last reported for this unit. Only a unit this client
 * hasn't saved or loaded yet this session falls back to the revision flag on the actor.
 */
async function sendLayoutSave(actor, state, record) {
  const expected = Number.isSafeInteger(record.revision) ? record.revision : hotbarLayoutRevision(actor);
  const saved = await requestLayoutSave(actor, state, expected);
  record.revision = saved.revision;
  if (saved.stale) record.generation += 1;
  return saved;
}

/**
 * Reload the stored layout once the unit's queued saves settle. The save doesn't wait for the reload, because Core
 * may save while loading (when it normalizes the state), and that save would wait behind this one forever. More
 * refusals during the reload share it.
 */
function reloadAfterStale(manager, actorUuid) {
  if (manager._emblemLayoutReload) return;
  const running = layoutSaves.get(actorUuid)?.queue ?? Promise.resolve();
  const reload = running
    .then(() => (showsActor(manager, actorUuid) ? manager.loadState?.() : undefined))
    .catch(error => reportFoundryError(import.meta.url, error, 'reloadAfterStale'));
  manager._emblemLayoutReload = reload;
  void reload.then(() => { if (manager._emblemLayoutReload === reload) manager._emblemLayoutReload = null; });
}

/** This client's send order and revision for one unit, created on its first save or load. */
function layoutSaveRecord(actorUuid) {
  let record = layoutSaves.get(actorUuid);
  if (!record) {
    record = { revision: null, generation: 0, pending: 0, queue: Promise.resolve() };
    layoutSaves.set(actorUuid, record);
    forgetIdleLayoutRecords(actorUuid);
  }
  return record;
}

/** Drop idle units once a session has cycled through many, so every Token ever shown is not held forever. */
function forgetIdleLayoutRecords(keep) {
  if (layoutSaves.size <= TRACKED_LAYOUT_LIMIT) return;
  for (const [actorUuid, record] of layoutSaves) {
    if (layoutSaves.size <= TRACKED_LAYOUT_LIMIT) return;
    if (actorUuid !== keep && record.pending === 0) layoutSaves.delete(actorUuid);
  }
}

/**
 * Note the revision a load just read for a unit, from the PersistenceManager `loadState` patch in core-runtime.mjs.
 * A load taken while one of this client's saves is in flight is ignored, because the flag it read is about to
 * change. The record keeps the revision the host reports instead.
 */
export function rememberLoadedLayoutRevision(actor) {
  const actorUuid = String(actor?.uuid ?? '');
  if (!actorUuid || !isBg3HudUnit(actor)) return;
  const record = layoutSaveRecord(actorUuid);
  if (record.pending === 0) record.revision = hotbarLayoutRevision(actor);
}

/** Whether the HUD still shows this exact unit. A synthetic token actor shares its base actor's id but not its uuid. */
function showsActor(manager, actorUuid) {
  return Boolean(actorUuid) && String(manager?.currentActor?.uuid ?? '') === actorUuid;
}

/**
 * Send the layout to the host with its expected revision. An actor that isn't a unit is skipped: Core's
 * ItemUpdateManager creates a temporary PersistenceManager for any Actor an item lands on, so a Convoy, Vendor or
 * Object can reach this save, and the host would refuse it with a message to the user. The save is also skipped
 * while an execution segment is open on this client (an Enemy AI turn, for example), because CommandDispatcher
 * refuses global commands during a segment.
 */
async function requestLayoutSave(actor, state, expectedRevision) {
  const { api } = game.emblemRpg;
  if (!isBg3HudUnit(actor)) return { ok: false, stale: false, revision: expectedRevision };
  if (api.protocol.execution()?.owner?.segment === true) {
    return { ok: false, stale: false, revision: expectedRevision };
  }
  const actorUuid = String(actor?.uuid ?? '');
  const result = await api.character.hotbar.saveLayout({ actorUuid, state, expectedRevision });
  const revision = Number(result?.data?.revision);
  const stale = result?.code === HOTBAR_LAYOUT_OUTCOMES.STALE;
  if (stale) {
    reportFoundryNotice(import.meta.url,
      `Hotbar layout for ${actorUuid} was arranged from revision ${expectedRevision}; the saved layout is `
      + `revision ${Number.isSafeInteger(revision) ? revision : 'unknown'}. The saved layout was reloaded.`,
      'Save a unit hotbar layout');
  }
  return {
    ok: result?.ok === true,
    stale,
    revision: Number.isSafeInteger(revision) ? revision : expectedRevision
  };
}

/** Send an arrangement a fill or a rebuild made in the background, behind this client's other saves for the unit. */
function persistHudLayout(actor, state) {
  const record = layoutSaveRecord(String(actor?.uuid ?? ''));
  record.pending += 1;
  const run = sendLayoutBehind(record, () => sendLayoutSave(actor, state, record));
  record.queue = run.catch(error => reportFoundryProbe(import.meta.url, error, 'persistHudLayout', true));
  return run;
}

/** Run one save after the unit's queued saves settle, and release its place whether it worked or threw. */
function sendLayoutBehind(record, send) {
  return record.queue.then(send).finally(() => { record.pending -= 1; });
}

/** Run one actor's HUD state writes one at a time. */
async function serializeActorState(actor, operation) {
  const previous = actor._emblemBg3StateWrite ?? Promise.resolve();
  let release;
  actor._emblemBg3StateWrite = new Promise(resolve => { release = resolve; });
  try {
    await previous.catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'serializeActorState'); });
    return await operation();
  } finally {
    release();
  }
}

/* -------------------------------------------- */
/*  State normalization                         */
/* -------------------------------------------- */
/** Remove every non-Macro cell from GM hotbar state, including saved views. */
export function pruneGmHotbarNonMacroCells(state) {
  if (!state) return 0;
  let removed = 0;
  for (const items of bg3HudCellGroups(state, true)) {
    for (const [key, cell] of Object.entries(items)) {
      if (cell?.type === 'Macro' && macroUuid(cell.uuid)) continue;
      delete items[key];
      removed += 1;
    }
  }
  return removed;
}

/** Remove cells for items the actor no longer has. Macro cells stay, since Macros are world documents. */
function pruneForeignBg3Cells(actor, state) {
  if (!actor || !state) return 0;
  return pruneForeignHudCells(state, [...actor.items].map(item => item.uuid));
}

/** Detect state naming anything the Actor does not carry: another Actor's Items, a synthetic Token's, or a lost one. */
function hasForeignBg3Cells(actor, state) {
  if (!actor || !state) return false;
  const owned = new Set([...actor.items].map(item => item.uuid));
  return bg3HudCellGroups(state, true).some(items => Object.values(items)
    .some(cell => Boolean(cell?.uuid) && cell.type !== 'Macro' && !owned.has(cell.uuid)));
}

/** Build blank Core state while retaining the saved row preference. */
function freshBg3HudState(persistenceManager, previous = null) {
  const state = persistenceManager?._getDefaultState?.() ?? {
    version: 2,
    hotbar: { grids: Array.from({ length: 3 }, () => ({ rows: 2, cols: 5, items: {} })) },
    weaponSets: {
      sets: Array.from({ length: 3 }, () => ({ rows: 1, cols: 2, items: {} })),
      activeSet: 0
    },
    quickAccess: { grids: [{ rows: 2, cols: 3, items: {} }] }
  };
  const fresh = clone(state);
  for (let index = 0; index < (fresh.hotbar?.grids?.length ?? 0); index += 1) {
    const oldRows = Number(previous?.hotbar?.grids?.[index]?.rows);
    if (Number.isInteger(oldRows) && oldRows > 0) {
      fresh.hotbar.grids[index].rows = Math.min(oldRows, BG3_HUD_MAX_ROWS);
    }
  }
  return fresh;
}

/** Give every hotbar grid the same row count: enough for every grid's last filled row, from 2 to BG3_HUD_MAX_ROWS. */
function normalizeBg3GridRows(state) {
  const grids = state?.hotbar?.grids;
  if (!Array.isArray(grids) || !grids.length) return false;
  let target = 2;
  for (const grid of grids) {
    const columns = Number(grid.cols) || 12;
    const rows = Number(grid.rows) || 1;
    for (let row = rows - 1; row >= 0; row -= 1) {
      if (Array.from({ length: columns }, (_, column) => grid.items?.[`${column}-${row}`]?.uuid).some(Boolean)) {
        target = Math.max(target, row + 1);
        break;
      }
    }
  }
  target = Math.min(Math.max(target, 2), BG3_HUD_MAX_ROWS);
  let changed = false;
  for (const grid of grids) {
    if (grid.rows === target) continue;
    grid.rows = target;
    changed = true;
  }
  return changed;
}

/**
 * Replace an actor's HUD state with a fresh one that keeps its row counts, optionally filled with its items, and
 * save it. One rebuild runs per actor at a time, and Core's item updates wait for it (patchItemUpdates in
 * core-runtime.mjs). Used for a resync and for copied or synthetic actors.
 */
function rebuildBg3HudState(actor, { autoFill = false, persistenceManager = null } = {}) {
  if (!actor || !canWriteActor(actor)) return Promise.resolve(false);
  if (actor._bg3RebuildInFlight) return actor._bg3RebuildInFlight;
  actor._emblemBg3AutoPopulateChecked = true;
  const operation = (async () => {
    const previous = actor.getFlag?.(BG3_HUD_CORE_ID, 'hudState');
    const fresh = freshBg3HudState(persistenceManager, previous);
    if (autoFill) addItemsToBg3State(actor, fresh);
    persistenceManager?._syncCurrentStateToActiveView?.(fresh);
    if (sameActor(persistenceManager?.currentActor, actor)) persistenceManager._lastSaveTimestamp = Date.now();
    const saved = await persistHudLayout(actor, fresh);
    if (sameActor(persistenceManager?.currentActor, actor)) persistenceManager.state = clone(fresh);
    return saved.ok;
  })();
  actor._bg3RebuildInFlight = operation;
  void operation.finally(() => {
    if (actor._bg3RebuildInFlight === operation) actor._bg3RebuildInFlight = null;
  });
  return operation;
}

/** Discard one Actor's arrangement and rebuild it from what the unit carries now. */
export function resyncBg3HudState(actor, persistenceManager = null) {
  return rebuildBg3HudState(actor, { autoFill: true, persistenceManager });
}

/** Push the persisted state into the rendered grids without rebuilding the HUD, then redecorate the cells. */
export async function refreshBg3HudGrids(app) {
  if (!app?.rendered || !app.persistenceManager) return false;
  const state = await app.persistenceManager.loadState?.();
  if (!state) return false;
  await renderDetachedState(app, state);
  Hooks.callAll('emblemRpg.bg3HudDecorate', app);
  return true;
}

/**
 * Tidy the shown unit's layout once per session: remove cells for items it no longer has, fill empty cells when
 * auto-populate is on, and even out the grid rows. Placed cells never move. Called after each HUD render.
 */
export function reconcileDisplayedBg3Hud(app) {
  const actor = app?.currentActor;
  const persistenceManager = app?.persistenceManager;
  if (!actor || !persistenceManager) return Promise.resolve(false);
  if (actor._emblemBg3ReconcileInFlight) return actor._emblemBg3ReconcileInFlight;
  if (actor._emblemBg3AutoPopulateChecked) return Promise.resolve(false);
  actor._emblemBg3AutoPopulateChecked = true;
  const operation = (async () => {
    const loaded = await persistenceManager.loadState?.();
    if (!loaded) return false;
    const state = clone(loaded);
    const removed = pruneForeignBg3Cells(actor, state);
    const added = autoPopulateEnabled() ? addItemsToBg3State(actor, state) : 0;
    const normalized = normalizeBg3GridRows(state);
    if (!canPersistReconcile(actor)) {
      if (removed || added || normalized) await renderDetachedState(app, state);
      return false;
    }
    if (!removed && !added && !normalized) return false;
    await persistenceManager.saveState?.(state);
    await renderDetachedState(app, state);
    Hooks.callAll('emblemRpg.bg3HudDecorate', app);
    return true;
  })();
  actor._emblemBg3ReconcileInFlight = operation;
  void operation.finally(() => {
    if (actor._emblemBg3ReconcileInFlight === operation) actor._emblemBg3ReconcileInFlight = null;
  });
  return operation;
}

/* -------------------------------------------- */
/*  Foundry lifecycle                           */
/* -------------------------------------------- */
/** When this user creates an unlinked Character token, give its synthetic actor a fresh hotbar of its own. */
export async function onCreateTokenBg3Hud(tokenDocument, _options, userId) {
  if (!localCreator(userId) || tokenDocument.actorLink || !compatible(tokenDocument.actor)) return;
  await rebuildBg3HudState(tokenDocument.actor, {
    autoFill: autoPopulateEnabled(),
    persistenceManager: currentPersistence()
  });
  await refreshCurrentActor(tokenDocument.actor);
}

/** Repair a duplicated Actor only when copied cells still name the source Actor. */
export async function onCreateActorBg3Hud(actor, _options, userId) {
  if (!localCreator(userId) || !compatible(actor)) return;
  const state = actor.getFlag(BG3_HUD_CORE_ID, 'hudState');
  if (!state || !hasForeignBg3Cells(actor, state)) return;
  await rebuildBg3HudState(actor, { autoFill: autoPopulateEnabled(), persistenceManager: currentPersistence() });
  await refreshCurrentActor(actor);
}

/** Repair every synthetic Actor copied as part of duplicating a whole Scene. */
export async function onCreateSceneBg3Hud(scene, _options, userId) {
  if (!localCreator(userId)) return;
  const actors = new Map();
  for (const tokenDocument of scene.tokens) {
    if (tokenDocument.actorLink || !compatible(tokenDocument.actor)) continue;
    actors.set(tokenDocument.actor.uuid ?? tokenDocument.uuid, tokenDocument.actor);
  }
  for (const actor of actors.values()) {
    const state = actor.getFlag(BG3_HUD_CORE_ID, 'hudState');
    if (!state || hasForeignBg3Cells(actor, state)) {
      await rebuildBg3HudState(actor, { autoFill: autoPopulateEnabled(), persistenceManager: currentPersistence() });
    }
  }
}

/** Refresh stats, passives, effects, and cells after a displayed Actor document changes. */
export function onBg3HudDocumentChanged(document) {
  const actor = document?.documentName === 'Actor' ? document : document?.actor ?? document?.parent;
  const app = ui.BG3HUD_APP;
  if (!app?.rendered || !sameActor(app.currentActor, actor)) return;
  clearTimeout(app._emblemBg3DecorationTimer);
  app._emblemBg3DecorationTimer = setTimeout(async () => {
    await app.components?.hotbar?.activeEffectsContainer?.render?.();
    await app.components?.hotbar?.passivesContainer?.render?.();
    await app.components?.passives?.render?.();
    Hooks.callAll('emblemRpg.bg3HudDecorate', app);
  }, 80);
}

/** Refresh the displayed Actor after an embedded Item lifecycle change. */
export function onEmbeddedItemBg3Hud(item) { onBg3HudDocumentChanged(item); }

/**
 * Refresh the displayed unit's HUD when an encounter starts or ends, because encounterUnderway() decides whether
 * projectBg3HudView locks the counterattack toggle. init/hooks.mjs calls this on createCombat and deleteCombat, and on
 * updateCombat with the update's changes, which count only when they touch the round Combat#started reads or the
 * Combat's Scene.
 * @param {object|null} [changes] An updateCombat hook's changes; null for a created or deleted Combat.
 */
export function onCombatChangedBg3Hud(changes = null) {
  if (changes && !Object.hasOwn(changes, 'round') && !Object.hasOwn(changes, 'scene')) return;
  const actor = ui.BG3HUD_APP?.currentActor;
  if (actor) onBg3HudDocumentChanged(actor);
}

/* -------------------------------------------- */
/*  State helpers                               */
/* -------------------------------------------- */
function macroUuid(uuid) {
  return /^Macro\.[^.]+$/.test(String(uuid)) || /^Compendium\..+\.Macro\.[^.]+$/.test(String(uuid));
}

function currentPersistence() {
  return ui.BG3HUD_APP?.persistenceManager ?? ui.BG3HOTBAR?.persistenceManager ?? null;
}

function autoPopulateEnabled() {
  return readSetting('autoPopulateEnabled', false) === true;
}

function compatible(actor) {
  return globalThis.game?.system?.id === SYSTEM_ID && isBg3HudUnit(actor);
}

function localCreator(userId) {
  return globalThis.game?.system?.id === SYSTEM_ID && String(globalThis.game?.userId ?? globalThis.game?.user?.id ?? '')
    === String(userId ?? '');
}

function sameActor(left, right) {
  return Boolean(left && right && (left === right || left.uuid === right.uuid || left.id === right.id));
}

function clone(value) {
  return foundry.utils.deepClone(value);
}

async function refreshCurrentActor(actor) {
  const app = ui.BG3HUD_APP;
  if (!app?.rendered || !sameActor(app.currentActor, actor)) return;
  await refreshBg3HudGrids(app);
}

async function renderDetachedState(app, state) {
  if (app.updateCoordinator?.applyUnifiedState) {
    await app.updateCoordinator.applyUnifiedState(state);
    return;
  }
  const updates = [];
  for (let index = 0; index < (state.hotbar?.grids?.length ?? 0); index += 1) {
    const data = state.hotbar.grids[index];
    const grid = app.components?.hotbar?.gridContainers?.[index];
    if (!grid) continue;
    Object.assign(grid, { rows: data.rows, cols: data.cols, items: data.items });
    updates.push(grid.render?.());
  }
  await Promise.all(updates.filter(Boolean));
}
