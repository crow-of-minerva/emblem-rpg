/** @layer ui/apps/sheets/item/editors */
/*
 * The modifier and requirement editors, opened through dialogs.mjs from the Item sheet. Both use the shared condition
 * builder in conditions.mjs. A modifier keeps its standard and aura fields apart when its payload is built, and a
 * requirement is either one condition tree or one placement panel from fields.mjs.
 */
import { SYSTEM_ID } from '../../../../../contracts/protocol.mjs';
import { openEditor } from '../../../../dialogs.mjs';
import { validate as validateTree } from '../../../../../contracts/dsl/conditions.mjs';
import { validateModifier } from '../../../../../contracts/dsl/modifiers.mjs';
import { createItemEditorNotifier } from '../../../../../presentation/interface/notifications.mjs';
import {
  getConditionClipboard,
  AURA_TARGET_CATEGORIES,
  MODIFIER_TARGET_CATEGORIES,
  mountConditionTreeBuilder,
  mountPathPicker,
  REQUIREMENT_PATH_CATEGORIES,
  setConditionClipboard
} from './conditions.mjs';
import {
  emptyRequirement,
  REQUIREMENT_TYPES,
  validate as validateRequirement
} from '../../../../../contracts/dsl/requirements.mjs';
import { bindTerrainGeometryPanels, readTerrainGeometryPanel, renderTerrainGeometryPanel } from './fields.mjs';
import { escapeHtml } from '../../../../../lib/dom/html.mjs';
import { getTooltip } from '../../../../tooltips.mjs';
import { FoundryDiagnostics } from '../../../../../foundry/adapters/services/diagnostics.mjs';

const notify = createItemEditorNotifier({ sourcePath: import.meta.url, diagnostics: new FoundryDiagnostics() });
const TEMPLATE = `systems/${SYSTEM_ID}/templates/editors/modifier-editor.hbs`;

/* -------------------------------------------- */
/*  Sheet Actions                               */
/* -------------------------------------------- */

/**
 * Open the editor on an existing modifier. openModifierEditor (dialogs.mjs) passes a stand-in event whose
 * `currentTarget` carries the index.
 */
export async function onEditModifier(itemSheet, event) {
  event.preventDefault();

  const index = parseInt(event.currentTarget.dataset.index);
  const modifier = itemSheet.document.system.modifiers[index];
  if (!modifier) return;

  return openModifierDialog(itemSheet, index, modifier);
}

/** Add a standard modifier and open its editor. */
export function onAddModifier(itemSheet, event) {
  event.preventDefault();
  return _addModifierOfKind(itemSheet, 'standard');
}

/** Add an aura modifier and open its editor. */
export function onAddAuraModifier(itemSheet, event) {
  event.preventDefault();
  return _addModifierOfKind(itemSheet, 'aura');
}

/**
 * Save a blank modifier on the Item, then open its editor. Cancelling leaves the blank entry on the sheet, where it
 * can be deleted.
 */
async function _addModifierOfKind(itemSheet, kind) {
  const modifiers = itemSheet.document.system.modifiers;
  const newModifier = {
    name: '',
    target: '',
    quantity: '0',
    condition: '',
    conditionTree: null,
    requiresEquipped: false,
    requiresActivation: false,
    stackable: false,
    kind,
    targetType: 'All'
  };
  await itemSheet.document.update({ 'system.modifiers': [...modifiers, newModifier] });
  synchronizeModifierHiddenFields(itemSheet);
  return openModifierDialog(itemSheet, modifiers.length, newModifier);
}

/* -------------------------------------------- */
/*  Hidden Fields                               */
/* -------------------------------------------- */

/**
 * Copy a saved modifier into the Item sheet's hidden modifier inputs, so the sheet's next submit doesn't overwrite
 * the editor's changes. In practice the lookup finds no form and nothing is updated: the sheet element is itself the
 * form, and the browser drops the template's inner form.
 */
function updateModifierHiddenFields(itemSheet, index, modifierData) {
  const form = itemSheet.element?.querySelector('form');
  if (!form) return;
  const setField = (suffix, value) => {
    const field = form.querySelector(`input[name="system.modifiers.${index}.${suffix}"]`);
    if (field) field.value = value;
  };
  setField('target', modifierData.target || '');
  setField('quantity', modifierData.quantity || '');
  setField('condition', modifierData.condition || '');
  setField('requiresEquipped', modifierData.requiresEquipped ?? false);
  setField('stackable', modifierData.stackable ?? false);
  setField('kind', modifierData.kind || 'standard');
  setField('targetType', modifierData.targetType || 'All');
}

/** Run updateModifierHiddenFields for every modifier. _addModifierOfKind calls it after appending a blank one. */
function synchronizeModifierHiddenFields(itemSheet) {
  const modifiers = itemSheet.document.system.modifiers;
  modifiers.forEach((modifier, index) => updateModifierHiddenFields(itemSheet, index, modifier));
}

/* -------------------------------------------- */
/*  Payload                                     */
/* -------------------------------------------- */

/** Build the modifier payload with its existing kind, clearing the fields that belong to the other kind. */
function buildModifierPayload(dialogEl, tree, original) {
  const kind = original.kind === 'aura' ? 'aura' : 'standard';
  const targetTypeEl = dialogEl.querySelector('#mod-target-type');
  return {
    ...original,
    name: dialogEl.querySelector('#mod-name')?.value ?? '',
    target: dialogEl.querySelector('#mod-target')?.value ?? '',
    quantity: dialogEl.querySelector('#mod-quantity')?.value ?? '0',
    requiresEquipped: dialogEl.querySelector('#mod-equipped')?.checked ?? false,
    requiresActivation: kind === 'aura' ? false : (dialogEl.querySelector('#mod-activation')?.checked ?? false),
    stackable: kind === 'aura' ? (dialogEl.querySelector('#mod-stackable')?.checked ?? false) : false,
    conditionTree: tree,
    kind,
    targetType: kind === 'aura' ? (targetTypeEl?.value || 'All') : 'All'
  };
}

/* -------------------------------------------- */
/*  Modifier Editor                             */
/* -------------------------------------------- */

/**
 * Open the modifier editor. The modifier is validated before saving: errors block the save and warnings are shown.
 * The copy and paste buttons share the condition clipboard with the other editors, and pasting over a non-empty tree
 * asks first.
 */
async function openModifierDialog(itemSheet, index, modifier) {
  const sourceTree = modifier.conditionTree && typeof modifier.conditionTree === 'object'
    && modifier.conditionTree.kind ? modifier.conditionTree : null;

  const isAura = modifier.kind === 'aura';
  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, { modifier, isAura });

  let builder = null;

  const titlePrefix = isAura ? 'Aura Modifier' : 'Modifier';
  return openEditor({
    document: itemSheet.document,
    title: `${titlePrefix}: ${modifier.name || '(unnamed)'}`,
    width: 640,
    height: 620,
    resizable: true,
    classes: ['dialog-modifier-editor'],
    content,
    gather: (root) => {
      const tree = builder ? builder.getTree() : null;
      const payload = buildModifierPayload(root, tree, modifier);
      const item = itemSheet.document;
      const r = validateModifier(payload, { itemType: item.system.itemType || item.type });
      if (!r.valid) {
        notify.error(`This modifier cannot be saved. ${r.errors.join(' ')}`);
        return undefined;
      }
      if (r.warnings.length) notify.warn(r.warnings.join(' '));
      return payload;
    },
    apply: async (updated) => {
      const modifiers = [...itemSheet.document.system.modifiers];
      modifiers[index] = updated;

      await itemSheet.document.update({ 'system.modifiers': modifiers });
      updateModifierHiddenFields(itemSheet, index, updated);
    },
    wire: (el) => {
      mountPathPicker(el);
      mountPathPicker(el, {
        categories: isAura ? AURA_TARGET_CATEGORIES : MODIFIER_TARGET_CATEGORIES,
        selector: '[data-path-input="target"]'
      });

      builder = mountConditionTreeBuilder(el.querySelector('.mod-tree-contents'), {
        initialTree: sourceTree,
        surface: isAura ? 'aura' : 'modifier',
        summaryEls: {
          summary: el.querySelector('.mod-condition-summary'),
          json: el.querySelector('.mod-advanced-json')
        },
        scopeEl: el
      });

      el.addEventListener('click', async (clickEv) => {
        const copyBtn = clickEv.target.closest('.mod-copy-btn');
        if (copyBtn) {
          clickEv.preventDefault();
          clickEv.stopPropagation();
          const tree = builder?.getTree();
          if (!tree) {
            notify.warn('Condition is empty. Nothing copied.');
            return;
          }
          setConditionClipboard(tree);
          notify.info('Modifier condition copied to clipboard.');
          return;
        }

        const pasteBtn = clickEv.target.closest('.mod-paste-btn');
        if (pasteBtn) {
          clickEv.preventDefault();
          clickEv.stopPropagation();
          const clip = getConditionClipboard();
          if (!clip) {
            notify.warn('Clipboard is empty.');
            return;
          }
          if (builder && !builder.isEmpty()) {
            const ok = await foundry.applications.api.DialogV2.confirm({
              window: { title: 'Overwrite condition?' },
              classes: [SYSTEM_ID],
              content: '<p>This modifier already has a condition. Replace with the clipboard contents?</p>',
              modal: true, rejectClose: false
            });
            if (!ok) return;
          }
          builder?.setTree(clip);
        }
      });
    }
  });
}

/* -------------------------------------------- */
/*  Requirement Options                         */
/* -------------------------------------------- */

/**
 * The two requirement types as the editor's type selector and window title name them. A Condition requirement is
 * one condition tree, which names the caster and the target through its own paths. A Placement requirement is one
 * geometry panel.
 * @type {ReadonlyArray<{key: string, label: string}>}
 */
const REQUIREMENT_TYPE_OPTIONS = Object.freeze([
  { key: 'condition', label: 'Condition' },
  { key: 'terrainGeometry', label: 'Placement' }
]);

function requirementTypeOptions(selected) {
  return REQUIREMENT_TYPE_OPTIONS.map(option =>
    `<option value="${option.key}"${option.key === selected ? ' selected' : ''}>${option.label}</option>`
  ).join('');
}

function requirementTypeLabel(type) {
  return REQUIREMENT_TYPE_OPTIONS.find(option => option.key === type)?.label ?? 'Condition';
}

/* -------------------------------------------- */
/*  Requirement Creation                        */
/* -------------------------------------------- */

/**
 * Append a blank requirement to the Item and return its index. `openRequirementEditor` in dialogs.mjs calls this
 * and then opens the editor on that index with `isNew`, so a cancelled editor removes the blank entry again.
 * @param {ItemSheet} itemSheet           The sheet.
 * @param {string} [type]                 Which requirement type. An unknown one becomes a Condition.
 * @returns {Promise<number>}             The new entry's index.
 */
export async function createRequirementEntry(itemSheet, type = 'condition') {
  const item = itemSheet.document;
  const kind = REQUIREMENT_TYPES.includes(type) ? type : 'condition';
  const requirements = [...item.system.requirements, emptyRequirement(kind, '')];
  await item.update({ 'system.requirements': requirements });
  return requirements.length - 1;
}

/** Remove the blank entry `createRequirementEntry` added, once its editor has closed without saving. */
async function discardRequirementEntry(itemSheet, entryIndex) {
  const all = [...itemSheet.document.system.requirements];
  if (entryIndex < 0 || entryIndex >= all.length) return;
  all.splice(entryIndex, 1);
  await itemSheet.document.update({ 'system.requirements': all });
}

/* -------------------------------------------- */
/*  Requirement Markup                          */
/* -------------------------------------------- */

/** The editor's markup: the type and name row, then the list `paintRequirementBody` draws the predicate card into. */
function requirementEditorHtml(entry) {
  const typeTip = escapeHtml(getTooltip('editor.requirement.type'));
  const nameTip = escapeHtml(getTooltip('editor.requirement.name'));
  return `
    <div class="ed-container">
      <div class="ed-hrow">
        <label class="ed-field" style="width:150px">
          <span class="ed-label" data-tooltip="${typeTip}">type</span>
          <select data-entry-field="type">${requirementTypeOptions(entry.type)}</select>
        </label>
        <label class="ed-field ed-field--grow">
          <span class="ed-label" data-tooltip="${nameTip}">name</span>
          <input type="text" data-entry-field="name" value="${escapeHtml(entry.name || '')}" />
        </label>
      </div>
      <div class="ed-list" data-req-body></div>
    </div>`;
}

/**
 * The Condition predicate card: a header row naming the condition beside its one-line summary, then the tree
 * builder with its clipboard buttons, then the raw JSON. The `mod-*` classes keep the tree builder's own styling.
 */
function conditionPanelHtml() {
  const summaryTip = escapeHtml(getTooltip('editor.condition.summary'));
  const copyTip = escapeHtml(getTooltip('editor.condition.copy'));
  const pasteTip = escapeHtml(getTooltip('editor.condition.paste'));
  return `
    <div class="ed-panel" data-pred-kind="condition">
      <div class="ed-hrow ed-hrow--inline">
        <span class="ed-label" data-tooltip="${summaryTip}">condition:</span>
        <span class="ed-summary" data-pred-summary></span>
      </div>
      <div class="mod-tree-root">
        <div class="mod-tree-contents" data-tree-container></div>
        <div class="mod-tree-footer">
          <button type="button" class="ed-btn mod-copy-btn" data-tooltip="${copyTip}">copy</button>
          <button type="button" class="ed-btn mod-paste-btn" data-tooltip="${pasteTip}">paste</button>
        </div>
      </div>
      <details class="mod-advanced">
        <summary>advanced json</summary>
        <textarea class="mod-advanced-json" rows="6" spellcheck="false"></textarea>
      </details>
    </div>`;
}

/* -------------------------------------------- */
/*  Requirement Body                            */
/* -------------------------------------------- */

/**
 * Draw the requirement's single predicate: the shared condition builder inside its card for a Condition requirement,
 * or the geometry panel from fields.mjs, which is the card itself, for a Placement one. The builder is mounted again
 * each time, since a repaint destroys the markup the old one was bound to.
 */
function paintRequirementBody(bodyEl, state) {
  const predicate = state.entry.predicates[0];
  state.builder = null;
  if (state.entry.type === 'terrainGeometry') {
    bodyEl.innerHTML = renderTerrainGeometryPanel(predicate.geometry, { context: 'requirement' });
    const panel = bodyEl.firstElementChild;
    if (panel) panel.dataset.predKind = 'terrainGeometry';
    return;
  }
  bodyEl.innerHTML = conditionPanelHtml();
  const card = bodyEl.firstElementChild;
  const tree = predicate.tree;
  state.builder = mountConditionTreeBuilder(card.querySelector('[data-tree-container]'), {
    initialTree: tree && typeof tree === 'object' && tree.kind ? tree : null,
    surface: 'requirement',
    summaryEls: {
      summary: card.querySelector('[data-pred-summary]'),
      json: card.querySelector('.mod-advanced-json')
    },
    scopeEl: card
  });
}

/**
 * Read the whole requirement, header and predicate together. A stored geometry `negate` flag is kept, because
 * game/effects/requirements.mjs still applies it even though the panel has no control for it.
 */
function readRequirement(dialogEl, state) {
  const name = (dialogEl.querySelector('[data-entry-field="name"]')?.value ?? '').trim();
  if (state.entry.type === 'terrainGeometry') {
    const panelEl = dialogEl.querySelector('[data-tg-panel]')
      ?? dialogEl.querySelector('[data-pred-kind="terrainGeometry"]');
    const geometry = readTerrainGeometryPanel(panelEl);
    const predicate = { kind: 'terrainGeometry', geometry };
    if (state.entry.predicates[0]?.negate === true) predicate.negate = true;
    return { type: 'terrainGeometry', name, predicates: [predicate] };
  }
  return { type: 'condition', name, predicates: [{ kind: 'condition', tree: state.builder?.getTree() ?? null }] };
}

/* -------------------------------------------- */
/*  Handlers                                    */
/* -------------------------------------------- */

/**
 * Wire the type selector and the condition clipboard. Changing the type keeps what was authored under the other
 * one in `state.drafts`, so switching back restores it instead of starting blank.
 */
function attachHandlers(dialogEl, state) {
  const body = dialogEl.querySelector('[data-req-body]');
  bindTerrainGeometryPanels(dialogEl);

  dialogEl.addEventListener('change', (ev) => {
    const sel = ev.target.closest('select[data-entry-field="type"]');
    if (!sel || !REQUIREMENT_TYPES.includes(sel.value) || sel.value === state.entry.type) return;
    const current = readRequirement(dialogEl, state);
    state.drafts[current.type] = current;
    state.entry = state.drafts[sel.value] ?? emptyRequirement(sel.value, current.name);
    paintRequirementBody(body, state);
  });

  dialogEl.addEventListener('click', async (ev) => {
    if (ev.target.closest('.mod-copy-btn')) {
      ev.preventDefault();
      ev.stopPropagation();
      const tree = state.builder?.getTree();
      if (!tree) {
        notify.warn('Condition is empty. Nothing copied.');
        return;
      }
      setConditionClipboard(tree);
      notify.info('Condition copied to clipboard.');
      return;
    }

    if (!ev.target.closest('.mod-paste-btn') || !state.builder) return;
    ev.preventDefault();
    ev.stopPropagation();
    const clip = getConditionClipboard();
    if (!clip) {
      notify.warn('Clipboard is empty.');
      return;
    }
    if (!state.builder.isEmpty()) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: 'Overwrite condition?' },
        classes: [SYSTEM_ID],
        content: '<p>This requirement already has a condition. Replace with the clipboard contents?</p>',
        modal: true, rejectClose: false
      });
      if (!ok) return;
    }
    state.builder.setTree(clip);
  });
}

/* -------------------------------------------- */
/*  Requirement Editor                          */
/* -------------------------------------------- */

/**
 * Edit one requirement, validating it with the requirement contract and the requirement condition rules before
 * writing the Item. With `isNew` the entry is the blank one `createRequirementEntry` just added, and it is removed
 * again unless the editor saves it.
 * @param {ItemSheet} itemSheet           The sheet it was opened from.
 * @param {number} entryIndex             Which requirement.
 * @param {object} [options]
 * @param {boolean} [options.isNew]       Whether a close without a save should remove the entry.
 * @returns {Promise<*>}                  What the dialog resolved with.
 */
export async function openRequirementEditor(itemSheet, entryIndex, { isNew = false } = {}) {
  const entry = itemSheet.document.system.requirements[entryIndex];
  if (!entry) return;

  const state = { entry: foundry.utils.deepClone(entry), drafts: {}, builder: null, saved: false };

  const result = await openEditor({
    document: itemSheet.document,
    title: `Requirement: ${entry.name || requirementTypeLabel(entry.type)}`,
    width: 700,
    height: 620,
    resizable: true,
    classes: ['dialog-requirement-editor'],
    content: requirementEditorHtml(state.entry),
    gather: (root) => {
      const updated = readRequirement(root, state);
      const r = validateRequirement(updated);
      const tree = updated.type === 'condition' ? updated.predicates[0]?.tree ?? null : null;
      const rules = validateTree(tree, { path: 'predicates[0].tree', surface: 'requirement' });
      const errors = [...new Set([...r.errors, ...rules.errors])];
      if (errors.length) {
        notify.error(`This requirement cannot be saved. ${errors.join(' ')}`);
        return undefined;
      }
      if (rules.warnings.length) notify.warn(rules.warnings.join(' '));
      return updated;
    },
    apply: async (updated) => {
      const all = [...itemSheet.document.system.requirements];
      all.splice(entryIndex, 1, updated);
      await itemSheet.document.update({ 'system.requirements': all });
      state.saved = true;
    },
    wire: (root) => {
      mountPathPicker(root, { categories: REQUIREMENT_PATH_CATEGORIES });
      paintRequirementBody(root.querySelector('[data-req-body]'), state);
      attachHandlers(root, state);
    }
  });
  if (isNew && !state.saved) await discardRequirementEntry(itemSheet, entryIndex);
  return result;
}
