/** @layer foundry/adapters/document-writes */
import { EQUIPMENT_REFUSALS } from '../../../contracts/domains/items.mjs';
import { OWNED_UNIT_FACTIONS } from '../../../contracts/domains/characters.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';
import { readCustomTerrainPresets } from '../services/json-files.mjs';

/* -------------------------------------------- */
/*  Item Authoring Persistence                  */
/* -------------------------------------------- */

/**
 * Item writes for the GM authoring tools, behind ItemAuthoringService (engine/authoring.mjs) and
 * api.items.authoring. The service checks the caller may author before the write runs.
 */
export class FoundryItemAuthoringRepository {
  async resolve(uuid) { return fromUuid(uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'resolve'); return null; }); }

  /** Create a Staff from a Spell, beside it in the same actor or compendium. null if the UUID isn't a Spell. */
  async copySpellAsStaff(uuid) {
    const sourceDocument = await this.resolve(uuid);
    if (!isItem(sourceDocument) || sourceDocument.type !== 'Spell') return null;
    const source = sourceDocument.toObject();
    delete source._id;
    source.type = 'Equipment';
    source.name = `Staff of ${sourceDocument.name}`;
    source.system ??= {};
    source.system.itemType = source.system.itemType === 'Attack' ? 'Staff' : 'Staff (U)';
    const [created] = await sourceDocument.constructor.createDocuments([source], {
      parent: sourceDocument.parent, pack: sourceDocument.pack
    });
    return created ?? null;
  }

  /** The custom terrain presets by name, for the terrain picker in the item effect editor. */
  async getTerrainPresets() {
    const presets = await readCustomTerrainPresets();
    return Object.fromEntries(presets.map(preset => [preset.name, { icon: preset.icon, params: preset.params }]));
  }
}

/* -------------------------------------------- */
/*  Uses                                        */
/* -------------------------------------------- */

/**
 * Bring an Item's current uses back under its effective maximum after the maximum changed. Called by the
 * active GM's Item update hook (createItemUsesHookHandlers in foundry/hooks/items.mjs).
 * @param {Item} item The Item whose `uses.max` changed.
 * @returns {Promise<boolean>} Whether a write was needed.
 */
export async function clampItemUses(item) {
  if (!isItem(item) || !item.system?.uses || typeof item.getEffectiveMaxUses !== 'function') return false;
  const maximum = item.getEffectiveMaxUses();
  const current = Number(item.system.uses.current) || 0;
  if (current <= maximum) return false;
  await item.update({ 'system.uses.current': maximum }, { emblemUsesClamp: true });
  return true;
}

/* -------------------------------------------- */
/*  Arrival                                     */
/* -------------------------------------------- */

/**
 * Fill an Item to its effective maximum, writing the persisted maximum too unless the uses are conditional.
 * @param {Item} item The Item to fill.
 * @returns {Promise<boolean>} Whether a write was needed.
 */
async function fillItemUses(item) {
  const uses = item?.system?.uses;
  if (!isItem(item) || !uses || typeof item.getEffectiveMaxUses !== 'function') return false;
  const maximum = item.getEffectiveMaxUses();
  const updates = {};
  if (uses.type !== 'conditional' && Number(uses.max) !== maximum) updates['system.uses.max'] = maximum;
  if (Number(uses.current) !== maximum) updates['system.uses.current'] = maximum;
  if (!Object.keys(updates).length) return false;
  await item.update(updates, { emblemUsesClamp: true });
  return true;
}

/**
 * Tidy an Item an Actor has just received. Called by the active GM's createItem hook
 * (createItemArrivalHookHandlers in foundry/hooks/items.mjs). The item arrives unequipped, and a Lord or Retainer's
 * copy stops being stealable. A new item is filled to its maximum uses, while one moved by a transfer or combat
 * settlement keeps its uses. A second Mount is deleted, since a unit holds only one. Coinpurses are left alone.
 * @param {Item} item The created Item.
 * @param {object} [options] The creation options.
 * @returns {Promise<{ok: boolean, reasonCode: string, data?: object}>} A refused second Mount carries its reasonCode.
 */
export async function normalizeCreatedItem(item, options = {}) {
  const actor = item?.parent;
  if (!isItem(item) || actor?.documentName !== 'Actor') return NOTHING_NORMALIZED;
  if (String(item.system?.itemType ?? '') === 'Coinpurse') return NOTHING_NORMALIZED;
  if (String(item.system?.itemType ?? '') === 'Mount') {
    const held = collectionValues(actor.items)
      .find(other => other.id !== item.id && String(other.system?.itemType ?? '') === 'Mount');
    if (held) {
      await actor.deleteEmbeddedDocuments('Item', [item.id]);
      return Object.freeze({
        ok: false,
        reasonCode: EQUIPMENT_REFUSALS.MOUNT_ALREADY_ACTIVE,
        data: Object.freeze({ actorName: actor.name, itemName: held.name })
      });
    }
  }
  if (item.system?.uses && options.emblemTransfer !== true && options.emblemCombatSettlement !== true) {
    await fillItemUses(item);
  }
  const updates = { 'system.isWielded': false, 'system.isWorn': false, 'system.isEquipped': false };
  const stealable = String(item.system?.stealable?.flag ?? '');
  if (stealable && stealable !== 'None' && OWNED_UNIT_FACTIONS.includes(String(actor.system?.faction?.role ?? ''))) {
    updates['system.stealable.flag'] = 'None';
  }
  await item.update(updates);
  return NORMALIZED;
}

const NOTHING_NORMALIZED = Object.freeze({ ok: false, reasonCode: '' });
const NORMALIZED = Object.freeze({ ok: true, reasonCode: '' });

/* -------------------------------------------- */
/*  Foundry Helpers                             */
/* -------------------------------------------- */

function isItem(document) {
  return document?.documentName === 'Item';
}
