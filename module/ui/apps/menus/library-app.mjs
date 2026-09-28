/** @layer ui/apps/menus */
import { missingBuiltins, withBuiltinsRestored } from '../../../game/downtime/library.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { getTooltip } from '../../tooltips.mjs';

/* -------------------------------------------- */
/*  Library window                              */
/* -------------------------------------------- */
const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Each library class's open window, which `open` brings forward and `refreshViews` re-reads. */
const openLibraries = new Map();

/**
 * The world library window that recipe-library-app.mjs and song-library-app.mjs share: GMs edit it and everyone
 * else reads it from the same window. Edits stay in memory until Save, which sends the whole library through the
 * subclass's api.downtime save command, so the window tracks a dirty flag, warns on close, and stops following
 * outside changes meanwhile.
 *
 * A subclass declares its DEFAULT_OPTIONS and PARTS and a static LIBRARY: the entry noun (`recipe`, whose list is
 * `recipes`), the row class the templates give each entry, the drag type, the Default and Personal tabs, the add
 * button's tooltip id, the station type whose sheets show the library, and the entry normalizer and blank-entry
 * builder from game/downtime. It also supplies `_inspectLibrary()` and `_saveLibrary(entries)`, which call its
 * api.downtime commands, and `_detailContext(selected)` and `_wireDetail(parts)` for its own detail fields.
 */
export class LibraryApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * Open this library's window, or bring it forward if it's open, and select an entry when one is named (`recipeId`
   * or `songId`). The Character and station sheets call it.
   */
  static open(options = {}) {
    let library = openLibraries.get(this);
    if (!library) {
      library = new this();
      openLibraries.set(this, library);
    }
    const id = options[`${this.LIBRARY.noun}Id`];
    if (id) library.showEntry(id);
    library.render({ force: true });
    return library;
  }

  /**
   * Follow a library change made elsewhere: the open window re-reads unless dirty, and the Character and station
   * sheets that show the library repaint.
   */
  static refreshViews() {
    void openLibraries.get(this)?.reload();
    const { noun, stationType } = this.LIBRARY;
    const open = [
      ...foundry.applications.instances.values(),
      ...Object.values(globalThis.ui?.windows ?? {})
    ];
    for (const app of open) {
      const actor = app?.document;
      if (actor?.documentName !== 'Actor' || !['Character', 'Object'].includes(actor.type)) continue;
      if (actor.type === 'Object' && actor.system.objectType !== stationType) continue;
      if (actor.type === 'Character' && !(actor.system.knowledge[`${noun}s`].length > 0)) continue;
      app.render(false);
    }
  }

  constructor(options = {}) {
    super(options);
    this._entries = null;
    this._builtins = [];
    this._readOnly = true;
    this._activeTab = 'default';
    this._selectedId = null;
    this._pendingId = null;
    this._dirty = false;
  }

  get title() {
    const title = this.options.window.title;
    return this._dirty ? `${title} (unsaved)` : title;
  }

  /** Switch to an entry's tab and select it. Before the library has been read, the id is kept until it is. */
  showEntry(id) {
    const entry = this._entries?.find(candidate => candidate.id === id) ?? null;
    if (!entry) {
      this._pendingId = id;
      return;
    }
    this._activeTab = entry.isDefault ? 'default' : 'personal';
    this._selectedId = id;
    this._pendingId = null;
  }

  /** Re-read the world library unless unsaved work is open. */
  async reload() {
    if (this._dirty) return;
    this._entries = null;
    if (this.rendered) await this.render(false);
  }

  async close(options = {}) {
    if (this._dirty && !options.force) {
      const discard = await DialogV2.confirm({
        window: { title: 'Discard changes?' },
        content: `<p>The ${this.options.window.title} has unsaved changes. Close without saving?</p>`,
        rejectClose: false,
        modal: true
      });
      if (!discard) return this;
    }
    if (openLibraries.get(this.constructor) === this) openLibraries.delete(this.constructor);
    return super.close(options);
  }

  /* -------------------------------------------- */
  /*  Render context                              */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { noun, tabs, addTooltip } = this.constructor.LIBRARY;
    const list = `${noun}s`;
    if (!this._entries) {
      const view = await this._inspectLibrary();
      this._entries = (view?.[list] ?? []).map(entry => structuredClone(entry));
      this._builtins = (view?.builtins ?? []).map(entry => structuredClone(entry));
      this._readView(view);
      this._readOnly = view?.canEdit !== true;
      if (this._pendingId) this.showEntry(this._pendingId);
    }
    const tab = tabs[this._activeTab] ?? tabs.default;
    const tabEntries = this._entries.filter(entry => entry.isDefault === tab.isDefault);
    let selected = this._entries.find(entry => entry.id === this._selectedId) ?? null;
    if (selected && selected.isDefault !== tab.isDefault) selected = null;
    if (!selected && tabEntries.length && !this._selectedId) selected = tabEntries[0];
    this._selectedId = selected?.id ?? null;
    return Object.assign(context, {
      readOnly: this._readOnly,
      tabs: Object.entries(tabs).map(([key, entry]) => ({ key, ...entry, active: key === this._activeTab })),
      tab: { key: this._activeTab, ...tab },
      isPersonalTab: this._activeTab === 'personal',
      addTooltip: getTooltip(addTooltip, { tab: tab.label }),
      [list]: tabEntries.map(entry => ({
        id: entry.id,
        name: entry.name || `Unnamed ${noun}`,
        img: entry.img,
        dc: entry.dc,
        ...this._rowFields(entry),
        draggable: !entry.isDefault && !this._readOnly,
        selected: entry.id === this._selectedId
      })),
      [`has${capitalized(noun)}s`]: tabEntries.length > 0,
      selected,
      ...this._detailContext(selected),
      canRestore: !this._readOnly && this._activeTab === 'default'
        && missingBuiltins(this._entries, this._builtins).length > 0,
      dirty: this._dirty
    });
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    const { noun, rowClass, dragType, normalize } = this.constructor.LIBRARY;
    const selected = this._entries?.find(entry => entry.id === this._selectedId) ?? null;
    for (const row of root.querySelectorAll(`.${rowClass}[draggable="true"]`)) {
      row.addEventListener('dragstart', event => {
        event.dataTransfer.setData('text/plain', JSON.stringify({ type: dragType, [`${noun}Id`]: row.dataset.id }));
        event.dataTransfer.effectAllowed = 'all';
      });
    }
    if (!selected || this._readOnly) return;
    const byName = name => root.querySelector(`[name='${name}']`);
    const row = selector => root.querySelector(`.${rowClass}[data-id='${selected.id}'] ${selector}`);
    const markDirty = () => {
      if (this._dirty) return;
      this._dirty = true;
      const title = root.querySelector('.window-title');
      if (title) title.textContent = this.title;
    };
    byName('name')?.addEventListener('input', event => {
      selected.name = event.target.value;
      const label = row(`.${rowClass}-name`);
      if (label) label.textContent = selected.name || `Unnamed ${noun}`;
      markDirty();
    });
    byName('description')?.addEventListener('input', event => {
      selected.description = event.target.value;
      markDirty();
    });
    byName('dc')?.addEventListener('change', event => {
      selected.dc = normalize({ ...selected, dc: event.target.value }, selected.id).dc;
      event.target.value = selected.dc;
      const tag = row(`.${rowClass}-dc`);
      if (tag) tag.textContent = `DC ${selected.dc}`;
      markDirty();
    });
    this._wireDetail({ root, selected, byName, row, markDirty });
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */
  static setTab(_event, target) {
    const key = String(target.dataset.tab ?? '');
    if (!this.constructor.LIBRARY.tabs[key] || key === this._activeTab) return;
    this._activeTab = key;
    this._selectedId = null;
    this.render(false);
  }

  static selectEntry(_event, target) {
    const id = String(target.closest('[data-id]')?.dataset.id ?? '');
    if (!id || id === this._selectedId) return;
    this._selectedId = id;
    this.render(false);
  }

  static addEntry() {
    if (this._readOnly) return;
    const { noun, tabs, create } = this.constructor.LIBRARY;
    const entry = create(foundry.utils.randomID(), tabs[this._activeTab].isDefault);
    entry.name = `New ${capitalized(noun)}`;
    this._entries.push(entry);
    this._selectedId = entry.id;
    this._dirty = true;
    this.render(false);
  }

  static async deleteEntry() {
    if (this._readOnly) return;
    const selected = this._entries.find(entry => entry.id === this._selectedId) ?? null;
    if (!selected) return;
    const { noun } = this.constructor.LIBRARY;
    const restorable = selected.builtin ? ` Built-in ${noun}s can be restored from the Default tab.` : '';
    const ok = await DialogV2.confirm({
      window: { title: `Delete ${noun}?` },
      content: `<p>Remove <strong>${escapeHtml(selected.name || `this ${noun}`)}</strong> from the library? `
        + `Units linked to it will simply forget it.${restorable}</p>`,
      rejectClose: false,
      modal: true
    });
    if (!ok) return;
    this._entries.splice(this._entries.indexOf(selected), 1);
    this._selectedId = null;
    this._dirty = true;
    this.render(false);
  }

  static moveEntry() {
    if (this._readOnly) return;
    const selected = this._entries.find(entry => entry.id === this._selectedId) ?? null;
    if (!selected) return;
    selected.isDefault = !selected.isDefault;
    this._activeTab = selected.isDefault ? 'default' : 'personal';
    this._dirty = true;
    this.render(false);
  }

  /** Put back every built-in entry the world has removed, at the front of the list, and mark the window unsaved. */
  static restoreBuiltins() {
    if (this._readOnly) return;
    const restored = withBuiltinsRestored(this._entries, this._builtins, this.constructor.LIBRARY.normalize);
    if (restored !== this._entries) {
      this._entries = restored;
      this._dirty = true;
      this._activeTab = 'default';
      this._selectedId = this._entries[0]?.id ?? null;
    }
    this.render(false);
  }

  static pickImage() {
    if (this._readOnly) return;
    const selected = this._entries.find(entry => entry.id === this._selectedId) ?? null;
    if (!selected) return;
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: 'image',
      current: selected.img,
      callback: path => {
        selected.img = path;
        this._dirty = true;
        this.render(false);
      }
    });
    picker.browse();
  }

  /** Send the whole library through the subclass's save command, which surfaces the result. */
  static async save() {
    if (this._readOnly) return;
    const { normalize } = this.constructor.LIBRARY;
    const entries = this._entries.map(entry => normalize(entry, entry.id));
    const result = await this._saveLibrary(entries);
    if (result?.ok !== true) return;
    this._entries = entries;
    this._dirty = false;
    this.render(false);
  }

  static async cancel() {
    await this.close();
  }

  /* -------------------------------------------- */
  /*  Optional library parts                      */
  /* -------------------------------------------- */
  /** Keep anything else the subclass needs from the library view. */
  _readView(_view) {}

  /** Extra fields for one entry's row in the list. */
  _rowFields(_entry) {
    return {};
  }
}

function capitalized(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
