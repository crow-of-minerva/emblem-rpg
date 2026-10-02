/** @layer contracts/domains */
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
export const TOKEN_ART_SLOTS = Object.freeze([
  Object.freeze({ key: 'default', label: 'Default' }),
  Object.freeze({ key: 'armored', label: 'Armored' }),
  Object.freeze({ key: 'cavalry', label: 'Mounted' }),
  Object.freeze({ key: 'armoredCavalry', label: 'Armored Mounted' }),
  Object.freeze({ key: 'flying', label: 'Flying' })
]);

/** The conditions a token art entry can switch on: momentary events, and lasting states such as what is wielded. */
export const TOKEN_CONDITIONS = Object.freeze([
  'On Evade', 'On Crit', 'On Attack', 'On Cast', 'Unarmed', 'Wielding: Blade', 'Wielding: Polearm',
  'Wielding: Heavy', 'Wielding: Brawling', 'Wielding: Covert', 'Wielding: Bow', 'Wielding: Magic',
  'Wielding: Specific Item', 'Using Ability'
]);

/** The conditions that last while they hold. The rest are momentary events (evade, crit, attack, cast). */
export const STEADY_TOKEN_CONDITIONS = Object.freeze([
  'Unarmed', 'Wielding: Blade', 'Wielding: Polearm', 'Wielding: Heavy', 'Wielding: Brawling',
  'Wielding: Covert', 'Wielding: Bow', 'Wielding: Magic', 'Wielding: Specific Item',
  'Using Ability'
]);

/**
 * The keys a Foundry movement write names whether or not their values changed: every movement field, with the
 * movement history and Regions it records and the document id. A consumer that reacts to which keys an update
 * carries reads a write limited to these as a move, never as a new texture, name or state. The list is v14's
 * TokenDocument.MOVEMENT_FIELDS plus `_id`, `_movementHistory` and `_regions`; recheck it after a Foundry upgrade.
 */
export const TOKEN_MOVEMENT_WRITE_KEYS = Object.freeze([
  '_id', 'x', 'y', 'elevation', 'width', 'height', 'depth', 'shape', 'level', '_movementHistory', '_regions'
]);

/**
 * The side of one status-icon slot on a Token, before the canvas UI scale. presentation/token/rendering.mjs lays the
 * icons out in these slots, and external/barbrawl/resource-bars.mjs shortens a bar by one slot for a wield marker.
 */
export const STATUS_ICON_SLOT = 19;

export const SPECIFIC_ITEM_CONDITION = 'Wielding: Specific Item';
export const USING_ABILITY_CONDITION = 'Using Ability';
export const ON_CAST_CONDITION = 'On Cast';

/**
 * The comma-separated reference list each keyed condition reads from an entry. Each holds Item names, but an id or
 * UUID still matches too (see tokenEntryReferenceMatches).
 */
export const TOKEN_ENTRY_REFERENCE_FIELDS = Object.freeze({
  [SPECIFIC_ITEM_CONDITION]: 'specificItemUuid',
  [USING_ABILITY_CONDITION]: 'specificAbilityIds',
  [ON_CAST_CONDITION]: 'specificSpellNames'
});

const REFINEMENT_SUFFIX = /\s*\(\+\d+\)\s*$/;

/** Split an authored reference list into its trimmed, non-empty references. */
export function readTokenEntryReferences(raw) {
  return String(raw ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

/**
 * Tell whether one Item is what a reference list names. A name matches case-insensitively, and a name written
 * without a refinement suffix also matches every refined copy, so "Iron Sword" covers "Iron Sword (+1)". A
 * reference that is an id or UUID matches the Item's own id or its compendium source.
 */
export function tokenEntryReferenceMatches(item, references) {
  if (!item || !references.length) return false;
  const name = normalizeReferenceName(item.name);
  const baseName = name.replace(REFINEMENT_SUFFIX, '');
  const ids = new Set([item.id, idTail(item.uuid), idTail(item.compendiumSource)]
    .filter(Boolean));
  return references.some(reference => {
    const wanted = normalizeReferenceName(reference);
    return (wanted && (wanted === name || wanted === baseName)) || ids.has(idTail(reference));
  });
}

function normalizeReferenceName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function idTail(raw) {
  return String(raw ?? '').trim().split('.').pop() ?? '';
}

/**
 * How many class-art tabs one unit may carry. The appearance editor in `ui/apps/menus/acp-app.mjs` enforces it and
 * `api.character.art` publishes it, so Studio (character/variants.mjs) uses the same limit.
 */
export const MAX_TOKEN_ART_TABS = 10;

/**
 * An entry's triggers, any one of which fires it, for token art transitions and the appearance editor.
 */
export function readTokenEntryTriggers(entry) {
  if (Array.isArray(entry?.triggers) && entry.triggers.length) {
    return entry.triggers.map(value => String(value ?? '').trim()).filter(Boolean);
  }
  return [];
}

/** An entry's guards, all of which must hold, for token art transitions and the appearance editor. */
export function readTokenEntryGuards(entry) {
  return (Array.isArray(entry?.guards) ? entry.guards : [])
    .map(value => String(value ?? '').trim()).filter(Boolean);
}

/**
 * The groups the appearance editor's Map Entries dialog in `ui/apps/menus/acp-app.mjs` offers. A group with a
 * `wielding` condition maps that stance and guards its event entries with it. The group without one maps bare events.
 */
export const TOKEN_ENTRY_MAP_GROUPS = Object.freeze([
  Object.freeze({ key: 'basics', label: 'Basics', wielding: '' }),
  Object.freeze({ key: 'blade', label: 'Wielding Blade', wielding: 'Wielding: Blade' }),
  Object.freeze({ key: 'heavy', label: 'Wielding Heavy', wielding: 'Wielding: Heavy' }),
  Object.freeze({ key: 'polearm', label: 'Wielding Polearm', wielding: 'Wielding: Polearm' }),
  Object.freeze({ key: 'bow', label: 'Wielding Bow', wielding: 'Wielding: Bow' }),
  Object.freeze({ key: 'magic', label: 'Wielding Magic', wielding: 'Wielding: Magic' }),
  Object.freeze({ key: 'covert', label: 'Wielding Covert', wielding: 'Wielding: Covert' })
]);

/**
 * Turn the Map Entries checklist into the conditional entries to append, in reading order. Basics always maps evade,
 * attack and crit. A wielding group maps its stance, then only the events asked for. `combined` folds attack and crit
 * into one entry and wins over `split` when both are set.
 * @param {{group: string, evade?: boolean, split?: boolean, combined?: boolean}[]} selections   The checked groups.
 * @returns {{triggers: string[], guards: string[]}[]}
 */
export function planTokenEntryMap(selections) {
  const planned = [];
  for (const selection of Array.isArray(selections) ? selections : []) {
    const group = TOKEN_ENTRY_MAP_GROUPS.find(candidate => candidate.key === selection?.group);
    if (!group) continue;
    const basics = !group.wielding;
    const guards = basics ? [] : [group.wielding];
    const add = triggers => planned.push({ triggers, guards: [...guards] });
    if (!basics) planned.push({ triggers: [group.wielding], guards: [] });
    if (basics || selection.evade === true) add(['On Evade']);
    if (selection.combined === true) add(['On Attack', 'On Crit']);
    else if (basics || selection.split === true) { add(['On Attack']); add(['On Crit']); }
  }
  return planned;
}

export const TOKEN_FX_FLAG_KEY = 'tokenFx';

export const TOKEN_FX_SECTIONS = Object.freeze([
  'adjust', 'glow', 'bloom', 'bevel', 'distort', 'smoke', 'transform'
]);

export const TOKEN_FX_ANIM_TYPES = Object.freeze([
  Object.freeze({ value: 'colorOscillation', label: 'Color Cycle' }),
  Object.freeze({ value: 'syncColorOscillation', label: 'Color Cycle (Synced)' }),
  Object.freeze({ value: 'pulse', label: 'Strength Pulse' })
]);

export const TOKEN_FX_DEFAULTS = Object.freeze({
  adjustEnabled: false,
  brightness: 1, saturation: 1, contrast: 1, gamma: 1, red: 1, green: 1, blue: 1,
  glowEnabled: false, glowColor: '#ffd27a', glowStrength: 4, glowInner: 0,
  glowAnimEnabled: false, glowAnimType: 'colorOscillation', glowAnimDuration: 3000,
  glowColor2: '#ff4d4d', glowPulseMin: 0, glowPulseMax: 8,
  bloomEnabled: false, bloomThreshold: 0.5, bloomScale: 1, bloomBlur: 4, bloomBrightness: 1,
  bevelEnabled: false, bevelThickness: 5, bevelRotation: 0, bevelLightColor: '#ffffff',
  bevelLightAlpha: 0.9, bevelShadowColor: '#000000', bevelShadowAlpha: 0.9,
  distortEnabled: false, distortStrength: 5, distortSpeed: 0.05, distortStretch: 1,
  smokeEnabled: false, smokeColor: '#aaaaaa', smokeScale: 1, smokeSpeed: 0.005,
  smokeBlend: 2, smokeStretch: 1,
  transformEnabled: false, transformScale: 1, transformRotation: 0,
  transformTranslateX: 0, transformTranslateY: 0, transformTwist: 0, transformBulge: 0
});

const TOKEN_FX_RANGES = Object.freeze({
  brightness: [0, 2], saturation: [0, 2], contrast: [0, 2],
  gamma: [0.1, 3], red: [0, 2], green: [0, 2], blue: [0, 2],
  glowStrength: [0, 20], glowInner: [0, 20], glowAnimDuration: [200, 10000],
  glowPulseMin: [0, 20], glowPulseMax: [0, 20],
  bloomThreshold: [0, 1], bloomScale: [0, 3], bloomBlur: [0, 20], bloomBrightness: [0, 2],
  bevelThickness: [0, 15], bevelRotation: [0, 360], bevelLightAlpha: [0, 1], bevelShadowAlpha: [0, 1],
  distortStrength: [0, 20], distortSpeed: [0, 0.3], distortStretch: [0.1, 4],
  smokeScale: [0.1, 4], smokeSpeed: [-0.05, 0.05], smokeBlend: [0, 15], smokeStretch: [0.1, 4],
  transformScale: [0, 3], transformRotation: [0, 360],
  transformTranslateX: [-1, 1], transformTranslateY: [-1, 1],
  transformTwist: [-360, 360], transformBulge: [-1, 1]
});

const TOKEN_FX_HEX = /^#[0-9a-fA-F]{6}$/;
const TOKEN_FX_ANIM_VALUES = new Set(TOKEN_FX_ANIM_TYPES.map(option => option.value));

/**
 * Merge authored token effects with neutral defaults and clamp each field for the appearance editor and
 * presentation layer.
 */
export function normalizeTokenFxConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const config = { ...TOKEN_FX_DEFAULTS };
  for (const [key, fallback] of Object.entries(TOKEN_FX_DEFAULTS)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (typeof fallback === 'boolean') config[key] = Boolean(value);
    else if (key === 'glowAnimType') config[key] = TOKEN_FX_ANIM_VALUES.has(value) ? value : fallback;
    else if (typeof fallback === 'string') {
      const hex = String(value ?? '').trim().toLowerCase();
      config[key] = TOKEN_FX_HEX.test(hex) ? hex : fallback;
    } else {
      const number = Number(value);
      const [low, high] = TOKEN_FX_RANGES[key] ?? [-Infinity, Infinity];
      config[key] = Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
    }
  }
  return config;
}

/** Tell the appearance editor which effect sections differ from their defaults. */
export function tokenFxAdvancedSections(config) {
  return {
    adjust: config.gamma !== 1 || config.red !== 1 || config.green !== 1 || config.blue !== 1,
    glow: config.glowAnimEnabled === true,
    bloom: config.bloomBlur !== 4 || config.bloomBrightness !== 1,
    bevel: config.bevelLightAlpha !== 0.9 || config.bevelShadowColor !== '#000000'
      || config.bevelShadowAlpha !== 0.9,
    distort: config.distortStretch !== 1,
    smoke: config.smokeBlend !== 2 || config.smokeStretch !== 1,
    transform: config.transformTranslateX !== 0 || config.transformTranslateY !== 0
      || config.transformTwist !== 0 || config.transformBulge !== 0
  };
}

export const AUDIO_CHANNELS = Object.freeze({
  MUSIC: 'music',
  ENVIRONMENT: 'environment',
  INTERFACE: 'interface',
  VOICE_OVER: 'voiceover'
});

export const VOICE_OVER_CHANNEL_LABEL = 'Voice-Overs';

export const VOICE_CATEGORIES = Object.freeze([
  Object.freeze({ key: 'select', label: 'Select', folder: 'Select' }),
  Object.freeze({ key: 'crit', label: 'Crit', folder: 'Crit' }),
  Object.freeze({ key: 'thanks', label: 'Gratitude', folder: 'Gratitude' }),
  Object.freeze({ key: 'rally', label: 'Rally', folder: 'Rally' }),
  Object.freeze({ key: 'injured', label: 'Injured', folder: 'Injured' }),
  Object.freeze({ key: 'defeat', label: 'Defeat', folder: 'Defeat' }),
  Object.freeze({ key: 'levelGood', label: 'Level (Good)', folder: 'Level/Good' }),
  Object.freeze({ key: 'levelBad', label: 'Level (Bad)', folder: 'Level/Bad' })
]);

export const FOOTSTEP_GROUPS = Object.freeze([
  footstepGroup('onFoot', 'On Foot', [
    ['default', 'Default'], ['bestial', 'Bestial'], ['largeBeast', 'Large Beast'],
    ['monstrous', 'Monstrous'], ['ghoul', 'Ghoul'], ['spider', 'Spider'], ['giant', 'Giant'],
    ['skeleton', 'Skeleton'], ['gooey', 'Gooey'], ['metallic', 'Metallic'], ['dragon', 'Dragon'],
    ['custom', 'Custom']
  ]),
  footstepGroup('armored', 'Armored', [
    ['default', 'Default'], ['alternative', 'Alternative'], ['metallic', 'Metallic'], ['custom', 'Custom']
  ]),
  footstepGroup('mounted', 'Mounted', [
    ['default', 'Default'], ['bestial', 'Bestial'], ['largeBeast', 'Large Beast'],
    ['monstrous', 'Monstrous'], ['dragon', 'Dragon'], ['custom', 'Custom']
  ]),
  footstepGroup('flying', 'Flying', [
    ['default', 'Default'], ['levitation', 'Levitation'], ['lightFlap', 'Light Flap'], ['custom', 'Custom']
  ])
]);

const MAX_FOLDER_PATH_LENGTH = 512;

/** Validate an audio folder path for the appearance editor and presentation layer. Rejects traversal and URL syntax. */
export function normalizeAudioFolderPath(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\/+$/, '');
  if (!value || value.length > MAX_FOLDER_PATH_LENGTH) return null;
  if (/^[\\/]|[\\:%?#\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
const VOICE_PRESENTATION_KIND = 'voice';
export const FOOTSTEP_PRESENTATION_KIND = 'step';

/** Check a voice or footstep message the GM's client sent. */
export function isUnitPresentationMessage(value) {
  if (!plainRecord(value)) return false;
  if (value.kind === VOICE_PRESENTATION_KIND) {
    return exactKeys(value, ['kind', 'actorId', 'file'])
      && boundedText(value.actorId, 128)
      && boundedText(value.file, 2048);
  }
  if (value.kind !== FOOTSTEP_PRESENTATION_KIND || !boundedText(value.tokenUuid, 512)
    || !exactKeys(value, ['kind', 'tokenUuid', 'sounds'])
    || !Array.isArray(value.sounds) || value.sounds.length < 1 || value.sounds.length > 4) return false;
  return value.sounds.every(sound => {
    if (!plainRecord(sound)
      || !exactKeys(sound, ['soundId', 'file', 'index', 'volume', 'delay', 'fadeIn', 'fadeOut'])) return false;
    const hasSoundId = boundedText(sound.soundId, 128);
    const hasFile = boundedText(sound.file, 2048);
    if (hasSoundId === hasFile) return false;
    return optionalInteger(sound.index, 0, 64)
      && optionalNumber(sound.volume, 0, 1)
      && optionalInteger(sound.delay, 0, 5000)
      && optionalInteger(sound.fadeIn, 0, 5000)
      && optionalInteger(sound.fadeOut, 0, 5000);
  });
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
function footstepGroup(key, label, presets) {
  return Object.freeze({
    key,
    label,
    presets: Object.freeze(presets.map(([value, presetLabel]) => Object.freeze({ value, label: presetLabel })))
  });
}

function optionalInteger(value, minimum, maximum) {
  return value === undefined || (Number.isInteger(value) && value >= minimum && value <= maximum);
}

function optionalNumber(value, minimum, maximum) {
  return value === undefined || (Number.isFinite(value) && value >= minimum && value <= maximum);
}
