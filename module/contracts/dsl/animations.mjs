/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { say } from './messages.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

/** Step kinds a sequence may contain. */
export const STEP_KINDS = Object.freeze(['effect', 'sound', 'wait', 'tokenAnim']);

/** Range buckets a slot holds a separate sequence for. */
export const RANGE_KINDS = Object.freeze(['melee', 'ranged', 'self']);

/** Occasions an item may carry an animation slot for. */
export const SLOT_KINDS = Object.freeze(['attack', 'critical', 'activation']);

/**
 * Location names a step may anchor to, worked out when the animation plays. `token-facing-target` places at the
 * acting token, as `token` does, and `target-endpoint` falls back to the target, since nothing sets the end point it
 * reads. Only `atLocation` and a tokenAnim's `target` are checked against this list.
 */
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
 * Validate an animation payload, collecting every error rather than throwing on the first. Each message is a plain
 * sentence naming the animation step it is about, numbered from 1 as the cards show them.
 * @param {object} anim  Payload to validate.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(anim) {
  const errors = [];

  if (!isPlainObject(anim)) {
    return { valid: false, errors: [say('the animation', 'cannot be read')] };
  }
  if (!Array.isArray(anim.steps)) {
    errors.push(say('the animation', 'has steps that cannot be read'));
  } else {
    anim.steps.forEach((step, i) => {
      const at = `animation step ${i + 1}`;
      const fail = sentence => errors.push(say(at, sentence));
      if (!isPlainObject(step)) { fail('cannot be read'); return; }
      if (!STEP_KINDS.includes(step.kind)) {
        fail('is a kind of step the system does not know');
        return;
      }
      const allowed = STEP_KEYS_BY_KIND[step.kind];
      for (const key of Object.keys(step)) {
        if (!allowed.has(key)) fail(`has a setting called ${key} that this kind of step does not use`);
      }
      if (step.atLocation && !LOCATION_REFS.includes(step.atLocation)) {
        fail('plays at a place the system does not know');
      }
      if (step.kind === 'tokenAnim' && step.target && !LOCATION_REFS.includes(step.target)) {
        fail('animates a token the system does not know');
      }
      if (step.audioChannel && !AUDIO_CHANNELS.includes(step.audioChannel)) {
        fail('plays on a sound channel the system does not know');
      }
      if (step.layer !== undefined && !LAYER_KINDS.includes(step.layer)) {
        fail('draws on a layer the system does not know');
      }
      if (step.if !== undefined) {
        for (const e of validatePredicate(step.if)) fail(`has a condition that ${e}`);
      }
      if (step.perTarget !== undefined && typeof step.perTarget !== 'boolean') {
        fail('has a per target setting that is not on or off');
      }
    });
  }
  if (anim.duration !== undefined && typeof anim.duration !== 'number') {
    errors.push(say('the animation', 'has a duration that is not a number'));
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * Validate a step's `if` predicate, recursing through `not`. Returns what is wrong with it, each worded to follow
 * `has a condition that`, empty when valid.
 */
function validatePredicate(pred) {
  if (!isPlainObject(pred)) return ['cannot be read'];
  const errors = [];
  for (const key of Object.keys(pred)) {
    if (!PREDICATE_KEYS.has(key)) errors.push(`uses a setting called ${key} it does not know`);
  }
  if (pred.hasEffect !== undefined && typeof pred.hasEffect !== 'string') {
    errors.push('names a status with something other than text');
  }
  if (pred.expr !== undefined && typeof pred.expr !== 'string') {
    errors.push('has an expression that is not text');
  }
  if (pred.not !== undefined) errors.push(...validatePredicate(pred.not));
  return errors;
}

/**
 * Validate every range payload on a slot, opening each range's messages with a sentence naming that range.
 * @param {object|null} [slot]  Slot to validate. A missing slot is valid.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSlot(slot) {
  if (slot === null || slot === undefined) return { valid: true, errors: [] };
  if (!isPlainObject(slot)) return { valid: false, errors: [say('this animation slot', 'cannot be read')] };
  const errors = [];
  for (const range of RANGE_KINDS) {
    const payload = slot[range];
    if (payload === null || payload === undefined) continue;
    const r = validate(payload);
    if (!r.valid) errors.push(...r.errors.map(e => `${say(`the ${range} animation`, 'has a problem')} ${e}`));
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
