/** @layer game/downtime */
import {
  DOWNTIME_LANES, DOWNTIME_STATION_TYPES, FACTION_RELATION_DC, FACTION_WEALTH_CAP, REQUISITION_AVAILABLE_KINDS,
  REQUISITION_LIMITS, REQUISITION_OUTCOMES, REQUISITION_SKILL_KEY, normalizeFactions
} from '../../contracts/domains/downtime.mjs';
import { RESULT_CODES, refuse } from '../../contracts/results.mjs';
import { resolveParticipants } from './rules.mjs';

/* -------------------------------------------- */
/*  Difficulty and demand                       */
/* -------------------------------------------- */
/**
 * The difficulty of asking a faction for a demand: the relation's base plus one per step of GP demanded, so
 * 1000 GP from a Friendly faction is DC 15 and from a Poor one DC 25. An unknown relation reads as Neutral, the
 * default normalizeFaction gives a row.
 * @param {string} relation One of FACTION_RELATIONS.
 * @param {number} demand The GP demanded.
 * @returns {number}
 */
export function requisitionDc(relation, demand) {
  const base = Object.hasOwn(FACTION_RELATION_DC, String(relation))
    ? FACTION_RELATION_DC[relation] : FACTION_RELATION_DC.Neutral;
  return base + Math.max(0, Math.floor((Number(demand) || 0) / REQUISITION_LIMITS.step));
}

/**
 * The most GP one requisition may demand of a faction by its wealth, or null when its coffers are boundless and only
 * REQUISITION_LIMITS.maxDemand bounds the demand. An unknown wealth reads as Average.
 * @param {string} wealth One of FACTION_WEALTH.
 * @returns {?number}
 */
export function wealthCap(wealth) {
  return Object.hasOwn(FACTION_WEALTH_CAP, String(wealth)) ? FACTION_WEALTH_CAP[wealth] : FACTION_WEALTH_CAP.Average;
}

/** Whether a demand is a whole number of steps, at least the minimum, within the faction's cap and the sanity limit. */
function demandValid(demand, wealth) {
  const { step, min } = REQUISITION_LIMITS;
  if (!Number.isSafeInteger(demand) || demand < min || demand % step !== 0) return false;
  return demand <= demandCeiling(wealth);
}

/** The highest demand a faction of this wealth accepts, with the sanity limit standing in for an uncapped one. */
function demandCeiling(wealth) {
  const cap = wealthCap(wealth);
  return cap === null ? REQUISITION_LIMITS.maxDemand : Math.min(cap, REQUISITION_LIMITS.maxDemand);
}

/* -------------------------------------------- */
/*  Faction rows                                */
/* -------------------------------------------- */
/**
 * Plan the Stationary's faction table after a requisition. The named row is marked requisitioned whether the faction
 * granted the demand or not, and every other row is unchanged.
 * The rows come back normalised and frozen, so the writer hands Foundry a copy.
 * @param {object[]} rows The station's faction rows.
 * @param {string} factionId The requisitioned row's `_id`.
 * @returns {readonly object[]} A new rows array. The input is untouched.
 */
export function planFactionLock(rows, factionId) {
  return frozenRows(normalizeFactions(rows).map(row => (
    row._id === factionId ? { ...row, requisitioned: true } : row
  )));
}

/**
 * Plan the faction table the GM's Reset Downtime writes: every row's requisition marker cleared, so each faction may
 * be asked again. The rows come back normalised and frozen, so the writer hands Foundry a copy.
 * @param {object[]} rows The station's faction rows.
 * @returns {readonly object[]} A new rows array. The input is untouched.
 */
export function planFactionReset(rows) {
  return frozenRows(normalizeFactions(rows).map(row => ({ ...row, requisitioned: false })));
}

function frozenRows(rows) {
  return Object.freeze(rows.map(row => Object.freeze(row)));
}

/* -------------------------------------------- */
/*  The request                                 */
/* -------------------------------------------- */
/**
 * Validate a requisition before anything is rolled or written, only in free exploration. The requisitioner must be
 * free for an Action activity and linked to a party Convoy, and the kind must be one the system supports. The faction
 * must be an enabled row not yet requisitioned this downtime, and the demand must fit its wealth.
 * @param {object} snapshot `station`, the acting unit (`cursor`), `exploring`, `inReach`, `roster` (downtime units
 *   carrying `convoyUuid`), `factions` (the station's rows) and `convoys` (`{[uuid]: {uuid, name}}`).
 * @param {object} intent A normalizeRequisitionIntent result.
 * @returns {Readonly<object>} A refusal, or `{ok: true, code, data}` with the plan also under `plan`.
 */
export function planRequisition(snapshot = {}, intent = {}) {
  if (snapshot.station?.objectType !== DOWNTIME_STATION_TYPES.REQUISITION) {
    return refuse(RESULT_CODES.DOWNTIME_STATION_INVALID);
  }
  if (snapshot.exploring !== true) return refuse(RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED);
  if (snapshot.inReach !== true) {
    return refuse(RESULT_CODES.DOWNTIME_OUT_OF_REACH, { actorName: snapshot.cursor?.name });
  }
  const performer = resolveParticipants(snapshot.roster ?? [], { lane: DOWNTIME_LANES.ACTION })
    .find(entry => entry.actorUuid === intent.performerUuid) ?? null;
  if (!performer) return refuse(RESULT_CODES.DOWNTIME_PERFORMER_OUTSIDE_ROSTER);
  if (!performer.eligible) {
    return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, {
      performerName: performer.name, blocked: performer.blocked
    });
  }
  const convoy = linkedConvoy(snapshot, performer);
  if (!convoy) return refuse(RESULT_CODES.DOWNTIME_CONVOY_REQUIRED, { performerName: performer.name });
  if (!REQUISITION_AVAILABLE_KINDS.includes(intent.kind)) {
    return refuse(RESULT_CODES.DOWNTIME_KIND_UNAVAILABLE, { kind: intent.kind });
  }
  const faction = normalizeFactions(snapshot.factions).find(row => row._id === intent.factionId) ?? null;
  if (!faction?.enabled) return refuse(RESULT_CODES.DOWNTIME_FACTION_UNKNOWN);
  if (faction.requisitioned) return refuse(RESULT_CODES.DOWNTIME_FACTION_LOCKED, { factionName: faction.name });
  if (!demandValid(intent.demand, faction.wealth)) {
    return refuse(RESULT_CODES.DOWNTIME_DEMAND_INVALID, {
      demand: intent.demand, cap: demandCeiling(faction.wealth), step: REQUISITION_LIMITS.step
    });
  }
  const plan = Object.freeze({
    performer,
    faction: Object.freeze(faction),
    kind: intent.kind,
    demand: intent.demand,
    dc: requisitionDc(faction.relation, intent.demand),
    skillKey: REQUISITION_SKILL_KEY,
    convoy,
    staged: performer.actorUuid !== snapshot.cursor?.actorUuid
  });
  return Object.freeze({ ok: true, code: RESULT_CODES.DOWNTIME_REQUISITIONED, data: plan, plan });
}

/** The requisitioner's linked Convoy with its name, or null when it has none or that Convoy could not be read. */
function linkedConvoy(snapshot, performer) {
  const uuid = String(performer.convoyUuid ?? '');
  const convoys = snapshot.convoys ?? {};
  if (!uuid || !Object.hasOwn(convoys, uuid)) return null;
  return Object.freeze({ uuid, name: String(convoys[uuid]?.name ?? '') });
}

/* -------------------------------------------- */
/*  Outcome                                     */
/* -------------------------------------------- */
/** How a requisition's Civics check turned out: a total over the difficulty succeeds, as every check does. */
export function requisitionOutcome(total, dc) {
  const value = checkNumber(total);
  const difficulty = checkNumber(dc);
  return value > difficulty ? REQUISITION_OUTCOMES.SUCCESS : REQUISITION_OUTCOMES.FAIL;
}

/** A check value as a number. Anything unreadable is NaN, so no comparison with it succeeds. */
function checkNumber(value) {
  return value === null || value === undefined || value === '' ? Number.NaN : Number(value);
}

/**
 * The result line of the requisition's chat card: where the granted gold is headed, or who declined. The card prints
 * the kind, the demand, the difficulty and the total beside it.
 * @param {{faction?: object|string, kind?: string, demand?: number, dc?: number, total?: number, outcome?: string,
 *   convoyName?: string}} settled The faction row or its name, the demand, the outcome and the Convoy's name.
 * @returns {string}
 */
export function describeRequisition({ faction, demand, outcome, convoyName } = {}) {
  if (outcome === REQUISITION_OUTCOMES.SUCCESS) {
    const convoy = String(convoyName ?? '').trim() || 'the Convoy';
    return `${Math.max(0, Math.floor(Number(demand) || 0))} GP is on its way to ${convoy}.`;
  }
  const name = String((typeof faction === 'string' ? faction : faction?.name) ?? '').trim();
  return `${name || 'The faction'} declined.`;
}
