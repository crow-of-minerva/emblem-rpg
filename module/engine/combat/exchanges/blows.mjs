/** @layer engine/combat/exchanges */
import { COMBAT_EXCHANGE_TIMING, COMBAT_SIDES } from '../../../contracts/domains/combat.mjs';
import { DEFEAT_PRESENTATION_TIMING } from '../../../contracts/domains/damage.mjs';
import { MAGIC_PROFICIENCIES, WEAPON_PROFICIENCIES } from '../../../contracts/domains/items.mjs';
import {
  buildCombatSequence,
  combatWeaponHasUses,
  resolveCombatBlow,
  sideDown
} from '../../../game/combat/exchange.mjs';
import { defeatEndsExchange } from '../../../game/combat/damage.mjs';
import { earnsCharacterExperience, resolveWeaponExperience } from '../../../game/progression/rules.mjs';
import { CombatPersistenceError, StaleCombatError } from '../../recovery/errors.mjs';
import { cardRequester, presentSafely } from '../../feedback.mjs';
import { requireActiveExchangeSnapshot } from './gates.mjs';
import {
  attackMessage,
  blowRecord,
  combatDamagePresentation,
  damageMessage,
  impactMessage,
  noticeMessage
} from './receipts.mjs';
import {
  effectEndedExchange,
  presentCombatImpact,
  revalidateEffectDefeats,
  runHitTriggers,
  runMissTriggers,
  settleCombatStance
} from './settlement.mjs';

/* -------------------------------------------- */
/*  Blow sequence                               */
/* -------------------------------------------- */

/** Run the attack's blows in order, reading both units fresh from the map before each one. */
export async function runCombatSequence(services, exchange) {
  const { intent, context } = exchange;
  const reads = exchangeReads(services.combatState, exchange.operation, context.userId, true);
  let snapshot = await requireActiveExchangeSnapshot(reads, intent, context.userId);
  exchange.defenderCouldCounterAtStart = snapshot.defenderCanRespond;
  // No blows when a pre-combat effect ended the exchange or left the attacker out of range.
  let remaining = effectEndedExchange(exchange.effectHealth, exchange.preCombatEffectIndex) || !snapshot.sourceInRange
    ? [] : [...buildCombatSequence(snapshot.source, snapshot.target, snapshot.defenderCanRespond)];
  // Blows are labelled A1, A2... for the attacker and D1, D2... for the defender. `completed` holds the highest
  // number each side has reached, so a rebuilt sequence skips blows already taken.
  const completed = { A: 0, D: 0 };
  // The last read of the map, kept until a blow uses it. Nothing writes or awaits between this read and the next
  // blow, so that blow starts from it instead of reading again.
  let unwritten = snapshot;
  while (remaining.length) {
    const label = remaining.shift();
    const prefix = label.charAt(0);
    completed[prefix] = Math.max(completed[prefix], Number(label.slice(1)) || 0);
    if (prefix === 'A' && intent.skippedAttacks.includes(label)) continue;

    // Every blow starts from newly derived Actors because the preceding blow may have changed combat stats.
    snapshot = unwritten ?? await requireActiveExchangeSnapshot(reads, intent, context.userId);
    unwritten = null;
    const sequenceState = sequenceStateOf(snapshot);
    const rolled = await rollBlow(services, snapshot, label, intent);
    if (!blowRemainsLegal(rolled.acting, rolled.combat, exchange.useLedger)) continue;
    if (sideDown(rolled.defending)) break;
    if (!rolled.attackingSource) exchange.defenderCountered = true;
    const blowEffectIndex = exchange.effectHealth.length;

    const blow = await settleBlow(services, exchange, snapshot, rolled);
    await revalidateEffectDefeats(services, exchange.effectHealth, blowEffectIndex, exchange.operation);
    await services.settlement.completeBlow(rolled.acting, rolled.defending,
      { landed: blow.result !== 'miss', operation: exchange.operation });
    exchange.transcript.push(blow);
    remaining = await pruneBrokenWeapon(services, exchange, rolled, remaining);
    if (defeatEndsExchange(blow.defeatStatus) || effectEndedExchange(exchange.effectHealth, blowEffectIndex)) break;

    await services.wait(delayBeforeNextBlow(snapshot, remaining, rolled.side));
    snapshot = await requireActiveExchangeSnapshot(reads, intent, context.userId);
    unwritten = snapshot;
    remaining = rebuildSequence(snapshot, sequenceState, remaining, completed, exchange.useLedger);
  }
}

/**
 * Read the attack's state. Each read also carries the command's operation, so writes made from it save undo data
 * there.
 * @param {object} combatState The combat state reader.
 * @param {object|null} operation The dispatcher operation the exchange writes under.
 * @param {string} [requesterUserId] The user who started the exchange, the audience for its effect notices.
 * @param {boolean} [afterPreCombat] Whether the pre-combat effects have already run.
 * @returns {{getSnapshot: Function}}
 */
export function exchangeReads(combatState, operation = null, requesterUserId = '', afterPreCombat = false) {
  const audience = Object.freeze(requesterUserId ? [String(requesterUserId)] : []);
  return { getSnapshot: async intent => {
    const snapshot = await combatState.getSnapshot(intent, { afterPreCombat });
    return snapshot ? Object.freeze({ ...snapshot, operation, audience }) : snapshot;
  } };
}

function sequenceStateOf(snapshot) {
  return {
    sourceSpeed: snapshot.source.speed,
    targetSpeed: snapshot.target.speed,
    sourceStance: snapshot.source.stance.value,
    targetStance: snapshot.target.stance.value
  };
}

/** Roll the acting side's combat line for one blow before its legality is judged. */
async function rollBlow(services, snapshot, label, intent) {
  const attackingSource = label.charAt(0) === 'A';
  const acting = attackingSource ? snapshot.source : snapshot.target;
  const defending = attackingSource ? snapshot.target : snapshot.source;
  const rolledCombat = await services.combatState.rollCombatSide(acting, defending, {
    distance: snapshot.distance,
    damageType: attackingSource ? intent.damageType : ''
  });
  return {
    label,
    attackingSource,
    acting,
    defending,
    rolledCombat,
    combat: rolledCombat.combat,
    side: attackingSource ? COMBAT_SIDES.ATTACKER : COMBAT_SIDES.DEFENDER
  };
}

/**
 * Count the attacker's Weapon Art use, spend the Marked effect empowering the blow and one of the defender's
 * Dexterity points, then roll the attack, show the swing and resolve it as a miss or a hit.
 */
async function settleBlow(services, exchange, snapshot, rolled) {
  const { label, side, acting, defending, combat, attackingSource, rolledCombat } = rolled;
  const operation = exchange.operation;
  if (attackingSource && acting.weaponArt && acting.weaponArt.uses?.infinite !== true) {
    addUse(exchange.useLedger, acting.weaponArt.uuid, 1);
  }
  await services.settlement.consumeMarkedEffect(acting, operation);
  if (defending.dexterity > 0) await services.settlement.spendDexterity(defending.actorUuid, operation);
  const check = await services.combatState.rollAttack(acting, defending, combat, {
    karmaBookings: Object.freeze([...exchange.karmaBookings])
  });
  if (check.karmaBooking) exchange.karmaBookings.push(check.karmaBooking);
  await presentSafely(services, attackMessage(label, side, snapshot, acting, defending, check));

  const blow = blowRecord(label, side, check, acting, defending);
  if (check.result === 'miss') return settleMissedBlow(services, exchange, snapshot, rolled, blow);
  return settleLandedBlow(services, exchange, snapshot, rolled, blow);
}

/* -------------------------------------------- */
/*  Missed blows                                */
/* -------------------------------------------- */

/**
 * A miss still earns weapon XP, and spends a use when the weapon needs a magic school, before its miss triggers
 * run. The school alone decides the use: a Spell that needs none is magic for Silence, but spends nothing on a miss.
 */
async function settleMissedBlow(services, exchange, snapshot, rolled, blow) {
  const { acting, defending } = rolled;
  if (MAGIC_PROFICIENCIES.includes(String(acting.weapon.proficiency ?? '').toLowerCase())) {
    addUse(exchange.useLedger, acting.weapon.uuid, 1);
  }
  addProficiencyAward(exchange.proficiencyAwards, acting, false);
  await presentSafely(services, impactMessage(blow, acting, defending, null, cardRequester(exchange.context)));
  await runMissTriggers(services, acting, defending, snapshot, blow.check, exchange.effectHealth);
  return blow;
}

/* -------------------------------------------- */
/*  Landed blows                                */
/* -------------------------------------------- */

/**
 * Resolve a hit: roll damage, write health and Stance Break, show the impact, then run the hit and kill effects.
 */
async function settleLandedBlow(services, exchange, snapshot, rolled, blow) {
  const { label, side, acting, defending } = rolled;
  const combat = landedCombatLine(rolled.combat, blow.check);
  const rolledDamage = await services.combatState.rollDamage(combat.damageFormula);
  const resolved = resolveCombatBlow({
    attacker: { ...acting, breakDamage: combat.breakDamage },
    defender: defending.healthTarget,
    side,
    check: blow.check,
    rolledDamage,
    damageType: combat.damageType
  });
  const persisted = await commitOrFail(() => services.settlement.commitBlow(defending, resolved.resolution,
    exchange.operation));
  const stanceBreak = await settleCombatStance(services.stances, defending.actorUuid, exchange.operation);
  addUse(exchange.useLedger, acting.weapon.uuid, 1);
  addProficiencyAward(exchange.proficiencyAwards, acting, true);
  let landed = Object.freeze({
    ...blow,
    damageType: combat.damageType,
    rolledDamage,
    amount: resolved.resolution.amount,
    stanceAmount: resolved.resolution.stanceAmount,
    hpBefore: resolved.resolution.hpBefore,
    hpAfter: Number.isFinite(persisted.hpAfter) ? persisted.hpAfter : resolved.resolution.hpAfter,
    stanceAfter: Number.isFinite(persisted.stanceAfter) ? persisted.stanceAfter : resolved.resolution.stanceAfter,
    critical: resolved.critical,
    damage: combatDamagePresentation(combat, resolved.resolution, rolledDamage, acting, defending),
    defeatStatus: persisted.defeatStatus ?? null,
    extraLivesAfter: persisted.extraLivesAfter
  });
  await presentCombatImpact(services, exchange.stanceBreaks, stanceBreak, impactMessage(landed, acting, defending,
    damageMessage(defending, resolved.resolution, persisted, resolved.critical), cardRequester(exchange.context)));
  if (landed.defeatStatus) await services.wait(DEFEAT_PRESENTATION_TIMING.continuationDelay);
  const defeatStatus = await runHitTriggers(services, acting, defending, snapshot, landed, exchange.effectHealth,
    exchange.restores);
  if (defeatStatus && defeatStatus !== landed.defeatStatus) {
    landed = Object.freeze({ ...landed, defeatStatus });
  }
  return landed;
}

/**
 * The combat line a landed blow is rolled and reported on. A crit uses the critical damage formula and
 * mitigation when its mitigation differs.
 */
function landedCombatLine(combat, check) {
  if (check.result !== 'crit' || combat.criticalMitigation === combat.mitigation) return combat;
  return Object.freeze({
    ...combat,
    damageFormula: combat.criticalDamageFormula,
    mitigation: combat.criticalMitigation,
    mitigationFull: combat.mitigation
  });
}

async function commitOrFail(commit) {
  const persisted = await commit();
  if (persisted?.stale === true) throw new StaleCombatError();
  if (persisted?.ok !== true) throw new CombatPersistenceError(persisted.code);
  return persisted;
}

/* -------------------------------------------- */
/*  Sequence upkeep                             */
/* -------------------------------------------- */

/** Drop the rest of a side's blows once its weapon has no uses left, and say so. */
async function pruneBrokenWeapon(services, exchange, rolled, remaining) {
  const { acting, attackingSource } = rolled;
  if (!weaponBroke(acting, exchange.useLedger) || exchange.brokenItems.has(acting.weapon.uuid)) return remaining;
  exchange.brokenItems.add(acting.weapon.uuid);
  const prefixToLose = attackingSource ? 'A' : 'D';
  const lost = remaining.filter(candidate => candidate.startsWith(prefixToLose)).length;
  const kept = remaining.filter(candidate => !candidate.startsWith(prefixToLose));
  await presentSafely(services, noticeMessage('warn', `${acting.actorName}'s ${acting.weapon.name} broke!`));
  if (lost > 0) {
    await presentSafely(services, noticeMessage('info',
      `${acting.actorName} loses ${lost} remaining attack${lost === 1 ? '' : 's'}!`));
  }
  return kept;
}

function delayBeforeNextBlow(snapshot, remaining, side) {
  if (objectDelay(snapshot)) return COMBAT_EXCHANGE_TIMING.objectBlow;
  const nextSide = remaining[0]?.startsWith('A') ? COMBAT_SIDES.ATTACKER
    : remaining[0]?.startsWith('D') ? COMBAT_SIDES.DEFENDER : null;
  return nextSide === side ? COMBAT_EXCHANGE_TIMING.sameSideBlow : COMBAT_EXCHANGE_TIMING.sideChangeBlow;
}

/** Rebuild the remaining sequence when a speed or stance change altered who strikes how often. */
function rebuildSequence(snapshot, sequenceState, remaining, completed, useLedger) {
  const speedChanged = sequenceState.sourceSpeed !== snapshot.source.speed
    || sequenceState.targetSpeed !== snapshot.target.speed;
  const stanceChanged = (sequenceState.sourceStance > 0 && snapshot.source.stance.value <= 0)
    || (sequenceState.targetStance > 0 && snapshot.target.stance.value <= 0);
  if (!speedChanged && !stanceChanged) return remaining;
  const defenderCanRespond = snapshot.defenderCanRespond && !weaponBroke(snapshot.target, useLedger);
  const fresh = buildCombatSequence(snapshot.source, snapshot.target, defenderCanRespond);
  return fresh.filter(candidate => {
    const candidatePrefix = candidate.charAt(0);
    if ((Number(candidate.slice(1)) || 0) <= completed[candidatePrefix]) return false;
    const candidateSide = candidatePrefix === 'A' ? snapshot.source : snapshot.target;
    return !weaponBroke(candidateSide, useLedger);
  });
}

/* -------------------------------------------- */
/*  Ledgers                                     */
/* -------------------------------------------- */

function blowRemainsLegal(side, combat, useLedger) {
  if (side.hp.value <= 0 || side.stance.value <= 0 || !side.weapon.present) return false;
  if (side.silenced && side.weapon.magic) return false;
  return combatWeaponHasUses(side.weapon, useLedger[side.weapon.uuid] ?? 0) && combat.damageType !== '';
}

function weaponBroke(side, useLedger) {
  if (!side.weapon.present || side.weapon.uses.infinite) return false;
  return !combatWeaponHasUses(side.weapon, useLedger[side.weapon.uuid] ?? 0);
}

/** Count `amount` uses of an item in the exchange's use ledger. */
export function addUse(ledger, itemUuid, amount) {
  if (itemUuid) ledger[itemUuid] = (ledger[itemUuid] ?? 0) + amount;
}

function addProficiencyAward(ledger, side, hit) {
  const key = `${side.actorUuid}:${side.proficiency.key}`;
  const current = ledger.get(key) ?? { side, hits: 0, misses: 0 };
  if (hit) current.hits += 1;
  else current.misses += 1;
  ledger.set(key, current);
}

/**
 * Turn the attack's hits and misses into weapon proficiency XP and rank-ups, feeding resolveWeaponExperience one
 * swing at a time: all hits first, then all misses. A rank-up raises the stored base rank, while each swing's XP
 * threshold comes from the unit's total rank (base plus bonuses). Only the last rank-up per proficiency is reported.
 */
export function proficiencyUpdates(ledger) {
  const updates = {};
  const rankUps = [];
  for (const { side, hits, misses } of ledger.values()) {
    const proficiency = side.proficiency;
    if (!proficiency.key || !earnsCharacterExperience(side.actorType)) continue;
    if (!WEAPON_PROFICIENCIES.includes(String(proficiency.key).toLowerCase())) continue;
    let rank = Math.max(0, Math.floor(Number(proficiency.total) || 0));
    let base = Math.max(0, Math.floor(Number(proficiency.base) || 0));
    let xp = Math.max(0, Math.floor(Number(proficiency.xp) || 0));
    let rankUp = null;
    for (let index = 0; index < hits + misses; index += 1) {
      const result = resolveWeaponExperience({
        proficiency: { ...proficiency, total: rank, xp },
        hit: index < hits,
        multiplier: proficiency.multiplier
      });
      if (!result) continue;
      if (result.rankedUp) {
        base += 1;
        rankUp = { rankLetter: result.rankLetter, rank: result.rank };
      }
      rank = result.rank;
      xp = result.xp;
    }
    updates[side.actorUuid] = {
      ...(updates[side.actorUuid] ?? {}),
      [`system.prof.${proficiency.key}.base`]: base,
      [`system.prof.${proficiency.key}.xp`]: xp
    };
    if (rankUp) rankUps.push({ side, key: proficiency.key, ...rankUp });
  }
  return { updates, rankUps };
}

/** Whether either side of the attack is a Destructible, which uses its own timing and skips some animations. */
export function objectDelay(snapshot) {
  return snapshot.source.destructible || snapshot.target.destructible;
}
