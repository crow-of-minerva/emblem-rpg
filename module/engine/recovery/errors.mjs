/** @layer engine/recovery */

/**
 * Thrown when combat data changed after it was read. engine/combat/exchanges/resolution.mjs refuses the exchange
 * with `COMBAT_EXCHANGE_STALE`, and CommandDispatcher undoes the command's writes.
 */
export class StaleCombatError extends Error {}

/** A write that failed, in combat, object, movement, trade or item-use code. `code` says why; the command is undone. */
export class CombatPersistenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
