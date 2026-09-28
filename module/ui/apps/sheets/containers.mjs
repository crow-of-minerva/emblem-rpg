/** @layer ui/apps/sheets */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { CONVOY_GOLD_DRAG_TYPE, CONVOY_INBOUND_FLAG } from '../../../contracts/domains/economy.mjs';
import { matchingResourceStack } from '../../../game/character/inventory.mjs';
import { isCoinpurseItem } from '../../../game/economy/coinpurse.mjs';
import { isInboundItem, partitionConvoyItems } from '../../../game/economy/inbound.mjs';
import { isContainerStockable } from '../../../game/economy/trade.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import { playMenuSound } from '../../../presentation/audio/service.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../presentation/interface/notifications.mjs';
import { openStudioForSlot } from '../../../external/studio/character-art.mjs';
import { readDropPayload, resolveItem } from '../../../foundry/adapters/services/host.mjs';
import { openMerchandiseSettings, openResourceAmountDialog } from '../../dialogs.mjs';
import { EmblemSheetMixin, showTabPanels } from './base.mjs';
import { FoundryDiagnostics , reportFoundryError } from '../../../foundry/adapters/services/diagnostics.mjs';

/**
 * While a drop is being stored, a repeat of the same drop is ignored. The lock is released when the store finishes,
 * or after this long if it is still running (for example, waiting on the Resource amount dialog).
 */
const DROP_DEDUPE_MS = 2000;
const TOKEN_CONFIG_ACTIONS = new Set(['configurePrototypeToken', 'configureToken']);
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Container category view                     */
/* -------------------------------------------- */
const WEAPON_TABS = Object.freeze({
  Brawling: 'brawling', Blade: 'blade', Polearm: 'polearm', Heavy: 'heavy', Bow: 'bow', Covert: 'covert'
});
const ITEM_CATEGORIES = Object.freeze([
  { key: 'all', label: 'All', noun: 'items', icon: 'all.png', weapon: false },
  { key: 'brawling', label: 'Brawling', noun: 'brawling weapons', icon: 'brawling.png', weapon: true },
  { key: 'blade', label: 'Blade', noun: 'blade weapons', icon: 'blade.png', weapon: true },
  { key: 'polearm', label: 'Polearm', noun: 'polearms', icon: 'polearm.png', weapon: true },
  { key: 'heavy', label: 'Heavy', noun: 'heavy weapons', icon: 'heavy.png', weapon: true },
  { key: 'bow', label: 'Bow', noun: 'bows', icon: 'bow.png', weapon: true },
  { key: 'covert', label: 'Covert', noun: 'covert weapons', icon: 'covert.png', weapon: true },
  { key: 'staves', label: 'Staves', noun: 'staves', icon: 'staves.png', weapon: false },
  { key: 'armor', label: 'Armor', noun: 'armor', icon: 'armor.png', weapon: false },
  { key: 'consumables', label: 'Consumables', noun: 'consumables', icon: 'consumable.png', weapon: false },
  { key: 'miscellaneous', label: 'Misc', noun: 'miscellaneous items', icon: 'misc.png', weapon: false }
]);

/**
 * Sort Items into the category tabs, each with its rows and count. Used by the Convoy and Vendor sheets and by the
 * vendor shop window (menus/vendor-app.mjs), which passes its own rows already sorted.
 */
export function buildContainerCategories(items, activeTab, mapItem = item => item, { sorted = true } = {}) {
  const buckets = Object.fromEntries(ITEM_CATEGORIES.map(category => [category.key, []]));
  for (const item of items) {
    const row = mapItem(item);
    buckets.all.push(row);
    buckets[categoryForItem(item)].push(row);
  }
  if (sorted) for (const rows of Object.values(buckets)) rows.sort((a, b) => a.name.localeCompare(b.name));
  return ITEM_CATEGORIES.map(category => ({
    ...category, items: buckets[category.key], count: buckets[category.key].length, active: category.key === activeTab
  }));
}

/* -------------------------------------------- */
/*  Container sheet                             */
/* -------------------------------------------- */
class ContainerActorSheet extends EmblemSheetMixin(foundry.applications.sheets.ActorSheetV2) {
  /* -------------------------------------------- */
  /*  Container configuration                     */
  /* -------------------------------------------- */
  static DEFAULT_TAB = 'all';
  static ACTIVE_DROPS = new Set();

  /**
   * The category tabs and the Convoy's Stored / Inbound switch only change the view, so a read-only container keeps
   * them for a party member or visitor.
   */
  static NAVIGATION_CONTROLS = ['.convoy-tab-button', '.vendor-tab-button', '.convoy-inbound-toggle'];

  /** A container's token is driven from the actor, so the token configuration controls are dropped. */
  _getHeaderControls() {
    return super._getHeaderControls().filter(control => !TOKEN_CONFIG_ACTIONS.has(control.action));
  }

  /* -------------------------------------------- */
  /*  Container context                           */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.actor = this.document;
    context.categoryList = buildContainerCategories(
      this._listedItems(),
      this.activeTab,
      item => this._itemView(item)
    );
    return context;
  }

  /** The Items the category list shows. The Convoy sheet narrows them to its current view. */
  _listedItems() {
    return this.document.items;
  }

  _itemView(item) {
    const data = item.toObject(false);
    const uses = item.system.uses ?? {};
    data.system.uses = {
      ...uses,
      current: Number(uses.current) || 0,
      max: Number(uses.max) || 0,
      type: uses.type ?? 'limited'
    };
    return data;
  }

  /* -------------------------------------------- */
  /*  Container interaction                       */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    const tabSelector = this.document.type === 'Convoy' ? '.convoy-tab-button' : '.vendor-tab-button';
    const paneSelector = this.document.type === 'Convoy' ? '.convoy-tab-content' : '.vendor-tab-content';
    for (const tab of this.element.querySelectorAll(tabSelector)) {
      tab.addEventListener('click', event => {
        const key = event.currentTarget.dataset.tab;
        if (!key || key === this.activeTab) return;
        this._activeTab = key;
        showTabPanels(this.element, key, { controls: tabSelector, panels: paneSelector, display: 'block' });
        if (this.document.type === 'Convoy') {
          const active = context.categoryList.find(category => category.key === key);
          this._updateTabSummary?.(key, active?.count ?? 0);
        }
      });
    }
    // An inbound row is neither dragged nor opened here. ConvoySheet opens it for staff.
    for (const row of this.element.querySelectorAll('[data-item-id]:not([data-inbound="true"])')) {
      row.addEventListener('dblclick', () => this.document.items.get(row.dataset.itemId)?.sheet?.render(true));
      row.addEventListener('dragstart', this._onDragStart.bind(this));
    }
    for (const button of this.element.querySelectorAll('.delete-item-btn')) {
      button.addEventListener('click', event => this._deleteItem(event));
    }
  }

  /* -------------------------------------------- */
  /*  Container drops                             */
  /* -------------------------------------------- */

  /** The container's wording, the notification ids its drops raise, and the command that moves an Actor's Item in. */
  get _containerVocabulary() {
    return this.document.type === 'Vendor' ? VENDOR_VOCABULARY : CONVOY_VOCABULARY;
  }

  /**
   * Resolve a dropped Item from the source it names before ActorSheetV2._onDropDocument can. Core's fromDropData
   * prefers the inline copy every drag payload from base.mjs carries and hands back a parentless Item, which hides
   * both the Actor a possession came from and a drop of this container's own Item back onto itself. A reader who
   * can't edit the container gets no further than an Item, which _canStore then limits to their own units' Items.
   */
  async _onDrop(event) {
    const payload = readDropPayload(event);
    if (payload?.type !== 'Item') return this.isEditable ? super._onDrop(event) : null;
    const item = await resolveItem(String(payload.uuid ?? '')) ?? await detachedDropItem(payload);
    return item ? this._onDropItem(event, item) : null;
  }

  /**
   * Store a dropped Item. An Item another Actor holds moves through the economy command, a loose Item is copied in
   * unequipped, and a Resource asks for an amount first. Dropping the container's own Item back on it does nothing.
   */
  async _onDropItem(event, item) {
    if (!item || item.parent?.uuid === this.document.uuid || !this._canStore(item)) return null;
    const dropKey = `${this.document.type}-drop-${item.uuid ?? item.id}-${this.document.id}`;
    const locks = this.constructor.ACTIVE_DROPS;
    if (locks.has(dropKey)) return null;
    locks.add(dropKey);
    const release = setTimeout(() => locks.delete(dropKey), DROP_DEDUPE_MS);
    try {
      return await this._storeDroppedItem(item);
    } finally {
      clearTimeout(release);
      locks.delete(dropKey);
    }
  }

  async _storeDroppedItem(item) {
    const words = this._containerVocabulary;
    const facts = itemFacts(item);
    const fromActor = item.parent?.documentName === 'Actor';
    if (!isContainerStockable(facts) || (this.document.type === 'Vendor' && isCoinpurseItem(facts))) {
      notifications.show(words.typeRefused, { itemName: item.name });
      return null;
    }
    const amount = await droppedAmount(item, fromActor);
    if (amount === undefined) return null;
    if (fromActor) {
      await words.move(this.document, item, amount);
      return null;
    }
    if (this.document.type === 'Convoy' && isCoinpurseItem(facts)) {
      notifications.show(NOTIFICATION_IDS.COINPURSE_CARRIER_REQUIRED);
      return null;
    }
    return this._storeLooseItem(item, amount, words);
  }

  /**
   * Copy a loose Item (from the world or a compendium) into the container, unequipped. The sheet writes it itself.
   * An inbound copy carries the Convoy's inbound flag, and a stored copy has it cleared, so it can't arrive hidden.
   */
  async _storeLooseItem(item, amount, words, { inbound = false } = {}) {
    const source = item.toObject();
    delete source._id;
    source.system.isWielded = false;
    source.system.isWorn = false;
    source.system.isEquipped = false;
    if (inbound || isInboundItem(source)) {
      source.flags = { ...source.flags, [SYSTEM_ID]: { ...source.flags?.[SYSTEM_ID], [CONVOY_INBOUND_FLAG]: inbound } };
    }
    if (amount !== null) {
      const stack = matchingStack(this.document.items, source);
      if (stack) {
        const total = (Number(stack.system.amount) || 0) + amount;
        await stack.update({ 'system.amount': total });
        notifications.show(words.resourceStored, { itemName: item.name, amount, total, stacked: true });
        return stack;
      }
      source.system.amount = amount;
    }
    const [created] = await this.document.createEmbeddedDocuments('Item', [source], { emblemTransfer: true });
    if (amount !== null) notifications.show(words.resourceStored, { itemName: item.name, amount, total: amount, stacked: false });
    return created ?? null;
  }

  /* -------------------------------------------- */
  /*  Container item removal                      */
  /* -------------------------------------------- */

  async _deleteItem(event) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget.closest('[data-item-id]');
    const item = row?.dataset.itemId ? this.document.items.get(row.dataset.itemId) : null;
    if (!item || !this._canDeleteItems(item)) return;
    const words = this._containerVocabulary;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Item' },
      content: `<p>Are you sure you want to ${words.deleteVerb} <strong>${escapeHtml(item.name)}</strong> from the ${words.noun}?</p>`,
      modal: true
    });
    if (confirmed) await this.document.deleteEmbeddedDocuments('Item', [item.id]);
  }

  _canDeleteItems() {
    return this.isEditable;
  }

  /**
   * Allow owned-item Convoy deposits through the economy command. Loose-item copies and Vendor stocking require
   * authoring permission.
   */
  _canStore(item) {
    if (this.document.type === 'Convoy' && item.parent?.documentName === 'Actor') return item.parent.isOwner === true;
    return this.isEditable;
  }
}

/** The Item a payload carries inline, for a drag whose UUID names nothing this world can resolve. */
async function detachedDropItem(payload) {
  try {
    return await Item.implementation.fromDropData(payload) ?? null;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'detachedDropItem');
    return null;
  }
}

/**
 * The stack a dropped Resource joins: same name, same unit price and the same vendor tags (matchingResourceStack),
 * since one material bought at two prices counts as two goods. It must also be on the same side of delivery, so a
 * stored drop never grows an inbound stack.
 */
function matchingStack(items, source) {
  const inbound = isInboundItem(source);
  return matchingResourceStack([...items].filter(item => isInboundItem(item) === inbound), source);
}

/** The facts the stocking rules in game/economy read from a dropped Item. */
function itemFacts(item) {
  return { type: item.type, itemType: item.system.itemType, name: item.name };
}

/**
 * How much of a dropped Resource to store, asked in the amount dialog: null for any other Item, and undefined when
 * the drop is called off or the amount is not above 0. A stack moved from a unit caps the amount at its size.
 */
async function droppedAmount(item, fromActor = false) {
  if (item.type !== 'Resource') return null;
  const available = fromActor ? Math.max(1, Number(item.system.amount) || 1) : null;
  const amount = await openResourceAmountDialog(item.name, available);
  if (amount === null || amount === undefined) return undefined;
  if (amount <= 0) {
    notifications.show(NOTIFICATION_IDS.RESOURCE_AMOUNT_REQUIRED);
    return undefined;
  }
  return amount;
}

const CONVOY_VOCABULARY = Object.freeze({
  noun: 'convoy',
  deleteVerb: 'delete',
  typeRefused: NOTIFICATION_IDS.CONVOY_ITEM_TYPE_REFUSED,
  resourceStored: NOTIFICATION_IDS.CONVOY_RESOURCE_STORED,
  move: (convoy, item, amount) => game.emblemRpg.api.economy.convoyDeposit({
    sourceActorUuid: item.parent.uuid, itemId: item.id, convoyUuid: convoy.uuid, amount
  })
});

const VENDOR_VOCABULARY = Object.freeze({
  noun: 'vendor',
  deleteVerb: 'remove',
  typeRefused: NOTIFICATION_IDS.VENDOR_ITEM_TYPE_REFUSED,
  resourceStored: NOTIFICATION_IDS.VENDOR_RESOURCE_STOCKED,
  move: (vendor, item, amount) => game.emblemRpg.api.economy.vendorStock({
    sourceActorUuid: item.parent.uuid, itemId: item.id, vendorUuid: vendor.uuid, amount
  })
});

function categoryForItem(item) {
  const itemType = item.system?.itemType;
  if (item.type === 'Equipment') {
    if (itemType === 'Weapon') return WEAPON_TABS[item.system?.weapon?.req] ?? 'miscellaneous';
    if (itemType === 'Staff' || itemType === 'Staff (U)') return 'staves';
    if (['Armor', 'Shield', 'Accessory'].includes(itemType)) return 'armor';
  }
  if (item.type === 'Consumable') return 'consumables';
  return 'miscellaneous';
}

/* -------------------------------------------- */
/*  Convoy sheet                                */
/* -------------------------------------------- */
/** What each category tab counts in the header, before "stored" or "inbound". */
const COUNT_NOUNS = Object.freeze({
  all: 'items',
  brawling: 'Brawling weapons',
  blade: 'Blade weapons',
  polearm: 'Polearm weapons',
  heavy: 'Heavy weapons',
  bow: 'Bow weapons',
  covert: 'Covert weapons',
  staves: 'Staves',
  armor: 'Armor items',
  consumables: 'Consumables',
  miscellaneous: 'Miscellaneous items'
});

/** The Convoy sheet's two lists: what the Convoy holds, and what staff have yet to deliver to it. */
const CONVOY_VIEWS = Object.freeze({ STORED: 'stored', INBOUND: 'inbound' });
const INBOUND_ROW_SELECTOR = '.convoy-item[data-inbound="true"]';
const GOLD_SELECTOR = '.convoy-gp-drag';
const INBOUND_OWNED_REFUSAL =
  'A unit\'s own items go to the Stored view, so only a loose Item can be added as inbound.';
const INBOUND_COINPURSE_REFUSAL = 'Enter inbound gold in the GP field. A Coinpurse cannot be added as inbound.';

/** The sheet for Convoy actors, registered in init/registrations.mjs. */
export class ConvoySheet extends ContainerActorSheet {
  static DEFAULT_OPTIONS = {
    classes: ['actor', 'convoy'],
    position: { width: 550, height: 450 },
    window: { title: 'Convoy', icon: 'fas fa-warehouse' }
  };

  static PARTS = {
    main: { template: `systems/${SYSTEM_ID}/templates/sheets/convoy-sheet.hbs` }
  };

  /** Whether the sheet shows the Inbound view. Like the active category tab, the choice is kept on the sheet. */
  get inboundView() {
    return this._convoyView === CONVOY_VIEWS.INBOUND;
  }

  /* -------------------------------------------- */
  /*  Convoy context                              */
  /* -------------------------------------------- */
  /** Each view lists and counts only its own Items, so the Stored view never shows what is still on its way. */
  _listedItems() {
    const { stored, inbound } = partitionConvoyItems(this.document.items);
    return this.inboundView ? inbound : stored;
  }

  _itemView(item) {
    const row = super._itemView(item);
    row.inbound = isInboundItem(item);
    row.canDelete = row.inbound ? isStaff() : this.isEditable;
    return row;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const inbound = this.inboundView;
    const arrivals = partitionConvoyItems(this.document.items).inbound.length;
    const inboundGp = Number(this.document.system.inboundGp) || 0;
    const active = context.categoryList.find(category => category.active);
    context.activeCountLabel = countLabel(this.activeTab, active?.count ?? 0, inbound);
    context.inboundView = inbound;
    context.inboundCount = arrivals;
    context.inboundPending = arrivals > 0 || inboundGp > 0;
    context.gpField = inbound ? 'system.inboundGp' : 'system.gp';
    context.gpValue = inbound ? inboundGp : this.document.system.gp;
    context.gpLocked = inbound && !isStaff();
    context.emptyText = inbound ? 'Nothing here is on its way to the Convoy.' : '';
    return context;
  }

  _updateTabSummary(tab, count) {
    const target = this.element.querySelector('.convoy-item-count');
    if (target) target.textContent = countLabel(tab, count, this.inboundView);
  }

  /* -------------------------------------------- */
  /*  Convoy interaction                          */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    if (!this.inboundView) {
      this.element.querySelector(GOLD_SELECTOR)?.addEventListener('dragstart', event => this._startGoldDrag(event));
    }
    for (const button of this.element.querySelectorAll('.convoy-inbound-toggle')) {
      button.addEventListener('click', event => this._showView(event.currentTarget.dataset.view));
    }
    this.element.querySelector('.convoy-deliver-all')?.addEventListener('click', event => {
      event.preventDefault();
      void this._deliver({ all: true });
    });
    if (!isStaff()) return;
    for (const row of this.element.querySelectorAll(INBOUND_ROW_SELECTOR)) {
      row.addEventListener('dblclick', () => this.document.items.get(row.dataset.itemId)?.sheet?.render(true));
    }
  }

  /** Staff deliver by right-clicking an inbound row or, on the Inbound view, the gold icon. One menu serves both. */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    if (!isStaff()) return;
    this._createContextMenu(this._inboundDeliveryEntries, `${INBOUND_ROW_SELECTOR}, ${GOLD_SELECTOR}`, {
      fixed: true, hookName: 'getEmblemConvoyInboundContextOptions', parentClassHooks: false
    });
  }

  /** Switch between the Stored and Inbound lists. The category tab stays where it was. */
  _showView(view) {
    const next = view === CONVOY_VIEWS.INBOUND ? CONVOY_VIEWS.INBOUND : CONVOY_VIEWS.STORED;
    if (next === (this._convoyView ?? CONVOY_VIEWS.STORED)) return;
    this._convoyView = next;
    playMenuSound(SOUND_IDS.UI_BLIP_1);
    this.render(false);
  }

  /**
   * Start a drag of the Convoy's gold from its coin icon. The Character sheet it lands on asks how much
   * (_onDropConvoyGold), and the convoyWithdraw command settles it.
   */
  _startGoldDrag(event) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify({
      type: CONVOY_GOLD_DRAG_TYPE,
      convoyId: this.document.id,
      convoyUuid: this.document.uuid
    }));
  }

  /** The staff delivery menu's entries. Foundry's ContextMenu shows each one only on the target it names. */
  _inboundDeliveryEntries() {
    return [
      {
        label: 'Deliver',
        icon: '<i class="fas fa-truck-ramp-box"></i>',
        visible: target => target?.matches?.(INBOUND_ROW_SELECTOR) === true,
        onClick: (_event, target) => this._deliver({ itemIds: [String(target?.dataset?.itemId ?? '')] })
      },
      {
        label: 'Deliver gold',
        icon: '<i class="fas fa-coins"></i>',
        visible: target => this.inboundView && target?.matches?.(GOLD_SELECTOR) === true,
        onClick: () => this._deliver({ gold: true })
      }
    ];
  }

  /**
   * Send one staff delivery through api.economy.convoyDeliver: everything inbound, the named inbound Items, or the
   * inbound gold. The command moves them into the stored inventory and `system.gp`, and the facade shows the result.
   */
  _deliver(selection) {
    if (!isStaff()) return null;
    return game.emblemRpg.api.economy.convoyDeliver({ convoyUuid: this.document.uuid, ...selection });
  }

  /* -------------------------------------------- */
  /*  Convoy drops and removal                    */
  /* -------------------------------------------- */
  /**
   * ActorSheetV2 binds core's DragDrop, which attaches its drop listener only when _canDragDrop allows, and core
   * allows only an editable sheet. The Stored view of a world Convoy also listens for a reader who can't edit it, so a
   * Player can deposit an Item their unit holds. _onDrop and _canStore refuse everything else that reader drops. A
   * Convoy in a compendium keeps core's rule, so no deposit is sent into a locked pack.
   */
  _canDragDrop(selector) {
    return super._canDragDrop(selector) || (!this.inboundView && !this.document.pack);
  }

  /** On the Inbound view, only staff may drop Items (to add inbound content). The Stored view keeps the usual rules. */
  _canStore(item) {
    if (this.inboundView) return isStaff() && this.isEditable;
    return super._canStore(item);
  }

  async _storeDroppedItem(item) {
    return this.inboundView ? this._storeInboundItem(item) : super._storeDroppedItem(item);
  }

  /**
   * Add an inbound Item from a drop on the Inbound view. A loose Item is copied in with the inbound flag, written by
   * the sheet as a stored copy is (_storeLooseItem). A unit's own Item is refused, since it goes through the deposit
   * command into the Stored view, and so is a Coinpurse, since inbound gold is entered in the header's GP field.
   */
  async _storeInboundItem(item) {
    const facts = itemFacts(item);
    if (!isContainerStockable(facts)) {
      notifications.show(NOTIFICATION_IDS.CONVOY_ITEM_TYPE_REFUSED, { itemName: item.name });
      return null;
    }
    if (item.parent?.documentName === 'Actor') return refuseInbound(INBOUND_OWNED_REFUSAL);
    if (isCoinpurseItem(facts)) return refuseInbound(INBOUND_COINPURSE_REFUSAL);
    const amount = await droppedAmount(item);
    if (amount === undefined) return null;
    return this._storeLooseItem(item, amount, this._containerVocabulary, { inbound: true });
  }

  /** Only staff remove an inbound Item. A stored one follows the sheet's authoring permission. */
  _canDeleteItems(item) {
    return isInboundItem(item) ? isStaff() : super._canDeleteItems(item);
  }
}

/** The header's count line: "12 items stored", "3 Blade weapons inbound". */
function countLabel(tab, count, inbound) {
  return `${count} ${COUNT_NOUNS[tab] ?? COUNT_NOUNS.all} ${inbound ? 'inbound' : 'stored'}`;
}

/** Staff (GM and Assistant GM) deliver and add inbound content. Foundry's isGM is true for both roles. */
function isStaff() {
  return game.user.isGM;
}

/** Refuse an inbound drop on the dropping staff member's own client, with the refusal cue. */
function refuseInbound(text) {
  playMenuSound(SOUND_IDS.UI_ERROR);
  ui.notifications.warn(text);
  return null;
}

/* -------------------------------------------- */
/*  Vendor sheet                                */
/* -------------------------------------------- */
/** The sheet for Vendor actors, registered in init/registrations.mjs. */
export class VendorSheet extends ContainerActorSheet {
  static DEFAULT_OPTIONS = {
    classes: ['actor', 'vendor'],
    position: { width: 550, height: 450 },
    actions: {
      editImage: VendorSheet.editImage,
      merchandiseSettings: VendorSheet.merchandiseSettings,
      clearStock: VendorSheet.clearStock
    },
    window: { title: 'Vendor', icon: 'fas fa-store', minimizable: true, resizable: false }
  };

  static PARTS = {
    main: { template: `systems/${SYSTEM_ID}/templates/sheets/vendor-sheet.hbs` }
  };

  _itemView(item) {
    const row = super._itemView(item);
    const rawStock = item.getFlag(SYSTEM_ID, 'stock');
    const isResource = item.type === 'Resource';
    row.id = item.id;
    // A Resource's stock is its amount and it is priced per unit.
    row.cost = Number(isResource ? item.system.cost.perUnit : item.system.cost) || 0;
    if (isResource) row.stock = Math.max(0, Math.floor(Number(item.system.amount) || 0));
    else row.stock = rawStock === null || rawStock === undefined || rawStock === ''
      ? null
      : Math.max(0, Math.floor(Number(rawStock) || 0));
    row.locked = item.getFlag(SYSTEM_ID, 'vendorLocked') === true;
    return row;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.isTokenActor = this.document.isToken;
    context.actorLink = this.document.prototypeToken.actorLink;
    return context;
  }

  /* -------------------------------------------- */
  /*  Vendor interaction                          */
  /* -------------------------------------------- */
  _sheetFrameButtons() {
    if (!game.user.isGM) return [];
    return [
      { action: 'merchandiseSettings', icon: 'fas fa-tags', label: 'Merchandise Settings' },
      { action: 'clearStock', icon: 'fas fa-broom', label: 'Clear Stock' }
    ];
  }

  /** A vendor's portrait is its token, so it is edited in the studio's default slot rather than the file browser. */
  static async editImage(event) {
    event.preventDefault();
    return openStudioForSlot(this.document, 'default');
  }

  _canDeleteItems() {
    return game.user.isGM === true;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector('.vendor-disposition-input')?.addEventListener('change', event => {
      if (!this.isEditable) return;
      const value = Math.round(Number(String(event.currentTarget.value).trim()) || 0);
      this.document.update({ 'system.disposition': Math.max(-10, Math.min(10, value)) });
    });
    this.element.querySelector('.vendor-linked-input')?.addEventListener('change', event => {
      if (!this.isEditable) return;
      this.document.update({ 'prototypeToken.actorLink': event.currentTarget.checked });
    });
    for (const input of this.element.querySelectorAll('.vendor-stock-input')) {
      input.addEventListener('change', event => this._writeStock(event.currentTarget));
    }
    for (const row of this.element.querySelectorAll('.vendor-item')) {
      row.addEventListener('contextmenu', event => this._toggleLock(event, row.dataset.itemId));
    }
  }

  /**
   * Save a stock edit. Blank means unlimited stock and 0 means sold out. A Resource's stock is its amount, which
   * never goes below 1.
   */
  async _writeStock(input) {
    if (!this.isEditable) return null;
    const item = this.document.items.get(input.closest('[data-item-id]')?.dataset.itemId);
    if (!item) return null;
    const raw = String(input.value).trim();
    if (item.type === 'Resource') return item.update({ 'system.amount': Math.max(1, Math.floor(Number(raw) || 1)) });
    if (raw === '') return item.unsetFlag(SYSTEM_ID, 'stock');
    return item.setFlag(SYSTEM_ID, 'stock', Math.max(0, Math.floor(Number(raw) || 0)));
  }

  /** Right-click toggles the stock lock: locked entries survive Clear Stock. */
  async _toggleLock(event, itemId) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user.isGM) return;
    const item = this.document.items.get(itemId);
    if (!item) return;
    if (item.getFlag(SYSTEM_ID, 'vendorLocked')) await item.unsetFlag(SYSTEM_ID, 'vendorLocked');
    else await item.setFlag(SYSTEM_ID, 'vendorLocked', true);
    playMenuSound(SOUND_IDS.UI_BLIP_1);
  }

  /** Empty the vendor except for locked entries. When nothing is unlocked, say so instead of asking. */
  static async clearStock() {
    if (!game.user.isGM) return;
    const vendor = this.document;
    const lockedCount = vendor.items.filter(item => item.getFlag(SYSTEM_ID, 'vendorLocked')).length;
    const ids = vendor.items.filter(item => !item.getFlag(SYSTEM_ID, 'vendorLocked')).map(item => item.id);
    if (!ids.length) {
      notifications.show(lockedCount ? NOTIFICATION_IDS.VENDOR_STOCK_ALL_LOCKED : NOTIFICATION_IDS.VENDOR_STOCK_EMPTY, {
        vendorName: vendor.name
      });
      return;
    }
    const lockedNote = lockedCount ? ` <strong>${lockedCount} locked item(s)</strong> will be kept.` : '';
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Clear Stock', icon: 'fas fa-broom' },
      classes: [SYSTEM_ID],
      content: `<p>Remove <strong>${ids.length} item(s)</strong> from <strong>${escapeHtml(vendor.name)}</strong>?${lockedNote} This cannot be undone.</p>`,
      modal: true
    });
    if (!confirmed) return;
    try {
      await vendor.deleteEmbeddedDocuments('Item', ids);
      notifications.show(NOTIFICATION_IDS.VENDOR_STOCK_CLEARED, { vendorName: vendor.name, removed: ids.length, lockedCount });
      playMenuSound(SOUND_IDS.UI_UNSELECT);
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'clearStock');
      notifications.show(NOTIFICATION_IDS.VENDOR_STOCK_CLEAR_FAILED);
      playMenuSound(SOUND_IDS.UI_ERROR);
    }
  }

  /** Edit which goods this vendor buys from players. The vendorMerchandise command writes the change, not the sheet. */
  static async merchandiseSettings() {
    if (!game.user.isGM) return;
    const changes = await openMerchandiseSettings(this.document);
    if (!changes) return;
    await game.emblemRpg.api.economy.vendorMerchandise({ vendorUuid: this.document.uuid, changes });
  }
}
