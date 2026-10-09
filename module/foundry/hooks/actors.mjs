/** @layer foundry/hooks */
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { DIAGNOSTIC_SOURCES, SYSTEM_ID, createDiagnostic } from '../../contracts/protocol.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { MOVEMENT_PLAN_PATHS } from '../../contracts/domains/characters.mjs';
import { ARMAMENT_FLAGS } from '../../contracts/domains/objects.mjs';
import { RESTORE_WRITE_OPTION } from '../../contracts/domains/recovery.mjs';
import { isActiveGm as isCurrentCoordinator, isActiveGm as localUserIsActiveGm } from '../adapters/services/host.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';
import { projectEquipmentEffectIdentity } from '../adapters/document-writes/characters.mjs';
import { characterEquipmentCapacity, equipmentStateField } from '../../game/character/inventory.mjs';
import { changeLeafPaths } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Class features                              */
/* -------------------------------------------- */

/**
 * Class feature hook handlers, on the host client. A Class added to a Character, or a level change the system's own
 * level-up didn't write, submits RECONCILE_FEATURES for its classes. `executeInternal` queues a system maintenance
 * command (MaintenanceScheduler.submit in engine/maintenance.mjs).
 */
export function createClassFeatureHookHandlers({ executeInternal }) {
  return Object.freeze({
    onClassItemCreated(item) {
      if (!isCurrentCoordinator() || item.type !== 'Class' || item.parent?.type !== 'Character') return;
      // Compendium actors are authoring stock, and their embedded UUIDs can't be resolved synchronously.
      if (item.pack || item.parent?.pack) return;
      void executeInternal(INTERNAL_COMMAND_IDS.CHARACTER.CLASSES.RECONCILE_FEATURES, { classUuid: item.uuid });
    },

    async onCharacterLevelChanged(actor, changes, options = {}) {
      if (!isCurrentCoordinator() || actor.type !== 'Character' || actor.pack) return;
      if (options.emblemProgressionSettlement === true) return;
      if (!foundry.utils.hasProperty(changes, 'system.progression.level')) return;
      for (const classItem of actor.items.filter(item => item.type === 'Class')) {
        await executeInternal(INTERNAL_COMMAND_IDS.CHARACTER.CLASSES.RECONCILE_FEATURES, { classUuid: classItem.uuid });
      }
    }
  });
}

/* -------------------------------------------- */
/*  Equipment effects                           */
/* -------------------------------------------- */
/** The equipment check results the GM is told about. The rest are silent repairs. */
const REPORTED_RECONCILIATIONS = new Set([
  RESULT_CODES.INVENTORY_REQUIREMENTS_UNEQUIPPED,
  RESULT_CODES.INVENTORY_CAPACITY_STORED,
  RESULT_CODES.INVENTORY_CAPACITY_UNSTORED
]);

/**
 * Equipment hook handlers, on the host client. After a change that could leave a Character's equipment effects
 * out of step (on ready, and when it's created or its items, effects, borrowed Armament or own fields change),
 * submit RECONCILE_EFFECTS for it, 25 ms later and once per burst. Caster requirements can read any unit field or
 * status, so changes to those count. Writes the equipment check made itself, and undo restores, are skipped.
 * A unit-field change or a non-equipment effect only runs the check when it could find something (see
 * mayNeedEquipmentCheck); any other change in the same burst runs it regardless.
 */
export function createEquipmentEffectLifecycle({ executeInternal, notify = null }) {
  const timers = new Map();

  function schedule(actor, { always = true } = {}) {
    if (!isCurrentCoordinator() || actor?.type !== 'Character' || actor.pack) return;
    const actorUuid = String(actor.uuid ?? '');
    if (!actorUuid) return;
    const pending = timers.get(actorUuid);
    if (pending) {
      if (always) pending.always = true;
      return;
    }
    const entry = { always, timer: null };
    entry.timer = setTimeout(() => {
      timers.delete(actorUuid);
      if (!entry.always && !mayNeedEquipmentCheck(currentActor(actorUuid) ?? actor)) return;
      void executeInternal(INTERNAL_COMMAND_IDS.CHARACTER.INVENTORY.RECONCILE_EFFECTS, { actorUuid }).then(result => {
        if (REPORTED_RECONCILIATIONS.has(result?.code)) notify?.showResult?.(result);
      }).catch(error => {
        reportFoundryError(import.meta.url, error, 'Emblem RPG | Equipment-effect reconciliation failed');
      });
    }, 25);
    timers.set(actorUuid, entry);
  }

  return Object.freeze({
    onReady() {
      if (!isCurrentCoordinator()) return;
      for (const actor of worldAndPlacedActors()) schedule(actor);
    },
    onActorCreated(actor, options = {}) {
      if (isEquipmentSettlement(options)) return;
      schedule(actor);
    },
    onEmbeddedItemChanged(item, _changes = null, options = {}) {
      if (isEquipmentSettlement(options)) return;
      schedule(item?.parent);
    },
    onActorArmamentChanged(actor, changes = null, options = {}) {
      if (isEquipmentSettlement(options) || !armamentFlagChanged(changes)) return;
      schedule(actor);
    },
    /** A unit's own fields changed: its name, a stat, a status, or anything else a caster requirement may read. */
    onActorFactsChanged(actor, changes = null, options = {}) {
      if (isEquipmentSettlement(options) || !actorFactsChanged(changes)) return;
      schedule(actor, { always: false });
    },
    /** `changes` is null for a created or deleted effect. */
    onActiveEffectChanged(effect, changes = null, options = {}) {
      if (isEquipmentSettlement(options)) return;
      schedule(effect?.parent, { always: equipmentEffectTouched(effect, changes) });
    }
  });
}

/**
 * Whether the equipment check could change anything on a unit whose items, equipment effects and borrowed Armament
 * are as they were at its last check: an item in use that has requirements, which any unit field, status or effect
 * may break, or more carried equipment than its slots, which item and effect modifiers may shrink. A borrowed
 * Armament always counts, since its rack token can be deleted without a write to this actor.
 */
function mayNeedEquipmentCheck(actor) {
  if (actor.getFlag?.(SYSTEM_ID, ARMAMENT_FLAGS.UUID)) return true;
  let carried = 0;
  for (const item of actor.items ?? []) {
    const system = item._source?.system ?? item.system ?? {};
    const field = equipmentStateField({ type: item.type, system });
    const requirements = system.requirements;
    if (field && system[field] === true && Array.isArray(requirements) && requirements.length) return true;
    if (item.type === 'Equipment' && !item.getFlag(SYSTEM_ID, 'innateGrant')) carried += 1;
  }
  return carried > characterEquipmentCapacity(Number(actor.system?.equipment?.slots));
}

/** The actor as it is now. An unlinked token's actor can be rebuilt between the change and the check. */
function currentActor(actorUuid) {
  try { return fromUuidSync(actorUuid); } catch { return null; }
}

/**
 * Whether an effect is, or may have stopped being, a wield, armor or mount effect. That depends on its name,
 * flags and statuses (projectEquipmentEffectIdentity), so an update to any of those counts.
 */
function equipmentEffectTouched(effect, changes) {
  if (projectEquipmentEffectIdentity(effect).kind) return true;
  if (!changes || typeof changes !== 'object') return false;
  return changeLeafPaths(changes).some(path => path === 'name' || path.startsWith('flags')
    || path.startsWith('statuses'));
}

/** World actors plus each unlinked token's own actor, for the ready sweeps. game.actors holds only world actors. */
function worldAndPlacedActors() {
  const actors = new Map();
  const add = actor => {
    const uuid = String(actor?.uuid ?? '');
    if (uuid && !actors.has(uuid)) actors.set(uuid, actor);
  };
  for (const actor of game.actors) add(actor);
  for (const scene of game.scenes) {
    for (const token of scene.tokens) if (!token.actorLink) add(token.actor);
  }
  return actors.values();
}

/** Writes the equipment check made itself, or that an undo restore wrote (RESTORE_WRITE_OPTION). */
function isEquipmentSettlement(options) {
  return options?.emblemEquipmentSettlement === true || options?.[RESTORE_WRITE_OPTION] === true;
}

/**
 * Whether an Actor update touched a fact a caster requirement can read: the name or anything under system, except
 * the movement-plan fields written when a unit is picked up or put down for a move, which no requirement reads.
 */
function actorFactsChanged(changes) {
  if (!changes || typeof changes !== 'object') return false;
  return changeLeafPaths(changes).some(path => path === 'name'
    || ((path === 'system' || path.startsWith('system.')) && !MOVEMENT_PLAN_PATHS.includes(path)));
}

/** Whether an Actor update took up or handed back a borrowed Armament. */
export function armamentFlagChanged(changes) {
  const flags = changes?.flags?.[SYSTEM_ID];
  return Boolean(flags) && (ARMAMENT_FLAGS.UUID in flags || `-=${ARMAMENT_FLAGS.UUID}` in flags);
}

/* -------------------------------------------- */
/*  Stance                                      */
/* -------------------------------------------- */
/**
 * Stance hook handlers, on the host client, for StanceBreakService (engine/combat/damage.mjs). A Foundry or sheet
 * edit of a Character's stance value re-checks its Stance Break. Writes the system's own commands made, and undo
 * restores, are skipped. On ready, every Character is checked once.
 */
export function createStanceHookHandlers({ stances }) {
  return Object.freeze({
    onReady() {
      if (!localUserIsActiveGm()) return;
      for (const actor of worldAndPlacedActors()) {
        if (actor?.type !== 'Character' || actor.pack) continue;
        void stances.settleMechanics(String(actor.uuid ?? '')).catch(error => {
          reportFoundryError(import.meta.url, error, 'Emblem RPG | Stance Break reconciliation failed');
        });
      }
    },
    onCharacterStanceUpdated(actor, changes, operation = {}) {
      if (systemOwnedSettlement(operation) || actor?.type !== 'Character'
        || !localUserIsActiveGm() || !stanceValueChanged(changes)) return undefined;
      return stances.settle(String(actor.uuid ?? ''));
    }
  });
}

function systemOwnedSettlement(operation) {
  return operation?.emblemHealthSettlement === true
    || operation?.emblemCombatSettlement === true
    || operation?.emblemEffectSettlement === true
    || operation?.[RESTORE_WRITE_OPTION] === true
    || operation?.emblemDevelopmentReset === true;
}
function stanceValueChanged(changes) {
  return changes?.['system.resources.stn.value'] !== undefined
    || changes?.system?.resources?.stn?.value !== undefined;
}

/* -------------------------------------------- */
/*  Support                                     */
/* -------------------------------------------- */

const SUPPORT_OWN_WRITE_OPTIONS = ['emblemSupportSettlement', 'emblemSupportMirror', RESTORE_WRITE_OPTION];

/**
 * Support hook handler, on the host client. A Foundry or sheet edit of a Character's support partners submits
 * RECONCILE_MIRROR so the partners' side matches. Support commands already keep both sides in step themselves.
 */
export function createSupportHookHandlers({ executeInternal }) {
  return Object.freeze({
    onCharacterSupportChanged(actor, changes, options = {}) {
      if (!isCurrentCoordinator() || actor?.type !== 'Character') return;
      if (SUPPORT_OWN_WRITE_OPTIONS.some(option => options[option] === true)) return;
      if (!supportPartnersTouched(changes)) return;
      void executeInternal(INTERNAL_COMMAND_IDS.CHARACTER.SUPPORT.RECONCILE_MIRROR, { actorUuid: actor.uuid });
    }
  });
}

/** Whether an update's diff touched the support partner list, at any depth. */
function supportPartnersTouched(changes) {
  if (!changes || typeof changes !== 'object') return false;
  let flattened;
  try { flattened = foundry.utils.flattenObject(changes); } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'supportPartnersTouched');
    return false;
  }
  return Object.keys(flattened).some(key => key === 'system.support.partners'
    || key.startsWith('system.support.partners.'));
}

/* -------------------------------------------- */
/*  Voice path approval                         */
/* -------------------------------------------- */

/**
 * Approve voice folders when a GM creates or imports an actor, and clear the approval when it's deleted. The check is
 * on the user who created it, not the local user, so a connected GM can't approve a Player-authored path by accident.
 */
export function createVoiceApprovalHookHandlers({ unitAudioAuthoring, diagnostics = null }) {
  const report = error => diagnostics?.record?.(createDiagnostic({ sourcePath: import.meta.url,
    source: DIAGNOSTIC_SOURCES.CHARACTER, detail: 'voice-path-approval', error
  }));
  const guard = promise => Promise.resolve(promise).catch(report);
  return Object.freeze({
    onActorCreated(actor, _options = {}, userId = '') {
      if (!localUserIsActiveGm() || globalThis.game?.users?.get(String(userId))?.isGM !== true) return false;
      if (!actor?.system?.art?.voicePath) return false;
      void guard(unitAudioAuthoring.approveVoicePathsFor([actor]));
      return true;
    },

    onActorDeleted(actor) {
      if (!localUserIsActiveGm() || unitAudioAuthoring.isVoicePathApproved(actor) !== true) return false;
      void guard(unitAudioAuthoring.approveVoicePath(actor, null));
      return true;
    }
  });
}

/* -------------------------------------------- */
/*  Player characters                           */
/* -------------------------------------------- */

/**
 * On the host client, give each player their Lord: restore their ownership of it and set it as their Foundry
 * Player Character. Runs for every player on ready, followed by party access and Convoy ownership, and for one
 * player when they connect.
 */
export function createPlayerCharacterHookHandlers({
  parties, lordUuidFor, resolve = uuid => fromUuidSync(uuid), diagnostics = null
}) {
  const report = error => diagnostics?.record?.(createDiagnostic({ sourcePath: import.meta.url,
    source: DIAGNOSTIC_SOURCES.CHARACTER, detail: 'player-character-sync', error
  }));
  const sync = async user => {
    if (!user || user.isGM) return false;
    const lordUuid = lordUuidFor(String(user.id ?? ''));
    const lord = lordUuid ? resolve(lordUuid) : null;
    if (!lord) return false;
    const restored = await parties.restoreLordOwnership(String(user.id), lord);
    const mirrored = await parties.syncPlayerCharacter(String(user.id), lord);
    return restored || mirrored;
  };
  return Object.freeze({
    async onReadyPlayerCharacters() {
      if (!localUserIsActiveGm()) return 0;
      let synced = 0;
      for (const user of game.users) {
        try {
          if (await sync(user)) synced += 1;
        } catch (error) {
          reportFoundryError(import.meta.url, error, 'createPlayerCharacterHookHandlers');
          report(error);
        }
      }
      try {
        await parties.syncPartyAccess();
      } catch (error) {
        reportFoundryError(import.meta.url, error, 'createPlayerCharacterHookHandlers');
        report(error);
      }
      try {
        await parties.syncConvoyOwnership();
      } catch (error) {
        reportFoundryError(import.meta.url, error, 'createPlayerCharacterHookHandlers');
        report(error);
      }
      return synced;
    },

    async onUserConnectedPlayerCharacter(user, connected) {
      if (connected !== true || !localUserIsActiveGm()) return false;
      try {
        const synced = await sync(user);
        if (synced) await parties.syncPartyAccess();
        return synced;
      } catch (error) {
        reportFoundryError(import.meta.url, error, 'createPlayerCharacterHookHandlers');
        report(error);
        return false;
      }
    }
  });
}
