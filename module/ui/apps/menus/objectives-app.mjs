/** @layer ui/apps/menus */
import { OBJECTIVE_TYPES } from '../../../contracts/domains/combat.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { normalizeObjectiveSpec, roundLimitLocked } from '../../../game/combat/objectives.mjs';
import { readObjectiveConfig } from '../../../foundry/adapters/projections/encounters.mjs';
import { createEncounterNotifier } from '../../../presentation/interface/notifications.mjs';
import { openEditor } from '../../dialogs.mjs';
import { FoundryDiagnostics } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Authoring vocabulary                        */
/* -------------------------------------------- */

const ROUND_LIMIT_TOOLTIP = 'The map ends in failure once this round closes (0 means no limit)';
const ROUND_LIMIT_LOCKED_TOOLTIP =
  'Unused while a Survive or Defend objective is set, because those carry their own turn count';
const ARRIVE_ANY_TOOLTIP = 'On: the first unit of the player side to reach an Arrival Point wins the map';

export const CONDITION_LABELS = Object.freeze({
  defeat: 'Defeat Target(s)',
  rout: 'Rout Enemy',
  survive: 'Survive',
  arrive: 'Arrive',
  defend: 'Defend'
});

/**
 * The three editable reference lists, and how each presents itself.
 *
 * `minRows` is both the floor a list is padded to and the point below which the delete button is
 * disabled, so a list can never be emptied into a state with nothing to type into.
 */
const LISTS = Object.freeze({
  protectedUnits: {
    minRows: 1,
    placeholder: index => `Protected unit ${index + 1}: token or actor ID`
  },
  defeatTargets: {
    minRows: 1,
    placeholder: index => (index === 0
      ? 'Target 1: token or actor ID (required)'
      : `Target ${index + 1}: token or actor ID`)
  },
  arriveUnits: {
    minRows: 1,
    placeholder: index => (index === 0
      ? 'Leave blank to require all unit(s) to arrive'
      : `Unit ${index + 1}: token or actor ID`)
  }
});

/* -------------------------------------------- */
/*  Editable state                              */
/* -------------------------------------------- */

function padList(list, minRows) {
  const values = Array.isArray(list) ? list.map(value => String(value ?? '')) : [];
  while (values.length < minRows) values.push('');
  return values;
}

/**
 * Normalise one saved objective into the shape the form edits.
 *
 * Every branch's fields are built regardless of the objective's type, so switching the type reveals
 * a panel that already has values rather than an empty one.
 */
function buildObjective(source) {
  const data = source && typeof source === 'object' ? source : {};
  return {
    type: OBJECTIVE_TYPES.includes(data.type) ? data.type : 'defeat',
    defeatTargets: padList(data.defeatTargets, LISTS.defeatTargets.minRows),
    routCount: data.routCount == null ? '' : String(data.routCount),
    routIncludeSpawns: data.routIncludeSpawns !== false,
    surviveTurns: Number(data.surviveTurns) > 0 ? Number(data.surviveTurns) : 1,
    arriveUnits: padList(data.arriveUnits, LISTS.arriveUnits.minRows),
    arriveAnyPlayerUnit: data.arriveAnyPlayerUnit === true,
    defendTurns: Number(data.defendTurns) > 0 ? Number(data.defendTurns) : 1
  };
}

/** Build the whole editable state from what the map has stored. */
function buildState(saved) {
  const spec = normalizeObjectiveSpec(saved);
  const objectives = spec.objectives.map(buildObjective);
  if (!objectives.length) objectives.push(buildObjective(null));
  return {
    objectives,
    roundLimit: spec.roundLimit,
    loss: {
      anyLordDefeat: spec.loss.anyLordDefeat,
      protectedUnits: padList(spec.loss.protectedUnits, LISTS.protectedUnits.minRows)
    }
  };
}

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

function rowHtml(value, index, key) {
  const removable = index >= LISTS[key].minRows;
  return `
    <div class="obj-row" data-row-idx="${index}">
      <span class="obj-row-idx">${index + 1}</span>
      <input type="text" class="obj-row-input" value="${escapeHtml(value)}"
             placeholder="${escapeHtml(LISTS[key].placeholder(index))}" />
      <button type="button" class="obj-row-del" data-action="remove-row" data-tooltip="Remove this entry"${removable ? '' : ' disabled'}>
        <i class="fas fa-trash"></i>
      </button>
    </div>`;
}

function listBlockHtml(key, title, addLabel, values, controlHtml = '') {
  return `
    <div class="obj-list-block" data-obj-block="${key}">
      <div class="obj-block-head">
        <span class="obj-block-title">${title}</span>
        ${controlHtml}
        <button type="button" class="obj-add-btn" data-action="add-row" data-obj-add="${key}">
          <i class="fas fa-plus"></i> ${addLabel}
        </button>
      </div>
      <div class="obj-row-list" data-obj-list="${key}">${values.map((value, index) => rowHtml(value, index, key)).join('')}</div>
    </div>`;
}

/**
 * The Arrive card's Any Player Unit switch, in the list header beside the Add button it disables.
 *
 * While it's on, the first player unit to reach an Arrival Point wins, so the required-unit list is dimmed and
 * disabled (applyArriveLocks). Its entries are kept and come back when the switch is turned off.
 */
function arriveAnyToggleHtml(objective) {
  return `
    <label class="obj-check obj-arrive-any" data-tooltip="${escapeHtml(ARRIVE_ANY_TOOLTIP)}">
      <input type="checkbox" data-obj-field="arriveAnyPlayerUnit"${objective.arriveAnyPlayerUnit ? ' checked' : ''} />
      <span>Any Player Unit</span>
    </label>`;
}

/**
 * One objective card, with every type's panel present and all but the current one hidden, so
 * changing the type is a class toggle rather than a re-render and the values typed into the other
 * branches survive the switch.
 */
function objectiveCardHtml(objective, index, total) {
  const options = OBJECTIVE_TYPES.map(type =>
    `<option value="${type}"${objective.type === type ? ' selected' : ''}>${CONDITION_LABELS[type]}</option>`
  ).join('');
  const hide = type => (objective.type === type ? '' : ' is-hidden');

  return `
    <section class="obj-card" data-obj-idx="${index}">
      <div class="obj-card-head">
        <span class="obj-card-idx">Objective ${index + 1}</span>
        <label class="obj-field obj-field-grow">
          <span>Select Win Condition</span>
          <select data-obj-field="type">${options}</select>
        </label>
        <button type="button" class="obj-card-del" data-action="remove-objective"
                data-tooltip="Remove this objective"${total > 1 ? '' : ' disabled'}>
          <i class="fas fa-trash"></i>
        </button>
      </div>

      <div class="obj-panel${hide('defeat')}" data-obj-panel="defeat">
        ${listBlockHtml('defeatTargets', 'Target IDs', 'Add Target', objective.defeatTargets)}
      </div>

      <div class="obj-panel${hide('rout')}" data-obj-panel="rout">
        <label class="obj-field">
          <span>Enemy Count</span>
          <input type="number" min="1" step="1" data-obj-field="routCount" value="${escapeHtml(objective.routCount)}"
                 placeholder="Leave empty to require all enemies to be routed" />
        </label>
        <label class="obj-check" data-tooltip="On: units that spawn mid-battle must be routed too">
          <input type="checkbox" data-obj-field="routIncludeSpawns"${objective.routIncludeSpawns ? ' checked' : ''} />
          <span>Count spawned reinforcements</span>
        </label>
      </div>

      <div class="obj-panel${hide('survive')}" data-obj-panel="survive">
        <label class="obj-field">
          <span>Turn Count</span>
          <input type="number" min="1" step="1" data-obj-field="surviveTurns"
                 value="${escapeHtml(objective.surviveTurns)}" placeholder="How many turns?" />
        </label>
      </div>

      <div class="obj-panel${hide('arrive')}" data-obj-panel="arrive">
        ${listBlockHtml('arriveUnits', 'Required Unit(s)', 'Add Unit', objective.arriveUnits,
          arriveAnyToggleHtml(objective))}
      </div>

      <div class="obj-panel${hide('defend')}" data-obj-panel="defend">
        <label class="obj-field">
          <span>Turn Count</span>
          <input type="number" min="1" step="1" data-obj-field="defendTurns"
                 value="${escapeHtml(objective.defendTurns)}" />
        </label>
      </div>
    </section>`;
}

/* -------------------------------------------- */
/*  Painting                                    */
/* -------------------------------------------- */

/** Re-render every card from state. Callers sync from the DOM first: this discards the markup. */
function paintObjectives(root, state) {
  const list = root.querySelector('[data-obj-cards]');
  if (!list) return;
  list.innerHTML = state.objectives
    .map((objective, index) => objectiveCardHtml(objective, index, state.objectives.length))
    .join('');
}

function rowListOwner(state, objectiveIndex, key) {
  if (key === 'protectedUnits') return state.loss;
  return objectiveIndex >= 0 ? state.objectives[objectiveIndex] : null;
}

function paintRowList(root, state, objectiveIndex, key) {
  const list = key === 'protectedUnits'
    ? root.querySelector('.obj-loss [data-obj-list="protectedUnits"]')
    : root.querySelector(`.obj-card[data-obj-idx="${objectiveIndex}"] [data-obj-list="${key}"]`);
  const owner = rowListOwner(state, objectiveIndex, key);
  if (!list || !owner) return;
  list.innerHTML = owner[key].map((value, index) => rowHtml(value, index, key)).join('');
}

/**
 * Dim and disable the required-unit list of every card that takes any player unit's arrival.
 *
 * Only the display is locked: the typed references stay in state and in the saved card, so a GM who
 * turns the switch off again finds the list exactly as it was.
 */
function applyArriveLocks(root, state) {
  for (const card of root.querySelectorAll('.obj-card')) {
    const block = card.querySelector('[data-obj-block="arriveUnits"]');
    if (!block) continue;
    const locked = state.objectives[Number(card.dataset.objIdx)]?.arriveAnyPlayerUnit === true;
    block.classList.toggle('is-locked', locked);
    for (const control of block.querySelectorAll('.obj-row-input, .obj-add-btn')) control.disabled = locked;
    for (const remove of block.querySelectorAll('.obj-row-del')) {
      const index = Number(remove.closest('.obj-row')?.dataset.rowIdx);
      remove.disabled = locked || !(index >= LISTS.arriveUnits.minRows);
    }
  }
}

/** Enable or disable the round limit, and swap its tooltip for the one that says why. */
function applyRoundLimitLock(root, state) {
  const locked = roundLimitLocked(state.objectives);
  const input = root.querySelector('[data-obj-field="roundLimit"]');
  if (input) input.disabled = locked;
  const field = root.querySelector('.obj-round-limit');
  if (!field) return;
  field.classList.toggle('is-locked', locked);
  field.dataset.tooltip = locked ? ROUND_LIMIT_LOCKED_TOOLTIP : ROUND_LIMIT_TOOLTIP;
}

/* -------------------------------------------- */
/*  DOM sync                                    */
/* -------------------------------------------- */

/**
 * Copy every field back into state before a repaint or a save. The round limit is rounded down here; the other
 * numbers stay as typed until saving, so a half-typed number is not changed under the cursor.
 */
function syncFromDom(root, state) {
  const limit = Math.floor(Number(root.querySelector('[data-obj-field="roundLimit"]')?.value));
  state.roundLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  const loss = root.querySelector('.obj-loss');
  state.loss = {
    anyLordDefeat: Boolean(loss?.querySelector('[data-obj-field="anyLordDefeat"]')?.checked),
    protectedUnits: [...(loss?.querySelectorAll('[data-obj-list="protectedUnits"] .obj-row-input') ?? [])]
      .map(input => input.value)
  };
  state.objectives = [...root.querySelectorAll('.obj-card')].map(card => {
    const field = name => card.querySelector(`[data-obj-field="${name}"]`)?.value ?? '';
    const list = key => [...card.querySelectorAll(`[data-obj-list="${key}"] .obj-row-input`)].map(input => input.value);
    return {
      type: field('type'),
      defeatTargets: list('defeatTargets'),
      routCount: field('routCount'),
      routIncludeSpawns: Boolean(card.querySelector('[data-obj-field="routIncludeSpawns"]')?.checked),
      surviveTurns: field('surviveTurns'),
      arriveUnits: list('arriveUnits'),
      arriveAnyPlayerUnit: Boolean(card.querySelector('[data-obj-field="arriveAnyPlayerUnit"]')?.checked),
      defendTurns: field('defendTurns')
    };
  });
}

function applyCardVisibility(card) {
  const type = card.querySelector('[data-obj-field="type"]')?.value;
  for (const panel of card.querySelectorAll('[data-obj-panel]')) {
    panel.classList.toggle('is-hidden', panel.dataset.objPanel !== type);
  }
}

/* -------------------------------------------- */
/*  Handlers                                    */
/* -------------------------------------------- */

/**
 * Wire the card and row controls, delegated from the dialog body because both are repainted
 * constantly and per-element listeners would go stale on every add or remove.
 */
function attachHandlers(root, state) {
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    const card = button.closest('.obj-card');
    const objectiveIndex = card ? Number(card.dataset.objIdx) : -1;

    switch (button.dataset.action) {
      case 'add-objective': {
        syncFromDom(root, state);
        state.objectives.push(buildObjective(null));
        paintObjectives(root, state);
        applyRoundLimitLock(root, state);
        applyArriveLocks(root, state);
        root.querySelector('.obj-card:last-child')?.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'remove-objective': {
        syncFromDom(root, state);
        state.objectives.splice(objectiveIndex, 1);
        if (!state.objectives.length) state.objectives.push(buildObjective(null));
        paintObjectives(root, state);
        applyRoundLimitLock(root, state);
        applyArriveLocks(root, state);
        break;
      }
      case 'add-row': {
        const key = button.dataset.objAdd;
        if (!LISTS[key]) break;
        syncFromDom(root, state);
        const owner = rowListOwner(state, objectiveIndex, key);
        if (!owner) break;
        owner[key].push('');
        paintRowList(root, state, objectiveIndex, key);
        applyArriveLocks(root, state);
        button.closest('.obj-block-head')?.nextElementSibling
          ?.querySelector('.obj-row:last-child .obj-row-input')?.focus();
        break;
      }
      case 'remove-row': {
        const row = button.closest('.obj-row');
        const key = button.closest('[data-obj-list]')?.dataset.objList;
        if (!row || !LISTS[key]) break;
        syncFromDom(root, state);
        const owner = rowListOwner(state, objectiveIndex, key);
        if (!owner) break;
        const values = owner[key];
        values.splice(Number(row.dataset.rowIdx), 1);
        owner[key] = padList(values, LISTS[key].minRows);
        paintRowList(root, state, objectiveIndex, key);
        applyArriveLocks(root, state);
        break;
      }
    }
  });

  root.addEventListener('change', event => {
    const field = event.target.closest('[data-obj-field]');
    const name = field?.dataset.objField ?? '';
    if (name !== 'type' && name !== 'arriveAnyPlayerUnit') return;
    const card = field.closest('.obj-card');
    if (card && name === 'type') applyCardVisibility(card);
    syncFromDom(root, state);
    applyRoundLimitLock(root, state);
    applyArriveLocks(root, state);
  });
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

function cleanList(list) {
  return list
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

/**
 * Read the form and return what would be saved alongside anything wrong with it. Errors are
 * collected rather than thrown at the first one, so a GM fixes everything in one pass, and a locked
 * round limit is saved as zero rather than as whatever the disabled field still shows.
 */
function collect(root, state) {
  syncFromDom(root, state);
  const errors = [];
  const roundLimit = roundLimitLocked(state.objectives) ? 0 : state.roundLimit;

  const objectives = state.objectives.map((objective, index) => {
    const routCount = objective.routCount.trim();
    const data = {
      type: objective.type,
      defeatTargets: cleanList(objective.defeatTargets),
      routCount: routCount === '' ? null : Number(routCount),
      routIncludeSpawns: objective.routIncludeSpawns,
      surviveTurns: Number(objective.surviveTurns),
      arriveUnits: cleanList(objective.arriveUnits),
      arriveAnyPlayerUnit: objective.arriveAnyPlayerUnit,
      defendTurns: Number(objective.defendTurns)
    };
    const fail = message => errors.push(`Objective ${index + 1}: ${message}`);
    if (data.type === 'defeat' && !data.defeatTargets.length) {
      fail('at least one Target ID must be entered.');
    }
    if (data.type === 'rout' && data.routCount !== null
      && !(Number.isFinite(data.routCount) && data.routCount > 0)) {
      fail('Enemy Count must be a positive number, or left empty.');
    }
    if (data.type === 'survive' && !(Number.isFinite(data.surviveTurns) && data.surviveTurns > 0)) {
      fail('Turn Count must be at least 1.');
    }
    if (data.type === 'defend' && !(Number.isFinite(data.defendTurns) && data.defendTurns > 0)) {
      fail('Turn Count must be at least 1.');
    }
    return data;
  });

  return {
    data: {
      objectives,
      roundLimit,
      loss: {
        anyLordDefeat: state.loss.anyLordDefeat,
        protectedUnits: cleanList(state.loss.protectedUnits)
      }
    },
    errors
  };
}

/* -------------------------------------------- */
/*  Dialog                                      */
/* -------------------------------------------- */

/**
 * Open the GM's editor for a map's win and defeat conditions, from the combat tracker
 * (ui/apps/foundry/combat-tracker.mjs) or the Terrain Builder's Scene settings.
 *
 * Objectives are stored on the scene rather than the encounter, because ending an encounter deletes its document
 * and the map's conditions have to outlive it. The Save button is intercepted rather than given a callback, so a
 * validation failure keeps the dialog open. A save the host refuses keeps it open too, with a notice saying why.
 */
export async function openObjectivesEditor(scene = globalThis.canvas?.scene) {
  if (!globalThis.game?.user?.isGM || !scene) return null;
  const notifier = createEncounterNotifier({ diagnostics: new FoundryDiagnostics() });
  const state = buildState(readObjectiveConfig(scene));

  const content = `
    <div class="ed-container obj-root">
      <div class="obj-loss">
        <div class="obj-loss-head">
          <span class="obj-block-title">Defeat Conditions</span>
          <label class="obj-check" data-tooltip="Any Lord defeated ends the map in failure">
            <input type="checkbox" data-obj-field="anyLordDefeat"${state.loss.anyLordDefeat ? ' checked' : ''} />
            <span>Any Lord defeated</span>
          </label>
        </div>
        <label class="obj-field obj-round-limit" data-tooltip="${escapeHtml(ROUND_LIMIT_TOOLTIP)}">
          <span>Round Limit</span>
          <input type="number" min="0" step="1" data-obj-field="roundLimit" value="${escapeHtml(state.roundLimit)}" />
        </label>
        ${listBlockHtml('protectedUnits', 'Protected Unit(s)', 'Add Unit', state.loss.protectedUnits)}
      </div>
      <div class="obj-card-list" data-obj-cards></div>
      <button type="button" class="ed-btn-add obj-add-objective" data-action="add-objective">
        <i class="fas fa-plus"></i> Add Objective
      </button>
    </div>`;

  let saved = null;
  let saving = false;

  await openEditor({
    title: 'objectives',
    icon: 'fas fa-bullseye',
    width: 540,
    height: 640,
    resizable: true,
    classes: ['dialog-objectives'],
    content,
    wire: (element, _ctx, dialog) => {
      const root = element.querySelector('.obj-root');
      if (!root) return;
      paintObjectives(root, state);
      applyRoundLimitLock(root, state);
      applyArriveLocks(root, state);
      attachHandlers(root, state);

      element.querySelector('button[data-action="save"]')?.addEventListener('click', async event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (saving) return;
        saving = true;
        try {
          const { data, errors } = collect(root, state);
          if (errors.length) {
            notifier.invalid(`Objectives are invalid: ${errors.join(' ')}`);
            return;
          }
          const result = await game.emblemRpg.api.encounters.setObjectives({
            sceneUuid: String(scene.uuid ?? ''),
            ...data
          });
          if (result?.ok === false) return;
          saved = data;
          dialog.close();
        } finally {
          saving = false;
        }
      });
    }
  });

  return saved;
}
