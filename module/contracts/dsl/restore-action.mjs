/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';

/** The actions a restore actions step can give back. All three together give the unit its whole turn back. */
export const RESTORABLE_ACTIONS = Object.freeze(['standard', 'bonus', 'movement']);

/**
 * Bring a restore actions step saved with the old whole turn choice (`turn`) to the current shape, returning a new
 * step. A step that listed `turn` now lists all three actions; any other step comes back as it was.
 * @param {object} step The step. It is not changed.
 * @returns {{step: object, changed: boolean}} `changed` is false when the step comes back as it was.
 */
export function normalizeRestoreAction(step) {
  if (!isPlainObject(step) || step.kind !== 'restoreAction' || !Array.isArray(step.actions)
    || !step.actions.includes('turn')) return { step, changed: false };
  return { step: { ...step, actions: [...RESTORABLE_ACTIONS] }, changed: true };
}
