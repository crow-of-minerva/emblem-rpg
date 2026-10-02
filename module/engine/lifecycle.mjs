/** @layer engine */
import { COMMAND_LANES } from '../contracts/commands.mjs';
import { EXECUTION_LIFECYCLE } from '../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Startup lifecycle                           */
/* -------------------------------------------- */

const ORDER = Object.freeze([
  EXECUTION_LIFECYCLE.STARTING,
  EXECUTION_LIFECYCLE.RECOVERING,
  EXECUTION_LIFECYCLE.MAINTAINING,
  EXECUTION_LIFECYCLE.READY
]);

/** Command lanes (kinds of command) startup never holds back: read-only, table recovery, and child commands. */
const ALWAYS_ADMITTED = Object.freeze([COMMAND_LANES.INSPECT, COMMAND_LANES.RECOVERY, COMMAND_LANES.CHILD]);
const MAINTENANCE_LANES = Object.freeze([COMMAND_LANES.MAINTENANCE, COMMAND_LANES.STARTUP]);

const ADMITTED_LANES = Object.freeze({
  [EXECUTION_LIFECYCLE.STARTING]: new Set(ALWAYS_ADMITTED),
  [EXECUTION_LIFECYCLE.RECOVERING]: new Set(ALWAYS_ADMITTED),
  [EXECUTION_LIFECYCLE.MAINTAINING]: new Set([...ALWAYS_ADMITTED, ...MAINTENANCE_LANES]),
  [EXECUTION_LIFECYCLE.READY]: new Set(Object.values(COMMAND_LANES))
});

/**
 * Decide which kinds of command CommandDispatcher accepts while the host client starts up. RECOVERING is where the
 * host restores whatever undo record an interrupted page left open. MAINTAINING allows the ready-time clean-up jobs
 * and startup sweeps, and READY allows gameplay. State only moves forward; a reloaded host gets a new lifecycle
 * from init/system.mjs.
 */
export class ExecutionLifecycle {
  #state = EXECUTION_LIFECYCLE.STARTING;

  get state() {
    return this.#state;
  }

  /**
   * Move to a later startup state.
   * @param {string} next One of {@link EXECUTION_LIFECYCLE}.
   * @returns {boolean} False when `next` is not later than the current state, which is then left unchanged.
   */
  advance(next) {
    if (ORDER.indexOf(next) <= ORDER.indexOf(this.#state)) return false;
    this.#state = next;
    return true;
  }

  /** Whether a command in this lane may run in the current state. */
  admits(lane) {
    return ADMITTED_LANES[this.#state].has(lane);
  }
}
