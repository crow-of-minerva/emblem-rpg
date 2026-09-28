/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

/** Step kinds a sequence may contain. */
export const STEP_KINDS = Object.freeze(['effect', 'sound', 'wait', 'tokenAnim']);

/** Range buckets a slot holds a separate sequence for. */
export const RANGE_KINDS = Object.freeze(['melee', 'ranged', 'self']);

/** Occasions an item may carry an animation slot for. */
export const SLOT_KINDS = Object.freeze(['attack', 'critical', 'activation']);

/** Symbolic locations a step may anchor to, resolved against the live sequence context at play time. */
const LOCATION_REFS = Object.freeze([
  'token',
  'target',
  'token-facing-target',
  'target-endpoint',
  'target-location',

  // The token that the effect's most recent spawnToken step placed.
  'lastSpawned'
]);

/** Foundry audio channels a `sound` step may play on. */
const AUDIO_CHANNELS = Object.freeze(['environment', 'interface', 'music']);

/**
 * Sequencer layers accepted by animation authoring. null lets Sequencer choose the layer and apply zIndex
 * ordering.
 */
const LAYER_KINDS = Object.freeze([null, 'aboveInterface', 'aboveLighting', 'belowTokens']);

/* -------------------------------------------- */
/*  Step Schema                                 */
/* -------------------------------------------- */

/** Keys every step kind accepts. */
const SHARED_KEYS = new Set(['kind', 'delay', 'duration', 'repeats', 'waitUntilFinished', 'if', 'perTarget']);

/** Keys accepted inside a step's `if` predicate. */
const PREDICATE_KEYS = new Set(['hasEffect', 'expr', 'not']);

/** Keys accepted by an `effect` step, on top of the shared ones. */
const EFFECT_KEYS = new Set([
  'file', 'atLocation', 'attachTo', 'stretchTo', 'rotateTowards', 'rotate',
  'moveTowards', 'moveSpeed', 'snapToGrid',
  'spriteOffset', 'scale', 'scaleToObject', 'playbackRate', 'opacity', 'tint', 'hue',
  'zIndex', 'center', 'mirrorX', 'mirrorY', 'randomizeMirrorX', 'randomizeMirrorY',
  'randomRotation', 'fadeIn', 'fadeOut', 'rotateIn', 'rotateOut',
  'startTime', 'endTime', 'timeRange', 'layer', 'filter',

  // Keep an effect after the sequence ends, name it, or tie it to the anchored unit's active effect of that name.
  'persist', 'name', 'tieToEffectName'
]);

/** Keys accepted by a `sound` step, on top of the shared ones. */
const SOUND_KEYS = new Set([
  'file', 'audioChannel', 'volume', 'fadeInAudio', 'fadeOutAudio',
  'startTime', 'endTime', 'timeRange'
]);

/** Keys accepted by a `wait` step, on top of the shared ones. */
const WAIT_KEYS = new Set(['ms']);

/** Keys accepted by a `tokenAnim` step, on top of the shared ones. */
const TOKEN_ANIM_KEYS = new Set(['target', 'opacity', 'rotation', 'fadeIn', 'fadeOut']);

/**
 * The full accepted key set per step kind. Validation is a strict allowlist, so a typo in an authored step
 * surfaces as an error rather than being silently dropped by Sequencer.
 */
const STEP_KEYS_BY_KIND = {
  effect:    new Set([...SHARED_KEYS, ...EFFECT_KEYS]),
  sound:     new Set([...SHARED_KEYS, ...SOUND_KEYS]),
  wait:      new Set([...SHARED_KEYS, ...WAIT_KEYS]),
  tokenAnim: new Set([...SHARED_KEYS, ...TOKEN_ANIM_KEYS])
};

/* -------------------------------------------- */
/*  Factory Methods                             */
/* -------------------------------------------- */

/** Create an empty animation payload. */
export function empty() {
  return { steps: [] };
}

/** Create an empty slot with no sequence bound to any range. */
export function emptySlot() {
  return { melee: null, ranged: null, self: null };
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Validate an animation payload, collecting every error rather than throwing on the first.
 * @param {object} anim  Payload to validate.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(anim) {
  const errors = [];

  if (!isPlainObject(anim)) {
    return { valid: false, errors: ['root must be an object'] };
  }
  if (!Array.isArray(anim.steps)) {
    errors.push('steps must be an array');
  } else {
    anim.steps.forEach((step, i) => {
      const at = `steps[${i}]`;
      if (!isPlainObject(step)) { errors.push(`${at} must be an object`); return; }
      if (!STEP_KINDS.includes(step.kind)) {
        errors.push(`${at}.kind must be one of ${STEP_KINDS.join('|')}`);
        return;
      }
      const allowed = STEP_KEYS_BY_KIND[step.kind];
      for (const key of Object.keys(step)) {
        if (!allowed.has(key)) errors.push(`${at}: unknown key "${key}" for kind "${step.kind}"`);
      }
      if (step.atLocation && !LOCATION_REFS.includes(step.atLocation)) {
        errors.push(`${at}.atLocation: unknown ref "${step.atLocation}"`);
      }
      if (step.kind === 'tokenAnim' && step.target && !LOCATION_REFS.includes(step.target)) {
        errors.push(`${at}.target: unknown ref "${step.target}"`);
      }
      if (step.audioChannel && !AUDIO_CHANNELS.includes(step.audioChannel)) {
        errors.push(`${at}.audioChannel: unknown channel "${step.audioChannel}"`);
      }
      if (step.layer !== undefined && !LAYER_KINDS.includes(step.layer)) {
        errors.push(`${at}.layer: must be one of ${LAYER_KINDS.join('|')}`);
      }
      if (step.if !== undefined) {
        const predErrors = validatePredicate(step.if);
        for (const e of predErrors) errors.push(`${at}.if: ${e}`);
      }
      if (step.perTarget !== undefined && typeof step.perTarget !== 'boolean') {
        errors.push(`${at}.perTarget: must be a boolean`);
      }
    });
  }
  if (anim.duration !== undefined && typeof anim.duration !== 'number') {
    errors.push('duration must be a number');
  }

  return { valid: errors.length === 0, errors };
}

/** Validate a step's `if` predicate, recursing through `not`. Returns the errors, empty when valid. */
function validatePredicate(pred) {
  if (!isPlainObject(pred)) return ['must be an object'];
  const errors = [];
  for (const key of Object.keys(pred)) {
    if (!PREDICATE_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }
  if (pred.hasEffect !== undefined && typeof pred.hasEffect !== 'string') {
    errors.push('hasEffect must be a string');
  }
  if (pred.expr !== undefined && typeof pred.expr !== 'string') {
    errors.push('expr must be a string');
  }
  if (pred.not !== undefined) {
    for (const e of validatePredicate(pred.not)) errors.push(`not: ${e}`);
  }
  return errors;
}

/**
 * Validate every range payload on a slot, prefixing each error with its range.
 * @param {object|null} [slot]  Slot to validate. A missing slot is valid.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSlot(slot) {
  if (slot === null || slot === undefined) return { valid: true, errors: [] };
  if (!isPlainObject(slot)) return { valid: false, errors: ['slot must be an object'] };
  const errors = [];
  for (const range of RANGE_KINDS) {
    const payload = slot[range];
    if (payload === null || payload === undefined) continue;
    const r = validate(payload);
    if (!r.valid) errors.push(...r.errors.map(e => `${range}: ${e}`));
  }
  return { valid: errors.length === 0, errors };
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Whether a payload is worth playing: it has at least one step. */
export function isPopulated(anim) {
  if (!isPlainObject(anim)) return false;
  return Array.isArray(anim.steps) && anim.steps.length > 0;
}
