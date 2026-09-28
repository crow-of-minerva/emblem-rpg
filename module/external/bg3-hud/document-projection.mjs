/** @layer external/bg3-hud */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { TERRAIN_STAT_FLAGS } from '../../contracts/domains/terrain.mjs';
import { projectAuraContributionsFor } from '../../foundry/adapters/projections/board.mjs';
import {
  isAirborneActor,
  isStanceBrokenActor,
  projectFlightForbidden
} from '../../foundry/adapters/projections/combat-context.mjs';
import { encounterUnderway } from '../../foundry/adapters/projections/encounters.mjs';
import { COMBAT_STATS, CORE_STATS } from '../../game/character/rules.mjs';
import { counterModeLocked } from '../../game/character/counter-mode.mjs';
import {
  MOVE_SCALINGS,
  MOVE_SCALING_LABELS,
  UNIT_MOVE_SCALING_FLAG,
  normalizeMoveScaling,
  resolveMoveScalingDelta
} from '../../game/movement/input-policy.mjs';
import { pendingFeatureChoiceIds } from '../../game/classes/rules.mjs';
import { earnsCharacterExperience } from '../../game/progression/rules.mjs';
import { tradeActionAvailable } from '../../game/economy/trade.mjs';
import { STEAL_ABILITY_NAME } from '../../contracts/domains/economy.mjs';
import { CHARACTER_EXPERIENCE_THRESHOLD } from '../../contracts/domains/progression.mjs';
import { statModifierDeltas } from '../../game/character/modifier-deltas.mjs';
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';

const STATS = Object.freeze(['atk', 'brk', 'spd', 'acc', 'crit', 'eva', 'def', 'res']);
const STAT_LABELS = Object.freeze(Object.fromEntries(
  [...CORE_STATS, ...COMBAT_STATS].map(stat => [stat.key, stat.label])
));
const STAT_INFLUENCES = Object.freeze({
  atk: ['atk'], brk: ['brk'], spd: ['spd', 'agi', 'bld', 'mgt', 'wgt', 'wgtRed'], acc: ['acc', 'tqn'],
  crit: ['crit', 'wit'], eva: ['eva', 'agi', 'bld', 'mgt', 'wgt', 'wgtRed'], def: ['def'], res: ['res']
});

/* -------------------------------------------- */
/*  Document projections                        */
/* -------------------------------------------- */
/**
 * Turn an item into the cell data Core stores for a hotbar slot. The _emblem fields carry what the cell
 * decoration in presentation/interface/bg3-hud.mjs needs: item kind, equipped state and targeting colour.
 */
export function projectBg3Cell(item) {
  if (!item) return null;
  const current = Number(item.system?.uses?.current);
  const max = Number(item.getEffectiveMaxUses?.() ?? item.system?.uses?.max);
  const uses = Number.isFinite(max) && max > 0 ? { value: Number.isFinite(current) ? current : 0, max } : null;
  return Object.freeze({
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    type: 'Item',
    uses,
    depleted: Boolean(uses && uses.value <= 0),
    _emblemDocType: item.type,
    _emblemItemType: item.system?.itemType ?? '',
    _emblemActionType: item.system?.actionType ?? '',
    _emblemWeaponReq: item.system?.weapon?.req ?? '',
    _emblemIsWielded: item.system?.isWielded === true,
    _emblemIsWorn: item.system?.isWorn === true,
    _emblemIsEquipped: item.system?.isEquipped === true,
    _emblemIsActiveItem: item.actor?.activeItem?.uuid === item.uuid,
    _emblemActiveColorName: activeTargetingColorName(item),
    _emblemIsActiveWepArt: item.actor?.getFlag?.(SYSTEM_ID, 'activeWeaponArt') === item.id
  });
}

/** Name the targeting-grid colour the item would draw: null for a Self item, and '' when no colour is set. */
function activeTargetingColorName(item) {
  if (item.type === 'Ability' && String(item.name ?? '') === STEAL_ABILITY_NAME) return 'Orange';
  if (item.system?.itemType === 'Weapon Art') return 'Purple';
  const effect = item.system?.effectData ?? {};
  if (effect.targetType === 'Self') return null;
  return String(effect.gridColor ?? '');
}

/**
 * Rebuild a stored cell from its item before the adapter decorates it, so presentation gets plain data and never
 * the item. Cells that already carry the _emblem fields, Macros and cells with no uuid pass through unchanged.
 */
export async function hydrateBg3Cell(cellData) {
  if (!cellData || cellData._emblemDocType !== undefined || !cellData.uuid || cellData.type === 'Macro') return cellData;
  const document = await fromUuid(cellData.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'document'); return null; });
  return document ? projectBg3Cell(document) : cellData;
}

/**
 * Collect what decorateEmblemBg3Hud (presentation/interface/bg3-hud.mjs) needs to style the HUD for its current
 * actor: read-only state, the active item, a copy of the actor's system data, the rows that explain each stat's
 * modifier, the Ascend/Land button's facts and the counterattack toggle's. init/system.mjs pairs the two in
 * decorateHud. The result is plain frozen data, never the live actor, and decorateEmblemBg3Hud keeps parts of it
 * between refreshes.
 * @param {object} app The BG3 HUD application.
 * @param {object} [ports] `characterSource(actor)` yields the compile source the stat baseline is measured from.
 */
export function projectBg3HudView(app, ports = {}) {
  const actor = app?.currentActor;
  const multiSelect = (globalThis.canvas?.tokens?.controlled ?? []).length > 1;
  if (!actor) return Object.freeze({ actor: null, activeItem: null, multiSelect, readOnly: false, counterMode: null });
  const auras = projectHudAuraContributions(app);
  const deltas = measureHudStatDeltas(actor, ports.characterSource);
  const readOnly = app?._viewOnlyInspect === true || actor.isOwner !== true;
  return Object.freeze({
    multiSelect,
    readOnly,
    turn: Object.freeze({ tradeAvailable: tradeActionAvailable(actor.system?.turn) }),
    activeItem: actor.activeItem?.uuid ? Object.freeze({
      uuid: String(actor.activeItem.uuid),
      cellId: String(actor.activeItemCell ?? ''),
      colorName: activeTargetingColorName(actor.activeItem)
    }) : null,
    actor: Object.freeze({
      system: foundry.utils.deepClone(actor.system ?? {}),
      modifierDeltas: deltas,
      modifierRows: Object.freeze(Object.fromEntries(
        STATS.map(key => [key, projectBg3ModifierRows(actor, key, auras, deltas ? deltas[key] ?? 0 : undefined)])
      ))
    }),
    flight: projectHudFlight(actor, (app?.currentToken?.document ?? app?.currentToken)?.parent),
    counterMode: readOnly || multiSelect ? null : projectHudCounterMode(actor)
  });
}

/** How far each stat sits from the unit's own build (statModifierDeltas). null when no characterSource was given. */
function measureHudStatDeltas(actor, characterSource) {
  if (typeof characterSource !== 'function') return null;
  try {
    return statModifierDeltas(characterSource(actor), STATS) ?? Object.freeze({});
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Stat modifier measurement failed');
    return null;
  }
}

/** The nameplate's level, class and experience facts, or null for a unit with none of them to show. */
export function projectBg3Progression(actor) {
  const rawLevel = actor?.system?.progression?.level;
  const level = rawLevel === undefined || rawLevel === null ? null : Number(rawLevel) || 1;
  const classItem = [...(actor?.items ?? [])].find(item => item.type === 'Class') ?? null;
  const trimmed = String(classItem?.name ?? '').trim();
  const className = trimmed && trimmed !== '--' ? trimmed : '';
  const progressing = earnsCharacterExperience(actor?.system?.faction?.role);
  if (level === null && !className && !progressing) return null;
  const experience = Number(actor?.system?.progression?.experience) || 0;
  const experienceMax = Number(actor?.system?.progression?.experienceThreshold) || CHARACTER_EXPERIENCE_THRESHOLD;
  return {
    level,
    className,
    classImage: className ? String(classItem?.img ?? '') : '',
    progressing,
    experience,
    experienceMax,
    experiencePercent: Math.max(0, Math.min(100, (experience / experienceMax) * 100)),
    pendingChoices: projectBg3PendingFeatureChoices(actor)
  };
}

/** The feature bundles the player still has to choose from at this level, each with its class's uuid. */
function projectBg3PendingFeatureChoices(actor) {
  if (actor?.type !== 'Character') return [];
  const actorLevel = Number(actor.system?.progression?.level) || 0;
  const choices = actor.flags?.[SYSTEM_ID]?.classChoices ?? {};
  const actorItems = [...(actor.items ?? [])].map(item => ({
    id: item.id, uuid: item.uuid, name: item.name, type: item.type,
    sourceId: String(item.flags?.core?.sourceId ?? '')
  }));
  const pending = [];
  for (const classItem of actor.items ?? []) {
    if (classItem.type !== 'Class') continue;
    const ids = pendingFeatureChoiceIds({
      bundles: classItem.system?.features ?? [],
      actorItems,
      actorLevel,
      recordedBundles: choices[classItem.id] ?? {}
    });
    for (const bundleId of ids) {
      pending.push(Object.freeze({ classUuid: String(classItem.uuid), bundleId }));
    }
  }
  return pending;
}

/**
 * What the Ascend/Land button needs: whether the unit can fly (a flier that isn't levitating), whether it's
 * airborne, and what would stop a take-off, including whether its token's scene forbids flight.
 */
function projectHudFlight(actor, scene) {
  const flying = actor.system?.unitType?.flying === true;
  return Object.freeze({
    canFly: flying && actor.system?.combat?.levitation !== true,
    airborne: isAirborneActor(actor),
    actionAvailable: actor.system?.turn?.actionAvailable !== false,
    stanceBroken: isStanceBrokenActor(actor),
    flightForbidden: projectFlightForbidden(scene)
  });
}

/**
 * The swords and dove toggle's facts: whether the unit never counterattacks (`system.pacifist`), and whether this
 * user may no longer change that (counterModeLocked in game/character/counter-mode.mjs). null for a unit other than
 * a Character, which has no toggle.
 */
function projectHudCounterMode(actor) {
  if (actor.type !== 'Character') return null;
  return Object.freeze({
    pacifist: actor.system?.pacifist === true,
    locked: counterModeLocked({
      gm: game.user.isGM === true,
      encounterActive: encounterUnderway(),
      turn: actor.system?.turn
    })
  });
}

/** The auras reaching the HUD's unit, read from the Scene its Token stands on rather than the one this client shows. */
function projectHudAuraContributions(app) {
  const tokenDocument = app?.currentToken?.document ?? app?.currentToken ?? null;
  const tokenUuid = String(tokenDocument?.uuid ?? '');
  if (!tokenUuid) return [];
  try {
    return projectAuraContributionsFor(tokenDocument);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Aura attribution failed');
    return [];
  }
}

/**
 * The item a wield or armor marker stands for, looked up on the marker's own actor by the item id its origin ends
 * with. The origin's actor part is ignored because a unit imported from a compendium keeps origins that still name
 * the compendium copy.
 */
export function equipmentMarkerItem(effect) {
  const parts = String(effect?.origin ?? '').split('.');
  const index = parts.lastIndexOf('Item');
  const itemId = index >= 0 ? parts[index + 1] : '';
  return itemId ? effect?.parent?.items?.get?.(itemId) ?? null : null;
}

/** Plain tooltip data for an item or effect. A wield or armor marker shows its item's tooltip instead. */
export async function projectBg3Tooltip(document) {
  if (!document) return null;
  if (document.documentName === 'ActiveEffect') {
    const linked = document.flags?.[SYSTEM_ID]?.isWieldEffect || document.flags?.[SYSTEM_ID]?.isArmorEffect;
    const source = linked ? equipmentMarkerItem(document) : null;
    if (source) return projectBg3Tooltip(source);
  }
  return {
    documentName: String(document.documentName ?? ''),
    name: String(document.name ?? document.label ?? ''),
    label: String(document.label ?? ''),
    type: String(document.type ?? ''),
    description: String(document.description ?? ''),
    system: foundry.utils.deepClone(document.system ?? {}),
    flags: foundry.utils.deepClone(document.flags ?? {})
  };
}

/* -------------------------------------------- */
/*  Modifier projections                        */
/* -------------------------------------------- */
/**
 * The rows that explain one displayed stat: direct contributions first, and the indirect ones (acting through an
 * attribute the stat derives from) only when the direct rows do not account for the measured delta. Without a
 * measurement every influencing row is listed, and a measured zero lists nothing.
 */
function projectBg3ModifierRows(actor, statKey, auraContributions = [], delta = undefined) {
  if (delta === 0) return Object.freeze([]);
  const influences = STAT_INFLUENCES[statKey] ?? [statKey];
  const candidates = [];
  const terrain = Number(actor?.flags?.[SYSTEM_ID]?.[TERRAIN_STAT_FLAGS[statKey]]) || 0;
  if (terrain) candidates.push({ key: statKey, row: { type: 'terrain', source: 'Terrain', value: terrain, via: null } });
  for (const contribution of auraContributions) {
    const key = String(contribution.target ?? '').split('.')[1] ?? '';
    if (!influences.includes(key)) continue;
    candidates.push({ key, row: Object.freeze({
      type: 'aura',
      source: contribution.itemName || contribution.modifierName || 'Aura',
      value: contribution.value,
      via: key === statKey ? null : statLabel(key),
      icon: contribution.sourceSprite || 'icons/svg/mystery-man.svg',
      uuid: contribution.itemUuid || null,
      actorUuid: contribution.sourceActorUuid || null,
      actorName: contribution.sourceActorName || ''
    }) });
  }
  for (const effect of actor?.effects ?? []) {
    if (effect?.active === false || effect?.disabled === true) continue;
    for (const contribution of effectContributions(effect)) {
      if (!influences.includes(contribution.key)) continue;
      candidates.push({ key: contribution.key, row: Object.freeze({
        type: 'effect', source: effect.name || effect.label || 'Effect', value: contribution.value,
        via: contribution.key === statKey ? null : statLabel(contribution.key),
        icon: effect.img || 'icons/svg/mystery-man.svg', uuid: effect.uuid || null
      }) });
    }
  }
  const scaling = normalizeMoveScaling(actor?.flags?.[SYSTEM_ID]?.[UNIT_MOVE_SCALING_FLAG]);
  if (statKey === 'mov' && scaling !== MOVE_SCALINGS.NONE) {
    const others = candidates.filter(candidate => candidate.key === statKey)
      .reduce((sum, candidate) => sum + candidate.row.value, 0);
    const value = typeof delta === 'number' ? delta - others : resolveMoveScalingDelta(scaling, {
      total: Number(actor?.system?.stats?.mov?.total) || 0, mounted: actor?.system?.statuses?.mounted === true
    });
    if (value) {
      candidates.push({ key: statKey, row: Object.freeze({
        type: 'terrain', source: `Move Scaling: ${MOVE_SCALING_LABELS[scaling]}`, value, via: null
      }) });
    }
  }
  const direct = candidates.filter(candidate => candidate.key === statKey);
  const accounted = direct.reduce((sum, candidate) => sum + candidate.row.value, 0);
  const explained = typeof delta === 'number' && accounted === delta;
  const chosen = explained ? direct : [...direct, ...candidates.filter(candidate => candidate.key !== statKey)];
  return Object.freeze(chosen.map(candidate => candidate.row));
}

function effectContributions(effect) {
  const contributions = [];
  for (const change of effect?.changes ?? []) {
    const match = String(change?.key ?? '').match(/^system\.stats\.([^.]+)\.(?:mod|total|base|aura|penalty)$/);
    if (!match || (change?.type !== undefined ? change.type !== 'add' : ![undefined, 'add', 2].includes(change?.mode))) continue;
    const value = Number(change.value);
    if (Number.isFinite(value) && value !== 0) contributions.push({ key: match[1], value });
  }
  for (const [key, raw] of Object.entries(effect?.flags?.[SYSTEM_ID]?.rally?.stats ?? {})) {
    const value = Number(raw);
    if (Number.isFinite(value) && value !== 0) contributions.push({ key, value });
  }
  return contributions;
}

function statLabel(key) {
  const text = String(key ?? '');
  return STAT_LABELS[text] ?? (text ? text[0].toUpperCase() + text.slice(1) : '');
}
