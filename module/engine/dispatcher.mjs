/** @layer engine */
import { COMMAND_LANES, commandLane, commandBlocks } from '../contracts/commands.mjs';
import {
  COMMAND_REQUEST_MEMORY,
  COMMAND_TIMING,
  DIAGNOSTIC_SOURCES,
  REQUEST_STATES,
  commandRequestDigest,
  createDiagnostic,
  diagnosticPayload,
  requirePorts
} from '../contracts/protocol.mjs';
import { RESULT_CODES, accept, refuse } from '../contracts/results.mjs';

/* -------------------------------------------- */
/*  Command dispatch                            */
/* -------------------------------------------- */
const MAX_RESOURCE_KEY_LENGTH = 256;
const MAX_SEGMENT_LABEL_LENGTH = 64;

/** If one of these is running, a gameplay command waits briefly instead of being refused as busy. */
const YIELDING_LANES = new Set([COMMAND_LANES.MAINTENANCE, COMMAND_LANES.STARTUP, COMMAND_LANES.RECOVERY]);

/**
 * Runs commands on the host client one at a time. A command keeps the command slot until its handler finishes;
 * read-only (inspect) commands run without taking it. A command that finds the slot taken is refused as busy,
 * except that gameplay commands wait briefly behind maintenance, startup or recovery work. A driver on the host,
 * such as the Enemy AI, can keep the slot across several actions; the code calls that a segment. Results are
 * remembered by user, request id and payload, so a command delivered twice runs once.
 */
export class CommandDispatcher {
  #definitions = new Map();
  #requests = new Map();
  #tombstones = new Map();
  #owner = null;
  #waiters = [];
  #generation = 0;
  #tokens = 0;
  #segments = 0;
  #diagnostics;
  #operations;
  #executor;
  #admission;
  #onSettled;
  #onExecutionChanged;
  #segmentBoundary;
  #segmentTeardown;
  #timing;
  #memory;
  #now;
  #wait;
  #openSegments = new Set();

  /**
   * Everything but `timing`, `memory` and `now` comes from init/system.mjs: `operations` is OperationRecovery (the
   * undo log), `executor` answers whether this page is the host client, `admission` applies the startup and pause
   * checks, `wait` is the presentation delay, and the four callbacks report slot changes and run clean-up work
   * while a segment holds the slot.
   */
  constructor({ diagnostics, operations, executor, admission, onSettled, onExecutionChanged, segmentBoundary,
    segmentTeardown, wait, timing = COMMAND_TIMING, memory = COMMAND_REQUEST_MEMORY, now = () => Date.now() }) {
    requirePorts('CommandDispatcher', { diagnostics, operations, executor, admission, onSettled,
      onExecutionChanged, segmentBoundary, segmentTeardown, wait });
    this.#diagnostics = diagnostics;
    this.#operations = operations;
    this.#executor = executor;
    this.#admission = admission;
    this.#onSettled = onSettled;
    this.#onExecutionChanged = onExecutionChanged;
    this.#segmentBoundary = segmentBoundary;
    this.#segmentTeardown = segmentTeardown;
    this.#timing = timing;
    this.#memory = memory;
    this.#now = now;
    this.#wait = wait;
  }

  register(commandId, definition) {
    if (this.#definitions.has(commandId)) throw new Error(`Command already registered: ${commandId}`);
    if (typeof definition?.authorize !== 'function' || typeof definition.handler !== 'function') {
      throw new Error(`Command ${commandId} must declare both an authorize slot and a handler.`);
    }
    this.#definitions.set(commandId, definition);
  }

  registerContribution(definitions) {
    for (const definition of definitions) this.register(definition.id, definition);
  }

  /* -------------------------------------------- */
  /*  Command slot                                */
  /* -------------------------------------------- */

  /** Whether a command or segment holds the command slot right now. */
  executionHeld() {
    return this.#owner !== null;
  }

  /** Whether the command slot is free and no gameplay command is waiting for it. */
  executionFree() {
    return this.#owner === null && this.#waiters.length === 0;
  }

  /**
   * Whether nothing is running: the slot is free, or a segment holds it between actions. api.board.awaitSettled
   * reads this, so a driver such as the Enemy AI can wait between its own actions without waiting on itself.
   */
  executionIdle() {
    return !this.#owner || (this.#owner.segment && (!this.#owner.run || this.#owner.run.settled));
  }

  /**
   * Whether the running command has taken any of these resource keys. It only reads. init/system.mjs hands it to
   * the encounter lifecycle as `encounterRunning`, which asks whether a command is writing a scene.
   */
  resourcesBusy(keys) {
    const run = this.#owner?.run;
    return Boolean(run) && !run.settled && keys.some(key => run.keys.has(key));
  }

  /** A frozen copy of who holds the slot, for host status replies and every client's "processing" blocker. */
  executionSnapshot() {
    const owner = this.#owner;
    return Object.freeze({
      generation: this.#generation,
      blocks: owner?.blocks === true,
      owner: owner ? Object.freeze({
        commandId: owner.segment ? owner.commandId : owner.run?.commandId ?? owner.commandId,
        lane: owner.lane,
        userId: owner.userId,
        since: owner.since,
        segment: owner.segment
      }) : null
    });
  }

  /**
   * Free the slot from a command that never finishes, for the forced recovery.clear-busy in
   * engine/recovery/commands.mjs. The abandoned run is marked finished, so resource claims through its own context
   * refuse, and so do child commands that pass its context as `scope`. A child command called without a scope is
   * not checked: if the old handler resumes, it joins whichever command holds the slot then (see invokeWithin).
   * A segment's next action is refused as released. Nothing stops writes the old handler makes directly, and its
   * undo record is left open on purpose: `recorded` tells the caller the host must reload so startup restores it.
   * @returns {{commandId: string, lane: string, recorded: boolean}|null} The command that held the slot, or null
   *   when it was free.
   */
  abandonExecution() {
    const owner = this.#owner;
    if (!owner) return null;
    const recorded = owner.run?.operation?.abandon() === true;
    const abandoned = Object.freeze({ commandId: owner.run?.commandId ?? owner.commandId, lane: owner.lane, recorded });
    this.#diagnostics.record(createDiagnostic({ sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.DISPATCHER,
      commandId: abandoned.commandId, error: new Error(`command.execution-abandoned:${abandoned.commandId}`),
      detail: 'execution-abandoned' }));
    this.#release(owner);
    return abandoned;
  }

  /**
   * When the host page unloads, leave the running command's undo record for the next page load to apply (called
   * from the page-unload handlers in init/system.mjs). A closing page may keep running the handler for a moment, so
   * its run ends as `abandoned` instead of starting an undo, and the next page's startup
   * `OperationRecovery.restoreUnfinished()` applies the record.
   * @returns {boolean} Whether the abandoned command still has a saved undo record.
   */
  abandonOperation() {
    return this.#owner?.run?.operation?.abandon() === true;
  }

  /* -------------------------------------------- */
  /*  Requests                                    */
  /* -------------------------------------------- */

  /**
   * Run a CommandGateway request. `userId` is the sender id socketlib takes from the Foundry server, so a player
   * cannot forge it.
   */
  async dispatch(envelope, userId) {
    const requestId = String(envelope?.id ?? '');
    const commandId = String(envelope?.commandId ?? '');
    if (!requestId || !commandId || !userId) return refuse(RESULT_CODES.COMMAND_FAILED);
    const payload = envelope.payload ?? {};
    const requestKey = `${userId}:${requestId}`;
    const fingerprint = commandRequestDigest(commandId, payload);
    this.#forget();

    const known = this.#requests.get(requestKey);
    if (known) {
      return known.fingerprint === fingerprint
        ? known.promise : refuse(RESULT_CODES.COMMAND_REQUEST_CONFLICT, { requestId, commandId });
    }
    if (this.#tombstones.has(requestKey)) return refuse(RESULT_CODES.COMMAND_REQUEST_EXPIRED, { requestId, commandId });

    const messageMode = envelope.messageMode ?? 'public';
    const requester = Object.freeze({ userId, messageMode });
    const context = { requestId, commandId, payload, userId, messageMode, requester };
    const entry = { fingerprint, commandId, settled: false, settledAt: 0, result: null, promise: null };
    entry.promise = Promise.resolve()
      .then(() => this.#admit(context))
      .catch(error => this.#fail(context, error))
      .then(result => {
        Object.assign(entry, { settled: true, settledAt: this.#now(), result });
        this.#forget();
        return result;
      });
    this.#requests.set(requestKey, entry);
    return entry.promise;
  }

  /** What became of one of this caller's own requests. Another caller's request id is never revealed. */
  requestStatus(userId, requestId) {
    this.#forget();
    const id = String(requestId ?? '');
    const key = `${userId}:${id}`;
    const entry = this.#requests.get(key);
    if (entry && !entry.settled) {
      return Object.freeze({ requestId: id, commandId: entry.commandId, state: REQUEST_STATES.PENDING });
    }
    if (entry) {
      return Object.freeze({ requestId: id, commandId: entry.commandId, result: entry.result,
        state: entry.result?.ok === true ? REQUEST_STATES.COMPLETED : REQUEST_STATES.REFUSED });
    }
    if (this.#tombstones.has(key)) return Object.freeze({ requestId: id, state: REQUEST_STATES.EXPIRED });
    return Object.freeze({ requestId: id, state: REQUEST_STATES.NOT_FOUND });
  }

  /**
   * Run a child command inside the running command, sharing its undo record and resource keys, without a second
   * request. `scope` is the parent's handler context. Refuses when no command is running, or when `scope` carries
   * an `execution` token that is not the running command's. A call without a scope (init/system.mjs defaults it to
   * `{}`) skips the token check and joins whichever command is running. The child's authorize check runs with
   * `userId`; init/system.mjs always passes the host GM's id, so the parent's own authorization is the real check.
   */
  async invokeWithin(commandId, payload, userId, requestId, scope = {}) {
    const parent = scope ?? {};
    const id = String(commandId ?? '');
    const definition = this.#definitions.get(id);
    if (!definition || !userId) return refuse(RESULT_CODES.UNKNOWN_COMMAND);
    const owner = this.#owner;
    const run = owner?.run;
    if (!run || run.settled || (parent.execution && parent.execution !== owner.token)) {
      return refuse(RESULT_CODES.COMMAND_CHILD_OUTSIDE_EXECUTION, { commandId: id });
    }
    if (!owner.blocks && commandBlocks(id, payload)) {
      owner.blocks = true;
      this.#generation += 1;
      this.#announceExecution();
    }
    const requester = parent.requester ?? run.requester
      ?? Object.freeze({ userId, messageMode: 'public' });
    return this.#invoke(definition, {
      requester, messageMode: requester.messageMode,
      requestId: String(requestId ?? ''), commandId: id, payload: payload ?? {}, userId,
      lane: COMMAND_LANES.CHILD, within: true, execution: owner.token,
      operation: run.operation?.joined() ?? null,
      resourceKeys: parent.resourceKeys ?? Object.freeze([...run.keys]),
      claimResources: parent.claimResources ?? (keys => this.#claim(run, keys))
    });
  }

  /* -------------------------------------------- */
  /*  Root requests                               */
  /* -------------------------------------------- */

  /**
   * Run a root CommandGateway request: check startup and authorization, take the command slot, then authorize
   * again now that nothing else can run. The slot is released whatever the handler returns.
   */
  async #admit(context) {
    const definition = this.#definitions.get(context.commandId);
    if (!definition) return refuse(RESULT_CODES.UNKNOWN_COMMAND);
    if (!this.#executor()) return refuse(RESULT_CODES.NO_ACTIVE_GM);
    const lane = commandLane(context.commandId);
    if (lane === COMMAND_LANES.CHILD) {
      return refuse(RESULT_CODES.COMMAND_CHILD_OUTSIDE_EXECUTION, { commandId: context.commandId });
    }
    const admitted = { ...context, lane };
    const barred = this.#admission(admitted, definition);
    if (barred) return barred;
    const refusal = await definition.authorize(admitted);
    if (refusal) return refusal;
    if (lane === COMMAND_LANES.INSPECT) return this.#invoke(definition, { ...admitted, resourceKeys: Object.freeze([]) });

    const owner = await this.#acquire(admitted, lane);
    if (!owner) return this.#busy(lane);
    try {
      return await this.#runUnder(owner, definition, admitted);
    } finally {
      this.#release(owner);
    }
  }

  /**
   * Run the command while it holds the slot, then keep its writes if it succeeded or undo them if it failed. Its
   * resource keys are worked out fresh here. A root command is authorized a second time here. A segment action or
   * a clean-up job inside a segment arrives with `authorized` set, because its caller already checked it while
   * holding the same slot.
   */
  async #runUnder(owner, definition, context, { authorized = false } = {}) {
    const run = this.#beginRun(owner, context);
    run.operation = this.#operations.open({
      id: context.requestId, label: context.commandId, userId: context.userId
    });
    try {
      const resourceKeys = await concurrencyKeysFor(definition, context);
      for (const key of resourceKeys) run.keys.add(key);
      const result = await this.#invoke(definition, {
        ...context, execution: owner.token, operation: run.operation, resourceKeys: Object.freeze(resourceKeys),
        claimResources: keys => this.#claim(run, keys)
      }, { authorized });
      return await this.#settleOperation(run.operation, result);
    } catch (error) {
      return await this.#settleOperation(run.operation, this.#fail(context, error));
    } finally {
      run.settled = true;
    }
  }

  /**
   * Keep the run's writes when its handler succeeded, and undo them otherwise. A commit that cannot be saved counts
   * as a failure, and `data.restored` tells the caller whether the undo worked. engine/recovery/operations.mjs has
   * already reported anything it could not undo. An abandoned run passes the handler's result through unchanged.
   */
  async #settleOperation(operation, result) {
    const settled = await operation.settle(result?.ok === true);
    if (settled.outcome === 'commit-failed') {
      return refuse(RESULT_CODES.COMMAND_FAILED,
        { reasonCode: RESULT_CODES.OPERATION_COMMIT_FAILED, restored: settled.restored });
    }
    if (settled.outcome !== 'restored') return result;
    return refuse(result?.code ?? RESULT_CODES.COMMAND_FAILED,
      { ...(result?.data ?? {}), restored: settled.restored });
  }

  /**
   * Run a definition after checking again that this client is still the host and that startup allows the command,
   * then authorize it unless the caller already did while holding the slot.
   */
  async #invoke(definition, context, { authorized = false } = {}) {
    try {
      if (!this.#executor()) return refuse(RESULT_CODES.NO_ACTIVE_GM);
      const barred = this.#admission(context, definition);
      if (barred) return barred;
      return await (authorized ? definition.handler(context) : invokeCommand(definition, context));
    } catch (error) {
      return this.#fail(context, error);
    }
  }

  /**
   * Take the slot now, or resolve null when it is taken. Only gameplay commands may wait, for up to
   * `maintenanceYieldMs`, and only behind maintenance, startup or recovery work (#yielding).
   */
  #acquire(context, lane) {
    const owner = this.#take(context, lane);
    if (owner || lane !== COMMAND_LANES.GAMEPLAY || !this.#yielding()) return Promise.resolve(owner);
    return new Promise(resolve => {
      const waiter = { context, lane, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(entry => entry !== waiter);
        resolve(null);
      }, this.#timing.maintenanceYieldMs);
      this.#waiters.push(waiter);
    });
  }

  /** Check and take the slot in one synchronous step, so two requests can never both get it. */
  #take(context, lane) {
    if (this.#owner || (lane !== COMMAND_LANES.GAMEPLAY && this.#waiters.length)) return null;
    this.#generation += 1;
    this.#owner = {
      token: `execution:${++this.#tokens}`, lane, commandId: context.commandId, userId: context.userId,
      since: this.#now(), segment: context.segment === true, run: null,
      blocks: context.segment === true || commandBlocks(context.commandId, context.payload)
    };
    this.#announceExecution();
    return this.#owner;
  }

  /** Whether a gameplay command may wait for what holds the slot: maintenance, startup or recovery, never a segment. */
  #yielding() {
    return Boolean(this.#owner) && !this.#owner.segment && YIELDING_LANES.has(this.#owner.lane);
  }

  /** Free the slot, hand it straight to the first waiting gameplay command, and report the release. */
  #release(owner) {
    if (this.#owner !== owner) return;
    if (owner.run) owner.run.settled = true;
    const settled = Object.freeze({ commandId: owner.commandId, lane: owner.lane,
      resourceKeys: [...(owner.run?.keys ?? [])] });
    this.#owner = null;
    this.#generation += 1;
    while (!this.#owner && this.#waiters.length) {
      const waiter = this.#waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(this.#take(waiter.context, waiter.lane));
    }
    // The others only waited because maintenance work held the slot. Behind another gameplay command they are
    // refused as busy, as a new request would be.
    if (this.#owner?.lane === COMMAND_LANES.GAMEPLAY) {
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    if (!this.#owner) this.#announceExecution();
    try {
      this.#onSettled(settled);
    } catch (error) {
      this.#diagnostics.record(createDiagnostic({ sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.DISPATCHER,
        commandId: owner.commandId, error, detail: 'execution-released' }));
    }
  }

  /**
   * Report the slot change through the `onExecutionChanged` callback. A failure there is only recorded, so it never
   * changes who holds the slot.
   */
  #announceExecution() {
    try { this.#onExecutionChanged(this.executionSnapshot()); }
    catch (error) {
      this.#diagnostics.record(createDiagnostic({ sourcePath: import.meta.url,
        source: DIAGNOSTIC_SOURCES.DISPATCHER, error, detail: 'execution-view' }));
    }
  }

  #busy(lane) {
    const holder = this.#owner;
    const data = holder ? { holder: { commandId: holder.run?.commandId ?? holder.commandId, lane: holder.lane } } : {};
    return refuse(lane === COMMAND_LANES.RECOVERY ? RESULT_CODES.RECOVERY_BUSY : RESULT_CODES.COMMAND_EXECUTION_BUSY, data);
  }

  /** Start one handler's run in the slot. A segment starts a fresh run, with fresh keys, for every action. */
  #beginRun(owner, context) {
    if (owner.run) owner.run.settled = true;
    owner.run = { commandId: context.commandId, requester: context.requester, keys: new Set(), settled: false,
      operation: null };
    return owner.run;
  }

  /**
   * Add keys to the running handler's resource keys. Refuses a malformed key or a run that has finished. The keys
   * lock nothing, because holding the slot already keeps other commands out.
   */
  #claim(run, keys) {
    if (run.settled || this.#owner?.run !== run) return false;
    const wanted = [...new Set((keys ?? []).map(key => String(key ?? '')))];
    if (wanted.some(key => !validResourceKey(key))) return false;
    for (const key of wanted) run.keys.add(key);
    return true;
  }

  /* -------------------------------------------- */
  /*  Segments                                    */
  /* -------------------------------------------- */

  /**
   * Let a driver on the host client, such as the Enemy AI (api.protocol), keep the slot across several actions so
   * players can't act in between. Each action is authorized and gets its resource keys afresh. Other gameplay stays
   * out until the segment is released or closed, and both wait for a running action to finish first.
   * @param {{userId: string, label?: string}} intent The host user and a short label for status views.
   * @returns {Promise<object>} `command.segment-opened` carrying `data.segment`, or the refusal.
   */
  async openSegment({ userId, label = 'segment' } = {}) {
    const name = `segment:${String(label || 'segment').slice(0, MAX_SEGMENT_LABEL_LENGTH)}`;
    const context = { requestId: `${name}:${++this.#segments}`, commandId: name, payload: {},
      userId: String(userId ?? ''), lane: COMMAND_LANES.GAMEPLAY, segment: true };
    const owner = await this.#acquireSegment(context);
    if (!owner?.token) return owner;
    return accept(RESULT_CODES.COMMAND_SEGMENT_OPENED, { segment: this.#segment(context, owner) });
  }

  /**
   * Mark open segments as asked to stop, once CommandGateway has checked the request came from a GM or Assistant.
   * The driver reads stopRequested between actions and closes its handle. This method does not
   * cancel an action, release the slot or prevent further driver calls.
   * @param {{userId: string}} intent The authenticated user asking for the stop.
   * @returns {object} `command.segment-stop-requested` with how many segments were marked, or the refusal.
   */
  requestSegmentStop({ userId } = {}) {
    const requester = String(userId ?? '');
    if (!requester) return refuse(RESULT_CODES.COMMAND_FAILED);
    if (!this.#executor()) return refuse(RESULT_CODES.NO_ACTIVE_GM);
    const open = [...this.#openSegments].filter(state => !state.closed);
    if (!open.length) return refuse(RESULT_CODES.COMMAND_SEGMENT_NOT_OPEN);
    const alreadyRequested = open.every(state => state.stopRequested);
    for (const state of open) state.stopRequested = true;
    return accept(RESULT_CODES.COMMAND_SEGMENT_STOP_REQUESTED, { segments: open.length, alreadyRequested });
  }

  /** Take the slot for a segment, or return the refusal. */
  async #acquireSegment(context) {
    if (!context.userId) return refuse(RESULT_CODES.COMMAND_FAILED);
    if (!this.#executor()) return refuse(RESULT_CODES.NO_ACTIVE_GM);
    const barred = this.#admission(context, null);
    if (barred) return barred;
    const owner = await this.#acquire(context, COMMAND_LANES.GAMEPLAY);
    if (!owner) return this.#busy(COMMAND_LANES.GAMEPLAY);
    return owner;
  }

  /** Build the segment handle api.protocol gives the driver: run actions, wait, release, take back, close. */
  #segment(context, initialOwner) {
    const state = { owner: initialOwner, closed: false, lost: false, active: null, actions: 0,
      stopRequested: false, openedAt: initialOwner.since };
    this.#openSegments.add(state);
    const letGo = () => {
      const owner = state.owner;
      state.owner = null;
      if (owner) this.#release(owner);
    };
    const lose = () => {
      state.lost = true;
      state.closed = true;
      this.#openSegments.delete(state);
      letGo();
      return refuse(RESULT_CODES.SOCKET_AUTHORITY_LOST);
    };
    const settledActive = () => (state.active ? state.active.then(() => undefined, () => undefined) : Promise.resolve());
    return Object.freeze({
      get held() {
        return !state.closed && state.owner !== null;
      },
      get closed() {
        return state.closed;
      },
      get stopRequested() {
        return state.stopRequested;
      },
      wait: milliseconds => this.#wait(milliseconds),
      run: (commandId, payload = {}) => {
        if (state.lost) return Promise.resolve(refuse(RESULT_CODES.SOCKET_AUTHORITY_LOST));
        if (state.closed || !state.owner || this.#owner !== state.owner) {
          return Promise.resolve(refuse(RESULT_CODES.COMMAND_SEGMENT_RELEASED));
        }
        if (state.active) return Promise.resolve(this.#busy(COMMAND_LANES.GAMEPLAY));
        if (!this.#executor()) return Promise.resolve(lose());
        state.active = this.#segmentBoundaryThenAction(state, context, commandId, payload)
          .then(result => (this.#executor() ? result : (lose(), result)))
          .finally(() => { state.active = null; });
        return state.active;
      },
      release: async () => {
        await settledActive();
        letGo();
      },
      reacquire: async () => {
        if (state.lost) return refuse(RESULT_CODES.SOCKET_AUTHORITY_LOST);
        if (state.closed) return refuse(RESULT_CODES.COMMAND_SEGMENT_RELEASED);
        if (state.owner) return accept(RESULT_CODES.COMMAND_SEGMENT_OPENED);
        const owner = await this.#acquireSegment(context);
        if (!owner?.token) return owner;
        if (state.closed) {
          this.#release(owner);
          return refuse(RESULT_CODES.COMMAND_SEGMENT_RELEASED);
        }
        state.owner = owner;
        return accept(RESULT_CODES.COMMAND_SEGMENT_OPENED);
      },
      close: async () => {
        await settledActive();
        await this.#releaseSegmentHolds(context, state);
        letGo();
        state.closed = true;
        this.#openSegments.delete(state);
      }
    });
  }

  /**
   * When a segment closes, run the teardown from init/system.mjs before freeing the slot. It releases any move the
   * driver left open, as a normal command with its own undo record.
   */
  async #releaseSegmentHolds(context, state) {
    try {
      await this.#segmentTeardown({ userId: context.userId, since: state.openedAt },
        (commandId, payload, requestId) =>
          this.#runMaintenanceUnder(state.owner, commandId, payload, requestId, context.userId));
    } catch (error) {
      this.#diagnostics.record(createDiagnostic({ sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.DISPATCHER,
        commandId: context.commandId, error, detail: 'segment-teardown' }));
    }
  }

  /**
   * Before each segment action, run the queued MaintenanceScheduler jobs while the segment holds the slot, so turn
   * completion and other clean-up finish between the driver's units.
   */
  async #segmentBoundaryThenAction(state, segment, commandId, payload) {
    try {
      await this.#segmentBoundary((maintenanceId, maintenancePayload, requestId) =>
        this.#runMaintenanceUnder(state.owner, maintenanceId, maintenancePayload, requestId, segment.userId));
    } catch (error) {
      this.#diagnostics.record(createDiagnostic({ sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.DISPATCHER,
        commandId: segment.commandId, error, detail: 'segment-maintenance' }));
    }
    if (!state.owner || this.#owner !== state.owner) return refuse(RESULT_CODES.COMMAND_SEGMENT_RELEASED);
    return this.#segmentAction(state, segment, commandId, payload);
  }

  /**
   * Run one command as its own root, with fresh keys and its own undo record, while a segment holds the slot. Used
   * for the clean-up jobs between driver actions and for the teardown release.
   */
  async #runMaintenanceUnder(owner, commandId, payload, requestId, userId) {
    const id = String(commandId ?? '');
    const definition = this.#definitions.get(id);
    if (!definition) return refuse(RESULT_CODES.UNKNOWN_COMMAND);
    if (!owner || this.#owner !== owner) return refuse(RESULT_CODES.COMMAND_EXECUTION_BUSY);
    const context = { requestId: String(requestId ?? ''), commandId: id, payload: payload ?? {}, userId,
      lane: commandLane(id) };
    try {
      const barred = this.#admission(context, definition);
      if (barred) return barred;
      const refusal = await definition.authorize(context);
      if (refusal) return refusal;
      return await this.#runUnder(owner, definition, context, { authorized: true });
    } catch (error) {
      return this.#fail(context, error);
    }
  }

  /** One gameplay action inside a segment: authorized afresh, then run while the segment holds the slot. */
  async #segmentAction(state, segment, commandId, payload) {
    const id = String(commandId ?? '');
    const definition = this.#definitions.get(id);
    if (!definition) return refuse(RESULT_CODES.UNKNOWN_COMMAND);
    if (commandLane(id) !== COMMAND_LANES.GAMEPLAY) {
      return refuse(RESULT_CODES.COMMAND_CHILD_OUTSIDE_EXECUTION, { commandId: id });
    }
    const context = { requestId: `${segment.requestId}:${++state.actions}`, commandId: id,
      payload: payload ?? {}, userId: segment.userId, lane: COMMAND_LANES.GAMEPLAY, segment: true };
    try {
      const barred = this.#admission(context, definition);
      if (barred) return barred;
      const refusal = await definition.authorize(context);
      if (refusal) return refusal;
      return await this.#runUnder(state.owner, definition, context, { authorized: true });
    } catch (error) {
      return this.#fail(context, error);
    }
  }

  /* -------------------------------------------- */
  /*  Request memory and failures                 */
  /* -------------------------------------------- */

  /** Move finished results past their age or count limit into tombstones (ids kept as expired), and drop old ones. */
  #forget() {
    const now = this.#now();
    const { results, resultAgeMs, tombstones, tombstoneAgeMs } = this.#memory;
    let kept = 0;
    for (const entry of this.#requests.values()) if (entry.settled) kept += 1;
    for (const [key, entry] of this.#requests) {
      if (!entry.settled || (kept <= results && now - entry.settledAt < resultAgeMs)) continue;
      this.#requests.delete(key);
      this.#tombstones.set(key, now);
      kept -= 1;
    }
    for (const [key, at] of this.#tombstones) {
      if (this.#tombstones.size <= tombstones && now - at < tombstoneAgeMs) continue;
      this.#tombstones.delete(key);
    }
  }

  #fail(context, error) {
    const diagnostic = createDiagnostic({ sourcePath: import.meta.url,
      source: DIAGNOSTIC_SOURCES.DISPATCHER,
      commandId: context.commandId,
      requestId: context.requestId,
      error
    });
    this.#diagnostics.record(diagnostic);
    return refuse(RESULT_CODES.COMMAND_FAILED, { diagnostic: diagnosticPayload(diagnostic) });
  }
}

/* -------------------------------------------- */
/*  Definition invocation                       */
/* -------------------------------------------- */

/** Run a definition's authorize slot, then its handler only when the caller was admitted. */
async function invokeCommand(definition, context) {
  const refusal = await definition.authorize(context);
  if (refusal) return refusal;
  return definition.handler(context);
}

/* -------------------------------------------- */
/*  Concurrency keys                            */
/* -------------------------------------------- */

/**
 * Add the resource keys a handler is about to write to its run, before it writes. A child command shares its
 * parent's keys through invokeWithin. The keys lock nothing, since holding the command slot already keeps other
 * commands out, but they record what the command touches for CommandDispatcher.resourcesBusy. A malformed key or a
 * finished run returns false, and the handler refuses before writing.
 * @param {object} context The handler's dispatch context.
 * @param {string[]} keys Every resource key the handler is about to write.
 * @returns {boolean} True when every key is held, now or by claim.
 */
export function holdsResources(context, keys) {
  if (typeof context.claimResources === 'function') return context.claimResources(keys);
  const held = new Set(context.resourceKeys ?? []);
  return keys.every(key => held.has(key));
}

/** Resolve one or more resource keys in stable order. */
async function concurrencyKeysFor(definition, context) {
  const supplied = definition.concurrencyKeys
    ? await definition.concurrencyKeys(context)
    : [await definition.concurrencyKey?.(context)];
  const values = Array.isArray(supplied) ? supplied : [supplied];
  const keys = values.map(value => String(value ?? '')).filter(Boolean);
  if (keys.some(key => !validResourceKey(key))) throw new Error('Invalid command resource key.');
  return [...new Set(keys)].sort();
}

function validResourceKey(key) {
  return key.length <= MAX_RESOURCE_KEY_LENGTH
    && !/[\u0000-\u001f\u007f\s]/.test(key)
    && /^[a-z][a-z0-9-]*:.+$/i.test(key);
}
