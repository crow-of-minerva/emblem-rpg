/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';

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
 * Whether a value is a condition node, an object with a `kind`. Character compilation and the board projection use
 * it to ask whether a modifier carries a condition tree.
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
/*  Validation                                  */
/* -------------------------------------------- */
/** Validate a serializable condition tree and collect every shape error. */
export function validate(tree, path = '') {
  const errors = [];
  if (tree === null || tree === undefined) return { valid: true, errors };
  if (!isPlainObject(tree)) return { valid: false, errors: [`${path || 'root'}: must be an object`] };
  if (!NODE_KINDS.includes(tree.kind)) {
    return { valid: false, errors: [`${path || 'root'}.kind: must be one of ${NODE_KINDS.join('|')}`] };
  }
  switch (tree.kind) {
    case 'group':
      if (!GROUP_OPS.includes(tree.op)) errors.push(`${path}.op: must be 'and' or 'or'`);
      if (!Array.isArray(tree.children)) errors.push(`${path}.children: must be an array`);
      else tree.children.forEach((child, index) => errors.push(...validate(child, `${path}.children[${index}]`).errors));
      break;
    case 'compare':
      if (typeof tree.left !== 'string' || tree.left.trim() === '') {
        errors.push(`${path}.left: must be a non-empty string`);
      }
      if (!COMPARE_OPS.includes(tree.op)) errors.push(`${path}.op: must be one of ${COMPARE_OPS.join('|')}`);
      if (!isPlainObject(tree.right)) errors.push(`${path}.right: must be { literal } or { expr }`);
      else if (tree.right.expr === undefined && !('literal' in tree.right)) {
        errors.push(`${path}.right: must have either 'literal' or 'expr'`);
      } else if (tree.right.expr !== undefined && typeof tree.right.expr !== 'string') {
        errors.push(`${path}.right.expr: must be a string`);
      } else if (tree.right.ignoreCase !== undefined) {
        if (typeof tree.right.ignoreCase !== 'boolean') errors.push(`${path}.right.ignoreCase: must be a boolean`);
        else if (!CONTAINS_OPS.includes(tree.op) || !('literal' in tree.right)) {
          errors.push(`${path}.right.ignoreCase: applies only to the literal of a 'contains' comparison`);
        }
      }
      break;
    case 'truthy':
      if (typeof tree.expr !== 'string' || tree.expr.trim() === '') {
        errors.push(`${path}.expr: must be a non-empty string`);
      }
      errors.push(...validateNegate(tree, path));
      break;
    case 'status':
      if (typeof tree.name !== 'string' || tree.name.trim() === '') {
        errors.push(`${path}.name: must be a non-empty string`);
      }
      if (tree.side !== undefined && !STATUS_SIDES.includes(tree.side)) {
        errors.push(`${path}.side: must be one of ${STATUS_SIDES.join('|')}`);
      }
      errors.push(...validateNegate(tree, path));
      break;
    case 'chance':
      if (typeof tree.percent !== 'number' || tree.percent < 0 || tree.percent > 100) {
        errors.push(`${path}.percent: must be a number between 0 and 100`);
      }
      break;
  }
  return { valid: errors.length === 0, errors };
}

function validateNegate(tree, path) {
  return tree.negate === undefined || typeof tree.negate === 'boolean' ? [] : [`${path}.negate: must be a boolean`];
}
