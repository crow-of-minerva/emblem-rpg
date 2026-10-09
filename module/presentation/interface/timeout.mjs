/** @layer presentation/interface */
import { recordDiagnostic } from '../../contracts/protocol.mjs';
import { escapeHtml } from '../../lib/dom/html.mjs';

/**
 * Post a chat notice saying who called `/release` and whether any token control was freed. The host posts it from
 * engine/recovery/commands.mjs once the locks are cleared. The chat command shows its own notice if this can't be
 * posted.
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
