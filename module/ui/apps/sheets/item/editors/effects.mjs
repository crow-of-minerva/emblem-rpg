/** @layer ui/apps/sheets/item/editors */
/*
 * The effect editor: one triggered effect on an Item (or an Object), made of a trigger and a list of DSL steps that
 * can nest inside if branches. Cards are read back from the DOM before each edit. FIELDS_BY_KIND drives the ordinary
 * step fields. A custom status has its own panel of fields, plus an advanced json box for the ActiveEffect data the
 * panel has no field for. An animation step's animation is kept as JSON text in a hidden field that
 * openAnimationPayloadEditor fills. A step key that no field covers is dropped when the card is read and saved, and
 * so is a field the step's mode or scope hides, because a hidden field is not drawn at all.
 * What the trigger supplies decides which steps, units and squares are offered (trigger-choices.mjs).
 */
import { SYSTEM_ID } from '../../../../../contracts/protocol.mjs';
import { readSystemJson } from '../../../../../foundry/adapters/services/json-files.mjs';
import { createItemEditorNotifier } from '../../../../../presentation/interface/notifications.mjs';
import { capitalize, escapeHtml, optionMarkup } from '../../../../../lib/dom/html.mjs';
import { wireCatalogPicker } from '../../../../../lib/dom/search-dropdown.mjs';
import {
  ACTOR_TYPES,
  AREA_FACTIONS,
  empty as emptyAction,
  isPopulated as actionIsPopulated,
  MAX_AREA_RADIUS,
  MAX_EFFECT_DELAY_MS,
  STEP_KINDS,
  TOKEN_REFS,
  TRIGGER_CAPABILITIES,
  effectCarrier,
  validateEffectEntry
} from '../../../../../contracts/dsl/effects.mjs';
import {
  CHANGE_TYPES,
  END_TRIGGER_KEYS,
  STATUS_END_TRIGGERS,
  changeKeyRule,
  changeTargetByKey,
  customStatusChangeTargets,
  customStatusTemplate,
  defaultChangePriority,
  deriveStatusId,
  normalizeCustomStatus
} from '../../../../../contracts/dsl/custom-status.mjs';
import { isPlainObject } from '../../../../../lib/core/runtime.mjs';
import { STATUS_EFFECTS, STATUS_KEYS, STATUS_NAMES, statusLabel } from '../../../../../config/statuses.mjs';
import { triggerLabel } from '../../../../../config/triggers.mjs';
import { DAMAGE_TYPES } from '../../../../../contracts/domains/damage.mjs';
import { isEmpty as conditionIsEmpty, readsOtherUnit } from '../../../../../contracts/dsl/conditions.mjs';
import {
  conditionLineHtml,
  conditionTemplateGroups,
  conditionTemplateTree,
  mountConditionTreeBuilder,
  mountPathPicker,
  readConditionTree
} from './conditions.mjs';
import { openAnimationPayloadEditor } from './animations.mjs';
import {
  fitStepToTrigger,
  referenceOffered,
  stepKindOffered,
  triggerChoices,
  triggerFitsGroup,
  triggerKeysForGroup,
  triggerPhrase
} from './trigger-choices.mjs';
import {
  anyCardExpanded,
  createCardList,
  duplicateCard,
  parseCardJson,
  removeCard,
  transferCard,
  unparsedJsonErrors,
  writeCards
} from './card-list.mjs';
import {
  bindTerrainGeometryPanels,
  readField,
  readTerrainGeometryPanel,
  renderField,
  renderTerrainGeometryPanel,
  summarizeGeometry
} from './fields.mjs';
import { openEditor } from '../../../../dialogs.mjs';
import { getTooltip } from '../../../../tooltips.mjs';
import { DEFAULT_STATUS_DURATION } from '../../../../../contracts/domains/characters.mjs';
import { lightAnimationChoices, lightColorationChoices } from '../../../../../foundry/adapters/services/host.mjs';
import {
  reportFoundryError, FoundryDiagnostics, reportFoundryProbe
} from '../../../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Authoring Choices                           */
/* -------------------------------------------- */

export const VOICE_CATEGORIES = Object.freeze([
  { value: 'select', label: 'Select', folder: 'Select' },
  { value: 'crit', label: 'Crit', folder: 'Crit' },
  { value: 'thanks', label: 'Gratitude', folder: 'Gratitude' },
  { value: 'rally', label: 'Rally', folder: 'Rally' },
  { value: 'injured', label: 'Injured', folder: 'Injured' },
  { value: 'defeat', label: 'Defeat', folder: 'Defeat' },
  { value: 'levelGood', label: 'Level (Good)', folder: 'Level/Good' },
  { value: 'levelBad', label: 'Level (Bad)', folder: 'Level/Bad' }
]);

/**
 * How each step kind reads on its card, in the add-step picker and in a summary line. The code key itself only
 * appears in the kind's tooltip and in the card's `data-step-kind`.
 * @type {Readonly<Record<string, string>>}
 */
export const STEP_KIND_LABELS = Object.freeze({
  damage: 'Damage', heal: 'Heal', modShield: 'Shield', applyEffect: 'Apply status', removeEffect: 'Remove status',
  setFaction: 'Change faction', animation: 'Animation', floatingText: 'Floating text', moveToken: 'Move token',
  spawnToken: 'Spawn token', restoreAction: 'Restore actions',
  playResist: 'Resist popup', playVoice: 'Voice line',
  unequip: 'Unequip weapon', guard: 'Guard', terrainEdit: 'Edit terrain', if: 'If', wait: 'Wait'
});

/**
 * What each kind does, as the add-step picker's secondary line.
 * @type {Readonly<Record<string, string>>}
 */
const STEP_KIND_MEANINGS = Object.freeze({
  damage: 'deals hit point damage to a unit',
  heal: 'restores hit points to a unit',
  modShield: 'adds temporary shield points to a unit',
  applyEffect: 'puts a status on a unit',
  removeEffect: 'takes statuses off one or every unit',
  setFaction: 'moves a unit to another faction while a status lasts',
  animation: 'plays a Sequencer animation on the board',
  floatingText: 'shows text floating over a unit',
  moveToken: 'pushes, pulls, swaps or teleports a token',
  spawnToken: 'places a new token on the scene',
  restoreAction: 'gives a unit its actions back',
  playResist: 'shows the resist popup over a unit',
  playVoice: 'plays one of the unit\'s voice lines',
  unequip: 'puts away the weapon a unit wields',
  guard: 'runs the guard exchange on the target',
  terrainEdit: 'changes the squares in an area',
  if: 'runs steps only while a condition holds',
  wait: 'pauses before the next step runs'
});

/**
 * The add-step picker's groups after the templates. Guard is left out of the menu: a guard step only arrives with an
 * item that already has one. The picker also leaves out each kind the effect's trigger can't carry (stepKindOffered).
 * @type {ReadonlyArray<{label: string, kinds: string[]}>}
 */
const ADD_STEP_GROUPS = Object.freeze([
  { label: 'Combat', kinds: ['damage', 'heal', 'modShield'] },
  { label: 'Statuses', kinds: ['applyEffect', 'removeEffect'] },
  { label: 'Board', kinds: [
    'moveToken', 'terrainEdit', 'spawnToken', 'setFaction', 'restoreAction',
    'unequip'
  ] },
  { label: 'Presentation', kinds: ['animation', 'floatingText', 'playResist', 'playVoice'] },
  { label: 'Flow', kinds: ['if', 'wait'] }
]);

/**
 * How each starting template in `TEMPLATES` is named in the picker's Templates group.
 * @type {Readonly<Record<string, string>>}
 */
const TEMPLATE_LABELS = Object.freeze({
  applyDamage: 'Damage roll', applyHealing: 'Healing roll', applyStatus: 'Status on target',
  applyCustomStatus: 'Custom status', damageAndStatus: 'Damage and status', translateToken: 'Push back',
  linkedAnimation: 'Status with aura'
});

/**
 * What a template needs from the trigger beyond each of its step kinds being offered. Status on target and Push back
 * act on the other unit by name, and a trigger mid-exchange allows no push.
 * @type {Readonly<Record<string, function(object): boolean>>}
 */
const TEMPLATE_NEEDS = Object.freeze({
  applyStatus: cap => cap.target !== 'none',
  translateToken: cap => cap.target !== 'none' && !cap.midExchange
});

function stepKindLabel(kind) {
  return STEP_KIND_LABELS[kind] ?? String(kind ?? '?');
}

export const TERRAIN_EDIT_HAZARD_TYPES = Object.freeze(['healing', ...DAMAGE_TYPES]);

/* -------------------------------------------- */
/*  Authoring Templates                         */
/* -------------------------------------------- */

/** The custom status a new change faction step is tied to. The unit changes back when it ends. */
function turnedStatusTemplate() {
  const status = customStatusTemplate();
  status.name = 'Turned';
  status.statuses = [deriveStatusId(status.name)];
  status.flags.core.statusId = status.statuses[0];
  return status;
}

/**
 * The starting templates the add-step picker offers, each building a fresh action whose steps a pick adds after
 * fitStepToTrigger has fitted them to the trigger. `default` is the empty action and isn't offered. A custom status
 * keeps its duration in its own data.
 */
export const TEMPLATES = Object.freeze({
  default: () => emptyAction(),
  applyDamage: () => ({
    steps: [{ kind: 'damage', target: 'target', formula: '1d4', dmgType: 'slashing' }]
  }),
  applyHealing: () => ({
    steps: [{ kind: 'heal', target: 'target', formula: '1d4' }]
  }),
  applyStatus: () => ({
    steps: [{ kind: 'applyEffect', target: 'target', preset: 'restrained', durationPhases: DEFAULT_STATUS_DURATION }]
  }),
  applyCustomStatus: () => ({
    steps: [{
      kind: 'applyEffect',
      target: 'target',
      preset: 'custom',
      customData: customStatusTemplate()
    }]
  }),
  damageAndStatus: () => ({
    steps: [
      { kind: 'damage', target: 'target', formula: '1d4', dmgType: 'slashing' },
      { kind: 'applyEffect', target: 'target', preset: 'poisoned', durationPhases: DEFAULT_STATUS_DURATION }
    ]
  }),
  translateToken: () => ({
    steps: [{ kind: 'moveToken', target: 'target', mode: 'push', distance: 1 }]
  }),
  linkedAnimation: () => ({
    steps: [
      { kind: 'applyEffect', target: 'target', preset: 'shine', durationPhases: 2,
        linkAnimationTag: 'shine-aura' },
      { kind: 'animation', persistent: true, tag: 'shine-aura',
        animation: { steps: [] }, attachTarget: 'target', attachToEffectName: 'Shine' }
    ]
  })
});

/* -------------------------------------------- */
/*  Display Helpers                             */
/* -------------------------------------------- */

/**
 * How many phases an apply-status step's status lasts. A custom status keeps its duration in its own data, where 0
 * means it lasts until a trigger removes it. A stock status lasts at least one phase.
 */
function effectDuration(step) {
  if (step?.preset === 'custom') {
    const duration = step.customData?.flags?.[SYSTEM_ID]?.duration;
    return Number.isInteger(duration) && duration >= 0 ? duration : DEFAULT_STATUS_DURATION;
  }
  const duration = Number(step?.durationPhases);
  return Number.isFinite(duration) && duration >= 1 ? duration : DEFAULT_STATUS_DURATION;
}

/** The icon of the status an apply-status step hands out, or an empty string when it has none. */
function statusImage(step) {
  const img = step?.preset === 'custom' ? step.customData?.img : STATUS_EFFECTS[step?.preset]?.img;
  return typeof img === 'string' ? img.trim() : '';
}

/** The name of the status an apply-status step hands out, or the custom status's own name. */
export function presetLabel(step) {
  if (step?.preset === 'custom') return step.customData?.name || 'custom effect';
  if (!step?.preset) return '?';
  return statusLabel(step.preset);
}

/** The part of a terrain edit step's summary line that says what the edit does. */
function terrainEditSummary(step) {
  const parts = [];
  const signed = value => Number(value) > 0 ? `+${Number(value)}` : `${Number(value)}`;
  for (const key of ['eva', 'def', 'res']) {
    if (step?.[key] !== undefined) parts.push(`${key} ${signed(step[key])}`);
  }
  if (step?.mov !== undefined) parts.push(`mov ${Number(step.mov)}`);
  if (typeof step?.effect === 'string' && step.effect !== '') {
    parts.push(`${step.effect} ${step.variable ?? 0}${step.canKillPlayer === true ? ', lethal' : ''}`);
  }
  if (typeof step?.vfxEffect === 'string' && step.vfxEffect.trim() !== '') parts.push('effect');
  const dim = Number(step?.lightDim) || 0;
  const bright = Number(step?.lightBright) || 0;
  if (dim > 0 || bright > 0) parts.push(`light ${dim}/${bright}`);
  const duration = Math.max(0, Math.floor(Number(step?.duration) || 0));
  let summary = parts.length > 0 ? parts.join(', ') : 'no change';
  if (typeof step?.presetTile === 'string' && step.presetTile.trim() !== '') {
    summary = `${step.presetTile} tile, ${summary}`;
  }
  summary += duration > 0 ? ` for ${duration} phase${duration === 1 ? '' : 's'}` : ', permanent';
  if (step?.overwrite !== true) summary += ', fills gaps';
  if (step?.replacePrevious === true) summary += ', replaces previous';
  return summary;
}

function voiceCategoryLabel(category) {
  return VOICE_CATEGORIES.find(entry => entry.value === category)?.label ?? '?';
}

const notify = createItemEditorNotifier({ sourcePath: import.meta.url, diagnostics: new FoundryDiagnostics() });
const TERRAIN_FALLBACK_ICON = 'icons/svg/hazard.svg';
const TERRAIN_EDIT_PARAM_KEYS = Object.freeze([
  'eva', 'def', 'res', 'mov', 'effect', 'variable', 'stn', 'canKillPlayer',
  'vfxEffect', 'vfxScale', 'vfxOpacity', 'vfxRotation', 'vfxMirrorX', 'vfxMirrorY',
  'lightDim', 'lightBright', 'lightColor', 'lightAlpha', 'lightAnimType', 'lightWalls',
  'lightAnimSpeed', 'lightAnimIntensity', 'lightVision', 'lightColoration',
  'lightLuminosity', 'lightAttenuation', 'lightSaturation', 'lightContrast', 'lightShadows'
]);
let terrainPresetPromise = null;
let terrainPresetData = { presets: [], names: new Set(), custom: {} };

/* -------------------------------------------- */
/*  Clipboard                                   */
/* -------------------------------------------- */

/**
 * The effect entry clipboard. Every effect editor shares it, so a whole effect can be copied between items.
 * @type {object|null}
 */
let _clipboard = null;

/* -------------------------------------------- */
/*  Option Sets                                 */
/* -------------------------------------------- */

/**
 * Who a step can act on, as selector options.
 * @type {object[]}
 */
const TOKEN_REF_OPTIONS = TOKEN_REFS.map(r => ({ value: r, label: r }));
const AOE_TARGET_OPTIONS = [...TOKEN_REF_OPTIONS, { value: 'area', label: 'area' }];
const TERRAIN_TARGET_OPTIONS = [{ value: '', label: 'cast area' }, ...AOE_TARGET_OPTIONS];
const LOCATION_OPTIONS = [
  { value: 'targetLocation', label: 'the clicked square' },
  ...TOKEN_REF_OPTIONS
];
const AREA_FACTION_LABELS = Object.freeze({
  all: 'every unit', enemies: 'enemies', allies: 'allies', enemiesAndNeutrals: 'enemies and neutrals'
});
const AREA_FACTION_OPTIONS = AREA_FACTIONS.map(f => ({ value: f, label: AREA_FACTION_LABELS[f] ?? f }));

/**
 * How a move step moves its token, in the order the selector offers them.
 * @type {object[]}
 */
const MOVE_MODE_OPTIONS = [
  { value: 'teleport', label: 'teleport' },
  { value: 'push', label: 'push away' },
  { value: 'pull', label: 'pull toward' },
  { value: 'swap', label: 'swap' },
  { value: 'shift', label: 'shift' },
  { value: 'terrainGeometry', label: 'by rule' }
];

/**
 * The step kinds that can target an area rather than a single token, and so grow a radius panel when they do.
 * @type {Set<string>}
 */
const AOE_KINDS = new Set(['damage', 'heal', 'applyEffect', 'terrainEdit']);

const DMG_TYPE_OPTIONS = DAMAGE_TYPES.map(t => ({ value: t, label: t }));

/**
 * The statuses an apply-effect step can hand out, split by whether they help or harm, plus a custom status.
 * @type {object[]}
 */
const PRESET_OPTIONS = [
  ...STATUS_KEYS.filter(k => STATUS_EFFECTS[k].harmful)
    .map(k => ({ value: k, label: `${STATUS_EFFECTS[k].label} (harmful)` })),
  ...STATUS_KEYS.filter(k => STATUS_EFFECTS[k].beneficial)
    .map(k => ({ value: k, label: `${STATUS_EFFECTS[k].label} (beneficial)` })),
  { value: 'custom', label: 'custom' }
];

/**
 * What applying a status again does to its duration, stored as the step's `durationStacks`: true adds to what is
 * left, anything else starts it over.
 * @type {object[]}
 */
const REAPPLICATION_OPTIONS = [
  { value: 'false', label: 'renew duration' },
  { value: 'true', label: 'stack duration' }
];

/* -------------------------------------------- */
/*  Field Table                                 */
/* -------------------------------------------- */

/** The "who" field most steps start with, and its variant that also offers an area. */
const WHO = { name: 'target', type: 'select', options: TOKEN_REF_OPTIONS, label: 'who', tooltip: 'editor.step.who' };
const WHO_OR_AREA = { ...WHO, options: AOE_TARGET_OPTIONS };

/**
 * The field descriptors for each step kind, used both to render a card and to read it back. Each carries the
 * `label` its card shows and the `tooltip` id `renderField` puts on that label. `unit` shows a measurement label
 * such as ms or sq inside the input, `span` makes the field take a whole grid row, and `required` leaves the blank
 * choice out of a selector. Animation, move, guard and if steps lay out their own bodies. A terrain edit shows its
 * "who" field from here, then its own panel.
 * @type {Record<string, object[]>}
 */
const FIELDS_BY_KIND = {
  damage: [
    WHO_OR_AREA,
    { name: 'formula', type: 'text', label: 'amount', placeholder: '1d4', tooltip: 'editor.damage.amount' },
    { name: 'dmgType', type: 'select', options: DMG_TYPE_OPTIONS, label: 'type', tooltip: 'editor.damage.type',
      required: true },
    { name: 'brk', type: 'text', label: 'stance damage', placeholder: '0', tooltip: 'editor.damage.stance' },
    { name: 'alt', type: 'checkboxDefaultOn', label: 'apply mitigation', tooltip: 'editor.damage.mitigation' },
    { name: 'isCrit', type: 'tristate', label: 'critical', tooltip: 'editor.damage.critical' }
  ],
  heal: [
    WHO_OR_AREA,
    { name: 'formula', type: 'text', label: 'amount', placeholder: '1d6', tooltip: 'editor.heal.amount' },
    { name: 'stnAmount', type: 'text', label: 'stance restored', placeholder: '1', tooltip: 'editor.heal.stance' }
  ],
  modShield: [
    WHO,
    { name: 'formula', type: 'text', label: 'amount', placeholder: 'selfCha', tooltip: 'editor.shield.amount' },
    { name: 'cap', type: 'text', label: 'cap', placeholder: '10', tooltip: 'editor.shield.cap' }
  ],
  applyEffect: [
    WHO_OR_AREA,
    { name: 'preset', type: 'select', options: PRESET_OPTIONS, label: 'status', tooltip: 'editor.status.preset',
      required: true },
    { name: 'durationPhases', type: 'number', label: 'phases', placeholder: `${DEFAULT_STATUS_DURATION}`,
      tooltip: 'editor.status.duration' },
    { name: 'durationStacks', type: 'select', options: REAPPLICATION_OPTIONS, label: 'reapplication',
      tooltip: 'editor.status.reapplication', required: true },
    { name: 'linkAnimationTag', type: 'text', label: 'id tag', placeholder: 'marked',
      tooltip: 'editor.status.linked-tag' }
  ],
  setFaction: [
    WHO,
    { name: 'actorType', type: 'select', options: ACTOR_TYPES.map(t => ({ value: t, label: t })), label: 'faction',
      tooltip: 'editor.faction.faction' },
    { name: 'grantOwnership', type: 'checkbox', label: 'grant ownership', tooltip: 'editor.faction.grant-ownership' },
    { name: 'linkStatusTag', type: 'text', label: 'linked status tag', placeholder: 'turned',
      tooltip: 'editor.faction.linked-tag', required: true }
  ],
  removeEffect: [
    { name: 'scope', type: 'select', label: 'scope', tooltip: 'editor.remove.scope',
      options: [{ value: 'token', label: 'this target' }, { value: 'global', label: 'every token' }] },
    WHO,
    { name: 'name', type: 'text', label: 'status name', placeholder: 'Marked', datalist: STATUS_NAMES,
      tooltip: 'editor.remove.name' },
    { name: 'placedByActor', type: 'select', options: TOKEN_REF_OPTIONS, label: 'placed by',
      tooltip: 'editor.remove.placed-by' },
    { name: 'excludeTarget', type: 'checkbox', label: 'spare the target', tooltip: 'editor.remove.exclude-target' },
    { name: 'dispelHarmful', type: 'checkbox', label: 'dispel harmful', tooltip: 'editor.remove.dispel-harmful' },
    { name: 'dispelBeneficial', type: 'checkbox', label: 'dispel beneficial',
      tooltip: 'editor.remove.dispel-beneficial' }
  ],
  animation: [
    { name: 'persistent', type: 'checkbox', label: 'persistent', tooltip: 'editor.animation.persistent' },
    { name: 'await', type: 'checkbox', label: 'wait until finished', tooltip: 'editor.animation.await' },
    { name: 'tag', type: 'text', label: 'linked status tag', placeholder: 'marked', tooltip: 'editor.animation.tag' },
    { name: 'attachToEffectName', type: 'text', label: 'or tie to status named', placeholder: 'Marked',
      tooltip: 'editor.animation.tie-name' }
  ],
  floatingText: [
    WHO,
    { name: 'text', type: 'text', label: 'text', placeholder: 'Blocked!', tooltip: 'editor.floating.text' },
    { name: 'color', type: 'text', label: 'colour', placeholder: '#ffffff', tooltip: 'editor.floating.color' },
    { name: 'fontSize', type: 'number', label: 'size', placeholder: '35', tooltip: 'editor.floating.font-size' },
    { name: 'offsetY', type: 'number', label: 'offset y', placeholder: '-40', tooltip: 'editor.floating.offset-y' },
    { name: 'durationMs', type: 'number', label: 'duration', placeholder: '1500', unit: 'ms',
      tooltip: 'editor.floating.duration' }
  ],
  moveToken: [
    { ...WHO, label: 'who moves', tooltip: 'editor.move.who' },
    { name: 'mode', type: 'select', options: MOVE_MODE_OPTIONS, label: 'how', tooltip: 'editor.move.how' },
    { name: 'pair', type: 'select', options: TOKEN_REF_OPTIONS, label: 'with', tooltip: 'editor.move.pair' },
    { name: 'distance', type: 'text', label: 'distance', placeholder: '1', unit: 'sq',
      tooltip: 'editor.move.distance' },
    { name: 'location', type: 'select', options: LOCATION_OPTIONS, label: 'to', tooltip: 'editor.move.to' },
    { name: 'dx', type: 'text', label: 'dx', placeholder: '1', tooltip: 'editor.move.dx' },
    { name: 'dy', type: 'text', label: 'dy', placeholder: '0', tooltip: 'editor.move.dy' },
    { name: 'bypassWalls', type: 'checkbox', label: 'ignore walls', tooltip: 'editor.move.ignore-walls' }
  ],
  spawnToken: [
    { name: 'actorUuid', type: 'text', label: 'actor', placeholder: 'Actor.xxxxxxxxxxxxxxxx',
      tooltip: 'editor.spawn.actor' },
    { name: 'location', type: 'select', options: LOCATION_OPTIONS, label: 'where', tooltip: 'editor.spawn.location' },
    { name: 'name', type: 'text', label: 'token name', placeholder: 'Illusion', tooltip: 'editor.spawn.name' },
    { name: 'duration', type: 'number', label: 'duration', placeholder: '0', tooltip: 'editor.spawn.duration' },
    { name: 'isFriendly', type: 'checkbox', label: 'friendly to caster', tooltip: 'editor.spawn.friendly' },
    { name: 'grantOwnership', type: 'checkbox', label: 'owned by caster', tooltip: 'editor.spawn.owned' },
    { name: 'summoningSickness', type: 'checkbox', label: 'summoning sickness', tooltip: 'editor.spawn.sickness' },
    { name: 'replaceOnRecast', type: 'checkbox', label: 'replace on recast', tooltip: 'editor.spawn.replace' }
  ],
  restoreAction: [
    WHO,
    { name: 'standard', type: 'checkbox', label: 'standard action', tooltip: 'editor.restore.standard' },
    { name: 'bonus', type: 'checkbox', label: 'bonus action', tooltip: 'editor.restore.bonus' },
    { name: 'movement', type: 'checkbox', label: 'movement', tooltip: 'editor.restore.movement' },
    { name: 'turn', type: 'checkbox', label: 'whole turn', tooltip: 'editor.restore.full' }
  ],
  playResist: [WHO],
  playVoice: [
    { ...WHO, label: 'speaker', tooltip: 'editor.voice.speaker' },
    { name: 'category', type: 'select', options: VOICE_CATEGORIES.map(c => ({ value: c.value, label: c.label })),
      label: 'line', tooltip: 'editor.voice.category' },
    { name: 'skipIfSelf', type: 'checkbox', label: 'skip when self', tooltip: 'editor.voice.skip-self' }
  ],
  unequip: [{ ...WHO, tooltip: 'editor.unequip.who' }],
  guard: [],
  wait: [{ name: 'ms', type: 'text', label: 'wait', placeholder: '500', unit: 'ms', tooltip: 'editor.wait.ms' }],
  terrainEdit: [{ ...WHO, options: TERRAIN_TARGET_OPTIONS }],
  if: []
};
/* -------------------------------------------- */
/*  Terrain Presets                             */
/* -------------------------------------------- */

/**
 * Load the default terrain presets and the world's custom ones, once per session. They are not reloaded, so presets
 * saved later in the Terrain Builder show up only after a reload, and a failed load stays empty until then.
 */
function terrainPresetsReady() {
  terrainPresetPromise ??= Promise.all([
    readSystemJson('terrain.json').catch((diagnosticError) => {
      reportFoundryError(import.meta.url, diagnosticError, 'terrainPresetsReady');
      return null;
    }),
    game.emblemRpg.api.items.authoring.getTerrainPresets().catch((diagnosticError) => {
      reportFoundryError(import.meta.url, diagnosticError, 'terrainPresetsReady');
      return {};
    })
  ]).then(([defaults, custom]) => {
    const parsed = parseTerrainPresets(defaults);
    terrainPresetData = { ...parsed, custom: normalizeCustomTerrainPresets(custom, parsed) };
  });
  return terrainPresetPromise;
}

function parseTerrainPresets(raw) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.presets) ? raw.presets : []);
  const presets = [];
  for (const entry of source) {
    const name = String(entry?.name ?? '').trim();
    if (!name || !entry?.params || typeof entry.params !== 'object') continue;
    presets.push({
      name,
      icon: String(entry.icon ?? '').trim() || TERRAIN_FALLBACK_ICON,
      params: foundry.utils.deepClone(entry.params)
    });
  }
  return { presets, names: new Set(presets.map(entry => entry.name)) };
}

function normalizeCustomTerrainPresets(raw, defaults) {
  const output = {};
  for (const [name, entry] of Object.entries(raw ?? {})) {
    if (defaults.names.has(name)) continue;
    output[name] = entry && typeof entry === 'object' && entry.params
      ? {
          icon: entry.icon || TERRAIN_FALLBACK_ICON,
          params: foundry.utils.deepClone(entry.params)
        }
      : {
          icon: TERRAIN_FALLBACK_ICON,
          params: foundry.utils.deepClone(entry ?? {})
        };
  }
  return output;
}

function getDefaultPresets() {
  return terrainPresetData.presets.map(entry => foundry.utils.deepClone(entry));
}

function getCustomPresets() {
  return foundry.utils.deepClone(terrainPresetData.custom);
}

function terrainEditFieldsFromPreset(params) {
  const output = {};
  if (!params || typeof params !== 'object') return output;
  const putNumber = (key, raw, neutral) => {
    const number = Number(raw);
    if (Number.isFinite(number) && number !== neutral) output[key] = number;
  };
  putNumber('eva', params.evasionMod, 0);
  putNumber('def', params.defMod, 0);
  putNumber('res', params.resMod, 0);
  putNumber('mov', params.movementCost, 1);
  const tileEffect = params.tileEffects?.[0] ?? null;
  if (tileEffect) {
    output.effect = tileEffect.type;
    output.variable = tileEffect.value;
    if (tileEffect.stn) output.stn = tileEffect.stn;
    if (tileEffect.canKillPlayer === true) output.canKillPlayer = true;
  }
  const visual = String(params.effect ?? '').trim();
  if (visual) {
    output.vfxEffect = visual;
    putNumber('vfxScale', params.effectScale, 1);
    putNumber('vfxOpacity', params.effectOpacity, 1);
    putNumber('vfxRotation', params.effectRotation, 0);
    if (params.effectMirrorX) output.vfxMirrorX = true;
    if (params.effectMirrorY) output.vfxMirrorY = true;
  }
  const light = params.light;
  if (Number(light?.dim) > 0 || Number(light?.bright) > 0) {
    putNumber('lightDim', light.dim, 0);
    putNumber('lightBright', light.bright, 0);
    if (light.color && light.color.toLowerCase() !== '#ffffff') output.lightColor = light.color;
    putNumber('lightAlpha', light.alpha, 0.5);
    putNumber('lightAnimSpeed', light.animSpeed, 5);
    putNumber('lightAnimIntensity', light.animIntensity, 5);
    putNumber('lightColoration', light.coloration, 1);
    putNumber('lightLuminosity', light.luminosity, 0.5);
    putNumber('lightAttenuation', light.attenuation, 0.5);
    putNumber('lightSaturation', light.saturation, 0);
    putNumber('lightContrast', light.contrast, 0);
    putNumber('lightShadows', light.shadows, 0);
    if (light.animType) output.lightAnimType = light.animType;
    if (light.walls === false) output.lightWalls = false;
    if (light.vision === false) output.lightVision = false;
  }
  return output;
}

/**
 * The names of the default and custom terrain presets. openEffectActionEditor awaits terrainPresetsReady before
 * it renders, so the store is loaded by the time this runs.
 * @returns {{defaults: string[], custom: string[]}}
 */
function _terrainPresetList() {
  try {
    const defaults = getDefaultPresets().map(p => p.name);
    const custom = Object.keys(getCustomPresets());
    return { defaults, custom };
  } catch (_) {
    reportFoundryError(import.meta.url, _, '_terrainPresetList');
    return { defaults: [], custom: [] };
  }
}

/** The parameters a named preset carries, or null for an unknown name. */
function _terrainPresetParams(name) {
  if (typeof name !== 'string' || !name) return null;
  try {
    const def = getDefaultPresets().find(p => p.name === name);
    if (def) return def.params;
    const custom = getCustomPresets()[name];
    return custom ? custom.params : null;
  } catch (_) {
    reportFoundryError(import.meta.url, _, '_terrainPresetParams');
    return null;
  }
}

/**
 * The preset selector's options, grouped by default and custom. A selected preset that no longer exists is kept and
 * marked missing, so a step pointing at a deleted preset says so rather than silently reverting to none.
 */
function _terrainPresetOptions(selected) {
  const { defaults, custom } = _terrainPresetList();
  const opt = (name) =>
    `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`;
  let out = `<option value=""${!selected ? ' selected' : ''}>None</option>`;
  if (defaults.length) out += `<optgroup label="Default">${defaults.map(opt).join('')}</optgroup>`;
  if (custom.length) out += `<optgroup label="Custom">${custom.map(opt).join('')}</optgroup>`;
  if (selected && !defaults.includes(selected) && !custom.includes(selected)) {
    out += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (missing)</option>`;
  }
  return out;
}

/** The light animation options, read from the core configuration. */
function _terrainLightAnimOptions(selected) {
  return optionMarkup([{ value: '', label: 'None' }, ...lightAnimationChoices()], selected ?? '');
}

/** The light coloration options, read from the core shader techniques. */
function _terrainColorationOptions(selected) {
  return optionMarkup(lightColorationChoices(), Number(selected ?? 1));
}

/* -------------------------------------------- */
/*  Terrain Panel                               */
/* -------------------------------------------- */

/** A field's label span, carrying the tooltip every label shows on hover. */
function labelSpan(text, tooltipId) {
  const tip = tooltipId ? ` data-tooltip="${escapeHtml(getTooltip(tooltipId))}"` : '';
  return `<span class="ed-label"${tip}>${escapeHtml(text)}</span>`;
}

/**
 * One number input on the terrain panel.
 * @param {object} [opts]                         Bounds, placeholder, hidden and disabled state.
 */
function terrainNumberField(step, name, label, tooltip, opts = {}) {
  const v = step[name] === undefined || step[name] === null ? '' : step[name];
  const min = opts.min !== undefined ? ` min="${opts.min}"` : '';
  const max = opts.max !== undefined ? ` max="${opts.max}"` : '';
  const hidden = opts.hidden ? ' hidden' : '';
  const disabled = opts.disabled ? ' disabled' : '';
  return `<label class="ed-field"${hidden}>${labelSpan(label, tooltip)}`
    + `<input type="number" step="${opts.step ?? 'any'}"${min}${max} data-step-field="${name}"`
    + ` value="${escapeHtml(v)}" placeholder="${opts.placeholder ?? ''}"${disabled} /></label>`;
}

function terrainCheckField(name, label, tooltip, checked, disabled = false) {
  return `<label class="ed-field ed-field-checkbox" data-tooltip="${escapeHtml(getTooltip(tooltip))}">`
    + `<input type="checkbox" data-step-field="${name}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''} />`
    + `<span class="ed-label">${escapeHtml(label)}</span></label>`;
}

function terrainSelectField(name, label, tooltip, optionsHtml, disabled = false) {
  return `<label class="ed-field">${labelSpan(label, tooltip)}`
    + `<select data-step-field="${name}"${disabled ? ' disabled' : ''}>${optionsHtml}</select></label>`;
}

/**
 * The Sequencer effect a terrain edit draws on its squares, folded away until one is set.
 * @param {boolean} locked        Whether a preset supplies the values.
 */
function terrainVfxHtml(step, locked) {
  const hasVfx = typeof step.vfxEffect === 'string' && step.vfxEffect.trim() !== '';
  const num = (name, label, tooltip, opts) =>
    terrainNumberField(step, name, label, tooltip, { ...opts, disabled: locked });
  return `<details class="ed-details"${hasVfx ? ' open' : ''}>
      <summary>effect</summary>
      <div class="ed-grid ed-grid--3">
        <label class="ed-field ed-span">${labelSpan('effect path', 'editor.terrain.vfx')}
          <input type="text" data-step-field="vfxEffect" value="${escapeHtml(step.vfxEffect ?? '')}"
            placeholder="jb2a.markers.light_orb.complete.blue" spellcheck="false"${locked ? ' disabled' : ''} />
        </label>
        ${num('vfxScale', 'scale', 'editor.terrain.vfx-scale', { min: 0.25, max: 3, placeholder: '1' })}
        ${num('vfxOpacity', 'opacity', 'editor.terrain.vfx-opacity', { min: 0.05, max: 1, placeholder: '1' })}
        ${num('vfxRotation', 'rotation', 'editor.terrain.vfx-rotation', { min: 0, max: 360, step: 5, placeholder: '0' })}
        ${terrainCheckField('vfxMirrorX', 'mirror x', 'editor.terrain.vfx-mirror-x', step.vfxMirrorX === true, locked)}
        ${terrainCheckField('vfxMirrorY', 'mirror y', 'editor.terrain.vfx-mirror-y', step.vfxMirrorY === true, locked)}
      </div>
    </details>`;
}

/**
 * The light a terrain edit places on its squares, folded away until a radius is set.
 * @param {boolean} locked        Whether a preset supplies the values.
 */
function terrainLightHtml(step, locked) {
  const hasLight = Number(step.lightDim) > 0 || Number(step.lightBright) > 0;
  const lightColor = typeof step.lightColor === 'string' && step.lightColor ? step.lightColor : '#ffffff';
  const disabled = locked ? ' disabled' : '';
  const num = (name, label, tooltip, opts) =>
    terrainNumberField(step, name, label, tooltip, { ...opts, disabled: locked });
  const check = (name, label, tooltip, on) => terrainCheckField(name, label, tooltip, on, locked);
  const select = (name, label, tooltip, options) => terrainSelectField(name, label, tooltip, options, locked);
  return `<details class="ed-details"${hasLight ? ' open' : ''}>
      <summary>light</summary>
      <div class="ed-grid ed-grid--4">
        ${num('lightDim', 'dim radius', 'editor.terrain.light-dim', { min: 0, step: 1, placeholder: '0' })}
        ${num('lightBright', 'bright radius', 'editor.terrain.light-bright', { min: 0, step: 1, placeholder: '0' })}
        <label class="ed-field">${labelSpan('colour', 'editor.terrain.light-colour')}
          <input type="color" data-step-field="lightColor" value="${escapeHtml(lightColor)}"${disabled} />
        </label>
        ${num('lightAlpha', 'intensity', 'editor.terrain.light-intensity', { min: 0, max: 1, placeholder: '0.5' })}
        ${select('lightAnimType', 'animation', 'editor.terrain.light-animation',
          _terrainLightAnimOptions(step.lightAnimType))}
        ${num('lightAnimSpeed', 'speed', 'editor.terrain.light-speed', { min: 1, max: 10, step: 1, placeholder: '5' })}
        ${num('lightAnimIntensity', 'animation intensity', 'editor.terrain.light-anim-intensity',
          { min: 1, max: 10, step: 1, placeholder: '5' })}
        ${check('lightWalls', 'walls block', 'editor.terrain.light-walls', step.lightWalls !== false)}
        ${check('lightVision', 'provides vision', 'editor.terrain.light-vision', step.lightVision !== false)}
        ${select('lightColoration', 'coloration', 'editor.terrain.light-coloration',
          _terrainColorationOptions(step.lightColoration))}
        ${num('lightLuminosity', 'luminosity', 'editor.terrain.light-luminosity',
          { min: -1, max: 1, placeholder: '0.5' })}
        ${num('lightAttenuation', 'attenuation', 'editor.terrain.light-attenuation',
          { min: 0, max: 1, placeholder: '0.5' })}
        ${num('lightSaturation', 'saturation', 'editor.terrain.light-saturation', { min: -1, max: 1, placeholder: '0' })}
        ${num('lightContrast', 'contrast', 'editor.terrain.light-contrast', { min: -1, max: 1, placeholder: '0' })}
        ${num('lightShadows', 'shadows', 'editor.terrain.light-shadows', { min: 0, max: 1, placeholder: '0' })}
      </div>
    </details>`;
}

/**
 * Render the terrain edit fields, locking the parameters when a preset supplies them. The hazard, effect and light
 * sections open only when used. `readTerrainEditPanel` reads the panel back by `data-terrain-panel`.
 */
function renderTerrainEditPanel(step) {
  const locked = typeof step.presetTile === 'string' && step.presetTile.trim() !== '';
  const showStn = step.effect === 'healing';
  const showKill = typeof step.effect === 'string' && step.effect !== '' && !showStn;
  const hazardOpts = optionMarkup(
    [{ value: '', label: 'none' }, ...TERRAIN_EDIT_HAZARD_TYPES.map(type => ({ value: type, label: capitalize(type) }))],
    step.effect ?? ''
  );
  const stat = (name, opts = {}) =>
    terrainNumberField(step, name, name, 'editor.terrain.stat',
      { step: 1, placeholder: '0', disabled: locked, ...opts });

  return `<div data-terrain-panel>
    <div class="ed-grid ed-grid--4">
      ${terrainCheckField('overwrite', 'overwrite', 'editor.terrain.overwrite', step.overwrite === true)}
      ${terrainCheckField('replacePrevious', 'replace previous', 'editor.terrain.replace-previous',
        step.replacePrevious === true)}
      ${terrainNumberField(step, 'duration', 'phases', 'editor.terrain.duration',
        { min: 0, step: 1, placeholder: '0 is permanent' })}
      ${terrainSelectField('presetTile', 'tile', 'editor.terrain.preset',
        _terrainPresetOptions(locked ? step.presetTile : ''))}
    </div>
    <div class="ed-panel${locked ? ' is-locked' : ''}">
      <div class="ed-grid ed-grid--4">
        ${stat('eva')}
        ${stat('def')}
        ${stat('res')}
        ${stat('mov', { min: 1, placeholder: '1' })}
      </div>
      <div class="ed-grid ed-grid--4">
        ${terrainSelectField('effect', 'effect', 'editor.terrain.effect', hazardOpts, locked)}
        ${terrainNumberField(step, 'variable', 'amount', 'editor.terrain.variable',
          { min: 1, step: 1, placeholder: '1', disabled: locked })}
        ${terrainNumberField(step, 'stn', 'stance', 'editor.terrain.stn',
          { min: 0, step: 1, placeholder: '0', hidden: !showStn, disabled: locked })}
        ${showKill
          ? terrainCheckField('canKillPlayer', 'can kill a player', 'editor.terrain.can-kill',
            step.canKillPlayer === true, locked)
          : ''}
      </div>
      ${terrainVfxHtml(step, locked)}
      ${terrainLightHtml(step, locked)}
    </div>
  </div>`;
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * renderField options for effect cards: keep a stored choice that is no longer offered as a marked entry, and add
 * a blank first choice unless the field is `required`.
 * @type {object}
 */
const FIELD_STYLE = { emptyOption: true, keepOrphan: true };

/** The selector matching one step card, and never a condition node inside an if step. */
const CARD = '.ed-card[data-step-kind]';

/** The selector matching a list of step cards: the root list or an if branch. */
const LIST = '.ed-list[data-branch-list]';

/**
 * One descriptor rendered through `renderField` for a card body grid. A descriptor marked `span` takes the whole
 * row.
 * @param {string} idPrefix       What makes the control's id unique within the dialog.
 */
function fieldHtml(field, value, idPrefix) {
  const html = renderField(field, value, { ...FIELD_STYLE, emptyOption: field.required !== true, idPrefix });
  return field.span ? html.replace('class="', 'class="ed-span ') : html;
}

/* -------------------------------------------- */
/*  Summaries                                   */
/* -------------------------------------------- */

const AREA_WORDS = Object.freeze({
  all: 'every unit', enemies: 'every enemy', allies: 'every ally', enemiesAndNeutrals: 'every enemy and neutral'
});
const RESTORE_WORDS = Object.freeze({
  standard: 'standard action', bonus: 'bonus action', movement: 'movement', turn: 'whole turn'
});
const MOVE_PAIR_LABELS = Object.freeze({ push: 'from', pull: 'toward', swap: 'with' });

/** How a step's target reads in a summary line. */
function targetSummary(target) {
  if (target && typeof target === 'object') {
    if (target.area) {
      const a = target.area;
      const centre = a.includeCenter === true ? ' and the centre' : '';
      return `${AREA_WORDS[a.faction] ?? AREA_WORDS.all} within ${a.radius ?? 1} of ${a.center ?? 'self'}${centre}`;
    }
    if (target.expr) return `(${target.expr})`;
  }
  return target || '?';
}

/** How a terrain edit's target reads: squares rather than units, and the cast area when none is set. */
function terrainTargetSummary(target) {
  if (!target) return 'the cast area';
  if (typeof target === 'object' && target.area) {
    const a = target.area;
    const centre = a.includeCenter === true ? ' and the centre' : '';
    return `squares within ${a.radius ?? 1} of ${a.center ?? 'self'}${centre}`;
  }
  return `the square of ${targetSummary(target)}`;
}

/** How a location reads in a summary line. */
function locationSummary(location) {
  return LOCATION_OPTIONS.find(o => o.value === location)?.label ?? (location || '?');
}

/** The summary line of a move step, in the words its labels use. */
function moveSummary(step) {
  const who = targetSummary(step.target);
  const pair = step.pair || '?';
  const distance = `${step.distance ?? 1} sq`;
  switch (step.mode) {
    case 'push': return `push ${who} away from ${pair}, ${distance}`;
    case 'pull': return `pull ${who} toward ${pair}, ${distance}`;
    case 'swap': return `swap ${who} with ${pair}`;
    case 'teleport': return `teleport ${who} to ${locationSummary(step.location)}`;
    case 'shift': return `shift ${who} by ${step.dx ?? 0}, ${step.dy ?? 0}`;
    case 'terrainGeometry': return `move ${who} by rule: ${summarizeGeometry(step.geometry, { context: 'step' })}`;
    default: return `move ${who}`;
  }
}

/** The summary line of a remove-status step. */
function removeSummary(step) {
  const dispels = [];
  if (step.dispelHarmful) dispels.push('harmful');
  if (step.dispelBeneficial) dispels.push('beneficial');
  const what = dispels.length
    ? `every ${dispels.join(' and ')} status${step.name ? ` and "${step.name}"` : ''}`
    : (step.name ? `"${step.name}"` : 'a status');
  const where = step.scope === 'global' ? 'every token' : targetSummary(step.target);
  const placed = step.placedByActor ? ` placed by ${step.placedByActor}` : '';
  const spared = step.scope === 'global' && step.excludeTarget ? ', sparing the target' : '';
  return `remove ${what}${placed} from ${where}${spared}`;
}

/** The summary line of an animation step. */
function animationSummary(step) {
  const n = Array.isArray(step.animation?.steps) ? step.animation.steps.length : 0;
  const steps = `${n} step${n === 1 ? '' : 's'}`;
  if (step.persistent) return `persistent, ${steps}${step.tag ? `, tagged ${step.tag}` : ''}`;
  return `${steps}${step.await ? ', waits until finished' : ''}`;
}

/** The summary line of an if step. */
function ifSummary(step) {
  const then = step.then?.length || 0;
  const otherwise = Array.isArray(step.else)
    ? `, else ${step.else.length} step${step.else.length === 1 ? '' : 's'}`
    : '';
  return `if ${step.condition ? 'the condition holds' : 'always'}, ${then} step${then === 1 ? '' : 's'}${otherwise}`;
}

/**
 * Summarize a collapsed effect step in the words its labels use. This is plain text: every value here is authored,
 * and the card escapes the whole line before showing it.
 */
function stepSummaryText(step) {
  const who = targetSummary(step.target);
  switch (step.kind) {
    case 'damage': {
      const brk = step.brk && Number(step.brk) !== 0 ? `, ${step.brk} stance` : '';
      return `${step.formula || '?'} ${step.dmgType || '?'} to ${who}${brk}`;
    }
    case 'heal':
      return `heal ${who} ${step.formula || '?'}${step.stnAmount ? `, ${step.stnAmount} stance` : ''}`;
    case 'modShield':    return `${step.formula || '?'} shield to ${who}${step.cap ? `, up to ${step.cap}` : ''}`;
    case 'setFaction':
      return `${who} joins ${step.actorType || '?'}${step.grantOwnership ? ', owned by the caster' : ''}`
        + ` while ${step.linkStatusTag || '?'} lasts`;
    case 'applyEffect': {
      const n = effectDuration(step);
      const lasts = n === 0 ? 'until a trigger removes it' : `for ${n} phase${n === 1 ? '' : 's'}`;
      const tag = step.linkAnimationTag ? `, tagged ${step.linkAnimationTag}` : '';
      return `puts ${presetLabel(step)} on ${who} ${lasts}${tag}`;
    }
    case 'removeEffect': return removeSummary(step);
    case 'animation':    return animationSummary(step);
    case 'floatingText': return `"${step.text || '?'}" over ${who}`;
    case 'playVoice':
      return `${voiceCategoryLabel(step.category)} line from ${who}${step.skipIfSelf ? ', not when self' : ''}`;
    case 'playResist':   return `resist popup on ${who}`;
    case 'moveToken':    return moveSummary(step);
    case 'spawnToken':   return `spawn ${step.name || step.actorUuid || '?'} at ${locationSummary(step.location)}`;
    case 'restoreAction': {
      const actions = Array.isArray(step.actions) ? step.actions.map(a => RESTORE_WORDS[a] ?? a) : [];
      return `restore ${actions.length ? actions.join(', ') : '?'} for ${who}`;
    }
    case 'unequip':      return `unequip ${who}`;
    case 'guard':        return 'runs on the target';
    case 'wait':         return `wait ${step.ms || 0} ms`;
    case 'terrainEdit':  return `${terrainTargetSummary(step.target)}: ${terrainEditSummary(step)}`;
    case 'if':           return ifSummary(step);
    default: return stepKindLabel(step.kind);
  }
}

/**
 * The icon an apply-status card shows in its header, open or collapsed. `refreshStatusHeader` updates it as the
 * custom status's icon path changes, and hides it while there is no path.
 */
function statusSpriteHtml(step) {
  const img = statusImage(step);
  return `<img class="ed-sprite" data-status-sprite src="${escapeHtml(img)}" alt=""${img ? '' : ' hidden'} />`;
}

const EMPTY_SLOT_HTML = '<div class="ed-summary">no steps</div>';

/* -------------------------------------------- */
/*  Step Cards                                  */
/* -------------------------------------------- */

/**
 * The card list for this editor's step markup. `stepCards.state` carries which cards are collapsed and which
 * conditions are folded, so the steps themselves hold only what `openEffectActionEditor` saves. One list is shared
 * by every open effect editor; each step object gets its own id.
 * @type {object}
 */
const stepCards = createCardList({
  cardSelector: CARD,
  renderCard: (step, index, context) => renderStepCard(step, index, context?.path, context?.depth),
  readCard: cardEl => readStepFromCard(cardEl),
  emptyHtml: EMPTY_SLOT_HTML
});

/**
 * The fields each move mode uses. A known mode hides the others, and an unknown mode shows every field.
 * @type {Record<string, Set<string>>}
 */
const MOVE_FIELDS_BY_MODE = {
  teleport:         new Set(['location', 'bypassWalls']),
  push:             new Set(['distance', 'pair', 'bypassWalls']),
  pull:             new Set(['distance', 'pair', 'bypassWalls']),
  swap:             new Set(['pair', 'bypassWalls']),
  shift:            new Set(['dx', 'dy', 'bypassWalls']),
  terrainGeometry:  new Set(['bypassWalls'])
};

/**
 * The move-step fields shown whatever the mode.
 * @type {Set<string>}
 */
const MOVE_COMMON_FIELDS = new Set(['target', 'mode']);

/**
 * Whether a field belongs on a step's row of fields. A move step shows the fields its mode uses. A remove-status step
 * names a target only for one token, and spares the target only when it clears every token. A custom status shows
 * its id tag inside its panel rather than in the row.
 */
function isStepFieldShown(step, name) {
  if (step.kind === 'removeEffect' && name === 'target') return step.scope !== 'global';
  if (step.kind === 'removeEffect' && name === 'excludeTarget') return step.scope === 'global';
  if (step.kind === 'applyEffect' && name === 'linkAnimationTag') return step.preset !== 'custom';
  if (step.kind !== 'moveToken' || MOVE_COMMON_FIELDS.has(name)) return true;
  const relevant = Object.hasOwn(MOVE_FIELDS_BY_MODE, step.mode) ? MOVE_FIELDS_BY_MODE[step.mode] : null;
  return !relevant || relevant.has(name);
}

/** Whether a step's target is an area query rather than a single token reference. */
function isAreaTargetStep(step) {
  return AOE_KINDS.has(step.kind) && !!step.target && typeof step.target === 'object' && !!step.target.area;
}

/** Whether a move step places by terrain geometry rather than by distance or location. */
function isGeometryMoveStep(step) {
  return step.kind === 'moveToken' && step.mode === 'terrainGeometry';
}

/* -------------------------------------------- */
/*  Authored JSON fields                        */
/* -------------------------------------------- */

/**
 * What a card's JSON textarea shows: the author's unfinished text if it doesn't parse yet, otherwise the step's
 * current value written out.
 * @param {Function} stored       Writes out the value the step holds.
 */
function jsonFieldText(step, field, stored) {
  return stepCards.state.text(stepCards.state.identify(step), field) || stored();
}

/** How many characters a line of a custom status's advanced json may run to before an object or array is split. */
const COMPACT_JSON_WIDTH = 100;

/** Write a JSON value on one line, with a space after each colon and comma. */
function inlineJson(value) {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (value && typeof value === 'object') {
    const parts = jsonEntries(value).map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** An object's entries as JSON.stringify keeps them: undefined values and functions are left out. */
function jsonEntries(value) {
  return Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== 'function');
}

/** Whether an object or array holds only strings, numbers, booleans and nulls. */
function holdsOnlyPlainValues(value) {
  return Object.values(value).every(item => item === null || typeof item !== 'object');
}

/**
 * Write a value as JSON indented by two spaces. An object or array that holds only plain values always stays on one
 * line. Any other stays on one line when it fits within COMPACT_JSON_WIDTH.
 * @param {string} [indent]       The indentation of the line the value starts on.
 * @param {number} [lead]         How many characters come before the value on that line, after the indentation.
 */
function compactJson(value, indent = '', lead = 0) {
  const inline = inlineJson(value);
  if (!value || typeof value !== 'object' || holdsOnlyPlainValues(value)) return inline;
  // The extra character leaves room for the comma that follows a value inside a list or object.
  if (indent.length + lead + inline.length < COMPACT_JSON_WIDTH) return inline;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    return `[\n${value.map(item => inner + compactJson(item, inner)).join(',\n')}\n${indent}]`;
  }
  const lines = jsonEntries(value).map(([key, item]) => {
    const label = `${JSON.stringify(key)}: `;
    return inner + label + compactJson(item, inner, label.length);
  });
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

/** The class a JSON textarea has while its text doesn't parse. `.dialog-editor textarea.is-invalid` styles it. */
function jsonFieldMark(step, field) {
  return stepCards.state.text(stepCards.state.identify(step), field) ? ' class="is-invalid"' : '';
}

/**
 * Read one of a card's JSON fields. A value that parses goes onto the step and clears any text held for it. Text
 * that doesn't parse is held against the card id instead, so the next paint puts it back and
 * `collectValidationErrors` keeps Save refused, naming the step, until the author finishes it.
 * @param {HTMLElement|null} input        The textarea, where the card has one.
 * @param {string} cardId                 The card's id in `stepCards.state`.
 * @param {string} field                  Which JSON field.
 * @returns {{value: *}|null}             The parsed value, or null where there is nothing usable yet.
 */
function readStepJson(input, cardId, field) {
  if (!input) return null;
  const read = parseCardJson(input.value);
  stepCards.state.setText(cardId, field, read.invalid ?? '');
  return 'value' in read ? read : null;
}

/* -------------------------------------------- */
/*  Card Bodies                                 */
/* -------------------------------------------- */

/** The radius panel a step shows when its target is an area. `readStepPanels` reads it back by `data-area-panel`. */
function areaPanelHtml(step) {
  const a = step.target.area || {};
  const center = a.center ?? 'self';
  const radius = Number.isFinite(Number(a.radius)) ? Number(a.radius) : 1;
  const includeTip = escapeHtml(getTooltip('editor.step.area-include-center'));
  const filterHtml = step.kind === 'terrainEdit'
    ? `<label class="ed-field ed-field-checkbox" data-tooltip="${includeTip}">`
      + `<input type="checkbox" data-area-field="includeCenter"${a.includeCenter === true ? ' checked' : ''} />`
      + '<span class="ed-label">include centre</span></label>'
    : `<label class="ed-field">${labelSpan('faction', 'editor.step.area-faction')}`
      + `<select data-area-field="faction">${optionMarkup(AREA_FACTION_OPTIONS, a.faction ?? 'all')}</select></label>`;
  return `<div class="ed-panel" data-area-panel><div class="ed-grid ed-grid--3">
      <label class="ed-field">${labelSpan('centre', 'editor.step.area-center')}
        <select data-area-field="center">${optionMarkup(TOKEN_REF_OPTIONS, center)}</select></label>
      <label class="ed-field">${labelSpan('radius', 'editor.step.area-radius')}
        <span class="ed-with-unit" data-unit="sq">
          <input type="number" step="1" min="1" max="${MAX_AREA_RADIUS}" data-area-field="radius" value="${radius}"
            placeholder="1" />
        </span></label>
      ${filterHtml}
    </div></div>`;
}

/** The rule text a stock status's card shows on the second row of its fields, before the id tag. */
function statusDescriptionHtml(step) {
  const description = STATUS_EFFECTS[step.preset]?.description;
  if (!description) return '';
  return `<div class="ed-summary eff-status-rule" data-tooltip="${escapeHtml(description)}">`
    + `${escapeHtml(description)}</div>`;
}

/* -------------------------------------------- */
/*  Custom Status Panel                         */
/* -------------------------------------------- */

/** The top-level keys of a custom status's data that the panel writes. Every other key shows in advanced json. */
const PANEL_DATA_KEYS = new Set(['name', 'img', 'description', 'statuses', 'changes', 'flags']);

/** The system flags of a custom status that the panel and the phases field write. */
const PANEL_FLAG_KEYS = new Set([
  'duration', 'harmful', 'beneficial', 'hiddenOnToken', ...END_TRIGGER_KEYS,
  'stackable', 'stackCount', 'stackLimit', 'removeStackWhenHit', 'triggerSheds'
]);

/** The core flags the panel writes: only the status id, which normalizeCustomStatus makes from the name. */
const PANEL_CORE_FLAG_KEYS = new Set(['statusId']);

const POLARITY_OPTIONS = [
  { value: 'neutral', label: 'neutral' },
  { value: 'beneficial', label: 'beneficial' },
  { value: 'harmful', label: 'harmful' }
];

/** The id tag field: the step's `linkAnimationTag`, drawn inside the panel for a custom status. */
const ID_TAG_FIELD = Object.freeze({
  name: 'linkAnimationTag', type: 'text', label: 'id tag', placeholder: 'marked', tooltip: 'editor.status.linked-tag'
});

/** The selector of a modifier row's target input, which the change target picker opens on. */
const CHANGE_KEY_INPUT = '[data-cs-panel] [data-path-input="target"]';

/**
 * A custom status step's data in the shape the panel draws, without changing the step. A step with no data starts
 * from customStatusTemplate, and a duration still saved on the step moves into the data.
 */
function customStatusData(step) {
  return normalizeCustomStatus(isPlainObject(step.customData) ? step.customData : customStatusTemplate(), step);
}

/** A change key as its row shows it: the path under `system.`, or the whole key when it is not under `system.`. */
function changePath(key) {
  return key.startsWith('system.') ? key.slice('system.'.length) : key;
}

/**
 * The change key a row's target input stands for. Text left as it was drawn keeps the key the row was drawn from,
 * so a key outside `system.` survives. Any other text is a path under `system.`, typed with or without that prefix.
 * @param {string} text           What the input holds.
 * @param {string} [drawnKey]     The key the row was drawn from.
 */
function changeKey(text, drawnKey = '') {
  const path = String(text ?? '').trim();
  if (!path) return '';
  if (drawnKey && path === changePath(drawnKey)) return drawnKey;
  return path.startsWith('system.') ? path : `system.${path}`;
}

/**
 * The part of a custom status's data the panel has no field for, which the advanced json box shows: other top-level
 * keys, other system and core flags, and flags of any other scope.
 * @returns {object}
 */
function customStatusExtras(data) {
  const extras = Object.fromEntries(Object.entries(data).filter(([key]) => !PANEL_DATA_KEYS.has(key)));
  const flags = {};
  for (const [scope, value] of Object.entries(isPlainObject(data.flags) ? data.flags : {})) {
    const owned = scope === SYSTEM_ID ? PANEL_FLAG_KEYS : scope === 'core' ? PANEL_CORE_FLAG_KEYS : null;
    if (!owned) {
      flags[scope] = value;
      continue;
    }
    const rest = Object.entries(isPlainObject(value) ? value : {}).filter(([key]) => !owned.has(key));
    if (rest.length) flags[scope] = Object.fromEntries(rest);
  }
  if (Object.keys(flags).length) extras.flags = flags;
  return extras;
}

/**
 * The advanced json box's data with the panel's laid on top. Each top-level key and each system flag the panel writes
 * replaces the box's value whole, so a `triggerSheds` typed in the box cannot add to the panel's choice. The box's
 * other flags are kept.
 * @param {object} box            What the advanced json box holds.
 * @param {object} form           What the panel holds, with its system flags under `flags`.
 * @returns {object}
 */
function panelOverBox(box, form) {
  const flags = isPlainObject(box.flags) ? box.flags : {};
  const system = isPlainObject(flags[SYSTEM_ID]) ? flags[SYSTEM_ID] : {};
  return { ...box, ...form, flags: { ...flags, [SYSTEM_ID]: { ...system, ...form.flags[SYSTEM_ID] } } };
}

/**
 * One modifier row. The value cell holds a number input and a true or false select, and shows the one the target's
 * kind takes; for a target the picker does not offer, the select shows only when the stored value is true or false.
 * A stored value the number input cannot show is kept in its `data-raw`, so a row left untouched saves it back.
 * @param {object} [change]       The row's change, `{key, type, value, priority}`.
 * @param {boolean} [added]       Whether the author just added the row, which lets syncChangeRow pick its type.
 */
function changeRowHtml(change = {}, added = false) {
  const key = typeof change.key === 'string' ? change.key : '';
  const target = changeTargetByKey(key);
  const boolean = target ? target.kind === 'boolean' : typeof change.value === 'boolean';
  const type = typeof change.type === 'string' && change.type ? change.type : 'add';
  const legacy = CHANGE_TYPES.includes(type) ? [] : [{ value: type, label: `${type} (legacy)` }];
  const typeOptions = optionMarkup([...CHANGE_TYPES, ...legacy], type);
  const numeric = typeof change.value === 'number' || (typeof change.value === 'string' && change.value.trim() !== '');
  const number = numeric && Number.isFinite(Number(change.value)) ? String(Number(change.value)) : '';
  const raw = number === '' && change.value !== undefined && !(boolean && typeof change.value === 'boolean')
    ? ` data-raw="${escapeHtml(JSON.stringify(change.value))}"`
    : '';
  const booleanOptions = optionMarkup(['true', 'false'], change.value === false ? 'false' : 'true');
  const defaultPriority = defaultChangePriority(key, type);
  const priority = Number.isFinite(change.priority) && change.priority !== defaultPriority ? change.priority : '';
  const tip = escapeHtml(getTooltip('editor.status.change-delete'));
  return `
    <div class="eff-cs-row" data-change${added ? ' data-change-new' : ''}>
      <span class="eff-cs-cell"><input type="text" class="ed-input mod-expression-input" data-path-input="target"
        data-key="${escapeHtml(key)}" aria-label="modifiers" value="${escapeHtml(changePath(key))}" placeholder="atk"
        autocomplete="off" /></span>
      <select aria-label="how" data-change-how>${typeOptions}</select>
      <span class="eff-cs-cell"><input type="number" step="any" aria-label="value" data-change-num
        value="${escapeHtml(number)}"${raw}${boolean ? ' hidden' : ''} /><select aria-label="value" data-change-bool${
        boolean ? '' : ' hidden'}>${booleanOptions}</select></span>
      <input type="number" step="1" aria-label="priority" data-change-priority value="${priority}"
        placeholder="${defaultPriority}" />
      <button type="button" class="ed-card-btn ed-card-btn--delete" data-action="delete-change" data-tooltip="${tip}">
        <i class="fas fa-trash"></i></button>
    </div>`;
}

/** The phase-or-stack choice under one end trigger's tile. */
function triggerShedsHtml(shedsStack, shown) {
  const button = (shed, label, on) => `<button type="button" class="ed-btn ed-btn--row${on ? ' ed-btn--accent' : ''}"`
    + ` data-shed="${shed}" aria-pressed="${on}">${label}</button>`;
  return `<span class="eff-cs-sheds" data-sheds data-tooltip="${escapeHtml(getTooltip('editor.status.sheds'))}"`
    + `${shown ? '' : ' hidden'}>${button('phase', 'one phase', !shedsStack)}${button('stack', 'one stack', shedsStack)}`
    + '</span>';
}

/**
 * The panel a custom status's card shows under its row of fields, in four sections: what the status is, which
 * triggers wear it down, how it stacks, and the stats it changes. `readCustomStatus` reads it back by
 * `data-cs-panel`, and `syncCustomStatusPanel` keeps its disabled fields and choices current while it is edited.
 * @param {object} data           The step's data, from customStatusData.
 * @param {string} idPrefix       What makes the controls' ids unique within the dialog.
 */
function customStatusPanelHtml(step, data, idPrefix) {
  const flags = data.flags[SYSTEM_ID];
  const id = name => `${idPrefix}cs-${name}`;
  const tip = tooltipId => escapeHtml(getTooltip(tooltipId));
  const checked = on => (on ? ' checked' : '');
  const img = typeof data.img === 'string' ? data.img : '';
  const polarity = flags.harmful ? 'harmful' : flags.beneficial ? 'beneficial' : 'neutral';
  const stackable = flags.stackable === true;
  const showSheds = stackable && flags.duration > 0;
  const stackOff = stackable ? '' : ' ed-field--disabled';
  const stackDisabled = stackable ? '' : ' disabled';

  const identity = `
    <div class="eff-cs-section"><div class="ed-grid ed-grid--3">
      <label class="ed-field">${labelSpan('name', 'editor.status.name')}
        <input type="text" id="${id('name')}" data-cs-field="name" value="${escapeHtml(data.name)}"
          placeholder="Custom Status" /></label>
      <div class="ed-field">
        <label class="ed-label" for="${id('img')}" data-tooltip="${tip('editor.status.icon')}">icon</label>
        <span class="eff-cs-icon">
          <img class="ed-sprite" data-cs-icon src="${escapeHtml(img)}" alt=""${img ? '' : ' hidden'} />
          <input type="text" id="${id('img')}" data-cs-field="img" value="${escapeHtml(img)}" />
          <button type="button" class="ed-card-btn" data-action="browse-icon"
            data-tooltip="${tip('editor.status.browse-icon')}"><i class="fas fa-folder-open"></i></button>
        </span></div>
      ${fieldHtml(ID_TAG_FIELD, step.linkAnimationTag, idPrefix)}
      <label class="ed-field">${labelSpan('polarity', 'editor.status.polarity')}
        <select id="${id('polarity')}" data-cs-field="polarity">${optionMarkup(POLARITY_OPTIONS, polarity)}</select>
      </label>
      <label class="ed-field eff-cs-span2 eff-cs-desc">${labelSpan('description', 'editor.status.description')}
        <textarea id="${id('description')}" data-cs-field="description" rows="2">${
          escapeHtml(data.description ?? '')}</textarea></label>
      <label class="ed-field">${labelSpan('hidden on token', 'editor.status.hidden-on-token')}
        <span class="ed-check-slot"><input type="checkbox" id="${id('hiddenOnToken')}" data-cs-field="hiddenOnToken"${
          checked(flags.hiddenOnToken)} /></span></label>
    </div></div>`;

  const tiles = STATUS_END_TRIGGERS.map(({ key, label, tooltip }) => `
      <div class="ed-check eff-cs-trigger" data-tooltip="${tip(tooltip)}">
        <input type="checkbox" id="${id(key)}" data-trigger="${key}"${checked(flags[key])} /><label
          for="${id(key)}">${escapeHtml(label)}</label>
        ${triggerShedsHtml(flags.triggerSheds?.[key] === true, showSheds && flags[key] === true)}
      </div>`).join('');
  const ends = `
    <div class="eff-cs-section">
      ${labelSpan('ends when', 'editor.status.ends-when')}
      <div class="ed-grid ed-grid--4 eff-cs-ends">${tiles}</div>
    </div>`;

  const stacking = `
    <div class="eff-cs-section">
      <div class="ed-grid ed-grid--4 eff-cs-stacking">
        <label class="ed-field">${labelSpan('stackable', 'editor.status.stackable')}
          <span class="ed-check-slot"><input type="checkbox" id="${id('stackable')}" data-cs-field="stackable"${
            checked(stackable)} /></span></label>
        <label class="ed-field${stackOff}" data-needs-stack>
          ${labelSpan('stacks per application', 'editor.status.stack-count')}
          <input type="number" step="1" min="1" id="${id('stackCount')}" data-cs-field="stackCount"
            value="${escapeHtml(flags.stackCount)}"${stackDisabled} /></label>
        <label class="ed-field${stackOff}" data-needs-stack>${labelSpan('stack limit', 'editor.status.stack-limit')}
          <input type="number" step="1" min="1" id="${id('stackLimit')}" data-cs-field="stackLimit"
            value="${escapeHtml(flags.stackLimit ?? '')}" placeholder="none"${stackDisabled} /></label>
        <label class="ed-field${stackOff}" data-needs-stack>
          ${labelSpan('loses a stack when hit', 'editor.status.stack-hit')}
          <span class="ed-check-slot"><input type="checkbox" id="${id('removeStackWhenHit')}"
            data-cs-field="removeStackWhenHit"${checked(flags.removeStackWhenHit)}${stackDisabled} /></span></label>
      </div>
      <div class="ed-summary eff-cs-hint" data-stack-hint${stackable ? '' : ' hidden'}><span>added values are
        multiplied by the stack count. Each trigger above removes one phase or one stack, as set beneath it.</span></div>
    </div>`;

  const rows = data.changes.map(change => changeRowHtml(isPlainObject(change) ? change : {})).join('');
  const modifiers = `
    <div class="eff-cs-section">
      <div class="eff-cs-changes" data-changes>
        <div class="eff-cs-row eff-cs-row--head" data-changes-head${rows ? '' : ' hidden'}>
          ${labelSpan('modifiers', 'editor.status.change-target')}
          ${labelSpan('how', 'editor.status.change-type')}
          ${labelSpan('value', 'editor.status.change-value')}
          ${labelSpan('priority', 'editor.status.change-priority')}
        </div>
        ${rows}
        <div class="ed-summary" data-changes-empty${rows ? ' hidden' : ''}><span>no changes</span></div>
      </div>
      <div class="ed-add-row">
        <button type="button" class="ed-btn" data-action="add-change"
          data-tooltip="${tip('editor.status.add-change')}">+ change</button>
      </div>
    </div>`;

  return `<div class="ed-panel" data-cs-panel>${identity}${ends}${stacking}${modifiers}</div>`;
}

/**
 * The folded advanced json box under a custom status's card: the data the panel has no field for, empty when the
 * panel covers it all. It is the card's `customData` JSON field, so text that does not parse is held and reported
 * like any other JSON step field. It stays open across repaints once the author opens it.
 * @param {object} data           The step's data, from customStatusData.
 */
function customStatusJsonHtml(step, data) {
  const cardId = stepCards.state.identify(step);
  const json = jsonFieldText(step, 'customData', () => {
    const extras = customStatusExtras(data);
    return Object.keys(extras).length ? compactJson(extras) : '';
  });
  const open = stepCards.state.isSet(cardId, 'jsonOpen') || stepCards.state.text(cardId, 'customData');
  return `
      <details data-cs-json${open ? ' open' : ''}>
        <summary data-tooltip="${escapeHtml(getTooltip('editor.status.advanced-json'))}">advanced json</summary>
        <textarea${jsonFieldMark(step, 'customData')} data-step-field="customData" aria-label="advanced json"
          rows="4" placeholder="{ }">${escapeHtml(json)}</textarea>
      </details>`;
}

/**
 * The value a descriptor shows for a step: restore-action boxes read the actions list, an area target shows as the
 * `area` choice with its panel beneath, and the reapplication select shows `durationStacks` as text.
 */
function stepFieldValue(step, field) {
  if (step.kind === 'restoreAction' && ['standard', 'bonus', 'movement', 'turn'].includes(field.name)) {
    return Array.isArray(step.actions) && step.actions.includes(field.name);
  }
  if (field.name === 'target' && isAreaTargetStep(step)) return 'area';
  if (step.kind === 'applyEffect' && field.name === 'durationStacks') return String(step.durationStacks === true);
  return step[field.name];
}

/**
 * The body of an animation card: the status link row, shown only while the animation is persistent, then the two
 * switches and the button that opens the animation editor. The animation itself is kept in a hidden textarea, and
 * the unit it attaches to in a hidden input that `deriveAnimationAttachTargets` rewrites on save.
 * @param {string} idPrefix       What makes the controls' ids unique within the dialog.
 */
function animationBodyHtml(step, idPrefix) {
  const [persistent, awaits, tag, tieName] = FIELDS_BY_KIND.animation;
  const animJson = jsonFieldText(step, 'animation', () => step.animation ? JSON.stringify(step.animation) : '');
  const count = Array.isArray(step.animation?.steps) ? step.animation.steps.length : 0;
  const on = step.persistent === true;
  const check = (field, value, disabled) =>
    `<label class="ed-check${disabled ? ' ed-field--disabled' : ''}"`
    + ` data-tooltip="${escapeHtml(getTooltip(field.tooltip))}">`
    + `<input type="checkbox" id="${idPrefix}${field.name}" data-step-field="${field.name}"`
    + `${value ? ' checked' : ''}${disabled ? ' disabled' : ''} /><span>${escapeHtml(field.label)}</span></label>`;
  return `
    <div class="ed-grid ed-grid--2"${on ? '' : ' hidden style="display:none"'}>
      ${fieldHtml(tag, step.tag, idPrefix)}
      ${fieldHtml(tieName, step.attachToEffectName, idPrefix)}
    </div>
    <div class="ed-grid" style="grid-template-columns:auto auto minmax(0,1fr)">
      ${check(persistent, on, !on && step.await === true)}
      ${check(awaits, step.await === true && !on, on)}
      <button type="button" class="ed-btn ed-btn--accent" data-action="edit-animation"
        data-tooltip="${escapeHtml(getTooltip('editor.animation.edit'))}">Edit Animation Steps (${count})</button>
    </div>
    <textarea${jsonFieldMark(step, 'animation')} data-step-field="animation" hidden>${escapeHtml(animJson)}</textarea>
    <input type="hidden" data-step-field="attachTarget" value="${escapeHtml(step.attachTarget ?? '')}" />`;
}

/**
 * The body of a move card: who moves and how, the fields the chosen mode needs, the geometry panel for a move by
 * rule, and the walls switch last whatever the mode. `MOVE_FIELDS_BY_MODE` decides which fields show.
 * @param {string} idPrefix       What makes the controls' ids unique within the dialog.
 */
function moveBodyHtml(step, idPrefix) {
  const cells = FIELDS_BY_KIND.moveToken
    .filter(f => isStepFieldShown(step, f.name))
    .map(f => {
      const field = f.name === 'pair' ? { ...f, label: MOVE_PAIR_LABELS[step.mode] ?? f.label } : f;
      return fieldHtml(field, step[f.name], idPrefix);
    });
  if (isGeometryMoveStep(step)) {
    const panel = `<div class="ed-span">${renderTerrainGeometryPanel(step.geometry, { context: 'step' })}</div>`;
    cells.splice(Math.max(0, cells.length - 1), 0, panel);
  }
  return `<div class="ed-grid ed-grid--3">${cells.join('')}</div>`;
}

/** An add-step control: the button, and the search box `attachAddStepPicker` reveals beside it. */
function addStepControlHtml() {
  return `<button type="button" class="ed-btn ed-btn--accent" data-action="add-step"`
    + ` data-tooltip="${escapeHtml(getTooltip('editor.effect.add-step'))}">+ add step</button>`
    + '<input type="text" class="ed-add-step-search" data-role="add-step-search" placeholder="search steps" hidden />';
}

/**
 * One branch of an if card: its label, its own card list and its add row.
 * @param {string} name                   `then` or `else`.
 * @param {object[]} steps                The branch's steps.
 * @param {object} context                The owning card's position, depth tint and whether an else exists.
 */
function branchHtml(name, steps, { idx, parentPath, childDepth, tint, hasElse }) {
  const inner = (steps || []).map((s, i) => renderStepCard(s, i, `${parentPath}-${idx}-${name}`, childDepth)).join('');
  const removeHtml = name === 'else'
    ? '<button type="button" class="eff-if-branch-remove" data-action="remove-else"'
      + ' data-tooltip="Remove the else branch"><i class="fas fa-xmark"></i></button>'
    : '';
  const addElseHtml = name === 'then' && !hasElse
    ? '<button type="button" class="ed-btn" data-action="add-else" data-tooltip="Add an else branch">+ else</button>'
    : '';
  return `
      <div class="eff-if-branch" data-branch="${name}" data-depth="${tint}">
        <div class="eff-if-branch-label"><span>${name}</span>${removeHtml}</div>
        <div class="ed-list" data-branch-list="${name}">${inner || EMPTY_SLOT_HTML}</div>
        <div class="ed-add-row">${addStepControlHtml()}${addElseHtml}</div>
      </div>`;
}

/**
 * The body of an if card: the condition builder's host, then the branches. The starting condition is stored on the
 * host for `mountStepConditions` to read once the markup is in the document.
 * @param {number} idx            Its position in the list it sits in.
 * @param {string} parentPath     The path of that list, which makes field ids unique.
 * @param {number} depth          Nesting depth, which tints a branch.
 */
function ifBodyHtml(step, idx, parentPath, depth) {
  const condSeed = escapeHtml(JSON.stringify(step.condition ?? null));
  const context = { idx, parentPath, childDepth: depth + 1, tint: (depth + 1) % 5, hasElse: Array.isArray(step.else) };
  const folded = stepCards.state.isSet(stepCards.state.identify(step), 'conditionFolded');
  return `
      <div class="eff-if-condition${folded ? ' is-folded' : ''}" data-condition-host data-condition="${condSeed}">
        <button type="button" class="eff-if-condition-line" data-action="toggle-condition"
          data-tooltip="Show or hide the condition's rules">
          <i class="fas fa-chevron-right eff-if-condition-caret"></i>
          <span class="eff-if-condition-text" data-condition-line>${conditionLineHtml(step.condition ?? null)}</span>
        </button>
        <div class="eff-if-condition-tree mod-tree-root">
          <div class="mod-tree-contents" data-condition-tree></div>
        </div>
      </div>
      ${branchHtml('then', step.then, context)}
      ${context.hasElse ? branchHtml('else', step.else, context) : ''}`;
}

/**
 * The body of one step card. Animations, moves, guards and ifs lay themselves out. Every other kind shows the
 * descriptors isStepFieldShown keeps in a three-column grid, then the area or terrain panel its kind adds. An
 * apply-status card uses four columns and ends with its stock status's description, or with the custom status
 * panel, whose phases field reads the duration in the status's own data.
 * @param {number} idx            Its position in the list it sits in.
 * @param {string} parentPath     The path of that list, which makes field ids unique.
 * @param {number} depth          Nesting depth, which tints a branch.
 * @param {object|null} [custom]  A custom status step's data, from customStatusData; null for any other step.
 */
function stepBodyHtml(step, idx, parentPath, depth, custom = null) {
  const idPrefix = `eff-${parentPath}-${idx}-`;
  switch (step.kind) {
    case 'animation': return animationBodyHtml(step, idPrefix);
    case 'moveToken': return moveBodyHtml(step, idPrefix);
    case 'guard': return '<div class="ed-summary">runs on the target</div>';
    case 'if': return ifBodyHtml(step, idx, parentPath, depth);
    default: break;
  }
  const status = step.kind === 'applyEffect';
  const cells = (FIELDS_BY_KIND[step.kind] || []).filter(f => isStepFieldShown(step, f.name)).map(f => {
    if (custom && f.name === 'durationPhases') {
      return fieldHtml({ ...f, min: 0, tooltip: 'editor.status.phases' }, custom.flags[SYSTEM_ID].duration, idPrefix);
    }
    const ownershipHidden = step.kind === 'setFaction' && f.name === 'grantOwnership' && step.target !== 'target';
    const field = ownershipHidden ? { ...f, hidden: true } : f;
    return fieldHtml(field, stepFieldValue(step, f), idPrefix);
  });
  // A stock status's rule text takes the second row's first three columns, with the id tag in the fourth.
  if (status && !custom) cells.splice(Math.max(0, cells.length - 1), 0, statusDescriptionHtml(step));
  const grid = cells.join('') ? `<div class="ed-grid ed-grid--${status ? 4 : 3}">${cells.join('')}</div>` : '';
  const area = isAreaTargetStep(step) ? areaPanelHtml(step) : '';
  const terrain = step.kind === 'terrainEdit' ? renderTerrainEditPanel(step) : '';
  const panel = custom ? customStatusPanelHtml(step, custom, idPrefix) : '';
  return `${grid}${area}${terrain}${panel}`;
}

/**
 * Render an effect step as one card: the header with its grip, kind, ordinal, summary and actions, then the body
 * `stepBodyHtml` builds. An apply-status card also shows its status's icon in the header, and a custom status adds
 * its advanced json box under the body. The branches of an if step render their own cards the same way.
 * @param {number} idx                    Its position within its own list.
 * @param {string} [parentPath]           Its path, for unique element ids.
 * @param {number} [depth]                How deeply nested it is.
 */
function renderStepCard(step, idx, parentPath = 'root', depth = 0) {
  const cardId = stepCards.state.identify(step);
  const collapsed = stepCards.state.isSet(cardId, 'collapsed');
  const rail = step.kind === 'if' ? ` data-rail="${(depth + 1) % 5}"` : '';
  const tip = id => escapeHtml(getTooltip(id));
  const kindTip = escapeHtml(getTooltip('editor.card.kind', { kind: step.kind }));
  const status = step.kind === 'applyEffect';
  const custom = status && step.preset === 'custom';
  const shown = custom ? { ...step, customData: customStatusData(step) } : step;
  return `
    <div class="ed-card${collapsed ? ' is-collapsed' : ''}" data-card-id="${cardId}" data-step-idx="${idx}"
      data-step-kind="${escapeHtml(step.kind)}" data-step-path="${escapeHtml(parentPath)}"
      data-depth="${depth % 5}"${rail}>
      <div class="ed-card-header" data-action="toggle-collapse">
        <span class="ed-card-grip" draggable="true" data-tooltip="${tip('editor.card.drag')}">
          <i class="fas fa-grip-vertical"></i></span>
        <button type="button" class="ed-card-chevron" data-action="toggle-collapse"
          data-tooltip="${tip('editor.card.collapse')}"><i class="fas fa-chevron-down"></i></button>
        ${status ? statusSpriteHtml(shown) : ''}
        <span class="ed-card-kind" data-tooltip="${kindTip}">${escapeHtml(stepKindLabel(step.kind))}</span>
        <span class="ed-card-idx">#${idx + 1}</span>
        <span class="ed-card-summary">${escapeHtml(stepSummaryText(shown))}</span>
        <span class="ed-card-actions">
          <button type="button" class="ed-card-btn" data-action="duplicate"
            data-tooltip="${tip('editor.card.duplicate')}"><i class="fas fa-clone"></i></button>
          <button type="button" class="ed-card-btn ed-card-btn--delete" data-action="delete"
            data-tooltip="${tip('editor.card.delete')}"><i class="fas fa-trash"></i></button>
        </span>
      </div>
      <div class="ed-card-body">${stepBodyHtml(step, idx, parentPath, depth, custom ? shown.customData : null)}</div>${
        custom ? customStatusJsonHtml(step, shown.customData) : ''}
    </div>`;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/**
 * The builder handle mounted on each condition host, which lets the template selector in `attachStepChanges`
 * replace a tree without mounting a second builder on the same host.
 * @type {WeakMap<HTMLElement, object>}
 */
const conditionBuilders = new WeakMap();

/**
 * The first element matching a selector inside this card's own body, never one belonging to a step nested inside
 * one of its branches.
 */
function ownElement(cardEl, selector) {
  for (const el of cardEl.querySelectorAll(selector)) {
    if (el.closest(CARD) === cardEl) return el;
  }
  return null;
}

/** The condition host of this card, never one belonging to a step nested inside it. */
function ownConditionHost(cardEl) {
  return ownElement(cardEl, '[data-condition-host]');
}

/** This card's own control for a step field. */
function ownStepField(cardEl, name) {
  return ownElement(cardEl, `[data-step-field="${name}"]`);
}

/**
 * Mount the shared condition builder on every if step that doesn't have one yet. Each repaint replaces the markup,
 * so the starting condition is stored on the host element and read once.
 * @param {HTMLElement} root   The dialog, or the list that was just painted.
 */
function mountStepConditions(root) {
  for (const host of root.querySelectorAll('[data-condition-host]')) {
    if (host.dataset.conditionMounted === '1') continue;
    host.dataset.conditionMounted = '1';
    let initialTree = null;
    try {
      initialTree = JSON.parse(host.dataset.condition || 'null');
    } catch {
      initialTree = null;
    }
    const builder = mountConditionTreeBuilder(host.querySelector('[data-condition-tree]'), {
      initialTree,
      scopeEl: host,
      rootActionsHtml: conditionTemplateSelectHtml(),
      summaryEls: { summary: host.querySelector(':scope > .eff-if-condition-line [data-condition-line]') }
    });
    conditionBuilders.set(host, builder);
  }
}

/** The template selector that `mountConditionTreeBuilder` paints into the root group's action cluster. */
function conditionTemplateSelectHtml() {
  return '<select class="mod-group-template" data-cond-template'
    + ` data-tooltip="Replace this condition with a template">${conditionTemplateOptions()}</select>`;
}

/**
 * Read the terrain panel back onto its step. A blank number is left off the step, except a blank duration, which
 * saves as 0 (permanent). A preset replaces every parameter with its own, and the two switches that default on are
 * only written when turned off.
 * @param {object} step          The step read so far, which this completes in place.
 */
function readTerrainEditPanel(panel, step) {
  const el = (n) => panel.querySelector(`[data-step-field="${n}"]`);
  const readNum = (n) => {
    const e = el(n);
    if (!e || e.value === '') return undefined;
    const v = Number(e.value);
    return Number.isFinite(v) ? v : undefined;
  };
  const readOn = (n) => (el(n)?.checked ? true : undefined);
  const readOffOnly = (n) => {
    const e = el(n);
    if (!e) return undefined;
    return e.checked ? undefined : false;
  };
  const readStr = (n) => {
    const v = (el(n)?.value ?? '').trim();
    return v === '' ? undefined : v;
  };
  const put = (k, v) => { if (v !== undefined) step[k] = v; };

  put('overwrite', readOn('overwrite'));
  put('duration', readNum('duration') ?? 0);
  put('replacePrevious', readOn('replacePrevious'));
  for (const k of ['eva', 'def', 'res', 'mov', 'variable', 'stn']) put(k, readNum(k));
  put('effect', readStr('effect'));
  put('canKillPlayer', readOn('canKillPlayer'));
  put('vfxEffect', readStr('vfxEffect'));
  for (const k of ['vfxScale', 'vfxOpacity', 'vfxRotation']) put(k, readNum(k));
  put('vfxMirrorX', readOn('vfxMirrorX'));
  put('vfxMirrorY', readOn('vfxMirrorY'));
  put('lightDim', readNum('lightDim'));
  put('lightBright', readNum('lightBright'));
  const lightColor = el('lightColor')?.value;
  if (lightColor && lightColor.toLowerCase() !== '#ffffff') step.lightColor = lightColor;
  put('lightAlpha', readNum('lightAlpha'));
  put('lightAnimType', readStr('lightAnimType'));
  put('lightWalls', readOffOnly('lightWalls'));
  put('lightVision', readOffOnly('lightVision'));
  for (const k of ['lightAnimSpeed', 'lightAnimIntensity', 'lightColoration', 'lightLuminosity', 'lightAttenuation',
    'lightSaturation', 'lightContrast', 'lightShadows']) put(k, readNum(k));
  put('presetTile', readStr('presetTile'));
  if (step.presetTile) {
    const presetParams = _terrainPresetParams(step.presetTile);
    if (presetParams) {
      for (const k of TERRAIN_EDIT_PARAM_KEYS) delete step[k];
      Object.assign(step, terrainEditFieldsFromPreset(presetParams));
    }
  }
}

/**
 * Read the area panel back as the step's target.
 * @param {HTMLElement|null} panel        The panel `areaPanelHtml` drew.
 * @param {string} kind                   The step kind: a terrain edit takes no faction and may include the centre.
 */
function readAreaTarget(panel, kind) {
  const center = panel?.querySelector('[data-area-field="center"]')?.value || 'self';
  const faction = panel?.querySelector('[data-area-field="faction"]')?.value || 'all';
  const radiusRaw = panel?.querySelector('[data-area-field="radius"]')?.value;
  const radius = radiusRaw !== undefined && radiusRaw !== '' && Number.isFinite(Number(radiusRaw))
    ? Math.min(MAX_AREA_RADIUS, Math.max(1, Math.floor(Number(radiusRaw))))
    : 1;
  if (kind !== 'terrainEdit') return { area: { center, radius, faction } };
  const target = { area: { center, radius } };
  if (panel?.querySelector('[data-area-field="includeCenter"]')?.checked === true) target.area.includeCenter = true;
  return target;
}

/** A number input's value, or null when it is blank or not a number. */
function readNumberInput(input) {
  const text = String(input?.value ?? '').trim();
  const number = Number(text);
  return text !== '' && Number.isFinite(number) ? number : null;
}

/**
 * Read one modifier row back as a change. A blank priority is left off, so normalizeCustomStatus gives the row its
 * type's default, and a blank value that was drawn from a stored value the number input could not show saves that
 * stored value.
 */
function readChangeRow(row) {
  const keyInput = row.querySelector('[data-path-input="target"]');
  const change = {
    key: changeKey(keyInput?.value, keyInput?.dataset.key),
    type: row.querySelector('[data-change-how]')?.value || 'add'
  };
  const boolean = row.querySelector('[data-change-bool]');
  const numberInput = row.querySelector('[data-change-num]');
  let value;
  if (boolean && !boolean.hidden) value = boolean.value === 'true';
  else if (readNumberInput(numberInput) !== null) value = readNumberInput(numberInput);
  else if (numberInput?.value.trim() === '' && numberInput.dataset.raw !== undefined) {
    value = JSON.parse(numberInput.dataset.raw);
  }
  if (value !== undefined) change.value = value;
  const priority = readNumberInput(row.querySelector('[data-change-priority]'));
  if (priority !== null) change.priority = priority;
  return change;
}

/**
 * Read a custom status card back as the step's `customData`. The panel and the phases field give what they cover,
 * laid over whatever the advanced json box holds, and normalizeCustomStatus then makes the status id from the name
 * and fills the defaults. The phases field's value moves into the data, so the step keeps no `durationPhases`. A card
 * drawn before its status was custom has no panel yet, and starts from customStatusTemplate.
 * @param {object} step          The step read so far. Its `durationPhases` is taken off it.
 * @returns {object}
 */
function readCustomStatus(cardEl, step) {
  const duration = step.durationPhases;
  delete step.durationPhases;
  const panel = ownElement(cardEl, '[data-cs-panel]');
  if (!panel) return normalizeCustomStatus(customStatusTemplate(), { durationPhases: duration });

  const cardId = stepCards.state.identify(step);
  stepCards.state.set(cardId, 'jsonOpen', ownElement(cardEl, '[data-cs-json]')?.open === true);
  const field = name => panel.querySelector(`[data-cs-field="${name}"]`);
  const polarity = field('polarity')?.value;
  const status = {
    duration: duration ?? DEFAULT_STATUS_DURATION,
    harmful: polarity === 'harmful',
    beneficial: polarity === 'beneficial',
    hiddenOnToken: field('hiddenOnToken')?.checked === true,
    stackable: field('stackable')?.checked === true,
    stackCount: readNumberInput(field('stackCount')),
    stackLimit: readNumberInput(field('stackLimit')),
    removeStackWhenHit: field('removeStackWhenHit')?.checked === true,
    triggerSheds: {}
  };
  for (const box of panel.querySelectorAll('[data-trigger]')) {
    const key = box.dataset.trigger;
    status[key] = box.checked;
    const shedsStack = box.parentElement?.querySelector('[data-shed="stack"]')?.getAttribute('aria-pressed') === 'true';
    if (box.checked && shedsStack) status.triggerSheds[key] = true;
  }
  const form = {
    name: field('name')?.value ?? '',
    img: field('img')?.value.trim() ?? '',
    description: field('description')?.value ?? '',
    changes: [...panel.querySelectorAll('[data-change]')].map(readChangeRow),
    flags: { [SYSTEM_ID]: status }
  };
  const extras = readStepJson(ownStepField(cardEl, 'customData'), cardId, 'customData');
  return normalizeCustomStatus(panelOverBox(isPlainObject(extras?.value) ? extras.value : {}, form), step);
}

/**
 * Read the panel a step kind adds to its card back onto the step.
 * @param {string} kind          The step kind, which decides which panel is there to read.
 * @param {object} step          The step read so far, which this completes in place.
 */
function readStepPanels(cardEl, kind, step) {
  if (kind === 'terrainEdit') {
    const panel = ownElement(cardEl, '[data-terrain-panel]');
    if (panel) readTerrainEditPanel(panel, step);
  }

  if (kind === 'moveToken') {
    const panel = ownElement(cardEl, '[data-tg-panel]');
    if (step.mode === 'terrainGeometry' && panel) step.geometry = readTerrainGeometryPanel(panel);
    else delete step.geometry;
  }

  if (kind === 'if') {
    const thenList = ownElement(cardEl, '[data-branch-list="then"]');
    const elseList = ownElement(cardEl, '[data-branch-list="else"]');
    step.then = thenList ? stepCards.read(thenList) : [];
    if (elseList) step.else = stepCards.read(elseList);
  }

  if (kind === 'restoreAction') {
    const actions = [];
    for (const a of ['standard', 'bonus', 'movement', 'turn']) {
      if (step[a] === true) actions.push(a);
      delete step[a];
    }
    step.actions = actions;
  }

  if (kind === 'applyEffect') {
    if (step.durationStacks === 'true') step.durationStacks = true;
    else delete step.durationStacks;
    if (step.preset === 'custom') {
      step.customData = readCustomStatus(cardEl, step);
    } else {
      const d = Number(step.durationPhases);
      step.durationPhases = Number.isFinite(d) && d >= 1 ? d : DEFAULT_STATUS_DURATION;
    }
  }

  if (kind === 'animation') {
    if (step.persistent && step.await) delete step.await;
    const kept = ownStepField(cardEl, 'attachTarget')?.value;
    if (kept) step.attachTarget = kept;
  }

  if (kind === 'guard') step.target = 'target';

  if (AOE_KINDS.has(kind) && step.target === 'area') {
    step.target = readAreaTarget(ownElement(cardEl, '[data-area-panel]'), kind);
  }
}

/**
 * Read one card back into a step. The card's display state is recorded against its id in `stepCards.state`, never
 * on the step, so the step holds only authored data. readEntryFromDom still prunes and completes it before a save.
 */
function readStepFromCard(cardEl) {
  const kind = cardEl.dataset.stepKind;
  if (!STEP_KINDS.includes(kind)) return null;
  const step = { kind };
  const cardId = stepCards.state.adopt(step, cardEl.dataset.cardId);
  stepCards.state.set(cardId, 'collapsed', cardEl.classList.contains('is-collapsed'));
  const fields = FIELDS_BY_KIND[kind] || [];
  for (const f of fields) {
    const input = ownStepField(cardEl, f.name);
    if (!input) continue;
    const v = readField(f, input);
    if (v !== undefined && v !== '') step[f.name] = v;
  }

  const animTa = ownStepField(cardEl, 'animation');
  const animation = readStepJson(animTa, cardId, 'animation');
  if (animation) step.animation = animation.value;
  else if (kind === 'animation' && !animTa?.value.trim()) step.animation = { steps: [] };
  const conditionHost = ownConditionHost(cardEl);
  if (conditionHost) {
    stepCards.state.set(cardId, 'conditionFolded', conditionHost.classList.contains('is-folded'));
    const tree = readConditionTree(conditionHost.querySelector('[data-condition-tree]'));
    if (tree) step.condition = tree;
  }
  readStepPanels(cardEl, kind, step);
  return step;
}

/**
 * Draw a list of steps, or the empty marker where there are none, then mount a builder on each condition the paint
 * replaced.
 */
function paintStepList(listEl, steps) {
  const path = listEl.dataset.branchList ? `nested-${listEl.dataset.branchList}` : 'root';
  stepCards.paint(listEl, steps, { path, depth: 0 });
  mountStepConditions(listEl);
}

/** The condition template selector's options, grouped as the templates declare. */
function conditionTemplateOptions() {
  const groups = conditionTemplateGroups().map(g =>
    `<optgroup label="${escapeHtml(g.label)}">${g.items
      .map(t => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.label)}</option>`).join('')}</optgroup>`
  ).join('');
  return `<option value="">template...</option>${groups}`;
}

/** Hide the condition templates that read the other unit when the trigger has no other unit. */
function fitConditionTemplates(select, trigger) {
  const noOtherUnit = TRIGGER_CAPABILITIES[trigger]?.target === 'none';
  for (const option of select.options) {
    option.hidden = noOtherUnit && readsOtherUnit(conditionTemplateTree(option.value));
  }
  for (const group of select.querySelectorAll('optgroup')) {
    group.hidden = [...group.children].every(option => option.hidden);
  }
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * The step fields authored as raw JSON, and so the ones that can be malformed: a custom status's advanced json box
 * and an animation step's hidden animation field.
 * @type {string[]}
 */
const JSON_STEP_FIELDS = ['customData', 'animation'];

/** How each JSON step field is named in the message about text that doesn't parse. */
const JSON_STEP_FIELD_WORDS = Object.freeze({ customData: 'advanced json', animation: 'animation' });

/**
 * Every error and warning for the effect as it stands. Broken JSON is reported first, by step number. The entry is
 * also checked against the item it is on.
 * @param {object} state                  The editor's state, whose source entry the read entry keeps its fields from.
 * @returns {{errors: string[], warnings: string[]}}
 */
function collectValidationErrors(dialogEl, state) {
  const errors = [];
  const unparsed = [];

  for (const ta of dialogEl.querySelectorAll('textarea[data-step-field]')) {
    const field = ta.dataset.stepField;
    if (!JSON_STEP_FIELDS.includes(field)) continue;
    if (!('invalid' in parseCardJson(ta.value))) continue;
    const index = Number(ta.closest(CARD)?.dataset.stepIdx);
    unparsed.push({ index: Number.isInteger(index) ? index : null, field: JSON_STEP_FIELD_WORDS[field] });
  }
  errors.push(...unparsedJsonErrors(unparsed, 'step'));

  const r = validateEntryOnItem(readEntryFromDom(dialogEl, state.entry), state.document);
  errors.push(...r.errors);
  return { errors, warnings: r.warnings };
}

/** Validate an entry against the item it is on, so triggers and steps that can't work on that item are caught. */
function validateEntryOnItem(entry, document) {
  return validateEffectEntry(entry, { carrier: document ? effectCarrier(document) : null });
}

/**
 * Show the effect's validation errors, then its warnings, and disable Save while there are errors, naming the first
 * in the button's tooltip. Warnings don't block Save, and already open with `Warning:`. A read that fails on a
 * half-finished card counts as an error, so partial edits can't leave Save enabled.
 */
function refreshValidation(dialogEl, state) {
  let errors;
  let warnings = [];
  try { ({ errors, warnings } = collectValidationErrors(dialogEl, state)); }
  catch (err) {
    reportFoundryProbe(import.meta.url, err, 'refreshValidation', err instanceof SyntaxError);
    errors = ['A step cannot be read yet. Finish filling it in.'];
  }

  const bar = dialogEl.querySelector('[data-role="validation"]');
  if (bar) {
    const messages = [...errors, ...warnings];
    const hidden = messages.length - 4;
    const extra = hidden === 1 ? ' There is 1 more.' : hidden > 1 ? ` There are ${hidden} more.` : '';
    bar.textContent = messages.slice(0, 4).join(' ') + extra;
    bar.hidden = messages.length === 0;
  }

  const saveBtn = dialogEl.querySelector('button[data-action="save"]');
  if (!saveBtn) return;
  saveBtn.disabled = errors.length > 0;
  if (errors.length) saveBtn.dataset.tooltip = getTooltip('editor.save-disabled', { error: errors[0] });
  else delete saveBtn.dataset.tooltip;
}

/* -------------------------------------------- */
/*  Animation targets                           */
/* -------------------------------------------- */

/**
 * Give every tagged animation step the unit its linked status is applied to, so the visual attaches where the
 * status lives. The Apply status step carrying the same `linkAnimationTag` is looked for through the whole entry,
 * branches included: a plain token reference on it wins, an `attachTarget` the animation already carries is kept
 * otherwise, and `target` is the fallback. `prepareEffectAnimation` in effect-execution.mjs reads the result.
 * @param {object[]} steps        The entry's steps, changed in place.
 * @returns {object[]}            The same steps.
 */
export function deriveAnimationAttachTargets(steps) {
  const targetsByTag = new Map();
  const animations = [];
  const walk = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (!step || typeof step !== 'object') continue;
      if (step.kind === 'applyEffect' && typeof step.linkAnimationTag === 'string' && step.linkAnimationTag) {
        if (!targetsByTag.has(step.linkAnimationTag)) targetsByTag.set(step.linkAnimationTag, step.target);
      } else if (step.kind === 'animation' && typeof step.tag === 'string' && step.tag) {
        animations.push(step);
      }
      if (step.kind === 'if') {
        walk(step.then);
        walk(step.else);
      }
    }
  };
  walk(steps);
  for (const step of animations) {
    const linked = targetsByTag.get(step.tag);
    if (linked === 'self' || linked === 'target') step.attachTarget = linked;
    else if (typeof step.attachTarget !== 'string' || !step.attachTarget) step.attachTarget = 'target';
  }
  return steps;
}

/* -------------------------------------------- */
/*  Handlers                                    */
/* -------------------------------------------- */

/**
 * Bind the effect card controls on the dialog root. Each handler reads the whole action back from the DOM before
 * changing and repainting it, and validation reruns after every input, change and click.
 */
function attachHandlers(dialogEl, state) {
  const rootList = dialogEl.querySelector('.ed-list[data-branch-list="root"]');
  bindTerrainGeometryPanels(dialogEl);
  const repaint = () => {
    paintStepList(rootList, state.action.steps);
    syncTriggerFields(dialogEl);
    syncCollapseAllLabel(dialogEl);
    refreshValidation(dialogEl, state);
  };

  dialogEl.querySelector('[data-action="collapse-all"]')?.addEventListener('click', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const cards = [...dialogEl.querySelectorAll(CARD)];
    if (cards.length === 0) return;
    const collapsing = anyCardExpanded(stepCards.state, cards.map(c => c.dataset.cardId));
    for (const c of cards) {
      c.classList.toggle('is-collapsed', collapsing);
      stepCards.state.set(c.dataset.cardId, 'collapsed', collapsing);
    }
    syncCollapseAllLabel(dialogEl);
  });

  attachAddStepPicker(dialogEl, state, rootList, repaint);
  attachStepButtons(dialogEl, state, repaint);
  attachBranchControls(dialogEl, state, repaint);
  attachStepChanges(dialogEl, state, repaint);
  attachStatusCards(dialogEl);
  attachEntryClipboard(dialogEl, state, repaint);
  attachStepDragAndDrop(dialogEl, state, repaint);

  dialogEl.querySelector('[data-entry-field="trigger"]')
    ?.addEventListener('change', () => syncTriggerFields(dialogEl));

  const revalidate = foundry.utils.debounce(() => refreshValidation(dialogEl, state), 150);
  dialogEl.addEventListener('input', revalidate);
  dialogEl.addEventListener('change', revalidate);
  dialogEl.addEventListener('click', revalidate);
  syncTriggerFields(dialogEl);
  syncCollapseAllLabel(dialogEl);
  refreshValidation(dialogEl, state);
}

/** The trigger the dialog's trigger select holds now. */
function currentTrigger(dialogEl) {
  return dialogEl.querySelector('[data-entry-field="trigger"]')?.value ?? '';
}

/** The selects whose choices name a unit or a square, on step cards, area panels and move-by-rule panels. */
const REFERENCE_SELECTS = [
  'select[data-step-field="target"]', 'select[data-step-field="pair"]', 'select[data-step-field="location"]',
  'select[data-step-field="placedByActor"]', 'select[data-area-field="center"]', 'select[data-tg-field="anchor"]'
].join(', ');

/**
 * Fit the dialog to its trigger: show the item names box only for On Use Item, and hide each unit or square choice
 * the trigger can't supply. A card keeps the choice it already holds, which the validation bar then explains. Runs
 * when the trigger changes and after every repaint.
 */
function syncTriggerFields(dialogEl) {
  const trigger = currentTrigger(dialogEl);
  const names = dialogEl.querySelector('[data-role="item-names"]');
  if (names) names.hidden = trigger !== 'onUseItem';
  for (const select of dialogEl.querySelectorAll(REFERENCE_SELECTS)) {
    const castArea = select.dataset.stepField === 'target' && select.closest(CARD)?.dataset.stepKind === 'terrainEdit';
    for (const option of select.options) option.hidden = !referenceOffered(option.value, trigger, { castArea });
  }
}

/** Set the collapse-all button's label from the cards' current state. */
function syncCollapseAllLabel(dialogEl) {
  const button = dialogEl.querySelector('[data-action="collapse-all"]');
  if (!button) return;
  const ids = [...dialogEl.querySelectorAll(CARD)].map(card => card.dataset.cardId);
  if (!ids.length) return;
  button.textContent = anyCardExpanded(stepCards.state, ids) ? 'collapse all' : 'expand all';
}

/**
 * Copy a step for the duplicate button. The copy is a fresh card, so it takes its own id from `stepCards.state` and
 * shows what the original showed (collapsed or expanded, condition folded or open), down through its branches.
 */
function copyStep(step) {
  const copy = foundry.utils.deepClone(step);
  inheritStepDisplay(step, copy);
  return copy;
}

/** Walk a duplicated step and its branches in step with the original, giving each copy the original's display. */
function inheritStepDisplay(source, copy) {
  stepCards.state.inherit(source, copy);
  for (const branch of ['then', 'else']) {
    const from = Array.isArray(source?.[branch]) ? source[branch] : null;
    const to = Array.isArray(copy?.[branch]) ? copy[branch] : null;
    if (!from || !to) continue;
    for (let i = 0; i < Math.min(from.length, to.length); i++) inheritStepDisplay(from[i], to[i]);
  }
}

/** Whether the add-step picker offers a template on a trigger: each of its step kinds, and what TEMPLATE_NEEDS asks. */
function templateOffered(key, steps, trigger) {
  const cap = TRIGGER_CAPABILITIES[trigger];
  return steps.every(step => stepKindOffered(step.kind, trigger)) && (!cap || (TEMPLATE_NEEDS[key]?.(cap) ?? true));
}

/**
 * The add-step picker's rows on a trigger: each template and kind it offers there, each keyed by the text the row
 * shows so a pick can be turned back into the steps it adds, fitted to that trigger.
 * @returns {{groups: object[], byValue: Map<string, Function>}}
 */
function addStepRows(trigger) {
  const byValue = new Map();
  const fitted = steps => steps.map(step => fitStepToTrigger(step, trigger));
  const templates = Object.entries(TEMPLATES)
    .filter(([key, make]) => key !== 'default' && templateOffered(key, make().steps, trigger))
    .map(([key, make]) => {
      const value = TEMPLATE_LABELS[key] ?? key;
      const count = make().steps.length;
      byValue.set(value.toLowerCase(), () => fitted(make().steps));
      return { value, label: `adds ${count} step${count === 1 ? '' : 's'}` };
    });
  const groups = [{ label: 'Templates', entries: templates }];
  for (const group of ADD_STEP_GROUPS) {
    const entries = group.kinds.filter(kind => stepKindOffered(kind, trigger)).map(kind => {
      const value = stepKindLabel(kind);
      byValue.set(value.toLowerCase(), () => fitted([makeStepDefault(kind)].flat()));
      return { value, label: STEP_KIND_MEANINGS[kind] ?? '' };
    });
    groups.push({ label: group.label, entries });
  }
  return { groups, byValue };
}

/**
 * Wire every add-step control. Its button reveals a search box, and `wireCatalogPicker` lists the templates and kinds
 * under that box, searchable and keyboard-driven. The rows follow the trigger the select holds whenever the list is
 * drawn. A pick lands in the list the control belongs to: the root list from the footer, or a branch from its own add
 * row.
 * @param {Function} repaint              Repaints the lists from `state.action`.
 */
function attachAddStepPicker(dialogEl, state, rootList, repaint) {
  const rows = () => addStepRows(currentTrigger(dialogEl));
  const SEARCH = '[data-role="add-step-search"]';
  wireCatalogPicker(dialogEl, {
    selector: SEARCH, groups: () => rows().groups, rows: 16, emptyText: 'No matching step.'
  });

  const hide = (input) => {
    input.value = '';
    input.hidden = true;
  };

  dialogEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action="add-step"]');
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();
    const input = btn.parentElement?.querySelector(SEARCH);
    if (!input) return;
    input.hidden = false;
    input.focus();
  });

  dialogEl.addEventListener('change', (ev) => {
    const input = ev.target.closest?.(SEARCH);
    if (!input) return;
    const make = rows().byValue.get(input.value.trim().toLowerCase());
    hide(input);
    if (!make) return;
    const branchEl = input.closest('.eff-if-branch');
    const listEl = branchEl ? branchEl.querySelector(':scope > .ed-list') : rootList;
    if (!listEl) return;
    state.action = readActionFromDom(dialogEl);
    const arr = locateStepsArray(state.action, listEl);
    if (!arr) return;
    arr.push(...make());
    repaint();
    if (listEl === rootList) rootList.lastElementChild?.scrollIntoView({ block: 'nearest' });
  });

  dialogEl.addEventListener('focusout', (ev) => {
    const input = ev.target.closest?.(SEARCH);
    if (input) hide(input);
  });

  dialogEl.addEventListener('keydown', (ev) => {
    const input = ev.target.closest?.(SEARCH);
    if (!input) return;
    if (ev.key === 'Enter') ev.preventDefault();
    if (ev.key === 'Escape') input.blur();
  });
}

/** Deleting, duplicating and collapsing the step cards, and opening a card's animation editor. */
function attachStepButtons(dialogEl, state, repaint) {
  dialogEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ed-card-btn:is([data-action="delete"], [data-action="duplicate"])');
    if (!btn) return;
    const card = btn.closest(CARD);
    const list = card?.parentElement;
    if (!list?.matches(LIST)) return;
    state.action = readActionFromDom(dialogEl);
    const stepsArr = locateStepsArray(state.action, list);
    if (!stepsArr) return;
    const idx = parseInt(card.dataset.stepIdx, 10);
    if (btn.dataset.action === 'delete') writeCards(stepsArr, removeCard(stepsArr, idx));
    else writeCards(stepsArr, duplicateCard(stepsArr, idx, copyStep));
    repaint();
  });

  dialogEl.addEventListener('click', (ev) => {
    const header = ev.target.closest('.ed-card-header');
    if (!header || ev.target.closest('.ed-card-actions, .ed-card-grip')) return;
    const card = header.closest(CARD);
    if (!card) return;
    stepCards.state.set(card.dataset.cardId, 'collapsed', card.classList.toggle('is-collapsed'));
    syncCollapseAllLabel(dialogEl);
  });

  dialogEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action="edit-animation"]');
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();
    const card = btn.closest(CARD);
    if (!card) return;
    const ta = ownStepField(card, 'animation');
    let current = null;
    if (ta && ta.value.trim()) {
      try { current = JSON.parse(ta.value); } catch { current = null; }
    }
    const edited = await openAnimationPayloadEditor(current, { document: state.document });
    if (!edited) return;
    if (ta) ta.value = JSON.stringify(edited);
    const count = Array.isArray(edited.steps) ? edited.steps.length : 0;
    btn.textContent = `Edit Animation Steps (${count})`;
  });
}

/** Folding an if step's condition, and adding or removing its optional else branch. */
function attachBranchControls(dialogEl, state, repaint) {
  dialogEl.addEventListener('click', (ev) => {
    const line = ev.target.closest('[data-action="toggle-condition"]');
    if (!line) return;
    ev.preventDefault();
    const host = line.closest('[data-condition-host]');
    if (!host) return;
    const folded = host.classList.toggle('is-folded');
    stepCards.state.set(host.closest(CARD)?.dataset.cardId, 'conditionFolded', folded);
  });

  dialogEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action="add-else"], [data-action="remove-else"]');
    if (!btn) return;
    ev.preventDefault();
    const card = btn.closest('.ed-card[data-step-kind="if"]');
    const list = card?.parentElement;
    if (!list?.matches(LIST)) return;
    const removing = btn.dataset.action === 'remove-else';
    const elseHoldsSteps = !!ownElement(card, '[data-branch-list="else"]')?.querySelector(`:scope > ${CARD}`);
    if (removing && elseHoldsSteps) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: 'Remove else branch?' },
        classes: [SYSTEM_ID],
        content: '<p>Remove this else branch and <b>every step inside it</b>?</p>',
        modal: true
      });
      if (ok !== true) return;
    }
    state.action = readActionFromDom(dialogEl);
    const step = locateStepsArray(state.action, list)?.[parseInt(card.dataset.stepIdx, 10)];
    if (step?.kind !== 'if') return;
    if (removing) delete step.else;
    else step.else = step.else ?? [];
    repaint();
  });
}

/** The controls whose value changes what a step card shows, and the condition templates. */
function attachStepChanges(dialogEl, state, repaint) {
  dialogEl.addEventListener('change', (ev) => {
    const sel = ev.target.closest(
      'select[data-step-field="preset"], select[data-step-field="target"], '
      + '.ed-card[data-step-kind="moveToken"] select[data-step-field="mode"], '
      + '.ed-card[data-step-kind="removeEffect"] select[data-step-field="scope"], '
      + '.ed-card[data-step-kind="animation"] input[data-step-field="persistent"], '
      + '.ed-card[data-step-kind="animation"] input[data-step-field="await"], '
      + '.ed-card[data-step-kind="terrainEdit"] select[data-step-field="effect"], '
      + '.ed-card[data-step-kind="terrainEdit"] select[data-step-field="presetTile"]'
    );
    if (!sel) return;
    state.action = readActionFromDom(dialogEl);
    repaint();
  });

  // The condition builder redraws the template select on every edit, so it is fitted to the trigger on focus.
  dialogEl.addEventListener('focusin', (ev) => {
    const sel = ev.target.closest('select[data-cond-template]');
    if (sel) fitConditionTemplates(sel, currentTrigger(dialogEl));
  });

  dialogEl.addEventListener('change', async (ev) => {
    const sel = ev.target.closest('select[data-cond-template]');
    if (!sel) return;
    const key = sel.value;
    sel.value = '';
    const card = sel.closest(CARD);
    const host = card ? ownConditionHost(card) : null;
    if (!host) return;

    const tree = conditionTemplateTree(key);
    const current = readConditionTree(host.querySelector('[data-condition-tree]'));
    if (current) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: 'Replace condition?' },
        classes: [SYSTEM_ID],
        content: `<p>Replace this step's condition with <b>${key ? 'the selected template' : 'nothing'}</b>?</p>`,
        modal: true
      });
      if (ok !== true) return;
    }
    conditionBuilders.get(host)?.setTree(tree ?? null);
    host.classList.remove('is-folded');
    refreshValidation(dialogEl, state);
  });
}

/** The phases an apply-status card's phases field stands for: a blank field means the default. */
function phasesShown(cardEl) {
  const text = String(ownStepField(cardEl, 'durationPhases')?.value ?? '').trim();
  return text === '' ? DEFAULT_STATUS_DURATION : Number(text);
}

/**
 * Keep a custom status panel in step with its own fields: the stack fields and the hint under them only while the
 * status is stackable, and the phase-or-stack choice under each checked trigger only while it is stackable and lasts
 * more than 0 phases.
 */
function syncCustomStatusPanel(cardEl) {
  const panel = ownElement(cardEl, '[data-cs-panel]');
  if (!panel) return;
  const stackable = panel.querySelector('[data-cs-field="stackable"]')?.checked === true;
  for (const field of panel.querySelectorAll('[data-needs-stack]')) {
    field.classList.toggle('ed-field--disabled', !stackable);
    for (const control of field.querySelectorAll('input, select')) control.disabled = !stackable;
  }
  const hint = panel.querySelector('[data-stack-hint]');
  if (hint) hint.hidden = !stackable;
  const showSheds = stackable && phasesShown(cardEl) > 0;
  for (const box of panel.querySelectorAll('[data-trigger]')) {
    const sheds = box.parentElement?.querySelector('[data-sheds]');
    if (sheds) sheds.hidden = !(showSheds && box.checked);
  }
}

/**
 * Fit a modifier row to its target: a true or false target shows the true or false select, a number target the
 * number input, and a target the picker does not offer keeps the control it has. A row added in this editor also
 * takes the one type its new target works with (changeKeyRule), though both stay selectable. The priority
 * placeholder shows the default for the row's target and type.
 */
function syncChangeRow(row) {
  const keyInput = row.querySelector('[data-path-input="target"]');
  const key = changeKey(keyInput?.value, keyInput?.dataset.key);
  const target = changeTargetByKey(key);
  if (target) {
    const boolean = target.kind === 'boolean';
    row.querySelector('[data-change-num]').hidden = boolean;
    row.querySelector('[data-change-bool]').hidden = !boolean;
  }
  const how = row.querySelector('[data-change-how]');
  // Only when the target changes, so a type the author then picks by hand is kept.
  if (how && row.hasAttribute('data-change-new') && row.dataset.typedKey !== key) {
    row.dataset.typedKey = key;
    const type = changeKeyRule(key).type;
    if (type) how.value = type;
  }
  const priority = row.querySelector('[data-change-priority]');
  if (priority) priority.placeholder = String(defaultChangePriority(key, how?.value));
}

/** Show the modifier heading while a panel has rows, and the "no changes" line while it has none. */
function syncChangeList(list) {
  const hasRows = !!list.querySelector('[data-change]');
  const head = list.querySelector('[data-changes-head]');
  const empty = list.querySelector('[data-changes-empty]');
  if (head) head.hidden = !hasRows;
  if (empty) empty.hidden = hasRows;
}

/**
 * The part of an apply-status card its header shows, read from the card's step fields and, for a custom status, its
 * name, icon and phases fields. The rest of the custom status panel is not read.
 */
function statusHeaderStep(cardEl) {
  const step = { kind: 'applyEffect' };
  for (const f of FIELDS_BY_KIND.applyEffect) {
    const input = ownStepField(cardEl, f.name);
    const v = input ? readField(f, input) : undefined;
    if (v !== undefined && v !== '') step[f.name] = v;
  }
  if (step.target === 'area') step.target = readAreaTarget(ownElement(cardEl, '[data-area-panel]'), step.kind);
  const panel = ownElement(cardEl, '[data-cs-panel]');
  if (step.preset === 'custom' && panel) {
    const field = name => panel.querySelector(`[data-cs-field="${name}"]`);
    step.customData = {
      name: field('name')?.value.trim() || customStatusTemplate().name,
      img: field('img')?.value ?? '',
      flags: { [SYSTEM_ID]: { duration: phasesShown(cardEl) } }
    };
  }
  return step;
}

/** Bring an apply-status card's header icon and collapsed summary up to date with its fields. */
function refreshStatusHeader(cardEl) {
  const step = statusHeaderStep(cardEl);
  const header = cardEl.querySelector(':scope > .ed-card-header');
  const summary = header?.querySelector('.ed-card-summary');
  if (summary) summary.textContent = stepSummaryText(step);
  const sprite = header?.querySelector('[data-status-sprite]');
  const img = statusImage(step);
  if (sprite) {
    if (img) sprite.src = img;
    sprite.hidden = !img;
  }
  const thumb = ownElement(cardEl, '[data-cs-icon]');
  if (thumb) {
    if (img) thumb.src = img;
    thumb.hidden = !img;
  }
}

/**
 * The live behaviour of apply-status cards, none of which repaints the list: the header and the custom status panel
 * follow each edit, the folder button opens Foundry's file picker for the icon, the phase-or-stack buttons switch,
 * and modifier rows are added and deleted in place. The modifier target inputs open the change target picker.
 */
function attachStatusCards(dialogEl) {
  wireCatalogPicker(dialogEl, { selector: CHANGE_KEY_INPUT, groups: customStatusChangeTargets() });

  const follow = (ev) => {
    const card = ev.target.closest?.('.ed-card[data-step-kind="applyEffect"]');
    if (!card?.isConnected) return;
    const row = ev.target.closest('[data-change]');
    if (row) syncChangeRow(row);
    syncCustomStatusPanel(card);
    refreshStatusHeader(card);
  };
  dialogEl.addEventListener('input', follow);
  dialogEl.addEventListener('change', follow);

  dialogEl.addEventListener('click', (ev) => {
    const browse = ev.target.closest('[data-action="browse-icon"]');
    if (!browse) return;
    ev.preventDefault();
    const input = browse.parentElement?.querySelector('[data-cs-field="img"]');
    if (!input) return;
    new foundry.applications.apps.FilePicker.implementation({
      type: 'image',
      current: input.value,
      callback: (path) => {
        if (!input.isConnected) return;
        input.value = path;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }).browse();
  });

  dialogEl.addEventListener('click', (ev) => {
    const shed = ev.target.closest('[data-shed]');
    if (!shed) return;
    ev.preventDefault();
    for (const button of shed.parentElement.children) {
      const on = button === shed;
      button.classList.toggle('ed-btn--accent', on);
      button.setAttribute('aria-pressed', String(on));
    }
  });

  dialogEl.addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-action="add-change"]');
    const remove = ev.target.closest('[data-action="delete-change"]');
    if (!add && !remove) return;
    ev.preventDefault();
    if (add) {
      const list = add.closest('.eff-cs-section')?.querySelector('[data-changes]');
      if (!list) return;
      list.querySelector('[data-changes-empty]')?.insertAdjacentHTML('beforebegin', changeRowHtml({ value: 0 }, true));
      syncChangeList(list);
      return;
    }
    const list = remove.closest('[data-changes]');
    remove.closest('[data-change]')?.remove();
    if (list) syncChangeList(list);
  });
}

/**
 * Copying one whole effect entry and pasting it over another. An entry whose trigger this item never fires is refused
 * with a notice, and the dialog is left as it was.
 */
function attachEntryClipboard(dialogEl, state, repaint) {
  dialogEl.querySelector('[data-action="copy-entry"]')?.addEventListener('click', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    _clipboard = foundry.utils.deepClone(readEntryFromDom(dialogEl, state.entry));
    notify.info('Effect entry copied to clipboard.');
  });
  dialogEl.querySelector('[data-action="paste-entry"]')?.addEventListener('click', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    if (!_clipboard) {
      notify.warn('Clipboard is empty.');
      return;
    }
    if (!triggerFitsGroup(_clipboard.trigger, state.group)) {
      notify.warn(`That effect uses ${triggerPhrase(_clipboard.trigger)}, which this item cannot use.`);
      return;
    }
    const trigEl = dialogEl.querySelector('[data-entry-field="trigger"]');
    if (trigEl) trigEl.value = _clipboard.trigger;
    state.action = foundry.utils.deepClone(_clipboard.action) || emptyAction();
    repaint();

    const nameEl = dialogEl.querySelector('[data-entry-field="name"]');
    if (nameEl) nameEl.value = _clipboard.name || '';
    const namesEl = dialogEl.querySelector('[data-entry-field="itemNames"]');
    if (namesEl) namesEl.value = Array.isArray(_clipboard.itemNames) ? _clipboard.itemNames.join('\n') : '';
    const delayEl = dialogEl.querySelector('[data-entry-field="delayMs"]');
    if (delayEl) delayEl.value = Number.isFinite(Number(_clipboard.delayMs)) ? Number(_clipboard.delayMs) : 0;
    const awaitsEl = dialogEl.querySelector('[data-entry-field="tokenAwaits"]');
    if (awaitsEl) awaitsEl.checked = _clipboard.tokenAwaits === true;
    notify.info('Effect entry pasted.');
    refreshValidation(dialogEl, state);
  });
}

/** Dragging a step card by its grip, within a list and between branches. */
function attachStepDragAndDrop(dialogEl, state, repaint) {
  let dragSource = null;

  const clearDropMarkers = () => {
    dialogEl.querySelectorAll('.ed-drop-line').forEach(el => el.remove());
    dialogEl.querySelectorAll('.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
  };

  const cardsIn = (listEl) => [...listEl.querySelectorAll(`:scope > ${CARD}`)];

  const insertionIndexFor = (listEl, clientY) => {
    const cards = cardsIn(listEl).filter(c => c !== dragSource?.card);
    for (let i = 0; i < cards.length; i++) {
      const box = cards[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return { index: i, before: cards[i] };
    }
    return { index: cards.length, before: null };
  };

  dialogEl.addEventListener('dragstart', (ev) => {
    const grip = ev.target.closest?.('.ed-card-grip');
    const card = grip?.closest(CARD);
    const list = card?.parentElement;
    if (!card || !list?.matches(LIST)) {
      ev.preventDefault();
      return;
    }
    dragSource = { card, list };
    card.classList.add('is-dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', 'emblem-step');
    ev.dataTransfer.setDragImage(card, 12, 12);
  });

  dialogEl.addEventListener('dragend', () => {
    dragSource?.card.classList.remove('is-dragging');
    dragSource = null;
    clearDropMarkers();
  });

  dialogEl.addEventListener('dragover', (ev) => {
    if (!dragSource) return;
    const list = ev.target.closest?.(LIST);
    if (!list || dragSource.card.contains(list)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    clearDropMarkers();
    list.classList.add('is-drop-target');
    const line = document.createElement('div');
    line.className = 'ed-drop-line';
    const { before } = insertionIndexFor(list, ev.clientY);
    list.insertBefore(line, before);
  });

  dialogEl.addEventListener('drop', (ev) => {
    if (!dragSource) return;
    const list = ev.target.closest?.(LIST);
    if (!list || dragSource.card.contains(list)) return;
    ev.preventDefault();

    const { index: rawTarget } = insertionIndexFor(list, ev.clientY);
    const sourceList = dragSource.list;
    const sourceIdx = cardsIn(sourceList).indexOf(dragSource.card);
    clearDropMarkers();
    if (sourceIdx < 0) return;

    state.action = readActionFromDom(dialogEl);
    const fromArr = locateStepsArray(state.action, sourceList);
    const toArr = locateStepsArray(state.action, list);
    if (!fromArr || !toArr) return;

    const moved = transferCard(fromArr, sourceIdx, toArr, rawTarget);
    if (moved.from === fromArr) return;
    writeCards(fromArr, moved.from);
    if (toArr !== fromArr) writeCards(toArr, moved.to);
    repaint();
  });
}

/* -------------------------------------------- */
/*  Paths                                       */
/* -------------------------------------------- */

/**
 * Find the steps array a DOM list stands for, by walking up through the if branches that hold it. A missing branch
 * array is created, so a new step has somewhere to go.
 * @returns {object[]|null}
 */
function locateStepsArray(action, listEl) {
  const chain = [];
  let el = listEl;
  while (el) {
    const branch = el.dataset?.branchList;
    if (branch !== 'then' && branch !== 'else') break;
    const ifCard = el.closest('.ed-card[data-step-kind="if"]');
    if (!ifCard) return null;
    const idx = parseInt(ifCard.dataset.stepIdx, 10);
    if (!Number.isInteger(idx)) return null;
    chain.unshift({ branch, idx });
    el = ifCard.parentElement?.closest(LIST) ?? null;
  }

  let arr = action.steps;
  for (const { branch, idx } of chain) {
    const parent = arr[idx];
    if (!parent || parent.kind !== 'if') return null;
    parent[branch] = parent[branch] || [];
    arr = parent[branch];
  }
  return arr;
}

function readActionFromDom(dialogEl) {
  const rootList = dialogEl.querySelector('.ed-list[data-branch-list="root"]');
  const steps = rootList ? stepCards.read(rootList) : [];
  return { steps };
}

/**
 * Drop an else branch the author added and then left empty, recursing into the branches that remain. This runs when
 * the entry is read for validation and save, not on every read, so `readStepPanels` keeps a branch that was just
 * added while the dialog is still open.
 */
function pruneEmptyBranches(steps) {
  for (const s of steps || []) {
    if (!s || typeof s !== 'object') continue;
    if (Array.isArray(s.then)) pruneEmptyBranches(s.then);
    if (Array.isArray(s.else) && s.else.length === 0) delete s.else;
    else if (Array.isArray(s.else)) pruneEmptyBranches(s.else);
  }
}

/**
 * Read the effect entry for validation and save. The one field the dialog doesn't edit, `itemUuids`, is carried over
 * from the entry it opened with. `condition` is always null, because it was folded into an if step on open. Item
 * names are collected only for the trigger that uses them.
 * @param {object} [source]               The entry the dialog opened with.
 */
function readEntryFromDom(dialogEl, source = {}) {
  const action = readActionFromDom(dialogEl);
  pruneEmptyBranches(action.steps);
  deriveAnimationAttachTargets(action.steps);
  const trigger = dialogEl.querySelector('[data-entry-field="trigger"]')?.value || '';
  const name    = dialogEl.querySelector('[data-entry-field="name"]')?.value || '';
  const delayRaw = dialogEl.querySelector('[data-entry-field="delayMs"]')?.value;
  const delayMs = delayRaw === '' || delayRaw == null ? 0 : (Number(delayRaw) || 0);
  const tokenAwaits = dialogEl.querySelector('[data-entry-field="tokenAwaits"]')?.checked === true;
  const itemNamesEl = dialogEl.querySelector('[data-entry-field="itemNames"]');
  const itemNames = itemNamesEl && trigger === 'onUseItem'
    ? itemNamesEl.value.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0)
    : [];
  const entry = {
    trigger, name, delayMs, tokenAwaits,
    condition: null,
    action,
    itemNames,
    itemUuids: Array.isArray(source.itemUuids) ? [...source.itemUuids] : []
  };
  return entry;
}

/* -------------------------------------------- */
/*  Adding Steps                                */
/* -------------------------------------------- */

/**
 * A newly added step of a kind, with starting values that addStepRows then fits to the trigger. Spawn token, terrain
 * edit and remove status steps start empty and block Save until they are filled in, and a floating text step shows
 * nothing until it has text. A change faction step comes with the status it is tied to, as a list of two steps.
 */
function makeStepDefault(kind) {
  switch (kind) {
    case 'damage':       return { kind, target: 'target', formula: '1d4', dmgType: 'slashing', brk: '0', alt: true };
    case 'heal':         return { kind, target: 'self', formula: '1d4' };
    case 'modShield':    return { kind, target: 'target', formula: 'selfCha', cap: 'selfCha' };
    case 'applyEffect':
      return { kind, target: 'target', preset: 'restrained', durationPhases: DEFAULT_STATUS_DURATION };
    case 'setFaction':   return [
      { kind: 'applyEffect', target: 'target', preset: 'custom', linkAnimationTag: 'turned',
        customData: turnedStatusTemplate() },
      { kind, target: 'target', actorType: 'Ally', linkStatusTag: 'turned' }
    ];
    case 'removeEffect': return { kind, target: 'target', name: '' };
    case 'animation':    return { kind, animation: { steps: [] } };
    case 'floatingText': return { kind, target: 'target', text: '' };
    case 'moveToken':    return { kind, target: 'target', mode: 'push', pair: 'self', distance: '1' };
    case 'spawnToken':   return { kind, actorUuid: '', location: 'targetLocation' };
    case 'restoreAction': return { kind, target: 'target', actions: ['standard'] };
    case 'playResist':   return { kind, target: 'target' };
    case 'playVoice':    return { kind, target: 'target', category: 'select' };
    case 'unequip':      return { kind, target: 'target' };
    case 'guard':        return { kind, target: 'target' };
    case 'terrainEdit':  return { kind, overwrite: true };
    case 'wait':         return { kind, ms: 500 };
    case 'if':           return { kind, condition: null, then: [] };
    default:             return { kind };
  }
}

/* -------------------------------------------- */
/*  Effect Editor                               */
/* -------------------------------------------- */

/**
 * Append a default entry to the item, for `openEffectActionEditor` to open straight away with `isNew` so a cancel
 * takes it off again. The item sheet's `effectsPath` names the list.
 * @param {ItemSheet} itemSheet           The sheet it was asked from.
 * @param {object} [options]
 * @param {string} [options.group]        The owning item's trigger group.
 * @returns {Promise<number>}             The new entry's index.
 */
export async function createEffectEntry(itemSheet, { group = '' } = {}) {
  const effectsPath = itemSheet.effectsPath;
  const entry = {
    trigger: triggerKeysForGroup(group)[0] ?? '',
    name: '',
    itemNames: [],
    itemUuids: [],
    delayMs: 0,
    tokenAwaits: false,
    condition: null,
    action: emptyAction()
  };
  const all = [...foundry.utils.getProperty(itemSheet.document, effectsPath), entry];
  await itemSheet.document.update({ [effectsPath]: all });
  return all.length - 1;
}

/** Take a just-created entry off the item again, because its editor was cancelled. */
async function removeEffectEntry(itemSheet, snapshot, openedAt) {
  const effectsPath = itemSheet.effectsPath;
  const entryIndex = currentEntryIndex(itemSheet, snapshot, openedAt);
  if (entryIndex < 0) return;
  const all = [...foundry.utils.getProperty(itemSheet.document, effectsPath)];
  all.splice(entryIndex, 1);
  await itemSheet.document.update({ [effectsPath]: all });
}

/**
 * Where the entry an editor opened on sits now, or -1 if it is gone or was changed elsewhere. The item sheet can
 * delete and reorder effects while the editor is open, so the entry is found by its content.
 * @param {ItemSheet} itemSheet           The sheet it was opened from.
 * @param {object} snapshot               A copy of the entry as it was when the editor opened.
 * @param {number} openedAt               Its index when the editor opened, preferred while it still matches.
 */
function currentEntryIndex(itemSheet, snapshot, openedAt) {
  const all = Array.from(foundry.utils.getProperty(itemSheet.document, itemSheet.effectsPath) ?? []);
  if (foundry.utils.equals(all[openedAt], snapshot)) return openedAt;
  return all.findIndex(e => foundry.utils.equals(e, snapshot));
}

/**
 * The dialog's header row: trigger, the item names an on-use-item trigger filters by, name, hold pose and delay. The
 * trigger select lists the item group's triggers (triggerChoices), and is 150px wide unless an unavailable trigger's
 * longer label needs more. Only an item that is used reads the hold pose, so the other groups don't show it.
 * @param {string} group          The owning item's trigger group.
 * @param {boolean} retractable   Whether the owning item is retractable, which narrows the triggers it lists.
 */
function effectHeaderHtml(entry, group, retractable = false) {
  const choices = triggerChoices(group, entry.trigger, { retractable });
  const longest = Math.max(...choices.map(choice => choice.label.length));
  const triggerOpts = choices.map(({ value, label, disabled }) =>
    `<option value="${escapeHtml(value)}"${value === entry.trigger ? ' selected' : ''}${disabled ? ' disabled' : ''}>`
    + `${escapeHtml(label)}</option>`).join('');
  const itemNamesValue = Array.isArray(entry.itemNames) ? entry.itemNames.join('\n') : '';
  const itemNamesHidden = entry.trigger === 'onUseItem' ? '' : ' hidden';
  const itemNamesHtml = `
        <label class="ed-field ed-field--grow ed-field--textarea" data-role="item-names"${itemNamesHidden}>
          ${labelSpan('item names', 'editor.effect.item-names')}
          <textarea data-entry-field="itemNames" rows="2">${escapeHtml(itemNamesValue)}</textarea>
        </label>`;
  const delay = Number.isFinite(Number(entry.delayMs)) ? Number(entry.delayMs) : 0;
  const holdPoseHtml = group !== 'B' ? '' : `
        <label class="ed-field ed-field--check">
          ${labelSpan('hold pose', 'editor.effect.hold-pose')}
          <span class="ed-check-slot">
            <input type="checkbox" data-entry-field="tokenAwaits"${entry.tokenAwaits === true ? ' checked' : ''} />
          </span>
        </label>`;
  return `
      <div class="ed-hrow">
        <label class="ed-field" style="width:max(150px, calc(${longest}ch + 36px))">
          ${labelSpan('trigger', 'editor.effect.trigger')}
          <select data-entry-field="trigger">${triggerOpts}</select>
        </label>
        ${itemNamesHtml}
        <label class="ed-field ed-field--grow">
          ${labelSpan('name', 'editor.effect.name')}
          <input type="text" data-entry-field="name" value="${escapeHtml(entry.name || '')}" />
        </label>${holdPoseHtml}
        <label class="ed-field" style="width:78px">
          ${labelSpan('delay', 'editor.effect.delay')}
          <span class="ed-with-unit" data-unit="ms">
            <input type="number" min="0" max="${MAX_EFFECT_DELAY_MS}" step="1" data-entry-field="delayMs"
              value="${delay}" />
          </span>
        </label>
      </div>`;
}

/** The toolbar under the root list: the add-step control, then the list-wide and clipboard actions. */
function effectFooterHtml() {
  return `
        <div class="eff-editor-footer">
          <span class="ed-add-row">${addStepControlHtml()}</span>
          <span class="eff-spacer"></span>
          <button type="button" class="ed-btn" data-action="collapse-all">collapse all</button>
          <button type="button" class="ed-btn" data-action="copy-entry">copy</button>
          <button type="button" class="ed-btn" data-action="paste-entry">paste</button>
        </div>`;
}

/**
 * Bring each custom status step's data to the shape the panel draws, through normalizeCustomStatus, before the cards
 * are first drawn. A duration saved on the step moves into the data, and keys the panel has no field for show in the
 * advanced json box, so older content opens with nothing lost.
 * @param {object[]} steps        The steps, changed in place through their branches.
 */
function normalizeCustomSteps(steps) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object') continue;
    if (step.kind === 'applyEffect' && step.preset === 'custom') {
      step.customData = customStatusData(step);
      delete step.durationPhases;
    }
    normalizeCustomSteps(step.then);
    normalizeCustomSteps(step.else);
  }
}

const ENTRY_LOST_MESSAGE = 'This effect was changed, moved or removed while the editor was open. Reopen it and try again.';

/**
 * Open the effect editor on a copy of one entry, through openEffectEditor (dialogs.mjs). An entry-level condition
 * is shown as an if step wrapping the steps, and each custom status is brought to its current shape. The trigger
 * choices are the item group's, and the complete entry is validated before saving. An entry opened with `isNew`
 * (one `createEffectEntry` just appended) is removed again when the dialog closes without saving.
 * @param {ItemSheet} itemSheet           The sheet it was opened from.
 * @param {number} entryIndex             Which effect.
 * @param {object} [options]
 * @param {string} [options.group]        The owning item's trigger group.
 * @param {boolean} [options.isNew]       Whether a cancel should delete the entry.
 * @returns {Promise<*>}
 */
export async function openEffectActionEditor(itemSheet, entryIndex, { group = '', isNew = false } = {}) {
  const effectsPath = itemSheet.effectsPath;
  const entry = foundry.utils.getProperty(itemSheet.document, effectsPath)[entryIndex];
  if (!entry) return;
  const snapshot = foundry.utils.deepClone(entry);
  await terrainPresetsReady();

  const state = {
    document: itemSheet.document,
    group,
    entry: foundry.utils.deepClone(entry),
    action: actionIsPopulated(entry.action) ? foundry.utils.deepClone(entry.action) : emptyAction()
  };
  normalizeCustomSteps(state.action.steps);
  // The entry condition is saved back as an if step. A failing entry condition skipped the whole entry; a failing
  // if step still lets the entry's delay and hold pose run.
  if (entry.condition && !conditionIsEmpty(entry.condition)) {
    state.action.steps = [{
      kind: 'if',
      condition: foundry.utils.deepClone(entry.condition),
      then: state.action.steps
    }];
  }
  if (state.action.steps.length >= 2) {
    for (const s of state.action.steps) {
      if (s && typeof s === 'object') stepCards.state.set(stepCards.state.identify(s), 'collapsed', true);
    }
  }

  const content = `
    <div class="eff-editor-root">
      ${effectHeaderHtml(entry, group, itemSheet.document.system?.retractable === true)}
      <div class="eff-step-pane">
        <div class="ed-list" data-branch-list="root"></div>
        ${effectFooterHtml()}
        <div class="eff-editor-errors" data-role="validation" hidden></div>
      </div>
    </div>`;

  let saved = false;
  const result = await openEditor({
    document: itemSheet.document,
    title: `Effect: ${entry.name || triggerLabel(entry.trigger) || '(new)'}`,
    position: { width: 660, height: 580 },
    resizable: true,
    classes: ['dialog-effect-action-editor'],
    content,
    wire: (root) => {
      mountPathPicker(root);
      const list = root.querySelector('.ed-list[data-branch-list="root"]');
      if (list) paintStepList(list, state.action.steps);
      mountStepConditions(root);
      attachHandlers(root, state);
    },
    gather: (root) => {
      const updated = readEntryFromDom(root, state.entry);

      const r = validateEntryOnItem(updated, state.document);
      if (!r.valid) {
        notify.error(`This effect cannot be saved. ${r.errors.join(' ')}`);
        return undefined;
      }
      if (currentEntryIndex(itemSheet, snapshot, entryIndex) < 0) {
        notify.error(ENTRY_LOST_MESSAGE);
        return undefined;
      }

      return updated;
    },
    apply: async (updated) => {
      const index = currentEntryIndex(itemSheet, snapshot, entryIndex);
      if (index < 0) {
        notify.error(ENTRY_LOST_MESSAGE);
        return null;
      }
      const all = [...foundry.utils.getProperty(itemSheet.document, effectsPath)];
      all[index] = updated;
      const written = await itemSheet.document.update({ [effectsPath]: all });
      saved = true;
      return written;
    }
  });
  if (isNew && !saved) await removeEffectEntry(itemSheet, snapshot, entryIndex);
  return result;
}

