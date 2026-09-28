/** @layer foundry/adapters/document-writes */
import {
  KARMA_LEDGER_SETTING, RECIPE_LIBRARY_REVISION_SETTING, SONG_LIBRARY_REVISION_SETTING
} from '../../../config/settings.mjs';
import { ENGAGEMENT_KINDS } from '../../../contracts/domains/characters.mjs';
import {
  DOWNTIME_FLAG, DOWNTIME_STATION_TYPES, GATHER_DESTINATIONS, TRAINING_SPAR, TRAINING_SPAR_ITEMS
} from '../../../contracts/domains/downtime.mjs';
import { validate as validateAnimation } from '../../../contracts/dsl/animations.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { CHARACTER_INVENTORY_LIMITS, characterPocketCount, matchingResourceStack } from '../../../game/character/inventory.mjs';
import {
  INGREDIENT_RESOURCE_TYPES, hydrateIngredients, planRecipeLibraryChanges
} from '../../../game/downtime/cooking.mjs';
import { craftingKind, isBrewable, stationForges } from '../../../game/downtime/crafting.mjs';
import { planSongLibraryChanges, resolveSongLibrary } from '../../../game/downtime/performance.mjs';
import { planFactionLock } from '../../../game/downtime/requisition.mjs';
import { isInboundItem } from '../../../game/economy/inbound.mjs';
import { selectAnimationRange } from '../../../game/effects/animation-planning.mjs';
import { resolveStandingDestination } from '../../../game/movement/pathfinding.mjs';
import { cellsAdjacent } from '../../../game/objects/rules.mjs';
import { clamp, collectionValues } from '../../../lib/core/runtime.mjs';
import {
  projectCraftingStation, projectDowntimeReset, projectDowntimeRoster, projectDowntimeUnitState, projectForgeable,
  projectGatheringStation, projectRecipe, projectRecipeLibrary, projectResourceStacks, projectSongLibrary,
  projectSongTracks, projectStationFactions
} from '../projections/downtime.mjs';
import { projectLinkedConvoys } from '../projections/economy.mjs';
import { stripVendorTags, vendorTagCaptures, vendorTagHolders } from './economy.mjs';
import { readItemCatalog } from '../projections/items.mjs';
import { projectPhaseTrackOptions, sceneExplorationActive } from '../projections/encounters.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';
import { worldExperienceMultiplier } from '../services/settings-policy.mjs';
import {
  cookbookReady, currentCookbook, currentSongbook, recipeLibraryReady, songLibraryReady, songbookReady,
  writeRecipeChanges, writeSongChanges
} from '../services/json-files.mjs';
import {
  displaceToken, readSetting, resolveActor, resolveItem, resolveScene, resolveToken,
  tokenFootprintCells as footprintCells
} from '../services/host.mjs';

const settlementOptions = () => ({ emblemDowntimeSettlement: true });
const stagingOptions = () => ({ animate: false, showRuler: false, autoRotate: false,
  constrainOptions: { ignoreWalls: true, ignoreCost: true } });
const RECIPE_INDEX_FIELDS = ['system.itemType', 'system.craftingData.creation', 'system.description'];
/** The official Items pack, whose ingredients a recipe names before any world copy or other pack. */
const OFFICIAL_ITEM_PACK_UUID = 'Compendium.emblem-rpg-content.items.';
/** The Item types a training spar's animation may be borrowed from: weapons, and the spells of the casting schools. */
const SPAR_ITEM_TYPES = Object.freeze(['Equipment', 'Spell', 'Ability', 'Consumable', 'Miscellaneous']);
/** Where a Stationary keeps its faction rows, the one path a requisition and the GM's reset write on it. */
const STATION_FACTIONS_PATH = 'system.requisition.factions';
/** Where a Vendor keeps each party's haggle, added by FoundryTradeRepository.settleHaggle and cleared by the reset. */
const VENDOR_HAGGLES_PATH = 'system.haggles';
const ENERGY_VALUE_PATH = 'system.resources.energy.value';

/* -------------------------------------------- */
/*  Downtime repository                         */
/* -------------------------------------------- */
/**
 * Reads and writes for engine/downtime: the station activities, the recipe and song libraries, and the GM's resets.
 *
 * Staging the performer and settling an activity are one unit of work: the command's operation captures the
 * performer, the station, the Items that change and the karma ledger before the first write, so a refusal has
 * CommandDispatcher put the unit back where it stood with its supplies intact.
 */
export class FoundryDowntimeRepository {
  constructor({ movements, parties = null }) {
    this.movements = movements;
    this.parties = parties;
  }

  /**
   * CommandDispatcher lock keys: the board, the Scene, the Tokens involved and every inventory Actor the driving
   * unit can draw on (see #reach). A socialize or training session adds its partner's Token, whose Actor is already
   * in the roster. A requisition, the only payload naming a faction, also locks the Stationary's Actor.
   */
  async resourceKeys(payload = {}) {
    const keys = ['movement:board'];
    const cursor = String(payload.cursorTokenUuid ?? '');
    const scene = cursor.split('.Token.')[0];
    if (scene) keys.push(`scene:${scene}`);
    for (const uuid of [payload.cursorTokenUuid, payload.stationTokenUuid, payload.partnerTokenUuid]) {
      if (uuid) keys.push(`token:${uuid}`);
    }
    if (payload.performerUuid) keys.push(`actor:${payload.performerUuid}`);
    if (payload.factionId !== undefined && payload.stationTokenUuid) {
      const station = (await resolveToken(payload.stationTokenUuid))?.actor;
      if (station) keys.push(`actor:${station.uuid}`);
    }
    const cursorToken = await resolveToken(cursor);
    if (cursorToken?.actor && cursorToken.parent) {
      const { owners } = await this.#reach(cursorToken.parent, cursorToken.actor);
      for (const actorUuid of owners.keys()) keys.push(`actor:${actorUuid}`);
    }
    return [...new Set(keys)].sort();
  }

  /* -------------------------------------------- */
  /*  Reading                                     */
  /* -------------------------------------------- */
  /**
   * Everything a gather is planned from: the node with each gatherable whose source Resource no longer resolves
   * marked `missing`, whether the unit stands next to it, the roster and its Convoy.
   */
  async getGatheringSnapshot(intent) {
    const cursorToken = await resolveToken(intent.cursorTokenUuid);
    const stationToken = await resolveToken(intent.stationTokenUuid);
    const cursor = cursorToken?.actor;
    const stationActor = stationToken?.actor;
    if (!cursor || cursor.type !== 'Character' || !stationActor || stationActor.type !== 'Object') return null;
    if (String(stationActor.system?.objectType ?? '') !== DOWNTIME_STATION_TYPES.GATHERING) return null;
    const scene = cursorToken.parent;
    if (!scene || stationToken.parent !== scene || stationToken.hidden === true) return null;
    const gridSize = scene.grid.size;
    const movement = await this.movements.getSnapshot(cursorToken.uuid);
    const { convoy, roster, owners } = await this.#reach(scene, cursor);
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      gridSize,
      cursor: Object.freeze({
        actorUuid: String(cursor.uuid), tokenUuid: String(cursorToken.uuid), name: String(cursor.name ?? ''),
        movementPlanning: movement?.movementPlanning === true
      }),
      station: await markMissingSources(projectGatheringStation(stationToken)),
      stationCell: Object.freeze({ ...footprintCells(stationToken, gridSize)[0] }),
      inReach: cellsAdjacent(footprintCells(cursorToken, gridSize), footprintCells(stationToken, gridSize)),
      exploring: sceneExplorationActive(scene) === true,
      roster,
      convoy: convoy ? Object.freeze({ uuid: convoy.actorUuid, name: convoy.name }) : null,
      writableActorUuids: Object.freeze([...owners.keys()])
    });
  }

  /**
   * Project the crafting station, reachable inventories and Convoys, workable items and Resource stacks. Include
   * recipes for a Laboratory.
   */
  async getCraftingSnapshot(intent) {
    const cursorToken = await resolveToken(intent.cursorTokenUuid);
    const stationToken = await resolveToken(intent.stationTokenUuid);
    const cursor = cursorToken?.actor;
    const stationActor = stationToken?.actor;
    if (!cursor || cursor.type !== 'Character' || !stationActor || stationActor.type !== 'Object') return null;
    const station = projectCraftingStation(stationToken);
    if (!craftingKind(station.objectType)) return null;
    const scene = cursorToken.parent;
    if (!scene || stationToken.parent !== scene || stationToken.hidden === true) return null;
    const gridSize = scene.grid.size;
    const movement = await this.movements.getSnapshot(cursorToken.uuid);
    const { convoy, roster, owners } = await this.#reach(scene, cursor);
    const items = [];
    const stacks = {};
    for (const [uuid, { actor, label }] of owners) {
      for (const item of collectionValues(actor.items)) {
        if (item.type !== 'Equipment' || isInboundItem(item)) continue;
        const forgeable = projectForgeable(item, actor, label);
        if (stationForges(station.objectType, forgeable)) items.push(forgeable);
      }
      stacks[uuid] = projectResourceStacks(actor);
    }
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      gridSize,
      cursor: Object.freeze({
        actorUuid: String(cursor.uuid), tokenUuid: String(cursorToken.uuid), name: String(cursor.name ?? ''),
        movementPlanning: movement?.movementPlanning === true
      }),
      station,
      stationCell: Object.freeze({ ...footprintCells(stationToken, gridSize)[0] }),
      inReach: cellsAdjacent(footprintCells(cursorToken, gridSize), footprintCells(stationToken, gridSize)),
      exploring: sceneExplorationActive(scene) === true,
      roster,
      convoy: convoy ? Object.freeze({ uuid: convoy.actorUuid, name: convoy.name }) : null,
      writableActorUuids: Object.freeze([...owners.keys()]),
      items: Object.freeze(items),
      stacks: Object.freeze(stacks),
      recipes: station.objectType === DOWNTIME_STATION_TYPES.LABORATORY ? await this.#recipePool() : Object.freeze([])
    });
  }

  /** Project the cooking station, reachable ingredients, roster meals and known recipes for engine/downtime. */
  async getCookingSnapshot(intent) {
    const cursorToken = await resolveToken(intent.cursorTokenUuid);
    const stationToken = await resolveToken(intent.stationTokenUuid);
    const cursor = cursorToken?.actor;
    const stationActor = stationToken?.actor;
    if (!cursor || cursor.type !== 'Character' || !stationActor || stationActor.type !== 'Object') return null;
    const station = projectCraftingStation(stationToken);
    if (station.objectType !== DOWNTIME_STATION_TYPES.COOKING) return null;
    const scene = cursorToken.parent;
    if (!scene || stationToken.parent !== scene || stationToken.hidden === true) return null;
    const gridSize = scene.grid.size;
    const movement = await this.movements.getSnapshot(cursorToken.uuid);
    const { convoy, roster, owners } = await this.#reach(scene, cursor);
    const stacks = {};
    for (const [uuid, { actor }] of owners) stacks[uuid] = projectResourceStacks(actor);
    await recipeLibraryReady();
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      gridSize,
      cursor: Object.freeze({
        actorUuid: String(cursor.uuid), tokenUuid: String(cursorToken.uuid), name: String(cursor.name ?? ''),
        movementPlanning: movement?.movementPlanning === true
      }),
      station,
      stationCell: Object.freeze({ ...footprintCells(stationToken, gridSize)[0] }),
      inReach: cellsAdjacent(footprintCells(cursorToken, gridSize), footprintCells(stationToken, gridSize)),
      exploring: sceneExplorationActive(scene) === true,
      roster,
      convoy: convoy ? Object.freeze({ uuid: convoy.actorUuid, name: convoy.name }) : null,
      writableActorUuids: Object.freeze([...owners.keys()]),
      stacks: Object.freeze(stacks),
      library: projectRecipeLibrary(await this.#ingredientsByName())
    });
  }

  /**
   * Project the instrument, the roster with the performance each unit already carries and the songs it knows, and
   * the song library, for the perform command and inspectPerformance in engine/downtime/commands.mjs. A performance
   * writes only roster units, so they are the Actors the command must hold.
   */
  async getPerformanceSnapshot(intent) {
    const cursorToken = await resolveToken(intent.cursorTokenUuid);
    const stationToken = await resolveToken(intent.stationTokenUuid);
    const cursor = cursorToken?.actor;
    const stationActor = stationToken?.actor;
    if (!cursor || cursor.type !== 'Character' || !stationActor || stationActor.type !== 'Object') return null;
    const station = projectCraftingStation(stationToken);
    if (station.objectType !== DOWNTIME_STATION_TYPES.PERFORMANCE) return null;
    const scene = cursorToken.parent;
    if (!scene || stationToken.parent !== scene || stationToken.hidden === true) return null;
    const gridSize = scene.grid.size;
    const movement = await this.movements.getSnapshot(cursorToken.uuid);
    const { roster } = await this.#reach(scene, cursor);
    await songLibraryReady();
    const library = projectSongLibrary();
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      gridSize,
      cursor: Object.freeze({
        actorUuid: String(cursor.uuid), tokenUuid: String(cursorToken.uuid), name: String(cursor.name ?? ''),
        movementPlanning: movement?.movementPlanning === true
      }),
      station,
      stationCell: Object.freeze({ ...footprintCells(stationToken, gridSize)[0] }),
      inReach: cellsAdjacent(footprintCells(cursorToken, gridSize), footprintCells(stationToken, gridSize)),
      exploring: sceneExplorationActive(scene) === true,
      roster,
      writableActorUuids: Object.freeze(roster.map(unit => unit.actorUuid)),
      library,
      tracks: projectSongTracks(library)
    });
  }

  /**
   * Project the Stationary, its faction rows, and the roster with the Convoy each unit is linked to, for the
   * requisition command and inspectRequisition in engine/downtime/commands.mjs. A requisition writes the
   * requisitioner, the station's rows and, when granted, the requisitioner's Convoy, so the roster, every linked
   * Convoy and the station's Actor (an unlinked Token's synthetic one included) are the Actors the command holds.
   */
  async getRequisitionSnapshot(intent) {
    const cursorToken = await resolveToken(intent.cursorTokenUuid);
    const stationToken = await resolveToken(intent.stationTokenUuid);
    const cursor = cursorToken?.actor;
    const stationActor = stationToken?.actor;
    if (!cursor || cursor.type !== 'Character' || !stationActor || stationActor.type !== 'Object') return null;
    const station = projectCraftingStation(stationToken);
    if (station.objectType !== DOWNTIME_STATION_TYPES.REQUISITION) return null;
    const scene = cursorToken.parent;
    if (!scene || stationToken.parent !== scene || stationToken.hidden === true) return null;
    const gridSize = scene.grid.size;
    const movement = await this.movements.getSnapshot(cursorToken.uuid);
    const { convoy, roster, owners } = await this.#reach(scene, cursor);
    const convoys = {};
    for (const { convoyUuid } of roster) {
      const wagon = convoyUuid ? owners.get(convoyUuid)?.actor : null;
      if (wagon) convoys[convoyUuid] = Object.freeze({ uuid: convoyUuid, name: String(wagon.name ?? '') });
    }
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      gridSize,
      cursor: Object.freeze({
        actorUuid: String(cursor.uuid), tokenUuid: String(cursorToken.uuid), name: String(cursor.name ?? ''),
        movementPlanning: movement?.movementPlanning === true
      }),
      station,
      stationCell: Object.freeze({ ...footprintCells(stationToken, gridSize)[0] }),
      inReach: cellsAdjacent(footprintCells(cursorToken, gridSize), footprintCells(stationToken, gridSize)),
      exploring: sceneExplorationActive(scene) === true,
      roster,
      convoy: convoy ? Object.freeze({ uuid: convoy.actorUuid, name: convoy.name }) : null,
      stationActorUuid: String(stationActor.uuid),
      factions: projectStationFactions(stationActor),
      convoys: Object.freeze(convoys),
      writableActorUuids: Object.freeze([
        ...roster.map(unit => unit.actorUuid), ...Object.keys(convoys), String(stationActor.uuid)
      ])
    });
  }

  /**
   * Project a pair of party units for the socialize and train commands and inspectSocial in
   * engine/downtime/commands.mjs: the driving unit, the adjacent unit it visited, whether their Tokens touch, the
   * roster game/downtime/social.mjs checks both against, and the world's experience multiplier the menu previews
   * level experience with. Both Tokens must be Characters on the same Scene. A socialize or a training session
   * writes only the pair, so the roster covers every Actor the command must hold. A training intent also resolves
   * the spar its opening beat plays.
   */
  async getSocialSnapshot(intent) {
    const cursorToken = await resolveToken(intent.cursorTokenUuid);
    const partnerToken = await resolveToken(intent.partnerTokenUuid);
    const cursor = cursorToken?.actor;
    const partner = partnerToken?.actor;
    if (!cursor || cursor.type !== 'Character' || !partner || partner.type !== 'Character') return null;
    const scene = cursorToken.parent;
    if (!scene || partnerToken.parent !== scene) return null;
    const gridSize = scene.grid.size;
    const movement = await this.movements.getSnapshot(cursorToken.uuid);
    const { roster } = await this.#reach(scene, cursor);
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      gridSize,
      cursor: Object.freeze({
        actorUuid: String(cursor.uuid), tokenUuid: String(cursorToken.uuid), name: String(cursor.name ?? ''),
        movementPlanning: movement?.movementPlanning === true
      }),
      partner: Object.freeze({
        actorUuid: String(partner.uuid), tokenUuid: String(partnerToken.uuid), name: String(partner.name ?? '')
      }),
      inReach: cellsAdjacent(footprintCells(cursorToken, gridSize), footprintCells(partnerToken, gridSize)),
      exploring: sceneExplorationActive(scene) === true,
      roster,
      writableActorUuids: Object.freeze(roster.map(unit => unit.actorUuid)),
      worldExperienceMultiplier: worldExperienceMultiplier(),
      spar: intent.proficiencyKey ? await this.#sparFor(intent.proficiencyKey) : null
    });
  }

  /**
   * The spar a training session in one proficiency plays: the first Item named in TRAINING_SPAR_ITEMS, a world
   * copy before any pack for each name, that carries an authored melee attack or activation animation. The
   * animation is dropped, leaving no spar to play, when it is invalid or too long for a presentation beat.
   */
  async #sparFor(proficiencyKey) {
    const names = TRAINING_SPAR_ITEMS[proficiencyKey] ?? [];
    if (!names.length) return null;
    const catalog = await readItemCatalog(SPAR_ITEM_TYPES);
    for (const name of names) {
      const entry = catalog.find(candidate => candidate.name.trim().toLowerCase() === name.toLowerCase());
      const item = entry ? await resolveItem(entry.uuid) : null;
      const slots = item?.system?.animV2 ?? {};
      const authored = selectAnimationRange(slots.attack, ENGAGEMENT_KINDS.MELEE)
        ?? selectAnimationRange(slots.activation, ENGAGEMENT_KINDS.MELEE);
      if (!authored) continue;
      const animation = structuredClone(authored);
      return Object.freeze({
        itemName: String(item.name ?? name),
        itemUuid: String(item.uuid ?? entry.uuid),
        animation: sparAnimationFits(animation) ? animation : null,
        passDurationMs: clamp(Number(animation.duration) || TRAINING_SPAR.defaultPassMs,
          TRAINING_SPAR.minPassMs, TRAINING_SPAR.maxPassMs)
      });
    }
    return null;
  }

  /**
   * The names of a socialize or training pair whose snapshot could not be read, so the socialize and train commands
   * in engine/downtime/commands.mjs can refuse naming the units. A Token that is gone gives an empty name.
   */
  async getPairNames(intent) {
    const name = token => String(token?.actor?.name ?? token?.name ?? '');
    return Object.freeze({
      actorName: name(await resolveToken(intent.cursorTokenUuid)),
      partnerName: name(await resolveToken(intent.partnerTokenUuid))
    });
  }

  /** The roster and the inventories it can draw on (units and linked Convoys), for the snapshots and resourceKeys. */
  async #reach(scene, cursor) {
    const convoy = projectLinkedConvoys(cursor, this.parties)[0] ?? null;
    const roster = [];
    const owners = new Map();
    for (const unit of projectDowntimeRoster(scene, cursor, this.parties)) {
      const actor = await resolveActor(unit.actorUuid);
      if (!actor) continue;
      const own = projectLinkedConvoys(actor, this.parties)[0] ?? null;
      roster.push(Object.freeze({ ...unit, convoyUuid: own ? String(own.actorUuid) : '' }));
      owners.set(String(actor.uuid), { actor, label: `Carried by ${actor.name}` });
      for (const linked of [convoy, own]) {
        const wagon = linked ? await resolveActor(linked.actorUuid) : null;
        if (!wagon || owners.has(String(wagon.uuid))) continue;
        owners.set(String(wagon.uuid), { actor: wagon, label: `In ${wagon.name}` });
      }
    }
    return { convoy, roster: Object.freeze(roster), owners };
  }

  /**
   * Every ingredient Resource the world offers by lower-cased name: the official pack's entry first, then a world
   * copy, then any other pack, so a stale imported copy cannot hide the shipped ingredient.
   */
  async #ingredientsByName() {
    const byName = new Map();
    const catalog = await readItemCatalog(['Resource'], { fields: ['system.resourceType'] });
    const official = entry => String(entry.uuid ?? '').startsWith(OFFICIAL_ITEM_PACK_UUID);
    for (const entry of [...catalog.filter(official), ...catalog.filter(entry => !official(entry))]) {
      if (!INGREDIENT_RESOURCE_TYPES.includes(String(entry.system?.resourceType ?? ''))) continue;
      const key = String(entry.name ?? '').toLowerCase();
      if (!key || byName.has(key)) continue;
      byName.set(key, Object.freeze({ uuid: String(entry.uuid ?? ''), name: String(entry.name ?? ''), img: String(entry.img ?? '') }));
    }
    return byName;
  }

  /* -------------------------------------------- */
  /*  Recipe library                              */
  /* -------------------------------------------- */
  /** The library with its art resolved, the shipped cookbook beside it, and whether this user may edit it. */
  async getRecipeLibrarySnapshot() {
    await recipeLibraryReady();
    return Object.freeze({
      canEdit: globalThis.game?.user?.isGM === true,
      recipes: projectRecipeLibrary(await this.#ingredientsByName()),
      builtins: Object.freeze(currentCookbook().recipes.map(recipe => hydrateIngredients(recipe, new Map())))
    });
  }

  /** Replace the whole library. The world's file keeps only what differs from the shipped cookbook. */
  async saveRecipeLibrary(recipes) {
    try {
      const list = (recipes ?? []).map(recipe => structuredClone(recipe));
      const cookbook = await cookbookReady();
      await this.#storeRecipeChanges(planRecipeLibraryChanges(cookbook.recipes, list));
      return { ok: true, count: list.length };
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'saveRecipeLibrary');
      return { ok: false, code: 'downtime.recipe-library-write-failed' };
    }
  }

  /** Point the world's stored ingredients at live art again, writing only when a recipe actually changed. */
  async repairRecipeLibraryArt() {
    const stored = await recipeLibraryReady();
    if (!stored.recipes.length) return 0;
    const byName = await this.#ingredientsByName();
    const fixed = stored.recipes.map(recipe => hydrateIngredients(recipe, byName));
    const changed = fixed.filter((recipe, index) => recipe !== stored.recipes[index]).length;
    if (!changed) return 0;
    try {
      await this.#storeRecipeChanges({ recipes: fixed, removed: stored.removed });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'repairRecipeLibraryArt');
      return 0;
    }
    return changed;
  }

  /** Write the world's recipe file, then bump the revision every client re-reads it on. */
  async #storeRecipeChanges(changes) {
    await writeRecipeChanges(changes);
    const revision = Number(readSetting(RECIPE_LIBRARY_REVISION_SETTING, 0)) || 0;
    await game.settings.set(SYSTEM_ID, RECIPE_LIBRARY_REVISION_SETTING, revision + 1);
  }

  /* -------------------------------------------- */
  /*  Song library                                */
  /* -------------------------------------------- */
  /**
   * The library, the shipped songbook beside it, whether this user may edit it, and the world's Playlists and
   * PlaylistSounds the song library editor offers as tracks.
   */
  async getSongLibrarySnapshot() {
    await songLibraryReady();
    return Object.freeze({
      canEdit: globalThis.game?.user?.isGM === true,
      songs: projectSongLibrary(),
      builtins: Object.freeze(currentSongbook().songs.map(song => Object.freeze(structuredClone(song)))),
      trackOptions: projectPhaseTrackOptions()
    });
  }

  /**
   * Replace the whole song library. The world's file keeps only what differs from the shipped songbook, and a
   * built-in missing from the list is stored as removed. Refused while the shipped songbook is unreadable, since
   * every built-in would then look removed.
   */
  async saveSongLibrary(songs) {
    try {
      const list = (songs ?? []).map(song => structuredClone(song));
      const songbook = await songbookReady();
      if (songbook.loaded !== true) throw new Error('The shipped songbook could not be read; nothing was saved');
      await this.#storeSongChanges(planSongLibraryChanges(songbook.songs, list));
      return { ok: true, count: list.length };
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'saveSongLibrary');
      return { ok: false, code: 'downtime.song-library-write-failed' };
    }
  }

  /**
   * Keep the world's song file minimal against the shipped songbook at startup: an edited built-in that now matches
   * the shipped song, a removal of a built-in the system no longer ships, and an entry a removal hides are dropped.
   * Writes only when something was dropped, and returns how many entries went.
   */
  async repairSongLibrary() {
    const stored = await songLibraryReady();
    const songbook = currentSongbook();
    if (stored.loaded !== true || songbook.loaded !== true) return 0;
    const planned = planSongLibraryChanges(songbook.songs, resolveSongLibrary(songbook.songs, stored));
    const repaired = (stored.songs.length - planned.songs.length) + (stored.removed.length - planned.removed.length);
    if (repaired <= 0) return 0;
    try {
      await this.#storeSongChanges(planned);
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'repairSongLibrary');
      return 0;
    }
    return repaired;
  }

  /** Write the world's song file, then bump the revision every client re-reads it on. */
  async #storeSongChanges(changes) {
    await writeSongChanges(changes);
    const revision = Number(readSetting(SONG_LIBRARY_REVISION_SETTING, 0)) || 0;
    await game.settings.set(SYSTEM_ID, SONG_LIBRARY_REVISION_SETTING, revision + 1);
  }

  /** Every consumable recipe the world offers, a world copy winning over a compendium entry of the same name. */
  async #recipePool() {
    const seen = new Set();
    const recipes = [];
    for (const entry of await readItemCatalog(['Consumable'], { fields: RECIPE_INDEX_FIELDS })) {
      const recipe = projectRecipe(entry, entry.source);
      const key = recipe.name.toLowerCase();
      if (seen.has(key) || !isBrewable(recipe)) continue;
      seen.add(key);
      recipes.push(recipe);
    }
    recipes.sort((a, b) => a.name.localeCompare(b.name));
    return Object.freeze(recipes);
  }

  /** The stored data a brewed copy is created from: the recipe Item's own, world or compendium. */
  async readProduct(recipeUuid) {
    const source = await resolveItem(recipeUuid);
    return source ? source.toObject() : null;
  }

  /**
   * Where the yield lands and what it may stack onto: the chosen Convoy when linked, else the performer's pockets.
   * The stacks are only those a landing joins (matchingResourceStack, vendor tags included), so a tagged stack of the
   * same Resource is no room.
   */
  async getDepositFacts(snapshot, performer, sendTo = GATHER_DESTINATIONS.CONVOY) {
    const performerActor = await resolveActor(performer.actorUuid);
    const convoy = sendTo === GATHER_DESTINATIONS.INVENTORY ? null
      : snapshot.convoy ?? projectLinkedConvoys(performerActor, this.parties)[0] ?? null;
    const destination = convoy ? await resolveActor(convoy.actorUuid ?? convoy.uuid) : performerActor;
    if (!destination) return null;
    const items = storedItems(destination);
    const found = await Promise.all(snapshot.station.gathering.items
      .map(entry => (entry.uuid ? resolveItem(entry.uuid) : null)));
    const facts = item => Object.freeze({
      name: String(item.name ?? ''), perUnit: Number(item.system?.cost?.perUnit) || 0
    });
    return Object.freeze({
      destination: Object.freeze({
        uuid: String(destination.uuid),
        name: String(destination.name ?? ''),
        isCharacter: destination.type === 'Character',
        pocketCount: characterPocketCount(items),
        pocketLimit: CHARACTER_INVENTORY_LIMITS.pockets,
        stacks: Object.freeze(items.filter(item => found.some(source => matchingResourceStack([item], source)))
          .map(facts))
      }),
      sources: Object.freeze(Object.fromEntries(found.map((source, index) => [index, source ? facts(source) : null])))
    });
  }

  /* -------------------------------------------- */
  /*  Staging                                     */
  /* -------------------------------------------- */
  /**
   * Put the performer at the station and hide the driving unit, remembering where each stood so the successful
   * end of the activity can send them back. If either half is refused, the operation's rollback undoes the staging.
   *
   * This is the staged activity's first capture, so it also records the karma ledger that the check
   * engine/downtime/resolvers.mjs rolls next will book, and unstagePerformer's capture adds nothing new.
   */
  async stagePerformer(snapshot, performer, operation = null) {
    const performerToken = await resolveToken(performer.tokenUuid);
    const cursorToken = await resolveToken(snapshot.cursor.tokenUuid);
    if (!performerToken || !cursorToken || performerToken.uuid === cursorToken.uuid) return null;
    const staging = Object.freeze({
      cursorTokenUuid: String(cursorToken.uuid),
      cursorHidden: cursorToken._source.hidden === true,
      performerTokenUuid: String(performerToken.uuid),
      home: Object.freeze({
        x: Number(performerToken._source.x) || 0, y: Number(performerToken._source.y) || 0
      })
    });
    try {
      await operation?.capture({
        documents: [cursorToken, performerToken], settings: [KARMA_LEDGER_SETTING]
      });
      await cursorToken.update({ hidden: true }, stagingOptions());
      if (cursorToken._source.hidden !== true) throw new Error('downtime.staging-hide-refused');
      const moved = await displaceToken(performerToken, snapshot.stationCell, snapshot.gridSize, stagingOptions());
      if (!moved || performerToken._source.x !== Math.round(snapshot.stationCell.x) * snapshot.gridSize
        || performerToken._source.y !== Math.round(snapshot.stationCell.y) * snapshot.gridSize) {
        throw new Error('downtime.staging-move-refused');
      }
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'stagePerformer');
      return null;
    }
    return staging;
  }

  /** Send a staged performer home and reveal the driving unit. Each half is tried whether or not the other worked. */
  async unstagePerformer(staging, operation = null) {
    const performerToken = staging ? await resolveToken(staging.performerTokenUuid) : null;
    const cursorToken = staging ? await resolveToken(staging.cursorTokenUuid) : null;
    if (!performerToken || !cursorToken) return false;
    let settled = true;
    await operation?.capture({ documents: [performerToken, cursorToken] });
    const returns = [[performerToken, { ...staging.home }], [cursorToken, { hidden: staging.cursorHidden }]];
    for (const [token, changes] of returns) {
      try {
        await token.update({ ...changes }, stagingOptions());
        if (Object.entries(changes).some(([path, value]) => token._source[path] !== value)) settled = false;
      } catch (diagnosticError) {
        reportFoundryError(import.meta.url, diagnosticError, 'unstagePerformer');
        settled = false;
      }
    }
    return settled;
  }

  /* -------------------------------------------- */
  /*  Settlement                                  */
  /* -------------------------------------------- */
  /** Spend the performer's Energy, land every drawn unit, and write the node's remaining stock. */
  async settleGathering(snapshot, { performer, spend, deposit, destinationUuid }, context) {
    const performerActor = await resolveActor(performer.actorUuid);
    const nodeActor = await resolveActor(snapshot.station.actorUuid);
    const destination = await resolveActor(destinationUuid);
    if (!performerActor || !nodeActor || !destination) return { ok: false, code: 'downtime.aggregate-missing' };
    try {
      const landings = await planLandings(destination, snapshot.station.gathering.items, deposit.deposits);
      await context.operation?.capture({
        documents: [performerActor, nodeActor, ...landings.map(landing => landing.stack).filter(Boolean)],
        creating: reservedCreations(destination, landings)
      });
      await performerActor.update(energySpendChanges(spend), settlementOptions());
      for (const landing of landings) await landDrawnResource(destination, landing);
      await nodeActor.update({
        'system.gathering.items': deposit.items.map(entry => ({ ...entry }))
      }, settlementOptions());
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settleGathering');
      return { ok: false, code: 'downtime.settlement-write-failed' };
    }
    return { ok: true, destinationUuid: String(destination.uuid), destinationName: String(destination.name ?? '') };
  }

  /** Spend the Energy and the materials, then write the copy's durability and its forging tally. */
  async settleForging(snapshot, { performer, spend, draws, item, forged }, context) {
    const owner = await resolveActor(item.ownerUuid);
    const performerActor = await resolveActor(performer.actorUuid);
    const copy = owner?.items.get(item.itemId) ?? null;
    if (!copy || !performerActor) return { ok: false, code: 'downtime.aggregate-missing' };
    try {
      const groups = await planDraws(draws);
      const drawn = drawCaptures(groups);
      await context.operation?.capture({
        documents: [performerActor, copy, ...drawn.documents], deleting: drawn.deleting
      });
      await performerActor.update(energySpendChanges(spend), settlementOptions());
      await drawMaterials(groups);
      await owner.updateEmbeddedDocuments('Item', [{
        _id: item.itemId,
        'system.uses.current': forged.usesAfter,
        'system.craftingData.forgingXP': forged.forgingXP
      }], settlementOptions());
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settleForging');
      return { ok: false, code: 'downtime.settlement-write-failed' };
    }
    const written = owner.items.get(item.itemId) ?? copy;
    return {
      ok: true,
      itemName: String(written.name ?? ''),
      usesCurrent: Number(written.system?.uses?.current) || 0,
      usesMax: Number(written.system?.uses?.max) || 0
    };
  }

  /** Spend the Energy and the materials, then land every brewed copy where the plan sent it. */
  async settleBrewing(snapshot, { performer, spend, draws, deliveries, product }, context) {
    const performerActor = await resolveActor(performer.actorUuid);
    const destinations = new Map();
    for (const delivery of deliveries) {
      if (destinations.has(delivery.destinationUuid)) continue;
      const destination = await resolveActor(delivery.destinationUuid);
      if (!destination) return { ok: false, code: 'downtime.aggregate-missing' };
      destinations.set(delivery.destinationUuid, destination);
    }
    if (!performerActor || (deliveries.length && !product)) return { ok: false, code: 'downtime.aggregate-missing' };
    try {
      const groups = await planDraws(draws);
      const drawn = drawCaptures(groups);
      const copies = deliveries.map(delivery => ({
        destination: destinations.get(delivery.destinationUuid), data: structuredClone(product), id: reservedId()
      }));
      await context.operation?.capture({
        documents: [performerActor, ...drawn.documents], deleting: drawn.deleting, creating: creationClaims(copies)
      });
      await performerActor.update(energySpendChanges(spend), settlementOptions());
      await drawMaterials(groups);
      for (const copy of copies) await createReserved(copy);
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settleBrewing');
      return { ok: false, code: 'downtime.settlement-write-failed' };
    }
    return { ok: true, destinations: [...new Set(deliveries.map(
      delivery => String(destinations.get(delivery.destinationUuid).name ?? '')))] };
  }

  /** Commit the chef's whole downtime, draw every ingredient, and put the meal on every diner. */
  async settleCooking(snapshot, { performer, commitment, draws, meals }, context) {
    const performerActor = await resolveActor(performer.actorUuid);
    if (!performerActor) return { ok: false, code: 'downtime.aggregate-missing' };
    const diners = new Map();
    for (const meal of meals) {
      const diner = await resolveActor(meal.actorUuid);
      if (!diner) return { ok: false, code: 'downtime.aggregate-missing' };
      diners.set(meal.actorUuid, diner);
    }
    try {
      const groups = await planDraws(draws);
      const drawn = drawCaptures(groups);
      const served = meals.map(meal => ({
        destination: diners.get(meal.actorUuid), data: structuredClone(meal.data), id: reservedId()
      }));
      await context.operation?.capture({
        documents: [performerActor, ...drawn.documents], deleting: drawn.deleting, creating: creationClaims(served)
      });
      await performerActor.update({
        [`flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`]: { ...commitment }
      }, settlementOptions());
      await drawMaterials(groups);
      for (const meal of served) await createReserved(meal);
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settleCooking');
      return { ok: false, code: 'downtime.settlement-write-failed' };
    }
    return { ok: true, fed: meals.map(meal => String(diners.get(meal.actorUuid).name ?? '')) };
  }

  /**
   * Commit the lead performer's whole downtime and put the performance's passive on every audience unit. The lead's
   * system flags and every reserved passive id are captured in one call before the first write, so a refusal takes
   * the passives off again and gives the lead its downtime back, the flag scope too when the commitment
   * introduced it. Accompaniments spend nothing.
   * @param {object} snapshot The performance snapshot the plan was drawn from.
   * @param {{performer: object, commitment: object, passives: Array<{actorUuid: string, data: object}>}} settlement
   * @param {{operation?: object}} context The command context whose operation captures the writes.
   * @returns {Promise<Readonly<{ok: boolean, affected?: string[], code?: string}>>}
   */
  async settlePerformance(snapshot, { performer, commitment, passives = [] }, context) {
    const lead = await resolveActor(performer.actorUuid);
    if (!lead) return Object.freeze({ ok: false, code: 'downtime.aggregate-missing' });
    const audience = new Map();
    for (const passive of passives) {
      const actor = await resolveActor(passive.actorUuid);
      if (!actor) return Object.freeze({ ok: false, code: 'downtime.aggregate-missing' });
      audience.set(passive.actorUuid, actor);
    }
    const commitmentPath = `flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`;
    try {
      const granted = passives.map(passive => ({
        destination: audience.get(passive.actorUuid), data: structuredClone(passive.data), id: reservedId()
      }));
      await context.operation?.capture({
        documents: [{ document: lead, paths: [`flags.${SYSTEM_ID}`] }], creating: creationClaims(granted)
      });
      await lead.update({ [commitmentPath]: { ...commitment } }, settlementOptions());
      for (const passive of granted) await createReserved(passive);
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settlePerformance');
      return Object.freeze({ ok: false, code: 'downtime.settlement-write-failed' });
    }
    return Object.freeze({
      ok: true,
      affected: Object.freeze(passives.map(passive => String(audience.get(passive.actorUuid).name ?? '')))
    });
  }

  /**
   * Commit both units' whole downtime after a socialize. Both units' system flags are captured in one call before
   * the first write, so a refusal gives both their downtime back, the flag scope too when a commitment introduced it.
   * @param {object} snapshot The social snapshot the plan was drawn from.
   * @param {{units: Array<{actorUuid: string, commitment: object}>}} settlement
   * @param {{operation?: object}} context The command context whose operation captures the writes.
   * @returns {Promise<Readonly<{ok: boolean, code?: string}>>}
   */
  async settleSocial(snapshot, { units = [] }, context) {
    const pair = await resolveCommitted(units);
    if (!pair) return Object.freeze({ ok: false, code: 'downtime.aggregate-missing' });
    try {
      await context.operation?.capture({ documents: pair.map(({ actor }) => ({
        document: actor, paths: [`flags.${SYSTEM_ID}`]
      })) });
      await writeCommitments(pair);
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settleSocial');
      return Object.freeze({ ok: false, code: 'downtime.settlement-write-failed' });
    }
    return Object.freeze({ ok: true });
  }

  /**
   * Commit both units' whole downtime after a training session and write the trainee's proficiency experience,
   * and its earned rank when the grant crossed a threshold. One capture call names both units' system flags and
   * the trainee's proficiency before the first write. A null `proficiency` (a grant that earned nothing) skips
   * that write.
   * @param {object} snapshot The social snapshot the plan was drawn from.
   * @param {{units: Array<{actorUuid: string, commitment: object}>,
   *   proficiency: ?{actorUuid: string, key: string, base: number, xp: number}}} settlement
   * @param {{operation?: object}} context The command context whose operation captures the writes.
   * @returns {Promise<Readonly<{ok: boolean, code?: string}>>}
   */
  async settleTraining(snapshot, { units = [], proficiency = null }, context) {
    const pair = await resolveCommitted(units);
    const trainee = proficiency ? pair?.find(entry => entry.actorUuid === proficiency.actorUuid) : null;
    if (!pair || (proficiency && !trainee)) return Object.freeze({ ok: false, code: 'downtime.aggregate-missing' });
    const profPath = proficiency ? `system.prof.${proficiency.key}` : '';
    try {
      await context.operation?.capture({ documents: pair.map(({ actor }) => ({
        document: actor, paths: actor === trainee?.actor ? [`flags.${SYSTEM_ID}`, profPath] : [`flags.${SYSTEM_ID}`]
      })) });
      await writeCommitments(pair);
      if (trainee) {
        await trainee.actor.update({
          [`${profPath}.base`]: proficiency.base, [`${profPath}.xp`]: proficiency.xp
        }, settlementOptions());
      }
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settleTraining');
      return Object.freeze({ ok: false, code: 'downtime.settlement-write-failed' });
    }
    return Object.freeze({ ok: true });
  }

  /**
   * Commit the requisitioner's whole downtime, lock the faction it asked on the Stationary whatever the answer, and
   * add a granted demand to its Convoy's inbound gold. One capture call names the requisitioner's system flags, the
   * station's faction rows and, when gold is sent, the Convoy's inbound gold before the first write. The rows are
   * re-read here, so a faction staff deleted mid-roll refuses rather than locking nothing.
   * @param {object} snapshot The requisition snapshot the plan was drawn from.
   * @param {{performer: object, commitment: object, factionId: string, convoyUuid: string, gold: number}} settlement
   *   `gold` is the demand on a granted requisition and 0 on a declined one.
   * @param {{operation?: object}} context The command context whose operation captures the writes.
   * @returns {Promise<Readonly<{ok: boolean, factionName?: string, convoyName?: string, code?: string}>>}
   */
  async settleRequisition(snapshot, { performer, commitment, factionId, convoyUuid = '', gold = 0 }, context) {
    const requisitioner = await resolveActor(performer.actorUuid);
    const station = await resolveActor(snapshot.stationActorUuid);
    const sent = Math.max(0, Math.floor(Number(gold) || 0));
    const convoy = sent > 0 ? await resolveActor(convoyUuid) : null;
    if (!requisitioner || !station || (sent > 0 && convoy?.type !== 'Convoy')) {
      return Object.freeze({ ok: false, code: 'downtime.aggregate-missing' });
    }
    const rows = projectStationFactions(station);
    const faction = rows.find(row => row._id === factionId);
    if (!faction) return Object.freeze({ ok: false, code: 'downtime.faction-missing' });
    try {
      await context.operation?.capture({ documents: [
        { document: requisitioner, paths: [`flags.${SYSTEM_ID}`] },
        { document: station, paths: [STATION_FACTIONS_PATH] },
        ...(convoy ? [{ document: convoy, paths: ['system.inboundGp'] }] : [])
      ] });
      await writeCommitments([{ actor: requisitioner, commitment }]);
      await station.update({ [STATION_FACTIONS_PATH]: structuredClone(planFactionLock(rows, factionId)) },
        settlementOptions());
      if (convoy) {
        const inbound = Math.max(0, Number(convoy._source?.system?.inboundGp ?? convoy.system?.inboundGp) || 0);
        await convoy.update({ 'system.inboundGp': inbound + sent }, settlementOptions());
      }
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'settleRequisition');
      return Object.freeze({ ok: false, code: 'downtime.settlement-write-failed' });
    }
    return Object.freeze({ ok: true, factionName: faction.name, convoyName: String(convoy?.name ?? '') });
  }

  /* -------------------------------------------- */
  /*  Staff administration                        */
  /* -------------------------------------------- */
  /** Name the one Actor the GM's Reset Downtime Activity and Restore Energy commands write. */
  unitResourceKeys(payload = {}) {
    const actorUuid = String(payload.actorUuid ?? '');
    return actorUuid ? [`actor:${actorUuid}`] : [];
  }

  /**
   * Name the Scene and every Actor the GM's Reset Downtime may write there: each placed party unit, each carrier of
   * a downtime buff, each Stationary and each Vendor.
   */
  async sceneResourceKeys(payload = {}) {
    const sceneUuid = String(payload.sceneUuid ?? '');
    if (!sceneUuid) return [];
    const keys = [`scene:${sceneUuid}`];
    const reset = projectDowntimeReset(await resolveScene(sceneUuid));
    const reached = [...reset.units, ...reset.carriers, ...reset.stations, ...reset.vendors];
    for (const { actorUuid } of reached) keys.push(`actor:${actorUuid}`);
    for (const { actor } of vendorTagHolders()) keys.push(`actor:${actor.uuid}`);
    return [...new Set(keys)].sort();
  }

  /** One unit's commitment and Energy, re-read under execution before engine/downtime plans a reset or a restore. */
  async getUnitState(actorUuid) {
    const actor = await resolveActor(actorUuid);
    return actor?.type === 'Character' ? projectDowntimeUnitState(actor) : null;
  }

  /** Write the reset: the unit's Energy back to capacity and its downtime commitment cleared. */
  resetUnitDowntime(actorUuid, plan, operation = null) {
    return this.#writeUnitDowntime(actorUuid, plan, 'resetUnitDowntime', operation);
  }

  /** Write the restored Energy, leaving the unit committed to the activity it is part-way through. */
  restoreUnitEnergy(actorUuid, plan, operation = null) {
    return this.#writeUnitDowntime(actorUuid, plan, 'restoreUnitEnergy', operation);
  }

  /** The one Actor write both staff controls make. A refused write leaves the unit exactly as it stood. */
  async #writeUnitDowntime(actorUuid, plan, detail, operation) {
    const actor = await resolveActor(actorUuid);
    if (!actor) return false;
    try {
      await operation?.capture({ documents: [actor] });
      await actor.update({
        'system.resources.energy.value': plan.energy,
        [`flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`]: { ...plan.commitment }
      }, settlementOptions());
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, detail);
      return false;
    }
  }

  /** What the GM's Reset Downtime is planned from, re-read under execution: see projectDowntimeReset. */
  async getDowntimeResetSnapshot(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    return scene ? projectDowntimeReset(scene) : null;
  }

  /**
   * Write the GM's Reset Downtime for engine/downtime/commands.mjs: each planned unit's Energy and cleared
   * commitment, every downtime-granted buff deleted, each planned Stationary's unlocked faction rows, and each planned
   * Vendor's haggles cleared, and every vendor-tagged Item in the world untagged (vendorTagHolders in ./economy.mjs).
   * One capture call names every unit's system flags and Energy, every buff, every station's rows, every Vendor's
   * haggles and every tag before the first write, so a sweep that stops part-way is put back whole.
   * @param {{units?: Array<{actorUuid: string, energy: number, commitment: object}>,
   *   buffs?: Array<{actorUuid: string, itemIds: string[]}>,
   *   stations?: Array<{actorUuid: string, factions: object[]}>,
   *   vendors?: Array<{actorUuid: string, haggles: number}>}} plan The writes, each list narrowed to what changes.
   * @param {{operation?: object}} context The command context whose operation captures the writes.
   * @returns {Promise<Readonly<{ok: boolean, data?: {units: number, buffs: number, stations: number,
   *   haggles: number}, code?: string}>>} `haggles` sums the planned Vendors' counts.
   */
  async resetDowntime({ units = [], buffs = [], stations = [], vendors = [] } = {}, context = {}) {
    const resolve = entries => Promise.all(entries.map(async entry => ({
      entry, actor: await resolveActor(entry.actorUuid)
    })));
    const [unitActors, carriers, stationActors, vendorActors] = await Promise.all(
      [units, buffs, stations, vendors].map(resolve));
    if ([...unitActors, ...stationActors, ...vendorActors].some(({ actor }) => !actor)) {
      return Object.freeze({ ok: false, code: 'downtime.aggregate-missing' });
    }
    const sweeps = carriers.map(({ entry, actor }) => ({
      actor, items: (entry.itemIds ?? []).map(id => actor?.items.get(String(id))).filter(Boolean)
    })).filter(sweep => sweep.items.length);
    const tagged = vendorTagHolders();
    try {
      await context.operation?.capture({
        documents: [
          ...unitActors.map(({ actor }) => ({ document: actor, paths: [`flags.${SYSTEM_ID}`, ENERGY_VALUE_PATH] })),
          ...stationActors.map(({ actor }) => ({ document: actor, paths: [STATION_FACTIONS_PATH] })),
          ...vendorActors.map(({ actor }) => ({ document: actor, paths: [VENDOR_HAGGLES_PATH] })),
          ...vendorTagCaptures(tagged)
        ],
        deleting: sweeps.flatMap(sweep => sweep.items)
      });
      for (const { entry, actor } of unitActors) {
        await actor.update({
          [ENERGY_VALUE_PATH]: entry.energy, [`flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`]: { ...entry.commitment }
        }, settlementOptions());
      }
      for (const { actor, items } of sweeps) {
        await actor.deleteEmbeddedDocuments('Item', items.map(item => String(item.id)), settlementOptions());
      }
      for (const { entry, actor } of stationActors) {
        await actor.update({ [STATION_FACTIONS_PATH]: structuredClone(entry.factions) }, settlementOptions());
      }
      for (const { actor } of vendorActors) await actor.update({ [VENDOR_HAGGLES_PATH]: [] }, settlementOptions());
      await stripVendorTags(tagged, settlementOptions());
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'resetDowntime');
      return Object.freeze({ ok: false, code: 'downtime.reset-failed' });
    }
    return Object.freeze({ ok: true, data: Object.freeze({
      units: unitActors.length,
      buffs: sweeps.reduce((total, sweep) => total + sweep.items.length, 0),
      stations: stationActors.length,
      haggles: vendorActors.reduce((total, { entry }) => total + entry.haggles, 0)
    }) });
  }

  /* -------------------------------------------- */
  /*  Aftermath                                   */
  /* -------------------------------------------- */
  /** A visit that gathered closes the driving unit's plan where it stands, its movement spent unless exploring. */
  async settleStanding(snapshot, operation = null) {
    const movement = await this.movements.getSnapshot(snapshot.cursor.tokenUuid);
    if (movement?.movementPlanning !== true) return true;
    const resolution = resolveStandingDestination(movement);
    if (!resolution) return false;
    return this.movements.commit(movement, resolution, {
      resume: false, endTurn: false, charges: snapshot.exploring !== true, operation
    });
  }

  /** Take a spent node off the map. A node restocked meanwhile stays. */
  async removeStation(stationTokenUuid, operation = null) {
    const token = await resolveToken(stationTokenUuid);
    const items = token?.actor?.system?.gathering?.items ?? [];
    if (!token || items.some(entry => (Number(entry?.total) || 0) > 0)) return false;
    try {
      await operation?.capture({ deleting: [token] });
      await token.delete();
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'removeStation');
      return false;
    }
  }
}

/* -------------------------------------------- */
/*  Settlement writes                           */
/* -------------------------------------------- */

/** The units a socialize or a training session commits, each resolved to its Actor, or null when one is gone. */
async function resolveCommitted(units) {
  const resolved = [];
  for (const unit of units) {
    const actor = await resolveActor(unit.actorUuid);
    if (!actor) return null;
    resolved.push({ actorUuid: String(unit.actorUuid), actor, commitment: unit.commitment });
  }
  return resolved.length ? resolved : null;
}

/** Write each unit's Action-lane commitment, the whole of its downtime. */
async function writeCommitments(units) {
  for (const { actor, commitment } of units) {
    await actor.update({ [`flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`]: { ...commitment } }, settlementOptions());
  }
}

/** Whether a spar animation crosses the presentation socket: a valid payload within TRAINING_SPAR's length. */
function sparAnimationFits(animation) {
  if (!validateAnimation(animation).valid) return false;
  try { return JSON.stringify(animation).length <= TRAINING_SPAR.maxAnimationLength; } catch { return false; }
}

/** The Energy and lane commitment every Energy-lane activity spends. */
function energySpendChanges(spend) {
  return {
    'system.resources.energy.value': spend.energy,
    [`flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`]: { ...spend.commitment }
  };
}

/**
 * Group the planned material draws by owner: the stacks that shrink, and the ones drawn to nothing, which are
 * deleted so no pocket fills with empties.
 */
async function planDraws(draws = []) {
  const byOwner = new Map();
  for (const draw of draws) {
    if (!byOwner.has(draw.ownerUuid)) byOwner.set(draw.ownerUuid, { updates: [], deletions: [] });
    const group = byOwner.get(draw.ownerUuid);
    if (draw.remaining > 0) group.updates.push({ _id: draw.itemId, 'system.amount': draw.remaining });
    else group.deletions.push(draw.itemId);
  }
  const groups = [];
  for (const [ownerUuid, group] of byOwner) {
    const owner = await resolveActor(ownerUuid);
    if (!owner) throw new Error('downtime.material-owner-missing');
    groups.push({ ...group, owner });
  }
  return groups;
}

/** The Items planned draws touch, in the shape one capture call takes. */
function drawCaptures(groups) {
  const documents = groups.flatMap(group => group.updates.map(change => group.owner.items.get(change._id)));
  const deleting = groups.flatMap(group => group.deletions.map(id => group.owner.items.get(id)));
  return { documents: documents.filter(Boolean), deleting: deleting.filter(Boolean) };
}

async function drawMaterials(groups) {
  for (const group of groups) {
    if (group.updates.length) await group.owner.updateEmbeddedDocuments('Item', group.updates, settlementOptions());
    if (group.deletions.length) await group.owner.deleteEmbeddedDocuments('Item', group.deletions, settlementOptions());
  }
}

/**
 * A Gathering Node with each gatherable marked `missing` when its source Resource no longer resolves, which
 * game/downtime/gathering.mjs then leaves out of the view, the draw and the node's exhaustion.
 */
async function markMissingSources(station) {
  const items = [];
  for (const entry of station.gathering.items) {
    const source = entry.uuid ? await resolveItem(entry.uuid) : null;
    items.push(Object.freeze({ ...entry, missing: !source }));
  }
  return Object.freeze({ ...station, gathering: Object.freeze({ ...station.gathering, items: Object.freeze(items) }) });
}

/** Where each drawn Resource lands: onto the stack it matches now, or as a copy created under a reserved id. */
async function planLandings(destination, entries, deposits) {
  const landings = [];
  for (const row of deposits) {
    if (row.leftBehind) continue;
    const entry = entries[row.index];
    const source = entry?.uuid ? await resolveItem(entry.uuid) : null;
    if (!source) continue;
    const data = source.toObject();
    delete data._id;
    data.system ??= {};
    data.system.amount = row.count;
    landings.push({ data, count: row.count, id: reservedId(),
      stack: matchingResourceStack(storedItems(destination), data) ?? null });
  }
  return landings;
}

/** Stack a drawn Resource onto its match, or create it under the id the operation already reserved. */
async function landDrawnResource(destination, landing) {
  const stack = matchingResourceStack(storedItems(destination), landing.data);
  if (!stack) {
    await destination.createEmbeddedDocuments('Item', [{ ...landing.data, _id: landing.id }],
      { keepId: true, ...settlementOptions() });
    return;
  }
  await destination.updateEmbeddedDocuments('Item', [{
    _id: stack.id, 'system.amount': (Number(stack.system?.amount) || 0) + landing.count
  }], settlementOptions());
}

/** What an Actor holds that gameplay reaches: a Convoy's inbound Items stay out until staff deliver them. */
function storedItems(actor) {
  return collectionValues(actor?.items).filter(item => !isInboundItem(item));
}

/** The creation claims a gathering deposit reserves: one per drawn Resource that finds no stack to join. */
function reservedCreations(destination, landings) {
  const ids = landings.filter(landing => !landing.stack).map(landing => landing.id);
  return ids.length ? [{ parent: destination, documentName: 'Item', ids }] : [];
}

/** The creation claims a set of crafted or cooked copies reserves, grouped by the Actor each lands on. */
function creationClaims(copies) {
  const byParent = new Map();
  for (const copy of copies) {
    if (!byParent.has(copy.destination)) byParent.set(copy.destination, []);
    byParent.get(copy.destination).push(copy.id);
  }
  return [...byParent].map(([parent, ids]) => ({ parent, documentName: 'Item', ids }));
}

async function createReserved({ destination, data, id }) {
  await destination.createEmbeddedDocuments('Item', [{ ...data, _id: id }],
    { keepId: true, ...settlementOptions() });
}

function reservedId() {
  return foundry.utils.randomID();
}
