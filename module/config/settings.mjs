/** @layer config */
import { DRIVEN_HOLD_SETTING } from '../contracts/domains/suppression.mjs';
import { OPERATION_RECORD_SETTING } from '../contracts/domains/recovery.mjs';

/* -------------------------------------------- */
/*  Setting vocabulary                          */
/* -------------------------------------------- */
export const SCHEMA_VERSION_SETTING = 'schemaVersion';
export const BG3_SHOW_ITEM_USES_SETTING = 'bg3ShowItemUses';
const AUTO_POPULATE_ENABLED_SETTING = 'autoPopulateEnabled';
const AUTO_POPULATE_CHARACTERS_SETTING = 'autoPopulatePlayerCharacters';
const AUTO_POPULATE_CONFIGURATION_SETTING = 'autoPopulateConfiguration';
export const CAMPAIGN_PARTIES_SETTING = 'campaignParties';
export const TERRAIN_BUILDER_GRID_SETTING = 'terrainBuilderShowGrid';
export const USER_LOCK_SETTING = 'userLock';
export const TOKEN_ROTATION_LOCK_SETTING = 'lockTokenRotation';
export const TERRAIN_TIPS_MODE_SETTING = 'terrainTipsMode';
export const VOICELINE_FREQUENCY_SETTING = 'voicelineFrequency';
export const UI_SOUNDS_SETTING = 'uiSounds';
export const TOKEN_TOOLTIP_SCALE_SETTING = 'tokenTooltipScale';
export const TOKEN_TOOLTIP_DEFAULT_SCALE = 0.75;
export const VOICE_OVER_VOLUME_SETTING = 'voiceOverVolume';
export const VOICE_PATH_APPROVALS_SETTING = 'voicePathApprovals';
export const DIFFICULTY_SETTING = 'difficulty';
export const XP_MULTIPLIER_SETTING = 'xpMultiplier';
export const PLAYER_CRITICAL_BONUS_SETTING = 'toPlayerCritDamageMultiplier';
export const PLAYER_CRITICAL_BONUS_RANGE = Object.freeze({ min: 0.25, max: 1, step: 0.05 });
export const TOKEN_OUTLINE_COLOUR_SETTING = 'tokenOutlineColour';
export const TOKEN_OUTLINE_DEFAULT_COLOUR = '#382040';
export const HIT_CHANCE_MODEL_SETTING = 'hitChanceModel';
export const FLYER_TARGETING_SETTING = 'flyerTargeting';
export const KARMA_LEDGER_SETTING = 'karmaLedger';
export const RECIPE_LIBRARY_REVISION_SETTING = 'recipeLibraryRevision';
export const SONG_LIBRARY_REVISION_SETTING = 'songLibraryRevision';
export const CINEMATIC_BATTLE_SETTING = 'cinematicBattle';
const CINEMATIC_ABILITIES_SETTING = 'cinematicAbilities';
const CINEMATIC_CASTING_SETTING = 'cinematicCasting';
const CINEMATIC_ITEM_USAGE_SETTING = 'cinematicItemUsage';
export const COMBAT_CINEMATIC_ZOOM_SETTING = 'combatCinematicZoom';
export const CINEMATIC_PHASE_CAMERA_SETTING = 'cinematicPhaseCamera';
export const ENEMY_PHASE_CAMERA_ZOOM_SETTING = 'enemyPhaseCameraZoom';
export const CENTER_CAMERA_ON_SELECT_SETTING = 'centerCameraOnSelect';
export const CENTER_CAMERA_SPEED_SETTING = 'centerCameraSpeed';
export const CAMERA_FOLLOW_MODE_SETTING = 'cameraFollowMode';
export const CAMERA_FOLLOW_MARGIN_SETTING = 'cameraFollowMargin';
export const CAMERA_FOLLOW_SPEED_SETTING = 'cameraFollowSpeed';
const CAMERA_SPEED_CHOICES = Object.freeze({ instant: 'Instant', smooth: 'Smooth', verySmooth: 'Very Smooth' });

export const ITEM_CINEMATIC_SETTINGS = Object.freeze({
  abilities: CINEMATIC_ABILITIES_SETTING,
  casting: CINEMATIC_CASTING_SETTING,
  itemUsage: CINEMATIC_ITEM_USAGE_SETTING
});

/* -------------------------------------------- */
/*  Setting declarations                        */
/* -------------------------------------------- */
const TOKEN_ROTATION_LOCK_OPTIONS = Object.freeze({
  name: 'Lock Token Artwork Rotation',
  hint: 'Start new tokens with their artwork rotation locked, and lock every placed token when turned on.',
  scope: 'world',
  config: true,
  type: Boolean,
  default: true
});

const TERRAIN_TIPS_MODE_OPTIONS = Object.freeze({
  name: 'Terrain Tips',
  hint: 'Whether the Show Terrain Tips key shows tips only while held or toggles them on and off.',
  scope: 'client',
  config: true,
  type: String,
  choices: Object.freeze({ hold: 'Hold', toggle: 'Toggle' }),
  default: 'toggle'
});

const VOICELINE_FREQUENCY_OPTIONS = Object.freeze({
  name: 'Voiceline Frequency',
  hint: 'How often a unit voice line plays on selection. Extended waits 30 seconds between lines.',
  scope: 'client',
  config: true,
  type: String,
  choices: Object.freeze({
    normal: 'Normal',
    extended: 'Extended',
    oncePerPhase: 'Once Per Phase',
    disabled: 'Disabled'
  }),
  default: 'normal'
});

const UI_SOUNDS_OPTIONS = Object.freeze({
  name: 'UI Sounds',
  hint: 'Game Only keeps unit control and dialog sounds and mutes the blips on sheets and menus.',
  scope: 'user',
  config: true,
  type: String,
  choices: Object.freeze({ all: 'All', game: 'Game Only', none: 'None' }),
  default: 'all'
});

const DIFFICULTY_OPTIONS = Object.freeze({
  name: 'Difficulty',
  hint: 'Raises HP, Atk, Acc, Spd, Stn, Def and Res on every Enemy and Boss unit at any level above Normal.',
  scope: 'world',
  config: true,
  requiresReload: false,
  type: String,
  choices: Object.freeze({ normal: 'Normal', veteran: 'Veteran', extreme: 'Extreme', lunatic: 'Lunatic' }),
  default: 'normal'
});

/**
 * System settings registered by init/registrations.mjs. The hidden world settings (operation record, movement lock,
 * Enemy AI map hold, karma ledger, campaign parties) hold live shared state. Only a GM's client can write a world
 * setting, and each write fires updateSetting on every client.
 */
export const SETTING_DEFINITIONS = Object.freeze([
  Object.freeze({ id: OPERATION_RECORD_SETTING,
    options: Object.freeze({ name: 'Operation record', scope: 'world', config: false, type: Object, default: null }) }),
  Object.freeze({ id: SCHEMA_VERSION_SETTING,
    options: Object.freeze({ name: 'Schema version', scope: 'world', config: false, type: Number, default: 0 }) }),
  Object.freeze({ id: BG3_SHOW_ITEM_USES_SETTING,
    options: Object.freeze({ name: 'Show BG3 HUD Item uses', scope: 'client', config: false,
      type: Boolean, default: true }) }),
  Object.freeze({ id: AUTO_POPULATE_ENABLED_SETTING,
    options: Object.freeze({ name: 'Auto-populate BG3 HUD', scope: 'world', config: false,
      type: Boolean, default: true }) }),
  Object.freeze({ id: AUTO_POPULATE_CHARACTERS_SETTING,
    options: Object.freeze({ name: 'Auto-populate player Characters', scope: 'world', config: false,
      type: Boolean, default: false }) }),
  Object.freeze({ id: AUTO_POPULATE_CONFIGURATION_SETTING,
    options: Object.freeze({ name: 'Auto-populate configuration', scope: 'world', config: false,
      type: Object, default: Object.freeze({
        grid0: Object.freeze(['weapon', 'spell-attack']),
        grid1: Object.freeze(['spell-utility', 'ability-active', 'ability-utility']),
        grid2: Object.freeze(['consumable', 'miscellaneous'])
      }) }) }),
  Object.freeze({ id: CAMPAIGN_PARTIES_SETTING,
    options: Object.freeze({ name: 'Campaign parties', scope: 'world', config: false, type: Object, default: null }) }),
  Object.freeze({ id: TERRAIN_BUILDER_GRID_SETTING,
    options: Object.freeze({ name: 'Show the Terrain Builder grid', scope: 'client', config: false,
      type: Boolean, default: true }) }),
  Object.freeze({ id: USER_LOCK_SETTING,
    options: Object.freeze({ name: 'Board control lock', scope: 'world', config: false,
      type: Object, default: null }) }),
  Object.freeze({ id: DRIVEN_HOLD_SETTING,
    options: Object.freeze({ name: 'Driven board hold', scope: 'world', config: false,
      type: Object, default: null }) }),
  Object.freeze({ id: TOKEN_ROTATION_LOCK_SETTING, options: TOKEN_ROTATION_LOCK_OPTIONS }),
  Object.freeze({ id: TERRAIN_TIPS_MODE_SETTING, options: TERRAIN_TIPS_MODE_OPTIONS }),
  Object.freeze({ id: VOICELINE_FREQUENCY_SETTING, options: VOICELINE_FREQUENCY_OPTIONS }),
  Object.freeze({ id: UI_SOUNDS_SETTING, options: UI_SOUNDS_OPTIONS }),
  Object.freeze({ id: TOKEN_TOOLTIP_SCALE_SETTING,
    options: Object.freeze({
      name: 'Token Tooltip Scale',
      hint: 'How large the token tooltip is drawn while the Show Token Tooltip key is held. 0.5 is the original size.',
      scope: 'client',
      config: true,
      type: Number,
      default: TOKEN_TOOLTIP_DEFAULT_SCALE,
      range: Object.freeze({ min: 0.5, max: 1, step: 0.05 })
    }) }),
  Object.freeze({ id: VOICE_OVER_VOLUME_SETTING,
    options: Object.freeze({ name: 'Voice-Over volume', scope: 'client', config: false,
      type: Number, default: 0.5 }) }),
  Object.freeze({ id: VOICE_PATH_APPROVALS_SETTING,
    options: Object.freeze({ name: 'Approved unit audio folders', scope: 'world', config: false,
      type: Object, default: Object.freeze({}) }) }),
  Object.freeze({ id: DIFFICULTY_SETTING, options: DIFFICULTY_OPTIONS }),
  Object.freeze({ id: HIT_CHANCE_MODEL_SETTING,
    options: Object.freeze({
      name: 'Hit Chance Model',
      hint: 'Choose the random model used for attacks, meaningful skill checks, and saving throws.',
      scope: 'world',
      config: true,
      requiresReload: false,
      type: String,
      choices: Object.freeze({ karmic: 'Karmic', trueRng: 'True RNG', twoRn: 'Two Random Numbers' }),
      default: 'karmic'
    }) }),
  Object.freeze({ id: FLYER_TARGETING_SETTING,
    options: Object.freeze({
      name: 'Flyer Targeting',
      hint: 'Whether melee weapons can target flying units: Aerial never allows it, and Classic allows an '
        + 'adjacent one within the normal melee elevation limit.',
      scope: 'world',
      config: true,
      requiresReload: false,
      type: String,
      choices: Object.freeze({ aerial: 'Aerial', classic: 'Classic' }),
      default: 'aerial'
    }) }),
  Object.freeze({ id: CINEMATIC_BATTLE_SETTING,
    options: Object.freeze({
      name: 'Camera: Battle',
      hint: 'Letterbox and zoom in when a combat exchange begins.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    }) }),
  Object.freeze({ id: CINEMATIC_ABILITIES_SETTING,
    options: Object.freeze({
      name: 'Camera: Abilities',
      hint: 'Letterbox and zoom in when an Ability is activated.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    }) }),
  Object.freeze({ id: CINEMATIC_CASTING_SETTING,
    options: Object.freeze({
      name: 'Camera: Casting',
      hint: 'Letterbox and zoom in when a Spell or utility staff is cast.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    }) }),
  Object.freeze({ id: CINEMATIC_ITEM_USAGE_SETTING,
    options: Object.freeze({
      name: 'Camera: Item Usage',
      hint: 'Letterbox and zoom in when a Consumable is used.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    }) }),
  Object.freeze({ id: COMBAT_CINEMATIC_ZOOM_SETTING,
    options: Object.freeze({
      name: 'Camera: Zoom',
      hint: 'How far the camera zooms in for any of the above. Higher is closer.',
      scope: 'client',
      config: true,
      type: Number,
      default: 2,
      range: Object.freeze({ min: 0.5, max: 3, step: 0.1 })
    }) }),
  Object.freeze({ id: CINEMATIC_PHASE_CAMERA_SETTING,
    options: Object.freeze({
      name: 'Camera: Phase Opening',
      hint: 'As a phase opens, pan to each unit that bleeds, is poisoned or stands in a hazard, then to your party.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    }) }),
  Object.freeze({ id: ENEMY_PHASE_CAMERA_ZOOM_SETTING,
    options: Object.freeze({
      name: 'Camera: Enemy Phase Zoom',
      hint: 'How far the camera pulls back during the enemy phase. Lower shows more of the map.',
      scope: 'client',
      config: true,
      type: Number,
      default: 1,
      range: Object.freeze({ min: 0.3, max: 1, step: 0.05 })
    }) }),
  Object.freeze({ id: CENTER_CAMERA_ON_SELECT_SETTING,
    options: Object.freeze({
      name: 'Camera: Center on Selection',
      hint: 'Pan to a unit when you select it to move.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    }) }),
  Object.freeze({ id: CENTER_CAMERA_SPEED_SETTING,
    options: Object.freeze({
      name: 'Camera: Centering Speed',
      hint: 'How quickly the camera pans to a selected unit.',
      scope: 'client',
      config: true,
      type: String,
      choices: CAMERA_SPEED_CHOICES,
      default: 'verySmooth'
    }) }),
  Object.freeze({ id: CAMERA_FOLLOW_MODE_SETTING,
    options: Object.freeze({
      name: 'Camera: Follow Movement',
      hint: 'How the camera tracks a unit as it moves.',
      scope: 'client',
      config: true,
      type: String,
      choices: Object.freeze({ off: 'Off', edgePan: 'Edge Pan', lockedCenter: 'Locked Center' }),
      default: 'edgePan'
    }) }),
  Object.freeze({ id: CAMERA_FOLLOW_MARGIN_SETTING,
    options: Object.freeze({
      name: 'Camera: Follow Margin',
      hint: 'Edge Pan only: how close to the screen edge a unit gets before the camera moves.',
      scope: 'client',
      config: true,
      type: String,
      choices: Object.freeze({ tight: 'Tight (30%)', loose: 'Loose (40%)', centered: 'Centered (50%)' }),
      default: 'centered'
    }) }),
  Object.freeze({ id: CAMERA_FOLLOW_SPEED_SETTING,
    options: Object.freeze({
      name: 'Camera: Follow Speed',
      hint: 'How quickly the camera moves while following a unit.',
      scope: 'client',
      config: true,
      type: String,
      choices: CAMERA_SPEED_CHOICES,
      default: 'verySmooth'
    }) }),
  Object.freeze({ id: KARMA_LEDGER_SETTING,
    options: Object.freeze({ name: 'Karma ledger', scope: 'world', config: false,
      type: Object, default: Object.freeze({}) }) }),
  Object.freeze({ id: RECIPE_LIBRARY_REVISION_SETTING,
    options: Object.freeze({ name: 'Recipe library revision', scope: 'world', config: false,
      type: Number, default: 0 }) }),
  Object.freeze({ id: SONG_LIBRARY_REVISION_SETTING,
    options: Object.freeze({ name: 'Song library revision', scope: 'world', config: false,
      type: Number, default: 0 }) }),
  Object.freeze({ id: XP_MULTIPLIER_SETTING,
    options: Object.freeze({
      name: 'XP Multiplier',
      hint: 'Scales the XP every unit earns from combat. 1 is normal and 0 awards none.',
      scope: 'world',
      config: true,
      type: Number,
      default: 1,
      range: Object.freeze({ min: 0, max: 2, step: 0.05 })
    }) }),
  Object.freeze({ id: PLAYER_CRITICAL_BONUS_SETTING,
    options: Object.freeze({
      name: 'To Player Crit Dmg. Multiplier',
      hint: 'Multiplies the extra crit damage enemies deal '
        + 'to Lords and Retainers. '
        + 'At 0.5, 10 extra damage becomes 5.',
      scope: 'world',
      config: true,
      requiresReload: false,
      type: Number,
      default: 1,
      range: PLAYER_CRITICAL_BONUS_RANGE
    }) }),
  Object.freeze({ id: TOKEN_OUTLINE_COLOUR_SETTING,
    options: Object.freeze({
      name: 'Token Outline Colour',
      hint: 'Outline colour drawn around tokens. Default #382040.',
      scope: 'world',
      config: true,
      fieldType: 'ColorField',
      fieldOptions: Object.freeze({ required: true, nullable: false, initial: TOKEN_OUTLINE_DEFAULT_COLOUR }),
      default: TOKEN_OUTLINE_DEFAULT_COLOUR
    }) })
]);

/* -------------------------------------------- */
/*  Configure Settings sections                 */
/* -------------------------------------------- */
/**
 * Settings groups used by init/registrations.mjs and foundry/patches/settings-sections.mjs.
 * Registration order determines display order.
 */
export const SETTING_SECTIONS = Object.freeze([
  Object.freeze({ label: 'Gameplay', settingIds: Object.freeze([
    DIFFICULTY_SETTING, HIT_CHANCE_MODEL_SETTING, FLYER_TARGETING_SETTING, XP_MULTIPLIER_SETTING,
    PLAYER_CRITICAL_BONUS_SETTING
  ]) }),
  Object.freeze({ label: 'Camera', settingIds: Object.freeze([
    CINEMATIC_BATTLE_SETTING, CINEMATIC_ABILITIES_SETTING, CINEMATIC_CASTING_SETTING, CINEMATIC_ITEM_USAGE_SETTING,
    COMBAT_CINEMATIC_ZOOM_SETTING, CINEMATIC_PHASE_CAMERA_SETTING, ENEMY_PHASE_CAMERA_ZOOM_SETTING,
    CENTER_CAMERA_ON_SELECT_SETTING, CENTER_CAMERA_SPEED_SETTING, CAMERA_FOLLOW_MODE_SETTING,
    CAMERA_FOLLOW_MARGIN_SETTING, CAMERA_FOLLOW_SPEED_SETTING
  ]) }),
  Object.freeze({ label: 'Interface', settingIds: Object.freeze([
    TERRAIN_TIPS_MODE_SETTING, TOKEN_TOOLTIP_SCALE_SETTING, VOICELINE_FREQUENCY_SETTING, UI_SOUNDS_SETTING
  ]) }),
  Object.freeze({ label: 'Tokens', settingIds: Object.freeze([
    TOKEN_OUTLINE_COLOUR_SETTING, TOKEN_ROTATION_LOCK_SETTING
  ]) })
]);
