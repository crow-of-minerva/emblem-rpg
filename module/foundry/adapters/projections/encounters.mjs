/** @layer foundry/adapters/projections */
import {
  COMBAT_CONTINUATIONS,
  ENCOUNTER_DECAY_FLAGS,
  ENCOUNTER_PHASES,
  ENCOUNTER_PHASE_FLAG,
  ENCOUNTER_ROUND_FLAG,
  ENCOUNTER_TRACK_FLAGS,
  EXPLORATION_FLAG,
  GUARD_BOND_FLAGS,
  OBJECTIVE_FLAGS,
  PAUSED_ENCOUNTER_FLAG,
  SUMMON_REMAINING_FLAG,
  SUMMON_TICKS_ON_FLAG,
  SUMMONED_BY_FLAG
} from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { triggerGroupForItem } from '../../../contracts/dsl/effects.mjs';
import { DRIVEN_HOLD_SETTING, normalizeDrivenHold } from '../../../contracts/domains/suppression.mjs';
import {
  isPhaseParticipant,
  normalizePausedEncounter,
  phaseForFaction,
  unitTurnComplete
} from '../../../game/combat/phases.mjs';
import {
  normalizeObjectiveProgress,
  normalizeObjectiveSnapshot,
  normalizeObjectiveSpec,
  objectiveMarkers
} from '../../../game/combat/objectives.mjs';
import { SKILLS, UNIT_TYPES, resolveAvatarScale } from '../../../game/character/rules.mjs';
import { carriedLootKind } from '../../../game/economy/trade.mjs';
import { DOWNTIME_FLAG } from '../../../contracts/domains/downtime.mjs';
import { RALLY_RECORD_FLAG } from '../../../contracts/domains/progression.mjs';
import { normalizeRallyRecord } from '../../../game/support/rules.mjs';
import { downtimeCommitment } from '../../../game/downtime/rules.mjs';
import {
  MOVEMENT_PERMISSION_FLAG,
  MOVE_SCALING_FLAG,
  normalizeMovementPermission,
  normalizeMoveScaling
} from '../../../game/movement/input-policy.mjs';
import { readTerrainGrid } from './terrain.mjs';
import { scanTerrainImpacts } from '../../../game/terrain/effects.mjs';
import { footprintCells, normalizeTerrainProfile } from '../../../game/terrain/rules.mjs';
import { TERRAIN_UNIT_TYPES } from '../../../contracts/domains/terrain.mjs';
import { projectFoundryCombatActorContext, projectHealEchoPolicies } from './combat-context.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import { resolveScene, resolveViewedScene, unpackFlagKeys } from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Encounter projection                        */
/* -------------------------------------------- */

const PHASE_TRIGGERS = Object.freeze(['onPhaseBegin', 'onPhaseEnd']);

/**
 * The Scene phase, roster and objective snapshots the encounter engine (engine/combat/encounters) reads.
 * FoundryEncounterRepository in document-writes/encounters.mjs passes these reads through to this class.
 */
export class FoundryEncounterProjection {
  /**
   * Name the movement board, Scene and all placed Actors the encounter command may write, including passive-effect
   * targets.
   */
  async resourceKeys(payload = {}) {
    const sceneUuid = String(payload.sceneUuid ?? '');
    if (!sceneUuid) return ['movement:board'];
    const actorUuids = placedActorUuids(await resolveScene(sceneUuid));
    return ['movement:board', `scene:${sceneUuid}`, ...actorUuids.map(actorUuid => `actor:${actorUuid}`)];
  }

  /**
   * Every Actor placed on the Scene right now, including units placed or spawned after the command took its keys.
   * A running encounter command claims all of them before it writes (holdsPlacedActors in
   * engine/combat/encounters/commands.mjs).
   */
  async getWritableActorUuids(sceneUuid) {
    return Object.freeze(placedActorUuids(await resolveScene(sceneUuid)));
  }

  /**
   * Units still carrying an unanswered end-of-turn continuation, one entry per Actor. At startup,
   * completeInterruptedTurns in init/system.mjs sends a finish command for each one to close turns whose prompt was
   * lost when the host reloaded, and that command (settleLostContinuation) reads the list again to check the
   * request is still current.
   * @returns {ReadonlyArray<{sceneUuid: string, actorUuid: string, tokenUuid: string, requestId: string}>}
   */
  getPendingContinuations() {
    const found = new Map();
    for (const combat of collectionValues(globalThis.game?.combats)) {
      const scene = combat?.started === true ? combat.scene : null;
      for (const token of collectionValues(scene?.tokens)) {
        const turn = token.actor?.system?.turn;
        if (turn?.continuationPending !== COMBAT_CONTINUATIONS.END_TURN) continue;
        const actorUuid = String(token.actor.uuid ?? '');
        if (found.has(actorUuid)) continue;
        found.set(actorUuid, Object.freeze({
          sceneUuid: String(scene.uuid ?? ''),
          actorUuid,
          tokenUuid: String(token.uuid ?? ''),
          requestId: String(turn.continuationRequestId ?? '')
        }));
      }
    }
    return Object.freeze([...found.values()]);
  }

  /** The Scene's phase, round and objective state, with each phase-taking unit's terrain, decay and passive facts. */
  async getSnapshot(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return null;
    const terrainGrid = readTerrainGrid(scene);
    const gridSize = Number(scene.grid?.size) || 1;
    const units = phaseParticipantTokens(scene)
      .map(({ token, actor, actorType }) => projectEncounterUnit(token, actor, actorType, { terrainGrid, gridSize }));
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      ...projectEncounterPhase(scene),
      units: Object.freeze(units),
      ...projectObjectiveState(scene)
    });
  }

  /** Project the objective board and stored encounter state without the per-unit passive facts. */
  async getObjectiveSnapshot(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    return scene ? projectObjectiveBoard(scene) : null;
  }
}

/** Each distinct Actor behind a Token on a Scene, whatever its type or faction. */
export function placedActorUuids(scene) {
  const actorUuids = collectionValues(scene?.tokens).map(token => String(token.actor?.uuid ?? '')).filter(Boolean);
  return [...new Set(actorUuids)];
}

/** Every Character Token on a Scene whose faction takes a phase, with its Actor and that faction. */
function phaseParticipantTokens(scene) {
  const participants = [];
  for (const token of collectionValues(scene.tokens)) {
    const actor = token.actor;
    if (!actor || actor.type !== 'Character') continue;
    const actorType = String(actor.system?.faction?.role ?? 'Neutral');
    if (isPhaseParticipant(actorType)) participants.push({ token, actor, actorType });
  }
  return participants;
}

/* -------------------------------------------- */
/*  Objective projection                        */
/* -------------------------------------------- */

/**
 * Project one Scene's placed units, terrain points, authored spec, and stored encounter state.
 *
 * The terrain grid is the expensive half and only the objective-point checks read it, so a caller
 * that only needs the roster asks for the board without it.
 */
export function projectObjectiveBoard(scene, { terrain = true } = {}) {
  if (!scene) return null;
  const combat = findSceneCombat(scene);
  const cycle = projectEncounterPhase(scene);
  return Object.freeze({
    sceneUuid: String(scene.uuid ?? ''),
    sceneId: String(scene.id ?? ''),
    gridSize: Number(scene.grid?.size) || 0,
    gridless: scene.grid?.type === CONST.GRID_TYPES.GRIDLESS,
    terrainGrid: terrain ? readTerrainGrid(scene) : {},
    ...cycle,
    units: projectBoardUnits(scene, cycle.phase),
    exploration: Boolean(scene.getFlag?.(SYSTEM_ID, EXPLORATION_FLAG)),
    paused: normalizePausedEncounter(scene.getFlag?.(SYSTEM_ID, PAUSED_ENCOUNTER_FLAG)),
    otherRunningSceneUuid: String(collectionValues(globalThis.game?.combats)
      .find(entry => entry?.started === true && entry.scene && combatSceneId(entry) !== String(scene.id))
      ?.scene?.uuid ?? ''),
    ...projectObjectiveState(scene, combat)
  });
}

/**
 * The Scene's live encounter state on its own, without the roster or the terrain grid behind it. `paused` says the
 * Scene holds a paused encounter's record, so Enemy AI can tell a pause from an end when the Combat is deleted.
 * @param {string} [sceneUuid] Scene to read, defaulting to the displayed one.
 * @returns {Readonly<object>|null} Frozen phase state, or null when the Scene can't be found.
 */
export function projectEncounterState(sceneUuid = '') {
  const scene = resolveViewedScene(sceneUuid);
  if (!scene) return null;
  const combat = findSceneCombat(scene);
  return Object.freeze({
    sceneUuid: String(scene.uuid ?? ''),
    ...projectEncounterPhase(scene),
    started: combat?.started === true,
    autoAdvance: combat ? combat.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.AUTO_ADVANCE) !== false : true,
    exploration: sceneExplorationActive(scene) === true,
    encounterActive: sceneCombatActive(scene) === true,
    paused: Boolean(scene.getFlag?.(SYSTEM_ID, PAUSED_ENCOUNTER_FLAG)),
    combatUuid: String(combat?.uuid ?? '')
  });
}

/** Every placed unit reduced to the facts objectives and the roster read. */
function projectBoardUnits(scene, phase) {
  const units = [];
  for (const token of collectionValues(scene.tokens)) {
    const actor = token.actor;
    if (!actor) continue;
    const actorType = String(actor.system.faction.role ?? '');
    if (!isPhaseParticipant(actorType)) continue;
    units.push(Object.freeze({
      tokenId: String(token.id ?? ''),
      tokenUuid: String(token.uuid ?? ''),
      tokenName: String(token.name ?? ''),
      actorId: String(actor.id ?? ''),
      actorUuid: String(actor.uuid ?? ''),
      actorName: String(actor.name ?? ''),
      actorType,
      hidden: token.hidden === true,
      visible: token.object?.visible !== false,
      x: Number(token.x) || 0,
      y: Number(token.y) || 0,
      width: Number(token.width) || 1,
      height: Number(token.height) || 1,
      hp: finite(actor.system.resources.hp.value),
      hpMax: finite(actor.system.resources.hp.max),
      stance: finite(actor.system.resources.stn.value),
      stanceMax: finite(actor.system.resources.stn.max),
      energy: finite(actor.system.resources.energy?.value),
      energyMax: finite(actor.system.resources.energy?.max),
      downtime: downtimeCommitment(actor.getFlag?.(SYSTEM_ID, DOWNTIME_FLAG)
        ?? actor.flags?.[SYSTEM_ID]?.[DOWNTIME_FLAG]),
      factionColor: String(actor.system.faction.color ?? ''),
      img: String(actor.img ?? token.texture?.src ?? ''),
      avatarScale: resolveAvatarScale(actor.system.art.avatarScale),
      auraCount: collectionValues(actor.items).filter(item => item.system?.aura?.enabled === true).length,
      lootKind: carriedLootKind(collectionValues(actor.items).map(projectLootFacts)),
      unitTypes: Object.freeze(UNIT_TYPES.filter(type => actor.system.unitType[type.key] === true)
        .map(type => type.key)),
      skills: Object.freeze(SKILLS
        .map(skill => Object.freeze({ key: skill.key, label: skill.label, rank: finite(actor.system?.skills?.[skill.key]?.total) }))
        .filter(skill => skill.rank > 0)),
      acted: unitTurnComplete(actor.system.turn) && phaseForFaction(actorType) === phase
    }));
  }
  return Object.freeze(units);
}

/** The Item facts the roster's loot badge reads: what a thief may lift, and what a defeat would leave behind. */
function projectLootFacts(item) {
  const system = item.system ?? {};
  return Object.freeze({
    type: String(item?.type ?? ''),
    innate: Boolean(item.getFlag?.(SYSTEM_ID, 'innateGrant')),
    isEquipped: system.isWielded === true || system.isWorn === true || system.isEquipped === true,
    stealableFlag: String(system.stealable?.flag ?? ''),
    stealableDc: Number(system.stealable?.dc) || 0
  });
}

/** Read the authored specification and whatever the running encounter has recorded against it. */
function projectObjectiveState(scene, combat = findSceneCombat(scene)) {
  return {
    combatId: String(combat?.id ?? ''),
    combatUuid: String(combat?.uuid ?? ''),
    started: combat?.started === true,
    autoAdvance: combat ? combat.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.AUTO_ADVANCE) !== false : true,
    combatMusic: combat ? combat.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.COMBAT_MUSIC) !== false : true,
    spec: normalizeObjectiveSpec(readObjectiveConfig(scene, combat)),
    targets: normalizeObjectiveSnapshot(combat?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.TARGETS)),
    progress: normalizeObjectiveProgress(combat?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.PROGRESS)),
    pendingEnd: readPendingEnd(combat),
    hasPendingEnd: combat?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.END_PENDING) != null
  };
}

/** The phase and round, which are stored on the Scene, not on the Combat document. */
function projectEncounterPhase(scene) {
  const phase = String(scene?.getFlag?.(SYSTEM_ID, ENCOUNTER_PHASE_FLAG) ?? '');
  const round = Number(scene?.getFlag?.(SYSTEM_ID, ENCOUNTER_ROUND_FLAG));
  return {
    phase: Object.values(ENCOUNTER_PHASES).includes(phase) ? phase : '',
    round: Number.isFinite(round) ? Math.max(1, Math.floor(round)) : 1
  };
}

/**
 * What the phase music in services/audio.mjs plays from: the current phase, whether the encounter has music turned
 * on, and each phase's track.
 */
export function projectPhaseMusic(scene, combat = findSceneCombat(scene)) {
  const tracks = {};
  for (const [phase, flag] of Object.entries(ENCOUNTER_TRACK_FLAGS)) {
    tracks[phase] = String(scene?.getFlag?.(SYSTEM_ID, flag) ?? '');
  }
  return Object.freeze({
    phase: projectEncounterPhase(scene).phase,
    enabled: combat ? combat.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.COMBAT_MUSIC) !== false : false,
    tracks: Object.freeze(tracks)
  });
}

/**
 * The map's authored objectives, from the Scene flag. Worlds saved before objectives moved to the Scene keep them on
 * the Combat document, which is read when the Scene has none.
 */
export function readObjectiveConfig(scene, combat = findSceneCombat(scene)) {
  return scene?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.CONFIG)
    ?? combat?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.CONFIG)
    ?? null;
}

/** The map's own combat parameters as the Terrain Builder edits them: tracks, movement, sight and objectives. */
export function projectSceneCombatSettings(scene = globalThis.canvas?.scene) {
  const tracks = {};
  for (const flag of Object.values(ENCOUNTER_TRACK_FLAGS)) tracks[flag] = String(scene?.getFlag?.(SYSTEM_ID, flag) ?? '');
  return Object.freeze({
    sceneUuid: String(scene?.uuid ?? ''),
    tracks: Object.freeze(tracks),
    movementPermission: normalizeMovementPermission(scene?.getFlag?.(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG)),
    moveScaling: normalizeMoveScaling(scene?.getFlag?.(SYSTEM_ID, MOVE_SCALING_FLAG)),
    tokenVision: scene?.tokenVision === true,
    fogMode: finite(scene?.fog?.mode, 0),
    globalLight: scene?.environment?.globalLight?.enabled === true,
    darkness: finite(scene?.environment?.darknessLevel, 0),
    objectives: normalizeObjectiveSpec(readObjectiveConfig(scene))
  });
}

/** Every playlist with something to play, offered whole and sound by sound, for a phase-track picker. */
export function projectPhaseTrackOptions() {
  const playlists = [];
  const sounds = [];
  for (const playlist of globalThis.game?.playlists ?? []) {
    const contents = playlist.sounds?.contents ?? [];
    if (!contents.length) continue;
    const name = String(playlist.name ?? '');
    playlists.push({ uuid: String(playlist.uuid ?? ''), name });
    sounds.push({
      name,
      sounds: contents.map(sound => ({ uuid: String(sound.uuid ?? ''), name: String(sound.name ?? '') }))
    });
  }
  return { playlists, sounds };
}

/**
 * What a song's linked track is, for the Instrument menu's track card. A PlaylistSound gives its name, its
 * playlist, its audio file and whether it repeats. A whole Playlist gives its name, how many sounds it holds and
 * whether it cycles. A deleted or unknown uuid returns null.
 * @param {string} uuid A Playlist or PlaylistSound uuid, as a song stores it.
 * @returns {Readonly<{uuid: string, kind: string, name: string, playlist: string, path: string, repeat: boolean,
 *   soundCount: number}>|null}
 */
export function projectTrackFacts(uuid) {
  const id = String(uuid ?? '');
  if (!id) return null;
  let document = null;
  try {
    document = fromUuidSync(id, { strict: false }) ?? null;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'projectTrackFacts');
    return null;
  }
  if (document?.documentName === 'PlaylistSound') {
    return Object.freeze({
      uuid: id, kind: 'sound', name: String(document.name ?? ''), playlist: String(document.parent?.name ?? ''),
      path: String(document.path ?? ''), repeat: document.repeat === true, soundCount: 1
    });
  }
  if (document?.documentName !== 'Playlist') return null;
  const modes = CONST.PLAYLIST_MODES;
  return Object.freeze({
    uuid: id, kind: 'playlist', name: String(document.name ?? ''), playlist: String(document.name ?? ''),
    path: '', repeat: [modes.SEQUENTIAL, modes.SHUFFLE].includes(document.mode),
    soundCount: Number(document.sounds?.size ?? document.sounds?.length) || 0
  });
}

/**
 * Read objective marker ids for Token badges without building the full objective board.
 * @param {object} [scene] The scene whose encounter is read.
 * @returns {{defeat: string[], protected: string[]}}
 */
export function projectObjectiveMarkerTargets(scene = globalThis.canvas?.scene) {
  const combat = findSceneCombat(scene);
  return objectiveMarkers(normalizeObjectiveSnapshot(combat?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.TARGETS)));
}

/** The hold a companion module has taken over the board, read straight from the world setting. */
export function projectDrivenHold() {
  try {
    return normalizeDrivenHold(globalThis.game?.settings?.get?.(SYSTEM_ID, DRIVEN_HOLD_SETTING));
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'projectDrivenHold');
    return null;
  }
}

/** The Combat bound to a Scene, or null. A Scene has at most one, since its phase and round live on the Scene. */
export function findSceneCombat(scene) {
  if (!scene) return null;
  const combats = collectionValues(globalThis.game?.combats);
  return combats.find(candidate => candidate.scene?.id === scene.id) ?? null;
}

/** Whether a Scene is running the exploration board rather than an encounter. */
export function sceneExplorationActive(scene) {
  return scene?.getFlag?.(SYSTEM_ID, 'explorationMode') === true;
}

/**
 * Whether a started encounter is bound to this Scene, which several rules check before charging for anything. It
 * reads the Combat documents, never the combat this client happens to be viewing.
 */
export function sceneCombatActive(scene) {
  if (!scene?.id) return false;
  return collectionValues(globalThis.game?.combats)
    .some(combat => combat?.started === true && combatSceneId(combat) === String(scene.id));
}

/**
 * Whether an encounter has started on the given Scene, or on any Scene when none is given. It reads the Combat
 * documents, not the displayed canvas.
 * @param {object|null} [scene] Scene to ask about.
 * @returns {boolean}
 */
export function encounterUnderway(scene = null) {
  if (scene) return sceneCombatActive(scene);
  return collectionValues(globalThis.game?.combats).some(combat => combat?.started === true && Boolean(combat.scene));
}

/**
 * The Scene clients are held on while an encounter runs, for the scene lock in foundry/patches/scene-lock.mjs.
 * Among Scenes with a running encounter it keeps the one this client displays, then the active Scene, then the one
 * with the lowest Scene id.
 * @returns {Readonly<{sceneId: string, sceneUuid: string, sceneName: string}>|null}
 */
export function projectEncounterSceneLock() {
  const scenes = new Map();
  for (const combat of collectionValues(globalThis.game?.combats)) {
    const scene = combat?.started === true ? combat.scene : null;
    if (scene?.id) scenes.set(String(scene.id), scene);
  }
  if (!scenes.size) return null;
  const scene = scenes.get(String(globalThis.canvas?.scene?.id ?? ''))
    ?? scenes.get(String(globalThis.game?.scenes?.active?.id ?? ''))
    ?? scenes.get([...scenes.keys()].sort()[0]);
  return Object.freeze({
    sceneId: String(scene.id),
    sceneUuid: String(scene.uuid ?? ''),
    sceneName: String(scene.navName || scene.name || '')
  });
}

function combatSceneId(combat) {
  return String(combat?.scene?.id ?? combat?.sceneId ?? combat?._source?.scene ?? combat?.scene ?? '');
}

/**
 * The encounter end queued on this map, as plain data. While one is queued, no further phase advance, pause or
 * objective check goes ahead.
 */
function readPendingEnd(combat) {
  const raw = combat?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.END_PENDING);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.freeze(unpackFlagKeys(raw));
}

/* -------------------------------------------- */
/*  Unit projection                             */
/* -------------------------------------------- */

function projectEncounterUnit(token, actor, actorType, board = {}) {
  const gridSize = Number(board.gridSize) || 1;
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    actorName: String(actor.name ?? token.name ?? 'Unit'),
    actorType,
    hp: finite(actor.system.resources.hp.value),
    cell: Object.freeze({
      x: Math.floor(Number(token.x) / gridSize),
      y: Math.floor(Number(token.y) / gridSize),
      width: Math.max(1, Math.round(Number(token.width) || 1)),
      height: Math.max(1, Math.round(Number(token.height) || 1))
    }),
    statuses: Object.freeze({
      poisoned: actor.system.statuses.poisoned === true || actorHasStatus(actor, 'Poisoned'),
      corpseRot: actorHasStatus(actor, 'CorpseRot')
    }),
    terrain: projectUnitTerrain(token, actor, board),
    special: projectSpecialPools(actor.system.special),
    effects: projectDecayFacts(actor),
    passiveEntries: projectPhaseEntries(actor),
    healEchoes: Object.freeze(projectHealEchoPolicies(actor)),
    conditionSelf: projectFoundryCombatActorContext(actor)
  });
}

/**
 * Project the terrain a unit is standing on, with the defenses that decide how much of it lands.
 *
 * The scan is null on a bare square, which is the cheap gate that keeps the phase from entering the
 * expensive settlement path for every unit on the map.
 */
function projectUnitTerrain(token, actor, { terrainGrid = {}, gridSize = 1 } = {}) {
  const footprint = {
    x: Math.floor(Number(token.x) / gridSize),
    y: Math.floor(Number(token.y) / gridSize),
    width: Math.max(1, Math.round(Number(token.width) || 1)),
    height: Math.max(1, Math.round(Number(token.height) || 1))
  };
  const profile = normalizeTerrainProfile({
    name: String(actor.name ?? ''),
    actorType: String(actor.system?.faction?.role ?? ''),
    unitTypes: TERRAIN_UNIT_TYPES.filter(type => actor.system?.unitType?.[type] === true),
    uuids: [String(actor.uuid ?? ''), actor.id ? `Actor.${actor.id}` : '']
  });
  return Object.freeze({
    scan: scanTerrainImpacts(terrainGrid, footprintCells(footprint), profile),
    defenses: Object.freeze({
      protections: Object.freeze(Object.entries(actor.system?.equipment?.prots ?? {})
        .filter(([, enabled]) => enabled === true).map(([type]) => type)),
      defense: Number(actor.system?.stats?.def?.total) || 0,
      resistance: Number(actor.system?.stats?.res?.total) || 0
    })
  });
}

function projectSpecialPools(special) {
  const pools = {};
  for (const [key, pool] of Object.entries(special ?? {})) {
    pools[key] = Object.freeze({ value: finite(pool?.value), max: finite(pool?.max) });
  }
  return Object.freeze(pools);
}

function projectDecayFacts(actor) {
  const facts = [];
  for (const effect of collectionValues(actor.effects)) {
    const flags = effect.flags?.[SYSTEM_ID] ?? {};
    facts.push(Object.freeze({
      id: String(effect.id ?? ''),
      name: String(effect.name ?? effect.label ?? ''),
      stackable: flags.stackable === true,
      stackCount: Math.max(1, Math.floor(Number(flags.stackCount) || 1)),
      stackLimit: Math.max(0, Math.floor(Number(flags.stackLimit) || 0)),
      duration: Number(flags.duration),
      statuses: Object.freeze([...(effect.statuses ?? [])].map(String)),
      dotCanKillPlayer: typeof flags.dotCanKillPlayer === 'boolean' ? flags.dotCanKillPlayer : undefined,
      [ENCOUNTER_DECAY_FLAGS.PHASE_BEGIN]: flags[ENCOUNTER_DECAY_FLAGS.PHASE_BEGIN] === true,
      [ENCOUNTER_DECAY_FLAGS.PHASE_END]: flags[ENCOUNTER_DECAY_FLAGS.PHASE_END] === true,
      [ENCOUNTER_DECAY_FLAGS.ANY_PHASE_END]: flags[ENCOUNTER_DECAY_FLAGS.ANY_PHASE_END] === true
    }));
  }
  return Object.freeze(facts);
}

function actorHasStatus(actor, statusId) {
  const wanted = String(statusId).toLowerCase();
  return collectionValues(actor.effects).some(effect => effect.disabled !== true
    && [...(effect.statuses ?? [])].some(status => String(status).toLowerCase() === wanted));
}

function projectPhaseEntries(actor) {
  const entries = [];
  for (const item of collectionValues(actor.items)) {
    if (triggerGroupForItem({ type: item.type, itemType: item.system?.itemType }) !== 'C') continue;
    for (const entry of item.system?.effects ?? []) {
      if (!PHASE_TRIGGERS.includes(String(entry?.trigger ?? ''))) continue;
      entries.push(Object.freeze({
        ...structuredClone(entry),
        sourceItemUuid: String(item.uuid ?? ''),
        sourceItemName: String(item.name ?? ''),
        sourceItem: Object.freeze({
          uuid: String(item.uuid ?? ''),
          name: String(item.name ?? ''),
          type: String(item.type ?? ''),
          img: String(item.img ?? ''),
          image: String(item.img ?? ''),
          system: structuredClone(item.system ?? {})
        })
      }));
    }
  }
  return Object.freeze(entries);
}

/* -------------------------------------------- */
/*  Encounter aftermath                         */
/* -------------------------------------------- */

/**
 * What an ending encounter clears from its map, read by FoundryEncounterRepository for the teardown in
 * engine/combat/encounters/objectives.mjs: every placed Token, whether an effect summon placed it, whether it stands
 * in a Guard bond, whether its Actor has Rallied anyone this map, and the effects its Character wears as the
 * detached facts `planEncounterAftermath` classifies. Neutral units are included. An encounter's start reads the
 * same facts to clear the map's Rally records (clearRallyRecords in phases.mjs), and a phase's end reads a timed
 * summon's countdown from them (planSummonExpiry).
 * @param {object} scene The map whose encounter is ending or starting.
 * @returns {Readonly<{sceneUuid: string, units: readonly object[]}>}
 */
export function projectEncounterAftermath(scene) {
  return Object.freeze({
    sceneUuid: String(scene?.uuid ?? ''),
    units: Object.freeze(collectionValues(scene?.tokens).map(projectAftermathUnit))
  });
}

/**
 * One placed Token as an ended encounter's cleanup reads it. `linked` tells a Token showing a world Actor, which
 * outlives it, from one whose unlinked Actor lives and dies with the Token.
 */
function projectAftermathUnit(token) {
  const actor = token.actor ?? null;
  return Object.freeze({
    tokenUuid: String(token.uuid ?? ''),
    actorUuid: String(actor?.uuid ?? ''),
    linked: Boolean(actor) && actor.isToken !== true,
    summoned: typeof token.getFlag?.(SYSTEM_ID, SUMMONED_BY_FLAG) === 'string',
    summonRemaining: token.getFlag?.(SYSTEM_ID, SUMMON_REMAINING_FLAG) ?? null,
    summonTicksOn: token.getFlag?.(SYSTEM_ID, SUMMON_TICKS_ON_FLAG) ?? null,
    guardBonded: Boolean(token.getFlag?.(SYSTEM_ID, GUARD_BOND_FLAGS.GUARDER))
      || collectionValues(actor?.effects).some(effect => Boolean(effect.flags?.[SYSTEM_ID]?.guardRole)),
    rallied: normalizeRallyRecord(actor?.flags?.[SYSTEM_ID]?.[RALLY_RECORD_FLAG]).length > 0,
    effects: actor?.type === 'Character' ? projectStatusFacts(actor) : Object.freeze([])
  });
}

/** Each effect a Character wears as `isEncounterStatus` reads it: its name, status ids and system flags. */
function projectStatusFacts(actor) {
  return Object.freeze(collectionValues(actor.effects).map(effect => {
    const source = effect._source ?? effect;
    const statuses = [...(source.statuses ?? effect.statuses ?? []), source.flags?.core?.statusId];
    return Object.freeze({
      id: String(effect.id ?? ''),
      name: String(source.name ?? effect.name ?? ''),
      statuses: Object.freeze(statuses.filter(Boolean).map(String)),
      flags: Object.freeze(structuredClone(source.flags?.[SYSTEM_ID] ?? {}))
    });
  }));
}
