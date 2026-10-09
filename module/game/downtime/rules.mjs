/** @layer game/downtime */
import { DOWNTIME_ENERGY_BASE, DOWNTIME_LANES } from '../../contracts/domains/downtime.mjs';

/* -------------------------------------------- */
/*  Commitment                                  */
/* -------------------------------------------- */
/** A cleared commitment, written when a downtime begins. */
export const DOWNTIME_CLEARED = Object.freeze({ lane: null, action: '', exhausted: false });

/**
 * A unit's commitment this downtime: which kind of activity it took (`lane`: Energy or Action), what it did, and
 * whether it is exhausted. A unit that never acted reads the same as a cleared one.
 */
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

/** 'Defeated' for a unit at 0 HP (`defeated`), otherwise empty. Units at 0 HP take no part in downtime. */
export function defeatedBlock(unit) {
  return unit?.defeated === true ? DEFEATED_BLOCK : '';
}

/**
 * The first reason a unit can't join a downtime activity, checked in order: ownership, defeat, exhaustion, already
 * doing an activity of the other kind, then Energy. Empty when nothing blocks it. A unit with no `owned` value counts
 * as owned.
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

/** Mark each roster row eligible, or blocked with its reason, for one kind of activity. */
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
 * Why a unit cannot pay `cost` Energy for an Energy activity outside the downtime menus, such as picking a lock in
 * free exploration, or empty when it can. Ownership is not checked; the command already checks the unit's Token.
 */
export function energyLaneBlock({ commitment, energy = 0 } = {}, cost = 0) {
  return participantBlock({ commitment, energy, lane: DOWNTIME_LANES.ENERGY, energyCost: cost });
}

/* -------------------------------------------- */
/*  Spending                                    */
/* -------------------------------------------- */
/**
 * The Energy and commitment an Energy activity (gathering, forging, brewing or picking a lock) leaves a unit with.
 * Spending the last Energy exhausts the unit.
 */
export function energyLaneSpend({ energy = 0, cost = 0, label = '' } = {}) {
  const remaining = Math.max(0, (Number(energy) || 0) - Math.max(0, Number(cost) || 0));
  return Object.freeze({
    energy: remaining,
    commitment: Object.freeze({ lane: DOWNTIME_LANES.ENERGY, action: String(label), exhausted: remaining <= 0 })
  });
}

/**
 * The commitment an Action activity records: cooking, performing, a requisition, socializing, training or a haggle.
 * It exhausts the unit at once.
 */
export function actionLaneSpend(label = '') {
  return Object.freeze({ lane: DOWNTIME_LANES.ACTION, action: String(label), exhausted: true });
}

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
/**
 * The Energy to show on the exploration tracker. Only a unit part-way through an Energy activity has any to show.
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
/*  GM tools                                    */
/* -------------------------------------------- */
/**
 * Whether the GM's Reset Downtime Activity is worth offering: the unit is exhausted, or it spent Energy that
 * free exploration had refilled. A unit that has not worked yet has nothing to reset.
 */
export function downtimeResetAvailable({ commitment, energy = 0, energyMax = 0 } = {}) {
  return downtimeCommitment(commitment).exhausted === true || energySpent({ energy, energyMax }) > 0;
}

/**
 * Whether the GM's Restore Energy is worth offering: the unit is doing an Energy activity and has spent some of its
 * capacity. A unit doing an Action activity has no Energy to hand back, and a full one needs none.
 */
export function energyRestoreAvailable({ commitment, energy = 0, energyMax = 0 } = {}) {
  const report = resolveCommittedEnergy({ commitment, energy, energyMax });
  return report !== null && report.value < report.max;
}

/**
 * Plan a GM's downtime reset: Energy back to capacity and the commitment cleared, the same as free exploration
 * gives every unit (planExplorationTurnUpdates).
 */
export function planDowntimeReset({ energyMax = 0 } = {}) {
  return Object.freeze({ energy: wholeNumber(energyMax), commitment: DOWNTIME_CLEARED });
}

/**
 * Plan one Energy restoration, capped at the unit's capacity. The commitment stands, so the unit resumes
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
 * Everyone present who shares the acting unit's party (`partyId`); `cursorActorUuid` names the acting unit. A unit
 * in no party works alone: its roster is itself, so it can work a station but can pair with, feed, accompany or
 * affect nobody. An acting unit that is not present has no roster.
 */
export function narrowRoster(present = [], cursorActorUuid = null) {
  const cursor = present.find(entry => entry.actorUuid === cursorActorUuid) ?? null;
  if (!cursor) return Object.freeze([]);
  if (!cursor.partyId) return Object.freeze([cursor]);
  return Object.freeze(present.filter(entry => entry.partyId === cursor.partyId));
}

/** The roster with the acting unit at its head and everyone else in the order they were placed. */
export function leadRoster(roster = [], cursorActorUuid = null) {
  const lead = roster.filter(entry => entry.actorUuid === cursorActorUuid);
  return Object.freeze([...lead, ...roster.filter(entry => entry.actorUuid !== cursorActorUuid)]);
}

