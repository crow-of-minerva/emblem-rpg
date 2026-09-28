/** @layer socket */

/* -------------------------------------------- */
/*  Sliding-window limiter                      */
/* -------------------------------------------- */
const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_CALLS = 180;
const DEFAULT_MAX_CALLS_PER_OPERATION = 60;
const DEFAULT_MAX_TRACKED_CALLERS = 128;

/**
 * Limit how many commands each non-GM user can send to the host, checked by CommandGateway before dispatch.
 * Each caller has one window for all commands and one per command. A reconnect clears the caller's counters.
 * CommandDispatcher still checks authority on its own.
 */
export class SocketRateLimiter {
  constructor({
    windowMs = DEFAULT_WINDOW_MS,
    maxCalls = DEFAULT_MAX_CALLS,
    maxCallsPerOperation = DEFAULT_MAX_CALLS_PER_OPERATION,
    maxTrackedCallers = DEFAULT_MAX_TRACKED_CALLERS,
    now = Date.now
  } = {}) {
    this.windowMs = Math.max(1, Number(windowMs) || DEFAULT_WINDOW_MS);
    this.maxCalls = Math.max(1, Math.floor(Number(maxCalls) || DEFAULT_MAX_CALLS));
    this.maxCallsPerOperation = Math.max(1, Math.floor(Number(maxCallsPerOperation) || DEFAULT_MAX_CALLS_PER_OPERATION));
    this.maxTrackedCallers = Math.max(1, Math.floor(Number(maxTrackedCallers) || DEFAULT_MAX_TRACKED_CALLERS));
    this.now = typeof now === 'function' ? now : Date.now;
    this.callers = new Map();
  }

  /**
   * Count one inbound request. Returns `{ok: true}`, or the blocked scope, the wait before a retry, and whether
   * this refusal started the block (CommandGateway records a diagnostic only then).
   */
  consume(callerId, operation) {
    const callerKey = typeof callerId === 'string' && callerId ? callerId : '(unidentified)';
    const operationKey = typeof operation === 'string' && operation ? operation : '(invalid)';
    const now = Number(this.now());
    const cutoff = now - this.windowMs;
    const entry = this.#caller(callerKey, now);

    if (entry.callerBlockedUntil > now) return blocked('caller', entry.callerBlockedUntil - now, false);
    entry.callerBlockedUntil = 0;
    const operationBlockedUntil = entry.operationBlocks.get(operationKey) ?? 0;
    if (operationBlockedUntil > now) return blocked('operation', operationBlockedUntil - now, false);
    entry.operationBlocks.delete(operationKey);

    trim(entry.all, cutoff);
    for (const [key, timestamps] of entry.operations) {
      trim(timestamps, cutoff);
      if (timestamps.length === 0) {
        entry.operations.delete(key);
        entry.operationBlocks.delete(key);
      }
    }
    if (entry.all.length >= this.maxCalls) {
      entry.callerBlockedUntil = entry.all[0] + this.windowMs;
      return blocked('caller', entry.callerBlockedUntil - now, true);
    }
    let perOperation = entry.operations.get(operationKey);
    if (!perOperation) {
      perOperation = [];
      entry.operations.set(operationKey, perOperation);
    }
    trim(perOperation, cutoff);
    if (perOperation.length >= this.maxCallsPerOperation) {
      const blockedUntil = perOperation[0] + this.windowMs;
      entry.operationBlocks.set(operationKey, blockedUntil);
      return blocked('operation', blockedUntil - now, true);
    }
    entry.all.push(now);
    perOperation.push(now);
    return { ok: true };
  }

  /** Clear a disconnected caller's counters when CommandGateway forgets that caller. */
  clear(callerId) {
    this.callers.delete(callerId);
  }

  #caller(callerId, now) {
    let entry = this.callers.get(callerId);
    if (!entry) {
      while (this.callers.size >= this.maxTrackedCallers) {
        this.callers.delete(this.callers.keys().next().value);
      }
      entry = { all: [], operations: new Map(), callerBlockedUntil: 0, operationBlocks: new Map(), touchedAt: now };
      this.callers.set(callerId, entry);
      return entry;
    }
    this.callers.delete(callerId);
    this.callers.set(callerId, entry);
    entry.touchedAt = now;
    return entry;
  }
}

function trim(timestamps, cutoff) {
  let first = 0;
  while (first < timestamps.length && timestamps[first] <= cutoff) first += 1;
  if (first > 0) timestamps.splice(0, first);
}

function blocked(scope, retryAfterMs, report) {
  return { ok: false, scope, retryAfterMs: Math.max(1, retryAfterMs), report };
}
