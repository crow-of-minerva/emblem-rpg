/** @layer ui/apps/sheets/object */
import { SYSTEM_ID } from '../../../../contracts/protocol.mjs';
import { CONTAINER_ITEM_TYPES, LOCK_KEY_ITEM_TYPES, LOCKABLE_OBJECT_TYPES, TARGET_SHAPES } from '../../../../contracts/domains/objects.mjs';
import { objectSubtypeBracketed } from '../../../../game/objects/rules.mjs';
import { projectTargetingAreaPreview } from '../../../../game/targeting/attack-grid.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../../presentation/interface/notifications.mjs';
import { openEffectEditor } from '../item/editors/dialogs.mjs';
import { openAnimationEditorDialog } from '../item/editors/animations.mjs';
import { EmblemSheetMixin } from '../base.mjs';
import { RecipeLibraryApp } from '../../menus/recipe-library-app.mjs';
import { SongLibraryApp } from '../../menus/song-library-app.mjs';
import {
  DOWNTIME_STATION_TYPES, FACTION_RELATION_DC, FACTION_RELATIONS, FACTION_WEALTH, FACTION_WEALTH_CAP,
  REQUISITION_LIMITS, normalizeFaction
} from '../../../../contracts/domains/downtime.mjs';
import { projectStoredRecipeLibrary } from '../../../../foundry/adapters/projections/downtime.mjs';
import { recipeLibraryReady } from '../../../../foundry/adapters/services/json-files.mjs';
import { openSceneCropForArtState } from '../../../../external/studio/character-art.mjs';
import { FoundryDiagnostics , reportFoundryError } from '../../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Object sheet                                */
/* -------------------------------------------- */
const TARGET_DIRECTIONS = Object.freeze([
  { key: 'nw', label: 'Northwest', rotation: -45 },
  { key: 'n', label: 'North', rotation: 0 },
  { key: 'ne', label: 'Northeast', rotation: 45 },
  { key: 'w', label: 'West', rotation: -90 },
  { center: true },
  { key: 'e', label: 'East', rotation: 90 },
  { key: 'sw', label: 'Southwest', rotation: -135 },
  { key: 's', label: 'South', rotation: 180 },
  { key: 'se', label: 'Southeast', rotation: 135 }
]);
const OBJECT_ART_STATES = Object.freeze({
  Destructible: Object.freeze([
    { key: 'intact', label: 'Intact Token Src', field: 'img', placeholder: 'Token src while Integrity is above 0' },
    { key: 'destroyed', label: 'Destroyed Token Src', field: 'system.art.destroyedImagePath',
      placeholder: 'Swapped in when Integrity hits 0' }
  ]),
  Door: Object.freeze([
    { key: 'closed', label: 'Closed Token Src', field: 'img', placeholder: 'Token src while closed / locked' },
    { key: 'opened', label: 'Opened Token Src', field: 'system.art.altImagePath',
      placeholder: 'Swapped in when opened / unlocked' }
  ]),
  Chest: Object.freeze([
    { key: 'closed', label: 'Closed Token Src', field: 'img', placeholder: 'Token src while closed / locked' },
    { key: 'opened', label: 'Opened Token Src', field: 'system.art.altImagePath',
      placeholder: 'Swapped in when opened / unlocked' }
  ])
});

const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/*
 * Altar authoring is switched off: `objectSubtypeBracketed` marks the Altar subtype as not built yet, and the sheet
 * shows a notice in its place. These constants and the commented-out handlers below belong to the Altar fields.
 *
 * An altar can give as well as teach, so anything grantable is accepted as a boon.
 * const BOON_ITEM_TYPES = Object.freeze(['Equipment', 'Consumable', 'Miscellaneous', 'Spell', 'Ability']);
 *
 * The offering each esoteric tier opens at, in the order the sheet lists them.
 * const ALTAR_TIER_LABELS = Object.freeze([
 *   { key: 't2', label: 'Tier 2' }, { key: 't3', label: 'Tier 3' },
 *   { key: 't4', label: 'Tier 4' }, { key: 't5', label: 'Tier 5' }
 * ]);
 */

/** Where an Object keeps its effects. It differs from an Item's path, so the shared effect editor is told it. */
const OBJECT_EFFECTS_PATH = 'system.effects';

/** Where a Stationary keeps the factions its Requisition menu offers. */
const FACTIONS_PATH = 'system.requisition.factions';


/** The sheet for Object actors, registered in init/registrations.mjs. */
export class ObjectSheet extends EmblemSheetMixin(foundry.applications.sheets.ActorSheetV2) {
  /* -------------------------------------------- */
  /*  Sheet configuration                         */
  /* -------------------------------------------- */
  static DEFAULT_TAB = 'overview';

  static DEFAULT_OPTIONS = {
    classes: ['actor', 'object'],
    position: { width: 500, height: 'auto' },
    window: { title: 'Object', icon: 'fas fa-cube' },
    viewPermission: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
    actions: {
      addFaction: ObjectSheet.addFaction,
      deleteFaction: ObjectSheet.deleteFaction,
      clearFactionLock: ObjectSheet.clearFactionLock
    }
  };

  /** The tabs only choose which panel shows, so a read-only Object sheet keeps them for an observer. */
  static NAVIGATION_CONTROLS = ['.tab-button'];

  static PARTS = {
    main: { template: `systems/${SYSTEM_ID}/templates/sheets/object-sheet.hbs`, scrollable: [''] }
  };

  /* -------------------------------------------- */
  /*  Sheet context                               */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.actor = this.document;
    context.items = this.document.items;
    context.accentSlug = String(this.document.system.objectType || 'none').toLowerCase().replaceAll(' ', '-');
    context.pixelArt = this.document.getFlag(SYSTEM_ID, 'pixelArt') === true;
    const bust = context.pixelArt ? `?${this.document._stats?.modifiedTime ?? Date.now()}` : '';
    context.profileImg = `${this.document.img}${bust}`;
    await recipeLibraryReady();
    const library = projectStoredRecipeLibrary().recipes;
    context.recipeLibrary = {
      defaults: library.filter(recipe => recipe.isDefault).length,
      personal: library.filter(recipe => !recipe.isDefault).length
    };
    context.songLibrary = this.document.system.objectType === DOWNTIME_STATION_TYPES.PERFORMANCE
      ? await songLibraryCounts() : null;
    if (this.document.system.objectType === DOWNTIME_STATION_TYPES.REQUISITION) {
      Object.assign(context, stationaryContext(this.document));
    }
    context.featureBracketed = objectSubtypeBracketed(this.document.system.objectType);
    // context.altarTiers = ALTAR_TIER_LABELS.map(tier => ({
    //   ...tier, value: this.document.system.altar?.tierMins?.[tier.key] ?? ''
    // }));
    context.tokenParams = this._tokenParameters();
    context.tokenLink = {
      shown: this.document.system.isDropChest !== true,
      linked: this.document.isToken ? false : this.document.prototypeToken.actorLink
    };
    context.artStateRows = this._artStateRows(context.tokenParams.scale);
    context.perStateScale = Boolean(context.artStateRows);
    context.keyItem = await this._keyItem();
    if (this.document.system.objectType === 'Armament') {
      const armament = this.document.system.armament;
      const shape = TARGET_SHAPES.includes(armament.targetShape) ? armament.targetShape : 'Cross';
      context.targetAreaPad = TARGET_DIRECTIONS.map(direction => ({
        ...direction,
        on: direction.key ? armament.targetArea[direction.key] === true : false
      }));
      context.targetShapes = TARGET_SHAPES.map(name => ({ name, selected: name === shape }));
      context.targetAreaPreview = this._targetAreaPreview(armament.targetArea, armament.rng, shape);
    }
    return context;
  }

  _tokenParameters() {
    const token = this.document.isToken ? this.document.token : this.document.prototypeToken;
    const rawTint = token.texture.tint;
    let tint = '#ffffff';
    try {
      if (rawTint !== null && rawTint !== undefined) tint = foundry.utils.Color.from(rawTint).css;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, '_tokenParameters');
      tint = '#ffffff';
    }
    return {
      width: token.width ?? 1,
      height: token.height ?? 1,
      scale: Math.abs(token.texture.scaleX ?? 1),
      tint
    };
  }

  _artStateRows(prototypeScale) {
    const states = OBJECT_ART_STATES[this.document.system.objectType];
    if (!states) return null;
    const art = this.document.system.art;
    return states.map(state => ({
      ...state,
      src: foundry.utils.getProperty(this.document, state.field) ?? '',
      scale: art[state.key].scale ?? Math.min(3, Math.max(0.2, Number(prototypeScale) || 1)),
      tint: art[state.key].tint || '#ffffff',
      offsetX: art[state.key].offsetX ?? 0,
      offsetY: art[state.key].offsetY ?? 0
    }));
  }

  async _keyItem() {
    const uuid = this.document.system.key;
    if (!uuid) return null;
    try {
      const item = await fromUuid(uuid);
      return item ? { name: item.name, img: item.img } : null;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, '_keyItem');
      return null;
    }
  }

  _targetAreaPreview(area, rng, shape) {
    const { size, cells } = projectTargetingAreaPreview(area, rng, shape);
    return { size, cells: cells.map(state => `ta-${state}`) };
  }

  /* -------------------------------------------- */
  /*  Rendering and interaction                   */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    this.setPosition({ width: 500, height: 'auto' });

    for (const tab of this.element.querySelectorAll('.tab-button[data-tab]')) {
      tab.addEventListener('click', event => {
        this._activeTab = event.currentTarget.dataset.tab || 'overview';
        this.render(false);
      });
    }
    this.element.querySelector('.object-lock-toggle')?.addEventListener('click', async () => {
      if (!this.isEditable) return;
      await this.document.update({ 'system.locked': !this.document.system.locked });
    });
    this.element.querySelector('.object-key-clear')?.addEventListener('click', () => {
      if (this.isEditable) return this.document.update({ 'system.key': '' });
    });
    for (const input of this.element.querySelectorAll('.object-token-param')) {
      input.addEventListener('change', event => this._updateTokenParameter(event.currentTarget));
    }
    this.element.querySelector('.object-token-link')?.addEventListener('change', event => {
      void this._updateTokenLink(event.currentTarget.checked);
    });
    for (const input of this.element.querySelectorAll('.obj-src-input')) {
      input.addEventListener('click', event => this._pickArtState(event.currentTarget.dataset.srcTarget));
    }
    for (const input of this.element.querySelectorAll('.obj-src-scale')) {
      input.addEventListener('change', event => {
        const value = Number(event.currentTarget.value);
        event.currentTarget.value = String(Math.min(3, Math.max(0.2, Number.isFinite(value) ? value : 1)));
      });
    }
    for (const input of this.element.querySelectorAll('.obj-src-tint')) {
      input.addEventListener('change', event => {
        const key = event.currentTarget.dataset.tintTarget;
        if (!key || !this.isEditable || !OBJECT_ART_STATES[this.document.system.objectType]?.some(state => state.key === key)) return;
        this.document.update({ [`system.art.${key}.tint`]: event.currentTarget.value });
      });
    }
    for (const row of this.element.querySelectorAll('.object-item[data-item-id]')) {
      row.addEventListener('dragstart', event => this._startItemDrag(event, row.dataset.itemId));
    }
    for (const button of this.element.querySelectorAll('.open-item-btn')) {
      button.addEventListener('click', event => this._itemFromControl(event.currentTarget)?.sheet?.render(true));
    }
    for (const button of this.element.querySelectorAll('.delete-item-btn')) {
      button.addEventListener('click', event => this._deleteItem(event));
    }
    for (const button of this.element.querySelectorAll('.gather-item-delete')) {
      button.addEventListener('click', event => this._deleteGatherable(event.currentTarget.dataset.gatherIndex));
    }
    // for (const button of this.element.querySelectorAll('.boon-item-delete')) {
    //   button.addEventListener('click', event => this._deleteBoon(event.currentTarget.dataset.boonIndex));
    // }
    this.element.querySelector('.add-effect-btn')?.addEventListener('click', () => {
      void openEffectEditor(this.document, null, { effectsPath: OBJECT_EFFECTS_PATH });
    });
    for (const button of this.element.querySelectorAll('.eff-row-edit')) {
      button.addEventListener('click', event => {
        const index = Number(event.currentTarget.dataset.effectIndex);
        if (Number.isInteger(index)) {
          void openEffectEditor(this.document, index, { effectsPath: OBJECT_EFFECTS_PATH });
        }
      });
    }
    this.element.querySelector('.armament-anim-btn')?.addEventListener('click', () => {
      void openAnimationEditorDialog(this.document);
    });
    for (const button of this.element.querySelectorAll('.obj-src-cut-btn')) {
      const field = OBJECT_ART_STATES[this.document.system.objectType]
        ?.find(state => state.key === button.dataset.cutTarget)?.field;
      button.addEventListener('click', async () => {
        const outcome = await openSceneCropForArtState(this.document, button.dataset.cutTarget, field);
        if (!outcome.ok) notifications.show(NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_UNAVAILABLE);
      });
    }
    for (const button of this.element.querySelectorAll('.cooking-open-library')) {
      button.addEventListener('click', () => { RecipeLibraryApp.open(); });
    }
    for (const button of this.element.querySelectorAll('.instrument-open-library')) {
      button.addEventListener('click', () => { SongLibraryApp.open(); });
    }
  }

  /**
   * Mark sheet saves with emblemSheetEdit, so an Integrity value typed here swaps the Token art without the
   * destruction smoke (foundry/hooks/objects.mjs).
   */
  async _processSubmitData(event, form, submitData, options = {}) {
    return super._processSubmitData(event, form, submitData, { ...options, emblemSheetEdit: true });
  }

  /**
   * A Token actor writes its own Token. A world actor writes its prototype, which the Object hooks copy to its
   * placed Tokens (syncObjectTokenParameters).
   */
  async _updateTokenParameter(input) {
    if (!this.isEditable) return;
    const param = input.dataset.param;
    const token = this.document.isToken ? this.document.token : null;
    if (param === 'tint') {
      const tint = input.value || '#ffffff';
      return token ? token.update({ 'texture.tint': tint }) : this.document.update({ 'prototypeToken.texture.tint': tint });
    }
    const entered = Number(input.value);
    if (!Number.isFinite(entered)) return this.render(false);
    const value = param === 'scale' ? Math.min(3, Math.max(0.2, entered)) : Math.max(0.5, entered);
    input.value = String(value);
    const writes = param === 'scale'
      ? { 'texture.scaleX': value, 'texture.scaleY': value }
      : { [param]: value };
    if (token) return token.update(writes);
    return this.document.update(Object.fromEntries(Object.entries(writes)
      .map(([path, written]) => [`prototypeToken.${path}`, written])));
  }

  /**
   * A world actor links or unlinks its prototype, which every later placement copies. An unlinked placed Token's
   * sheet links that Token itself. The Token then shows the world actor, so the world actor's sheet takes over.
   */
  async _updateTokenLink(linked) {
    if (!this.isEditable) return;
    if (!this.document.isToken) return this.document.update({ 'prototypeToken.actorLink': linked });
    if (!linked) return;
    const token = this.document.token;
    await token.update({ actorLink: true });
    await this.close();
    token.actor?.sheet?.render(true);
  }

  async _pickArtState(key) {
    if (!this.isEditable || !key) return;
    const state = OBJECT_ART_STATES[this.document.system.objectType]?.find(entry => entry.key === key);
    if (!state) return;
    const current = foundry.utils.getProperty(this.document, state.field) || this.document.img || '';
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: 'image',
      current,
      callback: path => this.document.update({ [state.field]: path })
    });
    return picker.browse();
  }

  _startItemDrag(event, itemId) {
    const item = this.document.items.get(itemId);
    if (!item) return;
    event.dataTransfer.setData('text/plain', JSON.stringify({ type: 'Item', uuid: item.uuid }));
  }

  _itemFromControl(control) {
    const row = control.closest('[data-item-id]');
    return row ? this.document.items.get(row.dataset.itemId) : null;
  }

  async _deleteItem(event) {
    event.preventDefault();
    if (!this.isEditable) return;
    const item = this._itemFromControl(event.currentTarget);
    if (item) await this.document.deleteEmbeddedDocuments('Item', [item.id]);
  }

  // async _deleteBoon(index) {
  //   if (!this.isEditable) return;
  //   const boons = foundry.utils.deepClone(this.document.system.altar.boons ?? []);
  //   boons.splice(Number(index), 1);
  //   return this.document.update({ 'system.altar.boons': boons });
  // }

  async _deleteGatherable(index) {
    if (!this.isEditable) return;
    const items = foundry.utils.deepClone(this.document.system.gathering.items);
    items.splice(Number(index), 1);
    return this.document.update({ 'system.gathering.items': items });
  }

  /* -------------------------------------------- */
  /*  Stationary factions                         */
  /* -------------------------------------------- */
  /** Append a blank faction row. The Requisition menu offers it once it has a name and is enabled. */
  static async addFaction() {
    if (!this.isEditable) return null;
    const rows = await this._savedFactions();
    if (rows.length >= REQUISITION_LIMITS.maxFactions) return null;
    rows.push(normalizeFaction({}, foundry.utils.randomID()));
    return this.document.update({ [FACTIONS_PATH]: rows });
  }

  static async deleteFaction(_event, target) {
    if (!this.isEditable) return null;
    const id = target.closest('[data-faction-id]')?.dataset.factionId;
    const rows = await this._savedFactions();
    const kept = rows.filter(row => row._id !== id);
    if (kept.length === rows.length) return null;
    return this.document.update({ [FACTIONS_PATH]: kept });
  }

  /** A GM clears one row's Requisitioned marker by hand. Reset Downtime clears every row's. */
  static async clearFactionLock(_event, target) {
    if (!this.isEditable || !game.user.isGM) return null;
    const id = target.closest('[data-faction-id]')?.dataset.factionId;
    const rows = await this._savedFactions();
    const row = rows.find(entry => entry._id === id);
    if (!row?.requisitioned) return null;
    row.requisitioned = false;
    return this.document.update({ [FACTIONS_PATH]: rows });
  }

  /**
   * The faction rows a row button rewrites, read once the form's pending edits are saved. The buttons write the
   * whole array, so a name typed just before one was pressed would otherwise be lost to the older copy.
   */
  async _savedFactions() {
    await this.submit();
    return foundry.utils.deepClone(Array.from(this.document.system.requisition.factions));
  }

  /** A subtype that isn't built yet (objectSubtypeBracketed) can't be authored, so its sheet ignores every drop. */
  async _onDropItem(event, item) {
    if (!this.isEditable || !item) return null;
    if (objectSubtypeBracketed(this.document.system.objectType)) return null;
    if (event.target.closest('[data-drop-zone="key"]')) {
      if (!LOCKABLE_OBJECT_TYPES.includes(this.document.system.objectType)) return null;
      if (!LOCK_KEY_ITEM_TYPES.includes(item.type)) {
        notifications.show(NOTIFICATION_IDS.OBJECT_KEY_ITEM_TYPE);
        return null;
      }
      await this.document.update({ 'system.key': item.uuid });
      return null;
    }
    if (this.document.system.objectType === 'Door') return null;
    // if (this.document.system.objectType === 'Altar' && BOON_ITEM_TYPES.includes(item.type)) {
    //   const boons = foundry.utils.deepClone(this.document.system.altar.boons ?? []);
    //   if (!boons.some(entry => entry.uuid === item.uuid)) {
    //     boons.push({ uuid: item.uuid, name: item.name, img: item.img, percent: 5, tier: 1 });
    //     await this.document.update({ 'system.altar.boons': boons });
    //   }
    //   return null;
    // }
    if (this.document.system.objectType === 'Gathering Node' && item.type === 'Resource') {
      const items = foundry.utils.deepClone(this.document.system.gathering.items);
      if (!items.some(entry => entry.uuid === item.uuid)) {
        items.push({ uuid: item.uuid, name: item.name, img: item.img, total: 1, weight: 1, hidden: false });
        await this.document.update({ 'system.gathering.items': items });
      }
      return null;
    }
    if (!['Chest', 'Loot'].includes(this.document.system.objectType)) return null;
    if (!CONTAINER_ITEM_TYPES.includes(item.type)) {
      notifications.show(NOTIFICATION_IDS.OBJECT_CONTENT_ITEM_TYPE);
      return null;
    }
    const source = item.toObject();
    delete source._id;
    const [created] = await this.document.createEmbeddedDocuments('Item', [source]);
    return created ?? null;
  }
}

/**
 * The Factions section of a Stationary: its stored rows, and the relation and wealth choices labelled with the DC
 * base and the demand cap each sets, as the requisition rules in game/downtime/requisition.mjs price them.
 */
function stationaryContext(document) {
  const factions = Array.from(document.system.requisition.factions).map(row => ({
    id: row._id,
    name: row.name ?? '',
    relation: row.relation,
    wealth: row.wealth,
    enabled: row.enabled !== false,
    requisitioned: row.requisitioned === true
  }));
  return {
    stationaryFactions: factions,
    factionRelations: FACTION_RELATIONS.map(value => ({ value, label: `${value} (DC ${FACTION_RELATION_DC[value]})` })),
    factionWealth: FACTION_WEALTH.map(value => ({
      value, label: `${value} (${wealthCapLabel(FACTION_WEALTH_CAP[value])})`
    })),
    factionNameMax: REQUISITION_LIMITS.maxName,
    factionsFull: factions.length >= REQUISITION_LIMITS.maxFactions
  };
}

function wealthCapLabel(cap) {
  return cap === null || cap === undefined ? 'no cap' : `${Number(cap).toLocaleString('en-US')} GP`;
}

/** Count the Song Library's Default and Personal songs for an Instrument's Songs section. */
async function songLibraryCounts() {
  const view = await game.emblemRpg.api.downtime.inspectSongLibrary();
  const songs = view?.songs ?? [];
  return {
    defaults: songs.filter(song => song.isDefault).length,
    personal: songs.filter(song => !song.isDefault).length
  };
}
