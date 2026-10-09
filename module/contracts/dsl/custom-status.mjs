/** @layer contracts/dsl */
/*
 * The custom status an apply status step authors (`preset: 'custom'`, data in `step.customData`): the data a new one
 * starts from, the list of modifier targets its rows may pick, the clean-up that brings older data to the current
 * shape, and the checks run before it is saved or applied. The data becomes an ActiveEffect on the unit, so its keys
 * are ActiveEffect keys plus the system's flags.
 */
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { SYSTEM_ID } from '../protocol.mjs';
import {
  ALL_UNIT_TYPE_KEYS, COMBAT_FLAG_KEYS, DEFAULT_STATUS_DURATION, SAVE_KEYS, STATS, STATUSES, STATUS_KEYS,
  VOCABULARY_BY_NAME
} from '../domains/characters.mjs';
import { ENCOUNTER_DECAY_FLAGS } from '../domains/combat.mjs';
import { DAMAGE_TYPES } from '../domains/damage.mjs';

/* -------------------------------------------- */
/*  Ends when                                   */
/* -------------------------------------------- */

/**
 * The flags that say what wears a status down, in the order the editor lists them, with the label and tooltip id
 * each one's tile shows. Each time one fires for a custom status, the status loses one phase or one stack
 * (planStatusTicks in game/effects/statuses.mjs).
 */
export const STATUS_END_TRIGGERS = Object.freeze([
  Object.freeze({
    key: ENCOUNTER_DECAY_FLAGS.PHASE_BEGIN, label: 'phase begin', tooltip: 'editor.status.ends.phase-begin'
  }),
  Object.freeze({ key: ENCOUNTER_DECAY_FLAGS.PHASE_END, label: 'phase end', tooltip: 'editor.status.ends.phase-end' }),
  Object.freeze({
    key: ENCOUNTER_DECAY_FLAGS.ANY_PHASE_END, label: 'any phase end', tooltip: 'editor.status.ends.any-phase-end'
  }),
  Object.freeze({
    key: 'removeOnCombatSequenceEnd', label: 'post attack exchange', tooltip: 'editor.status.ends.exchange-end'
  }),
  Object.freeze({ key: 'removeOnStanceBreak', label: 'on stance break', tooltip: 'editor.status.ends.stance-break' }),
  Object.freeze({ key: 'removeWhenAttacked', label: 'on attacked', tooltip: 'editor.status.ends.attacked' }),
  Object.freeze({
    key: 'removeOnHostileAction', label: 'taking hostile action', tooltip: 'editor.status.ends.hostile-action'
  }),
  Object.freeze({
    key: 'removeOnHostileTargeted', label: 'targeted by hostile', tooltip: 'editor.status.ends.hostile-targeted'
  })
]);

/** The end trigger flags alone, in the same order. */
export const END_TRIGGER_KEYS = Object.freeze(STATUS_END_TRIGGERS.map(trigger => trigger.key));

/** The name a custom status gets when it has none. */
const DEFAULT_STATUS_NAME = 'Custom Status';

/** The status id used when a name has no letters or digits. */
const FALLBACK_STATUS_ID = 'CustomStatus';

/** System flags removed from authored data: play sets them, or the step supplies them. */
const DROPPED_FLAG_KEYS = Object.freeze([
  'markedBy', 'tauntedBy', 'linkedAnimationTag', 'linkedAnimationBase', 'durationStacks', 'protectedBy',
  'isProtecting', 'illusionCaster', 'statusImmunities', 'dotCanKillPlayer', 'applyCount'
]);

/** The change types a modifier row may use. */
export const CHANGE_TYPES = Object.freeze(['add', 'override']);

/** The priority a row gets when it has none: adds run first, overrides last. */
export const DEFAULT_PRIORITY = Object.freeze({ add: 20, override: 99 });

/**
 * The lowest priority at which a protection, vulnerability or immunity change counts. Character data preparation
 * (game/character/compilation.mjs) skips such a change below it.
 */
const DAMAGE_TYPE_PRIORITY = 99;

/** Foundry's old numeric change modes that map onto the two change types the editor offers. */
const MODE_TYPES = Object.freeze({ 2: 'add', 5: 'override' });

/** A stat total's change key. A total can only be overridden. */
const TOTAL_KEY = /^system\.stats\.[^.]+\.total$/;

/** A protection, vulnerability or immunity change key. */
const DAMAGE_TYPE_KEY = /^system\.equipment\.(?:prots|vulns|imms)\./;

/**
 * The status id a custom status is saved under: its name with everything but letters and digits removed, so
 * "Covert Penalty: Dagger" becomes CovertPenaltyDagger.
 * @param {string} name The status name.
 * @returns {string}
 */
export function deriveStatusId(name) {
  return String(name ?? '').replace(/[^\p{L}\p{N}]/gu, '') || FALLBACK_STATUS_ID;
}

/* -------------------------------------------- */
/*  Modifier targets                            */
/* -------------------------------------------- */

/** A vocabulary label from contracts/domains/characters.mjs, or the key when the vocabulary has none. */
function vocabularyLabel(name, fallback) {
  return VOCABULARY_BY_NAME.get(name)?.label ?? fallback;
}

function targetGroup(label, entries) {
  return Object.freeze({ label, entries: Object.freeze(entries.map(entry => Object.freeze(entry))) });
}

/**
 * The fields a modifier row may change, all ones that stay on the actor once it is prepared. Derived totals other
 * than the stat totals, skills, proficiencies, growth, caps and gear slots are left out.
 */
const CHANGE_TARGET_GROUPS = Object.freeze([
  targetGroup('Stat components', STATS.flatMap(stat => [
    { value: `stats.${stat.key}.mod`, label: `${stat.label}: mod`, kind: 'number' },
    { value: `stats.${stat.key}.penalty`, label: `${stat.label}: penalty`, kind: 'number' }
  ])),
  targetGroup('Stat totals', STATS.filter(stat => stat.kind !== 'formula').map(stat => (
    { value: `stats.${stat.key}.total`, label: `${stat.label}: total`, kind: 'number' }
  ))),
  targetGroup('Status', STATUSES.filter(status => status.source === 'effect').map(status => (
    { value: `statuses.${status.key}`, label: status.label, kind: 'boolean' }
  ))),
  targetGroup('Combat flags', COMBAT_FLAG_KEYS.map(key => (
    { value: `combat.${key}`, label: vocabularyLabel(`combat.${key}`, key), kind: 'boolean' }
  ))),
  targetGroup('Unit type', ALL_UNIT_TYPE_KEYS.map(key => (
    { value: `unitType.${key}`, label: vocabularyLabel(key, key), kind: 'boolean' }
  ))),
  targetGroup('Damage types', DAMAGE_TYPES.flatMap(type => [
    { value: `equipment.prots.${type}`, label: `Protection: ${type}`, kind: 'boolean' },
    { value: `equipment.vulns.${type}`, label: `Vulnerability: ${type}`, kind: 'boolean' },
    { value: `equipment.imms.${type}`, label: `Immunity: ${type}`, kind: 'boolean' }
  ])),
  targetGroup('Saves', SAVE_KEYS.map(key => (
    { value: `saves.${key}`, label: `${key.toUpperCase()} save modifier`, kind: 'number' }
  ))),
  targetGroup('Turn', [
    { value: 'turn.actionAvailable', label: 'Action available', kind: 'boolean' },
    { value: 'turn.bonusActionAvailable', label: 'Bonus action available', kind: 'boolean' },
    { value: 'turn.movementAvailable', label: 'Movement available', kind: 'boolean' }
  ])
]);

/** Every offered target by its full change key, such as `system.stats.def.penalty`. */
const CHANGE_TARGETS_BY_KEY = new Map(CHANGE_TARGET_GROUPS.flatMap(group =>
  group.entries.map(entry => [`system.${entry.value}`, entry])));

/**
 * The targets a status modifier row may pick, in groups. Each entry's `value` is its path under `system.` and its
 * `kind` says whether the row takes a number or on and off.
 * @returns {ReadonlyArray<{label: string, entries: ReadonlyArray<{value: string, label: string, kind: string}>}>}
 */
export function customStatusChangeTargets() {
  return CHANGE_TARGET_GROUPS;
}

/**
 * The offered target a change key writes, or null when the editor does not offer it.
 * @param {string} key A full change key, such as `system.stats.def.penalty`.
 * @returns {{value: string, label: string, kind: string}|null}
 */
export function changeTargetByKey(key) {
  return CHANGE_TARGETS_BY_KEY.get(String(key ?? '')) ?? null;
}

/**
 * What a change key needs to have any effect: the one change type it works with, and the lowest priority it counts
 * at. A stat total only takes an override, and a damage type change needs a priority of 99 or more. Any other key
 * takes either type at any priority, shown as nulls.
 * @param {string} key A full change key, such as `system.stats.def.total`.
 * @returns {{type: string|null, minPriority: number|null}}
 */
export function changeKeyRule(key) {
  const text = String(key ?? '');
  const type = TOTAL_KEY.test(text) ? 'override' : null;
  return { type, minPriority: DAMAGE_TYPE_KEY.test(text) ? DAMAGE_TYPE_PRIORITY : null };
}

/**
 * The priority a modifier row saved without one gets: 99 for a damage type change, otherwise by its type.
 * @param {string} key A full change key.
 * @param {string} type The row's change type, `add` or `override`.
 * @returns {number}
 */
export function defaultChangePriority(key, type) {
  if (DAMAGE_TYPE_KEY.test(String(key ?? ''))) return DAMAGE_TYPE_PRIORITY;
  return DEFAULT_PRIORITY[type] ?? DEFAULT_PRIORITY.add;
}

/* -------------------------------------------- */
/*  New status                                  */
/* -------------------------------------------- */

/**
 * The data a new custom status starts from: neutral, one phase long, ending at the end of its unit's phase, with no
 * modifier rows.
 * @returns {object}
 */
export function customStatusTemplate() {
  return {
    name: DEFAULT_STATUS_NAME,
    img: 'icons/svg/aura.svg',
    description: '',
    statuses: [FALLBACK_STATUS_ID],
    changes: [],
    flags: {
      core: { statusId: FALLBACK_STATUS_ID },
      [SYSTEM_ID]: {
        duration: DEFAULT_STATUS_DURATION,
        harmful: false,
        beneficial: false,
        hiddenOnToken: false,
        ...Object.fromEntries(END_TRIGGER_KEYS.map(key => [key, key === ENCOUNTER_DECAY_FLAGS.PHASE_END])),
        stackable: false,
        stackCount: 1,
        stackLimit: null,
        removeStackWhenHit: false,
        triggerSheds: {}
      }
    }
  };
}

/* -------------------------------------------- */
/*  Older data                                  */
/* -------------------------------------------- */

/** A number from a number or a numeric string, or null for anything else (null, empty text, booleans). */
function readNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A row value as a number, or the value untouched when it isn't one, so validation can report it. */
function numberValue(value) {
  return readNumber(value) ?? value;
}

/** A row value as on or off. A missing value reads as off; anything else unreadable is left for validation. */
function booleanValue(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === ''
    || value === null || value === undefined) return false;
  return value;
}

/**
 * The stack-shedding choices a status gets when it has none saved: a stackable status with a stack limit and a
 * duration sheds a stack on every trigger it ends on. Any other status sheds none.
 * @param {object} flags The status's system flags.
 * @returns {Record<string, boolean>}
 */
function defaultTriggerSheds(flags = {}) {
  const limit = readNumber(flags?.stackLimit);
  const duration = readNumber(flags?.duration);
  if (flags?.stackable !== true || !(limit >= 1) || !(duration > 0)) return {};
  return Object.fromEntries(END_TRIGGER_KEYS.filter(key => flags[key] === true).map(key => [key, true]));
}

/** Whether the clean-up drops a modifier row: one on the retired turn-over flag, or on a status that is gone. */
function isDroppedRow(row) {
  if (!isPlainObject(row)) return false;
  const key = String(row.key ?? '');
  if (key === 'system.flags.isTurnOver') return true;
  const status = /^system\.statuses\.([^.]+)$/.exec(key);
  return status !== null && !STATUS_KEYS.includes(status[1]);
}

/** A modifier row brought to the current shape. */
function normalizeChangeRow(row) {
  if (!isPlainObject(row)) return row;
  const change = { ...row };
  delete change.phase;
  delete change.false;
  if (change.type === undefined && typeof change.mode === 'number' && MODE_TYPES[change.mode]) {
    change.type = MODE_TYPES[change.mode];
    delete change.mode;
  }
  const key = String(change.key ?? '');
  const priority = readNumber(change.priority);
  change.priority = priority === null ? defaultChangePriority(key, change.type) : Math.round(priority);
  const target = changeTargetByKey(key);
  const value = target?.kind === 'number' ? numberValue(change.value)
    : target?.kind === 'boolean' ? booleanValue(change.value) : change.value;
  if (value !== undefined) change.value = value;
  return change;
}

/**
 * Bring custom status data of any age to the current shape, returning a new object. The id is made from the name,
 * the step's duration moves into the data, Foundry's old numeric change modes become types, and rows and flags the
 * system no longer reads are dropped. Every other key is kept untouched, for the editor's advanced data box. The
 * result always has a `triggerSheds` object, empty at least, which tells planStatusTicks to use the per-trigger
 * phase or stack choice.
 * @param {object} data The step's `customData`. It is not changed.
 * @param {object|null} [step] The apply status step, read only for its `durationPhases`.
 * @returns {object}
 */
export function normalizeCustomStatus(data, step = null) {
  const source = isPlainObject(data) ? structuredClone(data) : {};
  const flags = isPlainObject(source.flags) ? source.flags : {};
  const core = isPlainObject(flags.core) ? flags.core : {};
  const status = isPlainObject(flags[SYSTEM_ID]) ? { ...flags[SYSTEM_ID] } : {};
  const hadStatusId = (Array.isArray(source.statuses) && source.statuses.some(id => String(id ?? '').trim() !== ''))
    || String(core.statusId ?? '').trim() !== '';

  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : DEFAULT_STATUS_NAME;
  const statusId = deriveStatusId(name);
  for (const key of DROPPED_FLAG_KEYS) delete status[key];

  // A status that had no id was never drawn on the token, so it stays hidden there unless it says otherwise.
  status.hiddenOnToken = Object.hasOwn(status, 'hiddenOnToken') ? status.hiddenOnToken === true : !hadStatusId;
  status.harmful = status.harmful === true;
  status.beneficial = status.beneficial === true && !status.harmful;
  const stepDuration = readNumber(step?.durationPhases);
  const flagDuration = readNumber(status.duration);
  const duration = stepDuration !== null && stepDuration >= 0 ? stepDuration
    : flagDuration !== null && flagDuration >= 0 ? flagDuration : DEFAULT_STATUS_DURATION;
  status.duration = Math.max(0, Math.floor(duration));
  for (const key of END_TRIGGER_KEYS) status[key] = status[key] === true;
  status.stackable = status.stackable === true;
  status.stackCount = Math.max(1, Math.floor(readNumber(status.stackCount) ?? 1));
  const limit = Math.floor(readNumber(status.stackLimit) ?? 0);
  status.stackLimit = limit >= 1 ? limit : null;
  // Only a stackable status can shed a stack, so the choice is dropped with the stacking.
  status.removeStackWhenHit = status.stackable && status.removeStackWhenHit === true;
  status.triggerSheds = isPlainObject(status.triggerSheds)
    ? Object.fromEntries(Object.entries(status.triggerSheds)
      .filter(([key]) => END_TRIGGER_KEYS.includes(key)).map(([key, value]) => [key, value === true]))
    : defaultTriggerSheds(status);

  const changes = (Array.isArray(source.changes) ? source.changes : []).filter(row => !isDroppedRow(row))
    .map(normalizeChangeRow);
  return {
    ...source,
    name,
    statuses: [statusId],
    changes,
    flags: { ...flags, core: { ...core, statusId }, [SYSTEM_ID]: status }
  };
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/** Whether a saved value is unset, or a whole number of at least `min` given as a number or numeric text. */
function unsetOrWhole(value, min) {
  if (value === undefined || value === null || value === '') return true;
  const number = readNumber(value);
  return Number.isInteger(number) && number >= min;
}

/**
 * Check a custom status as authored. Its name, numbers and stack-shedding triggers are checked as written, before
 * the clean-up would quietly fix them; its modifier rows are checked as normalizeCustomStatus leaves them, which is
 * how they are applied. Errors stop the step from being saved or run; a warning notes a row whose target the
 * editor does not offer, which still applies as written, or a duration that no phase trigger counts down.
 * @param {object} data The step's `customData`.
 * @param {object|null} [step] The apply status step, read only for its `durationPhases`.
 * @returns {{errors: string[], warnings: string[]}} Plain sentences a GM can read.
 */
export function validateCustomStatus(data, step = null) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(data)) return { errors: ['The custom status cannot be read.'], warnings };
  const applied = normalizeCustomStatus(data, step);
  if (typeof data.name !== 'string' || data.name.trim() === '') errors.push('The status has no name.');
  const flags = isPlainObject(data.flags?.[SYSTEM_ID]) ? data.flags[SYSTEM_ID] : {};
  if (!unsetOrWhole(flags.duration, 0)) {
    errors.push('The number of phases the status lasts must be a whole number of 0 or more.');
  }
  if (!unsetOrWhole(flags.stackCount, 1)) errors.push('Each application must add a whole number of stacks, 1 or more.');
  const { stackCount, stackLimit, duration } = applied.flags[SYSTEM_ID];
  if (stackLimit !== null && stackLimit < stackCount) {
    errors.push('The stack limit is lower than the stacks each application adds.');
  }
  // Only a phase trigger counts phases down; without one a duration above 0 never runs out.
  if (duration > 0 && !Object.values(ENCOUNTER_DECAY_FLAGS).some(key => applied.flags[SYSTEM_ID][key] === true)) {
    warnings.push('A status effect with phases > 0 must be told when to tick down.');
  }
  const sheds = isPlainObject(flags.triggerSheds) ? Object.keys(flags.triggerSheds) : [];
  if (sheds.some(key => !END_TRIGGER_KEYS.includes(key))) {
    errors.push('The status sheds a stack on a trigger the system does not know.');
  }
  // The clean-up drops some rows and keeps the rest in order, so the kept rows line up with the applied ones.
  const rows = (Array.isArray(data.changes) ? data.changes : []).filter(row => !isDroppedRow(row));
  rows.forEach((row, index) => {
    const at = `Modifier row ${index + 1}`;
    const change = applied.changes[index];
    if (!isPlainObject(change)) {
      errors.push(`${at} cannot be read.`);
      return;
    }
    if (!unsetOrWhole(row.priority, -Infinity)) errors.push(`${at} has a priority that is not a whole number.`);
    const key = typeof change.key === 'string' ? change.key.trim() : '';
    if (!key) errors.push(`${at} does not say what it changes.`);
    if (!CHANGE_TYPES.includes(change.type)) errors.push(`${at} must either add or override.`);
    if (!key) return;
    const rule = changeKeyRule(key);
    if (rule.type === 'override' && change.type === 'add') {
      errors.push(`${at} adds to a total. A total can only be overridden.`);
    }
    if (rule.minPriority !== null && change.priority < rule.minPriority) {
      errors.push(`${at} changes a damage type protection, which needs a priority of ${rule.minPriority} or more.`);
    }
    const target = changeTargetByKey(key);
    if (!target) warnings.push(`${at} changes something the editor does not offer. It is kept as written.`);
    else if (target.kind === 'number' && !(typeof change.value === 'number' && Number.isFinite(change.value))) {
      errors.push(`${at} needs a number.`);
    } else if (target.kind === 'boolean' && typeof change.value !== 'boolean') {
      errors.push(`${at} needs to be on or off.`);
    }
  });
  return { errors, warnings };
}
