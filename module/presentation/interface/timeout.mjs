/** @layer presentation/interface */
import { recordDiagnostic } from '../../contracts/protocol.mjs';
import { escapeHtml } from '../../lib/dom/html.mjs';

/**
 * Announce the table-management timeout the GM calls with `/release`.
 * `engine/recovery/commands.mjs` posts this from the host after RECOVERY.CLEAR_LOCK settles, so the table sees
 * who called time and whether any control was actually released. The chat command shows its own notice when the
 * announcement could not be posted.
 */
export function createTimeoutPresenter({ chat, diagnostics = null }) {
  return Object.freeze({
    /** Post the chat notice. If it can't be posted, record the error and return null. */
    async announce({ callerName = 'GM', cleared = false } = {}) {
      const caller = escapeHtml(String(callerName ?? ''));
      const message = cleared
        ? `Timeout called by ${caller}. Active token control released.`
        : `Timeout called by ${caller}. No active token control was released.`;
      try {
        return await chat.create({ actorUuid: '', alias: 'Emblem RPG',
          content: '<div class="emblem-chat-notice"><strong>Emblem RPG</strong> ' + message + '</div>' });
      } catch (error) {
        recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'timeout-announcement' });
        return null;
      }
    }
  });
}
