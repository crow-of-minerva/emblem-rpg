/** @layer socket */
import { RESULT_CODES, accept, refuse } from '../contracts/results.mjs';
import {
  COMMAND_TIMING,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  createDiagnostic,
  diagnosticPayload,
  hostRefusalCode,
  requirePorts
} from '../contracts/protocol.mjs';
import { checkPayload } from './firewall.mjs';
import { createCommandEnvelope, isCommandEnvelope, isCommandStatusRequest, isSegmentStopRequest } from './protocol.mjs';
import { SocketRateLimiter } from './rate-limit.mjs';
/** What a timed-out wait returns, so it can't be mistaken for a real reply. */
const EXPIRED = Symbol('expired');

/** Replies meaning the tab this client sent to may no longer be the host, so its saved session id is dropped. */
const FORGETS_HOST_SESSION = new Set([RESULT_CODES.SOCKET_HOST_SESSION_STALE, RESULT_CODES.SOCKET_MULTIPLE_HOSTS]);

/* -------------------------------------------- */
/*  Command gateway                             */
/* -------------------------------------------- */
/**
 * Send public API commands to CommandDispatcher on the host client.
 * Each request carries an id and the host tab's session id. A lost reply comes back as an unknown outcome: the host
 * may already have run the command, so the gateway neither cancels nor retries it.
 */
export class CommandGateway {
  #pending = new Map();
  #sessions = new Map();

  /**
   * Built in init/system.mjs. `lifecycle` and `execution` fill status replies, `operatorIdentifier` names Foundry's
   * update-operator marker for the payload check, and `authorityObserver` re-checks which GM tab is the host.
   */
  constructor({ dispatcher, transport, identity, diagnostics, operatorIdentifier, lifecycle, execution,
    authorityObserver, rateLimiter = new SocketRateLimiter(), timing = COMMAND_TIMING }) {
    requirePorts('CommandGateway', { dispatcher, transport, identity, diagnostics, operatorIdentifier, lifecycle,
      execution, authorityObserver });
    this.dispatcher = dispatcher;
    this.transport = transport;
    this.identity = identity;
    this.diagnostics = diagnostics;
    this.rateLimiter = rateLimiter;
    this.operatorIdentifier = operatorIdentifier;
    this.timing = timing;
    this.lifecycle = lifecycle;
    this.execution = execution;
    this.authorityObserver = authorityObserver;
  }

  /** Connect socketlib transport callbacks to command, presentation, status and host-presence handlers. */
  initializeTransport(presentationHandler, presenceHandler = null) {
    this.transport.initialize(
      (envelope, userId) => this.#receive(envelope, userId),
      presentationHandler,
      (request, userId) => this.#status(request, userId),
      (request, userId) => this.#stopSegment(request, userId),
      presenceHandler
    );
  }

  /* -------------------------------------------- */
  /*  Callers                                     */
  /* -------------------------------------------- */

  /**
   * Send a public API command to the host and return its result, refusal or unknown outcome.
   * On the host client the call goes straight to CommandDispatcher, without the size, rate or session checks.
   */
  async execute(commandId, payload = {}) {
    let requestId = '';
    try { requestId = this.identity.requestId(); } catch (error) { return this.#fail(commandId, '', error); }
    const host = this.identity.host();
    const unavailable = hostRefusal(host);
    if (unavailable) return withRequest(unavailable, requestId);
    const localUserId = this.identity.localUserId();
    const messageMode = this.identity.messageMode();

    if (host.localIsHost) {
      let envelope;
      try {
        envelope = createCommandEnvelope(commandId, payload, requestId,
          { transmitted: false, hostSession: this.identity.sessionId(), messageMode });
      } catch (error) { return this.#fail(commandId, requestId, error); }
      const refused = this.#firewall(envelope);
      if (refused) return withRequest(refused, requestId);
      return withRequest(await this.dispatcher.dispatch(envelope, localUserId), requestId);
    }

    if (!this.transport.ready) return withRequest(refuse(RESULT_CODES.SOCKET_NOT_READY), requestId);
    let probe;
    try { probe = createCommandEnvelope(commandId, payload, requestId, { messageMode }); } catch (error) {
      return this.#fail(commandId, requestId, error);
    }
    const refused = this.#firewall(probe);
    if (refused) return withRequest(refused, requestId);
    const { session: hostSession, refused: hostRefused } = await this.#sessionOf(host.hostUserId);
    if (hostRefused) return withRequest(hostRefused, requestId);
    if (!hostSession) return withRequest(refuse(RESULT_CODES.SOCKET_HOST_UNREACHABLE), requestId);
    const envelope = createCommandEnvelope(commandId, payload, requestId, { hostSession, messageMode });
    const reply = await this.#send(host.hostUserId, envelope);
    if (FORGETS_HOST_SESSION.has(reply?.code)) this.#sessions.delete(host.hostUserId);
    return withRequest(reply, requestId);
  }

  /** Ask the host what became of one request, within the status deadline. */
  requestStatus(requestId) {
    return this.#ask({ requestId: String(requestId ?? '') });
  }

  /**
   * Ask the host for its status. An `onResponse` observer (the processing blocker passes one) still sees a reply
   * that arrives after the status deadline, but the returned promise settles by the deadline.
   */
  status(onResponse = null) {
    return this.#ask({}, onResponse);
  }

  /**
   * Ask the host to stop a running series of actions, such as an Enemy AI turn, before its next action. Only a GM
   * or Assistant may ask. This isn't a command, so it neither waits for the running one nor takes its place.
   * A lost reply returns unknown and is not retried.
   * @returns {Promise<object>} `command.segment-stop-requested`, a refusal, or an unknown outcome.
   */
  async requestSegmentStop() {
    const host = this.identity.host();
    const unavailable = hostRefusal(host);
    if (unavailable) return unavailable;
    if (host.localIsHost) return this.#stopSegment({}, this.identity.localUserId());
    if (!this.transport.ready) return refuse(RESULT_CODES.SOCKET_NOT_READY);
    const { session: hostSession, refused: hostRefused } = await this.#sessionOf(host.hostUserId);
    if (hostRefused) return hostRefused;
    if (!hostSession) return refuse(RESULT_CODES.SOCKET_HOST_UNREACHABLE);
    const reply = await this.#bounded(() => this.transport.requestSegmentStop(host.hostUserId, { hostSession }),
      this.timing.statusMs);
    if (reply === EXPIRED || !reply) return refuse(RESULT_CODES.COMMAND_OUTCOME_UNKNOWN);
    if (FORGETS_HOST_SESSION.has(reply.code)) this.#sessions.delete(host.hostUserId);
    return reply;
  }

  /** This client's current view of the command host, read locally without asking anyone. */
  host() {
    return this.identity.host();
  }

  /**
   * Handle Foundry user connection changes. Forget the saved host session id, and end a departing host's waiting
   * requests as unknown.
   */
  onUserActivity(userId, active) {
    const id = String(userId ?? '');
    this.#sessions.delete(id);
    if (active) return;
    for (const pending of [...this.#pending.values()]) {
      if (pending.hostUserId === id) pending.settle(unknownOutcome(pending));
    }
  }

  /** When the host may have changed, re-check which GM tab is the host and end requests sent to an old one. */
  onAuthorityChanged() {
    try {
      this.authorityObserver();
    } catch (error) {
      this.diagnostics.record(createDiagnostic({ sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.GATEWAY,
        error, notify: false, severity: DIAGNOSTIC_SEVERITIES.WARNING, detail: 'authority-observer' }));
    }
    const hostUserId = this.identity.host().hostUserId;
    for (const pending of [...this.#pending.values()]) {
      if (pending.hostUserId !== hostUserId) pending.settle(unknownOutcome(pending));
    }
    for (const id of [...this.#sessions.keys()]) if (id !== hostUserId) this.#sessions.delete(id);
  }

  async #ask(request, onResponse = null) {
    const host = this.identity.host();
    const unavailable = hostRefusal(host);
    if (unavailable) return unavailable;
    if (host.localIsHost) return this.#status(request, this.identity.localUserId());
    if (!this.transport.ready) return refuse(RESULT_CODES.SOCKET_NOT_READY);
    const reply = await this.#bounded(async () => {
      const response = await this.transport.requestStatus(host.hostUserId, request);
      try { onResponse?.(response); }
      catch (error) {
        this.diagnostics.record(createDiagnostic({ sourcePath: import.meta.url, error, notify: false,
          detail: 'host-status-observer' }));
      }
      return response;
    }, this.timing.statusMs);
    if (reply === EXPIRED || !reply) {
      return refuse(RESULT_CODES.COMMAND_OUTCOME_UNKNOWN, { requestId: request.requestId ?? '' });
    }
    if (reply.code === RESULT_CODES.COMMAND_STATUS && reply.data?.hostSession) {
      this.#sessions.set(host.hostUserId, String(reply.data.hostSession));
    }
    return reply;
  }

  /**
   * Get the host tab's session id through a status request, and remember it.
   * If the host GM has two tabs open, return that refusal instead of reporting the host as unreachable.
   * @returns {Promise<{session: string, refused: object|null}>}
   */
  async #sessionOf(hostUserId) {
    if (this.#sessions.has(hostUserId)) return { session: this.#sessions.get(hostUserId), refused: null };
    const reply = await this.#bounded(() => this.transport.requestStatus(hostUserId, {}), this.timing.statusMs);
    if (reply !== EXPIRED && reply?.code === RESULT_CODES.SOCKET_MULTIPLE_HOSTS) {
      return { session: '', refused: refuse(RESULT_CODES.SOCKET_MULTIPLE_HOSTS) };
    }
    const session = reply !== EXPIRED && reply?.code === RESULT_CODES.COMMAND_STATUS
      ? String(reply.data?.hostSession ?? '') : '';
    if (session) this.#sessions.set(hostUserId, session);
    return { session, refused: null };
  }

  /** Send one envelope and wait at most the response deadline. A lost reply becomes an unknown outcome. */
  #send(hostUserId, envelope) {
    return new Promise(resolve => {
      const pending = { requestId: envelope.id, commandId: envelope.commandId, hostUserId, settled: false, timer: null };
      pending.settle = result => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        this.#pending.delete(pending.requestId);
        resolve(result);
      };
      this.#pending.set(pending.requestId, pending);
      pending.timer = setTimeout(() => pending.settle(unknownOutcome(pending)), this.timing.responseMs);
      Promise.resolve()
        .then(() => this.transport.executeAsUser(hostUserId, envelope))
        .then(reply => pending.settle(reply ?? unknownOutcome(pending)), error => {
          this.diagnostics.record(createDiagnostic({ sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.GATEWAY,
            commandId: envelope.commandId, requestId: envelope.id, error, notify: false,
            severity: DIAGNOSTIC_SEVERITIES.WARNING }));
          pending.settle(unknownOutcome(pending));
        });
    });
  }

  /** Run `work` with a deadline. A timeout and an error both return EXPIRED, and neither is recorded. */
  async #bounded(work, milliseconds) {
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(EXPIRED), milliseconds); });
    try {
      return await Promise.race([Promise.resolve().then(work).catch(() => EXPIRED), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Dispatch host lifecycle work directly to CommandDispatcher with its supplied request id. */
  executeInternal(commandId, payload, requestId) {
    try {
      const envelope = createCommandEnvelope(commandId, payload, requestId, { transmitted: false });
      return this.dispatcher.dispatch(envelope, this.identity.localUserId());
    } catch (error) {
      return Promise.resolve(this.#fail(commandId, requestId, error));
    }
  }

  #fail(commandId, requestId, error) {
    const diagnostic = createDiagnostic({ sourcePath: import.meta.url,
      source: DIAGNOSTIC_SOURCES.GATEWAY, commandId, requestId, error
    });
    this.diagnostics.record(diagnostic);
    return refuse(RESULT_CODES.COMMAND_FAILED, { diagnostic: diagnosticPayload(diagnostic) });
  }

  /** Forget a disconnected caller's rate budget. */
  forgetCaller(userId) {
    this.rateLimiter.clear(String(userId ?? ''));
  }

  /* -------------------------------------------- */
  /*  Host                                        */
  /* -------------------------------------------- */

  /**
   * On the host client: check and run a command another client sent. `userId` comes from the Foundry server, so it
   * can't be forged. Each command's own permission check runs in CommandDispatcher. `hostSession` is optional.
   */
  async #receive(envelope, userId) {
    if (!isCommandEnvelope(envelope)) return refuse(RESULT_CODES.COMMAND_FAILED);
    const host = this.identity.host();
    if (!host.localIsHost) return hostRefusal(host) ?? refuse(RESULT_CODES.NO_ACTIVE_GM);
    if (envelope.hostSession && envelope.hostSession !== this.identity.sessionId()) {
      return refuse(RESULT_CODES.SOCKET_HOST_SESSION_STALE, { requestId: envelope.id });
    }
    const limited = this.#rateLimit(envelope, userId);
    if (limited) return limited;
    const refused = this.#firewall(envelope, userId);
    if (refused) return refused;
    return this.dispatcher.dispatch(envelope, userId);
  }

  /** Answer a status request from this host's own state. Only the eligible host answers. */
  #status(request, userId) {
    if (!isCommandStatusRequest(request)) return refuse(RESULT_CODES.SOCKET_PAYLOAD_REFUSED);
    const host = this.identity.host();
    if (!host.localIsHost) return hostRefusal(host) ?? refuse(RESULT_CODES.NO_ACTIVE_GM);
    const requestId = request.requestId ?? '';
    return accept(RESULT_CODES.COMMAND_STATUS, {
      hostUserId: host.hostUserId,
      hostSession: this.identity.sessionId(),
      lifecycle: this.lifecycle(),
      execution: this.execution(),
      request: requestId ? this.dispatcher.requestStatus(String(userId ?? ''), requestId) : null
    });
  }

  /**
   * On the host client: let a GM or Assistant stop a running series of actions, such as an Enemy AI turn. Reached
   * through socketlib, or directly from requestSegmentStop on the host.
   */
  #stopSegment(request, userId) {
    if (!isSegmentStopRequest(request)) return refuse(RESULT_CODES.SOCKET_PAYLOAD_REFUSED);
    const host = this.identity.host();
    if (!host.localIsHost) return hostRefusal(host) ?? refuse(RESULT_CODES.NO_ACTIVE_GM);
    if (request.hostSession && request.hostSession !== this.identity.sessionId()) {
      return refuse(RESULT_CODES.SOCKET_HOST_SESSION_STALE);
    }
    const sender = String(userId ?? '');
    if (!sender || this.identity.isGmUser(sender) !== true) return refuse(RESULT_CODES.GM_REQUIRED);
    try {
      return this.dispatcher.requestSegmentStop({ userId: sender });
    } catch (error) {
      return this.#fail('segment-stop', '', error);
    }
  }

  #firewall(envelope, userId = this.identity.localUserId()) {
    const verdict = checkPayload(envelope.payload, { operatorIdentifier: this.operatorIdentifier() });
    if (verdict.ok) return null;
    this.diagnostics.record(createDiagnostic({ sourcePath: import.meta.url,
      source: DIAGNOSTIC_SOURCES.GATEWAY, commandId: envelope.commandId, requestId: envelope.id,
      notify: false,
      severity: DIAGNOSTIC_SEVERITIES.WARNING, detail: `${userId}: ${verdict.reason}`
    }));
    return refuse(RESULT_CODES.SOCKET_PAYLOAD_REFUSED);
  }

  #rateLimit(envelope, userId) {
    if (this.identity.isGmUser(userId) === true) return null;
    const verdict = this.rateLimiter.consume(String(userId ?? ''), envelope.commandId);
    if (verdict.ok) return null;
    if (verdict.report) {
      this.diagnostics.record(createDiagnostic({ sourcePath: import.meta.url,
        source: DIAGNOSTIC_SOURCES.GATEWAY, commandId: envelope.commandId, requestId: envelope.id,
        notify: false,
        severity: DIAGNOSTIC_SEVERITIES.WARNING,
        detail: `${userId} exceeded the ${verdict.scope} socket budget; blocked for ${verdict.retryAfterMs} ms`
      }));
    }
    return refuse(RESULT_CODES.SOCKET_RATE_LIMITED, { retryAfterMs: verdict.retryAfterMs, scope: verdict.scope });
  }
}

/** A refusal when the world has no single eligible host tab, or null when it has one. */
function hostRefusal(host) {
  const code = hostRefusalCode(host);
  return code ? refuse(code) : null;
}

/** A result that names the request it answers, so the caller can ask about it later. */
function withRequest(result, requestId) {
  if (!result || typeof result !== 'object') return result;
  return Object.freeze({ ...result, data: Object.freeze({ ...(result.data ?? {}), requestId }) });
}

/** The outcome of a request whose reply was lost: the host may or may not have run it. */
function unknownOutcome({ requestId, commandId }) {
  return refuse(RESULT_CODES.COMMAND_OUTCOME_UNKNOWN, { requestId, commandId });
}
