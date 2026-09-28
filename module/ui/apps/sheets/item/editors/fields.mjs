/** @layer ui/apps/sheets/item/editors */
/*
 * Descriptor-driven fields for the animation and effect editors: renderField draws a field from its descriptor, and
 * readField reads it back, returning undefined for a default so it isn't saved. The second half of the file is the
 * placement (terrain geometry) panel shared by the requirement and effect editors.
 */
import {
  defaultGeometry,
  GEOMETRY_ANCHORS,
  GEOMETRY_BUDGET_SOURCES,
  GEOMETRY_ELEVATION_RULES,
  GEOMETRY_METRICS,
  GEOMETRY_MOVERS,
  GEOMETRY_PICKS,
  GEOMETRY_REACHES,
  MAX_FOOTPRINT_SIDE,
  MAX_GEOMETRY_DISTANCE,
  normalizeGeometry
} from '../../../../../contracts/dsl/terrain-geometry.mjs';
import { escapeHtml, optionMarkup } from '../../../../../lib/dom/html.mjs';
import { getTooltip } from '../../../../tooltips.mjs';

/* -------------------------------------------- */
/*  Class Stems                                 */
/* -------------------------------------------- */

/** The class stem a field's variant classes are built from: the first class in `fieldClass`. */
function variantOf(fieldClass) {
  return String(fieldClass ?? '').trim().split(/\s+/)[0] || 'ed-field';
}

/** A descriptor's visible label (its name unless it declares one), escaped for the markup `renderField` builds. */
function labelOf(field) {
  return escapeHtml(field.label || field.name);
}

function placeholderOf(field) {
  return escapeHtml(field.placeholder ?? '');
}

/** The `data-tooltip` attribute for a tooltip id from ui/tooltips.mjs, or nothing when the id has no text. */
function tooltipAttr(id, data = {}) {
  const text = id ? getTooltip(id, data) : '';
  return text ? ` data-tooltip="${escapeHtml(text)}"` : '';
}

/** The label line of a stacked field: an `.ed-label` span carrying the descriptor's tooltip. */
function labelSpan(field) {
  return `<span class="ed-label"${tooltipAttr(field.tooltip, field.tooltipData)}>${labelOf(field)}</span>`;
}

/** Wrap a text or number input in the unit marker when the descriptor names a unit such as "ms" or "sq". */
function withUnit(field, input) {
  return field.unit ? `<span class="ed-with-unit" data-unit="${escapeHtml(field.unit)}">${input}</span>` : input;
}

/** A checkbox field: box then caption, with the tooltip on the wrapping label because the box has no label line. */
function checkField(field, fieldClass, variant, input) {
  const classes = `${fieldClass} ${variant}-checkbox${field.disabled ? ` ${variant}-disabled` : ''}`;
  const attrs = `${tooltipAttr(field.tooltip, field.tooltipData)}${field.hidden ? ' hidden' : ''}`;
  return `<label class="${classes}"${attrs}>${input}<span class="ed-label">${labelOf(field)}</span></label>`;
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * Render one field from its descriptor. The checkbox types differ in their default: `checkbox` stores true when
 * ticked, `checkboxDefaultOn` stores false when unticked, and `invertedCheckbox` stores true when unticked. A
 * composite field puts its inputs under one `data-step-field` element for readField. A descriptor may name a
 * `tooltip` id (with `tooltipData`) for its label and a `unit` for a text or number input.
 * @param {object} field                          The field descriptor.
 * @param {*} value                               Its current value.
 * @param {object} [options]
 * @param {string} [options.idPrefix]             Prefix for the control's element id, for uniqueness.
 * @param {string} [options.fieldClass]           The editor's field classes. The first is the variant stem.
 * @param {string} [options.numberStep]           The `step` a number input takes.
 * @param {boolean} [options.emptyOption]         Prepend a blank option to a selector.
 * @param {boolean} [options.keepOrphan]          Keep a selected value that is not among the options.
 * @returns {string}
 */
export function renderField(field, value, {
  idPrefix = '',
  fieldClass = 'ed-field',
  numberStep = 'any',
  emptyOption = false,
  keepOrphan = false
} = {}) {
  const id = `${idPrefix}${field.name}`;
  const label = labelSpan(field);
  const variant = variantOf(fieldClass);
  const bind = `id="${id}" data-step-field="${field.name}"`;
  const hidden = field.hidden ? ' hidden' : '';

  switch (field.type) {
    case 'select': {
      const known = field.options.map(o => (typeof o === 'string' ? o : o.value));
      const orphan = keepOrphan && value !== undefined && value !== null && value !== '' && !known.includes(value)
        ? [{ value, label: `${value} (legacy)` }]
        : [];
      const opts = [...field.options, ...orphan].map(o => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        const attr = v === undefined || v === null ? '' : escapeHtml(v);
        return `<option value="${attr}"${v === (value ?? '') ? ' selected' : ''}>${escapeHtml(l || '--')}</option>`;
      }).join('');
      const blank = emptyOption ? '<option value=""></option>' : '';
      const select = `<select ${bind}>${blank}${opts}</select>`;
      return `<label class="${fieldClass}"${hidden}>${label}${select}</label>`;
    }
    case 'checkbox': {
      const on = value ? ' checked' : '';
      const input = `<input type="checkbox" ${bind}${on}${field.disabled ? ' disabled' : ''} />`;
      return checkField(field, fieldClass, variant, input);
    }
    case 'checkboxDefaultOn': {
      const input = `<input type="checkbox" ${bind}${value === false ? '' : ' checked'} />`;
      return checkField(field, fieldClass, variant, input);
    }
    case 'invertedCheckbox': {
      const input = `<input type="checkbox" ${bind} data-inverted="1"${value ? '' : ' checked'} />`;
      return checkField(field, fieldClass, variant, input);
    }
    case 'tristate': {
      const v = value === true ? 'true' : value === false ? 'false' : '';
      return `<label class="${fieldClass}"${hidden}>${label}<select ${bind} data-tristate="1">
        <option value=""${v === '' ? ' selected' : ''}>auto</option>
        <option value="true"${v === 'true' ? ' selected' : ''}>true</option>
        <option value="false"${v === 'false' ? ' selected' : ''}>false</option>
      </select></label>`;
    }
    case 'number': {
      const v = value === undefined || value === null ? '' : escapeHtml(value);
      const input = `<input type="number" step="${numberStep}" ${bind} value="${v}"`
        + ` placeholder="${placeholderOf(field)}" />`;
      return `<label class="${fieldClass}"${hidden}>${label}${withUnit(field, input)}</label>`;
    }
    case 'textarea': {
      const v = value === undefined || value === null ? '' : String(value);
      const area = `<textarea ${bind} rows="3" placeholder="${placeholderOf(field)}">`
        + `${escapeHtml(v)}</textarea>`;
      return `<label class="${fieldClass} ${variant}-textarea"${hidden}>${label}${area}</label>`;
    }
    case 'offset': return renderOffset(field, value, fieldClass, variant);
    case 'scale': return renderScale(field, value, fieldClass, variant);
    case 'repeats': return renderRepeats(field, value, fieldClass, variant);
    case 'atLocation': return renderAtLocation(field, value, fieldClass, variant);
    case 'mirrors': return renderMirrors(field, value, fieldClass, variant);
    default: {
      const v = value === undefined || value === null ? '' : escapeHtml(value);
      const listId = field.datalist ? `${id}-list` : '';
      const listOptions = (field.datalist ?? []).map(o => `<option value="${escapeHtml(o)}"></option>`).join('');
      const listHtml = field.datalist ? `<datalist id="${listId}">${listOptions}</datalist>` : '';
      const listAttr = field.datalist ? ` list="${listId}"` : '';
      const input = `<input type="text" ${bind} value="${v}" placeholder="${placeholderOf(field)}"${listAttr} />`;
      return `<label class="${fieldClass}"${hidden}>${label}${withUnit(field, input)}${listHtml}</label>`;
    }
  }
}

/**
 * The offset composite: one label per control (x, y, grid units) over a number pair and the grid-units box. Its
 * value is `{x, y, gridUnits}`.
 */
function renderOffset(field, value, fieldClass, variant) {
  const x = escapeHtml(value?.x ?? '');
  const y = escapeHtml(value?.y ?? '');
  const gridUnits = value && value.gridUnits === false ? '' : ' checked';
  const tip = tooltipAttr(field.tooltip, field.tooltipData);
  return `<div class="${fieldClass} ${variant}-offset" data-step-field="${field.name}">
      <span class="ed-label ${variant}-offset-x-label"${tip}>offset x</span>
      <span class="ed-label ${variant}-offset-y-label">offset y</span>
      <span class="ed-label ${variant}-offset-grid-label"${tooltipAttr('editor.anim.grid-units')}>grid units</span>
      <input type="number" step="any" class="${variant}-offset-x" placeholder="0" data-offset-part="x" value="${x}" />
      <input type="number" step="any" class="${variant}-offset-y" placeholder="0" data-offset-part="y" value="${y}" />
      <input type="checkbox" class="${variant}-offset-grid-cb" data-offset-part="gridUnits"${gridUnits} />
    </div>`;
}

/** The scale composite: a uniform factor (a number) or an x and y pair (`{x, y}`), under one label. */
function renderScale(field, value, fieldClass, variant) {
  const isNum = typeof value === 'number';
  const isXY = value && typeof value === 'object' && !Array.isArray(value);
  const n = escapeHtml(isNum ? value : '');
  const xv = escapeHtml(isXY ? (value.x ?? '') : '');
  const yv = escapeHtml(isXY ? (value.y ?? '') : '');
  return `<div class="${fieldClass} ${variant}-scale" data-step-field="${field.name}">
      ${labelSpan(field)}
      <div class="${variant}-scale-row">
        <input type="number" step="any" placeholder="n" data-scale-part="n" value="${n}" />
        <input type="number" step="any" placeholder="x" data-scale-part="x" value="${xv}" />
        <input type="number" step="any" placeholder="y" data-scale-part="y" value="${yv}" />
      </div>
    </div>`;
}

/**
 * The repeats composite: a count, and the shortest and longest delay between plays, under one label. Its value is
 * `{count, delayMin, delayMax}`.
 */
function renderRepeats(field, value, fieldClass, variant) {
  const count = escapeHtml(value?.count ?? '');
  const dMin = escapeHtml(value?.delayMin ?? '');
  const dMax = escapeHtml(value?.delayMax ?? '');
  return `<div class="${fieldClass} ${variant}-repeats" data-step-field="${field.name}">
      ${labelSpan(field)}
      <div class="${variant}-repeats-row">
        <input type="number" step="any" placeholder="count" data-repeats-part="count" value="${count}" />
        <input type="number" step="any" placeholder="min delay" data-repeats-part="delayMin" value="${dMin}" />
        <input type="number" step="any" placeholder="max delay" data-repeats-part="delayMax" value="${dMax}" />
      </div>
    </div>`;
}

/**
 * The atLocation composite: where an animation plays (from the descriptor's `options`), and whether it plays again
 * for each target. Its value is `{atLocation, perTarget}`.
 */
function renderAtLocation(field, value, fieldClass, variant) {
  const atLoc = value?.atLocation ?? '';
  const perTarget = value && value.perTarget ? ' checked' : '';
  const opts = field.options.map(o =>
    `<option value="${escapeHtml(o)}"${o === atLoc ? ' selected' : ''}>${escapeHtml(o || '--')}</option>`).join('');
  const tip = tooltipAttr(field.tooltip, field.tooltipData);
  const perTargetTip = tooltipAttr('editor.anim.per-target');
  return `<div class="${fieldClass} ${variant}-atLocation" data-step-field="${field.name}">
      <span class="ed-label ${variant}-atLocation-sel-label"${tip}>at location</span>
      <span class="ed-label ${variant}-atLocation-pt-label"${perTargetTip}>per target</span>
      <select class="${variant}-atLocation-sel" data-atloc-part="atLocation">${opts}</select>
      <input type="checkbox" class="${variant}-atLocation-pt-cb" data-atloc-part="perTarget"${perTarget} />
    </div>`;
}

/** The mirrors composite: four checkboxes over the step's mirror and random-mirror keys. */
function renderMirrors(field, value, fieldClass, variant) {
  const keys = [
    ['mirrorX', 'mirror x'], ['mirrorY', 'mirror y'], ['randomizeMirrorX', 'random x'], ['randomizeMirrorY', 'random y']
  ];
  const labels = keys.map(([key, text], index) =>
    `<span class="ed-label"${index === 0 ? tooltipAttr(field.tooltip, field.tooltipData) : ''}>${text}</span>`);
  const boxes = keys.map(([key]) =>
    `<input type="checkbox" data-mirror-key="${key}"${value && value[key] ? ' checked' : ''} />`);
  return `<div class="${fieldClass} ${variant}-mirrors" data-step-field="${field.name}">
      ${labels.join('\n      ')}
      ${boxes.join('\n      ')}
    </div>`;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/** The element a field's value is read from, whether the caller passed the control itself or the box around it. */
function controlIn(root, field) {
  if (!root) return null;
  const selector = `[data-step-field="${field.name}"]`;
  if (typeof root.matches === 'function' && root.matches(selector)) return root;
  if (typeof root.querySelector === 'function') return root.querySelector(selector) ?? root;
  return root;
}

/**
 * Read a field back from its control. A default reads as undefined so it isn't saved, and a composite that sets
 * several step keys returns them under `__keys` for the editor to merge.
 * @param {object} field                  The field descriptor.
 * @param {HTMLElement} root              The control, or something containing it.
 * @returns {*}
 */
export function readField(field, root) {
  const input = controlIn(root, field);
  if (!input) return undefined;

  if (field.type === 'offset') {
    const xRaw = input.querySelector('[data-offset-part="x"]')?.value;
    const yRaw = input.querySelector('[data-offset-part="y"]')?.value;
    const gridUnits = input.querySelector('[data-offset-part="gridUnits"]')?.checked === true;
    const xNum = xRaw === '' || xRaw == null ? null : Number(xRaw);
    const yNum = yRaw === '' || yRaw == null ? null : Number(yRaw);
    const hasX = xNum !== null && Number.isFinite(xNum) && xNum !== 0;
    const hasY = yNum !== null && Number.isFinite(yNum) && yNum !== 0;
    if (!hasX && !hasY) return undefined;
    const out = { gridUnits };
    if (hasX) out.x = xNum;
    if (hasY) out.y = yNum;
    return out;
  }
  if (field.type === 'scale') {
    const nRaw = input.querySelector('[data-scale-part="n"]')?.value;
    const xRaw = input.querySelector('[data-scale-part="x"]')?.value;
    const yRaw = input.querySelector('[data-scale-part="y"]')?.value;
    const nNum = nRaw === '' || nRaw == null ? null : Number(nRaw);
    if (nNum !== null && Number.isFinite(nNum)) return nNum;
    const xNum = xRaw === '' || xRaw == null ? null : Number(xRaw);
    const yNum = yRaw === '' || yRaw == null ? null : Number(yRaw);
    const hasX = xNum !== null && Number.isFinite(xNum);
    const hasY = yNum !== null && Number.isFinite(yNum);
    if (!hasX && !hasY) return undefined;
    return { x: hasX ? xNum : 1, y: hasY ? yNum : 1 };
  }
  if (field.type === 'repeats') {
    const cRaw = input.querySelector('[data-repeats-part="count"]')?.value;
    const minRaw = input.querySelector('[data-repeats-part="delayMin"]')?.value;
    const maxRaw = input.querySelector('[data-repeats-part="delayMax"]')?.value;
    const cNum = cRaw === '' || cRaw == null ? null : Number(cRaw);
    if (cNum === null || !Number.isFinite(cNum)) return undefined;
    const out = { count: cNum };
    const minNum = minRaw === '' || minRaw == null ? null : Number(minRaw);
    const maxNum = maxRaw === '' || maxRaw == null ? null : Number(maxRaw);
    if (minNum !== null && Number.isFinite(minNum)) out.delayMin = minNum;
    if (maxNum !== null && Number.isFinite(maxNum)) out.delayMax = maxNum;
    return out;
  }
  if (field.type === 'atLocation') {
    const atLocRaw = input.querySelector('[data-atloc-part="atLocation"]')?.value;
    const perTarget = input.querySelector('[data-atloc-part="perTarget"]')?.checked === true;
    const out = {};
    if (atLocRaw && atLocRaw !== '') out.atLocation = atLocRaw;
    if (perTarget) out.perTarget = true;
    return Object.keys(out).length ? { __keys: out } : undefined;
  }
  if (field.type === 'mirrors') {
    const out = {};
    for (const cb of input.querySelectorAll('[data-mirror-key]')) {
      const key = cb.dataset.mirrorKey;
      if (cb.checked) out[key] = true;
    }
    return { __keys: out };
  }
  if (field.type === 'checkbox') return input.checked || undefined;
  if (field.type === 'checkboxDefaultOn') return input.checked ? undefined : false;
  if (field.type === 'invertedCheckbox') return input.checked ? undefined : true;
  if (field.type === 'tristate') {
    if (input.value === 'true') return true;
    if (input.value === 'false') return false;
    return undefined;
  }
  if (input.value === '' || input.value === null) return undefined;
  if (field.type === 'number') {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : undefined;
  }
  return input.value;
}

/*
 * The placement (terrain geometry) panel shared by the requirement and effect editors. A requirement needs enough
 * valid squares to exist, and an effect step picks one of them. readTerrainGeometryPanel drops the fields the
 * panel's context doesn't use.
 */
const FIELD_SELECTOR = '[data-tg-field]';

/* -------------------------------------------- */
/*  Authoring Catalog                           */
/* -------------------------------------------- */

const GEOMETRY_ANCHOR_LABELS = Object.freeze({ target: 'target', self: 'self', targetLocation: 'the clicked square' });
const GEOMETRY_MOVER_LABELS = Object.freeze({ self: 'self', target: 'target', custom: 'a unit of size' });
const GEOMETRY_METRIC_LABELS = Object.freeze({ emblem: 'cost 2 (Emblem)', king: 'cost 1 (king)' });
const GEOMETRY_REACH_LABELS = Object.freeze({ path: 'walking', teleport: 'teleporting' });
const GEOMETRY_BUDGET_LABELS = Object.freeze({
  rng: 'item range', mvmt: 'movement stat', custom: 'custom', none: 'no limit'
});
const GEOMETRY_ELEVATION_LABELS = Object.freeze({ any: 'any', matchAnchor: 'same as anchor' });
const GEOMETRY_PICK_LABELS = Object.freeze({
  nearest: 'nearest to mover', farthest: 'farthest from mover', random: 'random', prompt: 'the player picks'
});
const GEOMETRY_PICK_PHRASES = Object.freeze({
  nearest: 'nearest to the mover', farthest: 'farthest from the mover', random: 'at random', prompt: 'the player picks'
});

const GEOMETRY_PRESETS = Object.freeze([
  { key: 'charge', label: 'Charge to the target', geometry: defaultGeometry() },
  { key: 'besideSelfTeleport', label: 'Teleport the target beside you',
    geometry: defaultGeometry({
      anchor: 'self', mover: 'target', reach: 'teleport', budgetSource: 'none', pick: 'prompt'
    }) },
  { key: 'besideTargetTeleport', label: 'Teleport beside the target',
    geometry: defaultGeometry({ anchor: 'target', mover: 'self', reach: 'teleport', budgetSource: 'none' }) },
  { key: 'openSquareBesideSelf', label: 'An open square beside you',
    geometry: defaultGeometry({ anchor: 'self', mover: 'custom', reach: 'teleport', budgetSource: 'none' }) }
]);

function presetGeometry(key) {
  const preset = GEOMETRY_PRESETS.find(entry => entry.key === key);
  return preset ? { ...preset.geometry } : null;
}

/**
 * The fields of a geometry that matter in one editor context, as a comparable string. Fields the context does
 * not use, and budget fields a teleport never reads, are left out so a preset still matches after a round trip
 * through readTerrainGeometryPanel.
 * @param {*} raw                                 The geometry.
 * @param {'requirement'|'step'} context          Where it is edited.
 */
function comparableGeometry(raw, context) {
  const g = normalizeGeometry(raw);
  const out = {
    anchor: g.anchor, minDistance: g.minDistance, maxDistance: g.maxDistance, metric: g.metric, reach: g.reach,
    elevation: g.elevation, lineOfSight: g.lineOfSight
  };
  if (g.reach === 'path') {
    out.budgetSource = g.budgetSource;
    if (g.budgetSource === 'custom') out.budgetValue = g.budgetValue;
  }
  if (context === 'step') {
    out.pick = g.pick;
  } else {
    out.mover = g.mover;
    out.minCount = g.minCount;
    if (g.mover === 'custom') {
      out.moverWidth = g.moverWidth;
      out.moverHeight = g.moverHeight;
    }
  }
  return JSON.stringify(out);
}

/**
 * The preset a geometry equals in one context, or '' for Custom.
 * @param {'requirement'|'step'} context          Where it is edited.
 */
function presetKeyFor(raw, context) {
  const wanted = comparableGeometry(raw, context);
  return GEOMETRY_PRESETS.find(preset => comparableGeometry(preset.geometry, context) === wanted)?.key ?? '';
}

/* -------------------------------------------- */
/*  Summary                                     */
/* -------------------------------------------- */

/**
 * How the mover gets to the square: the reach and, for a walk, its budget.
 * @param {string} verb           "walk" for a requirement, "walking" for a step.
 */
function reachPhrase(g, verb) {
  if (g.reach === 'teleport') return verb === 'walk' ? 'teleport' : 'teleporting';
  if (g.budgetSource === 'none') return `${verb} without limit`;
  if (g.budgetSource === 'rng') return `${verb} within item range`;
  if (g.budgetSource === 'mvmt') return `${verb} within its movement`;
  const n = g.budgetValue;
  if (typeof n !== 'number') return `${verb} within an unset limit`;
  return `${verb} within ${n} ${n === 1 ? 'square' : 'squares'}`;
}

/**
 * One English sentence describing a geometry, in the same words the panel's controls use. Shown in the panel and
 * in the effect editor's step summary.
 * @param {*} raw                                 The geometry, normalized here.
 * @param {{context?: 'requirement'|'step'}} [options]
 * @returns {string}
 */
export function summarizeGeometry(raw, { context = 'requirement' } = {}) {
  const g = normalizeGeometry(raw);
  const step = context === 'step';
  const anchor = g.anchor === 'target' ? 'the target'
    : g.anchor === 'targetLocation' ? 'the clicked square'
      : !step && g.mover === 'self' ? 'itself' : 'you';
  const band = g.minDistance === 1 && g.maxDistance === 1 ? 'next to'
    : g.minDistance === g.maxDistance ? `exactly ${g.minDistance} from`
      : `${g.minDistance} to ${g.maxDistance} from`;
  const extras = [];
  if (g.metric === 'king') extras.push('diagonals costing 1');
  if (g.elevation === 'matchAnchor') extras.push('at the same elevation');
  if (g.lineOfSight) extras.push("in the anchor's sight");
  const tail = extras.map(extra => `, ${extra}`).join('');
  if (step) {
    const pick = GEOMETRY_PICK_PHRASES[g.pick];
    return `Move to a square ${band} ${anchor} by ${reachPhrase(g, 'walking')}${tail}, ${pick}.`;
  }
  const mover = g.mover === 'self' ? 'Self'
    : g.mover === 'target' ? 'The target' : `A ${g.moverWidth}×${g.moverHeight} unit`;
  const count = g.minCount > 1 ? `, with at least ${g.minCount} such squares` : '';
  return `${mover} must be able to ${reachPhrase(g, 'walk')} to a square ${band} ${anchor}${tail}${count}.`;
}

/* -------------------------------------------- */
/*  Field Markup                                */
/* -------------------------------------------- */

function options(values, labels, selected) {
  return optionMarkup(values.map(value => ({ value, label: labels[value] ?? value })), selected);
}

/**
 * One grid cell: an `.ed-field` with its label line and one or more controls beneath.
 * @param {string} label                  The label text.
 * @param {string} tooltipId              The label's tooltip id.
 * @param {string} controls               The control markup.
 * @param {object} [options]
 * @param {string} [options.tag]          The wrapping element. A cell with several controls is a div.
 * @param {string} [options.attrs]        Extra attributes on the wrapper.
 */
function fieldCell(label, tooltipId, controls, { tag = 'label', attrs = '' } = {}) {
  const line = `<span class="ed-label"${tooltipAttr(tooltipId)}>${label}</span>`;
  return `<${tag} class="ed-field"${attrs}>${line}${controls}</${tag}>`;
}

/**
 * A selector bound to one geometry field. A forced selector shows the `forced` value, disabled, and remembers the
 * authored value in data-tg-forced so refreshPanel can restore it when the forcing condition lifts.
 * @param {object} labels                 How each value is named.
 * @param {string} selected               The authored value.
 * @param {object} [options]
 * @param {string} [options.forced]       The value shown while the selector is forced.
 * @param {string} [options.attrs]        Extra attributes.
 */
function selectControl(name, values, labels, selected, { forced, attrs = '' } = {}) {
  const shown = forced ?? selected;
  const force = forced === undefined ? '' : ` data-tg-forced="${escapeHtml(selected)}" disabled`;
  return `<select data-tg-field="${name}"${attrs}${force}>${options(values, labels, shown)}</select>`;
}

/** A whole-number input bound to one geometry field, with an optional maximum. */
function numberControl(name, value, min, max) {
  const maxAttr = max !== undefined ? ` max="${max}"` : '';
  const bound = `min="${min}"${maxAttr}`;
  return `<input type="number" step="1" ${bound} data-tg-field="${name}" value="${escapeHtml(value)}" />`;
}

/**
 * Row 1: who must fit (with the custom footprint beneath), what the distance is measured from, and the distance
 * range.
 */
function renderWhoRow(g, isReq) {
  const custom = isReq && g.mover === 'custom';
  const size = `<span class="ed-pair" data-tg-size${custom ? '' : ' hidden'}>`
    + numberControl('moverWidth', g.moverWidth, 1, MAX_FOOTPRINT_SIDE)
    + `<span class="ed-pair-x">×</span>`
    + numberControl('moverHeight', g.moverHeight, 1, MAX_FOOTPRINT_SIDE)
    + '</span>';
  const who = isReq
    ? fieldCell('who must fit', 'editor.geometry.who',
      selectControl('mover', GEOMETRY_MOVERS, GEOMETRY_MOVER_LABELS, g.mover) + size, { tag: 'div' })
    : fieldCell('who must fit', 'editor.geometry.who', '<span class="ed-summary">the moved token</span>',
      { tag: 'div' });
  const anchor = fieldCell('measured from', 'editor.geometry.anchor',
    selectControl('anchor', GEOMETRY_ANCHORS, GEOMETRY_ANCHOR_LABELS, g.anchor));
  const distance = fieldCell('distance', 'editor.geometry.distance', '<span class="ed-pair">'
    + numberControl('minDistance', g.minDistance, 1, MAX_GEOMETRY_DISTANCE)
    + '<span class="ed-pair-x">to</span>'
    + numberControl('maxDistance', g.maxDistance, 1, MAX_GEOMETRY_DISTANCE)
    + '</span>', { tag: 'div' });
  return `<div class="ed-grid ed-grid--3">${who}${anchor}${distance}</div>`;
}

/**
 * Row 2: the reach, its budget (with the custom amount beneath), and the diagonal rule. A custom footprint has no
 * origin to walk from, so it forces a teleport. A teleport has no budget, so it forces "no limit".
 */
function renderReachRow(g, isReq) {
  const custom = isReq && g.mover === 'custom';
  const reach = custom ? 'teleport' : g.reach;
  const teleport = reach === 'teleport';
  const showValue = !teleport && g.budgetSource === 'custom';
  const reachCell = fieldCell('gets there by', 'editor.geometry.reach',
    selectControl('reach', GEOMETRY_REACHES, GEOMETRY_REACH_LABELS, g.reach, custom ? { forced: 'teleport' } : {}));
  const budgetOptions = { attrs: ' data-tg-budget', ...(teleport ? { forced: 'none' } : {}) };
  const budget = selectControl('budgetSource', GEOMETRY_BUDGET_SOURCES, GEOMETRY_BUDGET_LABELS, g.budgetSource,
    budgetOptions);
  const amount = `<span class="ed-with-unit" data-unit="sq" data-tg-budget-value${showValue ? '' : ' hidden'}>`
    + numberControl('budgetValue', typeof g.budgetValue === 'number' ? g.budgetValue : '', 0)
    + '</span>';
  const budgetCell = fieldCell('within', 'editor.geometry.budget', budget + amount, { tag: 'div' });
  const metricCell = fieldCell('diagonals', 'editor.geometry.diagonals',
    selectControl('metric', GEOMETRY_METRICS, GEOMETRY_METRIC_LABELS, g.metric));
  return `<div class="ed-grid ed-grid--3">${reachCell}${budgetCell}${metricCell}</div>`;
}

/** Row 3: elevation, line of sight, and the count a requirement needs or the pick a step makes. */
function renderExtraRow(g, isReq) {
  const elevation = fieldCell('elevation', 'editor.geometry.elevation',
    selectControl('elevation', GEOMETRY_ELEVATION_RULES, GEOMETRY_ELEVATION_LABELS, g.elevation));
  const los = `<label class="ed-check ed-field-checkbox"${tooltipAttr('editor.geometry.los')}>`
    + `<input type="checkbox" data-tg-field="lineOfSight"${g.lineOfSight ? ' checked' : ''} />`
    + '<span>visible from the anchor</span></label>';
  const last = isReq
    ? fieldCell('open squares needed', 'editor.geometry.min-count', numberControl('minCount', g.minCount, 1, 99))
    : fieldCell('chosen square', 'editor.geometry.pick',
      selectControl('pick', GEOMETRY_PICKS, GEOMETRY_PICK_LABELS, g.pick));
  return `<div class="ed-grid ed-grid--3">${elevation}${los}${last}</div>`;
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * Render the placement panel for a spec: a template row over three rows of three cells. Conditional controls
 * (the custom footprint, the custom budget amount) are rendered hidden rather than omitted, so showing them later
 * only unhides them and the panel isn't redrawn.
 * @param {object} spec                                   The spec, normalized for display.
 * @param {object} [options]
 * @param {string} [options.context]                      Where the panel is used.
 * @returns {string}
 */
export function renderTerrainGeometryPanel(spec, { context = 'requirement' } = {}) {
  const g = normalizeGeometry(spec);
  const isReq = context === 'requirement';
  const presetOpts = optionMarkup(
    [{ value: '', label: 'Custom' }, ...GEOMETRY_PRESETS.map(p => ({ value: p.key, label: p.label }))],
    presetKeyFor(g, context)
  );
  const template = fieldCell('template', 'editor.geometry.template', `<select data-tg-preset>${presetOpts}</select>`);
  const summary = `<span class="ed-summary" data-tg-summary>${escapeHtml(summarizeGeometry(g, { context }))}</span>`;
  return `
    <div class="ed-panel" data-tg-panel data-tg-context="${context}">
      ${renderWhoRow(g, isReq)}
      ${renderReachRow(g, isReq)}
      ${renderExtraRow(g, isReq)}
    </div>`;
}

/**
 * Read geometry for contract normalization. Empty numbers read as undefined, a teleport drops its budget, a
 * non-custom budget drops its amount, and fields belonging to the other editor context are removed.
 * @param {HTMLElement} panelEl           The panel.
 * @returns {object}                      The spec.
 */
export function readTerrainGeometryPanel(panelEl) {
  const out = {};
  if (!panelEl) return out;
  for (const el of panelEl.querySelectorAll(FIELD_SELECTOR)) {
    const name = el.dataset.tgField;
    if (el.type === 'checkbox') { out[name] = el.checked; continue; }
    if (el.type === 'number') {
      const n = Number(el.value);
      out[name] = el.value === '' || !Number.isFinite(n) ? undefined : n;
      continue;
    }
    out[name] = el.value;
  }
  const { minDistance, maxDistance } = out;
  if (minDistance !== undefined && maxDistance !== undefined && maxDistance < minDistance) {
    out.maxDistance = minDistance;
  }
  if (out.reach === 'teleport') {
    delete out.budgetSource;
    delete out.budgetValue;
  } else if (out.budgetSource !== 'custom') {
    delete out.budgetValue;
  }
  if (panelEl.dataset.tgContext === 'step') {
    delete out.mover;
    delete out.moverWidth;
    delete out.moverHeight;
    delete out.minCount;
  } else {
    delete out.pick;
  }
  return out;
}

/* -------------------------------------------- */
/*  Live Behavior                               */
/* -------------------------------------------- */

/** Write a spec into a rendered panel, leaving alone the fields the spec doesn't name. */
function writePanel(panelEl, spec) {
  for (const el of panelEl.querySelectorAll(FIELD_SELECTOR)) {
    const name = el.dataset.tgField;
    if (!(name in spec)) continue;
    if (el.type === 'checkbox') el.checked = spec[name] === true;
    else el.value = spec[name] ?? '';
  }
}

/** Force a selector to show one value, disabled, or release it back to the value it held before it was forced. */
function forceSelect(el, forced, value) {
  if (!el) return;
  if (forced) {
    if (el.dataset.tgForced === undefined) el.dataset.tgForced = el.value;
    el.value = value;
    el.disabled = true;
    return;
  }
  if (el.dataset.tgForced !== undefined) {
    el.value = el.dataset.tgForced;
    delete el.dataset.tgForced;
  }
  el.disabled = false;
}

/**
 * Keep the distance range in order while it is typed: raising the minimum pulls the maximum up with it, and a
 * maximum entered below the minimum is raised to it.
 */
function clampDistance(panelEl, changed) {
  const minEl = panelEl.querySelector('[data-tg-field="minDistance"]');
  const maxEl = panelEl.querySelector('[data-tg-field="maxDistance"]');
  if (!minEl || !maxEl || (changed !== minEl && changed !== maxEl)) return;
  const min = Number(minEl.value);
  if (minEl.value === '' || !Number.isFinite(min)) return;
  if (maxEl.value === '' || Number(maxEl.value) < min) maxEl.value = String(min);
}

/**
 * Recheck the forced selectors and conditional controls, and rewrite the summary line. The summary is built from
 * the normalized spec so it describes what will actually happen, while the visibility rules read the raw values,
 * since those are what the user just chose.
 */
function refreshPanel(panelEl) {
  const context = panelEl.dataset.tgContext === 'step' ? 'step' : 'requirement';
  const custom = panelEl.querySelector('[data-tg-field="mover"]')?.value === 'custom';
  const reachEl = panelEl.querySelector('[data-tg-field="reach"]');
  forceSelect(reachEl, custom, 'teleport');
  const teleport = reachEl?.value === 'teleport';
  forceSelect(panelEl.querySelector('[data-tg-budget]'), teleport, 'none');
  const raw = readTerrainGeometryPanel(panelEl);
  const sizeEl = panelEl.querySelector('[data-tg-size]');
  if (sizeEl) sizeEl.hidden = !custom;
  const amountEl = panelEl.querySelector('[data-tg-budget-value]');
  if (amountEl) amountEl.hidden = !(!teleport && raw.budgetSource === 'custom');
  const summary = panelEl.querySelector('[data-tg-summary]');
  if (summary) summary.textContent = summarizeGeometry(normalizeGeometry(raw), { context });
}

/**
 * Write a template's geometry into the panel. Forced selectors are released first so the template's own values
 * become the ones remembered. Choosing Custom changes nothing.
 */
function applyPreset(panelEl, key) {
  const preset = presetGeometry(key);
  if (!preset) return;
  forceSelect(panelEl.querySelector('[data-tg-field="reach"]'), false, '');
  forceSelect(panelEl.querySelector('[data-tg-budget]'), false, '');
  writePanel(panelEl, normalizeGeometry(preset));
}

/**
 * Bind the geometry events once per dialog root, so panels drawn later work without new bindings. Choosing a
 * template fills the panel, and editing any field afterwards switches the template selector back to Custom.
 * @param {HTMLElement} rootEl    The dialog root.
 */
export function bindTerrainGeometryPanels(rootEl) {
  if (!rootEl || rootEl.dataset.tgBound === '1') return;
  rootEl.dataset.tgBound = '1';
  const markCustom = (panel) => {
    const presetSel = panel.querySelector('[data-tg-preset]');
    if (presetSel) presetSel.value = '';
  };
  rootEl.addEventListener('change', (ev) => {
    const panel = ev.target.closest?.('[data-tg-panel]');
    if (!panel) return;
    if (ev.target.matches?.('[data-tg-preset]')) {
      applyPreset(panel, ev.target.value);
    } else {
      clampDistance(panel, ev.target);
      markCustom(panel);
    }
    refreshPanel(panel);
  });
  rootEl.addEventListener('input', (ev) => {
    const panel = ev.target.closest?.('[data-tg-panel]');
    if (!panel || !ev.target.matches?.('input')) return;
    if (ev.target.dataset?.tgField === 'minDistance') clampDistance(panel, ev.target);
    markCustom(panel);
    refreshPanel(panel);
  });
}
