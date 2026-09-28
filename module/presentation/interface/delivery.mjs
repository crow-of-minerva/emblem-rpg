/** @layer presentation/interface */
import { EXECUTION_PRESENTATION_KIND } from '../../contracts/domains/execution.mjs';
import {
  COMBAT_PRESENTATION_BEATS,
  COMBAT_PRESENTATION_KIND,
  EFFECT_OPERATION_PRESENTATION_KIND,
  ENEMY_PHASE_CAMERA_BEATS,
  ENEMY_PHASE_CAMERA_PRESENTATION_KIND
} from '../../contracts/domains/combat.mjs';
import {
  DEFEAT_PRESENTATION_KIND,
  DEFEAT_PRESENTATION_TYPES,
  HEALTH_CHANGE_TYPES,
  HEALTH_PRESENTATION_KIND
} from '../../contracts/domains/damage.mjs';
import { DOWNTIME_PRESENTATION_EVENTS, DOWNTIME_PRESENTATION_KIND } from '../../contracts/domains/downtime.mjs';
import { ECONOMY_PRESENTATION_KIND } from '../../contracts/domains/economy.mjs';
import {
  ITEM_ACTIVATION_PRESENTATION_BEATS,
  ITEM_ACTIVATION_PRESENTATION_KIND
} from '../../contracts/domains/items.mjs';
import { PROGRESSION_PRESENTATION_KIND } from '../../contracts/domains/progression.mjs';
import { createPacingClock } from '../../lib/dom/pacing-clock.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';
import { activationBeatHoldMs, combatBeatHoldMs, effectOperationHoldMs } from '../canvas/combat-exchange.mjs';
import { healthBeatHoldMs } from '../canvas/unit-feedback.mjs';
import { progressionBeatHoldMs } from '../graphics/progression.mjs';
import { downtimeBeatHoldMs } from './chat-cards.mjs';

/* -------------------------------------------- */
/*  Delivery vocabulary                         */
/* -------------------------------------------- */

/** How long the host waits after each kind of presentation message. A kind missing here gets no wait. */
const HOLDS = Object.freeze({
  [COMBAT_PRESENTATION_KIND]: combatBeatHoldMs,
  [ITEM_ACTIVATION_PRESENTATION_KIND]: activationBeatHoldMs,
  [EFFECT_OPERATION_PRESENTATION_KIND]: effectOperationHoldMs,
  [HEALTH_PRESENTATION_KIND]: healthBeatHoldMs,
  [PROGRESSION_PRESENTATION_KIND]: progressionBeatHoldMs,
  [DOWNTIME_PRESENTATION_KIND]: downtimeBeatHoldMs
});

const DOWNTIME_END_EVENTS = new Set([
  DOWNTIME_PRESENTATION_EVENTS.GATHER_END, DOWNTIME_PRESENTATION_EVENTS.FORGE_END,
  DOWNTIME_PRESENTATION_EVENTS.BREW_END, DOWNTIME_PRESENTATION_EVENTS.COOK_END,
  DOWNTIME_PRESENTATION_EVENTS.PERFORM_END, DOWNTIME_PRESENTATION_EVENTS.SOCIAL_END,
  DOWNTIME_PRESENTATION_EVENTS.TRAIN_END, DOWNTIME_PRESENTATION_EVENTS.REQUISITION_END
]);
const DOWNTIME_CARD_EVENTS = new Set([
  DOWNTIME_PRESENTATION_EVENTS.GATHER_SETTLED, DOWNTIME_PRESENTATION_EVENTS.FORGE_SETTLED,
  DOWNTIME_PRESENTATION_EVENTS.BREW_SETTLED, DOWNTIME_PRESENTATION_EVENTS.COOK_SETTLED,
  DOWNTIME_PRESENTATION_EVENTS.PERFORM_SETTLED, DOWNTIME_PRESENTATION_EVENTS.SOCIAL_SETTLED,
  DOWNTIME_PRESENTATION_EVENTS.TRAIN_SETTLED, DOWNTIME_PRESENTATION_EVENTS.REQUISITION_SETTLED
]);
/** The spar's opening beat turns both tokens to face each other, which is a token write only the host makes. */
const DOWNTIME_HOST_WRITES = new Set([...DOWNTIME_CARD_EVENTS, DOWNTIME_PRESENTATION_EVENTS.TRAIN_BEGIN]);
const COMBAT_HOST_WRITES = new Set([
  COMBAT_PRESENTATION_BEATS.START, COMBAT_PRESENTATION_BEATS.ATTACK,
  COMBAT_PRESENTATION_BEATS.IMPACT, COMBAT_PRESENTATION_BEATS.RANK_UP
]);
const ACTIVATION_HOST_WRITES = new Set([
  ITEM_ACTIVATION_PRESENTATION_BEATS.LEAD_IN, ITEM_ACTIVATION_PRESENTATION_BEATS.CAST,
  ITEM_ACTIVATION_PRESENTATION_BEATS.DAMAGE_CARD, ITEM_ACTIVATION_PRESENTATION_BEATS.RANK_UP
]);

/* -------------------------------------------- */
/*  Delivery policy                             */
/* -------------------------------------------- */

/**
 * How long the engine waits after sending this presentation message, from its authored or fixed duration.
 * UnitPresentationGateway waits this long on the host whatever any client has drawn.
 * @param {object} message A validated presentation message.
 * @returns {number} Milliseconds, never negative.
 */
export function presentationHoldMs(message) {
  const hold = Number(HOLDS[message?.kind]?.(message));
  return Number.isFinite(hold) && hold > 0 ? hold : 0;
}

/**
 * Whether a hidden page should still run this message. UnitPresentationGateway asks only while the page is hidden.
 *
 * Every client applies the messages that release state (releasesState): the processing blocker, the end of an
 * exchange, activation or enemy-phase camera, a cleared defeat fade, a pathfinding refresh and a downtime end. The
 * host also runs the beats in writesForTable, which post chat cards or change tokens for the whole table. Its
 * health and defeat-fade entries have no effect: those beats write nothing, and HealthPresentation drops them on a
 * hidden page. Everything else, notices included, is dropped rather than queued, so a hidden page shows no toast
 * and replays nothing when it returns.
 * @param {object} message A validated presentation message.
 * @param {{host?: boolean}} [options] Whether this client is the host presenting its own beat.
 * @returns {boolean}
 */
export function deliversWhileHidden(message, { host = false } = {}) {
  if (releasesState(message)) return true;
  return host === true && writesForTable(message);
}

/**
 * The delivery object UnitPresentationGateway paces and filters with: the holds, the hidden-page policy, this
 * page's visibility, and a clock a background page can't slow. init/system.mjs builds one and also hands its
 * `wait`, `schedule` and `cancelScheduled` to TokenArtTransitionCoordinator, CombatPresentation and other services.
 * @param {object} [options]
 * @param {Function} [options.hidden] Whether this page is hidden now.
 * @param {{wait: Function}} [options.clock] The clock holds are waited on.
 * @returns {Readonly<{holdMs: Function, deliversWhileHidden: Function, hidden: Function, wait: Function,
 *   schedule: Function, cancelScheduled: Function}>}
 */
export function createPresentationDelivery({ hidden = pageHidden, clock = createPacingClock() } = {}) {
  return Object.freeze({
    holdMs: presentationHoldMs,
    deliversWhileHidden,
    hidden,
    wait: milliseconds => clock.wait(milliseconds),
    schedule: (callback, milliseconds) => scheduleOnClock(clock, callback, milliseconds),
    cancelScheduled: handle => { if (handle) handle.cancelled = true; }
  });
}

/**
 * Run one callback after a wait on the pacing clock, unless its handle is cancelled first.
 *
 * The host times table-wide art swaps and reverts this way, so a background page lands them on the beat instead of
 * one throttled wake-up or more later.
 * @param {{wait: Function}} clock The pacing clock.
 * @param {Function} callback What runs once the wait ends.
 * @param {number} milliseconds How long to wait.
 * @returns {{cancelled: boolean}} The handle cancelScheduled takes.
 */
function scheduleOnClock(clock, callback, milliseconds) {
  const handle = { cancelled: false };
  void Promise.resolve(clock.wait(milliseconds)).then(() => { if (!handle.cancelled) callback(); });
  return handle;
}

/* -------------------------------------------- */
/*  Beat classes                                */
/* -------------------------------------------- */

function releasesState(message) {
  switch (message?.kind) {
    case EXECUTION_PRESENTATION_KIND: return true;
    case COMBAT_PRESENTATION_KIND: return message.beat === COMBAT_PRESENTATION_BEATS.END;
    case ITEM_ACTIVATION_PRESENTATION_KIND: return message.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.END;
    case ENEMY_PHASE_CAMERA_PRESENTATION_KIND: return message.beat === ENEMY_PHASE_CAMERA_BEATS.END;
    case DEFEAT_PRESENTATION_KIND: return message.change === DEFEAT_PRESENTATION_TYPES.CLEAR_FADE;
    case EFFECT_OPERATION_PRESENTATION_KIND: return message.operation?.step?.kind === 'refreshPathfinding';
    case DOWNTIME_PRESENTATION_KIND: return DOWNTIME_END_EVENTS.has(message.event);
    default: return false;
  }
}

function writesForTable(message) {
  switch (message?.kind) {
    case COMBAT_PRESENTATION_KIND: return COMBAT_HOST_WRITES.has(message.beat);
    case ITEM_ACTIVATION_PRESENTATION_KIND: return ACTIVATION_HOST_WRITES.has(message.beat);
    case EFFECT_OPERATION_PRESENTATION_KIND: return message.operation?.step?.kind === 'animation';
    case HEALTH_PRESENTATION_KIND: return message.change !== HEALTH_CHANGE_TYPES.HEAL;
    case DEFEAT_PRESENTATION_KIND: return message.change === DEFEAT_PRESENTATION_TYPES.FADE;
    case ECONOMY_PRESENTATION_KIND: return true;
    case DOWNTIME_PRESENTATION_KIND: return DOWNTIME_HOST_WRITES.has(message.event);
    default: return false;
  }
}
