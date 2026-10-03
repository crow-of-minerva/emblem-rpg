/** @layer foundry/adapters/document-writes */
import {
  ENCOUNTER_PHASE_FLAG,
  ENCOUNTER_ROUND_FLAG,
  EXPLORATION_FLAG,
  GUARD_BOND_BREAKS,
  OBJECTIVE_FLAGS,
  PAUSED_ENCOUNTER_FLAG,
  SUMMON_REMAINING_FLAG
} from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { RALLY_RECORD_FLAG } from '../../../contracts/domains/progression.mjs';
import { TERRAIN_EDIT_RECORDS_FLAG, TERRAIN_GRID_FLAG } from '../../../contracts/domains/terrain.mjs';
import {
  DRIVEN_HOLD_SETTING,
  drivenHoldIsStale,
  normalizeDrivenHold,
  normalizeDrivenHoldIntent
} from '../../../contracts/domains/suppression.mjs';
import {
  findSceneCombat, projectDrivenHold, projectEncounterAftermath, projectObjectiveBoard
} from '../projections/encounters.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import {
  forcedDeletion, resolveActor, resolveScene, resolveToken, stackRescale as rescaleDecayChanges
} from '../services/host.mjs';
import { reportFoundryError, reportFoundryProbe } from '../services/diagnostics.mjs';
import { commitRetraction } from './retractions.mjs';

/* -------------------------------------------- */
/*  Encounter settlement                        */
/* -------------------------------------------- */

const encounterOptions = () => ({ emblemEncounterSettlement: true });

/** The Scene flags a phase change writes. capturePhaseChange records them before the first write. */
const PHASE_SCENE_PATHS = Object.freeze([
  `flags.${SYSTEM_ID}.${ENCOUNTER_PHASE_FLAG}`, `flags.${SYSTEM_ID}.${ENCOUNTER_ROUND_FLAG}`
]);

/**
 * The Actor path recorded before applyTurnUpdates. The updates can also change Willpower, Dexterity, Extra Actions,
 * Energy and the downtime flag, which are not recorded.
 */
const TURN_PATHS = Object.freeze(['system.turn']);

/** What Foundry's Combat#startCombat writes, and so all that needs restoring to undo a start. */
const COMBAT_START_PATHS = Object.freeze(['round', 'turn']);

/** What `Combat#activate` writes, which the tracker reads to decide which encounter it offers. */
const COMBAT_ACTIVE_PATHS = Object.freeze(['active']);

/** A unit's record of the Rallies it cast this map, which an encounter's start and end both clear. */
const RALLY_RECORD_PATH = `flags.${SYSTEM_ID}.${RALLY_RECORD_FLAG}`;

/** The phases a timed summon has left, which each phase change that reaches it counts down. */
const SUMMON_REMAINING_PATH = `flags.${SYSTEM_ID}.${SUMMON_REMAINING_FLAG}`;

/**
 * Saves encounter state for engine/combat/encounters: the Scene's phase and round, units' turn state, effect decay,
 * the Combat document and its objective flags, and an ended encounter's cleanup. Plain reads pass straight through
 * to FoundryEncounterProjection (projections/encounters.mjs).
 *
 * Each writer takes the running command's `operation` (its undo record) and records what it is about to change
 * before writing, so a failed command can be undone.
 */
export class FoundryEncounterRepository {
  constructor({ projection, guardBonds = null }) {
    this.projection = projection;
    this.guardBonds = guardBonds;
  }

  resourceKeys(payload) {
    return this.projection.resourceKeys(payload);
  }

  getWritableActorUuids(sceneUuid) {
    return this.projection.getWritableActorUuids(sceneUuid);
  }

  getPendingContinuations() {
    return this.projection.getPendingContinuations();
  }

  getSnapshot(sceneUuid) {
    return this.projection.getSnapshot(sceneUuid);
  }

  getObjectiveSnapshot(sceneUuid) {
    return this.projection.getObjectiveSnapshot(sceneUuid);
  }

  /** What an ended encounter clears from its map, read from the Scene by projectEncounterAftermath. */
  async getAftermathSnapshot(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    return scene ? projectEncounterAftermath(scene) : null;
  }

  /**
   * Record, in one save, what an ordinary phase change writes: the Scene's phase and round, the terrain entries the
   * timed-terrain expiry will rewrite, and each participant's turn state. `engine/combat/encounters/phases.mjs` calls
   * this before its first write.
   * @param {string} sceneUuid The map whose phase is turning over.
   * @param {{operation: object|null, actorUuids: string[], terrain: object|null}} intent The undo record, the
   *   participants to record, and the expiry plan from `TerrainPhaseService.projectTimedExpiry`.
   * @returns {Promise<boolean>} False when the Scene is gone.
   */
  async capturePhaseChange(sceneUuid, { operation = null, actorUuids = [], terrain = null } = {}) {
    if (!operation) return true;
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    const documents = [{ document: scene, paths: [...PHASE_SCENE_PATHS, ...terrainSweepPaths(terrain)] }];
    for (const actorUuid of actorUuids) {
      const actor = await resolveActor(actorUuid);
      if (actor) documents.push({ document: actor, paths: TURN_PATHS });
    }
    await operation.capture({ documents });
    return true;
  }

  /** Stamp the acting faction and round onto the Scene in one write, so `updateScene` sees both change together. */
  async setPhase(sceneUuid, phase, round, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    try {
      await operation?.capture({ documents: [{ document: scene, paths: PHASE_SCENE_PATHS }] });
      await scene.update({
        [`flags.${SYSTEM_ID}.${ENCOUNTER_PHASE_FLAG}`]: String(phase),
        [`flags.${SYSTEM_ID}.${ENCOUNTER_ROUND_FLAG}`]: Math.max(1, Math.floor(Number(round) || 1))
      });
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'setPhase');
      return false;
    }
  }

  /** Clear the Scene's phase and round, in one write, without touching any unit's turn state. */
  async clearPhase(sceneUuid, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    try {
      await operation?.capture({ documents: [{ document: scene, paths: PHASE_SCENE_PATHS }] });
      await scene.update({
        ...forcedDeletion(`flags.${SYSTEM_ID}.${ENCOUNTER_PHASE_FLAG}`),
        ...forcedDeletion(`flags.${SYSTEM_ID}.${ENCOUNTER_ROUND_FLAG}`)
      });
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'clearPhase');
      return false;
    }
  }

  /**
   * Write every participating unit's opening turn state, recording their turn state first. Each unit's kept
   * retractable item use becomes final before its turn is replaced (commitRetraction). Neighbouring world Actors
   * share one write; see turnUpdateBatches.
   */
  async applyTurnUpdates(sceneUuid, plan = [], operation = null) {
    const actors = [];
    for (const entry of plan) {
      const actor = await resolveActor(entry.actorUuid);
      if (actor) actors.push({ actor, updates: entry.updates });
    }
    if (!actors.length) return true;
    try {
      await operation?.capture({ documents: actors.map(entry => ({ document: entry.actor, paths: TURN_PATHS })) });
      for (const { actor } of actors) await commitRetraction(actor, operation);
      for (const batch of turnUpdateBatches(actors)) {
        if (batch.length === 1) await batch[0].actor.update({ ...batch[0].updates }, encounterOptions());
        else {
          await getDocumentClass('Actor').updateDocuments(
            batch.map(entry => ({ ...entry.updates, _id: entry.actor.id })), encounterOptions()
          );
        }
      }
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'applyTurnUpdates');
      return false;
    }
  }

  /**
   * Apply one unit's planned phase decay: removals, countdowns, and shed stacks. An effect that is already gone is
   * skipped.
   */
  async applyEffectDecay(actorUuid, plan, operation = null) {
    const actor = await resolveActor(actorUuid);
    if (!actor) return false;
    try {
      const effects = collectionValues(actor.effects);
      const byId = id => effects.find(candidate => candidate.id === id) ?? null;
      const removeIds = plan.removeIds.filter(byId);
      const updates = plan.durations.filter(entry => byId(entry.id)).map(entry => ({
        _id: entry.id,
        [`flags.${SYSTEM_ID}.duration`]: entry.duration
      }));
      for (const stack of plan.stacks) {
        const effect = byId(stack.id);
        if (!effect) continue;
        updates.push({
          _id: stack.id,
          [`flags.${SYSTEM_ID}.stackCount`]: stack.to,
          'system.changes': rescaleDecayChanges(effect, stack.from, stack.to)
        });
      }
      await operation?.capture({
        deleting: removeIds.map(byId),
        documents: updates.map(entry => byId(entry._id))
      });
      if (removeIds.length) await actor.deleteEmbeddedDocuments('ActiveEffect', removeIds, encounterOptions());
      if (updates.length) await actor.updateEmbeddedDocuments('ActiveEffect', updates, encounterOptions());
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'applyEffectDecay');
      return false;
    }
  }

  /* -------------------------------------------- */
  /*  Encounter documents                         */
  /* -------------------------------------------- */

  /**
   * Create the Scene's encounter; the system runs one Combat per Scene. Its id is recorded for undo before the
   * Combat exists, so a failed command, or a host client reload before the command finishes, removes it. Returns
   * null if the Scene already has one.
   */
  async createEncounter(sceneUuid, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene || findSceneCombat(scene)) return null;
    try {
      const combatId = documentId();
      await operation?.capture({ creating: [{ documentName: 'Combat', ids: [combatId] }] });
      const combat = await getDocumentClass('Combat').create({ _id: combatId, scene: scene.id }, { keepId: true });
      // Undo deletes the new Combat, so its activation needs no record of its own.
      await combat?.activate({ render: false });
      return combat ? String(combat.id) : null;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'createEncounter');
      return null;
    }
  }

  /** Make the Scene's existing encounter the active one, so the tracker shows it instead of offering a new one. */
  async activateEncounter(sceneUuid, operation = null) {
    const combat = await resolveSceneCombat(sceneUuid);
    if (!combat) return false;
    try {
      await operation?.capture({ documents: [{ document: combat, paths: COMBAT_ACTIVE_PATHS }] });
      await combat.activate({ render: true });
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'activateEncounter');
      return false;
    }
  }

  /**
   * Start the Scene's encounter with Foundry's Combat#startCombat, recording the round and turn it writes so a
   * failed command can undo the start. The system keeps phase and round in Scene flags and never advances the
   * Combat's own round, so core round hooks and round-based effect durations from other modules don't tick.
   */
  async startEncounter(sceneUuid, operation = null) {
    const combat = await resolveSceneCombat(sceneUuid);
    if (!combat) return false;
    try {
      if (combat.started !== true) {
        await operation?.capture({ documents: [{ document: combat, paths: COMBAT_START_PATHS }] });
        await combat.startCombat();
      }
      return combat.started === true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'startEncounter');
      return false;
    }
  }

  /** Delete the Scene's encounter, which also removes every flag stored on it. */
  async deleteEncounter(sceneUuid, operation = null) {
    const combat = await resolveSceneCombat(sceneUuid);
    if (!combat) return true;
    try {
      await operation?.capture({ deleting: [combat] });
      await combat.delete();
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'deleteEncounter');
    }
    return !collectionValues(game.combats).some(entry => entry.uuid === combat.uuid);
  }

  /** Toggle one boolean encounter switch. */
  async setEncounterFlag(sceneUuid, key, value, operation = null) {
    const combat = await resolveSceneCombat(sceneUuid);
    if (!combat) return false;
    try {
      await operation?.capture({ documents: [{ document: combat, paths: [`flags.${SYSTEM_ID}.${key}`] }] });
      await combat.setFlag(SYSTEM_ID, key, value);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'setEncounterFlag');
      return false;
    }
  }

  /** Keep a paused encounter's round on the Scene, where it outlives the deleted Combat document. */
  async writePausedEncounter(sceneUuid, record, operation = null) {
    return this.#writeSceneFlag(sceneUuid, PAUSED_ENCOUNTER_FLAG, { ...record }, operation);
  }

  /** Forget a paused encounter, whether it was resumed or discarded. */
  async clearPausedEncounter(sceneUuid, operation = null) {
    return this.#writeSceneFlag(sceneUuid, PAUSED_ENCOUNTER_FLAG, undefined, operation);
  }

  /** Store or clear the Scene's free-exploration switch. */
  async setExploration(sceneUuid, active, operation = null) {
    return this.#writeSceneFlag(sceneUuid, EXPLORATION_FLAG, active ? true : undefined, operation);
  }

  /** One Scene flag, recorded at its own path and then written or removed. */
  async #writeSceneFlag(sceneUuid, flag, value, operation) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    try {
      await operation?.capture({ documents: [{ document: scene, paths: [`flags.${SYSTEM_ID}.${flag}`] }] });
      if (value === undefined) await scene.unsetFlag(SYSTEM_ID, flag);
      else await scene.setFlag(SYSTEM_ID, flag, value);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, `writeSceneFlag:${flag}`);
      return false;
    }
  }

  /* -------------------------------------------- */
  /*  Encounter aftermath                         */
  /* -------------------------------------------- */

  /**
   * Clear what an ended encounter leaves on its map, as `planEncounterAftermath` planned it for the teardown in
   * engine/combat/encounters/objectives.mjs: break every Guard bond through FoundryGuardBondRepository, delete the
   * statuses the units wear, clear the units' Rally records, then remove the summoned Tokens and any unlinked Actor
   * inside them. Everything is recorded in one save before the first write, so a refused end puts the bonds,
   * statuses, records and summons back.
   * @param {string} sceneUuid The map whose encounter is ending.
   * @param {{bondedTokenUuids: string[], statuses: Array<{actorUuid: string, effectIds: string[]}>,
   *   ralliedActorUuids?: string[], summonTokenUuids: string[]}} plan What the teardown clears.
   * @param {object|null} [operation] The ending command's undo record.
   * @returns {Promise<boolean>} Whether everything planned is gone.
   */
  async clearEncounterAftermath(sceneUuid, plan, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    try {
      const bonded = await sceneTokens(scene, plan.bondedTokenUuids);
      const summons = await sceneTokens(scene, plan.summonTokenUuids);
      const statuses = await wornStatuses(plan.statuses);
      const rallied = await resolveActors(plan.ralliedActorUuids);
      const bonds = bonded.map(token => this.guardBonds?.breakCaptures?.(token) ?? { documents: [], deleting: [] });
      await operation?.capture({
        documents: [...bonds.flatMap(bond => bond.documents), ...rallyRecordCaptures(rallied)],
        deleting: [...bonds.flatMap(bond => bond.deleting), ...statuses.flatMap(entry => entry.effects), ...summons]
      });
      for (const token of bonded) {
        await this.guardBonds?.breakFor(token.uuid, GUARD_BOND_BREAKS.ENCOUNTER_ENDED, { operation });
      }
      for (const { actor, effects } of statuses) {
        const ids = effects.map(effect => String(effect.id)).filter(id => actor.effects.get(id));
        if (ids.length) await actor.deleteEmbeddedDocuments('ActiveEffect', ids, encounterOptions());
        if (ids.some(id => actor.effects.get(id))) return false;
      }
      await writeRallyRecordResets(rallied);
      if (summons.length) {
        await scene.deleteEmbeddedDocuments('Token', summons.map(token => String(token.id)), encounterOptions());
      }
      return summons.every(token => !scene.tokens.get(token.id));
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'clearEncounterAftermath');
      return false;
    }
  }

  /**
   * Make the kept retractable item use of every unit on an ending encounter's map final (commitRetraction), so no
   * use outlives the encounter it was made in.
   * @param {string} sceneUuid The map whose encounter is ending.
   * @param {object|null} [operation] The ending command's undo record.
   * @returns {Promise<boolean>} False when the Scene is gone or a write failed.
   */
  async commitRetractions(sceneUuid, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    try {
      const actors = new Set(collectionValues(scene.tokens).map(token => token.actor).filter(Boolean));
      for (const actor of actors) await commitRetraction(actor, operation);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'commitRetractions');
      return false;
    }
  }

  /**
   * Count down the timed summons an ending phase reaches and remove those whose time ran out, as `planSummonExpiry`
   * planned it for the phase change in engine/combat/encounters/phases.mjs. The counters are recorded, then written
   * in one Token update, and the removal goes through removeSummons.
   * @param {string} sceneUuid The map whose phase is ending.
   * @param {{expiredTokenUuids: string[], counters: Array<{tokenUuid: string, remaining: number}>}} plan
   * @param {object|null} [operation] The phase change's undo record.
   * @returns {Promise<boolean>} Whether every counter is written and every expired summon is gone.
   */
  async expireSummons(sceneUuid, plan, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    try {
      const counted = await sceneTokens(scene, plan.counters.map(counter => counter.tokenUuid));
      await operation?.capture({
        documents: counted.map(token => ({ document: token, paths: [SUMMON_REMAINING_PATH] }))
      });
      const counters = new Map();
      for (const token of counted) {
        const { remaining } = plan.counters.find(counter => counter.tokenUuid === token.uuid);
        if (!counters.has(token.id)) counters.set(token.id, { _id: token.id, [SUMMON_REMAINING_PATH]: remaining });
      }
      if (counters.size) await scene.updateEmbeddedDocuments('Token', [...counters.values()], encounterOptions());
      return await removeSummons(scene, await sceneTokens(scene, plan.expiredTokenUuids), this.guardBonds, operation);
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'expireSummons');
      return false;
    }
  }

  /**
   * Clear the record of the Rallies each named unit cast this map, for a new encounter's start (beginEncounter in
   * engine/combat/encounters/phases.mjs). The records are saved for undo before they are cleared.
   * @param {string[]} actorUuids The Actors `planRallyRecordReset` named.
   * @param {object|null} [operation] The starting command's undo record.
   * @returns {Promise<boolean>} Whether every record cleared.
   */
  async clearRallyRecords(actorUuids, operation = null) {
    try {
      const actors = await resolveActors(actorUuids);
      await operation?.capture({ documents: rallyRecordCaptures(actors) });
      await writeRallyRecordResets(actors);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'clearRallyRecords');
      return false;
    }
  }

  /* -------------------------------------------- */
  /*  Objective records                           */
  /* -------------------------------------------- */

  /** Write the GM's authored win and defeat conditions onto the map. */
  async writeObjectiveConfig(sceneUuid, spec, operation = null) {
    return this.#writeSceneFlag(sceneUuid, OBJECTIVE_FLAGS.CONFIG, structuredClone(spec), operation);
  }

  /** Store the resolved objective targets, optionally resetting progress with them. */
  async writeObjectiveTargets(sceneUuid, targets, { resetProgress = false, operation = null } = {}) {
    const combat = await resolveSceneCombat(sceneUuid);
    if (!combat) return false;
    const update = { [`flags.${SYSTEM_ID}.${OBJECTIVE_FLAGS.TARGETS}`]: structuredClone(targets) };
    const paths = [`flags.${SYSTEM_ID}.${OBJECTIVE_FLAGS.TARGETS}`];
    if (resetProgress) {
      update[`flags.${SYSTEM_ID}.${OBJECTIVE_FLAGS.PROGRESS}`] = { kills: [], arrivals: [] };
      Object.assign(update, forcedDeletion(`flags.${SYSTEM_ID}.${OBJECTIVE_FLAGS.END_PENDING}`));
      paths.push(`flags.${SYSTEM_ID}.${OBJECTIVE_FLAGS.PROGRESS}`, `flags.${SYSTEM_ID}.${OBJECTIVE_FLAGS.END_PENDING}`);
    }
    try {
      await operation?.capture({ documents: [{ document: combat, paths }] });
      await combat.update(update);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'writeObjectiveTargets');
      return false;
    }
  }

  /** Record kills and arrivals, which are what a rout count and an arrival objective read. */
  async writeObjectiveProgress(sceneUuid, progress, operation = null) {
    return this.#writeEncounterFlag(sceneUuid, OBJECTIVE_FLAGS.PROGRESS, {
      kills: [...progress.kills],
      arrivals: [...progress.arrivals]
    }, operation);
  }

  /** Remove units that have arrived after breaking their Guard bonds, recording both sides and the Tokens first. */
  async withdrawUnits(sceneUuid, tokenUuids, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return false;
    try {
      const tokens = [];
      for (const tokenUuid of tokenUuids ?? []) {
        const token = await resolveToken(tokenUuid);
        if (token && String(token.parent?.id ?? '') === String(scene.id)) tokens.push(token);
      }
      if (!tokens.length) return true;
      const bonds = tokens.map(token => this.guardBonds?.breakCaptures?.(token) ?? { documents: [], deleting: [] });
      await operation?.capture({
        documents: bonds.flatMap(bond => bond.documents),
        deleting: [...bonds.flatMap(bond => bond.deleting), ...tokens]
      });
      for (const token of tokens) {
        await this.guardBonds?.breakFor(token.uuid, GUARD_BOND_BREAKS.LEFT, { operation });
      }
      const removeIds = tokens.map(token => String(token.id));
      await scene.deleteEmbeddedDocuments('Token', removeIds, encounterOptions());
      return removeIds.every(id => !scene.tokens.get(id));
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'withdrawUnits');
      return false;
    }
  }

  /**
   * Save the objective end this map is waiting on. While the flag is set, the map refuses every further phase
   * advance, pause and objective check, and resolveObjectiveEnd (encounters/objectives.mjs) finishes the end as its
   * own command.
   */
  async writePendingEnd(sceneUuid, request, operation = null) {
    return this.#writeEncounterFlag(sceneUuid, OBJECTIVE_FLAGS.END_PENDING, structuredClone(request), operation);
  }

  /** Write the decided outcome onto the pending end, which makes the end final. */
  async commitPendingEnd(sceneUuid, requestId, reason, committedAt, operation = null) {
    const combat = await resolveSceneCombat(sceneUuid);
    const pending = combat?.getFlag(SYSTEM_ID, OBJECTIVE_FLAGS.END_PENDING);
    if (!combat || pending?.requestId !== requestId) return false;
    return this.#writeEncounterFlag(sceneUuid, OBJECTIVE_FLAGS.END_PENDING,
      { ...pending, updatedAt: committedAt, commit: { reason, committedAt } }, operation);
  }

  /** Drop a queued end that no longer matches the map. */
  async clearPendingEnd(sceneUuid, operation = null) {
    return this.#writeEncounterFlag(sceneUuid, OBJECTIVE_FLAGS.END_PENDING, undefined, operation);
  }

  /** One encounter flag, recorded at its own path and then written or removed. */
  async #writeEncounterFlag(sceneUuid, flag, value, operation) {
    const combat = await resolveSceneCombat(sceneUuid);
    if (!combat) return false;
    try {
      await operation?.capture({ documents: [{ document: combat, paths: [`flags.${SYSTEM_ID}.${flag}`] }] });
      if (value === undefined) await combat.unsetFlag(SYSTEM_ID, flag);
      else await combat.setFlag(SYSTEM_ID, flag, value);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, `writeEncounterFlag:${flag}`);
      return false;
    }
  }

  /** The Scene's objective overview, from projectObjectiveBoard. */
  async projectBoard(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    return scene ? projectObjectiveBoard(scene) : null;
  }

  /* -------------------------------------------- */
  /*  Companion module hold                       */
  /* -------------------------------------------- */

  /** The hold a companion module (such as the enemy AI) has taken on play, as plain data, or null. */
  getDrivenHold() {
    return projectDrivenHold();
  }

  /** Whether a changed setting is the driven hold, so a client repaints its banner. */
  isDrivenHoldSetting(setting) {
    const key = setting?.key ?? setting?.name;
    return key === `${SYSTEM_ID}.${DRIVEN_HOLD_SETTING}`;
  }

  /** Take the hold for a companion module (api drivenBoard.hold). Returns null while another client has it. */
  async holdDrivenBoard(intent, userId, userName = '') {
    const holderId = String(userId ?? '');
    if (!holderId) return null;
    const standing = projectDrivenHold();
    if (standing && standing.holderId !== holderId) return null;
    const normalized = normalizeDrivenHoldIntent(intent);
    const value = {
      driverId: normalized.driverId,
      holderId,
      holderName: String(userName || game.users.get(holderId)?.name || 'Someone'),
      label: normalized.label,
      tokenName: normalized.tokenName,
      tokenImg: normalized.tokenImg,
      acquiredAt: standing ? standing.acquiredAt : Date.now()
    };
    try {
      await globalThis.game.settings.set(SYSTEM_ID, DRIVEN_HOLD_SETTING, value);
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'holdDrivenBoard');
      return null;
    }
    return normalizeDrivenHold(value);
  }

  /** Release the hold, which only the client holding it may do. */
  async releaseDrivenBoard(userId) {
    const standing = projectDrivenHold();
    if (!standing) return true;
    if (standing.holderId !== String(userId ?? '')) return false;
    return clearDrivenHold();
  }

  /** Clear a hold left by a client that has disconnected, or one held too long. */
  async reapDrivenBoard() {
    const standing = projectDrivenHold();
    if (!standing) return false;
    const holderActive = game.users.get(standing.holderId)?.active === true;
    if (!drivenHoldIsStale(standing, { holderActive, now: Date.now() })) return false;
    reportFoundryProbe(import.meta.url, null, `Emblem RPG | Reaping a driven board hold left by ${standing.holderName}.`, true);
    return clearDrivenHold();
  }
}

/* -------------------------------------------- */
/*  Host helpers                                */
/* -------------------------------------------- */

/**
 * The Scene flag entries one phase's timed-terrain expiry will rewrite, from
 * `TerrainPhaseService.projectTimedExpiry`, so only those squares are recorded before the phase change.
 */
function terrainSweepPaths(terrain) {
  const paths = new Set();
  for (const counter of terrain?.counters ?? []) {
    paths.add(`flags.${SYSTEM_ID}.${TERRAIN_EDIT_RECORDS_FLAG}.${counter.key}`);
  }
  for (const cell of terrain?.cells ?? []) {
    paths.add(`flags.${SYSTEM_ID}.${TERRAIN_GRID_FLAG}.${cell.key}`);
    paths.add(`flags.${SYSTEM_ID}.${TERRAIN_EDIT_RECORDS_FLAG}.${cell.key}`);
  }
  return [...paths];
}

async function clearDrivenHold() {
  try {
    await globalThis.game.settings.set(SYSTEM_ID, DRIVEN_HOLD_SETTING, null);
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'clearDrivenHold');
    return false;
  }
}

async function resolveSceneCombat(sceneUuid) {
  const scene = await resolveScene(sceneUuid);
  return scene ? findSceneCombat(scene) : null;
}

/**
 * Break the Guard bonds of the summons named and delete their Tokens, recording both first.
 * @returns {Promise<boolean>} Whether every summon is gone.
 */
export async function removeSummons(scene, tokens, guardBonds, operation = null) {
  if (!tokens.length) return true;
  const bonds = tokens.map(token => guardBonds?.breakCaptures?.(token) ?? { documents: [], deleting: [] });
  await operation?.capture({
    documents: bonds.flatMap(bond => bond.documents),
    deleting: [...bonds.flatMap(bond => bond.deleting), ...tokens]
  });
  for (const token of tokens) await guardBonds?.breakFor(token.uuid, GUARD_BOND_BREAKS.LEFT, { operation });
  await scene.deleteEmbeddedDocuments('Token', tokens.map(token => String(token.id)), encounterOptions());
  return tokens.every(token => !scene.tokens.get(token.id));
}

/**
 * Group turn updates into writes, keeping plan order: a run of world Actors goes out as one Actor.updateDocuments,
 * and a token's unlinked Actor, which Foundry writes through its ActorDelta, goes alone. An Actor already in the run
 * starts a new one, so its second update applies on top of its first, as two separate writes would.
 */
function turnUpdateBatches(entries) {
  const batches = [];
  let run = null;
  for (const entry of entries) {
    const { actor } = entry;
    if (actor.isToken || actor.pack || actor.parent) {
      batches.push([entry]);
      run = null;
      continue;
    }
    if (!run || run.some(other => other.actor === actor)) batches.push(run = []);
    run.push(entry);
  }
  return batches;
}

/** The Tokens a cleanup plan names that still stand on its map. */
async function sceneTokens(scene, tokenUuids = []) {
  const tokens = [];
  for (const tokenUuid of tokenUuids) {
    const token = await resolveToken(tokenUuid);
    if (token && String(token.parent?.id ?? '') === String(scene.id)) tokens.push(token);
  }
  return tokens;
}

/** Each planned Actor with the status effects it still wears. */
async function wornStatuses(entries = []) {
  const worn = [];
  for (const entry of entries) {
    const actor = await resolveActor(entry.actorUuid);
    const effects = (entry.effectIds ?? []).map(id => actor?.effects.get(String(id))).filter(Boolean);
    if (effects.length) worn.push({ actor, effects });
  }
  return worn;
}

/** The planned Actors that still exist. */
async function resolveActors(actorUuids = []) {
  const actors = [];
  for (const actorUuid of actorUuids) {
    const actor = await resolveActor(actorUuid);
    if (actor) actors.push(actor);
  }
  return actors;
}

/** The one path each Rally record reset writes, to be recorded for undo. */
function rallyRecordCaptures(actors) {
  return actors.map(actor => ({ document: actor, paths: [RALLY_RECORD_PATH] }));
}

/** Empty each Actor's record of the Rallies it cast this map. */
async function writeRallyRecordResets(actors) {
  for (const actor of actors) await actor.update({ [RALLY_RECORD_PATH]: [] }, encounterOptions());
}

/** A new document id, picked before creation so it can be recorded for undo and kept with `keepId`. */
function documentId() {
  return foundry.utils.randomID();
}
