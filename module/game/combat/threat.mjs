/** @layer game/combat */
import { INCAPACITATING_STATUSES, THREAT_SEVERE_HP_FRACTION, THREAT_TIERS } from '../../contracts/domains/combat.mjs';
import { areFactionsHostile, CRITICAL_MULTIPLIER_BASE } from '../character/rules.mjs';
import { airborneBeyondMelee, hasRequiredProficiency, parseAttackRange } from '../targeting/attack-grid.mjs';
import { isMagicItem } from '../effects/requirements.mjs';
import { shortcutTravelDistance } from '../movement/pathfinding.mjs';
import { cellKey, rectKeys } from '../../lib/core/geometry.mjs';
import { clamp, finite } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Unit state                                  */
/* -------------------------------------------- */
const HELD_STATUSES = new Set(INCAPACITATING_STATUSES);

/* -------------------------------------------- */
/*  Rule constants                              */
/* -------------------------------------------- */

/** Hit and crit chances are percentages, clamped to this range. */
const CHANCE_MIN = 0;
const CHANCE_MAX = 100;

/** The fewest attacks a matchup can make. damageFigures ignores a matchup reporting fewer. */
const MIN_ATTACK_COUNT = 1;

/** Two units are always at least one square apart, so engagementDistance counts a smaller gap as 1. */
const MIN_ENGAGEMENT_DISTANCE = 1;

/** Whether a unit is still standing, and so still a threat. */
function isAlive(unit) {
  return finite(unit.hp) > 0;
}

/**
 * Whether a unit is out of action: its stance is at 0 or an incapacitating status holds it. Spent actions don't
 * count, so threat lines still show danger from units that already acted this round. engine/combat/threat.mjs
 * grades such a unit as inert.
 */
export function isIncapacitated(unit) {
  if (finite(unit.stance) <= 0) return true;
  for (const status of unit.statuses ?? []) {
    if (HELD_STATUSES.has(String(status).toLowerCase())) return true;
  }
  return false;
}

/**
 * Whether a unit can threaten the selected one at all. A unit whose longest attack range is 1 can't hit an airborne
 * target out of melee reach (airborneBeyondMelee in game/targeting/attack-grid.mjs), wherever either stands.
 */
function canThreaten(unit, selected, board) {
  if (finite(unit.maxAttackRange) > 1) return true;
  return !airborneBeyondMelee({
    sourceAirborne: unit.airborne === true,
    targetAirborne: selected.airborne === true,
    targetStanceBroken: selected.stanceBroken === true,
    classicFlyers: board.classicFlyers === true,
    flightForbidden: board.flightForbidden === true
  });
}

/**
 * The actor a taunt forces this hostile to attack, or '' if none. A taunter that isn't on the board is ignored, and
 * a guarded taunter is replaced by its guarder.
 */
function compulsionTarget(hostile) {
  const tauntor = String(hostile.tauntedByActorUuid ?? '');
  if (!tauntor || hostile.tauntorPresent !== true) return '';
  return String(hostile.tauntorGuardedByActorUuid ?? '') || tauntor;
}

/** The other actor a taunt forces the hostile to attack instead of this target, or null. */
function compelledElsewhere(hostile, targetActorUuid) {
  const struck = compulsionTarget(hostile);
  if (!struck) return null;
  return struck === String(targetActorUuid ?? '') ? null : struck;
}

/* -------------------------------------------- */
/*  Candidate selection                         */
/* -------------------------------------------- */
/**
 * The hostiles worth building a movement reach for when the threat overlay inspects the selected unit
 * (beginInspection in engine/combat/threat.mjs). A hostile is skipped when it is too far away to matter: farther
 * than its movement and attack reach plus the selected unit's movement, teleports included. Free cells and
 * exploration turn the skip off.
 * @param {object} board The selected unit, every other unit on the board and the scene's `travelShortcuts`.
 * @returns {Readonly<object>} The candidates, plus the live hostiles, taunt sources and prefilter area that later
 *   checks need to decide whether to rebuild.
 */
export function selectThreatCandidates(board) {
  const selected = board?.selected ?? {};
  const selfReach = selected.exploring ? Infinity : movementPoints(selected.movement);
  const shortcuts = Array.isArray(board?.travelShortcuts) ? board.travelShortcuts : null;
  const prefilter = shortcuts !== null && Number.isFinite(selfReach);
  const selfRect = selected.rect ?? { x: 0, y: 0, width: 1, height: 1 };
  const slack = teleportSlack(selfRect, shortcuts);
  const candidates = [];
  const liveHostiles = [];
  const compulsionSources = [];

  for (const unit of board?.units ?? []) {
    if (!unit || unit.tokenId === selected.tokenId || unit.combatant !== true) continue;
    if (!areFactionsHostile(unit.faction, selected.faction)) continue;
    if (isAlive(unit)) liveHostiles.push(unit.actorUuid);
    if (!isAlive(unit) || unit.visible !== true) continue;
    if (!canThreaten(unit, selected, board)) continue;
    const struck = compulsionTarget(unit);
    if (struck) {
      compulsionSources.push(String(unit.tauntedByActorUuid));
      if (struck !== String(unit.tauntedByActorUuid)) compulsionSources.push(struck);
    }
    if (compelledElsewhere(unit, selected.actorUuid)) continue;
    if (prefilter) {
      const bound = movementPoints(unit.movement) + finite(unit.maxAttackReach) + selfReach + slack;
      if (Number.isFinite(bound) && shortcutTravelDistance(unit.rect, selfRect, shortcuts) > bound) continue;
    }
    candidates.push(unit);
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    liveHostiles: Object.freeze([...new Set(liveHostiles)]),
    compulsionSources: Object.freeze([...new Set(compulsionSources)]),
    prefilter: prefilter ? Object.freeze({ x: selfRect.x, y: selfRect.y, radius: selfReach, shortcuts }) : null
  });
}

/** How far a unit could move, treating an unreadable value as unbounded so nothing is wrongly pruned. */
function movementPoints(value) {
  const points = Number(value);
  return Number.isFinite(points) ? Math.max(0, points) : Infinity;
}

/**
 * Extra room on teleport maps for a selected unit bigger than one square. Its trips through pads are measured from
 * its top-left square, not its nearest edge.
 */
function teleportSlack(rect, shortcuts) {
  if (!shortcuts?.length) return 0;
  return Math.max(0, (rect.width ?? 1) - 1) + Math.max(0, (rect.height ?? 1) - 1);
}

/* -------------------------------------------- */
/*  Reach                                       */
/* -------------------------------------------- */
/**
 * The squares a hostile could attack next turn, from its movement graph, and those where only an airborne target
 * can be hit because height hides a grounded one. Used by engine/combat/threat.mjs.
 */
export function threatReach(graph) {
  return Object.freeze({
    reach: Object.freeze(new Set((graph?.attackableTiles ?? []).map(cell => cellKey(cell.x, cell.y)))),
    occluded: Object.freeze(new Set((graph?.flyersOnlyTiles ?? []).map(cell => cellKey(cell.x, cell.y))))
  });
}

/** Whether a reach covers any square of the focus footprint, honouring height occlusion for a grounded focus. */
export function threatCovers(threat, focus) {
  if (!(threat?.reach instanceof Set) || threat.reach.size === 0) return false;
  const cells = rectKeys(focus.x, focus.y, focus.width ?? 1, focus.height ?? 1);
  return cells.some(cell => threat.reach.has(cell) && (focus.airborne === true || !threat.occluded?.has(cell)));
}

/**
 * Whether the focus has moved outside the area the prefilter assumed, so the hostiles it skipped need a new look.
 * Measured the same way as the prefilter, teleports included.
 */
export function leftPrefilterEnvelope(prefilter, focus) {
  if (!prefilter) return false;
  const anchor = point => ({ x: point.x, y: point.y, width: 1, height: 1 });
  return shortcutTravelDistance(anchor(prefilter), anchor(focus), prefilter.shortcuts ?? []) > prefilter.radius;
}

/* -------------------------------------------- */
/*  Weapons                                     */
/* -------------------------------------------- */
const ATTACK_ITEM_TYPES = new Set(['Weapon', 'Attack', 'Staff']);

/**
 * Whether the unit could attack with a carried item: an attack item with a range, uses left and the rank to wield it,
 * and not a magic item (isMagicItem in game/effects/requirements.mjs) held by a Silenced unit. Used by
 * projections/attack-targeting.mjs for threat matchups and the Enemy AI's loadout.
 */
export function weaponUsableForThreat(weapon, unit) {
  if (!ATTACK_ITEM_TYPES.has(String(weapon?.itemType ?? ''))) return false;
  if (!parseAttackRange(weapon?.range)) return false;
  if (weapon?.infinite !== true && finite(weapon?.uses) < 1) return false;
  if (unit?.silenced === true && isMagicItem({ type: weapon?.type, requiredProficiency: weapon?.proficiency })) {
    return false;
  }
  return hasRequiredProficiency(unit?.proficiencies, weapon?.proficiency, weapon?.rank);
}

/* -------------------------------------------- */
/*  Grading                                     */
/* -------------------------------------------- */
/**
 * The distance a unit would attack from: the distance inside the weapon's range nearest the current gap, since it
 * moves into range rather than attacking from where it stands. Used by projectThreatMatchups
 * (projections/attack-targeting.mjs).
 */
export function engagementDistance(gap, range) {
  if (!range) return Math.max(MIN_ENGAGEMENT_DISTANCE, finite(gap));
  return Math.max(range.minRange, Math.min(finite(gap), range.maxRange));
}

/**
 * Grade one matchup against the target's current HP. gradeIncomingThreat grades the strongest of a hostile's
 * matchups with it. The Enemy AI's attack-intent line calls it through the system API's combat.gradeThreat with
 * allowLethal, because it knows the attack is coming, so an outright kill grades lethal rather than severe.
 * @param {object} [input]
 * @param {object|null} [input.matchup] Strike count, hit and crit chance, crit multiplier and damage span.
 * @param {number} [input.targetHp] The health the matchup is measured against.
 * @param {boolean} [input.allowLethal] Whether a landed-hit total that covers the health grades lethal.
 * @returns {Readonly<{tier: string, damageOnHit: number, bestCase: number}>}
 */
export function gradeMatchupThreat({ matchup = null, targetHp = 0, allowLethal = false } = {}) {
  const damage = damageFigures(matchup);
  return Object.freeze({
    tier: threatTier(damage, targetHp, allowLethal),
    damageOnHit: damage?.onHit ?? 0,
    bestCase: damage?.bestCase ?? 0
  });
}

/**
 * How dangerous one hostile is to the selected unit, for the threat lines (grade in engine/combat/threat.mjs). The
 * grade doesn't predict what the Enemy AI will do, so the attack is never treated as certain and the lethal tier is
 * never given here. An incapacitated hostile grades inert.
 */
export function gradeIncomingThreat({ incapacitated = false, targetHp = 0, matchups = [] } = {}) {
  if (incapacitated) return Object.freeze({ tier: THREAT_TIERS.INERT, damageOnHit: 0 });
  const graded = gradeMatchupThreat({ matchup: strongestMatchup(matchups), targetHp });
  return Object.freeze({ tier: graded.tier, damageOnHit: graded.damageOnHit });
}

/* -------------------------------------------- */
/*  Grading helpers                             */
/* -------------------------------------------- */

/**
 * Damage if every attack hits with average rolls (`onHit`) and at best, with maximum rolls and crits (`bestCase`),
 * or null when the matchup makes no attack. Severity isn't weighted by hit chance, because an unlikely lethal hit
 * still needs a warning.
 */
function damageFigures(matchup) {
  if (!matchup || finite(matchup.attackCount) < MIN_ATTACK_COUNT) return null;
  const attacks = Math.max(MIN_ATTACK_COUNT, Math.floor(finite(matchup.attackCount)));
  const hitChance = clamp(finite(matchup.hitChance), CHANCE_MIN, CHANCE_MAX);
  const critChance = clamp(finite(matchup.critChance), CHANCE_MIN, CHANCE_MAX);
  const critMultiplier = finite(matchup.critMultiplier) || CRITICAL_MULTIPLIER_BASE;
  const { average, maximum } = damageSpread(matchup.damage);
  return {
    onHit: hitChance > 0 ? average * attacks : 0,
    bestCase: hitChance > 0 ? maximum * (critChance > 0 ? critMultiplier : 1) * attacks : 0
  };
}

/** The tier a damage figure earns against the target's current HP. Lethal is given only with allowLethal. */
function threatTier(damage, targetHp, allowLethal) {
  const hp = finite(targetHp);
  if (!damage || hp <= 0) return THREAT_TIERS.MINOR;
  if (allowLethal && damage.onHit >= hp) return THREAT_TIERS.LETHAL;
  if ((damage.onHit / hp) > THREAT_SEVERE_HP_FRACTION || damage.bestCase >= hp) return THREAT_TIERS.SEVERE;
  return THREAT_TIERS.MINOR;
}

/** The matchup with the most on-hit damage (the first of equals), or null when none makes an attack. */
function strongestMatchup(matchups) {
  let best = null;
  let bestDamage = null;
  for (const matchup of matchups) {
    const damage = damageFigures(matchup);
    if (!damage || (bestDamage && damage.onHit <= bestDamage.onHit)) continue;
    best = matchup;
    bestDamage = damage;
  }
  return best;
}

function damageSpread(value) {
  const text = String(value ?? '0').trim();
  const spread = text.match(/^(\d+)-(\d+)$/);
  if (spread) {
    const low = Number(spread[1]);
    const high = Number(spread[2]);
    return { average: (low + high) / 2, maximum: high };
  }
  const flat = parseInt(text, 10);
  const figure = Number.isNaN(flat) ? 0 : flat;
  return { average: figure, maximum: figure };
}
