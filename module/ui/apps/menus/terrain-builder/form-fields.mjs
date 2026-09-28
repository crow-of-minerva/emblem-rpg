/** @layer ui/apps/menus/terrain-builder */
import { CROSSING_DC_MULT_DEFAULT, CROSSING_DIRECTIONS } from '../../../../contracts/domains/terrain.mjs';

/* -------------------------------------------- */
/*  Field vocabulary                            */
/* -------------------------------------------- */

/**
 * One authored per-square field of the Terrain Builder.
 *
 * - `name` is the control's `name=` attribute in `templates/editors/terrain-builder.hbs` and the key the template
 *   reads from its `fields` context. Adding a field means one entry here plus its markup, nothing else.
 * - `kind` says how the control is read and written: `number`, `text`, `select`, `color`, `checkbox` or `list`.
 * - `value` is the authored default, used for a blank control, a preset that omits the field and a selection whose
 *   squares disagree.
 * - `path` is where the value sits in the form object `_selectionSquares` writes cells from and a preset stores.
 *   It defaults to `name`.
 * - `cell` is where the value sits on a stored terrain cell, defaulting to `path`. A `derived` field has no stored
 *   counterpart: the application computes it (the spans, the transition arms and the row lists).
 * - `cellRead` picks how a stored value is coerced back onto the form (see `coerceCellValue`).
 * - `fromAnchor` marks the effect fields a spanned selection reads from its rectangle anchor rather than from
 *   agreement across deliberately empty member squares.
 * - `sparse` marks a control whose form value a sibling list descriptor already writes: the crossing directions,
 *   which `TerrainBuilder._readCrossingRows` reads only where an elevation boundary allows editing.
 *   Such a control is applied from a preset only when that preset carries it, so a preset that says nothing about
 *   a direction leaves the value the selection's own elevation suggested.
 * @typedef {object} TerrainFormField
 */

/** Strip a typed teleport tag down to the stored one or two capitals. */
const teleportTag = (raw) => raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);

/**
 * Every per-square field, in the order the form object stores them. Preset files are written from that object, so
 * the order of this table is the key order of a saved preset.
 * @type {readonly TerrainFormField[]}
 */
const TERRAIN_FORM_FIELDS = Object.freeze([
  { name: 'movementCost', kind: 'number', value: 1, cellRead: 'raw' },
  { name: 'evasionMod', kind: 'number', value: 0, cellRead: 'raw' },
  { name: 'defMod', kind: 'number', value: 0, cellRead: 'raw' },
  { name: 'resMod', kind: 'number', value: 0, cellRead: 'raw' },
  { name: 'effect', kind: 'text', value: '', trim: true, fromAnchor: true },
  { name: 'effectScale', kind: 'number', value: 1, cellRead: 'nonzero', fromAnchor: true },
  { name: 'effectOpacity', kind: 'number', value: 1, fromAnchor: true },
  { name: 'effectRotation', kind: 'number', value: 0, cellRead: 'nonzero', fromAnchor: true },
  { name: 'effectMirrorX', kind: 'checkbox', value: false, cellRead: 'strict-true', fromAnchor: true },
  { name: 'effectMirrorY', kind: 'checkbox', value: false, cellRead: 'strict-true', fromAnchor: true },
  { name: 'effectSpan', kind: 'checkbox', value: false, derived: true },
  { name: 'tileEffects', kind: 'list', empty: 'array', derived: true },
  { name: 'objectivePoint', kind: 'select', value: '' },
  { name: 'overwriteBehavior', kind: 'select', value: '' },
  { name: 'respawnRounds', kind: 'number', value: 1, cellRead: 'nonzero', min: 1 },
  { name: 'spawns', kind: 'list', empty: 'array', derived: true },
  { name: 'exceptions', kind: 'list', empty: 'array', derived: true },
  { name: 'soundFile', kind: 'text', value: '', cell: 'audioFile', trim: true },
  { name: 'soundRadius', kind: 'number', value: 3, cell: 'audioRadius', cellRead: 'nonzero' },
  { name: 'soundVolume', kind: 'number', value: 0.8, cell: 'audioVolume' },
  { name: 'soundEasing', kind: 'checkbox', value: true, cell: 'audioEasing' },
  { name: 'audioSpan', kind: 'checkbox', value: false, derived: true },
  { name: 'lightSpan', kind: 'checkbox', value: false, derived: true },
  { name: 'lightDim', kind: 'number', value: 0, path: 'light.dim', cellRead: 'nonzero' },
  { name: 'lightBright', kind: 'number', value: 0, path: 'light.bright', cellRead: 'nonzero' },
  { name: 'lightWalls', kind: 'checkbox', value: true, path: 'light.walls' },
  { name: 'lightColor', kind: 'color', value: '#ffffff', path: 'light.color' },
  { name: 'lightAlpha', kind: 'number', value: 0.5, path: 'light.alpha' },
  { name: 'lightAnimType', kind: 'select', value: '', path: 'light.animType' },
  { name: 'lightAnimSpeed', kind: 'number', value: 5, path: 'light.animSpeed', cellRead: 'nonzero' },
  { name: 'lightAnimIntensity', kind: 'number', value: 5, path: 'light.animIntensity', cellRead: 'nonzero' },
  { name: 'lightVision', kind: 'checkbox', value: true, path: 'light.vision' },
  { name: 'lightColoration', kind: 'number', value: 1, path: 'light.coloration' },
  { name: 'lightLuminosity', kind: 'number', value: 0.5, path: 'light.luminosity' },
  { name: 'lightAttenuation', kind: 'number', value: 0.5, path: 'light.attenuation' },
  { name: 'lightSaturation', kind: 'number', value: 0, path: 'light.saturation' },
  { name: 'lightContrast', kind: 'number', value: 0, path: 'light.contrast' },
  { name: 'lightShadows', kind: 'number', value: 0, path: 'light.shadows' },
  { name: 'obstacle', kind: 'checkbox', value: false, cellRead: 'raw' },
  { name: 'impassable', kind: 'checkbox', value: false, cellRead: 'raw' },
  { name: 'transition', kind: 'select', value: '', derived: true },
  { name: 'transitionDirs', kind: 'list', empty: 'object', derived: true },
  { name: 'crossing', kind: 'list', empty: 'object', derived: true },
  ...CROSSING_DIRECTIONS.flatMap(dir => [
    { name: `crossing-${dir}-skill`, kind: 'select', value: 'athletics', path: `crossing.${dir}.skill`, sparse: true },
    {
      name: `crossing-${dir}-mult`, kind: 'number', value: CROSSING_DC_MULT_DEFAULT,
      path: `crossing.${dir}.mult`, sparse: true
    }
  ]),
  { name: 'transitionRestrict', kind: 'select', value: '' },
  { name: 'teleportLetter', kind: 'text', value: '', normalize: teleportTag },
  { name: 'teleportCost', kind: 'select', value: 'standard' },
  { name: 'teleportMov', kind: 'number', value: 0, cellRead: 'nonzero' },
  { name: 'teleportBlockable', kind: 'checkbox', value: false }
].map(field => Object.freeze(field)));

/** The scalar fields only, which are the ones bound to a single named control. */
export const TERRAIN_SCALAR_FIELDS = Object.freeze(TERRAIN_FORM_FIELDS.filter(field => field.kind !== 'list'));

/**
 * Every field's authored default, keyed by control name. `_selectionSquares` reads the audio radius from here so
 * the fallback it stores and the value the form offers cannot drift apart.
 * @type {Readonly<Object<string, *>>}
 */
export const TERRAIN_FIELD_DEFAULTS = Object.freeze(
  Object.fromEntries(TERRAIN_SCALAR_FIELDS.map(field => [field.name, field.value])));

/** Where a field sits in the form object a preset stores and `_selectionSquares` writes cells from. */
const formPath = (field) => field.path ?? field.name;

/** Where a field sits on a stored terrain cell, or null when the application derives it instead. */
const cellPath = (field) => (field.derived || field.sparse ? null : (field.cell ?? formPath(field)));

/* -------------------------------------------- */
/*  Reading the form                            */
/* -------------------------------------------- */

/**
 * Turn the raw control values of the per-square trays into the form object that `_selectionSquares` writes cells
 * from and the preset files store. `TerrainBuilder._readPerSquareForm` collects `raw` from the DOM and supplies
 * `lists` from the three row editors, the transition compass and the crossing rows.
 * @param {Object<string, *>} raw     Control values by name: `value` for all but checkboxes, `checked` for those.
 * @param {Object<string, *>} lists   Row and compass values by field name.
 * @returns {object} The per-square form.
 */
export function readTerrainFormValues(raw, lists = {}) {
  const form = {};
  for (const field of TERRAIN_FORM_FIELDS) {
    if (field.sparse) continue;
    const path = formPath(field);
    writeFieldPath(form, path, field.kind === 'list'
      ? (lists[path] ?? (field.empty === 'object' ? {} : []))
      : readControlValue(field, raw[field.name]));
  }
  return form;
}

/**
 * Coerce one raw control value. A blank number reads as zero, as the browser gives it. Only an unreadable or absent
 * control falls back to the authored default. A checkbox reads what it shows, never its default.
 * @param {TerrainFormField} field
 * @param {*} rawValue
 * @returns {*}
 */
function readControlValue(field, rawValue) {
  if (field.kind === 'checkbox') return !!rawValue;
  if (field.kind === 'number') {
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) ? numeric : field.value;
  }
  const text = String(rawValue ?? '');
  const trimmed = field.trim ? text.trim() : text;
  return field.normalize ? field.normalize(trimmed) : (trimmed || field.value);
}

/* -------------------------------------------- */
/*  Applying a preset                           */
/* -------------------------------------------- */

/**
 * Project a stored preset, or a copied tile, onto the values the per-square controls should show.
 *
 * `TerrainBuilder._applyPresetToForm` writes the result into the DOM and leaves any control this omits alone. The
 * row lists are rebuilt separately by the row editors, which own their own markup.
 * @param {object} preset             Preset parameters, in the shape `readTerrainFormValues` returns.
 * @returns {Object<string, *>} Control values by name, without the sparse controls the preset says nothing about.
 */
export function projectPresetToFormValues(preset) {
  const values = {};
  for (const field of TERRAIN_SCALAR_FIELDS) {
    const stored = readFieldPath(preset, formPath(field));
    if (field.sparse && stored === undefined) continue;
    values[field.name] = field.kind === 'checkbox'
      ? (field.value === true ? stored !== false : !!stored)
      : (stored ?? field.value);
  }
  return values;
}

/* -------------------------------------------- */
/*  Reading a selection                         */
/* -------------------------------------------- */

/**
 * Project the selected squares onto the values the per-square controls open at, for the template context
 * `TerrainBuilder._prepareContext` builds.
 * @param {object} sources
 * @param {function(string, *): *} sources.common   Reads one stored path, returning the default unless every
 *                                                  selected square agrees on it.
 * @param {object|null} sources.anchor              The spanned rectangle's top-left square.
 * @param {boolean} sources.spanActive              Whether the selection currently spans one effect.
 * @returns {Object<string, *>} Field values by control name.
 */
export function projectSelectionFieldValues({ common, anchor, spanActive = false }) {
  const fields = {};
  for (const field of TERRAIN_FORM_FIELDS) {
    const path = cellPath(field);
    if (!path) continue;
    const stored = field.fromAnchor && spanActive
      ? (readFieldPath(anchor, path) ?? field.value)
      : common(path, field.value);
    fields[field.name] = coerceCellValue(field, stored);
  }
  return fields;
}

/**
 * Coerce one stored value onto its control.
 *
 * `raw` keeps whatever the cell holds, `nonzero` treats a stored zero as unauthored, `strict-true` and `not-false`
 * distinguish a deliberately cleared flag from a missing one, and the remaining modes fall back on an unreadable
 * number or an empty string.
 * @param {TerrainFormField} field
 * @param {*} stored
 * @returns {*}
 */
function coerceCellValue(field, stored) {
  switch (field.cellRead ?? defaultCellRead(field)) {
    case 'raw': return stored;
    case 'nonzero': {
      const numeric = Number(stored) || field.value;
      return field.min === undefined ? numeric : Math.max(field.min, numeric);
    }
    case 'finite': {
      const numeric = Number(stored);
      return Number.isFinite(numeric) ? numeric : field.value;
    }
    case 'strict-true': return stored === true;
    case 'not-false': return stored !== false;
    case 'truthy': return !!stored;
    default: return stored || field.value;
  }
}

/** The coercion a field uses when it names none: a true checkbox keeps a cleared flag, a number must be readable. */
function defaultCellRead(field) {
  if (field.kind === 'checkbox') return field.value === true ? 'not-false' : 'truthy';
  return field.kind === 'number' ? 'finite' : 'value';
}

/* -------------------------------------------- */
/*  Dotted paths                                */
/* -------------------------------------------- */

/**
 * Read a dotted path such as `light.dim` from a preset or a stored terrain cell.
 * @param {object|null} source
 * @param {string} path
 * @returns {*}
 */
export function readFieldPath(source, path) {
  let value = source;
  for (const step of path.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[step];
  }
  return value;
}

/** Write a dotted path, creating the nested object the light block uses. */
function writeFieldPath(target, path, value) {
  const steps = path.split('.');
  let cursor = target;
  while (steps.length > 1) {
    const step = steps.shift();
    cursor[step] ??= {};
    cursor = cursor[step];
  }
  cursor[steps[0]] = value;
}
