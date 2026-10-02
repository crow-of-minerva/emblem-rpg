/** @layer external/socketlib */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { SOCKET_OPERATIONS } from '../../socket/protocol.mjs';

/* -------------------------------------------- */
/*  Socket transport                            */
/* -------------------------------------------- */
/**
 * The system's socket connection, through socketlib. It carries commands to the host, status and stop requests,
 * host tab presence and presentation messages. init/system.mjs creates it, CommandGateway registers the handlers
 * (initializeTransport), and HostPagePresence and UnitPresentationGateway also send through it.
 * socketlib passes each handler the sender's user id, which the Foundry server sets, so it can't be forged.
 * socketlib sends every message, replies included, to every client and filters on arrival, so never put secret
 * data in commands, replies or audience messages.
 */
export class SocketlibSystemTransport {
  #socket = null;

  get ready() {
    return Boolean(this.#socket);
  }

  /**
   * Register the socket handlers once, from CommandGateway.initializeTransport. Throws if socketlib isn't loaded.
   * The status, stop and presence handlers are optional.
   */
  initialize(commandHandler, presentationHandler, statusHandler = null, stopHandler = null, presenceHandler = null) {
    if (this.#socket) return;
    if (!globalThis.socketlib) throw new Error('socketlib is not available.');

    this.#socket = globalThis.socketlib.registerSystem(SYSTEM_ID);
    this.#socket.register(SOCKET_OPERATIONS.EXECUTE_COMMAND, async function (envelope) {
      return commandHandler(envelope, this?.socketdata?.userId);
    });
    this.#socket.register(SOCKET_OPERATIONS.UNIT_PRESENTATION, async function (message) {
      return presentationHandler(message, this?.socketdata?.userId);
    });
    if (statusHandler) {
      this.#socket.register(SOCKET_OPERATIONS.COMMAND_STATUS, async function (request) {
        return statusHandler(request, this?.socketdata?.userId);
      });
    }
    if (stopHandler) {
      this.#socket.register(SOCKET_OPERATIONS.SEGMENT_STOP, async function (request) {
        return stopHandler(request, this?.socketdata?.userId);
      });
    }
    if (presenceHandler) {
      this.#socket.register(SOCKET_OPERATIONS.HOST_PRESENCE, async function (message) {
        return presenceHandler(message, this?.socketdata?.userId);
      });
    }
  }

  /**
   * Send a HostPagePresence message to every other connected client. It isn't addressed to this user, because
   * socketlib runs a call addressed to the caller's own user on the calling tab only. HostPagePresence.receive
   * keeps only messages from its own user's other tabs. The message is emitted before this returns, so the goodbye
   * sent when a tab closes still leaves.
   */
  async sendHostPresence(message) {
    if (!this.#socket) throw new Error('socketlib is not ready.');
    return this.#socket.executeForOthers(SOCKET_OPERATIONS.HOST_PRESENCE, message);
  }

  /** Send a command envelope to the host user's client and wait for its reply. */
  async executeAsUser(userId, envelope) {
    if (!this.#socket) throw new Error('socketlib is not ready.');
    return this.#socket.executeAsUser(SOCKET_OPERATIONS.EXECUTE_COMMAND, userId, envelope);
  }

  /** Ask one user's client, the host, for its session, lifecycle and a request's state. */
  async requestStatus(userId, request) {
    if (!this.#socket) throw new Error('socketlib is not ready.');
    return this.#socket.executeAsUser(SOCKET_OPERATIONS.COMMAND_STATUS, userId, request);
  }

  /** Ask the host's client to stop a running series of actions, such as an Enemy AI turn, before its next action. */
  async requestSegmentStop(userId, request) {
    if (!this.#socket) throw new Error('socketlib is not ready.');
    return this.#socket.executeAsUser(SOCKET_OPERATIONS.SEGMENT_STOP, userId, request);
  }

  /** Send a presentation message to every other client. */
  async executeForOthers(message) {
    if (!this.#socket) throw new Error('socketlib is not ready.');
    return this.#socket.executeForOthers(SOCKET_OPERATIONS.UNIT_PRESENTATION, message);
  }

  /**
   * Send a presentation message addressed to the named users. socketlib still sends it to every client, and the
   * others drop it on arrival. The promise settles once it's sent.
   */
  async executeForUsers(userIds, message) {
    if (!this.#socket) throw new Error('socketlib is not ready.');
    return this.#socket.executeForUsers(SOCKET_OPERATIONS.UNIT_PRESENTATION, userIds, message);
  }
}
