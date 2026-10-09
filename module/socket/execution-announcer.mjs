/** @layer socket */
import { BLOCKER_ENGAGE_MS, executionMessage } from '../contracts/domains/execution.mjs';
import { recordDiagnostic } from '../contracts/protocol.mjs';

/** Tell every client when the host is busy running a command, so they show or hide the processing blocker. */
export class ExecutionAnnouncer {
  #view = null;
  #pending = false;
  #version = 0;

  constructor({ broadcast, wait, sessionId, userName, diagnostics }) {
    Object.assign(this, { broadcast, wait, sessionId, userName, diagnostics });
  }

  /**
   * CommandDispatcher calls this whenever what it is running changes. A new busy state is announced only after
   * BLOCKER_ENGAGE_MS, so quick commands don't flash the processing blocker. The end of one is always sent at once,
   * because another client may still show a blocker this announcer never announced.
   */
  onExecutionChanged(snapshot) {
    const version = ++this.#version;
    this.#pending = false;
    const owner = snapshot.blocks && snapshot.owner ? this.#owner(snapshot.owner) : null;
    const next = { hostSession: this.sessionId(), generation: snapshot.generation, owner };
    if (!owner || this.#view?.owner) {
      this.#send(next);
      return;
    }
    this.#view = Object.freeze({ ...next, owner: null });
    this.#pending = true;
    Promise.resolve().then(() => this.wait(BLOCKER_ENGAGE_MS)).then(() => {
      if (this.#version !== version) return;
      this.#pending = false;
      this.#send(next);
    }).catch(error => {
      if (this.#version === version) this.#pending = false;
      this.#record(error, 'execution-engage');
    });
  }

  view() {
    return this.#view ?? Object.freeze({ hostSession: this.sessionId(), generation: 0, owner: null });
  }

  pending() { return this.#pending; }

  /** Send the current busy state again, so a client that missed a message can correct its processing blocker. */
  async republish() {
    try { return await this.broadcast(executionMessage(this.view())) === true; }
    catch (error) { this.#record(error, 'execution-republish'); return false; }
  }

  #owner(owner) {
    const userName = String(this.userName(owner.userId) || 'A user').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128);
    return Object.freeze({ commandId: owner.commandId, lane: owner.lane, userName: userName || 'A user',
      since: owner.since, segment: owner.segment === true });
  }

  #send(view) {
    this.#view = Object.freeze(view);
    void this.republish();
  }

  #record(error, detail) {
    recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail });
  }
}
