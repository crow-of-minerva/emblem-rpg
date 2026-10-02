/** @layer game/combat */
import {
  ENCOUNTER_PHASES,
  ENCOUNTER_PHASE_FACTIONS,
  OBJECTIVE_CHECK_KINDS,
  OBJECTIVE_END_CHECKPOINTS,
  OBJECTIVE_END_REASONS,
  OBJECTIVE_END_RETRY,
  ROUT_FACTIONS,
  SETTLE_BARRIER_TIMING,
  normalizeObjectiveCard
} from '../../contracts/domains/combat.mjs';

/* -------------------------------------------- */
/*  Authored specification                      */
/* -------------------------------------------- */

/** Clean up the objectives saved on a Scene, for the encounter code and the objective editor. */
export function normalizeObjectiveSpec(raw) {
  const list = Array.isArray(raw?.objectives) ? raw.objectives : [];
  const objectives = list.map(normalizeObjectiveCard).filter(Boolean);
  const loss = raw?.loss && typeof raw.loss === 'object' ? raw.loss : {};
  return Object.freeze({
    objectives: Object.freeze(objectives),
    roundLimit: positiveInteger(raw?.roundLimit, 0),
    loss: Object.freeze({
      anyLordDefeat: loss.anyLordDefeat === true,
      protectedUnits: cleanRefs(loss.protectedUnits)
    })
  });
}

/** Whether an objective owns the round deadline, leaving the GM's own limit unusable. */
export function roundLimitLocked(objectives) {
  return (objectives ?? []).some(entry => entry?.type === 'survive' || entry?.type === 'defend');
}

/**
 * The round deadline in play, and whether reaching it wins or loses the map. The shortest Survive or Defend deadline
 * wins it. Without one, the GM's round limit loses it.
 */
export function deadlineFor(objectives, roundLimit) {
  const deadlines = [];
  for (const objective of objectives ?? []) {
    if (objective?.type === 'survive') deadlines.push(Number(objective.surviveTurns));
    else if (objective?.type === 'defend') deadlines.push(Number(objective.defendTurns));
  }
  const valid = deadlines.filter(number => Number.isFinite(number) && number > 0);
  if (valid.length) return { limit: Math.min(...valid), kind: 'victory' };
  const limit = Number(roundLimit);
  if (Number.isFinite(limit) && limit > 0) return { limit, kind: 'failure' };
  return { limit: 0, kind: null };
}

/** Whether a deadline has arrived, counted in rounds ended, not rounds begun. */
function deadlineReached(deadline, roundEnded) {
  if (!deadline.kind || !(deadline.limit > 0)) return false;
  return Number(roundEnded) >= deadline.limit;
}

/* -------------------------------------------- */
/*  Objective points                            */
/* -------------------------------------------- */

/**
 * Every terrain key a unit's footprint covers, so a large unit partly on a point counts. The `row-col` keys are
 * built by hand and must match terrainKey() in contracts/domains/terrain.mjs.
 */
function footprintKeys({ x, y, width, height }, gridSize) {
  const size = Number(gridSize);
  if (!Number.isFinite(size) || size <= 0) return [];
  const column = Math.floor(Number(x) / size);
  const row = Math.floor(Number(y) / size);
  const across = Math.max(1, Math.round(Number(width) || 1));
  const down = Math.max(1, Math.round(Number(height) || 1));
  const keys = [];
  for (let dx = 0; dx < across; dx++) {
    for (let dy = 0; dy < down; dy++) keys.push(`${row + dy}-${column + dx}`);
  }
  return keys;
}

/** The arrival and defence squares marked on a terrain grid, as two sets. */
export function objectivePointsOf(grid) {
  const arrive = new Set();
  const defend = new Set();
  for (const [key, entry] of Object.entries(grid ?? {})) {
    if (entry?.objectivePoint === 'arrive') arrive.add(key);
    else if (entry?.objectivePoint === 'defend') defend.add(key);
  }
  return { arrive, defend };
}

/** Whether a footprint touches any of a set of squares. */
function standsOnPoint(footprint, points) {
  return footprint.some(key => points.has(key));
}

/** The units on the map standing on any of a set of squares. */
function unitsOnPoints(units, points, gridSize) {
  if (!points.size) return [];
  return (units ?? []).filter(unit => standsOnPoint(footprintKeys(unit, gridSize), points));
}

/* -------------------------------------------- */
/*  Roster predicates                           */
/* -------------------------------------------- */

/** Whether a unit still has HP. */
function unitAlive(unit) {
  return Number(unit?.hp ?? 0) > 0;
}

/** Every living unit of the player factions. */
export function livingPlayerUnits(units) {
  const factions = ENCOUNTER_PHASE_FACTIONS[ENCOUNTER_PHASES.PLAYER];
  return (units ?? []).filter(unit => factions.includes(unit?.actorType) && unitAlive(unit));
}

/** Every living unit a rout would have to clear. */
function livingRoutUnits(units) {
  return (units ?? []).filter(unit => ROUT_FACTIONS.includes(unit?.actorType) && unitAlive(unit));
}

/* -------------------------------------------- */
/*  Condition predicates                        */
/* -------------------------------------------- */

/** Whether a rout objective is satisfied. */
function routMet(objective, { initial, kills, living }) {
  const includeSpawns = objective?.routIncludeSpawns !== false;
  const count = objective?.routCount ?? null;
  const initialSet = new Set(initial ?? []);
  const killList = [...new Set(kills ?? [])];

  if (count === null) {
    if (includeSpawns) {
      if (initialSet.size === 0 && killList.length === 0) return false;
      return (living?.size ?? 0) === 0;
    }
    if (initialSet.size === 0) return false;
    return [...initialSet].every(id => !living?.has(id));
  }

  const counted = includeSpawns ? killList : killList.filter(id => initialSet.has(id));
  return counted.length >= count;
}

/**
 * The rout roster's units that are neither on the map nor among the counted kills, for a Rout objective with a
 * kill count. Their fate is unknown, so they're never counted as kills. runObjectiveCheck
 * (engine/combat/encounters/objectives.mjs) warns the GM about them.
 */
export function unaccountedRosterIds(spec, snapshot, progress, board) {
  if (!(spec?.objectives ?? []).some(objective => objective.type === 'rout' && Number(objective.routCount) > 0)) return [];
  const present = new Set((board?.units ?? []).map(unit => unit.tokenId));
  const counted = new Set(progress?.kills ?? []);
  return (snapshot?.enemies ?? []).filter(id => !present.has(id) && !counted.has(id));
}

/**
 * Whether an Arrive objective is met. With Any Player Unit, one arrival is enough. Otherwise every named unit must
 * arrive, or the whole living player side if none are named.
 */
function arriveMet({ required, playerUnits, arrived, anyPlayerUnit = false }) {
  const arrivedSet = new Set(arrived ?? []);
  if (anyPlayerUnit) return arrivedSet.size > 0;
  const needed = required ?? playerUnits ?? [];
  if (!needed.length) return false;
  return needed.every(id => arrivedSet.has(id));
}

/** Whether every named defeat target has fallen. */
function defeatMet(targetIds, isDefeated) {
  if (!targetIds?.length) return false;
  return targetIds.every(id => isDefeated(id));
}

/** Whether any unit the map must protect has fallen. */
function anyProtectedFallen(protectedIds, isDefeated) {
  return (protectedIds ?? []).some(id => isDefeated(id));
}

/* -------------------------------------------- */
/*  Target resolution                           */
/* -------------------------------------------- */

/** Every unit on the map that a reference the GM typed could mean: a token or actor id, uuid or name. */
function resolveObjectiveRef(ref, units) {
  const needle = String(ref ?? '').trim().toLowerCase();
  if (!needle) return [];
  const matches = [];
  for (const unit of units ?? []) {
    const candidates = [unit.tokenId, unit.tokenUuid, unit.tokenName, unit.actorId, unit.actorUuid, unit.actorName];
    if (candidates.some(candidate => String(candidate ?? '').trim().toLowerCase() === needle)) {
      matches.push(unit.tokenId);
    }
  }
  return matches;
}

/**
 * Turn the GM's references into token ids. snapshotObjectiveTargets (engine/combat/encounters/objectives.mjs) saves
 * the result once the encounter is running, and the list then stays fixed, so deleted targets and later
 * reinforcements don't change it. `unresolved` lists the references no token matched.
 */
export function resolveObjectiveTargets(units, spec) {
  const unresolved = [];
  const resolveList = (refs) => {
    const ids = new Set();
    for (const ref of refs ?? []) {
      const found = resolveObjectiveRef(ref, units);
      if (!found.length) unresolved.push(ref);
      for (const id of found) ids.add(id);
    }
    return [...ids];
  };

  const defeat = [];
  const arrive = [];
  for (const objective of spec.objectives) {
    defeat.push(objective.type === 'defeat' ? resolveList(objective.defeatTargets) : null);
    arrive.push(objective.type === 'arrive' && !objective.arriveAnyPlayerUnit && objective.arriveUnits.length
      ? resolveList(objective.arriveUnits)
      : null);
  }

  const protectedIds = new Set(resolveList(spec.loss.protectedUnits));
  if (spec.loss.anyLordDefeat) {
    for (const unit of units ?? []) {
      if (unit.actorType === 'Lord') protectedIds.add(unit.tokenId);
    }
  }

  return {
    snapshot: {
      defeat,
      arrive,
      protected: [...protectedIds],
      enemies: livingRoutUnits(units).map(unit => unit.tokenId)
    },
    unresolved
  };
}

/** Clean up the saved objective target list. */
export function normalizeObjectiveSnapshot(raw) {
  const list = value => Object.freeze(Array.isArray(value) ? [...value] : []);
  return Object.freeze({
    defeat: list(raw?.defeat),
    arrive: list(raw?.arrive),
    protected: list(raw?.protected),
    enemies: list(raw?.enemies)
  });
}

/** Clean up the saved objective progress: kills and arrivals. */
export function normalizeObjectiveProgress(raw) {
  return Object.freeze({
    kills: Object.freeze(Array.isArray(raw?.kills) ? [...raw.kills] : []),
    arrivals: Object.freeze(Array.isArray(raw?.arrivals) ? [...raw.arrivals] : [])
  });
}

/** Every way this map's objectives can't be met as configured. snapshotObjectiveTargets shows each as a warning. */
export function objectiveSetupWarnings(spec, board, unresolved) {
  const warnings = [];
  if (unresolved?.length) {
    warnings.push(`No token on this map matches ${unresolved.map(ref => `"${ref}"`).join(', ')}, `
      + 'so that Objective can never be met.');
  }
  const points = objectivePointsOf(board?.terrainGrid);
  if (spec.objectives.some(entry => entry.type === 'arrive') && !points.arrive.size) {
    warnings.push('An Arrive objective is set but this map has no Arrival Points. Mark them in the Terrain Builder.');
  }
  if (spec.objectives.some(entry => entry.type === 'defend') && !points.defend.size) {
    warnings.push('A Defend objective is set but this map has no Defense Points. Mark them in the Terrain Builder.');
  }
  if (spec.objectives.some(entry => entry.type === 'rout' && !entry.routIncludeSpawns)
    && !livingRoutUnits(board?.units).length) {
    warnings.push('A Rout objective ignores reinforcements, but no Enemy or Boss units are on the map.');
  }
  return Object.freeze(warnings);
}

/* -------------------------------------------- */
/*  Markers                                     */
/* -------------------------------------------- */

/** Which units carry a defeat-target or protected marker, from the saved target list. */
export function objectiveMarkers(snapshot) {
  const targets = new Set();
  for (const list of snapshot?.defeat ?? []) for (const id of list ?? []) targets.add(id);
  return Object.freeze({
    defeat: Object.freeze([...targets]),
    protected: Object.freeze([...new Set(snapshot?.protected ?? [])])
  });
}

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */

/**
 * Whether the map has an Arrive objective. Without one, engine/combat/encounters/objectives.mjs leaves units standing
 * on arrival points instead of withdrawing them.
 */
export function arrivalObjectiveSet(spec) {
  return (spec?.objectives ?? []).some(entry => entry?.type === 'arrive');
}

/** The units that newly reached an arrival point and are not already recorded. */
export function newArrivals(units, board, progress) {
  const points = objectivePointsOf(board?.terrainGrid);
  const landed = unitsOnPoints(units, points.arrive, board?.gridSize).map(unit => unit.tokenId);
  const recorded = new Set(progress?.arrivals ?? []);
  return landed.filter(id => !recorded.has(id));
}

/**
 * Build the defeat predicate used by objective checks. Recorded arrivals count as escapes,
 * even after token removal, so withdrawing a protected unit cannot cause defeat.
 */
function isDefeatedIn(board, progress) {
  const living = new Map((board?.units ?? []).map(unit => [unit.tokenId, unit]));
  const escaped = new Set(progress?.arrivals ?? []);
  return id => {
    if (escaped.has(id)) return false;
    const unit = living.get(id);
    return !unit || !unitAlive(unit);
  };
}

function failureMet(spec, snapshot, progress, board) {
  return anyProtectedFallen(snapshot.protected, isDefeatedIn(board, progress));
}

function defeatOrRoutMet(spec, snapshot, progress, board) {
  const isDefeated = isDefeatedIn(board, progress);
  const living = new Set(livingRoutUnits(board?.units).map(unit => unit.tokenId));
  return spec.objectives.some((objective, index) => {
    if (objective.type === 'defeat') return defeatMet(snapshot.defeat[index] ?? [], isDefeated);
    if (objective.type === 'rout') {
      return routMet(objective, { initial: snapshot.enemies, kills: progress.kills, living });
    }
    return false;
  });
}

function arriveObjectiveMet(spec, snapshot, progress, board) {
  if (!arrivalObjectiveSet(spec)) return false;
  const playerUnits = livingPlayerUnits(board?.units).map(unit => unit.tokenId);
  return spec.objectives.some((objective, index) => objective.type === 'arrive'
    && arriveMet({
      required: snapshot.arrive[index] ?? null,
      playerUnits,
      arrived: progress.arrivals,
      anyPlayerUnit: objective.arriveAnyPlayerUnit === true
    }));
}

function defendLocationHeld(spec, board) {
  if (!spec.objectives.some(entry => entry.type === 'defend')) return false;
  const points = objectivePointsOf(board?.terrainGrid);
  return unitsOnPoints(livingRoutUnits(board?.units), points.defend, board?.gridSize).length > 0;
}

/**
 * When a queued map end for this reason is checked again before it takes effect: at once, in the player phase, or
 * in the enemy phase (see authoritativeEndReason).
 */
export function checkpointFor(reason) {
  if ([OBJECTIVE_END_REASONS.PROTECTED_DEFEAT, OBJECTIVE_END_REASONS.DEFEAT_OR_ROUT_VICTORY].includes(reason)) {
    return OBJECTIVE_END_CHECKPOINTS.IMMEDIATE;
  }
  if ([OBJECTIVE_END_REASONS.DEFEND_DEFEAT, OBJECTIVE_END_REASONS.DEADLINE_VICTORY,
    OBJECTIVE_END_REASONS.DEADLINE_DEFEAT].includes(reason)) {
    return OBJECTIVE_END_CHECKPOINTS.ENEMY;
  }
  return OBJECTIVE_END_CHECKPOINTS.PLAYER;
}

/**
 * The end reason an objective check finds, or null, for runObjectiveCheck in engine/combat/encounters/objectives.mjs.
 * Failure is checked before victory. Player-phase checks look at arrivals, and enemy-phase checks look at Defense
 * Points and round deadlines. Recorded arrivals tell escapes apart from deaths.
 */
export function evaluateObjectives(spec, snapshot, progress, board, trigger = {}) {
  if (failureMet(spec, snapshot, progress, board)) return OBJECTIVE_END_REASONS.PROTECTED_DEFEAT;
  if (defeatOrRoutMet(spec, snapshot, progress, board)) return OBJECTIVE_END_REASONS.DEFEAT_OR_ROUT_VICTORY;

  const kind = trigger.kind ?? OBJECTIVE_CHECK_KINDS.IMMEDIATE;
  if (kind === OBJECTIVE_CHECK_KINDS.IMMEDIATE) return null;

  if (kind === OBJECTIVE_CHECK_KINDS.TURN_END || trigger.phase === ENCOUNTER_PHASES.PLAYER) {
    return arriveObjectiveMet(spec, snapshot, progress, board)
      ? OBJECTIVE_END_REASONS.ARRIVAL_VICTORY
      : null;
  }

  if (trigger.phase === ENCOUNTER_PHASES.ENEMY) {
    if (defendLocationHeld(spec, board)) return OBJECTIVE_END_REASONS.DEFEND_DEFEAT;
    const deadline = deadlineFor(spec.objectives, spec.roundLimit);
    if (!deadlineReached(deadline, trigger.roundEnded)) return null;
    return deadline.kind === 'victory'
      ? OBJECTIVE_END_REASONS.DEADLINE_VICTORY
      : OBJECTIVE_END_REASONS.DEADLINE_DEFEAT;
  }

  return null;
}

/**
 * Check a queued encounter end again before resolveObjectiveEnd (engine/combat/encounters/objectives.mjs) commits
 * it. The whole order is checked again, not just the old reason, so a protected unit lost since then replaces a
 * queued victory.
 */
export function authoritativeEndReason(spec, snapshot, progress, board, pending) {
  if (failureMet(spec, snapshot, progress, board)) return OBJECTIVE_END_REASONS.PROTECTED_DEFEAT;
  if (defeatOrRoutMet(spec, snapshot, progress, board)) return OBJECTIVE_END_REASONS.DEFEAT_OR_ROUT_VICTORY;

  if (pending.checkpoint === OBJECTIVE_END_CHECKPOINTS.PLAYER) {
    if (pending.phase !== ENCOUNTER_PHASES.PLAYER) return null;
    return arriveObjectiveMet(spec, snapshot, progress, board)
      ? OBJECTIVE_END_REASONS.ARRIVAL_VICTORY
      : null;
  }

  if (pending.checkpoint === OBJECTIVE_END_CHECKPOINTS.ENEMY) {
    if (pending.phase !== ENCOUNTER_PHASES.ENEMY || pending.roundEnded !== pending.round) return null;
    if (defendLocationHeld(spec, board)) return OBJECTIVE_END_REASONS.DEFEND_DEFEAT;
    const deadline = deadlineFor(spec.objectives, spec.roundLimit);
    if (!deadlineReached(deadline, pending.roundEnded)) return null;
    return deadline.kind === 'victory'
      ? OBJECTIVE_END_REASONS.DEADLINE_VICTORY
      : OBJECTIVE_END_REASONS.DEADLINE_DEFEAT;
  }

  return null;
}


/* -------------------------------------------- */
/*  Waiting for quiet                           */
/* -------------------------------------------- */

/** The statuses a queued end may report that are worth trying again rather than abandoning. */
export const OBJECTIVE_END_RETRY_STATUSES = Object.freeze(['commit-contended', 'teardown-failed']);

/**
 * One check of whether the system's pending work has finished, polled by waitForSettledProcessing
 * (foundry/adapters/services/processing-blocker.mjs): settled once nothing has been busy for `stableMs`, expired
 * once `deadline` passes. A busy reading restarts the quiet period, because a short gap between the steps of one
 * command doesn't mean the work is done.
 * @param {{busy: boolean, now: number, quietSince: number|null, deadline: number, stableMs?: number}} facts
 *   Whether work is running now, the current time, when the quiet period began, the deadline, and the quiet period's
 *   length (SETTLE_BARRIER_TIMING.stableMs by default).
 * @returns {{settled: boolean, expired: boolean, quietSince: number|null}}
 */
export function readSettleBarrier({
  busy, now, quietSince = null, deadline, stableMs = SETTLE_BARRIER_TIMING.stableMs
}) {
  if (busy) return { settled: false, expired: now >= deadline, quietSince: null };
  const since = quietSince === null ? now : quietSince;
  const window = Number.isFinite(Number(stableMs)) ? Math.max(0, Number(stableMs)) : SETTLE_BARRIER_TIMING.stableMs;
  if ((now - since) >= window) return { settled: true, expired: false, quietSince: since };
  return { settled: false, expired: now >= deadline, quietSince: since };
}

/**
 * The delay before retrying a queued objective end, doubling with each attempt, or no retry past the attempt limit.
 * Used by createObjectiveEndRetries in engine/combat/encounters/objectives.mjs.
 * @param {number} attempts How many attempts have now been made against this request.
 * @returns {{retry: boolean, delayMs: number}}
 */
export function planObjectiveEndRetry(attempts) {
  const made = Math.max(1, Math.floor(Number(attempts) || 1));
  if (made > OBJECTIVE_END_RETRY.maxAttempts) return { retry: false, delayMs: 0 };
  return {
    retry: true,
    delayMs: Math.min(OBJECTIVE_END_RETRY.maxMs, OBJECTIVE_END_RETRY.baseMs * (2 ** (made - 1)))
  };
}

/* -------------------------------------------- */
/*  Local helpers                               */
/* -------------------------------------------- */

function cleanRefs(list) {
  return Object.freeze((Array.isArray(list) ? list : [])
    .map(value => String(value ?? '').trim())
    .filter(value => value.length > 0));
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
