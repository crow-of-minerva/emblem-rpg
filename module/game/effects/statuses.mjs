/** @layer game/effects */
import { BLEEDING_STATUS_ID } from '../../contracts/domains/characters.mjs';
import { ENCOUNTER_DECAY_FLAGS, GUARD_BOND_EFFECT_NAME } from '../../contracts/domains/combat.mjs';
import { STANCE_BREAK_EFFECT_NAME, STANCE_BREAK_STATUS_ID } from '../../contracts/domains/damage.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { END_TRIGGER_KEYS } from '../../contracts/dsl/custom-status.mjs';
import { FLIGHT_STATUS_MARKERS, STATUS_EFFECTS } from '../../config/statuses.mjs';
import { hpFloor } from '../combat/damage.mjs';

/* -------------------------------------------- */
/*  Status ticks                                */
/* -------------------------------------------- */

/** The end flags that fire at a phase boundary. The others fire on an event during play. */
const PHASE_END_FLAGS = Object.freeze(new Set(Object.values(ENCOUNTER_DECAY_FLAGS)));

/**
 * What an end trigger does to the statuses it fires for, removing any left with no phases or stacks. A status with a
 * `triggerSheds` object loses one phase, or one stack when it is stackable and has no phases or sheds a stack on that
 * trigger; a status without one ticks by planFixedTick.
 * @param {object[]} effects The unit's effects as `{id, name, stackable, stackCount, stackLimit, duration,
 *   triggerSheds}` plus their end flags, with `triggerSheds` null when the effect has none.
 * @param {string|string[]} flagKey The end flag that fired. Given several, a status carrying more than one ticks
 *   once, by the first of them it carries.
 * @returns {{removeIds: string[], durations: object[], stacks: object[]}}
 */
export function planStatusTicks(effects = [], flagKey = '') {
  const flagKeys = [flagKey].flat().map(String).filter(Boolean);
  const plan = { removeIds: [], durations: [], stacks: [] };
  for (const effect of effects) {
    const flag = flagKeys.find(key => effect?.[key] === true);
    const id = String(effect?.id ?? '');
    if (!flag || !id) continue;
    const sheds = effect.triggerSheds;
    if (sheds === null || typeof sheds !== 'object') {
      planFixedTick(plan, id, effect, flag);
      continue;
    }
    const phases = Math.max(0, Math.floor(Number(effect.duration) || 0));
    if (effect.stackable === true && (phases === 0 || sheds[flag] === true)) addStackLoss(plan, id, effect);
    else if (phases <= 1) plan.removeIds.push(id);
    else plan.durations.push({ id, duration: phases - 1 });
  }
  return plan;
}

/** Add one lost stack to a tick plan, or the whole effect at its last stack. */
function addStackLoss(plan, id, effect) {
  const current = Math.max(1, Math.floor(Number(effect.stackCount) || 1));
  if (current <= 1) plan.removeIds.push(id);
  else plan.stacks.push({ id, name: String(effect.name ?? ''), from: current, to: current - 1 });
}

/**
 * The tick for a status without `triggerSheds`: an event trigger removes it, and a phase trigger sheds a stack from a
 * stack with a limit, removes one without, and takes one phase from anything else.
 */
function planFixedTick(plan, id, effect, flag) {
  const duration = Number(effect.duration);
  if (!PHASE_END_FLAGS.has(flag)) plan.removeIds.push(id);
  else if (effect.stackable === true) {
    if (Math.floor(Number(effect.stackLimit) || 0) > 0) addStackLoss(plan, id, effect);
    else plan.removeIds.push(id);
  } else if (!Number.isFinite(duration) || duration <= 1) plan.removeIds.push(id);
  else plan.durations.push({ id, duration: duration - 1 });
}

/* -------------------------------------------- */
/*  Encounter statuses                          */
/* -------------------------------------------- */

/** Flags only equipment and mount effects carry: standing state a unit keeps from one encounter to the next. */
const STANDING_EFFECT_FLAGS = Object.freeze(['isWieldEffect', 'isArmorEffect', 'isMountEffect']);

/**
 * Status ids that stand for a unit's standing condition rather than a status: Stance Break, which only regained
 * stance clears, the equipment and mount markers, and the flight markers.
 */
const STANDING_STATUS_IDS = Object.freeze(new Set([
  STANCE_BREAK_STATUS_ID, 'Wielding', 'Wearing', 'Mounted',
  ...Object.values(FLIGHT_STATUS_MARKERS).map(marker => marker.id)
]));

/** The flags a status writer sets to say when its status ends. Any one of them makes an effect a status. */
const STATUS_LIFECYCLE_FLAGS = Object.freeze([...END_TRIGGER_KEYS, 'stackable']);

/** Every status id in the STATUS_EFFECTS registry, plus the id both halves of a Guard bond carry. */
const STATUS_IDS = Object.freeze(new Set([
  ...Object.values(STATUS_EFFECTS).map(definition => definition.id), GUARD_BOND_EFFECT_NAME
]));

/**
 * Whether an effect a unit wears is a status, which planEncounterAftermath (game/combat/phases.mjs) clears when an
 * encounter ends. Statuses are what the status writers apply: `applyEffect` presets, custom statuses and statuses
 * given from the Token HUD, each with a phase `duration`. Rallies, Guard bond halves, and any effect carrying a
 * registry status id or a status-lifecycle flag count too. Equipment and mount effects, Stance Break and the flight
 * markers are standing state, not statuses. An effect with none of these marks, such as one a GM made by hand, is
 * left alone.
 * @param {{name?: string, statuses?: readonly string[], flags?: object}} effect The effect's name, its status ids
 *   and its system-scope flags.
 * @returns {boolean}
 */
export function isEncounterStatus(effect = {}) {
  const flags = effect?.flags ?? {};
  const statuses = (effect?.statuses ?? []).map(String);
  if (STANDING_EFFECT_FLAGS.some(flag => flags[flag] === true)) return false;
  if (effect?.name === STANCE_BREAK_EFFECT_NAME || statuses.some(id => STANDING_STATUS_IDS.has(id))) return false;
  if (typeof flags.duration === 'number' || Boolean(flags.rally) || Boolean(flags.guardRole)) return true;
  if (STATUS_LIFECYCLE_FLAGS.some(flag => flags[flag] === true)) return true;
  return statuses.some(id => STATUS_IDS.has(id));
}


/* -------------------------------------------- */
/*  Phase-opening ticks                         */
/* -------------------------------------------- */

/** Ordered damage statuses used by planPhaseStartTicks. */
const PHASE_TICKS = Object.freeze({
  bleeding: Object.freeze({
    key: 'bleeding', statusId: BLEEDING_STATUS_ID, dieSize: 4, damageType: '', stanceDamage: 0, unpreventable: true
  }),
  poisoned: Object.freeze({
    key: 'poisoned', statusId: 'Poisoned', formula: '1d6', damageType: 'decay', stanceDamage: 0, unpreventable: false
  }),
  corpseRot: Object.freeze({
    key: 'corpseRot', statusId: 'CorpseRot', formula: '2d8', damageType: 'decay', stanceDamage: 1, unpreventable: false
  })
});

/**
 * The status damage a unit takes when its phase opens, in order: Bleeding deals 1d4 per stack and sheds a stack,
 * Poison deals 1d6 decay, and Corpse Rot deals 2d8 decay and 1 stance damage. Corpse Rot is no longer in the status
 * registry, but a unit carrying its id still takes the tick. Lords and Retainers stop at 1 HP unless the applied
 * effect, or its registry entry, sets dotCanKillPlayer.
 * @param {object} unit The unit's `actorType`, `statuses` {poisoned, corpseRot}, and `effects` with their `statuses`.
 * @returns {object[]} `{formula, damageType, stanceDamage, canKillPlayer, lethal, unpreventable, shed}` each.
 */
export function planPhaseStartTicks(unit = {}) {
  const ticks = [];
  const bleed = statusEffectFact(unit, PHASE_TICKS.bleeding.statusId);
  if (bleed) {
    const stacks = Math.max(1, Math.floor(Number(bleed.stackCount) || 1));
    ticks.push(phaseTick(unit, PHASE_TICKS.bleeding, {
      formula: `${stacks}d${PHASE_TICKS.bleeding.dieSize}`,
      shed: planStackShed(bleed)
    }));
  }
  if (unit.statuses?.poisoned === true) ticks.push(phaseTick(unit, PHASE_TICKS.poisoned, { shed: null }));
  if (unit.statuses?.corpseRot === true) ticks.push(phaseTick(unit, PHASE_TICKS.corpseRot, { shed: null }));
  return ticks;
}

/** Whether a status's tick may reduce a player unit to 0 HP: the applied effect's flag first, the registry's second. */
function statusTickCanKillPlayer(key, effect = null) {
  if (typeof effect?.dotCanKillPlayer === 'boolean') return effect.dotCanKillPlayer;
  return STATUS_EFFECTS[key]?.flags?.dotCanKillPlayer === true;
}

function statusEffectFact(unit, statusId) {
  return (unit.effects ?? []).find(effect => (effect?.statuses ?? []).includes(statusId)) ?? null;
}

function phaseTick(unit, tick, extra) {
  const canKillPlayer = statusTickCanKillPlayer(tick.key, statusEffectFact(unit, tick.statusId));
  return { ...tick, ...extra, canKillPlayer, lethal: hpFloor(unit.actorType, canKillPlayer) === 0 };
}

/** Cap a rolled tick's damage: a lethal tick may finish the unit, and a non-lethal one stops at 1 HP. */
export function clampTickDamage(rolled, remainingHp, lethal) {
  const hp = Math.max(0, Math.floor(Number(remainingHp) || 0));
  const amount = Math.max(0, Math.floor(Number(rolled) || 0));
  return Math.min(amount, lethal ? hp : Math.max(0, hp - 1));
}

/**
 * The average damage planPhaseStartTicks' ticks will deal when the unit's phase opens, each capped by the HP the
 * earlier ticks leave. foundry/adapters/projections/board.mjs reports it as `pendingPhaseDamage` for the Enemy AI's
 * scoring.
 * @param {object} unit The unit, as {@link planPhaseStartTicks} reads it.
 * @param {{hp?: number, average?: Function}} [options] Current HP, and a function that averages a dice formula.
 * @returns {number}
 */
export function expectedPhaseStartDamage(unit = {}, { hp = 0, average = () => 0 } = {}) {
  const health = Math.max(0, Number(hp) || 0);
  if (health <= 0) return 0;
  let taken = 0;
  for (const tick of planPhaseStartTicks(unit)) {
    const room = Math.max(0, health - taken - (tick.lethal ? 0 : 1));
    taken += Math.min(Math.max(0, Number(average(tick.formula)) || 0), room);
  }
  return taken;
}

/* -------------------------------------------- */
/*  On-hit debuffs                              */
/* -------------------------------------------- */

/** The entry triggers that run when an attack hits. */
const ON_HIT_TRIGGERS = Object.freeze(['onHit', 'onHitOrCrit']);

/**
 * Whether an item's authored entries apply a harmful effect to the target on a hit. The Enemy AI's loadout
 * (projectLoadoutWeapon in projections/attack-targeting.mjs) reports it as `onHitDebuff`. Only top-level steps are
 * checked.
 * @param {readonly object[]} entries Authored `effects` entries.
 * @returns {boolean}
 */
export function hasOnHitDebuff(entries = []) {
  return (Array.isArray(entries) ? entries : []).some(entry => {
    if (!ON_HIT_TRIGGERS.includes(String(entry?.trigger ?? ''))) return false;
    const steps = entry?.action?.steps;
    return Array.isArray(steps) && steps.some(step => step?.kind === 'applyEffect'
      && String(step.target ?? '') === 'target' && !stepIsBeneficial(step));
  });
}

/** A preset step is beneficial when the registry marks it so, and a custom one when its own flags do. */
function stepIsBeneficial(step) {
  const preset = String(step?.preset ?? '');
  if (preset && preset !== 'custom') return STATUS_EFFECTS[preset]?.beneficial === true;
  return step?.customData?.flags?.[SYSTEM_ID]?.beneficial === true;
}

/* -------------------------------------------- */
/*  Stack shedding                              */
/* -------------------------------------------- */

/**
 * The plan, in planStatusTicks' shape, that removes one stack from the effect, or the whole effect at its last stack.
 * settleUnitTicks (engine/combat/encounters/phases.mjs) hands it to the encounter writer's applyEffectDecay once the
 * tick's damage has landed.
 */
function planStackShed(effect) {
  const plan = { removeIds: [], durations: [], stacks: [] };
  addStackLoss(plan, String(effect.id ?? ''), effect);
  return plan;
}
