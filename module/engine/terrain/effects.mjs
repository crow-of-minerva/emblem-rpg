/** @layer engine/terrain */
import { COMMAND_IDS } from '../../contracts/commands.mjs';
import { DAMAGE_POLICIES } from '../../contracts/domains/damage.mjs';
import { TERRAIN_PERSISTENCE_CODES, TERRAIN_SPAWN_SETTLE_MS } from '../../contracts/domains/terrain.mjs';
import {
  collectDueTerrainSpawns,
  planTerrainEditSweep,
  projectSpawnRecord,
  projectTerrainSweepTargets,
  capTerrainDamage,
  resolveTerrainImpacts,
  spawnPhaseFor
} from '../../game/terrain/effects.mjs';
import { placementOccupancyKeys, resolveSpawnPlacement } from '../../game/terrain/rules.mjs';
import { requirePorts } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Occurrence outcomes                         */
/* -------------------------------------------- */

/**
 * What happened at one spawn square: the unit arrived, it was legitimately skipped, its writes did not land, or the
 * running command could not add the arrival's actor to its resource keys (a malformed key or a run that has
 * already settled), which stops the batch before the arrival is created.
 */
const SPAWN_OUTCOMES = Object.freeze({
  ARRIVED: Object.freeze({ spawned: true, unfinished: false }),
  SKIPPED: Object.freeze({ spawned: false, unfinished: false }),
  UNFINISHED: Object.freeze({ spawned: false, unfinished: true }),
  BUSY: Object.freeze({ spawned: false, unfinished: true, busy: true })
});

/* -------------------------------------------- */
/*  Terrain phase consequences                  */
/* -------------------------------------------- */

/** Apply terrain ticks, spawns and expiry for the phase change in engine/combat/encounters/phases.mjs. */
export class TerrainPhaseService {
  constructor({ terrain, impacts, wait }) {
    requirePorts('TerrainPhaseService', { terrain, impacts, wait });
    this.terrain = terrain;
    this.impacts = impacts;
    this.wait = wait;
  }

  /** A copy whose health commands add their resource keys through the running phase command's `hold`. */
  withResources(resources) {
    return new TerrainPhaseService({ terrain: this.terrain,
      impacts: this.impacts.withResources(resources), wait: this.wait });
  }

  /**
   * Apply healing before hazards at phase start. A failed impact stops the phase change, which then restores.
   * @param {object[]} units Projected phase participants carrying their scanned terrain facts.
   * @returns {Promise<{ok: boolean, applied: number}>}
   */
  async applyPhaseStartImpacts(units = []) {
    let applied = 0;
    for (const unit of units) {
      if (!unit?.terrain?.scan) continue;
      const resolved = resolveTerrainImpacts(unit.terrain.scan, unit.terrain.defenses);
      let remaining = Number.isFinite(unit.hp) ? Number(unit.hp) : null;
      if (resolved.heal) {
        const healed = await this.impacts.applyHealing({ actorUuid: unit.actorUuid, tokenUuid: unit.tokenUuid,
          amount: resolved.heal.hp, stanceAmount: resolved.heal.stance });
        if (healed?.ok === false) return { ok: false, applied };
        if (Number.isFinite(healed?.data?.hpAfter)) remaining = healed.data.hpAfter;
        applied += 1;
      }
      const owed = remaining === null ? resolved.damage
        : capTerrainDamage(resolved.damage, { hp: remaining, actorType: unit.actorType });
      for (const damage of owed) {
        const dealt = await this.impacts.applyDamage({ actorUuid: unit.actorUuid, tokenUuid: unit.tokenUuid,
          amount: damage.amount, damageType: damage.type,
          policy: DAMAGE_POLICIES.WEAPON, canKillPlayer: damage.canKillPlayer });
        if (dealt?.ok === false) return { ok: false, applied };
        applied += 1;
      }
    }
    return { ok: true, applied };
  }

  /**
   * Spawn phase-end arrivals at their faction's timing, claiming each arrival's Actor before its Token is created.
   * The completed record each arrival leaves behind is the square's cooldown, which `collectDueTerrainSpawns` reads
   * on later phases.
   * @param {string} sceneUuid Scene whose phase is closing.
   * @param {string} closingPhase Phase that is ending.
   * @param {number} round Round the closing phase belongs to.
   * @param {{resources?: {hold: function(string[]): boolean}|null, operation?: object|null}} [options] The running
   *   command's hold and the operation its writes are captured into.
   * @returns {Promise<{ok: boolean, spawned: number, unfinished: number, busy: boolean}>}
   */
  async firePhaseEndSpawns(sceneUuid, closingPhase, round, { resources = null, operation = null } = {}) {
    const board = await this.terrain.getSpawnBoard(sceneUuid);
    if (!board) return spawnAnswer(0, 0);
    const due = collectDueTerrainSpawns(board.grid, round, board.state);
    if (!due.length) return spawnAnswer(0, 0);

    const occupied = new Set(board.occupied);
    let spawned = 0;
    let unfinished = 0;
    for (const entry of due) {
      const outcome = await this.#settleSpawnOccurrence({
        sceneUuid, closingPhase, round, board, occupied, entry, resources, operation
      });
      if (outcome.spawned) spawned += 1;
      if (outcome.unfinished) unfinished += 1;
      if (outcome.busy) return spawnAnswer(spawned, unfinished, true);
    }
    if (spawned > 0) await this.wait(TERRAIN_SPAWN_SETTLE_MS);
    return spawnAnswer(spawned, unfinished);
  }

  /**
   * Place one due arrival: reserve its Token id in the operation, create the Token, settle its behaviour and fade,
   * then write the completed record that puts the square on cooldown.
   */
  async #settleSpawnOccurrence({ sceneUuid, closingPhase, round, board, occupied, entry, resources, operation }) {
    const reference = await this.terrain.getSpawnReference(String(entry.spawn.uuid));
    if (!reference || spawnPhaseFor(reference.actorType) !== closingPhase) return SPAWN_OUTCOMES.SKIPPED;
    const footprint = this.#placeSpawn(board, occupied, entry, reference);
    if (!footprint) return SPAWN_OUTCOMES.SKIPPED;
    const uuid = String(entry.spawn.uuid);
    const tokenId = this.terrain.randomId();

    if (resources && !await this.#holdsArrival(sceneUuid, uuid, tokenId, resources)) return SPAWN_OUTCOMES.BUSY;
    const created = await this.terrain.createSpawn({
      sceneUuid, uuid, tokenId, footprint, stateKey: entry.stateKey, operation
    });
    if (created?.ok !== true) return SPAWN_OUTCOMES.UNFINISHED;
    for (const key of placementOccupancyKeys(footprint)) occupied.add(key);
    const settled = await this.terrain.settleSpawn({
      sceneUuid, tokenId, footprint, behavior: entry.spawn.behavior ?? ''
    });
    if (settled?.ok !== true) return SPAWN_OUTCOMES.UNFINISHED;
    const recorded = await this.terrain.recordSpawnState(sceneUuid,
      { [entry.stateKey]: projectSpawnRecord(round) }, operation);
    return recorded === true ? SPAWN_OUTCOMES.ARRIVED : SPAWN_OUTCOMES.UNFINISHED;
  }

  /**
   * Add the actor a reserved arrival will write to the running command's resource keys. This fails only for a
   * malformed key or a run that has already settled.
   */
  async #holdsArrival(sceneUuid, uuid, tokenId, resources) {
    const actorUuid = await this.terrain.spawnActorUuid({ sceneUuid, uuid, tokenId });
    return !actorUuid || resources.hold([`actor:${actorUuid}`]) === true;
  }

  #placeSpawn(board, occupied, entry, reference) {
    const footprint = { x: entry.x, y: entry.y, width: reference.width, height: reference.height };
    const placement = resolveSpawnPlacement(
      { ...board, occupied }, footprint, entry.spawn.blockable === true
    );
    return placement ? { ...footprint, ...placement } : null;
  }

  /**
   * Name the terrain cells and counters one phase's expiry will rewrite, so the phase change can capture exactly
   * those flag entries before its first write. `expireTimedEdits` plans afresh from the same rules.
   * @param {string} sceneUuid Scene whose phase is closing.
   * @param {string} closingPhase Phase that is ending.
   * @returns {Promise<{ok: boolean, code: string, counters: object[], cells: object[]}>}
   */
  async projectTimedExpiry(sceneUuid, closingPhase) {
    const journal = await this.terrain.getEditJournal(sceneUuid);
    if (!journal) {
      return {
        ok: false, code: TERRAIN_PERSISTENCE_CODES.MISSING_SCENE, counters: [], cells: []
      };
    }
    const plan = planTerrainEditSweep(journal.grid, journal.records, { decrement: true, closingPhase });
    const targets = projectTerrainSweepTargets(plan);
    const owed = targets.counters.length > 0 || targets.cells.length > 0;
    return {
      ok: true,
      code: owed ? TERRAIN_PERSISTENCE_CODES.APPLIED : TERRAIN_PERSISTENCE_CODES.NO_OP,
      counters: targets.counters,
      cells: targets.cells
    };
  }

  /**
   * Count the closing phase's timed terrain edits down and restore the squares whose time ran out.
   * @param {string} sceneUuid Scene whose phase is closing.
   * @param {string} closingPhase Phase that is ending.
   * @param {object|null} [operation] The phase change's operation, which the Scene write captures into.
   * @returns {Promise<{ok: boolean, code: string, cells: number}>}
   */
  async expireTimedEdits(sceneUuid, closingPhase, operation = null) {
    return this.#sweepEdits(sceneUuid, { decrement: true, closingPhase }, operation);
  }

  /**
   * Revert every timed terrain edit at once, for the end of a battle where the counters mean nothing, and for the
   * GM Macros compendium's Clear Terrain Effects. Edits authored with no duration are left standing.
   * @param {string} sceneUuid Scene whose battle has been decided, viewed on the canvas or not.
   * @param {object|null} [operation] The running command's operation.
   * @returns {Promise<{ok: boolean, code: string, cells: number}>} `cells` counts the squares put back.
   */
  async revertTimedEdits(sceneUuid, operation = null) {
    return this.#sweepEdits(sceneUuid, { decrement: false, closingPhase: null }, operation);
  }

  /** Forget which spawn squares have fired, so a fresh battle starts clean on this map. */
  async resetSpawnState(sceneUuid, operation = null) {
    await this.terrain.clearSpawnState(sceneUuid, operation);
  }

  async #sweepEdits(sceneUuid, options, operation) {
    const journal = await this.terrain.getEditJournal(sceneUuid);
    if (!journal) {
      return { ok: false, code: TERRAIN_PERSISTENCE_CODES.MISSING_SCENE, cells: 0 };
    }
    const plan = planTerrainEditSweep(journal.grid, journal.records, options);
    if (!plan.cells.length && !plan.counters.length) {
      return { ok: true, code: TERRAIN_PERSISTENCE_CODES.NO_OP, cells: 0 };
    }
    const committed = await this.terrain.applyEditSweep(sceneUuid, plan, operation);
    const ok = committed?.ok === true;
    return {
      ok,
      code: String(committed?.code ?? TERRAIN_PERSISTENCE_CODES.WRITE_FAILED),
      cells: ok ? plan.cells.length : 0
    };
  }
}

/**
 * Report how one phase's spawn squares went: how many arrived, how many left their writes unfinished, and whether
 * a refused resource key for an arrival stopped the batch.
 */
function spawnAnswer(spawned, unfinished, busy = false) {
  return { ok: unfinished === 0, spawned, unfinished, busy };
}

/* -------------------------------------------- */
/*  Health dispatch                             */
/* -------------------------------------------- */

/**
 * The health port for terrain, phase-tick, rest and fall impacts: APPLY_DAMAGE and APPLY_HEALING run as child
 * commands through CommandDispatcher's `invokeWithin` (wired in init/system.mjs), so they join the running
 * command's operation and their health writes are captured there.
 */
export function createTerrainImpactPort(execute, resources = {}) {
  return Object.freeze({
    applyDamage: (intent, parent = resources) => execute(COMMAND_IDS.COMBAT.APPLY_DAMAGE, intent, parent),
    applyHealing: (intent, parent = resources) => execute(COMMAND_IDS.COMBAT.APPLY_HEALING, intent, parent),
    withResources: held => createTerrainImpactPort(execute, held)
  });
}
