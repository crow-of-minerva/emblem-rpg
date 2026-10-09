/** @layer game/support */
import { SUPPORT_NONE_TIER, SUPPORT_RANKS } from '../../contracts/domains/progression.mjs';
import { STATS } from '../../contracts/domains/characters.mjs';
import { capitalize } from '../../lib/dom/html.mjs';
import { isPlainObject } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Built-in affinity table                     */
/* -------------------------------------------- */

/** Display labels for the stats an affinity changes. affinityStatLabel shows any other key capitalized. */
const DEFAULT_STAT_LABELS = Object.freeze({
  atk: 'Atk', acc: 'Acc', crit: 'Crit', critDmg: 'Crit Dmg', spd: 'Spd',
  eva: 'Eva', def: 'Def', res: 'Res', wit: 'Wit', cha: 'Cha', mov: 'Mov'
});

/** Every stat key an affinity may move. @type {ReadonlySet<string>} */
const AFFINITY_STAT_KEYS = Object.freeze(new Set(STATS.map(entry => entry.key)));

/**
 * The tiers an affinity prices, lowest first: None for a Rally that reaches a party member without an earned bond
 * (rallyRankFor in rules.mjs), then the support ranks. A tier's index is its support rank plus one. The Rally
 * description (rally-ability.mjs) lists each stat's values in this order.
 */
export const AFFINITY_TIERS = Object.freeze([SUPPORT_NONE_TIER, ...SUPPORT_RANKS]);

/**
 * The built-in affinity table, used when no affinities file can be read (readAffinityFile in
 * foundry/adapters/services/json-files.mjs). Each stat lists one value per tier in AFFINITY_TIERS order.
 * Negative values are penalties. `adjective` describes the affinity in its Rally's description.
 */
const DEFAULT_AFFINITIES = Object.freeze({
  Savagery: {
    adjective: 'savage',
    atk: [2, 3, 3, 4, 4, 5, 5], spd: [2, 3, 3, 3, 4, 4, 5], acc: [-4, -4, -3, -3, -3, -2, -1]
  },
  Rage: {
    adjective: 'furious',
    atk: [2, 3, 3, 4, 4, 4, 5], crit: [10, 15, 15, 15, 20, 25, 25], eva: [-4, -4, -3, -3, -3, -2, -1]
  },
  Cunning: {
    adjective: 'cunning',
    eva: [2, 3, 3, 3, 4, 4, 5], acc: [2, 3, 3, 4, 4, 5, 5], atk: [-4, -4, -3, -3, -3, -2, -1]
  },
  Impulse: {
    adjective: 'impulsive',
    spd: [2, 3, 3, 4, 4, 5, 5], eva: [2, 3, 3, 3, 4, 4, 5], def: [-4, -4, -3, -3, -3, -2, -1]
  },
  Wisdom: {
    adjective: 'wise',
    wit: [2, 3, 3, 3, 4, 5, 5], cha: [2, 3, 3, 4, 4, 4, 5], spd: [-4, -4, -3, -3, -3, -2, -1]
  },
  Decisiveness: {
    adjective: 'decisive',
    crit: [10, 15, 15, 20, 20, 20, 25], critDmg: [0.25, 0.5, 0.5, 0.5, 0.75, 1, 1],
    spd: [-4, -4, -3, -3, -3, -2, -1]
  },
  Caution: {
    adjective: 'cautious',
    eva: [2, 3, 3, 4, 4, 4, 5], def: [2, 3, 3, 3, 4, 5, 5], atk: [-4, -4, -3, -3, -3, -2, -1]
  },
  Vigilance: {
    adjective: 'vigilant',
    def: [2, 3, 3, 4, 4, 5, 5], res: [2, 3, 3, 3, 4, 4, 5], mov: [-3, -3, -2, -2, -2, -2, -1]
  },
  Audacity: {
    adjective: 'audacious',
    mov: [1, 2, 2, 2, 2, 2, 2], def: [-4, -4, -3, -3, -2, -1, 0], res: [-4, -4, -3, -2, -2, -1, 0]
  }
});

/** Keys that describe a definition rather than naming a stat, so inline and wrapped tables can be told apart. */
const RESERVED_KEYS = new Set(['label', 'adjective', 'stats']);

/* -------------------------------------------- */
/*  Table parsing                               */
/* -------------------------------------------- */

/**
 * Parse an affinities JSON file for readAffinityFile in foundry/adapters/services/json-files.mjs. The file holds
 * the table itself or wraps it in `affinities`, beside optional `statLabels`. Throws when no affinity survives, so
 * the reader moves on to the next file, and finally to builtinAffinityTable, instead of installing an empty table.
 * @param {*} definition Parsed file contents.
 * @returns {{registry: object, statLabels: object, warnings: string[]}}
 */
export function parseAffinityDefinition(definition) {
  const source = isPlainObject(definition?.affinities) ? definition.affinities : definition;
  const { registry, warnings } = normalizeAffinityRegistry(source);
  if (!Object.keys(registry).length) throw new Error('no valid affinities defined');
  const statLabels = isPlainObject(definition?.statLabels)
    ? { ...DEFAULT_STAT_LABELS, ...definition.statLabels }
    : { ...DEFAULT_STAT_LABELS };
  return { registry, statLabels, warnings };
}

/** The built-in table, normalized, as the reader's fallback. */
export function builtinAffinityTable() {
  const { registry, warnings } = normalizeAffinityRegistry(DEFAULT_AFFINITIES);
  return { registry, statLabels: { ...DEFAULT_STAT_LABELS }, warnings };
}

/**
 * Normalize a whole table. An affinity left with no usable stats is dropped with a warning instead of failing the
 * file.
 * @param {*} source Authored table.
 * @returns {{registry: object, warnings: string[]}}
 */
function normalizeAffinityRegistry(source) {
  const registry = {};
  const warnings = [];
  for (const [name, definition] of Object.entries(source ?? {})) {
    const entry = normalizeAffinity(name, definition, warnings);
    if (entry) registry[name] = entry;
    else warnings.push(`Affinity "${name}" defines no usable stats and was skipped.`);
  }
  return { registry, warnings };
}

/* -------------------------------------------- */
/*  Table accessors                             */
/* -------------------------------------------- */

/** Every registered affinity name, in authored order. */
export function affinityNames(table) {
  return Object.keys(table?.registry ?? {});
}

/** Display label for an affinity, falling back to its own name. */
export function affinityLabel(table, name) {
  return table?.registry?.[name]?.label ?? String(name ?? '');
}

/** The word that describes an affinity in its Rally's description, or an empty string when the table gives none. */
export function affinityAdjective(table, name) {
  return table?.registry?.[name]?.adjective ?? '';
}

/** The stat table for an affinity: stat key to one value per tier (AFFINITY_TIERS), or null when unregistered. */
export function affinityStats(table, name) {
  return table?.registry?.[name]?.stats ?? null;
}

/** Display label for a stat, falling back to its capitalized key so an unknown stat still reads sensibly. */
export function affinityStatLabel(table, key) {
  const stat = String(key ?? '');
  return table?.statLabels?.[stat] || capitalize(stat);
}

/* -------------------------------------------- */
/*  Normalization helpers                       */
/* -------------------------------------------- */
function normalizeAffinity(name, definition, warnings) {
  if (!isPlainObject(definition)) return null;
  const source = isPlainObject(definition.stats)
    ? definition.stats
    : Object.fromEntries(Object.entries(definition).filter(([key]) => !RESERVED_KEYS.has(key)));

  const stats = {};
  for (const [key, value] of Object.entries(source)) {
    if (!AFFINITY_STAT_KEYS.has(key)) {
      warnings.push(`Affinity "${name}" stat "${key}" is not a stat and was ignored.`);
      continue;
    }
    const byRank = normalizeRankValues(value);
    if (!byRank) {
      warnings.push(`Affinity "${name}" stat "${key}" is not a number, array, or rank map and was ignored.`);
      continue;
    }
    stats[key] = byRank;
  }
  if (!Object.keys(stats).length) return null;

  const label = typeof definition.label === 'string' && definition.label.trim() ? definition.label.trim() : name;
  const adjective = typeof definition.adjective === 'string' ? definition.adjective.trim() : '';
  return { name, label, adjective, stats };
}

/**
 * Normalize a stat's per-tier values for parseAffinityDefinition: a scalar repeats, an array follows AFFINITY_TIERS
 * order, None first, and an object maps tier names. A tier the file leaves out is worth 0.
 */
function normalizeRankValues(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return AFFINITY_TIERS.map(() => value);
  if (Array.isArray(value)) return AFFINITY_TIERS.map((_unused, index) => Number(value[index]) || 0);
  if (isPlainObject(value)) return AFFINITY_TIERS.map(tier => Number(value[tier]) || 0);
  return null;
}
