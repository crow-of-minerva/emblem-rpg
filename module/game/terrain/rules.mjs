/** @layer game/terrain */
import { FACTION_GROUPS } from '../../contracts/domains/characters.mjs';
import { cellKey, footprintCells as gridFootprintCells } from '../../lib/core/geometry.mjs';
import {
  CROSSING_DC_MULT_DEFAULT,
  CROSSING_DIRECTION_STEPS,
  CROSSING_DIRECTIONS,
  CROSSING_SKILLS,
  EXCEPTION_SELECTORS,
  FALL_BASE_FRACTIONS,
  FALL_MARGIN,
  MAX_BRIDGE_NETWORK,
  MAX_BRIDGE_SPAN,
  MAX_SPAWN_DISPLACEMENT,
  parseTerrainKey,
  TERRAIN_CELL_DEFAULTS,
  TERRAIN_STAT_FIELDS,
  TELEPORT_COSTS,
  TERRAIN_UNIT_TYPES,
  terrainKey,
  TILE_EFFECT_TYPES
} from '../../contracts/domains/terrain.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { buildSkillCheck, checkSuccessChance } from '../rolls/checks.mjs';
import { SKILL_BY_KEY } from '../character/rules.mjs';

/* -------------------------------------------- */
/*  Grid projection                             */
/* -------------------------------------------- */

export { parseTerrainKey, terrainKey };

/** Read one terrain entry without creating a stored default. */
export function terrainCellAt(grid, x, y) {
  return grid?.[terrainKey(x, y)] ?? null;
}

/** Return valid persisted terrain cells. */
export function terrainCells(grid) {
  return Object.entries(grid ?? {}).filter(([, value]) => value && typeof value === 'object');
}

/** Whether a Scene change touches the terrain grid. */
export function terrainGridChanged(changes, systemId = SYSTEM_ID) {
  const flags = changes?.flags?.[systemId];
  if (!flags || typeof flags !== 'object') return false;
  return Object.keys(flags).some(key => key === 'terrainGrid' || key.startsWith('terrainGrid.'));
}

/* -------------------------------------------- */
/*  Elevation transitions                       */
/* -------------------------------------------- */
/** The directions a directional transition opens, or null for any other cell. */
export function normalizeTransitionDirs(data) {
  if (data?.transition !== 'directional') return null;
  const directions = {};
  for (const direction of CROSSING_DIRECTIONS) {
    if (data.transitionDirs?.[direction] === true) directions[direction] = true;
  }
  return Object.keys(directions).length ? directions : null;
}

/* -------------------------------------------- */
/*  Tile effects                                */
/* -------------------------------------------- */

/** Normalize one authored terrain damage or healing effect. `canKillPlayer` is carried for damage only. */
export function sanitizeTileEffect(raw) {
  const type = TILE_EFFECT_TYPES.includes(raw?.type) ? raw.type : 'slashing';
  const value = Math.max(0, Math.floor(Number(raw?.value) || 0));
  const stance = Math.max(0, Math.floor(Number(raw?.stn) || 0));
  const effect = { type, value };
  if (type === 'healing' && stance > 0) effect.stn = stance;
  if (type !== 'healing' && raw?.canKillPlayer === true) effect.canKillPlayer = true;
  return effect;
}

/** Whether a normalized terrain effect changes a resource. */
export function tileEffectIsActive(effect) {
  return effect.value > 0 || (effect.type === 'healing' && (effect.stn ?? 0) > 0);
}

/** Read a cell's active hazards for terrain effect planning. */
export function tileEffectsOf(entry) {
  if (!Array.isArray(entry?.tileEffects)) return [];
  return entry.tileEffects.map(sanitizeTileEffect).filter(tileEffectIsActive);
}

/* -------------------------------------------- */
/*  Unit exceptions                             */
/* -------------------------------------------- */
const SELECTOR_VALUES = Object.freeze(EXCEPTION_SELECTORS.map(entry => entry.value));
const FACTION_MEMBERS = FACTION_GROUPS;

/** Normalize one exception without allowing a half-authored entry to match. */
export function sanitizeException(raw) {
  return {
    selector: SELECTOR_VALUES.includes(raw?.selector) ? raw.selector : 'unitType',
    value: String(raw?.value ?? '').trim(),
    syncMove: raw?.syncMove === true,
    syncEffect: raw?.syncEffect === true
  };
}

/**
 * Which of a cell's rules a unit is exempt from through a matching exception. A match always lifts the stat
 * modifiers, and lifts the movement cost and the hazards when the exception says so.
 */
export function cellExemptions(exceptions, profile) {
  const result = { stats: false, move: false, effect: false };
  if (!Array.isArray(exceptions) || !profile) return result;
  for (const raw of exceptions) {
    const exception = sanitizeException(raw);
    if (!terrainExceptionMatches(exception, profile)) continue;
    result.stats = true;
    if (exception.syncMove) result.move = true;
    if (exception.syncEffect) result.effect = true;
    if (result.move && result.effect) break;
  }
  return result;
}

/** Every exception a grid authors, each selector and value once, in first-seen order. */
export function terrainExceptions(grid) {
  const seen = new Map();
  for (const [, entry] of terrainCells(grid)) {
    if (!Array.isArray(entry.exceptions)) continue;
    for (const raw of entry.exceptions) {
      const exception = sanitizeException(raw);
      if (!exception.value) continue;
      const key = `${exception.selector}=${exception.value}`;
      if (!seen.has(key)) seen.set(key, Object.freeze(exception));
    }
  }
  return Object.freeze([...seen.values()]);
}

/** Which authored exceptions a unit matches: units matching the same ones read a grid identically. */
export function terrainProfileClass(exceptions, profile) {
  if (!profile) return '';
  return exceptions.filter(exception => terrainExceptionMatches(exception, profile))
    .map(exception => `${exception.selector}=${exception.value}`).join('|');
}

function terrainExceptionMatches(exception, profile) {
  if (!exception.value) return false;
  if (exception.selector === 'unitType') return profile.unitTypes?.includes(exception.value) === true;
  if (exception.selector === 'faction') {
    return FACTION_MEMBERS[exception.value]?.includes(profile.actorType) === true;
  }
  if (exception.selector === 'name') {
    return String(profile.name ?? '').trim().toLowerCase() === exception.value.toLowerCase();
  }
  return exception.selector === 'actorId' && profile.uuids?.includes(exception.value) === true;
}

/** Build the narrow serializable profile consumed by terrain exception rules. */
export function normalizeTerrainProfile(raw) {
  return Object.freeze({
    name: String(raw?.name ?? ''),
    actorType: String(raw?.actorType ?? ''),
    unitTypes: Object.freeze(TERRAIN_UNIT_TYPES.filter(type => raw?.unitTypes?.includes(type))),
    uuids: Object.freeze((raw?.uuids ?? []).map(String).filter(Boolean))
  });
}

/* -------------------------------------------- */
/*  Unit modifiers                              */
/* -------------------------------------------- */
const TERRAIN_STAT_KEYS = Object.freeze(['evasionMod', 'defMod', 'resMod']);

/**
 * The terrain stat modifiers under a footprint, for planTerrainStatFields and projectTerrainModifiersAt in
 * foundry/adapters/projections/board.mjs. For each stat, the strongest positive and the strongest negative tile
 * values combine, instead of every occupied cell adding up.
 * @param {object} grid Persisted terrain grid.
 * @param {Array<[number, number]>} cells Footprint cells as column and row pairs.
 * @param {object|null} profile Normalized exception profile for the unit standing there.
 * @returns {{evasionMod: number, defMod: number, resMod: number}}
 */
export function terrainStatModifiers(grid, cells, profile) {
  const negative = { evasionMod: 0, defMod: 0, resMod: 0 };
  const positive = { evasionMod: 0, defMod: 0, resMod: 0 };
  for (const [x, y] of cells ?? []) {
    const entry = terrainCellAt(grid, x, y);
    if (!entry || cellExemptions(entry.exceptions, profile).stats) continue;
    for (const key of TERRAIN_STAT_KEYS) {
      const value = Number(entry[key]) || 0;
      if (!value) continue;
      if (value < 0) negative[key] = Math.min(negative[key], value);
      else positive[key] = Math.max(positive[key], value);
    }
  }
  return {
    evasionMod: negative.evasionMod + positive.evasionMod,
    defMod: negative.defMod + positive.defMod,
    resMod: negative.resMod + positive.resMod
  };
}

/** Enumerate the cells one footprint occupies. */
export function footprintCells(footprint) {
  return gridFootprintCells(footprint?.x, footprint?.y, footprint?.width, footprint?.height)
    .map(cell => [cell.x, cell.y]);
}

/**
 * Plan the terrain stat fields each changed unit should carry, for engine/board.mjs. Airborne and unplaced units
 * get zero modifiers, so stale terrain bonuses are cleared.
 * @param {{grid: object, units: object[]}} board Detached terrain board snapshot.
 * @returns {Array<{actorUuid: string, fields: Record<string, number>}>}
 */
export function planTerrainStatFields(board) {
  const grid = board.grid ?? {};
  const plans = [];
  const planned = new Set();
  for (const unit of Array.isArray(board.units) ? board.units : []) {
    const actorUuid = String(unit?.actorUuid ?? '');
    if (!actorUuid || planned.has(actorUuid)) continue;
    planned.add(actorUuid);
    const modifiers = unit.placed && !unit.airborne
      ? terrainStatModifiers(grid, footprintCells(unit.footprint), unit.profile)
      : { evasionMod: 0, defMod: 0, resMod: 0 };
    const fields = {};
    let changed = false;
    for (const [field, flag] of Object.entries(TERRAIN_STAT_FIELDS)) {
      fields[flag] = modifiers[field];
      if ((Number(unit.fields?.[flag]) || 0) !== modifiers[field]) changed = true;
    }
    if (changed) plans.push({ actorUuid, fields });
  }
  return plans;
}

/* -------------------------------------------- */
/*  Movement projection                         */
/* -------------------------------------------- */

/** Build the terrain costs and blocked cells consumed by game/movement/pathfinding.mjs. */
export function projectTerrainMovement(grid, profile, {
  airborne = false,
  mounted = false,
  terrainCostReduction = 0,
  zones = {}
} = {}) {
  const teleports = projectTerrainTeleports(grid, { airborne, mounted });
  const crossings = projectTerrainCrossings(grid, zones);
  const costs = {};
  const obstacles = [];
  const impassable = [];
  const elevations = {};
  const transitionDirections = {};
  const restrictedTransitions = [];
  for (const [key, entry] of terrainCells(grid)) {
    const exemptions = cellExemptions(entry.exceptions, profile);
    const { x, y } = parseTerrainKey(key);
    const movementKey = `${x},${y}`;
    if (entry.impassable === true) impassable.push({ x, y });
    else if (entry.obstacle === true) obstacles.push({ x, y });
    if (!airborne && !exemptions.move) {
      const cost = Number(entry.movementCost ?? TERRAIN_CELL_DEFAULTS.movementCost);
      if (Number.isFinite(cost) && cost >= 0 && cost !== 1) {
        costs[movementKey] = cost === 0 ? 0 : Math.max(1, cost - Math.max(0, terrainCostReduction));
      }
    }
    const elevation = Number(entry.elevation) || 0;
    if (elevation) elevations[movementKey] = elevation;
    const directions = normalizeTransitionDirs(entry);
    if (directions) transitionDirections[movementKey] = Object.freeze({ ...directions });
    const restricted = directions && ((entry.transitionRestrict === 'flying' && airborne)
      || (entry.transitionRestrict === 'mounted' && mounted));
    if (restricted) restrictedTransitions.push({ x, y });
  }
  return Object.freeze({
    costs: Object.freeze(costs),
    obstacles: Object.freeze(obstacles.map(cell => Object.freeze(cell))),
    impassable: Object.freeze(impassable.map(cell => Object.freeze(cell))),
    elevations: Object.freeze(elevations),
    transitionDirections: Object.freeze(transitionDirections),
    restrictedTransitions: Object.freeze(restrictedTransitions.map(cell => Object.freeze(cell))),
    teleports,
    crossings
  });
}

/** Build detached terrain views consumed by presentation/canvas/terrain.mjs. */
export function projectTerrainPresentation(grid, zones = {}, {
  showHiddenSpawns = false,
  spawnImages = {}
} = {}) {
  const cells = terrainCells(grid).map(([key, entry]) => {
    const point = parseTerrainKey(key);
    const projected = structuredClone(entry);
    projected.spawns = (Array.isArray(entry.spawns) ? entry.spawns : [])
      .filter(spawn => showHiddenSpawns || spawn?.visible === true)
      .map(spawn => ({
        ...structuredClone(spawn),
        image: String(spawnImages?.[spawn?.uuid] ?? '')
      }));
    return {
      ...projected,
      key,
      x: point.x,
      y: point.y,
      tileEffects: tileEffectsOf(entry),
      transitionDirections: { ...(normalizeTransitionDirs(entry) ?? {}) }
    };
  });
  return {
    cells,
    zones: Object.fromEntries(Object.entries(zones ?? {}).map(([key, value]) => [
      key, { ...structuredClone(value) }
    ]))
  };
}

/* -------------------------------------------- */
/*  Elevation crossings                         */
/* -------------------------------------------- */

/**
 * The crossing a step between two elevations asks for, for evaluateCrossing, or null where the step crosses
 * nothing. By default climbing rolls Athletics and descending rolls Finesse, at DC 5 per level of height. The
 * origin cell's directional override can change the skill and the rate, or forbid the crossing.
 */
function resolveCrossing({ fromElevation, toElevation, override = null, zoneName = '' } = {}) {
  const from = Number(fromElevation) || 0;
  const to = Number(toElevation) || 0;
  if (from === to) return null;
  const skillType = String(override?.skill || (to > from ? CROSSING_SKILLS.ATHLETICS : CROSSING_SKILLS.FINESSE));
  if (skillType === CROSSING_SKILLS.DISABLED) return null;
  const mult = Number(override?.mult);
  const rate = Number.isFinite(mult) ? Math.max(0, mult) : CROSSING_DC_MULT_DEFAULT;
  return {
    fromElevation: from,
    toElevation: to,
    descending: from > to,
    levels: Math.abs(from - to),
    dc: Math.round(rate * Math.abs(from - to)),
    skillType,
    zoneName: String(zoneName || 'Ground Floor')
  };
}

/**
 * The skill resolveCrossingCheck rolls. An Either crossing takes whichever skill gives this unit the better odds,
 * and Athletics on a tie.
 */
function resolveCrossingSkill(skillType, odds = {}) {
  if (skillType !== CROSSING_SKILLS.EITHER) return String(skillType);
  const athletics = Number(odds[CROSSING_SKILLS.ATHLETICS]) || 0;
  const finesse = Number(odds[CROSSING_SKILLS.FINESSE]) || 0;
  return athletics >= finesse ? CROSSING_SKILLS.ATHLETICS : CROSSING_SKILLS.FINESSE;
}

/**
 * Build the crossing check and odds for movement previews and engine settlement.
 * Compare full skill chances, including stat bonuses, before choosing an Either skill.
 * @param {object} crossing The crossing, carrying `skillType` and `dc`.
 * @param {object} unit Detached unit facts: `skills`, `attributes`, `factionRole`, `blessed`.
 * @returns {{skillKey: string, check: object|null, chance: number}} Chance as a whole percentage.
 */
export function resolveCrossingCheck(crossing, unit = {}) {
  const checkFor = skillKey => {
    const skill = SKILL_BY_KEY[skillKey];
    if (!skill) return null;
    return buildSkillCheck({
      skillKey,
      mode: 'standard',
      dc: crossing?.dc,
      rank: unit.skills?.[skillKey],
      statValue: unit.attributes?.[skill.stat],
      actorType: unit.factionRole,
      blessed: unit.blessed
    });
  };
  const chanceFor = check => (check ? Math.round(checkSuccessChance(check) * 100) : 0);
  const odds = {};
  for (const skillKey of [CROSSING_SKILLS.ATHLETICS, CROSSING_SKILLS.FINESSE]) {
    odds[skillKey] = chanceFor(checkFor(skillKey));
  }
  const skillKey = resolveCrossingSkill(crossing?.skillType, odds);
  const check = checkFor(skillKey);
  return { skillKey, check, chance: chanceFor(check) };
}

/**
 * Calculate failed-descent damage for engine crossing settlement from height and failure margin.
 * @param {object} input Levels descended, the miss, and the unit's maximum health.
 * @returns {number} Damage, rounded.
 */
export function crossingFallDamage({ levels = 0, miss = 0, maxHp = 0 } = {}) {
  const dropped = Math.max(0, Math.floor(Number(levels) || 0));
  if (dropped <= 0) return 0;
  const base = FALL_BASE_FRACTIONS[dropped] ?? (dropped - 3);
  const shortfall = Math.min(Math.max(Number(miss) || 0, 0), FALL_MARGIN) / FALL_MARGIN;
  return Math.round(Math.max(0, Number(maxHp) || 0) * base * shortfall);
}

/** Identify bridge cells for crossingBridgeLandings: an impassable gap with an authored crossing direction. */
function crossingBridges(board, x, y, direction) {
  const cell = board[terrainKey(x, y)];
  if (!cell?.blocking) return false;
  return cell.directions?.[direction] === true;
}

/**
 * The crossing board projectTerrainMovement hands out as `crossings`: only the fields the crossing rules read
 * (elevation, transition directions, per-direction overrides, standing blockers and zone name), in one frozen entry
 * per square that says anything about crossing it.
 */
function projectTerrainCrossings(grid, zones = {}) {
  const board = {};
  for (const [key, entry] of terrainCells(grid)) {
    const directions = normalizeTransitionDirs(entry);
    const elevation = Number(entry.elevation) || 0;
    const blocking = entry.obstacle === true || entry.impassable === true;
    if (!elevation && !directions && !blocking && !entry.crossing) continue;
    board[key] = Object.freeze({
      elevation,
      blocking,
      transition: String(entry.transition ?? ''),
      directions: directions ? Object.freeze({ ...directions }) : null,
      crossing: entry.crossing ? Object.freeze(structuredClone(entry.crossing)) : null,
      zoneName: String(zones?.[entry.zoneId]?.name ?? '')
    });
  }
  return Object.freeze(board);
}

/**
 * Find bridge-network exits for movement crossing choices. The walk follows authored entry and exit directions
 * through stacked or branching bridge cells, so one attempt can offer several landings.
 * @param {object} board The crossing board from projectTerrainMovement's `crossings`.
 * @param {{x: number, y: number}} from The square being left.
 * @param {string|null} [firstDirection] Only walk routes that begin this way.
 * @returns {object[]} One landing per reachable square, carrying its first and last step.
 */
export function crossingBridgeLandings(board, from, firstDirection = null) {
  const originX = Math.floor(Number(from?.x) || 0);
  const originY = Math.floor(Number(from?.y) || 0);
  const landings = new Map();
  const seen = new Set([cellKey(originX, originY)]);
  const queue = [];
  const enter = (x, y, direction, first) => {
    const key = cellKey(x, y);
    if (seen.has(key) || !crossingBridges(board, x, y, direction)) return;
    seen.add(key);
    queue.push({ x, y, first: first ?? direction });
  };
  for (const direction of (firstDirection ? [firstDirection] : CROSSING_DIRECTIONS)) {
    const [dx, dy] = CROSSING_DIRECTION_STEPS[direction];
    enter(originX + dx, originY + dy, direction, direction);
  }
  let walked = 0;
  while (queue.length > 0 && walked < MAX_BRIDGE_NETWORK) {
    walked += 1;
    const node = queue.shift();
    const directions = board[terrainKey(node.x, node.y)]?.directions ?? {};
    for (const direction of CROSSING_DIRECTIONS) {
      const [dx, dy] = CROSSING_DIRECTION_STEPS[direction];
      const x = node.x + dx;
      const y = node.y + dy;
      const key = cellKey(x, y);
      if (crossingBridges(board, x, y, direction)) { enter(x, y, direction, node.first); continue; }
      if (!directions[direction] || seen.has(key) || landings.has(key)) continue;
      if (Math.abs(x - originX) > MAX_BRIDGE_SPAN || Math.abs(y - originY) > MAX_BRIDGE_SPAN) continue;
      landings.set(key, { x, y, direction: node.first, approach: direction });
    }
  }
  return [...landings.values()];
}

/** The orthogonal direction between two adjacent squares, or null when they are not one step apart. */
export function crossingStepDirection(from, to) {
  const dx = (Number(to?.x) || 0) - (Number(from?.x) || 0);
  const dy = (Number(to?.y) || 0) - (Number(from?.y) || 0);
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  if (dx === 0) return dy > 0 ? 'down' : 'up';
  return dx > 0 ? 'right' : 'left';
}

/**
 * Validate a crossing requested by movement commands. Non-adjacent targets must be bridge exits,
 * and the origin's first-step override governs the whole attempt.
 * @param {object} board The crossing board from projectTerrainMovement's `crossings`.
 * @param {{x: number, y: number}} from The square being left.
 * @param {{x: number, y: number}} to The square aimed at.
 * @returns {object|null}
 */
export function evaluateCrossing(board, from, to) {
  const dx = (Number(to?.x) || 0) - (Number(from?.x) || 0);
  const dy = (Number(to?.y) || 0) - (Number(from?.y) || 0);
  let direction = crossingStepDirection(from, to);
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    const landing = crossingBridgeLandings(board, from).find(entry => entry.x === to.x && entry.y === to.y);
    if (!landing) return null;
    direction = landing.direction;
  }
  if (!direction) return null;
  const crossing = resolveCrossing({
    fromElevation: board[terrainKey(from.x, from.y)]?.elevation,
    toElevation: board[terrainKey(to.x, to.y)]?.elevation,
    override: crossingOverrideAt(board, from, direction),
    zoneName: board[terrainKey(to.x, to.y)]?.zoneName
  });
  if (!crossing) return null;
  return {
    ...crossing,
    direction,
    from: Object.freeze({ x: from.x, y: from.y }),
    to: Object.freeze({ x: to.x, y: to.y })
  };
}

/** A square's authored override for one direction, read only while its transition is still a crossing. */
function crossingOverrideAt(board, cell, direction) {
  const entry = board[terrainKey(cell.x, cell.y)];
  if (entry?.transition !== 'crossing') return null;
  const override = entry.crossing?.[direction];
  return override?.skill ? override : null;
}

/** Every square a crossing could be attempted onto from here: the four neighbours, plus any bridge landing. */
export function crossingTargets(board, from) {
  const targets = CROSSING_DIRECTIONS.map(direction => {
    const [dx, dy] = CROSSING_DIRECTION_STEPS[direction];
    return { x: from.x + dx, y: from.y + dy };
  });
  for (const landing of crossingBridgeLandings(board, from)) targets.push({ x: landing.x, y: landing.y });
  return targets;
}

/* -------------------------------------------- */
/*  Teleport pads                               */
/* -------------------------------------------- */

/**
 * The teleport pads projectTerrainMovement hands out, in cell-key order: each pad's square, letter, price and
 * partner square. A pad pairs with the first other pad of the same letter. Unpaired pads are kept so activation can
 * explain the missing exit. A pad authored No Flying or No Mounted is marked `restricted` for a unit that flies or
 * rides, and refuses it.
 */
function projectTerrainTeleports(grid, { airborne = false, mounted = false } = {}) {
  const pads = [];
  for (const [key, entry] of terrainCells(grid)) {
    if (entry.transition !== 'teleport') continue;
    const letter = String(entry.teleportLetter ?? '');
    if (!letter) continue;
    const { x, y } = parseTerrainKey(key);
    pads.push({
      x,
      y,
      letter,
      cost: TELEPORT_COSTS[String(entry.teleportCost ?? '').toUpperCase()] ?? TELEPORT_COSTS.STANDARD,
      movementCost: Math.max(0, Math.floor(Number(entry.teleportMov) || 0)),
      blockable: entry.teleportBlockable === true,
      restricted: (entry.transitionRestrict === 'flying' && airborne)
        || (entry.transitionRestrict === 'mounted' && mounted),
      exit: null
    });
  }
  for (const pad of pads) {
    const partner = pads.find(other => other !== pad && other.letter === pad.letter);
    pad.exit = partner ? Object.freeze({ x: partner.x, y: partner.y }) : null;
  }
  return Object.freeze(pads.map(pad => Object.freeze(pad)));
}

/** The pad a unit is standing on, or null when its square carries none. */
export function teleportPadAt(pads = [], cell) {
  const x = Math.floor(Number(cell?.x) || 0);
  const y = Math.floor(Number(cell?.y) || 0);
  return pads.find(pad => pad.x === x && pad.y === y) ?? null;
}

/**
 * Choose a teleport destination before engine movement settlement spends its cost. A blockable exit refuses an
 * occupied cell, and any other exit searches for a free footprint on the exit floor.
 * Trust the authored exit itself and do not treat type-restricted transitions as standing blockers.
 * @param {object} board Detached placement board: `grid`, `bounds`, `occupied` cell keys, `blocked` cell keys
 *   and `elevations`.
 * @param {object} pad The pad being used, carrying its `exit`.
 * @param {{width: number, height: number}} footprint The passenger's footprint.
 * @returns {{ok: boolean, code: string, destination?: object}}
 */
export function resolveTeleportLanding(board, pad, footprint) {
  if (!pad || pad.restricted) return landing(false, RESULT_CODES.TELEPORT_UNAVAILABLE);
  if (!pad.exit) return landing(false, RESULT_CODES.TELEPORT_UNPAIRED);
  const placement = { ...pad.exit, width: footprint?.width, height: footprint?.height };
  if (placementIsClear(board, placement)) {
    return landing(true, RESULT_CODES.TELEPORT_USED, pad.exit);
  }
  if (pad.blockable) return landing(false, RESULT_CODES.TELEPORT_EXIT_BLOCKED);
  const floor = Number(board.elevations?.[cellKey(pad.exit.x, pad.exit.y)]) || 0;
  const sameFloor = { ...board, floor };
  const spilled = nearestClearPlacement(sameFloor, placement);
  return spilled
    ? landing(true, RESULT_CODES.TELEPORT_USED, spilled)
    : landing(false, RESULT_CODES.TELEPORT_EXIT_CROWDED);
}

/**
 * Plan teleport costs for engine/movement/commands.mjs. Movement-cost pads continue planning,
 * bonus-cost pads close movement, and action-cost pads end the turn. Exploration pays nothing.
 * @param {object} pad The pad being used.
 * @param {object} turn Detached turn facts: what remains of the action, the bonus and the movement.
 * @returns {{ok: boolean, code: string, movementSpent?: number, resume?: boolean, endTurn?: boolean,
 *   anchors?: boolean}}
 */
export function resolveTeleportCost(pad, turn = {}) {
  if (turn.exploring === true) return charge(0, true, false);
  if (pad.cost === TELEPORT_COSTS.MOVEMENT) {
    return Math.max(0, Number(turn.movementRemaining) || 0) >= pad.movementCost
      ? charge(pad.movementCost, true, false)
      : landing(false, RESULT_CODES.TELEPORT_MOVEMENT_REQUIRED);
  }
  if (pad.cost === TELEPORT_COSTS.BONUS) {
    return turn.bonusAvailable === true
      ? charge(0, true, false, { bonus: true })
      : landing(false, RESULT_CODES.TELEPORT_BONUS_REQUIRED);
  }
  return turn.actionAvailable === true
    ? charge(0, false, true, { action: true })
    : landing(false, RESULT_CODES.TELEPORT_ACTION_REQUIRED);
}

function landing(ok, code, destination = null) {
  return destination ? { ok, code, destination: Object.freeze({ ...destination }) } : { ok, code };
}

function charge(movementSpent, resume, endTurn, spends = {}) {
  return {
    ok: true,
    code: RESULT_CODES.TELEPORT_USED,
    movementSpent,
    resume,
    endTurn,
    spendsBonus: spends.bonus === true,
    spendsAction: spends.action === true,
    anchors: spends.bonus === true
  };
}

/* -------------------------------------------- */
/*  Spawn placement                             */
/* -------------------------------------------- */

/**
 * Choose a spawn destination for engine/terrain/effects.mjs. A blockable arrival refuses an occupied cell, and any
 * other searches for the nearest legal footprint.
 * @param {object} board Detached placement board: `grid`, `bounds` and `occupied` cell keys.
 * @param {{x: number, y: number, width: number, height: number}} footprint Authored placement.
 * @param {boolean} blockable Whether an occupied square refuses instead of displacing.
 * @returns {{x: number, y: number}|null}
 */
export function resolveSpawnPlacement(board, footprint, blockable) {
  if (placementIsClear(board, footprint)) {
    return { x: Math.round(Number(footprint.x) || 0), y: Math.round(Number(footprint.y) || 0) };
  }
  return blockable ? null : nearestClearPlacement(board, footprint);
}

/** The cell keys a settled placement takes out of circulation for the arrivals after it. */
export function placementOccupancyKeys(footprint) {
  return footprintCells(footprint).map(([x, y]) => cellKey(x, y));
}

/* -------------------------------------------- */
/*  Landing resolution                          */
/* -------------------------------------------- */

/**
 * Whether a footprint can be set down on a square.
 *
 * Every cell it would cover has to be inside the map, clear of obstacles and impassable terrain, and free of
 * anything already standing there.
 */
function placementIsClear(board, footprint) {
  const occupied = board.occupied instanceof Set
    ? board.occupied
    : new Set(Array.isArray(board.occupied) ? board.occupied : []);
  const columns = Number(board.bounds?.columns);
  const rows = Number(board.bounds?.rows);
  for (const [x, y] of footprintCells(footprint)) {
    if (x < 0 || y < 0) return false;
    if (Number.isFinite(columns) && x >= columns) return false;
    if (Number.isFinite(rows) && y >= rows) return false;
    const key = cellKey(x, y);
    const entry = terrainCellAt(board.grid, x, y);
    if (entry?.impassable === true || entry?.obstacle === true) return false;
    if (board.blocked instanceof Set && board.blocked.has(key)) return false;
    if (occupied.has(key)) return false;
    if (Number.isFinite(board.floor) && (Number(board.elevations?.[key]) || 0) !== board.floor) return false;
  }
  return true;
}

/**
 * The nearest square that can hold the footprint, searched by rings of Chebyshev distance so nearest means
 * what it looks like on a grid. Null means nothing within reach can hold the unit.
 */
function nearestClearPlacement(board, footprint, maxDisplacement = MAX_SPAWN_DISPLACEMENT) {
  const x = Math.round(Number(footprint?.x) || 0);
  const y = Math.round(Number(footprint?.y) || 0);
  const dimensions = { width: footprint?.width, height: footprint?.height };
  for (let ring = 1; ring <= maxDisplacement; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        if (placementIsClear(board, { ...dimensions, x: x + dx, y: y + dy })) {
          return { x: x + dx, y: y + dy };
        }
      }
    }
  }
  return null;
}
