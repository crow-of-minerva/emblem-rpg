/** @layer foundry/adapters/projections */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import {
  TERRAIN_EDIT_RECORDS_FLAG,
  TERRAIN_GRID_FLAG,
  TERRAIN_ZONES_FLAG,
  parseTerrainKey
} from '../../../contracts/domains/terrain.mjs';
import { DOOR_WALL_FLAG } from '../../../contracts/domains/objects.mjs';
import {
  projectTerrainMovement, terrainCells, terrainExceptions, terrainProfileClass
} from '../../../game/terrain/rules.mjs';
import { objectivePointsOf } from '../../../game/combat/objectives.mjs';
import { landingBlocked, terrainBoundsTravelByDistance } from '../../../game/movement/pathfinding.mjs';
import { geometrySightCells } from '../../../game/targeting/shapes.mjs';
import {
  persistedTokenPosition, resolveDocument, resolveViewedScene, sceneWallsTestable
} from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Palette                                     */
/* -------------------------------------------- */
const ZONE_PALETTE = Object.freeze([
  '#ffd24a', '#4ad2ff', '#ff6f6f', '#7ce04a', '#c08cff', '#ff9f40', '#5ad6b0'
]);

/* -------------------------------------------- */
/*  Scene reads                                 */
/* -------------------------------------------- */
const TERRAIN_FLAGS = Object.freeze([TERRAIN_GRID_FLAG, TERRAIN_ZONES_FLAG, TERRAIN_EDIT_RECORDS_FLAG]);
const TERRAIN_READS = new WeakMap();
const TERRAIN_ELEVATIONS = new WeakMap();
const TERRAIN_MOVEMENTS = new WeakMap();

/**
 * A copy of one terrain flag, cached so repeated movement reads don't clone it again. The cache is keyed on the
 * flag's `_source` object because Scene preparation replaces the prepared flags without changing any terrain.
 * forgetTerrainReads clears it on every real Scene update, including edits made in place.
 */
function readTerrainFlag(scene, flag) {
  const live = scene?.getFlag?.(SYSTEM_ID, flag);
  if (!live || typeof live !== 'object') return {};
  const key = terrainFlagIdentity(scene, flag) ?? live;
  const kept = TERRAIN_READS.get(key);
  if (kept) return kept;
  const copy = structuredClone(live);
  TERRAIN_READS.set(key, copy);
  return copy;
}

/**
 * Drop the cached terrain reads of one Scene, whether or not its update replaced the flag objects. init/hooks.mjs
 * calls it on every Scene update.
 */
export function forgetTerrainReads(scene) {
  for (const flag of TERRAIN_FLAGS) {
    const key = terrainFlagIdentity(scene, flag);
    if (key) TERRAIN_READS.delete(key);
    const live = scene?.getFlag?.(SYSTEM_ID, flag);
    if (live && typeof live === 'object') TERRAIN_READS.delete(live);
  }
}

/** The object a Scene's terrain flag is cached under: its source form, or the prepared one when there is none. */
function terrainFlagIdentity(scene, flag) {
  const source = scene?._source?.flags?.[SYSTEM_ID]?.[flag];
  if (source && typeof source === 'object') return source;
  const live = scene?.getFlag?.(SYSTEM_ID, flag);
  return live && typeof live === 'object' ? live : null;
}

/** A cached copy of a Scene's terrain grid, so no caller holds the flag object itself. No Scene reads as `{}`. */
export function readTerrainGrid(scene) {
  return readTerrainFlag(scene, TERRAIN_GRID_FLAG);
}

/** The terrain elevation of every raised or sunken cell on a Scene, keyed by movement cell and cached per grid. */
export function readTerrainElevations(scene) {
  const grid = readTerrainGrid(scene);
  const kept = TERRAIN_ELEVATIONS.get(grid);
  if (kept) return kept;
  const elevations = {};
  for (const [key, entry] of terrainCells(grid)) {
    const elevation = Number(entry.elevation) || 0;
    if (!elevation) continue;
    const { x, y } = parseTerrainKey(key);
    elevations[`${x},${y}`] = elevation;
  }
  const frozen = Object.freeze(elevations);
  TERRAIN_ELEVATIONS.set(grid, frozen);
  return frozen;
}

/**
 * The terrain costs and blockers pathfinding reads for one kind of unit, from projectTerrainMovement in
 * game/terrain/rules.mjs. Results are cached per grid and per unit class (airborne, mounted, cost reduction and
 * which terrain exceptions apply), so units of the same class share one copy.
 * @param {object} scene The Scene whose terrain is read.
 * @param {object|null} profile The unit's terrain profile, as {@link normalizeTerrainProfile} shapes it.
 * @param {{airborne?: boolean, mounted?: boolean, terrainCostReduction?: number}} [options]
 * @returns {Readonly<object>} Frozen movement terrain, shared with every unit of the same class.
 */
export function readTerrainMovement(scene, profile, { airborne = false, mounted = false, terrainCostReduction = 0 } = {}) {
  const grid = readTerrainGrid(scene);
  const zones = readTerrainZones(scene);
  let kept = TERRAIN_MOVEMENTS.get(grid);
  if (!kept || kept.zones !== zones) {
    kept = { zones, exceptions: terrainExceptions(grid), byClass: new Map() };
    TERRAIN_MOVEMENTS.set(grid, kept);
  }
  const unitClass = `${airborne ? 1 : 0}${mounted ? 1 : 0}:${Number(terrainCostReduction) || 0}:${terrainProfileClass(kept.exceptions, profile)}`;
  const found = kept.byClass.get(unitClass);
  if (found) return found;
  const movement = projectTerrainMovement(grid, profile, { airborne, mounted, terrainCostReduction, zones });
  kept.byClass.set(unitClass, movement);
  return movement;
}

/**
 * Whether an obstacle lies under a token's saved position, so a flier there couldn't land (landingBlocked in
 * game/movement/pathfinding.mjs).
 * @param {object} token TokenDocument or placeable.
 * @returns {boolean}
 */
export function projectLandingBlocked(token) {
  const scene = (token?.document ?? token)?.parent;
  const gridSize = Number(scene?.grid?.size);
  const position = persistedTokenPosition(token);
  if (!scene || !(gridSize > 0) || !position) return false;
  return landingBlocked(
    { x: Math.floor(position.x / gridSize), y: Math.floor(position.y / gridSize) },
    { width: position.width, height: position.height },
    readTerrainMovement(scene, null).obstacles
  );
}

/**
 * The whole map's terrain for the Enemy AI planner: its Defend objective squares, its teleports, its elevations,
 * and whether straight-line distance is still a lower bound on travel. The Enemy AI reads it as
 * game.emblemRpg.api.terrain.getBoard.
 * @param {string} [sceneUuid] Scene to read, defaulting to the displayed one.
 * @returns {import('../../../api/types.mjs').TerrainBoard|null} Null when the Scene can't be found.
 */
export function projectTerrainMeasurementBoard(sceneUuid = '') {
  const scene = resolveViewedScene(sceneUuid);
  if (!scene) return null;
  const grid = readTerrainGrid(scene);
  const movement = projectTerrainMovement(grid, null, { zones: readTerrainZones(scene) });
  const gridSize = Number(scene.grid?.size) || 1;
  const defendPoints = [];
  for (const key of objectivePointsOf(grid).defend) {
    const { x, y } = parseTerrainKey(key);
    if (Number.isFinite(x) && Number.isFinite(y)) defendPoints.push(Object.freeze({ x, y }));
  }
  return Object.freeze({
    hasTerrain: Object.keys(grid).length > 0,
    defendPoints: Object.freeze(defendPoints),
    // The board is read for no particular unit, so the pads' per-unit `restricted` mark is left off.
    teleports: Object.freeze(movement.teleports.map(({ restricted, ...pad }) => Object.freeze(pad))),
    elevations: readTerrainElevations(scene),
    travelBoundedByDistance: terrainBoundsTravelByDistance({
      terrainCosts: movement.costs, terrainTeleports: movement.teleports
    }),
    // Scene padding is always 0 (hooks/scene.mjs), so the map's size in squares is its pixel size over the grid size.
    columns: Math.ceil((Number(scene.width) || 0) / gridSize),
    rows: Math.ceil((Number(scene.height) || 0) / gridSize)
  });
}

/** A cached copy of a Scene's zone table. No Scene reads as `{}`. */
export function readTerrainZones(scene) {
  return readTerrainFlag(scene, TERRAIN_ZONES_FLAG);
}

/** Read every cell assigned to one zone. */
export function readZoneCells(zoneId, scene = globalThis.canvas?.scene) {
  const grid = readTerrainGrid(scene);
  return Object.keys(grid).filter(key => grid[key]?.zoneId === zoneId);
}

/**
 * How many of the Scene's walls the Terrain Builder can edit, and how many of those block movement and sight. A
 * locked Door's own walls are managed by the Door, so they are left out.
 */
export function readBuilderWallCounts(scene = globalThis.canvas?.scene) {
  const counts = { total: 0, move: 0, sight: 0 };
  for (const wall of collectionValues(scene?.walls)) {
    if (wall.getFlag?.(SYSTEM_ID, DOOR_WALL_FLAG)) continue;
    counts.total += 1;
    if (Number(wall.move) !== CONST.WALL_MOVEMENT_TYPES.NONE) counts.move += 1;
    if (Number(wall.sight) !== CONST.EDGE_SENSE_TYPES.NONE) counts.sight += 1;
  }
  return counts;
}

/** Choose the next zone palette color for the Terrain Builder. */
export function suggestZoneColor(scene = globalThis.canvas?.scene) {
  return ZONE_PALETTE[Object.keys(readTerrainZones(scene)).length % ZONE_PALETTE.length];
}

/**
 * The Scene's records of the terrain edits spells have made, keyed by cell.
 */
export function readTerrainEditRecords(scene = globalThis.canvas?.scene) {
  return readTerrainFlag(scene, TERRAIN_EDIT_RECORDS_FLAG);
}

/** How the Terrain Builder's cell inspection describes a spell's terrain edit: the spell, its caster, time left. */
export async function readTerrainEditPresentation(cellKey, scene = globalThis.canvas?.scene) {
  const record = readTerrainEditRecords(scene)[cellKey];
  if (!record) return null;
  const [item, caster] = await Promise.all([
    resolveDocument(record.itemUuid),
    resolveDocument(record.casterUuid)
  ]);
  const itemName = item?.name || 'Effect';
  const casterName = caster?.name || '';
  return Object.freeze({
    key: String(cellKey),
    label: casterName ? `${itemName} (${casterName})` : itemName,
    remainingLabel: terrainEditRemainingLabel(record)
  });
}

/**
 * The name, faction and size of the Actor a spawn point names, as plain data, for the Terrain Builder and
 * FoundryTerrainRepository. Anything that isn't an Actor reads as `isActor: false`.
 */
export async function resolveTerrainSpawnReference(uuid) {
  const actor = await resolveDocument(uuid);
  if (actor?.documentName !== 'Actor') {
    return Object.freeze({ isActor: false, name: '', actorType: '', width: 1, height: 1 });
  }
  return Object.freeze({
    isActor: true,
    name: String(actor.name ?? ''),
    actorType: String(actor.system?.faction?.role ?? ''),
    width: Math.max(1, Math.round(Number(actor.prototypeToken?.width) || 1)),
    height: Math.max(1, Math.round(Number(actor.prototypeToken?.height) || 1))
  });
}

/**
 * Token data for a terrain spawn, for FoundryTerrainRepository to create. The Token is unlinked, so the arrival gets
 * its own Actor, and starts fully transparent until settleSpawn fades it in after placement.
 * @param {string} uuid Authored spawn Actor UUID.
 * @param {{x: number, y: number}} position Scene coordinates for the arrival.
 * @returns {Promise<object|null>}
 */
export async function readTerrainSpawnTokenData(uuid, position) {
  const actor = await resolveDocument(uuid);
  if (actor?.documentName !== 'Actor') return null;
  const document = await actor.getTokenDocument({
    x: Number(position?.x) || 0,
    y: Number(position?.y) || 0,
    alpha: 0,
    actorLink: false
  });
  return document?.toObject() ?? null;
}

/**
 * The Scene FoundryTerrainRepository works on: the one a uuid names, whether or not it is on the canvas, or the
 * displayed Scene when no uuid is given.
 */
export async function readPersistedTerrainScene(sceneUuid = '') {
  if (sceneUuid) return resolveDocument(String(sceneUuid), 'Scene');
  return globalThis.canvas?.scene ?? null;
}

/** Token art for the spawn markers drawn on the map, by Actor uuid. Hidden spawns count only with `includeHidden`. */
export async function readTerrainSpawnImages(grid, { includeHidden = false } = {}) {
  const uuids = new Set();
  for (const [, entry] of terrainCells(grid)) {
    for (const spawn of Array.isArray(entry?.spawns) ? entry.spawns : []) {
      if (!includeHidden && spawn?.visible !== true) continue;
      if (spawn?.uuid) uuids.add(String(spawn.uuid));
    }
  }
  const images = {};
  await Promise.all([...uuids].map(async uuid => {
    let actor = null;
    try { actor = await fromUuid(uuid); } catch (_) {
      reportFoundryError(import.meta.url, _, 'readTerrainSpawnImages');
      return;
    }
    if (actor?.documentName !== 'Actor') return;
    const image = actor.prototypeToken?.texture?.src || actor.img;
    if (image) images[uuid] = String(image);
  }));
  return images;
}

/* -------------------------------------------- */
/*  Sight                                       */
/* -------------------------------------------- */
/**
 * What a line-of-sight test over an area reads: terrain heights and blockers, the cells units occupy (and which of
 * them are airborne), and, for each origin cell in `centers`, the cells walls hide from it.
 */
export function projectSight(scene, { cells, centers, losRule = 'normal', ground = false, units = [] }) {
  const terrain = projectTerrainSight(scene, ground);
  const gridSize = Math.max(1, Number(scene?.grid?.size) || 1);
  const hasWalls = collectionValues(scene?.walls).length > 0;
  const airborneCells = new Set();
  const occupiedCells = new Set();
  for (const unit of units) {
    for (const cell of unit?.cells ?? []) {
      const key = `${cell.x},${cell.y}`;
      occupiedCells.add(key);
      if (losRule === 'normal' && unit.airborne === true) airborneCells.add(key);
    }
  }
  return Object.freeze({
    losRule: String(losRule ?? 'normal'),
    elevations: terrain.elevations,
    impassableCells: terrain.impassable,
    obstacleCells: terrain.obstacles,
    airborneCells,
    occupiedCells,
    hasWalls,
    wallBlocked: hasWalls && losRule !== 'ignoreLoS'
      ? centers.map(center => Object.freeze({ center, blocked: wallBlockedFrom(scene, center, cells, gridSize) }))
      : Object.freeze([])
  });
}

const TERRAIN_SIGHT = new WeakMap();

/**
 * The terrain heights and blockers a sight test reads. One item use tests sight two or three times, so the result
 * is cached against the terrain grid copy it came from and reused until the scene changes.
 */
function projectTerrainSight(scene, ground) {
  const grid = readTerrainGrid(scene);
  const rule = ground ? 'ground' : 'air';
  const kept = TERRAIN_SIGHT.get(grid);
  if (kept?.[rule]) return kept[rule];

  const elevations = {};
  const impassable = new Set();
  const obstacles = new Set();
  for (const [terrainKey, entry] of terrainCells(grid)) {
    const { x, y } = parseTerrainKey(terrainKey);
    const key = `${x},${y}`;
    if (entry.elevation) elevations[key] = Number(entry.elevation) || 0;
    if (!ground) continue;
    if (entry.impassable) impassable.add(key);
    if (entry.obstacle) obstacles.add(key);
  }
  const derived = { elevations: Object.freeze(elevations), impassable, obstacles };
  TERRAIN_SIGHT.set(grid, Object.assign(kept ?? {}, { [rule]: derived }));
  return derived;
}

/**
 * Ask Foundry’s collision backend which cells are blocked from the origin. For a scene with walls that this client
 * isn't viewing, report every other cell blocked, because the backend only knows the walls of the scene on the
 * canvas. With no level given, testCollision uses the canvas's current Level (v14), so units on different Levels
 * of one scene are tested as if on the same one.
 */
function wallBlockedFrom(scene, center, cells, gridSize) {
  const blocked = new Set();
  const testable = sceneWallsTestable(scene);
  const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.sight;
  if (testable && typeof backend?.testCollision !== 'function') return blocked;
  const [centerX, centerY] = String(center).split(',').map(Number);
  const from = { x: (centerX * gridSize) + (gridSize / 2), y: (centerY * gridSize) + (gridSize / 2) };
  for (const key of cells) {
    if (key === center) continue;
    if (!testable) {
      blocked.add(key);
      continue;
    }
    const [x, y] = String(key).split(',').map(Number);
    const to = { x: (x * gridSize) + (gridSize / 2), y: (y * gridSize) + (gridSize / 2) };
    if (backend.testCollision(from, to, { mode: 'any', type: 'sight' }) === true) blocked.add(key);
  }
  return blocked;
}

/**
 * Line-of-sight data for a placement requirement that needs sight, cast from `anchor` over the cells it covers.
 * createGeometryResolver (game/targeting/shapes.mjs) takes it as its `sight` option.
 * @param {object} board The mover’s movement data (projectMovementSnapshot), naming its scene and size.
 * @param {object} anchor The square or footprint the geometry is measured from.
 * @param {{width: number, height: number}} footprint The placed unit’s footprint.
 * @param {object} spec Normalized geometry spec.
 * @returns {object|null} Null when the geometry asks for no line of sight.
 */
export function projectGeometrySight(board, anchor, footprint, spec) {
  if (spec?.lineOfSight !== true || !anchor) return null;
  const { centers, cells } = geometrySightCells(anchor, footprint, spec, board);
  const losRule = board?.freeTargeting === true ? 'ignoreLoS' : 'normal';
  return projectSight(resolveViewedScene(board?.sceneUuid), { cells, centers, losRule });
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
function terrainEditRemainingLabel(record) {
  if (record.respawnRemaining !== null && record.respawnRemaining !== undefined) {
    return `Respawns in ${record.respawnRemaining} round${Number(record.respawnRemaining) === 1 ? '' : 's'}`;
  }
  if (record.remaining === null || record.remaining === undefined) return 'Permanent';
  return `${record.remaining} round${Number(record.remaining) === 1 ? '' : 's'} left`;
}
