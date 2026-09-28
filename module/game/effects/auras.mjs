/** @layer game/effects */
import { AURA_TARGET_TYPES } from '../../contracts/domains/items.mjs';
import { areFactionsFriendly, areFactionsHostile } from '../character/rules.mjs';
import { ALL_UNIT_TYPE_KEYS, STATS } from '../../contracts/domains/characters.mjs';
import { evaluate as evaluateConditionTree } from './conditions.mjs';
import { isEmpty as conditionIsEmpty } from '../../contracts/dsl/conditions.mjs';
import { footprintDistance } from '../../lib/core/geometry.mjs';
import { isInMeleeRange } from '../targeting/attack-grid.mjs';
import { withMeleeReach } from '../character/compilation.mjs';

/* -------------------------------------------- */
/*  Aura targets                                */
/* -------------------------------------------- */
/** The stats an aura can change, as `stats.<key>` paths. Each value is saved in that stat's `aura` field. */
export const AURA_ATTRIBUTE_PATHS = Object.freeze(STATS.map(stat => `stats.${stat.key}`));

const AURA_TARGET_ALIASES = Object.freeze({
  hp: 'stats.hpMax', stn: 'stats.stnMax', movement: 'stats.mov', weight: 'stats.wgt'
});
const AURA_PATH_BY_STAT = Object.freeze(Object.fromEntries(
  AURA_ATTRIBUTE_PATHS.map(path => [path.split('.')[1], path])
));
const DEFAULT_AURA_RANGE = 1;

/**
 * The unit facts buildUnitFacts in game/character/compilation.mjs derives from what a unit wields, wears or has
 * equipped: its gear slots and their records, the unit types a mount or a wielded Spell grants, and the totals its
 * equipment and Class feed.
 */
const GEAR_FACT_KEYS = new Set([
  'weapon', 'armor', 'shield', 'mount', 'class', 'equipmentSlots', 'prots', 'vulns', 'imms',
  'stats', 'maxHp', 'maxStn', 'saves', 'combat', 'skills', 'prof', 'mounted', 'airborne',
  ...STATS.map(stat => stat.key), ...ALL_UNIT_TYPE_KEYS
]);
const GEAR_STATUS_KEYS = new Set(['mounted', 'airborne']);
const EXPRESSION_STRINGS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const EXPRESSION_PATHS = /(?<![\w$.])[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/g;
const PATH_SEPARATOR = /\s*\??\.\s*/;

/**
 * The aura path an authored modifier target writes. The item sheet's condition editor
 * (ui/apps/sheets/item/editors/conditions.mjs) also uses it to list the paths an aura can target.
 * @param {string} rawTarget Authored target name, container path, or path with a leaf.
 * @returns {string|null} `stats.<key>`, or null when this schema has no such stat.
 */
export function resolveAuraTarget(rawTarget) {
  const target = String(rawTarget ?? '').trim().replace(/^system\./, '');
  if (!target) return null;
  const parts = target.split('.');
  const key = parts.length === 1 ? parts[0] : parts[0] === 'stats' ? parts[1] : parts[0];
  const alias = AURA_TARGET_ALIASES[key];
  if (alias) return alias;
  return AURA_PATH_BY_STAT[key] ?? null;
}

/**
 * Whether an aura's target rule lets it reach this receiver. Friendly leaves out the emitter and Friendly+Self
 * includes it. Hostile leaves out Neutrals.
 * @param {string} sourceFaction Emitting unit's faction.
 * @param {string} targetFaction Receiving unit's faction.
 * @param {string} targetType Authored target rule.
 * @param {boolean} isSelf Whether emitter and receiver are the same unit.
 * @returns {boolean}
 */
function auraTargetAllowed(sourceFaction, targetFaction, targetType, isSelf) {
  const rule = AURA_TARGET_TYPES.includes(targetType) ? targetType : 'All';
  if (rule === 'All') return true;
  const friendly = areFactionsFriendly(sourceFaction, targetFaction);
  if (rule === 'Friendly+Self') return friendly || isSelf;
  if (rule === 'Friendly') return friendly && !isSelf;
  return !isSelf && areFactionsHostile(sourceFaction, targetFaction);
}

/**
 * A text summary of a unit's aura emissions. The board hook (foundry/hooks/board.mjs) compares it before and after
 * an item write to tell an ordinary write from a change to an aura.
 * @param {object[]} emissions Projected aura emissions for one unit.
 * @returns {string}
 */
export function auraEmissionSignature(emissions) {
  if (!Array.isArray(emissions) || emissions.length === 0) return '';
  return emissions.map(emission => {
    const modifier = emission?.modifier ?? {};
    return [
      modifier.target, modifier.quantity, emission?.range, modifier.targetType,
      modifier.stackable ? 1 : 0,
      modifier.conditionTree ? JSON.stringify(modifier.conditionTree) : ''
    ].join('|');
  }).join(';');
}

/* -------------------------------------------- */
/*  Equipment reads                             */
/* -------------------------------------------- */
/**
 * Whose equipment one unit's aura conditions can read. `self` is the emitter's own gear, as when Shield Wall checks
 * for its Heavy shield, and `target` is the receiver's, as when an aura for allies wielding an Attack Spell checks
 * theirs. The board hook in foundry/hooks/board.mjs uses this to recompute a scene's auras after an equip change
 * only when some aura could see it. A path that reaches gear some other way counts for both, so an unusual
 * expression causes an extra recompute rather than a stale aura.
 * @param {object[]} emissions Projected aura emissions for one unit.
 * @returns {Readonly<{self: boolean, target: boolean}>}
 */
export function auraGearReads(emissions) {
  const reads = { self: false, target: false };
  for (const emission of emissions ?? []) {
    if (hasConditionTree(emission?.modifier?.conditionTree)) collectGearReads(emission.modifier.conditionTree, reads);
    if (reads.self && reads.target) break;
  }
  return Object.freeze(reads);
}

/** Walk a stored condition tree, marking which unit's gear its leaves read. */
function collectGearReads(node, reads) {
  if (!node || typeof node !== 'object') return;
  if (node.kind === 'group') {
    for (const child of node.children ?? []) collectGearReads(child, reads);
    return;
  }
  if (node.kind === 'status') {
    const status = String(node.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (GEAR_STATUS_KEYS.has(status)) reads[node.side === 'target' ? 'target' : 'self'] = true;
    return;
  }
  for (const text of [node.left, node.expr, node.right?.expr]) {
    if (typeof text === 'string') collectExpressionGearReads(text, reads);
  }
}

/**
 * Mark the gear one authored expression reads. The aura context spreads the emitter's facts at the root beside
 * `self`, `caster`, `item` (the emitting Item) and `target`, so a bare fact is the emitter's own.
 */
function collectExpressionGearReads(text, reads) {
  for (const [path] of text.replace(EXPRESSION_STRINGS, "''").matchAll(EXPRESSION_PATHS)) {
    const [root, key, ...rest] = path.split(PATH_SEPARATOR);
    if (root === 'target') reads.target ||= GEAR_FACT_KEYS.has(key);
    else if (root === 'self' || root === 'caster') reads.self ||= GEAR_FACT_KEYS.has(key);
    else if (root === 'item' || GEAR_FACT_KEYS.has(root)) reads.self = true;
    else if ([key, ...rest].some(segment => GEAR_FACT_KEYS.has(segment))) {
      reads.self = true;
      reads.target = true;
    }
  }
}

/* -------------------------------------------- */
/*  Contributions                               */
/* -------------------------------------------- */
/**
 * The aura bonuses one placed unit receives from every unit on the board. Called by planAuraFields and by the board
 * projection (foundry/adapters/projections/board.mjs). A unit's own aura ignores distance. A non-stackable modifier
 * counts once per source item, so copies of the same relic don't stack.
 * @param {{units: object[]}} board Detached snapshot of the placed units.
 * @param {string} receiverTokenUuid Token receiving the auras.
 * @returns {object[]} Frozen contribution facts.
 */
export function collectAuraContributions(board, receiverTokenUuid) {
  const units = Array.isArray(board?.units) ? board.units : [];
  const receiver = units.find(unit => unit.tokenUuid === receiverTokenUuid) ?? null;
  if (!receiver?.receives || !receiver.placed) return Object.freeze([]);

  const contributions = [];
  const appliedNonStackable = new Set();
  for (const source of units) {
    if (!source.placed || !source.emissions?.length) continue;
    const isSelf = source.tokenUuid === receiver.tokenUuid;
    const distance = isSelf ? 0 : unitDistance(source, receiver);
    for (const emission of source.emissions) {
      const contribution = resolveContribution(emission, source, receiver, {
        isSelf,
        distance,
        appliedNonStackable
      });
      if (contribution) contributions.push(contribution);
    }
  }
  return Object.freeze(contributions);
}

/**
 * The aura values to save on each unit. engine/board.mjs merges them with the terrain plans, and the character
 * writer's settleModifierFields saves them. Every stat is summed from zero, so an expired or out-of-range aura
 * leaves no stale bonus. A plan names only the stats whose value differs from the saved one, and a unit with no
 * change is left out.
 * @param {{units: object[]}} board Detached snapshot of the placed units.
 * @returns {object[]} The `{actorUuid, fields}` intents.
 */
export function planAuraFields(board) {
  const units = Array.isArray(board?.units) ? board.units : [];
  const plans = [];
  const planned = new Set();
  for (const unit of units) {
    if (!unit.receives || planned.has(unit.actorUuid)) continue;
    planned.add(unit.actorUuid);
    const fields = {};
    for (const path of AURA_ATTRIBUTE_PATHS) fields[path] = 0;
    if (unit.placed) {
      for (const contribution of collectAuraContributions(board, unit.tokenUuid)) {
        fields[contribution.target] += contribution.value;
      }
    }
    const changed = changedAuraFields(unit.auraFields, fields);
    if (Object.keys(changed).length === 0) continue;
    plans.push({ actorUuid: unit.actorUuid, fields: changed });
  }
  return plans;
}

/* -------------------------------------------- */
/*  Contribution rules                          */
/* -------------------------------------------- */
function resolveContribution(emission, source, receiver, state) {
  const modifier = emission?.modifier ?? {};
  const range = Number(emission?.range) || DEFAULT_AURA_RANGE;
  if (!state.isSelf && state.distance > range) return null;
  if (!auraTargetAllowed(source.faction, receiver.faction, modifier.targetType, state.isSelf)) return null;
  if (!auraConditionMet(modifier, emission, source, receiver, state)) return null;

  const value = Number(modifier.quantity) || 0;
  if (value === 0) return null;
  const target = resolveAuraTarget(modifier.target);
  if (!target) return null;

  if (modifier.stackable !== true) {
    const identity = emission.itemSource || emission.itemName || '';
    const key = `${identity}::${modifier.name || modifier.target}::${target}`;
    if (state.appliedNonStackable.has(key)) return null;
    state.appliedNonStackable.add(key);
  }
  return Object.freeze({
    target,
    value,
    sourceTokenUuid: source.tokenUuid,
    sourceActorUuid: source.actorUuid,
    sourceActorName: source.name,
    sourceSprite: source.sprite,
    itemUuid: emission.itemUuid,
    itemName: emission.itemName,
    modifierName: String(modifier.name ?? '')
  });
}

function auraConditionMet(modifier, emission, source, receiver, state) {
  const tree = hasConditionTree(modifier.conditionTree) ? modifier.conditionTree : null;
  if (!tree || conditionIsEmpty(tree)) return true;
  try {
    return evaluateConditionTree(tree, auraConditionContext(emission, source, receiver, state));
  } catch {
    return false;
  }
}

function auraConditionContext(emission, source, receiver, state) {
  const inMeleeRange = isInMeleeRange({
    distance: state.distance, sourceElevation: source?.elevation, targetElevation: receiver?.elevation
  });
  const self = withMeleeReach(source?.facts ?? null, inMeleeRange);
  return {
    ...(self ?? {}),
    self,
    caster: self,
    item: emission.item ?? null,
    target: withMeleeReach(receiver?.facts ?? null, inMeleeRange),
    inMeleeRange
  };
}

function hasConditionTree(tree) {
  return tree !== null && typeof tree === 'object' && typeof tree.kind === 'string';
}

function unitDistance(source, receiver) {
  const a = source.footprint ?? {};
  const b = receiver.footprint ?? {};
  return footprintDistance(a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height);
}

function changedAuraFields(current, planned) {
  return Object.fromEntries(Object.entries(planned)
    .filter(([path, value]) => (Number(current?.[path]) || 0) !== value));
}
