/** @layer game/targeting */
import { cellKey, parseCellKey, rectDistance, rectKeys } from '../../lib/core/geometry.mjs';
import { targetTypeAdmits } from '../character/rules.mjs';
import { TARGET_KINDS } from '../objects/rules.mjs';
import { clamp } from '../../lib/core/runtime.mjs';
import { normalizeGeometry } from '../../contracts/dsl/terrain-geometry.mjs';
import { isEmpty as conditionIsEmpty } from '../../contracts/dsl/conditions.mjs';
import { evaluate as evaluateConditionTree } from '../effects/conditions.mjs';
import { buildMovementGraph, resolveMovementDestination, standingLegality } from '../movement/pathfinding.mjs';
import { parseAttackRange, pruneCellsBySight, terrainElevationAt } from './attack-grid.mjs';

/* -------------------------------------------- */
/*  Aimed shape vocabulary                      */
/* -------------------------------------------- */
const CARDINALS = Object.freeze([
  Object.freeze({ dx: 0, dy: -1 }),
  Object.freeze({ dx: 1, dy: 0 }),
  Object.freeze({ dx: 0, dy: 1 }),
  Object.freeze({ dx: -1, dy: 0 })
]);

const DIAGONALS = Object.freeze([
  Object.freeze({ dx: -1, dy: -1 }),
  Object.freeze({ dx: 1, dy: -1 }),
  Object.freeze({ dx: -1, dy: 1 }),
  Object.freeze({ dx: 1, dy: 1 })
]);

/* -------------------------------------------- */
/*  Lines                                       */
/* -------------------------------------------- */

/**
 * The cells a line-shaped Item can fire along, traced outward from the footprint's own edges.
 * @param {object} input The source's top-left square, footprint, range band, and Scene bounds.
 * @returns {Set<string>} Cell keys on every legal ray.
 */
export function generateLineCells(input = {}) {
  const cells = new Set();
  const bounds = sourceBounds(input);
  const band = rangeBand(input);
  if (!bounds || !band) return cells;
  const columns = dimension(input.columns);
  const rows = dimension(input.rows);
  for (const origin of lineOrigins(bounds)) {
    for (const direction of origin.cardinals) {
      traceRay(cells, origin, direction, band.min, band.max, columns, rows);
    }
    for (const direction of origin.diagonals) {
      traceRay(cells, origin, direction, band.min, Math.max(band.min, band.max - 1), columns, rows);
    }
  }
  return cells;
}

/**
 * Resolve the ray game/items/activation.mjs fires at a clicked cell. Edge squares are tried in order, each firing
 * straight out from its own edge, then the corners diagonally, as generateLineCells draws them. Diagonal rays reach
 * one square less than straight rays.
 * @param {object} input The source's top-left square, footprint, target cells, targetable keys, band, and Scene
 *   bounds.
 * @returns {{origin: object, direction: object, cells: Set<string>, endPoint: object}|null}
 */
export function resolveLineRay(input = {}) {
  const bounds = sourceBounds(input);
  const band = rangeBand(input);
  if (!bounds || !band) return null;
  const targetCells = normalizeCells(input.targetCells);
  const targetable = keySet(input.targetableKeys);
  for (const origin of lineOrigins(bounds)) {
    const direction = lineDirectionFrom(origin, targetCells, targetable, band);
    if (!direction) continue;
    return traceLineRay(origin, direction, band, dimension(input.columns), dimension(input.rows));
  }
  return null;
}

/* -------------------------------------------- */
/*  Cones                                       */
/* -------------------------------------------- */

/**
 * The footprint edge a cone projects from, and the direction it faces, for one aim cell.
 * @param {object} input The source's top-left square, footprint, and aim cell.
 * @returns {{x: number, y: number, dx: number, dy: number}|null}
 */
export function resolveConeAim(input = {}) {
  const bounds = sourceBounds(input);
  const aim = normalizeCell(input.aim);
  if (!bounds || !aim) return null;
  const dx = aim.x < bounds.minX ? -1 : aim.x > bounds.maxX ? 1 : 0;
  const dy = aim.y < bounds.minY ? -1 : aim.y > bounds.maxY ? 1 : 0;
  if (dx === 0 && dy === 0) return null;
  return {
    x: dx !== 0 ? (dx > 0 ? bounds.maxX : bounds.minX) : clamp(aim.x, bounds.minX, bounds.maxX),
    y: dy !== 0 ? (dy > 0 ? bounds.maxY : bounds.minY) : clamp(aim.y, bounds.minY, bounds.maxY),
    dx,
    dy
  };
}

/**
 * The cells a cone covers: aimed straight, it widens by one square on each side every two rows; aimed diagonally,
 * it is a triangle.
 * @param {object} input Plain origin cell, facing, depth, and Scene bounds.
 * @returns {Set<string>} Cell keys inside the cone.
 */
export function generateConeCells(input = {}) {
  const cells = new Set();
  const origin = normalizeCell(input.origin);
  const dx = unitStep(input.direction.dx);
  const dy = unitStep(input.direction.dy);
  const depth = Math.floor(Number(input.depth) || 0);
  if (!origin || (dx === 0 && dy === 0) || depth < 1) return cells;
  const columns = dimension(input.columns);
  const rows = dimension(input.rows);

  if (dx !== 0 && dy !== 0) {
    for (let step = 1; step <= depth; step += 1) {
      for (let offset = 0; offset < step; offset += 1) {
        addCell(cells, origin.x + (dx * (step - offset)), origin.y + (dy * (offset + 1)), columns, rows);
      }
    }
    return cells;
  }

  const horizontal = dy === 0;
  for (let step = 1; step <= depth; step += 1) {
    const half = Math.floor(step / 2);
    for (let offset = -half; offset <= half; offset += 1) {
      const x = origin.x + (dx * step) + (horizontal ? 0 : offset);
      const y = origin.y + (dy * step) + (horizontal ? offset : 0);
      addCell(cells, x, y, columns, rows);
    }
  }
  return cells;
}

/* -------------------------------------------- */
/*  Locations                                   */
/* -------------------------------------------- */

/**
 * The cells an effect covers around one aim cell, counting straight steps, or diagonal (chess king) steps when the
 * shape is Square.
 * @param {object} input Plain centre cell, radius, shape, and Scene bounds.
 * @returns {Set<string>} Cell keys inside the area.
 */
export function generateLocationCells(input = {}) {
  const cells = new Set();
  const center = normalizeCell(input.center);
  if (!center) return cells;
  const radius = Math.max(0, Math.floor(Number(input.radius) || 0));
  const columns = dimension(input.columns);
  const rows = dimension(input.rows);
  if (radius === 0) {
    addCell(cells, center.x, center.y, columns, rows);
    return cells;
  }
  const square = String(input.shape ?? 'Normal') === 'Square';
  for (let x = center.x - radius; x <= center.x + radius; x += 1) {
    for (let y = center.y - radius; y <= center.y + radius; y += 1) {
      const offsetX = Math.abs(x - center.x);
      const offsetY = Math.abs(y - center.y);
      const distance = square ? Math.max(offsetX, offsetY) : offsetX + offsetY;
      if (distance <= radius) addCell(cells, x, y, columns, rows);
    }
  }
  return cells;
}

/** The largest radius an effect step's area reaches. A larger radius is held to this. */
export const MAX_AREA_RADIUS = 99;

/**
 * An effect area's radius as a whole number of squares from 0 to MAX_AREA_RADIUS. A blank or non-numeric value is
 * 0, and an infinite one is held to the maximum, so the loops over the area always end.
 * @param {unknown} value The authored radius.
 * @returns {number}
 */
export function effectAreaRadius(value) {
  const radius = Math.floor(Number(value));
  return Number.isNaN(radius) ? 0 : clamp(radius, 0, MAX_AREA_RADIUS);
}

/**
 * The cells within a radius of a footprint, counting straight steps (no diagonals) from its edge, with the footprint
 * itself kept or dropped. The radius is held to MAX_AREA_RADIUS.
 * @param {object} input The source's top-left square, footprint, radius, whether the source squares count, and
 *   Scene bounds.
 * @returns {Set<string>} Cell keys inside the reach.
 */
export function generateAreaCells(input = {}) {
  const cells = new Set();
  const bounds = sourceBounds(input);
  if (!bounds) return cells;
  const radius = effectAreaRadius(input.radius);
  const columns = dimension(input.columns);
  const rows = dimension(input.rows);
  const includeSource = input.includeSource === true;
  const rect = {
    x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX + 1, height: bounds.maxY - bounds.minY + 1
  };
  for (let x = bounds.minX - radius; x <= bounds.maxX + radius; x += 1) {
    for (let y = bounds.minY - radius; y <= bounds.maxY + radius; y += 1) {
      const inside = x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
      if (inside ? !includeSource : rectDistance(rect, { x, y, width: 1, height: 1 }) > radius) continue;
      addCell(cells, x, y, columns, rows);
    }
  }
  return cells;
}

/**
 * The ring of squares touching a footprint, which is the grid a cone picks its direction from.
 * @param {object} input The source's top-left square, footprint, and Scene bounds.
 * @returns {Set<string>} Adjacent cell keys.
 */
export function generateAdjacentCells(input = {}) {
  const cells = new Set();
  const bounds = sourceBounds(input);
  if (!bounds) return cells;
  const columns = dimension(input.columns);
  const rows = dimension(input.rows);
  const occupied = new Set(rectKeys(
    bounds.minX, bounds.minY, bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1
  ));
  for (let x = bounds.minX - 1; x <= bounds.maxX + 1; x += 1) {
    for (let y = bounds.minY - 1; y <= bounds.maxY + 1; y += 1) {
      if (occupied.has(cellKey(x, y))) continue;
      addCell(cells, x, y, columns, rows);
    }
  }
  return cells;
}

/* -------------------------------------------- */
/*  Occupancy                                   */
/* -------------------------------------------- */

/**
 * Select targets for game/items/activation.mjs when any footprint cell intersects the area.
 * Exclude unknown kinds and scenery. Admit living Destructibles only when requested, without faction checks.
 * @param {object} input The units on the map, cell keys, target type, source faction, one excluded Token, and
 *   whether Destructibles are admitted.
 * @returns {object[]} The caught units, in the order given.
 */
export function selectUnitsInCells(input = {}) {
  const cells = keySet(input.cells);
  const targetType = String(input.targetType ?? 'Any');
  const sourceFaction = String(input.sourceFaction ?? 'Neutral');
  const excluded = String(input.excludeTokenUuid ?? '');
  const admitsDestructibles = input.admitsDestructibles === true;
  const selected = [];
  for (const unit of input.units ?? []) {
    if (excluded && String(unit?.tokenUuid ?? '') === excluded) continue;
    if (!normalizeCells(unit?.cells).some(cell => cells.has(cellKey(cell.x, cell.y)))) continue;
    const kind = String(unit?.targetKind ?? TARGET_KINDS.SCENERY);
    if (kind === TARGET_KINDS.DESTRUCTIBLE) {
      if (admitsDestructibles && unit.destroyed !== true) selected.push(unit);
      continue;
    }
    if (kind !== TARGET_KINDS.UNIT) continue;
    if (!targetTypeAdmits(targetType, sourceFaction, unit?.faction)) continue;
    selected.push(unit);
  }
  return selected;
}

/** The cells a footprint anchored at one square occupies. */
export function footprintCellKeys(source, footprint) {
  const bounds = sourceBounds({ source, footprint });
  if (!bounds) return [];
  return rectKeys(bounds.minX, bounds.minY, bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1);
}

/* -------------------------------------------- */
/*  Ray helpers                                 */
/* -------------------------------------------- */
function lineOrigins(bounds) {
  const large = bounds.maxX > bounds.minX || bounds.maxY > bounds.minY;
  if (!large) {
    return [{ x: bounds.minX, y: bounds.minY, cardinals: CARDINALS, diagonals: DIAGONALS }];
  }
  const origins = [];
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    origins.push({ x, y: bounds.minY, cardinals: [CARDINALS[0]], diagonals: [] });
  }
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    origins.push({ x: bounds.maxX, y, cardinals: [CARDINALS[1]], diagonals: [] });
  }
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    origins.push({ x, y: bounds.maxY, cardinals: [CARDINALS[2]], diagonals: [] });
  }
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    origins.push({ x: bounds.minX, y, cardinals: [CARDINALS[3]], diagonals: [] });
  }
  origins.push({ x: bounds.minX, y: bounds.minY, cardinals: [], diagonals: [DIAGONALS[0]] });
  origins.push({ x: bounds.maxX, y: bounds.minY, cardinals: [], diagonals: [DIAGONALS[1]] });
  origins.push({ x: bounds.minX, y: bounds.maxY, cardinals: [], diagonals: [DIAGONALS[2]] });
  origins.push({ x: bounds.maxX, y: bounds.maxY, cardinals: [], diagonals: [DIAGONALS[3]] });
  return origins;
}

/** Only the directions this edge square fires along count, and only within the reach it fires to. */
function lineDirectionFrom(origin, targetCells, targetableKeys, band) {
  for (const cell of targetCells) {
    if (!targetableKeys.has(cellKey(cell.x, cell.y))) continue;
    const deltaX = cell.x - origin.x;
    const deltaY = cell.y - origin.y;
    const direction = axialDirection(deltaX, deltaY);
    if (!direction) continue;
    const diagonal = direction.dx !== 0 && direction.dy !== 0;
    const allowed = diagonal ? origin.diagonals : origin.cardinals;
    if (!allowed.some(entry => entry.dx === direction.dx && entry.dy === direction.dy)) continue;
    const step = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    const maximum = diagonal ? Math.max(band.min, band.max - 1) : band.max;
    if (step >= band.min && step <= maximum) return direction;
  }
  return null;
}

function axialDirection(deltaX, deltaY) {
  if (deltaX === 0 && deltaY === 0) return null;
  if (deltaX === 0 || deltaY === 0) return { dx: unitStep(deltaX), dy: unitStep(deltaY) };
  if (Math.abs(deltaX) !== Math.abs(deltaY)) return null;
  return { dx: unitStep(deltaX), dy: unitStep(deltaY) };
}

function traceLineRay(origin, direction, band, columns, rows) {
  const diagonal = direction.dx !== 0 && direction.dy !== 0;
  const maximum = diagonal ? Math.max(band.min, band.max - 1) : band.max;
  const cells = new Set();
  const endPoint = { x: origin.x, y: origin.y };
  for (let step = band.min; step <= maximum; step += 1) {
    const x = origin.x + (direction.dx * step);
    const y = origin.y + (direction.dy * step);
    if (!inBounds(x, y, columns, rows)) continue;
    cells.add(cellKey(x, y));
    endPoint.x = x;
    endPoint.y = y;
  }
  return {
    origin: { x: origin.x, y: origin.y },
    direction,
    cells,
    endPoint
  };
}

function traceRay(cells, origin, direction, minimum, maximum, columns, rows) {
  for (let step = minimum; step <= maximum; step += 1) {
    const x = origin.x + (direction.dx * step);
    const y = origin.y + (direction.dy * step);
    if (!inBounds(x, y, columns, rows)) break;
    cells.add(cellKey(x, y));
  }
}

/* -------------------------------------------- */
/*  Authored placement geometry                 */
/* -------------------------------------------- */
/**
 * How far a `path` geometry may reach, from the budget its author named. Only a teleport or an explicit `none` is
 * unlimited. A custom amount that is not a number, or an item range that cannot be parsed, reaches nothing, so a
 * broken budget fails closed instead of walking anywhere.
 * @param {object} geometry Normalized geometry spec.
 * @param {object} facts The unit's `totalMovement` and the effect's `effectRange`.
 * @returns {number} Squares of budget, `Infinity` where the author named none.
 */
export function geometryPlacementBudget(geometry, facts = {}) {
  if (geometry?.reach !== 'path') return Infinity;
  if (geometry.budgetSource === 'none') return Infinity;
  if (geometry.budgetSource === 'rng') {
    const range = parseAttackRange(String(facts.effectRange ?? ''))?.maxRange;
    return Number.isFinite(range) ? Math.max(0, Math.floor(range)) : 0;
  }
  if (geometry.budgetSource === 'mvmt') return Math.max(0, Math.floor(Number(facts.totalMovement) || 0));
  const amount = geometry.budgetSource === 'custom' ? geometry.budgetValue : NaN;
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
}

/**
 * Resolve candidate placements for authored geometry steps, applying their filters and ranking.
 * @param {object} source The moving unit's map data: `columns`, `rows`, `current` (null for a hypothetical unit),
 *   `footprint`, occupancy, terrain, and `sight` when the geometry asks for line of sight.
 * @param {object} anchorRect The square or footprint the geometry is measured from.
 * @param {object} geometry Normalized geometry spec.
 * @param {number} [budget] Path budget from `geometryPlacementBudget`.
 * @returns {readonly object[]} Ranked candidates as `{x, y, distance}`, with `cost` where a walk priced them.
 */
export function resolveGeometryPlacements(source, anchorRect, geometry, budget = Infinity) {
  if (!source || !anchorRect) return Object.freeze([]);
  const anchor = placementRect(anchorRect);
  const footprint = placementFootprint(source.footprint);
  const origin = normalizeCell(source.current);
  const legal = standingLegality(source);
  let candidates = bandPlacements(source, anchor, footprint, geometry)
    .filter(candidate => !(origin && candidate.x === origin.x && candidate.y === origin.y))
    .filter(candidate => legal(candidate, footprint));
  if (geometry?.elevation === 'matchAnchor') {
    candidates = keepAnchorElevation(candidates, footprint, anchor, source.terrainElevations);
  }
  if (geometry?.lineOfSight === true) candidates = keepInSight(candidates, footprint, anchor, source.sight);
  if (geometry?.reach === 'path' && origin) candidates = priceWalk(candidates, source, origin, budget);
  return Object.freeze(rankPlacements(candidates, geometry?.pick, origin));
}

/**
 * The squares a geometry's line of sight is tested over: the anchor's own, and every band placement's.
 * @param {object} anchorRect The square or footprint the geometry is measured from.
 * @param {{width: number, height: number}} footprint The placed unit's footprint.
 * @param {object} geometry Normalized geometry spec.
 * @param {{columns: number, rows: number}} bounds The map size in squares.
 * @returns {{centers: string[], cells: Set<string>}}
 */
export function geometrySightCells(anchorRect, footprint, geometry, bounds) {
  const anchor = placementRect(anchorRect);
  const size = placementFootprint(footprint);
  const cells = new Set();
  for (const placement of bandPlacements(bounds, anchor, size, geometry)) {
    for (const key of placementKeys(placement, size)) cells.add(key);
  }
  return { centers: rectKeys(anchor.x, anchor.y, anchor.width, anchor.height), cells };
}

/**
 * Build the placement counter passed to game/effects/requirements.mjs; each moving unit is measured on its own
 * movement data.
 * @param {object} [boards]
 * @param {object|null} [boards.self] The caster's movement data.
 * @param {(tokenUuid: string) => object|null} [boards.target] A named target's movement data.
 * @param {(board: object, anchor: object, footprint: object, spec: object) => object|null} [boards.sight] The
 *   sight data a line-of-sight geometry is filtered by.
 * @param {string|number} [boards.effectRange] The range a caster-moving path budget is priced from.
 * @param {string|number} [boards.targetEffectRange] The range a target-moving path budget is priced from.
 * @returns {(request: {anchor: object, mover: object, spec: object}) => {count: number, reason?: string}} A count
 *   of 0 names why when nothing was measured: `no-board` without movement data, `no-sight` when the geometry needs
 *   line of sight and no sight data was supplied.
 */
export function createGeometryResolver({
  self = null, target = () => null, sight = () => null, effectRange = '', targetEffectRange = effectRange
} = {}) {
  return ({ anchor, mover, spec } = {}) => {
    const side = mover?.side === 'target' || mover?.side === 'custom' ? mover.side : 'self';
    // `self` may be a function so a caller can leave the unit's own board unread until a geometry query needs it.
    const board = side === 'target' ? target(String(mover?.id ?? '')) : typeof self === 'function' ? self() : self;
    if (!board?.supportedGrid || !anchor || !mover) return { count: 0, reason: 'no-board' };
    const footprint = placementFootprint(mover);
    const standing = side === 'custom'
      ? { ...board, current: null, airborne: false, occupiedCells: [...(board.occupiedCells ?? []), ...boardOwnCells(board)] }
      : { ...board, current: { x: mover.x, y: mover.y } };
    const sightFacts = spec?.lineOfSight === true ? sight(board, anchor, footprint, spec) : null;
    if (spec?.lineOfSight === true && !sightFacts) return { count: 0, reason: 'no-sight' };
    const facts = { ...standing, footprint, sight: sightFacts };
    const budget = geometryPlacementBudget(spec, {
      totalMovement: board.totalMovement,
      effectRange: side === 'target' ? targetEffectRange : effectRange
    });
    return { count: resolveGeometryPlacements(facts, anchor, spec, budget).length };
  };
}

/**
 * Predict where an attacker's preCombat self-moves will put it, for the combat preview, by running them in order.
 * Skip failed conditions and resolve random placement as nearest to keep previews deterministic.
 * @param {object} input
 * @param {readonly object[]} input.entries The Item's authored effect entries.
 * @param {object} input.movement The mover's movement data, standing where it is now.
 * @param {object} input.anchorRect The target's square or footprint.
 * @param {object} input.context Condition values as the map stands now, `distance` among them.
 * @param {object} [input.budgetFacts] The `totalMovement` and `effectRange` a path budget is priced from.
 * @returns {{moved: boolean, position: {x: number, y: number}}}
 */
export function predictGeometryApproach({ entries, movement, anchorRect, context, budgetFacts = {} }) {
  let position = { x: Number(movement?.current?.x) || 0, y: Number(movement?.current?.y) || 0 };
  let moved = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.trigger !== 'preCombat') continue;
    if (!conditionIsEmpty(entry.condition) && evaluateConditionTree(entry.condition, context) !== true) continue;
    for (const step of entry.action?.steps ?? []) {
      if (step?.kind !== 'moveToken' || step.target !== 'self' || step.mode !== 'terrainGeometry') continue;
      const geometry = normalizeGeometry(step.geometry);
      if (geometry.anchor !== 'target') continue;
      const [landing] = resolveGeometryPlacements(
        { ...movement, current: position },
        anchorRect,
        { ...geometry, pick: geometry.pick === 'random' ? 'nearest' : geometry.pick },
        geometryPlacementBudget(geometry, budgetFacts)
      );
      if (!landing) continue;
      position = { x: landing.x, y: landing.y };
      moved = true;
    }
  }
  return { moved, position };
}

/** Diagonal-step (chess king) distance between two rectangles, used when the author picks the `king` metric. */
function kingRectDistance(a, b) {
  const x = Math.max(0, a.x - (b.x + b.width - 1), b.x - (a.x + a.width - 1));
  const y = Math.max(0, a.y - (b.y + b.height - 1), b.y - (a.y + a.height - 1));
  return Math.max(x, y);
}

function placementRect(rect) {
  return {
    x: Math.floor(Number(rect.x) || 0),
    y: Math.floor(Number(rect.y) || 0),
    width: Math.max(1, Math.floor(Number(rect.width) || 1)),
    height: Math.max(1, Math.floor(Number(rect.height) || 1))
  };
}

function placementFootprint(footprint) {
  return {
    width: Math.max(1, Math.floor(Number(footprint?.width) || 1)),
    height: Math.max(1, Math.floor(Number(footprint?.height) || 1))
  };
}

function placementKeys(candidate, footprint) {
  return rectKeys(candidate.x, candidate.y, footprint.width, footprint.height);
}

function boardOwnCells(board) {
  const standing = normalizeCell(board.current);
  return standing ? placementKeys(standing, placementFootprint(board.footprint)) : [];
}

function bandPlacements(bounds, anchor, footprint, geometry) {
  const minimum = Math.max(1, Math.floor(Number(geometry?.minDistance) || 1));
  const maximum = Math.max(minimum, Math.floor(Number(geometry?.maxDistance) || minimum));
  const lastRow = Math.min(dimension(bounds?.rows) - 1, anchor.y + anchor.height - 1 + maximum);
  const lastColumn = Math.min(dimension(bounds?.columns) - 1, anchor.x + anchor.width - 1 + maximum);
  const placements = [];
  for (let y = Math.max(0, anchor.y - maximum - footprint.height + 1); y <= lastRow; y += 1) {
    for (let x = Math.max(0, anchor.x - maximum - footprint.width + 1); x <= lastColumn; x += 1) {
      const candidate = { x, y, width: footprint.width, height: footprint.height };
      const distance = geometry?.metric === 'king' ? kingRectDistance(anchor, candidate) : rectDistance(anchor, candidate);
      if (distance >= minimum && distance <= maximum) placements.push({ x, y, distance });
    }
  }
  return placements;
}

function anchorElevation(anchor, elevations) {
  const x = Math.floor(anchor.x + (anchor.width / 2));
  const y = Math.floor(anchor.y + (anchor.height / 2));
  return terrainElevationAt(elevations ?? {}, x, y);
}

function keepAnchorElevation(candidates, footprint, anchor, elevations) {
  const level = anchorElevation(anchor, elevations);
  return candidates.filter(candidate => placementKeys(candidate, footprint).every(key => {
    const cell = parseCellKey(key);
    return terrainElevationAt(elevations ?? {}, cell.x, cell.y) === level;
  }));
}

function keepInSight(candidates, footprint, anchor, sight) {
  if (!sight) return [];
  const visible = pruneCellsBySight({
    ...sight,
    cells: new Set(candidates.flatMap(candidate => placementKeys(candidate, footprint))),
    centers: placementKeys(anchor, anchor),
    centerElevation: anchorElevation(anchor, sight.elevations)
  });
  return candidates.filter(candidate => placementKeys(candidate, footprint).every(key => visible.has(key)));
}

/**
 * Price the walk to each candidate. An effect's walk is not the mover's own move, so a flier stuck on the ground by
 * a stance break can still be moved.
 */
function priceWalk(candidates, source, origin, budget) {
  const graph = buildMovementGraph({
    ...source, start: origin, allowance: budget, movementPlanning: false, groundedByStanceBreak: false
  });
  const priced = [];
  for (const candidate of candidates) {
    const resolution = resolveMovementDestination(graph, candidate);
    if (resolution && resolution.cost <= budget) priced.push({ ...candidate, cost: resolution.cost });
  }
  return priced;
}

function rankPlacements(candidates, pick, origin) {
  if (pick === 'random') return candidates.map(candidate => Object.freeze(candidate));
  const reach = candidate => (origin
    ? ((candidate.x - origin.x) ** 2) + ((candidate.y - origin.y) ** 2)
    : candidate.distance);
  const direction = pick === 'farthest' ? -1 : 1;
  return [...candidates]
    .sort((a, b) => (direction * (reach(a) - reach(b))) || (a.distance - b.distance) || (a.y - b.y) || (a.x - b.x))
    .map(candidate => Object.freeze(candidate));
}

/* -------------------------------------------- */
/*  Normalization                               */
/* -------------------------------------------- */
function sourceBounds(input) {
  const anchor = normalizeCell(input?.source);
  if (!anchor) return null;
  const width = Math.max(1, Math.floor(Number(input?.footprint?.width) || 1));
  const height = Math.max(1, Math.floor(Number(input?.footprint?.height) || 1));
  return {
    minX: anchor.x,
    minY: anchor.y,
    maxX: anchor.x + width - 1,
    maxY: anchor.y + height - 1
  };
}

function rangeBand(input) {
  const minimum = Math.floor(Number(input?.minRange));
  const maximum = Math.floor(Number(input?.maxRange));
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
  if (minimum < 0 || maximum < minimum) return null;
  return { min: minimum, max: maximum };
}

function normalizeCell(cell) {
  const x = Math.floor(Number(cell?.x));
  const y = Math.floor(Number(cell?.y));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function normalizeCells(cells) {
  const normalized = [];
  for (const cell of cells ?? []) {
    const entry = typeof cell === 'string' ? parseCellKey(cell) : normalizeCell(cell);
    if (entry) normalized.push(entry);
  }
  return normalized;
}

function keySet(keys) {
  if (keys instanceof Set) return keys;
  return new Set(keys ?? []);
}

function addCell(cells, x, y, columns, rows) {
  if (inBounds(x, y, columns, rows)) cells.add(cellKey(x, y));
}

function inBounds(x, y, columns, rows) {
  if (x < 0 || y < 0) return false;
  if (columns > 0 && x >= columns) return false;
  return !(rows > 0 && y >= rows);
}

function dimension(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function unitStep(value) {
  const number = Number(value) || 0;
  return number > 0 ? 1 : number < 0 ? -1 : 0;
}
