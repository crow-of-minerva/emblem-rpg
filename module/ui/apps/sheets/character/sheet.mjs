/** @layer ui/apps/sheets/character */
import { playMountFlourish } from '../../../../external/sequencer/animation-dispatch.mjs';
import { SYSTEM_ID } from '../../../../contracts/protocol.mjs';
import { GROWTH_KEYS } from '../../../../contracts/domains/characters.mjs';
import { escapeHtml } from '../../../../lib/dom/html.mjs';
import { cachedTrimmedImage, trimContainerSprites } from '../../../../lib/dom/image-trim.mjs';
import {
  COMBAT_STATS,
  CORE_STATS,
  PROFICIENCIES,
  SKILLS,
  UNIT_TYPES,
  adjustSpecialPool,
  resolveAvatarScale,
  skillRankLabel,
  statPenalty,
  toggleExtraLife,
  zenithStats
} from '../../../../game/character/rules.mjs';
import {
  CHARACTER_INVENTORY_LIMITS,
  EQUIPMENT_NOTICES,
  characterActorItemDropAllowed,
  characterEquipmentCapacity,
  characterEquipmentCount,
  characterItemAdmission,
  characterItemListing,
  characterItemTransfers,
  characterPocketCount,
  equipmentStateField,
  matchingResourceStack
} from '../../../../game/character/inventory.mjs';
import {
  affinityDirections,
  affinitySummary,
  clampSupportRank,
  isSupportEligible,
  rallyStatBonuses,
  rallyStatLine,
  supportRankLetter,
  supportXpNeeded
} from '../../../../game/support/rules.mjs';
import { affinityLabel, affinityNames } from '../../../../game/support/affinities.mjs';
import {
  affinityTableReady, currentAffinityTable, recipeLibraryReady
} from '../../../../foundry/adapters/services/json-files.mjs';
import { projectActorPartyId, readPartyState } from '../../../../foundry/adapters/projections/parties.mjs';
import { SUPPORT_UNRANKED } from '../../../../contracts/domains/progression.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../../presentation/interface/notifications.mjs';
import { playMenuSound } from '../../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../../presentation/audio/sound-database.mjs';
import { ActorControlPanel } from '../../menus/acp-app.mjs';
import { RECIPE_DRAG_TYPE, RecipeLibraryApp } from '../../menus/recipe-library-app.mjs';
import { SONG_DRAG_TYPE, SongLibraryApp } from '../../menus/song-library-app.mjs';
import { projectKnownRecipeIds, projectKnownRecipes } from '../../../../foundry/adapters/projections/downtime.mjs';
import { GROWTH_STAT_LABEL } from '../../../../game/downtime/cooking.mjs';
import { describeBonuses } from '../../../../game/downtime/performance.mjs';
import {
  chooseSkillRollMode,
  openGoldAmountDialog,
  openResourceAmountDialog,
  runDropItemFlow
} from '../../../dialogs.mjs';
import { activateHotbarItem } from '../../../controls/targeting.mjs';
import { resumeMovementAfterTargeting } from '../../../controls/movement.mjs';
import {
  commitSupportPartners,
  editCharacterStat,
  editLevelExperience,
  editProficiency,
  editSkill,
  openAddSupportDialog,
  openClassSelectionDialog,
  openSupportEditorDialog
} from './authoring.mjs';
import { TOOLTIP_IDS, getTooltip } from '../../../tooltips.mjs';
import { EmblemSheetMixin, canCurrentUserAuthor } from '../base.mjs';
import { CONVOY_GOLD_DRAG_TYPE } from '../../../../contracts/domains/economy.mjs';
import { exposesLootToParty } from '../../../../game/economy/trade.mjs';
import { isDroppableItem } from '../../../../game/objects/rules.mjs';
import { readDropPayload } from '../../../../foundry/adapters/services/host.mjs';
import { reportFoundryError, FoundryDiagnostics, reportFoundryProbe } from '../../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Sheet vocabulary                            */
/* -------------------------------------------- */
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });
const DROP_LOCK_TTL = 2000;
const UNLISTED_COMBAT_STATS = new Set([
  'brk', 'critDmg', 'critRed', 'brkRed', 'wgtRed', 'sight', 'expMultiplier', 'stnRegen'
]);
const INVENTORY_PAGE_SIZE = 5;
const INVENTORY_SECTION_ORDER = Object.freeze({
  equipment: Object.freeze({ Armor: 0, Weapon: 1, Staff: 2, 'Staff (U)': 3, Shield: 4, Accessory: 5 }),
  spells: Object.freeze({ Attack: 0, Utility: 1 }),
  abilities: Object.freeze({ Mount: 0, 'Weapon Art': 1, Active: 2 }),
  pockets: Object.freeze({ Consumable: 0, Miscellaneous: 1, Resource: 2 })
});
const HOTBAR_ITEM_TYPES = new Set(['Consumable', 'Spell']);
const HOTBAR_ITEM_SUBTYPES = new Set(['Active', 'Weapon Art']);
const HOTBAR_EQUIPMENT_SUBTYPES = new Set(['Weapon', 'Attack', 'Staff (U)', 'Staff']);
const JOURNAL_DROP_TYPES = new Set(['JournalEntry', 'JournalEntryPage']);
const DRAGGABLE_ITEM_ROWS = '.inventory-row[data-item-id], .passive-item-row[data-item-id]';
const PROFICIENCY_TIERS = Object.freeze({
  armor: Object.freeze([
    ['prof-armor-off', 'Armor'], ['prof-armor-l', 'Light Armor'], ['prof-armor-m', 'Medium Armor'], ['prof-armor-h', 'Heavy Armor']
  ]),
  riding: Object.freeze([['prof-riding-off', 'Riding'], ['prof-riding-on', 'Horseback Riding'], ['prof-flying-on', 'Aerial Riding']])
});

/** Build the Character sheet's inventory tables from the unit's Items (_prepareGearContext passes its documents). */
export function buildCharacterInventory(items, options = {}) {
  return buildCharacterInventoryView(items, options);
}

/** Whether an Item can go on the hotbar: something the unit uses, not something it only carries. */
function characterItemHotbarEligible(item) {
  const itemType = String(item.system.itemType ?? '');
  if (HOTBAR_ITEM_TYPES.has(item.type) || HOTBAR_ITEM_SUBTYPES.has(itemType)) return true;
  if (item.type === 'Equipment') return HOTBAR_EQUIPMENT_SUBTYPES.has(itemType);
  return false;
}

/** Where a dragged item row may land, or null when it may start no drag at all. */
function characterDragCapabilities(item) {
  const rule = inventoryRuleItem(item);
  const canDragToHotbar = characterItemHotbarEligible(item);
  const canDragToActor = characterActorItemDropAllowed(rule);
  if (!canDragToHotbar && !canDragToActor) return null;
  const copies = canDragToActor && !characterItemTransfers(rule);
  const landing = copies ? 'copy onto another unit' : 'other actor';
  const destination = canDragToHotbar && canDragToActor
    ? `Drag to hotbar or ${landing}`
    : canDragToHotbar ? 'Drag to hotbar' : `Drag to ${landing}`;
  return { canDragToHotbar, canDragToActor, copies, destination };
}

/** Whether a drop payload names a journal entry or page. */
export function isJournalDrop(payload) {
  return JOURNAL_DROP_TYPES.has(payload.type) && Boolean(payload.uuid);
}

/* -------------------------------------------- */
/*  Character sheet                             */
/* -------------------------------------------- */
/** The sheet for Character actors, registered in init/registrations.mjs. */
export class CharacterSheet extends EmblemSheetMixin(foundry.applications.sheets.ActorSheetV2) {
  /* -------------------------------------------- */
  /*  Sheet configuration                         */
  /* -------------------------------------------- */
  static DEFAULT_OPTIONS = {
    classes: ['actor', 'character-sheet'],
    position: { width: 550, height: 450 },
    viewPermission: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
    actions: {
      restoreStandardAction: CharacterSheet.restoreStandardAction,
      spendStandardAction: CharacterSheet.spendStandardAction,
      openControlPanel: CharacterSheet.openControlPanel,
      openItem: CharacterSheet.openItem,
      openClassSheet: CharacterSheet.openClassSheet,
      selectClass: CharacterSheet.selectClass,
      rollSkill: CharacterSheet.rollSkill,
      setTab: CharacterSheet.setTab,
      setInventoryTab: CharacterSheet.setInventoryTab,
      toggleInventorySort: CharacterSheet.toggleInventorySort,
      toggleInventorySortDirection: CharacterSheet.toggleInventorySortDirection,
      toggleCarriedItem: CharacterSheet.toggleCarriedItem,
      toggleMount: CharacterSheet.toggleMount,
      removeCarriedItem: CharacterSheet.removeCarriedItem,
      toggleGrowths: CharacterSheet.toggleGrowths,
      adjustSpecial: CharacterSheet.adjustSpecial,
      setExtraLives: CharacterSheet.setExtraLives,
      addSupport: CharacterSheet.addSupport,
      removeSupport: CharacterSheet.removeSupport,
      openLinkedConvoy: CharacterSheet.openLinkedConvoy,
      openJournal: CharacterSheet.openJournal,
      unlinkJournal: CharacterSheet.unlinkJournal,
      openRecipe: CharacterSheet.openRecipe,
      unlinkRecipe: CharacterSheet.unlinkRecipe,
      openSong: CharacterSheet.openSong,
      unlinkSong: CharacterSheet.unlinkSong
    },
    window: { title: 'Actor Sheet', icon: 'fas fa-user' }
  };

  static DEFAULT_TAB = 'main';

  static SHEET_OPTIONS = { preserveFocus: true, dragDrop: true };

  static NAVIGATION_CONTROLS = [
    '.tab-button', '.table-tab-button', '.label-show-growths', '.skill-toggle', '.sort-by-toggle', '.sort-dir-toggle',
    '.open-linked-convoy'
  ];

  /** Gameplay controls an owning Player keeps on a read-only sheet, since they send commands instead of editing. */
  static GAMEPLAY_CONTROLS = ['.inventory-remove-button'];

  static PARTS = {
    main: { template: `systems/${SYSTEM_ID}/templates/sheets/character-sheet.hbs` }
  };

  static async spendStandardAction() {
    return game.emblemRpg.api.character.actions.spendStandard(this.document.uuid);
  }

  static async restoreStandardAction() {
    return game.emblemRpg.api.character.actions.restoreStandard(this.document.uuid);
  }

  static openControlPanel(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    return ActorControlPanel.openFor(this.document);
  }

  /** The Control Panel button, for someone who may author the unit: staff, or a Trusted Player who owns it. */
  _sheetFrameButtons() {
    if (!canCurrentUserAuthor(this.document)) return [];
    return [{ action: 'openControlPanel', icon: 'fas fa-sliders', label: 'Control Panel' }];
  }

  /** An innate Item's remove button stays disabled when a read-only sheet hands its owner the gameplay controls. */
  _toggleDisabled(disabled) {
    super._toggleDisabled(disabled);
    if (!disabled) return;
    for (const button of this.element.querySelectorAll('.inventory-remove-button[data-item-id]')) {
      const item = this.document.items.get(button.dataset.itemId);
      if (!item || isInnateCharacterItem(item)) button.disabled = true;
    }
  }

  /* -------------------------------------------- */
  /*  Sheet actions                               */
  /* -------------------------------------------- */
  static openItem(_event, target) {
    this.document.items.get(target.dataset.itemId)?.sheet?.render(true);
  }

  static openClassSheet() {
    const classItem = this.document.items.find(item => item.type === 'Class');
    if (classItem) return classItem.sheet?.render(true);
    return notifications.show(NOTIFICATION_IDS.CLASS_NOT_ASSIGNED);
  }

  static selectClass() {
    if (!this.isEditable) return;
    return openClassSelectionDialog(this.document, this);
  }

  static async rollSkill(_event, target) {
    const skillKey = target.dataset.skill;
    const skill = SKILLS.find(entry => entry.key === skillKey);
    if (!skill) return;
    const mode = await chooseSkillRollMode(skill.label);
    if (!mode) return;
    return game.emblemRpg.api.character.skills.roll({
      actorUuid: this.document.uuid,
      skillKey,
      mode
    });
  }

  static setInventoryTab(_event, target) {
    const tab = target.dataset.inventoryTab;
    if (!tab || tab === this._activeInventoryTab) return;
    this._activeInventoryTab = tab;
    this.render(false);
  }

  static toggleInventorySort() {
    this._inventorySortBy = this._inventorySortBy === 'name' ? 'type' : 'name';
    this.render(false);
  }

  static toggleInventorySortDirection() {
    this._inventorySortDir = this._inventorySortDir === 'desc' ? 'asc' : 'desc';
    this.render(false);
  }

  static openLinkedConvoy(event, target) {
    event.preventDefault();
    const convoy = resolveDocumentSync(target.dataset.convoyUuid);
    convoy?.sheet?.render(true);
  }

  /** Equip, wear or wield an item. On success, play the UI blip, or the mount animation for a Mount. */
  static async toggleCarriedItem(event, target) {
    event.preventDefault();
    if (!this.canPlay) return;
    const item = this.document.items.get(target.dataset.itemId);
    if (!item) return;
    const wasEquipped = item.system.isEquipped === true;
    const result = await game.emblemRpg.api.character.inventory.toggleEquipment({
      actorUuid: this.document.uuid,
      itemId: item.id
    });
    if (!result?.ok) return result;
    if (result.data?.notices?.includes(EQUIPMENT_NOTICES.TWO_HANDED_UNWIELDED)) {
      notifications.show(NOTIFICATION_IDS.INVENTORY_TWO_HANDED_UNWIELDED);
    }
    if (item.system.itemType === 'Mount') void playMountFlourish(this.document, { dismount: wasEquipped });
    else playMenuSound(SOUND_IDS.UI_BLIP_1);
    return result;
  }

  /** Mount or dismount. A GM toggles it directly, and a player spends the unit's action (activateMountAsAction). */
  static async toggleMount(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const item = this.document.items.get(target.dataset.itemId);
    if (!item) return;
    if (game.user.isGM) return CharacterSheet.toggleCarriedItem.call(this, event, target);
    if (!this.canPlay) return;
    return activateMountAsAction(this.document, item);
  }

  /**
   * Take a carried Item off the unit. A droppable item goes through the drop prompt (runDropItemFlow), whose commands
   * its owner may use. Anything else, such as a passive feature, is deleted after a confirmation, which needs
   * authoring rights.
   */
  static async removeCarriedItem(event, target) {
    event.preventDefault();
    if (!this.canPlay) return;
    const item = this.document.items.get(target.dataset.itemId);
    if (!item) return;
    if (isInnateCharacterItem(item)) {
      return notifications.show(NOTIFICATION_IDS.INVENTORY_WARNING, {
        message: `${item.name} is an innate feature and cannot be removed here.`
      });
    }
    const passive = target.classList.contains('passive-item-delete');
    if (!passive && isDroppableItem({ type: item.type, innate: isInnateCharacterItem(item) })) {
      return runDropItemFlow({ actor: this.document, itemId: item.id, resume: resumeMovementAfterTargeting });
    }
    if (!this.isEditable) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Remove Item' },
      classes: [SYSTEM_ID],
      content: `<p>Remove <strong>${escapeHtml(item.name)}</strong> from ${escapeHtml(this.document.name)}?</p>`,
      modal: true
    });
    if (confirmed) await this.document.deleteEmbeddedDocuments('Item', [item.id]);
  }

  /** Swap the stat column between values and growth rates in the DOM. Nothing on the unit changes. */
  static toggleGrowths(_event, target) {
    this._showGrowths = !this._showGrowths;
    showGrowthColumn(this.element, this._showGrowths);
    target.classList.toggle('is-active', this._showGrowths);
  }

  static async adjustSpecial(_event, target) {
    if (!this.isEditable) return;
    const key = target.dataset.resource;
    const delta = Number(target.dataset.delta) || 0;
    const node = this.document.system.special[key];
    if (!node || !delta) return;
    const maximum = key === 'extraLives' ? 3 : Number.POSITIVE_INFINITY;
    const { value, max } = adjustSpecialPool(node, delta, maximum);
    return this.document.update({
      [`system.special.${key}.max`]: max,
      [`system.special.${key}.value`]: value
    });
  }

  static async setExtraLives(_event, target) {
    if (!this.isEditable) return;
    const next = toggleExtraLife(this.document.system.special.extraLives, target.dataset.heartIndex);
    return this.document.update({ 'system.special.extraLives.value': next.value });
  }

  /* -------------------------------------------- */
  /*  Notes                                       */
  /* -------------------------------------------- */
  static async openJournal(event, target) {
    event.preventDefault();
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (uuid) await openLinkedJournal(uuid);
  }

  static async unlinkJournal(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isEditable) return;
    const uuid = target.closest('[data-uuid]')?.dataset.uuid;
    if (!uuid) return;
    await unlinkJournalFromActor(this.document, uuid);
    this.render(false);
  }

  static async openRecipe(event, target) {
    event.preventDefault();
    const id = target.closest('[data-recipe-id]')?.dataset.recipeId;
    if (id) RecipeLibraryApp.open({ recipeId: id });
  }

  static async unlinkRecipe(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user.isGM) return;
    const id = target.closest('[data-recipe-id]')?.dataset.recipeId;
    if (!id) return;
    await unlinkRecipeFromActor(this.document, id);
    this.render(false);
  }

  static async openSong(event, target) {
    event.preventDefault();
    const id = target.closest('[data-song-id]')?.dataset.songId;
    if (id) SongLibraryApp.open({ songId: id });
  }

  static async unlinkSong(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user.isGM) return;
    const id = target.closest('[data-song-id]')?.dataset.songId;
    if (!id) return;
    await unlinkSongFromActor(this.document, id);
    this.render(false);
  }

  /** Teach the unit a Personal recipe dragged from the Recipe Library onto the open Notes tab. GM only. */
  async _onDropRecipe(event, payload) {
    if (!this._isNotesDrop(event) || !game.user.isGM) return false;
    const result = await linkRecipeToActor(this.document, String(payload.recipeId ?? ''));
    if (!result.ok) {
      notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_WARNING, { message: result.reason });
      return false;
    }
    notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_INFO, {
      message: `${this.document.name} learned ${result.name || 'a recipe'}.`
    });
    this.render(false);
    return true;
  }

  /** Teach the unit a Personal song dragged from the Song Library onto the open Notes tab. GM only. */
  async _onDropSong(event, payload) {
    if (!this._isNotesDrop(event) || !game.user.isGM) return false;
    const result = await linkSongToActor(this.document, String(payload.songId ?? ''));
    if (!result.ok) {
      notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_WARNING, { message: result.reason });
      return false;
    }
    notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_INFO, {
      message: `${this.document.name} learned ${result.name || 'a song'}.`
    });
    this.render(false);
    return true;
  }

  /** Link a journal entry or page dropped on the open Notes tab, then ask the host to let the unit's owners read it. */
  async _onDropJournal(event, payload) {
    if (!this._isNotesDrop(event) || !this.isEditable) return false;
    const result = await linkJournalToActor(this.document, payload.uuid);
    if (!result.ok) {
      notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_WARNING, { message: result.reason });
      return false;
    }
    await game.emblemRpg.api.character.knowledge.grantJournalAccess({
      actorUuid: this.document.uuid, journalUuid: payload.uuid
    });
    notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_INFO, {
      message: `${result.name} linked to ${this.document.name}.`
    });
    this.render(false);
    return true;
  }

  _isNotesDrop(event) {
    const notes = event?.target?.closest?.('.tab-content[data-tab="notes"]');
    return Boolean(notes) && notes.style?.display !== 'none';
  }

  /** Withdraw gold from the party Convoy when its coin icon is dropped here. The host checks the balance again. */
  async _onDropConvoyGold(_event, payload) {
    if (!this.document.isOwner) return false;
    const convoy = resolveDocumentSync(payload.convoyUuid) ?? game.actors.get(payload.convoyId) ?? null;
    if (!convoy) return false;
    const available = Number(convoy.system?.gp) || 0;
    if (available <= 0) {
      notifications.show(NOTIFICATION_IDS.CONVOY_EMPTY, { convoyName: convoy.name });
      return false;
    }
    const amount = await openGoldAmountDialog(convoy.name, this.document.name, available);
    if (!amount) return false;
    const result = await game.emblemRpg.api.economy.convoyWithdraw({
      targetActorUuid: this.document.uuid, convoyUuid: convoy.uuid, amount
    });
    notifications.showResult(result);
    return result?.ok === true;
  }

  /* -------------------------------------------- */
  /*  Support bonds                               */
  /* -------------------------------------------- */
  static async addSupport() {
    if (!this.isEditable) return;
    const chosen = await openAddSupportDialog(this.document);
    if (chosen) await this.addSupportPartner(chosen);
  }

  static async removeSupport(event, target) {
    event.stopPropagation();
    if (!this.isEditable) return;
    const index = Number(target.dataset.index);
    const partners = supportPartnerList(this.document);
    if (!Number.isInteger(index) || index < 0 || index >= partners.length) return;
    partners.splice(index, 1);
    await commitSupportPartners(this.document, partners);
  }

  /** Add a Support partner to this unit's list. The setPartners command also writes the partner's side of the bond. */
  async addSupportPartner(uuid) {
    if (!this.isEditable) return;
    const partner = await fromUuid(String(uuid ?? '')).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'partner'); return null; });
    const warn = message => notifications.show(NOTIFICATION_IDS.SUPPORT_WARNING, { message });
    if (!partner || partner.documentName !== 'Actor') return warn('Invalid actor reference.');
    if (partner.uuid === this.document.uuid) return warn('An actor cannot Support itself.');
    if (!isSupportEligible({ type: partner.type, actorType: partner.system.faction.role })) {
      return warn('Only Lords and Retainers can be added as Supports.');
    }
    const partners = supportPartnerList(this.document);
    if (partners.some(entry => entry.actorUUID === partner.uuid)) {
      return warn(`${partner.name} is already a Support.`);
    }
    partners.push({ actorUUID: partner.uuid, name: partner.name, rank: SUPPORT_UNRANKED, xp: 0 });
    await commitSupportPartners(this.document, partners);
  }

  /* -------------------------------------------- */
  /*  Sheet context                               */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.actor = this.document;
    context.exposesLoot = exposesLootToParty(this.document.system.faction.role);
    context.items = [...this.document.items].map(item => characterItemView(item, context.exposesLoot));
    context.actionAvailable = Boolean(this.document.system.turn.actionAvailable);
    context.showSupports = ['Lord', 'Retainer'].includes(this.document.system.faction.role);
    context.activeTab = this._activeTab ?? 'main';
    if (context.activeTab === 'supports' && !context.showSupports) context.activeTab = 'main';
    context.tabMain = context.activeTab === 'main';
    context.tabFeatures = context.activeTab === 'features';
    context.tabSupports = context.activeTab === 'supports';
    context.tabNotes = context.activeTab === 'notes';
    if (context.showSupports) {
      await affinityTableReady();
      Object.assign(context, buildSupportContext(this.document, currentAffinityTable()));
    }
    context.showGrowths = Boolean(this._showGrowths);
    context.systemPath = `systems/${SYSTEM_ID}`;
    const portraitType = ['Lord', 'Retainer', 'Boss'].includes(this.document.system.faction.role)
      ? this.document.system.faction.role.toLowerCase()
      : 'npc';
    context.portrait = {
      maskClass: `emblem-character__portrait-mask--${portraitType}`,
      border: `${context.systemPath}/assets/ui/${portraitType}-border.png`
    };
    context.linkedConvoyUuid = linkedConvoyUuid(this.document);
    context.linkedJournals = linkedJournalViews(this.document);
    await recipeLibraryReady();
    context.knownRecipes = knownRecipeViews(this.document);
    context.knownSongs = await knownSongViews(this.document);
    context.hasNotesLinks = context.linkedJournals.length > 0 || context.knownRecipes.length > 0
      || context.knownSongs.length > 0;
    this._prepareUnitContext(context);
    this._prepareGearContext(context);
    return context;
  }

  /**
   * The unit itself: its types, its stats, its skills and its proficiencies.
   * @param {object} context   The render context, extended in place.
   */
  _prepareUnitContext(context) {
    const system = this.document.system;
    context.unitTypes = UNIT_TYPES.map(unit => {
      const active = system.unitType[unit.key] === true;
      const innate = system.innateUnitType[unit.key] === true;
      return {
        ...unit,
        active,
        image: `${context.systemPath}/assets/ui/unit-types/${unit.key}-flat.png`,
        tooltip: getTooltip(TOOLTIP_IDS.TOGGLE_UNIT_TYPE, { ...unit, active, innate })
      };
    });
    const classItem = this.document.items.find(item => item.type === 'Class') ?? null;
    const zenith = zenithStats({
      stats: system.stats, caps: system.caps, growthKeys: GROWTH_KEYS,
      unplayable: classItem?.system.tier === 'Unplayable'
    });
    context.stats = CORE_STATS.map(stat => {
      const node = system.stats[stat.key];
      const growthNode = stat.growth ? system.growth[stat.growth] : null;
      const growthRate = Number(growthNode?.total) || 0;
      const penalty = stat.key === 'stn' || stat.key === 'bld' ? 0 : statPenalty(node);
      return {
        ...stat,
        node,
        growthNode,
        growthRate,
        growthColor: growthColor(growthRate),
        zenith: Boolean(stat.growth && zenith[stat.growth]),
        penalty,
        penaltyTooltip: penalty ? getTooltip(TOOLTIP_IDS.STAT_PENALTY, stat) : '',
        dividerAfter: stat.key === 'bld'
      };
    });
    const build = Number(system.stats.bld.total) || 0;
    context.combatStats = COMBAT_STATS.filter(stat => !UNLISTED_COMBAT_STATS.has(stat.key)).map(stat => ({
      ...stat,
      node: system.stats[stat.key],
      overweight: stat.key === 'wgt' && (Number(system.stats.wgt.total) || 0) > build
    }));
    context.skills = SKILLS.map(skill => {
      const node = system.skills[skill.key];
      const rank = Number(node.total) || 0;
      const rankLabel = skillRankLabel(rank);
      return {
        ...skill,
        rank,
        rankLabel,
        xp: Number(node.xp) || 0,
        xpMax: Number(node.xpMax) || 0,
        active: rank > 0,
        mastery: rank === 4,
        image: `${context.systemPath}/assets/ui/skills/${skill.key}${rank ? '' : '-off'}.png`,
        tooltip: getTooltip(TOOLTIP_IDS.SKILL, { label: skill.label, rankLabel })
      };
    });
    context.proficiencies = PROFICIENCIES.map(proficiency => {
      const node = system.prof[proficiency.key];
      const rank = Number(node.total) || 0;
      const tier = proficiencyTier(proficiency, rank);
      return {
        ...proficiency,
        rank,
        xp: Number(node.xp) || 0,
        xpMax: tier ? 0 : Number(node.xpMax) || 0,
        misc: Boolean(proficiency.misc),
        icon: `${context.systemPath}/assets/ui/proficiencies/${tier?.[0] ?? `${proficiency.icon}${rank ? '' : '-off'}`}.png`,
        rankIcon: `${context.systemPath}/assets/ui/proficiencies/${rank ? `rank${rank}` : 'norank'}.png`,
        tooltip: getTooltip(TOOLTIP_IDS.PROFICIENCY, { label: tier?.[1] ?? proficiency.label })
      };
    });
  }

  /**
   * What the unit carries and spends: its class, features, inventory tabs and special pools.
   * @param {object} context   The render context, extended in place.
   */
  _prepareGearContext(context) {
    context.classItem = context.items.find(item => item.type === 'Class') ?? null;
    context.featureItems = context.items.filter(item => item.type === 'Ability' && item.itemType === 'Passive');
    const inventory = buildCharacterInventory(this.document.items, {
      sortBy: this._inventorySortBy ?? 'type',
      sortDir: this._inventorySortDir ?? 'asc',
      equipmentSlots: this.document.system.equipment.slots
    });
    this._inventorySortBy = inventory.sortBy;
    this._inventorySortDir = inventory.sortDir;
    const inventoryTabs = buildInventoryTabs(inventory);
    if (!inventoryTabs.some(tab => tab.key === this._activeInventoryTab)) this._activeInventoryTab = 'equipment';
    const activeInventory = inventoryTabs.find(tab => tab.key === this._activeInventoryTab) ?? inventoryTabs[0];
    context.inventoryTabs = inventoryTabs.map(tab => ({
      ...tab,
      active: tab.key === activeInventory.key,
      tooltip: getTooltip(TOOLTIP_IDS.INVENTORY_TAB, tab)
    }));
    context.inventoryTable = {
      key: activeInventory.key,
      title: activeInventory.title,
      items: activeInventory.items.map(item => characterItemView(item, context.exposesLoot))
    };
    context.inventorySort = {
      label: inventory.sortByLabel,
      direction: inventory.sortDir,
      directionTooltip: getTooltip(TOOLTIP_IDS.SORT_DIRECTION, { direction: inventory.sortDir }),
      directionIcon: inventory.sortDir === 'asc' ? 'fa-arrow-up-short-wide' : 'fa-arrow-down-wide-short'
    };
    const extraLives = this.document.system.special.extraLives;
    context.extraLives = {
      value: Number(extraLives.value) || 0,
      max: Number(extraLives.max) || 0,
      hearts: Array.from({ length: Number(extraLives.max) || 0 }, (_, index) => ({
        index,
        active: index < (Number(extraLives.value) || 0),
        tooltip: getTooltip(TOOLTIP_IDS.EXTRA_LIFE, { index })
      })),
      increaseTooltip: getTooltip(TOOLTIP_IDS.ADJUST_SPECIAL_MAX, { delta: 1, label: 'extra lives' }),
      decreaseTooltip: getTooltip(TOOLTIP_IDS.ADJUST_SPECIAL_MAX, { delta: -1, label: 'extra lives' })
    };
    context.specialResources = [
      { key: 'extraActions', label: 'Extra Actions' },
      { key: 'dexterity', label: 'Dexterity' },
      { key: 'willpower', label: 'Willpower' }
    ].map(resource => ({
      ...resource,
      node: this.document.system.special[resource.key],
      increaseTooltip: getTooltip(TOOLTIP_IDS.ADJUST_SPECIAL_MAX, { delta: 1, label: resource.label.toLowerCase() }),
      decreaseTooltip: getTooltip(TOOLTIP_IDS.ADJUST_SPECIAL_MAX, { delta: -1, label: resource.label.toLowerCase() })
    }));
    context.tooltips = {
      editPortrait: getTooltip(TOOLTIP_IDS.OPEN_ACTOR_CONTROL),
      openItem: getTooltip(TOOLTIP_IDS.OPEN_ITEM),
      removePassive: getTooltip(TOOLTIP_IDS.REMOVE_PASSIVE),
      restoreAction: getTooltip(TOOLTIP_IDS.RESTORE_STANDARD_ACTION),
      spendAction: getTooltip(TOOLTIP_IDS.SPEND_STANDARD_ACTION),
      spentAction: getTooltip(TOOLTIP_IDS.STANDARD_ACTION_SPENT),
      toggleInventorySort: getTooltip(TOOLTIP_IDS.TOGGLE_INVENTORY_SORT),
      openLinkedConvoy: getTooltip(TOOLTIP_IDS.OPEN_LINKED_CONVOY),
      addSupport: getTooltip(TOOLTIP_IDS.ADD_SUPPORT),
      removeSupport: getTooltip(TOOLTIP_IDS.REMOVE_SUPPORT),
      openJournal: getTooltip(TOOLTIP_IDS.OPEN_JOURNAL),
      unlinkJournal: getTooltip(TOOLTIP_IDS.UNLINK_JOURNAL),
      unlinkRecipe: getTooltip(TOOLTIP_IDS.UNLINK_RECIPE),
      unlinkSong: getTooltip(TOOLTIP_IDS.UNLINK_SONG)
    };
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    this._wireRightClickEditors(context);
    for (const input of this.element.querySelectorAll('.special-resource-remaining[data-resource]')) {
      input.addEventListener('change', async event => {
        if (!this.isEditable) return;
        const key = event.currentTarget.dataset.resource;
        const node = this.document.system.special[key];
        if (!node) return;
        const value = Math.max(0, Math.min(Number(node.max) || 0, Math.floor(Number(event.currentTarget.value) || 0)));
        await this.document.update({ [`system.special.${key}.value`]: value });
      });
    }
    for (const label of this.element.querySelectorAll('.fit-text')) {
      const length = label.textContent.length;
      label.style.fontSize = length > 20 ? '10px' : length > 15 ? '11px' : '12px';
    }
    this._wireItemDrags();
    this._wireSupportTab();
    showGrowthColumn(this.element, Boolean(this._showGrowths));
    queueMicrotask(() => stripPortraitListeners(this.element));
  }

  /**
   * The right-click editors on the unit types, skills, proficiencies, stats and experience bar, for whoever may edit
   * the unit: staff, or a Trusted Player who owns it.
   */
  _wireRightClickEditors(context) {
    for (const element of this.element.querySelectorAll('[data-unit-type]')) {
      element.addEventListener('contextmenu', async event => {
        event.preventDefault();
        if (!this.isEditable) return;
        const key = event.currentTarget.dataset.unitType;
        await this.document.update({ [`system.innateUnitType.${key}`]: !this.document.system.innateUnitType[key] });
      });
    }
    for (const element of this.element.querySelectorAll('[data-skill-editor]')) {
      element.addEventListener('contextmenu', async event => {
        event.preventDefault();
        if (!this.isEditable) return;
        const skill = context.skills.find(entry => entry.key === event.currentTarget.dataset.skillEditor);
        if (skill) await editSkill(this.document, skill);
      });
    }
    for (const element of this.element.querySelectorAll('[data-proficiency-editor]')) {
      element.addEventListener('contextmenu', async event => {
        event.preventDefault();
        if (!this.isEditable) return;
        const key = event.currentTarget.dataset.proficiencyEditor;
        const proficiency = context.proficiencies.find(entry => entry.key === key);
        if (proficiency && !proficiency.misc) await editProficiency(this.document, proficiency);
      });
    }
    for (const element of this.element.querySelectorAll('[data-stat-editor]')) {
      element.addEventListener('contextmenu', async event => {
        event.preventDefault();
        if (!this.isEditable) return;
        const stat = context.stats.find(entry => entry.key === event.currentTarget.dataset.statEditor);
        if (stat) await editCharacterStat(this.document, stat);
      });
    }
    this.element.querySelector('.actor-xp-bar')?.addEventListener('contextmenu', async event => {
      event.preventDefault();
      if (this.isEditable) await editLevelExperience(this.document);
    });
  }

  /** Make inventory and passive-feature images draggable when the item can go somewhere, with a tooltip for where. */
  _wireItemDrags() {
    for (const row of this.element.querySelectorAll(DRAGGABLE_ITEM_ROWS)) {
      const item = this.document.items.get(row.dataset.itemId);
      const capabilities = item ? characterDragCapabilities(item) : null;
      const image = row.querySelector('img');
      if (!image) continue;
      if (!capabilities) {
        image.draggable = false;
        continue;
      }
      if (image.hasAttribute('data-draggable-setup')) continue;
      image.draggable = true;
      image.addEventListener('dragstart', event => this._onDragStart(event));
      image.style.cursor = 'var(--cursor-grab)';
      image.dataset.tooltip = getTooltip(TOOLTIP_IDS.DRAG_ITEM, { name: item.name, destination: capabilities.destination });
      image.setAttribute('data-draggable-setup', 'true');
    }
  }

  /** The supports tab: portrait trimming, the live affinity readout and the bond editors. */
  _wireSupportTab() {
    trimContainerSprites(this.element.querySelector('.support-card-grid'));
    const affinitySelect = this.element.querySelector('select[name="system.support.affinity"]');
    affinitySelect?.addEventListener('change', event => {
      const readout = this.element.querySelector('.support-affinity-stats');
      const option = event.currentTarget.selectedOptions?.[0];
      if (readout) readout.innerHTML = option?.dataset?.stats ?? '';
    });
    for (const card of this.element.querySelectorAll('.support-card[data-support-index]')) {
      card.addEventListener('contextmenu', async event => {
        event.preventDefault();
        if (this.isEditable) await openSupportEditorDialog(this.document, Number(card.dataset.supportIndex));
      });
    }
  }

  /* -------------------------------------------- */
  /*  Drag and drop                               */
  /* -------------------------------------------- */
  /** Cancel the drag of an item that can go nowhere. Otherwise the payload says where it may land. */
  _onDragStart(event) {
    const itemId = event.currentTarget?.closest?.('[data-item-id]')?.dataset?.itemId;
    const item = this.document.items.get(itemId);
    const capabilities = item ? characterDragCapabilities(item) : null;
    if (!item || !capabilities) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    const payload = JSON.stringify(this._dragPayload(item));
    event.dataTransfer.setData('text/plain', payload);
    event.dataTransfer.setData('application/json', payload);
  }

  _dragPayloadExtras(item) {
    const capabilities = characterDragCapabilities(item)
      ?? { canDragToHotbar: false, canDragToActor: false, copies: false };
    return {
      emblemType: 'EmblemItem',
      canDragToHotbar: capabilities.canDragToHotbar,
      canDragToActor: capabilities.canDragToActor,
      copies: capabilities.copies
    };
  }

  async _onDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const payload = readDropPayload(event) ?? {};
    if (payload.type === 'Item') return this._onDropItem(event, await resolveDroppedItem(payload), payload);
    if (payload.type === CONVOY_GOLD_DRAG_TYPE) return this._onDropConvoyGold(event, payload);
    if (isJournalDrop(payload)) return this._onDropJournal(event, payload);
    if (payload.type === RECIPE_DRAG_TYPE) return this._onDropRecipe(event, payload);
    if (payload.type === SONG_DRAG_TYPE) return this._onDropSong(event, payload);
    if (payload.type === 'Actor' && event.target?.closest?.('[data-tab="supports"]')) {
      return this.addSupportPartner(payload.uuid);
    }
    return super._onDrop(event);
  }

  /**
   * Transfer another owned Actor’s Item or a linked Convoy Item through the inventory command.
   * Copying a world or compendium Item requires document-authoring permission.
   */
  async _onDropItem(event, item, payload = {}) {
    if (!item) return;
    const sourceActor = item.parent?.documentName === 'Actor'
      ? item.parent
      : payload.actorId ? game.actors.get(payload.actorId) : null;
    if (sourceActor?.uuid === this.document.uuid) return;
    if (sourceActor ? !this.canPlay : !this.isEditable) return;
    if (sourceActor && !sourceActor.isOwner && !game.user.isGM && sourceActor.uuid !== linkedConvoyUuid(this.document)) {
      return notifications.show(NOTIFICATION_IDS.INVENTORY_WARNING, { message: `You do not own ${sourceActor.name}.` });
    }
    if (sourceActor && !characterActorItemDropAllowed(inventoryRuleItem(item))) {
      return notifications.show(NOTIFICATION_IDS.INVENTORY_WARNING, {
        message: `${item.name} cannot be transferred between actors.`
      });
    }

    const admission = characterItemAdmission({
      items: this.document.items.map(inventoryRuleItem),
      equipmentSlots: this.document.system.equipment.slots
    }, inventoryRuleItem(item));
    if (!admission.ok) return notifications.show(NOTIFICATION_IDS.INVENTORY_WARNING, {
      message: inventoryRefusalMessage(admission, item)
    });

    const dropKey = `${sourceActor?.uuid ?? item.uuid}-${item.id ?? item.uuid}-${this.document.uuid}`;
    this.constructor._activeInventoryDrops ??= new Set();
    if (this.constructor._activeInventoryDrops.has(dropKey)) return;
    this.constructor._activeInventoryDrops.add(dropKey);
    const release = setTimeout(() => this.constructor._activeInventoryDrops.delete(dropKey), DROP_LOCK_TTL);
    release?.unref?.();
    try {
      await this._receiveInventoryItem(item, sourceActor);
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'Emblem RPG | Character inventory drop failed');
    }
  }

  async _receiveInventoryItem(item, sourceActor) {
    if (sourceActor) {
      let amount = null;
      if (item.type === 'Resource') {
        const available = Math.max(1, Number(item.system?.amount) || 1);
        amount = await openResourceAmountDialog(item.name, available);
        if (!amount) return;
      }
      return game.emblemRpg.api.character.inventory.transfer({
        sourceActorUuid: sourceActor.uuid,
        targetActorUuid: this.document.uuid,
        itemId: item.id,
        amount
      });
    }
    if (item.type === 'Resource') {
      const amount = await openResourceAmountDialog(item.name);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const match = matchingResourceStack(this.document.items.map(inventoryRuleItem), inventoryRuleItem(item));
      const existing = match ? this.document.items.get(match.id) : null;
      const previous = Number(existing?.system?.amount) || 0;
      if (existing) await existing.update({ 'system.amount': previous + amount });
      if (!existing) {
        const data = inventoryCreationData(item);
        data.system.amount = amount;
        await this.document.createEmbeddedDocuments('Item', [data]);
      }
      return;
    }

    await this.document.createEmbeddedDocuments('Item', [inventoryCreationData(item)]);
  }
}

/* -------------------------------------------- */
/*  Mount action                                */
/* -------------------------------------------- */
/** Validate Token, turn, action and uses before sending a player’s Mount use through item activation. */
async function activateMountAsAction(actor, item) {
  const warn = message => notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_WARNING, { message });
  const tokens = actor.getActiveTokens();
  const controlled = tokens.find(token => token.controlled) ?? tokens[0] ?? null;
  if (!controlled) return warn(`Select ${actor.name}'s token to activate ${item.name}.`);
  const turn = actor.system.turn;
  if (turn.actionAvailable === false && turn.bonusActionAvailable === false) return warn(`${actor.name}'s turn is over.`);
  if (turn.actionAvailable === false) return warn(`${actor.name} has no Action remaining.`);
  const uses = item.system.uses ?? {};
  if (uses.type !== 'infinite' && (Number(uses.current) || 0) < 1) return warn(`${item.name} is depleted.`);
  return activateHotbarItem(item.uuid);
}

/* -------------------------------------------- */
/*  Journal links                               */
/* -------------------------------------------- */
/** The raw uuids a unit has linked, unresolved. */
export function linkedJournalUuids(actor) {
  return actor.system.knowledge.journals.filter(Boolean);
}

/** The unit's linked journals, resolved for the Notes tab. A deleted journal is left out. */
export function linkedJournalViews(actor, user = game.user) {
  return linkedJournalUuids(actor).map(uuid => {
    const document = resolveDocumentSync(uuid);
    if (!document) return null;
    const isPage = document.documentName === 'JournalEntryPage';
    return {
      uuid,
      name: isPage ? `${document.parent?.name ?? ''}: ${document.name}` : document.name,
      icon: isPage ? 'fas fa-file-lines' : 'fas fa-book',
      visible: document.testUserPermission?.(user, 'OBSERVER') ?? true
    };
  }).filter(Boolean);
}

/**
 * Link a journal entry or page to a unit. This only records the link. The sheet's _onDropJournal then sends the
 * grantJournalAccess command so the unit's owners can read it.
 */
export async function linkJournalToActor(actor, uuid) {
  const document = await fromUuid(String(uuid ?? '')).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'document'); return null; });
  if (!actor || !document || !JOURNAL_DROP_TYPES.has(document.documentName)) {
    return { ok: false, reason: 'That is not a journal entry.' };
  }
  const ids = linkedJournalUuids(actor);
  if (ids.includes(uuid)) return { ok: false, reason: `${document.name} is already linked to ${actor.name}.` };
  await actor.update({ 'system.knowledge.journals': [...ids, uuid] });
  return { ok: true, name: document.name };
}

/** Remove a journal link. The read permission stays, since the owners may have been given the entry another way. */
export async function unlinkJournalFromActor(actor, uuid) {
  const ids = linkedJournalUuids(actor);
  if (!ids.includes(uuid)) return false;
  await actor.update({ 'system.knowledge.journals': ids.filter(id => id !== uuid) });
  return true;
}

/** Open a linked journal, jumping to the page when the link names one and falling back to its book. */
export async function openLinkedJournal(uuid) {
  const document = await fromUuid(String(uuid ?? '')).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'document'); return null; });
  if (!document) return notifications.show(NOTIFICATION_IDS.JOURNAL_NOT_FOUND);
  if (document.documentName === 'JournalEntryPage') {
    try {
      await document.parent.sheet.render(true, { pageId: document.id });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'openLinkedJournal');
      document.parent.sheet.render(true);
    }
    return;
  }
  document.sheet.render(true);
}

/* -------------------------------------------- */
/*  Support presentation                        */
/* -------------------------------------------- */
function supportPartnerList(actor) {
  return actor.system.support.partners.map(entry => ({ ...entry }));
}

function buildSupportContext(actor, table) {
  const affinity = String(actor.system.support.affinity ?? '');
  const names = affinityNames(table);
  const options = affinity && !names.includes(affinity) ? [...names, affinity] : names;
  return {
    supportAffinity: affinity,
    affinityOptions: options.map(name => ({
      name, label: affinityLabel(table, name), selected: name === affinity,
      stats: affinityChipsHtml(affinityDirections(table, name))
    })),
    supportAffinityChips: affinityDirections(table, affinity),
    supportCards: actor.system.support.partners
      .map((entry, index) => supportCardView(entry, index, table))
  };
}

/** The affinity readout as markup, so the select can swap it in without a re-render. */
function affinityChipsHtml(chips) {
  return chips.map(chip =>
    `<span class="affinity-stat ${chip.penalty ? 'is-down' : 'is-up'}">${escapeHtml(chip.label)}</span>`
  ).join('');
}

/** A partner card shows the partner's affinity, because a Rally's bonuses come from the partner's affinity. */
function supportCardView(entry, index, table) {
  const partner = resolveSupportPartner(entry.actorUUID);
  const rank = clampSupportRank(entry.rank);
  const partnerAffinity = String(partner?.system?.support?.affinity ?? '');
  const bonuses = rank < 0 ? null : rallyStatBonuses(table, partnerAffinity, rank);
  const name = partner?.name || entry.name || 'Unknown';
  const xp = Math.max(0, Number(entry.xp) || 0);
  const xpNeeded = supportXpNeeded(rank);
  const rankLetter = supportRankLetter(rank);
  const rawImg = partner?.img || 'icons/svg/mystery-man.svg';
  return {
    index,
    name,
    rawImg,
    img: cachedTrimmedImage(rawImg) ?? rawImg,
    factionColor: partner?.system?.faction?.color || '#808080',
    avatarScale: avatarScaleFor(partner),
    rankLetter,
    rankImage: rank < 0 ? '' : `systems/${SYSTEM_ID}/assets/ui/proficiencies/rank${rank + 1}.png`,
    xp,
    xpNeeded,
    affinity: partnerAffinity || '--',
    affinityTooltip: bonuses ? rallyStatLine(table, bonuses) : affinitySummary(table, partnerAffinity),
    tooltip: getTooltip(TOOLTIP_IDS.SUPPORT_CARD, { name, rankLetter, xp, xpNeeded })
  };
}

/** The clamped portrait zoom one actor asked for. */
function avatarScaleFor(actor) {
  return resolveAvatarScale(actor?.system?.art?.avatarScale);
}

function resolveSupportPartner(uuid) {
  return resolveDocumentSync(uuid);
}

function resolveDocumentSync(uuid) {
  try { return fromUuidSync(String(uuid ?? '')) ?? null; } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'resolveDocumentSync', /^fromUuidSync was invoked on UUID .*cannot be retrieved synchronously\.$/.test(String(diagnosticError?.message ?? '')));
    return null;
  }
}

/* -------------------------------------------- */
/*  Stat column                                 */
/* -------------------------------------------- */
function growthColor(value) {
  if (value < 25) return '#c22a2a';
  if (value < 40) return '#eac71e';
  if (value < 60) return '#8ec169';
  return '#00dc0b';
}

/** Show either the stat values or the growth rates in the stat column. Only the DOM changes, not the unit. */
function showGrowthColumn(root, showGrowths) {
  for (const element of root.querySelectorAll('.growthfield')) element.style.display = showGrowths ? 'inline' : 'none';
  for (const element of root.querySelectorAll('.corestat')) element.style.display = showGrowths ? 'none' : '';
  for (const element of root.querySelectorAll('.penaltyStat')) element.style.display = showGrowths ? 'none' : '';
  root.querySelector('.label-show-growths')?.classList.toggle('is-active', showGrowths);
}

/** Replace the portrait with a clone, which drops the listeners another module bound to it. */
function stripPortraitListeners(root) {
  for (const element of root?.querySelectorAll?.('.profile-img') ?? []) {
    element.replaceWith(element.cloneNode(true));
  }
}

/** The `[icon, label]` an armor or riding tier shows, or null for a proficiency that ranks by XP. */
function proficiencyTier(proficiency, rank) {
  const tiers = PROFICIENCY_TIERS[proficiency.key];
  return tiers ? tiers[rank] ?? tiers[0] : null;
}

/**
 * The Convoy of the unit's party, which is the party of its first player owner who is in one (projectActorPartyId).
 * Null when the unit has no party or the party has no Convoy.
 */
function linkedConvoyUuid(actor) {
  const partyId = projectActorPartyId(actor);
  if (!partyId) return null;
  const party = readPartyState().parties.find(entry => entry.id === partyId);
  const convoy = party?.convoyUuid ? resolveDocumentSync(party.convoyUuid) : null;
  return convoy ? String(convoy.uuid) : null;
}

/* -------------------------------------------- */
/*  Inventory views                             */
/* -------------------------------------------- */
function characterItemView(item, exposesLoot = false) {
  const system = item.system;
  const stateField = equipmentStateField(inventoryRuleItem(item));
  const maximum = Number(system.uses?.max) || 0;
  const current = Number(system.uses?.current) || 0;
  const infinite = system.uses?.type === 'infinite';
  const resource = item.type === 'Resource';
  const uses = resource ? `×${Number(system.amount) || 0}` : infinite ? '∞' : maximum > 0 ? `${current}/${maximum}` : '';
  const itemType = resource ? 'Resource' : system.itemType || item.type;
  const innate = isInnateCharacterItem(item);
  const droppable = isDroppableItem({ type: item.type, innate });
  return {
    id: item.id ?? item._id,
    name: item.name,
    img: item.img,
    type: item.type,
    itemType,
    uses,
    usesLow: !resource && !infinite && maximum > 5 && current <= maximum / 3,
    usesInfinite: !resource && infinite,
    stealableFlag: exposesLoot ? system.stealable?.flag ?? 'None' : 'None',
    weaponArt: item.type === 'Ability' && itemType === 'Weapon Art',
    weaponArtCost: Number(system.wepArtData?.cost) || 0,
    innate,
    droppable,
    draggable: characterDragCapabilities(item) !== null,
    removeIcon: droppable ? 'fa-hand' : 'fa-times',
    removeTooltip: innate
      ? getTooltip(TOOLTIP_IDS.INNATE_ITEM)
      : droppable ? getTooltip(TOOLTIP_IDS.DROP_ITEM) : getTooltip(TOOLTIP_IDS.DELETE_ITEM, { type: item.type }),
    toggle: characterEquipmentToggleView(item, itemType, stateField)
  };
}

function characterEquipmentToggleView(item, itemType, stateField) {
  if (!stateField) return null;
  const active = item.system[stateField] === true;
  if (item.type === 'Ability' && itemType === 'Mount') return {
    field: stateField,
    active,
    mount: true,
    className: `mount-toggle${active ? ' mounted' : ''}`,
    image: active ? 'armor-equipped.png' : 'armor-equipped-off.png',
    label: active ? 'Dismount' : 'Mount'
  };
  if (stateField === 'isWielded') {
    const classPrefix = item.type === 'Spell' && itemType === 'Attack' ? 'spell' : 'wield';
    return {
      field: stateField,
      active,
      mount: false,
      className: `equip-toggle ${classPrefix}${active ? '-equipped' : ''}`,
      image: active ? 'wield.png' : 'wield-off.png',
      label: classPrefix === 'spell' ? 'Equip' : 'Wield'
    };
  }
  if (stateField === 'isWorn') return {
    field: stateField,
    active,
    mount: false,
    className: `equip-toggle armor${active ? '-equipped' : ''}`,
    image: active ? 'armor-equipped.png' : 'armor-equipped-off.png',
    label: 'Wear'
  };
  return {
    field: stateField,
    active,
    mount: false,
    className: `equip-toggle accessory${active ? '-equipped' : ''}`,
    image: active ? 'item-equipped.png' : 'item-equipped-off.png',
    label: 'Equip'
  };
}

/**
 * The tab strip above the inventory table: equipment, spells and abilities each run over as many five-row pages as
 * they carry, so a slot grant that lifts equipment past the table's five rows opens a second Equipment tab rather
 * than spilling out of it. `_prepareGearContext` picks the active tab out of this list.
 */
export function buildInventoryTabs(inventory) {
  const tabs = [
    ...inventoryPageTabs(inventory.equipment, 'equipment', 'Equipment', 'equipment.png'),
    ...inventoryPageTabs(inventory.spells, 'spells', 'Spells', 'spells.png'),
    ...inventoryPageTabs(inventory.abilities, 'abilities', 'Abilities', 'abilities.png')
  ];
  tabs.push({ key: 'pockets', title: 'Pockets', icon: 'inventory.png', items: inventory.pockets });
  return tabs;
}

/**
 * One tab per page of a paginated section. The first page keeps the bare key, so an active tab held across renders
 * still resolves, and the last page of the group carries the divider that separates it from the next section.
 */
function inventoryPageTabs(pages, key, title, icon) {
  const tabs = pages.map((items, index) => ({
    key: index ? `${key}${index + 1}` : key,
    title: index ? `${title} ${index + 1}` : title,
    icon, page: index ? index + 1 : null, items
  }));
  tabs.at(-1).dividerAfter = true;
  return tabs;
}

async function resolveDroppedItem(payload) {
  try {
    return await Item.implementation.fromDropData(payload);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Could not resolve Item drop data');
  }
  return payload.uuid ? fromUuid(payload.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'resolveDroppedItem'); return null; }) : null;
}

function inventoryCreationData(item) {
  const data = item.toObject();
  delete data._id;
  data.system ??= {};
  data.system.isWielded = false;
  data.system.isWorn = false;
  data.system.isEquipped = false;
  return data;
}

function inventoryRuleItem(item) {
  return {
    id: item?.id ?? item?._id ?? '',
    name: item?.name ?? '',
    type: item?.type ?? '',
    innateGrant: Boolean(item?.getFlag?.(SYSTEM_ID, 'innateGrant') ?? item?.innateGrant),
    /** Read-only: the vendor tags matchingResourceStack compares, so a tagged stack never merges with another. */
    flags: item?.flags ?? {},
    system: foundry.utils.deepClone(item?.system ?? {})
  };
}

function isInnateCharacterItem(item) {
  return inventoryRuleItem(item).innateGrant;
}

function buildCharacterInventoryView(items, { sortBy = 'type', sortDir = 'asc', equipmentSlots } = {}) {
  const carried = Array.from(items ?? []);
  const projections = carried.map(inventoryRuleItem);
  const direction = sortDir === 'desc' ? 'desc' : 'asc';
  const field = sortBy === 'name' ? 'name' : 'type';
  const section = key => sortInventorySection(
    carried.filter((item, index) => characterItemListing(projections[index]) === key), key, field, direction
  );
  return {
    equipment: paginateInventory(section('equipment')),
    pockets: section('pockets'),
    spells: paginateInventory(section('spells')),
    abilities: paginateInventory(section('abilities')),
    equipmentCount: characterEquipmentCount(projections),
    equipmentCapacity: characterEquipmentCapacity(equipmentSlots),
    pocketCount: characterPocketCount(projections),
    pocketCapacity: CHARACTER_INVENTORY_LIMITS.pockets,
    sortBy: field,
    sortDir: direction,
    sortByLabel: field === 'name' ? 'A-Z' : 'Type'
  };
}

function sortInventorySection(items, section, sortBy, sortDir) {
  const order = INVENTORY_SECTION_ORDER[section];
  const sorted = [...items].sort((left, right) => {
    if (sortBy === 'type') {
      const leftType = left.type === 'Resource' ? 'Resource' : left.system?.itemType || left.type;
      const rightType = right.type === 'Resource' ? 'Resource' : right.system?.itemType || right.type;
      const typeDelta = (order[leftType] ?? 99) - (order[rightType] ?? 99);
      if (typeDelta) return typeDelta;
    }
    return String(left.name ?? '').localeCompare(String(right.name ?? ''), undefined, { sensitivity: 'base' });
  });
  return sortDir === 'desc' ? sorted.reverse() : sorted;
}

function paginateInventory(items) {
  const pages = [];
  for (let index = 0; index < items.length; index += INVENTORY_PAGE_SIZE) {
    pages.push(items.slice(index, index + INVENTORY_PAGE_SIZE));
  }
  return pages.length ? pages : [[]];
}

function inventoryRefusalMessage(result, item) {
  const messages = {
    'inventory.item-type': `${item?.type || 'This item'} cannot be carried by a Character.`,
    'inventory.armor-full': 'Only one suit of armor may be carried.',
    'inventory.equipment-full': `Equipment is full (max ${result.limit}).`,
    'inventory.spells-full': `Spells are full (max ${result.limit}).`,
    'inventory.abilities-full': `Abilities are full (max ${result.limit}).`,
    'inventory.pockets-full': `Pockets are full (max ${result.limit}).`
  };
  return messages[result.code] ?? 'That inventory change is not allowed.';
}

/* -------------------------------------------- */
/*  Recipe links                                */
/* -------------------------------------------- */
/** The unit's Personal recipes for its Notes tab, each with its growths spelled out for the row's tooltip. */
function knownRecipeViews(actor) {
  return projectKnownRecipes(actor).map(recipe => ({
    id: recipe.id,
    img: recipe.img,
    name: recipe.name || 'Unnamed recipe',
    dc: recipe.dc,
    tooltip: getTooltip(TOOLTIP_IDS.OPEN_RECIPE, {
      growths: GROWTH_KEYS.filter(key => recipe.growths[key])
        .map(key => `${GROWTH_STAT_LABEL[key]} ${recipe.growths[key] > 0 ? '+' : ''}${recipe.growths[key]}`).join(', ')
    })
  }));
}

/** Teach a unit a Personal recipe. A Default recipe is refused, since everyone can already cook it. */
async function linkRecipeToActor(actor, recipeId) {
  const library = await game.emblemRpg.api.downtime.inspectRecipeLibrary();
  const recipe = library?.recipes?.find(entry => entry.id === recipeId) ?? null;
  if (!actor || !recipe) return { ok: false, reason: 'That recipe is no longer in the library.' };
  if (recipe.isDefault) return {
    ok: false, reason: `${recipe.name || 'That recipe'} is a Default recipe, so everyone can already cook it.`
  };
  const ids = projectKnownRecipeIds(actor);
  if (ids.includes(recipeId)) return { ok: false, reason: `${actor.name} already knows ${recipe.name || 'that recipe'}.` };
  await actor.update({ 'system.knowledge.recipes': [...ids, recipeId] });
  return { ok: true, name: recipe.name };
}

/** Remove a recipe link from a unit. */
async function unlinkRecipeFromActor(actor, recipeId) {
  const ids = projectKnownRecipeIds(actor);
  if (!ids.includes(recipeId)) return false;
  await actor.update({ 'system.knowledge.recipes': ids.filter(id => id !== recipeId) });
  return true;
}

/* -------------------------------------------- */
/*  Song links                                  */
/* -------------------------------------------- */
/** The song ids a unit has been taught, as the Song Library links them. */
function knownSongIds(actor) {
  return actor.system.knowledge.songs.filter(Boolean);
}

/** The unit's Personal songs for its Notes tab, named from the Song Library view, each with its bonuses spelled out. */
async function knownSongViews(actor) {
  const known = new Set(knownSongIds(actor));
  if (!known.size) return [];
  const library = await game.emblemRpg.api.downtime.inspectSongLibrary();
  return (library?.songs ?? []).filter(song => known.has(song.id)).map(song => ({
    id: song.id,
    img: song.img,
    name: song.name || 'Unnamed song',
    dc: song.dc,
    tooltip: getTooltip(TOOLTIP_IDS.OPEN_SONG, { bonuses: describeBonuses(song.bonuses) })
  }));
}

/** Teach a unit a Personal song. A Default song is refused, since every lead can already perform it. */
async function linkSongToActor(actor, songId) {
  const library = await game.emblemRpg.api.downtime.inspectSongLibrary();
  const song = library?.songs?.find(entry => entry.id === songId) ?? null;
  if (!actor || !song) return { ok: false, reason: 'That song is no longer in the library.' };
  if (song.isDefault) {
    return {
      ok: false, reason: `${song.name || 'That song'} is a Default song, so every lead can already perform it.`
    };
  }
  const ids = knownSongIds(actor);
  if (ids.includes(songId)) return { ok: false, reason: `${actor.name} already knows ${song.name || 'that song'}.` };
  await actor.update({ 'system.knowledge.songs': [...ids, songId] });
  return { ok: true, name: song.name };
}

/** Remove a song link from a unit. */
async function unlinkSongFromActor(actor, songId) {
  const ids = knownSongIds(actor);
  if (!ids.includes(songId)) return false;
  await actor.update({ 'system.knowledge.songs': ids.filter(id => id !== songId) });
  return true;
}
