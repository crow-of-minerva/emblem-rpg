/** @layer foundry/adapters/projections */
import { HIT_CHANCE_MODEL_SETTING } from '../../../config/settings.mjs';
import { HIT_CHANCE_MODELS, KARMA_LEDGER_RESOURCE_KEY } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { triggerGroupForItem } from '../../../contracts/dsl/effects.mjs';
import { DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import { sceneCombatActive, sceneExplorationActive } from './encounters.mjs';
import {
  checkKarmicPull,
  nextKarmaDebt,
  replayKarmaBookings,
  resolveAttackCheck,
  twoRandomNumberNatural
} from '../../../game/rolls/checks.mjs';
import { readKarmaLedger } from '../dice/karma.mjs';
import {
  buildCombatSequence,
  calculateCombatSide,
  combatDamageTypes,
  defenderCanCounter
} from '../../../game/combat/exchange.mjs';
import {
  CRITICAL_MULTIPLIER_BASE, factionGroup, resolveActionLosRule, resolveAvatarScale, targetTypeAdmits,
  unitIgnoresLineOfSight
} from '../../../game/character/rules.mjs';
import { selectAnimationRange } from '../../../game/effects/animation-planning.mjs';
import { resolveStandingMovementSpent } from '../../../game/movement/input-policy.mjs';
import { airborneBeyondMelee, parseAttackRange, rangeReachesEngagement } from '../../../game/targeting/attack-grid.mjs';
import {
  boardFlanking,
  isAirborneActor,
  isArmamentWeapon,
  isAttackItem,
  isDestructibleActor,
  isMagicItemDocument,
  markedAllyBonus,
  normalizeStatusKey,
  passiveFlag,
  projectActorStatusKeys,
  projectAttackRequirements,
  projectCombatRuleFacts,
  projectDestructibleRuleFacts,
  projectFlightReach,
  projectHealEchoPolicies,
  projectPreCombatApproach,
  projectProficiency,
  projectProficiencyTotals,
  projectWeapon,
  projectWieldedArmament,
  tauntedByActorUuid,
  tokenCells,
  withExchangeFlanking,
  withFoundryCombatContext,
  withMarkedBonus,
  withSharedProjections
} from './combat-context.mjs';
import { projectMovementSnapshot } from './movement.mjs';
import { redirectFoundryHostileToken } from './tokens.mjs';
import { projectFoundryTokenArtItem } from '../document-writes/tokens.mjs';
import { projectHealthTarget } from '../document-writes/health.mjs';
import { collectionValues, digest, finite } from '../../../lib/core/runtime.mjs';
import {
  clone, persistedTokenCenter, resolveItem, resolveToken, sceneWallsTestable, testSceneWallCollision, tokenGridSize
} from '../services/host.mjs';

/* -------------------------------------------- */
/*  Attack data                                 */
/* -------------------------------------------- */

/**
 * Reads everything an attack needs from Foundry and rolls its dice. The host client runs the attack with it, and
 * the acting player's client builds the Combat and Destructible previews from it. init/system.mjs registers it as
 * `combatState`.
 */
export class FoundryCombatStateRepository {
  constructor({ health, movements, unitAudio = null }) {
    this.health = health;
    this.movements = movements;
    this.unitAudio = unitAudio;
  }

  /**
   * The resource keys an attack declares, naming what it may write: the movement board, the karma ledger, the
   * scene, both actors (the target after any Guard redirect), and the weapon and Weapon Art uuids from the request.
   * For an Armament attack the weapon uuid is the Armament's token, not its actor.
   */
  async resourceKeys(payload = {}) {
    const source = await resolveToken(payload.sourceTokenUuid);
    const target = redirectFoundryHostileToken(await resolveToken(payload.targetTokenUuid));
    return [
      'movement:board',
      KARMA_LEDGER_RESOURCE_KEY,
      source?.parent?.uuid ? `scene:${source.parent.uuid}` : '',
      source?.actor?.uuid ? `actor:${source.actor.uuid}` : '',
      target?.actor?.uuid ? `actor:${target.actor.uuid}` : '',
      payload.itemUuid ? `item:${payload.itemUuid}` : '',
      payload.weaponArtUuid ? `item:${payload.weaponArtUuid}` : ''
    ].filter(Boolean);
  }

  /** The resource keys a post-exchange choice declares: the movement board, the Scene and the acting unit's Actor. */
  async continuationResourceKeys(payload = {}) {
    const source = await resolveToken(payload.sourceTokenUuid);
    return [
      'movement:board',
      source?.parent?.uuid ? `scene:${source.parent.uuid}` : '',
      source?.actor?.uuid ? `actor:${source.actor.uuid}` : ''
    ].filter(Boolean);
  }

  /** The current state a pending Extra Action choice is answered from, read fresh from the unit's token. */
  async getContinuationSnapshot(tokenUuid) {
    const token = await resolveToken(tokenUuid);
    if (!token?.actor || token.actor.type !== 'Character') return null;
    const movement = await this.movements.getSnapshot(token.uuid, { hints: false });
    if (!movement) return null;
    const actor = token.actor;
    const turn = actor.system.turn;
    return Object.freeze({
      sceneUuid: String(token.parent?.uuid ?? ''),
      sourceTokenUuid: token.uuid,
      sourceActorUuid: actor.uuid,
      sourceDefeated: finite(actor.system.resources.hp.value) < 1,
      hasCanter: passiveFlag(actor, 'canter'),
      extraActionsRemaining: Math.max(0, finite(actor.system.special.extraActions.value)),
      extraActionUsed: turn.extraActionUsed === true,
      continuationPending: String(turn.continuationPending ?? ''),
      continuationRequestId: String(turn.continuationRequestId ?? ''),
      continuationCanters: turn.continuationCanters === true,
      movementRemaining: Math.max(0, finite(movement.allowance)),
      movement,
      encounterActive: sceneCombatActive(token.parent),
      explorationActive: sceneExplorationActive(token.parent)
    });
  }

  /** Whether the requesting user still controls the movement plan a pending choice holds. */
  canUserOwnContinuation(snapshot, userId) {
    return this.movements.canUserPlan(snapshot?.movement, userId);
  }

  /**
   * Everything one attack needs: both sides, the distance and engagement after any pre-combat move, the attack
   * order, and every check the attack makes, with a fingerprint over them. The host client calls it to run the
   * attack, and the acting player's client calls it for the previews. With `afterPreCombat` the pre-combat effects
   * have already run, so the distance is the current one on the map.
   * @param {object} intent The normalized exchange intent.
   * @param {{afterPreCombat?: boolean}} [options] Whether pre-combat effects have run.
   */
  async getSnapshot(intent, { afterPreCombat = false } = {}) {
    const sourceToken = await resolveToken(intent.sourceTokenUuid);
    let targetToken = await resolveToken(intent.targetTokenUuid);
    targetToken = redirectFoundryHostileToken(targetToken);
    if (!sourceToken?.actor || !targetToken?.actor || sourceToken.parent !== targetToken.parent) return null;
    const objectTarget = isDestructibleActor(targetToken.actor);
    if (sourceToken.actor.type !== 'Character' || (targetToken.actor.type !== 'Character' && !objectTarget)) return null;

    const sourceItem = await resolveWeapon(intent.itemUuid, sourceToken.actor);
    if (!sourceItem || !isAttackItem(sourceItem)) return null;
    if (!isArmamentWeapon(sourceItem) && itemActor(sourceItem)?.uuid !== sourceToken.actor.uuid) return null;
    const sourceArt = intent.weaponArtUuid ? await resolveItem(intent.weaponArtUuid) : null;
    const artPairing = projectWeaponArt(sourceToken.actor, sourceItem, sourceArt, Boolean(intent.weaponArtUuid));
    const targetItem = objectTarget ? null : wieldedAttackItem(targetToken.actor);
    const [sourceHealth, targetHealth, movement] = await Promise.all([
      this.health.getSnapshot(sourceToken.actor.uuid, sourceToken.uuid),
      this.health.getSnapshot(targetToken.actor.uuid, targetToken.uuid),
      this.movements.getSnapshot(sourceToken.uuid, { hints: false })
    ]);
    if (!sourceHealth || !targetHealth || !movement) return null;

    const gridSize = Number(sourceToken.parent?.grid?.size) || 1;
    const movementSpent = resolveStandingMovementSpent(movement);
    // Effect steps priced by range use the weapon's maximum range.
    const effectRange = parseAttackRange(projectWeapon(sourceToken.actor, sourceItem).range)?.maxRange ?? 0;
    const approach = projectPreCombatApproach({
      sourceToken, targetToken, targetItem, movement, movementSpent, gridSize,
      activatedItem: objectTarget || afterPreCombat ? null : sourceArt ?? sourceItem,
      effectRange, attackShape: sourceItem.system?.weapon?.targetShape
    });
    const { distance, engagement, inMeleeRange } = approach;
    const combatContext = recordCombatContext({ intent, sourceToken, targetToken, targetItem }, {
      distance, engagement, inMeleeRange, movementSpent
    });
    // Both sides share one copy of each Item's data. The scope opens inside the combat context, after its Actor
    // resets, so the unit values the resets compute are not kept past it.
    const [sourceBase, targetBase] = withFoundryCombatContext({
      ...combatContext, sourceActor: sourceToken.actor, targetActor: targetToken.actor,
      sourceItem: sourceArt ?? sourceItem, targetItem
    }, () => withSharedProjections(() => [
      withMarkedBonus(
        projectSide(sourceToken, sourceItem, sourceHealth, sourceArt, engagement),
        markedAllyBonus(sourceToken.actor, targetToken.actor)
      ),
      objectTarget
        ? projectObjectSide(targetToken, targetHealth)
        : withMarkedBonus(
          projectSide(targetToken, targetItem, targetHealth, null, engagement),
          markedAllyBonus(targetToken.actor, sourceToken.actor)
        )
    ]));
    const flanking = distance === 1 && !objectTarget
      ? boardFlanking(sourceToken, targetToken, gridSize) : { source: false, target: false };
    const source = withExchangeFlanking(sourceBase, flanking.source);
    const target = withExchangeFlanking(targetBase, flanking.target);
    const counter = objectTarget ? false : defenderCanCounter(target, distance, source, engagement);
    const sequence = buildCombatSequence(source, target, counter);
    const sourceCombat = calculateCombatSide(source, target, {
      distance,
      damageType: intent.damageType || undefined
    });
    const targetCombat = calculateCombatSide(target, source, {
      distance
    });
    const requirements = projectAttackRequirements({
      item: sourceArt ?? sourceItem, source, target: objectTarget ? null : target, sourceToken, targetToken,
      movement, targetMovement: () => projectMovementSnapshot(targetToken, { hints: false }), gridSize, effectRange
    });
    const snapshot = {
      sceneUuid: String(sourceToken.parent?.uuid ?? ''),
      sourceTokenUuid: sourceToken.uuid,
      targetTokenUuid: targetToken.uuid,
      sourceActorUuid: sourceToken.actor.uuid,
      targetActorUuid: targetToken.actor.uuid,
      sourceItemUuid: sourceItem.uuid,
      sourceWeaponArtUuid: sourceArt?.uuid ?? '',
      targetItemUuid: targetItem?.uuid ?? '',
      source,
      target,
      sourceCombat,
      targetCombat,
      sequence,
      defenderCanRespond: counter,
      distance,
      engagement,
      boardDistance: approach.boardDistance,
      boardEngagement: approach.boardEngagement,
      reachDistance: approach.reachDistance,
      reachEngagement: approach.reachEngagement,
      effectRange,
      lineOfSightBlocked: sightBlocked(sourceToken, targetToken, sourceItem) === true,
      sourceInRange: rangeReachesEngagement(
        source.weapon.range, approach.reachDistance, approach.reachEngagement, source.airborne
      ),
      sourceRequirementsMet: requirements.ok,
      sourceRequirementCode: requirements.code,
      sourceRequirementNames: requirements.names,
      targetFactionValid: objectTarget || validTargetFaction(sourceToken.actor, targetToken.actor, sourceItem),
      targetEligibilityValid: objectTarget
        ? objectEligibilityValid(sourceToken, targetToken)
        : targetEligibilityValid(sourceToken, targetToken, sourceItem, source, target),
      targetAlive: objectTarget ? target.stance.value > 0 : target.hp.value > 0,
      sceneGeometryAvailable: sightTestable(sourceToken, sourceItem),
      sourceItemWielded: isArmamentWeapon(sourceItem)
        ? standingOnArmament(sourceToken, sourceItem, gridSize) : sourceItem.system?.isWielded === true,
      sourceItemUsable: itemUsable(sourceItem),
      sourceMagicAvailable: !isMagicBlocked(sourceToken.actor, sourceArt ?? sourceItem),
      sourceWeaponArtValid: artPairing.valid,
      sourceWeaponArtCost: artPairing.cost,
      sourceStandardAvailable: sourceToken.actor.system.turn.actionAvailable !== false,
      sourceOwnsMovementPlan: movement.movementPlanning === true,
      encounterActive: sceneCombatActive(sourceToken.parent),
      explorationActive: sceneExplorationActive(sourceToken.parent),
      movement,
      combatContext
    };
    snapshot.cinematic = intent.cinematic !== false;
    return Object.freeze({ ...snapshot, fingerprint: combatFingerprint(snapshot) });
  }

  /**
   * Roll this attack's damage type when the side's weapon picks one at random, and return the side's combat line
   * (calculateCombatSide) for the attack.
   */
  async rollCombatSide(side, target, { distance, damageType = '' } = {}) {
    const random = side.randomizeDamageType === true && combatDamageTypes(side, target).length > 0;
    const damageTypeRoll = random ? Math.random() : null;
    return Object.freeze({
      damageTypeRoll,
      combat: calculateCombatSide(side, target, {
        distance,
        damageType: damageType || undefined,
        damageTypeRoll: damageTypeRoll ?? undefined
      })
    });
  }

  /**
   * Roll one hit check. Under the karmic model it starts from the saved karma debt plus any earlier rolls in this
   * attack, and returns its own karma entry (`karmaBooking`) to be saved with the rest of the attack.
   * @param {object} side The acting side.
   * @param {object} target The defending side.
   * @param {object} combat The acting side's combat line.
   * @param {{karmaBookings?: ReadonlyArray<object>}} [options] The exchange's bookings so far, in order.
   */
  async rollAttack(side, target, combat, { karmaBookings = [] } = {}) {
    const model = hitChanceModel();
    const faction = factionGroup(side.actorType);
    const advantage = combat.advantage === true;
    const disadvantage = combat.disadvantage === true;
    const declaredCount = advantage !== disadvantage ? 2 : 1;
    let attempts = [];
    let karma = null;

    if (model === HIT_CHANCE_MODELS.KARMIC) {
      const debt = exchangeKarmaDebt(karmaBookings, faction);
      const pull = checkKarmicPull(debt, Math.random());
      const candidates = Array.from({ length: pull.attempts + 1 }, () => randomDeclaredAttempts(declaredCount,
        false, side.blessed));
      attempts = chooseKarmicAttempt(candidates, pull.keep, side, target, combat);
      karma = { faction, debt };
    } else {
      attempts = randomDeclaredAttempts(declaredCount, model === HIT_CHANCE_MODELS.TWO_RANDOM_NUMBERS, side.blessed);
    }

    const result = resolveAttackCheck({
      accuracy: Number(side.accuracy),
      evasion: target.evasion,
      critChance: combat.critChance,
      attempts,
      critRoll: randomD100(),
      advantage,
      disadvantage,
      blessed: side.blessed === true,
      model
    });
    const success = result.result !== 'miss';
    const karmaBooking = karma ? Object.freeze({
      key: karma.faction,
      chance: result.promisedChance,
      success,
      before: karma.debt,
      after: nextKarmaDebt(karma.debt, result.promisedChance, success)
    }) : null;
    const criticalVoice = result.result === 'crit'
      ? await this.unitAudio?.criticalVoiceClip?.(side.actorUuid) ?? null : null;
    return Object.freeze({
      ...result,
      dc: Number(target.evasion) || 0,
      accuracyBonus: Number(side.accuracy),
      karmaBooking,
      criticalVoice
    });
  }

  /** Evaluate an approved numeric damage formula through Foundry's Roll implementation. */
  async rollDamage(formula) {
    const roll = await new Roll(String(formula || '0')).evaluate();
    return Math.max(0, Number(roll.total) || 0);
  }
}

/* -------------------------------------------- */
/*  Effects the exchange fires                  */
/* -------------------------------------------- */

/**
 * The defenses an effect step's damage or healing is checked against. When an effect fired by an attack hits one
 * of the two fighters, read its defenses as they stood in the fight; otherwise use its normal health data.
 * @param {object|null} combatContext The attack's `combatContext` (see recordCombatContext); it stays on the host
 *   client.
 * @param {object} health The unit's health data from FoundryHealthRepository.getSnapshot.
 * @returns {Promise<Readonly<object>>}
 */
export async function projectExchangeHealthTarget(combatContext, health) {
  const { sourceTokenUuid, targetTokenUuid } = combatContext ?? {};
  if (!sourceTokenUuid || ![sourceTokenUuid, targetTokenUuid].includes(health.tokenUuid)) return health.target;
  const [sourceToken, targetToken] = await Promise.all([resolveToken(sourceTokenUuid), resolveToken(targetTokenUuid)]);
  if (!sourceToken?.actor || !targetToken?.actor) return health.target;
  const sourceArt = combatContext.weaponArtUuid ? await resolveItem(combatContext.weaponArtUuid) : null;
  const sourceItem = sourceArt ?? await resolveWeapon(combatContext.itemUuid, sourceToken.actor);
  const targetItem = combatContext.targetItemUuid ? await resolveItem(combatContext.targetItemUuid) : null;
  const actor = health.tokenUuid === sourceTokenUuid ? sourceToken.actor : targetToken.actor;
  return withFoundryCombatContext({
    ...combatContext, sourceActor: sourceToken.actor, targetActor: targetToken.actor, sourceItem, targetItem
  }, () => combatHealthTarget(actor, health));
}

/**
 * Save what the attack read both fighters under: the uuids of the two tokens, the weapon, Weapon Art and the
 * target's weapon, plus the distance, engagement, melee reach and movement spent that withFoundryCombatContext
 * applies. The attack data carries it as `combatContext` so projectExchangeHealthTarget can read the fighters the
 * same way later.
 */
function recordCombatContext({ intent, sourceToken, targetToken, targetItem }, facts) {
  return Object.freeze({
    sourceTokenUuid: sourceToken.uuid,
    targetTokenUuid: targetToken.uuid,
    itemUuid: String(intent.itemUuid ?? ''),
    weaponArtUuid: String(intent.weaponArtUuid ?? ''),
    targetItemUuid: String(targetItem?.uuid ?? ''),
    ...facts
  });
}

/* -------------------------------------------- */
/*  Attack sides                                */
/* -------------------------------------------- */

/** The attack, critical and Weapon Art animations for this engagement, picked from the Items' animations by range. */
function projectFoundryCombatAnimations(weapon, activeItem, engagement) {
  const itemSystem = weapon?.system ?? {};
  return Object.freeze({
    attackAnimation: clone(selectAnimationRange(itemSystem.anim?.attack, engagement)),
    criticalAnimation: clone(selectAnimationRange(itemSystem.anim?.critical, engagement)),
    activationAnimation: activeItem?.system?.itemType === 'Weapon Art'
      ? clone(selectAnimationRange(activeItem.system?.anim?.activation, engagement)) : null
  });
}

/**
 * The defenses an attack is checked against. Call it inside withFoundryCombatContext so combat-only modifiers to
 * maximums, protections, immunities and armor apply; current hit points, stance and shield come from the health
 * data read before the fight.
 */
function combatHealthTarget(actor, health) {
  return Object.freeze({
    ...projectHealthTarget(actor),
    hp: health.target.hp,
    stance: health.target.stance,
    shield: health.target.shield
  });
}

/**
 * One Character's side of the attack: its rule values (the same ones attack targeting uses), its defenses, and
 * everything needed to apply the result. The Combat Preview shows this side too, so it also carries the
 * proficiency totals the preview's weapon switcher reads.
 */
function projectSide(token, weapon, health, activeItem = null, engagement = '') {
  const actor = token.actor;
  const system = actor.system;
  const statuses = projectActorStatusKeys(actor);
  const target = combatHealthTarget(actor, health);
  return Object.freeze({
    ...projectCombatRuleFacts(actor, weapon, activeItem),
    actorUuid: actor.uuid,
    tokenUuid: token.uuid,
    actorName: String(actor.name ?? token.name ?? 'Character'),
    actorImage: String(actor.img ?? token.texture?.src ?? 'icons/svg/mystery-man.svg'),
    avatarScale: resolveAvatarScale(system.art.avatarScale),
    factionColor: String(system.faction?.color ?? '#9f7dc5'),
    hasVoicePath: Boolean(String(system.art.voicePath ?? '').trim()),
    hp: Object.freeze({ value: target.hp, max: target.hpMax }),
    stance: Object.freeze({ value: target.stance, max: target.stanceMax }),
    shield: target.shield,
    criticalMultiplier: finite(system.stats.critDmg.total) || CRITICAL_MULTIPLIER_BASE,
    level: Math.max(1, Math.floor(finite(system.progression.level) || 1)),
    experience: Math.max(0, Math.floor(finite(system.progression.experience))),
    attackIndex: Math.max(0, Math.floor(finite(system.turn.attackIndex))),
    adaptive: passiveFlag(actor, 'adaptive') || statuses.has('adaptive'),
    hasCanter: passiveFlag(actor, 'canter'),
    hasMultiAttack: passiveFlag(actor, 'multiAttack'),
    bonusAvailable: system.turn.bonusActionAvailable !== false,
    extraActionsRemaining: Math.max(0, finite(system.special.extraActions.value)),
    extraActionUsed: system.turn.extraActionUsed === true,
    groundOnArmamentUse: Boolean(actor.getFlag(SYSTEM_ID, 'armamentUuid')) && isAirborneActor(actor),
    tauntedByActorUuid: tauntedByActorUuid(actor),
    destructible: false,
    protections: Object.freeze([...target.protections]),
    vulnerabilities: Object.freeze([...target.vulnerabilities]),
    immunities: Object.freeze([...target.immunities]),
    damageTypes: Object.freeze(validDamageTypes(system, weapon?.system ?? {})),
    healthTarget: target,
    healthSnapshot: health,
    extraLives: health.extraLives,
    effects: Object.freeze(projectActiveEffectEntries(weapon, activeItem)),
    passiveEffects: Object.freeze(projectPassiveEffectEntries(actor)),
    healEchoes: Object.freeze(projectHealEchoPolicies(actor)),
    effectLifecycle: projectEffectLifecycle(actor),
    ...projectFoundryCombatAnimations(weapon, activeItem, engagement),
    weaponArt: projectWeaponArtDisplay(activeItem),
    usedItem: projectFoundryTokenArtItem(activeItem ?? weapon),
    proficiency: projectProficiency(actor, weapon),
    proficiencies: projectProficiencyTotals(system)
  });
}

/**
 * The Destructible's side: its rule values, integrity and protections. Fields only a Character uses are zeroed or
 * empty.
 */
function projectObjectSide(token, health) {
  const actor = token.actor;
  const system = actor.system;
  const target = combatHealthTarget(actor, health);
  return Object.freeze({
    ...projectDestructibleRuleFacts(actor),
    actorUuid: actor.uuid,
    tokenUuid: token.uuid,
    actorName: String(actor.name ?? token.name ?? 'Object'),
    actorImage: String(token.texture?.src ?? actor.img ?? 'icons/svg/mystery-man.svg'),
    avatarScale: 1.25,
    factionColor: String(system.faction.color ?? '#9f7dc5'),
    hasVoicePath: false,
    hp: Object.freeze({ value: target.hp, max: target.hpMax }),
    stance: Object.freeze({ value: target.stance, max: target.stanceMax }),
    shield: 0,
    criticalMultiplier: CRITICAL_MULTIPLIER_BASE,
    level: 1,
    experience: 0,
    attackIndex: 0,
    adaptive: false,
    hasCanter: false,
    hasMultiAttack: false,
    bonusAvailable: false,
    extraActionsRemaining: 0,
    extraActionUsed: false,
    groundOnArmamentUse: false,
    tauntedByActorUuid: '',
    protections: Object.freeze([...target.protections]),
    vulnerabilities: Object.freeze([...target.vulnerabilities]),
    immunities: Object.freeze([...target.immunities]),
    healthTarget: target,
    healthSnapshot: health,
    extraLives: 0,
    effects: Object.freeze([]),
    passiveEffects: Object.freeze([]),
    healEchoes: Object.freeze([]),
    effectLifecycle: Object.freeze({
      sanctuaryEffectId: null,
      hostileActionEffectIds: Object.freeze([]),
      hostileTargetedEffectIds: Object.freeze([]),
      removeWhenAttacked: Object.freeze([]),
      combatEndEffectIds: Object.freeze([])
    }),
    attackAnimation: null,
    criticalAnimation: null,
    activationAnimation: null,
    weaponArt: null,
    usedItem: null,
    proficiency: Object.freeze({ key: '' }),
    markedAttackBonus: 0,
    markedSpeedBonus: 0,
    markedCritBonus: 0,
    markedAdvantage: false,
    markedEffect: null
  });
}

function objectEligibilityValid(sourceToken, targetToken) {
  if (targetToken.hidden === true) return false;
  return sourceToken.actor.system.turn.actionAvailable !== false;
}

function projectEffectLifecycle(actor) {
  const result = {
    sanctuaryEffectId: null,
    hostileActionEffectIds: [],
    hostileTargetedEffectIds: [],
    removeWhenAttacked: [],
    combatEndEffectIds: []
  };
  for (const effect of collectionValues(actor.effects)) {
    if (effect.disabled === true || !effect.id) continue;
    const flags = effect.flags?.[SYSTEM_ID] ?? {};
    if (normalizeStatusKey(effect.name ?? effect.label) === 'sanctuary') result.sanctuaryEffectId = effect.id;
    if (flags.removeOnHostileAction === true) result.hostileActionEffectIds.push(effect.id);
    if (flags.removeOnHostileTargeted === true) result.hostileTargetedEffectIds.push(effect.id);
    if (flags.removeWhenAttacked === true) {
      result.removeWhenAttacked.push(Object.freeze({ id: effect.id, applyCount: finite(flags.applyCount) || 1 }));
    }
    if (flags.removeOnCombatSequenceEnd === true) result.combatEndEffectIds.push(effect.id);
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).map(([key, value]) => [
    key,
    Array.isArray(value) ? Object.freeze(value) : value
  ])));
}

/**
 * Whether the requested Weapon Art can be used with this weapon, and its cost. The art spends `cost` uses of the
 * weapon's durability and the weapon must keep at least one use afterwards. A cost that is not a whole number from
 * 0 to 100 makes the art invalid.
 */
function projectWeaponArt(actor, weapon, art, requested) {
  if (!requested) return Object.freeze({ valid: true, cost: 0 });
  if (!art || itemActor(art)?.uuid !== actor.uuid || art.type !== 'Ability'
    || art.system?.itemType !== 'Weapon Art') return Object.freeze({ valid: false, cost: 0 });
  const cost = Number(art.system?.wepArtData?.cost);
  if (!Number.isInteger(cost) || cost < 0 || cost > 100) return Object.freeze({ valid: false, cost: 0 });
  const family = String(weapon.system?.weapon?.req ?? '').toLowerCase();
  if (!family || art.system?.wepArtData?.[family] !== true) return Object.freeze({ valid: false, cost });
  if (!itemUsable(art)) return Object.freeze({ valid: false, cost });
  const uses = weapon.system?.uses ?? {};
  if (uses.type !== 'infinite' && finite(uses.current) <= cost) return Object.freeze({ valid: false, cost });
  return Object.freeze({ valid: true, cost });
}

function projectWeaponArtDisplay(item) {
  if (item?.system?.itemType !== 'Weapon Art') return null;
  return Object.freeze({
    uuid: String(item.uuid ?? ''),
    name: String(item.name ?? ''),
    image: String(item.img ?? ''),
    uses: Object.freeze({
      current: finite(item.system?.uses?.current),
      maximum: finite(item.system?.uses?.max),
      infinite: item.system?.uses?.type === 'infinite'
    })
  });
}

function validDamageTypes(system, itemSystem) {
  return DAMAGE_TYPES.filter(type => system.equipment.damageTypes[type] === true
    && itemSystem.weapon?.dmgTypes?.[type] !== false);
}

/** The weapon's and the active Item's effect entries. Each Item's entries share one frozen copy of the Item. */
function projectActiveEffectEntries(weapon, activeItem) {
  const entries = [];
  const items = activeItem && activeItem !== weapon ? [weapon, activeItem] : [weapon];
  for (const item of items) {
    if (!item) continue;
    let sourceItem = null;
    for (const entry of item.system?.effects ?? []) {
      sourceItem ??= projectEffectItem(item);
      entries.push(Object.freeze({
        ...clone(entry),
        sourceItemUuid: item.uuid,
        sourceItemName: item.name,
        sourceItem
      }));
    }
  }
  return entries;
}

/** Every Passive's effect entries. A Passive's entries share one frozen copy of it. */
function projectPassiveEffectEntries(actor) {
  const entries = [];
  for (const item of collectionValues(actor.items)) {
    if (triggerGroupForItem({ type: item.type, itemType: item.system?.itemType }) !== 'C') continue;
    let sourceItem = null;
    for (const entry of item.system?.effects ?? []) {
      sourceItem ??= projectEffectItem(item);
      entries.push(Object.freeze({
        ...clone(entry),
        sourceItemUuid: item.uuid,
        sourceItemName: item.name,
        sourceItem
      }));
    }
  }
  return entries;
}

/**
 * An Item as its effect entries carry it, with a copy of its saved system data, frozen all the way down because
 * every entry of the Item shares it. Nothing that reads an entry writes into its Item.
 */
function projectEffectItem(item) {
  return deepFreeze({
    uuid: String(item?.uuid ?? ''),
    name: String(item?.name ?? ''),
    type: String(item?.type ?? ''),
    img: String(item?.img ?? ''),
    image: String(item?.img ?? ''),
    system: clone(item?.system ?? {})
  });
}

/** Freeze a plain-data value and everything inside it. */
function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/* -------------------------------------------- */
/*  Live validation                             */
/* -------------------------------------------- */

/**
 * A hash of the fields the attack depends on. The host refuses the attack when it differs from the one the
 * player's preview showed, so the preview and the host must compute every field here the same way, and nothing
 * only one client knows may go in.
 */
function combatFingerprint(snapshot) {
  return digest(JSON.stringify({
    sceneUuid: snapshot.sceneUuid,
    sourceTokenUuid: snapshot.sourceTokenUuid,
    targetTokenUuid: snapshot.targetTokenUuid,
    source: fingerprintSide(snapshot.source),
    target: fingerprintSide(snapshot.target),
    distance: snapshot.distance,
    engagement: snapshot.engagement,
    boardDistance: snapshot.boardDistance,
    boardEngagement: snapshot.boardEngagement,
    sequence: snapshot.sequence,
    lineOfSightBlocked: snapshot.lineOfSightBlocked,
    sourceInRange: snapshot.sourceInRange,
    sourceRequirementsMet: snapshot.sourceRequirementsMet,
    targetFactionValid: snapshot.targetFactionValid,
    targetEligibilityValid: snapshot.targetEligibilityValid,
    targetAlive: snapshot.targetAlive,
    cinematic: snapshot.cinematic,
    encounterActive: snapshot.encounterActive,
    explorationActive: snapshot.explorationActive,
    sourceItemWielded: snapshot.sourceItemWielded,
    sourceItemUsable: snapshot.sourceItemUsable,
    sourceMagicAvailable: snapshot.sourceMagicAvailable,
    sourceWeaponArtUuid: snapshot.sourceWeaponArtUuid,
    sourceWeaponArtValid: snapshot.sourceWeaponArtValid,
    sourceWeaponArtCost: snapshot.sourceWeaponArtCost,
    sourceStandardAvailable: snapshot.sourceStandardAvailable,
    movement: {
      planning: snapshot.movement.movementPlanning,
      controller: snapshot.movement.movementControllerId,
      source: snapshot.movement.sourcePosition,
      anchor: snapshot.movement.anchorPosition
    }
  }));
}

function fingerprintSide(side) {
  return {
    hp: side.hp,
    stance: side.stance,
    shield: side.shield,
    weapon: side.weapon,
    attack: side.attack,
    accuracy: side.accuracy,
    evasion: side.evasion,
    crit: side.crit,
    speed: side.speed,
    defense: side.defense,
    resistance: side.resistance,
    charisma: side.charisma,
    breakDamage: side.breakDamage,
    criticalMultiplier: side.criticalMultiplier,
    dexterity: side.dexterity,
    attackIndex: side.attackIndex,
    adaptive: side.adaptive,
    hasCanter: side.hasCanter,
    hasMultiAttack: side.hasMultiAttack,
    bonusAvailable: side.bonusAvailable,
    extraActionsRemaining: side.extraActionsRemaining,
    extraActionUsed: side.extraActionUsed,
    extraAttacks: side.extraAttacks,
    noExtraAttacks: side.noExtraAttacks,
    firstStrike: side.firstStrike,
    cannotCounter: side.cannotCounter,
    counterlock: side.counterlock,
    impervious: side.impervious,
    blessed: side.blessed,
    blinded: side.blinded,
    flanked: side.flanked,
    truestrike: side.truestrike,
    shine: side.shine,
    silenced: side.silenced,
    airborne: side.airborne,
    tauntedByActorUuid: side.tauntedByActorUuid,
    unitTypes: side.unitTypes,
    protections: side.protections,
    vulnerabilities: side.vulnerabilities,
    immunities: side.immunities,
    effectiveAgainst: side.effectiveAgainst,
    weaponAdvantages: side.weaponAdvantages,
    damageTypes: side.damageTypes,
    armor: side.armor,
    extraLives: side.extraLives,
    effects: side.effects,
    passiveEffects: side.passiveEffects,
    healEchoes: side.healEchoes,
    effectLifecycle: side.effectLifecycle,
    proficiency: side.proficiency,
    weaponArt: side.weaponArt
  };
}

/** Whether walls hide the target, or null when this client can't test the walls of the units' Scene. */
function sightBlocked(source, target, item) {
  if (exchangeLosRule(source, item) === 'ignoreLoS') return false;
  return testSceneWallCollision(source.parent,
    persistedTokenCenter(source, tokenGridSize(source, 1)), persistedTokenCenter(target, tokenGridSize(target, 1)));
}

/** The rule this exchange tests sight under: the attacker's free-targeting override outranks the weapon's. */
function exchangeLosRule(source, item) {
  return resolveActionLosRule(
    item.system?.effectData?.losRule, unitIgnoresLineOfSight(source.actor?.flags?.[SYSTEM_ID])
  );
}

/**
 * Whether the client reading the attack can test the exchange's sight: always under ignoreLoS, otherwise only
 * when the units' Scene has no walls or is the one this client displays. That client is the host for the exchange
 * and the acting player's for the preview. While an encounter runs, the scene lock keeps clients on its Scene.
 */
function sightTestable(source, item) {
  return exchangeLosRule(source, item) === 'ignoreLoS' || sceneWallsTestable(source.parent);
}

function itemUsable(item) {
  return item.system?.uses?.type === 'infinite' || finite(item.system?.uses?.current) > 0;
}

/** Whether Silence stops the unit using the Item it attacks with: a Silenced unit cannot use a magic Item. */
function isMagicBlocked(actor, item) {
  const silenced = actor?.system?.statuses?.silenced === true || projectActorStatusKeys(actor).has('silenced');
  return silenced && isMagicItemDocument(item);
}

/** Whether an attack may pick this target: a Hostile one, per targetTypeAdmits in game/character/rules.mjs. */
function validTargetFaction(source, target, item) {
  if (!isAttackItem(item)) return false;
  return targetTypeAdmits('Hostile', source.system?.faction?.role, target.system?.faction?.role);
}

function targetEligibilityValid(sourceToken, targetToken, item, source, target) {
  if (targetToken.hidden === true) return false;
  if (sourceToken.actor.system.turn.actionAvailable === false) return false;
  if (source.tauntedByActorUuid && source.tauntedByActorUuid !== target.actorUuid) return false;
  if (target.effectLifecycle?.sanctuaryEffectId) return false;
  // A melee-only weapon (range 1) can't reach a flying target from the ground.
  if (String(item.system?.weapon?.rng ?? '').trim() === '1'
    && airborneBeyondMelee(projectFlightReach(sourceToken, targetToken))) return false;
  return true;
}

/* -------------------------------------------- */
/*  Dice and lookups                            */
/* -------------------------------------------- */

function hitChanceModel() {
  const model = String(game.settings.get(SYSTEM_ID, HIT_CHANCE_MODEL_SETTING) ?? HIT_CHANCE_MODELS.KARMIC);
  return Object.values(HIT_CHANCE_MODELS).includes(model) ? model : HIT_CHANCE_MODELS.KARMIC;
}

/** The karma debt for one faction's next attack roll: the saved karma ledger plus earlier rolls in this attack. */
function exchangeKarmaDebt(bookings, faction) {
  const ledger = readKarmaLedger();
  const replayed = replayKarmaBookings(ledger, bookings);
  return Object.hasOwn(replayed, String(faction ?? '')) ? replayed[faction] : Number(ledger[faction]) || 0;
}

function randomD100() {
  return Math.floor(Math.random() * 100) + 1;
}

function randomDeclaredAttempts(count, twoRn, blessed) {
  return Array.from({ length: count }, () => Object.freeze({
    natural: twoRn ? twoRandomNumberNatural(randomDie(20), randomDie(20), Math.random()) : randomDie(20),
    blessed: blessed ? randomDie(4) : 0
  }));
}

/**
 * Karma debt rolls extra attempts and keeps the best one (`keep: 'high'`) or the worst (`keep: 'low'`), so a side
 * that has been unlucky gets luckier and a side that has been lucky gets less so.
 */
function chooseKarmicAttempt(candidates, keep, side, target, combat) {
  let chosen = candidates[0];
  let chosenTotal = attackAttemptTotal(chosen, side, target, combat);
  for (const candidate of candidates.slice(1)) {
    const total = attackAttemptTotal(candidate, side, target, combat);
    if ((keep === 'high' && total > chosenTotal) || (keep === 'low' && total < chosenTotal)) {
      chosen = candidate;
      chosenTotal = total;
    }
  }
  return chosen;
}

function attackAttemptTotal(attempts, side, target, combat) {
  return resolveAttackCheck({
    accuracy: Number(side.accuracy),
    evasion: target.evasion,
    critChance: 0,
    attempts,
    critRoll: 100,
    advantage: combat.advantage,
    disadvantage: combat.disadvantage,
    blessed: side.blessed === true
  }).total;
}

function randomDie(faces) {
  return Math.floor(Math.random() * faces) + 1;
}

function wieldedAttackItem(actor) {
  return collectionValues(actor.items).find(item => item.system?.isWielded === true && isAttackItem(item)) ?? null;
}

function itemActor(item) {
  return item.actor ?? (item.parent?.documentName === 'Actor' ? item.parent : null);
}

/**
 * The Item a uuid names, or the borrowed Armament's weapon shape when the uuid is the Armament token the unit's flag
 * names. Whether the unit still stands on the Armament is checked separately (standingOnArmament).
 */
async function resolveWeapon(uuid, actor) {
  const item = await resolveItem(uuid);
  if (item) return item;
  const armament = projectWieldedArmament(actor);
  return armament && armament.token.uuid === String(uuid ?? '') ? armament.weapon : null;
}

/** Whether the unit still overlaps the Armament token. Once it walks off, it can't attack with it, flag or not. */
function standingOnArmament(sourceToken, weapon, gridSize) {
  const armamentToken = sourceToken.parent?.tokens?.get?.(String(weapon.uuid).split('.Token.')[1]?.split('.')[0]);
  if (!armamentToken) return false;
  const mine = new Set(tokenCells(sourceToken, gridSize).map(cell => `${cell.x},${cell.y}`));
  return tokenCells(armamentToken, gridSize).some(cell => mine.has(`${cell.x},${cell.y}`));
}
