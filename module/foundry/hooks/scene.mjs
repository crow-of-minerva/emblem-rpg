/** @layer foundry/hooks */
import {
  ENCOUNTER_PHASE_FLAG,
  ENCOUNTER_ROUND_FLAG,
  ENCOUNTER_TRACK_FLAGS,
  EXPLORATION_FLAG,
  OBJECTIVE_CHECK_KINDS,
  OBJECTIVE_FLAGS,
  PAUSED_ENCOUNTER_FLAG
} from '../../contracts/domains/combat.mjs';
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { unitTurnComplete } from '../../game/combat/phases.mjs';
import { findSceneCombat } from '../adapters/projections/encounters.mjs';
import { revealRefreshRequired } from '../../game/vision/sight.mjs';
import { isMapVisible, scheduleFogReveal } from '../patches/vision.mjs';
import { projectSightBonusSquares } from '../adapters/projections/vision.mjs';
import { SUPPORTED_GRID_TYPES } from '../../config/constants.mjs';
import { collectionValues } from '../../lib/core/runtime.mjs';
import { remapSceneTokenUuids } from '../../lib/core/uuid-remap.mjs';
import {
  forcedDeletion,
  isActiveGm as isCurrentCoordinator,
  isPixelArtAsset,
  primePixelArtTexture
} from '../adapters/services/host.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Canvas drop boundary                        */
/* -------------------------------------------- */

/** Open Item-folder directory windows on canvas drops. Leave Actor-folder drops to Foundry’s bulk placement. */
export function createCanvasDropHandlers({ openFolderDirectory }) {
  return Object.freeze({
    onDropCanvasData(_canvas, data) {
      if (data?.type !== 'Folder') return undefined;
      const folder = fromUuidSync(String(data.uuid ?? ''));
      if (folder?.documentName !== 'Folder' || folder.type !== 'Item') return undefined;
      void openFolderDirectory(folder);
      return false;
    }
  });
}

/* -------------------------------------------- */
/*  Scene constraints                           */
/* -------------------------------------------- */

/**
 * Scene hook handlers. Every Scene has no padding and a supported grid, it can't turn gridless while it holds an
 * encounter, and a created Scene's token references are repointed at it. Also primes pixel-art textures for
 * Sequencer effects.
 */
export function createSceneLifecycle({ notify = null, localUserId = () => globalThis.game?.user?.id } = {}) {
  return Object.freeze({
    onPreCreateScene(scene) {
      const updates = {};
      if (scene.padding !== 0) updates.padding = 0;
      if (!SUPPORTED_GRID_TYPES.includes(Number(scene.grid.type))) {
        updates['grid.type'] = CONST.GRID_TYPES.SQUARE;
      }
      if (Object.keys(updates).length) scene.updateSource(updates);
      return updates;
    },

    onPreUpdateScene(scene, changed) {
      if (foundry.utils.getProperty(changed, 'padding') !== undefined) foundry.utils.setProperty(changed, 'padding', 0);
      const gridType = foundry.utils.getProperty(changed, 'grid.type');
      if (gridType === undefined) return undefined;
      if (!SUPPORTED_GRID_TYPES.includes(Number(gridType))) {
        foundry.utils.setProperty(changed, 'grid.type', CONST.GRID_TYPES.SQUARE);
        return undefined;
      }
      if (Number(gridType) === CONST.GRID_TYPES.GRIDLESS && findSceneCombat(scene)) {
        notify?.gridlessBlocked?.();
        return false;
      }
      return undefined;
    },

    /** Repoint the stale token references a duplicated or imported Scene carries, on the GM client that created it. */
    async onCreateScene(scene, _options, userId) {
      if (String(userId ?? '') !== String(localUserId() ?? '') || globalThis.game?.user?.isGM !== true) return 0;
      const count = await repairSceneReferences(scene);
      if (count) notify?.referencesRepaired?.({ count, sceneName: String(scene?.name ?? '') });
      return count;
    },

    /** Prime one of the system's own pixel-art images the moment Sequencer spawns an effect from it. */
    onCreateSequencerEffect(effect) {
      const file = effect?.data?.file;
      return isPixelArtAsset(file) ? primePixelArtTexture(file) : Promise.resolve(false);
    }
  });
}

/** Repoint every token UUID on a Scene at that Scene: the Tokens first, then each unlinked Token's Actor. */
async function repairSceneReferences(scene) {
  const tokens = collectionValues(scene?.tokens);
  if (!tokens.length) return 0;
  const sceneId = String(scene.id);
  const tokenIds = new Set(tokens.map(token => token.id));
  let count = 0;

  const tokenUpdates = [];
  for (const token of tokens) {
    const source = token.toObject();
    delete source.delta;
    const next = remapSceneTokenUuids(source, sceneId, tokenIds);
    if (!next.count) continue;
    tokenUpdates.push({ _id: token.id, ...foundry.utils.diffObject(source, next.value) });
    count += next.count;
  }
  if (tokenUpdates.length) await scene.updateEmbeddedDocuments('Token', tokenUpdates);

  for (const token of tokens) {
    if (token.actorLink || !token.actor) continue;
    count += await repairActorReferences(token.actor, sceneId, tokenIds);
  }
  return count;
}

async function repairActorReferences(actor, sceneId, tokenIds) {
  const source = actor.toObject();
  const items = source.items ?? [];
  const effects = source.effects ?? [];
  delete source.items;
  delete source.effects;
  let count = 0;

  const base = remapSceneTokenUuids(source, sceneId, tokenIds);
  if (base.count) {
    await actor.update(foundry.utils.diffObject(source, base.value));
    count += base.count;
  }
  for (const [type, entries] of [['Item', items], ['ActiveEffect', effects]]) {
    const updates = [];
    for (const entry of entries) {
      const next = remapSceneTokenUuids(entry, sceneId, tokenIds);
      if (!next.count) continue;
      updates.push({ _id: entry._id, ...foundry.utils.diffObject(entry, next.value) });
      count += next.count;
    }
    if (updates.length) await actor.updateEmbeddedDocuments(type, updates);
  }
  return count;
}

/* -------------------------------------------- */
/*  Encounter lifecycle adapters                */
/* -------------------------------------------- */

/**
 * Turn the events that can decide a map (a defeat, a removed token, a finished turn) into objective checks, on the
 * host client only. `executeInternal` queues a system maintenance command (MaintenanceScheduler.submit in
 * engine/maintenance.mjs), which merges identical submissions into one run.
 */
export function createEncounterLifecycle({
  executeInternal, deferring = () => false, encounterRunning = () => false, events = null, notify = null,
  startup = () => false
}) {
  const stopped = new Map();

  /**
   * Tell the GM once when a phase change this adapter started was stopped, and why. The same stop isn't reported
   * again until a phase change on that map goes through. A GM's own Advance Phase reports to its caller instead.
   */
  const reportStoppedPhaseChange = (sceneUuid, result) => {
    if (result?.ok !== false || stopped.get(sceneUuid) === result.code) return;
    stopped.set(sceneUuid, result.code);
    notify?.phaseChangeStopped?.(result);
  };

  const dispatch = createEncounterDispatch({ executeInternal, deferring, encounterRunning,
    reportStoppedPhaseChange, startup });
  const check = (scene, payload) => dispatch.submit(scene, payload, INTERNAL_COMMAND_IDS.ENCOUNTERS.CHECK_OBJECTIVES);

  if (events?.subscribe) {
    events.subscribe(EVENT_IDS.ACTOR_DEFEATED, event => {
      const tokenUuid = String(event?.data?.tokenUuid ?? '');
      const scene = sceneOfToken(tokenUuid);
      if (!scene) return;
      check(scene, {
        kind: OBJECTIVE_CHECK_KINDS.IMMEDIATE,
        defeatedTokenId: tokenUuid.split('.').pop() ?? '',
        defeatedActorType: String(event?.data?.actorType ?? '')
      });
    });
    events.subscribe(EVENT_IDS.ENCOUNTER_PHASE_ADVANCED, event => {
      stopped.delete(String(event?.data?.sceneUuid ?? ''));
    });
  }

  return Object.freeze({
    /** One encounter per map, and never on a gridless one. */
    onPreCreateEncounter(document, data) {
      let sceneId = data?.scene ?? null;
      if (!sceneId) {
        sceneId = (game.scenes.current ?? globalThis.canvas?.scene)?.id ?? null;
        if (sceneId) document.updateSource({ scene: sceneId });
      }
      if (!sceneId) return undefined;
      const scene = game.scenes.get(sceneId);
      if (scene?.grid?.type === CONST.GRID_TYPES.GRIDLESS) {
        notify?.gridRequired?.();
        return false;
      }
      if (findSceneCombat(scene)) {
        notify?.alreadyRunning?.();
        return false;
      }
      return undefined;
    },

    /** Clear the map's phase and round however its encounter went away. */
    onDeleteEncounter(combat) {
      const scene = combat.scene ?? game.scenes.get(combat._source.scene) ?? null;
      if (!activeGm() || !scene) return;
      void scene.update({
        ...forcedDeletion(`flags.${SYSTEM_ID}.${ENCOUNTER_PHASE_FLAG}`),
        ...forcedDeletion(`flags.${SYSTEM_ID}.${ENCOUNTER_ROUND_FLAG}`)
      }).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'createEncounterLifecycle'); });
    },

    /**
     * Queue an end request written to the encounter, resolved once the command that wrote it has released the map.
     * Clearing the flag also lands here, because Foundry's diff carries the deletion marker as the value.
     */
    onEncounterFlagsChanged(combat, changed) {
      const pending = changed?.flags?.[SYSTEM_ID]?.[OBJECTIVE_FLAGS.END_PENDING];
      // A write with `commit` but no `requestId` is the command finishing the request, not a new one.
      if (!pending || (typeof pending === 'object' && 'commit' in pending && !('requestId' in pending))) return;
      dispatch.pendingEnd(combat);
    },

    /** A removed token can be the last defeat or rout target, so a delete is also a win check. */
    onTokenRemoved(token) {
      check(token?.parent, { kind: OBJECTIVE_CHECK_KINDS.IMMEDIATE });
    },

    /**
     * A unit finishing its turn submits COMPLETE_TURN, which checks objectives and may advance the phase. Only an
     * update that touches system.turn and leaves the turn complete submits. A phase change that stops, or an
     * encounter gone stale, is reported to the GM (reportStoppedPhaseChange).
     */
    onUnitTurnChanged(actor, changed) {
      if (!activeGm() || !changed?.system?.turn || !unitTurnComplete(actor?.system?.turn)) return;
      dispatch.submit(sceneOfActor(actor), {
        kind: OBJECTIVE_CHECK_KINDS.TURN_END, actorUuid: String(actor?.uuid ?? '')
      }, INTERNAL_COMMAND_IDS.ENCOUNTERS.COMPLETE_TURN);
    },

    /**
     * Check objectives on every started encounter once, through the same command the live hooks use. Called by
     * completeStartup (init/system.mjs) after unfinished operations are restored.
     */
    async reconcileObjectives() {
      if (!activeGm()) return;
      for (const combat of collectionValues(globalThis.game?.combats)) {
        if (!combat?.started || !combat.scene?.uuid) continue;
        await executeInternal(INTERNAL_COMMAND_IDS.ENCOUNTERS.CHECK_OBJECTIVES,
          { sceneUuid: combat.scene.uuid, kind: OBJECTIVE_CHECK_KINDS.RECONCILE });
      }
    },

    flushDeferred: () => dispatch.flush(),
    onResourcesReleased: () => dispatch.flush()
  });
}

/**
 * Queue checks that arrive during startup or while a command is busy on that map, and run them once the map is free,
 * if the encounter and unit still match. A turn completed before the host is ready is submitted with autoAdvance
 * off, so it can't advance the phase. An end request queued while the map was busy is finished here with
 * RESOLVE_OBJECTIVE_END once the map is free.
 *
 * Queued checks run in the order the rules need, not the order the hooks fired. A map's objective checks run before
 * its turn completion, so a defeat during the turn is counted before the phase change decides whether the
 * encounter is already over.
 */
function createEncounterDispatch({ executeInternal, deferring, encounterRunning, reportStoppedPhaseChange, startup }) {
  const pending = new Map();
  const endings = new Map();
  let flushing = null;
  const sceneFor = sceneUuid => globalThis.game?.scenes?.get?.(sceneUuid.split('.')[1])
    ?? collectionValues(globalThis.game?.combats).find(combat => combat.scene?.uuid === sceneUuid)?.scene;
  const execute = async (commandId, payload) => {
    try {
      const result = await executeInternal(commandId, payload);
      if (commandId === INTERNAL_COMMAND_IDS.ENCOUNTERS.COMPLETE_TURN
        && (result?.data?.phaseChangeStopped === true || result?.code === RESULT_CODES.ENCOUNTER_STALE)) {
        reportStoppedPhaseChange(payload.sceneUuid, result);
      }
    } catch (error) { reportFoundryError(import.meta.url, error, 'encounter-lifecycle'); }
  };
  const replay = async () => {
    while (pending.size) {
      if (deferring() || !activeGm()) return;
      const [key, entry] = nextRetained(pending);
      pending.delete(key);
      const scene = sceneFor(entry.payload.sceneUuid);
      const combat = findSceneCombat(scene);
      if (!combat?.started || combat.id !== entry.combatId) continue;
      if (entry.commandId === INTERNAL_COMMAND_IDS.ENCOUNTERS.COMPLETE_TURN) {
        const actor = collectionValues(scene.tokens).find(token => token.actor?.uuid === entry.payload.actorUuid)?.actor;
        if (!unitTurnComplete(actor?.system?.turn)) continue;
      }
      await execute(entry.commandId, entry.payload);
    }
    for (const [sceneUuid, ending] of endings) {
      if (deferring() || !activeGm()) return;
      if (encounterRunning(sceneUuid)) continue;
      endings.delete(sceneUuid);
      const combat = findSceneCombat(sceneFor(sceneUuid));
      const current = combat?.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.END_PENDING);
      if (combat?.started && combat.id === ending.combatId && current?.requestId === ending.requestId) {
        await execute(INTERNAL_COMMAND_IDS.ENCOUNTERS.RESOLVE_OBJECTIVE_END, { sceneUuid });
      }
    }
  };
  const flush = () => {
    if (deferring() || !activeGm()) return Promise.resolve();
    if (!flushing) flushing = Promise.resolve().then(replay).finally(() => { flushing = null; });
    return flushing;
  };
  return Object.freeze({
    submit(scene, payload, commandId) {
      const sceneUuid = String(scene?.uuid ?? '');
      const combat = findSceneCombat(scene);
      if (!sceneUuid || !activeGm() || !combat?.started) return;
      const withheld = commandId === INTERNAL_COMMAND_IDS.ENCOUNTERS.COMPLETE_TURN && startup();
      const intent = { sceneUuid, ...payload, ...(withheld ? { autoAdvance: false } : {}) };
      if (deferring() || encounterRunning(sceneUuid)) {
        const key = JSON.stringify([combat.id, commandId, intent]);
        pending.set(key, { combatId: combat.id, commandId, payload: intent });
      } else void execute(commandId, intent);
    },
    pendingEnd(combat) {
      if (!activeGm() || !combat?.scene?.uuid) return;
      endings.set(combat.scene.uuid, { combatId: combat.id,
        requestId: combat.getFlag?.(SYSTEM_ID, OBJECTIVE_FLAGS.END_PENDING)?.requestId });
      void flush();
    },
    flush
  });
}

/** Run order for queued checks: objective checks, and anything unlisted, before turn completions. */
const RETAINED_DISPATCH_ORDER = Object.freeze({
  [INTERNAL_COMMAND_IDS.ENCOUNTERS.CHECK_OBJECTIVES]: 0,
  [INTERNAL_COMMAND_IDS.ENCOUNTERS.COMPLETE_TURN]: 1
});

/** The queued check to run next: the earliest in run order, and among equals the one submitted first. */
function nextRetained(pending) {
  const rank = entry => RETAINED_DISPATCH_ORDER[entry.commandId] ?? 0;
  let chosen = null;
  for (const item of pending) {
    if (!chosen || rank(item[1]) < rank(chosen[1])) chosen = item;
  }
  return chosen;
}

/* -------------------------------------------- */
/*  Flag checks and Scene lookups               */
/* -------------------------------------------- */

/** Whether a Scene update touched a flag the round warning, Combat tab and encounter tracker draw from. */
export function encounterSceneFlagsChanged(changed) {
  const flags = changed?.flags?.[SYSTEM_ID];
  if (!flags) return false;
  return [
    ENCOUNTER_PHASE_FLAG, ENCOUNTER_ROUND_FLAG, EXPLORATION_FLAG, OBJECTIVE_FLAGS.CONFIG, PAUSED_ENCOUNTER_FLAG
  ].some(key => key in flags || `-=${key}` in flags);
}

/** Whether a Scene update changed its phase music tracks or the current phase. */
export function phaseMusicSceneFlagsChanged(changed) {
  const flags = changed?.flags?.[SYSTEM_ID];
  if (!flags) return false;
  return [ENCOUNTER_PHASE_FLAG, ...Object.values(ENCOUNTER_TRACK_FLAGS)]
    .some(key => key in flags || `-=${key}` in flags);
}

/** Whether an encounter update touched the switch that silences one battle's music. */
export function phaseMusicEncounterFlagsChanged(changed) {
  const flags = changed?.flags?.[SYSTEM_ID];
  return Boolean(flags) && (OBJECTIVE_FLAGS.COMBAT_MUSIC in flags
    || `-=${OBJECTIVE_FLAGS.COMBAT_MUSIC}` in flags);
}

/** Encounter lifecycle work runs only on the host client. */
function activeGm() {
  return isCurrentCoordinator();
}

/** The Scene a unit stands on in a started encounter, found from its token or the encounters' Scenes. */
function sceneOfActor(actor) {
  if (actor?.isToken && actor.token?.parent) return actor.token.parent;
  for (const combat of globalThis.game?.combats ?? []) {
    if (!combat?.started || !combat.scene) continue;
    if ([...(combat.scene.tokens ?? [])].some(token => token.actor?.uuid === actor?.uuid)) return combat.scene;
  }
  return null;
}

/** The Scene a token UUID names, or null. Never falls back to the displayed Scene. */
function sceneOfToken(tokenUuid) {
  const parts = String(tokenUuid ?? '').split('.');
  const sceneId = parts[0] === 'Scene' ? parts[1] : null;
  return sceneId ? globalThis.game?.scenes?.get?.(sceneId) ?? null : null;
}

/* -------------------------------------------- */
/*  Sight lifecycle input                       */
/* -------------------------------------------- */

/**
 * Rebuild the vision of an actor's tokens when its sight bonus has changed, one tick after the hook. The token
 * document is reset, not just re-prepared, because Foundry rebuilds the basic-sight detection mode only from source
 * data.
 * @param {object} scheduling The lifecycle's `defer` and its record of each token's last bonus.
 */
function refreshSightBonus(actor, { defer, lastBonus }) {
  if (actor?.documentName !== 'Actor') return;
  defer(() => {
    if (!globalThis.canvas?.ready) return;
    let changed = false;
    for (const token of actor.getActiveTokens()) {
      const tokenDocument = token.document;
      if (!tokenDocument) continue;
      const bonus = projectSightBonusSquares(tokenDocument.actor);
      if (lastBonus.get(tokenDocument) === bonus) continue;
      lastBonus.set(tokenDocument, bonus);
      tokenDocument.reset();
      token.initializeVisionSource();
      changed = true;
    }
    if (changed) canvas.perception.update({ refreshVision: true, refreshLighting: true });
  });
}

/** Rebuild sight for an actor whose Blinded status changed, one tick after the hook. */
function refreshBlindedSight(effect, { defer }) {
  if (!touchesBlinded(effect)) return;
  const actor = effect.parent;
  if (actor?.documentName !== 'Actor') return;
  defer(() => {
    if (!globalThis.canvas?.ready) return;
    for (const token of actor.getActiveTokens()) token.initializeSources();
    canvas.perception.update({ refreshVision: true, refreshLighting: true });
  });
}

/**
 * Vision hook handlers (runtime.vision in init/hooks.mjs): the fog reveal, door sight checks, and rebuilds when an
 * actor's sight bonus, movement plan or Blinded status changes. Door work goes to MaintenanceScheduler as
 * RECONCILE_DOORS, on the host client only.
 */
export function createVisionLifecycle({ executeInternal } = {}) {
  const lastBonus = new WeakMap();
  const pendingDoorScenes = new Set();
  let doorTimer = null;
  let doorDeadline = Infinity;
  let doorEveryScene = false;

  /**
   * Queue a Scene, or every Scene, for a door sight check. A lock change or a placement runs at once. A moved door
   * waits DOOR_RECONCILE_DELAY_MS, so a drag is checked once.
   */
  function scheduleDoorSight({ sceneUuid = '', everyScene = false, delay = 0 } = {}) {
    if (typeof executeInternal !== 'function' || !isCurrentCoordinator()) return;
    if (everyScene) doorEveryScene = true;
    else pendingDoorScenes.add(String(sceneUuid ?? ''));
    const due = Date.now() + delay;
    if (doorTimer && due >= doorDeadline) return;
    if (doorTimer) clearTimeout(doorTimer);
    doorDeadline = due;
    doorTimer = setTimeout(() => {
      doorTimer = null;
      doorDeadline = Infinity;
      void runDoorSight();
    }, delay);
  }

  async function runDoorSight() {
    const payloads = doorEveryScene
      ? [{ everyScene: true }]
      : [...pendingDoorScenes].map(sceneUuid => ({ sceneUuid }));
    doorEveryScene = false;
    pendingDoorScenes.clear();
    for (const payload of payloads) {
      await executeInternal(INTERNAL_COMMAND_IDS.VISION.RECONCILE_DOORS, payload).catch(error => {
        reportFoundryError(import.meta.url, error, 'Emblem RPG | Door sight reconciliation failed');
      });
    }
  }

  function defer(run) {
    setTimeout(run, 0);
  }

  const refreshSight = actor => refreshSightBonus(actor, { defer, lastBonus });
  const refreshBlinded = effect => refreshBlindedSight(effect, { defer });

  return Object.freeze({
    onCanvasReadyVision() {
      if (isMapVisible(globalThis.canvas?.scene)) scheduleFogReveal();
      scheduleDoorSight({ sceneUuid: String(globalThis.canvas?.scene?.uuid ?? '') });
    },

    onReadyVision() {
      scheduleDoorSight({ everyScene: true });
    },

    onDoorPlacementChanged(tokenDocument, changes = null) {
      if (!isDoorToken(tokenDocument)) return;
      if (changes && !doorFootprintChanged(changes)) return;
      scheduleDoorSight({
        sceneUuid: String(tokenDocument.parent?.uuid ?? ''), delay: changes ? DOOR_RECONCILE_DELAY_MS : 0
      });
    },

    onDoorLockChanged(actor, changes = {}) {
      if (actor?.type !== 'Object' || String(actor.system?.objectType ?? '') !== 'Door') return;
      if (!foundry.utils.hasProperty(changes, 'system.locked')) return;
      if (actor.isToken) scheduleDoorSight({ sceneUuid: String(actor.token?.parent?.uuid ?? '') });
      else scheduleDoorSight({ everyScene: true });
    },

    onSceneFogChanged(scene, changed = {}) {
      if (scene !== globalThis.canvas?.scene) return;
      const refresh = revealRefreshRequired({
        touchedMapVisible: foundry.utils.hasProperty(changed, `flags.${SYSTEM_ID}.mapVisible`),
        touchedFogMode: foundry.utils.hasProperty(changed, 'fog.mode'),
        touchedTokenVision: foundry.utils.hasProperty(changed, 'tokenVision'),
        mapVisible: isMapVisible(scene)
      });
      if (refresh) scheduleFogReveal();
    },

    onActorSightChanged(actor, changes = {}) {
      const touchedPlan = foundry.utils.hasProperty(changes, 'system.turn.movementPlanning')
        || foundry.utils.hasProperty(changes, 'system.turn.movementAnchorX')
        || foundry.utils.hasProperty(changes, 'system.turn.movementAnchorY');
      if (touchedPlan) {
        for (const token of actor.getActiveTokens()) {
          if (token._isVisionSource?.()) token.initializeSources();
        }
      }
      refreshSight(actor);
    },

    onEmbeddedSightChanged(document) {
      refreshSight(document?.parent);
    },

    onSightEffectChanged(effect) {
      refreshBlinded(effect);
      refreshSight(effect?.parent);
    }
  });
}

/* -------------------------------------------- */
/*  Change detection                            */
/* -------------------------------------------- */
const DOOR_RECONCILE_DELAY_MS = 200;

function isDoorToken(tokenDocument) {
  const actor = tokenDocument?.actor;
  return actor?.type === 'Object' && String(actor.system?.objectType ?? '') === 'Door';
}

function doorFootprintChanged(changes) {
  return changes.x !== undefined || changes.y !== undefined
    || changes.width !== undefined || changes.height !== undefined;
}

function touchesBlinded(effect) {
  return [...effect.statuses].some(status => String(status).toLowerCase() === 'blinded');
}
