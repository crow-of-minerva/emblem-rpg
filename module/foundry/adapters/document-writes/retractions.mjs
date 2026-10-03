/** @layer foundry/adapters/document-writes */
import { MOVEMENT_PLAN_PATHS } from '../../../contracts/domains/characters.mjs';
import {
  parseRetraction, pendingUseConsumption, rememberRetraction, retractionStanding, serializeRetraction
} from '../../../game/items/retraction.mjs';
import { clone, resolveActor, resolveDocument, resolveItem, resolveToken } from '../services/host.mjs';

/* -------------------------------------------- */
/*  Retractable item uses                       */
/* -------------------------------------------- */

/**
 * Where a unit keeps its retractable item use and what its items remember this turn, as the text
 * game/items/retraction.mjs reads and writes.
 */
const RETRACTION_PATH = 'system.turn.retraction';

/** The items whose skill check failed this phase. The phase change empties the list. */
const LOCKED_ITEMS_PATH = 'system.turn.lockedItems';

const TURN_PREFIX = 'system.turn.';

/** Marks these writes like an item use's own, so the Stance hook and the placed-token fill leave them alone. */
const writeOptions = () => ({ emblemEffectSettlement: true });

/**
 * Make a unit's kept retractable use final and forget what its items remember this turn. The item's uses are spent
 * by the same rule as an ordinary use (pendingUseConsumption), so a consumable at zero is destroyed. Every write is
 * saved in `operation` first. The unit acting again, its turn end, the phase change and the end of the encounter all
 * come here.
 * @param {Actor|null} actor The unit.
 * @param {object|null} [operation] The running command's undo record.
 * @returns {Promise<boolean>} Whether anything was written. A unit with nothing kept or remembered is left alone.
 */
export async function commitRetraction(actor, operation = null) {
  if (!actor?.system?.turn?.retraction) return false;
  const pending = parseRetraction(actor.system.turn.retraction)?.pending ?? null;
  const item = pending ? await resolveItem(pending.itemUuid) : null;
  const consumption = item ? pendingUseConsumption(item, pending.landed === true) : null;
  const destroy = consumption?.destroy === true;
  await operation?.capture({
    documents: [
      { document: actor, paths: [RETRACTION_PATH] },
      ...(consumption?.consume && !destroy ? [{ document: item, paths: ['system.uses'] }] : [])
    ],
    deleting: destroy ? [item] : []
  });
  if (destroy) await item.delete(writeOptions());
  else if (consumption?.consume) await item.update({ 'system.uses.current': consumption.remaining }, writeOptions());
  await actor.update({ [RETRACTION_PATH]: null }, writeOptions());
  return true;
}

/**
 * The reads and writes behind retractable item uses for engine/items/activation.mjs: keeping a use, making it final,
 * locking an item whose check failed, and taking a use back. Built in init/system.mjs with the same snapshots
 * service the undo records use.
 */
export class FoundryRetractionRepository {
  /** @param {{snapshots: {restore: Function}}} ports The service that writes an undo record's old values back. */
  constructor({ snapshots }) {
    this.snapshots = snapshots;
  }

  /** Make the unit's kept use final (commitRetraction). */
  async commit(actorUuid, operation = null) {
    return commitRetraction(await resolveActor(actorUuid), operation);
  }

  /**
   * Keep a retractable use on the unit: the copy of its undo record, the item, whether it landed, and the movement
   * spent and token position now, which Cancel compares to tell whether the unit has moved since. The item's check
   * result and dice are added to what it remembers this turn.
   * @param {string} tokenUuid The unit's Token.
   * @param {{record: object|null, itemUuid: string, landed: boolean, check: object|null,
   *   rolls: Record<string, number>}} use What the use wrote and rolled.
   * @param {object|null} [operation] The use's undo record.
   */
  async keep(tokenUuid, { record, itemUuid, landed, check, rolls }, operation = null) {
    const token = await resolveToken(tokenUuid);
    const actor = token?.actor;
    if (!actor) throw new Error('retraction.unit-missing');
    const turn = actor.system?.turn ?? {};
    const text = serializeRetraction({
      pending: {
        record: recordWithoutSettings(record),
        itemUuid: String(itemUuid ?? ''),
        landed: landed === true,
        movementSpent: Number(turn.movementSpent) || 0,
        x: Number(token._source.x) || 0,
        y: Number(token._source.y) || 0
      },
      memory: rememberRetraction(parseRetraction(turn.retraction)?.memory, String(itemUuid ?? ''), { check, rolls })
    });
    await operation?.capture({ documents: [{ document: actor, paths: [RETRACTION_PATH] }] });
    await actor.update({ [RETRACTION_PATH]: text }, writeOptions());
  }

  /** Lock an item whose skill check failed until the next phase, and make the unit's kept use final. */
  async lock(actorUuid, itemUuid, operation = null) {
    const actor = await resolveActor(actorUuid);
    if (!actor) throw new Error('retraction.unit-missing');
    const locked = [...new Set([...(actor.system?.turn?.lockedItems ?? []), String(itemUuid ?? '')])];
    await operation?.capture({ documents: [{ document: actor, paths: [LOCKED_ITEMS_PATH, RETRACTION_PATH] }] });
    await actor.update({ [LOCKED_ITEMS_PATH]: locked, [RETRACTION_PATH]: null }, writeOptions());
  }

  /**
   * Whether the unit has a kept use, and whether it has moved since (retractionStanding).
   * @returns {Promise<{pending: boolean, moved: boolean, itemUuid: string, actorUuid: string}|null>}
   */
  async getStanding(tokenUuid) {
    const token = await resolveToken(tokenUuid);
    const actor = token?.actor;
    if (!actor) return null;
    const turn = actor.system?.turn ?? {};
    const standing = retractionStanding(parseRetraction(turn.retraction), {
      movementSpent: turn.movementSpent, x: token._source.x, y: token._source.y
    });
    return { ...standing, actorUuid: String(actor.uuid ?? '') };
  }

  /**
   * Take the unit's kept use back: write back the old values its undo record holds, which deletes the statuses it
   * created through Foundry's normal delete, then clear the kept use but keep what its items remember. The movement
   * plan's own fields keep their current values. Every write is saved in `operation` first, so a refused retraction
   * is undone.
   * @returns {Promise<boolean>} False when nothing is kept or its record can't be read.
   */
  async retract(tokenUuid, operation = null) {
    const token = await resolveToken(tokenUuid);
    const actor = token?.actor;
    const retraction = parseRetraction(actor?.system?.turn?.retraction);
    const record = retraction?.pending?.record;
    if (!Array.isArray(record?.documents)) return false;
    keepCurrentTurnFields(record, actor);
    const captures = await restoreCaptures(record);
    captures.documents.push({ document: actor, paths: [RETRACTION_PATH] });
    await operation?.capture(captures);
    const unresolved = await this.snapshots.restore(record) ?? [];
    if (unresolved.length) {
      throw new Error(`retraction.not-restored: ${unresolved.map(entry => entry.key).join(', ')}`);
    }
    const remembered = serializeRetraction({ pending: null, memory: retraction.memory });
    await token.actor.update({ [RETRACTION_PATH]: remembered }, writeOptions());
    return true;
  }
}

/* -------------------------------------------- */
/*  Undo records                                */
/* -------------------------------------------- */

/**
 * The record without its world settings. The only setting an item use saves is the karma ledger, and the passed
 * check the item remembers keeps what that roll booked.
 */
function recordWithoutSettings(record) {
  return record ? { ...record, settings: [] } : null;
}

/**
 * Put the unit's current movement plan fields and kept use into the record before it is written back. The plan stays
 * as it is now (it may have been opened since the use, without the unit moving), and the kept use is left for
 * retract to clear in its own write. An unlinked token's record holds its ActorDelta, whose saved data may have had
 * no turn at all.
 */
function keepCurrentTurnFields(record, actor) {
  const uuids = new Set([actor.uuid, actor.token?.delta?.uuid, actor.parent?.delta?.uuid].filter(Boolean));
  const turn = actor.system?.turn ?? {};
  for (const entry of record.documents) {
    if (!uuids.has(entry.uuid)) continue;
    const system = entry.fields?.system;
    const saved = system && typeof system === 'object' ? (system.turn ??= {}) : entry.fields?.['system.turn'];
    if (!saved || typeof saved !== 'object') continue;
    for (const path of [...MOVEMENT_PLAN_PATHS, RETRACTION_PATH]) {
      saved[path.slice(TURN_PREFIX.length)] = clone(turn[path.slice(TURN_PREFIX.length)] ?? null);
    }
  }
}

/**
 * What writing a record back will change, for the retraction's own undo record: the current values of every path
 * it names, the documents it created (which the write-back deletes) and those it deleted (which it recreates under
 * their old ids).
 */
async function restoreCaptures(record) {
  const documents = [];
  const deleting = [];
  const creating = [];
  for (const entry of record.documents ?? []) {
    const document = await resolveDocument(entry.uuid);
    const paths = [...Object.keys(entry.fields ?? {}), ...(entry.absent ?? [])];
    if (document && paths.length) documents.push({ document, paths });
  }
  for (const entry of record.created ?? []) {
    const document = await resolveDocument(createdUuid(entry));
    if (document) deleting.push(document);
  }
  for (const entry of record.deleted ?? []) {
    const id = String(entry.source?._id ?? String(entry.uuid ?? '').split('.').at(-1));
    const parent = entry.parentUuid ? await resolveDocument(entry.parentUuid) : null;
    creating.push({ parent, documentName: entry.documentName, ids: [id], pack: entry.pack });
  }
  return { documents, deleting, creating };
}

/** The uuid a document created under a saved id has. */
function createdUuid(entry) {
  return entry.parentUuid
    ? `${entry.parentUuid}.${entry.documentName}.${entry.id}`
    : `${entry.documentName}.${entry.id}`;
}
