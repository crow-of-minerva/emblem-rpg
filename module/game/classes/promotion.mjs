/** @layer game/classes */
import {
  PROMOTION_BAR_COLUMNS,
  PROMOTION_BAR_LABELS,
  PROMOTION_BAR_MAXIMA,
  PROMOTION_PROFICIENCY_KEYS,
  PROMOTION_STAT_KEYS,
  PROMOTION_UNAVAILABLE_REASONS
} from '../../contracts/domains/progression.mjs';
import { GROWTH_KEYS, SKILLS } from '../../contracts/domains/characters.mjs';
import { capitalize } from '../../lib/dom/html.mjs';
import { finite as number } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Promotion vocabulary                        */
/* -------------------------------------------- */
const PROFICIENCY_LABELS = Object.freeze({
  brawling: 'Brawling', blade: 'Blade', polearm: 'Polearm', heavy: 'Heavy', bow: 'Bow', covert: 'Covert',
  elemental: 'Elemental', divine: 'Divine', occult: 'Occult', arcane: 'Arcane', riding: 'Riding', armor: 'Armor'
});
const SLOT_FALLBACK_CHAINS = Object.freeze({
  armoredCavalry: ['armoredCavalry', 'cavalry', 'armored', 'default'],
  cavalry: ['cavalry', 'default'],
  flying: ['flying', 'default'],
  armored: ['armored', 'default'],
  default: ['default']
});
const UTILITY_PROFICIENCIES = Object.freeze(['riding', 'armor']);
const UTILITY_DISPLAY = Object.freeze({
  riding: Object.freeze({
    0: ['prof-riding-off.png', 'None'], 1: ['prof-riding-on.png', 'Horseback Riding'], 2: ['prof-flying-on.png', 'Aerial Riding']
  }),
  armor: Object.freeze({
    0: ['prof-armor-off.png', 'None'], 1: ['prof-armor-l.png', 'Light Armor'],
    2: ['prof-armor-m.png', 'Medium Armor'], 3: ['prof-armor-h.png', 'Heavy Armor']
  })
});
const MOUNT_STAT_LABELS = Object.freeze({
  mov: 'Mov', hp: 'HP', stn: 'Stn', eva: 'Eva', atk: 'Atk', spd: 'Spd', acc: 'Acc', crit: 'Crit'
});
const MOUNT_UNIT_LABELS = Object.freeze({
  cavalry: 'Cavalry', flying: 'Flying', dragon: 'Dragon', beast: 'Beast', monster: 'Monstrosity', undead: 'Undead'
});
const DEFAULT_PREVIEW_IMAGE = 'icons/svg/mystery-man.svg';

/* -------------------------------------------- */
/*  Promotion paths                             */
/* -------------------------------------------- */
/**
 * Every promotion path of the unit's Class, for the promotion window (ui/apps/menus/promote-app.mjs) and
 * engine/character/progression.mjs. Blocked paths stay listed with their missing requirements, and `refusal` says
 * why none can be taken. A GM-driven promotion can skip the item requirement (`bypassItem`), and the GM Macros
 * compendium's Promote Unit skips every requirement (`bypassRequirements`).
 * @param {object} snapshot A detached copy of the unit's promotion data.
 * @param {{bypassItem?: boolean, bypassRequirements?: boolean}} [options]
 * @returns {Readonly<{options: object[], available: object[], refusal: string|null}>}
 */
export function resolvePromotionOptions(snapshot, { bypassItem = false, bypassRequirements = false } = {}) {
  const actorLevel = Math.max(1, number(snapshot.actorLevel) || 1);
  const classItem = snapshot.classItem ?? null;
  const promotions = classItem?.promotions ?? [];
  if (!classItem) return frozenResolution([], `${snapshot.actorName ?? 'That unit'} has no Class to promote from.`);
  if (!promotions.length) return frozenResolution([], `${snapshot.actorName}'s Class has no promotions.`);
  const options = promotions.map(promotion =>
    promotionOption(promotion, snapshot, actorLevel, bypassItem || bypassRequirements, bypassRequirements));
  const available = options.filter(option => option.selectable);
  if (available.length) return frozenResolution(options, null, available);
  return frozenResolution(options, promotionRefusal(options, snapshot, actorLevel, bypassItem), available);
}

function frozenResolution(options, refusal, available = []) {
  return Object.freeze({ options: Object.freeze(options), available: Object.freeze(available), refusal });
}

function promotionOption(promotion, snapshot, actorLevel, bypassItem, bypassRequirements = false) {
  const requiredLevel = Math.max(1, number(promotion.lvl) || 1);
  const meetsLevelReq = actorLevel >= requiredLevel;
  const proficiencyReqs = PROMOTION_PROFICIENCY_KEYS.map(key => requirementRow(
    PROFICIENCY_LABELS[key], promotion.proficiencies?.[key], snapshot.proficiencies?.[key]?.total
  ));
  const skillReqs = SKILLS.map(({ key }) => requirementRow(
    capitalize(key), promotion.skills?.[key], snapshot.skills?.[key]
  ));
  const meetsProfReqs = proficiencyReqs.every(row => row.met);
  const meetsSkillReqs = skillReqs.every(row => row.met);
  const meetsRequirements = meetsLevelReq && meetsProfReqs && meetsSkillReqs;
  const promotionItem = promotion.promotionItem ?? {};
  const hasPromoItem = Boolean(promotionItem.uuid || promotionItem.name);
  const itemMatches = hasPromoItem && usedItemMatches(snapshot.usedItem, promotionItem);
  const selectable = bypassRequirements || (bypassItem ? meetsRequirements : meetsRequirements && itemMatches);
  const target = snapshot.targetClasses?.[promotion.classUuid] ?? null;
  const baseStats = target?.baseStats ?? {};
  const classProficiencies = target?.proficiencies ?? {};
  return Object.freeze({
    id: String(promotion._id ?? ''),
    requiredLevel,
    classUuid: String(promotion.classUuid ?? ''),
    className: target?.name || promotion.className || 'Unknown Class',
    classImg: promotion.classImg || 'icons/svg/item-bag.svg',
    meetsRequirements,
    meetsLevelReq,
    meetsProfReqs,
    meetsSkillReqs,
    itemMatches,
    selectable,
    unavailableReason: unavailableReason({ bypassItem, meetsRequirements, hasPromoItem, itemMatches, promotionItem }),
    proficiencyReqs: Object.freeze(proficiencyReqs),
    skillReqs: Object.freeze(skillReqs),
    baseStats: Object.freeze({ ...baseStats }),
    baseCaps: Object.freeze({ ...(target?.baseCaps ?? {}) }),
    classProficiencies: Object.freeze({ ...classProficiencies }),
    promotedProficiencies: promotedProficiencies(snapshot.proficiencies ?? {}, classProficiencies),
    mount: mountSummary(target?.mount ?? null),
    capabilities: classCapabilities(classProficiencies, Boolean(target?.mount))
  });
}

function requirementRow(name, requiredValue, actorValue) {
  const required = number(requiredValue);
  const actor = number(actorValue);
  return Object.freeze({ name, required, actorValue: actor, met: required <= 0 || actor >= required });
}

function unavailableReason({ bypassItem, meetsRequirements, hasPromoItem, itemMatches, promotionItem }) {
  if (bypassItem) return meetsRequirements ? '' : PROMOTION_UNAVAILABLE_REASONS.REQUIREMENTS;
  if (!hasPromoItem) return PROMOTION_UNAVAILABLE_REASONS.NO_ITEM;
  if (!itemMatches) return `Only available with ${promotionItem.name || 'a different item'}`;
  return meetsRequirements ? '' : PROMOTION_UNAVAILABLE_REASONS.REQUIREMENTS;
}

/** Whether the item a unit used is the one a path designates, by uuid, by the source it was copied from, or by name. */
function usedItemMatches(usedItem, ref) {
  if (!usedItem || (!ref?.uuid && !ref?.name)) return false;
  const refUuid = String(ref.uuid ?? '');
  if (refUuid && [usedItem.uuid, usedItem.compendiumSource].includes(refUuid)) return true;
  const refName = normal(ref.name);
  return Boolean(refName) && normal(usedItem.name) === refName;
}

/**
 * The proficiency ranks a unit would hold in the new class. Weapon ranks are its own earned and passive ranks plus
 * the new class's grant. Riding becomes 2 for a flying class, at least 1 for a riding class, and otherwise stays at
 * the current total. Armor is the new class's grant alone.
 */
function promotedProficiencies(actorProficiencies, classProficiencies) {
  const promoted = {};
  for (const key of PROMOTION_PROFICIENCY_KEYS) {
    const node = actorProficiencies[key] ?? {};
    promoted[key] = Math.max(0, number(node.base) + number(node.passive) + number(classProficiencies[key]));
  }
  const riding = number(actorProficiencies.riding?.total);
  if (classProficiencies.flying) promoted.riding = 2;
  else if (classProficiencies.riding) promoted.riding = Math.max(1, riding);
  else promoted.riding = riding;
  promoted.armor = number(classProficiencies.armor);
  return Object.freeze(promoted);
}

/** The ranks a unit holds today, in the same shape the promoted side is compared against. */
export function currentProficiencies(actorProficiencies) {
  const current = {};
  for (const key of [...PROMOTION_PROFICIENCY_KEYS, ...UTILITY_PROFICIENCIES]) {
    current[key] = number(actorProficiencies[key]?.total);
  }
  return Object.freeze(current);
}

/** The unmet requirements of one path, worded as the refusal message lists them. */
function promotionShortfalls(option, actorLevel) {
  const parts = [];
  if (!option.meetsLevelReq) parts.push(`Level ${option.requiredLevel} (has ${actorLevel})`);
  for (const row of [...option.proficiencyReqs, ...option.skillReqs]) {
    if (row.required > 0 && !row.met) parts.push(`${row.name} ${row.required} (has ${row.actorValue})`);
  }
  return parts;
}

function promotionRefusal(options, snapshot, actorLevel, bypassItem) {
  const reachable = options.filter(option => bypassItem || option.itemMatches);
  if (reachable.length) {
    const detail = reachable
      .map(option => `${option.className} (needs ${promotionShortfalls(option, actorLevel).join(', ') || 'unmet requirements'})`)
      .join(' | ');
    return `${snapshot.actorName} does not yet qualify to promote: ${detail}.`;
  }
  const itemName = snapshot.usedItem?.name ? `"${snapshot.usedItem.name}"` : 'that item';
  return `${snapshot.actorName} has no promotion for ${itemName}.`;
}

/* -------------------------------------------- */
/*  Preview art                                 */
/* -------------------------------------------- */
/** The three capabilities that decide which art slot a class is shown in. */
function classCapabilities(classProficiencies, hasMount) {
  return Object.freeze({
    hasMount: hasMount === true,
    hasFlying: Boolean(classProficiencies?.flying),
    hasHeavyArmor: number(classProficiencies?.armor) === 3
  });
}

/** The art slot that best represents a class, ordered by how much each capability changes the silhouette. */
function chooseClassSlot({ hasMount, hasFlying, hasHeavyArmor }) {
  if (hasMount && hasHeavyArmor) return 'armoredCavalry';
  if (hasMount) return 'cavalry';
  if (hasFlying) return 'flying';
  if (hasHeavyArmor) return 'armored';
  return 'default';
}

/**
 * Preview art for a class in the promotion window (ui/apps/menus/promote-app.mjs), from that class's own art slots.
 * The actor's default token is used only with allowGlobalFallback, because it shows the current class, not the
 * promotion target.
 * @param {object} art The actor's art model: `tokens`, `tokenScales`, `tabs`.
 * @param {string} className Class to preview.
 * @param {object} capabilities That class's capabilities.
 * @param {string} fallbackImage Image of last resort.
 * @param {{allowGlobalFallback?: boolean}} [options]
 * @returns {{img: string, scale: number}}
 */
export function resolveClassPreviewArt(art, className, capabilities, fallbackImage, { allowGlobalFallback = false } = {}) {
  const chain = SLOT_FALLBACK_CHAINS[chooseClassSlot(capabilities)] ?? ['default'];
  const tab = findClassTab(art?.tabs, className);
  if (tab?.tokens) {
    for (const slot of chain) {
      const path = tab.tokens[slot];
      if (path) return { img: path, scale: slotScale(tab.tokenScales, slot) };
    }
  }
  if (allowGlobalFallback && art?.tokens?.default) {
    return { img: art.tokens.default, scale: slotScale(art?.tokenScales, 'default') };
  }
  return { img: fallbackImage || DEFAULT_PREVIEW_IMAGE, scale: 1 };
}

function findClassTab(tabs, className) {
  const key = normal(className);
  if (!key) return null;
  return (tabs ?? []).find(tab => normal(tab?.name) === key) ?? null;
}

function slotScale(scales, slot) {
  const value = number(scales?.[slot]);
  return value > 0 ? value : 1;
}

/* -------------------------------------------- */
/*  Preview rows                                */
/* -------------------------------------------- */
/** Riding and armor as icon rows, since a rank number says nothing about what kind of mount or armor it means. */
export function utilityProficiencyRows(proficiencies) {
  return UTILITY_PROFICIENCIES.map(key => {
    const value = number(proficiencies?.[key]);
    const { icon, label } = utilityProficiencyDisplay(key, value);
    return { key, value, icon, label, none: value === 0 };
  });
}

/** The icon and label for one utility proficiency rank. */
function utilityProficiencyDisplay(kind, value) {
  const table = UTILITY_DISPLAY[kind];
  const [icon, label] = table?.[value] ?? table?.[0] ?? ['', ''];
  return { icon, label };
}

/** A mount's contribution as stats and unit types, with zero stats dropped so the grid lists only what changes. */
export function mountSummary(mount) {
  if (!mount) return Object.freeze({ has: false, name: '', stats: Object.freeze([]), unitTypes: Object.freeze([]) });
  const stats = Object.entries(MOUNT_STAT_LABELS)
    .map(([key, label]) => Object.freeze({ label, value: number(mount.stats?.[key]) }))
    .filter(stat => stat.value !== 0);
  const unitTypes = Object.entries(MOUNT_UNIT_LABELS)
    .filter(([key]) => mount.unitTypes?.[key] === true)
    .map(([, label]) => label);
  return Object.freeze({ has: true, name: String(mount.name ?? ''), stats: Object.freeze(stats), unitTypes: Object.freeze(unitTypes) });
}

/**
 * The old and new class base stats for the stat screen shown after a promotion (PROMOTION_STATS in
 * engine/character/progression.mjs). Personal stat caps don't apply here, so `zenith` is always false.
 */
export function promotionStatResults(oldBaseStats, newBaseStats) {
  return Object.freeze(Object.fromEntries(PROMOTION_STAT_KEYS.map(key => {
    const oldValue = number(oldBaseStats?.[key]);
    const newValue = number(newBaseStats?.[key]);
    return [key, Object.freeze({ oldValue, newValue, increased: newValue > oldValue, zenith: false })];
  })));
}

/**
 * Plan promotion-item consumption for engine/character/progression.mjs: spend one use while more than one is left,
 * otherwise remove the item. An Infinite-use item is always removed.
 */
export function planPromotionItemConsumption(item) {
  if (!item) return null;
  const uses = item.uses ?? {};
  if (uses.type !== 'infinite' && number(uses.current) > 1) {
    return { itemId: item.id, remove: false, usesCurrent: number(uses.current) - 1 };
  }
  return { itemId: item.id, remove: true, usesCurrent: 0 };
}

/* -------------------------------------------- */
/*  Preview bars                                */
/* -------------------------------------------- */
/**
 * The bar rows the promotion window draws for one path: gains + class base now and after, the mount's bonus, and
 * the class caps before and after, each as a value and as a fraction of the stat's fixed ceiling.
 * ui/apps/menus/promote-app.mjs repaints its bars from these rows whenever the chosen path changes.
 * @param {object} snapshot The unit's promotion data (gains, caps, classItem).
 * @param {object} option One resolved path from resolvePromotionOptions (baseStats, baseCaps, mount).
 * @returns {{left: object[], right: object[]}}
 */
export function promotionBarRows(snapshot, option) {
  const rows = keys => keys.map(key => promotionBarRow(key, snapshot, option));
  return { left: rows(PROMOTION_BAR_COLUMNS.left), right: rows(PROMOTION_BAR_COLUMNS.right) };
}

/**
 * One stat's bar. Only the growth stats carry level-up gains and caps. A promotion swaps the class part of a cap
 * and keeps every other part.
 */
function promotionBarRow(key, snapshot, option) {
  const max = PROMOTION_BAR_MAXIMA[key];
  const capped = GROWTH_KEYS.includes(key);
  const gains = capped ? number(snapshot.gains[key]) : 0;
  const now = gains + number(snapshot.classItem.baseStats[key]);
  const after = gains + number(option.baseStats[key]);
  const mount = mountBonus(option.mount, key);
  const cap = snapshot.caps[key];
  const capNow = capped ? number(cap.total) : 0;
  const capNew = capped ? capNow - number(cap.class) + number(option.baseCaps[key]) : 0;
  return {
    key, label: PROMOTION_BAR_LABELS[key], max, capped, now, after, delta: after - now, mount, capNow, capNew,
    nowPct: barFraction(now, max),
    afterPct: barFraction(after, max),
    mountedPct: barFraction(after + mount, max),
    capNowPct: barFraction(capNow, max),
    capNewPct: barFraction(capNew, max)
  };
}

/** A path's mount bonus to one stat, read back from mountSummary's rows through MOUNT_STAT_LABELS. */
function mountBonus(summary, key) {
  const label = MOUNT_STAT_LABELS[key];
  if (!label) return 0;
  return number(summary.stats.find(stat => stat.label === label)?.value);
}

/** A value as a share of its bar's ceiling, clamped to the bar and rounded to four places for the CSS widths. */
function barFraction(value, max) {
  if (!(max > 0)) return 0;
  return Math.round(Math.min(1, Math.max(0, value / max)) * 10000) / 10000;
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
function normal(value) {
  return String(value ?? '').trim().toLowerCase();
}
