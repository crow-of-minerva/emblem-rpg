/** @layer engine/combat/exchanges */
import {
  COMBAT_PRESENTATION_BEATS,
  combatPresentationMessage
} from '../../../contracts/domains/combat.mjs';
import { HEALTH_CHANGE_TYPES, healthPresentationMessage } from '../../../contracts/domains/damage.mjs';
import { criticalMultiplierAgainst } from '../../../game/combat/damage.mjs';

const PHYSICAL_DAMAGE_TYPES = ['slashing', 'piercing', 'crushing', 'missile', 'none', ''];
const MAGICAL_DAMAGE_TYPES = ['fire', 'ice', 'lightning', 'wind', 'decay', 'arcane', 'shadow', 'holy'];

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
// The messages an exchange broadcasts for CombatPresentation to play on every client.

export function startMessage(snapshot) {
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.START, {
    sourceTokenUuid: snapshot.sourceTokenUuid,
    targetTokenUuid: snapshot.targetTokenUuid,
    sequence: snapshot.sequence,
    cinematic: snapshot.cinematic,
    objectTarget: snapshot.target.destructible === true
  });
}

export function weaponArtMessage(snapshot) {
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.WEAPON_ART, {
    sourceTokenUuid: snapshot.sourceTokenUuid,
    sourceActorUuid: snapshot.sourceActorUuid,
    weaponArt: snapshot.source.weaponArt
  });
}

export function attackMessage(label, side, snapshot, acting, defending, check) {
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.ATTACK, {
    label,
    side,
    sourceTokenUuid: acting.tokenUuid,
    targetTokenUuid: defending.tokenUuid,
    sourceActorUuid: acting.actorUuid,
    targetActorUuid: defending.actorUuid,
    distance: snapshot.distance,
    result: check.result,
    check,
    attackAnimation: acting.attackAnimation,
    criticalAnimation: acting.criticalAnimation,
    activationAnimation: acting.activationAnimation,
    source: combatantPresentation(acting),
    target: combatantPresentation(defending)
  });
}

/**
 * The impact message CombatPresentation plays for a blow. It carries the requesting user, so the attack card uses
 * the attacker's roll mode.
 */
export function impactMessage(blow, acting, defending, health = null, requester = null) {
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.IMPACT, {
    ...blow,
    sourceTokenUuid: acting.tokenUuid,
    targetTokenUuid: defending.tokenUuid,
    ...(health ? { health } : {}),
    ...(requester ? { requester } : {})
  });
}

export function noticeMessage(level, message) {
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.NOTICE, { level, message });
}

/** Build the proficiency rank-up message publishExchange sends after the exchange's proficiency writes. */
export function rankUpMessage(rankUp, requester = null) {
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.RANK_UP, {
    actorUuid: rankUp.side.actorUuid,
    actorName: rankUp.side.actorName,
    actorImage: rankUp.side.actorImage,
    avatarScale: rankUp.side.avatarScale,
    proficiencyKey: rankUp.key,
    rankLetter: rankUp.rankLetter,
    rank: rankUp.rank,
    ...(requester ? { requester } : {})
  });
}

export function endMessage(payload) {
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.END, payload);
}

/* -------------------------------------------- */
/*  Blow records                                */
/* -------------------------------------------- */

/** The transcript entry every blow starts from before its result is known. */
export function blowRecord(label, side, check, acting, defending) {
  return Object.freeze({
    label,
    side,
    result: check.result,
    check,
    sourceActorUuid: acting.actorUuid,
    targetActorUuid: defending.actorUuid,
    source: combatantPresentation(acting),
    target: combatantPresentation(defending)
  });
}

function combatantPresentation(side) {
  return Object.freeze({
    actorName: side.actorName,
    actorImage: side.actorImage,
    avatarScale: side.avatarScale,
    factionColor: side.factionColor,
    hasVoicePath: side.hasVoicePath === true,
    weapon: side.weapon,
    weaponArt: side.weaponArt,
    usedItem: side.usedItem ?? null
  });
}

/** The damage breakdown the attack card explains a landed blow with. */
export function combatDamagePresentation(combat, resolution, rolledDamage, acting, defending) {
  const physical = PHYSICAL_DAMAGE_TYPES.includes(resolution.damageType);
  const magical = MAGICAL_DAMAGE_TYPES.includes(resolution.damageType);
  const mitigationBase = physical ? Number(defending.defense) || 0
    : magical ? Number(defending.resistance) || 0 : 0;
  const mitigationFull = Number(combat.mitigationFull ?? combat.mitigation) || 0;
  return Object.freeze({
    attackFormula: combat.attackFormula,
    damageFormula: combat.damageFormula,
    rolled: rolledDamage,
    dealt: resolution.amount,
    stance: resolution.stanceAmount,
    breakDamage: combat.breakDamage,
    damageType: resolution.damageType,
    mitigation: combat.mitigation,
    mitigationStat: physical ? 'Def' : magical ? 'Res' : null,
    mitigationBase,
    mitigationArmor: Math.max(0, mitigationFull - mitigationBase),
    mitigationBroken: mitigationFull > (Number(combat.mitigation) || 0),
    effective: combat.effective,
    effectivenessMultiplier: combat.effectivenessMultiplier,
    criticalMultiplier: criticalMultiplierAgainst(acting.criticalMultiplier, defending.healthTarget),
    protectionApplied: resolution.protectionApplied,
    vulnerabilityApplied: resolution.vulnerabilityApplied,
    immunityApplied: defending.immunities?.includes?.(resolution.damageType) === true,
    breakBase: Number(acting.breakDamage) || 0,
    breakReduction: Number(defending.healthTarget?.breakReduction) || 0
  });
}

/* -------------------------------------------- */
/*  Health messages                             */
/* -------------------------------------------- */

/**
 * The damage numbers for a landed blow, from the totals actually written. `lastHit` comes from the rolled result
 * (`resolution.defeated`), not from the defeat the write recorded.
 */
export function damageMessage(target, resolution, persisted, critical) {
  return healthPresentationMessage({
    tokenUuid: target.tokenUuid,
    change: HEALTH_CHANGE_TYPES.DAMAGE,
    resolution,
    persisted,
    critical,
    lastHit: resolution.defeated
  });
}
