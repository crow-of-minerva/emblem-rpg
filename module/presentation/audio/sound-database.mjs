/** @layer presentation/audio */

/* -------------------------------------------- */
/*  Sound catalog                               */
/* -------------------------------------------- */
export const COMBAT_SOUND_PATH = 'systems/emblem-rpg/sound/combat/';

/**
 * Ids for every bundled sound, which AudioService plays by id. The Enemy AI plays them by id too, through
 * game.emblemRpg.api.presentation.audio.play, so an id must not change once published. SOUND_DATABASE maps each id
 * to its file.
 */
export const SOUND_IDS = Object.freeze({
  ANIMATION_TIMING_MARKER: 'animation.timing-marker',
  UI_SELECT: 'ui.select',
  UI_SELECT_ALT: 'ui.select-alt',
  UI_UNSELECT: 'ui.unselect',
  UI_CONFIRM: 'ui.confirm',
  UI_CONFIRM_ALT: 'ui.confirm-alt',
  UI_SELECT_3: 'ui.select-3',
  UI_BLIP_1: 'ui.blip-1',
  UI_BLIP_2: 'ui.blip-2',
  UI_BLIP_4: 'ui.blip-4',
  UI_BLIP_5: 'ui.blip-5',
  UI_PURCHASE: 'ui.purchase',
  DOWNTIME_GATHER_HARVESTING: 'downtime.gather-harvesting',
  DOWNTIME_GATHER_MINING: 'downtime.gather-mining',
  DOWNTIME_GATHER_LOGGING: 'downtime.gather-logging',
  DOWNTIME_GATHER_SHOVELING: 'downtime.gather-shoveling',
  DOWNTIME_GATHER_FISHING: 'downtime.gather-fishing',
  DOWNTIME_FORGE: 'downtime.forge',
  DOWNTIME_BREW: 'downtime.brew',
  DOWNTIME_COOK: 'downtime.cook',
  UI_EXPAND: 'ui.expand',
  UI_COLLAPSE: 'ui.collapse',
  UI_FANFARE: 'ui.fanfare',
  UI_CLICK: 'ui.click',
  UI_ERROR: 'ui.error',
  UI_FAILURE: 'ui.failure',
  UI_SUCCESS: 'ui.success',
  UI_PING: 'ui.ping',
  PROGRESSION_XP_GAIN: 'progression.xp-gain',
  PROGRESSION_LEVEL_UP: 'progression.level-up',
  PROGRESSION_LEVEL_DING: 'progression.level-ding',
  COMBAT_BEGIN: 'combat.begin',
  COMBAT_PHASE_PLAYER: 'combat.phase.player',
  COMBAT_PHASE_ENEMY: 'combat.phase.enemy',
  COMBAT_EXPLORATION_BEGIN: 'combat.exploration-begin',
  COMBAT_MAP_CLEARED: 'combat.map-cleared',
  COMBAT_MAP_DEFEAT: 'combat.map-defeat',
  COMBAT_STANCE_BREAK: 'combat.stance-break',
  COMBAT_HIT_ABSORB: 'combat.hit.absorb',
  COMBAT_HIT_ARCANE_1: 'combat.hit.arcane-1',
  COMBAT_HIT_ARCANE_2: 'combat.hit.arcane-2',
  COMBAT_HIT_CRITICAL: 'combat.hit.critical',
  COMBAT_HIT_DECAY: 'combat.hit.decay',
  COMBAT_HIT_FINAL: 'combat.hit.final',
  COMBAT_HIT_FIRE: 'combat.hit.fire',
  COMBAT_HIT_GENERIC: 'combat.hit.generic',
  COMBAT_HIT_HOLY_1: 'combat.hit.holy-1',
  COMBAT_HIT_HOLY_2: 'combat.hit.holy-2',
  COMBAT_HIT_ICE: 'combat.hit.ice',
  COMBAT_HIT_LIGHTNING: 'combat.hit.lightning',
  COMBAT_HIT_SHADOW: 'combat.hit.shadow',
  COMBAT_HIT_SOFT: 'combat.hit.soft',
  COMBAT_HIT_WIND: 'combat.hit.wind',
  COMBAT_NO_DAMAGE: 'combat.no-damage',
  COMBAT_MISS: 'combat.miss',
  COMBAT_PARRY: 'combat.parry',
  COMBAT_RESIST: 'combat.resist',
  COMBAT_CRITICAL_FLASH: 'combat.critical-flash',
  COMBAT_CRITICAL_BANNER: 'combat.critical-banner',
  COMBAT_UNIT_FADE: 'combat.unit-fade',
  COMBAT_WEAPON_ART_ACTIVATE: 'combat.weapon-art-activate',
  MAGIC_LIGHT_CHARGE: 'magic.light-charge',
  MAGIC_ELECTRIC_CACKLE: 'magic.electric-cackle',
  MAGIC_LOOP: 'magic.loop',
  MAGIC_PUFF_OF_SMOKE: 'magic.puff-of-smoke',
  MISC_HEARTBEAT: 'misc.heartbeat',
  MOVEMENT_CLIMB: 'movement.climb',
  OBJECT_CHEST_OPEN: 'object.chest-open',
  OBJECT_CHEST_CLOSE: 'object.chest-close',
  OBJECT_DOOR_OPEN: 'object.door-open',
  OBJECT_DOOR_CLOSE: 'object.door-close',
  OBJECT_DESTRUCTION_1: 'object.destruction-1',
  OBJECT_DESTRUCTION_2: 'object.destruction-2',
  OBJECT_DESTRUCTION_3: 'object.destruction-3',
  FOOTSTEPS_ARMOR: 'footsteps.armor',
  FOOTSTEPS_BEAST: 'footsteps.beast',
  FOOTSTEPS_CORPSE: 'footsteps.corpse',
  FOOTSTEPS_DRAGON: 'footsteps.dragon',
  FOOTSTEPS_FLAP: 'footsteps.flap',
  FOOTSTEPS_FLYING: 'footsteps.flying',
  FOOTSTEPS_FOOT: 'footsteps.foot',
  FOOTSTEPS_GIANT: 'footsteps.giant',
  FOOTSTEPS_GOOEY: 'footsteps.gooey',
  FOOTSTEPS_HORSE: 'footsteps.horse',
  FOOTSTEPS_LARGE_BEAST: 'footsteps.large-beast',
  FOOTSTEPS_LEVITATION: 'footsteps.levitation',
  FOOTSTEPS_METALLIC: 'footsteps.metallic',
  FOOTSTEPS_OGRE: 'footsteps.ogre',
  FOOTSTEPS_SKELETON: 'footsteps.skeleton',
  FOOTSTEPS_SPIDER: 'footsteps.spider'
});
/**
 * Each sound's file (or `files` to choose from) under the system folder, with its volume, `loop`, and `floorMs`, the
 * shortest gap AudioService allows between two plays.
 */
export const SOUND_DATABASE = Object.freeze({
  [SOUND_IDS.ANIMATION_TIMING_MARKER]: Object.freeze({
    file: 'sound/ui/blip-3.wav',
    volume: 0.6
  }),
  [SOUND_IDS.UI_SELECT]: Object.freeze({
    file: 'sound/ui/select-1.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_SELECT_ALT]: Object.freeze({
    file: 'sound/ui/select-2.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_UNSELECT]: Object.freeze({
    file: 'sound/ui/unselect.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_CONFIRM]: Object.freeze({
    file: 'sound/ui/confirm.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_CONFIRM_ALT]: Object.freeze({
    file: 'sound/ui/confirm-2.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_SELECT_3]: Object.freeze({
    file: 'sound/ui/select-3.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_BLIP_1]: Object.freeze({
    file: 'sound/ui/blip-1.wav',
    volume: 0.25
  }),
  [SOUND_IDS.UI_BLIP_2]: Object.freeze({
    file: 'sound/ui/blip-2.wav',
    volume: 0.25
  }),
  [SOUND_IDS.UI_BLIP_4]: Object.freeze({
    file: 'sound/ui/blip-4.wav',
    volume: 0.25
  }),
  [SOUND_IDS.UI_BLIP_5]: Object.freeze({
    file: 'sound/ui/blip-5.wav',
    volume: 0.25
  }),
  [SOUND_IDS.UI_CLICK]: Object.freeze({
    file: 'sound/ui/click.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_PURCHASE]: Object.freeze({
    file: 'sound/ui/purchase.wav',
    volume: 0.5
  }),
  [SOUND_IDS.UI_EXPAND]: Object.freeze({
    file: 'sound/ui/expand.wav',
    volume: 0.5,
    floorMs: 500
  }),
  [SOUND_IDS.UI_COLLAPSE]: Object.freeze({
    file: 'sound/ui/collapse.wav',
    volume: 0.5,
    floorMs: 500
  }),
  [SOUND_IDS.UI_FANFARE]: Object.freeze({
    file: 'sound/ui/fanfare.wav',
    volume: 1
  }),
  [SOUND_IDS.UI_ERROR]: Object.freeze({
    file: 'sound/ui/error.wav',
    volume: 0.5,
    floorMs: 1000
  }),
  [SOUND_IDS.UI_FAILURE]: Object.freeze({
    file: 'sound/ui/failure.wav',
    volume: 0.6
  }),
  [SOUND_IDS.UI_SUCCESS]: Object.freeze({
    file: 'sound/ui/success.wav',
    volume: 0.6
  }),
  [SOUND_IDS.UI_PING]: Object.freeze({
    file: 'sound/ui/ping.wav',
    volume: 0.6
  }),
  [SOUND_IDS.OBJECT_CHEST_OPEN]: Object.freeze({ file: 'sound/misc/chest-open.wav', volume: 0.5 }),
  [SOUND_IDS.OBJECT_CHEST_CLOSE]: Object.freeze({ file: 'sound/misc/chest-close.wav', volume: 0.5 }),
  [SOUND_IDS.OBJECT_DOOR_OPEN]: Object.freeze({ file: 'sound/misc/door-open.wav', volume: 0.5 }),
  [SOUND_IDS.OBJECT_DOOR_CLOSE]: Object.freeze({ file: 'sound/misc/door-close.wav', volume: 0.5 }),
  [SOUND_IDS.OBJECT_DESTRUCTION_1]: Object.freeze({ file: 'sound/misc/destructible-1.wav', volume: 0.5 }),
  [SOUND_IDS.OBJECT_DESTRUCTION_2]: Object.freeze({ file: 'sound/misc/destructible-2.wav', volume: 0.5 }),
  [SOUND_IDS.OBJECT_DESTRUCTION_3]: Object.freeze({ file: 'sound/misc/destructible-3.wav', volume: 0.5 }),
  [SOUND_IDS.PROGRESSION_XP_GAIN]: Object.freeze({
    file: 'sound/ui/gain-xp.wav',
    volume: 0.3,
    loop: true
  }),
  [SOUND_IDS.PROGRESSION_LEVEL_UP]: Object.freeze({
    file: 'sound/ui/level-up.wav',
    volume: 1
  }),
  [SOUND_IDS.PROGRESSION_LEVEL_DING]: Object.freeze({
    file: 'sound/ui/level-ding.wav',
    volume: 1
  }),
  [SOUND_IDS.COMBAT_BEGIN]: Object.freeze({
    file: 'sound/combat/begin-combat.wav',
    volume: 0.5
  }),
  [SOUND_IDS.COMBAT_PHASE_PLAYER]: Object.freeze({
    file: 'sound/combat/player-phase.wav',
    volume: 1
  }),
  [SOUND_IDS.COMBAT_PHASE_ENEMY]: Object.freeze({
    file: 'sound/combat/enemy-phase.wav',
    volume: 1
  }),
  [SOUND_IDS.COMBAT_EXPLORATION_BEGIN]: Object.freeze({
    file: 'sound/ui/begin-exploration.wav',
    volume: 0.5
  }),
  [SOUND_IDS.COMBAT_MAP_CLEARED]: Object.freeze({
    file: 'sound/combat/map-cleared.wav',
    volume: 0.5
  }),
  [SOUND_IDS.COMBAT_MAP_DEFEAT]: Object.freeze({
    file: 'sound/combat/map-defeat.wav',
    volume: 1
  }),
  [SOUND_IDS.COMBAT_STANCE_BREAK]: Object.freeze({
    file: 'sound/combat/stance-break.wav',
    volume: 0.75
  }),
  [SOUND_IDS.COMBAT_HIT_ABSORB]: Object.freeze({ file: 'sound/combat/hit-absorb.wav' }),
  [SOUND_IDS.COMBAT_HIT_ARCANE_1]: Object.freeze({ file: 'sound/combat/hit-arcane-1.wav' }),
  [SOUND_IDS.COMBAT_HIT_ARCANE_2]: Object.freeze({ file: 'sound/combat/hit-arcane-2.wav' }),
  [SOUND_IDS.COMBAT_HIT_CRITICAL]: Object.freeze({ file: 'sound/combat/hit-crit.wav' }),
  [SOUND_IDS.COMBAT_HIT_DECAY]: Object.freeze({ file: 'sound/combat/hit-decay.wav' }),
  [SOUND_IDS.COMBAT_HIT_FINAL]: Object.freeze({ file: 'sound/combat/hit-final.wav' }),
  [SOUND_IDS.COMBAT_HIT_FIRE]: Object.freeze({ file: 'sound/combat/hit-fire.wav' }),
  [SOUND_IDS.COMBAT_HIT_GENERIC]: Object.freeze({ file: 'sound/combat/hit-generic.wav', volume: 0.5 }),
  [SOUND_IDS.COMBAT_HIT_HOLY_1]: Object.freeze({ file: 'sound/combat/hit-holy-1.wav' }),
  [SOUND_IDS.COMBAT_HIT_HOLY_2]: Object.freeze({ file: 'sound/combat/hit-holy-2.wav' }),
  [SOUND_IDS.COMBAT_HIT_ICE]: Object.freeze({ file: 'sound/combat/hit-ice.wav' }),
  [SOUND_IDS.COMBAT_HIT_LIGHTNING]: Object.freeze({ file: 'sound/combat/hit-lightning.wav' }),
  [SOUND_IDS.COMBAT_HIT_SHADOW]: Object.freeze({ file: 'sound/combat/hit-shadow.wav' }),
  [SOUND_IDS.COMBAT_HIT_SOFT]: Object.freeze({ file: 'sound/combat/hit-soft.wav' }),
  [SOUND_IDS.COMBAT_HIT_WIND]: Object.freeze({ file: 'sound/combat/hit-wind.wav' }),
  [SOUND_IDS.COMBAT_NO_DAMAGE]: Object.freeze({ file: 'sound/combat/no-dmg.wav', volume: 0.5 }),
  [SOUND_IDS.COMBAT_MISS]: Object.freeze({ file: 'sound/combat/miss-1.wav', volume: 0.5 }),
  [SOUND_IDS.COMBAT_PARRY]: Object.freeze({ file: 'sound/combat/parry.wav', volume: 0.5 }),
  [SOUND_IDS.COMBAT_RESIST]: Object.freeze({ file: 'sound/combat/resist.wav', volume: 0.5 }),
  [SOUND_IDS.COMBAT_CRITICAL_FLASH]: Object.freeze({ file: 'sound/combat/crit-flash.wav' }),
  [SOUND_IDS.COMBAT_CRITICAL_BANNER]: Object.freeze({ file: 'sound/combat/crit-banner.wav' }),
  [SOUND_IDS.COMBAT_UNIT_FADE]: Object.freeze({ file: 'sound/combat/unit-fade.wav', volume: 0.5 }),
  [SOUND_IDS.COMBAT_WEAPON_ART_ACTIVATE]: Object.freeze({ file: 'sound/mag/skill-activate.wav', volume: 0.5 }),
  [SOUND_IDS.MAGIC_LIGHT_CHARGE]: Object.freeze({ file: 'sound/mag/light-charge.wav' }),
  [SOUND_IDS.MAGIC_ELECTRIC_CACKLE]: Object.freeze({ file: 'sound/mag/electric-cackle.wav' }),
  [SOUND_IDS.MAGIC_LOOP]: Object.freeze({ file: 'sound/mag/magic-loop.wav' }),
  [SOUND_IDS.MAGIC_PUFF_OF_SMOKE]: Object.freeze({ file: 'sound/mag/puff-of-smoke.mp3' }),
  [SOUND_IDS.MISC_HEARTBEAT]: Object.freeze({ file: 'sound/misc/heartbeat.wav' }),
  [SOUND_IDS.DOWNTIME_GATHER_HARVESTING]: gatherPool('harvest'),
  [SOUND_IDS.DOWNTIME_GATHER_MINING]: gatherPool('mining'),
  [SOUND_IDS.DOWNTIME_GATHER_LOGGING]: gatherPool('logging'),
  [SOUND_IDS.DOWNTIME_GATHER_SHOVELING]: gatherPool('shoveling'),
  [SOUND_IDS.DOWNTIME_GATHER_FISHING]: gatherPool('fishing'),
  [SOUND_IDS.DOWNTIME_FORGE]: Object.freeze({
    files: Object.freeze(Array.from({ length: 4 }, (_value, index) => `sound/misc/anvil-hit-${index + 1}.wav`)), volume: 0.5
  }),
  [SOUND_IDS.DOWNTIME_BREW]: Object.freeze({ file: 'sound/misc/create-potion.wav', volume: 0.55 }),
  [SOUND_IDS.DOWNTIME_COOK]: Object.freeze({ file: 'sound/misc/cooking.mp3', volume: 0.6 }),
  [SOUND_IDS.MOVEMENT_CLIMB]: Object.freeze({ file: 'sound/misc/climb.wav', volume: 0.8 }),
  [SOUND_IDS.FOOTSTEPS_ARMOR]: soundPool('armor', 6),
  [SOUND_IDS.FOOTSTEPS_BEAST]: soundPool('beast', 2),
  [SOUND_IDS.FOOTSTEPS_CORPSE]: soundPool('corpse', 2),
  [SOUND_IDS.FOOTSTEPS_DRAGON]: soundPool('dragon', 2),
  [SOUND_IDS.FOOTSTEPS_FLAP]: soundPool('flap', 2),
  [SOUND_IDS.FOOTSTEPS_FLYING]: soundPool('flying', 1, false),
  [SOUND_IDS.FOOTSTEPS_FOOT]: soundPool('foot', 6),
  [SOUND_IDS.FOOTSTEPS_GIANT]: soundPool('giant', 2),
  [SOUND_IDS.FOOTSTEPS_GOOEY]: soundPool('gooey', 4),
  [SOUND_IDS.FOOTSTEPS_HORSE]: soundPool('horse', 2),
  [SOUND_IDS.FOOTSTEPS_LARGE_BEAST]: soundPool('large-beast', 4),
  [SOUND_IDS.FOOTSTEPS_LEVITATION]: soundPool('lev', 2),
  [SOUND_IDS.FOOTSTEPS_METALLIC]: soundPool('metallic', 6),
  [SOUND_IDS.FOOTSTEPS_OGRE]: soundPool('ogre', 2),
  [SOUND_IDS.FOOTSTEPS_SKELETON]: soundPool('skeleton', 4),
  [SOUND_IDS.FOOTSTEPS_SPIDER]: soundPool('spider', 2)
});

/* -------------------------------------------- */
/*  Catalog helpers                             */
/* -------------------------------------------- */
/** The two working sounds of one gathering method, played in turn as the work banner strikes. */
function gatherPool(stem) {
  return Object.freeze({ files: Object.freeze([`sound/misc/${stem}-1.wav`, `sound/misc/${stem}-2.wav`]), volume: 0.5 });
}

function soundPool(stem, count, numbered = true) {
  const files = numbered
    ? Array.from({ length: count }, (_value, index) => `sound/fstp/${stem}-${index + 1}.wav`)
    : [`sound/fstp/${stem}.wav`];
  return Object.freeze({ files: Object.freeze(files) });
}
