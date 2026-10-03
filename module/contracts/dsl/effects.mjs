/** @layer contracts/dsl */
import { DAMAGE_TYPES } from '../domains/damage.mjs';
import { validate as validateAnimation } from './animations.mjs';
import { DEFAULT_STATUS_DURATION, FACTION_ROLES, REGISTERED_STATUS_KEYS } from '../domains/characters.mjs';
import { GUARD_BOND_REFUSALS } from '../domains/combat.mjs';
import { ITEM_ACTIVATION_SUPPORT, retractableAllowed } from '../domains/items.mjs';
import { normalizeGeometry, validateGeometry } from './terrain-geometry.mjs';
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { readsOtherUnit, validate as validateConditionTree } from './conditions.mjs';
import { oneOf, placeOf, say, warn as warnAt } from './messages.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

const VOICE_CATEGORY_KEYS = Object.freeze([
  'select', 'crit', 'thanks', 'rally', 'injured', 'defeat', 'levelGood', 'levelBad'
]);

/** Every step kind the effect editor can author and effect execution runs. */
export const STEP_KINDS = Object.freeze([
  'damage', 'heal', 'modShield',
  'applyEffect', 'removeEffect', 'setFaction',
  'animation', 'floatingText', 'playVoice',

  'moveToken', 'spawnToken', 'restoreAction', 'playResist',
  'unequip',
  'guard',
  'terrainEdit',
  'if', 'wait'
]);

/**
 * The longest an effect may pause, in milliseconds: an entry's delay, a step's delay or a wait step. Commands run
 * one at a time on the host client, so a long pause holds up the whole table.
 */
export const MAX_EFFECT_DELAY_MS = 5000;

/** The largest radius, in squares, an area target may have. */
export const MAX_AREA_RADIUS = 20;

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

/** How the move modes read in the editor, for the message about a missing one. */
const MOVE_MODE_WORDS = Object.freeze(['teleport', 'push away', 'pull toward', 'swap', 'shift', 'by rule']);

/** Spent resources a `restoreAction` step may hand back. */
const RESTORABLE_ACTIONS = Object.freeze(['standard', 'bonus', 'movement', 'turn']);

/** Symbolic token references a step may address. */
export const TOKEN_REFS = Object.freeze(['self', 'target']);

/** Presets an `applyEffect` step may name: every registered status, plus a hand-authored `custom` payload. */
const EFFECT_PRESETS = Object.freeze([...REGISTERED_STATUS_KEYS, 'custom']);

/* -------------------------------------------- */
/*  Trigger vocabulary                          */
/* -------------------------------------------- */

/** Group A: triggers for items that attack, firing around an exchange (see triggerGroupForItem). */
export const ATTACK_EFFECT_TRIGGERS = Object.freeze([
  'preCombat', 'onHit', 'onCrit', 'onHitOrCrit', 'onMiss',
  'onStruck', 'onEvade', 'postCombat', 'onKill'
]);

/** Group B: triggers for items that are used, including the outcome of the item's save or check. */
export const ACTIVATION_EFFECT_TRIGGERS = Object.freeze([
  'onActivation', 'onFailedSave', 'onSucceedSave', 'onFailedCheck', 'onSucceedCheck'
]);

/** The triggers a retractable item may use: its activation and the outcome of its skill check. */
export const RETRACTABLE_EFFECT_TRIGGERS = Object.freeze(['onActivation', 'onFailedCheck', 'onSucceedCheck']);

/**
 * Group C: triggers for passive Abilities, firing on phases, a death, a kill, a blow taken, an evade or another
 * item's use.
 */
export const PASSIVE_EFFECT_TRIGGERS = Object.freeze([
  'onPhaseBegin', 'onPhaseEnd', 'onDeath', 'onKill', 'onStruck', 'onEvade', 'onUseItem'
]);

/** How each step kind reads after its number in a message, as in `Step 3 moves a token`. */
const STEP_PHRASES = Object.freeze({
  damage: 'deals damage', heal: 'heals', modShield: 'adds a shield', applyEffect: 'applies a status',
  removeEffect: 'removes a status', setFaction: 'changes a faction', animation: 'plays an animation',
  floatingText: 'shows floating text', moveToken: 'moves a token', spawnToken: 'spawns a token',
  restoreAction: 'restores actions', playResist: 'shows the resist popup', playVoice: 'plays a voice line',
  unequip: 'unequips a weapon', guard: 'starts a guard',
  terrainEdit: 'edits terrain', if: 'checks a condition', wait: 'waits'
});

/** How each trigger reads in a message, as in `That is not allowed on an evade trigger`. */
const TRIGGER_PHRASES = Object.freeze({
  preCombat: 'a pre-combat trigger', onHit: 'a hit trigger', onCrit: 'a crit trigger',
  onHitOrCrit: 'a hit or crit trigger', onMiss: 'a miss trigger', onStruck: 'a struck trigger',
  onEvade: 'an evade trigger', postCombat: 'a post-combat trigger', onKill: 'a kill trigger',
  onActivation: 'an activation trigger', onFailedSave: 'a failed save trigger',
  onSucceedSave: 'a passed save trigger', onFailedCheck: 'a failed check trigger',
  onSucceedCheck: 'a passed check trigger', onPhaseBegin: 'a phase begin trigger',
  onPhaseEnd: 'a phase end trigger', onDeath: 'a death trigger', onUseItem: 'a use item trigger'
});

const EFFECT_TRIGGER_KEYS = Object.freeze([
  ...new Set([
    ...ATTACK_EFFECT_TRIGGERS,
    ...ACTIVATION_EFFECT_TRIGGERS,
    ...PASSIVE_EFFECT_TRIGGERS,
  ])
]);

/** Item subtypes a unit uses rather than attacks with, so they take activation triggers. */
const ACTIVATION_ITEM_SUBTYPES = new Set(['Active', 'Utility', 'Staff (U)', 'Mount']);

/**
 * Which trigger group fires on an item: 'A' (attack triggers) for items that attack, 'B' (activation triggers) for
 * Consumables and the subtypes above, and 'C' (passive triggers) for passive Abilities.
 * @param {{type?: string, itemType?: string}} item The Item's document type and subtype.
 * @returns {'A'|'B'|'C'}
 */
export function triggerGroupForItem({ type, itemType } = {}) {
  if (type === 'Ability' && itemType === 'Passive') return 'C';
  if (type === 'Consumable') return 'B';
  if (ACTIVATION_ITEM_SUBTYPES.has(itemType)) return 'B';
  return 'A';
}

/** The groups whose items a trigger fires on. `onKill`, `onStruck` and `onEvade` are attack and passive triggers. */
function triggerGroups(trigger) {
  const groups = [];
  if (ATTACK_EFFECT_TRIGGERS.includes(trigger)) groups.push('A');
  if (ACTIVATION_EFFECT_TRIGGERS.includes(trigger)) groups.push('B');
  if (PASSIVE_EFFECT_TRIGGERS.includes(trigger)) groups.push('C');
  return Object.freeze(groups);
}

// What each kind of trigger gives its steps. The fields are described on TRIGGER_CAPABILITIES.
const ACTIVATION_CAPABILITIES = {
  target: 'eachTarget', location: 'aimed', castArea: 'aimed', midExchange: false,
  targetMayBeSlain: false, selfMayBeSlain: false, repeats: 'perTarget'
};
const BLOW_CAPABILITIES = {
  target: 'opponent', location: 'none', castArea: 'none', midExchange: true,
  targetMayBeSlain: false, selfMayBeSlain: false, repeats: 'perBlow'
};
const PHASE_CAPABILITIES = {
  target: 'none', location: 'none', castArea: 'none', midExchange: false,
  targetMayBeSlain: false, selfMayBeSlain: false, repeats: 'perPhase'
};
const CAPABILITIES_BY_TRIGGER = {
  preCombat: { ...BLOW_CAPABILITIES, repeats: 'once' },
  onHit: BLOW_CAPABILITIES,
  onCrit: BLOW_CAPABILITIES,
  onHitOrCrit: BLOW_CAPABILITIES,
  onMiss: BLOW_CAPABILITIES,
  onStruck: BLOW_CAPABILITIES,
  onEvade: BLOW_CAPABILITIES,
  onKill: { ...BLOW_CAPABILITIES, targetMayBeSlain: true, repeats: 'once' },
  onDeath: { ...BLOW_CAPABILITIES, selfMayBeSlain: true, repeats: 'once' },
  postCombat: { ...BLOW_CAPABILITIES, midExchange: false, targetMayBeSlain: true, selfMayBeSlain: true, repeats: 'once' },
  onActivation: ACTIVATION_CAPABILITIES,
  onFailedSave: ACTIVATION_CAPABILITIES,
  onSucceedSave: ACTIVATION_CAPABILITIES,
  onFailedCheck: ACTIVATION_CAPABILITIES,
  onSucceedCheck: ACTIVATION_CAPABILITIES,
  onPhaseBegin: PHASE_CAPABILITIES,
  onPhaseEnd: PHASE_CAPABILITIES,
  onUseItem: { ...PHASE_CAPABILITIES, location: 'usedItem', castArea: 'usedItem', repeats: 'once' }
};

/**
 * What each trigger gives its steps, read by the item checks in validateEffectEntry. `group`: the trigger groups it
 * fires in. `target`: the other unit a step may name (each target of the use, the opponent in the exchange, or none).
 * `location` and `castArea`: whether there is a clicked square and cast area (aimed, borrowed from the item being
 * used, or none). `midExchange`: the steps run while the exchange is still going, so steps that move units or
 * change sides are refused.
 * `targetMayBeSlain` and `selfMayBeSlain`: the other unit or the acting unit may already be dead. `repeats`: how
 * often the entry runs (per target, per blow, per phase, or once).
 */
export const TRIGGER_CAPABILITIES = Object.freeze(Object.fromEntries(EFFECT_TRIGGER_KEYS.map(trigger => [
  trigger,
  Object.freeze({ group: triggerGroups(trigger), ...CAPABILITIES_BY_TRIGGER[trigger] })
])));

/**
 * @typedef {object} EffectCarrier The item details validateEffectEntry checks an entry against.
 * @property {string} type The Item's document type.
 * @property {string} itemType Its subtype.
 * @property {string} [targetType] Who it targets: Any, Ground or Self.
 * @property {string} [rngType] Its range shape.
 * @property {number} [targets] How many units it may target.
 * @property {object|null} [save] Its saving throw settings.
 * @property {object|null} [check] Its skill check settings.
 * @property {boolean} [retractable] Whether the item is marked retractable (`system.retractable`).
 * @property {string} [actionType] The action it spends, as `system.actionType` names it.
 */
/**
 * The details of an Item, or of anything shaped like one (`{type, system}`), that decide which triggers and steps
 * its effect entries may use, for validateEffectEntry's `carrier` option.
 * @param {{type?: string, system?: object}} item
 * @returns {EffectCarrier}
 */
export function effectCarrier(item) {
  const system = item?.system ?? {};
  const carrier = {
    type: String(item?.type ?? ''),
    itemType: String(system.itemType ?? ''),
    retractable: system.retractable === true,
    actionType: String(system.actionType ?? 'Standard Action')
  };
  const data = system.effectData;
  if (!data || typeof data !== 'object') return carrier;
  return {
    ...carrier,
    targetType: String(data.targetType ?? 'Any'),
    rngType: String(data.rngType ?? 'Single'),
    targets: Math.max(1, Math.floor(Number(data.targets ?? 1) || 1)),
    save: data.savingThrowDC ?? null,
    check: data.skillCheckDC ?? null
  };
}

/* -------------------------------------------- */
/*  Step outcomes                               */
/* -------------------------------------------- */

/**
 * The codes a step returns when it was authored for a moment that can't give it what it needs, or when the board
 * left it nothing to act on: no preset, no unit to move or to move against, no square to land on, a landing square
 * that is taken or walled off, no Actor or square to summon, no Guard partner, no linked status for a faction change.
 * The Foundry writers return each one before the step writes anything.
 */
export const EFFECT_STEP_PRECONDITION_FAILURES = Object.freeze({
  PRESET_MISSING: 'effect.preset-missing',
  FACTION_STATUS_MISSING: 'effect.faction-status-missing',
  MOVE_TARGET_MISSING: 'effect.move-target-missing',
  MOVE_PAIR_MISSING: 'effect.move-pair-missing',
  MOVE_MODE_UNKNOWN: 'effect.move-mode-unknown',
  MOVE_DESTINATION_MISSING: 'effect.move-destination-missing',
  MOVE_BLOCKED: 'effect.move-blocked',
  SPAWN_SOURCE_MISSING: 'effect.spawn-source-missing',
  SPAWN_LOCATION_MISSING: 'effect.spawn-location-missing',
  GUARD_TARGET_MISSING: 'effect.guard-target-missing'
});

/** The precondition codes above, plus every refused Guard bond, which is likewise refused before any write. */
const PRECONDITION_FAILURE_CODES = new Set([
  ...Object.values(EFFECT_STEP_PRECONDITION_FAILURES),
  ...Object.values(GUARD_BOND_REFUSALS)
]);

/**
 * Whether a failed step's code is an authoring or precondition failure, which engine/effects/execution.mjs skips
 * with a GM notice, rather than a persistence failure, which still fails the command so it restores.
 * @param {string} code The failed step's result code.
 * @returns {boolean}
 */
export function isEffectPreconditionFailure(code) {
  return PRECONDITION_FAILURE_CODES.has(String(code ?? ''));
}

/**
 * The codes game/effects/planning.mjs lists in a plan's `errors`: an entry that fails validation, and an entry or
 * `if` condition that throws. Either one is skipped, and engine/effects/execution.mjs reports it to the GM. A plan's
 * `warnings` use ENTRY_WARNING for an entry that runs but that validation warns about; those are only logged.
 */
export const EFFECT_PLAN_ERRORS = Object.freeze({
  INVALID_ENTRY: 'invalid-entry',
  CONDITION_FAILED: 'condition-evaluation-failed',
  ENTRY_WARNING: 'entry-warning'
});

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
  setFaction:    new Set([...SHARED_KEYS, 'target', 'actorType', 'grantOwnership', 'linkStatusTag']),
  removeEffect:  new Set([...SHARED_KEYS, 'target', 'name', 'scope', 'placedByActor', 'excludeTarget', 'dispelHarmful', 'dispelBeneficial']),
  animation:     new Set([...SHARED_KEYS, 'animation', 'persistent', 'tag', 'attachToEffectName', 'attachTarget', 'await']),
  floatingText:  new Set([...SHARED_KEYS, 'target', 'text', 'color', 'fontSize', 'offsetY', 'durationMs']),
  moveToken:     new Set([...SHARED_KEYS, 'target', 'mode', 'distance', 'location', 'pair', 'dx', 'dy', 'bypassWalls', 'geometry']),
  spawnToken:    new Set([...SHARED_KEYS, 'actorUuid', 'location', 'name', 'tokenOverrides', 'isFriendly', 'grantOwnership', 'summoningSickness', 'duration', 'replaceOnRecast']),
  restoreAction: new Set([...SHARED_KEYS, 'target', 'actions']),
  playResist:    new Set([...SHARED_KEYS, 'target']),
  playVoice:     new Set([...SHARED_KEYS, 'target', 'category', 'skipIfSelf']),
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
  wait:          new Set([...SHARED_KEYS, 'ms'])
};

/** Faction filters an area token reference may narrow to. */
export const AREA_FACTIONS = Object.freeze(['all', 'enemies', 'allies', 'enemiesAndNeutrals']);

/** Factions a `setFaction` step may switch a token to. */
export const ACTOR_TYPES = FACTION_ROLES;

/* -------------------------------------------- */
/*  Factory Methods                             */
/* -------------------------------------------- */

/** Create an empty effect payload. */
export function empty() {
  return { steps: [] };
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

/** Whether a payload is worth running: it has at least one step. */
export function isPopulated(action) {
  if (!isPlainObject(action)) return false;
  return Array.isArray(action.steps) && action.steps.length > 0;
}

/** The end of the sentence for a pause longer than MAX_EFFECT_DELAY_MS. */
const TOO_LONG = `longer than 5 seconds. Keep it to ${MAX_EFFECT_DELAY_MS} milliseconds or less`;

/** Whether a delay or wait is a number over MAX_EFFECT_DELAY_MS. A wait written as a dice formula is not checked. */
function overDelayCap(value) {
  if (value === undefined || value === null || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n > MAX_EFFECT_DELAY_MS;
}

/**
 * Check the radius and faction filter of a step's area target. A missing radius counts as 1 and a missing faction as
 * every unit.
 */
function validateArea(area, fail) {
  if (area.radius !== undefined
      && !(Number.isInteger(area.radius) && area.radius >= 1 && area.radius <= MAX_AREA_RADIUS)) {
    fail(`has an area whose radius is not a whole number from 1 to ${MAX_AREA_RADIUS}`);
  }
  if (area.faction !== undefined && !AREA_FACTIONS.includes(area.faction)) {
    fail('has an area that picks units by a faction the system does not know');
  }
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
  if (!isPlainObject(action)) return { valid: false, errors: [say('this effect', 'has steps that cannot be read')] };
  const errors = [];
  if (!Array.isArray(action.steps)) {
    errors.push(say('this effect', 'has steps that cannot be read'));
  } else {
    action.steps.forEach((step, i) => errors.push(...validateStep(step, `steps[${i}]`)));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate one step against the rules of its kind, recursing into an `if` step's branches.
 * @param {object} step  Step to validate.
 * @param {string} path  Where the step sits, such as `steps[2].then[0]`, which names it in each message.
 * @returns {string[]}   Collected error sentences, empty when valid.
 */
function validateStep(step, path) {
  const at = placeOf(path);
  const errors = [];
  const fail = sentence => errors.push(say(at, sentence));
  const needsUnit = () => { if (!isTokenRef(step.target)) fail('does not name a valid unit to act on'); };
  if (!isPlainObject(step)) return [say(at, 'cannot be read')];
  if (!STEP_KINDS.includes(step.kind)) return [say(at, 'is a kind of step the system does not know')];
  const allowed = STEP_KEYS_BY_KIND[step.kind];
  for (const key of Object.keys(step)) {
    if (!allowed.has(key)) fail(`has a setting called ${key} that this kind of step does not use`);
  }
  if (overDelayCap(step.delay)) fail(`has a delay ${TOO_LONG}`);
  if (isPlainObject(step.target?.area)) validateArea(step.target.area, fail);
  switch (step.kind) {
    case 'damage':
      needsUnit();
      if (typeof step.formula !== 'string' || step.formula.trim() === '') fail('has no damage formula');
      if (typeof step.dmgType !== 'string' || step.dmgType.trim() === '') fail('has no damage type');
      else if (!DAMAGE_TYPES.includes(step.dmgType)) fail('deals a damage type the system does not know');
      break;
    case 'heal':
      needsUnit();
      if (typeof step.formula !== 'string' || step.formula.trim() === '') fail('has no heal amount');
      break;
    case 'modShield':
      needsUnit();
      if (typeof step.formula !== 'string' && typeof step.formula !== 'number') fail('has no shield amount');
      break;
    case 'applyEffect':
      needsUnit();
      if (!step.preset) fail('does not say which status to apply');
      else if (!EFFECT_PRESETS.includes(step.preset)) fail('applies a status the system does not know');
      if (step.preset === 'custom' && !isPlainObject(step.customData)) {
        fail('applies a custom status but has no custom status data');
      }
      if (step.durationPhases !== undefined) {
        const d = Number(step.durationPhases);
        if (!Number.isFinite(d) || d < 1) {
          const phases = `${DEFAULT_STATUS_DURATION} phase${DEFAULT_STATUS_DURATION === 1 ? '' : 's'}`;
          fail(`needs a duration of at least 1 phase. Leave it empty to use ${phases}`);
        }
      }
      break;
    case 'setFaction':
      needsUnit();
      if (!ACTOR_TYPES.includes(step.actorType)) fail(`needs a faction, one of ${oneOf(ACTOR_TYPES)}`);
      if (!(typeof step.linkStatusTag === 'string' && step.linkStatusTag.trim() !== '')) {
        fail('changes a faction but is not tied to a status. Give it the linked animation tag of an apply status '
          + 'step before it, so the unit changes back when that status ends');
      }
      break;
    case 'removeEffect':
      // A global removal sweeps the whole Scene, so EffectExecutionService doesn't read a target.
      if (step.scope !== 'global') needsUnit();
      if (!(typeof step.name === 'string' && step.name.trim() !== '')
          && step.dispelHarmful !== true && step.dispelBeneficial !== true) {
        fail('does not say which status to remove. Give a status name, or tick dispel harmful or dispel beneficial');
      }
      break;
    case 'animation':
      if (!isPlainObject(step.animation)) {
        fail('has no animation to play');
      } else {
        for (const e of validateAnimation(step.animation).errors) fail(`plays an animation with a problem. ${e}`);
      }
      if (step.persistent === true
          && !(typeof step.tag === 'string' && step.tag.trim() !== '')
          && !attachesToSpawnedToken(step.animation)) {
        fail('plays a persistent animation with no tag. Give it the tag an apply status step uses as its linked '
          + 'animation tag, or attach it to the last spawned token');
      }
      break;
    case 'floatingText':
      needsUnit();
      if (typeof step.text !== 'string') fail('has no text to show');
      break;
    case 'moveToken':
      needsUnit();
      if (!MOVE_MODES.includes(step.mode)) fail(`needs a way to move, one of ${oneOf(MOVE_MODE_WORDS)}`);
      if (step.mode === 'terrainGeometry') {
        errors.push(...validateGeometry(step.geometry, { context: 'step', path: `${path}.geometry` }));
      }
      if (step.mode === 'teleport' && step.location === undefined) fail('teleports but has no place to go');
      if (step.mode === 'push' && typeof step.pair === 'string' && step.pair === step.target) {
        fail('pushes a unit away from itself. Choose another unit to push it from');
      }
      if (step.mode === 'pull' && typeof step.pair === 'string' && step.pair === step.target) {
        fail('pulls a unit toward itself. Choose another unit to pull it toward');
      }
      if (step.mode === 'swap' && typeof step.pair === 'string' && step.pair === step.target) {
        fail('swaps a unit with itself. Choose another unit to swap with');
      }
      if (step.mode === 'shift') {
        if (step.dx === undefined && step.dy === undefined) fail('shifts but sets neither dx nor dy');
      }
      break;
    case 'spawnToken':
      if (typeof step.actorUuid !== 'string' || step.actorUuid.trim() === '') fail('has no actor to spawn');
      if (step.location === undefined) fail('has no place to put the token');
      if (step.duration !== undefined && !(Number.isInteger(step.duration) && step.duration >= 0)) {
        fail('needs a duration that is a whole number, 0 or more. 0 lasts until the encounter ends');
      }
      break;
    case 'restoreAction':
      needsUnit();
      if (!Array.isArray(step.actions) || step.actions.length === 0) {
        fail('does not say which actions to restore');
      } else {
        for (const a of step.actions) {
          if (!RESTORABLE_ACTIONS.includes(a)) {
            fail(`restores ${a}, which is not an action. Use ${oneOf(RESTORABLE_ACTIONS)}`);
          }
        }
      }
      break;
    case 'playResist':
      needsUnit();
      break;
    case 'playVoice':
      needsUnit();
      if (!VOICE_CATEGORY_KEYS.includes(step.category)) {
        fail('plays a voice line from a category the system does not know');
      }
      break;
    case 'unequip':
      needsUnit();
      break;
    case 'guard':
      if (step.target !== 'target') {
        fail('starts a guard on someone other than the target. A guard only runs on the target');
      }
      break;
    case 'terrainEdit': {
      if (step.target !== undefined) needsUnit();
      if (step.target?.area?.includeCenter !== undefined && typeof step.target.area.includeCenter !== 'boolean') {
        fail('has an area whose include center setting is not on or off');
      }
      for (const k of TERRAIN_EDIT_NUMERIC_KEYS) {
        if (step[k] !== undefined && !Number.isFinite(Number(step[k]))) {
          fail(`has a ${k.replace(/([A-Z])/g, ' $1').toLowerCase()} setting that is not a number`);
        }
      }
      if (step.duration === undefined) fail('has no duration. Use 0 for an edit that is permanent');
      else if (Number(step.duration) < 0) fail('needs a duration of 0 or more. 0 is permanent');
      if (step.variable !== undefined && !(Number(step.variable) > 0)) fail('needs a hazard amount above 0');
      if (step.mov !== undefined && !(Number(step.mov) >= 1)) fail('needs a movement cost of 1 or more');
      if (step.effect !== undefined && step.effect !== '' && !TERRAIN_EDIT_HAZARD_TYPES.includes(step.effect)) {
        fail('paints a hazard the system does not know');
      }
      if (step.presetTile !== undefined && (typeof step.presetTile !== 'string' || step.presetTile.trim() === '')) {
        fail('has an empty terrain preset name');
      }
      const hasStat = ['eva', 'def', 'res', 'mov'].some(k => step[k] !== undefined);
      const hasHazard = typeof step.effect === 'string' && step.effect !== '';
      const hasVfx = typeof step.vfxEffect === 'string' && step.vfxEffect.trim() !== '';
      const hasLight = Number(step.lightDim) > 0 || Number(step.lightBright) > 0;
      if (!hasStat && !hasHazard && !hasVfx && !hasLight) {
        fail('changes nothing. Set a stat, a hazard, a visual effect or a light');
      }
      break;
    }
    case 'if': {
      errors.push(...validateConditionTree(step.condition, `${path}.condition`).errors);
      if (!Array.isArray(step.then)) {
        fail('has then steps that cannot be read');
      } else {
        step.then.forEach((s, i) => errors.push(...validateStep(s, `${path}.then[${i}]`)));
      }
      if (step.else !== undefined) {
        if (!Array.isArray(step.else)) fail('has else steps that cannot be read');
        else step.else.forEach((s, i) => errors.push(...validateStep(s, `${path}.else[${i}]`)));
      }
      break;
    }
    case 'wait':
      if (typeof step.ms !== 'number' && typeof step.ms !== 'string') fail('does not say how long to wait');
      else if (overDelayCap(step.ms)) fail(`waits ${TOO_LONG}`);
      break;
  }
  return errors;
}

/* -------------------------------------------- */
/*  Entry validation                            */
/* -------------------------------------------- */

/**
 * Validate one authored effect entry and its nested action. game/effects/planning.mjs checks every entry with it
 * before planning, and the effect editor before saving. Its condition and every `if` condition get the effect
 * condition rules. With a `carrier`, the entry is also checked against what its trigger supplies on that item. Every
 * message is a plain sentence naming the step or condition it is about, and the same sentence is never listed twice.
 * @param {*} entry The authored entry.
 * @param {string|{path?: string, carrier?: EffectCarrier|null}} [options] Where the entry sits, or the options.
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateEffectEntry(entry, options = {}) {
  const { path = 'entry', carrier = null } = typeof options === 'string' ? { path: options } : options ?? {};
  if (!isPlainObject(entry)) return { valid: false, errors: [say('this effect', 'cannot be read')], warnings: [] };
  const errors = [];
  const warnings = [];
  const fail = sentence => errors.push(say('this effect', sentence));
  if (!EFFECT_TRIGGER_KEYS.includes(entry.trigger)) fail('has no trigger the system knows');
  if (entry.name !== undefined && typeof entry.name !== 'string') fail('has a name that is not text');
  validateStringList(entry.itemNames, 'item names', errors);
  validateStringList(entry.itemUuids, 'item links', errors);
  if (entry.delayMs !== undefined && (!Number.isFinite(Number(entry.delayMs)) || Number(entry.delayMs) < 0)) {
    fail('needs a delay of 0 or more');
  } else if (overDelayCap(entry.delayMs)) {
    fail(`has a delay ${TOO_LONG}`);
  }
  if (entry.tokenAwaits !== undefined && typeof entry.tokenAwaits !== 'boolean') {
    fail('has a token wait setting that is not on or off');
  }
  const condition = validateConditionTree(entry.condition, { path: `${path}.condition`, surface: 'effect' });
  errors.push(...condition.errors);
  warnings.push(...condition.warnings);
  const action = validate(entry.action);
  errors.push(...action.errors);
  // The action check already reports each if condition's shape, so only new messages are added here.
  walkSteps(entry.action?.steps, `${path}.action.steps`, true, (step, at) => {
    if (step.kind !== 'if') return;
    const rules = validateConditionTree(step.condition, { path: `${at}.condition`, surface: 'effect' });
    errors.push(...rules.errors.filter(error => !errors.includes(error)));
    warnings.push(...rules.warnings);
  });
  validatePromptPlacement(entry, path, errors);
  validateFactionLinks(entry, path, errors);
  if (carrier && EFFECT_TRIGGER_KEYS.includes(entry.trigger)) {
    validateEntryContext(entry, carrier, path, { errors, warnings });
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/* -------------------------------------------- */
/*  Context rules                               */
/* -------------------------------------------- */

const SAVE_TRIGGERS = new Set(['onFailedSave', 'onSucceedSave']);
const CHECK_TRIGGERS = new Set(['onFailedCheck', 'onSucceedCheck']);
const AIMED_RNG_TYPES = new Set(ITEM_ACTIVATION_SUPPORT.aimedRngTypes);
/** Step kinds that change a unit, so a slain unit can't take them. */
const CORPSE_STEPS = new Set(['damage', 'heal', 'modShield', 'applyEffect', 'removeEffect', 'moveToken', 'setFaction']);
/** Step kinds that change who stands where or on which side, which the exchange checked only when it opened. */
const MID_EXCHANGE_FORBIDDEN = new Set(['moveToken', 'setFaction', 'unequip', 'restoreAction']);
/** Steps that only show something, so running them once per target is harmless. */
const DISPLAY_STEPS = new Set([
  'animation', 'floatingText', 'playVoice', 'playResist', 'wait'
]);

/** Run the carrier rules on one entry, adding to `errors` and `warnings`. */
function validateEntryContext(entry, carrier, path, out) {
  const trigger = entry.trigger;
  const cap = TRIGGER_CAPABILITIES[trigger];
  const group = triggerGroupForItem(carrier);
  const fail = (at, sentence) => out.errors.push(say(placeOf(at), sentence));
  const warn = (at, sentence) => out.warnings.push(warnAt(placeOf(at), sentence));

  if (!cap.group.includes(group)) {
    fail(path, `uses ${TRIGGER_PHRASES[trigger]}, which never fires on this kind of item`);
  }
  if (trigger === 'onUseItem' && !listed(entry.itemNames) && !listed(entry.itemUuids)) {
    fail(path, 'uses a use item trigger but names no item to watch for');
  }
  checkRetractable(trigger, carrier, path, out.errors);
  checkOutcomeTrigger(trigger, carrier, path, fail, warn);
  if (cap.target === 'none' && readsOtherUnit(entry.condition)) {
    fail(`${path}.condition`, `reads the other unit, but ${TRIGGER_PHRASES[trigger]} has no other unit`);
  }

  const location = locationSupport(cap, carrier);
  const ctx = { trigger, cap, location, multiTarget: cap.repeats === 'perTarget' && multiTargetShape(carrier) };
  walkSteps(entry.action?.steps, `${path}.action.steps`, true, (step, at, topLevel) => {
    checkStep(step, at, topLevel, ctx, fail, warn);
  });
}

/** Whether a list names at least one non-empty string. */
function listed(value) {
  return Array.isArray(value) && value.some(entry => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * A retractable item must be a bonus action that targets Self, and its effects may fire only on activation and
 * skill check triggers. The item sheet offers no other choice, so these catch pack and pasted items.
 */
function checkRetractable(trigger, carrier, at, errors) {
  if (carrier.retractable !== true) return;
  if (!retractableAllowed(carrier)) {
    errors.push('This item is retractable, but only a bonus action that targets self can be taken back.');
  }
  if (!RETRACTABLE_EFFECT_TRIGGERS.includes(trigger)) {
    errors.push(say(placeOf(at), `fires on ${TRIGGER_PHRASES[trigger]}. A retractable item only fires on activation `
      + 'and skill check triggers'));
  }
}

/** Save and check outcome triggers need the item to roll that save or check. */
function checkOutcomeTrigger(trigger, carrier, at, fail, warn) {
  const uses = `uses ${TRIGGER_PHRASES[trigger]}`;
  if (SAVE_TRIGGERS.has(trigger)) {
    if (carrier.save !== undefined && carrier.save?.required !== true) {
      fail(at, `${uses}, but the item does not ask for a saving throw`);
    }
    if (carrier.targetType === 'Ground' || carrier.targetType === 'Self') {
      const aim = carrier.targetType === 'Ground' ? 'the ground' : 'its user';
      fail(at, `${uses}, which never fires on an item that targets ${aim}`);
    }
  }
  if (CHECK_TRIGGERS.has(trigger) && carrier.check !== undefined) {
    if (carrier.check?.required !== true || String(carrier.check.skill ?? 'None') === 'None') {
      fail(at, `${uses}, but the item does not ask for a skill check with a skill`);
    } else if (carrier.save?.required === true) {
      warn(at, `${uses}, which never fires on a target, because the item rolls its saving throw instead`);
    }
  }
}

/**
 * Whether the trigger has a clicked square and cast area: 'yes', 'no', or 'borrowed' for onUseItem, which uses the
 * item being used. An activation has one only when its item is aimed, when the carrier says how it targets.
 */
function locationSupport(cap, carrier) {
  if (cap.location === 'usedItem') return 'borrowed';
  if (cap.location !== 'aimed') return 'no';
  if (carrier.rngType === undefined) return 'yes';
  return AIMED_RNG_TYPES.has(carrier.rngType) || carrier.targetType === 'Ground' ? 'yes' : 'no';
}

/** Whether one use of the item can catch more than one unit, so per-target entries run several times. */
function multiTargetShape(carrier) {
  if (carrier.rngType === undefined || carrier.targetType === 'Ground') return false;
  if (AIMED_RNG_TYPES.has(carrier.rngType)) return true;
  if (carrier.targetType === 'Self') return false;
  if (carrier.rngType === 'Line' || carrier.rngType === 'Area') return true;
  return carrier.rngType === 'Multiple' && carrier.targets > 1;
}

/** Call `visit(step, path, topLevel)` on every step, inside `if` branches too. */
function walkSteps(steps, path, topLevel, visit) {
  if (!Array.isArray(steps)) return;
  steps.forEach((step, i) => {
    if (!isPlainObject(step)) return;
    const at = `${path}[${i}]`;
    visit(step, at, topLevel);
    if (step.kind === 'if') {
      walkSteps(step.then, `${at}.then`, false, visit);
      walkSteps(step.else, `${at}.else`, false, visit);
    }
  });
}

/** Whether a token reference names the run's target, directly or as an area's centre. */
function namesTarget(ref) {
  return ref === 'target' || (isPlainObject(ref?.area) && ref.area.center === 'target');
}

/** How a step uses the other unit, by the field that names it, for the message about a trigger that has none. */
const TARGET_USES = Object.freeze({
  target: 'targets', pair: 'pairs with', location: 'goes to', 'geometry.anchor': 'is anchored on'
});

/** How a step that changes a unit reads with that unit as its object, as in `heals the other unit`. */
const UNIT_CHANGES = Object.freeze({
  damage: 'damages', heal: 'heals', modShield: 'changes the shield of', applyEffect: 'puts a status on',
  removeEffect: 'removes a status from', moveToken: 'moves', setFaction: 'changes the faction of'
});

/** Run the trigger rules on one step: what the trigger supplies, and what repeats or piles up. */
function checkStep(step, at, topLevel, { trigger, cap, location, multiTarget }, fail, warn) {
  const kind = step.kind;
  const geometry = kind === 'moveToken' && step.mode === 'terrainGeometry' ? normalizeGeometry(step.geometry) : null;
  const named = TRIGGER_PHRASES[trigger];

  if (cap.target === 'none') {
    const refs = [['target', step.target], ['pair', step.pair], ['location', step.location]];
    if (geometry) refs.push(['geometry.anchor', geometry.anchor]);
    for (const [key, ref] of refs) {
      if (namesTarget(ref)) {
        fail(`${at}.${key}`, `${TARGET_USES[key]} the other unit, but ${named} has no other unit. Use self`);
      }
    }
    if (kind === 'if' && readsOtherUnit(step.condition)) {
      fail(at, `checks the other unit, but ${named} has no other unit`);
    }
  }

  const locationRefs = [];
  const placesAt = kind === 'moveToken' || kind === 'spawnToken';
  if (placesAt && step.location === 'targetLocation') locationRefs.push('location');
  if (geometry?.anchor === 'targetLocation') locationRefs.push('geometry.anchor');
  if (kind === 'terrainEdit' && step.target === undefined) locationRefs.push('target');
  for (const key of locationRefs) {
    const castArea = key === 'target';
    if (location === 'no') {
      fail(`${at}.${key}`, castArea
        ? `edits the cast area, but ${named} has no cast area here`
        : `uses the clicked square, but ${named} has no clicked square here`);
    }
    if (location === 'borrowed') {
      warn(`${at}.${key}`, castArea
        ? 'edits the cast area of the item being used, if it has one'
        : 'uses the clicked square of the item being used, if it has one');
    }
  }

  const turnRefresh = kind === 'restoreAction' && step.target === 'self'
    && Array.isArray(step.actions) && step.actions.some(a => a === 'turn' || a === 'standard');
  if (turnRefresh && (cap.repeats === 'perBlow' || trigger === 'preCombat')) {
    fail(at, `gives its own unit back a turn or standard action. That is not allowed on ${named}`);
  } else if (cap.midExchange && MID_EXCHANGE_FORBIDDEN.has(kind)
    && !(kind === 'restoreAction' && trigger === 'onKill')
    && !(trigger === 'preCombat' && isPredictedPreCombatMove(step, topLevel, geometry))) {
    fail(at, trigger === 'preCombat' && kind === 'moveToken'
      ? 'moves a token. On a pre-combat trigger the only move allowed is a top level move of self by rule, '
        + 'anchored on the other unit'
      : `${STEP_PHRASES[kind]}. That is not allowed on ${named}`);
  }

  if (kind === 'restoreAction' && trigger === 'onPhaseBegin') {
    fail(at, 'gives back actions, but every unit already has its actions when a phase begins');
  } else if (kind === 'restoreAction' && trigger === 'onPhaseEnd') {
    fail(at, 'gives back actions at the end of the phase, when the unit can no longer use them');
  }

  if (kind === 'guard' && trigger !== 'onActivation') {
    fail(at, 'starts a guard. That is only allowed on an activation trigger');
  }

  // postCombat skips slain units when it runs, so only onKill and onDeath refuse steps on a corpse.
  if (CORPSE_STEPS.has(kind) && trigger !== 'postCombat') {
    if (cap.targetMayBeSlain && step.target === 'target') {
      fail(`${at}.target`,
        `${UNIT_CHANGES[kind]} the other unit, but that unit may already be dead when ${named} fires`);
    }
    if (cap.selfMayBeSlain && step.target === 'self') {
      fail(`${at}.target`,
        `${UNIT_CHANGES[kind]} its own unit, but that unit may already be dead when ${named} fires`);
    }
  }

  if (geometry) {
    if (geometry.reach === 'path' && geometry.budgetSource === 'rng' && cap.repeats === 'perPhase') {
      fail(`${at}.geometry.budgetSource`,
        `moves by rule within item range, but ${named} has no item range, so the move can never go anywhere`);
    }
    if (typeof step.target === 'string' && geometry.anchor === step.target) {
      fail(`${at}.geometry.anchor`, 'moves a unit by rule anchored on that same unit');
    }
  }

  const area = isPlainObject(step.target?.area);
  if (cap.midExchange && kind === 'damage' && area) {
    warn(`${at}.target`, `deals area damage. On ${named} that ends the exchange if it defeats a bystander`);
  }
  if (multiTarget) {
    const onSelf = step.target === 'self' && !DISPLAY_STEPS.has(kind);
    const castArea = kind === 'terrainEdit' && step.target === undefined;
    if (onSelf || area || kind === 'spawnToken' || castArea) {
      warn(at, 'runs once for every unit the item catches');
    }
  }
  if (cap.repeats === 'perBlow' || cap.repeats === 'perPhase') {
    const every = cap.repeats === 'perBlow' ? 'blow' : 'phase';
    if (kind === 'spawnToken' && step.replaceOnRecast !== true) {
      warn(at, `spawns a token every ${every}, so they pile up`);
    }
    if (kind === 'modShield' && (step.cap === undefined || step.cap === null || step.cap === '')) {
      warn(at, `adds a shield with no cap, so it grows every ${every}`);
    }
    if (kind === 'terrainEdit' && Math.floor(Number(step.duration) || 0) === 0) {
      warn(at, `makes a permanent terrain edit every ${every}, so they pile up`);
    }
    if (kind === 'applyEffect' && step.durationStacks === true) {
      warn(at, `stacks a status duration, so it grows every ${every}`);
    }
  }
}

/** The one preCombat move the attack preview predicts: a top-level move of self next to the target. */
function isPredictedPreCombatMove(step, topLevel, geometry) {
  return step.kind === 'moveToken' && topLevel && step.target === 'self' && geometry?.anchor === 'target';
}

/**
 * The player is asked to pick a square only for the first move by rule with that pick at the top level of an
 * activation entry, before the item is confirmed (findPromptGeometryStep). Anywhere else nobody is asked.
 */
function validatePromptPlacement(entry, path, errors) {
  let asked = false;
  walkSteps(entry.action?.steps, `${path}.action.steps`, true, (step, at, topLevel) => {
    if (step.kind !== 'moveToken' || step.mode !== 'terrainGeometry' || step.geometry?.pick !== 'prompt') return;
    const place = placeOf(`${at}.geometry.pick`);
    if (entry.trigger !== 'onActivation' || !topLevel) {
      errors.push(say(place, 'lets the player pick the square, which only works on a top level step of an activation '
        + 'trigger. Choose nearest, farthest or random'));
    } else if (asked) {
      errors.push(say(place, 'lets the player pick the square, but only the first such step in an effect asks. '
        + 'Choose nearest, farthest or random'));
    }
    if (entry.trigger === 'onActivation' && topLevel) asked = true;
  });
}

/**
 * A faction change lasts only while a status lasts, so each change faction step must name, as its linked status
 * tag, the linked animation tag of an apply status step that comes before it in this entry and acts on the same
 * unit. A step with no tag is reported by validateStep.
 */
function validateFactionLinks(entry, path, errors) {
  const statusTargets = new Map();
  walkSteps(entry.action?.steps, `${path}.action.steps`, true, (step, at) => {
    if (step.kind === 'applyEffect' && typeof step.linkAnimationTag === 'string' && step.linkAnimationTag) {
      const targets = statusTargets.get(step.linkAnimationTag) ?? [];
      statusTargets.set(step.linkAnimationTag, [...targets, sameUnitKey(step.target)]);
      return;
    }
    if (step.kind !== 'setFaction' || typeof step.linkStatusTag !== 'string' || !step.linkStatusTag.trim()) return;
    const targets = statusTargets.get(step.linkStatusTag);
    const place = placeOf(`${at}.linkStatusTag`);
    if (!targets) {
      errors.push(say(place, 'is tied to a status, but no apply status step before it has that linked animation tag'));
    } else if (!targets.includes(sameUnitKey(step.target))) {
      errors.push(say(place, 'is tied to a status put on a different unit. Give both steps the same unit'));
    }
  });
}

/** A token reference as text, so two steps naming the same unit or the same area compare equal. */
function sameUnitKey(ref) {
  if (!isPlainObject(ref)) return JSON.stringify(ref ?? null);
  const sorted = value => isPlainObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
    : value;
  return JSON.stringify(sorted(ref));
}

/** A list of item names or links must be a list of text. `words` names it in the message. */
function validateStringList(value, words, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    errors.push(say('this effect', `has ${words} that cannot be read`));
  }
}
