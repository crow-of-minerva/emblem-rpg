/** @layer presentation/audio */
import { SYSTEM_ID , recordDiagnostic } from '../../contracts/protocol.mjs';
import { OBJECT_PRESENTATION_EVENTS } from '../../contracts/domains/objects.mjs';
import { AUDIO_CHANNELS, VOICE_CATEGORIES } from '../../contracts/domains/tokens.mjs';
import { VOICELINE_FREQUENCY_SETTING } from '../../config/settings.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';
import { SOUND_DATABASE, SOUND_IDS } from './sound-database.mjs';

/* -------------------------------------------- */
/*  Bundled audio                               */
/* -------------------------------------------- */
const DEFAULT_DUCK_MS = 2000;
const DUCK_GRACE_MS = 300;

/**
 * Which UI Sounds group a sound belongs to: `game` for unit control and dialog buttons, `menu` for sheet and menu
 * clicks. Sounds with no group are game events and always play.
 */
export const UI_SOUND_TIERS = Object.freeze({ GAME: 'game', MENU: 'menu' });

/**
 * Whether the UI Sounds setting lets a request of this tier play: All plays both tiers, Game Only plays the game
 * tier, and None plays neither.
 * @param {string} mode The setting value: all, game or none.
 * @param {string|undefined} tier The request's UI_SOUND_TIERS value.
 * @returns {boolean}
 */
export function uiSoundAllowed(mode, tier) {
  if (!tier) return true;
  if (mode === 'none') return false;
  return mode !== 'game' || tier === UI_SOUND_TIERS.GAME;
}

/**
 * Plays the system's bundled sounds by SOUND_IDS id, and authored files such as voice lines, through
 * FoundryAudioPlayer. init/system.mjs builds the only instance, which presenters share and
 * game.emblemRpg.api.presentation.audio exposes.
 */
export class AudioService {
  constructor(player, { ducking = null, now = () => Date.now(), uiSounds = () => 'all' } = {}) {
    this.player = player;
    this.ducking = ducking;
    this.now = now;
    this.uiSounds = uiSounds;
    this.lastPlayed = new Map();
  }

  /**
   * Play one bundled sound by its SOUND_IDS id. Resolves false only when this service skipped it; a sound the player
   * drops afterwards (hidden page, audio not yet unlocked) still resolves true.
   */
  async play(soundId, options = {}) {
    return (await this.start(soundId, options)) !== false;
  }

  /**
   * Start one bundled sound and return the player's playback handle when there is one. A sound with a `floorMs`
   * is skipped if it last played less than that long ago, and a `ui` request is skipped when this client's UI
   * Sounds setting mutes its group.
   */
  async start(soundId, { ui, ...options } = {}) {
    const definition = SOUND_DATABASE[soundId];
    const file = definition?.file ?? definition?.files?.[options.index ?? 0];
    if (!file) return false;
    if (!uiSoundAllowed(this.uiSounds(), ui)) return false;
    if (!this.#passesFloor(soundId, definition)) return false;
    return this.player.play({
      src: `systems/${SYSTEM_ID}/${file}`,
      ...options,
      volume: options.volume ?? definition.volume ?? 1,
      loop: options.loop ?? definition.loop ?? false
    });
  }

  /** Warm one bundled sound before it is first needed. */
  async preload(soundId) {
    const definition = SOUND_DATABASE[soundId];
    const file = definition?.file ?? definition?.files?.[0];
    if (!file || typeof this.player.preload !== 'function') return false;
    return this.player.preload(`systems/${SYSTEM_ID}/${file}`);
  }

  /** Play a GM-approved audio file (such as a voice line), lowering the music while it plays if asked. */
  async playFile(src, options = {}) {
    if (!src) return false;
    const { duck = false, duckMs = null, ...request } = options;
    if (duck && this.ducking) this.ducking.duck();
    const playback = await this.player.play({ src, ...request });
    if (duck && this.ducking) {
      const seconds = Number(playback?.duration);
      const measured = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0;
      const span = Number.isFinite(duckMs) && duckMs > 0 ? duckMs : measured || DEFAULT_DUCK_MS;
      this.ducking.releaseAfter(span + DUCK_GRACE_MS);
    }
    return true;
  }

  #passesFloor(soundId, definition) {
    const floor = Number(definition.floorMs) || 0;
    if (!floor) return true;
    const now = this.now();
    const last = this.lastPlayed.get(soundId);
    if (last !== undefined && now - last < floor) return false;
    this.lastPlayed.set(soundId, now);
    return true;
  }
}

/* -------------------------------------------- */
/*  Music ducking                               */
/* -------------------------------------------- */
const AUDIO_DUCKING = Object.freeze({ factor: 0.3, fadeDownSeconds: 0.15, fadeUpSeconds: 0.4 });

/**
 * Pull the music down while something louder plays over it. Ducks nest, and only the last release brings the
 * music back up.
 */
export class AudioDucking {
  constructor({ diagnostics = null,
    music = () => game.audio.music,
    schedule = (callback, delay) => setTimeout(callback, delay)
  } = {}) {
    this.diagnostics = diagnostics;
    this.music = music;
    this.schedule = schedule;
    this.depth = 0;
    this.baseGain = null;
  }

  /** Take a duck. Only the outermost one ramps the music down. */
  duck() {
    const target = this.#node();
    if (!target) return false;
    if (this.depth === 0) {
      // Foundry's music volume slider sets this same gain node. Remember its level so the release can return to it.
      this.baseGain = target.node.gain.value;
      ramp(target, this.baseGain * AUDIO_DUCKING.factor, AUDIO_DUCKING.fadeDownSeconds, this.diagnostics);
    }
    this.depth += 1;
    return true;
  }

  /** Release one duck. The music comes back up only when the last duck is released; the count never goes below zero. */
  release() {
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth > 0 || this.baseGain === null) return false;
    const target = this.#node();
    if (target) ramp(target, this.baseGain, AUDIO_DUCKING.fadeUpSeconds, this.diagnostics);
    this.baseGain = null;
    return true;
  }

  /** Release a held duck once a span has passed, for callers with no natural release moment. */
  releaseAfter(durationMs) {
    const span = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_DUCK_MS + DUCK_GRACE_MS;
    this.schedule(() => this.release(), span);
  }

  /** Duck for a span and release on a timer, with grace for a sound that runs slightly long. */
  forDuration(durationMs) {
    if (!this.duck()) return false;
    const span = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_DUCK_MS;
    this.releaseAfter(span + DUCK_GRACE_MS);
    return true;
  }

  #node() {
    const context = this.music();
    return context?.gainNode ? { context, node: context.gainNode } : null;
  }
}

function ramp({ context, node }, target, seconds, diagnostics = null) {
  try {
    const now = Number(context.currentTime) || 0;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(target, now + seconds);
  } catch (error) {
    recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'Ramp audio gain' });
    try { node.gain.value = target; } catch (error) {
      recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'Set fallback audio gain' });
    }
  }
}

/** Play a unit-control or dialog-button sound on this client. */
export function playUiSound(soundId, options = {}) {
  void game.emblemRpg.api.presentation.audio.play(soundId, { ui: UI_SOUND_TIERS.GAME, ...options });
}

/** Play one sheet or menu blip, which the UI Sounds setting mutes below All. */
export function playMenuSound(soundId, options = {}) {
  void game.emblemRpg.api.presentation.audio.play(soundId, { ui: UI_SOUND_TIERS.MENU, ...options });
}

/**
 * Whether this client has turned unit voice lines off. Each client plays every voice line for itself, so each line
 * honours its own listener's choice rather than the host's.
 * @returns {boolean}
 */
export function voiceLinesMuted() {
  return game.settings.get(SYSTEM_ID, VOICELINE_FREQUENCY_SETTING) === 'disabled';
}

/* -------------------------------------------- */
/*  Footstep sets                               */
/* -------------------------------------------- */
const MOUNTED_SETS = Object.freeze({
  default: stepSet(SOUND_IDS.FOOTSTEPS_HORSE, 0.2),
  bestial: stepSet(SOUND_IDS.FOOTSTEPS_BEAST, 0.3),
  largeBeast: stepSet(SOUND_IDS.FOOTSTEPS_LARGE_BEAST, 0.3),
  monstrous: stepSet(SOUND_IDS.FOOTSTEPS_OGRE, 0.25),
  dragon: stepSet(SOUND_IDS.FOOTSTEPS_DRAGON, 0.15)
});
const FLYING_SETS = Object.freeze({
  default: stepSet(SOUND_IDS.FOOTSTEPS_FLYING, 0.23),
  levitation: stepSet(SOUND_IDS.FOOTSTEPS_LEVITATION, 1, { sequential: true, fadeIn: 200, fadeOut: 300 }),
  lightFlap: stepSet(SOUND_IDS.FOOTSTEPS_FLAP, 0.4, { simultaneous: true, delay: 300 })
});
const ON_FOOT_SETS = Object.freeze({
  default: stepSet(SOUND_IDS.FOOTSTEPS_FOOT, 0.75),
  bestial: stepSet(SOUND_IDS.FOOTSTEPS_BEAST, 0.3),
  largeBeast: stepSet(SOUND_IDS.FOOTSTEPS_LARGE_BEAST, 0.35),
  monstrous: stepSet(SOUND_IDS.FOOTSTEPS_OGRE, 0.75),
  ghoul: stepSet(SOUND_IDS.FOOTSTEPS_CORPSE, 0.4, { sequential: true }),
  spider: stepSet(SOUND_IDS.FOOTSTEPS_SPIDER, 0.1, { sequential: true }),
  giant: stepSet(SOUND_IDS.FOOTSTEPS_GIANT, 0.3, { sequential: true, minInterval: 450 }),
  skeleton: stepSet(SOUND_IDS.FOOTSTEPS_SKELETON, 0.1, { sequential: true }),
  gooey: stepSet(SOUND_IDS.FOOTSTEPS_GOOEY, 0.5),
  metallic: stepSet(SOUND_IDS.FOOTSTEPS_METALLIC, 0.25),
  dragon: stepSet(SOUND_IDS.FOOTSTEPS_DRAGON, 0.15, { sequential: true })
});
const ARMORED_SETS = Object.freeze({
  default: stepSet(SOUND_IDS.FOOTSTEPS_ARMOR, 0.45),
  metallic: stepSet(SOUND_IDS.FOOTSTEPS_METALLIC, 0.5)
});
const SOUND_FILE_COUNTS = Object.freeze(Object.fromEntries(
  Object.entries(SOUND_DATABASE).map(([id, definition]) => [id, definition.files?.length ?? 1])
));
const VOICE_FOLDERS = Object.freeze(Object.fromEntries(
  VOICE_CATEGORIES.map(category => [category.key, category.folder])
));

/* -------------------------------------------- */
/*  Unit audio presentation                     */
/* -------------------------------------------- */
/**
 * Unit voice lines and footsteps. On the active GM, the unit presentation hooks in init/system.mjs ask this class
 * for selection, Rally and footstep messages and broadcast them. Every client then plays each message with
 * playMessage, which applies that client's own voice-line setting.
 */
export class UnitAudioService {
  constructor({ diagnostics = null,
    audio,
    files,
    notifyUnapproved = () => {},
    now = () => Date.now(),
    random = () => Math.random(),
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancelSchedule = handle => clearTimeout(handle)
  }) {
    this.diagnostics = diagnostics;
    this.audio = audio;
    this.files = files;
    this.notifyUnapproved = notifyUnapproved;
    this.now = now;
    this.random = random;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.selectionTimes = new Map();
    this.voiceState = new Map();
    this.unapprovedActors = new Set();
    this.stepTimes = new Map();
    this.setState = new Map();
    this.customCache = new Map();
    this.customLastFile = null;
    this.movementSchedules = new Map();
  }

  /** Pick a selection voice clip (an injured one below 40% HP) for the message sent to every client. */
  async selectionMessage(facts) {
    const actorId = String(facts?.actorId ?? '');
    const voicePath = String(facts?.voicePath ?? '');
    if (!actorId || !voicePath) return null;
    const now = this.now();
    if (this.selectionTimes.has(actorId) && now - this.selectionTimes.get(actorId) < 1000) return null;
    this.selectionTimes.set(actorId, now);
    if (facts.voiceApproved !== true) {
      if (!this.unapprovedActors.has(actorId)) {
        this.unapprovedActors.add(actorId);
        this.notifyUnapproved({ actorId, actorName: facts.actorName });
      }
      return null;
    }

    const hp = Number(facts.hp) || 0;
    const hpMax = Number(facts.hpMax) || 0;
    let file = null;
    if (hpMax > 0 && hp / hpMax < 0.4) file = await this.#voiceFile(voicePath, VOICE_FOLDERS.injured);
    if (!file) file = await this.#voiceFile(voicePath, VOICE_FOLDERS.select);
    return file ? Object.freeze({ kind: 'voice', actorId, file }) : null;
  }

  /**
   * Pick the voice clip for a Rally that landed. Units with no voice folder stay silent.
   * @param {object} outcome The finished item-activation outcome.
   * @param {object} facts The caster's voice details: actor id, voice folder and whether the GM approved it.
   * @returns {Promise<object|null>} A voice message, or null.
   */
  async rallyMessage(outcome, facts) {
    const landed = (outcome?.deliveries ?? []).some(entry => entry.delivery === 'rally' && entry.landed === true);
    const actorId = String(facts?.actorId ?? '');
    if (!landed || !actorId || !facts?.voicePath || facts.voiceApproved !== true) return null;
    const file = await this.#voiceFile(facts.voicePath, VOICE_FOLDERS.rally);
    return file ? Object.freeze({ kind: 'voice', actorId, file }) : null;
  }

  /** Pick the footstep set for one legal movement update. */
  async footstepMessage(facts) {
    const tokenUuid = String(facts?.tokenUuid ?? '');
    if (!tokenUuid) return null;
    const mode = facts.airborne ? 'flying' : facts.mounted ? 'mounted' : facts.armored ? 'armored' : 'onFoot';
    const authored = facts.footsteps?.[mode] ?? {};
    const preset = String(authored.preset || 'default');
    if (preset === 'custom' && authored.customPath) return this.#customStep(tokenUuid, authored.customPath);
    const sets = mode === 'flying' ? FLYING_SETS
      : mode === 'mounted' ? MOUNTED_SETS
        : mode === 'armored' ? ARMORED_SETS : ON_FOOT_SETS;
    return this.#bundledStep(tokenUuid, mode, sets[preset] ?? sets.default, facts.heldKeyboard === true);
  }

  /** Schedule footstep attempts across one animated Foundry movement path. */
  scheduleMovementFootsteps(facts, movement, emit) {
    const tokenUuid = String(facts?.tokenUuid ?? '');
    const stepCount = Math.max(0, Math.floor(Number(movement?.stepCount) || 0));
    if (!tokenUuid || !stepCount || typeof emit !== 'function') return false;

    this.cancelMovementFootsteps(tokenUuid);
    const duration = Math.max(0, Number(movement?.duration) || 0);
    const attemptCount = duration > 0 ? stepCount : 1;
    const state = { cancelled: false, remaining: attemptCount, timers: new Set() };
    this.movementSchedules.set(tokenUuid, state);
    this.#runMovementFootstep(facts, emit, state);
    for (let index = 1; index < attemptCount; index += 1) {
      const delay = Math.round((duration * index) / stepCount);
      let timer;
      timer = this.schedule(() => {
        state.timers.delete(timer);
        this.#runMovementFootstep(facts, emit, state);
      }, delay);
      state.timers.add(timer);
    }
    return true;
  }

  /** Stop the footsteps still queued for a token whose move was replaced or undone. */
  cancelMovementFootsteps(tokenUuid) {
    const key = String(tokenUuid ?? '');
    const state = this.movementSchedules.get(key);
    if (!state) return false;
    state.cancelled = true;
    for (const timer of state.timers) this.cancelSchedule(timer);
    state.timers.clear();
    this.movementSchedules.delete(key);
    return true;
  }

  /** Play a voice line or footstep on this client, skipping voice lines this player muted or heard too recently. */
  async playMessage(message, context = {}) {
    if (message?.kind === 'voice') {
      if (!this.#voiceAllowed(message.actorId, context)) return false;
      return this.audio.playFile(message.file, { volume: 0.5, channel: AUDIO_CHANNELS.VOICE_OVER });
    }
    if (message?.kind !== 'step') return false;
    await Promise.all(message.sounds.map(sound => sound.soundId
      ? this.audio.play(sound.soundId, { ...sound, channel: 'environment' })
      : this.audio.playFile(sound.file, { ...sound, channel: 'environment' })));
    return true;
  }

  async #emitMovementFootstep(facts, emit, state) {
    if (state.cancelled) return;
    const message = await this.footstepMessage(facts);
    if (message && !state.cancelled) await emit(message);
  }

  #runMovementFootstep(facts, emit, state) {
    const attempt = this.#emitMovementFootstep(facts, emit, state).catch(error => {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: error, detail: 'Emblem RPG | Unit movement presentation failed' });
    });
    void attempt.finally(() => {
      state.remaining -= 1;
      const tokenUuid = String(facts?.tokenUuid ?? '');
      if (state.remaining === 0 && this.movementSchedules.get(tokenUuid) === state) {
        this.movementSchedules.delete(tokenUuid);
      }
    });
  }

  async #voiceFile(base, subfolder) {
    const files = await this.files.listAudio(`${base}/${subfolder}`);
    return files.length ? files[Math.floor(this.random() * files.length)] : null;
  }

  /** One step's sounds. The cadence is kept per token, so two units walking together each keep their own. */
  #bundledStep(tokenUuid, mode, set, heldKeyboard) {
    const now = this.now();
    const walkingInterval = Math.max(set.minInterval ?? 175, heldKeyboard ? 220 : 175);
    const interval = mode === 'flying' ? 700 : mode === 'mounted' ? 300 : walkingInterval;
    const cadenceKey = `${tokenUuid}:${mode}`;
    if (this.stepTimes.has(cadenceKey) && now - this.stepTimes.get(cadenceKey) < interval) return null;
    this.stepTimes.set(cadenceKey, now);
    const count = SOUND_FILE_COUNTS[set.soundId] ?? 1;
    const sounds = set.simultaneous
      ? Array.from({ length: count }, (_value, index) => resolvedSound(set, index, index ? set.delay : 0))
      : [resolvedSound(set, this.#pickIndex(set, count), 0)];
    return Object.freeze({ kind: 'step', tokenUuid, sounds: Object.freeze(sounds) });
  }

  async #customStep(tokenUuid, path) {
    const now = this.now();
    const cadenceKey = `${tokenUuid}:custom`;
    if (this.stepTimes.has(cadenceKey) && now - this.stepTimes.get(cadenceKey) < 700) return null;
    this.stepTimes.set(cadenceKey, now);
    let files = this.customCache.get(path);
    if (!files) {
      files = await this.files.listAudio(path);
      if (!files.length) return null;
      this.customCache.set(path, files);
    }
    let candidates = files;
    if (files.length > 1 && this.customLastFile) candidates = files.filter(file => file !== this.customLastFile);
    const file = candidates[Math.floor(this.random() * candidates.length)];
    this.customLastFile = file;
    return Object.freeze({
      kind: 'step',
      tokenUuid,
      sounds: Object.freeze([Object.freeze({ file, volume: 0.5 })])
    });
  }

  #pickIndex(set, count) {
    if (count <= 1) return 0;
    const state = this.setState.get(set) ?? { step: 0, last: -1 };
    let index;
    if (set.sequential) {
      index = state.step % count;
      if (index === state.last) index = (index + 1) % count;
      state.step = index + 1;
    } else if (state.last < 0) index = Math.floor(this.random() * count);
    else {
      index = Math.floor(this.random() * (count - 1));
      if (index >= state.last) index += 1;
    }
    state.last = index;
    this.setState.set(set, state);
    return index;
  }

  #voiceAllowed(actorId, context) {
    const mode = context.mode ?? 'normal';
    if (mode === 'disabled') return false;
    const now = this.now();
    const state = this.voiceState.get(actorId) ?? {};
    let allowed;
    if (mode === 'oncePerPhase' && context.phaseKey != null) {
      allowed = state.phaseKey !== context.phaseKey;
      if (allowed) state.phaseKey = context.phaseKey;
    } else {
      const interval = mode === 'normal' ? 6000 : 30000;
      allowed = state.lastMs === undefined || now - state.lastMs >= interval;
      if (allowed) state.lastMs = now;
    }
    if (allowed) this.voiceState.set(actorId, state);
    return allowed;
  }
}

/* -------------------------------------------- */
/*  Audio helpers                               */
/* -------------------------------------------- */
function stepSet(soundId, volume, options = {}) {
  return Object.freeze({ soundId, volume, ...options });
}

function resolvedSound(set, index, delay) {
  return Object.freeze({
    soundId: set.soundId,
    index,
    volume: set.volume,
    ...(delay ? { delay } : {}),
    ...(set.fadeIn ? { fadeIn: set.fadeIn } : {}),
    ...(set.fadeOut ? { fadeOut: set.fadeOut } : {})
  });
}

/* -------------------------------------------- */
/*  Object interaction feedback                 */
/* -------------------------------------------- */
const OBJECT_EVENT_SOUNDS = Object.freeze({
  [OBJECT_PRESENTATION_EVENTS.LOCKPICK_FAILED]: SOUND_IDS.UI_FAILURE
});
const LOCK_CUES = Object.freeze({
  Chest: Object.freeze({ open: SOUND_IDS.OBJECT_CHEST_OPEN, close: SOUND_IDS.OBJECT_CHEST_CLOSE }),
  Door: Object.freeze({ open: SOUND_IDS.OBJECT_DOOR_OPEN, close: SOUND_IDS.OBJECT_DOOR_CLOSE })
});

/** Play the sound (and smoke) for a chest, door or destructible object event on this client. */
export class ObjectInteractionPresentation {
  constructor({ audio, tokens = null, smoke = null }) {
    this.audio = audio;
    this.tokens = tokens;
    this.smoke = smoke;
  }

  async show(message) {
    if (pageHidden()) return false;
    if (message?.event === OBJECT_PRESENTATION_EVENTS.DESTROYED) return this.#showDestruction(message);
    const soundId = OBJECT_EVENT_SOUNDS[message?.event];
    if (!soundId) return false;
    return this.audio.play(soundId);
  }

  /**
   * Play a chest or door lock cue on the client that made the change. Opening is broadcast to everyone; closing
   * plays only for whoever closed it.
   */
  async playLockCue({ objectType, opened } = {}) {
    const cue = LOCK_CUES[String(objectType ?? '')];
    if (!cue) return false;
    const soundId = opened === true ? cue.open : cue.close;
    return this.audio.play(soundId, { channel: AUDIO_CHANNELS.ENVIRONMENT, broadcast: opened === true });
  }

  /** Play the destruction sounds and smoke that hide the swap to the broken art. */
  async #showDestruction(message) {
    const token = await this.tokens?.placeable?.(String(message.tokenUuid ?? '')) ?? null;
    const outcomes = await Promise.allSettled([
      this.audio.play(SOUND_IDS.OBJECT_DESTRUCTION_3, { channel: AUDIO_CHANNELS.ENVIRONMENT }),
      this.audio.play(SOUND_IDS.OBJECT_DESTRUCTION_2, { channel: AUDIO_CHANNELS.ENVIRONMENT }),
      this.audio.play(SOUND_IDS.OBJECT_DESTRUCTION_1, { channel: AUDIO_CHANNELS.ENVIRONMENT }),
      token && typeof this.smoke === 'function' ? this.smoke(token) : Promise.resolve(false)
    ]);
    return outcomes.some(outcome => outcome.status === 'fulfilled' && outcome.value === true);
  }
}
