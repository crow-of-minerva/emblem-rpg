/** @layer game/progression */
import { clamp, finite, isPlainObject } from '../../lib/core/runtime.mjs';
import { computeAttackExperience } from './rules.mjs';

/* -------------------------------------------- */
/*  Table vocabulary                            */
/* -------------------------------------------- */
const EXPERIENCE_MODES = Object.freeze(['flat', 'pass-fail', 'damage-based']);
const TARGET_MODES = Object.freeze(['single', 'multiple']);
const ENTRY_FIELDS = Object.freeze(new Set([
  'exp-mode', 'value', 'target-mode', 'leveled', 'min', 'max', 'limit', 'kill-bonus'
]));
const TABLE_FIELDS = Object.freeze(new Set(['items']));

/**
 * A leveled entry multiplies a target's score by 1 plus a fifth of the level gap, held between 0 and 2. A target
 * five levels below the caster scores nothing, and one five levels above scores double.
 */
const LEVEL_FACTOR_SPAN = 5;
const LEVEL_FACTOR_MAX = 2;

/**
 * The share of an ally's HP a `damage-based` entry counts as a full heal.
 */
const FULL_HEAL_HP_SHARE = 0.9;

/* -------------------------------------------- */
/*  Table parsing                               */
/* -------------------------------------------- */

/**
 * The key an activated Item's name is looked up under in the activation XP table, and the key the per-encounter
 * limit counter on the caster is stored under.
 * @param {unknown} name An Item name, as authored.
 * @returns {string}
 */
export function activationExperienceKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Parse the `exp-data.json` file that foundry/adapters/services/json-files.mjs reads. A key may bundle several Item
 * names separated by commas, and each name gets its own copy of the entry. An entry with an unusable field is
 * skipped and an unknown field is ignored, each with a warning, so one typo never disables the rest of the table.
 * A valid declaration of a name declared before replaces the earlier one, with one console-only notice per name;
 * an invalid one is skipped and leaves the earlier one. A payload that is not a table at all throws, and the reader
 * falls back to the next file.
 * @param {*} payload Parsed file contents: `{items: {[itemNames]: entry}}`.
 * @param {Array<[string, *]>} [itemPairs] The `items` members in source order, repeated keys included, as the
 *   reader scans them from the file's text. A parsed object keeps only the last of two identical keys, and puts
 *   integer-like keys first, so its own order is the fallback.
 * @returns {{entries: ReadonlyMap<string, object>, warnings: string[], notices: string[]}} Entries keyed by
 *   activationExperienceKey; `warnings` for skipped entries and ignored fields, `notices` for repeated names.
 */
export function parseActivationExperienceTable(payload, itemPairs = null) {
  if (!isPlainObject(payload)) throw new Error('the activation XP table is not a JSON object');
  if (!isPlainObject(payload.items)) throw new Error('the activation XP table has no "items" object');
  const warnings = [];
  for (const field of Object.keys(payload)) {
    if (!TABLE_FIELDS.has(field)) {
      warnings.push(`Activation XP table field "${field}" is not recognised and was ignored.`);
    }
  }
  const entries = new Map();
  const repeated = new Map();
  for (const [authoredKey, source] of itemPairs ?? Object.entries(payload.items)) {
    const names = authoredKey.split(',').map(part => part.trim()).filter(Boolean);
    const entry = parseEntry(authoredKey, names, source, warnings);
    if (!entry) continue;
    for (const name of names) {
      const key = activationExperienceKey(name);
      if (entries.has(key)) repeated.set(key, name);
      entries.set(key, { ...entry, name });
    }
  }
  const notices = [...repeated.values()]
    .map(name => `Activation XP entry "${name}" is declared more than once; the later declaration is used.`);
  return { entries, warnings, notices };
}

/**
 * One declaration's entry fields in the shape resolveActivationExperience reads, without its name, or null with a
 * warning when it names no Item or a field is unusable. Unknown fields are reported and ignored. An absent or null
 * optional field takes its default.
 */
function parseEntry(authoredKey, names, source, warnings) {
  const skip = reason => {
    warnings.push(`Activation XP entry "${authoredKey}" ${reason} and was skipped.`);
    return null;
  };
  if (!names.length) return skip('has no Item name');
  if (!isPlainObject(source)) return skip('is not an object');
  for (const field of Object.keys(source)) {
    if (!ENTRY_FIELDS.has(field)) {
      warnings.push(`Activation XP entry "${authoredKey.trim()}" field "${field}" is not recognised and was ignored.`);
    }
  }

  const mode = source['exp-mode'];
  if (!EXPERIENCE_MODES.includes(mode)) return skip(`has no exp-mode among ${EXPERIENCE_MODES.join(', ')}`);
  const value = source.value;
  if (!isNonNegativeNumber(value)) return skip('has no non-negative number value');
  const targetMode = source['target-mode'] ?? 'single';
  if (!TARGET_MODES.includes(targetMode)) return skip(`has a target-mode other than ${TARGET_MODES.join(' or ')}`);
  const leveled = source.leveled ?? false;
  if (typeof leveled !== 'boolean') return skip('has a leveled flag that is not true or false');
  const min = source.min ?? 0;
  if (!isNonNegativeNumber(min)) return skip('has a min that is not a non-negative number');
  const max = source.max ?? null;
  if (max !== null && !isNonNegativeNumber(max)) return skip('has a max that is not a non-negative number');
  if (max !== null && min > max) return skip('has a min above its max');
  const limit = source.limit ?? null;
  if (limit !== null && !(Number.isInteger(limit) && limit >= 1)) return skip('has a limit below 1 or not whole');
  const killBonus = source['kill-bonus'] ?? false;
  if (typeof killBonus !== 'boolean') return skip('has a kill-bonus flag that is not true or false');

  return { mode, targetMode, value, leveled, min, max, limit, killBonus };
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/* -------------------------------------------- */
/*  Experience resolution                       */
/* -------------------------------------------- */

/**
 * Raw level XP one Item activation earns its caster, before the unit's and the world's multipliers. The item
 * activation snapshot (foundry/adapters/projections/items.mjs) carries the entry found by the Item's name. The
 * activation engine (engine/items/activation.mjs) reports what the action did to each target and hands a positive
 * result to the combat progression service. An Item with no entry, an activation outside a running encounter and
 * an entry already used `limit` times this encounter earn nothing.
 * @param {object} input
 * @param {object|null} input.entry The parsed table entry, or null when the Item has none.
 * @param {number} input.casterLevel The caster's level.
 * @param {object[]} input.targets One outcome-facts record per target the activation reached.
 * @param {boolean} input.encounterRunning Whether an encounter is running on the caster's scene.
 * @param {number} input.usesThisEncounter XP-granting uses of this entry the caster has made this encounter.
 * @returns {{experience: number, countsTowardLimit: boolean}} `countsTowardLimit` says to advance the use counter.
 */
export function resolveActivationExperience({ entry, casterLevel, targets = [], encounterRunning, usesThisEncounter }) {
  if (!entry || encounterRunning !== true) return noExperience();
  if (entry.limit !== null && finite(usesThisEncounter) >= entry.limit) return noExperience();

  const level = finite(casterLevel);
  let raw;
  let killTargets;
  if (entry.mode === 'flat') {
    raw = entry.value;
    killTargets = targets.filter(target => target.hostile && target.slain);
  } else {
    const graded = targets.filter(countsForExperience)
      .map(target => ({ target, score: targetScore(entry, target, level) }));
    const chosen = entry.targetMode === 'single' ? highestScore(graded) : graded;
    raw = chosen.reduce((sum, { score }) => sum + score, 0);
    killTargets = chosen.map(({ target }) => target).filter(target => target.hostile && target.slain);
  }

  let experience = clamp(Math.round(raw), entry.min, entry.max ?? Infinity);
  if (entry.killBonus) {
    for (const target of killTargets) {
      experience += computeAttackExperience(level, target.level, true, { opponentIsBoss: target.isBoss === true });
    }
  }
  return { experience, countsTowardLimit: experience > 0 };
}

function noExperience() {
  return { experience: 0, countsTowardLimit: false };
}

/** A target counts when the action harmed or displaced an opponent, or helped or displaced a friend. */
function countsForExperience(target) {
  if (target.hostile && (changed(target.harmful) || target.moved)) return true;
  return Boolean(target.friendly && (changed(target.helpful) || target.moved));
}

function changed(effect) {
  return finite(effect?.hp) > 0 || finite(effect?.stn) > 0 || effect?.status === true;
}

/**
 * One counting target's score: the entry's value, or its share of the target's HP and Stance, then the level gap.
 */
function targetScore(entry, target, casterLevel) {
  let score = entry.value;
  if (entry.mode === 'damage-based') {
    const effect = target.hostile ? target.harmful : target.helpful;
    const hpPool = target.hostile ? target.hpMax : finite(target.hpMax) * FULL_HEAL_HP_SHARE;
    score = entry.value * (share(effect?.hp, hpPool) + share(effect?.stn, target.stnMax));
  }
  if (entry.leveled) {
    score *= clamp(1 + ((finite(target.level) - casterLevel) / LEVEL_FACTOR_SPAN), 0, LEVEL_FACTOR_MAX);
  }
  return score;
}

/** How much of a pool the action moved, from 0 to 1. A pool with no maximum counts as untouched. */
function share(amount, maximum) {
  const pool = finite(maximum);
  return pool > 0 ? Math.min(1, Math.max(0, finite(amount)) / pool) : 0;
}

/** The single graded target of a `single` entry: the highest score, the earliest target on a tie. */
function highestScore(graded) {
  let best = null;
  for (const candidate of graded) if (!best || candidate.score > best.score) best = candidate;
  return best ? [best] : [];
}
