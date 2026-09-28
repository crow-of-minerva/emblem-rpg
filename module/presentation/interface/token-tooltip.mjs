/** @layer presentation/interface */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { escapeHtml } from '../../lib/dom/html.mjs';
import { INSPECTION_KINDS } from '../../contracts/domains/board.mjs';

/* -------------------------------------------- */
/*  Overlay configuration                       */
/* -------------------------------------------- */
const ROOT_CLASS = 'emblem-token-tooltip';
const DAMAGE_ICON_PATH = `systems/${SYSTEM_ID}/assets/ui/dmg-types`;
const UNIT_ICON_PATH = `systems/${SYSTEM_ID}/assets/ui/unit-types`;
const PLACEMENT = Object.freeze({ gapX: 16, offsetY: -8, edge: 20, min: 10, tabs: 24 });
const SCALE_BOUNDS = Object.freeze({ min: 0.5, max: 1, authored: 0.5 });
const DEFAULT_SCALE = 0.75;
const SPEED_CLASSES = Object.freeze({
  '2': 'tooltip-spd-fast-major',
  '1': 'tooltip-spd-fast-minor',
  '0': '',
  '-1': 'tooltip-spd-slow-minor',
  '-2': 'tooltip-spd-slow-major'
});
let element = null;
let visible = false;

/* -------------------------------------------- */
/*  Overlay lifecycle                           */
/* -------------------------------------------- */
/**
 * Fill the tooltip from one inspection record and show it beside its anchor. ui/controls/interaction.mjs calls it
 * for the token being inspected.
 * @param {object} inspection Frozen facts describing the hovered Token.
 * @param {object} anchor Screen-space rectangle the tooltip sits beside.
 * @param {number} [scale] Reader's tooltip scale, where 0.5 draws it at its authored size.
 */
export function showTokenTooltip(inspection, anchor, scale = DEFAULT_SCALE) {
  if (!inspection) return false;
  const root = ensureElement();
  if (!root) return false;
  root.innerHTML = renderInspection(inspection);
  root.classList.toggle('has-tabs', (inspection.attacks?.length ?? 0) > 0);
  root.style.zoom = String(tooltipZoom(scale));
  root.style.display = 'block';
  visible = true;
  positionTokenTooltip(anchor);
  return true;
}

/** Take the tooltip out of view, leaving it mounted for the next hover. */
export function hideTokenTooltip() {
  if (!element) return;
  element.style.display = 'none';
  visible = false;
}

/** Report whether the tooltip is currently showing. */
export function isTokenTooltipVisible() {
  return visible;
}

/* -------------------------------------------- */
/*  Placement                                   */
/* -------------------------------------------- */
/** Turn the reader's scale into the zoom the panel is drawn at, clamped to the range the setting allows. */
function tooltipZoom(scale) {
  const wanted = Number(scale);
  const bounded = Number.isFinite(wanted)
    ? Math.min(SCALE_BOUNDS.max, Math.max(SCALE_BOUNDS.min, wanted))
    : DEFAULT_SCALE;
  return bounded / SCALE_BOUNDS.authored;
}

/**
 * Sit the tooltip beside its anchor, flipped away from the right edge and clamped vertically.
 *
 * Every measurement here is in screen pixels. A zoomed panel reads its own `left` and `top` in its zoomed
 * space, so the settled position is divided by the zoom on the way out.
 * @param {object} anchor Screen-space rectangle `{left, top, width}` of the described Token.
 */
export function positionTokenTooltip(anchor) {
  if (!element || !anchor) return;
  const own = element.getBoundingClientRect();
  const zoom = Number(element.style.zoom) || 1;
  const overhang = (element.classList.contains('has-tabs') ? PLACEMENT.tabs : 0) * zoom;
  let left = anchor.left + (anchor.width ?? 0) + PLACEMENT.gapX;
  let top = anchor.top + PLACEMENT.offsetY;
  const flipped = left + own.width + overhang > window.innerWidth - PLACEMENT.edge;
  if (flipped) left = anchor.left - own.width - PLACEMENT.gapX;
  if (top + own.height > window.innerHeight - PLACEMENT.edge) top = window.innerHeight - own.height - PLACEMENT.edge;
  if (top < PLACEMENT.edge) top = PLACEMENT.edge;
  element.classList.toggle('tabs-left', flipped);
  element.style.left = `${Math.max(PLACEMENT.min + (flipped ? overhang : 0), left) / zoom}px`;
  element.style.top = `${Math.max(PLACEMENT.min, top) / zoom}px`;
}

/* -------------------------------------------- */
/*  Inspection markup                           */
/* -------------------------------------------- */
function renderInspection(inspection) {
  if (inspection.kind === INSPECTION_KINDS.NAME_ONLY) return header(inspection);
  if (inspection.kind === INSPECTION_KINDS.LOCK) return header(inspection) + renderLock(inspection);
  if (inspection.kind === INSPECTION_KINDS.ARMAMENT) return header(inspection) + renderArmament(inspection);
  if (inspection.kind === INSPECTION_KINDS.DESTRUCTIBLE) return header(inspection) + renderDestructible(inspection);
  return tabs(inspection.attacks) + header(inspection) + renderUnit(inspection);
}

function renderUnit(inspection) {
  const stats = inspection.stats;
  const speedClass = SPEED_CLASSES[String(inspection.speedBand)] ?? '';
  return ledger([
    ['Atk', stats.atk], ['Brk', stats.brk],
    ['Acc', stats.acc], ['Crit', stats.crit],
    ['Def', stats.def], ['Res', stats.res],
    ['Eva', stats.eva], ['Spd', stats.spd, speedClass]
  ])
    + '<div class="tooltip-rule"></div>'
    + affinityRow('Dmg Type', damageIcons(inspection.damageTypes))
    + affinities(inspection);
}

function renderArmament(inspection) {
  const stats = inspection.stats;
  return ledger([
    ['Atk', stats.atk], ['Brk', stats.brk],
    ['Acc', stats.acc], ['Crit', stats.crit],
    ['Rng', stats.rng], ['Dur', inspection.durability, inspection.broken ? 'tooltip-broken' : 'tooltip-resource']
  ])
    + '<div class="tooltip-rule"></div>'
    + affinityRow('Dmg Type', damageIcons(inspection.damageTypes))
    + effectiveRow(inspection.effectiveAgainst);
}

function renderDestructible(inspection) {
  return statRow('Integrity', inspection.integrity, 'tooltip-resource')
    + '<div class="tooltip-rule"></div>'
    + affinities(inspection);
}

function renderLock(inspection) {
  if (inspection.unlocked) return statRow('Lock', 'Unlocked', 'tooltip-open');
  if (inspection.unpickable) return statRow('Lock', 'Cannot be Picked', 'tooltip-broken');
  return statRow('Difficulty Class', inspection.difficultyClass, 'tooltip-locked');
}

/* -------------------------------------------- */
/*  Markup helpers                              */
/* -------------------------------------------- */
function header(inspection) {
  const kind = inspection.kindLabel
    ? `<span class="tooltip-kind tooltip-label">${escapeHtml(inspection.kindLabel)}</span>`
    : '';
  return `<div class="tooltip-header"><span>${escapeHtml(inspection.name)}</span>${kind}</div>`;
}

function tabs(attacks) {
  if (!attacks?.length) return '';
  const mounted = attacks
    .map(attack => `<span class="tooltip-tab${attack.wielded ? ' is-wielded' : ''}">`
      + `<img src="${escapeHtml(attack.img)}" alt="${escapeHtml(attack.name)}" /></span>`)
    .join('');
  return `<div class="tooltip-tabs">${mounted}</div>`;
}

function ledger(entries) {
  return `<div class="tooltip-ledger">${entries.map(entry => statRow(...entry)).join('')}</div>`;
}

function statRow(label, value, valueClass = '') {
  return '<div class="tooltip-stat-row">'
    + `<span class="tooltip-label">${escapeHtml(label)}</span>`
    + `<b class="${valueClass}">${escapeHtml(String(value))}</b></div>`;
}

/** The affinity rows a target actually has, so an empty one never spends a line. */
function affinities(inspection) {
  return [
    ['Vulns.', inspection.vulnerableTypes],
    ['Prots.', inspection.protectedTypes],
    ['Imms.', inspection.immuneTypes]
  ]
    .filter(([, types]) => types?.length)
    .map(([label, types]) => affinityRow(label, damageIcons(types)))
    .join('');
}

function affinityRow(label, body) {
  return '<div class="tooltip-affinity-row">'
    + `<span class="tooltip-label">${escapeHtml(label)}</span>${body}</div>`;
}

function damageIcons(types) {
  const icons = (types ?? [])
    .map(type => `<img src="${DAMAGE_ICON_PATH}/${encodeURIComponent(type)}.png"`
      + ` alt="${escapeHtml(type)}" />`)
    .join('');
  return `<div class="tooltip-icons">${icons}</div>`;
}

function effectiveRow(entries) {
  if (!entries?.length) return '';
  const icons = entries
    .map(entry => `<img src="${UNIT_ICON_PATH}/${encodeURIComponent(entry.key)}-type.png"`
      + ` alt="${escapeHtml(entry.label)}" />`)
    .join('');
  return affinityRow('Eff. vs', `<div class="tooltip-icons">${icons}</div>`);
}

/* -------------------------------------------- */
/*  Element lifecycle                           */
/* -------------------------------------------- */
function ensureElement() {
  if (element?.isConnected) return element;
  const created = globalThis.document?.createElement?.('aside');
  if (!created) return null;
  created.className = ROOT_CLASS;
  created.style.display = 'none';
  document.body?.appendChild?.(created);
  element = created;
  return element;
}
