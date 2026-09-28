/** @layer socket */
import { isPlainObject } from '../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Payload firewall                            */
/* -------------------------------------------- */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_KEY_LENGTH = 128;
const KEY_OPERATOR_PREFIX = /^(?:-=|==)/;

/**
 * Validate payload paths before CommandGateway dispatches the command.
 * Reject prototype access and empty or oversized segments in dotted and nested keys.
 * Treat serialized data operators as values, not paths. The same checks apply to GM requests.
 */
export function checkPayload(payload, { operatorIdentifier = null } = {}) {
  if (payload === undefined || payload === null) return { ok: true };
  if (!isBranch(payload, operatorIdentifier)) {
    return { ok: false, reason: 'payload must be a plain object' };
  }
  for (const rawPath of collectPaths(payload, operatorIdentifier)) {
    const refusal = pathRefusal(rawPath);
    if (refusal) return { ok: false, reason: `${refusal}: "${rawPath}"` };
  }
  return { ok: true };
}

/** Flatten nested and dotted keys into the paths checked by checkPayload. */
function collectPaths(data, operatorIdentifier = null, prefix = '', out = []) {
  const entries = Array.isArray(data) ? data.map((entry, index) => [String(index), entry]) : Object.entries(data);
  for (const [key, value] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isBranch(value, operatorIdentifier) || Array.isArray(value)) collectPaths(value, operatorIdentifier, path, out);
    else out.push(path);
  }
  return out;
}

function isBranch(value, operatorIdentifier) {
  if (!isPlainObject(value)) return false;
  return operatorIdentifier === null || operatorIdentifier === undefined
    || !Object.prototype.hasOwnProperty.call(value, operatorIdentifier);
}

function pathRefusal(path) {
  for (const raw of String(path).split('.')) {
    const segment = raw.replace(KEY_OPERATOR_PREFIX, '');
    if (!segment) return 'empty path segment';
    if (segment.length > MAX_KEY_LENGTH) return 'path segment too long';
    if (FORBIDDEN_SEGMENTS.has(segment)) return 'forbidden path segment';
  }
  return null;
}
