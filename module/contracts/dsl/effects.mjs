/** @layer contracts/dsl */
import { DAMAGE_TYPES } from '../domains/damage.mjs';
import { validate as validateAnimation } from './animations.mjs';
import { DEFAULT_STATUS_DURATION, FACTION_ROLES, REGISTERED_STATUS_KEYS } from '../domains/characters.mjs';
import { validateGeometry } from './terrain-geometry.mjs';
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { validate as validateConditionTree } from './conditions.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

const VOICE_CATEGORY_KEYS = Object.freeze([
  'select', 'crit', 'thanks', 'rally', 'injured', 'defeat', 'levelGood', 'levelBad'
]);

/**
 * Schema version stamped on every effect payload. Payloads carrying any other version are rejected rather than
 * migrated.
 */
export const EFFECT_VERSION = 2;

/** Every step kind the effect editor can author and effect execution runs. */
export const STEP_KINDS = Object.freeze([
  'damage', 'heal', 'modShield',
  'applyEffect', 'removeEffect', 'setFaction',
  'animation', 'floatingText', 'playVoice',

  'moveToken', 'spawnToken', 'despawnToken', 'restoreAction', 'playResist',
  'refreshPathfinding',
  'unequip',
  'guard',
  'terrainEdit',
  'if', 'wait', 'expr'
]);

/** Hazard types a `terrainEdit` step may paint onto a tile. Healing is a hazard slot that ticks upward. */
export const TERRAIN_EDIT_HAZARD_TYPES = Object.freeze(['healing', ...DAMAGE_TYPES]);

/** `terrainEdit` fields validated as numbers. Everything else on the step is a string, boolean or preset name. */
const TERRAIN_EDIT_NUMERIC_KEYS = Object.freeze([
  'duration', 'eva', 'def', 'res', 'mov', 'variable', 'stn',
  'vfxScale', 'vfxOpacity', 'vfxRotation',
  'lightDim', 'lightBright', 'lightAlpha', 'lightAnimSpeed', 'lightAnimIntensity',
  'lightColoration', 'lightLuminosity', 'lightAttenuation', 'lightSaturation',
  'lightContrast', 'lightShadows'
]);

/**
 * Movement modes accepted by effect execution. Forced steps use board crossing rules: walk level ground,
 * resolve drops with a check and fall, and leave the unit in place when the destination blocks it.
 */
const MOVE_MODES = Object.freeze(['teleport', 'push', 'pull', 'swap', 'shift', 'terrainGeometry']);

/** Spent resources a `restoreAction` step may hand back. */
const RESTORABLE_ACTIONS = Object.freeze(['standard', 'bonus', 'movement', 'turn']);

/** Symbolic token references a step may address. */
export const TOKEN_REFS = Object.freeze(['self', 'target']);

/** Preset names older effects may still use. Validation accepts them, but its errors list only EFFECT_PRESETS. */
const LEGACY_EFFECT_PRESETS = Object.freeze(['covertPenalty', 'burning', 'bleeding']);

/** Presets an `applyEffect` step may name: every registered status, plus a hand-authored `custom` payload. */
const EFFECT_PRESETS = Object.freeze([...REGISTERED_STATUS_KEYS, 'custom']);

/** Every preset validation accepts, current and legacy. */
const ALL_EFFECT_PRESETS = Object.freeze([...EFFECT_PRESETS, ...LEGACY_EFFECT_PRESETS]);

/* -------------------------------------------- */
/*  Trigger vocabulary                          */
/* -------------------------------------------- */

export const ATTACK_EFFECT_TRIGGERS = Object.freeze([
  'preCombat', 'onHit', 'onCrit', 'onHitOrCrit', 'onMiss',
  'onStruck', 'onEvade', 'postCombat', 'onKill'
]);

export const ACTIVATION_EFFECT_TRIGGERS = Object.freeze([
  'onActivation', 'onFailedSave', 'onSucceedSave', 'onFailedCheck', 'onSucceedCheck'
]);

export const PASSIVE_EFFECT_TRIGGERS = Object.freeze([
  'onPhaseBegin', 'onPhaseEnd', 'onDeath', 'onKill', 'onEvade', 'onUseItem'
]);

export const LEGACY_EFFECT_TRIGGERS = Object.freeze(['onActivate']);

const EFFECT_TRIGGER_KEYS = Object.freeze([
  ...new Set([
    ...ATTACK_EFFECT_TRIGGERS,
    ...ACTIVATION_EFFECT_TRIGGERS,
    ...PASSIVE_EFFECT_TRIGGERS,
    ...LEGACY_EFFECT_TRIGGERS
  ])
]);

/* -------------------------------------------- */
/*  Step Schema                                 */
/* -------------------------------------------- */

/** Keys every step kind accepts. */
const SHARED_KEYS = new Set(['kind', 'delay']);

/**
 * The full accepted key set per step kind. Validation is a strict allowlist, so a typo in an authored step
 * surfaces as an error rather than being silently ignored by effect execution.
 */
const STEP_KEYS_BY_KIND = {
  damage:        new Set([...SHARED_KEYS, 'target', 'formula', 'dmgType', 'brk', 'alt', 'isCrit']),
  heal:          new Set([...SHARED_KEYS, 'target', 'formula', 'stnAmount']),
  modShield:     new Set([...SHARED_KEYS, 'target', 'formula', 'cap']),
  applyEffect:   new Set([...SHARED_KEYS, 'target', 'preset', 'customData', 'linkAnimationTag', 'durationPhases', 'durationStacks']),
  setFaction:    new Set([...SHARED_KEYS, 'target', 'actorType', 'grantOwnership']),
  removeEffect:  new Set([...SHARED_KEYS, 'target', 'name', 'scope', 'placedByActor', 'excludeTarget', 'dispelHarmful', 'dispelBeneficial']),
  animation:     new Set([...SHARED_KEYS, 'animation', 'persistent', 'tag', 'attachToEffectName', 'attachTarget', 'await']),
  floatingText:  new Set([...SHARED_KEYS, 'target', 'text', 'color', 'fontSize', 'offsetY', 'durationMs']),
  moveToken:     new Set([...SHARED_KEYS, 'target', 'mode', 'distance', 'location', 'pair', 'dx', 'dy', 'bypassWalls', 'geometry']),
  spawnToken:    new Set([...SHARED_KEYS, 'actorUuid', 'location', 'name', 'rotation', 'tokenOverrides', 'isFriendly', 'grantOwnership', 'summoningSickness']),
  despawnToken:  new Set([...SHARED_KEYS, 'filter']),
  restoreAction: new Set([...SHARED_KEYS, 'target', 'actions']),
  playResist:    new Set([...SHARED_KEYS, 'target']),
  playVoice:     new Set([...SHARED_KEYS, 'target', 'category', 'skipIfSelf']),
  refreshPathfinding: new Set([...SHARED_KEYS, 'target']),
  unequip:       new Set([...SHARED_KEYS, 'target']),
  guard:         new Set([...SHARED_KEYS, 'target']),
  terrainEdit:   new Set([...SHARED_KEYS, 'target',
    'overwrite', 'duration', 'replacePrevious', 'presetTile',
    'eva', 'def', 'res', 'mov',
    'effect', 'variable', 'stn', 'canKillPlayer',
    'vfxEffect', 'vfxScale', 'vfxOpacity', 'vfxRotation', 'vfxMirrorX', 'vfxMirrorY',
    'lightDim', 'lightBright', 'lightColor', 'lightAlpha', 'lightAnimType',
    'lightWalls', 'lightAnimSpeed', 'lightAnimIntensity', 'lightVision', 'lightColoration',
    'lightLuminosity', 'lightAttenuation', 'lightSaturation', 'lightContrast', 'lightShadows'
  ]),
  if:            new Set([...SHARED_KEYS, 'condition', 'then', 'else']),
  wait:          new Set([...SHARED_KEYS, 'ms']),
  expr:          new Set([...SHARED_KEYS, 'expr'])
};

/** Faction filters an area token reference may narrow to. */
export const AREA_FACTIONS = Object.freeze(['all', 'enemies', 'allies', 'enemiesAndNeutrals']);

/** Factions a `setFaction` step may switch a token to. */
export const ACTOR_TYPES = FACTION_ROLES;

/* -------------------------------------------- */
/*  Factory Methods                             */
/* -------------------------------------------- */

/** Create an empty effect payload at the current schema version. */
export function empty() {
  return { version: EFFECT_VERSION, steps: [] };
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Whether an animation payload anchors itself to a token spawned earlier in the same sequence. Such an animation
 * has a lifetime even without a tag, which is why the persistent-animation tag rule allows it.
 */
function attachesToSpawnedToken(anim) {
  if (!isPlainObject(anim) || !Array.isArray(anim.steps)) return false;
  return anim.steps.some(s => isPlainObject(s)
    && s.kind === 'effect'
    && (s.attachTo === 'lastSpawned' || s.atLocation === 'lastSpawned'));
}

/** Whether a payload is worth running: current version, with at least one step. */
export function isPopulated(action) {
  if (!isPlainObject(action)) return false;
  if (action.version !== EFFECT_VERSION) return false;
  return Array.isArray(action.steps) && action.steps.length > 0;
}

/** Whether a value addresses a token: a symbolic name, an expression, or an area query. */
function isTokenRef(v) {
  if (typeof v === 'string') return TOKEN_REFS.includes(v);
  if (isPlainObject(v) && typeof v.expr === 'string') return true;
  if (isPlainObject(v) && isPlainObject(v.area)) return true;
  return false;
}

/**
 * Validate an effect payload, collecting every error rather than throwing on the first. The effect editor
 * (ui/apps/sheets/item/editors/effects.mjs) and validateEffectEntry call it.
 * @param {object|null} [action] The payload. A missing payload is valid.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(action) {
  if (action === null || action === undefined) return { valid: true, errors: [] };
  if (!isPlainObject(action)) return { valid: false, errors: ['root: must be an object'] };
  const errors = [];
  if (action.version !== EFFECT_VERSION) {
    errors.push(`unsupported version ${action.version} (expected ${EFFECT_VERSION})`);
  }
  if (!Array.isArray(action.steps)) {
    errors.push('steps: must be an array');
  } else {
    action.steps.forEach((step, i) => errors.push(...validateStep(step, `steps[${i}]`)));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate one step against the rules of its kind, recursing into an `if` step's branches.
 * @param {object} step  Step to validate.
 * @param {string} path  Dotted path used to prefix error messages.
 * @returns {string[]}   Collected error strings, empty when valid.
 */
function validateStep(step, path) {
  const errors = [];
  if (!isPlainObject(step)) return [`${path}: must be an object`];
  if (!STEP_KINDS.includes(step.kind)) {
    return [`${path}.kind: must be one of ${STEP_KINDS.join('|')}`];
  }
  const allowed = STEP_KEYS_BY_KIND[step.kind];
  for (const key of Object.keys(step)) {
    if (!allowed.has(key)) errors.push(`${path}: unknown key "${key}" for kind "${step.kind}"`);
  }
  switch (step.kind) {
    case 'damage':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (typeof step.formula !== 'string' || step.formula.trim() === '') errors.push(`${path}.formula: required`);
      if (typeof step.dmgType !== 'string' || step.dmgType.trim() === '') errors.push(`${path}.dmgType: required`);
      break;
    case 'heal':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (typeof step.formula !== 'string' || step.formula.trim() === '') errors.push(`${path}.formula: required`);
      break;
    case 'modShield':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (typeof step.formula !== 'string' && typeof step.formula !== 'number') errors.push(`${path}.formula: required`);
      break;
    case 'applyEffect':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (step.preset && !ALL_EFFECT_PRESETS.includes(step.preset)) {
        errors.push(`${path}.preset: must be one of ${EFFECT_PRESETS.join('|')}`);
      }
      if (step.preset === 'custom' && !isPlainObject(step.customData)) {
        errors.push(`${path}.customData: required when preset === "custom"`);
      }
      if (step.durationPhases !== undefined) {
        const d = Number(step.durationPhases);
        if (!Number.isFinite(d) || d < 1) {
          errors.push(`${path}.durationPhases: must be a number >= 1 (omit to use ${DEFAULT_STATUS_DURATION})`);
        }
      }
      break;
    case 'setFaction':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (!ACTOR_TYPES.includes(step.actorType)) {
        errors.push(`${path}.actorType: must be one of ${ACTOR_TYPES.join('|')}`);
      }
      break;
    case 'removeEffect':
      // A global removal sweeps the whole Scene, so EffectExecutionService doesn't read a target.
      if (step.scope !== 'global' && !isTokenRef(step.target)) {
        errors.push(`${path}.target: must be a TokenRef`);
      }
      break;
    case 'animation':
      if (!isPlainObject(step.animation)) {
        errors.push(`${path}.animation: must be an AnimPayload object`);
      } else {
        const r = validateAnimation(step.animation);
        for (const e of r.errors) errors.push(`${path}.animation: ${e}`);
      }
      if (step.persistent === true
          && !(typeof step.tag === 'string' && step.tag.trim() !== '')
          && !attachesToSpawnedToken(step.animation)) {
        errors.push(`${path}.tag: required for a persistent animation. Set the tag that a matching applyEffect step \
uses as its linkAnimationTag, or attach an effect step to "lastSpawned"`);
      }
      break;
    case 'floatingText':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (typeof step.text !== 'string') errors.push(`${path}.text: required`);
      break;
    case 'moveToken':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (!MOVE_MODES.includes(step.mode)) {
        errors.push(`${path}.mode: must be one of ${MOVE_MODES.join('|')}`);
      }
      if (step.mode === 'terrainGeometry') {
        errors.push(...validateGeometry(step.geometry, { context: 'step', path: `${path}.geometry` }));
      }
      if (step.mode === 'teleport' && step.location === undefined) {
        errors.push(`${path}.location: required when mode === "teleport"`);
      }
      if (step.mode === 'shift') {
        if (step.dx === undefined && step.dy === undefined) {
          errors.push(`${path}: shift mode requires at least one of dx, dy`);
        }
      }
      break;
    case 'spawnToken':
      if (typeof step.actorUuid !== 'string' || step.actorUuid.trim() === '') {
        errors.push(`${path}.actorUuid: required`);
      }
      if (step.location === undefined) errors.push(`${path}.location: required`);
      break;
    case 'despawnToken':
      if (!isPlainObject(step.filter) || typeof step.filter.flagPath !== 'string') {
        errors.push(`${path}.filter: required { flagPath: string, value: literal|{expr} }`);
      }
      break;
    case 'restoreAction':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (!Array.isArray(step.actions) || step.actions.length === 0) {
        errors.push(`${path}.actions: required, non-empty array`);
      } else {
        for (const a of step.actions) {
          if (!RESTORABLE_ACTIONS.includes(a)) {
            errors.push(`${path}.actions: "${a}" must be one of ${RESTORABLE_ACTIONS.join('|')}`);
          }
        }
      }
      break;
    case 'playResist':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      break;
    case 'playVoice':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (!VOICE_CATEGORY_KEYS.includes(step.category)) {
        errors.push(`${path}.category: must be one of ${VOICE_CATEGORY_KEYS.join('|')}`);
      }
      break;
    case 'refreshPathfinding':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      break;
    case 'unequip':
      if (!isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      break;
    case 'guard':
      if (step.target !== 'target') errors.push(`${path}.target: 'guard' may only run on 'target'`);
      break;
    case 'terrainEdit': {
      if (step.target !== undefined && !isTokenRef(step.target)) errors.push(`${path}.target: must be a TokenRef`);
      if (step.target?.area?.includeCenter !== undefined && typeof step.target.area.includeCenter !== 'boolean') {
        errors.push(`${path}.target.area.includeCenter: must be a boolean`);
      }
      for (const k of TERRAIN_EDIT_NUMERIC_KEYS) {
        if (step[k] !== undefined && !Number.isFinite(Number(step[k]))) {
          errors.push(`${path}.${k}: must be a number`);
        }
      }
      if (step.duration !== undefined && Number(step.duration) < 0) {
        errors.push(`${path}.duration: must be >= 0 (0 = permanent)`);
      }
      if (step.effect !== undefined && step.effect !== '' && !TERRAIN_EDIT_HAZARD_TYPES.includes(step.effect)) {
        errors.push(`${path}.effect: must be one of ${TERRAIN_EDIT_HAZARD_TYPES.join('|')}`);
      }
      if (step.presetTile !== undefined && (typeof step.presetTile !== 'string' || step.presetTile.trim() === '')) {
        errors.push(`${path}.presetTile: must be a non-empty preset name`);
      }
      const hasStat = ['eva', 'def', 'res', 'mov'].some(k => step[k] !== undefined);
      const hasHazard = typeof step.effect === 'string' && step.effect !== '';
      const hasVfx = typeof step.vfxEffect === 'string' && step.vfxEffect.trim() !== '';
      const hasLight = Number(step.lightDim) > 0 || Number(step.lightBright) > 0;
      if (!hasStat && !hasHazard && !hasVfx && !hasLight) {
        errors.push(`${path}: must set at least one terrain parameter (stat, effect, vfx, or light)`);
      }
      break;
    }
    case 'if': {
      const r = validateConditionTree(step.condition, `${path}.condition`);
      for (const e of r.errors) errors.push(e);
      if (!Array.isArray(step.then)) {
        errors.push(`${path}.then: must be an array of steps`);
      } else {
        step.then.forEach((s, i) => errors.push(...validateStep(s, `${path}.then[${i}]`)));
      }
      if (step.else !== undefined) {
        if (!Array.isArray(step.else)) errors.push(`${path}.else: must be an array of steps`);
        else step.else.forEach((s, i) => errors.push(...validateStep(s, `${path}.else[${i}]`)));
      }
      break;
    }
    case 'wait':
      if (typeof step.ms !== 'number' && typeof step.ms !== 'string') errors.push(`${path}.ms: required`);
      break;
    case 'expr':
      if (typeof step.expr !== 'string' || step.expr.trim() === '') errors.push(`${path}.expr: required`);
      break;
  }
  return errors;
}

/* -------------------------------------------- */
/*  Entry validation                            */
/* -------------------------------------------- */

/**
 * Validate one authored effect entry and its nested action. game/effects/planning.mjs checks every entry with it
 * before planning.
 * @param {*} entry The authored entry.
 * @param {string} [path] Prefix for error messages.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateEffectEntry(entry, path = 'entry') {
  if (!isPlainObject(entry)) return { valid: false, errors: [`${path}: must be an object`] };
  const errors = [];
  if (!EFFECT_TRIGGER_KEYS.includes(entry.trigger)) {
    errors.push(`${path}.trigger: must be one of ${EFFECT_TRIGGER_KEYS.join('|')}`);
  }
  if (entry.name !== undefined && typeof entry.name !== 'string') {
    errors.push(`${path}.name: must be a string`);
  }
  if (entry.failedSave !== undefined && entry.failedSave !== null && typeof entry.failedSave !== 'boolean') {
    errors.push(`${path}.failedSave: must be boolean or null`);
  }
  validateStringList(entry.itemNames, `${path}.itemNames`, errors);
  validateStringList(entry.itemUuids, `${path}.itemUuids`, errors);
  if (entry.delayMs !== undefined && (!Number.isFinite(Number(entry.delayMs)) || Number(entry.delayMs) < 0)) {
    errors.push(`${path}.delayMs: must be a number >= 0`);
  }
  if (entry.tokenAwaits !== undefined && typeof entry.tokenAwaits !== 'boolean') {
    errors.push(`${path}.tokenAwaits: must be boolean`);
  }
  const condition = validateConditionTree(entry.condition, `${path}.condition`);
  errors.push(...condition.errors);
  const action = validate(entry.action);
  errors.push(...action.errors.map(error => `${path}.action.${error}`));
  return { valid: errors.length === 0, errors };
}

function validateStringList(value, path, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    errors.push(`${path}: must be an array of strings`);
  }
}
