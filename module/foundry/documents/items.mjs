/** @layer foundry/documents */
import { admitNativeWrite } from '../adapters/services/authority.mjs';
import { REFINEMENT_OUTCOME_CODES } from '../../contracts/domains/items.mjs';
import {
  evaluateScaling,
  baseDurability,
  baseItemName,
  databaseRefinementAllowed,
  forgingTier,
  prepareItemBaseData,
  prepareItemDerivedData,
  reconcileRefinement,
  refinementRenameReset,
  refinementTier,
  seedTierXpRequirement,
  settleStoredItemState
} from '../../game/items/rules.mjs';
/* -------------------------------------------- */
/*  Item document                               */
/* -------------------------------------------- */
const ITEM_TYPE_DEFAULTS = Object.freeze({
  Equipment: 'Weapon',
  Ability: 'Passive',
  Spell: 'Attack',
  Consumable: 'Potion',
  Miscellaneous: 'Other'
});

const ITEM_DOCUMENT_OUTCOMES = REFINEMENT_OUTCOME_CODES;

/** The stored fields an Item write is settled against: uses, the refinement tier that raises them, and wield state. */
const STORED_STATE_FIELDS = Object.freeze(['uses', 'craftingData', 'isWielded', 'isEquipped', 'isWorn']);

/** Raise emblemRpg.itemDocumentOutcome, which init/hooks.mjs turns into a notification. */
function publishDocumentOutcome(outcome) {
  Hooks.callAll('emblemRpg.itemDocumentOutcome', Object.freeze(outcome));
}

/* -------------------------------------------- */
/*  Item behavior                               */
/* -------------------------------------------- */
/**
 * The system's Item class (CONFIG.Item.documentClass, set in init/registrations.mjs). It prepares item data through
 * game/items/rules.mjs, keeps a carried copy's "(+N)" name and forging XP in agreement, and passes every native write
 * through admitNativeWrite (services/authority.mjs).
 */
export class EmblemItem extends Item {
  /**
   * Items saved before forgingXP existed show their refinement only in the "(+N)" name suffix. They get the forging
   * XP that tier requires, so they keep it.
   */
  static migrateData(data) {
    const crafting = data?.system?.craftingData;
    const named = refinementTier(data?.name);
    if (crafting && typeof crafting === 'object' && crafting.forgingXP === undefined && named > 0) {
      const authored = crafting.refinement?.tiers?.[named - 1]?.xpReq;
      crafting.forgingXP = authored !== undefined ? Math.max(0, Number(authored) || 0)
        : seedTierXpRequirement(named - 1, baseDurability(data.system));
    }
    return super.migrateData(data);
  }

  /** Staff and a Trusted owner delete natively. A Player's delete is refused before Foundry sends it. */
  async _preDelete(options, user) {
    if (!admitNativeWrite(user, this, 'delete')) return false;
    return super._preDelete(options, user);
  }

  prepareBaseData() {
    super.prepareBaseData();
    if (this.type === 'Class' || this.type === 'Resource') return;
    const source = foundry.utils.deepClone(this.system);
    if (!source.itemType) source.itemType = ITEM_TYPE_DEFAULTS[this.type] ?? '';
    Object.assign(this.system, prepareItemBaseData(this.type, source));
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    const result = prepareItemDerivedData({
      documentType: this.type,
      system: foundry.utils.deepClone(this.system)
    });
    if (result.system) Object.assign(this.system, result.system);
    this._emblemRefinementTier = result.tier;
    this._emblemBrokenArmor = result.brokenArmor;
  }

  get refinementTier() { return this._emblemRefinementTier ?? forgingTier(this.system?.craftingData); }
  get appliedRefinement() {
    const tier = this.refinementTier;
    return tier ? this.system?.craftingData?.refinement?.tiers?.[tier - 1]?.modifiers ?? null : null;
  }
  get isBrokenArmor() { return this._emblemBrokenArmor ?? false; }

  /** The item's maximum uses. A conditional maximum on an owned item scales with the owner's stats. */
  getEffectiveMaxUses() {
    const uses = this.system?.uses;
    if (!uses) return 0;
    if (uses.type !== 'conditional' || !this.parent) return Math.max(0, Number(uses.max) || 0);
    const stored = this._source.system.uses ?? uses;
    const base = Math.max(1, Number(stored.max) || 1);
    const facts = { name: this.name, system: stored };
    return Math.max(0, Math.floor(evaluateScaling(this.parent.system, base, stored.scaling, facts)));
  }

  /**
   * Refuse a refined name or forging XP on a world or compendium item. On a carried Equipment copy, bring the name
   * suffix and forging XP into agreement. Then fill in the item type and settle stored uses and wield state.
   */
  async _preCreate(data, options, user) {
    if (!admitNativeWrite(user, this, 'create')) return false;
    const name = data.name ?? this.name;
    const crafting = this._source.system.craftingData;
    if (!databaseRefinementAllowed({ embedded: Boolean(this.parent), name, forgingXP: crafting?.forgingXP })) {
      publishDocumentOutcome({
        code: ITEM_DOCUMENT_OUTCOMES.DATABASE_REFINEMENT_FORBIDDEN,
        data: { itemName: name }
      });
      return false;
    }
    if (this.parent && this.type === 'Equipment' && crafting) {
      const named = refinementTier(name);
      const settled = reconcileRefinement({ name, crafting, suffixWins: named > 0 && named !== forgingTier(crafting) });
      const source = {};
      if (settled.name !== name) source.name = settled.name;
      if (settled.forgingXP !== (Number(crafting.forgingXP) || 0)) source['system.craftingData.forgingXP'] = settled.forgingXP;
      if (Object.keys(source).length) this.updateSource(source);
    }
    const itemType = data.system?.itemType || ITEM_TYPE_DEFAULTS[data.type ?? this.type];
    if (itemType && !data.system?.itemType) this.updateSource({ 'system.itemType': itemType });
    const settled = settleStoredItemState({
      documentType: this.type, embedded: Boolean(this.parent), system: this._source.system,
      ownerSystem: this.parent?.system ?? null, name: this.name
    });
    if (settled) this.updateSource(settled);
    return super._preCreate(data, options, user);
  }

  /**
   * The same checks as _preCreate for an update. Renaming a refined copy to a different base item also resets its
   * stats to that base item's, and each outcome is announced through publishDocumentOutcome.
   */
  async _preUpdate(changed, options, user) {
    if (!admitNativeWrite(user, this, 'update', changed)) return false;
    const expanded = foundry.utils.expandObject(changed);
    const nextName = Object.hasOwn(changed, 'name') ? String(changed.name ?? '') : this.name;
    const changedXP = expanded.system?.craftingData?.forgingXP;
    if (!databaseRefinementAllowed({ embedded: this.isEmbedded, name: nextName, forgingXP: changedXP })) {
      publishDocumentOutcome({
        code: ITEM_DOCUMENT_OUTCOMES.DATABASE_REFINEMENT_FORBIDDEN,
        data: { itemName: nextName }
      });
      delete changed.name;
      return false;
    }
    if (this.isEmbedded && this.type === 'Equipment' && (Object.hasOwn(changed, 'name') || expanded.system?.craftingData)) {
      const crafting = foundry.utils.mergeObject(
        this._source.system.craftingData ?? {}, expanded.system?.craftingData ?? {}, { inplace: false }
      );
      const suffixWins = Object.hasOwn(changed, 'name') && refinementTier(nextName) !== refinementTier(this.name);
      const settled = reconcileRefinement({ name: nextName, crafting, suffixWins });
      if (settled.name !== nextName) changed.name = settled.name;
      if (settled.forgingXP !== (Number(crafting.forgingXP) || 0)) {
        foundry.utils.setProperty(changed, 'system.craftingData.forgingXP', settled.forgingXP);
      }
    }
    const finalName = Object.hasOwn(changed, 'name') ? String(changed.name ?? '') : this.name;
    const wantedBaseName = baseItemName(finalName);
    if (this.type === 'Equipment' && this.refinementTier && wantedBaseName !== baseItemName(this.name)) {
      const baseItem = game.items.find(item => item.name === wantedBaseName && item.type === this.type);
      const reset = refinementRenameReset({
        documentType: this.type,
        embedded: this.isEmbedded,
        oldName: this.name,
        newName: finalName,
        baseSystem: baseItem?.toObject()?.system
      });
      if (reset) {
        changed.system ??= {};
        changed.system.weapon = foundry.utils.deepClone(reset.system.weapon);
        changed.system.armor = foundry.utils.deepClone(reset.system.armor);
        changed.system.wgt = reset.system.wgt;
        changed.system.uses ??= {};
        changed.system.uses.max = reset.system.uses.max;
        publishDocumentOutcome({
          code: reset.refined ? ITEM_DOCUMENT_OUTCOMES.REFINEMENT_RESET : ITEM_DOCUMENT_OUTCOMES.REFINEMENT_REVERTED,
          data: { itemName: finalName, oldName: this.name, baseName: reset.baseName }
        });
      } else if (this.isEmbedded) {
        publishDocumentOutcome({
          code: ITEM_DOCUMENT_OUTCOMES.REFINEMENT_BASE_MISSING,
          data: { baseName: wantedBaseName }
        });
      }
    }
    const settled = settleStoredItemState({
      documentType: this.type, embedded: this.isEmbedded,
      system: storedStateAfter(this._source.system, foundry.utils.expandObject(changed).system),
      ownerSystem: this.parent?.system ?? null, name: finalName
    });
    for (const [path, value] of Object.entries(settled ?? {})) foundry.utils.setProperty(changed, path, value);
    return super._preUpdate(changed, options, user);
  }
}

/** The fields settleStoredItemState reads, as they will be stored once `change` lands on `source`. */
function storedStateAfter(source = {}, change = {}) {
  const pick = value => Object.fromEntries(STORED_STATE_FIELDS.filter(key => value?.[key] !== undefined)
    .map(key => [key, value[key]]));
  return foundry.utils.mergeObject(pick(source), pick(change), { inplace: false });
}
