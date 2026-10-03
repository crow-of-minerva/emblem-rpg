/** @layer foundry/adapters/projections */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { triggerGroupForItem } from '../../../contracts/dsl/effects.mjs';
import { ACTIVATION_EXPERIENCE_USES_FLAG, RALLY_RECORD_FLAG } from '../../../contracts/domains/progression.mjs';
import { activationExperienceEntry, currentAffinityTable } from '../services/json-files.mjs';
import { activationExperienceKey } from '../../../game/progression/activation-experience.mjs';
import {
  normalizeRallyRecord, rallyCasterFacts, rallyRankFor, rallyStatBonuses, rallyStatRows
} from '../../../game/support/rules.mjs';
import { INNATE_GRANT_FLAG } from '../../../game/character/innate-grants.mjs';
import { ITEM_ACTIVATION_TRIGGERS } from '../../../contracts/domains/items.mjs';
import { isPopulated } from '../../../contracts/dsl/animations.mjs';
import { animationSkipsCinematic, selectAnimationRange } from '../../../game/effects/animation-planning.mjs';
import { parseRetraction, retractionMemoryFor } from '../../../game/items/retraction.mjs';
import { entriesAlwaysGuard } from '../../../game/effects/planning.mjs';
import { MOVEMENT_PERMISSION_FLAG, mountsForbidden, normalizeMovementPermission } from '../../../game/movement/input-policy.mjs';
import {
  activationAreaCells,
  activationCinematicCategory,
  activationCoverage,
  activationRedirectsToGuarder,
  activationSuccessRate,
  buildActivationTargetingGrid,
  buildMountStatChanges,
  deriveActivationArea,
  deriveActivationEnvelope,
  deriveActivationTargets,
  isActivationItem,
  isMountActivation,
  mountActivationIntent,
  resolveActivationDelivery,
  resolveActivationLine,
  resolveSaveAdvantage
} from '../../../game/items/activation.mjs';
import { resolveTargetKind, TARGET_KINDS } from '../../../game/objects/rules.mjs';
import { footprintCellKeys } from '../../../game/targeting/shapes.mjs';
import { resolveEngagement } from '../../../game/targeting/attack-grid.mjs';
import { projectTargetingBoard } from './board.mjs';
import { projectActorPartyId } from './parties.mjs';
import { findSceneCombat, sceneExplorationActive } from './encounters.mjs';
import { redirectFoundryFixtureToken, redirectFoundryHostileToken } from './tokens.mjs';
import { projectLandingBlocked, projectSight, readTerrainElevations } from './terrain.mjs';
import {
  SKILL_BY_KEY, resolveAvatarScale, unitIgnoresLineOfSight
} from '../../../game/character/rules.mjs';
import {
  buildSavingThrow,
  buildSkillCheck,
  calculateSavingThrowDifficulty,
  calculateSkillCheckDifficulty,
  checkSuccessChance,
  projectSavingThrowModifiers
} from '../../../game/rolls/checks.mjs';
import {
  isAirborneActor,
  isMagicItemDocument,
  isStanceBrokenActor,
  normalizeStatusKey,
  projectFlightForbidden,
  projectActorStatusKeys,
  projectFoundryCombatActorContext,
  projectHealEchoPolicies,
  projectProficiency,
  tokenTerrainElevation
} from './combat-context.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import {
  clone, persistedTokenCenter, persistedTokenPosition, resolveActor, resolveItem, resolveToken, testSceneWallCollision
} from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';
import { worldClassicFlyerTargeting } from '../services/settings-policy.mjs';

/* -------------------------------------------- */
/*  Item catalog                                */
/* -------------------------------------------- */
const PACK_INDEXES = new Map();

/** Read every Item compendium index once per requested field set, until a pack changes under it. */
async function packCatalogEntries(fields) {
  const key = [...fields].sort().join('|');
  if (!PACK_INDEXES.has(key)) {
    PACK_INDEXES.set(key, (async () => {
      const entries = [];
      for (const pack of collectionValues(globalThis.game?.packs)) {
        if ((pack?.documentName ?? pack?.metadata?.type) !== 'Item') continue;
        try {
          for (const entry of await pack.getIndex(fields.length ? { fields: [...fields] } : undefined)) {
            entries.push(Object.freeze({
              uuid: entry.uuid ?? `Compendium.${pack.collection}.Item.${entry._id}`,
              name: String(entry.name ?? ''),
              img: entry.img ?? '',
              type: entry.type,
              system: entry.system ?? {},
              source: pack.metadata?.label ?? pack.title ?? ''
            }));
          }
        } catch (error) {
          reportFoundryError(import.meta.url, error, `Emblem RPG | Could not index ${pack.metadata?.label ?? pack.collection}`);
        }
      }
      return Object.freeze(entries);
    })());
  }
  return PACK_INDEXES.get(key);
}

/** Drop the cached compendium indexes, so the next catalog read sees a pack that has been edited. */
export function invalidateItemCatalog() {
  PACK_INDEXES.clear();
}

/**
 * Every authored Item of the given types, from this world and from every Item compendium.
 * @param {Iterable<string>} types  Item document types to keep.
 * @param {object} [options]        `fields` names the index fields a caller reads from `system`.
 * @returns {Promise<Array>} World entries first, each `{uuid, name, img, type, system, source}`.
 */
export async function readItemCatalog(types, { fields = [] } = {}) {
  const wanted = new Set(types);
  const entries = [];
  for (const item of collectionValues(globalThis.game?.items)) {
    if (!wanted.has(item?.type)) continue;
    entries.push(Object.freeze({
      uuid: item.uuid,
      name: String(item.name ?? ''),
      img: item.img ?? '',
      type: item.type,
      system: item.system ?? {},
      source: ''
    }));
  }
  for (const entry of await packCatalogEntries(fields)) {
    if (wanted.has(entry.type)) entries.push(entry);
  }
  return entries;
}

/* -------------------------------------------- */
/*  Item use on the host client                 */
/* -------------------------------------------- */

/**
 * What the host client reads from Foundry to carry out an item use (engine/items/activation.mjs): the resource
 * keys, the data it checks and applies, the out-of-date check before its first write, and the units its effects
 * reached. Built in init/system.mjs.
 */
export class FoundryItemActivationRepository {
  constructor({ movements = null, guardBonds = null } = {}) {
    this.movements = movements;
    this.guardBonds = guardBonds;
  }

  /** Name the movement board, Scene, caster, Item and target Actors the activation command may write. */
  async resourceKeys(payload = {}) {
    const source = await resolveToken(payload.sourceTokenUuid);
    const targets = await Promise.all((payload.targetTokenUuids ?? []).map(uuid => resolveToken(uuid)));
    return [
      'movement:board',
      source?.parent?.uuid ? `scene:${source.parent.uuid}` : '',
      source?.actor?.uuid ? `actor:${source.actor.uuid}` : '',
      payload.itemUuid ? `item:${payload.itemUuid}` : '',
      ...targets.map(token => token?.actor?.uuid ? `actor:${token.actor.uuid}` : '')
    ].filter(Boolean);
  }

  /**
   * Collect the caster, the item's targeting rules, every aimed or caught target, and the scene size. Returns null
   * when the caster isn't a Character on a Scene, the Item isn't one of its activation items, or an aimed token has
   * no Actor or stands on another Scene. Returns `{unsupported}` when the Item's targeting can't be derived.
   */
  async getSnapshot(intent) {
    const sourceToken = await resolveToken(intent.sourceTokenUuid);
    const actor = sourceToken?.actor;
    const scene = sourceToken?.parent;
    if (!actor || !scene || actor.type !== 'Character') return null;

    const item = await resolveItem(intent.itemUuid);
    if (!item || itemActor(item)?.uuid !== actor.uuid) return null;
    // One frozen copy serves both reads, which run in the same tick and so see the same Item.
    const itemFacts = frozenItemFacts(item);
    if (!isActivationItem(itemFacts)) return null;
    const envelope = deriveActivationEnvelope({
      item: itemFacts,
      ownerSystem: actor.system,
      ownerFreeTargeting: unitIgnoresLineOfSight(actor.flags?.[SYSTEM_ID])
    });
    if (envelope.ok !== true) return Object.freeze({ unsupported: true, code: envelope.code });

    const gridSize = Math.max(1, Number(scene.grid?.size) || 1);
    const redirects = activationRedirectsToGuarder({ subtype: item.system.itemType, targetType: envelope.targetType });
    const aimTargets = [];
    for (const uuid of intent.targetTokenUuids) {
      const aimed = await resolveToken(uuid);
      if (!aimed?.actor || aimed.parent !== scene) return null;
      const token = redirects ? redirectFoundryHostileToken(aimed) : aimed;
      if (aimTargets.some(target => target.tokenUuid === String(token.uuid ?? ''))) continue;
      aimTargets.push(projectActivationTarget(token, gridSize, { token: sourceToken, losRule: envelope.losRule }));
    }
    // Scene padding is always 0 (hooks/scene.mjs), so the map's size in squares is its pixel size over the grid size.
    const bounds = Object.freeze({
      columns: Math.ceil((Number(scene.width) || 0) / gridSize),
      rows: Math.ceil((Number(scene.height) || 0) / gridSize)
    });
    const source = projectActivationSource(sourceToken, item, gridSize);
    const units = projectTargetingBoard(scene)?.units ?? [];
    const geometry = await deriveActivationGeometry({
      scene, envelope, source, units, bounds, gridSize, aim: intent.aim, aimTargets, redirects
    });
    const targets = envelope.derivesTargets ? geometry.targets : aimTargets;
    const entries = projectActivationEntries(item);
    const distance = targets.length
      ? footprintDistance(sourceToken, targets[0], gridSize)
      : aimDistance(sourceToken, intent.aim, gridSize);
    const classicFlyers = worldClassicFlyerTargeting();
    const flightForbidden = projectFlightForbidden(scene);
    const engagement = resolveEngagement({
      distance,
      sourceElevation: source.elevation,
      targetElevation: targets.length ? targets[0].elevation : aimElevation(scene, intent.aim, source.elevation),
      sourceAirborne: source.airborne,
      targetAirborne: targets.length ? targets[0].airborne : false,
      targetStanceBroken: targets.length ? targets[0].stanceBroken : false,
      classicFlyers,
      flightForbidden
    });

    return Object.freeze({
      sceneUuid: String(scene.uuid ?? ''),
      gridSize,
      columns: bounds.columns,
      rows: bounds.rows,
      envelope,
      source,
      item: projectActivationItem(item, engagement, source, envelope),
      entries,
      guardBonds: await this.#guardBonds(entries, sourceToken, targets),
      passiveEntries: projectPassiveActivationEntries(actor),
      healEchoes: projectHealEchoPolicies(actor),
      units: Object.freeze(units),
      affinities: currentAffinityTable(),
      sight: geometry.sight,
      forcedMovementBoards: envelope.forcedMovement && aimTargets.length === 1
        ? this.movements?.getForcedMovementBoards?.(sourceToken.uuid, aimTargets[0].tokenUuid) ?? null
        : null,
      aimTargets: Object.freeze(aimTargets),
      targets: Object.freeze(targets),
      effectCells: Object.freeze([...geometry.effectCells]),
      distance,
      classicFlyers,
      flightForbidden,
      explorationActive: sceneExplorationActive(scene),
      experience: projectActivationExperience(actor, item, scene),
      fingerprint: activationFingerprint(sourceToken, item, targets)
    });
  }

  /**
   * The side, level and pools of units an item use's effect steps reached beyond its caster and targets, such as
   * the allies an area around the caster caught, for the experience award in engine/items/activation.mjs.
   * A unit that is gone by then is left out.
   */
  async getReachedUnits(actorUuids) {
    const units = [];
    for (const actorUuid of actorUuids) {
      const actor = await resolveActor(actorUuid);
      if (!actor) continue;
      const targetKind = resolveTargetKind({ documentType: actor.type, objectType: actor.system?.objectType });
      units.push(Object.freeze({
        actorUuid: String(actor.uuid ?? ''),
        actorType: String(actor.system?.faction?.role ?? 'Neutral'),
        objectTarget: targetKind === TARGET_KINDS.DESTRUCTIBLE,
        scenery: targetKind === TARGET_KINDS.SCENERY,
        ...projectExperienceFacts(actor.system)
      }));
    }
    return Object.freeze(units);
  }

  /**
   * Each target's Guard bond with the caster, as FoundryGuardBondRepository.sideOf describes both sides, when every
   * use of the Item reaches a Guard step. engine/items/activation.mjs refuses a bond that cannot form before it
   * writes anything.
   */
  async #guardBonds(entries, sourceToken, targets) {
    if (!this.guardBonds || !entriesAlwaysGuard(entries)) return Object.freeze([]);
    const guarder = this.guardBonds.sideOf(sourceToken);
    const bonds = [];
    for (const target of targets) {
      const guarded = this.guardBonds.sideOf(await resolveToken(target.tokenUuid));
      bonds.push(Object.freeze({ guarder, guarded }));
    }
    return Object.freeze(bonds);
  }

  /**
   * Whether the caster, the item and the targets are unchanged since getSnapshot read them (activationFingerprint).
   * deliverActivatedItem checks it before its first write and refuses an out-of-date use.
   */
  async stillCurrent(snapshot) {
    const token = await resolveToken(snapshot.source.tokenUuid);
    const item = await resolveItem(snapshot.envelope.itemUuid);
    if (!token?.actor || !item) return false;
    const targets = [];
    for (const target of snapshot.targets) {
      const targetToken = await resolveToken(target.tokenUuid);
      if (!targetToken?.actor) return false;
      targets.push(projectActivationTarget(targetToken, snapshot.gridSize));
    }
    return activationFingerprint(token, item, targets) === snapshot.fingerprint;
  }

  /** Build the checker that counts where a unit could stand, for items whose effects have placement requirements. */
  geometryResolver(snapshot) {
    return this.movements?.geometryResolver?.({
      sourceTokenUuid: snapshot.source.tokenUuid,
      effectRange: String(snapshot.envelope?.range?.maxRange ?? '')
    });
  }
}

/* -------------------------------------------- */
/*  Caster and targets                          */
/* -------------------------------------------- */

function projectActivationSource(token, item, gridSize) {
  const actor = token.actor;
  const system = actor.system ?? {};
  const turn = system.turn ?? {};
  const statuses = projectActorStatusKeys(actor);
  const position = persistedTokenPosition(token);
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    actorName: String(actor.name ?? token.name ?? 'Character'),
    actorImage: String(actor.img ?? token.texture?.src ?? 'icons/svg/mystery-man.svg'),
    avatarScale: resolveAvatarScale(system.art?.avatarScale),
    actorType: String(system.faction?.role ?? 'Neutral'),
    ...projectExperienceFacts(system),
    x: Math.floor(finite(position.x) / gridSize),
    y: Math.floor(finite(position.y) / gridSize),
    elevation: tokenTerrainElevation(token, gridSize),
    airborne: isAirborneActor(actor),
    landingBlocked: isAirborneActor(actor) && projectLandingBlocked(token),
    mounted: system.statuses?.mounted === true,
    mountsForbidden: mountsForbidden(normalizeMovementPermission(token.parent?.getFlag?.(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG))),
    attackTotal: String(system.stats?.atk?.total ?? '0'),
    footprint: Object.freeze({
      width: Math.max(1, Math.floor(finite(token.width) || 1)),
      height: Math.max(1, Math.floor(finite(token.height) || 1))
    }),
    standardAvailable: turn.actionAvailable !== false,
    bonusAvailable: turn.bonusActionAvailable !== false,
    // The items whose skill check failed this phase, and the unit's kept retractable use with what this item
    // remembers from a use taken back this turn.
    lockedItems: Object.freeze((turn.lockedItems ?? []).map(String)),
    retraction: activationRetraction(parseRetraction(turn.retraction), String(item.uuid ?? '')),
    turnOver: turn.actionAvailable === false && turn.bonusActionAvailable === false
      && turn.movementAvailable === false,
    magicBlocked: statuses.has('silenced') || system.statuses?.silenced === true,
    stanceAvailable: finite(system.resources?.stn?.value) > 0 || finite(system.resources?.stn?.max) <= 0,
    sanctuary: statuses.has('sanctuary') || system.statuses?.sanctuary === true,
    sanctuaryEffectId: sanctuaryEffectId(actor),
    attributes: projectAttributeTotals(system),
    progression: projectProgressionFacts(actor),
    skills: projectSkillRanks(system),
    blessed: statuses.has('blessed') || system.statuses?.blessed === true,
    support: projectActivationSupport(actor),
    proficiency: projectProficiency(actor, item),
    conditionSelf: projectFoundryCombatActorContext(actor),
    conditionItem: projectItemFacts(item)
  });
}

/** Whether the caster has a kept retractable use, and what this item remembers from a use taken back this turn. */
function activationRetraction(retraction, itemUuid) {
  return Object.freeze({ pending: Boolean(retraction?.pending), memory: retractionMemoryFor(retraction, itemUuid) });
}

/**
 * The caster's affinity, Support bonds, party and this map's Rally record (RALLY_RECORD_FLAG), which decide whom
 * its Rally reaches, how often, and what it grants.
 */
function projectActivationSupport(actor) {
  const support = actor._source?.system?.support ?? actor.system?.support ?? {};
  return Object.freeze({
    affinity: String(support.affinity ?? ''),
    partners: Object.freeze((support.partners ?? []).map(entry => Object.freeze({
      actorUUID: String(entry?.actorUUID ?? ''),
      rank: Number(entry?.rank)
    }))),
    partyId: projectActorPartyId(actor) ?? '',
    rallies: Object.freeze(normalizeRallyRecord(actor.flags?.[SYSTEM_ID]?.[RALLY_RECORD_FLAG])
      .map(entry => Object.freeze(entry)))
  });
}

function projectActivationTarget(token, gridSize, looker = null) {
  const actor = token.actor;
  const system = actor.system ?? {};
  const targetKind = resolveTargetKind({
    documentType: actor.type, objectType: system.objectType, hidden: token.hidden === true
  });
  const position = persistedTokenPosition(token);
  const x = Math.floor(finite(position.x) / gridSize);
  const y = Math.floor(finite(position.y) / gridSize);
  const width = Math.max(1, Math.floor(finite(position.width) || 1));
  const height = Math.max(1, Math.floor(finite(position.height) || 1));
  const cells = [];
  for (let dx = 0; dx < width; dx += 1) {
    for (let dy = 0; dy < height; dy += 1) cells.push(Object.freeze({ x: x + dx, y: y + dy }));
  }
  return Object.freeze({
    actorUuid: String(actor.uuid ?? ''),
    tokenUuid: String(token.uuid ?? ''),
    actorName: String(actor.name ?? token.name ?? 'Unit'),
    tokenName: String(token.name ?? actor.name ?? 'Unit'),
    actorImage: String(actor.img ?? token.texture?.src ?? 'icons/svg/mystery-man.svg'),
    avatarScale: resolveAvatarScale(system.art?.avatarScale),
    actorType: String(system.faction?.role ?? 'Neutral'),
    objectTarget: targetKind === TARGET_KINDS.DESTRUCTIBLE,
    scenery: targetKind === TARGET_KINDS.SCENERY,
    objectDestroyed: targetKind === TARGET_KINDS.DESTRUCTIBLE && (Number(system.resources?.stn?.value) || 0) <= 0,
    ...projectExperienceFacts(system),
    x,
    y,
    elevation: tokenTerrainElevation(token, gridSize),
    airborne: isAirborneActor(actor),
    stanceBroken: isStanceBrokenActor(actor),
    footprint: Object.freeze({ width, height }),
    cells: Object.freeze(cells),
    attributes: projectAttributeTotals(system),
    saveModifiers: projectSaveModifiers(system),
    willpowerRemaining: Math.max(0, Math.floor(finite(system.special?.willpower?.value))),
    magicSaveAdvantage: system.combat?.magicSaveAdvantage === true,
    blessed: projectActorStatusKeys(actor).has('blessed') || system.statuses?.blessed === true,
    sanctuary: projectActorStatusKeys(actor).has('sanctuary') || system.statuses?.sanctuary === true,
    // The base actor's id, so rallyRankFor can match a Support bond on an unlinked token, and the unit's party.
    baseActorId: String(actor.isToken ? (actor.token?.actorId ?? actor.id) : actor.id ?? ''),
    partyId: projectActorPartyId(actor) ?? '',
    rallied: [...(actor.effects ?? [])].some(effect => effect?.disabled !== true
      && Boolean(effect?.flags?.[SYSTEM_ID]?.rally)),
    wallBlocked: looker ? wallSightBlockedBetween(looker.token, token, gridSize, looker.losRule) : false,
    freeTargeting: token.getFlag?.(SYSTEM_ID, 'freeTargeting') === true,
    conditionSelf: projectFoundryCombatActorContext(actor)
  });
}

/**
 * Whether walls hide the target from the caster. A scene with walls this client cannot test counts as blocked, as
 * it does everywhere else in targeting.
 */
function wallSightBlockedBetween(source, target, gridSize, losRule = 'normal') {
  if (!source || String(losRule ?? 'normal') === 'ignoreLoS') return false;
  return testSceneWallCollision(source.parent,
    persistedTokenCenter(source, gridSize), persistedTokenCenter(target, gridSize)) !== false;
}

function projectActivationItem(item, engagement, source, envelope) {
  const system = item.system ?? {};
  return Object.freeze({
    uuid: String(item.uuid ?? ''),
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    img: String(item.img ?? ''),
    type: String(item.type ?? ''),
    subtype: String(system.itemType ?? ''),
    magical: isMagicItemDocument(item),
    params: Object.freeze((system.effectData?.params ?? []).map(param => Object.freeze({
      name: String(param?.name ?? ''),
      options: String(param?.options ?? ''),
      numeric: param?.numeric === true
    }))),
    activationAnimation: clone(selectActivationAnimation(item, engagement, source, envelope)),
    attackAnimation: clone(selectAnimationRange(system.anim?.attack, engagement)),
    skipCinematic: activationSkipsCinematic(item, engagement, source, envelope)
  });
}

/** Whether the activation animation tab that applies to this use has Skip cinematic ticked. */
function activationSkipsCinematic(item, engagement, source, envelope) {
  const slot = item.system?.anim?.activation;
  if (!isMountActivation(item)) {
    return animationSkipsCinematic(slot, engagement, { self: envelope?.selfTargeted === true });
  }
  const payload = mountActivationIntent(source) === 'dismount' ? slot?.ranged : slot?.melee;
  return payload?.skipCinematic === true;
}

/**
 * A self-use plays its self slot. A Mount plays its melee slot to mount and its ranged slot to dismount
 * (mountActivationIntent).
 */
function selectActivationAnimation(item, engagement, source, envelope) {
  const slot = item.system?.anim?.activation;
  if (!isMountActivation(item)) return selectAnimationRange(slot, engagement, { self: envelope?.selfTargeted === true });
  const payload = mountActivationIntent(source) === 'dismount' ? slot?.ranged : slot?.melee;
  return isPopulated(payload) ? payload : null;
}

/** The Item's activation entries. They share one frozen copy of the Item, read in this same synchronous pass. */
function projectActivationEntries(item) {
  const entries = [];
  let sourceItem = null;
  for (const entry of item.system?.effects ?? []) {
    if (!ITEM_ACTIVATION_TRIGGERS.includes(String(entry?.trigger ?? ''))) continue;
    sourceItem ??= frozenItemFacts(item);
    entries.push(Object.freeze({
      ...clone(entry),
      sourceItemUuid: String(item.uuid ?? ''),
      sourceItemName: String(item.name ?? ''),
      sourceItem
    }));
  }
  return Object.freeze(entries);
}

/** Every Passive's onUseItem entries. A Passive's entries share one frozen copy of it, read in this same pass. */
function projectPassiveActivationEntries(actor) {
  const entries = [];
  for (const item of collectionValues(actor.items)) {
    if (triggerGroupForItem({ type: item.type, itemType: item.system?.itemType }) !== 'C') continue;
    let sourceItem = null;
    for (const entry of item.system?.effects ?? []) {
      if (String(entry?.trigger ?? '') !== 'onUseItem') continue;
      sourceItem ??= frozenItemFacts(item);
      entries.push(Object.freeze({
        ...clone(entry),
        sourceItemUuid: String(item.uuid ?? ''),
        sourceItemName: String(item.name ?? ''),
        sourceItem
      }));
    }
  }
  return Object.freeze(entries);
}

/* -------------------------------------------- */
/*  Item and unit details                       */
/* -------------------------------------------- */

function projectItemFacts(item) {
  const system = clone(item?.system ?? {});
  // clone() copies the stored source through toObject(), which loses the conditional maximum the owner's stats set
  // during data prep. Put the prepared values back.
  if (system.uses && item?.system?.uses) {
    system.uses.max = item.system.uses.max;
    system.uses.current = item.system.uses.current;
  }
  return Object.freeze({
    uuid: String(item?.uuid ?? ''),
    id: String(item?.id ?? ''),
    name: String(item?.name ?? ''),
    img: String(item?.img ?? ''),
    image: String(item?.img ?? ''),
    type: String(item?.type ?? ''),
    // The innate grant the item came from, if any; this is how the targeting rules recognise Rally.
    innateGrant: String(item?.flags?.[SYSTEM_ID]?.[INNATE_GRANT_FLAG] ?? ''),
    system
  });
}

/**
 * projectItemFacts, frozen all the way down, for a copy several readers share. Nothing that reads item facts writes
 * into them; the freeze keeps it that way.
 */
function frozenItemFacts(item) {
  return deepFreeze(projectItemFacts(item));
}

/** Freeze a plain-data value and everything inside it. */
function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * A unit's level and its HP and Stance maxima, used to scale the experience an item use or a theft earns.
 */
export function projectExperienceFacts(system) {
  return {
    level: Math.max(1, Math.floor(finite(system?.progression?.level) || 1)),
    hpMax: Math.max(0, finite(system?.resources?.hp?.max)),
    stnMax: Math.max(0, finite(system?.resources?.stn?.max))
  };
}

/**
 * What the item-use experience award reads: the item's entry in the activation XP table, the id of the encounter
 * running on the scene (empty outside one and during exploration), and how many experience-granting uses of that
 * entry the caster has already made in it. A theft reads the same for the thief's Steal Ability.
 * @param {object} actor The caster Actor.
 * @param {{name: string}} item The Item whose name the entry is looked up by.
 * @param {object} scene The caster's Scene.
 * @returns {Readonly<object>}
 */
export function projectActivationExperience(actor, item, scene) {
  const combat = findSceneCombat(scene);
  const encounterId = combat?.started === true && !sceneExplorationActive(scene) ? String(combat.id ?? '') : '';
  const key = activationExperienceKey(item.name);
  const used = projectActivationExperienceUses(actor, encounterId).find(use => use.key === key);
  return Object.freeze({
    entry: activationExperienceEntry(item.name),
    key,
    encounterId,
    encounterRunning: encounterId !== '',
    usesThisEncounter: used?.count ?? 0
  });
}

/**
 * The caster's recorded activation XP uses in one encounter, as `{key, count}` rows. A record stamped with any other
 * encounter's id reads as no uses, which is how the count resets when an encounter ends.
 * FoundryItemActivationSettlement.recordExperienceUse writes the record.
 * @param {object|null} actor The caster Actor.
 * @param {string} encounterId The running encounter's Combat id.
 * @returns {Array<{key: string, count: number}>}
 */
export function projectActivationExperienceUses(actor, encounterId) {
  const record = actor?.flags?.[SYSTEM_ID]?.[ACTIVATION_EXPERIENCE_USES_FLAG];
  if (!encounterId || String(record?.encounterId ?? '') !== encounterId || !Array.isArray(record.uses)) return [];
  return record.uses
    .filter(use => typeof use?.key === 'string' && Number.isInteger(use.count) && use.count > 0)
    .map(use => ({ key: use.key, count: use.count }));
}

/** Each stat's earned base and class value, each growth's earned base and each cap's total, for planBoosterGains. */
function projectProgressionFacts(actor) {
  const stored = actor._source?.system ?? {};
  const prepared = actor.system ?? {};
  const stats = {};
  for (const key of Object.keys(prepared.stats ?? {})) {
    stats[key] = Object.freeze({ base: finite(stored.stats?.[key]?.base), class: finite(prepared.stats?.[key]?.class) });
  }
  const growth = {};
  for (const key of Object.keys(prepared.growth ?? {})) growth[key] = finite(stored.growth?.[key]?.base);
  const caps = {};
  for (const [key, node] of Object.entries(prepared.caps ?? {})) caps[key] = finite(node?.total ?? node?.base);
  return Object.freeze({ stats: Object.freeze(stats), growth: Object.freeze(growth), caps: Object.freeze(caps) });
}

/** Every stat total of one prepared unit, as the plain numbers a check is built from. */
export function projectAttributeTotals(system) {
  const totals = {};
  for (const [key, node] of Object.entries(system?.stats ?? {})) {
    totals[key] = finite(node?.total ?? node?.value);
  }
  return Object.freeze(totals);
}

/** A target's save modifiers, with the attributes its statuses withhold, as every save path reads them. */
function projectSaveModifiers(system) {
  return projectSavingThrowModifiers(system?.saves, system?.statuses);
}

/** Every skill rank of one prepared unit. */
export function projectSkillRanks(system) {
  const ranks = {};
  for (const [key, node] of Object.entries(system?.skills ?? {})) {
    ranks[key] = finite(node?.total ?? node?.value);
  }
  return Object.freeze(ranks);
}

function sanctuaryEffectId(actor) {
  const effect = collectionValues(actor?.effects).find(candidate => (
    normalizeStatusKey(candidate?.name ?? candidate?.label) === 'sanctuary'
  ));
  return String(effect?.id ?? '');
}

/**
 * What stillCurrent compares: the caster's square and turn state, the Item's uses, and each target's square.
 * Squares come from the stored Token position (persistedTokenPosition in host.mjs).
 */
function activationFingerprint(token, item, targets) {
  const position = persistedTokenPosition(token);
  return JSON.stringify({
    x: finite(position.x),
    y: finite(position.y),
    turn: token.actor?.system?.turn ?? {},
    uses: item.system?.uses ?? {},
    targets: targets.map(target => ({ uuid: target.tokenUuid, x: target.x, y: target.y }))
  });
}

/**
 * Squares across plus squares down from the caster's top-left square to the target's (at least 1), ignoring token
 * size. It only picks the cast animation and feeds the cast message; no rule reads it. aimDistance does the same
 * for an aimed square.
 */
function footprintDistance(source, target, gridSize) {
  const sourceX = Math.floor(finite(source.x) / gridSize);
  const sourceY = Math.floor(finite(source.y) / gridSize);
  return Math.max(1, Math.abs(target.x - sourceX) + Math.abs(target.y - sourceY));
}

function aimDistance(source, aim, gridSize) {
  if (!aim) return 0;
  const sourceX = Math.floor(finite(source.x) / gridSize);
  const sourceY = Math.floor(finite(source.y) / gridSize);
  return Math.abs(Number(aim.x) - sourceX) + Math.abs(Number(aim.y) - sourceY);
}

function aimElevation(scene, aim, fallback) {
  if (!aim) return fallback;
  return Number(readTerrainElevations(scene)[`${Number(aim.x)},${Number(aim.y)}`]) || 0;
}

function itemActor(item) {
  return item?.parent?.documentName === 'Actor' ? item.parent : null;
}

/* -------------------------------------------- */
/*  Targeting controls                          */
/* -------------------------------------------- */

/**
 * What a hotbar slot needs to decide whether an Item starts activation targeting. Returns null when
 * the Item can't be activated or its owner has no token on the canvas.
 */
export async function projectHotbarActivation(itemUuid) {
  const item = await resolveItem(itemUuid);
  const actor = itemActor(item);
  const token = actorControlledToken(actor);
  if (!item || !actor || !token) return null;
  const facts = projectItemFacts(item);
  if (!isActivationItem(facts)) return null;
  const envelope = deriveActivationEnvelope({
    item: facts,
    ownerSystem: actor.system,
    ownerFreeTargeting: unitIgnoresLineOfSight(actor.flags?.[SYSTEM_ID])
  });
  if (envelope.ok !== true) return null;
  const scene = token.parent;
  const gridSize = Math.max(1, Number(scene?.grid?.size) || 1);
  const source = projectActivationSource(token, item, gridSize);
  // Scene padding is always 0 (hooks/scene.mjs), so the map's size in squares is its pixel size over the grid size.
  const bounds = Object.freeze({
    columns: Math.ceil((Number(scene?.width) || 0) / gridSize),
    rows: Math.ceil((Number(scene?.height) || 0) / gridSize)
  });
  const units = projectTargetingBoard(scene)?.units ?? [];
  return Object.freeze({
    tokenUuid: String(token.uuid ?? ''),
    actorUuid: String(actor.uuid ?? ''),
    itemUuid: String(item.uuid ?? ''),
    itemId: String(item.id ?? ''),
    envelope,
    source,
    cinematicCategory: activationCinematicCategory(facts),
    gridColor: String(item.system?.effectData?.gridColor ?? ''),
    units: Object.freeze(units),
    sight: projectGridSight(scene, envelope, source, bounds, units),
    classicFlyers: worldClassicFlyerTargeting(),
    flightForbidden: projectFlightForbidden(scene),
    gridSize,
    columns: bounds.columns,
    rows: bounds.rows
  });
}

/**
 * The cells an aimed item use would cover, so the overlay draws the same cells the host client will use.
 * @param {object} context The targeting context built when targeting started.
 * @param {object} aim Aim cell.
 * @returns {Readonly<{ok: boolean, code: string, cells: ReadonlySet<string>, units: readonly object[]}>}
 */
export async function projectActivationAim(context, aim) {
  const scene = (await resolveToken(context.tokenUuid))?.parent ?? null;
  const bounds = { columns: context.columns, rows: context.rows };
  const request = {
    envelope: context.envelope,
    source: context.source,
    footprint: context.source.footprint,
    aim,
    ...bounds
  };
  const raw = activationAreaCells(request);
  if (!raw.ok) return Object.freeze({ ok: false, code: raw.code, cells: new Set(), units: Object.freeze([]) });
  const sight = projectSight(scene, {
    cells: raw.cells,
    centers: [`${raw.origin.x},${raw.origin.y}`],
    losRule: context.envelope.losRule,
    units: context.units
  });
  const area = deriveActivationArea({ ...request, sight });
  return Object.freeze({
    ok: area.ok,
    code: area.code,
    cells: area.cells,
    units: await projectCaughtUnits(context, area.cells)
  });
}

/**
 * The line a clicked target puts a line-shaped item use on, and the units it catches.
 * @param {object} context The targeting context built when targeting started.
 * @param {object} grid Current targeting grid.
 * @param {object} target The clicked unit's data.
 * @returns {Readonly<{ok: boolean, cells: ReadonlySet<string>, units: readonly object[]}>}
 */
export async function projectActivationRay(context, grid, target) {
  const ray = resolveActivationLine({
    envelope: context.envelope,
    source: context.source,
    footprint: context.source.footprint,
    targetCells: target?.cells,
    targetableKeys: grid?.targetableKeys,
    columns: context.columns,
    rows: context.rows
  });
  if (!ray) return Object.freeze({ ok: false, cells: new Set(), units: Object.freeze([]) });
  return Object.freeze({ ok: true, cells: ray.cells, units: await projectCaughtUnits(context, ray.cells) });
}

/**
 * The units an item's own area catches, with the details its confirm window shows.
 * @param {object} context The targeting context built when targeting started.
 * @param {ReadonlySet<string>} cells Cells the Item covers.
 * @returns {Promise<readonly object[]>}
 */
export async function projectCaughtUnits(context, cells) {
  const caught = deriveActivationTargets({
    envelope: context.envelope,
    cells,
    units: context.units,
    sourceFaction: context.source.actorType,
    sourceTokenUuid: context.source.tokenUuid
  });
  const targets = [];
  for (const unit of caught) {
    const token = await resolveToken(unit.tokenUuid);
    if (token?.actor) targets.push(projectActivationTarget(token, context.gridSize));
  }
  return Object.freeze(targets);
}

/* -------------------------------------------- */
/*  Sight and areas                             */
/* -------------------------------------------- */

async function deriveActivationGeometry({
  scene, envelope, source, units, bounds, gridSize, aim, aimTargets, redirects = false
}) {
  const request = { envelope, source, footprint: source.footprint, ...bounds };
  const gridSight = projectGridSight(scene, envelope, source, bounds, units);
  if (!envelope.derivesTargets) {
    return { sight: gridSight, targets: aimTargets, effectCells: new Set() };
  }

  let cells = new Set();
  let sight = gridSight;
  if (envelope.aimed) {
    const raw = activationAreaCells({ ...request, aim });
    if (raw.ok) {
      sight = projectSight(scene, {
        cells: raw.cells,
        centers: [`${raw.origin.x},${raw.origin.y}`],
        losRule: envelope.losRule,
        units
      });
      cells = deriveActivationArea({ ...request, aim, sight }).cells;
    }
  } else if (envelope.areaWide) {
    cells = buildActivationTargetingGrid({ ...request, sight: gridSight }).targetableKeys;
  } else {
    const grid = buildActivationTargetingGrid({ ...request, sight: gridSight });
    const ray = resolveActivationLine({
      ...request, targetCells: aimTargets[0]?.cells, targetableKeys: grid.targetableKeys
    });
    cells = ray?.cells ?? new Set();
  }

  const caught = deriveActivationTargets({
    envelope,
    cells,
    units,
    sourceFaction: source.actorType,
    sourceTokenUuid: source.tokenUuid
  });
  const targets = [];
  for (const unit of caught) {
    const found = await resolveToken(unit.tokenUuid);
    const token = found?.actor && redirects ? redirectFoundryHostileToken(found) : found;
    if (!token?.actor || targets.some(target => target.tokenUuid === String(token.uuid ?? ''))) continue;
    targets.push(projectActivationTarget(token, gridSize));
  }
  return { sight: gridSight, targets, effectCells: envelope.aimed ? cells : new Set() };
}

function projectGridSight(scene, envelope, source, bounds, units) {
  const cells = activationCoverage({
    envelope, source, footprint: source.footprint, columns: bounds.columns, rows: bounds.rows
  });
  return projectSight(scene, {
    cells,
    centers: footprintCellKeys(source, source.footprint),
    losRule: envelope.losRule,
    ground: envelope.groundPlacement === true,
    units
  });
}

/** Rebuild the targeting grid data after anything on the map changes. */
export async function projectActivationGrid(context) {
  return projectHotbarActivation(context.itemUuid);
}

/** One clicked token's data for the item's reach check, after any fixture-click or Guard redirect. */
export async function projectActivationTargetFacts(context, targetToken) {
  const fixture = redirectFoundryFixtureToken(targetToken);
  if (fixture.refused) return null;
  const token = (fixture.redirected ? fixture.token : null) ?? targetToken?.document ?? targetToken;
  const uuid = String(token?.uuid ?? '');
  const aimed = await resolveToken(uuid);
  const redirects = activationRedirectsToGuarder({
    subtype: context?.source?.conditionItem?.system?.itemType, targetType: context?.envelope?.targetType
  });
  const resolved = aimed?.actor && redirects ? redirectFoundryHostileToken(aimed) : aimed;
  if (!resolved?.actor) return null;
  const scene = resolved.parent;
  const gridSize = Math.max(1, Number(scene?.grid?.size) || 1);
  const source = await resolveToken(context?.tokenUuid);
  return projectActivationTarget(resolved, gridSize, { token: source, losRule: context?.envelope?.losRule });
}

/**
 * What the confirm window shows, including each target's success rate.
 * @param {object} context The targeting context built when targeting started.
 * @param {object[]} targets Target data already checked against the grid.
 * @param {object|null} location The square the window centres on: a picked placement, else the aimed ground cell.
 * @returns {Readonly<object>|null}
 */
export function projectActivationPreview(context, targets, location = null) {
  const envelope = context.envelope;
  const item = context.source.conditionItem;
  const rows = targets.map(target => {
    const delivery = resolveActivationDelivery({
      envelope,
      sourceFaction: context.source.actorType,
      targetFaction: target.actorType,
      targetDestructible: target.objectTarget === true,
      hasTarget: true
    });
    return Object.freeze({
      name: target.actorName,
      img: target.actorImage,
      rallyBonuses: projectRallyPreview(context, target),
      delivery: delivery.kind,
      skillLabel: envelope.skillCheck?.skill ?? '',
      skillDc: delivery.kind === 'check'
        ? calculateSkillCheckDifficulty(
          target.attributes, envelope.skillCheck.base, envelope.skillCheck.targetAttribute
        ) : null,
      successRate: activationSuccessRate({
        kind: delivery.kind,
        autoSucceed: delivery.autoSucceed,
        autoFail: delivery.autoFail,
        successChance: declaredSuccessChance(context, envelope, target, delivery)
      })
    });
  });
  return Object.freeze({
    item: Object.freeze({
      name: String(item?.name ?? ''),
      img: String(item?.img ?? ''),
      usesType: String(item?.system?.uses?.type ?? 'limited'),
      usesCurrent: Number(item?.system?.uses?.current) || 0,
      usesMax: Number(item?.system?.uses?.max) || 0
    }),
    params: Object.freeze((item?.system?.effectData?.params ?? [])
      .filter(param => String(param?.options ?? '').trim())
      .map(param => Object.freeze({
        name: String(param.name ?? ''),
        options: Object.freeze(String(param.options).split(',').map(option => option.trim()).filter(Boolean))
      }))),
    targets: Object.freeze(rows),
    hasTokenTargets: rows.length > 0,
    isTargetArray: rows.length > 1,
    targetLocation: location,
    mount: projectMountPreview(context)
  });
}

/** The saddle confirmation a Mount shows instead of targets: its direction and the before-and-after stat table. */
function projectMountPreview(context) {
  if (context.envelope?.mount !== true) return null;
  const intent = mountActivationIntent(context.source);
  return Object.freeze({
    intent,
    header: intent === 'dismount' ? 'Confirm Dismount' : 'Confirm Mount',
    statChanges: buildMountStatChanges(context.source, context.source.conditionItem?.system?.mountData?.stats ?? {}, intent)
  });
}

/** What rallying this ally would grant, for the confirm window. */
function projectRallyPreview(context, target) {
  if (context.envelope.rally !== true) return null;
  const rank = rallyRankFor(rallyCasterFacts(context.source), {
    uuid: target.actorUuid, actorId: target.baseActorId, partyId: target.partyId
  });
  if (rank === null) return null;
  const table = currentAffinityTable();
  const bonuses = rallyStatBonuses(table, context.source.support?.affinity, rank);
  return bonuses ? Object.freeze(rallyStatRows(table, bonuses)) : null;
}

function declaredSuccessChance(context, envelope, target, delivery) {
  if (delivery.autoFail === true) return 0;
  if (delivery.kind === 'save') {
    return checkSuccessChance(buildSavingThrow({
      targetAttribute: envelope.savingThrow.targetAttribute,
      dc: calculateSavingThrowDifficulty(context.source.attributes, {
        base: envelope.savingThrow.base,
        attribute: envelope.savingThrow.attribute
      }),
      attributes: target.attributes,
      saveModifiers: target.saveModifiers,
      actorType: target.actorType,
      blessed: target.blessed,
      hasAdvantage: resolveSaveAdvantage({
        magicSaveAdvantage: target.magicSaveAdvantage,
        magical: isMagicItemDocument(context.source.conditionItem),
        willpowerRemaining: target.willpowerRemaining
      }).hasAdvantage
    }));
  }
  if (delivery.kind !== 'check') return 0;
  const skillKey = String(envelope.skillCheck.skill ?? '').toLowerCase();
  const skill = SKILL_BY_KEY[skillKey];
  if (!skill) return 0;
  return checkSuccessChance(buildSkillCheck({
    skillKey,
    mode: 'standard',
    dc: calculateSkillCheckDifficulty(
      target.attributes, envelope.skillCheck.base, envelope.skillCheck.targetAttribute
    ),
    rank: context.source.skills?.[skillKey],
    statValue: context.source.attributes?.[skill.stat],
    actorType: context.source.actorType,
    blessed: context.source.blessed
  }));
}

function actorControlledToken(actor) {
  const controlled = collectionValues(canvas?.tokens?.controlled)
    .find(token => token?.actor?.uuid === actor?.uuid);
  if (controlled?.document) return controlled.document;
  return collectionValues(canvas?.scene?.tokens).find(token => token?.actor?.uuid === actor?.uuid) ?? null;
}
