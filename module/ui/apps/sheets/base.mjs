/** @layer ui/apps/sheets */
import {
  canFoundryUserAuthorDocument,
  canFoundryUserPlayDocument
} from '../../../foundry/adapters/services/authority.mjs';
import { openStudioForItem } from '../../../external/studio/character-art.mjs';
import { captureScrollPositions, restoreScrollPositions } from '../../../lib/dom/scroll.mjs';
import { reportFoundryProbe } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Window transitions                          */
/* -------------------------------------------- */
const COLLAPSE_FADE_MS = 130;
const COLLAPSE_FADE_CLASS = 'emblem-collapse-fade';

/* -------------------------------------------- */
/*  Sheet options                               */
/* -------------------------------------------- */
const SHEET_DEFAULTS = Object.freeze({
  preserveScroll: true,
  preserveFocus: false,
  dragDrop: false,
  imageStudio: false
});

const EDIT_IMAGE_DEFAULTS = Object.freeze({
  gmOnly: false,
  attrFromTarget: false,
  position: false
});

/* -------------------------------------------- */
/*  Shared sheet behavior                       */
/* -------------------------------------------- */
/** Whether the local user may author a document through its sheet: a GM, or a Trusted Player who owns it. */
export function canCurrentUserAuthor(document) {
  return canFoundryUserAuthorDocument(game.user, document);
}

/** Whether the local user may use a sheet's gameplay controls, which send system commands: the owner or a GM. */
function canCurrentUserPlay(document) {
  return canFoundryUserPlayDocument(game.user, document);
}

/* -------------------------------------------- */
/*  Sheet mixin                                 */
/* -------------------------------------------- */
/**
 * Add the behavior every system sheet shares to ActorSheetV2 or ItemSheetV2: rendering from the first PARTS template,
 * scroll and focus kept across renders, the read-only rules, item drags, the image picker and the collapse fade.
 * The Character, Class, Item, Resource, Object, Convoy and Vendor sheets are built on it.
 * @param {typeof foundry.applications.api.ApplicationV2} Base
 * @returns {typeof foundry.applications.api.ApplicationV2}
 */
export function EmblemSheetMixin(Base) {
  return class EmblemDocumentSheet extends Base {
    static DEFAULT_TAB = null;

    /** Per-sheet options (keep scroll or focus, accept drops, image picker), merged over SHEET_DEFAULTS. */
    static SHEET_OPTIONS = {};

    /** Selectors for navigation controls, such as tabs, that stay usable on a read-only sheet. */
    static NAVIGATION_CONTROLS = [];

    /** Selectors for the gameplay controls a read-only sheet keeps usable for the unit's owner or a GM. */
    static GAMEPLAY_CONTROLS = [];

    /** Options every system sheet shares. Foundry merges this up the class chain, so a sheet adds only its own. */
    static DEFAULT_OPTIONS = {
      classes: ['emblem-rpg', 'sheet'],
      tag: 'form',
      form: { closeOnSubmit: false, submitOnChange: true },
      window: { minimizable: true, resizable: false },
      actions: { editImage: EmblemDocumentSheet.editImage }
    };

    /** Pick a new image for the document this sheet edits. */
    static async editImage(event, target) {
      if (!this.isEditable) return null;
      return browseDocumentImage(this, event, target);
    }

    /** Remember the clicked tab and draw the sheet again. */
    static setTab(_event, target) {
      this._activeTab = target.dataset.tab || this.constructor.DEFAULT_TAB;
      this.render(false);
    }

    get activeTab() {
      return this._activeTab ?? this.constructor.DEFAULT_TAB;
    }

    get title() {
      return this.document.name;
    }

    get sheetOptions() {
      return resolveSheetOptions(this.constructor.SHEET_OPTIONS);
    }

    /** Fade to the compact sheet bar and remember the expanded dimensions. */
    async minimize() {
      return collapseSheet(this, () => super.minimize());
    }

    /** Fade from the compact bar and restore the sheet's expanded dimensions. */
    async maximize() {
      return expandSheet(this, () => super.maximize());
    }

    // These sheets don't use HandlebarsApplicationMixin: the first PARTS template is rendered as the whole content
    // and _replaceHTML swaps it in, so any other PARTS entries are ignored.
    async _renderHTML(context, options) {
      const part = Object.values(this.constructor.PARTS)[0];
      return foundry.applications.handlebars.renderTemplate(part.template, context);
    }

    async _prepareContext(options) {
      return prepareSheetContext(this, await super._prepareContext(options));
    }

    // Foundry's form data reads an img[data-edit]'s src into the submit; images are saved by editImage instead.
    _prepareSubmitData(event, form, formData) {
      const data = super._prepareSubmitData(event, form, formData);
      for (const image of form.querySelectorAll('img[data-edit]')) delete data[image.dataset.edit];
      return data;
    }

    _getFrameButtons(options) {
      return [...super._getFrameButtons(options), ...this._sheetFrameButtons(options)];
    }

    _sheetFrameButtons() {
      return [];
    }

    /** Swap the content while keeping the scroll offsets and, where asked, the focused field and its caret. */
    _replaceHTML(result, content) {
      replaceSheetContent(this, result, content);
    }

    /** Wire the shared listeners: drops on the content root, and a right-click on the image opening Studio. */
    _activateSharedListeners(content) {
      activateSharedListeners(this, content);
    }

    /** Editable only by someone who may author the document: a GM, or a Trusted Player who owns it. */
    get isEditable() {
      return super.isEditable === true && canCurrentUserAuthor(this.document);
    }

    /** Whether the local user is the owner or a GM, so gameplay controls stay usable on a read-only sheet. */
    get canPlay() {
      return canCurrentUserPlay(this.document);
    }

    /**
     * Foundry disables every control on a read-only sheet. Turn the navigation controls back on, and the gameplay
     * controls too for the owner or a GM. The emblem-readonly class lets the stylesheet give disabled
     * fields a plain cursor, since they only display values there, and disabled buttons the locked cursor.
     */
    _toggleDisabled(disabled) {
      super._toggleDisabled(disabled);
      this.element.classList.toggle('emblem-readonly', disabled === true);
      if (!disabled) return;
      enableNavigationControls(this.element, this.constructor.NAVIGATION_CONTROLS);
      if (this.canPlay) enableNavigationControls(this.element, this.constructor.GAMEPLAY_CONTROLS);
    }

    _onDragOver(event) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    /**
     * Start a drag of one of the document's items. The payload carries its uuid and a full copy of its data; Foundry's
     * fromDropData builds a parentless copy from that data, so receivers should look the item up by uuid first.
     */
    _onDragStart(event) {
      startItemDrag(this, event);
    }

    _dragPayload(item) {
      return itemDragPayload(this, item);
    }

    /** Extra drag payload fields a sheet adds so the receiver can tell where the item came from. */
    _dragPayloadExtras(_item) {
      return {};
    }

    /** Open the pixel editor on the document's image, on a right-click. Studio makes the final call. */
    async _onEditImageStudio(event) {
      event.preventDefault();
      if (!game.user.isGM && !canFoundryUserAuthorDocument(game.user, this.document)) return;
      return openStudioForItem(this.document);
    }
  };
}

/* -------------------------------------------- */
/*  Mixin helpers                               */
/* -------------------------------------------- */
/** A sheet's SHEET_OPTIONS over the defaults, with the image picker's own defaults filled in. */
function resolveSheetOptions(declared = {}) {
  return {
    ...SHEET_DEFAULTS,
    ...declared,
    editImage: { ...EDIT_IMAGE_DEFAULTS, ...declared.editImage }
  };
}

function prepareSheetContext(sheet, context) {
  context.document = sheet.document;
  context.system = sheet.document.system;
  context.isEditable = sheet.isEditable;
  context.canAuthor = sheet.isEditable;
  context.canPlay = sheet.canPlay;
  context.isGM = game.user.isGM;
  if (sheet.constructor.DEFAULT_TAB !== null) context.activeTab = sheet.activeTab;
  return context;
}

function replaceSheetContent(sheet, result, content) {
  const options = sheet.sheetOptions;
  const savedScroll = options.preserveScroll ? captureScrollPositions(content) : null;
  const savedFocus = options.preserveFocus ? captureFocus(content) : null;
  content.innerHTML = result;
  sheet._activateSharedListeners(content);
  if (savedScroll) restoreScrollPositions(content, savedScroll);
  if (savedFocus) restoreFocus(content, savedFocus);
}

/**
 * With dragDrop on, drops are also caught on the content so a read-only sheet still accepts them. On an editable
 * sheet Foundry's own drop handler on the form runs too, so a sheet using this must stop the drop's propagation or
 * _onDrop runs twice.
 */
function activateSharedListeners(sheet, content) {
  const options = sheet.sheetOptions;
  if (options.dragDrop && !content.hasAttribute('data-drop-listeners-added')) {
    content.addEventListener('dragover', sheet._onDragOver.bind(sheet));
    content.addEventListener('drop', sheet._onDrop.bind(sheet));
    content.setAttribute('data-drop-listeners-added', 'true');
  }
  if (options.imageStudio) {
    for (const element of content.querySelectorAll('[data-action="editImage"]')) {
      element.addEventListener('contextmenu', sheet._onEditImageStudio.bind(sheet));
    }
  }
}

/** Re-enable the controls matching these selectors after Foundry disabled the whole read-only sheet. */
function enableNavigationControls(root, selectors = []) {
  let count = 0;
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      element.disabled = false;
      count += 1;
    }
  }
  return count;
}

function startItemDrag(sheet, event) {
  const itemId = event.currentTarget?.dataset?.itemId ?? event.currentTarget?.closest?.('[data-item-id]')?.dataset?.itemId;
  const item = sheet.document.items?.get(itemId);
  if (!item || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', JSON.stringify(sheet._dragPayload(item)));
}

/** The payload a dragged item carries: its ids, its full data, and whatever the sheet's _dragPayloadExtras adds. */
function itemDragPayload(sheet, item) {
  return {
    type: 'Item',
    uuid: item.uuid,
    id: item.id,
    actorId: sheet.document.id,
    data: item.toObject(),
    ...sheet._dragPayloadExtras(item)
  };
}

/* -------------------------------------------- */
/*  Sheet chrome                                */
/* -------------------------------------------- */
/**
 * Open the image picker for the document a sheet edits and write the chosen path back to it. Called by the mixin's
 * editImage action.
 * @param {object} sheet   The sheet whose document gets the image.
 * @param {Event} event    The click, whose default action is prevented.
 * @param {HTMLElement} target The control, whose `data-edit` names the field when the sheet asks for that.
 * @returns {Promise|null} The FilePicker's browse promise, or null when the picker is GM-only and the user isn't a GM.
 */
function browseDocumentImage(sheet, event, target) {
  const options = sheet.sheetOptions.editImage;
  if (options.gmOnly && !game.user.isGM) return null;
  event.preventDefault();
  const attribute = (options.attrFromTarget ? target.dataset.edit : null) || 'img';
  const config = {
    type: 'image',
    current: foundry.utils.getProperty(sheet.document, attribute),
    callback: path => sheet.document.update({ [attribute]: path })
  };
  if (options.position) {
    config.position = { top: (sheet.position?.top ?? 0) + 40, left: (sheet.position?.left ?? 0) + 10 };
  }
  return new foundry.applications.apps.FilePicker.implementation(config).browse();
}

/**
 * Show one tab without redrawing: mark its control active and reveal only its panel.
 * @param {HTMLElement} root      The sheet content root.
 * @param {string} tab            The tab to show.
 * @param {object} selectors      `controls` and `panels` selectors, the dataset `attribute` panels
 *                                carry, and the `display` an active panel takes when it needs one.
 */
export function showTabPanels(root, tab, { controls, panels, attribute = 'tab', display = null }) {
  for (const control of root.querySelectorAll(controls)) {
    control.classList.toggle('active', control.dataset.tab === tab);
  }
  for (const panel of root.querySelectorAll(panels)) {
    const active = panel.dataset[attribute] === tab;
    panel.classList.toggle('active', active);
    if (display !== null) panel.style.display = active ? display : 'none';
  }
}

/* -------------------------------------------- */
/*  Focus preservation                          */
/* -------------------------------------------- */
/** Record which field inside the content is focused and where its caret sits. */
function captureFocus(content, active = globalThis.document?.activeElement) {
  if (!active || !content.contains(active) || !active.name) return null;
  return {
    name: active.name,
    tagName: active.tagName,
    selectionStart: active.selectionStart ?? null,
    selectionEnd: active.selectionEnd ?? null
  };
}

/** Put the focus and the caret back onto the field of the same name in the new content. */
function restoreFocus(content, saved) {
  const next = content.querySelector(`[name="${saved.name}"]`);
  if (!next) return false;
  next.focus?.();
  const textControl = saved.tagName === 'INPUT' || saved.tagName === 'TEXTAREA';
  if (textControl && saved.selectionStart !== null && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    } catch (diagnosticError) {
      reportFoundryProbe(import.meta.url, diagnosticError, 'restoreFocus', diagnosticError?.name === 'InvalidStateError');
      return true;
    }
  }
  return true;
}

/* -------------------------------------------- */
/*  Collapse helpers                            */
/* -------------------------------------------- */
async function collapseSheet(sheet, minimize) {
  const element = sheet.element;
  if (!element || sheet._emblemCollapsing || sheet.minimized
    || !sheet.rendered || !sheet.options.window.minimizable) {
    return minimize();
  }
  sheet._emblemCollapsing = true;
  const { width, height } = sheet.position;
  sheet._emblemPriorSize = restorableDimension(width) && restorableDimension(height) ? { width, height } : null;
  try {
    await fadeSheet(element);
    await minimize();
  } finally {
    element.classList.remove(COLLAPSE_FADE_CLASS);
    sheet._emblemCollapsing = false;
  }
}

async function expandSheet(sheet, maximize) {
  const element = sheet.element;
  if (!element || sheet._emblemCollapsing || !sheet.minimized) return maximize();
  sheet._emblemCollapsing = true;
  const prior = sheet._emblemPriorSize;
  sheet._emblemPriorSize = null;
  try {
    await fadeSheet(element);
    await maximize();
    if (prior && sheet.rendered) sheet.setPosition(prior);
  } finally {
    element.classList.remove(COLLAPSE_FADE_CLASS);
    sheet._emblemCollapsing = false;
  }
}

function fadeSheet(element) {
  element.classList.add(COLLAPSE_FADE_CLASS);
  return new Promise(resolve => setTimeout(resolve, COLLAPSE_FADE_MS));
}

function restorableDimension(value) {
  return value === 'auto' || Number.isFinite(value);
}
