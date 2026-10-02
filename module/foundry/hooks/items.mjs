/** @layer foundry/hooks */
import { isActiveGm } from '../adapters/services/host.mjs';

/* -------------------------------------------- */
/*  Item lifecycle input                        */
/* -------------------------------------------- */

/**
 * Build the Item hooks that keep saved uses consistent: when an Item's maximum moves, the host client clamps its
 * current uses back under the new effective maximum, exactly once per change.
 * @param {{clampItemUses: Function}} options The Item write that clamps the uses.
 */
export function createItemUsesHookHandlers({ clampItemUses }) {
  return Object.freeze({
    onItemUsesMaxChanged(item, changes, options = {}) {
      if (!isActiveGm() || options.emblemUsesClamp === true) return;
      if (!usesMaxTouched(changes)) return;
      void clampItemUses(item);
    }
  });
}

/**
 * On the host client, tidy an item an Actor has just received (normalizeCreatedItem), and tell the user who added
 * it when it is refused, as a second Mount is.
 * @param {{normalizeCreatedItem: Function, notify?: object}} options The Item write and the refusal notice.
 */
export function createItemArrivalHookHandlers({ normalizeCreatedItem, notify = null }) {
  return Object.freeze({
    async onItemArrived(item, options = {}, userId = '') {
      if (!isActiveGm() || item?.parent?.documentName !== 'Actor' || item.parent.pack) return;
      const outcome = await normalizeCreatedItem(item, options);
      if (outcome?.reasonCode) notify?.inventoryRefused?.(outcome.reasonCode, outcome.data, userId);
    }
  });
}

/**
 * Invalidate the authoring Item catalog when a compendium Item changes.
 * @param {{invalidateItemCatalog: Function}} options Drops the cached catalog.
 */
export function createItemCatalogHookHandlers({ invalidateItemCatalog }) {
  return Object.freeze({
    onCatalogItemChanged(item) {
      if (!item?.pack) return;
      invalidateItemCatalog();
    }
  });
}

function usesMaxTouched(changes) {
  const uses = changes?.system?.uses;
  if (uses && typeof uses === 'object' && Object.hasOwn(uses, 'max')) return true;
  return Object.hasOwn(changes?.system ?? {}, 'uses.max') || Object.hasOwn(changes ?? {}, 'system.uses.max');
}
