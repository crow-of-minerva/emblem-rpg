/** @layer game/items */
import { resolveActivationConsumption } from './activation.mjs';

/*
 * The rules for retractable item uses. A use of an item marked retractable (`system.retractable`) is saved on the
 * unit's `system.turn.retraction` until the unit acts again or its turn ends. Cancel takes it back, and also undoes a
 * walk made since it in the same movement plan.
 * The field holds JSON text of `{pending, memory}`: `pending` is the one use that can still be taken back (its undo
 * record, item, whether it landed, and the movement spent, token position and movement plan at the time), and
 * `memory` maps each retractable item used this turn to its passed skill check and dice, so using it again after
 * taking it back rolls nothing new. It is text so the undo records save and write it back as one value.
 */

/**
 * Read the saved field, or null when nothing is kept or remembered.
 * @param {string|null} text The unit's `system.turn.retraction`.
 * @returns {{pending: object|null, memory: Record<string, object>}|null}
 */
export function parseRetraction(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const pending = value.pending && typeof value.pending === 'object' ? value.pending : null;
    const memory = value.memory && typeof value.memory === 'object' && !Array.isArray(value.memory)
      ? value.memory : {};
    return { pending, memory };
  } catch {
    return null;
  }
}

/**
 * The text to save, or null when nothing is kept and nothing remembered.
 * @param {{pending?: object|null, memory?: Record<string, object>}} retraction
 * @returns {string|null}
 */
export function serializeRetraction({ pending = null, memory = {} } = {}) {
  if (!pending && !Object.keys(memory ?? {}).length) return null;
  return JSON.stringify({ pending: pending ?? null, memory: memory ?? {} });
}

/**
 * The parts of the unit's turn a kept use saves and Cancel compares: the movement spent, and the open movement
 * plan's start time and anchor in pixels. With no plan open the start time is 0, which no open plan has.
 * @param {object} turn The unit's `system.turn`.
 * @returns {{movementSpent: number, planStartedAt: number, anchorX: number, anchorY: number}}
 */
export function retractionTurn(turn = {}) {
  const planning = turn?.movementPlanning === true;
  return {
    movementSpent: Number(turn?.movementSpent) || 0,
    planStartedAt: planning ? Number(turn.movementPlanStartedAt) || 0 : 0,
    anchorX: Number(turn?.movementAnchorX) || 0,
    anchorY: Number(turn?.movementAnchorY) || 0
  };
}

/**
 * Whether the unit has a use it can take back, whether it has moved since that use, and whether taking it back can
 * first return the unit to the use's square (`returnable`): only while the walk since is uncommitted, in the same
 * open plan.
 * @param {object|null} retraction The parsed field (parseRetraction).
 * @param {object} turn The unit's `system.turn` now.
 * @param {{x?: number, y?: number}} position Its token's position now, in pixels.
 * @returns {{pending: boolean, moved: boolean, returnable: boolean, itemUuid: string,
 *   position: {x: number, y: number}|null}} `position` is the token's position at the use, in pixels.
 */
export function retractionStanding(retraction, turn = {}, { x = 0, y = 0 } = {}) {
  const pending = retraction?.pending;
  if (!pending) return { pending: false, moved: false, returnable: false, itemUuid: '', position: null };
  const now = retractionTurn(turn);
  const spentSince = (Number(pending.movementSpent) || 0) !== now.movementSpent;
  const moved = spentSince || Number(pending.x) !== Number(x) || Number(pending.y) !== Number(y);
  const samePlan = now.planStartedAt !== 0 && (Number(pending.planStartedAt) || 0) === now.planStartedAt
    && Number(pending.anchorX) === now.anchorX && Number(pending.anchorY) === now.anchorY;
  return {
    pending: true,
    moved,
    returnable: moved && !spentSince && samePlan,
    itemUuid: String(pending.itemUuid ?? ''),
    position: { x: Number(pending.x) || 0, y: Number(pending.y) || 0 }
  };
}

/**
 * What keeping a use for good does to its item: the same rule as an ordinary use (resolveActivationConsumption),
 * read against the item's uses as they stand now, so a consumable at zero is destroyed.
 * @param {{type?: string, system?: object}} item The item the use was made with.
 * @param {boolean} landed Whether the use landed.
 * @returns {{consume: boolean, remaining: number, destroy: boolean}}
 */
export function pendingUseConsumption(item, landed) {
  const system = item?.system ?? {};
  return resolveActivationConsumption({
    envelope: {
      usesType: String(system.uses?.type ?? 'limited'),
      usesCurrent: Math.max(0, Number(system.uses?.current) || 0),
      consumeOnFailure: system.effectData?.consumeOnFailure !== false,
      consumable: String(item?.type ?? '') === 'Consumable'
    },
    landed: landed === true
  });
}

/**
 * The passed skill check and dice one item rolled this turn, or null when it rolled nothing yet.
 * @param {object|null} retraction The parsed field (parseRetraction).
 * @param {string} itemUuid The item.
 * @returns {{check: object|null, rolls: Record<string, number>}|null} Each roll keyed by the effect step that made it.
 */
export function retractionMemoryFor(retraction, itemUuid) {
  const entry = retraction?.memory?.[itemUuid];
  if (!entry || typeof entry !== 'object') return null;
  const rolls = Object.entries(entry.rolls ?? {}).filter(([, value]) => Number.isFinite(Number(value)))
    .map(([key, value]) => [key, Number(value)]);
  return { check: entry.check ?? null, rolls: Object.fromEntries(rolls) };
}

/**
 * The memory with one item's check result and dice replaced.
 * @param {Record<string, object>|null} memory The current memory.
 * @param {string} itemUuid The item.
 * @param {{check?: object|null, rolls?: Record<string, number>}} remembered
 * @returns {Record<string, object>}
 */
export function rememberRetraction(memory, itemUuid, { check = null, rolls = {} } = {}) {
  return { ...(memory ?? {}), [itemUuid]: { check, rolls: { ...rolls } } };
}

/**
 * Whether a use's skill check was rolled and failed. A failed check makes a retractable use final at once.
 * @param {object[]} deliveries One delivery per target, as engine/items/activation.mjs records them.
 * @returns {boolean}
 */
export function activationCheckFailed(deliveries = []) {
  return deliveries.some(delivery => delivery?.delivery === 'check' && delivery.skillCheck
    && delivery.skillCheck.success !== true);
}

/**
 * The passed skill check a use rolled, to reuse when the item is used again after being taken back. A check that
 * passed without a roll, or that shared one roll across targets, is not remembered.
 * @param {object[]} deliveries One delivery per target.
 * @returns {{success: boolean, total: number, natural: number, dc: number}|null}
 */
export function rememberedCheck(deliveries = []) {
  const check = deliveries.find(delivery => delivery?.delivery === 'check' && delivery.skillCheck?.success === true
    && delivery.skillCheck.autoSucceeded !== true && delivery.skillCheck.shared !== true)?.skillCheck;
  if (!check) return null;
  return { success: true, total: Number(check.total) || 0, natural: Number(check.natural) || 0,
    dc: Number(check.dc) || 0 };
}
