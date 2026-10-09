/** @layer init */
import { ACTOR_TYPES, ITEM_TYPES } from '../config/constants.mjs';
import { KEYBINDING_DEFINITIONS } from '../config/keybindings.mjs';
import {
  BG3_SHOW_ITEM_USES_SETTING,
  CAMPAIGN_PARTIES_SETTING,
  DIFFICULTY_SETTING,
  HIT_CHANCE_MODEL_SETTING,
  RECIPE_LIBRARY_REVISION_SETTING,
  SETTING_DEFINITIONS,
  SETTING_SECTIONS,
  SONG_LIBRARY_REVISION_SETTING,
  VOICE_OVER_VOLUME_SETTING
} from '../config/settings.mjs';
import { tokenHudStatusEffects } from '../config/statuses.mjs';
import { triggerLabel } from '../config/triggers.mjs';
import { SYSTEM_ID } from '../contracts/protocol.mjs';
import { EFFECT_MOVE_ACTION } from '../contracts/domains/combat.mjs';
import { characterAvatarScale } from '../game/character/rules.mjs';
import { LEGACY_AVATAR_SCALE, LEGACY_AVATAR_STYLE } from '../lib/dom/html.mjs';
import { CharacterDataModel } from '../foundry/data-models/actor/character.mjs';
import { ConvoyDataModel, VendorDataModel } from '../foundry/data-models/actor/containers.mjs';
import { ObjectDataModel } from '../foundry/data-models/actor/object.mjs';
import { ClassDataModel } from '../foundry/data-models/item/class.mjs';
import { ItemDataModel } from '../foundry/data-models/item/general.mjs';
import { ResourceDataModel } from '../foundry/data-models/item/resource.mjs';
import { EmblemActiveEffect } from '../foundry/documents/active-effects.mjs';
import { EmblemActor, EmblemActors } from '../foundry/documents/actors.mjs';
import { EmblemActorDelta } from '../foundry/documents/actor-deltas.mjs';
import { EmblemItem } from '../foundry/documents/items.mjs';
import { CharacterSheet } from '../ui/apps/sheets/character/sheet.mjs';
import { ClassSheet } from '../ui/apps/sheets/class/sheet.mjs';
import { ConvoySheet, VendorSheet } from '../ui/apps/sheets/containers.mjs';
import { ItemSheet, ResourceSheet } from '../ui/apps/sheets/item/sheet.mjs';
import { ObjectSheet } from '../ui/apps/sheets/object/sheet.mjs';
import { EmblemCombatTracker } from '../ui/apps/foundry/combat-tracker.mjs';
import {
  createCanvasKeybindingHandlers
} from '../ui/controls/keybindings.mjs';

/* -------------------------------------------- */
/*  Foundry registration                        */
/* -------------------------------------------- */
const PARTIALS = Object.freeze({
  'category-tabs': `systems/${SYSTEM_ID}/templates/partials/category-tabs.hbs`,
  'category-pane': `systems/${SYSTEM_ID}/templates/partials/category-pane.hbs`
});

/**
 * Register the system's document classes and data models, the forced-move movement action, the status effects,
 * sheets, the combat tracker, settings, keybindings and Handlebars helpers. Called from the `init` hook in
 * init/hooks.mjs.
 */
export function registerSystemFoundations(getTooltip, callbacks = {}) {
  registerDataModels();
  registerMovementActions();
  registerStatusEffects();
  registerSheets();
  registerApplications();
  registerSettings(callbacks);
  registerKeybindings();
  registerHandlebars(getTooltip);
}

function registerDataModels() {
  CONFIG.Actor.documentClass = EmblemActor;
  CONFIG.Actor.collection = EmblemActors;
  CONFIG.ActiveEffect.documentClass = EmblemActiveEffect;
  CONFIG.ActorDelta.documentClass = EmblemActorDelta;
  CONFIG.Actor.dataModels[ACTOR_TYPES.CHARACTER] = CharacterDataModel;
  CONFIG.Actor.dataModels[ACTOR_TYPES.CONVOY] = ConvoyDataModel;
  CONFIG.Actor.dataModels[ACTOR_TYPES.OBJECT] = ObjectDataModel;
  CONFIG.Actor.dataModels[ACTOR_TYPES.VENDOR] = VendorDataModel;

  CONFIG.Item.documentClass = EmblemItem;
  for (const itemType of ITEM_TYPES) {
    CONFIG.Item.dataModels[itemType] = itemType === 'Class'
      ? ClassDataModel
      : itemType === 'Resource'
        ? ResourceDataModel
        : ItemDataModel;
  }

  // The resource bars each actor type offers its tokens. Foundry v14 reads CONFIG.Actor.trackableAttributes for
  // that, not `trackers`, so this list has no effect.
  CONFIG.Actor.trackers = CONFIG.Actor.trackers ?? {};
  CONFIG.Actor.trackers[ACTOR_TYPES.CHARACTER] = [
    { path: 'resources.hp.value', label: 'HP' },
    { path: 'resources.stn.value', label: 'Stn' }
  ];
  CONFIG.Actor.trackers[ACTOR_TYPES.OBJECT] = [
    { path: 'resources.hp.value', label: 'HP' },
    { path: 'resources.stn.value', label: 'Stn' }
  ];
}

/**
 * The movement action an effect's forced move uses (EFFECT_MOVE_ACTION, from contracts/domains/combat.mjs). It
 * can't be picked by hand, costs no movement, isn't blocked by walls and draws no ruler.
 */
function registerMovementActions() {
  CONFIG.Token.movement.actions[EFFECT_MOVE_ACTION] = {
    label: 'Charge',
    icon: 'fa-solid fa-person-running-fast',
    img: 'icons/svg/jump.svg',
    order: 9,
    teleport: false,
    measure: false,
    walls: null,
    visualize: false,
    canSelect: false,
    terrainAction: null,
    costMultiplier: 0
  };
}

/** Replace Foundry's whole status list with the system's, so core statuses such as `dead` no longer exist. */
function registerStatusEffects() {
  CONFIG.statusEffects = tokenHudStatusEffects();
}

function registerSheets() {
  const actorSheets = [
    [CharacterSheet, ACTOR_TYPES.CHARACTER],
    [ConvoySheet, ACTOR_TYPES.CONVOY],
    [ObjectSheet, ACTOR_TYPES.OBJECT],
    [VendorSheet, ACTOR_TYPES.VENDOR]
  ];
  for (const [sheet, type] of actorSheets) {
    foundry.documents.collections.Actors.registerSheet(SYSTEM_ID, sheet, { types: [type], makeDefault: true });
  }

  foundry.documents.collections.Items.registerSheet(SYSTEM_ID, ClassSheet, {
    types: ['Class'], makeDefault: true
  });
  foundry.documents.collections.Items.registerSheet(SYSTEM_ID, ResourceSheet, {
    types: ['Resource'], makeDefault: true
  });
  foundry.documents.collections.Items.registerSheet(SYSTEM_ID, ItemSheet, {
    types: ITEM_TYPES.filter(type => !['Class', 'Resource'].includes(type)), makeDefault: true
  });
}

function registerApplications() {
  CONFIG.ui.combat = EmblemCombatTracker;
}

function registerSettings(callbacks) {
  for (const definition of orderedSettingDefinitions()) {
    const { fieldType, fieldOptions, ...options } = definition.options;
    if (fieldType) options.type = new foundry.data.fields[fieldType]({ ...fieldOptions });
    if (definition.id === BG3_SHOW_ITEM_USES_SETTING) options.onChange = callbacks.onBg3DisplayChanged;
    if (definition.id === HIT_CHANCE_MODEL_SETTING) options.onChange = callbacks.onHitChanceModelChanged;
    if (definition.id === DIFFICULTY_SETTING) options.onChange = callbacks.onDifficultyChanged;
    if (definition.id === CAMPAIGN_PARTIES_SETTING) options.onChange = callbacks.onCampaignPartiesChanged;
    if (definition.id === VOICE_OVER_VOLUME_SETTING) options.onChange = callbacks.onVoiceOverVolumeChanged;
    if (definition.id === RECIPE_LIBRARY_REVISION_SETTING) options.onChange = callbacks.onRecipeLibraryChanged;
    if (definition.id === SONG_LIBRARY_REVISION_SETTING) options.onChange = callbacks.onSongLibraryChanged;
    game.settings.register(SYSTEM_ID, definition.id, options);
  }
}

/** Order config/settings.mjs declarations by section before registering them with Foundry. */
function orderedSettingDefinitions() {
  const byId = new Map(SETTING_DEFINITIONS.map(definition => [definition.id, definition]));
  const sectioned = SETTING_SECTIONS.flatMap(section => section.settingIds)
    .map(id => byId.get(id)).filter(Boolean);
  const placed = new Set(sectioned.map(definition => definition.id));
  return [...sectioned, ...SETTING_DEFINITIONS.filter(definition => !placed.has(definition.id))];
}

function registerKeybindings() {
  const handlers = createCanvasKeybindingHandlers();
  for (const definition of KEYBINDING_DEFINITIONS) {
    const handler = handlers[definition.id];
    game.keybindings.register(SYSTEM_ID, definition.id, {
      name: definition.name,
      hint: definition.hint,
      editable: definition.keys.map(key => definition.modifiers?.length
        ? ({ key, modifiers: definition.modifiers })
        : ({ key })),
      onDown: typeof handler === 'function' ? handler : handler?.down,
      onUp: typeof handler === 'function' ? undefined : handler?.up,
      repeat: definition.repeat === true,
      precedence: definition.precedence === 'priority'
        ? CONST.KEYBINDING_PRECEDENCE.PRIORITY
        : CONST.KEYBINDING_PRECEDENCE.NORMAL
    });
  }
}

function registerHandlebars(getTooltip) {
  const handlebars = globalThis.Handlebars;
  if (!handlebars) return;
  Promise.resolve(foundry.applications.handlebars.loadTemplates(Object.values(PARTIALS))).then(() => {
    for (const [name, path] of Object.entries(PARTIALS)) {
      const partial = handlebars.partials[path];
      if (partial) handlebars.registerPartial(name, partial);
    }
  });

  // eq, or and and replace core helpers of the same name with versions that behave the same.
  handlebars.registerHelper('eq', (left, right) => left === right);
  handlebars.registerHelper('capitalize', value => {
    const text = String(value ?? '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  });
  handlebars.registerHelper('or', (...args) => args.slice(0, -1).some(Boolean));
  handlebars.registerHelper('and', (...args) => args.slice(0, -1).every(Boolean));
  handlebars.registerHelper('add', (left, right) => Number(left) + Number(right));
  handlebars.registerHelper('default', (value, fallback) =>
    value === null || value === undefined || value === '' ? fallback : value
  );
  // The inline portrait zoom of an actor; a legacy avatar is drawn unzoomed and smooth. A combat tracker row passes
  // its zoom already worked out, with LEGACY_AVATAR_SCALE for a legacy avatar.
  handlebars.registerHelper('avatarScale', (actor, options) => {
    const art = actor?.system?.art;
    const scale = art?.avatarScale === LEGACY_AVATAR_SCALE ? LEGACY_AVATAR_SCALE : characterAvatarScale(art);
    if (scale === LEGACY_AVATAR_SCALE) return new handlebars.SafeString(LEGACY_AVATAR_STYLE);
    const clip = options?.hash?.clip ? 'transform-origin:center center;' : '';
    return new handlebars.SafeString(`${clip}transform:scale(${scale});`);
  });
  handlebars.registerHelper('durabilityColor', (current, max) => {
    const value = Number(current);
    const limit = Number(max);
    if (value === 0 || (limit > 0 && value / limit <= 0.25)) return '#ff6b6b';
    if (limit > 0 && value / limit <= 0.5) return '#ffa500';
    return 'inherit';
  });
  handlebars.registerHelper('successRateClass', value => {
    const rate = Number(value) || 0;
    if (rate >= 90) return 'very-high-chance';
    if (rate >= 70) return 'high-chance';
    return rate >= 45 ? 'medium-chance' : 'low-chance';
  });
  handlebars.registerHelper('tooltip', (id, data) => getTooltip(id, data));
  handlebars.registerHelper('triggerLabel', key => triggerLabel(key));
}
