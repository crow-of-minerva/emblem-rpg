/** @layer foundry/adapters/document-writes */
import { USER_LOCK_SETTING } from '../../../config/settings.mjs';
import { GUARD_BOND_EFFECT_NAME } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { TELEPORT_SETTLEMENT_OUTCOMES } from '../../../contracts/domains/terrain.mjs';
import { GROUNDED_BY_STANCE_BREAK_FLAG, planMovementSpend } from '../../../game/movement/input-policy.mjs';
import { collectionValues, structurallyEqual } from '../../../lib/core/runtime.mjs';
import { clone } from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Movement state                              */
/* -------------------------------------------- */

/** The turn fields a movement plan owns, read from prepared data as the planner sees them. */
function movementState(actor) {
  const turn = actor.system?.turn ?? {};
  return {
    actionAvailable: turn.actionAvailable !== false,
    bonusActionAvailable: turn.bonusActionAvailable !== false,
    movementSpent: Number(turn.movementSpent) || 0,
    movementAvailable: turn.movementAvailable !== false,
    extraActionUsed: turn.extraActionUsed === true,
    continuationPending: String(turn.continuationPending ?? ''),
    continuationRequestId: String(turn.continuationRequestId ?? ''),
    movementPlanning: turn.movementPlanning === true,
    canterPathfinding: turn.canterPathfinding === true,
    movementControllerId: String(turn.movementControllerId ?? ''),
    movementAnchorX: Number(turn.movementAnchorX) || 0,
    movementAnchorY: Number(turn.movementAnchorY) || 0,
    movementPlanStartedAt: Number(turn.movementPlanStartedAt) || 0
  };
}

/** Whether the unit's turn state and position still match what the command planned against. */
export function snapshotStillCurrent(token, actor, snapshot) {
  const turn = actor.system?.turn ?? {};
  return (Number(turn.movementSpent) || 0) === snapshot.movementSpent
    && (turn.movementAvailable !== false) === snapshot.movementAvailable
    && (turn.actionAvailable !== false) === snapshot.standardAvailable
    && turn.movementPlanning === true
    && (turn.canterPathfinding === true) === snapshot.canterPathfinding
    && String(turn.movementControllerId ?? '') === snapshot.movementControllerId
    && (Number(turn.movementAnchorX) || 0) === snapshot.anchorPosition.x
    && (Number(turn.movementAnchorY) || 0) === snapshot.anchorPosition.y
    && token._source.x === snapshot.sourcePosition.x
    && token._source.y === snapshot.sourcePosition.y;
}

const TURN_PATH = 'system.turn.';

/**
 * The Actor fields a movement write changes: the unit's turn block and, when a flier lands or takes off, its
 * Grounded status and the flag a Stance Break sets (taking off clears it). movementActorCapture records only these
 * paths for undo, not the whole Character.
 */
const TURN_PATHS = Object.freeze(['system.turn']);
const TURN_AND_GROUNDED_PATHS = Object.freeze([
  'system.turn', 'system.statuses.grounded', `flags.${SYSTEM_ID}.${GROUNDED_BY_STANCE_BREAK_FLAG}`
]);

export function movementActorCapture(actor, { grounds = false } = {}) {
  return { document: actor, paths: grounds ? TURN_AND_GROUNDED_PATHS : TURN_PATHS };
}

/**
 * Whether a turn write actually took effect. A preUpdate hook can veto an update without an error, so movement
 * writes read the saved turn back before they release the movement lock or report success.
 *
 * Only the turn paths are compared, because a write may change other fields alongside the turn and Foundry adds
 * `_id` to the changes object it is given. Callers still hand Foundry a copy, not the object they check afterwards.
 */
export function turnChangesLanded(actor, changes) {
  const turn = actor.system?.turn ?? {};
  return Object.entries(changes ?? {})
    .filter(([path]) => path.startsWith(TURN_PATH))
    .every(([path, value]) => structurallyEqual(turn[path.slice(TURN_PATH.length)], value));
}

/** Whether both positions have the same x and y on the map. */
export function samePosition(left, right) {
  const a = left?._source ?? left;
  const b = right?._source ?? right;
  return Number(a?.x) === Number(b?.x) && Number(a?.y) === Number(b?.y);
}

/** Fresh options for a placement that puts a unit where the rules say it stands, rather than walking it there. */
export function movementRestoreOptions() {
  return { animate: false, emblemMovementRestore: true };
}

/* -------------------------------------------- */
/*  Movement lock                               */
/* -------------------------------------------- */

/** A copy of the movement-lock setting, safe to compare or record. */
export function movementLockNow() {
  return clone(game.settings.get(SYSTEM_ID, USER_LOCK_SETTING)) ?? null;
}

/** Normalize the stored movement lock into the plain shape engine/movement reads. */
export function normalizeLock(lock) {
  if (!lock?.holderId || !lock?.tokenUuid) return null;
  return Object.freeze({
    holderId: String(lock.holderId),
    holderName: String(lock.holderName ?? 'Someone'),
    tokenUuid: String(lock.tokenUuid),
    actorUuid: String(lock.actorUuid ?? ''),
    tokenName: String(lock.tokenName ?? 'a Token'),
    tokenImg: String(lock.tokenImg ?? ''),
    acquiredAt: Number(lock.acquiredAt) || 0
  });
}

export function sameLock(left, right) {
  return Boolean(left && right)
    && left.holderId === right.holderId
    && left.tokenUuid === right.tokenUuid
    && left.acquiredAt === right.acquiredAt;
}

/** Locks this user acquired before this page loaded are abandoned, whatever their age. */
const PAGE_STARTED_AT = Date.now();

/**
 * Whether a planning lock is stale: the user holding it has disconnected, or this user took it before the page last
 * loaded. A plan has no timeout while that user stays connected, but the GM can restore and release a live plan.
 */
export function lockIsStale(lock) {
  const user = game.users.get(lock.holderId);
  if (!user?.active) return true;
  return user.isSelf === true && Number(lock.acquiredAt) < PAGE_STARTED_AT;
}

/* -------------------------------------------- */
/*  Closing a plan                              */
/* -------------------------------------------- */

/**
 * Other documents closing a plan can change besides the unit's own Actor and Token: the unit's Guard partners and
 * their bond effects. FoundryMovementRepository records them with the rest before the first write.
 */
export function planEndCaptures(actor, token, { guardBonds = null } = {}) {
  const deleting = [];
  const documents = [];
  const bond = token ? guardBonds?.bondOf?.(token) ?? null : null;
  for (const partner of [bond?.guarded, bond?.guarder].filter(Boolean)) {
    documents.push(partner);
    deleting.push(...guardBondEffects(partner.actor));
  }
  return { documents, deleting };
}

/**
 * Finish a plan that has just closed: break a Guard bond the unit no longer stands in (FoundryGuardBondRepository in
 * document-writes/tokens.mjs). A failed write throws.
 */
export async function settlePlanEnd(actor, token, { guardBonds = null, operation = null } = {}) {
  await guardBonds?.recheck([token.uuid], { operation });
}

/**
 * Close a movement plan: write the turn the caller planned, release the movement lock, then finish the plan's end
 * (settlePlanEnd). Everything is recorded in the caller's undo record first, so a later failure can be undone.
 * @returns {Promise<boolean>} false if the token, turn or lock changed while closing, or the turn write didn't take.
 */
export async function closeMovementPlan({
  token, actor, changes, guardBonds = null, operation = null
}) {
  const before = movementState(actor);
  const lock = movementLockNow();
  const position = { x: token._source.x, y: token._source.y };
  const cleanup = planEndCaptures(actor, token, { guardBonds });
  await operation?.capture({
    documents: [movementActorCapture(actor), token, ...cleanup.documents],
    deleting: cleanup.deleting,
    settings: [USER_LOCK_SETTING]
  });
  if (!samePosition(token, position) || !structurallyEqual(movementState(actor), before)
    || !structurallyEqual(movementLockNow(), lock)) return false;
  await actor.update(clone(changes), {});
  if (!turnChangesLanded(actor, changes)) return false;
  await releaseLockAndSettlePlanEnd(actor, token, { guardBonds, operation });
  return true;
}

/**
 * Release the movement lock and finish the plan's end (settlePlanEnd) side by side: neither reads what the other
 * writes. Both are waited for before a failure is thrown, the lock's first, so the caller's undo never runs while a
 * write is still in flight.
 */
export async function releaseLockAndSettlePlanEnd(actor, token, options = {}) {
  const outcomes = await Promise.allSettled([
    game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, null),
    settlePlanEnd(actor, token, options)
  ]);
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}

/* -------------------------------------------- */
/*  Teleport hops                               */
/* -------------------------------------------- */

export function teleportOutcome(code, reasonCode) {
  return Object.freeze({ ok: code === TELEPORT_SETTLEMENT_OUTCOMES.SETTLED, code, reasonCode });
}

/**
 * Carry out one teleport hop for FoundryMovementRepository.teleport, in this order: move the token pad to pad, write
 * the movement charge the rules worked out, and release the movement lock if the hop ends the plan. A refused write
 * returns REVERTED, which engine/movement/commands.mjs refuses as TELEPORT_SETTLEMENT_FAILED.
 */
export async function settleTeleportHop(snapshot, resolution, charge, token, actor, operation = null) {
  const destination = Object.freeze({
    x: resolution.destination.x * snapshot.gridSize,
    y: resolution.destination.y * snapshot.gridSize
  });
  const before = movementState(actor);
  const lock = movementLockNow();
  const changes = teleportTurnChanges(snapshot, resolution, charge, destination);
  await operation?.capture({ documents: [movementActorCapture(actor), token], settings: [USER_LOCK_SETTING] });
  if (!snapshotStillCurrent(token, actor, snapshot) || !structurallyEqual(movementState(actor), before)
    || !structurallyEqual(movementLockNow(), lock)) {
    return teleportOutcome(TELEPORT_SETTLEMENT_OUTCOMES.STALE, 'movement.teleport-facts-stale');
  }
  try {
    // Foundry v14 ignores the `teleport` key here; the 'displace' action is what makes the move instant.
    const landed = await token.move({ ...destination, teleport: true, action: 'displace' }, movementRestoreOptions());
    if (landed === false || !samePosition(token, destination)) throw new Error('movement.teleport-hop-refused');
    await actor.update(clone(changes), {});
    if (!turnChangesLanded(actor, changes)) throw new Error('movement.teleport-write-refused');
    if (charge.resume !== true) await game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, null);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'settleTeleportHop');
    return teleportOutcome(TELEPORT_SETTLEMENT_OUTCOMES.REVERTED,
      String(error?.message ?? 'movement.teleport-write-failed'));
  }
  return teleportOutcome(TELEPORT_SETTLEMENT_OUTCOMES.SETTLED, '');
}

/** The turn a hop leaves behind: its movement charge, the action or bonus it spends, and its new starting point. */
function teleportTurnChanges(snapshot, resolution, charge, destination) {
  const changes = {
    'system.turn.movementSpent': planMovementSpend({
      priorSpent: snapshot.movementSpent,
      legCost: resolution.cost + Math.max(0, Number(charge.movementSpent) || 0),
      charges: snapshot.exploring !== true
    }),
    'system.turn.movementAvailable': snapshot.exploring === true
      ? snapshot.movementAvailable
      : charge.resume === true && charge.anchors !== true,
    'system.turn.movementPlanning': charge.resume === true,
    'system.turn.canterPathfinding': charge.resume === true && snapshot.canterPathfinding === true,
    'system.turn.movementControllerId': charge.resume === true ? snapshot.movementControllerId : '',
    'system.turn.movementAnchorX': destination.x,
    'system.turn.movementAnchorY': destination.y,
    'system.turn.movementPlanStartedAt': charge.resume === true ? snapshot.movementPlanStartedAt : 0
  };
  if (charge.spendsBonus) changes['system.turn.bonusActionAvailable'] = false;
  if (charge.spendsAction) changes['system.turn.actionAvailable'] = false;
  if (charge.endTurn === true) {
    changes['system.turn.actionAvailable'] = false;
    changes['system.turn.bonusActionAvailable'] = false;
  }
  return changes;
}

/* -------------------------------------------- */
/*  Guard bonds                                 */
/* -------------------------------------------- */

/** The Guard bond effects FoundryGuardBondRepository deletes when a bond breaks, recorded before the recheck runs. */
function guardBondEffects(actor) {
  return collectionValues(actor?.effects).filter(effect => (
    effect?.name === GUARD_BOND_EFFECT_NAME && Boolean(effect?.flags?.[SYSTEM_ID]?.guardRole)
  ));
}
