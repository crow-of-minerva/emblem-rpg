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

/** Holders gameplay may wait a bounded moment for, instead of refusing at once. */
const YIELDING_LANES = new Set([COMMAND_LANES.MAINTENANCE, COMMAND_LANES.STARTUP, COMMAND_LANES.RECOVERY]);

/**
 * Runs authenticated CommandGateway requests one at a time: a root command holds world execution until its handler
 * settles, and inspection commands run without holding it. A request that finds execution held is refused as busy,
 * except that gameplay waits a bounded moment behind maintenance, startup or recovery work. Results are remembered
 * by caller, request id and payload, so a repeated delivery never runs a command twice.
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
   * Every port but the three production constants comes from init/system.mjs: `operations` is OperationRecovery,
   * `executor` answers whether this page hosts, `admission` is the startup and pause gate, `wait` is the
   * presentation pacing clock, and the four callbacks report execution changes and drive segment boundaries.
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
  /*  Execution owner                             */
  /* -------------------------------------------- */

  /** Whether a command or segment holds world execution right now. */
  executionHeld() {
    return this.#owner !== null;
  }

  /** Whether execution is free and no gameplay request is waiting to take it. */
  executionFree() {
    return this.#owner === null && this.#waiters.length === 0;
  }

  /**
   * Whether nothing is running: execution is free, or a segment holds it between actions. api.board.awaitSettled
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

  /** A detached view of who holds execution, for host status replies and every client's processing blocker. */
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
   * Give up on a holder that never settles, for the forced recovery.clear-busy in engine/recovery/commands.mjs.
   * The abandoned run is settled, so its later resource claims and nested invokeWithin calls refuse, and a segment
   * finds itself released. Nothing stops writes the old handler makes directly if it ever resumes, and its
   * operation record is left open on purpose: `recorded` tells the caller the host must reload so startup
   * restores it.
   * @returns {{commandId: string, lane: string, recorded: boolean}|null} The holder, or null when execution was free.
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
   * Give up on the running operation without touching execution, for the page-unload handlers in init/system.mjs.
   * A page that is closing keeps running its handler for a while, so its settle must not start a restoration the
   * next page would load through: the abandoned run settles as `abandoned`, its record stays open, and the new
   * page's startup `OperationRecovery.restoreUnfinished()` restores it against a consistent world.
   * @returns {boolean} Whether the abandoned operation still holds a durable record.
   */
  abandonOperation() {
    return this.#owner?.run?.operation?.abandon() === true;
  }

  /* -------------------------------------------- */
  /*  Requests                                    */
  /* -------------------------------------------- */

  /** Dispatch a CommandGateway envelope using the transport-authenticated sender id. */
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
   * Run a child command inside the running command, with its execution token, operation and resource keys and no
   * second root request. `scope` is the parent's context. Refuses when no command is running or the scope's
   * execution token is not the current one. The child's own authorize slot still runs.
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
  /*  Admission                                   */
  /* -------------------------------------------- */

  /**
   * Admit a root CommandGateway request: check startup and authorization, acquire execution,
   * then authorize again with fresh resources. Release execution regardless of the handler's outcome.
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
   * Resolve fresh resource keys under the held owner, then run the handler with them, a claim port and the
   * operation its writers capture through. The operation settles from the handler's own outcome. A root is
   * authorized here a second time, now under the owner. A segment action or a maintenance run under a segment
   * arrives `authorized`, because its caller already checked it under this same owner.
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
   * Commit the run's operation when its handler succeeded, and put its before-images back otherwise.
   * A commit that cannot be saved is itself a failure, so the caller is told the restoration's outcome through
   * `data.restored`. engine/recovery/operations.mjs has already reported anything it could not resolve.
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
   * Run a definition after checking again that this client still hosts and that startup admits the command, then
   * authorize it unless the caller already did under the held owner.
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
   * Take execution now, or resolve null when it is held. Only gameplay may wait, for up to `maintenanceYieldMs`, and
   * only behind maintenance, startup or recovery work (#yielding).
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

  /** Check and set the owner in one synchronous step, so two admissions can never both take it. */
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

  /** Whether gameplay may wait for the current holder: maintenance, startup or recovery work, never a segment. */
  #yielding() {
    return Boolean(this.#owner) && !this.#owner.segment && YIELDING_LANES.has(this.#owner.lane);
  }

  /** Free the owner, hand it straight to the first waiting gameplay request, and report the release. */
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
   * Report the execution change through the `onExecutionChanged` port. A failure there is only recorded, so it never
   * changes who holds execution.
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

  /** Start one handler's run under the owner. A segment starts a fresh run, with fresh keys, for every action. */
  #beginRun(owner, context) {
    if (owner.run) owner.run.settled = true;
    owner.run = { commandId: context.commandId, requester: context.requester, keys: new Set(), settled: false,
      operation: null };
    return owner.run;
  }

  /**
   * Add keys to the running handler's resource keys. Refuses a malformed key or a run that has settled. The keys
   * lock nothing, because world execution already keeps other commands out.
   */
  #claim(run, keys) {
    if (run.settled || this.#owner?.run !== run) return false;
    const wanted = [...new Set((keys ?? []).map(key => String(key ?? '')))];
    if (wanted.some(key => !validResourceKey(key))) return false;
    for (const key of wanted) run.keys.add(key);
    return true;
  }

  /* -------------------------------------------- */
  /*  Execution segments                          */
  /* -------------------------------------------- */

  /**
   * Hold execution for a host-local driver such as the Enemy AI (api.protocol). Each action run through the segment
   * is authorized and gets its resource keys afresh. Other gameplay stays out until the segment is released or
   * closed, and both wait for a running action to finish first.
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
   * Mark open segments after CommandGateway authenticates a staff stop request.
   * The driver reads stopRequested between actions and closes its handle. This method does not
   * cancel an action, release execution or prevent further driver calls.
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

  /** The owner for a segment, or the refusal that stops it. */
  async #acquireSegment(context) {
    if (!context.userId) return refuse(RESULT_CODES.COMMAND_FAILED);
    if (!this.#executor()) return refuse(RESULT_CODES.NO_ACTIVE_GM);
    const barred = this.#admission(context, null);
    if (barred) return barred;
    const owner = await this.#acquire(context, COMMAND_LANES.GAMEPLAY);
    if (!owner) return this.#busy(COMMAND_LANES.GAMEPLAY);
    return owner;
  }

  /** Build the api.protocol segment handle, binding actions, stop state and pacing to its execution owner. */
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
   * Run the teardown injected by init/system.mjs before releasing segment execution.
   * It rechecks plan ownership and identity before closing a movement plan left by the driver, and releases it
   * through the runner given here, so that release is an ordinary command with its own operation record rather
   * than a bare write under the segment's owner.
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
   * Drain MaintenanceScheduler work under the segment's execution before its next action.
   * This lets turn completion and reconciliation settle between automatically driven units.
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
   * Run one command as its own root, with fresh keys and its own operation, inside execution a segment already
   * holds. Both the reconciliation drain between driver actions and the teardown release enter here.
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

  /** One gameplay action inside a segment: authorized afresh, then run under the segment's owner. */
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

  /** Move settled results past their age or count bound into tombstones, and drop tombstones past theirs. */
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
 * parent's keys through invokeWithin. The keys lock nothing, since world execution already keeps other commands
 * out, but they record what the command touches for CommandDispatcher.resourcesBusy. A malformed key or a settled
 * run returns false, and the handler refuses before writing.
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
