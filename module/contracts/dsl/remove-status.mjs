/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** The units a remove status step may act on: the acting unit, the other unit, or every unit on the scene. */
export const REMOVE_TARGETS = Object.freeze(['self', 'target', 'scene']);

/** The unit a scene-wide removal may leave alone. */
export const REMOVE_EXCEPTIONS = Object.freeze(['self', 'target']);

/** How a remove status step picks statuses: one by name, or every status of the kinds it lists. */
export const REMOVE_WHICH = Object.freeze(['name', 'kind']);

/** The kinds a status can be. A status with neither the harmful nor the beneficial flag is neutral. */
export const STATUS_KINDS = Object.freeze(['harmful', 'beneficial', 'neutral']);

/** How much of each matched status comes off: all of it, a number of stacks, or a number of phases. */
export const REMOVE_AMOUNTS = Object.freeze(['all', 'stacks', 'phases']);

/** The units whose applied statuses a remove status step may limit itself to. */
export const REMOVE_APPLIERS = Object.freeze(['self', 'target']);

/**
 * The kind of a status from its system flags: harmful, beneficial, or neutral when it carries neither flag.
 * @param {object} [flags] The effect's `flags.emblem-rpg` object.
 * @returns {string}
 */
export function statusKindOf(flags) {
  if (flags?.harmful === true) return 'harmful';
  if (flags?.beneficial === true) return 'beneficial';
  return 'neutral';
}

/** Whether a value is text with something other than spaces in it. */
function filled(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Whether a value is blank text: empty, or only spaces. */
function blank(value) {
  return typeof value === 'string' && value.trim() === '';
}

/* -------------------------------------------- */
/*  Older steps                                 */
/* -------------------------------------------- */

/** The settings older remove status steps saved, which normalizeRemoveStatus converts and drops. */
const OLD_KEYS = Object.freeze(['scope', 'placedByActor', 'excludeTarget', 'dispelHarmful', 'dispelBeneficial']);

/** The order normalizeRemoveStatus writes a step's own settings in. Any other key follows in its saved order. */
const KEY_ORDER = Object.freeze(['kind', 'target', 'except', 'which', 'name', 'kinds', 'appliedBy', 'amount', 'count']);

/**
 * Bring a remove status step saved in the older shape to the current one, returning a new step. Any other kind of
 * step comes back as it was, and so does a remove status step with none of the old settings, unless it has a status
 * name but no `which`.
 * @param {object} step The step. It is not changed.
 * @returns {{step: object, changed: boolean, ambiguous: boolean}} `changed` is false when the step comes back as it
 *   was. `ambiguous` is true when the old step had both a status name and a dispel box: the name is kept and the
 *   dispel box dropped, so a GM should check the step.
 */
export function normalizeRemoveStatus(step) {
  const same = { step, changed: false, ambiguous: false };
  if (!isPlainObject(step) || step.kind !== 'removeEffect') return same;
  const old = OLD_KEYS.some(key => Object.hasOwn(step, key));
  if (!old && (step.which !== undefined || !filled(step.name))) return same;

  const global = step.scope === 'global';
  const harmful = step.dispelHarmful === true;
  const beneficial = step.dispelBeneficial === true;
  const next = {
    ...Object.fromEntries(KEY_ORDER.map(key => [key, step[key]])),
    target: global ? 'scene' : step.target,
    except: global && step.excludeTarget === true ? 'target' : step.except,
    name: blank(step.name) ? undefined : step.name,
    appliedBy: filled(step.placedByActor) ? step.placedByActor : step.appliedBy
  };
  let ambiguous = false;
  if (next.which === undefined) {
    if (filled(next.name)) {
      next.which = 'name';
      ambiguous = harmful || beneficial;
    } else if (harmful || beneficial) {
      next.which = 'kind';
      next.kinds = [harmful && 'harmful', beneficial && 'beneficial'].filter(Boolean);
    } else if (next.appliedBy !== undefined) {
      // An old step with only placed by set removed every status that unit had put on.
      next.which = 'kind';
      next.kinds = [...STATUS_KINDS];
    }
  }

  const result = {};
  for (const key of KEY_ORDER) if (next[key] !== undefined) result[key] = next[key];
  for (const [key, value] of Object.entries(step)) {
    if (!KEY_ORDER.includes(key) && !OLD_KEYS.includes(key)) result[key] = value;
  }
  return { step: result, changed: true, ambiguous };
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Check a remove status step's own settings: which statuses, applied by, except, amount and count. The unit it acts
 * on is checked in contracts/dsl/effects.mjs, as for every step kind.
 * @param {object} step The step.
 * @returns {string[]} The end of each error sentence, read after the step's place, as in `Step 2 removes a status by
 *   name but gives no name`. Empty when the step is valid.
 */
export function validateRemoveStatus(step) {
  const errors = [];
  // A blank name or an empty kinds list holds nothing, so it does not clash with the other way of choosing.
  const hasName = step.name !== undefined && !blank(step.name);
  const hasKinds = step.kinds !== undefined && !(Array.isArray(step.kinds) && step.kinds.length === 0);
  if (step.which === 'name') {
    if (!filled(step.name)) errors.push('removes a status by name but gives no name');
    if (hasKinds) errors.push('ticks kinds of status but does not remove by kind. Clear them or choose by kind');
  } else if (step.which === 'kind') {
    const kinds = step.kinds;
    if (!Array.isArray(kinds) || kinds.length === 0) {
      errors.push('removes statuses by kind but ticks none of all harmful, all beneficial or all neutral');
    } else if (kinds.some((kind, index) => !STATUS_KINDS.includes(kind) || kinds.indexOf(kind) !== index)) {
      errors.push('removes a kind of status the system does not know. Use harmful, beneficial or neutral');
    }
    if (hasName) errors.push('has a status name but does not remove by name. Clear the name or choose by name');
  } else {
    errors.push('does not say which statuses to remove. Choose by name or by kind');
  }
  if (step.except !== undefined) {
    if (!REMOVE_EXCEPTIONS.includes(step.except)) errors.push('spares a unit other than self or target');
    if (step.target !== 'scene') errors.push('spares a unit but acts on only one unit. Use except with the whole map');
  }
  if (step.appliedBy !== undefined && !REMOVE_APPLIERS.includes(step.appliedBy)) {
    errors.push('only removes statuses applied by a unit other than self or target');
  }
  const amount = step.amount === undefined ? 'all' : step.amount;
  if (!REMOVE_AMOUNTS.includes(amount)) {
    errors.push('removes an amount the system does not know. Use full removal, stacks or phases');
  } else if (amount === 'all' && step.count !== undefined) {
    errors.push('has a count but removes all of each status. Clear the count or choose stacks or phases');
  } else if (step.count !== undefined && !(Number.isInteger(step.count) && step.count >= 1)) {
    errors.push('removes a number of stacks or phases that is not a whole number of 1 or more');
  }
  return errors;
}
