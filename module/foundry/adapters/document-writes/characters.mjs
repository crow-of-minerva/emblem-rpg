/** @layer foundry/adapters/document-writes */
import { SYSTEM_ID , recordDiagnostic } from '../../../contracts/protocol.mjs';
import { ARMAMENT_FLAGS } from '../../../contracts/domains/objects.mjs';
import { BG3_HUD_CORE_ID, BG3_HUD_LAYOUT_REVISION_FLAG } from '../../../contracts/domains/bg3-hud.mjs';
import { SUPPORT_UNRANKED } from '../../../contracts/domains/progression.mjs';
import { projectAuraBoard, projectTerrainBoard } from '../projections/board.mjs';
import { projectCharacterSource } from '../projections/characters.mjs';
import { projectFoundryCombatActorContext } from '../projections/combat-context.mjs';
import { encounterUnderway } from '../projections/encounters.mjs';
import { projectActorPartyId, projectOwnershipLevel, readPartyState } from '../projections/parties.mjs';
import {
  clone, forcedReplacement, isStanceBreakEffect, readEffectFlags as effectFlags, resolveScene
} from '../services/host.mjs';
import {
  INNATE_GRANT_FLAG, INNATE_GRANTS, INNATE_SOURCE_NAMES, innateGrantsHeld
} from '../../../game/character/innate-grants.mjs';
import { isInboundItem } from '../../../game/economy/inbound.mjs';
import {
  UNIT_FREE_TARGETING_FLAG, resolveAvatarScale, unitIgnoresLineOfSight
} from '../../../game/character/rules.mjs';
import { EQUIPMENT_EFFECT_IDS, EQUIPMENT_EFFECT_KINDS } from '../../../contracts/domains/items.mjs';
import { RESULT_CODES } from '../../../contracts/results.mjs';
import { reportFoundryError , FoundryDiagnostics } from '../services/diagnostics.mjs';
import { affinityTableReady } from '../services/json-files.mjs';

/** The flags cleared when a unit wields its own weapon and stops using a borrowed Armament. */
const ARMAMENT_FLAG_PATHS = Object.freeze([
  `flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.UUID}`,
  `flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.PREVIOUS_WIELDED_ID}`
]);

/** The one path the free-targeting command writes, and the one its operation captures. */
const FREE_TARGETING_PATH = `flags.${SYSTEM_ID}.${UNIT_FREE_TARGETING_FLAG}`;

/** The one path the counterattack mode command writes, and the one its operation captures. */
const PACIFIST_PATH = 'system.pacifist';

/* -------------------------------------------- */
/*  Actor persistence                           */
/* -------------------------------------------- */
/**
 * Reads and writes a unit's turn, inventory, equipment effects, hotbar layout, aura and terrain fields, support
 * bonds and innate grants, for the character, inventory, board and support commands in engine/. Each settle method
 * compares a fresh snapshot's fingerprint first and returns `stale: true` if what it read has changed.
 */
export class FoundryActorRepository {
  constructor({ diagnostics = null } = {}) {
    this.diagnostics = diagnostics;
  }

  /**
   * A unit's stats, skills, turn, free-targeting state and counterattack mode, with a fingerprint update uses to spot
   * changes. `turn` and `encounterActive` are the facts planPacifistChange (game/character/counter-mode.mjs) weighs.
   */
  async getSnapshot(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return null;
    const snapshot = {
      uuid: actor.uuid,
      name: actor.name,
      img: String(actor.img ?? ''),
      type: actor.type,
      actorType: String(actor.system?.faction?.role ?? 'Neutral'),
      avatarScale: resolveAvatarScale(actor.system?.art?.avatarScale),
      standardAvailable: Boolean(actor.system?.turn?.actionAvailable),
      attributes: Object.freeze(Object.fromEntries(
        Object.entries(actor.system?.stats ?? {}).map(([key, value]) => [key, Number(value?.total) || 0])
      )),
      skills: Object.freeze(Object.fromEntries(
        Object.entries(actor.system?.skills ?? {}).map(([key, value]) => [key, Number(value?.total) || 0])
      )),
      blessed: actor.system?.statuses?.blessed === true,
      freeTargeting: unitIgnoresLineOfSight(actor.flags?.[SYSTEM_ID]),
      pacifist: actor.system?.pacifist === true,
      turn: Object.freeze({
        actionAvailable: actor.system?.turn?.actionAvailable === true,
        movementAvailable: actor.system?.turn?.movementAvailable === true
      }),
      encounterActive: encounterUnderway()
    };
    return Object.freeze({ ...snapshot, fingerprint: JSON.stringify(snapshot) });
  }

  /** Apply changes if the Actor still matches the getSnapshot result. Throws if the Actor is gone. */
  async update(snapshot, changes) {
    const actor = await fromUuid(snapshot.uuid);
    if (!actor || actor.documentName !== 'Actor') throw new Error('Actor no longer exists.');
    const current = await this.getSnapshot(snapshot.uuid);
    if (current?.fingerprint !== snapshot.fingerprint) return Object.freeze({ ok: false, stale: true });
    await actor.update(changes);
    return Object.freeze({ ok: true, stale: false });
  }

  /**
   * Write the staff free-targeting override onto one unit. The flag is the only thing the command touches, so the
   * capture names its path alone. The command (engine/character/commands.mjs) reads the current state from getSnapshot.
   * @param {string} actorUuid The unit the Token HUD control named.
   * @param {boolean} enabled Whether the unit's actions should ignore line of sight.
   * @param {object|null} [operation] The running operation, which captures the flag before it changes.
   * @returns {Promise<boolean>} Whether the write landed.
   */
  async setFreeTargeting(actorUuid, enabled, operation = null) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return false;
    try {
      await operation?.capture({ documents: [{ document: actor, paths: [FREE_TARGETING_PATH] }] });
      await actor.update({ [FREE_TARGETING_PATH]: enabled === true });
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'setFreeTargeting');
      return false;
    }
  }

  /**
   * Write one unit's counterattack mode. The field is the only thing the command touches, so the capture names its
   * path alone. The command (engine/character/commands.mjs) reads the current mode from getSnapshot.
   * @param {string} actorUuid The unit the BG3 HUD toggle named.
   * @param {boolean} pacifist Whether the unit should never counterattack.
   * @param {object|null} [operation] The running operation, which captures the field before it changes.
   * @returns {Promise<boolean>} Whether the write landed.
   */
  async setPacifist(actorUuid, pacifist, operation = null) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return false;
    try {
      await operation?.capture({ documents: [{ document: actor, paths: [PACIFIST_PATH] }] });
      await actor.update({ [PACIFIST_PATH]: pacifist === true });
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'setPacifist');
      return false;
    }
  }

  /* -------------------------------------------- */
  /*  Shared hotbar layout                        */
  /* -------------------------------------------- */
  /** A unit's shared hotbar layout as a save reads it: its revision and every Item it carries. */
  async getHotbarLayoutSnapshot(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return null;
    return {
      actorUuid: String(actor.uuid),
      type: String(actor.type ?? ''),
      revision: (Number(actor.getFlag(SYSTEM_ID, BG3_HUD_LAYOUT_REVISION_FLAG)) || 0),
      itemUuids: [...actor.items].map(item => String(item.uuid))
    };
  }

  /**
   * Write BG3 HUD layout flags and the next revision together. Refuse if another save changed the snapshot
   * revision.
   */
  async saveHotbarLayout(snapshot, state) {
    const actor = await fromUuid(snapshot.actorUuid);
    if (!actor || actor.documentName !== 'Actor') return { ok: false, stale: false };
    const revision = (Number(actor.getFlag(SYSTEM_ID, BG3_HUD_LAYOUT_REVISION_FLAG)) || 0);
    if (revision !== snapshot.revision) return { ok: false, stale: true, revision };
    await actor.update({
      flags: { [BG3_HUD_CORE_ID]: { hudState: state }, [SYSTEM_ID]: { [BG3_HUD_LAYOUT_REVISION_FLAG]: revision + 1 } }
    });
    return { ok: true, revision: revision + 1 };
  }

  /**
   * The players who own a unit, for a notice addressed to them rather than the table. Gamemasters are left out:
   * a GM owns everything, and hears the reconciliation's own result on the host instead.
   * @param {string} actorUuid The unit.
   * @returns {Promise<string[]>} Owning user ids.
   */
  async getOwnerUserIds(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return [];
    const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    return game.users.contents
      .filter(user => !user.isGM && projectOwnershipLevel(actor.ownership, user.id) >= owner)
      .map(user => String(user.id));
  }

  /**
   * The Convoy a unit's surplus equipment goes to: the one linked to the party of whichever player owns the unit,
   * the same link the Character sheet offers. Returns an inventory snapshot so the capacity reconciliation in
   * engine/character/commands.mjs can hand it straight to receiveInventoryItem, or null when nothing is linked.
   * The Convoy's inbound Items are left off the list, while the fingerprint still covers them, so the writer's
   * freshness check compares the whole Convoy.
   * @param {string} actorUuid The overflowing unit.
   * @returns {Promise<object|null>}
   */
  async getLinkedConvoySnapshot(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return null;
    const partyId = projectActorPartyId(actor);
    if (!partyId) return null;
    const convoyUuid = readPartyState().parties.find(entry => entry.id === partyId)?.convoyUuid;
    if (!convoyUuid) return null;
    const convoy = await this.getInventorySnapshot(String(convoyUuid));
    if (convoy?.type !== 'Convoy') return null;
    return Object.freeze({ ...convoy, items: Object.freeze(convoy.items.filter(item => item.inbound !== true)) });
  }

  /**
   * A Character's detached compile source, which game/character/equipment-effects.mjs compiles before and after a
   * gear change to measure the Stn that gear grants. It's read only when equipment changes, because projecting it
   * reads the board. null for anything but a Character.
   * @param {string} actorUuid
   * @returns {Promise<object|null>}
   */
  async getStanceSource(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') return null;
    return projectCharacterSource(actor);
  }

  /**
   * What the inventory and equipment rules read about an Actor: its items (as source data), its effects with their
   * equipment kind, turn, proficiencies, carrying capacity and borrowed Armament, plus a fingerprint the settle
   * methods check.
   */
  async getInventorySnapshot(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return null;
    const prof = Object.fromEntries(Object.entries(actor.system?.prof ?? {}).map(([key, value]) => [key, {
      total: Number(value?.total) || 0
    }]));
    const snapshot = {
      uuid: actor.uuid,
      name: actor.name,
      type: actor.type,
      inCombat: encounterUnderway(),
      /** The derived carrying capacity game/character/inventory.mjs admits and reconciles against. */
      equipmentSlots: Number(actor.system?.equipment?.slots),
      system: Object.freeze({
        /** The turn facts game/character/inventory.mjs weighs: an Action to wield, a running turn to equip. */
        turn: Object.freeze({
          actionAvailable: actor.system?.turn?.actionAvailable === true,
          movementAvailable: actor.system?.turn?.movementAvailable === true
        }),
        prof: Object.freeze(prof),
        resources: Object.freeze({
          hp: Object.freeze({ value: Number(actor._source?.system?.resources?.hp?.value) || 0 }),
          stn: Object.freeze({ value: Number(actor._source?.system?.resources?.stn?.value) || 0 })
        }),
        /** Stance Break as the compiler detects it. While it holds, equipment-effects.mjs grants no Stn from gear. */
        statuses: Object.freeze({ stanceBroken: Array.from(actor.effects).some(isStanceBreakEffect) })
      }),
      armament: projectBorrowedArmament(actor),
      /** Project caster requirements for equipment validation and the equipment drift sweep. */
      conditionSelf: projectFoundryCombatActorContext(actor),
      items: Object.freeze(actor.items.map(item => Object.freeze({
        id: item.id,
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        type: item.type,
        innateGrant: Boolean(item.getFlag(SYSTEM_ID, 'innateGrant')),
        /** A Convoy's undelivered Item, which no transfer moves and nothing stacks onto. */
        inbound: isInboundItem(item),
        /** The system's flags, whose vendor tags stack matching compares (matchingResourceStack in inventory.mjs). */
        flags: Object.freeze({
          [SYSTEM_ID]: foundry.utils.deepClone(item._source?.flags?.[SYSTEM_ID] ?? item.flags?.[SYSTEM_ID] ?? {})
        }),
        system: foundry.utils.deepClone(item._source?.system ?? item.system ?? {})
      }))),
      effects: Object.freeze(Array.from(actor.effects).map(effect => {
        const equipment = projectEquipmentEffectIdentity(effect);
        return Object.freeze({
          id: effect.id,
          name: effect.name,
          img: effect.img,
          origin: effect.origin,
          disabled: effect.disabled === true,
          changes: foundry.utils.deepClone(effect._source?.changes ?? effect.changes ?? []),
          statuses: Object.freeze(Array.from(effect.statuses)),
          flags: foundry.utils.deepClone(effect.flags ?? {}),
          equipmentKind: equipment.kind,
          equipmentItemId: equipment.itemId
        });
      }))
    };
    return Object.freeze({ ...snapshot, fingerprint: inventoryFingerprint(snapshot) });
  }

  /**
   * Commit item state, special effects, and mount resource top-up together. The `operation` the caller's command
   * holds captures every Item, effect and Actor field first, so the dispatcher can put them all back.
   */
  async settleEquipmentToggle(snapshot,
    { itemUpdates = [], effects = {}, resourceValues = {}, operation = null } = {}) {
    return this.#commitEquipmentState(snapshot, {
      itemUpdates,
      effects,
      actorUpdates: buildEquipmentResourceUpdates(resourceValues),
      operation
    });
  }

  /** Repair only the special effects derived from an already-persisted equipment state. */
  async reconcileEquipmentEffects(snapshot, effects = {}, operation = null) {
    return this.#commitEquipmentState(snapshot, { itemUpdates: [], effects, actorUpdates: {}, operation });
  }

  async #commitEquipmentState(snapshot, { itemUpdates, effects, actorUpdates, operation = null }) {
    const actor = await fromUuid(snapshot.uuid);
    if (!actor || actor.documentName !== 'Actor') return Object.freeze({ ok: false, code: 'inventory.actor-missing' });
    const current = await this.getInventorySnapshot(snapshot.uuid);
    if (current?.fingerprint !== snapshot.fingerprint) {
      return Object.freeze({ ok: false, stale: true, code: 'inventory.state-changed' });
    }
    const deleteIds = (effects.deleteIds ?? []).filter(id => actor.effects.get(id));
    const createData = reserveDocumentIds(buildEquipmentEffectDocuments(effects.createIntents));
    const dropsArmament = itemUpdates.some(update => update?.['system.isWielded'] === true)
      && Boolean(actor.getFlag(SYSTEM_ID, ARMAMENT_FLAGS.UUID));
    const actorPaths = [...Object.keys(actorUpdates), ...(dropsArmament ? ARMAMENT_FLAG_PATHS : [])];
    await operation?.capture({
      documents: [
        ...itemUpdates.map(update => actor.items.get(String(update?._id ?? ''))).filter(Boolean),
        ...(actorPaths.length ? [{ document: actor, paths: actorPaths }] : [])
      ],
      deleting: deleteIds.map(id => actor.effects.get(id)),
      creating: createData.length
        ? [{ parent: actor, documentName: 'ActiveEffect', ids: createData.map(entry => entry._id) }]
        : []
    });
    try {
      if (itemUpdates.length) {
        await actor.updateEmbeddedDocuments('Item', itemUpdates, { emblemEquipmentSettlement: true });
        if (dropsArmament) await dropBorrowedArmament(actor);
      }
      if (deleteIds.length) {
        await actor.deleteEmbeddedDocuments('ActiveEffect', deleteIds, { emblemEquipmentSettlement: true });
      }
      if (createData.length) {
        await actor.createEmbeddedDocuments('ActiveEffect', createData,
          { keepId: true, emblemEquipmentSettlement: true });
      }
      if (Object.keys(actorUpdates).length) {
        await actor.update(actorUpdates, { emblemEquipmentSettlement: true });
      }
      return Object.freeze({ ok: true, stale: false });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/characters.mjs', error: diagnosticError,
        detail: 'commitEquipmentState'
      });
      return Object.freeze({ ok: false, code: 'inventory.equipment-settlement-failed', diagnostic });
    }
  }

  /* -------------------------------------------- */
  /*  Aura persistence                            */
  /* -------------------------------------------- */
  /** Project one Scene's placed units plus any detached Character still carrying aura values. */
  async getAuraBoardSnapshot(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    const board = scene ? projectAuraBoard(scene) : null;
    if (!board) return null;
    return Object.freeze({ ...board, fingerprint: auraBoardFingerprint(board) });
  }

  /** Project the terrain board one Scene's standing modifiers are recomputed from. */
  async getTerrainBoardSnapshot(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    return scene ? projectTerrainBoard(scene) : null;
  }

  /**
   * Write planned aura and terrain fields together per Actor so preparation runs once.
   * Reproject both boards from the snapshot’s Scene and refuse if either changed.
   */
  async settleModifierFields(snapshot, plans = [], operation = null) {
    const [auras, terrain] = await Promise.all([
      this.getAuraBoardSnapshot(snapshot.sceneUuid), this.getTerrainBoardSnapshot(snapshot.sceneUuid)
    ]);
    if (auras?.fingerprint !== snapshot.auraFingerprint) return { ok: false, stale: true };
    if (terrain?.fingerprint !== snapshot.terrainFingerprint) return { ok: false, stale: true };
    const settlements = [];
    for (const plan of plans) {
      const actor = await fromUuid(plan.actorUuid);
      if (actor?.documentName === 'Actor') settlements.push({ actor, changes: buildModifierUpdates(plan) });
    }
    await operation?.capture({
      documents: settlements.map(({ actor, changes }) => ({ document: actor, paths: Object.keys(changes) }))
    });
    try {
      for (const { actor, changes } of settlements) await actor.update(changes, { emblemModifierSettlement: true });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/characters.mjs', error: diagnosticError,
        detail: 'settleModifierFields'
      });
      return {
        ok: false, stale: false, code: RESULT_CODES.BOARD_MODIFIER_SETTLEMENT_FAILED, diagnostic
      };
    }
    return { ok: true, stale: false, settled: settlements.length };
  }

  /* -------------------------------------------- */
  /*  Support persistence                         */
  /* -------------------------------------------- */
  /** Project one unit's affinity and bonds from persisted source, never from prepared data. */
  async getSupportSnapshot(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || actor.documentName !== 'Actor') return null;
    const snapshot = projectSupportUnit(actor);
    return Object.freeze({ ...snapshot, fingerprint: JSON.stringify(snapshot) });
  }

  /** Project every world Character whose reciprocal half a mirror sweep could have to correct. */
  async getSupportRoster() {
    const units = game.actors
      .filter(actor => actor.type === 'Character')
      .map(actor => projectSupportUnit(actor));
    return Object.freeze({ units: Object.freeze(units), fingerprint: supportRosterFingerprint(units) });
  }

  /** Replace one unit's bonds, refusing when the list moved under the snapshot. */
  async settleSupportPartners(snapshot, partners, context = {}) {
    const actor = await fromUuid(snapshot?.uuid);
    if (!actor || actor.documentName !== 'Actor') {
      return { ok: false, code: 'character.support.actor-missing' };
    }
    const current = await this.getSupportSnapshot(snapshot.uuid);
    if (current?.fingerprint !== snapshot.fingerprint) {
      return { ok: false, stale: true, code: RESULT_CODES.SUPPORT_STATE_CHANGED };
    }
    await context.operation?.capture({ documents: [supportBonds(actor)] });
    try {
      await actor.update({ 'system.support.partners': clone(partners) }, { emblemSupportSettlement: true });
      if (JSON.stringify(actor._source.system.support.partners) !== JSON.stringify(partners)) {
        throw new Error('support.write-vetoed');
      }
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/characters.mjs', error: diagnosticError,
        detail: 'settleSupportPartners'
      });
      return { ok: false, code: RESULT_CODES.SUPPORT_SETTLEMENT_FAILED, diagnostic };
    }
    return { ok: true, stale: false };
  }

  /** Write every mirrored bond the sweep corrected. A failed write refuses, and the dispatcher restores the rest. */
  async settleSupportMirror(snapshot, plans = [], context = {}) {
    const current = await this.getSupportRoster();
    if (current?.fingerprint !== snapshot?.fingerprint) return { ok: false, stale: true };
    const entries = [];
    for (const plan of plans) {
      const actor = await fromUuid(plan.actorUuid);
      if (actor?.documentName === 'Actor') entries.push({ actor, partners: plan.partners });
    }
    await context.operation?.capture({ documents: entries.map(entry => supportBonds(entry.actor)) });
    try {
      for (const { actor, partners } of entries) {
        await actor.update({ 'system.support.partners': clone(partners) }, { emblemSupportMirror: true });
        if (JSON.stringify(actor._source.system.support.partners) !== JSON.stringify(partners)) {
          throw new Error('support.write-vetoed');
        }
      }
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'settleSupportMirror');
      return { ok: false, stale: false, code: RESULT_CODES.SUPPORT_SETTLEMENT_FAILED };
    }
    return { ok: true, stale: false, settled: entries.length };
  }

  /**
   * Move or copy an item from one Actor to another and rebuild the giver's equipment effects, capturing both sides
   * before any write. An inbound source item is refused before anything is written, and a Resource never stacks
   * onto an inbound one.
   */
  async receiveInventoryItem({
    source, target, itemId, amount = null, stackId = null, move = true, sourceEffects = {}, sourceResourceValues = {},
    operation = null
  }) {
    const [sourceActor, targetActor] = await Promise.all([fromUuid(source.uuid), fromUuid(target.uuid)]);
    if (sourceActor?.documentName !== 'Actor' || targetActor?.documentName !== 'Actor') {
      throw new Error('Inventory Actor no longer exists.');
    }
    const [currentSource, currentTarget] = await Promise.all([
      this.getInventorySnapshot(source.uuid),
      this.getInventorySnapshot(target.uuid)
    ]);
    if (currentSource?.fingerprint !== source.fingerprint || currentTarget?.fingerprint !== target.fingerprint) {
      return Object.freeze({ ok: false, stale: true });
    }
    const item = sourceActor.items.get(itemId);
    if (!item) throw new Error('Inventory Item no longer exists.');
    if (isInboundItem(item)) {
      return Object.freeze({ ok: false, stale: false, code: RESULT_CODES.CONVOY_INBOUND_LOCKED });
    }

    const candidate = item.type === 'Resource' && stackId ? targetActor.items.get(stackId) : null;
    const stack = candidate && !isInboundItem(candidate) ? candidate : null;
    const splits = move && item.type === 'Resource' && amount < (Number(item.system?.amount) || 0);
    const createdId = foundry.utils.randomID();
    const effectDeletes = (sourceEffects.deleteIds ?? []).filter(id => sourceActor.effects.get(id));
    const effectCreates = reserveDocumentIds(buildEquipmentEffectDocuments(sourceEffects.createIntents));
    // The Stn the giver keeps once the piece it had in use is gone (planEquipmentDepartureResources).
    const sourceResources = move ? buildEquipmentResourceUpdates(sourceResourceValues) : {};
    const sourcePaths = Object.keys(sourceResources);
    await operation?.capture({
      documents: [
        ...(stack ? [stack] : []), ...(move && splits ? [item] : []),
        ...(sourcePaths.length ? [{ document: sourceActor, paths: sourcePaths }] : [])
      ],
      deleting: [...(move && !splits ? [item] : []), ...effectDeletes.map(id => sourceActor.effects.get(id))],
      creating: [
        ...(stack ? [] : [{ parent: targetActor, documentName: 'Item', ids: [createdId] }]),
        ...(effectCreates.length
          ? [{ parent: sourceActor, documentName: 'ActiveEffect', ids: effectCreates.map(entry => entry._id) }]
          : [])
      ]
    });
    let created = [];
    try {
      if (stack) {
        await stack.update({ 'system.amount': (Number(stack.system?.amount) || 0) + amount },
          { emblemEquipmentSettlement: true });
      } else {
        const data = item.toObject();
        data._id = createdId;
        data.system ??= {};
        data.system.isWielded = false;
        data.system.isWorn = false;
        data.system.isEquipped = false;
        if (item.type === 'Resource') data.system.amount = amount;
        // A moved item keeps its uses; a copy arrives as a new item.
        created = await targetActor.createEmbeddedDocuments('Item', [data],
          { emblemEquipmentSettlement: true, emblemTransfer: move === true, keepId: true });
      }
      if (!move) return Object.freeze({ ok: true, stale: false, created });
      if (splits) {
        await item.update({ 'system.amount': (Number(item.system.amount) || 0) - amount },
          { emblemEquipmentSettlement: true });
      } else {
        await sourceActor.deleteEmbeddedDocuments('Item', [item.id], { emblemEquipmentSettlement: true });
      }
      await applyEquipmentEffectPlan(sourceActor, effectDeletes, effectCreates);
      if (sourcePaths.length) await sourceActor.update(sourceResources, { emblemEquipmentSettlement: true });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/characters.mjs', error: diagnosticError,
        detail: 'receiveInventoryItem'
      });
      return Object.freeze({ ok: false, stale: false, code: 'inventory.transfer-settlement-failed', diagnostic });
    }
    return Object.freeze({ ok: true, stale: false, created });
  }

  /* -------------------------------------------- */
  /*  Innate grants                               */
  /* -------------------------------------------- */

  /**
   * Project the unit an innate-grant sync decides on, together with the source item every grant would copy: a named
   * grant's item from the world or a compendium, or a built grant's data made for this unit (builtInnateSource).
   *
   * A compendium actor is left alone: granting into a pack would rewrite shipped content.
   */
  async getInnateGrantSnapshot(actorUuid) {
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor' || actor.pack) return null;
    const sources = {};
    for (const grant of INNATE_GRANTS) {
      if (grant.build) {
        sources[grant.key] = await builtInnateSource(grant, actor);
        continue;
      }
      const source = await resolveInnateSource(grant.itemName);
      sources[grant.key] = source ? clone(source.toObject()) : null;
    }
    const snapshot = { ...projectInnateUnit(actor), sources: Object.freeze(sources) };
    return Object.freeze({ ...snapshot, fingerprint: innateGrantFingerprint(snapshot) });
  }

  /**
   * Apply the innate-grant plan as one captured batch, in the order update, delete, create. Adoptions are recorded
   * before duplicates are removed, and creates come last so a replaced grant leaves exactly one copy.
   */
  async settleInnateGrants(snapshot, plan, operation = null) {
    const actor = await fromUuid(snapshot?.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor') return Object.freeze({ ok: false, code: 'innate.actor-missing' });
    const current = await this.getInnateGrantSnapshot(snapshot.uuid);
    if (current?.fingerprint !== snapshot.fingerprint) {
      return Object.freeze({ ok: false, stale: true, code: 'innate.state-changed' });
    }
    const updates = plan.updates.map(buildInnateUpdate);
    const creates = reserveDocumentIds(plan.creates.map(clone));
    await operation?.capture({
      documents: updates.map(update => actor.items.get(String(update._id ?? ''))).filter(Boolean),
      deleting: plan.deleteIds.map(id => actor.items.get(String(id))).filter(Boolean),
      creating: creates.length ? [{ parent: actor, documentName: 'Item', ids: creates.map(entry => entry._id) }] : []
    });
    let created = [];
    try {
      if (updates.length) await actor.updateEmbeddedDocuments('Item', updates, {});
      if (plan.deleteIds.length) await actor.deleteEmbeddedDocuments('Item', [...plan.deleteIds], {});
      if (creates.length) created = await actor.createEmbeddedDocuments('Item', creates, { keepId: true });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/characters.mjs', error: diagnosticError,
        detail: 'settleInnateGrants'
      });
      return Object.freeze({ ok: false, code: 'innate.settlement-failed', diagnostic });
    }
    return Object.freeze({ ok: true, stale: false, createdIds: Object.freeze(created.map(item => item.id)) });
  }
}

/* -------------------------------------------- */
/*  Innate grant sources                        */
/* -------------------------------------------- */

/** Cache resolveInnateSource hits and misses by lowercase name to avoid scanning all Item packs on every sync. */
const INNATE_SOURCE_CACHE = new Map();

/** Drop a cached grant source after its item changed, so the next sync re-reads it. */
export function invalidateInnateSource(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key || !INNATE_SOURCE_NAMES.has(key)) return false;
  INNATE_SOURCE_CACHE.delete(key);
  return true;
}

/** Forget every cached grant source. Called at ready (foundry/hooks/innate-grants.mjs), before the startup sweep. */
export function clearInnateSourceCache() {
  INNATE_SOURCE_CACHE.clear();
}

/**
 * Whether a unit already holds every innate grant it qualifies for, under the name each built grant would give it
 * now (innateGrantsHeld). foundry/hooks/innate-grants.mjs then submits no reconcile, so no grant source is built.
 */
export async function unitHoldsInnateGrants(actor) {
  const input = await innateBuildInput(actor);
  const names = Object.fromEntries(INNATE_GRANTS.filter(grant => grant.name)
    .map(grant => [grant.key, grant.name(input)]));
  return innateGrantsHeld(projectInnateUnit(actor), names);
}

/** What a built grant is made from: the affinity table in force and the unit's affinity. */
async function innateBuildInput(actor) {
  return { table: await affinityTableReady(), affinity: String(actor.system?.support?.affinity ?? '') };
}

/**
 * A built grant's source for one unit: the grant's `build` (the Rally Ability, game/support/rally-ability.mjs) from
 * the unit's affinity and the affinity table once it has loaded, passed through the Item data model so it carries
 * every stored field, as a compendium source does. A refresh then compares like with like and writes only real
 * changes. The document stamps are dropped, so two builds for an unchanged unit fingerprint the same. Returns null,
 * and grants nothing, when the data does not validate.
 */
async function builtInnateSource(grant, actor) {
  try {
    const data = grant.build(await innateBuildInput(actor));
    const source = new Item.implementation(data).toObject();
    delete source._stats;
    return clone(source);
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, `builtInnateSource:${grant.key}`);
    return null;
  }
}

/** Resolve an innate grant from world Items first, then Item compendia. Skip packs whose indexes cannot be read. */
async function resolveInnateSource(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  if (INNATE_SOURCE_CACHE.has(key)) return INNATE_SOURCE_CACHE.get(key);
  const world = game.items?.find?.(item => String(item.name ?? '').trim().toLowerCase() === key) ?? null;
  if (world) { INNATE_SOURCE_CACHE.set(key, world); return world; }
  for (const pack of game.packs ?? []) {
    if (pack.documentName !== 'Item' && pack.metadata?.type !== 'Item') continue;
    let index = null;
    try { index = await pack.getIndex(); } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'resolveInnateSource');
      continue;
    }
    const entry = [...index].find(candidate => String(candidate.name ?? '').trim().toLowerCase() === key);
    if (!entry) continue;
    const document = await pack.getDocument(entry._id);
    if (document) { INNATE_SOURCE_CACHE.set(key, document); return document; }
  }
  INNATE_SOURCE_CACHE.set(key, null);
  return null;
}

/* -------------------------------------------- */
/*  Innate grant settlement                     */
/* -------------------------------------------- */
/** The unit facts planInnateGrants and innateGrantsHeld read, with each item projected by projectInnateItem. */
function projectInnateUnit(actor) {
  return {
    uuid: actor.uuid,
    name: String(actor.name ?? ''),
    type: actor.type,
    actorType: String(actor.system?.faction?.role ?? 'Neutral'),
    unitType: clone(actor.system?.unitType ?? {}),
    items: Object.freeze([...actor.items].map(projectInnateItem))
  };
}

function projectInnateItem(item) {
  return Object.freeze({
    id: item.id,
    name: String(item.name ?? ''),
    img: String(item.img ?? ''),
    type: item.type,
    innateGrant: String(item.getFlag(SYSTEM_ID, INNATE_GRANT_FLAG) ?? ''),
    system: clone(item._source?.system ?? item.system ?? {}),
    flags: clone(item._source?.flags ?? item.flags ?? {})
  });
}

function innateGrantFingerprint(snapshot) {
  return JSON.stringify({
    actorType: snapshot.actorType,
    unitType: snapshot.unitType,
    items: snapshot.items.map(item => [item.id, item.name, item.img, item.innateGrant, item.system, item.flags]),
    sources: snapshot.sources
  });
}



function buildInnateUpdate(update) {
  if (update.kind === 'refresh') {
    return {
      _id: update.itemId,
      name: update.name,
      ...forcedReplacement('system', clone(update.system)),
      ...forcedReplacement(`flags.${SYSTEM_ID}`, clone(update.flags))
    };
  }
  return { _id: update.itemId, [`flags.${SYSTEM_ID}.${INNATE_GRANT_FLAG}`]: update.grantKey };
}

/* -------------------------------------------- */
/*  Aura settlement                             */
/* -------------------------------------------- */
function auraBoardFingerprint(board) {
  return JSON.stringify(board.units.map(unit => [
    unit.tokenUuid, unit.actorUuid, unit.placed, unit.faction, unit.footprint, unit.auraFields,
    unit.emissions.map(emission => [emission.itemId, emission.range, emission.modifier])
  ]));
}

function buildModifierUpdates(plan) {
  return {
    ...(plan.aura ? buildAuraUpdates(plan.aura) : {}),
    ...(plan.terrain ? buildTerrainUpdates(plan.terrain) : {}),
    ...(plan.movement ? buildTerrainUpdates(plan.movement) : {})
  };
}







function buildAuraUpdates(fields) {
  return Object.fromEntries(Object.entries(fields).map(([path, value]) => [`system.${path}.aura`, value]));
}



function buildTerrainUpdates(fields) {
  return Object.fromEntries(Object.entries(fields).map(([flag, value]) => [`flags.${SYSTEM_ID}.${flag}`, value]));
}



/* -------------------------------------------- */
/*  Support settlement                          */
/* -------------------------------------------- */
function projectSupportUnit(actor) {
  const support = actor._source?.system?.support ?? {};
  return {
    uuid: actor.uuid,
    name: String(actor.name ?? ''),
    type: actor.type,
    actorType: String(actor._source?.system?.faction?.role ?? actor.system?.faction?.role ?? 'Neutral'),
    affinity: String(support.affinity ?? ''),
    partners: (support.partners ?? []).map(entry => Object.freeze({
      actorUUID: String(entry?.actorUUID ?? ''),
      name: String(entry?.name ?? ''),
      // A missing rank reads as SUPPORT_UNRANKED, so support rules treat it as an unearned bond.
      rank: Number.isFinite(Number(entry?.rank)) ? Number(entry.rank) : SUPPORT_UNRANKED,
      xp: Number(entry?.xp) || 0
    }))
  };
}

function supportRosterFingerprint(units) {
  return JSON.stringify(units.map(unit => [unit.uuid, unit.name, unit.partners]));
}

/** A bond settlement writes one array, so its capture protects that path alone rather than the whole unit. */
function supportBonds(actor) {
  return { document: actor, paths: ['system.support.partners'] };
}







function inventoryFingerprint(snapshot) {
  return JSON.stringify({
    uuid: snapshot.uuid,
    type: snapshot.type,
    inCombat: snapshot.inCombat,
    system: snapshot.system,
    items: snapshot.items,
    effects: snapshot.effects
  });
}

/* -------------------------------------------- */
/*  Equipment settlement helpers                */
/* -------------------------------------------- */
/** The Armament a Character is working, read from its own flag by the Token that flag names. */
function projectBorrowedArmament(actor) {
  const tokenUuid = String(actor.getFlag(SYSTEM_ID, ARMAMENT_FLAGS.UUID) ?? '');
  if (!tokenUuid) return null;
  let token = null;
  try { token = fromUuidSync(tokenUuid); } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'projectBorrowedArmament');
    token = null;
  }
  const armament = token?.actor;
  if (armament?.type !== 'Object' || String(armament.system?.objectType ?? '') !== 'Armament') return null;
  return Object.freeze({
    uuid: tokenUuid,
    name: String(armament.name ?? ''),
    img: String(token.texture?.src ?? armament.img ?? ''),
    armament: true
  });
}

/** Leave Armament mode when the equipment command wields the unit's own weapon. Nothing else is re-wielded. */
async function dropBorrowedArmament(actor) {
  await actor.update({
    [`flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.UUID}`]: '',
    [`flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.PREVIOUS_WIELDED_ID}`]: ''
  }, { emblemEquipmentSettlement: true });
}


/** Remove and rebuild the wield, armor and mount effects a transfer left behind on the giving unit. */
async function applyEquipmentEffectPlan(actor, deleteIds, createData) {
  if (deleteIds.length) {
    await actor.deleteEmbeddedDocuments('ActiveEffect', deleteIds, { emblemEquipmentSettlement: true });
  }
  if (createData.length) {
    await actor.createEmbeddedDocuments('ActiveEffect', createData,
      { keepId: true, emblemEquipmentSettlement: true });
  }
}

/** Creation data with an id reserved on every entry that had none, so a create whose reply is lost can be undone. */
function reserveDocumentIds(data) {
  return data.map(entry => (entry?._id ? entry : { ...entry, _id: foundry.utils.randomID() }));
}


const MOUNT_NAME_PREFIX = 'Mounted: ';
const MOUNT_STAT_LABELS = Object.freeze({
  mov: 'Mov', hp: 'HP', stn: 'Stn', eva: 'Eva', atk: 'Atk', spd: 'Spd', acc: 'Acc', crit: 'Crit'
});
const MOUNT_TYPE_LABELS = Object.freeze({
  cavalry: 'Cavalry', flying: 'Flying', dragon: 'Dragon', beast: 'Beast', monster: 'Monstrosity', undead: 'Undead'
});

/* -------------------------------------------- */
/*  Equipment effect projection                 */
/* -------------------------------------------- */
/** Project one Foundry ActiveEffect into the narrow identity used by equipment rules. */
export function projectEquipmentEffectIdentity(effect) {
  const flags = effectFlags(effect);
  let kind = '';
  if (flags.isWieldEffect === true) kind = EQUIPMENT_EFFECT_KINDS.WIELD;
  else if (flags.isArmorEffect === true) kind = EQUIPMENT_EFFECT_KINDS.ARMOR;
  else if (flags.isMountEffect === true
    || effectStatuses(effect).has('Mounted')
    || String(effect?.name ?? '').startsWith(MOUNT_NAME_PREFIX)) kind = EQUIPMENT_EFFECT_KINDS.MOUNT;
  return Object.freeze({
    kind,
    itemId: String(flags.mountItemId ?? originItemId(effect?.origin) ?? '')
  });
}

/* -------------------------------------------- */
/*  ActiveEffect document mapping               */
/* -------------------------------------------- */
/** Translate approved equipment-effect intents into Foundry ActiveEffect creation data. */
function buildEquipmentEffectDocuments(intents) {
  if (!Array.isArray(intents)) return [];
  return intents.map(buildEquipmentEffectDocument);
}

/** Translate domain resource values into Foundry Actor update paths. */
function buildEquipmentResourceUpdates(resourceValues) {
  const updates = {};
  const hp = Number(resourceValues?.hp);
  const stance = Number(resourceValues?.stn);
  if (Number.isFinite(hp)) updates['system.resources.hp.value'] = hp;
  if (Number.isFinite(stance)) updates['system.resources.stn.value'] = stance;
  return updates;
}

function buildEquipmentEffectDocument(intent) {
  const item = intent?.item ?? {};
  const common = {
    img: String(item.img ?? ''),
    origin: String(item.uuid ?? ''),
    disabled: false
  };
  if (intent?.kind === EQUIPMENT_EFFECT_KINDS.WIELD) {
    return {
      _id: EQUIPMENT_EFFECT_IDS.WIELD,
      name: `Wielding: ${String(item.name ?? '')}`,
      ...common,
      flags: { [SYSTEM_ID]: { isWieldEffect: true } },
      statuses: ['Wielding']
    };
  }
  if (intent?.kind === EQUIPMENT_EFFECT_KINDS.ARMOR) {
    return {
      _id: EQUIPMENT_EFFECT_IDS.ARMOR,
      name: `Wearing: ${String(item.name ?? '')}`,
      ...common,
      flags: { [SYSTEM_ID]: { isArmorEffect: true } },
      statuses: ['Wearing']
    };
  }
  if (intent?.kind === EQUIPMENT_EFFECT_KINDS.MOUNT) return buildMountEffectDocument(intent, common);
  throw new Error(`Unknown equipment effect intent: ${String(intent?.kind ?? '')}`);
}

/**
 * Create the mount status and unit-type marker. Character compilation reads mount stat bonuses from the equipment
 * Item.
 */
function buildMountEffectDocument(intent, common) {
  const stats = intent?.mount?.stats ?? {};
  const unitTypes = intent?.mount?.unitTypes ?? {};
  const changes = [{ key: 'system.statuses.mounted', type: 'override', value: true, priority: 20 }];
  for (const key of ['infantry', ...Object.keys(MOUNT_TYPE_LABELS)]) {
    changes.push({
      key: `system.unitType.${key}`,
      type: 'override',
      value: key === 'infantry' ? false : unitTypes[key] === true,
      priority: 20
    });
  }
  return {
    name: `${MOUNT_NAME_PREFIX}${String(intent?.item?.name ?? '')}`,
    ...common,
    description: buildMountDescription(stats, unitTypes),
    changes,
    flags: { [SYSTEM_ID]: { isMountEffect: true, mountItemId: String(intent?.item?.id ?? '') } },
    statuses: ['Mounted']
  };
}

function buildMountDescription(stats, unitTypes) {
  const statBits = Object.entries(MOUNT_STAT_LABELS).flatMap(([key, label]) => {
    const value = Number(stats[key]) || 0;
    return value === 0 ? [] : [`${value > 0 ? '+' : ''}${value} ${label}`];
  });
  const typeBits = Object.entries(MOUNT_TYPE_LABELS)
    .filter(([key]) => unitTypes[key] === true)
    .map(([, label]) => label);
  const parts = [];
  if (statBits.length) parts.push(`<p><strong>Mount Bonuses:</strong> ${statBits.join(', ')}</p>`);
  if (typeBits.length) parts.push(`<p><strong>Unit Types:</strong> ${typeBits.join(', ')}</p>`);
  return parts.join('');
}

function effectStatuses(effect) {
  const statuses = effect?.statuses;
  return statuses instanceof Set ? statuses : new Set(Array.isArray(statuses) ? statuses : []);
}

function originItemId(origin) {
  if (typeof origin !== 'string') return null;
  const parts = origin.split('.');
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] === 'Item') return parts[index + 1] ?? null;
  }
  return null;
}
