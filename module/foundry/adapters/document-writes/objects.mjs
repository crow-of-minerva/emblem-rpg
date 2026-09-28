/** @layer foundry/adapters/document-writes */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { DOWNTIME_FLAG } from '../../../contracts/domains/downtime.mjs';
import {
  ARMAMENT_FLAGS,
  DROP_SETTLEMENT_OUTCOMES,
  LOCKABLE_OBJECT_TYPES,
  LOCKTOUCH_ITEM_NAME,
  OBJECT_DESTRUCTION_TIMING,
  OBJECT_PRESENTATION_EVENTS,
  objectPresentationMessage
} from '../../../contracts/domains/objects.mjs';
import {
  armamentStillOccupied,
  cellsAdjacent,
  defeatedLootPayloads,
  dropChestPresentation,
  fixtureHidden,
  objectArtDefaults,
  objectHasArtStates,
  objectLockDifficulty,
  objectScaleDefaults,
  objectTokenAppearance
} from '../../../game/objects/rules.mjs';
import { resolveAvatarScale } from '../../../game/character/rules.mjs';
import { isAirborneActor, projectActorStatusKeys } from '../projections/combat-context.mjs';
import { projectDoorVisibility } from '../projections/vision.mjs';
import { projectDowntimeUnitState } from '../projections/downtime.mjs';
import { findSceneCombat, sceneExplorationActive } from '../projections/encounters.mjs';
import { projectAttributeTotals, projectSkillRanks } from '../projections/items.mjs';
import { collectionValues, delay } from '../../../lib/core/runtime.mjs';
import {
  normalizedDocumentSource,
  resolveActor,
  resolveDocument,
  resolveToken,
  persistedTokenFootprintCells,
  tokenFootprintCells as footprintCells
} from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

const DROP_CHEST_IMAGE = `systems/${SYSTEM_ID}/assets/object/loot.png`;
const DROP_CHEST_TEMPLATE_NAME = '[Drop Loot Template]';
const DROP_CHEST_TEMPLATE_FLAG = 'isDropChestTemplate';
const DROP_CHEST_SCALE = 0.3;

/* -------------------------------------------- */
/*  Object repository                           */
/* -------------------------------------------- */

/**
 * Reads and writes for engine/objects: locks and doors, rack Armaments, and dropping or discarding items.
 *
 * Every write takes the running command's operation (as a parameter, or on the snapshot the engine froze) and
 * captures the before-images of what it will change before its first write. The lock writes rely on
 * captureLockWrites, which records them all up front. CommandDispatcher commits or restores that record, so
 * nothing here has to undo its own writes.
 */
export class FoundryObjectRepository {
  constructor({ movements }) {
    this.movements = movements;
  }

  /**
   * CommandDispatcher lock keys: the board and the Scenes, Tokens and Actors involved, any drop pile under them,
   * and every placement of a lock whose art may change. A drop from a unit with no Token locks only its Actor.
   */
  async resourceKeys(payload = {}) {
    if (payload.sourceActorUuid) return [`actor:${String(payload.sourceActorUuid)}`];
    const keys = ['movement:board'];
    for (const tokenUuid of [payload.sourceTokenUuid, payload.lockTokenUuid, payload.armamentTokenUuid]) {
      const uuid = String(tokenUuid ?? '');
      const scene = uuid.split('.Token.')[0];
      if (scene) keys.push(`scene:${scene}`);
      if (uuid) keys.push(`token:${uuid}`);
      const token = uuid ? await resolveToken(uuid) : null;
      if (token?.actor?.uuid) keys.push(`actor:${token.actor.uuid}`);
      if (token?.parent) {
        const pile = findDropPile(token.parent, Number(token.x) || 0, Number(token.y) || 0);
        if (pile?.actor?.uuid) keys.push(`actor:${pile.actor.uuid}`);
      }
    }
    if (payload.lockTokenUuid) {
      const lock = await resolveToken(payload.lockTokenUuid);
      if (lock?.actor) keys.push(...objectAppearanceKeys(lock.actor));
    }
    return [...new Set(keys)].sort();
  }

  /**
   * Project the acting unit, the lock beside or under it, and the Scene state that decides what the attempt costs.
   * A hidden lock isn't there, so it reads as none.
   */
  async getLockSnapshot(intent) {
    const sourceToken = await resolveToken(intent.sourceTokenUuid);
    const lockToken = await resolveToken(intent.lockTokenUuid);
    const sourceActor = sourceToken?.actor;
    const lockActor = lockToken?.actor;
    if (!sourceActor || sourceActor.type !== 'Character' || !lockActor || lockActor.type !== 'Object') return null;
    if (fixtureHidden({ documentType: lockActor.type, hidden: lockToken.hidden })) return null;
    if (!LOCKABLE_OBJECT_TYPES.includes(String(lockActor.system?.objectType ?? ''))) return null;
    const scene = sourceToken.parent;
    if (!scene || lockToken.parent !== scene) return null;
    const gridSize = scene.grid.size;
    const sourceCells = footprintCells(sourceToken, gridSize);
    const lockCells = footprintCells(lockToken, gridSize);
    const movement = await this.movements.getSnapshot(sourceToken.uuid);
    const encounterRunning = findSceneCombat(scene)?.started === true;
    const exploring = sceneExplorationActive(scene) === true;
    const claimsAction = encounterRunning && !exploring;
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      source: projectLockSource(sourceToken, sourceActor, movement, await resolveKeyName(lockActor)),
      lock: projectLock(lockToken, lockActor, await resolveKeyName(lockActor)),
      inReach: cellsAdjacent(sourceCells, lockCells),
      visible: String(lockActor.system?.objectType ?? '') === 'Door'
        ? projectDoorVisibility(sourceToken, lockToken) : true,
      claimsAction,
      exploring,
      sourceAirborne: isAirborneActor(sourceActor),
      commitsSquare: !claimsAction && !exploring && movement?.movementPlanning === true
    });
  }

  /**
   * Record everything a lock attempt may change, in the one capture engine/objects/interaction.mjs makes before
   * `settleLock` writes: the Object and each of its placements (whose art the opening swaps), the acting unit and
   * its Token, and the key the attempt spends.
   * @param {object} snapshot The lock snapshot the handler validated.
   * @param {{consumesKey?: boolean}} plan The opening plan from game/objects/rules.mjs.
   * @param {object|null} operation The command's operation handle, or null outside a command.
   */
  async captureLockWrites(snapshot, plan, operation = null) {
    if (!operation) return;
    const lock = await resolveActor(snapshot.lock.actorUuid);
    const source = await resolveActor(snapshot.source.actorUuid);
    const sourceToken = snapshot.source.tokenUuid ? await resolveToken(snapshot.source.tokenUuid) : null;
    const key = plan.consumesKey ? carriedKey(source, snapshot.lock.keyName) : null;
    await operation.capture({
      documents: [lock, source, sourceToken, ...objectPlacements(lock)].filter(Boolean),
      deleting: key ? [key] : []
    });
  }

  /** Open the lock and bring each placed Token's art up to date, under the command's current resource holds. */
  async unlock(snapshot, resources) {
    const actor = await resolveActor(snapshot.lock.actorUuid);
    if (!actor || actor.system?.locked !== true) return false;
    if (!resources.hold(objectAppearanceKeys(actor))) return false;
    await actor.update({ 'system.locked': false }, { emblemObjectSettlement: true });
    await syncObjectTokenAppearance(actor, { resources });
    return true;
  }

  /** Spend the key the lock names. Which key comes from the lock, never from the request. */
  async consumeKey(snapshot) {
    const actor = await resolveActor(snapshot.source.actorUuid);
    const key = carriedKey(actor, snapshot.lock.keyName);
    if (!key) return false;
    await actor.deleteEmbeddedDocuments('Item', [key.id], { emblemObjectSettlement: true });
    return !actor.items.get(key.id);
  }

  /**
   * Write the Energy and Energy-lane commitment a lockpick in free exploration leaves the unit with, the same two
   * fields the downtime writer spends for gathering, forging and brewing.
   */
  async spendEnergy(snapshot, spend) {
    const actor = await resolveActor(snapshot.source.actorUuid);
    if (!actor) return false;
    await actor.update({
      'system.resources.energy.value': spend.energy,
      [`flags.${SYSTEM_ID}.${DOWNTIME_FLAG}`]: { ...spend.commitment }
    }, { emblemDowntimeSettlement: true });
    return true;
  }

  /** An attempt during an encounter costs the unit's action, and its turn ends where it stands. */
  spendTurn(snapshot, resolution) {
    return this.movements.commit(snapshot.source.movement, resolution,
      { resume: false, endTurn: true, operation: snapshot.operation ?? null });
  }

  /** A free interaction still fixes the square the unit walked to before it acted. */
  commitSquare(snapshot, resolution) {
    return this.movements.commit(snapshot.source.movement, resolution,
      { resume: true, endTurn: false, operation: snapshot.operation ?? null });
  }

  /* -------------------------------------------- */
  /*  Armaments                                   */
  /* -------------------------------------------- */

  /**
   * Project the unit, the Armament named or already borrowed, and whether the unit still stands on it. A hidden
   * Armament reads as none, so it can't be taken up, though a unit already borrowing one can still hand it back.
   */
  async getArmamentSnapshot(intent) {
    const sourceToken = await resolveToken(intent.sourceTokenUuid);
    const sourceActor = sourceToken?.actor;
    if (!sourceActor || sourceActor.type !== 'Character') return null;
    const scene = sourceToken.parent;
    if (!scene) return null;
    const borrowedUuid = String(sourceActor.getFlag(SYSTEM_ID, ARMAMENT_FLAGS.UUID) ?? '');
    const armamentToken = await resolveToken(intent.armamentTokenUuid || borrowedUuid);
    const armamentActor = armamentToken?.actor;
    const armament = armamentActor?.type === 'Object' && String(armamentActor.system?.objectType ?? '') === 'Armament'
      && armamentToken.parent === scene
      && !fixtureHidden({ documentType: armamentActor.type, hidden: armamentToken.hidden }) ? armamentActor : null;
    const gridSize = scene.grid.size;
    const sourceCells = persistedTokenFootprintCells(sourceToken, gridSize);
    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      exploring: sceneExplorationActive(scene) === true,
      source: projectArmamentSource(sourceToken, sourceActor, borrowedUuid),
      armament: armament ? projectArmament(armamentToken, armament) : null,
      inReach: armament ? armamentStillOccupied(sourceCells, persistedTokenFootprintCells(armamentToken, gridSize)) : false
    });
  }

  /**
   * Record the rack on the wielder and unwield its own weapon. Moving from one rack to another keeps the weapon
   * remembered from before the first.
   */
  async wieldArmament(snapshot, operation = null) {
    const actor = await resolveActor(snapshot.source.actorUuid);
    const armamentToken = await resolveToken(snapshot.armament.tokenUuid);
    if (!actor || !armamentToken?.actor) return false;
    const alreadyBorrowing = Boolean(snapshot.source.armamentTokenUuid);
    const previousId = alreadyBorrowing ? snapshot.source.previousWieldedItemId : snapshot.source.wieldedItemId;
    const stowed = !alreadyBorrowing && previousId ? actor.items.get(previousId) : null;
    await operation?.capture({ documents: [actor, stowed].filter(Boolean) });
    await actor.update({
      [`flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.UUID}`]: snapshot.armament.tokenUuid,
      [`flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.PREVIOUS_WIELDED_ID}`]: previousId
    });
    if (stowed?.system?.isWielded === true) await stowed.update({ 'system.isWielded': false });
    return true;
  }

  /** Clear the rack from the wielder, drop the Wielding marker it left, and optionally re-wield the old weapon. */
  async releaseArmament(snapshot, { restore = true, operation = null } = {}) {
    const actor = await resolveActor(snapshot.source.actorUuid);
    if (!actor || !snapshot.source.armamentTokenUuid) return false;
    const previousId = String(snapshot.source.previousWieldedItemId ?? '');
    const wieldMarkers = collectionValues(actor.effects)
      .filter(effect => effect.flags?.[SYSTEM_ID]?.isWieldEffect === true);
    const previous = restore && previousId ? actor.items.get(previousId) : null;
    await operation?.capture({
      documents: [actor, previous].filter(Boolean), deleting: wieldMarkers
    });
    await actor.update({
      [`flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.UUID}`]: '',
      [`flags.${SYSTEM_ID}.${ARMAMENT_FLAGS.PREVIOUS_WIELDED_ID}`]: ''
    });
    if (wieldMarkers.length) {
      await actor.deleteEmbeddedDocuments('ActiveEffect', wieldMarkers.map(effect => effect.id));
    }
    if (previous && previous.system?.isWielded !== true) await previous.update({ 'system.isWielded': true });
    return true;
  }

  /* -------------------------------------------- */
  /*  Item drops                                  */
  /* -------------------------------------------- */

  /**
   * Project the unit, the Item it means to set down, and whether it stands on a Scene to drop onto. A unit named by
   * its Actor stands on none: it has no Token, Scene or plan, and can only discard what it carries.
   */
  async getDropSnapshot(intent) {
    if (intent.sourceActorUuid) {
      const actor = await resolveActor(intent.sourceActorUuid);
      if (!actor || actor.type !== 'Character') return null;
      const carried = actor.items.get(intent.itemId) ?? null;
      return Object.freeze({
        sceneUuid: '',
        exploring: false,
        placed: false,
        source: Object.freeze({
          actorUuid: String(actor.uuid ?? ''), tokenUuid: '', actorName: String(actor.name ?? 'Character'), movement: null
        }),
        item: carried ? projectDroppedItem(carried) : null
      });
    }
    const sourceToken = await resolveToken(intent.sourceTokenUuid);
    const sourceActor = sourceToken?.actor;
    if (!sourceActor || sourceActor.type !== 'Character' || !sourceToken.parent) return null;
    const item = sourceActor.items.get(intent.itemId) ?? null;
    const movement = await this.movements.getSnapshot(sourceToken.uuid);
    return Object.freeze({
      sceneUuid: String(sourceToken.parent.uuid ?? ''),
      exploring: sceneExplorationActive(sourceToken.parent) === true,
      placed: true,
      source: Object.freeze({
        actorUuid: String(sourceActor.uuid ?? ''),
        tokenUuid: String(sourceToken.uuid ?? ''),
        actorName: String(sourceActor.name ?? sourceToken.name ?? 'Character'),
        movement: movement ?? null
      }),
      item: item ? projectDroppedItem(item) : null
    });
  }

  /** Lay the Item on the unit's square: the copy or a new bag lands, and only then does the original leave. */
  async dropItemAsLoot(snapshot, context = {}) {
    const token = await resolveToken(snapshot.source.tokenUuid);
    const scene = token?.parent;
    const actor = token?.actor;
    const item = actor?.items.get(snapshot.item.id);
    if (!scene || !item) return dropOutcome(DROP_SETTLEMENT_OUTCOMES.STALE, 'objects.drop-aggregate-missing');
    const x = Number(token.x) || 0;
    const y = Number(token.y) || 0;
    const payloads = [loosePayload(item)];
    const reserved = await reserveDropPlacement(scene, x, y, payloads, context.operation ?? null, [item]);
    try {
      if (!await dropPayloadsAt(scene, x, y, payloads, reserved)) throw new Error('objects.drop-placement-failed');
      await actor.deleteEmbeddedDocuments('Item', [item.id]);
      if (actor.items.get(item.id)) throw new Error('objects.drop-source-delete-failed');
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'dropItemAsLoot');
      return dropOutcome(DROP_SETTLEMENT_OUTCOMES.REVERTED, String(error?.message ?? 'objects.drop-write-failed'));
    }
    return dropOutcome(DROP_SETTLEMENT_OUTCOMES.SETTLED, '');
  }

  /** Destroy the Item outright. */
  async discardItem(snapshot, operation = null) {
    const actor = await resolveActor(snapshot.source.actorUuid);
    const item = actor?.items.get(snapshot.item.id);
    if (!item) return false;
    await operation?.capture({ deleting: [item] });
    await actor.deleteEmbeddedDocuments('Item', [item.id]);
    return true;
  }

  /** A defeated unit leaves its Drops-flagged, unequipped goods on its square before the token is removed. */
  async dropDefeatedLoot(actorUuid, tokenUuid, operation = null) {
    const actor = await resolveActor(actorUuid);
    const token = await resolveToken(tokenUuid);
    if (!actor || !token?.parent) return false;
    const dropped = defeatedLootPayloads(collectionValues(actor.items).map(projectDroppedItem));
    if (!dropped.length) return false;
    const payloads = dropped.map(entry => loosePayload(actor.items.get(entry.id))).filter(Boolean);
    const x = Number(token.x) || 0;
    const y = Number(token.y) || 0;
    await dropPayloadsAt(token.parent, x, y, payloads,
      await reserveDropPlacement(token.parent, x, y, payloads, operation));
    return true;
  }

  /**
   * Release the rack once its wielder no longer stands on it. Checked after each movement commit
   * (engine/movement/commands.mjs) and whenever the wielder's Token moves (foundry/hooks/objects.mjs).
   */
  async releaseArmamentIfLeft(tokenUuid, operation = null) {
    const snapshot = await this.getArmamentSnapshot({ sourceTokenUuid: tokenUuid, armamentTokenUuid: '' });
    if (!snapshot?.source.armamentTokenUuid) return false;
    if (snapshot.armament && snapshot.inReach) return false;
    return this.releaseArmament(snapshot, { restore: true, operation });
  }
}

/* -------------------------------------------- */
/*  Drop piles                                  */
/* -------------------------------------------- */

function projectDroppedItem(item) {
  const system = item.system ?? {};
  return Object.freeze({
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    innate: Boolean(item.getFlag(SYSTEM_ID, 'innateGrant')),
    isEquipped: system.isWielded === true || system.isWorn === true || system.isEquipped === true,
    stealableFlag: String(system.stealable?.flag ?? '')
  });
}

function loosePayload(item) {
  if (!item) return null;
  const payload = item.toObject();
  delete payload._id;
  payload.system ??= {};
  payload.system.isWielded = false;
  payload.system.isWorn = false;
  payload.system.isEquipped = false;
  const stored = normalizedDocumentSource('Item', payload);
  delete stored._id;
  return stored;
}

/**
 * The drop pile already standing on a square, or nothing when that square is still bare. A hidden pile isn't there,
 * so a drop onto its square lays down a pile of its own.
 */
function findDropPile(scene, x, y) {
  return collectionValues(scene?.tokens).find(tokenDocument => {
    const actor = tokenDocument.actor;
    return actor?.type === 'Object' && String(actor.system?.objectType ?? '') === 'Loot'
      && actor.system?.isDropChest === true && tokenDocument.hidden !== true
      && tokenDocument.x === x && tokenDocument.y === y;
  }) ?? null;
}

/**
 * Make the ids a drop is about to create and record its before-images in one capture, so a command that fails
 * afterwards has exactly the copy, bag and template to remove and the original Item to put back. Without an
 * operation nothing is reserved and Foundry assigns the ids.
 * @returns {{itemIds: string[], tokenId: string, templateId: string}} What dropPayloadsAt must create with.
 */
async function reserveDropPlacement(scene, x, y, payloads, operation = null, deleting = []) {
  const reserved = { itemIds: [], tokenId: '', templateId: '' };
  if (!operation) return reserved;
  const pile = findDropPile(scene, x, y);
  const creating = [];
  if (pile) {
    reserved.itemIds = payloads.map(() => claimedDocumentId());
    creating.push({ parent: pile.actor, documentName: 'Item', ids: reserved.itemIds });
  } else {
    if (!dropChestTemplateActor()) {
      reserved.templateId = claimedDocumentId();
      creating.push({ parent: null, documentName: 'Actor', ids: [reserved.templateId] });
    }
    reserved.tokenId = claimedDocumentId();
    creating.push({ parent: scene, documentName: 'Token', ids: [reserved.tokenId] });
  }
  await operation.capture({ documents: pile ? [pile.actor] : [], deleting, creating });
  return reserved;
}

/**
 * Put dropped items on a square: into the drop pile already there, or into a new bag Token. Uses the ids
 * reserveDropPlacement made, if any. Returns the pile or the new Token, or null if nothing was created.
 */
async function dropPayloadsAt(scene, x, y, payloads, { itemIds = [], tokenId = '', templateId = '' } = {}) {
  if (!payloads.length) return null;
  const existing = findDropPile(scene, x, y);
  if (existing) {
    const data = payloads.map((payload, index) => (itemIds[index] ? { ...payload, _id: itemIds[index] } : payload));
    const created = await existing.actor.createEmbeddedDocuments('Item', data,
      itemIds.length ? { keepId: true } : {});
    return created?.length ? existing : null;
  }
  const look = dropChestPresentation(payloads, DROP_CHEST_IMAGE);
  const template = await dropChestTemplate(templateId);
  const tokenData = await template.getTokenDocument({
    x,
    y,
    name: look.name,
    texture: { src: look.image, scaleX: DROP_CHEST_SCALE, scaleY: DROP_CHEST_SCALE },
    actorLink: false,
    delta: { name: look.name, img: look.image, items: payloads }
  });
  const data = tokenData.toObject();
  if (tokenId) data._id = tokenId;
  const created = await scene.createEmbeddedDocuments('Token', [data], tokenId ? { keepId: true } : {});
  return created?.[0] ?? null;
}

/** The world's one drop-bag template Actor, or nothing until the first bag creates it. */
function dropChestTemplateActor() {
  return collectionValues(game.actors)
    .find(actor => actor.getFlag(SYSTEM_ID, DROP_CHEST_TEMPLATE_FLAG) === true) ?? null;
}

/** The drop-bag template, created under the id reserveDropPlacement reserved when the world has none yet. */
async function dropChestTemplate(templateId = '') {
  const existing = dropChestTemplateActor();
  if (existing) {
    if (String(existing.system?.objectType ?? '') !== 'Loot') {
      await existing.update({ 'system.objectType': 'Loot', 'system.locked': false, 'system.isDropChest': true });
    }
    return existing;
  }
  return globalThis.Actor.create({
    ...(templateId ? { _id: templateId } : {}),
    name: DROP_CHEST_TEMPLATE_NAME,
    type: 'Object',
    img: DROP_CHEST_IMAGE,
    system: { objectType: 'Loot', locked: false, isDropChest: true },
    ownership: { default: 0 },
    flags: { [SYSTEM_ID]: { [DROP_CHEST_TEMPLATE_FLAG]: true } },
    prototypeToken: {
      actorLink: false,
      texture: { src: DROP_CHEST_IMAGE, scaleX: DROP_CHEST_SCALE, scaleY: DROP_CHEST_SCALE },
      width: 1,
      height: 1,
      lockRotation: true,
      sort: -1000
    }
  });
}

/** The gameplay result engine/objects/interaction.mjs turns into an acceptance or a refusal. */
function dropOutcome(code, reasonCode) {
  return { ok: code === DROP_SETTLEMENT_OUTCOMES.SETTLED, code, reasonCode };
}

/** A new document id, made before the create so the operation can record what a rollback must remove. */
function claimedDocumentId() {
  return foundry.utils.randomID();
}

/* -------------------------------------------- */
/*  Armament projection                         */
/* -------------------------------------------- */

function projectArmamentSource(token, actor, borrowedUuid) {
  const system = actor.system ?? {};
  const wielded = collectionValues(actor.items).find(item => item.system?.isWielded === true
    && ['Weapon', 'Attack', 'Staff'].includes(String(item.system?.itemType ?? '')));
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    actorName: String(actor.name ?? token.name ?? 'Character'),
    mounted: system.statuses?.mounted === true,
    proficiencies: Object.freeze(Object.fromEntries(Object.entries(system.prof ?? {})
      .map(([key, value]) => [key, Number(value?.total) || 0]))),
    wieldedItemId: String(wielded?.id ?? ''),
    armamentTokenUuid: borrowedUuid,
    previousWieldedItemId: String(actor.getFlag(SYSTEM_ID, ARMAMENT_FLAGS.PREVIOUS_WIELDED_ID) ?? '')
  });
}

function projectArmament(token, actor) {
  const armament = actor.system?.armament ?? {};
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    name: String(actor.name ?? token.name ?? 'Armament'),
    objectType: String(actor.system?.objectType ?? ''),
    requiredProficiency: String(armament.req ?? 'None'),
    requiredRank: Number(armament.rank) || 0,
    durability: Object.freeze({
      value: Number(armament.durability?.value) || 0,
      max: Number(armament.durability?.max) || 0,
      type: String(armament.durability?.type ?? 'limited')
    })
  });
}

/* -------------------------------------------- */
/*  Lock projection                             */
/* -------------------------------------------- */

function projectLockSource(token, actor, movement, keyName) {
  const system = actor.system ?? {};
  const statuses = projectActorStatusKeys(actor);
  const itemNames = collectionValues(actor.items).map(item => String(item.name ?? ''));
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    actorName: String(actor.name ?? token.name ?? 'Character'),
    actorImage: String(actor.img ?? token.texture?.src ?? ''),
    avatarScale: resolveAvatarScale(system.art?.avatarScale),
    actorType: String(system.faction?.role ?? 'Neutral'),
    attributes: projectAttributeTotals(system),
    skills: projectSkillRanks(system),
    blessed: statuses.has('blessed') || system.statuses?.blessed === true,
    standardAvailable: system.turn?.actionAvailable !== false,
    carriesKey: Boolean(keyName) && itemNames.includes(keyName),
    hasLocktouch: itemNames.includes(LOCKTOUCH_ITEM_NAME),
    downtime: projectDowntimeUnitState(actor),
    movement: movement ?? null
  });
}

function projectLock(token, actor, keyName) {
  const system = actor.system ?? {};
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    name: String(actor.name ?? token.name ?? 'Object'),
    image: String(token.texture?.src ?? actor.img ?? ''),
    objectType: String(system.objectType ?? ''),
    locked: system.locked !== false,
    keyName: String(keyName ?? ''),
    difficultyClass: objectLockDifficulty(system.difficultyClass)
  });
}

async function resolveKeyName(lockActor) {
  const keyUuid = String(lockActor?.system?.key ?? '');
  if (!keyUuid) return '';
  const item = await resolveDocument(keyUuid);
  return String(item?.name ?? '');
}

/** The key a unit carries for a lock. Which key comes from the lock, never from the request. */
function carriedKey(actor, keyName) {
  const name = String(keyName ?? '');
  return name ? collectionValues(actor?.items).find(item => item.name === name) ?? null : null;
}

/* -------------------------------------------- */
/*  Object token appearance                     */
/* -------------------------------------------- */

/**
 * The art facts an Object's appearance is decided from, also read by document-writes/tokens.mjs. An unlinked
 * Token's prototype tint comes from its base Actor.
 */
export function projectObjectArtFacts(actor) {
  const art = actor?.system?.art ?? {};
  const baseActor = actor?.isToken ? actor.token?.baseActor ?? actor : actor;
  return {
    objectType: String(actor?.system?.objectType ?? ''),
    locked: actor?.system?.locked,
    destroyed: isObjectDestroyed(actor),
    isDropChest: actor?.system?.isDropChest === true,
    img: String(actor?.img ?? ''),
    prototypeSrc: String(actor?.prototypeToken?.texture?.src ?? ''),
    prototypeTint: tintCss(baseActor?.prototypeToken?.texture?.tint),
    altImagePath: String(art.altImagePath ?? ''),
    destroyedImagePath: String(art.destroyedImagePath ?? ''),
    states: Object.fromEntries(OBJECT_ART_KEYS
      .filter(key => art[key] && typeof art[key] === 'object')
      .map(key => [key, art[key]]))
  };
}

/** Whether an Object's Integrity has run out, which is what swaps a Destructible to its broken art. */
function isObjectDestroyed(actor) {
  if (actor?.system?.objectType !== 'Destructible') return false;
  return (Number(actor.system?.resources?.stn?.value) || 0) <= 0;
}

/**
 * Whether a Destructible's Token should render as destroyed, for the token art code in document-writes/tokens.mjs.
 * Only once its saved art matches the broken state, because the host delays that write until smoke covers it.
 */
export function isVisuallyDestroyed(token) {
  const actor = token?.actor;
  if (!isObjectDestroyed(actor) || DESTRUCTION_SWAPS.has(String(token?.document?.uuid ?? ''))) return false;
  const wanted = String(objectTokenAppearance(projectObjectArtFacts(actor)).src ?? '');
  const shown = String(token?.document?._source?.texture?.src ?? token?.document?.texture?.src ?? '');
  return !wanted || shown.split('?')[0] === wanted.split('?')[0];
}

/** Hold a Token at its intact art while the smoke that hides the swap is playing. */
function beginDestructionSwap(tokenDocument) {
  const uuid = String(tokenDocument?.uuid ?? '');
  if (uuid) DESTRUCTION_SWAPS.add(uuid);
}

/** Release a Token from the concealed swap. */
function endDestructionSwap(tokenDocument) {
  DESTRUCTION_SWAPS.delete(String(tokenDocument?.uuid ?? ''));
}

/**
 * Bring each placed Token's art, scale and tint in line with its Object's state. Only changed fields are written,
 * so the update hooks don't loop. Prototype art is left alone. When a Destructible breaks, smoke is sent first and
 * the texture write waits until the smoke covers it. Called by FoundryObjectRepository.unlock and by the Object
 * update hook in foundry/hooks/objects.mjs.
 * @param {Actor} actor The Object whose Tokens are being brought up to date.
 * @param {{destructionFx?: boolean, present?: Function, resources?: object}} [options] Optional presentation, and
 *   the resource holds a command's art writes must still own.
 * @returns {Promise<boolean>}
 */
export async function syncObjectTokenAppearance(actor,
  { destructionFx = false, present = null, resources = null } = {}) {
  if (actor?.type !== 'Object') return false;
  if (actor.isToken) {
    const own = appearanceWrites(actor, actor.token);
    if (!Object.keys(own).length) return true;
    holdObjectArt(resources, actor.token);
    if (destructionFx && isDestructionSwap(actor, own)) await concealDestruction(actor.token, present);
    await writeTokenArt(actor.token, own);
    return true;
  }
  for (const scene of collectionValues(game.scenes)) {
    const updates = [];
    const concealed = [];
    for (const tokenDocument of collectionValues(scene.tokens)) {
      if (tokenDocument.actorId !== actor.id) continue;
      const tokenActor = tokenDocument.actor ?? actor;
      const writes = appearanceWrites(tokenActor, tokenDocument);
      if (!Object.keys(writes).length) continue;
      holdObjectArt(resources, tokenDocument);
      if (destructionFx && tokenDocument.object && isDestructionSwap(tokenActor, writes)) {
        beginDestructionSwap(tokenDocument);
        concealed.push({ tokenDocument, writes });
      } else updates.push({ _id: tokenDocument.id, ...writes });
    }
    if (updates.length) await scene.updateEmbeddedDocuments('Token', updates, objectArtWrite());
    if (concealed.length) await delay(OBJECT_DESTRUCTION_TIMING.swapDelay);
    for (const { tokenDocument, writes } of concealed) {
      await presentDestruction(tokenDocument, present);
      await writeTokenArt(tokenDocument, writes);
    }
  }
  return true;
}

/** Every Token an Object stands on, including unlinked placements sharing its base Actor id. */
function objectPlacements(actor) {
  if (!actor) return [];
  if (actor.isToken) return [actor.token].filter(Boolean);
  return collectionValues(game.scenes).flatMap(scene => collectionValues(scene.tokens))
    .filter(token => token.actorId === actor.id);
}

/** Lock keys for every placement of an Object, which an opening must hold before it changes any art. */
function objectAppearanceKeys(actor) {
  return [...new Set([`actor:${actor.uuid}`, ...objectPlacements(actor).flatMap(token => [
    `scene:${token.parent.uuid}`, `token:${token.uuid}`, ...(token.actor?.uuid ? [`actor:${token.actor.uuid}`] : [])
  ])])];
}

/**
 * A command's art write must hold the placement it changes, even on a Scene other than the one the unit stands on.
 * FoundryObjectRepository.unlock passes its resource holds, and a hook-driven sync passes none and just writes.
 * Throws if a hold can't be taken.
 */
function holdObjectArt(resources, token) {
  if (!resources) return;
  const keys = [`scene:${token.parent.uuid}`, `token:${token.uuid}`,
    ...(token.actor?.uuid ? [`actor:${token.actor.uuid}`] : [])];
  if (!resources.hold(keys)) throw new Error('Object art resources are busy.');
}

/** Whether a pending write is the moment a Destructible visibly breaks, the one swap concealed behind smoke. */
function isDestructionSwap(actor, writes) {
  const destroyed = String(actor?.system?.art?.destroyedImagePath ?? '');
  return Boolean(destroyed) && writes['texture.src'] === destroyed && isObjectDestroyed(actor);
}

/** Hold one Token as intact through the beat before the smoke and the smoke itself. */
async function concealDestruction(tokenDocument, present) {
  beginDestructionSwap(tokenDocument);
  await delay(OBJECT_DESTRUCTION_TIMING.swapDelay);
  await presentDestruction(tokenDocument, present);
}

/** Send every client the smoke and crumble, then wait while it covers the Token. If the send fails, swap at once. */
async function presentDestruction(tokenDocument, present) {
  if (typeof present !== 'function') return;
  try {
    const shown = await present(objectPresentationMessage(OBJECT_PRESENTATION_EVENTS.DESTROYED, {
      tokenUuid: String(tokenDocument.uuid ?? '')
    }));
    if (shown !== false) await delay(OBJECT_DESTRUCTION_TIMING.smokeCover);
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'presentDestruction');
  }
}

/** Write a Token's art instantly, release any concealment, and re-seat the sprite whose state just changed. */
async function writeTokenArt(tokenDocument, writes) {
  endDestructionSwap(tokenDocument);
  try {
    await tokenDocument.update(writes, objectArtWrite());
  } finally {
    tokenDocument.object?.renderFlags?.set?.({ refreshPosition: true });
  }
}

/**
 * Push prototype size, scale, tint and name changes to placed Tokens. Preserve per-state scale and tint on
 * two-state Objects.
 * @param {Actor} actor The Object whose prototype was edited.
 * @param {object} changes The Actor update that was applied.
 * @returns {Promise<boolean>}
 */
export async function syncObjectTokenParameters(actor, changes) {
  if (actor?.type !== 'Object') return false;
  if (actor.isToken) {
    const name = foundry.utils.getProperty(changes, 'name');
    if (!name || !actor.token || actor.token.name === name) return false;
    await actor.token.update({ name });
    return true;
  }
  const perState = objectHasArtStates(actor.system?.objectType);
  const writes = {};
  const carry = (path, target, skip = false) => {
    const value = foundry.utils.getProperty(changes, path);
    if (value !== undefined && !skip) writes[target] = value;
  };
  carry('prototypeToken.width', 'width');
  carry('prototypeToken.height', 'height');
  carry('prototypeToken.texture.scaleX', 'texture.scaleX', perState);
  carry('prototypeToken.texture.scaleY', 'texture.scaleY', perState);
  carry('prototypeToken.texture.tint', 'texture.tint', perState);
  carry('name', 'name');
  if (!Object.keys(writes).length) return false;
  for (const scene of collectionValues(game.scenes)) {
    const updates = collectionValues(scene.tokens)
      .filter(tokenDocument => tokenDocument.actorId === actor.id)
      .map(tokenDocument => ({ _id: tokenDocument.id, ...writes }));
    if (updates.length) await scene.updateEmbeddedDocuments('Token', updates, objectArtWrite());
  }
  return true;
}

/**
 * The extra writes an Object's create or update needs: default art and scale for its subtype, and its name and image
 * copied to the prototype Token. Art the author set is kept. A synthetic (token) Actor has no prototype, so only its
 * art is seeded. Sight stays off: it is turned off on creation, and forced off when an update tries to enable it.
 * Called from the preCreateActor and preUpdateActor handlers in foundry/hooks/objects.mjs.
 *
 * The preUpdateActor changes are not diffed yet, and every sheet save re-sends the subtype and name the Object
 * already has. So an update seeds only when the subtype really changes, and copies the name only on a rename.
 * Otherwise any sheet edit would put a chosen scale back to the subtype's default.
 * @param {Actor} actor The Object being created or updated.
 * @param {object|null} changes The pending update, or null on creation.
 * @returns {object} The writes the caller folds into its own update.
 */
export function planObjectPrototypeWrites(actor, changes = null) {
  const pending = changes ?? {};
  const writes = changes ? {} : { 'prototypeToken.sight.enabled': false, 'prototypeToken.lockRotation': true };
  if (changes && (pending['prototypeToken.sight.enabled'] === true
    || foundry.utils.getProperty(pending, 'prototypeToken.sight.enabled') === true)) {
    writes['prototypeToken.sight.enabled'] = false;
  }
  const objectType = changes
    ? changedValue(pending, 'system.objectType', actor?.system?.objectType)
    : String(actor?.system?.objectType ?? '');
  if (objectType) {
    const facts = {
      isDropChest: actor?.system?.isDropChest === true,
      jb2a: Boolean(globalThis.game?.modules?.get?.('jb2a_patreon')?.active),
      placeholderArt: CONST.DEFAULT_TOKEN,
      current: {
        img: String(actor?.img ?? ''),
        'system.art.altImagePath': String(actor?.system?.art?.altImagePath ?? ''),
        'system.art.destroyedImagePath': String(actor?.system?.art?.destroyedImagePath ?? ''),
        'prototypeToken.texture.src': String(actor?.prototypeToken?.texture?.src ?? '')
      }
    };
    const seeds = {
      ...objectArtDefaults(facts, objectType),
      ...(actor?.isToken ? {} : objectScaleDefaults(actor?.prototypeToken?.texture?.scaleX, objectType))
    };
    for (const [field, value] of Object.entries(seeds)) {
      if (!foundry.utils.hasProperty(pending, field)) writes[field] = value;
    }
  }
  if (actor?.isToken) return writes;
  const name = changes ? changedValue(pending, 'name', actor?.name) : actor?.name;
  if (name && !foundry.utils.hasProperty(pending, 'prototypeToken.name')) writes['prototypeToken.name'] = name;
  const image = changes ? foundry.utils.getProperty(pending, 'img') : actor?.img;
  const seeded = writes.img ?? image;
  if (seeded && !foundry.utils.hasProperty(pending, 'prototypeToken.texture.src')
    && writes['prototypeToken.texture.src'] === undefined) {
    writes['prototypeToken.texture.src'] = seeded;
  }
  return writes;
}

/** A pending field's value when it differs from the stored one, else undefined. */
function changedValue(pending, path, stored) {
  const value = foundry.utils.getProperty(pending, path);
  return value === stored ? undefined : value;
}

const DESTRUCTION_SWAPS = new Set();
const objectArtWrite = () => ({ emblemObjectSettlement: true, animation: { duration: 0 } });
const OBJECT_ART_KEYS = Object.freeze(['intact', 'destroyed', 'closed', 'opened']);

function appearanceWrites(actor, target) {
  const appearance = objectTokenAppearance(projectObjectArtFacts(actor));
  const writes = {};
  if (appearance.src && String(target?.texture?.src ?? '') !== appearance.src) {
    writes['texture.src'] = appearance.src;
  }
  if (appearance.scale !== null
    && (target?.texture?.scaleX !== appearance.scale || target?.texture?.scaleY !== appearance.scale)) {
    writes['texture.scaleX'] = appearance.scale;
    writes['texture.scaleY'] = appearance.scale;
  }
  if (appearance.tint !== null && tintDiffers(target?.texture?.tint, appearance.tint)) {
    writes['texture.tint'] = appearance.tint;
  }
  return writes;
}

function tintDiffers(current, desired) {
  const value = tintCss(current);
  return value === null || value.toLowerCase() !== String(desired).toLowerCase();
}

function tintCss(raw) {
  if (raw === null || raw === undefined || raw === '') return '#ffffff';
  if (typeof raw?.css === 'string') return raw.css.toLowerCase();
  if (typeof raw === 'number' && Number.isInteger(raw)) return `#${raw.toString(16).padStart(6, '0')}`;
  if (typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  try {
    return foundry.utils.Color.from(raw).css;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'tintCss');
    return null;
  }
}
