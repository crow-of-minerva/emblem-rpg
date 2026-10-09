/** @layer init */
import { createCharacterCommandContribution } from '../engine/character/commands.mjs';
import { createDoorSightCommandContribution, createModifierCommandContribution } from '../engine/board.mjs';
import { createSupportCommandContribution } from '../engine/support/commands.mjs';
import {
  createEncounterLifecycle,
  createSceneLifecycle,
  createVisionLifecycle
} from '../foundry/hooks/scene.mjs';
import { createRecoveryChatCommands } from '../ui/apps/foundry/chat-commands.mjs';
import {
  WORLD_SCHEMA_STATES,
  stampMigratedWorldSchema,
  stampWorldSchema,
  tokenOutlineColours
} from '../foundry/adapters/services/settings-policy.mjs';
import { migrateWorldContent } from './migrate-world.mjs';
import { projectUserLordUuid } from '../foundry/adapters/projections/parties.mjs';
import { projectCharacterSource } from '../foundry/adapters/projections/characters.mjs';
import {
  createClassCommandContribution,
  createCombatProgressionService,
  createProgressionCommandContribution
} from '../engine/character/progression.mjs';
import { CommandDispatcher } from '../engine/dispatcher.mjs';
import { ExecutionLifecycle } from '../engine/lifecycle.mjs';
import { MaintenanceScheduler } from '../engine/maintenance.mjs';
import { installAuthorityFence } from '../foundry/patches/authority-fence.mjs';
import { createRecoveryCommandContribution } from '../engine/recovery/commands.mjs';
import { OperationRecovery } from '../engine/recovery/operations.mjs';
import { FoundryOperationStore } from '../foundry/adapters/recovery/operation-store.mjs';
import { FoundryDocumentSnapshots } from '../foundry/adapters/recovery/document-snapshots.mjs';
import { createPresentationDelivery } from '../presentation/interface/delivery.mjs';
import { reconcileKarmaLedgerModel } from '../foundry/adapters/dice/karma.mjs';
import { createTimeoutPresenter } from '../presentation/interface/timeout.mjs';
import {
  INVENTORY_CAPACITY_NOTICE_KIND,
  INVENTORY_REFUSAL_PRESENTATION_KIND,
  inventoryCapacityNoticeMessage
} from '../contracts/domains/items.mjs';
import { RESULT_CODES, refuse } from '../contracts/results.mjs';
import { createDevelopmentCommandContribution } from '../engine/development.mjs';
import { createMovementCommandContribution, recoverStaleMovement } from '../engine/movement/commands.mjs';
import { createHealthCommandContribution, StanceBreakService } from '../engine/combat/damage.mjs';
import { createCombatCommandContribution } from '../engine/combat/exchanges/resolution.mjs';
import { createEncounterCommandContribution } from '../engine/combat/encounters/commands.mjs';
import { createObjectiveEndRetries } from '../engine/combat/encounters/objectives.mjs';
import {
  createEncounterNotifier,
  createNotificationHookHandlers,
  createPlatformNotifier,
  presentInventoryCapacityNotice,
  presentInventoryRefusal,
  NOTIFICATION_IDS,
  NotificationService
} from '../presentation/interface/notifications.mjs';
import {
  BannerPresentation, ConversationBanner, WorkBanner, refreshRoundWarning
} from '../presentation/graphics/banners.mjs';
import { deadlineFor } from '../game/combat/objectives.mjs';
import {
  FoundryEncounterProjection,
  encounterUnderway,
  projectEncounterState,
  projectObjectiveBoard
} from '../foundry/adapters/projections/encounters.mjs';
import {
  projectPairOccupancy, projectThreatBoard, projectThreatReach
} from '../foundry/adapters/projections/movement.mjs';
import {
  projectAuraFieldsAt,
  projectAuraFieldsAtMany,
  projectFootprintElevation,
  projectTerrainHazardAt,
  projectTerrainModifiersAt,
  projectUnitBoard
} from '../foundry/adapters/projections/board.mjs';
import { projectTerrainMeasurementBoard } from '../foundry/adapters/projections/terrain.mjs';
import { areFactionsFriendly, areFactionsHostile } from '../game/character/rules.mjs';
import { airborneBeyondMelee } from '../game/targeting/attack-grid.mjs';
import {
  projectEngagementFrom,
  projectFlankingFrom,
  projectItemUsability,
  projectMeasuredMatchup,
  projectSightBlockedFrom,
  projectThreatMatchups,
  projectUnitLoadout
} from '../foundry/adapters/projections/attack-targeting.mjs';
import { createThreatAssessment } from '../engine/combat/threat.mjs';
import { gradeMatchupThreat } from '../game/combat/threat.mjs';
import { ThreatIndicators } from '../presentation/canvas/threat.mjs';
import { topActionWindow } from '../ui/dialogs.mjs';
import {
  BANNER_PRESENTATION_KIND,
  COMBAT_CONTINUATIONS,
  COMBAT_PRESENTATION_KIND,
  EFFECT_OPERATION_PRESENTATION_KIND,
  ENEMY_PHASE_CAMERA_BEATS,
  ENEMY_PHASE_CAMERA_PRESENTATION_KIND,
  PHASE_CAMERA_PRESENTATION_KIND
} from '../contracts/domains/combat.mjs';
import { createItemActivationCommandContribution } from '../engine/items/activation.mjs';
import { createObjectCommandContribution, createObjectQueries } from '../engine/objects/interaction.mjs';
import { FoundryObjectRepository } from '../foundry/adapters/document-writes/objects.mjs';
import { createArmamentReleaseHandlers } from '../foundry/hooks/objects.mjs';
import { FoundryTradeRepository } from '../foundry/adapters/document-writes/economy.mjs';
import { createEconomyCommandContribution, createEconomyQueries } from '../engine/economy/trade.mjs';
import { OBJECT_PRESENTATION_KIND } from '../contracts/domains/objects.mjs';
import { ECONOMY_PRESENTATION_KIND } from '../contracts/domains/economy.mjs';
import { DOWNTIME_PRESENTATION_KIND } from '../contracts/domains/downtime.mjs';
import { createDowntimeCommandContribution, createDowntimeQueries } from '../engine/downtime/commands.mjs';
import { FoundryDowntimeRepository } from '../foundry/adapters/document-writes/downtime.mjs';
import { EffectExecutionService } from '../engine/effects/execution.mjs';
import { createFactionLinkCommandContribution } from '../engine/effects/faction-links.mjs';
import { ItemAuthoringService, PartyService, TerrainAuthoringService } from '../engine/authoring.mjs';

import { TerrainPhaseService, createTerrainImpactPort } from '../engine/terrain/effects.mjs';
import {
  createTerrainReplacementPort,
  FoundryTerrainRepository
} from '../foundry/adapters/document-writes/terrain.mjs';
import { showTerrainSpawnArrival } from '../presentation/canvas/terrain.mjs';
import { TERRAIN_SPAWN_PRESENTATION_KIND } from '../contracts/domains/terrain.mjs';
import { FoundryActorRepository } from '../foundry/adapters/document-writes/characters.mjs';
import { FoundryJournalRepository } from '../foundry/adapters/document-writes/journals.mjs';
import { FoundryCharacterCheckService } from '../foundry/adapters/dice/checks.mjs';
import { FoundryChatOutput, FoundryProgressionChatOutput } from '../foundry/adapters/document-writes/chat-output.mjs';
import { createBoardLifecycle, createThreatHookHandlers } from '../foundry/hooks/board.mjs';
import { createCoinpurseLifecycle } from '../foundry/hooks/economy.mjs';
import { createInnateGrantLifecycle } from '../foundry/hooks/innate-grants.mjs';
import { createFactionLinkLifecycle } from '../foundry/hooks/faction-links.mjs';
import {
  createClassFeatureHookHandlers,
  createEquipmentEffectLifecycle,
  createPlayerCharacterHookHandlers,
  createVoiceApprovalHookHandlers,
  createStanceHookHandlers,
  createSupportHookHandlers
} from '../foundry/hooks/actors.mjs';
import {
  FoundryAudioPlayer,
  FoundryPerformanceMusic,
  FoundryPhaseMusic,
  unitAudioRepository
} from '../foundry/adapters/services/audio.mjs';
import {
  activationExperienceTableReady,
  affinityTableReady,
  ensureWorldJsonFiles,
  recipeLibraryReady,
  songLibraryReady
} from '../foundry/adapters/services/json-files.mjs';

import {
  FoundryCanvasTokenRepository,
  HOST_PAGE_PEERS,
  dataOperatorIdentifier,
  isActiveGm as localUserIsActiveGm,
  localUserFrozenByPause,
  resolveActor,
  worldPaused
} from '../foundry/adapters/services/host.mjs';
import { EVENT_IDS } from '../contracts/events.mjs';
import { FoundryEventPublisher } from '../foundry/adapters/services/committed-events.mjs';
import { FoundryStanceRepository } from '../foundry/adapters/document-writes/stances.mjs';
import {
  configureBg3HudAdapter,
  emitBg3HudAction,
  isBg3LocalUserGm,
  openBg3DocumentSheet,
  openBg3EffectDescription,
  populateBg3Hud,
  showBg3InstantTooltip
} from '../external/bg3-hud/character-hud.mjs';
import { configureEmblemBg3Core } from '../external/bg3-hud/core-runtime.mjs';
import { bg3ItemLocked, projectBg3HudView } from '../external/bg3-hud/document-projection.mjs';

import { FoundryClassFeatureRepository } from '../foundry/adapters/document-writes/class-features.mjs';
import { FoundryItemAuthoringRepository } from '../foundry/adapters/document-writes/items.mjs';
import { FoundryHealthRepository } from '../foundry/adapters/document-writes/health.mjs';
import { FoundryCombatStateRepository } from '../foundry/adapters/projections/combat-exchange.mjs';
import { FoundryCombatSettlementRepository } from '../foundry/adapters/document-writes/combat-settlement.mjs';
import {
  FoundryEffectRepository,
  FoundryItemActivationSettlement,
  revertFactionLink
} from '../foundry/adapters/document-writes/effect-execution.mjs';
import { FoundryEncounterRepository } from '../foundry/adapters/document-writes/encounters.mjs';
import { FoundryRetractionRepository } from '../foundry/adapters/document-writes/retractions.mjs';
import { FoundryDevelopmentRepository } from '../foundry/adapters/document-writes/development.mjs';
import { FoundryItemActivationRepository } from '../foundry/adapters/projections/items.mjs';
import { FoundryMovementRepository } from '../foundry/adapters/document-writes/movement.mjs';
import { FoundryPartyRepository } from '../foundry/adapters/document-writes/parties.mjs';
import { FoundryDoorSightRepository } from '../foundry/adapters/document-writes/vision.mjs';
import { FoundryProgressionRepository } from '../foundry/adapters/document-writes/progression.mjs';
import {
  FoundryGuardBondRepository,
  configureFoundryTokenArt,
  ensureActorTokenArtBaseline,
  faceTokensTowardEachOther,
  fireActorTokenCondition,
  onRefreshTokenArt,
  refreshActorTokenArt,
  revertActorTokenCondition
} from '../foundry/adapters/document-writes/tokens.mjs';
import {
  createFoundryCommandAuthority,
  createFoundryGatewayIdentity,
  projectFoundryUserAuthority
} from '../foundry/adapters/services/authority.mjs';
import { ProcessingBlocker, waitForSettledProcessing } from '../foundry/adapters/services/processing-blocker.mjs';
import { ExecutionAnnouncer } from '../socket/execution-announcer.mjs';
import { installProcessingInputGuards, installProcessingNativeGuards } from '../foundry/patches/processing-input.mjs';
import { FoundryDiagnostics , notifyFoundry } from '../foundry/adapters/services/diagnostics.mjs';
import { SocketlibSystemTransport } from '../external/socketlib/system-transport.mjs';
import {
  playCombatCriticalFlash,
  playDamageCameraShake,
  playExtraLifePulse,
  playStanceBreakImpact,
  playWeaponArtFlourish
} from '../external/sequencer/runtime.mjs';
import { AnimationDispatcher, playDestructionSmoke } from '../external/sequencer/animation-dispatch.mjs';
import { TokenMagicCombatImpacts } from '../external/token-magic-fx/filters.mjs';
import { SYSTEM_VERSION } from '../config/constants.mjs';
import {
  CAMERA_FOLLOW_MARGIN_SETTING,
  CAMERA_FOLLOW_MODE_SETTING,
  CAMERA_FOLLOW_SPEED_SETTING,
  CENTER_CAMERA_ON_SELECT_SETTING,
  CENTER_CAMERA_SPEED_SETTING,
  CINEMATIC_BATTLE_SETTING,
  CINEMATIC_PHASE_CAMERA_SETTING,
  COMBAT_CINEMATIC_ZOOM_SETTING,
  ENEMY_PHASE_CAMERA_ZOOM_SETTING,
  ITEM_CINEMATIC_SETTINGS,
  UI_SOUNDS_SETTING
} from '../config/settings.mjs';
import {
  COMMAND_IDS,
  COMMAND_LANES,
  INTERNAL_COMMAND_IDS,
  commandFrozenByPause
} from '../contracts/commands.mjs';
import {
  COMMAND_TIMING,
  EXECUTION_LIFECYCLE,
  PLAN_DISCONNECT_RELEASE,
  STARTUP_RELEASE_RETRY,
  SYSTEM_ID,
  hostRefusalCode,
  pauseFreezesUser,
  planReleaseDueOnDisconnect,
  recordDiagnostic
} from '../contracts/protocol.mjs';
import {
  AudioDucking,
  AudioService,
  ObjectInteractionPresentation,
  UI_SOUND_TIERS,
  UnitAudioService
} from '../presentation/audio/service.mjs';
import { SOUND_IDS } from '../presentation/audio/sound-database.mjs';
import {
  DowntimePresentation, EconomyOutcomePresentation, renderSkillRankCard
} from '../presentation/interface/chat-cards.mjs';
import { CharacterCheckChatPresenter } from '../presentation/interface/checks.mjs';
import { ProgressionPresentation } from '../presentation/graphics/progression.mjs';
import { HealthPresentation, StanceBreakPresentation } from '../presentation/canvas/unit-feedback.mjs';
import { CombatPresentation } from '../presentation/canvas/combat-exchange.mjs';
import { CombatCinematicPresentation } from '../presentation/camera/cinematic.mjs';
import { CameraLease } from '../presentation/camera/lease.mjs';
import { UnitCameraPresentation } from '../presentation/camera/unit-follow.mjs';
import { CriticalPresentation } from '../presentation/graphics/critical.mjs';
import {
  onCanvasReadyMovementPresentation, onMovementLockSetting
} from '../presentation/canvas/cell-overlays.mjs';
import { TokenArtTransitionCoordinator } from '../presentation/token/art-transitions.mjs';
import {
  animateTokenDodge,
  animateTokenFootstep,
  configureTokenPresentation,
  holdPathfindingIndicator,
  stopTokenFootstepAnimation
} from '../presentation/token/rendering.mjs';
import {
  decorateBg3Cell,
  decorateEmblemBg3Hud,
  configureBg3HudPresentation,
  enforceBg3HudVisibility,
  notifyBg3HudNotice,
  renderEmblemBg3Tooltip
} from '../presentation/interface/bg3-hud.mjs';
import { createPublicFacade } from '../api/facade.mjs';
import { createMeasurementApi } from '../api/measurement.mjs';
import { CommandGateway } from '../socket/gateway.mjs';
import { UnitPresentationGateway } from '../socket/presentation-gateway.mjs';
import { HostPagePresence } from '../socket/host-presence.mjs';
import { openActorControlPanel, refreshActorControlPanelArt } from '../ui/apps/menus/acp-app.mjs';
import { activatePromotionItem, beginPromotionSequence } from '../ui/apps/menus/promote-app.mjs';
import { configureTerrainBuilder } from '../ui/apps/menus/terrain-builder/app.mjs';
import {
  activateHotbarItem,
  configureAttackTargetingControls
} from '../ui/controls/targeting.mjs';
import {
  cancelSuspendedMovement,
  inspectHoveredMovementToken,
  inspectMovementPlan,
  isHeldMovementRepeating,
  resumeMovementAfterTargeting,
  settleMovementAnimation,
  suspendMovementForTargeting
} from '../ui/controls/movement.mjs';
import { EXECUTION_PRESENTATION_KIND } from '../contracts/domains/execution.mjs';
import { DEFEAT_PRESENTATION_KIND, HEALTH_PRESENTATION_KIND, STANCE_BREAK_PRESENTATION_KIND } from '../contracts/domains/damage.mjs';
import { ITEM_ACTIVATION_PRESENTATION_KIND } from '../contracts/domains/items.mjs';
import {
  progressionFeatureNoticeMessage,
  progressionPresentationMessage,
  PROGRESSION_FEATURE_NOTICE_KIND,
  PROGRESSION_PRESENTATION_BEATS,
  PROGRESSION_PRESENTATION_KIND
} from '../contracts/domains/progression.mjs';
import { PromotionPresentation } from '../presentation/graphics/promotion.mjs';
import { playPromotionFlourish } from '../external/sequencer/runtime.mjs';
import { FOOTSTEP_PRESENTATION_KIND } from '../contracts/domains/tokens.mjs';

/* -------------------------------------------- */
/*  System runtime                              */
/* -------------------------------------------- */

/**
 * Movement-lock releases that clear the lock at once instead of first checking that it has gone stale: a GM's
 * timeout, a player who left the game, and the Enemy AI giving up the command lock.
 */
const FORCED_LOCK_RELEASES = new Set(['timeout', 'disconnect', 'segment']);

/** Busy replies the GM's client retries at startup while another command is still running. */
const STARTUP_RETRY_CODES = new Set([RESULT_CODES.RECOVERY_BUSY, RESULT_CODES.COMMAND_EXECUTION_BUSY]);

/** Replies the host retries when releasing a disconnected player's lock: busy, or still starting up. */
const DISCONNECT_RETRY_CODES = new Set([
  RESULT_CODES.RECOVERY_BUSY, RESULT_CODES.COMMAND_EXECUTION_BUSY, RESULT_CODES.RECOVERY_STARTING
]);

/**
 * Run a host command, retrying while another command is running. Recovery commands are refused straight away when
 * busy instead of waiting their turn, so the startup and disconnect lock releases retry here. Each try gets its own
 * request id, because CommandDispatcher returns the first result for a repeated id.
 * @param {object} intent The command and its callbacks.
 * @param {string} intent.label Request-id prefix. Attempt n runs as `<label>:<n>`.
 * @param {{attempts: number, retryMs: number}} intent.bound How many attempts, and the wait between two of them.
 * @param {Function} intent.retryable Whether a result is a busy refusal worth another attempt.
 * @param {Function} intent.run Runs one attempt under the request id it is given.
 * @param {Function} intent.wait Waits between tries, with a timer that keeps working in a background tab.
 * @param {object} intent.diagnostics Receives one diagnostic when the bound runs out.
 * @param {{detail: string, message: string}} intent.exhausted That diagnostic.
 * @param {Function} [intent.stillWanted] Asked before every attempt. False stops without running it.
 * @returns {Promise<object|null>} The first result not worth retrying, the last busy refusal once the bound runs
 *   out, or null when the routine stopped being wanted.
 */
async function retryWhileBusy({ label, bound, retryable, run, wait, diagnostics, exhausted,
  stillWanted = () => true }) {
  let result = null;
  for (let attempt = 1; attempt <= bound.attempts; attempt += 1) {
    if (!stillWanted()) return null;
    result = await run(`${label}:${attempt}`);
    if (!retryable(result)) return result;
    if (attempt < bound.attempts) await wait(bound.retryMs);
  }
  recordDiagnostic(diagnostics, { sourcePath: import.meta.url, detail: exhausted.detail,
    error: new Error(exhausted.message) });
  return result;
}

/**
 * Wire engine, Foundry, socket, UI and presentation services for one runtime. installSystemHooks in init/hooks.mjs
 * builds it during Foundry's init hook and drives its setup, socket and ready steps. It lives as long as the page.
 */
export function createSystemRuntime() {
  /* -------------------------------------------- */
  /*  Delivery, diagnostics and adapter wiring    */
  /* -------------------------------------------- */

  const diagnostics = new FoundryDiagnostics();
  const executionLifecycle = new ExecutionLifecycle();

  const presentationDelivery = createPresentationDelivery();
  /**
   * What game code calls to show something on every client. UnitPresentationGateway sends each message to the other
   * clients and shows it here. The gateway is created further down, so it is looked up when the call runs.
   */
  const broadcastPort = Object.freeze({ diagnostics,
    broadcast: (message, options) => unitPresentation.broadcast(message, options)
  });
  /** Chat cards without a roll source. FoundryChatOutput keeps card order in a module-level queue. */
  const chat = new FoundryChatOutput();
  configureBg3HudAdapter({
    presentation: {
      decorateCell: decorateBg3Cell,
      renderTooltip: renderEmblemBg3Tooltip,
      notify: notifyBg3HudNotice
    },
    activation: {
      activateItem: async (itemUuid, cellId) =>
        await activatePromotionItem(itemUuid) || activateHotbarItem(itemUuid, cellId)
    }
  });
  configureBg3HudPresentation({
    diagnostics,
    emitAction: emitBg3HudAction,
    isLocalGm: isBg3LocalUserGm,
    isItemLocked: bg3ItemLocked,
    openEffect: openBg3EffectDescription,
    openSheet: openBg3DocumentSheet,
    populateHud: populateBg3Hud,
    showInstantTooltip: showBg3InstantTooltip
  });
  const decorateHud = (app, html) =>
    decorateEmblemBg3Hud(app, html, projectBg3HudView(app, { characterSource: projectCharacterSource }));
  configureEmblemBg3Core({ decorateHud, enforceVisibility: enforceBg3HudVisibility });
  configureFoundryTokenArt({
    transitions: new TokenArtTransitionCoordinator({ diagnostics,
      schedule: presentationDelivery.schedule,
      cancelScheduled: presentationDelivery.cancelScheduled,
      wait: presentationDelivery.wait
    })
  });
  configureTokenPresentation({ applyVerticalAdjustment: onRefreshTokenArt, outlineColours: tokenOutlineColours });

  /* -------------------------------------------- */
  /*  Repositories and presenters                 */
  /* -------------------------------------------- */

  const notifications = new NotificationService({ diagnostics });
  const canvasTokens = new FoundryCanvasTokenRepository();
  const actors = new FoundryActorRepository({ diagnostics });
  const events = new FoundryEventPublisher();
  const development = new FoundryDevelopmentRepository();

  const guardBonds = new FoundryGuardBondRepository({ notify: createPlatformNotifier({ diagnostics }) });
  const movements = new FoundryMovementRepository({ guardBonds, diagnostics, wait: presentationDelivery.wait });
  const audio = new AudioService(new FoundryAudioPlayer(), {
    ducking: new AudioDucking({ diagnostics }),
    uiSounds: () => game.settings.get(SYSTEM_ID, UI_SOUNDS_SETTING)
  });
  const health = new FoundryHealthRepository({ tokens: canvasTokens, unitAudio: unitAudioRepository, guardBonds });
  const combatState = new FoundryCombatStateRepository({ health, movements, unitAudio: unitAudioRepository });
  const combatSettlement = new FoundryCombatSettlementRepository({ health, movements });
  const stanceRepository = new FoundryStanceRepository();
  const activationProjection = new FoundryItemActivationRepository({ movements, guardBonds });
  const activationSettlement = new FoundryItemActivationSettlement({ settlement: combatSettlement });
  const encounters = new FoundryEncounterRepository({
    projection: new FoundryEncounterProjection(), guardBonds
  });
  const banners = new BannerPresentation({ audio });
  const objectPresentation = new ObjectInteractionPresentation({
    audio, tokens: canvasTokens, smoke: playDestructionSmoke
  });
  const economyPresentation = new EconomyOutcomePresentation({ audio, chat });
  const objects = new FoundryObjectRepository({ movements });
  const objectQueries = createObjectQueries({ objects });
  const partyRepository = new FoundryPartyRepository();
  const trades = new FoundryTradeRepository({ movements, parties: partyRepository });
  const economyQueries = createEconomyQueries({ trades });
  const downtime = new FoundryDowntimeRepository({ movements, parties: partyRepository });
  const downtimeQueries = createDowntimeQueries({ downtime });
  const downtimePresentation = new DowntimePresentation({
    banner: new WorkBanner({ audio, diagnostics }),
    conversation: new ConversationBanner({ audio, diagnostics }),
    animation: (payload, context, options) => AnimationDispatcher.play(payload, context, options),
    faceTokens: (trainerTokenUuid, traineeTokenUuid) => (gatewayIdentity.localUserIsActiveGm()
      ? faceTokensTowardEachOther(trainerTokenUuid, traineeTokenUuid) : false),
    chat,
    tokens: canvasTokens,
    diagnostics
  });
  const phaseMusic = new FoundryPhaseMusic();
  const performanceMusic = new FoundryPerformanceMusic();
  const checks = new FoundryCharacterCheckService();
  const checkPresentation = new CharacterCheckChatPresenter(new FoundryChatOutput(checks));
  const classFeatures = new FoundryClassFeatureRepository();
  const itemAuthoring = new ItemAuthoringService({ items: new FoundryItemAuthoringRepository() });
  const partyService = new PartyService({ parties: partyRepository });
  configureTerrainBuilder({ terrainAuthoring: new TerrainAuthoringService({
    terrain: () => createTerrainReplacementPort(undefined, diagnostics)
  }) });
  const progression = new FoundryProgressionRepository({ unitAudio: unitAudioRepository });
  const progressionPresentation = new ProgressionPresentation({ diagnostics,
    audio,
    chat: new FoundryProgressionChatOutput({ renderSkillRankUp: renderSkillRankCard }),
    notifications
  });
  const promotionPresentation = new PromotionPresentation({ diagnostics,
    progression: progressionPresentation,
    tokens: canvasTokens,
    flourish: playPromotionFlourish
  });

  /* -------------------------------------------- */
  /*  Execution and command dispatch              */
  /* -------------------------------------------- */

  const processingBlocker = new ProcessingBlocker({ diagnostics, isHost: localUserIsActiveGm });
  const executionAnnouncer = new ExecutionAnnouncer({ diagnostics, wait: presentationDelivery.wait,
    sessionId: () => gatewayIdentity.sessionId(), userName: id => game.users.get(id)?.name ?? '',
    broadcast: broadcastPort.broadcast });
  const executionView = () => ({ blocker: executionAnnouncer.view() });
  const syncProcessing = () => processingBlocker.syncWithHost({ host: () => gateway.host(),
    status: observer => gateway.status(observer), localView: () => executionAnnouncer.view() });
  // The document classes' pre-write checks read this (admitNativeWrite in services/authority.mjs) to refuse other
  // clients' direct edits while the host is running a command.
  for (const name of ['Actor', 'ActorDelta', 'Item', 'ActiveEffect']) {
    CONFIG[name].documentClass.processingBlocker = processingBlocker;
  }
  const authority = createFoundryCommandAuthority();
  /**
   * Refuse a command while startup is unfinished, or while the game is paused for the user who sent it. A command
   * started inside another command skips the check, because its parent already passed it.
   */
  const admitCommand = context => {
    if (context.within) return null;
    if (!executionLifecycle.admits(context.lane)) return refuse(RESULT_CODES.RECOVERY_STARTING);
    const frozen = pauseFreezesUser({ paused: worldPaused(), isGm: authority.isGm(context.userId) });
    if (frozen && commandFrozenByPause(context.commandId)) return refuse(RESULT_CODES.COMMAND_TABLE_PAUSED);
    return null;
  };
  /**
   * Saves a copy of each document a command changes, so a failed or interrupted command can be undone. At startup,
   * completeStartup() below undoes any command the host's last session left unfinished, before commands are accepted.
   * If an undo fails, the GM sees one notice and the console names the documents.
   */
  const documentSnapshots = new FoundryDocumentSnapshots();
  const operations = new OperationRecovery({ diagnostics,
    store: new FoundryOperationStore(),
    snapshots: documentSnapshots,
    notifyGm: () => {
      if (localUserIsActiveGm()) notifications.show(NOTIFICATION_IDS.OPERATION_RESTORE_FAILED);
    }
  });
  const dispatcher = new CommandDispatcher({ diagnostics, operations, executor: localUserIsActiveGm,
    wait: presentationDelivery.wait,
    onExecutionChanged: snapshot => executionAnnouncer.onExecutionChanged(snapshot),
    admission: admitCommand,
    onSettled: released => {
      void maintenance.drain();
      if (released.lane !== COMMAND_LANES.RECOVERY) void encounterHooks.onResourcesReleased();
    },
    segmentBoundary: run => maintenance.drainInto(run),
    segmentTeardown: (intent, run) => releaseSegmentPlan(intent, run)
  });
  const maintenance = new MaintenanceScheduler({ dispatcher,
    userId: () => gatewayIdentity.localUserId(),
    admits: lane => executionLifecycle.admits(lane)
  });
  const registerCommands = definitions => dispatcher.registerContribution(definitions);
  /** Tell a unit's owners when items over its carrying limit were moved to the convoy. */
  const inventoryPort = Object.freeze({ diagnostics,
    presentCapacityMove: (moved, options) => unitPresentation.broadcast(
      inventoryCapacityNoticeMessage(moved), options)
  });
  registerCommands(createCharacterCommandContribution({ diagnostics,
    actors, events, checks, checkPresentation, authority, journals: new FoundryJournalRepository(),
    presentation: inventoryPort
  }));
  registerCommands(createModifierCommandContribution({ actors, authority }));
  registerCommands(createSupportCommandContribution({ actors, authority }));
  registerCommands(createDoorSightCommandContribution({ doors: new FoundryDoorSightRepository(), authority }));

  /* -------------------------------------------- */
  /*  Host protocol                               */
  /* -------------------------------------------- */

  const transport = new SocketlibSystemTransport();
  const gatewayIdentity = createFoundryGatewayIdentity();
  const hostPresence = new HostPagePresence({ transport, identity: gatewayIdentity, sessions: HOST_PAGE_PEERS,
    wait: presentationDelivery.wait, diagnostics, onDuplicateChange: change => onHostPagesChanged(change) });
  const leaveHostPresence = () => hostPresence.dispose();
  const gateway = new CommandGateway({
    dispatcher, transport, identity: gatewayIdentity, diagnostics, operatorIdentifier: dataOperatorIdentifier,
    lifecycle: () => executionLifecycle.state, execution: executionView,
    authorityObserver: () => hostPresence.sync()
  });

  /* -------------------------------------------- */
  /*  Shared command ports and progression        */
  /* -------------------------------------------- */

  const progressionPort = Object.freeze({ diagnostics,
    broadcast: broadcastPort.broadcast,
    presentBuddingTalent: notice => progressionPresentation.presentBuddingTalent(notice),
    createSkillRankUp: outcome => progressionPresentation.createSkillRankUp(outcome),
    presentFeatureChanges: (changes, options) => unitPresentation.broadcast(
      progressionFeatureNoticeMessage(changes), options),
    playPromotionFlourish: tokenUuid => (tokenUuid
      ? unitPresentation.broadcast(progressionPresentationMessage(
        PROGRESSION_PRESENTATION_BEATS.PROMOTION_FLOURISH, { tokenUuid }))
      : false)
  });
  const invokeWithin = (commandId, intent, label, parent = {}) => dispatcher.invokeWithin(
    commandId, intent, gatewayIdentity.localUserId(), `${label}:${foundry.utils.randomID(12)}`, parent
  );
  const effectRepository = new FoundryEffectRepository({
    health,
    movements,
    unitAudio: unitAudioRepository,
    guardBonds,
    crossings: { force: (intent, parent) => invokeWithin(
      INTERNAL_COMMAND_IDS.MOVEMENT.FORCE_CROSSING, intent, 'effect:crossing', parent) },
    wait: presentationDelivery.wait
  });
  registerCommands(createFactionLinkCommandContribution({ factionLinks: { revert: revertFactionLink }, authority }));
  registerCommands(createClassCommandContribution({ diagnostics,
    classFeatures, events, authority, presentation: progressionPort, movements, progression,
    inventory: { diagnostics, toggleEquipment: (intent, parent) => invokeWithin(
      COMMAND_IDS.CHARACTER.INVENTORY.TOGGLE_EQUIPMENT, intent, 'promotion:mount', parent
    ) },
    wait: presentationDelivery.wait
  }));
  registerCommands(createProgressionCommandContribution({
    progression, presentation: progressionPort, events, classFeatures, authority, wait: presentationDelivery.wait
  }));
  /** XP awarding shared by the combat, item-use and downtime commands. It holds no state. */
  const combatProgression = createCombatProgressionService({
    progression, presentation: progressionPort, events, classFeatures, wait: presentationDelivery.wait
  });

  /* -------------------------------------------- */
  /*  Unit presentation                           */
  /* -------------------------------------------- */

  const unitAudio = new UnitAudioService({ diagnostics,
    audio,
    files: unitAudioRepository,
    notifyUnapproved: ({ actorName }) => notifications.show(NOTIFICATION_IDS.ACTOR_CONTROL_WARNING, {
      message: `${actorName}'s voice folder must be approved by a GM in the Actor Control Panel.`
    })
  });
  const stancePresentation = new StanceBreakPresentation({ diagnostics,
    audio,
    impact: playStanceBreakImpact,
    tokens: canvasTokens
  });
  const healthPresentation = new HealthPresentation({ diagnostics,
    tokens: canvasTokens,
    impacts: new TokenMagicCombatImpacts({ tokens: canvasTokens }),
    audio,
    cameraShake: playDamageCameraShake,
    extraLifeEffect: playExtraLifePulse,
    wait: presentationDelivery.wait
  });
  const clientSetting = key => game.settings.get(SYSTEM_ID, key);
  const cameraLease = new CameraLease();
  const cinematic = new CombatCinematicPresentation({ diagnostics,
    tokens: canvasTokens,
    zoom: () => clientSetting(COMBAT_CINEMATIC_ZOOM_SETTING),
    phaseCamera: () => clientSetting(CINEMATIC_PHASE_CAMERA_SETTING) !== false,
    enemyPhaseZoom: () => clientSetting(ENEMY_PHASE_CAMERA_ZOOM_SETTING),
    lease: cameraLease
  });
  const unitCamera = new UnitCameraPresentation({ diagnostics,
    lease: cameraLease,
    settings: Object.freeze({
      centerOnSelect: () => clientSetting(CENTER_CAMERA_ON_SELECT_SETTING) !== false,
      centerSpeed: () => clientSetting(CENTER_CAMERA_SPEED_SETTING),
      followMode: () => clientSetting(CAMERA_FOLLOW_MODE_SETTING) ?? 'edgePan',
      followMargin: () => clientSetting(CAMERA_FOLLOW_MARGIN_SETTING),
      followSpeed: () => clientSetting(CAMERA_FOLLOW_SPEED_SETTING)
    })
  });
  /** Let every client render CombatPresentation, but allow only the active GM to write shared token art and facing. */
  const onActiveGm = write => async (...args) => (gatewayIdentity.localUserIsActiveGm() ? write(...args) : false);
  const combatPresentation = new CombatPresentation({ diagnostics,
    tokens: canvasTokens,
    tokenArt: Object.freeze({
      fireConditional: onActiveGm(fireActorTokenCondition),
      revertConditional: onActiveGm(revertActorTokenCondition),
      ensureBaseline: onActiveGm(ensureActorTokenArtBaseline),
      faceTargets: onActiveGm(faceTokensTowardEachOther)
    }),
    health: healthPresentation,
    audio,
    chat,
    animation: (payload, context, options) => AnimationDispatcher.play(payload, context, options),
    dodge: animateTokenDodge,
    criticalFlash: playCombatCriticalFlash,
    weaponArtFlourish: playWeaponArtFlourish,
    critical: new CriticalPresentation({ diagnostics }),
    cinematic,
    pathfindingIndicator: holdPathfindingIndicator,
    notify: (level, message) => notifyFoundry(import.meta.url, level, message),
    notices: notifications,
    wait: presentationDelivery.wait,
    schedule: presentationDelivery.schedule,
    cancelScheduled: presentationDelivery.cancelScheduled
  });
  const unitPresentation = new UnitPresentationGateway({
    transport,
    identity: gatewayIdentity,
    diagnostics,
    delivery: presentationDelivery,
    onMessage: async message => {
      if (message.kind === INVENTORY_REFUSAL_PRESENTATION_KIND) return presentInventoryRefusal(notifications, message);
      if (message.kind === INVENTORY_CAPACITY_NOTICE_KIND) {
        return presentInventoryCapacityNotice(notifications, message);
      }
      if (message.kind === PROGRESSION_FEATURE_NOTICE_KIND) return progressionPresentation.presentFeatureChanges(message);
      if (message.kind === EXECUTION_PRESENTATION_KIND) return processingBlocker.apply(message);
      if (message.kind === STANCE_BREAK_PRESENTATION_KIND) return stancePresentation.show(message);
      if (message.kind === HEALTH_PRESENTATION_KIND) return healthPresentation.show(message);
      if (message.kind === DEFEAT_PRESENTATION_KIND) return healthPresentation.show(message);
      if (message.kind === BANNER_PRESENTATION_KIND) return banners.show(message);
      if (message.kind === PROGRESSION_PRESENTATION_KIND) {
        return message.beat === PROGRESSION_PRESENTATION_BEATS.PROMOTION_STATS
          || message.beat === PROGRESSION_PRESENTATION_BEATS.PROMOTION_FLOURISH
          ? promotionPresentation.show(message)
          : progressionPresentation.show(message);
      }
      if (message.kind === PHASE_CAMERA_PRESENTATION_KIND) return cinematic.panPhase(message);
      if (message.kind === ENEMY_PHASE_CAMERA_PRESENTATION_KIND) {
        if (message.beat === ENEMY_PHASE_CAMERA_BEATS.BEGIN) {
          return cinematic.beginEnemyPhaseOverview(message.duration);
        }
        if (message.beat === ENEMY_PHASE_CAMERA_BEATS.FOCUS) {
          return cinematic.focusEnemyPhaseUnit(message.tokenUuid, message.duration);
        }
        return cinematic.endEnemyPhaseOverview(message.duration);
      }
      if (message.kind === OBJECT_PRESENTATION_KIND) return objectPresentation.show(message);
      if (message.kind === ECONOMY_PRESENTATION_KIND) return economyPresentation.show(message);
      if (message.kind === DOWNTIME_PRESENTATION_KIND) return downtimePresentation.show(message);
      if (message.kind === TERRAIN_SPAWN_PRESENTATION_KIND) return showTerrainSpawnArrival(message);
      if ([
        COMBAT_PRESENTATION_KIND,
        EFFECT_OPERATION_PRESENTATION_KIND,
        ITEM_ACTIVATION_PRESENTATION_KIND
      ].includes(message.kind)) {
        return combatPresentation.show(message);
      }
      if (message.kind === FOOTSTEP_PRESENTATION_KIND) {
        animateTokenFootstep(unitAudioRepository.tokenPlaceable(message.tokenUuid));
      }
      return unitAudio.playMessage(message, unitAudioRepository.voicePlaybackContext());
    }
  });

  /* -------------------------------------------- */
  /*  Gameplay command contributions              */
  /* -------------------------------------------- */

  const stanceBreaks = new StanceBreakService({ diagnostics,
    stances: stanceRepository,
    events,
    presentation: { show: broadcastPort.broadcast }
  });
  registerCommands(createHealthCommandContribution({
    health,
    presentation: broadcastPort,
    events,
    stanceBreaks,
    objects,
    authority,
    wait: presentationDelivery.wait
  }));
  const effectExecution = new EffectExecutionService({ diagnostics,
    effects: effectRepository,
    notifyGm: notice => {
      if (localUserIsActiveGm()) notifications.show(NOTIFICATION_IDS.EFFECT_STEP_SKIPPED, notice);
    },
    present: broadcastPort.broadcast,
    stances: stanceRepository,
    wait: presentationDelivery.wait
  });
  registerCommands(createCombatCommandContribution({
    combatState,
    wait: presentationDelivery.wait,
    settlement: combatSettlement,
    effects: effectExecution,
    presentation: broadcastPort,
    events,
    stances: stanceRepository,
    objects,
    diagnostics,
    authority,
    progression: combatProgression
  }));
  const skillExperience = Object.freeze({
    grant: (intent, parent) => invokeWithin(COMMAND_IDS.CHARACTER.PROGRESSION.GRANT_SKILL_EXPERIENCE, intent, 'skills', parent)
  });
  const supportExperience = Object.freeze({
    grant: (intent, parent) => invokeWithin(COMMAND_IDS.CHARACTER.SUPPORT.GRANT_XP, intent, 'support', parent)
  });
  registerCommands(createItemActivationCommandContribution({ diagnostics,
    activations: activationProjection,
    settlement: activationSettlement,
    // Taking a retractable use back writes its saved old values through the same service the undo records use.
    retractions: new FoundryRetractionRepository({ snapshots: documentSnapshots }),
    effects: effectExecution,
    checks,
    continuations: { getSnapshot: tokenUuid => combatState.getContinuationSnapshot(tokenUuid) },
    presentation: broadcastPort,
    checkPresentation,
    skills: skillExperience,
    support: supportExperience,
    events,
    movements,
    inventory: { diagnostics, toggleEquipment: (intent, parent) => invokeWithin(
      COMMAND_IDS.CHARACTER.INVENTORY.TOGGLE_EQUIPMENT, intent, 'activation:mount', parent
    ) },
    defeats: health,
    objects,
    authority,
    wait: presentationDelivery.wait,
    progression: combatProgression
  }));
  registerCommands(createObjectCommandContribution({
    objects,
    movements,
    checks,
    checkPresentation,
    skills: skillExperience,
    presentation: broadcastPort,
    events,
    diagnostics,
    authority,
    wait: presentationDelivery.wait
  }));
  registerCommands(createEconomyCommandContribution({
    trades,
    movements,
    checks,
    checkPresentation,
    presentation: broadcastPort,
    skills: skillExperience,
    progression: combatProgression,
    events,
    diagnostics,
    authority,
    random: () => Math.random(),
    wait: presentationDelivery.wait
  }));
  registerCommands(createDowntimeCommandContribution({
    downtime,
    checks,
    checkPresentation,
    skills: skillExperience,
    support: supportExperience,
    music: Object.freeze({ play: uuid => performanceMusic.play(uuid), stop: () => performanceMusic.stop() }),
    progression: combatProgression,
    presentation: broadcastPort,
    events,
    diagnostics,
    authority,
    random: () => Math.random(),
    wait: presentationDelivery.wait
  }));
  const phaseImpacts = createTerrainImpactPort(
    (commandId, intent, resources) => invokeWithin(commandId, intent, `phase:${commandId}`,
      resources?.hold ? { claimResources: keys => resources.hold(keys) } : resources ?? {})
  );
  const terrainRepository = new FoundryTerrainRepository({
    present: broadcastPort.broadcast,
    wait: presentationDelivery.wait
  });
  const terrainPhases = new TerrainPhaseService({
    terrain: terrainRepository,
    impacts: phaseImpacts,
    wait: presentationDelivery.wait
  });
  let objectiveEndSequence = 0;
  /** Numbers each disconnect release, so a player who leaves twice never repeats a request id. */
  let disconnectReleases = 0;
  const objectiveEndRetries = createObjectiveEndRetries({
    wait: presentationDelivery.wait,
    run: sceneUuid => gateway.executeInternal(INTERNAL_COMMAND_IDS.ENCOUNTERS.RESOLVE_OBJECTIVE_END,
      { sceneUuid }, `retry:objective-end:${objectiveEndSequence += 1}`),
    notify: (_level, message) => notifications.show(NOTIFICATION_IDS.ENCOUNTER_OBJECTIVE_WARNING, { message })
  });
  registerCommands(createEncounterCommandContribution({ diagnostics,
    encounters,
    terrain: terrainPhases,
    movements,
    effects: effectExecution,
    dice: { roll: formula => effectRepository.rollFormula(formula) },
    impacts: phaseImpacts,
    defeats: health,
    objects,
    rests: createTerrainImpactPort((commandId, intent, parent) => invokeWithin(commandId, intent, `end-turn:${commandId}`, parent)),
    presentation: broadcastPort.broadcast,
    events,
    notify: (_level, message) => notifications.show(NOTIFICATION_IDS.ENCOUNTER_OBJECTIVE_WARNING, { message }),
    identifier: () => foundry.utils.randomID(20),
    endRetries: objectiveEndRetries,
    continuations: {
      settle: (actorUuid, operation) => combatSettlement.settlePendingContinuation(
        { sourceActorUuid: actorUuid }, { kind: COMBAT_CONTINUATIONS.END_TURN }, operation
      )
    },
    authority,
    wait: presentationDelivery.wait
  }));
  registerCommands(createDevelopmentCommandContribution({ diagnostics,
    development, movements, events, authority, terrain: terrainPhases
  }));
  const timeoutPresenter = createTimeoutPresenter({ chat, diagnostics });
  registerCommands(createRecoveryCommandContribution({
    authority,
    getLock: () => movements.getLock(),
    lockKeys: () => movements.recoveryKeys(),
    republishExecution: () => executionAnnouncer.republish(),
    abandonExecution: () => dispatcher.abandonExecution(),
    /** Reload once the clear-busy reply has been sent, so the next startup can undo the abandoned command. */
    reloadHost: () => foundry.utils.debouncedReload(),
    recoverLock: context => recoverStaleMovement(context, movements,
      { force: FORCED_LOCK_RELEASES.has(String(context.payload?.announcement ?? '')) }),
    announce: async ({ userId, cleared }) => {
      try {
        return Boolean(await timeoutPresenter.announce({ cleared, callerName: game.users.get(userId)?.name ?? 'GM' }));
      } catch (error) {
        recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'timeout-announcement' });
        return false;
      }
    }
  }));

  registerCommands(createMovementCommandContribution({
    movements, events, authority, objects, diagnostics,
    checks,
    checkPresentation,
    skills: skillExperience,
    impacts: createTerrainImpactPort((commandId, intent, parent) => invokeWithin(commandId, intent, `movement:${commandId}`, parent)),
    audio: {
      climb: () => audio.play(SOUND_IDS.MOVEMENT_CLIMB, { volume: 0.8, broadcast: true }),
      error: () => audio.play(SOUND_IDS.UI_ERROR, { ui: UI_SOUND_TIERS.GAME })
    },
    wait: presentationDelivery.wait,
    inventory: { diagnostics, toggleEquipment: (intent, parent) => invokeWithin(
      COMMAND_IDS.CHARACTER.INVENTORY.TOGGLE_EQUIPMENT, intent, 'permissions:dismount', parent
    ) }
  }));

  /* -------------------------------------------- */
  /*  Host routines                               */
  /* -------------------------------------------- */

  /**
   * At startup, the GM's client releases a movement lock left by its last session and finishes each end of turn
   * that never ran. Undoing unfinished commands doesn't cover these. Each runs as its own command, retried while
   * another command is running, so the old lock isn't left held for the whole session.
   */
  async function completeInterruptedTurns() {
    let sequence = 0;
    const sweep = label => ({ label, bound: STARTUP_RELEASE_RETRY, wait: presentationDelivery.wait, diagnostics,
      retryable: result => STARTUP_RETRY_CODES.has(result?.code),
      exhausted: { detail: 'startup-release-busy', message: `startup.release-busy:${label}` } });
    await retryWhileBusy({ ...sweep('startup:stale-lock'),
      run: requestId => gateway.executeInternal(COMMAND_IDS.RECOVERY.CLEAR_LOCK, {}, requestId) });
    for (const pending of encounters.getPendingContinuations()) {
      await retryWhileBusy({ ...sweep(`startup:continuation:${sequence += 1}`),
        run: requestId => gateway.executeInternal(
          INTERNAL_COMMAND_IDS.ENCOUNTERS.FINISH_CONTINUATION, pending, requestId) });
    }
  }

  /**
   * Bring an older world up to this version's schema through migrateWorldContent (init/migrate-world.mjs). Taking
   * the command lock for the run is retried while another command is running.
   */
  function migrateWorld() {
    return migrateWorldContent({ notifications, diagnostics, recordSchema: stampMigratedWorldSchema,
      openSegment: () => retryWhileBusy({ label: 'startup:content-migration', bound: STARTUP_RELEASE_RETRY,
        wait: presentationDelivery.wait, diagnostics, retryable: result => STARTUP_RETRY_CODES.has(result?.code),
        exhausted: { detail: 'startup-migration-busy', message: 'startup.migration-busy' },
        run: () => openExecutionSegment({ label: 'content-migration' }) }) });
  }

  /**
   * When the GM opens or closes a second tab, update which tab runs commands and the busy state. If this is the only
   * GM tab again, undo any command left unfinished, unless an undo is already running or this tab is mid-command.
   */
  function onHostPagesChanged({ duplicated }) {
    gateway.onAuthorityChanged();
    void syncProcessing();
    if (duplicated || hostRestore || !localUserIsActiveGm() || dispatcher.executionHeld()) return;
    hostRestore = operations.restoreUnfinished()
      .catch(error => recordDiagnostic(diagnostics,
        { sourcePath: import.meta.url, error, detail: 'operation-restore' }))
      .finally(() => { hostRestore = null; });
  }

  /**
   * When the Enemy AI (or another holder) gives up the command lock, release the movement lock it took, but only if
   * that lock is still its own and was taken after it began. The release runs as an ordinary `recovery.clear-lock`
   * command, which checks the lock again so it never releases one a player has taken since.
   */
  async function releaseSegmentPlan({ userId = '', since = 0 } = {}, run = null) {
    const lock = movements.getLock();
    if (!lock?.tokenUuid || String(lock.holderId ?? '') !== String(userId ?? '')) return false;
    if (Number(lock.acquiredAt) < Number(since) || typeof run !== 'function') return false;
    const result = await run(COMMAND_IDS.RECOVERY.CLEAR_LOCK, { announcement: 'segment' },
      `segment:release:${userId}:${since}`);
    return result?.data?.cleared === true;
  }

  /**
   * When a player disconnects, the host client releases their movement lock and puts their unit back where its move
   * started. It calls `gateway.executeInternal` rather than the public API, whose busy check would refuse it with a
   * notice on the host's screen. Busy replies are retried quietly while the lock is still the one they held. If the
   * host itself disconnects, its next startup releases the lock instead.
   */
  async function releaseDisconnectedPlan(userId) {
    const id = String(userId ?? '');
    const held = movements.getLock();
    if (!id || !gatewayIdentity.host().localIsHost) return false;
    if (!planReleaseDueOnDisconnect({ lock: held, held, userId: id })) return false;
    const result = await retryWhileBusy({ label: `disconnect:${id}:${disconnectReleases += 1}`,
      bound: PLAN_DISCONNECT_RELEASE, wait: presentationDelivery.wait, diagnostics,
      stillWanted: () => planReleaseDueOnDisconnect({ lock: movements.getLock(), held, userId: id }),
      retryable: outcome => DISCONNECT_RETRY_CODES.has(outcome?.code) && gatewayIdentity.host().localIsHost,
      run: requestId => {
        const unavailable = hostRefusalCode(gatewayIdentity.host());
        return unavailable ? refuse(unavailable)
          : gateway.executeInternal(COMMAND_IDS.RECOVERY.CLEAR_LOCK, { announcement: 'disconnect' }, requestId);
      },
      exhausted: { detail: 'disconnect-release-busy', message: `movement.disconnect-release-busy:${id}` } });
    if (result && !DISCONNECT_RETRY_CODES.has(result.code)) notifications.showResult(result);
    return result?.ok === true && result.data?.cleared === true;
  }

  /**
   * When the page closes or reloads, don't undo a running command from it. A reloading browser keeps running this
   * page's scripts, and the new page would read the world half-undone. The unfinished command stays recorded, and
   * `completeStartup` on the next page undoes it.
   */
  function abandonOperationOnUnload() {
    dispatcher.abandonOperation();
  }

  /** Take the command lock for a run of commands (an execution segment), only on the host client and as its user. */
  function openExecutionSegment({ label = '' } = {}) {
    const host = gatewayIdentity.host();
    if (host.localIsHost) return dispatcher.openSegment({ userId: gatewayIdentity.localUserId(), label });
    return Promise.resolve(refuse(hostRefusalCode(host) || RESULT_CODES.NO_ACTIVE_GM));
  }

  /* -------------------------------------------- */
  /*  Control wiring and hook handlers            */
  /* -------------------------------------------- */

  configureAttackTargetingControls({
    movement: {
      inspect: inspectMovementPlan,
      settle: settleMovementAnimation,
      suspend: suspendMovementForTargeting,
      resume: resumeMovementAfterTargeting,
      cancel: cancelSuspendedMovement
    },
    combat: { snapshot: intent => combatState.getSnapshot(intent) },
    indicator: {
      hold: async (tokenUuid, held) => {
        const token = await canvasTokens.placeable(tokenUuid);
        if (token) holdPathfindingIndicator(token, held);
        return Boolean(token);
      }
    }
  });
  const stanceHooks = createStanceHookHandlers({ stances: stanceBreaks });
  /** Queue follow-up fixes from Foundry hooks to run once no command is running. */
  const submitMaintenance = (commandId, payload) => maintenance.submit(commandId, payload);
  const classHooks = createClassFeatureHookHandlers({ executeInternal: submitMaintenance });
  const equipmentEffectHooks = createEquipmentEffectLifecycle({
    executeInternal: submitMaintenance,
    notify: notifications
  });
  const supportHooks = createSupportHookHandlers({ executeInternal: submitMaintenance });
  const coinpurseHooks = createCoinpurseLifecycle({ executeInternal: submitMaintenance, notify: notifications });
  const innateGrantHooks = createInnateGrantLifecycle({ executeInternal: submitMaintenance, notify: notifications });
  // Read by EmblemActiveEffect._onDeleteOperation, so a faction change ends with the status it is tied to.
  CONFIG.ActiveEffect.documentClass.factionLinks = createFactionLinkLifecycle({
    revertWithin: payload => invokeWithin(INTERNAL_COMMAND_IDS.CHARACTER.FACTION.REVERT_LINK, payload, 'faction-link'),
    executeInternal: submitMaintenance
  });
  const encounterHooks = createEncounterLifecycle({
    executeInternal: submitMaintenance,
    deferring: () => !executionLifecycle.admits(COMMAND_LANES.MAINTENANCE),
    startup: () => executionLifecycle.state !== EXECUTION_LIFECYCLE.READY,
    encounterRunning: sceneUuid => dispatcher.resourcesBusy([`scene:${sceneUuid}`]),
    events,
    notify: createEncounterNotifier({ diagnostics })
  });
  const modifierHooks = createBoardLifecycle({ executeInternal: submitMaintenance });
  const visionHooks = createVisionLifecycle({ executeInternal: submitMaintenance });
  const threatIndicators = new ThreatIndicators({ diagnostics,
    assess: createThreatAssessment({
      board: { projectThreatBoard, projectThreatReach },
      matchups: { projectThreatMatchups },
      diagnostics
    }),
    isBusy: () => processingBlocker.engaged(),
    actionWindowOpen: () => topActionWindow() !== null,
    encounterActive: () => encounterUnderway()
  });
  const threatHooks = createThreatHookHandlers({ threatIndicators });
  const presentationHooks = createNotificationHookHandlers(notifications);
  const paintBoardHoldBanner = () => onMovementLockSetting(
    movements.getLock(), game.user?.id ?? '', encounters.getDrivenHold()
  );
  const movementPresentationHooks = Object.freeze({
    onMovementPresentationReady() {
      onCanvasReadyMovementPresentation(movements.getLock(), game.user?.id ?? '', encounters.getDrivenHold());
    },
    onMovementLockSettingChanged(setting) {
      if (!movements.isLockSetting(setting)) return;
      paintBoardHoldBanner();
    },
    onDrivenHoldSettingChanged(setting) {
      if (!encounters.isDrivenHoldSetting(setting)) return;
      paintBoardHoldBanner();
    }
  });
  const unitPresentationHooks = createUnitPresentationHookHandlers({
    unitAudio,
    unitAudioRepository,
    unitPresentation
  });
  let transportStarted = false;
  /** The undo this tab started on becoming the only GM tab again, so two tab changes can't start overlapping undos. */
  let hostRestore = null;

  /* -------------------------------------------- */
  /*  Public facade                               */
  /* -------------------------------------------- */

  const measurement = createMeasurementApi({
    encounters: Object.freeze({ getState: projectEncounterState, getBoard: projectUnitBoard }),
    combat: Object.freeze({
      measure: projectMeasuredMatchup,
      canEngage: projectEngagementFrom,
      sightBlocked: projectSightBlockedFrom,
      flanking: projectFlankingFrom,
      loadout: projectUnitLoadout,
      canUse: projectItemUsability,
      airborneBeyondMelee
    }),
    movement: Object.freeze({ canPass: projectPairOccupancy }),
    terrain: Object.freeze({
      getBoard: projectTerrainMeasurementBoard,
      modifiersAt: projectTerrainModifiersAt,
      hazardAt: projectTerrainHazardAt,
      elevationAt: projectFootprintElevation,
      auraFieldsAt: projectAuraFieldsAt,
      auraFieldsAtMany: projectAuraFieldsAtMany
    }),
    board: Object.freeze({
      awaitSettled: options => waitForSettledProcessing({ diagnostics, wait: presentationDelivery.wait,
        busy: () => localUserIsActiveGm()
          ? !dispatcher.executionIdle() || (executionAnnouncer.pending() && !dispatcher.executionSnapshot().owner?.segment)
          : processingBlocker.engaged() }, options)
    }),
    factions: Object.freeze({
      hostile: areFactionsHostile,
      friendly: areFactionsFriendly
    })
  });

  const facade = createPublicFacade({
    gateway,
    executionSegments: Object.freeze({ open: intent => openExecutionSegment(intent), wait: presentationDelivery.wait }),
    processing: processingBlocker,
    tableFrozen: localUserFrozenByPause,
    promotions: Object.freeze({
      openPreview: intent => beginPromotionSequence(
        intent?.tokenUuid ?? '', intent?.actorUuid ?? '', intent?.usedItemId ?? '',
        { bypassItem: intent?.bypassItem === true, bypassRequirements: intent?.bypassRequirements === true }
      )
    }),
    objectQueries,
    economyQueries,
    downtimeQueries,
    movements,
    itemAuthoring,
    partyService,
    authority: () => projectFoundryUserAuthority(game.user),
    events,
    audio,
    tokenArt: Object.freeze({
      refreshActorArt: refreshActorTokenArt,
      refreshAuthoringPanel: refreshActorControlPanelArt,
      faceTargets: faceTokensTowardEachOther
    }),
    controlPanel: Object.freeze({ open: openActorControlPanel }),
    presentationCamera: broadcastPort,
    threatIndicators,
    drivenBoard: Object.freeze({
      hold: intent => (dispatcher.executionSnapshot().owner?.segment === true
        ? encounters.holdDrivenBoard(intent, game.user?.id ?? '', game.user?.name ?? '') : Promise.resolve(null)),
      release: () => encounters.releaseDrivenBoard(game.user?.id ?? ''),
      current: () => encounters.getDrivenHold()
    }),
    measurement,
    notifications,
    /** The pure threat rule the Enemy AI scores attacks with, passed in because api/ may not import game/. */
    gradeThreat: gradeMatchupThreat,
    combatCinematicEnabled: () => game.settings.get(SYSTEM_ID, CINEMATIC_BATTLE_SETTING),
    itemCinematicEnabled: category => Boolean(ITEM_CINEMATIC_SETTINGS[category])
      && game.settings.get(SYSTEM_ID, ITEM_CINEMATIC_SETTINGS[category]) !== false,
    currentSceneUuid: () => String(globalThis.canvas?.scene?.uuid ?? '')
  });

  /* -------------------------------------------- */
  /*  Chat commands and actor hook handlers       */
  /* -------------------------------------------- */

  const platformNotifier = createPlatformNotifier({ diagnostics });
  const sceneHooks = createSceneLifecycle({ notify: platformNotifier });
  const playerCharacterHooks = createPlayerCharacterHookHandlers({
    parties: partyRepository, lordUuidFor: projectUserLordUuid, diagnostics
  });
  const voiceApprovalHooks = createVoiceApprovalHookHandlers({
    unitAudioAuthoring: unitAudioRepository, diagnostics
  });
  const recoveryChat = createRecoveryChatCommands({
    api: () => facade.api,
    notify: platformNotifier,
    localUser: () => globalThis.game?.user ?? null,
    diagnostics
  });

  /* -------------------------------------------- */
  /*  Lifecycle steps                             */
  /* -------------------------------------------- */

  function start() {
    game.emblemRpg = facade;
  }

  function setup() {
    /**
     * Start reading the JSON tables (affinities, item-use XP, recipes, songs) early, so they are loaded before a
     * sheet or an item use needs them.
     */
    void affinityTableReady();
    void activationExperienceTableReady();
    void recipeLibraryReady();
    void songLibraryReady();
    hostPresence.sync();
    /** Guard input before Foundry renders its interface: ProcessingBlocker refuses all of it until ready() ends. */
    installProcessingInputGuards({ blocker: processingBlocker, sync: syncProcessing,
      inspectCanvas: inspectHoveredMovementToken });
    globalThis.addEventListener?.('beforeunload', abandonOperationOnUnload);
    globalThis.addEventListener?.('pagehide', abandonOperationOnUnload);
  }

  function socketReady() {
    if (transportStarted || !globalThis.socketlib) return;
    gateway.initializeTransport((message, userId) => unitPresentation.receive(message, userId),
      (message, userId) => hostPresence.receive(message, userId));
    hostPresence.start();
    globalThis.addEventListener?.('pagehide', leaveHostPresence);
    transportStarted = true;
    console.info('Emblem RPG | Authenticated command transport ready');
  }

  /**
   * Run startup, then lift the startup hourglass whatever happens. If startup throws before it reaches READY, this
   * client keeps refusing commands with `recovery.starting`. A failure shows one lasting STARTUP_FAILED notice, and
   * the console names it.
   */
  async function ready() {
    try {
      await completeStartup();
    } catch (error) {
      recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'startup-failed', notify: false });
      notifications.show(NOTIFICATION_IDS.STARTUP_FAILED);
    } finally {
      processingBlocker.finishStartup();
    }
  }

  async function completeStartup() {
    if (globalThis.socketlib) socketReady();
    await hostPresence.settle();
    installProcessingNativeGuards({ blocker: processingBlocker });
    await syncProcessing();
    installAuthorityFence({
      executionHeld: () => dispatcher.executionHeld(),
      isHost: localUserIsActiveGm,
      onFenced: error => recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'authority-fence' })
    });
    await reconcileKarmaLedgerModel().catch(error =>
      recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'karma-ledger-model' }));
    executionLifecycle.advance(EXECUTION_LIFECYCLE.RECOVERING);
    if (localUserIsActiveGm()) {
      await operations.restoreUnfinished().catch(error =>
        recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'operation-restore' }));
    }
    executionLifecycle.advance(EXECUTION_LIFECYCLE.MAINTAINING);
    if (localUserIsActiveGm()) {
      await completeInterruptedTurns().catch(error =>
        recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'startup-interrupted-turns' }));
    }
    void maintenance.drain();
    await encounterHooks.flushDeferred();
    await encounterHooks.reconcileObjectives();
    equipmentEffectHooks.onReady();
    try {
      syncRoundWarning();
    } catch (error) {
      recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'startup-round-warning' });
    }
    syncPhaseMusic();
    modifierHooks.onReady();
    visionHooks.onReadyVision();
    stanceHooks.onReady();
    innateGrantHooks.onReady();
    events.subscribe(EVENT_IDS.ITEM_ACTIVATION_COMMITTED, event => {
      void unitPresentationHooks.onRallyVoice(event);
    });
    if (localUserIsActiveGm()) void encounters.reapDrivenBoard().then(() => paintBoardHoldBanner());
    void ensureWorldJsonFiles().then(() => Promise.all([
      maintenance.submit(INTERNAL_COMMAND_IDS.DOWNTIME.REPAIR_RECIPE_LIBRARY, {}),
      maintenance.submit(INTERNAL_COMMAND_IDS.DOWNTIME.REPAIR_SONG_LIBRARY, {})
    ]));
    void audio.preload(SOUND_IDS.COMBAT_PHASE_PLAYER);
    void audio.preload(SOUND_IDS.COMBAT_PHASE_ENEMY);
    const readyPlayerCharacters = playerCharacterHooks.onReadyPlayerCharacters();
    const schema = stampWorldSchema().catch(error => {
      recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'world-schema' });
      return null;
    });
    await settleStartupMaintenance(readyPlayerCharacters);
    executionLifecycle.advance(EXECUTION_LIFECYCLE.READY);
    const verdict = await schema;
    if (verdict?.state === WORLD_SCHEMA_STATES.AHEAD) platformNotifier.schemaMismatch(verdict);
    if (verdict?.state === WORLD_SCHEMA_STATES.BEHIND && localUserIsActiveGm()) await migrateWorld();
    console.info(`Emblem RPG | ${SYSTEM_VERSION} ready`);
  }

  /** Before accepting commands, wait (up to the reply timeout) for startup fixes and party ownership to finish. */
  async function settleStartupMaintenance(...work) {
    const deadline = presentationDelivery.wait(COMMAND_TIMING.responseMs);
    const settled = Promise.all([maintenance.idle(), ...work.map(task => Promise.resolve(task).catch(() => undefined))]);
    await Promise.race([settled, deadline]);
  }

  function syncPhaseMusic() {
    void phaseMusic.sync(globalThis.canvas?.scene);
  }

  function restorePhaseMusic(combat) {
    void phaseMusic.restore(combat.scene ?? globalThis.canvas?.scene);
  }

  function syncRoundWarning() {
    const board = projectObjectiveBoard(globalThis.canvas?.scene, { terrain: false });
    const deadline = deadlineFor(board?.spec?.objectives ?? [], board?.spec?.roundLimit ?? 0);
    refreshRoundWarning({
      limit: deadline.limit,
      kind: deadline.kind,
      round: board?.round ?? 0,
      running: board?.started === true
    });
  }

  /* -------------------------------------------- */
  /*  Runtime surface                             */
  /* -------------------------------------------- */

  /**
   * installSystemHooks in init/hooks.mjs drives the four lifecycle steps and calls each hook handler as
   * `runtime.<group>.<handler>`. A group keeps the name its factory gives each handler, so searching for a handler
   * finds both its definition and every Foundry hook that runs it.
   */
  return Object.freeze({
    start,
    setup,
    socketReady,
    ready,
    sendUserNotice: (message, audience) => unitPresentation.broadcast(message, { audience }),
    decorateHud,
    objects: Object.freeze({
      present: broadcastPort.broadcast,
      cue: facts => objectPresentation.playLockCue(facts)
    }),
    classFeatures: classHooks,
    equipmentEffects: equipmentEffectHooks,
    support: supportHooks,
    coinpurse: coinpurseHooks,
    notifications: presentationHooks,
    movementPresentation: movementPresentationHooks,
    stances: stanceHooks,
    vision: visionHooks,
    armamentRelease: createArmamentReleaseHandlers({ objects }),
    voiceApproval: voiceApprovalHooks,
    innateGrants: innateGrantHooks,
    modifiers: modifierHooks,
    threat: threatHooks,
    encounter: encounterHooks,
    encounterCues: Object.freeze({ syncRoundWarning, syncPhaseMusic, restorePhaseMusic }),
    performanceMusic: Object.freeze({
      onPlaylistSoundUpdate: (sound, changes) => performanceMusic.onPlaylistSoundUpdate(sound, changes),
      onPlaylistUpdate: (playlist, changes) => performanceMusic.onPlaylistUpdate(playlist, changes)
    }),
    presenters: Object.freeze({
      onCombatCanvasTearDown: () => combatPresentation.dispose(),
      onStanceCanvasTearDown: () => stancePresentation.dispose()
    }),
    camera: Object.freeze({
      onControlToken: (token, controlled) => {
        if (controlled && token?.actor?.system?.turn?.movementPlanning === true) unitCamera.centerOnUnit(token);
      },
      onUpdateToken: (tokenDocument, changes) => unitCamera.followUnit(tokenDocument, changes),
      onCanvasTearDown: () => unitCamera.dispose()
    }),
    unitPresentation: unitPresentationHooks,
    scene: sceneHooks,
    playerCharacters: playerCharacterHooks,
    users: Object.freeze({
      onUserDisconnected: user => {
        void syncProcessing();
        gateway.forgetCaller(user.id);
        void releaseDisconnectedPlan(user.id);
      },
      onUserActivity: (user, connected) => {
        gateway.onUserActivity(user.id, connected === true);
        gateway.onAuthorityChanged();
        void syncProcessing();
      },
      onUserRoleChanged: () => { gateway.onAuthorityChanged(); void syncProcessing(); }
    }),
    recoveryChat
  });
}

/* -------------------------------------------- */
/*  Unit presentation hooks                     */
/* -------------------------------------------- */
/**
 * Voice and footstep cues the active GM broadcasts to every client: a selection line when a unit starts planning a
 * move (updateActor), a Rally line when a Rally lands (ITEM_ACTIVATION_COMMITTED), and footsteps as a Token moves
 * (moveToken). A move that restores a unit stops its footsteps instead.
 */
function createUnitPresentationHookHandlers({ unitAudio, unitAudioRepository, unitPresentation }) {
  return Object.freeze({
    onUnitSelection(actor, changes) {
      const planning = changes?.system?.turn?.movementPlanning
        ?? changes?.['system.turn.movementPlanning'];
      if (planning !== true || !localUserIsActiveGm()) return;
      setTimeout(async () => {
        const message = await unitAudio.selectionMessage(unitAudioRepository.voiceFacts(actor));
        if (message) await unitPresentation.broadcast(message);
      }, 50);
    },

    async onRallyVoice(event) {
      if (!localUserIsActiveGm()) return;
      const actor = await resolveActor(String(event?.data?.sourceActorUuid ?? ''));
      if (!actor) return;
      const message = await unitAudio.rallyMessage(event.data, unitAudioRepository.voiceFacts(actor));
      if (message) await unitPresentation.broadcast(message);
    },

    onUnitMovement(tokenDocument, movement, operation = {}) {
      if (operation.emblemMovementRestore === true) {
        const tokenUuid = String(tokenDocument?.uuid ?? '');
        stopTokenFootstepAnimation(unitAudioRepository.tokenPlaceable(tokenUuid));
        if (localUserIsActiveGm()) unitAudio.cancelMovementFootsteps(tokenUuid);
        return;
      }
      if (!localUserIsActiveGm()) return;
      const projection = unitAudioRepository.movementFootstepFacts(tokenDocument, movement, operation);
      if (!projection) return;
      unitAudio.scheduleMovementFootsteps(
        { ...projection.facts, heldKeyboard: isHeldMovementRepeating() },
        projection,
        message => unitPresentation.broadcast(message)
      );
    }
  });
}
