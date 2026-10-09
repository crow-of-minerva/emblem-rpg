/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { placeOf, say } from './messages.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

/** What the placement's distance range is measured from. */
export const GEOMETRY_ANCHORS = Object.freeze(['target', 'self', 'targetLocation']);

/**
 * Which token the spec places. `custom` places a hypothetical footprint, used for "is there an open square"
 * gates that move nothing.
 */
export const GEOMETRY_MOVERS = Object.freeze(['self', 'target', 'custom']);

/** Distance metrics. `emblem` is the system's own token distance, and `king` is Chebyshev distance. */
export const GEOMETRY_METRICS = Object.freeze(['emblem', 'king']);

/** Whether the mover must be able to walk to the square or may appear there. */
export const GEOMETRY_REACHES = Object.freeze(['path', 'teleport']);

/** Where a `path` reach draws its movement budget from. */
export const GEOMETRY_BUDGET_SOURCES = Object.freeze(['rng', 'mvmt', 'custom', 'none']);

/** Whether a candidate square must sit at the anchor's elevation. */
export const GEOMETRY_ELEVATION_RULES = Object.freeze(['any', 'matchAnchor']);

/** How one square is chosen when several qualify. Only effect steps pick, and requirements just count. */
export const GEOMETRY_PICKS = Object.freeze(['nearest', 'farthest', 'random', 'prompt']);

/** Largest custom footprint side the editor accepts, matching the largest supported token size. */
export const MAX_FOOTPRINT_SIDE = 3;

/** Largest distance the editor accepts, which bounds how many placements are tried. */
export const MAX_GEOMETRY_DISTANCE = 30;

/* -------------------------------------------- */
/*  Factory Methods                             */
/* -------------------------------------------- */

/**
 * Build a geometry spec at its defaults: land adjacent to the target, on foot, within item range.
 * @param {object} [overrides={}]  Fields to replace on the default spec.
 * @returns {object}
 */
export function defaultGeometry(overrides = {}) {
  return {
    anchor: 'target',
    mover: 'self',
    moverWidth: 1,
    moverHeight: 1,
    minDistance: 1,
    maxDistance: 1,
    metric: 'emblem',
    reach: 'path',
    budgetSource: 'rng',
    budgetValue: '',
    elevation: 'any',
    lineOfSight: false,
    minCount: 1,
    pick: 'nearest',
    ...overrides
  };
}

/* -------------------------------------------- */
/*  Normalization                               */
/* -------------------------------------------- */

/** Coerce a value to a whole number from `min` to `max`, or `fallback` when it isn't a finite number. */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Coerce stored data into a complete, in-range spec. Every consumer normalizes before use, so a half-authored or
 * hand-edited spec still resolves rather than throwing.
 */
export function normalizeGeometry(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const base = defaultGeometry();
  const minDistance = clampInt(src.minDistance, 1, MAX_GEOMETRY_DISTANCE, base.minDistance);
  const maxDistance = Math.max(minDistance, clampInt(src.maxDistance, 1, MAX_GEOMETRY_DISTANCE, minDistance));
  return {
    anchor: pickEnum(src.anchor, GEOMETRY_ANCHORS, base.anchor),
    mover: pickEnum(src.mover, GEOMETRY_MOVERS, base.mover),
    moverWidth: clampInt(src.moverWidth, 1, MAX_FOOTPRINT_SIDE, 1),
    moverHeight: clampInt(src.moverHeight, 1, MAX_FOOTPRINT_SIDE, 1),
    minDistance,
    maxDistance,
    metric: pickEnum(src.metric, GEOMETRY_METRICS, base.metric),
    reach: pickEnum(src.reach, GEOMETRY_REACHES, base.reach),
    budgetSource: pickEnum(src.budgetSource, GEOMETRY_BUDGET_SOURCES, base.budgetSource),
    budgetValue: numericBudget(src.budgetValue),
    elevation: pickEnum(src.elevation, GEOMETRY_ELEVATION_RULES, base.elevation),
    lineOfSight: src.lineOfSight === true,
    minCount: clampInt(src.minCount, 1, 99, 1),
    pick: pickEnum(src.pick, GEOMETRY_PICKS, base.pick)
  };
}

/**
 * A custom budget is a count of squares. A finite number stays, a numeric string becomes that number, and anything
 * else clears to '' so the editor shows an empty amount and validation asks for one.
 */
function numericBudget(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return '';
}

/** `value` when it's one of `allowed`, otherwise `fallback`. */
function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Validate a stored geometry spec, reporting authoring mistakes the editor should surface. Requirements and
 * effect steps use different subsets of the spec, so `context` decides which fields are checked.
 * @param {*} raw                                Stored geometry data.
 * @param {object} [opts={}]
 * @param {'requirement'|'step'} [opts.context='requirement']    Where the spec is used.
 * @param {string} [opts.path='geometry']        Where the spec sits, which names the step or requirement in each
 *                                               message.
 * @returns {string[]}                           Collected error sentences, empty when valid.
 */
export function validateGeometry(raw, { context = 'requirement', path = 'geometry' } = {}) {
  const place = placeOf(path, context === 'step' ? 'this step' : 'this requirement');
  const errors = [];
  const fail = sentence => errors.push(say(place, sentence));
  if (!isPlainObject(raw)) return [say(place, 'has placement settings that cannot be read')];
  const g = raw;
  if (!GEOMETRY_ANCHORS.includes(g.anchor)) fail('is anchored on something the system does not know');
  if (context === 'requirement') {
    if (!GEOMETRY_MOVERS.includes(g.mover)) fail('places a token the system does not know');
    if (g.mover === 'custom') {
      for (const k of ['moverWidth', 'moverHeight']) {
        const n = Number(g[k]);
        if (!Number.isInteger(n) || n < 1 || n > MAX_FOOTPRINT_SIDE) {
          fail(`needs a footprint ${k === 'moverWidth' ? 'width' : 'height'} from 1 to ${MAX_FOOTPRINT_SIDE} squares`);
        }
      }
    }
    if (g.minCount !== undefined) {
      const n = Number(g.minCount);
      if (!Number.isInteger(n) || n < 1) fail('needs a count of 1 or more');
    }
  }
  const minD = Number(g.minDistance);
  const maxD = Number(g.maxDistance);
  if (!Number.isInteger(minD) || minD < 1) fail('needs a minimum distance that is a whole number, 1 or more');
  if (!Number.isInteger(maxD) || maxD < 1) fail('needs a maximum distance that is a whole number, 1 or more');
  if (Number.isInteger(minD) && Number.isInteger(maxD) && maxD < minD) {
    fail('has a maximum distance below its minimum distance');
  }
  if (!GEOMETRY_METRICS.includes(g.metric)) fail('measures distance in a way the system does not know');
  if (!GEOMETRY_REACHES.includes(g.reach)) fail('reaches its square in a way the system does not know');
  if (g.reach === 'path') {
    if (!GEOMETRY_BUDGET_SOURCES.includes(g.budgetSource)) {
      fail('takes its movement budget from a source the system does not know');
    }
    if (g.budgetSource === 'custom') {
      const v = g.budgetValue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('needs a custom budget of 0 squares or more');
    }
  }
  if (g.elevation !== undefined && !GEOMETRY_ELEVATION_RULES.includes(g.elevation)) {
    fail('has an elevation rule the system does not know');
  }
  if (g.lineOfSight !== undefined && typeof g.lineOfSight !== 'boolean') {
    fail('has a line of sight setting that is not on or off');
  }
  if (context === 'step' && g.pick !== undefined && !GEOMETRY_PICKS.includes(g.pick)) {
    fail('picks its square in a way the system does not know');
  }
  return errors;
}

/* -------------------------------------------- */
/*  Effect integration                          */
/* -------------------------------------------- */

/**
 * Find the step whose placement promptGeometryPlacement (ui/controls/targeting.mjs) asks for before the item is
 * confirmed: the first top-level moveToken step using terrainGeometry with the `prompt` pick, in an `onActivation`
 * entry. Steps inside `if` branches are skipped, because effect execution hasn't evaluated their conditions yet.
 * @param {any[]} entries The Item's authored `effects`.
 * @returns {{entryIndex: number, stepIndex: number, step: object}|null}
 */
export function findPromptGeometryStep(entries) {
  if (!Array.isArray(entries)) return null;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (!isPlainObject(entry)) continue;
    if (entry.trigger !== 'onActivation') continue;
    const steps = entry.action?.steps;
    if (!Array.isArray(steps)) continue;
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      if (!isPlainObject(step)) continue;
      if (step.kind !== 'moveToken' || step.mode !== 'terrainGeometry') continue;
      if (step.geometry?.pick !== 'prompt') continue;
      return { entryIndex, stepIndex, step };
    }
  }
  return null;
}
