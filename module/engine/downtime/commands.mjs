/** @layer engine/downtime */
import { COMMAND_IDS, INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { KARMA_LEDGER_RESOURCE_KEY } from '../../contracts/domains/combat.mjs';
import {
  DOWNTIME_LANES,
  DOWNTIME_PRESENTATION_EVENTS,
  GATHERING_TIMING,
  PERFORMANCE_PASSIVE_NAMES,
  REQUISITION_AVAILABLE_KINDS,
  REQUISITION_KIND_LABELS,
  REQUISITION_KIND_ORDER,
  REQUISITION_LIMITS,
  REQUISITION_SKILL_KEY,
  SOCIAL_SKILL_KEY,
  TRAINING_SUPPORT_XP,
  TRAIN_SKILL_KEY,
  downtimePresentationMessage,
  normalizeBrewingIntent,
  normalizeCookingIntent,
  normalizeDowntimeResetIntent,
  normalizeDowntimeUnitIntent,
  normalizeEnergyRestoreIntent,
  normalizeForgingIntent,
  normalizeGatheringIntent,
  normalizePerformanceIntent,
  normalizeFactions,
  normalizeRecipeLibraryIntent,
  normalizeRequisitionIntent,
  normalizeSocialIntent,
  normalizeSongLibraryIntent,
  normalizeStationIntent,
  normalizeTrainingIntent
} from '../../contracts/domains/downtime.mjs';
import { DIAGNOSTIC_SOURCES, recordDiagnostic, requirePorts } from '../../contracts/protocol.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { SKILL_BY_KEY, skillRankLabel } from '../../game/character/rules.mjs';
import {
  COOK_SKILL,
  SPECIAL_MARGIN,
  normalizeRecipes,
  planCooking,
  recipesForChef
} from '../../game/downtime/cooking.mjs';
import {
  CRAFTING_ENERGY_COST,
  CRAFT_CRIT_MARGIN,
  DEFAULT_BREW_SKILL,
  DEFAULT_FORGE_SKILL,
  craftingKind,
  craftingSkillKey,
  forgeState,
  forgeTierPreviews,
  forgeableKind,
  planBrewing,
  planForging,
  reachOwners,
  reachableStacks,
  supplyRows,
  supplyTotals
} from '../../game/downtime/crafting.mjs';
import {
  GATHERING_ENERGY_COST,
  gatherableEntry,
  gatheringMethod,
  gatheringMultiplier,
  gatheringSkillKey,
  nodeStock,
  planGathering
} from '../../game/downtime/gathering.mjs';
import { missingBuiltins } from '../../game/downtime/library.mjs';
import { normalizeSongs, planPerformance, songsForPerformer } from '../../game/downtime/performance.mjs';
import { planFactionReset, planRequisition, requisitionDc, wealthCap } from '../../game/downtime/requisition.mjs';
import {
  defeatedBlock,
  downtimeCommitment,
  downtimeResetAvailable,
  energyRestoreAvailable,
  leadRoster,
  planDowntimeReset,
  planEnergyRestore,
  resolveParticipants
} from '../../game/downtime/rules.mjs';
import {
  actionLaneBlock, eligibleTraining, planSocialize, planTraining, trainingRewardPreview
} from '../../game/downtime/social.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { holdsResources } from '../dispatcher.mjs';
import { presentSafely, recordAbsorbed } from '../feedback.mjs';
import {
  converse, draftRequisition, playInstrument, skillCheckFor, spar, workBrew, workForge, workNode, workPot
} from './resolvers.mjs';

const RECIPE_LIBRARY_KEY = 'downtime:recipe-library';
const SONG_LIBRARY_KEY = 'downtime:song-library';

/** The skill every performer rolls at an Instrument. */
const PERFORMANCE_SKILL_KEY = 'performance';

/** Why nobody may start a downtime activity outside free exploration, as a menu's performer tiles and buttons say. */
const EXPLORATION_BLOCK = 'Only in free exploration';

/* -------------------------------------------- */
/*  Downtime commands                           */
/* -------------------------------------------- */
/**
 * Build the downtime command definitions that init/system.mjs registers with CommandDispatcher: gathering,
 * crafting, cooking, performance, requisition, socializing and training, the recipe and song library saves and
 * their startup repairs, and the GM's downtime resets. `music` is FoundryPerformanceMusic, which starts a song's
 * track as the performance banner opens and stops it on a total failure. `now` times how long that banner has
 * been up. `progression` is createCombatProgressionService (engine/character/progression.mjs), which awards a
 * training session's level XP.
 *
 * Socializing and training check only that the requester controls the unit that starts them. The partner is
 * whichever adjacent party unit it chose, whoever owns it, and the handler checks the pair again before rolling.
 */
export function createDowntimeCommandContribution({
  downtime, checks, checkPresentation, skills, support, music, progression, presentation, events, diagnostics,
  authority, random, wait, now = () => Date.now()
}) {
  requirePorts('createDowntimeCommandContribution', { downtime, checks, checkPresentation, skills, support, music,
    progression, presentation, events, diagnostics, random, wait });
  const services = { downtime, checks, checkPresentation, skills, support, music, progression, presentation, events,
    diagnostics, random, wait, now };
  const authorize = createCommandAuthorization(authority);
  const definition = (id, handler, sharedKeys = []) => ({
    id,
    authorize: authorize.all(
      authorize.tokenController(payload => payload.cursorTokenUuid),
      authorize.actorOwner(payload => payload.performerUuid)
    ),
    concurrencyKeys: async context => [...await downtime.resourceKeys(context.payload), ...sharedKeys],
    handler: context => handler(context, services)
  });
  const pairDefinition = (id, handler) => ({
    id,
    authorize: authorize.tokenController(payload => payload.cursorTokenUuid),
    concurrencyKeys: async context => [...await downtime.resourceKeys(context.payload), KARMA_LEDGER_RESOURCE_KEY],
    handler: context => handler(context, services)
  });
  return [
    definition(COMMAND_IDS.DOWNTIME.GATHER, gather),
    definition(COMMAND_IDS.DOWNTIME.FORGE, forge),
    // Brewing, cooking, performing and requisitions roll against a DC, so the check may be karmic and write the
    // world's karma ledger.
    definition(COMMAND_IDS.DOWNTIME.BREW, brew, [KARMA_LEDGER_RESOURCE_KEY]),
    definition(COMMAND_IDS.DOWNTIME.COOK, cook, [KARMA_LEDGER_RESOURCE_KEY]),
    definition(COMMAND_IDS.DOWNTIME.PERFORM, perform, [KARMA_LEDGER_RESOURCE_KEY]),
    definition(COMMAND_IDS.DOWNTIME.REQUISITION, requisition, [KARMA_LEDGER_RESOURCE_KEY]),
    pairDefinition(COMMAND_IDS.DOWNTIME.SOCIALIZE, socialize),
    pairDefinition(COMMAND_IDS.DOWNTIME.TRAIN, train),
    {
      id: COMMAND_IDS.DOWNTIME.SAVE_RECIPE_LIBRARY,
      authorize: authorize.gm(),
      concurrencyKeys: () => [RECIPE_LIBRARY_KEY],
      handler: context => saveRecipeLibrary(context, services)
    },
    {
      id: INTERNAL_COMMAND_IDS.DOWNTIME.REPAIR_RECIPE_LIBRARY,
      authorize: authorize.activeGm(),
      concurrencyKeys: () => [RECIPE_LIBRARY_KEY],
      handler: () => repairRecipeLibrary(services)
    },
    {
      id: COMMAND_IDS.DOWNTIME.SAVE_SONG_LIBRARY,
      authorize: authorize.gm(),
      concurrencyKeys: () => [SONG_LIBRARY_KEY],
      handler: context => saveSongLibrary(context, services)
    },
    {
      id: INTERNAL_COMMAND_IDS.DOWNTIME.REPAIR_SONG_LIBRARY,
      authorize: authorize.activeGm(),
      concurrencyKeys: () => [SONG_LIBRARY_KEY],
      handler: () => repairSongLibrary(services)
    },
    {
      id: COMMAND_IDS.DOWNTIME.RESET_ACTIVITY,
      authorize: authorize.gm(),
      concurrencyKeys: context => downtime.unitResourceKeys(context.payload),
      handler: context => resetActivity(context, services)
    },
    {
      id: COMMAND_IDS.DOWNTIME.RESTORE_ENERGY,
      authorize: authorize.gm(),
      concurrencyKeys: context => downtime.unitResourceKeys(context.payload),
      handler: context => restoreEnergy(context, services)
    },
    {
      id: COMMAND_IDS.DOWNTIME.RESET,
      authorize: authorize.gm(),
      concurrencyKeys: context => downtime.sceneResourceKeys(context.payload),
      handler: context => resetDowntime(context, services)
    }
  ];
}

/* -------------------------------------------- */
/*  Gathering                                   */
/* -------------------------------------------- */
/**
 * The gathering command. performAtStation moves the gatherer to the node and back around workNode
 * (downtime/resolvers.mjs), which rolls, spends the Energy and delivers the yield. A node left empty is removed
 * after the gatherer has gone back.
 */
async function gather(context, services) {
  const intent = normalizeGatheringIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getGatheringSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const plan = planGathering({
    station: snapshot.station,
    exploring: snapshot.exploring === true,
    inReach: snapshot.inReach === true,
    roster: snapshot.roster,
    performerUuid: intent.performerUuid,
    cursorActorUuid: snapshot.cursor.actorUuid,
    cursorName: snapshot.cursor.name
  });
  if (!plan.ok) return refuse(plan.code, plan.data);
  const performer = snapshot.roster.find(entry => entry.actorUuid === intent.performerUuid);
  const outcome = await performAtStation(context, services, snapshot, performer, {
    staged: plan.data.staged, endEvent: DOWNTIME_PRESENTATION_EVENTS.GATHER_END, detail: 'gather'
  }, activity => workNode(activity, services, snapshot, performer, { ...plan.data, destination: intent.destination }));
  if (outcome.ok === true && outcome.data.exhausted) {
    await services.wait(GATHERING_TIMING.nodeRemoval);
    await services.downtime.removeStation(snapshot.station.tokenUuid, context.operation);
  }
  return outcome;
}

/* -------------------------------------------- */
/*  Forging and brewing                         */
/* -------------------------------------------- */
/** The forging command: checks the item with planForging, then runs workForge inside performAtStation. */
async function forge(context, services) {
  const intent = normalizeForgingIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getCraftingSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const plan = planForging({ ...craftingFacts(snapshot, intent.performerUuid), itemUuid: intent.itemUuid });
  if (!plan.ok) return refuse(plan.code, plan.data);
  const performer = snapshot.roster.find(entry => entry.actorUuid === intent.performerUuid);
  return performAtStation(context, services, snapshot, performer, {
    staged: plan.data.staged, endEvent: DOWNTIME_PRESENTATION_EVENTS.FORGE_END, detail: 'forge'
  }, activity => workForge(activity, services, snapshot, performer, plan.data));
}

/** The brewing command: checks the recipe with planBrewing, then runs workBrew inside performAtStation. */
async function brew(context, services) {
  const intent = normalizeBrewingIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getCraftingSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const recipe = (snapshot.recipes ?? []).find(entry => entry.uuid === intent.recipeUuid) ?? null;
  const plan = planBrewing({ ...craftingFacts(snapshot, intent.performerUuid), recipe });
  if (!plan.ok) return refuse(plan.code, plan.data);
  const performer = snapshot.roster.find(entry => entry.actorUuid === intent.performerUuid);
  return performAtStation(context, services, snapshot, performer, {
    staged: plan.data.staged, endEvent: DOWNTIME_PRESENTATION_EVENTS.BREW_END, detail: 'brew'
  }, activity => workBrew(activity, services, snapshot, performer, plan.data));
}

function craftingFacts(snapshot, performerUuid) {
  return {
    station: snapshot.station,
    exploring: snapshot.exploring === true,
    inReach: snapshot.inReach === true,
    roster: snapshot.roster,
    performerUuid,
    cursorActorUuid: snapshot.cursor.actorUuid,
    cursorName: snapshot.cursor.name,
    items: snapshot.items ?? [],
    stacks: snapshot.stacks ?? {},
    convoyUuid: snapshot.convoy?.uuid ?? ''
  };
}

/* -------------------------------------------- */
/*  Cooking                                     */
/* -------------------------------------------- */
/** The cooking command: checks the meal with planCooking, then runs workPot inside performAtStation. */
async function cook(context, services) {
  const intent = normalizeCookingIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getCookingSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const plan = planCooking({
    ...craftingFacts(snapshot, intent.performerUuid),
    library: snapshot.library ?? [],
    recipeId: intent.recipeId,
    specialName: intent.specialName,
    dinerUuids: intent.dinerUuids
  });
  if (!plan.ok) return refuse(plan.code, plan.data);
  const performer = snapshot.roster.find(entry => entry.actorUuid === intent.performerUuid);
  return performAtStation(context, services, snapshot, performer, {
    staged: plan.data.staged, endEvent: DOWNTIME_PRESENTATION_EVENTS.COOK_END, detail: 'cook'
  }, activity => workPot(activity, services, snapshot, performer, plan.data));
}

/* -------------------------------------------- */
/*  Performance                                 */
/* -------------------------------------------- */
/**
 * The performance command: runs playInstrument (downtime/resolvers.mjs) inside performAtStation. Only the lead
 * moves to the Instrument and spends its downtime. planPerformance has already checked the song, the
 * accompaniments, and that no performer was affected by an earlier performance.
 */
async function perform(context, services) {
  const intent = normalizePerformanceIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getPerformanceSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const planned = planPerformance(snapshot, intent);
  if (!planned.ok) return refuse(planned.code, planned.data);
  const performer = snapshot.roster.find(entry => entry.actorUuid === intent.performerUuid);
  return performAtStation(context, services, snapshot, performer, {
    staged: planned.plan.staged, endEvent: DOWNTIME_PRESENTATION_EVENTS.PERFORM_END, detail: 'perform'
  }, activity => playInstrument(activity, services, snapshot, performer, planned.plan));
}

/* -------------------------------------------- */
/*  Requisition                                 */
/* -------------------------------------------- */
/**
 * The requisition command: runs draftRequisition (downtime/resolvers.mjs) inside performAtStation.
 * planRequisition in game/downtime/requisition.mjs has already checked the Stationary, the requisitioner's
 * Downtime Action and linked Convoy, the kind, the faction row and the demand against the faction's wealth.
 */
async function requisition(context, services) {
  const intent = normalizeRequisitionIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getRequisitionSnapshot(intent);
  if (!snapshot) return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const planned = planRequisition(snapshot, intent);
  if (!planned.ok) return refuse(planned.code, planned.data);
  const performer = snapshot.roster.find(entry => entry.actorUuid === intent.performerUuid);
  return performAtStation(context, services, snapshot, performer, {
    staged: planned.plan.staged, endEvent: DOWNTIME_PRESENTATION_EVENTS.REQUISITION_END, detail: 'requisition'
  }, activity => draftRequisition(activity, services, snapshot, performer, planned.plan));
}

/* -------------------------------------------- */
/*  Socializing and training                    */
/* -------------------------------------------- */
/**
 * The socialize command: runs converse (downtime/resolvers.mjs) inside performTogether. The pair is read fresh,
 * and planSocialize checks again for free exploration, party membership, adjacency and both units' Downtime Action
 * before anything rolls.
 */
async function socialize(context, services) {
  const intent = normalizeSocialIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getSocialSnapshot(intent);
  if (!snapshot) return pairUnavailable(services, intent);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const planned = planSocialize(snapshot);
  if (!planned.ok) return refuse(planned.code, planned.data);
  return performTogether(context, services, snapshot, {
    endEvent: DOWNTIME_PRESENTATION_EVENTS.SOCIAL_END, detail: 'socialize'
  }, activity => converse(activity, services, snapshot, planned.plan));
}

/**
 * The training command: runs spar (downtime/resolvers.mjs) inside performTogether. planTraining makes the
 * socialize checks, then checks the chosen proficiency and works out which unit teaches. The client never says who
 * teaches.
 */
async function train(context, services) {
  const intent = normalizeTrainingIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getSocialSnapshot(intent);
  if (!snapshot) return pairUnavailable(services, intent);
  if (!holdsReach(context, snapshot)) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const planned = planTraining(snapshot, intent);
  if (!planned.ok) return refuse(planned.code, planned.data);
  return performTogether(context, services, snapshot, {
    endEvent: DOWNTIME_PRESENTATION_EVENTS.TRAIN_END, detail: 'train'
  }, activity => spar(activity, services, snapshot, planned.plan));
}

/**
 * Refuse a pair that can no longer be read (a token removed mid-request), naming whichever units can still be found
 * (FoundryDowntimeRepository.getPairNames). `pair` marks the notice as the pair's rather than a station's, and a
 * unit that is gone leaves its name empty.
 */
async function pairUnavailable(services, intent) {
  const { actorName, partnerName } = await services.downtime.getPairNames(intent);
  return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE, { pair: true, actorName, partnerName });
}

/* -------------------------------------------- */
/*  Recipe library                              */
/* -------------------------------------------- */
/** Replace the world's recipe library with what the GM's editor holds, normalised on the way in. */
async function saveRecipeLibrary(context, services) {
  const intent = normalizeRecipeLibraryIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const recipes = intent.recipes.map(entry => ({ ...entry, id: String(entry.id ?? '') }));
  const saved = await services.downtime.saveRecipeLibrary(normalizeRecipes(recipes).map((recipe, index) => ({
    ...recipe, id: recipe.id || recipes[index].id || `recipe-${index}`
  })));
  if (saved?.ok !== true) return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED, { reasonCode: saved?.code ?? '' });
  return accept(RESULT_CODES.DOWNTIME_RECIPE_LIBRARY_SAVED, { count: saved.count });
}

/**
 * At startup, point each ingredient in the world's recipe file at the Resource item of the same name, refreshing
 * its UUID and image (FoundryDowntimeRepository.repairRecipeLibraryArt).
 */
async function repairRecipeLibrary(services) {
  const repaired = await services.downtime.repairRecipeLibraryArt();
  return accept(RESULT_CODES.DOWNTIME_RECIPE_LIBRARY_REPAIRED, { repaired: Number(repaired) || 0 });
}

/* -------------------------------------------- */
/*  Song library                                */
/* -------------------------------------------- */
/**
 * Replace the world's song library with what the GM's editor holds, normalised on the way in.
 * FoundryDowntimeRepository.saveSongLibrary stores the built-in songs missing from the list as removals, the same
 * songs the editor's own `removed` list names.
 */
async function saveSongLibrary(context, services) {
  const intent = normalizeSongLibraryIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const saved = await services.downtime.saveSongLibrary(normalizeSongs(intent.songs));
  if (saved?.ok !== true) return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED, { reasonCode: saved?.code ?? '' });
  return accept(RESULT_CODES.DOWNTIME_SONG_LIBRARY_SAVED, { count: saved.count });
}

/**
 * At startup, drop entries from the world's song file that the shipped songbook makes unnecessary
 * (FoundryDowntimeRepository.repairSongLibrary).
 */
async function repairSongLibrary(services) {
  const repaired = await services.downtime.repairSongLibrary();
  return accept(RESULT_CODES.DOWNTIME_SONG_LIBRARY_REPAIRED, { repaired: Number(repaired) || 0 });
}

/* -------------------------------------------- */
/*  GM tools                                    */
/* -------------------------------------------- */
/**
 * Hand one unit its downtime back, from the exploration roster's context menu in
 * ui/apps/foundry/combat-tracker.mjs: Energy back to full and its chosen activity cleared, exactly what opening free
 * exploration gives every unit. The unit may then pick a new activity.
 */
async function resetActivity(context, services) {
  const intent = normalizeDowntimeUnitIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const unit = await services.downtime.getUnitState(intent.actorUuid);
  if (!unit) return refuse(RESULT_CODES.DOWNTIME_UNIT_MISSING);
  if (!downtimeResetAvailable(unit)) return refuse(RESULT_CODES.DOWNTIME_NOTHING_TO_RESET, { actorName: unit.name });
  if (!await services.downtime.resetUnitDowntime(intent.actorUuid, planDowntimeReset(unit), context.operation)) {
    return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED);
  }
  return accept(RESULT_CODES.DOWNTIME_ACTIVITY_RESET, { actorName: unit.name });
}

/**
 * Give a crafter part-way through its activity some of its spent Energy back, without clearing the activity, so it
 * can carry on. Only a unit doing an Energy activity that has already spent some Energy can get any back.
 */
async function restoreEnergy(context, services) {
  const intent = normalizeEnergyRestoreIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const unit = await services.downtime.getUnitState(intent.actorUuid);
  if (!unit) return refuse(RESULT_CODES.DOWNTIME_UNIT_MISSING);
  const plan = energyRestoreAvailable(unit) ? planEnergyRestore({ ...unit, amount: intent.amount }) : null;
  if (!plan) return refuse(RESULT_CODES.DOWNTIME_ENERGY_NOT_RESTORABLE, { actorName: unit.name });
  if (!await services.downtime.restoreUnitEnergy(intent.actorUuid, plan, context.operation)) {
    return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED);
  }
  return accept(RESULT_CODES.DOWNTIME_ENERGY_RESTORED, {
    actorName: unit.name, restored: plan.restored, energy: plan.energy, energyMax: unit.energyMax
  });
}

/**
 * The GM's Reset Downtime button on the exploration tracker: every party unit on the map gets its Downtime Action
 * and full Energy back, every downtime buff comes off so the party may eat and hear a song again, every
 * Stationary's factions may be requisitioned again, and every Vendor on the map forgets its haggles. A table with
 * nothing to reset writes nothing. Only this command clears haggles: Reset Downtime Activity and opening free
 * exploration leave them.
 */
async function resetDowntime(context, services) {
  const intent = normalizeDowntimeResetIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.DOWNTIME_INPUT_INVALID);
  const snapshot = await services.downtime.getDowntimeResetSnapshot(intent.sceneUuid);
  if (!snapshot) return refuse(RESULT_CODES.SCENE_NOT_FOUND);
  const plan = planTableReset(snapshot);
  const reached = [...plan.units, ...plan.buffs, ...plan.stations, ...plan.vendors]
    .map(entry => `actor:${entry.actorUuid}`);
  if (!holdsResources(context, [...new Set(reached)])) return refuse(RESULT_CODES.DOWNTIME_STALE);
  const reset = await services.downtime.resetDowntime(plan, context);
  if (reset?.ok !== true) {
    return refuse(RESULT_CODES.DOWNTIME_SETTLEMENT_FAILED, { reasonCode: reset?.code ?? '' });
  }
  return accept(RESULT_CODES.DOWNTIME_RESET_DONE, {
    units: reset.data.units, buffs: reset.data.buffs, stations: reset.data.stations, haggles: reset.data.haggles
  });
}

/**
 * The writes one Reset Downtime makes: each party unit not already at full Energy with no activity chosen gets what
 * free exploration hands out (planDowntimeReset), every unit holding downtime buffs loses them, each Stationary
 * with a requisitioned faction gets its factions unlocked (planFactionReset), and each Vendor with haggles has them
 * cleared, with its count of haggles for the total the reset reports.
 */
function planTableReset(snapshot) {
  const units = (snapshot.units ?? []).flatMap(unit => {
    const reset = planDowntimeReset(unit);
    const held = downtimeCommitment(unit.commitment);
    const fresh = reset.energy === unit.energy && !held.lane && !held.action && !held.exhausted;
    return fresh ? [] : [{
      actorUuid: unit.actorUuid, name: unit.name, energy: reset.energy, commitment: reset.commitment
    }];
  });
  const stations = (snapshot.stations ?? []).filter(station => station.factions.some(row => row.requisitioned))
    .map(station => ({
      actorUuid: station.actorUuid, name: station.name, factions: planFactionReset(station.factions)
    }));
  const vendors = (snapshot.vendors ?? []).filter(vendor => vendor.haggles > 0)
    .map(vendor => ({ actorUuid: vendor.actorUuid, name: vendor.name, haggles: vendor.haggles }));
  return { units, buffs: [...(snapshot.carriers ?? [])], stations, vendors };
}

/* -------------------------------------------- */
/*  Resource keys                               */
/* -------------------------------------------- */
/**
 * Record every actor this activity may write (`writableActorUuids`) in the command's resource keys. The keys lock
 * nothing; this fails only for a malformed key or a command that has already finished (holdsResources in
 * engine/dispatcher.mjs).
 */
function holdsReach(context, snapshot) {
  return holdsResources(context, (snapshot.writableActorUuids ?? []).map(actorUuid => `actor:${actorUuid}`));
}

/* -------------------------------------------- */
/*  Running an activity                         */
/* -------------------------------------------- */
/**
 * Move the performer to the station (FoundryDowntimeRepository.stagePerformer), do the activity, then move the
 * performer back and close the movement plan of the unit that started the visit. If the activity fails, the undo
 * puts both tokens back; only a finished activity moves them back here.
 */
async function performAtStation(context, services, snapshot, performer, { staged, endEvent, detail }, work) {
  let staging = null;
  let outcome;
  let stagingSettled = true;
  let standingSettled = false;
  try {
    if (staged) {
      staging = await services.downtime.stagePerformer(snapshot, performer, context.operation);
      if (!staging) throw new Error('downtime.staging-failed');
      await services.wait(GATHERING_TIMING.stageHold);
    }
    outcome = await work(context);
  } catch (error) {
    outcome = await activityFailure(services, endEvent, detail, error);
  }
  if (outcome.ok !== true) return outcome;
  if (staging) {
    await services.wait(GATHERING_TIMING.stageHold);
    stagingSettled = await unstage(services, staging, context.operation);
  }
  standingSettled = await settleCursorStanding(services, snapshot, detail, context.operation);
  return accept(outcome.code, { ...outcome.data, standingSettled, stagingSettled });
}

/**
 * performAtStation without a station, for socializing and training, where both units stay where they stand.
 * Closing the starting unit's plan is part of the same command, so it is undone with the activity.
 */
async function performTogether(context, services, snapshot, { endEvent, detail }, work) {
  let outcome;
  try {
    outcome = await work(context);
  } catch (error) {
    outcome = await activityFailure(services, endEvent, detail, error);
  }
  if (outcome.ok !== true) return outcome;
  const standingSettled = await settleCursorStanding(services, snapshot, detail, context.operation);
  return accept(outcome.code, { ...outcome.data, standingSettled });
}

/** Record an activity that threw, close its banner dimmed on every client, and refuse so every change is undone. */
async function activityFailure(services, endEvent, detail, error) {
  recordDiagnostic(services.diagnostics, {
    sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.DOWNTIME, error, detail
  });
  await presentSafely(services, downtimePresentationMessage(endEvent, { success: false }));
  return refuse(RESULT_CODES.DOWNTIME_ACTIVITY_FAILED);
}

async function unstage(services, staging, operation) {
  try {
    if (await services.downtime.unstagePerformer(staging, operation) === true) return true;
    recordAbsorbed(services, new Error('downtime.staging-return-incomplete'), 'unstage', DIAGNOSTIC_SOURCES.DOWNTIME);
  } catch (error) {
    recordAbsorbed(services, error, 'unstage', DIAGNOSTIC_SOURCES.DOWNTIME);
  }
  return false;
}

/**
 * Close the starting unit's movement plan where it stands (FoundryDowntimeRepository.settleStanding). A failure
 * is recorded but doesn't undo the finished activity.
 */
async function settleCursorStanding(services, snapshot, detail, operation) {
  try {
    if (await services.downtime.settleStanding(snapshot, operation) === true) return true;
    recordAbsorbed(services, new Error('downtime.turn-settlement-failed'), detail, DIAGNOSTIC_SOURCES.DOWNTIME);
  } catch (error) {
    recordAbsorbed(services, error, detail, DIAGNOSTIC_SOURCES.DOWNTIME);
  }
  return false;
}

/* -------------------------------------------- */
/*  Downtime queries                            */
/* -------------------------------------------- */
/** Supply read-only station menus through the downtime API in api/facade.mjs. */
export function createDowntimeQueries({ downtime }) {
  return Object.freeze({
    async inspectGathering(intent = {}) {
      const normalized = stationIntent(intent);
      if (!normalized) return null;
      const snapshot = await downtime.getGatheringSnapshot(normalized);
      if (!snapshot) return null;
      return gatheringView(snapshot);
    },
    async inspectCrafting(intent = {}) {
      const normalized = stationIntent(intent);
      if (!normalized) return null;
      const snapshot = await downtime.getCraftingSnapshot(normalized);
      if (!snapshot) return null;
      return craftingView(snapshot);
    },
    async inspectCooking(intent = {}) {
      const normalized = stationIntent(intent);
      if (!normalized) return null;
      const snapshot = await downtime.getCookingSnapshot(normalized);
      if (!snapshot) return null;
      return cookingView(snapshot);
    },
    async inspectRecipeLibrary() {
      const snapshot = await downtime.getRecipeLibrarySnapshot();
      if (!snapshot) return null;
      return Object.freeze({
        canEdit: snapshot.canEdit === true,
        recipes: Object.freeze(snapshot.recipes.map(recipe => structuredClone(recipe))),
        builtins: Object.freeze(snapshot.builtins.map(recipe => structuredClone(recipe))),
        missingBuiltinIds: Object.freeze(missingBuiltins(snapshot.recipes, snapshot.builtins).map(recipe => recipe.id))
      });
    },
    async inspectPerformance(intent = {}) {
      const normalized = stationIntent(intent);
      if (!normalized) return null;
      const snapshot = await downtime.getPerformanceSnapshot(normalized);
      if (!snapshot) return null;
      return performanceView(snapshot);
    },
    async inspectRequisition(intent = {}) {
      const normalized = stationIntent(intent);
      if (!normalized) return null;
      const snapshot = await downtime.getRequisitionSnapshot(normalized);
      if (!snapshot) return null;
      return requisitionView(snapshot);
    },
    async inspectSongLibrary() {
      const snapshot = await downtime.getSongLibrarySnapshot();
      if (!snapshot) return null;
      return Object.freeze({
        canEdit: snapshot.canEdit === true,
        songs: Object.freeze(snapshot.songs.map(song => structuredClone(song))),
        builtins: Object.freeze(snapshot.builtins.map(song => structuredClone(song))),
        missingBuiltinIds: Object.freeze(missingBuiltins(snapshot.songs, snapshot.builtins).map(song => song.id)),
        trackOptions: Object.freeze(structuredClone(snapshot.trackOptions ?? { playlists: [], sounds: [] }))
      });
    },
    async inspectSocial(intent = {}) {
      const normalized = normalizeSocialIntent({
        cursorTokenUuid: intent.cursorTokenUuid, partnerTokenUuid: intent.partnerTokenUuid
      });
      if (!normalized) return null;
      const snapshot = await downtime.getSocialSnapshot(normalized);
      if (!snapshot) return null;
      return socialView(snapshot);
    }
  });
}

function stationIntent(intent) {
  return normalizeStationIntent({ cursorTokenUuid: intent.cursorTokenUuid, stationTokenUuid: intent.stationTokenUuid });
}

/**
 * The refusal a station menu reports first: outside free exploration, then out of reach of the unit that started
 * the visit. A view may add its own after these.
 */
function stationRefusal(snapshot) {
  if (snapshot.exploring !== true) return RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED;
  return snapshot.inReach !== true ? RESULT_CODES.DOWNTIME_OUT_OF_REACH : '';
}

/**
 * The roster's performer rows for one kind of activity, Energy or Downtime Action (resolveParticipants in
 * game/downtime/rules.mjs). Outside free exploration every row is blocked, so a menu rebuilt after exploration ends
 * offers nobody to begin with.
 */
function stationParticipants(snapshot, roster, lane) {
  const rows = resolveParticipants(roster, lane);
  if (snapshot.exploring === true) return rows;
  return Object.freeze(rows.map(entry => Object.freeze({ ...entry, eligible: false, blocked: EXPLORATION_BLOCK })));
}

function viewHead(snapshot, refusal) {
  return {
    refusal,
    refusalData: Object.freeze({ actorName: snapshot.cursor.name, stationName: snapshot.station.name }),
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    cursorActorUuid: snapshot.cursor.actorUuid,
    stationTokenUuid: snapshot.station.tokenUuid,
    exploring: snapshot.exploring === true,
    convoyName: snapshot.convoy?.name ?? ''
  };
}

function performerRow(entry, snapshot) {
  return {
    actorUuid: entry.actorUuid,
    name: entry.name,
    image: entry.image,
    avatarScale: entry.avatarScale,
    eligible: entry.eligible,
    blocked: entry.blocked,
    energy: entry.energy.value,
    energyMax: entry.energy.max,
    isCursor: entry.actorUuid === snapshot.cursor.actorUuid
  };
}

function gatheringView(snapshot) {
  const gathering = snapshot.station.gathering;
  const cost = GATHERING_ENERGY_COST;
  const skillKey = gatheringSkillKey(gathering.skill);
  const skill = SKILL_BY_KEY[skillKey] ?? null;
  const participants = stationParticipants(snapshot, leadRoster(snapshot.roster, snapshot.cursor.actorUuid),
    { lane: DOWNTIME_LANES.ENERGY, energyCost: cost });
  const stock = nodeStock(gathering.items);
  const refusal = stationRefusal(snapshot) || (!stock.length ? RESULT_CODES.DOWNTIME_NODE_EXHAUSTED : '');
  return Object.freeze({
    ...viewHead(snapshot, refusal),
    node: Object.freeze({
      name: snapshot.station.name,
      image: snapshot.station.image,
      description: gathering.description,
      skillKey,
      skillLabel: skill?.label ?? gathering.skill,
      energyCost: cost,
      multiplier: gatheringMultiplier(gathering),
      method: gatheringMethod(gathering.animType)
    }),
    performers: Object.freeze(participants.map(entry => {
      const check = skillCheckFor(entry, skillKey);
      return Object.freeze({
        ...performerRow(entry, snapshot),
        skillDie: check ? skillRankLabel(check.rank) : '',
        skillBonus: check?.statBonus ?? 0
      });
    })),
    gatherables: Object.freeze(gathering.items.filter(gatherableEntry).map(entry => Object.freeze({
      name: entry.hidden ? '???' : (entry.name || '(unset)'),
      image: entry.hidden ? '' : entry.img,
      hidden: entry.hidden,
      total: Math.floor(entry.total)
    })))
  });
}

/**
 * The crafting view: the station's kind, every copy in anyone's reach with its forge terms and tier previews, every
 * recipe the world offers, and each performer with what it can spend, the pocket room a brewed copy needs and how it
 * rolls every skill in play.
 */
function craftingView(snapshot) {
  const kind = craftingKind(snapshot.station.objectType);
  const facts = { stacks: snapshot.stacks ?? {}, convoyUuid: snapshot.convoy?.uuid ?? '' };
  const participants = stationParticipants(snapshot, leadRoster(snapshot.roster, snapshot.cursor.actorUuid),
    { lane: DOWNTIME_LANES.ENERGY, energyCost: CRAFTING_ENERGY_COST });
  const items = (snapshot.items ?? []).map(item => {
    const state = forgeState(item.source);
    return Object.freeze({
      itemUuid: item.itemUuid,
      ownerUuid: item.ownerUuid,
      ownerLabel: item.ownerLabel,
      name: item.name,
      image: item.image,
      kind: forgeableKind(item.itemType),
      tier: state.tier,
      usesCurrent: state.usesCurrent,
      usesMax: state.usesMax,
      atFull: state.atFull,
      skillKey: state.skillKey,
      skillLabel: skillLabel(state.skillKey, DEFAULT_FORGE_SKILL),
      forgeMult: state.forgeMult,
      materials: state.materials.map(entry => Object.freeze({ name: entry.name, image: entry.img ?? '', quantity: entry.quantity })),
      forgingXP: state.forgingXP,
      description: String(item.source?.description ?? ''),
      tiers: forgeTierPreviews(item.source)
    });
  });
  const recipes = (snapshot.recipes ?? []).map(recipe => {
    const skillKey = craftingSkillKey(recipe.creation?.skillCheck, DEFAULT_BREW_SKILL);
    return Object.freeze({
      uuid: recipe.uuid,
      name: recipe.name,
      image: recipe.image,
      itemType: recipe.itemType,
      skillKey,
      skillLabel: skillLabel(skillKey, DEFAULT_BREW_SKILL),
      dc: Math.max(0, Number(recipe.creation?.difficultyClass) || 0),
      materials: (recipe.creation?.materials ?? []).map(entry => Object.freeze({ name: entry.name, image: entry.img ?? '', quantity: entry.quantity })),
      description: recipe.description ?? '',
      source: recipe.source ?? ''
    });
  });
  const skillKeys = new Set([
    ...items.map(item => item.skillKey), ...recipes.map(recipe => recipe.skillKey),
    DEFAULT_FORGE_SKILL.toLowerCase(), DEFAULT_BREW_SKILL.toLowerCase()
  ]);
  return Object.freeze({
    ...viewHead(snapshot, stationRefusal(snapshot)),
    kind,
    station: Object.freeze({ name: snapshot.station.name, image: snapshot.station.image, objectType: snapshot.station.objectType }),
    energyCost: CRAFTING_ENERGY_COST,
    critMargin: CRAFT_CRIT_MARGIN,
    performers: Object.freeze(participants.map(entry => Object.freeze({
      ...performerRow(entry, snapshot),
      pocketCount: entry.pocketCount,
      pocketLimit: entry.pocketLimit,
      reach: reachOwners(facts, entry),
      supplies: supplyTotals(reachableStacks(facts, entry)),
      onHand: supplyRows(reachableStacks(facts, entry)),
      checks: Object.freeze(Object.fromEntries([...skillKeys].map(key => {
        const check = skillCheckFor(entry, key);
        return [key, Object.freeze({ die: skillRankLabel(check.rank), bonus: check.statBonus ?? 0 })];
      })))
    }))),
    items: Object.freeze(items),
    recipes: Object.freeze(recipes)
  });
}

function skillLabel(skillKey, fallback) {
  return SKILL_BY_KEY[skillKey]?.label ?? fallback;
}

/**
 * The cooking view: the pot, everyone who could cook with why they cannot (a fed unit cannot cook twice), everyone
 * who could eat with the meal they already carry, the recipes each chef knows, and what each chef can reach.
 */
function cookingView(snapshot) {
  const facts = { stacks: snapshot.stacks ?? {}, convoyUuid: snapshot.convoy?.uuid ?? '' };
  const skillKey = COOK_SKILL.toLowerCase();
  const participants = stationParticipants(snapshot, leadRoster(snapshot.roster, snapshot.cursor.actorUuid),
    { lane: DOWNTIME_LANES.ACTION });
  const library = snapshot.library ?? [];
  return Object.freeze({
    ...viewHead(snapshot, stationRefusal(snapshot)),
    station: Object.freeze({ name: snapshot.station.name, image: snapshot.station.image, objectType: snapshot.station.objectType }),
    skillKey,
    skillLabel: SKILL_BY_KEY[skillKey]?.label ?? COOK_SKILL,
    specialMargin: SPECIAL_MARGIN,
    performers: Object.freeze(participants.map(entry => {
      const fed = Boolean(entry.mealName);
      const stacks = reachableStacks(facts, entry);
      const check = skillCheckFor(entry, skillKey);
      return Object.freeze({
        ...performerRow(entry, snapshot),
        eligible: entry.eligible && !fed,
        blocked: entry.eligible && fed ? 'Already fed' : entry.blocked,
        mealName: entry.mealName ?? '',
        defeated: Boolean(defeatedBlock(entry)),
        skillDie: skillRankLabel(check.rank),
        skillBonus: check.statBonus ?? 0,
        recipeIds: Object.freeze(recipesForChef(library, entry.recipeIds).map(recipe => recipe.id)),
        supplies: supplyTotals(stacks),
        foods: Object.freeze(stacks.filter(stack => stack.foodType).map(stack => Object.freeze({
          ownerUuid: stack.ownerUuid, itemId: stack.itemId, name: stack.name, img: stack.img, amount: stack.amount, foodType: stack.foodType
        })))
      });
    })),
    recipes: Object.freeze(library.map(recipe => Object.freeze(structuredClone(recipe))))
  });
}

/**
 * The performance view that ui/apps/menus/performance-app.mjs reads. It lists the Instrument, and every unit that
 * could lead with the songs it knows or why it can't (a unit an earlier performance affected can't perform again
 * before the party rests). Every party unit is a possible accompaniment whatever activity it chose, unless a
 * performance affected it or it is down at 0 HP. The audience is the party with the performance each carries.
 * The song library comes with the details of every track it links.
 */
function performanceView(snapshot) {
  const skillKey = PERFORMANCE_SKILL_KEY;
  const library = snapshot.library ?? [];
  const roster = leadRoster(snapshot.roster, snapshot.cursor.actorUuid);
  const leads = stationParticipants(snapshot, roster, { lane: DOWNTIME_LANES.ACTION });
  const rolls = entry => {
    const check = skillCheckFor(entry, skillKey);
    return { skillDie: skillRankLabel(check.rank), skillBonus: check.statBonus ?? 0 };
  };
  return Object.freeze({
    ...viewHead(snapshot, stationRefusal(snapshot)),
    station: Object.freeze({
      name: snapshot.station.name, image: snapshot.station.image, objectType: snapshot.station.objectType
    }),
    skillKey,
    skillLabel: SKILL_BY_KEY[skillKey]?.label ?? 'Performance',
    performers: Object.freeze(leads.map(entry => Object.freeze({
      ...performerRow(entry, snapshot),
      eligible: entry.eligible && !entry.performanceMark,
      blocked: performanceBlock(entry.performanceMark) || entry.blocked,
      performanceMark: entry.performanceMark ?? '',
      ...rolls(entry),
      songIds: Object.freeze(songsForPerformer(library, entry.songIds).map(song => song.id))
    }))),
    accompaniments: Object.freeze(roster.map(entry => Object.freeze({
      ...performerRow(entry, snapshot),
      eligible: !entry.performanceMark && !defeatedBlock(entry),
      blocked: performanceBlock(entry.performanceMark) || defeatedBlock(entry),
      performanceMark: entry.performanceMark ?? '',
      ...rolls(entry)
    }))),
    audience: Object.freeze(roster.filter(entry => !defeatedBlock(entry)).map(entry => Object.freeze({
      actorUuid: entry.actorUuid,
      name: entry.name,
      image: entry.image,
      avatarScale: entry.avatarScale,
      performanceMark: entry.performanceMark ?? ''
    }))),
    songs: Object.freeze(library.map(song => Object.freeze(structuredClone(song)))),
    tracks: Object.freeze({ ...(snapshot.tracks ?? {}) })
  });
}

/**
 * The requisition view that ui/apps/menus/requisition-app.mjs reads. It lists the Stationary, and every unit that
 * could requisition with how it rolls Civics and its Convoy, or why it can't (a unit linked to no Convoy has
 * nowhere to send the gold). It also lists the station's enabled factions with each one's base difficulty and
 * wealth cap (null when uncapped), every request kind with whether it is available yet, and the demand's bounds.
 */
function requisitionView(snapshot) {
  const skillKey = REQUISITION_SKILL_KEY;
  const convoys = snapshot.convoys ?? {};
  const roster = leadRoster(snapshot.roster, snapshot.cursor.actorUuid);
  const requisitioners = stationParticipants(snapshot, roster, { lane: DOWNTIME_LANES.ACTION });
  return Object.freeze({
    ...viewHead(snapshot, stationRefusal(snapshot)),
    station: Object.freeze({
      name: snapshot.station.name, image: snapshot.station.image, objectType: snapshot.station.objectType
    }),
    skillKey,
    skillLabel: skillLabel(skillKey, 'Civics'),
    performers: Object.freeze(requisitioners.map(entry => {
      const convoy = entry.convoyUuid && Object.hasOwn(convoys, entry.convoyUuid) ? convoys[entry.convoyUuid] : null;
      const blocked = entry.blocked || (convoy ? '' : 'No convoy linked');
      const check = skillCheckFor(entry, skillKey);
      return Object.freeze({
        ...performerRow(entry, snapshot),
        eligible: !blocked,
        blocked,
        skillDie: skillRankLabel(check.rank),
        skillBonus: check.statBonus ?? 0,
        convoy: convoy ? Object.freeze({ uuid: String(convoy.uuid), name: String(convoy.name ?? '') }) : null
      });
    })),
    factions: Object.freeze(normalizeFactions(snapshot.factions).filter(row => row.enabled).map(row => Object.freeze({
      id: row._id,
      name: row.name,
      relation: row.relation,
      wealth: row.wealth,
      enabled: row.enabled,
      requisitioned: row.requisitioned,
      baseDc: requisitionDc(row.relation, 0),
      cap: wealthCap(row.wealth)
    }))),
    kinds: Object.freeze(REQUISITION_KIND_ORDER.map(key => Object.freeze({
      key, label: REQUISITION_KIND_LABELS[key] ?? key, available: REQUISITION_AVAILABLE_KINDS.includes(key)
    }))),
    limits: Object.freeze({
      step: REQUISITION_LIMITS.step, min: REQUISITION_LIMITS.min, maxDemand: REQUISITION_LIMITS.maxDemand
    })
  });
}

/** Why a unit a performance already reached can neither perform nor accompany: empty for an unaffected unit. */
function performanceBlock(mark) {
  if (!mark) return '';
  return mark === PERFORMANCE_PASSIVE_NAMES.UNINSPIRED ? 'Uninspired' : 'Already inspired';
}

/**
 * The social view that ui/apps/menus/social-app.mjs reads: the unit that started the visit and the unit it chose,
 * how each rolls Sociability and Command and whether it still has its Downtime Action, and every proficiency the
 * pair can train with who teaches and the level XP each side would earn. `refusal` comes from planSocialize, so a
 * partner click on the map (ui/controls/interaction.mjs) refuses in the same order the command would.
 */
function socialView(snapshot) {
  const verdict = planSocialize(snapshot);
  const refusal = verdict.ok ? '' : verdict.code;
  const find = uuid => snapshot.roster.find(entry => entry.actorUuid === uuid) ?? null;
  const cursorUnit = find(snapshot.cursor.actorUuid);
  const partnerUnit = find(snapshot.partner.actorUuid);
  const cursor = socialUnitRow(cursorUnit, snapshot.cursor);
  const partner = socialUnitRow(partnerUnit, snapshot.partner);
  const pairable = Boolean(cursorUnit && partnerUnit && cursorUnit.actorUuid !== partnerUnit.actorUuid);
  const training = pairable ? eligibleTraining(partnerUnit, cursorUnit).map(entry => Object.freeze({
    key: entry.key,
    label: entry.label,
    icon: entry.icon,
    trainerUuid: entry.trainer.actorUuid,
    trainerName: entry.trainer.name,
    traineeUuid: entry.trainee.actorUuid,
    traineeName: entry.trainee.name,
    trainerRankLabel: entry.trainerRankLabel,
    traineeRankLabel: entry.traineeRankLabel,
    equal: entry.equal,
    levelExperience: trainingRewardPreview(entry, snapshot.worldExperienceMultiplier)
  })) : [];
  return Object.freeze({
    refusal,
    refusalData: Object.freeze({
      actorName: snapshot.cursor.name, partnerName: snapshot.partner.name, blocked: verdict.data?.blocked ?? ''
    }),
    cursorTokenUuid: snapshot.cursor.tokenUuid,
    cursorActorUuid: snapshot.cursor.actorUuid,
    partnerTokenUuid: snapshot.partner.tokenUuid,
    partnerActorUuid: snapshot.partner.actorUuid,
    exploring: snapshot.exploring === true,
    cursor,
    partner,
    skillLabels: Object.freeze({
      [SOCIAL_SKILL_KEY]: skillLabel(SOCIAL_SKILL_KEY, 'Sociability'),
      [TRAIN_SKILL_KEY]: skillLabel(TRAIN_SKILL_KEY, 'Command')
    }),
    training: Object.freeze(training),
    trainingSupportXp: TRAINING_SUPPORT_XP,
    canSocialize: !refusal,
    canTrain: !refusal && training.length > 0,
    blocked: socialBlock(refusal, snapshot, cursor, partner)
  });
}

/** One unit of the pair as the social menu shows it. A unit outside the party keeps its name but gets no rolls. */
function socialUnitRow(unit, fallback) {
  const blocked = unit ? actionLaneBlock(unit) : 'Not in this party';
  const rolls = key => {
    const check = unit ? skillCheckFor(unit, key) : null;
    return Object.freeze({ skillDie: check ? skillRankLabel(check.rank) : '', skillBonus: check?.statBonus ?? 0 });
  };
  return Object.freeze({
    actorUuid: fallback.actorUuid,
    tokenUuid: fallback.tokenUuid,
    name: unit?.name ?? fallback.name,
    image: unit?.image ?? '',
    avatarScale: unit?.avatarScale ?? 1,
    level: unit?.level ?? 1,
    eligible: !blocked,
    blocked,
    [SOCIAL_SKILL_KEY]: rolls(SOCIAL_SKILL_KEY),
    [TRAIN_SKILL_KEY]: rolls(TRAIN_SKILL_KEY)
  });
}

/** The refusal as the menu's disabled button explains it, empty when the pair may act. */
function socialBlock(refusal, snapshot, cursor, partner) {
  switch (refusal) {
    case '': return '';
    case RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED: return EXPLORATION_BLOCK;
    case RESULT_CODES.DOWNTIME_PARTNER_OUTSIDE_ROSTER: return `${partner.name} is not in this party`;
    case RESULT_CODES.DOWNTIME_SELF_PAIRING: return 'A unit cannot pair with itself';
    case RESULT_CODES.DOWNTIME_OUT_OF_REACH: return `${partner.name} is out of reach`;
    case RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE: return `${cursor.name}: ${cursor.blocked}`;
    case RESULT_CODES.DOWNTIME_PARTNER_INELIGIBLE: return `${partner.name}: ${partner.blocked}`;
    default: return `${snapshot.cursor.name} is not in this party`;
  }
}
