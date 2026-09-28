/** @layer game/downtime */
import { GROWTH_KEYS, STATS } from '../../contracts/domains/characters.mjs';
import {
  DOWNTIME_ENTITY_FLAG, DOWNTIME_LANES, DOWNTIME_STATION_TYPES, MEAL_OUTCOMES, RECIPE_LIMITS
} from '../../contracts/domains/downtime.mjs';
import { FOOD_TYPE_STATS } from '../../contracts/domains/items.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';
import { materialNeeds, planMaterialDraw, reachableStacks, supplyTotals } from './crafting.mjs';
import { builtinId, defineLibrary } from './library.mjs';
import { defeatedBlock, resolveParticipants } from './rules.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** The skill cooking rolls. */
export const COOK_SKILL = 'Nature';

/** How far over the difficulty a cook must land for a special ingredient to count. */
export const SPECIAL_MARGIN = 5;

/** The raw stat a special meal grants, felt at once rather than at the next level. */
const SPECIAL_STAT_BONUS = 1;

/** The Resource types a recipe may call for. */
export const INGREDIENT_RESOURCE_TYPES = Object.freeze(['Ingredient', 'Reagent']);

/** Art for a recipe or an ingredient that has none of its own. */
const RECIPE_FALLBACK_IMAGE = 'icons/consumables/food/bowl-stew-brown.webp';
export const INGREDIENT_FALLBACK_IMAGE = 'icons/svg/item-bag.svg';

/** The passive each meal outcome grants. mealPassiveAmong finds a unit's existing meal by these names. */
const MEAL_PASSIVE_NAMES = Object.freeze({
  [MEAL_OUTCOMES.FAIL]: 'Sated Stomach', [MEAL_OUTCOMES.SUCCESS]: 'Well Fed', [MEAL_OUTCOMES.SPECIAL]: 'Envigorated'
});

/** The status art of each meal passive, whatever dish left it. */
const MEAL_PASSIVE_IMAGES = Object.freeze({
  [MEAL_OUTCOMES.FAIL]: `systems/${SYSTEM_ID}/assets/status/SatedStomach.png`,
  [MEAL_OUTCOMES.SUCCESS]: `systems/${SYSTEM_ID}/assets/status/WellFed.png`,
  [MEAL_OUTCOMES.SPECIAL]: `systems/${SYSTEM_ID}/assets/status/Envigorated.png`
});

/** Support XP by meal outcome, for supportXpFor. Even a failed shared meal grants some. */
const SUPPORT_XP_BY_OUTCOME = Object.freeze({
  [MEAL_OUTCOMES.SPECIAL]: 15, [MEAL_OUTCOMES.SUCCESS]: 10, [MEAL_OUTCOMES.FAIL]: 5
});

/** How each growth stat is labelled on a meal. */
export const GROWTH_STAT_LABEL = Object.freeze(Object.fromEntries(GROWTH_KEYS.map(key => [
  key, STATS.find(entry => entry.growth === key)?.short ?? key
])));

/** The stat each special-ingredient label writes, as a raw stat rather than a growth. */
const SPECIAL_STAT_TARGET = Object.freeze({
  HP: 'hpMax', Bld: 'bld', Mgt: 'mgt', Agi: 'agi', Tqn: 'tqn', Wit: 'wit', Cha: 'cha', Def: 'def', Res: 'res'
});

const MEAL_NAMES = Object.freeze(Object.values(MEAL_PASSIVE_NAMES));
const numeric = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** A bonus as a meal or a performance passive writes it: `+2`, `0` or `-1`. */
export const signed = value => (value > 0 ? `+${value}` : String(value));

/* -------------------------------------------- */
/*  Recipes                                     */
/* -------------------------------------------- */
function blankGrowths() {
  return Object.fromEntries(GROWTH_KEYS.map(key => [key, null]));
}

/** A blank recipe with the given id, Default unless told otherwise. */
export function newRecipe(id, isDefault = true) {
  return {
    id: String(id ?? ''), name: '', img: RECIPE_FALLBACK_IMAGE, description: '', isDefault: isDefault !== false,
    builtin: false, dc: 10, ingredients: [], growths: blankGrowths()
  };
}

/** Coerce a stored recipe into the canonical shape: a positive difficulty, quantities of at least one, every growth. */
export function normalizeRecipe(raw, fallbackId = '') {
  const recipe = raw ?? {};
  const growths = blankGrowths();
  for (const key of GROWTH_KEYS) {
    const value = recipe.growths?.[key];
    if (value === null || value === undefined || value === '') continue;
    const whole = Math.trunc(Number(value));
    growths[key] = Number.isFinite(whole) && whole !== 0
      ? Math.max(-RECIPE_LIMITS.maxGrowth, Math.min(RECIPE_LIMITS.maxGrowth, whole)) : null;
  }
  return {
    id: String(recipe.id || fallbackId || ''),
    name: String(recipe.name ?? ''),
    img: String(recipe.img || RECIPE_FALLBACK_IMAGE),
    description: String(recipe.description ?? ''),
    isDefault: recipe.isDefault !== false,
    builtin: recipe.builtin === true,
    dc: Math.max(1, Math.min(RECIPE_LIMITS.maxDc, Math.trunc(Number(recipe.dc)) || 1)),
    ingredients: (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).map(entry => ({
      uuid: String(entry?.uuid ?? ''),
      name: String(entry?.name ?? ''),
      img: String(entry?.img ?? ''),
      quantity: Math.max(1, Math.trunc(Number(entry?.quantity)) || 1)
    })),
    growths
  };
}

/**
 * The recipe library's rules, shared with the song library through defineLibrary in library.mjs. A world's recipe
 * matches its built-in when everything but its ingredients' uuids and art is the same, so repairing an ingredient's
 * reference never stores an edit.
 */
export const {
  normalizeEntries: normalizeRecipes,
  normalizeChanges: normalizeRecipeChanges,
  resolve: resolveRecipeLibrary,
  planChanges: planRecipeLibraryChanges,
  known: recipesForChef
} = defineLibrary({ key: 'recipes', fallbackPrefix: 'recipe', normalize: normalizeRecipe, signature: recipeSignature });

function recipeSignature(recipe) {
  const normalized = normalizeRecipe(recipe, recipe?.id);
  const ingredients = normalized.ingredients.map(({ name, quantity }) => ({ name, quantity }));
  return JSON.stringify({ ...normalized, ingredients });
}

/**
 * Point a recipe's ingredients at the Resource items of the same name, taking their uuid and art. Used by the recipe
 * library writer in foundry/adapters/document-writes/downtime.mjs and by projectRecipeLibrary in
 * projections/downtime.mjs. Returns the same recipe object when nothing changed, so the writer can skip a write.
 */
export function hydrateIngredients(recipe, byName) {
  let changed = false;
  const ingredients = (recipe?.ingredients ?? []).map(entry => {
    const hit = byName?.get?.(String(entry?.name ?? '').toLowerCase());
    if (!hit) return entry;
    const uuid = String(hit.uuid ?? '');
    const img = String(hit.img || entry.img || '');
    if (uuid === entry.uuid && img === entry.img) return entry;
    changed = true;
    return { ...entry, uuid, img };
  });
  return changed ? { ...recipe, ingredients } : recipe;
}

/* -------------------------------------------- */
/*  The cookbook                                */
/* -------------------------------------------- */
function cookbookIngredients(source) {
  const pairs = Array.isArray(source)
    ? source.map(entry => (Array.isArray(entry) ? entry : [entry?.name, entry?.quantity]))
    : Object.entries(source ?? {});
  return pairs
    .filter(([name]) => String(name ?? '').trim())
    .map(([name, quantity]) => ({ uuid: '', name: String(name).trim(), img: '', quantity: Math.max(1, Math.trunc(Number(quantity)) || 1) }));
}

/**
 * Parse the shipped cookbook for foundry/adapters/services/json-files.mjs, giving each recipe its built-in id and
 * art path. An entry with no name or no ingredient is skipped with a warning.
 */
export function parseCookbook(raw) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.recipes) ? raw.recipes : []);
  const recipes = [];
  const warnings = [];
  for (const entry of source) {
    const name = String(entry?.name ?? '').trim();
    const ingredients = cookbookIngredients(entry?.ingredients);
    if (!name || !ingredients.length) {
      warnings.push(`Recipe "${entry?.name ?? entry?.id ?? '?'}" names no dish or no ingredient and was skipped.`);
      continue;
    }
    recipes.push(normalizeRecipe({
      id: builtinId(entry?.id, name),
      name,
      img: String(entry?.img ?? '').trim() || `systems/${SYSTEM_ID}/assets/items/recipes/${encodeURIComponent(name)}.png`,
      description: String(entry?.description ?? ''),
      isDefault: true,
      builtin: true,
      dc: entry?.dc,
      ingredients,
      growths: { ...(entry?.growths ?? {}) }
    }));
  }
  return Object.freeze({ recipes: Object.freeze(recipes), warnings: Object.freeze(warnings) });
}

/* -------------------------------------------- */
/*  Outcomes                                    */
/* -------------------------------------------- */
/** How a cook turned out: a failure under the difficulty, a success on a strict beat, a special past the margin. */
export function cookOutcome(roll, dc, hasSpecial) {
  const margin = numeric(roll) - numeric(dc);
  if (margin < 1) return MEAL_OUTCOMES.FAIL;
  if (hasSpecial && margin >= SPECIAL_MARGIN) return MEAL_OUTCOMES.SPECIAL;
  return MEAL_OUTCOMES.SUCCESS;
}

/** The growth bonuses a meal grants: the recipe's own, each halved toward zero on a failure, zeros dropped. */
function mealGrowths(recipe, outcome) {
  const out = [];
  for (const key of GROWTH_KEYS) {
    const raw = Number(recipe?.growths?.[key]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const amount = outcome === MEAL_OUTCOMES.FAIL ? (raw > 0 ? Math.floor(raw / 2) : -Math.floor(-raw / 2)) : raw;
    if (amount === 0) continue;
    out.push({ key, label: GROWTH_STAT_LABEL[key], amount });
  }
  return out;
}

/** The special ingredient's raw stat bonus, or null when the meal did not earn it. */
function specialBonus(foodType, outcome) {
  if (outcome !== MEAL_OUTCOMES.SPECIAL) return null;
  const stat = FOOD_TYPE_STATS[foodType];
  if (!stat || !SPECIAL_STAT_TARGET[stat]) return null;
  return { stat, amount: SPECIAL_STAT_BONUS };
}

/** How much of an ingredient a sitting needs: the recipe's per-diner quantity times the number eating. */
function ingredientNeed(quantity, diners) {
  return Math.max(1, Math.trunc(Number(quantity)) || 1) * Math.max(1, Math.trunc(Number(diners)) || 1);
}

/** Support experience for an outcome, the failure value for anything unrecognised. */
export function supportXpFor(outcome) {
  return SUPPORT_XP_BY_OUTCOME[outcome] ?? SUPPORT_XP_BY_OUTCOME[MEAL_OUTCOMES.FAIL];
}

/** The passive an outcome grants. */
export function mealPassiveName(outcome) {
  return MEAL_PASSIVE_NAMES[outcome] ?? MEAL_PASSIVE_NAMES[MEAL_OUTCOMES.FAIL];
}

/** The meal a unit already carries, by the names of its items. A unit eats one meal per downtime. */
export function mealPassiveAmong(itemNames = []) {
  return itemNames.find(name => MEAL_NAMES.includes(name)) ?? '';
}

/* -------------------------------------------- */
/*  The meal passive                            */
/* -------------------------------------------- */
/** One passive modifier in the Item modifier shape, for the meal passive here and the performance passives. */
export function modifier(name, target, amount) {
  return {
    name, target, quantity: String(amount), condition: '', conditionTree: null, requiresEquipped: false,
    requiresActivation: false, stackable: false, kind: 'standard', targetType: 'All'
  };
}

/**
 * Build the meal passive a cook grants each diner, for workPot in engine/downtime/resolvers.mjs. It carries the
 * recipe's growth bonuses, halved on a failure, plus the special stat when earned. The item is tagged as downtime
 * content so the GM's Reset Downtime removes it.
 */
export function buildMealPassive(recipe, outcome, specialFoodType = null) {
  const growths = mealGrowths(recipe, outcome);
  const special = specialBonus(specialFoodType, outcome);
  const name = mealPassiveName(outcome);
  const modifiers = growths.map(entry => modifier(`${entry.label} Growth`, `growth.${entry.key}`, entry.amount));
  if (special) modifiers.push(modifier(`${special.stat} ${signed(special.amount)}`, SPECIAL_STAT_TARGET[special.stat], special.amount));
  const parts = growths.map(entry => `${entry.label} growth ${signed(entry.amount)}`);
  if (special) parts.push(`${special.stat} ${signed(special.amount)}`);
  const summary = parts.length ? parts.join(', ') : 'no lasting benefit';
  const flavour = outcome === MEAL_OUTCOMES.FAIL
    ? 'Failed meal, so growth bonuses are halved.'
    : outcome === MEAL_OUTCOMES.SPECIAL ? 'Special meal.' : 'Successful meal.';
  const data = {
    name,
    type: 'Ability',
    img: RECIPE_FALLBACK_IMAGE,
    system: {
      itemType: 'Passive',
      description: `${flavour} ${recipe?.name || 'A meal'}: ${summary}. Lasts until the GM resets Downtime.`,
      modifiers
    },
    flags: { [SYSTEM_ID]: { [DOWNTIME_ENTITY_FLAG]: true } }
  };
  return { data, growths, special, summary, name };
}

/* -------------------------------------------- */
/*  The table                                   */
/* -------------------------------------------- */
/** What the recipe costs for this many diners against what the chef can reach. */
export function ingredientNeeds(recipe, diners, totals = {}) {
  return materialNeeds((recipe?.ingredients ?? []).map(entry => ({
    name: entry.name || '(unset)', img: entry.img || INGREDIENT_FALLBACK_IMAGE, quantity: ingredientNeed(entry.quantity, diners)
  })), totals).map(entry => ({ ...entry, ok: entry.ok && entry.name !== '(unset)' }));
}

/** The foods a chef could add as the special ingredient: food-typed, not already in the pot, one row per name. */
export function specialCandidates(recipe, stacks = [], diners = 1) {
  const inPot = new Set((recipe?.ingredients ?? []).map(entry => entry.name).filter(Boolean));
  const totals = supplyTotals(stacks);
  const byName = new Map();
  for (const stack of stacks) {
    const stat = FOOD_TYPE_STATS[stack.foodType];
    if (!stat || inPot.has(stack.name) || byName.has(stack.name)) continue;
    byName.set(stack.name, { name: stack.name, image: stack.img || INGREDIENT_FALLBACK_IMAGE, foodType: stack.foodType, stat });
  }
  const need = Math.max(1, Math.trunc(Number(diners)) || 1);
  return [...byName.values()]
    .map(entry => ({ ...entry, have: totals[entry.name] ?? 0, need, ok: (totals[entry.name] ?? 0) >= need }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The recipe's growth-rate modifiers for a preview, a cell per stat. */
export function growthCells(recipe) {
  return GROWTH_KEYS.map(key => {
    const value = recipe?.growths?.[key];
    return { key, label: GROWTH_STAT_LABEL[key], delta: value ? signed(value) : null };
  });
}

/**
 * Validate cooking for engine/downtime/commands.mjs before costs are written.
 * Check station, free exploration and reach, chef availability, known recipe, unfed diners still standing, and
 * ingredients for every serving.
 */
export function planCooking(facts = {}) {
  if (facts.station?.objectType !== DOWNTIME_STATION_TYPES.COOKING) return refuse(RESULT_CODES.DOWNTIME_STATION_INVALID);
  if (facts.exploring !== true) return refuse(RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED);
  if (facts.inReach !== true) return refuse(RESULT_CODES.DOWNTIME_OUT_OF_REACH, { actorName: facts.cursorName });
  const participants = resolveParticipants(facts.roster ?? [], { lane: DOWNTIME_LANES.ACTION });
  const chef = participants.find(entry => entry.actorUuid === facts.performerUuid) ?? null;
  if (!chef) return refuse(RESULT_CODES.DOWNTIME_PERFORMER_OUTSIDE_ROSTER);
  if (!chef.eligible) return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { performerName: chef.name, blocked: chef.blocked });
  if (chef.mealName) return refuse(RESULT_CODES.DOWNTIME_ALREADY_FED, { actorName: chef.name, mealName: chef.mealName });
  const recipe = recipesForChef(facts.library ?? [], chef.recipeIds).find(entry => entry.id === facts.recipeId) ?? null;
  if (!recipe) return refuse(RESULT_CODES.DOWNTIME_RECIPE_UNKNOWN, { performerName: chef.name });
  const diners = [chef];
  for (const uuid of facts.dinerUuids ?? []) {
    if (uuid === chef.actorUuid) continue;
    const diner = participants.find(entry => entry.actorUuid === uuid) ?? null;
    if (!diner) return refuse(RESULT_CODES.DOWNTIME_DINER_OUTSIDE_ROSTER);
    if (diner.mealName) return refuse(RESULT_CODES.DOWNTIME_ALREADY_FED, { actorName: diner.name, mealName: diner.mealName });
    const fallen = defeatedBlock(diner);
    if (fallen) {
      return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { performerName: diner.name, blocked: fallen });
    }
    diners.push(diner);
  }
  if (recipe.ingredients.some(entry => !entry.name)) return refuse(RESULT_CODES.DOWNTIME_RECIPE_UNKNOWN, { performerName: chef.name });
  const count = diners.length;
  const stacks = reachableStacks(facts, chef);
  const wanted = recipe.ingredients.map(entry => ({ name: entry.name, quantity: ingredientNeed(entry.quantity, count) }));
  const ingredients = planMaterialDraw(wanted, stacks);
  if (!ingredients.ok) return refuse(RESULT_CODES.DOWNTIME_MATERIALS_SHORT, { itemName: recipe.name, materials: 'ingredients' });
  let special = null;
  if (facts.specialName) {
    const candidate = specialCandidates(recipe, stacks, count).find(entry => entry.name === facts.specialName) ?? null;
    if (!candidate) return refuse(RESULT_CODES.DOWNTIME_SPECIAL_INVALID, { itemName: facts.specialName });
    if (!candidate.ok) return refuse(RESULT_CODES.DOWNTIME_MATERIALS_SHORT, { itemName: candidate.name, materials: candidate.name });
    special = Object.freeze({ name: candidate.name, image: candidate.image, foodType: candidate.foodType, stat: candidate.stat });
    wanted.push({ name: special.name, quantity: count });
  }
  const draw = planMaterialDraw(wanted, stacks);
  if (!draw.ok) return refuse(RESULT_CODES.DOWNTIME_MATERIALS_SHORT, { itemName: recipe.name, materials: 'ingredients' });
  return accept(RESULT_CODES.DOWNTIME_COOKED, Object.freeze({
    recipe,
    chef,
    diners: Object.freeze(diners),
    count,
    skillKey: COOK_SKILL.toLowerCase(),
    dc: recipe.dc,
    draws: draw.draws,
    materials: Object.freeze(wanted.map(entry => Object.freeze({ ...entry }))),
    special,
    staged: chef.actorUuid !== facts.cursorActorUuid
  }));
}
