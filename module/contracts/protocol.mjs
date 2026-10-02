/** @layer contracts */
import { canonicalJson, digest, isPlainObject as plainRecord } from '../lib/core/runtime.mjs';
import { RESULT_CODES } from './results.mjs';

/* -------------------------------------------- */
/*  Package identifiers                         */
/* -------------------------------------------- */
/** The system's package id, which is also the scope of its flags and settings. */
export const SYSTEM_ID = 'emblem-rpg';

/** Who can see a roll card: everyone, GMs only, GMs only with the roller kept blind, or only the roller. */
export const ROLL_MESSAGE_MODES = Object.freeze(['public', 'gm', 'blind', 'self']);

/** Turn a Foundry message mode or an older roll mode name (gmroll, blindroll, selfroll) into one of these. */
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

/** Whether every key on a record appears in the allowed set. It doesn't check that every allowed key is present. */
export function exactKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

/* -------------------------------------------- */
/*  Authority contract                          */
/* -------------------------------------------- */
/** The caller's Foundry role, as a plain value the engine can check without Foundry. */
export const AUTHORITY_LEVELS = Object.freeze({
  NONE: 'none',
  PLAYER: 'player',
  TRUSTED: 'trusted',
  ASSISTANT: 'assistant',
  GAMEMASTER: 'gamemaster'
});

const SYSTEM_AUTHOR_LEVELS = new Set([AUTHORITY_LEVELS.ASSISTANT, AUTHORITY_LEVELS.GAMEMASTER]);

/** Whether the caller is a GM or assistant GM, who may edit any document. */
export function canAuthorSystemDocuments(caller) {
  return SYSTEM_AUTHOR_LEVELS.has(caller?.level);
}

/**
 * Whether the world pause freezes a user: it freezes Players and Trusted Players, but not GMs or Assistants.
 * The host client's command checks and the client input checks both use this rule.
 */
export function pauseFreezesUser({ paused = false, isGm = false } = {}) {
  return paused === true && isGm !== true;
}

/* -------------------------------------------- */
/*  Host authority and command outcomes         */
/* -------------------------------------------- */

/** Foundry's Gamemaster role number: the only role whose client may run commands as host. */
const GAMEMASTER_ROLE = 4;

/**
 * Host states used by CommandGateway. With several GMs connected, or one GM with several tabs open, no client runs
 * commands.
 */
export const HOST_STATES = Object.freeze({
  READY: 'ready',
  NO_HOST: 'no-host',
  MULTIPLE_HOSTS: 'multiple-hosts',
  DUPLICATE_PAGES: 'duplicate-pages'
});

/**
 * CommandGateway's reply and status deadlines, and how long a gameplay command waits in CommandDispatcher for
 * upkeep work to finish. When the reply deadline passes, the caller stops waiting but the host work isn't cancelled.
 * The deadline leaves room for long exchanges and progression. If the host client is known to have left, the caller
 * is told the outcome is unknown at once.
 */
export const COMMAND_TIMING = Object.freeze({ responseMs: 60000, statusMs: 5000, maintenanceYieldMs: 3000 });

/**
 * Retry timing for releasing the movement lock of a player who disconnected mid-move, while another command is
 * running, so a movement command already under way can finish first.
 */
export const PLAN_DISCONNECT_RELEASE = Object.freeze({ retryMs: 3000, attempts: 10 });

/**
 * Retry timing for start-up work on the host client (clearing a leftover movement lock, finishing turns cut off by
 * a reload, migrating world data) while upkeep started at load is still running. The waits are short because
 * gameplay hasn't started yet.
 */
export const STARTUP_RELEASE_RETRY = Object.freeze({ retryMs: 250, attempts: 20 });

/**
 * Whether a disconnected player's movement lock should be released. Only the exact lock they held when they left
 * is released, so a lock taken after a reconnect survives. The recovery step separately checks who started the
 * actor's planned move and when.
 * @param {object} input The standing lock, the lock seen when the user left, and the user who left.
 * @returns {boolean}
 */
export function planReleaseDueOnDisconnect({ lock = null, held = null, userId = '' } = {}) {
  if (!lock?.tokenUuid || !held?.tokenUuid) return false;
  if (String(lock.holderId ?? '') !== String(userId ?? '')) return false;
  return lock.tokenUuid === held.tokenUuid && Number(lock.acquiredAt) === Number(held.acquiredAt);
}

/**
 * How often the GM's open tabs check in with each other. At start-up a tab waits settleMs for other tabs to answer
 * before recovery runs. A tab that stays silent for heartbeatMs * silentBeats counts as closed.
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
 * How long the host remembers requests. A finished result is kept so a repeated delivery returns it instead of
 * running again. Once the result is evicted, its id stays as a tombstone that refuses a repeat outright.
 */
export const COMMAND_REQUEST_MEMORY = Object.freeze({
  results: 500,
  resultAgeMs: 10 * 60 * 1000,
  tombstones: 5000,
  tombstoneAgeMs: 60 * 60 * 1000
});

/** The host client's start-up order: recovery first, then upkeep, and only then gameplay. */
export const EXECUTION_LIFECYCLE = Object.freeze({
  STARTING: 'starting',
  RECOVERING: 'recovering',
  MAINTAINING: 'maintaining',
  READY: 'ready'
});

/**
 * Tie a request id to exactly what it asks for, so the same id reused for another command or payload is refused.
 * @param {string} commandId The command id.
 * @param {object} payload   The serializable payload.
 * @returns {string} A short stable digest.
 */
export function commandRequestDigest(commandId, payload) {
  return digest(canonicalJson([String(commandId ?? ''), payload ?? {}]));
}

/**
 * Work out which client hosts commands, from the connected users and the GM's open tabs. Exactly one GM with one tab
 * open may run commands. Assistant GMs never host, and several GMs or several tabs of the GM turn commands off.
 * @param {Iterable<{id: string, role: number, active: boolean}>} users Every known user.
 * @param {string} localUserId This client's user id.
 * @param {{peerPages?: number}} [pages] How many other open tabs of this client's own user are known.
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
 * Throw at start-up when init/system.mjs builds a class without a service it needs, naming the class and each
 * missing service. Without this a wiring mistake would run with the feature silently switched off.
 * @param {string} owner The class or factory being built.
 * @param {object} ports Each required service by name, as the class received it.
 */
export function requirePorts(owner, ports) {
  const missing = Object.keys(ports).filter(name => ports[name] === undefined || ports[name] === null);
  if (missing.length) throw new Error(`${owner} was built without ${missing.join(', ')}.`);
}

/* -------------------------------------------- */
/*  Diagnostic vocabulary                       */
/* -------------------------------------------- */
/** How serious a logged error is. */
export const DIAGNOSTIC_SEVERITIES = Object.freeze({
  DEBUG: 'debug',
  ERROR: 'error',
  WARNING: 'warning'
});

/** Which part of the system logged an error. */
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

/** Build a log record for an error the system caught and handled instead of throwing. */
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

/** Copy a diagnostic record for sending over a socket, without its Error object. */
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
