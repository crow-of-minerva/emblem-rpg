/** @layer ui/apps/sheets/item/editors */
/*
 * Entry points the Item sheet and the Object sheet use to open the item editors: effects (effects.mjs), modifiers
 * and requirements (condition-editors.mjs), uses and range scaling (scaling.mjs), and the targeting, effect
 * parameter and damage-condition dialogs defined here. The animation and crafting editors are opened from their own
 * files. The editors share card-list.mjs, fields.mjs and the condition builder in conditions.mjs.
 */
import { DAMAGE_TYPES } from '../../../../../contracts/domains/damage.mjs';
import { openEditor } from '../../../../dialogs.mjs';
import { createEffectEntry, openEffectActionEditor } from './effects.mjs';
import {
  createRequirementEntry,
  onAddAuraModifier,
  onAddModifier,
  onEditModifier,
  openRequirementEditor as openFullRequirementEditor
} from './condition-editors.mjs';
import { openScalingDialog } from './scaling.mjs';
import { mountConditionTreeBuilder, mountPathPicker, summarizeCondition } from './conditions.mjs';
import { isEmpty as isConditionEmpty } from '../../../../../contracts/dsl/conditions.mjs';
import { triggerGroupForItem } from '../../../../../contracts/dsl/effects.mjs';
import { getTooltip } from '../../../../tooltips.mjs';
import { capitalize } from '../../../../../lib/dom/html.mjs';

const TARGET_PARAMETERS_TEMPLATE = `systems/emblem-rpg/templates/editors/target-params.hbs`;
const EFFECT_PARAMETERS_TEMPLATE = `systems/emblem-rpg/templates/editors/effect-params.hbs`;
const DAMAGE_CONDITION_TEMPLATE = `systems/emblem-rpg/templates/editors/weapon-dmg-conditions.hbs`;

/** Where an Item keeps its effects. An Object keeps its own at `system.effects`. */
const DEFAULT_EFFECTS_PATH = 'system.effects';

const SKILL_OPTIONS = Object.freeze([
  'None', 'Athletics', 'Finesse', 'Trading', 'Civics', 'Handicraft',
  'Sociability', 'Command', 'Nature', 'Perception', 'Performance', 'Reason', 'Esoteric'
]);

/* -------------------------------------------- */
/*  Sheet adapter                               */
/* -------------------------------------------- */

/**
 * Give the editors one sheet-like subject. They read only `document`, `element`, `render` and `effectsPath` from it.
 * The Item sheet passes itself and gets a thin wrapper that adds the effects path. The Object sheet passes its
 * Actor, which gets a stand-in with no element and a render that does nothing. A subject that already has an
 * effects path is used as it is.
 */
function itemSheetFor(subject, effectsPath = DEFAULT_EFFECTS_PATH) {
  if (!subject?.document) return { document: subject, element: null, render: () => {}, effectsPath };
  if (subject.effectsPath) return subject;
  return {
    get document() { return subject.document; },
    get element() { return subject.element; },
    render: (...args) => subject.render(...args),
    effectsPath
  };
}

/* -------------------------------------------- */
/*  Scaling                                     */
/* -------------------------------------------- */

/**
 * Open the uses or range scaling dialog for an item. The item sheet passes a Durability title and base label for
 * weapons, staves and armour, and everything else takes the defaults here.
 * @param {ItemSheet|Item} subject        The sheet or item.
 * @param {string} [kind]                 'uses' or 'range'.
 * @param {object} [options]
 * @param {string} [options.title]        Window title.
 * @param {string} [options.baseLabel]    Label of the base field.
 * @returns {Promise<void>}
 */
export function openScalingEditor(subject, kind = 'uses', { title, baseLabel } = {}) {
  const itemSheet = itemSheetFor(subject);
  if (kind === 'uses') return openScalingDialog(itemSheet, {
    title: title ?? 'Uses',
    baseLabel: baseLabel ?? 'base uses',
    basePath: 'system.uses.max',
    scalingPath: 'system.uses.scaling',
    usesTypePath: 'system.uses.type',
    includeNone: false,
    baseAsString: false
  });
  return openScalingDialog(itemSheet, {
    title: title ?? 'Range',
    baseLabel: baseLabel ?? 'base range',
    basePath: 'system.effectData.rng',
    scalingPath: 'system.effectData.rngScaling',
    losRulePath: 'system.effectData.losRule',
    includeNone: true,
    baseAsString: true
  });
}

/* -------------------------------------------- */
/*  Targets and effects                         */
/* -------------------------------------------- */

/**
 * Open the Target Parameters dialog from the Item sheet: target type, range type, grid color and the Ground
 * options. A Potion always targets its user, so it gets no dialog.
 */
export async function openTargetingEditor(subject) {
  const itemSheet = itemSheetFor(subject);
  const item = itemSheet.document;
  if (item.system.itemType === 'Potion') return null;
  const source = item._source ?? item;
  const data = foundry.utils.getProperty(source, 'system.effectData');
  return openEditor({
    document: item,
    title: 'Target Parameters',
    width: 425,
    height: 'auto',
    resizable: true,
    classes: ['dialog-uses-formula', 'dialog-target-params'],
    content: () => foundry.applications.handlebars.renderTemplate(TARGET_PARAMETERS_TEMPLATE, {}),
    wire: (root, _context, dialog) => {
      const set = (selector, selected) => {
        const control = root.querySelector(selector);
        if (control && selected !== null && selected !== undefined) control.value = selected;
      };
      set('.tp-target-type', data.targetType ?? 'Any');
      set('.tp-rng-type', data.rngType ?? 'Single');
      set('.tp-grid-color', data.gridColor ?? 'Red');
      set('.tp-valid-squares', data.groundValidSquares ?? 'All');
      set('.tp-max-elev', Number(data.groundMaxElevDiff) || 0);
      const unoccupied = root.querySelector('.tp-unoccupied-only');
      if (unoccupied) unoccupied.checked = data.groundUnoccupiedOnly !== false;
      const sync = () => {
        const section = root.querySelector('.tp-ground-section');
        if (section) section.hidden = root.querySelector('.tp-target-type')?.value !== 'Ground';
        dialog.setPosition({ height: 'auto' });
      };
      root.querySelector('.tp-target-type')?.addEventListener('change', sync);
      sync();
    },
    gather: root => ({
      'system.effectData.targetType': root.querySelector('.tp-target-type')?.value ?? 'Any',
      'system.effectData.rngType': root.querySelector('.tp-rng-type')?.value ?? 'Single',
      'system.effectData.gridColor': root.querySelector('.tp-grid-color')?.value ?? 'Red',
      'system.effectData.groundValidSquares': root.querySelector('.tp-valid-squares')?.value ?? 'All',
      'system.effectData.groundMaxElevDiff':
        Math.max(0, Number.parseInt(root.querySelector('.tp-max-elev')?.value, 10) || 0),
      'system.effectData.groundUnoccupiedOnly': root.querySelector('.tp-unoccupied-only')?.checked === true
    }),
    apply: async updates => {
      await item.update(updates);
      itemSheet.render(false);
    }
  });
}

/**
 * Open the Effect Parameters dialog from the Item sheet: the custom parameters an item's effects can ask for, and
 * the saving throw or skill check that delivers them.
 */
export async function openEffectParametersEditor(subject) {
  const itemSheet = itemSheetFor(subject);
  const item = itemSheet.document;
  const data = item.system.effectData;
  const savingThrowDC = data.savingThrowDC;
  const skillCheckDC = data.skillCheckDC;
  const content = await foundry.applications.handlebars.renderTemplate(EFFECT_PARAMETERS_TEMPLATE, {
    params: Array.from(data.params),
    saveRequired: savingThrowDC.required === true,
    skillRequired: skillCheckDC.required === true,
    savingThrowDC,
    skillCheckDC,
    skillOptions: SKILL_OPTIONS
  });
  return openEditor({
    document: item,
    title: 'Effect Parameters',
    width: 640,
    height: 'auto',
    resizable: true,
    classes: ['dialog-effect-params'],
    content,
    wire: (root, _context, dialog) => wireEffectParameters(root, dialog),
    gather: gatherEffectParameters,
    apply: updates => item.update(updates)
  });
}

/**
 * Bind the delivery switcher, its summary and the custom parameter list inside the Effect Parameters dialog.
 * @param {HTMLElement} root              The dialog content.
 * @param {DialogV2} dialog               The dialog, for height updates.
 */
function wireEffectParameters(root, dialog) {
  const switcher = root.querySelector('#params-delivery-type');
  const saveBlock = root.querySelector('#params-saving-throw-block');
  const skillBlock = root.querySelector('#params-skill-check-block');
  const readout = root.querySelector('[data-role="check-summary"]');
  const syncSummary = () => writeCheckSummary(readout, switcher?.value ?? 'None', root);
  const syncBlocks = () => {
    saveBlock?.classList.toggle('is-hidden', switcher?.value !== 'SavingThrow');
    skillBlock?.classList.toggle('is-hidden', switcher?.value !== 'SkillCheck');
    syncSummary();
    dialog.setPosition({ height: 'auto' });
  };
  switcher?.addEventListener('change', syncBlocks);
  for (const block of [saveBlock, skillBlock]) {
    block?.addEventListener('input', syncSummary);
    block?.addEventListener('change', syncSummary);
  }
  syncBlocks();

  const container = root.querySelector('#params-container');
  const head = root.querySelector('[data-role="params-head"]');
  const empty = root.querySelector('[data-role="params-empty"]');
  const syncParams = () => {
    const count = container?.querySelectorAll('.ed-param-entry').length ?? 0;
    head?.classList.toggle('is-hidden', count === 0);
    empty?.classList.toggle('is-hidden', count > 0);
    dialog.setPosition({ height: 'auto' });
  };
  container?.addEventListener('click', event => {
    const button = event.target.closest('.delete-param');
    if (!button) return;
    button.closest('.ed-param-entry')?.remove();
    syncParams();
  });
  root.querySelector('#add-new-param')?.addEventListener('click', () => {
    const index = container?.querySelectorAll('.ed-param-entry').length ?? 0;
    container?.insertAdjacentHTML('beforeend', parameterRow(index));
    syncParams();
    container?.lastElementChild?.querySelector('.param-name')?.focus();
  });
}

/**
 * Read the Effect Parameters dialog back into an item update: the custom parameter list plus the fields of the
 * selected check, with the other check switched off.
 * @param {HTMLElement} root              The dialog content.
 * @returns {object}                      The update for Item#update.
 */
function gatherEffectParameters(root) {
  const params = [];
  for (const entry of root.querySelectorAll('.ed-param-entry')) {
    const name = entry.querySelector('.param-name')?.value.trim() ?? '';
    if (!name) continue;
    params.push({
      name,
      options: entry.querySelector('.param-options')?.value.trim() ?? '',
      numeric: entry.querySelector('.param-numeric')?.checked === true
    });
  }
  const deliveryType = root.querySelector('#params-delivery-type')?.value ?? 'None';
  const updates = { 'system.effectData.params': params };
  if (deliveryType === 'SavingThrow') {
    Object.assign(updates, {
      'system.effectData.savingThrowDC.required': true,
      'system.effectData.savingThrowDC.base': Number(root.querySelector('#params-save-base')?.value) || 0,
      'system.effectData.savingThrowDC.attribute': root.querySelector('#params-save-attribute')?.value ?? 'None',
      'system.effectData.savingThrowDC.targetAttribute':
        root.querySelector('#params-save-target-attr')?.value ?? 'None',
      'system.effectData.savingThrowDC.ignoreForFriendly':
        root.querySelector('#params-save-ignore-friendly')?.checked === true,
      'system.effectData.skillCheckDC.required': false
    });
  } else if (deliveryType === 'SkillCheck') {
    Object.assign(updates, {
      'system.effectData.skillCheckDC.required': true,
      'system.effectData.skillCheckDC.base': Number(root.querySelector('#params-skill-base')?.value) || 0,
      'system.effectData.skillCheckDC.targetAttribute':
        root.querySelector('#params-skill-target-attr')?.value ?? 'None',
      'system.effectData.skillCheckDC.skill': root.querySelector('#params-skill-skill')?.value ?? 'None',
      'system.effectData.skillCheckDC.ignoreForFriendly':
        root.querySelector('#params-skill-ignore-friendly')?.checked === true,
      'system.effectData.savingThrowDC.required': false
    });
  } else {
    updates['system.effectData.savingThrowDC.required'] = false;
    updates['system.effectData.skillCheckDC.required'] = false;
  }
  return updates;
}

function parameterRow(index) {
  return `
    <div class="effect-param-row ed-param-entry" data-index="${index}">
      <input type="text" class="param-name" value="" placeholder="name" aria-label="Parameter name"
        data-tooltip="${getTooltip('editor.params.custom-name')}">
      <input type="text" class="param-options" value="" placeholder="a, b, c or formula" aria-label="Options"
        data-tooltip="${getTooltip('editor.params.custom-options')}">
      <input type="checkbox" class="param-numeric" data-tooltip="${getTooltip('effect-param.numeric')}"
        aria-label="Numeric">
      <button type="button" class="delete-param" data-tooltip="${getTooltip('effect-param.delete')}"
        aria-label="Delete parameter"><i class="fas fa-trash"></i></button>
    </div>`;
}

/**
 * The pieces of the check summary in reading order. A plain piece is muted text. A `lit` piece is a chosen
 * attribute or skill, which writeCheckSummary tints.
 * @param {string} deliveryType             None, SavingThrow or SkillCheck.
 * @param {(selector: string) => string} value   Reads a control's value from the dialog.
 * @returns {{text?: string, lit?: string}[]}
 */
function checkSummarySegments(deliveryType, value) {
  const save = deliveryType === 'SavingThrow';
  if (!save && deliveryType !== 'SkillCheck') return [{ text: 'no check required' }];
  const base = Number(value(save ? '#params-save-base' : '#params-skill-base')) || 0;
  const adds = value(save ? '#params-save-attribute' : '#params-skill-target-attr');
  const rolls = value(save ? '#params-save-target-attr' : '#params-skill-skill');
  const segments = [{ text: `DC ${base}` }];
  if (adds !== 'None') segments.push({ text: ` + ${save ? 'caster' : 'target'} ` }, { lit: adds });
  if (rolls !== 'None') segments.push({ text: save ? ', target rolls ' : ', skill ' }, { lit: rolls });
  return segments;
}

/**
 * Write the one-line check summary beside the delivery switcher, for example "DC 10 + caster Wit, target rolls
 * Mgt", with the chosen attribute and skill names highlighted.
 * @param {HTMLOutputElement|null} output   The summary element.
 * @param {string} deliveryType             The selected delivery: None, SavingThrow or SkillCheck.
 * @param {HTMLElement} root                The dialog root the check fields live in.
 */
function writeCheckSummary(output, deliveryType, root) {
  if (!output) return;
  const value = selector => root.querySelector(selector)?.value ?? 'None';
  output.replaceChildren();
  output.classList.toggle('is-none', deliveryType !== 'SavingThrow' && deliveryType !== 'SkillCheck');
  for (const segment of checkSummarySegments(deliveryType, value)) {
    if (segment.lit === undefined) {
      output.append(segment.text);
      continue;
    }
    const lit = document.createElement('b');
    lit.className = 'ed-lit';
    lit.textContent = segment.lit;
    output.append(lit);
  }
}

/* -------------------------------------------- */
/*  Full item authoring editors                 */
/* -------------------------------------------- */

/**
 * Open the modifier editor on an existing modifier, or on a new standard or aura modifier. The condition-editors.mjs
 * handlers take an event, so this passes a stand-in that carries the index.
 */
export function openModifierEditor(subject, index = null, kind = 'standard') {
  const itemSheet = itemSheetFor(subject);
  const event = { preventDefault() {}, currentTarget: { dataset: { index: String(index ?? '') } } };
  if (index !== null) return onEditModifier(itemSheet, event);
  return kind === 'aura' ? onAddAuraModifier(itemSheet, event) : onAddModifier(itemSheet, event);
}

/**
 * Open the effect editor on an existing entry, or append a default entry through createEffectEntry and open the
 * editor on that so a new effect is authored in one window.
 * @param {ItemSheet|Item} subject        The sheet or item.
 * @param {number|null} [index]           Which effect, or null to create one.
 * @param {object} [options]
 * @param {string} [options.effectsPath]  Where the item keeps its effects.
 * @returns {Promise<void|null>}
 */
export async function openEffectEditor(subject, index = null, { effectsPath = DEFAULT_EFFECTS_PATH } = {}) {
  const itemSheet = itemSheetFor(subject, effectsPath);
  const { type, system } = itemSheet.document;
  const group = triggerGroupForItem({ type, itemType: system?.itemType });
  if (index !== null && index !== undefined) return openEffectActionEditor(itemSheet, index, { group });
  const created = await createEffectEntry(itemSheet, { group });
  if (created === null || created === undefined) return null;
  return openEffectActionEditor(itemSheet, created, { group, isNew: true });
}

/**
 * Open the requirement editor on an existing entry, or append a default entry through createRequirementEntry and
 * open the editor on that.
 * @param {ItemSheet|Item} subject        The sheet or item.
 * @param {number|null} [index]           Which requirement, or null to create one.
 * @returns {Promise<void|null>}
 */
export async function openRequirementEditor(subject, index = null) {
  const itemSheet = itemSheetFor(subject);
  if (index !== null && index !== undefined) return openFullRequirementEditor(itemSheet, index);
  const created = await createRequirementEntry(itemSheet);
  if (created === null || created === undefined) return null;
  return openFullRequirementEditor(itemSheet, created, { isNew: true });
}

/** Open the Damage Type Conditions dialog for a weapon: one condition per enabled damage type, and the randomizer. */
export function openDamageConditionsEditor(subject) {
  return openWeaponDmgConditionsDialog(itemSheetFor(subject));
}

/* -------------------------------------------- */
/*  Weapon Damage Conditions                    */
/* -------------------------------------------- */

async function openWeaponDmgConditionsDialog(itemSheet) {
  const damageData = itemSheet.document.system.weapon.dmgTypes;
  const enabledDmgTypes = DAMAGE_TYPES.filter(type => damageData[type]).map(type => {
    const tree = damageData[`${type}ConditionTree`];
    return {
      dmgType: type,
      displayName: capitalize(type),
      tree: tree?.kind ? tree : null,
      hasCondition: Boolean(tree?.kind && !isConditionEmpty(tree)),
      summary: summarizeCondition(tree?.kind ? tree : null)
    };
  });
  const content = await foundry.applications.handlebars.renderTemplate(DAMAGE_CONDITION_TEMPLATE, {
    randomize: damageData.randomize === true,
    enabledDmgTypes
  });
  const builders = new Map();
  return openEditor({
    document: itemSheet.document,
    title: 'Damage Type Conditions',
    width: 640,
    height: 680,
    resizable: true,
    classes: ['dialog-weapon-dmg-conditions'],
    content,
    gather: root => {
      const update = {};
      const randomize = root.querySelector('#randomize-checkbox');
      if (randomize) update['system.weapon.dmgTypes.randomize'] = randomize.checked;
      for (const [type, builder] of builders) {
        update[`system.weapon.dmgTypes.${type}ConditionTree`] = builder.getTree();
        update[`system.weapon.dmgTypes.${type}Condition`] = '';
      }
      return update;
    },
    apply: update => itemSheet.document.update(update),
    wire: root => wireDamageConditionBuilders(root, damageData, builders)
  });
}

function wireDamageConditionBuilders(root, damageData, builders) {
  mountPathPicker(root);
  for (const block of root.querySelectorAll('.dmg-cond-block')) {
    const type = block.dataset.dmgType;
    const container = block.querySelector('[data-tree-container]');
    if (!container) continue;
    const initial = damageData[`${type}ConditionTree`];
    const builder = mountConditionTreeBuilder(container, {
      initialTree: initial?.kind ? initial : null,
      scopeEl: block,
      summaryEls: { summary: block.querySelector('.dmg-cond-state') }
    });
    builders.set(type, builder);
  }
}
