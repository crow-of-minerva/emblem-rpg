/** @layer foundry/adapters/services */
import { isExecutionMessage, isExecutionView } from '../../../contracts/domains/execution.mjs';
import { SETTLE_BARRIER_TIMING } from '../../../contracts/domains/combat.mjs';
import { HOST_STATES, recordDiagnostic } from '../../../contracts/protocol.mjs';
import { readSettleBarrier } from '../../../game/combat/objectives.mjs';

export const PROCESSING_INPUTS = Object.freeze({
  GAMEPLAY: 'gameplay', SAVE: 'save', ADMIN: 'admin', CHAT: 'chat', CAMERA: 'camera', INSPECT: 'inspect'
});
const BLOCKED_INPUTS = new Set([PROCESSING_INPUTS.GAMEPLAY, PROCESSING_INPUTS.SAVE, PROCESSING_INPUTS.ADMIN]);

/**
 * Tracks whether the host client is busy running a command (`owner` names it). While it is, this client refuses
 * gameplay, sheet-save and admin input and shows a busy cursor. The host's busy/idle messages (apply) and
 * syncWithHost keep it up to date.
 */
export class ProcessingBlocker {
  #view = Object.freeze({ hostSession: '', generation: 0, owner: null });
  #listeners = new Set();
  #retiredSessions = new Set();
  #starting = true;
  #sync = 0;

  constructor({ host = () => globalThis, isHost, diagnostics = null }) {
    Object.assign(this, { host, isHost, diagnostics });
    this.#paintStartup();
  }

  snapshot() { return this.#view; }
  engaged() { return this.#view.owner !== null; }

  /**
   * Whether this client is still loading. installProcessingInputGuards silently refuses every local input while
   * it is true. Only that input guard reads it, so the system's own startup commands and writes still go through.
   */
  starting() { return this.#starting; }

  /** Called once by the runtime's ready() in init/system.mjs when startup finishes, whatever its outcome. */
  finishStartup() {
    if (!this.#starting) return;
    this.#starting = false;
    this.#paintStartup();
  }

  /** Subscribe to busy/idle changes. The caller runs the returned unsubscribe when its interface closes. */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Take a busy/idle update from an authenticated host message. An older update from the same host tab is ignored,
   * and once a new host tab sends one, updates from the old tab are ignored.
   */
  apply(message) {
    if (!isExecutionMessage(message)) return false;
    const { kind, ...view } = message;
    return this.#applyView(view);
  }

  /**
   * Ask the host for its current busy state after a late join or reconnect. With no ready host, the busy state is
   * cleared. A failed or unreadable reply changes nothing.
   */
  async syncWithHost({ host, status, localView }) {
    const sync = ++this.#sync;
    const before = host();
    if (before.state !== HOST_STATES.READY) {
      this.#set({ ...this.#view, owner: null });
      return true;
    }
    try {
      const apply = view => {
        if (sync !== this.#sync || host().hostUserId !== before.hostUserId) return false;
        return this.#applyView(view);
      };
      if (before.localIsHost) return apply(localView());
      const reply = await status(response => apply(response?.data?.execution?.blocker));
      return apply(reply?.data?.execution?.blocker);
    } catch (error) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: 'processing-status' });
      return false;
    }
  }

  /**
   * Whether local input of this kind may go ahead. Gameplay, save and admin input is refused while the host is busy,
   * silently, since the busy cursor already shows why.
   */
  admitInput(kind) {
    return !this.engaged() || !BLOCKED_INPUTS.has(kind);
  }

  /**
   * Whether a native document write may go ahead (admitNativeWrite in services/authority.mjs). The host's own writes
   * always pass, though its interface still checks admitInput before submitting. Other clients' writes are refused
   * like saves while the host is busy.
   */
  admitNativeWrite() {
    return this.isHost() || this.admitInput(PROCESSING_INPUTS.SAVE);
  }

  /** The stylesheet shows the hourglass over the whole page while the body carries this class. */
  #paintStartup() {
    this.host()?.document?.body?.classList?.toggle('emblem-starting', this.#starting);
  }

  #applyView(view) {
    if (!isExecutionView(view) || this.#retiredSessions.has(view.hostSession)) return false;
    const previous = this.#view;
    if (view.hostSession === previous.hostSession && view.generation < previous.generation) return false;
    if (previous.hostSession && previous.hostSession !== view.hostSession) {
      this.#retiredSessions.add(previous.hostSession);
      if (this.#retiredSessions.size > 32) this.#retiredSessions.delete(this.#retiredSessions.values().next().value);
    }
    this.#set(view);
    return true;
  }

  #set(view) {
    this.#view = Object.freeze({ ...view, owner: view.owner ? Object.freeze({ ...view.owner }) : null });
    const body = this.host()?.document?.body;
    body?.classList?.toggle('emblem-busy', this.engaged());
    if (this.engaged()) body?.setAttribute?.('aria-busy', 'true');
    else body?.removeAttribute?.('aria-busy');
    for (const listener of this.#listeners) {
      try { listener(this.#view); }
      catch (error) { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: 'processing-view' }); }
    }
  }
}

/**
 * Wait until `busy()` has stayed false for `stableMs`, for api.board.awaitSettled (init/system.mjs). Returns false at
 * the deadline or as soon as `abort` returns true.
 */
export async function waitForSettledProcessing({ busy, wait, now = () => Date.now(), diagnostics }, {
  stableMs = SETTLE_BARRIER_TIMING.stableMs, timeoutMs = SETTLE_BARRIER_TIMING.timeoutMs,
  pollMs = SETTLE_BARRIER_TIMING.pollMs, abort = null, label = ''
} = {}) {
  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  let quietSince = null;
  while (now() < deadline) {
    if (abort?.() === true) return false;
    const reading = readSettleBarrier({ busy: busy(), now: now(), quietSince, deadline, stableMs });
    if (reading.settled) return true;
    quietSince = reading.quietSince;
    await wait(Math.max(1, Number(pollMs) || 1));
  }
  recordDiagnostic(diagnostics, { sourcePath: import.meta.url, detail: `processing-settle-timeout:${label}` });
  return false;
}
