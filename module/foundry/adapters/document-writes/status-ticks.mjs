/** @layer foundry/adapters/document-writes */
/*
 * Writes a planned change to a unit's statuses: phases counted down, stacks shed and statuses removed. The plan comes
 * from planStatusTicks for an end trigger or planStatusRemoval for a remove status step (game/effects/statuses.mjs),
 * and each caller passes its own write options so its hooks recognise the write.
 */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { planStatusTicks } from '../../../game/effects/statuses.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { stackRescale } from '../services/host.mjs';
import { projectStatusTickFacts } from '../projections/encounters.mjs';

/**
 * Write one unit's tick plan: delete the statuses it removes, count down phases and shed stacks. A shed stack scales
 * the effect's additive changes to the new count. An effect that is already gone is skipped. Everything changed is
 * saved in the undo record first. An error from a write reaches the caller.
 * @param {Actor} actor The unit.
 * @param {{removeIds: string[], durations: object[], stacks: object[]}} plan From planStatusTicks or planStatusRemoval.
 * @param {object|null} [operation] The running command's undo record.
 * @param {object} [options] The write options the calling writer's hooks check.
 * @returns {Promise<boolean>} Whether anything was written.
 */
export async function applyStatusTickPlan(actor, plan, operation = null, options = {}) {
  const effects = collectionValues(actor?.effects);
  const byId = id => effects.find(candidate => candidate.id === id) ?? null;
  const removeIds = [...new Set((plan?.removeIds ?? []).filter(byId))];
  const removed = new Set(removeIds);
  const updates = (plan?.durations ?? []).filter(entry => byId(entry.id) && !removed.has(entry.id)).map(entry => ({
    _id: entry.id,
    [`flags.${SYSTEM_ID}.duration`]: entry.duration
  }));
  for (const stack of plan?.stacks ?? []) {
    const effect = byId(stack.id);
    if (!effect || removed.has(stack.id)) continue;
    updates.push({
      _id: stack.id,
      [`flags.${SYSTEM_ID}.stackCount`]: stack.to,
      'system.changes': stackRescale(effect, stack.from, stack.to)
    });
  }
  if (!removeIds.length && !updates.length) return false;
  await operation?.capture({
    deleting: removeIds.map(byId),
    documents: updates.map(entry => byId(entry._id))
  });
  if (removeIds.length) await actor.deleteEmbeddedDocuments('ActiveEffect', removeIds, options);
  if (updates.length) await actor.updateEmbeddedDocuments('ActiveEffect', updates, options);
  return true;
}

/**
 * Tick the listed statuses on one unit for one end trigger, planned from the effects as they are now. A listed
 * effect that no longer carries the flag, or is gone, is left alone.
 * @param {Actor} actor The unit.
 * @param {string[]} effectIds The effects the trigger fires for.
 * @param {string} flagKey The end flag that fired, such as `removeWhenAttacked`.
 * @param {object|null} [operation] The running command's undo record.
 * @param {object} [options] The write options the calling writer's hooks check.
 * @returns {Promise<boolean>} Whether anything was written.
 */
export async function tickStatusEffects(actor, effectIds, flagKey, operation = null, options = {}) {
  const wanted = new Set((effectIds ?? []).map(String).filter(Boolean));
  if (!actor || !wanted.size) return false;
  const facts = collectionValues(actor.effects).filter(effect => wanted.has(effect.id)).map(projectStatusTickFacts);
  return applyStatusTickPlan(actor, planStatusTicks(facts, flagKey), operation, options);
}
