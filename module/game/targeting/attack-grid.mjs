/** @layer game/targeting */
import { WEAPON_PROFICIENCIES } from '../../contracts/domains/items.mjs';
import { ENGAGEMENT_KINDS } from '../../contracts/domains/characters.mjs';
import { MELEE_ELEVATION_REACH } from '../../contracts/domains/combat.mjs';
import { TARGET_AREA_KEYS, TARGET_SHAPES } from '../../contracts/domains/objects.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { isMagicBlocked } from '../effects/requirements.mjs';
import { cellKey, cellKeyOf, footprintCells, parseCellKey } from '../../lib/core/geometry.mjs';
import { targetTypeAdmits } from '../character/rules.mjs';
import { holdsProficiencyRank } from '../progression/rules.mjs';

/* -------------------------------------------- */
/*  Attack range vocabulary                     */
/* -------------------------------------------- */
const ATTACK_ITEM_TYPES = new Set(['Weapon', 'Attack', 'Staff']);
const TARGETING_SHAPES = new Set(TARGET_SHAPES);
const PREVIEW_MAX_RADIUS = 15;
const TARGETING_SECTORS = Object.freeze([
  Object.freeze({ key: 'nw', ux: -1, uy: -1 }),
  Object.freeze({ key: 'n', ux: 0, uy: -1 }),
  Object.freeze({ key: 'ne', ux: 1, uy: -1 }),
  Object.freeze({ key: 'w', ux: -1, uy: 0 }),
  Object.freeze({ key: 'e', ux: 1, uy: 0 }),
  Object.freeze({ key: 'sw', ux: -1, uy: 1 }),
  Object.freeze({ key: 's', ux: 0, uy: 1 }),
  Object.freeze({ key: 'se', ux: 1, uy: 1 })
]);

/* -------------------------------------------- */
/*  Attack verdict reasons                      */
/* -------------------------------------------- */

/**
 * Why validateAttackActivation turned a hotbar attack away, or let it open its grid. targetingMessage in
 * ui/controls/targeting.mjs looks up its refusal text by these string values, so a renamed value must change there
 * too.
 */
const ATTACK_ACTIVATION_REASONS = Object.freeze({
  READY: 'targeting-ready',
  SOURCE_NOT_CONTROLLED: 'source-not-controlled',
  MOVEMENT_PLAN_REQUIRED: 'movement-plan-required',
  ITEM_OWNER_MISMATCH: 'item-owner-mismatch',
  ITEM_NOT_ATTACK: 'item-not-attack',
  STANDARD_ACTION_REQUIRED: 'standard-action-required',
  STANCE_BROKEN: 'stance-broken',
  MAGIC_BLOCKED: 'magic-blocked',
  ITEM_DEPLETED: 'item-depleted',
  WEAPON_PROFICIENCY_REQUIRED: 'weapon-proficiency-required',
  WEAPON_ART_MISMATCH: 'weapon-art-mismatch',
  WEAPON_ART_DEPLETED: 'weapon-art-depleted',
  WEAPON_ART_DURABILITY: 'weapon-art-durability',
  WEAPON_ART_CASTER_REQUIREMENTS: RESULT_CODES.ITEM_CASTER_REQUIREMENTS_UNMET
});

/**
 * Why validateAttackTarget rejected a clicked target, or validateAttackSnapshot the exchange it would open, or why
 * they accepted it. targetingMessage reads these values too.
 */
const ATTACK_TARGET_REASONS = Object.freeze({
  VALID: 'target-valid',
  TARGET_SELF: 'target-self',
  TARGET_MISSING: 'target-missing',
  TARGET_HIDDEN: 'target-hidden',
  TARGET_DESTROYED: 'target-destroyed',
  OBJECT_DESTROYED: 'object-destroyed',
  TURN_OVER: 'turn-over',
  TAUNTED: 'taunted',
  TARGET_SANCTUARY: 'target-sanctuary',
  TARGET_AIRBORNE: 'target-airborne',
  LINE_OF_SIGHT_BLOCKED: 'line-of-sight-blocked',
  TARGET_FACTION_INVALID: 'target-faction-invalid',
  TARGET_OUT_OF_RANGE: 'target-out-of-range',
  TARGET_INELIGIBLE: 'target-ineligible',
  PREVIEW_UNAVAILABLE: 'preview-unavailable'
});

/* -------------------------------------------- */
/*  Available ranges                            */
/* -------------------------------------------- */
/**
 * Resolve the ranges a unit can actually threaten from its plain actor and item data, for
 * foundry/adapters/projections/movement.mjs.
 * @param {object} source Plain proficiencies, status, inventory, and derived wielded range.
 * @returns {readonly object[]} Frozen range bands, both ends included.
 */
export function resolveAttackRanges(source = {}) {
  const actor = { silenced: source.silenced === true };
  const proficiencies = source.proficiencies ?? {};
  const items = Array.isArray(source.items) ? source.items : [];
  const ranges = [];

  for (const item of items) {
    if (!ATTACK_ITEM_TYPES.has(String(item?.itemType ?? ''))) continue;
    if (isMagicBlocked(actor, item)) continue;
    if (!hasRequiredProficiency(proficiencies, item?.requiredProficiency, item?.requiredRank)) continue;
    const range = parseAttackRange(item?.range);
    if (range) ranges.push(freezeRange(range, item));
  }

  const wielded = items.find(item => item?.wielded === true) ?? null;
  if (!isMagicBlocked(actor, wielded)) {
    const derived = parseAttackRange(source.derivedRange);
    if (derived) ranges.push(freezeRange(derived, wielded));
  }

  return Object.freeze(ranges);
}

/** An authored range is a bare maximum, or a minimum and a maximum joined by a dash, and nothing else. */
const ATTACK_RANGE_PATTERN = /^(\d+)(?:\s*-\s*(\d+))?$/;

/**
 * Parse an authored weapon range. A bare number reaches every square from one through that maximum.
 * @param {unknown} value Authored range string.
 * @returns {{minRange: number, maxRange: number}|null}
 */
export function parseAttackRange(value) {
  if (typeof value !== 'string') return null;
  // Whole-string match, so a malformed value such as "1-2-3" is refused rather than half-read as 1-2.
  const parts = ATTACK_RANGE_PATTERN.exec(value.trim());
  if (!parts) return null;
  const minRange = parts[2] === undefined ? 1 : Number.parseInt(parts[1], 10);
  const maxRange = Number.parseInt(parts[2] ?? parts[1], 10);
  if (maxRange < minRange) return null;
  return Object.freeze({ minRange, maxRange });
}

/**
 * Fold a unit's derived reach into one weapon's authored band. The derived reach only ever extends: a unit's
 * reach comes from the weapon it wields, so it must never shorten a different weapon the unit merely carries.
 * A minimum above one is kept in the emitted string, because `parseAttackRange` reads a bare number as reaching
 * from one and would otherwise widen the band on the round trip.
 */
export function resolveEffectiveAttackRange(authoredValue, derivedValue) {
  const authored = parseAttackRange(String(authoredValue ?? ''));
  const derived = parseAttackRange(String(derivedValue ?? ''));
  if (!authored || !derived) return String(authoredValue ?? '');
  const maximum = Math.max(authored.maxRange, derived.maxRange);
  return authored.minRange > 1 ? `${authored.minRange}-${maximum}` : String(maximum);
}

/* -------------------------------------------- */
/*  Engagement                                  */
/* -------------------------------------------- */
/**
 * Classify an attack as melee or ranged. A grounded attack on an airborne target that melee cannot reach
 * (airborneBeyondMelee) is ranged. Otherwise an adjacent target within one floor is melee and any other is ranged.
 * Airborne attackers are judged by map distance and height too.
 * @param {object} input Plain distance, the two units' floor elevations, and the flight fields airborneBeyondMelee
 *   reads.
 * @returns {string} An engagement kind, or an empty string.
 */
export function resolveEngagement(input = {}) {
  const distance = Number(input.distance);
  if (!(distance >= 1)) return '';
  if (airborneBeyondMelee(input)) return ENGAGEMENT_KINDS.RANGED;
  return isInMeleeRange(input) ? ENGAGEMENT_KINDS.MELEE : ENGAGEMENT_KINDS.RANGED;
}

/**
 * Whether a target in the air is out of a melee strike's reach: it is airborne with its stance whole, the attacker
 * is on the ground, the world does not play Classic flyer targeting, and the map allows flight. A broken stance
 * opens even a levitating flier to melee, and so does a map without flight, where only a levitating unit is aloft.
 * Used everywhere a melee attack on a flier is checked, including the Enemy AI through
 * `api.combat.airborneBeyondMelee`.
 * @param {object} facts `sourceAirborne`, `targetAirborne`, `targetStanceBroken`, `classicFlyers` and
 *   `flightForbidden`, which says the map forbids flight.
 * @returns {boolean}
 */
export function airborneBeyondMelee(facts = {}) {
  return facts.targetAirborne === true && facts.targetStanceBroken !== true
    && facts.sourceAirborne !== true && facts.classicFlyers !== true && facts.flightForbidden !== true;
}

/**
 * Whether a target is in melee range by map position alone: adjacent and within melee's elevation reach. Authored
 * conditions and the engagement checks read it, and resolveEngagement applies the flight rules separately.
 * @param {object} input Plain distance and the two units' floor elevations.
 * @returns {boolean}
 */
export function isInMeleeRange(input = {}) {
  if (Number(input.distance) !== 1) return false;
  const drop = Math.abs((Number(input.sourceElevation) || 0) - (Number(input.targetElevation) || 0));
  return drop <= MELEE_ELEVATION_REACH;
}

/**
 * Check a weapon band for combat preview and target validation. Range-one weapons require melee
 * unless an airborne attacker strikes down at an adjacent target.
 * @param {unknown} value Authored range string.
 * @param {number} distance Squares to the foe.
 * @param {string} [engagement] Engagement kind, when one has been judged from the map.
 * @param {boolean} [airborne] Whether the wielder is airborne.
 * @returns {boolean}
 */
export function rangeReachesEngagement(value, distance, engagement = '', airborne = false) {
  const range = parseAttackRange(String(value ?? ''));
  if (!range || !(distance >= range.minRange && distance <= range.maxRange)) return false;
  return engagement !== ENGAGEMENT_KINDS.RANGED || range.maxRange > 1 || airborne === true;
}

/* -------------------------------------------- */
/*  Attack tile geometry                        */
/* -------------------------------------------- */
/**
 * Calculate every in-bounds cell threatened from one token position.
 * @param {number} startX The token's top-left column.
 * @param {number} startY The token's top-left row.
 * @param {object} range Inclusive range, shape, and optional directional sectors.
 * @param {number} columns Scene width in cells.
 * @param {number} rows Scene height in cells.
 * @param {object} footprint Token width and height in cells.
 * @returns {Set<string>} Threatened cell keys.
 */
export function calculateAttackTilesFromPosition(
  startX,
  startY,
  range,
  columns,
  rows,
  footprint = { width: 1, height: 1 }
) {
  const tiles = new Set();
  const authoredMin = Number(range?.minRange);
  const authoredMax = Number(range?.maxRange);
  if (!Number.isFinite(authoredMin) || !Number.isFinite(authoredMax)
    || authoredMin < 0 || authoredMax < authoredMin) return tiles;
  const minRange = Math.floor(authoredMin);
  const maxRange = Math.floor(authoredMax);
  const width = Math.max(1, Math.floor(Number(footprint?.width) || 1));
  const height = Math.max(1, Math.floor(Number(footprint?.height) || 1));
  const sourceCells = footprintCells(startX, startY, width, height);
  const shape = normalizeShape(range?.shape);
  const distance = usesChebyshev(shape) ? chebyshevDistance : manhattanDistance;
  const minX = Math.max(0, startX - maxRange);
  const maxX = Math.min(columns - 1, startX + width - 1 + maxRange);
  const minY = Math.max(0, startY - maxRange);
  const maxY = Math.min(rows - 1, startY + height - 1 + maxRange);

  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const nearest = distance(x, y, sourceCells);
      if (nearest >= minRange && nearest <= maxRange) tiles.add(cellKey(x, y));
    }
  }
  filterTargetingArea(tiles, sourceCells, range?.area, shape, { min: minRange, max: maxRange });
  return tiles;
}

function manhattanDistance(targetX, targetY, sourceCells) {
  let nearest = Infinity;
  for (const source of sourceCells) {
    nearest = Math.min(nearest, Math.abs(targetX - source.x) + Math.abs(targetY - source.y));
  }
  return nearest;
}

function chebyshevDistance(targetX, targetY, sourceCells) {
  let nearest = Infinity;
  for (const source of sourceCells) {
    nearest = Math.min(nearest, Math.max(Math.abs(targetX - source.x), Math.abs(targetY - source.y)));
  }
  return nearest;
}

/**
 * Squares between two footprints, measured the way the attack grid measures this shape: diagonally for Square and
 * Cone, in straight steps otherwise. The exchange checks a weapon's range with it, so it agrees with the grid.
 * @param {string} shape The attacking weapon's targeting shape.
 * @param {{x: number, y: number, width: number, height: number}} source The attacker's footprint.
 * @param {{x: number, y: number, width: number, height: number}} target The target's footprint.
 * @returns {number}
 */
export function attackShapeDistance(shape, source, target) {
  const distance = usesChebyshev(normalizeShape(shape)) ? chebyshevDistance : manhattanDistance;
  const sourceCells = footprintCells(source.x, source.y, source.width, source.height);
  let nearest = Infinity;
  for (const cell of footprintCells(target.x, target.y, target.width, target.height)) {
    nearest = Math.min(nearest, distance(cell.x, cell.y, sourceCells));
  }
  return nearest;
}

/* -------------------------------------------- */
/*  Directional targeting                       */
/* -------------------------------------------- */
function filterTargetingArea(tiles, sourceCells, area, shape, band) {
  const sectors = activeSectors(area);
  if (!sectors && shape !== 'Cone') return;
  const bounds = footprintBounds(sourceCells);
  for (const key of [...tiles]) {
    const { x, y } = parseCellKey(key);
    const offset = offsetFromBounds(x, y, bounds);
    if (!inTargetingArea(offset.x, offset.y, sectors, shape, band)) tiles.delete(key);
  }
}

function inTargetingArea(dx, dy, sectors, shape, band) {
  if (dx === 0 && dy === 0) return true;
  const list = sectors ?? (shape === 'Cone' ? TARGETING_SECTORS : null);
  if (!list) return true;
  return list.some(sector => shape === 'Cone'
    ? inConeSector(dx, dy, sector, band)
    : inSector(dx, dy, sector));
}

function inConeSector(dx, dy, sector, band) {
  // A diagonal sector is a wedge around the diagonal, with depth counted as ceil(2(h+v)/3) rather than diagonal steps.
  if (sector.ux !== 0 && sector.uy !== 0) {
    const horizontal = dx * sector.ux;
    const vertical = dy * sector.uy;
    if (horizontal < 1 || vertical < 1) return false;
    if (horizontal <= Math.floor(vertical / 2) || vertical <= Math.floor(horizontal / 2)) return false;
    const depth = Math.ceil(((horizontal + vertical) * 2) / 3);
    return depth >= band.min && depth <= band.max;
  }
  const depth = (dx * sector.ux) + (dy * sector.uy);
  const spread = Math.abs((dx * sector.uy) - (dy * sector.ux));
  return depth >= band.min && depth <= band.max && spread <= Math.floor(depth / 2);
}

function inSector(dx, dy, sector) {
  const dot = (dx * sector.ux) + (dy * sector.uy);
  if (dot <= 0) return false;
  const distanceSquared = (dx * dx) + (dy * dy);
  const sectorLengthSquared = (sector.ux * sector.ux) + (sector.uy * sector.uy);
  return (dot * dot * 2) >= (distanceSquared * sectorLengthSquared);
}

/* -------------------------------------------- */
/*  Targeting area preview                      */
/* -------------------------------------------- */
/**
 * Build the Armament sheet's row-major aim grid, marking source, out-of-range and enabled-sector cells.
 * @param {object|null} area Stored per-sector flags.
 * @param {string|number} rng Authored range.
 * @param {string} [shape] Targeting shape.
 * @returns {{size: number, cells: string[]}} Grid edge length and its cell states.
 */
export function projectTargetingAreaPreview(area, rng, shape = 'Cross') {
  const sectors = activeSectors(area);
  const normalized = normalizeShape(shape);
  const chebyshev = usesChebyshev(normalized);
  const authored = previewBand(rng);
  const min = Math.max(0, authored.min);
  const max = Math.min(PREVIEW_MAX_RADIUS, Math.max(min, authored.max, 1));
  const size = (max * 2) + 1;
  const band = { min, max };
  const cells = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const dx = col - max;
      const dy = row - max;
      if (dx === 0 && dy === 0) { cells.push('src'); continue; }
      const distance = chebyshev ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx) + Math.abs(dy);
      if (distance < min || distance > max) { cells.push('blank'); continue; }
      cells.push(inTargetingArea(dx, dy, sectors, normalized, band) ? 'on' : 'off');
    }
  }
  return { size, cells };
}

function previewBand(rng) {
  const end = text => {
    const value = Number.parseInt(String(text).trim(), 10);
    return Number.isFinite(value) ? value : 1;
  };
  if (typeof rng === 'number') return { min: 1, max: Number.isFinite(rng) ? Math.floor(rng) : 1 };
  const text = String(rng ?? '').trim();
  if (!text) return { min: 1, max: 1 };
  const hyphen = text.indexOf('-');
  if (hyphen < 0) return { min: 1, max: end(text) };
  return { min: end(text.slice(0, hyphen)), max: end(text.slice(hyphen + 1)) };
}

/* -------------------------------------------- */
/*  Normalization                               */
/* -------------------------------------------- */
function freezeRange(range, item) {
  const area = item?.area && typeof item.area === 'object'
    ? Object.freeze(Object.fromEntries(TARGETING_SECTORS.map(({ key }) => [key, item.area[key] === true])))
    : null;
  return Object.freeze({
    ...range,
    shape: normalizeShape(item?.shape),
    area,
    losRule: String(item?.losRule ?? 'normal')
  });
}

function normalizeShape(shape) {
  return TARGETING_SHAPES.has(String(shape)) ? String(shape) : 'Cross';
}

function usesChebyshev(shape) {
  return shape === 'Square' || shape === 'Cone';
}

/**
 * How far a range reaches in straight (non-diagonal) steps, for the distance checks that skip far-away units.
 * Square and Cone ranges measure diagonally, so their far corner is twice the maximum away. Only Armaments carry
 * those shapes.
 * @param {{maxRange: number, shape?: string}} range A range from {@link resolveAttackRanges}.
 * @returns {number}
 */
export function attackReachSteps(range) {
  const maxRange = Math.max(0, Math.floor(Number(range?.maxRange) || 0));
  return usesChebyshev(normalizeShape(range?.shape)) ? maxRange * 2 : maxRange;
}

function activeSectors(area) {
  if (!area || typeof area !== 'object') return null;
  const active = TARGETING_SECTORS.filter(sector => area[sector.key] === true);
  return active.length === 0 || active.length === TARGETING_SECTORS.length ? null : active;
}

function footprintBounds(cells) {
  return cells.reduce((bounds, cell) => ({
    minX: Math.min(bounds.minX, cell.x),
    minY: Math.min(bounds.minY, cell.y),
    maxX: Math.max(bounds.maxX, cell.x),
    maxY: Math.max(bounds.maxY, cell.y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function offsetFromBounds(x, y, bounds) {
  const sourceX = Math.min(bounds.maxX, Math.max(bounds.minX, x));
  const sourceY = Math.min(bounds.maxY, Math.max(bounds.minY, y));
  return { x: x - sourceX, y: y - sourceY };
}

/* -------------------------------------------- */
/*  Heightmap visibility                        */
/* -------------------------------------------- */
const HEIGHTMAP_EYE_ALLOWANCE = 1;

/**
 * Decide whether an intermediate terrain column rises above the sightline between two cells. Cells must be whole
 * numbers; the line walk never ends otherwise.
 * @param {number} x0 Source column.
 * @param {number} y0 Source row.
 * @param {number} x1 Target column.
 * @param {number} y1 Target row.
 * @param {Map<string, number>|Record<string, number>} elevations Floor elevation by cell.
 * @param {number} eyeAllowance Allowed height above the interpolated sightline.
 * @returns {boolean}
 */
export function terrainHeightOccludes(
  x0,
  y0,
  x1,
  y1,
  elevations,
  eyeAllowance = HEIGHTMAP_EYE_ALLOWANCE
) {
  if (!hasElevations(elevations)) return false;
  const total = Math.hypot(x1 - x0, y1 - y0);
  if (total === 0) return false;
  const sourceElevation = terrainElevationAt(elevations, x0, y0);
  const targetElevation = terrainElevationAt(elevations, x1, y1);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let error = dx - dy;
  let x = x0;
  let y = y0;

  while (x !== x1 || y !== y1) {
    const doubled = 2 * error;
    if (doubled > -dy) {
      error -= dy;
      x += stepX;
    }
    if (doubled < dx) {
      error += dx;
      y += stepY;
    }
    if (x === x1 && y === y1) break;
    const progress = Math.hypot(x - x0, y - y0) / total;
    const sightElevation = sourceElevation + (progress * (targetElevation - sourceElevation));
    if (terrainElevationAt(elevations, x, y) > sightElevation + eyeAllowance) return true;
  }
  return false;
}

/* -------------------------------------------- */
/*  Heightmap helpers                           */
/* -------------------------------------------- */
function hasElevations(elevations) {
  return elevations instanceof Map ? elevations.size > 0 : Object.keys(elevations ?? {}).length > 0;
}

/**
 * Return one authored floor elevation, with flat ground as the default.
 * @param {Map<string, number>|Record<string, number>} elevations Floor elevation by cell.
 * @param {number} x Cell column.
 * @param {number} y Cell row.
 * @returns {number}
 */
export function terrainElevationAt(elevations, x, y) {
  const key = `${x},${y}`;
  const value = elevations instanceof Map ? elevations.get(key) : elevations?.[key];
  return Number(value) || 0;
}

/* -------------------------------------------- */
/*  Grid sight                                  */
/* -------------------------------------------- */

/**
 * Mark height-occluded ground cells for targeting overlays without removing them, since flying occupants may still
 * be hit. Each cell is tested from the nearest caster footprint cell, and an airborne caster ignores height.
 * @param {object} input Plain cell keys, source cells, elevations, and the looker's flight state.
 * @returns {Set<string>} The height-occluded cell keys.
 */
export function heightOccludedCells(input = {}) {
  const occluded = new Set();
  if (input.airborne === true || !hasElevations(input.elevations)) return occluded;
  const sourceCells = normalizeCells(input.sourceCells);
  if (!sourceCells.length) return occluded;
  const sourceKeys = new Set(sourceCells.map(cell => `${cell.x},${cell.y}`));
  for (const key of input.cells ?? []) {
    if (sourceKeys.has(key)) continue;
    const target = splitKey(key);
    const nearest = nearestCell(sourceCells, target);
    if (terrainHeightOccludes(nearest.x, nearest.y, target.x, target.y, input.elevations)) occluded.add(key);
  }
  return occluded;
}

/**
 * The floor a footprint presents to a unit standing at `sourceElevation`: the cell of its own whose elevation
 * lies nearest, so reaching any one section of a multi-cell target reaches the whole target.
 *
 * `buildAttackTargetingGrid` weighs each cell separately through `filterElevationReach`, and
 * `validateAttackTarget` accepts a click when any cell of the target survived that filter. `resolveEngagement`
 * and `isInMeleeRange` judge from a single elevation instead, so `projectPreCombatApproach` in
 * `foundry/adapters/projections/combat-context.mjs` reads the target footprint through here to reach the same
 * verdict the grid the player clicked on already reached.
 * @param {object} input Plain source elevation, target footprint cells, elevations, and the fallback floor.
 * @returns {number} The nearest cell's elevation, or the fallback when no cell or no terrain was read.
 */
export function reachableFootprintElevation(input = {}) {
  const fallback = Number(input.fallback) || 0;
  if (!hasElevations(input.elevations)) return fallback;
  const cells = normalizeCells(input.cells);
  if (!cells.length) return fallback;
  const source = Number(input.sourceElevation) || 0;
  let nearest = null;
  for (const cell of cells) {
    const elevation = terrainElevationAt(input.elevations, cell.x, cell.y);
    if (nearest === null || Math.abs(source - elevation) < Math.abs(source - nearest)) nearest = elevation;
  }
  return nearest === null ? fallback : nearest;
}

/**
 * Drop the cells whose floor is further from the looker's than `maxDifference`.
 * @param {object} input Plain cell keys, elevations, source elevation, and the allowed difference.
 * @returns {Set<string>} The surviving cell keys.
 */
export function filterElevationReach(input = {}) {
  const cells = new Set(input.cells ?? []);
  if (!hasElevations(input.elevations)) return cells;
  const maximum = Math.max(0, Math.floor(Number(input.maxDifference) || 0));
  const source = Number(input.sourceElevation) || 0;
  for (const key of [...cells]) {
    const cell = splitKey(key);
    if (Math.abs(source - terrainElevationAt(input.elevations, cell.x, cell.y)) > maximum) cells.delete(key);
  }
  return cells;
}

/**
 * Filter area cells for activation targeting. Under normal sight, height limits apply, and walls apply unless sight
 * is ignored. One origin cell passing both tests is enough. The origin is always kept, and airborne targets are
 * exempt from height.
 * @param {object} input Plain cell keys, centre cells, elevations, airborne cells, wall results, and sight rule.
 * @returns {Set<string>} The surviving cell keys.
 */
export function pruneCellsBySight(input = {}) {
  const cells = new Set(input.cells ?? []);
  const losRule = String(input.losRule ?? 'normal');
  if (losRule === 'ignoreLoS') return cells;
  const checkHeight = losRule === 'normal';
  const hasWalls = input.hasWalls === true;
  if (!hasWalls && (!checkHeight || !hasElevations(input.elevations))) return cells;

  const centers = normalizeCells(input.centers);
  const centerKeys = new Set(centers.map(cell => `${cell.x},${cell.y}`));
  const centerElevation = Number(input.centerElevation) || 0;
  const airborne = input.airborneCells instanceof Set ? input.airborneCells : new Set(input.airborneCells ?? []);
  const walls = wallLookup(input.wallBlocked);

  for (const key of [...cells]) {
    if (centerKeys.has(key)) continue;
    const cell = splitKey(key);
    const exempt = checkHeight && airborne.has(key);
    if (checkHeight && !exempt
      && Math.abs(terrainElevationAt(input.elevations, cell.x, cell.y) - centerElevation) > MELEE_ELEVATION_REACH) {
      cells.delete(key);
      continue;
    }
    const visible = centers.some(center => {
      if (checkHeight && !exempt
        && terrainHeightOccludes(center.x, center.y, cell.x, cell.y, input.elevations)) return false;
      return !(hasWalls && walls.get(`${center.x},${center.y}`)?.has(key) === true);
    });
    if (!visible) cells.delete(key);
  }
  return cells;
}

/**
 * Check footprint height occlusion for target validation. Sight is blocked only when every pair of looking and
 * target cells is occluded, and either unit being airborne bypasses the heightmap.
 * @param {object} input Plain looking cells, target cells, elevations, sight rule, and flight state.
 * @returns {boolean}
 */
export function footprintHeightBlocked(input = {}) {
  if (String(input.losRule ?? 'normal') !== 'normal' || input.airborne === true) return false;
  if (!hasElevations(input.elevations)) return false;
  const sourceCells = normalizeCells(input.sourceCells);
  const targetCells = normalizeCells(input.targetCells);
  if (!sourceCells.length || !targetCells.length) return false;
  return targetCells.every(target => sourceCells.every(source => (
    terrainHeightOccludes(source.x, source.y, target.x, target.y, input.elevations)
  )));
}

/* -------------------------------------------- */
/*  Grid sight helpers                          */
/* -------------------------------------------- */
function wallLookup(wallBlocked) {
  const lookup = new Map();
  for (const entry of wallBlocked ?? []) {
    const blocked = entry?.blocked instanceof Set ? entry.blocked : new Set(entry?.blocked ?? []);
    lookup.set(String(entry?.center ?? ''), blocked);
  }
  return lookup;
}

function nearestCell(cells, target) {
  let nearest = cells[0];
  let distance = Math.abs(target.x - nearest.x) + Math.abs(target.y - nearest.y);
  for (const cell of cells.slice(1)) {
    const candidate = Math.abs(target.x - cell.x) + Math.abs(target.y - cell.y);
    if (candidate >= distance) continue;
    nearest = cell;
    distance = candidate;
  }
  return nearest;
}

function normalizeCells(cells) {
  const normalized = [];
  for (const cell of cells ?? []) {
    const entry = typeof cell === 'string' ? splitKey(cell) : { x: Math.floor(Number(cell?.x)), y: Math.floor(Number(cell?.y)) };
    if (Number.isFinite(entry.x) && Number.isFinite(entry.y)) normalized.push(entry);
  }
  return normalized;
}

function splitKey(key) {
  const comma = String(key).indexOf(',');
  return { x: Number(String(key).slice(0, comma)), y: Number(String(key).slice(comma + 1)) };
}

/* -------------------------------------------- */
/*  Activation                                  */
/* -------------------------------------------- */
/**
 * Validate a hotbar attack before ui/controls/targeting.mjs opens its grid.
 * @param {object} input Whether the unit is controlled and planning a move, and the item's owner, type, uses and
 *   requirements.
 * @returns {{ok: boolean, reason: string}}
 */
export function validateAttackActivation(input = {}) {
  const reasons = ATTACK_ACTIVATION_REASONS;
  if (input.controlled !== true) return verdict(false, reasons.SOURCE_NOT_CONTROLLED);
  if (input.movementPlanning !== true || input.planMatches !== true) {
    return verdict(false, reasons.MOVEMENT_PLAN_REQUIRED);
  }
  if (input.itemOwned !== true) return verdict(false, reasons.ITEM_OWNER_MISMATCH);
  if (!ATTACK_ITEM_TYPES.has(String(input.itemType ?? ''))) return verdict(false, reasons.ITEM_NOT_ATTACK);
  if (input.standardAvailable !== true) return verdict(false, reasons.STANDARD_ACTION_REQUIRED);
  if (input.stanceAvailable === false) return verdict(false, reasons.STANCE_BROKEN);
  if (input.magicBlocked === true) return verdict(false, reasons.MAGIC_BLOCKED);
  if (input.itemInfinite !== true && Number(input.itemUses) < 1) return verdict(false, reasons.ITEM_DEPLETED);
  if (!hasRequiredProficiency(input.proficiencies, input.requiredProficiency, input.requiredRank)) {
    return verdict(false, reasons.WEAPON_PROFICIENCY_REQUIRED);
  }
  if (input.weaponArtPresent === true) {
    if (input.weaponArtCompatible !== true) return verdict(false, reasons.WEAPON_ART_MISMATCH);
    if (input.weaponArtUsable !== true) return verdict(false, reasons.WEAPON_ART_DEPLETED);
    if (input.weaponArtAffordable !== true) return verdict(false, reasons.WEAPON_ART_DURABILITY);
    if (input.weaponArtCasterMet === false) return verdict(false, reasons.WEAPON_ART_CASTER_REQUIREMENTS);
  }
  return verdict(true, reasons.READY);
}

/* -------------------------------------------- */
/*  Grid                                        */
/* -------------------------------------------- */
/**
 * Build attack cells for ui/controls/targeting.mjs from plain scene and unit data.
 * Retain height-occluded cells for airborne targets and return them separately for overlay dimming.
 * @param {object} input Plain source, item range, scene bounds, and footprint data.
 * @returns {Readonly<{targetableCells: readonly object[], targetableKeys: ReadonlySet<string>,
 *   flyersOnlyKeys: ReadonlySet<string>}|null>}
 */
export function buildAttackTargetingGrid(input = {}) {
  const range = parseAttackRange(input.range);
  const columns = Math.max(0, Math.floor(Number(input.columns) || 0));
  const rows = Math.max(0, Math.floor(Number(input.rows) || 0));
  if (!range || columns < 1 || rows < 1) return null;
  const source = input.source ?? {};
  const shape = input.square === true ? 'Square' : input.cone === true ? 'Cone' : 'Cross';
  const area = normalizeArea(input.area);
  const keys = calculateAttackTilesFromPosition(
    Math.floor(Number(source.x) || 0),
    Math.floor(Number(source.y) || 0),
    { ...range, shape, area },
    columns,
    rows,
    input.footprint
  );
  const flyersOnlyKeys = applyGridSight(keys, source, input);
  const cells = [...keys].map(parseCellKey).sort(compareCells).map(cell => Object.freeze(cell));
  return Object.freeze({
    targetableCells: Object.freeze(cells),
    targetableKeys: new Set(keys),
    flyersOnlyKeys
  });
}

/**
 * Check a clicked attack target against freshly read map data, for openPreviewForTarget in ui/controls/targeting.mjs
 * before it opens a preview. An attack is always a Hostile pick, whatever target type its weapon names.
 * @param {object} input Plain source, target, grid, faction, and sight data.
 * @returns {{ok: boolean, reason: string}}
 */
export function validateAttackTarget(input = {}) {
  const reasons = ATTACK_TARGET_REASONS;
  if (input.sourceTokenUuid && input.sourceTokenUuid === input.targetTokenUuid) {
    return verdict(false, reasons.TARGET_SELF);
  }
  if (input.targetPresent !== true) return verdict(false, reasons.TARGET_MISSING);
  if (input.targetHidden === true) return verdict(false, reasons.TARGET_HIDDEN);
  const objectTarget = input.targetObject === true;
  if (input.targetDestroyed === true) {
    return verdict(false, objectTarget ? reasons.OBJECT_DESTROYED : reasons.TARGET_DESTROYED);
  }
  if (input.sourceTurnOver === true) return verdict(false, reasons.TURN_OVER);
  if (!objectTarget && input.sourceTauntedByActorUuid
    && input.sourceTauntedByActorUuid !== input.targetActorUuid) return verdict(false, reasons.TAUNTED);
  if (!objectTarget && input.targetSanctuary === true) return verdict(false, reasons.TARGET_SANCTUARY);
  if (!objectTarget && input.meleeOnly === true && airborneBeyondMelee(input)) {
    return verdict(false, reasons.TARGET_AIRBORNE);
  }
  if (input.sightBlocked === true && input.freeTargeting !== true) {
    return verdict(false, reasons.LINE_OF_SIGHT_BLOCKED);
  }
  if (!objectTarget && !targetTypeAdmits('Hostile', input.sourceFaction, input.targetFaction)) {
    return verdict(false, reasons.TARGET_FACTION_INVALID);
  }
  const targetable = input.targetableKeys instanceof Set
    ? input.targetableKeys
    : new Set(input.targetableKeys ?? []);
  const targetCells = Array.isArray(input.targetCells) ? input.targetCells : [];
  if (!targetCells.some(cell => targetable.has(cellKeyOf(cell)))) {
    return verdict(false, reasons.TARGET_OUT_OF_RANGE);
  }
  return verdict(true, reasons.VALID);
}

/**
 * Repeat the host client's attack checks (validateSnapshot in engine/combat/exchanges/gates.mjs) for
 * openPreviewForTarget in ui/controls/targeting.mjs, so the Combat Preview can name the problem instead of offering
 * an Attack the host would refuse. A few checks, such as whether the map changed since, stay with the host client.
 * @param {object|null} snapshot The attack's details as FoundryCombatStateRepository reads them.
 * @returns {{ok: boolean, reason: string}}
 */
export function validateAttackSnapshot(snapshot) {
  const target = ATTACK_TARGET_REASONS;
  const activation = ATTACK_ACTIVATION_REASONS;
  if (!snapshot || snapshot.explorationActive === true || snapshot.sceneGeometryAvailable === false) {
    return verdict(false, target.PREVIEW_UNAVAILABLE);
  }
  if (snapshot.sourceRequirementsMet === false) {
    return verdict(false, snapshot.sourceRequirementCode || target.PREVIEW_UNAVAILABLE);
  }
  if (snapshot.lineOfSightBlocked) return verdict(false, target.LINE_OF_SIGHT_BLOCKED);
  if (!snapshot.sourceInRange) return verdict(false, target.TARGET_OUT_OF_RANGE);
  if (!snapshot.targetFactionValid) return verdict(false, target.TARGET_FACTION_INVALID);
  if (!snapshot.targetEligibilityValid) return verdict(false, target.TARGET_INELIGIBLE);
  if (!snapshot.targetAlive) return verdict(false, target.TARGET_DESTROYED);
  if (!snapshot.sourceItemWielded) return verdict(false, target.PREVIEW_UNAVAILABLE);
  if (!snapshot.sourceItemUsable) return verdict(false, activation.ITEM_DEPLETED);
  if (!snapshot.sourceMagicAvailable) return verdict(false, activation.MAGIC_BLOCKED);
  if (!snapshot.sourceWeaponArtValid) return verdict(false, activation.WEAPON_ART_MISMATCH);
  if (!snapshot.sourceStandardAvailable) return verdict(false, activation.STANDARD_ACTION_REQUIRED);
  return verdict(true, target.VALID);
}

/* -------------------------------------------- */
/*  Rule helpers                                */
/* -------------------------------------------- */
/**
 * Whether a unit holds the proficiency rank a weapon asks for, for the attack grid, its activation check and the
 * threat lines. It asks holdsProficiencyRank in game/progression/rules.mjs with the rank read as a whole number.
 * Only a weapon proficiency is recognised, so any other the weapon names refuses.
 */
export function hasRequiredProficiency(proficiencies, rawRequired, rawRank) {
  const totals = Object.fromEntries(WEAPON_PROFICIENCIES.map(key => [key, proficiencies?.[key]]));
  return holdsProficiencyRank(totals, rawRequired, Math.max(0, Math.floor(Number(rawRank) || 0)));
}

/** Height dimming, and the melee height limit, apply only under the normal sight rule. */
function applyGridSight(keys, source, input) {
  if (input.losRule !== 'normal') return new Set();
  const flyersOnly = heightOccludedCells({
    cells: keys,
    sourceCells: footprintCells(source.x, source.y, input.footprint?.width, input.footprint?.height),
    elevations: input.elevations,
    airborne: input.airborne === true
  });
  if (input.meleeOnly !== true || input.airborne === true) return flyersOnly;
  const reachable = filterElevationReach({
    cells: keys,
    elevations: input.elevations,
    sourceElevation: input.sourceElevation,
    maxDifference: MELEE_ELEVATION_REACH
  });
  for (const key of [...keys]) if (!reachable.has(key)) keys.delete(key);
  for (const key of [...flyersOnly]) if (!keys.has(key)) flyersOnly.delete(key);
  return flyersOnly;
}

function normalizeArea(area) {
  if (!area || typeof area !== 'object') return null;
  const normalized = Object.fromEntries(TARGET_AREA_KEYS.map(key => [key, area[key] === true]));
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function compareCells(left, right) {
  return left.y - right.y || left.x - right.x;
}

/** Every verdict this file returns: `ok` and a reason from one of the two maps above. */
function verdict(ok, reason) {
  return { ok, reason };
}
