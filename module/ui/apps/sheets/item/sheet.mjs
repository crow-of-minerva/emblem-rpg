/** @layer ui/apps/sheets/item */
import { SYSTEM_ID } from '../../../../contracts/protocol.mjs';
import { FOOD_TYPE_STATS, FOOD_TYPES, ITEM_SUBTYPES, RESOURCE_TYPES } from '../../../../contracts/domains/items.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../../presentation/interface/notifications.mjs';
import {
  openDamageConditionsEditor,
  openEffectEditor,
  openEffectParametersEditor,
  openModifierEditor,
  openRequirementEditor,
  openScalingEditor,
  openTargetingEditor
} from './editors/dialogs.mjs';
import { openAnimationEditorDialog } from './editors/animations.mjs';
import { openConsumableCraftingDialog, openCraftingSettingsDialog } from './editors/crafting.mjs';
import { parseAttackRange } from '../../../../game/targeting/attack-grid.mjs';
import { averageFormulaValue } from '../../../../game/combat/attack-preview.mjs';
import { escapeHtml, sanitizeHtml } from '../../../../lib/dom/html.mjs';
import { EmblemSheetMixin, showTabPanels } from '../base.mjs';
import {
  canFoundryUserAuthorIgnoringLock,
  inLockedCompendium
} from '../../../../foundry/adapters/services/authority.mjs';
import { FoundryDiagnostics , reportFoundryError } from '../../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Item sheet                                  */
/* -------------------------------------------- */
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });
const MANAGED_FRAME_ACTIONS = new Set(['copyAsStaff', 'openAnimationSettings', 'openCraftingSettings']);
const EFFECT_TAB_EXCLUSIONS = new Set(['Armor', 'Accessory', 'Shield', 'Mount', 'Booster']);
const SELF_ONLY = new Set(['Potion', 'Booster']);
const USES_EXCLUSIONS = new Set(['Shield', 'Accessory', 'Passive']);
const TARGETING = new Set(['Staff (U)', 'Active', 'Utility']);
const ATTACKS = new Set(['Weapon', 'Staff', 'Attack']);
const EFFECT_SUMMARIES = new Set(['Weapon Art', 'Weapon', 'Staff', 'Attack']);
const ACTIVATED_EFFECTS = new Set(['Active', 'Staff (U)', 'Utility']);
const REQUIREMENTS = new Set(['Weapon Art', 'Utility', 'Weapon', 'Staff', 'Staff (U)', 'Attack', 'Active']);
const NO_ANIMATION = new Set(['Armor', 'Shield', 'Accessory', 'Passive']);
const NO_EQUIPMENT_CRAFTING = new Set(['Accessory', 'Shield']);
const CONSUMABLE_CRAFTING = new Set(['Potion', 'Bomb']);
const ITEM_DERIVED_ECHO_PATHS = Object.freeze([
  'system.weapon.atk', 'system.weapon.brk', 'system.weapon.acc', 'system.weapon.crit',
  'system.armor.def', 'system.armor.res', 'system.armor.stn', 'system.wgt', 'system.uses.max', 'system.cost',
  ...['slashing', 'piercing', 'crushing', 'missile', 'fire', 'ice', 'lightning', 'wind', 'arcane', 'decay', 'shadow', 'holy']
    .flatMap(type => [`system.armor.prots.${type}`, `system.armor.vulns.${type}`])
]);

/**
 * What the Item sheet offers for one document type and subtype: its tabs, sections and editors. The sheet exposes it
 * as `capabilities`. The Item directory's context menu and the Enemy AI module read it too.
 */
export function itemCapabilityProfile(documentType, itemType) {
  const known = ITEM_SUBTYPES[documentType]?.includes(itemType) === true;
  const miscellaneous = documentType === 'Miscellaneous';
  const consumable = documentType === 'Consumable';
  const equipment = documentType === 'Equipment';
  const spell = documentType === 'Spell';
  const ability = documentType === 'Ability';
  const coinpurse = miscellaneous && itemType === 'Coinpurse';
  const weaponLike = ATTACKS.has(itemType);
  const targetable = consumable || TARGETING.has(itemType);
  const booster = consumable && itemType === 'Booster';
  const activated = (consumable && !booster) || ACTIVATED_EFFECTS.has(itemType);
  return Object.freeze({
    known, documentType, itemType, coinpurse, compact: coinpurse, showBody: !coinpurse,
    showUses: !miscellaneous && !USES_EXCLUSIONS.has(itemType),
    usesLabel: ['Weapon', 'Staff', 'Armor'].includes(itemType) ? 'Durability' : 'Uses',
    showWeaponArtCost: itemType === 'Weapon Art', showTargeting: targetable,
    forceSelfTarget: SELF_ONLY.has(itemType), showAttackStat: weaponLike, showHands: itemType === 'Weapon',
    showProficiency: (equipment && itemType !== 'Accessory') || spell,
    proficiencyKind: ['Armor', 'Shield'].includes(itemType) ? 'armor'
      : (['Staff', 'Staff (U)'].includes(itemType) || spell) ? 'magical'
        : (equipment && itemType !== 'Accessory') ? 'physical' : null,
    showRank: ['Weapon', 'Staff', 'Staff (U)'].includes(itemType) || spell,
    showWeaponArtProficiencies: itemType === 'Weapon Art', showAttackOverview: weaponLike,
    showArmorOverview: itemType === 'Armor', showMountOverview: itemType === 'Mount',
    showActivatedOverview: consumable || ACTIVATED_EFFECTS.has(itemType), showShieldOverview: itemType === 'Shield',
    showBoosterOverview: booster, showActionType: activated,
    descriptionHeight: ['Other', 'Passive'].includes(itemType) ? 176
      : ['Attack', 'Weapon', 'Armor', 'Staff', 'Mount'].includes(itemType) ? 75 : booster ? 105 : 150,
    tabs: Object.freeze({ overview: true, effects: !miscellaneous && !EFFECT_TAB_EXCLUSIONS.has(itemType),
      modifiers: !booster, requirements: consumable || REQUIREMENTS.has(itemType) }),
    showEffectivenessSummary: EFFECT_SUMMARIES.has(itemType), showPassiveEffects: itemType === 'Passive',
    showActivatedEffects: activated, showValue: !spell && !ability,
    editors: Object.freeze({
      uses: !miscellaneous && !USES_EXCLUSIONS.has(itemType), target: targetable && !SELF_ONLY.has(itemType),
      range: targetable, damageConditions: weaponLike,
      effects: !miscellaneous && !EFFECT_TAB_EXCLUSIONS.has(itemType),
      effectParams: activated, modifiers: !booster,
      requirements: consumable || REQUIREMENTS.has(itemType),
      animation: !miscellaneous && !NO_ANIMATION.has(itemType),
      crafting: (equipment && !NO_EQUIPMENT_CRAFTING.has(itemType))
        || (consumable && CONSUMABLE_CRAFTING.has(itemType)),
      equipmentCrafting: equipment && !NO_EQUIPMENT_CRAFTING.has(itemType),
      consumableCrafting: consumable && CONSUMABLE_CRAFTING.has(itemType), copyAsStaff: spell
    })
  });
}

/**
 * The type and subtype flags `templates/sheets/item-sheet.hbs` draws with, computed once per render so the template
 * tests named flags instead of subtype names. Several flags repeat a condition in itemCapabilityProfile (for
 * example showEffectsTab and `tabs.effects`, showUsesTracker and `showUses`), so a change to which subtypes show a
 * section has to be made in both.
 * @param {string} documentType           The Item document type.
 * @param {string} itemType               Its authored subtype.
 * @returns {object}                      Frozen named booleans, and the description box's height in pixels.
 */
export function itemSheetTypeFlags(documentType, itemType) {
  const subtype = name => itemType === name;
  const equipment = documentType === 'Equipment';
  const ability = documentType === 'Ability';
  const spell = documentType === 'Spell';
  const consumable = documentType === 'Consumable';
  const miscellaneous = documentType === 'Miscellaneous';
  const weapon = subtype('Weapon');
  const armor = subtype('Armor');
  const staff = subtype('Staff');
  const staffUtility = subtype('Staff (U)');
  const shield = subtype('Shield');
  const accessory = subtype('Accessory');
  const active = subtype('Active');
  const passive = subtype('Passive');
  const weaponArt = subtype('Weapon Art');
  const mount = subtype('Mount');
  const attack = subtype('Attack');
  const utility = subtype('Utility');
  const booster = subtype('Booster');
  const other = subtype('Other');
  const activated = active || utility || staffUtility || (consumable && !booster);
  return Object.freeze({
    isEquipment: equipment, isAbility: ability, isSpell: spell, isConsumable: consumable,
    isMiscellaneous: miscellaneous,
    isWeapon: weapon, isArmor: armor, isStaff: staff, isStaffUtility: staffUtility, isShield: shield,
    isAccessory: accessory, isActive: active, isPassive: passive, isWeaponArt: weaponArt, isMount: mount,
    isAttack: attack, isUtility: utility, isPotion: subtype('Potion'), isBomb: subtype('Bomb'),
    isBooster: booster,
    isPromotion: subtype('Promotion'), isCoinpurse: subtype('Coinpurse'), isOther: other,
    isArmorOrShield: armor || shield,
    isMagicalProficiency: staff || staffUtility || spell,
    isDurabilityItem: weapon || staff || armor,
    isWeaponLike: weapon || attack || staff,
    isActivatedItem: activated,
    isCarryable: equipment || consumable || miscellaneous,
    showProficiencySelect: weapon || staff || staffUtility || armor || shield || spell,
    showRankSelect: weapon || staff || staffUtility || spell,
    showUsesTracker: !miscellaneous && !shield && !accessory && !passive,
    showTargetGroup: consumable || staffUtility || active || utility,
    showLineOfSight: staff || attack,
    showEffectsTab: !miscellaneous && !armor && !accessory && !shield && !mount && !booster,
    showRequirementsTab: consumable || weaponArt || utility || weapon || staff || staffUtility || attack || active,
    showEffectivenessBoxes: weaponArt || weapon || staff || attack,
    showValue: !spell && !ability,
    descriptionHeight: (other || passive) ? 176
      : (attack || weapon || armor || staff || mount) ? 75 : booster ? 105 : 150
  });
}

/**
 * Free-text weapon fields that other code has to parse, each with its parser and the advice shown when a value
 * can't be parsed. `parseAttackRange` feeds the targeting grid and the Enemy AI's reach, and `averageFormulaValue`
 * feeds the combat preview and the threat grade. Both return null for text they can't read.
 */
const VALIDATED_AUTHORED_FIELDS = Object.freeze([
  Object.freeze({
    path: 'system.weapon.rng',
    label: 'Range',
    readable: text => parseAttackRange(text) !== null,
    advice: 'Use a single number like 2, or a span like 2-3.'
  }),
  Object.freeze({
    path: 'system.weapon.atk',
    label: 'Attack',
    readable: text => averageFormulaValue(text) !== null,
    advice: 'Use a number like 9, or dice like 2d6+1.'
  })
]);

/**
 * Drop a submitted value its parser can't read, keep the stored value, and tell the author why. Removing the path
 * from the submission is enough, because Foundry writes only the fields it is given.
 */
function refuseUnreadableAuthoredFields(submitData) {
  for (const field of VALIDATED_AUTHORED_FIELDS) {
    const submitted = getPath(submitData, field.path);
    if (submitted === undefined) continue;
    const text = String(submitted).trim();
    if (text === '' || field.readable(text)) continue;
    deletePath(submitData, field.path);
    notifications.show(NOTIFICATION_IDS.ITEM_EDITOR_WARNING, {
      message: `${field.label} was not saved: "${text}" cannot be read. ${field.advice}`
    });
  }
  return submitData;
}

/**
 * Clean an Item or Resource sheet submission before Foundry writes it:
 * - drop Range and Attack text that can't be parsed;
 * - while a refinement or broken armor changes the shown values (echoGuardActive), drop a field that only sends
 *   back its shown value, so the saved base value survives;
 * - keep each modifier's saved condition tree and the saved effect list;
 * - give a Multiple-target range at least 2 targets;
 * - set the steal DC to match the stealable flag.
 */
function reconcileItemSubmitData(submitData, { prepared, stored, echoGuardActive = false } = {}) {
  if (!submitData || typeof submitData !== 'object') return submitData;
  refuseUnreadableAuthoredFields(submitData);
  const submittedSystem = submitData.system;
  const storedSystem = stored?.system ?? {};
  if (echoGuardActive) {
    for (const path of ITEM_DERIVED_ECHO_PATHS) {
      const submitted = getPath(submitData, path);
      if (submitted === undefined) continue;
      const derived = getPath(prepared, path);
      const source = getPath(stored, path);
      if (String(submitted) === String(derived) && String(derived) !== String(source)) deletePath(submitData, path);
    }
  }
  // Foundry's validation in _prepareSubmitData has already turned the form's indexed modifiers into an array.
  const incomingModifiers = submittedSystem?.modifiers;
  if (Array.isArray(incomingModifiers)) {
    const existing = Array.isArray(storedSystem.modifiers) ? storedSystem.modifiers : [];
    submittedSystem.modifiers = incomingModifiers.map((modifier, index) => ({
      ...modifier, conditionTree: existing[index]?.conditionTree ?? null
    }));
  }
  if (submittedSystem && Object.hasOwn(submittedSystem, 'effects')) {
    submittedSystem.effects = storedSystem.effects ?? [];
  }
  const effectData = submittedSystem?.effectData;
  if (effectData) {
    const rangeType = effectData.rngType ?? storedSystem.effectData?.rngType;
    if (rangeType === 'Multiple') {
      const incoming = Number(effectData.targets);
      const fallback = Number(storedSystem.effectData?.targets) || 2;
      effectData.targets = Math.max(2, Number.isFinite(incoming) ? incoming : fallback);
    }
  }
  const stealable = submittedSystem?.stealable;
  if (stealable?.flag === 'Drops') stealable.dc = 0;
  else if (stealable?.flag === 'Stealable'
    && Number(stealable.dc ?? storedSystem.stealable?.dc) === 0) stealable.dc = 10;
  return submitData;
}

/** The sheet for every Item type except Class and Resource, registered in init/registrations.mjs. */
export class ItemSheet extends EmblemSheetMixin(foundry.applications.sheets.ItemSheetV2) {
  /* -------------------------------------------- */
  /*  Sheet configuration                         */
  /* -------------------------------------------- */
  static DEFAULT_TAB = 'overview';

  static DEFAULT_OPTIONS = {
    classes: ['item', 'item-sheet'],
    position: { width: 500, height: 325 },
    window: { title: 'Item Sheet', icon: 'fas fa-file' },
    actions: {
      copyAsStaff: ItemSheet.copyAsStaff,
      openAnimationSettings: ItemSheet.openAnimationSettings,
      openCraftingSettings: ItemSheet.openCraftingSettings,
      toggleTradeDisabled: ItemSheet.toggleTradeDisabled,
      toggleWeaponArtProficiency: ItemSheet.toggleWeaponArtProficiency
    }
  };

  /** The tabs only choose which panel shows, so a read-only Item sheet keeps them for whoever may see it. */
  static NAVIGATION_CONTROLS = ['.tab-button'];

  static PARTS = { main: { template: `systems/${SYSTEM_ID}/templates/sheets/item-sheet.hbs` } };
  static SHEET_OPTIONS = {
    imageStudio: true,
    editImage: { gmOnly: true, attrFromTarget: true, position: true }
  };

  get capabilities() { return itemCapabilityProfile(this.document.type, this.document.system.itemType); }

  /**
   * Whether this reader is offered Copy As Staff. It ignores the compendium lock, so a locked compendium Spell keeps
   * the button, and copyAsStaff asks for an import there.
   */
  get canCopyFrom() { return canFoundryUserAuthorIgnoringLock(game.user, this.document); }

  static async toggleWeaponArtProficiency(event, target) {
    if (!this.isEditable) return;
    event.preventDefault();
    const key = target.dataset.proficiency;
    if (!key) return;
    const path = `system.wepArtData.${key}`;
    const enabled = !foundry.utils.getProperty(this.document, path);
    await this.document.update({ [path]: enabled });
    target.style.opacity = enabled ? '1' : '0.2';
  }

  static async toggleTradeDisabled(event) {
    if (!this.isEditable) return;
    event.preventDefault();
    await this.document.update({ 'system.tradeDisabled': !this.document.system.tradeDisabled });
  }

  /**
   * Create a Staff from this Spell through api.items.authoring.copyAsStaff, beside it in its actor or compendium. A
   * locked compendium takes no new document, so its Spell asks for an import before anything is confirmed or written.
   */
  static async copyAsStaff(event) {
    if (!this.canCopyFrom || this.document.type !== 'Spell') return;
    event.preventDefault();
    if (inLockedCompendium(this.document)) {
      notifications.show(NOTIFICATION_IDS.ITEM_EDITOR_WARNING,
        { message: 'This Spell is in a locked compendium. Import it first.' });
      return;
    }
    const kind = this.document.system.itemType === 'Attack' ? 'Staff' : 'Staff (U)';
    const name = `Staff of ${this.document.name}`;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Copy As Staff?' }, classes: [SYSTEM_ID], content: `<p>Create <strong>${escapeHtml(name)}</strong> (${escapeHtml(kind)})?</p>`
    });
    if (!confirmed) return;
    const result = await game.emblemRpg.api.items.authoring.copyAsStaff(this.document.uuid);
    notifications.showResult(result);
    if (result.ok && result.data?.uuid) (await fromUuid(result.data.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'copyAsStaff'); return null; }))?.sheet?.render(true);
  }

  /* -------------------------------------------- */
  /*  Frame actions                               */
  /* -------------------------------------------- */
  static openAnimationSettings() {
    if (this.isEditable && this.capabilities.editors.animation) return openAnimationEditorDialog(this.document);
  }
  static openCraftingSettings() {
    if (!this.isEditable || !this.capabilities.editors.crafting) return;
    return this.capabilities.editors.equipmentCrafting
      ? openCraftingSettingsDialog(this.document) : openConsumableCraftingDialog(this.document);
  }
  /** Copy As Staff shows even on a locked compendium Item, where it asks for an import. Settings need edit rights. */
  _sheetFrameButtons() {
    const editors = this.capabilities.editors;
    const copy = editors.copyAsStaff && this.canCopyFrom
      ? [{ action: 'copyAsStaff', icon: 'fas fa-wand-magic-sparkles', label: 'Copy As Staff' }] : [];
    if (!this.isEditable) return copy;
    return [
      ...copy,
      editors.animation && { action: 'openAnimationSettings', icon: 'fas fa-film', label: 'Animation Settings' },
      editors.crafting && { action: 'openCraftingSettings', icon: 'fas fa-hammer', label: 'Crafting Settings' }
    ].filter(Boolean);
  }

  /* -------------------------------------------- */
  /*  Sheet context                               */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.document;
    const capability = this.capabilities;
    if (!capability.tabs[this.activeTab]) this._activeTab = 'overview';
    context.item = item;
    context.activeTab = this.activeTab;
    context.capabilities = capability;
    context.typeFlags = itemSheetTypeFlags(item.type, item.system.itemType);
    context.pixelArt = item.getFlag(SYSTEM_ID, 'pixelArt') === true;
    const bust = context.pixelArt ? `?${item._stats?.modifiedTime ?? Date.now()}` : '';
    context.profileImg = `${item.img}${bust}`;
    context.descriptionHtml = sanitizeHtml(item.system.description ?? '');
    context.hasParams = item.system.effectData.params.length > 0
      || item.system.effectData.savingThrowDC.required === true
      || item.system.effectData.skillCheckDC.required === true;
    context.tradeDisabled = item.system.tradeDisabled === true;
    context.hideValueField = context.tradeDisabled && !this.isEditable;
    context.owner = actorOwnerContext(item);
    context.showOwnerStealControls = context.owner?.isNpc === true && context.typeFlags.isCarryable;
    return context;
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */
  /** Wire the content, then rebuild the sheet's own header buttons to match the current edit rights. */
  _onRender(context, options) {
    super._onRender(context, options);
    this.setPosition({ height: this.capabilities.compact ? 105 : 325 });
    this._wireSheet(this.element);
    this._syncFrameButtons();
  }

  /**
   * Foundry draws header buttons only with the window frame on the first render, so the sheet's own buttons are
   * replaced here, in front of the close button, to match the current edit rights.
   */
  _syncFrameButtons() {
    const header = this.element.querySelector('.window-header');
    const close = header?.querySelector('button[data-action="close"]');
    if (!close) return;
    for (const action of MANAGED_FRAME_ACTIONS) header.querySelector(`button[data-action="${action}"]`)?.remove();
    for (const { action, icon, label } of this._sheetFrameButtons()) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `header-control ${icon} icon`; button.dataset.action = action;
      button.setAttribute('aria-label', label); button.setAttribute('data-tooltip', label);
      close.insertAdjacentElement('beforebegin', button);
    }
  }

  /* -------------------------------------------- */
  /*  Authoring controls                          */
  /* -------------------------------------------- */
  _wireSheet(root) {
    this._wireTabs(root);
    if (!this.isEditable) return this._lockAuthoring(root);
    this._wireDescription(root);
    this._wireFormulaEditors(root);
    this._wireToggleGrids(root);
    this._wireEffects(root);
    this._wireModifiers(root);
    this._wireRequirements(root);
    this._wireAura(root);
  }

  _wireTabs(root) {
    for (const button of root.querySelectorAll('.tab-navigator .tab-button')) {
      button.addEventListener('click', event => {
        event.preventDefault();
        const tab = button.dataset.tab;
        if (!this.capabilities.tabs[tab]) return;
        this._activeTab = tab;
        showTabPanels(root, tab, {
          controls: '.tab-navigator .tab-button',
          panels: '[data-tab-content]',
          attribute: 'tabContent',
          display: ''
        });
      });
    }
  }

  /**
   * Disable the authoring controls for a user who can't edit the Item. Buttons get aria-disabled instead. The window
   * header is left alone: close, Copy UUID and the other frame buttons stay usable on a locked Item.
   */
  _lockAuthoring(root) {
    root.classList.add('is-readonly');
    const content = root.querySelector('.window-content') ?? root;
    for (const control of content.querySelectorAll('input, select, textarea')) control.disabled = true;
    for (const editable of content.querySelectorAll('[contenteditable]')) editable.setAttribute('contenteditable', 'false');
    for (const control of content.querySelectorAll('button:not(.tab-button), [data-action]:not(.tab-button)')) control.setAttribute('aria-disabled', 'true');
  }

  _wireDescription(root) {
    const editor = root.querySelector('.item-description-editor .ide-content');
    editor?.addEventListener('blur', async () => {
      const next = sanitizeHtml(editor.innerHTML);
      if (next !== (this.document.system.description ?? '')) await this.document.update({ 'system.description': next }, { render: false });
    });
  }

  _wireFormulaEditors(root) {
    root.querySelector('.uses-label-trigger')?.addEventListener('click', event => {
      event.preventDefault();
      const durability = itemSheetTypeFlags(this.document.type, this.document.system.itemType).isDurabilityItem;
      openScalingEditor(this, 'uses', durability ? { title: 'Durability', baseLabel: 'base durability' } : {});
    });
    root.querySelector('.range-label-trigger')?.addEventListener('click', event => { event.preventDefault(); openScalingEditor(this, 'range'); });
    root.querySelector('.target-label-trigger')?.addEventListener('click', event => {
      event.preventDefault();
      if (this.capabilities.editors.target) openTargetingEditor(this);
    });
    root.querySelector('.dmg-conditions-trigger')?.addEventListener('click', event => { event.preventDefault(); openDamageConditionsEditor(this); });
    for (const button of root.querySelectorAll('.open-params-btn')) {
      button.addEventListener('click', event => {
        event.preventDefault();
        openEffectParametersEditor(this);
      });
    }
  }

  _wireToggleGrids(root) {
    for (const input of root.querySelectorAll('.hidden-checkbox, .effective-against-section input[type="checkbox"], .weapon-advantage-section input[type="checkbox"]')) {
      input.addEventListener('change', () => {
        if (input.name.startsWith('system.armor.vulns.') && input.checked) {
          const other = root.querySelector(`[name="system.armor.prots.${input.name.split('.').pop()}"]`);
          if (other) { other.checked = false; iconOpacity(other, false); }
        }
        if (input.name.startsWith('system.armor.prots.') && input.checked) {
          const other = root.querySelector(`[name="system.armor.vulns.${input.name.split('.').pop()}"]`);
          if (other) { other.checked = false; iconOpacity(other, false); }
        }
        iconOpacity(input);
      });
    }
  }

  _wireEffects(root) {
    for (const button of root.querySelectorAll('.add-effect-btn')) button.addEventListener('click', event => { event.preventDefault(); openEffectEditor(this); });
    for (const button of root.querySelectorAll('.eff-row-edit')) button.addEventListener('click', event => { event.preventDefault(); openEffectEditor(this, Number(button.dataset.effectIndex)); });
    for (const button of root.querySelectorAll('.eff-row-delete')) button.addEventListener('click', async event => {
      event.preventDefault();
      const index = Number(button.dataset.effectIndex);
      if (!await this._confirmDelete('effect', this.document.system.effects[index]?.name)) return;
      const effects = foundry.utils.deepClone(Array.from(this.document.system.effects)); effects.splice(index, 1);
      await this.document.update({ 'system.effects': effects });
    });
    this._wireInlineName(root, '.eff-row-name', 'effectIndex', 'system.effects');
    this._wireReorder(root, '.effects-entries', '.effects-entry', '.eff-row-drag', 'effectIndex', 'system.effects');
  }

  _wireModifiers(root) {
    root.querySelector('.add-modifier')?.addEventListener('click', async event => {
      event.preventDefault();
      let kind = 'standard';
      if (this.document.system.aura.enabled) {
        kind = await foundry.applications.api.DialogV2.wait({
          window: { title: 'Add Modifier' }, content: '<p>Choose the modifier kind.</p>',
          classes: [SYSTEM_ID],
          buttons: [
            { action: 'standard', label: 'Standard Modifier', default: true },
            { action: 'aura', label: 'Aura Modifier' },
            { action: 'cancel', label: 'Cancel' }
          ]
        });
      }
      if (kind === 'standard' || kind === 'aura') openModifierEditor(this, null, kind);
    });
    for (const button of root.querySelectorAll('.edit-modifier')) button.addEventListener('click', event => { event.preventDefault(); openModifierEditor(this, Number(button.dataset.index)); });
    for (const button of root.querySelectorAll('.delete-modifier')) button.addEventListener('click', async event => {
      event.preventDefault();
      const index = Number(button.dataset.index);
      if (!await this._confirmDelete('modifier', this.document.system.modifiers[index]?.name)) return;
      const modifiers = foundry.utils.deepClone(Array.from(this.document.system.modifiers)); modifiers.splice(index, 1);
      await this.document.update({ 'system.modifiers': modifiers });
    });
    this._wireReorder(root, '.modifier-entries', '.modifier-entry', '.modifier-drag-handle', 'modifierIndex', 'system.modifiers');
  }

  _wireRequirements(root) {
    root.querySelector('.add-requirement-btn')?.addEventListener('click', event => { event.preventDefault(); openRequirementEditor(this); });
    for (const button of root.querySelectorAll('.req-row-edit')) button.addEventListener('click', event => { event.preventDefault(); openRequirementEditor(this, Number(button.dataset.requirementIndex)); });
    for (const button of root.querySelectorAll('.req-row-delete')) button.addEventListener('click', async event => {
      event.preventDefault();
      const index = Number(button.dataset.requirementIndex);
      if (!await this._confirmDelete('requirement', this.document.system.requirements[index]?.name)) return;
      const requirements = foundry.utils.deepClone(Array.from(this.document.system.requirements)); requirements.splice(index, 1);
      await this.document.update({ 'system.requirements': requirements });
    });
    this._wireInlineName(root, '.req-row-name', 'requirementIndex', 'system.requirements');
    this._wireReorder(root, '.requirement-entries', '.requirement-entry', '.req-row-drag', 'requirementIndex', 'system.requirements');
  }

  _wireAura(root) {
    const enabled = root.querySelector('.aura-enabled-checkbox');
    const range = root.querySelector('.aura-rng-input');
    enabled?.addEventListener('change', () => {
      range.disabled = !enabled.checked;
      range.value = enabled.checked ? String(Math.max(1, Number(range.value) || 1)) : '0';
    });
    range?.addEventListener('change', () => { range.value = String(Math.min(5, Math.max(1, Number(range.value) || 1))); });
  }

  _wireInlineName(root, selector, indexKey, path) {
    for (const input of root.querySelectorAll(selector)) input.addEventListener('change', async event => {
      event.preventDefault();
      const index = Number(input.dataset[indexKey]);
      const entries = sourceArray(this.document, path);
      if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
      entries[index] = { ...entries[index], name: input.value };
      await this.document.update({ [path]: entries });
    });
  }

  _wireReorder(root, listSelector, rowSelector, handleSelector, indexKey, path) {
    let dragged = null;
    for (const list of root.querySelectorAll(listSelector)) {
      list.addEventListener('dragstart', event => {
        const row = event.target instanceof Element ? event.target.closest(rowSelector) : null;
        if (!row || !list.contains(row) || !event.target.closest(handleSelector)) {
          event.preventDefault(); return;
        }
        dragged = row;
        row.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', 'emblem-item-entry');
      });
      list.addEventListener('dragover', event => {
        if (!dragged || dragged.parentElement !== list) return;
        event.preventDefault();
        const row = event.target instanceof Element ? event.target.closest(rowSelector) : null;
        list.querySelectorAll(rowSelector).forEach(element => element.classList.remove('is-drop-before', 'is-drop-after'));
        if (!row || row === dragged) return;
        row.classList.add(event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? 'is-drop-before' : 'is-drop-after');
      });
      list.addEventListener('drop', async event => {
        if (!dragged || dragged.parentElement !== list) return;
        event.preventDefault();
        const row = event.target instanceof Element ? event.target.closest(rowSelector) : null;
        const from = Number(dragged.dataset[indexKey]);
        let to = row ? Number(row.dataset[indexKey]) : list.querySelectorAll(rowSelector).length - 1;
        if (row && event.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2) to += 1;
        if (to > from) to -= 1;
        const entries = sourceArray(this.document, path);
        if (Number.isInteger(from) && from >= 0 && from < entries.length && Number.isInteger(to) && to >= 0 && to < entries.length && from !== to) {
          await this.document.update({ [path]: moveEntry(entries, from, to) });
        }
      });
      list.addEventListener('dragend', () => {
        dragged?.classList.remove('is-dragging');
        list.querySelectorAll(rowSelector).forEach(element => element.classList.remove('is-drop-before', 'is-drop-after'));
        dragged = null;
      });
    }
  }

  /* -------------------------------------------- */
  /*  Submission                                  */
  /* -------------------------------------------- */
  _prepareSubmitData(event, form, formData) {
    if (!this.isEditable) return {};
    const data = super._prepareSubmitData(event, form, formData);
    return reconcileItemSubmitData(data, {
      prepared: this.document,
      stored: this.document._source,
      echoGuardActive: !!this.document.appliedRefinement || this.document.isBrokenArmor
    });
  }

  _confirmDelete(kind, name) {
    return foundry.applications.api.DialogV2.confirm({
      window: { title: `Delete ${kind}?` }, classes: [SYSTEM_ID], content: `<p>Remove ${escapeHtml(name || `this ${kind}`)}?</p>`
    });
  }
}
/* -------------------------------------------- */
/*  Item sheet helpers                          */
/* -------------------------------------------- */
function iconOpacity(input, on = input.checked) {
  const image = input.parentElement?.querySelector('img');
  if (image) image.style.opacity = on ? '1' : '0.2';
}

function actorOwnerContext(item) {
  const parent = item.parent;
  if (parent?.documentName !== 'Actor') return null;
  const actorType = parent.system.faction.role ?? 'Neutral';
  const isNpc = parent.type === 'Character' && !['Lord', 'Retainer'].includes(actorType);
  return {
    uuid: parent.uuid, name: parent.name, img: parent.img, isNpc, tooltip: `Owned by ${parent.name}`,
    stealableFlag: item.system.stealable.flag ?? 'None', stealableDC: item.system.stealable.dc ?? 10
  };
}

function sourceArray(item, path) {
  const source = foundry.utils.getProperty(item._source ?? item, path);
  return foundry.utils.deepClone(Array.isArray(source) ? source : []);
}

function moveEntry(entries, from, to) {
  const copy = [...entries];
  const [entry] = copy.splice(from, 1);
  copy.splice(to, 0, entry);
  return copy;
}

function getPath(value, path) {
  return path.split('.').reduce((node, key) => node?.[key], value);
}

function deletePath(value, path) {
  const parts = path.split('.');
  const leaf = parts.pop();
  const parent = parts.reduce((node, key) => node?.[key], value);
  if (parent && leaf) delete parent[leaf];
}



/* -------------------------------------------- */
/*  Resource sheet                              */
/* -------------------------------------------- */
/** The sheet for Resource Items, registered in init/registrations.mjs. */
export class ResourceSheet extends EmblemSheetMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ['item', 'resource-sheet'],
    position: { width: 500, height: 225 },
    window: { icon: 'fas fa-gem' }
  };

  static PARTS = { main: { template: `systems/${SYSTEM_ID}/templates/sheets/resource-sheet.hbs` } };
  static SHEET_OPTIONS = { preserveScroll: false, imageStudio: true, editImage: { gmOnly: true } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.document;
    context.item = item;
    context.resourceTypes = RESOURCE_TYPES.map(value => ({ value, selected: value === item.system.resourceType }));
    context.foodTypes = ['', ...FOOD_TYPES].map(value => ({
      value,
      label: value ? `${value} (${FOOD_TYPE_STATS[value]})` : '--',
      selected: value === item.system.foodType
    }));
    context.owner = item.parent?.type === 'Character' ? actorOwnerContext(item) : null;
    return context;
  }

  _prepareSubmitData(event, form, formData) {
    if (!this.isEditable) return {};
    const data = super._prepareSubmitData(event, form, formData);
    return reconcileItemSubmitData(data, { stored: this.document._source });
  }
}
