/** @layer game/downtime */

/* -------------------------------------------- */
/*  Built-in entries                            */
/* -------------------------------------------- */
/** The id prefix every shipped entry carries, so a world's own entry never takes a built-in's id. */
const BUILTIN_PREFIX = 'builtin-';

/**
 * The id a shipped cookbook or songbook entry is stored under: its authored id, or a slug of its name when it has
 * none, carrying the built-in prefix once.
 */
export function builtinId(authoredId, name) {
  const authored = String(authoredId ?? '').trim() || slug(name);
  return authored.startsWith(BUILTIN_PREFIX) ? authored : BUILTIN_PREFIX + authored;
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The built-in entries a library no longer holds, matched by id, so a library window can offer to restore them. */
export function missingBuiltins(entries = [], builtins = []) {
  const present = new Set(entries.map(entry => entry.id));
  return builtins.filter(entry => !present.has(entry.id));
}

/**
 * The library with every missing built-in put back at the front, each normalised into a fresh copy, or the same
 * list when nothing is missing.
 */
export function withBuiltinsRestored(entries = [], builtins = [], normalize) {
  const missing = missingBuiltins(entries, builtins);
  if (!missing.length) return entries;
  return [...missing.map(entry => normalize(entry, entry.id)), ...entries];
}

/* -------------------------------------------- */
/*  Library rules                               */
/* -------------------------------------------- */
/**
 * The rules a world library of recipes or songs follows, bound to one kind of entry. The shipped book holds the
 * built-ins. The world's `json/` file holds only its changes: its own entries and the built-ins it edited under
 * `key`, and the ids of the built-ins it removed under `removed`. cooking.mjs and performance.mjs each define theirs.
 * @param {object} library
 * @param {string} library.key The list's key in the world's changes and the library views: `recipes` or `songs`.
 * @param {string} library.fallbackPrefix A stored entry without an id takes this prefix and its index.
 * @param {(raw: object, fallbackId: string) => object} library.normalize Coerces one stored entry.
 * @param {(entry: object) => string} library.signature Two entries with the same signature are the same edit.
 */
export function defineLibrary({ key, fallbackPrefix, normalize, signature }) {
  const normalizeEntries = (stored = []) => (Array.isArray(stored) ? stored : [])
    .map((entry, index) => normalize(entry, `${fallbackPrefix}-${index}`));
  return Object.freeze({
    /**
     * Every stored entry normalised, each keeping its own id so a unit's link to it holds. An entry with no id gets
     * `<fallbackPrefix>-<index>`, which shifts if the list changes.
     */
    normalizeEntries,

    /** A world's stored changes, coerced: its entries normalised and the built-ins it removed as distinct ids. */
    normalizeChanges(raw) {
      const removed = Array.isArray(raw?.removed) ? raw.removed : [];
      return {
        [key]: normalizeEntries(raw?.[key]),
        removed: [...new Set(removed.map(id => String(id ?? '')).filter(Boolean))]
      };
    },

    /** The library in force: the built-ins it kept, each as the world edited it, then the world's own entries. */
    resolve(builtins = [], changes = {}) {
      const removed = new Set(changes.removed ?? []);
      const own = changes[key] ?? [];
      const edited = new Map(own.map(entry => [entry.id, entry]));
      const shipped = new Set(builtins.map(entry => entry.id));
      return [
        ...builtins.filter(entry => !removed.has(entry.id)).map(entry => edited.get(entry.id) ?? entry),
        ...own.filter(entry => !shipped.has(entry.id) && !removed.has(entry.id))
      ];
    },

    /** What is saved for a whole library: new and edited entries, and removals. */
    planChanges(builtins = [], entries = []) {
      const shipped = new Map(builtins.map(entry => [entry.id, entry]));
      const kept = new Set(entries.map(entry => entry.id));
      return {
        [key]: entries.filter(entry => !shipped.has(entry.id)
          || signature(entry) !== signature(shipped.get(entry.id))),
        removed: builtins.filter(entry => !kept.has(entry.id)).map(entry => entry.id)
      };
    },

    /** What a unit may use: every Default entry plus the Personal ones linked to it, in library order. */
    known(library, knownIds) {
      const known = new Set(knownIds ?? []);
      return (library ?? []).filter(entry => entry.isDefault || known.has(entry.id));
    }
  });
}
