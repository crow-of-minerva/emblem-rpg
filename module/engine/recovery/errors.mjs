/** @layer engine/recovery */

/**
 * Signal stale combat facts to engine/combat/exchanges/resolution.mjs, which refuses the exchange with
 * `COMBAT_EXCHANGE_STALE` and lets CommandDispatcher restore the operation.
 */
export class StaleCombatError extends Error {}

/** Name a refused write so the refusal an engine settlement returns carries the reason the writer gave. */
export class CombatPersistenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
