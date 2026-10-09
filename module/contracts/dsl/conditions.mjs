/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { ENGAGEMENT_CHOICES, STATS, VOCABULARY_BY_NAME } from '../domains/characters.mjs';
import { placeOf, say } from './messages.mjs';

/* -------------------------------------------- */
/*  Condition vocabulary                        */
/* -------------------------------------------- */
/** Every node kind a tree may hold: `group` and the four leaves in `LEAF_KINDS`. */
const NODE_KINDS = Object.freeze(['group', 'compare', 'truthy', 'chance', 'status']);
export const LEAF_KINDS = Object.freeze(['compare', 'truthy', 'chance', 'status']);
export const GROUP_OPS = Object.freeze(['and', 'or']);
export const COMPARE_OPS = Object.freeze([
  '===', '!==', '<', '>', '<=', '>=', 'includes', 'not-includes', 'contains', 'not-contains'
]);

/** The comparisons that search the left value for the right one, and so may fold letter case. */
export const CONTAINS_OPS = Object.freeze(['contains', 'not-contains']);

/** Whose statuses a `status` leaf reads: the unit the condition belongs to, or that unit's target. */
export const STATUS_SIDES = Object.freeze(['self', 'target']);

/* -------------------------------------------- */
/*  Construction                                */
/* -------------------------------------------- */
/** Create an empty condition tree. */
export function empty() {
  return { kind: 'group', op: 'and', children: [] };
}

/**
 * Whether a value is a condition node, an object with a `kind`, as when asking whether a modifier carries a
 * condition tree.
 */
export function hasConditionTree(tree) {
  return tree !== null && typeof tree === 'object' && typeof tree.kind === 'string';
}

/** Whether a condition tree places no constraint at all. */
export function isEmpty(tree) {
  if (!isPlainObject(tree)) return true;
  if (tree.kind === 'group') {
    if (!Array.isArray(tree.children) || tree.children.length === 0) return true;
    return tree.children.every(isEmpty);
  }
  if (tree.kind === 'compare') return !tree.left || !tree.op;
  if (tree.kind === 'truthy') return !tree.expr || tree.expr.trim() === '';
  if (tree.kind === 'status') return typeof tree.name !== 'string' || tree.name.trim() === '';
  if (tree.kind === 'chance') return typeof tree.percent !== 'number';
  return true;
}

/* -------------------------------------------- */
/*  Surfaces and values                         */
/* -------------------------------------------- */
/**
 * The places a condition tree is authored: an effect entry or `if` step, a standard modifier, an aura modifier, an
 * activation requirement and a weapon damage-type condition. Only the effect surface allows a chance.
 */
export const CONDITION_SURFACES = Object.freeze(['effect', 'modifier', 'aura', 'requirement', 'damageType']);

/** Context roots that name a unit. Below them a path reads that unit's values. */
const UNIT_ROOTS = Object.freeze(['self', 'target', 'caster', 'actor']);

/** Context roots that hold item or call data rather than unit values, so any path below them is accepted. */
const OPEN_ROOTS = Object.freeze([
  'item', 'activeItem', 'selectedParams', 'targetLocation', 'savingThrowResult', 'skillCheckResult',
  'casterPlacement', 'targetPlacement'
]);

/** Unit values the evaluator's contexts carry beyond the authoring vocabulary. */
const UNIT_FACT_EXTRAS = Object.freeze([
  'statuses', 'physicalWeaponTypesCarried', 'hasStealables',
  ...STATS.map(stat => `stats.${stat.key}.total`),
  ...['weapon', 'armor', 'shield', 'mount', 'class'].flatMap(slot =>
    ['name', 'type', 'itemType', 'tier', 'twoHanded', 'wgt'].map(field => `${slot}.${field}`))
]);

/** Bare names only some contexts add: an effect run's flags, and shorthands such as `targetHp` and `selfMgt`. */
const CONTEXT_NAMES = new Set([
  'savingThrowRequired', 'skillCheckRequired', 'slainActorUuids', 'targetId',
  ...['self', 'caster', 'target'].flatMap(prefix =>
    ['hp', 'maxHp', 'stn', 'maxStn', 'level', ...STATS.map(stat => stat.key)]
      .map(key => `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`))
]);

/** A set of names plus every dotted prefix of each, so `prots` and `stats.mgt` count as known objects. */
function withPrefixes(names) {
  const known = new Set();
  for (const name of names) {
    const parts = name.split('.');
    for (let length = 1; length <= parts.length; length++) known.add(parts.slice(0, length).join('.'));
  }
  return known;
}

const BARE_FACTS = withPrefixes([...VOCABULARY_BY_NAME.keys(), ...UNIT_FACT_EXTRAS]);
const ROOTED_FACTS = withPrefixes([
  ...[...VOCABULARY_BY_NAME.values()].filter(entry => entry.bareOnly !== true).map(entry => entry.name),
  ...UNIT_FACT_EXTRAS
]);

/**
 * Whether a dotted path names a value some condition context supplies. A bare name reads the unit itself, a unit root
 * (`self`, `target`, `caster`, `actor`) reads that unit, and a trailing `length` reads a list's size.
 */
export function isKnownFactPath(path) {
  const segments = String(path ?? '').split('.');
  if (segments.length > 1 && segments.at(-1) === 'length') segments.pop();
  const [root] = segments;
  if (OPEN_ROOTS.includes(root)) return true;
  if (UNIT_ROOTS.includes(root)) return segments.length === 1 || ROOTED_FACTS.has(segments.slice(1).join('.'));
  const name = segments.join('.');
  return BARE_FACTS.has(name) || CONTEXT_NAMES.has(name);
}

/** Names an expression may use that are not context lookups. */
const EXPRESSION_KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'let', 'const', 'var', 'Math']);

/**
 * The dotted paths an authored expression reads, such as `target.hp` and `maxHp` in `target.hp < maxHp / 2`. String
 * literals, keywords, `Math`, names the expression declares itself and the method in a call are left out.
 */
export function expressionPaths(text) {
  if (typeof text !== 'string') return [];
  const source = text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  const declared = new Set([...source.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]));
  const paths = [];
  for (const match of source.matchAll(/(?<![\w$.\]])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)(\s*\()?/g)) {
    const segments = match[1].split(/\s*\??\.\s*/);
    if (match[2]) segments.pop();
    if (segments.length === 0 || EXPRESSION_KEYWORDS.has(segments[0]) || declared.has(segments[0])) continue;
    paths.push(segments.join('.'));
  }
  return paths;
}

/** Every value path a tree reads. A status leaf reads `statuses`, or `target.statuses` on the target side. */
export function conditionPaths(tree) {
  if (!isPlainObject(tree)) return [];
  switch (tree.kind) {
    case 'group': return (Array.isArray(tree.children) ? tree.children : []).flatMap(conditionPaths);
    case 'compare': return [...expressionPaths(tree.left), ...expressionPaths(tree.right?.expr)];
    case 'truthy': return expressionPaths(tree.expr);
    case 'status': return [tree.side === 'target' ? 'target.statuses' : 'statuses'];
    default: return [];
  }
}

/**
 * Whether a tree reads the other unit: a path under `target`, a status check on the target, or the distance or
 * engagement with it. Phase triggers and the use item trigger have no other unit for these to read.
 */
export function readsOtherUnit(tree) {
  return conditionPaths(tree).some(path => {
    const segments = path.split('.');
    return segments[0] === 'target' || ['distance', 'engagement'].includes(segments.at(-1));
  });
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */
/**
 * Validate a condition tree. With no options, or a path string, only the shape is checked. With a `surface` from
 * CONDITION_SURFACES the authoring rules for that surface run too. Each message is a plain sentence that opens with
 * where the condition sits, worked out from `path` (`the condition in step 2`), or with `place` when the caller
 * names it itself.
 * @param {object|null} tree
 * @param {string|{path?: string, place?: string, surface?: string}} [options]
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validate(tree, options = '') {
  const settings = typeof options === 'string' ? { path: options } : (options ?? {});
  const { path = '', surface = null } = settings;
  const place = settings.place ?? placeOf(path, 'the condition');
  const errors = shapeErrors(tree, place);
  const warnings = [];
  if (surface !== null && surface !== undefined) {
    if (!CONDITION_SURFACES.includes(surface)) {
      errors.push(say(place, 'is checked in a place the system does not know'));
    } else if (isPlainObject(tree)) {
      surfaceIssues(tree, 0, { place, surface, errors, warnings });
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/** Collect every shape error in a tree. `place` names the whole condition, as every message opens with it. */
function shapeErrors(tree, place) {
  const errors = [];
  const fail = sentence => errors.push(say(place, sentence));
  if (tree === null || tree === undefined) return errors;
  if (!isPlainObject(tree)) return [say(place, 'cannot be read')];
  if (!NODE_KINDS.includes(tree.kind)) return [say(place, 'has a rule of a kind the system does not know')];
  switch (tree.kind) {
    case 'group':
      if (!GROUP_OPS.includes(tree.op)) fail('has a group that does not say whether all or any of its rules must hold');
      if (!Array.isArray(tree.children)) fail('has a group whose rules cannot be read');
      else tree.children.forEach(child => errors.push(...shapeErrors(child, place)));
      break;
    case 'compare':
      if (typeof tree.left !== 'string' || tree.left.trim() === '') fail('has a comparison with nothing on its left');
      if (!COMPARE_OPS.includes(tree.op)) fail('has a comparison the system does not know how to make');
      if (!isPlainObject(tree.right)) fail('has a comparison with nothing on its right');
      else if (tree.right.expr === undefined && !('literal' in tree.right)) {
        fail('has a comparison with nothing on its right');
      } else if (tree.right.expr !== undefined && typeof tree.right.expr !== 'string') {
        fail('has a comparison whose right side cannot be read');
      } else if (tree.right.ignoreCase !== undefined) {
        if (typeof tree.right.ignoreCase !== 'boolean') {
          fail('has a comparison whose ignore case setting is not on or off');
        } else if (!CONTAINS_OPS.includes(tree.op) || !('literal' in tree.right)) {
          fail('ignores letter case on a comparison that does not check whether text contains a value');
        }
      }
      break;
    case 'truthy':
      if (typeof tree.expr !== 'string' || tree.expr.trim() === '') fail('has a check with no expression');
      errors.push(...validateNegate(tree, place));
      break;
    case 'status':
      if (typeof tree.name !== 'string' || tree.name.trim() === '') fail('has a status check with no status name');
      if (tree.side !== undefined && !STATUS_SIDES.includes(tree.side)) {
        fail('has a status check on a unit other than self or target');
      }
      errors.push(...validateNegate(tree, place));
      break;
    case 'chance':
      if (typeof tree.percent !== 'number' || tree.percent < 0 || tree.percent > 100) {
        fail('has a chance that is not a number from 0 to 100');
      }
      break;
  }
  return errors;
}

function validateNegate(tree, place) {
  return tree.negate === undefined || typeof tree.negate === 'boolean'
    ? []
    : [say(place, 'has a rule whose negate setting is not on or off')];
}

/** Collect the surface rules' errors and warnings for one node and everything below it. */
function surfaceIssues(node, depth, issues) {
  if (!isPlainObject(node)) return;
  const { place, surface, errors } = issues;
  const fail = sentence => errors.push(say(place, sentence));
  const unknownPaths = text => {
    for (const fact of expressionPaths(text)) {
      if (!isKnownFactPath(fact)) fail(`reads ${fact}, which is not a fact the system knows`);
    }
  };
  switch (node.kind) {
    case 'group':
      if (depth > 0 && Array.isArray(node.children) && node.children.length === 0) fail('has an empty group');
      (Array.isArray(node.children) ? node.children : []).forEach(child => surfaceIssues(child, depth + 1, issues));
      break;
    case 'chance':
      if (surface !== 'effect') fail('uses a chance. A chance can only be used on an effect entry or an if step');
      if (node.percent === 0) fail('has a 0 percent chance, which never happens. Use a value from 1 to 99');
      if (node.percent === 100) fail('has a 100 percent chance, which always happens. Use a value from 1 to 99');
      if (node.negate === true) fail('has a negated chance. A chance cannot be negated');
      break;
    case 'compare': {
      if (node.negate === true) fail('has a negated comparison. Flip its operator instead');
      unknownPaths(node.left);
      if (!isPlainObject(node.right)) break;
      unknownPaths(node.right.expr);
      if (!('literal' in node.right)) break;
      const literal = node.right.literal;
      const blank = literal === undefined || (typeof literal === 'string' && literal.trim() === '')
        || (Array.isArray(literal) && literal.length === 0);
      if (blank) fail('has a comparison with an empty value');
      // The evaluator reads 'melee' or 'ranged' against distance as engagement; any other word never matches.
      const strings = [literal].flat().some(value => typeof value === 'string');
      const engagementWord = typeof literal === 'string' && ENGAGEMENT_CHOICES.includes(literal);
      if (strings && !engagementWord && /(^|\.)distance$/.test(String(node.left ?? '').trim())) {
        fail('compares distance with a word. Distance is a number, or melee or ranged');
      }
      if (['includes', 'not-includes'].includes(node.op) && !Array.isArray(literal)) {
        fail(`checks whether a value ${node.op === 'includes' ? 'is' : 'is not'} one of a list, but gives no list`);
      }
      break;
    }
    case 'truthy':
      unknownPaths(node.expr);
      break;
  }
}
