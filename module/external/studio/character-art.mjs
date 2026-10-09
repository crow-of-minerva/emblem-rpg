/** @layer external/studio */

/* -------------------------------------------- */
/*  Studio result codes and art slots           */
/* -------------------------------------------- */
const MODULE_ID = 'emblem-rpg-studio';

export const STUDIO_OPEN_CODES = Object.freeze({
  OPENED: 'studio.opened',
  ACTOR_REQUIRED: 'studio.actor-required',
  BASE_ACTOR_REQUIRED: 'studio.base-actor-required',
  SLOT_UNKNOWN: 'studio.slot-unknown',
  TAB_NOT_FOUND: 'studio.tab-not-found',
  ENTRY_NOT_FOUND: 'studio.entry-not-found',
  ITEM_REQUIRED: 'studio.item-required',
  API_UNAVAILABLE: 'studio.api-unavailable'
});

const SLOT_TYPES = Object.freeze({
  default: 'default',
  armored: 'armored',
  cavalry: 'cavalry',
  armoredCavalry: 'armoredCavalry',
  flying: 'flying'
});

/* -------------------------------------------- */
/*  Public bridge                               */
/* -------------------------------------------- */
/**
 * Open Emblem Character Studio on one of an actor's art slots. A failure comes back as `{ok: false, code, data}`,
 * which the Actor Control Panel shows with showStudioFailure.
 * @param {Actor} actor Actor whose art is being edited.
 * @param {string} slot Art variant: default, armored, cavalry, armoredCavalry or flying.
 * @param {{tabId?: string, entryIndex?: number}} [options] The class tab, and the entry inside it.
 * @returns {Promise<object>} `{ok, code}`, plus the destination (`tuple`) and the opened application on success.
 */
export async function openStudioForSlot(actor, slot, options = {}) {
  const destination = studioDestinationForSlot(actor, slot, options);
  if (!destination.ok) return destination;

  const api = game.modules.get(MODULE_ID)?.api;
  if (typeof api?.openCharacterStudio !== 'function') {
    return failure(STUDIO_OPEN_CODES.API_UNAVAILABLE);
  }

  const application = await api.openCharacterStudio(actor, destination.tuple);
  return {
    ok: true,
    code: STUDIO_OPEN_CODES.OPENED,
    tuple: destination.tuple,
    application
  };
}

/**
 * Ask Studio for the actor update that copies the default token compositions to a new class tab. The Actor
 * Control Panel saves it along with the tab. Returns {} when Studio isn't available.
 */
export function studioClassSeedUpdate(actor, className) {
  const api = game.modules.get(MODULE_ID)?.api;
  if (typeof api?.getCharacterClassSeed !== 'function') return {};
  const update = api.getCharacterClassSeed(actor, className);
  return update && typeof update === 'object' ? update : {};
}

/**
 * Open Emblem Sprite Studio on an item's image. No permission check happens here; the Studio module decides.
 */
export async function openStudioForItem(item) {
  if (item?.documentName !== 'Item') return failure(STUDIO_OPEN_CODES.ITEM_REQUIRED);
  const api = game.modules.get(MODULE_ID)?.api;
  if (typeof api?.openSpriteStudio !== 'function') return failure(STUDIO_OPEN_CODES.API_UNAVAILABLE);
  const application = await api.openSpriteStudio(item);
  return { ok: true, code: STUDIO_OPEN_CODES.OPENED, application };
}

/**
 * Open Studio's scene crop, which cuts part of the scene's art into one of an actor's art states. Called by the
 * Object sheet's crop control.
 */
export async function openSceneCropForArtState(actor, target, field) {
  if (!actor) return failure(STUDIO_OPEN_CODES.ACTOR_REQUIRED);
  if (!target || !field) return failure(STUDIO_OPEN_CODES.SLOT_UNKNOWN, { slot: target });
  const api = game.modules.get(MODULE_ID)?.api;
  if (typeof api?.openSceneCrop !== 'function') return failure(STUDIO_OPEN_CODES.API_UNAVAILABLE);
  const src = await api.openSceneCrop({ actorUuid: actor.uuid, target, field });
  return { ok: true, code: STUDIO_OPEN_CODES.OPENED, src };
}

/**
 * The destination record Studio's `openCharacterStudio` takes, as Studio's module API documents it. This is a JSDoc
 * type path only and never runs.
 * @typedef {import('../../../../../modules/emblem-rpg-studio/module/api.mjs').StudioDestination} StudioDestination
 */

/**
 * Turn an art slot, class tab and entry into the destination Character Studio opens on. Refuses a token or
 * compendium actor, an unknown slot, and a tab or entry the actor doesn't have.
 * @returns {{ok: true, tuple: StudioDestination}|{ok: false, code: string, data: object}} The destination to open,
 *   or the failure's code from STUDIO_OPEN_CODES and what it names.
 */
function studioDestinationForSlot(actor, slot, options = {}) {
  if (!actor) return failure(STUDIO_OPEN_CODES.ACTOR_REQUIRED);
  if (actor.isToken || actor.pack) return failure(STUDIO_OPEN_CODES.BASE_ACTOR_REQUIRED);

  const type = SLOT_TYPES[slot];
  if (!type) return failure(STUDIO_OPEN_CODES.SLOT_UNKNOWN, { slot });

  const { tabId, entryIndex } = options;
  let classKey = 'Default';
  let entry = '';
  let resolvedEntryIndex = null;
  let entryId = null;

  if (tabId && tabId !== 'default') {
    const tab = (actor.system?.art?.tabs ?? []).find(candidate => candidate.id === tabId);
    if (!tab) {
      return failure(STUDIO_OPEN_CODES.TAB_NOT_FOUND, { tabId, actorName: actor.name });
    }
    classKey = String(tab.name || '').trim() || 'Default';

    if (Number.isInteger(entryIndex) && entryIndex >= 0) {
      const candidate = tab.entries?.[entryIndex];
      if (!candidate) return failure(STUDIO_OPEN_CODES.ENTRY_NOT_FOUND, { tabId, entryIndex });
      entry = String(candidate.name || '').trim();
      resolvedEntryIndex = entryIndex;
      entryId = candidate.id || null;
    }
  }

  return {
    ok: true,
    tuple: Object.freeze({
      classKey,
      tabId: tabId && tabId !== 'default' ? tabId : null,
      entry,
      entryIndex: resolvedEntryIndex,
      ...(entryId ? { entryId } : {}),
      type
    })
  };
}

/* -------------------------------------------- */
/*  Outcomes                                    */
/* -------------------------------------------- */
function failure(code, data = {}) {
  return { ok: false, code, data };
}
