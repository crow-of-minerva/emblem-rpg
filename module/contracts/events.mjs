/** @layer contracts */

/* -------------------------------------------- */
/*  Event contracts                             */
/* -------------------------------------------- */
/**
 * The events the engine publishes as commands succeed. Companion modules subscribe with
 * `api.events.on(type, handler)`, and `api.events.types` lists these ids.
 */
export const EVENT_IDS = Object.freeze({
  STANDARD_ACTION_SPENT: 'character.standard-action-spent',
  STANDARD_ACTION_RESTORED: 'character.standard-action-restored',
  SKILL_CHECK_ROLLED: 'character.skill-check-rolled',
  INVENTORY_EQUIPMENT_UPDATED: 'inventory.equipment-updated',
  INVENTORY_ITEM_TRANSFERRED: 'inventory.item-transferred',
  CHARACTER_CLASS_ASSIGNED: 'character.class-assigned',
  CLASS_FEATURES_SELECTED: 'class.features-selected',
  CLASS_FEATURES_RECONCILED: 'class.features-reconciled',
  CHARACTER_PROMOTED: 'character.promoted',
  INNATE_GRANTS_RECONCILED: 'character.innate-grants-reconciled',
  CHARACTER_EXPERIENCE_GRANTED: 'character.experience-granted',
  CHARACTER_LEVEL_GAINED: 'character.level-gained',
  SKILL_EXPERIENCE_GRANTED: 'character.skill-experience-granted',
  SKILL_RANK_GAINED: 'character.skill-rank-gained',
  ACTOR_DAMAGED: 'actor.damaged',
  ACTOR_HEALED: 'actor.healed',
  ACTOR_EXTRA_LIFE_TRIGGERED: 'actor.extra-life-triggered',
  ACTOR_DEFEATED: 'actor.defeated',
  COMBAT_EXCHANGE_COMMITTED: 'combat.exchange-committed',
  ITEM_ACTIVATION_COMMITTED: 'items.activation-committed',
  OBJECT_LOCK_ATTEMPTED: 'objects.lock-attempted',
  ARMAMENT_WIELDED: 'objects.armament-wielded',
  ARMAMENT_RELEASED: 'objects.armament-released',
  ITEM_DROPPED: 'objects.item-dropped',
  GATHERING_SETTLED: 'downtime.gathering-settled',
  FORGING_SETTLED: 'downtime.forging-settled',
  BREWING_SETTLED: 'downtime.brewing-settled',
  COOKING_SETTLED: 'downtime.cooking-settled',
  PERFORMANCE_SETTLED: 'downtime.performance-settled',
  SOCIALIZE_SETTLED: 'downtime.socialize-settled',
  TRAINING_SETTLED: 'downtime.training-settled',
  REQUISITION_SETTLED: 'downtime.requisition-settled',
  TRADE_COMPLETED: 'economy.trade-completed',
  STEAL_ATTEMPTED: 'economy.steal-attempted',
  VENDOR_TRADED: 'economy.vendor-traded',
  VENDOR_HAGGLED: 'economy.vendor-haggle-settled',
  CONVOY_DEPOSITED: 'economy.convoy-deposited',
  CONVOY_WITHDRAWN: 'economy.convoy-withdrawn',
  CONVOY_DELIVERED: 'economy.convoy-delivered',
  ENCOUNTER_BEGAN: 'encounters.began',
  ENCOUNTER_PHASE_ADVANCED: 'encounters.phase-advanced',
  ENCOUNTER_ENDED: 'encounters.ended',
  ENCOUNTER_OBJECTIVES_AUTHORED: 'encounters.objectives-authored',
  ENCOUNTER_OBJECTIVE_END_QUEUED: 'encounters.objective-end-queued',
  ENCOUNTER_OBJECTIVE_END_COMMITTED: 'encounters.objective-end-committed',
  STANCE_BREAK_APPLIED: 'character.stance-break-applied',
  STANCE_BREAK_CLEARED: 'character.stance-break-cleared',
  MOVEMENT_COMMITTED: 'movement.committed',
  FLIGHT_TOGGLED: 'movement.flight-toggled',
  UNITS_RESTORED: 'development.units-restored',
  ITEMS_REPAIRED: 'development.items-repaired',
  TERRAIN_EFFECTS_CLEARED: 'development.terrain-effects-cleared'
});
