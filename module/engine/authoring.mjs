/** @layer engine */
import { callerIsGamemaster } from './authorization.mjs';
import { accept, refuse, RESULT_CODES } from '../contracts/results.mjs';
import { canAuthorSystemDocuments, diagnosticData, recordDiagnostic } from '../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Item authoring                              */
/* -------------------------------------------- */
/** Coordinate Item authoring requested by api/facade.mjs through injected Foundry writers. */
export class ItemAuthoringService {
  constructor({ items }) { this.items = items; }

  async copyAsStaff(caller, itemUuid) {
    if (!canAuthorSystemDocuments(caller)) return { ok: false, code: 'authoring.denied' };
    const created = await this.items.copySpellAsStaff(itemUuid);
    return created
      ? { ok: true, code: 'authoring.staff-created', data: { itemName: created.name, uuid: created.uuid } }
      : { ok: false, code: 'authoring.item-not-found' };
  }

  async terrainPresets() {
    return this.items.getTerrainPresets();
  }
}

/* -------------------------------------------- */
/*  Party configuration                        */
/* -------------------------------------------- */

/** Run api.parties edits and the Foundry ownership changes they imply. Full GMs only, not Assistants. */
export class PartyService {
  constructor({ parties }) {
    this.parties = parties;
  }

  snapshot(caller) {
    if (!callerIsGamemaster(caller)) return refuse(RESULT_CODES.GM_REQUIRED);
    return accept(RESULT_CODES.PARTY_SNAPSHOT, this.parties.snapshot());
  }

  async actorCandidate(caller, actorUuid) {
    if (!callerIsGamemaster(caller)) return refuse(RESULT_CODES.GM_REQUIRED);
    const candidate = await this.parties.actorCandidate(String(actorUuid ?? ''));
    return candidate
      ? accept(RESULT_CODES.PARTY_ACTOR_CANDIDATE, candidate)
      : refuse(RESULT_CODES.PARTY_ACTOR_UUID_INVALID);
  }

  async saveState(caller, state) {
    if (!callerIsGamemaster(caller)) return refuse(RESULT_CODES.GM_REQUIRED);
    const outcome = await this.parties.reconcileState(state);
    return settlementResult(outcome, 'party.state-updated');
  }

  async grantOwnership(caller, userId, actorUuid) {
    if (!callerIsGamemaster(caller)) return refuse(RESULT_CODES.GM_REQUIRED);
    const outcome = await this.parties.grantOwnership(String(userId ?? ''), String(actorUuid ?? ''));
    return settlementResult(outcome, 'party.ownership-granted');
  }

  async assignUnit(caller, intent) {
    if (!callerIsGamemaster(caller)) return refuse(RESULT_CODES.GM_REQUIRED);
    const outcome = await this.parties.assignUnit({
      userId: String(intent?.userId ?? ''),
      actorUuid: String(intent?.actorUuid ?? ''),
      role: intent?.role === 'lord' ? 'lord' : 'retainer',
      fromUserId: String(intent?.fromUserId ?? ''),
      changeType: intent?.changeType === true
    });
    return settlementResult(outcome, 'party.unit-assigned');
  }

  async removeUnit(caller, userId, actorUuid) {
    if (!callerIsGamemaster(caller)) return refuse(RESULT_CODES.GM_REQUIRED);
    const outcome = await this.parties.removeUnit(String(userId ?? ''), String(actorUuid ?? ''));
    return settlementResult(outcome, 'party.unit-removed');
  }

  async assignConvoy(caller, partyId, actorUuid) {
    if (!callerIsGamemaster(caller)) return refuse(RESULT_CODES.GM_REQUIRED);
    const candidate = await this.parties.actorCandidate(String(actorUuid ?? ''));
    if (!candidate || candidate.type !== 'Convoy') return refuse(RESULT_CODES.PARTY_CONVOY_REQUIRED);
    if (!candidate.imported) return refuse(RESULT_CODES.PARTY_CONVOY_IMPORT_REQUIRED);
    const state = this.parties.readState();
    const party = state.parties.find(entry => entry.id === String(partyId ?? ''));
    if (!party) return refuse(RESULT_CODES.PARTY_STATE_UPDATE_FAILED);
    party.convoyUuid = candidate.uuid;
    return settlementResult(await this.parties.reconcileState(state), 'party.state-updated');
  }
}

/* -------------------------------------------- */
/*  Results                                    */
/* -------------------------------------------- */

function settlementResult(outcome, successCode) {
  if (!outcome?.ok) {
    return refuse(outcome?.code ?? RESULT_CODES.COMMAND_FAILED,
      { ...diagnosticData(outcome), ...(outcome?.data ?? {}) });
  }
  const data = { ...outcome };
  delete data.ok;
  return accept(successCode, data);
}

/* -------------------------------------------- */
/*  Terrain replacement                         */
/* -------------------------------------------- */

/**
 * Replace terrain through the Foundry writer as one Scene update, so a failed write leaves the map exactly as it
 * was. The Terrain Builder writes outside CommandDispatcher, so there is no undo record to restore.
 * @param {object} request
 * @param {object} request.repository         The scene's terrain writer.
 * @param {string[]} request.deletePaths      Complete entries the edit removes.
 * @param {Record<string, *>} request.replacements  Complete entries the edit writes in their place.
 */
async function replaceTerrainEntries({ repository, deletePaths = [], replacements = {} }) {
  try {
    await repository.replace({ deletePaths, replacements });
  } catch (cause) {
    recordDiagnostic(repository?.diagnostics, { sourcePath: 'foundry/adapters/document-writes/terrain.mjs',
      error: cause, detail: 'Replace terrain entries'
    });
    throw terrainPersistenceFailure(cause);
  }
}

/* -------------------------------------------- */
/*  Terrain authoring use cases                 */
/* -------------------------------------------- */
/** Apply terrain-builder edits through the Foundry terrain writer without exposing Scene flags to ui/. */
export class TerrainAuthoringService {
  constructor({ terrain }) {
    this.terrain = terrain;
  }

  clearCells(cells) { return this.#settle('planCellClear', cells); }
  replaceCells(entries) { return this.#settle('planCellReplacement', entries); }
  revertEditCells(cells) { return this.#settle('planEditReversion', cells); }
  removeCellsFromZone(cells) { return this.#settle('planZoneCellRemoval', cells); }
  deleteZone(zoneId) { return this.#settle('planZoneDeletion', zoneId); }

  createZone(cells, options) { return this.#repository().createZone(cells, options); }
  updateZone(zoneId, patch) { return this.#repository().updateZone(zoneId, patch); }
  addZoneCells(zoneId, cells) { return this.#repository().addZoneCells(zoneId, cells); }
  createWalls(segments, options) { return this.#repository().createWalls(segments, options); }
  deleteWall(wallId) { return this.#repository().deleteWall(wallId); }
  clearWalls() { return this.#repository().clearWalls(); }
  configureScene(settings) { return this.#repository().writeSceneSettings(settings); }

  #repository() {
    return this.terrain();
  }

  async #settle(planner, value) {
    const repository = this.#repository();
    return replaceTerrainEntries({ repository, ...repository[planner](value) });
  }
}

function terrainPersistenceFailure(cause) {
  return Object.assign(new Error('Terrain persistence failed; the map was left unchanged.', { cause }),
    { code: 'terrain.persistence-failed' });
}
