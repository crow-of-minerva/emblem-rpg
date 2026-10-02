/** @layer ui/apps/foundry */
import { ENCOUNTER_TRACK_FLAGS } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { SUPPORTED_GRID_TYPES } from '../../../config/constants.mjs';
import { TOKEN_OUTLINE_COLOUR_SETTING, TOKEN_OUTLINE_DEFAULT_COLOUR } from '../../../config/settings.mjs';
import { tokenOutlineColours } from '../../../foundry/adapters/services/settings-policy.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { isMapVisible } from '../../../foundry/patches/vision.mjs';
import { projectPhaseTrackOptions } from '../../../foundry/adapters/projections/encounters.mjs';
import {
  MOVEMENT_PERMISSION_FLAG,
  MOVEMENT_PERMISSION_LABELS,
  normalizeMovementPermission
} from '../../../game/movement/input-policy.mjs';
import { ENCOUNTER_TOOLTIP_IDS, SCENE_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';

/* -------------------------------------------- */
/*  Scene configuration                         */
/* -------------------------------------------- */

const MAP_VISIBLE_MARKER = 'data-emblem-map-visible';
const PERMISSION_MARKER = 'data-emblem-movement-permission';
const TRACK_MARKER = 'data-emblem-phase-track';
const OUTLINE_MARKER = 'data-emblem-token-outline';
const TOKEN_OUTLINE_SCENE_FLAG = TOKEN_OUTLINE_COLOUR_SETTING;
const PHASE_FIELDS = Object.freeze([
  { phase: 'Player', label: 'Player Phase Track', tooltip: ENCOUNTER_TOOLTIP_IDS.PLAYER_PHASE_TRACK },
  { phase: 'Enemy', label: 'Enemy Phase Track', tooltip: ENCOUNTER_TOOLTIP_IDS.ENEMY_PHASE_TRACK }
]);

/**
 * Put the two phase tracks in Scene Config beside the map's own music.
 *
 * The value is a uuid naming either one PlaylistSound or a whole Playlist, so a map can be scored with a
 * single theme or with a set the playlist's own mode shuffles or cycles.
 */
export function onRenderSceneConfigPhaseTracks(app, element) {
  const scene = app.document;
  const root = element instanceof globalThis.HTMLElement ? element : element?.[0];
  if (!scene || !root || root.querySelector(`[${TRACK_MARKER}]`)) return;
  const anchor = root.querySelector('[name="playlistSound"]')?.closest('.form-group')
    ?? root.querySelector('[name="playlist"]')?.closest('.form-group');
  if (!anchor) return;

  const options = projectPhaseTrackOptions();
  for (const field of [...PHASE_FIELDS].reverse()) {
    anchor.after(trackField(app, scene, field, options));
  }
  app.setPosition({ height: 'auto' });
}

/**
 * Put the Map Visible toggle in Scene Config directly under Token Vision, the setting it rides on.
 *
 * The checkbox writes only the scene flag. onPreUpdateSceneMapVisible (foundry/adapters/document-writes/vision.mjs)
 * adds the vision and fog settings it implies to the same Scene update.
 */
export function onRenderSceneConfigMapVisible(app, element) {
  const scene = app.document;
  const root = element instanceof globalThis.HTMLElement ? element : element?.[0];
  if (!scene || !root || root.querySelector(`[${MAP_VISIBLE_MARKER}]`)) return;
  const anchor = root.querySelector('input[name="tokenVision"]')?.closest('.form-group');
  if (!anchor) return;

  const inputId = `${app.id}-emblem-map-visible`;
  const group = document.createElement('div');
  group.className = 'form-group';
  group.setAttribute(MAP_VISIBLE_MARKER, '');
  group.dataset.tooltip = getTooltip(SCENE_TOOLTIP_IDS.MAP_VISIBLE);

  const caption = document.createElement('label');
  caption.setAttribute('for', inputId);
  caption.textContent = 'Map Visible';

  const fields = document.createElement('div');
  fields.className = 'form-fields';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = `flags.${SYSTEM_ID}.mapVisible`;
  input.id = inputId;
  input.checked = isMapVisible(scene);
  fields.appendChild(input);

  group.append(caption, fields);
  anchor.after(group);
  app.setPosition({ height: 'auto' });
}

/**
 * Put the Movement Type Permissions select under Map Visible, where the map's own rules sit. init/hooks.mjs runs
 * this after onRenderSceneConfigMapVisible; without Map Visible it falls back to under Token Vision.
 */
export function onRenderSceneConfigMovementPermission(app, element) {
  const scene = app.document;
  const root = element instanceof globalThis.HTMLElement ? element : element?.[0];
  if (!scene || !root || root.querySelector(`[${PERMISSION_MARKER}]`)) return;
  const anchor = root.querySelector(`[${MAP_VISIBLE_MARKER}]`)
    ?? root.querySelector('input[name="tokenVision"]')?.closest('.form-group');
  if (!anchor) return;

  const inputId = `${app.id}-emblem-movement-permission`;
  const selected = normalizeMovementPermission(scene.getFlag(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG));
  const group = document.createElement('div');
  group.className = 'form-group';
  group.setAttribute(PERMISSION_MARKER, '');
  group.dataset.tooltip = getTooltip(SCENE_TOOLTIP_IDS.MOVEMENT_PERMISSION);

  const caption = document.createElement('label');
  caption.setAttribute('for', inputId);
  caption.textContent = 'Movement Type Permissions';

  const fields = document.createElement('div');
  fields.className = 'form-fields';
  const select = document.createElement('select');
  select.id = inputId;
  select.name = `flags.${SYSTEM_ID}.${MOVEMENT_PERMISSION_FLAG}`;
  for (const [value, label] of Object.entries(MOVEMENT_PERMISSION_LABELS)) select.appendChild(option(value, label, selected));
  fields.appendChild(select);

  group.append(caption, fields);
  anchor.after(group);
  app.setPosition({ height: 'auto' });
}

/** Remove the padding field: the grid maths assumes scene coordinates start at the map's own origin. */
export function onRenderSceneConfigPadding(app, element) {
  const root = element instanceof globalThis.HTMLElement ? element : element?.[0];
  const group = root?.querySelector('[name="padding"]')?.closest('.form-group');
  if (!group) return false;
  group.remove();
  app.setPosition({ height: 'auto' });
  return true;
}

/**
 * Strip the unsupported grid types from the Grid tab's selector and correct a value the map already carries. The
 * Basics tab's grid-type select has no name attribute, so it is not matched here and keeps every type.
 */
export function onRenderSceneConfigGridTypes(_app, element) {
  const root = element instanceof globalThis.HTMLElement ? element : element?.[0];
  const select = root?.querySelector('select[name="grid.type"]');
  if (!select) return false;
  const options = select.options ? [...select.options] : [...select.querySelectorAll('option')];
  for (const entry of options) {
    if (!SUPPORTED_GRID_TYPES.includes(Number(entry.value))) entry.remove();
  }
  if (!SUPPORTED_GRID_TYPES.includes(Number(select.value))) select.value = String(CONST.GRID_TYPES.SQUARE);
  return true;
}

/**
 * Add the scene's token outline colour beside the background colour it is chosen against. The reset button only
 * puts the world's outline colour back in the picker, and saving the form writes it.
 */
export function onRenderSceneConfigTokenOutline(app, element) {
  const scene = app.document;
  const root = element instanceof globalThis.HTMLElement ? element : element?.[0];
  if (!scene || !root || root.querySelector(`[${OUTLINE_MARKER}]`)) return false;
  const anchor = root.querySelector('color-picker[name="backgroundColor"]')?.closest('.form-group');
  if (!anchor) return false;

  const inputId = `${app.id}-emblem-token-outline`;
  const name = `flags.${SYSTEM_ID}.${TOKEN_OUTLINE_SCENE_FLAG}`;
  const group = document.createElement('div');
  group.className = 'form-group';
  group.setAttribute(OUTLINE_MARKER, '');
  group.innerHTML = `
    <label for="${inputId}">Token Outline Color</label>
    <div class="form-fields">
      <color-picker id="${inputId}" name="${name}" value="${escapeHtml(tokenOutlineColours(scene).dst)}">
        <input type="text" placeholder="${TOKEN_OUTLINE_DEFAULT_COLOUR}">
        <input type="color">
      </color-picker>
      <button type="button" class="emblem-reset-token-outline" data-tooltip="${getTooltip(SCENE_TOOLTIP_IDS.TOKEN_OUTLINE_RESET)}">
        <i class="fas fa-undo"></i>
      </button>
    </div>
  `;
  const picker = group.querySelector(`color-picker[name="${name}"]`);
  group.querySelector('.emblem-reset-token-outline').addEventListener('click', event => {
    event.preventDefault();
    if (picker) picker.value = tokenOutlineColours(scene).src;
  });
  anchor.after(group);
  app.setPosition({ height: 'auto' });
  return true;
}

/** One labelled select bound to the Scene flag its phase reads. */
function trackField(app, scene, { phase, label, tooltip }, options) {
  const flag = ENCOUNTER_TRACK_FLAGS[phase];
  const inputId = `${app.id}-emblem-${flag}`;
  const selected = String(scene.getFlag(SYSTEM_ID, flag) ?? '');

  const group = document.createElement('div');
  group.className = 'form-group';
  group.setAttribute(TRACK_MARKER, phase);
  group.dataset.tooltip = getTooltip(tooltip);

  const caption = document.createElement('label');
  caption.setAttribute('for', inputId);
  caption.textContent = label;

  const fields = document.createElement('div');
  fields.className = 'form-fields';
  fields.appendChild(trackSelect(inputId, `flags.${SYSTEM_ID}.${flag}`, selected, options));

  group.append(caption, fields);
  return group;
}

/** The select itself: nothing, then every whole playlist, then every sound under its own playlist. */
function trackSelect(inputId, name, selected, options) {
  const select = document.createElement('select');
  select.id = inputId;
  select.name = name;
  select.appendChild(option('', 'None', selected));

  if (options.playlists.length) {
    const group = document.createElement('optgroup');
    group.label = 'Playlists';
    for (const entry of options.playlists) group.appendChild(option(entry.uuid, entry.name, selected));
    select.appendChild(group);
  }
  for (const entry of options.sounds) {
    const group = document.createElement('optgroup');
    group.label = entry.name;
    for (const sound of entry.sounds) group.appendChild(option(sound.uuid, sound.name, selected));
    select.appendChild(group);
  }
  return select;
}

function option(value, label, selected) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  if (value === selected) element.selected = true;
  return element;
}
