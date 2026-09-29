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
import { cellKey, parseCellKey } from '../../lib/core/geometry.mjs';
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
 * Whether the moving unit may pass through another unit, and whether that unit's square is taken for landing. The
 * movement projection (foundry/adapters/projections/movement.mjs) sorts the board's units into buildMovementGraph's
 * blocked and occupied cells with it, and projections/board.mjs asks it for landing alone. Each unit's `airborne` is
 * the fact projectMovementUnit reads with isAirborneActor. A hidden fixture neither blocks nor takes a square, except
 * a hidden Destructible, which still blocks (fixtureHiddenFromMovement in game/objects/rules.mjs).
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
  const canPass = (moving?.airborne === true) !== (other.airborne === true)
    || areFactionsFriendly(moving?.faction, other.faction);
  return { occupiesLanding, canPass };
}

/* -------------------------------------------- */
/*  Landing                                     */
/* -------------------------------------------- */
/**
 * Whether an obstacle lies under a footprint, which makes its square one a flier cannot land on. The flight action
 * in engine/movement/commands.mjs refuses to land there. A stance break lands a flier there anyway and strands it.
 * @param {{x: number, y: number}} anchor The footprint's top-left square.
 * @param {{width?: number, height?: number}} [footprint] Its size in squares.
 * @param {Array<{x: number, y: number}>} [obstacles] The Scene's obstacle squares, as a movement snapshot's
 *   `terrainOcclusionCells` carries them.
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
 * Whether the square a movement snapshot has its unit standing on now is one a flier cannot land on, the test every
 * forced landing is refused by (planForcedLanding in input-policy.mjs).
 * @param {object|null} movement Movement snapshot: `current`, `footprint` and `terrainOcclusionCells`.
 * @returns {boolean}
 */
export function standsOverObstacle(movement) {
  if (!movement?.current) return false;
  return landingBlocked(movement.current, movement.footprint, movement.terrainOcclusionCells);
}

/**
 * Whether a unit is stranded on the square it stands on: a stance break grounded it (the `groundedByStanceBreak`
 * fact the movement snapshot reads off its Actor), it is still a flier on the ground, and an obstacle is under it.
 * It takes no move of its own until it takes off, so buildMovementGraph gives it no steps and the movement commands
 * refuse to move it. A push, a swap or an effect's placement is not its own move and ignores this.
 * @param {object} source Movement snapshot: `groundedByStanceBreak`, `flying`, `airborne`, `footprint` and
 *   `terrainOcclusionCells`.
 * @param {{x: number, y: number}} [anchor] The square it stands on, or the snapshot's plan anchor when none is named.
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
 * Build the weighted graph used by movement previews, engine validation and planning modules.
 * Teleport edges are opt-in: the normal player grid stops at the pad until the player activates it.
 * Only movement-priced pads can be represented as graph edges. A unit stranded where the search starts
 * (movementStranded) keeps its own square and nothing more, with no allowance left for a crossing.
 * @param {object} source Plain Scene and unit projection.
 * @param {object} [options]
 * @param {boolean} [options.teleports] Whether movement-cost pads become edges of the graph.
 * @param {{x: number, y: number}|null} [options.start] Search from this square instead of the snapshot's anchor.
 * @param {number|null} [options.allowance] Reach to search to, `Infinity` included, instead of the unit's own.
 * @param {object|null} [options.cellPenalties] A surcharge, by cell key, added to the route cost (not the movement
 *   cost) of entering a cell.
 * @param {boolean} [options.attackReach] Whether the attack reach is measured. False leaves both tile lists empty.
 * @param {boolean} [options.keyboardDiagonals] Whether the diagonal keyboard steps are listed. False leaves
 *   `diagonalStepKeys` empty for a reader that never moves the unit by key, such as the threat overlay's reach.
 * @param {boolean} [options.reverse] Search toward `start` instead of away from it. Every step and teleport is taken
 *   against its direction, so a cell's cost and route are what walking from it to `start` costs, its parent is the
 *   next square on that walk, and the placements are the squares `start` can be reached from. `start` is a goal
 *   here, not where the unit stands, so being stranded is not checked.
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
 * Resolve the cost and shortest legal route checked by engine/movement/commands.mjs before committing a
 * destination.
 * @param {object} graph Graph returned by {@link buildMovementGraph}.
 * @param {object} destination Grid anchor.
 * @returns {object|null} Resolution, or `null` when the anchor is not a legal landing.
 */
export function resolveMovementDestination(graph, destination) {
  return resolveRoute(graph, destination, graph.destinations);
}

/**
 * The landing test the graph applies to a placement, judged where the footprint stands with no walk implied.
 * @param {object} source Plain Scene and unit projection.
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
  return resolveMovementDestination(buildMovementGraph(movement), movement.current);
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
 * @param {object} destination Grid anchor.
 * @returns {object|null} Preview resolution, or `null` outside the movement graph.
 */
export function resolveMovementPreview(graph, destination) {
  return resolveRoute(graph, destination, graph.placements);
}

/**
 * Route a movement preview from the temporary Token position, for ui/controls/drag-route.mjs. `cost` stays relative
 * to the committed anchor, and `routeCost` measures only this temporary route.
 */
export function resolveMovementPreviewFrom(graph, start, destination) {
  const origin = normalizePoint(start);
  const target = normalizePoint(destination);
  const originKey = cellKey(origin.x, origin.y);
  const targetKey = cellKey(target.x, target.y);
  const legalKeys = cellKeySet(graph?.placements ?? []);
  if (!legalKeys.has(originKey) || !legalKeys.has(targetKey)) return null;

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
      if (!canTraverseMovementStep(graph, current, next)) continue;
      const nextCost = current.cost + finiteNonNegative(graph.costByStep?.[stepKey(current, next)], 1);
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

/** Whether two adjacent preview anchors share a legal directed movement edge. */
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

/** The reach a unit's graph is built to: nothing for an open plan whose movement is spent, its allowance otherwise. */
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
 * @param {object} source Plain Scene and unit projection.
 * @returns {boolean}
 */
export function terrainBoundsTravelByDistance(source = {}) {
  if (Object.values(source.terrainCosts ?? {}).some(cost => Number(cost) === 0)) return false;
  return !(source.terrainTeleports ?? []).some(pad => pad?.exit && pad.cost === TELEPORT_COSTS.MOVEMENT);
}

/**
 * Build teleport edges for buildMovementGraph. Exclude action- and bonus-priced pads because their
 * turn costs need engine settlement. Restricted pads remain walkable but cannot be activated.
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
 * Check a teleport destination for buildMovementGraph using standing rules, not walked edges.
 * Ignore crossed walls and heights but require a uniform floor under the landing footprint. A unit on the landing
 * footprint, ally or not, drops the edge, because the teleport command (useTeleport in engine/movement/commands.mjs)
 * never lands a unit on an occupied exit.
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
    for (const range of input.attackRanges) {
      if (range.emplaced && rack.size > 0 && !onRack) continue;
      for (const key of calculateAttackTilesFromPosition(
        placement.x,
        placement.y,
        range,
        input.columns,
        input.rows,
        input.footprint
      )) fromPlacement.add(key);
    }

    if (!hasElevation) {
      for (const key of fromPlacement) attackable.add(key);
      continue;
    }
    if (meleeOnly) filterMeleeElevation(fromPlacement, placement, input.terrainElevations);
    const obscured = input.airborne
      ? new Set()
      : heightObscuredCells(fromPlacement, placement, input.footprint, input.terrainElevations);
    for (const key of fromPlacement) {
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
 * The attack tiles whose ground height hides from a placement, judged from the footprint square nearest each tile.
 * buildCombinedAttackRange runs it for every placement of every graph the threat overlay builds, so it allocates
 * nothing per tile beyond the parsed tile itself.
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
 * Build movement-overlay hints for ui/controls/movement.mjs. Mark hostile weapon effectiveness as danger
 * and stealable goods when the selected unit has Steal. Leave friendly units unmarked.
 * @param {object} source Movement snapshot carrying `factionRole` and the projected `hints` facts.
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
 * @param {object} landing The snapshot's landing facts, from {@link crossingLandingFacts}.
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

/**
 * What crossingLandingIsLegal reads, built once per snapshot. Normalizing costs about a millisecond on a terrain-heavy
 * scene, so callers that check many landings build this once instead of once per landing.
 */
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
 * @param {object} source Movement snapshot of the unit being moved, with its own occupancy.
 * @param {{x: number, y: number}} from The square being left.
 * @param {{x: number, y: number}} to The square it is being sent to.
 * @param {object} [options] `ignoreWalls` for a step authored to pass through walls.
 * @returns {Readonly<{outcome: string, crossing: object|null}>} The crossing to roll, on a descent.
 */
export function resolveForcedStep(source, from, to, { ignoreWalls = false } = {}) {
  const input = normalizeInput(source);
  if (footprintOverlaps(to, input.footprint, new Set(input.occupiedCells))) {
    return forcedStep(FORCED_STEP_OUTCOMES.OCCUPIED);
  }
  if (!crossingLandingIsLegal(crossingLandingFacts(source, input), from, to, { ignoreWalls })) {
    return forcedStep(FORCED_STEP_OUTCOMES.BLOCKED);
  }
  const fromElevation = finiteNumber(input.terrainElevations[cellKey(from.x, from.y)]);
  const toElevation = finiteNumber(input.terrainElevations[cellKey(to.x, to.y)]);
  if (input.airborne || fromElevation === toElevation) return forcedStep(FORCED_STEP_OUTCOMES.WALK);
  if (toElevation > fromElevation) return forcedStep(FORCED_STEP_OUTCOMES.ASCENT);
  const crossing = crossingCandidates(source, from, to)
    .find(option => option.to.x === to.x && option.to.y === to.y);
  return crossing ? forcedStep(FORCED_STEP_OUTCOMES.DESCENT, crossing) : forcedStep(FORCED_STEP_OUTCOMES.BLOCKED);
}

function forcedStep(outcome, crossing = null) {
  return Object.freeze({ outcome, crossing });
}

/**
 * Build crossing choices for ui/controls/movement.mjs and engine/movement/commands.mjs. Entering an impassable
 * bridge cell follows its network to the possible landings, and the player chooses when the network branches.
 * @param {object} source Movement snapshot carrying the projected crossing board.
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
 * Build crossing-arrow previews for ui/controls/movement.mjs and the movement projection. Walkable destinations are
 * skipped, and where one border branches to several bridge exits the landing with the best odds wins.
 * @param {object} source Movement snapshot carrying the projected crossing board and the unit's skill facts.
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

function stepCrossesWall(from, to, input) {
  if (input.wallsByCell.size === 0) return false;
  for (let dx = 0; dx < input.footprint.width; dx += 1) {
    for (let dy = 0; dy < input.footprint.height; dy += 1) {
      const movement = {
        x1: from.x + dx + 0.5,
        y1: from.y + dy + 0.5,
        x2: to.x + dx + 0.5,
        y2: to.y + dy + 0.5
      };
      for (const wall of wallsNearStep(input, from.x + dx, from.y + dy, to.x + dx, to.y + dy)) {
        if (segmentsIntersect(movement, wall)) return true;
      }
    }
  }
  return false;
}

/** The walls that could cross a one-square step, drawn from the buckets of its two cells. */
function wallsNearStep(input, fromX, fromY, toX, toY) {
  const near = input.wallsByCell.get(cellKey(fromX, fromY)) ?? [];
  const beyond = input.wallsByCell.get(cellKey(toX, toY)) ?? [];
  if (near.length === 0) return beyond;
  if (beyond.length === 0) return near;
  return new Set([...near, ...beyond]);
}

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
function normalizeInput(source = {}, { start: startOverride = null, allowance = null } = {}) {
  const columns = positiveInteger(source.columns);
  const rows = positiveInteger(source.rows);
  if (!columns || !rows) throw new TypeError('Movement grid dimensions must be positive integers.');
  const start = normalizePoint(startOverride ?? source.start);
  const footprint = {
    width: positiveInteger(source.footprint?.width) || 1,
    height: positiveInteger(source.footprint?.height) || 1
  };
  const walls = source.airborne ? [] : (source.walls ?? []).map(normalizeWall).filter(Boolean);
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
    terrainCosts: source.airborne ? {} : { ...(source.terrainCosts ?? {}) },
    terrainElevations: { ...(source.terrainElevations ?? {}) },
    terrainTransitionDirections: { ...(source.terrainTransitionDirections ?? {}) },
    terrainRestrictedTransitionCells: new Set(normalizeCellKeys(source.terrainRestrictedTransitionCells)),
    terrainTeleports: Array.isArray(source.terrainTeleports) ? source.terrainTeleports : [],
    armamentCells: new Set(normalizeCellKeys(source.armamentCells)),
    walls,
    wallsByCell: indexWallsByCell(walls),
    attackRanges: normalizeAttackRanges(source.attackRanges)
  };
}

/** Index walls for wallsNearStep. Include a one-cell margin so a center-to-center step needs only its two buckets. */
function indexWallsByCell(walls) {
  const index = new Map();
  for (const wall of walls) {
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
      emplaced: range?.emplaced === true
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

/** A caller-named reach, which a planner uses instead of the unit's own. `Infinity` asks for the whole board. */
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
