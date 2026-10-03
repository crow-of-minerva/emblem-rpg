/** @layer foundry/adapters/document-writes */
import { STANCE_BREAK_EFFECT_DATA } from '../../../config/statuses.mjs';
import { SYSTEM_ID , recordDiagnostic } from '../../../contracts/protocol.mjs';
import { GROUNDED_BY_STANCE_BREAK_FLAG } from '../../../game/movement/input-policy.mjs';
import { collectionValues, finite as number } from '../../../lib/core/runtime.mjs';
import { isAirborneActor } from '../projections/combat-context.mjs';
import { sceneCombatActive } from '../projections/encounters.mjs';
import {
  isAdditiveEffectChange,
  isStanceBreakEffect,
  resolveActor
} from '../services/host.mjs';
import { FoundryDiagnostics } from '../services/diagnostics.mjs';
import { tickStatusEffects } from './status-ticks.mjs';

/** Marks these writes as the system's own, so the Stance hook in foundry/hooks/actors.mjs skips them. */
const settlementOptions = () => ({ emblemHealthSettlement: true });

/** The Actor fields a stance break that grounds a flier writes: its Grounded status and the mark saying why. */
const GROUNDED_BY_STANCE_BREAK_PATH = `flags.${SYSTEM_ID}.${GROUNDED_BY_STANCE_BREAK_FLAG}`;
const LANDING_PATHS = Object.freeze(['system.statuses.grounded', GROUNDED_BY_STANCE_BREAK_PATH]);

/* -------------------------------------------- */
/*  Stance repository                           */
/* -------------------------------------------- */
/**
 * Reads a Character's stance state and writes the Stance Break changes that resolveStanceBreak
 * (game/combat/damage.mjs) plans, for StanceBreakService (engine/combat/damage.mjs).
 */
export class FoundryStanceRepository {
  /**
   * The Character's HP, stance, flight state and stance-related effect ids, with a fingerprint commit uses to spot
   * changes. null for anything but a Character.
   */
  async getSnapshot(actorUuid) {
    const actor = await resolveActor(actorUuid);
    return actor?.type === 'Character' ? projectActor(actor) : null;
  }

  /**
   * Apply a stance transition if the actor still matches the snapshot it was planned from. If not, returns
   * `stale: true` so the caller reads again and replans.
   *
   * A fresh break first ticks the effects that end on a stance break (tickStatusEffects in status-ticks.mjs): each
   * ends, or loses a phase or a stack, as planStatusTicks decides. Before each write, everything it touches is
   * recorded in the caller's undo record: the effects ticked or removed, the Stance Break created, and for a flier
   * the break grounds, its Grounded status and the flag saying a stance break grounded it. A refused command then
   * restores the old effects and flight state together.
   * @param {object} snapshot The getSnapshot result the transition was planned from.
   * @param {object} transition The plan from resolveStanceBreak (game/combat/damage.mjs).
   * @param {{operation?: object|null}} [context] The running command's undo record, if any.
   */
  async commit(snapshot, transition, { operation = null } = {}) {
    const actor = await resolveActor(snapshot?.actorUuid);
    if (!actor || actor.type !== 'Character') return Object.freeze({ ok: false });
    const current = projectActor(actor);
    if (current.fingerprint !== snapshot.fingerprint) return Object.freeze({ ok: false, stale: true });

    const deleteIds = transition.deleteEffectIds.filter(id => effectById(actor, id));
    const creates = transition.createBreakEffect
      ? [{ ...cloneData(STANCE_BREAK_EFFECT_DATA), _id: foundry.utils.randomID() }] : [];
    const landing = transition.grounds === true
      ? { 'system.statuses.grounded': true, [GROUNDED_BY_STANCE_BREAK_PATH]: true } : null;
    try {
      await tickStatusEffects(actor, transition.tickEffectIds, 'removeOnStanceBreak', operation, settlementOptions());
      await writeStanceEffects(operation, actor, deleteIds, creates, landing);
      return Object.freeze({ ok: true, tokenUuid: current.tokenUuid });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/stances.mjs', error: diagnosticError, detail: 'commit'
      });
      return Object.freeze({ ok: false, diagnostic });
    }
  }
}

/* -------------------------------------------- */
/*  Stance writes                               */
/* -------------------------------------------- */

/**
 * Record the effects to delete, the new Stance Break and the landing for undo, then delete and create those effects
 * and land the flier the break grounds, the same way the flight action lands a unit. Throws if Foundry refuses any
 * step.
 */
async function writeStanceEffects(operation, actor, deleteIds, creates, landing = null) {
  await operation?.capture({
    documents: landing ? [{ document: actor, paths: LANDING_PATHS }] : [],
    deleting: deleteIds.map(id => actor.effects.get(id)).filter(Boolean),
    creating: creates.length
      ? [{ parent: actor, documentName: 'ActiveEffect', ids: creates.map(source => source._id) }] : []
  });
  if (deleteIds.length) {
    await actor.deleteEmbeddedDocuments('ActiveEffect', deleteIds, settlementOptions());
    if (deleteIds.some(id => actor.effects.has(id))) throw new Error('stance.effect-deletion-refused');
  }
  if (creates.length) {
    await actor.createEmbeddedDocuments('ActiveEffect', creates, { ...settlementOptions(), keepId: true });
    if (creates.some(source => !actor.effects.has(source._id))) throw new Error('stance.effect-creation-refused');
  }
  if (!landing) return;
  await actor.update(landing, settlementOptions());
  if (actor.system?.statuses?.grounded !== true) throw new Error('stance.grounding-refused');
}

/* -------------------------------------------- */
/*  Stance state                                */
/* -------------------------------------------- */
function projectActor(actor) {
  const breakEffectIds = [];
  const repairBreakEffectIds = [];
  const removeOnBreakEffectIds = [];
  for (const effect of collectionValues(actor.effects)) {
    const id = String(effect?.id ?? '');
    if (!id) continue;
    if (isStanceBreakEffect(effect)) {
      breakEffectIds.push(id);
      if (!matchesStanceBreakDefinition(effect)) repairBreakEffectIds.push(id);
    }
    if (removesOnStanceBreak(effect)) removeOnBreakEffectIds.push(id);
  }
  breakEffectIds.sort();
  repairBreakEffectIds.sort();
  removeOnBreakEffectIds.sort();
  const facts = {
    actorUuid: String(actor.uuid ?? ''),
    actorName: String(actor.name ?? 'Character'),
    tokenUuid: unitTokenUuid(actor),
    hp: number(actor.system?.resources?.hp?.value),
    stance: number(actor.system?.resources?.stn?.value),
    airborne: isAirborneActor(actor),
    levitating: actor.system?.combat?.levitation === true,
    breakEffectIds,
    repairBreakEffectIds,
    removeOnBreakEffectIds
  };
  return Object.freeze({
    ...facts,
    breakEffectIds: Object.freeze(breakEffectIds),
    repairBreakEffectIds: Object.freeze(repairBreakEffectIds),
    removeOnBreakEffectIds: Object.freeze(removeOnBreakEffectIds),
    fingerprint: JSON.stringify([
      facts.actorUuid, facts.hp, facts.stance, breakEffectIds, repairBreakEffectIds, removeOnBreakEffectIds,
      facts.airborne, facts.levitating
    ])
  });
}

function matchesStanceBreakDefinition(effect) {
  const expected = STANCE_BREAK_EFFECT_DATA.changes;
  const actual = collectionValues(effect?.changes);
  if (actual.length !== expected.length) return false;
  return expected.every(expectedChange => actual.some(change => (
    change?.key === expectedChange.key
      && number(change?.value) === number(expectedChange.value)
      && isAdditiveEffectChange(change)
  )));
}

function removesOnStanceBreak(effect) {
  return effect.getFlag(SYSTEM_ID, 'removeOnStanceBreak') === true;
}

/* -------------------------------------------- */
/*  Foundry helpers                             */
/* -------------------------------------------- */

/**
 * The Token the break is shown on, read from documents so a Scene the host client isn't viewing still gets it: a
 * synthetic Actor's own Token, otherwise the linked Token on a Scene with a started encounter, then the one on the
 * active Scene, then any.
 */
function unitTokenUuid(actor) {
  const parent = actor?.parent;
  if (parent?.documentName === 'Token' && parent.uuid) return String(parent.uuid);
  const tokens = collectionValues(actor?.getDependentTokens({ linked: true, concreteOnly: true }));
  const token = tokens.find(candidate => sceneCombatActive(candidate.parent))
    ?? tokens.find(candidate => candidate.parent === game.scenes.active)
    ?? tokens[0];
  return String(token?.uuid ?? '');
}

function effectById(actor, id) {
  return actor.effects.get(id) ?? null;
}

function cloneData(value) {
  return foundry.utils.deepClone(value);
}
