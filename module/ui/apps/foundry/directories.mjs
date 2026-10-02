/** @layer ui/apps/foundry */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { avatarScaleStyle, escapeHtml } from '../../../lib/dom/html.mjs';
import { ConfigurePartyApp } from '../menus/party-app.mjs';
import { openAnimationEditorDialog } from '../sheets/item/editors/animations.mjs';
import { openCraftingSettingsDialog } from '../sheets/item/editors/crafting.mjs';
import { itemCapabilityProfile } from '../sheets/item/sheet.mjs';

/* -------------------------------------------- */
/*  Folder Directory Windows                    */
/* -------------------------------------------- */

const openWindows = new Map();
const scopedClasses = new Map();

/**
 * Open, or refocus, a floating directory window scoped to one sidebar folder. Runs when an Item folder is dropped
 * on the canvas (createCanvasDropHandlers in foundry/hooks/scene.mjs).
 */
export async function openFolderDirectory(folder) {
  const existing = openWindows.get(folder.id);
  if (existing) return existing.render({ force: true });
  const app = new (scopedDirectoryClass(folder.type))({
    id: `${folder.type.toLowerCase()}-folder-${folder.id}`,
    folderId: folder.id,
    window: { frame: true, positioned: true, minimizable: true, controls: [], title: folder.name },
    classes: [
      'sidebar-popout', 'emblem-folder-directory',
      folder.type === 'Actor' ? 'actors-sidebar' : 'items-sidebar'
    ]
  });
  openWindows.set(folder.id, app);
  return app.render({ force: true });
}

/* -------------------------------------------- */
/*  Scoped directory class                      */
/* -------------------------------------------- */

/**
 * The core directory application narrowed to one folder's subtree, so every inherited behavior (drag and drop,
 * context menus, search, the create buttons on folder banners) keeps working inside the window.
 * @param {string} documentName          Which sidebar collection the folder belongs to.
 * @returns {typeof foundry.applications.sidebar.DocumentDirectory}
 */
function scopedDirectoryClass(documentName) {
  let cls = scopedClasses.get(documentName);
  if (cls) return cls;
  const Base = documentName === 'Actor'
    ? foundry.applications.sidebar.tabs.ActorDirectory
    : foundry.applications.sidebar.tabs.ItemDirectory;
  cls = class EmblemFolderDirectory extends Base {
    get title() {
      return game.folders.get(this.options.folderId)?.name ?? super.title;
    }

    async _prepareDirectoryContext(context, options) {
      await super._prepareDirectoryContext(context, options);
      const node = folderNode(this.collection.tree, this.options.folderId);
      if (node) context.tree = node;
      else {
        context.tree = { root: true, folder: null, depth: 0, visible: false, children: [], entries: [] };
        void this.close();
      }
    }

    // Join the collection's apps, so Foundry re-renders this window when the folder's documents change.
    _onFirstRender(context, options) {
      super._onFirstRender(context, options);
      this.collection.apps.push(this);
    }

    _onClose(options) {
      super._onClose(options);
      const index = this.collection.apps.indexOf(this);
      if (index >= 0) this.collection.apps.splice(index, 1);
      openWindows.delete(this.options.folderId);
    }
  };
  scopedClasses.set(documentName, cls);
  return cls;
}

function folderNode(node, folderId) {
  if (node.folder?.id === folderId) return node;
  for (const child of node.children ?? []) {
    const found = folderNode(child, folderId);
    if (found) return found;
  }
  return null;
}

/* -------------------------------------------- */
/*  Actor directory                             */
/* -------------------------------------------- */
const DROP_CHEST_TEMPLATE_FLAG = 'isDropChestTemplate';
const AVATAR_INDEX_FIELD = 'system.art.avatarScale';
const AVATAR_ZOOM_TYPES = new Set(['Character', 'Vendor']);
const avatarIndexedPacks = new Set();

/** Hide drop-chest templates, zoom each portrait thumbnail, and add the GM-only Configure Party button. */
export function onRenderActorDirectory(_application, root) {
  const element = domElement(root);
  if (!element) return;
  hideDropChestTemplateEntries(element);
  tagCharacterAvatarThumbnails(element);
  if (!game.user.isGM) return;
  if (element.querySelector('.emblem-configure-party-row')) return;
  const header = element.querySelector('.directory-header');
  if (!header) return;

  const row = document.createElement('div');
  row.className = 'header-actions action-buttons flexrow emblem-configure-party-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'emblem-configure-party-btn';
  button.innerHTML = '<i class="fas fa-flag"></i> Configure Party';
  button.addEventListener('click', () => ConfigurePartyApp.open());
  row.appendChild(button);

  const actions = header.querySelector('.header-actions');
  if (actions) actions.insertAdjacentElement('afterend', row);
  else header.appendChild(row);
}

/** Zoom the portrait thumbnails of an Actor compendium window from the indexed avatar scale. */
export async function onRenderCompendium(application, root) {
  const pack = application?.collection;
  if (pack?.documentName !== 'Actor') return false;
  const element = domElement(root);
  if (!element) return false;
  if (!avatarIndexedPacks.has(pack.collection)) {
    avatarIndexedPacks.add(pack.collection);
    await pack.getIndex({ fields: [AVATAR_INDEX_FIELD] });
  }
  if (element.isConnected === false) return false;
  for (const entry of pack.index) {
    if (!AVATAR_ZOOM_TYPES.has(entry.type)) continue;
    zoomThumbnail(element.querySelector(`[data-entry-id="${entry._id}"] img.thumbnail`), entry.system?.art?.avatarScale);
  }
  return true;
}

/** Redraw the Actor directory when a portrait's zoom moves, which the thumbnail alone would not follow. */
export function onUpdateActorAvatarScale(_actor, changes) {
  if (!foundry.utils.hasProperty(changes, AVATAR_INDEX_FIELD)) return false;
  globalThis.ui?.actors?.render?.();
  return true;
}

/** The field every Actor pack index carries so a compendium listing can zoom without loading documents. */
export function registerAvatarIndexField(config = globalThis.CONFIG) {
  const fields = config?.Actor?.compendiumIndexFields;
  if (Array.isArray(fields) && !fields.includes(AVATAR_INDEX_FIELD)) fields.push(AVATAR_INDEX_FIELD);
  return fields;
}

function hideDropChestTemplateEntries(element) {
  for (const actor of game.actors) {
    if (!actor.getFlag(SYSTEM_ID, DROP_CHEST_TEMPLATE_FLAG)) continue;
    const selector = `[data-entry-id="${actor.id}"], [data-document-id="${actor.id}"], [data-actor-id="${actor.id}"]`;
    for (const node of element.querySelectorAll?.(selector) ?? []) node.style.display = 'none';
  }
}

function tagCharacterAvatarThumbnails(element) {
  for (const actor of game.actors) {
    if (!AVATAR_ZOOM_TYPES.has(actor.type)) continue;
    const selector = `[data-entry-id="${actor.id}"], [data-document-id="${actor.id}"]`;
    for (const node of element.querySelectorAll?.(selector) ?? []) {
      zoomThumbnail(node.querySelector?.('img.thumbnail'), actor.system?.art?.avatarScale);
    }
  }
}

function zoomThumbnail(image, scale) {
  if (!image) return;
  image.classList.add('emblem-avatar-zoom');
  image.style.cssText = avatarScaleStyle(scale);
}

/* -------------------------------------------- */
/*  Item directory context menu                 */
/* -------------------------------------------- */
/**
 * Offer the Animation and Crafting editors on the Item directory rows that have them, to a GM. `init/hooks.mjs`
 * calls this from `getItemContextOptions`. The entries use v14's ContextMenu fields, so each check and click gets
 * the row's element.
 */
export function onItemDirectoryContext(_html, options) {
  if (!Array.isArray(options)) return;
  options.push({
    label: 'Animation Settings',
    icon: '<i class="fas fa-film"></i>',
    visible: row => contextItemEditors(row)?.animation === true,
    onClick: (_event, row) => {
      const item = itemFromRow(row);
      if (item) void openAnimationEditorDialog(item);
    }
  });
  options.push({
    label: 'Crafting Settings',
    icon: '<i class="fas fa-hammer"></i>',
    visible: row => contextItemEditors(row)?.equipmentCrafting === true,
    onClick: (_event, row) => {
      const item = itemFromRow(row);
      if (item) void openCraftingSettingsDialog(item);
    }
  });
}

function itemFromRow(row) {
  const id = row?.dataset?.entryId ?? row?.dataset?.documentId;
  return id ? game.items.get(id) ?? null : null;
}

function contextItemEditors(row) {
  if (!game.user.isGM) return null;
  const item = itemFromRow(row);
  if (!item) return null;
  return itemCapabilityProfile(item.type, String(item.system?.itemType ?? '')).editors;
}

/* -------------------------------------------- */
/*  Folder icons                                */
/* -------------------------------------------- */
const FOLDER_ICON_FLAG = 'icon';
const FOLDER_ICON_MARKER = 'data-emblem-folder-icon';

/** Add the folder icon picker beneath the folder's colour, once per render. */
export function onRenderFolderConfig(application, form) {
  const folder = application?.document;
  const root = domElement(form);
  if (!folder || !root || root.querySelector(`[${FOLDER_ICON_MARKER}]`)) return false;
  const colorGroup = root.querySelector('color-picker[name="color"]')?.closest('.form-group');
  if (!colorGroup) return false;

  const inputId = `${application.id}-emblem-icon`;
  const group = document.createElement('div');
  group.className = 'form-group';
  group.setAttribute(FOLDER_ICON_MARKER, '');
  group.innerHTML = `
    <label for="${inputId}">Folder Icon</label>
    <div class="form-fields">
      <file-picker id="${inputId}" name="flags.${SYSTEM_ID}.${FOLDER_ICON_FLAG}" type="image"
        value="${escapeHtml(folderIcon(folder) ?? '')}"></file-picker>
    </div>
  `;
  colorGroup.after(group);
  application.setPosition?.({ height: 'auto' });
  return true;
}

/** Swap the default folder glyph for the chosen image in every rendered directory. */
export function onRenderDocumentDirectory(application, root) {
  const element = domElement(root);
  if (!element) return 0;
  let swapped = 0;
  for (const row of element.querySelectorAll('li.directory-item.folder[data-folder-id]')) {
    const iconPath = folderIcon(directoryFolder(application, row.dataset.folderId));
    const header = row.querySelector(':scope > .folder-header');
    if (!header) continue;
    const existing = header.querySelector(':scope > img.emblem-folder-icon');
    const glyph = header.querySelector(':scope > i.fa-folder, :scope > i.fa-folder-open');
    if (!iconPath) {
      if (existing) {
        existing.remove();
        glyph?.style.removeProperty('display');
      }
      continue;
    }
    if (glyph) glyph.style.display = 'none';
    if (existing) {
      if (existing.getAttribute('src') !== iconPath) existing.setAttribute('src', iconPath);
    } else {
      const image = document.createElement('img');
      image.className = 'emblem-folder-icon';
      image.src = iconPath;
      image.alt = '';
      header.prepend(image);
    }
    swapped += 1;
  }
  return swapped;
}

/** The folder behind one directory row, from the collection that directory lists. */
function directoryFolder(application, folderId) {
  if (!folderId) return null;
  return application?.collection?.folders?.get?.(folderId) ?? game.folders.get(folderId) ?? null;
}

function folderIcon(folder) {
  const value = folder?.getFlag(SYSTEM_ID, FOLDER_ICON_FLAG);
  return typeof value === 'string' && value.length ? value : null;
}

function domElement(root) {
  const HTMLElementClass = globalThis.HTMLElement;
  if (HTMLElementClass && root instanceof HTMLElementClass) return root;
  return root?.[0] ?? root ?? null;
}
