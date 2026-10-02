/** @layer game/movement */
import {
  crossingBridgeLandings,
  crossingStepDirection,
  crossingTargets,
  evaluateCrossing,
  resolveCrossingCheck
} from '../terrain/rules.mjs';
import { fixtureHiddenFromMovement, successChanceBand } from '../objects/rules.mjs';
import { FORCED_STEP_OUTCOMES, TELEPORT_COSTS } from '../../contracts/domains/terrain.mjs';
import { MELEE_ELEVATION_REACH } from '../../contracts/domains/combat.mjs';
import {
  calculateAttackTilesFromPosition,
  terrainElevationAt,
  terrainHeightOccludes
} from '../targeting/attack-grid.mjs';
import { cellKey, parseCellKey, rectDistance } from '../../lib/core/geometry.mjs';
import { areFactionsFriendly } from '../character/rules.mjs';
import { finite as finiteNumber } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Grid vocabulary                             */
/* -------------------------------------------- */
const DIRECTIONS = Object.freeze([
  Object.freeze({ x: 0, y: -1 }),
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 0, y: 1 }),
  Object.freeze({ x: -1, y: 0 })
]);
const DIAGONAL_DIRECTIONS = Object.freeze([
  Object.freeze({ x: 1, y: -1 }),
  Object.freeze({ x: 1, y: 1 }),
  Object.freeze({ x: -1, y: 1 }),
  Object.freeze({ x: -1, y: -1 })
]);
const EPSILON = 0.000001;
const OBJECT_FIXTURE_TYPES = Object.freeze([
  'Chest', 'Armament', 'Loot', 'Gathering Node', 'Altar', 'Cooking Pot', 'Stationary', 'Workshop',
  'Laboratory', 'Instrument'
]);

/* -------------------------------------------- */
/*  Unit occupancy                              */
/* -------------------------------------------- */
/**
 * Whether the moving unit may pass through another unit's square, and whether that square is taken so the unit
 * cannot stop there. Allies can be passed, and so can any unit at a different height: a flier passes over a ground
 * unit and the other way round. A hidden fixture neither blocks nor takes a square, except a hidden Destructible,
 * which still blocks.
 */
export function resolveMovementOccupancy(moving, other) {
  const occupiesLanding = unitOccupiesLanding(other);
  if (!other) return { occupiesLanding, canPass: false };
  if (moving?.passing || other.passable || !occupiesLanding) {
    return { occupiesLanding, canPass: true };
  }
  if (other.actorType === 'Object' && other.objectType === 'Destructible') {
    const canPass = other.blocksFlyers ? false : moving?.airborne === true;
    return { occupiesLanding, canPass };
  }
  if (other.actorType === 'Object') {
    // Objects take no side, so faction never lets a unit through. A locked Door stops fliers too.
    return { occupiesLanding, canPass: other.objectType !== 'Door' && moving?.airborne === true };
  }
  const canPass = (moving?.airborne === true) !== (other.airborne === true)
    || areFactionsFriendly(moving?.faction, other.faction);
  return { occupiesLanding, canPass };
}

/* -------------------------------------------- */
/*  Landing                                     */
/* -------------------------------------------- */
/**
 * Whether an obstacle lies under a footprint, so a flier cannot land there. Only a stance break sets a flier down on
 * one anyway.
 * @param {{x: number, y: number}} anchor The footprint's top-left square.
 * @param {{width?: number, height?: number}} [footprint] Its size in squares.
 * @param {Array<{x: number, y: number}>} [obstacles] The Scene's obstacle squares (`terrainOcclusionCells` in the
 *   unit's movement data).
 * @returns {boolean}
 */
export function landingBlocked(anchor, footprint, obstacles) {
  const blocked = new Set((obstacles ?? []).map(cell => `${cell.x},${cell.y}`));
  if (!blocked.size) return false;
  const width = Math.max(1, Number(footprint?.width) || 1);
  const height = Math.max(1, Number(footprint?.height) || 1);
  for (let dx = 0; dx < width; dx += 1) {
    for (let dy = 0; dy < height; dy += 1) {
      if (blocked.has(`${anchor.x + dx},${anchor.y + dy}`)) return true;
    }
  }
  return false;
}

/**
 * Whether the unit is standing over an obstacle right now, a square a flier cannot land on.
 * @param {object|null} movement The unit's movement data: `current`, `footprint` and `terrainOcclusionCells`.
 * @returns {boolean}
 */
export function standsOverObstacle(movement) {
  if (!movement?.current) return false;
  return landingBlocked(movement.current, movement.footprint, movement.terrainOcclusionCells);
}

/**
 * Whether a unit is stuck where it stands: a stance break knocked a flier to the ground (`groundedByStanceBreak`)
 * while it was over an obstacle. It cannot move on its own until it takes off again, so buildMovementGraph gives it
 * no steps. A push, a swap or an effect that places it still moves it.
 * @param {object} source The unit's movement data: `groundedByStanceBreak`, `flying`, `airborne`, `footprint` and
 *   `terrainOcclusionCells`.
 * @param {{x: number, y: number}} [anchor] The square it stands on. Defaults to `source.start`.
 * @returns {boolean}
 */
export function movementStranded(source = {}, anchor = source.start) {
  if (source.groundedByStanceBreak !== true || source.flying !== true || source.airborne === true || !anchor) {
    return false;
  }
  return landingBlocked(anchor, source.footprint, source.terrainOcclusionCells);
}

/* -------------------------------------------- */
/*  Public pathfinding                          */
/* -------------------------------------------- */
/**
 * Build the movement graph used by movement previews, move validation and the Enemy AI. It is a cheapest-first
 * (Dijkstra) search over 4-way steps, ordered by route (movement cost plus any `cellPenalties`) and stopped at the
 * unit's allowance in movement cost. For a token larger than one square, a step costs the most expensive square under
 * the new footprint, and walls are tested on each footprint square's centre-to-centre line.
 * Teleport edges are opt-in: the normal player grid stops at the pad until the player activates it.
 * Only pads that cost movement can become graph edges. A unit stuck where the search starts (movementStranded)
 * keeps its own square and nothing more, with no movement left for a crossing.
 * @param {object} source The map's terrain and the unit's movement data.
 * @param {object} [options]
 * @param {boolean} [options.teleports] Whether movement-cost pads become edges of the graph.
 * @param {{x: number, y: number}|null} [options.start] Search from this square instead of the unit's `start`.
 * @param {number|null} [options.allowance] Reach to search to, `Infinity` included, instead of the unit's own.
 * @param {object|null} [options.cellPenalties] A surcharge, by cell key, added to the route cost of entering a cell.
 *   It is meant to steer the route only, but since each square keeps its cheapest route, a penalty can also hide
 *   squares near the edge of the allowance and raise the cost reported for others.
 * @param {boolean} [options.attackReach] Whether the attack reach is measured. False leaves both tile lists empty.
 * @param {boolean} [options.keyboardDiagonals] Whether the diagonal keyboard steps are listed. False leaves
 *   `diagonalStepKeys` empty for a reader that never moves the unit by key, such as the threat overlay's reach.
 * @param {boolean} [options.reverse] Search toward `start` instead of away from it. Every step and teleport is taken
 *   against its direction, so a cell's cost and route are what walking from it to `start` costs, its parent is the
 *   next square on that walk, and the placements are the squares `start` can be reached from. `start` is a goal
 *   here, not where the unit stands, so the stuck-unit check is skipped.
 * @returns {object} Serializable graph with legal destinations and route metadata.
 */
export function buildMovementGraph(source, {
  teleports = false, start = null, allowance = null, cellPenalties = null, attackReach = true,
  keyboardDiagonals = true, reverse = false
} = {}) {
  const input = normalizeInput(source, { start, allowance });
  const stranded = !reverse && movementStranded(source, input.start);
  if (stranded) input.allowance = 0;
  const penalties = normalizeCellPenalties(cellPenalties);
  const blocked = new Set([
    ...input.blockedCells,
    ...input.terrainOcclusionCells,
    ...input.terrainImpassableCells
  ]);
  const occupied = new Set(input.occupiedCells);
  const costs = input.terrainCosts;
  const stepKeys = new Set();
  const costByStep = {};
  const originKey = cellKey(input.start.x, input.start.y);
  const costByCell = { [originKey]: 0 };
  const routeByCell = { [originKey]: 0 };
  const parentByCell = {};
  const queue = [];
  const hops = teleports ? teleportEdges(input, blocked, occupied) : new Map();
  const padsByExit = reverse ? teleportPadsByExit(hops) : null;
  if (!stranded) pushCheapest(queue, { ...input.start, cost: 0, route: 0 });

  const relax = (currentKey, current, next, edgeCost, entered = next) => {
    const nextCost = current.cost + edgeCost;
    if (nextCost > input.allowance + EPSILON) return;
    const nextKey = cellKey(next.x, next.y);
    const nextRoute = current.route + edgeCost + footprintPenalty(penalties, entered, input.footprint);
    if (nextRoute + EPSILON >= (routeByCell[nextKey] ?? Infinity)) return;
    costByCell[nextKey] = nextCost;
    routeByCell[nextKey] = nextRoute;
    parentByCell[nextKey] = currentKey;
    pushCheapest(queue, { ...next, cost: nextCost, route: nextRoute });
  };

  while (queue.length) {
    const current = takeCheapest(queue);
    const currentKey = cellKey(current.x, current.y);
    if (current.route > routeByCell[currentKey] + EPSILON) continue;

    if (reverse) {
      for (const pad of padsByExit.get(currentKey) ?? []) {
        const edgeKey = stepKey(pad, current);
        stepKeys.add(edgeKey);
        costByStep[edgeKey] = pad.cost;
        relax(currentKey, current, pad, pad.cost, current);
      }
    } else {
      const hop = hops.get(currentKey);
      if (hop) {
        const edgeKey = stepKey(current, hop);
        stepKeys.add(edgeKey);
        costByStep[edgeKey] = hop.cost;
        relax(currentKey, current, hop, hop.cost);
      }
    }

    for (const direction of DIRECTIONS) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      if (!footprintFits(next, input, blocked)) continue;
      const from = reverse ? next : current;
      const to = reverse ? current : next;
      if (stepCrossesWall(from, to, input)) continue;
      if (!terrainStepIsAllowed(from, to, input)) continue;

      const edgeKey = stepKey(from, to);
      const edgeCost = footprintCost(to, input.footprint, costs);
      stepKeys.add(edgeKey);
      costByStep[edgeKey] = edgeCost;
      relax(currentKey, current, next, edgeCost, to);
    }
  }

  const placements = Object.keys(costByCell)
    .map(parseCellKey)
    .sort(compareCells)
    .map(cell => Object.freeze({ ...cell, cost: costByCell[cellKey(cell.x, cell.y)] }));
  const diagonalStepKeys = keyboardDiagonals ? buildDiagonalStepKeys(placements, input) : [];
  const destinations = placements.filter(cell => !footprintOverlaps(cell, input.footprint, occupied));
  const walkableTiles = new Set();
  for (const anchor of placements) {
    for (let dx = 0; dx < input.footprint.width; dx += 1) {
      for (let dy = 0; dy < input.footprint.height; dy += 1) {
        walkableTiles.add(cellKey(anchor.x + dx, anchor.y + dy));
      }
    }
  }
  const attackRange = attackReach
    ? buildCombinedAttackRange(input, placements)
    : freezeAttackRange(new Set(), new Set());

  return Object.freeze({
    columns: input.columns,
    rows: input.rows,
    start: Object.freeze({ ...input.start }),
    footprint: Object.freeze({ ...input.footprint }),
    allowance: input.allowance,
    placements: Object.freeze(placements),
    destinations: Object.freeze(destinations),
    walkableTiles: Object.freeze([...walkableTiles].map(parseCellKey).sort(compareCells).map(cell => Object.freeze(cell))),
    attackableTiles: attackRange.attackableTiles,
    flyersOnlyTiles: attackRange.flyersOnlyTiles,
    stepKeys: Object.freeze([...stepKeys].sort()),
    diagonalStepKeys: Object.freeze(diagonalStepKeys),
    costByStep: Object.freeze(costByStep),
    costByCell: Object.freeze(costByCell),
    routeByCell: Object.freeze(routeByCell),
    parentByCell: Object.freeze(parentByCell)
  });
}

/**
 * The cost and shortest legal route to a square the unit can end its move on.
 * @param {object} graph Graph returned by {@link buildMovementGraph}.
 * @param {object} destination The footprint's top-left square.
 * @returns {object|null} Resolution, or `null` when the unit cannot stop there.
 */
export function resolveMovementDestination(graph, destination) {
  return resolveRoute(graph, destination, graph.destinations);
}

/**
 * The test the graph uses for whether a footprint may stop on a square, judged on that square alone with no walk
 * to it.
 * @param {object} source The map's terrain and the unit's movement data.
 * @returns {(anchor: {x: number, y: number}, footprint: {width: number, height: number}) => boolean}
 */
export function standingLegality(source = {}) {
  const bounds = { columns: positiveInteger(source.columns), rows: positiveInteger(source.rows) };
  const blocked = new Set([
    ...normalizeCellKeys(source.blockedCells ?? []),
    ...(source.airborne === true ? [] : normalizeCellKeys(source.terrainOcclusionCells ?? [])),
    ...normalizeCellKeys(source.terrainImpassableCells ?? [])
  ]);
  const occupied = new Set(normalizeCellKeys(source.occupiedCells ?? []));
  return (anchor, footprint) => {
    const size = { width: positiveInteger(footprint?.width) || 1, height: positiveInteger(footprint?.height) || 1 };
    return footprintFits(anchor, { ...bounds, footprint: size }, blocked) && !footprintOverlaps(anchor, size, occupied);
  };
}

/** Where a unit is standing now: the destination its own current square resolves to. */
export function resolveStandingDestination(movement) {
  return resolveMovementDestination(
    buildMovementGraph(movement, { attackReach: false, keyboardDiagonals: false }),
    movement.current
  );
}

/** Where a unit stands once its effects have run: the leg it walked, ending wherever they set it down. */
export function resolveSettledStanding(walked, movement) {
  if (!walked) return null;
  const current = normalizePoint(movement?.current);
  if (current.x === walked.destination.x && current.y === walked.destination.y) return walked;
  return Object.freeze({
    destination: Object.freeze(current),
    cost: walked.cost,
    path: Object.freeze([...walked.path, Object.freeze(current)]),
    displaced: true
  });
}

/**
 * Resolve a movement UI preview, including friendly-occupied cells that cannot be committed as destinations.
 * @param {object} graph Graph returned by {@link buildMovementGraph}.
 * @param {object} destination The footprint's top-left square.
 * @returns {object|null} Preview resolution, or `null` outside the movement graph.
 */
export function resolveMovementPreview(graph, destination) {
  return resolveRoute(graph, destination, graph.placements);
}

/**
 * Route a movement preview from where the token is being dragged. `cost` is still counted from the square the move
 * started on, and `routeCost` measures only this route.
 */
export function resolveMovementPreviewFrom(graph, start, destination) {
  const origin = normalizePoint(start);
  const target = normalizePoint(destination);
  const originKey = cellKey(origin.x, origin.y);
  const targetKey = cellKey(target.x, target.y);
  const legalKeys = cellKeySet(graph?.placements ?? []);
  if (!legalKeys.has(originKey) || !legalKeys.has(targetKey)) return null;
  const legalSteps = stepKeySet(graph?.stepKeys);

  const queue = [];
  pushCheapest(queue, { ...origin, cost: 0, route: 0 });
  const routeCostByCell = { [originKey]: 0 };
  const parentByCell = { [originKey]: '' };
  while (queue.length) {
    const current = takeCheapest(queue);
    const currentKey = cellKey(current.x, current.y);
    if (current.cost > routeCostByCell[currentKey] + EPSILON) continue;
    if (currentKey === targetKey) break;
    for (const direction of DIRECTIONS) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      const nextKey = cellKey(next.x, next.y);
      if (!legalKeys.has(nextKey)) continue;
      // A whole square and one cardinal step, so the edge key is built once with no point normalising.
      const edgeKey = stepKey(current, next);
      if (!legalSteps.has(edgeKey)) continue;
      const nextCost = current.cost + finiteNonNegative(graph.costByStep?.[edgeKey], 1);
      if (nextCost + EPSILON >= (routeCostByCell[nextKey] ?? Infinity)) continue;
      routeCostByCell[nextKey] = nextCost;
      parentByCell[nextKey] = currentKey;
      pushCheapest(queue, { ...next, cost: nextCost, route: nextCost });
    }
  }
  if (!Object.hasOwn(parentByCell, targetKey)) return null;

  const path = [];
  let cursor = targetKey;
  while (cursor) {
    path.push(parseCellKey(cursor));
    cursor = parentByCell[cursor] ?? '';
  }
  path.reverse();
  return Object.freeze({
    destination: Object.freeze(target),
    cost: graph.costByCell[targetKey],
    routeCost: routeCostByCell[targetKey],
    path: Object.freeze(path.map(cell => Object.freeze(cell)))
  });
}

/** Whether a legal step leads from one square to the adjacent one, in that direction. */
function canTraverseMovementStep(graph, from, to) {
  const start = normalizePoint(from);
  const destination = normalizePoint(to);
  if (Math.abs(start.x - destination.x) + Math.abs(start.y - destination.y) !== 1) return false;
  return stepKeySet(graph?.stepKeys).has(stepKey(start, destination));
}

/** Whether one keyboard translation may enter a cardinal neighbor or displayed diagonal destination. */
export function canTraverseMovementTranslation(graph, from, to) {
  const start = normalizePoint(from);
  const destination = normalizePoint(to);
  const deltaX = Math.abs(start.x - destination.x);
  const deltaY = Math.abs(start.y - destination.y);
  if (deltaX + deltaY === 1) return canTraverseMovementStep(graph, start, destination);
  if (deltaX !== 1 || deltaY !== 1) return false;
  return stepKeySet(graph?.diagonalStepKeys).has(stepKey(start, destination));
}

/** Whether every adjacent edge in a proposed preview path is legal. */
export function movementPathIsTraversable(graph, path) {
  if (!Array.isArray(path) || path.length < 1) return false;
  for (let index = 1; index < path.length; index += 1) {
    if (!canTraverseMovementStep(graph, path[index - 1], path[index])) return false;
  }
  return true;
}

function resolveRoute(graph, destination, legalCells) {
  const point = normalizePoint(destination);
  const key = cellKey(point.x, point.y);
  if (!cellKeySet(legalCells).has(key)) return null;

  const path = [];
  let cursor = key;
  while (cursor) {
    path.push(parseCellKey(cursor));
    cursor = graph.parentByCell[cursor] ?? '';
  }
  path.reverse();
  if (path[0]?.x !== graph.start.x || path[0]?.y !== graph.start.y) return null;
  return Object.freeze({
    destination: Object.freeze(point),
    cost: graph.costByCell[key],
    path: Object.freeze(path.map(cell => Object.freeze(cell)))
  });
}

/** Return the unspent movement available to a unit. */
export function remainingMovement(total, spent) {
  return Math.max(0, finiteNumber(total) - Math.max(0, finiteNumber(spent)));
}

/** The reach a unit's graph is built to: zero while it plans a move with no movement left, its allowance otherwise. */
function movementReach(source = {}) {
  if (source.allowance === Infinity) return Infinity;
  if (source.movementPlanning === true && source.movementAvailable === false && source.exploring !== true) return 0;
  return Math.max(0, finiteNumber(source.allowance));
}

/* -------------------------------------------- */
/*  Teleport edges                              */
/* -------------------------------------------- */
/**
 * Tell threat and planning prefilters whether distance bounds movement cost.
 * Free cells and paired movement-priced teleports break that bound, so distant units cannot be pruned safely.
 * @param {object} source The map's terrain.
 * @returns {boolean}
 */
export function terrainBoundsTravelByDistance(source = {}) {
  return travelShortcuts(source)?.length === 0;
}

/**
 * The teleports that cost movement, which a distance prefilter must count as shortcuts. Null when the map has free
 * cells, since then distance limits nothing.
 * @param {object} source The map's own terrain, not one unit's view of it: `terrainCosts` and `terrainTeleports`.
 * @returns {ReadonlyArray<{x: number, y: number, exit: {x: number, y: number}, cost: number}>|null}
 */
export function travelShortcuts(source = {}) {
  if (Object.values(source.terrainCosts ?? {}).some(cost => Number(cost) === 0)) return null;
  return Object.freeze((source.terrainTeleports ?? [])
    .filter(pad => pad?.exit && pad.cost === TELEPORT_COSTS.MOVEMENT)
    .map(pad => Object.freeze({
      x: pad.x,
      y: pad.y,
      exit: Object.freeze({ x: pad.exit.x, y: pad.exit.y }),
      cost: Math.max(0, Number(pad.movementCost) || 0)
    })));
}

/**
 * The least movement one footprint could need to reach another, using the shortcuts from {@link travelShortcuts}.
 * Walking costs at least the number of squares between them. A shortcut costs its price and moves the footprint's
 * top-left square from pad to exit. Shortcuts work both ways, so the distance is the same in either direction.
 * @param {{x: number, y: number, width?: number, height?: number}} from The footprint that travels.
 * @param {{x: number, y: number, width?: number, height?: number}} to The footprint it must reach.
 * @param {ReadonlyArray<object>} [shortcuts]
 * @returns {number}
 */
export function shortcutTravelDistance(from, to, shortcuts = []) {
  const size = { width: from.width ?? 1, height: from.height ?? 1 };
  const target = { x: to.x, y: to.y, width: to.width ?? 1, height: to.height ?? 1 };
  const origin = { x: from.x, y: from.y, ...size };
  const ends = shortcuts.flatMap(pad => [
    { at: pad, other: pad.exit, cost: pad.cost },
    { at: pad.exit, other: pad, cost: pad.cost }
  ]);
  const cell = point => ({ x: point.x, y: point.y, width: 1, height: 1 });
  let best = rectDistance(origin, target);
  const reached = ends.map(end => rectDistance(origin, cell(end.at)));
  const settled = ends.map(() => false);
  for (;;) {
    let next = -1;
    for (let i = 0; i < ends.length; i += 1) {
      if (!settled[i] && (next < 0 || reached[i] < reached[next])) next = i;
    }
    if (next < 0 || reached[next] >= best) return best;
    settled[next] = true;
    const landed = { x: ends[next].other.x, y: ends[next].other.y, ...size };
    const arrival = reached[next] + ends[next].cost;
    best = Math.min(best, arrival + rectDistance(landed, target));
    for (let i = 0; i < ends.length; i += 1) {
      if (!settled[i]) reached[i] = Math.min(reached[i], arrival + rectDistance(landed, cell(ends[i].at)));
    }
  }
}

/**
 * Build teleport edges for buildMovementGraph. Pads that cost an action or a bonus action are left out, since only
 * the teleport command can charge those. Pads barred to this unit stay walkable but give no edge.
 */
function teleportEdges(input, blocked, occupied) {
  const edges = new Map();
  for (const pad of input.terrainTeleports) {
    if (!pad.exit || pad.cost !== TELEPORT_COSTS.MOVEMENT || pad.restricted) continue;
    if (!teleportLandingOk(pad.exit, input, blocked, occupied)) continue;
    edges.set(cellKey(pad.x, pad.y), { x: pad.exit.x, y: pad.exit.y, cost: pad.movementCost });
  }
  return edges;
}

/** Turn teleportEdges round for a reverse search: every pad that lands on a square, by that square's key. */
function teleportPadsByExit(edges) {
  const pads = new Map();
  for (const [padKey, exit] of edges) {
    const exitKey = cellKey(exit.x, exit.y);
    const pad = { ...parseCellKey(padKey), cost: exit.cost };
    const listed = pads.get(exitKey);
    if (listed) listed.push(pad);
    else pads.set(exitKey, [pad]);
  }
  return pads;
}

/**
 * Whether a pad's exit can hold the unit, judged by standing rules rather than a walked step: walls and height
 * changes on the way are ignored, but a walker needs level floor under the whole footprint. Any unit on the exit,
 * ally or not, drops the edge. The teleport command is looser: unless the pad is blockable, it moves the arrival to
 * the nearest clear square, so the graph can miss a hop the command would allow.
 */
function teleportLandingOk(anchor, input, blocked, occupied) {
  let floor = null;
  for (let dx = 0; dx < input.footprint.width; dx += 1) {
    for (let dy = 0; dy < input.footprint.height; dy += 1) {
      const x = anchor.x + dx;
      const y = anchor.y + dy;
      if (x < 0 || y < 0 || x >= input.columns || y >= input.rows) return false;
      const key = cellKey(x, y);
      if (blocked.has(key) || occupied.has(key)) return false;
      if (input.airborne) continue;
      const elevation = finiteNumber(input.terrainElevations[key]);
      if (floor === null) floor = elevation;
      else if (elevation !== floor) return false;
    }
  }
  return true;
}

/* -------------------------------------------- */
/*  Combined attack reach                       */
/* -------------------------------------------- */
function buildCombinedAttackRange(input, placements) {
  const attackable = new Set();
  const flyersOnly = new Set();
  const clear = new Set();
  if (!input.attackRanges.length) return freezeAttackRange(attackable, flyersOnly);

  const hasElevation = Object.keys(input.terrainElevations).length > 0;
  const meleeOnly = !input.airborne && input.attackRanges.every(range => range.maxRange <= 1);
  const rack = input.armamentCells;
  for (const placement of placements) {
    const onRack = rack.size > 0 && footprintOverlaps(placement, input.footprint, rack);
    const fromPlacement = new Set();
    const overHeight = new Set();
    for (const range of input.attackRanges) {
      if (range.emplaced && rack.size > 0 && !onRack) continue;
      const tiles = input.freeTargeting || range.seesOverHeight ? overHeight : fromPlacement;
      for (const key of calculateAttackTilesFromPosition(
        placement.x,
        placement.y,
        range,
        input.columns,
        input.rows,
        input.footprint
      )) tiles.add(key);
    }

    if (!hasElevation) {
      for (const key of fromPlacement) attackable.add(key);
      for (const key of overHeight) attackable.add(key);
      continue;
    }
    if (meleeOnly) {
      filterMeleeElevation(fromPlacement, placement, input.terrainElevations);
      filterMeleeElevation(overHeight, placement, input.terrainElevations);
    }
    for (const key of overHeight) {
      attackable.add(key);
      clear.add(key);
      flyersOnly.delete(key);
    }
    const obscured = input.airborne
      ? new Set()
      : heightObscuredCells(fromPlacement, placement, input.footprint, input.terrainElevations);
    for (const key of fromPlacement) {
      if (overHeight.has(key)) continue;
      attackable.add(key);
      if (obscured.has(key)) {
        if (!clear.has(key)) flyersOnly.add(key);
      } else {
        clear.add(key);
        flyersOnly.delete(key);
      }
    }
  }
  return freezeAttackRange(attackable, flyersOnly);
}

function filterMeleeElevation(tiles, placement, elevations) {
  const sourceElevation = terrainElevationAt(elevations, placement.x, placement.y);
  for (const key of [...tiles]) {
    const target = parseCellKey(key);
    if (Math.abs(sourceElevation - terrainElevationAt(elevations, target.x, target.y)) > MELEE_ELEVATION_REACH) {
      tiles.delete(key);
    }
  }
}

/**
 * The attack tiles hidden by higher ground from a placement, judged from the footprint square nearest each tile.
 * It runs for every placement the threat overlay draws, so keep it free of per-tile allocations.
 */
function heightObscuredCells(tiles, placement, footprint, elevations) {
  const sourceCells = [];
  for (let dx = 0; dx < footprint.width; dx += 1) {
    for (let dy = 0; dy < footprint.height; dy += 1) {
      sourceCells.push({ x: placement.x + dx, y: placement.y + dy });
    }
  }
  const sourceKeys = new Set(sourceCells.map(cell => cellKey(cell.x, cell.y)));
  const obscured = new Set();
  for (const key of tiles) {
    if (sourceKeys.has(key)) continue;
    const target = parseCellKey(key);
    const nearest = nearestCell(sourceCells, target);
    if (terrainHeightOccludes(nearest.x, nearest.y, target.x, target.y, elevations)) obscured.add(key);
  }
  return obscured;
}

/** The cell with the fewest grid steps to the target, the earliest listed on a tie. */
function nearestCell(cells, target) {
  let nearest = cells[0];
  let fewest = Infinity;
  for (const cell of cells) {
    const distance = Math.abs(target.x - cell.x) + Math.abs(target.y - cell.y);
    if (distance < fewest) {
      nearest = cell;
      fewest = distance;
    }
  }
  return nearest;
}

function freezeAttackRange(attackable, flyersOnly) {
  const freezeCells = keys => Object.freeze([...keys]
    .map(parseCellKey)
    .sort(compareCells)
    .map(cell => Object.freeze(cell)));
  return Object.freeze({
    attackableTiles: freezeCells(attackable),
    flyersOnlyTiles: freezeCells(flyersOnly)
  });
}

/* -------------------------------------------- */
/*  Hostile hints                               */
/* -------------------------------------------- */
/**
 * The movement overlay's marks on hostile units: danger where a hostile's weapon is effective against this unit,
 * and stealable goods when this unit has Steal. Friendly units get no mark.
 * @param {object} source The unit's movement data, with `factionRole` and `hints`.
 * @returns {object[]} One `{tokenId, x, y, width, effective, stealable}` per marked hostile.
 */
export function planMovementHints(source = {}) {
  const facts = source.hints ?? {};
  const ownTypes = new Set(Array.isArray(facts.unitTypes) ? facts.unitTypes : []);
  const marks = [];
  for (const unit of Array.isArray(facts.units) ? facts.units : []) {
    if (areFactionsFriendly(source.factionRole, unit?.factionRole)) continue;
    const effective = ownTypes.size > 0
      && (Array.isArray(unit.effectiveAgainst) ? unit.effectiveAgainst : []).some(type => ownTypes.has(type));
    const stealable = facts.hasStealAbility === true && unit.hasStealables === true;
    if (!effective && !stealable) continue;
    marks.push({
      tokenId: String(unit.tokenId ?? ''),
      x: Math.floor(finiteNumber(unit.x)),
      y: Math.floor(finiteNumber(unit.y)),
      width: Math.max(1, Math.floor(finiteNumber(unit.width, 1))),
      effective,
      stealable
    });
  }
  return marks;
}

/* -------------------------------------------- */
/*  Unit policy helpers                         */
/* -------------------------------------------- */
function unitOccupiesLanding(unit) {
  if (!unit) return true;
  if (fixtureHiddenFromMovement({ documentType: unit.actorType, objectType: unit.objectType, hidden: unit.hidden })) {
    return false;
  }
  if (unit.actorType === 'Convoy') return false;
  if (unit.actorType !== 'Object') return true;
  if (OBJECT_FIXTURE_TYPES.includes(unit.objectType)) return false;
  if (unit.objectType === 'Door' && unit.locked === false) return false;
  return !(unit.objectType === 'Destructible' && Number(unit.stance) <= 0);
}

/* -------------------------------------------- */
/*  Search rules                                */
/* -------------------------------------------- */
function footprintFits(anchor, input, blocked) {
  for (let dx = 0; dx < input.footprint.width; dx += 1) {
    for (let dy = 0; dy < input.footprint.height; dy += 1) {
      const x = anchor.x + dx;
      const y = anchor.y + dy;
      if (x < 0 || y < 0 || x >= input.columns || y >= input.rows) return false;
      if (blocked.has(cellKey(x, y))) return false;
    }
  }
  return true;
}

function footprintOverlaps(anchor, footprint, occupied) {
  for (let dx = 0; dx < footprint.width; dx += 1) {
    for (let dy = 0; dy < footprint.height; dy += 1) {
      if (occupied.has(cellKey(anchor.x + dx, anchor.y + dy))) return true;
    }
  }
  return false;
}

function footprintCost(anchor, footprint, costs) {
  let cost = 0;
  for (let dx = 0; dx < footprint.width; dx += 1) {
    for (let dy = 0; dy < footprint.height; dy += 1) {
      const key = cellKey(anchor.x + dx, anchor.y + dy);
      const authored = Object.hasOwn(costs, key) ? finiteNonNegative(costs[key], 1) : 1;
      cost = Math.max(cost, authored);
    }
  }
  return cost;
}

/** Keep only the surcharges that mean something: a positive, finite number against a cell key. */
function normalizeCellPenalties(penalties) {
  if (!penalties || typeof penalties !== 'object') return null;
  const normalized = {};
  for (const [key, value] of Object.entries(penalties)) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) normalized[key] = amount;
  }
  return Object.keys(normalized).length ? normalized : null;
}

/** What entering a square costs a route on top of its movement: the worst surcharge under the footprint. */
function footprintPenalty(penalties, anchor, footprint) {
  if (!penalties) return 0;
  let worst = 0;
  for (let dx = 0; dx < footprint.width; dx += 1) {
    for (let dy = 0; dy < footprint.height; dy += 1) {
      worst = Math.max(worst, penalties[cellKey(anchor.x + dx, anchor.y + dy)] ?? 0);
    }
  }
  return worst;
}

/* -------------------------------------------- */
/*  Elevation crossings                         */
/* -------------------------------------------- */

/**
 * Validate a crossing landing before the movement UI offers a check. Require clear terrain,
 * a free footprint and an unobstructed center-to-center segment. Passing through allies does not allow landing on
 * them.
 * @param {object} landing The prepared landing data from {@link crossingLandingFacts}.
 * @param {{x: number, y: number}} from The square being left.
 * @param {{x: number, y: number}} to The square aimed at.
 * @param {object} [options] `ignoreWalls` lets a step authored to pass through walls land past one.
 * @returns {boolean}
 */
function crossingLandingIsLegal(landing, from, to, { ignoreWalls = false } = {}) {
  const { input, blocked, occupied } = landing;
  if (!footprintFits(to, input, blocked)) return false;
  if (footprintOverlaps(to, input.footprint, occupied)) return false;
  return ignoreWalls || !stepCrossesWall(from, to, input);
}

/** What crossingLandingIsLegal reads, built once so callers testing many landings don't redo the setup. */
function crossingLandingFacts(source, input = normalizeInput(source)) {
  return {
    input,
    blocked: new Set([...input.blockedCells, ...input.terrainOcclusionCells, ...input.terrainImpassableCells]),
    occupied: new Set(input.occupiedCells)
  };
}

/**
 * Classify a forced move for Shove and Retrieve activation checks.
 * Level ground is a step, descent requires crossing resolution and ascent is refused.
 * Airborne units ignore floor transitions but still need a valid destination.
 * @param {object} source Movement data of the unit being moved, with occupied squares worked out for that unit.
 * @param {{x: number, y: number}} from The square being left.
 * @param {{x: number, y: number}} to The square it is being sent to.
 * @param {object} [options] `ignoreWalls` for a step authored to pass through walls.
 * @returns {Readonly<{outcome: string, crossing: object|null}>} The crossing to roll, on a descent.
 */
export function resolveForcedStep(source, from, to, { ignoreWalls = false } = {}) {
  const input = normalizeInput(source);
  const landing = landingOutcome(source, input, from, to, ignoreWalls);
  if (landing !== FORCED_STEP_OUTCOMES.WALK) return forcedStep(landing);
  const fromElevation = finiteNumber(input.terrainElevations[cellKey(from.x, from.y)]);
  const toElevation = finiteNumber(input.terrainElevations[cellKey(to.x, to.y)]);
  if (input.airborne || fromElevation === toElevation) return forcedStep(FORCED_STEP_OUTCOMES.WALK);
  if (toElevation > fromElevation) return forcedStep(FORCED_STEP_OUTCOMES.ASCENT);
  const crossing = crossingCandidates(source, from, to)
    .find(option => option.to.x === to.x && option.to.y === to.y);
  return crossing ? forcedStep(FORCED_STEP_OUTCOMES.DESCENT, crossing) : forcedStep(FORCED_STEP_OUTCOMES.BLOCKED);
}

/**
 * Whether a unit sent straight from one square to another, ignoring height, may land there: OCCUPIED when another
 * token takes the landing, BLOCKED when it is off the map, on a blocked square, or past a wall on the straight line,
 * otherwise WALK. Effect teleports and swaps use this, since they do not walk or climb.
 * @param {object} source Movement data of the unit being moved, with occupied squares worked out for that unit.
 * @param {{x: number, y: number}} from The square being left.
 * @param {{x: number, y: number}} to The square it is being sent to.
 * @param {object} [options] `ignoreWalls` for a move authored to pass through walls.
 * @returns {string} A FORCED_STEP_OUTCOMES value.
 */
export function resolveLanding(source, from, to, { ignoreWalls = false } = {}) {
  return landingOutcome(source, normalizeInput(source), from, to, ignoreWalls);
}

function landingOutcome(source, input, from, to, ignoreWalls) {
  if (footprintOverlaps(to, input.footprint, new Set(input.occupiedCells))) return FORCED_STEP_OUTCOMES.OCCUPIED;
  if (!crossingLandingIsLegal(crossingLandingFacts(source, input), from, to, { ignoreWalls })) {
    return FORCED_STEP_OUTCOMES.BLOCKED;
  }
  return FORCED_STEP_OUTCOMES.WALK;
}

function forcedStep(outcome, crossing = null) {
  return Object.freeze({ outcome, crossing });
}

/**
 * The crossings a step from one square to the next can attempt. Stepping onto a bridge square (an obstacle or
 * impassable square with crossing directions authored) follows the bridge to its possible landings, and the player
 * picks one when the bridge branches.
 * @param {object} source The unit's movement data, with the map's crossing data (`terrainCrossings`).
 * @param {{x: number, y: number}} from The square being left.
 * @param {{x: number, y: number}} to The square aimed at.
 * @returns {readonly object[]} One entry per landing the attempt could reach.
 */
export function crossingCandidates(source, from, to) {
  const board = source?.terrainCrossings ?? {};
  const direction = crossingStepDirection(from, to);
  const leaps = direction ? crossingBridgeLandings(board, from, direction) : [];
  const squares = leaps.length ? leaps : [{ x: to.x, y: to.y, approach: null }];
  const options = [];
  let landing = null;
  for (const square of squares) {
    const crossing = evaluateCrossing(board, from, square);
    if (!crossing) continue;
    landing ??= crossingLandingFacts(source);
    if (!crossingLandingIsLegal(landing, from, square)) continue;
    options.push(Object.freeze({ ...crossing, approach: square.approach ?? crossing.direction }));
  }
  return Object.freeze(options);
}

/**
 * The crossing arrows to show from the squares a unit can reach. Squares it can walk to are skipped, and where one
 * step in one direction leads to several bridge exits the landing with the best odds wins.
 * @param {object} source The unit's movement data, with the map's crossing data and the unit's skills.
 * @param {object} graph Graph returned by {@link buildMovementGraph}.
 * @returns {readonly object[]} One entry per reachable crossing, carrying its skill, odds and odds band.
 */
export function collectCrossingOptions(source, graph) {
  const board = source?.terrainCrossings ?? {};
  const reachable = new Set(graph.walkableTiles.map(cell => cellKey(cell.x, cell.y)));
  const footprint = graph.footprint;
  const walkable = target => {
    for (let dx = 0; dx < footprint.width; dx += 1) {
      for (let dy = 0; dy < footprint.height; dy += 1) {
        if (!reachable.has(cellKey(target.x + dx, target.y + dy))) return false;
      }
    }
    return true;
  };
  const options = new Map();
  let landing = null;
  for (const anchor of graph.placements) {
    if (graph.allowance - graph.costByCell[cellKey(anchor.x, anchor.y)] < 1) continue;
    for (const target of crossingTargets(board, anchor)) {
      if (walkable(target)) continue;
      const crossing = evaluateCrossing(board, anchor, target);
      if (!crossing) continue;
      landing ??= crossingLandingFacts(source);
      if (!crossingLandingIsLegal(landing, anchor, target)) continue;
      const odds = resolveCrossingCheck(crossing, source);
      const option = Object.freeze({
        ...crossing, skillKey: odds.skillKey, chance: odds.chance, band: successChanceBand(odds.chance)
      });
      const key = `${cellKey(anchor.x, anchor.y)}:${crossing.direction}`;
      const standing = options.get(key);
      if (!standing || option.chance > standing.chance) options.set(key, option);
    }
  }
  return Object.freeze([...options.values()]);
}

/**
 * Whether a step crosses a wall, tested on each footprint square's centre-to-centre line, along its whole length.
 * A wall running between two rows or columns inside a large footprint is never tested.
 */
function stepCrossesWall(from, to, input) {
  if (input.wallsByCell.size === 0) return false;
  const buckets = isOneSquareStep(from, to) ? input.wallsByCell : wallsByBox(input.wallIndex);
  for (let dx = 0; dx < input.footprint.width; dx += 1) {
    for (let dy = 0; dy < input.footprint.height; dy += 1) {
      const movement = {
        x1: from.x + dx + 0.5,
        y1: from.y + dy + 0.5,
        x2: to.x + dx + 0.5,
        y2: to.y + dy + 0.5
      };
      const near = buckets === input.wallsByCell
        ? wallsNearStep(buckets, from.x + dx, from.y + dy, to.x + dx, to.y + dy)
        : wallsAlongStep(buckets, from.x + dx, from.y + dy, to.x + dx, to.y + dy);
      for (const wall of near) {
        if (segmentsIntersect(movement, wall)) return true;
      }
    }
  }
  return false;
}

/** The walls that could cross a step, drawn from the buckets of its two cells. */
function wallsNearStep(buckets, fromX, fromY, toX, toY) {
  const near = buckets.get(cellKey(fromX, fromY)) ?? [];
  const beyond = buckets.get(cellKey(toX, toY)) ?? [];
  if (near.length === 0) return beyond;
  if (beyond.length === 0) return near;
  return new Set([...near, ...beyond]);
}

/**
 * The walls that could cross a step longer than one square, drawn from the wallsByBox bucket of every square in the
 * box the step spans. A wall can only cross the line if its widened box shares one of those squares.
 */
function wallsAlongStep(buckets, fromX, fromY, toX, toY) {
  const near = new Set();
  const minX = Math.floor(Math.min(fromX, toX));
  const maxX = Math.floor(Math.max(fromX, toX));
  const minY = Math.floor(Math.min(fromY, toY));
  const maxY = Math.floor(Math.max(fromY, toY));
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      for (const wall of buckets.get(cellKey(x, y)) ?? []) near.add(wall);
    }
  }
  return near;
}

/**
 * Diagonal keyboard steps between two squares the unit can already reach, on level ground unless it flies. Walls
 * at the corner are not tested; the destination still costs what the 4-way search found.
 */
function buildDiagonalStepKeys(placements, input) {
  const placementKeys = new Set(placements.map(cell => cellKey(cell.x, cell.y)));
  const diagonalSteps = [];
  for (const from of placements) {
    for (const direction of DIAGONAL_DIRECTIONS) {
      const to = { x: from.x + direction.x, y: from.y + direction.y };
      if (!placementKeys.has(cellKey(to.x, to.y))) continue;
      if (!directKeyboardElevationIsAllowed(from, to, input)) continue;
      diagonalSteps.push(stepKey(from, to));
    }
  }
  return diagonalSteps.sort();
}

function directKeyboardElevationIsAllowed(from, to, input) {
  if (input.airborne) return true;
  const fromElevation = finiteNumber(input.terrainElevations[cellKey(from.x, from.y)]);
  const toElevation = finiteNumber(input.terrainElevations[cellKey(to.x, to.y)]);
  return fromElevation === toElevation;
}

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */
function segmentsIntersect(left, right) {
  const o1 = orientation(left.x1, left.y1, left.x2, left.y2, right.x1, right.y1);
  const o2 = orientation(left.x1, left.y1, left.x2, left.y2, right.x2, right.y2);
  const o3 = orientation(right.x1, right.y1, right.x2, right.y2, left.x1, left.y1);
  const o4 = orientation(right.x1, right.y1, right.x2, right.y2, left.x2, left.y2);
  if (opposite(o1, o2) && opposite(o3, o4)) return true;
  if (Math.abs(o1) <= EPSILON && onSegment(left.x1, left.y1, left.x2, left.y2, right.x1, right.y1)) return true;
  if (Math.abs(o2) <= EPSILON && onSegment(left.x1, left.y1, left.x2, left.y2, right.x2, right.y2)) return true;
  if (Math.abs(o3) <= EPSILON && onSegment(right.x1, right.y1, right.x2, right.y2, left.x1, left.y1)) return true;
  return Math.abs(o4) <= EPSILON && onSegment(right.x1, right.y1, right.x2, right.y2, left.x2, left.y2);
}

function orientation(ax, ay, bx, by, cx, cy) {
  return ((bx - ax) * (cy - ay)) - ((by - ay) * (cx - ax));
}

function opposite(left, right) {
  return (left > EPSILON && right < -EPSILON) || (left < -EPSILON && right > EPSILON);
}

function onSegment(ax, ay, bx, by, px, py) {
  return px >= Math.min(ax, bx) - EPSILON && px <= Math.max(ax, bx) + EPSILON
    && py >= Math.min(ay, by) - EPSILON && py <= Math.max(ay, by) + EPSILON;
}

/* -------------------------------------------- */
/*  Input normalization                         */
/* -------------------------------------------- */
/**
 * The search input with defaults filled in. A unit in the air ignores walls, obstacles and terrain movement costs;
 * impassable squares still stop it.
 */
function normalizeInput(source = {}, { start: startOverride = null, allowance = null } = {}) {
  const columns = positiveInteger(source.columns);
  const rows = positiveInteger(source.rows);
  if (!columns || !rows) throw new TypeError('Movement grid dimensions must be positive integers.');
  const start = normalizePoint(startOverride ?? source.start);
  const footprint = {
    width: positiveInteger(source.footprint?.width) || 1,
    height: positiveInteger(source.footprint?.height) || 1
  };
  const wallIndex = source.airborne ? NO_WALLS : indexedWalls(source.walls ?? []);
  return {
    columns,
    rows,
    start,
    footprint,
    allowance: overriddenReach(allowance) ?? movementReach(source),
    blockedCells: normalizeCellKeys(source.blockedCells),
    occupiedCells: normalizeCellKeys(source.occupiedCells),
    airborne: source.airborne === true,
    terrainOcclusionCells: source.airborne ? [] : normalizeCellKeys(source.terrainOcclusionCells),
    terrainImpassableCells: normalizeCellKeys(source.terrainImpassableCells),
    terrainCosts: source.airborne ? NO_TERRAIN : (source.terrainCosts ?? NO_TERRAIN),
    terrainElevations: source.terrainElevations ?? NO_TERRAIN,
    terrainTransitionDirections: source.terrainTransitionDirections ?? NO_TERRAIN,
    terrainRestrictedTransitionCells: new Set(normalizeCellKeys(source.terrainRestrictedTransitionCells)),
    terrainTeleports: Array.isArray(source.terrainTeleports) ? source.terrainTeleports : [],
    armamentCells: new Set(normalizeCellKeys(source.armamentCells)),
    walls: wallIndex.walls,
    wallsByCell: wallIndex.wallsByCell,
    wallIndex,
    attackRanges: normalizeAttackRanges(source.attackRanges),
    freeTargeting: source.freeTargeting === true
  };
}

/** Read-only stand-in for a missing terrain map. The search only reads these maps, so the source's are used as is. */
const NO_TERRAIN = Object.freeze({});
const NO_WALLS = Object.freeze({ walls: Object.freeze([]), wallsByCell: new Map(), byBox: null });

/**
 * The wall index of each walls array the movement projection hands out. Only frozen arrays of frozen walls are kept,
 * because a kept index must not outlive a change to its walls.
 */
const WALL_INDEXES = new WeakMap();

/** A source's usable walls with their square index, built once per frozen walls array. */
function indexedWalls(sourceWalls) {
  const cacheable = Array.isArray(sourceWalls) && Object.isFrozen(sourceWalls) && sourceWalls.every(Object.isFrozen);
  const kept = cacheable ? WALL_INDEXES.get(sourceWalls) : null;
  if (kept) return kept;
  const walls = sourceWalls.map(normalizeWall).filter(Boolean);
  const index = { walls, wallsByCell: indexWallsByCell(walls), byBox: null };
  if (cacheable) WALL_INDEXES.set(sourceWalls, index);
  return index;
}

/** Whether a step stays put or moves to one of the eight neighbouring squares, the steps wallsByCell covers. */
function isOneSquareStep(from, to) {
  const integers = [from.x, from.y, to.x, to.y].every(Number.isInteger);
  return integers && Math.abs(to.x - from.x) <= 1 && Math.abs(to.y - from.y) <= 1;
}

/**
 * Index walls for wallsNearStep: each wall goes in every square it passes through or touches, and in the squares
 * around those. A one-square step's centre-to-centre line stays inside its two squares, so a wall that meets it
 * lies within half a square of one of them and is in that square's bucket.
 */
function indexWallsByCell(walls) {
  const index = new Map();
  for (const wall of walls) {
    for (const key of wallCellKeys(wall)) {
      const bucket = index.get(key);
      if (bucket) bucket.push(wall);
      else index.set(key, [wall]);
    }
  }
  return index;
}

/** How far a wall is widened before its squares are read, so rounding never drops a square it touches. */
const WALL_CELL_SLACK = 0.000001;

/** The keys of the squares a wall passes through or touches, plus one square on every side of each. */
function wallCellKeys(wall) {
  const keys = new Set();
  const minX = Math.min(wall.x1, wall.x2);
  const maxX = Math.max(wall.x1, wall.x2);
  const lastColumn = Math.floor(maxX + WALL_CELL_SLACK);
  for (let column = Math.floor(minX - WALL_CELL_SLACK); column <= lastColumn; column += 1) {
    const [low, high] = wallRowSpan(wall, column, minX, maxX);
    const firstRow = Math.floor(low - WALL_CELL_SLACK) - 1;
    const lastRow = Math.floor(high + WALL_CELL_SLACK) + 1;
    for (let x = column - 1; x <= column + 1; x += 1) {
      for (let y = firstRow; y <= lastRow; y += 1) keys.add(cellKey(x, y));
    }
  }
  return keys;
}

/** The lowest and highest y a wall reaches inside one column of squares, or at its nearer end if it stops short. */
function wallRowSpan(wall, column, minX, maxX) {
  if (wall.x1 === wall.x2) return [Math.min(wall.y1, wall.y2), Math.max(wall.y1, wall.y2)];
  const left = Math.min(Math.max(column, minX), maxX);
  const right = Math.max(Math.min(column + 1, maxX), left);
  const slope = (wall.y2 - wall.y1) / (wall.x2 - wall.x1);
  const atLeft = wall.y1 + ((left - wall.x1) * slope);
  const atRight = wall.y1 + ((right - wall.x1) * slope);
  return [Math.min(atLeft, atRight), Math.max(atLeft, atRight)];
}

/**
 * Walls bucketed over their bounding box widened by one square, for a step longer than one square (a push of several
 * squares or a bridge landing). Built the first time such a step is tested and kept with the walls.
 */
function wallsByBox(wallIndex) {
  if (wallIndex.byBox) return wallIndex.byBox;
  const index = new Map();
  for (const wall of wallIndex.walls) {
    const minX = Math.floor(Math.min(wall.x1, wall.x2)) - 1;
    const maxX = Math.floor(Math.max(wall.x1, wall.x2)) + 1;
    const minY = Math.floor(Math.min(wall.y1, wall.y2)) - 1;
    const maxY = Math.floor(Math.max(wall.y1, wall.y2)) + 1;
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = cellKey(x, y);
        const bucket = index.get(key);
        if (bucket) bucket.push(wall);
        else index.set(key, [wall]);
      }
    }
  }
  wallIndex.byBox = index;
  return index;
}

function normalizeAttackRanges(ranges) {
  if (!Array.isArray(ranges)) return [];
  const normalized = [];
  for (const range of ranges) {
    const minRange = Number(range?.minRange);
    const maxRange = Number(range?.maxRange);
    if (!Number.isFinite(minRange) || !Number.isFinite(maxRange) || minRange < 0 || maxRange < minRange) continue;
    normalized.push({
      minRange: Math.floor(minRange),
      maxRange: Math.floor(maxRange),
      shape: String(range?.shape ?? 'Cross'),
      area: range?.area && typeof range.area === 'object' ? { ...range.area } : null,
      emplaced: range?.emplaced === true,
      seesOverHeight: String(range?.losRule ?? 'normal') !== 'normal'
    });
  }
  return normalized;
}

/* -------------------------------------------- */
/*  Terrain elevation                           */
/* -------------------------------------------- */
/**
 * Check terrain transitions during graph search. A type-restricted transition remains walkable ground
 * for that type but supplies no crossing between floors.
 */
function terrainStepIsAllowed(from, to, input) {
  if (input.airborne) return true;
  const destinationElevations = new Set();
  for (let dx = 0; dx < input.footprint.width; dx += 1) {
    for (let dy = 0; dy < input.footprint.height; dy += 1) {
      const fromKey = cellKey(from.x + dx, from.y + dy);
      const toKey = cellKey(to.x + dx, to.y + dy);
      const fromElevation = finiteNumber(input.terrainElevations[fromKey]);
      const toElevation = finiteNumber(input.terrainElevations[toKey]);
      destinationElevations.add(toElevation);
      if (fromElevation === toElevation) continue;
      const direction = stepDirection(from, to);
      if (!usableCrossing(input, fromKey)?.[direction] && !usableCrossing(input, toKey)?.[direction]) return false;
    }
  }
  return destinationElevations.size <= 1;
}

/** The crossing directions a square grants this unit, none when its transition is barred to the unit's type. */
function usableCrossing(input, key) {
  if (input.terrainRestrictedTransitionCells.has(key)) return null;
  return input.terrainTransitionDirections[key] ?? null;
}

function stepDirection(from, to) {
  if (to.x > from.x) return 'right';
  if (to.x < from.x) return 'left';
  if (to.y > from.y) return 'down';
  return 'up';
}

function normalizeCellKeys(cells = []) {
  return cells.map(cell => typeof cell === 'string'
    ? cellKey(...cell.split(',').map(Number))
    : cellKey(normalizePoint(cell).x, normalizePoint(cell).y));
}

function normalizeWall(wall) {
  const values = [wall?.x1, wall?.y1, wall?.x2, wall?.y2].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return { x1: values[0], y1: values[1], x2: values[2], y2: values[3] };
}

function normalizePoint(point = {}) {
  return { x: Math.floor(finiteNumber(point.x)), y: Math.floor(finiteNumber(point.y)) };
}

function positiveInteger(value) {
  const number = Math.floor(finiteNumber(value));
  return number > 0 ? number : 0;
}

/** A caller-named reach, which a planner uses instead of the unit's own. `Infinity` asks for the whole map. */
function overriddenReach(allowance) {
  if (allowance === null || allowance === undefined) return null;
  if (allowance === Infinity) return Infinity;
  const number = Number(allowance);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/* -------------------------------------------- */
/*  Queue and cell helpers                      */
/* -------------------------------------------- */
const CELL_KEY_SETS = new WeakMap();
const STEP_KEY_SETS = new WeakMap();

/** The cell keys of a graph list, built once per list and kept off the serializable graph. */
function cellKeySet(cells) {
  const cached = CELL_KEY_SETS.get(cells);
  if (cached) return cached;
  const keys = new Set(cells.map(cell => cellKey(cell.x, cell.y)));
  CELL_KEY_SETS.set(cells, keys);
  return keys;
}

/** The step keys of a graph edge list, built once per list. */
function stepKeySet(steps) {
  if (!Array.isArray(steps)) return EMPTY_STEP_KEYS;
  const cached = STEP_KEY_SETS.get(steps);
  if (cached) return cached;
  const keys = new Set(steps);
  STEP_KEY_SETS.set(steps, keys);
  return keys;
}

const EMPTY_STEP_KEYS = new Set();

/** Counts cells as they join a search queue, so equal routes come off oldest first. Shared by every search here. */
let openOrder = 0;

/** Whether one open cell comes off the frontier before another: cheapest route first, then oldest. */
function cheaperThan(left, right) {
  return left.route < right.route || (left.route === right.route && left.order < right.order);
}

/** Add one open cell to the binary heap the searches draw the cheapest frontier from. */
function pushCheapest(queue, cell) {
  openOrder += 1;
  cell.order = openOrder;
  queue.push(cell);
  let index = queue.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!cheaperThan(queue[index], queue[parent])) break;
    [queue[parent], queue[index]] = [queue[index], queue[parent]];
    index = parent;
  }
}

/** Remove and return the cheapest open cell. */
function takeCheapest(queue) {
  const top = queue[0];
  const last = queue.pop();
  if (queue.length === 0) return top;
  queue[0] = last;
  let index = 0;
  for (;;) {
    const left = (index * 2) + 1;
    const right = left + 1;
    let smallest = index;
    if (left < queue.length && cheaperThan(queue[left], queue[smallest])) smallest = left;
    if (right < queue.length && cheaperThan(queue[right], queue[smallest])) smallest = right;
    if (smallest === index) break;
    [queue[smallest], queue[index]] = [queue[index], queue[smallest]];
    index = smallest;
  }
  return top;
}

function compareCells(left, right) {
  return left.y - right.y || left.x - right.x;
}

function stepKey(from, to) {
  return `${cellKey(from.x, from.y)}>${cellKey(to.x, to.y)}`;
}
