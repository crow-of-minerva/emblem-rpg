/** @layer ui/apps/menus */
import { defaultPerformer, pickableFirst, resolvePerformer } from './downtime-performer.mjs';
import {
  menuShown, performerRows, rerenderMenu, rollLine, selectPerformer, showDowntimeMenu, submitMenu
} from './downtime-menu.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { REQUISITION_KINDS } from '../../../contracts/domains/downtime.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { playMenuSound, playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import { SHEET_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/requisition-menu.hbs`;
const WINDOW_CLASS = 'window-requisition-menu';
const MENU_WIDTH = 1040;
const MENU_HEIGHT = 640;

/** Each 100 GP demanded adds 1 to the faction's base DC, matching requisitionDc in game/downtime/requisition.mjs. */
const GP_PER_DC = 100;
const NO_CONVOY = 'No convoy linked';
const KIND_UNAVAILABLE = 'Not yet available';
const FACTION_LOCKED = 'Already requisitioned this downtime';
const KIND_NOTES = Object.freeze({ [REQUISITION_KINDS.FUNDING]: 'Gold sent to the Convoy' });

/* -------------------------------------------- */
/*  Requisition menu                            */
/* -------------------------------------------- */
/**
 * Show a Stationary's requisitioners, the request kinds, the factions it lists and the demand with the Civics DC it
 * sets, from the api.downtime.inspectRequisition view. The button sends one api.downtime.requisition command, which
 * shows the work banner and posts the check card and the result card. A refusal made on this client, such as a busy
 * host or a paused table, leaves the window open with the picks; otherwise the window closes while the host runs the
 * command.
 * @param {object} view The downtime query's requisition view (api.downtime.inspectRequisition).
 * @param {{refresh?: Function}} [handlers] Re-reads the view before the window is rebuilt.
 * @returns {Promise<boolean>} Resolves when the window closes, which is before the command answers, so the value
 *   does not report the outcome.
 */
export async function openRequisitionMenu(view, { refresh = null } = {}) {
  if (menuShown(WINDOW_CLASS)) return false;
  const state = {
    performerUuid: defaultPerformer({ performers: performerEntries(view) }),
    kind: REQUISITION_KINDS.FUNDING,
    factionId: null,
    demand: Number(view.limits?.min) || GP_PER_DC,
    requisitioned: false,
    busy: false
  };
  await showDowntimeMenu({
    title: `Requisition: ${view.station.name}`, classes: [WINDOW_CLASS], width: MENU_WIDTH, height: MENU_HEIGHT,
    view, state, refresh, render, body: '.requisition-menu', confirmAction: 'requisition', confirm: beginRequisition,
    actions: { selectPerformer, selectKind, selectFaction }, afterMount: wireDemand
  });
  return state.requisitioned;
}

/* -------------------------------------------- */
/*  View                                        */
/* -------------------------------------------- */
/**
 * Build the requisition template's context from the inspect view and the menu's picks. Units that can't requisition
 * are listed after the ones that can. Kinds not yet available and factions already requisitioned this downtime are
 * listed but can't be picked, and the demand is checked against the chosen faction's cap.
 * @param {object} view The view from api.downtime.inspectRequisition.
 * @param {{performerUuid: string|null, kind: string, factionId: string|null, demand: number, busy?: boolean}} state
 * @returns {object} The frozen template context.
 */
function prepareRequisitionView(view, state) {
  const entries = performerEntries(view);
  const active = resolvePerformer({ performers: entries }, state.performerUuid);
  const performers = performerRows(entries, active, { skillLabel: view.skillLabel });
  const kinds = kindRows(view.kinds, state.kind);
  const pickedKind = kinds.find(row => row.key === state.kind) ?? null;
  const factions = pickableFirst(factionRows(view.factions, state.factionId), row => !row.locked);
  const pickedFaction = factions.find(row => row.id === state.factionId) ?? null;
  const faction = pickedFaction && !pickedFaction.locked ? pickedFaction : null;
  const demand = demandView(view.limits, faction, state.demand);
  const dc = faction && demand.valid ? faction.baseDc + demand.value / GP_PER_DC : null;
  const performerRow = performers.find(row => row.selected) ?? null;
  const blocked = blockReason({ entries, active, pickedKind, factions, pickedFaction, demand });
  const canRequisition = !blocked && state.busy !== true;
  const convoyName = active?.convoy?.name ?? '';
  const ticket = Object.freeze({
    blocked,
    bad: Boolean(faction) && !demand.valid,
    performer: active?.name ?? '',
    faction: faction?.name ?? '',
    demand: gpLabel(demand.value),
    roll: performerRow ? rollLine(performerRow, view.skillLabel) : '',
    dc
  });
  return Object.freeze({
    station: view.station,
    modeDesc: `Ask a faction for support with a ${view.skillLabel} check. Win or lose, the requisitioner spends `
      + 'their Downtime Action and the faction cannot be asked again until downtime is reset.',
    performers,
    hasPerformers: performers.length > 0,
    kinds,
    factions,
    hasFactions: factions.length > 0,
    availableCount: factions.filter(row => !row.locked).length,
    faction,
    hasSelection: Boolean(faction),
    emptyDetail: factions.length ? 'Select a faction to requisition.' : 'This Stationary lists no factions.',
    demand,
    dc,
    dcLabel: dc === null ? '--' : String(dc),
    convoyLine: convoyName
      ? `Funds arrive in ${convoyName} as inbound gold.`
      : 'Funds arrive in the requisitioner\'s Convoy as inbound gold.',
    ticket,
    ticketHtml: ticketMarkup(ticket),
    canRequisition,
    buttonTitle: !canRequisition && blocked ? blocked : ''
  });
}

/**
 * The view's performers as requisitioner candidates. A unit must be marked eligible and linked to a party Convoy,
 * since the funds arrive there as inbound gold.
 */
function performerEntries(view) {
  return (view.performers ?? []).map(entry => {
    const convoy = entry.convoy?.uuid ? entry.convoy : null;
    const eligible = entry.eligible === true && Boolean(convoy);
    const blocked = eligible ? '' : String(entry.blocked || (convoy ? '' : NO_CONVOY));
    return { ...entry, convoy, eligible, blocked };
  });
}

/** Every request kind in the view's order. Only an available kind can be picked. */
function kindRows(kinds = [], picked) {
  return (kinds ?? []).map(entry => {
    const available = entry.available === true;
    return Object.freeze({
      key: String(entry.key),
      label: entry.label || String(entry.key),
      available,
      note: available ? KIND_NOTES[entry.key] ?? '' : KIND_UNAVAILABLE,
      selected: available && entry.key === picked
    });
  });
}

/**
 * The enabled factions, each with the base DC its relation sets and the cap its wealth sets. A faction already
 * requisitioned this downtime is locked.
 */
function factionRows(factions = [], picked) {
  return (factions ?? []).filter(entry => entry.enabled !== false).map(entry => {
    const locked = entry.requisitioned === true;
    const baseDc = Number(entry.baseDc) || 0;
    const cap = entry.cap === null || entry.cap === undefined ? null : Number(entry.cap);
    return Object.freeze({
      id: String(entry.id),
      name: entry.name || 'Unnamed faction',
      relation: entry.relation ?? '',
      wealth: entry.wealth ?? '',
      baseDc,
      cap,
      capLabel: capLabel(cap),
      summary: `${entry.relation} (DC ${baseDc}) | ${entry.wealth} (${cap === null ? 'no cap' : gpLabel(cap)})`,
      locked,
      blocked: locked ? FACTION_LOCKED : '',
      selected: !locked && String(entry.id) === String(picked ?? '')
    });
  });
}

/**
 * The demand field: its bounds from the view's limits and the faction's cap (a Boundless faction stops at the
 * sanity limit), whether the entered amount is a whole step inside them, and the amount a committed entry snaps to.
 */
function demandView(limits = {}, faction, raw) {
  const step = positive(limits?.step, GP_PER_DC);
  const min = positive(limits?.min, step);
  const ceiling = positive(limits?.maxDemand, min);
  const max = Math.max(min, Math.floor((faction?.cap ?? ceiling) / step) * step);
  const value = Number(raw);
  const valid = Number.isInteger(value) && value % step === 0 && value >= min && value <= max;
  const snapped = Math.min(max, Math.max(min, Math.round((Number.isFinite(value) ? value : min) / step) * step));
  const range = `${gpLabel(min)} to ${gpLabel(max)} in steps of ${step}`;
  return Object.freeze({
    value: Number.isFinite(value) ? value : 0,
    step,
    min,
    max,
    valid,
    snapped,
    capLabel: faction ? capLabel(faction.cap) : '',
    note: valid ? range : `Demand ${range}`
  });
}

function blockReason({ entries, active, pickedKind, factions, pickedFaction, demand }) {
  if (!entries.length) return 'No party member is on this map';
  if (!active) {
    return entries.every(entry => entry.blocked === NO_CONVOY)
      ? 'No party member here is linked to a Convoy' : 'No party member can requisition right now';
  }
  if (!pickedKind) return 'Choose what to request';
  if (!pickedKind.available) return `${pickedKind.label} requests are not yet available`;
  if (!factions.length) return 'This Stationary lists no factions';
  if (!pickedFaction) return 'Select a faction';
  if (pickedFaction.locked) return `${pickedFaction.name} was already requisitioned this downtime`;
  if (!demand.valid) return demand.note;
  return '';
}

/** The footer line: the refusal, or who asks which faction for how much and the roll against the DC. */
function ticketMarkup(ticket) {
  if (ticket.blocked) return escapeHtml(ticket.blocked);
  if (!ticket.performer) return '';
  return `<strong>${escapeHtml(ticket.performer)}</strong> asks <strong>${escapeHtml(ticket.faction)}</strong> for `
    + `<strong>${escapeHtml(ticket.demand)}</strong> (${escapeHtml(ticket.roll)} against DC ${escapeHtml(ticket.dc)})`;
}

function capLabel(cap) {
  return cap === null || cap === undefined ? 'No cap' : `Cap ${gpLabel(cap)}`;
}

function gpLabel(amount) {
  return `${(Number(amount) || 0).toLocaleString('en-US')} GP`;
}

function positive(value, fallback) {
  const number = Math.trunc(Number(value));
  return number > 0 ? number : fallback;
}

/**
 * Render the body, and write the requisitioner it shows back into the picks, so one who became unavailable is
 * replaced.
 */
async function render(view, state) {
  const prepared = prepareRequisitionView(view, state);
  state.performerUuid = prepared.performers.find(entry => entry.selected)?.actorUuid ?? null;
  return globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    ...prepared,
    demandTooltip: getTooltip(SHEET_TOOLTIP_IDS.REQUISITION_DEMAND),
    dcTooltip: getTooltip(SHEET_TOOLTIP_IDS.REQUISITION_DC),
    convoyTooltip: getTooltip(SHEET_TOOLTIP_IDS.REQUISITION_CONVOY)
  });
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */
/** Wire the demand field, which follows typing in place and snaps a finished entry. */
function wireDemand(menu) {
  const input = menu.root.querySelector('.rq-demand-input');
  if (!input) return;
  input.addEventListener('input', () => typeDemand(menu, input));
  input.addEventListener('change', () => commitDemand(menu, input));
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitDemand(menu, input);
  });
}

/** Pick a request kind. A kind that isn't available yet plays the error sound instead. */
function selectKind(menu, row) {
  if (menu.state.busy) return;
  if (row.dataset.available !== 'true') {
    playUiSound(SOUND_IDS.UI_ERROR);
    return;
  }
  menu.state.kind = String(row.dataset.kind ?? '');
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/** Pick a faction and bring the demand inside its cap, so switching to a poorer faction never leaves it over. */
function selectFaction(menu, row) {
  if (menu.state.busy) return;
  if (row.dataset.locked === 'true') {
    playUiSound(SOUND_IDS.UI_ERROR);
    return;
  }
  const factionId = String(row.dataset.id ?? '');
  menu.state.factionId = factionId;
  menu.state.demand = prepareRequisitionView(menu.view, { ...menu.state, factionId }).demand.snapped;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/** Follow the typed amount without rebuilding the window, so the field keeps its focus and caret. */
function typeDemand(menu, input) {
  if (menu.state.busy) return;
  menu.state.demand = Number(input.value);
  patchDemand(menu);
}

/** Snap a finished entry to a whole step inside the cap, in place, so a following Begin click still lands. */
function commitDemand(menu, input) {
  if (menu.state.busy) return;
  const snapped = prepareRequisitionView(menu.view, menu.state).demand.snapped;
  menu.state.demand = snapped;
  input.value = String(snapped);
  patchDemand(menu);
}

/** Redraw what the demand decides: the DC readout, the range note, the footer line and the Begin button. */
function patchDemand(menu) {
  const root = menu.root;
  const prepared = prepareRequisitionView(menu.view, menu.state);
  const dc = root.querySelector('.rq-dc-value');
  if (dc) dc.textContent = prepared.dcLabel;
  root.querySelector('.rq-demand-field')?.classList.toggle('is-bad', !prepared.demand.valid);
  const note = root.querySelector('.rq-demand-note');
  if (note) {
    note.textContent = prepared.demand.note;
    note.classList.toggle('is-bad', !prepared.demand.valid);
  }
  const ticket = root.querySelector('.rq-ticket');
  if (ticket) {
    ticket.innerHTML = prepared.ticketHtml;
    ticket.classList.toggle('is-bad', prepared.ticket.bad);
  }
  const button = root.querySelector('button[data-action="requisition"]');
  if (button) button.disabled = !prepared.canRequisition;
  const footer = root.querySelector('.gm-footer');
  if (footer) {
    if (prepared.buttonTitle) footer.dataset.tooltip = prepared.buttonTitle;
    else delete footer.dataset.tooltip;
  }
}

/**
 * Send the requisition command with the requisitioner, kind, faction and demand. The API shows the result,
 * including any refusal, as a notification.
 */
async function beginRequisition(menu) {
  const { view, state } = menu;
  const prepared = prepareRequisitionView(view, state);
  const performer = prepared.performers.find(row => row.selected) ?? null;
  const kind = prepared.kinds.find(row => row.selected) ?? null;
  if (!performer || !kind || !prepared.faction || !prepared.canRequisition || state.busy) return;
  try {
    const result = await submitMenu(menu, () => game.emblemRpg.api.downtime.requisition({
      cursorTokenUuid: view.cursorTokenUuid,
      stationTokenUuid: view.stationTokenUuid,
      performerUuid: performer.actorUuid,
      factionId: prepared.faction.id,
      kind: kind.key,
      demand: prepared.demand.value
    }));
    state.requisitioned = result?.ok === true;
  } finally {
    state.busy = false;
  }
}
