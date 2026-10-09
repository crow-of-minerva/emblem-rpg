/** @layer foundry/adapters/services */

/* -------------------------------------------- */
/*  Committed events                            */
/* -------------------------------------------- */
/**
 * The local committed-event bus, on Foundry hooks: every event goes to emblemRpgCommittedEvent and to
 * emblemRpg.<type>. Built in init/system.mjs and handed to the engine as `events`.
 */
export class FoundryEventPublisher {
  /**
   * Publish an event. When the caller passes its dispatcher `operation`, Operation#onCommit
   * (engine/recovery/operations.mjs) holds the event until that operation commits, and a restore drops it. Otherwise
   * the event is published at once, even from inside a running command.
   * @param {string} type The event id.
   * @param {object} data The event payload.
   * @param {{operation?: *}} [options] The operation the event belongs to, when it was raised inside one.
   * @returns {object} The event, or a frozen `{type, data, deferred: true}` while the operation is still open.
   */
  publish(type, data, { operation = null } = {}) {
    const payload = Object.freeze({ ...data });
    if (typeof operation?.onCommit === 'function') {
      operation.onCommit(() => { this.publish(type, payload); });
      return Object.freeze({ type, data: payload, deferred: true });
    }
    const event = Object.freeze({
      type,
      data: payload,
      committedAt: Date.now()
    });
    Hooks.callAll('emblemRpgCommittedEvent', event);
    Hooks.callAll(`emblemRpg.${type}`, event);
    return event;
  }

  /** Subscribe to one event type, or to every event when `type` is empty. Returns the unsubscribe function. */
  subscribe(type, handler) {
    const hook = type ? `emblemRpg.${type}` : 'emblemRpgCommittedEvent';
    const id = Hooks.on(hook, handler);
    return () => Hooks.off(hook, id);
  }
}
