/** @layer game/combat */
import { DAMAGE_TYPES } from '../../contracts/domains/damage.mjs';
import {
  buildCombatSequence,
  calculateCombatSide,
  combatAttackCount,
  defenderCanCounter
} from './exchange.mjs';
import { rangeReachesEngagement } from '../targeting/attack-grid.mjs';
import { holdsProficiencyRank } from '../progression/rules.mjs';
import { finite as number } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Rule constants                              */
/* -------------------------------------------- */

/**
 * A broken stance costs the defender 4 speed, the same lead an attacker needs for one extra attack. Matches the
 * Stance Break effect's -4 Agility in config/statuses.mjs; change both together.
 */
const BROKEN_STANCE_SPEED_LOSS = 4;

/**
 * Unit stats passed straight through to the combat rules in exchange.mjs, which clean them up themselves.
 * normalizeSide adds the fields this file reads; any other field is dropped.
 */
const CARRIED_RULE_FACTS = Object.freeze([
  'attack', 'accuracy', 'evasion', 'crit', 'speed', 'defense', 'resistance', 'breakDamage', 'charisma',
  'blessed', 'flanked', 'blinded', 'firstStrike', 'cannotCounter', 'counterlock', 'impervious',
  'critDefenseBreak', 'truestrike', 'shine', 'silenced', 'markedAdvantage', 'markedAttackBonus', 'markedCritBonus',
  'markedSpeedBonus', 'dexterity', 'extraAttacks', 'unitTypes', 'protections', 'vulnerabilities', 'immunities',
  'effectiveAgainst', 'weaponAdvantages', 'armor', 'damageTypeConditions', 'conditionSelf', 'conditionItem'
]);

/* -------------------------------------------- */
/*  Preview calculation                         */
/* -------------------------------------------- */
/**
 * Work out a matchup's preview numbers without rolling: each side's damage, hit and crit chances, attack count, and
 * the attack order. Used by the Combat Preview window, the threat overlay and the Enemy AI. The real exchange rolls
 * and saves in engine/combat/exchanges/.
 * @param {object} input Plain attacker, defender, weapon and distance data. `reachDistance` and
 *   `reachEngagement` are where the host checks range, before any move the attack makes; they default to the fought
 *   `distance` and `engagement`.
 * @returns {Readonly<object>} The frozen preview numbers for both sides.
 */
export function calculateAttackPreview(input = {}) {
  const attacker = normalizeSide(input.attacker);
  const defender = normalizeSide(input.defender);
  const distance = Math.max(0, Number(input.distance) || 0);
  const engagement = String(input.engagement ?? '');
  attacker.validWeapons = validPreviewWeapons(attacker, Math.max(0, Number(input.reachDistance ?? distance) || 0),
    String(input.reachEngagement ?? engagement));
  const attackerCombat = calculateCombatSide(attacker, defender, {
    distance,
    damageType: input.damageType,
    damageTypeRoll: input.attackerDamageTypeRoll
  });
  const defenderCombat = calculateCombatSide(defender, attacker, {
    distance,
    damageTypeRoll: input.defenderDamageTypeRoll
  });
  const defenderCanRespond = defenderCanCounter(defender, distance, attacker, engagement);
  const sequence = buildCombatSequence(attacker, defender, defenderCanRespond);
  const attackerCount = sequence.filter(label => label.startsWith('A')).length;
  const defenderCount = sequence.filter(label => label.startsWith('D')).length;
  const attackSequence = sequence.join(', ');

  return Object.freeze({
    attacker: sideProjection(attacker, defender, attackerCombat, attackerCount),
    defender: sideProjection(defender, attacker, defenderCombat, defenderCount),
    defenderCanRespond,
    attackSequence,
    weaponArt: null
  });
}

/* -------------------------------------------- */
/*  Per-side preview                            */
/* -------------------------------------------- */
function sideProjection(self, target, combat, count) {
  const damage = formulaRange(combat.damageFormula);
  return Object.freeze({
    name: self.name,
    actorType: self.actorType,
    image: self.image,
    legacyArt: self.legacyArt,
    tokenWidth: self.tokenWidth,
    tokenHeight: self.tokenHeight,
    textureScale: self.textureScale,
    hp: Object.freeze({ ...self.hp }),
    stance: Object.freeze({ ...self.stance }),
    weapon: Object.freeze({ ...self.weapon, damageType: combat.damageType }),
    validWeapons: Object.freeze(self.validWeapons.map(weapon => Object.freeze({ ...weapon }))),
    damageTypes: Object.freeze([...self.damageTypes]),
    selectedDamageType: combat.damageType,
    randomizeDamageType: self.randomizeDamageType,
    damage,
    hitChance: combat.hitChance,
    critChance: combat.critChance,
    attackCount: count,
    onBreakAttackCount: projectedOnBreakCount(self, target, count, combat.breakDamage),
    breakDamage: combat.breakDamage,
    effective: combat.effective,
    advantage: combat.advantage,
    disadvantage: combat.disadvantage,
    damageAffinity: combat.affinity
  });
}

/**
 * Clean up one unit's stats for the preview: the fields this file reads get their proper types, and the stats in
 * CARRIED_RULE_FACTS pass through unchanged.
 * @param {object} [side] One unit's plain stats from foundry/adapters/projections/attack-targeting.mjs.
 * @returns {object} The cleaned-up stats, used by this file and exchange.mjs.
 */
function normalizeSide(side = {}) {
  const shaped = {};
  for (const key of CARRIED_RULE_FACTS) shaped[key] = side[key];
  return Object.assign(shaped, {
    name: String(side.name ?? ''),
    actorType: String(side.actorType ?? 'Neutral'),
    image: String(side.image ?? ''),
    legacyArt: side.legacyArt === true,
    tokenWidth: Math.max(1, Number(side.tokenWidth) || 1),
    tokenHeight: Math.max(1, Number(side.tokenHeight) || 1),
    textureScale: Math.abs(Number(side.textureScale) || 1),
    hp: numericTrack(side.hp),
    stance: numericTrack(side.stance),
    airborne: side.airborne === true,
    noExtraAttacks: side.noExtraAttacks === true,
    randomizeDamageType: side.randomizeDamageType === true,
    damageTypes: DAMAGE_TYPES.filter(type => side.damageTypes?.includes?.(type) || side.damageTypes?.[type] === true),
    proficiencies: Object.freeze({ ...(side.proficiencies ?? {}) }),
    weapon: normalizeWeapon(side.weapon),
    validWeapons: Array.isArray(side.validWeapons) ? side.validWeapons.map(normalizeWeapon) : []
  });
}

function normalizeWeapon(weapon = {}) {
  return {
    id: weapon.id == null ? null : String(weapon.id),
    name: String(weapon.name ?? ''),
    image: String(weapon.image ?? weapon.img ?? ''),
    range: String(weapon.range ?? '1'),
    baseRange: String(weapon.baseRange ?? weapon.range ?? '1'),
    proficiency: String(weapon.proficiency ?? ''),
    requiredRank: Math.max(0, Math.floor(number(weapon.requiredRank))),
    damageType: String(weapon.damageType ?? 'none'),
    magic: weapon.magic === true,
    fixed: weapon.fixed === true,
    shieldBlocked: weapon.shieldBlocked === true,
    present: weapon.present !== false && Boolean(weapon.id || weapon.name || weapon.image || weapon.img),
    uses: Object.freeze({
      current: Math.max(0, number(weapon.uses?.current)),
      max: Math.max(0, number(weapon.uses?.max)),
      infinite: weapon.uses?.infinite === true || weapon.uses?.type === 'infinite'
    })
  };
}

/**
 * The weapons the Combat Preview offers to switch to: those that pass the host's range check at this distance and
 * that the side has the rank for, with the current weapon first. Each weapon's `range` is its own reach in the unit's
 * hands (projectWeaponChoicesAs in foundry/adapters/projections/characters.mjs). A weapon in a proficiency the side
 * has no total for is left out. One marked `shieldBlocked` stays, for the preview to show but not offer.
 */
function validPreviewWeapons(side, distance, engagement = '') {
  const current = side.weapon;
  return side.validWeapons
    .flatMap(weapon => {
      if (!rangeReachesEngagement(weapon.range, distance, engagement, side.airborne)) return [];
      if (weapon.id !== current.id
        && !holdsProficiencyRank(side.proficiencies, weapon.proficiency, weapon.requiredRank)) return [];
      return [Object.freeze({ ...weapon })];
    })
    .sort((left, right) => left.id === current.id ? -1 : right.id === current.id ? 1 : 0);
}

/* -------------------------------------------- */
/*  Preview values                              */
/* -------------------------------------------- */
/**
 * Whether the planned attacks' break damage would empty the defender's stance. Used by projectedOnBreakCount and by
 * the Enemy AI's matchup data (`willBreak` in projections/attack-targeting.mjs).
 * @param {{breakDamage?: number, stance?: number, attackCount?: number}} [input] Break damage per hit, remaining
 *   stance and number of attacks.
 * @returns {boolean}
 */
export function stanceBreaksUnderAttacks({ breakDamage, stance, attackCount } = {}) {
  const value = Number(breakDamage) || 0;
  const remaining = Number(stance) || 0;
  if (value <= 0 || remaining < 1) return false;
  return Math.ceil(remaining / value) <= Math.max(0, Math.floor(Number(attackCount) || 0));
}

/**
 * The midpoint of a plain XdY±N formula's range, with both ends floored at 0, or null for anything else. Used for
 * the Enemy AI's healing and phase damage estimates, and by the item sheet to check that a formula can be read.
 * @param {unknown} formula Authored damage or healing formula.
 * @returns {number|null} The average, or null when the text is not a plain formula.
 */
export function averageFormulaValue(formula) {
  // A blank formula is an absence, not a zero: Number('') is 0, so the bounds below would read it as real damage.
  if (String(formula ?? '').trim() === '') return null;
  const bounds = String(formulaRange(formula)).split('-');
  const low = Number(bounds[0]);
  const high = bounds.length > 1 ? Number(bounds[1]) : low;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return (low + high) / 2;
}

function formulaRange(formula) {
  const compact = String(formula).replaceAll(' ', '').replaceAll('--', '+');
  if (/^[+-]?\d+(?:[+-]\d+)*$/.test(compact)) return String(Math.max(0, arithmetic(compact)));
  const dice = compact.match(/^(-?\d+)d(\d+)((?:[+-]\d+)*)$/i);
  if (!dice) return compact;
  const count = Number(dice[1]);
  const size = Number(dice[2]);
  const modifier = arithmetic(dice[3]);
  const low = count >= 0 ? count : count * size;
  const high = count >= 0 ? count * size : count;
  const minimum = Math.max(0, low + modifier);
  const maximum = Math.max(0, high + modifier);
  return minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
}

function arithmetic(expression) {
  const values = expression.match(/[+-]?\d+/g) ?? [];
  return values.reduce((total, value) => total + Number(value), 0);
}

function projectedOnBreakCount(attacker, defender, current, breakValue) {
  if (attacker.noExtraAttacks) return 0;
  if (!stanceBreaksUnderAttacks({
    breakDamage: breakValue, stance: defender.stance.value, attackCount: current
  })) return 0;
  const projected = combatAttackCount(attacker, defender, -BROKEN_STANCE_SPEED_LOSS);
  return projected > current ? projected : 0;
}

/* -------------------------------------------- */
/*  Value helpers                               */
/* -------------------------------------------- */
function numericTrack(track = {}) {
  return { value: Math.max(0, number(track.value)), max: Math.max(0, number(track.max)) };
}
