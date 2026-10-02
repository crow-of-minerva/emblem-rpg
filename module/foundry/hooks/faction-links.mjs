/** @layer foundry/hooks */
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { FACTION_LINK_FLAG } from '../../contracts/domains/characters.mjs';
import { RESTORE_WRITE_OPTION } from '../../contracts/domains/recovery.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { isFactionLinkRecord } from '../../game/effects/faction-links.mjs';
import { isActiveGm, localUserId } from '../adapters/services/host.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Faction changes tied to a status            */
/* -------------------------------------------- */

/**
 * Change a unit back when the status its faction change was tied to is deleted, however it went: countdown, dispel,
 * a remove status step, the end of the encounter, or the GM deleting it. EmblemActiveEffect calls
 * `onEffectsDeleted` from `_onDeleteOperation`, on every client, after the deletion; only the host client acts.
 *
 * A deletion this client made while a command is running is changed back inside that command (`revertWithin`), and
 * the deleting client awaits it, so the writes land in the command's undo record before it goes on. Any other
 * deletion is queued as a maintenance command. Deletions an undo makes are skipped: the undo writes the old faction
 * back itself.
 * @param {object} ports
 * @param {Function} ports.revertWithin Runs REVERT_LINK inside the running command, given the payload. When it is
 *   refused (no command is running) or fails, the revert is queued as maintenance instead.
 * @param {Function} ports.executeInternal Queues REVERT_LINK as maintenance, given its id and payload.
 */
export function createFactionLinkLifecycle({ revertWithin, executeInternal }) {
  const failed = error => reportFoundryError(import.meta.url, error,
    'Emblem RPG | Changing a unit back to its faction failed');

  async function revert(payload, deletedHere) {
    if (deletedHere) {
      const joined = await revertWithin(payload);
      if (joined?.ok === true) return;
    }
    // Not awaited: the queued command waits for the command slot, which the deleting code may be holding.
    void Promise.resolve(executeInternal(INTERNAL_COMMAND_IDS.CHARACTER.FACTION.REVERT_LINK, payload)).catch(failed);
  }

  return Object.freeze({
    /** Never throws: a failure is reported and the deletion stands. */
    async onEffectsDeleted(effects, operation = {}, user = null) {
      if (!isActiveGm() || operation?.[RESTORE_WRITE_OPTION] === true) return;
      const deletedHere = String(user?.id ?? user ?? '') === localUserId();
      for (const effect of effects ?? []) {
        const record = effect?.flags?.[SYSTEM_ID]?.[FACTION_LINK_FLAG];
        const actor = effect?.parent;
        if (!isFactionLinkRecord(record) || actor?.documentName !== 'Actor' || actor.pack) continue;
        const payload = { actorUuid: String(actor.uuid), effectId: String(effect.id), record: structuredClone(record) };
        try {
          await revert(payload, deletedHere);
        } catch (error) {
          failed(error);
        }
      }
    }
  });
}
