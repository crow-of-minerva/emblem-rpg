/** @layer ui/apps/menus */
import { defaultPerformer, resolvePerformer } from './downtime-performer.mjs';
import {
  energyPips, menuShown, performerRows, selectPerformer, showDowntimeMenu, submitMenu
} from './downtime-menu.mjs';
import { GATHER_DESTINATIONS } from '../../../contracts/domains/downtime.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { RESULT_CODES } from '../../../contracts/results.mjs';
import { playMenuSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/gathering-menu.hbs`;
const WINDOW_CLASS = 'window-gathering-menu';
const MENU_WIDTH = 660;
const MENU_HEIGHT = 500;
const DESTINATION_LABELS = Object.freeze({
  [GATHER_DESTINATIONS.CONVOY]: 'Convoy',
  [GATHER_DESTINATIONS.INVENTORY]: 'Inventory'
});

/* -------------------------------------------- */
/*  Gathering menu                              */
/* -------------------------------------------- */
/**
 * Show a gathering Node's stock and the units that can gather it. interactWithStation (ui/controls/interaction.mjs)
 * opens it with the api.downtime.inspectGathering view. On submit the window closes and one
 * api.downtime.gather command runs, which rolls, delivers the yield and posts the result.
 * @param {object} view The downtime query's gathering view.
 * @param {{refresh?: Function}} [handlers] Re-reads the view before the window is rebuilt.
 * @returns {Promise<boolean>} Always false in practice: the window closes before the gather command answers, and
 *   the caller ignores the value.
 */
export async function openGatheringMenu(view, { refresh = null } = {}) {
  if (menuShown(WINDOW_CLASS)) return false;
  const state = { performerUuid: defaultPerformer(view), destination: '', gathered: false, busy: false };
  await showDowntimeMenu({
    title: `Gathering: ${view.node.name}`, classes: [WINDOW_CLASS], width: MENU_WIDTH, height: MENU_HEIGHT,
    view, state, refresh, render, body: '.gathering-menu', confirmAction: 'gather', confirm: beginGathering,
    actions: { selectPerformer }, afterMount: watchDestination
  });
  return state.gathered;
}

/* -------------------------------------------- */
/*  View                                        */
/* -------------------------------------------- */
/**
 * Map the downtime gathering projection and local picks into the gathering template context. The view lists only
 * the entries a gather can draw, so a node listing none is exhausted.
 */
function prepareGatheringView(view, state) {
  const active = resolvePerformer(view, state.performerUuid);
  const performers = performerRows(view.performers ?? [], active, {
    skillLabel: view.node.skillLabel,
    sorted: false,
    extra: entry => ({ energy: entry.energy, energyMax: entry.energyMax, pips: energyPips(entry) })
  });
  const gatherables = view.gatherables ?? [];
  const hasStock = gatherables.length > 0;
  let warning = '';
  if (view.refusal === RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED) warning = 'Only in free exploration.';
  else if (!hasStock) warning = 'This Node is exhausted.';
  else if (!performers.length) warning = 'No party member is on this map.';
  else if (!active) warning = 'No party member can gather here right now.';
  const destination = resolveDestination(view, state.destination);
  return Object.freeze({
    node: view.node,
    performers,
    hasPerformers: performers.length > 0,
    destinations: Object.freeze(availableDestinations(view).map(value => Object.freeze({
      value, label: DESTINATION_LABELS[value], selected: value === destination
    }))),
    gatherables,
    hasGatherables: gatherables.length > 0,
    gatherableCount: gatherables.length,
    hasStock,
    canGather: Boolean(active) && hasStock && state.busy !== true,
    warning
  });
}

/** The chosen destination while it is still offered, else the Convoy when the party has one, else the inventory. */
function resolveDestination(view, destination) {
  const offered = availableDestinations(view);
  return offered.includes(destination) ? destination : offered[0];
}

function availableDestinations(view) {
  return view.convoyName
    ? [GATHER_DESTINATIONS.CONVOY, GATHER_DESTINATIONS.INVENTORY]
    : [GATHER_DESTINATIONS.INVENTORY];
}

async function render(view, state) {
  return globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, prepareGatheringView(view, state));
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */
/** Follow the destination select as it changes, without rebuilding the body. */
function watchDestination(menu) {
  menu.root.addEventListener('change', event => {
    const select = event.target?.closest?.('select[name="gatherTo"]');
    if (!select) return;
    menu.state.destination = resolveDestination(menu.view, String(select.value ?? ''));
    playMenuSound(SOUND_IDS.UI_BLIP_1);
  });
}

/** Close the window, then send the gather command with the chosen gatherer and destination. */
async function beginGathering(menu) {
  const { view, state } = menu;
  const performer = resolvePerformer(view, state.performerUuid);
  if (!performer || state.busy) return;
  const result = await submitMenu(menu, () => game.emblemRpg.api.downtime.gather({
    cursorTokenUuid: view.cursorTokenUuid,
    stationTokenUuid: view.stationTokenUuid,
    performerUuid: performer.actorUuid,
    destination: resolveDestination(view, state.destination)
  }));
  state.gathered = result?.ok === true;
  state.busy = false;
}
