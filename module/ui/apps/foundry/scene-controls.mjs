/** @layer ui/apps/foundry */
import { ENCOUNTER_PHASE_FLAG } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import {
  bossLootPreviewAvailable,
  openBossLootAnimationPreview
} from '../../../external/boss-loot/animation-preview.mjs';
import { TerrainBuilder } from '../menus/terrain-builder/app.mjs';
import { onTerrainWallChanged } from '../menus/terrain-builder/overlay.mjs';
import { captureAdvanceIntent } from './combat-tracker.mjs';

/* -------------------------------------------- */
/*  Encounter scene controls                    */
/* -------------------------------------------- */

/** Add the GM-only encounter phase group beside the Token controls. */
export function onGetEncounterSceneControls(controls) {
  if (!game.user.isGM || controls['emblem-encounter']) return;
  const running = Boolean(activeScene()?.getFlag(SYSTEM_ID, ENCOUNTER_PHASE_FLAG));
  controls['emblem-encounter'] = {
    name: 'emblem-encounter',
    title: 'Encounter',
    icon: 'fas fa-flag',
    order: (controls.tokens?.order ?? 0) + 0.6,
    visible: true,
    // No activeTool: every tool here is a button, and Foundry fires the active tool's onChange whenever the GM
    // opens or leaves the group.
    tools: {
      begin: {
        name: 'begin',
        order: 1,
        title: 'Begin Encounter',
        icon: 'fas fa-play',
        button: true,
        visible: !running,
        onChange: () => void game.emblemRpg.api.encounters.begin(currentSceneUuid())
      },
      advancePhase: {
        name: 'advancePhase',
        order: 2,
        title: 'Advance Phase',
        icon: 'fas fa-forward',
        button: true,
        visible: running,
        onChange: () => void game.emblemRpg.api.encounters.advancePhase(captureAdvanceIntent(currentSceneUuid()))
      },
      end: {
        name: 'end',
        order: 3,
        title: 'End Encounter',
        icon: 'fas fa-stop',
        button: true,
        visible: running,
        onChange: () => void game.emblemRpg.api.encounters.end(currentSceneUuid())
      }
    }
  };
}

/** Rebuild the GM's encounter controls when a Scene's phase flag changes, so the right buttons show. */
export function onEncounterPhaseChanged(scene, changes) {
  const flags = changes.flags?.[SYSTEM_ID];
  if (!flags || !(ENCOUNTER_PHASE_FLAG in flags || `-=${ENCOUNTER_PHASE_FLAG}` in flags)) return;
  if (scene.id !== activeScene()?.id) return;
  if (!game.user.isGM) return;
  // A plain render reuses the old tool list; reset re-runs getSceneControlButtons.
  globalThis.ui?.controls?.render?.({ reset: true });
}

/* -------------------------------------------- */
/*  Scene lookups                               */
/* -------------------------------------------- */

function activeScene() {
  return globalThis.canvas?.scene ?? globalThis.game?.scenes?.active ?? null;
}

function currentSceneUuid() {
  return String(activeScene()?.uuid ?? '');
}

/* -------------------------------------------- */
/*  Scene controls                              */
/* -------------------------------------------- */
let lightObjectsVisible = false;
let soundObjectsVisible = false;

/** Add the GM Terrain Builder group to Foundry Scene controls. */
export function onGetSceneControlButtons(controls) {
  if (!game.user.isGM || controls['emblem-terrain']) return;
  const tokenOrder = controls.tokens?.order ?? 0;
  controls['emblem-terrain'] = {
    name: 'emblem-terrain',
    title: 'Terrain Builder',
    icon: 'fas fa-mountain-sun',
    order: tokenOrder + 0.5,
    visible: true,
    activeTool: 'paint',
    onChange: (_event, active) => {
      const selected = active ?? ui.controls.control?.name === 'emblem-terrain';
      if (selected && globalThis.canvas?.tiles?.active) globalThis.canvas.tiles.deactivate();
      if (selected) void TerrainBuilder.open();
      else TerrainBuilder.closeFromControl();
    },
    tools: {
      paint: {
        name: 'paint',
        order: 1,
        title: 'Paint Terrain',
        icon: 'fas fa-brush',
        // Foundry also calls onChange with false when the tool is deactivated, so open only on activation.
        onChange: (_event, active) => { if (active !== false) void TerrainBuilder.open(); }
      },
      showLights: {
        name: 'showLights',
        order: 10,
        title: 'Show Light Objects',
        icon: 'fas fa-lightbulb',
        toggle: true,
        active: lightObjectsVisible,
        onChange: (_event, active) => setTerrainPlaceableVisibility('lighting', active)
      },
      showSounds: {
        name: 'showSounds',
        order: 11,
        title: 'Show Sound Objects',
        icon: 'fas fa-volume-high',
        toggle: true,
        active: soundObjectsVisible,
        onChange: (_event, active) => setTerrainPlaceableVisibility('sounds', active)
      }
    }
  };
  if (bossLootPreviewAvailable()) {
    controls['emblem-terrain'].tools.bossLootPreview = {
      name: 'bossLootPreview',
      order: 3,
      title: 'Boss Loot Animations Preview',
      icon: 'blap blap-icon-animation-preview',
      button: true,
      onChange: () => void openBossLootAnimationPreview()
    };
  }
}

/**
 * On canvasReady, close a Terrain Builder that survived the Scene change, and apply the light and sound
 * visibility toggles to the new canvas. onCanvasTearDownTerrainControls closes the builder before the change.
 */
export function onCanvasReadyTerrainControls() {
  void TerrainBuilder.closeForCanvasChange();
  applyTerrainPlaceableVisibility();
}

/** Close the Builder before Foundry destroys the Scene-owned Canvas beneath it. */
export function onCanvasTearDownTerrainControls() {
  return TerrainBuilder.closeForCanvasChange();
}

/** Refresh builder wall visuals after a wall document changes. */
export function onTerrainWallDocumentChanged() {
  onTerrainWallChanged();
}

/* -------------------------------------------- */
/*  Placeable visibility                        */
/* -------------------------------------------- */
function setTerrainPlaceableVisibility(layerName, visible) {
  if (layerName === 'lighting') lightObjectsVisible = Boolean(visible);
  else soundObjectsVisible = Boolean(visible);
  applyTerrainPlaceableVisibility();
}

function applyTerrainPlaceableVisibility() {
  setLayerVisibility(globalThis.canvas?.lighting, lightObjectsVisible);
  setLayerVisibility(globalThis.canvas?.sounds, soundObjectsVisible);
}

function setLayerVisibility(layer, visible) {
  if (layer?.objects) layer.objects.visible = Boolean(visible);
}
