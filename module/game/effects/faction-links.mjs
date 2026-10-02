/** @layer game/effects */
import { isPlainObject } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Faction changes tied to a status            */
/* -------------------------------------------- */

/**
 * @typedef {object} FactionLinkRecord What one change faction step changed on a unit, saved on the ActiveEffect of
 *   the status it is tied to (FACTION_LINK_FLAG) and written back when that status is deleted.
 * @property {number} order Which change came first on this unit, when several statuses each changed its faction.
 * @property {string} role The faction role the step gave the unit.
 * @property {string|null} previousRole The unit's faction role before the step.
 * @property {string} tokenUuid The token whose disposition the step changed, or '' when it changed none.
 * @property {number|null} disposition The disposition the step gave that token.
 * @property {number|null} previousDisposition The token's disposition before the step.
 * @property {Record<string, number|null>} ownership Each user the step made an owner, with that user's ownership
 *   level before it, or null when the actor had no entry for the user.
 */

/** Whether a stored value is a faction change record this file wrote. */
export function isFactionLinkRecord(record) {
  return isPlainObject(record) && Number.isFinite(record.order) && typeof record.role === 'string';
}

/** The `order` for a new record on a unit, after every record its other statuses already hold. */
export function nextFactionLinkOrder(records = []) {
  return records.filter(isFactionLinkRecord).reduce((highest, record) => Math.max(highest, record.order), 0) + 1;
}

/**
 * Plan one change faction step on one unit. When the status already holds a record (the step ran again while the
 * status lasts), its saved old values are kept, so deleting the status still restores the unit as it was first.
 * @param {object} input
 * @param {FactionLinkRecord|null} [input.record] The record the status already holds.
 * @param {number} input.order The order for a new record (nextFactionLinkOrder).
 * @param {string} input.role The faction role the step sets.
 * @param {number|null} [input.disposition] The disposition that role gives the token, or null to leave it.
 * @param {{role?: string, tokenUuid?: string, disposition?: number|null, ownership?: object}} input.current The
 *   unit as it is now: its role, its token and that token's disposition, and its ownership levels by user id.
 * @param {string[]} [input.grants] The users the step makes owners.
 * @param {number} input.ownerLevel Foundry's OWNER ownership level.
 * @returns {{record: FactionLinkRecord, ownership: Record<string, number>}} The record to save on the status, and the
 *   ownership levels to write on the actor.
 */
export function planFactionChange({ record = null, order, role, disposition = null, current = {}, grants = [],
  ownerLevel }) {
  const levels = current.ownership ?? {};
  const granted = [...new Set(grants)].filter(userId => !(Number(levels[userId]) >= ownerLevel));
  const added = Object.fromEntries(granted.map(userId => [userId, numberOrNull(levels[userId])]));
  const kept = isFactionLinkRecord(record) ? record : null;
  const tokenUuid = disposition === null ? '' : String(current.tokenUuid ?? '');
  return {
    record: {
      order: kept ? kept.order : order,
      role,
      previousRole: kept ? kept.previousRole : roleOrNull(current.role),
      tokenUuid: kept?.tokenUuid || tokenUuid,
      disposition: disposition ?? kept?.disposition ?? null,
      previousDisposition: kept ? kept.previousDisposition : numberOrNull(current.disposition),
      ownership: { ...added, ...(kept?.ownership ?? {}) }
    },
    ownership: Object.fromEntries(granted.map(userId => [userId, ownerLevel]))
  };
}

/**
 * Plan what to write back when a status holding a faction change record is deleted.
 *
 * When a later faction change on the same unit is still tied to another live status, the unit keeps its current
 * faction, and that later record takes over this one's old values, so the unit returns to its first faction when the
 * last status ends. Otherwise the old values are written back. A value the GM has changed since the step ran (the
 * role, the disposition, or a user who is no longer an owner) is left as the GM set it.
 * @param {object} input
 * @param {FactionLinkRecord} input.record The deleted status's record.
 * @param {{effectId: string, record: FactionLinkRecord}[]} [input.others] Records still on the unit's other statuses.
 * @param {{role?: string, disposition?: number|null, ownership?: object}} [input.current] The unit as it is now.
 * @param {number} input.ownerLevel Foundry's OWNER ownership level.
 * @returns {{role: string|null, disposition: number|null, grant: Record<string, number>, revoke: string[],
 *   handOff: {effectId: string, record: FactionLinkRecord}|null}} The role and disposition to write (null to leave
 *   them), the ownership levels to write back, the users whose entry to delete, and the record to save on another
 *   status instead.
 */
export function planFactionRevert({ record, others = [], current = {}, ownerLevel }) {
  const none = { role: null, disposition: null, grant: {}, revoke: [], handOff: null };
  if (!isFactionLinkRecord(record)) return none;
  const disposition = Number.isFinite(record.previousDisposition) && record.tokenUuid
    && current.disposition === record.disposition ? record.previousDisposition : null;
  const later = others.filter(other => isFactionLinkRecord(other?.record) && other.record.order > record.order)
    .sort((a, b) => a.record.order - b.record.order)[0];
  if (later) {
    const sameToken = later.record.tokenUuid === record.tokenUuid;
    return {
      ...none,
      disposition: sameToken ? null : disposition,
      handOff: {
        effectId: String(later.effectId ?? ''),
        record: {
          ...later.record,
          previousRole: record.previousRole,
          previousDisposition: sameToken ? record.previousDisposition : later.record.previousDisposition,
          ownership: { ...later.record.ownership, ...record.ownership }
        }
      }
    };
  }
  const levels = current.ownership ?? {};
  const grant = {};
  const revoke = [];
  for (const [userId, previous] of Object.entries(record.ownership ?? {})) {
    if (Number(levels[userId]) !== ownerLevel) continue;
    if (previous === null) revoke.push(userId);
    else grant[userId] = previous;
  }
  const role = current.role === record.role && typeof record.previousRole === 'string' ? record.previousRole : null;
  return { ...none, role, disposition, grant, revoke };
}

function numberOrNull(value) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? null : Number(value);
}

function roleOrNull(value) {
  return typeof value === 'string' ? value : null;
}
