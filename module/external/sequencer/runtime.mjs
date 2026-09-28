/** @layer external/sequencer */
import { parseTerrainKey } from '../../game/terrain/rules.mjs';
import { finite as finiteNumber } from '../../lib/core/runtime.mjs';
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Sequencer access                            */
/* -------------------------------------------- */

/**
 * Small wrappers over Sequencer's globals, for animation-dispatch.mjs, the terrain document writer
 * (foundry/adapters/document-writes/terrain.mjs) and this file's terrain effects. Sequencer is a required module,
 * but a database key may be missing or not loaded yet, so lookups return null or false instead of throwing.
 */
export const SequencerRuntime = {
  get SequenceClass() { return globalThis.Sequence; },

  get available() {
    return typeof Sequencer !== 'undefined' && !!globalThis.Sequencer;
  },

  /** A new Sequence for the caller to build and play. */
  sequence() {
    return new Sequence();
  },

  /** End the Sequencer effects that match a filter such as `{ name }`. */
  endEffects(filter) {
    if (!globalThis.Sequencer?.EffectManager?.endEffects) return;
    return Sequencer.EffectManager.endEffects(filter);
  },

  /**
   * Whether a Sequencer database key such as `jb2a.flames.01` is registered yet. It stays false until the module
   * that provides the key has loaded its database, which on a fresh world can happen after `canvasReady`. File
   * paths aren't database keys, so callers check those separately.
   */
  databaseEntryExists(file) {
    const db = globalThis.Sequencer?.Database;
    return !!db?.entryExists && db.entryExists(file);
  },

  /**
   * Names of the Sequencer effects now on the canvas that start with a prefix. Sequencer removes effects on a scene
   * change, so reconcileTerrainEffects compares against this list rather than a cache of its own, which could fall
   * out of step with the screen.
   * @returns {Set<string>}
   */
  runningEffectNames(prefix = '') {
    const names = new Set();
    const list = globalThis.Sequencer?.EffectManager?.getEffects?.() || [];
    for (const e of list) {
      const n = e?.data?.name;
      if (n && n.startsWith(prefix)) names.add(n);
    }
    return names;
  },

  /** Whether any current effect has one of the supplied exact names. */
  hasRunningEffect(names) {
    if (!globalThis.Sequencer?.EffectManager?.getEffects) return false;
    return names.some(name => (Sequencer.EffectManager.getEffects({ name }) ?? []).length > 0);
  },

  /**
   * Turn a file path or Sequencer database key into a file path. A path (anything with a slash) comes back as is.
   * A key is looked up, and its entry (a string, a file object or an array of them) gives its first file. Returns
   * null when the key has no entry. Used for terrain sounds (document-writes/terrain.mjs) and, despite the name,
   * for the destruction smoke's effect file.
   */
  resolveSoundPath(ref) {
    if (!ref || typeof ref !== 'string') return null;
    if (ref.includes('/')) return ref;
    const db = globalThis.Sequencer?.Database;
    if (!db?.getEntry) return null;
    try {
      const entry = db.getEntry(ref, { softFail: true });
      if (!entry) return null;
      if (typeof entry === 'string') return entry;
      if (typeof entry.getFile === 'function') return entry.getFile();
      if (typeof entry.file === 'string') return entry.file;
      if (Array.isArray(entry)) {
        const first = entry[0];
        if (typeof first === 'string') return first;
        return first?.getFile?.() ?? first?.file ?? null;
      }
      return null;
    } catch (_) {
      reportFoundryError(import.meta.url, _, 'SequencerRuntime');
      return null;
    }
  },

  /**
   * Load files into Sequencer's cache before they play, so effects that start together don't each fetch the same
   * file. Nothing is remembered between calls. A failed preload is recorded, and playback then loads the file itself.
   */
  async preload(files) {
    const P = globalThis.Sequencer?.Preloader;
    if (!P?.preload || !files?.length) return;
    try { await P.preload(files); } catch (_) {
      reportFoundryError(import.meta.url, _, 'SequencerRuntime');
    }
  }
};

/**
 * Whether this client has an audio channel a sound can be routed to yet. Foundry opens its channels only after the
 * page's first click, and Sequencer throws, with an error notification, when told to use one that isn't open.
 * Until then callers leave the channel off, so the sound plays on Sequencer's default channel.
 * @param {string} channel Channel name such as `interface` or `voiceover`.
 * @returns {boolean}
 */
export function audioChannelReady(channel) {
  const AudioContextClass = globalThis.AudioContext;
  return typeof AudioContextClass === 'function' && game.audio[channel] instanceof AudioContextClass;
}

/** Whether transient sounds can play on this client now: its page is visible and its audio has been unlocked. */
export function transientSoundsAudible() {
  return !pageHidden() && game.audio.locked !== true;
}

/* -------------------------------------------- */
/*  Stance-break impact                         */
/* -------------------------------------------- */
/**
 * Play the four-layer JB2A stance-break impact and a camera shake at the token, on this client only.
 * StanceBreakPresentation calls it through its `impact` port (wired in init/system.mjs).
 */
export async function playStanceBreakImpact(token) {
  if (!token || typeof globalThis.Sequence !== 'function') return false;
  try {
    const sequence = new Sequence();
    sequence
      .effect()
      .file('jb2a.impact.006.yellow')
      .atLocation(token)
      .randomizeMirrorX()
      .locally()
      .scale(0.5)
      .effect()
      .file('jb2a.impact.orange.1')
      .atLocation(token)
      .randomizeMirrorX()
      .locally()
      .scale(0.5)
      .effect()
      .file('jb2a.impact.orange.6')
      .atLocation(token)
      .belowTokens(true)
      .randomizeMirrorX()
      .locally()
      .scale(0.25)
      .effect()
      .file('jb2a.impact.orange.4')
      .atLocation(token)
      .randomizeMirrorX()
      .delay(200)
      .locally()
      .scale(0.5)
      .canvasPan()
      .locally()
      .shake({ strength: 8, fadeOutDuration: 100, duration: 300 });
    await sequence.play();
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playStanceBreakImpact');
    return false;
  }
}

/* -------------------------------------------- */
/*  Damage camera impact                        */
/* -------------------------------------------- */
/** Shake this client's camera. HealthPresentation calls it on a hit and picks the strength. */
export async function playDamageCameraShake(strength) {
  if (typeof globalThis.Sequence !== 'function') return false;
  try {
    await new Sequence().canvasPan().locally().shake({
      strength,
      fadeInDuration: 50,
      fadeOutDuration: 50,
      duration: 300
    }).play();
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playDamageCameraShake');
    return false;
  }
}

/* -------------------------------------------- */
/*  Extra Life                                  */
/* -------------------------------------------- */
/** Play the Extra Life heart pulse at the token on this client. HealthPresentation calls it. */
export async function playExtraLifePulse(token) {
  if (!token || typeof globalThis.Sequence !== 'function') return false;
  try {
    await new Sequence()
      .effect()
      .atLocation(token)
      .scaleToObject(1.25)
      .aboveInterface()
      .file('blfx.steampunk.heart1.pulse.shell.yellow')
      .endTime(1200)
      .playbackRate(0.9)
      .filter('ColorMatrix', { hue: 325 })
      .locally()
      .play();
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playExtraLifePulse');
    return false;
  }
}

/* -------------------------------------------- */
/*  Exchange motion                             */
/* -------------------------------------------- */

/** Play the critical-hit wind-up flash at a token on this client. CombatPresentation calls it. */
export async function playCombatCriticalFlash(token) {
  if (!token || typeof globalThis.Sequence !== 'function') return false;
  try {
    await new Sequence()
      .effect()
      .file('animated-spell-effects-cartoon.level 01.bless.blue')
      .atLocation(token)
      .scaleToObject(1.5)
      .playbackRate(1)
      .fadeIn(150)
      .fadeOut(150)
      .locally()
      .waitUntilFinished()
      .play();
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playCombatCriticalFlash');
    return false;
  }
}

/** Play the Weapon Art flash, and the art's icon when given, at a token on this client (for CombatPresentation). */
export async function playWeaponArtFlourish(token, artImage) {
  if (!token || typeof globalThis.Sequence !== 'function') return false;
  try {
    const sequence = new Sequence()
      .effect()
      .atLocation(token)
      .file('animated-spell-effects-cartoon.flash.03')
      .scaleToObject(1.2)
      .filter('ColorMatrix', { brightness: 3 })
      .tint('#7794ff')
      .locally();
    if (artImage) {
      sequence.effect()
        .file(artImage)
        .atLocation(token)
        .scaleToObject(0.5)
        .fadeIn(100)
        .fadeOut(400)
        .duration(900)
        .zIndex(2)
        .locally();
    }
    await sequence.play();
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playWeaponArtFlourish');
    return false;
  }
}

/**
 * Play the promotion flourish over a token on this client. A hidden page skips it. PromotionPresentation starts it
 * without waiting, and the progression engine swaps the class on its own timer (PROMOTION_FLOURISH_TIMING).
 * @param {Token} token Token being promoted.
 * @param {{sounds: object}} options Resolved sound files.
 * @returns {Promise<boolean>} Whether the chain played.
 */
export async function playPromotionFlourish(token, { sounds = {} } = {}) {
  if (!token || typeof globalThis.Sequence !== 'function' || pageHidden()) return false;
  await new Promise(resolve => setTimeout(resolve, 300));
  try {
    const sequence = new Sequence();
    if (sounds.lightCharge) interfaceSound(sequence, sounds.lightCharge).delay(500);
    sequence.effect().locally().file('jb2a.magic_signs.circle.02.transmutation.intro.blue')
      .playbackRate(0.9).atLocation(token).scaleToObject(1.5).playbackRate(0.95)
      .belowTokens().waitUntilFinished(-2500);
    if (sounds.electricCackle) interfaceSound(sequence, sounds.electricCackle);
    sequence.effect().locally().atLocation(token).scaleToObject(2).aboveInterface()
      .file('animated-spell-effects-cartoon.mix.electric ball.03')
      .filter('ColorMatrix', { hue: 345, brightness: 1.5 }).waitUntilFinished(-200);
    if (sounds.electricCackle) interfaceSound(sequence, sounds.electricCackle);
    sequence.effect().locally().atLocation(token).scaleToObject(1.6).aboveInterface()
      .file('animated-spell-effects-cartoon.electricity.10')
      .effect().locally().atLocation(token).scaleToObject(1.2).aboveInterface()
      .file('animated-spell-effects-cartoon.mix.electric ball.03')
      .filter('ColorMatrix', { hue: 345, brightness: 1.5 }).waitUntilFinished();
    if (sounds.magicLoop) interfaceSound(sequence, sounds.magicLoop);
    sequence.effect().locally().atLocation(token).scaleToObject(2).aboveInterface()
      .file('animated-spell-effects-cartoon.energy.10')
      .waitUntilFinished(-800)
      .effect().locally().atLocation(token).scaleToObject(2.5).aboveInterface()
      .file('animated-spell-effects-cartoon.cantrips.sacred_flame.blue')
      .filter('ColorMatrix', { hue: 150, brightness: 1.2 }).waitUntilFinished(-600);
    if (sounds.magicLoop) {
      interfaceSound(sequence, sounds.magicLoop).startTime(800).endTime(1000).fadeInAudio(500).fadeOutAudio(800);
    }
    sequence.effect().locally().atLocation(token).scaleToObject(2.5).aboveInterface().startTime(500)
      .file('animated-spell-effects-cartoon.cantrips.sacred_flame.blue')
      .filter('ColorMatrix', { hue: 150, brightness: 1.2 }).waitUntilFinished(-600)
      .effect().locally().atLocation(token).scaleToObject(2.5).aboveInterface().startTime(1500)
      .file('animated-spell-effects-cartoon.cantrips.sacred_flame.blue')
      .filter('ColorMatrix', { hue: 150, brightness: 1.2 }).waitUntilFinished(-600);
    if (sounds.puffOfSmoke) {
      interfaceSound(sequence, sounds.puffOfSmoke).startTime(700).fadeInAudio(100);
    }
    sequence.effect().locally().atLocation(token).scaleToObject(2.5).aboveInterface()
      .file('animated-spell-effects-cartoon.air.explosion.gray')
      .playbackRate(0.7).waitUntilFinished();
    if (sounds.fanfare) interfaceSound(sequence, sounds.fanfare).fadeInAudio(100).fadeOutAudio(100);
    sequence.effect().locally().atLocation(token).scaleToObject(1.2).aboveInterface()
      .file('jb2a.glint.yellow.many.0')
      .playbackRate(1).duration(4000).fadeOut(500).waitUntilFinished();
    await sequence.play();
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'playPromotionFlourish');
    return false;
  }
}

/**
 * A sound cue played on this client only, on the interface channel, or on Sequencer's default while this client's
 * channels are not open yet.
 */
function interfaceSound(sequence, file) {
  const sound = sequence.sound().locally();
  if (audioChannelReady('interface')) sound.audioChannel('interface');
  return sound.file(file);
}

/* -------------------------------------------- */
/*  Persistent terrain effects                  */
/* -------------------------------------------- */
const EFFECT_PREFIX = 'emblem-terrain-fx-';
const playedSignatures = new Map();
const pendingUntil = new Map();
const PENDING_MS = 3000;
let syncing = false;
let queuedRequest = null;
let lifecycleGeneration = 0;

/**
 * Bring the scene's looping terrain effects in line with the terrain grid: end the ones no longer authored and
 * play new or changed ones. init/hooks.mjs calls it when the terrain changes and again after the canvas loads. A
 * call made during a sync replaces any request still waiting, so the next pass uses the newest grid.
 * `trustPending: false` replays an effect started in the last 3 seconds if Sequencer doesn't list it yet.
 */
export async function syncTerrainEffects(grid, gridSize, { trustPending = true } = {}) {
  if (!SequencerRuntime.available) return;
  queuedRequest = { grid: grid ?? {}, gridSize: Number(gridSize) || 0, trustPending };
  if (syncing) return;
  syncing = true;
  try {
    while (queuedRequest) {
      const request = queuedRequest;
      queuedRequest = null;
      await reconcileTerrainEffects(request, lifecycleGeneration);
    }
  } finally {
    syncing = false;
  }
}

/**
 * End the terrain effects and forget their state when the canvas is torn down (canvasTearDown in init/hooks.mjs).
 * A sync still running at that moment plays nothing onto the next canvas.
 */
export function disposeTerrainEffects() {
  lifecycleGeneration += 1;
  queuedRequest = null;
  for (const name of SequencerRuntime.runningEffectNames(EFFECT_PREFIX)) SequencerRuntime.endEffects({ name });
  playedSignatures.clear();
  pendingUntil.clear();
}

async function reconcileTerrainEffects(request, generation) {
  const { grid, gridSize, trustPending } = request;
  const running = SequencerRuntime.runningEffectNames(EFFECT_PREFIX);
  const desired = desiredTerrainEffects(grid);
  for (const name of running) {
    if (desired.has(name)) continue;
    SequencerRuntime.endEffects({ name });
    playedSignatures.delete(name);
    pendingUntil.delete(name);
  }

  const toPlay = [];
  for (const [name, effect] of desired) {
    const signature = terrainEffectSignature(effect);
    const pending = trustPending && (pendingUntil.get(name) ?? 0) > Date.now();
    if (playedSignatures.get(name) === signature && (running.has(name) || pending)) continue;
    if (!effect.file.includes('/') && !SequencerRuntime.databaseEntryExists(effect.file)) continue;
    toPlay.push([name, effect, signature]);
  }
  if (!toPlay.length) return;
  await SequencerRuntime.preload([...new Set(toPlay.map(([, effect]) => effect.file))]);
  if (generation !== lifecycleGeneration) return;
  for (const [name, effect, signature] of toPlay) {
    playTerrainEffect(name, effect, gridSize);
    playedSignatures.set(name, signature);
    pendingUntil.set(name, Date.now() + PENDING_MS);
  }
}

function desiredTerrainEffects(grid) {
  const desired = new Map();
  for (const [key, entry] of Object.entries(grid ?? {})) {
    if (typeof entry?.effect !== 'string' || !entry.effect) continue;
    const spanWidth = Number(entry.effectSpanW) > 0 ? Math.floor(Number(entry.effectSpanW)) : 0;
    const spanHeight = Number(entry.effectSpanH) > 0 ? Math.floor(Number(entry.effectSpanH)) : 0;
    const spanning = spanWidth > 0 && spanHeight > 0;
    desired.set(`${EFFECT_PREFIX}${key}`, {
      key,
      file: entry.effect,
      scale: positiveNumber(entry.effectScale, 1),
      opacity: Math.min(1, positiveNumber(entry.effectOpacity, 1)),
      rotation: finiteNumber(entry.effectRotation, 0),
      mirrorX: entry.effectMirrorX === true,
      mirrorY: entry.effectMirrorY === true,
      spanWidth: spanning ? spanWidth : 1,
      spanHeight: spanning ? spanHeight : 1
    });
  }
  return desired;
}

function playTerrainEffect(name, effect, gridSize) {
  const { x, y } = parseTerrainKey(effect.key);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !gridSize) return;
  SequencerRuntime.endEffects({ name });
  const chain = SequencerRuntime.sequence()
    .effect()
    .file(effect.file)
    .atLocation({
      x: (x + effect.spanWidth / 2) * gridSize,
      y: (y + effect.spanHeight / 2) * gridSize
    })
    .size({
      width: gridSize * effect.spanWidth * effect.scale,
      height: gridSize * effect.spanHeight * effect.scale
    })
    .opacity(effect.opacity)
    .belowTokens()
    .persist()
    .temporary()
    .locally()
    .name(name);
  if (effect.rotation) chain.rotate(effect.rotation);
  if (effect.mirrorX) chain.mirrorX(true);
  if (effect.mirrorY) chain.mirrorY(true);
  chain.play();
}

function terrainEffectSignature(effect) {
  return [
    effect.file,
    effect.scale,
    effect.opacity,
    effect.rotation,
    effect.mirrorX ? 1 : 0,
    effect.mirrorY ? 1 : 0,
    `${effect.spanWidth}x${effect.spanHeight}`
  ].join('|');
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}
