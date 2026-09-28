/** @layer presentation/canvas */
import { AUDIO_CHANNELS } from '../../contracts/domains/tokens.mjs';
import { SOUND_IDS } from '../audio/sound-database.mjs';
import { addFloat, clearFloats, floatTextStyle, showFloatingText } from '../graphics/floating-text.mjs';
import { SYSTEM_ID , recordDiagnostic } from '../../contracts/protocol.mjs';
import {
  DEFEAT_PRESENTATION_KIND,
  DEFEAT_PRESENTATION_TIMING,
  DEFEAT_PRESENTATION_TYPES,
  HEALTH_CHANGE_TYPES,
  HEALTH_PRESENTATION_KIND,
  STANCE_BREAK_PRESENTATION_KIND,
  DAMAGE_TYPES
} from '../../contracts/domains/damage.mjs';
import {
  animateTokenDefeatFade,
  animateTokenShake,
  applyNearestTexture,
  clearTokenDefeatFade
} from '../token/rendering.mjs';
import { voiceLinesMuted } from '../audio/service.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Stance-break presentation                   */
/* -------------------------------------------- */
const FLOAT_DURATION_MS = 1000;

/** Render committed stance-break messages with impact, floating text and sound. */
export class StanceBreakPresentation {
  constructor({ diagnostics = null, audio, impact, tokens }) {
    this.diagnostics = diagnostics;
    this.audio = audio;
    this.impact = impact;
    this.tokens = tokens;
  }

  /** Present one validated stance-break message on the receiving client's current canvas. */
  async show(message) {
    if (message?.kind !== STANCE_BREAK_PRESENTATION_KIND || pageHidden()) return false;
    const token = await this.tokens.placeable(message.tokenUuid);
    if (!token) return false;
    showFloatingText(token, 'Break!!', {
      color: '#ff8c1a',
      fontScale: 0.25,
      offsetY: 40,
      floatDistance: 0,
      durationMs: FLOAT_DURATION_MS,
      group: 'stance-break'
    });
    const results = await Promise.allSettled([
      this.impact(token),
      this.audio.play(SOUND_IDS.COMBAT_STANCE_BREAK, { channel: 'environment' })
    ]);
    return results.some(result => result.status === 'fulfilled' && result.value !== false);
  }

  /** Release active floating labels before a canvas replacement. */
  dispose() {
    clearFloats('stance-break');
  }
}

/* -------------------------------------------- */
/*  Damage display values                       */
/* -------------------------------------------- */
const DAMAGE_COLORS = Object.freeze({
  '': '#ff0000ff',
  missile: '#BFDDD1', slashing: '#BFDDD1', piercing: '#BFDDD1', crushing: '#BFDDD1',
  fire: '#d46a00ff', ice: '#68cdffff', lightning: '#1540ffff', wind: '#d1ff81ff',
  arcane: '#ff92ffff', decay: '#17791cff', shadow: '#7100c2ff', holy: '#ffee00ff'
});
const UNLISTED_COLOR = '#FFFFFF';
const DAMAGE_TYPE_ICONS = new Set(DAMAGE_TYPES);
const DEFEAT_VOICE_PAUSE_MS = 500;
const ABSORB_COLOR = '#2ff5ddff';
const LAST_STAND_COLOR = 'rgb(255, 190, 77)';
const HEAVY_HIT_RATIO = 0.33;
const SEVERE_HIT_RATIO = 0.5;
const SHAKE_AMPLITUDE = 0.11;
const DEFEAT_SHAKE_AMPLITUDE = 0.16;
const DEFEAT_SHAKE_DURATION = 520;
const SHAKE_DURATION = 420;

/* -------------------------------------------- */
/*  Health presentation                         */
/* -------------------------------------------- */
/** Render committed damage and healing without reading or changing Actor mechanics. */
export class HealthPresentation {
  constructor({ diagnostics = null,
    tokens,
    impacts,
    audio,
    cameraShake,
    extraLifeEffect,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  }) {
    this.diagnostics = diagnostics;
    this.tokens = tokens;
    this.impacts = impacts;
    this.audio = audio;
    this.cameraShake = cameraShake;
    this.extraLifeEffect = extraLifeEffect;
    this.wait = wait;
  }

  /** Present one validated health or defeat message on the receiving client's current canvas. */
  async show(message) {
    if (message?.kind !== HEALTH_PRESENTATION_KIND && message?.kind !== DEFEAT_PRESENTATION_KIND) return false;
    if (pageHidden()) return this.#applyHidden(message);
    const token = await this.tokens.placeable(message.tokenUuid);
    if (!token) return false;
    if (message.kind === DEFEAT_PRESENTATION_KIND) {
      if (message.change === DEFEAT_PRESENTATION_TYPES.EXTRA_LIFE) return this.#showExtraLife(token, message);
      if (message.change === DEFEAT_PRESENTATION_TYPES.CLEAR_FADE) return clearTokenDefeatFade(token);
      return this.#showDefeat(token, message);
    }
    if (message.change === HEALTH_CHANGE_TYPES.HEAL) return this.#showHealing(token, message);
    return this.#showDamage(token, message);
  }

  /**
   * On a hidden page, apply only the clear-fade beat. Every other beat is transient and is dropped, not queued.
   * `deliversWhileHidden` in `presentation/interface/delivery.mjs` lets the clear through because it releases state:
   * a fade left on the mesh would resume on this client's ticker when the page returns and leave the unit invisible.
   */
  async #applyHidden(message) {
    if (message.kind !== DEFEAT_PRESENTATION_KIND || message.change !== DEFEAT_PRESENTATION_TYPES.CLEAR_FADE) {
      return false;
    }
    const token = await this.tokens.placeable(message.tokenUuid);
    return token ? clearTokenDefeatFade(token) : false;
  }

  async #showHealing(token, message) {
    const gridSize = Number(canvas.grid?.size) || 100;
    if (message.displayStanceAmount > 0) {
      showText(token, `+${message.displayStanceAmount}`, '#ff8c1a', Math.floor(gridSize * 0.2), 0, 1500, 40);
    }
    if (message.displayAmount > 0) {
      showText(token, `+${message.displayAmount}`, '#0dff00ff', Math.floor(gridSize * 0.4), 45, 1500, -40);
    }
    return message.displayAmount > 0 || message.displayStanceAmount > 0;
  }

  async #showDamage(token, message) {
    const gridSize = Number(canvas.grid?.size) || 100;
    let fontSize = Math.floor(gridSize * 0.4);
    if (message.critical) fontSize *= 1.3;

    if (message.amount > 0) {
      showDamageNumber(token, message, fontSize);
      void this.impacts.apply(message);
    } else if (message.absorbed > 0) {
      showText(token, `${message.absorbed} Absorbed`, ABSORB_COLOR, fontSize, 45, 1500, -40);
      void this.impacts.apply(message);
    } else if (softHit(message)) {
      void this.impacts.apply(message);
    } else {
      showText(token, 'No Damage', '#daeaffff', fontSize, 45, 1500, -40);
    }
    if (message.critical && message.amount > 0) {
      showText(token, 'Critical Hit!', '#e50000ff', fontSize, 0, 1500, 0);
    }
    if (message.displayStanceAmount > 0) {
      showText(token, String(message.displayStanceAmount), '#ff8c1a', Math.floor(gridSize * 0.2), 0, 1500, 40);
    }
    if (message.lastStandTriggered) {
      showText(token, 'Last Stand!', LAST_STAND_COLOR, Math.floor(gridSize * 0.42), 20, 1600, -25);
    }

    if (message.lastHit && message.defeatVoice) void this.#playDefeatVoice(message.defeatVoice);
    await Promise.allSettled([
      this.#playDamageSound(message),
      this.#shakeCamera(message),
      shakeToken(token, message)
    ]);
    return true;
  }

  /**
   * The defeated unit's voice line, with half a second of silence before and after and the music ducked under it.
   * The caller doesn't wait for it, so it never holds up the killing blow.
   */
  async #playDefeatVoice(file) {
    if (voiceLinesMuted()) return false;
    try {
      await this.wait(DEFEAT_VOICE_PAUSE_MS);
      await this.audio.playFile(file, { volume: 1, duck: true, channel: AUDIO_CHANNELS.VOICE_OVER });
      await this.wait(DEFEAT_VOICE_PAUSE_MS);
    } catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'playDefeatVoice' });
      return false;
    }
    return true;
  }

  async #showExtraLife(token) {
    const outcomes = await Promise.allSettled([
      this.audio.play(SOUND_IDS.MISC_HEARTBEAT, { channel: 'environment' }),
      this.extraLifeEffect ? this.extraLifeEffect(token) : Promise.resolve(false)
    ]);
    return outcomes.some(outcome => outcome.status === 'fulfilled' && outcome.value !== false);
  }

  /** The fade is this client's own mesh effect, so the beat is paced by the clock and never waits on the animation. */
  async #showDefeat(token) {
    await this.wait(DEFEAT_PRESENTATION_TIMING.fadeLeadIn);
    void animateTokenDefeatFade(token);
    await Promise.allSettled([
      this.audio.play(SOUND_IDS.COMBAT_UNIT_FADE, { channel: 'environment', volume: 0.5 }),
      this.wait(DEFEAT_PRESENTATION_TIMING.fadeDuration + DEFEAT_PRESENTATION_TIMING.fadeSettle)
    ]);
    return true;
  }

  async #playDamageSound(message) {
    if (message.amount > 0) {
      const sounds = damageSounds(message.damageType, message.lastHit);
      await Promise.all(sounds.map(sound => this.audio.play(sound.id, {
        channel: 'environment',
        volume: sound.volume,
        fadeIn: sound.fadeIn,
        fadeOut: sound.fadeOut,
        timeRange: sound.timeRange
      })));
      if (message.critical) await this.audio.play(SOUND_IDS.COMBAT_HIT_CRITICAL, { channel: 'environment' });
      return true;
    }
    if (message.absorbed > 0) {
      return this.audio.play(SOUND_IDS.COMBAT_HIT_ABSORB, { channel: 'environment' });
    }
    if (softHit(message)) return this.audio.play(SOUND_IDS.COMBAT_HIT_SOFT, { channel: 'environment' });
    return this.audio.play(SOUND_IDS.COMBAT_NO_DAMAGE, { channel: 'environment', volume: 0.5 });
  }

  async #shakeCamera(message) {
    if (message.lastHit) await this.cameraShake(12);
    else if (message.amount > 0 && message.critical) await this.cameraShake(10);
    if (message.amount > 0) await this.cameraShake(6);
  }
}

/* -------------------------------------------- */
/*  Floating combat text                        */
/* -------------------------------------------- */
function showDamageNumber(token, message, fontSize) {
  const group = new PIXI.Container();
  group.position.set(token.center.x, token.center.y - 40);
  group.zIndex = 999999;
  group.scale.set(0);
  const damageType = String(message.damageType ?? '').toLowerCase();
  const text = new PIXI.Text(`-${message.displayAmount}`,
    floatTextStyle(fontSize, DAMAGE_COLORS[damageType] ?? UNLISTED_COLOR));
  if (!DAMAGE_TYPE_ICONS.has(damageType)) {
    text.anchor.set(0.5);
    text.position.set(0, 0);
    group.addChild(text);
  } else {
    const icon = PIXI.Sprite.from(`systems/${SYSTEM_ID}/assets/ui/dmg-types/${damageType}.png`);
    if (icon.texture) applyNearestTexture(icon.texture);
    const iconSize = fontSize * 0.7;
    icon.width = icon.height = iconSize;
    icon.anchor.set(1, 0.5);
    icon.position.set(-6, 0);
    text.anchor.set(0, 0.5);
    text.position.set(0, 0);
    group.addChild(icon, text);
  }
  addFloat(group, { floatDistance: 45, durationMs: 1500, maxScale: 1.2, group: 'health' });
}

function softHit(message) {
  return message.allowSoftHit === true && message.stanceAmount > 0;
}

function showText(token, text, color, fontSize, floatDistance, duration, centerYOffset) {
  showFloatingText(token, text, {
    color, fontSize, offsetY: centerYOffset, floatDistance, durationMs: duration, group: 'health'
  });
}

/* -------------------------------------------- */
/*  Impact sound and motion                     */
/* -------------------------------------------- */
function damageSounds(damageType, lastHit) {
  const elemental = {
    fire: [{ id: SOUND_IDS.COMBAT_HIT_FIRE }],
    ice: [{ id: SOUND_IDS.COMBAT_HIT_ICE }],
    lightning: [{
      id: SOUND_IDS.COMBAT_HIT_LIGHTNING, timeRange: [300, 1000], fadeIn: 100, fadeOut: 300
    }],
    wind: [{ id: SOUND_IDS.COMBAT_HIT_WIND }],
    arcane: [
      { id: SOUND_IDS.COMBAT_HIT_ARCANE_1 },
      { id: SOUND_IDS.COMBAT_HIT_ARCANE_2, fadeOut: 100 }
    ],
    decay: [{ id: SOUND_IDS.COMBAT_HIT_DECAY }],
    shadow: [{ id: SOUND_IDS.COMBAT_HIT_SHADOW }],
    holy: [{ id: SOUND_IDS.COMBAT_HIT_HOLY_2 }, { id: SOUND_IDS.COMBAT_HIT_HOLY_1 }]
  }[damageType];
  if (elemental) return lastHit ? [...elemental, { id: SOUND_IDS.COMBAT_HIT_FINAL }] : elemental;
  return lastHit
    ? [{ id: SOUND_IDS.COMBAT_HIT_FINAL }]
    : [{ id: SOUND_IDS.COMBAT_HIT_GENERIC, volume: 0.5 }];
}

function shakeToken(token, message) {
  if (message.lastHit) return animateTokenShake(token, DEFEAT_SHAKE_AMPLITUDE, DEFEAT_SHAKE_DURATION);
  const amplitude = shakeAmplitude(message);
  return amplitude > 0 ? animateTokenShake(token, amplitude, SHAKE_DURATION) : Promise.resolve(false);
}

function shakeAmplitude(message) {
  const ratio = message.hpMax > 0 ? message.amount / message.hpMax : 0;
  const amplitude = ratio > HEAVY_HIT_RATIO ? SHAKE_AMPLITUDE * (ratio > SEVERE_HIT_RATIO ? 1.3 : 1) : 0;
  return message.lastStandTriggered ? Math.max(amplitude, SHAKE_AMPLITUDE) : amplitude;
}

/**
 * How long a committed hit holds the table: the struck unit's own shake, the part of the beat with a fixed length.
 * The host waits this out instead of the shake, which a hidden page never finishes drawing.
 * @param {object} message Health presentation message.
 * @returns {number} Milliseconds.
 */
export function healthBeatHoldMs(message) {
  if (message?.kind !== HEALTH_PRESENTATION_KIND || message.change === HEALTH_CHANGE_TYPES.HEAL) return 0;
  if (message.lastHit) return DEFEAT_SHAKE_DURATION;
  return shakeAmplitude(message) > 0 ? SHAKE_DURATION : 0;
}
