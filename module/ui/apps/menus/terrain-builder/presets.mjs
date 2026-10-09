/** @layer ui/apps/menus/terrain-builder */
import { escapeHtml } from '../../../../lib/dom/html.mjs';
import {
  deleteCustomTerrainPreset,
  readCustomTerrainPresets,
  readDefaultTerrainPresets,
  saveCustomTerrainPreset
} from '../../../../foundry/adapters/services/json-files.mjs';
import { SYSTEM_ID } from '../../../../contracts/protocol.mjs';
import { createTerrainNotifier } from '../../../../presentation/interface/notifications.mjs';
import { FoundryDiagnostics } from '../../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Preset pickers                              */
/* -------------------------------------------- */
const FALLBACK_ICON = 'icons/svg/hazard.svg';
const notifications = createTerrainNotifier({ diagnostics: new FoundryDiagnostics() });

/**
 * Show the preset picker and return a copy of the chosen preset's field values, or null if nothing was loaded.
 * Shipped presets come from the system's `json/terrain.json`, custom ones from the world's own `json/terrain.json`.
 * A custom preset with the same name as a shipped one is hidden.
 */
export async function openLoadTerrainPresetDialog() {
  const shipped = await readDefaultTerrainPresets();
  const defaults = shipped.presets ?? [];
  const defaultNames = new Set(defaults.map(preset => preset.name));
  const custom = (await readCustomTerrainPresets()).filter(preset => !defaultNames.has(preset.name));
  const entries = [
    ...defaults.map(preset => ({ ...preset, key: `default:${preset.name}`, custom: false })),
    ...custom.map(preset => ({ ...preset, key: `custom:${preset.name}`, custom: true }))
  ];
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: 'Load Terrain Preset', icon: 'fas fa-folder-open' },
    classes: [SYSTEM_ID, 'emblem-terrain-preset-dialog'],
    position: { width: 460 },
    content: presetPickerMarkup(defaults, custom),
    buttons: [
      {
        // Returns the selected cell's key; with nothing selected the dialog resolves to 'load', which loads nothing.
        action: 'load', label: 'Load', icon: 'fas fa-folder-open', default: true,
        callback: (_event, _button, dialog) => dialog.element.querySelector('.tpp-cell.is-selected')?.dataset.key ?? null
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-xmark' }
    ],
    render: (_event, dialog) => wirePresetPicker(dialog.element)
  });
  const preset = byKey.get(result);
  return preset ? structuredClone(preset.params) : null;
}

/**
 * Ask for a name and icon, then save `params` (the terrain form's values) to the world's `json/terrain.json`.
 * Saving under an existing custom name replaces that preset without asking; shipped names are refused.
 * @returns {Promise<boolean>} Whether the preset was saved.
 */
export async function openSaveTerrainPresetDialog(params) {
  const shipped = await readDefaultTerrainPresets();
  const defaultNames = new Set((shipped.presets ?? []).map(preset => preset.name));
  const custom = (await readCustomTerrainPresets()).filter(preset => !defaultNames.has(preset.name));
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: 'Save Terrain Preset', icon: 'fas fa-bookmark' },
    classes: [SYSTEM_ID, 'emblem-terrain-preset-dialog'],
    position: { width: 460 },
    content: savePresetMarkup(custom),
    buttons: [
      {
        action: 'save', label: 'Save Preset', icon: 'fas fa-bookmark', default: true,
        callback: (_event, _button, dialog) => readSavePresetForm(dialog.element)
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-xmark' }
    ],
    render: (_event, dialog) => wireSavePreset(dialog.element, custom)
  });
  // Cancel, closing the window, or a blank name gives an action name or null instead of `{ name, icon }`.
  if (!result?.name) return false;
  if (defaultNames.has(result.name)) {
    notifications.warn(`Choose a name other than the built-in "${result.name}".`);
    return false;
  }
  if (!await saveCustomTerrainPreset(result.name, result.icon, params)) return false;
  notifications.info(`Saved Terrain preset "${result.name}".`);
  return true;
}

/* -------------------------------------------- */
/*  Picker interaction                          */
/* -------------------------------------------- */
/** Clicking a cell in the Load dialog selects it. */
function wirePresetPicker(root) {
  root.querySelectorAll('.tpp-cell[data-key]').forEach(cell => {
    cell.addEventListener('click', () => {
      root.querySelectorAll('.tpp-cell').forEach(entry => entry.classList.remove('is-selected'));
      cell.classList.add('is-selected');
    });
  });
  wireDeleteButtons(root);
}

/** Clicking a custom preset in the Save dialog copies its name and icon into the form, ready to overwrite it. */
function wireSavePreset(root, custom) {
  const byName = new Map(custom.map(preset => [preset.name, preset]));
  root.querySelectorAll('.tpp-cell[data-name]').forEach(cell => {
    cell.addEventListener('click', event => {
      if (event.target.closest('.tpp-del')) return;
      root.querySelector('[name="presetName"]').value = cell.dataset.name;
      const icon = byName.get(cell.dataset.name)?.icon ?? FALLBACK_ICON;
      root.querySelector('[name="presetIcon"]').value = icon;
      root.querySelector('.tps-icon-preview').src = icon;
    });
  });
  wireDeleteButtons(root);
  root.querySelector('.tps-pick-icon')?.addEventListener('click', () => {
    const input = root.querySelector('[name="presetIcon"]');
    const preview = root.querySelector('.tps-icon-preview');
    new foundry.applications.apps.FilePicker.implementation({
      type: 'image',
      current: input.value || 'icons/svg/',
      callback: path => {
        input.value = path;
        preview.src = path;
      }
    }).render(true);
  });
}

/** Each delete button confirms, removes the preset from the world's file, then blanks its cell in place. */
function wireDeleteButtons(root) {
  root.querySelectorAll('.tpp-del').forEach(button => {
    button.addEventListener('click', async event => {
      // Keep the click from also selecting the cell.
      event.stopPropagation();
      const name = button.dataset.name;
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: 'Delete Preset', icon: 'fas fa-trash' },
        content: `<p>Delete the saved preset "<strong>${escapeHtml(name)}</strong>"? This cannot be undone.</p>`,
        modal: true,
        rejectClose: false
      });
      if (!confirmed || !await deleteCustomTerrainPreset(name)) return;
      const cell = button.closest('.tpp-cell');
      cell.className = 'tpp-cell tpp-empty';
      cell.replaceChildren();
      delete cell.dataset.key;
      delete cell.dataset.name;
    });
  });
}

/* -------------------------------------------- */
/*  Picker markup                               */
/* -------------------------------------------- */
function presetPickerMarkup(defaults, custom) {
  return `<div class="terrain-preset-picker">
    <div class="tpp-section"><div class="tpp-section-title">Default Presets</div>
      ${presetGridMarkup(defaults, 'default', false)}</div>
    <div class="tpp-section"><div class="tpp-section-title">Custom Presets</div>
      ${presetGridMarkup(custom, 'custom', true)}</div>
  </div>`;
}

function savePresetMarkup(custom) {
  return `<div class="terrain-preset-save">
    ${presetGridMarkup(custom, 'custom', true)}
    <div class="tps-form">
      <label class="tps-name"><span>Name</span><input type="text" name="presetName" autocomplete="off"></label>
      <div class="tps-icon"><img class="tps-icon-preview" src="${FALLBACK_ICON}" alt="">
        <input type="hidden" name="presetIcon" value="${FALLBACK_ICON}">
        <button type="button" class="tps-pick-icon">Choose Icon</button></div>
    </div>
  </div>`;
}

/**
 * A grid of preset cells, padded with empty cells to at least 16 and to a full row of four.
 * @param {string} kind 'default' or 'custom'; it prefixes each cell's `data-key`.
 */
function presetGridMarkup(presets, kind, deletable) {
  const slotCount = Math.max(16, Math.ceil(presets.length / 4) * 4);
  const cells = [];
  for (let index = 0; index < slotCount; index += 1) {
    const preset = presets[index];
    if (!preset) {
      cells.push('<div class="tpp-cell tpp-empty"></div>');
      continue;
    }
    const name = escapeHtml(preset.name);
    cells.push(`<div class="tpp-cell" data-key="${kind}:${name}" data-name="${name}" data-tooltip="${name}">
      <img class="tpp-icon" src="${escapeHtml(preset.icon || FALLBACK_ICON)}" alt="">
      <span class="tpp-name">${name}</span>
      ${deletable ? `<button type="button" class="tpp-del" data-name="${name}" data-tooltip="Delete preset">&times;</button>` : ''}
    </div>`);
  }
  return `<div class="tpp-grid" data-kind="${kind}">${cells.join('')}</div>`;
}

/** Read the Save dialog's name and icon, or warn and return null when the name is blank (the dialog still closes). */
function readSavePresetForm(root) {
  const name = root.querySelector('[name="presetName"]')?.value?.trim();
  if (!name) {
    notifications.warn('Enter a preset name.');
    return null;
  }
  return {
    name,
    icon: root.querySelector('[name="presetIcon"]')?.value || FALLBACK_ICON
  };
}

