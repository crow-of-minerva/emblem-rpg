/** @layer game/downtime */
import { STATS } from '../../contracts/domains/characters.mjs';
import {
  DOWNTIME_ENTITY_FLAG, DOWNTIME_LANES, DOWNTIME_STATION_TYPES, LISTENER_SUPPORT_XP, PERFORMANCE_ENTITY_FLAG,
  PERFORMANCE_GRADES, PERFORMANCE_GRADE_ORDER, PERFORMANCE_PASSIVE_NAMES, PERFORMER_SUPPORT_XP, SONG_LIMITS,
  SONG_STAT_KEYS
} from '../../contracts/domains/downtime.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { RESULT_CODES, refuse } from '../../contracts/results.mjs';
import { modifier, signed } from './cooking.mjs';
import { builtinId, defineLibrary } from './library.mjs';
import { defeatedBlock, resolveParticipants } from './rules.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** The skill every performer rolls. */
const PERFORM_SKILL_KEY = 'performance';

/** Art for a song that has none of its own. */
const SONG_FALLBACK_IMAGE = `systems/${SYSTEM_ID}/assets/object/sound.png`;

/** The status art of the performance passives, whatever song left them. */
const INSPIRED_IMAGE = `systems/${SYSTEM_ID}/assets/status/Inspiration.png`;
const UNINSPIRED_IMAGE = `systems/${SYSTEM_ID}/assets/status/Uninspired.png`;

/** What a song asks for when its author left the field empty. */
const SONG_DEFAULTS = Object.freeze({ dc: 10, performers: 1 });

/** Bonus increments a lone performer earns on top of the song's own values. */
const SOLO_INCREMENTS = Object.freeze({
  [PERFORMANCE_GRADES.FAILURE]: 0, [PERFORMANCE_GRADES.LESSER]: 0, [PERFORMANCE_GRADES.SUCCESS]: 0,
  [PERFORMANCE_GRADES.GREATER]: 1, [PERFORMANCE_GRADES.TRIUMPH]: 2
});

/** Bonus increments a group earns when every accompaniment also succeeded. */
const GROUP_INCREMENTS = Object.freeze({
  [PERFORMANCE_GRADES.FAILURE]: 0, [PERFORMANCE_GRADES.LESSER]: 0, [PERFORMANCE_GRADES.SUCCESS]: 0,
  [PERFORMANCE_GRADES.GREATER]: 2, [PERFORMANCE_GRADES.TRIUMPH]: 3
});

/** The short label each song stat is written with on a passive, e.g. `+2 Mgt`. */
const STAT_SHORT = Object.freeze(Object.fromEntries(SONG_STAT_KEYS.map(key => [
  key, STATS.find(entry => entry.key === key)?.short ?? key
])));

/* -------------------------------------------- */
/*  Songs                                       */
/* -------------------------------------------- */
function blankBonuses() {
  return Object.fromEntries(SONG_STAT_KEYS.map(key => [key, 0]));
}

/** A whole number held to a range. An empty or unreadable value takes the fallback. */
function wholeWithin(value, { min, max }, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const whole = Math.trunc(Number(value));
  if (!Number.isFinite(whole)) return fallback;
  return Math.max(min, Math.min(max, whole));
}

/** A song's track: a trimmed Playlist or PlaylistSound uuid, or empty when unset or out of bounds. */
function songTrack(value) {
  if (typeof value !== 'string') return '';
  const track = value.trim();
  return track.length <= SONG_LIMITS.maxTrack ? track : '';
}

/** A blank song with the given id, Default unless told otherwise, for the song library editor. */
export function newSong(id, isDefault = true) {
  return normalizeSong({ id: String(id ?? ''), isDefault: isDefault !== false });
}

/**
 * Coerce a stored song into the canonical shape: a difficulty and a performer count within SONG_LIMITS, every
 * stat bonus a whole number from 0 (not granted) to the bonus ceiling, and a track uuid string.
 * The result is a fresh, mutable object, so the song library editor may keep editing it.
 */
export function normalizeSong(raw, fallbackId = '') {
  const song = raw ?? {};
  const bonuses = blankBonuses();
  for (const key of SONG_STAT_KEYS) bonuses[key] = wholeWithin(song.bonuses?.[key], SONG_LIMITS.bonus, 0);
  return {
    id: String(song.id || fallbackId || ''),
    name: String(song.name ?? ''),
    img: String(song.img || SONG_FALLBACK_IMAGE),
    description: String(song.description ?? ''),
    isDefault: song.isDefault !== false,
    builtin: song.builtin === true,
    dc: wholeWithin(song.dc, SONG_LIMITS.dc, SONG_DEFAULTS.dc),
    performers: wholeWithin(song.performers, SONG_LIMITS.performers, SONG_DEFAULTS.performers),
    bonuses,
    track: songTrack(song.track)
  };
}

/**
 * The song library's rules, shared with the recipe library through defineLibrary in library.mjs. A world's song
 * matches its built-in only when every normalised field is the same.
 */
export const {
  normalizeEntries: normalizeSongs,
  normalizeChanges: normalizeSongChanges,
  resolve: resolveSongLibrary,
  planChanges: planSongLibraryChanges,
  known: songsForPerformer
} = defineLibrary({ key: 'songs', fallbackPrefix: 'song', normalize: normalizeSong, signature: songSignature });

function songSignature(song) {
  return JSON.stringify(normalizeSong(song, song?.id));
}

/* -------------------------------------------- */
/*  The songbook                                */
/* -------------------------------------------- */
/**
 * Parse the shipped `json/songs.json` for foundry/adapters/services/json-files.mjs. Each id gains the built-in
 * prefix, and a song with no name is skipped with a warning.
 */
export function parseSongbook(raw) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.songs) ? raw.songs : []);
  const songs = [];
  const warnings = [];
  for (const entry of source) {
    const name = String(entry?.name ?? '').trim();
    if (!name) {
      warnings.push(`Song "${entry?.id ?? '?'}" has no name and was skipped.`);
      continue;
    }
    songs.push(normalizeSong({
      ...entry,
      id: builtinId(entry?.id, name),
      name,
      img: String(entry?.img ?? '').trim(),
      isDefault: true,
      builtin: true
    }));
  }
  return Object.freeze({ songs: Object.freeze(songs), warnings: Object.freeze(warnings) });
}

/* -------------------------------------------- */
/*  Marks                                       */
/* -------------------------------------------- */
/**
 * The performance a unit already carries, read from its items' flags by the downtime roster projection:
 * `'Inspired'`, `'Uninspired'`, or empty when it may still perform and benefit. One performance per downtime.
 * @param {Iterable<{name?: string, flags?: object}>} items The unit's items, or item-like records.
 */
export function performanceMarkAmong(items = []) {
  for (const item of items ?? []) {
    if (!item?.flags?.[SYSTEM_ID]?.[PERFORMANCE_ENTITY_FLAG]) continue;
    return String(item.name ?? '') === PERFORMANCE_PASSIVE_NAMES.UNINSPIRED
      ? PERFORMANCE_PASSIVE_NAMES.UNINSPIRED : PERFORMANCE_PASSIVE_NAMES.INSPIRED;
  }
  return '';
}

/* -------------------------------------------- */
/*  Grading                                     */
/* -------------------------------------------- */
/** The lead's own grade by margin over the difficulty. An unreadable margin is a failure. */
function gradeForMargin(margin) {
  const value = Number(margin);
  if (!Number.isFinite(value) || value < -4) return PERFORMANCE_GRADES.FAILURE;
  if (value < 1) return PERFORMANCE_GRADES.LESSER;
  if (value < 5) return PERFORMANCE_GRADES.SUCCESS;
  if (value < 10) return PERFORMANCE_GRADES.GREATER;
  return PERFORMANCE_GRADES.TRIUMPH;
}

/**
 * Grade a performance for engine/downtime/resolvers.mjs from every performer's margin over the song's difficulty.
 * A solo keeps the lead's grade. A group keeps it, with larger increments, only while every accompaniment succeeded.
 * One failed accompaniment drops a failing or Faltering lead to a failure, and any better lead to Faltering.
 * @param {{leadMargin: number, accompanimentMargins?: number[]}} margins Each check's total minus the difficulty.
 * @returns {{grade: string, increments: number}}
 */
export function gradePerformance({ leadMargin, accompanimentMargins = [] } = {}) {
  const lead = gradeForMargin(leadMargin);
  const margins = Array.isArray(accompanimentMargins) ? accompanimentMargins : [];
  if (!margins.length) return { grade: lead, increments: SOLO_INCREMENTS[lead] };
  if (margins.every(margin => Number(margin) >= 1)) {
    return { grade: lead, increments: GROUP_INCREMENTS[lead] };
  }
  const faltered = [PERFORMANCE_GRADES.FAILURE, PERFORMANCE_GRADES.LESSER].includes(lead)
    ? PERFORMANCE_GRADES.FAILURE : PERFORMANCE_GRADES.LESSER;
  return { grade: faltered, increments: 0 };
}

/**
 * Allocate the stat bonuses a graded performance grants its audience. A failure grants nothing, and a Faltering
 * one grants +1 to one granted stat. Anything better grants the song's values, then adds +1 per increment to a
 * granted stat drawn again each time, so a stat may be picked twice.
 * @param {object} bonuses The song's bonuses. A stat at 0 is not granted and is never drawn.
 * @param {string} grade One of PERFORMANCE_GRADES.
 * @param {number} increments From gradePerformance.
 * @param {() => number} rng The action's random source, answering in [0, 1).
 * @returns {Readonly<object>} Stat key to bonus, in SONG_STAT_KEYS order.
 */
export function allocateSongBonuses(bonuses, grade, increments = 0, rng) {
  const values = Object.fromEntries(SONG_STAT_KEYS.map(key => [
    key, wholeWithin(bonuses?.[key], SONG_LIMITS.bonus, 0)
  ]));
  const granted = SONG_STAT_KEYS.filter(key => values[key] > 0);
  if (!granted.length || grade === PERFORMANCE_GRADES.FAILURE || !PERFORMANCE_GRADE_ORDER.includes(grade)) {
    return Object.freeze({});
  }
  if (grade === PERFORMANCE_GRADES.LESSER) return Object.freeze({ [drawStat(granted, rng)]: 1 });
  const allocated = Object.fromEntries(granted.map(key => [key, values[key]]));
  const extra = Math.max(0, Math.trunc(Number(increments)) || 0);
  for (let step = 0; step < extra; step += 1) allocated[drawStat(granted, rng)] += 1;
  return Object.freeze(Object.fromEntries(granted.map(key => [key, allocated[key]])));
}

/** One uniform draw among the granted stats from the injected random source. */
function drawStat(keys, rng) {
  if (typeof rng !== 'function') throw new TypeError('allocateSongBonuses needs the action\'s random source.');
  const index = Math.floor((Number(rng()) || 0) * keys.length);
  return keys[Math.min(keys.length - 1, Math.max(0, index))];
}

/** Allocated bonuses as the passive and the settled card write them, e.g. `+2 Mgt, +1 Wit`, or empty for none. */
export function describeBonuses(allocated = {}) {
  return bonusEntries(allocated).map(entry => `${signed(entry.amount)} ${entry.label}`).join(', ');
}

function bonusEntries(allocated) {
  return SONG_STAT_KEYS
    .map(key => ({ key, label: STAT_SHORT[key], amount: Math.trunc(Number(allocated?.[key])) || 0 }))
    .filter(entry => entry.amount !== 0);
}

/** Support experience each pair of performers shares for a grade, the failure value for anything unrecognised. */
export function performerSupportXpFor(grade) {
  return PERFORMER_SUPPORT_XP[grade] ?? PERFORMER_SUPPORT_XP[PERFORMANCE_GRADES.FAILURE];
}

/** Support experience each performer shares with every listener for a grade, the failure value when unrecognised. */
export function listenerSupportXpFor(grade) {
  return LISTENER_SUPPORT_XP[grade] ?? LISTENER_SUPPORT_XP[PERFORMANCE_GRADES.FAILURE];
}

/* -------------------------------------------- */
/*  The performance passive                     */
/* -------------------------------------------- */
/**
 * Build the Inspired passive each audience unit receives, for playInstrument in engine/downtime/resolvers.mjs. It
 * holds one raw-stat modifier per allocated bonus. It is tagged as downtime content so the GM's Reset Downtime
 * removes it, and marked with the song and grade so performanceMarkAmong finds it.
 * @returns {{data: object, name: string, summary: string}} `data` is the Item's creation data.
 */
export function buildPerformancePassive(song, grade, allocated = {}) {
  const entries = bonusEntries(allocated);
  const summary = describeBonuses(allocated);
  const name = PERFORMANCE_PASSIVE_NAMES.INSPIRED;
  const description = `${song?.name || 'A song'}: ${summary || 'no lasting benefit'}. Lasts until the party rests.`;
  const modifiers = entries.map(entry => modifier(`${entry.label} ${signed(entry.amount)}`, entry.key, entry.amount));
  return {
    data: passiveData(song, grade, name, INSPIRED_IMAGE, description, modifiers), name, summary
  };
}

/** Build the Uninspired passive a failed performance leaves on its audience: no modifiers, the same marks. */
export function buildUninspiredPassive(song) {
  const name = PERFORMANCE_PASSIVE_NAMES.UNINSPIRED;
  const description = `Drained by a failed performance of ${song?.name || 'a song'}. Cannot perform or benefit from `
    + 'another performance until the party rests.';
  return {
    data: passiveData(song, PERFORMANCE_GRADES.FAILURE, name, UNINSPIRED_IMAGE, description, []), name, summary: ''
  };
}

function passiveData(song, grade, name, img, description, modifiers) {
  return {
    name,
    type: 'Ability',
    img,
    system: { itemType: 'Passive', description, modifiers },
    flags: {
      [SYSTEM_ID]: {
        [DOWNTIME_ENTITY_FLAG]: true,
        [PERFORMANCE_ENTITY_FLAG]: { songId: String(song?.id ?? ''), grade: String(grade ?? '') }
      }
    }
  };
}

/* -------------------------------------------- */
/*  The stage                                   */
/* -------------------------------------------- */
/**
 * Validate a performance for engine/downtime/commands.mjs before anything is rolled or written, only in free
 * exploration. The lead must be an unaffected Action-lane participant who knows the song. Accompaniments ignore
 * commitment: each must be a distinct, unaffected, standing roster unit other than the lead, exactly as many as the
 * song asks for. The audience is every unaffected roster unit still standing, performers included. The listeners are
 * every standing non-performer. A unit at 0 HP takes no part in downtime at all.
 * @param {object} snapshot The performance snapshot: `station`, `cursor`, `exploring`, `inReach`, `roster`
 *   (downtime units carrying `performanceMark` and `songIds`) and `library`.
 * @param {object} intent A normalizePerformanceIntent result.
 * @returns {Readonly<object>} A refusal, or `{ok: true, code, data}` with the plan also under `plan`.
 */
export function planPerformance(snapshot = {}, intent = {}) {
  if (snapshot.station?.objectType !== DOWNTIME_STATION_TYPES.PERFORMANCE) {
    return refuse(RESULT_CODES.DOWNTIME_STATION_INVALID);
  }
  if (snapshot.exploring !== true) return refuse(RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED);
  if (snapshot.inReach !== true) {
    return refuse(RESULT_CODES.DOWNTIME_OUT_OF_REACH, { actorName: snapshot.cursor?.name });
  }
  const roster = snapshot.roster ?? [];
  const lead = resolveParticipants(roster, { lane: DOWNTIME_LANES.ACTION })
    .find(entry => entry.actorUuid === intent.performerUuid) ?? null;
  if (!lead) return refuse(RESULT_CODES.DOWNTIME_PERFORMER_OUTSIDE_ROSTER);
  if (!lead.eligible) {
    return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { performerName: lead.name, blocked: lead.blocked });
  }
  if (lead.performanceMark) return alreadyAffected(lead);
  const known = songsForPerformer(snapshot.library ?? [], lead.songIds).find(entry => entry.id === intent.songId);
  if (!known) return refuse(RESULT_CODES.DOWNTIME_SONG_UNKNOWN, { performerName: lead.name });
  const song = Object.freeze(normalizeSong(known, known.id));
  const wanted = song.performers - 1;
  const uuids = Array.isArray(intent.accompanimentUuids) ? intent.accompanimentUuids : [];
  if (uuids.length !== wanted) {
    return refuse(RESULT_CODES.DOWNTIME_ACCOMPANIMENT_COUNT, {
      songName: song.name, required: wanted, given: uuids.length
    });
  }
  const accompaniments = [];
  for (const uuid of uuids) {
    const unit = roster.find(entry => entry.actorUuid === uuid) ?? null;
    const reason = uuid === lead.actorUuid ? 'lead'
      : accompaniments.some(entry => entry.actorUuid === uuid) ? 'duplicate' : unit ? '' : 'outside-roster';
    if (reason) return refuse(RESULT_CODES.DOWNTIME_ACCOMPANIMENT_INVALID, { actorName: unit?.name ?? '', reason });
    if (unit.performanceMark) return alreadyAffected(unit);
    const fallen = defeatedBlock(unit);
    if (fallen) {
      return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { performerName: unit.name, blocked: fallen });
    }
    accompaniments.push(unit);
  }
  const performing = new Set([lead.actorUuid, ...uuids]);
  const plan = Object.freeze({
    song,
    lead,
    accompaniments: Object.freeze(accompaniments),
    audience: Object.freeze(roster.filter(entry => !entry.performanceMark && !defeatedBlock(entry))),
    listeners: Object.freeze(roster.filter(entry => !performing.has(entry.actorUuid) && !defeatedBlock(entry))),
    skillKey: PERFORM_SKILL_KEY,
    dc: song.dc,
    staged: lead.actorUuid !== snapshot.cursor?.actorUuid
  });
  return Object.freeze({ ok: true, code: RESULT_CODES.DOWNTIME_PERFORMED, data: plan, plan });
}

function alreadyAffected(unit) {
  return refuse(RESULT_CODES.DOWNTIME_ALREADY_INSPIRED, {
    actorName: unit.name, performanceMark: unit.performanceMark
  });
}
