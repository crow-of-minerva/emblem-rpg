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
 * Bar Brawl's subdivision settings. A Character's stance bar never keeps them, so it shows the real stance count
 * that drawStanceSegments divides.
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
 * An invisible bar. An Object keeps one for each native bar it doesn't show, because Bar Brawl expects an entry for
 * both bar1 and bar2. It reads no actor data and is hidden from every viewer.
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

/**
 * The Bar Brawl bars for an Object: bar2 shows Integrity on a Destructible that isn't broken, and every other native
 * bar is an OBJECT_HIDDEN_BAR entry. A repair turns bar2 back into the Integrity bar, whose GM setting of INHERIT
 * replaces the hidden entry's. With more than one segment the Integrity bar shows dividers instead of a number.
 */
function buildObjectResourceBars(actor) {
  const bars = Object.fromEntries(LEGACY_BAR_IDS.map(id => [id, { id, ...OBJECT_HIDDEN_BAR }]));
  if (actor?.system?.objectType !== 'Destructible' || objectDestroyed(actor)) return bars;
  const segments = stanceMaximum(actor);
  bars[STANCE_BAR_ID] = {
    ...OBJECT_STANCE_BAR, label: segments > 1 ? '' : 'Stn', style: segments > 1 ? 'none' : 'fraction'
  };
  return bars;
}

/** Seed Bar Brawl's native prototype-token data before a Character is created. */
export function onPreCreateActorBars(actor) {
  if (actor.type !== 'Character') return;
  actor.updateSource(prototypeBarUpdate(actor));
}

/** Bring a new Character's bars up to date on the active GM's client, whichever user created it. */
export function onCreateActorBars(actor) {
  if (actor.type !== 'Character' || !isActiveGm()) return;
  queueSynchronization(actor);
}

/** Recolour bars when a Character changes faction, redraw them when its shields move, and follow an Object's state. */
export function onUpdateActorBars(actor, changes) {
  if (actor.type === 'Object') {
    if (hasPath(changes, 'system.objectType') || hasPath(changes, 'system.resources.stn')) queueSynchronization(actor);
    return;
  }
  if (actor.type !== 'Character') return;
  if (hasPath(changes, 'system.resources.shields.value')) {
    for (const token of actor.getActiveTokens(true)) token.drawBars();
  }
  if (hasSystemUpdate(changes)) queueSynchronization(actor);
}

/** Keep the stored segment count current when an embedded Class or Item changes derived stance. */
export function onEmbeddedItemBars(item) {
  const actor = item.parent;
  if (actor?.type === 'Character') queueSynchronization(actor);
}

/**
 * On ready, the active GM brings bar settings up to date: every Object's prototype and tokens on every scene, and
 * every Character's prototype and its tokens on the scene being viewed.
 */
export async function onReadyBarBrawl() {
  if (!barBrawlActive() || !isActiveGm()) return;
  for (const actor of collectionValues(game.actors)) {
    const object = actor.type === 'Object';
    if (actor.type !== 'Character' && !object) continue;
    if (object && objectBarsInSync(actor)) continue;
    try {
      await (object ? synchronizeObjectBars(actor) : synchronizeCharacterBars(actor));
    } catch (error) {
      reportFoundryError(import.meta.url, error, `Emblem RPG | Could not reconcile token bars for ${actor.name}.`);
    }
  }
}

/**
 * Save an Object's bar settings on its prototype and on its tokens in every scene. Each token follows its own
 * actor, because an unlinked Destructible has its own Integrity. A synthetic token actor updates only its token.
 */
async function synchronizeObjectBars(actor) {
  if (!barBrawlActive() || actor.type !== 'Object' || !isActiveGm()) return;
  if (actor.isToken) {
    if (actor.token && !objectTokenBarsMatch(actor.token, actor)) {
      await actor.token.update(objectTokenBarUpdate(actor, actor.token));
    }
    return;
  }
  if (!objectBarsInSync(actor)) {
    await actor.update(Object.fromEntries(Object.entries(objectTokenBarUpdate(actor, actor.prototypeToken))
      .map(([path, value]) => [`prototypeToken.${path}`, value])));
  }
  for (const scene of collectionValues(game.scenes)) {
    const updates = collectionValues(scene?.tokens)
      .filter(token => token.actorId === actor.id && !objectTokenBarsMatch(token, token.actor ?? actor))
      .map(token => ({ _id: token.id, ...objectTokenBarUpdate(token.actor ?? actor, token) }));
    if (updates.length > 0) await scene.updateEmbeddedDocuments('Token', updates);
  }
}

/** Whether an Object's prototype already has exactly the bars its type and Integrity call for. */
function objectBarsInSync(actor) {
  return objectTokenBarsMatch(actor?.prototypeToken, actor);
}

/**
 * Whether an Object's prototype or placed token holds exactly the bars objectBarContract lists, each with the
 * contract's fields. Other fields Bar Brawl's token form saves on a bar are not compared, since the merge write
 * objectTokenBarUpdate sends keeps them.
 */
function objectTokenBarsMatch(token, actor) {
  const contract = objectBarContract(actor);
  const bars = token?.flags?.barbrawl?.resourceBars ?? {};
  return structurallyEqual(Object.keys(bars).sort(), Object.keys(contract.bars).sort())
    && Object.entries(contract.bars).every(([id, bar]) => barHoldsFields(bars[id], bar))
    && LEGACY_BAR_IDS.every(id => (token?.[id]?.attribute ?? null) === contract.attributes[id]);
}

/**
 * Save a Character's HP and stance bar settings on its prototype and on its tokens on the canvas, each only when
 * characterBarsMatch finds a difference. A token's synthetic actor shows its base actor's prototype and its
 * ActorDelta can't store one, so only a world actor's prototype is written.
 */
async function synchronizeCharacterBars(actor) {
  if (!barBrawlActive() || actor.type !== 'Character' || !isActiveGm()) return;
  const update = prototypeBarUpdate(actor);
  const prototype = actor.prototypeToken;
  if (!actor.isToken && !characterBarsMatch(prototype, update['prototypeToken.flags.barbrawl.resourceBars'])) {
    await actor.update({ ...update, ...approximationDeletions(prototype, 'prototypeToken.') });
  }

  const activeTokens = actor.getActiveTokens(true);
  const bars = buildCharacterResourceBars(actor);
  for (const token of activeTokens) {
    const document = token.document;
    const tokenBars = buildCharacterResourceBars(actor, document.flags?.barbrawl?.resourceBars ?? bars);
    if (characterBarsMatch(document, tokenBars)) continue;
    await document.update({ ...tokenBarUpdate(tokenBars), ...approximationDeletions(document) });
  }
}

/* -------------------------------------------- */
/*  Stance presentation                         */
/* -------------------------------------------- */
/**
 * Decorate Bar Brawl's bars on a token (drawToken hook): stance dividers, the shield ring on the HP bar, and room
 * for the wield badge. It watches the container for bars Bar Brawl adds later and redraws once per frame at most.
 */
export function onDrawTokenBars(token) {
  const container = token?.bars;
  if (!container) return;
  let binding = barRenderBindings.get(token);
  if (binding?.container !== container) {
    releaseBarRenderBinding(token);
    const onChildAdded = child => {
      reserveWieldBadgeSpace(token, child);
      if (child?.name === STANCE_BAR_ID) drawStanceSegments(token, child);
      if (child?.name === HP_BAR_ID) drawShieldOverlay(token, child);
    };
    container.on?.('childAdded', onChildAdded);
    binding = { container, onChildAdded, frame: null };
    barRenderBindings.set(token, binding);
  }
  scheduleStanceSegments(token, binding);
}

/** Re-apply the bar decorations after Bar Brawl or Foundry refreshes a token. */
export function onRefreshTokenBars(token) {
  onDrawTokenBars(token);
}

/** Release the Bar Brawl container listener for a destroyed token. */
export function onDestroyTokenBars(token) {
  releaseBarRenderBinding(token);
}

/**
 * Release all Bar Brawl presentation listeners before the canvas is replaced. `init/hooks.mjs` runs this on every
 * `canvasTearDown` to remove the listeners on each token's bar container.
 */
export function disposeTokenBars() {
  for (const token of [...barRenderBindings.keys()]) releaseBarRenderBinding(token);
}

/** Redraw native bars when a wield marker appears, disappears, or changes origin. */
export function onActiveEffectBars(effect) {
  if (!isWieldEffect(effect)) return;
  for (const token of effect?.parent?.getActiveTokens?.(true) ?? []) token.drawBars?.();
}

/* -------------------------------------------- */
/*  Configuration helpers                       */
/* -------------------------------------------- */
function applyCommon(bar, label, attribute, order) {
  Object.assign(bar, {
    id: bar.id || `bar${order + 1}`,
    order,
    attribute,
    label,
    position: 'bottom-inner',
    ownerVisibility: ALWAYS,
    otherVisibility: ALWAYS,
    indentLeft: 10,
    indentRight: 10,
    style: 'fraction'
  });
}

function stanceMaximum(actor) {
  const maximum = Number(actor?.system?.resources?.stn?.max);
  return Number.isFinite(maximum) && maximum > 0 ? Math.round(maximum) : 1;
}

function scheduleStanceSegments(token, binding) {
  if (binding.frame !== null) return;
  const requestFrame = globalThis.requestAnimationFrame ?? (callback => setTimeout(callback, 0));
  binding.frame = requestFrame(() => {
    binding.frame = null;
    for (const bar of binding.container.children ?? []) reserveWieldBadgeSpace(token, bar);
    const stanceBar = barChild(binding.container, STANCE_BAR_ID);
    if (stanceBar) drawStanceSegments(token, stanceBar);
    const hpBar = barChild(binding.container, HP_BAR_ID);
    if (hpBar) drawShieldOverlay(token, hpBar);
  });
}

/** Shift and shorten one native bottom bar by the exact slot occupied by the wield badge. */
function reserveWieldBadgeSpace(token, bar) {
  if (!['bar1', 'bar2'].includes(bar?.name) || bar.emblemWieldReserveApplied === true) return;
  const reserve = Math.max(0, Number(wieldBadgeReserve(token)) || 0);
  const currentX = Number(bar.position?.x ?? bar.x) || 0;
  const currentWidth = Number(bar.contentWidth) || 0;
  if (!(reserve > currentX) || !(currentWidth > reserve - currentX)) return;

  const width = currentWidth - (reserve - currentX);
  const ratio = width / currentWidth;
  if (bar.position) bar.position.x = reserve;
  else bar.x = reserve;
  for (const child of bar.children ?? []) {
    if (child?.name === `${bar.name}-text`) {
      child.x = width / 2;
    } else if (child?.name === 'gfx' && child.scale) {
      child.scale.x *= ratio;
    } else if (Number.isFinite(child?.width)) {
      child.width *= ratio;
    }
  }
  bar.contentWidth = width;
  bar.emblemWieldReserveApplied = true;
}

/**
 * The width the wield marker's status slot takes at the Token's bottom-left, where
 * presentation/token/rendering.mjs draws it, or 0 when the Token carries no wield marker.
 */
function wieldBadgeReserve(token) {
  if (!projectFoundryTokenEffects(token).some(effect => effect.wield === true)) return 0;
  return STATUS_ICON_SLOT * (Number(globalThis.canvas?.dimensions?.uiScale) || 1);
}

function drawStanceSegments(token, bar) {
  const previous = barChild(bar, STANCE_SEGMENTS_NAME);
  const maximum = stanceMaximum(token?.actor);
  const borderWidth = barBorderWidth();
  const signature = `${maximum}@${bar.contentWidth}x${bar.contentHeight}:${borderWidth}`;
  if (previous && !previous.destroyed && previous.parent === bar && previous.emblemStanceSignature === signature) return;
  if (previous) {
    previous.parent?.removeChild?.(previous);
    previous.destroy?.();
  }

  if (maximum <= 1 || !globalThis.PIXI?.Graphics || !(bar.contentWidth > 0) || !(bar.contentHeight > 0)) return;
  const segments = new PIXI.Graphics();
  segments.name = STANCE_SEGMENTS_NAME;
  segments.emblemStanceSignature = signature;
  segments.lineStyle(borderWidth, 0x000000, 1);
  const segmentWidth = bar.contentWidth / maximum;
  for (let index = 1; index < maximum; index += 1) {
    const x = segmentWidth * index;
    segments.moveTo(x, 0);
    segments.lineTo(x, bar.contentHeight);
  }
  bar.addChild(segments);
}

/* -------------------------------------------- */
/*  Shield presentation                         */
/* -------------------------------------------- */
/**
 * Trace the shield ring over the HP bar and retint its label to the shielded total.
 *
 * scheduleStanceSegments runs this on every Token refresh, which is every frame while the unit moves, so a ring
 * drawn from the same shield fraction and bar size is kept and only moved back on top, where a rebuild would put it.
 */
function drawShieldOverlay(token, bar) {
  const previous = barChild(bar, SHIELD_OVERLAY_NAME);
  const hp = token?.actor?.system?.resources?.hp ?? {};
  const maximum = Number(hp.max) || 0;
  const shields = Number(token?.actor?.system?.resources?.shields?.value) || 0;
  const drawable = maximum > 0 && shields > 0 && Boolean(globalThis.PIXI?.Graphics)
    && bar.contentWidth > 0 && bar.contentHeight > 0;
  const fraction = drawable ? Math.min(shields / maximum, 1) : 0;
  const signature = drawable ? `${fraction}@${bar.contentWidth}x${bar.contentHeight}:${barBorderRadius()}` : '';
  const kept = drawable && previous && !previous.destroyed && previous.emblemShieldSignature === signature;
  if (previous && !kept) {
    bar.removeChild?.(previous);
    previous.destroy?.();
  }
  if (!drawable) return;
  if (!kept) {
    const ring = shieldRing(bar, fraction);
    ring.emblemShieldSignature = signature;
    bar.addChild(ring);
  } else if (bar.children?.at?.(-1) !== previous) bar.addChild(previous);
  retintShieldLabel(token, bar, { value: Number(hp.value) || 0, maximum, shields });
}

/**
 * Build the shield ring's three strokes around the Bar Brawl health bar. The outline runs from the left over the
 * shielded share of the bar, and closes into a full rectangle when shields cover the whole width.
 */
function shieldRing(bar, fraction) {
  const width = bar.contentWidth;
  const height = bar.contentHeight;
  const radius = barBorderRadius();
  const covered = width * fraction;
  const full = covered >= width - 0.5;
  const corner = Math.max(0, Math.min(radius, covered / 2, height / 2));
  const overlay = new PIXI.Graphics();
  overlay.name = SHIELD_OVERLAY_NAME;
  for (const stroke of SHIELD_STROKES) {
    overlay.lineStyle(stroke.width, SHIELD_TINT, stroke.alpha, 0.5);
    if (full) {
      overlay.drawRoundedRect(0, 0, width, height, radius);
      continue;
    }
    overlay.moveTo(covered, 0);
    overlay.lineTo(corner, 0);
    overlay.quadraticCurveTo(0, 0, 0, corner);
    overlay.lineTo(0, height - corner);
    overlay.quadraticCurveTo(0, height, corner, height);
    overlay.lineTo(covered, height);
  }
  return overlay;
}

/** Split the Bar Brawl health label into normal and shield-colored text runs. */
function retintShieldLabel(token, bar, { value, maximum, shields }) {
  const name = `${bar.name}-text`;
  const existing = barChild(bar, name);
  if (!existing || existing.emblemShieldLabel === true) return;
  if (!globalThis.PIXI?.Text || !globalThis.PIXI?.Container) return;
  const configuration = token?.document?.flags?.[MODULE_ID]?.resourceBars?.[bar.name] ?? {};
  const style = String(configuration.style ?? 'fraction');
  if (style === 'none') return;
  const prefix = configuration.label ? `${configuration.label}  ` : '';
  const runs = style === 'percent'
    ? [[prefix, null], [`${Math.round((Math.min(Math.max(value, 0), maximum) / maximum) * 100)}%`, SHIELD_TINT_CSS]]
    : [
      [prefix, null],
      [formatBarValue(value + Math.round(shields)), SHIELD_TINT_CSS],
      [` / ${formatBarValue(maximum)}`, null]
    ];
  const font = existing.style;
  const x = existing.x;
  const y = existing.y;
  const flipped = existing.scale?.x < 0;
  bar.removeChild?.(existing);
  existing.destroy?.();
  bar.addChild(segmentedLabel(name, runs, font, { x, y, flipped }));
}

/** Lay out and center the Bar Brawl label’s text runs as one group. */
function segmentedLabel(name, runs, font, { x, y, flipped }) {
  const container = new PIXI.Container();
  container.name = name;
  container.emblemShieldLabel = true;
  let cursor = 0;
  for (const [text, colour] of runs) {
    if (!text) continue;
    const runStyle = colour && font?.clone ? Object.assign(font.clone(), { fill: colour }) : font;
    const run = new PIXI.Text(text, runStyle);
    run.resolution = 2;
    run.anchor.set(0, 0.5);
    run.x = cursor;
    cursor += run.width;
    container.addChild(run);
  }
  container.pivot.set(cursor / 2, 0);
  container.x = x;
  container.y = y;
  if (flipped) container.scale.x = -1;
  return container;
}

/** Whole numbers print as they are, and anything else keeps one decimal, as Bar Brawl's own label does. */
function formatBarValue(value) {
  const number = Number(value) || 0;
  if (Number.isInteger(number)) return String(number);
  const rounded = Math.round(number * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function barBorderRadius() {
  return barStyleName() === 'minimal' ? 0 : barStyleName() === 'legacy' ? 3 : 2;
}

function barChild(container, name) {
  return container?.getChildByName?.(name) ?? container?.children?.find(child => child.name === name) ?? null;
}

function barBorderWidth() {
  return barStyleName() === 'legacy' ? 2 : 1;
}

function barStyleName() {
  try {
    return String(game.settings.get(MODULE_ID, 'barStyle') || 'default');
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'barStyleName', /is not a registered game setting$/.test(String(diagnosticError?.message ?? '')));
    return 'default';
  }
}

function releaseBarRenderBinding(token) {
  const binding = barRenderBindings.get(token);
  if (!binding) return;
  binding.container.off?.('childAdded', binding.onChildAdded);
  if (binding.frame !== null) {
    const cancelFrame = globalThis.cancelAnimationFrame ?? clearTimeout;
    cancelFrame(binding.frame);
  }
  barRenderBindings.delete(token);
}

function prototypeBarUpdate(actor) {
  const bars = buildCharacterResourceBars(actor);
  return {
    'prototypeToken.flags.barbrawl.resourceBars': bars,
    'prototypeToken.bar1.attribute': 'resources.hp',
    'prototypeToken.bar2.attribute': 'resources.stn',
    'prototypeToken.displayBars': displayAlways()
  };
}

function tokenBarUpdate(bars) {
  return {
    'flags.barbrawl.resourceBars': bars,
    'bar1.attribute': 'resources.hp',
    'bar2.attribute': 'resources.stn',
    displayBars: displayAlways()
  };
}

/**
 * Whether a prototype or placed token already shows the Character bars `bars`. Only the fields `bars` carries are
 * compared, since buildCharacterResourceBars copies every other stored field, and a stance bar that still
 * approximates its value is a difference.
 */
function characterBarsMatch(token, bars) {
  const stored = token?.flags?.barbrawl?.resourceBars ?? {};
  return !stanceApproximated(token)
    && Object.entries(bars).every(([id, bar]) => barHoldsFields(stored[id], bar))
    && token?.bar1?.attribute === 'resources.hp'
    && token?.bar2?.attribute === 'resources.stn'
    && token?.displayBars === displayAlways();
}

/** Whether a stored Bar Brawl bar has every field of `bar` at the same value, whatever other fields it keeps. */
function barHoldsFields(stored, bar) {
  return Object.entries(bar).every(([field, value]) => structurallyEqual(stored?.[field], value));
}

/**
 * Update keys that delete the stance bar's subdivision settings, if it still has them. A merge update would
 * otherwise keep them, since buildCharacterResourceBars leaves them out.
 */
function approximationDeletions(token, prefix = '') {
  if (!stanceApproximated(token)) return {};
  const stance = token.flags.barbrawl.resourceBars[STANCE_BAR_ID];
  return Object.assign({}, ...APPROXIMATION_FIELDS.filter(field => Object.hasOwn(stance, field))
    .map(field => forcedDeletion(`${prefix}flags.barbrawl.resourceBars.${STANCE_BAR_ID}.${field}`)));
}

/**
 * Whether Bar Brawl approximates a token's stored stance bar, which it does only while `subdivisions` is set. Its
 * token form saves an unset one as null, which changes nothing and stays.
 */
function stanceApproximated(token) {
  return Boolean(token?.flags?.barbrawl?.resourceBars?.[STANCE_BAR_ID]?.subdivisions);
}

/**
 * Queue one bar synchronization per unit however many writes ask for it. A request made while one is still waiting
 * to start joins it, since that run reads the unit when it starts. A request made during a run queues one more.
 */
function queueSynchronization(actor) {
  if (waitingSynchronizations.has(actor)) return;
  waitingSynchronizations.add(actor);
  const synchronize = actor.type === 'Object' ? synchronizeObjectBars : synchronizeCharacterBars;
  const previous = pendingSynchronizations.get(actor) ?? Promise.resolve();
  const current = previous
    .catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'current', null, false); })
    .then(() => {
      waitingSynchronizations.delete(actor);
      return synchronize(actor);
    });
  pendingSynchronizations.set(actor, current);
  void current.catch(error => {
    reportFoundryError(import.meta.url, error, `Emblem RPG | Could not reconcile token bars for ${actor.name}.`);
  }).finally(() => {
    if (pendingSynchronizations.get(actor) === current) pendingSynchronizations.delete(actor);
  });
}

/* -------------------------------------------- */
/*  Host helpers                                */
/* -------------------------------------------- */
function barBrawlActive() {
  return moduleActive(MODULE_ID);
}

function displayAlways() {
  return CONST.TOKEN_DISPLAY_MODES.ALWAYS;
}

/**
 * The bars and native bar attributes an Object's type and Integrity call for. Each native attribute follows its bar
 * the way Bar Brawl pairs them, so a custom bar has none.
 */
function objectBarContract(actor) {
  const bars = buildObjectResourceBars(actor);
  const attributes = Object.fromEntries(LEGACY_BAR_IDS.map(id => {
    const { attribute } = bars[id];
    return [id, attribute === CUSTOM_ATTRIBUTE ? null : attribute];
  }));
  return { bars, attributes };
}

/**
 * The token update that gives an Object exactly the bars objectBarContract lists. Foundry merges it over the stored
 * bars, so other fields Bar Brawl's token form saved stay. Extra bars are deleted rather than set to null, because
 * Bar Brawl's preUpdateToken handler reads every bar in the update. Both native attributes are written too.
 */
function objectTokenBarUpdate(actor, token = null) {
  const { bars, attributes } = objectBarContract(actor);
  const current = token?.flags?.barbrawl?.resourceBars ?? {};
  const write = { 'flags.barbrawl.resourceBars': bars };
  for (const key of Object.keys(current)) {
    if (!(key in bars)) Object.assign(write, forcedDeletion(`flags.barbrawl.resourceBars.${key}`));
  }
  for (const id of LEGACY_BAR_IDS) write[`${id}.attribute`] = attributes[id];
  return write;
}

function objectDestroyed(actor) {
  const stance = actor?.system?.resources?.stn?.value;
  return stance !== undefined && stance !== null && Number(stance) <= 0;
}

function hasPath(changes, path) {
  return foundry.utils.hasProperty(changes ?? {}, path);
}

function clone(value) {
  return foundry.utils.duplicate(value);
}

function hasSystemUpdate(changes) {
  if (!changes || typeof changes !== 'object') return false;
  return Object.hasOwn(changes, 'system') || Object.keys(changes).some(key => key.startsWith('system.'));
}

function isWieldEffect(effect) {
  return readEffectFlags(effect).isWieldEffect === true;
}
