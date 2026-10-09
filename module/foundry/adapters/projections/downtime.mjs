/** @layer foundry/adapters/projections */
import { FACTION_GROUPS } from '../../../contracts/domains/characters.mjs';
import {
  DOWNTIME_ENTITY_FLAG, DOWNTIME_FLAG, DOWNTIME_ROSTER_FACTIONS, DOWNTIME_STATION_TYPES, normalizeFactions
} from '../../../contracts/domains/downtime.mjs';
import { WEAPON_PROFICIENCIES } from '../../../contracts/domains/items.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { INNATE_GRANT_FLAG } from '../../../game/character/innate-grants.mjs';
import { CHARACTER_INVENTORY_LIMITS, characterPocketCount } from '../../../game/character/inventory.mjs';
import { characterAvatarScale } from '../../../game/character/rules.mjs';
import {
  hydrateIngredients, mealPassiveAmong, resolveRecipeLibrary
} from '../../../game/downtime/cooking.mjs';
import { performanceMarkAmong, resolveSongLibrary } from '../../../game/downtime/performance.mjs';
import { downtimeCommitment, narrowRoster } from '../../../game/downtime/rules.mjs';
import { haggleEntries } from '../../../game/economy/haggle.mjs';
import { isInboundItem } from '../../../game/economy/inbound.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import {
  currentCookbook, currentRecipeChanges, currentSongChanges, currentSongbook
} from '../services/json-files.mjs';
import { projectActorStatusKeys, projectProficiencyByKey } from './combat-context.mjs';
import { projectTrackFacts } from './encounters.mjs';
import { projectAttributeTotals, projectSkillRanks } from './items.mjs';
import { normalizePartyState, projectActorPartyId } from './parties.mjs';

/* -------------------------------------------- */
/*  Stations                                    */
/* -------------------------------------------- */
/** A Gathering Node as the activity reads it: its authored rule and every gatherable with its stock. */
export function projectGatheringStation(token) {
  const actor = token?.actor ?? null;
  const system = actor?.system ?? {};
  const gathering = system.gathering ?? {};
  return Object.freeze({
    tokenUuid: String(token?.uuid ?? ''),
    actorUuid: String(actor?.uuid ?? ''),
    name: String(actor?.name ?? token?.name ?? ''),
    image: String(actor?.img ?? token?.texture?.src ?? ''),
    objectType: String(system.objectType ?? ''),
    gathering: Object.freeze({
      description: String(gathering.description ?? ''),
      skill: String(gathering.skill ?? ''),
      multiplier: Number(gathering.multiplier) || 0,
      animType: String(gathering.animType ?? ''),
      items: Object.freeze((gathering.items ?? []).map(entry => Object.freeze({
        uuid: String(entry?.uuid ?? ''),
        name: String(entry?.name ?? ''),
        img: String(entry?.img ?? ''),
        total: Number(entry?.total) || 0,
        weight: Number(entry?.weight) || 0,
        hidden: entry?.hidden === true
      })))
    })
  });
}

/** A Workshop or Laboratory as the activity reads it: the fixture alone, since the work is on what units carry. */
export function projectCraftingStation(token) {
  const actor = token?.actor ?? null;
  return Object.freeze({
    tokenUuid: String(token?.uuid ?? ''),
    actorUuid: String(actor?.uuid ?? ''),
    name: String(actor?.name ?? token?.name ?? ''),
    image: String(actor?.img ?? token?.texture?.src ?? ''),
    objectType: String(actor?.system?.objectType ?? '')
  });
}

/**
 * One carried Equipment copy as the forge reads it: where it sits, what it is, whether a rule granted it, and its
 * stored source.
 */
export function projectForgeable(item, owner, ownerLabel) {
  const data = item?.toObject?.() ?? {};
  return Object.freeze({
    itemUuid: String(item?.uuid ?? ''),
    itemId: String(item?.id ?? ''),
    ownerUuid: String(owner?.uuid ?? ''),
    ownerLabel: String(ownerLabel ?? ''),
    name: String(item?.name ?? ''),
    image: String(item?.img ?? ''),
    type: String(item?.type ?? ''),
    itemType: String(data.system?.itemType ?? ''),
    innateGrant: Boolean(item?.getFlag?.(SYSTEM_ID, INNATE_GRANT_FLAG)),
    source: Object.freeze(data.system ?? {})
  });
}

/**
 * The Resource stacks an owner holds, as a job draws from them. A Convoy's inbound Items are not yet delivered, so
 * no downtime activity reaches them.
 */
export function projectResourceStacks(owner) {
  const stacks = collectionValues(owner?.items).filter(item => item?.type === 'Resource' && !isInboundItem(item));
  return Object.freeze(stacks.map(item => Object.freeze({
    ownerUuid: String(owner?.uuid ?? ''),
    itemId: String(item.id ?? ''),
    name: String(item.name ?? ''),
    img: String(item.img ?? ''),
    amount: Number(item.system?.amount) || 0,
    foodType: String(item.system?.foodType ?? '')
  })));
}

/**
 * A Stationary's faction rows as the requisition reads and rewrites them: the persisted rows, falling back to the
 * prepared ones, through normalizeFactions. An unlinked station's Actor already merges its Token's ActorDelta.
 * @param {object} actor The Stationary's Actor.
 * @returns {readonly object[]} Detached, frozen rows.
 */
export function projectStationFactions(actor) {
  const rows = actor?._source?.system?.requisition?.factions ?? actor?.system?.requisition?.factions;
  return Object.freeze(normalizeFactions(rows).map(row => Object.freeze(row)));
}

/* -------------------------------------------- */
/*  Recipes                                     */
/* -------------------------------------------- */
/** The recipe library in force: the shipped cookbook with the world's `json/recipes.json` changes laid over it. */
export function projectStoredRecipeLibrary() {
  return Object.freeze({
    recipes: Object.freeze(resolveRecipeLibrary(currentCookbook().recipes, currentRecipeChanges()))
  });
}

/** The recipe library with each ingredient's uuid and art taken from the live Resource of that name. */
export function projectRecipeLibrary(byName) {
  return Object.freeze(projectStoredRecipeLibrary().recipes.map(recipe => hydrateIngredients(recipe, byName)));
}

/** The recipe ids a unit has been taught. */
export function projectKnownRecipeIds(actor) {
  const ids = actor?.system?.knowledge?.recipes;
  return Object.freeze(Array.isArray(ids) ? ids.filter(Boolean).map(String) : []);
}

/** The Personal recipes a unit has been taught that are still in the library, for its character sheet. */
export function projectKnownRecipes(actor) {
  const known = new Set(projectKnownRecipeIds(actor));
  return Object.freeze(projectStoredRecipeLibrary().recipes.filter(recipe => known.has(recipe.id)));
}

/** One recipe as the laboratory reads it, from a world Item or a compendium index entry carrying its creation. */
export function projectRecipe(entry, source = '') {
  const creation = entry?.system?.craftingData?.creation ?? {};
  return Object.freeze({
    uuid: String(entry?.uuid ?? ''),
    name: String(entry?.name ?? ''),
    image: String(entry?.img ?? ''),
    type: String(entry?.type ?? ''),
    itemType: String(entry?.system?.itemType ?? ''),
    creation: Object.freeze({
      materials: Object.freeze((creation.materials ?? []).map(material => Object.freeze({
        uuid: String(material?.uuid ?? ''), name: String(material?.name ?? ''), img: String(material?.img ?? ''),
        quantity: Number(material?.quantity) || 0
      }))),
      difficultyClass: Number(creation.difficultyClass) || 0,
      skillCheck: String(creation.skillCheck ?? '')
    }),
    description: String(entry?.system?.description ?? ''),
    source: String(source ?? '')
  });
}

/* -------------------------------------------- */
/*  Songs                                       */
/* -------------------------------------------- */
/** The song library in force: the shipped songbook with the world's `json/songs.json` changes laid over it. */
export function projectStoredSongLibrary() {
  return Object.freeze({
    songs: Object.freeze(resolveSongLibrary(currentSongbook().songs, currentSongChanges()))
  });
}

/**
 * The songs the performance menu and the song library editor read, each a detached copy. A song keeps its track
 * uuid as authored, and FoundryPerformanceMusic resolves it only when the song is performed.
 */
export function projectSongLibrary() {
  return Object.freeze(projectStoredSongLibrary().songs.map(song => Object.freeze(structuredClone(song))));
}

/**
 * The details of every track the song library links, keyed by uuid, for the performance view's track card
 * (FoundryDowntimeRepository.getPerformanceSnapshot). A track that no longer resolves is left out, which the
 * Instrument menu shows as a missing track.
 */
export function projectSongTracks(library) {
  const facts = {};
  for (const song of library ?? []) {
    const uuid = String(song?.track ?? '');
    if (!uuid || uuid in facts) continue;
    const track = projectTrackFacts(uuid);
    if (track) facts[uuid] = track;
  }
  return Object.freeze(facts);
}

/** The Personal song ids a unit has been taught, from `system.knowledge.songs`. */
export function projectKnownSongIds(actor) {
  const ids = actor?.system?.knowledge?.songs;
  return Object.freeze(Array.isArray(ids) ? ids.filter(Boolean).map(String) : []);
}

/* -------------------------------------------- */
/*  Roster                                      */
/* -------------------------------------------- */
/**
 * One placed Character as a downtime activity sees it: who it is, its party, whether it is down at 0 HP, what it
 * rolls with, what it has left, the meal and performance it already carries, and the Personal recipes and songs it
 * knows. game/downtime/social.mjs directs and rewards a training session by its level, experience multiplier and
 * weapon proficiencies.
 */
function projectDowntimeUnit(token, actor, partyId) {
  const system = actor.system;
  const statuses = projectActorStatusKeys(actor);
  return Object.freeze({
    pocketCount: characterPocketCount(collectionValues(actor.items)),
    pocketLimit: CHARACTER_INVENTORY_LIMITS.pockets,
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    owned: actor.isOwner === true,
    partyId,
    name: String(actor.name ?? token.name ?? ''),
    image: String(actor.img ?? token.texture?.src ?? ''),
    avatarScale: characterAvatarScale(system.art),
    actorType: String(system.faction.role ?? ''),
    attributes: projectAttributeTotals(system),
    skills: projectSkillRanks(system),
    blessed: statuses.has('blessed') || system.statuses.blessed === true,
    defeated: finite(system.resources.hp.value) < 1,
    energy: Object.freeze({
      value: Math.max(0, Number(system.resources.energy.value) || 0),
      max: Math.max(0, Number(system.resources.energy.max) || 0)
    }),
    commitment: downtimeCommitment(actor.getFlag?.(SYSTEM_ID, DOWNTIME_FLAG)
      ?? actor.flags?.[SYSTEM_ID]?.[DOWNTIME_FLAG]),
    mealName: mealPassiveAmong(collectionValues(actor.items).map(item => String(item?.name ?? ''))),
    recipeIds: projectKnownRecipeIds(actor),
    performanceMark: performanceMarkAmong(collectionValues(actor.items)),
    songIds: projectKnownSongIds(actor),
    level: Math.max(1, Math.floor(finite(system.progression.level, 1)) || 1),
    experienceMultiplier: finite(system.stats.expMultiplier.total, 100),
    proficiencies: Object.freeze(Object.fromEntries(
      WEAPON_PROFICIENCIES.map(key => [key, projectProficiencyByKey(actor, key)])))
  });
}

/**
 * Who can join an activity: the starting unit's party members placed on this scene (narrowRoster in
 * game/downtime/rules.mjs). A starting unit in no party, or a world with no party state, joins alone. Each unit's
 * party comes from projectActorPartyId, the same one the targeting pickers use.
 */
export function projectDowntimeRoster(scene, cursorActor, parties = null) {
  const stored = parties?.readState?.() ?? null;
  const state = stored ? normalizePartyState(stored) : null;
  const present = new Map();
  for (const token of collectionValues(scene?.tokens)) {
    const actor = token?.actor;
    if (!actor || actor.type !== 'Character') continue;
    if (!DOWNTIME_ROSTER_FACTIONS.includes(String(actor.system.faction.role ?? ''))) continue;
    const unit = projectDowntimeUnit(token, actor, state ? projectActorPartyId(actor, state) : null);
    if (!present.has(unit.actorUuid)) present.set(unit.actorUuid, unit);
  }
  return narrowRoster([...present.values()], String(cursorActor?.uuid ?? ''));
}

/* -------------------------------------------- */
/*  GM administration                           */
/* -------------------------------------------- */
/**
 * One unit as the GM's exploration roster controls read it: who it is, what it committed to, and what Energy it
 * holds. FoundryDowntimeRepository hands this to engine/downtime/commands.mjs for the reset and restore commands.
 */
export function projectDowntimeUnitState(actor) {
  const resources = actor.system.resources;
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    name: String(actor.name ?? ''),
    commitment: downtimeCommitment(actor.getFlag?.(SYSTEM_ID, DOWNTIME_FLAG)
      ?? actor.flags?.[SYSTEM_ID]?.[DOWNTIME_FLAG]),
    energy: Math.max(0, Number(resources.energy.value) || 0),
    energyMax: Math.max(0, Number(resources.energy.max) || 0)
  });
}

/**
 * Everything the GM's Reset Downtime puts back on one Scene, for FoundryDowntimeRepository.getDowntimeResetSnapshot:
 * every placed party unit (the factions free exploration refills) with its commitment and Energy, every unit with
 * a buff from a downtime activity, every Stationary with its faction rows, and every Vendor with the number of
 * haggles it holds (haggleEntries in game/economy/haggle.mjs). A unit, station or Vendor placed twice counts once.
 */
export function projectDowntimeReset(scene) {
  const units = new Map();
  const stations = new Map();
  const vendors = new Map();
  for (const token of collectionValues(scene?.tokens)) {
    const actor = token?.actor;
    const uuid = String(actor?.uuid ?? '');
    if (!actor || units.has(uuid) || stations.has(uuid) || vendors.has(uuid)) continue;
    const name = String(actor.name ?? token.name ?? '');
    if (actor.type === 'Character' && FACTION_GROUPS.player.includes(String(actor.system?.faction?.role ?? ''))) {
      units.set(uuid, projectDowntimeUnitState(actor));
    } else if (actor.type === 'Object'
      && String(actor.system?.objectType ?? '') === DOWNTIME_STATION_TYPES.REQUISITION) {
      stations.set(uuid, Object.freeze({
        tokenUuid: String(token.uuid ?? ''), actorUuid: uuid, name, factions: projectStationFactions(actor)
      }));
    } else if (actor.type === 'Vendor') {
      vendors.set(uuid, Object.freeze({
        tokenUuid: String(token.uuid ?? ''), actorUuid: uuid, name, haggles: haggleEntries(actor.system?.haggles).length
      }));
    }
  }
  return Object.freeze({
    units: Object.freeze([...units.values()]),
    carriers: projectDowntimeBuffs(scene),
    stations: Object.freeze([...stations.values()]),
    vendors: Object.freeze([...vendors.values()])
  });
}

/**
 * Every placed unit carrying a buff a downtime activity granted, with the Item ids the GM's Reset Downtime deletes:
 * a cook's meal passive and a performance's Inspired or Uninspired passive, each tagged with DOWNTIME_ENTITY_FLAG as
 * game/downtime builds it.
 */
export function projectDowntimeBuffs(scene) {
  const carriers = new Map();
  for (const token of collectionValues(scene?.tokens)) {
    const actor = token?.actor;
    if (!actor || actor.type !== 'Character' || carriers.has(String(actor.uuid))) continue;
    const buffs = collectionValues(actor.items)
      .filter(item => item.getFlag?.(SYSTEM_ID, DOWNTIME_ENTITY_FLAG) === true
        || item.flags?.[SYSTEM_ID]?.[DOWNTIME_ENTITY_FLAG] === true);
    if (!buffs.length) continue;
    carriers.set(String(actor.uuid), Object.freeze({
      actorUuid: String(actor.uuid),
      name: String(actor.name ?? ''),
      itemIds: Object.freeze(buffs.map(item => String(item.id))),
      itemNames: Object.freeze(buffs.map(item => String(item.name ?? '')))
    }));
  }
  return Object.freeze([...carriers.values()]);
}
