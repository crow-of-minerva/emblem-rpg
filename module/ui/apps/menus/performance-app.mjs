/** @layer ui/apps/menus */
import { defaultPerformer, pickableFirst, resolvePerformer } from './downtime-performer.mjs';
import {
  menuShown, performerRows, rerenderMenu, rollLine, selectPerformer, showDowntimeMenu, submitMenu
} from './downtime-menu.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { STATS } from '../../../contracts/domains/characters.mjs';
import { PERFORMANCE_PASSIVE_NAMES, SONG_STAT_KEYS } from '../../../contracts/domains/downtime.mjs';
import { probeTrackDuration } from '../../../foundry/adapters/services/audio.mjs';
import { avatarScaleStyle } from '../../../lib/dom/html.mjs';
import { playMenuSound, playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/performance-menu.hbs`;
const WINDOW_CLASS = 'window-performance-menu';
const MENU_WIDTH = 1040;
const MENU_HEIGHT = 560;
const STAT_BY_KEY = Object.freeze(Object.fromEntries(STATS.map(stat => [stat.key, stat])));
/** The track card's length until the audio file has been read, and for a file that cannot be read. */
const DURATION_PENDING = '--:--';

/* -------------------------------------------- */
/*  Performance menu                            */
/* -------------------------------------------- */
/**
 * Show an Instrument's lead performers, their songs and the accompaniment a group song needs, from the
 * api.downtime.inspectPerformance view. Begin Performance sends one api.downtime.perform command, which shows the
 * banner and posts every performer's roll card and the result card. A refusal made on this client, such as a busy
 * host or a paused table, leaves the window open with the picks; otherwise the window closes while the host runs the
 * command.
 * @param {object} view The downtime query's performance view (api.downtime.inspectPerformance).
 * @param {{refresh?: Function}} [handlers] Re-reads the view before the window is rebuilt.
 * @returns {Promise<boolean>} Resolves when the window closes, which is before the command answers, so the value
 *   does not report the outcome.
 */
export async function openPerformanceMenu(view, { refresh = null } = {}) {
  if (menuShown(WINDOW_CLASS)) return false;
  const state = {
    performerUuid: defaultPerformer({ performers: leadEntries(view) }), songId: null, accompanimentUuids: [],
    trackDurations: {}, performed: false, busy: false
  };
  await showDowntimeMenu({
    title: `Performance: ${view.station.name}`, classes: [WINDOW_CLASS], width: MENU_WIDTH, height: MENU_HEIGHT,
    view, state, refresh, render, body: '.performance-menu', confirmAction: 'perform', confirm: beginPerformance,
    actions: { selectPerformer: selectLead, selectSong, toggleAccompaniment }, afterMount: fillTrackDuration
  });
  return state.performed;
}

/* -------------------------------------------- */
/*  View                                        */
/* -------------------------------------------- */
/**
 * Build the performance template's context from the inspect view and the menu's picks. Units that can't be picked
 * are listed after the ones that can, and so are songs the free party members can't accompany. The footer line
 * describes the performance the button would send, or why it can't, and the same reason is the footer's tooltip.
 * @param {object} view The view from api.downtime.inspectPerformance.
 * @param {{performerUuid: string|null, songId: string|null, accompanimentUuids: string[],
 *   trackDurations?: Record<string, number|null>, busy?: boolean}} state
 * @returns {object} The frozen template context.
 */
function preparePerformanceView(view, state) {
  const leads = leadEntries(view);
  const active = resolvePerformer({ performers: leads }, state.performerUuid);
  const performers = performerRows(leads, active, { skillLabel: view.skillLabel });
  const known = new Set(active?.songIds ?? []);
  const songs = active ? (view.songs ?? []).filter(song => known.has(song.id)) : [];
  const song = songs.find(entry => entry.id === state.songId) ?? null;
  const candidates = pickableFirst((view.accompaniments ?? [])
    .filter(entry => entry.actorUuid !== active?.actorUuid)
    .map(entry => ({ ...entry, pickable: markFree(entry), blocked: blockedReason(entry) }))
    .sort((a, b) => a.name.localeCompare(b.name)), entry => entry.pickable);
  const free = candidates.filter(entry => entry.pickable).length;
  const need = song ? accompanimentsNeeded(song) : 0;
  const picked = new Set(state.accompanimentUuids);
  const chosen = need > 0 ? candidates.filter(entry => entry.pickable && picked.has(entry.actorUuid)) : [];
  const accompaniments = need > 0 ? candidates.map(entry => Object.freeze({
    actorUuid: entry.actorUuid,
    name: entry.name,
    image: entry.image,
    avatarStyle: avatarScaleStyle(entry.avatarScale),
    chosen: entry.pickable && picked.has(entry.actorUuid),
    blocked: entry.pickable ? '' : entry.blocked,
    roll: rollLine(entry)
  })) : [];
  const songRows = pickableFirst(songs.map(entry => ({ entry, short: accompanimentsNeeded(entry) > free })),
    row => !row.short);
  const detail = song ? songDetail(song, { tracks: view.tracks, durations: state.trackDurations }, {
    need, chosen: chosen.length, free
  }) : null;
  const blockTitle = blockReason({ performers, active, songs, song, detail });
  const leadRow = performers.find(entry => entry.selected) ?? null;
  const canPerform = Boolean(detail) && !detail.short && chosen.length === need && state.busy !== true;
  const cast = [active?.name, ...chosen.map(entry => entry.name)].filter(Boolean);
  return Object.freeze({
    station: view.station,
    modeDesc: `Roll a ${view.skillLabel} check for the party. Everyone on this map who has not heard a performance `
      + 'since the last rest takes the song\'s bonuses. A failed performance leaves them Uninspired instead.',
    performers,
    hasPerformers: performers.length > 0,
    leadName: active?.name ?? '',
    songs: Object.freeze(songRows.map(({ entry, short }) => Object.freeze({
      id: entry.id, name: entry.name || 'Unnamed song', image: entry.img, dc: entry.dc,
      performers: songPerformers(entry), group: songPerformers(entry) > 1, personal: !entry.isDefault,
      hasTrack: Boolean(entry.track), selected: entry.id === song?.id, short
    }))),
    hasSongs: songs.length > 0,
    accompaniments,
    hasAccompanimentPicker: need > 0,
    hasAccompaniments: accompaniments.length > 0,
    detail,
    hasSelection: Boolean(detail),
    ticket: Object.freeze({
      blocked: blockTitle,
      bad: Boolean(detail) && (detail.short || chosen.length > need),
      cast: listNames(cast),
      verb: cast.length > 1 ? 'perform' : 'performs',
      song: detail?.name ?? '',
      roll: leadRow ? `${view.skillLabel} ${rollLine(leadRow)}` : ''
    }),
    canPerform,
    buttonInsufficient: Boolean(detail?.short),
    buttonLabel: detail?.short ? 'Not Enough Performers' : 'Begin Performance',
    buttonTitle: !canPerform && blockTitle ? blockTitle : ''
  });
}

/**
 * Seconds as m:ss, or h:mm:ss past an hour, for the track card. A length not yet read, or unreadable, shows the
 * pending mark.
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (seconds == null || !Number.isFinite(total) || total <= 0) return DURATION_PENDING;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * The view's performers as lead candidates. A unit can lead only when the view marks it eligible and no earlier
 * performance has marked it (Inspired or Uninspired).
 */
function leadEntries(view) {
  return (view.performers ?? []).map(entry => ({
    ...entry,
    eligible: entry.eligible === true && !entry.performanceMark,
    blocked: blockedReason(entry)
  }));
}

function markFree(entry) {
  return entry.eligible !== false && !entry.performanceMark;
}

function blockedReason(entry) {
  if (entry.blocked) return String(entry.blocked);
  if (!entry.performanceMark) return '';
  return entry.performanceMark === PERFORMANCE_PASSIVE_NAMES.UNINSPIRED ? 'Uninspired' : 'Already inspired';
}

function songPerformers(song) {
  return Math.max(1, Math.trunc(Number(song.performers)) || 1);
}

function accompanimentsNeeded(song) {
  return songPerformers(song) - 1;
}

/**
 * Build the song card: its difficulty and performers, the stats it inspires in stat order, its linked track and the
 * accompaniment it needs. A linked track missing from the view's `tracks` can no longer be found.
 */
function songDetail(song, { tracks, durations }, { need, chosen, free }) {
  const bonuses = SONG_STAT_KEYS.map(key => {
    const value = Math.max(0, Math.trunc(Number(song.bonuses?.[key])) || 0);
    return Object.freeze({
      key, label: STAT_BY_KEY[key]?.short ?? key, title: STAT_BY_KEY[key]?.label ?? key, value, granted: value > 0
    });
  });
  const performers = songPerformers(song);
  const linked = String(song.track ?? '');
  const facts = linked ? tracks?.[linked] ?? null : null;
  return Object.freeze({
    name: song.name || 'Unnamed song',
    description: song.description ?? '',
    dc: song.dc,
    performers,
    performersLabel: performers === 1 ? 'Solo' : String(performers),
    bonuses,
    hasBonuses: bonuses.some(cell => cell.granted),
    hasTrack: Boolean(linked),
    track: facts ? trackCard(facts, durations) : null,
    trackMissing: Boolean(linked) && !facts,
    group: need > 0,
    need,
    chosen,
    needLabel: `${chosen}/${need} chosen`,
    short: need > free
  });
}

/** The track card: one sound by its playlist and its file's length once read, a whole playlist by its sound count. */
function trackCard(facts, durations) {
  const sound = facts.kind === 'sound';
  const count = Number(facts.soundCount) || 0;
  return Object.freeze({
    uuid: facts.uuid,
    name: facts.name || 'Unnamed track',
    sub: sound ? (facts.playlist ? `${facts.playlist} playlist` : 'Playlist sound') : 'Whole playlist',
    path: sound ? String(facts.path ?? '') : '',
    duration: sound ? formatDuration(durations?.[facts.path]) : '',
    sounds: sound ? '' : `${count} sound${count === 1 ? '' : 's'}`,
    repeat: facts.repeat === true
  });
}

function blockReason({ performers, active, songs, song, detail }) {
  if (!performers.length) return 'No party member is on this map';
  if (!active) return 'No party member can perform right now';
  if (!songs.length) return 'This performer knows no songs';
  if (!song) return 'Select a song';
  if (detail.short) return 'Not enough free party members to accompany this song';
  if (detail.chosen < detail.need) {
    const missing = detail.need - detail.chosen;
    return `Choose ${missing} more accompaniment${missing === 1 ? '' : 's'}`;
  }
  if (detail.chosen > detail.need) return `Choose only ${detail.need} accompaniment${detail.need === 1 ? '' : 's'}`;
  return '';
}

/** Join names for the footer line: "Ana", "Ana and Bo", "Ana, Bo and Cy". */
function listNames(names) {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Render the body, and write the lead it shows back into the picks, so a lead who became unavailable is replaced. */
async function render(view, state) {
  const prepared = preparePerformanceView(view, state);
  state.performerUuid = prepared.performers.find(entry => entry.selected)?.actorUuid ?? null;
  return globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, prepared);
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */
/**
 * Read the linked track's length in the background and write it into the card when it arrives. The answer is kept
 * on the menu's state so a rebuilt body shows it at once. probeTrackDuration in foundry/adapters/services/audio.mjs
 * reads each file once per session.
 */
function fillTrackDuration(menu) {
  const path = String(menu.root.querySelector('.pf-track[data-track-path]')?.dataset.trackPath ?? '');
  if (!path || path in menu.state.trackDurations) return;
  void probeTrackDuration(path).then(seconds => {
    menu.state.trackDurations[path] = seconds;
    const card = menu.root.querySelector('.pf-track[data-track-path]');
    if (card?.dataset.trackPath !== path) return;
    const slot = card.querySelector('.pf-track-duration');
    if (slot) slot.textContent = formatDuration(seconds);
  });
}

/** Pick the lead, who then no longer counts among the accompanists. */
function selectLead(menu, pick) {
  selectPerformer(menu, pick, (state, uuid) => {
    state.accompanimentUuids = state.accompanimentUuids.filter(entry => entry !== uuid);
  });
}

function selectSong(menu, row) {
  if (menu.state.busy) return;
  const id = String(row.dataset.id ?? '');
  menu.state.songId = menu.state.songId === id ? null : id;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/** Tick or untick one accompanist. A blocked unit, or one more than the song needs, plays the error sound instead. */
function toggleAccompaniment(menu, row) {
  if (menu.state.busy) return;
  const uuid = String(row.dataset.uuid ?? '');
  const picks = menu.state.accompanimentUuids;
  if (picks.includes(uuid)) {
    menu.state.accompanimentUuids = picks.filter(entry => entry !== uuid);
  } else {
    const detail = preparePerformanceView(menu.view, menu.state).detail;
    if (row.dataset.blocked === 'true' || !detail || detail.chosen >= detail.need) {
      playUiSound(SOUND_IDS.UI_ERROR);
      return;
    }
    menu.state.accompanimentUuids = [...picks, uuid];
  }
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/**
 * Send the perform command with the lead, the song and the accompanists. The API shows the result, including any
 * refusal, as a notification.
 */
async function beginPerformance(menu) {
  const { view, state } = menu;
  const prepared = preparePerformanceView(view, state);
  const lead = prepared.performers.find(row => row.selected) ?? null;
  const song = prepared.songs.find(row => row.selected) ?? null;
  if (!lead || !song || !prepared.canPerform || state.busy) return;
  try {
    const result = await submitMenu(menu, () => game.emblemRpg.api.downtime.perform({
      cursorTokenUuid: view.cursorTokenUuid,
      stationTokenUuid: view.stationTokenUuid,
      performerUuid: lead.actorUuid,
      songId: song.id,
      accompanimentUuids: prepared.accompaniments.filter(row => row.chosen).map(row => row.actorUuid)
    }));
    state.performed = result?.ok === true;
  } finally {
    state.busy = false;
  }
}
