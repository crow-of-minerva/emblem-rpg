/** @layer game/items */
import { COMBAT_CONTINUATIONS, MELEE_ELEVATION_REACH } from '../../contracts/domains/combat.mjs';
import {
  EXPLORATION_ACTIVATION_SUBTYPES,
  FORCED_MOVEMENT_ABILITIES,
  MELEE_REACH_ABILITIES,
  ITEM_ACTIVATION_SUPPORT,
  ITEM_ACTIVATION_TRIGGERS,
  PROFICIENCY_RANK_LETTERS,
  retractableAllowed
} from '../../contracts/domains/items.mjs';
import { RALLY_GRANT_KEY } from '../../contracts/domains/progression.mjs';
import { GROWTH_KEYS, PROFICIENCIES, STATS } from '../../contracts/domains/characters.mjs';
import { areFactionsFriendly, resolveActionLosRule, targetTypeAdmits } from '../character/rules.mjs';
import { canRallyTarget, rallyCasterFacts } from '../support/rules.mjs';
import { turnContinuation } from '../combat/exchange.mjs';
import {
  airborneBeyondMelee,
  calculateAttackTilesFromPosition,
  filterElevationReach,
  footprintHeightBlocked,
  heightOccludedCells,
  parseAttackRange,
  pruneCellsBySight
} from '../targeting/attack-grid.mjs';
import {
  footprintCellKeys,
  generateAdjacentCells,
  generateConeCells,
  generateLineCells,
  generateLocationCells,
  resolveConeAim,
  resolveLineRay,
  selectUnitsInCells
} from '../targeting/shapes.mjs';
import { sanctuaryBlocksPick } from '../targeting/sanctuary.mjs';
import { evaluateScaling, isScalingActive } from './rules.mjs';
import { checkCaster, checkTargets } from '../effects/requirements.mjs';
import { holdsProficiencyRank } from '../progression/rules.mjs';
import { resolveForcedStep } from '../movement/pathfinding.mjs';
import { FORCED_STEP_OUTCOMES } from '../../contracts/domains/terrain.mjs';
import { ON_CAST_CONDITION, USING_ABILITY_CONDITION } from '../../contracts/domains/tokens.mjs';
import { cellKeyOf } from '../../lib/core/geometry.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { triggerGroupForItem } from '../../contracts/dsl/effects.mjs';

/* -------------------------------------------- */
/*  Activation vocabulary                       */
/* -------------------------------------------- */

const MOUNT_SUBTYPE = 'Mount';
const MOUNT_STAT_ROWS = Object.freeze([
  Object.freeze({ key: 'mov', label: 'Mov', attribute: 'mov' }),
  Object.freeze({ key: 'hp', label: 'HP', attribute: 'hpMax' }),
  Object.freeze({ key: 'stn', label: 'Stn', attribute: 'stnMax' }),
  Object.freeze({ key: 'eva', label: 'Eva', attribute: 'eva' }),
  Object.freeze({ key: 'atk', label: 'Atk', attribute: 'atk' }),
  Object.freeze({ key: 'spd', label: 'Spd', attribute: 'spd' }),
  Object.freeze({ key: 'acc', label: 'Acc', attribute: 'acc' }),
  Object.freeze({ key: 'crit', label: 'Crit', attribute: 'crit' })
]);
const FORMULA_TRAILING_SUM = /^(.*?)([+-]\d+)$/;
const ON_CAST_SUBTYPES = new Set(['Staff (U)', 'Utility']);
const CONSUMABLE_DOCUMENT_TYPE = 'Consumable';
const SPELL_DOCUMENT_TYPE = 'Spell';
const ACTIVATED_STAFF_SUBTYPE = 'Staff (U)';
const CANTER_STAFF_SUBTYPES = new Set(['Staff', ACTIVATED_STAFF_SUBTYPE]);
const SPELL_RANK_MET = Object.freeze({ ok: true });
const BOOSTER_SUBTYPE = 'Booster';
const BOOSTER_STAT_KEYS = Object.freeze(['hpMax', 'stnMax', 'mov', 'bld', 'mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res']);
const BOOSTER_RESOURCE_OF = Object.freeze({ hpMax: 'hp', stnMax: 'stn' });
const BOOSTER_STATS = Object.freeze(BOOSTER_STAT_KEYS.map(key => {
  const stat = STATS.find(entry => entry.key === key);
  return Object.freeze({ key, label: stat.short, growth: stat.growth ?? null, resource: BOOSTER_RESOURCE_OF[key] ?? null });
}));
const BOOSTER_GROWTHS = Object.freeze(GROWTH_KEYS.map(key => {
  const stat = STATS.find(entry => entry.growth === key);
  return Object.freeze({ key, label: stat.short });
}));
const BOOSTER_LIST_SEPARATOR = /[,\s]+/;
const AIMED_RNG_TYPES = new Set(ITEM_ACTIVATION_SUPPORT.aimedRngTypes);
const DERIVED_TARGET_RNG_TYPES = new Set(['Line', 'Area', 'Location', 'Cone']);
const ACTIVATION_TRIGGER_SET = new Set(ITEM_ACTIVATION_TRIGGERS);

/** Whether an item is used through item activation rather than as an attack: Consumables and activation subtypes. */
export function isActivationItem(item = {}) {
  return triggerGroupForItem({ type: String(item.type ?? ''), itemType: String(item.system?.itemType ?? '') }) === 'B';
}

/** The activation trigger set an authored entry must name to run on a use. */
export function activationTriggers() {
  return ITEM_ACTIVATION_TRIGGERS;
}

/**
 * Whether an item's activation entries deal damage, searching conditional branches too. deriveActivationEnvelope
 * uses it to decide whether the item can strike Destructibles.
 * @param {readonly object[]} entries The Item's authored `effects` entries.
 * @returns {boolean}
 */
function activationDealsDamage(entries = []) {
  return (Array.isArray(entries) ? entries : []).some(entry => (
    ACTIVATION_TRIGGER_SET.has(String(entry?.trigger ?? '')) && stepsDealDamage(entry?.action?.steps)
  ));
}

function stepsDealDamage(steps) {
  return (Array.isArray(steps) ? steps : []).some(step => step?.kind === 'damage'
    || (step?.kind === 'if' && (stepsDealDamage(step.then) || stepsDealDamage(step.else))));
}

/* -------------------------------------------- */
/*  Activation settings                         */
/* -------------------------------------------- */

/**
 * An item's targeting, cost and roll settings, read once from its data for the checks below, which call the result
 * the envelope. foundry/adapters/projections/items.mjs builds it for the targeting controls and
 * engine/items/activation.mjs.
 * @param {object} input Plain Item data plus the owner's system, for range scaling.
 * @returns {object} Either the frozen `{ok: true, ...envelope}` or `{ok: false, code}`.
 */
export function deriveActivationEnvelope(input = {}) {
  const item = input.item ?? {};
  const system = item.system ?? {};
  if (!isActivationItem(item)) return refusal(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);
  const effectData = system.effectData;
  if (!effectData) return refusal(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);

  const rngType = String(effectData.rngType ?? 'Single');
  if (!ITEM_ACTIVATION_SUPPORT.rngTypes.includes(rngType)) return refusal(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);
  const actionType = isBoosterItem(item) ? 'Standard Action' : String(system.actionType ?? 'Standard Action');
  if (!ITEM_ACTIVATION_SUPPORT.actionTypes.includes(actionType)) return refusal(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);
  const authoredLosRule = String(effectData.losRule ?? 'normal');
  if (!ITEM_ACTIVATION_SUPPORT.losRules.includes(authoredLosRule)) {
    return refusal(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);
  }
  const losRule = resolveActionLosRule(authoredLosRule, input.ownerFreeTargeting);

  const scaledRange = String(evaluateActivationRange(input.ownerSystem, effectData, { name: item.name, system }));
  const range = parseAttackRange(scaledRange);
  if (!range || range.minRange < 0 || range.maxRange < range.minRange || range.maxRange > 99) {
    return refusal(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);
  }
  const maxTargets = Math.max(1, Math.floor(Number(effectData.targets ?? 1) || 1));
  if (maxTargets > ITEM_ACTIVATION_SUPPORT.maxTargets) return refusal(RESULT_CODES.ITEM_ACTIVATION_UNSUPPORTED);

  const targetType = String(effectData.targetType ?? 'Any');
  const groundPlacement = targetType === 'Ground';
  const mount = isMountActivation(item);
  const locationShape = String(effectData.rngShape ?? 'Normal') === 'Square' ? 'Square' : 'Normal';
  const cone = rngType === 'Cone';
  const dealsDamage = activationDealsDamage(system.effects);
  return Object.freeze({
    ok: true,
    itemUuid: String(item.uuid ?? ''),
    itemName: String(item.name ?? ''),
    documentType: String(item.type ?? ''),
    subtype: String(system.itemType ?? ''),
    actionType,
    mount,
    rngType,
    losRule,
    targetType,
    maxTargets,
    shape: rngType !== 'Location' && locationShape === 'Square' ? 'Square' : 'Cross',
    // Rally is recognised by its innate grant, since its name follows the caster's affinity.
    rally: item.innateGrant === RALLY_GRANT_KEY,
    booster: isBoosterItem(item),
    forcedMovement: forcedMovementAbility(item.name),
    meleeReach: meleeReachAbility(item.name),
    aimed: AIMED_RNG_TYPES.has(rngType) || groundPlacement,
    groundPlacement,
    areaWide: rngType === 'Area',
    lineTargeting: rngType === 'Line',
    multiTargeting: rngType === 'Multiple',
    derivesTargets: DERIVED_TARGET_RNG_TYPES.has(rngType) || groundPlacement,
    selfTargeted: targetType === 'Self' || mount,
    groundValidSquares: String(effectData.groundValidSquares ?? 'All'),
    groundUnoccupiedOnly: effectData.groundUnoccupiedOnly !== false,
    groundMaxElevationDifference: Math.max(0, Number(effectData.groundMaxElevDiff) || 0),
    locationRange: Math.max(0, Number(effectData.locationRng) || 0),
    locationShape,
    coneDepth: cone ? Math.max(1, Number.parseInt(scaledRange, 10) || 1) : 0,
    range: cone
      ? Object.freeze({ minRange: 1, maxRange: 1 })
      : Object.freeze({ minRange: range.minRange, maxRange: range.maxRange }),
    maxElevationDifference: rngType === 'Single' && range.maxRange === 1 ? MELEE_ELEVATION_REACH : null,
    savingThrow: normalizeSaveEnvelope(effectData.savingThrowDC),
    skillCheck: normalizeCheckEnvelope(effectData.skillCheckDC),
    consumeOnFailure: effectData.consumeOnFailure !== false,
    usesType: String(system.uses?.type ?? 'limited'),
    usesCurrent: Math.max(0, Number(system.uses?.current) || 0),
    consumable: String(item.type ?? '') === CONSUMABLE_DOCUMENT_TYPE,
    // An item marked retractable that isn't a bonus action targeting Self is used like any other.
    retractable: system.retractable === true && retractableAllowed({ actionType, targetType }),
    dealsDamage,
    strikesObjects: dealsDamage && targetType !== 'Friendly',
    authored: (system.effects ?? []).some(entry => Array.isArray(entry?.action?.steps)
      && entry.action.steps.length > 0)
  });
}

/**
 * An item's range after scaling, for deriveActivationEnvelope and projectLoadoutItem in
 * foundry/adapters/projections/attack-targeting.mjs. Scaling reads the authored range's leading number and returns
 * a plain maximum, so it starts at 1.
 */
export function evaluateActivationRange(ownerSystem, effectData = {}, item = null) {
  const authored = String(effectData.rng ?? '1');
  const scaling = effectData.rngScaling;
  if (!isScalingActive(scaling)) return authored;
  const base = Number.parseInt(authored, 10);
  if (!Number.isFinite(base)) return authored;
  return String(Math.max(1, Math.floor(evaluateScaling(ownerSystem, base, scaling, item))));
}

/* -------------------------------------------- */
/*  Legality                                    */
/* -------------------------------------------- */

/** Whether Free Exploration lets a unit use this Item: healing, buffs, promotions and mounts, never an attack. */
export function explorationAllowsItem(item = {}) {
  return (EXPLORATION_ACTIVATION_SUBTYPES[String(item?.type ?? '')] ?? []).includes(String(item?.subtype ?? ''));
}

/**
 * Check caster and item legality for engine/items/activation.mjs and the hotbar entry in ui/controls/targeting.mjs,
 * before target geometry.
 * @param {object} input The envelope and the owner's turn state, plus `item` (the Item's data),
 *   `proficiencyTotal` (the caster's compiled total in the Item's `system.weapon.req` proficiency) and `locked`
 *   (the item's skill check failed this phase, so it can't be used again until the next one).
 * @returns {{ok: boolean, code: string, data?: object}} A Spell rank refusal names the school and rank, and a locked
 *   item refusal names the item.
 */
export function validateActivationLegality(input = {}) {
  const envelope = input.envelope;
  if (input.controlled !== true) return verdict(false, RESULT_CODES.OWNER_REQUIRED);
  if (input.turnOver === true) return verdict(false, RESULT_CODES.ITEM_ACTION_UNAVAILABLE);
  if (input.locked === true) {
    return verdict(false, RESULT_CODES.ITEM_LOCKED_THIS_PHASE, { itemName: String(envelope.itemName ?? '') });
  }
  if (envelope.actionType === 'Standard Action' && input.standardAvailable !== true) {
    return verdict(false, RESULT_CODES.ITEM_ACTION_UNAVAILABLE);
  }
  if (envelope.actionType === 'Bonus Action' && input.bonusAvailable !== true) {
    return verdict(false, RESULT_CODES.ITEM_ACTION_UNAVAILABLE);
  }
  if (envelope.usesType !== 'infinite' && envelope.usesCurrent < 1) {
    return verdict(false, RESULT_CODES.ITEM_USES_EXHAUSTED);
  }
  const spellRank = resolveSpellRank({ item: input.item, proficiencyTotal: input.proficiencyTotal });
  if (!spellRank.ok) {
    return verdict(false, RESULT_CODES.ITEM_SPELL_RANK_REQUIRED, {
      itemName: spellRank.itemName, proficiency: spellRank.proficiency, rankLabel: spellRank.rankLabel
    });
  }
  if (input.magicBlocked === true && input.magical === true) return verdict(false, RESULT_CODES.ITEM_ACTIVATION_UNAVAILABLE);
  if (input.stanceAvailable === false) return verdict(false, RESULT_CODES.ITEM_ACTIVATION_UNAVAILABLE);
  return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
}

/**
 * Whether a caster ranks high enough in a Spell's or activated staff's school to use it, for
 * validateActivationLegality and foundry/adapters/projections/attack-targeting.mjs. Like
 * game/character/inventory.mjs for weapons, it asks holdsProficiencyRank in game/progression/rules.mjs, so no
 * school, "None" or rank 0 passes. Only Spells and Staff (U) Equipment are checked here. An attack Staff is wielded,
 * so the equipment and attack checks cover it.
 * @param {{item?: object, proficiencyTotal?: number}} input Plain Item data and the caster's compiled total in the
 *   Item's `system.weapon.req` proficiency.
 * @returns {{ok: boolean, proficiency?: string, rank?: number, rankLabel?: string, itemName?: string}}
 */
export function resolveSpellRank(input = {}) {
  const item = input.item ?? {};
  const rankGated = String(item.type ?? '') === SPELL_DOCUMENT_TYPE
    || String(item.system?.itemType ?? '') === ACTIVATED_STAFF_SUBTYPE;
  if (!rankGated) return SPELL_RANK_MET;
  const required = String(item.system?.weapon?.req ?? '').trim().toLowerCase();
  const rank = Math.max(0, Math.floor(Number(item.system?.weapon?.rank) || 0));
  if (holdsProficiencyRank({ [required]: input.proficiencyTotal }, required, rank)) return SPELL_RANK_MET;
  return {
    ok: false,
    proficiency: PROFICIENCIES.find(entry => entry.key === required)?.label ?? required,
    rank,
    rankLabel: PROFICIENCY_RANK_LETTERS[Math.min(PROFICIENCY_RANK_LETTERS.length, rank) - 1],
    itemName: String(item.name ?? '')
  };
}

/**
 * Check authored requirements for engine/items/activation.mjs.
 * Terrain predicates use the supplied placement resolver and refuse when it is unavailable.
 * @param {object} input Requirements, the Item's name, document type (`itemType`) and required proficiency, which
 *   decide whether Silence blocks the caster, the caster's derived data, the derived targets, and optionally
 *   `resolveTerrainGeometry`, which counts the placements a geometry predicate reaches.
 * @returns {{ok: boolean, code: string, data?: object}} A refusal names what failed for the player.
 */
export function validateActivationRequirements(input = {}) {
  const requirements = Array.isArray(input.requirements) ? input.requirements : [];
  const source = input.source ?? null;
  const itemName = String(input.itemName ?? source?.conditionItem?.name ?? '');
  const casterPlacement = requirementPlacement(source);
  const resolveTerrainGeometry = typeof input.resolveTerrainGeometry === 'function'
    ? input.resolveTerrainGeometry : undefined;
  const caster = checkCaster({
    requirements,
    caster: source?.conditionSelf ?? null,
    item: { type: input.itemType, requiredProficiency: input.requiredProficiency },
    casterPlacement,
    resolveTerrainGeometry
  });
  if (!caster.ok) {
    return verdict(false, RESULT_CODES.ITEM_CASTER_REQUIREMENTS_UNMET, {
      itemName, silenced: caster.silenced === true, requirementNames: Object.freeze([...caster.failedNames])
    });
  }
  const targets = checkTargets({
    requirements,
    caster: source?.conditionSelf ?? null,
    casterPlacement,
    resolveTerrainGeometry,
    targetLocation: input.targetLocation ?? null,
    targets: (input.targets ?? []).map(target => ({
      id: target?.tokenUuid ?? null,
      name: String(target?.tokenName ?? target?.actorName ?? ''),
      actor: target?.conditionSelf ?? null,
      placement: requirementPlacement(target)
    }))
  });
  if (targets.ok) return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  return verdict(false, RESULT_CODES.ITEM_TARGET_REQUIREMENTS_UNMET, {
    itemName,
    targetNames: Object.freeze(targets.failingTargets.map(target => target.name).filter(Boolean)),
    requirementNames: Object.freeze([...targets.failedNames])
  });
}

/** The authored requirement list an activation Item carries, read from its data. */
export function activationRequirements(itemFacts) {
  const requirements = itemFacts?.system?.requirements;
  return Array.isArray(requirements) ? requirements : [];
}

/** The proficiency an item needs. With its document type, isMagicItem reads it to decide what Silence blocks. */
export function activationRequiredProficiency(itemFacts) {
  return String(itemFacts?.system?.weapon?.req ?? '');
}

/** A unit's square and footprint, in the shape a terrain requirement check reads. */
export function requirementPlacement(unit) {
  if (!unit) return null;
  return {
    x: Number(unit.x) || 0,
    y: Number(unit.y) || 0,
    width: Math.max(1, Number(unit.footprint?.width) || 1),
    height: Math.max(1, Number(unit.footprint?.height) || 1)
  };
}

/**
 * Whether an activation aimed at a guarded unit hits its guarder instead. Active and Utility items that aren't
 * Friendly do. Consumables and everything else don't.
 * @param {{subtype: string, targetType: string}} item The Item's kind and whom it targets.
 * @returns {boolean}
 */
export function activationRedirectsToGuarder({ subtype, targetType } = {}) {
  const kind = String(subtype ?? '');
  return (kind === 'Active' || kind === 'Utility') && String(targetType ?? 'Any') !== 'Friendly';
}

/**
 * Validate the target list for engine/items/activation.mjs and each pick in ui/controls/targeting.mjs. Exclude
 * scenery, admit Destructibles only for damaging items, and refuse a hostile direct pick on a unit under Sanctuary.
 * @param {object} envelope Derived activation envelope.
 * @param {string} sourceActorUuid Acting unit.
 * @param {object[]} targets Resolved target data.
 * @param {object} [source] Acting unit's data, needed by Items whose legality depends on the caster.
 * @returns {{ok: boolean, code: string}}
 */
export function validateActivationTargets(envelope, sourceActorUuid, targets = [], source = null) {
  if (targets.some(target => target?.scenery === true)) return verdict(false, RESULT_CODES.ITEM_TARGET_SCENERY);
  if (envelope.strikesObjects !== true && targets.some(target => target?.objectTarget === true)) {
    return verdict(false, RESULT_CODES.ITEM_TARGET_OBJECT);
  }
  if (targets.some(target => target?.objectDestroyed === true)) return verdict(false, RESULT_CODES.ITEM_TARGET_DESTROYED);
  if (!targets.every(target => activationTargetFactionAllowed(envelope, source, target))) {
    return verdict(false, RESULT_CODES.ITEM_TARGET_FACTION, {
      itemName: String(envelope.itemName ?? ''),
      targetType: String(envelope.targetType ?? '')
    });
  }
  const shielded = targets.find(target => sanctuaryBlocksPick(envelope, sourceActorUuid, target));
  if (shielded) {
    return verdict(false, RESULT_CODES.ITEM_TARGET_SANCTUARY, { targetName: String(shielded.actorName ?? '') });
  }
  if (envelope.rally && !targets.every(target => rallyTargetAllowed(source, target))) {
    return verdict(false, RESULT_CODES.ITEM_TARGET_INVALID);
  }
  if (envelope.aimed) return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  if (envelope.selfTargeted) {
    const aimedElsewhere = targets.length > 1
      || (targets.length === 1 && targets[0]?.actorUuid !== sourceActorUuid);
    return aimedElsewhere ? verdict(false, RESULT_CODES.ITEM_TARGET_INVALID) : verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  }
  if (envelope.areaWide) return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  if (targets.length === 0) return verdict(false, RESULT_CODES.ITEM_TARGET_INVALID);
  if (targets.length > envelope.maxTargets) return verdict(false, RESULT_CODES.ITEM_TARGET_INVALID);
  if (['Single', 'Line'].includes(envelope.rngType) && targets.length > 1) {
    return verdict(false, RESULT_CODES.ITEM_TARGET_INVALID);
  }
  return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
}

/**
 * Apply the Item's target type to one pick, through targetTypeAdmits in game/character/rules.mjs, for the UI and
 * engine activation checks. Destructibles skip the faction check, and validateActivationTargets checks instead
 * whether the item can damage them.
 * @param {object} envelope Derived activation envelope.
 * @param {object|null} source The caster's data.
 * @param {object} target One target's data.
 * @returns {boolean}
 */
export function activationTargetFactionAllowed(envelope = {}, source = null, target = {}) {
  if (target?.objectTarget === true) return true;
  return targetTypeAdmits(envelope.targetType, source?.actorType, target?.actorType);
}


/** A Rally can only target a unit rallyTargetBlocker admits: reached, under its map limit, not rallied this round. */
function rallyTargetAllowed(source, target) {
  return canRallyTarget(
    rallyCasterFacts(source),
    {
      name: target?.actorName,
      uuid: target?.actorUuid,
      actorId: target?.baseActorId,
      partyId: target?.partyId,
      rallied: target?.rallied === true
    }
  );
}

/**
 * The cells an item can target, for ui/controls/targeting.mjs and foundry/adapters/projections/items.mjs. Lines are
 * rays from the footprint's edge, and a cone picks an adjacent direction. Area grids drop cells out of sight, while
 * other grids keep height-hidden cells and mark them for dimming.
 * @param {object} input Plain envelope, source position, Scene bounds, footprint, and detached sight data.
 * @returns {{targetableCells: readonly object[], targetableKeys: ReadonlySet<string>,
 *   flyersOnlyKeys: ReadonlySet<string>}}
 */
export function buildActivationTargetingGrid(input = {}) {
  const keys = activationCoverage(input);
  const flyersOnlyKeys = pruneActivationGrid(keys, input);
  const cells = [...keys]
    .map(key => {
      const [x, y] = String(key).split(',').map(Number);
      return { x, y };
    })
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map(cell => Object.freeze(cell));
  return {
    targetableCells: Object.freeze(cells),
    targetableKeys: keys,
    flyersOnlyKeys
  };
}

/**
 * Validate reach before the activation is carried out, checking sight, height, then range.
 * Honor ignore-sight and free-targeting flags. Height blocks grounded targets only when every target
 * square is hidden from every caster square.
 * @param {object} input Plain source position, Scene bounds, footprint, sight data, and target data.
 * @returns {{ok: boolean, code: string}}
 */
export function validateActivationReach(input = {}) {
  const envelope = input.envelope;
  const covered = activationCoverage(input);
  pruneActivationGrid(covered, input);
  if (envelope.aimed) {
    const aim = input.aim;
    if (!aim) return verdict(false, RESULT_CODES.ITEM_AIM_INVALID);
    return covered.has(cellKeyOf(aim)) ? verdict(true, RESULT_CODES.ITEM_ACTIVATED) : verdict(false, RESULT_CODES.ITEM_TARGET_OUT_OF_RANGE);
  }
  if (envelope.selfTargeted || envelope.areaWide) return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  for (const target of input.targets ?? []) {
    if (targetSightBlocked(input, target)) return verdict(false, RESULT_CODES.ITEM_TARGET_SIGHT_BLOCKED);
    if (targetElevationUnreachable(input, target)) {
      return verdict(false, RESULT_CODES.ITEM_TARGET_ELEVATION_UNREACHABLE);
    }
    const cells = Array.isArray(target?.cells) ? target.cells : [];
    if (!cells.some(cell => covered.has(cellKeyOf(cell)))) return verdict(false, RESULT_CODES.ITEM_TARGET_OUT_OF_RANGE);
  }
  return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
}

/** Whether a touch-range item's target stands more than one level up or down. An airborne caster ignores this. */
function targetElevationUnreachable(input = {}, target = {}) {
  const envelope = input.envelope;
  const source = input.source ?? {};
  if (!Number.isFinite(envelope.maxElevationDifference) || source.airborne === true) return false;
  if (String(input.sight?.losRule ?? 'normal') !== 'normal') return false;
  return Math.abs(Number(target.elevation ?? 0) - Number(source.elevation ?? 0)) > envelope.maxElevationDifference;
}

/** Whether walls or height hide one target from the caster. A target with the free-targeting flag is never hidden. */
function targetSightBlocked(input = {}, target = {}) {
  if (target.freeTargeting === true) return false;
  const sight = input.sight ?? {};
  const losRule = String(sight.losRule ?? 'normal');
  if (losRule === 'ignoreLoS') return false;
  if (target.wallBlocked === true) return true;
  const source = input.source ?? {};
  return footprintHeightBlocked({
    losRule,
    sourceCells: footprintCellKeys(source, input.footprint ?? source.footprint),
    targetCells: target.cells,
    airborne: source.airborne === true || target.airborne === true,
    elevations: sight.elevations
  });
}

/* -------------------------------------------- */
/*  Forced movement                             */
/* -------------------------------------------- */
/** Which named forced-movement ability an Item is, or an empty string when it is neither. */
function forcedMovementAbility(itemName) {
  const name = String(itemName ?? '').trim();
  return Object.values(FORCED_MOVEMENT_ABILITIES).includes(name) ? name : '';
}

/** The item's name if it's one of the abilities that reach their target as melee does, or '' if not. */
function meleeReachAbility(itemName) {
  const name = String(itemName ?? '').trim();
  return MELEE_REACH_ABILITIES.includes(name) ? name : '';
}

/**
 * Check Shove, Retrieve and Swap for engine/items/activation.mjs and the activation click in
 * ui/controls/targeting.mjs. All three refuse an airborne target that melee can't reach, judged by
 * airborneBeyondMelee in game/targeting/attack-grid.mjs as for an attack. Shove and Retrieve then check each mover's
 * movement data (`boards`). Shove pushes the target away, and Retrieve steps the caster back and pulls the target
 * into the square it left. Each needs a free square at the same height or lower, and missing movement data refuses.
 * Drops are resolved as crossings. Swap's exchange of squares is left to its effect.
 * @param {object} input The envelope, source, target, the movement data of both, and the `classicFlyers` and
 *   `flightForbidden` settings.
 * @returns {{ok: boolean, code: string, ability: string}}
 */
export function validateForcedMovementSquare(input = {}) {
  const forced = String(input.envelope.forcedMovement ?? '');
  const ability = forced || String(input.envelope.meleeReach ?? '');
  if (!ability) return forcedVerdict(true, RESULT_CODES.ITEM_ACTIVATED, ability);
  const source = input.source ?? {};
  const target = input.target ?? null;
  if (!target) return forcedVerdict(true, RESULT_CODES.ITEM_ACTIVATED, ability);
  if (airborneBeyondMelee({
    sourceAirborne: source.airborne === true,
    targetAirborne: target.airborne === true,
    targetStanceBroken: target.stanceBroken === true,
    classicFlyers: input.classicFlyers === true,
    flightForbidden: input.flightForbidden === true
  })) {
    return forcedVerdict(false, RESULT_CODES.ITEM_FORCED_TARGET_AIRBORNE, ability);
  }
  if (!forced) return forcedVerdict(true, RESULT_CODES.ITEM_ACTIVATED, ability);
  const boards = input.boards ?? {};
  const step = compassStep(source, target);
  const moves = forced === FORCED_MOVEMENT_ABILITIES.SHOVE
    ? [[boards.target, target, 1]]
    : [[boards.source, source, -1], [boards.target, target, -1]];
  for (const [board, mover, sign] of moves) {
    if (!board) return forcedVerdict(false, RESULT_CODES.ITEM_FORCED_BOARD_REQUIRED, ability);
    const from = { x: Math.floor(Number(mover.x) || 0), y: Math.floor(Number(mover.y) || 0) };
    const forced = resolveForcedStep(board, from, { x: from.x + (step.dx * sign), y: from.y + (step.dy * sign) });
    const refusal = FORCED_STEP_REFUSALS[forced.outcome];
    if (refusal) return forcedVerdict(false, refusal, ability);
  }
  return forcedVerdict(true, RESULT_CODES.ITEM_ACTIVATED, ability);
}

/** The refusal code for each way a forced step can be stopped. A walk or a drop isn't stopped. */
const FORCED_STEP_REFUSALS = Object.freeze({
  [FORCED_STEP_OUTCOMES.OCCUPIED]: RESULT_CODES.ITEM_FORCED_SQUARE_OCCUPIED,
  [FORCED_STEP_OUTCOMES.BLOCKED]: RESULT_CODES.ITEM_FORCED_SQUARE_BLOCKED,
  [FORCED_STEP_OUTCOMES.ASCENT]: RESULT_CODES.ITEM_FORCED_SQUARE_ABOVE
});

/** The compass step from one unit's square toward another's, to the nearest eighth. */
function compassStep(from, to) {
  const dx = (Number(to?.x) || 0) - (Number(from?.x) || 0);
  const dy = (Number(to?.y) || 0) - (Number(from?.y) || 0);
  if (dx === 0 && dy === 0) return { dx: 1, dy: 0 };
  const degrees = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  const octant = Math.round(degrees / 45) % 8;
  return COMPASS_STEPS[octant];
}

const COMPASS_STEPS = Object.freeze([
  Object.freeze({ dx: 1, dy: 0 }),
  Object.freeze({ dx: 1, dy: 1 }),
  Object.freeze({ dx: 0, dy: 1 }),
  Object.freeze({ dx: -1, dy: 1 }),
  Object.freeze({ dx: -1, dy: 0 }),
  Object.freeze({ dx: -1, dy: -1 }),
  Object.freeze({ dx: 0, dy: -1 }),
  Object.freeze({ dx: 1, dy: -1 })
]);

function forcedVerdict(ok, code, ability) {
  return { ok, code, ability };
}

/* -------------------------------------------- */
/*  Aimed areas                                 */
/* -------------------------------------------- */

/**
 * The cells an aimed area covers, worked out from the aim cell rather than targets the client sent, for
 * foundry/adapters/projections/items.mjs. A cone starts at the footprint edge it faces. Sight is tested from the
 * area's origin once the aim is valid.
 * @param {object} input Plain envelope, source position, footprint, aim cell, Scene bounds, and sight data.
 * @returns {{ok: boolean, code: string, cells: ReadonlySet<string>, origin: object|null}}
 */
export function deriveActivationArea(input = {}) {
  const raw = activationAreaCells(input);
  if (!raw.ok) return raw;
  const sight = input.sight ?? {};
  const fromCaster = input.envelope.rngType === 'Cone';
  return areaResult(pruneCellsBySight({
    ...sight,
    cells: raw.cells,
    centers: [raw.origin],
    centerElevation: fromCaster
      ? Number(input.source?.elevation) || 0
      : elevationOf(sight.elevations, raw.origin)
  }), raw.origin);
}

/**
 * Build unfiltered area cells and origin for deriveActivationArea before sight checks.
 * @param {object} input Plain envelope, source position, footprint, aim cell, and Scene bounds.
 * @returns {{ok: boolean, code: string, cells: ReadonlySet<string>, origin: object|null}}
 */
export function activationAreaCells(input = {}) {
  const envelope = input.envelope;
  const aim = normalizeCell(input.aim);
  if (envelope.aimed !== true || !aim) return areaRefusal(RESULT_CODES.ITEM_AIM_INVALID);
  const columns = dimension(input.columns);
  const rows = dimension(input.rows);

  if (envelope.rngType === 'Cone') {
    const origin = resolveConeAim({ source: input.source, footprint: input.footprint, aim });
    if (!origin) return areaRefusal(RESULT_CODES.ITEM_AIM_INVALID);
    const cone = generateConeCells({ origin, direction: origin, depth: envelope.coneDepth, columns, rows });
    if (cone.size === 0) return areaRefusal(RESULT_CODES.ITEM_AIM_INVALID);
    return areaResult(cone, origin);
  }

  return areaResult(generateLocationCells({
    center: aim, radius: envelope.locationRange, shape: envelope.locationShape, columns, rows
  }), aim);
}

/**
 * Check that the aimed square is free, when the item's Unoccupied Only setting is on.
 * @param {object} envelope Derived activation envelope.
 * @param {object} aim Aim cell.
 * @param {readonly object[]} units The units on the map.
 * @param {string} sourceTokenUuid The acting unit, which never blocks its own placement.
 * @returns {{ok: boolean, code: string}}
 */
export function validateGroundPlacement(envelope, aim, units = [], sourceTokenUuid = '') {
  if (envelope.groundPlacement !== true) return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  const target = normalizeCell(aim);
  if (!target) return verdict(false, RESULT_CODES.ITEM_AIM_INVALID);
  if (envelope.groundUnoccupiedOnly !== true) return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  const key = cellKeyOf(target);
  for (const unit of units) {
    if (String(unit?.tokenUuid ?? '') === String(sourceTokenUuid ?? '')) continue;
    if ((unit?.cells ?? []).some(cell => cellKeyOf(cell) === key)) return verdict(false, RESULT_CODES.ITEM_GROUND_OCCUPIED);
  }
  return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
}

/**
 * The units an item's area or line catches, for foundry/adapters/projections/items.mjs. Ground placement catches no
 * units, and a line leaves out the caster. Scenery is left out, and Destructibles count only for an item that deals
 * damage.
 * @param {object} input The envelope, covered cells, units on the map, and the caster's data.
 * @returns {readonly object[]} The caught units.
 */
export function deriveActivationTargets(input = {}) {
  const envelope = input.envelope;
  if (envelope.groundPlacement === true) return [];
  return selectUnitsInCells({
    units: input.units,
    cells: input.cells,
    targetType: envelope.targetType,
    sourceFaction: input.sourceFaction,
    excludeTokenUuid: envelope.lineTargeting === true ? String(input.sourceTokenUuid ?? '') : '',
    admitsDestructibles: envelope.strikesObjects === true
  });
}

/**
 * The ray a clicked target puts a line-shaped Item on, and the cells that ray covers.
 * @param {object} input Plain envelope, source position, footprint, target cells, grid, and Scene bounds.
 * @returns {{cells: ReadonlySet<string>, endPoint: object}|null}
 */
export function resolveActivationLine(input = {}) {
  const envelope = input.envelope;
  if (envelope.lineTargeting !== true) return null;
  const ray = resolveLineRay({
    source: input.source,
    footprint: input.footprint,
    targetCells: input.targetCells,
    targetableKeys: input.targetableKeys,
    minRange: envelope.range.minRange,
    maxRange: envelope.range.maxRange,
    columns: input.columns,
    rows: input.rows
  });
  return ray ? { cells: ray.cells, endPoint: ray.endPoint } : null;
}

/**
 * Validate client-selected parameters against authored item choices before the activation runs.
 * @param {object} item Detached Item data.
 * @param {object} params Parameters the request named.
 * @returns {{ok: boolean, code: string}}
 */
export function validateActivationParams(item = {}, params = {}) {
  const authored = new Map();
  for (const param of item.system?.effectData?.params ?? []) {
    if (!param?.name) continue;
    authored.set(String(param.name), {
      options: String(param.options ?? '').split(',').map(option => option.trim()).filter(Boolean),
      numeric: param.numeric === true
    });
  }
  for (const [name, value] of Object.entries(params ?? {})) {
    const spec = authored.get(name);
    if (!spec) return verdict(false, RESULT_CODES.ITEM_PARAM_INVALID);
    if (spec.options.length && !spec.options.includes(value)) return verdict(false, RESULT_CODES.ITEM_PARAM_INVALID);
    if (!spec.options.length && spec.numeric && !Number.isFinite(Number(value))) {
      return verdict(false, RESULT_CODES.ITEM_PARAM_INVALID);
    }
  }
  return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
}

/* -------------------------------------------- */
/*  Saves and checks                            */
/* -------------------------------------------- */

/**
 * Decide which roll an activation needs (a target's save, the caster's skill check, or none) for
 * engine/items/activation.mjs. Destructibles automatically fail saves, so they cause no roll, roll card,
 * Willpower spend or save-effect consumption.
 * @param {object} input The envelope, both factions, and whether the target is a Destructible.
 * @returns {{kind: string, autoSucceed: boolean, autoFail: boolean}}
 */
export function resolveActivationDelivery(input = {}) {
  const envelope = input.envelope;
  const friendly = areFactionsFriendly(input.sourceFaction, input.targetFaction);
  if (envelope.savingThrow?.required && input.hasTarget === true) {
    const autoFail = input.targetDestructible === true;
    return {
      kind: 'save',
      autoSucceed: !autoFail && envelope.savingThrow.ignoreForFriendly === true && friendly,
      autoFail
    };
  }
  if (envelope.skillCheck?.required) {
    return {
      kind: 'check',
      autoSucceed: envelope.skillCheck.ignoreForFriendly === true && friendly && input.hasTarget === true,
      autoFail: false
    };
  }
  return { kind: 'none', autoSucceed: false, autoFail: false };
}

/** Whether a target's save may be rolled with advantage, and whether that spends a Willpower charge. */
export function resolveSaveAdvantage(input = {}) {
  const magicAdvantage = input.magicSaveAdvantage === true && input.magical === true;
  const spendsWillpower = !magicAdvantage && Math.max(0, Number(input.willpowerRemaining) || 0) > 0;
  return { hasAdvantage: magicAdvantage || spendsWillpower, spendsWillpower };
}

/**
 * Whether the effect lands after the roll: a failed target save or successful caster check lands it.
 * @param {object} input The roll kind from resolveActivationDelivery and its result.
 * @returns {boolean}
 */
export function resolveActivationLanded(input = {}) {
  if (input.kind === 'save') return input.savingThrow ? input.savingThrow.success !== true : false;
  if (input.kind === 'check') return input.skillCheck ? input.skillCheck.success === true : false;
  return true;
}

/**
 * Plan use consumption and depleted-item deletion for the Foundry activation writer.
 * @param {object} input The envelope and whether the effect landed.
 * @returns {{consume: boolean, remaining: number, destroy: boolean}}
 */
export function resolveActivationConsumption(input = {}) {
  const envelope = input.envelope;
  const current = envelope.usesCurrent;
  const consume = envelope.usesType !== 'infinite'
    && current > 0
    && (input.landed === true || envelope.consumeOnFailure === true);
  const remaining = consume ? Math.max(0, current - 1) : current;
  return {
    consume,
    remaining,
    destroy: consume && envelope.consumable === true && remaining === 0
  };
}

/**
 * The turn change written when an activation starts: only a Bonus Action is spent here. engine/items/activation.mjs
 * spends a Standard Action later, when the turn ends.
 */
export function resolveActivationActionSpend(actionType) {
  if (actionType === 'Bonus Action') return { 'system.turn.bonusActionAvailable': false };
  return {};
}

/**
 * Calculate the effect's landing percentage for the activation confirmation UI.
 * A save chance is inverted and a check chance used as it is. Exempt allies and Destructibles are certain.
 * @param {object} input The roll kind and the check plan's declared success chance.
 * @returns {number|null} A whole percentage, or null when the item asks for no roll.
 */
export function activationSuccessRate(input = {}) {
  if (input.kind === 'none') return null;
  if (input.autoSucceed === true || input.autoFail === true) return 100;
  const chance = Math.max(0, Math.min(1, Number(input.successChance) || 0));
  return Math.round((input.kind === 'save' ? 1 - chance : chance) * 100);
}

/* -------------------------------------------- */
/*  Continuation and cinematic                  */
/* -------------------------------------------- */

/**
 * Select the presentation cinematic from item type and subtype for engine activation.
 * Utility staves cast and offensive staves attack. Mounts use their own flourish.
 * @param {object} item Plain Item data.
 * @returns {string|null} A cinematic category name.
 */
export function activationCinematicCategory(item = {}) {
  const documentType = String(item.type ?? '');
  const subtype = String(item.system?.itemType ?? item.subtype ?? '');
  if (subtype === 'Mount') return null;
  if (documentType === 'Spell' || subtype === 'Staff (U)' || subtype === 'Utility') return 'casting';
  if (documentType === 'Consumable') return 'itemUsage';
  if (documentType === 'Ability') return 'abilities';
  return null;
}

/**
 * Choose the token-art condition consumed by activation presentation: On Cast for Spells and casting
 * Equipment, otherwise the ability-use condition.
 * @param {object} item Plain Item data.
 * @returns {string} A conditional token art name.
 */
export function activationCastCondition(item = {}) {
  const subtype = String(item.system?.itemType ?? item.subtype ?? '');
  const casts = String(item.type ?? '') === 'Spell' || ON_CAST_SUBTYPES.has(subtype);
  return casts ? ON_CAST_CONDITION : USING_ABILITY_CONDITION;
}

/**
 * Tell activation presentation whether to retain the pose through the effect sequence.
 * Ability-use poses always persist. On Cast persists when an authored entry waits on the token.
 * @param {object} input Plain Item data and its authored entries.
 * @returns {boolean}
 */
export function activationHoldsCastArt(input = {}) {
  if (activationCastCondition(input.item ?? {}) !== ON_CAST_CONDITION) return true;
  return (input.entries ?? []).some(entry => entry?.tokenAwaits === true);
}

/**
 * What the unit's turn does after an activation, for engine/items/activation.mjs. A retractable item keeps its
 * movement plan open, and a Bonus Action keeps the unit on its square with no movement. Other actions offer the Extra
 * Action, then Canter after a Spell or a staff (activationAllowsCanter), then end the turn, in the order
 * resolveCombatContinuation in game/combat/exchange.mjs uses after an attack. Multiattack only follows an attack.
 * @param {object} input Plain action cost and live turn state, plus `retractable`, `cantersAfter`, `hasCanter` and
 *   the `movementRemaining` the walked leg left.
 * @returns {Readonly<object>} The continuation every client reads.
 */
export function resolveActivationContinuation(input = {}) {
  if (input.sourceDefeated === true) return turnContinuation(COMBAT_CONTINUATIONS.END_TURN);
  if (input.retractable === true) return turnContinuation(COMBAT_CONTINUATIONS.MOVEMENT);
  if (input.actionType === 'Bonus Action') return turnContinuation(COMBAT_CONTINUATIONS.BONUS_ACTION);
  if (input.explorationActive === true) return turnContinuation(COMBAT_CONTINUATIONS.EXPLORATION);
  if (input.extraActionUsed !== true && Math.max(0, Number(input.extraActionsRemaining) || 0) > 0) {
    return turnContinuation(COMBAT_CONTINUATIONS.EXTRA_ACTION_CHOICE);
  }
  const movementRemaining = Math.max(0, Number(input.movementRemaining) || 0);
  if (input.cantersAfter === true && input.hasCanter === true && movementRemaining > 0) {
    return turnContinuation(COMBAT_CONTINUATIONS.CANTER);
  }
  return turnContinuation(COMBAT_CONTINUATIONS.END_TURN);
}

/** Whether a unit with Canter may move on after using this Item: a Spell or a staff, never an Ability or other Item. */
export function activationAllowsCanter(item = {}) {
  return String(item?.type ?? '') === SPELL_DOCUMENT_TYPE
    || CANTER_STAFF_SUBTYPES.has(String(item?.system?.itemType ?? item?.subtype ?? ''));
}

/* -------------------------------------------- */
/*  Mounting                                    */
/* -------------------------------------------- */

/** Whether an Item is a Mount, which activates on its rider alone and changes the saddle rather than a target. */
export function isMountActivation(item = {}) {
  return String(item.system?.itemType ?? item.subtype ?? '') === MOUNT_SUBTYPE;
}

/** Which way a Mount activation goes for its rider: onto the saddle, or off it. */
export function mountActivationIntent(source = {}) {
  return source.mounted === true ? 'dismount' : 'mount';
}

/**
 * Gate Mount activation in engine/items/activation.mjs against the scene's mount restriction.
 * Always allow dismounting so a unit can leave the saddle after a scene change.
 * @param {object} input Plain envelope and the rider's mounted state and map settings.
 * @returns {{ok: boolean, code: string}}
 */
export function validateMountActivation(input = {}) {
  const envelope = input.envelope;
  const source = input.source ?? {};
  if (envelope.mount !== true) return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
  if (mountActivationIntent(source) === 'mount' && source.mountsForbidden === true) {
    return verdict(false, RESULT_CODES.ITEM_MOUNTS_FORBIDDEN);
  }
  return verdict(true, RESULT_CODES.ITEM_ACTIVATED);
}

/**
 * The stat rows the Mount confirmation shows, leaving out unchanged stats. Mounting adds the mount's bonuses and
 * dismounting subtracts them. A formula attack changes only its number and keeps its dice.
 * @param {object} source Plain rider data: attribute totals and the attack total as displayed.
 * @param {object} stats Authored mount stat bonuses.
 * @param {string} intent `mount` or `dismount`.
 * @returns {ReadonlyArray<object>}
 */
export function buildMountStatChanges(source = {}, stats = {}, intent = 'mount') {
  const sign = intent === 'dismount' ? -1 : 1;
  const attributes = source.attributes ?? {};
  const rows = [];
  for (const row of MOUNT_STAT_ROWS) {
    const delta = (Number(stats?.[row.key]) || 0) * sign;
    if (delta === 0) continue;
    if (row.key === 'atk') {
      const from = String(source.attackTotal ?? '0').trim() || '0';
      rows.push(Object.freeze({ label: row.label, from, to: projectAttackTotal(from, delta), direction: delta > 0 ? 'up' : 'down' }));
      continue;
    }
    if (!(row.attribute in attributes)) continue;
    const from = Number(attributes[row.attribute]) || 0;
    rows.push(Object.freeze({ label: row.label, from, to: from + delta, direction: delta > 0 ? 'up' : 'down' }));
  }
  return Object.freeze(rows);
}

function projectAttackTotal(total, delta) {
  if (/^-?\d+$/.test(total)) return String(Number.parseInt(total, 10) + delta);
  const match = FORMULA_TRAILING_SUM.exec(total);
  const base = match ? match[1] : total;
  const sum = (match ? Number.parseInt(match[2], 10) : 0) + delta;
  if (sum === 0) return base;
  return sum > 0 ? `${base}+${sum}` : `${base}${sum}`;
}

/* -------------------------------------------- */
/*  Boosters                                    */
/* -------------------------------------------- */

/** Whether an Item is a Booster, a Consumable that raises its user's own stats and growths for good. */
function isBoosterItem(item = {}) {
  return String(item.type ?? item.documentType ?? '') === CONSUMABLE_DOCUMENT_TYPE
    && String(item.system?.itemType ?? item.subtype ?? '') === BOOSTER_SUBTYPE;
}

/** The stats a Booster may name, by the short label the sheet shows, in authored order and once each. */
function parseBoosterStats(text) {
  return parseBoosterList(text, BOOSTER_STATS);
}

/** The growths a Booster may name, by the short label the sheet shows, in authored order and once each. */
function parseBoosterGrowths(text) {
  return parseBoosterList(text, BOOSTER_GROWTHS);
}

/**
 * The permanent gains a Booster gives, for engine/items/activation.mjs and the activation writer. Personal stats rise
 * within class caps, listed growths rise, and HP or Stn rise along with their maximum.
 * @param {object} input `item` data plus the user's `progression` data (stat base and class parts, growths, cap
 *   totals).
 * @returns {object}
 */
export function planBoosterGains(input = {}) {
  const data = input.item?.system?.consumableData ?? {};
  const progression = input.source?.progression ?? {};
  const statValue = wholeValue(data.statValue);
  const growthValue = wholeValue(data.growthValue);
  const stats = parseBoosterStats(data.stat).map(stat => {
    const node = progression.stats?.[stat.key] ?? {};
    const from = wholeValue(node.base);
    const cap = stat.growth ? wholeValue(progression.caps?.[stat.growth]) : 0;
    const ceiling = cap > 0 ? cap - wholeValue(node.class) : null;
    const to = ceiling !== null && statValue > 0 ? Math.min(from + statValue, Math.max(from, ceiling)) : from + statValue;
    return {
      key: stat.key, label: stat.label, resource: stat.resource,
      from, to, gain: to - from, capped: to - from < statValue
    };
  });
  const growths = parseBoosterGrowths(data.growth).map(growth => {
    const from = wholeValue(progression.growth?.[growth.key]);
    return { key: growth.key, label: growth.label, from, to: from + growthValue, gain: growthValue };
  });
  const resources = stats
    .filter(stat => stat.resource && stat.gain !== 0)
    .map(stat => ({ key: stat.resource, gain: stat.gain }));
  return {
    stats,
    growths,
    resources,
    landed: stats.some(stat => stat.gain !== 0) || growths.some(growth => growth.gain !== 0)
  };
}

/** Format planBoosterGains results for the activation notice, including stats already at their class cap. */
export function boosterGainLine(actorName, plan) {
  const parts = [
    ...(plan?.stats ?? []).map(stat => stat.gain !== 0
      ? `${stat.label} ${signed(stat.gain)}${stat.capped ? ' (capped)' : ''}`
      : `${stat.label} at cap`),
    ...(plan?.growths ?? []).map(growth => `${growth.label} growth ${signed(growth.gain)}%`)
  ];
  return `${actorName}: ${parts.length ? parts.join(', ') : 'nothing to raise'}`;
}

function parseBoosterList(text, rows) {
  const wanted = String(text ?? '').split(BOOSTER_LIST_SEPARATOR).map(token => token.trim().toLowerCase()).filter(Boolean);
  const found = [];
  for (const token of wanted) {
    const row = rows.find(entry => entry.label.toLowerCase() === token || entry.key.toLowerCase() === token);
    if (row && !found.includes(row)) found.push(row);
  }
  return found;
}

function wholeValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

/* -------------------------------------------- */
/*  Normalization                               */
/* -------------------------------------------- */

function normalizeSaveEnvelope(savingThrowDc) {
  if (!savingThrowDc?.required) return null;
  return Object.freeze({
    required: true,
    base: Number(savingThrowDc.base) || 0,
    attribute: String(savingThrowDc.attribute ?? 'None'),
    targetAttribute: String(savingThrowDc.targetAttribute ?? 'None'),
    ignoreForFriendly: savingThrowDc.ignoreForFriendly === true
  });
}

function normalizeCheckEnvelope(skillCheckDc) {
  if (!skillCheckDc?.required) return null;
  return Object.freeze({
    required: true,
    base: Number(skillCheckDc.base) || 0,
    skill: String(skillCheckDc.skill ?? 'None'),
    targetAttribute: String(skillCheckDc.targetAttribute ?? 'None'),
    ignoreForFriendly: skillCheckDc.ignoreForFriendly === true
  });
}

/** The raw cells an Item's targeting grid covers before sight is considered. */
export function activationCoverage(input = {}) {
  const envelope = input.envelope;
  const source = input.source ?? {};
  const anchor = { x: Math.floor(Number(source.x) || 0), y: Math.floor(Number(source.y) || 0) };
  const columns = dimension(input.columns);
  const rows = dimension(input.rows);
  const geometry = { source: anchor, footprint: input.footprint, columns, rows };
  if (envelope.rngType === 'Cone') return generateAdjacentCells(geometry);
  if (envelope.lineTargeting === true) {
    return generateLineCells({
      ...geometry, minRange: envelope.range.minRange, maxRange: envelope.range.maxRange
    });
  }
  return calculateAttackTilesFromPosition(
    anchor.x, anchor.y, { ...envelope.range, shape: envelope.shape }, columns, rows, input.footprint
  );
}

function pruneActivationGrid(keys, input) {
  const envelope = input.envelope;
  const source = input.source ?? {};
  const sight = input.sight ?? {};
  const sourceCells = footprintCellKeys(source, input.footprint);
  if (envelope.groundPlacement === true) filterGroundSquares(keys, envelope, sight, source, sourceCells);
  if (envelope.areaWide === true) {
    retain(keys, pruneCellsBySight({
      ...sight,
      cells: keys,
      centers: sourceCells,
      centerElevation: Number(source.elevation) || 0
    }));
    return new Set();
  }
  if (String(sight.losRule ?? 'normal') !== 'normal') return new Set();
  const flyersOnly = heightOccludedCells({
    cells: keys, sourceCells, elevations: sight.elevations, airborne: source.airborne === true
  });
  if (!Number.isFinite(envelope.maxElevationDifference) || source.airborne === true) return flyersOnly;
  retain(keys, filterElevationReach({
    cells: keys,
    elevations: sight.elevations,
    sourceElevation: Number(source.elevation) || 0,
    maxDifference: envelope.maxElevationDifference
  }));
  for (const key of [...flyersOnly]) if (!keys.has(key)) flyersOnly.delete(key);
  return flyersOnly;
}

function filterGroundSquares(keys, envelope, sight, source, sourceCells = []) {
  const validSquares = envelope.groundValidSquares;
  const limit = envelope.groundMaxElevationDifference;
  const blocksObstacles = validSquares === 'Walkable';
  const blocksImpassable = blocksObstacles || validSquares === 'Flyable';
  const blocksOccupied = envelope.groundUnoccupiedOnly === true;
  if (!blocksImpassable && !blocksOccupied && limit === 0) return;
  const impassable = keySet(sight.impassableCells);
  const obstacles = keySet(sight.obstacleCells);
  const occupied = keySet(sight.occupiedCells);
  const own = keySet(sourceCells);
  const casterElevation = Number(source.elevation) || 0;
  for (const key of [...keys]) {
    if (blocksImpassable && impassable.has(key)) { keys.delete(key); continue; }
    if (blocksObstacles && obstacles.has(key)) { keys.delete(key); continue; }
    if (blocksOccupied && occupied.has(key) && !own.has(key)) { keys.delete(key); continue; }
    if (limit > 0 && Math.abs(elevationOf(sight.elevations, parseCell(key)) - casterElevation) > limit) {
      keys.delete(key);
    }
  }
}

function retain(keys, survivors) {
  for (const key of [...keys]) if (!survivors.has(key)) keys.delete(key);
}

function keySet(keys) {
  return keys instanceof Set ? keys : new Set(keys ?? []);
}

function normalizeCell(cell) {
  const x = Math.floor(Number(cell?.x));
  const y = Math.floor(Number(cell?.y));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function parseCell(key) {
  const [x, y] = String(key).split(',').map(Number);
  return { x, y };
}

function elevationOf(elevations, cell) {
  const key = `${cell?.x},${cell?.y}`;
  const value = elevations instanceof Map ? elevations.get(key) : elevations?.[key];
  return Number(value) || 0;
}

function dimension(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function areaResult(cells, origin) {
  return { ok: true, code: RESULT_CODES.ITEM_ACTIVATED, cells, origin: { ...origin } };
}

function areaRefusal(code) {
  return { ok: false, code, cells: new Set(), origin: null };
}

function refusal(code) {
  return { ok: false, code };
}

function verdict(ok, code, data = null) {
  return data ? { ok, code, data } : { ok, code };
}
