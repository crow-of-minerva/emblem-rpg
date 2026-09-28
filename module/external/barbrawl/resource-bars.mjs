/** @layer external/barbrawl */
import { forcedDeletion, isActiveGm, readEffectFlags } from '../../foundry/adapters/services/host.mjs';
import { collectionValues, structurallyEqual } from '../../lib/core/runtime.mjs';
import { moduleActive } from '../host.mjs';
import { reportFoundryError, reportFoundryProbe } from '../../foundry/adapters/services/diagnostics.mjs';
import { projectFoundryTokenEffects } from '../../foundry/adapters/projections/tokens.mjs';
import { STATUS_ICON_SLOT } from '../../contracts/domains/tokens.mjs';

/* -------------------------------------------- */
/*  Bar vocabulary                              */
/* -------------------------------------------- */
const MODULE_ID = 'barbrawl';
const ALWAYS = 50;
/** Bar Brawl's visibility values besides ALWAYS: a GM setting of INHERIT follows the owner's, and NONE never draws. */
const INHERIT = -1;
const NONE = 0;
/** The attribute of a Bar Brawl bar that reads no actor data, which Bar Brawl pairs with no native attribute. */
const CUSTOM_ATTRIBUTE = 'custom';
const HP_BAR_ID = 'bar1';
const STANCE_BAR_ID = 'bar2';
const LEGACY_BAR_IDS = Object.freeze([HP_BAR_ID, STANCE_BAR_ID]);
/**
 * Bar Brawl's value approximation fields, which a Character's stance bar never keeps: while `subdivisions` is set,
 * Bar Brawl shows the stance value on a scale of its own instead of the count drawStanceSegments divides.
 */
const APPROXIMATION_FIELDS = Object.freeze(['subdivisions', 'subdivisionsOwner']);
const STANCE_SEGMENTS_NAME = 'stanceSegments';
const SHIELD_OVERLAY_NAME = 'shieldOverlay';
const SHIELD_TINT = 0x1fffe0;
const SHIELD_TINT_CSS = '#1fffe0';
const SHIELD_STROKES = Object.freeze([
  Object.freeze({ width: 9, alpha: 0.14 }),
  Object.freeze({ width: 6, alpha: 0.3 }),
  Object.freeze({ width: 3.5, alpha: 1 })
]);
const OBJECT_STANCE_BAR = Object.freeze({
  id: STANCE_BAR_ID,
  attribute: 'resources.stn',
  label: 'Stn',
  position: 'bottom-inner',
  ownerVisibility: ALWAYS,
  otherVisibility: ALWAYS,
  gmVisibility: INHERIT,
  indentLeft: 10,
  indentRight: 10,
  style: 'fraction',
  mincolor: '#815532',
  maxcolor: '#FFB638'
});
/**
 * The entry an Object keeps for a native bar it doesn't show. Bar Brawl's Token Config saves both native bar
 * attributes every time, and its preUpdateToken handler (synchronizeLegacyBar) reads the entry of each one saved
 * without an attribute, so an Object needs an entry for bar1 and bar2 alike. A custom bar saves with no native
 * attribute, and one hidden from every viewer is never drawn.
 */
const OBJECT_HIDDEN_BAR = Object.freeze({
  attribute: CUSTOM_ATTRIBUTE,
  ownerVisibility: NONE,
  otherVisibility: NONE,
  gmVisibility: NONE
});
const pendingSynchronizations = new WeakMap();
const waitingSynchronizations = new WeakSet();
const barRenderBindings = new Map();

export const FACTION_BAR_COLORS = Object.freeze({
  lord: Object.freeze({ mincolor: '#1660C0', maxcolor: '#0091FF' }),
  retainer: Object.freeze({ mincolor: '#1660C0', maxcolor: '#0091FF' }),
  enemy: Object.freeze({ mincolor: '#651818', maxcolor: '#C32929' }),
  boss: Object.freeze({ mincolor: '#651818', maxcolor: '#C32929' }),
  ally: Object.freeze({ mincolor: '#186518', maxcolor: '#10A42E' }),
  neutral: Object.freeze({ mincolor: '#3F1862', maxcolor: '#5C1CD4' }),
  default: Object.freeze({ mincolor: '#3F3F3F', maxcolor: '#9E9E9E' })
});

/* -------------------------------------------- */
/*  Public integration                          */
/* -------------------------------------------- */
/** Build Character health and stance bars over existing Bar Brawl configuration. */
function buildCharacterResourceBars(actor, existing = actor?.prototypeToken?.flags?.barbrawl?.resourceBars) {
  const bars = clone(existing ?? {});
  bars.bar1 ??= { id: 'bar1' };
  bars.bar2 ??= { id: 'bar2' };

  applyCommon(bars.bar1, 'HP', 'resources.hp', 1);
  applyCommon(bars.bar2, '', 'resources.stn', 0);

  const actorType = String(actor?.system?.faction?.role ?? '').toLowerCase();
  const palette = FACTION_BAR_COLORS[actorType] ?? FACTION_BAR_COLORS.default;
  const stanceSegments = stanceMaximum(actor);
  Object.assign(bars.bar1, palette);
  Object.assign(bars.bar2, {
    mincolor: '#815532',
    maxcolor: '#FFB638',
    label: stanceSegments > 1 ? '' : 'Stn',
    style: stanceSegments > 1 ? 'none' : 'fraction'
  });
  for (const field of APPROXIMATION_FIELDS) delete bars.bar2[field];
  return bars;
}
