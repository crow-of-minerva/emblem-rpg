/** @layer ui/apps/menus/terrain-builder */
import {
  EXCEPTION_FACTIONS,
  EXCEPTION_SELECTORS,
  SPAWN_BEHAVIORS,
  SPAWN_BEHAVIOR_FACTIONS,
  SPAWN_BEHAVIOR_VALUES,
  TERRAIN_UNIT_TYPES,
  TILE_EFFECT_TYPES
} from '../../../../contracts/domains/terrain.mjs';
import { sanitizeException, sanitizeTileEffect, tileEffectIsActive } from '../../../../game/terrain/rules.mjs';
import { capitalize } from '../../../../lib/dom/html.mjs';

/**
 * The header classes every row list shares. All three lists reuse the spawn row's header markup, so one set of CSS
 * rules styles them.
 */
const TITLE_CLASS = 'terrain-spawn-title';
const DELETE_CLASS = 'terrain-spawn-del';

/* -------------------------------------------- */
/*  Spawn arrays                                */
/* -------------------------------------------- */

/**
 * Normalise one spawn array.
 *
 * An end round of zero means "no end", which is why it is passed through untouched. Any other value is pulled up to
 * the start round, so a spawn window can never come out inverted and silently spawn nothing.
 * @param {object} raw            Spawn data as typed or saved.
 * @returns {object}
 */
export function sanitizeTerrainSpawn(raw) {
  const start = Math.max(0, Math.floor(Number(raw?.startRound) || 0));
  const rawEnd = Math.max(0, Math.floor(Number(raw?.endRound) || 0));
  return {
    uuid: String(raw?.uuid ?? '').trim(),
    startRound: start,
    endRound: rawEnd === 0 ? 0 : Math.max(rawEnd, start),
    cooldown: Math.max(0, Math.floor(Number(raw?.cooldown) || 0)),
    blockable: !!raw?.blockable,
    visible: !!raw?.visible,
    behavior: SPAWN_BEHAVIOR_VALUES.includes(raw?.behavior) ? raw.behavior : ''
  };
}

/** Display label for a tile effect type. */
const tileEffectTypeLabel = (type) => (type === 'healing' ? 'Healing' : capitalize(type));

/* -------------------------------------------- */
/*  Row specs                                   */
/* -------------------------------------------- */

/**
 * What one repeated list in the Selection trays holds.
 *
 * `TerrainRowEditor` does what every list shares (building, adding, removing, renumbering and reading rows), and
 * each row spec supplies only what differs:
 * - `listSelector`, `rowSelector` and `rowClass` place the rows in `templates/editors/terrain-builder.hbs`.
 * - `markup` builds one row's HTML and `hydrate` fills its controls from a saved entry. `styles/emblem-rpg.css`
 *   styles their classes.
 * - `read` collects a row's controls and `sanitize` normalises them, which is also how a saved list is normalised.
 * - `isActive` decides whether a row carries anything. Inactive rows are dropped on read; exception and tile effect
 *   rows are also marked invalid.
 * - `label` titles a row and `decorate` adjusts it for its own contents. `renumberRow` replaces the title and the
 *   invalid mark for a row that titles itself later, as a spawn row does from its Actor.
 * - `changeClasses` name the controls whose edits retitle the row.
 * - `wire(row, context)` adds the row's own listeners once it is built; `context` holds `renumber` and `hooks`.
 * @typedef {object} TerrainRowSpec
 */
export const TERRAIN_ROW_SPECS = Object.freeze({
  /* -------------------------------------------- */
  spawns: Object.freeze({
    listSelector: '.terrain-spawn-list',
    rowSelector: '.terrain-spawn-list > .terrain-spawn-row',
    rowClass: 'terrain-spawn-row',
    changeClasses: Object.freeze([]),
    sanitize: sanitizeTerrainSpawn,
    isActive: (entry) => !!entry.uuid,
    label: (entry, index) => `Array ${index + 1}`,

    markup: () => `
      <div class="terrain-spawn-rowhead">
        <button type="button" class="terrain-spawn-collapse" data-tooltip="Collapse"><i class="fas fa-chevron-down"></i></button>
        <span class="terrain-spawn-title">Array</span>
        <button type="button" class="terrain-spawn-del" data-tooltip="Remove this spawn array"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="terrain-spawn-body">
        <label class="terrain-field terrain-field--grow">
          <span class="ed-label">Actor UUID</span>
          <input class="ed-input terrain-spawn-uuid" type="text" autocomplete="off" spellcheck="false"
            placeholder="e.g. Actor.AbCd1234 or Compendium.pack.Actor.AbCd1234" />
        </label>
        <div class="terrain-field-row">
          <label class="terrain-field">
            <span class="ed-label">Start Round</span>
            <input class="ed-input terrain-spawn-start" type="number" min="0" max="999" />
          </label>
          <label class="terrain-field">
            <span class="ed-label">End Round</span>
            <input class="ed-input terrain-spawn-end" type="number" min="0" max="999" />
          </label>
        </div>
        <div class="terrain-field-row">
          <label class="terrain-field">
            <span class="ed-label">Cooldown Rounds</span>
            <input class="ed-input terrain-spawn-cd" type="number" min="0" max="999" />
          </label>
          <label class="terrain-toggle terrain-spawn-blockable">
            <input type="checkbox" class="terrain-spawn-block" /><span>Blockable?</span>
          </label>
        </div>
        <div class="terrain-field-row">
          <label class="terrain-toggle terrain-spawn-visibility">
            <input type="checkbox" class="terrain-spawn-visible" /><span>Show to Players?</span>
          </label>
        </div>
        <label class="terrain-field terrain-field--grow">
          <span class="ed-label">Spawned Unit Behavior</span>
          <select class="ed-input terrain-spawn-behavior">
            ${SPAWN_BEHAVIORS.map(b => `<option value="${b.value}">${b.label}</option>`).join('')}
          </select>
        </label>
      </div>`,

    hydrate(row, entry) {
      const cell = (cls) => row.querySelector(`.${cls}`);
      cell('terrain-spawn-uuid').value = entry.uuid;
      cell('terrain-spawn-start').value = entry.startRound;
      cell('terrain-spawn-end').value = entry.endRound;
      cell('terrain-spawn-cd').value = entry.cooldown;
      cell('terrain-spawn-block').checked = entry.blockable;
      cell('terrain-spawn-visible').checked = entry.visible;
      cell('terrain-spawn-behavior').value = entry.behavior;
    },

    read: (row) => ({
      uuid: row.querySelector('.terrain-spawn-uuid')?.value,
      startRound: Number(row.querySelector('.terrain-spawn-start')?.value),
      endRound: Number(row.querySelector('.terrain-spawn-end')?.value),
      cooldown: Number(row.querySelector('.terrain-spawn-cd')?.value),
      blockable: row.querySelector('.terrain-spawn-block')?.checked,
      visible: row.querySelector('.terrain-spawn-visible')?.checked,
      behavior: row.querySelector('.terrain-spawn-behavior')?.value
    }),

    /** The collapse button, keeping End Round at or after Start Round, and the Actor lookup. */
    wire(row, { hooks }) {
      const cell = (cls) => row.querySelector(`.${cls}`);
      cell('terrain-spawn-collapse').addEventListener('click', () => row.classList.toggle('is-collapsed'));

      const start = cell('terrain-spawn-start');
      const end = cell('terrain-spawn-end');
      const clampEnd = () => {
        const authoredEnd = Number(end.value) || 0;
        const authoredStart = Number(start.value) || 0;
        if (authoredEnd !== 0 && authoredEnd < authoredStart) end.value = authoredStart;
      };
      start.addEventListener('change', clampEnd);
      end.addEventListener('change', clampEnd);

      cell('terrain-spawn-uuid').addEventListener('change', () => void resolveSpawnRow(row, hooks));
      void resolveSpawnRow(row, hooks);
    },

    /** A spawn row is titled by its Actor, so renumbering only updates the fallback title and looks it up again. */
    renumberRow(row, label, { hooks }) {
      row.dataset.spawnLabel = label;
      void resolveSpawnRow(row, hooks);
    }
  }),

  /* -------------------------------------------- */
  exceptions: Object.freeze({
    listSelector: '.terrain-exception-list',
    rowSelector: '.terrain-exception-row',
    rowClass: 'terrain-spawn-row terrain-exception-row',
    changeClasses: Object.freeze(['terrain-exc-unit', 'terrain-exc-faction', 'terrain-exc-text']),
    sanitize: sanitizeException,
    isActive: (entry) => !!entry.value,

    label(entry, index) {
      const selectorLabel = EXCEPTION_SELECTORS.find(option => option.value === entry.selector)?.label ?? 'Exception';
      const shown = entry.selector === 'unitType' || entry.selector === 'faction'
        ? capitalize(entry.value)
        : entry.value;
      return shown ? `${selectorLabel}: ${shown}` : `Exception ${index + 1}`;
    },

    markup(entry) {
      const unitTypes = TERRAIN_UNIT_TYPES.map(value => ({ value, label: capitalize(value) }));
      const selectors = optionRow(EXCEPTION_SELECTORS, entry.selector);
      const units = optionRow(unitTypes, entry.selector === 'unitType' ? entry.value : '');
      const factions = optionRow(EXCEPTION_FACTIONS, entry.selector === 'faction' ? entry.value : '');
      return `
      <div class="terrain-spawn-rowhead">
        <span class="terrain-spawn-title">Exception</span>
        <button type="button" class="terrain-spawn-del" data-tooltip="Remove this exception"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="terrain-spawn-body">
        <div class="terrain-field-row">
          <label class="terrain-field terrain-field--grow">
            <span class="ed-label">Match By</span>
            <select class="ed-input terrain-exc-selector">${selectors}</select>
          </label>
        </div>
        <div class="terrain-field-row terrain-exc-value-row">
          <label class="terrain-field terrain-field--grow">
            <span class="ed-label terrain-exc-value-label">Value</span>
            <select class="ed-input terrain-exc-unit">${units}</select>
            <select class="ed-input terrain-exc-faction">${factions}</select>
            <input class="ed-input terrain-exc-text" type="text" autocomplete="off" spellcheck="false" />
          </label>
        </div>
        <div class="terrain-toggles terrain-exc-sync">
          <span class="ed-label terrain-exc-sync-label">Sync</span>
          <label class="terrain-toggle"><input type="checkbox" class="terrain-exc-move" /><span>Move Cost</span></label>
          <label class="terrain-toggle"><input type="checkbox" class="terrain-exc-effect" /><span>Tile Effect</span></label>
        </div>
      </div>`;
    },

    hydrate(row, entry) {
      const typed = entry.selector === 'name' || entry.selector === 'actorId';
      if (typed) row.querySelector('.terrain-exc-text').value = entry.value;
      row.querySelector('.terrain-exc-move').checked = entry.syncMove;
      row.querySelector('.terrain-exc-effect').checked = entry.syncEffect;
    },

    read(row) {
      const selector = row.querySelector('.terrain-exc-selector')?.value ?? 'unitType';
      const value = selector === 'unitType' ? row.querySelector('.terrain-exc-unit')?.value
        : selector === 'faction' ? row.querySelector('.terrain-exc-faction')?.value
        : row.querySelector('.terrain-exc-text')?.value;
      return {
        selector,
        value,
        syncMove: row.querySelector('.terrain-exc-move')?.checked,
        syncEffect: row.querySelector('.terrain-exc-effect')?.checked
      };
    },

    wire(row, { renumber }) {
      row.querySelector('.terrain-exc-selector').addEventListener('change', () => syncExceptionRow(row, renumber));
      syncExceptionRow(row, renumber);
    }
  }),

  /* -------------------------------------------- */
  tileEffects: Object.freeze({
    listSelector: '.terrain-tile-effect-list',
    rowSelector: '.terrain-tile-effect-row',
    rowClass: 'terrain-spawn-row terrain-tile-effect-row',
    changeClasses: Object.freeze(['terrain-te-type', 'terrain-te-value', 'terrain-te-stn', 'terrain-te-kill']),
    sanitize: sanitizeTileEffect,
    isActive: tileEffectIsActive,

    label(entry, index) {
      if (!tileEffectIsActive(entry)) return `Effect ${index + 1}`;
      return entry.type === 'healing'
        ? `Healing ${entry.value}${entry.stn ? ` | ${entry.stn} Stn` : ''}`
        : `${tileEffectTypeLabel(entry.type)} ${entry.value}${entry.canKillPlayer ? ' | Lethal' : ''}`;
    },

    markup(entry) {
      const types = TILE_EFFECT_TYPES.map(type => ({ value: type, label: tileEffectTypeLabel(type) }));
      return `
      <div class="terrain-spawn-rowhead">
        <span class="terrain-spawn-title">Effect</span>
        <button type="button" class="terrain-spawn-del" data-tooltip="Remove this effect array"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="terrain-spawn-body">
        <div class="terrain-field-row">
          <label class="terrain-field terrain-field--grow">
            <span class="ed-label">Type</span>
            <select class="ed-input terrain-te-type">${optionRow(types, entry.type)}</select>
          </label>
          <label class="terrain-field">
            <span class="ed-label">Value</span>
            <input class="ed-input terrain-te-value" type="number" min="0" max="999" />
          </label>
          <label class="terrain-field terrain-te-stn-field">
            <span class="ed-label">Stn</span>
            <input class="ed-input terrain-te-stn" type="number" min="0" max="99" />
          </label>
        </div>
        <label class="terrain-toggle terrain-te-kill-field"
          data-tooltip="Whether this damage can reduce a Lord or Retainer to 0 HP">
          <input type="checkbox" class="terrain-te-kill" /><span>Can Kill PC</span>
        </label>
      </div>`;
    },

    hydrate(row, entry) {
      row.querySelector('.terrain-te-value').value = entry.value;
      row.querySelector('.terrain-te-stn').value = entry.stn ?? 0;
      row.querySelector('.terrain-te-kill').checked = entry.canKillPlayer === true;
    },

    read: (row) => ({
      type: row.querySelector('.terrain-te-type')?.value,
      value: row.querySelector('.terrain-te-value')?.value,
      stn: row.querySelector('.terrain-te-stn')?.value,
      canKillPlayer: row.querySelector('.terrain-te-kill')?.checked === true
    }),

    /** The stance field applies only to healing, and the lethality toggle only to damage. */
    decorate(row, entry) {
      const healing = entry.type === 'healing';
      const stanceField = row.querySelector('.terrain-te-stn-field');
      if (stanceField) stanceField.style.display = healing ? '' : 'none';
      const killField = row.querySelector('.terrain-te-kill-field');
      if (killField) killField.style.display = healing ? 'none' : '';
    }
  })
});

/* -------------------------------------------- */
/*  Row editor                                  */
/* -------------------------------------------- */

/**
 * One repeated list in the Selection trays.
 *
 * `TerrainBuilder` owns three of these, one per entry of `TERRAIN_ROW_SPECS`. Rows are built and removed in place
 * rather than through a re-render, so adding or removing one never reloads the other trays from the Scene and
 * discards unsaved fields. `readAll` gives the list's value for the per-square form.
 */
export class TerrainRowEditor {
  #spec;
  #root;
  #hooks;

  /**
   * @param {TerrainRowSpec} spec                 One entry of `TERRAIN_ROW_SPECS`.
   * @param {object} options
   * @param {function(): HTMLElement|null} options.root   The builder's current element, re-read on every call.
   * @param {object} [options.hooks]              Foundry lookups a row spec needs, such as the spawn Actor resolver.
   */
  constructor(spec, { root, hooks = {} }) {
    this.#spec = spec;
    this.#root = root;
    this.#hooks = hooks;
  }

  /** Rebuild the list from stored entries, which is what a render and a loaded preset both do. */
  render(entries) {
    const list = this.#list();
    if (!list) return;
    list.replaceChildren();
    for (const entry of entries) list.appendChild(this.#node(entry));
    this.renumber();
  }

  /** Append one empty row, for the tray's Add button. */
  add() {
    const list = this.#list();
    if (!list) return;
    list.appendChild(this.#node());
    this.renumber();
  }

  /** Retitle and revalidate every row, so a removal leaves the remaining headers correct rather than stale. */
  renumber() {
    const spec = this.#spec;
    this.#rows().forEach((row, index) => {
      const entry = this.readRow(row);
      const label = spec.label(entry, index);
      spec.decorate?.(row, entry);
      if (spec.renumberRow) {
        spec.renumberRow(row, label, this.#context());
        return;
      }
      row.querySelector(`.${TITLE_CLASS}`).textContent = label;
      row.classList.toggle('is-invalid', !spec.isActive(entry));
    });
  }

  /** One row's normalized entry. */
  readRow(row) {
    return this.#spec.sanitize(this.#spec.read(row));
  }

  /** Every row that carries something, in list order. */
  readAll() {
    return this.#rows().map(row => this.readRow(row)).filter(entry => this.#spec.isActive(entry));
  }

  /* -------------------------------------------- */

  #list() {
    return this.#root()?.querySelector(this.#spec.listSelector) ?? null;
  }

  #rows() {
    return [...(this.#root()?.querySelectorAll(this.#spec.rowSelector) ?? [])];
  }

  #context() {
    return { renumber: () => this.renumber(), hooks: this.#hooks };
  }

  /** Build one row: its markup, its saved values, the shared delete and retitle wiring, then the row spec's `wire`. */
  #node(data = {}) {
    const spec = this.#spec;
    const entry = spec.sanitize(data);
    const row = document.createElement('div');
    row.className = spec.rowClass;
    row.innerHTML = spec.markup(entry);
    spec.hydrate(row, entry);

    row.querySelector(`.${DELETE_CLASS}`).addEventListener('click', () => {
      row.remove();
      this.renumber();
    });
    for (const cls of spec.changeClasses) {
      row.querySelector(`.${cls}`).addEventListener('change', () => this.renumber());
    }
    spec.wire?.(row, this.#context());
    return row;
  }
}

/* -------------------------------------------- */
/*  Row helpers                                 */
/* -------------------------------------------- */

/** The `<option>` markup of one row select. */
function optionRow(entries, selected) {
  return entries.map(option =>
    `<option value="${option.value}"${option.value === selected ? ' selected' : ''}>${option.label}</option>`).join('');
}

/**
 * Show the value control that fits an exception row's selector: the unit-type select, the faction select, or the
 * text box for a name or Actor UUID. The other two stay hidden, and the value label and the text box's placeholder
 * follow the selector too.
 * @param {HTMLElement} row       Exception row.
 * @param {function(): void} renumber   The owning editor's renumber.
 */
function syncExceptionRow(row, renumber) {
  const selector = row.querySelector('.terrain-exc-selector').value;
  const show = (cls, on) => { row.querySelector(`.${cls}`).style.display = on ? '' : 'none'; };
  show('terrain-exc-unit', selector === 'unitType');
  show('terrain-exc-faction', selector === 'faction');
  show('terrain-exc-text', selector === 'name' || selector === 'actorId');

  const text = row.querySelector('.terrain-exc-text');
  text.placeholder = selector === 'actorId' ? 'e.g. Actor.AbCd1234' : 'Exact unit name';
  row.querySelector('.terrain-exc-value-label').textContent =
    { unitType: 'Unit Type', faction: 'Faction', name: 'Name', actorId: 'Actor UUID' }[selector] ?? 'Value';
  renumber();
}

/**
 * Look up a spawn row's Actor to title the row and enable the behavior picker. If the UUID changed during the lookup,
 * the result is dropped.
 * @param {HTMLElement} row               Spawn row.
 * @param {object} hooks                  Supplies `resolveSpawnReference`, which app.mjs passes in.
 * @returns {Promise<void>}
 */
async function resolveSpawnRow(row, hooks) {
  const input = row.querySelector('.terrain-spawn-uuid');
  const title = row.querySelector(`.${TITLE_CLASS}`);
  const behavior = row.querySelector('.terrain-spawn-behavior');
  const uuid = input.value.trim();

  const fallback = row.dataset.spawnLabel || 'Array';
  if (!uuid) {
    row.classList.remove('is-invalid');
    title.textContent = fallback;
    behavior.disabled = true;
    return;
  }

  const actor = await hooks.resolveSpawnReference(uuid);

  if (input.value.trim() !== uuid) return;

  row.classList.toggle('is-invalid', !actor.isActor);
  title.textContent = actor.isActor ? actor.name : `${fallback} (unresolved)`;

  behavior.disabled = !actor.isActor || !SPAWN_BEHAVIOR_FACTIONS.includes(actor.actorType);
  if (behavior.disabled) behavior.value = '';
}
