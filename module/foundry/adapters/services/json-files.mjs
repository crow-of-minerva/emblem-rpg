/** @layer foundry/adapters/services */
import { builtinAffinityTable, parseAffinityDefinition } from '../../../game/support/affinities.mjs';
import {
  activationExperienceKey,
  parseActivationExperienceTable
} from '../../../game/progression/activation-experience.mjs';
import { normalizeRecipeChanges, parseCookbook } from '../../../game/downtime/cooking.mjs';
import { normalizeSongChanges, parseSongbook } from '../../../game/downtime/performance.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { isActiveGm } from './host.mjs';
import { reportFoundryError, reportFoundryNotice, reportFoundryValidation } from './diagnostics.mjs';

const JSON_FOLDER = 'json';
const AFFINITIES_FILE = 'affinities.json';
const ACTIVATION_EXPERIENCE_FILE = 'exp-data.json';
const RECIPES_FILE = 'recipes.json';
const SONGS_FILE = 'songs.json';
const TERRAIN_FILE = 'terrain.json';
const FALLBACK_TERRAIN_ICON = 'icons/svg/hazard.svg';

/* -------------------------------------------- */
/*  System data files                           */
/* -------------------------------------------- */
/**
 * Read one shipped `json/` file, or null where no page context exists to resolve the system path against.
 * An `optional` file the system does not ship also returns null instead of throwing.
 */
export async function readSystemJson(fileName, { optional = false } = {}) {
  const response = await fetchSystemFile(fileName, { optional });
  return response ? response.json() : null;
}

async function fetchSystemFile(fileName, { optional = false } = {}) {
  // Resolved against the page URL, so a Foundry route prefix (such as /foundry/) is kept.
  const origin = globalThis.location?.href ?? '';
  if (!origin) return null;
  const response = await fetch(new URL(`systems/${SYSTEM_ID}/${JSON_FOLDER}/${fileName}`, origin));
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`${fileName} responded ${response.status}`);
  return response;
}

/* -------------------------------------------- */
/*  World data files                            */
/* -------------------------------------------- */
const WORLD_FILE_SEEDS = Object.freeze([
  [AFFINITIES_FILE, () => shippedFileText(AFFINITIES_FILE)],
  [ACTIVATION_EXPERIENCE_FILE, () => shippedFileText(ACTIVATION_EXPERIENCE_FILE, { optional: true })],
  [RECIPES_FILE, async () => worldJsonText(normalizeRecipeChanges(null))],
  [SONGS_FILE, async () => worldJsonText(normalizeSongChanges(null))],
  [TERRAIN_FILE, async () => worldJsonText({ presets: [] })]
]);
const readyWorldFolders = new Map();

/**
 * On the host client, give the world any `json/` file it lacks: blank recipes, songs and terrain, and copies of the
 * shipped affinities and activation XP table. Once copied, the world file is the one read, so later changes to the
 * shipped affinities or XP table don't reach this world unless its copy is deleted.
 */
export async function ensureWorldJsonFiles() {
  if (!isActiveGm() || !worldJsonFolder()) return [];
  let present;
  try {
    await worldJsonFolderReady();
    present = new Set(await worldJsonFileNames());
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not prepare the world's json folder.`);
    return [];
  }
  const created = [];
  for (const [fileName, seed] of WORLD_FILE_SEEDS) {
    if (present.has(fileName)) continue;
    try {
      const text = await seed();
      if (text === null) continue;
      await uploadWorldFile(fileName, text);
      created.push(fileName);
    } catch (error) {
      reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not create ${worldJsonFolder()}/${fileName}.`);
    }
  }
  return created;
}

/** A shipped file's text for a world copy, or null to seed nothing when the system ships no optional file. */
async function shippedFileText(fileName, { optional = false } = {}) {
  const response = await fetchSystemFile(fileName, { optional });
  return response ? response.text() : null;
}

/** The world's own `json/` folder beside its `world.json`, or an empty string outside a world. */
function worldJsonFolder() {
  const worldId = String(globalThis.game?.world?.id ?? '');
  return worldId ? `worlds/${worldId}/${JSON_FOLDER}` : '';
}

/** Read one of the world's `json/` files past the browser cache, or null when the page, world or file is missing. */
async function readWorldJson(fileName) {
  const response = await fetchWorldFile(fileName);
  return response ? response.json() : null;
}

/** The same read as readWorldJson, as the file's raw text. */
async function readWorldText(fileName) {
  const response = await fetchWorldFile(fileName);
  return response ? response.text() : null;
}

async function fetchWorldFile(fileName) {
  // Resolved against the page URL, like fetchSystemFile, so a route prefix is kept.
  const origin = globalThis.location?.href ?? '';
  const folder = worldJsonFolder();
  if (!origin || !folder) return null;
  const response = await fetch(new URL(`${folder}/${fileName}`, origin), { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${folder}/${fileName} responded ${response.status}`);
  return response;
}

/** Replace one of the world's `json/` files whole, creating the folder first when the world has none yet. */
async function writeWorldJson(fileName, data) {
  await worldJsonFolderReady();
  await uploadWorldFile(fileName, worldJsonText(data));
}

function worldJsonText(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function worldJsonFolderReady() {
  const folder = worldJsonFolder();
  if (!readyWorldFolders.has(folder)) {
    readyWorldFolders.set(folder, createWorldJsonFolder(folder).catch(error => {
      readyWorldFolders.delete(folder);
      throw error;
    }));
  }
  return readyWorldFolders.get(folder);
}

async function createWorldJsonFolder(folder) {
  if (!folder) throw new Error('No world is loaded to hold a json folder');
  const picker = filePicker();
  const listing = await picker.browse('data', folder.slice(0, folder.lastIndexOf('/')));
  if ((listing?.dirs ?? []).some(dir => String(dir).split('/').pop() === JSON_FOLDER)) return true;
  await picker.createDirectory('data', folder, {});
  return true;
}

async function worldJsonFileNames() {
  const listing = await filePicker().browse('data', worldJsonFolder());
  return (listing?.files ?? []).map(file => decodeURIComponent(String(file).split('/').pop()));
}

async function uploadWorldFile(fileName, text) {
  const folder = worldJsonFolder();
  const file = new File([text], fileName, { type: 'application/json' });
  const response = await filePicker().upload('data', folder, file, {}, { notify: false });
  if (!response?.path) throw new Error(`${folder}/${fileName} could not be written`);
}

function filePicker() {
  const picker = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
  if (!picker) throw new Error('The FilePicker is unavailable');
  return picker;
}

/* -------------------------------------------- */
/*  Affinity table                              */
/* -------------------------------------------- */
let affinityCache = installAffinityTable(builtinAffinityTable());
let pendingAffinityLoad = null;

/** The affinity table in force, for the rules and sheets that read it during a synchronous render. */
export function currentAffinityTable() {
  return affinityCache;
}

/** Await the affinity table, starting the world-file read if nothing has yet. */
export async function affinityTableReady() {
  if (!pendingAffinityLoad) pendingAffinityLoad = readAffinityFile();
  return pendingAffinityLoad;
}

async function readAffinityFile() {
  const sources = [
    {
      label: `${worldJsonFolder()}/${AFFINITIES_FILE}`, fallback: 'the shipped affinities',
      read: () => readWorldJson(AFFINITIES_FILE)
    },
    {
      label: `${JSON_FOLDER}/${AFFINITIES_FILE}`, fallback: 'the built-in affinities',
      read: () => readSystemJson(AFFINITIES_FILE)
    }
  ];
  for (const source of sources) {
    const parsed = await readTableSource(source, parseAffinityDefinition);
    if (parsed) {
      affinityCache = installAffinityTable(parsed);
      return affinityCache;
    }
  }
  affinityCache = installAffinityTable(builtinAffinityTable());
  return affinityCache;
}

/**
 * Read and parse one candidate file of a table that falls back file by file. A file that can't be fetched or isn't
 * valid JSON is reported as unreadable, and one the table parser rejects as malformed. Either returns null, so the
 * caller moves on to the next file. A missing file returns null quietly. The parsed table's validation warnings are
 * shown here as warning notifications, and its `notices`, when it has any, go to the console only.
 */
async function readTableSource({ label, fallback, read }, parse) {
  let payload = null;
  try {
    payload = await read();
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not read ${label}. Using ${fallback}.`);
    return null;
  }
  if (payload === null) return null;
  try {
    const parsed = parse(payload);
    for (const warning of parsed.warnings) reportFoundryValidation(import.meta.url, null, warning);
    for (const notice of parsed.notices ?? []) reportFoundryNotice(import.meta.url, notice, `Read ${label}`);
    return parsed;
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | ${label} is malformed. Using ${fallback}.`);
    return null;
  }
}

function installAffinityTable({ registry, statLabels }) {
  for (const entry of Object.values(registry)) {
    for (const byRank of Object.values(entry.stats)) Object.freeze(byRank);
    Object.freeze(entry.stats);
    Object.freeze(entry);
  }
  return Object.freeze({ registry: Object.freeze(registry), statLabels: Object.freeze(statLabels) });
}

/* -------------------------------------------- */
/*  Activation XP table                         */
/* -------------------------------------------- */
let activationExperienceCache = installActivationExperienceTable(new Map());
let pendingActivationExperienceLoad = null;

/** The activation XP table in force, empty until the files have been read. */
export function currentActivationExperienceTable() {
  return activationExperienceCache;
}

/**
 * The activation XP entry for an activated Item's name, matched trimmed and case-insensitive, or null when the Item
 * earns no activation XP.
 */
export function activationExperienceEntry(itemName) {
  return activationExperienceCache.entries.get(activationExperienceKey(itemName)) ?? null;
}

/**
 * Await the activation XP table, starting the read if nothing has yet. The world's `json/exp-data.json` replaces
 * the shipped table entirely. The shipped file is the fallback, and with neither, no activation earns XP.
 */
export async function activationExperienceTableReady() {
  if (!pendingActivationExperienceLoad) pendingActivationExperienceLoad = readActivationExperienceFile();
  return pendingActivationExperienceLoad;
}

async function readActivationExperienceFile() {
  const sources = [
    {
      label: `${worldJsonFolder()}/${ACTIVATION_EXPERIENCE_FILE}`, fallback: 'the shipped activation XP table',
      read: () => readWorldText(ACTIVATION_EXPERIENCE_FILE)
    },
    {
      label: `${JSON_FOLDER}/${ACTIVATION_EXPERIENCE_FILE}`, fallback: 'no activation XP',
      read: () => shippedFileText(ACTIVATION_EXPERIENCE_FILE, { optional: true })
    }
  ];
  for (const source of sources) {
    const parsed = await readTableSource(source, parseActivationExperienceText);
    if (parsed) {
      activationExperienceCache = installActivationExperienceTable(parsed.entries);
      return activationExperienceCache;
    }
  }
  activationExperienceCache = installActivationExperienceTable(new Map());
  return activationExperienceCache;
}

/**
 * Parse the table from the file's text in source order. JSON.parse keeps only the last copy of a repeated key, in
 * the first copy's place, and puts integer-like keys first, so the `items` members are read again from the text for
 * parseActivationExperienceTable. If that scan fails, the parsed object's own order is used instead.
 */
function parseActivationExperienceText(text) {
  const payload = JSON.parse(text);
  let itemPairs = null;
  try {
    itemPairs = orderedItemPairs(text);
  } catch (error) {
    reportFoundryNotice(import.meta.url, error, 'Scan the activation XP table in source order');
  }
  return parseActivationExperienceTable(payload, itemPairs);
}

function installActivationExperienceTable(entries) {
  for (const entry of entries.values()) Object.freeze(entry);
  return Object.freeze({ entries });
}

/**
 * The members of the top-level `items` object, as `[key, value]` pairs in the order the text writes them, repeated
 * keys included, from JSON text that JSON.parse has already accepted. Keys are decoded with their escapes, as
 * JSON.parse decodes them. When `items` appears twice, only the last copy counts, as for JSON.parse; null when that
 * copy is not an object. Nested values are skipped with a depth count, never by recursion, so no nesting depth can
 * exhaust the stack.
 */
function orderedItemPairs(text) {
  let index = 0;
  const skipSpace = () => {
    while (' \t\n\r'.includes(text[index]) && index < text.length) index += 1;
  };
  const skipString = () => {
    index += 1;
    while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    index += 1;
  };
  const skipValue = () => {
    if (text[index] === '"') return skipString();
    if (text[index] !== '{' && text[index] !== '[') {
      while (index < text.length && !',}] \t\n\r'.includes(text[index])) index += 1;
      return undefined;
    }
    let depth = 0;
    do {
      const character = text[index];
      if (character === '"') {
        skipString();
        continue;
      }
      if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;
      index += 1;
    } while (depth > 0);
    return undefined;
  };
  const eachMember = visit => {
    index += 1;
    skipSpace();
    if (text[index] === '}') return void (index += 1);
    for (;;) {
      skipSpace();
      const keyStart = index;
      skipString();
      const key = JSON.parse(text.slice(keyStart, index));
      skipSpace();
      index += 1;
      skipSpace();
      visit(key);
      skipSpace();
      if (text[index++] === '}') return;
    }
  };

  let pairs = null;
  skipSpace();
  if (text[index] !== '{') return null;
  eachMember(key => {
    if (key !== 'items') return skipValue();
    if (text[index] !== '{') {
      pairs = null;
      return skipValue();
    }
    const found = [];
    eachMember(itemKey => {
      const valueStart = index;
      skipValue();
      found.push([itemKey, JSON.parse(text.slice(valueStart, index))]);
    });
    pairs = found;
    return undefined;
  });
  return pairs;
}

/* -------------------------------------------- */
/*  Terrain presets                             */
/* -------------------------------------------- */
let defaultPresetCache = { presets: [] };

/** Read shipped terrain presets from the system data file. */
export async function readDefaultTerrainPresets() {
  try {
    const data = await readSystemJson(TERRAIN_FILE);
    if (data) defaultPresetCache = normalizePresetFile(data);
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not read the shipped terrain presets.`);
  }
  return structuredClone(defaultPresetCache);
}

/** Read the terrain presets the world saved in its own `json/terrain.json`. */
export async function readCustomTerrainPresets() {
  try {
    return await readWorldPresets();
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not read the world's terrain presets.`);
    return [];
  }
}

/** Save or replace one world terrain preset, returning whether the world's file was written. */
export async function saveCustomTerrainPreset(name, icon, params) {
  try {
    const presets = await readWorldPresets();
    const preset = { name, icon: String(icon || FALLBACK_TERRAIN_ICON), params: structuredClone(params ?? {}) };
    const index = presets.findIndex(entry => entry.name === name);
    if (index >= 0) presets[index] = preset;
    else presets.push(preset);
    await writeWorldJson(TERRAIN_FILE, { presets });
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not save the terrain preset "${name}".`);
    return false;
  }
}

/** Delete one world terrain preset, returning whether the world's file was written. */
export async function deleteCustomTerrainPreset(name) {
  try {
    const presets = await readWorldPresets();
    await writeWorldJson(TERRAIN_FILE, { presets: presets.filter(entry => entry.name !== name) });
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not delete the terrain preset "${name}".`);
    return false;
  }
}

async function readWorldPresets() {
  const raw = await readWorldJson(TERRAIN_FILE);
  return presetEntries(raw).map(entry => ({
    name: String(entry.name),
    icon: String(entry.icon || FALLBACK_TERRAIN_ICON),
    params: structuredClone(entry.params)
  }));
}

function normalizePresetFile(raw) {
  return {
    presets: presetEntries(raw).map(entry => ({
      name: String(entry.name),
      icon: String(entry.icon || FALLBACK_TERRAIN_ICON),
      params: structuredClone(entry.params)
    })),
  };
}

function presetEntries(raw) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.presets) ? raw.presets : [];
  return source.filter(entry => entry?.name && entry?.params && typeof entry.params === 'object');
}

/* -------------------------------------------- */
/*  Recipe and song libraries                   */
/* -------------------------------------------- */
/**
 * The recipe library: the shipped cookbook `json/recipes.json` and the world's changes to it in its own
 * `json/recipes.json`. It is reloaded when another client saves.
 */
export const {
  bookReady: cookbookReady,
  currentBook: currentCookbook,
  libraryReady: recipeLibraryReady,
  reload: reloadRecipeLibrary,
  currentChanges: currentRecipeChanges,
  writeChanges: writeRecipeChanges
} = libraryFiles({
  fileName: RECIPES_FILE, key: 'recipes', book: 'cookbook', parse: parseCookbook, normalize: normalizeRecipeChanges
});

/** The song library: the shipped songbook `json/songs.json` and the world's changes to it, served the same way. */
export const {
  bookReady: songbookReady,
  currentBook: currentSongbook,
  libraryReady: songLibraryReady,
  reload: reloadSongLibrary,
  currentChanges: currentSongChanges,
  writeChanges: writeSongChanges
} = libraryFiles({
  fileName: SONGS_FILE, key: 'songs', book: 'songbook', parse: parseSongbook, normalize: normalizeSongChanges
});

/**
 * One library's files. The shipped book is read once and holds the built-ins under `key`, with `loaded` false
 * until it has been read. The world's file holds only its changes, normalised and frozen, with `loaded` false when
 * it could not be read, and then it is never overwritten.
 * @param {object} library
 * @param {string} library.fileName The book's and the world file's name under each `json/` folder.
 * @param {string} library.key The entry list's key, `recipes` or `songs`.
 * @param {string} library.book The book's name in reports: `cookbook` or `songbook`.
 * @param {Function} library.parse Reads the shipped book into `{[key], warnings}`.
 * @param {Function} library.normalize Coerces the world's stored changes.
 */
function libraryFiles({ fileName, key, book, parse, normalize }) {
  let bookCache = null;
  let pendingBookLoad = null;
  let changes = freezeChanges(normalize(null), true);
  let pendingChangesLoad = null;

  /** Await the shipped book, starting the read if nothing has yet. An unreadable file gives `loaded: false`. */
  async function bookReady() {
    if (!pendingBookLoad) pendingBookLoad = readBook();
    return pendingBookLoad;
  }

  /** The shipped book in force, empty until it has been read. */
  function currentBook() {
    return bookCache ?? Object.freeze({ [key]: Object.freeze([]), loaded: false });
  }

  /** Await the shipped book and the world's file, then return the world's changes to the book. */
  async function libraryReady() {
    pendingChangesLoad ??= readChanges();
    await Promise.all([bookReady(), pendingChangesLoad]);
    return changes;
  }

  /** Re-read the world's file to pick up a library another client saved. */
  async function reload() {
    pendingChangesLoad = readChanges();
    return libraryReady();
  }

  /** The world's changes to the book: its own entries and edited built-ins, and the built-ins it removed. */
  function currentChanges() {
    return changes;
  }

  /**
   * Replace the world's file. It throws instead while the file on disk could not be read, so a file this client
   * never saw is never overwritten.
   */
  async function writeChanges(next) {
    await libraryReady();
    if (changes.loaded !== true) {
      throw new Error(`${worldJsonFolder()}/${fileName} could not be read; it was left untouched`);
    }
    const normalized = normalize(next);
    await writeWorldJson(fileName, normalized);
    changes = freezeChanges(normalized, true);
    pendingChangesLoad = Promise.resolve(changes);
    return changes;
  }

  async function readBook() {
    try {
      const payload = await readSystemJson(fileName);
      const parsed = parse(payload);
      for (const warning of parsed.warnings) reportFoundryValidation(import.meta.url, null, warning);
      bookCache = Object.freeze({ [key]: parsed[key], loaded: payload !== null });
    } catch (error) {
      reportFoundryError(import.meta.url, error,
        `${SYSTEM_ID} | Could not read the ${book}. No built-in ${key} are available.`);
      bookCache = Object.freeze({ [key]: Object.freeze([]), loaded: false });
    }
    return bookCache;
  }

  async function readChanges() {
    try {
      changes = freezeChanges(normalize(await readWorldJson(fileName)), true);
    } catch (error) {
      reportFoundryError(import.meta.url, error,
        `${SYSTEM_ID} | Could not read the world's ${key}. Only the shipped ${book} is offered.`);
      changes = freezeChanges(normalize(null), false);
    }
    return changes;
  }

  function freezeChanges(stored, loaded) {
    return Object.freeze({
      [key]: Object.freeze(stored[key].map(entry => Object.freeze(entry))),
      removed: Object.freeze([...stored.removed]),
      loaded
    });
  }

  return Object.freeze({ bookReady, currentBook, libraryReady, reload, currentChanges, writeChanges });
}
