/** @layer contracts */
import { canonicalJson, digest, isPlainObject as plainRecord } from '../lib/core/runtime.mjs';
import { RESULT_CODES } from './results.mjs';

/* -------------------------------------------- */
/*  Package identifiers                         */
/* -------------------------------------------- */
/** The system's package id, which is also the scope of its flags and settings. */
export const SYSTEM_ID = 'emblem-rpg';

/** The bounded roll-card visibility vocabulary carried by command requests. */
export const ROLL_MESSAGE_MODES = Object.freeze(['public', 'gm', 'blind', 'self']);

/** Translate Foundry's message and legacy roll modes at the client boundary. */
export function normalizeRollMessageMode(value) {
  const modes = { gmroll: 'gm', blindroll: 'blind', selfroll: 'self' };
  return ROLL_MESSAGE_MODES.includes(value) ? value : Object.hasOwn(modes, value) ? modes[value] : 'public';
}

/* -------------------------------------------- */
/*  Serializable message guards                 */
/* -------------------------------------------- */

export { plainRecord };

/** Whether a value is a non-empty control-character-free string within a maximum length. */
export function boundedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Whether a value is a finite number at or above zero. */
export function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Whether every key on a record appears in the allowed set. */
export function exactKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

/* -------------------------------------------- */
/*  Authority contract                          */
/* -------------------------------------------- */
/** Foundry-independent caller authority used at application boundaries. */
export const AUTHORITY_LEVELS = Object.freeze({
  NONE: 'none',
  PLAYER: 'player',
  TRUSTED: 'trusted',
  ASSISTANT: 'assistant',
  GAMEMASTER: 'gamemaster'
});

const SYSTEM_AUTHOR_LEVELS = new Set([AUTHORITY_LEVELS.ASSISTANT, AUTHORITY_LEVELS.GAMEMASTER]);

/** Whether a bounded authority projection carries system-wide document authoring rights. */
export function canAuthorSystemDocuments(caller) {
  return SYSTEM_AUTHOR_LEVELS.has(caller?.level);
}

/**
 * Whether the world pause freezes a user: it freezes Players and Trusted Players, but not GMs or Assistants.
 * Command admission in init/system.mjs and the client input checks both use this rule.
 */
export function pauseFreezesUser({ paused = false, isGm = false } = {}) {
  return paused === true && isGm !== true;
}

/* -------------------------------------------- */
/*  Host authority and command outcomes         */
/* -------------------------------------------- */

/** Foundry's Gamemaster role number: the only role that may host command execution. */
const GAMEMASTER_ROLE = 4;

/**
 * Host states used by CommandGateway. Several GMs, or several live pages of the same GM, prevent command execution.
 */
export const HOST_STATES = Object.freeze({
  READY: 'ready',
  NO_HOST: 'no-host',
  MULTIPLE_HOSTS: 'multiple-hosts',
  DUPLICATE_PAGES: 'duplicate-pages'
});

/**
 * CommandGateway's reply and status deadlines, and how long a gameplay command waits in CommandDispatcher for
 * maintenance to yield. When the reply deadline passes, the caller stops waiting but the host work isn't cancelled.
 * The deadline leaves room for long exchanges and progression. A host known to have left settles as unknown at once.
 */
export const COMMAND_TIMING = Object.freeze({ responseMs: 60000, statusMs: 5000, maintenanceYieldMs: 3000 });

/**
 * How releaseDisconnectedPlan (init/system.mjs) retries a disconnected player's plan release while execution is
 * busy. It waits on the pacing clock between a bounded number of attempts, so a running movement command can finish.
 */
export const PLAN_DISCONNECT_RELEASE = Object.freeze({ retryMs: 3000, attempts: 10 });

/**
 * How the startup sweeps in completeInterruptedTurns (init/system.mjs) retry while a ready-time reconciliation still
 * holds world execution. The sweeps release this host's own stale control lock and finish each interrupted turn.
 * The attempts are short because they run before gameplay is admitted, and no one is waiting on the
 * reconciliation they follow.
 */
export const STARTUP_RELEASE_RETRY = Object.freeze({ retryMs: 250, attempts: 20 });

/**
 * Whether a disconnected player's planning lock should be released. Only the exact lock they held when they left
 * is released, so a lock taken after a reconnect survives. The recovery snapshot separately checks the Actor plan's
 * controller and start time.
 * @param {object} input The standing lock, the lock seen when the user left, and the user who left.
 * @returns {boolean}
 */
export function planReleaseDueOnDisconnect({ lock = null, held = null, userId = '' } = {}) {
  if (!lock?.tokenUuid || !held?.tokenUuid) return false;
  if (String(lock.holderId ?? '') !== String(userId ?? '')) return false;
  return lock.tokenUuid === held.tokenUuid && Number(lock.acquiredAt) === Number(held.acquiredAt);
}

/**
 * HostPagePresence handshake, heartbeat and expiry intervals. Startup waits settleMs for other pages to answer
 * before recovery runs. A page that sends no heartbeat for heartbeatMs * silentBeats is taken to be gone.
 */
export const HOST_PRESENCE_TIMING = Object.freeze({ heartbeatMs: 3000, silentBeats: 4, settleMs: 1500 });

/** What the host can say about one request it was asked about. */
export const REQUEST_STATES = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  REFUSED: 'refused',
  EXPIRED: 'expired',
  NOT_FOUND: 'not-found'
});

/**
 * How long the host remembers requests. A settled result is kept so a repeated delivery returns it instead of
 * running again. Once the result is evicted, its id stays as a tombstone that refuses a repeat outright.
 */
export const COMMAND_REQUEST_MEMORY = Object.freeze({
  results: 500,
  resultAgeMs: 10 * 60 * 1000,
  tombstones: 5000,
  tombstoneAgeMs: 60 * 60 * 1000
});

/** The host page's startup order: recovery first, then ready-time maintenance, and only then gameplay. */
export const EXECUTION_LIFECYCLE = Object.freeze({
  STARTING: 'starting',
  RECOVERING: 'recovering',
  MAINTAINING: 'maintaining',
  READY: 'ready'
});

/**
 * Bind a request id to exactly what it asks for, so the same id reused for another command or payload is refused.
 * @param {string} commandId The command id.
 * @param {object} payload   The serializable payload.
 * @returns {string} A short stable digest.
 */
export function commandRequestDigest(commandId, payload) {
  return digest(canonicalJson([String(commandId ?? ''), payload ?? {}]));
}

/**
 * Work out CommandGateway's host from connected roles and live host pages. Exactly one GM on one page may execute
 * commands. Assistant GMs never host, and several GMs or duplicate GM pages turn execution off.
 * @param {Iterable<{id: string, role: number, active: boolean}>} users Every known user.
 * @param {string} localUserId This client's user id.
 * @param {{peerPages?: number}} [pages] How many other live pages of this client's own user are known.
 * @returns {{state: string, hostUserId: string, hostUserIds: string[], localIsHost: boolean}}
 */
export function resolveHostAuthority(users, localUserId = '', { peerPages = 0 } = {}) {
  const local = String(localUserId ?? '');
  const hostUserIds = [...(users ?? [])]
    .filter(user => user?.active === true && Number(user.role) === GAMEMASTER_ROLE)
    .map(user => String(user.id ?? ''))
    .filter(Boolean)
    .sort();
  const counted = hostUserIds.length === 1 ? HOST_STATES.READY
    : hostUserIds.length === 0 ? HOST_STATES.NO_HOST : HOST_STATES.MULTIPLE_HOSTS;
  const duplicated = counted === HOST_STATES.READY && hostUserIds[0] === local && Number(peerPages) > 0;
  const state = duplicated ? HOST_STATES.DUPLICATE_PAGES : counted;
  const hostUserId = state === HOST_STATES.READY ? hostUserIds[0] : '';
  return Object.freeze({
    state,
    hostUserId,
    hostUserIds: Object.freeze(hostUserIds),
    localIsHost: Boolean(hostUserId) && hostUserId === local
  });
}

/** The host states that refuse as an unsupported table of several hosts rather than as a table without one. */
const SEVERAL_HOST_STATES = Object.freeze([HOST_STATES.MULTIPLE_HOSTS, HOST_STATES.DUPLICATE_PAGES]);

/**
 * Return the CommandGateway refusal for a missing or ambiguous host, or an empty string when one host is eligible.
 * @param {{state: string}} host A resolved host authority.
 * @returns {string} A result code, or ''.
 */
export function hostRefusalCode(host) {
  if (host?.state === HOST_STATES.READY) return '';
  return SEVERAL_HOST_STATES.includes(host?.state) ? RESULT_CODES.SOCKET_MULTIPLE_HOSTS : RESULT_CODES.NO_ACTIVE_GM;
}

/* -------------------------------------------- */
/*  Composition                                 */
/* -------------------------------------------- */

/**
 * Stop start-up when init/system.mjs leaves out a port an engine, socket or api owner needs, naming the owner and
 * each missing port. Without this a wiring mistake would run with the feature silently switched off.
 * @param {string} owner The class or factory being built.
 * @param {object} ports Each required port by name, as the owner received it.
 */
export function requirePorts(owner, ports) {
  const missing = Object.keys(ports).filter(name => ports[name] === undefined || ports[name] === null);
  if (missing.length) throw new Error(`${owner} was built without ${missing.join(', ')}.`);
}

/* -------------------------------------------- */
/*  Diagnostic vocabulary                       */
/* -------------------------------------------- */
export const DIAGNOSTIC_SEVERITIES = Object.freeze({
  DEBUG: 'debug',
  ERROR: 'error',
  WARNING: 'warning'
});

export const DIAGNOSTIC_SOURCES = Object.freeze({
  DISPATCHER: 'dispatcher',
  GATEWAY: 'gateway',
  PRESENTATION: 'presentation',
  COMBAT_EXCHANGE: 'combat-exchange',
  CHARACTER: 'character',
  PROGRESSION: 'progression',
  ECONOMY: 'economy',
  OBJECTS: 'objects',
  DOWNTIME: 'downtime',
  ITEMS: 'items',
  EFFECTS: 'effects',
  ENCOUNTER: 'encounter',
  HEALTH: 'health',
  MOVEMENT: 'movement',
  TERRAIN: 'terrain',
  THREAT: 'threat',
  REPOSITORY: 'repository'
});

const MAX_MESSAGE_LENGTH = 512;

/* -------------------------------------------- */
/*  Diagnostic records                          */
/* -------------------------------------------- */

/** Build one frozen record of a failure the system refused or absorbed instead of surfacing. */
export function createDiagnostic({
  source,
  sourcePath = '',
  commandId = '',
  requestId = '',
  error = null,
  stack = '',
  severity = DIAGNOSTIC_SEVERITIES.ERROR,
  detail = '',
  recovery = null,
  notify = true
}) {
  const message = String(error?.message ?? error ?? detail ?? '').slice(0, MAX_MESSAGE_LENGTH);
  const origin = diagnosticOrigin(error, sourcePath);
  return Object.freeze({
    source: String(source ?? (origin.path || 'diagnostics')),
    sourcePath: origin.path,
    layer: origin.layer,
    subfolder: origin.subfolder,
    commandId: String(commandId ?? ''),
    requestId: String(requestId ?? ''),
    severity: Object.values(DIAGNOSTIC_SEVERITIES).includes(severity) ? severity : DIAGNOSTIC_SEVERITIES.ERROR,
    message: message || String(detail ?? '').slice(0, MAX_MESSAGE_LENGTH),
    detail: String(detail ?? '').slice(0, 2048),
    stack: String(error?.stack ?? stack).slice(0, 16000),
    recovery: Object.freeze({
      status: recovery?.status === 'restored' ? 'restored' : recovery?.status === 'incomplete' ? 'incomplete' : 'none',
      state: String(recovery?.state ?? '').slice(0, 160)
    }),
    notify: severity !== DIAGNOSTIC_SEVERITIES.DEBUG && notify !== false,
    error: error instanceof Error ? error : null
  });
}

/** Whether a value is a diagnostic record a sink may print. */
export function isDiagnostic(value) {
  return plainRecord(value)
    && typeof value.source === 'string' && value.source.length > 0
    && typeof value.message === 'string'
    && Object.values(DIAGNOSTIC_SEVERITIES).includes(value.severity);
}

/* -------------------------------------------- */
/*  Diagnostic transport                        */
/* -------------------------------------------- */

/** Copy diagnostic facts across a socket without carrying an Error prototype. */
export function diagnosticPayload(diagnostic) {
  if (!isDiagnostic(diagnostic)) return null;
  const { error, ...payload } = diagnostic;
  return Object.freeze(payload);
}

/**
 * The `{diagnostic}` field to spread into a result's data when a value is, or carries, a diagnostic record.
 * Anything else gives `{}`, so an ordinary result gains no field.
 */
export function diagnosticData(value) {
  const diagnostic = isDiagnostic(value) ? value : value?.diagnostic;
  return isDiagnostic(diagnostic) ? { diagnostic: diagnosticPayload(diagnostic) } : {};
}

/** Build and record a diagnostic, and return its socket-safe copy. It never throws, even if the sink is broken. */
export function recordDiagnostic(diagnostics, input) {
  try {
    const diagnostic = createDiagnostic(input);
    try { diagnostics?.record?.(diagnostic); } catch {}
    return diagnosticPayload(diagnostic);
  } catch {}
}

/**
 * The system file a diagnostic came from: the first system frame in the stack of the innermost error cause that
 * has one, or else the caller's sourcePath. The result also names that file's layer and subfolder.
 */
export function diagnosticOrigin(error, sourcePath = '') {
  let stackPath = '';
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth += 1) {
    stackPath = String(cause?.stack ?? '').replaceAll('\\', '/')
      .match(/emblem-rpg\/module\/([a-z][a-z0-9/-]*\.mjs)/i)?.[1] || stackPath;
  }
  const supplied = String(sourcePath ?? '').replaceAll('\\', '/').split('/module/').at(-1)
    .replace(/^module\//, '').replace(/[?#].*$/, '');
  const path = stackPath || supplied;
  const parts = path.split('/');
  return Object.freeze({ path, layer: parts.length > 1 ? parts[0] : 'engine',
    subfolder: parts.length > 2 ? parts[1] : '' });
}
