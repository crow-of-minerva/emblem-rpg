/** @layer socket */
import {
  DIAGNOSTIC_SOURCES,
  boundedText,
  createDiagnostic,
  exactKeys,
  plainRecord,
  requirePorts
} from '../contracts/protocol.mjs';
import {
  isBannerPresentationMessage,
  isCombatPresentationMessage,
  isEnemyPhaseCameraMessage,
  isPhaseCameraPresentationMessage,
  isEffectPresentationMessage
} from '../contracts/domains/combat.mjs';
import { isDowntimePresentationMessage } from '../contracts/domains/downtime.mjs';
import { isEconomyPresentationMessage } from '../contracts/domains/economy.mjs';
import {
  isDefeatPresentationMessage, isHealthPresentationMessage, isStanceBreakPresentationMessage
} from '../contracts/domains/damage.mjs';
import {
  isInventoryCapacityNoticeMessage,
  isInventoryRefusalPresentationMessage,
  isItemActivationPresentationMessage
} from '../contracts/domains/items.mjs';
import { isObjectPresentationMessage } from '../contracts/domains/objects.mjs';
import {
  isProgressionFeatureNoticeMessage,
  isProgressionPresentationMessage
} from '../contracts/domains/progression.mjs';
import { isTerrainSpawnPresentationMessage } from '../contracts/domains/terrain.mjs';
import { isUnitPresentationMessage } from '../contracts/domains/tokens.mjs';
import { isExecutionMessage } from '../contracts/domains/execution.mjs';

/* -------------------------------------------- */
/*  Unit presentation gateway                   */
/* -------------------------------------------- */
/** The wrapper a host broadcast travels in. Its session and sequence let receivers drop repeats and stale messages. */
const PRESENTATION_DELIVERY_KIND = 'presentation-delivery';
const PRESENTATION_DELIVERY_KEYS = Object.freeze(['kind', 'session', 'sequence', 'audience', 'message']);
const MAX_PRESENTATION_AUDIENCE = 64;

/** The longest the rules wait on one message, whatever the delivery policy asks for. */
const MAX_PRESENTATION_HOLD_MS = 15000;

/**
 * Send animations and notices from the host client to the other clients through socketlib, and to the host's own
 * presenter. The delivery policy in presentation/interface/delivery.mjs sets how long the rules pause for each
 * message and what a hidden client skips. The rules wait that set time, never for the animation itself.
 */
export class UnitPresentationGateway {
  #sequence = 0;
  #session = '';
  #lastSequence = 0;

  constructor({ transport, onMessage, identity, diagnostics, delivery }) {
    requirePorts('UnitPresentationGateway', { transport, onMessage, identity, diagnostics, delivery });
    this.transport = transport;
    this.onMessage = onMessage;
    this.identity = identity;
    this.diagnostics = diagnostics;
    this.delivery = delivery;
  }

  /**
   * Broadcast a presentation message, start the host's presenter and wait the pause the delivery policy sets.
   * @param {object} message A presentation message.
   * @param {{audience?: string[]|null}} [options] The only users who should show it, or everyone when omitted.
   *   It is not private: every client still receives it.
   * @returns {Promise<boolean>} Whether the message was accepted and sent.
   */
  async broadcast(message, { audience = null } = {}) {
    if (!isSupportedPresentationMessage(message) || !this.identity.localUserIsActiveGm()) return false;
    const recipients = audience === null || audience === undefined ? null : normalizeAudience(audience);
    if (recipients === false) return false;
    const delivery = Object.freeze({
      kind: PRESENTATION_DELIVERY_KIND,
      session: String(this.identity.sessionId() ?? ''),
      sequence: ++this.#sequence,
      audience: recipients,
      message
    });
    this.#send(delivery);
    if (!recipients || recipients.includes(this.#localUserId())) this.#present(message, { host: true });
    await this.#hold(message);
    return true;
  }

  /**
   * Show a message from the host user if this user is in its audience. `userId` is set by the Foundry server, so
   * only the host user gets past the sender check. Drop duplicate or older messages from the same host tab.
   * @returns {Promise<boolean>} Whether the presenter was started here.
   */
  async receive(payload, userId) {
    const delivery = readPresentationDelivery(payload);
    const hostId = this.identity.activeGmId();
    if (!delivery || !hostId || String(userId ?? '') !== String(hostId)) return false;
    if (delivery.audience && !delivery.audience.includes(this.#localUserId())) return false;
    if (!this.#admit(delivery)) return false;
    return this.#present(delivery.message, { host: false });
  }

  /**
   * Send a stamped message through the transport without waiting for it to render: addressed to the audience's
   * other users when it names one, otherwise to every other client. socketlib still has the server relay it to
   * every client, and receive() drops it where the user isn't in the audience.
   */
  #send(delivery) {
    if (!this.transport.ready) return;
    const local = this.#localUserId();
    const recipients = delivery.audience ? delivery.audience.filter(id => id !== local) : null;
    if (recipients && !recipients.length) return;
    try {
      const sending = recipients
        ? this.transport.executeForUsers(recipients, delivery)
        : this.transport.executeForOthers(delivery);
      void Promise.resolve(sending).catch(error => this.#record(error, delivery.message));
    } catch (error) {
      this.#record(error, delivery.message);
    }
  }

  /** Start the local presenter under the delivery policy. Hidden clients skip transient rendering. */
  #present(message, { host }) {
    try {
      if (this.delivery.hidden() && !this.delivery.deliversWhileHidden(message, { host })) return false;
      void Promise.resolve(this.onMessage(message)).catch(error => this.#record(error, message));
      return true;
    } catch (error) {
      this.#record(error, message);
      return false;
    }
  }

  async #hold(message) {
    let hold = 0;
    try {
      hold = Number(this.delivery.holdMs(message)) || 0;
    } catch (error) {
      this.#record(error, message);
    }
    if (hold > 0) await this.delivery.wait(Math.min(hold, MAX_PRESENTATION_HOLD_MS));
  }

  /** Whether a stamped message is new for the host tab that sent it. */
  #admit({ session, sequence }) {
    if (session !== this.#session) {
      this.#session = session;
      this.#lastSequence = sequence;
      return true;
    }
    if (sequence <= this.#lastSequence) return false;
    this.#lastSequence = sequence;
    return true;
  }

  #localUserId() {
    return String(this.identity.localUserId() ?? '');
  }

  #record(error, message) {
    this.diagnostics.record(createDiagnostic({ sourcePath: import.meta.url,
      source: DIAGNOSTIC_SOURCES.PRESENTATION, detail: String(message?.kind ?? ''), error
    }));
  }
}

const PRESENTATION_MESSAGE_VALIDATORS = Object.freeze([
  isUnitPresentationMessage,
  isStanceBreakPresentationMessage,
  isHealthPresentationMessage,
  isDefeatPresentationMessage,
  isCombatPresentationMessage,
  isEffectPresentationMessage,
  isBannerPresentationMessage,
  isPhaseCameraPresentationMessage,
  isEnemyPhaseCameraMessage,
  isItemActivationPresentationMessage,
  isObjectPresentationMessage,
  isEconomyPresentationMessage,
  isDowntimePresentationMessage,
  isProgressionPresentationMessage,
  isProgressionFeatureNoticeMessage,
  isTerrainSpawnPresentationMessage,
  isExecutionMessage,
  isInventoryRefusalPresentationMessage,
  isInventoryCapacityNoticeMessage
]);

function isSupportedPresentationMessage(message) {
  return PRESENTATION_MESSAGE_VALIDATORS.some(accepts => accepts(message));
}

/** Decode input for UnitPresentationGateway.receive: a delivery broadcast() stamped with the host tab's session id. */
function readPresentationDelivery(payload) {
  if (!plainRecord(payload) || payload.kind !== PRESENTATION_DELIVERY_KIND) return null;
  if (!exactKeys(payload, PRESENTATION_DELIVERY_KEYS)) return null;
  if (!boundedText(payload.session, 128)) return null;
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return null;
  const audience = payload.audience === null ? null : normalizeAudience(payload.audience);
  if (audience === false || !isSupportedPresentationMessage(payload.message)) return null;
  return { session: payload.session, sequence: payload.sequence, audience, message: payload.message };
}

/** A bounded list of distinct user ids, or false when the value is not one. */
function normalizeAudience(audience) {
  if (!Array.isArray(audience) || audience.length > MAX_PRESENTATION_AUDIENCE) return false;
  const ids = audience.map(id => String(id ?? ''));
  return ids.every(id => boundedText(id, 128)) ? Object.freeze([...new Set(ids)]) : false;
}
