/** @layer game/downtime */
import { DOWNTIME_LANES, DOWNTIME_STATION_TYPES } from '../../contracts/domains/downtime.mjs';
import { DAMAGE_TYPES } from '../../contracts/domains/damage.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { isInnateCharacterItem } from '../character/inventory.mjs';
import { forgingTerms, forgingTier, forgingXpAfter, prepareItemDerivedData, reachableTiers } from '../items/rules.mjs';
import { capitalize } from '../../lib/dom/html.mjs';
import { resolveParticipants } from './rules.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** Energy cost checked by planForging and planBrewing, independent of item value. */
export const CRAFTING_ENERGY_COST = 1;

/** How far over the difficulty a brew must land to yield a second copy. */
export const CRAFT_CRIT_MARGIN = 6;

/** The consumable subtypes a recipe may be authored on. */
const BREWABLE_SUBTYPES = Object.freeze(['Potion', 'Bomb']);

/** The skill a forge rolls when the item names none. */
export const DEFAULT_FORGE_SKILL = 'Handicraft';

/** The skill a brew rolls when the recipe names none. */
export const DEFAULT_BREW_SKILL = 'Nature';

/** The two crafting activities, one per kind of crafting station. */
export const CRAFTING_KINDS = Object.freeze({ WORKSHOP: 'workshop', LABORATORY: 'laboratory' });

const FORGE_KINDS = Object.freeze({ Weapon: 'weapon', Armor: 'armor', Staff: 'staff', 'Staff (U)': 'staff' });
const STATION_FORGE_KINDS = Object.freeze({
  [DOWNTIME_STATION_TYPES.WORKSHOP]: Object.freeze(['weapon', 'armor']),
  [DOWNTIME_STATION_TYPES.LABORATORY]: Object.freeze(['staff'])
});
const WEAPON_BONUSES = Object.freeze([
  ['Atk', 'atk', 1], ['Brk', 'brk', 1], ['Dur', 'durability', 1], ['Wgt', 'wgt', -1], ['Acc', 'acc', 1], ['Crit', 'crit', 1]
]);
const ARMOR_BONUSES = Object.freeze([
  ['Stn', 'stn', 1], ['Def', 'def', 1], ['Res', 'res', 1], ['Wgt', 'wgtRed', -1], ['Dur', 'durability', 1]
]);

const numeric = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

/* -------------------------------------------- */
/*  Stations and subjects                       */
/* -------------------------------------------- */
/** Which crafting activity a station hosts, or '' for an Object that hosts none. */
export function craftingKind(stationType) {
  if (stationType === DOWNTIME_STATION_TYPES.WORKSHOP) return CRAFTING_KINDS.WORKSHOP;
  if (stationType === DOWNTIME_STATION_TYPES.LABORATORY) return CRAFTING_KINDS.LABORATORY;
  return '';
}

/** The forgeable kind of an Equipment subtype: weapon, armor, or staff. */
export function forgeableKind(itemType) {
  return FORGE_KINDS[itemType] ?? '';
}

/**
 * Whether a carried copy is something this station forges: a kind the station takes, forging enabled, and a copy a
 * forge can act on at all. An innate grant stands in for a rule rather than being carried, and an infinite copy never
 * spends durability, so neither has anything to restore or to tally toward a tier.
 */
export function stationForges(stationType, item) {
  const kinds = STATION_FORGE_KINDS[stationType] ?? [];
  if (item?.type !== 'Equipment' || !kinds.includes(forgeableKind(item.itemType))) return false;
  if (isInnateCharacterItem(item) || item.source?.uses?.type === 'infinite') return false;
  return item.source?.craftingData?.forging?.enabled === true;
}

/** Whether an Item is a recipe the laboratory brews: a brewable subtype with materials authored on its creation. */
export function isBrewable({ type, itemType, creation } = {}) {
  return type === 'Consumable' && BREWABLE_SUBTYPES.includes(itemType) && (creation?.materials?.length ?? 0) > 0;
}

/** The skill key an authored label rolls, lower-cased, with the activity's default when blank. */
export function craftingSkillKey(label, fallback) {
  return String(label ?? '').trim().toLowerCase() || String(fallback).toLowerCase();
}

/* -------------------------------------------- */
/*  Materials                                   */
/* -------------------------------------------- */
/** How much of each material a set of stacks holds, by name: split stacks are still the same material. */
export function supplyTotals(stacks = []) {
  const totals = {};
  for (const stack of stacks) {
    const name = String(stack?.name ?? '');
    if (!name) continue;
    totals[name] = (totals[name] || 0) + Math.max(0, Math.floor(numeric(stack.amount)));
  }
  return Object.freeze(totals);
}

/** The stacks a performer can spend as one row per name, for the crafting menu's list of what is on hand. */
export function supplyRows(stacks = []) {
  const rows = new Map();
  for (const stack of stacks) {
    const name = String(stack?.name ?? '');
    if (!name) continue;
    const row = rows.get(name) ?? { name, image: String(stack.img ?? ''), amount: 0, food: Boolean(stack.foodType) };
    row.amount += Math.max(0, Math.floor(numeric(stack.amount)));
    rows.set(name, row);
  }
  return Object.freeze([...rows.values()].sort((left, right) => left.name.localeCompare(right.name)).map(Object.freeze));
}

/** What each material costs and whether it is on hand, for a menu's preview and a plan's refusal. */
export function materialNeeds(materials = [], totals = {}) {
  return Object.freeze(materials.map(material => {
    const name = String(material?.name ?? '');
    const need = Math.max(0, Math.floor(numeric(material?.quantity)));
    const have = Math.max(0, Math.floor(numeric(totals[name])));
    return Object.freeze({ name, image: String(material?.image ?? material?.img ?? ''), need, have, ok: have >= need });
  }));
}

/**
 * Plan which stacks each material is drawn from, in the order given, which reachableStacks makes pockets before the
 * Convoy. The forging, brewing and cooking plans carry the draws to the downtime writer. Nothing is drawn if any
 * material is short.
 */
export function planMaterialDraw(materials = [], stacks = []) {
  const remaining = stacks.map(stack => ({ ...stack, amount: Math.max(0, Math.floor(numeric(stack.amount))) }));
  const draws = [];
  for (const material of materials) {
    const name = String(material?.name ?? '');
    let wanted = Math.max(0, Math.floor(numeric(material?.quantity)));
    for (const stack of remaining) {
      if (wanted <= 0) break;
      if (stack.name !== name || stack.amount <= 0) continue;
      const take = Math.min(stack.amount, wanted);
      stack.amount -= take;
      wanted -= take;
      draws.push(Object.freeze({ ownerUuid: stack.ownerUuid, itemId: stack.itemId, name, take, remaining: stack.amount }));
    }
    if (wanted > 0) return { ok: false, draws: Object.freeze([]) };
  }
  return { ok: true, draws: Object.freeze(draws) };
}

/* -------------------------------------------- */
/*  Forging                                     */
/* -------------------------------------------- */
/** How much durability a forge restores: the skill roll times the copy's forge multiplier, rounded. */
function restoredDurability(roll, mult) {
  const multiplier = Math.max(0.1, numeric(mult) || 1);
  return Math.max(0, Math.round(Math.max(0, numeric(roll)) * multiplier));
}

/** A carried copy as the forge reads it: its held tier, its durability, and the terms at that tier. */
export function forgeState(source) {
  const crafting = source?.craftingData ?? {};
  const held = prepareItemDerivedData({ documentType: 'Equipment', system: source });
  const usesMax = numeric(held.system?.uses?.max);
  const usesCurrent = Math.min(Math.max(0, numeric(source?.uses?.current)), usesMax);
  const terms = forgingTerms(crafting);
  return {
    tier: held.tier,
    usesCurrent,
    usesMax,
    atFull: usesCurrent >= usesMax,
    forgingXP: Math.max(0, numeric(crafting.forgingXP)),
    forgeMult: terms.forgeMult,
    skillKey: craftingSkillKey(terms.skillCheck, DEFAULT_FORGE_SKILL),
    materials: Object.freeze((terms.materials ?? []).map(entry => Object.freeze({ ...entry })))
  };
}

/**
 * Work out a forge's result for workForge in engine/downtime/resolvers.mjs: durability restored, forging XP, the new
 * tier, and any durability top-up from that tier's higher maximum.
 */
export function forgeOutcome({ source, roll }) {
  const crafting = source?.craftingData ?? {};
  const state = forgeState(source);
  const restored = Math.min(restoredDurability(roll, state.forgeMult), Math.max(0, state.usesMax - state.usesCurrent));
  const forgingXP = forgingXpAfter(crafting, restored);
  const tierAfter = forgingTier({ ...crafting, forgingXP });
  const next = tierAfter === state.tier
    ? null
    : prepareItemDerivedData({ documentType: 'Equipment', system: { ...source, craftingData: { ...crafting, forgingXP } } });
  const maxAfter = next ? numeric(next.system?.uses?.max) : state.usesMax;
  const topUp = Math.max(0, maxAfter - state.usesMax);
  return Object.freeze({
    restored,
    usesBefore: state.usesCurrent,
    usesAfter: Math.min(state.usesCurrent + restored + topUp, maxAfter),
    usesMax: state.usesMax,
    maxAfter,
    topUp,
    forgingBefore: state.forgingXP,
    forgingXP,
    tierBefore: state.tier,
    tierAfter
  });
}

/**
 * Every tier a copy can reach, for the crafting menu's tier tabs: what that tier grants over the unrefined item,
 * the tally it requires, and whether the copy already holds it. Tiers replace one another, so each is a total.
 */
export function forgeTierPreviews(source) {
  const crafting = source?.craftingData ?? {};
  const held = forgingTier(crafting);
  const tiers = crafting.refinement?.tiers ?? [];
  const armor = source?.itemType === 'Armor';
  const base = armor ? source?.armor?.prots : source?.weapon?.dmgTypes;
  return Object.freeze(reachableTiers(crafting).map(({ index, xpReq }) => {
    const modifiers = tiers[index]?.modifiers ?? {};
    const bonuses = (armor ? ARMOR_BONUSES : WEAPON_BONUSES).map(([label, key, sign]) => Object.freeze({
      label, delta: formatBonus(sign * numeric(modifiers[key]))
    }));
    const granted = armor ? modifiers.prots : modifiers.dmgTypes;
    const types = DAMAGE_TYPES.filter(type => granted?.[type] === true && base?.[type] !== true).map(capitalize);
    bonuses.push(Object.freeze({ label: armor ? 'Protection' : 'Damage', delta: types.length ? types.join(', ') : null, prot: true }));
    return Object.freeze({ tier: index + 1, xpReq, reached: index < held, bonuses: Object.freeze(bonuses) });
  }));
}

function formatBonus(value) {
  if (!value) return null;
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Validate forging for engine/downtime/commands.mjs. Check station, free exploration, reach, performer Energy,
 * item eligibility and equipment state, then materials.
 */
export function planForging(facts = {}) {
  const gate = craftingGate(facts);
  if (!gate.ok) return gate;
  const item = reachableItem(facts, gate.performer);
  if (!item) return refuse(RESULT_CODES.DOWNTIME_SUBJECT_OUT_OF_REACH);
  if (!stationForges(facts.station?.objectType, item)) return refuse(RESULT_CODES.DOWNTIME_SUBJECT_INVALID, { itemName: item.name });
  const state = forgeState(item.source);
  if (state.atFull) return refuse(RESULT_CODES.DOWNTIME_NOTHING_TO_RESTORE, { itemName: item.name });
  const draw = planMaterialDraw(state.materials, reachableStacks(facts, gate.performer));
  if (!draw.ok) return refuse(RESULT_CODES.DOWNTIME_MATERIALS_SHORT, { itemName: item.name });
  return accept(RESULT_CODES.DOWNTIME_FORGED, Object.freeze({
    item,
    skillKey: state.skillKey,
    cost: CRAFTING_ENERGY_COST,
    draws: draw.draws,
    materials: state.materials,
    staged: gate.performer.actorUuid !== facts.cursorActorUuid
  }));
}

/* -------------------------------------------- */
/*  Brewing                                     */
/* -------------------------------------------- */
/** How many copies a brew makes: none on a failure, one on a success, two past the critical margin. */
export function craftYield(roll, dc) {
  const margin = numeric(roll) - numeric(dc);
  if (margin <= 0) return 0;
  return margin >= CRAFT_CRIT_MARGIN ? 2 : 1;
}

/**
 * How many of an owner's pockets a planned draw frees: each of its stacks that the draw empties, since the writer
 * deletes a stack drawn to nothing before the product lands.
 */
export function freedPockets(draws = [], ownerUuid = '') {
  const left = new Map();
  for (const draw of draws) {
    if (draw.ownerUuid === ownerUuid) left.set(draw.itemId, draw.remaining);
  }
  return [...left.values()].filter(remaining => remaining <= 0).length;
}

/** Where each brewed copy lands: the performer's pockets while there is room, else the Convoy, else nowhere. */
export function planBrewDelivery({ count = 0, pocketCount = 0, pocketLimit = Infinity, performerUuid = '', convoyUuid = '' } = {}) {
  let pockets = Math.max(0, numeric(pocketCount));
  const limit = Number.isFinite(pocketLimit) ? pocketLimit : Infinity;
  const deliveries = [];
  let lost = 0;
  for (let made = 0; made < Math.max(0, Math.floor(numeric(count))); made += 1) {
    if (pockets < limit) {
      pockets += 1;
      deliveries.push(Object.freeze({ destinationUuid: performerUuid, kind: 'pockets' }));
    } else if (convoyUuid) {
      deliveries.push(Object.freeze({ destinationUuid: convoyUuid, kind: 'convoy' }));
    } else {
      lost += 1;
    }
  }
  return { deliveries: Object.freeze(deliveries), lost };
}

/** The data a brewed copy is created from: the recipe's own, without its id or any equipped state. */
export function brewedProductData(data) {
  const product = structuredClone(data ?? {});
  delete product._id;
  if (product.system) {
    product.system.isWielded = false;
    product.system.isWorn = false;
    product.system.isEquipped = false;
  }
  return product;
}

/**
 * Validate brewing for engine/downtime/commands.mjs. Require a reachable Laboratory in free exploration, an
 * available performer, a known recipe, materials and room for the first product before charging costs. The room
 * counts the pockets the draw itself empties.
 */
export function planBrewing(facts = {}) {
  if (facts.station?.objectType !== DOWNTIME_STATION_TYPES.LABORATORY) return refuse(RESULT_CODES.DOWNTIME_STATION_INVALID);
  const gate = craftingGate(facts);
  if (!gate.ok) return gate;
  const recipe = facts.recipe ?? null;
  if (!recipe || !isBrewable(recipe)) return refuse(RESULT_CODES.DOWNTIME_RECIPE_UNKNOWN);
  const draw = planMaterialDraw(recipe.creation.materials, reachableStacks(facts, gate.performer));
  if (!draw.ok) return refuse(RESULT_CODES.DOWNTIME_MATERIALS_SHORT, { itemName: recipe.name });
  const room = planBrewDelivery({
    count: 1,
    pocketCount: gate.performer.pocketCount - freedPockets(draw.draws, gate.performer.actorUuid),
    pocketLimit: gate.performer.pocketLimit,
    performerUuid: gate.performer.actorUuid, convoyUuid: reachConvoy(facts, gate.performer)
  });
  if (room.lost > 0) return refuse(RESULT_CODES.DOWNTIME_NO_ROOM, { performerName: gate.performer.name, itemName: recipe.name });
  return accept(RESULT_CODES.DOWNTIME_BREWED, Object.freeze({
    recipe,
    skillKey: craftingSkillKey(recipe.creation.skillCheck, DEFAULT_BREW_SKILL),
    dc: Math.max(0, numeric(recipe.creation.difficultyClass)),
    cost: CRAFTING_ENERGY_COST,
    draws: draw.draws,
    materials: Object.freeze(recipe.creation.materials.map(entry => Object.freeze({ ...entry }))),
    convoyUuid: reachConvoy(facts, gate.performer),
    staged: gate.performer.actorUuid !== facts.cursorActorUuid
  }));
}

/* -------------------------------------------- */
/*  Shared gates                                */
/* -------------------------------------------- */
/** Shared gates for planForging and planBrewing, checked in order: station, free exploration, reach, performer. */
function craftingGate(facts) {
  if (!craftingKind(facts.station?.objectType)) return refuse(RESULT_CODES.DOWNTIME_STATION_INVALID);
  if (facts.exploring !== true) return refuse(RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED);
  if (facts.inReach !== true) return refuse(RESULT_CODES.DOWNTIME_OUT_OF_REACH, { actorName: facts.cursorName });
  const participants = resolveParticipants(facts.roster ?? [], { lane: DOWNTIME_LANES.ENERGY, energyCost: CRAFTING_ENERGY_COST });
  const performer = participants.find(entry => entry.actorUuid === facts.performerUuid) ?? null;
  if (!performer) return refuse(RESULT_CODES.DOWNTIME_PERFORMER_OUTSIDE_ROSTER);
  if (!performer.eligible) {
    return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { performerName: performer.name, blocked: performer.blocked });
  }
  return { ok: true, performer };
}

/** The Convoy a performer draws on: the driving unit's party Convoy first, then the performer's own. */
function reachConvoy(facts, performer) {
  return String(facts.convoyUuid || performer.convoyUuid || '');
}

/** The owners whose goods a performer may work: its own pockets and the reachable Convoy. */
export function reachOwners(facts, performer) {
  const convoy = reachConvoy(facts, performer);
  return Object.freeze(convoy ? [performer.actorUuid, convoy] : [performer.actorUuid]);
}

function reachableItem(facts, performer) {
  const owners = reachOwners(facts, performer);
  return (facts.items ?? []).find(item => item.itemUuid === facts.itemUuid && owners.includes(item.ownerUuid)) ?? null;
}

/** The Resource stacks a performer may spend, its own pockets before the Convoy. */
export function reachableStacks(facts, performer) {
  const stacks = facts.stacks ?? {};
  return reachOwners(facts, performer).flatMap(owner => stacks[owner] ?? []);
}
