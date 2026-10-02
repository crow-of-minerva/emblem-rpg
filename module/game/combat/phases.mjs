/** @layer game/combat */
import {
  ENCOUNTER_PHASES,
  ENCOUNTER_PHASE_FACTIONS,
  ENCOUNTER_TRACK_FLAGS,
  PAUSED_ENCOUNTER_RECORD_VERSION,
  PHASE_CAMERA_GROUP_SPAN
} from '../../contracts/domains/combat.mjs';
import { MOVEMENT_PLAN_PATHS } from '../../contracts/domains/characters.mjs';
import { DOWNTIME_ENERGY_BASE, DOWNTIME_FLAG } from '../../contracts/domains/downtime.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { TOKEN_MOVEMENT_WRITE_KEYS } from '../../contracts/domains/tokens.mjs';
import { DOWNTIME_CLEARED } from '../downtime/rules.mjs';
import { isEncounterStatus } from '../effects/statuses.mjs';
import { changeLeafPaths } from '../../lib/core/runtime.mjs';
import { normalizeObjectiveProgress, normalizeObjectiveSnapshot } from './objectives.mjs';

/* -------------------------------------------- */
/*  Phase cycle                                 */
/* -------------------------------------------- */

const TURN_ACTIVE = Object.freeze({
  'system.turn.actionAvailable': true,
  'system.turn.bonusActionAvailable': true,
  'system.turn.movementAvailable': true,
  'system.turn.movementSpent': 0,
  'system.turn.movementBonus': 0,
  'system.turn.extraActionUsed': false,
  'system.turn.traded': false,
  'system.turn.movementPlanning': false,
  'system.turn.movementControllerId': '',
  'system.turn.movementAnchorX': 0,
  'system.turn.movementAnchorY': 0,
  'system.turn.movementPlanStartedAt': 0,
  'system.turn.canterPathfinding': false,
  'system.turn.attackIndex': 0,
  'system.turn.continuationPending': '',
  'system.turn.continuationRequestId': '',
  'system.turn.continuationCanters': false
});

/** What a restoreAction `turn` restore writes: every slot back, with movement spent and its penalty cleared. */
export const TURN_REFRESH = Object.freeze({
  'system.turn.actionAvailable': true,
  'system.turn.bonusActionAvailable': true,
  'system.turn.movementAvailable': true,
  'system.turn.movementSpent': 0,
  'system.stats.mov.penalty': 0,
  'system.turn.extraActionUsed': false
});

const TURN_INACTIVE = Object.freeze({
  'system.turn.actionAvailable': false,
  'system.turn.bonusActionAvailable': false,
  'system.turn.movementAvailable': false,
  'system.turn.movementSpent': 0,
  'system.turn.movementBonus': 0,
  'system.turn.extraActionUsed': false,
  'system.turn.traded': false,
  'system.turn.movementPlanning': false,
  'system.turn.movementControllerId': '',
  'system.turn.movementAnchorX': 0,
  'system.turn.movementAnchorY': 0,
  'system.turn.movementPlanStartedAt': 0,
  'system.turn.canterPathfinding': false,
  'system.turn.attackIndex': 0,
  'system.turn.continuationPending': '',
  'system.turn.continuationRequestId': '',
  'system.turn.continuationCanters': false
});

/**
 * The update paths that write a unit's turn state back from a saved copy of it. restoreUpdate in
 * foundry/adapters/document-writes/development.mjs uses it when FoundryDevelopmentRepository restores units.
 */
export function turnUpdate(turn) {
  return {
    'system.turn.actionAvailable': turn.actionAvailable === true,
    'system.turn.bonusActionAvailable': turn.bonusActionAvailable === true,
    'system.turn.movementAvailable': turn.movementAvailable === true,
    'system.turn.movementSpent': Number(turn.movementSpent) || 0,
    'system.turn.movementBonus': Number(turn.movementBonus) || 0,
    'system.turn.extraActionUsed': turn.extraActionUsed === true,
    'system.turn.traded': turn.traded === true,
    'system.turn.continuationPending': String(turn.continuationPending ?? ''),
    'system.turn.continuationRequestId': String(turn.continuationRequestId ?? ''),
    'system.turn.continuationCanters': turn.continuationCanters === true,
    'system.turn.movementPlanning': turn.movementPlanning === true,
    'system.turn.movementControllerId': String(turn.movementControllerId ?? ''),
    'system.turn.movementAnchorX': Number(turn.movementAnchorX) || 0,
    'system.turn.movementAnchorY': Number(turn.movementAnchorY) || 0,
    'system.turn.movementPlanStartedAt': Number(turn.movementPlanStartedAt) || 0
  };
}

/** Whether an authored faction takes part in the phase cycle at all. */
export function isPhaseParticipant(actorType) {
  return Object.values(ENCOUNTER_PHASE_FACTIONS).some(members => members.includes(String(actorType ?? '')));
}

/** The phase an authored faction acts in, or null when it stands outside the cycle. */
export function phaseForFaction(actorType) {
  for (const [phase, members] of Object.entries(ENCOUNTER_PHASE_FACTIONS)) {
    if (members.includes(String(actorType ?? ''))) return phase;
  }
  return null;
}

/**
 * The phase that follows `phase`, for engine/combat/encounters/phases.mjs. The round goes up when play returns to
 * the Player phase.
 * @param {string} phase The phase now ending.
 * @param {number} round The round it belongs to.
 * @returns {{outgoing: string, incoming: string, round: number}}
 */
export function nextEncounterPhase(phase, round) {
  const outgoing = phase === ENCOUNTER_PHASES.ENEMY ? ENCOUNTER_PHASES.ENEMY : ENCOUNTER_PHASES.PLAYER;
  const incoming = outgoing === ENCOUNTER_PHASES.PLAYER ? ENCOUNTER_PHASES.ENEMY : ENCOUNTER_PHASES.PLAYER;
  const current = Math.max(1, Math.floor(Number(round) || 1));
  return {
    outgoing,
    incoming,
    round: incoming === ENCOUNTER_PHASES.PLAYER ? current + 1 : current
  };
}

/**
 * The turn-state updates for every unit when a phase opens, which engine/combat/encounters/phases.mjs writes through
 * applyTurnUpdates. Each unit's turn state is replaced whole. The acting faction's Willpower and Dexterity are
 * refilled, and at encounter start both factions' pools are, Extra Actions included. Extra Actions refill only then.
 * @param {object[]} units Units with `actorUuid`, `actorType` and `special` pools.
 * @param {string} phase The phase opening.
 * @param {object} [options]
 * @param {boolean} [options.encounterStart] Whether this opening is the encounter's first.
 * @returns {object[]} One `{actorUuid, updates}` entry per participating unit.
 */
export function planPhaseTurnUpdates(units = [], phase, { encounterStart = false } = {}) {
  const active = ENCOUNTER_PHASE_FACTIONS[phase] ?? [];
  const plan = [];
  for (const unit of units) {
    if (!isPhaseParticipant(unit?.actorType)) continue;
    const acting = active.includes(String(unit.actorType));
    plan.push({
      actorUuid: String(unit.actorUuid ?? ''),
      acting,
      updates: {
        ...(acting ? TURN_ACTIVE : TURN_INACTIVE),
        ...(acting || encounterStart === true ? specialResourceResets(unit.special, encounterStart === true) : {})
      }
    });
  }
  return plan;
}

/** The units whose faction acts in `phase`, in scene order. */
export function phaseParticipants(units = [], phase) {
  const members = ENCOUNTER_PHASE_FACTIONS[phase] ?? [];
  return units.filter(unit => members.includes(String(unit?.actorType ?? '')));
}

/* -------------------------------------------- */
/*  Phase camera                                */
/* -------------------------------------------- */

/**
 * Group units for the camera pans when a phase opens (engine/combat/encounters/phases.mjs). Each group grows from
 * the leftmost ungrouped unit while its bounds fit within `span`. Units without a cell come last, in one group with
 * no pan.
 * @param {object[]} units Units with a `cell` {x, y, width, height} in squares.
 * @param {number} [span] Widest cluster on either axis.
 * @returns {object[][]}
 */
export function phaseCameraGroups(units = [], span = PHASE_CAMERA_GROUP_SPAN) {
  const placed = units.filter(unit => Number.isFinite(Number(unit?.cell?.x)) && Number.isFinite(Number(unit?.cell?.y)))
    .sort((a, b) => (Number(a.cell.x) - Number(b.cell.x)) || (Number(a.cell.y) - Number(b.cell.y)));
  const unplaced = units.filter(unit => !placed.includes(unit));
  const groups = [];
  const taken = new Set();
  for (const seed of placed) {
    if (taken.has(seed)) continue;
    taken.add(seed);
    const group = [seed];
    let box = cellBox(seed.cell);
    for (const candidate of placed) {
      if (taken.has(candidate)) continue;
      const union = unionBox(box, cellBox(candidate.cell));
      if (union.right - union.left > span || union.bottom - union.top > span) continue;
      taken.add(candidate);
      group.push(candidate);
      box = union;
    }
    groups.push(group);
  }
  if (unplaced.length) groups.push(unplaced);
  return groups;
}

function cellBox(cell) {
  const x = Number(cell.x) || 0;
  const y = Number(cell.y) || 0;
  return { left: x, top: y, right: x + Math.max(1, Number(cell.width) || 1), bottom: y + Math.max(1, Number(cell.height) || 1) };
}

function unionBox(a, b) {
  return {
    left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)
  };
}

/* -------------------------------------------- */
/*  Phase music                                 */
/* -------------------------------------------- */

/**
 * The track to play for the current phase, or null to keep the scene's music. Used by the phase-music service in
 * foundry/adapters/services/audio.mjs.
 * @param {object} music The current phase, the encounter music switch, and each phase's track.
 * @returns {string|null} A Playlist or PlaylistSound uuid.
 */
export function phaseMusicTrack(music = {}) {
  if (music.enabled === false) return null;
  const phase = String(music.phase ?? '');
  if (!ENCOUNTER_TRACK_FLAGS[phase]) return null;
  const track = String(music.tracks?.[phase] ?? '');
  return track.length > 0 ? track : null;
}

/** List tracks the Foundry phase-music adapter may need to stop on a phase change. */
export function phaseMusicTracks(music = {}) {
  return Object.keys(ENCOUNTER_TRACK_FLAGS)
    .map(phase => String(music.tracks?.[phase] ?? ''))
    .filter(track => track.length > 0);
}

/* -------------------------------------------- */
/*  Turn state                                  */
/* -------------------------------------------- */

/** Whether a unit has spent both its action and its movement this phase. */
export function unitTurnComplete(turn) {
  return turn?.actionAvailable !== true && turn?.movementAvailable !== true;
}

/** Count living units and completed turns for the combat tracker, phase-progress checks and the empty-phase guard. */
export function phaseRosterProgress(units = [], phase) {
  const members = ENCOUNTER_PHASE_FACTIONS[phase] ?? [];
  const alive = units.filter(unit => members.includes(String(unit?.actorType ?? '')) && Number(unit?.hp ?? 0) > 0);
  const acted = alive.filter(unit => unit?.acted === true).length;
  return Object.freeze({
    acted,
    total: alive.length,
    pct: alive.length ? Math.round((acted / alive.length) * 100) : 0,
    complete: alive.length > 0 && acted === alive.length
  });
}

/**
 * Token fields the combat tracker rows never show: everything a movement write names, and the facing flip. A write
 * touching only these leaves every row as it was.
 */
const ROSTER_INERT_TOKEN_KEYS = Object.freeze([...TOKEN_MOVEMENT_WRITE_KEYS, 'rotation', 'texture.scaleX']);

/** Whether a Token write can change what the roster shows: a row reads the unit, never where its Token stands. */
export function tokenChangeAffectsRoster(changes) {
  const keys = Object.keys(changes ?? {});
  if (!keys.length) return true;
  return keys.some(key => !ROSTER_INERT_TOKEN_KEYS.includes(key)
    && !(key === 'texture' && facingOnly(changes.texture)));
}

/** Whether an Actor write can change what the roster shows. Picking a unit up or putting it down cannot. */
export function actorChangeAffectsRoster(changes) {
  const paths = changeLeafPaths(changes)
    .filter(path => path !== '_id' && path !== '_stats' && !path.startsWith('_stats.'));
  if (!paths.length) return true;
  return paths.some(path => !MOVEMENT_PLAN_PATHS.includes(path));
}

/** Whether a texture change only turns the sprite around, as the movement facing write does. */
function facingOnly(texture) {
  const keys = Object.keys(texture ?? {});
  return keys.length > 0 && keys.every(key => key === 'scaleX');
}

/** Whether an enemy row is listed for a user: the GM sees every enemy, a player only those their vision reaches. */
export function enemyRowListed(unit, isGM) {
  if (isGM === true) return true;
  if (unit?.hidden === true) return false;
  return unit?.visible !== false;
}

/**
 * Whether an enemy row's listing changed since the combat tracker last recorded it. An enemy with no record isn't
 * followed this way, so it never counts as changed.
 */
export function enemyListingFlipped(listed, listedNow) {
  return listed !== undefined && listed !== listedNow;
}

/**
 * Whether an enemy on the scene was missing from the combat tracker's last render, such as one placed since then,
 * so the tracker must render again. ui/apps/foundry/combat-tracker.mjs asks this on a player's vision refresh;
 * enemies it already rendered are followed through their own Token's visibility refresh.
 * @param {{has: Function}} recorded Token ids of the enemies the last render recorded, listed or not.
 * @param {Iterable<{tokenId: string, actorType: string}>} units Every unit on the Scene.
 * @param {readonly string[]} playerFactions The factions the roster lists as player rows.
 * @returns {boolean}
 */
export function enemyListingIncomplete(recorded, units, playerFactions) {
  for (const unit of units ?? []) {
    const actorType = String(unit?.actorType ?? '');
    if (!isPhaseParticipant(actorType) || playerFactions.includes(actorType)) continue;
    if (!recorded.has(String(unit?.tokenId ?? ''))) return true;
  }
  return false;
}

/**
 * Turn updates for the player units when free exploration is switched on or off, for
 * engine/combat/encounters/commands.mjs. Switching it on also refills Energy and clears downtime commitments.
 */
export function planExplorationTurnUpdates(units = [], active) {
  const members = ENCOUNTER_PHASE_FACTIONS[ENCOUNTER_PHASES.PLAYER];
  const plan = [];
  for (const unit of units) {
    if (!members.includes(String(unit?.actorType ?? ''))) continue;
    const refill = active === true ? {
      'system.resources.energy.value': Number.isFinite(unit.energyMax) ? unit.energyMax : DOWNTIME_ENERGY_BASE,
      [`flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`]: { ...DOWNTIME_CLEARED }
    } : {};
    plan.push({
      actorUuid: String(unit.actorUuid ?? ''),
      acting: active === true,
      updates: { ...(active ? TURN_ACTIVE : TURN_INACTIVE), ...refill }
    });
  }
  return plan;
}

/* -------------------------------------------- */
/*  Paused encounter                            */
/* -------------------------------------------- */

/**
 * The paused-encounter record that pauseEncounter (engine/combat/encounters/phases.mjs) saves on the scene: the
 * round, the objective targets with their progress (defeated targets may no longer exist), and the auto-advance
 * switch from the deleted Combat, which resumeEncounter writes onto the new one. Only a stored false turns
 * auto-advance off. Units aren't recorded; their turn state is reset when the encounter resumes.
 */
export function planPausedEncounter({ round, phase, pausedAt, targets, progress, autoAdvance } = {}) {
  return Object.freeze({
    version: PAUSED_ENCOUNTER_RECORD_VERSION,
    round: Math.max(1, Math.floor(Number(round) || 1)),
    phase: Object.values(ENCOUNTER_PHASES).includes(String(phase)) ? String(phase) : '',
    pausedAt: Math.max(0, Math.floor(Number(pausedAt) || 0)),
    targets: normalizeObjectiveSnapshot(targets),
    progress: normalizeObjectiveProgress(progress),
    autoAdvance: autoAdvance !== false
  });
}

/** Clean up a saved paused-encounter record, or null when the map has none. */
export function normalizePausedEncounter(raw) {
  return raw && typeof raw === 'object' ? planPausedEncounter(raw) : null;
}

/* -------------------------------------------- */
/*  Encounter aftermath                         */
/* -------------------------------------------- */

/**
 * Plan what an ended encounter clears from its map, for engine/combat/encounters/objectives.mjs: Guard bonds,
 * statuses (see `isEncounterStatus`), Rally records (see `planRallyRecordReset`), and summoned Tokens. An unlinked
 * summon's statuses go with its Token, and an Actor behind several Tokens is cleared once. A paused encounter never
 * runs this.
 * @param {ReadonlyArray<object>} units One `{tokenUuid, actorUuid, linked, summoned, guardBonded, rallied,
 *   effects}` entry per placed Token.
 * @returns {{bondedTokenUuids: string[], statuses: object[], ralliedActorUuids: string[],
 *   summonTokenUuids: string[]}} The Tokens whose bonds break, each Actor's status effect ids, the Actors whose
 *   Rally records clear, and the summoned Tokens to remove.
 */
export function planEncounterAftermath(units = []) {
  const bondedTokenUuids = [];
  const summonTokenUuids = [];
  const statuses = [];
  const purged = new Set();
  for (const unit of units) {
    const tokenUuid = String(unit?.tokenUuid ?? '');
    const actorUuid = String(unit?.actorUuid ?? '');
    if (unit?.guardBonded === true && tokenUuid) bondedTokenUuids.push(tokenUuid);
    if (unit?.summoned === true && tokenUuid) summonTokenUuids.push(tokenUuid);
    if ((unit?.summoned === true && unit.linked !== true) || !actorUuid || purged.has(actorUuid)) continue;
    purged.add(actorUuid);
    const effectIds = (unit.effects ?? []).filter(isEncounterStatus)
      .map(effect => String(effect.id ?? '')).filter(Boolean);
    if (effectIds.length) statuses.push({ actorUuid, effectIds });
  }
  return { bondedTokenUuids, statuses, ralliedActorUuids: planRallyRecordReset(units), summonTokenUuids };
}

/**
 * Plan what a phase's end does to the timed summons on its map, for engine/combat/encounters/phases.mjs: each summon
 * whose countdown ticks on `closingPhase` loses a phase, and one with none left is removed. A summon without a
 * countdown lasts until the encounter ends.
 * @param {ReadonlyArray<object>} units One `{tokenUuid, summoned, summonRemaining, summonTicksOn}` entry per Token.
 * @param {string} closingPhase The phase now ending.
 * @returns {{expiredTokenUuids: string[], counters: Array<{tokenUuid: string, remaining: number}>}}
 */
export function planSummonExpiry(units = [], closingPhase) {
  const expiredTokenUuids = [];
  const counters = [];
  for (const unit of units) {
    const tokenUuid = String(unit?.tokenUuid ?? '');
    const remaining = Math.floor(Number(unit?.summonRemaining));
    if (unit?.summoned !== true || !tokenUuid || !(remaining >= 1) || unit.summonTicksOn !== closingPhase) continue;
    if (remaining > 1) counters.push({ tokenUuid, remaining: remaining - 1 });
    else expiredTokenUuids.push(tokenUuid);
  }
  return { expiredTokenUuids, counters };
}

/**
 * The Actors on a map whose record of this map's Rallies must clear, each once, for an encounter's start
 * (beginEncounter in engine/combat/encounters/phases.mjs) and its end (planEncounterAftermath).
 * @param {ReadonlyArray<object>} units One `{actorUuid, rallied}` entry per placed Token.
 * @returns {string[]}
 */
export function planRallyRecordReset(units = []) {
  return [...new Set(units.filter(unit => unit?.rallied === true && unit.actorUuid)
    .map(unit => String(unit.actorUuid)))];
}

/* -------------------------------------------- */
/*  Local helpers                               */
/* -------------------------------------------- */

function specialResourceResets(special, encounterStart) {
  const resets = {};
  for (const key of encounterStart ? ['willpower', 'dexterity', 'extraActions'] : ['willpower', 'dexterity']) {
    const max = Number(special?.[key]?.max);
    if (Number.isFinite(max)) resets[`system.special.${key}.value`] = Math.max(0, max);
  }
  return resets;
}
