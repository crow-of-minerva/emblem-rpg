/** @layer foundry/adapters/projections */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { FALL_MARGIN } from '../../../contracts/domains/terrain.mjs';
import {
  GROUNDED_BY_STANCE_BREAK_FLAG, MOVEMENT_PERMISSION_FLAG, flyingForbidden, normalizeMovementPermission
} from '../../../game/movement/input-policy.mjs';
import {
  buildMovementGraph,
  collectCrossingOptions,
  remainingMovement,
  resolveMovementOccupancy,
  travelShortcuts
} from '../../../game/movement/pathfinding.mjs';
import { attackReachSteps, resolveAttackRanges } from '../../../game/targeting/attack-grid.mjs';
import { createGeometryResolver } from '../../../game/targeting/shapes.mjs';
import { crossingFallDamage, normalizeTerrainProfile } from '../../../game/terrain/rules.mjs';
import { hasStealAbility, isStealableItem, tradeActionAvailable } from '../../../game/economy/trade.mjs';
import { factionGroup, resolveAvatarScale, unitIgnoresLineOfSight } from '../../../game/character/rules.mjs';
import {
  isAirborneActor, isStanceBrokenActor, projectActorStatusKeys, projectWieldedArmament, tauntedByActorUuid
} from './combat-context.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import { cellKeyOf, footprintCells } from '../../../lib/core/geometry.mjs';
import { projectAttributeTotals, projectSkillRanks } from './items.mjs';
import { liveGuardBondPartnerToken, redirectFoundryHostileToken } from './tokens.mjs';
import { projectGeometrySight, readTerrainMovement } from './terrain.mjs';
import { sceneCombatActive, sceneExplorationActive } from './encounters.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';
import { worldClassicFlyerTargeting } from '../services/settings-policy.mjs';

/* -------------------------------------------- */
/*  Movement data                               */
/* -------------------------------------------- */
/**
 * Everything pathfinding and the movement overlays need about one unit and its map, as plain data: its position
 * and where its planned move started (`anchorPosition`), allowance, occupied squares, terrain, walls, attack ranges
 * and turn state. FoundryMovementRepository.getSnapshot serves it to companion modules as api.movement.getPlan,
 * and the movement writer checks it against the live documents before saving.
 * @param {TokenDocument} token The unit's placed Token.
 * @param {object} [options] `ignoreTokenIds` leaves those tokens out of the occupied squares, for a unit about to
 *   move. `nextTurn` gives the whole movement allowance rather than what is left this turn, which counts the square
 *   an Extra Action adds (`system.turn.movementBonus`). `hints: false` skips the hostile markers (they read every
 *   unit's items) for callers like the threat overlay that never draw them.
 * @returns {Readonly<object>} Frozen movement data.
 */
export function projectMovementSnapshot(token, { ignoreTokenIds = [], nextTurn = false, hints = true } = {}) {
  const scene = token.parent;
  const actor = token.actor;
  const gridSize = Number(scene?.grid?.size);
  const width = Number(scene?.width);
  const height = Number(scene?.height);
  const squareType = CONST.GRID_TYPES.SQUARE;
  const supportedGrid = Boolean(scene
    && gridSize > 0
    && width > 0
    && height > 0
    && (scene.grid?.type == null || Number(scene.grid.type) === squareType));
  const currentPosition = { x: Number((token._source ?? token).x) || 0, y: Number((token._source ?? token).y) || 0 };
  const turn = actor?.system?.turn ?? {};
  const movementPlanning = turn.movementPlanning === true;
  const anchorPosition = movementPlanning
    ? { x: Number(turn.movementAnchorX) || 0, y: Number(turn.movementAnchorY) || 0 }
    : currentPosition;
  const start = supportedGrid
    ? { x: Math.floor(anchorPosition.x / gridSize), y: Math.floor(anchorPosition.y / gridSize) }
    : { x: 0, y: 0 };
  const current = supportedGrid
    ? { x: Math.floor(currentPosition.x / gridSize), y: Math.floor(currentPosition.y / gridSize) }
    : { x: 0, y: 0 };
  const footprint = tokenFootprint(token);
  const totalMovement = Number(actor?.system?.stats?.mov?.total) || 0;
  const movementSpent = Number(turn.movementSpent) || 0;
  const movementBonus = Math.max(0, Number(turn.movementBonus) || 0);
  const exploring = sceneExplorationActive(scene);
  const ignored = new Set(ignoreTokenIds.map(String));
  const occupancy = supportedGrid ? projectTokenOccupancy(scene, token, gridSize, ignored) : emptyOccupancy();
  const terrain = supportedGrid ? projectTerrainState(scene, token) : emptyTerrain();
  const armament = projectWieldedArmament(actor);
  const attackRanges = projectAttackRanges(actor, armament);

  return Object.freeze({
    tokenUuid: token.uuid,
    tokenId: token.id,
    tokenName: token.name ?? actor?.name ?? 'Character',
    tokenImg: actor?.img ?? token.texture?.src ?? '',
    actorUuid: actor?.uuid ?? '',
    actorName: actor?.name ?? token.name ?? 'Character',
    actorType: actor?.type ?? '',
    sceneUuid: scene?.uuid ?? '',
    supportedGrid,
    // Scene padding is always 0 (hooks/scene.mjs), so the map's size in squares is its pixel size over the grid size.
    columns: supportedGrid ? Math.ceil(width / gridSize) : 0,
    rows: supportedGrid ? Math.ceil(height / gridSize) : 0,
    gridSize: supportedGrid ? gridSize : 0,
    start: Object.freeze(start),
    current: Object.freeze(current),
    footprint: Object.freeze(footprint),
    allowance: exploring ? Infinity
      : (nextTurn ? totalMovement : remainingMovement(totalMovement + movementBonus, movementSpent)),
    totalMovement,
    movementSpent,
    standardAvailable: turn.actionAvailable !== false,
    movementAvailable: turn.movementAvailable !== false,
    movementPlanning,
    canterPathfinding: movementPlanning && turn.canterPathfinding === true,
    movementControllerId: String(turn.movementControllerId ?? ''),
    movementPlanStartedAt: Number(turn.movementPlanStartedAt) || 0,
    airborne: isAirborneActor(actor),
    flying: actor?.system?.unitType?.flying === true,
    grounded: actor?.system?.statuses?.grounded === true,
    levitating: actor?.system?.combat?.levitation === true,
    groundedByStanceBreak: actor?.flags?.[SYSTEM_ID]?.[GROUNDED_BY_STANCE_BREAK_FLAG] === true,
    stanceBroken: isStanceBrokenActor(actor),
    freeTargeting: unitIgnoresLineOfSight(actor?.flags?.[SYSTEM_ID]),
    encounterActive: sceneCombatActive(scene),
    permission: scenePermission(scene),
    blockedCells: Object.freeze(occupancy.blockedCells),
    occupiedCells: Object.freeze(occupancy.occupiedCells),
    terrainOcclusionCells: terrain.obstacles,
    terrainImpassableCells: terrain.impassable,
    terrainCosts: terrain.costs,
    terrainElevations: terrain.elevations,
    terrainTransitionDirections: terrain.transitionDirections,
    terrainRestrictedTransitionCells: terrain.restrictedTransitions,
    terrainTeleports: terrain.teleports,
    terrainCrossings: terrain.crossings,
    armamentCells: Object.freeze(supportedGrid && armament ? tokenCellKeys(armament.token, gridSize) : []),
    hints: supportedGrid && hints ? projectHintFacts(scene, token, gridSize) : Object.freeze({ units: [] }),
    exploring,
    bonusAvailable: turn.bonusActionAvailable !== false,
    tradeAvailable: tradeActionAvailable(turn),
    factionRole: String(actor?.system?.faction?.role ?? 'Neutral'),
    actorImage: String(actor?.img ?? token.texture?.src ?? ''),
    avatarScale: resolveAvatarScale(actor?.system?.art?.avatarScale),
    blessed: actor?.system?.statuses?.blessed === true,
    stance: Number(actor?.system?.resources?.stn?.value ?? 1),
    stanceMax: Math.max(0, Number(actor?.system?.resources?.stn?.max) || 0),
    stanceRegen: finite(actor?.system?.stats?.stnRegen?.total, 3),
    hp: Math.max(0, Number(actor?.system?.resources?.hp?.value) || 0),
    hpMax: Math.max(0, Number(actor?.system?.resources?.hp?.max) || 0),
    mounted: actorIsMounted(actor),
    skills: projectSkillRanks(actor?.system ?? {}),
    attributes: projectAttributeTotals(actor?.system ?? {}),
    walls: supportedGrid ? projectMovementWalls(scene, gridSize) : NO_WALLS,
    attackRanges,
    anchorPosition: Object.freeze({ ...anchorPosition }),
    sourcePosition: Object.freeze({ ...currentPosition })
  });
}

/**
 * Builds the checker that counts where a unit could stand, for items whose effects have placement requirements.
 * Each unit's movement data is read from the live scene the first time it is needed.
 * @param {object} [request]
 * @param {string} [request.sourceTokenUuid] The caster, whose movement data a self or hypothetical mover uses.
 * @param {string|number} [request.effectRange] The range a caster-moving path budget is priced from.
 * @param {string|number} [request.targetEffectRange] The range a target-moving path budget is priced from.
 * @returns {(request: {anchor: object, mover: object, spec: object}) => {count: number}}
 */
export function projectGeometryResolver({
  sourceTokenUuid = '', effectRange = '', targetEffectRange = effectRange
} = {}) {
  const boards = new Map();
  const board = tokenUuid => {
    const key = String(tokenUuid ?? '');
    if (!boards.has(key)) {
      const tokenDocument = resolveTokenDocument(key);
      const placed = tokenDocument?.parent?.tokens && tokenDocument.actor;
      boards.set(key, placed ? projectMovementSnapshot(tokenDocument) : null);
    }
    return boards.get(key);
  };
  let resolve = null;
  return request => {
    resolve ??= createGeometryResolver({
      self: board(sourceTokenUuid), target: board, sight: projectGeometrySight, effectRange, targetEffectRange
    });
    return resolve(request);
  };
}

/** Read a map's movement permission, Allowed when it names none. */
export function scenePermission(scene) {
  return normalizeMovementPermission(scene?.getFlag?.(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG));
}

/** Whether a unit is mounted, read from the Mount status alone. */
function actorIsMounted(actor) {
  return actor?.system?.statuses?.mounted === true;
}

/* -------------------------------------------- */
/*  Reachable squares for Enemy AI              */
/* -------------------------------------------- */
/**
 * One unit's reachable squares for the Enemy AI planner, measured without writing anything. `start` and `maxCost`
 * override the origin and budget, and `cellPenalties` bias routes. `stationary` spends no allowance, and
 * `attackReach: false` skips attack coverage. `reverse` measures every square's way to `start` instead of from it
 * (buildMovementGraph's option). The Enemy AI reads it as game.emblemRpg.api.movement.getField.
 * @param {string} tokenUuid The unit being measured.
 * @param {object} [options] Search options, all optional and all additive.
 * @returns {Readonly<object>|null} Frozen `{graph, snapshot}`, or null when the uuid isn't a Token with an Actor.
 */
export function projectMovementField(tokenUuid, {
  nextTurn = false, start = null, maxCost = null, cellPenalties = null,
  ignoreTokenIds = [], teleports = true, stationary = false, attackReach = true, reverse = false
} = {}) {
  const tokenDocument = resolveTokenDocument(tokenUuid);
  if (!tokenDocument?.parent?.tokens || !tokenDocument.actor) return null;
  const snapshot = projectMovementSnapshot(tokenDocument, { ignoreTokenIds, nextTurn });
  const graph = stationary
    ? buildMovementGraph(snapshot, { start: start ?? snapshot.current, allowance: 0, attackReach })
    : buildMovementGraph(snapshot, { teleports, start, allowance: maxCost, cellPenalties, attackReach, reverse });
  return Object.freeze({ graph, snapshot });
}

/**
 * Every elevation crossing one unit could attempt, with its odds and worst-case fall damage, by the same rules the
 * movement overlays use. The Enemy AI reads it as game.emblemRpg.api.movement.crossings.
 * @param {string} tokenUuid The unit being measured.
 * @returns {readonly object[]|null} One frozen entry per crossing, or null when the uuid isn't a Token with an Actor.
 */
export function projectMovementCrossings(tokenUuid) {
  const tokenDocument = resolveTokenDocument(tokenUuid);
  if (!tokenDocument?.parent?.tokens || !tokenDocument.actor) return null;
  const snapshot = projectMovementSnapshot(tokenDocument);
  const graph = buildMovementGraph(snapshot, { teleports: true });
  const maxHp = Math.max(0, Number(snapshot.hpMax) || 0);
  return Object.freeze(collectCrossingOptions(snapshot, graph).map(option => {
    const worstFallDamage = option.descending
      ? crossingFallDamage({ levels: option.levels, miss: FALL_MARGIN, maxHp })
      : 0;
    return Object.freeze({
      from: Object.freeze({ ...option.from }),
      to: Object.freeze({ ...option.to }),
      direction: option.direction,
      zoneName: option.zoneName,
      skillKey: option.skillKey,
      dc: option.dc,
      chance: option.chance,
      descending: option.descending,
      levels: option.levels,
      fromElevation: option.fromElevation,
      toElevation: option.toElevation,
      worstFallDamage,
      fallFraction: maxHp > 0 ? worstFallDamage / maxHp : 0
    });
  }));
}

/**
 * The two sets of movement data a Shove or Retrieve is checked against: the caster's, and the moved unit's with the
 * caster left out of the occupied squares, so Retrieve can use the square the caster vacates.
 * @param {string} sourceTokenUuid The caster.
 * @param {string} targetTokenUuid The unit the ability moves.
 * @returns {Readonly<{source: object, target: object}>|null} Null when either is off a supported Scene.
 */
export function projectForcedMovementBoards(sourceTokenUuid, targetTokenUuid) {
  const source = resolveTokenDocument(sourceTokenUuid);
  const target = resolveTokenDocument(targetTokenUuid);
  if (!source?.parent?.tokens || !source.actor || !target?.parent?.tokens || !target.actor) return null;
  const board = projectMovementSnapshot(source);
  if (!board.supportedGrid) return null;
  return Object.freeze({
    source: board,
    target: projectMovementSnapshot(target, { ignoreTokenIds: [String(source.id)] })
  });
}

/* -------------------------------------------- */
/*  Token footprints                            */
/* -------------------------------------------- */

/**
 * Footprint in squares. A unit fills 1, 2 or 3 squares by rule, so any other size falls back to one square. A
 * fixture token, such as a Destructible, covers exactly the squares the scene gives it, so projectTokenOccupancy
 * blocks all five squares of a 5x1 wall rather than only its top-left square.
 */
function tokenFootprint(token, { unit = true } = {}) {
  return {
    width: unit ? supportedTokenDimension(token.width) : placedDimension(token.width),
    height: unit ? supportedTokenDimension(token.height) : placedDimension(token.height)
  };
}

function tokenCellKeys(token, gridSize) {
  const anchor = {
    x: Math.floor(Number((token._source ?? token).x) / gridSize),
    y: Math.floor(Number((token._source ?? token).y) / gridSize)
  };
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return [];
  return footprintKeys(anchor, tokenFootprint(token));
}

function supportedTokenDimension(value) {
  const dimension = Math.round(Number(value) || 1);
  return [1, 2, 3].includes(dimension) ? dimension : 1;
}

function placedDimension(value) {
  return Math.max(1, Math.round(Number(value) || 1));
}

/**
 * Every other token's cells, sorted into those the mover can't pass through and those it can't stop on. A Guard
 * partner is left out because it may share the mover's square, and resolveMovementOccupancy leaves out a hidden
 * fixture, unless it is a Destructible.
 */
function projectTokenOccupancy(scene, movingToken, gridSize, ignored = new Set()) {
  const blocked = new Set();
  const occupied = new Set();
  const moving = projectMovementUnit(movingToken.actor);
  const partnerId = String(liveGuardBondPartnerToken(movingToken)?.id ?? '');
  for (const token of collectionValues(scene.tokens)) {
    if (!token || token.id === movingToken.id || ignored.has(String(token.id))) continue;
    if (partnerId && String(token.id) === partnerId) continue;
    const anchor = {
      x: Math.floor(Number((token._source ?? token).x) / gridSize),
      y: Math.floor(Number((token._source ?? token).y) / gridSize)
    };
    const cells = footprintKeys(anchor, tokenFootprint(token, { unit: token.actor?.type === 'Character' }));
    const policy = resolveMovementOccupancy(moving, projectMovementUnit(token.actor, token));
    if (policy.occupiesLanding) {
      for (const cell of cells) occupied.add(cell);
    }
    if (!policy.canPass) {
      for (const cell of cells) blocked.add(cell);
    }
  }
  return { blockedCells: [...blocked], occupiedCells: [...occupied] };
}

/* -------------------------------------------- */
/*  Hostile markers                             */
/* -------------------------------------------- */
/**
 * What the movement overlay's hostile markers read: this unit's active types and steal ability, and each other
 * Character's top-left square, width (not height) and what it carries.
 */
function projectHintFacts(scene, movingToken, gridSize) {
  const actor = movingToken.actor;
  const units = [];
  for (const token of collectionValues(scene.tokens)) {
    const other = token?.actor;
    if (!token || token.id === movingToken.id || !other || other.type !== 'Character') continue;
    units.push(Object.freeze({
      tokenId: String(token.id),
      x: Math.floor(Number((token._source ?? token).x) / gridSize),
      y: Math.floor(Number((token._source ?? token).y) / gridSize),
      width: supportedTokenDimension(token.width),
      factionRole: String(other.system?.faction?.role ?? 'Neutral'),
      effectiveAgainst: Object.freeze(armamentEffectiveness(other)),
      hasStealables: collectionValues(other.items).some(item => isStealableItem(stealFacts(item)))
    }));
  }
  return Object.freeze({
    unitTypes: Object.freeze(activeUnitTypes(actor)),
    hasStealAbility: hasStealAbility(collectionValues(actor?.items)),
    units: Object.freeze(units)
  });
}

function activeUnitTypes(actor) {
  const airborne = isAirborneActor(actor);
  return Object.entries(actor?.system?.unitType ?? {})
    .filter(([key, value]) => (key === 'flying' ? airborne : value === true))
    .map(([key]) => key);
}

function armamentEffectiveness(actor) {
  const types = new Set();
  for (const item of collectionValues(actor?.items)) {
    if (!ARMAMENT_ITEM_TYPES.has(String(item?.system?.itemType ?? ''))) continue;
    for (const [type, active] of Object.entries(item.system?.weapon?.effectiveAgainst ?? {})) {
      if (active === true) types.add(type);
    }
  }
  return [...types];
}

function stealFacts(item) {
  return {
    type: String(item?.type ?? ''),
    innate: Boolean(item?.getFlag?.(SYSTEM_ID, 'innateGrant')),
    stealableFlag: String(item?.system?.stealable?.flag ?? ''),
    stealableDc: Number(item?.system?.stealable?.dc) || 0
  };
}

const ARMAMENT_ITEM_TYPES = new Set(['Weapon', 'Staff', 'Attack', 'Weapon Art']);

/** A unit as resolveMovementOccupancy reads it. `hidden` is its Token's, which only a fixture's rules read. */
function projectMovementUnit(actor, token = null) {
  if (!actor) return null;
  return {
    actorType: actor.type,
    hidden: token?.hidden === true,
    faction: actor.system?.faction?.role ?? 'Neutral',
    passing: actor.system?.statuses?.passing === true,
    passable: actor.system?.statuses?.passable === true,
    objectType: actor.system?.objectType ?? '',
    locked: actor.system?.locked !== false,
    blocksFlyers: actor.system?.blockFlyers === true,
    stance: Number(actor.system?.resources?.stn?.value) || 0,
    airborne: isAirborneActor(actor)
  };
}

/* -------------------------------------------- */
/*  Attack ranges                               */
/* -------------------------------------------- */
/**
 * The attack ranges pathfinding marks around each reachable square, from the weapons the unit carries. A borrowed
 * Armament's ranges are added flagged `emplaced`, so they count only at squares overlapping the Armament.
 */
function projectAttackRanges(actor, armament = null) {
  if (!actor) return Object.freeze([]);
  const proficiencies = Object.fromEntries(Object.entries(actor.system?.prof ?? {})
    .map(([key, proficiency]) => [key, Number(proficiency?.total) || 0]));
  const silenced = actorIsSilenced(actor);
  const carried = resolveAttackRanges({
    items: collectionValues(actor.items).map(attackItemFacts),
    proficiencies,
    silenced,
    derivedRange: armament ? undefined : actor.system?.stats?.rng?.total
  });
  if (!armament) return carried;
  const emplaced = resolveAttackRanges({
    items: [attackItemFacts(armament.weapon)],
    proficiencies,
    silenced,
    derivedRange: actor.system?.stats?.rng?.total
  }).map(range => Object.freeze({ ...range, emplaced: true }));
  return Object.freeze([...carried, ...emplaced]);
}

function attackItemFacts(item) {
  const system = item?.system ?? {};
  return Object.freeze({
    type: String(item?.type ?? ''),
    itemType: String(system.itemType ?? ''),
    requiredProficiency: String(system.weapon?.req ?? ''),
    requiredRank: Number(system.weapon?.rank) || 0,
    range: system.weapon?.rng,
    wielded: system.isWielded === true,
    shape: system.weapon?.targetShape,
    area: system.weapon?.targetArea && typeof system.weapon.targetArea === 'object'
      ? Object.freeze({ ...system.weapon.targetArea })
      : null,
    losRule: String(system.effectData?.losRule ?? 'normal')
  });
}

function actorIsSilenced(actor) {
  if (actor?.system?.statuses?.silenced === true) return true;
  const statuses = collectionValues(actor?.statuses);
  if (statuses.some(status => String(status).toLowerCase() === 'silenced')) return true;
  return collectionValues(actor?.appliedEffects).some(effect => (
    collectionValues(effect?.statuses).some(status => String(status).toLowerCase() === 'silenced')
  ));
}

/* -------------------------------------------- */
/*  Terrain                                     */
/* -------------------------------------------- */
function projectTerrainState(scene, movingToken) {
  const actor = movingToken.actor;
  const unitType = actor?.system?.unitType ?? {};
  const profile = normalizeTerrainProfile({
    name: actor?.name,
    actorType: actor?.system?.faction?.role,
    unitTypes: Object.keys(unitType).filter(type => unitType[type] === true),
    uuids: [actor?.uuid, actor?.token?.baseActor?.uuid, actor?.id ? `Actor.${actor.id}` : ''].filter(Boolean)
  });
  return readTerrainMovement(scene, profile, {
    airborne: isAirborneActor(actor),
    mounted: actorIsMounted(actor),
    terrainCostReduction: collectionValues(actor?.items).some(item => (
      item?.name === 'Into the Wilds' && item?.system?.itemType === 'Passive'
    )) ? 1 : 0
  });
}

function emptyTerrain() {
  return Object.freeze({
    costs: Object.freeze({}),
    obstacles: Object.freeze([]),
    impassable: Object.freeze([]),
    elevations: Object.freeze({}),
    transitionDirections: Object.freeze({}),
    restrictedTransitions: Object.freeze([]),
    teleports: Object.freeze([]),
    crossings: Object.freeze({})
  });
}

function emptyOccupancy() {
  return { blockedCells: [], occupiedCells: [] };
}

/* -------------------------------------------- */
/*  Walls                                       */
/* -------------------------------------------- */
const NO_WALLS = Object.freeze([]);

/** The last walls list handed out for each Scene, reused while its walls read the same so pathfinding's index stays. */
const SCENE_WALLS = new WeakMap();

/**
 * The Scene's movement-blocking walls in squares, read fresh on every call. When they match the last list handed out
 * for this Scene, that same frozen list is returned, so pathfinding can keep the wall index it built for it.
 */
function projectMovementWalls(scene, gridSize) {
  const walls = collectionValues(scene.walls)
    .filter(wallBlocksMovement)
    .map(wall => wallCoordinates(wall, gridSize))
    .filter(Boolean)
    .map(wall => Object.freeze(wall));
  const kept = SCENE_WALLS.get(scene);
  if (kept && sameWalls(kept, walls)) return kept;
  const fresh = Object.freeze(walls);
  SCENE_WALLS.set(scene, fresh);
  return fresh;
}

function sameWalls(left, right) {
  return left.length === right.length && left.every((wall, index) => wall.x1 === right[index].x1
    && wall.y1 === right[index].y1 && wall.x2 === right[index].x2 && wall.y2 === right[index].y2);
}

function wallBlocksMovement(wall) {
  const noRestriction = CONST.WALL_MOVEMENT_TYPES.NONE;
  const open = CONST.WALL_DOOR_STATES.OPEN;
  const movement = Number(wall?.move ?? wall?.document?.move ?? wall?._source?.move);
  const door = Number(wall?.door ?? wall?.document?.door ?? wall?._source?.door) || 0;
  const state = Number(wall?.ds ?? wall?.document?.ds ?? wall?._source?.ds) || 0;
  return movement !== noRestriction && !(door && state === open);
}

function wallCoordinates(wall, gridSize) {
  const coordinates = wall?.c ?? wall?.document?.c ?? wall?._source?.c;
  if (!Array.isArray(coordinates) || coordinates.length < 4) return null;
  const values = coordinates.slice(0, 4).map(value => Number(value) / gridSize);
  if (!values.every(Number.isFinite)) return null;
  return { x1: values[0], y1: values[1], x2: values[2], y2: values[3] };
}

/* -------------------------------------------- */
/*  Footprint keys                              */
/* -------------------------------------------- */

function footprintKeys(anchor, footprint) {
  return footprintCells(anchor?.x, anchor?.y, footprint?.width, footprint?.height).map(cellKeyOf);
}

/* -------------------------------------------- */
/*  Threat overlay                              */
/* -------------------------------------------- */
/**
 * What the threat overlay grades a selected unit's danger from: the unit itself, and every other token's
 * position, faction, reach and taunt, from saved positions and this client's visibility. Hidden units get no threat
 * line. createThreatAssessment (engine/combat/threat.mjs) reads it.
 * @param {string} selectedTokenUuid The unit whose incoming threats are asked for.
 * @returns {Readonly<object>|null} Frozen threat data, or null when the uuid isn't a Token with an Actor.
 */
export function projectThreatBoard(selectedTokenUuid) {
  const selectedDocument = resolveTokenDocument(selectedTokenUuid);
  const scene = selectedDocument?.parent ?? null;
  if (!scene?.tokens || !selectedDocument.actor) return null;
  const gridSize = Number(scene.grid?.size) || 1;
  const snapshot = projectMovementSnapshot(selectedDocument, { hints: false });
  const selectedActor = selectedDocument.actor;
  const units = [];
  for (const tokenDocument of collectionValues(scene.tokens)) {
    if (tokenDocument.id === selectedDocument.id) continue;
    const unit = projectThreatUnit(tokenDocument, gridSize, scene);
    if (unit) units.push(unit);
  }
  const terrain = readTerrainMovement(scene, null);
  return Object.freeze({
    gridSize,
    encounterActive: sceneCombatActive(scene) === true,
    travelShortcuts: travelShortcuts({ terrainCosts: terrain.costs, terrainTeleports: terrain.teleports }),
    classicFlyers: worldClassicFlyerTargeting(),
    flightForbidden: flyingForbidden(snapshot.permission),
    selected: Object.freeze({
      tokenUuid: String(selectedDocument.uuid ?? ''),
      tokenId: String(selectedDocument.id ?? ''),
      actorUuid: String(selectedActor.uuid ?? ''),
      faction: String(selectedActor.system?.faction?.role ?? 'Neutral'),
      combatant: selectedActor.type === 'Character',
      playerUnit: factionGroup(selectedActor.system?.faction?.role) === 'player',
      movement: snapshot.totalMovement,
      airborne: snapshot.airborne === true,
      stanceBroken: isStanceBrokenActor(selectedActor),
      exploring: snapshot.exploring === true,
      rect: Object.freeze(threatRect(selectedDocument, gridSize))
    }),
    units: Object.freeze(units)
  });
}

/**
 * One hostile's movement data for the threat overlay. The selected unit is left out of the occupied squares, since
 * it is about to move, and the hostile gets its whole allowance, since the threat line is about its next turn.
 * @param {string} hostileTokenUuid The hostile.
 * @param {string} selectedTokenUuid The unit it might reach.
 * @returns {Readonly<object>|null} Its movement data (projectMovementSnapshot), or null when either Token is gone.
 */
export function projectThreatReach(hostileTokenUuid, selectedTokenUuid) {
  const hostile = resolveTokenDocument(hostileTokenUuid);
  const selected = resolveTokenDocument(selectedTokenUuid);
  if (!hostile?.actor || !selected) return null;
  return projectMovementSnapshot(hostile, { ignoreTokenIds: [selected.id], nextTurn: true, hints: false });
}

function projectThreatUnit(tokenDocument, gridSize, scene) {
  const actor = tokenDocument.actor ?? null;
  if (!actor) return null;
  const system = actor.system ?? {};
  const tauntor = tauntedByActorUuid(actor);
  const compulsion = tauntor ? tauntCompulsion(scene, tauntor) : ABSENT_TAUNTOR;
  const ranges = projectAttackRanges(actor, projectWieldedArmament(actor));
  return Object.freeze({
    tokenUuid: String(tokenDocument.uuid ?? ''),
    tokenId: String(tokenDocument.id ?? ''),
    actorUuid: String(actor.uuid ?? ''),
    name: String(actor.name ?? tokenDocument.name ?? ''),
    faction: String(system.faction?.role ?? 'Neutral'),
    combatant: actor.type === 'Character',
    hp: Number(system.resources?.hp?.value) || 0,
    stance: Number(system.resources?.stn?.value) || 0,
    statuses: Object.freeze([...projectActorStatusKeys(actor)]),
    visible: tokenDocument.hidden !== true && tokenDocument.object?.visible !== false,
    airborne: isAirborneActor(actor),
    movement: Number(system.stats?.mov?.total) || 0,
    maxAttackRange: Math.max(0, ...ranges.map(range => Number(range.maxRange) || 0)),
    maxAttackReach: Math.max(0, ...ranges.map(attackReachSteps)),
    rect: Object.freeze(threatRect(tokenDocument, gridSize)),
    tauntedByActorUuid: tauntor,
    tauntorPresent: compulsion.present,
    tauntorGuardedByActorUuid: compulsion.guardedByActorUuid
  });
}

const ABSENT_TAUNTOR = Object.freeze({ present: false, guardedByActorUuid: '' });

/**
 * Whether the unit that taunted is still on the map, so its taunt holds, and, when a Guard bond covers it, the
 * guarder who would take attacks aimed at it.
 */
function tauntCompulsion(scene, actorUuid) {
  for (const tokenDocument of collectionValues(scene.tokens)) {
    const actor = tokenDocument?.actor;
    if (!actor || String(actor.uuid ?? '') !== String(actorUuid)) continue;
    if (!unitAnswersMarks(tokenDocument)) return ABSENT_TAUNTOR;
    const guarder = redirectFoundryHostileToken(tokenDocument);
    const guarderUuid = String(guarder?.actor?.uuid ?? '');
    const bonded = guarderUuid !== '' && guarderUuid !== String(actorUuid) && unitAnswersMarks(guarder);
    return Object.freeze({ present: true, guardedByActorUuid: bonded ? guarderUuid : '' });
  }
  return ABSENT_TAUNTOR;
}

/** Whether a unit is standing where a mark can still reach it: alive, on the map, not hidden and outside Sanctuary. */
function unitAnswersMarks(tokenDocument) {
  const actor = tokenDocument?.actor;
  if (!actor || tokenDocument.hidden === true) return false;
  if ((Number(actor.system?.resources?.hp?.value) || 0) <= 0) return false;
  return !projectActorStatusKeys(actor).has('sanctuary') && actor.system?.statuses?.sanctuary !== true;
}

function threatRect(tokenDocument, gridSize) {
  const source = tokenDocument._source ?? tokenDocument;
  return {
    x: Math.floor(Number(source.x ?? tokenDocument.x) / gridSize),
    y: Math.floor(Number(source.y ?? tokenDocument.y) / gridSize),
    ...tokenFootprint(source)
  };
}

function resolveTokenDocument(tokenUuid) {
  if (!tokenUuid) return null;
  let document = null;
  try {
    document = fromUuidSync(tokenUuid) ?? null;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'resolveTokenDocument');
    document = null;
  }
  return document?.documentName === 'Token' ? document : null;
}
