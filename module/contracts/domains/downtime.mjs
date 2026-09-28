/** @layer contracts/domains */
import { validate as validateAnimation } from '../dsl/animations.mjs';
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';
import { WEAPON_PROFICIENCIES } from './items.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
/** The Actor flag a unit's downtime commitment is stored under: `{lane, action, exhausted}`. */
export const DOWNTIME_FLAG = 'downtime';

/** The Item flag marking a buff a downtime activity granted, so a refresh can find and remove it. */
export const DOWNTIME_ENTITY_FLAG = 'downtimeEntity';

/** The two kinds of downtime act. An Energy-lane act spends Energy, and an Action-lane act uses the whole downtime. */
export const DOWNTIME_LANES = Object.freeze({ ENERGY: 'energy', ACTION: 'action' });

/** Every unit's Energy before passive modifiers. The capacity is worked out when needed and never stored. */
export const DOWNTIME_ENERGY_BASE = 3;

/** Skill experience one Energy-lane act pays, as a fraction of the current rank bar per Energy spent. */
export const DOWNTIME_XP_FRACTION_PER_ENERGY = 0.03;

/** Skill experience one Action-lane act pays, as a fraction of the current rank bar. */
export const DOWNTIME_XP_FRACTION_ACTION = 0.10;

/** The factions a downtime roster is drawn from. */
export const DOWNTIME_ROSTER_FACTIONS = Object.freeze(['Lord', 'Retainer']);

/** The Object subtype each activity is performed at. */
export const DOWNTIME_STATION_TYPES = Object.freeze({
  COOKING: 'Cooking Pot', GATHERING: 'Gathering Node', WORKSHOP: 'Workshop', LABORATORY: 'Laboratory',
  PERFORMANCE: 'Instrument', REQUISITION: 'Stationary'
});

/** Station priority used by the board interaction handler when more than one station is available. */
export const DOWNTIME_STATION_ORDER = Object.freeze([
  DOWNTIME_STATION_TYPES.COOKING, DOWNTIME_STATION_TYPES.GATHERING, DOWNTIME_STATION_TYPES.WORKSHOP,
  DOWNTIME_STATION_TYPES.LABORATORY, DOWNTIME_STATION_TYPES.PERFORMANCE, DOWNTIME_STATION_TYPES.REQUISITION
]);

/** How a cook turned out: under the difficulty, over it, or over it by the margin with a special ingredient. */
export const MEAL_OUTCOMES = Object.freeze({ FAIL: 'fail', SUCCESS: 'success', SPECIAL: 'special' });

/** The bounds a saved recipe must fit. The downtime rules then normalise the values within them. */
export const RECIPE_LIMITS = Object.freeze({
  maxRecipes: 200, maxIngredients: 24, maxName: 200, maxDescription: 2000, maxImage: 512, maxDc: 99, maxGrowth: 100
});

/** The raw stats a song may raise, in the order game/downtime/performance.mjs lists and allocates them. */
export const SONG_STAT_KEYS = Object.freeze([
  'hpMax', 'stnMax', 'bld', 'mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res'
]);

/**
 * The bounds a stored song is held to. normalizeSongLibraryIntent checks text lengths and counts, and normalizeSong
 * in game/downtime/performance.mjs clamps the difficulty, the performer count and each stat bonus into these ranges.
 */
export const SONG_LIMITS = Object.freeze({
  maxSongs: RECIPE_LIMITS.maxRecipes,
  maxName: RECIPE_LIMITS.maxName,
  maxDescription: RECIPE_LIMITS.maxDescription,
  maxImage: RECIPE_LIMITS.maxImage,
  maxTrack: 512,
  dc: Object.freeze({ min: 1, max: RECIPE_LIMITS.maxDc }),
  performers: Object.freeze({ min: 1, max: 6 }),
  bonus: Object.freeze({ min: 0, max: 10 })
});

/** How a performance went, from a total failure to a triumph. The lead's margin and the accompaniments decide it. */
export const PERFORMANCE_GRADES = Object.freeze({
  FAILURE: 'failure', LESSER: 'lesser', SUCCESS: 'success', GREATER: 'greater', TRIUMPH: 'triumph'
});

/** The grades from worst to best. */
export const PERFORMANCE_GRADE_ORDER = Object.freeze([
  PERFORMANCE_GRADES.FAILURE, PERFORMANCE_GRADES.LESSER, PERFORMANCE_GRADES.SUCCESS, PERFORMANCE_GRADES.GREATER,
  PERFORMANCE_GRADES.TRIUMPH
]);

/** How the performance menu and the settled card name each grade. */
export const PERFORMANCE_GRADE_LABELS = Object.freeze({
  [PERFORMANCE_GRADES.FAILURE]: 'Failed Performance',
  [PERFORMANCE_GRADES.LESSER]: 'Faltering',
  [PERFORMANCE_GRADES.SUCCESS]: 'Success',
  [PERFORMANCE_GRADES.GREATER]: 'Rousing',
  [PERFORMANCE_GRADES.TRIUMPH]: 'Triumphant'
});

/** The passive a performance leaves on its audience: Inspired with the song's bonuses, or Uninspired on a failure. */
export const PERFORMANCE_PASSIVE_NAMES = Object.freeze({ INSPIRED: 'Inspired', UNINSPIRED: 'Uninspired' });

/** The Item flag marking a performance passive: `flags['emblem-rpg'].performance = {songId, grade}`. */
export const PERFORMANCE_ENTITY_FLAG = 'performance';

/** Support experience each pair of performers shares, by grade. */
export const PERFORMER_SUPPORT_XP = Object.freeze({
  [PERFORMANCE_GRADES.FAILURE]: 5, [PERFORMANCE_GRADES.LESSER]: 8, [PERFORMANCE_GRADES.SUCCESS]: 11,
  [PERFORMANCE_GRADES.GREATER]: 14, [PERFORMANCE_GRADES.TRIUMPH]: 17
});

/** Support experience each performer shares with every roster unit that only listened, by grade. */
export const LISTENER_SUPPORT_XP = Object.freeze({
  [PERFORMANCE_GRADES.FAILURE]: 1, [PERFORMANCE_GRADES.LESSER]: 2, [PERFORMANCE_GRADES.SUCCESS]: 3,
  [PERFORMANCE_GRADES.GREATER]: 4, [PERFORMANCE_GRADES.TRIUMPH]: 5
});

/** The gathering methods a node may be authored with. Each has its own pair of working sounds. */
export const GATHER_METHODS = Object.freeze(['harvesting', 'mining', 'logging', 'shoveling', 'fishing']);

/** Where a gather's yield is sent: the party Convoy, or the gathering unit's own inventory. */
export const GATHER_DESTINATIONS = Object.freeze({ CONVOY: 'convoy', INVENTORY: 'inventory' });

/**
 * Gather presentation timings, in milliseconds: the banner before the roll, the pause after the worker walks to the
 * node and again before it walks back (stageHold), and how long an exhausted node stays before it's removed.
 */
export const GATHERING_TIMING = Object.freeze({
  bannerHold: 4000, stageHold: 900, stageSettle: 250, nodeRemoval: 3000
});

/** Forge and brew timings: the banner held before the roll, and the same staging pause as a gather. */
export const CRAFTING_TIMING = Object.freeze({ bannerHold: 3500, stageHold: GATHERING_TIMING.stageHold });

/** Cooking timings: the pot's banner held before the roll, and the same staging pause as a gather. */
export const COOKING_TIMING = Object.freeze({ bannerHold: 4000, stageHold: GATHERING_TIMING.stageHold });

/**
 * Performance timings: the instrument's banner held before the rolls, and the same staging pause as a gather. A song
 * with a track keeps its banner up for at least `trackLinger` after it opens.
 */
export const PERFORMANCE_TIMING = Object.freeze({
  bannerHold: 4000, stageHold: GATHERING_TIMING.stageHold, trackLinger: 8000
});

/** How long downtime settlement waits for the roll card's dice. The engine waits on its clock, not on Dice So Nice. */
export const DOWNTIME_CHECK_TIMING = Object.freeze({ diceSettleHold: 2600 });

/** The skill both units roll when they socialize. */
export const SOCIAL_SKILL_KEY = 'sociability';

/** The skill the trainer rolls. The trainee gains its total as proficiency experience. */
export const TRAIN_SKILL_KEY = 'command';

/** Support experience one training session banks for the pair. */
export const TRAINING_SUPPORT_XP = 5;

/** The two activities a pair of party units may share, chosen in the social menu. */
export const SOCIAL_MODES = Object.freeze({ SOCIALIZE: 'socialize', TRAIN: 'train' });

/** The board unit-pick modes ui/controls/interaction.mjs opens for a downtime activity between two units. */
export const DOWNTIME_PICK_MODES = Object.freeze({ SOCIAL: 'socialize' });

/** Socialize timings: the two-portrait band held open before the rolls, and the same staging pause as a gather. */
export const SOCIAL_TIMING = Object.freeze({ bannerHold: 4000, stageHold: GATHERING_TIMING.stageHold });

/**
 * The spar a training session plays before the trainer's roll: how many alternating passes, and the bounds each
 * pass's length is clamped into from the authored animation's duration. An animation whose serialized form is
 * longer than `maxAnimationLength` is too big for a presentation message, so no spar plays.
 */
export const TRAINING_SPAR = Object.freeze({
  passes: 4, defaultPassMs: 1000, minPassMs: 300, maxPassMs: 2500, maxAnimationLength: 6144
});

/** The request kinds a requisition may name at a Stationary. */
export const REQUISITION_KINDS = Object.freeze({
  FUNDING: 'funding', EQUIPMENT: 'equipment', SUPPLIES: 'supplies', HIRELINGS: 'hirelings'
});

/** The kinds in the order the requisition menu lists them. */
export const REQUISITION_KIND_ORDER = Object.freeze([
  REQUISITION_KINDS.FUNDING, REQUISITION_KINDS.EQUIPMENT, REQUISITION_KINDS.SUPPLIES, REQUISITION_KINDS.HIRELINGS
]);

/** How the requisition menu and the settled card name each kind. */
export const REQUISITION_KIND_LABELS = Object.freeze({
  [REQUISITION_KINDS.FUNDING]: 'Funding',
  [REQUISITION_KINDS.EQUIPMENT]: 'Equipment',
  [REQUISITION_KINDS.SUPPLIES]: 'Supplies',
  [REQUISITION_KINDS.HIRELINGS]: 'Hirelings'
});

/** The kinds planRequisition in game/downtime/requisition.mjs settles. The menu lists the rest as unavailable. */
export const REQUISITION_AVAILABLE_KINDS = Object.freeze([REQUISITION_KINDS.FUNDING]);

/** The skill a requisitioner rolls. */
export const REQUISITION_SKILL_KEY = 'civics';

/** How a requisition turned out: the faction granted the demand, or declined it. */
export const REQUISITION_OUTCOMES = Object.freeze({ SUCCESS: 'success', FAIL: 'fail' });

/** How a Stationary's faction regards the party, from worst to best. */
export const FACTION_RELATIONS = Object.freeze(['Poor', 'Neutral', 'Decent', 'Friendly', 'Devoted']);

/** A requisition's base difficulty by relation. Each step of the demand adds one (see requisitionDc). */
export const FACTION_RELATION_DC = Object.freeze({ Poor: 15, Neutral: 10, Decent: 7, Friendly: 5, Devoted: 0 });

/** How deep a faction's coffers run, from poorest to richest. */
export const FACTION_WEALTH = Object.freeze(['Poor', 'Average', 'Prosperous', 'Elite', 'Boundless']);

/** The most GP one requisition may demand, by the faction's wealth. Null means only maxDemand caps it. */
export const FACTION_WEALTH_CAP = Object.freeze({
  Poor: 1000, Average: 2000, Prosperous: 3000, Elite: 5000, Boundless: null
});

/**
 * The bounds of a requisition and of a Stationary's faction table. A demand is a whole number of `step`s from `min`
 * up to the faction's cap, and never past `maxDemand`. A table holds at most `maxFactions` rows, with names of up to
 * `maxName` characters.
 */
export const REQUISITION_LIMITS = Object.freeze({
  step: 100, min: 100, maxDemand: 100000, maxFactions: 24, maxName: 80
});

/** Requisition timings: the Stationary's banner held before the roll, and the same staging pause as a gather. */
export const REQUISITION_TIMING = Object.freeze({ bannerHold: 4000, stageHold: GATHERING_TIMING.stageHold });

/**
 * The items whose attack (or activation) animation the training spar plays, by proficiency. The first item found
 * wins, and a world copy is tried before a pack copy.
 */
export const TRAINING_SPAR_ITEMS = Object.freeze({
  blade: Object.freeze(['Training Sword', 'Broadsword', 'Longsword']),
  brawling: Object.freeze(['Training Gloves', 'Gauntlets', 'Strikers']),
  bow: Object.freeze(['Practice Bow', 'Shortbow', 'Hunting Bow']),
  polearm: Object.freeze(['Training Spear', 'Winged Spear', 'Partisan']),
  heavy: Object.freeze(['Training Mallet', 'Wooden Club', 'War Axe']),
  covert: Object.freeze(['Practice Knife', 'Stiletto', 'Kris']),
  elemental: Object.freeze(['Firebolt', 'Frostbolt']),
  arcane: Object.freeze(['Magic Missiles']),
  divine: Object.freeze(['Salve', 'Sunbeam']),
  occult: Object.freeze(['Umbra', 'Necrosis'])
});

/* -------------------------------------------- */
/*  Stationary factions                         */
/* -------------------------------------------- */
/**
 * Coerce one stored faction row of a Stationary (`system.requisition.factions`) into its canonical shape: a bounded
 * name, a known relation and wealth, and the two switches. The Object data model clamps its prepared rows with this,
 * and the requisition snapshot reads the station through it. The result is a fresh, mutable object.
 * @param {object} raw The stored row.
 * @param {string} [fallbackId] The id a row without one takes.
 */
export function normalizeFaction(raw, fallbackId = '') {
  const row = plainRecord(raw) ? raw : {};
  return {
    _id: String(row._id || fallbackId || ''),
    name: String(row.name ?? '').trim().slice(0, REQUISITION_LIMITS.maxName),
    relation: FACTION_RELATIONS.includes(row.relation) ? row.relation : 'Neutral',
    wealth: FACTION_WEALTH.includes(row.wealth) ? row.wealth : 'Average',
    enabled: row.enabled !== false,
    requisitioned: row.requisitioned === true
  };
}

/** Every stored faction row normalised, in table order. Non-record rows are dropped, and the list is capped. */
export function normalizeFactions(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => plainRecord(row))
    .slice(0, REQUISITION_LIMITS.maxFactions)
    .map((row, index) => normalizeFaction(row, `faction-${index}`));
}

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
// These normalizers bound the payloads engine/downtime/commands.mjs reads. A command refuses a null result with
// DOWNTIME_INPUT_INVALID, and a menu read (inspectCooking, inspectSocial and the like) returns null.
const GATHER_INTENT_KEYS = ['cursorTokenUuid', 'stationTokenUuid', 'performerUuid', 'destination'];
const MAX_UUID_LENGTH = 512;
const MAX_ITEMS = 24;

/** Bound one gather: the unit driving it, the node it stands at, the unit sent to work it, and where the yield goes. */
export function normalizeGatheringIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, GATHER_INTENT_KEYS)) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const stationTokenUuid = tokenUuid(payload.stationTokenUuid);
  const performerUuid = actorUuid(payload.performerUuid);
  if (!cursorTokenUuid || !stationTokenUuid || !performerUuid) return null;
  if (cursorTokenUuid === stationTokenUuid) return null;
  if (!Object.values(GATHER_DESTINATIONS).includes(payload.destination)) return null;
  return Object.freeze({ cursorTokenUuid, stationTokenUuid, performerUuid, destination: payload.destination });
}

const FORGE_INTENT_KEYS = ['cursorTokenUuid', 'stationTokenUuid', 'performerUuid', 'itemUuid'];
const BREW_INTENT_KEYS = ['cursorTokenUuid', 'stationTokenUuid', 'performerUuid', 'recipeUuid'];

/** Bound one forge: the driving unit, the station it stands at, the unit sent to work, and the carried copy. */
export function normalizeForgingIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, FORGE_INTENT_KEYS)) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const stationTokenUuid = tokenUuid(payload.stationTokenUuid);
  const performerUuid = actorUuid(payload.performerUuid);
  const itemUuid = embeddedItemUuid(payload.itemUuid);
  if (!cursorTokenUuid || !stationTokenUuid || !performerUuid || !itemUuid) return null;
  if (cursorTokenUuid === stationTokenUuid) return null;
  return Object.freeze({ cursorTokenUuid, stationTokenUuid, performerUuid, itemUuid });
}

/** Bound one brew: the driving unit, the station, the unit sent to work, and the recipe the world offers. */
export function normalizeBrewingIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, BREW_INTENT_KEYS)) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const stationTokenUuid = tokenUuid(payload.stationTokenUuid);
  const performerUuid = actorUuid(payload.performerUuid);
  const recipeUuid = itemUuid(payload.recipeUuid);
  if (!cursorTokenUuid || !stationTokenUuid || !performerUuid || !recipeUuid) return null;
  if (cursorTokenUuid === stationTokenUuid) return null;
  return Object.freeze({ cursorTokenUuid, stationTokenUuid, performerUuid, recipeUuid });
}

const COOK_INTENT_KEYS = ['cursorTokenUuid', 'stationTokenUuid', 'performerUuid', 'recipeId', 'specialName', 'dinerUuids'];
const MAX_DINERS = 24;

/** Bound one cook: the driving unit, the pot, the chef, the recipe id, an optional special ingredient, the diners. */
export function normalizeCookingIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, COOK_INTENT_KEYS)) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const stationTokenUuid = tokenUuid(payload.stationTokenUuid);
  const performerUuid = actorUuid(payload.performerUuid);
  const recipeId = String(payload.recipeId ?? '');
  if (!cursorTokenUuid || !stationTokenUuid || !performerUuid || !boundedText(recipeId, RECIPE_LIMITS.maxName)) return null;
  if (cursorTokenUuid === stationTokenUuid) return null;
  const specialName = payload.specialName === null || payload.specialName === undefined ? '' : String(payload.specialName);
  if (specialName && !boundedText(specialName, RECIPE_LIMITS.maxName)) return null;
  const rawDiners = payload.dinerUuids ?? [];
  if (!Array.isArray(rawDiners) || rawDiners.length > MAX_DINERS) return null;
  const dinerUuids = [];
  for (const entry of rawDiners) {
    const uuid = actorUuid(entry);
    if (!uuid) return null;
    if (uuid !== performerUuid && !dinerUuids.includes(uuid)) dinerUuids.push(uuid);
  }
  return Object.freeze({
    cursorTokenUuid, stationTokenUuid, performerUuid, recipeId, specialName, dinerUuids: Object.freeze(dinerUuids)
  });
}

/** Bound a whole recipe library the GM saves: a list of records within the recipe limits, detached. */
export function normalizeRecipeLibraryIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ['recipes'])) return null;
  if (!Array.isArray(payload.recipes) || payload.recipes.length > RECIPE_LIMITS.maxRecipes) return null;
  const recipes = [];
  for (const entry of payload.recipes) {
    if (!plainRecord(entry)) return null;
    const ingredients = Array.isArray(entry.ingredients) ? entry.ingredients : [];
    if (ingredients.length > RECIPE_LIMITS.maxIngredients || ingredients.some(item => !plainRecord(item))) return null;
    for (const [key, limit] of [['id', RECIPE_LIMITS.maxName], ['name', RECIPE_LIMITS.maxName],
      ['img', RECIPE_LIMITS.maxImage], ['description', RECIPE_LIMITS.maxDescription]]) {
      const text = String(entry[key] ?? '');
      if (text.length > limit) return null;
    }
    if (ingredients.some(item => String(item.name ?? '').length > RECIPE_LIMITS.maxName
      || String(item.uuid ?? '').length > MAX_UUID_LENGTH || String(item.img ?? '').length > RECIPE_LIMITS.maxImage)) return null;
    recipes.push(structuredClone(entry));
  }
  return Object.freeze({ recipes: Object.freeze(recipes) });
}

const PERFORM_INTENT_KEYS = ['cursorTokenUuid', 'stationTokenUuid', 'performerUuid', 'songId', 'accompanimentUuids'];
const MAX_ACCOMPANIMENTS = SONG_LIMITS.performers.max - 1;

/**
 * Bound one performance: the driving unit, the instrument, the lead performer, the song id, and the accompanying
 * units. Accompaniments come back distinct and without the lead. planPerformance checks their count against the song.
 */
export function normalizePerformanceIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, PERFORM_INTENT_KEYS)) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const stationTokenUuid = tokenUuid(payload.stationTokenUuid);
  const performerUuid = actorUuid(payload.performerUuid);
  const songId = String(payload.songId ?? '');
  if (!cursorTokenUuid || !stationTokenUuid || !performerUuid || !boundedText(songId, SONG_LIMITS.maxName)) return null;
  if (cursorTokenUuid === stationTokenUuid) return null;
  const rawAccompaniments = payload.accompanimentUuids ?? [];
  if (!Array.isArray(rawAccompaniments) || rawAccompaniments.length > MAX_ITEMS) return null;
  const accompanimentUuids = [];
  for (const entry of rawAccompaniments) {
    const uuid = actorUuid(entry);
    if (!uuid) return null;
    if (uuid !== performerUuid && !accompanimentUuids.includes(uuid)) accompanimentUuids.push(uuid);
  }
  if (accompanimentUuids.length > MAX_ACCOMPANIMENTS) return null;
  return Object.freeze({
    cursorTokenUuid, stationTokenUuid, performerUuid, songId, accompanimentUuids: Object.freeze(accompanimentUuids)
  });
}

/**
 * Bound a whole song library the GM saves: a list of records within the song limits, detached, and optionally the
 * built-in ids it removed. Bonuses may name only song stats, and normalizeSong clamps every value afterwards.
 */
export function normalizeSongLibraryIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ['songs', 'removed'])) return null;
  if (!Array.isArray(payload.songs) || payload.songs.length > SONG_LIMITS.maxSongs) return null;
  const rawRemoved = payload.removed ?? [];
  if (!Array.isArray(rawRemoved) || rawRemoved.length > SONG_LIMITS.maxSongs) return null;
  const songs = [];
  for (const entry of payload.songs) {
    if (!plainRecord(entry)) return null;
    if (entry.bonuses !== undefined && (!plainRecord(entry.bonuses) || !exactKeys(entry.bonuses, SONG_STAT_KEYS))) {
      return null;
    }
    for (const [key, limit] of [['id', SONG_LIMITS.maxName], ['name', SONG_LIMITS.maxName],
      ['img', SONG_LIMITS.maxImage], ['description', SONG_LIMITS.maxDescription], ['track', SONG_LIMITS.maxTrack]]) {
      if (String(entry[key] ?? '').length > limit) return null;
    }
    songs.push(structuredClone(entry));
  }
  const removed = [];
  for (const entry of rawRemoved) {
    const id = String(entry ?? '');
    if (!boundedText(id, SONG_LIMITS.maxName)) return null;
    if (!removed.includes(id)) removed.push(id);
  }
  return Object.freeze({ songs: Object.freeze(songs), removed: Object.freeze(removed) });
}

const REQUISITION_INTENT_KEYS = ['cursorTokenUuid', 'stationTokenUuid', 'performerUuid', 'factionId', 'kind', 'demand'];

/**
 * Bound one requisition: the driving unit, the Stationary, the requisitioner, the faction row's id, a known request
 * kind, and the demand as a whole number of GP. planRequisition in game/downtime/requisition.mjs decides whether the
 * kind is available and the demand fits the faction, so its refusal can say why.
 */
export function normalizeRequisitionIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, REQUISITION_INTENT_KEYS)) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const stationTokenUuid = tokenUuid(payload.stationTokenUuid);
  const performerUuid = actorUuid(payload.performerUuid);
  const factionId = typeof payload.factionId === 'string' ? payload.factionId : '';
  if (!cursorTokenUuid || !stationTokenUuid || !performerUuid) return null;
  if (cursorTokenUuid === stationTokenUuid || !boundedText(factionId, REQUISITION_LIMITS.maxName)) return null;
  if (!REQUISITION_KIND_ORDER.includes(payload.kind)) return null;
  if (!Number.isSafeInteger(payload.demand) || payload.demand < 0) return null;
  return Object.freeze({
    cursorTokenUuid, stationTokenUuid, performerUuid, factionId, kind: payload.kind, demand: payload.demand
  });
}

/** Bound a read of one station: the pair of Tokens and nothing else. */
export function normalizeStationIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ['cursorTokenUuid', 'stationTokenUuid'])) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const stationTokenUuid = tokenUuid(payload.stationTokenUuid);
  if (!cursorTokenUuid || !stationTokenUuid || cursorTokenUuid === stationTokenUuid) return null;
  return Object.freeze({ cursorTokenUuid, stationTokenUuid });
}

const SOCIAL_INTENT_KEYS = ['cursorTokenUuid', 'partnerTokenUuid'];
const TRAINING_INTENT_KEYS = ['cursorTokenUuid', 'partnerTokenUuid', 'proficiencyKey'];

/**
 * Bound one socialize, and the social menu's read of a pair: the driving unit's Token and the adjacent Token it
 * visited. planSocialize in game/downtime/social.mjs rechecks the pair against the roster and the board.
 */
export function normalizeSocialIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, SOCIAL_INTENT_KEYS)) return null;
  const cursorTokenUuid = tokenUuid(payload.cursorTokenUuid);
  const partnerTokenUuid = tokenUuid(payload.partnerTokenUuid);
  if (!cursorTokenUuid || !partnerTokenUuid || cursorTokenUuid === partnerTokenUuid) return null;
  return Object.freeze({ cursorTokenUuid, partnerTokenUuid });
}

/** Bound one training session: the same pair of Tokens and the weapon proficiency the pair trains. */
export function normalizeTrainingIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, TRAINING_INTENT_KEYS)) return null;
  const pair = normalizeSocialIntent({
    cursorTokenUuid: payload.cursorTokenUuid, partnerTokenUuid: payload.partnerTokenUuid
  });
  const proficiencyKey = typeof payload.proficiencyKey === 'string' ? payload.proficiencyKey.toLowerCase() : '';
  if (!pair || !WEAPON_PROFICIENCIES.includes(proficiencyKey)) return null;
  return Object.freeze({ ...pair, proficiencyKey });
}

/** The most Energy one restore may hand back, before the unit's own capacity caps it. */
export const ENERGY_RESTORE_LIMIT = 99;

/** Bound one unit's downtime administration: the Actor whose commitment the staff control is reaching for. */
export function normalizeDowntimeUnitIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ['actorUuid'])) return null;
  const uuid = actorUuid(payload.actorUuid);
  return uuid ? Object.freeze({ actorUuid: uuid }) : null;
}

/** Bound one Energy restoration: the unit and the whole number of points the staff caller asked for. */
export function normalizeEnergyRestoreIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ['actorUuid', 'amount'])) return null;
  const uuid = actorUuid(payload.actorUuid);
  const amount = Math.floor(Number(payload.amount));
  if (!uuid || !Number.isFinite(amount) || amount < 1 || amount > ENERGY_RESTORE_LIMIT) return null;
  return Object.freeze({ actorUuid: uuid, amount });
}

/**
 * Bound one Reset Downtime: the Scene whose placed units, downtime buffs, Stationaries and Vendors' haggles are reset.
 */
export function normalizeDowntimeResetIntent(payload) {
  if (!plainRecord(payload) || !exactKeys(payload, ['sceneUuid'])) return null;
  const sceneUuid = String(payload.sceneUuid ?? '');
  if (!sceneUuid.startsWith('Scene.') || !boundedText(sceneUuid, MAX_UUID_LENGTH)) return null;
  return Object.freeze({ sceneUuid });
}

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
export const DOWNTIME_PRESENTATION_KIND = 'downtime-activity';

export const DOWNTIME_PRESENTATION_EVENTS = Object.freeze({
  GATHER_BEGIN: 'gather-begin',
  GATHER_END: 'gather-end',
  GATHER_SETTLED: 'gather-settled',
  FORGE_BEGIN: 'forge-begin',
  FORGE_END: 'forge-end',
  FORGE_SETTLED: 'forge-settled',
  BREW_BEGIN: 'brew-begin',
  BREW_END: 'brew-end',
  BREW_SETTLED: 'brew-settled',
  COOK_BEGIN: 'cook-begin',
  COOK_END: 'cook-end',
  COOK_SETTLED: 'cook-settled',
  PERFORM_BEGIN: 'perform-begin',
  PERFORM_END: 'perform-end',
  PERFORM_SETTLED: 'perform-settled',
  SOCIAL_BEGIN: 'social-begin',
  SOCIAL_END: 'social-end',
  SOCIAL_SETTLED: 'social-settled',
  TRAIN_BEGIN: 'train-begin',
  TRAIN_END: 'train-end',
  TRAIN_SETTLED: 'train-settled',
  REQUISITION_BEGIN: 'requisition-begin',
  REQUISITION_END: 'requisition-end',
  REQUISITION_SETTLED: 'requisition-settled'
});

const MAX_PRESENTATION_MESSAGE_LENGTH = 8192;

/** One downtime presentation message the active GM broadcasts: the working banner, its close, or the results card. */
export function downtimePresentationMessage(event, data = {}) {
  if (!Object.values(DOWNTIME_PRESENTATION_EVENTS).includes(event)) {
    throw new TypeError(`Unknown downtime presentation event: ${event}`);
  }
  return Object.freeze({ kind: DOWNTIME_PRESENTATION_KIND, event, ...structuredClone(data) });
}

/** Accept only bounded downtime feedback at the presentation socket. */
export function isDowntimePresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== DOWNTIME_PRESENTATION_KIND) return false;
  if (!Object.values(DOWNTIME_PRESENTATION_EVENTS).includes(value.event)) return false;
  for (const key of ['stationTokenUuid', 'actorUuid', 'cursorTokenUuid', 'partnerTokenUuid', 'trainerTokenUuid',
    'traineeTokenUuid']) {
    if (value[key] !== undefined && !boundedText(String(value[key]), MAX_UUID_LENGTH)) return false;
  }
  if (!socialBeatBounded(value)) return false;
  if (value.method !== undefined && !GATHER_METHODS.includes(value.method)) return false;
  for (const key of ['items', 'materials', 'destinations', 'diners', 'supportRecipients', 'rankUps', 'performers',
    'listeners', 'bonuses']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > MAX_ITEMS) return false;
    if (value[key].some(entry => !boundedText(String(plainRecord(entry) ? entry.name ?? '' : entry), MAX_UUID_LENGTH))) {
      return false;
    }
  }
  try { return JSON.stringify(value).length <= MAX_PRESENTATION_MESSAGE_LENGTH; } catch { return false; }
}

const MAX_BEAT_TEXT = 1024;
const SOCIAL_CARD_TEXT = ['actorName', 'actorImage', 'partnerName', 'partnerImage', 'skillLabel'];
const SOCIAL_CARD_NUMBERS = ['avatarScale', 'partnerAvatarScale', 'firstTotal', 'secondTotal', 'supportGain'];
const TRAINING_CARD_TEXT = ['actorName', 'actorImage', 'traineeName', 'traineeImage', 'proficiencyLabel',
  'proficiencyIcon', 'trainerRankLabel', 'traineeRankLabel'];
const TRAINING_CARD_NUMBERS = ['avatarScale', 'traineeAvatarScale', 'roll', 'proficiencyExperience',
  'trainerLevelExperience', 'traineeLevelExperience', 'supportGain'];

/**
 * Check that socialize, training and performance messages have the shapes engine/downtime/resolvers.mjs builds and
 * DowntimePresentation reads: both Tokens on an opening message, a boolean on a closing one, the performance's track
 * flags, and every text and number a results card prints. Other downtime messages get only the shared checks.
 */
function socialBeatBounded(value) {
  const events = DOWNTIME_PRESENTATION_EVENTS;
  switch (value.event) {
    case events.PERFORM_BEGIN:
      return optionalFlag(value.trackPlaying);
    case events.PERFORM_END:
      return typeof value.success === 'boolean' && optionalFlag(value.trackPlaying)
        && optionalFlag(value.trackStopped);
    case events.SOCIAL_BEGIN:
      return Boolean(tokenUuid(value.cursorTokenUuid) && tokenUuid(value.partnerTokenUuid))
        && portraitBounded(value.left) && portraitBounded(value.right);
    case events.SOCIAL_END:
    case events.TRAIN_END:
      return typeof value.success === 'boolean';
    case events.SOCIAL_SETTLED:
      return cardFieldsBounded(value, SOCIAL_CARD_TEXT, SOCIAL_CARD_NUMBERS);
    case events.TRAIN_BEGIN:
      return sparBeatBounded(value);
    case events.TRAIN_SETTLED:
      return cardFieldsBounded(value, TRAINING_CARD_TEXT, TRAINING_CARD_NUMBERS)
        && WEAPON_PROFICIENCIES.includes(value.proficiencyKey) && typeof value.rankedUp === 'boolean'
        && (value.newRankLetter === null || value.newRankLetter === undefined || beatText(value.newRankLetter));
    default:
      return true;
  }
}

/** The spar's opening message: both Tokens, the proficiency, and a pass count and length within TRAINING_SPAR. */
function sparBeatBounded(value) {
  if (!tokenUuid(value.trainerTokenUuid) || !tokenUuid(value.traineeTokenUuid)) return false;
  if (!WEAPON_PROFICIENCIES.includes(value.proficiencyKey)) return false;
  if (!Number.isInteger(value.passes) || value.passes < 0 || value.passes > TRAINING_SPAR.passes) return false;
  if (!beatNumber(value.passDurationMs) || value.passDurationMs < 0 || value.passDurationMs > TRAINING_SPAR.maxPassMs) {
    return false;
  }
  if (value.animation === null) return true;
  if (!plainRecord(value.animation) || !validateAnimation(value.animation).valid) return false;
  try { return JSON.stringify(value.animation).length <= TRAINING_SPAR.maxAnimationLength; } catch { return false; }
}

function portraitBounded(record) {
  return plainRecord(record) && exactKeys(record, ['name', 'image', 'avatarScale'])
    && beatText(record.name) && beatText(record.image) && beatNumber(record.avatarScale);
}

function cardFieldsBounded(value, textKeys, numberKeys) {
  return textKeys.every(key => beatText(value[key])) && numberKeys.every(key => beatNumber(value[key]));
}

/** A card string: empty, or bounded and free of control characters. */
function beatText(value) {
  return value === '' || boundedText(value, MAX_BEAT_TEXT);
}

function beatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalFlag(value) {
  return value === undefined || typeof value === 'boolean';
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
function actorUuid(value) {
  const uuid = String(value ?? '');
  if (!boundedText(uuid, MAX_UUID_LENGTH)) return '';
  return uuid.startsWith('Actor.') || uuid.includes('.Actor.') ? uuid : '';
}

function tokenUuid(value) {
  const uuid = String(value ?? '');
  return boundedText(uuid, MAX_UUID_LENGTH) && uuid.includes('.Token.') ? uuid : '';
}

function itemUuid(value) {
  const uuid = String(value ?? '');
  if (!boundedText(uuid, MAX_UUID_LENGTH)) return '';
  return uuid.startsWith('Item.') || uuid.includes('.Item.') ? uuid : '';
}

function embeddedItemUuid(value) {
  const uuid = itemUuid(value);
  return uuid.includes('.Item.') && !uuid.startsWith('Compendium.') ? uuid : '';
}
