/** @layer ui/apps/sheets/item/editors */
/*
 * The uses and range scaling dialog, opened by openScalingEditor (dialogs.mjs) with the Item paths to edit. A
 * factor (level, proficiency, stat or skill) combines with a threshold table, a multiple, an addition or a formula,
 * and the preview evaluates the result against the Item's owner with the game's scaling rules.
 */
import { openEditor } from '../../../../dialogs.mjs';
import { getTooltip } from '../../../../tooltips.mjs';
import { SYSTEM_ID } from '../../../../../contracts/protocol.mjs';
import { WEAPON_PROFICIENCIES as PROFICIENCY_NAMES } from '../../../../../contracts/domains/items.mjs';
import { evaluateScaling, isScalingActive } from '../../../../../game/items/rules.mjs';
import { parseAttackRange } from '../../../../../game/targeting/attack-grid.mjs';
import { capitalize } from '../../../../../lib/dom/html.mjs';

/** The stats a Stat factor can measure. */
const SAVE_TYPES = Object.freeze(['mgt', 'agi', 'tqn', 'wit', 'cha']);
/** The skills a Skill factor can measure. */
const SKILL_KEYS = Object.freeze([
  'athletics', 'finesse', 'trading', 'civics', 'handicraft',
  'sociability', 'command', 'nature', 'perception', 'performance', 'reason', 'esoteric'
]);

const TEMPLATE = `systems/${SYSTEM_ID}/templates/editors/uses-formula.hbs`;

/* -------------------------------------------- */
/*  Factors                                     */
/* -------------------------------------------- */

/**
 * How each factor is described in the preview, spelling out what it reads.
 * @type {Record<string, string>}
 */
const FACTOR_LABELS = {
  None: 'None',
  Level: 'Actor level',
  Proficiency: 'Proficiency total',
  Stat: 'Stat (value + class)',
  Skill: 'Skill (value + class)'
};

/** The subjects a factor can measure, or none for a factor that needs no subject. */
function subjectOptionsFor(factor) {
  if (factor === 'Proficiency') return PROFICIENCY_NAMES;
  if (factor === 'Stat') return SAVE_TYPES;
  if (factor === 'Skill') return SKILL_KEYS;
  return [];
}

/** The subject a factor starts with when it is first chosen. */
function defaultSubjectFor(factor) {
  const opts = subjectOptionsFor(factor);
  return opts[0] || '';
}

/* -------------------------------------------- */
/*  Painting                                    */
/* -------------------------------------------- */

/** Fill the factor selector, offering None only where the caller allows a value that doesn't scale. */
function paintFactorOptions(dialogEl, opts) {
  const sel = dialogEl.querySelector('.us-factor');
  if (!sel) return;
  const factors = opts.includeNone
    ? ['None', 'Level', 'Proficiency', 'Stat', 'Skill']
    : ['Level', 'Proficiency', 'Stat', 'Skill'];
  sel.innerHTML = factors.map(f => `<option value="${f}">${f}</option>`).join('');
}

/**
 * Fill the subject selector for the chosen factor, or hide it for a factor that needs none. A subject left over from
 * another factor is corrected in the working state as well as the selector, so the two always agree.
 */
function paintSubject(dialogEl, state) {
  const factor = state.scaling.factor;
  const subjectEl = dialogEl.querySelector('.us-subject');
  if (!subjectEl) return;
  const opts = subjectOptionsFor(factor);
  if (opts.length === 0) {
    subjectEl.hidden = true;
    subjectEl.innerHTML = '';
    return;
  }
  subjectEl.hidden = false;
  subjectEl.innerHTML = opts.map(o => {
    const label = capitalize(o);
    return `<option value="${o}"${o === state.scaling.subject ? ' selected' : ''}>${label}</option>`;
  }).join('');
  if (!opts.includes(state.scaling.subject)) {
    state.scaling.subject = opts[0];
    subjectEl.value = opts[0];
  }
}

/** Show only the chosen type's section. A factor of None hides the type row and every section. */
function paintTypeSections(dialogEl, state, opts) {
  const isNone = opts.includeNone && state.scaling.factor === 'None';

  const typeRow = dialogEl.querySelector('.us-type-row');
  if (typeRow) typeRow.hidden = isNone;

  dialogEl.querySelectorAll('.us-type-section').forEach(sec => {
    const showFor = sec.dataset.section;
    sec.hidden = isNone || showFor !== state.scaling.type;
  });
}

/* -------------------------------------------- */
/*  Uses type                                   */
/* -------------------------------------------- */

/**
 * Show the base for limited and conditional uses, the scaling fields only for conditional uses, and neither for
 * infinite uses. The preview also needs an owner to evaluate against, so it stays hidden on an unowned item.
 */
function applyUsesTypeVisibility(dialogEl, state, opts) {
  if (!opts.usesTypePath) return;
  const ut = state.usesType || 'limited';
  const conditional = ut === 'conditional';
  const showBase = ut !== 'infinite';

  const setHidden = (sel, hide) => { const n = dialogEl.querySelector(sel); if (n) n.hidden = hide; };
  setHidden('.us-factor-row', !conditional);
  setHidden('.us-type-row', !conditional);
  setHidden('.us-preview-section', !conditional || !state.hasActor);
  setHidden('.us-section', !showBase);
  setHidden('.us-base-row', !showBase);

  if (conditional) paintTypeSections(dialogEl, state, opts);
  else dialogEl.querySelectorAll('.us-type-section').forEach(s => { s.hidden = true; });
}

/* -------------------------------------------- */
/*  Thresholds                                  */
/* -------------------------------------------- */

/** One row of the threshold table: the factor value it triggers at, and the result at that value. */
function renderThresholdRow(t, idx) {
  return `
    <div class="us-threshold-row" data-threshold-index="${idx}">
      <span class="us-threshold-prefix"><i class="fas fa-hashtag"></i></span>
      <input type="number" class="us-threshold-at" step="1" value="${Number(t.at) || 0}"
        data-tooltip="${getTooltip('editor.scaling.threshold-at')}" />
      <span class="us-threshold-sep">:</span>
      <input type="number" class="us-threshold-uses" step="1" value="${Number(t.uses) || 0}"
        data-tooltip="${getTooltip('editor.scaling.threshold-uses')}" />
      <button type="button" class="us-threshold-del" data-tooltip="${getTooltip('editor.scaling.threshold-delete')}">
        <i class="fas fa-trash"></i>
      </button>
    </div>`;
}

function paintThresholds(dialogEl, state) {
  const wrap = dialogEl.querySelector('.us-thresholds');
  if (!wrap) return;
  const list = state.scaling.thresholds;
  wrap.innerHTML = list.map((t, i) => renderThresholdRow(t, i)).join('');
}

/** Read the threshold table back, treating an unparseable field as zero rather than dropping the row. */
function readThresholdsFromDom(dialogEl) {
  const rows = dialogEl.querySelectorAll('.us-threshold-row');
  const out = [];
  rows.forEach(row => {
    const at = parseInt(row.querySelector('.us-threshold-at')?.value, 10);
    const uses = parseInt(row.querySelector('.us-threshold-uses')?.value, 10);
    out.push({ at: Number.isNaN(at) ? 0 : at, uses: Number.isNaN(uses) ? 0 : uses });
  });
  return out;
}

/* -------------------------------------------- */
/*  State Sync                                  */
/* -------------------------------------------- */

/**
 * Read every field back into the working state. The add-to-base checkbox is read from the selected type's section
 * only, since each type renders its own copy and only the visible one shows what was chosen.
 */
function syncStateFromDom(dialogEl, state) {
  const factor = dialogEl.querySelector('.us-factor')?.value || 'Level';
  const type = dialogEl.querySelector('.us-type')?.value || 'Additive';
  const subject = dialogEl.querySelector('.us-subject')?.value || '';
  const base = parseInt(dialogEl.querySelector('.us-base')?.value, 10);
  const multiplier = parseInt(dialogEl.querySelector('.us-multiplier')?.value, 10);
  const formula = dialogEl.querySelector('.us-formula')?.value ?? '';
  const addToBase = !!dialogEl.querySelector(`.us-type-section[data-section="${type}"] .us-add-to-base`)?.checked;
  const roundDown = !!dialogEl.querySelector('.us-round-down')?.checked;

  state.scaling.factor = factor;
  state.scaling.type = type;
  state.scaling.subject = subject;
  state.scaling.multiplier = Number.isNaN(multiplier) ? 1 : multiplier;
  state.scaling.formula = formula;
  state.scaling.addToBase = addToBase;
  state.scaling.roundDown = roundDown;
  state.scaling.thresholds = readThresholdsFromDom(dialogEl);
  state.base = Math.max(1, Number.isNaN(base) ? 1 : base);

  const losEl = dialogEl.querySelector('.us-los-rule');
  if (losEl) state.losRule = losEl.value;

  const utEl = dialogEl.querySelector('.us-uses-type');
  if (utEl) state.usesType = utEl.value;
}

/** Copy the add-to-base value into every type's copy of the checkbox, so switching type keeps the choice. */
function refreshAddToBaseCheckboxes(dialogEl, state) {
  dialogEl.querySelectorAll('.us-type-section .us-add-to-base').forEach(cb => {
    cb.checked = !!state.scaling.addToBase;
  });
}

function refreshRoundDownCheckbox(dialogEl, state) {
  const cb = dialogEl.querySelector('.us-round-down');
  if (cb) cb.checked = !!state.scaling.roundDown;
}

/** Put the multiplier, the formula and the base back into the form after a repaint. */
function refreshSecondaryFields(dialogEl, state) {
  const m = dialogEl.querySelector('.us-multiplier');
  if (m) m.value = Number(state.scaling.multiplier) || 1;
  const f = dialogEl.querySelector('.us-formula');
  if (f) f.value = state.scaling.formula || '';
  const b = dialogEl.querySelector('.us-base');
  if (b) b.value = Math.max(1, Number(state.base) || 1);
}

/* -------------------------------------------- */
/*  Preview                                     */
/* -------------------------------------------- */

/**
 * Evaluate the scaling against the item's owner and show the result. An unowned item can't be previewed, and the
 * dialog hides its preview section, so nothing is written. A scaling that isn't active previews as the plain base,
 * because that is the value it produces.
 * @param {Actor|null} actor              The item's owner, or null for an unowned item.
 */
function updatePreview(dialogEl, state, item, actor, opts) {
  const previewEl = dialogEl.querySelector('.us-preview');
  if (!previewEl) return;

  const factor = state.scaling.factor;
  const subject = state.scaling.subject;
  const typeLabel = state.scaling.type;
  const subjectLabel = subject ? ` (${subject})` : '';
  const isNone = opts.includeNone && factor === 'None';

  let summary = isNone
    ? `Factor: None | Base: ${state.base}`
    : `Factor: ${FACTOR_LABELS[factor] || factor}${subjectLabel} | Type: ${typeLabel} | Base: ${state.base}`;

  if (!actor) return;

  if (isNone || !isScalingActive(state.scaling)) {
    previewEl.textContent = `${summary}\n→ ${state.base}`;
    return;
  }

  const value = evaluateScaling(actor.system, state.base, state.scaling, {
    name: item.name, system: foundry.utils.deepClone(item.system)
  });
  previewEl.textContent = `${summary}\n→ ${value}`;
}

/* -------------------------------------------- */
/*  Handlers                                    */
/* -------------------------------------------- */

/**
 * Bind the scaling controls. A factor change resets the subject. The factor and type selectors have their own
 * handlers, so the shared change handler skips them.
 * @param {Actor|null} actor              The item's owner, or null for an unowned item.
 */
function attachHandlers(dialogEl, state, item, actor, opts) {
  const repaint = () => {
    paintSubject(dialogEl, state);
    paintTypeSections(dialogEl, state, opts);
    paintThresholds(dialogEl, state);
    refreshAddToBaseCheckboxes(dialogEl, state);
    refreshRoundDownCheckbox(dialogEl, state);
    refreshSecondaryFields(dialogEl, state);
    updatePreview(dialogEl, state, item, actor, opts);
  };

  dialogEl.querySelector('.us-factor')?.addEventListener('change', (ev) => {
    state.scaling.factor = ev.target.value;
    if (state.scaling.factor !== 'None') {
      state.scaling.subject = defaultSubjectFor(state.scaling.factor);
    }
    repaint();
  });

  dialogEl.querySelector('.us-type')?.addEventListener('change', (ev) => {
    syncStateFromDom(dialogEl, state);
    state.scaling.type = ev.target.value;
    repaint();
  });

  dialogEl.addEventListener('input', (ev) => {
    if (!ev.target.closest('.uses-scaling-container')) return;
    syncStateFromDom(dialogEl, state);
    updatePreview(dialogEl, state, item, actor, opts);
  });

  dialogEl.addEventListener('change', (ev) => {
    if (!ev.target.closest('.uses-scaling-container')) return;
    if (ev.target.matches('.us-factor, .us-type')) return;
    syncStateFromDom(dialogEl, state);
    updatePreview(dialogEl, state, item, actor, opts);
  });

  dialogEl.querySelector('.us-add-threshold')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    syncStateFromDom(dialogEl, state);
    state.scaling.thresholds = [...state.scaling.thresholds, { at: 0, uses: 0 }];
    paintThresholds(dialogEl, state);
    updatePreview(dialogEl, state, item, actor, opts);
  });

  dialogEl.addEventListener('click', (ev) => {
    const delBtn = ev.target.closest('.us-threshold-del');
    if (!delBtn) return;
    ev.preventDefault();
    syncStateFromDom(dialogEl, state);
    const row = delBtn.closest('.us-threshold-row');
    const idx = parseInt(row?.dataset.thresholdIndex, 10);
    if (!Number.isNaN(idx)) state.scaling.thresholds.splice(idx, 1);
    paintThresholds(dialogEl, state);
    updatePreview(dialogEl, state, item, actor, opts);
  });
}

/* -------------------------------------------- */
/*  Scaling Dialog                              */
/* -------------------------------------------- */

/**
 * The text the Range editor saves as `system.effectData.rng`. The base field shows only the range's first number, so
 * a stored range such as "2-3" is kept as it is while nothing scales and the base field is untouched. Otherwise, or
 * when the stored text isn't a range, the base field's number is saved.
 * @param {object} state          The working state.
 * @param {string} stored         The range as the Item stores it.
 * @param {boolean} edited        Whether the author edited the base field.
 * @returns {string}
 */
function baseText(state, stored, edited) {
  const kept = !edited && !isScalingActive(state.scaling) && parseAttackRange(stored);
  return kept ? stored : String(state.base);
}

/**
 * Open the scaling dialog on the paths openScalingEditor (dialogs.mjs) supplies. Values are read from the Item's
 * source, and a base saved as text (the Range editor's) goes through `baseText`.
 * @param {ItemSheet} itemSheet                           The sheet it was opened from.
 * @param {object} opts                                   Which paths to edit and what to call them.
 * @param {string} opts.basePath                          Where the base value lives.
 * @param {string} opts.scalingPath                       Where the scaling config lives.
 * @param {string} [opts.usesTypePath]                    Where the uses type lives, for the uses editor.
 * @param {string} [opts.losRulePath]                     Where the sight rule lives, for the range editor.
 * @param {boolean} [opts.includeNone]                    Offer a factor of None.
 * @param {boolean} [opts.baseAsString]                   Write the base as text.
 * @param {string} [opts.title]                           Window title.
 * @param {string} [opts.baseLabel]                       What to call the base.
 * @returns {Promise<void>}
 */
export async function openScalingDialog(itemSheet, opts) {
  const item = itemSheet.document;
  const source = item._source || item;
  const current = foundry.utils.getProperty(source, opts.scalingPath) || {};
  const currentBase = foundry.utils.getProperty(source, opts.basePath);

  const initialFactor = current.factor || (opts.includeNone ? 'None' : 'Level');
  const state = {
    base: Math.max(1, parseInt(currentBase, 10) || 1),
    scaling: {
      factor: initialFactor,
      subject: current.subject || (initialFactor === 'None' ? '' : defaultSubjectFor(initialFactor)),
      type: current.type || 'Additive',
      multiplier: current.multiplier ?? 1,
      thresholds: Array.isArray(current.thresholds) ? foundry.utils.deepClone(current.thresholds) : [],
      formula: current.formula || '',
      addToBase: !!current.addToBase,
      roundDown: !!current.roundDown
    },
    losRule: opts.losRulePath ? (foundry.utils.getProperty(source, opts.losRulePath) || 'normal') : null,
    usesType: opts.usesTypePath ? (foundry.utils.getProperty(source, opts.usesTypePath) || 'limited') : null
  };
  let baseEdited = false;

  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    baseLabel: opts.baseLabel || 'base',
    showLosRule: !!opts.losRulePath,
    showUsesType: !!opts.usesTypePath
  });
  const actor = item.parent || null;
  state.hasActor = Boolean(actor);

  return openEditor({
    document: item,
    title: opts.title || 'Scaling',
    width: 540,
    height: opts.usesTypePath ? 'auto' : 580,
    resizable: true,
    classes: ['dialog-uses-formula'],
    content,
    gather: (root) => {
      syncStateFromDom(root, state);
      const updates = {};
      updates[opts.basePath] = opts.baseAsString ? baseText(state, currentBase, baseEdited) : state.base;
      updates[opts.scalingPath] = state.scaling;
      if (opts.losRulePath) updates[opts.losRulePath] = state.losRule || 'normal';
      if (opts.usesTypePath) updates[opts.usesTypePath] = state.usesType || 'limited';
      return updates;
    },
    apply: async (updates) => {
      await item.update(updates);
      itemSheet.render(false);
    },
    wire: (el, _ctx, dialog) => {
      paintFactorOptions(el, opts);
      el.querySelector('.us-factor').value = state.scaling.factor;
      el.querySelector('.us-type').value = state.scaling.type;
      const baseEl = el.querySelector('.us-base');
      baseEl.value = state.base;
      baseEl.addEventListener('input', () => { baseEdited = true; });
      el.querySelector('.us-multiplier').value = Number(state.scaling.multiplier) || 1;
      el.querySelector('.us-formula').value = state.scaling.formula;
      paintSubject(el, state);
      paintTypeSections(el, state, opts);
      paintThresholds(el, state);
      refreshAddToBaseCheckboxes(el, state);
      refreshRoundDownCheckbox(el, state);
      const losEl = el.querySelector('.us-los-rule');
      if (losEl && state.losRule) losEl.value = state.losRule;
      const previewSection = el.querySelector('.us-preview-section');
      if (previewSection) previewSection.hidden = !state.hasActor;
      updatePreview(el, state, item, actor, opts);
      attachHandlers(el, state, item, actor, opts);

      if (opts.usesTypePath) {
        const utSel = el.querySelector('.us-uses-type');
        if (utSel) {
          utSel.value = state.usesType || 'limited';
          utSel.addEventListener('change', () => {
            state.usesType = utSel.value;
            applyUsesTypeVisibility(el, state, opts);
            dialog.setPosition({ height: 'auto' });
          });
        }
        applyUsesTypeVisibility(el, state, opts);
      }
    }
  });
}
