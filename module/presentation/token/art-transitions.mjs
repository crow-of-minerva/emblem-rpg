/** @layer presentation/token */
import { recordDiagnostic } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Transition coordination                    */
/* -------------------------------------------- */

/**
 * Timing and ordering for token art changes, with no access to Foundry documents. The token art writer in
 * foundry/adapters/document-writes/tokens.mjs does the writes and uses this class for three things: a temporary
 * conditional art swap (On Attack, On Crit, On Evade and the like) and its timed revert, one queue of texture writes
 * per token so they land in order, and a debounced art refresh per actor. init/system.mjs builds it.
 */
export class TokenArtTransitionCoordinator {
  /**
   * @param {object} [options]
   * @param {object} [options.diagnostics]
   * @param {Function} [options.schedule] Runs a callback after a delay and returns a handle. In play it uses the
   *   host's pacing clock, so a hidden host still reverts shared art on time.
   * @param {Function} [options.cancelScheduled] Cancels a handle schedule returned.
   * @param {Function} [options.wait] Resolves after a delay, on the same clock.
   */
  constructor({ diagnostics = null,
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancelScheduled = handle => clearTimeout(handle),
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  } = {}) {
    this.diagnostics = diagnostics;
    this.schedule = schedule;
    this.cancelScheduled = cancelScheduled;
    this.wait = wait;
    this.writeQueues = new Map();
    this.transientLocks = new Map();
    this.refreshTimers = new Map();
  }

  /** Cancel a transient lock's revert and watchdog. */
  #clearLockTimers(lock) {
    if (lock?.timer) this.cancelScheduled(lock.timer);
    if (lock?.watchdog) this.cancelScheduled(lock.watchdog);
  }

  /** Swap fade, hold and revert fade for a conditional swap, in milliseconds. Options override the defaults. */
  timing(condition, options = {}) {
    const defaults = condition === 'On Crit' ? [1500, 560]
      : condition === 'On Attack' ? [800, 450]
        : condition === 'On Evade' ? [500, 280] : [1000, 300];
    return {
      swapFadeMs: Number.isFinite(options.swapFadeMs) ? options.swapFadeMs : 180,
      durationMs: Number.isFinite(options.durationMs) ? options.durationMs : defaults[0],
      revertFadeMs: Number.isFinite(options.revertFadeMs) ? options.revertFadeMs : defaults[1]
    };
  }

  /**
   * Hold a conditional swap for one actor and schedule its revert, unless the caller reverts it by hand. A
   * 60-second watchdog reverts a swap nobody released.
   */
  beginTransient(key, { snapshots, timing, manualRevert, revert }) {
    this.clearTransient(key);
    const lock = { timer: null, watchdog: null, snapshots, due: null, revertFadeMs: timing.revertFadeMs };
    const finish = () => {
      if (this.transientLocks.get(key) !== lock) return;
      this.transientLocks.delete(key);
      this.#clearLockTimers(lock);
      void revert(lock);
    };
    if (!manualRevert) {
      lock.due = Date.now() + timing.durationMs;
      lock.timer = this.schedule(finish, timing.durationMs);
    }
    lock.watchdog = this.schedule(finish, 60000);
    this.transientLocks.set(key, lock);
    return lock;
  }

  transient(key) {
    return this.transientLocks.get(key) ?? null;
  }

  /** Drop the actor's held swap and its timers, and return it so the caller can restore the art. */
  clearTransient(key) {
    const lock = this.transientLocks.get(key) ?? null;
    this.#clearLockTimers(lock);
    this.transientLocks.delete(key);
    return lock;
  }

  /** Wait until a timed swap has reverted and faded back. A swap held for a manual revert returns at once. */
  async waitForTransient(key) {
    const lock = this.transient(key);
    if (!lock?.timer) return;
    const remaining = Math.max(0, (lock.due ?? 0) - Date.now()) + (lock.revertFadeMs ?? 0);
    await this.wait(remaining);
  }

  /** Run one art refresh per key, `delayMs` after the last request. */
  scheduleRefresh(key, refresh, delayMs = 50) {
    const current = this.refreshTimers.get(key);
    if (current) clearTimeout(current);
    this.refreshTimers.set(key, setTimeout(() => {
      this.refreshTimers.delete(key);
      void refresh();
    }, delayMs));
  }

  /** The texture state the newest queued write for this token will save, or null when none is queued. */
  desiredWrite(key) {
    return this.writeQueues.get(key)?.desired ?? null;
  }

  /** Queue a write so one token's texture writes run one at a time, in order. A failed write doesn't block the next. */
  enqueueWrite(key, desired, write) {
    if (!key) return Promise.resolve().then(write);
    let entry = this.writeQueues.get(key);
    if (!entry) {
      entry = { chain: Promise.resolve(), count: 0, desired };
      this.writeQueues.set(key, entry);
    }
    entry.desired = desired;
    entry.count += 1;
    const result = entry.chain.then(write, write);
    entry.chain = result.catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'enqueueWrite' }); });
    return result.finally(() => {
      entry.count -= 1;
      if (entry.count <= 0 && this.writeQueues.get(key) === entry) this.writeQueues.delete(key);
    });
  }

  /** Resolves once every write queued so far for this token has run. */
  settleWrite(key) {
    return this.writeQueues.get(key)?.chain ?? Promise.resolve();
  }
}
