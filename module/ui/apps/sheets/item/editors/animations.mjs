/** @layer ui/apps/sheets/item/editors */
/*
 * The animation editor: the Sequencer steps an Item or an Armament Object plays for each slot and range. The field
 * tables below drive the step cards. Keys and value shapes the fields can't show stay in each card's Advanced JSON
 * box, so opening and saving the editor keeps authored data. openAnimationPayloadEditor reuses the same step list for
 * the animation on an effect step.
 */
import {
  STEP_KINDS,
  SLOT_KINDS,
  RANGE_KINDS,
  validate,
  validateSlot,
  empty,
  emptySlot,
  isPopulated
} from '../../../../../contracts/dsl/animations.mjs';
import { AnimationDispatcher } from '../../../../../external/sequencer/animation-dispatch.mjs';
import { openEditor } from '../../../../dialogs.mjs';
import { getTooltip } from '../../../../tooltips.mjs';
import { createCardList, parseCardJson, unparsedJsonErrors } from './card-list.mjs';
import { capitalize, escapeHtml } from '../../../../../lib/dom/html.mjs';
import { renderField, readField } from './fields.mjs';
import { createItemEditorNotifier } from '../../../../../presentation/interface/notifications.mjs';
import { SYSTEM_ID } from '../../../../../contracts/protocol.mjs';
import { SOUND_IDS } from '../../../../../presentation/audio/sound-database.mjs';
import { playMenuSound } from '../../../../../presentation/audio/service.mjs';
import {
  reportFoundryError,
  FoundryDiagnostics,
  reportFoundryProbe,
  reportFoundryValidation
} from '../../../../../foundry/adapters/services/diagnostics.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/editors/animation-editor.hbs`;
const notify = createItemEditorNotifier({ sourcePath: import.meta.url, diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Clipboard                                   */
/* -------------------------------------------- */

/**
 * The step clipboard. Every animation editor shares it, so steps can be copied between tabs and between items.
 * @type {object|null}
 */
let _clipboard = null;

/* -------------------------------------------- */
/*  Tabs                                        */
/* -------------------------------------------- */

/**
 * Map editor tabs to animation slots and ranges. Mount and dismount use activation melee and ranged slots.
 * @type {Record<string, object>}
 */
const TAB_DEFINITIONS = {
  'attack.melee':       { slot: 'attack',     range: 'melee',  label: 'Adjacent',  icon: 'fas fa-sword' },
  'attack.ranged':      { slot: 'attack',     range: 'ranged', label: 'Ranged',    icon: 'fas fa-bullseye-arrow' },
  'critical.melee':     { slot: 'critical',   range: 'melee',  label: 'Crit (Adj)',icon: 'fas fa-burst' },
  'critical.ranged':    { slot: 'critical',   range: 'ranged', label: 'Crit (Rng)',icon: 'fas fa-explosion' },
  'activation.melee':   { slot: 'activation', range: 'melee',  label: 'Adjacent',  icon: 'fas fa-bolt' },
  'activation.ranged':  { slot: 'activation', range: 'ranged', label: 'Ranged',    icon: 'fas fa-meteor' },
  'activation.self':    { slot: 'activation', range: 'self',   label: 'Self',      icon: 'fas fa-hand-sparkles' },
  'activation.mount':   { slot: 'activation', range: 'melee',  label: 'Mount',     icon: 'fas fa-horse' },
  'activation.dismount':{ slot: 'activation', range: 'ranged', label: 'Dismount',  icon: 'fas fa-person-walking' }
};

/**
 * The tabs an item gets: attack and critical, mount, or activation. An item that fits none of them gets every tab.
 * @param {Item|Actor} item       The item, or an Armament actor.
 */
function visibleTabKeysFor(item) {
  const { type } = item;
  const itemType = item.system.itemType;

  if (type === 'Object' && item.system.objectType === 'Armament') {
    return ['attack.melee', 'attack.ranged', 'critical.melee', 'critical.ranged'];
  }

  const isAttacker = (type === 'Equipment' && (itemType === 'Weapon' || itemType === 'Staff'))
    || (type === 'Spell' && itemType === 'Attack');
  if (isAttacker) return ['attack.melee', 'attack.ranged', 'critical.melee', 'critical.ranged'];

  if (type === 'Ability' && itemType === 'Mount') return ['activation.mount', 'activation.dismount'];

  const isActivator = (type === 'Spell' && itemType === 'Utility')
    || (type === 'Equipment' && itemType === 'Staff (U)')
    || type === 'Consumable'
    || type === 'Ability';
  if (isActivator) return ['activation.melee', 'activation.ranged', 'activation.self'];

  return Object.keys(TAB_DEFINITIONS);
}

/* -------------------------------------------- */
/*  Field Tables                                */
/* -------------------------------------------- */

/**
 * Descriptor shorthands. `renderField` reads `label`, `tooltip` (a tooltips.mjs id) and `unit` from each, so a
 * table row names what the card shows and where its help text comes from.
 */
const ms = (name, label, placeholder, tooltip) => ({ name, label, type: 'number', unit: 'ms', placeholder, tooltip });
const num = (name, label, placeholder, tooltip) => ({ name, label, type: 'number', placeholder, tooltip });
const sel = (name, label, options, tooltip) => ({ name, label, type: 'select', options, tooltip });

/**
 * The timing fields every step kind carries. A negative `waitUntilFinished` starts the next step that many
 * milliseconds early, so steps can overlap.
 * @type {object[]}
 */
const COMMON_FIELDS = [
  ms('delay', 'delay', '500', 'editor.anim.delay'),
  ms('duration', 'duration', '1000', 'editor.anim.duration'),
  ms('waitUntilFinished', 'wait until finished', '0', 'editor.anim.wait'),
  { name: 'perTarget', label: 'per target', type: 'checkbox', tooltip: 'editor.anim.per-target' }
];

/**
 * The fields on an effect step, used both to render and to read a card. `coveredKeys` lists the stored keys a
 * composite field handles, so they stay out of Advanced JSON.
 * @type {object[]}
 */
const EFFECT_FIELDS = [
  { name: 'file', label: 'file', type: 'text', placeholder: 'jb2a.fire_bolt.orange', tooltip: 'editor.anim.file' },
  {
    name: 'atLocation', label: 'at location', type: 'atLocation', tooltip: 'editor.anim.at-location',
    options: ['', 'token', 'target', 'target-endpoint', 'target-location', 'lastSpawned'],
    coveredKeys: ['atLocation', 'perTarget']
  },
  sel('attachTo', 'attach to', ['', 'token', 'target', 'lastSpawned'], 'editor.anim.attach-to'),
  sel('stretchTo', 'stretch to', ['', 'token', 'target', 'target-location', 'target-endpoint', 'lastSpawned'],
    'editor.anim.stretch-to'),
  sel('rotateTowards', 'rotate towards', ['', 'token', 'target', 'target-location', 'lastSpawned'],
    'editor.anim.rotate-towards'),
  num('rotate', 'rotation', '90', 'editor.anim.rotate'),
  { name: 'repeats', label: 'repeats', type: 'repeats', tooltip: 'editor.anim.repeats' },
  sel('layer', 'layer', ['', 'aboveInterface', 'aboveLighting', 'belowTokens'], 'editor.anim.layer'),
  num('scaleToObject', 'scale to token', '1.5', 'editor.anim.scale-to-object'),
  { name: 'scale', label: 'scale', type: 'scale', tooltip: 'editor.anim.scale' },
  num('playbackRate', 'speed', '1.0', 'editor.anim.playback-rate'),
  num('opacity', 'opacity', '1.0', 'editor.anim.opacity'),
  num('hue', 'hue', '90', 'editor.anim.hue'),
  ms('fadeIn', 'fade in', '500', 'editor.anim.fade-in'),
  ms('fadeOut', 'fade out', '500', 'editor.anim.fade-out'),
  {
    name: 'mirrors', label: 'mirror', type: 'mirrors', tooltip: 'editor.anim.mirrors',
    coveredKeys: ['mirrorX', 'mirrorY', 'randomizeMirrorX', 'randomizeMirrorY']
  },
  { name: 'spriteOffset', label: 'offset', type: 'offset', tooltip: 'editor.anim.offset' },
  ms('startTime', 'start at', '0', 'editor.anim.start-time'),
  ms('endTime', 'end at', '500', 'editor.anim.end-time')
];

/**
 * The fields on a sound step.
 * @type {object[]}
 */
const SOUND_FIELDS = [
  {
    name: 'file', label: 'file', type: 'text', tooltip: 'editor.anim.file',
    placeholder: `systems/${SYSTEM_ID}/sound/misc/chest-close.wav`
  },
  sel('audioChannel', 'channel', ['', 'environment', 'interface', 'music'], 'editor.anim.channel'),
  num('volume', 'volume', '0.5', 'editor.anim.volume'),
  ms('startTime', 'start at', '0', 'editor.anim.start-time'),
  ms('fadeInAudio', 'fade in', '500', 'editor.anim.fade-in-audio'),
  ms('fadeOutAudio', 'fade out', '500', 'editor.anim.fade-out-audio')
];

/**
 * The only field a wait step has.
 * @type {object[]}
 */
const WAIT_FIELDS = [ms('ms', 'wait', '500', 'editor.wait.ms')];

/**
 * The fields on a token-animation step, which moves or fades a token rather than drawing anything.
 * @type {object[]}
 */
const TOKEN_ANIM_FIELDS = [
  sel('target', 'target', ['token', 'target', 'lastSpawned'], 'editor.move.who'),
  num('opacity', 'opacity', '1.0', 'editor.anim.opacity'),
  num('rotation', 'rotation', '90', 'editor.anim.rotate'),
  ms('fadeIn', 'fade in', '500', 'editor.anim.fade-in'),
  ms('fadeOut', 'fade out', '500', 'editor.anim.fade-out')
];

/**
 * The field table for a step kind. An effect has no per-target field, since it already places itself per target
 * through its location reference, and offering both would be two ways to say one thing.
 */
function fieldsForKind(kind) {
  switch (kind) {
    case 'effect':    return [...EFFECT_FIELDS, ...COMMON_FIELDS.filter(f => f.name !== 'perTarget')];
    case 'sound':     return [...SOUND_FIELDS, ...COMMON_FIELDS];
    case 'wait':      return WAIT_FIELDS;
    case 'tokenAnim': return [...TOKEN_ANIM_FIELDS, ...COMMON_FIELDS];
    default: return COMMON_FIELDS;
  }
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * The finer step this editor's numeric fields take. The field markup itself is the shared `ed-field` that
 * `renderField` emits by default.
 * @type {object}
 */
const FIELD_STYLE = { numberStep: '0.01' };

/**
 * The kind names a card header shows. The code key stays in the header's tooltip.
 * @type {Record<string, string>}
 */
const KIND_LABELS = Object.freeze({ effect: 'Effect', sound: 'Sound', wait: 'Wait', tokenAnim: 'Token animation' });

/**
 * The shared card list bound to this editor's step markup. Here a pane's cards are its model: a delete, duplicate or
 * drag moves the elements themselves and `reindex` renumbers them. So only the paint, read and single-card render
 * parts are used, and a card's collapsed state stays where the user left it.
 * @type {object}
 */
const stepCards = createCardList({
  cardSelector: '.ed-card',
  renderCard: (step, index, context) => renderStepCard(step, index, context?.tabKey, { collapsed: context?.collapsed }),
  readCard: cardEl => readStepFromCard(cardEl),
  indexSelector: '.ed-card-idx'
});

/** Summarize a collapsed animation card by file, then location, or an empty marker. */
function summarizeStep(step) {
  if (step.kind === 'wait') return `${step.ms ?? 0}ms`;
  if (step.kind === 'tokenAnim') {
    const bits = [];
    if (typeof step.opacity === 'number')  bits.push(`opacity=${step.opacity}`);
    if (typeof step.rotation === 'number') bits.push(`rotate=${step.rotation}`);
    if (bits.length === 0) bits.push('(no-op)');
    return `${step.target ?? 'token'} | ${bits.join(' | ')}`;
  }
  const file = Array.isArray(step.file) ? `${step.file[0]} (+${step.file.length - 1})` : step.file;
  if (file) return file;
  const loc = step.atLocation || step.attachTo || step.stretchTo;
  return loc ? `→ ${loc}` : '(empty)';
}

/** Whether a field can show the stored value's shape. renderStepCard puts other shapes in Advanced JSON. */
function fieldCanRenderValue(field, value) {
  if (value === undefined || value === null) return true;
  switch (field.type) {
    case 'number':
      return typeof value === 'number';
    case 'checkbox':
      return typeof value === 'boolean';
    case 'select':
    case 'text':
      return typeof value === 'string';
    case 'offset':
    case 'repeats':
      return typeof value === 'object' && !Array.isArray(value);
    case 'scale':

      return typeof value === 'number'
        || (value && typeof value === 'object' && !Array.isArray(value));
    case 'atLocation':
    case 'mirrors':

      return true;
    default:
      return true;
  }
}

/**
 * Render an animation step card. Keys and value shapes the fields don't handle go in its Advanced JSON box.
 * @param {string} tabKey                         Which tab, used to make the field ids unique.
 * @param {object} [options]
 * @param {boolean} [options.collapsed]           Start collapsed.
 */
function renderStepCard(step, idx, tabKey, { collapsed = true } = {}) {
  const fields = fieldsForKind(step.kind);
  const visibleFieldDefs = new Map(fields.map(f => [f.name, f]));

  const coveredByComposite = new Map();
  for (const f of fields) {
    if (Array.isArray(f.coveredKeys)) {
      for (const k of f.coveredKeys) coveredByComposite.set(k, f);
    }
  }
  const advanced = {};
  for (const k of Object.keys(step)) {
    if (k === 'kind') continue;
    if (coveredByComposite.has(k)) continue;
    const def = visibleFieldDefs.get(k);
    if (!def || !fieldCanRenderValue(def, step[k])) advanced[k] = step[k];
  }

  const fieldOptions = { ...FIELD_STYLE, idPrefix: `anim-${tabKey.replace('.', '-')}-${idx}-` };
  const fieldsHtml = fields.map(f => {
    let html;
    if (Array.isArray(f.coveredKeys)) {
      const subset = {};
      for (const k of f.coveredKeys) if (step[k] !== undefined) subset[k] = step[k];
      html = renderField(f, Object.keys(subset).length ? subset : undefined, fieldOptions);
    } else {
      const v = fieldCanRenderValue(f, step[f.name]) ? step[f.name] : undefined;
      html = renderField(f, v, fieldOptions);
    }
    return f.name === 'file' ? `<div class="ed-span">${html}</div>` : html;
  }).join('');
  const advJson = Object.keys(advanced).length > 0 ? JSON.stringify(advanced, null, 2) : '';
  const collapsedCls = collapsed ? ' is-collapsed' : '';
  const summary = escapeHtml(summarizeStep(step));

  return `
    <div class="ed-card${collapsedCls}" data-step-idx="${idx}" data-step-kind="${escapeHtml(step.kind)}">
      ${renderCardHeader(step, idx, summary)}
      <div class="ed-card-body"><div class="ed-grid ed-grid--3">${fieldsHtml}</div></div>
      <details>
        <summary data-tooltip="${escapeHtml(getTooltip('editor.anim.advanced'))}">advanced json</summary>
        <textarea data-step-json rows="4" placeholder="{ }">${escapeHtml(advJson)}</textarea>
      </details>
    </div>`;
}

/**
 * The header row of a step card: grip, chevron, kind, ordinal, the collapsed summary and the two card actions.
 * `attachAnimationStepButtons` finds these controls by class, and reads `data-action` only to tell delete from
 * duplicate.
 * @param {string} summary        The summary line, already escaped.
 */
function renderCardHeader(step, idx, summary) {
  const kind = String(step.kind);
  const tip = (id, data) => escapeHtml(getTooltip(id, data));
  return `
      <div class="ed-card-header" data-action="toggle-collapse">
        <span class="ed-card-grip" draggable="true" data-tooltip="${tip('editor.card.drag')}">
          <i class="fas fa-grip-vertical"></i>
        </span>
        <button type="button" class="ed-card-chevron" data-action="toggle-collapse"
          data-tooltip="${tip('editor.card.collapse')}"><i class="fas fa-chevron-down"></i></button>
        <span class="ed-card-kind" data-tooltip="${tip('editor.card.kind', { kind })}">
          ${escapeHtml(KIND_LABELS[kind] ?? kind)}
        </span>
        <span class="ed-card-idx">#${idx + 1}</span>
        <span class="ed-card-summary">${summary}</span>
        <span class="ed-card-actions">
          <button type="button" class="ed-card-btn" data-action="duplicate"
            data-tooltip="${tip('editor.card.duplicate')}"><i class="fas fa-clone"></i></button>
          <button type="button" class="ed-card-btn ed-card-btn--delete" data-action="delete"
            data-tooltip="${tip('editor.card.delete')}"><i class="fas fa-trash"></i></button>
        </span>
      </div>`;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/**
 * Read the card's fields, leaving out empty values so Sequencer's defaults apply, and merge Advanced JSON last. Text
 * that doesn't parse adds nothing and stays in its box as typed: `refreshStepJson` marks it and disables Save,
 * `unparsedJsonRefused` refuses a save while it is there, and `warnUnparsedStepJson` warns before Copy or Preview.
 */
function readStepFromCard(card) {
  const kind = card.dataset.stepKind;
  if (!STEP_KINDS.includes(kind)) return null;
  const step = { kind };
  const fields = fieldsForKind(kind);
  for (const f of fields) {
    const input = card.querySelector(`[data-step-field="${f.name}"]`);
    if (!input) continue;
    const v = readField(f, input);
    if (v === undefined || v === '') continue;

    if (v && typeof v === 'object' && v.__keys && typeof v.__keys === 'object') {
      Object.assign(step, v.__keys);
    } else {
      step[f.name] = v;
    }
  }
  const { value: json } = parseCardJson(card.querySelector('[data-step-json]')?.value);
  if (json && typeof json === 'object') Object.assign(step, json);
  return step;
}

/**
 * The Advanced JSON boxes in one pane whose text doesn't parse, by the position of the step card holding each.
 * @returns {Array<{index: number, field: string, text: string}>}
 */
function unparsedStepJson(paneEl) {
  const unparsed = [];
  const cards = paneEl.querySelector('.ed-list')?.querySelectorAll(':scope > .ed-card') ?? [];
  cards.forEach((card, index) => {
    const { invalid } = parseCardJson(card.querySelector('[data-step-json]')?.value);
    if (invalid !== undefined) unparsed.push({ index, field: 'advanced json', text: invalid });
  });
  return unparsed;
}

/**
 * The refusal line for one pane's unparsed Advanced JSON. Steps are numbered per pane, so a tab of the slot editor
 * is named by its label, with its slot in front where two tabs share the label, as "Attack Adjacent" and
 * "Activation Adjacent" do.
 */
function stepJsonErrors(paneEl) {
  const tab = TAB_DEFINITIONS[paneEl.dataset.animPane];
  const labelRepeats = Object.values(TAB_DEFINITIONS).filter(other => other.label === tab?.label).length > 1;
  const name = labelRepeats ? `${capitalize(tab.slot)} ${tab.label}` : tab?.label;
  return unparsedJsonErrors(unparsedStepJson(paneEl), name ? `${name} step` : 'step');
}

/**
 * Warn once for each Advanced JSON box in a pane that doesn't parse, before Copy or Preview reads the pane's steps
 * without those keys. The box is parsed again so the diagnostic records the parser's own error.
 */
function warnUnparsedStepJson(paneEl) {
  for (const { text } of unparsedStepJson(paneEl)) {
    try { JSON.parse(text); } catch (err) {
      reportFoundryValidation(import.meta.url, err, 'Enter valid JSON in the animation step.');
    }
  }
}

/**
 * Refuse a save while any Advanced JSON box doesn't parse, rather than save its step without those keys. Save is
 * already disabled then, so this is the guard behind the button.
 * @returns {boolean}             Whether the save is refused.
 */
function unparsedJsonRefused(panes) {
  const errors = panes.flatMap(stepJsonErrors);
  if (errors.length) notify.error(`Animation is invalid: ${errors.join(' | ')}`);
  return errors.length > 0;
}

/**
 * Mark each Advanced JSON box whose text doesn't parse, and keep Save disabled while any does, naming the first such
 * step in the button's tooltip as the effect editor does. The text stays in its box, and no notification is shown.
 */
function refreshStepJson(html) {
  for (const box of html.querySelectorAll('textarea[data-step-json]')) {
    box.classList.toggle('is-invalid', 'invalid' in parseCardJson(box.value));
  }
  const errors = [...html.querySelectorAll('.anim-tab-pane')].flatMap(stepJsonErrors);
  const saveBtn = html.querySelector('button[data-action="save"]');
  if (!saveBtn) return;
  saveBtn.disabled = errors.length > 0;
  if (errors.length) saveBtn.dataset.tooltip = getTooltip('editor.save-disabled', { error: errors[0] });
  else delete saveBtn.dataset.tooltip;
}

/** Read every step in a pane, in card order. The step reader ignores the `tabKey` it is passed. */
function readStepsFromDom(paneEl, tabKey) {
  return stepCards.read(paneEl.querySelector('.ed-list'), { tabKey });
}

/** Refresh a card's summary line after an edit. */
function updateCardSummary(card) {
  const step = readStepFromCard(card);
  if (!step) return;
  const summaryEl = card.querySelector('.ed-card-summary');
  if (summaryEl) summaryEl.textContent = summarizeStep(step);
}

function readDurationFromDom(paneEl) {
  const inp = paneEl.querySelector('.anim-duration-input');
  return parseFloat(inp?.value) || 0;
}

/* -------------------------------------------- */
/*  Payloads                                    */
/* -------------------------------------------- */

/** Build one tab's animation payload, or null where it has no steps. */
function buildPayloadFromTab(paneEl, tabKey) {
  const steps = readStepsFromDom(paneEl, tabKey);
  if (steps.length === 0) return null;
  const payload = { steps };
  const dur = readDurationFromDom(paneEl);
  if (dur > 0) payload.duration = dur;
  return payload;
}

/**
 * Collect the slot payloads for the Item update. A slot with no populated range is left out, so playback can tell
 * that the slot has no animation.
 */
function collectSlotPayloads(tabs, dialogEl) {

  const anim = { attack: emptySlot(), critical: emptySlot(), activation: emptySlot() };
  for (const t of tabs) {
    const pane = dialogEl.querySelector(`.anim-tab-pane[data-anim-pane="${t.key}"]`);
    if (!pane) continue;
    const def = TAB_DEFINITIONS[t.key];
    anim[def.slot][def.range] = buildPayloadFromTab(pane, t.key);
  }

  for (const slot of SLOT_KINDS) {
    if (RANGE_KINDS.every(range => anim[slot][range] === null)) delete anim[slot];
  }
  return anim;
}

/**
 * The update that writes these slots at `system.anim`, where an Item and an Armament Actor both keep them, with each
 * removed slot set to null. persistAnim applies it.
 * @param {object} anim                   The slot payloads.
 * @returns {object}
 */
function animationUpdate(anim) {
  const updates = {};
  for (const slot of SLOT_KINDS) updates[`system.anim.${slot}`] = anim[slot] ?? null;
  return updates;
}

async function persistAnim(it, anim) {
  await it.update(animationUpdate(anim));
}

/* -------------------------------------------- */
/*  Step Lists                                  */
/* -------------------------------------------- */

/** The stored animation for one slot and range, or an empty one. */
function readPayload(item, slot, range) {
  const data = foundry.utils.getProperty(item, `system.anim.${slot}.${range}`);
  if (isPopulated(data)) return data;
  return empty();
}

/** Draw a pane's step list from a payload. */
function paintStepList(paneEl, payload) {
  const tabKey = paneEl.dataset.animPane;
  stepCards.paint(paneEl.querySelector('.ed-list'), payload?.steps ?? [], { tabKey });
}

/** Add steps to the end of a pane's list, continuing its numbering. */
function appendStepList(paneEl, steps) {
  const list = paneEl.querySelector('.ed-list');
  const tabKey = paneEl.dataset.animPane;
  let idx = list.querySelectorAll('.ed-card').length;
  for (const s of steps) {
    list.insertAdjacentHTML('beforeend', stepCards.renderOne(s, idx, { tabKey }));
    idx++;
  }
}

/**
 * One pane's toolbar and empty step list. `openAnimationEditorDialog` hands this to the template per tab and
 * `openAnimationPayloadEditor` inlines it, so both dialogs draw the same toolbar and `attachStepListHandlers` finds
 * the same controls in each.
 * @param {string} tabKey         Which tab, written onto every control the handlers read it from.
 * @param {number} duration       The stored duration.
 */
function renderPaneMarkup(tabKey, duration) {
  const key = escapeHtml(tabKey);
  const tip = id => escapeHtml(getTooltip(id));
  const addButton = (kind, icon, tipId) => `
        <button type="button" class="ed-btn ed-btn--accent anim-add-step" data-anim-tab="${key}"
          data-step-kind="${kind}" data-tooltip="${tip(tipId)}"><i class="fas ${icon}"></i> ${kind}</button>`;
  const iconButton = (cls, icon, tipId) => `
        <button type="button" class="anim-pane-btn ${cls}" data-anim-tab="${key}" data-tooltip="${tip(tipId)}">
          <i class="fas ${icon}"></i>
        </button>`;
  return `
      <div class="anim-pane-toolbar">
        <label class="ed-field" style="width:110px">
          <span class="ed-label" data-tooltip="${tip('animation.duration')}">duration</span>
          <span class="ed-with-unit" data-unit="ms">
            <input type="number" class="anim-duration-input" value="${escapeHtml(duration)}"
              min="0" step="50" placeholder="0" />
          </span>
        </label>
        ${addButton('effect', 'fa-plus', 'animation.add-effect-step')}
        ${addButton('sound', 'fa-volume-high', 'animation.add-sound-step')}
        ${addButton('wait', 'fa-hourglass-half', 'animation.add-wait-step')}
        <span class="anim-pane-spacer"></span>
        ${iconButton('anim-copy', 'fa-copy', 'animation.copy-tab')}
        ${iconButton('anim-paste', 'fa-paste', 'animation.paste-tab')}
        ${iconButton('anim-preview', 'fa-play', 'animation.preview-tab')}
      </div>
      <div class="ed-list" data-anim-tab="${key}"></div>`;
}

const SOUND_PATH = `systems/${SYSTEM_ID}/sound/`;

/* -------------------------------------------- */
/*  Preview Targeting                           */
/* -------------------------------------------- */

/**
 * The location references that mean a square, which a preview has to be given by clicking.
 * @type {Set<string>}
 */
const LOCATION_PICK_REFS = new Set(['target-location', 'target-endpoint']);

/**
 * The references that mean a token, which a preview takes from the user's current target.
 * @type {Set<string>}
 */
const TARGET_TOKEN_REFS = new Set(['target', 'token-facing-target']);
const LOCATION_FIELDS = ['atLocation', 'attachTo', 'stretchTo', 'rotateTowards', 'moveTowards'];

/**
 * What a preview of these steps needs the user to supply: 'location', 'target' or 'none'. A location wins over a
 * target, since a square can stand in for a token but not the reverse.
 */
function classifyTargetingNeed(steps) {
  let needsLocation = false;
  let needsTarget = false;
  for (const s of steps) {
    for (const field of LOCATION_FIELDS) {
      const ref = s[field];
      if (!ref) continue;
      if (LOCATION_PICK_REFS.has(ref)) needsLocation = true;
      else if (TARGET_TOKEN_REFS.has(ref)) needsTarget = true;
    }
  }
  if (needsLocation) return 'location';
  if (needsTarget) return 'target';
  return 'none';
}

/**
 * Wait for a click on a canvas square for the animation preview, and swallow the click before it selects a Token.
 * The point snaps to the cell center, and the listener is removed on timeout.
 * @returns {Promise<{x: number, y: number}|null>} The cell center, or null if nothing was clicked in time.
 */
async function awaitCanvasClickPosition(timeoutMs) {
  const view = canvas?.app?.view;
  if (!view) return null;

  return new Promise(resolve => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      view.removeEventListener('pointerdown', onClick, true);
      view.style.cursor = '';
    };

    const onClick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const t = canvas.stage.worldTransform;
      const worldX = (ev.clientX - t.tx) / t.a;
      const worldY = (ev.clientY - t.ty) / t.d;
      const gs = canvas.grid?.size ?? 100;
      const snapX = Math.floor(worldX / gs) * gs + gs / 2;
      const snapY = Math.floor(worldY / gs) * gs + gs / 2;
      cleanup();
      resolve({ x: snapX, y: snapY });
    };

    timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    view.style.cursor = 'crosshair';
    view.addEventListener('pointerdown', onClick, true);
  });
}

/** The preview's range in grid squares (the larger of the two axis distances), at least 1. */
function gridDistance(source, target) {
  const gs = canvas?.grid?.size ?? 100;
  const sx = source.center?.x ?? source.x;
  const sy = source.center?.y ?? source.y;
  const tx = target.center?.x ?? target.x;
  const ty = target.center?.y ?? target.y;
  const dx = Math.abs(tx - sx) / gs;
  const dy = Math.abs(ty - sy) / gs;

  return Math.max(1, Math.round(Math.max(dx, dy)));
}

/* -------------------------------------------- */
/*  Preview                                     */
/* -------------------------------------------- */

/**
 * Play the tab's animation on the canvas. A source token has to be selected, since almost every step anchors to
 * one. Whether a target or a clicked square is also needed is worked out from the steps rather than asked up front.
 */
async function runPreview(tabKey, editorHtml) {
  const pane = editorHtml.querySelector(`.anim-tab-pane[data-anim-pane="${tabKey}"]`);
  if (!pane) {
    notify.warn('Editor tab not found.');
    return;
  }
  warnUnparsedStepJson(pane);
  const steps = readStepsFromDom(pane, tabKey);
  if (steps.length === 0) {
    notify.warn('No steps to preview.');
    return;
  }
  const duration = readDurationFromDom(pane);

  const source = canvas?.tokens?.controlled?.[0];
  if (!source) {
    notify.warn('Select a token to act as the preview source.');
    return;
  }

  const isSelfTab = TAB_DEFINITIONS[tabKey]?.range === 'self';

  let targetRef;
  const need = classifyTargetingNeed(steps);
  if (isSelfTab && need !== 'location') {
    targetRef = source;
  } else if (need === 'location') {
    notify.info('Click a square within 5 seconds to set the preview target.');
    const point = await awaitCanvasClickPosition(5000);
    if (!point) {
      notify.warn('Preview cancelled: no square clicked.');
      return;
    }
    const gs = canvas.grid?.size ?? 100;

    targetRef = {
      x: point.x - gs / 2,
      y: point.y - gs / 2,
      center: point,
      name: '(picked square)'
    };
  } else if (need === 'target') {
    const targets = [...game.user.targets];
    if (targets.length === 0) {
      notify.warn('Target a token to preview against.');
      return;
    }
    targetRef = targets[0];
  } else {

    targetRef = {
      x: source.x ?? 0,
      y: source.y ?? 0,
      center: source.center ?? { x: source.x ?? 0, y: source.y ?? 0 },
      name: '(self)'
    };
  }

  const distance = isSelfTab ? 0 : (need === 'none' ? 1 : gridDistance(source, targetRef));

  const gs = canvas.grid?.size ?? 100;
  const tlPixel = targetRef.center ?? { x: (targetRef.x ?? 0) + gs / 2, y: (targetRef.y ?? 0) + gs / 2 };
  const ctx = {
    token: source,
    target: targetRef,
    targetLocation: { x: Math.floor(tlPixel.x / gs), y: Math.floor(tlPixel.y / gs) },
    distance,
    path: SOUND_PATH
  };
  const payload = { steps };
  if (duration > 0) payload.duration = duration;
  await AnimationDispatcher.play(payload, ctx, { preview: true });

  if (duration > 0) {
    setTimeout(() => playMenuSound(SOUND_IDS.ANIMATION_TIMING_MARKER), duration);
  }
}

/* -------------------------------------------- */
/*  Handlers                                    */
/* -------------------------------------------- */

/**
 * Bind the step controls on the dialog root, so cards that are drawn again keep working without new bindings. A
 * click on a drag handle is swallowed, and a duplicated card keeps its collapsed state.
 */
function attachStepListHandlers(html) {
  attachAnimationStepButtons(html);
  attachAnimationStepSummaries(html);
  attachAnimationStepDragging(html);
  attachStepJsonChecks(html);
}

/** Clicks on the step cards (delete, duplicate, collapse) and on the pane toolbars (add, copy, paste, preview). */
function attachAnimationStepButtons(html) {
  html.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.ed-card-btn');
    if (btn) {
      ev.stopPropagation();
      const card = btn.closest('.ed-card');
      const list = card.parentElement;
      const action = btn.dataset.action;
      if (action === 'delete') { card.remove(); stepCards.reindex(list); return; }
      if (action === 'duplicate') {
        const tabKey = card.closest('.anim-tab-pane')?.dataset.animPane ?? '';
        const step = readStepFromCard(card);
        if (step) {
          const collapsed = card.classList.contains('is-collapsed');
          card.insertAdjacentHTML('afterend',
            stepCards.renderOne(step, Number(card.dataset.stepIdx) + 1, { tabKey, collapsed }));
          // Unfinished Advanced JSON is not part of the step read, so the copy is given the typed text itself.
          const typed = card.querySelector('[data-step-json]');
          const copied = card.nextElementSibling.querySelector('[data-step-json]');
          if ('invalid' in parseCardJson(typed.value)) copied.value = typed.value;
          stepCards.reindex(list);
        }
        return;
      }
    }

    if (ev.target.closest('.ed-card-grip')) {
      ev.stopPropagation();
      return;
    }

    const header = ev.target.closest('.ed-card-header');
    if (header && !ev.target.closest('.ed-card-actions')) {
      const card = header.closest('.ed-card');
      if (card) card.classList.toggle('is-collapsed');
      return;
    }

    const addBtn = ev.target.closest('.anim-add-step');
    if (addBtn) {
      const tabKey = addBtn.dataset.animTab;
      const kind = addBtn.dataset.stepKind;
      const pane = html.querySelector(`.anim-tab-pane[data-anim-pane="${tabKey}"]`);
      const list = pane.querySelector('.ed-list');
      const newIdx = list.querySelectorAll('.ed-card').length;
      const stub = { kind };
      list.insertAdjacentHTML('beforeend', stepCards.renderOne(stub, newIdx, { tabKey, collapsed: false }));
      const newCard = list.lastElementChild;
      newCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const copyBtn = ev.target.closest('.anim-copy');
    if (copyBtn) {
      const tabKey = copyBtn.dataset.animTab;
      const pane = html.querySelector(`.anim-tab-pane[data-anim-pane="${tabKey}"]`);

      warnUnparsedStepJson(pane);
      const steps = foundry.utils.deepClone(readStepsFromDom(pane, tabKey));
      const duration = readDurationFromDom(pane);
      _clipboard = { steps, duration, sourceTab: tabKey };
      notify.info(`Copied ${steps.length} step${steps.length === 1 ? '' : 's'} from ${tabKey}.`);
      return;
    }

    const pasteBtn = ev.target.closest('.anim-paste');
    if (pasteBtn) {
      if (!_clipboard) {
        notify.warn('Nothing to paste.');
        return;
      }
      const tabKey = pasteBtn.dataset.animTab;
      const pane = html.querySelector(`.anim-tab-pane[data-anim-pane="${tabKey}"]`);
      const existingCount = pane.querySelectorAll('.ed-card').length;
      const pasteCount = _clipboard.steps.length;

      let mode = 'overwrite';
      if (existingCount > 0) {
        mode = await foundry.applications.api.DialogV2.wait({
          window: { title: 'Paste animation steps?' },
          classes: [SYSTEM_ID],
          content: `<p>The <strong>${tabKey}</strong> tab already has <strong>${existingCount}</strong> step${existingCount === 1 ? '' : 's'}. Paste <strong>${pasteCount}</strong> step${pasteCount === 1 ? '' : 's'} copied from <strong>${_clipboard.sourceTab}</strong>:</p>`,
          buttons: [
            { action: 'add', icon: 'fas fa-plus', label: 'Add to End', default: true },
            { action: 'overwrite', icon: 'fas fa-arrows-rotate', label: 'Overwrite' },
            { action: 'cancel', icon: 'fas fa-times', label: 'Cancel' }
          ],
          rejectClose: false,
          modal: true
        });
        if (!mode || mode === 'cancel') return;
      }

      const pastedSteps = foundry.utils.deepClone(_clipboard.steps);
      if (mode === 'add') {
        appendStepList(pane, pastedSteps);
      } else {
        paintStepList(pane, { steps: pastedSteps });
        if (_clipboard.duration > 0) {
          const dur = pane.querySelector('.anim-duration-input');
          if (dur) dur.value = _clipboard.duration;
        }
      }
      refreshStepJson(html);
      notify.info(`Pasted ${pastedSteps.length} step${pastedSteps.length === 1 ? '' : 's'} into ${tabKey}.`);
      return;
    }

    const previewBtn = ev.target.closest('.anim-preview');
    if (previewBtn) {
      const tabKey = previewBtn.dataset.animTab;
      runPreview(tabKey, html).catch(err => {
        reportFoundryError(import.meta.url, err, 'emblem-rpg | Preview failed:');
      });
      return;
    }
  });
}

/** Keep each card's one-line summary in step with its fields. */
function attachAnimationStepSummaries(html) {
  const refreshSummary = (ev) => {
    const card = ev.target.closest?.('.ed-card');
    if (card) updateCardSummary(card);
  };
  html.addEventListener('input', refreshSummary);
  html.addEventListener('change', refreshSummary);
}

/**
 * Check every Advanced JSON box as it is typed in, and after a click that deletes or duplicates a card. A paste and
 * a drag run the check themselves: a paste can wait on a confirmation before it replaces the cards, and a drag
 * renumbers them without a click.
 */
function attachStepJsonChecks(html) {
  const refresh = () => refreshStepJson(html);
  for (const type of ['input', 'change', 'click']) html.addEventListener(type, refresh);
}

/** Let a step card be dragged to a new position in its list. */
function attachAnimationStepDragging(html) {
  let dragCard = null;
  html.addEventListener('dragstart', (ev) => {
    const handle = ev.target.closest('.ed-card-grip');
    if (!handle) return;
    dragCard = handle.closest('.ed-card');
    if (!dragCard) return;
    dragCard.classList.add('is-dragging');
    ev.dataTransfer.effectAllowed = 'move';
    // A browser that refuses either call still drags: the card is found again from the event target.
    try { ev.dataTransfer.setData('text/plain', dragCard.dataset.stepIdx ?? ''); } catch (diagnosticError) {
      reportFoundryProbe(import.meta.url, diagnosticError, 'attachAnimationStepDragging', true);
    }
    try { ev.dataTransfer.setDragImage(dragCard, 16, 12); } catch (diagnosticError) {
      reportFoundryProbe(import.meta.url, diagnosticError, 'attachAnimationStepDragging', true);
    }
  });
  html.addEventListener('dragover', (ev) => {
    if (!dragCard) return;
    const list = dragCard.parentElement;
    const overCard = ev.target.closest('.ed-card');
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    if (!overCard || overCard === dragCard || overCard.parentElement !== list) return;
    const rect = overCard.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height / 2;
    list.insertBefore(dragCard, after ? overCard.nextElementSibling : overCard);
  });
  html.addEventListener('drop', (ev) => {
    if (dragCard) ev.preventDefault();
  });
  html.addEventListener('dragend', () => {
    if (!dragCard) return;
    const list = dragCard.parentElement;
    dragCard.classList.remove('is-dragging');
    stepCards.reindex(list);
    refreshStepJson(html);
    dragCard = null;
  });
}

/* -------------------------------------------- */
/*  Animation Editor                            */
/* -------------------------------------------- */

/**
 * Open the animation editor from the Item sheet, the Object sheet (for an Armament) or the Item directory menu.
 * Every slot is validated with the animation contract before saving.
 * @param {Item|Actor} item               The item, or an Armament actor.
 * @returns {Promise<void>}
 */
export async function openAnimationEditorDialog(item) {

  const visibleKeys = visibleTabKeysFor(item);
  const tabs = visibleKeys.map(key => {
    const def = TAB_DEFINITIONS[key];
    const payload = readPayload(item, def.slot, def.range);
    return {
      key,
      slot: def.slot,
      range: def.range,
      label: def.label,
      icon: def.icon,
      paneHtml: renderPaneMarkup(key, payload.duration ?? 0),
      _payload: payload
    };
  });

  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, { tabs });

  return openEditor({
    document: item,
    title: `Animation Settings: ${item.name}`,
    icon: 'fas fa-film',
    width: 760,
    height: 720,
    resizable: true,
    classes: ['dialog-animation-editor'],
    content,
    gather: (root) => {
      if (unparsedJsonRefused([...root.querySelectorAll('.anim-tab-pane')])) return undefined;
      const anim = collectSlotPayloads(tabs, root);
      for (const [slot, slotData] of Object.entries(anim)) {
        const r = validateSlot(slotData);
        if (!r.valid) {
          notify.error(`Animation "${slot}" is invalid: ${r.errors.join(' | ')}`);
          return undefined;
        }
      }
      return anim;
    },
    apply: (anim) => persistAnim(item, anim),
    wire: (html) => {
      for (const t of tabs) {
        const pane = html.querySelector(`.anim-tab-pane[data-anim-pane="${t.key}"]`);
        if (pane) paintStepList(pane, t._payload);
      }
      html.querySelectorAll('.anim-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.animTab;
          html.querySelectorAll('.anim-tab-btn').forEach(b => b.classList.toggle('is-active', b.dataset.animTab === target));
          html.querySelectorAll('.anim-tab-pane').forEach(p => p.classList.toggle('is-hidden', p.dataset.animPane !== target));
        });
      });
      attachStepListHandlers(html);
    }
  });
}

/**
 * Edit the animation on one effect step, without the Item's slots and ranges. Called by the effect editor
 * (effects.mjs). An animation the contract refuses shows its errors and keeps the dialog open.
 * @param {object} payload                        The animation.
 * @param {object} [options]
 * @param {string} [options.title]                Window title.
 * @param {object|null} [options.document]        The document being edited, for openEditor's edit-rights check.
 * @returns {Promise<object|null>}                The edited animation, or null.
 */
export async function openAnimationPayloadEditor(payload, { title = 'Edit Animation', document = null } = {}) {

  const initial = isPopulated(payload) ? foundry.utils.deepClone(payload) : empty();
  const paneKey = 'payload';

  const content = `
    <div class="ed-container ed-anim-container">
      <div class="anim-tab-pane" data-anim-pane="${paneKey}">
        ${renderPaneMarkup(paneKey, initial.duration ?? 0)}
      </div>
    </div>`;

  const result = await openEditor({
    document,
    title,
    width: 720,
    height: 600,
    resizable: true,
    classes: ['dialog-animation-editor'],
    content,
    gather: (root) => {
      const pane = root.querySelector(`.anim-tab-pane[data-anim-pane="${paneKey}"]`);
      if (!pane) return null;
      if (unparsedJsonRefused([pane])) return undefined;
      const steps = readStepsFromDom(pane, paneKey);
      if (steps.length === 0) return empty();
      const out = { steps };
      const dur = readDurationFromDom(pane);
      if (dur > 0) out.duration = dur;

      const r = validate(out);
      if (!r.valid) {
        notify.error(`Animation is invalid: ${r.errors.join(' | ')}`);
        return undefined;
      }
      return out;
    },
    wire: (html) => {
      const pane = html.querySelector(`.anim-tab-pane[data-anim-pane="${paneKey}"]`);
      if (pane) paintStepList(pane, initial);

      attachStepListHandlers(html);
    }
  });

  return (result && typeof result === 'object' && Array.isArray(result.steps)) ? result : null;
}
