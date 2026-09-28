/** @layer game/downtime */
import { DOWNTIME_LANES, DOWNTIME_STATION_TYPES, GATHER_METHODS } from '../../contracts/domains/downtime.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { resolveParticipants } from './rules.mjs';

/* -------------------------------------------- */
/*  Node reading                                */
/* -------------------------------------------- */
const MULTIPLIER_BOUNDS = Object.freeze({ min: 0.1, max: 2 });
const DEFAULT_SKILL_KEY = 'athletics';

/** What one gather costs on the Energy lane, the same at every node. */
export const GATHERING_ENERGY_COST = 1;

/** The node's yield multiplier, clamped on read so an extreme authored value cannot empty the map in one gather. */
export function gatheringMultiplier(gathering = {}) {
  const raw = Number(gathering?.multiplier);
  return Math.min(MULTIPLIER_BOUNDS.max, Math.max(MULTIPLIER_BOUNDS.min, Number.isFinite(raw) && raw > 0 ? raw : 1));
}

/** The skill key a node rolls, lower-cased from the authored label. */
export function gatheringSkillKey(skill) {
  const key = String(skill ?? '').trim().toLowerCase();
  return key || DEFAULT_SKILL_KEY;
}

/** The gathering method, falling back to harvesting for an unknown or blank one. */
export function gatheringMethod(animType) {
  return GATHER_METHODS.includes(animType) ? animType : GATHER_METHODS[0];
}

/** How many units a gather yields: the skill roll times the node's multiplier, floored. */
export function gatherAmount(roll, multiplier) {
  return Math.max(0, Math.floor(Math.max(0, Number(roll) || 0) * Math.max(0, Number(multiplier) || 0)));
}

/**
 * Whether a node entry takes part in gathering at all: its source Resource still resolves (the snapshot marks a
 * vanished one `missing`) and it has stock left. Every other entry is ignored: not offered, drawn or counted.
 */
export function gatherableEntry(entry) {
  return entry?.missing !== true && Math.floor(Number(entry?.total) || 0) > 0;
}

/** Index of the gatherable with the most stock left, whose icon the gathering banner shows. */
function mostAbundantIndex(items = []) {
  let best = -1;
  let bestTotal = -1;
  items.forEach((item, index) => {
    if (!gatherableEntry(item)) return;
    const total = Number(item.total) || 0;
    if (total > bestTotal) { bestTotal = total; best = index; }
  });
  return best;
}

/** The pool a gather draws from: every gatherable entry, keyed by its index on the node. */
export function nodeStock(items = []) {
  return Object.freeze(items
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => gatherableEntry(entry))
    .map(({ entry, index }) => Object.freeze({
      index, total: Math.floor(Number(entry.total)), weight: Number(entry.weight) || 0
    })));
}

/* -------------------------------------------- */
/*  Distribution                                */
/* -------------------------------------------- */
/**
 * Split a gather's yield among the node's entries, for workNode in engine/downtime/resolvers.mjs. Each unit is drawn
 * by weight from the given random source without replacement, so no entry gives more than its stock, and the
 * total is capped at the stock left.
 */
export function distributeGather(items = [], total, rng) {
  const pool = [];
  for (const item of items) {
    const available = Math.max(0, Math.floor(Number(item.available ?? item.total) || 0));
    const weight = Math.max(0, Number(item.weight) || 0);
    if (available > 0 && weight > 0) pool.push({ key: item.key ?? item.index, available, weight });
  }
  const result = {};
  let remaining = Math.min(Math.max(0, Math.floor(Number(total) || 0)),
    pool.reduce((sum, item) => sum + item.available, 0));
  while (remaining > 0) {
    const live = pool.filter(item => item.available > 0);
    const weightSum = live.reduce((sum, item) => sum + item.weight, 0);
    if (weightSum <= 0) break;
    let cursor = Math.max(0, Math.min(0.999999, Number(rng?.()) || 0)) * weightSum;
    let chosen = null;
    for (const item of live) {
      if (cursor < item.weight) { chosen = item; break; }
      cursor -= item.weight;
    }
    chosen ??= live[live.length - 1];
    chosen.available -= 1;
    result[chosen.key] = (result[chosen.key] || 0) + 1;
    remaining -= 1;
  }
  return result;
}

/* -------------------------------------------- */
/*  Planning                                    */
/* -------------------------------------------- */
/**
 * Validate gathering for engine/downtime/commands.mjs. Check station, free exploration, reach, stock, performer
 * membership and available Energy. A node with no gatherable entry left is exhausted.
 */
export function planGathering(facts = {}) {
  const gathering = facts.station?.gathering ?? null;
  if (facts.station?.objectType !== DOWNTIME_STATION_TYPES.GATHERING || !gathering) {
    return refuse(RESULT_CODES.DOWNTIME_STATION_INVALID);
  }
  if (facts.exploring !== true) return refuse(RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED);
  if (facts.inReach !== true) return refuse(RESULT_CODES.DOWNTIME_OUT_OF_REACH, { actorName: facts.cursorName });
  const stock = nodeStock(gathering.items);
  if (!stock.length) return refuse(RESULT_CODES.DOWNTIME_NODE_EXHAUSTED, { stationName: facts.station.name });
  const cost = GATHERING_ENERGY_COST;
  const participants = resolveParticipants(facts.roster, { lane: DOWNTIME_LANES.ENERGY, energyCost: cost });
  const performer = participants.find(entry => entry.actorUuid === facts.performerUuid) ?? null;
  if (!performer) return refuse(RESULT_CODES.DOWNTIME_PERFORMER_OUTSIDE_ROSTER);
  if (!performer.eligible) {
    return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { performerName: performer.name, blocked: performer.blocked });
  }
  const icon = mostAbundantIndex(gathering.items);
  return accept(RESULT_CODES.DOWNTIME_GATHERED, Object.freeze({
    skillKey: gatheringSkillKey(gathering.skill),
    cost,
    multiplier: gatheringMultiplier(gathering),
    method: gatheringMethod(gathering.animType),
    stock,
    iconImage: String(gathering.items?.[icon]?.img || facts.station.image || ''),
    staged: performer.actorUuid !== facts.cursorActorUuid
  }));
}

/**
 * Plan the inventory and node writes after a gather, for workNode in engine/downtime/resolvers.mjs. A drawn entry
 * joins a matching Resource stack or takes a free pocket slot. With no room it stays on the node, marked left
 * behind. A hidden entry is revealed only once it is collected. An entry whose source is gone by the time the yield
 * lands is ignored: no row, and no stock taken. The node is exhausted once no gatherable entry is left, and the
 * `missing` marks are the snapshot's, never written back.
 */
export function planGatherDeposit({ distribution = {}, items = [], sources = {}, destination = {} } = {}) {
  const remaining = items.map(({ missing: _missing, ...entry }) => ({
    ...entry, total: Math.max(0, Math.floor(Number(entry?.total) || 0))
  }));
  const character = destination.isCharacter === true;
  const stacks = new Set((destination.stacks ?? []).map(stack => `${stack.name}@${Number(stack.perUnit) || 0}`));
  let pockets = Number(destination.pocketCount) || 0;
  const limit = Number.isFinite(destination.pocketLimit) ? destination.pocketLimit : Infinity;
  const deposits = [];
  for (const [key, drawn] of Object.entries(distribution)) {
    const index = Number(key);
    const entry = remaining[index];
    const count = Math.max(0, Math.floor(Number(drawn) || 0));
    if (!entry || count <= 0) continue;
    const source = sources[index] ?? null;
    if (!source) continue;
    const row = { index, name: String(entry.name ?? ''), image: String(entry.img ?? ''), count, leftBehind: false };
    if (character) {
      const stackKey = `${source.name}@${Number(source.perUnit) || 0}`;
      if (!stacks.has(stackKey) && pockets >= limit) {
        row.leftBehind = true;
        row.name = entry.hidden ? '???' : row.name;
        deposits.push(Object.freeze(row));
        continue;
      }
      if (!stacks.has(stackKey)) { stacks.add(stackKey); pockets += 1; }
    }
    entry.total = Math.max(0, entry.total - count);
    entry.hidden = false;
    deposits.push(Object.freeze(row));
  }
  return Object.freeze({
    deposits: Object.freeze(deposits),
    items: Object.freeze(remaining.map(entry => Object.freeze(entry))),
    exhausted: !remaining.some((entry, index) => gatherableEntry({ ...entry, missing: items[index]?.missing }))
  });
}
