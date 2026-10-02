/** @layer foundry/adapters/projections */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { ARMAMENT_FLAGS } from '../../../contracts/domains/objects.mjs';
import { buildUnitFacts, withMeleeReach } from '../../../game/character/compilation.mjs';
import { DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import { factionGroup } from '../../../game/character/rules.mjs';
import {
  MOVEMENT_PERMISSION_FLAG, flyingForbidden, normalizeMovementPermission
} from '../../../game/movement/input-policy.mjs';
import { combineWeaponArtTraits, findCombatOutflanker, projectMarkedBonus } from '../../../game/combat/exchange.mjs';
import {
  activationRequiredProficiency,
  activationRequirements,
  validateActivationRequirements
} from '../../../game/items/activation.mjs';
import {
  attackShapeDistance,
  isInMeleeRange,
  reachableFootprintElevation,
  resolveEffectiveAttackRange,
  resolveEngagement,
  terrainElevationAt
} from '../../../game/targeting/attack-grid.mjs';
import { createGeometryResolver, predictGeometryApproach } from '../../../game/targeting/shapes.mjs';
import { isMagicItem } from '../../../game/effects/requirements.mjs';
import { projectGeometrySight, readTerrainElevations } from './terrain.mjs';
import { clone, persistedTokenFootprintCells, persistedTokenPosition } from '../services/host.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import { footprintCells, rectDistance } from '../../../lib/core/geometry.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';
import { worldClassicFlyerTargeting } from '../services/settings-policy.mjs';

const ATTACK_ITEM_TYPES = Object.freeze(['Weapon', 'Attack', 'Staff']);

/* -------------------------------------------- */
/*  Combat derivation context                   */
/* -------------------------------------------- */

/**
 * Run `read` with both Actors prepared as they stand in this exchange, then put them back. Each Actor is given its
 * item, its opponent, the distance, engagement and melee reach, its side and any drawn chance rolls, and is
 * re-prepared so its stats reflect them. Afterwards their earlier in-memory values are restored and they are
 * prepared again. Nothing is saved. Each side's `myTarget` is the unit it fights, whichever side opened the
 * exchange, and `isAttacking` tells the two apart. Used by the exchange snapshot and projectExchangeHealthTarget
 * (combat-exchange.mjs) and by projectPreCombatApproach below.
 * @param {object} input
 * @param {Actor} input.sourceActor The attacker.
 * @param {Actor} input.targetActor The defender.
 * @param {Item|null} input.sourceItem The weapon or Weapon Art the attacker uses.
 * @param {Item|null} input.targetItem The defender's wielded weapon.
 * @param {number} input.distance Squares between the two.
 * @param {string} [input.engagement] Melee or ranged, as resolveEngagement gives it.
 * @param {boolean} [input.inMeleeRange] Whether the two stand within reach of each other, defaulting to the
 *   distance alone when the caller has read no terrain.
 * @param {number|null} [input.movementSpent] The attacker's squares moved this turn, including the open leg of its
 *   movement plan.
 * @param {object|null} [input.sourceChanceRolls] The attacker's chance-modifier rolls an authoritative action drew,
 *   replayed by this read's preparation. Without them no chance modifier fires.
 * @param {object|null} [input.targetChanceRolls] The defender's, likewise.
 * @param {Function} read Called while the context is installed.
 * @returns {*} What `read` returns.
 */
export function withFoundryCombatContext({
  sourceActor,
  targetActor,
  sourceItem,
  targetItem,
  distance,
  engagement = '',
  inMeleeRange = isInMeleeRange({ distance }),
  movementSpent = null,
  sourceChanceRolls = null,
  targetChanceRolls = null
}, read) {
  const sourceState = captureContext(sourceActor);
  const targetState = captureContext(targetActor);
  const outerFacts = unitFactsInContext;
  try {
    installContext(sourceActor, {
      activeItem: sourceItem,
      myTarget: targetActor,
      combatDistance: distance,
      combatEngagement: engagement,
      combatInMeleeRange: inMeleeRange === true,
      combatMovementSpent: movementSpent,
      isAttacking: true,
      isDefending: false,
      isUsingWeaponArt: isWeaponArtItem(sourceItem),
      modifierChanceRolls: sourceChanceRolls
    });
    installContext(targetActor, {
      activeItem: targetItem,
      myTarget: sourceActor,
      combatDistance: distance,
      combatEngagement: engagement,
      combatInMeleeRange: inMeleeRange === true,
      combatMovementSpent: null,
      isAttacking: false,
      isDefending: true,
      isUsingWeaponArt: false,
      modifierChanceRolls: targetChanceRolls
    });
    sourceActor.reset();
    targetActor.reset();
    unitFactsInContext = new Map();
    return read();
  } finally {
    unitFactsInContext = outerFacts;
    restoreContext(sourceActor, sourceState);
    restoreContext(targetActor, targetState);
    sourceActor.reset();
    targetActor.reset();
  }
}

/**
 * A unit's condition context: what an authored condition can read about the unit and its target, the active item,
 * distance, engagement and side, from whatever withFoundryCombatContext installed on the Actor. Read by the combat,
 * encounter and item projections and by the character writer.
 */
export function projectFoundryCombatActorContext(actor) {
  if (!actor) return null;
  return shapeCombatActorContext({
    self: projectUnitFacts(actor),
    target: projectUnitFacts(actor.myTarget),
    activeItem: actor.activeItem,
    distance: actor.combatDistance,
    engagement: actor.combatEngagement,
    inMeleeRange: actor.combatInMeleeRange,
    attacking: actor.isAttacking,
    defending: actor.isDefending,
    usingWeaponArt: actor.isUsingWeaponArt
  });
}

/**
 * Project the condition contexts both sides of a hypothetical matchup read, in the shape
 * projectFoundryCombatActorContext gives a live exchange, without installing a combat context on either Actor.
 * `projectMeasuredMatchup` and `projectThreatMatchups` in attack-targeting.mjs pass each unit with the system data
 * its hypothetical compile produced, so the damage-type trees calculateCombatSide in game/combat/exchange.mjs
 * evaluates read the distance and engagement of the attack being measured, as they do in the exchange.
 * @param {object} input
 * @param {{actor: Actor, system: object, item: Item|null}} input.attacker The attacking unit, its system data for
 *   this matchup, and the Item it strikes with.
 * @param {{actor: Actor, system: object, item: Item|null}} input.defender The defending unit, likewise.
 * @param {number} input.distance Squares between the two.
 * @param {string} input.engagement The engagement resolveEngagement gives for that distance.
 * @param {boolean} input.inMeleeRange Whether the two stand within reach of each other.
 * @returns {Readonly<{attacker: object, defender: object}>}
 */
export function projectMatchupCombatContexts({ attacker, defender, distance, engagement, inMeleeRange }) {
  const attackerFacts = shapeUnitFacts(attacker.actor, attacker.system);
  const defenderFacts = shapeUnitFacts(defender.actor, defender.system);
  const shared = { distance, engagement, inMeleeRange, usingWeaponArt: false };
  return Object.freeze({
    attacker: shapeCombatActorContext({
      ...shared, self: attackerFacts, target: defenderFacts, activeItem: attacker.item, attacking: true
    }),
    defender: shapeCombatActorContext({
      ...shared, self: defenderFacts, target: attackerFacts, activeItem: defender.item, defending: true
    })
  });
}

/** Build a combatant's condition context. Live exchanges and what-if matchups both use it, so they share one shape. */
function shapeCombatActorContext({
  self: facts, target, activeItem, distance, engagement, inMeleeRange, attacking, defending, usingWeaponArt
}) {
  const reach = inMeleeRange === true;
  const self = withMeleeReach(facts, reach);
  return Object.freeze({
    ...self,
    self,
    caster: self,
    item: null,
    activeItem: projectContextItem(activeItem),
    target: withMeleeReach(target, reach),
    distance: finite(distance),
    engagement: String(engagement ?? ''),
    attacking: attacking === true,
    defending: defending === true,
    usingWeaponArt: usingWeaponArt === true
  });
}

/** Whether the Item a unit swings with is a Weapon Art rather than the weapon itself. */
function isWeaponArtItem(item) {
  return String(item?.system?.itemType ?? '') === 'Weapon Art';
}

/**
 * Unit facts built while withFoundryCombatContext or withSharedProjections runs, cached because the read asks for
 * the same unchanged facts more than once. Null outside both.
 */
let unitFactsInContext = null;

/** Item copies shared while withSharedProjections runs, by Item and then by kind of copy. Null outside one. */
let itemCopiesInScope = null;

/**
 * Run a read that projects the same unchanged units and Items many times over, such as one threat grade
 * (projectThreatMatchups in attack-targeting.mjs), sharing each unit's facts and each Item's copies until it
 * returns. The read must not write anything, since every copy it shares was taken before it ran.
 * @param {Function} read The read.
 * @returns {*} What `read` returns.
 */
export function withSharedProjections(read) {
  const outerFacts = unitFactsInContext;
  const outerCopies = itemCopiesInScope;
  unitFactsInContext ??= new Map();
  itemCopiesInScope ??= new Map();
  try {
    return read();
  } finally {
    unitFactsInContext = outerFacts;
    itemCopiesInScope = outerCopies;
  }
}

/**
 * One copy of an Item's data per withSharedProjections run, made by `copy` the first time it is asked for, or a
 * fresh copy outside a run. Callers never mutate what it returns. Read by projectGearItem and projectContextItem
 * here and by projectContextItem in characters.mjs.
 * @param {Item} item The Item copied.
 * @param {string} kind Which copy of it, since callers copy different views of the same Item.
 * @param {Function} copy Makes the copy.
 * @returns {*} The copy.
 */
export function sharedItemCopy(item, kind, copy) {
  if (!itemCopiesInScope) return copy();
  let copies = itemCopiesInScope.get(item);
  if (!copies) itemCopiesInScope.set(item, copies = new Map());
  if (!copies.has(kind)) copies.set(kind, copy());
  return copies.get(kind);
}

/**
 * One Actor as the flat facts authored conditions name (buildUnitFacts in game/character/compilation.mjs), cached
 * while a combat context or shared projection runs. The aura board and Character compilation read it.
 */
export function projectUnitFacts(actor) {
  if (!actor) return null;
  const kept = unitFactsInContext?.get(actor);
  if (kept) return kept;
  const facts = shapeUnitFacts(actor);
  unitFactsInContext?.set(actor, facts);
  return facts;
}

/**
 * Shape one Actor's facts from its system data: the live data by default, or the data a hypothetical compile
 * produced, whose equipment ids then name the gear that compile put in hand.
 */
function shapeUnitFacts(actor, system = actor.system ?? {}) {
  return Object.freeze(structuredClone(buildUnitFacts({ ...system, turn: projectCharacterTurn(actor, system.turn) }, {
    statuses: [...projectActorStatusKeys(actor)],
    name: actor.name,
    uuid: String(actor.uuid ?? ''),
    size: projectUnitSize(actor),
    gear: {
      weapon: projectGearItem(actor, 'weaponId', system),
      armor: projectGearItem(actor, 'armorId', system),
      shield: projectGearItem(actor, 'shieldId', system),
      mount: projectGearItem(actor, 'mountId', system),
      class: projectGearItem(actor, 'classId', system)
    }
  })));
}

/**
 * A unit's size as authored conditions read it (`size`, `caster.size`, `target.size`): the width in whole squares of
 * the Token it stands on, from the saved footprint the Guard bond check (FoundryGuardBondRepository.sideOf and
 * resolveGuardBond) reads, so a unit resized only on the board is judged at its board size. A unit with no placed
 * Token reads its prototype Token's width. Read by shapeUnitFacts and by projectCharacterSource in characters.mjs.
 */
export function projectUnitSize(actor) {
  const width = persistedTokenPosition(placedUnitToken(actor))?.width ?? actor.prototypeToken?.width;
  return Math.max(1, Math.floor(Number(width) || 1));
}

/**
 * The Token a unit stands on: a synthetic Actor's own Token, otherwise its linked Token on the viewed Scene, then on
 * the active Scene, then on any Scene. Null when the unit isn't placed.
 */
function placedUnitToken(actor) {
  const tokens = collectionValues(actor.getDependentTokens({ linked: true, concreteOnly: true }));
  const viewed = globalThis.canvas?.scene ?? null;
  return tokens.find(token => viewed && token.parent === viewed)
    ?? tokens.find(token => token.parent?.active === true)
    ?? tokens[0] ?? null;
}

/**
 * The unit's stored turn state, with `movementSpent` taken from the combat context while one is installed, so the
 * open leg of a movement plan counts.
 */
export function projectCharacterTurn(actor, turn) {
  const movementSpent = Number(actor?.combatMovementSpent);
  return Number.isFinite(movementSpent) ? { ...(turn ?? {}), movementSpent } : { ...(turn ?? {}) };
}

function projectGearItem(actor, key, system = actor?.system) {
  const id = system?.equipment?.[key];
  const item = id ? actor.items?.get?.(id) ?? null : key === 'weaponId' ? projectWieldedArmament(actor)?.weapon ?? null : null;
  return item ? { name: item.name, system: sharedItemCopy(item, 'gear', () => clone(item.system) ?? {}) } : null;
}

/* -------------------------------------------- */
/*  Status vocabulary                           */
/* -------------------------------------------- */

/** An authored status name or id reduced to lowercase letters and digits, the form status comparisons use. */
export function normalizeStatusKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Collect one Actor's active status keys from its effects' names, status ids, statuses, and Token statuses. */
export function projectActorStatusKeys(actor) {
  const statuses = new Set();
  for (const effect of statusCollection(actor?.effects)) {
    if (effect.disabled === true) continue;
    statuses.add(normalizeStatusKey(effect.name ?? effect.label));
    const statusId = effect.flags?.core?.statusId;
    if (typeof statusId === 'string' && statusId) statuses.add(normalizeStatusKey(statusId));
    for (const status of statusCollection(effect.statuses)) statuses.add(normalizeStatusKey(status));
  }
  for (const status of statusCollection(actor?.statuses)) statuses.add(normalizeStatusKey(status));
  return statuses;
}

function statusCollection(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === 'function') return [...collection.values()];
  return Array.from(collection);
}

/* -------------------------------------------- */
/*  Context restoration                         */
/* -------------------------------------------- */

const CONTEXT_KEYS = Object.freeze([
  'activeItem', 'myTarget', 'combatDistance', 'combatEngagement', 'combatInMeleeRange',
  'combatMovementSpent',
  'isAttacking', 'isDefending', 'isUsingWeaponArt', 'modifierChanceRolls'
]);

function captureContext(actor) {
  return Object.fromEntries(CONTEXT_KEYS.map(key => [key, {
    present: Object.prototype.hasOwnProperty.call(actor, key),
    value: actor[key]
  }]));
}

function installContext(actor, context) {
  for (const key of CONTEXT_KEYS) {
    const value = context[key];
    if (value === null) delete actor[key];
    else actor[key] = value;
  }
}

function restoreContext(actor, state) {
  for (const key of CONTEXT_KEYS) {
    if (state[key].present) actor[key] = state[key].value;
    else delete actor[key];
  }
}

function projectContextItem(item) {
  if (!item) return null;
  return sharedItemCopy(item, 'context', () => Object.freeze({
    id: item.id ?? null,
    uuid: item.uuid ?? null,
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    system: Object.freeze(clone(item.system) ?? {})
  }));
}

/* -------------------------------------------- */
/*  Pre-combat approach                         */
/* -------------------------------------------- */

/** Whether an Item's effects move its user before the attacks, which makes the attack distance a prediction. */
function movesBeforeCombat(item) {
  return (item?.system?.effects ?? []).some(entry => entry?.trigger === 'preCombat'
    && (entry.action?.steps ?? []).some(step => step?.kind === 'moveToken' && step.target === 'self'));
}

/**
 * The distance and engagement an attack is fought at. It starts from where the two units stand. When the attacking
 * Item moves its user before the attacks, it predicts where that move lands (predictGeometryApproach), evaluated
 * under the combat context at the starting distance. Called by the exchange snapshot in combat-exchange.mjs.
 * @param {object} input
 * @param {Token} input.sourceToken Attacking Token.
 * @param {Token} input.targetToken Defending Token.
 * @param {Item|null} input.activatedItem The Art or weapon installed as the attacker's active Item.
 * @param {Item|null} input.targetItem The defender's wielded Item.
 * @param {object|null} input.movement The attacker's movement snapshot, standing where it is now.
 * @param {number|null} [input.movementSpent] The attacker's squares moved this turn, as the exchange counts them.
 * @param {number} input.gridSize Pixels per grid square.
 * @param {object|null} [input.sourceChanceRolls] The attacker's drawn chance-modifier rolls, when an action drew them.
 * @param {object|null} [input.targetChanceRolls] The defender's, likewise.
 * @param {number} [input.effectRange] The attack's maximum range.
 * @param {string} [input.attackShape] The attacking weapon's targeting shape.
 * @returns {object} `boardDistance`, `boardEngagement`, `reachDistance` and `reachEngagement` (the board facts
 *   measured the way the weapon's shape aims, for the range check), the fought `distance`, `engagement` and
 *   `inMeleeRange`, and `moved`.
 */
export function projectPreCombatApproach({
  sourceToken, targetToken, activatedItem, targetItem, movement, movementSpent = null, gridSize,
  sourceChanceRolls = null, targetChanceRolls = null, effectRange = 0, attackShape = 'Cross'
}) {
  const sourceActor = sourceToken?.actor ?? null;
  const targetActor = targetToken?.actor ?? null;
  const elevations = readTerrainElevations(sourceToken?.document?.parent ?? sourceToken?.parent);
  const anchorRect = tokenGridRect(targetToken, gridSize);
  const sourceRect = tokenGridRect(sourceToken, gridSize);
  const flight = projectFlightReach(sourceToken, targetToken);
  const targetCells = anchorRect
    ? footprintCells(anchorRect.x, anchorRect.y, anchorRect.width, anchorRect.height) : null;
  /** Both elevations for an attacker at this height, with the target's read the way the targeting grid reads it. */
  const facing = sourceElevation => ({
    sourceElevation,
    targetElevation: reachableFootprintElevation({
      sourceElevation, cells: targetCells, elevations,
      fallback: tokenTerrainElevation(targetToken, gridSize, elevations)
    }),
    ...flight
  });
  const boardDistance = sourceRect && anchorRect ? rectDistance(sourceRect, anchorRect) : 0;
  const standing = { distance: boardDistance, ...facing(tokenTerrainElevation(sourceToken, gridSize, elevations)) };
  const boardEngagement = resolveEngagement(standing);
  const boardMeleeRange = isInMeleeRange(standing);
  const reachDistance = sourceRect && anchorRect ? attackShapeDistance(attackShape, sourceRect, anchorRect) : 0;
  const reachEngagement = resolveEngagement({ ...standing, distance: reachDistance });
  const board = {
    boardDistance, boardEngagement, reachDistance, reachEngagement, distance: boardDistance,
    engagement: boardEngagement, inMeleeRange: boardMeleeRange, moved: false
  };
  if (!sourceActor || !targetActor || !anchorRect || !movement?.supportedGrid || !movesBeforeCombat(activatedItem)) {
    return board;
  }
  const approach = withFoundryCombatContext({
    sourceActor, targetActor, sourceItem: activatedItem, targetItem,
    distance: boardDistance, engagement: boardEngagement, inMeleeRange: boardMeleeRange, movementSpent,
    sourceChanceRolls, targetChanceRolls
  }, () => predictGeometryApproach({
    entries: activatedItem.system?.effects ?? [],
    movement,
    anchorRect,
    context: projectFoundryCombatActorContext(sourceActor),
    budgetFacts: { totalMovement: movement.totalMovement, effectRange }
  }));
  if (!approach.moved) return board;
  const landing = { ...approach.position, width: sourceRect.width, height: sourceRect.height };
  const distance = rectDistance(landing, anchorRect);
  const arrival = { distance, ...facing(footprintTerrainElevation(landing, elevations)) };
  return {
    ...board,
    distance,
    engagement: resolveEngagement(arrival),
    inMeleeRange: isInMeleeRange(arrival),
    moved: true
  };
}

/**
 * Whether the attacker meets the authored requirements of the Item it attacks with, checked from where it stands.
 * A geometry requirement counts the placements the mover could walk to within the geometry's own budget. The
 * exchange snapshot in combat-exchange.mjs reads it.
 * @param {object} input
 * @param {Item|null} input.item The Weapon Art or weapon whose requirements apply.
 * @param {object} input.source The attacker's projected side, its `conditionSelf` and `weapon` among its facts.
 * @param {object|null} input.target The defender's projected side.
 * @param {Token} input.sourceToken Attacking Token.
 * @param {Token|null} input.targetToken Defending Token.
 * @param {object|null} input.movement The attacker's movement snapshot.
 * @param {Function} [input.targetMovement] Lazily projects the defender's movement snapshot for a target mover.
 * @param {number} input.gridSize Pixels per grid square.
 * @param {number|string} [input.effectRange] The attacker's range; its weapon's when not given.
 * @returns {Readonly<{ok: boolean, code: string, names: readonly string[]}>}
 */
export function projectAttackRequirements(input) {
  const facts = projectRequirementFacts(input);
  if (!facts.requirements.length) return Object.freeze({ ok: true, code: '', names: Object.freeze([]) });
  const verdict = validateActivationRequirements(facts);
  return Object.freeze({
    ok: verdict.ok === true,
    code: verdict.ok === true ? '' : String(verdict.code ?? ''),
    names: Object.freeze([...(verdict.data?.requirementNames ?? verdict.data?.targetNames ?? [])])
  });
}

/**
 * The facts an Item's authored requirements are checked against: the list itself, both units as placements, and
 * the resolver that counts the placements a geometry requirement could reach.
 * @param {object} input The same shape {@link projectAttackRequirements} takes.
 * @returns {object} The input `validateActivationRequirements`, `checkCaster` and `checkTargets` all read.
 */
export function projectRequirementFacts({
  item, source, target, sourceToken, targetToken, movement, targetMovement = null, gridSize,
  effectRange = source?.weapon?.range ?? ''
}) {
  const sourceRect = tokenGridRect(sourceToken, gridSize);
  const targetRect = tokenGridRect(targetToken, gridSize);
  let targetBoard;
  const resolveTerrainGeometry = createGeometryResolver({
    self: movement,
    target: () => {
      if (targetBoard === undefined) targetBoard = targetMovement?.() ?? null;
      return targetBoard;
    },
    sight: projectGeometrySight,
    effectRange,
    targetEffectRange: target?.weapon?.range ?? ''
  });
  const unit = (side, rect) => (side ? {
    conditionSelf: side.conditionSelf ?? null,
    tokenUuid: side.tokenUuid,
    tokenName: side.actorName,
    x: rect?.x ?? 0,
    y: rect?.y ?? 0,
    footprint: { width: rect?.width ?? 1, height: rect?.height ?? 1 }
  } : null);
  return {
    requirements: activationRequirements({ system: item?.system ?? {} }),
    itemType: String(item?.type ?? ''),
    requiredProficiency: activationRequiredProficiency({ system: item?.system ?? {} }),
    itemName: String(item?.name ?? ''),
    source: unit(source, sourceRect),
    targets: target ? [unit(target, targetRect)] : [],
    resolveTerrainGeometry
  };
}

/** A token's footprint in grid cells from its saved position, corner rounded down, from placeable or document. */
function tokenGridRect(token, gridSize) {
  const position = persistedTokenPosition(token);
  if (!position || !(Number(gridSize) >= 1)) return null;
  return Object.freeze({
    x: Math.floor(position.x / gridSize),
    y: Math.floor(position.y / gridSize),
    width: Math.max(1, Math.round(position.width)),
    height: Math.max(1, Math.round(position.height))
  });
}

/* -------------------------------------------- */
/*  Borrowed Armament                           */
/* -------------------------------------------- */

/**
 * The Armament token a unit has borrowed (named by its Armament flag), with the Armament's weapon built as a plain
 * attack-item shape: weapon stats, uses, animations and effects laid out like an embedded weapon, so the combat
 * rules read both the same way. Null when the flag is empty or doesn't name an Armament token.
 * @returns {{token: object, actor: object, weapon: object}|null}
 */
export function projectWieldedArmament(actor) {
  const tokenUuid = String(actor?.getFlag?.(SYSTEM_ID, ARMAMENT_FLAGS.UUID) ?? '');
  if (!tokenUuid) return null;
  let token = null;
  try { token = fromUuidSync(tokenUuid); } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'projectWieldedArmament');
    token = null;
  }
  const armament = token?.actor ?? null;
  if (token?.documentName !== 'Token' || armament?.type !== 'Object') return null;
  if (String(armament.system?.objectType ?? '') !== 'Armament') return null;
  return Object.freeze({ token, actor: armament, weapon: armamentWeaponShape(token, armament) });
}

/** Whether a weapon reference is the detached Armament shape rather than an embedded Item. */
export function isArmamentWeapon(weapon) {
  return weapon?.armament === true;
}

function armamentWeaponShape(token, armament) {
  const block = armament.system?.armament ?? {};
  const durability = block.durability ?? {};
  const infinite = durability.type === 'infinite';
  const bools = source => Object.freeze(Object.fromEntries(Object.entries(source ?? {})
    .map(([key, value]) => [key, value === true])));
  return Object.freeze({
    uuid: String(token.uuid ?? ''),
    id: '',
    name: String(armament.name ?? token.name ?? 'Armament'),
    img: String(armament.img ?? token.texture?.src ?? ''),
    type: 'Object',
    documentName: 'Actor',
    armament: true,
    armamentActorUuid: String(armament.uuid ?? ''),
    system: Object.freeze({
      itemType: 'Weapon',
      isWielded: true,
      actionType: 'Standard Action',
      wgt: Number(block.wgt) || 0,
      uses: Object.freeze({
        current: infinite ? 999 : Number(durability.value) || 0,
        max: infinite ? 999 : Number(durability.max) || 0,
        type: infinite ? 'infinite' : 'limited'
      }),
      weapon: Object.freeze({
        req: String(block.req ?? 'None'),
        rank: Number(block.rank) || 0,
        twoHanded: false,
        atkStat: String(block.atkStat ?? 'None'),
        atk: String(block.atk ?? '0'),
        brk: Number(block.brk) || 0,
        rng: String(block.rng ?? '1'),
        acc: Number(block.acc) || 0,
        crit: Number(block.crit) || 0,
        extraAttacks: Number(block.extraAttacks) || 0,
        noExtraAttacks: block.noExtraAttacks === true,
        dmgTypes: bools(block.dmgTypes),
        effectiveAgainst: bools(block.effectiveAgainst),
        breaker: bools(block.breaker),
        targetShape: String(block.targetShape ?? 'Cross'),
        targetArea: bools(block.targetArea)
      }),
      effects: Object.freeze(Array.isArray(armament.system?.effects) ? armament.system.effects : []),
      anim: Object.freeze({ ...(armament.system?.anim ?? {}) }),
      effectData: Object.freeze({ losRule: 'normal', targetType: 'Hostile', rngShape: '', gridColor: '' })
    })
  });
}

/* -------------------------------------------- */
/*  Shared combat facts                         */
/* -------------------------------------------- */

/** Whether an Item is one a unit attacks with. */
export function isAttackItem(item) {
  return ATTACK_ITEM_TYPES.includes(String(item?.system?.itemType ?? ''));
}

/** Whether an Item, or the Armament weapon shape, is magic, by isMagicItem in game/effects/requirements.mjs. */
export function isMagicItemDocument(item) {
  return isMagicItem({ type: item?.type, requiredProficiency: item?.system?.weapon?.req });
}

/** Whether an Object actor is one an attack may destroy. */
export function isDestructibleActor(actor) {
  return actor?.type === 'Object' && String(actor.system?.objectType ?? '') === 'Destructible';
}

/** The Armor a unit wears, which decides its armor stats and whether it is vulnerable to every damage type. */
export function wornArmor(actor) {
  return collectionValues(actor?.items).find(item => item.type === 'Equipment'
    && item.system?.itemType === 'Armor' && item.system?.isWorn === true) ?? null;
}

/**
 * The facts calculateCombatSide, buildCombatSequence and defenderCanCounter in game/combat/exchange.mjs read from
 * one Character. The exchange's projectSide in combat-exchange.mjs, whose snapshot the Combat Preview shows, and
 * projectCombatSide in attack-targeting.mjs, which the planner measurement and threat lines read, both start from
 * these. Each adds hit points, stance, protections and damage types from its own source.
 * @param {Actor} actor The unit, prepared under whatever withFoundryCombatContext installed.
 * @param {Item|object|null} weapon The weapon it strikes with, or the detached Armament shape.
 * @param {Item|null} [activeItem] The Weapon Art it strikes through, if any.
 * @param {object} [system] Its system data: the live data, or what a hypothetical compile produced.
 * @param {object|null} [conditionSelf] Its condition context, when the caller built one for a hypothetical matchup.
 * @returns {Readonly<object>}
 */
export function projectCombatRuleFacts(actor, weapon, activeItem = null, system = actor.system ?? {},
  conditionSelf = null) {
  const statuses = projectActorStatusKeys(actor);
  const raised = key => statuses.has(key) || system.statuses?.[key] === true;
  const passive = key => system.combat?.[key] === true;
  const armor = wornArmor(actor);
  const traits = combineWeaponArtTraits({
    extraAttacks: weapon?.system?.weapon?.extraAttacks,
    noExtraAttacks: weapon?.system?.weapon?.noExtraAttacks,
    effectiveAgainst: system.equipment?.effectiveAgainst,
    breaker: system.equipment?.breaker
  }, activeItem?.system?.itemType === 'Weapon Art' ? activeItem.system.weapon : null);
  return Object.freeze({
    actorType: String(actor.system?.faction?.role ?? 'Neutral'),
    attack: String(system.stats?.atk?.total ?? '0'),
    accuracy: finite(system.stats?.acc?.total),
    evasion: finite(system.stats?.eva?.total),
    crit: finite(system.stats?.crit?.total),
    speed: finite(system.stats?.spd?.total),
    defense: finite(system.stats?.def?.total),
    resistance: finite(system.stats?.res?.total),
    charisma: finite(system.stats?.cha?.total),
    breakDamage: finite(system.stats?.brk?.total),
    dexterity: finite(system.special?.dexterity?.value),
    extraAttacks: traits.extraAttacks,
    noExtraAttacks: traits.noExtraAttacks,
    firstStrike: passive('firstStrike') || statuses.has('firststrike'),
    cannotCounter: passive('cannotCounter')
      || Boolean(actor.getFlag?.(SYSTEM_ID, ARMAMENT_FLAGS.UUID)) || statuses.has('cannotcounter')
      || actor.system?.pacifist === true,
    counterlock: passive('counterlock') || statuses.has('counterlock'),
    impervious: passive('impervious') || statuses.has('impervious'),
    critDefenseBreak: passive('critDefenseBreak'),
    blessed: raised('blessed'),
    blinded: raised('blinded'),
    flanked: raised('flanked'),
    truestrike: raised('truestrike'),
    shine: raised('shine'),
    silenced: raised('silenced'),
    airborne: isAirborneActor(actor),
    unitTypes: Object.freeze({ ...(system.unitType ?? {}) }),
    effectiveAgainst: traits.effectiveAgainst,
    weaponAdvantages: traits.breaker,
    armor: Object.freeze({
      defense: finite(armor?.system?.armor?.def),
      resistance: finite(armor?.system?.armor?.res),
      breakReduction: finite(system.stats?.brkRed?.total),
      critReduction: finite(system.stats?.critRed?.total)
    }),
    weapon: projectWeapon(actor, weapon, system),
    damageTypeConditions: Object.freeze(projectDamageTypeConditions(weapon?.system)),
    randomizeDamageType: weapon?.system?.weapon?.dmgTypes?.randomize === true,
    conditionSelf: conditionSelf ?? projectFoundryCombatActorContext(actor),
    conditionItem: projectRuleItem(weapon)
  });
}

/**
 * The same facts for a Destructible, which defends with its Integrity alone: no weapon, no attacks, no traits and
 * no experience. projectObjectSide in combat-exchange.mjs reads it, and the Destructible preview shows that snapshot.
 * @param {Actor} actor The Destructible Object.
 * @returns {Readonly<object>}
 */
export function projectDestructibleRuleFacts(actor) {
  const system = actor.system ?? {};
  return Object.freeze({
    actorType: String(system.faction?.role ?? 'Neutral'),
    attack: '0',
    accuracy: 0,
    evasion: 0,
    crit: 0,
    speed: 0,
    defense: finite(system.stats?.def?.total),
    resistance: finite(system.stats?.res?.total),
    charisma: 0,
    breakDamage: 0,
    dexterity: 0,
    extraAttacks: 0,
    noExtraAttacks: true,
    firstStrike: false,
    cannotCounter: true,
    counterlock: false,
    impervious: false,
    critDefenseBreak: false,
    blessed: false,
    blinded: false,
    flanked: false,
    truestrike: false,
    shine: false,
    silenced: false,
    airborne: false,
    destructible: true,
    unitTypes: Object.freeze({ ...(system.unitType ?? {}) }),
    effectiveAgainst: Object.freeze({}),
    weaponAdvantages: Object.freeze({}),
    armor: Object.freeze({ defense: 0, resistance: 0, breakReduction: 0, critReduction: 0 }),
    weapon: projectWeapon(actor, null),
    damageTypes: Object.freeze([]),
    damageTypeConditions: Object.freeze({}),
    randomizeDamageType: false,
    conditionSelf: Object.freeze({ name: String(actor.name ?? ''), system: Object.freeze({}) }),
    conditionItem: projectRuleItem(null)
  });
}

/**
 * Whether an Actor is in the air. For a Character that is the airborne status compileCharacterData derives. An
 * Object has no flight state, so its flying type alone decides, and a Vendor or Convoy never flies.
 */
export function isAirborneActor(actor) {
  if (actor?.type === 'Character') return actor.system?.statuses?.airborne === true;
  return actor?.system?.unitType?.flying === true;
}

/** Whether a Character's stance is broken, a status compileCharacterData derives. Nothing else has a stance. */
export function isStanceBrokenActor(actor) {
  return actor?.type === 'Character' && actor.system?.statuses?.stanceBroken === true;
}

/**
 * The flight facts airborneBeyondMelee (game/targeting/attack-grid.mjs) checks for one attacker and target, which
 * resolveEngagement also reads beside the two elevations. Every projection that checks melee against flyers builds
 * them here. The map's flight permission comes from the target's Scene.
 */
export function projectFlightReach(sourceToken, targetToken) {
  const document = targetToken?.document ?? targetToken ?? sourceToken?.document ?? sourceToken;
  return {
    sourceAirborne: isAirborneActor(sourceToken?.actor),
    targetAirborne: isAirborneActor(targetToken?.actor),
    targetStanceBroken: isStanceBrokenActor(targetToken?.actor),
    classicFlyers: worldClassicFlyerTargeting(),
    flightForbidden: projectFlightForbidden(document?.parent)
  };
}

/** Whether a Scene's movement permission forbids flight, the map fact airborneBeyondMelee reads. */
export function projectFlightForbidden(scene) {
  return flyingForbidden(normalizeMovementPermission(scene?.getFlag?.(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG)));
}

/**
 * The range a weapon reaches in this unit's hands. The derived reach in `stats.rng` belongs to whichever weapon
 * those stats were compiled with, so the caller passes the stats of the equipment state it is asking about.
 */
function effectiveWeaponRange(system, item) {
  const base = String(item?.system?.weapon?.rng ?? '1').trim();
  const derived = String(system?.stats?.rng?.total ?? base).trim();
  return resolveEffectiveAttackRange(base, derived);
}

/**
 * A token's occupied cells from its saved position, for the attack targeting and exchange projections and the
 * flank check here. Empty when the grid size is unusable.
 */
export function tokenCells(token, gridSize) {
  if (!token || !(Number(gridSize) >= 1)) return [];
  return persistedTokenFootprintCells(token, gridSize);
}

/** Whether each side of a melee exchange is flanked by a unit with Outflank, for the exchange snapshot. */
export function boardFlanking(sourceToken, targetToken, gridSize) {
  const occupancy = sceneCombatOccupancy(sourceToken?.document?.parent ?? sourceToken?.parent, gridSize);
  return {
    source: tokenIsFlanked(sourceToken, occupancy, gridSize),
    target: tokenIsFlanked(targetToken, occupancy, gridSize)
  };
}

/**
 * Flanking with the mover placed on a square it is considering, by the same occupancy rule the exchange uses. Its
 * only caller is projectFlankingFrom in attack-targeting.mjs, which the Enemy AI planner reads as
 * game.emblemRpg.api.combat.flanking.
 * @param {object} input
 * @param {Token} input.token The mover.
 * @param {{x: number, y: number}} input.standing The square it would stand on, in grid cells.
 * @param {Token|null} input.targetToken The unit it would flank.
 * @param {number} input.gridSize Pixels per grid square.
 * @returns {Readonly<{flanks: boolean, flanked: boolean}>}
 */
export function projectHypotheticalFlanking({ token, standing, targetToken, gridSize }) {
  const scene = token?.document?.parent ?? token?.parent ?? null;
  const anchor = { x: Math.floor(finite(standing?.x)), y: Math.floor(finite(standing?.y)) };
  const occupancy = sceneCombatOccupancy(scene, gridSize, {
    tokenUuid: String((token?.document ?? token)?.uuid ?? ''), anchor
  });
  return Object.freeze({
    flanks: Boolean(targetToken) && !alreadyFlanked(targetToken)
      && tokenIsFlankedAt(targetToken, tokenAnchor(targetToken, gridSize), occupancy),
    flanked: !alreadyFlanked(token) && tokenIsFlankedAt(token, anchor, occupancy)
  });
}

/** A unit that already has the Flanked status can't be flanked again, the same rule the exchange applies. */
function alreadyFlanked(token) {
  const actor = (token?.document ?? token)?.actor ?? null;
  return projectActorStatusKeys(actor).has('flanked') || actor?.system?.statuses?.flanked === true;
}

/** Mark a side flanked on the board, recording in `exchangeFlanked` whether the exchange is what raises the status. */
export function withExchangeFlanking(side, flanked) {
  return Object.freeze({
    ...side,
    flanked: side.flanked || flanked,
    exchangeFlanked: flanked && !side.flanked
  });
}

function sceneCombatOccupancy(scene, gridSize, relocated = null) {
  const cells = new Map();
  for (const token of collectionValues(scene?.tokens)) {
    if (!token?.actor) continue;
    const moved = relocated?.tokenUuid && String(token.uuid ?? '') === relocated.tokenUuid;
    const anchor = moved ? relocated.anchor : tokenAnchor(token, gridSize);
    const entry = Object.freeze({
      tokenUuid: String(token.uuid ?? ''),
      faction: String(token.actor.system?.faction?.role ?? 'Neutral'),
      hasOutflank: passiveFlag(token.actor, 'outflank'),
      x: anchor.x,
      y: anchor.y
    });
    const footprint = moved
      ? footprintCells(anchor.x, anchor.y, finite(token.width) || 1, finite(token.height) || 1)
      : tokenCells(token, gridSize);
    for (const cell of footprint) cells.set(`${cell.x},${cell.y}`, entry);
  }
  return cells;
}

function tokenAnchor(token, gridSize) {
  const position = persistedTokenPosition(token);
  return { x: Math.floor(finite(position?.x) / gridSize), y: Math.floor(finite(position?.y) / gridSize) };
}

function tokenIsFlanked(token, occupancy, gridSize) {
  return tokenIsFlankedAt(token, tokenAnchor(token, gridSize), occupancy);
}

function tokenIsFlankedAt(token, anchor, occupancy) {
  const document = token?.document ?? token;
  const position = persistedTokenPosition(token);
  if (Math.max(1, Math.round(finite(position?.width) || 1)) !== 1
    || Math.max(1, Math.round(finite(position?.height) || 1)) !== 1) return false;
  return Boolean(findCombatOutflanker({
    x: anchor.x,
    y: anchor.y,
    faction: String(document.actor?.system?.faction?.role ?? 'Neutral'),
    occupantAt: (column, row) => occupancy.get(`${column},${row}`) ?? null
  }));
}

/** The terrain elevation under the centre of a token's saved footprint. */
export function tokenTerrainElevation(token, gridSize, elevations = null) {
  const document = token?.document ?? token;
  const position = persistedTokenPosition(token);
  if (!position || !(Number(gridSize) >= 1)) return 0;
  return footprintTerrainElevation({
    x: position.x / gridSize,
    y: position.y / gridSize,
    width: position.width,
    height: position.height
  }, elevations ?? readTerrainElevations(document.parent));
}

/** The terrain elevation at the centre square of a footprint given in grid cells. */
export function footprintTerrainElevation(footprint, elevations) {
  const width = Math.max(1, Number(footprint?.width) || 1);
  const height = Math.max(1, Number(footprint?.height) || 1);
  const x = Math.floor((Number(footprint?.x) || 0) + (width / 2));
  const y = Math.floor((Number(footprint?.y) || 0) + (height / 2));
  return terrainElevationAt(elevations, x, y);
}

/**
 * One weapon as the plain facts the previews, the exchange and the planner read. `wielderSystem` is the unit's
 * system data with this weapon in hand. It defaults to the live Actor, which is right for the weapon actually
 * equipped. A planner asking about a weapon the unit only carries passes a what-if compile instead, so the range
 * doesn't borrow the reach of the weapon equipped now.
 */
export function projectWeapon(actor, item, wielderSystem = actor?.system) {
  if (!item) return Object.freeze({ present: false, uses: Object.freeze({}) });
  const system = item.system ?? {};
  const baseRange = String(system.weapon?.rng ?? '1');
  const proficiency = String(system.weapon?.req ?? '');
  return Object.freeze({
    id: String(item.id ?? ''),
    uuid: String(item.uuid ?? ''),
    name: String(item.name ?? ''),
    image: String(item.img ?? ''),
    range: actor ? effectiveWeaponRange(wielderSystem, item) : baseRange,
    baseRange,
    proficiency,
    fixed: isArmamentWeapon(item),
    requiredRank: Math.max(0, Math.floor(Number(system.weapon?.rank) || 0)),
    magic: isMagicItemDocument(item),
    uses: Object.freeze({
      current: finite(system.uses?.current),
      max: finite(system.uses?.max),
      maximum: finite(system.uses?.max),
      infinite: system.uses?.type === 'infinite'
    }),
    present: true
  });
}

/** Project one Item as the detached facts an authored rule may read. */
export function projectRuleItem(item) {
  return Object.freeze({
    uuid: String(item?.uuid ?? ''),
    name: String(item?.name ?? ''),
    type: String(item?.type ?? ''),
    system: clone(item?.system ?? {}) ?? {}
  });
}

/** Read the weapon damage-type conditions passed to combat rule evaluation. */
export function projectDamageTypeConditions(itemSystem = {}) {
  return Object.fromEntries(DAMAGE_TYPES.map(type => [
    type,
    clone(itemSystem?.weapon?.dmgTypes?.[`${type}ConditionTree`] ?? null)
  ]));
}

/** Whether a unit has a compiled combat passive, such as canter, under `system.combat`. */
export function passiveFlag(actor, key) {
  return actor?.system?.combat?.[key] === true;
}

/** The uuid of the Actor that taunted this unit, or an empty string when it isn't taunted. */
export function tauntedByActorUuid(actor) {
  if (actor?.system?.statuses?.taunted !== true && !projectActorStatusKeys(actor).has('taunted')) return '';
  const effect = collectionValues(actor?.effects).find(candidate => (
    candidate?.disabled !== true && normalizeStatusKey(candidate.name ?? candidate.label) === 'taunted'
  ));
  return String(effect?.flags?.[SYSTEM_ID]?.tauntedBy?.actorUuid ?? '');
}

/**
 * Whether an attacker gains from an ally's Mark on the defender, and which effect grants it, so the exchange can
 * spend the Mark it actually used.
 */
export function markedAllyBonus(attacker, defender) {
  const effect = collectionValues(defender?.effects).find(candidate => (
    candidate?.disabled !== true && (
      normalizeStatusKey(candidate.name ?? candidate.label) === 'marked'
        || collectionValues(candidate.statuses).some(status => normalizeStatusKey(status) === 'marked')
    )
  ));
  const markedBy = effect?.flags?.[SYSTEM_ID]?.markedBy;
  const attackerFaction = String(attacker?.system?.faction?.role ?? 'Neutral');
  if (!effect?.id || !markedBy?.actorUuid || markedBy.actorUuid === attacker?.uuid) {
    return { applied: false };
  }
  const group = factionGroup(attackerFaction);
  if (group === null || group === 'neutral' || group !== factionGroup(markedBy.actorType)) {
    return { applied: false };
  }
  return { applied: true, actorUuid: defender.uuid, effectId: effect.id };
}

/**
 * Add an ally's Mark bonuses to a combat side. projectMarkedBonus in game/combat/exchange.mjs decides what the Mark
 * is worth, and the effect's identity is kept beside it so settlement can spend the Mark this side actually used.
 */
export function withMarkedBonus(side, bonus) {
  return Object.freeze({
    ...side,
    ...projectMarkedBonus(bonus.applied),
    markedEffect: bonus.applied ? Object.freeze({ actorUuid: bonus.actorUuid, effectId: bonus.effectId }) : null
  });
}

/**
 * The heal-echo policies on a unit's Items, for combat settlement and item activation. A policy names the healing it
 * echoes by Item name (`items`), by kind (`sources`), or both, and resolveHealEchoAmount in game/effects/planning.mjs
 * matches them. A policy naming neither, or with no positive fraction, echoes nothing and is dropped.
 */
export function projectHealEchoPolicies(actor) {
  const policies = [];
  for (const item of collectionValues(actor?.items)) {
    const policy = item.flags?.[SYSTEM_ID]?.healEcho;
    const items = Array.isArray(policy?.items) ? policy.items.map(String).filter(Boolean) : [];
    const sources = Array.isArray(policy?.sources) ? policy.sources.map(String).filter(Boolean) : [];
    if (!items.length && !sources.length) continue;
    const fraction = Number(policy.fraction);
    if (!Number.isFinite(fraction) || fraction <= 0) continue;
    policies.push(Object.freeze({
      items: Object.freeze(items),
      sources: Object.freeze(sources),
      fraction
    }));
  }
  return policies;
}

/* -------------------------------------------- */
/*  Weapon proficiency                          */
/* -------------------------------------------- */

/** Project earned and compiled proficiency, experience and multiplier for combat rules and progression. */
export function projectProficiency(actor, weapon) {
  return projectProficiencyByKey(actor, weapon?.system?.weapon?.req);
}

/**
 * Every proficiency's compiled total, by key, from the system data given: the Combat Preview's weapon switcher
 * offers only the weapons these ranks allow. projectSide in combat-exchange.mjs reads them under the exchange's
 * combat context, and projectCombatSide in attack-targeting.mjs from a hypothetical compile.
 */
export function projectProficiencyTotals(system) {
  return Object.freeze(Object.fromEntries(Object.entries(system?.prof ?? {})
    .map(([key, value]) => [key, Number(value?.total) || 0])));
}

/**
 * One weapon proficiency by key: the earned base, the compiled total, the banked experience, the best experience
 * multiplier the unit carries for it, and the rank thresholds. projectProficiency reads the key from a weapon, and
 * the downtime roster in downtime.mjs reads every key for a training session.
 */
export function projectProficiencyByKey(actor, proficiencyKey) {
  const key = String(proficiencyKey ?? '').toLowerCase();
  const node = actor.system?.prof?.[key] ?? {};
  return Object.freeze({
    key,
    base: finite(actor._source?.system?.prof?.[key]?.base ?? node.base),
    total: finite(node.total),
    xp: finite(node.xp),
    multiplier: weaponExperienceMultiplier(actor, key),
    maxE: finite(node.maxE) || 50,
    maxD: finite(node.maxD) || 50,
    maxC: finite(node.maxC) || 75,
    maxB: finite(node.maxB) || 100,
    maxA: finite(node.maxA) || 125,
    maxS: finite(node.maxS) || 150
  });
}

function weaponExperienceMultiplier(actor, key) {
  if (!key) return 1;
  let best = 1;
  for (const item of collectionValues(actor.items)) {
    const bonus = item.flags?.[SYSTEM_ID]?.weaponXpBonus;
    const types = Array.isArray(bonus?.types) ? bonus.types : [];
    if (!types.some(type => String(type).toLowerCase() === key)) continue;
    const multiplier = Number(bonus.multiplier);
    if (Number.isFinite(multiplier) && multiplier > best) best = multiplier;
  }
  return best;
}
