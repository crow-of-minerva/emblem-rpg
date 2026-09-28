/** @layer foundry/adapters/projections */
import {
  ALL_UNIT_TYPE_KEYS,
  COMBAT_FLAG_KEYS,
  GROWTH_KEYS,
  PROFICIENCIES,
  SAVE_KEYS,
  SKILLS,
  STATS,
  STATUS_KEYS,
  UNIT_TYPE_KEYS
} from '../../../contracts/domains/characters.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { TERRAIN_STAT_FLAGS } from '../../../contracts/domains/terrain.mjs';
import { GUARD_BOND_EFFECT_NAME, GUARD_BOND_ROLES } from '../../../contracts/domains/combat.mjs';
import { DIFFICULTY_SETTING } from '../../../config/settings.mjs';
import { compileCharacterData } from '../../../game/character/compilation.mjs';
import { AURA_ATTRIBUTE_PATHS } from '../../../game/effects/auras.mjs';
import { DEFAULT_DIFFICULTY, resolveAvatarScale } from '../../../game/character/rules.mjs';
import { projectEquipmentStats } from '../../../game/items/rules.mjs';
import { UNIT_MOVE_SCALING_FLAG, normalizeMoveScaling } from '../../../game/movement/input-policy.mjs';
import {
  isAttackItem, projectCharacterTurn, projectUnitFacts, projectUnitSize, projectWeapon as projectWeaponFacts,
  projectWieldedArmament, sharedItemCopy
} from './combat-context.mjs';
import { wieldTakesOffShield } from '../../../game/character/inventory.mjs';
import { clone, isAdditiveEffectChange, isStanceBreakEffect, readSetting } from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Promotion preview                           */
/* -------------------------------------------- */

/**
 * Build the promotion facts shared by the preview and class-feature writer: requirements, target Classes and art.
 * `gains` holds each growth stat's level-up gains and `caps` each growth cap's total and class part, because the
 * preview's bars compare gains plus class base against the current and promoted class caps. The writer checks the
 * preview fingerprint before committing.
 * @param {string} actorUuid Unit being promoted.
 * @param {{usedItemId?: string, tokenUuid?: string}} [options]
 * @returns {Promise<Readonly<object>|null>}
 */
export async function projectPromotionPreview(actorUuid, { usedItemId = '', tokenUuid = '' } = {}) {
  const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
  if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') return null;
  const classItem = [...actor.items].find(item => item.type === 'Class') ?? null;
  const usedItem = usedItemId ? actor.items.get(usedItemId) ?? null : null;
  const named = tokenUuid ? await fromUuid(tokenUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'named'); return null; }) : null;
  const token = named?.documentName === 'Token' && named.actor?.uuid === actor.uuid ? named : null;
  const snapshot = {
    actorUuid: actor.uuid,
    actorName: String(actor.name ?? ''),
    actorImage: String(actor.img ?? ''),
    avatarScale: resolveAvatarScale(actor.system.art.avatarScale),
    tokenUuid: String(token?.uuid ?? ''),
    tokenForeign: Boolean(named) && !token,
    tokenImage: String(token?.texture?.src ?? actor.prototypeToken?.texture?.src ?? actor.img ?? ''),
    tokenSize: Math.max(Number(token?.width) || 1, Number(token?.height) || 1),
    actorLevel: Number(actor.system.progression.level) || 1,
    turnOver: actor.system.turn.actionAvailable === false && actor.system.turn.movementAvailable === false,
    movementPlanning: actor.system.turn.movementPlanning === true,
    encounterRunning: Boolean(token?.parent && findSceneCombat(token.parent)?.started === true),
    proficiencies: Object.fromEntries(Object.entries(actor.system.prof).map(([key, node]) => [key, {
      total: Number(node.total) || 0, base: Number(node.base) || 0, passive: Number(node.passive) || 0
    }])),
    skills: Object.fromEntries(
      Object.entries(actor.system.skills).map(([key, node]) => [key, Number(node.total) || 0])
    ),
    gains: Object.fromEntries(GROWTH_KEYS.map(key => [
      key, Number(actor.system.stats[key === 'hp' ? 'hpMax' : key].base) || 0
    ])),
    caps: Object.fromEntries(GROWTH_KEYS.map(key => [key, {
      total: Number(actor.system.caps[key].total) || 0,
      class: Number(actor.system.caps[key].class) || 0
    }])),
    classItem: classItem ? await projectClass(classItem) : null,
    usedItem: usedItem ? projectUsedItem(usedItem) : null,
    art: {
      tokens: clone(actor.system.art.tokens),
      tokenScales: clone(actor.system.art.tokenScales),
      tabs: clone(actor.system.art.tabs)
    },
    targetClasses: Object.freeze(await projectPromotionTargets(classItem))
  };
  return Object.freeze({ ...snapshot, fingerprint: classStateFingerprint(actor) });
}

/**
 * A fingerprint of the unit's level, stored items and class choices. The class-feature writer
 * (document-writes/class-features.mjs) puts it in each snapshot so a stale plan is refused. Derived values are left
 * out, so a change that writes nothing doesn't invalidate the plan.
 */
export function classStateFingerprint(actor) {
  return JSON.stringify({
    level: Number(actor.system?.progression?.level) || 1,
    items: [...actor.items].map(item => ({
      id: item.id,
      uuid: item.uuid,
      name: item.name,
      type: item.type,
      sourceId: String(item.flags?.core?.sourceId ?? ''),
      system: item._source?.system ?? item.system
    })),
    choices: actor.flags?.[SYSTEM_ID]?.classChoices ?? {}
  });
}

/* -------------------------------------------- */
/*  Class projection                            */
/* -------------------------------------------- */

/** Every Class a path points at, resolved once per uuid however many paths name it. */
async function projectPromotionTargets(classItem) {
  const targets = {};
  for (const promotion of classItem?.system?.promotions ?? []) {
    const uuid = String(promotion.classUuid ?? '');
    if (!uuid || targets[uuid]) continue;
    const target = await fromUuid(uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'target'); return null; });
    if (target?.documentName === 'Item' && target.type === 'Class') targets[uuid] = await projectClass(target);
  }
  return targets;
}

/** A Class as the promotion rules read it: its stats, ranks, paths and the Mount its bundles would grant. */
async function projectClass(classItem) {
  const system = classItem.system;
  return Object.freeze({
    id: classItem.id,
    uuid: classItem.uuid,
    name: String(classItem.name ?? ''),
    baseStats: clone(system.baseStats),
    baseCaps: clone(system.baseCaps),
    proficiencies: clone(system.proficiencies),
    promotions: clone(Array.from(system.promotions)),
    mount: await projectClassMount(system)
  });
}

/**
 * The first Mount any of a Class's bundles would hand out, because that Mount changes the promoted silhouette.
 * Its image is the Mount Ability's own, which ui/apps/menus/promote-app.mjs shows on the preview's mount chip.
 */
async function projectClassMount(system) {
  for (const bundle of system.features) {
    for (const ref of bundle.items) {
      if (!ref.uuid) continue;
      const feature = await fromUuid(ref.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'feature'); return null; });
      if (feature?.type !== 'Ability' || feature.system.itemType !== 'Mount') continue;
      return Object.freeze({
        name: String(feature.name ?? ''),
        img: String(feature.img ?? ''),
        stats: clone(feature.system.mountData.stats),
        unitTypes: clone(feature.system.mountData.unitTypes)
      });
    }
  }
  return null;
}

/* -------------------------------------------- */
/*  Projection helpers                          */
/* -------------------------------------------- */

function projectUsedItem(item) {
  return Object.freeze({
    id: item.id,
    uuid: item.uuid,
    name: String(item.name ?? ''),
    sourceId: String(item.flags?.core?.sourceId ?? ''),
    compendiumSource: String(item._stats?.compendiumSource ?? ''),
    uses: Object.freeze({
      type: String(item.system?.uses?.type ?? ''),
      current: Number(item.system?.uses?.current) || 0
    })
  });
}

function findSceneCombat(scene) {
  return [...(game.combats ?? [])].find(combat => combat?.scene === scene || combat?.scene?.id === scene?.id) ?? null;
}

/* -------------------------------------------- */
/*  Compiler source projection                  */
/* -------------------------------------------- */
const MAGE_ARMOR_EFFECT_NAME = 'MageArmor';
const PROTECTION_CHANGE_KEY = /^system\.equipment\.(prots|vulns|imms)\.([^.]+)$/;

/**
 * The input compileCharacterData reads for one Character, built from its stored data and its effects. Chance
 * modifiers use the draws passed in or the ones an action installed on the actor, and ordinary preparation has none.
 * A borrowed Armament is added as a wielded weapon. Called by Character preparation
 * (data-models/actor/character.mjs), FoundryActorRepository, the BG3 HUD and compileCharacterAs below.
 * @param {{chanceRolls?: object|null}} [options]
 * @returns {object}
 */
export function projectCharacterSource(actor, { chanceRolls = null } = {}) {
  const source = actor._source?.system ?? actor.system ?? {};
  const effects = applicableEffects(actor);
  const armament = projectWieldedArmament(actor)?.weapon ?? null;
  const items = armament ? [...actor.items, armament] : [...actor.items];
  return {
    id: actor.id ?? null,
    uuid: actor.uuid ?? '',
    name: actor.name ?? '',
    system: {
      stats: pickStats(source.stats),
      growth: pickNodes(source.growth, GROWTH_KEYS, ['base', 'mod', 'penalty', 'aura']),
      caps: pickNodes(source.caps, GROWTH_KEYS, ['base', 'mod', 'penalty', 'aura']),
      skills: pickNodes(source.skills, SKILLS.map(entry => entry.key), ['base', 'xp']),
      prof: pickNodes(source.prof, PROFICIENCIES.map(entry => entry.key),
        ['base', 'xp', 'maxE', 'maxD', 'maxC', 'maxB', 'maxA', 'maxS']),
      innateUnitType: Object.fromEntries(UNIT_TYPE_KEYS.map(key => [key, source.innateUnitType?.[key] === true])),
      resources: {
        hp: { value: source.resources?.hp?.value },
        stn: { value: source.resources?.stn?.value },
        energy: { value: source.resources?.energy?.value, mod: source.resources?.energy?.mod },
        shields: { value: source.resources?.shields?.value }
      },
      statuses: { grounded: source.statuses?.grounded === true },
      faction: { role: source.faction?.role ?? 'Neutral' },
      progression: {
        level: source.progression?.level,
        experience: source.progression?.experience,
        maxLevel: source.progression?.maxLevel,
        experienceThreshold: source.progression?.experienceThreshold
      },
      support: source.support ?? { affinity: '', partners: [] },
      special: source.special ?? {},
      turn: projectCharacterTurn(actor, source.turn)
    },
    items: items.map(projectItem),
    terrainModifiers: projectTerrainModifiers(actor),
    moveScaling: projectMoveScaling(actor),
    rallyModifiers: projectRallyModifiers(effects),
    effectModifiers: projectEffectModifiers(effects),
    effectStatuses: projectEffectStatuses(actor),
    effectCombatFlags: projectEffectCombatFlags(actor, effects),
    statusKeys: [...collectStatusKeys(actor)],
    effectUnitTypes: projectEffectUnitTypes(effects),
    protectionOverrides: projectProtectionOverrides(effects),
    mageArmor: activeEffects(effects).some(effect => effect?.name === MAGE_ARMOR_EFFECT_NAME),
    statuses: { stanceBreak: [...(actor.effects ?? [])].some(isStanceBreakEffect) },
    difficulty: worldDifficulty(),
    modifierContext: {
      chanceRolls: chanceRolls ?? actor.modifierChanceRolls ?? undefined,
      activeItemId: actor.activeItem?.id ?? null,
      activeItem: projectContextItem(actor.activeItem),
      wieldedItem: projectContextItem(armament ?? [...actor.items].find(item => item.system?.isWielded === true) ?? null),
      target: projectUnitFacts(actor.myTarget),
      combatDistance: Number(actor.combatDistance) || 0,
      combatEngagement: String(actor.combatEngagement ?? ''),
      combatInMeleeRange: typeof actor.combatInMeleeRange === 'boolean' ? actor.combatInMeleeRange : null,
      isAttacking: actor.isAttacking === true,
      isDefending: actor.isDefending === true,
      isUsingWeaponArt: actor.isUsingWeaponArt === true,
      size: projectUnitSize(actor)
    }
  };
}

/* -------------------------------------------- */
/*  Projection helpers                          */
/* -------------------------------------------- */

function pickStats(source) {
  return Object.fromEntries(STATS.map(entry => {
    const node = source?.[entry.key] ?? {};
    return [entry.key, {
      base: node.base, mod: node.mod, penalty: node.penalty, aura: node.aura
    }];
  }));
}

function pickNodes(source, keys, fields) {
  return Object.fromEntries(keys.map(key => {
    const node = source?.[key] ?? {};
    return [key, Object.fromEntries(fields.map(field => [field, node?.[field]]))];
  }));
}

/** The world difficulty key, read as Normal until the setting is registered. */
function worldDifficulty() {
  try {
    return String(readSetting(DIFFICULTY_SETTING, DEFAULT_DIFFICULTY));
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'worldDifficulty');
    return DEFAULT_DIFFICULTY;
  }
}

/** Read the terrain modifiers the Scene last settled onto this Actor. */
function projectTerrainModifiers(actor) {
  const flags = actor._source?.flags?.[SYSTEM_ID] ?? actor.flags?.[SYSTEM_ID] ?? {};
  return Object.fromEntries(Object.entries(TERRAIN_STAT_FLAGS)
    .map(([stat, flag]) => [stat, Number(flags?.[flag]) || 0]));
}

/** Read the map scaling the board last settled onto this Actor. */
function projectMoveScaling(actor) {
  const flags = actor._source?.flags?.[SYSTEM_ID] ?? actor.flags?.[SYSTEM_ID] ?? {};
  return normalizeMoveScaling(flags?.[UNIT_MOVE_SCALING_FLAG]);
}

/** The stat bonuses of the first active Rally effect a unit carries, or null when it has none. */
function projectRallyModifiers(effects) {
  for (const effect of effects ?? []) {
    if (effect?.active === false || effect?.disabled === true) continue;
    const stats = effect?.flags?.[SYSTEM_ID]?.rally?.stats;
    if (!stats) continue;
    return Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value)]));
  }
  return null;
}

/**
 * The additive changes of active effects that land on values the Character compiler owns: stat `mod`, `penalty`
 * and `aura` leaves, and saves. Preparation rebuilds those from the compiled result, which would overwrite a change
 * Foundry applied to the actor directly, so applyEffectModifiers in compileCharacterData adds these back.
 */
function projectEffectModifiers(effects) {
  const projected = [];
  for (const effect of activeEffects(effects)) {
    for (const change of effect?.changes ?? []) {
      const target = String(change?.key ?? '');
      if (!isCompiledEffectTarget(target)) continue;
      if (!isAdditiveEffectChange(change)) continue;
      const value = Number(change?.value);
      if (!Number.isFinite(value) || value === 0) continue;
      projected.push({
        effectId: String(effect.id ?? ''),
        effectName: String(effect.name ?? effect.label ?? 'Effect'),
        target,
        value
      });
    }
  }
  return projected;
}

/** Whether an effect change key names a stat leaf or a save the compiler owns. */
function isCompiledEffectTarget(target) {
  if (/^system\.stats\.[^.]+\.(?:mod|penalty|aura)$/.test(target)) return true;
  const save = /^system\.saves\.([^.]+)$/.exec(target);
  return Boolean(save) && SAVE_KEYS.includes(save[1]);
}

/**
 * Every status the unit carries, from its effects' status ids and names and from `system.statuses` effect changes.
 * The guarder in a Guard bond also gets `guarding`.
 * @returns {Record<string, boolean>}
 */
function projectEffectStatuses(actor) {
  const raised = {};
  const normalized = collectStatusKeys(actor);
  for (const effect of activeEffects(actor?.effects)) {
    if (effect?.name === GUARD_BOND_EFFECT_NAME && effect?.flags?.[SYSTEM_ID]?.guardRole === GUARD_BOND_ROLES.GUARDER) {
      raised.guarding = true;
    }
    for (const change of effect?.changes ?? []) {
      const match = /^system\.statuses\.([^.]+)$/.exec(String(change?.key ?? ''));
      if (match && STATUS_KEYS.includes(match[1]) && changeIsTruthy(change)) raised[match[1]] = true;
    }
  }
  for (const key of STATUS_KEYS) {
    if (normalized.has(normalizeKey(key))) raised[key] = true;
  }
  return raised;
}

/**
 * Combat flags raised by effects, from `system.combat` changes and from status ids or effect names that name a
 * flag. A `false` never clears a flag another source granted.
 * @param {Actor} actor The unit.
 * @param {Iterable<ActiveEffect>} effects Effects to read, including the ones items transfer.
 * @returns {Record<string, boolean>}
 */
function projectEffectCombatFlags(actor, effects) {
  const raised = {};
  for (const effect of activeEffects(effects)) {
    for (const change of effect?.changes ?? []) {
      const match = /^system\.combat\.([^.]+)$/.exec(String(change?.key ?? ''));
      if (match && COMBAT_FLAG_KEYS.includes(match[1]) && changeIsTruthy(change)) raised[match[1]] = true;
    }
  }
  const normalized = collectStatusKeys(actor);
  for (const key of COMBAT_FLAG_KEYS) {
    if (normalized.has(normalizeKey(key))) raised[key] = true;
  }
  return raised;
}

/**
 * Every status id and effect name the unit carries, normalized. The compiler hands these to `buildUnitFacts` as the
 * unit's own `statuses`, the list a status condition on one of its modifiers checks.
 * @returns {Set<string>}
 */
function collectStatusKeys(actor) {
  const normalized = new Set();
  for (const effect of activeEffects(actor?.effects)) {
    for (const status of collection(effect?.statuses)) normalized.add(normalizeKey(status));
    normalized.add(normalizeKey(effect?.name ?? effect?.label));
  }
  for (const status of collection(actor?.statuses)) normalized.add(normalizeKey(status));
  normalized.delete('');
  return normalized;
}

/** The protection, vulnerability and immunity changes of active effects, with the priority that settles a clash. */
function projectProtectionOverrides(effects) {
  const overrides = [];
  for (const effect of activeEffects(effects)) {
    for (const change of effect?.changes ?? []) {
      const match = PROTECTION_CHANGE_KEY.exec(String(change?.key ?? ''));
      if (!match) continue;
      overrides.push({ group: match[1], type: match[2], value: change.value, priority: Number(change.priority) || 0 });
    }
  }
  return overrides;
}

/** Unit types granted by effects. A `false` never removes a type another source granted. */
function projectEffectUnitTypes(effects) {
  const granted = {};
  for (const effect of activeEffects(effects)) {
    for (const change of effect?.changes ?? []) {
      const match = /^system\.unitType\.([^.]+)$/.exec(String(change?.key ?? ''));
      if (match && ALL_UNIT_TYPE_KEYS.includes(match[1]) && changeIsTruthy(change)) granted[match[1]] = true;
    }
  }
  return granted;
}

/** The unit's effects in application order: armor first, then the rest, then the effects its items transfer. */
function applicableEffects(actor) {
  return typeof actor?.allApplicableEffects === 'function'
    ? [...actor.allApplicableEffects()]
    : [...(actor?.effects ?? [])];
}

function activeEffects(effects) {
  const out = [];
  for (const effect of effects ?? []) {
    if (effect?.active === false || effect?.disabled === true) continue;
    out.push(effect);
  }
  return out;
}

function changeIsTruthy(change) {
  const value = change?.value;
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collection(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.contents)) return value.contents;
  if (typeof value[Symbol.iterator] === 'function') return [...value];
  return [];
}

/** An Item as a compile's modifier context carries it, with its own copy of the prepared system data. */
function projectContextItem(item) {
  if (!item) return null;
  const prepared = sharedItemCopy(item, 'prepared', () => item.system?.toObject?.(false) ?? item.system ?? {});
  return {
    id: item.id ?? null,
    uuid: item.uuid ?? null,
    name: item.name ?? '',
    type: item.type ?? '',
    system: structuredClone(prepared)
  };
}

function copyRecord(value) {
  return { ...(value ?? {}) };
}

function projectWeapon(source) {
  const weapon = source.weapon ?? {};
  return {
    req: weapon.req ?? 'None',
    rank: weapon.rank ?? 0,
    twoHanded: weapon.twoHanded === true,
    atkStat: weapon.atkStat ?? '',
    effectiveAgainst: copyRecord(weapon.effectiveAgainst),
    breaker: copyRecord(weapon.breaker),
    dmgTypes: copyRecord(weapon.dmgTypes),
    atk: weapon.atk,
    brk: weapon.brk,
    rng: weapon.rng,
    acc: weapon.acc,
    crit: weapon.crit,
    extraAttacks: weapon.extraAttacks,
    noExtraAttacks: weapon.noExtraAttacks === true
  };
}

function projectArmor(source) {
  const armor = source.armor ?? {};
  return {
    req: armor.req ?? 'None',
    def: armor.def,
    res: armor.res,
    stn: armor.stn,
    eva: armor.eva,
    brkRed: armor.brkRed ?? armor.brkReduction,
    critRed: armor.critRed ?? armor.critReduction,
    vulns: copyRecord(armor.vulns),
    prots: copyRecord(armor.prots)
  };
}

/**
 * Project one carried Item for compileCharacterData from its persisted data. An Equipment copy's refinement tier and
 * armor breakage are applied through projectEquipmentStats, so combat reads the stats the Item sheet shows.
 */
function projectItem(item) {
  const stored = item._source?.system ?? item.system ?? {};
  const source = { ...stored, ...projectEquipmentStats({ documentType: item.type, system: stored }) };
  const projected = {
    id: item.id,
    uuid: item.uuid ?? null,
    name: item.name ?? '',
    type: item.type,
    itemType: source.itemType || item.system?.itemType || '',
    innateGrant: Boolean(item.flags?.[SYSTEM_ID]?.innateGrant),
    stealableFlag: String(source.stealable?.flag ?? ''),
    stealableDc: Number(source.stealable?.dc) || 0,
    isWielded: source.isWielded === true,
    isWorn: source.isWorn === true,
    isEquipped: source.isEquipped === true,
    wgt: source.wgt,
    weapon: projectWeapon(source),
    armor: projectArmor(source),
    modifiers: (source.modifiers ?? []).map(modifier => ({
      name: modifier.name,
      target: modifier.target,
      quantity: modifier.quantity,
      conditionTree: modifier.conditionTree,
      requiresEquipped: modifier.requiresEquipped === true,
      requiresActivation: modifier.requiresActivation === true,
      stackable: modifier.stackable === true,
      kind: modifier.kind,
      targetType: modifier.targetType
    })),
    mountData: {
      stats: copyRecord(source.mountData?.stats),
      unitTypes: copyRecord(source.mountData?.unitTypes)
    }
  };
  if (item.type === 'Class') {
    projected.classData = {
      tier: source.tier,
      baseStats: copyRecord(source.baseStats),
      baseGrowths: copyRecord(source.baseGrowths),
      baseCaps: copyRecord(source.baseCaps),
      proficiencies: copyRecord(source.proficiencies),
      skills: copyRecord(source.skills),
      unitType: copyRecord(source.unitType)
    };
  }
  return projected;
}

/**
 * Compile a unit as it would be in a what-if situation, without writing anything: another weapon in hand, a given
 * opponent, distance and side, and optionally the ground of a square it is considering. The threat, measurement and
 * loadout projections in attack-targeting.mjs use it, and so does the inspection tooltip's attack preview
 * (tokens.mjs).
 * @param {Actor} actor The unit.
 * @param {object} [matchup] The wielded item id, the unit it fights as `target`, the combat distance, whether the two
 *   stand in melee range, the side, the Weapon Art it strikes through as `activeItem` (the wielded weapon when none
 *   is named), and optionally the `terrainModifiers` and `auraFields` of a square the unit is only considering,
 *   which replace the ones it currently carries.
 * @returns {object} The compiled result, shaped as the compiler shapes it.
 */
export function compileCharacterAs(actor, matchup = {}) {
  const projected = projectCharacterSource(actor);
  applyHypotheticalGround(projected, matchup);
  const wieldedItemId = matchup.wieldedItemId ?? null;
  if (wieldedItemId !== null) {
    const wieldable = new Set(['Weapon', 'Staff', 'Attack']);
    for (const item of projected.items) {
      if (wieldable.has(item.itemType)) item.isWielded = String(item.id) === String(wieldedItemId);
    }
  }
  const wielded = projected.items.find(item => item.isWielded) ?? null;
  const wieldedDocument = !wielded ? null
    : wielded.type === 'Object' ? projectWieldedArmament(actor)?.weapon ?? null
      : actor.items?.get?.(wielded.id) ?? null;
  const activeItem = matchup.activeItem ?? wieldedDocument;
  projected.modifierContext = {
    ...projected.modifierContext,
    activeItemId: activeItem?.id ?? null,
    activeItem: projectContextItem(activeItem),
    wieldedItem: projectContextItem(wieldedDocument),
    target: projectUnitFacts(matchup.target ?? null),
    combatDistance: Number(matchup.combatDistance) || 0,
    combatEngagement: String(matchup.combatEngagement ?? ''),
    combatInMeleeRange: typeof matchup.inMeleeRange === 'boolean' ? matchup.inMeleeRange : null,
    isAttacking: matchup.isAttacking === true,
    isDefending: matchup.isDefending === true,
    isUsingWeaponArt: activeItem?.system?.itemType === 'Weapon Art'
  };
  return compileCharacterData(projected);
}

/**
 * The weapons a unit could switch to in the Combat Preview (projectFoundryCombatPreview in attack-targeting.mjs):
 * every attack Item it carries. Each carries as `range` the reach it would have in the unit's hands in `matchup`,
 * compiled by compileCharacterAs with that weapon wielded, and `shieldBlocked` when wielding it would take off the
 * equipped shield, which the preview shows but won't let the player pick.
 * @param {Actor} actor The unit.
 * @param {string} heldId The weapon in hand.
 * @param {object} [matchup] compileCharacterAs's matchup, naming the Weapon Art in use as `activeItem`.
 * @returns {object[]} projectWeapon's facts (combat-context.mjs) for each weapon.
 */
export function projectWeaponChoicesAs(actor, heldId, matchup = {}) {
  const items = [...(actor.items ?? [])];
  return items.filter(isAttackItem).map(item => {
    const { stats } = compileCharacterAs(actor, { ...matchup, wieldedItemId: item.id });
    return {
      ...projectWeaponFacts(null, item),
      range: projectWeaponFacts(actor, item, { stats }).range,
      shieldBlocked: item.id !== heldId && wieldTakesOffShield(items, item)
    };
  });
}

/**
 * Swap in the terrain and aura values of the square being considered. Every aura field is overwritten, with 0
 * where the square gets nothing, so an aura that can't reach that square doesn't carry over into the measurement.
 */
function applyHypotheticalGround(projected, matchup) {
  if (matchup.terrainModifiers) {
    projected.terrainModifiers = Object.fromEntries(Object.keys(TERRAIN_STAT_FLAGS)
      .map(stat => [stat, Number(matchup.terrainModifiers[stat]) || 0]));
  }
  if (!matchup.auraFields) return;
  for (const path of AURA_ATTRIBUTE_PATHS) {
    const [container, key] = path.split('.');
    projected.system[container][key].aura = Number(matchup.auraFields[path]) || 0;
  }
}
