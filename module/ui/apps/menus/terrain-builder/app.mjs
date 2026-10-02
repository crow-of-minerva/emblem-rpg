/** @layer ui/apps/menus/terrain-builder */
import {
  readBuilderWallCounts,
  readTerrainEditPresentation,
  readTerrainGrid as getTerrainGrid,
  readTerrainZones as getZones,
  readZoneCells as getZoneCells,
  resolveTerrainSpawnReference
} from '../../../../foundry/adapters/projections/terrain.mjs';
import { TERRAIN_BUILDER_GRID_SETTING } from '../../../../config/settings.mjs';
import { SYSTEM_ID } from '../../../../contracts/protocol.mjs';
import { CROSSING_DC_MULT_DEFAULT, CROSSING_DIRECTIONS } from '../../../../contracts/domains/terrain.mjs';

import {
  normalizeTransitionDirs,
  parseTerrainKey,
  sanitizeException,
  terrainCellAt,
  terrainKey,
  tileEffectsOf
} from '../../../../game/terrain/rules.mjs';
import {
  projectPresetToFormValues,
  projectSelectionFieldValues,
  readFieldPath,
  readTerrainFormValues,
  TERRAIN_FIELD_DEFAULTS,
  TERRAIN_SCALAR_FIELDS
} from './form-fields.mjs';
import { sanitizeTerrainSpawn, TERRAIN_ROW_SPECS, TerrainRowEditor } from './row-editor.mjs';
import { DEFAULT_ZONE_COLOR, nextZoneColor } from './zone-colors.mjs';
import { setTerrainVisualizationVisible } from '../../../../presentation/canvas/terrain.mjs';
import { createTerrainNotifier } from '../../../../presentation/interface/notifications.mjs';
import {
  enterTerrainMode,
  exitTerrainMode,
  getTerrainSelection,
  isTerrainModeActive,
  isTerrainSelectionLocked,
  refreshWallViz,
  refreshZoneOutlines,
  FREE_BONE_DEFAULT,
  FREE_BONE_MIN,
  setBuilderGridVisible,
  setFreeBoneLength,
  setTerrainBuilderMode,
  setTerrainSelection,
  setTerrainSelectionListener,
  setTerrainSelectionLocked,
  setWallChangeListener,
  setWallDeleteListener,
  setWallDrawListener,
  setWallSnapMode
} from './overlay.mjs';
import {
  openLoadTerrainPresetDialog as openLoadPresetDialog,
  openSaveTerrainPresetDialog as openSavePresetDialog
} from './presets.mjs';
import { projectPhaseTrackOptions, projectSceneCombatSettings } from '../../../../foundry/adapters/projections/encounters.mjs';
import { isMapVisible } from '../../../../foundry/patches/vision.mjs';
import { ENCOUNTER_TRACK_FLAGS } from '../../../../contracts/domains/combat.mjs';
import { MOVEMENT_PERMISSION_LABELS, MOVE_SCALING_LABELS } from '../../../../game/movement/input-policy.mjs';
import { roundLimitLocked } from '../../../../game/combat/objectives.mjs';
import { CONDITION_LABELS, openObjectivesEditor } from '../objectives-app.mjs';
import { ENCOUNTER_TOOLTIP_IDS } from '../../../tooltips.mjs';
import { capitalize } from '../../../../lib/dom/html.mjs';
import { lightAnimationChoices, lightColorationChoices } from '../../../../foundry/adapters/services/host.mjs';
import { FoundryDiagnostics , reportFoundryError } from '../../../../foundry/adapters/services/diagnostics.mjs';

let terrainAuthoring = null;

/* -------------------------------------------- */
/*  Authoring service                           */
/* -------------------------------------------- */
/**
 * Receive the TerrainAuthoringService (engine/authoring.mjs) that init/system.mjs builds. Every terrain, zone, wall
 * and Scene-setting write the builder makes goes through it.
 */
export function configureTerrainBuilder(configuration = {}) {
  terrainAuthoring = configuration.terrainAuthoring ?? null;
}

function terrainAuthoringService() {
  if (!terrainAuthoring) {
    throw new Error('ui/apps/menus/terrain-builder/app.mjs: terrainAuthoring was used before init/system.mjs '
      + 'called configureTerrainBuilder.');
  }
  return terrainAuthoring;
}

const notify = createTerrainNotifier({ diagnostics: new FoundryDiagnostics() });

const TEMPLATE = `systems/${SYSTEM_ID}/templates/editors/terrain-builder.hbs`;
const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* -------------------------------------------- */
/*  Field Vocabulary                            */
/* -------------------------------------------- */

const titleCase = (s) => (s ? capitalize(s) : s);

/** What a square does when a spell tries to paint over it. */
const OVERWRITE_BEHAVIOR_TYPES = [
  { value: '', label: 'None' },
  { value: 'forbid', label: 'Forbid Overwrite' },
  { value: 'clear', label: 'Clear' },
  { value: 'clearRespawn', label: 'Clear with Respawn' }
];

const overwriteBehaviorOptions = (selected) =>
  OVERWRITE_BEHAVIOR_TYPES.map(o => ({ value: o.value, label: o.label, selected: o.value === (selected || '') }));

/** The two roles a square can play in a map's objectives. */
const OBJECTIVE_POINT_TYPES = [
  { value: '', label: 'None' },
  { value: 'arrive', label: 'Arrival Point' },
  { value: 'defend', label: 'Defense Point' }
];

const objectivePointOptions = (selected) =>
  OBJECTIVE_POINT_TYPES.map(o => ({ value: o.value, label: o.label, selected: o.value === (selected || '') }));

/** Display label for each objective role. */
const OBJECTIVE_POINT_LABELS = { arrive: 'Arrival Point', defend: 'Defense Point' };

/** How a boundary can be crossed in one direction: not at all, or by passing one skill or either of two. */
const CROSSING_SKILL_TYPES = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'athletics', label: 'Athletics' },
  { value: 'finesse', label: 'Finesse' },
  { value: 'either', label: 'Either' }
];

/** The neighbour each crossing direction looks at, as a column and row step. */
const CROSSING_STEPS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Display label per direction. */
const CROSSING_LABELS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' };

/** The icon for each direction button on the transition compass. */
const DPAD_ICONS = { up: 'fa-caret-up', down: 'fa-caret-down', left: 'fa-caret-left', right: 'fa-caret-right' };

const crossingSkillOptions = (selected) =>
  CROSSING_SKILL_TYPES.map(o => ({ value: o.value, label: o.label, selected: o.value === selected }));

/** Read a crossing DC multiplier field. A blank field reads as 0; only a missing control gets the default. */
const _readDCMult = (root, field) => {
  const raw = Number(root.querySelector(`[name="${field}"]`)?.value);
  return Number.isFinite(raw) ? Math.max(0, raw) : CROSSING_DC_MULT_DEFAULT;
};

/* -------------------------------------------- */
/*  Shared Values Across a Selection            */
/* -------------------------------------------- */

/** Spawn list as text, to check whether the selected squares share one list. */
const _spawnSig = (list) => JSON.stringify((list ?? []).map(sanitizeTerrainSpawn));

/** The same, for a square's exceptions. */
const _exceptionSig = (list) => JSON.stringify((list ?? []).map(sanitizeException));

/**
 * Read one saved field across the selected squares: their shared value, or the default if they differ or nothing is
 * selected.
 * @param {string[]} sel    The selected cell keys.
 * @param {object} grid     The Scene terrain grid.
 * @returns {function(string, *): *}
 */
function _agreedCellReader(sel, grid) {
  return (path, dflt) => {
    if (sel.length === 0) return dflt;
    const values = new Set(sel.map(key => readFieldPath(grid[key], path) ?? dflt));
    return values.size === 1 ? [...values][0] : dflt;
  };
}

/** The builder window. Only one exists, since it owns the canvas's terrain mode. */
let _instance = null;

/* -------------------------------------------- */
/*  Cell Entries                                */
/* -------------------------------------------- */

/**
 * Build the per-square entries TerrainAuthoringService.replaceCells writes when the selection is saved.
 *
 * Each selected square is replaced whole from the form, keeping only its zone and elevation. A field the selection
 * disagreed on opened at its default, so it is saved as that default on every square. A spanned visual effect is
 * stored only on the rectangle's top-left square. Spanned audio and light are written to every selected square under
 * one shared key. Other squares using the same teleport tag lose their teleport first; the old partner of a selected
 * pad with a different tag is left as a pad with no exit.
 * @param {string[]} sel   The selected cell keys.
 * @param {object} data    The per-square form, already read.
 * @returns {object} The cell entries, keyed by cell.
 */
function _selectionSquares(sel, data) {
  const grid = getTerrainGrid(canvas.scene);
  const setUpdate = {};

  // A spanning effect is stored on the rectangle's top-left square with its size in cells.
  const rect = _rectInfo(sel);
  const spanActive = !!data.effect && data.effectSpan && !!rect?.isRect && sel.length > 1;

  // Each square gets its own audio key, or a spanned selection shares one. syncTerrainPlaceables turns the keys into
  // AmbientSound documents after the save, one per key at the centre of its squares, so an unspanned selection gets
  // one sound per square.
  const audioActive = !!data.soundFile;
  const audioSpan = audioActive && data.audioSpan && sel.length > 1;
  let sharedAudioKey = null;
  if (audioSpan) {
    const keys = new Set(sel.map(k => grid[k]?.audioKey).filter(Boolean));
    sharedAudioKey = keys.size === 1 ? [...keys][0] : foundry.utils.randomID();
  }

  // Lights are keyed the same way and become AmbientLight documents, one per key.
  const lightActive = (data.light.dim > 0 || data.light.bright > 0);
  const lightSpan = lightActive && data.lightSpan && sel.length > 1;
  let sharedLightKey = null;
  if (lightSpan) {
    const keys = new Set(sel.map(k => grid[k]?.lightKey).filter(Boolean));
    sharedLightKey = keys.size === 1 ? [...keys][0] : foundry.utils.randomID();
  }

  const isTeleport = data.transition === 'teleport';

  // Take the teleport off any other squares using this tag before writing the selected pair.
  if (isTeleport) {
    for (const [k, d] of Object.entries(grid)) {
      if (d?.transition !== 'teleport' || d.teleportLetter !== data.teleportLetter || sel.includes(k)) continue;
      const e = { ...d };
      delete e.transition; delete e.teleportLetter; delete e.teleportCost; delete e.teleportMov; delete e.teleportBlockable;
      setUpdate[k] = e;
    }
  }

  for (const key of sel) {
    const existing = grid[key] || {};
    const entry = {};
    // Keep zone membership and elevation, which the zone tools own.
    if (existing.zoneId) entry.zoneId = existing.zoneId;
    if (existing.elevation) entry.elevation = existing.elevation;
    if (data.movementCost !== 1) entry.movementCost = data.movementCost;
    if (data.evasionMod !== 0) entry.evasionMod = data.evasionMod;
    if (data.defMod !== 0) entry.defMod = data.defMod;
    if (data.resMod !== 0) entry.resMod = data.resMod;
    if (data.effect && (!spanActive || key === rect.anchorKey)) {
      entry.effect = data.effect;
      if (data.effectScale > 0 && data.effectScale !== 1) entry.effectScale = data.effectScale;
      if (data.effectOpacity >= 0 && data.effectOpacity !== 1) entry.effectOpacity = data.effectOpacity;
      if (data.effectRotation) entry.effectRotation = data.effectRotation;
      if (data.effectMirrorX) entry.effectMirrorX = true;
      if (data.effectMirrorY) entry.effectMirrorY = true;
      if (spanActive) { entry.effectSpanW = rect.w; entry.effectSpanH = rect.h; }
    }
    if (data.tileEffects.length > 0) entry.tileEffects = data.tileEffects;
    if (data.overwriteBehavior) {
      entry.overwriteBehavior = data.overwriteBehavior;
      if (data.overwriteBehavior === 'clearRespawn') entry.respawnRounds = Math.max(1, Math.floor(data.respawnRounds) || 1);
    }
    if (data.spawns.length > 0) entry.spawns = data.spawns;
    if (OBJECTIVE_POINT_LABELS[data.objectivePoint]) entry.objectivePoint = data.objectivePoint;
    if (data.exceptions.length > 0) entry.exceptions = data.exceptions;
    if (audioActive) {
      entry.audioKey = audioSpan ? sharedAudioKey : key;
      entry.audioFile = data.soundFile;
      entry.audioRadius = data.soundRadius > 0 ? data.soundRadius : TERRAIN_FIELD_DEFAULTS.soundRadius;
      entry.audioVolume = Math.min(Math.max(data.soundVolume, 0), 1);
      if (!data.soundEasing) entry.audioEasing = false;
    }
    if (lightActive) {
      entry.lightKey = lightSpan ? sharedLightKey : key;
      entry.light = { ...data.light };
    }
    if (data.obstacle) entry.obstacle = true;
    if (data.impassable) entry.impassable = true;
    if (data.transition === 'directional' && Object.keys(data.transitionDirs).length > 0) {
      entry.transition = 'directional';
      entry.transitionDirs = data.transitionDirs;
    } else if (data.transition === 'crossing') {
      entry.transition = 'crossing';
      if (Object.keys(data.crossing).length > 0) entry.crossing = data.crossing;
    } else if (isTeleport) {
      entry.transition = 'teleport';
      entry.teleportLetter = data.teleportLetter;
      entry.teleportCost = data.teleportCost;
      if (data.teleportCost === 'movement') entry.teleportMov = data.teleportMov;
      if (data.teleportBlockable) entry.teleportBlockable = true;
    }
    if (entry.transition && data.transitionRestrict) entry.transitionRestrict = data.transitionRestrict;

    setUpdate[key] = entry;
  }
  return setUpdate;
}

/**
 * Read one square into the labelled groups the overview tray shows.
 * @param {string} key    The cell key of the only selected square.
 * @param {object} grid   The Scene terrain grid.
 * @returns {Promise<object>} The square, its coordinates and its groups.
 */
async function _singleSquareOverview(key, grid) {
  const { x: c, y: r } = parseTerrainKey(key);
  const d = grid[key] || {};
  const groups = [];
  const addGroup = (label, items) => {
    if (items.length === 0) return;
    groups.push({
      label,
      items: items.map(it => (it.wide || it.cast || it.editName || String(it.tag ?? it.v ?? '').length <= 12)
        ? it
        : { ...it, span2: true })
    });
  };

  const stats = [];
  if (d.evasionMod) stats.push({ k: 'Eva', v: d.evasionMod, editName: 'evasionMod' });
  if (d.defMod) stats.push({ k: 'Def', v: d.defMod, editName: 'defMod' });
  if (d.resMod) stats.push({ k: 'Res', v: d.resMod, editName: 'resMod' });
  if (d.exceptions?.length) stats.push({ k: 'Exc', v: d.exceptions.length, jump: 'adv' });
  addGroup('Stats', stats);

  const geo = [];
  if (Number(d.movementCost ?? 1) !== 1) geo.push({ k: 'Move', v: d.movementCost, editName: 'movementCost' });
  if (d.transition) {
    const dirs = normalizeTransitionDirs(d);
    const base = dirs ? `Directional | ${CROSSING_DIRECTIONS.filter(dir => dirs[dir]).map(dir => CROSSING_LABELS[dir]).join('/')}`
      : d.transition === 'teleport' ? `Teleport ${d.teleportLetter || '?'} (${d.teleportCost || 'standard'}${d.teleportCost === 'movement' ? ' ' + (d.teleportMov || 0) : ''})${d.teleportBlockable ? ' | Blockable' : ''}`
      : d.transition === 'crossing' ? `Crossing${CROSSING_DIRECTIONS
        .filter(dir => d.crossing?.[dir]?.skill)
        .map(dir => ` | ${CROSSING_LABELS[dir]} ${capitalize(d.crossing[dir].skill)} ×${d.crossing[dir].mult ?? CROSSING_DC_MULT_DEFAULT}`)
        .join('')}`
      : '';
    const restrict = d.transitionRestrict === 'mounted' ? ' | No Mounted'
      : d.transitionRestrict === 'flying' ? ' | No Flying' : '';
    if (base) geo.push({ k: 'Trans', v: base + restrict, jump: 'geo' });
  }
  if (d.obstacle) geo.push({ tag: 'Obstacle', toggleName: 'obstacle' });
  if (d.impassable) geo.push({ tag: 'Impassable', toggleName: 'impassable' });
  addGroup('Geo', geo);

  const effects = [];
  for (const te of tileEffectsOf(d)) {
    if (te.type === 'healing') {
      if (te.value) effects.push({ k: 'Heal', v: `${te.value} HP`, jump: 'mech' });
      if (te.stn) effects.push({ k: 'Stn+', v: te.stn, jump: 'mech' });
    } else {
      effects.push({ k: 'Hzd', v: `${te.value} ${te.type}${te.canKillPlayer ? ' | lethal' : ''}`, jump: 'mech' });
    }
  }
  if (d.spawns?.length) effects.push({ k: 'Spawn', v: d.spawns.length, jump: 'mech' });
  if (OBJECTIVE_POINT_LABELS[d.objectivePoint]) effects.push({ tag: OBJECTIVE_POINT_LABELS[d.objectivePoint], jump: 'mech' });
  if (d.overwriteBehavior === 'forbid') effects.push({ tag: 'No Overwrite', jump: 'adv' });
  else if (d.overwriteBehavior === 'clear') effects.push({ tag: 'Clears on Overwrite', jump: 'adv' });
  else if (d.overwriteBehavior === 'clearRespawn') effects.push({ tag: `Respawns after ${d.respawnRounds ?? 1}`, jump: 'adv' });

  const terrainEdit = await readTerrainEditPresentation(key);
  if (terrainEdit) effects.push({ cast: terrainEdit });
  addGroup('Effects', effects);

  const fx = [];
  if (d.effect) fx.push({ k: 'FX', v: d.effect, wide: true, jump: 'fx' });
  if (Number(d.light?.dim) > 0 || Number(d.light?.bright) > 0) {
    fx.push({ k: 'Light', v: `${d.light.dim ?? 0}/${d.light.bright ?? 0}`, jump: 'light' });
  }
  if (d.audioFile) fx.push({ k: 'Audio', v: d.audioFile, wide: true, jump: 'audio' });
  addGroup('FX', fx);

  return { key, row: r, col: c, elev: d.elevation ?? 0, groups };
}

/**
 * Fill in the selection's transition fields: directional, crossing or teleport.
 * @param {object} fields   The per-square form being filled, extended in place.
 * @param {string[]} sel    The selected cell keys.
 * @param {object} grid     The Scene terrain grid.
 */
function _readSelectionTransitions(fields, sel, grid) {
  const count = sel.length;
  // The transition kind a square shows in this form: teleport, crossing, directional or none.
  const canonical = (data) => {
    const t = data?.transition;
    if (t === 'teleport' || t === 'crossing') return t;
    return normalizeTransitionDirs(data) ? 'directional' : '';
  };
  const transitions = new Set(sel.map(k => canonical(grid[k])));
  fields.transition = (count > 0 && transitions.size === 1) ? [...transitions][0] : '';
  fields.transitionNone = !fields.transition;
  fields.isDirectional = fields.transition === 'directional';
  fields.isTeleport = fields.transition === 'teleport';
  fields.isCrossing = fields.transition === 'crossing';
  fields.hasTransition = !!fields.transition && !fields.isCrossing;

  // A direction starts lit only if every selected square has it.
  fields.transitionDirs = CROSSING_DIRECTIONS.map(dir => {
    const vals = new Set(sel.map(k => !!normalizeTransitionDirs(grid[k])?.[dir]));
    return {
      dir,
      label: CROSSING_LABELS[dir],
      icon: DPAD_ICONS[dir],
      on: count > 0 && vals.size === 1 && [...vals][0]
    };
  });
  fields.transitionAllDirs = fields.transitionDirs.every(d => d.on);

  // A crossing direction can be set only where the height changes. If the squares disagree on its skill, it defaults
  // to Finesse when more of them step down, otherwise Athletics.
  fields.crossingDirs = CROSSING_DIRECTIONS.map(dir => {
    const [dx, dy] = CROSSING_STEPS[dir];
    let enabled = false;
    let ascends = 0;
    let descends = 0;
    const skills = new Set();
    const mults = new Set();
    for (const key of sel) {
      const { x: c, y: r } = parseTerrainKey(key);
      const here = grid[key]?.elevation || 0;
      const there = terrainCellAt(grid, c + dx, r + dy)?.elevation || 0;
      if (there === here) continue;
      enabled = true;
      if (there > here) ascends++; else descends++;
      const authored = grid[key]?.transition === 'crossing' ? grid[key]?.crossing?.[dir] : null;
      skills.add(authored?.skill || '');
      mults.add(Number(authored?.mult));
    }
    const fallback = descends > ascends ? 'finesse' : 'athletics';
    const skill = (skills.size === 1 && [...skills][0]) ? [...skills][0] : fallback;
    const authoredMult = mults.size === 1 ? [...mults][0] : NaN;
    return {
      dir,
      label: CROSSING_LABELS[dir],
      enabled,
      mult: Number.isFinite(authoredMult) ? authoredMult : CROSSING_DC_MULT_DEFAULT,
      skillOptions: crossingSkillOptions(skill)
    };
  });
  fields.canCross = fields.crossingDirs.some(d => d.enabled);
}

/**
 * Fill in the selection's fields that aren't a single saved value: the two span toggles, the row lists, and the
 * option lists and flags the template shows or hides its blocks with.
 * @param {object} fields   The per-square form being filled, extended in place.
 * @param {string[]} sel    The selected cell keys.
 * @param {object} grid     The Scene terrain grid.
 */
function _readSelectionContents(fields, sel, grid) {
  const count = sel.length;
  const tileEffectSigs = new Set(sel.map(k => JSON.stringify(tileEffectsOf(grid[k]))));
  fields.tileEffects = (count > 0 && tileEffectSigs.size === 1) ? JSON.parse([...tileEffectSigs][0]) : [];
  // Rows load only when every selected square has the same list. A mixed selection starts empty.
  const spawnSigs = new Set(sel.map(k => _spawnSig(grid[k]?.spawns)));
  fields.spawns = (count > 0 && spawnSigs.size === 1) ? JSON.parse([...spawnSigs][0]) : [];
  const exceptionSigs = new Set(sel.map(k => _exceptionSig(grid[k]?.exceptions)));
  fields.exceptions = (count > 0 && exceptionSigs.size === 1) ? JSON.parse([...exceptionSigs][0]) : [];

  // A span is shared when every selected square already has the same sound or light key.
  fields.audioSpan = count > 1 && sel.every(k => grid[k]?.audioKey && grid[k].audioKey === grid[sel[0]]?.audioKey);
  fields.lightSpan = count > 1 && sel.every(k => grid[k]?.lightKey && grid[k].lightKey === grid[sel[0]]?.lightKey);

  fields.teleportLetter ||= nextTeleportTag(grid);
  fields.objectivePointOptions = objectivePointOptions(fields.objectivePoint);
  fields.isClearRespawn = fields.overwriteBehavior === 'clearRespawn';
  fields.lightAnimOptions = lightAnimOptions(fields.lightAnimType);
  fields.colorationOptions = colorationOptions(fields.lightColoration);
  fields.isMovementCost = fields.teleportCost === 'movement';
  fields.showTpMov = fields.isTeleport && fields.isMovementCost;
}

/** The selection's bounding rectangle, whether the selection fills it, and its top-left square's key. */
function _rectInfo(sel) {
  if (!sel.length) return null;
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const k of sel) {
    const { x: c, y: r } = parseTerrainKey(k);
    if (Number.isNaN(r) || Number.isNaN(c)) return null;
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (c < minC) minC = c; if (c > maxC) maxC = c;
  }
  const w = maxC - minC + 1;
  const h = maxR - minR + 1;
  return { minR, minC, w, h, isRect: sel.length === w * h, anchorKey: terrainKey(minC, minR) };
}

/* -------------------------------------------- */
/*  Layout                                      */
/* -------------------------------------------- */

/**
 * Label, icon and template flag for each data tray, titling the Selection panel it fills.
 * @type {Record<string, {label: string, icon: string, flag: string}>}
 */
const TRAY_META = {
  overview: { label: 'Overview', icon: 'fa-clipboard-list', flag: 'isTrayOverview' },
  stats: { label: 'Stat Modifiers', icon: 'fa-shield-halved', flag: 'isTrayStats' },
  geo: { label: 'Geography', icon: 'fa-mountain-sun', flag: 'isTrayGeo' },
  mech: { label: 'Mechanical Effects', icon: 'fa-burst', flag: 'isTrayMech' },
  fx: { label: 'Visual FX', icon: 'fa-wand-magic-sparkles', flag: 'isTrayFx' },
  audio: { label: 'Audio', icon: 'fa-volume-high', flag: 'isTrayAudio' },
  light: { label: 'Light', icon: 'fa-lightbulb', flag: 'isTrayLight' },
  adv: { label: 'Advanced Settings', icon: 'fa-sliders', flag: 'isTrayAdv' }
};

/** The builder's modes and wall snap modes, each key mapped to the flag the template shows its sections with. */
const BUILDER_MODES = Object.freeze({ terrain: 'isTerrain', walls: 'isWalls', settings: 'isSettings' });
const WALL_SNAP_MODES = Object.freeze({ grid: 'isGridSnap', free: 'isFreeSnap', polygon: 'isPolySnap' });

/**
 * The restrictions a wall can put on each sense, as `EDGE_SENSE_TYPES` keys. Movement only knows None and Normal.
 * The two threshold types are the ones that read the wall's threshold.
 */
const WALL_SENSE_LABELS = Object.freeze({
  NONE: 'None', LIMITED: 'Limited', NORMAL: 'Normal', PROXIMITY: 'Proximity', DISTANCE: 'Distance'
});
const WALL_MOVE_LABELS = Object.freeze({ NONE: 'None', NORMAL: 'Normal' });
const WALL_THRESHOLD_TYPES = Object.freeze(['PROXIMITY', 'DISTANCE']);
const WALL_SENSES = Object.freeze(['sight', 'light', 'sound']);

/**
 * The wall types Foundry's own wall controls offer, with the same restrictions. The door types are left out, since
 * this system's doors are Door objects. Window's thresholds are in squares.
 */
const WALL_PRESETS = Object.freeze({
  solid: { label: 'Solid', icon: 'fa-bars',
    move: 'NORMAL', sight: 'NORMAL', light: 'NORMAL', sound: 'NORMAL' },
  terrain: { label: 'Terrain', icon: 'fa-mountain',
    move: 'NORMAL', sight: 'LIMITED', light: 'LIMITED', sound: 'LIMITED' },
  invisible: { label: 'Invisible', icon: 'fa-eye-slash',
    move: 'NORMAL', sight: 'NONE', light: 'NONE', sound: 'NONE' },
  ethereal: { label: 'Ethereal', icon: 'fa-mask',
    move: 'NONE', sight: 'NORMAL', light: 'NORMAL', sound: 'NONE' },
  window: { label: 'Window', icon: 'fa-window-maximize',
    move: 'NORMAL', sight: 'PROXIMITY', light: 'PROXIMITY', sound: 'NORMAL',
    threshold: { sight: 2, light: 2, attenuation: true } }
});

/** The restrictions the builder starts with: walls block movement and sight, but not light or sound. */
const DEFAULT_WALL_RESTRICTIONS = Object.freeze({
  move: 'NORMAL', sight: 'NORMAL', light: 'NONE', sound: 'NONE',
  threshold: Object.freeze({ sight: 2, light: 2, sound: 2, attenuation: false })
});

/** The preset whose restrictions the chosen ones match, or null. */
function _matchingWallPreset(restrictions) {
  return Object.keys(WALL_PRESETS).find(key => {
    const preset = WALL_PRESETS[key];
    return ['move', ...WALL_SENSES].every(sense => preset[sense] === restrictions[sense]);
  }) ?? null;
}

/** The chosen restrictions as the `EDGE_SENSE_TYPES` values the terrain writer stores. */
function _wallWriteSpec(restrictions) {
  const sense = CONST.EDGE_SENSE_TYPES;
  return {
    move: sense[restrictions.move],
    sight: sense[restrictions.sight],
    light: sense[restrictions.light],
    sound: sense[restrictions.sound],
    threshold: { ...restrictions.threshold }
  };
}

const TRAY_FLAGS = Object.freeze(
  Object.fromEntries(Object.entries(TRAY_META).map(([key, meta]) => [key, meta.flag])));

/**
 * The selection-lock button's two tooltips. The template reads them through `_prepareContext`, and
 * `_applyLockButton` swaps them when it updates the button in place.
 */
const LOCK_TOOLTIPS = Object.freeze({
  locked: 'Selection locked',
  unlocked: 'Lock the current selection'
});

/**
 * A new zone starts as "Zone" at level 0 in an unused colour; the zone row edits it afterwards.
 * @type {Readonly<{level: number, name: string}>}
 */
const NEW_ZONE = Object.freeze({ level: 0, name: 'Zone' });

/** The chosen key of one state table, or its first key when a control names something else. */
function _stateKey(table, raw) {
  return Object.hasOwn(table, raw) ? raw : Object.keys(table)[0];
}

/** One state table as the `is…` flags the template reads. */
function _stateFlags(table, chosen) {
  return Object.fromEntries(Object.entries(table).map(([key, flag]) => [flag, key === chosen]));
}

/** The light animation types Foundry knows about, localised, with a leading None. */
function lightAnimOptions(selected) {
  return [
    { value: '', label: 'None', selected: !selected },
    ...lightAnimationChoices().map(choice => ({ ...choice, selected: choice.value === selected }))
  ];
}

/** The coloration techniques Foundry's lighting shader offers, localised. */
function colorationOptions(selected) {
  return lightColorationChoices().map(choice => ({
    ...choice,
    selected: Number(choice.value) === Number(selected)
  }));
}

/**
 * Whether the current scene can carry terrain at all.
 *
 * Everything here is set per grid square, so a hex or gridless map has nothing to paint onto.
 * @returns {boolean}
 */
function _isSquareScene() {
  return !!canvas.scene && canvas.scene.grid.type === CONST.GRID_TYPES.SQUARE;
}

/* -------------------------------------------- */
/*  Teleport Tags                               */
/* -------------------------------------------- */

/**
 * A spreadsheet-style column tag from a zero-based index: A to Z, then AA, AB and so on.
 * @param {number} n              Zero-based index.
 * @returns {string}
 */
function _tagFromIndex(n) {
  let s = '';
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

/**
 * The first tag not already in use anywhere on the scene, which is what a freshly created pair gets.
 * @param {object} grid           The scene's terrain grid.
 * @returns {string}
 */
function nextTeleportTag(grid) {
  const used = new Set();
  for (const d of Object.values(grid)) {
    if (d?.transition === 'teleport' && d.teleportLetter) used.add(String(d.teleportLetter).toUpperCase());
  }
  for (let n = 0; ; n++) {
    const tag = _tagFromIndex(n);
    if (!used.has(tag)) return tag;
  }
}

/* -------------------------------------------- */
/*  Scene Settings                              */
/* -------------------------------------------- */

const FOG_MODE_LABELS = Object.freeze({ DISABLED: 'Disabled', INDIVIDUAL: 'Individual', SHARED: 'Shared' });

const PHASE_TRACKS = Object.freeze([
  { key: ENCOUNTER_TRACK_FLAGS.Player, label: 'Player Phase Track', tooltip: ENCOUNTER_TOOLTIP_IDS.PLAYER_PHASE_TRACK },
  { key: ENCOUNTER_TRACK_FLAGS.Enemy, label: 'Enemy Phase Track', tooltip: ENCOUNTER_TOOLTIP_IDS.ENEMY_PHASE_TRACK }
]);

function _sceneSettingsContext(scene) {
  const settings = projectSceneCombatSettings(scene);
  const options = projectPhaseTrackOptions();
  const known = new Set([
    ...options.playlists.map(entry => entry.uuid),
    ...options.sounds.flatMap(entry => entry.sounds.map(sound => sound.uuid))
  ]);
  const tracks = PHASE_TRACKS.map(track => {
    const value = settings.tracks[track.key] ?? '';
    return {
      ...track,
      value,
      noneSelected: !value,
      stale: !!value && !known.has(value),
      playlists: options.playlists.map(entry => ({ ...entry, selected: entry.uuid === value })),
      groups: options.sounds.map(entry => ({
        name: entry.name,
        sounds: entry.sounds.map(sound => ({ ...sound, selected: sound.uuid === value }))
      }))
    };
  });
  return {
    tracks,
    movementOptions: Object.entries(MOVEMENT_PERMISSION_LABELS)
      .map(([value, label]) => ({ value, label, selected: value === settings.movementPermission })),
    moveScalingOptions: Object.entries(MOVE_SCALING_LABELS)
      .map(([value, label]) => ({ value, label, selected: value === settings.moveScaling })),
    mapVisible: isMapVisible(scene),
    tokenVision: settings.tokenVision,
    globalLight: settings.globalLight,
    darkness: settings.darkness,
    fogOptions: Object.entries(CONST.FOG_EXPLORATION_MODES).map(([key, value]) => ({
      value, label: FOG_MODE_LABELS[key] ?? titleCase(key.toLowerCase()), selected: value === settings.fogMode
    })),
    victory: settings.objectives.objectives.map(_objectiveLabel),
    defeat: _defeatLabels(settings.objectives)
  };
}

function _objectiveLabel(objective) {
  const label = CONDITION_LABELS[objective.type] ?? titleCase(objective.type);
  if (objective.type === 'survive') return `${label} | ${objective.surviveTurns} turns`;
  if (objective.type === 'defend') return `${label} | ${objective.defendTurns} turns`;
  if (objective.type === 'defeat') return `${label} | ${objective.defeatTargets?.length ?? 0}`;
  if (objective.type === 'rout' && objective.routCount) return `${label} | ${objective.routCount}`;
  return label;
}

function _defeatLabels(spec) {
  const labels = [];
  if (spec.loss.anyLordDefeat) labels.push('Any Lord Defeated');
  if (spec.loss.protectedUnits.length) labels.push(`Protected Units | ${spec.loss.protectedUnits.length}`);
  if (spec.roundLimit > 0 && !roundLimitLocked(spec.objectives)) labels.push(`Round Limit | ${spec.roundLimit}`);
  return labels;
}

/**
 * The GM's Terrain Builder window, opened from the Terrain Builder scene control
 * (ui/apps/foundry/scene-controls.mjs). It edits terrain, walls and Scene settings through the
 * TerrainAuthoringService that configureTerrainBuilder receives, and overlay.mjs owns canvas selection. The trays
 * stay mounted, so switching them keeps unsaved fields and Save reads the whole form.
 */
export class TerrainBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  /* -------------------------------------------- */
  /*  Instance State                              */
  /* -------------------------------------------- */

  /**
   * Set while closeForCanvasChange closes the builder (the scene control was switched away, or the canvas changed),
   * so `_onClose` doesn't switch the control back to tokens under whatever the user picked.
   * @type {boolean}
   */
  static _closingFromControl = false;

  /** The close in progress, shared by control changes and canvas replacement so the builder closes once. */
  static _closePromise = null;

  /**
   * Which of the three modes is showing (a key of `BUILDER_MODES`). Only `#onSetMode` changes it, and it also tells
   * the canvas overlay which tools to offer.
   * @type {string}
   */
  _mode = 'terrain';

  /**
   * What newly drawn walls restrict: movement and each sense as an `EDGE_SENSE_TYPES` key, and the thresholds in
   * squares. The wall controls and `#onSetWallPreset` write it in place without a re-render, since a re-render drops
   * a polygon or chain in progress, and `_onWallsDrawn` reads it rather than the form.
   * @type {{move: string, sight: string, light: string, sound: string, threshold: object}}
   */
  _wallRestrictions = foundry.utils.deepClone(DEFAULT_WALL_RESTRICTIONS);

  /**
   * How wall drawing snaps (a key of `WALL_SNAP_MODES`). `setWallSnapMode` passes it to the canvas.
   * @type {string}
   */
  _wallSnap = 'grid';

  /**
   * The pixels each freestyle wall runs before the stroke starts the next one. The Bone Length field writes it in
   * place, and `_onRender` passes it to the canvas.
   * @type {number}
   */
  _wallBoneLength = FREE_BONE_DEFAULT;

  /**
   * The open data tray. One is always open: Overview by default, with Stats shown instead on a bare square.
   * `_applyTray` shows it without a re-render, so unsaved fields survive a tray switch.
   * @type {string}
   */
  _activeTray = 'overview';

  /**
   * Whether the selected square has saved terrain data, which is what the Overview tray shows.
   * @type {boolean}
   */
  _hasOverview = false;

  /**
   * A copied square's parameters, for pasting onto another selection.
   * @type {object|null}
   */
  _clipboard = null;

  /**
   * The three repeated lists of the Selection trays. Each owns its own rows so adding or removing one never
   * re-renders the window and discards unsaved fields (see `row-editor.mjs`).
   * @type {Record<string, TerrainRowEditor>}
   */
  _rows = {
    spawns: new TerrainRowEditor(TERRAIN_ROW_SPECS.spawns, {
      root: () => this.element,
      hooks: { resolveSpawnReference: resolveTerrainSpawnReference }
    }),
    exceptions: new TerrainRowEditor(TERRAIN_ROW_SPECS.exceptions, { root: () => this.element }),
    tileEffects: new TerrainRowEditor(TERRAIN_ROW_SPECS.tileEffects, { root: () => this.element })
  };

  /* -------------------------------------------- */
  /*  Configuration                               */
  /* -------------------------------------------- */

  static DEFAULT_OPTIONS = {
    id: 'emblem-terrain-builder',
    classes: [SYSTEM_ID, 'emblem-terrain-builder'],
    tag: 'div',
    window: {
      title: 'Terrain Builder',
      icon: 'fas fa-mountain-sun',
      resizable: true,
      minimizable: true
    },
    position: { width: 812, height: 560 },
    actions: {
      saveSelection: TerrainBuilder.#onSaveSelection,
      clearSelection: TerrainBuilder.#onClearSelection,
      savePreset: TerrainBuilder.#onSavePreset,
      loadPreset: TerrainBuilder.#onLoadPreset,
      createZone: TerrainBuilder.#onCreateZone,
      updateZone: TerrainBuilder.#onUpdateZone,
      deleteZone: TerrainBuilder.#onDeleteZone,
      removeFromZone: TerrainBuilder.#onRemoveFromZone,
      selectZone: TerrainBuilder.#onSelectZone,
      addToZone: TerrainBuilder.#onAddToZone,
      setMode: TerrainBuilder.#onSetMode,
      setSnapMode: TerrainBuilder.#onSetSnapMode,
      setWallPreset: TerrainBuilder.#onSetWallPreset,
      clearWalls: TerrainBuilder.#onClearWalls,
      setTray: TerrainBuilder.#onSetTray,
      overviewJump: TerrainBuilder.#onOverviewJump,
      overviewToggle: TerrainBuilder.#onOverviewToggle,
      addSpawn: TerrainBuilder.#onAddSpawn,
      addException: TerrainBuilder.#onAddException,
      addTileEffect: TerrainBuilder.#onAddTileEffect,
      toggleLock: TerrainBuilder.#onToggleLock,
      removeEffectEdit: TerrainBuilder.#onRemoveEffectEdit,
      copyTile: TerrainBuilder.#onCopyTile,
      pasteTile: TerrainBuilder.#onPasteTile,
      editObjectives: TerrainBuilder.#onEditObjectives
    }
  };

  static PARTS = { main: { template: TEMPLATE } };

  /* -------------------------------------------- */
  /*  Opening & Closing                           */
  /* -------------------------------------------- */

  /**
   * The builder, created on first use.
   * @returns {TerrainBuilder}
   */
  static getInstance() {
    if (!_instance) _instance = new TerrainBuilder();
    return _instance;
  }

  /**
   * Open the builder, for a GM on a square-grid map.
   *
   * On any other grid it also switches back to the token controls, so the scene control doesn't sit active over a
   * builder that never appeared. A player just gets a warning.
   * @returns {Promise<TerrainBuilder|null>}
   */
  static async open() {
    if (!game.user.isGM) {
      notify.warn('GM only.');
      return null;
    }
    if (!_isSquareScene()) {
      notify.warn('Terrain Builder requires a square-grid map.');
      try { canvas.tokens?.activate(); } catch (_) {
        reportFoundryError(import.meta.url, _, 'open');
      }
      return null;
    }
    const app = TerrainBuilder.getInstance();
    await app.render({ force: true });
    try { app.bringToFront(); } catch (_) {
      reportFoundryError(import.meta.url, _, 'open');
    }
    return app;
  }

  /** Close when the GM switches away from the Terrain Builder scene control. Same as closeForCanvasChange. */
  static closeFromControl() {
    void TerrainBuilder.closeForCanvasChange();
  }

  /**
   * Close the builder without switching the scene control back to tokens. Used when the GM picks another scene
   * control, before the canvas is torn down, and on canvasReady for a builder that survived a Scene change. Calls made
   * while a close is running share it.
   */
  static closeForCanvasChange() {
    if (TerrainBuilder._closePromise) return TerrainBuilder._closePromise;
    if (!_instance?.rendered) return Promise.resolve(false);
    TerrainBuilder._closingFromControl = true;
    TerrainBuilder._closePromise = Promise.resolve(_instance.close()).then(() => true).finally(() => {
      TerrainBuilder._closingFromControl = false;
      TerrainBuilder._closePromise = null;
    });
    return TerrainBuilder._closePromise;
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * Build the template context from the selected cells.
   *
   * The per-square controls come from the field table in `form-fields.mjs`: the selection's shared value, or the
   * field's default where the squares differ. The effect span, transition directions and row lists are read
   * separately.
   * @returns {Promise<object>}
   */
  async _prepareContext() {
    const sel = [...getTerrainSelection()];
    const count = sel.length;
    const grid = getTerrainGrid(canvas.scene);
    const zones = getZones(canvas.scene);

    // A spanned effect is stored once on its rectangle's top-left square, so its fields are read from there.
    const rect = _rectInfo(sel);
    const anchor = rect ? grid[rect.anchorKey] : null;
    const fields = {};
    fields.canSpan = !!rect?.isRect && count > 1;
    fields.effectSpan = fields.canSpan
      && Number(anchor?.effectSpanW) === rect.w
      && Number(anchor?.effectSpanH) === rect.h;

    Object.assign(fields, projectSelectionFieldValues({
      common: _agreedCellReader(sel, grid),
      anchor,
      spanActive: fields.effectSpan
    }));
    _readSelectionTransitions(fields, sel, grid);
    _readSelectionContents(fields, sel, grid);

    let sharedZoneId = null;
    if (count > 0) {
      const first = grid[sel[0]]?.zoneId || null;
      if (first && sel.every(k => (grid[k]?.zoneId || null) === first)) sharedZoneId = first;
    }
    const zoneMeta = sharedZoneId ? zones[sharedZoneId] : null;
    const zone = zoneMeta ? {
      id: sharedZoneId,
      name: zoneMeta.name ?? 'Zone',
      level: zoneMeta.level ?? 0,
      color: zoneMeta.color ?? DEFAULT_ZONE_COLOR,
      cellCount: getZoneCells(sharedZoneId).length
    } : null;

    const single = count === 1 ? await _singleSquareOverview(sel[0], grid) : null;

    const spansZones = count > 0 && !zone && sel.some(k => grid[k]?.zoneId);

    this._hasOverview = !!single && single.groups.length > 0;
    const tray = this._resolvedTray();

    const allZones = Object.values(zones)
      .map(zd => ({
        id: zd.id,
        name: zd.name ?? 'Zone',
        level: zd.level ?? 0,
        color: zd.color ?? DEFAULT_ZONE_COLOR,
        cellCount: getZoneCells(zd.id).length,
        isEditing: !!zone && zone.id === zd.id
      }))
      .sort((a, b) => (b.level - a.level) || a.name.localeCompare(b.name));

    return {
      mode: this._mode,
      ..._stateFlags(BUILDER_MODES, this._mode),
      hasOverview: this._hasOverview,
      ..._stateFlags(TRAY_FLAGS, tray),
      trayLabel: TRAY_META[tray]?.label ?? '',
      trayIcon: TRAY_META[tray]?.icon ?? 'fa-sliders',
      showGrid: game.settings.get(SYSTEM_ID, TERRAIN_BUILDER_GRID_SETTING),
      sceneSettings: this._mode === 'settings' ? _sceneSettingsContext(canvas.scene) : null,
      walls: this._mode === 'walls' ? this._wallContext() : null,
      wallSnap: this._wallSnap,
      wallBoneLength: this._wallBoneLength,
      wallBoneMin: FREE_BONE_MIN,
      ..._stateFlags(WALL_SNAP_MODES, this._wallSnap),
      hasSelection: count > 0,
      selectionLocked: isTerrainSelectionLocked(),
      lockTooltip: isTerrainSelectionLocked() ? LOCK_TOOLTIPS.locked : LOCK_TOOLTIPS.unlocked,
      statusText: count === 0 ? 'No squares selected' : `${count} square${count === 1 ? '' : 's'} selected`,
      fields,
      single,
      zone,
      canCreateZone: count > 0 && !zone,
      spansZones,
      allZones,
      canTeleport: count === 2,
      restrictOptions: [
        { value: '', label: 'None' },
        { value: 'mounted', label: 'Cannot be Mounted' },
        { value: 'flying', label: 'Cannot be Flying' }
      ].map(o => ({ value: o.value, label: o.label, selected: o.value === fields.transitionRestrict })),
      costOptions: [
        { value: 'standard', label: 'Standard Action' },
        { value: 'bonus', label: 'Bonus Action' },
        { value: 'movement', label: 'Movement' }
      ].map(o => ({ value: o.value, label: o.label, selected: o.value === fields.teleportCost })),
      overwriteBehaviorOptions: overwriteBehaviorOptions(fields.overwriteBehavior)
    };
  }

  /**
   * Mount the canvas overlay, register the overlay's selection and wall listeners, and bind the controls of the
   * mode that is showing. Scene-control hooks close the builder before the canvas is replaced.
   */
  _onRender(context, options) {
    super._onRender(context, options);
    this._hoistModeBar();
    if (!isTerrainModeActive()) enterTerrainMode();
    setTerrainVisualizationVisible(true);
    setTerrainSelectionListener(() => this.render());
    setWallDrawListener((segs) => this._onWallsDrawn(segs));
    setWallDeleteListener((wallId) => this._onWallDelete(wallId));
    setWallChangeListener(() => this._refreshWallCounts());
    setWallSnapMode(this._wallSnap);
    setFreeBoneLength(this._wallBoneLength);
    setTerrainBuilderMode(this._mode);
    setBuilderGridVisible(game.settings.get(SYSTEM_ID, TERRAIN_BUILDER_GRID_SETTING));

    if (this._mode === 'walls') this._wireWallControls();
    else if (this._mode === 'settings') this._wireSettingsControls();
    else {
      this._wireTerrainControls();
      this._wireOverview();
      for (const [key, editor] of Object.entries(this._rows)) editor.render(context.fields[key]);
      this._applyPasteButton();
    }

    this._applyTray();
  }

  /* -------------------------------------------- */
  /*  Scene Settings                              */
  /* -------------------------------------------- */

  /** Wire the settings-mode controls. Each Scene setting saves as soon as its control changes. */
  _wireSettingsControls() {
    const root = this.element;
    const cb = root.querySelector('[name="showGrid"]');
    cb?.addEventListener('change', () => {
      game.settings.set(SYSTEM_ID, TERRAIN_BUILDER_GRID_SETTING, cb.checked);
      setBuilderGridVisible(cb.checked);
    });
    for (const input of root.querySelectorAll('[data-scene-setting]')) {
      input.addEventListener('change', () => void this._saveSceneSetting(input));
      const readout = root.querySelector(`.terrain-slider-val[data-for="${input.dataset.sceneSetting}"]`);
      if (readout) input.addEventListener('input', () => { readout.textContent = input.value; });
    }
  }

  async _saveSceneSetting(input) {
    if (!game.user.isGM) { notify.warn('GM only.'); return; }
    const value = input.type === 'checkbox' ? input.checked : input.value;
    await this.#runAuthoring('_saveSceneSetting',
      () => terrainAuthoringService().configureScene({ [input.dataset.sceneSetting]: value }),
      'The Scene setting could not be saved.');
    if (this.rendered && this._mode === 'settings') this.render();
  }

  static async #onEditObjectives(event) {
    event.preventDefault();
    await openObjectivesEditor(canvas.scene);
    if (this.rendered && this._mode === 'settings') this.render();
  }

  /* -------------------------------------------- */
  /*  Walls                                       */
  /* -------------------------------------------- */

  /** The wall mode's presets, restriction and threshold controls, and the Scene's wall counts. */
  _wallContext() {
    const chosen = this._wallRestrictions;
    const preset = _matchingWallPreset(chosen);
    const options = (labels, value) => Object.entries(labels)
      .map(([key, label]) => ({ value: key, label, selected: key === value }));
    const senseLabel = sense => sense[0].toUpperCase() + sense.slice(1);
    return {
      presets: Object.entries(WALL_PRESETS).map(([key, { label, icon }]) => ({
        key, label, icon, active: key === preset, tooltip: `terrain.wall-${key}`
      })),
      restrictions: [
        { key: 'move', label: 'Movement', options: options(WALL_MOVE_LABELS, chosen.move) },
        ...WALL_SENSES.map(sense => ({
          key: sense,
          label: senseLabel(sense),
          tooltip: 'terrain.wall-sense',
          options: options(WALL_SENSE_LABELS, chosen[sense])
        }))
      ],
      thresholds: WALL_SENSES.map(sense => ({
        key: sense,
        label: senseLabel(sense),
        value: chosen.threshold[sense],
        disabled: !WALL_THRESHOLD_TYPES.includes(chosen[sense])
      })),
      attenuation: chosen.threshold.attenuation,
      counts: readBuilderWallCounts(canvas.scene)
    };
  }

  /**
   * Wire the wall mode's restriction selects and threshold fields to `_wallRestrictions`.
   *
   * A wall must block movement or sight, so a change that would leave both at None is refused: such a wall is
   * invisible in the builder and does nothing in play.
   */
  _wireWallControls() {
    const root = this.element;
    const chosen = this._wallRestrictions;
    for (const select of root.querySelectorAll('[data-wall-restriction]')) {
      select.addEventListener('change', () => {
        const key = select.dataset.wallRestriction;
        const previous = chosen[key];
        chosen[key] = select.value;
        if (chosen.move === 'NONE' && chosen.sight === 'NONE') {
          chosen[key] = previous;
          notify.warn('A wall must block movement or sight.');
        }
        this._syncWallControls();
      });
    }
    const bone = root.querySelector('[name="wallBoneLength"]');
    bone?.addEventListener('change', () => {
      this._wallBoneLength = Math.max(FREE_BONE_MIN, Math.round(Number(bone.value)) || FREE_BONE_DEFAULT);
      bone.value = this._wallBoneLength;
      setFreeBoneLength(this._wallBoneLength);
    });
    for (const input of root.querySelectorAll('[data-wall-threshold]')) {
      input.addEventListener('change', () => {
        const key = input.dataset.wallThreshold;
        if (key === 'attenuation') chosen.threshold.attenuation = input.checked;
        else chosen.threshold[key] = Math.max(0.5, Number(input.value) || chosen.threshold[key]);
        this._syncWallControls();
      });
    }
  }

  /** Show `_wallRestrictions` in the wall controls in place, so a polygon or chain in progress survives. */
  _syncWallControls() {
    const root = this.element;
    const chosen = this._wallRestrictions;
    const preset = _matchingWallPreset(chosen);
    for (const button of root.querySelectorAll('[data-wall-preset]')) {
      button.classList.toggle('is-active', button.dataset.wallPreset === preset);
    }
    for (const select of root.querySelectorAll('[data-wall-restriction]')) {
      select.value = chosen[select.dataset.wallRestriction];
    }
    for (const input of root.querySelectorAll('[data-wall-threshold]')) {
      const key = input.dataset.wallThreshold;
      if (key === 'attenuation') { input.checked = chosen.threshold.attenuation; continue; }
      input.value = chosen.threshold[key];
      input.disabled = !WALL_THRESHOLD_TYPES.includes(chosen[key]);
    }
  }

  /** Update the Scene Walls counts in place after any wall on the viewed scene changes. */
  _refreshWallCounts() {
    if (!this.rendered || this._mode !== 'walls') return;
    const counts = readBuilderWallCounts(canvas.scene);
    for (const cell of this.element.querySelectorAll('[data-wall-count]')) {
      cell.textContent = counts[cell.dataset.wallCount] ?? 0;
    }
  }

  /**
   * Create walls from what was drawn on the overlay (its wall draw listener), with the chosen restrictions.
   * @param {object[]} segments             Drawn segments.
   * @returns {Promise<void>}
   */
  async _onWallsDrawn(segments) {
    if (!game.user.isGM || !segments?.length) return;
    const spec = _wallWriteSpec(this._wallRestrictions);
    const created = await this.#runAuthoring('_onWallsDrawn',
      () => terrainAuthoringService().createWalls(segments, spec),
      'The walls could not be created.');
    if (created) refreshWallViz();
  }

  /**
   * Delete a wall the GM right-clicked in wall mode.
   * @param {string} wallId                 Wall to delete.
   * @returns {Promise<void>}
   */
  async _onWallDelete(wallId) {
    if (!game.user.isGM || !wallId) return;
    const deleted = await this.#runAuthoring('_onWallDelete', () => terrainAuthoringService().deleteWall(wallId),
      'The wall could not be deleted.');
    if (deleted) refreshWallViz();
  }

  /**
   * Leave terrain mode and put the canvas back.
   *
   * The control is switched back to tokens only when the close didn't come through closeForCanvasChange, or the
   * builder would undo whatever tool the user just picked.
   */
  _onClose(options) {
    super._onClose(options);
    setTerrainSelectionListener(null);
    exitTerrainMode();
    setTerrainVisualizationVisible(false);
    if (!TerrainBuilder._closingFromControl) {
      try {
        if (ui.controls?.control?.name === 'emblem-terrain') canvas.tokens?.activate();
      } catch (_) {
        reportFoundryError(import.meta.url, _, '_onClose');
      }
    }
  }

  /* -------------------------------------------- */
  /*  Form Reading                                */
  /* -------------------------------------------- */

  /**
   * Read every tray control into the per-square form that Save, presets and Copy use. `readTerrainFormValues` turns
   * the raw values into the saved shape.
   * @returns {object}
   */
  _readPerSquareForm() {
    const root = this.element;
    const raw = {};
    for (const field of TERRAIN_SCALAR_FIELDS) {
      const control = root.querySelector(`[name="${field.name}"]`);
      raw[field.name] = field.kind === 'checkbox' ? control?.checked : control?.value;
    }
    return readTerrainFormValues(raw, {
      tileEffects: this._rows.tileEffects.readAll(),
      spawns: this._rows.spawns.readAll(),
      exceptions: this._rows.exceptions.readAll(),
      transitionDirs: this._readTransitionDirs(),
      crossing: this._readCrossingRows()
    });
  }

  /**
   * The directions lit on the transition compass.
   * @returns {object}
   */
  _readTransitionDirs() {
    const dirs = {};
    for (const btn of this.element.querySelectorAll('.terrain-dpad-btn.is-on[data-dir]')) {
      if (btn.dataset.dir !== 'all') dirs[btn.dataset.dir] = true;
    }
    return dirs;
  }

  /**
   * The Zone Crossing settings, one entry per direction the form allows editing.
   * @returns {object}
   */
  _readCrossingRows() {
    const root = this.element;
    const out = {};
    for (const dir of CROSSING_DIRECTIONS) {
      const select = root.querySelector(`[name="crossing-${dir}-skill"]`);
      if (!select || select.disabled) continue;
      out[dir] = { skill: select.value || 'athletics', mult: _readDCMult(root, `crossing-${dir}-mult`) };
    }
    return out;
  }

  /** Mirror Overview inputs to their owning tray fields in both directions. Save reads only the named tray fields. */
  _wireOverview() {
    const root = this.element;
    for (const input of root.querySelectorAll('.terrain-ov-input')) {
      const field = root.querySelector(`.terrain-tray-pane [name="${input.dataset.ovMirror}"]`);
      if (!field) continue;
      input.addEventListener('change', () => {
        field.value = input.value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      });
      field.addEventListener('change', () => { input.value = field.value; });
    }
  }

  /**
   * Show and hide the transition, teleport and respawn fields as their selects change, and wire the transition
   * compass and slider readouts. The show/hide rules must match the template's initial `display:none` conditions.
   */
  _wireTerrainControls() {
    const root = this.element;
    const transSel = root.querySelector('[name="transition"]');
    const costSel = root.querySelector('[name="teleportCost"]');
    const owSel = root.querySelector('[name="overwriteBehavior"]');
    const show = (sel, on) => { const el = root.querySelector(sel); if (el) el.style.display = on ? '' : 'none'; };
    const sync = () => {
      const trans = transSel?.value || '';
      const isTp = trans === 'teleport';
      show('.terrain-tp-letter', isTp);
      show('.terrain-dpad', trans === 'directional');
      show('.terrain-xz', trans === 'crossing');
      show('.terrain-tp-restrict', !!trans && trans !== 'crossing');
      show('.terrain-tp-cost', isTp);
      show('.terrain-tp-mov', isTp && costSel?.value === 'movement');
      show('.terrain-tp-block', isTp);
      show('.terrain-ow-rounds', owSel?.value === 'clearRespawn');
    };
    transSel?.addEventListener('change', sync);
    costSel?.addEventListener('change', sync);
    owSel?.addEventListener('change', sync);
    sync();

    const dpad = root.querySelector('.terrain-dpad');
    const arms = [...root.querySelectorAll('.terrain-dpad-btn[data-dir]')].filter(b => b.dataset.dir !== 'all');
    const allBtn = root.querySelector('.terrain-dpad-btn[data-dir="all"]');
    const syncDpad = () => allBtn?.classList.toggle('is-on', arms.every(b => b.classList.contains('is-on')));
    dpad?.addEventListener('click', event => {
      const btn = event.target.closest('.terrain-dpad-btn');
      if (!btn) return;
      event.preventDefault();
      if (btn.dataset.dir === 'all') {
        const lit = arms.every(b => b.classList.contains('is-on'));
        for (const arm of arms) arm.classList.toggle('is-on', !lit);
      } else btn.classList.toggle('is-on');
      syncDpad();
    });
    syncDpad();

    for (const slider of root.querySelectorAll('.terrain-slider input[type="range"]')) {
      const out = root.querySelector(`.terrain-slider-val[data-for="${slider.name}"]`);
      if (out) slider.addEventListener('input', () => { out.textContent = slider.value; });
    }
  }

  /* -------------------------------------------- */
  /*  Trays                                       */
  /* -------------------------------------------- */

  /**
   * Move mode tabs into the Foundry window header. Stop pointerdown there so tab clicks cannot start window
   * dragging.
   */
  _hoistModeBar() {
    const header = this.element?.querySelector('.window-header');
    if (!header) return;
    header.querySelectorAll('.terrain-modebar').forEach(el => el.remove());
    const bar = this.element.querySelector('.terrain-modebar');
    if (!bar) return;
    header.insertBefore(bar, header.querySelector('.header-control') ?? null);
    bar.addEventListener('pointerdown', ev => ev.stopPropagation());
  }

  /**
   * The tray actually shown, which is the open one unless it is an Overview the square has no data to fill.
   *
   * The fallback is not saved to `_activeTray`: stepping onto a bare square shows Stats, stepping back onto a square
   * with data returns to Overview, and a tray the GM picks still sticks.
   * @returns {string} Tray key.
   */
  _resolvedTray() {
    return (this._activeTray === 'overview' && !this._hasOverview) ? 'stats' : this._activeTray;
  }

  /** Show the open tray and its title without re-rendering, so unsaved fields survive a tray switch. */
  _applyTray() {
    const root = this.element;
    if (!root) return;
    const key = this._mode === 'terrain' ? this._resolvedTray() : null;
    root.classList.toggle('tray-open', !!key);
    root.querySelectorAll('.terrain-tray-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tray === key));
    root.querySelectorAll('.terrain-tray-pane').forEach(p => p.classList.toggle('is-active', p.dataset.trayPane === key));

    const meta = TRAY_META[key];
    const header = root.querySelector('.terrain-tray-drawer .terrain-pane-header');
    if (!meta || !header) return;
    header.querySelector('i').className = `fas ${meta.icon}`;
    header.querySelector('span').textContent = `Selection: ${meta.label}`;
  }

  /* -------------------------------------------- */
  /*  Authoring                                   */
  /* -------------------------------------------- */

  /**
   * Run one terrain authoring call and report a failure instead of letting it escape into Foundry's action handler.
   *
   * Writes go straight from the GM's client to the Scene, so a failed write shows up here as an error. It is logged
   * and the GM is warned. Nothing is retried, and the form keeps what the GM typed.
   * @param {string} action                 The handler reporting the failure.
   * @param {function(): Promise<*>} work   The authoring call.
   * @param {string} failure                What the user is told when it fails.
   * @returns {Promise<boolean>} Whether the call completed.
   */
  async #runAuthoring(action, work, failure = 'The Terrain Builder change could not be applied.') {
    try {
      await work();
      return true;
    } catch (error) {
      reportFoundryError(import.meta.url, error, action);
      notify.warn(failure);
      return false;
    }
  }

  /**
   * Run a terrain or zone change, then refresh the zone outlines, tell the GM what happened and re-render from the
   * Scene. A failed call skips all three, so unsaved tray fields survive it.
   * @param {string} action                 The handler reporting the failure.
   * @param {function(): Promise<*>} work   The authoring call.
   * @param {string} notice                 What the user is told when it completes.
   * @returns {Promise<void>}
   */
  async #applyAuthoring(action, work, notice) {
    if (!await this.#runAuthoring(action, work)) return;
    refreshZoneOutlines();
    notify.info(notice);
    this.render();
  }

  /**
   * Save the form to the selected squares through TerrainAuthoringService.replaceCells. Every field except zone and
   * elevation is replaced from the form. A teleport pair must be exactly two squares with a tag.
   */
  static async #onSaveSelection(event) {
    event.preventDefault();
    if (!game.user.isGM) { notify.warn('GM only.'); return; }
    const sel = [...getTerrainSelection()];
    if (sel.length === 0) { notify.warn('Select at least one square.'); return; }

    const data = this._readPerSquareForm();
    const isTeleport = data.transition === 'teleport';
    if (isTeleport && sel.length !== 2) {
      notify.warn('Select exactly two squares to create a Teleport Pair.');
      return;
    }
    if (isTeleport && !data.teleportLetter) {
      notify.warn('Enter a Teleport tag of one or two letters.');
      return;
    }

    const setUpdate = _selectionSquares(sel, data);
    await this.#applyAuthoring('saveSelection', () => terrainAuthoringService().replaceCells(setUpdate),
      `Saved Terrain to ${sel.length} square${sel.length === 1 ? '' : 's'}.`);
  }

  /** Strip every selected square back to nothing, zone membership and elevation included. */
  static async #onClearSelection(event) {
    event.preventDefault();
    if (!game.user.isGM) { notify.warn('GM only.'); return; }
    const sel = [...getTerrainSelection()];
    if (sel.length === 0) { notify.warn('Select at least one square.'); return; }
    await this.#applyAuthoring('clearSelection', () => terrainAuthoringService().clearCells(sel),
      `Cleared Terrain from ${sel.length} square${sel.length === 1 ? '' : 's'}.`);
  }

  /**
   * Revert a square a spell has painted over, back to its original terrain.
   *
   * Spell-placed terrain is stored as an edit over the original rather than replacing it, so this is a revert rather
   * than a clear.
   */
  static async #onRemoveEffectEdit(event) {
    event.preventDefault();
    if (!game.user.isGM) { notify.warn('GM only.'); return; }
    const key = event.target.closest('[data-edit-key]')?.dataset.editKey;
    if (!key) return;
    await this.#applyAuthoring('removeEffectEdit', () => terrainAuthoringService().revertEditCells([key]),
      'Removed the persisted effect, so the square reverted to its original terrain.');
  }

  /* -------------------------------------------- */
  /*  Presets                                     */
  /* -------------------------------------------- */

  /**
   * Write a preset or copied tile into the tray controls, without saving. `projectPresetToFormValues` works out each
   * control's value from the same field table the form is read with, so a preset saved from this form loads back
   * unchanged. Only the three selects that show or hide other fields get a `change` event; the Overview tray keeps
   * its old values until the next render.
   * @param {object} preset         Preset parameters, or a copied tile.
   */
  _applyPresetToForm(preset) {
    const root = this.element;
    if (!root || !preset) return;
    const values = projectPresetToFormValues(preset);
    for (const field of TERRAIN_SCALAR_FIELDS) {
      if (!(field.name in values)) continue;
      const control = root.querySelector(`[name="${field.name}"]`);
      if (!control) continue;
      if (field.kind === 'checkbox') control.checked = values[field.name];
      else control.value = values[field.name] ?? '';
    }
    this._rows.tileEffects.render(tileEffectsOf(preset));
    this._rows.spawns.render(preset.spawns ?? []);
    this._rows.exceptions.render(preset.exceptions ?? []);

    const presetDirs = preset.transitionDirs || {};
    const presetAll = CROSSING_DIRECTIONS.every(dir => presetDirs[dir]);
    for (const btn of root.querySelectorAll('.terrain-dpad-btn[data-dir]')) {
      const dir = btn.dataset.dir;
      btn.classList.toggle('is-on', dir === 'all' ? presetAll : !!presetDirs[dir]);
    }

    root.querySelector('[name="transition"]')?.dispatchEvent(new Event('change'));
    root.querySelector('[name="teleportCost"]')?.dispatchEvent(new Event('change'));
    root.querySelector('[name="overwriteBehavior"]')?.dispatchEvent(new Event('change'));
    for (const s of root.querySelectorAll('.terrain-slider input[type="range"]')) s.dispatchEvent(new Event('input'));
  }

  /** Save the current form as a preset. */
  static async #onSavePreset(event) {
    event.preventDefault();
    await openSavePresetDialog(this._readPerSquareForm());
  }

  /** Load a preset into the form. */
  static async #onLoadPreset(event) {
    event.preventDefault();
    const params = await openLoadPresetDialog();
    if (params) this._applyPresetToForm(params);
  }

  /* -------------------------------------------- */
  /*  Zones                                       */
  /* -------------------------------------------- */

  /** Turn the selection into a new zone. */
  static async #onCreateZone(event) {
    event.preventDefault();
    const sel = [...getTerrainSelection()];
    if (sel.length === 0) { notify.warn('Select at least one square.'); return; }
    const color = nextZoneColor(Object.values(getZones(canvas.scene)).map(zone => zone.color ?? DEFAULT_ZONE_COLOR));
    await this.#applyAuthoring('createZone', () => terrainAuthoringService().createZone(sel, { ...NEW_ZONE, color }),
      `Created Zone "${NEW_ZONE.name}" from ${sel.length} square${sel.length === 1 ? '' : 's'}.`);
  }

  /** Apply the zone form's values to the zone whose row was clicked. */
  static async #onUpdateZone(event, target) {
    event.preventDefault();
    const zoneId = target.dataset.zoneId;
    if (!zoneId) return;
    const root = this.element;
    const level = Number(root.querySelector('[name="zoneLevel"]')?.value) || 0;
    const color = root.querySelector('[name="zoneColor"]')?.value || DEFAULT_ZONE_COLOR;
    const name = root.querySelector('[name="zoneName"]')?.value?.trim() || 'Zone';

    await this.#applyAuthoring('updateZone', () => terrainAuthoringService().updateZone(zoneId, { name, level, color }),
      'Zone updated.');
  }

  /** Delete the zone whose row was clicked, leaving its squares' terrain intact. */
  static async #onDeleteZone(event, target) {
    event.preventDefault();
    const zoneId = target.dataset.zoneId;
    if (!zoneId) return;
    await this.#applyAuthoring('deleteZone', () => terrainAuthoringService().deleteZone(zoneId), 'Zone deleted.');
  }

  /** Take the selected squares out of whatever zone they belong to. */
  static async #onRemoveFromZone(event) {
    event.preventDefault();
    const sel = [...getTerrainSelection()];
    if (sel.length === 0) return;
    await this.#applyAuthoring('removeFromZone', () => terrainAuthoringService().removeCellsFromZone(sel),
      `Removed ${sel.length} square${sel.length === 1 ? '' : 's'} from the Zone.`);
  }

  /* -------------------------------------------- */
  /*  Modes & Tools                               */
  /* -------------------------------------------- */

  /** Switch to the clicked mode (terrain, walls or settings), telling the canvas which tools to offer. */
  static #onSetMode(event, target) {
    event.preventDefault();
    const mode = _stateKey(BUILDER_MODES, target.dataset.mode);
    if (mode === this._mode) return;
    this._mode = mode;
    setTerrainBuilderMode(mode);
    this.render();
  }

  /** Switch how wall drawing snaps to the clicked snap button's mode. */
  static #onSetSnapMode(event, target) {
    event.preventDefault();
    const snap = _stateKey(WALL_SNAP_MODES, target.dataset.snap);
    if (snap === this._wallSnap) return;
    this._wallSnap = snap;
    setWallSnapMode(snap);
    this.render();
  }

  /** Take the clicked preset's restrictions for the next walls drawn, without a re-render. */
  static #onSetWallPreset(event, target) {
    event.preventDefault();
    const preset = WALL_PRESETS[target.dataset.wallPreset];
    if (!preset) return;
    const chosen = this._wallRestrictions;
    for (const key of ['move', ...WALL_SENSES]) chosen[key] = preset[key];
    Object.assign(chosen.threshold, preset.threshold ?? {});
    this._syncWallControls();
  }

  /** Delete every wall the builder can edit, once the GM confirms. */
  static async #onClearWalls(event) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const { total } = readBuilderWallCounts(canvas.scene);
    if (!total) return;
    const confirmed = await DialogV2.confirm({
      window: { title: 'Clear All Walls' },
      content: `<p>Delete all ${total} wall${total === 1 ? '' : 's'} on this scene? Door walls stay.</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;
    const cleared = await this.#runAuthoring('#onClearWalls', () => terrainAuthoringService().clearWalls(),
      'The walls could not be cleared.');
    if (cleared) refreshWallViz();
  }

  /** Update the selection-lock button in place so toggling it cannot reload and discard unsaved form fields. */
  _applyLockButton() {
    const btn = this.element?.querySelector('.terrain-lock-btn');
    if (!btn) return;
    const locked = isTerrainSelectionLocked();
    btn.classList.toggle('is-locked', locked);
    btn.dataset.tooltip = locked ? LOCK_TOOLTIPS.locked : LOCK_TOOLTIPS.unlocked;
    const icon = btn.querySelector('i');
    if (icon) icon.className = `fas ${locked ? 'fa-lock' : 'fa-lock-open'}`;
  }

  /** Lock or unlock the selection, so painting a series of squares doesn't lose the set on a stray click. */
  static #onToggleLock(event) {
    event.preventDefault();
    setTerrainSelectionLocked(!isTerrainSelectionLocked());
    this._applyLockButton();
  }

  /* -------------------------------------------- */
  /*  Clipboard                                   */
  /* -------------------------------------------- */

  /** Copy the current form values, unsaved edits included, for pasting into another selection. */
  static #onCopyTile(event) {
    event.preventDefault();
    const sel = [...getTerrainSelection()];
    if (sel.length === 0) { notify.warn('Select at least one square to copy from.'); return; }
    this._clipboard = this._readPerSquareForm();
    notify.info('Tile parameters copied.');
    this._applyPasteButton();
  }

  /** Paste the clipboard into the form, without saving it. */
  static #onPasteTile(event) {
    event.preventDefault();
    if (!this._clipboard) { notify.warn('Clipboard is empty: copy a tile first.'); return; }
    this._applyPresetToForm(this._clipboard);
    notify.info('Pasted tile parameters into the form.');
  }

  /** Enable the paste button only when there is something on the clipboard. */
  _applyPasteButton() {
    const btn = this.element?.querySelector('[data-action="pasteTile"]');
    if (btn) btn.disabled = !this._clipboard;
  }

  /* -------------------------------------------- */
  /*  Row Actions                                 */
  /* -------------------------------------------- */

  /** Add an exception row. */
  static #onAddException(event) {
    event.preventDefault();
    this._rows.exceptions.add();
  }

  /** Add a tile effect row. */
  static #onAddTileEffect(event) {
    event.preventDefault();
    this._rows.tileEffects.add();
  }

  /** Add a spawn array row. */
  static #onAddSpawn(event) {
    event.preventDefault();
    this._rows.spawns.add();
  }

  /**
   * Open the clicked tray.
   *
   * One is always open, so clicking the open tab again does nothing. The drawer never collapses, which keeps the
   * window from resizing under the cursor.
   */
  static #onSetTray(event, target) {
    event.preventDefault();
    const key = target.dataset.tray;
    if (!key || key === this._activeTray) return;
    this._activeTray = key;
    this._applyTray();
  }

  /** Open the tray that owns the clicked Overview entry, for entries too complex to edit in place. */
  static #onOverviewJump(event, target) {
    event.preventDefault();
    const key = target.dataset.ovTray;
    if (!key || key === this._activeTray) return;
    this._activeTray = key;
    this._applyTray();
  }

  /** Toggle an Overview flag chip by flipping its tray's checkbox, which is what Save reads. */
  static #onOverviewToggle(event, target) {
    event.preventDefault();
    const cb = this.element?.querySelector(`.terrain-tray-pane [name="${target.dataset.ovField}"]`);
    if (!cb) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    target.classList.toggle('is-on', cb.checked);
  }

  /** Select the squares of the zone whose row was clicked. */
  static #onSelectZone(event, target) {
    event.preventDefault();
    const zoneId = target.dataset.zoneId;
    if (!zoneId) return;
    setTerrainSelection(getZoneCells(zoneId));
  }

  /** Add the selected squares to the zone whose row was clicked. */
  static async #onAddToZone(event, target) {
    event.preventDefault();
    const zoneId = target.dataset.zoneId;
    if (!zoneId) return;
    const sel = [...getTerrainSelection()];
    if (sel.length === 0) { notify.warn('Select at least one square.'); return; }
    const zone = getZones(canvas.scene)[zoneId];
    await this.#applyAuthoring('addToZone', () => terrainAuthoringService().addZoneCells(zoneId, sel),
      `Added ${sel.length} square${sel.length === 1 ? '' : 's'} to "${zone?.name ?? 'Zone'}".`);
  }
}
