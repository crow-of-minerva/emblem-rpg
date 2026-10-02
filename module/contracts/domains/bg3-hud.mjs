/** @layer contracts/domains */
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';
import { RESULT_CODES } from '../results.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
export const BG3_HUD_CORE_ID = 'bg3-hud-core';
export const BG3_HUD_CORE_VERSION = '0.6.0';
export const BG3_HUD_CORE_VERSION_CEILING = '0.7.0';

/**
 * Whether an installed BG3 HUD Core version is one this adapter was written against: 0.6.0 up to, but not
 * including, 0.7.0. Patch releases keep the hooks and classes the adapter relies on, and a new minor version may not.
 */
export function isSupportedBg3HudCoreVersion(version, compare) {
  const found = String(version ?? '');
  if (!found) return true;
  if (typeof compare !== 'function') return found === BG3_HUD_CORE_VERSION;
  return !compare(BG3_HUD_CORE_VERSION, found) && compare(BG3_HUD_CORE_VERSION_CEILING, found);
}

export const BG3_HUD_INTENTS = Object.freeze({
  GM_BAR: 'gm-bar',
  TOKEN_ACTIVE: 'token-active',
  TOKEN_VIEW_ONLY: 'token-view-only',
  PLAYER_HIDDEN: 'player-hidden'
});

export const BG3_HUD_MAX_ROWS = 4;

/** The hook a read-only inspection raises with the inspected Token, and with null when it ends. */
export const INSPECT_TOKEN_HOOK = 'emblemRpg.inspectToken';
export const BG3_HUD_SCALE = Object.freeze({ min: 0.5, max: 1, step: 0.01 });

/** Notice ids the BG3 HUD adapter emits. presentation/interface/bg3-hud.mjs maps them to notification ids. */
export const BG3_HUD_NOTICES = Object.freeze({
  NO_ACTOR: 'no-actor',
  PERSISTENCE_UNAVAILABLE: 'persistence-unavailable',
  AUTO_POPULATE_UNAVAILABLE: 'auto-populate-unavailable',
  HOTBAR_COMPLETE: 'hotbar-complete',
  RESYNC_SELECT_TOKEN: 'resync-select-token',
  RESYNC_NOT_OWNED: 'resync-not-owned',
  INSPECTING_UNIT: 'inspecting-unit'
});

/** Address one displayed cell, so the same Item placed in several slots stays distinguishable. */
export function bg3HudCellAddress(cell) {
  if (!cell) return '';
  const container = String(cell.containerType ?? '');
  const index = Number(cell.index);
  if (!container || !Number.isInteger(index)) return '';
  return `${container}:${Number(cell.containerIndex) || 0}:${index}`;
}

/* -------------------------------------------- */
/*  Visibility                                  */
/* -------------------------------------------- */
/**
 * Which HUD an application is showing: a unit's, the GM's, or none.
 * @param {object} app             The core HUD application.
 * @param {boolean} isGamemaster   Whether the local user runs the game.
 * @returns {'actor'|'gm'|'hidden'}
 */
export function bg3HudKind(app, isGamemaster) {
  if (app?.currentToken && app?.currentActor) return 'actor';
  return isGamemaster ? 'gm' : 'hidden';
}

/**
 * Choose the BG3 HUD refresh transition: cover a rebuild from one unit to another, and fade when switching between
 * a unit, the GM bar and no HUD.
 * @param {object} previous  The `{kind, tokenId}` the HUD was showing.
 * @param {object} next      The `{kind, tokenId}` it is about to show.
 * @returns {'settle'|'rebuild'|'fade-in'|'fade-out'}
 */
export function bg3HudTransition(previous, next) {
  if (previous.kind === next.kind && previous.tokenId === next.tokenId) return 'settle';
  if (previous.kind === 'actor' && next.kind === 'actor') return 'rebuild';
  if ((previous.kind === 'hidden' && next.kind !== 'hidden')
    || (previous.kind === 'gm' && next.kind === 'actor')) return 'fade-in';
  if ((previous.kind !== 'hidden' && next.kind === 'hidden')
    || (previous.kind === 'actor' && next.kind === 'gm')) return 'fade-out';
  return 'rebuild';
}

/* -------------------------------------------- */
/*  Shared layouts                              */
/* -------------------------------------------- */
/** The system flag counting a unit's saved hotbar layouts, which a save names to prove it is not stale. */
export const BG3_HUD_LAYOUT_REVISION_FLAG = 'hotbarLayoutRevision';

/**
 * Layout-save results returned by the hotbar save command. Only INVALID shows a notice, and the HUD reloads a stale
 * layout.
 */
export const HOTBAR_LAYOUT_OUTCOMES = Object.freeze({
  SAVED: RESULT_CODES.HOTBAR_LAYOUT_SAVED,
  STALE: RESULT_CODES.HOTBAR_LAYOUT_STALE,
  INVALID: RESULT_CODES.HOTBAR_LAYOUT_INVALID
});

const HOTBAR_LAYOUT_INTENT_KEYS = Object.freeze(['actorUuid', 'state', 'expectedRevision']);

/** The largest serialized layout a save carries, well inside the command envelope. */
const HOTBAR_LAYOUT_MAX_CHARACTERS = 48 * 1024;

/**
 * Check one layout save: the unit, its whole HUD state, and the revision the state was arranged from. The state is
 * returned as a separate, writable copy, since the host writes it into a document update.
 * @param {object} payload The command payload.
 * @returns {{actorUuid: string, state: object, expectedRevision: number}|null}
 */
export function normalizeHotbarLayoutIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, HOTBAR_LAYOUT_INTENT_KEYS)) return null;
  const actorUuid = String(payload.actorUuid ?? '');
  const revision = payload.expectedRevision;
  if (!boundedText(actorUuid, 512) || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (!plainRecord(payload.state)) return null;
  const serialized = JSON.stringify(payload.state);
  if (serialized.length > HOTBAR_LAYOUT_MAX_CHARACTERS) return null;
  return Object.freeze({ actorUuid, state: JSON.parse(serialized), expectedRevision: revision });
}

/** Every group of cells a HUD state holds: hotbar grids, weapon sets and quick access, with saved views on request. */
export function bg3HudCellGroups(state, includeViews = false) {
  const groups = [];
  const collect = source => {
    for (const grid of source?.hotbar?.grids ?? []) if (grid?.items) groups.push(grid.items);
    for (const set of source?.weaponSets?.sets ?? []) if (set?.items) groups.push(set.items);
    for (const grid of source?.quickAccess?.grids ?? []) if (grid?.items) groups.push(grid.items);
  };
  collect(state);
  if (includeViews) for (const view of state?.views?.list ?? []) collect(view?.hotbarState);
  return groups;
}

/**
 * Remove, in place, every cell naming a document the unit does not carry, saved views included. Macros are world
 * documents and stay.
 * @param {object} state A copy of the HUD state, changed in place.
 * @param {string[]} carriedUuids The uuids of every Item the unit carries.
 * @returns {number} How many cells were removed.
 */
export function pruneForeignHudCells(state, carriedUuids = []) {
  const carried = new Set(carriedUuids);
  let removed = 0;
  for (const items of bg3HudCellGroups(state, true)) {
    for (const [key, cell] of Object.entries(items)) {
      if (!cell?.uuid || cell.type === 'Macro' || carried.has(cell.uuid)) continue;
      delete items[key];
      removed += 1;
    }
  }
  return removed;
}
