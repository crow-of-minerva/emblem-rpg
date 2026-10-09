/** @layer ui/apps/foundry */
import { DIAGNOSTIC_SOURCES, createDiagnostic } from '../../../contracts/protocol.mjs';

export const CHAT_COMMANDS = Object.freeze({ '/release': 'release', '/unstuck': 'unstuck' });
const LABELS = Object.freeze({ release: '/release', unstuck: '/unstuck' });

/**
 * The two GM recovery chat commands: /release and /unstuck. init/system.mjs builds them, and the chatMessage hook
 * in init/hooks.mjs calls onChatMessage. Chat only asks, through game.emblemRpg.api.recovery. The host checks the user
 * and carries out the command.
 */
export function createRecoveryChatCommands({ api, notify, localUser, diagnostics = null }) {
  const runners = Object.freeze({ release, unstuck });

  /**
   * Release the movement lock so the table can act again, even if the player holding it is still connected, or if
   * a GM restore left it behind. The host posts the chat notice itself; this only speaks if that post failed or the
   * host refused.
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
   * Clear a stuck "processing" state. The host client gives up on whatever action is running, which lifts the
   * processing block on every client. If that action had saved an undo record, the host client reloads and undoes
   * it on startup. The movement lock stays where it is until /release frees it.
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
