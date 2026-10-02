/** @layer ui/apps/menus */
import { STATS } from '../../../contracts/domains/characters.mjs';
import { DOWNTIME_STATION_TYPES, SONG_LIMITS, SONG_STAT_KEYS } from '../../../contracts/domains/downtime.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { missingBuiltins } from '../../../game/downtime/library.mjs';
import { newSong, normalizeSong } from '../../../game/downtime/performance.mjs';
import { SHEET_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';
import { LibraryApp } from './library-app.mjs';

/* -------------------------------------------- */
/*  Song library                                */
/* -------------------------------------------- */
/** The drag payload a Personal song row carries, dropped on a unit's sheet to teach it. */
export const SONG_DRAG_TYPE = 'EmblemSong';

const TABS = Object.freeze({
  default: Object.freeze({
    label: 'Default', icon: 'fas fa-book-open', title: 'Songs every Instrument offers', isDefault: true
  }),
  personal: Object.freeze({
    label: 'Personal', icon: 'fas fa-user-pen', title: 'Songs only the units they are linked to can lead',
    isDefault: false
  })
});
const STAT_BY_KEY = Object.freeze(Object.fromEntries(STATS.map(stat => [stat.key, stat])));
const NO_TRACKS = Object.freeze({ playlists: Object.freeze([]), sounds: Object.freeze([]) });

/**
 * The world Song Library, a LibraryApp in the Recipe Library's frame and styles whose detail pane edits a song's
 * performers, stat bonuses and track.
 */
export class SongLibraryApp extends LibraryApp {
  /* -------------------------------------------- */
  /*  Application configuration                   */
  /* -------------------------------------------- */
  static DEFAULT_OPTIONS = {
    id: 'emblem-song-library',
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-crafting-settings', 'recipe-library', 'song-library'],
    tag: 'div',
    window: { title: 'Song Library', icon: 'fas fa-music', resizable: true, minimizable: true },
    position: { width: 690, height: 640 },
    actions: {
      setTab: LibraryApp.setTab,
      selectSong: LibraryApp.selectEntry,
      addSong: LibraryApp.addEntry,
      deleteSong: LibraryApp.deleteEntry,
      moveSong: LibraryApp.moveEntry,
      restoreBuiltins: LibraryApp.restoreBuiltins,
      pickImage: LibraryApp.pickImage,
      save: LibraryApp.save,
      cancel: LibraryApp.cancel
    }
  };

  static PARTS = { main: { template: `systems/${SYSTEM_ID}/templates/editors/song-library.hbs` } };

  static LIBRARY = Object.freeze({
    noun: 'song',
    rowClass: 'sl-song',
    dragType: SONG_DRAG_TYPE,
    tabs: TABS,
    addTooltip: SHEET_TOOLTIP_IDS.NEW_SONG,
    stationType: DOWNTIME_STATION_TYPES.PERFORMANCE,
    normalize: normalizeSong,
    create: newSong
  });

  constructor(options = {}) {
    super(options);
    this._trackOptions = NO_TRACKS;
  }

  /* -------------------------------------------- */
  /*  Library parts                               */
  /* -------------------------------------------- */
  async _inspectLibrary() {
    return game.emblemRpg.api.downtime.inspectSongLibrary();
  }

  _readView(view) {
    this._trackOptions = view?.trackOptions ?? NO_TRACKS;
  }

  _rowFields(song) {
    return { performers: song.performers, group: song.performers > 1, hasTrack: Boolean(song.track) };
  }

  _detailContext(selected) {
    return {
      limits: SONG_LIMITS,
      bonuses: selected ? SONG_STAT_KEYS.map(key => ({
        key,
        label: STAT_BY_KEY[key]?.short ?? key,
        value: selected.bonuses?.[key] || '',
        tooltip: getTooltip(SHEET_TOOLTIP_IDS.SONG_BONUS, { label: STAT_BY_KEY[key]?.label ?? key })
      })) : [],
      track: selected ? trackChoices(selected.track, this._trackOptions) : null
    };
  }

  /** Wire the performer count, the stat bonuses and the track, each normalised as normalizeSong stores it. */
  _wireDetail({ selected, byName, row, markDirty }) {
    const normalized = changes => normalizeSong({ ...selected, ...changes }, selected.id);
    byName('performers')?.addEventListener('change', event => {
      selected.performers = normalized({ performers: event.target.value }).performers;
      event.target.value = selected.performers;
      const tag = row('.sl-song-performers');
      if (tag) tag.hidden = selected.performers <= 1;
      const count = row('.sl-song-performers-count');
      if (count) count.textContent = String(selected.performers);
      markDirty();
    });
    for (const key of SONG_STAT_KEYS) {
      byName(`bonus_${key}`)?.addEventListener('change', event => {
        const bonuses = { ...selected.bonuses, [key]: event.target.value };
        selected.bonuses[key] = normalized({ bonuses }).bonuses[key];
        event.target.value = selected.bonuses[key] || '';
        markDirty();
      });
    }
    byName('track')?.addEventListener('change', event => {
      selected.track = normalized({ track: event.target.value }).track;
      const icon = row('.sl-song-track');
      if (icon) icon.hidden = !selected.track;
      markDirty();
    });
  }

  /**
   * Send the whole library through api.downtime.saveSongLibrary, with `removed` listing the built-ins it no longer
   * holds. The server works out the removals itself from the songs and only checks that `removed` is well formed.
   */
  async _saveLibrary(songs) {
    const removed = missingBuiltins(songs, this._builtins).map(song => song.id);
    return game.emblemRpg.api.downtime.saveSongLibrary({ songs, removed });
  }
}

/**
 * Follow a song library change: the open library re-reads unless it has unsaved edits, and the sheets repaint.
 * init/hooks.mjs calls it when the song library revision setting changes, after reloading the library.
 */
export function refreshSongLibraryViews() {
  SongLibraryApp.refreshViews();
}

/**
 * The Track select's choices from the library view's world Playlists: nothing, every whole playlist, then every
 * sound under its own playlist. A stored uuid the world no longer resolves stays selected as unresolved.
 */
function trackChoices(value, options) {
  const current = String(value ?? '');
  const playlists = options.playlists ?? [];
  const groups = options.sounds ?? [];
  const known = new Set([
    ...playlists.map(entry => entry.uuid),
    ...groups.flatMap(group => group.sounds.map(sound => sound.uuid))
  ]);
  return {
    value: current,
    noneSelected: !current,
    stale: Boolean(current) && !known.has(current),
    playlists: playlists.map(entry => ({ ...entry, selected: entry.uuid === current })),
    groups: groups.map(group => ({
      name: group.name,
      sounds: group.sounds.map(sound => ({ ...sound, selected: sound.uuid === current }))
    }))
  };
}
