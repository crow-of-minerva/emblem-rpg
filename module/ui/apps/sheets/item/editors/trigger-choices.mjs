/** @layer ui/apps/sheets/item/editors */
/*
 * What the effect editor offers for one trigger: the triggers an item's effects may use, the step kinds the add-step
 * picker lists, the units and squares a step may name, and the starting values of a new step. Each rule follows
 * TRIGGER_CAPABILITIES in contracts/dsl/effects.mjs, where validateEffectEntry still decides what may be saved. Nothing
 * here touches the DOM, so these rules run in plain Node.
 */
import {
  ACTIVATION_EFFECT_TRIGGERS,
  ATTACK_EFFECT_TRIGGERS,
  PASSIVE_EFFECT_TRIGGERS,
  RETRACTABLE_EFFECT_TRIGGERS,
  TRIGGER_CAPABILITIES
} from '../../../../../contracts/dsl/effects.mjs';
import { triggerLabel } from '../../../../../config/triggers.mjs';

/* -------------------------------------------- */
/*  Triggers                                    */
/* -------------------------------------------- */

/**
 * The triggers an item of one trigger group may use, in the order the trigger select lists them. A retractable item
 * gets only its activation and skill check triggers.
 * @param {string} group          'A' for items that attack, 'B' for items that are used, 'C' for passive Abilities.
 * @param {object} [options]
 * @param {boolean} [options.retractable]  Whether the item is marked retractable.
 * @returns {readonly string[]}
 */
export function triggerKeysForGroup(group, { retractable = false } = {}) {
  const keys = group === 'C' ? PASSIVE_EFFECT_TRIGGERS
    : group === 'B' ? ACTIVATION_EFFECT_TRIGGERS : ATTACK_EFFECT_TRIGGERS;
  return retractable ? keys.filter(key => RETRACTABLE_EFFECT_TRIGGERS.includes(key)) : keys;
}

/** Whether a trigger fires on items of a trigger group. */
export function triggerFitsGroup(trigger, group) {
  return TRIGGER_CAPABILITIES[trigger]?.group.includes(group) === true;
}

/**
 * The trigger select's options for an effect on an item of one group. An effect whose trigger the item can't use
 * gets it as a disabled first option, so the select still shows it and the validation bar says why it can't be saved.
 * @param {string} group          The item's trigger group.
 * @param {string} current        The effect's trigger.
 * @param {object} [options]
 * @param {boolean} [options.retractable]  Whether the item is marked retractable.
 * @returns {Array<{value: string, label: string, disabled?: boolean}>}
 */
export function triggerChoices(group, current, { retractable = false } = {}) {
  const choices = triggerKeysForGroup(group, { retractable }).map(key => ({ value: key, label: triggerLabel(key) }));
  if (!current || choices.some(choice => choice.value === current)) return choices;
  const unavailable = { value: current, label: `${triggerLabel(current)}, not available on this item`, disabled: true };
  return [unavailable, ...choices];
}

/** How a trigger reads inside a sentence, with its article, as in `an on hit trigger`. */
export function triggerPhrase(trigger) {
  const words = String(triggerLabel(trigger)).toLowerCase();
  return `${/^[aeiou]/.test(words) ? 'an' : 'a'} ${words} trigger`;
}

/* -------------------------------------------- */
/*  Step kinds                                  */
/* -------------------------------------------- */

/**
 * Step kinds that move a unit or change its side or actions, which validateEffectEntry refuses while an exchange is
 * still going.
 */
const EXCHANGE_LOCKED_KINDS = new Set(['moveToken', 'setFaction', 'unequip', 'restoreAction']);

/**
 * Whether the add-step picker offers a step kind on a trigger. A trigger that runs mid-exchange leaves out the kinds
 * above, except restoring actions on a kill and the one move a pre-combat trigger allows. A spawn needs a
 * clicked square, so a trigger without one leaves it out. Restoring actions is left out on phase begin and phase end,
 * where it would change nothing. An unknown trigger offers every kind.
 */
export function stepKindOffered(kind, trigger) {
  const cap = TRIGGER_CAPABILITIES[trigger];
  if (!cap) return true;
  if (cap.midExchange && EXCHANGE_LOCKED_KINDS.has(kind)) {
    return (kind === 'restoreAction' && trigger === 'onKill') || (kind === 'moveToken' && trigger === 'preCombat');
  }
  if (kind === 'spawnToken') return cap.location !== 'none';
  if (kind === 'restoreAction') return trigger !== 'onPhaseBegin' && trigger !== 'onPhaseEnd';
  return true;
}

/* -------------------------------------------- */
/*  Units and squares                           */
/* -------------------------------------------- */

/**
 * Whether a step on a trigger is offered a unit or square choice: `target` needs a trigger with another unit,
 * `targetLocation` one with a clicked square, and the cast area one with a cast area. Every other value is offered.
 * @param {string} value                  The choice's value.
 * @param {string} trigger                The effect's trigger.
 * @param {object} [options]
 * @param {boolean} [options.castArea]    Whether an empty value means the cast area, as on a terrain edit.
 */
export function referenceOffered(value, trigger, { castArea = false } = {}) {
  const cap = TRIGGER_CAPABILITIES[trigger];
  if (!cap) return true;
  if (value === 'target') return cap.target !== 'none';
  if (value === 'targetLocation') return cap.location !== 'none';
  if (value === '' && castArea) return cap.castArea !== 'none';
  return true;
}

/* -------------------------------------------- */
/*  New steps                                   */
/* -------------------------------------------- */

/**
 * Fit a new step's starting values to a trigger, in place, through its branches. With no other unit, a step names
 * self instead of `target`, a spawn starts on self's square, and a push or pull, which would then push self from
 * self, starts as a shift instead. With no cast area, a terrain edit starts on self's square. On a pre-combat
 * trigger a move starts as the one move allowed there: self, by rule, next to the target.
 * @param {object} step           A step just made by the add-step picker.
 * @param {string} trigger        The effect's trigger.
 * @returns {object}              The same step.
 */
export function fitStepToTrigger(step, trigger) {
  const cap = TRIGGER_CAPABILITIES[trigger];
  if (!cap || !step || typeof step !== 'object') return step;
  if (cap.target === 'none') {
    for (const key of ['target', 'pair', 'attachTarget']) {
      if (step[key] === 'target') step[key] = 'self';
    }
    if (step.kind === 'spawnToken' && step.location === 'targetLocation') step.location = 'self';
    if (step.kind === 'moveToken' && ['push', 'pull'].includes(step.mode) && step.pair === step.target) {
      delete step.pair;
      delete step.distance;
      Object.assign(step, { mode: 'shift', dx: '1', dy: '0' });
    }
  }
  if (step.kind === 'terrainEdit' && step.target === undefined && cap.castArea === 'none') step.target = 'self';
  if (step.kind === 'moveToken' && trigger === 'preCombat') {
    for (const key of ['pair', 'distance', 'location', 'dx', 'dy']) delete step[key];
    Object.assign(step, { target: 'self', mode: 'terrainGeometry' });
  }
  for (const branch of [step.then, step.else]) {
    if (Array.isArray(branch)) branch.forEach(inner => fitStepToTrigger(inner, trigger));
  }
  return step;
}
