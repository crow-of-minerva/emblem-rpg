/** @layer ui/apps/menus */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { avatarScaleStyle } from '../../../lib/dom/html.mjs';
import { playMenuSound, playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import { captureForDialog } from '../../dialogs.mjs';
import { pickableFirst } from './downtime-performer.mjs';

/* -------------------------------------------- */
/*  Menu window                                 */
/* -------------------------------------------- */
/** Whether a menu's window is already open, so a second click on its station opens no second one. */
export function menuShown(windowClass) {
  return Boolean(globalThis.document?.querySelector?.(`.${windowClass}`));
}

/**
 * Show one downtime menu; resolves when the window closes. The gathering, cooking, crafting, social, performance
 * and requisition menus open through here, each with the view from its api.downtime inspect query. While the window
 * is open it blocks canvas input, and the Confirm key presses the `confirmAction` button. DialogV2 needs at least
 * one button, so the window has a Close button that the stylesheet hides. Each time the body is built, clicks on
 * its `[data-action]` elements go to `actions` in order and the confirm button goes to `confirm`, then
 * `afterMount` wires the rest.
 * @param {object} menu
 * @param {string} menu.title The window title.
 * @param {string[]} menu.classes The menu's own window classes, after the system's and `window-game-menu`.
 * @param {number} menu.width
 * @param {number|string} menu.height
 * @param {object} menu.view The inspect query's view. Each rebuild replaces it with what `refresh()` returns.
 * @param {object} menu.state The menu's local picks, including `busy`.
 * @param {Function|null} menu.refresh Re-reads the view before the body is rebuilt.
 * @param {(view: object, state: object) => Promise<string>} menu.render Renders the body's HTML.
 * @param {string} menu.body The body's selector inside the window.
 * @param {string} menu.confirmAction The confirm button's `data-action`.
 * @param {(menu: object) => *} menu.confirm Sends the menu's command, usually through submitMenu.
 * @param {Record<string, (menu: object, target: HTMLElement) => void>} menu.actions Click handlers by `data-action`.
 * @param {((menu: object) => void)|null} [menu.afterMount]
 */
export async function showDowntimeMenu({ title, classes, width, height, ...menu }) {
  const content = await menu.render(menu.view, menu.state);
  await globalThis.foundry.applications.api.DialogV2.wait({
    window: { title, resizable: false },
    classes: [SYSTEM_ID, 'window-game-menu', ...classes],
    position: { width, height },
    content,
    buttons: [{ action: 'close', label: 'Close', callback: () => {} }],
    render: (_event, dialog) => {
      captureForDialog(dialog, {
        mode: 'shaped', confirmAction: menu.confirmAction, outsideClickCancels: false,
        openSound: SOUND_IDS.UI_SELECT_ALT
      });
      mountMenu({ ...menu, dialog });
    }
  });
}

/**
 * Re-read the view and rebuild the body. The new body goes in before the old one is removed, so the window keeps
 * its place and never goes blank, and each panel keeps its scroll position.
 */
export async function rerenderMenu(menu) {
  if (menu.refresh) {
    const fresh = await menu.refresh();
    if (fresh) menu.view = fresh;
  }
  const holder = menu.dialog.element?.querySelector(menu.body);
  if (!holder) return;
  const scrolled = [...holder.querySelectorAll('.gm-panel-scroll')].map(panel => panel.scrollTop);
  holder.insertAdjacentHTML('afterend', await menu.render(menu.view, menu.state));
  holder.remove();
  mountMenu(menu);
  menu.root?.querySelectorAll('.gm-panel-scroll').forEach((panel, index) => {
    panel.scrollTop = scrolled[index] ?? 0;
  });
}

/**
 * Send clicks on the body's `[data-action]` elements to the menu's handlers. Foundry's window also acts on
 * `data-action` clicks, so a body button must not use a name it reserves: `close`, `tab` or `toggleControls`.
 */
function mountMenu(menu) {
  const root = menu.dialog.element?.querySelector(menu.body);
  if (!root) return;
  menu.root = root;
  root.addEventListener('click', event => {
    for (const [action, handler] of Object.entries(menu.actions)) {
      const target = event.target?.closest?.(`[data-action="${action}"]`);
      if (target) {
        handler(menu, target);
        return;
      }
    }
    const begin = event.target?.closest?.(`button[data-action="${menu.confirmAction}"]`);
    if (begin) {
      event.preventDefault();
      void menu.confirm(menu);
    }
  });
  menu.afterMount?.(menu);
}

/* -------------------------------------------- */
/*  Shared actions                              */
/* -------------------------------------------- */
/**
 * Pick the performer on a clicked tile and rebuild the body. An ineligible tile plays the error sound instead.
 * `onChange` receives the state and the new performer's uuid when the pick changes, so the menu can drop that unit
 * from its other picks.
 */
export function selectPerformer(menu, pick, onChange = null) {
  if (menu.state.busy) return;
  if (pick.dataset.eligible !== 'true') {
    playUiSound(SOUND_IDS.UI_ERROR);
    return;
  }
  const uuid = String(pick.dataset.uuid ?? '');
  if (uuid !== menu.state.performerUuid) {
    menu.state.performerUuid = uuid;
    onChange?.(menu.state, uuid);
  }
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/**
 * Send the menu's command: mark the menu busy, play the confirm sound, run `send` (the api.downtime call) and return
 * its result. The caller clears `busy`. A refusal made on this client, such as the host being busy or the table
 * paused, answers at once and leaves the window open with its picks. Otherwise the window closes while the host
 * runs the command, so the activity plays on an uncovered board.
 */
export async function submitMenu(menu, send) {
  menu.state.busy = true;
  playUiSound(SOUND_IDS.UI_CONFIRM);
  const sent = send();
  const waiting = Symbol('waiting');
  const early = await Promise.race([sent, new Promise(resolve => setTimeout(resolve, 0, waiting))])
    .catch(() => waiting);
  if (early !== waiting && early?.ok !== true) return early;
  await menu.dialog.close();
  return sent;
}

/* -------------------------------------------- */
/*  Performer tiles                             */
/* -------------------------------------------- */
/**
 * Build the performer tiles, eligible units first unless `sorted` is false. Each tile shows the roll it would make:
 * `skillLabel` with the die and bonus that `dice` reads (by default the entry's own `skillDie` and `skillBonus`). It
 * also carries any `extra` fields and whether it is the `active` performer.
 */
export function performerRows(entries, active, { skillLabel, sorted = true, dice = entry => entry, extra = null }) {
  const rows = sorted ? pickableFirst(entries, entry => entry.eligible === true) : entries;
  return rows.map(entry => {
    const { skillDie, skillBonus } = dice(entry);
    return Object.freeze({
      actorUuid: entry.actorUuid,
      name: entry.name,
      image: entry.image,
      avatarStyle: avatarScaleStyle(entry.avatarScale),
      eligible: entry.eligible === true,
      blocked: entry.blocked ?? '',
      ...extra?.(entry),
      skillLabel,
      skillDie: skillDie ?? '',
      skillBonus: Number(skillBonus) || 0,
      selected: Boolean(active) && entry.actorUuid === active.actorUuid
    });
  });
}

/** A unit's energy pips, filled up to its current energy. */
export function energyPips(entry) {
  return Object.freeze(Array.from({ length: Math.max(0, Number(entry.energyMax) || 0) }, (_unused, index) =>
    Object.freeze({ filled: index < (Number(entry.energy) || 0) })));
}

/**
 * The roll a unit would make, as "d6 + 2" or "+ 1" for a unit with no skill die, read from its `skillDie` and
 * `skillBonus`. A skill name passed after the entry leads the line, as in "Nature d6 + 2".
 */
export function rollLine(entry, ...skill) {
  const { skillDie, skillBonus } = entry ?? {};
  return [...skill, skillDie ?? '', '+', Number(skillBonus) || 0].filter(part => part !== '').join(' ');
}
