/** @layer presentation/interface */
import {
  INVENTORY_CAPACITY_NOTICE_KIND,
  INVENTORY_REFUSAL_PRESENTATION_KIND,
  REFINEMENT_OUTCOME_CODES,
  inventoryRefusalPresentationMessage
} from '../../contracts/domains/items.mjs';
import { NOTIFICATION_IDS } from './notification-ids.mjs';
import { NOTIFICATIONS } from './notification-catalog.mjs';
import { playUiSound } from '../audio/service.mjs';
import { SOUND_IDS } from '../audio/sound-database.mjs';
import { createDiagnostic, isDiagnostic, recordDiagnostic } from '../../contracts/protocol.mjs';

export { NOTIFICATION_IDS, NOTIFICATIONS };

/* -------------------------------------------- */
/*  Notification service                        */
/* -------------------------------------------- */
const REFUSAL_LEVELS = Object.freeze(['warn', 'error']);

/**
 * Player text for the `data.reasonCode` values that mean the game changed under a command before it finished.
 * CommandDispatcher puts a refused command's writes back before it answers, so these ask the player to choose the
 * action again instead of logging a diagnostic.
 */
const COMMAND_REFUSAL_TEXT = Object.freeze({
  'health.aggregate-missing': 'That unit or its equipment changed. Choose the action again.',
  'progression.character-missing': 'That Character is no longer available.',
  'progression.state-changed': 'That Character changed. Choose the action again.'
});

/**
 * Show notifications by id: look the text up in notification-catalog.mjs and pass it to Foundry's
 * ui.notifications. Warnings and errors also play the error sound. A catalog entry with a `backend`, and a result
 * that carries a diagnostic or `diagnosticRecovery`, go to the diagnostics log instead of a toast.
 */
export class NotificationService {
  static #shownResults = new WeakSet();
  constructor({ playSound = playUiSound, diagnostics = null } = {}) {
    this.playSound = playSound;
    this.diagnostics = diagnostics;
  }

  /** Show the notice with this id, and return Foundry's handle for it, or undefined when no toast went up. */
  show(id, data = {}) {
    return this.showResult({ code: id, data });
  }

  showResult(result) {
    try { return this.#showResult(result); }
    catch (error) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: 'Render a notification' });
      return undefined;
    }
  }

  /** Take down a notice `show` returned, such as a permanent one whose work has finished. */
  dismiss(notice) {
    if (!notice) return;
    try { ui.notifications?.remove?.(notice); }
    catch (error) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: 'Dismiss a notification' });
    }
  }

  #showResult(result) {
    const definition = NOTIFICATIONS[result?.code];
    if (result && typeof result === 'object') {
      if (NotificationService.#shownResults.has(result)) return;
      NotificationService.#shownResults.add(result);
    }
    const diagnostic = result?.data?.diagnostic;
    if (isDiagnostic(diagnostic)) {
      this.diagnostics?.record?.(createDiagnostic({ ...diagnostic,
        error: diagnostic.error ?? diagnostic.message, recovery: diagnostic.recovery }));
      return;
    }
    if (!definition || definition.silent) return;
    const refusal = result.code === NOTIFICATION_IDS.COMMAND_FAILED
      ? COMMAND_REFUSAL_TEXT[result.data?.reasonCode] : null;
    if (refusal) {
      this.playSound(SOUND_IDS.UI_ERROR);
      ui.notifications?.warn?.(refusal);
      return;
    }
    const backend = result.code === NOTIFICATION_IDS.COMBAT_EXCHANGE_STALE ? definition.backend
      : NOTIFICATIONS[result.data?.reasonCode]?.backend ?? definition.backend;
    if (backend || result.data?.diagnosticRecovery) {
      this.diagnostics?.record?.(createDiagnostic({
        sourcePath: backend || definition.failureSource || 'engine/dispatcher.mjs',
        source: result.code,
        detail: JSON.stringify({ code: result.code, data: result.data ?? {} }),
        error: result.data?.error ?? definition.text?.(result.data ?? {}),
        recovery: result.data?.diagnosticRecovery ?? definition.recovery?.(result.data ?? {}) ?? null
      }));
      return;
    }
    if (typeof definition.text !== 'function') return;
    if (REFUSAL_LEVELS.includes(definition.level)) this.playSound(SOUND_IDS.UI_ERROR);
    const method = ui.notifications?.[definition.level] ?? ui.notifications?.info;
    // A permanent notice stays until the reader dismisses it. Foundry fades out every other one.
    return method?.call(ui.notifications, definition.text(result.data ?? {}),
      definition.permanent === true ? { permanent: true } : undefined);
  }
}

/* -------------------------------------------- */
/*  Document outcomes                           */
/* -------------------------------------------- */
const ITEM_OUTCOME_NOTIFICATIONS = Object.freeze({
  [REFINEMENT_OUTCOME_CODES.DATABASE_REFINEMENT_FORBIDDEN]: NOTIFICATION_IDS.ITEM_DATABASE_REFINEMENT_FORBIDDEN,
  [REFINEMENT_OUTCOME_CODES.REFINEMENT_RESET]: NOTIFICATION_IDS.ITEM_REFINEMENT_RESET,
  [REFINEMENT_OUTCOME_CODES.REFINEMENT_REVERTED]: NOTIFICATION_IDS.ITEM_REFINEMENT_REVERTED,
  [REFINEMENT_OUTCOME_CODES.REFINEMENT_BASE_MISSING]: NOTIFICATION_IDS.ITEM_REFINEMENT_BASE_MISSING
});

/* -------------------------------------------- */
/*  Notification hooks                          */
/* -------------------------------------------- */
/**
 * Handler for the emblemRpg.itemDocumentOutcome hook, which foundry/documents/items.mjs raises and init/hooks.mjs
 * routes here. It shows the notice for a refinement outcome on an Item.
 */
export function createNotificationHookHandlers(notifications) {
  return Object.freeze({
    onItemDocumentOutcome(outcome) {
      const notificationId = ITEM_OUTCOME_NOTIFICATIONS[outcome?.code];
      if (notificationId) notifications.show(notificationId, outcome.data);
    }
  });
}

/** The notifier the encounter lifecycle, the encounter scene lock and the objectives editor report through. */
export function createEncounterNotifier(options = {}) {
  const notifications = new NotificationService(options);
  return Object.freeze({
    warn: message => notifications.show(NOTIFICATION_IDS.ENCOUNTER_OBJECTIVE_WARNING, { message }),
    invalid: message => notifications.show(NOTIFICATION_IDS.OBJECTIVES_INPUT_INVALID, { message }),
    gridRequired: () => notifications.show(NOTIFICATION_IDS.ENCOUNTER_GRID_REQUIRED),
    alreadyRunning: () => notifications.show(NOTIFICATION_IDS.ENCOUNTER_ALREADY_RUNNING),
    /**
     * An automatic phase change was refused. A busy unit (ENCOUNTER_STALE) gets the notice that says to use Advance
     * Phase once it finishes. Any other refusal shows its own text.
     */
    phaseChangeStopped: result => (result?.code === NOTIFICATION_IDS.ENCOUNTER_STALE
      ? notifications.show(NOTIFICATION_IDS.ENCOUNTER_PHASE_CHANGE_STOPPED)
      : notifications.showResult(result))
  });
}

/** The notifier the item sheet's effect, condition and animation editors report through. */
export function createItemEditorNotifier(options = {}) {
  const notifications = new NotificationService(options);
  return Object.freeze({
    info: message => notifications.show(NOTIFICATION_IDS.ITEM_EDITOR_INFO, { message }),
    warn: message => notifications.show(NOTIFICATION_IDS.ITEM_EDITOR_WARNING, { message }),
    error: message => notifications.show(NOTIFICATION_IDS.ITEM_EDITOR_ERROR, { message }),
    failure: (message, error = null) => recordDiagnostic(options.diagnostics, {
      sourcePath: options.sourcePath || 'ui/apps/sheets/item/sheet.mjs', error, detail: message
    })
  });
}

/**
 * The notifier the platform hooks (scenes, items, Guard bonds, the world schema check) and the table chat commands
 * report through.
 *
 * A refused inventory change belongs to the user who made it. Given that user and a `notice(message, audience)`
 * function, a refusal for anyone but this client's own user is sent to that user alone. Any other refusal shows
 * here.
 * @param {object} [options] Notification service options, `localUserId`, and the optional `notice` function.
 * @returns {object}
 */
export function createPlatformNotifier(options = {}) {
  const notifications = new NotificationService(options);
  const { localUserId = () => '', notice = null, diagnostics = null } = options;
  return Object.freeze({
    gridlessBlocked: () => notifications.show(NOTIFICATION_IDS.SCENE_GRIDLESS_BLOCKED),
    tokenSizeInvalid: () => notifications.show(NOTIFICATION_IDS.TOKEN_SIZE_INVALID),
    guardBondBroken: data => notifications.show(NOTIFICATION_IDS.GUARD_BOND_BROKEN, data),
    referencesRepaired: data => notifications.show(NOTIFICATION_IDS.SCENE_REFERENCES_REPAIRED, data),
    schemaMismatch: data => notifications.show(NOTIFICATION_IDS.WORLD_SCHEMA_MISMATCH, data),
    gmOnly: label => notifications.show(NOTIFICATION_IDS.TABLE_COMMAND_GM_ONLY, { label }),
    usage: message => notifications.show(NOTIFICATION_IDS.TABLE_COMMAND_USAGE, { message }),
    info: message => notifications.show(NOTIFICATION_IDS.TABLE_COMMAND_INFO, { message }),
    failed: label => notifications.show(NOTIFICATION_IDS.TABLE_COMMAND_FAILED, { label }),
    inventoryRefused: async (reasonCode, data = {}, userId = '') => {
      const recipient = String(userId ?? '');
      if (!recipient || typeof notice !== 'function' || recipient === String(localUserId() ?? '')) {
        notifications.show(NOTIFICATION_IDS.INVENTORY_CHANGE_REFUSED, { ...data, reasonCode });
        return true;
      }
      try {
        return await notice(inventoryRefusalPresentationMessage(reasonCode, data), [recipient]);
      } catch (error) {
        recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'inventory-refusal-notice' });
        return false;
      }
    }
  });
}

/**
 * Show a refused inventory change on the client it was addressed to, from the notice the host sent.
 * @param {{show: Function}} notifications This client's notification service.
 * @param {object} message A validated inventory refusal notice.
 * @returns {boolean} Whether the notice was shown.
 */
export function presentInventoryRefusal(notifications, message) {
  if (message?.kind !== INVENTORY_REFUSAL_PRESENTATION_KIND) return false;
  notifications.show(NOTIFICATION_IDS.INVENTORY_CHANGE_REFUSED, { ...message.data, reasonCode: message.reasonCode });
  return true;
}

/**
 * Tell a unit's owner what the capacity reconciliation moved, from the notice the host addressed to them.
 * @param {{show: Function}} notifications This client's notification service.
 * @param {object} message A validated capacity notice.
 * @returns {boolean} Whether the notice was shown.
 */
export function presentInventoryCapacityNotice(notifications, message) {
  if (message?.kind !== INVENTORY_CAPACITY_NOTICE_KIND || !message.itemNames?.length) return false;
  notifications.show(NOTIFICATION_IDS.INVENTORY_CAPACITY_STORED, {
    actorName: message.actorName, convoyName: message.convoyName, itemNames: [...message.itemNames]
  });
  return true;
}

/** The notifier the Terrain Builder, its overlay and its presets report through. */
export function createTerrainNotifier(options = {}) {
  const notifications = new NotificationService(options);
  return Object.freeze({
    info: message => notifications.show(NOTIFICATION_IDS.TERRAIN_INFO, { message }),
    warn: message => notifications.show(NOTIFICATION_IDS.TERRAIN_WARNING, { message })
  });
}
