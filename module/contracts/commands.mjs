/** @layer contracts */

/* -------------------------------------------- */
/*  Command contracts                           */
/* -------------------------------------------- */

/**
 * How many times an engine command handler tries to settle against freshly projected state. A stale settlement is
 * retried once, and the command refuses if the second attempt is also stale.
 */
export const MAX_SETTLEMENT_ATTEMPTS = 2;
export const COMMAND_IDS = Object.freeze({
  RECOVERY: Object.freeze({ CLEAR_LOCK: 'recovery.clear-lock', CLEAR_BUSY: 'recovery.clear-busy' }),
  CHARACTER: Object.freeze({
    ACTIONS: Object.freeze({
      SPEND_STANDARD: 'character.actions.spend-standard',
      RESTORE_STANDARD: 'character.actions.restore-standard'
    }),
    SKILLS: Object.freeze({ ROLL: 'character.skills.roll' }),
    INVENTORY: Object.freeze({
      TOGGLE_EQUIPMENT: 'character.inventory.toggle-equipment',
      TRANSFER: 'character.inventory.transfer'
    }),
    CLASSES: Object.freeze({
      ASSIGN: 'character.classes.assign',
      SELECT_FEATURES: 'character.classes.select-features',
      REOPEN_BUNDLE: 'character.classes.reopen-bundle',
      PROMOTE: 'character.classes.promote'
    }),
    PROGRESSION: Object.freeze({
      GRANT_EXPERIENCE: 'character.progression.grant-experience',
      GRANT_SKILL_EXPERIENCE: 'character.progression.grant-skill-experience',
      LEVEL_UP: 'character.progression.level-up'
    }),
    SUPPORT: Object.freeze({
      GRANT_XP: 'character.support.grant-xp',
      SET_PARTNERS: 'character.support.set-partners'
    }),
    KNOWLEDGE: Object.freeze({ GRANT_JOURNAL_ACCESS: 'character.knowledge.grant-journal-access' }),
    TARGETING: Object.freeze({ SET_FREE_TARGETING: 'character.targeting.set-free-targeting' }),
    COUNTER: Object.freeze({ SET_PACIFIST: 'character.counter.set-pacifist' }),
    HOTBAR: Object.freeze({ SAVE_LAYOUT: 'character.hotbar.save-layout' })
  }),
  MOVEMENT: Object.freeze({
    BEGIN: 'movement.begin',
    COMMIT: 'movement.commit',
    CANCEL: 'movement.cancel',
    ROLLBACK: 'movement.rollback',
    DRIVE: 'movement.drive',
    TOGGLE_FLIGHT: 'movement.toggle-flight',
    TAKE_OFF: 'movement.take-off',
    SET_FLIGHT: 'movement.set-flight',
    TELEPORT: 'movement.teleport',
    CROSS: 'movement.cross'
  }),
  COMBAT: Object.freeze({
    APPLY_DAMAGE: 'combat.apply-damage',
    APPLY_HEALING: 'combat.apply-healing',
    RESOLVE_EXCHANGE: 'combat.resolve-exchange',
    RESOLVE_CONTINUATION: 'combat.resolve-continuation'
  }),
  ITEMS: Object.freeze({ ACTIVATE: 'items.activate' }),
  OBJECTS: Object.freeze({
    OPEN_LOCK: 'objects.open-lock',
    WIELD_ARMAMENT: 'objects.wield-armament',
    RELEASE_ARMAMENT: 'objects.release-armament',
    DROP_ITEM: 'objects.drop-item'
  }),
  DOWNTIME: Object.freeze({
    GATHER: 'downtime.gather',
    FORGE: 'downtime.forge',
    BREW: 'downtime.brew',
    COOK: 'downtime.cook',
    PERFORM: 'downtime.perform',
    SOCIALIZE: 'downtime.socialize',
    TRAIN: 'downtime.train',
    REQUISITION: 'downtime.requisition',
    SAVE_RECIPE_LIBRARY: 'downtime.save-recipe-library',
    SAVE_SONG_LIBRARY: 'downtime.save-song-library',
    RESET_ACTIVITY: 'downtime.reset-activity',
    RESTORE_ENERGY: 'downtime.restore-energy',
    RESET: 'downtime.reset'
  }),
  ECONOMY: Object.freeze({
    TRADE: 'economy.trade',
    STEAL: 'economy.steal',
    CONVOY_DEPOSIT: 'economy.convoy-deposit',
    CONVOY_WITHDRAW: 'economy.convoy-withdraw',
    CONVOY_DELIVER: 'economy.convoy-deliver',
    VENDOR_STOCK: 'economy.vendor-stock',
    VENDOR_PURCHASE: 'economy.vendor-purchase',
    VENDOR_SELL: 'economy.vendor-sell',
    VENDOR_CHECKOUT: 'economy.vendor-checkout',
    HAGGLE: 'economy.haggle',
    VENDOR_MERCHANDISE: 'economy.vendor-merchandise'
  }),
  ENCOUNTERS: Object.freeze({
    CREATE: 'encounters.create',
    BEGIN: 'encounters.begin',
    ADVANCE_PHASE: 'encounters.advance-phase',
    END: 'encounters.end',
    CANCEL: 'encounters.cancel',
    PAUSE: 'encounters.pause',
    RESUME: 'encounters.resume',
    DISCARD_PAUSE: 'encounters.discard-pause',
    SET_AUTO_ADVANCE: 'encounters.set-auto-advance',
    SET_COMBAT_MUSIC: 'encounters.set-combat-music',
    SET_EXPLORATION: 'encounters.set-exploration',
    SET_ROUND: 'encounters.set-round',
    END_TURN: 'encounters.end-turn',
    OBJECTIVES: Object.freeze({ AUTHOR: 'encounters.objectives.author' })
  }),
  DEVELOPMENT: Object.freeze({
    RESTORE_UNITS: 'development.restore-units',
    REPAIR_ITEMS: 'development.repair-items',
    CLEAR_TERRAIN_EFFECTS: 'development.clear-terrain-effects'
  })
});

/** Commands raised by trusted lifecycle adapters rather than exposed to ordinary callers. */
export const INTERNAL_COMMAND_IDS = Object.freeze({
  CHARACTER: Object.freeze({
    CLASSES: Object.freeze({ RECONCILE_FEATURES: 'character.classes.reconcile-features' }),
    INVENTORY: Object.freeze({ RECONCILE_EFFECTS: 'character.inventory.reconcile-effects' }),
    INNATE_GRANTS: Object.freeze({ RECONCILE: 'character.innate-grants.reconcile' }),
    SUPPORT: Object.freeze({ RECONCILE_MIRROR: 'character.support.reconcile-mirror' })
  }),
  BOARD: Object.freeze({ RECONCILE_MODIFIERS: 'board.reconcile-modifiers' }),
  MOVEMENT: Object.freeze({
    ENFORCE_PERMISSIONS: 'movement.enforce-permissions',
    FORCE_CROSSING: 'movement.force-crossing'
  }),
  DOWNTIME: Object.freeze({
    REPAIR_RECIPE_LIBRARY: 'downtime.repair-recipe-library',
    REPAIR_SONG_LIBRARY: 'downtime.repair-song-library'
  }),
  ECONOMY: Object.freeze({ RECONCILE_COINPURSE: 'economy.reconcile-coinpurse' }),
  ENCOUNTERS: Object.freeze({
    COMPLETE_TURN: 'encounters.complete-turn',
    CHECK_OBJECTIVES: 'encounters.check-objectives',
    RESOLVE_OBJECTIVE_END: 'encounters.resolve-objective-end',
    FINISH_CONTINUATION: 'encounters.finish-continuation'
  }),
  VISION: Object.freeze({ RECONCILE_DOORS: 'vision.reconcile-doors' })
});

/* -------------------------------------------- */
/*  Execution lanes                             */
/* -------------------------------------------- */

/**
 * How CommandDispatcher admits a command. While execution is held, a command is refused as busy, but a gameplay
 * command first waits up to maintenanceYieldMs behind maintenance, startup or recovery work. MaintenanceScheduler
 * and the startup sweeps in init/system.mjs retry a busy refusal. Inspection runs without taking execution, and a
 * child command must run inside its parent's execution.
 */
export const COMMAND_LANES = Object.freeze({
  GAMEPLAY: 'gameplay',
  INSPECT: 'inspect',
  MAINTENANCE: 'maintenance',
  RECOVERY: 'recovery',
  STARTUP: 'startup',
  CHILD: 'child'
});

/**
 * Commands that don't use the default gameplay lane. Hotbar saves use the inspect lane because they change only HUD
 * layout flags, and the layout's revision number guards against two saves racing without blocking gameplay.
 */
const LANE_BY_COMMAND = Object.freeze({
  [COMMAND_IDS.RECOVERY.CLEAR_LOCK]: COMMAND_LANES.RECOVERY,
  [COMMAND_IDS.RECOVERY.CLEAR_BUSY]: COMMAND_LANES.INSPECT,
  [COMMAND_IDS.CHARACTER.HOTBAR.SAVE_LAYOUT]: COMMAND_LANES.INSPECT,
  [INTERNAL_COMMAND_IDS.ENCOUNTERS.RESOLVE_OBJECTIVE_END]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.ENCOUNTERS.FINISH_CONTINUATION]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.ENCOUNTERS.COMPLETE_TURN]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.ENCOUNTERS.CHECK_OBJECTIVES]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.CHARACTER.CLASSES.RECONCILE_FEATURES]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.CHARACTER.INVENTORY.RECONCILE_EFFECTS]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.CHARACTER.INNATE_GRANTS.RECONCILE]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.CHARACTER.SUPPORT.RECONCILE_MIRROR]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.BOARD.RECONCILE_MODIFIERS]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.MOVEMENT.ENFORCE_PERMISSIONS]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.ECONOMY.RECONCILE_COINPURSE]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.VISION.RECONCILE_DOORS]: COMMAND_LANES.MAINTENANCE,
  [INTERNAL_COMMAND_IDS.DOWNTIME.REPAIR_RECIPE_LIBRARY]: COMMAND_LANES.STARTUP,
  [INTERNAL_COMMAND_IDS.DOWNTIME.REPAIR_SONG_LIBRARY]: COMMAND_LANES.STARTUP,
  [INTERNAL_COMMAND_IDS.MOVEMENT.FORCE_CROSSING]: COMMAND_LANES.CHILD
});

/**
 * The admission lane of one command id. Any command not listed above is gameplay.
 * @param {string} commandId A command id from {@link COMMAND_IDS} or {@link INTERNAL_COMMAND_IDS}.
 * @returns {string} One of {@link COMMAND_LANES}.
 */
export function commandLane(commandId) {
  return LANE_BY_COMMAND[commandId] ?? COMMAND_LANES.GAMEPLAY;
}

/**
 * Whether CommandDispatcher shows the processing blocker while this command runs. Inspect and maintenance commands,
 * movement planning (begin, cancel, rollback and the flight toggles) and the counterattack mode toggle, a one-field
 * write, leave the interface open. A movement commit blocks only when it doesn't go back to planning.
 */
export function commandBlocks(commandId, payload = {}) {
  if ([COMMAND_LANES.INSPECT, COMMAND_LANES.MAINTENANCE].includes(commandLane(commandId))) return false;
  if (commandId === COMMAND_IDS.MOVEMENT.COMMIT) return payload.resume === false;
  return !PLANNING_COMMANDS.has(commandId) && commandId !== COMMAND_IDS.CHARACTER.COUNTER.SET_PACIFIST;
}

const PLANNING_COMMANDS = new Set([
  COMMAND_IDS.MOVEMENT.BEGIN, COMMAND_IDS.MOVEMENT.CANCEL, COMMAND_IDS.MOVEMENT.ROLLBACK,
  COMMAND_IDS.MOVEMENT.TOGGLE_FLIGHT, COMMAND_IDS.MOVEMENT.TAKE_OFF, COMMAND_IDS.MOVEMENT.SET_FLIGHT
]);

/**
 * Whether the world pause freezes this command: every gameplay command except cancelling or rolling back a move.
 * Pair it with pauseFreezesUser, which checks the requester's role.
 * @param {string} commandId A command id from {@link COMMAND_IDS} or {@link INTERNAL_COMMAND_IDS}.
 * @returns {boolean}
 */
export function commandFrozenByPause(commandId) {
  return commandLane(commandId) === COMMAND_LANES.GAMEPLAY && !PAUSE_RELEASE_COMMANDS.has(commandId);
}

/**
 * Cancel and rollback stay allowed during the world pause, so a player can still put down the unit they were
 * moving.
 */
const PAUSE_RELEASE_COMMANDS = new Set([COMMAND_IDS.MOVEMENT.CANCEL, COMMAND_IDS.MOVEMENT.ROLLBACK]);
