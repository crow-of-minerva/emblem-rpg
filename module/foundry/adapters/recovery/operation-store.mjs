/** @layer foundry/adapters/recovery */
import { OPERATION_RECORD_SETTING } from '../../../contracts/domains/recovery.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { readSetting } from '../services/host.mjs';

/* -------------------------------------------- */
/*  Operation record access                     */
/* -------------------------------------------- */

/**
 * Read, write and clear the world setting that holds the open operation record.
 *
 * OperationRecovery (engine/recovery/operations.mjs) owns every transition and is the only caller. Nothing else
 * saves recovery data. Foundry stores a setting value as JSON, so a record's dotted field paths survive unexpanded,
 * and every value handed to `game.settings.set` is a fresh plain object.
 */
export class FoundryOperationStore {
  /** The record left by an unfinished operation, or null once the last one committed. */
  async read() {
    const stored = readSetting(OPERATION_RECORD_SETTING, null);
    return stored && typeof stored === 'object' ? jsonValue(stored) : null;
  }

  async write(record) {
    await game.settings.set(SYSTEM_ID, OPERATION_RECORD_SETTING, jsonValue(record));
  }

  /** Committing and cleaning up are this single write, so no committed operation leaves a record behind. */
  async clear() {
    await game.settings.set(SYSTEM_ID, OPERATION_RECORD_SETTING, null);
  }
}

/** A detached plain-JSON copy: a setting carries no class instance, undefined value or shared reference. */
function jsonValue(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
