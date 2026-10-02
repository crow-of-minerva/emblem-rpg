/** @layer contracts/domains */
import { COMMAND_LANES } from '../commands.mjs';
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';

export const EXECUTION_PRESENTATION_KIND = 'execution';
/** How long a command must run before ExecutionAnnouncer shows the "please wait" overlay. */
export const BLOCKER_ENGAGE_MS = 150;
const VIEW_KEYS = Object.freeze(['hostSession', 'generation', 'owner']);
const OWNER_KEYS = Object.freeze(['commandId', 'lane', 'userName', 'since', 'segment']);

/**
 * Build the message ExecutionAnnouncer sends to show or hide the "please wait" overlay on every client. It carries
 * display state, not permission to run commands.
 */
export function executionMessage({ hostSession, generation, owner }) {
  const message = { kind: EXECUTION_PRESENTATION_KIND, hostSession, generation,
    owner: owner === null ? null : Object.freeze({ ...owner }) };
  if (!isExecutionMessage(message)) throw new TypeError('Invalid execution view.');
  return Object.freeze(message);
}

/** Check the host's running-command status returned through CommandGateway; a broadcast adds a kind. */
export function isExecutionView(value) {
  return plainRecord(value) && exactKeys(value, VIEW_KEYS) && VIEW_KEYS.every(key => Object.hasOwn(value, key))
    && boundedText(value.hostSession, 128) && Number.isSafeInteger(value.generation) && value.generation >= 0
    && (value.owner === null || isExecutionOwner(value.owner));
}

/** Check an overlay message before the client updates its "please wait" overlay. */
export function isExecutionMessage(value) {
  if (!plainRecord(value) || value.kind !== EXECUTION_PRESENTATION_KIND) return false;
  const { kind, ...view } = value;
  return isExecutionView(view);
}

function isExecutionOwner(owner) {
  return plainRecord(owner) && exactKeys(owner, OWNER_KEYS) && OWNER_KEYS.every(key => Object.hasOwn(owner, key))
    && boundedText(owner.commandId, 128) && Object.values(COMMAND_LANES).includes(owner.lane)
    && boundedText(owner.userName, 128) && Number.isFinite(owner.since) && owner.since >= 0
    && typeof owner.segment === 'boolean';
}
