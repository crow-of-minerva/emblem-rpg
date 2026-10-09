/** @layer foundry/adapters/services */
import { createDiagnostic, diagnosticOrigin, DIAGNOSTIC_SEVERITIES, isDiagnostic } from '../../../contracts/protocol.mjs';
import { SYSTEM_TITLE } from '../../../config/constants.mjs';

/* -------------------------------------------- */
/*  Diagnostics output                          */
/* -------------------------------------------- */

/**
 * Write each diagnostic to the console and, unless it's marked `notify: false`, show a short error notification
 * that points there. The notification never carries the details, and repeats are dropped: the same error object
 * shows once, and the same message at most once a second. Nothing is thrown back to the caller.
 */
export class FoundryDiagnostics {
  static #targets = new WeakMap();

  constructor({
    output = globalThis.console,
    notifications = () => globalThis.ui?.notifications ?? null
  } = {}) {
    this.output = output;
    this.notifications = notifications;
  }

  record(diagnostic) {
    if (!isDiagnostic(diagnostic)) return false;
    try {
      const label = [diagnostic.sourcePath || diagnostic.source, diagnostic.commandId, diagnostic.requestId]
        .filter(Boolean).join(' | ');
      const line = `${SYSTEM_TITLE} | ${label}: ${diagnostic.message}`;
      const method = diagnostic.severity === DIAGNOSTIC_SEVERITIES.DEBUG ? 'debug'
        : diagnostic.severity === DIAGNOSTIC_SEVERITIES.ERROR ? 'error' : 'warn';
      this.output?.[method]?.(line, diagnostic.error ?? diagnostic.stack ?? '', {
        operation: diagnostic.detail, source: diagnostic.sourcePath, recovery: diagnostic.recovery,
        commandId: diagnostic.commandId, requestId: diagnostic.requestId
      });
    } catch {}
    try { if (diagnostic.notify !== false) this.#notify(diagnostic); } catch {}
    return true;
  }

  #notify(diagnostic) {
    const target = this.notifications();
    if (!target) return;
    let history = FoundryDiagnostics.#targets.get(target);
    if (!history) {
      history = { errors: new WeakSet(), notices: new Map() };
      FoundryDiagnostics.#targets.set(target, history);
    }
    const restored = diagnostic.recovery?.status === 'restored' && diagnostic.recovery.state;
    let repeated = false;
    for (let error = diagnostic.error, depth = 0; error instanceof Error && depth < 8; error = error.cause, depth += 1) {
      repeated ||= !restored && history.errors.has(error);
      history.errors.add(error);
    }
    const key = [diagnostic.sourcePath, diagnostic.commandId, diagnostic.requestId,
      diagnostic.message, diagnostic.recovery?.status].join('|');
    const now = Date.now();
    repeated ||= now - (history.notices.get(key) ?? -Infinity) < 1000;
    history.notices.set(key, now);
    for (const [id, time] of history.notices) if (now - time >= 1000) history.notices.delete(id);
    if (repeated) return;
    const name = diagnostic.layer === 'ui' ? 'UI' : diagnostic.layer === 'api' ? 'API'
      : `${(diagnostic.layer || 'engine')[0].toUpperCase()}${(diagnostic.layer || 'engine').slice(1)}`;
    const layer = `${name}${diagnostic.subfolder ? ` /${diagnostic.subfolder}` : ''}`;
    const message = restored
      ? `${layer} layer error: ${diagnostic.recovery.state} restored. See console for more details`
      : `${layer} layer error. See console for more details`;
    target.error?.(message, { console: false });
  }
}

/* -------------------------------------------- */
/*  Report helpers                              */
/* -------------------------------------------- */

/** Record a caught failure as a diagnostic, with the error kept for the console, and return without throwing. */
export function reportFoundryError(sourcePath, error, detail = '', recovery = null, notify = true) {
  try {
    new FoundryDiagnostics().record(createDiagnostic({ sourcePath, error, detail, recovery, notify }));
  } catch {}
}

/**
 * Record a failure from a lookup that is allowed to fail. An expected failure goes to debug output only. An
 * unexpected one is reported as an error, with a notification.
 */
export function reportFoundryProbe(sourcePath, error, detail = '', expected = true) {
  try {
    new FoundryDiagnostics().record(createDiagnostic({ sourcePath, error, detail,
      severity: expected ? DIAGNOSTIC_SEVERITIES.DEBUG : DIAGNOSTIC_SEVERITIES.ERROR, notify: !expected }));
  } catch {}
}

/** Record an expected refusal as a console warning, with no notification. */
export function reportFoundryNotice(sourcePath, message, detail = '') {
  try {
    new FoundryDiagnostics().record(createDiagnostic({ sourcePath, error: message, detail,
      severity: DIAGNOSTIC_SEVERITIES.WARNING, notify: false }));
  } catch {}
}

/**
 * Show `message` as a warning notification for invalid input and log the details to the console. An unexpected
 * error is reported as a failure instead.
 */
export function reportFoundryValidation(sourcePath, error, message, expected = true) {
  if (!expected) return reportFoundryError(sourcePath, error, message);
  try {
    new FoundryDiagnostics().record(createDiagnostic({ sourcePath, error, detail: message,
      severity: DIAGNOSTIC_SEVERITIES.WARNING, notify: false }));
    notifyFoundry(sourcePath, 'warn', message);
  } catch {}
}

/**
 * Show a Foundry notification at `level`. An 'error' is recorded with reportFoundryError instead: a console line
 * and the short error notification.
 */
export function notifyFoundry(sourcePath, level, message) {
  if (level === 'error') return reportFoundryError(sourcePath, message);
  try { globalThis.ui?.notifications?.[level]?.(message); }
  catch (error) {
    reportFoundryError(sourcePath, error, 'Display feedback');
  }
}

/**
 * Report uncaught errors and promise rejections that come from this system's files, without cancelling the event.
 * Installed once from init/hooks.mjs.
 */
export function observeFoundryErrors({ events = globalThis, hooks = globalThis.Hooks } = {}) {
  const report = (error, detail = '') => {
    try { if (diagnosticOrigin(error).path) reportFoundryError('', error, detail); } catch {}
  };
  const rejection = event => report(event.reason, 'Unhandled promise rejection');
  const failure = event => report(event.error, 'Unhandled script error');
  hooks?.on?.('error', (location, error) => report(error, String(location)));
  events.addEventListener?.('unhandledrejection', rejection);
  events.addEventListener?.('error', failure);
}
