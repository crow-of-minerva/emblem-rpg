/** @layer engine/downtime */
import {
  COMBAT_EXCHANGE_TIMING, COMBAT_PRESENTATION_BEATS, combatPresentationMessage
} from '../../contracts/domains/combat.mjs';
import {
  COOKING_TIMING,
  CRAFTING_TIMING,
  DOWNTIME_CHECK_TIMING,
  DOWNTIME_PRESENTATION_EVENTS,
  DOWNTIME_XP_FRACTION_ACTION,
  DOWNTIME_XP_FRACTION_PER_ENERGY,
  GATHERING_TIMING,
  MEAL_OUTCOMES,
  PERFORMANCE_GRADES,
  PERFORMANCE_GRADE_LABELS,
  PERFORMANCE_TIMING,
  REQUISITION_OUTCOMES,
  REQUISITION_TIMING,
  SOCIAL_SKILL_KEY,
  SOCIAL_TIMING,
  TRAINING_SPAR,
  TRAINING_SUPPORT_XP,
  TRAIN_SKILL_KEY,
  downtimePresentationMessage
} from '../../contracts/domains/downtime.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import { DIAGNOSTIC_SOURCES } from '../../contracts/protocol.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { SKILL_BY_KEY } from '../../game/character/rules.mjs';
import { buildMealPassive, cookOutcome, mealPassiveName, supportXpFor } from '../../game/downtime/cooking.mjs';
import {
  brewedProductData, craftYield, forgeOutcome, forgeableKind, freedPockets, planBrewDelivery
} from '../../game/downtime/crafting.mjs';
import { distributeGather, gatherAmount, planGatherDeposit } from '../../game/downtime/gathering.mjs';
import {
  allocateSongBonuses, buildPerformancePassive, buildUninspiredPassive, describeBonuses, gradePerformance,
  listenerSupportXpFor, performerSupportXpFor
} from '../../game/downtime/performance.mjs';
import { describeRequisition, requisitionOutcome } from '../../game/downtime/requisition.mjs';
import { actionLaneSpend, energyLaneSpend } from '../../game/downtime/rules.mjs';
import { socialSupportExperience, trainingProficiencyExperience } from '../../game/downtime/social.mjs';
import { planProficiencyExperienceGrant } from '../../game/progression/rules.mjs';
import { buildSkillCheck } from '../../game/rolls/checks.mjs';
import { grantSkillExperience } from '../character/skill-experience.mjs';
import { cardRequester, presentSafely, recordAbsorbed, runSafely, runSafelyAsync } from '../feedback.mjs';

/** The most rows one list on the performance card may carry, the limit isDowntimePresentationMessage enforces. */
const PERFORMANCE_CARD_ROWS = 24;

/* -------------------------------------------- */
/*  Shared helpers                              */
/* -------------------------------------------- */
/** The check a performer rolls for an activity's skill, with no difficulty unless the activity sets one. */
export function skillCheckFor(performer, skillKey, dc = null) {
  const skill = SKILL_BY_KEY[skillKey];
  return buildSkillCheck({
    skillKey,
    mode: 'standard',
    dc,
    rank: performer.skills?.[skillKey],
    statValue: performer.attributes?.[skill?.stat],
    actorType: performer.actorType,
    blessed: performer.blessed
  });
}

/**
 * Roll the check, show its card, then pause for DOWNTIME_CHECK_TIMING.diceSettleHold so players can read the dice
 * before the activity writes anything.
 */
async function rollCheck(context, services, performer, check, { effectName, targetName, detail }) {
  const roll = await services.checks.roll(performer.actorUuid, check,
    { requestId: context.requestId, operation: context.operation });
  try {
    await services.checkPresentation.presentSkill({
      requester: context.requester ?? { userId: context.userId, messageMode: context.messageMode },
      actorUuid: performer.actorUuid,
      actorName: performer.name,
      actorImage: performer.image,
      avatarScale: performer.avatarScale,
      dc: check.dc,
      natural: roll.natural,
      total: roll.total,
      success: roll.success,
      effectName,
      targetName,
      check,
      roll
    });
  } catch (error) {
    recordAbsorbed(services, error, detail, DIAGNOSTIC_SOURCES.DOWNTIME);
  }
  await services.wait(DOWNTIME_CHECK_TIMING.diceSettleHold);
  return roll;
}

function performerFacts(snapshot, performer) {
  return {
    actorUuid: performer.actorUuid,
    actorName: performer.name,
    actorImage: performer.image,
    avatarScale: performer.avatarScale,
    stationName: snapshot.station.name,
    stationImage: snapshot.station.image
  };
}

function settlementRefusal(settled) {
  return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED, { reasonCode: settled.code });
}

/* -------------------------------------------- */
/*  Gathering                                   */
/* -------------------------------------------- */
/**
 * Resolve gathering for the `gather` command in downtime/commands.mjs: open the banner, roll, draw the yield,
 * spend the Energy and deposit the items through FoundryDowntimeRepository.settleGathering, then post the card.
 */
export async function workNode(context, services, snapshot, performer, plan) {
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.GATHER_BEGIN, {
    stationTokenUuid: snapshot.station.tokenUuid, iconImage: plan.iconImage, method: plan.method
  }));
  await services.wait(GATHERING_TIMING.bannerHold);
  const check = skillCheckFor(performer, plan.skillKey);
  const roll = await rollCheck(context, services, performer, check, {
    effectName: 'Gathering', targetName: snapshot.station.name, detail: 'gather-card'
  });
  const distribution = distributeGather(
    plan.stock.map(entry => ({ key: entry.index, weight: entry.weight, available: entry.total })),
    gatherAmount(roll.total, plan.multiplier),
    services.random
  );
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.GATHER_END, { success: true }));

  const facts = await services.downtime.getDepositFacts(snapshot, performer, plan.destination);
  if (!facts) return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED, { reasonCode: 'downtime.destination-missing' });
  const deposit = planGatherDeposit({
    distribution, items: snapshot.station.gathering.items, sources: facts.sources, destination: facts.destination
  });
  const spend = energyLaneSpend({
    energy: performer.energy.value, cost: plan.cost, label: `Gathering: ${snapshot.station.name}`
  });
  const settled = await services.downtime.settleGathering(
    snapshot, { performer, spend, deposit, destinationUuid: facts.destination.uuid }, context
  );
  if (settled.ok !== true) return settlementRefusal(settled);
  await grantSkillExperience(
    services, performer.actorUuid, plan.skillKey, DOWNTIME_XP_FRACTION_PER_ENERGY * Math.max(1, plan.cost), context
  );
  const outcome = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    stationTokenUuid: snapshot.station.tokenUuid,
    stationName: snapshot.station.name,
    performerUuid: performer.actorUuid,
    performerName: performer.name,
    skillKey: plan.skillKey,
    total: roll.total,
    gathered: deposit.deposits,
    destinationUuid: settled.destinationUuid,
    destinationName: settled.destinationName,
    exhausted: deposit.exhausted,
    energyLeft: spend.energy,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.GATHER_SETTLED, {
    ...performerFacts(snapshot, performer),
    requester: cardRequester(context),
    destinationName: settled.destinationName,
    items: deposit.deposits.map(row => ({
      name: row.name, image: row.image, count: row.count, leftBehind: row.leftBehind
    }))
  }));
  runSafely(services, () => services.events.publish(EVENT_IDS.GATHERING_SETTLED, outcome), 'gathering-settled');
  return accept(RESULT_CODES.DOWNTIME_GATHERED, outcome);
}

/* -------------------------------------------- */
/*  Forging                                     */
/* -------------------------------------------- */
/**
 * Resolve forging for downtime/commands.mjs: roll the skill check, then write the uses restored, forging XP,
 * materials spent and Energy through FoundryDowntimeRepository.settleForging. A Staff is repaired, not forged.
 */
export async function workForge(context, services, snapshot, performer, plan) {
  const item = plan.item;
  const deed = forgeableKind(item.itemType) === 'staff' ? 'Repairing' : 'Forging';
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.FORGE_BEGIN, {
    stationTokenUuid: snapshot.station.tokenUuid, iconImage: item.image
  }));
  await services.wait(CRAFTING_TIMING.bannerHold);
  const check = skillCheckFor(performer, plan.skillKey);
  const roll = await rollCheck(context, services, performer, check, {
    effectName: deed, targetName: item.name, detail: 'forge-card'
  });
  const forged = forgeOutcome({ source: item.source, roll: roll.total });
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.FORGE_END, { success: true }));

  const spend = energyLaneSpend({ energy: performer.energy.value, cost: plan.cost, label: `${deed}: ${item.name}` });
  const settled = await services.downtime.settleForging(snapshot, { performer, spend, draws: plan.draws, item, forged }, context);
  if (settled.ok !== true) return settlementRefusal(settled);
  await grantSkillExperience(services, performer.actorUuid, plan.skillKey, DOWNTIME_XP_FRACTION_PER_ENERGY * plan.cost, context);
  const outcome = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    stationTokenUuid: snapshot.station.tokenUuid,
    stationName: snapshot.station.name,
    performerUuid: performer.actorUuid,
    performerName: performer.name,
    itemUuid: item.itemUuid,
    itemName: settled.itemName,
    itemKind: forgeableKind(item.itemType),
    skillKey: plan.skillKey,
    total: roll.total,
    restored: forged.restored,
    usesBefore: forged.usesBefore,
    usesAfter: settled.usesCurrent,
    usesMax: settled.usesMax,
    tierBefore: forged.tierBefore,
    tierAfter: forged.tierAfter,
    forgingXP: forged.forgingXP,
    energyLeft: spend.energy,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.FORGE_SETTLED, {
    ...performerFacts(snapshot, performer),
    requester: cardRequester(context),
    itemName: item.name,
    newName: settled.itemName,
    itemImage: item.image,
    itemKind: outcome.itemKind,
    usesBefore: forged.usesBefore,
    usesAfter: settled.usesCurrent,
    usesMax: settled.usesMax,
    restored: forged.restored,
    tierBefore: forged.tierBefore,
    tierAfter: forged.tierAfter,
    forgingBefore: forged.forgingBefore,
    forgingXP: forged.forgingXP,
    materials: plan.materials.map(entry => ({ name: entry.name, quantity: entry.quantity }))
  }));
  runSafely(services, () => services.events.publish(EVENT_IDS.FORGING_SETTLED, outcome), 'forging-settled');
  return accept(RESULT_CODES.DOWNTIME_FORGED, outcome);
}

/* -------------------------------------------- */
/*  Brewing                                     */
/* -------------------------------------------- */
/**
 * Resolve brewing for downtime/commands.mjs. Materials and Energy are spent even on a failure, and craftYield
 * turns the check's margin into how many copies are made. The copies land in the pockets the drawn materials leave
 * free, stacks drawn to nothing included.
 */
export async function workBrew(context, services, snapshot, performer, plan) {
  const recipe = plan.recipe;
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.BREW_BEGIN, {
    stationTokenUuid: snapshot.station.tokenUuid, iconImage: recipe.image
  }));
  await services.wait(CRAFTING_TIMING.bannerHold);
  const check = skillCheckFor(performer, plan.skillKey, plan.dc);
  const roll = await rollCheck(context, services, performer, check, {
    effectName: 'Brewing', targetName: recipe.name, detail: 'brew-card'
  });
  const count = craftYield(roll.total, plan.dc);
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.BREW_END, { success: count > 0 }));

  const product = count > 0 ? await services.downtime.readProduct(recipe.uuid) : null;
  if (count > 0 && !product) return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED, { reasonCode: 'downtime.recipe-missing' });
  const delivery = planBrewDelivery({
    count,
    pocketCount: performer.pocketCount - freedPockets(plan.draws, performer.actorUuid),
    pocketLimit: performer.pocketLimit,
    performerUuid: performer.actorUuid, convoyUuid: plan.convoyUuid
  });
  const spend = energyLaneSpend({ energy: performer.energy.value, cost: plan.cost, label: `Brewing: ${recipe.name}` });
  const settled = await services.downtime.settleBrewing(snapshot, {
    performer, spend, draws: plan.draws, deliveries: delivery.deliveries, product: product ? brewedProductData(product) : null
  }, context);
  if (settled.ok !== true) return settlementRefusal(settled);
  await grantSkillExperience(services, performer.actorUuid, plan.skillKey, DOWNTIME_XP_FRACTION_PER_ENERGY * plan.cost, context);
  const outcome = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    stationTokenUuid: snapshot.station.tokenUuid,
    stationName: snapshot.station.name,
    performerUuid: performer.actorUuid,
    performerName: performer.name,
    recipeUuid: recipe.uuid,
    recipeName: recipe.name,
    skillKey: plan.skillKey,
    total: roll.total,
    dc: plan.dc,
    success: count > 0,
    count,
    lost: delivery.lost,
    destinations: settled.destinations,
    energyLeft: spend.energy,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.BREW_SETTLED, {
    ...performerFacts(snapshot, performer),
    requester: cardRequester(context),
    recipeName: recipe.name,
    recipeImage: recipe.image,
    success: count > 0,
    count,
    lost: delivery.lost,
    destinations: settled.destinations,
    materials: plan.materials.map(entry => ({ name: entry.name, quantity: entry.quantity }))
  }));
  runSafely(services, () => services.events.publish(EVENT_IDS.BREWING_SETTLED, outcome), 'brewing-settled');
  return accept(RESULT_CODES.DOWNTIME_BREWED, outcome);
}

/* -------------------------------------------- */
/*  Cooking                                     */
/* -------------------------------------------- */
/**
 * Resolve cooking for downtime/commands.mjs: roll the Nature check, give every diner the meal's passive through
 * FoundryDowntimeRepository.settleCooking, then award the chef's support XP with each diner.
 */
export async function workPot(context, services, snapshot, performer, plan) {
  const recipe = plan.recipe;
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.COOK_BEGIN, {
    stationTokenUuid: snapshot.station.tokenUuid, iconImage: recipe.img || snapshot.station.image
  }));
  await services.wait(COOKING_TIMING.bannerHold);
  const check = skillCheckFor(performer, plan.skillKey, plan.dc);
  const roll = await rollCheck(context, services, performer, check, {
    effectName: 'Cooking', targetName: recipe.name || 'a meal', detail: 'cook-card'
  });
  const outcome = cookOutcome(roll.total, plan.dc, Boolean(plan.special));
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.COOK_END, {
    success: outcome !== MEAL_OUTCOMES.FAIL
  }));

  const meals = plan.diners.map(diner => ({
    actorUuid: diner.actorUuid, name: diner.name, image: diner.image, avatarScale: diner.avatarScale,
    built: buildMealPassive(recipe, outcome, plan.special?.foodType ?? null)
  }));
  const commitment = actionLaneSpend(`Cooking: ${recipe.name || 'a meal'}`);
  const settled = await services.downtime.settleCooking(snapshot, {
    performer, commitment, draws: plan.draws, meals: meals.map(meal => ({ actorUuid: meal.actorUuid, data: meal.built.data }))
  }, context);
  if (settled.ok !== true) return settlementRefusal(settled);
  const support = await grantSupportExperience(services, performer, plan.diners, supportXpFor(outcome), context);
  await grantSkillExperience(services, performer.actorUuid, plan.skillKey, DOWNTIME_XP_FRACTION_ACTION, context);
  const outcomeData = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    stationTokenUuid: snapshot.station.tokenUuid,
    stationName: snapshot.station.name,
    performerUuid: performer.actorUuid,
    performerName: performer.name,
    recipeId: recipe.id,
    recipeName: recipe.name,
    skillKey: plan.skillKey,
    total: roll.total,
    dc: plan.dc,
    outcome,
    mealName: mealPassiveName(outcome),
    special: plan.special,
    diners: Object.freeze(meals.map(meal => Object.freeze({ actorUuid: meal.actorUuid, name: meal.name, summary: meal.built.summary }))),
    support,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.COOK_SETTLED, {
    ...performerFacts(snapshot, performer),
    requester: cardRequester(context),
    recipeName: recipe.name,
    total: roll.total,
    dc: plan.dc,
    outcome,
    mealName: outcomeData.mealName,
    specialName: plan.special?.name ?? '',
    specialStat: plan.special?.stat ?? '',
    diners: meals.map(meal => ({ name: meal.name, image: meal.image, avatarScale: meal.avatarScale, summary: meal.built.summary })),
    supportGain: support.gain,
    supportRecipients: support.recipients,
    rankUps: support.rankUps
  }));
  runSafely(services, () => services.events.publish(EVENT_IDS.COOKING_SETTLED, outcomeData), 'cooking-settled');
  return accept(RESULT_CODES.DOWNTIME_COOKED, outcomeData);
}

/**
 * Grant support XP between one unit and each partner through the SUPPORT.GRANT_XP child command
 * (engine/support/commands.mjs), which also writes the bond on the partner's side. A failed award doesn't undo the
 * finished activity.
 */
async function grantSupportExperience(services, source, partners, amount, context) {
  const partnerActorUuids = partners.map(partner => partner.actorUuid).filter(uuid => uuid !== source.actorUuid);
  const empty = Object.freeze({ gain: 0, recipients: Object.freeze([]), rankUps: Object.freeze([]) });
  if (!partnerActorUuids.length) return empty;
  try {
    const result = await services.support.grant({
      sourceActorUuid: source.actorUuid, partnerActorUuids, amount, autoCreate: true
    }, context);
    if (result?.ok !== true) return empty;
    return Object.freeze({
      gain: Number(result.data?.gain) || 0,
      recipients: Object.freeze((result.data?.recipients ?? []).map(String)),
      rankUps: Object.freeze((result.data?.rankUps ?? []).map(entry => `${entry.a} & ${entry.b}: Support ${entry.from} → ${entry.to}!`))
    });
  } catch (error) {
    recordAbsorbed(services, error, 'support-experience', DIAGNOSTIC_SOURCES.DOWNTIME);
    return empty;
  }
}

/* -------------------------------------------- */
/*  Performance                                 */
/* -------------------------------------------- */
/**
 * Resolve a performance for downtime/commands.mjs. The lead and then each accompaniment roll Performance against
 * the song's DC, each on its own card. The margins set the grade, and allocateSongBonuses hands out the song's
 * bonuses by that grade. FoundryDowntimeRepository.settlePerformance spends the lead's downtime and puts Inspired,
 * or Uninspired after a total failure, on every audience unit. Support and skill XP follow.
 *
 * If the song has a track, FoundryPerformanceMusic starts it as the banner opens, in place of the banner's opening
 * sound, and the banner stays up for at least PERFORMANCE_TIMING.trackLinger. On a success the track plays on and
 * the banner closes without its success sound. A total failure stops the track at once and closes the banner with
 * the failure sound, its icon greyed in a dark red glow on every client.
 */
export async function playInstrument(context, services, snapshot, performer, plan) {
  const song = plan.song;
  const songName = song.name || 'a song';
  const track = song.track || '';
  const opened = clockNow(services);
  if (track) cueTrack(services, music => music.play(track));
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.PERFORM_BEGIN, {
    stationTokenUuid: snapshot.station.tokenUuid, iconImage: snapshot.station.image,
    ...(track ? { trackPlaying: true } : {})
  }));
  const units = [performer, ...plan.accompaniments];
  const totals = await rollPerformers(context, services, units, plan, { songName, track, opened });
  const [leadMargin, ...accompanimentMargins] = totals.map(total => total - plan.dc);
  const { grade, increments } = gradePerformance({ leadMargin, accompanimentMargins });
  const allocated = allocateSongBonuses(song.bonuses, grade, increments, services.random);
  const inspired = grade !== PERFORMANCE_GRADES.FAILURE;
  if (track && !inspired) cueTrack(services, music => music.stop());
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.PERFORM_END, {
    success: inspired, ...trackCloseFlags(track, inspired)
  }));

  const built = inspired ? buildPerformancePassive(song, grade, allocated) : buildUninspiredPassive(song);
  const settled = await services.downtime.settlePerformance(snapshot, {
    performer,
    commitment: actionLaneSpend(`Performance: ${songName}`),
    passives: plan.audience.map(unit => ({ actorUuid: unit.actorUuid, data: built.data }))
  }, context);
  if (settled.ok !== true) {
    if (track && inspired) cueTrack(services, music => music.stop());
    return settlementRefusal(settled);
  }
  const support = await grantPerformanceSupport(services, units, plan.listeners, grade, context);
  for (const unit of units) {
    await grantSkillExperience(services, unit.actorUuid, plan.skillKey, DOWNTIME_XP_FRACTION_ACTION, context);
  }
  const outcomeData = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    stationTokenUuid: snapshot.station.tokenUuid,
    stationName: snapshot.station.name,
    performerUuid: performer.actorUuid,
    performerName: performer.name,
    songId: song.id,
    songName: song.name,
    skillKey: plan.skillKey,
    dc: plan.dc,
    performers: Object.freeze(units.map((unit, index) => Object.freeze({
      actorUuid: unit.actorUuid, name: unit.name, image: unit.image, avatarScale: unit.avatarScale,
      total: totals[index], success: totals[index] - plan.dc >= 1
    }))),
    grade,
    bonuses: allocated,
    passiveName: built.name,
    affected: Object.freeze([...(settled.affected ?? plan.audience.map(unit => unit.name))]),
    listeners: Object.freeze(plan.listeners.map(unit => unit.name)),
    support,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, performanceCardMessage(context, snapshot, performer, song, outcomeData));
  runSafely(services, () => services.events.publish(EVENT_IDS.PERFORMANCE_SETTLED, outcomeData), 'performance-settled');
  return accept(RESULT_CODES.DOWNTIME_PERFORMED, outcomeData);
}

/**
 * Grant a performance's support XP: once for every pair of performers, then between each performer and every party
 * unit that only listened. The card shows the merged recipients and rank-ups.
 */
async function grantPerformanceSupport(services, performers, listeners, grade, context) {
  const pairs = [];
  for (const [index, source] of performers.entries()) {
    pairs.push(await grantSupportExperience(
      services, source, performers.slice(index + 1), performerSupportXpFor(grade), context));
  }
  const heard = [];
  for (const source of performers) {
    heard.push(await grantSupportExperience(services, source, listeners, listenerSupportXpFor(grade), context));
  }
  const grants = [...pairs, ...heard];
  return Object.freeze({
    performerGain: Math.max(0, ...pairs.map(grant => grant.gain)),
    listenerGain: Math.max(0, ...heard.map(grant => grant.gain)),
    recipients: Object.freeze([...new Set(grants.flatMap(grant => grant.recipients))]),
    rankUps: Object.freeze(grants.flatMap(grant => grant.rankUps))
  });
}

/**
 * Roll every performer's check, the lead first, once the banner has held PERFORMANCE_TIMING.bannerHold. With a track
 * the banner then stays up until PERFORMANCE_TIMING.trackLinger has passed since `opened`, and a roll that throws
 * stops the track before activityFailure in downtime/commands.mjs closes the banner.
 */
async function rollPerformers(context, services, units, plan, { songName, track, opened }) {
  const totals = [];
  try {
    await services.wait(PERFORMANCE_TIMING.bannerHold);
    for (const unit of units) {
      const roll = await rollCheck(context, services, unit, skillCheckFor(unit, plan.skillKey, plan.dc), {
        effectName: 'Performance', targetName: songName, detail: 'perform-card'
      });
      totals.push(Number(roll.total) || 0);
    }
    if (track) {
      const remaining = PERFORMANCE_TIMING.trackLinger - (clockNow(services) - opened);
      if (remaining > 0) await services.wait(remaining);
    }
  } catch (error) {
    if (track) cueTrack(services, music => music.stop());
    throw error;
  }
  return totals;
}

/**
 * Track flags for the banner's closing message. On a success they tell every client the track plays on in place
 * of the success sound. On a total failure they say the track stopped, so each banner greys its icon as it closes.
 */
function trackCloseFlags(track, inspired) {
  if (!track) return {};
  return inspired ? { trackPlaying: true } : { trackStopped: true };
}

/**
 * Start or stop the song's track through FoundryPerformanceMusic (wired in init/system.mjs). The command doesn't
 * wait for playback, and a playback error is only recorded.
 */
function cueTrack(services, cue) {
  runSafely(services, () => {
    void Promise.resolve(cue(services.music)).catch(error => {
      recordAbsorbed(services, error, 'performance-track', DIAGNOSTIC_SOURCES.DOWNTIME);
    });
  }, 'performance-track');
}

/** The command's clock, used to measure how long the banner has been up. The pauses themselves use `wait`. */
function clockNow(services) {
  return services.now();
}

/** The performance card: each performer's roll, the grade, the bonuses the audience got, and the support XP. */
function performanceCardMessage(context, snapshot, performer, song, outcome) {
  const listed = values => values.slice(0, PERFORMANCE_CARD_ROWS);
  return downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.PERFORM_SETTLED, {
    ...performerFacts(snapshot, performer),
    requester: cardRequester(context),
    songName: song.name,
    songImage: song.img,
    grade: outcome.grade,
    gradeLabel: PERFORMANCE_GRADE_LABELS[outcome.grade] ?? '',
    dc: outcome.dc,
    performers: outcome.performers.map(entry => ({
      name: entry.name, image: entry.image, avatarScale: entry.avatarScale, total: entry.total, success: entry.success
    })),
    bonuses: Object.entries(outcome.bonuses).map(([key, amount]) => describeBonuses({ [key]: amount })).filter(Boolean),
    affectedCount: outcome.affected.length,
    listeners: listed(outcome.listeners),
    listenerCount: outcome.listeners.length,
    performerGain: outcome.support.performerGain,
    listenerGain: outcome.support.listenerGain,
    supportRecipients: listed(outcome.support.recipients),
    rankUps: listed(outcome.support.rankUps)
  });
}

/* -------------------------------------------- */
/*  Requisition                                 */
/* -------------------------------------------- */
/**
 * Resolve a requisition for downtime/commands.mjs. The requisitioner rolls Civics against the faction's DC on its
 * own card. FoundryDowntimeRepository.settleRequisition then spends its whole downtime and locks the faction
 * whatever the answer, and a granted demand joins its Convoy's inbound gold for the GM to deliver. Civics XP
 * follows, then the result card and REQUISITION_SETTLED.
 */
export async function draftRequisition(context, services, snapshot, performer, plan) {
  const { faction, demand, dc } = plan;
  const factionName = faction.name || 'the faction';
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.REQUISITION_BEGIN, {
    stationTokenUuid: snapshot.station.tokenUuid, iconImage: snapshot.station.image
  }));
  await services.wait(REQUISITION_TIMING.bannerHold);
  const roll = await rollCheck(context, services, performer, skillCheckFor(performer, plan.skillKey, dc), {
    effectName: 'Requisition', targetName: factionName, detail: 'requisition-card'
  });
  const outcome = requisitionOutcome(roll.total, dc);
  const success = outcome === REQUISITION_OUTCOMES.SUCCESS;
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.REQUISITION_END, {
    success
  }));

  const settled = await services.downtime.settleRequisition(snapshot, {
    performer,
    commitment: actionLaneSpend(`Requisition: ${factionName}`),
    factionId: faction._id,
    convoyUuid: plan.convoy.uuid,
    gold: success ? demand : 0
  }, context);
  if (settled.ok !== true) return settlementRefusal(settled);
  await grantSkillExperience(services, performer.actorUuid, plan.skillKey, DOWNTIME_XP_FRACTION_ACTION, context);
  const summary = describeRequisition({
    faction, kind: plan.kind, demand, dc, total: roll.total, outcome, convoyName: plan.convoy.name
  });
  const outcomeData = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    stationTokenUuid: snapshot.station.tokenUuid,
    stationName: snapshot.station.name,
    performerUuid: performer.actorUuid,
    performerName: performer.name,
    factionId: faction._id,
    factionName: faction.name,
    requestKind: plan.kind,
    demand,
    dc,
    skillKey: plan.skillKey,
    total: roll.total,
    outcome,
    success,
    gold: success ? demand : 0,
    convoyUuid: plan.convoy.uuid,
    convoyName: plan.convoy.name,
    summary,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.REQUISITION_SETTLED, {
    ...performerFacts(snapshot, performer),
    requester: cardRequester(context),
    factionName: faction.name,
    requestKind: plan.kind,
    demand,
    dc,
    total: roll.total,
    success,
    outcome,
    convoyName: plan.convoy.name,
    summary
  }));
  runSafely(services, () => services.events.publish(EVENT_IDS.REQUISITION_SETTLED, outcomeData),
    'requisition-settled');
  return accept(RESULT_CODES.DOWNTIME_REQUISITIONED, outcomeData);
}

/* -------------------------------------------- */
/*  Socializing                                 */
/* -------------------------------------------- */
/**
 * Resolve a socialize for engine/downtime/commands.mjs. The conversation band opens over both portraits, then the
 * unit that started the visit and the unit it chose each roll Sociability on their own card.
 * FoundryDowntimeRepository.settleSocial spends both units' whole downtime. The pair's support bond then gains the
 * two totals added together, and both units earn Sociability XP.
 */
export async function converse(context, services, snapshot, plan) {
  const { cursor, partner } = plan;
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.SOCIAL_BEGIN, {
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    partnerTokenUuid: snapshot.partner.tokenUuid,
    left: portrait(cursor),
    right: portrait(partner)
  }));
  await services.wait(SOCIAL_TIMING.bannerHold);
  const totals = [];
  for (const [unit, other] of [[cursor, partner], [partner, cursor]]) {
    const roll = await rollCheck(context, services, unit, skillCheckFor(unit, SOCIAL_SKILL_KEY), {
      effectName: 'Socialize', targetName: other.name, detail: 'social-card'
    });
    totals.push(Number(roll.total) || 0);
  }
  const [firstTotal, secondTotal] = totals;
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.SOCIAL_END, {
    success: true
  }));

  const settled = await services.downtime.settleSocial(snapshot, { units: [
    { actorUuid: cursor.actorUuid, commitment: actionLaneSpend(`Socializing: ${partner.name}`) },
    { actorUuid: partner.actorUuid, commitment: actionLaneSpend(`Socializing: ${cursor.name}`) }
  ] }, context);
  if (settled.ok !== true) return settlementRefusal(settled);
  const support = await grantSupportExperience(
    services, cursor, [partner], socialSupportExperience(firstTotal, secondTotal), context);
  for (const unit of [cursor, partner]) {
    await grantSkillExperience(services, unit.actorUuid, SOCIAL_SKILL_KEY, DOWNTIME_XP_FRACTION_ACTION, context);
  }
  const outcome = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    partnerTokenUuid: snapshot.partner.tokenUuid,
    cursorUuid: cursor.actorUuid,
    cursorName: cursor.name,
    partnerUuid: partner.actorUuid,
    partnerName: partner.name,
    skillKey: SOCIAL_SKILL_KEY,
    firstTotal,
    secondTotal,
    support,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.SOCIAL_SETTLED, {
    actorUuid: cursor.actorUuid,
    actorName: cursor.name,
    actorImage: cursor.image,
    avatarScale: cursor.avatarScale,
    requester: cardRequester(context),
    partnerName: partner.name,
    partnerImage: partner.image,
    partnerAvatarScale: partner.avatarScale,
    firstTotal,
    secondTotal,
    skillLabel: SKILL_BY_KEY[SOCIAL_SKILL_KEY]?.label ?? 'Sociability',
    supportGain: support.gain,
    supportRecipients: support.recipients,
    rankUps: support.rankUps
  }));
  runSafely(services, () => services.events.publish(EVENT_IDS.SOCIALIZE_SETTLED, outcome), 'socialize-settled');
  return accept(RESULT_CODES.DOWNTIME_SOCIALIZED, outcome);
}

/** One side of the conversation band: the unit's name, portrait and avatar scale. */
function portrait(unit) {
  return { name: unit.name, image: unit.image, avatarScale: unit.avatarScale };
}

/* -------------------------------------------- */
/*  Training                                    */
/* -------------------------------------------- */
/**
 * Resolve a training session for engine/downtime/commands.mjs. The pair spars using an item animation chosen for
 * the proficiency (`snapshot.spar`), then the trainer rolls Command and the trainee earns the whole total
 * as proficiency XP through planProficiencyExperienceGrant. FoundryDowntimeRepository.settleTraining spends both
 * units' downtime and writes the trainee's proficiency. A rank-up shows the combat rank-up card. Both units' level
 * XP from the spar goes through the combat progression service, trainer first, and may level either up. The pair's
 * support bond gains TRAINING_SUPPORT_XP, and only the trainer earns Command XP.
 */
export async function spar(context, services, snapshot, plan) {
  const { trainer, trainee } = plan;
  await presentSafely(services, sparOpening(snapshot, plan));
  const animation = snapshot.spar?.animation ?? null;
  await services.wait(animation ? TRAINING_SPAR.passes * snapshot.spar.passDurationMs : 0);
  const roll = await rollCheck(context, services, trainer, skillCheckFor(trainer, TRAIN_SKILL_KEY), {
    effectName: 'Training', targetName: `${trainee.name} (${plan.label})`, detail: 'train-card'
  });
  const total = Number(roll.total) || 0;
  const proficiency = trainee.proficiencies?.[plan.key] ?? null;
  const grant = planProficiencyExperienceGrant(proficiency, trainingProficiencyExperience(total));

  const settled = await services.downtime.settleTraining(snapshot, {
    units: [
      { actorUuid: trainer.actorUuid, commitment: actionLaneSpend(`Training: ${trainee.name}`) },
      { actorUuid: trainee.actorUuid, commitment: actionLaneSpend(`Training: ${trainer.name}`) }
    ],
    proficiency: grant ? {
      actorUuid: trainee.actorUuid,
      key: plan.key,
      base: grant.base ?? Math.max(0, Math.floor(Number(proficiency?.base) || 0)),
      xp: grant.xp
    } : null
  }, context);
  if (settled.ok !== true) return settlementRefusal(settled);
  if (grant?.rankedUp) await presentSafely(services, traineeRankUpMessage(context, trainee, grant));
  const levels = await settleSparExperience(context, services, plan);
  if (levels.ok !== true) {
    return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED, { reasonCode: levels.code });
  }
  const support = await grantSupportExperience(services, trainer, [trainee], TRAINING_SUPPORT_XP, context);
  await grantSkillExperience(services, trainer.actorUuid, TRAIN_SKILL_KEY, DOWNTIME_XP_FRACTION_ACTION, context);
  const outcome = Object.freeze({
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    partnerTokenUuid: snapshot.partner.tokenUuid,
    trainerUuid: trainer.actorUuid,
    trainerName: trainer.name,
    traineeUuid: trainee.actorUuid,
    traineeName: trainee.name,
    proficiencyKey: plan.key,
    skillKey: TRAIN_SKILL_KEY,
    total,
    proficiencyExperience: grant?.awarded ?? 0,
    rankedUp: grant?.rankedUp === true,
    newRankLetter: grant?.rankedUp ? grant.rankLetter : null,
    levelExperience: Object.freeze({ trainer: levels.trainer, trainee: levels.trainee }),
    support,
    requestId: context.requestId,
    userId: context.userId
  });
  await presentSafely(services, trainingCardMessage(context, plan, outcome));
  runSafely(services, () => services.events.publish(EVENT_IDS.TRAINING_SETTLED, outcome), 'training-settled');
  return accept(RESULT_CODES.DOWNTIME_TRAINED, outcome);
}

/**
 * The spar's opening message: both tokens by role and the passes DowntimePresentation plays between them. If no
 * playable animation was found, the session opens with no passes.
 */
function sparOpening(snapshot, plan) {
  const tokenOf = unit => (unit.actorUuid === snapshot.cursor.actorUuid
    ? snapshot.cursor.tokenUuid : snapshot.partner.tokenUuid);
  const animation = snapshot.spar?.animation ?? null;
  return downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.TRAIN_BEGIN, {
    trainerTokenUuid: tokenOf(plan.trainer),
    traineeTokenUuid: tokenOf(plan.trainee),
    proficiencyKey: plan.key,
    animation,
    passes: animation ? TRAINING_SPAR.passes : 0,
    passDurationMs: animation ? snapshot.spar.passDurationMs : 0
  });
}

/** The combat exchange's weapon rank-up card, for a trainee whose grant crossed its threshold. */
function traineeRankUpMessage(context, trainee, grant) {
  const requester = cardRequester(context);
  return combatPresentationMessage(COMBAT_PRESENTATION_BEATS.RANK_UP, {
    actorUuid: trainee.actorUuid,
    actorName: trainee.name,
    actorImage: trainee.image,
    avatarScale: trainee.avatarScale,
    proficiencyKey: grant.key,
    rankLetter: grant.rankLetter,
    rank: grant.rank,
    ...(requester ? { requester } : {})
  });
}

/**
 * Award both units' raw spar XP through the combat progression service (engine/character/progression.mjs), which
 * scales each award by the unit's and the world's multipliers and may level the unit up. Then present each award
 * in turn, trainer first.
 * @returns {Promise<{ok: boolean, code?: string, trainer: number, trainee: number}>} The scaled awards.
 */
async function settleSparExperience(context, services, plan) {
  const progression = services.progression;
  const settled = await progression.settleCombatExperience({
    awards: [
      { actorUuid: plan.trainer.actorUuid, experience: plan.levelExperience.trainer, side: 'trainer' },
      { actorUuid: plan.trainee.actorUuid, experience: plan.levelExperience.trainee, side: 'trainee' }
    ],
    operation: context.operation ?? null
  });
  if (settled.ok !== true) {
    return { ok: false, code: String(settled.code ?? ''), trainer: 0, trainee: 0 };
  }
  const settlements = settled.settlements;
  for (const entry of settlements) {
    await services.wait(COMBAT_EXCHANGE_TIMING.experienceLeadIn);
    await runSafelyAsync(services, () => progression.publishCombatExperience({
      settlements: [entry], context
    }), 'train-experience');
  }
  const awarded = side => Number(settlements.find(entry => entry.side === side)?.experience.awarded) || 0;
  return { ok: true, trainer: awarded('trainer'), trainee: awarded('trainee') };
}

/** The training card: the trainer's roll, the trainee's proficiency XP, both units' level XP and the support XP. */
function trainingCardMessage(context, plan, outcome) {
  const { trainer, trainee } = plan;
  return downtimePresentationMessage(DOWNTIME_PRESENTATION_EVENTS.TRAIN_SETTLED, {
    actorUuid: trainer.actorUuid,
    actorName: trainer.name,
    actorImage: trainer.image,
    avatarScale: trainer.avatarScale,
    requester: cardRequester(context),
    traineeName: trainee.name,
    traineeImage: trainee.image,
    traineeAvatarScale: trainee.avatarScale,
    proficiencyKey: plan.key,
    proficiencyLabel: plan.label,
    proficiencyIcon: plan.icon,
    trainerRankLabel: plan.trainerRankLabel,
    traineeRankLabel: plan.traineeRankLabel,
    roll: outcome.total,
    proficiencyExperience: outcome.proficiencyExperience,
    rankedUp: outcome.rankedUp,
    newRankLetter: outcome.newRankLetter,
    trainerLevelExperience: outcome.levelExperience.trainer,
    traineeLevelExperience: outcome.levelExperience.trainee,
    supportGain: outcome.support.gain,
    supportRecipients: outcome.support.recipients,
    rankUps: outcome.support.rankUps
  });
}
