/** @layer contracts/domains */

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
/** The world setting a module (such as Enemy AI) holds while it moves units through a whole phase. */
export const DRIVEN_HOLD_SETTING = 'drivenBoardHold';

/** How long a module's hold may last before the GM's client clears it as abandoned (reapDrivenBoard). */
const DRIVEN_HOLD_STALE_MS = 5 * 60 * 1000;

const DRIVER_ID_LIMIT = 128;
const LABEL_LIMIT = 64;
const TOKEN_NAME_LIMIT = 64;
const TOKEN_IMG_LIMIT = 512;
const HOLDER_ID_LIMIT = 128;
const HOLDER_NAME_LIMIT = 64;

/**
 * Clean up the stored hold for the encounter code that reads and writes it. Returns null when no one holds it.
 */
export function normalizeDrivenHold(raw) {
  const holderId = boundedString(raw?.holderId, HOLDER_ID_LIMIT);
  if (!holderId) return null;
  return Object.freeze({
    driverId: boundedString(raw?.driverId, DRIVER_ID_LIMIT),
    holderId,
    holderName: boundedString(raw?.holderName, HOLDER_NAME_LIMIT) || 'Someone',
    label: boundedString(raw?.label, LABEL_LIMIT) || 'Automation',
    tokenName: boundedString(raw?.tokenName, TOKEN_NAME_LIMIT),
    tokenImg: boundedString(raw?.tokenImg, TOKEN_IMG_LIMIT),
    acquiredAt: Number(raw?.acquiredAt) || 0
  });
}

/**
 * Whether the hold can be cleared because the user who took it disconnected or it timed out.
 */
export function drivenHoldIsStale(hold, { holderActive = false, now = Date.now() } = {}) {
  if (!hold) return false;
  return holderActive !== true || (now - hold.acquiredAt) > DRIVEN_HOLD_STALE_MS;
}

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
/** Check a module's label and unit details before the hold is stored. */
export function normalizeDrivenHoldIntent(payload = {}) {
  return Object.freeze({
    driverId: boundedString(payload?.driverId, DRIVER_ID_LIMIT),
    label: boundedString(payload?.label, LABEL_LIMIT) || 'Automation',
    tokenName: boundedString(payload?.tokenName, TOKEN_NAME_LIMIT),
    tokenImg: boundedString(payload?.tokenImg, TOKEN_IMG_LIMIT)
  });
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
function boundedString(value, maximum) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum);
}
