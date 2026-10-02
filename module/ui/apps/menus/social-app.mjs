/** @layer ui/apps/menus */
import { menuShown, rerenderMenu, rollLine, showDowntimeMenu, submitMenu } from './downtime-menu.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { PROFICIENCIES } from '../../../contracts/domains/characters.mjs';
import { SOCIAL_MODES } from '../../../contracts/domains/downtime.mjs';
import { WEAPON_PROFICIENCIES } from '../../../contracts/domains/items.mjs';
import { avatarScaleStyle } from '../../../lib/dom/html.mjs';
import { playMenuSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/social-menu.hbs`;
const WINDOW_CLASS = 'window-social-menu';
const MENU_WIDTH = 780;
const PROFICIENCY_ICON_PATH = `systems/${SYSTEM_ID}/assets/ui/proficiencies`;
const PROFICIENCY_VOCABULARY = new Map(PROFICIENCIES.map(entry => [entry.key, entry]));
const MODE_ROWS = Object.freeze([
  Object.freeze({ key: SOCIAL_MODES.SOCIALIZE, label: 'Socialize', icon: 'fa-comments' }),
  Object.freeze({ key: SOCIAL_MODES.TRAIN, label: 'Train', icon: 'fa-swords' })
]);
const REMINDERS = Object.freeze({
  [SOCIAL_MODES.SOCIALIZE]: 'Socializing quickly builds Support among two characters of your party. Both gain '
    + 'Support XP equal to the sum of their Sociability check results.',
  [SOCIAL_MODES.TRAIN]: 'Training allows the receiving unit to gain weapon proficiency XP in a specialization which '
    + 'the trainer has greater mastery over. Both units also receive a bit of Level EXP and Support XP.'
});
const EMPTY_GRID = Object.freeze([]);

/* -------------------------------------------- */
/*  Social menu                                 */
/* -------------------------------------------- */
/**
 * Show the pair a socialize pick chose, the acting unit and the unit it visited, and let the player socialize or
 * train them. The button sends one api.downtime.socialize or api.downtime.train command, which plays the
 * conversation or the spar and posts the roll and result cards. A refusal made on this client, such as a busy host
 * or a paused table, leaves the window open with the picks; otherwise the window closes while the host runs the
 * command. The window's height follows its content, so switching to Train grows it by the proficiency grid.
 * @param {object} view The downtime query's social view (api.downtime.inspectSocial).
 * @param {{refresh?: Function}} [handlers] Re-reads the view before the window is rebuilt.
 * @returns {Promise<boolean>} Whether the command succeeded. Unlike the other downtime menus, this one waits for the
 *   answer, so the caller knows whether the pick was spent.
 */
export async function openSocialMenu(view, { refresh = null } = {}) {
  if (menuShown(WINDOW_CLASS)) return false;
  const state = { mode: SOCIAL_MODES.SOCIALIZE, proficiencyKey: null, busy: false, performed: false, pending: null };
  await showDowntimeMenu({
    title: `Socialize: ${view.cursor?.name ?? ''} and ${view.partner?.name ?? ''}`,
    classes: [WINDOW_CLASS],
    width: MENU_WIDTH,
    height: 'auto',
    view, state, refresh, render, body: '.social-menu', confirmAction: 'begin', confirm: beginActivity,
    actions: { setMode, selectProficiency }
  });
  await state.pending;
  return state.performed;
}

/* -------------------------------------------- */
/*  View                                        */
/* -------------------------------------------- */
/**
 * Build the social template's data: the two unit columns, the mode's icon and reminder, and in Train mode the
 * weapon proficiency grid, where only the rows view.training offers can be picked. In Socialize both columns show
 * their Sociability check. In Train they show Command, and once a proficiency is picked the trainer stands left and
 * the student right.
 * @param {object} view The view from api.downtime.inspectSocial.
 * @param {{mode: string, proficiencyKey: string|null, busy?: boolean}} state
 * @returns {object} The frozen template context.
 */
function prepareSocialView(view, state) {
  const isTrain = state.mode === SOCIAL_MODES.TRAIN;
  const mode = isTrain ? SOCIAL_MODES.TRAIN : SOCIAL_MODES.SOCIALIZE;
  const training = Array.isArray(view.training) ? view.training : [];
  const selected = isTrain ? training.find(row => row.key === state.proficiencyKey) ?? null : null;
  const blocked = blockReason(view, isTrain, training, selected);
  const allowed = isTrain ? view.canTrain === true : view.canSocialize === true;
  const canBegin = !blocked && allowed && state.busy !== true;
  const [left, right] = pairColumns(view, isTrain, selected);
  return Object.freeze({
    isTrain,
    modes: Object.freeze(MODE_ROWS.map(row => Object.freeze({ ...row, active: row.key === state.mode }))),
    centerIcon: MODE_ROWS.find(row => row.key === mode).icon,
    reminder: REMINDERS[mode],
    left,
    right,
    grid: isTrain ? proficiencyGrid(training, selected) : EMPTY_GRID,
    hasProficiencies: training.length > 0,
    canBegin,
    buttonLabel: isTrain ? 'Begin Training' : 'Begin Socializing',
    buttonTitle: canBegin ? '' : blocked
  });
}

/** The first reason the begin button is held: the pair's own block, then what Train mode still needs. */
function blockReason(view, isTrain, training, selected) {
  if (view.blocked) return String(view.blocked);
  if (!isTrain) return '';
  if (!training.length) return 'Neither unit holds a proficiency to train';
  if (!selected) return 'Select a proficiency';
  return '';
}

/**
 * The left and right unit columns. The acting unit stands left and the partner right, except once a training row
 * is picked. Then its trainer, matched by actorUuid, moves left with the Command check and the spar's level XP, and
 * its trainee stands right as the student with only its level XP.
 */
function pairColumns(view, isTrain, selected) {
  const labels = view.skillLabels ?? {};
  const units = [view.cursor, view.partner];
  if (!isTrain) {
    const sociability = { key: 'sociability', label: labels.sociability ?? 'Sociability' };
    return units.map(unit => unitColumn(unit, { check: sociability }));
  }
  const command = { key: 'command', label: labels.command ?? 'Command' };
  const trainer = selected ? units.find(unit => unit?.actorUuid === selected.trainerUuid) : null;
  const trainee = selected ? units.find(unit => unit?.actorUuid === selected.traineeUuid) : null;
  if (!trainer || !trainee) return units.map(unit => unitColumn(unit, { check: command }));
  const level = selected.levelExperience ?? {};
  return [
    unitColumn(trainer, { role: 'Trainer', check: command, trainingXp: Number(level.trainer) || 0 }),
    unitColumn(trainee, { role: 'Student', trainingXp: Number(level.trainee) || 0 })
  ];
}

/** One portrait column. A blocked unit keeps its reason for the column's tooltip. */
function unitColumn(unit, { role = '', check = null, trainingXp = null } = {}) {
  return Object.freeze({
    name: unit?.name ?? '',
    image: unit?.image || 'icons/svg/mystery-man.svg',
    avatarStyle: avatarScaleStyle(unit?.avatarScale),
    eligible: unit?.eligible !== false,
    blocked: String(unit?.blocked ?? ''),
    role,
    check: check ? Object.freeze({ label: check.label, line: rollLine(unit?.[check.key]) }) : null,
    trainingXp
  });
}

/**
 * Every weapon proficiency in WEAPON_PROFICIENCIES order. A cell the pair can train carries its training row's
 * teaching rank as the badge and both ranks in its tooltip. Any other cell shows the -off icon and can't be picked.
 */
function proficiencyGrid(training, selected) {
  return Object.freeze(WEAPON_PROFICIENCIES.map(key => {
    const vocabulary = PROFICIENCY_VOCABULARY.get(key);
    const label = vocabulary?.label ?? key;
    const row = training.find(entry => entry.key === key) ?? null;
    return Object.freeze({
      key,
      label,
      icon: `${PROFICIENCY_ICON_PATH}/${vocabulary?.icon ?? key}${row ? '' : '-off'}.png`,
      trainable: row !== null,
      selected: row !== null && row.key === selected?.key,
      badge: row ? String(row.trainerRankLabel ?? '') : '',
      title: row
        ? `${label}: ${row.trainerName} ${row.trainerRankLabel} > ${row.traineeName} ${row.traineeRankLabel}`
        : `${label}: neither unit holds it`
    });
  }));
}

async function render(view, state) {
  return globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, prepareSocialView(view, state));
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */
function setMode(menu, button) {
  if (menu.state.busy) return;
  const mode = String(button.dataset.mode ?? '');
  if (!Object.values(SOCIAL_MODES).includes(mode) || mode === menu.state.mode) return;
  menu.state.mode = mode;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/**
 * Toggle the picked grid cell. A disabled cell, or one whose key the current view doesn't offer, is ignored so only
 * trainable proficiencies can be picked. Clicking the picked cell again clears the pick.
 */
function selectProficiency(menu, cell) {
  if (menu.state.busy || cell.disabled) return;
  const key = String(cell.dataset.key ?? '');
  const picked = menu.state.proficiencyKey === key;
  const offered = Array.isArray(menu.view.training) && menu.view.training.some(row => row.key === key);
  if (!picked && !offered) return;
  menu.state.proficiencyKey = picked ? null : key;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/**
 * Send the socialize or train command with the pair and, for training, the proficiency. The API shows the result,
 * including any refusal, as a notification. openSocialMenu waits for this answer.
 */
function beginActivity(menu) {
  const { view, state } = menu;
  const prepared = prepareSocialView(view, state);
  if (!prepared.canBegin || state.busy) return null;
  state.pending = (async () => {
    try {
      const result = await submitMenu(menu, () => {
        const pair = { cursorTokenUuid: view.cursorTokenUuid, partnerTokenUuid: view.partnerTokenUuid };
        return prepared.isTrain
          ? game.emblemRpg.api.downtime.train({ ...pair, proficiencyKey: state.proficiencyKey })
          : game.emblemRpg.api.downtime.socialize(pair);
      });
      state.performed = result?.ok === true;
    } finally {
      state.busy = false;
    }
  })();
  return state.pending;
}
