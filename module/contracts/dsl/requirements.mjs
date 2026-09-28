/** @layer contracts/dsl */
import { isEmpty as isConditionEmpty, validate as validateCondition } from './conditions.mjs';
import { defaultGeometry, validateGeometry } from './terrain-geometry.mjs';
import { isPlainObject } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Requirement vocabulary                      */
/* -------------------------------------------- */
/**
 * The two requirement types, each named after the single predicate kind it holds. A `condition` requirement carries
 * one condition predicate, whose tree names the caster and the target through its own paths. A `terrainGeometry`
 * requirement carries one geometry predicate.
 */
export const REQUIREMENT_TYPES = Object.freeze(['condition', 'terrainGeometry']);

/* -------------------------------------------- */
/*  Construction                                */
/* -------------------------------------------- */
/** Create a blank requirement of one authored type, carrying its single predicate. */
export function emptyRequirement(type = 'condition', name = '') {
  if (type === 'terrainGeometry') {
    return { type, name, predicates: [{ kind: 'terrainGeometry', geometry: defaultGeometry() }] };
  }
  return { type: 'condition', name, predicates: [{ kind: 'condition', tree: null }] };
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */
/** Validate a serializable requirement and the predicate beneath it. */
export function validate(requirement) {
  const errors = [];
  if (!isPlainObject(requirement)) return { valid: false, errors: ['root: must be an object'] };
  if (!REQUIREMENT_TYPES.includes(requirement.type)) {
    errors.push(`type: must be one of ${REQUIREMENT_TYPES.join('|')}`);
  }
  if (requirement.name !== undefined && typeof requirement.name !== 'string') errors.push('name: must be a string');
  if (!Array.isArray(requirement.predicates)) errors.push('predicates: must be an array');
  else {
    if (REQUIREMENT_TYPES.includes(requirement.type)) {
      const { type, predicates } = requirement;
      if (predicates.length !== 1 || predicates[0]?.kind !== type) {
        errors.push(`predicates: a ${type} requirement holds exactly one ${type} predicate`);
      }
    }
    requirement.predicates.forEach((predicate, index) => {
      errors.push(...validatePredicate(predicate, `predicates[${index}]`));
    });
  }
  return { valid: errors.length === 0, errors };
}

function validatePredicate(predicate, path) {
  const errors = [];
  if (!isPlainObject(predicate)) return [`${path}: must be an object`];
  if (!REQUIREMENT_TYPES.includes(predicate.kind)) {
    return [`${path}.kind: must be one of ${REQUIREMENT_TYPES.join('|')}`];
  }
  if (predicate.kind === 'condition') {
    if (!isPlainObject(predicate.tree) || isConditionEmpty(predicate.tree)) {
      errors.push(`${path}.tree: required non-empty condition tree`);
    } else errors.push(...validateCondition(predicate.tree, `${path}.tree`).errors);
  } else {
    errors.push(...validateGeometry(predicate.geometry, { context: 'requirement', path: `${path}.geometry` }));
  }
  if (predicate.negate !== undefined && typeof predicate.negate !== 'boolean') {
    errors.push(`${path}.negate: must be a boolean`);
  }
  return errors;
}
