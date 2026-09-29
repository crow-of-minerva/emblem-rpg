/** @layer presentation/interface */
import { EQUIPMENT_REFUSALS, FORCED_MOVEMENT_ABILITIES } from '../../contracts/domains/items.mjs';
import { GUARD_BOND_BREAKS, GUARD_BOND_REFUSALS } from '../../contracts/domains/combat.mjs';
import { EFFECT_PLAN_ERRORS, EFFECT_STEP_PRECONDITION_FAILURES } from '../../contracts/dsl/effects.mjs';
import { DOWNTIME_NOTIFICATIONS, counted } from './downtime-notifications.mjs';
import { NOTIFICATION_IDS } from './notification-ids.mjs';

/** The warning for either half of a Guard pair that already stands in a bond. */
const GUARD_HELD = { level: 'warn', text: ({ actorName = '' } = {}) => `${actorName} is already in a Guard bond.` };

/* -------------------------------------------- */
/*  Notification copy                           */
/* -------------------------------------------- */
/**
 * The text and level NotificationService (notifications.mjs) shows for each notification id.
 * An entry with a `backend` goes to the diagnostic sink under that source path instead of a notification. A `silent`
 * entry, or a result code with no entry, shows nothing. A `permanent` notice stays until the reader dismisses it.
 * The downtime notices are defined in downtime-notifications.mjs and spread in with the other gameplay notices.
 */
export const NOTIFICATIONS = Object.freeze({
  // Character
  [NOTIFICATION_IDS.ACTION_ALREADY_AVAILABLE]: {
    level: 'info',
    text: () => 'This character already has a standard action.'
  },
  [NOTIFICATION_IDS.ACTION_ALREADY_SPENT]: {
    level: 'warn',
    text: () => 'This character already spent their standard action.'
  },
  [NOTIFICATION_IDS.ACTION_RESTORED]: {
    level: 'info',
    text: ({ actorName }) => `${actorName}'s standard action was restored.`
  },
  [NOTIFICATION_IDS.ACTION_SPENT]: {
    level: 'info',
    text: ({ actorName }) => `${actorName} spent their standard action.`
  },
  [NOTIFICATION_IDS.SKILL_ROLLED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SKILL_REQUIRED]: { level: 'warn', text: () => 'Choose a valid skill to roll.' },
  [NOTIFICATION_IDS.ROLL_MODE_INVALID]: { level: 'warn', text: () => 'Choose standard, advantage, or disadvantage.' },
  [NOTIFICATION_IDS.CHECK_DC_INVALID]: { level: 'warn', text: () => 'Choose a valid difficulty class.' },
  [NOTIFICATION_IDS.CHARACTER_REQUIRED]: { level: 'warn', text: () => 'This action requires a Character.' },
  [NOTIFICATION_IDS.CHARACTER_SHEET_INFO]: { level: 'info', text: ({ message }) => message || 'Character updated.' },
  [NOTIFICATION_IDS.CHARACTER_SHEET_WARNING]: {
    level: 'warn', text: ({ message }) => message || 'That Character change is not allowed.'
  },
  [NOTIFICATION_IDS.JOURNAL_ACCESS_GRANTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.JOURNAL_NOT_FOUND]: { level: 'warn', text: () => 'That journal entry no longer exists.' },
  [NOTIFICATION_IDS.JOURNAL_NOT_LINKED]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'} does not link that journal entry.`
  },
  [NOTIFICATION_IDS.JOURNAL_ACCESS_DENIED]: {
    level: 'warn', text: () => 'You can only share a journal entry you can already read.'
  },
  [NOTIFICATION_IDS.HOTBAR_LAYOUT_SAVED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.HOTBAR_LAYOUT_STALE]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.HOTBAR_LAYOUT_INVALID]: { level: 'error', text: () => 'That hotbar layout could not be saved.' },
  [NOTIFICATION_IDS.SUPPORT_WARNING]: {
    level: 'warn', text: ({ message }) => message || 'That Support change is not allowed.'
  },
  [NOTIFICATION_IDS.SUPPORT_XP_GRANTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SUPPORT_PARTNERS_SET]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SUPPORT_MIRROR_RECONCILED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SUPPORT_INPUT_INVALID]: { level: 'warn', text: () => 'That Support change is not valid.' },
  [NOTIFICATION_IDS.SUPPORT_INELIGIBLE]: {
    level: 'warn', text: () => 'Only Lords and Retainers can hold a Support bond.'
  },
  [NOTIFICATION_IDS.SUPPORT_STATE_CHANGED]: {
    level: 'warn', text: () => 'The bond changed before this Support update could settle.'
  },
  [NOTIFICATION_IDS.SUPPORT_SETTLEMENT_FAILED]: { backend: 'foundry/adapters/document-writes/characters.mjs', level: 'error', text: () => 'Support bonds could not be updated.' },
  [NOTIFICATION_IDS.SUPPORT_MIRROR_PENDING]: { backend: 'foundry/adapters/document-writes/characters.mjs',
    level: 'error', text: () => "Support bonds were saved, but a partner's side could not be updated. Ask the GM to check both support sheets."
  },
  [NOTIFICATION_IDS.CHARACTER_EXPERIENCE_GRANTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SKILL_EXPERIENCE_GRANTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SKILL_RANK_MAXIMUM]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SKILL_UNKNOWN]: { level: 'warn', text: () => 'That skill is not one a unit can train.' },
  [NOTIFICATION_IDS.CHARACTER_LEVEL_GAINED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.CHARACTER_EXPERIENCE_REQUIRED]: {
    level: 'warn', text: () => 'Enter a whole XP amount greater than zero.'
  },
  [NOTIFICATION_IDS.CHARACTER_LEVEL_MAXIMUM]: {
    level: 'info', text: ({ actorName }) => `${actorName} is already at maximum level.`
  },
  [NOTIFICATION_IDS.ACTOR_DAMAGED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ACTOR_HEALED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ACTOR_OR_TOKEN_REQUIRED]: { level: 'warn', text: () => 'Choose one placed Actor token.' },
  [NOTIFICATION_IDS.DAMAGE_INPUT_INVALID]: {
    level: 'warn', text: () => 'Choose a positive damage amount and a valid damage type.'
  },
  [NOTIFICATION_IDS.HEAL_INPUT_INVALID]: { level: 'warn', text: () => 'Choose a positive healing amount.' },
  [NOTIFICATION_IDS.HEALTH_STATE_STALE]: {
    level: 'warn', text: () => 'The Actor changed before this health update could settle.'
  },
  [NOTIFICATION_IDS.STANCE_BREAK_FAILED]: { backend: 'foundry/adapters/document-writes/health.mjs',
    level: 'error', text: () => 'The Stance Break could not be written, so the hit was undone.'
  },
  [NOTIFICATION_IDS.COMBAT_EXCHANGE_RESOLVED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.COMBAT_EXCHANGE_INPUT_INVALID]: { level: 'warn', text: () => 'That combat request is incomplete.' },
  [NOTIFICATION_IDS.COMBAT_EXCHANGE_UNAVAILABLE]: {
    level: 'warn', text: () => 'The attack is no longer available from the current board state.'
  },
  [NOTIFICATION_IDS.COMBAT_EXCHANGE_FAILED]: { backend: 'foundry/adapters/document-writes/combat-settlement.mjs',
    level: 'error', text: () => 'The exchange could not be written and was rolled back.'
  },
  [NOTIFICATION_IDS.COMBAT_EXCHANGE_STALE]: {
    level: 'warn', text: () => 'Combatants changed after the preview. Open the attack preview again.'
  },
  [NOTIFICATION_IDS.COMBAT_CONTINUATION_RESOLVED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.COMBAT_CONTINUATION_UNAVAILABLE]: {
    level: 'warn', text: () => 'That post-combat continuation is no longer available.'
  },
  [NOTIFICATION_IDS.COMBAT_CONTINUATION_STALE]: {
    level: 'warn', text: () => 'The unit changed before its post-combat choice could settle.'
  },
  [NOTIFICATION_IDS.GUARD_BOND_SELF]: { level: 'warn', text: () => 'A unit cannot Guard themselves.' },
  [NOTIFICATION_IDS.GUARD_BOND_HELD]: GUARD_HELD,
  [NOTIFICATION_IDS.GUARD_BOND_PARTNER_HELD]: GUARD_HELD,
  [NOTIFICATION_IDS.GUARD_BOND_OFF_MAP]: { level: 'warn', text: () => 'Both units must be on the map.' },
  [NOTIFICATION_IDS.GUARD_BOND_GROUNDED]: {
    level: 'warn', text: () => 'A grounded unit cannot Guard a flying unit.'
  },
  [NOTIFICATION_IDS.GUARD_BOND_SMALLER]: {
    level: 'warn', text: () => 'A smaller unit cannot Guard a larger unit.'
  },
  [NOTIFICATION_IDS.GUARD_BOND_BROKEN]: {
    level: 'info',
    text: ({ reason = '', actorName = '' } = {}) => `Guard bond broken: ${guardBondBreakReason(reason, actorName)}.`
  },
  [NOTIFICATION_IDS.EFFECT_STEP_SKIPPED]: { level: 'warn', text: effectSkipText },
  [NOTIFICATION_IDS.ITEM_ACTIVATED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ITEM_ACTIVATION_INPUT_INVALID]: { level: 'warn', text: () => 'Item not found.' },
  [NOTIFICATION_IDS.ITEM_ACTIVATION_UNSUPPORTED]: { level: 'warn', text: () => 'That item type cannot be used yet.' },
  [NOTIFICATION_IDS.ITEM_ACTIVATION_EXPLORATION_FORBIDDEN]: {
    level: 'warn', text: () => 'Only Potions, Boosters, Promotions and Mounts can be used in Free Exploration.'
  },
  [NOTIFICATION_IDS.ITEM_ACTIVATION_UNAVAILABLE]: { level: 'warn', text: () => 'That item cannot be used right now.' },
  [NOTIFICATION_IDS.ITEM_ACTIVATION_STALE]: {
    level: 'warn', text: () => 'The board changed before the activation could settle. Try again.'
  },
  [NOTIFICATION_IDS.ITEM_ACTIVATION_FAILED]: { backend: 'foundry/adapters/document-writes/effect-execution.mjs',
    level: 'error', text: () => 'The activation could not be written and was rolled back.'
  },
  [NOTIFICATION_IDS.ITEM_ACTION_UNAVAILABLE]: {
    level: 'warn', text: () => 'This unit has no action left for that item.'
  },
  [NOTIFICATION_IDS.ITEM_USES_EXHAUSTED]: { level: 'warn', text: () => 'That item has no uses left.' },
  [NOTIFICATION_IDS.ITEM_SPELL_RANK_REQUIRED]: {
    level: 'warn',
    text: ({ proficiency, rankLabel, itemName }) =>
      `${proficiency || 'Proficiency'} ${rankLabel || ''} required to cast ${itemName || 'that spell'}.`
  },
  [NOTIFICATION_IDS.ITEM_TARGET_INVALID]: { level: 'warn', text: () => 'That item cannot be aimed at those units.' },
  [NOTIFICATION_IDS.ITEM_TARGET_OBJECT]: {
    level: 'warn', text: () => 'Objects are only struck by attacks and damaging effects.'
  },
  [NOTIFICATION_IDS.ITEM_TARGET_SCENERY]: { level: 'warn', text: () => 'That is scenery, not a target.' },
  [NOTIFICATION_IDS.ITEM_TARGET_FACTION]: { level: 'warn', text: targetFactionText },
  [NOTIFICATION_IDS.ITEM_TARGET_DESTROYED]: { level: 'warn', text: () => 'That object is already destroyed.' },
  [NOTIFICATION_IDS.ITEM_TARGET_SANCTUARY]: {
    level: 'warn',
    text: ({ targetName } = {}) => `${targetName || 'That unit'} is under Sanctuary and cannot be targeted.`
  },
  [NOTIFICATION_IDS.ITEM_CASTER_REQUIREMENTS_UNMET]: { level: 'warn', text: casterRequirementText },
  [NOTIFICATION_IDS.ITEM_TARGET_REQUIREMENTS_UNMET]: { level: 'warn', text: targetRequirementText },
  [NOTIFICATION_IDS.ITEM_TARGET_SIGHT_BLOCKED]: {
    level: 'warn', text: () => 'There is no line of sight to that target.'
  },
  [NOTIFICATION_IDS.ITEM_TARGET_ELEVATION_UNREACHABLE]: {
    level: 'warn', text: () => 'That target is out of reach at that elevation.'
  },
  [NOTIFICATION_IDS.ITEM_TARGET_OUT_OF_RANGE]: {
    level: 'warn', text: () => 'That target is out of range for this item.'
  },
  [NOTIFICATION_IDS.ITEM_AIM_INVALID]: { level: 'warn', text: () => 'That is not a square this item can be aimed at.' },
  [NOTIFICATION_IDS.ITEM_MOUNTS_FORBIDDEN]: { level: 'warn', text: () => 'Mounts are not permitted on this map.' },
  [NOTIFICATION_IDS.OBJECT_LOCK_OPENED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.OBJECT_LOCK_HELD]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ARMAMENT_WIELDED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ARMAMENT_RELEASED]: { silent: true, text: () => '' },
  ...DOWNTIME_NOTIFICATIONS,
  [NOTIFICATION_IDS.ARMAMENT_INPUT_INVALID]: { level: 'warn', text: () => 'That armament request could not be read.' },
  [NOTIFICATION_IDS.ARMAMENT_UNAVAILABLE]: { level: 'warn', text: () => 'This unit is not standing on an armament.' },
  [NOTIFICATION_IDS.ARMAMENT_STALE]: {
    level: 'warn', text: () => 'The board changed before the armament could be taken up. Try again.'
  },
  [NOTIFICATION_IDS.ARMAMENT_MOUNTED]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'} cannot use an armament while mounted.`
  },
  [NOTIFICATION_IDS.ARMAMENT_PROFICIENCY]: {
    level: 'warn',
    text: data => `${data.proficiencyLabel ?? 'Proficiency'} ${data.rankLabel ?? ''} required to use ${data.armamentName ?? 'that armament'}.`
  },
  [NOTIFICATION_IDS.ARMAMENT_BROKEN]: {
    level: 'warn', text: data => `${data.armamentName ?? 'That armament'} is broken.`
  },
  [NOTIFICATION_IDS.ARMAMENT_EXPLORING]: {
    level: 'warn', text: () => 'Armaments are only worked inside an encounter.'
  },
  [NOTIFICATION_IDS.ITEM_DROPPED]: {
    level: 'info', text: data => `${data.actorName ?? 'The unit'} dropped ${data.itemName ?? 'an item'}.`
  },
  [NOTIFICATION_IDS.ITEM_DISCARDED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DROP_INPUT_INVALID]: { level: 'warn', text: () => 'That drop request could not be read.' },
  [NOTIFICATION_IDS.DROP_UNAVAILABLE]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'} has no token on the map.`
  },
  [NOTIFICATION_IDS.DROP_STALE]: { level: 'warn', text: () => 'That item or tile has changed. Try dropping it again.' },
  [NOTIFICATION_IDS.DROP_ITEM_REFUSED]: {
    level: 'warn', text: data => `${data.itemName ?? 'That item'} cannot be dropped.`
  },
  [NOTIFICATION_IDS.DROP_SETTLEMENT_FAILED]: { backend: 'foundry/adapters/document-writes/objects.mjs',
    level: 'error', text: () => 'That drop failed part-way and was undone, so nothing was left on the ground.'
  },
  [NOTIFICATION_IDS.TRADE_COMPLETED]: {
    level: 'info',
    text: data => (data.mode === 'loot'
      ? `${data.sourceName ?? 'The unit'} took from ${data.targetName ?? 'the container'}.`
      : `Trade completed between ${data.sourceName ?? 'the unit'} and ${data.targetName ?? 'the other'}.`)
  },
  [NOTIFICATION_IDS.TRADE_INPUT_INVALID]: { level: 'warn', text: () => 'That trade request could not be read.' },
  [NOTIFICATION_IDS.TRADE_UNAVAILABLE]: { level: 'warn', text: () => 'There is nobody there to trade with.' },
  [NOTIFICATION_IDS.TRADE_STALE]: {
    level: 'warn', text: () => 'The board changed before the trade could settle. Try again.'
  },
  [NOTIFICATION_IDS.TRADE_ITEM_MISSING]: { level: 'warn', text: () => 'That item is not carried any more.' },
  [NOTIFICATION_IDS.TRADE_TARGET_INVALID]: { level: 'warn', text: () => 'Trade requires a friendly unit.' },
  [NOTIFICATION_IDS.TRADE_OUT_OF_REACH]: { level: 'warn', text: () => 'That unit is not close enough.' },
  [NOTIFICATION_IDS.TRADE_ELEVATION]: { level: 'warn', text: () => 'Trade needs the same elevation.' },
  [NOTIFICATION_IDS.TRADE_AIRBORNE]: { level: 'warn', text: () => 'Cannot trade with a flying unit unless flying.' },
  [NOTIFICATION_IDS.TRADE_NOTHING_SELECTED]: { level: 'warn', text: () => 'No items selected to trade.' },
  [NOTIFICATION_IDS.TRADE_ITEM_REFUSED]: {
    level: 'warn', text: data => `${data.itemName ?? 'That item'} cannot change hands.`
  },
  [NOTIFICATION_IDS.TRADE_ITEM_EQUIPPED]: {
    level: 'warn', text: data => `Cannot transfer ${data.itemName ?? 'that item'} while it is equipped.`
  },
  [NOTIFICATION_IDS.TRADE_ARMOR_FULL]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'} can only carry one suit of armor.`
  },
  [NOTIFICATION_IDS.TRADE_EQUIPMENT_FULL]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'}'s Equipment is full (max ${data.limit ?? 5}).`
  },
  [NOTIFICATION_IDS.TRADE_POCKETS_FULL]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'}'s Pockets are full (max ${data.limit ?? 5}).`
  },
  [NOTIFICATION_IDS.TRADE_ACTION_UNAVAILABLE]: { level: 'warn', text: () => 'This unit has no Standard Action left.' },
  [NOTIFICATION_IDS.TRADE_BONUS_ACTION_UNAVAILABLE]: { level: 'warn', text: () => 'This unit has no Bonus Action left.' },
  [NOTIFICATION_IDS.TRADE_SQUARE_SHARED]: {
    level: 'warn', text: () => 'This unit cannot act while standing on another unit.'
  },
  [NOTIFICATION_IDS.CONVOY_DEPOSITED]: {
    level: 'info', text: ({ convoyName, gold }) => `Added ${gold ?? 0} GP to ${convoyName || 'the Convoy'}.`
  },
  [NOTIFICATION_IDS.CONVOY_ITEM_STORED]: {
    level: 'info', text: ({ itemName }) => `${itemName || 'Item'} transferred to the Convoy.`
  },
  [NOTIFICATION_IDS.CONVOY_RESOURCE_STORED]: {
    level: 'info', text: ({ itemName, amount, total, stacked }) => (stacked
      ? `Added ${amount ?? 0} ${itemName || 'Resource'} to the Convoy (total ${total ?? amount ?? 0}).`
      : `Added ${amount ?? 0} ${itemName || 'Resource'} to the Convoy.`)
  },
  [NOTIFICATION_IDS.CONVOY_ITEM_TYPE_REFUSED]: {
    level: 'warn', text: ({ itemName }) => `${itemName || 'That item'} cannot be stored in the Convoy.`
  },
  [NOTIFICATION_IDS.VENDOR_STOCKED]: {
    level: 'info', text: ({ itemName }) => `${itemName || 'Item'} transferred to the Vendor.`
  },
  [NOTIFICATION_IDS.VENDOR_RESOURCE_STOCKED]: {
    level: 'info', text: ({ itemName, amount, total, stacked }) => (stacked
      ? `Added ${amount ?? 0} ${itemName || 'Resource'} to the Vendor (total ${total ?? amount ?? 0}).`
      : `Added ${amount ?? 0} ${itemName || 'Resource'} to the Vendor.`)
  },
  [NOTIFICATION_IDS.VENDOR_ITEM_TYPE_REFUSED]: {
    level: 'warn', text: ({ itemName }) => `${itemName || 'That item'} cannot be stocked by a Vendor.`
  },
  [NOTIFICATION_IDS.VENDOR_STOCK_INPUT_INVALID]: { level: 'warn', text: () => 'That stocking request could not be read.' },
  [NOTIFICATION_IDS.VENDOR_STOCK_UNAVAILABLE]: { level: 'warn', text: () => 'That Vendor is no longer available.' },
  [NOTIFICATION_IDS.VENDOR_STOCK_STALE]: { level: 'warn', text: () => 'The Vendor transfer did not go through. Try again.' },
  [NOTIFICATION_IDS.RESOURCE_AMOUNT_REQUIRED]: { level: 'warn', text: () => 'Enter a Resource amount above 0.' },
  [NOTIFICATION_IDS.COINPURSE_MERGED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.COINPURSE_UNCHANGED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.COINPURSE_DISSOLVED]: {
    level: 'info', text: ({ gold, actorName }) => `Added ${gold ?? 0} GP to ${actorName || 'the Convoy'}.`
  },
  [NOTIFICATION_IDS.COINPURSE_CARRIER_REQUIRED]: {
    level: 'warn', text: () => 'A Coinpurse must be carried by a unit with a token before it can be deposited.'
  },
  [NOTIFICATION_IDS.CONVOY_WITHDRAWN]: {
    level: 'info', text: ({ targetName, amount, convoyName, purseTotal }) =>
      `${targetName || 'The unit'} took ${amount ?? 0} GP from ${convoyName || 'the Convoy'} (carrying ${purseTotal ?? 0} GP).`
  },
  [NOTIFICATION_IDS.CONVOY_WITHDRAWAL_INVALID]: { level: 'warn', text: () => 'Gold withdrawal is incomplete.' },
  [NOTIFICATION_IDS.CONVOY_WITHDRAWAL_UNAVAILABLE]: { level: 'warn', text: () => 'The requested Convoy is no longer available.' },
  [NOTIFICATION_IDS.CONVOY_NOT_LINKED]: {
    level: 'warn', text: ({ targetName }) => `${targetName || 'That unit'} is not in the party this Convoy belongs to.`
  },
  [NOTIFICATION_IDS.CONVOY_INSUFFICIENT_GOLD]: {
    level: 'warn', text: ({ convoyGp }) => `The Convoy holds only ${convoyGp ?? 0} GP.`
  },
  [NOTIFICATION_IDS.CONVOY_EMPTY]: {
    level: 'warn', text: ({ convoyName }) => `${convoyName || 'The Convoy'} has no gold to hand out.`
  },
  [NOTIFICATION_IDS.VENDOR_STOCK_EMPTY]: {
    level: 'info', text: ({ vendorName }) => `${vendorName || 'The Vendor'} is already empty.`
  },
  [NOTIFICATION_IDS.VENDOR_STOCK_ALL_LOCKED]: {
    level: 'info', text: ({ vendorName }) => `${vendorName || 'The Vendor'} has nothing unlocked to clear.`
  },
  [NOTIFICATION_IDS.VENDOR_STOCK_CLEARED]: {
    level: 'info', text: ({ vendorName, removed, lockedCount }) =>
      `Cleared ${vendorName || 'the Vendor'}'s stock (${removed ?? 0} removed${lockedCount ? `, ${lockedCount} locked kept` : ''}).`
  },
  [NOTIFICATION_IDS.VENDOR_STOCK_CLEAR_FAILED]: { backend: 'foundry/adapters/document-writes/economy.mjs', level: 'error', text: () => 'Clearing stock failed (see console).' },
  [NOTIFICATION_IDS.VENDOR_CHECKOUT_SETTLED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.VENDOR_CHECKOUT_UNAVAILABLE]: { level: 'warn', text: () => 'That basket could not be settled.' },
  [NOTIFICATION_IDS.VENDOR_HAGGLED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.VENDOR_HAGGLE_UNAVAILABLE]: { level: 'warn', text: () => 'That haggle could not be settled.' },
  [NOTIFICATION_IDS.VENDOR_HAGGLE_EXPLORATION_REQUIRED]: {
    level: 'warn', text: () => 'Haggling happens in free exploration.'
  },
  [NOTIFICATION_IDS.VENDOR_HAGGLE_LOCKED]: {
    level: 'warn',
    text: ({ vendorName } = {}) => `${vendorName || 'That vendor'} was already haggled with this downtime.`
  },
  [NOTIFICATION_IDS.CONVOY_INPUT_INVALID]: { level: 'warn', text: () => 'That convoy request could not be read.' },
  [NOTIFICATION_IDS.CONVOY_UNAVAILABLE]: { level: 'warn', text: () => 'No convoy is linked to this unit\'s party.' },
  [NOTIFICATION_IDS.CONVOY_ITEM_REFUSED]: { level: 'warn', text: () => 'That item cannot be sent to a convoy.' },
  [NOTIFICATION_IDS.CONVOY_LOCKED_IN_COMBAT]: { level: 'warn', text: () => 'Nothing can be taken from the convoy in combat.' },
  [NOTIFICATION_IDS.CONVOY_TURN_OVER]: { level: 'warn', text: () => 'Turn is over.' },
  [NOTIFICATION_IDS.CONVOY_STALE]: { level: 'warn', text: () => 'The convoy transfer did not go through. Try again.' },
  [NOTIFICATION_IDS.CONVOY_DELIVERED]: {
    level: 'info',
    text: ({ gold, itemCount, convoyName }) => `Delivered ${[Number(gold) > 0 ? `${Number(gold)} GP` : '',
      Number(itemCount) > 0 ? counted(itemCount, 'item') : ''].filter(Boolean).join(' and ') || 'nothing'}`
      + ` to ${convoyName || 'the Convoy'}.`
  },
  [NOTIFICATION_IDS.CONVOY_DELIVERY_EMPTY]: {
    level: 'warn', text: ({ convoyName }) => `${convoyName || 'The Convoy'} has nothing inbound to deliver.`
  },
  [NOTIFICATION_IDS.CONVOY_INBOUND_LOCKED]: { level: 'warn',
    text: ({ itemName }) => `${itemName || 'That item'} is still inbound, so staff must deliver it first.`
  },
  [NOTIFICATION_IDS.VENDOR_PURCHASED]: {
    level: 'info', text: ({ actorName, units, itemName, total, destinationName, boughtElsewhere }) =>
      `${actorName || 'The unit'} bought ${Number(units) > 1 ? `${units} ` : ''}${itemName || 'that'}`
      + `${Number(total) > 0 ? ` for ${total} GP` : ''}${boughtElsewhere ? `, sent to ${destinationName}` : ''}.`
  },
  [NOTIFICATION_IDS.VENDOR_SOLD]: {
    level: 'info', text: ({ units, itemName, vendorName, paid }) =>
      `Sold ${Number(units) > 1 ? `${units} ` : ''}${itemName || 'that'} to ${vendorName || 'the vendor'} `
      + `for ${paid ?? 0} GP.`
  },
  [NOTIFICATION_IDS.VENDOR_PURCHASE_UNAVAILABLE]: {
    level: 'warn', text: () => 'Purchase documents are no longer available.'
  },
  [NOTIFICATION_IDS.VENDOR_SALE_UNAVAILABLE]: {
    level: 'warn', text: () => 'Sale documents are no longer available.'
  },
  [NOTIFICATION_IDS.VENDOR_ITEM_UNTRADEABLE]: {
    level: 'warn', text: ({ itemName }) => `${itemName || 'That item'} cannot be traded.`
  },
  [NOTIFICATION_IDS.VENDOR_ITEM_UNAVAILABLE]: {
    level: 'warn', text: ({ itemName }) => `${itemName || 'That item'} is no longer available.`
  },
  [NOTIFICATION_IDS.VENDOR_ITEM_REFUSED]: {
    level: 'warn', text: ({ vendorName, itemName }) =>
      `${vendorName || 'The vendor'} will not buy ${itemName || 'that'}.`
  },
  [NOTIFICATION_IDS.VENDOR_BUYBACK_REFUSED]: {
    level: 'warn', text: ({ vendorName }) => `${vendorName || 'The vendor'} will not buy back what it sold.`
  },
  [NOTIFICATION_IDS.VENDOR_STOCK_INVALID]: {
    level: 'warn', text: ({ itemName }) => `${itemName || 'That item'} has invalid resource stock.`
  },
  [NOTIFICATION_IDS.VENDOR_OUT_OF_STOCK]: {
    level: 'warn', text: ({ itemName }) => `${itemName || 'That item'} is out of stock.`
  },
  [NOTIFICATION_IDS.VENDOR_QUANTITY_INVALID]: {
    level: 'warn', text: () => 'The requested quantity is unavailable.'
  },
  [NOTIFICATION_IDS.VENDOR_FUNDS_SHORT]: {
    level: 'warn', text: ({ actorName, itemName, total }) =>
      `${actorName || 'The unit'} cannot afford ${itemName || 'that'} (${total ?? 0} GP).`
  },
  [NOTIFICATION_IDS.VENDOR_ARMOR_OCCUPIED]: {
    level: 'warn', text: ({ actorName }) => `${actorName || 'The unit'} already has a suit of armor.`
  },
  [NOTIFICATION_IDS.VENDOR_EQUIPMENT_FULL]: {
    level: 'warn', text: ({ actorName, limit }) => `${actorName || 'The unit'}'s Equipment is full (max ${limit ?? 0}).`
  },
  [NOTIFICATION_IDS.VENDOR_POCKETS_FULL]: {
    level: 'warn', text: ({ actorName, limit }) => `${actorName || 'The unit'}'s Pockets are full (max ${limit ?? 0}).`
  },
  [NOTIFICATION_IDS.VENDOR_MERCHANDISE_SET]: {
    level: 'info', text: ({ vendorName }) => `${vendorName || 'The vendor'} updated its merchandise settings.`
  },
  [NOTIFICATION_IDS.VENDOR_SETTLEMENT_STALE]: {
    level: 'warn', text: () => 'The shop changed while that was being settled, so nothing was exchanged.'
  },
  [NOTIFICATION_IDS.STEAL_SUCCEEDED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.STEAL_FAILED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.STEAL_INPUT_INVALID]: { level: 'warn', text: () => 'That steal request could not be read.' },
  [NOTIFICATION_IDS.STEAL_TARGET_INVALID]: { level: 'warn', text: () => 'That is not someone to steal from.' },
  [NOTIFICATION_IDS.STEAL_ABILITY_REQUIRED]: {
    level: 'warn', text: data => `${data.actorName || 'That unit'} does not know how to steal.`
  },
  [NOTIFICATION_IDS.STEAL_ITEM_UNSTEALABLE]: {
    level: 'warn', text: data => `${data.itemName ?? 'That'} is not something that can be taken.`
  },
  [NOTIFICATION_IDS.STEAL_NOTHING_TO_TAKE]: {
    level: 'warn', text: data => `${data.targetName ?? 'That unit'} carries nothing that can be taken.`
  },
  [NOTIFICATION_IDS.OBJECT_LOCK_INPUT_INVALID]: { level: 'warn', text: () => 'That lock request could not be read.' },
  [NOTIFICATION_IDS.OBJECT_LOCK_UNAVAILABLE]: { level: 'warn', text: () => 'That is not a lock this command opens.' },
  [NOTIFICATION_IDS.OBJECT_LOCK_ALREADY_OPEN]: {
    level: 'warn', text: data => `${data.lockName ?? 'That lock'} is not locked.`
  },
  [NOTIFICATION_IDS.OBJECT_LOCK_STALE]: {
    level: 'warn', text: () => 'The board changed before the lock could settle. Try again.'
  },
  [NOTIFICATION_IDS.OBJECT_OUT_OF_REACH]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'} is not standing at that lock.`
  },
  [NOTIFICATION_IDS.OBJECT_NOT_VISIBLE]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'} can't see that lock from where it stands.`
  },
  [NOTIFICATION_IDS.OBJECT_KEY_MISSING]: {
    level: 'warn',
    text: data => (data.keyName
      ? `${data.actorName ?? 'This unit'} is not carrying ${data.keyName}.`
      : `${data.lockName ?? 'That lock'} has no key.`)
  },
  [NOTIFICATION_IDS.OBJECT_LOCK_UNPICKABLE]: {
    level: 'warn',
    text: data => (data.hasLocktouch === false
      ? `${data.actorName ?? 'This unit'} cannot pick locks.`
      : `${data.lockName ?? 'That lock'} cannot be picked.`)
  },
  [NOTIFICATION_IDS.OBJECT_ACTION_UNAVAILABLE]: {
    level: 'warn', text: data => `${data.actorName ?? 'This unit'} has no Standard Action left.`
  },
  [NOTIFICATION_IDS.OBJECT_LOCKPICK_BLOCKED]: {
    level: 'warn',
    text: data => `${data.actorName ?? 'This unit'} cannot pick a lock now: ${data.blocked || 'no Energy'}.`
  },
  [NOTIFICATION_IDS.ITEM_GROUND_OCCUPIED]: { level: 'warn', text: () => 'Ground targeting requires an empty square.' },
  [NOTIFICATION_IDS.ITEM_FORCED_TARGET_AIRBORNE]: {
    level: 'warn', text: data => `${data.ability ?? 'That ability'} needs a grounded target.`
  },
  [NOTIFICATION_IDS.ITEM_FORCED_SQUARE_OCCUPIED]: {
    level: 'warn',
    text: data => (data.ability === FORCED_MOVEMENT_ABILITIES.RETRIEVE
      ? 'Retrieve needs a free square behind the retriever.'
      : 'That square is occupied.')
  },
  [NOTIFICATION_IDS.ITEM_FORCED_SQUARE_BLOCKED]: {
    level: 'warn',
    text: data => (data.ability === FORCED_MOVEMENT_ABILITIES.RETRIEVE
      ? 'That square is wall-blocked.'
      : 'That square is blocked.')
  },
  [NOTIFICATION_IDS.ITEM_FORCED_SQUARE_ABOVE]: {
    level: 'warn',
    text: data => (data.ability === FORCED_MOVEMENT_ABILITIES.RETRIEVE
      ? 'Nobody can be pulled up onto higher ground.'
      : 'Nobody can be shoved up onto higher ground.')
  },
  [NOTIFICATION_IDS.ITEM_FORCED_BOARD_REQUIRED]: {
    level: 'warn', text: () => 'This ability is decided from the live board.'
  },
  [NOTIFICATION_IDS.ITEM_PARAM_INVALID]: { level: 'warn', text: () => 'That is not a choice this item offers.' },
  [NOTIFICATION_IDS.ENCOUNTER_BEGAN]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_ENDED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_PHASE_ADVANCED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_NOT_RUNNING]: { level: 'warn', text: () => 'No encounter is running on this scene.' },
  [NOTIFICATION_IDS.ENCOUNTER_OTHER_RUNNING]: {
    level: 'warn', text: () => 'Pause or end the running encounter before starting another.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_ALREADY_RUNNING]: {
    level: 'warn', text: () => 'This map already has an encounter.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_SETTLEMENT_FAILED]: { backend: 'foundry/adapters/document-writes/encounters.mjs',
    level: 'error', text: () => 'The phase change could not be written to the scene.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_CREATED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_CANCELLED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_PAUSED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_RESUMED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_PAUSE_DISCARDED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_PAUSE_MISSING]: {
    level: 'warn', text: () => 'This map has no paused encounter.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_OPTION_SET]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_EXPLORATION_SET]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_TURN_COMPLETED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_TURN_ENDED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.OBJECTIVES_CHECKED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.OBJECTIVES_END_COMMITTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.OBJECTIVES_END_QUEUED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.ENCOUNTER_MISSING]: { level: 'warn', text: () => 'This map has no encounter to act on.' },
  [NOTIFICATION_IDS.ENCOUNTER_GRID_REQUIRED]: { level: 'warn', text: () => 'Combat requires a square-grid map.' },
  [NOTIFICATION_IDS.ENCOUNTER_ADVANCE_STALE]: {
    level: 'warn', text: () => 'The phase already changed, so Advance Phase was not repeated.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_STALE]: {
    level: 'warn', text: () => 'A unit on the map was busy with another action, so the encounter stopped where it '
      + 'stood. Try again once it finishes.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_PHASE_CHANGE_STOPPED]: {
    level: 'warn', text: () => 'The phase change stopped because a unit is busy. Once its action finishes, '
      + 'use Advance Phase to resume.'
  },
  [NOTIFICATION_IDS.OBJECTIVES_AUTHORED]: { level: 'info', text: () => 'Objectives saved.' },
  [NOTIFICATION_IDS.OBJECTIVES_INPUT_INVALID]: {
    level: 'warn', text: ({ message }) => message || 'Objectives are invalid.'
  },
  [NOTIFICATION_IDS.OBJECTIVES_END_LOCKED]: { level: 'warn', text: () => 'This encounter end is already committed.' },
  [NOTIFICATION_IDS.CLASS_FEATURE_SELECTION_READY]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.CLASS_FEATURES_RECONCILED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.CLASS_FEATURE_GAINED]: {
    level: 'info', text: ({ actorName, featureName }) => `${actorName} gained ${featureName}.`
  },
  [NOTIFICATION_IDS.CLASS_FEATURES_REPLACED]: {
    level: 'info', text: ({ actorName, featureNames }) => `${actorName} lost ${featureNames.join(', ')} (replaced).`
  },
  [NOTIFICATION_IDS.CLASS_FEATURE_MISSING]: {
    level: 'warn', text: ({ className, featureName }) => `${className}: the feature "${featureName}" no longer exists.`
  },
  [NOTIFICATION_IDS.CLASS_PROMOTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.PROMOTION_UNAVAILABLE]: {
    level: 'warn', text: ({ message }) => message || 'That promotion is unavailable.'
  },
  [NOTIFICATION_IDS.PROMOTION_FAILED]: { backend: 'foundry/adapters/document-writes/class-features.mjs', level: 'error', text: promotionFailureText },
  [NOTIFICATION_IDS.INNATE_GRANTS_RECONCILED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.INNATE_GRANT_SETTLEMENT_FAILED]: { backend: 'foundry/adapters/document-writes/characters.mjs',
    level: 'error', text: ({ actorName }) => `Innate item sync failed for ${actorName}.`
  },
  [NOTIFICATION_IDS.INNATE_GRANT_SOURCE_MISSING]: {
    level: 'warn',
    text: ({ grantKey, itemName }) => `Innate grant "${grantKey}" skipped: no item named "${itemName}" found in the world or any compendium.`
  },
  [NOTIFICATION_IDS.CLASS_FEATURES_SELECTED]: {
    level: 'info',
    text: ({ actorName, featureNames }) => `${actorName} gained ${featureNames.join(', ')}.`
  },
  [NOTIFICATION_IDS.CLASS_BUNDLE_NOT_FOUND]: {
    level: 'warn', text: () => 'That Class feature bundle no longer exists.'
  },
  [NOTIFICATION_IDS.CLASS_BUNDLE_INVALID]: {
    level: 'warn', text: () => 'That bundle is not a selectable feature bundle.'
  },
  [NOTIFICATION_IDS.CLASS_BUNDLE_ALREADY_SELECTED]: {
    level: 'info', text: () => 'That feature bundle has already been selected.'
  },
  [NOTIFICATION_IDS.CLASS_BUNDLE_LEVEL_REQUIRED]: {
    level: 'warn', text: () => 'This Character has not reached the required level.'
  },
  [NOTIFICATION_IDS.CLASS_FEATURE_CHOICE_INVALID]: {
    level: 'warn', text: ({ required }) => `Choose exactly ${required} feature${required === 1 ? '' : 's'} from this bundle.`
  },
  [NOTIFICATION_IDS.CLASS_CATALOG_EMPTY]: {
    level: 'warn', text: () => 'No Class items found in the world or compendiums.'
  },
  [NOTIFICATION_IDS.CLASS_SELECTION_REQUIRED]: { level: 'warn', text: () => 'Select a Class.' },
  [NOTIFICATION_IDS.CLASS_TEMPLATE_UNAVAILABLE]: {
    level: 'warn', text: ({ tier }) => `No default template for ${tier}.`
  },
  [NOTIFICATION_IDS.CLASS_SOURCE_NOT_FOUND]: { level: 'warn', text: () => 'The selected Class could not be loaded.' },
  [NOTIFICATION_IDS.CLASS_ASSIGNED]: { level: 'info', text: ({ label }) => `${label} assigned.` },
  [NOTIFICATION_IDS.CLASS_UPDATE_FAILED]: { backend: 'foundry/adapters/document-writes/class-features.mjs', level: 'error', text: () => 'Class update did not complete.' },
  [NOTIFICATION_IDS.CLASS_UNIQUE_FEATURES_REMOVED]: {
    level: 'info',
    text: ({ actorName, className, featureNames }) => `${actorName} lost ${featureNames.join(', ')} (unique to ${className}).`
  },
  [NOTIFICATION_IDS.CLASS_NOT_ASSIGNED]: { level: 'warn', text: () => 'This actor has no Class.' },

  // Commands
  [NOTIFICATION_IDS.COMMAND_RESOURCE_BUSY]: {
    level: 'warn', text: () => 'A unit was busy with another action. Try again once it finishes.'
  },
  [NOTIFICATION_IDS.COMMAND_FAILED]: { backend: 'engine/dispatcher.mjs', level: 'error', text: () => 'The action could not be completed.' },
  [NOTIFICATION_IDS.OPERATION_RESTORE_FAILED]: {
    level: 'error',
    permanent: true,
    text: () => 'An interrupted action could not be fully undone. Check the console for the documents to repair.'
  },
  [NOTIFICATION_IDS.STARTUP_FAILED]: {
    level: 'error',
    permanent: true,
    text: () => 'Emblem RPG could not finish starting. Reload the page. Details are in the console.'
  },
  [NOTIFICATION_IDS.UNKNOWN_COMMAND]: { backend: 'engine/dispatcher.mjs', level: 'error', text: () => 'The system does not recognize this action.' },
  [NOTIFICATION_IDS.SOCKET_PAYLOAD_REFUSED]: {
    level: 'warn', text: () => 'The request carried data the system refuses to relay.'
  },
  [NOTIFICATION_IDS.SOCKET_RATE_LIMITED]: {
    level: 'warn', text: () => 'Too many requests at once. Wait a moment and try again.'
  },
  [NOTIFICATION_IDS.COMMAND_EXECUTION_BUSY]: {
    level: 'warn', text: () => 'Another action is still resolving. Try again once it finishes.'
  },
  [NOTIFICATION_IDS.COMMAND_TABLE_PAUSED]: {
    level: 'warn', text: () => 'The game is paused. Ask the GM to unpause before acting.'
  },
  [NOTIFICATION_IDS.COMMAND_OUTCOME_UNKNOWN]: {
    level: 'warn',
    text: () => 'The GM client did not confirm this action, so it may have happened. Check the table before retrying.'
  },
  [NOTIFICATION_IDS.COMMAND_STATUS]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.COMMAND_REQUEST_CONFLICT]: {
    level: 'error', text: () => 'That request was already used for a different action.'
  },
  [NOTIFICATION_IDS.COMMAND_REQUEST_EXPIRED]: {
    level: 'warn', text: () => 'That request is too old to repeat. Check the table before trying again.'
  },
  [NOTIFICATION_IDS.COMMAND_CHILD_OUTSIDE_EXECUTION]: {
    level: 'error', text: () => 'The action could not be completed.'
  },
  [NOTIFICATION_IDS.COMMAND_SEGMENT_OPENED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.COMMAND_SEGMENT_RELEASED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.SCENE_GRIDLESS_BLOCKED]: {
    level: 'warn', text: () => 'Gridless grids are blocked while an encounter exists.'
  },
  [NOTIFICATION_IDS.TOKEN_SIZE_INVALID]: {
    level: 'warn', text: () => 'Character tokens must be Standard (1×1) or Large (2×2).'
  },
  [NOTIFICATION_IDS.SCENE_REFERENCES_REPAIRED]: {
    level: 'info',
    text: ({ count, sceneName }) => `Remapped ${count} stale token reference(s) in "${sceneName}".`
  },
  [NOTIFICATION_IDS.WORLD_SCHEMA_MISMATCH]: { backend: 'foundry/hooks/scene.mjs',
    level: 'error',
    text: ({ stored, current }) =>
      `This world's data schema is ${stored}, but this build writes schema ${current}. No migration runs.`
  },
  [NOTIFICATION_IDS.WORLD_MIGRATION_STARTED]: {
    level: 'info', permanent: true, text: () => 'Automatic world content migration in process. Please wait.'
  },
  [NOTIFICATION_IDS.WORLD_MIGRATION_COMPLETED]: { level: 'info', text: () => 'Content migration completed. Have fun!' },
  [NOTIFICATION_IDS.WORLD_MIGRATION_CONFLICTS]: {
    level: 'warn',
    permanent: true,
    text: ({ count }) => `Content migration left ${count} item(s) unchanged because they hold animations or effects `
      + 'under both the old and new names. The console lists them.'
  },
  [NOTIFICATION_IDS.WORLD_MIGRATION_INCOMPLETE]: {
    level: 'warn',
    permanent: true,
    text: ({ count }) => `Content migration finished with ${count} failure(s). The console lists them. Fix them, then `
      + 'run the Migrate World Content macro from the Emblem RPG | Macros compendium.'
  },
  [NOTIFICATION_IDS.WORLD_MIGRATION_FAILED]: {
    level: 'error',
    permanent: true,
    text: () => 'Automatic world content migration failed. Details are in the console. It runs again on the next '
      + 'load, or run the Migrate World Content macro from the Emblem RPG | Macros compendium.'
  },
  // Table commands. Recovery itself says nothing: its result codes carry no copy and show no notification.
  [NOTIFICATION_IDS.TABLE_COMMAND_GM_ONLY]: { level: 'warn', text: ({ label }) => `${label} is GM-only.` },
  [NOTIFICATION_IDS.TABLE_COMMAND_USAGE]: { level: 'warn', text: ({ message }) => message },
  [NOTIFICATION_IDS.TABLE_COMMAND_INFO]: { level: 'info', text: ({ message }) => message },
  [NOTIFICATION_IDS.TABLE_COMMAND_FAILED]: { level: 'error',
    text: ({ label = 'That command' }) => `${label} could not finish. Check the diagnostic details.`
  },

  // Shared
  [NOTIFICATION_IDS.ACTOR_NOT_FOUND]: { level: 'warn', text: () => 'The selected actor could not be found.' },
  [NOTIFICATION_IDS.GM_REQUIRED]: { level: 'warn', text: () => 'Only a GM can complete this action.' },
  [NOTIFICATION_IDS.OWNER_REQUIRED]: { level: 'warn', text: () => 'You do not own this actor.' },
  [NOTIFICATION_IDS.AUTHOR_REQUIRED]: {
    level: 'warn', text: () => 'Only a GM or a Trusted owner of this unit can do that.'
  },

  // Socket
  [NOTIFICATION_IDS.NO_ACTIVE_GM]: { level: 'warn', text: () => 'A GM must be connected to complete this action.' },
  [NOTIFICATION_IDS.SOCKET_NOT_READY]: { backend: 'socket/gateway.mjs', level: 'error', text: () => 'The system connection is not ready yet.' },
  [NOTIFICATION_IDS.SOCKET_MULTIPLE_HOSTS]: {
    level: 'warn', text: () => 'Two full GM clients are connected. Play resumes when only one GM remains.'
  },
  [NOTIFICATION_IDS.SOCKET_HOST_SESSION_STALE]: {
    level: 'warn', text: () => 'The GM client reloaded before this action arrived, so it did not run. Try again.'
  },
  [NOTIFICATION_IDS.SOCKET_HOST_UNREACHABLE]: {
    level: 'warn', text: () => 'The GM client did not answer, so nothing was sent. Try again shortly.'
  },
  [NOTIFICATION_IDS.SOCKET_AUTHORITY_LOST]: {
    level: 'error', text: () => 'The GM client stopped hosting while an action ran. Check the table state.'
  },

  // Inventory
  [NOTIFICATION_IDS.INVENTORY_WARNING]: {
    level: 'warn',
    text: ({ message }) => message || 'That inventory change is not allowed.'
  },
  [NOTIFICATION_IDS.INVENTORY_ERROR]: { backend: 'foundry/adapters/document-writes/characters.mjs',
    level: 'error',
    text: ({ message }) => message || 'The inventory change could not be completed.'
  },
  [NOTIFICATION_IDS.INVENTORY_EQUIPMENT_UPDATED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.INVENTORY_EFFECTS_RECONCILED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.INVENTORY_CAPACITY_STORED]: {
    level: 'info',
    text: ({ actorName, convoyName, itemNames = [] }) => `${actorName} has more equipment than slots, so `
      + `${itemNames.join(', ')} went to ${convoyName}.`
  },
  [NOTIFICATION_IDS.INVENTORY_CAPACITY_UNSTORED]: {
    level: 'warn',
    text: ({ actorName, carried, capacity }) => `${actorName} carries ${carried} pieces of equipment `
      + `but has ${capacity} slots, and has no Convoy to send the surplus to.`
  },
  [NOTIFICATION_IDS.INVENTORY_REQUIREMENTS_UNEQUIPPED]: {
    level: 'warn',
    text: ({ actorName, unequipped = [] }) => unequipped
      .map(entry => `${actorName} no longer meets ${entry.itemName}'s requirements`
        + `${entry.requirementNames?.length ? ` (${entry.requirementNames.join(', ')})` : ''}, so it was unequipped.`)
      .join(' ')
  },
  [NOTIFICATION_IDS.BOARD_MODIFIERS_RECONCILED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.BOARD_UNAVAILABLE]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.VISION_DOORS_RECONCILED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.VISION_DOOR_SETTLEMENT_FAILED]: { backend: 'foundry/adapters/document-writes/vision.mjs',
    level: 'error',
    text: () => "A door's sight walls could not be updated. Reload the scene to try again."
  },
  [NOTIFICATION_IDS.BOARD_MODIFIER_SETTLEMENT_FAILED]: { backend: 'foundry/adapters/document-writes/characters.mjs',
    level: 'error', text: () => 'Aura and terrain modifiers on this Scene could not be updated.'
  },
  [NOTIFICATION_IDS.INVENTORY_ITEM_RECEIVED]: {
    level: 'info',
    text: ({ itemName, sourceActorName, targetActorName, moved }) => moved
      ? `${itemName} transferred from ${sourceActorName} to ${targetActorName}.`
      : `${itemName} copied to ${targetActorName}.`
  },
  [NOTIFICATION_IDS.INVENTORY_CHANGE_REFUSED]: { level: 'warn', text: equipmentRefusalText },
  [NOTIFICATION_IDS.INVENTORY_TWO_HANDED_UNWIELDED]: {
    level: 'info', text: () => 'Two-handed weapon unwielded to equip the shield.'
  },
  [NOTIFICATION_IDS.INVENTORY_TRANSFER_FAILED]: { backend: 'foundry/adapters/document-writes/characters.mjs',
    level: 'error',
    text: () => 'The Item transfer could not be completed.'
  },

  // Movement
  [NOTIFICATION_IDS.MOVEMENT_STARTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.MOVEMENT_COMMITTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.MOVEMENT_DRIVEN]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.MOVEMENT_CANCELLED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.MOVEMENT_ROLLED_BACK]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.MOVEMENT_RECOVERED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.MOVEMENT_LOCKED]: {
    level: 'warn', text: ({ holderName }) => `Token controls are locked while ${holderName || 'another user'} is selecting.`
  },
  [NOTIFICATION_IDS.MOVEMENT_PLAN_REQUIRED]: {
    level: 'warn', text: () => 'That Character is not currently planning movement.'
  },
  [NOTIFICATION_IDS.MOVEMENT_TOKEN_NOT_FOUND]: { level: 'warn', text: () => 'That Token is no longer available.' },
  [NOTIFICATION_IDS.MOVEMENT_GRID_UNSUPPORTED]: {
    level: 'warn', text: () => 'Movement currently requires a square-grid Scene.'
  },
  [NOTIFICATION_IDS.MOVEMENT_UNAVAILABLE]: { level: 'warn', text: () => 'This Character cannot move right now.' },
  [NOTIFICATION_IDS.MOVEMENT_STRANDED]: { level: 'warn', text: () => 'Stranded on an obstacle. Take off to move.' },
  [NOTIFICATION_IDS.MOVEMENT_OUT_OF_PLAY]: {
    level: 'warn', text: () => 'Units act only in a running encounter or in Free Exploration.'
  },
  [NOTIFICATION_IDS.MOVEMENT_DESTINATION_INVALID]: {
    level: 'warn', text: ({ occupied, actorName } = {}) => occupied
      ? `${actorName || 'This Character'} cannot end movement on an occupied tile!`
      : 'That destination is no longer reachable.'
  },
  [NOTIFICATION_IDS.MOVEMENT_STATE_STALE]: {
    level: 'warn', text: () => 'The board changed before movement was committed. Choose a destination again.'
  },
  [NOTIFICATION_IDS.MOVEMENT_OUT_OF_AREA]: { level: 'warn', text: () => 'Out of the Movement area.' },
  [NOTIFICATION_IDS.FLIGHT_TOGGLED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.FLIGHT_TAKEN_OFF]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.FLIGHT_SET]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.FREE_TARGETING_SET]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.PACIFIST_SET]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.PACIFIST_LOCKED]: {
    level: 'warn', text: () => "Only a GM can change this unit's counterattack mode after its turn"
  },
  [NOTIFICATION_IDS.TELEPORT_USED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.CROSSING_ATTEMPTED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.CROSSING_UNAVAILABLE]: { level: 'warn', text: () => 'This unit cannot cross terrain right now.' },
  [NOTIFICATION_IDS.CROSSING_ACTION_REQUIRED]: {
    level: 'warn', text: () => 'Crossing terrain takes an action this unit no longer has.'
  },
  [NOTIFICATION_IDS.CROSSING_MOVEMENT_REQUIRED]: {
    level: 'warn', text: () => 'Crossing terrain needs a square of movement left.'
  },
  [NOTIFICATION_IDS.CROSSING_STANCE_REQUIRED]: {
    level: 'warn', text: () => 'A Stance Broken unit cannot cross terrain.'
  },
  [NOTIFICATION_IDS.CROSSING_DESTINATION_INVALID]: {
    level: 'warn', text: () => 'That is not a square this unit can cross onto.'
  },
  [NOTIFICATION_IDS.CROSSING_STALE]: {
    level: 'warn', text: () => 'The crossing could not be completed. Ask the Gamemaster to recover the turn.'
  },
  [NOTIFICATION_IDS.TELEPORT_UNAVAILABLE]: {
    level: 'warn', text: () => 'This unit cannot use that transition square.'
  },
  [NOTIFICATION_IDS.TELEPORT_UNPAIRED]: {
    level: 'warn', text: data => `Teleport ${data.letter ?? '?'} has no paired square.`
  },
  [NOTIFICATION_IDS.TELEPORT_EXIT_BLOCKED]: {
    level: 'warn', text: data => `Teleport ${data.letter ?? '?'} is blocked because its far side is occupied.`
  },
  [NOTIFICATION_IDS.TELEPORT_EXIT_CROWDED]: {
    level: 'warn', text: data => `Teleport ${data.letter ?? '?'} has no free square to arrive on.`
  },
  [NOTIFICATION_IDS.TELEPORT_MOVEMENT_REQUIRED]: {
    level: 'warn', text: data => `Teleport ${data.letter ?? '?'} needs ${data.movementCost ?? 0} Movement.`
  },
  [NOTIFICATION_IDS.TELEPORT_BONUS_REQUIRED]: {
    level: 'warn', text: () => 'No Bonus Action remaining for this Teleport.'
  },
  [NOTIFICATION_IDS.TELEPORT_ACTION_REQUIRED]: {
    level: 'warn', text: () => 'No Action remaining for this Teleport.'
  },
  [NOTIFICATION_IDS.TELEPORT_SETTLEMENT_FAILED]: { backend: 'foundry/adapters/document-writes/movement.mjs',
    level: 'error', text: () => 'That hop failed part-way and was undone, so the unit is back on the pad.'
  },
  [NOTIFICATION_IDS.FLIGHT_COMBAT_ACTION_REQUIRED]: {
    level: 'warn', text: () => 'Take off with the flight action during combat.'
  },
  [NOTIFICATION_IDS.MOVEMENT_PERMISSIONS_ENFORCED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.FLIGHT_UNAVAILABLE]: { level: 'warn', text: () => 'This unit cannot take to the air.' },
  [NOTIFICATION_IDS.FLIGHT_FORBIDDEN]: { level: 'warn', text: () => 'Flying is not permitted on this map.' },
  [NOTIFICATION_IDS.FLIGHT_ACTION_REQUIRED]: {
    level: 'warn', text: () => 'Taking off or landing uses the whole action.'
  },
  [NOTIFICATION_IDS.FLIGHT_LANDING_BLOCKED]: { level: 'warn', text: () => 'Obstacle blocks landing.' },
  [NOTIFICATION_IDS.FLIGHT_STANCE_BROKEN]: { level: 'warn', text: () => 'A Stance Broken unit cannot take off.' },
  [NOTIFICATION_IDS.FORCED_LANDING_BLOCKED]: {
    level: 'warn', text: () => 'That would set this unit down on an obstacle. Fly clear of it first.'
  },

  // Targeting
  [NOTIFICATION_IDS.TARGETING_WARNING]: {
    level: 'warn', text: ({ message }) => message || 'That target is not valid.'
  },

  // Combat preview
  [NOTIFICATION_IDS.COMBAT_PREVIEW_REFRESH_FAILED]: { backend: 'ui/apps/menus/previews.mjs',
    level: 'error', text: () => 'The combat preview could not update that choice.'
  },

  // Development
  [NOTIFICATION_IDS.UNITS_RESTORED]: {
    level: 'info',
    text: ({ scopeName, unitCount }) =>
      `${unitCount} unit${unitCount === 1 ? '' : 's'} fully restored (${scopeName}).`
  },
  [NOTIFICATION_IDS.ITEMS_REPAIRED]: {
    level: 'info',
    text: ({ scopeName, itemCount }) =>
      `${itemCount} item${itemCount === 1 ? '' : 's'} repaired (${scopeName}).`
  },
  [NOTIFICATION_IDS.TERRAIN_EFFECTS_CLEARED]: {
    level: 'info',
    text: ({ cells }) => (cells
      ? `${cells} terrain effect${cells === 1 ? '' : 's'} cleared.`
      : 'No temporary terrain effects were standing.')
  },
  [NOTIFICATION_IDS.SCENE_NOT_FOUND]: { level: 'warn', text: () => 'That Scene could not be found.' },

  // Actor tools
  [NOTIFICATION_IDS.ACTOR_CONTROL_COLOR_INVALID]: {
    level: 'warn',
    text: () => 'Faction color must use the #RRGGBB format.'
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_UPDATE_FAILED]: { backend: 'foundry/adapters/document-writes/characters.mjs',
    level: 'error',
    text: () => 'The Actor Control Panel could not save that change.'
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_INFO]: {
    level: 'info',
    text: ({ message }) => message || 'Actor token art updated.'
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_WARNING]: {
    level: 'warn',
    text: ({ message }) => message || 'Check the Actor Control Panel values.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_OBJECTIVE_WARNING]: {
    level: 'warn',
    text: ({ message }) => message || 'An objective on this map cannot be met as configured.'
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_ACTOR_REQUIRED]: {
    level: 'warn',
    text: () => 'Choose a Character before opening Emblem Character Studio.'
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_BASE_ACTOR_REQUIRED]: {
    level: 'warn',
    text: () => 'Token art is edited on the base actor, not on an unlinked token.'
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_SLOT_UNKNOWN]: {
    level: 'warn',
    text: ({ slot }) => `Unknown token slot "${slot}".`
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_TAB_NOT_FOUND]: {
    level: 'warn',
    text: ({ tabId, actorName }) => `Token tab "${tabId}" not found on ${actorName}.`
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_ENTRY_NOT_FOUND]: {
    level: 'warn',
    text: ({ entryIndex, tabId }) => `Tab entry ${entryIndex} not found in tab "${tabId}".`
  },
  [NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_UNAVAILABLE]: { backend: 'external/studio/character-art.mjs',
    level: 'error',
    text: () => 'Emblem Character Studio is unavailable. Verify that emblem-rpg-studio is active.'
  },
  [NOTIFICATION_IDS.OBJECT_TOOL_PENDING]: {
    level: 'info',
    text: () => 'This Object tool will be connected when its gameplay workflow is rebuilt.'
  },
  [NOTIFICATION_IDS.OBJECT_KEY_ITEM_TYPE]: {
    level: 'warn', text: () => 'Only Equipment, Consumables and Miscellaneous items can be keys.'
  },
  [NOTIFICATION_IDS.OBJECT_CONTENT_ITEM_TYPE]: {
    level: 'warn', text: () => 'Only Equipment, Consumables, Miscellaneous items and Resources can be stored here.'
  },
  [NOTIFICATION_IDS.OBJECT_STANCE_BROKEN]: { level: 'warn', text: () => 'No actions while Stance Broken.' },
  [NOTIFICATION_IDS.TERRAIN_INFO]: { level: 'info', text: ({ message }) => message || 'Terrain updated.' },
  [NOTIFICATION_IDS.TERRAIN_WARNING]: {
    level: 'warn', text: ({ message }) => message || 'Check the terrain authoring values.'
  },

  // Party configuration
  [NOTIFICATION_IDS.PARTY_ACTOR_IMPORT_REQUIRED]: {
    level: 'warn', text: () => 'Import the actor into the world before granting ownership.'
  },
  [NOTIFICATION_IDS.PARTY_SNAPSHOT]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.PARTY_ACTOR_CANDIDATE]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.PARTY_ACTOR_UUID_INVALID]: { level: 'warn', text: () => 'That UUID does not resolve to an Actor.' },
  [NOTIFICATION_IDS.PARTY_CHARACTER_REQUIRED]: {
    level: 'warn', text: () => 'Only Character actors can be assigned as Lord or Retainers.'
  },
  [NOTIFICATION_IDS.PARTY_CONVOY_IMPORT_REQUIRED]: {
    level: 'warn', text: () => 'Import the convoy into the world before linking it.'
  },
  [NOTIFICATION_IDS.PARTY_CONVOY_REQUIRED]: {
    level: 'warn', text: () => 'Only a Convoy actor can be linked to a party.'
  },
  [NOTIFICATION_IDS.PARTY_DROP_ACTOR_REQUIRED]: { level: 'warn', text: () => 'Drop an Actor from the directory.' },
  [NOTIFICATION_IDS.PARTY_OWNERSHIP_GRANTED]: {
    level: 'info', text: ({ userName, actorName }) => `Granted ${userName} ownership of ${actorName}.`
  },
  [NOTIFICATION_IDS.PARTY_OWNERSHIP_GRANT_FAILED]: { backend: 'foundry/adapters/document-writes/parties.mjs',
    level: 'error', text: () => 'Ownership grant failed. See the console for details.'
  },
  [NOTIFICATION_IDS.PARTY_OWNERSHIP_REVOKE_FAILED]: { backend: 'foundry/adapters/document-writes/parties.mjs',
    level: 'error', text: () => 'Ownership revoke failed. See the console for details.'
  },
  [NOTIFICATION_IDS.PARTY_PLAYER_CHARACTER_SYNC_FAILED]: { backend: 'foundry/adapters/document-writes/parties.mjs',
    level: 'error', text: ({ userName }) => `${userName}'s Lord was assigned, but their Player Character was not updated.`
  },
  [NOTIFICATION_IDS.PARTY_UNIT_TYPE_FAILED]: { backend: 'foundry/adapters/document-writes/parties.mjs',
    level: 'error', text: () => 'Unit type change failed. See the console for details.'
  },
  [NOTIFICATION_IDS.PARTY_STATE_UPDATE_FAILED]: { backend: 'foundry/adapters/document-writes/parties.mjs',
    level: 'error', text: () => 'Party configuration could not be saved completely.'
  },
  [NOTIFICATION_IDS.PARTY_UNIT_ASSIGNMENT_FAILED]: { backend: 'foundry/adapters/document-writes/parties.mjs',
    level: 'error', text: () => 'The unit assignment could not be completed.'
  },
  [NOTIFICATION_IDS.PARTY_UNIT_TYPE_CONFIRMATION_REQUIRED]: {
    level: 'warn', text: ({ requiredType }) => `Confirm changing this unit to ${requiredType || 'the required type'}.`
  },
  [NOTIFICATION_IDS.FEATURE_TYPE_REQUIRED]: { level: 'warn', text: () => 'Choose an Ability or Spell.' },
  [NOTIFICATION_IDS.FEATURE_NOT_FOUND]: { level: 'warn', text: ({ name }) => `Could not resolve "${name}".` },
  [NOTIFICATION_IDS.CLASS_MOUNT_EXISTS]: { level: 'warn', text: () => 'This Class already has a Mount.' },
  [NOTIFICATION_IDS.PROMOTION_ITEM_REQUIRED]: { level: 'warn', text: () => 'Drop a Promotion Consumable here.' },
  [NOTIFICATION_IDS.PROMOTION_CLASS_REQUIRED]: { level: 'warn', text: () => 'Select a promotion Class.' },
  [NOTIFICATION_IDS.ITEM_JSON_INVALID]: { level: 'warn', text: ({ field }) => `${field || 'The JSON field'} is not valid JSON.` },
  [NOTIFICATION_IDS.ITEM_EDITOR_UNAVAILABLE]: { level: 'warn', text: () => 'That editor is not available for this item subtype.' },
  [NOTIFICATION_IDS.ITEM_EDITOR_INFO]: { level: 'info', text: ({ message }) => message || 'Item editor updated.' },
  [NOTIFICATION_IDS.ITEM_EDITOR_WARNING]: { level: 'warn', text: ({ message }) => message || 'Check the item editor values.' },
  [NOTIFICATION_IDS.ITEM_EDITOR_ERROR]: { level: 'warn', text: ({ message }) => message || 'The item editor could not complete that action.' },
  [NOTIFICATION_IDS.ITEM_AUTHORING_DENIED]: { level: 'warn', text: () => 'Only an Assistant GM or GM may author system documents.' },
  [NOTIFICATION_IDS.STAFF_CREATED]: { level: 'info', text: ({ itemName }) => `Created "${itemName}".` },
  [NOTIFICATION_IDS.ITEM_NOT_FOUND]: { level: 'warn', text: () => 'The source item could not be found.' },
  [NOTIFICATION_IDS.ITEM_DATABASE_REFINEMENT_FORBIDDEN]: {
    level: 'warn', text: ({ itemName }) => `Database items cannot be refined. Remove the (+N) suffix from "${itemName}".`
  },
  [NOTIFICATION_IDS.ITEM_REFINEMENT_RESET]: {
    level: 'info', text: ({ itemName }) => `"${itemName}" was reset to its base stats with the new tier applied.`
  },
  [NOTIFICATION_IDS.ITEM_REFINEMENT_REVERTED]: {
    level: 'info', text: ({ oldName, baseName }) => `"${oldName}" reverted to the base stats of "${baseName}".`
  },
  [NOTIFICATION_IDS.ITEM_REFINEMENT_BASE_MISSING]: {
    level: 'warn', text: ({ baseName }) => `Base item "${baseName}" was not found, so its stats were not reset.`
  },
  // BG3 HUD
  [NOTIFICATION_IDS.BG3_NO_ACTOR]: { level: 'warn', text: () => 'No actor selected.' },
  [NOTIFICATION_IDS.BG3_PERSISTENCE_UNAVAILABLE]: { backend: 'external/bg3-hud/hotbar.mjs', level: 'error', text: () => 'Hotbar persistence manager unavailable.' },
  [NOTIFICATION_IDS.BG3_AUTO_POPULATE_UNAVAILABLE]: { backend: 'external/bg3-hud/hotbar.mjs', level: 'error', text: () => 'Auto-populate unavailable.' },
  [NOTIFICATION_IDS.BG3_HOTBAR_COMPLETE]: { level: 'info', text: () => 'All eligible items are already on the hotbar.' },
  [NOTIFICATION_IDS.BG3_RESYNC_SELECT_TOKEN]: { level: 'warn', text: () => 'Select a token to resync its hotbar.' },
  [NOTIFICATION_IDS.BG3_RESYNC_NOT_OWNED]: { level: 'warn', text: () => 'Not your unit.' },
  [NOTIFICATION_IDS.BG3_INSPECTING_UNIT]: {
    level: 'info', text: () => 'You are inspecting another unit. Select your own unit to act.'
  },
  [NOTIFICATION_IDS.ENCOUNTER_SCENE_REQUIRED]: { level: 'warn', text: () => 'Activate a map before creating an encounter.' }
});

/* -------------------------------------------- */
/*  Requirement and equipment copy              */
/* -------------------------------------------- */
/** Format item caster-requirement failures: Silenced first, then failed requirements by name. */
function casterRequirementText(data = {}) {
  const itemName = data.itemName || 'This item';
  if (data.silenced === true) return 'Casting is prevented while Silenced.';
  const names = (data.requirementNames ?? []).filter(Boolean);
  if (names.length === 0) return `${itemName} does not meet its requirements.`;
  return `${itemName} requires ${names.join(', ')}.`;
}

/** Name the ability and the side it was authored for, so a misaimed pick says which rule stopped it. */
function targetFactionText(data = {}) {
  const side = data.targetType === 'Friendly' ? 'friendly' : 'hostile';
  return `${data.itemName || 'That item'} may only target ${side} units.`;
}

/** Format item target-requirement failures with the refused Token names. */
function targetRequirementText(data = {}) {
  const itemName = data.itemName || 'This item';
  const names = (data.targetNames ?? []).filter(Boolean);
  if (names.length === 0) return `${itemName} cannot be used on that target.`;
  return `${itemName} cannot be used on ${names.join(', ')}.`;
}

/** Map inventory rule refusal codes to notification text. */
const EQUIPMENT_REFUSAL_TEXT = Object.freeze({
  [EQUIPMENT_REFUSALS.TURN_OVER]: () => 'Turn is over.',
  [EQUIPMENT_REFUSALS.ACTION_REQUIRED]: () => 'Needs an Action.',
  [EQUIPMENT_REFUSALS.ITEM_DEPLETED]: ({ itemName }) => `${itemName} is depleted.`,
  [EQUIPMENT_REFUSALS.PROFICIENCY_UNKNOWN]: ({ required }) => `Unknown weapon requirement: ${required}.`,
  [EQUIPMENT_REFUSALS.PROFICIENCY_REQUIRED]: ({ required, rankLabel, itemName }) =>
    `${capitalizeWord(required)} ${rankLabel} required to use ${itemName}.`,
  [EQUIPMENT_REFUSALS.ARMOR_IN_COMBAT]: () => 'Armor is locked in combat.',
  [EQUIPMENT_REFUSALS.HANDOVER_IN_COMBAT]: () => 'Items change hands only through the Trade action in combat.',
  [EQUIPMENT_REFUSALS.ARMOR_PROFICIENCY_UNKNOWN]: ({ required }) => `Unknown armor requirement: ${required}.`,
  [EQUIPMENT_REFUSALS.ARMOR_PROFICIENCY_REQUIRED]: ({ required, itemName }) =>
    `${capitalizeWord(required)} armor proficiency required to wear ${itemName}.`,
  [EQUIPMENT_REFUSALS.MOUNT_ALREADY_ACTIVE]: ({ actorName, itemName }) =>
    `${actorName} already has a Mount (${itemName}).`,
  [EQUIPMENT_REFUSALS.REQUIREMENTS_UNMET]: ({ itemName, requirementNames = [] }) =>
    `${itemName}'s requirements are not met${requirementNames.length ? ` (${requirementNames.join(', ')})` : ''}.`
});

/** The diagnostic text for a failed promotion, with a specific message when it could not end the unit's turn. */
function promotionFailureText(data = {}) {
  if (data.reasonCode === 'promotion.turn-failed') return 'The promotion could not end that turn. Nothing was changed.';
  return 'The promotion did not complete.';
}

function equipmentRefusalText(data = {}) {
  const specific = EQUIPMENT_REFUSAL_TEXT[data.reasonCode];
  if (specific) return specific(data);
  return data.message || 'That inventory change is not allowed.';
}

function capitalizeWord(word) {
  const text = String(word ?? '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Format the combat contract’s Guard-bond break reasons. */
function guardBondBreakReason(reason, actorName) {
  if (reason === GUARD_BOND_BREAKS.FELL) return `${actorName} fell`;
  if (reason === GUARD_BOND_BREAKS.LEFT) return `${actorName} left the bond`;
  return 'partner not found';
}

/** Why an effect step or entry was skipped, by the code engine/effects/execution.mjs reports. */
const EFFECT_SKIP_REASONS = Object.freeze({
  [EFFECT_STEP_PRECONDITION_FAILURES.PRESET_MISSING]: 'it names no status to apply',
  [EFFECT_STEP_PRECONDITION_FAILURES.MOVE_TARGET_MISSING]: 'there was no unit to move',
  [EFFECT_STEP_PRECONDITION_FAILURES.MOVE_PAIR_MISSING]: 'there was no unit to move against',
  [EFFECT_STEP_PRECONDITION_FAILURES.MOVE_MODE_UNKNOWN]: 'its movement mode is unknown',
  [EFFECT_STEP_PRECONDITION_FAILURES.MOVE_DESTINATION_MISSING]: 'there was no square to move to',
  [EFFECT_STEP_PRECONDITION_FAILURES.SPAWN_SOURCE_MISSING]: 'the unit to summon, or the map, was not found',
  [EFFECT_STEP_PRECONDITION_FAILURES.SPAWN_LOCATION_MISSING]: 'there was no square to summon onto',
  [EFFECT_STEP_PRECONDITION_FAILURES.GUARD_TARGET_MISSING]: 'there was no unit to Guard',
  [EFFECT_PLAN_ERRORS.INVALID_ENTRY]: 'the entry is invalid',
  [EFFECT_PLAN_ERRORS.CONDITION_FAILED]: 'its condition could not be evaluated'
});

/** The GM's notice for a skipped effect step or entry. A refused Guard bond reads as one reason. */
function effectSkipText({ itemName = '', stepKind = '', code = '' } = {}) {
  const reason = EFFECT_SKIP_REASONS[code]
    ?? (Object.values(GUARD_BOND_REFUSALS).includes(code) ? 'the Guard bond could not form' : 'it could not run');
  const skipped = stepKind ? `its ${stepKind} step was skipped` : 'an effect entry was skipped';
  return `${itemName || 'An effect'}: ${skipped} because ${reason}. The console has the details.`;
}
