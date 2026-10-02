/** @layer foundry/adapters/services */
import { phaseMusicTrack, phaseMusicTracks } from '../../../game/combat/phases.mjs';
import { projectPhaseMusic } from '../projections/encounters.mjs';
import { isAirborneActor } from '../projections/combat-context.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { isActiveGm as localUserIsActiveGm, readSetting } from './host.mjs';
import { VOICE_PATH_APPROVALS_SETTING, VOICELINE_FREQUENCY_SETTING } from '../../../config/settings.mjs';
import { plainRecord, SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { ENCOUNTER_ROUND_FLAG } from '../../../contracts/domains/combat.mjs';
import { AUDIO_CHANNELS, normalizeAudioFolderPath, VOICE_CATEGORIES } from '../../../contracts/domains/tokens.mjs';
import { pageHidden } from '../../../lib/dom/visibility.mjs';
import { audioChannelReady } from '../../../external/sequencer/runtime.mjs';
import { reportFoundryError, reportFoundryProbe } from './diagnostics.mjs';

/* -------------------------------------------- */
/*  Audio playback                              */
/* -------------------------------------------- */
/** Plays the system's sounds for the audio service (presentation/audio/service.mjs). */
export class FoundryAudioPlayer {
  /**
   * Play a sound through Sequencer when it needs a delay, fade or time range, otherwise through Foundry's
   * AudioHelper. A request that isn't a broadcast is dropped while the page is hidden or the browser still has
   * audio locked. Only the AudioHelper path sends a broadcast to other clients. The Sequencer path plays locally.
   */
  async play(request) {
    const locked = globalThis.game?.audio?.locked === true;
    if (request.broadcast !== true && (locked || pageHidden())) return null;
    if (globalThis.Sequence && (request.delay || request.fadeIn || request.fadeOut || request.timeRange)) {
      const sequence = new Sequence();
      let sound = sequence.sound().file(request.src).locally().volume(request.volume ?? 1);
      const channel = resolvedChannel(request.channel);
      if (audioChannelReady(channel)) sound = sound.audioChannel(channel);
      if (request.delay) sound = sound.delay(request.delay);
      if (request.fadeIn) sound = sound.fadeInAudio(request.fadeIn);
      if (request.fadeOut) sound = sound.fadeOutAudio(request.fadeOut);
      if (Array.isArray(request.timeRange) && request.timeRange.length === 2) {
        sound = sound.timeRange(request.timeRange[0], request.timeRange[1]);
      }
      const playback = sequence.play();
      if (locked) void Promise.resolve(playback).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'play'); return null; });
      else await playback;
      return null;
    }
    const playback = foundry.audio.AudioHelper.play({
      src: request.src,
      volume: request.volume ?? 1,
      loop: request.loop ?? false,
      channel: resolvedChannel(request.channel)
    }, request.broadcast === true);
    if (!locked) return playback;
    void Promise.resolve(playback).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'play'); return null; });
    return null;
  }

  /** Load a file ahead of time so its first play doesn't wait on the fetch. A failed fetch is reported. */
  async preload(src) {
    try {
      await foundry.audio.AudioHelper.preloadSound(src);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'preload');
      return false;
    }
  }
}

/**
 * Always name a channel, the interface one by default. An undefined channel key overrides AudioHelper.play's own
 * default, and the sound then plays on the music channel.
 */
function resolvedChannel(requested) {
  return requested || AUDIO_CHANNELS.INTERFACE;
}

/* -------------------------------------------- */
/*  Phase music                                 */
/* -------------------------------------------- */

const PHASE_MUSIC_FADE_IN_MS = 500;
const PHASE_MUSIC_FADE_OUT_MS = 1000;

/**
 * Phase music, run on the host client. While an encounter runs, its Scene's configured phase track replaces the
 * Scene's own music and restarts on each phase change. syncPhaseMusic and restorePhaseMusic in init/system.mjs
 * drive it from Scene and encounter hooks.
 */
export class FoundryPhaseMusic {
  #playing = '';
  #playingKey = '';
  #scene = null;

  /**
   * Bring the music in line with the running encounter's Scene. A track already playing for the same phase, round
   * and track is left alone. A new phase or round restarts it. The Scene's own music comes back when no phase track
   * is set or the track can't be found. Calls are not queued: one phase change can fire both the combat and the
   * scene update hooks, and the two syncs can overlap.
   */
  async sync(scene) {
    if (!localUserIsActiveGm()) return;
    const owner = musicOwnerScene(scene, this.#scene);
    if (!owner) {
      if (this.#playing && this.#scene) await this.restore(this.#scene);
      return;
    }
    const music = projectPhaseMusic(owner);
    const wanted = phaseMusicTrack(music);
    const track = wanted ? await resolveTrack(wanted) : null;
    if (!track) {
      if (this.#playing) await this.restore(owner);
      return;
    }
    const key = [owner.uuid, music.phase, owner.getFlag(SYSTEM_ID, ENCOUNTER_ROUND_FLAG) ?? '', wanted].join('|');
    if ((key === this.#playingKey || !this.#playingKey) && trackPlaying(track)) {
      this.#adopt(owner, wanted, key);
      return;
    }
    await this.#takeOver(owner, wanted, track);
    this.#adopt(owner, wanted, key);
  }

  /** Stop every phase track and put the Scene's own music back. */
  async restore(scene) {
    if (!localUserIsActiveGm()) return;
    await this.#stopTracks(scene, '');
    this.#playing = '';
    this.#playingKey = '';
    this.#scene = null;
    await playSceneMusic(scene);
  }

  /** Remember the track now playing, so a later sync can tell a new phase from the same one. */
  #adopt(scene, uuid, key) {
    this.#playing = uuid;
    this.#playingKey = key;
    this.#scene = scene;
  }

  /**
   * Switch to one track: stop the other phase tracks and the Scene's own music, then play it. A single sound is set
   * to repeat first, so it loops for the whole phase. A whole Playlist keeps its own mode.
   */
  async #takeOver(scene, uuid, track) {
    await this.#stopTracks(scene, uuid, this.#playing);
    this.#playing = uuid;
    await stopSceneMusic(scene);
    await repeatSound(track);
    await playTrack(track);
  }

  /** Stop every configured track and whatever this service last started, except the one taking over. */
  async #stopTracks(scene, keepUuid, playing = this.#playing) {
    const uuids = new Set([...phaseMusicTracks(projectPhaseMusic(scene)), playing]);
    uuids.delete('');
    uuids.delete(keepUuid);
    for (const uuid of uuids) await stopTrack(await resolveTrack(uuid));
  }
}

/**
 * The Scene whose running encounter decides the music: the one asked about if it has one, then the one whose track
 * is already playing, then the world's only running encounter. So a GM viewing another Scene never takes the music
 * away from a battle.
 * @param {object|null} scene Scene the sync was asked about, usually the one this client displays.
 * @param {object|null} current Scene whose phase track is already playing.
 * @returns {object|null}
 */
function musicOwnerScene(scene, current) {
  const running = collectionValues(globalThis.game?.combats)
    .map(combat => (combat?.started === true ? combat.scene : null))
    .filter(Boolean);
  const held = candidate => (candidate ? running.find(owner => owner.id === candidate.id) ?? null : null);
  return held(scene) ?? held(current) ?? (running.length === 1 ? running[0] : null);
}

/** Set a single-sound phase track to repeat. Performance tracks never call this: their end brings the earlier music back. */
async function repeatSound({ sound }) {
  if (!sound || sound.repeat === true) return;
  try {
    await sound.update({ repeat: true });
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'repeatSound');
  }
}

/** Whether a resolved track is already playing. */
function trackPlaying({ playlist, sound }) {
  return sound ? sound.playing === true : playlist.playing === true;
}

/* -------------------------------------------- */
/*  Performance music                           */
/* -------------------------------------------- */

/**
 * Performance music on the host client: every PlaylistSound playing fades out and the song fades in. When the song
 * stops, by ending or by the GM stopping it, the earlier sounds fade back in; `stop` cuts it off and brings them
 * back at once. A second performance replaces the first and still restores the sounds from before the first. Only
 * this browser tab remembers what to restore, so after a host reload the song plays out and nothing resumes.
 */
export class FoundryPerformanceMusic {
  /** The track playing now and the earlier sounds it silenced. `started` turns true once its playback began. */
  #running = null;

  /** The latest `play` still starting. `stop` waits for it, so it can't race the track's start. */
  #starting = Promise.resolve(false);

  /**
   * Silence what's playing and start the track a Playlist or PlaylistSound UUID names. Returns whether the track
   * began. If it didn't, the earlier sounds come straight back. Errors are reported here, not thrown.
   * @param {string} uuid The song's track.
   * @returns {Promise<boolean>}
   */
  async play(uuid) {
    if (!localUserIsActiveGm()) return false;
    const starting = this.#start(uuid);
    this.#starting = starting;
    return starting;
  }

  /**
   * Cut the running track off without a fade and fade the sounds it silenced straight back in, as its natural end
   * would. Waits for a `play` still starting, so a track cut off as it begins still stops. Returns whether a track
   * was running. Errors are reported here, not thrown.
   * @returns {Promise<boolean>}
   */
  async stop() {
    if (!localUserIsActiveGm()) return false;
    try {
      await this.#starting;
      const running = this.#running;
      if (!running) return false;
      this.#running = null;
      await cutTrack(running.track);
      await resumeSounds(running);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'performance-stop');
      return false;
    }
  }

  async #start(uuid) {
    try {
      const track = await resolveTrack(String(uuid ?? ''));
      if (!track) return false;
      const earlier = this.#running;
      const owned = trackSoundUuids(track);
      const previous = (earlier?.previous ?? playingSoundUuids()).filter(entry => !owned.has(entry));
      const running = { track, previous, started: false };
      this.#running = running;
      if (earlier) await stopTrack(earlier.track);
      for (const entry of previous) await stopTrack(await resolveTrack(entry));
      await playTrack(track);
      if (this.#running !== running) return true;
      running.started = true;
      this.#settleIfStopped();
      return trackPlaying(track);
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'performance-play');
      return false;
    }
  }

  /** Resume the earlier sounds once the track stops. init/hooks.mjs routes `updatePlaylistSound` here. */
  onPlaylistSoundUpdate(sound, changes) {
    if (changes?.playing === false) this.#settleIfStopped();
  }

  /**
   * The same for a stop Foundry writes on the parent Playlist, which is how the playlist directory's stop button and
   * a sound's natural end reach every client. init/hooks.mjs routes `updatePlaylist` here.
   */
  onPlaylistUpdate(playlist, changes) {
    if (changes?.playing === false || Array.isArray(changes?.sounds)) this.#settleIfStopped();
  }

  /** Once the track has started and stopped playing, forget it and fade the earlier sounds back in. */
  #settleIfStopped() {
    const running = this.#running;
    if (!running?.started || !localUserIsActiveGm() || trackPlaying(running.track)) return;
    this.#running = null;
    void resumeSounds(running).catch(diagnosticError => {
      reportFoundryError(import.meta.url, diagnosticError, 'performance-resume');
    });
  }
}

/**
 * Stop a performance track at once: its fade drops to zero first, so every client's PlaylistSound sync stops it
 * without fading out, then the stop is written. playTrack sets the fade-in again before the track next plays.
 */
async function cutTrack(track) {
  const { playlist, sound } = track;
  try {
    await setTrackFade(track, 0);
    if (!sound) {
      if (playlist.playing) await playlist.stopAll();
      return;
    }
    if (sound.playing) await playlist.stopSound(sound);
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'cutTrack');
  }
}

/**
 * Fade the sounds a performance silenced back in. A single-sound track's own Playlist may have moved on to its
 * next sound when the track ended. That sound wasn't playing before, so it's stopped first.
 */
async function resumeSounds({ track, previous }) {
  const earlier = new Set(previous);
  if (track.sound) {
    for (const other of track.playlist.sounds) {
      if (!other.playing || earlier.has(String(other.uuid))) continue;
      startPlayback(track.playlist.stopSound(other), 'resumeSounds');
    }
  }
  for (const uuid of previous) {
    const resumed = await resolveTrack(uuid);
    if (!resumed?.sound || resumed.sound.playing) continue;
    await setTrackFade(resumed, PHASE_MUSIC_FADE_IN_MS);
    startPlayback(resumed.playlist.playSound(resumed.sound), 'resumeSounds');
  }
}

/** Every PlaylistSound playing across the world's Playlists, by uuid. */
function playingSoundUuids() {
  const uuids = [];
  for (const playlist of collectionValues(globalThis.game?.playlists)) {
    for (const sound of collectionValues(playlist.sounds)) if (sound.playing === true) uuids.push(String(sound.uuid));
  }
  return uuids;
}

/** The PlaylistSound uuids a track plays: the one sound, or every sound of a whole Playlist. */
function trackSoundUuids({ playlist, sound }) {
  return new Set((sound ? [sound] : collectionValues(playlist.sounds)).map(entry => String(entry.uuid)));
}

/* -------------------------------------------- */
/*  Track resolution                            */
/* -------------------------------------------- */

/**
 * Resolve a configured uuid to the Playlist or PlaylistSound it names.
 *
 * Type-checked rather than trusted, since a configured track can point at a document that has since been
 * deleted or replaced by one of a different kind.
 */
async function resolveTrack(uuid) {
  if (!uuid) return null;
  let document = null;
  try { document = await globalThis.fromUuid(uuid); } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'resolveTrack');
    return null;
  }
  if (document?.documentName === 'PlaylistSound') {
    return document.parent ? Object.freeze({ playlist: document.parent, sound: document }) : null;
  }
  if (document?.documentName === 'Playlist') return Object.freeze({ playlist: document, sound: null });
  return null;
}

/** How long a track's metadata read may take before the Instrument menu stops waiting for its length. */
const TRACK_PROBE_TIMEOUT_MS = 8000;
const trackDurations = new Map();

/**
 * Read how long a track's audio file runs, for the Instrument menu's track card
 * (ui/apps/menus/performance-app.mjs). Only the file's metadata is fetched, through a detached audio element that
 * never plays. Each path is read once per session, and a file that can't be read gives null.
 * @param {string} path The PlaylistSound's audio path.
 * @returns {Promise<number|null>} The length in seconds.
 */
export function probeTrackDuration(path) {
  const src = String(path ?? '');
  if (!src) return Promise.resolve(null);
  if (!trackDurations.has(src)) trackDurations.set(src, readTrackDuration(src));
  return trackDurations.get(src);
}

function readTrackDuration(src) {
  const AudioElement = globalThis.Audio;
  if (typeof AudioElement !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    const audio = new AudioElement();
    let timer = null;
    const settle = seconds => {
      clearTimeout(timer);
      audio.removeAttribute?.('src');
      resolve(seconds);
    };
    timer = setTimeout(() => settle(null), TRACK_PROBE_TIMEOUT_MS);
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      settle(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    }, { once: true });
    audio.addEventListener('error', () => settle(null), { once: true });
    audio.src = foundry.utils.getRoute(src);
  });
}

/**
 * Play a Playlist or PlaylistSound from the beginning, with the phase fade-in. For a single sound, the Playlist's
 * other sounds are stopped and a paused position is cleared first.
 */
async function playTrack(track) {
  const { playlist, sound } = track;
  try {
    await setTrackFade(track, PHASE_MUSIC_FADE_IN_MS);
    if (!sound) {
      if (playlist.playing) await playlist.stopAll();
      await playlist.playAll();
      return;
    }
    for (const other of playlist.sounds) {
      if (other.id !== sound.id && other.playing) await playlist.stopSound(other);
    }
    if (sound.playing) await playlist.stopSound(sound);
    if (sound.pausedTime) await sound.update({ pausedTime: null });
    await playlist.playSound(sound);
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playTrack');
  }
}

/** Silence one track, whichever kind it turned out to be. */
async function stopTrack(track) {
  if (!track) return;
  const { playlist, sound } = track;
  try {
    if (!sound) {
      if (playlist.playing) {
        await setTrackFade(track, PHASE_MUSIC_FADE_OUT_MS);
        startPlayback(playlist.stopAll(), 'stopTrack');
      }
      return;
    }
    if (sound.playing) {
      await setTrackFade(track, PHASE_MUSIC_FADE_OUT_MS);
      startPlayback(playlist.stopSound(sound), 'stopTrack');
    }
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'stopTrack');
  }
}

/** Start a core playback operation without making the phase transition wait for its fade. */
function startPlayback(playback, operation) {
  void Promise.resolve(playback).catch((diagnosticError) => {
    reportFoundryError(import.meta.url, diagnosticError, operation);
  });
}

/** Set the fade Foundry applies when this phase track is next forced to start or stop. */
async function setTrackFade(track, fade) {
  const document = track.sound ?? track.playlist;
  if (document.fade === fade) return;
  await document.update({ fade });
}

/* -------------------------------------------- */
/*  Scene music                                 */
/* -------------------------------------------- */

/** Resume the Scene's own music, whether that is a single sound or a whole playlist. */
async function playSceneMusic(scene) {
  try {
    if (scene?.playlistSound) {
      if (!scene.playlistSound.playing) await scene.playlistSound.update({ playing: true });
    } else if (scene?.playlist) await scene.playlist.playAll();
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playSceneMusic');
  }
}

/** Silence the Scene's own music while a phase track plays. */
async function stopSceneMusic(scene) {
  try {
    if (scene?.playlistSound) {
      if (scene.playlistSound.playing) await scene.playlistSound.update({ playing: false });
    } else if (scene?.playlist) await scene.playlist.stopAll();
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'stopSceneMusic');
  }
}

/* -------------------------------------------- */
/*  Unit audio                                  */
/* -------------------------------------------- */
/**
 * Unit voice and footstep audio: what unit audio reads from an actor, clip lookup in the Data folders, and the GM's
 * approval map for custom audio folders (VOICE_PATH_APPROVALS_SETTING).
 */
class FoundryUnitAudioRepository {
  /** The approval write still in flight, which the next one waits behind. */
  #approvalWrites = Promise.resolve();

  /** What voice playback needs from an actor: the voice folder, whether a GM approved it, and HP. */
  voiceFacts(actor) {
    const voicePath = normalizeAudioFolderPath(actor?.system?.art?.voicePath) ?? '';
    return Object.freeze({
      actorId: String(actor?.id ?? ''),
      actorName: String(actor?.name ?? 'this unit'),
      voicePath,
      voiceApproved: voicePath ? this.isVoicePathApproved(actor) : false,
      hp: Number(actor?.system?.resources?.hp?.value) || 0,
      hpMax: Number(actor?.system?.resources?.hp?.max) || 0
    });
  }

  /** A random level-up clip from the actor's approved voice folder, with its length, or null. */
  async levelVoiceClip(actor, quality = 'good') {
    const facts = this.voiceFacts(actor);
    if (!facts.voicePath || !facts.voiceApproved) return null;
    const categoryKey = quality === 'bad' ? 'levelBad' : 'levelGood';
    const folder = VOICE_CATEGORIES.find(category => category.key === categoryKey)?.folder;
    if (!folder) return null;
    const files = await this.listAudio(`${facts.voicePath}/${folder}`);
    if (!files.length) return null;
    const file = files[Math.floor(Math.random() * files.length)];
    return Object.freeze({ file, durationMs: await audioDurationMs(file) });
  }

  /** A random critical-hit clip from the actor's approved voice folder, for a combat exchange, or null. */
  async criticalVoiceClip(actorUuid) {
    let actor = null;
    try { actor = await globalThis.fromUuid(String(actorUuid ?? '')); } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'criticalVoiceClip');
      actor = null;
    }
    if (actor?.documentName !== 'Actor') return null;
    const facts = this.voiceFacts(actor);
    const folder = VOICE_CATEGORIES.find(category => category.key === 'crit')?.folder;
    if (!facts.voicePath || !facts.voiceApproved || !folder) return null;
    const files = await this.listAudio(`${facts.voicePath}/${folder}`);
    return files.length ? files[Math.floor(Math.random() * files.length)] : null;
  }

  /** A random clip from one voice category of the actor's approved voice folder, or null. */
  async voiceCategoryClip(actorUuid, categoryKey) {
    let actor = null;
    try { actor = await globalThis.fromUuid(String(actorUuid ?? '')); } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'voiceCategoryClip');
      actor = null;
    }
    if (actor?.documentName !== 'Actor') return null;
    const facts = this.voiceFacts(actor);
    const folder = VOICE_CATEGORIES.find(category => category.key === categoryKey)?.folder;
    if (!facts.voicePath || !facts.voiceApproved || !folder) return null;
    const files = await this.listAudio(`${facts.voicePath}/${folder}`);
    return files.length ? files[Math.floor(Math.random() * files.length)] : null;
  }

  /**
   * What footstep sounds need from a token: whether it's airborne, mounted or armored, and its custom footstep
   * folders, each kept only if a GM approved it.
   */
  footstepFacts(tokenDocument) {
    const actor = tokenDocument?.actor;
    const unitType = actor?.system?.unitType ?? {};
    const footsteps = foundry.utils.deepClone(actor?.system?.art?.footsteps ?? {});
    for (const [mode, authored] of Object.entries(footsteps)) {
      const path = normalizeAudioFolderPath(authored?.customPath);
      authored.customPath = path && this.isFootstepPathApproved(actor, mode, path) ? path : '';
    }
    return Object.freeze({
      tokenUuid: String(tokenDocument?.uuid ?? ''),
      airborne: isAirborneActor(actor),
      mounted: actor?.system?.statuses?.mounted === true,
      armored: unitType.armored === true,
      footsteps: Object.freeze(footsteps)
    });
  }

  /**
   * Footstep timing for one finished move: the step count and the animation's length. null for a move that puts a
   * token back after a failed command, or a move made outside movement planning.
   */
  movementFootstepFacts(tokenDocument, movement, operation = {}) {
    const waypoints = movement?.passed?.waypoints;
    if (operation.emblemMovementRestore === true || !Array.isArray(waypoints) || !waypoints.length) return null;
    if (tokenDocument?.actor?.system?.turn?.movementPlanning !== true) return null;
    return Object.freeze({
      facts: this.footstepFacts(tokenDocument),
      stepCount: waypoints.length,
      duration: Math.max(0, Number(movement?.animation?.duration) || 0)
    });
  }

  /** Read the receiving client's voice-frequency and combat-phase context. */
  voicePlaybackContext() {
    const mode = readSetting(VOICELINE_FREQUENCY_SETTING, 'normal') || 'normal';
    const scene = globalThis.canvas?.scene;
    const combat = game.combat;
    const inSceneCombat = combat?.started === true && (!scene || !combat.scene || combat.scene.id === scene.id);
    const phase = inSceneCombat ? scene?.getFlag(SYSTEM_ID, 'combatPhase') : null;
    const round = phase === 'Player' || phase === 'Enemy'
      ? String(scene?.getFlag(SYSTEM_ID, 'emblemRound') ?? 1)
      : null;
    return Object.freeze({ mode, phaseKey: round });
  }

  /** List supported audio files in a Foundry data-source folder. */
  async listAudio(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') return [];
    try {
      const response = await foundry.applications.apps.FilePicker.browse('data', folderPath);
      return Object.freeze((response?.files ?? []).filter(isAudioFile));
    } catch (diagnosticError) {
      reportFoundryProbe(import.meta.url, diagnosticError, 'listAudio', /ENOENT|does not exist|no such file or directory/i.test(String(diagnosticError?.message ?? '')));
      return [];
    }
  }

  /** Check the Actor's current voice path against the separate GM-owned approval map. */
  isVoicePathApproved(actor) {
    const key = voiceApprovalKey(actor);
    const path = normalizeAudioFolderPath(actor?.system?.art?.voicePath);
    if (!key || !path) return false;
    const approvals = readSetting(VOICE_PATH_APPROVALS_SETTING);
    return plainRecord(approvals) && Object.hasOwn(approvals, key) && approvals[key] === path;
  }

  /** Record or clear the exact voice folder a GM approved, so the host client may list its files. */
  async approveVoicePath(actor, rawPath) {
    const key = voiceApprovalKey(actor);
    return this.#approvePath(key, rawPath);
  }

  /**
   * Approve the current voice folders of a batch of imported Actors in one setting write, so the host client may
   * list their clips.
   */
  async approveVoicePathsFor(actors) {
    if (!game.user?.isGM) return 0;
    return this.#writeApprovals(next => {
      let changed = 0;
      for (const actor of actors ?? []) {
        const key = voiceApprovalKey(actor);
        const path = normalizeAudioFolderPath(actor?.system?.art?.voicePath);
        if (!key || !path || next[key] === path) continue;
        next[key] = path;
        changed += 1;
      }
      return changed;
    }, changed => changed > 0);
  }

  /** Check a custom footstep folder against the GM-owned approval map. */
  isFootstepPathApproved(actor, mode, path) {
    return approvedPath(footstepApprovalKey(actor, mode), path);
  }

  /** Record or clear a custom footstep folder edited by a GM. */
  async approveFootstepPath(actor, mode, rawPath) {
    return this.#approvePath(footstepApprovalKey(actor, mode), rawPath);
  }

  async #approvePath(key, rawPath) {
    if (!game.user?.isGM || !key) return false;
    const path = rawPath === '' || rawPath == null ? null : normalizeAudioFolderPath(rawPath);
    if (rawPath !== '' && rawPath != null && !path) return false;
    await this.#writeApprovals(next => {
      if (path) next[key] = path;
      else delete next[key];
    }, () => true);
    return true;
  }

  /**
   * Apply approval-map changes one at a time. Each reads the setting after the previous write, so two imports at
   * once can't overwrite each other.
   * @param {Function} change Mutates the fresh map and returns its outcome.
   * @param {Function} shouldWrite Whether that outcome needs the setting written.
   * @returns {Promise<*>} The change's outcome.
   */
  #writeApprovals(change, shouldWrite) {
    const run = this.#approvalWrites.then(async () => {
      const next = sanitizedApprovals();
      const outcome = change(next);
      if (shouldWrite(outcome)) await game.settings.set(SYSTEM_ID, VOICE_PATH_APPROVALS_SETTING, next);
      return outcome;
    });
    this.#approvalWrites = run.catch(error => reportFoundryProbe(import.meta.url, error, 'writeApprovals', true));
    return run;
  }

  /**
   * The placeable for a presentation message's token UUID on this client, or null. Falls back to the displayed
   * canvas's token with the same id.
   */
  tokenPlaceable(tokenUuid) {
    if (!tokenUuid) return null;
    let document = null;
    try {
      document = foundry.utils.fromUuidSync(tokenUuid);
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'tokenPlaceable');
    }
    if (document?.object) return document.object;
    const tokenId = String(tokenUuid).split('.').pop();
    return globalThis.canvas?.tokens?.get?.(tokenId) ?? null;
  }
}

/**
 * The single instance for this browser tab. Sharing one instance means every approval write queues behind the one
 * before it.
 */
export const unitAudioRepository = new FoundryUnitAudioRepository();

/* -------------------------------------------- */
/*  Approval and file helpers                   */
/* -------------------------------------------- */
const ACTOR_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_ACTOR_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const AUDIO_EXTENSIONS = new Set(['.ogg', '.wav', '.mp3']);

function voiceApprovalKey(actor) {
  const id = actor?.id;
  return validActorKey(id) ? id : null;
}

function footstepApprovalKey(actor, mode) {
  const actorKey = voiceApprovalKey(actor);
  return actorKey && ['onFoot', 'armored', 'mounted', 'flying'].includes(mode)
    ? `${actorKey}:footstep:${mode}` : null;
}

function validActorKey(id) {
  return typeof id === 'string' && ACTOR_KEY.test(id) && !FORBIDDEN_ACTOR_KEYS.has(id);
}

function approvedPath(key, path) {
  if (!key || !path) return false;
  const approvals = readSetting(VOICE_PATH_APPROVALS_SETTING);
  return plainRecord(approvals) && Object.hasOwn(approvals, key) && approvals[key] === path;
}

function sanitizedApprovals() {
  const stored = readSetting(VOICE_PATH_APPROVALS_SETTING, {});
  return Object.fromEntries(Object.entries(plainRecord(stored) ? stored : {}).filter(([key, value]) => (
    /^[A-Za-z0-9_:-]{1,128}$/.test(key)
      && !FORBIDDEN_ACTOR_KEYS.has(key)
      && normalizeAudioFolderPath(value) === value
  )));
}

async function audioDurationMs(file) {
  try {
    const sound = await foundry.audio.AudioHelper.preloadSound(file);
    const seconds = Number(sound?.duration);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'audioDurationMs');
    return 0;
  }
}

function isAudioFile(file) {
  const path = String(file).toLowerCase();
  return AUDIO_EXTENSIONS.has(path.slice(path.lastIndexOf('.')));
}
