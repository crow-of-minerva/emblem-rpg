/** @layer game/effects */
import { isPopulated } from '../../contracts/dsl/animations.mjs';
import { ENGAGEMENT_KINDS } from '../../contracts/domains/characters.mjs';
import { SafeEval } from '../../lib/core/safe-eval.mjs';
import { evaluateScaling, isScalingActive } from '../items/rules.mjs';

/* -------------------------------------------- */
/*  Animation planning                          */
/* -------------------------------------------- */
/**
 * Pick which variant of an authored animation slot plays: self, melee or ranged, falling back to the other filled-in
 * variants. Called by the combat exchange and item projections, and by the downtime writer for training spars.
 */
export function selectAnimationRange(slot, engagement, { self = false } = {}) {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
  const isSelf = self || !engagement;
  const isMelee = engagement === ENGAGEMENT_KINDS.MELEE;
  const order = isSelf
    ? [slot.self, slot.melee, slot.ranged]
    : isMelee
      ? [slot.melee, slot.ranged]
      : [slot.ranged, slot.melee];
  return order.find(isPopulated) ?? null;
}

/**
 * Turn an animation's authored steps into the steps to play. Steps whose `if` condition fails are dropped, a file
 * list is narrowed to one file using the caller's random values, and cone effects are sized to the item's range.
 * Called by buildSequence in external/sequencer/animation-dispatch.mjs, which reports each entry in `errors`.
 */
export function planAnimationSteps(steps, context, randomValues = []) {
  const planned = [];
  const errors = [];
  for (const [index, source] of Array.from(steps ?? []).entries()) {
    if (!source || typeof source !== 'object') continue;
    const predicate = evaluateAnimationPredicate(source.if, context);
    if (predicate.error) errors.push({ index, code: predicate.error });
    if (!predicate.value) continue;
    const step = { ...source };
    if (step.kind === 'effect' || step.kind === 'sound') {
      step.file = chooseAnimationFile(step.file, randomValues[index]);
    }
    if (step.kind === 'effect' && isConeFile(step.file)) {
      step.coneScaleToObject = Math.max(1.5, animationConeDepth(context) * 1.2);
    }
    planned.push(Object.freeze(step));
  }
  return { steps: planned, errors };
}

/* -------------------------------------------- */
/*  Predicate interpretation                    */
/* -------------------------------------------- */
function evaluateAnimationPredicate(predicate, context) {
  if (predicate === undefined || predicate === null) return { value: true, error: null };
  if (typeof predicate !== 'object' || Array.isArray(predicate)) return { value: true, error: null };
  if (predicate.not !== undefined) {
    const nested = evaluateAnimationPredicate(predicate.not, context);
    return { value: !nested.value, error: nested.error };
  }

  let value = true;
  if (typeof predicate.hasEffect === 'string') {
    value = context?.actor?.effects?.some(effect => (
      effect?.name === predicate.hasEffect || effect?.statusId === predicate.hasEffect
    )) === true;
  }
  if (typeof predicate.expr === 'string') {
    try {
      value = value && Boolean(SafeEval.evaluate(predicate.expr, {
        actor: context?.actor ?? null,
        token: context?.token ?? null,
        target: context?.target ?? null
      }));
    } catch {
      return { value: false, error: 'animation.predicate-expression-invalid' };
    }
  }
  return { value, error: null };
}

/* -------------------------------------------- */
/*  Authored file choice                        */
/* -------------------------------------------- */
function chooseAnimationFile(file, randomValue = 0) {
  const choices = Array.isArray(file)
    ? file.filter(value => typeof value === 'string' && value.length > 0)
    : typeof file === 'string' && file.includes(',')
      ? file.split(',').map(value => value.trim()).filter(Boolean)
      : [];
  if (!choices.length) return file ?? null;
  const chance = Math.max(0, Math.min(0.999999999, Number(randomValue) || 0));
  return choices[Math.floor(chance * choices.length)];
}

/* -------------------------------------------- */
/*  Rule-derived scaling                        */
/* -------------------------------------------- */
function animationConeDepth(context) {
  const actorSystem = context?.actor?.system ?? {};
  const effectData = context?.activeItem?.system?.effectData;
  if (!effectData) return 2;
  let range = effectData.rng;
  if (isScalingActive(effectData.rngScaling)) {
    const base = Number.parseInt(effectData.rng, 10);
    if (!Number.isNaN(base)) range = evaluateScaling(actorSystem, base, effectData.rngScaling);
  }
  const depth = Number.parseInt(range, 10);
  return Number.isFinite(depth) ? depth : 2;
}

function isConeFile(file) {
  return typeof file === 'string' && /\bcone\b/i.test(file);
}
