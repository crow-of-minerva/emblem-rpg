/** @layer lib/core */

/* -------------------------------------------- */
/*  Type Guards                                 */
/* -------------------------------------------- */

/**
 * Whether a value is a plain object: not null, not an array and not a class instance. It's written as a type
 * predicate, so a caller that checks it can read properties off the value afterwards without casting.
 * @param {*} v
 * @returns {v is Record<string, any>}
 */
export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

/* -------------------------------------------- */
/*  Numbers                                     */
/* -------------------------------------------- */

/** A value read as a finite number, or the fallback when it is not one. */
export function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A value read as a whole number at or above zero. */
export function whole(value) {
  return Math.max(0, Math.floor(finite(value)));
}

/** A value held inside an inclusive range. */
export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** A value snapped to the nearest half point, which is the resolution stance is measured in. */
export function roundToHalf(value) {
  return Math.round(Math.max(0, finite(value)) * 2) / 2;
}

/** An authored `#rrggbb` colour as the integer PIXI wants, or the fallback. */
export function hexColor(value, fallback = 0) {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value.replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* -------------------------------------------- */
/*  Collections                                 */
/* -------------------------------------------- */

/**
 * Read any array, keyed collection or iterable as a plain array.
 *
 * Foundry collections arrive in several shapes depending on which API returned them, and every reader wants the
 * same array. A value that's none of them reads as empty rather than throwing.
 * @param {*} collection
 * @returns {Array<any>}
 */
export function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (collection.contents !== undefined) return Array.from(collection.contents);
  if (typeof collection.values === 'function') return [...collection.values()];
  return typeof collection[Symbol.iterator] === 'function' ? [...collection] : [];
}

/* -------------------------------------------- */
/*  Digests                                     */
/* -------------------------------------------- */

/** JSON with every object's keys in sorted order, so equal values always print the same text. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** A short, stable hexadecimal digest of a string, for fingerprints that must stay within message bounds. */
export function digest(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */

/** Resolve after a number of milliseconds. */
export function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

/**
 * Poll a predicate until it holds or the timeout expires.
 * @param {() => boolean} predicate Condition to wait for.
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 * @returns {Promise<boolean>} Whether the predicate held before the timeout.
 */
export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

/* -------------------------------------------- */
/*  Structural equality                         */
/* -------------------------------------------- */

/**
 * Whether two plain values hold the same data, whatever their key order. Functions and class instances compare by
 * identity.
 */
export function structurallyEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => structurallyEqual(entry, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return Number.isNaN(a) && Number.isNaN(b);
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]));
}

/**
 * Every leaf dot-path a document update names, so an expanded and a dotted change read the same. An empty object is a
 * leaf, because it still says the field was written.
 */
export function changeLeafPaths(changes, prefix = '') {
  if (!isPlainObject(changes)) return prefix ? [prefix] : [];
  const keys = Object.keys(changes);
  if (!keys.length) return prefix ? [prefix] : [];
  return keys.flatMap(key => changeLeafPaths(changes[key], prefix ? `${prefix}.${key}` : key));
}
