/** @layer contracts/domains */
import { boundedText, nonNegativeNumber, plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
/** The damage type a weapon with no authored family deals. Defense reduces it like any physical hit. */
export const UNTYPED_DAMAGE_TYPE = 'none';

/**
 * The damage types Defense reduces, untyped hits included; a blank type counts as untyped. Resistance reduces
 * MAGICAL_DAMAGE_TYPES.
 */
export const PHYSICAL_DAMAGE_TYPES = Object.freeze([
  'slashing', 'piercing', 'crushing', 'missile', UNTYPED_DAMAGE_TYPE, ''
]);
export const MAGICAL_DAMAGE_TYPES = Object.freeze([
  'fire', 'ice', 'lightning', 'wind', 'arcane', 'decay', 'shadow', 'holy'
]);

export const DAMAGE_TYPES = Object.freeze([
  'slashing', 'piercing', 'crushing', 'missile', 'fire', 'ice', 'lightning', 'wind',
  'arcane', 'decay', 'shadow', 'holy'
]);

export const DAMAGE_POLICIES = Object.freeze({
  WEAPON: 'weapon',
  ABILITY: 'ability',
  DAMAGE_OVER_TIME: 'damageOverTime'
});

const POLICY_SET = new Set(Object.values(DAMAGE_POLICIES));

/** Check whether a value names a supported game/combat damage policy. */
export function isDamagePolicy(value) {
  return POLICY_SET.has(value);
}

export const HEALTH_CHANGE_TYPES = Object.freeze({ DAMAGE: 'damage', HEAL: 'heal' });

export const DEFEAT_STATUSES = Object.freeze({
  CLAIMED: 'claimed',
  EXTRA_LIFE: 'extra-life',
  SURVIVED: 'survived',
  ALREADY_DEFEATED: 'already-defeated'
});

export const STANCE_BREAK_EFFECT_NAME = 'Stance Break';
export const STANCE_BREAK_STATUS_ID = 'StanceBreak';
export const STANCE_BREAK_OUTCOMES = Object.freeze({
  NONE: 'none',
  APPLIED: 'applied',
  CLEARED: 'cleared',
  REPAIRED: 'repaired',
  FAILED: 'failed',
  STALE: 'stale'
});

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */
/** `fadeSettle` is the pause that lets the fade's own filter animation finish before the Token is removed. */
export const DEFEAT_PRESENTATION_TIMING = Object.freeze({
  continuationDelay: 500,
  fadeLeadIn: 500,
  fadeDuration: 1000,
  fadeSettle: 300
});

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
export const HEALTH_PRESENTATION_KIND = 'health-change';
export const DEFEAT_PRESENTATION_KIND = 'unit-defeat';
export const STANCE_BREAK_PRESENTATION_KIND = 'stance-break';
export const DEFEAT_PRESENTATION_TYPES = Object.freeze({
  FADE: 'fade',
  CLEAR_FADE: 'clear-fade',
  EXTRA_LIFE: 'extra-life'
});

const DAMAGE_TYPE_SET = new Set([...DAMAGE_TYPES, UNTYPED_DAMAGE_TYPE]);
const CHANGE_SET = new Set(Object.values(HEALTH_CHANGE_TYPES));
const VARIANT_SET = new Set(['default', 'alt']);
const DEFEAT_PRESENTATION_SET = new Set(Object.values(DEFEAT_PRESENTATION_TYPES));
const ALLOWED_MESSAGE_KEYS = new Set([
  'kind', 'change', 'tokenUuid', 'damageType', 'amount', 'stanceAmount', 'absorbed',
  'hpBefore', 'hpAfter', 'hpMax', 'critical', 'lastHit', 'lastStandTriggered',
  'physicalVariant', 'allowSoftHit', 'displayAmount', 'displayStanceAmount', 'defeatVoice'
]);

/**
 * Build the damage or healing popup every client shows. Where the HP actually written differs from the rule's
 * result, it shows the written value.
 * @param {object} input Token, change, the rule's totals, and the written totals when there are any.
 * @returns {Readonly<object>}
 */
export function healthPresentationMessage({
  tokenUuid,
  change,
  resolution,
  persisted = null,
  critical = false,
  lastHit = null,
  physicalVariant = 'default'
}) {
  const healing = change === HEALTH_CHANGE_TYPES.HEAL;
  const hpAfter = Number.isFinite(persisted?.hpAfter) ? persisted.hpAfter : resolution.hpAfter;
  const stanceAfter = Number.isFinite(persisted?.stanceAfter) ? persisted.stanceAfter : resolution.stanceAfter;
  return Object.freeze({
    kind: HEALTH_PRESENTATION_KIND,
    change,
    tokenUuid,
    damageType: healing ? '' : String(resolution.damageType ?? 'none'),
    amount: resolution.amount,
    stanceAmount: resolution.stanceAmount,
    absorbed: healing ? 0 : Number(resolution.absorbed) || 0,
    hpBefore: resolution.hpBefore,
    hpAfter,
    hpMax: resolution.hpMax,
    critical: !healing && critical === true,
    lastHit: healing ? false : (lastHit === null ? resolution.defeated === true : lastHit === true),
    lastStandTriggered: !healing && resolution.lastStandTriggered === true,
    physicalVariant: healing ? 'default' : physicalVariant,
    allowSoftHit: !healing && resolution.presentation?.allowSoftHit === true,
    defeatVoice: healing ? '' : String(persisted?.defeatVoice ?? ''),
    displayAmount: healing ? resolution.requestedAmount : resolution.amount,
    displayStanceAmount: healing ? resolution.requestedStanceAmount : (stanceAfter > 0 ? resolution.stanceAmount : 0)
  });
}

/** Check a damage or healing popup message received over the socket. */
export function isHealthPresentationMessage(value) {
  if (!plainRecord(value) || Object.keys(value).some(key => !ALLOWED_MESSAGE_KEYS.has(key))) return false;
  if (value.kind !== HEALTH_PRESENTATION_KIND || !CHANGE_SET.has(value.change)) return false;
  if (!boundedText(value.tokenUuid, 512)) return false;
  for (const key of ['amount', 'stanceAmount', 'absorbed', 'hpBefore', 'hpAfter', 'hpMax']) {
    if (!nonNegativeNumber(value[key])) return false;
  }
  if (!nonNegativeNumber(value.displayAmount) || !nonNegativeNumber(value.displayStanceAmount)) return false;
  if (typeof value.critical !== 'boolean' || typeof value.lastHit !== 'boolean'
    || typeof value.lastStandTriggered !== 'boolean' || typeof value.allowSoftHit !== 'boolean') return false;
  if (!VARIANT_SET.has(value.physicalVariant)) return false;
  if (value.defeatVoice !== '' && !boundedText(value.defeatVoice, 2048)) return false;
  return value.change === HEALTH_CHANGE_TYPES.HEAL
    ? value.damageType === ''
    : value.damageType === '' || DAMAGE_TYPE_SET.has(value.damageType);
}

/** Check a defeat or Extra Life message received over the socket. */
export function isDefeatPresentationMessage(value) {
  return plainRecord(value)
    && Object.keys(value).length === 3
    && value.kind === DEFEAT_PRESENTATION_KIND
    && DEFEAT_PRESENTATION_SET.has(value.change)
    && boundedText(value.tokenUuid, 512);
}

/** Check the message the GM's client sends to show a stance break once it is saved. */
export function isStanceBreakPresentationMessage(value) {
  if (!plainRecord(value)) return false;
  return Object.keys(value).length === 2
    && value.kind === STANCE_BREAK_PRESENTATION_KIND
    && boundedText(value.tokenUuid, 512);
}
