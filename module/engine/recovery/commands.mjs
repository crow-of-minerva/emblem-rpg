/** @layer engine/recovery */
import { COMMAND_IDS } from '../../contracts/commands.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { requirePorts } from '../../contracts/protocol.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { holdsResources } from '../dispatcher.mjs';

/**
 * The two table-recovery command definitions behind `api.recovery`, which init/system.mjs registers.
 *
 * `recovery.clear-lock` releases the movement control lock a departed or timed-out player left, through the
 * injected `recoverLock` (recoverStaleMovement, the same release `/release` uses). `getLock` reads the lock setting
 * and `lockKeys` names what releasing it may write.
 *
 * `recovery.clear-busy` has ExecutionAnnouncer resend who holds the command slot, which lifts every client's
 * "processing" blocker. When forced, it also has CommandDispatcher abandon whatever holds the slot. It is an
 * inspect command, so it runs beside that command and never refuses as busy. Each returns its outcome in `data`.
 */
export function createRecoveryCommandContribution({ authority, getLock, lockKeys, republishExecution, recoverLock,
  announce, abandonExecution, reloadHost }) {
  requirePorts('createRecoveryCommandContribution', { getLock, lockKeys, republishExecution, recoverLock, announce,
    abandonExecution, reloadHost });
  const authorization = createCommandAuthorization(authority);
  return [
    { id: COMMAND_IDS.RECOVERY.CLEAR_LOCK, authorize: authorization.gm(),
      // Reads the lock while the keys are worked out. CommandDispatcher hands this same context on to the handler,
      // which compares it with a fresh read.
      concurrencyKeys: context => { context.recoveryLock = getLock(); return lockKeys(); },
      handler: async context => {
        if (lockIdentity(context.recoveryLock) !== lockIdentity(getLock())) {
          return refuse(RESULT_CODES.RECOVERY_STALE);
        }
        if (!holdsResources(context, await lockKeys())) return refuse(RESULT_CODES.RECOVERY_BUSY);
        const outcome = await recoverLock(context);
        if (outcome.ok !== true) return outcome;
        const cleared = Boolean(context.recoveryLock) && !getLock();
        const announcementPosted = context.payload?.announcement === 'timeout'
          ? await announce({ userId: context.userId, cleared }) : null;
        return accept(cleared ? RESULT_CODES.RECOVERY_LOCK_CLEARED : RESULT_CODES.RECOVERY_INSPECTED,
          { outcome, cleared, announcementPosted });
      } },
    { id: COMMAND_IDS.RECOVERY.CLEAR_BUSY, authorize: authorization.gm(), concurrencyKeys: () => [],
      handler: async context => {
        const holder = context.payload?.force === true ? abandonExecution() : null;
        await republishExecution();
        // An abandoned command keeps its undo record, so the host reloads and startup undoes its writes.
        if (holder?.recorded === true) await reloadHost();
        return accept(RESULT_CODES.RECOVERY_BUSY_CLEARED,
          { abandoned: holder ? { commandId: holder.commandId, lane: holder.lane } : null });
      } }
  ];
}

/**
 * A stable text for one control lock. The handler compares the lock read while its keys were resolved with a
 * fresh read and refuses as stale if they differ, so it never releases a lock someone took in between. Both reads
 * happen after the command has taken the command slot.
 */
function lockIdentity(lock) {
  if (!lock || typeof lock !== 'object') return String(lock ?? '');
  return Object.keys(lock).sort().map(key => `${key}=${JSON.stringify(lock[key]) ?? ''}`).join('|');
}
