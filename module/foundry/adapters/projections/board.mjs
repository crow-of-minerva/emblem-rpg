/** @layer foundry/adapters/projections */
/*
 * Readers that list every token on a Scene, from saved token positions, as plain frozen data for the rules:
 * projectAuraBoard (each unit and the auras it gives off, for the host client's aura recalculation and the BG3 HUD),
 * projectTerrainBoard, projectTargetingBoard (item and interaction picks) and projectUnitBoard (read by the Enemy
 * AI). The functions at the end answer what a unit would get on a square it is considering: terrain bonuses,
 * hazards, height and auras.
 */
import {
  AURA_ATTRIBUTE_PATHS,
  auraEmissionSignature,
  auraGearReads,
  collectAuraContributions
} from '../../../game/effects/auras.mjs';
import {
  footprintTerrainElevation,
  isAirborneActor,
  isDestructibleActor,
  isStanceBrokenActor,
  passiveFlag,
  projectFlightForbidden,
  projectActorStatusKeys,
  projectUnitFacts,
  tauntedByActorUuid
} from './combat-context.mjs';
import { OBJECT_FIXTURE_TYPES } from '../../../contracts/domains/objects.mjs';
import {
  fixtureHidden,
  fixtureHiddenFromMovement,
  resolveTargetKind,
  TARGET_KINDS
} from '../../../game/objects/rules.mjs';
import { resolveMovementOccupancy } from '../../../game/movement/pathfinding.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { LURE_FLAG, SUMMONED_BY_FLAG } from '../../../contracts/domains/combat.mjs';
import { TERRAIN_STAT_FIELDS, TERRAIN_UNIT_TYPES } from '../../../contracts/domains/terrain.mjs';
import {
  footprintCells as terrainFootprintCells,
  normalizeTerrainProfile,
  terrainStatModifiers
} from '../../../game/terrain/rules.mjs';
import { capTerrainDamage, resolveTerrainImpacts, scanTerrainImpacts } from '../../../game/terrain/effects.mjs';
import { averageFormulaValue } from '../../../game/combat/attack-preview.mjs';
import { stanceRecoveryAmount } from '../../../game/combat/damage.mjs';
import { expectedPhaseStartDamage } from '../../../game/effects/statuses.mjs';
import { unitTurnComplete } from '../../../game/combat/phases.mjs';
import { factionGroup } from '../../../game/character/rules.mjs';
import { cellKey } from '../../../lib/core/geometry.mjs';
import { readTerrainElevations, readTerrainGrid } from './terrain.mjs';
import { projectEncounterState, sceneExplorationActive } from './encounters.mjs';
import { projectActorPartyId, readPartyState } from './parties.mjs';
import { redirectFoundryHostileToken } from './tokens.mjs';
import { resolveSync, resolveViewedScene } from '../services/host.mjs';
import { worldClassicFlyerTargeting } from '../services/settings-policy.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import { hasConditionTree } from '../../../contracts/dsl/conditions.mjs';
import {
  GROUNDED_BY_STANCE_BREAK_FLAG,
  MOVEMENT_INPUT_KINDS,
  MOVEMENT_PERMISSION_FLAG,
  MOVE_SCALINGS,
  MOVE_SCALING_FLAG,
  UNIT_MOVE_SCALING_FLAG,
  normalizeMovementPermission,
  normalizeMoveScaling,
  planFlightToggle
} from '../../../game/movement/input-policy.mjs';

const CHARACTER_TYPE = 'Character';
const MAX_TOKEN_DIMENSION = 3;

/* -------------------------------------------- */
/*  Placed units                                */
/* -------------------------------------------- */
/**
 * Every unit on one Scene and the auras it gives off, from saved token positions, for the host client's aura
 * recalculation. World Characters that aren't placed but still carry aura values are included so they get cleared,
 * but not ones placed on another Scene, whose values belong to that placement.
 * @param {Scene} [scene] Scene to read. Defaults to the Scene on screen.
 * @returns {{units: readonly object[]}|null} Frozen list of units, or null when there is no Scene.
 */
export function projectAuraBoard(scene = globalThis.canvas?.scene) {
  if (!scene?.tokens) return null;
  const gridSize = Number(scene.grid?.size) || 1;
  const elevations = readTerrainElevations(scene);
  const placed = [];
  const placedActorUuids = new Set();
  for (const tokenDocument of collectionValues(scene.tokens)) {
    const unit = projectPlacedUnit(tokenDocument, gridSize, elevations);
    if (!unit) continue;
    placed.push(unit);
    placedActorUuids.add(unit.actorUuid);
  }
  const units = [...placed, ...projectDetachedUnits(placedActorUuids, scene)];
  const conditional = placed.some(unit => unit.emissions.some(emission => emission.conditional));
  return Object.freeze({ units: Object.freeze(units.map(unit => detachUnit(unit, conditional))) });
}

/**
 * The aura contributions one placed unit receives, the same as collecting them from projectAuraBoard.
 *
 * A cheaper version for the BG3 HUD's aura explanation, which is redrawn on every step the shown unit takes. It
 * skips unplaced Characters, which never give off auras, and builds a unit's condition values only when a
 * conditional aura needs them.
 * @param {TokenDocument} tokenDocument The receiving unit's Token.
 * @returns {readonly object[]} Frozen contributions.
 */
export function projectAuraContributionsFor(tokenDocument) {
  const board = projectLiveAuraBoard(tokenDocument?.parent ?? null) ?? { units: [] };
  return collectAuraContributions(board, String(tokenDocument?.uuid ?? ''));
}

/**
 * The placed units of projectAuraBoard, with each unit's condition values built when first read. Use the result in
 * the same synchronous call, before any Actor changes.
 */
function projectLiveAuraBoard(scene) {
  if (!scene?.tokens) return null;
  const gridSize = Number(scene.grid?.size) || 1;
  const elevations = readTerrainElevations(scene);
  const placed = [];
  for (const tokenDocument of collectionValues(scene.tokens)) {
    const unit = projectPlacedUnit(tokenDocument, gridSize, elevations);
    if (unit) placed.push(unit);
  }
  const conditional = placed.some(unit => unit.emissions.some(emission => emission.conditional));
  return Object.freeze({ units: Object.freeze(placed.map(unit => detachUnitLazily(unit, conditional))) });
}

/**
 * A summary of the auras one Actor gives off. The hooks in foundry/hooks/board.mjs compare it before and after an
 * Item change and skip the aura recalculation when it is the same.
 * @returns {string}
 */
export function projectAuraEmissionSignature(actor) {
  return auraEmissionSignature(projectAuraEmissions(actor));
}

/**
 * Whose equipment one Actor's aura conditions read: its own, its target's, or both. The hooks in
 * foundry/hooks/board.mjs use it to skip the aura recalculation after an equip change no aura on the Scene can see.
 * @param {Actor} actor A unit standing on the Scene.
 * @returns {Readonly<{self: boolean, target: boolean}>}
 */
export function projectAuraGearReads(actor) {
  return auraGearReads(projectAuraEmissions(actor));
}

/* -------------------------------------------- */
/*  Units                                       */
/* -------------------------------------------- */
/** One Token as projectAuraBoard reads it. A hidden fixture gives off nothing until it is revealed. */
function projectPlacedUnit(tokenDocument, gridSize, elevations) {
  const actor = tokenDocument.actor ?? null;
  const actorUuid = String(actor?.uuid ?? '');
  if (!actor || !actorUuid) return null;
  if (fixtureHidden({ documentType: actor.type, hidden: tokenDocument.hidden })) return null;
  const footprint = projectFootprint(tokenDocument, gridSize);
  return {
    tokenUuid: String(tokenDocument.uuid ?? ''),
    actorUuid,
    actorId: String(actor.id ?? ''),
    name: String(actor.name ?? ''),
    placed: true,
    receives: actor.type === CHARACTER_TYPE,
    faction: String(actor.system?.faction?.role ?? 'Neutral'),
    sprite: projectSprite(tokenDocument, actor),
    footprint,
    elevation: footprintTerrainElevation(footprint, elevations),
    auraFields: projectAuraFields(actor),
    emissions: projectAuraEmissions(actor),
    document: actor
  };
}

/**
 * Whether a world Actor stands on a Scene other than this one. The values it carries belong to that placement, so
 * recalculating this Scene must not clear them as if the unit had left the map.
 */
function placedElsewhere(actor, scene) {
  return collectionValues(actor?.getDependentTokens?.({ linked: true, concreteOnly: true }))
    .some(token => token?.parent && String(token.parent.uuid ?? '') !== String(scene?.uuid ?? ''));
}

/** World Characters placed on no Scene that still carry aura values, so the recalculation clears them. */
function projectDetachedUnits(placedActorUuids, scene) {
  const detached = [];
  for (const actor of collectionValues(globalThis.game?.actors)) {
    if (actor?.type !== CHARACTER_TYPE || placedActorUuids.has(String(actor.uuid ?? ''))) continue;
    const auraFields = projectAuraFields(actor);
    if (!Object.values(auraFields).some(value => value !== 0)) continue;
    if (placedElsewhere(actor, scene)) continue;
    detached.push({
      tokenUuid: '',
      actorUuid: String(actor.uuid ?? ''),
      actorId: String(actor.id ?? ''),
      name: String(actor.name ?? ''),
      placed: false,
      receives: true,
      faction: String(actor.system?.faction?.role ?? 'Neutral'),
      sprite: String(actor.img ?? ''),
      footprint: Object.freeze({ x: 0, y: 0, width: 1, height: 1 }),
      elevation: 0,
      auraFields,
      emissions: Object.freeze([]),
      document: actor
    });
  }
  return detached;
}

/** The aura values saved on an Actor, by aura attribute path. */
function projectAuraFields(actor) {
  const source = actor?._source?.system ?? actor?.system ?? {};
  const fields = {};
  for (const path of AURA_ATTRIBUTE_PATHS) {
    const [container, key] = path.split('.');
    fields[path] = Number(source?.[container]?.[key]?.aura) || 0;
  }
  return Object.freeze(fields);
}

/* -------------------------------------------- */
/*  Terrain board                               */
/* -------------------------------------------- */
/**
 * Terrain data for one Scene: each placed Character's footprint, terrain profile and current terrain values,
 * and the squares a unit can't land on. Unplaced world Characters that still carry terrain values are included so
 * they get cleared, but not ones placed on another Scene.
 * @param {Scene} scene Scene to read.
 * @returns {object|null} Frozen result, or null when there is no Scene.
 */
export function projectTerrainBoard(scene) {
  if (!scene?.tokens) return null;
  const gridSize = Number(scene.grid?.size) || 1;
  const units = [];
  const placedActorUuids = new Set();
  const occupied = [];
  for (const tokenDocument of collectionValues(scene.tokens)) {
    const actor = tokenDocument.actor ?? null;
    const actorUuid = String(actor?.uuid ?? '');
    if (!actor || !actorUuid) continue;
    const footprint = projectFootprint(tokenDocument, gridSize);
    if (occupiesLanding(actor, tokenDocument)) occupied.push(...footprintKeys(footprint));
    if (actor.type !== CHARACTER_TYPE) continue;
    placedActorUuids.add(actorUuid);
    units.push(Object.freeze({
      tokenUuid: String(tokenDocument.uuid ?? ''),
      actorUuid,
      placed: true,
      airborne: isAirborneActor(actor),
      footprint,
      profile: projectTerrainProfile(actor, tokenDocument),
      fields: projectTerrainFields(actor),
      moveScaling: projectUnitMoveScaling(actor)
    }));
  }
  for (const actor of collectionValues(globalThis.game?.actors)) {
    const actorUuid = String(actor?.uuid ?? '');
    if (actor?.type !== CHARACTER_TYPE || !actorUuid || placedActorUuids.has(actorUuid)) continue;
    const fields = projectTerrainFields(actor);
    const moveScaling = projectUnitMoveScaling(actor);
    if (!Object.values(fields).some(value => value !== 0) && moveScaling === MOVE_SCALINGS.NONE) continue;
    if (placedElsewhere(actor, scene)) continue;
    units.push(Object.freeze({
      tokenUuid: '',
      actorUuid,
      placed: false,
      airborne: false,
      footprint: Object.freeze({ x: 0, y: 0, width: 1, height: 1 }),
      profile: projectTerrainProfile(actor, null),
      fields,
      moveScaling
    }));
  }
  const board = {
    sceneUuid: String(scene.uuid ?? ''),
    moveScaling: normalizeMoveScaling(scene.getFlag?.(SYSTEM_ID, MOVE_SCALING_FLAG)),
    grid: readTerrainGrid(scene),
    bounds: Object.freeze({
      columns: Math.ceil((Number(scene.width) || 0) / gridSize),
      rows: Math.ceil((Number(scene.height) || 0) / gridSize)
    }),
    occupied: Object.freeze([...new Set(occupied)]),
    units: Object.freeze(units)
  };
  return Object.freeze({ ...board, fingerprint: terrainBoardFingerprint(board) });
}

/** Summarize the terrain data so a plan built against an outdated copy is refused rather than saved. */
function terrainBoardFingerprint(board) {
  return JSON.stringify([
    board?.grid ?? {},
    board?.moveScaling ?? '',
    (board?.units ?? []).map(unit => [
      unit.actorUuid, unit.placed, unit.airborne, unit.footprint, unit.profile, unit.fields, unit.moveScaling
    ])
  ]);
}

function footprintKeys(footprint) {
  const keys = [];
  for (let dx = 0; dx < footprint.width; dx += 1) {
    for (let dy = 0; dy < footprint.height; dy += 1) keys.push(cellKey(footprint.x + dx, footprint.y + dy));
  }
  return keys;
}

function occupiesLanding(actor, tokenDocument) {
  return resolveMovementOccupancy(null, {
    actorType: actor.type,
    hidden: tokenDocument?.hidden === true,
    passable: actor.system?.statuses?.passable === true,
    objectType: String(actor.system?.objectType ?? ''),
    locked: actor.system?.locked !== false,
    stance: Number(actor.system?.resources?.stn?.value) || 0
  }).occupiesLanding;
}

function projectTerrainFields(actor) {
  const flags = actor?._source?.flags?.[SYSTEM_ID] ?? actor?.flags?.[SYSTEM_ID] ?? {};
  const fields = {};
  for (const flag of Object.values(TERRAIN_STAT_FIELDS)) fields[flag] = Number(flags?.[flag]) || 0;
  return Object.freeze(fields);
}

function projectUnitMoveScaling(actor) {
  const flags = actor?._source?.flags?.[SYSTEM_ID] ?? actor?.flags?.[SYSTEM_ID] ?? {};
  return normalizeMoveScaling(flags?.[UNIT_MOVE_SCALING_FLAG]);
}

/**
 * The identity terrain exceptions match a unit on. Both its token-scoped and world UUIDs are included, because a GM
 * authoring an exception pastes the world Actor's UUID while a placed unit is usually an unlinked Token that
 * reports its own.
 */
function projectTerrainProfile(actor, tokenDocument) {
  const unitTypes = TERRAIN_UNIT_TYPES.filter(type => actor.system.unitType[type] === true);
  const uuids = [
    String(actor.uuid ?? ''),
    String(tokenDocument?.baseActor?.uuid ?? actor.token?.baseActor?.uuid ?? ''),
    actor.id ? `Actor.${actor.id}` : ''
  ];
  return normalizeTerrainProfile({
    name: String(actor.name ?? ''),
    actorType: String(actor.system.faction.role ?? ''),
    unitTypes,
    uuids
  });
}

/* -------------------------------------------- */
/*  Aura modifiers                              */
/* -------------------------------------------- */
/**
 * Every aura modifier on a unit's Items whose aura is enabled with a range, read from the Items' saved data. Each
 * modifier's `quantity` and `conditionTree` still point into that saved data, so readers must not change them.
 */
function projectAuraEmissions(actor) {
  const emissions = [];
  for (const item of collectionValues(actor?.items)) {
    const source = item?._source?.system ?? item?.system ?? {};
    if (source.aura?.enabled !== true) continue;
    const range = Number(source.aura?.rng) || 0;
    if (range <= 0) continue;
    for (const modifier of source.modifiers ?? []) {
      if (modifier?.kind !== 'aura') continue;
      emissions.push(Object.freeze({
        itemId: String(item.id ?? ''),
        itemUuid: String(item.uuid ?? ''),
        itemName: String(item.name ?? ''),
        range,
        conditional: hasConditionTree(modifier.conditionTree),
        modifier: Object.freeze({
          name: String(modifier.name ?? ''),
          target: String(modifier.target ?? ''),
          quantity: modifier.quantity,
          conditionTree: modifier.conditionTree ?? null,
          stackable: modifier.stackable === true,
          targetType: String(modifier.targetType ?? 'All')
        }),
        item: hasConditionTree(modifier.conditionTree) ? projectEmissionItem(item) : null
      }));
    }
  }
  return Object.freeze(emissions);
}

/** A copy of an Item, with its prepared system data, for a conditional aura's conditions to read. */
function projectEmissionItem(item) {
  return Object.freeze({
    id: String(item.id ?? ''),
    uuid: String(item.uuid ?? ''),
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    system: detachedSystem(item.system)
  });
}

/* -------------------------------------------- */
/*  Condition values                            */
/* -------------------------------------------- */
/** A unit without its Actor, with its condition values when any aura on the Scene is conditional. */
function detachUnit(unit, conditional) {
  const { document, ...projected } = unit;
  return Object.freeze({ ...projected, facts: conditional ? projectUnitFacts(document) : null });
}

/** detachUnit with `facts` built on its first read and kept for later ones. */
function detachUnitLazily(unit, conditional) {
  const { document, ...projected } = unit;
  let facts;
  Object.defineProperty(projected, 'facts', {
    enumerable: true,
    get: () => {
      if (facts === undefined) facts = conditional ? projectUnitFacts(document) : null;
      return facts;
    }
  });
  return Object.freeze(projected);
}

/** A deep copy of an Item's prepared system data. */
function detachedSystem(system) {
  if (!system) return null;
  return structuredClone(system.toObject?.(false) ?? system);
}

/* -------------------------------------------- */
/*  Token helpers                               */
/* -------------------------------------------- */
function projectSprite(tokenDocument, actor) {
  const texture = String(tokenDocument?.texture?.src ?? '');
  if (texture && !/\.(?:webm|mp4|m4v|ogv)$/i.test(texture)) return texture;
  return String(actor?.img ?? '');
}

/**
 * A token's footprint in grid cells from its saved position (`_source`). Foundry copies each animation frame into
 * the live document, so during a move it holds a square on the way. Dividing pixels by the grid size by hand is safe
 * because hooks/scene.mjs keeps every Scene at padding 0 on a square or gridless grid.
 */
function projectFootprint(tokenDocument, gridSize) {
  const source = tokenDocument._source ?? tokenDocument;
  const unit = tokenDocument.actor?.type === CHARACTER_TYPE;
  return Object.freeze({
    x: Math.floor(Number(source.x ?? tokenDocument.x) / gridSize),
    y: Math.floor(Number(source.y ?? tokenDocument.y) / gridSize),
    width: tokenDimension(source.width ?? tokenDocument.width, unit),
    height: tokenDimension(source.height ?? tokenDocument.height, unit)
  });
}

/**
 * A unit stands on at most MAX_TOKEN_DIMENSION squares by rule. A fixture Token, such as a Destructible, covers
 * exactly the squares the Scene gives it, so a long wall occupies and can be aimed at over its whole length.
 */
function tokenDimension(value, unit) {
  const dimension = Math.max(1, Math.round(Number(value) || 1));
  return unit ? Math.min(MAX_TOKEN_DIMENSION, dimension) : dimension;
}

/* -------------------------------------------- */
/*  Targeting board                             */
/* -------------------------------------------- */

/**
 * Every token on a Scene with its cells, faction and target kind, from saved positions, so the targeting rules can
 * accept, redirect or refuse a pick. A hidden fixture (fixtureHidden in game/objects/rules.mjs) is left off, so no
 * pick, area or interaction finds it.
 * @param {Scene} [scene] Scene to read. Defaults to the Scene on screen.
 * @returns {{units: readonly object[]}|null} Frozen result, or null when there is no Scene.
 */
export function projectTargetingBoard(scene = globalThis.canvas?.scene) {
  if (!scene?.tokens) return null;
  const gridSize = Number(scene.grid?.size) || 1;
  const elevations = readTerrainElevations(scene);
  const parties = readPartyState();
  const units = [];
  for (const tokenDocument of collectionValues(scene.tokens)) {
    const unit = projectTargetableUnit(tokenDocument, gridSize, elevations, parties);
    if (unit) units.push(unit);
  }
  return Object.freeze({ gridSize, units: Object.freeze(units), explorationActive: sceneExplorationActive(scene) === true });
}

function projectTargetableUnit(tokenDocument, gridSize, elevations, parties) {
  const actor = tokenDocument.actor ?? null;
  if (!actor) return null;
  if (fixtureHidden({ documentType: actor.type, hidden: tokenDocument.hidden })) return null;
  const system = actor.system ?? {};
  const { x, y, width, height } = projectFootprint(tokenDocument, gridSize);
  const cells = [];
  for (let column = 0; column < width; column += 1) {
    for (let row = 0; row < height; row += 1) cells.push(Object.freeze({ x: x + column, y: y + row }));
  }
  const objectType = String(system.objectType ?? '');
  const targetKind = resolveTargetKind({ documentType: actor.type, objectType });
  const stance = finite(system.resources?.stn?.value, null);
  return Object.freeze({
    tokenUuid: String(tokenDocument.uuid ?? ''),
    actorUuid: String(actor.uuid ?? ''),
    name: String(actor.name ?? tokenDocument.name ?? ''),
    actorType: String(actor.type ?? ''),
    objectType,
    faction: String(system.faction?.role ?? 'Neutral'),
    combatant: actor.type === CHARACTER_TYPE,
    targetKind,
    destroyed: targetKind === TARGET_KINDS.DESTRUCTIBLE && (Number(stance) || 0) <= 0,
    fixture: OBJECT_FIXTURE_TYPES.includes(objectType),
    locked: system.locked !== false,
    stance,
    x,
    y,
    cells: Object.freeze(cells),
    elevation: footprintTerrainElevation({ x, y, width, height }, elevations),
    airborne: isAirborneActor(actor),
    hidden: tokenDocument.hidden === true,
    /** The base Actor id, so support rules can match bonds on unlinked Tokens, and the unit's party. */
    baseActorId: String(actor.isToken ? (actor.token?.actorId ?? actor.id) : actor.id ?? ''),
    partyId: projectActorPartyId(actor, parties) ?? '',
    rallied: [...(actor.effects ?? [])]
      .some(effect => effect?.disabled !== true && Boolean(effect?.flags?.[SYSTEM_ID]?.rally))
  });
}

/* -------------------------------------------- */
/*  Movement position                           */
/* -------------------------------------------- */
/**
 * Where a finished Foundry token movement ended, in scene pixels.
 * @param {object} tokenDocument Foundry Token document that moved.
 * @param {object} [movement] Foundry movement operation reported with the update.
 * @returns {{x: number, y: number}|null} Final position, or `null` when neither source is readable.
 */
export function projectFoundryMovementPosition(tokenDocument, movement = null) {
  const destination = movement?.destination ?? null;
  const x = Number(destination?.x ?? tokenDocument?.x);
  const y = Number(destination?.y ?? tokenDocument?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Which kind of input moved a token (a drag, the keyboard, the system or a restore), read from Foundry's update
 * options.
 * @param {object} tokenDocument Foundry Token document being updated.
 * @param {object} [options] Foundry update options.
 * @returns {string} One of MOVEMENT_INPUT_KINDS.
 */
export function projectFoundryMovementInput(tokenDocument, options = {}) {
  if (options.emblemMovementRestore === true) return MOVEMENT_INPUT_KINDS.RESTORE;
  if (options.emblemMovementPreview === true) return MOVEMENT_INPUT_KINDS.KEYBOARD;

  const tokenId = tokenDocument?.id ?? tokenDocument?._id;
  const method = options?._movement?.[tokenId]?.method
    ?? options?.movement?.[tokenId]?.method
    ?? options?.method;
  if (method === 'dragging') return MOVEMENT_INPUT_KINDS.MOUSE_DRAG;
  if (method === 'keyboard') return MOVEMENT_INPUT_KINDS.KEYBOARD;
  if (method === 'api') return MOVEMENT_INPUT_KINDS.SYSTEM;
  return MOVEMENT_INPUT_KINDS.UNKNOWN;
}

/* -------------------------------------------- */
/*  Measured unit board                         */
/* -------------------------------------------- */

/**
 * Every token on a Scene as the Enemy AI reads it, in grid cells: units with their stats, statuses, turn state and
 * pending phase damage, and objects. The Enemy AI reads it as game.emblemRpg.api.encounters.getBoard. A hidden
 * fixture is left off, except a hidden Destructible, which still blocks movement and stays on with `hidden` set.
 * Each unit's `occupiesLanding` is resolveMovementOccupancy's, false for anything movement passes straight through.
 * @param {string} [sceneUuid] Scene to read, defaulting to the displayed one.
 * @returns {import('../../../api/types.mjs').UnitBoard|null} Null when the Scene can't be found.
 */
export function projectUnitBoard(sceneUuid = '') {
  const scene = resolveViewedScene(sceneUuid);
  if (!scene?.tokens) return null;
  const gridSize = Number(scene.grid?.size) || 1;
  const state = projectEncounterState(String(scene.uuid ?? ''));
  const units = [];
  for (const tokenDocument of collectionValues(scene.tokens)) {
    const unit = projectMeasuredUnit(tokenDocument, gridSize);
    if (unit) units.push(unit);
  }
  return Object.freeze({
    sceneUuid: String(scene.uuid ?? ''),
    gridSize,
    columns: Math.ceil((Number(scene.width) || 0) / gridSize),
    rows: Math.ceil((Number(scene.height) || 0) / gridSize),
    phase: String(state?.phase ?? ''),
    round: Number(state?.round) || 1,
    encounterActive: state?.encounterActive === true,
    exploration: state?.exploration === true,
    classicFlyers: worldClassicFlyerTargeting(),
    flightForbidden: projectFlightForbidden(scene),
    units: Object.freeze(units)
  });
}

function projectMeasuredUnit(tokenDocument, gridSize) {
  const actor = tokenDocument.actor ?? null;
  if (!actor) return null;
  const system = actor.system ?? {};
  const presence = { documentType: actor.type, objectType: system.objectType, hidden: tokenDocument.hidden };
  if (fixtureHiddenFromMovement(presence)) return null;
  const footprint = projectFootprint(tokenDocument, gridSize);
  const statuses = projectActorStatusKeys(actor);
  const destructible = isDestructibleActor(actor);
  const stance = finite(system.resources?.stn?.value);
  const guarder = redirectFoundryHostileToken(tokenDocument);
  return Object.freeze({
    tokenUuid: String(tokenDocument.uuid ?? ''),
    tokenId: String(tokenDocument.id ?? ''),
    actorUuid: String(actor.uuid ?? ''),
    actorId: String(actor.id ?? ''),
    name: String(actor.name ?? tokenDocument.name ?? ''),
    img: String(tokenDocument.texture?.src ?? actor.img ?? ''),
    documentType: String(actor.type ?? ''),
    isCharacter: actor.type === CHARACTER_TYPE,
    destructible,
    destroyed: destructible && stance < 1,
    objectType: String(system.objectType ?? ''),
    factionRole: String(system.faction?.role ?? 'Neutral'),
    factionGroup: String(factionGroup(system.faction?.role) ?? ''),
    hidden: tokenDocument.hidden === true,
    // Whether the token shows on the calling client's canvas, so it depends on that client's vision. True when the
    // Scene isn't drawn there.
    visible: tokenDocument.object?.visible !== false,
    x: footprint.x,
    y: footprint.y,
    width: footprint.width,
    height: footprint.height,
    sort: finite(tokenDocument.sort),
    hp: finite(system.resources?.hp?.value),
    hpMax: finite(system.resources?.hp?.max),
    stance,
    stanceMax: finite(system.resources?.stn?.max),
    stanceRegen: stanceRecoveryAmount({ ...system.resources?.stn, regen: system.stats?.stnRegen?.total }),
    wit: finite(system.stats?.wit?.total),
    critMultiplier: finite(system.stats?.critDmg?.total) || 2,
    movement: finite(system.stats?.mov?.total),
    statuses: Object.freeze([...statuses]),
    flanked: statuses.has('flanked') || system.statuses?.flanked === true,
    hasOutflank: passiveFlag(actor, 'outflank'),
    airborne: isAirborneActor(actor),
    stanceBroken: isStanceBrokenActor(actor),
    flying: system.unitType?.flying === true,
    grounded: system.statuses?.grounded === true,
    levitating: system.combat?.levitation === true,
    groundedByStanceBreak: actor.flags?.[SYSTEM_ID]?.[GROUNDED_BY_STANCE_BREAK_FLAG] === true,
    canTakeOff: flightActionTakesOff(tokenDocument, actor),
    mounted: system.statuses?.mounted === true,
    silenced: statuses.has('silenced') || system.statuses?.silenced === true,
    turn: projectMeasuredTurn(system),
    tauntedByActorUuid: tauntedByActorUuid(actor),
    guarderTokenUuid: String(guarder?.uuid ?? tokenDocument.uuid ?? ''),
    sanctuary: statuses.has('sanctuary') || system.statuses?.sanctuary === true,
    sneaking: statuses.has('sneak') || system.statuses?.sneak === true,
    lure: tokenDocument.flags?.[SYSTEM_ID]?.[LURE_FLAG] === true,
    // The actor uuid of the unit whose effect spawned this token; empty for a token that wasn't summoned.
    summonedBy: String(tokenDocument.flags?.[SYSTEM_ID]?.[SUMMONED_BY_FLAG] ?? ''),
    passing: system.statuses?.passing === true,
    passable: system.statuses?.passable === true,
    blocksFlyers: system.blockFlyers === true,
    occupiesLanding: occupiesLanding(actor, tokenDocument),
    pendingPhaseDamage: projectPendingPhaseDamage(actor)
  });
}

/**
 * Whether the flight action would take this unit off now: a grounded flier the rule in planFlightToggle
 * (game/movement/input-policy.mjs) lets rise, on a map that allows flight, with its stance whole and its action
 * unspent. The Enemy AI reads it before it spends a turn taking off.
 */
function flightActionTakesOff(tokenDocument, actor) {
  if (actor.type !== CHARACTER_TYPE || actor.system?.statuses?.grounded !== true) return false;
  return planFlightToggle({
    flying: actor.system?.unitType?.flying === true,
    levitating: actor.system?.combat?.levitation === true,
    grounded: true,
    permission: normalizeMovementPermission(tokenDocument.parent?.getFlag?.(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG)),
    stanceBroken: isStanceBrokenActor(actor),
    actionAvailable: actor.system?.turn?.actionAvailable !== false
  }).ok === true;
}

function projectMeasuredTurn(system) {
  const turn = system.turn ?? {};
  return Object.freeze({
    actionAvailable: turn.actionAvailable !== false,
    bonusActionAvailable: turn.bonusActionAvailable !== false,
    movementAvailable: turn.movementAvailable !== false,
    movementSpent: finite(turn.movementSpent),
    turnComplete: unitTurnComplete(turn),
    extraActionsRemaining: finite(system.special?.extraActions?.value),
    extraActionUsed: turn.extraActionUsed === true
  });
}

/** The damage the unit's statuses will deal it when the next phase opens, averaged rather than rolled. */
function projectPendingPhaseDamage(actor) {
  const system = actor.system ?? {};
  return expectedPhaseStartDamage({
    actorType: String(system.faction?.role ?? ''),
    statuses: {
      poisoned: system.statuses?.poisoned === true || actorCarriesStatus(actor, 'Poisoned'),
      corpseRot: actorCarriesStatus(actor, 'CorpseRot')
    },
    effects: collectionValues(actor.effects).map(effect => Object.freeze({
      id: String(effect.id ?? ''),
      name: String(effect.name ?? ''),
      stackCount: Math.max(1, Math.floor(Number(effect.flags?.[SYSTEM_ID]?.stackCount) || 1)),
      statuses: Object.freeze([...(effect.statuses ?? [])].map(String)),
      dotCanKillPlayer: typeof effect.flags?.[SYSTEM_ID]?.dotCanKillPlayer === 'boolean'
        ? effect.flags[SYSTEM_ID].dotCanKillPlayer : undefined
    }))
  }, { hp: finite(system.resources?.hp?.value), average: averageFormulaValue });
}

function actorCarriesStatus(actor, statusId) {
  const wanted = String(statusId).toLowerCase();
  return collectionValues(actor?.effects).some(effect => effect.disabled !== true
    && [...(effect.statuses ?? [])].some(status => String(status).toLowerCase() === wanted));
}

/* -------------------------------------------- */
/*  Ground measurement                          */
/* -------------------------------------------- */

/**
 * The terrain evasion, defense and resistance bonuses a unit would get on a square it is considering, or where it
 * stands. Read by game.emblemRpg.api.terrain.modifiersAt and by hypotheticalGround in attack-targeting.mjs.
 * @param {{tokenUuid?: string, standing?: {x: number, y: number}|null}} [intent]
 * @returns {Readonly<{eva: number, def: number, res: number}>|null}
 */
export function projectTerrainModifiersAt({ tokenUuid = '', standing = null } = {}) {
  const ground = measuredGround(tokenUuid, standing);
  if (!ground) return null;
  const modifiers = terrainStatModifiers(
    readTerrainGrid(ground.scene), terrainFootprintCells(ground.footprint), ground.profile
  );
  return Object.freeze({ eva: modifiers.evasionMod, def: modifiers.defMod, res: modifiers.resMod });
}

/**
 * The net HP change terrain hazards would give a unit when a phase opens, on a square it is considering or where
 * it stands: healing minus the damage left after its defenses. Read by game.emblemRpg.api.terrain.hazardAt.
 * @param {{tokenUuid?: string, standing?: {x: number, y: number}|null}} [intent]
 * @returns {number|null}
 */
export function projectTerrainHazardAt({ tokenUuid = '', standing = null } = {}) {
  const ground = measuredGround(tokenUuid, standing);
  if (!ground) return null;
  const scan = scanTerrainImpacts(
    readTerrainGrid(ground.scene), terrainFootprintCells(ground.footprint), ground.profile
  );
  if (!scan) return 0;
  const system = ground.actor.system ?? {};
  const impacts = resolveTerrainImpacts(scan, {
    protections: Object.entries(system.equipment?.prots ?? {})
      .filter(([, enabled]) => enabled === true).map(([type]) => type),
    defense: finite(system.stats?.def?.total),
    resistance: finite(system.stats?.res?.total)
  });
  const healed = finite(impacts.heal?.hp);
  const hp = Math.min(finite(system.resources?.hp?.max), finite(system.resources?.hp?.value) + healed);
  const capped = capTerrainDamage(impacts.damage, { hp, actorType: String(system.faction?.role ?? '') });
  return healed - capped.reduce((total, entry) => total + finite(entry.amount), 0);
}

/**
 * The terrain elevation under the centre square of a footprint, which is the height the rules use for the whole
 * footprint. Read by game.emblemRpg.api.terrain.elevationAt.
 * @param {{sceneUuid?: string, standing?: {x: number, y: number}|null, width?: number, height?: number}} [intent]
 * @returns {number|null}
 */
export function projectFootprintElevation({ sceneUuid = '', standing = null, width = 1, height = 1 } = {}) {
  const scene = resolveViewedScene(sceneUuid);
  if (!scene || !standing) return null;
  return footprintTerrainElevation({
    x: Math.floor(finite(standing.x)),
    y: Math.floor(finite(standing.y)),
    width: Math.max(1, Math.round(finite(width) || 1)),
    height: Math.max(1, Math.round(finite(height) || 1))
  }, readTerrainElevations(scene));
}

/**
 * The aura values a unit would receive on a square it is considering, or where it stands. Read by
 * game.emblemRpg.api.terrain.auraFieldsAt and by hypotheticalGround in attack-targeting.mjs.
 * @param {{tokenUuid?: string, standing?: {x: number, y: number}|null}} [intent]
 * @returns {Readonly<Record<string, number>>|null}
 */
export function projectAuraFieldsAt({ tokenUuid = '', standing = null } = {}) {
  const measured = measuredAuraBoard(tokenUuid);
  if (!measured) return null;
  const { board, receiver, elevations } = measured;
  return auraFieldsOn(standing ? relocateAuraBoard(board, receiver, standing, elevations) : board, receiver);
}

/**
 * The aura values a unit would receive on each of several squares, from one read of the Scene's auras. Read by
 * game.emblemRpg.api.terrain.auraFieldsAtMany.
 * @param {{tokenUuid?: string, standings?: readonly {x: number, y: number}[]}} [intent]
 * @returns {Readonly<Record<string, Readonly<Record<string, number>>>>|null} Fields by `x,y` cell key.
 */
export function projectAuraFieldsAtMany({ tokenUuid = '', standings = [] } = {}) {
  const measured = measuredAuraBoard(tokenUuid);
  if (!measured) return null;
  const { board, receiver, elevations } = measured;
  const fieldsByCell = {};
  for (const standing of Array.isArray(standings) ? standings : []) {
    if (!standing) continue;
    const x = Math.floor(finite(standing.x));
    const y = Math.floor(finite(standing.y));
    const key = `${x},${y}`;
    if (key in fieldsByCell) continue;
    fieldsByCell[key] = auraFieldsOn(relocateAuraBoard(board, receiver, { x, y }, elevations), receiver);
  }
  return Object.freeze(fieldsByCell);
}

/** projectLiveAuraBoard for a unit's Scene, with the unit's token uuid and the Scene's elevations for moving it. */
function measuredAuraBoard(tokenUuid) {
  const token = resolveSync(String(tokenUuid ?? ''), 'Token');
  const scene = token?.parent ?? null;
  if (!token?.actor || !scene) return null;
  const board = projectLiveAuraBoard(scene);
  if (!board) return null;
  return { board, receiver: String(token.uuid ?? ''), elevations: readTerrainElevations(scene) };
}

/** Every aura attribute summed for one receiver. */
function auraFieldsOn(board, receiver) {
  const fields = {};
  for (const path of AURA_ATTRIBUTE_PATHS) fields[path] = 0;
  for (const contribution of collectAuraContributions(board, receiver)) {
    fields[contribution.target] += contribution.value;
  }
  return Object.freeze(fields);
}

/** Move one unit in `board` to another square, with that square's elevation, without touching the Scene. */
function relocateAuraBoard(board, tokenUuid, standing, elevations) {
  return Object.freeze({
    ...board,
    units: Object.freeze(board.units.map(unit => {
      if (unit.tokenUuid !== tokenUuid) return unit;
      const footprint = Object.freeze({
        ...unit.footprint,
        x: Math.floor(finite(standing.x)),
        y: Math.floor(finite(standing.y))
      });
      return Object.freeze({ ...unit, footprint, elevation: footprintTerrainElevation(footprint, elevations) });
    }))
  });
}

/**
 * A unit's Scene, its footprint on the square being considered (or where it stands) and its terrain profile. Only
 * Characters get terrain modifiers, so anything else reads as null.
 */
function measuredGround(tokenUuid, standing) {
  const token = resolveSync(String(tokenUuid ?? ''), 'Token');
  const actor = token?.actor ?? null;
  const scene = token?.parent ?? null;
  if (!actor || !scene || actor.type !== CHARACTER_TYPE) return null;
  const gridSize = Number(scene.grid?.size) || 1;
  const placed = projectFootprint(token, gridSize);
  const footprint = standing
    ? {
      x: Math.floor(finite(standing.x)),
      y: Math.floor(finite(standing.y)),
      width: placed.width,
      height: placed.height
    }
    : placed;
  return { token, actor, scene, footprint, profile: projectTerrainProfile(actor, token) };
}
