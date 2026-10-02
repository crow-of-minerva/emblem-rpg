/** @layer engine */
import { DIAGNOSTIC_SEVERITIES, DIAGNOSTIC_SOURCES, createDiagnostic } from '../contracts/protocol.mjs';

/** Show an animation or message on every client. If that fails, log it and keep the game change. */
export async function presentSafely(services, message) {
  try {
    return await services.presentation.broadcast(message) !== false;
  } catch (error) {
    recordAbsorbed(services, error, String(message?.beat ?? message?.kind ?? ''));
    return false;
  }
}

/**
 * Pass the authenticated command requester to Foundry roll-card writers so they use that player's roll mode.
 * Return null when no requester exists, leaving the card public and host-authored.
 */
export function cardRequester(context) {
  if (context.requester) return context.requester;
  const userId = String(context.userId ?? '');
  if (!userId) return null;
  return Object.freeze({ userId, messageMode: String(context.messageMode ?? 'public') });
}

/** The users a notice about a command is for: the authenticated requester alone, or nobody when there is none. */
export function requesterAudience(context) {
  const userId = String(context.userId ?? '');
  return userId ? [userId] : [];
}

/** Run a follow-up step, such as publishing an event, whose failure is only recorded and never fails the command. */
export function runSafely(services, callback, detail = '') {
  try { callback(); return true; } catch (error) { recordAbsorbed(services, error, detail); return false; }
}

/** Await a follow-up step whose failure is only recorded and never fails the command. */
export async function runSafelyAsync(services, callback, detail = '') {
  try { await callback(); return true; } catch (error) { recordAbsorbed(services, error, detail); return false; }
}

/** Record a failure the game logic absorbed. `source` names the domain and defaults to combat exchange. */
export function recordAbsorbed(services, error, detail, source = DIAGNOSTIC_SOURCES.COMBAT_EXCHANGE) {
  return services.diagnostics?.record?.(createDiagnostic({ sourcePath: import.meta.url,
    source,
    severity: DIAGNOSTIC_SEVERITIES.WARNING,
    detail,
    error
  })) === true;
}
