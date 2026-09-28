/** @layer game/effects */
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { normalizeGeometry } from '../../contracts/dsl/terrain-geometry.mjs';
import { MAGIC_PROFICIENCIES } from '../../contracts/domains/items.mjs';
import { evaluate as evaluateConditionTree, referencesTarget } from './conditions.mjs';

/* -------------------------------------------- */
/*  Magic Rules                                 */
/* -------------------------------------------- */

/**
 * Whether Silence stops the unit using the item, because a Silenced unit cannot use a magic item. Used by
 * checkCaster and by the attack grid (game/targeting/attack-grid.mjs).
 * @param {{silenced?: boolean, statuses?: readonly string[]}} actor
 * @param {{type?: string, requiredProficiency?: string}} item
 * @returns {boolean}
 */
export function isMagicBlocked(actor, item) {
  const statuses = Array.isArray(actor?.statuses) ? actor.statuses : [];
  const silenced = actor?.silenced === true || statuses.some(status => String(status).toLowerCase() === 'silenced');
  return silenced && isMagicItem(item);
}

/**
 * Whether an item is magic: a Spell always is, and so is anything that needs a magic school. Silence blocks a magic
 * item in attacks, item activation and the caster check. Advantage on saves against magic applies only against a
 * magic item.
 * @param {{type?: string, requiredProficiency?: string}} item Its document type and authored proficiency.
 * @returns {boolean}
 */
export function isMagicItem(item) {
  return String(item?.type ?? '') === 'Spell'
    || MAGIC_PROFICIENCIES.includes(String(item?.requiredProficiency ?? '').trim().toLowerCase());
}

/* -------------------------------------------- */
/*  Requirement Evaluation                      */
/* -------------------------------------------- */

/**
 * Check the requirements that read only the caster, and Silence against a magic item. Used by
 * validateActivationRequirements (game/items/activation.mjs), equipment requirements (game/character/inventory.mjs)
 * and the attack-targeting projection. A bare authored path reads the caster, as the `caster` root does.
 * @param {object} input
 * @returns {{ok: boolean, failedIds: string[], failedNames: string[], evaluationErrors: object[], silenced: boolean}}
 */
export function checkCaster(input = {}) {
  const requirements = Array.isArray(input.requirements) ? input.requirements : [];
  const context = {
    ...(isPlainObject(input.caster) ? input.caster : {}),
    actor: input.caster, self: input.caster, caster: input.caster, casterPlacement: input.casterPlacement,
    resolveTerrainGeometry: input.resolveTerrainGeometry, chanceRoll: input.chanceRoll
  };
  const result = evaluateRequirements(requirements.filter(req => !readsTarget(req)), context);
  const silenced = isMagicBlocked(input.caster, input.item);
  return { ok: result.failedIds.length === 0 && !silenced, ...result, silenced };
}

/**
 * Check the requirements that read a target, once for each target. Used by validateActivationRequirements and the
 * attack-targeting projection. A bare authored path still reads the caster, and the target is read through the
 * `target` root.
 * @param {object} input
 * @returns {{ok: boolean, failingTargets: {targetId: string|null, name: string, failedIds: string[]}[],
 *   evaluationErrors: object[]}}
 */
export function checkTargets(input = {}) {
  const requirements = Array.isArray(input.requirements) ? input.requirements.filter(readsTarget) : [];
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const failingTargets = [];
  const evaluationErrors = [];
  for (const target of targets) {
    const result = evaluateRequirements(requirements, {
      ...(isPlainObject(input.caster) ? input.caster : {}),
      actor: target?.actor, self: input.caster, caster: input.caster, target: target?.actor,
      targetId: target?.id ?? null,
      casterPlacement: input.casterPlacement, targetPlacement: target?.placement,
      targetLocation: input.targetLocation, resolveTerrainGeometry: input.resolveTerrainGeometry,
      chanceRoll: input.chanceRoll
    });
    evaluationErrors.push(...result.evaluationErrors.map(error => ({ ...error, targetId: target?.id ?? null })));
    if (result.failedIds.length > 0) {
      failingTargets.push({
        targetId: target?.id ?? null,
        name: String(target?.name ?? target?.actor?.name ?? ''),
        failedIds: result.failedIds
      });
    }
  }
  return { ok: failingTargets.length === 0, failingTargets, evaluationErrors };
}

/* -------------------------------------------- */
/*  Private Evaluation                          */
/* -------------------------------------------- */

/**
 * Whether a requirement is checked per target by `checkTargets` rather than once by `checkCaster`. A requirement
 * says so through its content: a condition tree that names the target, or a geometry that is anchored on or places
 * anything but the caster.
 */
function readsTarget(requirement) {
  if (!isPlainObject(requirement)) return false;
  const predicates = Array.isArray(requirement.predicates) ? requirement.predicates : [];
  return predicates.some(predicate => {
    if (predicate?.kind === 'condition') return referencesTarget(predicate.tree);
    if (predicate?.kind !== 'terrainGeometry') return false;
    const geometry = normalizeGeometry(predicate.geometry);
    return geometry.anchor !== 'self' || geometry.mover === 'target';
  });
}

function evaluateRequirements(requirements, context) {
  const failedIds = [];
  const failedNames = [];
  const evaluationErrors = [];
  for (let index = 0; index < requirements.length; index++) {
    const requirement = requirements[index];
    const result = evaluateRequirement(requirement, context);
    if (!result.ok) {
      failedIds.push(String(requirement?.id ?? requirement?.name ?? index));
      const name = String(requirement?.name ?? '').trim();
      if (name) failedNames.push(name);
    }
    evaluationErrors.push(...result.errors.map(error => ({ requirementId: requirement?.id ?? null, ...error })));
  }
  return { failedIds, failedNames, evaluationErrors };
}

function evaluateRequirement(requirement, context) {
  if (!isPlainObject(requirement)) return { ok: true, errors: [] };
  const predicates = Array.isArray(requirement.predicates) ? requirement.predicates : [];
  const errors = [];
  for (let index = 0; index < predicates.length; index++) {
    const result = evaluatePredicate(predicates[index], context);
    if (result.error) errors.push({ predicateIndex: index, code: result.error });
    if (!result.value) return { ok: false, errors };
  }
  return { ok: true, errors };
}

function evaluatePredicate(predicate, context) {
  if (!isPlainObject(predicate)) return { value: true, error: null };
  let value = true;
  let error = null;
  try {
    if (predicate.kind === 'condition') {
      value = evaluateConditionTree(predicate.tree, context, context.chanceRoll) === true;
    } else if (predicate.kind === 'terrainGeometry') {
      value = evaluateGeometryPredicate(predicate, context);
    }
  } catch {
    value = false;
    error = 'evaluation-failed';
  }
  return { value: predicate.negate === true ? !value : value, error };
}

function evaluateGeometryPredicate(predicate, context) {
  if (typeof context.resolveTerrainGeometry !== 'function') return false;
  const geometry = normalizeGeometry(predicate.geometry);
  const anchor = geometry.anchor === 'self'
    ? context.casterPlacement
    : geometry.anchor === 'targetLocation' ? context.targetLocation : context.targetPlacement;
  const mover = geometry.mover === 'target'
    ? context.targetPlacement && { ...context.targetPlacement, side: 'target', id: context.targetId ?? null }
    : geometry.mover === 'custom'
      ? { width: geometry.moverWidth, height: geometry.moverHeight, side: 'custom' }
      : context.casterPlacement && { ...context.casterPlacement, side: 'self' };
  if (!anchor || !mover) return false;
  const result = context.resolveTerrainGeometry({ anchor, mover, spec: geometry });
  return Number(result?.count ?? 0) >= geometry.minCount;
}
