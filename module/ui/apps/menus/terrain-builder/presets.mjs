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

/** Pick a shipped or world terrain preset and return a detached parameter object. */
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

/** Save the current terrain form as a named world preset. */
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
function wirePresetPicker(root) {
  root.querySelectorAll('.tpp-cell[data-key]').forEach(cell => {
    cell.addEventListener('click', () => {
      root.querySelectorAll('.tpp-cell').forEach(entry => entry.classList.remove('is-selected'));
      cell.classList.add('is-selected');
    });
  });
  wireDeleteButtons(root);
}

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

function wireDeleteButtons(root) {
  root.querySelectorAll('.tpp-del').forEach(button => {
    button.addEventListener('click', async event => {
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

