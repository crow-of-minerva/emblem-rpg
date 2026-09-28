/** @layer game/economy */
import { DOWNTIME_ROSTER_FACTIONS } from '../../contracts/domains/downtime.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { actionLaneBlock } from '../downtime/social.mjs';
import { clampDisposition, resolveVendorReach } from './vendor.mjs';

/* -------------------------------------------- */
/*  Bands and rewards                           */
/* -------------------------------------------- */
/**
 * How a haggle's Trading check total shifts a Vendor's disposition toward the haggling party, highest band first.
 * Each band is the lowest total that earns its shift, and a total under every other band loses a point.
 */
const HAGGLE_BANDS = Object.freeze([
  Object.freeze({ minimum: 30, shift: 7 }),
  Object.freeze({ minimum: 28, shift: 6 }),
  Object.freeze({ minimum: 25, shift: 5 }),
  Object.freeze({ minimum: 20, shift: 4 }),
  Object.freeze({ minimum: 17, shift: 3 }),
  Object.freeze({ minimum: 14, shift: 2 }),
  Object.freeze({ minimum: 10, shift: 1 }),
  Object.freeze({ minimum: 5, shift: 0 }),
  Object.freeze({ minimum: -Infinity, shift: -1 })
]);

/** Trading experience every haggle pays, whatever its result. */
const HAGGLE_EXPERIENCE_BASE = 5;

/** The check total at which a haggle stops paying extra experience; each point short of it adds one. */
const HAGGLE_EXPERIENCE_PAR = 20;

/* -------------------------------------------- */
/*  Stored haggles                              */
/* -------------------------------------------- */
/**
 * The key a haggle is stored under on the Vendor's `system.haggles`: the haggling unit's party, or the unit itself
 * when it belongs to no party. FoundryTradeRepository resolves the party through projectActorPartyId.
 */
export function haggleKey({ partyId, actorUuid } = {}) {
  return partyId ? `party:${partyId}` : `unit:${String(actorUuid ?? '')}`;
}

/** A Vendor's stored haggles read as `{key, bonus}` rows, dropping any row without a key or a whole bonus. */
export function haggleEntries(raw) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const entries = [];
  for (const row of raw) {
    const key = typeof row?.key === 'string' ? row.key : '';
    if (!key || !Number.isInteger(row.bonus)) continue;
    entries.push(Object.freeze({ key, bonus: row.bonus }));
  }
  return Object.freeze(entries);
}

/** The haggle stored for one key, or null when that party or unit has not haggled with the Vendor. */
export function haggleEntry(entries, key) {
  if (!key || !Array.isArray(entries)) return null;
  return entries.find(entry => entry?.key === key) ?? null;
}

/**
 * The disposition a party sees and pays at a Vendor: the Vendor's own disposition plus the party's haggle, kept
 * within the range the pricing curves in ./vendor.mjs cover. The base disposition itself is never written.
 */
export function effectiveDisposition(base, entries, key) {
  return clampDisposition(clampDisposition(base) + (haggleEntry(entries, key)?.bonus ?? 0));
}

/* -------------------------------------------- */
/*  Standing and plans                          */
/* -------------------------------------------- */
/**
 * Whether the shop offers Haggle and whether the unit at the counter may take it, for inspectShop in
 * engine/economy/trade.mjs. It is offered only in free exploration. `rostered` says whether the unit belongs to the
 * downtime roster factions at all, and `blocked` names why a rostered unit cannot spend its Downtime Action; both
 * are checked only while the party has not already haggled.
 * @param {object} standing `exploring`, `haggled`, and the `buyer` with its `actorType`, `commitment` and
 *   `defeated`.
 * @returns {Readonly<{offered: boolean, available: boolean, haggled: boolean, rostered: boolean, blocked: string}>}
 */
export function resolveHaggleStanding({ exploring, haggled, buyer } = {}) {
  const offered = exploring === true;
  const locked = haggled === true;
  const rostered = inDowntimeRoster(buyer);
  const blocked = offered && !locked && rostered ? actionLaneBlock(buyer) : '';
  return Object.freeze({
    offered, available: offered && !locked && rostered && !blocked, haggled: locked, rostered, blocked
  });
}

/**
 * Validate a haggle for engine/economy/trade.mjs before anything is rolled or written, in order: free exploration,
 * the pair's reach, the party's haggle this downtime, the unit's place in the downtime roster, then its Downtime
 * Action.
 * @param {object} facts FoundryTradeRepository.getHaggleFacts: `buyer`, `vendor` (with `haggles`), `key`, `reach`
 *   and `exploring`.
 * @returns {{ok: boolean, code: string, data: object}} A refusal, or an accept carrying the haggle key.
 */
export function planHaggle(facts = {}) {
  if (facts.exploring !== true) return refuse(RESULT_CODES.VENDOR_HAGGLE_EXPLORATION_REQUIRED);
  const reach = resolveVendorReach(facts.reach);
  if (!reach.ok) return reach;
  if (haggleEntry(facts.vendor?.haggles, facts.key)) {
    return refuse(RESULT_CODES.VENDOR_HAGGLE_LOCKED, { vendorName: String(facts.vendor?.name ?? '') });
  }
  if (!inDowntimeRoster(facts.buyer)) {
    return refuse(RESULT_CODES.DOWNTIME_PERFORMER_OUTSIDE_ROSTER, { actorName: String(facts.buyer?.name ?? '') });
  }
  const blocked = actionLaneBlock(facts.buyer);
  if (blocked) {
    return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { actorName: String(facts.buyer?.name ?? ''), blocked });
  }
  return accept(RESULT_CODES.VENDOR_HAGGLED, { key: facts.key });
}

/**
 * What a rolled haggle settles: the shift, the Trading experience, the Vendor's haggles with this key's entry
 * appended (fresh plain rows for FoundryTradeRepository.settleHaggle to write), and the party's disposition at the
 * Vendor before and after.
 * @param {object} input `vendor` from getHaggleFacts (`baseDisposition`, `haggles`), the haggle `key`, and the
 *   check `total`.
 * @returns {Readonly<{shift: number, experience: number, haggles: object[], dispositionBefore: number,
 *   dispositionAfter: number}>}
 */
export function planHaggleOutcome({ vendor, key, total } = {}) {
  const shift = haggleShift(total);
  const stored = haggleEntries(vendor?.haggles);
  const haggles = [...stored.map(entry => ({ key: entry.key, bonus: entry.bonus })), { key, bonus: shift }];
  return Object.freeze({
    shift,
    experience: haggleExperience(total),
    haggles,
    dispositionBefore: effectiveDisposition(vendor?.baseDisposition, stored, key),
    dispositionAfter: effectiveDisposition(vendor?.baseDisposition, haggles, key)
  });
}

/** Whether a unit takes downtime actions at all: only the DOWNTIME_ROSTER_FACTIONS, as every other activity. */
function inDowntimeRoster(unit) {
  return DOWNTIME_ROSTER_FACTIONS.includes(String(unit?.actorType ?? ''));
}

/** The disposition shift a Trading check total earns, from HAGGLE_BANDS. */
function haggleShift(total) {
  const value = Math.floor(Number(total));
  return (HAGGLE_BANDS.find(band => value >= band.minimum) ?? HAGGLE_BANDS[HAGGLE_BANDS.length - 1]).shift;
}

/** The flat Trading experience a haggle pays engine/economy/trade.mjs: more for a poorer check total. */
function haggleExperience(total) {
  return HAGGLE_EXPERIENCE_BASE + Math.max(0, HAGGLE_EXPERIENCE_PAR - Math.floor(total));
}
