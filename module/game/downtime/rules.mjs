/** @layer game/downtime */
import { DOWNTIME_ENERGY_BASE, DOWNTIME_LANES } from '../../contracts/domains/downtime.mjs';

/* -------------------------------------------- */
/*  Commitment                                  */
/* -------------------------------------------- */
/** A cleared commitment, written when a downtime begins. */
export const DOWNTIME_CLEARED = Object.freeze({ lane: null, action: '', exhausted: false });

/** A unit's commitment normalised, so a unit that never acted reads the same as a cleared one. */
export function downtimeCommitment(raw) {
  return Object.freeze({
    lane: Object.values(DOWNTIME_LANES).includes(raw?.lane) ? raw.lane : null,
    action: String(raw?.action ?? ''),
    exhausted: raw?.exhausted === true
  });
}

/** The Energy a unit may hold: the base every unit shares, raised only by passive modifiers. */
export function energyCapacity(mod = 0) {
  return Math.max(0, DOWNTIME_ENERGY_BASE + (Math.floor(Number(mod)) || 0));
}

/* -------------------------------------------- */
/*  Eligibility                                 */
/* -------------------------------------------- */
const DEFEATED_BLOCK = 'Defeated';

/**
 * The blocker for a unit left at 0 HP (`defeated` in the roster projection), or empty for a unit still standing.
 * participantBlock applies it to every performer. Rows that skip the lane checks apply it directly: the diners in
 * planCooking, the accompaniments and audience in planPerformance, and the matching views in
 * engine/downtime/commands.mjs.
 */
export function defeatedBlock(unit) {
  return unit?.defeated === true ? DEFEATED_BLOCK : '';
}

/**
 * The first reason a unit can't join a downtime activity, checked in order: ownership, defeat, exhaustion, a
 * commitment to the other lane, then Energy. Empty when nothing blocks it. A row without ownership facts counts as
 * owned.
 */
function participantBlock({ commitment, energy = 0, lane, energyCost = 0, owned = true, defeated = false }) {
  const state = downtimeCommitment(commitment);
  const cost = Math.max(0, Number(energyCost) || 0);
  if (owned === false) return 'Not your unit';
  if (defeated === true) return DEFEATED_BLOCK;
  if (state.exhausted) return 'Exhausted';
  if (state.lane && state.lane !== lane) return 'Committed to another activity';
  if (lane === DOWNTIME_LANES.ENERGY && (Number(energy) || 0) < cost) return `Needs ${cost} Energy`;
  return '';
}

/**
 * Mark each roster row eligible, or blocked with its reason, for one lane. The downtime planners and the menu views
 * in engine/downtime/commands.mjs build their performer rows with it.
 */
export function resolveParticipants(roster = [], { lane, energyCost = 0 } = {}) {
  return Object.freeze(roster.map(entry => {
    const blocked = participantBlock({
      commitment: entry.commitment, energy: entry.energy?.value, lane, energyCost, owned: entry.owned,
      defeated: entry.defeated
    });
    return Object.freeze({ ...entry, blocked, eligible: !blocked });
  }));
}

/**
 * Why a unit cannot pay `cost` Energy for an Energy-lane act outside the downtime menus, or empty when it can.
 * planLockOpening in game/objects/rules.mjs asks it for a lockpick in free exploration. The command authorizes the
 * unit's Token, so ownership is not a block here.
 */
export function energyLaneBlock({ commitment, energy = 0 } = {}, cost = 0) {
  return participantBlock({ commitment, energy, lane: DOWNTIME_LANES.ENERGY, energyCost: cost });
}

/* -------------------------------------------- */
/*  Spending                                    */
/* -------------------------------------------- */
/**
 * The Energy and commitment an Energy-lane activity leaves a unit with, for gathering, forging and brewing in
 * engine/downtime/resolvers.mjs and a lockpick in engine/objects/interaction.mjs. Spending the last Energy exhausts
 * the unit.
 */
export function energyLaneSpend({ energy = 0, cost = 0, label = '' } = {}) {
  const remaining = Math.max(0, (Number(energy) || 0) - Math.max(0, Number(cost) || 0));
  return Object.freeze({
    energy: remaining,
    commitment: Object.freeze({ lane: DOWNTIME_LANES.ENERGY, action: String(label), exhausted: remaining <= 0 })
  });
}

/**
 * The Action-lane commitment engine/downtime/resolvers.mjs records for cooking, performing, requisitions,
 * socializing and training, and engine/economy/trade.mjs records for a haggle. It exhausts the unit at once.
 */
export function actionLaneSpend(label = '') {
  return Object.freeze({ lane: DOWNTIME_LANES.ACTION, action: String(label), exhausted: true });
}

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
/**
 * The Energy a unit still has to report, read by the exploration roster in ui/apps/foundry/combat-tracker.mjs.
 * Only an Energy-lane commitment (gathering, forging, brewing or lockpicking) leaves Energy worth watching. An
 * Action-lane activity exhausts the unit as it finishes, and an uncommitted unit is still at the capacity exploration
 * refilled.
 * @returns {?{value: number, max: number, action: string}} Null when there is nothing to report.
 */
export function resolveCommittedEnergy({ commitment, energy = 0, energyMax = 0 } = {}) {
  const state = downtimeCommitment(commitment);
  if (state.lane !== DOWNTIME_LANES.ENERGY) return null;
  const max = Math.max(0, Math.floor(Number(energyMax)) || 0);
  if (max <= 0) return null;
  const value = Math.max(0, Math.min(max, Math.floor(Number(energy)) || 0));
  return { value, max, action: state.action };
}

/* -------------------------------------------- */
/*  Staff administration                        */
/* -------------------------------------------- */
/**
 * Whether the GM's Reset Downtime Activity is worth offering: the unit is exhausted, or it spent Energy that
 * free exploration had refilled. A unit that has not worked yet has nothing to reset.
 */
export function downtimeResetAvailable({ commitment, energy = 0, energyMax = 0 } = {}) {
  return downtimeCommitment(commitment).exhausted === true || energySpent({ energy, energyMax }) > 0;
}

/**
 * Whether the GM's Restore Energy is worth offering: the unit is committed to the Energy lane and has spent some
 * of its capacity. An Action-lane unit has no Energy to hand back, and a full one needs none.
 */
export function energyRestoreAvailable({ commitment, energy = 0, energyMax = 0 } = {}) {
  const report = resolveCommittedEnergy({ commitment, energy, energyMax });
  return report !== null && report.value < report.max;
}

/**
 * Plan the reset engine/downtime/commands.mjs writes: capacity back and the commitment cleared, which is what
 * free exploration itself hands every unit in planExplorationTurnUpdates.
 */
export function planDowntimeReset({ energyMax = 0 } = {}) {
  return Object.freeze({ energy: wholeNumber(energyMax), commitment: DOWNTIME_CLEARED });
}

/**
 * Plan one Energy restoration, capped at the unit's capacity. The lane commitment stands, so the unit resumes
 * the activity it started. Exhaustion lifts, because the restored unit has Energy again.
 * @returns {?Readonly<{energy: number, restored: number, commitment: object}>} Null when nothing would change.
 */
export function planEnergyRestore({ commitment, energy = 0, energyMax = 0, amount = 0 } = {}) {
  const max = wholeNumber(energyMax);
  const current = Math.min(max, wholeNumber(energy));
  const energyAfter = Math.min(max, current + wholeNumber(amount));
  if (energyAfter <= current) return null;
  return Object.freeze({
    energy: energyAfter,
    restored: energyAfter - current,
    commitment: Object.freeze({ ...downtimeCommitment(commitment), exhausted: false })
  });
}

/** How much of a unit's Energy capacity is gone, which is what makes a reset worth offering. */
function energySpent({ energy, energyMax }) {
  const max = wholeNumber(energyMax);
  return Math.max(0, max - Math.min(max, wholeNumber(energy)));
}

function wholeNumber(value) {
  return Math.max(0, Math.floor(Number(value)) || 0);
}

/* -------------------------------------------- */
/*  Roster                                      */
/* -------------------------------------------- */
/**
 * Everyone present who shares the driving unit's party (`partyId`). A unit in no party works alone: its roster is
 * itself, so it can work a station but can pair with, feed, accompany or affect nobody. A driving unit that is not
 * present has no roster.
 */
export function narrowRoster(present = [], cursorActorUuid = null) {
  const cursor = present.find(entry => entry.actorUuid === cursorActorUuid) ?? null;
  if (!cursor) return Object.freeze([]);
  if (!cursor.partyId) return Object.freeze([cursor]);
  return Object.freeze(present.filter(entry => entry.partyId === cursor.partyId));
}

/** The roster with the driving unit at its head and everyone else in the order they were placed. */
export function leadRoster(roster = [], cursorActorUuid = null) {
  const lead = roster.filter(entry => entry.actorUuid === cursorActorUuid);
  return Object.freeze([...lead, ...roster.filter(entry => entry.actorUuid !== cursorActorUuid)]);
}

