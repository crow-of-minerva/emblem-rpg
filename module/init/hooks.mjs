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
