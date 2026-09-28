/** @layer contracts/domains */

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
/** The world setting a companion module holds while it drives the board through a whole phase. */
export const DRIVEN_HOLD_SETTING = 'drivenBoardHold';

/** How long a driven hold may stand before the active GM clears it as abandoned (reapDrivenBoard). */
const DRIVEN_HOLD_STALE_MS = 5 * 60 * 1000;

const DRIVER_ID_LIMIT = 128;
const LABEL_LIMIT = 64;
const TOKEN_NAME_LIMIT = 64;
const TOKEN_IMG_LIMIT = 512;
const HOLDER_ID_LIMIT = 128;
const HOLDER_NAME_LIMIT = 64;

/**
 * Normalize the stored board hold for encounter projections and document writes. Returns null when no holder is
 * recorded.
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
 * Tell encounter document writes whether the board hold can be cleared because its holder disconnected or timed
 * out.
 */
export function drivenHoldIsStale(hold, { holderActive = false, now = Date.now() } = {}) {
  if (!hold) return false;
  return holderActive !== true || (now - hold.acquiredAt) > DRIVEN_HOLD_STALE_MS;
}

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
/** Bound companion-module labels and unit details before encounter document writes store a board hold. */
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
