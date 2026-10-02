/** @layer foundry/adapters/projections */
import { CAMPAIGN_PARTIES_SETTING } from '../../../config/settings.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { reportFoundryProbe } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Party state                                 */
/* -------------------------------------------- */
/**
 * @typedef {object} PartyRecord
 * @property {string} id
 * @property {string} name
 * @property {string|null} [convoyUuid]
 */

/**
 * @typedef {object} PartyState
 * @property {PartyRecord[]} parties
 * @property {Record<string, string>} membership
 * @property {Record<string, string>} lords
 */

/** A deep copy of a stored party setting, with id-less parties dropped and a missing map left empty. */
export function normalizePartyState(value) {
  const raw = (value === null || value === undefined ? {} : structuredClone(value));
  const parties = Array.isArray(raw.parties) ? raw.parties.filter(party => party?.id) : [];
  const membership = isRecord(raw.membership) ? raw.membership : {};
  const lords = isRecord(raw.lords) ? raw.lords : {};
  return { parties, membership, lords };
}

/** Read the stored party configuration, which is empty until a GM has configured one. */
export function readPartyState() {
  try {
    return normalizePartyState(globalThis.game?.settings?.get?.(SYSTEM_ID, CAMPAIGN_PARTIES_SETTING));
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'readPartyState', globalThis.game?.ready !== true && /is not a registered game setting$/.test(String(diagnosticError?.message ?? '')));
    return { parties: [], membership: {}, lords: {} };
  }
}

/* -------------------------------------------- */
/*  Membership                                  */
/* -------------------------------------------- */
/**
 * The ids of the non-GM users who own an actor, in world user order. GMs are left out because a GM owns everything,
 * so counting them would put every unit in whichever party the GM happens to be in.
 */
function projectPlayerOwnerIds(actor) {
  if (!actor.ownership) return [];
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const ids = [];
  for (const user of globalThis.game?.users?.contents ?? []) {
    if (user.isGM) continue;
    if (projectOwnershipLevel(actor.ownership, user.id) >= owner) ids.push(String(user.id));
  }
  return ids;
}

/** One user's ownership level on a document, with an absent entry inheriting the document default. */
export function projectOwnershipLevel(ownership, userId) {
  return Number(ownership?.[String(userId)] ?? ownership?.default ?? 0) || 0;
}

/**
 * The party an actor belongs to: the party of the first owning player who is in one. Ownership through the
 * "All Players" default counts.
 * @param {Actor} actor The unit.
 * @param {PartyState} [state] Party state already read, so a caller checking many units reads the setting once.
 * @returns {string|null} Party id, or null when no owning player is assigned to one.
 */
export function projectActorPartyId(actor, state = readPartyState()) {
  const { parties, membership } = state;
  if (!actor || !parties.length) return null;
  for (const userId of projectPlayerOwnerIds(actor)) {
    const party = parties.find(entry => entry.id === membership[userId]);
    if (party) return String(party.id);
  }
  return null;
}

/** The id of the party a user is assigned to, or null. */
export function projectUserPartyId(userId) {
  if (!userId) return null;
  const { parties, membership } = readPartyState();
  const party = parties.find(entry => entry.id === membership[userId]);
  return party ? String(party.id) : null;
}

/** The Actor uuid a user's Lord is recorded against, or an empty string when they have none. */
export function projectUserLordUuid(userId) {
  if (!userId) return '';
  return String(readPartyState().lords[String(userId)] ?? '');
}

/* -------------------------------------------- */
/*  Record guards                               */
/* -------------------------------------------- */
function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
