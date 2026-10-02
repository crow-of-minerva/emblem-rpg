/** @layer game/effects */
import { isEmpty } from '../../contracts/dsl/conditions.mjs';
import { ENGAGEMENT_CHOICES, STATUS_KEYS } from '../../contracts/domains/characters.mjs';
import { SafeEval } from '../../lib/core/safe-eval.mjs';

/** The `target` root as an authored path or expression names it, but not a property such as `weapon.target`. */
const TARGET_ROOT = /(^|[^.\w$])target\b/;

/* -------------------------------------------- */
/*  Condition evaluation                        */
/* -------------------------------------------- */
/**
 * Whether a condition tree (contracts/dsl/conditions.mjs) holds in `context`. `chanceRoll` supplies the draws in
 * [0, 100) for chance nodes: one number for all of them, an object keyed by node path, or a function of the path. A
 * node holds when its draw is below its percent. A SafeEvalError from a bad expression is not caught here; callers
 * catch it.
 */
export function evaluate(tree, context, chanceRoll = 100, path = 'root') {
  if (isEmpty(tree)) return true;
  switch (tree.kind) {
    case 'group':
      if (tree.op === 'and') {
        return tree.children.every((child, index) => evaluate(child, context, chanceRoll, `${path}.${index}`));
      }
      if (tree.op === 'or') {
        return tree.children.some((child, index) => evaluate(child, context, chanceRoll, `${path}.${index}`));
      }
      return false;
    case 'compare': {
      const right = evaluateOperand(tree.right, context);
      const left = SafeEval.evaluate(compareSubject(tree.left, right), context);
      return compareValues(tree.op, left, right, tree.right?.ignoreCase === true);
    }
    case 'truthy': return Boolean(SafeEval.evaluate(tree.expr, context)) !== (tree.negate === true);
    case 'status': return hasStatus(statusSubject(tree.side, context), tree.name) !== (tree.negate === true);
    case 'chance': return resolveChanceRoll(chanceRoll, path) < (tree.percent ?? 0);
    default: return false;
  }
}

/** The paths of a tree's chance nodes, for effectChanceRequirements in game/effects/planning.mjs. */
export function chanceNodePaths(tree, path = 'root') {
  return chanceNodeEntries(tree, path).map(entry => entry.path);
}

/**
 * The path and percent of each chance node in a tree. modifierChanceRequirements in game/character/compilation.mjs
 * lists them so the dice adapter (foundry/adapters/dice/modifier-chances.mjs) can draw them, and chanceNodePaths
 * keeps just the paths.
 * @param {object|null} tree The condition tree.
 * @param {string} [path] The stable path of the tree's root.
 * @returns {Array<{path: string, percent: number}>} One entry per chance node, in authored order.
 */
export function chanceNodeEntries(tree, path = 'root') {
  if (isEmpty(tree)) return [];
  if (tree.kind === 'chance') return [{ path, percent: Number(tree.percent ?? 0) }];
  if (tree.kind !== 'group' || !Array.isArray(tree.children)) return [];
  return tree.children.flatMap((child, index) => chanceNodeEntries(child, `${path}.${index}`));
}

/**
 * Whether any rule of a tree reads the target. game/effects/requirements.mjs uses this to decide whether an
 * activation requirement is checked once against the caster or once per target.
 * @param {object|null} tree   The condition tree.
 * @returns {boolean}
 */
export function referencesTarget(tree) {
  if (!tree || typeof tree !== 'object') return false;
  if (tree.kind === 'group') return (tree.children ?? []).some(referencesTarget);
  if (tree.kind === 'status') return tree.side === 'target';
  return [tree.left, tree.expr, tree.right?.expr].some(text => typeof text === 'string' && TARGET_ROOT.test(text));
}

/**
 * Whether a unit carries a status, for a status leaf in `evaluate`. `buildUnitFacts` in
 * game/character/compilation.mjs gives a unit both a `statuses` list of the effects it carries and one boolean per
 * system status, and either may hold the answer.
 * @param {object|null} unit   A unit's condition data from buildUnitFacts.
 * @param {string} name        The authored status name.
 * @returns {boolean}
 */
function hasStatus(unit, name) {
  const wanted = statusKey(name);
  if (!wanted || !unit || typeof unit !== 'object') return false;
  if (Array.isArray(unit.statuses) && unit.statuses.some(status => statusKey(status) === wanted)) return true;
  return STATUS_KEYS.some(key => unit[key] === true && statusKey(key) === wanted);
}

/** Reduce a status name, effect name, status id or key to lower-case letters and digits, so all four compare. */
function statusKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The unit a status leaf checks: the target, or else the condition's own unit (`self`, `caster` or `actor`). */
function statusSubject(side, context) {
  if (side === 'target') return context?.target ?? null;
  return context?.self ?? context?.caster ?? context?.actor ?? context ?? null;
}

function resolveChanceRoll(source, path) {
  if (typeof source === 'function') return Number(source(path));
  if (source && typeof source === 'object') return Number(source[path] ?? 100);
  return Number(source);
}

function compareValues(operator, left, right, ignoreCase = false) {
  switch (operator) {
    case '===': return left === right;
    case '!==': return left !== right;
    case '<': return Number(left) < Number(right);
    case '>': return Number(left) > Number(right);
    case '<=': return Number(left) <= Number(right);
    case '>=': return Number(left) >= Number(right);
    case 'includes':
      if (Array.isArray(right)) return right.includes(left);
      return typeof right === 'string' && typeof left === 'string' ? right.includes(left) : false;
    case 'not-includes':
      if (Array.isArray(right)) return !right.includes(left);
      return typeof right === 'string' && typeof left === 'string' ? !right.includes(left) : true;
    case 'contains': return containsValue(left, right, ignoreCase);
    case 'not-contains': return !containsValue(left, right, ignoreCase);
    default: return false;
  }
}

/**
 * Whether the left value holds the right one: a string holds it as any part of its text, so "Wolf" is found in
 * "Black Wolf", and a list holds it as one of its entries. `ignoreCase` folds both sides to lower case first, which
 * lets "wolf" find "Direwolf". An empty needle finds nothing, so a half-authored rule does not pass everything.
 */
function containsValue(left, right, ignoreCase) {
  if (right === undefined || right === null || right === '') return false;
  const fold = value => (ignoreCase && typeof value === 'string' ? value.toLowerCase() : value);
  const needle = fold(right);
  if (typeof left === 'string') return fold(left).includes(String(needle));
  if (Array.isArray(left)) return left.some(entry => fold(entry) === needle);
  return false;
}

/** A `distance` compared with "melee" or "ranged" reads `engagement` instead. */
function compareSubject(left, right) {
  if (!ENGAGEMENT_CHOICES.includes(right)) return left;
  return String(left ?? '').trim().replace(/(^|\.)distance$/, '$1engagement');
}

function evaluateOperand(operand, context) {
  if ('literal' in operand) return operand.literal;
  return typeof operand.expr === 'string' ? SafeEval.evaluate(operand.expr, context) : undefined;
}
