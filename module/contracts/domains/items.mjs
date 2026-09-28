/** @layer contracts/domains */
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */
export const WEAPON_PROFICIENCIES = Object.freeze([
  'brawling', 'blade', 'polearm', 'heavy', 'bow', 'covert', 'elemental', 'divine', 'occult', 'arcane'
]);

/** The weapon proficiencies that are magic schools: an Item that needs one is magic, whatever its type. */
export const MAGIC_PROFICIENCIES = Object.freeze(['arcane', 'divine', 'elemental', 'occult']);

export const ITEM_SUBTYPES = Object.freeze({
  Equipment: Object.freeze(['Weapon', 'Armor', 'Staff', 'Staff (U)', 'Shield', 'Accessory']),
  Ability: Object.freeze(['Active', 'Passive', 'Weapon Art', 'Mount']),
  Spell: Object.freeze(['Attack', 'Utility']),
  Consumable: Object.freeze(['Potion', 'Bomb', 'Booster', 'Promotion']),
  Miscellaneous: Object.freeze(['Coinpurse', 'Other'])
});

export const AURA_TARGET_TYPES = Object.freeze(['All', 'Friendly+Self', 'Friendly', 'Hostile']);

export const EQUIPMENT_EFFECT_KINDS = Object.freeze({
  WIELD: 'wield',
  ARMOR: 'armor',
  MOUNT: 'mount'
});

export const EQUIPMENT_EFFECT_IDS = Object.freeze({
  WIELD: 'emblemWieldMark1',
  ARMOR: 'emblemArmorMark1'
});

/** Rank labels used by item and character presentation. The index is the rank, so rank zero shows E. */
export const PROFICIENCY_RANK_LETTERS = Object.freeze(['E', 'D', 'C', 'B', 'A', 'S']);

export const CLASS_TIERS = Object.freeze(['Novice', 'Intermediate', 'Advanced', 'Unplayable', 'Unique']);
export const RESOURCE_TYPES = Object.freeze(['Material', 'Textile', 'Reagent', 'Ingredient']);
export const FOOD_TYPES = Object.freeze([
  'Grain', 'Dairy', 'Meat', 'Spice', 'Legume', 'Vegetable', 'Fruit', 'Nut', 'Seafood'
]);

/** The cooking stat each food type feeds, as an Ingredient's type is labelled. */
export const FOOD_TYPE_STATS = Object.freeze({
  Grain: 'HP', Dairy: 'Bld', Meat: 'Mgt', Spice: 'Agi', Legume: 'Tqn',
  Vegetable: 'Wit', Fruit: 'Cha', Nut: 'Def', Seafood: 'Res'
});

export const ITEM_ACTIVATION_SUPPORT = Object.freeze({
  rngTypes: Object.freeze(['Single', 'Multiple', 'Line', 'Location', 'Area', 'Cone']),
  aimedRngTypes: Object.freeze(['Location', 'Cone']),
  actionTypes: Object.freeze(['Standard Action', 'Bonus Action']),
  losRules: Object.freeze(['normal', 'ignoreHeight', 'ignoreLoS']),
  maxTargets: 16,
  maxParams: 16,
  maxParamLength: 64,
  maxCell: 4096
});

/** Ability names whose destination is selected on the board before item activation. */
export const FORCED_MOVEMENT_ABILITIES = Object.freeze({
  SHOVE: 'Shove',
  RETRIEVE: 'Retrieve'
});

/** Abilities that reach their single target as a melee strike does, so an airborne target must be in melee reach. */
export const MELEE_REACH_ABILITIES = Object.freeze([
  FORCED_MOVEMENT_ABILITIES.SHOVE,
  FORCED_MOVEMENT_ABILITIES.RETRIEVE,
  'Swap'
]);

/** What Free Exploration lets a unit use, by document type: healing, buffs, promotions and mounts only. */
export const EXPLORATION_ACTIVATION_SUBTYPES = Object.freeze({
  Consumable: Object.freeze(['Potion', 'Booster', 'Promotion']),
  Ability: Object.freeze(['Mount'])
});

/** Ability that item activation runs without a board lock, cinematic, XP award or turn end. */
export const UNLOCKED_ACTIVATION_ITEM_NAME = 'Dash';

/**
 * An Item use counts as one and a half weapon hits of proficiency experience. At two points per hit that's three
 * points, before the unit's own multiplier.
 */
export const ITEM_USE_PROFICIENCY_HIT_RATIO = 1.5;

export const ITEM_ACTIVATION_TRIGGERS = Object.freeze([
  'onActivation', 'onFailedSave', 'onSucceedSave', 'onFailedCheck', 'onSucceedCheck'
]);

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
const ACTIVATION_INTENT_KEYS = new Set([
  'sourceTokenUuid', 'itemUuid', 'targetTokenUuids', 'aim', 'params', 'placement', 'cinematic'
]);

/** Validate and detach the public item-activation intent without admitting mechanical claims. */
export function normalizeItemActivationIntent(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).some(key => !ACTIVATION_INTENT_KEYS.has(key))) return null;
  const sourceTokenUuid = String(payload.sourceTokenUuid ?? '');
  const itemUuid = String(payload.itemUuid ?? '');
  if (!sourceTokenUuid.includes('.Token.') || !itemUuid) return null;

  const rawTargets = payload.targetTokenUuids ?? [];
  if (!Array.isArray(rawTargets) || rawTargets.length > ITEM_ACTIVATION_SUPPORT.maxTargets) return null;
  if (!rawTargets.every(uuid => typeof uuid === 'string' && uuid.includes('.Token.') && uuid.length <= 512)) return null;
  const targetTokenUuids = [...new Set(rawTargets)];
  if (targetTokenUuids.length !== rawTargets.length) return null;

  const aim = normalizeActivationCell(payload.aim);
  if (aim === undefined) return null;
  const placement = normalizeActivationCell(payload.placement);
  if (placement === undefined) return null;
  const params = normalizeActivationParams(payload.params);
  if (params === null) return null;

  return Object.freeze({
    sourceTokenUuid,
    itemUuid,
    targetTokenUuids: Object.freeze(targetTokenUuids),
    aim,
    placement,
    params,
    cinematic: payload.cinematic !== false
  });
}

/* -------------------------------------------- */
/*  Refusals and receipts                       */
/* -------------------------------------------- */
/** Why an inventory change was refused. Each refusal carries the names its notice text needs. */
export const EQUIPMENT_REFUSALS = Object.freeze({
  NOT_EQUIPPABLE: 'inventory.not-equippable',
  HANDOVER_IN_COMBAT: 'inventory.handover-in-combat',
  TURN_OVER: 'inventory.turn-over',
  ACTION_REQUIRED: 'inventory.action-required',
  ITEM_DEPLETED: 'inventory.item-depleted',
  PROFICIENCY_UNKNOWN: 'inventory.proficiency-unknown',
  PROFICIENCY_REQUIRED: 'inventory.proficiency-required',
  ARMOR_IN_COMBAT: 'inventory.armor-in-combat',
  ARMOR_PROFICIENCY_UNKNOWN: 'inventory.armor-proficiency-unknown',
  ARMOR_PROFICIENCY_REQUIRED: 'inventory.armor-proficiency-required',
  MOUNT_ALREADY_ACTIVE: 'inventory.mount-already-active',
  REQUIREMENTS_UNMET: 'inventory.requirements-unmet'
});

/** Why an Item refinement write was refused or rewound while the document prepared itself. */
export const REFINEMENT_OUTCOME_CODES = Object.freeze({
  DATABASE_REFINEMENT_FORBIDDEN: 'item.database-refinement-forbidden',
  REFINEMENT_RESET: 'item.refinement-reset',
  REFINEMENT_REVERTED: 'item.refinement-reverted',
  REFINEMENT_BASE_MISSING: 'item.refinement-base-missing'
});

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */
/** Item activation and saving-throw timings. The engine waits on its own clock, not on Dice So Nice. */
export const ITEM_ACTIVATION_TIMING = Object.freeze({
  diceSettleHold: 2600,
  castLeadIn: 700,
  castAnimationDelay: 100,
  castRevertFallback: 800,
  settleTail: 2000
});

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
export const ITEM_ACTIVATION_PRESENTATION_KIND = 'item-activation';

export const ITEM_ACTIVATION_PRESENTATION_BEATS = Object.freeze({
  LEAD_IN: 'lead-in',
  CAST: 'cast',
  NOTICE: 'notice',
  DAMAGE_CARD: 'damage-card',
  RANK_UP: 'rank-up',
  END: 'end'
});

/** Build the serializable presentation transcript for one activation beat. */
export function itemActivationPresentationMessage(beat, data = {}) {
  if (!Object.values(ITEM_ACTIVATION_PRESENTATION_BEATS).includes(beat)) {
    throw new TypeError(`Unknown item activation presentation beat: ${beat}`);
  }
  return Object.freeze({ kind: ITEM_ACTIVATION_PRESENTATION_KIND, beat, ...structuredClone(data) });
}

/** Accept only bounded detached activation transcripts at the presentation socket. */
export function isItemActivationPresentationMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.kind !== ITEM_ACTIVATION_PRESENTATION_KIND) return false;
  if (!Object.values(ITEM_ACTIVATION_PRESENTATION_BEATS).includes(value.beat)) return false;
  try { return JSON.stringify(value).length <= 200000; } catch { return false; }
}

/** A refused inventory change, told only to the user whose change it was. */
export const INVENTORY_REFUSAL_PRESENTATION_KIND = 'inventory-refusal';

const INVENTORY_REFUSAL_KEYS = Object.freeze(['kind', 'reasonCode', 'data']);
const MAX_INVENTORY_REFUSAL_DATA_LENGTH = 4000;

/**
 * Build the notice one refused inventory change sends to the user who made it.
 * @param {string} reasonCode The refusal's reason code.
 * @param {object} [data] The detached names its text reads, such as the unit and the Item.
 * @returns {Readonly<{kind: string, reasonCode: string, data: object}>}
 */
export function inventoryRefusalPresentationMessage(reasonCode, data = {}) {
  const detail = plainRecord(data) ? structuredClone(data) : {};
  return Object.freeze({
    kind: INVENTORY_REFUSAL_PRESENTATION_KIND, reasonCode: String(reasonCode ?? ''), data: detail
  });
}

/** Accept only a bounded refusal notice at the presentation socket. */
export function isInventoryRefusalPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== INVENTORY_REFUSAL_PRESENTATION_KIND) return false;
  if (!exactKeys(value, INVENTORY_REFUSAL_KEYS) || !boundedText(value.reasonCode, 128)) return false;
  if (!plainRecord(value.data)) return false;
  try { return JSON.stringify(value.data).length <= MAX_INVENTORY_REFUSAL_DATA_LENGTH; } catch { return false; }
}

/** What went to the Convoy when a unit outgrew its equipment slots, told to the owners of that unit. */
export const INVENTORY_CAPACITY_NOTICE_KIND = 'inventory-capacity-notice';

const INVENTORY_CAPACITY_KEYS = Object.freeze(['kind', 'actorName', 'convoyName', 'itemNames']);
const CAPACITY_NOTICE_NAME_LIMIT = 32;

/**
 * Build the notice the capacity reconciliation sends the unit's owners after moving their surplus equipment.
 * @param {{actorName?: string, convoyName?: string, itemNames?: string[]}} moved What left and where it went.
 * @returns {Readonly<{kind: string, actorName: string, convoyName: string, itemNames: ReadonlyArray<string>}>}
 */
export function inventoryCapacityNoticeMessage({ actorName = '', convoyName = '', itemNames = [] } = {}) {
  return Object.freeze({
    kind: INVENTORY_CAPACITY_NOTICE_KIND,
    actorName: String(actorName ?? ''),
    convoyName: String(convoyName ?? ''),
    itemNames: Object.freeze((Array.isArray(itemNames) ? itemNames : [])
      .slice(0, CAPACITY_NOTICE_NAME_LIMIT).map(name => String(name ?? '')))
  });
}

/** Accept only a bounded capacity notice at the presentation socket. */
export function isInventoryCapacityNoticeMessage(value) {
  if (!plainRecord(value) || value.kind !== INVENTORY_CAPACITY_NOTICE_KIND) return false;
  if (!exactKeys(value, INVENTORY_CAPACITY_KEYS)) return false;
  const name = text => typeof text === 'string' && text.length <= 128;
  if (!name(value.actorName) || !name(value.convoyName)) return false;
  return Array.isArray(value.itemNames) && value.itemNames.length <= CAPACITY_NOTICE_NAME_LIMIT
    && value.itemNames.every(name);
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
function normalizeActivationCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return undefined;
  const { x, y } = value;
  const bound = ITEM_ACTIVATION_SUPPORT.maxCell;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
  if (x < -bound || x > bound || y < -bound || y > bound) return undefined;
  return Object.freeze({ x, y });
}

function normalizeActivationParams(value) {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > ITEM_ACTIVATION_SUPPORT.maxParams) return null;
  for (const [key, entry] of entries) {
    if (typeof key !== 'string' || !key || key.length > ITEM_ACTIVATION_SUPPORT.maxParamLength) return null;
    if (typeof entry !== 'string' || entry.length > ITEM_ACTIVATION_SUPPORT.maxParamLength) return null;
  }
  return Object.freeze(Object.fromEntries(entries));
}
