/** @layer ui/apps/foundry */
import { DIAGNOSTIC_SOURCES, createDiagnostic } from '../../../contracts/protocol.mjs';

export const CHAT_COMMANDS = Object.freeze({ '/release': 'release', '/unstuck': 'unstuck' });
const LABELS = Object.freeze({ release: '/release', unstuck: '/unstuck' });

/**
 * The two staff recovery chat commands: /release and /unstuck. init/system.mjs builds them, and the chatMessage hook
 * in init/hooks.mjs calls onChatMessage. Chat only asks, through game.emblemRpg.api.recovery. The host checks the user
 * and carries out the command.
 */
export function createRecoveryChatCommands({ api, notify, localUser, diagnostics = null }) {
  const runners = Object.freeze({ release, unstuck });

  /**
   * Free the table from a token-control hold through a forced api.recovery.clearLock (RECOVERY.CLEAR_LOCK on the
   * host). It releases the movement lock even while its holder is connected, and also a lock left after a GM restore
   * closed the plan. The host posts the timeout notice to chat itself, so this speaks only when that post failed or
   * the host refused.
   */
  async function release(argumentsText) {
    if (argumentsText) { notify.usage('Use /release.'); return null; }
    const result = await api().recovery.clearLock({ announcement: 'timeout' });
    if (!result.ok) {
      notify.info(`Token control was not released (${result.code}). `
        + 'If the table is stuck, use /unstuck and then /release again.');
      return result;
    }
    if (result.data?.announcementPosted === false) notify.info(result.data.cleared
      ? 'Timeout completed. Active token control released.' : 'Timeout checked. No active token control was released.');
    return result;
  }

  /**
   * Free the table from a stuck processing state. A forced RECOVERY.CLEAR_BUSY makes CommandDispatcher abandon
   * whatever command holds execution, which lifts every client's processing blocker. Token control stays with its
   * holder until /release frees it.
   */
  async function unstuck(argumentsText) {
    if (argumentsText) { notify.usage('Use /unstuck.'); return null; }
    const busy = await api().recovery.clearBusy({ force: true });
    if (!busy.ok) { notify.info(`The busy state was not cleared (${busy.code}).`); return busy; }
    const abandoned = busy.data?.abandoned?.commandId;
    notify.info(abandoned ? `Busy state cleared. Abandoned ${abandoned}. Check the board for a half-finished action.`
      : 'Nothing was processing. Busy state refreshed on every client.');
    return busy;
  }

  return Object.freeze({
    /**
     * A matched command is handled privately instead of posting its raw line to chat. Foundry's chat input hands
     * ChatLog#processMessage serialized HTML such as `<p>/release</p>`, so the markup is dropped before matching.
     */
    onChatMessage(_chatLog, messageText) {
      const raw = String(messageText ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim();
      const lower = raw.toLowerCase();
      const match = Object.keys(CHAT_COMMANDS).find(command => lower === command || lower.startsWith(`${command} `));
      if (!match) return undefined;
      const command = CHAT_COMMANDS[match];
      if (!(Number(localUser()?.role) >= Number(CONST.USER_ROLES.ASSISTANT))) { notify.gmOnly(LABELS[command]); return false; }
      runners[command](raw.slice(match.length).trim()).catch(error => {
        diagnostics?.record?.(createDiagnostic({ sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.GATEWAY,
          commandId: LABELS[command], error }));
        notify.failed(LABELS[command]);
      });
      return false;
    }
  });
}
