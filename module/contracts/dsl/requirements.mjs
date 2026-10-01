/** @layer contracts/dsl */
import { isEmpty as isConditionEmpty, validate as validateCondition } from './conditions.mjs';
import { defaultGeometry, validateGeometry } from './terrain-geometry.mjs';
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { placeOf, say } from './messages.mjs';

/** Every message here is about the one requirement being edited. */
const REQUIREMENT = 'this requirement';

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
/** Validate a serializable requirement and the predicate beneath it. Each message is a plain sentence. */
export function validate(requirement) {
  const errors = [];
  const fail = sentence => errors.push(say(REQUIREMENT, sentence));
  if (!isPlainObject(requirement)) return { valid: false, errors: [say(REQUIREMENT, 'cannot be read')] };
  if (!REQUIREMENT_TYPES.includes(requirement.type)) fail('is a kind of requirement the system does not know');
  if (requirement.name !== undefined && typeof requirement.name !== 'string') fail('has a name that is not text');
  if (!Array.isArray(requirement.predicates)) fail('has nothing it can check');
  else {
    if (REQUIREMENT_TYPES.includes(requirement.type)) {
      const { type, predicates } = requirement;
      if (predicates.length !== 1 || predicates[0]?.kind !== type) {
        fail(`must hold exactly one ${type === 'condition' ? 'condition' : 'placement rule'}`);
      }
    }
    requirement.predicates.forEach((predicate, index) => {
      errors.push(...validatePredicate(predicate, `predicates[${index}]`));
    });
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validatePredicate(predicate, path) {
  const errors = [];
  if (!isPlainObject(predicate)) return [say(REQUIREMENT, 'has a check that cannot be read')];
  if (!REQUIREMENT_TYPES.includes(predicate.kind)) {
    return [say(REQUIREMENT, 'has a check of a kind the system does not know')];
  }
  if (predicate.kind === 'condition') {
    if (!isPlainObject(predicate.tree) || isConditionEmpty(predicate.tree)) {
      errors.push(say(placeOf(`${path}.tree`), 'is empty'));
    } else errors.push(...validateCondition(predicate.tree, `${path}.tree`).errors);
  } else {
    errors.push(...validateGeometry(predicate.geometry, { context: 'requirement', path: `${path}.geometry` }));
  }
  if (predicate.negate !== undefined && typeof predicate.negate !== 'boolean') {
    errors.push(say(REQUIREMENT, 'has a negate setting that is not on or off'));
  }
  return errors;
}
