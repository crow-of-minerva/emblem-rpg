/** @layer foundry/adapters/document-writes */
import { SYSTEM_ID , recordDiagnostic } from '../../../contracts/protocol.mjs';
import {
  SPAWN_BEHAVIOR_FACTIONS,
  SPAWN_BEHAVIOR_VALUES,
  TERRAIN_EDIT_RECORDS_FLAG,
  TERRAIN_GRID_FLAG,
  TERRAIN_PERSISTENCE_CODES,
  TERRAIN_SPAWN_BEHAVIOR_FLAG,
  TERRAIN_SPAWN_FADE_MS,
  TERRAIN_SPAWN_STATE_FLAG,
  TERRAIN_ZONES_FLAG,
  terrainSpawnPresentationMessage
} from '../../../contracts/domains/terrain.mjs';
import { ENCOUNTER_TRACK_FLAGS } from '../../../contracts/domains/combat.mjs';
import { DOOR_WALL_FLAG } from '../../../contracts/domains/objects.mjs';
import {
  MOVEMENT_PERMISSION_FLAG,
  MOVE_SCALING_FLAG,
  normalizeMovementPermission,
  normalizeMoveScaling
} from '../../../game/movement/input-policy.mjs';
import { projectTerrainBoard } from '../projections/board.mjs';
import { parseTerrainKey, terrainCells } from '../../../game/terrain/rules.mjs';
import {
  readPersistedTerrainScene,
  readTerrainEditRecords,
  readTerrainGrid,
  readTerrainSpawnTokenData,
  readTerrainZones,
  readZoneCells,
  resolveTerrainSpawnReference
} from '../projections/terrain.mjs';
import { SequencerRuntime } from '../../../external/sequencer/runtime.mjs';
import { collectionValues, finite as finiteNumber } from '../../../lib/core/runtime.mjs';
import {
  forcedDeletion, forcedReplacement, isActiveGm as localUserIsActiveGm, packFlagKeys, unpackFlagKeys
} from '../services/host.mjs';
import { reportFoundryError , FoundryDiagnostics } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Flag paths                                  */
/* -------------------------------------------- */
const TERRAIN_GRID_PATH = `flags.${SYSTEM_ID}.${TERRAIN_GRID_FLAG}`;
const TERRAIN_ZONES_PATH = `flags.${SYSTEM_ID}.${TERRAIN_ZONES_FLAG}`;
const TERRAIN_EDIT_RECORDS_PATH = `flags.${SYSTEM_ID}.${TERRAIN_EDIT_RECORDS_FLAG}`;
const TERRAIN_SPAWN_STATE_PATH = `flags.${SYSTEM_ID}.${TERRAIN_SPAWN_STATE_FLAG}`;

/** Every square's arrival history, with its flag-safe keys unpacked (packFlagKeys in services/host.mjs). */
function readSpawnState(scene) {
  return unpackFlagKeys(scene.getFlag(SYSTEM_ID, TERRAIN_SPAWN_STATE_FLAG) ?? {});
}

/**
 * The Scene paths to capture for these squares' arrival records. On a map that has fired nothing yet the whole flag
 * is captured, so a rollback removes it rather than leaving an empty record behind.
 */
function spawnStatePaths(scene, stateKeys) {
  if (scene.getFlag(SYSTEM_ID, TERRAIN_SPAWN_STATE_FLAG) === undefined) return [TERRAIN_SPAWN_STATE_PATH];
  return stateKeys.map(key => `${TERRAIN_SPAWN_STATE_PATH}.${Object.keys(packFlagKeys({ [key]: null }))[0]}`);
}

/* -------------------------------------------- */
/*  Terrain writes                              */
/* -------------------------------------------- */

/**
 * The Terrain Builder's write port, bound to one Scene and handed to TerrainAuthoringService. The builder edits
 * outside CommandDispatcher. `replace` sends one Scene update in which each entry the plan rewrites is replaced
 * whole and each entry it drops is deleted, so a failed write can't leave an edit half applied.
 */
export function createTerrainReplacementPort(scene = globalThis.canvas?.scene, diagnostics = null) {
  requireTerrainScene(scene);
  return Object.freeze({
    diagnostics,
    replace: ({ deletePaths = [], replacements = {} } = {}) => {
      const changes = {};
      for (const path of deletePaths) {
        if (!Object.hasOwn(replacements, path)) Object.assign(changes, forcedDeletion(path));
      }
      for (const [path, value] of Object.entries(replacements)) {
        Object.assign(changes, forcedReplacement(path, value));
      }
      return Object.keys(changes).length ? scene.update(changes) : null;
    },
    planCellClear: cells => planCellClear(cells, scene),
    planEditReversion: cells => planEditReversion(cells, scene),
    planZoneCellRemoval: cells => planZoneCellRemoval(cells, scene),
    planZoneDeletion: zoneId => planZoneDeletion(zoneId, scene),
    planCellReplacement: entries => planCellReplacement(entries),
    createZone: (cells, options) => createTerrainZone(cells, options, scene),
    updateZone: (zoneId, patch) => updateTerrainZone(zoneId, patch, scene),
    addZoneCells: (zoneId, cells) => addTerrainCellsToZone(zoneId, cells, scene),
    createWalls: (segments, options) => createTerrainWalls(segments, options, scene),
    deleteWall: wallId => deleteTerrainWall(wallId, scene),
    clearWalls: () => clearTerrainWalls(scene),
    writeSceneSettings: settings => writeBuilderSceneSettings(settings, scene)
  });
}

/* -------------------------------------------- */
/*  Scene settings                              */
/* -------------------------------------------- */

async function writeBuilderSceneSettings(settings, scene = globalThis.canvas?.scene) {
  requireTerrainScene(scene);
  const changes = builderSceneChanges(settings ?? {});
  if (!Object.keys(changes).length) return { written: false, sceneUuid: String(scene.uuid ?? '') };
  await scene.update(changes);
  return { written: true, sceneUuid: String(scene.uuid ?? '') };
}

function builderSceneChanges(settings) {
  const has = key => Object.hasOwn(settings, key);
  const flags = {};
  for (const flag of Object.values(ENCOUNTER_TRACK_FLAGS)) {
    if (has(flag)) flags[flag] = String(settings[flag] ?? '');
  }
  if (has(MOVEMENT_PERMISSION_FLAG)) flags[MOVEMENT_PERMISSION_FLAG] = normalizeMovementPermission(settings[MOVEMENT_PERMISSION_FLAG]);
  if (has(MOVE_SCALING_FLAG)) flags[MOVE_SCALING_FLAG] = normalizeMoveScaling(settings[MOVE_SCALING_FLAG]);
  if (has('mapVisible')) flags.mapVisible = settings.mapVisible === true;
  const changes = Object.keys(flags).length ? { flags: { [SYSTEM_ID]: flags } } : {};
  if (has('tokenVision')) changes.tokenVision = settings.tokenVision === true;
  const fogMode = Number(settings.fogMode);
  if (has('fogMode') && Object.values(CONST.FOG_EXPLORATION_MODES).includes(fogMode)) {
    changes.fog = { mode: fogMode };
  }
  const environment = {};
  if (has('globalLight')) environment.globalLight = { enabled: settings.globalLight === true };
  if (has('darkness')) environment.darknessLevel = Math.min(1, Math.max(0, finiteNumber(settings.darkness, 0)));
  if (Object.keys(environment).length) changes.environment = environment;
  return changes;
}

/* -------------------------------------------- */
/*  Terrain consequences                        */
/* -------------------------------------------- */

/** Persist terrain spawns and timed edits for TerrainPhaseService. */
export class FoundryTerrainRepository {
  constructor({ present = null,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    this.present = present;
    this.wait = wait;
  }

  /** Project the board a spawn is placed on, together with what each square has already fired. */
  async getSpawnBoard(sceneUuid) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    if (!scene) return null;
    const board = projectTerrainBoard(scene);
    if (!board) return null;
    return {
      sceneUuid: String(scene.uuid ?? ''),
      grid: board.grid,
      bounds: board.bounds,
      occupied: board.occupied,
      state: readSpawnState(scene)
    };
  }

  /** Read the faction and footprint of an authored spawn without exposing its Actor. */
  async getSpawnReference(uuid) {
    const reference = await resolveTerrainSpawnReference(uuid);
    return reference?.isActor === true ? reference : null;
  }

  /** Choose the id an arrival will be created under, before anything is written. */
  randomId() {
    return foundry.utils.randomID();
  }

  /**
   * The UUID the arrival's Actor will have, for the phase command's lock keys. It works before an unlinked Token
   * exists by using the id reserved for it.
   */
  async spawnActorUuid({ sceneUuid, uuid, tokenId }) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    if (!scene) return '';
    const existing = scene.tokens.get(String(tokenId ?? '')) ?? null;
    if (existing) return String(existing.actor?.uuid ?? '');
    const data = await readTerrainSpawnTokenData(uuid, {});
    return data?.actorId ? `${scene.uuid}.Token.${tokenId}.Actor.${data.actorId}` : '';
  }

  /**
   * Create the arrival's Token. Its id and the square's arrival record are captured in one call, so the cooldown
   * recordSpawnState writes afterwards needs no capture of its own.
   */
  async createSpawn({ sceneUuid, uuid, tokenId, footprint, stateKey = '', operation = null }) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    if (!scene) return { ok: false, placed: false };
    const gridSize = scene.grid.size;
    const data = await readTerrainSpawnTokenData(uuid, {
      x: footprint.x * gridSize,
      y: footprint.y * gridSize
    });
    if (!data) return { ok: false, placed: false };
    let tokenDocument = null;
    try {
      await operation?.capture({
        creating: [{ parent: scene, documentName: 'Token', ids: [String(tokenId)] }],
        documents: stateKey ? [{ document: scene, paths: spawnStatePaths(scene, [stateKey]) }] : []
      });
      const payload = [{ ...data, _id: String(tokenId) }];
      tokenDocument = (await scene.createEmbeddedDocuments('Token', payload, { keepId: true }))?.[0] ?? null;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'createSpawn');
      return { ok: false, placed: false };
    }
    if (!tokenDocument) return { ok: false, placed: false };
    return { ok: true, placed: true, tokenUuid: String(tokenDocument.uuid ?? '') };
  }

  /**
   * Attach arrival behavior, broadcast the spawn ping and fade in the Token, then wait for the fade on the engine
   * clock. Everything written here belongs to the Token the same operation created, so nothing is captured.
   */
  async settleSpawn({ sceneUuid, tokenId, footprint, behavior = '' }) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    const tokenDocument = scene?.tokens.get(String(tokenId ?? '')) ?? null;
    if (!tokenDocument) return { ok: false, settled: false };
    try {
      await attachSpawnBehavior(tokenDocument, behavior);
      if (Number(tokenDocument.alpha) >= 1) {
        return { ok: true, settled: false, presented: false };
      }
      const gridSize = scene.grid.size;
      const [presented] = await Promise.all([
        this.#presentArrival(footprint, gridSize),
        tokenDocument.update({ alpha: 1 }, { animation: { duration: TERRAIN_SPAWN_FADE_MS } })
      ]);
      await this.wait(TERRAIN_SPAWN_FADE_MS);
      return { ok: true, settled: true, presented };
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'settleSpawn');
      return { ok: false, settled: false };
    }
  }

  /**
   * Record which squares have fired this round. A completed entry is the square's cooldown, which
   * `collectDueTerrainSpawns` reads on later phases, so it is ordinary Scene state captured like any other.
   */
  async recordSpawnState(sceneUuid, fired, operation = null) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    if (!scene || !Object.keys(fired ?? {}).length) return false;
    try {
      await operation?.capture({
        documents: [{ document: scene, paths: spawnStatePaths(scene, Object.keys(fired)) }]
      });
      await scene.setFlag(SYSTEM_ID, TERRAIN_SPAWN_STATE_FLAG,
        packFlagKeys({ ...readSpawnState(scene), ...structuredClone(fired) }));
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'recordSpawnState');
      return false;
    }
  }

  /** Forget every square's arrival history, so the next battle on this map starts fresh. */
  async clearSpawnState(sceneUuid, operation = null) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    if (!scene) return false;
    if (scene.getFlag(SYSTEM_ID, TERRAIN_SPAWN_STATE_FLAG) === undefined) return true;
    try {
      await operation?.capture({ documents: [{ document: scene, paths: [TERRAIN_SPAWN_STATE_PATH] }] });
      await scene.unsetFlag(SYSTEM_ID, TERRAIN_SPAWN_STATE_FLAG);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'clearSpawnState');
      return false;
    }
  }

  /** Read the grid and its edit journals together, so a sweep is planned against one consistent pair. */
  async getEditJournal(sceneUuid) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    if (!scene) return null;
    return {
      sceneUuid: String(scene.uuid ?? ''),
      grid: readTerrainGrid(scene),
      records: readTerrainEditRecords(scene)
    };
  }

  /**
   * Write each expired terrain cell and its journal entry in one Scene update.
   * Countdown-only changes update the counter, and restores use the receipt's saved after-image. When the caller runs
   * under a command, its `operation` captures exactly the flag entries this sweep rewrites before the update.
   */
  async applyEditSweep(sceneUuid, plan, operation = null) {
    const scene = await readPersistedTerrainScene(sceneUuid);
    if (!scene) return sweepAnswer(TERRAIN_PERSISTENCE_CODES.MISSING_SCENE);
    if (!plan?.cells?.length && !plan?.counters?.length && !plan?.restores?.length) {
      return sweepAnswer(TERRAIN_PERSISTENCE_CODES.NO_OP);
    }
    const records = readTerrainEditRecords(scene);
    const changes = {};
    const paths = new Set();
    let stale = 0;
    const write = (path, value) => {
      paths.add(path);
      Object.assign(changes, terrainFragment(path, value));
    };
    for (const cell of plan.cells ?? []) {
      if (!records?.[cell.key]) { stale += 1; continue; }
      write(`${TERRAIN_GRID_PATH}.${cell.key}`, cell.entry || null);
      write(`${TERRAIN_EDIT_RECORDS_PATH}.${cell.key}`, cell.record || null);
    }
    for (const counter of plan.counters ?? []) {
      if (!records?.[counter.key]) { stale += 1; continue; }
      const path = `${TERRAIN_EDIT_RECORDS_PATH}.${counter.key}.${counter.field}`;
      paths.add(path);
      changes[path] = counter.value;
    }
    for (const cell of plan.restores ?? []) write(`${TERRAIN_GRID_PATH}.${cell.key}`, cell.entry || null);
    if (!Object.keys(changes).length) {
      return sweepAnswer(stale ? TERRAIN_PERSISTENCE_CODES.STALE : TERRAIN_PERSISTENCE_CODES.NO_OP, { stale });
    }
    await operation?.capture({ documents: [{ document: scene, paths: [...paths] }] });
    try {
      await scene.update(changes);
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/terrain.mjs', error: diagnosticError, detail: 'applyEditSweep'
      });
      return sweepAnswer(TERRAIN_PERSISTENCE_CODES.WRITE_FAILED, { stale, diagnostic });
    }
    return sweepAnswer(TERRAIN_PERSISTENCE_CODES.APPLIED, { stale });
  }

  async #presentArrival(footprint, gridSize) {
    if (!this.present) return false;
    try {
      await this.present(terrainSpawnPresentationMessage({
        x: (footprint.x + footprint.width / 2) * gridSize,
        y: (footprint.y + footprint.height / 2) * gridSize
      }));
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'presentArrival');
      return false;
    }
  }
}

/** A sweep result. Its code says what happened: applied, a missing Scene, stale facts, a no-op or a failed write. */
function sweepAnswer(code, { stale = 0 } = {}) {
  return {
    ok: code !== TERRAIN_PERSISTENCE_CODES.MISSING_SCENE && code !== TERRAIN_PERSISTENCE_CODES.WRITE_FAILED,
    code,
    stale
  };
}

/**
 * Store spawn behavior on the unlinked Token’s Actor for the companion AI module.
 * Keep it off the shared world Actor so other copies retain their own behavior.
 */
async function attachSpawnBehavior(tokenDocument, behavior) {
  if (!behavior || !SPAWN_BEHAVIOR_VALUES.includes(behavior)) return;
  const actor = tokenDocument.actor;
  const faction = String(actor?.system?.faction?.role ?? '');
  if (!actor || !SPAWN_BEHAVIOR_FACTIONS.includes(faction)) return;
  if (actor.getFlag(SYSTEM_ID, TERRAIN_SPAWN_BEHAVIOR_FLAG) === behavior) return;
  await actor.update({ [`flags.${SYSTEM_ID}.${TERRAIN_SPAWN_BEHAVIOR_FLAG}`]: behavior });
}

/** One update fragment for a terrain path: the value written outright, or the key deleted when there is none. */
function terrainFragment(path, value) {
  return value ? forcedReplacement(path, value) : forcedDeletion(path);
}

/* -------------------------------------------- */
/*  Zone authoring                              */
/* -------------------------------------------- */

/** Create a zone and assign its elevation to every selected cell. */
async function createTerrainZone(cells, options = {}, scene = globalThis.canvas?.scene) {
  requireTerrainScene(scene);
  if (!cells?.length) return null;
  const id = foundry.utils.randomID();
  const level = finiteNumber(options.level, 0);
  const grid = readTerrainGrid(scene);
  const vacated = new Set();
  const update = {
    [`${TERRAIN_ZONES_PATH}.${id}`]: {
      id,
      name: String(options.name || 'Zone'),
      level,
      color: String(options.color || '#ffd24a')
    }
  };
  for (const key of cells) {
    if (grid[key]?.zoneId && grid[key].zoneId !== id) vacated.add(grid[key].zoneId);
    update[`${TERRAIN_GRID_PATH}.${key}.zoneId`] = id;
    update[`${TERRAIN_GRID_PATH}.${key}.elevation`] = level;
  }
  await scene.update(update);
  await pruneEmptyZones(vacated, scene);
  return id;
}

/** Add cells to an existing zone and mirror the zone elevation. */
async function addTerrainCellsToZone(zoneId, cells, scene = globalThis.canvas?.scene) {
  requireTerrainScene(scene);
  const zone = readTerrainZones(scene)[zoneId];
  if (!zone || !cells?.length) return;
  const grid = readTerrainGrid(scene);
  const vacated = new Set();
  const update = {};
  for (const key of cells) {
    if (grid[key]?.zoneId && grid[key].zoneId !== zoneId) vacated.add(grid[key].zoneId);
    update[`${TERRAIN_GRID_PATH}.${key}.zoneId`] = zoneId;
    update[`${TERRAIN_GRID_PATH}.${key}.elevation`] = finiteNumber(zone.level, 0);
  }
  await scene.update(update);
  await pruneEmptyZones(vacated, scene);
}

/** Update zone metadata and mirror a changed level onto member cells. */
async function updateTerrainZone(zoneId, patch, scene = globalThis.canvas?.scene) {
  requireTerrainScene(scene);
  if (!readTerrainZones(scene)[zoneId]) return;
  const update = { [`${TERRAIN_ZONES_PATH}.${zoneId}`]: { ...patch } };
  if (Object.hasOwn(patch ?? {}, 'level')) {
    for (const key of readZoneCells(zoneId, scene)) {
      update[`${TERRAIN_GRID_PATH}.${key}.elevation`] = finiteNumber(patch.level, 0);
    }
  }
  await scene.update(update);
}

async function pruneEmptyZones(zoneIds, scene) {
  if (!zoneIds?.size) return;
  const used = new Set(Object.values(readTerrainGrid(scene)).map(entry => entry?.zoneId).filter(Boolean));
  const update = {};
  for (const id of zoneIds) {
    if (!used.has(id) && readTerrainZones(scene)[id]) {
      Object.assign(update, forcedDeletion(`${TERRAIN_ZONES_PATH}.${id}`));
    }
  }
  if (Object.keys(update).length) await scene.update(update);
}

/* -------------------------------------------- */
/*  Replacement planning                        */
/* -------------------------------------------- */
/**
 * Plan a bulk square rewrite: every named square is cleared, then the ones with content are written back.
 * @param {Record<string, object>} entries Authored entries by cell key. An empty entry clears the square.
 * @returns {{deletePaths: string[], replacements: object}}
 */
function planCellReplacement(entries) {
  const deletePaths = [];
  const replacements = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    deletePaths.push(`${TERRAIN_GRID_PATH}.${key}`);
    if (entry && Object.keys(entry).length > 0) replacements[`${TERRAIN_GRID_PATH}.${key}`] = entry;
  }
  return { deletePaths, replacements };
}

function planCellClear(cells, scene) {
  const grid = readTerrainGrid(scene);
  const selected = new Set(cells ?? []);
  const deletePaths = [...selected].filter(key => grid[key]).map(key => `${TERRAIN_GRID_PATH}.${key}`);
  const vacated = new Set([...selected].map(key => grid[key]?.zoneId).filter(Boolean));
  deletePaths.push(...emptyZonePaths(grid, readTerrainZones(scene), vacated, selected));
  return { deletePaths, replacements: {} };
}

function planEditReversion(cells, scene) {
  const edits = readTerrainEditRecords(scene);
  const deletePaths = [];
  const replacements = {};
  for (const key of cells ?? []) {
    const record = edits[key];
    if (!record) continue;
    deletePaths.push(`${TERRAIN_GRID_PATH}.${key}`, `${TERRAIN_EDIT_RECORDS_PATH}.${key}`);
    if (record.original && typeof record.original === 'object') {
      replacements[`${TERRAIN_GRID_PATH}.${key}`] = structuredClone(record.original);
    }
  }
  return { deletePaths, replacements };
}

function planZoneCellRemoval(cells, scene, deletedZoneId = '') {
  const grid = readTerrainGrid(scene);
  const selected = new Set(cells ?? []);
  const deletePaths = [];
  const replacements = {};
  const vacated = new Set();
  for (const key of selected) {
    const entry = grid[key];
    if (!entry?.zoneId) continue;
    vacated.add(entry.zoneId);
    const remaining = { ...entry };
    delete remaining.zoneId;
    delete remaining.elevation;
    deletePaths.push(`${TERRAIN_GRID_PATH}.${key}`);
    if (Object.keys(remaining).length) replacements[`${TERRAIN_GRID_PATH}.${key}`] = remaining;
  }
  if (deletedZoneId) deletePaths.push(`${TERRAIN_ZONES_PATH}.${deletedZoneId}`);
  else deletePaths.push(...emptyZonePaths(grid, readTerrainZones(scene), vacated, selected));
  return { deletePaths, replacements };
}

function planZoneDeletion(zoneId, scene) {
  if (!readTerrainZones(scene)[zoneId]) return { deletePaths: [], replacements: {} };
  return planZoneCellRemoval(readZoneCells(zoneId, scene), scene, zoneId);
}

function emptyZonePaths(grid, zones, candidates, removedCells) {
  const retainedZones = new Set(Object.entries(grid)
    .filter(([key]) => !removedCells.has(key))
    .map(([, entry]) => entry?.zoneId)
    .filter(Boolean));
  return [...candidates]
    .filter(zoneId => zones[zoneId] && !retainedZones.has(zoneId))
    .map(zoneId => `${TERRAIN_ZONES_PATH}.${zoneId}`);
}

/* -------------------------------------------- */
/*  Wall authoring                              */
/* -------------------------------------------- */

/**
 * Create builder-authored walls with the restrictions the builder chose, each an `EDGE_SENSE_TYPES` value. A
 * restriction left out keeps the builder's default: movement and sight blocked, light and sound let through.
 * Thresholds arrive in squares and are stored in the Scene's distance units, only for a sense that uses one.
 */
async function createTerrainWalls(segments, restrictions = {}, scene = globalThis.canvas?.scene) {
  requireTerrainScene(scene);
  const { EDGE_SENSE_TYPES: sense, WALL_MOVEMENT_TYPES: movement } = globalThis.CONST;
  const senseTypes = new Set(Object.values(sense));
  const senseOf = (key, fallback) => {
    const value = Number(restrictions[key]);
    return senseTypes.has(value) ? value : fallback;
  };
  const senses = {
    sight: senseOf('sight', sense.NORMAL),
    light: senseOf('light', sense.NONE),
    sound: senseOf('sound', sense.NONE)
  };
  const distance = Number(scene.grid?.distance) || 1;
  const thresholdOf = key => {
    const squares = Number(restrictions.threshold?.[key]);
    const usesThreshold = senses[key] === sense.PROXIMITY || senses[key] === sense.DISTANCE;
    return usesThreshold && squares > 0 ? squares * distance : null;
  };
  const threshold = {
    sight: thresholdOf('sight'),
    light: thresholdOf('light'),
    sound: thresholdOf('sound'),
    attenuation: restrictions.threshold?.attenuation === true
  };
  const move = senseOf('move', sense.NORMAL) === sense.NONE ? movement.NONE : movement.NORMAL;
  return scene.createEmbeddedDocuments('Wall', segments.map(segment => ({
    c: [segment.x0, segment.y0, segment.x1, segment.y1],
    move,
    ...senses,
    threshold
  })));
}

/** Delete one builder-selected wall. */
async function deleteTerrainWall(wallId, scene = globalThis.canvas?.scene) {
  requireTerrainScene(scene);
  if (wallId) await scene.deleteEmbeddedDocuments('Wall', [wallId]);
}

/** Delete every wall the builder can edit, leaving a locked Door's own walls to door reconciliation. */
async function clearTerrainWalls(scene = globalThis.canvas?.scene) {
  requireTerrainScene(scene);
  const wallIds = collectionValues(scene.walls)
    .filter(wall => !wall.getFlag(SYSTEM_ID, DOOR_WALL_FLAG))
    .map(wall => String(wall.id));
  if (wallIds.length) await scene.deleteEmbeddedDocuments('Wall', wallIds);
  return wallIds.length;
}

/* -------------------------------------------- */
/*  Generated Scene placeables                  */
/* -------------------------------------------- */
let placeableSync = null;
let queuedPlaceableScene = null;

/** Reconcile painted light and audio fields into Foundry embedded documents. */
export async function syncTerrainPlaceables(scene = globalThis.canvas?.scene) {
  if (!localUserIsActiveGm() || !scene || !globalThis.canvas?.grid) return;
  if (placeableSync) {
    queuedPlaceableScene = scene;
    return placeableSync;
  }
  placeableSync = Promise.all([syncTerrainLights(scene), syncTerrainSounds(scene)]).finally(() => {
    placeableSync = null;
    if (queuedPlaceableScene) {
      const nextScene = queuedPlaceableScene;
      queuedPlaceableScene = null;
      void syncTerrainPlaceables(nextScene);
    }
  });
  return placeableSync;
}

async function syncTerrainLights(scene) {
  const grid = readTerrainGrid(scene);
  const groups = groupTerrainCells(grid, scene, entry => entry.lightKey && entry.light
    ? { key: entry.lightKey, data: entry.light }
    : null);
  const existing = embeddedByTerrainFlag(scene.lights, 'terrainLightKey');
  const distance = Number(scene.grid?.distance) || 1;
  const desired = new Map();
  for (const [key, group] of groups) {
    const light = group.data;
    const data = {
      x: Math.round(group.x / group.count),
      y: Math.round(group.y / group.count),
      walls: light.walls !== false,
      vision: light.vision !== false,
      config: {
        dim: (Number(light.dim) || 0) * distance,
        bright: (Number(light.bright) || 0) * distance,
        color: light.color || null,
        alpha: clamp(light.alpha, 0, 1, 0.5),
        coloration: clampInt(light.coloration, 0, 101, 1),
        luminosity: clamp(light.luminosity, -1, 1, 0.5),
        attenuation: clamp(light.attenuation, 0, 1, 0.5),
        saturation: clamp(light.saturation, -1, 1, 0),
        contrast: clamp(light.contrast, -1, 1, 0),
        shadows: clamp(light.shadows, 0, 1, 0),
        animation: {
          type: light.animType || null,
          speed: clampInt(light.animSpeed, 1, 10, 5),
          intensity: clampInt(light.animIntensity, 1, 10, 5)
        }
      }
    };
    desired.set(key, { data, signature: JSON.stringify(data) });
  }
  await reconcileEmbeddedDocuments(scene, 'AmbientLight', existing, desired, 'terrainLightKey', 'terrainLightSig');
}

async function syncTerrainSounds(scene) {
  const grid = readTerrainGrid(scene);
  const groups = groupTerrainCells(grid, scene, entry => entry.audioKey && entry.audioFile
    ? { key: entry.audioKey, data: entry }
    : null);
  const existing = embeddedByTerrainFlag(scene.sounds, 'terrainAudioKey');
  const distance = Number(scene.grid?.distance) || 1;
  const desired = new Map();
  for (const [key, group] of groups) {
    const file = SequencerRuntime.resolveSoundPath(group.data.audioFile);
    if (!file) {
      if (existing.has(key)) desired.set(key, { preserve: true });
      continue;
    }
    const radius = Number(group.data.audioRadius) > 0 ? Number(group.data.audioRadius) : 3;
    const volume = clamp(group.data.audioVolume, 0, 1, 0.8);
    const data = {
      x: Math.round(group.x / group.count),
      y: Math.round(group.y / group.count),
      radius: radius * distance,
      path: file,
      volume,
      easing: group.data.audioEasing !== false,
      repeat: true,
      walls: false
    };
    desired.set(key, { data, signature: JSON.stringify(data) });
  }
  await reconcileEmbeddedDocuments(scene, 'AmbientSound', existing, desired, 'terrainAudioKey', null);
}

function groupTerrainCells(grid, scene, project) {
  const groups = new Map();
  const gridSize = scene.grid.size;
  for (const [key, entry] of terrainCells(grid)) {
    const projected = project(entry);
    if (!projected) continue;
    const { x, y } = parseTerrainKey(key);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const group = groups.get(projected.key) ?? { x: 0, y: 0, count: 0, data: projected.data };
    group.x += (x + 0.5) * gridSize;
    group.y += (y + 0.5) * gridSize;
    group.count += 1;
    groups.set(projected.key, group);
  }
  return groups;
}

function embeddedByTerrainFlag(collection, flagName) {
  const result = new Map();
  for (const document of collectionValues(collection)) {
    const key = document.getFlag(SYSTEM_ID, flagName);
    if (key) result.set(key, document);
  }
  return result;
}

async function reconcileEmbeddedDocuments(scene, documentName, existing, desired, keyFlag, signatureFlag) {
  const toDelete = [...existing].filter(([key]) => !desired.has(key)).map(([, document]) => document.id);
  const toCreate = [];
  const toUpdate = [];
  for (const [key, target] of desired) {
    if (target.preserve) continue;
    const document = existing.get(key);
    if (!document) {
      const flags = { [SYSTEM_ID]: { [keyFlag]: key } };
      if (signatureFlag) flags[SYSTEM_ID][signatureFlag] = target.signature;
      toCreate.push({ ...target.data, flags });
      continue;
    }
    const currentSignature = signatureFlag
      ? document.getFlag(SYSTEM_ID, signatureFlag)
      : JSON.stringify(projectEmbeddedDocument(document, target.data));
    if (currentSignature === target.signature) continue;
    const update = { _id: document.id, ...target.data };
    if (signatureFlag) update[`flags.${SYSTEM_ID}.${signatureFlag}`] = target.signature;
    toUpdate.push(update);
  }
  if (toDelete.length) await scene.deleteEmbeddedDocuments(documentName, toDelete);
  if (toCreate.length) await scene.createEmbeddedDocuments(documentName, toCreate);
  if (toUpdate.length) await scene.updateEmbeddedDocuments(documentName, toUpdate);
}

function projectEmbeddedDocument(document, target) {
  return Object.fromEntries(Object.keys(target).map(key => [key, document[key]]));
}

/* -------------------------------------------- */
/*  Guards and clamps                           */
/* -------------------------------------------- */

function requireTerrainScene(scene) {
  if (!globalThis.game?.user?.isGM) throw new Error('Only a GM may author terrain.');
  if (!scene) throw new Error('Terrain authoring requires an active Scene.');
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function clampInt(value, minimum, maximum, fallback) {
  return Math.round(clamp(value, minimum, maximum, fallback));
}
