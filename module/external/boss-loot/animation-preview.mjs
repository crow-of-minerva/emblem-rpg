/** @layer external/boss-loot */
import { moduleActive } from '../host.mjs';
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Animations Preview                          */
/* -------------------------------------------- */
const MODULE_ID = 'boss-loot-assets-premium';
// A file inside the premium module, not a published API, so a module update may move or change it.
const PREVIEW_SCRIPT = `modules/${MODULE_ID}/scripts/apps/AnimationPreview.js`;

/** Whether the Boss Loot asset module is active, so the scene controls can offer its Animations Preview. */
export function bossLootPreviewAvailable() {
  return moduleActive(MODULE_ID);
}

/** Open Boss Loot's Animations Preview by importing the module's own script. Returns false if it can't open. */
export async function openBossLootAnimationPreview(options = {}) {
  if (!bossLootPreviewAvailable()) return false;
  try {
    const route = foundry.utils.getRoute(PREVIEW_SCRIPT);
    const module = await import(route);
    if (typeof module?.animationPreview !== 'function') return false;
    module.animationPreview(options);
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Boss Loot Animations Preview failed to open');
    return false;
  }
}
