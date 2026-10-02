/** @layer engine */
import { commandLane } from '../contracts/commands.mjs';
import { commandRequestDigest, requirePorts } from '../contracts/protocol.mjs';
import { RESULT_CODES, refuse } from '../contracts/results.mjs';

/* -------------------------------------------- */
/*  Maintenance scheduler                       */
/* -------------------------------------------- */

/**
 * Queue the clean-up jobs Foundry hooks submit (commands that bring derived data such as modifiers and door walls
 * back in line) and run them through CommandDispatcher. Identical submissions share one run, and work submitted
 * during a run gets one follow-up run. The queue runs once startup allows maintenance and the command slot is free,
 * behind any waiting gameplay. A hook's submission never makes the command that triggered it wait.
 */
export class MaintenanceScheduler {
  #dispatcher;
  #userId;
  #admits;
  #entries = new Map();
  #queue = [];
  #draining = null;
  #sequence = 0;
  #idle = [];

  /**
   * @param {object} ports
   * @param {object} ports.dispatcher The host's command dispatcher.
   * @param {Function} ports.userId The host user's id, which the jobs run as.
   * @param {Function} ports.admits Whether the startup lifecycle allows a command lane now.
   */
  constructor({ dispatcher, userId, admits }) {
    requirePorts('MaintenanceScheduler', { dispatcher, userId, admits });
    this.#dispatcher = dispatcher;
    this.#userId = userId;
    this.#admits = admits;
  }

  /* -------------------------------------------- */
  /*  Submission                                  */
  /* -------------------------------------------- */

  /**
   * Queue one maintenance or startup command. Each run dispatches under a request id the scheduler makes.
   * @param {string} commandId The command.
   * @param {object} [payload] Its payload. Identical payloads share a run.
   * @returns {Promise<object>} The result of the run that covered this submission.
   */
  submit(commandId, payload = {}) {
    const id = String(commandId ?? '');
    const body = payload ?? {};
    return new Promise(resolve => {
      const key = commandRequestDigest(id, body);
      const entry = this.#entries.get(key);
      if (entry?.running) entry.followers.push(resolve);
      else if (entry) entry.waiting.push(resolve);
      else {
        this.#entries.set(key, { key, commandId: id, payload: body, waiting: [resolve], followers: [],
          running: false });
        this.#queue.push(key);
      }
      void this.drain();
    });
  }

  /**
   * Run queued jobs while the command slot stays free. init/system.mjs calls this every time the slot is released
   * and during startup.
   */
  drain() {
    if (!this.#draining) {
      this.#draining = this.#pump().finally(() => {
        this.#draining = null;
        if (this.#queue.length && this.#runnable()) void this.drain();
        else if (!this.#queue.length) this.#settleIdle();
      });
    }
    return this.#draining;
  }

  /** Resolves once nothing is queued or running. */
  idle() {
    if (!this.#queue.length && !this.#draining) return Promise.resolve();
    return new Promise(resolve => this.#idle.push(resolve));
  }

  /**
   * While the Enemy AI (or another driver) holds the command slot, run queued jobs between its actions.
   * @param {Function} run Runs one command inside the driver's slot and resolves with its result.
   * @returns {Promise<void>}
   */
  async drainInto(run) {
    while (this.#queue.length) {
      const entry = this.#entries.get(this.#queue[0]);
      if (!this.#admits(commandLane(entry.commandId))) break;
      this.#queue.shift();
      if (await this.#runEntry(entry, run)) break;
    }
    if (!this.#queue.length && !this.#draining) this.#settleIdle();
  }

  /* -------------------------------------------- */
  /*  Draining                                    */
  /* -------------------------------------------- */

  async #pump() {
    const dispatch = (commandId, payload, requestId) =>
      this.#dispatcher.dispatch({ id: requestId, commandId, payload }, this.#userId());
    while (this.#runnable()) {
      if (await this.#runEntry(this.#entries.get(this.#queue.shift()), dispatch)) return;
    }
  }

  /** Run one queued entry through `run`. A busy refusal puts it back at the front of the queue and returns true. */
  async #runEntry(entry, run) {
    const waiting = entry.waiting.splice(0);
    entry.running = true;
    let result;
    try {
      result = await run(entry.commandId, entry.payload, this.#requestId(entry.commandId));
    } catch (error) {
      result = refuse(RESULT_CODES.COMMAND_FAILED, { message: String(error?.message ?? error) });
    } finally {
      entry.running = false;
    }
    if (result?.code === RESULT_CODES.COMMAND_EXECUTION_BUSY) {
      entry.waiting.unshift(...waiting, ...entry.followers.splice(0));
      this.#queue.unshift(entry.key);
      return true;
    }
    for (const resolve of waiting) resolve(result);
    if (entry.followers.length) {
      entry.waiting = entry.followers.splice(0);
      this.#queue.push(entry.key);
    } else this.#entries.delete(entry.key);
    return false;
  }

  /** Whether the next queued job may start: the command slot is free and startup allows its lane. */
  #runnable() {
    if (!this.#queue.length || !this.#dispatcher.executionFree()) return false;
    return this.#admits(commandLane(this.#entries.get(this.#queue[0]).commandId));
  }

  #settleIdle() {
    for (const resolve of this.#idle.splice(0)) resolve();
  }

  #requestId(commandId) {
    return `hook:maintenance:${commandId}:${++this.#sequence}`;
  }
}
