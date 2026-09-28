/** @layer init */
import { createOverlayRefresh } from '../ui/controls/overlay-refresh.mjs';
import { getTooltip } from '../ui/tooltips.mjs';
import {
  onCanvasReadyTerrainControls,
  onCanvasTearDownTerrainControls,
  onEncounterPhaseChanged,
  onGetEncounterSceneControls,
  onGetSceneControlButtons,
  onTerrainWallDocumentChanged
} from '../ui/apps/foundry/scene-controls.mjs';
import {
  refreshCombatTab,
  refreshCombatTabDebounced,
  rerenderTracker,
  rerenderTrackerForSightRefresh,
  rerenderTrackerForTokenChange,
  rerenderTrackerForTokenRefresh
} from '../ui/apps/foundry/combat-tracker.mjs';
import { anchorRoundWarning } from '../presentation/graphics/banners.mjs';
import {
  createCanvasDropHandlers,
  encounterSceneFlagsChanged,
  phaseMusicEncounterFlagsChanged,
  phaseMusicSceneFlagsChanged
} from '../foundry/hooks/scene.mjs';
import {
  onItemDirectoryContext,
  onRenderActorDirectory,
  onRenderCompendium,
  onRenderDocumentDirectory,
  onRenderFolderConfig,
  onUpdateActorAvatarScale,
  openFolderDirectory,
  registerAvatarIndexField
} from '../ui/apps/foundry/directories.mjs';
import { onRenderTokenConfig } from '../ui/apps/foundry/token-config.mjs';
import { onRenderUnitTokenHud } from '../ui/apps/foundry/token-hud.mjs';
import {
  applyVoiceOverVolume,
  installVoiceOverChannel,
  onRenderPlaylistDirectoryVolume
} from '../foundry/patches/audio-channels.mjs';
import { installLockedPlaylistSoundHold } from '../foundry/patches/playlist-sounds.mjs';
import { installSettingsSections, onRenderSettingsConfigSections } from '../foundry/patches/settings-sections.mjs';
import { localUserFrozenByPause, refreshCanvasVision } from '../foundry/adapters/services/host.mjs';
import { markPauseFreeze, markSceneLock } from '../presentation/interface/availability.mjs';
import {
  createItemArrivalHookHandlers,
  createItemCatalogHookHandlers,
  createItemUsesHookHandlers
} from '../foundry/hooks/items.mjs';
import { invalidateItemCatalog } from '../foundry/adapters/projections/items.mjs';
import { createObjectLifecycleHandlers } from '../foundry/hooks/objects.mjs';
import { onRefreshFixtureToken } from '../foundry/adapters/document-writes/tokens.mjs';
import { clampItemUses, normalizeCreatedItem } from '../foundry/adapters/document-writes/items.mjs';
import {
  disposeTokenBars,
  onActiveEffectBars,
  onCreateActorBars,
  onDestroyTokenBars,
  onDrawTokenBars,
  onEmbeddedItemBars,
  onPreCreateActorBars,
  onRefreshTokenBars,
  onReadyBarBrawl,
  onUpdateActorBars
} from '../external/barbrawl/resource-bars.mjs';
import {
  onCanvasReadyTokenArt,
  onCanvasReadyTokenRotation,
  onEmbeddedItemTokenArt,
  onMountEffectTokenArt,
  onPreCreateActorSight,
  onPreCreateActorTokenRotation,
  onPreCreateTokenArt,
  onPreCreateTokenRotation,
  onPreUpdateActorTokenRotation,
  onPreUpdateTokenRotation,
  onRefreshTokenArt,
  onUpdateActorTokenArt,
  onUpdateTokenRotationSetting
} from '../foundry/adapters/document-writes/tokens.mjs';
import { projectFoundryTokenEffects } from '../foundry/adapters/projections/tokens.mjs';
import {
  enforceCoreSettingsPolicy,
  initializeCoreSettingsPolicy,
  onEnforcedCoreSettingChanged
} from '../foundry/adapters/services/settings-policy.mjs';
import { syncTerrainPlaceables } from '../foundry/adapters/document-writes/terrain.mjs';
import {
  forgetTerrainReads,
  readTerrainGrid,
  readTerrainSpawnImages,
  readTerrainZones
} from '../foundry/adapters/projections/terrain.mjs';
import { disposeTerrainEffects, syncTerrainEffects } from '../external/sequencer/runtime.mjs';
import { clearAllLocalImpacts, clearLocalImpacts } from '../external/token-magic-fx/filters.mjs';
import { SYSTEM_ID } from '../contracts/protocol.mjs';
import { INSPECT_TOKEN_HOOK } from '../contracts/domains/bg3-hud.mjs';
import { TOKEN_OUTLINE_COLOUR_SETTING } from '../config/settings.mjs';
import { projectTerrainPresentation, terrainGridChanged } from '../game/terrain/rules.mjs';
import { applyMovementFacing } from '../foundry/adapters/document-writes/movement.mjs';
import {
  configureTokenEffectPresentation,
  drawEmblemTokenEffects,
  onActiveEffectTokenPresentation,
  onCanvasReadyTokenPresentation,
  onCanvasTearDownTokenPresentation,
  onControlTokenPresentation,
  onDestroyTokenPresentation,
  onDrawTokenPresentation,
  onHoverTokenPresentation,
  onRefreshTokenPresentation,
  onScenePhaseTokenPresentation,
  onTargetTokenPresentation,
  onUpdateActorTokenPresentation,
  onUpdateTokenPresentation,
  refreshEmblemTokenEffects
} from '../presentation/token/rendering.mjs';
import { onCanvasTearDownMovementPresentation } from '../presentation/canvas/cell-overlays.mjs';
import {
  onCanvasReadyTerrainPresentation,
  onCanvasTearDownTerrainPresentation,
  onTerrainPresentationChanged
} from '../presentation/canvas/terrain.mjs';
import {
  initializeMovementControls,
  onCanvasReadyMovementControls,
  onCanvasTearDownMovementControls,
  onControlTokenMovement,
  onDestroyTokenMovement,
  onMoveTokenMovement,
  onPreUpdateTokenMovement,
  onRenderMovementTokenHud,
  onBg3HudMovementAction,
  onUpdateActorMovement,
  onUpdateTokenMovement,
  inspectMovementPlan,
  refreshMovementOverlays,
  resumeMovementAfterTargeting,
  settleMovementAfterInteraction,
  suspendMovementForTargeting
} from '../ui/controls/movement.mjs';
import {
  initializeInspectionControls,
  isInteractionPickActive,
  onCanvasPanInspection,
  onCanvasTearDownInspection,
  onDestroyTokenInspection,
  onHoverTokenInspection,
  onUpdateTokenInspection,
  refreshInteractionOverlays,
  runInteract,
  runTrade
} from '../ui/controls/interaction.mjs';
import { installBoardCursor } from '../ui/controls/board-cursor.mjs';
import { setCounterMode } from '../ui/controls/counter-mode.mjs';
import { disposeCanvasDoubleClickCancel, installCanvasDoubleClickCancel } from '../ui/controls/keybindings.mjs';
import {
  activateAttackItemFromHotbar,
  isActivationTargetingActive,
  isAttackTargetingActive,
  onCanvasTearDownAttackTargeting,
  onControlTokenAttackTargeting,
  onTargetingSourceChanged,
  refreshTargetingOverlays,
  stepCancelAttackTargeting
} from '../ui/controls/targeting.mjs';
import {
  installPlaceablesFilterGate,
  initializeUiInterventions,
  onRenderTokenHud,
  readyUiInterventions
} from '../foundry/patches/ui-chrome.mjs';
import {
  installChatNotificationGate,
  onCollapseSidebarNotifications
} from '../foundry/patches/chat-notifications.mjs';
import { onLinkedJournalRenamed } from '../foundry/hooks/journal-links.mjs';
import { TokenBadgeStrip } from '../presentation/token/badges.mjs';
import { projectObjectiveMarkerTargets } from '../foundry/adapters/projections/encounters.mjs';
import {
  createCharacterTokenSizeGuards, enforceObjectTokenSight, fillPlacedToken
} from '../foundry/adapters/document-writes/tokens.mjs';
import { refreshTokenOutlines } from '../presentation/token/rendering.mjs';
import { playMenuSound } from '../presentation/audio/service.mjs';
import { SOUND_IDS } from '../presentation/audio/sound-database.mjs';
import {
  onBg3HudDocumentChanged,
  onCombatChangedBg3Hud,
  onCreateActorBg3Hud,
  onCreateSceneBg3Hud,
  onCreateTokenBg3Hud,
  onEmbeddedItemBg3Hud
} from '../external/bg3-hud/hotbar.mjs';
import { onBg3HudReady, onRenderBg3Hotbar, refreshBg3DisplaySettings } from '../external/bg3-hud/character-hud.mjs';
import { removeBg3HudToggleControl } from '../external/bg3-hud/core-runtime.mjs';
import { createEncounterNotifier, createPlatformNotifier } from '../presentation/interface/notifications.mjs';
import {
  onRenderSceneConfigGridTypes,
  onRenderSceneConfigMapVisible,
  onRenderSceneConfigMovementPermission,
  onRenderSceneConfigPadding,
  onRenderSceneConfigPhaseTracks,
  onRenderSceneConfigTokenOutline
} from '../ui/apps/foundry/scene-config.mjs';
import { installVisionPatches, invalidateSightGate } from '../foundry/patches/vision.mjs';
import { installBarAttributePatch } from '../foundry/patches/bar-attributes.mjs';
import { installCoreKeybindingDefaults } from '../foundry/patches/core-keybindings.mjs';
import { createEncounterSceneLock } from '../foundry/patches/scene-lock.mjs';
import {
  onPreCreateSceneFogDefaults,
  onPreUpdateSceneMapVisible
} from '../foundry/adapters/document-writes/vision.mjs';
import { refreshActorControlPanel } from '../ui/apps/menus/acp-app.mjs';
import { refreshRecipeLibraryViews } from '../ui/apps/menus/recipe-library-app.mjs';
import { refreshSongLibraryViews } from '../ui/apps/menus/song-library-app.mjs';
import { reloadRecipeLibrary, reloadSongLibrary } from '../foundry/adapters/services/json-files.mjs';
import { onDiceSoNiceRollStart } from '../external/dice-so-nice/faction-dice.mjs';
import { enforceDiceSoNiceInactiveTabSkip } from '../external/dice-so-nice/preferences.mjs';
import { onHitChanceModelChanged } from '../foundry/adapters/dice/checks.mjs';
import { onDifficultyChanged } from '../foundry/data-models/actor/character.mjs';
import { registerSystemFoundations } from './registrations.mjs';
import { createSystemRuntime } from './system.mjs';
import { runDropItemFlow } from '../ui/dialogs.mjs';
import { reportFoundryError, FoundryDiagnostics, observeFoundryErrors } from '../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Lifecycle hooks                             */
/* -------------------------------------------- */

/**
 * Run one consumer of a fan-out hook handler and keep going when it throws.
 *
 * Foundry hands a document update to every interested part of the system through a single handler below, so one
 * failing consumer must not skip the rest: the throw is reported through foundry/adapters/services/diagnostics.mjs
 * and the caller reads `undefined` for that step.
 * @param {string} name Which consumer failed, for the diagnostic.
 * @param {Function} run The consumer.
 * @returns {*} Whatever the consumer returned, or undefined when it threw.
 */
function guarded(name, run) {
  try {
    return run();
  } catch (error) {
    reportFoundryError(import.meta.url, error, name);
    return undefined;
  }
}

const LIFECYCLE_HOOK_CATALOG = Object.freeze(['init', 'setup', 'socketlib.ready', 'ready']);
const GLOBAL_HOOK_CATALOG = Object.freeze([
  'bg3HudReady',
  'canvasPan',
  'canvasReady',
  'canvasTearDown',
  'chatMessage',
  'collapseSidebar',
  'combatStart',
  'controlToken',
  'createActor',
  'createAmbientLight',
  'createRegion',
  'createScene',
  'createSequencerEffect',
  'createToken',
  'createActiveEffect',
  'createCombat',
  'createItem',
  'deleteActiveEffect',
  'deleteActor',
  'deleteAmbientLight',
  'deleteRegion',
  'deleteCombat',
  'deleteItem',
  'deleteToken',
  'createWall',
  'deleteWall',
  'diceSoNiceRollStart',
  'dropCanvasData',
  'destroyToken',
  'drawToken',
  'getItemContextOptions',
  'getSceneControlButtons',
  'hoverToken',
  'moveToken',
  'pauseGame',
  'preCreateActor',
  'preCreateCombat',
  'preCreateScene',
  'preCreateToken',
  'preUpdateActor',
  'preUpdateScene',
  'preUpdateToken',
  'renderActorDirectory',
  'renderBG3Hotbar',
  'renderCompendium',
  'renderDocumentDirectory',
  'renderFolderConfig',
  'renderPlaylistDirectory',
  'renderPrototypeTokenConfig',
  'renderSceneConfig',
  'renderSettingsConfig',
  'renderSidebar',
  'renderTokenConfig',
  'renderTokenHUD',
  'refreshToken',
  'sequencerReady',
  'sequencerEffectManagerReady',
  'sightRefresh',
  'targetToken',
  'updateActiveEffect',
  'updateActor',
  'updateAmbientLight',
  'updateRegion',
  'updateCombat',
  'updateItem',
  'updateJournalEntry',
  'updateJournalEntryPage',
  'updatePlaylist',
  'updatePlaylistSound',
  'updateSetting',
  'updateScene',
  'updateToken',
  'updateUser',
  'updateWall',
  'userConnected',
  'emblemRpg.itemDocumentOutcome',
  'emblemRpg.bg3HudAction',
  'emblemRpg.bg3HudDecorate',
  INSPECT_TOKEN_HOOK
]);

/**
 * Register the system's Foundry hooks and UI handlers. The entry file calls this once per page, and every
 * subscription lives until the page unloads.
 */
export function installSystemHooks() {
  observeFoundryErrors();
  const overlays = createOverlayRefresh({ sceneUuid: () => globalThis.canvas?.scene?.uuid ?? '',
    report: error => reportFoundryError(import.meta.url, error, 'refresh-control-overlays'),
    refresh: async (facts, valid) => {
      const results = await Promise.allSettled([refreshMovementOverlays(facts, valid),
        refreshTargetingOverlays(facts, valid), refreshInteractionOverlays(facts, valid)]);
      for (const result of results) if (result.status === 'rejected') {
        reportFoundryError(import.meta.url, result.reason, 'refresh-control-overlays');
      }
    }
  });
  /**
   * Built in the init hook below. Every later handler reads it unguarded, so a start-up that failed to build it
   * throws in each hook instead of leaving the system silently inert. Only `socketlib.ready` may run first, because
   * socketlib raises it from its own init, in whatever order Foundry loads the packages.
   */
  let runtime = null;
  let socketlibReady = Boolean(globalThis.socketlib);
  const canvasDrops = createCanvasDropHandlers({ openFolderDirectory });
  const itemUses = createItemUsesHookHandlers({ clampItemUses });
  const itemCatalog = createItemCatalogHookHandlers({ invalidateItemCatalog });
  const platformNotifier = createPlatformNotifier({ diagnostics: new FoundryDiagnostics(),
    localUserId: () => String(game.user?.id ?? ''),
    notice: (message, audience) => runtime.sendUserNotice(message, audience) });
  const badges = new TokenBadgeStrip({ projectMarkers: () => projectObjectiveMarkerTargets() });
  const tokenSize = createCharacterTokenSizeGuards(platformNotifier);
  const objects = createObjectLifecycleHandlers({
    present: message => runtime.objects.present(message),
    cue: facts => runtime.objects.cue(facts)
  });
  const itemArrival = createItemArrivalHookHandlers({
    normalizeCreatedItem,
    notify: platformNotifier
  });
  const sceneLock = createEncounterSceneLock({
    notify: createEncounterNotifier({ diagnostics: new FoundryDiagnostics() }).warn,
    mark: markSceneLock
  });

  const lifecycle = {
    init() {
      registerSystemFoundations(getTooltip, {
        onBg3DisplayChanged: refreshBg3DisplaySettings,
        onHitChanceModelChanged,
        onDifficultyChanged,
        onCampaignPartiesChanged: refreshCanvasVision,
        onVoiceOverVolumeChanged: applyVoiceOverVolume,
        onRecipeLibraryChanged: () => { void reloadRecipeLibrary().then(refreshRecipeLibraryViews); },
        onSongLibraryChanged: () => { void reloadSongLibrary().then(refreshSongLibraryViews); }
      });
      registerAvatarIndexField();
      initializeUiInterventions({
        sounds: {
          expand: () => playMenuSound(SOUND_IDS.UI_EXPAND),
          collapse: () => playMenuSound(SOUND_IDS.UI_COLLAPSE),
          tabClick: () => playMenuSound(SOUND_IDS.UI_BLIP_4)
        }
      });
      configureTokenEffectPresentation({ projectEffects: projectFoundryTokenEffects });
      runtime = createSystemRuntime();
      runtime.start();
      if (socketlibReady) runtime.socketReady();
    },
    setup() {
      runtime.setup();
      initializeTokenEffectRendering();
      installVisionPatches();
      installBarAttributePatch();
      installCoreKeybindingDefaults();
      sceneLock.install();
      installPlaceablesFilterGate();
      installChatNotificationGate();
      initializeMovementControls();
      initializeInspectionControls();
      installBoardCursor({ readFacts: readBoardCursorFacts });
      initializeCoreSettingsPolicy();
      installSettingsSections();
      installVoiceOverChannel();
      installLockedPlaylistSoundHold();
    },
    'socketlib.ready'() {
      socketlibReady = true;
      runtime?.socketReady();
    },
    ready() {
      readyUiInterventions();
      markPauseFreeze(localUserFrozenByPause());
      void runtime.ready();
      void onReadyBarBrawl();
      void enforceCoreSettingsPolicy();
      void enforceObjectTokenSight();
      void enforceDiceSoNiceInactiveTabSkip();
      refreshCombatTab();
    }
  };
  const globalHandlers = {
    bg3HudReady: (...args) => onBg3HudReady(...args),
    canvasPan: () => onCanvasPanInspection(),
    canvasReady: (...args) => {
      invalidateSightGate();
      sceneLock.onCanvasReady();
      runtime.threat.onCanvasReady();
      onCanvasReadyTerrainControls(...args);
      refreshTerrainRuntime({ resetPresentation: true });
      runtime.modifiers.onCanvasReadyModifiers(...args);
      runtime.movementPresentation.onMovementPresentationReady(...args);
      onCanvasReadyMovementControls(...args);
      installCanvasDoubleClickCancel();
      onCanvasReadyTokenPresentation(...args);
      badges.refresh();
      onCanvasReadyTokenRotation(...args);
      onCanvasReadyTokenArt(...args);
      runtime.encounterCues.syncRoundWarning();
      runtime.encounterCues.syncPhaseMusic();
      runtime.vision.onCanvasReadyVision();
      refreshCombatTabDebounced();
      rerenderTracker();
    },
    canvasTearDown: (...args) => {
      clearAllLocalImpacts();
      overlays.cancel();
      void onCanvasTearDownTerrainControls();
      closeTerrainEffectGate();
      clearTerrainRuntimeTimers();
      disposeTerrainEffects();
      onCanvasTearDownTerrainPresentation(...args);
      onCanvasTearDownAttackTargeting(...args);
      onCanvasTearDownInspection(...args);
      disposeCanvasDoubleClickCancel();
      onCanvasTearDownMovementControls(...args);
      onCanvasTearDownMovementPresentation(...args);
      onCanvasTearDownTokenPresentation(...args);
      runtime.presenters.onCombatCanvasTearDown(...args);
      runtime.presenters.onStanceCanvasTearDown(...args);
      runtime.camera.onCanvasTearDown(...args);
      disposeTokenBars();
    },
    collapseSidebar: () => {
      setTimeout(() => anchorRoundWarning(), 350);
      onCollapseSidebarNotifications();
    },
    controlToken: (...args) => {
      onControlTokenAttackTargeting(...args);
      runtime.threat.onControlToken();
      onControlTokenMovement(...args);
      onControlTokenPresentation(...args);
      runtime.camera.onControlToken(...args);
    },
    createActor: (...args) => {
      runtime.equipmentEffects.onActorCreated(...args);
      runtime.voiceApproval.onActorCreated(...args);
      runtime.innateGrants.onActorCreated(...args);
      onCreateActorBars(...args);
      void onCreateActorBg3Hud(...args);
    },
    createCombat: () => {
      badges.refresh();
      refreshCombatTabDebounced();
      sceneLock.onEncounterChanged();
      onCombatChangedBg3Hud();
    },
    chatMessage: (...args) => runtime.recoveryChat.onChatMessage(...args),
    createScene: (...args) => {
      void onCreateSceneBg3Hud(...args);
      void runtime.scene.onCreateScene(...args);
    },
    createSequencerEffect: effect => void runtime.scene.onCreateSequencerEffect(effect),
    createToken: (...args) => {
      overlays.invalidate(args[0]);
      runtime.threat.onTokenPlaced();
      badges.refresh();
      void fillPlacedToken(args[0], args[1]);
      void onCreateTokenBg3Hud(...args);
      runtime.innateGrants.onTokenCreated(...args);
      runtime.modifiers.onTokenPlacementChanged(args[0]);
      runtime.vision.onDoorPlacementChanged(args[0]);
    },
    createActiveEffect: (...args) => {
      runtime.threat.onEffectChanged(args[0]);
      runtime.modifiers.onUnitFlightChanged(args[0], args[1]);
      runtime.equipmentEffects.onActiveEffectChanged(args[0], null, args[1]);
      runtime.innateGrants.onActiveEffectChanged(args[0]);
      onActiveEffectBars(args[0]);
      onMountEffectTokenArt(...args);
      onActiveEffectTokenPresentation(...args);
      onBg3HudDocumentChanged(...args);
      runtime.vision.onSightEffectChanged(args[0]);
    },
    createItem: (...args) => {
      itemCatalog.onCatalogItemChanged(args[0]);
      runtime.threat.onItemChanged(args[0]);
      void itemArrival.onItemArrived(args[0], args[1], args[2]);
      runtime.classFeatures.onClassItemCreated(...args);
      runtime.innateGrants.onItemChanged(args[0]);
      runtime.coinpurse.onCoinpurseItemCreated(args[0], args[1]);
      runtime.equipmentEffects.onEmbeddedItemChanged(args[0], null, args[1]);
      onEmbeddedItemBars(...args);
      onEmbeddedItemTokenArt(args[0], null);
      onEmbeddedItemBg3Hud(...args);
      runtime.modifiers.onAuraItemChanged(args[0]);
      runtime.vision.onEmbeddedSightChanged(args[0]);
      runtime.modifiers.onUnitFlightChanged(args[0], args[1]);
    },
    createAmbientLight: () => invalidateSightGate(),
    createRegion: () => invalidateSightGate(),
    createWall: (...args) => onTerrainWallChange(...args),
    deleteCombat: (...args) => {
      runtime.threat.onDeleteCombat();
      badges.refresh();
      sceneLock.onEncounterChanged();
      runtime.encounter.onDeleteEncounter(...args);
      runtime.encounterCues.syncRoundWarning();
      runtime.encounterCues.restorePhaseMusic(args[0]);
      refreshCombatTabDebounced();
      onCombatChangedBg3Hud();
    },
    deleteActor: (...args) => runtime.voiceApproval.onActorDeleted(...args),
    deleteActiveEffect: (...args) => {
      runtime.threat.onEffectChanged(args[0]);
      runtime.modifiers.onUnitFlightChanged(args[0], args[1]);
      runtime.equipmentEffects.onActiveEffectChanged(args[0], null, args[1]);
      runtime.innateGrants.onActiveEffectChanged(args[0]);
      onActiveEffectBars(args[0]);
      onMountEffectTokenArt(...args);
      onActiveEffectTokenPresentation(...args);
      onBg3HudDocumentChanged(...args);
      runtime.vision.onSightEffectChanged(args[0]);
    },
    deleteItem: (...args) => {
      itemCatalog.onCatalogItemChanged(args[0]);
      runtime.threat.onItemChanged(args[0]);
      runtime.equipmentEffects.onEmbeddedItemChanged(args[0], null, args[1]);
      runtime.innateGrants.onItemChanged(args[0]);
      onTargetingSourceChanged(...args);
      onEmbeddedItemBars(...args);
      onEmbeddedItemTokenArt(args[0], null);
      onEmbeddedItemBg3Hud(...args);
      runtime.modifiers.onAuraItemChanged(args[0]);
      runtime.vision.onEmbeddedSightChanged(args[0]);
      runtime.modifiers.onUnitFlightChanged(args[0], args[1]);
    },
    deleteToken: (...args) => {
      overlays.invalidate(args[0]);
      runtime.threat.onTokenPlaced();
      badges.refresh();
      runtime.modifiers.onTokenPlacementChanged(args[0]);
      runtime.encounter.onTokenRemoved(args[0]);
      runtime.vision.onDoorPlacementChanged(args[0]);
      rerenderTracker();
    },
    deleteAmbientLight: () => invalidateSightGate(),
    deleteRegion: () => invalidateSightGate(),
    deleteWall: (...args) => onTerrainWallChange(...args),
    dropCanvasData: (...args) => canvasDrops.onDropCanvasData(...args),
    diceSoNiceRollStart: (...args) => onDiceSoNiceRollStart(...args),
    destroyToken: (...args) => {
      badges.release(args[0]);
      onTargetingSourceChanged(args[0]);
      onDestroyTokenInspection(...args);
      onDestroyTokenMovement(...args);
      onDestroyTokenPresentation(...args);
      onDestroyTokenBars(...args);
      clearLocalImpacts(args[0]);
    },
    drawToken: (...args) => {
      onDrawTokenPresentation(...args);
      onDrawTokenBars(...args);
      badges.draw(args[0]);
      onRefreshTokenArt(...args);
      onRefreshFixtureToken(args[0]);
    },
    getItemContextOptions: (...args) => onItemDirectoryContext(...args),
    getSceneControlButtons: (...args) => {
      removeBg3HudToggleControl(args[0]);
      onGetSceneControlButtons(...args);
      onGetEncounterSceneControls(...args);
    },
    hoverToken: (...args) => {
      onHoverTokenInspection(...args);
      onHoverTokenPresentation(...args);
    },
    moveToken: (...args) => {
      onMoveTokenMovement(...args);
      runtime.unitPresentation.onUnitMovement(...args);
      runtime.modifiers.onTokenMovementSettling(args[0]);
    },
    preCreateActor: (...args) => {
      onPreCreateActorBars(...args);
      onPreCreateActorTokenRotation(...args);
      onPreCreateActorSight(...args);
      objects.onPreCreateFixtureActor(args[0]);
    },
    preCreateCombat: (...args) => runtime.encounter.onPreCreateEncounter(...args),
    preCreateScene: (...args) => {
      onPreCreateSceneFogDefaults(...args);
      runtime.scene.onPreCreateScene(args[0]);
    },
    preCreateToken: (...args) => {
      onPreCreateTokenRotation(...args);
      objects.onPreCreateFixtureToken(args[0]);
      onPreCreateTokenArt(...args);
    },
    preUpdateActor: (...args) => {
      onPreUpdateActorTokenRotation(...args);
      objects.onPreUpdateFixtureActor(args[0], args[1]);
      return tokenSize.onPreUpdateActorSize(...args);
    },
    preUpdateScene: (...args) => {
      if (sceneLock.onPreUpdateScene(...args) === false) return false;
      const allowed = runtime.scene.onPreUpdateScene(...args);
      if (allowed === false) return false;
      onPreUpdateSceneMapVisible(...args);
      return undefined;
    },
    preUpdateToken: (...args) => {
      if (tokenSize.onPreUpdateTokenSize(...args) === false) return false;
      onPreUpdateTokenRotation(...args);
      objects.onPreUpdateFixtureToken(args[0], args[1]);
      const allowed = onPreUpdateTokenMovement(...args);
      if (allowed === true) applyMovementFacing(...args);
      return allowed;
    },
    renderActorDirectory: onRenderActorDirectory,
    renderCompendium: (...args) => void onRenderCompendium(...args),
    renderDocumentDirectory: (...args) => onRenderDocumentDirectory(...args),
    renderFolderConfig: (...args) => onRenderFolderConfig(...args),
    renderPlaylistDirectory: (...args) => onRenderPlaylistDirectoryVolume(...args),
    renderPrototypeTokenConfig: (...args) => onRenderTokenConfig(...args),
    renderSceneConfig: (...args) => {
      onRenderSceneConfigPadding(...args);
      onRenderSceneConfigGridTypes(...args);
      onRenderSceneConfigTokenOutline(...args);
      onRenderSceneConfigMapVisible(...args);
      onRenderSceneConfigMovementPermission(...args);
      onRenderSceneConfigPhaseTracks(...args);
    },
    renderSettingsConfig: (...args) => onRenderSettingsConfigSections(...args),
    renderTokenConfig: (...args) => onRenderTokenConfig(...args),
    renderSidebar: () => refreshCombatTabDebounced(),
    renderBG3Hotbar: (app, html) => onRenderBg3Hotbar(app, html, {
      on: (...args) => Hooks.on(...args),
      off: (...args) => Hooks.off(...args)
    }),
    renderTokenHUD: (...args) => {
      onRenderMovementTokenHud(...args);
      onRenderTokenHud(...args);
      onRenderUnitTokenHud(...args);
    },
    refreshToken: (...args) => {
      rerenderTrackerForTokenRefresh(args[0], args[1]);
      if (visibilityOnlyRefresh(args[1])) return;
      onRefreshTokenPresentation(...args);
      onRefreshTokenBars(...args);
      badges.draw(args[0]);
      onRefreshTokenArt(...args);
      onRefreshFixtureToken(args[0]);
    },
    sequencerReady: () => refreshTerrainRuntime(),
    sightRefresh: () => {
      if (!game.user.isGM) rerenderTrackerForSightRefresh();
    },
    sequencerEffectManagerReady: () => openTerrainEffectGate(),
    targetToken: onTargetTokenPresentation,
    updateActiveEffect: (...args) => {
      runtime.equipmentEffects.onActiveEffectChanged(...args);
      runtime.modifiers.onUnitFlightChanged(args[0], args[2]);
      onActiveEffectBars(args[0]);
      onActiveEffectTokenPresentation(...args);
      onBg3HudDocumentChanged(...args);
    },
    /**
     * Every consumer of an Actor update, each behind `guarded` so one throwing consumer can't skip the rest. The
     * stance settlement's result is returned, but Foundry ignores it: updateActor is raised with Hooks.callAll.
     */
    updateActor: (...args) => {
      guarded('threat', () => runtime.threat.onUpdateActor(args[0], args[1]));
      guarded('object-actor', () => objects.onUpdateObjectActor(args[0], args[1], args[2], args[3]));
      guarded('character-level', () => runtime.classFeatures.onCharacterLevelChanged(...args));
      guarded('innate-grants', () => runtime.innateGrants.onActorUpdated(args[0], args[1]));
      guarded('armament', () => runtime.equipmentEffects.onActorArmamentChanged(...args));
      guarded('actor-facts', () => runtime.equipmentEffects.onActorFactsChanged(...args));
      guarded('unit-selection', () => runtime.unitPresentation.onUnitSelection(...args));
      const stanceSettlement = guarded('stance', () => runtime.stances.onCharacterStanceUpdated(...args));
      guarded('targeting-source', () => onTargetingSourceChanged(...args));
      guarded('movement', () => onUpdateActorMovement(...args));
      guarded('token-presentation', () => onUpdateActorTokenPresentation(...args));
      guarded('resource-bars', () => onUpdateActorBars(...args));
      guarded('token-art', () => onUpdateActorTokenArt(...args));
      guarded('actor-control-panel', () => refreshActorControlPanel(args[0], args[1]));
      guarded('avatar-scale', () => onUpdateActorAvatarScale(...args));
      guarded('bg3-hud', () => onBg3HudDocumentChanged(...args));
      guarded('board-modifiers', () => runtime.modifiers.onModifierUnitChanged(...args));
      guarded('board-flight', () => runtime.modifiers.onUnitFlightChanged(args[0], args[2]));
      guarded('support', () => runtime.support.onCharacterSupportChanged(...args));
      guarded('unit-turn', () => runtime.encounter.onUnitTurnChanged(...args));
      guarded('actor-sight', () => runtime.vision.onActorSightChanged(...args));
      guarded('door-lock', () => runtime.vision.onDoorLockChanged(...args));
      guarded('combat-tracker', () => rerenderTracker());
      return stanceSettlement;
    },
    updateCombat: (...args) => {
      runtime.threat.onUpdateCombat();
      sceneLock.onEncounterChanged();
      runtime.encounter.onEncounterFlagsChanged(...args);
      runtime.encounterCues.syncRoundWarning();
      if (phaseMusicEncounterFlagsChanged(args[1])) runtime.encounterCues.syncPhaseMusic();
      refreshCombatTabDebounced();
      onCombatChangedBg3Hud(args[1]);
    },
    updateItem: (...args) => {
      itemCatalog.onCatalogItemChanged(args[0]);
      itemUses.onItemUsesMaxChanged(...args);
      runtime.innateGrants.onItemUpdated(args[0], args[1]);
      runtime.equipmentEffects.onEmbeddedItemChanged(...args);
      onTargetingSourceChanged(...args);
      onEmbeddedItemBars(...args);
      onEmbeddedItemTokenArt(...args);
      onEmbeddedItemBg3Hud(...args);
      runtime.modifiers.onAuraItemChanged(args[0], args[1]);
      runtime.modifiers.onMountItemChanged(args[0]);
      runtime.modifiers.onUnitFlightChanged(args[0], args[2]);
    },
    updateJournalEntry: (...args) => onLinkedJournalRenamed(...args),
    updateJournalEntryPage: (...args) => onLinkedJournalRenamed(...args),
    updatePlaylist: (...args) => runtime.performanceMusic.onPlaylistUpdate(...args),
    updatePlaylistSound: (...args) => runtime.performanceMusic.onPlaylistSoundUpdate(...args),
    updateSetting: (...args) => {
      onEnforcedCoreSettingChanged(...args);
      onUpdateTokenRotationSetting(...args);
      if (tokenOutlineSettingChanged(args[0])) refreshTokenOutlines();
      runtime.movementPresentation.onMovementLockSettingChanged(...args);
      runtime.movementPresentation.onDrivenHoldSettingChanged(...args);
    },
    updateScene: (...args) => {
      invalidateSightGate();
      runtime.threat.onUpdateScene(args[0], args[1]);
      forgetTerrainReads(args[0]);
      if (tokenOutlineSceneFlagChanged(args[1])) refreshTokenOutlines();
      onTerrainSceneUpdate(...args);
      runtime.modifiers.onTerrainGridWritten(...args);
      runtime.modifiers.onScenePermissionChanged(...args);
      onEncounterPhaseChanged(...args);
      onScenePhaseTokenPresentation(...args);
      runtime.vision.onSceneFogChanged(...args);
      if (phaseMusicSceneFlagsChanged(args[1])) runtime.encounterCues.syncPhaseMusic();
      if (!encounterSceneFlagsChanged(args[1])) return;
      runtime.encounterCues.syncRoundWarning();
      refreshCombatTabDebounced();
      rerenderTracker();
    },
    updateToken: (...args) => {
      overlays.invalidate(args[0], args[1]);
      runtime.threat.onUpdateToken(args[0], args[1]);
      rerenderTrackerForTokenChange(args[1]);
      onTargetingSourceChanged(...args);
      onUpdateTokenMovement(...args);
      onUpdateTokenInspection(...args);
      onUpdateTokenPresentation(...args);
      runtime.camera.onUpdateToken(...args);
      runtime.vision.onDoorPlacementChanged(args[0], args[1]);
      runtime.armamentRelease.onUpdateTokenArmamentRelease(args[0], args[1]);
    },
    updateUser: (user, changes) => {
      if (user.isSelf) void enforceDiceSoNiceInactiveTabSkip(user);
      if (Object.hasOwn(changes, 'role')) runtime.users.onUserRoleChanged();
      if (user.isSelf && Object.hasOwn(changes, 'role')) markPauseFreeze(localUserFrozenByPause());
    },
    updateAmbientLight: () => invalidateSightGate(),
    updateRegion: () => invalidateSightGate(),
    updateWall: (...args) => onTerrainWallChange(...args),
    userConnected: (user, connected) => {
      runtime.users.onUserActivity(user, connected);
      void runtime.playerCharacters.onUserConnectedPlayerCharacter(user, connected);
      if (connected === false) runtime.users.onUserDisconnected(user);
    },
    'emblemRpg.itemDocumentOutcome': (...args) => runtime.notifications.onItemDocumentOutcome(...args),
    'emblemRpg.bg3HudAction': (action, ...args) => onBg3HudAction(action, ...args),
    combatStart: () => runtime.threat.onCombatStart(),
    pauseGame: () => markPauseFreeze(localUserFrozenByPause()),
    [INSPECT_TOKEN_HOOK]: token => runtime.threat.onInspectToken(token),
    'emblemRpg.bg3HudDecorate': (app, html) => runtime.decorateHud(app, html)
  };

  for (const hook of LIFECYCLE_HOOK_CATALOG) Hooks.once(hook, lifecycle[hook]);
  for (const hook of GLOBAL_HOOK_CATALOG) Hooks.on(hook, globalHandlers[hook]);
}

/* -------------------------------------------- */
/*  Board cursor facts                          */
/* -------------------------------------------- */
/**
 * Read targeting and movement state for ui/controls/board-cursor.mjs.
 */
function readBoardCursorFacts() {
  const plan = inspectMovementPlan();
  return {
    picking: isAttackTargetingActive() || isActivationTargetingActive() || isInteractionPickActive(),
    dragging: Boolean(plan) && plan.dragging === true
  };
}

/* -------------------------------------------- */
/*  HUD actions                                 */
/* -------------------------------------------- */
function onBg3HudAction(action, ...args) {
  if (action === 'interact') {
    void runInteract(inspectMovementPlan(), {
    attack: activateAttackItemFromHotbar, resume: resumeMovementAfterTargeting,
    suspend: suspendMovementForTargeting, release: settleMovementAfterInteraction
  });
    return true;
  }
  if (action === 'trade') {
    void runTrade(inspectMovementPlan(), {
      inspect: inspectMovementPlan,
      suspend: suspendMovementForTargeting,
      resume: resumeMovementAfterTargeting,
      release: settleMovementAfterInteraction
    });
    return true;
  }
  if (action === 'cancel-targeting') return stepCancelAttackTargeting();
  if (action === 'drop-item') {
    const [token, actor, extra] = args;
    void runDropItemFlow({
      actor: actor ?? null,
      tokenUuid: String(token?.document?.uuid ?? ''),
      itemId: String(extra?.itemId ?? ''),
      resume: resumeMovementAfterTargeting
    });
    return true;
  }
  if (action === 'counter-mode') {
    const [, actor, extra] = args;
    void setCounterMode({ actorUuid: String(actor?.uuid ?? ''), pacifist: extra?.pacifist === true });
    return true;
  }
  return onBg3HudMovementAction(action, ...args);
}

/* -------------------------------------------- */
/*  Token effect rendering                      */
/* -------------------------------------------- */
const TOKEN_EFFECT_WRAPPERS = Object.freeze([
  'foundry.canvas.placeables.Token.prototype._drawEffects',
  'foundry.canvas.placeables.Token.prototype._refreshEffects'
]);

/** Whether a refreshToken pass only refreshes visibility, which Foundry does every frame and the handlers can skip. */
function visibilityOnlyRefresh(flags) {
  const raised = Object.keys(flags).filter(flag => flags[flag]);
  return raised.length === 1 && raised[0] === 'refreshVisibility';
}

function tokenOutlineSceneFlagChanged(changed) {
  const flags = changed.flags?.[SYSTEM_ID];
  if (!flags) return false;
  return TOKEN_OUTLINE_COLOUR_SETTING in flags || `-=${TOKEN_OUTLINE_COLOUR_SETTING}` in flags;
}

function tokenOutlineSettingChanged(setting) {
  return setting.key === `${SYSTEM_ID}.${TOKEN_OUTLINE_COLOUR_SETTING}`;
}

/** Replace Token#_drawEffects and Token#_refreshEffects with the system's (presentation/token/rendering.mjs). */
function initializeTokenEffectRendering() {
  if (!globalThis.libWrapper) {
    reportFoundryError(import.meta.url, null, 'Emblem RPG | libWrapper is required for Token effect presentation.');
    return;
  }
  globalThis.libWrapper.register(SYSTEM_ID, TOKEN_EFFECT_WRAPPERS[0], drawEmblemTokenEffects, 'OVERRIDE');
  globalThis.libWrapper.register(SYSTEM_ID, TOKEN_EFFECT_WRAPPERS[1], refreshEmblemTokenEffects, 'OVERRIDE');
}

/* -------------------------------------------- */
/*  Terrain hook routing                        */
/* -------------------------------------------- */
const terrainRuntimeTimers = new Set();
let terrainRefreshTimer = null;
let terrainProjectionGeneration = 0;
let terrainEffectGateOpen = false;

function onTerrainSceneUpdate(scene, changes) {
  if (scene.id !== globalThis.canvas?.scene?.id) return;
  const terrainFlags = changes.flags?.[SYSTEM_ID];
  const zonesChanged = terrainFlags && Object.keys(terrainFlags)
    .some(key => key === 'terrainZones' || key.startsWith('terrainZones.'));
  if (!terrainGridChanged(changes, SYSTEM_ID) && !zonesChanged) return;
  scheduleTerrainRefresh();
}

function onTerrainWallChange(wall) {
  invalidateSightGate();
  if (wall.parent.id !== globalThis.canvas?.scene?.id) return;
  onTerrainWallDocumentChanged();
  scheduleTerrainRefresh();
}

function scheduleTerrainRefresh() {
  if (terrainRefreshTimer) clearTimeout(terrainRefreshTimer);
  terrainRefreshTimer = setTimeout(() => {
    terrainRefreshTimer = null;
    refreshTerrainRuntime();
  }, 100);
}

/**
 * Redraw the displayed Scene's terrain from its flags: the terrain presentation, spawn images, placeables and, once
 * Sequencer is ready, the looping terrain effects. scheduleTerrainRefresh debounces Scene and wall changes into one
 * call 100 ms later.
 */
function refreshTerrainRuntime({ resetPresentation = false } = {}) {
  const scene = globalThis.canvas?.scene;
  if (!scene) return;
  const generation = ++terrainProjectionGeneration;
  const grid = readTerrainGrid(scene);
  const zones = readTerrainZones(scene);
  const showHiddenSpawns = game.user.isGM;
  const presentation = projectTerrainPresentation(grid, zones, { showHiddenSpawns });
  if (resetPresentation) onCanvasReadyTerrainPresentation(presentation, new FoundryDiagnostics());
  else onTerrainPresentationChanged(presentation, new FoundryDiagnostics());
  void readTerrainSpawnImages(grid, { includeHidden: showHiddenSpawns }).then(spawnImages => {
    if (generation !== terrainProjectionGeneration || scene.id !== globalThis.canvas?.scene?.id) return;
    if (!Object.keys(spawnImages).length) return;
    onTerrainPresentationChanged(projectTerrainPresentation(grid, zones, { showHiddenSpawns, spawnImages }), new FoundryDiagnostics());
  }).catch(error => {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Terrain spawn projection failed');
  });
  void syncTerrainPlaceables(scene).catch(error => {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Terrain placeable reconciliation failed');
  });
  if (terrainEffectGateOpen) void syncTerrainEffects(grid, globalThis.canvas?.grid?.size);
}

/**
 * Rebuild terrain effects once Sequencer's effect manager is ready (sequencerEffectManagerReady), because it clears
 * persistent effects after canvasReady. Passes at 400 and 1500 ms replay any effect it dropped in the meantime.
 */
function openTerrainEffectGate() {
  if (terrainEffectGateOpen) return;
  terrainEffectGateOpen = true;
  const scene = globalThis.canvas?.scene;
  if (!scene) return;
  void syncTerrainEffects(readTerrainGrid(scene), globalThis.canvas?.grid?.size);
  for (const delay of [400, 1500]) {
    const timer = setTimeout(() => {
      terrainRuntimeTimers.delete(timer);
      void syncTerrainEffects(readTerrainGrid(globalThis.canvas?.scene), globalThis.canvas?.grid?.size, {
        trustPending: false
      });
    }, delay);
    terrainRuntimeTimers.add(timer);
  }
}

function closeTerrainEffectGate() {
  terrainEffectGateOpen = false;
}

function clearTerrainRuntimeTimers() {
  terrainProjectionGeneration += 1;
  if (terrainRefreshTimer) clearTimeout(terrainRefreshTimer);
  terrainRefreshTimer = null;
  for (const timer of terrainRuntimeTimers) clearTimeout(timer);
  terrainRuntimeTimers.clear();
}
