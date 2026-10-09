/** @layer ui/apps/menus */
import { GROWTH_KEYS } from '../../../contracts/domains/characters.mjs';
import { DOWNTIME_STATION_TYPES } from '../../../contracts/domains/downtime.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import {
  GROWTH_STAT_LABEL, INGREDIENT_FALLBACK_IMAGE, INGREDIENT_RESOURCE_TYPES, newRecipe, normalizeRecipe
} from '../../../game/downtime/cooking.mjs';
import { SHEET_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';
import { wireMaterialList, wireSearch } from '../sheets/item/editors/crafting.mjs';
import { LibraryApp } from './library-app.mjs';

/* -------------------------------------------- */
/*  Recipe library                              */
/* -------------------------------------------- */
/** The drag payload a Personal recipe row carries, dropped on a unit's sheet to teach it. */
export const RECIPE_DRAG_TYPE = 'EmblemRecipe';

const TABS = Object.freeze({
  default: Object.freeze({
    label: 'Default', icon: 'fas fa-book-open', title: 'Recipes every Cooking Pot offers',
    isDefault: true
  }),
  personal: Object.freeze({
    label: 'Personal', icon: 'fas fa-user-pen',
    title: 'Recipes only the units they are linked to can cook', isDefault: false
  })
});

/** The world Recipe Library, a LibraryApp whose detail pane edits a recipe's growths and ingredients. */
export class RecipeLibraryApp extends LibraryApp {
  /* -------------------------------------------- */
  /*  Application configuration                   */
  /* -------------------------------------------- */
  static DEFAULT_OPTIONS = {
    id: 'emblem-recipe-library',
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-crafting-settings', 'recipe-library'],
    tag: 'div',
    window: { title: 'Recipe Library', icon: 'fas fa-utensils', resizable: true, minimizable: true },
    position: { width: 690, height: 580 },
    actions: {
      setTab: LibraryApp.setTab,
      selectRecipe: LibraryApp.selectEntry,
      addRecipe: LibraryApp.addEntry,
      deleteRecipe: LibraryApp.deleteEntry,
      moveRecipe: LibraryApp.moveEntry,
      restoreBuiltins: LibraryApp.restoreBuiltins,
      pickImage: LibraryApp.pickImage,
      save: LibraryApp.save,
      cancel: LibraryApp.cancel
    }
  };

  static PARTS = { main: { template: `systems/${SYSTEM_ID}/templates/editors/recipe-library.hbs` } };

  static LIBRARY = Object.freeze({
    noun: 'recipe',
    rowClass: 'rl-recipe',
    dragType: RECIPE_DRAG_TYPE,
    tabs: TABS,
    addTooltip: SHEET_TOOLTIP_IDS.NEW_RECIPE,
    stationType: DOWNTIME_STATION_TYPES.COOKING,
    normalize: normalizeRecipe,
    create: newRecipe
  });

  /* -------------------------------------------- */
  /*  Library parts                               */
  /* -------------------------------------------- */
  async _inspectLibrary() {
    return game.emblemRpg.api.downtime.inspectRecipeLibrary();
  }

  _detailContext(selected) {
    return {
      ingredients: (selected?.ingredients ?? []).map(entry => ({
        ...entry, img: entry.img || INGREDIENT_FALLBACK_IMAGE
      })),
      growths: selected ? GROWTH_KEYS.map(key => ({
        key, label: GROWTH_STAT_LABEL[key], value: selected.growths[key] ?? '',
        tooltip: getTooltip(SHEET_TOOLTIP_IDS.RECIPE_GROWTH, { label: GROWTH_STAT_LABEL[key] })
      })) : []
    };
  }

  /** Wire the growth fields and the ingredient list with its Resource search. */
  _wireDetail({ root, selected, byName, markDirty }) {
    for (const key of GROWTH_KEYS) {
      byName(`growth_${key}`)?.addEventListener('change', event => {
        const growths = { ...selected.growths, [key]: event.target.value };
        selected.growths[key] = normalizeRecipe({ ...selected, growths }, selected.id).growths[key];
        event.target.value = selected.growths[key] ?? '';
        markDirty();
      });
    }
    const list = root.querySelector('.craft-material-list');
    const container = root.querySelector('.craft-material-search');
    const input = root.querySelector("[name='ingredientSearch']");
    if (list && container && input) {
      const refresh = wireMaterialList(list, selected.ingredients, markDirty, 'No ingredients required');
      wireSearch(container, input, selected.ingredients, () => { refresh(); markDirty(); }, {
        resourceTypes: INGREDIENT_RESOURCE_TYPES
      });
      list.addEventListener('change', markDirty);
    }
  }

  async _saveLibrary(recipes) {
    return game.emblemRpg.api.downtime.saveRecipeLibrary({ recipes });
  }
}

/**
 * Follow a recipe library change: the open library re-reads unless it has unsaved edits, and the sheets repaint.
 * init/hooks.mjs calls it when the recipe library revision setting changes, after reloading the library.
 */
export function refreshRecipeLibraryViews() {
  RecipeLibraryApp.refreshViews();
}
