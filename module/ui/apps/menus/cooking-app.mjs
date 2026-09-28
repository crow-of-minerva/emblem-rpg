/** @layer ui/apps/menus */
import { defaultPerformer, pickableFirst, resolvePerformer } from './downtime-performer.mjs';
import {
  menuShown, performerRows, rerenderMenu, rollLine, selectPerformer, showDowntimeMenu, submitMenu
} from './downtime-menu.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { growthCells, ingredientNeeds, specialCandidates } from '../../../game/downtime/cooking.mjs';
import { avatarScaleStyle } from '../../../lib/dom/html.mjs';
import { playMenuSound, playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import { SHEET_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/cooking-menu.hbs`;
const WINDOW_CLASS = 'window-cooking-menu';
const MENU_WIDTH = 1120;
const MENU_HEIGHT = 680;
/** Stat filters for the special-ingredient grid, in display order: All, then every stat a food type can raise. */
const ALL_STATS = 'All';
const SPECIAL_FILTERS = Object.freeze([ALL_STATS, 'HP', 'Bld', 'Mgt', 'Agi', 'Tqn', 'Wit', 'Cha', 'Def', 'Res']);

/* -------------------------------------------- */
/*  Cooking menu                                */
/* -------------------------------------------- */
/**
 * Show a Cooking Pot's chefs, recipes, diners and special ingredients. interactWithStation
 * (ui/controls/interaction.mjs) opens it with the api.downtime.inspectCooking view. On submit the window closes and
 * one api.downtime.cook command runs, which rolls the chef's check and gives every diner the meal.
 * @param {object} view The downtime query's cooking view.
 * @param {{refresh?: Function}} [handlers] Re-reads the view before the window is rebuilt.
 * @returns {Promise<boolean>} Always false in practice: the window closes before the cook command answers, and the
 *   caller ignores the value.
 */
export async function openCookingMenu(view, { refresh = null } = {}) {
  if (menuShown(WINDOW_CLASS)) return false;
  const state = {
    performerUuid: defaultPerformer(view), recipeId: null, diners: new Set(), specialName: null,
    specialFilter: ALL_STATS, cooked: false, busy: false
  };
  await showDowntimeMenu({
    title: `Cooking: ${view.station.name}`, classes: [WINDOW_CLASS], width: MENU_WIDTH, height: MENU_HEIGHT,
    view, state, refresh, render, body: '.cooking-menu', confirmAction: 'cook', confirm: beginCooking,
    actions: { selectPerformer: selectChef, selectRecipe, toggleDiner, selectSpecial, filterSpecials }
  });
  return state.cooked;
}

/* -------------------------------------------- */
/*  View                                        */
/* -------------------------------------------- */
/**
 * Build the cooking template's context from the inspect view and the menu's picks. Units that can't be picked are
 * listed after the ones that can, and so are recipes the chef lacks the ingredients for at this diner count. The
 * footer line describes the meal the button would send, or why it can't, and the same reason is the footer's
 * tooltip.
 */
function prepareCookingView(view, state) {
  const active = resolvePerformer(view, state.performerUuid);
  const performers = performerRows(view.performers ?? [], active, { skillLabel: view.skillLabel });
  const recipes = active ? (view.recipes ?? []).filter(recipe => active.recipeIds.includes(recipe.id)) : [];
  const recipe = recipes.find(entry => entry.id === state.recipeId) ?? null;
  const dinerCandidates = pickableFirst((view.performers ?? [])
    .filter(entry => entry.actorUuid !== active?.actorUuid)
    .sort((a, b) => a.name.localeCompare(b.name)), entry => !entry.mealName && !entry.defeated);
  const eaters = dinerCandidates
    .filter(entry => !entry.mealName && !entry.defeated && state.diners.has(entry.actorUuid));
  const dinerCount = 1 + eaters.length;
  const diners = dinerCandidates.map(entry => Object.freeze({
    actorUuid: entry.actorUuid,
    name: entry.name,
    image: entry.image,
    avatarStyle: avatarScaleStyle(entry.avatarScale),
    chosen: state.diners.has(entry.actorUuid) && !entry.mealName && !entry.defeated,
    blocked: entry.defeated ? 'Defeated' : entry.mealName ? `Already fed (${entry.mealName})` : ''
  }));
  const stocked = entry => ingredientNeeds(entry, dinerCount, active?.supplies ?? {}).every(need => need.ok);
  const recipeRows = pickableFirst(recipes.map(entry => ({ entry, short: !stocked(entry) })), row => !row.short);
  const detail = active && recipe ? cookDetail(recipe, active, dinerCount, state, view.specialMargin) : null;
  const insufficient = Boolean(detail) && detail.materialsOk === false;
  let blockTitle = '';
  if (!performers.length) blockTitle = 'No party member is on this map';
  else if (!active) blockTitle = 'No party member can cook right now';
  else if (!recipes.length) blockTitle = 'This chef knows no recipes';
  else if (!recipe) blockTitle = 'Select a recipe';
  else if (!detail.canCook) blockTitle = detail.warning;
  const chefRow = performers.find(entry => entry.selected) ?? null;
  return Object.freeze({
    station: view.station,
    modeDesc: `Roll a ${view.skillLabel} check to cook a meal for the party. Beat the DC by ${view.specialMargin} with a special ingredient for a little extra.`,
    chefTooltip: getTooltip(SHEET_TOOLTIP_IDS.COOK_CHEF_EATS),
    performers,
    hasPerformers: performers.length > 0,
    chefName: active?.name ?? '',
    chefImage: chefRow?.image ?? '',
    chefAvatarStyle: chefRow?.avatarStyle ?? '',
    ticket: Object.freeze({
      blocked: blockTitle,
      bad: Boolean(detail) && !detail.canCook,
      chef: active?.name ?? '',
      recipe: detail?.name ?? '',
      special: detail?.specialName ?? '',
      roll: chefRow ? rollLine(chefRow, chefRow.skillLabel) : ''
    }),
    recipes: Object.freeze(recipeRows.map(({ entry, short }) => Object.freeze({
      id: entry.id, name: entry.name || 'Unnamed recipe', image: entry.img, dc: entry.dc, personal: !entry.isDefault,
      selected: entry.id === recipe?.id, short
    }))),
    hasRecipes: recipes.length > 0,
    diners,
    hasDiners: diners.length > 0,
    dinerCount,
    detail,
    hasSelection: Boolean(detail),
    canCook: Boolean(detail?.canCook) && state.busy !== true,
    buttonInsufficient: insufficient,
    buttonLabel: insufficient ? 'Insufficient Ingredients' : 'Begin Cooking',
    buttonTitle: !detail?.canCook && blockTitle ? blockTitle : ''
  });
}

/** Build the recipe card: the pot's needs, the special candidates under the chosen stat filter, and the growths. */
function cookDetail(recipe, chef, dinerCount, state, specialMargin) {
  const ingredients = ingredientNeeds(recipe, dinerCount, chef.supplies ?? {});
  const ingredientsOk = ingredients.every(entry => entry.ok);
  const candidates = specialCandidates(recipe, chef.foods ?? [], dinerCount)
    .map(entry => ({ ...entry, selected: entry.name === state.specialName }));
  const special = candidates.find(entry => entry.selected) ?? null;
  const filter = SPECIAL_FILTERS.includes(state.specialFilter) ? state.specialFilter : ALL_STATS;
  const specials = candidates.filter(entry => filter === ALL_STATS || entry.stat === filter);
  let specialsEmpty = 'No food on hand to add a personal touch.';
  if (candidates.length) specialsEmpty = `No ${filter} food on hand.`;
  const specialOk = !special || special.ok;
  let warning = '';
  if (!ingredientsOk) warning = 'Not enough ingredients for this many diners';
  else if (!specialOk) warning = `Not enough ${special.name} for this many diners`;
  return Object.freeze({
    name: recipe.name || 'Unnamed recipe',
    description: recipe.description,
    dc: recipe.dc,
    skill: chef.skillLabel ?? 'Nature',
    ingredients,
    hasIngredients: ingredients.length > 0,
    growths: growthCells(recipe).map(cell => ({ ...cell, special: Boolean(special) && cell.label === special.stat })),
    specials,
    hasSpecials: specials.length > 0,
    specialsEmpty,
    specialName: special?.name ?? '',
    specialNote: special
      ? `${special.stat} +1 on a roll of ${recipe.dc + specialMargin} or higher`
      : `Optional: one stat +1 on a roll of ${recipe.dc + specialMargin} or higher`,
    filters: SPECIAL_FILTERS.map(stat => ({ stat, selected: stat === filter })),
    materialsOk: ingredientsOk && specialOk,
    canCook: ingredientsOk && specialOk,
    warning
  });
}

async function render(view, state) {
  const prepared = prepareCookingView(view, state);
  state.performerUuid = prepared.performers.find(entry => entry.selected)?.actorUuid ?? null;
  if (prepared.detail && state.specialName && !prepared.detail.specialName) state.specialName = null;
  return globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    ...prepared,
    detail: prepared.detail ? { ...prepared.detail, skill: prepared.performers.find(entry => entry.selected)?.skillLabel ?? prepared.detail.skill } : null
  });
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */
/** Pick the chef, who then no longer counts among the diners. */
function selectChef(menu, pick) {
  selectPerformer(menu, pick, (state, uuid) => state.diners.delete(uuid));
}

function selectRecipe(menu, row) {
  if (menu.state.busy) return;
  const id = String(row.dataset.id ?? '');
  menu.state.recipeId = menu.state.recipeId === id ? null : id;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

function toggleDiner(menu, row) {
  if (menu.state.busy) return;
  if (row.dataset.blocked === 'true') {
    playUiSound(SOUND_IDS.UI_ERROR);
    return;
  }
  const uuid = String(row.dataset.uuid ?? '');
  if (menu.state.diners.has(uuid)) menu.state.diners.delete(uuid);
  else menu.state.diners.add(uuid);
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

function selectSpecial(menu, chip) {
  if (menu.state.busy) return;
  const name = String(chip.dataset.name ?? '') || null;
  menu.state.specialName = menu.state.specialName === name ? null : name;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

function filterSpecials(menu, label) {
  if (menu.state.busy) return;
  menu.state.specialFilter = String(label.dataset.stat ?? '') || ALL_STATS;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu).then(() => menu.root.querySelector('.ck-special-scroll')?.scrollTo(0, 0));
}

/** Close the window, then send the cook command with the chef, recipe, special ingredient and diners. */
async function beginCooking(menu) {
  const { view, state } = menu;
  const prepared = prepareCookingView(view, state);
  const performer = resolvePerformer(view, state.performerUuid);
  if (!performer || !prepared.canCook || state.busy) return;
  const recipe = prepared.recipes.find(row => row.selected) ?? null;
  if (!recipe) return;
  const result = await submitMenu(menu, () => game.emblemRpg.api.downtime.cook({
    cursorTokenUuid: view.cursorTokenUuid,
    stationTokenUuid: view.stationTokenUuid,
    performerUuid: performer.actorUuid,
    recipeId: recipe.id,
    specialName: prepared.detail.specialName,
    dinerUuids: prepared.diners.filter(row => row.chosen).map(row => row.actorUuid)
  }));
  state.cooked = result?.ok === true;
  state.busy = false;
}
