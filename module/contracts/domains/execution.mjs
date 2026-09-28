/** @layer contracts/domains */
import { COMMAND_LANES } from '../commands.mjs';
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';

export const EXECUTION_PRESENTATION_KIND = 'execution';
/** How long a command must hold execution before ExecutionAnnouncer shows the processing blocker. */
export const BLOCKER_ENGAGE_MS = 150;
const VIEW_KEYS = Object.freeze(['hostSession', 'generation', 'owner']);
const OWNER_KEYS = Object.freeze(['commandId', 'lane', 'userName', 'since', 'segment']);

/**
 * Build the processing-blocker message broadcast by ExecutionAnnouncer. It carries display state, not permission
 * to execute commands.
 */
export function executionMessage({ hostSession, generation, owner }) {
  const message = { kind: EXECUTION_PRESENTATION_KIND, hostSession, generation,
    owner: owner === null ? null : Object.freeze({ ...owner }) };
  if (!isExecutionMessage(message)) throw new TypeError('Invalid execution view.');
  return Object.freeze(message);
}

/** Validate the execution status returned through CommandGateway. A broadcast has the same fields plus a kind. */
export function isExecutionView(value) {
  return plainRecord(value) && exactKeys(value, VIEW_KEYS) && VIEW_KEYS.every(key => Object.hasOwn(value, key))
    && boundedText(value.hostSession, 128) && Number.isSafeInteger(value.generation) && value.generation >= 0
    && (value.owner === null || isExecutionOwner(value.owner));
}

/** Validate execution broadcasts before the presentation layer updates its processing blocker. */
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
