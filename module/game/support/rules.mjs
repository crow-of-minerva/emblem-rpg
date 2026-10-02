/** @layer game/support */
import {
  RALLY_DURATION_PHASES,
  RALLY_STATUS_ID,
  RALLY_TARGET_LIMITS,
  SUPPORT_ELIGIBLE_ACTOR_TYPES,
  SUPPORT_MAX_RANK,
  SUPPORT_NONE_TIER,
  SUPPORT_RANKS,
  SUPPORT_UNRANKED,
  SUPPORT_UNRANKED_LETTER,
  SUPPORT_XP_THRESHOLDS
} from '../../contracts/domains/progression.mjs';
import { affinityStatLabel, affinityStats } from './affinities.mjs';

/** XP needed to leave each rank, indexed by rank because the curve below walks ranks numerically. */
const THRESHOLD_BY_RANK = SUPPORT_RANKS.map(letter => SUPPORT_XP_THRESHOLDS[letter] || 0);

/** Reaching E costs E's own threshold, so an unearned bond and an E bond need the same next step. */
const UNRANKED_THRESHOLD = SUPPORT_XP_THRESHOLDS.E;

/** The last id segment of an Actor uuid, which is the base Actor a partner entry names. */
const ACTOR_ID_PATTERN = /Actor\.([^.]+)$/;

/* -------------------------------------------- */
/*  Rank curve                                  */
/* -------------------------------------------- */

/** Clamp a stored rank to the valid range; anything that isn't a number counts as unranked. */
export function clampSupportRank(rank) {
  const value = Number(rank);
  const whole = Number.isFinite(value) ? Math.trunc(value) : SUPPORT_UNRANKED;
  return Math.max(SUPPORT_UNRANKED, Math.min(SUPPORT_MAX_RANK, whole));
}

/** The letter shown for a rank. An unearned bond shows SUPPORT_UNRANKED_LETTER instead. */
export function supportRankLetter(rank) {
  const value = clampSupportRank(rank);
  return value < 0 ? SUPPORT_UNRANKED_LETTER : SUPPORT_RANKS[value];
}

/** XP needed to leave a rank for the next one. */
export function supportXpNeeded(rank) {
  const value = clampSupportRank(rank);
  return value < 0 ? UNRANKED_THRESHOLD : THRESHOLD_BY_RANK[value];
}

/**
 * Add XP to one bond without changing the input, for planSupportXpGrant. Several ranks can be gained at once. At
 * S rank the bar fills and any extra XP is dropped.
 * @param {object} entry Support entry.
 * @param {number} xpGain XP to grant.
 * @returns {{entry: object, ranksGained: number, fromLetter: string, rankLetter: string}}
 */
function applySupportXp(entry, xpGain) {
  const fromRank = clampSupportRank(entry.rank);
  let rank = fromRank;
  let xp = wholeXp(entry.xp) + wholeXp(xpGain);
  while (rank < SUPPORT_MAX_RANK && xp >= supportXpNeeded(rank)) {
    xp -= supportXpNeeded(rank);
    rank += 1;
  }
  if (rank >= SUPPORT_MAX_RANK) xp = Math.min(xp, supportXpNeeded(SUPPORT_MAX_RANK));
  return {
    entry: { ...entry, rank, xp },
    ranksGained: rank - fromRank,
    fromLetter: supportRankLetter(fromRank),
    rankLetter: supportRankLetter(rank)
  };
}

/* -------------------------------------------- */
/*  Bond eligibility                            */
/* -------------------------------------------- */

/** Whether a unit may hold a Support bond at all. Allies and Enemies deliberately cannot. */
export function isSupportEligible(facts) {
  if (!facts || facts.type !== 'Character') return false;
  return SUPPORT_ELIGIBLE_ACTOR_TYPES.includes(String(facts.actorType ?? ''));
}

/** The base Actor id a partner entry names, so an unlinked token can still be matched against a world bond. */
function supportActorIdFromUuid(uuid) {
  return ACTOR_ID_PATTERN.exec(String(uuid ?? ''))?.[1] ?? '';
}

/* -------------------------------------------- */
/*  XP grants                                   */
/* -------------------------------------------- */

/**
 * Plan the source unit's whole support list after an XP grant, as one update, for settleSupportXpGrant in
 * engine/support/commands.mjs. Writing it partner by partner would let the writes overwrite each other. The
 * partners' own entries follow afterward through planSupportMirror.
 * @param {{source: object, others: object[], gain: number, autoCreate?: boolean}} input Detached grant data.
 * @returns {{gain: number, partners: object[]|null, recipients: string[], rankUps: object[]}}
 */
export function planSupportXpGrant({ source, others = [], gain, autoCreate = true }) {
  const amount = wholeXp(gain);
  const empty = { gain: amount, partners: null, recipients: [], rankUps: [] };
  if (!isSupportEligible(source) || amount <= 0) return empty;

  const eligible = others.filter(other => other && other.uuid !== source.uuid && isSupportEligible(other));
  if (!eligible.length) return empty;

  const partners = (source.partners ?? []).map(entry => ({ ...entry }));
  const recipients = [];
  const rankUps = [];
  for (const other of eligible) {
    let index = partners.findIndex(entry => entry.actorUUID === other.uuid);
    if (index < 0) {
      if (!autoCreate) continue;
      partners.push({ actorUUID: other.uuid, name: other.name ?? '', rank: SUPPORT_UNRANKED, xp: 0 });
      index = partners.length - 1;
    }
    const result = applySupportXp(partners[index], amount);
    partners[index] = result.entry;
    recipients.push(other.name ?? '');
    if (result.ranksGained > 0) {
      rankUps.push({ a: source.name ?? '', b: other.name ?? '', from: result.fromLetter, to: result.rankLetter });
    }
  }
  if (!recipients.length) return empty;
  return { gain: amount, partners, recipients, rankUps };
}

/* -------------------------------------------- */
/*  Bond mirror                                 */
/* -------------------------------------------- */

/**
 * Plan the partners' side of a unit's bonds, for settleSupportMirror in engine/support/commands.mjs. The unit's own
 * list is the authority: each partner's entry for it is added, corrected or removed to match. Only the partner
 * lists that change are returned.
 * @param {{source: object, roster: object[]}} input The unit whose bonds changed and every Character that could
 *   hold its bond.
 * @returns {{actorUuid: string, partners: object[]}[]}
 */
export function planSupportMirror({ source, roster = [] }) {
  const plans = [];
  if (!source?.uuid) return plans;
  const held = new Map((source.partners ?? [])
    .filter(entry => entry?.actorUUID && entry.actorUUID !== source.uuid)
    .map(entry => [entry.actorUUID, entry]));

  for (const partner of roster) {
    if (!partner?.uuid || partner.uuid === source.uuid) continue;
    const entry = held.get(partner.uuid);
    const partners = (partner.partners ?? []).map(existing => ({ ...existing }));
    const index = partners.findIndex(existing => existing.actorUUID === source.uuid);

    if (!entry) {
      if (index < 0) continue;
      partners.splice(index, 1);
      plans.push({ actorUuid: partner.uuid, partners });
      continue;
    }

    const rank = clampSupportRank(entry.rank);
    const xp = wholeXp(entry.xp);
    if (index < 0) {
      partners.push({ actorUUID: source.uuid, name: source.name ?? '', rank, xp });
      plans.push({ actorUuid: partner.uuid, partners });
      continue;
    }
    const current = partners[index];
    if (clampSupportRank(current.rank) === rank && wholeXp(current.xp) === xp) continue;
    partners[index] = { ...current, rank, xp };
    plans.push({ actorUuid: partner.uuid, partners });
  }
  return plans;
}

/* -------------------------------------------- */
/*  Rally bonds                                 */
/* -------------------------------------------- */

/**
 * The caster's bond rank with a Rally target, or null for a missing or unearned bond, for rallyRankFor. A bond
 * matches by UUID, then by base Actor id so an unlinked token still finds it.
 * @param {object[]} partners The caster's bonds.
 * @param {{uuid?: string, actorId?: string}} target Identity of the unit being rallied.
 * @returns {number|null}
 */
function rallyRankBetween(partners, target) {
  if (!target) return null;
  const targetId = String(target.actorId ?? '');
  for (const entry of partners ?? []) {
    if (!entry?.actorUUID) continue;
    const matched = entry.actorUUID === target.uuid
      || (!!targetId && supportActorIdFromUuid(entry.actorUUID) === targetId);
    if (!matched) continue;
    const rank = clampSupportRank(entry.rank);
    return rank >= 0 ? rank : null;
  }
  return null;
}

/**
 * The caster data the Rally rules below read, from an activation source (projectActivationSource in
 * foundry/adapters/projections/items.mjs): its support data, name and Actor uuid.
 * @param {object} source The caster's activation data.
 * @returns {{uuid: string, name: string, affinity?: string, partners?: object[], partyId?: string,
 *   rallies?: object[]}}
 */
export function rallyCasterFacts(source) {
  return { ...source?.support, name: source?.actorName, uuid: String(source?.actorUuid ?? '') };
}

/**
 * The rank a Rally from the caster reaches this target at, or null when it can't. An earned bond gives its rank. A
 * unit in the caster's party without one is rallied at SUPPORT_UNRANKED, which prices the affinity's None tier. A
 * caster never reaches itself.
 * @param {{uuid?: string, partners?: object[], partyId?: string|null}} caster Unit calling the Rally.
 * @param {{uuid?: string, actorId?: string, partyId?: string|null}} target Unit being rallied.
 * @returns {number|null}
 */
export function rallyRankFor(caster, target) {
  if (caster?.uuid && caster.uuid === target?.uuid) return null;
  const bonded = rallyRankBetween(caster?.partners, target);
  if (bonded !== null) return bonded;
  const party = String(caster?.partyId ?? '');
  return party && party === String(target?.partyId ?? '') ? SUPPORT_UNRANKED : null;
}

/**
 * Why a Rally can't reach this unit, or null: it is outside the caster's party with no earned bond, the caster has
 * already Rallied it as often this map as the tier allows (rallyTargetLimit), or it was already Rallied this round.
 * The targeting controls (ui/controls/targeting.mjs) show the reason and draw no rank badge over a blocked unit,
 * and canRallyTarget answers activation checks.
 * @param {{uuid?: string, name?: string, partners?: object[], partyId?: string|null, rallies?: object[]}} caster
 *   Unit calling the Rally (rallyCasterFacts), with its record of this map's Rallies (normalizeRallyRecord).
 * @param {{name?: string, uuid?: string, actorId?: string, partyId?: string|null, rallied?: boolean}} target Unit
 *   being rallied.
 * @returns {string|null}
 */
export function rallyTargetBlocker(caster, target) {
  const targetName = target?.name ?? 'That unit';
  const casterName = caster?.name ?? 'the caster';
  if (caster?.uuid && caster.uuid === target?.uuid) return `${casterName} cannot Rally themself.`;
  const rank = rallyRankFor(caster, target);
  if (rank === null) return `${targetName} is not in ${casterName}'s party and has no Support rank with them.`;
  if (ralliesOn(caster?.rallies, target?.uuid) >= rallyTargetLimit(rank)) {
    return `${targetName} may not be rallied by ${casterName} anymore this encounter.`;
  }
  if (target?.rallied === true) return `${targetName} has already been Rallied this round.`;
  return null;
}

/** Whether this unit can be rallied. */
export function canRallyTarget(caster, target) {
  return rallyTargetBlocker(caster, target) === null;
}

/* -------------------------------------------- */
/*  Rally record                                */
/* -------------------------------------------- */

/** How many times a caster may Rally one unit in a map at this rank (RALLY_TARGET_LIMITS). */
export function rallyTargetLimit(rank) {
  const value = clampSupportRank(rank);
  return RALLY_TARGET_LIMITS[value < 0 ? SUPPORT_NONE_TIER : SUPPORT_RANKS[value]] ?? 1;
}

/**
 * A caster's stored record of this map's Rallies (RALLY_RECORD_FLAG) as `[{actorUuid, count}]`, keeping only
 * well-formed rows, since the record is read straight from an Actor's flags.
 */
export function normalizeRallyRecord(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => typeof entry?.actorUuid === 'string' && entry.actorUuid
      && Number.isInteger(entry.count) && entry.count > 0)
    .map(entry => ({ actorUuid: entry.actorUuid, count: entry.count }));
}

/** How many times the record says the caster has Rallied this unit this map. */
export function ralliesOn(rallies, actorUuid) {
  return (rallies ?? []).find(entry => entry.actorUuid === actorUuid)?.count ?? 0;
}

/**
 * The record after one more Rally on this unit, for FoundryItemActivationSettlement.recordRally
 * (foundry/adapters/document-writes/effect-execution.mjs). The input is left unchanged.
 */
export function planRallyCount(rallies, actorUuid) {
  const record = normalizeRallyRecord(rallies);
  const entry = record.find(row => row.actorUuid === actorUuid);
  if (entry) entry.count += 1;
  else record.push({ actorUuid, count: 1 });
  return record;
}

/**
 * The stat changes a Rally at this rank grants from the caster's affinity, leaving out stats that don't change.
 * SUPPORT_UNRANKED reads the None tier.
 * @returns {Record<string, number>|null} Null when the affinity is not registered.
 */
export function rallyStatBonuses(table, affinity, rank) {
  const stats = affinityStats(table, affinity);
  if (!stats) return null;
  const index = clampSupportRank(rank) + 1;
  const bonuses = {};
  for (const [key, byRank] of Object.entries(stats)) {
    const value = byRank[index] ?? 0;
    if (value !== 0) bonuses[key] = value;
  }
  return bonuses;
}

/** Bonuses as display rows, each carrying whether it is a penalty so the renderer can colour it. */
export function rallyStatRows(table, stats) {
  return Object.entries(stats ?? {}).map(([key, value]) => ({
    key,
    label: affinityStatLabel(table, key),
    value: formatRallyStatValue(key, value),
    penalty: value < 0
  }));
}

/** Bonuses as a single line of text, for a tooltip or an effect description. */
export function rallyStatLine(table, stats) {
  return rallyStatRows(table, stats).map(row => `${row.label} ${row.value}`).join(', ');
}

/** Which stats an affinity moves and in which direction, for the sheet's chips and its one-line summary. */
export function affinityDirections(table, affinity) {
  const stats = affinityStats(table, affinity);
  if (!stats) return [];
  return Object.entries(stats).map(([key, byRank]) => ({
    key,
    label: affinityStatLabel(table, key),
    penalty: Number(byRank.find(value => value !== 0)) < 0
  }));
}

/** A one-line summary of which stats an affinity moves, for a bond that has no rank to price yet. */
export function affinitySummary(table, affinity) {
  return affinityDirections(table, affinity)
    .map(entry => `${entry.penalty ? '−' : '+'}${entry.label}`)
    .join(' | ');
}

/**
 * The Rally effect settleRally (engine/items/activation.mjs) hands to applyRally. The writer keeps the affinity's
 * bonuses and penalties in the effect's flags, so one ActiveEffect carries the whole Rally. A Rally at
 * SUPPORT_UNRANKED names its rank as the None tier.
 * @returns {object|null} Null when the caster has no affinity the table knows.
 */
export function planRallyEffect({ table, caster, target, rank }) {
  const affinity = String(caster?.affinity ?? '');
  const stats = rallyStatBonuses(table, affinity, rank);
  if (!stats) return null;
  const clamped = clampSupportRank(rank);
  return Object.freeze({
    name: `Rally ${affinity}`,
    statusId: RALLY_STATUS_ID,
    affinity,
    rank: clamped,
    rankLetter: clamped < 0 ? SUPPORT_NONE_TIER : supportRankLetter(clamped),
    casterUuid: String(caster?.uuid ?? ''),
    casterName: String(caster?.name ?? ''),
    targetActorUuid: String(target?.actorUuid ?? ''),
    stats: Object.freeze({ ...stats }),
    statLine: rallyStatLine(table, stats),
    durationPhases: RALLY_DURATION_PHASES
  });
}

/* -------------------------------------------- */
/*  Value helpers                               */
/* -------------------------------------------- */

/**
 * A bonus rendered signed, for the rows here and the Rally description (rally-ability.mjs). Crit damage is stored
 * as a fraction and shown as a percentage.
 */
export function formatRallyStatValue(key, value) {
  const shown = key === 'critDmg' ? Math.round(Number(value) * 100) : Number(value);
  return `${shown > 0 ? '+' : ''}${shown}`;
}

function wholeXp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}
