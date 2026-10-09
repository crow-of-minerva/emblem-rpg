/** @layer ui/apps/menus/terrain-builder */
import { CROSSING_DC_MULT_DEFAULT, CROSSING_DIRECTIONS } from '../../../../contracts/domains/terrain.mjs';

/* -------------------------------------------- */
/*  Field vocabulary                            */
/* -------------------------------------------- */

/**
 * One per-square field of the Terrain Builder.
 *
 * - `name` is the control's `name=` attribute in `templates/editors/terrain-builder.hbs` and the key the template
 *   reads from its `fields` context. A new field also needs its markup and a line in `_selectionSquares` (app.mjs),
 *   which copies each value into the saved square by hand.
 * - `kind` says how the control is read and written: `number`, `text`, `select`, `color`, `checkbox` or `list`.
 * - `value` is the default, used for a blank control, a preset that omits the field and a selection whose squares
 *   disagree.
 * - `path` is where the value sits in the form object that Save, presets and Copy use. It defaults to `name`.
 * - `cell` is where the value sits on a saved terrain square, defaulting to `path`. A `derived` field isn't read
 *   from one saved path: app.mjs works it out from the whole selection (the spans, the transition directions and the
 *   row lists).
 * - `cellRead` picks how a saved value is turned back into a control value (see `coerceCellValue`).
 * - `fromAnchor` marks the visual effect fields. A spanned effect is saved only on its rectangle's top-left square,
 *   so these are read from that square.
 * - `sparse` marks the per-direction crossing controls; a preset sets them only when it names them, otherwise they
 *   keep the value the selection's heights suggested.
 * - `trim` and `normalize` clean typed text, `min` is the lowest number a saved value opens at, and `empty` is a
 *   list's blank value (`array` or `object`).
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
 * Every field's default, keyed by control name.
 * @type {Readonly<Object<string, *>>}
 */
export const TERRAIN_FIELD_DEFAULTS = Object.freeze(
  Object.fromEntries(TERRAIN_SCALAR_FIELDS.map(field => [field.name, field.value])));

/** Where a field sits in the form object that Save, presets and Copy use. */
const formPath = (field) => field.path ?? field.name;

/** Where a field sits on a saved terrain square, or null for derived and sparse fields, which app.mjs reads itself. */
const cellPath = (field) => (field.derived || field.sparse ? null : (field.cell ?? formPath(field)));

/* -------------------------------------------- */
/*  Reading the form                            */
/* -------------------------------------------- */

/**
 * Turn the raw tray control values into the form object that Save, presets and Copy use. `lists` holds the values
 * that aren't single controls: the three row lists, the transition directions and the crossing rows.
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
 * control falls back to the default. A checkbox reads what it shows, never its default.
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
 * Turn a saved preset, or a copied tile, into the values the per-square controls should show.
 *
 * `TerrainBuilder._applyPresetToForm` writes the result into the form and leaves any control left out alone. The
 * row lists are rebuilt separately by the row editors.
 * @param {object} preset             Preset parameters, in the shape `readTerrainFormValues` returns.
 * @returns {Object<string, *>} Control values by name, leaving out crossing controls the preset doesn't name.
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
 * The values the per-square controls open at for the selected squares, for `TerrainBuilder._prepareContext`.
 * @param {object} sources
 * @param {function(string, *): *} sources.common   Reads one saved path, returning the default unless every
 *                                                  selected square has the same value.
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
 * Turn one saved value into its control's value.
 *
 * `raw` keeps whatever the square holds, `nonzero` treats a saved zero as unset, `strict-true` and `not-false`
 * tell a flag that was turned off apart from a missing one, and the remaining modes fall back to the default on an
 * unreadable number or an empty string.
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

/**
 * The read mode a field gets when it names none: a checkbox that defaults on stays on unless saved as false, and a
 * number falls back to its default when unreadable.
 */
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
