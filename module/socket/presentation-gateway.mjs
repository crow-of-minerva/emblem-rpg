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

/** The longest one message may hold up the mechanics, whatever the delivery policy asks for. */
const MAX_PRESENTATION_HOLD_MS = 15000;

/**
 * Deliver engine presentation messages to the other clients through socketlib and to the host's own presenter.
 * The delivery policy in presentation/interface/delivery.mjs sets how long each message holds the mechanics and
 * what a hidden client skips. The engine waits for that hold, never for rendering to finish.
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
   * Broadcast an engine presentation message, start the host's presenter and wait for the delivery policy's hold.
   * @param {object} message A presentation message.
   * @param {{audience?: string[]|null}} [options] The only users who should present it, or everyone when omitted.
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
   * Pass an authenticated host message to the local presenter if its audience and sequence match.
   * Drop duplicate or older messages from the same host session.
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
   * Send a stamped message through the transport without awaiting rendering: to the audience's other users alone
   * when the message names one, otherwise to every other client. receive() still checks the audience on arrival.
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

  /** Whether a stamped message is new for its host page. */
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

/** Decode input for UnitPresentationGateway.receive: a delivery broadcast() stamped with its host page session. */
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
