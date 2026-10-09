/** @layer foundry/adapters/services */
import {
  ENCOUNTER_PHASE_FACTIONS,
  ENCOUNTER_PHASES
} from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID, pauseFreezesUser, resolveHostAuthority } from '../../../contracts/protocol.mjs';
import { footprintCells } from '../../../lib/core/geometry.mjs';
import { collectionValues, finite, isPlainObject } from '../../../lib/core/runtime.mjs';
import { HostPageSessions } from '../../../socket/host-presence.mjs';
import { projectUserLordUuid } from '../projections/parties.mjs';
import { STANCE_BREAK_EFFECT_NAME, STANCE_BREAK_STATUS_ID } from '../../../contracts/domains/damage.mjs';
import { reportFoundryError, reportFoundryProbe } from './diagnostics.mjs';

/* -------------------------------------------- */
/*  Lighting vocabularies                       */
/* -------------------------------------------- */
/**
 * The light animations this Foundry build offers, labelled in the client's language. Used by the light pickers in
 * the Terrain Builder and the effect editor.
 */
export function lightAnimationChoices() {
  const animations = globalThis.CONFIG?.Canvas?.lightAnimations ?? {};
  return Object.entries(animations).map(([value, definition]) => ({
    value,
    label: globalThis.game?.i18n?.localize?.(definition.label || value) ?? value
  }));
}

/** The coloration techniques Foundry's lighting shader offers, labelled in the client's language. Same pickers. */
export function lightColorationChoices() {
  const shader = globalThis.foundry?.canvas?.rendering?.shaders?.AdaptiveLightingShader;
  return Object.values(shader?.SHADER_TECHNIQUES ?? {}).map(technique => ({
    value: technique.id,
    label: globalThis.game?.i18n?.localize?.(technique.label) ?? String(technique.id)
  }));
}

/* -------------------------------------------- */
/*  Drag payloads                               */
/* -------------------------------------------- */
/**
 * Read a drop event's data with Foundry's TextEditor.getDragEventData, or from the raw dataTransfer when that
 * finds nothing. A bare UUID string comes back as {uuid}.
 * @param {object} event  The drop event.
 * @returns {object|null} The payload, or `null` when the drop carried nothing readable.
 */
export function readDropPayload(event) {
  try {
    const helper = globalThis.foundry?.applications?.ux?.TextEditor?.implementation?.getDragEventData
      ?? globalThis.foundry?.applications?.ux?.TextEditor?.getDragEventData;
    const payload = helper?.(event);
    if (payload && Object.keys(payload).length) return payload;
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'readDropPayload', diagnosticError instanceof SyntaxError);
  }
  if (!event?.dataTransfer) return null;
  for (const mime of ['text/plain', 'application/json']) {
    const raw = event.dataTransfer.getData(mime);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch (diagnosticError) {
      reportFoundryProbe(import.meta.url, diagnosticError, 'readDropPayload', true);
      return raw.includes('.') ? { uuid: raw.trim() } : null;
    }
  }
  return null;
}

/* -------------------------------------------- */
/*  Document resolution                         */
/* -------------------------------------------- */
/**
 * Resolve a UUID to its document with fromUuid. Errors are reported, not thrown.
 * @param {string} uuid Document UUID.
 * @param {string} [documentName] Required `documentName`, or empty for any document.
 * @returns {Promise<object|null>} null if the UUID doesn't resolve, or resolves to another document type.
 */
export async function resolveDocument(uuid, documentName = '') {
  if (!uuid) return null;
  try {
    const document = await globalThis.fromUuid(String(uuid));
    if (!document) return null;
    return !documentName || document.documentName === documentName ? document : null;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'resolveDocument');
    return null;
  }
}

export function resolveActor(uuid) {
  return resolveDocument(uuid, 'Actor');
}

export function resolveToken(uuid) {
  return resolveDocument(uuid, 'Token');
}

export function resolveScene(uuid) {
  return resolveDocument(uuid, 'Scene');
}

export function resolveItem(uuid) {
  return resolveDocument(uuid, 'Item');
}

/** The Armament Actor behind a weapon reference that names a placed Token rather than an Item. */
export async function resolveArmamentActor(uuid) {
  const token = await resolveToken(uuid);
  const actor = token?.actor ?? null;
  return actor?.type === 'Object' && String(actor.system?.objectType ?? '') === 'Armament' ? actor : null;
}

/**
 * resolveDocument without awaiting, through fromUuidSync, for render code that can't wait. An embedded document
 * inside a compendium can't be read this way and returns null.
 */
export function resolveSync(uuid, documentName = '') {
  if (!uuid) return null;
  try {
    const document = globalThis.fromUuidSync(String(uuid));
    if (!document) return null;
    return !documentName || document.documentName === documentName ? document : null;
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'resolveSync', /^fromUuidSync was invoked on UUID .*cannot be retrieved synchronously\.$/.test(String(diagnosticError?.message ?? '')));
    return null;
  }
}

/**
 * Resolve a Scene UUID without awaiting. With no UUID, returns the Scene this client is displaying. A UUID that no
 * longer resolves returns null, not the displayed Scene.
 */
export function resolveViewedScene(sceneUuid = '') {
  const named = String(sceneUuid ?? '');
  if (named) return resolveSync(named, 'Scene');
  return globalThis.canvas?.scene ?? null;
}

/* -------------------------------------------- */
/*  Host state                                  */
/* -------------------------------------------- */
/**
 * The other browser tabs this user has open, as heard over the socket (socket/host-presence.mjs fills it). With two
 * tabs of the Gamemaster open, neither can be the host client.
 */
export const HOST_PAGE_PEERS = new HostPageSessions();

/**
 * Work out which client is the host client, from the connected users and the number of other tabs this user has
 * open (resolveHostAuthority in contracts/protocol.mjs).
 * @returns {{state: string, hostUserId: string, hostUserIds: string[], localIsHost: boolean}}
 */
export function projectHostAuthority() {
  const users = collectionValues(globalThis.game?.users)
    .map(user => ({ id: String(user.id ?? ''), role: Number(user.role) || 0, active: user.active === true }));
  return resolveHostAuthority(users, localUserId(), { peerPages: HOST_PAGE_PEERS.size });
}

/**
 * Whether this client is the host client: the only connected Gamemaster, with a single browser tab open. Assistant
 * GMs never host, and nobody does while two Gamemasters, or two tabs of one, are connected. This is not Foundry's
 * game.users.activeGM, which core uses for its own GM-only writes.
 * @returns {boolean}
 */
export function isActiveGm() {
  return projectHostAuthority().localIsHost;
}

/** The id of the user on this client, which a document hook compares against the user who wrote. */
export function localUserId() {
  return String(globalThis.game?.user?.id ?? '');
}

/** Whether this client's user is an Assistant GM or the Gamemaster, read from Foundry's own role table. */
export function localUserIsStaff() {
  return Number(globalThis.game?.user?.role) >= CONST.USER_ROLES.ASSISTANT;
}

/** Whether the game is paused (Foundry's shared game.paused). */
export function worldPaused() {
  return globalThis.game?.paused === true;
}

/**
 * Whether the pause freezes this client's user (pauseFreezesUser), for input feedback. CommandDispatcher checks
 * the requesting user again on the host.
 */
export function localUserFrozenByPause() {
  return pauseFreezesUser({ paused: worldPaused(), isGm: localUserIsStaff() });
}

/** Read a setting, or return `fallback` when it's unset, not registered yet, or can't be read. */
export function readSetting(key, fallback = null, namespace = SYSTEM_ID) {
  try {
    return globalThis.game?.settings?.get?.(namespace, key) ?? fallback;
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'readSetting', globalThis.game?.ready !== true && /is not a registered game setting$/.test(String(diagnosticError?.message ?? '')));
    return fallback;
  }
}

/**
 * The marker Foundry puts on a serialized ForcedDeletion or ForcedReplacement, so the socket payload check
 * (socket/firewall.mjs) treats such an operator as one value rather than an object to walk into.
 */
export function dataOperatorIdentifier() {
  return globalThis.foundry?.data?.operators?.OPERATOR_IDENTIFIER ?? null;
}

/**
 * A detached deep copy. A DataModel or Document is copied from toObject(), its persisted source, so the copy can
 * be written back as it is.
 */
export function clone(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(typeof value.toObject === 'function' ? value.toObject() : value);
}

/**
 * Run creation data through its Foundry document class, so a caller can compare it with a persisted source rather
 * than with the shorthand it was authored in. Returns a plain copy when there's no document class or it throws.
 */
export function normalizedDocumentSource(documentName, data) {
  const DocumentClass = globalThis.CONFIG?.[String(documentName)]?.documentClass;
  if (typeof DocumentClass !== 'function') return clone(data);
  try {
    return new DocumentClass(clone(data), { parent: null, strict: false }).toObject();
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'normalizedDocumentSource');
    return clone(data);
  }
}

/** The saved values a document holds at the given dot-paths, as one flat `{path: value}` object. */
export function beforeImage(document, paths) {
  const source = document?._source ?? document;
  const image = {};
  for (const path of paths ?? []) image[path] = clone(globalThis.foundry?.utils?.getProperty?.(source, path) ?? null);
  return image;
}

/** Copy a beforeImage result for a flag, with each key's dots changed to '/' so Foundry doesn't expand them. */
export function packImage(image) {
  return Object.fromEntries(Object.entries(image ?? {}).map(([path, value]) => [path.replaceAll('.', '/'), clone(value)]));
}

const FLAG_KEY_DOT = '·';

/**
 * Copy a record for a flag, with the dots in every key (UUID keys included) changed to FLAG_KEY_DOT so Foundry
 * doesn't expand them.
 */
export function packFlagKeys(value) {
  if (Array.isArray(value)) return value.map(packFlagKeys);
  if (!isPlainObject(value)) return clone(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replaceAll('.', FLAG_KEY_DOT), packFlagKeys(entry)]));
}

/** Undo packFlagKeys on a record read back from a flag. */
export function unpackFlagKeys(value) {
  if (Array.isArray(value)) return value.map(unpackFlagKeys);
  if (!isPlainObject(value)) return clone(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replaceAll(FLAG_KEY_DOT, '.'), unpackFlagKeys(entry)]));
}

/**
 * Undo packImage on a value read back from a flag. One saved with its dots unescaped was expanded by Foundry into
 * nested objects, so it's flattened back to dotted paths.
 */
export function unpackImage(stored) {
  if (!stored || typeof stored !== 'object') return {};
  const entries = Object.entries(stored);
  if (entries.every(([key]) => key.includes('/') || !isPlainObject(stored[key]))) {
    return Object.fromEntries(entries.map(([key, value]) => [key.replaceAll('/', '.'), clone(value)]));
  }
  return clone(globalThis.foundry?.utils?.flattenObject?.(stored) ?? stored);
}

/**
 * The grid cells a live Token occupies, read from its pixel position.
 * @param {object} token TokenDocument or placeable with x, y, width and height.
 * @param {number} gridSize Scene grid size in pixels.
 * @returns {Array<{x: number, y: number}>}
 */
export function tokenFootprintCells(token, gridSize) {
  const grid = Math.max(1, Number(gridSize) || 1);
  return footprintCells((Number(token?.x) || 0) / grid, (Number(token?.y) || 0) / grid, token?.width, token?.height);
}

/**
 * A token's saved position and size (its _source), for game rules. The live document values can hold a move
 * animation's in-between position, or a stale one in a hidden tab.
 * @param {object|null} token TokenDocument or placeable, or a plain stub with x, y, width and height.
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function persistedTokenPosition(token) {
  const document = token?.document ?? token;
  if (!document) return null;
  const source = document._source ?? document;
  return {
    x: Number(source.x) || 0,
    y: Number(source.y) || 0,
    width: Number(source.width ?? document.width) || 1,
    height: Number(source.height ?? document.height) || 1
  };
}

/** The cells a token covers at its saved position (see persistedTokenPosition). */
export function persistedTokenFootprintCells(token, gridSize) {
  return tokenFootprintCells(persistedTokenPosition(token) ?? token, gridSize);
}

/**
 * Pixel centre of a token's saved position, counting it at least one square across. Wall tests between two units
 * measure from here.
 * @param {object|null} token TokenDocument or placeable.
 * @param {number} gridSize The pixel size of one square.
 * @returns {{x: number, y: number}}
 */
export function persistedTokenCenter(token, gridSize) {
  const position = persistedTokenPosition(token) ?? { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: finite(position.x) + (Math.max(1, finite(position.width) || 1) * gridSize / 2),
    y: finite(position.y) + (Math.max(1, finite(position.height) || 1) * gridSize / 2)
  };
}

/**
 * The pixel size of one square on the Scene a token stands on. It's read from that Scene, not the displayed canvas,
 * which may be showing another Scene.
 * @param {object} token TokenDocument or placeable.
 * @param {number} [fallback] Size returned when the token has no Scene grid.
 * @returns {number}
 */
export function tokenGridSize(token, fallback = 1) {
  const document = token?.document ?? token;
  return Number(document?.parent?.grid?.size) || fallback;
}

/* -------------------------------------------- */
/*  Canvas facilities                           */
/* -------------------------------------------- */
const PIXEL_ART_PATHS = Object.freeze([
  `systems/${SYSTEM_ID}/assets/`,
  '/emblem/items/',
  '/emblem/avatars/'
]);
const CONTENT_ASSET_PATH = /modules\/emblem-rpg-content[^/]*\/assets\//;

/** Re-derive every vision source on the displayed canvas, after something that decides who sees what changed. */
export function refreshCanvasVision() {
  const canvas = globalThis.canvas;
  if (!canvas?.ready) return false;
  canvas.perception.update({ initializeVision: true });
  return true;
}

/**
 * Whether this client can test walls on a Scene.
 *
 * Foundry's collision backend reads only the walls of the Scene this client has drawn, so another Scene's walls
 * cannot be tested here. A Scene without walls blocks nothing, wherever it is drawn.
 * @param {object} scene Scene document.
 * @returns {boolean}
 */
export function sceneWallsTestable(scene) {
  if (!scene) return false;
  if (!sceneHasWalls(scene)) return true;
  const canvas = globalThis.canvas;
  return canvas?.ready === true && Boolean(scene.uuid) && String(canvas.scene?.uuid ?? '') === String(scene.uuid);
}

/**
 * Test one wall collision between two pixel points on a Scene.
 * @param {object} scene The Scene both points lie on.
 * @param {{x: number, y: number}} origin Where the segment starts.
 * @param {{x: number, y: number}} destination Where it ends.
 * @param {string} [type] The wall restriction tested.
 * @returns {boolean|null} Whether a wall blocks the segment, or null when this client cannot test that Scene's walls.
 */
export function testSceneWallCollision(scene, origin, destination, type = 'sight') {
  if (!scene) return null;
  if (!sceneHasWalls(scene)) return false;
  if (!sceneWallsTestable(scene)) return null;
  const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.sight;
  if (typeof backend?.testCollision !== 'function') return false;
  return backend.testCollision(origin, destination, { mode: 'any', type }) === true;
}

function sceneHasWalls(scene) {
  const walls = scene?.walls;
  if (!walls) return false;
  return Number.isFinite(walls.size) ? walls.size > 0 : collectionValues(walls).length > 0;
}

/**
 * Identify system and system-declared module assets for pixel-art filtering. Third-party effect assets keep their
 * own filtering.
 * @param {string} file Effect file path.
 * @returns {boolean}
 */
export function isPixelArtAsset(file) {
  if (typeof file !== 'string' || !/\.(png|webp)(\?|$)/i.test(file)) return false;
  if (PIXEL_ART_PATHS.some(prefix => file.includes(prefix)) || CONTENT_ASSET_PATH.test(file)) return true;
  return systemContentModuleIds().some(id => file.includes(`modules/${id}/`));
}

/** Every installed module whose manifest declares this system, which is what makes its art the system's own. */
function systemContentModuleIds() {
  const systemId = String(globalThis.game?.system?.id ?? SYSTEM_ID);
  return collectionValues(globalThis.game?.modules)
    .filter(module => (module?.relationships?.systems ?? [])
      .some(relation => String(relation?.id ?? relation) === systemId))
    .map(module => String(module.id ?? ''))
    .filter(Boolean);
}

/** Switch a pixel-art texture to nearest-neighbour filtering so it scales crisp. Other art is left alone. */
export async function primePixelArtTexture(file) {
  if (!isPixelArtAsset(file)) return false;
  const load = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
  if (typeof load !== 'function') return false;
  const nearest = globalThis.PIXI?.SCALE_MODES?.NEAREST ?? 0;
  try {
    const texture = await load(file);
    const base = texture?.baseTexture ?? texture?.source;
    if (!base) return false;
    if (base.scaleMode !== nearest) {
      base.scaleMode = nearest;
      base.update?.();
    }
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'primePixelArtTexture');
    return false;
  }
}

/* -------------------------------------------- */
/*  Effect shape                                */
/* -------------------------------------------- */
/** A shallow copy of an effect's system flags, or {} when it has none. */
export function readEffectFlags(effect) {
  return { ...(effect?.flags?.[SYSTEM_ID] ?? {}) };
}

/** Whether an effect change adds to its target rather than overriding it, under v14's `type` or the older `mode`. */
export function isAdditiveEffectChange(change) {
  if (change?.type !== undefined) return change.type === 'add';
  return change?.mode === undefined || change.mode === 'add' || change.mode === 2;
}

/** Whether an effect is the stance break, however the effect that carries it was authored. */
export function isStanceBreakEffect(effect) {
  const statuses = effect?.statuses;
  return effect?.name === STANCE_BREAK_EFFECT_NAME
    || effect?.label === STANCE_BREAK_EFFECT_NAME
    || statuses?.has?.(STANCE_BREAK_STATUS_ID) === true
    || (Array.isArray(statuses) && statuses.includes(STANCE_BREAK_STATUS_ID))
    || effect?.flags?.core?.statusId === STANCE_BREAK_STATUS_ID;
}

/**
 * Rescale a stackable effect's additive changes from one stack count to another.
 * @param {object} effect Live ActiveEffect.
 * @param {number} current Stack count the stored values were written for.
 * @param {number} next Stack count they are being rewritten for.
 * @returns {Array<object>} Detached change records.
 */
export function stackRescale(effect, current, next) {
  const source = effect?._source?.system?.changes ?? effect?._source?.changes
    ?? effect?.system?.changes ?? effect?.changes ?? [];
  return collectionValues(source).map(raw => {
    const change = structuredClone(raw);
    if (!isAdditiveEffectChange(change)) return change;
    const value = Number(change.value);
    return Number.isFinite(value) && current > 0 ? { ...change, value: (value / current) * next } : change;
  });
}

/* -------------------------------------------- */
/*  Document updates                            */
/* -------------------------------------------- */
/** The update fragment that deletes one dot-path outright, through Foundry's ForcedDeletion operator. */
export function forcedDeletion(path) {
  return { [path]: new foundry.data.operators.ForcedDeletion() };
}

/**
 * The update fragment that replaces one dot-path whole rather than merging into it, through Foundry's
 * ForcedReplacement operator. Use it for an object or array that must not keep keys from the old value.
 */
export function forcedReplacement(path, value) {
  return { [path]: foundry.data.operators.ForcedReplacement.create(value) };
}

/** Move a token to a grid square with TokenDocument#move. Returns false if the move was refused. */
export async function displaceToken(token, destination, gridSize, options, action = 'displace') {
  const point = { x: Math.round(destination.x) * gridSize, y: Math.round(destination.y) * gridSize };
  return await token.move({ ...point, action }, options) !== false;
}

/* -------------------------------------------- */
/*  Canvas Token boundary                       */
/* -------------------------------------------- */
/**
 * Token lookups for animations and other display code: the document, and its placeable when this client has its
 * Scene drawn.
 */
export class FoundryCanvasTokenRepository {
  document(tokenUuid) {
    return resolveToken(tokenUuid);
  }

  /**
   * The token's placeable, or null when this client isn't displaying its Scene. The Scene and document UUIDs are
   * both checked because a copied Scene can reuse the same token ids.
   */
  async placeable(tokenUuid) {
    const document = await this.document(tokenUuid);
    if (!document) return null;
    if (document.object) return document.object;
    const canvas = globalThis.canvas;
    const sceneUuid = String(document.parent?.uuid ?? '');
    if (!sceneUuid || String(canvas?.scene?.uuid ?? '') !== sceneUuid) return null;
    const placeable = canvas?.tokens?.get?.(document.id) ?? null;
    return String(placeable?.document?.uuid ?? '') === String(document.uuid ?? '') ? placeable : null;
  }

  /**
   * The tokens the camera frames on this client when a player phase opens. A player gets their Lord, or their own
   * party units when they have no Lord on the displayed Scene. A GM gets the whole party.
   */
  phaseFocusPlaceables() {
    const user = globalThis.game?.user;
    const placeables = globalThis.canvas?.tokens?.placeables ?? [];
    const party = ENCOUNTER_PHASE_FACTIONS[ENCOUNTER_PHASES.PLAYER];
    const partyToken = token => party.includes(String(token.actor?.system?.faction?.role ?? ''));
    if (!user || user.isGM) return placeables.filter(partyToken);
    const lordUuid = projectUserLordUuid(user.id);
    const lord = placeables.filter(token => lordUuid && String(token.actor?.uuid ?? '') === lordUuid);
    if (lord.length) return lord;
    return placeables.filter(token => partyToken(token) && token.actor?.isOwner === true);
  }
}
