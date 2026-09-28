/** @layer socket */
import { isPlainObject } from '../lib/core/runtime.mjs';
import { ROLL_MESSAGE_MODES } from '../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Socket protocol                             */
/* -------------------------------------------- */
const SOCKET_PROTOCOL_VERSION = 2;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 16 * 1024;
const MAX_DEPTH = 12;
const MAX_COLLECTION_SIZE = 1000;
const MAX_IDENTIFIER_LENGTH = 128;

export const SOCKET_OPERATIONS = Object.freeze({
  EXECUTE_COMMAND: 'command.execute.v1',
  COMMAND_STATUS: 'command.status.v1',
  SEGMENT_STOP: 'command.segment-stop.v1',
  HOST_PRESENCE: 'host.presence.v1',
  UNIT_PRESENTATION: 'presentation.unit.v1'
});

/* -------------------------------------------- */
/*  Command envelopes                           */
/* -------------------------------------------- */
/**
 * Build the detached request that CommandGateway sends to CommandDispatcher.
 * @param {string} commandId   The command id.
 * @param {object} payload     Its serializable payload.
 * @param {string} requestId   The request id, kept for status queries.
 * @param {object} [options]   `transmitted: false` marks an envelope dispatched on the host itself, which skips only
 *                             the wire-size check. `hostSession` names the host page the caller addressed, so a
 *                             reloaded host can refuse a request meant for the page before it. `messageMode` is the
 *                             caller's roll message mode.
 * @returns {object} The frozen, detached envelope.
 */
export function createCommandEnvelope(commandId, payload, requestId,
  { transmitted = true, hostSession = '', messageMode = 'public' } = {}) {
  const envelope = {
    protocolVersion: SOCKET_PROTOCOL_VERSION,
    channel: 'commands',
    messageMode,
    id: String(requestId),
    commandId: String(commandId),
    payload: payload ?? {}
  };
  if (hostSession) envelope.hostSession = String(hostSession);
  if (!isCommandEnvelope(envelope, transmitted)) throw new TypeError('Invalid command envelope.');
  return deepFreeze(structuredClone(envelope));
}

/** Whether a value is a well-formed command envelope. `measured: false` skips the size check. */
export function isCommandEnvelope(value, measured = true) {
  if (!isPlainObject(value)) return false;
  if (value.protocolVersion !== SOCKET_PROTOCOL_VERSION
    || value.channel !== 'commands'
    || !boundedIdentifier(value.id, MAX_IDENTIFIER_LENGTH)
    || !boundedIdentifier(value.commandId, MAX_IDENTIFIER_LENGTH)
    || ('hostSession' in value && !boundedIdentifier(value.hostSession, MAX_IDENTIFIER_LENGTH))
    || ('messageMode' in value && !ROLL_MESSAGE_MODES.includes(value.messageMode))
    || !isPlainObject(value.payload)
    || !serializable(value.payload, 0, new Set())) return false;
  if (!measured) return true;
  try {
    return JSON.stringify(value).length <= MAX_ENVELOPE_BYTES;
  } catch {
    return false;
  }
}

/* -------------------------------------------- */
/*  Status requests                             */
/* -------------------------------------------- */

/** Validate the request-id-only payload accepted by CommandGateway's status handler. */
export function isCommandStatusRequest(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'requestId')) return false;
  return !('requestId' in value) || boundedIdentifier(value.requestId, MAX_IDENTIFIER_LENGTH);
}

/** Validate the host-session payload for CommandGateway.requestSegmentStop. */
export function isSegmentStopRequest(value) {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).some(key => key !== 'hostSession')) return false;
  return !('hostSession' in value) || boundedIdentifier(value.hostSession, MAX_IDENTIFIER_LENGTH);
}

/* -------------------------------------------- */
/*  Host page presence                          */
/* -------------------------------------------- */

/** Message kinds exchanged by HostPagePresence to detect duplicate host tabs. */
export const HOST_PRESENCE_KINDS = Object.freeze({
  HELLO: 'hello',
  PRESENT: 'present',
  HEARTBEAT: 'heartbeat',
  GOODBYE: 'goodbye'
});

/**
 * Build a HostPagePresence handshake or heartbeat message.
 * @param {string} kind One of {@link HOST_PRESENCE_KINDS}.
 * @param {string} session The sending page's session.
 * @param {string} [to] For `present` alone, the session of the page whose `hello` it answers.
 * @returns {object} The frozen message.
 */
export function createHostPresenceMessage(kind, session, to = '') {
  const message = kind === HOST_PRESENCE_KINDS.PRESENT ? { kind, session, to } : { kind, session };
  if (!isHostPresenceMessage(message)) throw new TypeError('Invalid host presence message.');
  return Object.freeze(message);
}

/** Validate the session identifiers before HostPagePresence accepts a message. */
export function isHostPresenceMessage(value) {
  if (!isPlainObject(value) || !Object.values(HOST_PRESENCE_KINDS).includes(value.kind)) return false;
  const answer = value.kind === HOST_PRESENCE_KINDS.PRESENT;
  const keys = answer ? ['kind', 'session', 'to'] : ['kind', 'session'];
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  return boundedIdentifier(value.session, MAX_IDENTIFIER_LENGTH)
    && (!answer || boundedIdentifier(value.to, MAX_IDENTIFIER_LENGTH));
}

function boundedIdentifier(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function serializable(value, depth, ancestors) {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_STRING_LENGTH;
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const values = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : null;
  if (!values || values.length > MAX_COLLECTION_SIZE) {
    ancestors.delete(value);
    return false;
  }
  const valid = values.every(entry => serializable(entry, depth + 1, ancestors));
  ancestors.delete(value);
  return valid;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
