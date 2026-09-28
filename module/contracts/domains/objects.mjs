/** @layer contracts/domains */
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
export const OBJECT_TYPES = Object.freeze([
  '', 'Destructible', 'Armament', 'Door', 'Chest', 'Loot', 'Gathering Node',
  'Altar', 'Cooking Pot', 'Stationary', 'Workshop', 'Laboratory', 'Instrument'
]);

export const OBJECT_FIXTURE_TYPES = Object.freeze([
  'Chest', 'Armament', 'Loot', 'Gathering Node',
  'Altar', 'Cooking Pot', 'Stationary', 'Workshop', 'Laboratory', 'Instrument'
]);

/**
 * Subtypes whose features aren't built yet: they have nothing to author on the Object sheet and no board
 * interaction. `objectSubtypeBracketed` in `game/objects/rules.mjs` is the check.
 */
export const BRACKETED_OBJECT_TYPES = Object.freeze(['Altar']);

/**
 * Subtypes a unit can work only during free exploration. In an encounter, `resolveInteractionTarget` in
 * `game/objects/rules.mjs` ignores them, so the Interact press does nothing on one.
 */
export const EXPLORATION_ONLY_OBJECT_TYPES = Object.freeze([
  'Gathering Node', 'Altar', 'Stationary', 'Cooking Pot', 'Workshop', 'Laboratory', 'Instrument'
]);

export const LOCKABLE_OBJECT_TYPES = Object.freeze(['Chest', 'Door']);

/** Item types accepted as the key to a Chest or Door lock. */
export const LOCK_KEY_ITEM_TYPES = Object.freeze(['Equipment', 'Consumable', 'Miscellaneous']);

/** Item types a Chest or Loot sheet accepts as contents. */
export const CONTAINER_ITEM_TYPES = Object.freeze([...LOCK_KEY_ITEM_TYPES, 'Resource']);

/** The shapes an Armament aims in: Cross measures Manhattan distance, Square and Cone measure Chebyshev. */
export const TARGET_SHAPES = Object.freeze(['Cross', 'Square', 'Cone']);

/** The eight compass sectors an Armament may restrict its aim to, in the order the sheet's pad reads them. */
export const TARGET_AREA_KEYS = Object.freeze(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']);

export const LOCK_METHODS = Object.freeze({ KEY: 'key', LOCKTOUCH: 'locktouch' });

/** The skill a lock is picked with, for chests and doors alike. */
export const LOCKTOUCH_SKILL_KEY = 'handicraft';

/** Item name required by the lock-opening command for a Locktouch attempt. */
export const LOCKTOUCH_ITEM_NAME = 'Locktouch';

/** The wielder's own document flags that record a borrowed Armament and the weapon it displaced. */
export const ARMAMENT_FLAGS = Object.freeze({
  UUID: 'armamentUuid',
  PREVIOUS_WIELDED_ID: 'armamentPrevWieldedId'
});

/**
 * Wall flag shared by the door writer and vision projection. It identifies the owning Door so its walls do not
 * hide its own face.
 */
export const DOOR_WALL_FLAG = 'doorWall';

export const DROP_ACTIONS = Object.freeze({ GROUND: 'ground', DISCARD: 'discard' });

/**
 * What a ground drop settlement reports (foundry/adapters/document-writes/objects.mjs): settled, stale (nothing
 * written) or reverted (undone after a failed write). No writer produces `blocked` or `recovery-required`.
 */
export const DROP_SETTLEMENT_OUTCOMES = Object.freeze({
  SETTLED: 'settled',
  STALE: 'stale',
  BLOCKED: 'blocked',
  REVERTED: 'reverted',
  RECOVERY_REQUIRED: 'recovery-required'
});

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
const MAX_UUID_LENGTH = 512;
const LOCK_INTENT_KEYS = ['sourceTokenUuid', 'lockTokenUuid', 'method'];
const ARMAMENT_WIELD_KEYS = ['sourceTokenUuid', 'armamentTokenUuid'];
const ARMAMENT_RELEASE_KEYS = ['sourceTokenUuid', 'restore'];
const DROP_INTENT_KEYS = ['sourceTokenUuid', 'itemId', 'action'];
const UNPLACED_DROP_INTENT_KEYS = ['sourceActorUuid', 'itemId', 'action'];
const DOCUMENT_ID = /^[A-Za-z0-9]{8,32}$/;

/** Bound one lock-opening request. Anything outside the three named fields is refused. */
export function normalizeLockOpenIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, LOCK_INTENT_KEYS)) return null;
  const sourceTokenUuid = String(payload.sourceTokenUuid ?? '');
  const lockTokenUuid = String(payload.lockTokenUuid ?? '');
  const method = String(payload.method ?? '');
  if (!boundedText(sourceTokenUuid, MAX_UUID_LENGTH) || !sourceTokenUuid.includes('.Token.')) return null;
  if (!boundedText(lockTokenUuid, MAX_UUID_LENGTH) || !lockTokenUuid.includes('.Token.')) return null;
  if (!Object.values(LOCK_METHODS).includes(method)) return null;
  return Object.freeze({ sourceTokenUuid, lockTokenUuid, method });
}

/** Bound one take-up request. The Armament is named by its placed Token, never by its base Actor. */
export function normalizeArmamentWieldIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ARMAMENT_WIELD_KEYS)) return null;
  const sourceTokenUuid = String(payload.sourceTokenUuid ?? '');
  const armamentTokenUuid = String(payload.armamentTokenUuid ?? '');
  if (!boundedText(sourceTokenUuid, MAX_UUID_LENGTH) || !sourceTokenUuid.includes('.Token.')) return null;
  if (!boundedText(armamentTokenUuid, MAX_UUID_LENGTH) || !armamentTokenUuid.includes('.Token.')) return null;
  return Object.freeze({ sourceTokenUuid, armamentTokenUuid });
}

/** Bound one release request. `restore` says whether the displaced weapon comes back into hand. */
export function normalizeArmamentReleaseIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ARMAMENT_RELEASE_KEYS)) return null;
  const sourceTokenUuid = String(payload.sourceTokenUuid ?? '');
  if (!boundedText(sourceTokenUuid, MAX_UUID_LENGTH) || !sourceTokenUuid.includes('.Token.')) return null;
  if (typeof payload.restore !== 'boolean') return null;
  return Object.freeze({ sourceTokenUuid, restore: payload.restore });
}

/**
 * Bound one drop request: the unit's placed Token, the carried Item, and whether it lands or is destroyed. A unit
 * standing on no Scene is named by its Actor instead, and can only destroy what it carries.
 */
export function normalizeItemDropIntent(payload) {
  if (!plainRecord(payload)) return null;
  const itemId = String(payload.itemId ?? '');
  const action = String(payload.action ?? '');
  if (!DOCUMENT_ID.test(itemId) || !Object.values(DROP_ACTIONS).includes(action)) return null;
  if (Object.hasOwn(payload, 'sourceActorUuid')) {
    if (!exactKeys(payload, UNPLACED_DROP_INTENT_KEYS) || action !== DROP_ACTIONS.DISCARD) return null;
    const sourceActorUuid = String(payload.sourceActorUuid ?? '');
    if (!boundedText(sourceActorUuid, MAX_UUID_LENGTH)) return null;
    return Object.freeze({ sourceTokenUuid: '', sourceActorUuid, itemId, action });
  }
  if (!exactKeys(payload, DROP_INTENT_KEYS)) return null;
  const sourceTokenUuid = String(payload.sourceTokenUuid ?? '');
  if (!boundedText(sourceTokenUuid, MAX_UUID_LENGTH) || !sourceTokenUuid.includes('.Token.')) return null;
  return Object.freeze({ sourceTokenUuid, sourceActorUuid: '', itemId, action });
}

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */
/**
 * Lock-picking timings: the wait for the dice, and the pause after a failed pick. The engine waits on its own clock,
 * not on Dice So Nice.
 */
export const LOCK_ATTEMPT_TIMING = Object.freeze({ diceSettleHold: 2600, failureHold: 1200 });

/**
 * A Destructible breaks behind smoke. The plume starts `swapDelay` after the blow, and the art swaps once the smoke
 * has covered the Token for `smokeCover`.
 */
export const OBJECT_DESTRUCTION_TIMING = Object.freeze({ swapDelay: 600, smokeCover: 900 });

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
export const OBJECT_PRESENTATION_KIND = 'object-interaction';

export const OBJECT_PRESENTATION_EVENTS = Object.freeze({
  LOCKPICK_FAILED: 'lockpick-failed',
  DESTROYED: 'destroyed'
});

/** Build one bounded object feedback message the active GM broadcasts after a settlement. */
export function objectPresentationMessage(event, data = {}) {
  if (!Object.values(OBJECT_PRESENTATION_EVENTS).includes(event)) {
    throw new TypeError(`Unknown object presentation event: ${event}`);
  }
  return Object.freeze({ kind: OBJECT_PRESENTATION_KIND, event, ...structuredClone(data) });
}

/** Accept only bounded object feedback at the presentation socket. */
export function isObjectPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== OBJECT_PRESENTATION_KIND) return false;
  if (!Object.values(OBJECT_PRESENTATION_EVENTS).includes(value.event)) return false;
  if (value.tokenUuid !== undefined && !boundedText(String(value.tokenUuid), MAX_UUID_LENGTH)) return false;
  try { return JSON.stringify(value).length <= 4096; } catch { return false; }
}
