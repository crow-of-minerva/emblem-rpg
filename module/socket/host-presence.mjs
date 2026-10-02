/** @layer socket */
import {
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  HOST_PRESENCE_TIMING,
  HOST_STATES,
  recordDiagnostic,
  requirePorts
} from '../contracts/protocol.mjs';
import { HOST_PRESENCE_KINDS, createHostPresenceMessage, isHostPresenceMessage } from './protocol.mjs';

/* -------------------------------------------- */
/*  Page sessions                               */
/* -------------------------------------------- */

/**
 * The host GM's other open browser tabs, by session id, with the heartbeats each has missed, so two tabs never both
 * run commands. HostPagePresence fills it, and resolveHostAuthority names no host while it isn't empty.
 */
export class HostPageSessions {
  #missed = new Map();

  /** How many other open tabs are known. */
  get size() {
    return this.#missed.size;
  }

  /** Whether a tab's session id is known. */
  has(session) {
    return this.#missed.has(session);
  }

  /** Mark a tab as open after hearing from it, with no missed heartbeats. */
  heard(session) {
    this.#missed.set(session, 0);
  }

  /** Forget one tab. Returns whether it was known. */
  forget(session) {
    return this.#missed.delete(session);
  }

  /**
   * Count one heartbeat interval against every known tab and forget each that has now stayed silent for `limit`.
   * @param {number} limit Silent intervals after which a tab is taken to be closed.
   * @returns {string[]} The sessions forgotten.
   */
  elapse(limit) {
    const gone = [];
    for (const [session, missed] of this.#missed) {
      if (missed + 1 >= limit) gone.push(session);
      else this.#missed.set(session, missed + 1);
    }
    for (const session of gone) this.#missed.delete(session);
    return gone;
  }

  /** Forget every tab. */
  clear() {
    this.#missed.clear();
  }
}

/* -------------------------------------------- */
/*  Host page presence                          */
/* -------------------------------------------- */

/**
 * Detect when the host GM has more than one tab open, which CommandGateway's host check refuses.
 * Foundry counts users, but socketlib sends a user's requests to all of their tabs.
 * Only presence messages from this same user are accepted, and a tab that stops sending heartbeats is forgotten.
 * An unknown heartbeat triggers a new handshake, since it may come from a tab that has already closed.
 */
export class HostPagePresence {
  #announced = false;
  #settling = null;
  #probed = false;
  #beating = false;
  #disposed = false;
  #duplicated = false;

  /**
   * @param {object} options
   * @param {object} options.transport Sends one presence message to every other client (`sendHostPresence`).
   * @param {object} options.identity This tab's session id, its user, and who the host is.
   * @param {HostPageSessions} options.sessions The list of this user's other tabs that the host check counts.
   * @param {Function} options.wait Timer for heartbeats, expiry and the startup wait; keeps time in a background tab.
   * @param {Function} options.onDuplicateChange Told `{duplicated}` each time another open tab starts or stops
   *   blocking this one.
   * @param {object} options.diagnostics Where a failed send or heartbeat is recorded.
   * @param {object} [options.timing] {@link HOST_PRESENCE_TIMING}.
   */
  constructor({ transport, identity, sessions, wait, onDuplicateChange, diagnostics, timing = HOST_PRESENCE_TIMING }) {
    requirePorts('HostPagePresence', { transport, identity, sessions, wait, onDuplicateChange, diagnostics });
    this.transport = transport;
    this.identity = identity;
    this.sessions = sessions;
    this.wait = wait;
    this.onDuplicateChange = onDuplicateChange;
    this.diagnostics = diagnostics;
    this.timing = timing;
  }

  /* -------------------------------------------- */
  /*  Public API                                  */
  /* -------------------------------------------- */

  /** Start the heartbeat loop, once. The tab announces itself as soon as its user could be the host. */
  start() {
    if (this.#beating || this.#disposed) return;
    this.#beating = true;
    this.sync();
    void this.#beat();
  }

  /**
   * Update presence after user or role changes. Announce this tab when its user could be the host, and clear
   * HostPageSessions when this user is no longer the sole connected GM. Until other tabs answer the hello, this tab
   * counts as the only one: startup waits for them (`settle()`), but later two tabs can both act as host for a moment.
   */
  sync() {
    if (this.#disposed) return;
    if (!this.#candidate()) {
      this.#announced = false;
      this.#settling = null;
      this.sessions.clear();
    } else if (!this.#announced && this.transport.ready) {
      this.#announced = true;
      this.#settling = Promise.resolve(this.wait(this.timing.settleMs));
      this.#send(HOST_PRESENCE_KINDS.HELLO);
    }
    this.#notify();
  }

  /** At startup, wait for other tabs to answer this tab's hello before it starts running commands. */
  settle() {
    this.sync();
    return this.#settling ?? Promise.resolve();
  }

  /**
   * Take one presence message from the socket.
   * @param {object} message The presence message.
   * @param {string} senderId The sender's user id, as set by the Foundry server.
   * @returns {boolean} Whether it came from another open tab of this user and changed what this tab knows.
   */
  receive(message, senderId) {
    if (this.#disposed || !isHostPresenceMessage(message)) return false;
    const local = String(this.identity.localUserId() ?? '');
    if (!local || String(senderId ?? '') !== local || message.session === this.#session()) return false;
    if (!this.#candidate()) return false;
    if (!this.#announced) this.sync();
    const taken = this.#take(message);
    this.#notify();
    return taken;
  }

  /**
   * Send goodbye and stop heartbeats on pagehide. The list of other tabs is kept, so a closing tab that knew of
   * others can't become host again; a tab that was alone stays eligible. Afterwards it ignores presence messages.
   */
  dispose() {
    if (this.#disposed) return;
    if (this.#announced) this.#send(HOST_PRESENCE_KINDS.GOODBYE);
    this.#disposed = true;
  }

  /* -------------------------------------------- */
  /*  Messages                                    */
  /* -------------------------------------------- */

  /** Apply one message from another tab of this user. Returns whether it changed what this tab knows. */
  #take({ kind, session, to }) {
    switch (kind) {
      case HOST_PRESENCE_KINDS.GOODBYE:
        return this.sessions.forget(session);
      case HOST_PRESENCE_KINDS.HELLO:
        this.sessions.heard(session);
        this.#send(HOST_PRESENCE_KINDS.PRESENT, session);
        return true;
      case HOST_PRESENCE_KINDS.PRESENT:
        if (to !== this.#session()) return this.#keepAlive(session);
        this.sessions.heard(session);
        return true;
      default:
        return this.#keepAlive(session);
    }
  }

  /**
   * Refresh a known HostPageSessions entry. For an unknown heartbeat, request a fresh handshake
   * instead of trusting a message that may have outlived its sender.
   */
  #keepAlive(session) {
    if (this.sessions.has(session)) {
      this.sessions.heard(session);
      return true;
    }
    if (!this.#probed) {
      this.#probed = true;
      this.#send(HOST_PRESENCE_KINDS.HELLO);
    }
    return false;
  }

  /* -------------------------------------------- */
  /*  Heartbeats                                  */
  /* -------------------------------------------- */

  /** Every heartbeat interval, send a heartbeat and forget tabs that have gone silent. */
  async #beat() {
    while (!this.#disposed) {
      try {
        await this.wait(this.timing.heartbeatMs);
      } catch (error) {
        this.#record(error);
        return;
      }
      if (this.#disposed) return;
      try {
        this.#heartbeat();
      } catch (error) {
        this.#record(error);
      }
    }
  }

  #heartbeat() {
    this.#probed = false;
    this.sync();
    if (!this.#announced) return;
    this.sessions.elapse(this.timing.silentBeats);
    this.#send(HOST_PRESENCE_KINDS.HEARTBEAT);
    this.#notify();
  }

  /* -------------------------------------------- */
  /*  Private helpers                             */
  /* -------------------------------------------- */

  /** Whether the connected users alone make this tab's user the host, however many tabs that user has open. */
  #candidate() {
    const host = this.identity.host();
    return host.localIsHost || host.state === HOST_STATES.DUPLICATE_PAGES;
  }

  /** Report a change in whether another open tab blocks this one, once per change. */
  #notify() {
    const duplicated = this.identity.host().state === HOST_STATES.DUPLICATE_PAGES;
    if (duplicated === this.#duplicated) return;
    this.#duplicated = duplicated;
    try {
      this.onDuplicateChange({ duplicated });
    } catch (error) {
      this.#record(error);
    }
  }

  #session() {
    return String(this.identity.sessionId() ?? '');
  }

  #send(kind, to = '') {
    if (!this.transport.ready) return;
    try {
      const message = createHostPresenceMessage(kind, this.#session(), to);
      void Promise.resolve(this.transport.sendHostPresence(message)).catch(error => this.#record(error));
    } catch (error) {
      this.#record(error);
    }
  }

  #record(error) {
    recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.GATEWAY, error,
      severity: DIAGNOSTIC_SEVERITIES.WARNING, notify: false, detail: 'host-presence' });
  }
}
