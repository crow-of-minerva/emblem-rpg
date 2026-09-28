/** @layer presentation/canvas */
import {
  COMBAT_PRESENTATION_BEATS,
  COMBAT_PRESENTATION_KIND,
  GUARD_BOND_REFUSALS
} from '../../contracts/domains/combat.mjs';
import {
  ITEM_ACTIVATION_PRESENTATION_BEATS,
  ITEM_ACTIVATION_PRESENTATION_KIND,
  ITEM_ACTIVATION_TIMING
} from '../../contracts/domains/items.mjs';
import { AUDIO_CHANNELS } from '../../contracts/domains/tokens.mjs';
import { HEALTH_PRESENTATION_KIND } from '../../contracts/domains/damage.mjs';
import { avatarScaleStyle, escapeHtml } from '../../lib/dom/html.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';
import { voiceLinesMuted } from '../audio/service.mjs';
import { COMBAT_SOUND_PATH, SOUND_IDS } from '../audio/sound-database.mjs';
import { CINEMATIC_CLOSE_MS } from '../camera/cinematic.mjs';
import { CRITICAL_BANNER_MS } from '../graphics/critical.mjs';
import { clearFloats, showFloatingText } from '../graphics/floating-text.mjs';
import { renderWeaponRankCard } from '../interface/chat-cards.mjs';
import { NOTIFICATION_IDS } from '../interface/notification-ids.mjs';
import { TOKEN_DODGE_MS } from '../token/rendering.mjs';
import { healthBeatHoldMs } from './unit-feedback.mjs';
import { recordDiagnostic } from '../../contracts/protocol.mjs';

/**
 * The exchange presenter's explicit beats, in milliseconds. The host paces the mechanics by these same numbers
 * rather than by its own rendering, so a beat lasts as long on a minimized host as on a watched one.
 */
const COMBAT_BEAT_TIMING = Object.freeze({
  attackLead: 100,
  criticalFlash: 708,
  criticalVoiceDelay: 350,
  weaponArtSound: 200
});

/** Cap presentation holds for effect animations without an authored duration. */
const EFFECT_ANIMATION_CEILING_MS = 8000;

/** Map Guard-bond verdicts from combat rules to player notifications. */
const GUARD_BOND_NOTIFICATIONS = Object.freeze({
  [GUARD_BOND_REFUSALS.SELF]: NOTIFICATION_IDS.GUARD_BOND_SELF,
  [GUARD_BOND_REFUSALS.GUARDER_BONDED]: NOTIFICATION_IDS.GUARD_BOND_HELD,
  [GUARD_BOND_REFUSALS.GUARDED_BONDED]: NOTIFICATION_IDS.GUARD_BOND_HELD,
  [GUARD_BOND_REFUSALS.OFF_MAP]: NOTIFICATION_IDS.GUARD_BOND_OFF_MAP,
  [GUARD_BOND_REFUSALS.GROUNDED]: NOTIFICATION_IDS.GUARD_BOND_GROUNDED,
  [GUARD_BOND_REFUSALS.SMALLER]: NOTIFICATION_IDS.GUARD_BOND_SMALLER
});

/* -------------------------------------------- */
/*  Combat exchange presentation                */
/* -------------------------------------------- */

/**
 * Show attacks, their outcomes, chat cards and effect steps on each client. The presentation gateway's message
 * handler in init/system.mjs sends combat, item activation and effect operation messages here.
 */
export class CombatPresentation {
  constructor({ diagnostics = null,
    tokens,
    tokenArt,
    health,
    audio,
    chat,
    animation,
    dodge,
    criticalFlash,
    weaponArtFlourish,
    critical,
    cinematic,
    pathfindingIndicator = () => {},
    notify = () => {},
    notices = Object.freeze({ show: () => {} }),
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancelScheduled = handle => clearTimeout(handle)
  }) {
    this.diagnostics = diagnostics;
    this.tokens = tokens;
    this.tokenArt = tokenArt;
    this.health = health;
    this.audio = audio;
    this.chat = chat;
    this.animation = animation;
    this.dodge = dodge;
    this.criticalFlash = criticalFlash;
    this.weaponArtFlourish = weaponArtFlourish;
    this.critical = critical;
    this.cinematic = cinematic;
    this.pathfindingIndicator = pathfindingIndicator;
    this.notify = notify;
    this.notices = notices;
    this.wait = wait;
    this.schedule = schedule;
    this.cancelScheduled = cancelScheduled;
    this.evadeSwaps = new Map();
  }

  async show(message) {
    if (message?.kind === COMBAT_PRESENTATION_KIND || message?.kind === ITEM_ACTIVATION_PRESENTATION_KIND) {
      this.cinematic?.touch?.();
    }
    if (message?.kind === 'effect-operation') return this.#showEffectOperation(message);
    if (message?.kind === ITEM_ACTIVATION_PRESENTATION_KIND) return this.#showActivation(message);
    if (message?.kind !== COMBAT_PRESENTATION_KIND) return false;
    if (message.beat === COMBAT_PRESENTATION_BEATS.START) return this.#showStart(message);
    if (message.beat === COMBAT_PRESENTATION_BEATS.WEAPON_ART) return this.#showWeaponArt(message);
    if (message.beat === COMBAT_PRESENTATION_BEATS.ATTACK) return this.#showAttack(message);
    if (message.beat === COMBAT_PRESENTATION_BEATS.IMPACT) return this.#showImpact(message);
    if (message.beat === COMBAT_PRESENTATION_BEATS.NOTICE) return this.#showNotice(message);
    if (message.beat === COMBAT_PRESENTATION_BEATS.RANK_UP) return this.#showRankUp(message);
    if (message.beat === COMBAT_PRESENTATION_BEATS.END) return this.#showEnd(message);
    return true;
  }

  /** Release timers, PIXI labels and any open cinematic owned by combat presentation, for a canvas teardown. */
  dispose() {
    for (const record of this.evadeSwaps.values()) this.cancelScheduled(record.timer);
    this.evadeSwaps.clear();
    clearFloats('combat');
    this.cinematic?.dispose?.();
  }

  async #showStart(message) {
    await this.#holdPathfindingIndicator(message.sourceTokenUuid, true);
    await this.#faceExchange(message.sourceTokenUuid, message.targetTokenUuid);
    return this.cinematic?.start?.(message) ?? true;
  }

  async #holdPathfindingIndicator(tokenUuid, exchanging) {
    const token = await this.tokens.placeable(tokenUuid);
    if (token) this.pathfindingIndicator(token, exchanging);
  }

  #faceExchange(sourceTokenUuid, targetTokenUuid) {
    return Promise.resolve(this.tokenArt.faceTargets?.(sourceTokenUuid, targetTokenUuid) ?? false)
      .catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'faceExchange' }); return false; });
  }

  async #showEnd(message) {
    let cinematicComplete = true;
    try {
      cinematicComplete = await (this.cinematic?.end?.(message) ?? true);
    } catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'showEnd' });
      cinematicComplete = false;
    }
    await this.#holdPathfindingIndicator(message.sourceTokenUuid, false);
    const actorUuids = [...new Set([
      String(message.sourceActorUuid ?? ''),
      String(message.targetActorUuid ?? '')
    ].filter(Boolean))];
    for (const actorUuid of actorUuids) {
      const evade = this.evadeSwaps.get(actorUuid);
      if (evade) this.cancelScheduled(evade.timer);
      this.evadeSwaps.delete(actorUuid);
    }
    const repairs = await Promise.allSettled(actorUuids.map(actorUuid => (
      this.tokenArt.ensureBaseline?.(actorUuid) ?? Promise.resolve(false)
    )));
    return cinematicComplete !== false && repairs.every(result => result.status === 'fulfilled');
  }

  async #showWeaponArt(message) {
    if (pageHidden()) return false;
    const token = await this.tokens.placeable(message.sourceTokenUuid);
    if (!token) return false;
    const flourish = this.weaponArtFlourish?.(token, message.weaponArt?.image) ?? false;
    await this.wait(COMBAT_BEAT_TIMING.weaponArtSound);
    await Promise.allSettled([
      flourish,
      this.audio.play(SOUND_IDS.COMBAT_WEAPON_ART_ACTIVATE, { channel: 'interface' })
    ]);
    return true;
  }

  /**
   * Present the attack art, critical wind-up and authored animation using explicit beat durations.
   * The host writes and reverts Token art even when it cannot render the attack locally.
   */
  async #showAttack(message) {
    const critical = message.result === 'crit';
    const animation = critical ? message.criticalAnimation : message.attackAnimation;
    if (message.result === 'miss') this.#scheduleEvadeSwap(message);
    let revert = null;
    try {
      void this.#settle(this.tokenArt.fireConditional(
        message.sourceActorUuid,
        critical ? 'On Crit' : 'On Attack',
        {
          manualRevert: true,
          fallback: critical ? 'On Attack' : '',
          usedItem: message.source?.usedItem,
          tokenUuid: message.sourceTokenUuid
        }
      ), 'showAttack');
      const [source, target] = await Promise.all([
        this.tokens.placeable(message.sourceTokenUuid),
        this.tokens.placeable(message.targetTokenUuid)
      ]);
      const context = { token: source && target ? source : null, target, distance: message.distance, path: COMBAT_SOUND_PATH };
      if (critical) {
        await this.#showCriticalWindUp(message, source);
      } else if (message.activationAnimation?.steps?.length) {
        await this.wait(COMBAT_BEAT_TIMING.attackLead);
        await this.#playAnimationSlot(message.activationAnimation, context);
      }
      revert = this.#scheduleAttackRevert(message.sourceActorUuid, animation);
      if (animation?.steps?.length) await this.#playAnimationSlot(animation, context);
      return Boolean(source && target);
    } finally {
      if (revert) this.cancelScheduled(revert.timer);
      if (!revert?.fired) {
        void Promise.resolve(this.tokenArt.revertConditional(
          message.sourceActorUuid,
          { delay: 0 }
        )).catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'showAttack' }); return false; });
      }
    }
  }

  /** Start one authored animation where this client can draw it, and hold for its authored length either way. */
  async #playAnimationSlot(animation, context) {
    if (context.token) await this.animation(animation, context, { await: false });
    await this.wait(animationDuration(animation, 0));
  }

  /** The critical flash, then the critical banner and voice line for a unit with a voice, each for its fixed length. */
  async #showCriticalWindUp(message, source) {
    const visible = !pageHidden();
    if (visible) {
      void this.#settle(this.audio.play(SOUND_IDS.COMBAT_CRITICAL_FLASH, { channel: 'environment' }), 'criticalFlash');
      if (source) void this.#settle(this.criticalFlash?.(source), 'criticalFlash');
    }
    await this.wait(COMBAT_BEAT_TIMING.criticalFlash + COMBAT_BEAT_TIMING.attackLead);
    if (!message.source?.hasVoicePath) return;
    if (visible) {
      void this.#settle(this.critical?.show?.(message.source), 'criticalBanner');
      void this.#settle(this.audio.play(SOUND_IDS.COMBAT_CRITICAL_BANNER, { channel: 'interface', volume: 0.3 }),
        'criticalBanner');
      if (message.check?.criticalVoice && !voiceLinesMuted()) {
        void this.#settle(this.wait(COMBAT_BEAT_TIMING.criticalVoiceDelay).then(() => this.audio.playFile(
          message.check.criticalVoice, { volume: 1, channel: AUDIO_CHANNELS.VOICE_OVER })), 'criticalVoice');
      }
    }
    await this.wait(CRITICAL_BANNER_MS);
  }

  /** The landing: the attack card, posted even from a hidden host, and the miss or damage each visible client shows. */
  async #showImpact(message) {
    this.evadeSwaps.delete(String(message.targetActorUuid ?? ''));
    const outcomes = [this.#postAttackCard(message)];
    if (message.result === 'miss') {
      if (!pageHidden()) outcomes.push(this.#showMiss(message));
    } else if (message.health?.kind === HEALTH_PRESENTATION_KIND) {
      outcomes.push(this.health.show(message.health));
    }
    await Promise.allSettled(outcomes);
    return true;
  }

  async #showMiss(message) {
    const [target, source] = await Promise.all([
      this.tokens.placeable(message.targetTokenUuid),
      this.tokens.placeable(message.sourceTokenUuid)
    ]);
    if (!target) return false;
    showFloatingText(target, 'Miss!', { color: '#FFFFFF', group: 'combat',
      fontScale: 0.4,
      offsetY: -40,
      floatDistance: 60,
      durationMs: 1500
    });
    if (source) void this.#settle(this.dodge(target, source), 'showImpact');
    return this.audio.play(SOUND_IDS.COMBAT_MISS, { channel: 'environment', volume: 0.5 });
  }

  /** Let a started visual or sound run on its own, recording a failure rather than surfacing it. */
  #settle(work, detail) {
    return Promise.resolve(work).catch(diagnosticError => {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail });
      return false;
    });
  }

  #scheduleEvadeSwap(message) {
    const actorUuid = String(message.targetActorUuid ?? '');
    if (!actorUuid) return;
    const existing = this.evadeSwaps.get(actorUuid);
    if (existing) this.cancelScheduled(existing.timer);
    const duration = attackDuration(message);
    const record = { fired: false, timer: null };
    record.timer = this.schedule(() => {
      record.fired = true;
      void this.tokenArt.fireConditional(actorUuid, 'On Evade', {
        swapFadeMs: 140,
        durationMs: 440,
        revertFadeMs: 240
      }).catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'scheduleEvadeSwap' }); return false; });
    }, Math.max(0, duration - 140));
    this.evadeSwaps.set(actorUuid, record);
  }

  #scheduleAttackRevert(actorUuid, animation) {
    const duration = animationDuration(animation, 0);
    const record = { fired: false, timer: null };
    record.timer = this.schedule(() => {
      record.fired = true;
      void this.tokenArt.revertConditional(actorUuid, { delay: 0 }).catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'scheduleAttackRevert' }); return false; });
    }, Math.max(0, duration - 100));
    return record;
  }

  async #showEffectOperation(message) {
    const step = message.operation?.step ?? {};
    const [self, target, lastSpawned] = await Promise.all([
      this.tokens.placeable(message.runtime?.self?.tokenUuid),
      this.tokens.placeable(message.runtime?.target?.tokenUuid),
      this.tokens.placeable(message.runtime?.lastSpawnedTokenUuid)
    ]);
    if (step.kind === 'animation' && step.animation) {
      await this.animation(step.animation, {
        token: self,
        target,
        targetLocation: message.runtime?.targetLocation ?? null,
        lastSpawnedToken: lastSpawned
      }, { await: false });
      return true;
    }
    if (pageHidden()) return false;
    if (step.kind === 'floatingText') {
      const placeable = step.tokenUuid
        ? await this.tokens.placeable(step.tokenUuid)
        : step.target === 'self' ? self : target;
      if (!placeable) return false;
      showFloatingText(placeable, String(step.text ?? ''), { color: String(step.color ?? '#FFFFFF'), group: 'combat',
        fontSize: Number.isFinite(Number(step.fontSize)) ? Number(step.fontSize) : null,
        fontScale: Math.max(0.1, Number(step.fontScale) || 0.35),
        offsetY: Number.isFinite(Number(step.offsetY)) ? Number(step.offsetY) : -40,
        floatDistance: Number.isFinite(Number(step.floatDistance)) ? Number(step.floatDistance) : null,
        durationMs: Number.isFinite(Number(step.durationMs)) ? Number(step.durationMs) : 1500
      });
      return true;
    }
    if (step.kind === 'shieldChange') {
      const placeable = await this.tokens.placeable(step.tokenUuid);
      if (!placeable || !(Number(step.gained) > 0)) return false;
      showFloatingText(placeable, `+${Number(step.gained)} Shield`, { color: '#1fffe0', group: 'combat',
        fontScale: 0.35,
        offsetY: -40,
        durationMs: 1500
      });
      return true;
    }
    if (step.kind === 'effectNotice') {
      if (step.notice === 'immune') {
        this.notify('info', `${step.actorName} is immune to ${step.effectName} (${step.sourceName}).`);
        return true;
      }
      const notificationId = GUARD_BOND_NOTIFICATIONS[step.notice];
      if (!notificationId) return false;
      this.notices.show(notificationId, { actorName: String(step.actorName ?? '') });
      return true;
    }
    if (step.kind === 'playResist') {
      const placeable = step.target === 'self' ? self : target;
      const source = step.target === 'self' ? target : self;
      if (placeable) {
        showFloatingText(placeable, 'Resist!', { color: '#FFFFFF', group: 'combat',
          fontScale: 0.4,
          offsetY: -40,
          floatDistance: 60,
          durationMs: 1500
        });
      }
      await Promise.allSettled([
        this.audio.play(SOUND_IDS.COMBAT_RESIST, { channel: 'environment', volume: 0.5 }),
        placeable && source && placeable !== source ? this.dodge(placeable, source) : Promise.resolve(false)
      ]);
      return true;
    }
    if (step.kind === 'playVoice' && step.voiceFile) {
      if (voiceLinesMuted()) return false;
      await this.audio.playFile(step.voiceFile, { channel: AUDIO_CHANNELS.VOICE_OVER });
      return true;
    }
    return false;
  }

  async #showActivation(message) {
    if (message.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.LEAD_IN) {
      return this.#showActivationLeadIn(message);
    }
    if (message.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.END) {
      return this.#showActivationEnd(message);
    }
    if (message.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.DAMAGE_CARD) {
      return this.#postEffectDamageCard(message);
    }
    if (message.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.RANK_UP) return this.#showRankUp(message);
    if (message.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.NOTICE) {
      if (pageHidden()) return false;
      this.notify('info', ['booster', 'support'].includes(message.notice)
        ? String(message.message ?? '')
        : `${message.notice === 'save' ? 'Saving throw' : 'Skill check'}: ${message.total}`);
      return true;
    }
    if (message.beat !== ITEM_ACTIVATION_PRESENTATION_BEATS.CAST) return false;
    const condition = String(message.castCondition ?? 'On Cast');
    const held = message.castHeld !== false;
    const animation = message.activationAnimation ?? message.attackAnimation;
    if (held) this.#fireActivationArt(message, condition);
    const [source, targets] = await Promise.all([
      this.tokens.placeable(message.sourceTokenUuid),
      Promise.all((message.targetTokenUuids ?? []).map(uuid => this.tokens.placeable(uuid)))
    ]);
    await this.wait(ITEM_ACTIVATION_TIMING.castAnimationDelay);
    if (!animation?.steps?.length) return true;
    if (!held) this.#fireActivationArt(message, condition);
    await this.#playAnimationSlot(animation, {
      token: source,
      target: targets.filter(Boolean),
      targetLocation: message.targetLocation ?? null,
      distance: message.distance,
      path: COMBAT_SOUND_PATH
    });
    if (held) return true;
    if (!Number.isFinite(Number(animation.duration))) {
      await this.wait(ITEM_ACTIVATION_TIMING.castRevertFallback);
    }
    void Promise.resolve(this.tokenArt.revertConditional(message.sourceActorUuid, { delay: 0 }))
      .catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'showActivation' }); return false; });
    return true;
  }

  #fireActivationArt(message, condition) {
    void Promise.resolve(this.tokenArt.fireConditional(
      message.sourceActorUuid,
      condition,
      { manualRevert: true, usedItem: message.item, tokenUuid: message.sourceTokenUuid }
    )).catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'fireActivationArt' }); return false; });
  }

  async #showActivationLeadIn(message) {
    await this.#holdPathfindingIndicator(message.sourceTokenUuid, true);
    await this.#faceExchange(message.sourceTokenUuid, message.targetTokenUuids?.[0]);
    let opened = false;
    try {
      opened = await (this.cinematic?.startActivation?.(message) ?? false);
    } catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'showActivationLeadIn' });
      opened = false;
    }
    if (opened) await this.wait(ITEM_ACTIVATION_TIMING.castLeadIn);
    return true;
  }

  async #showActivationEnd(message) {
    const settled = await Promise.allSettled([
      this.cinematic?.end?.(message) ?? Promise.resolve(true),
      this.tokenArt.ensureBaseline?.(message.sourceActorUuid) ?? Promise.resolve(true)
    ]);
    await this.#holdPathfindingIndicator(message.sourceTokenUuid, false);
    return settled.every(result => result.status === 'fulfilled');
  }

  #showNotice(message) {
    if (pageHidden()) return false;
    this.notify(String(message.level ?? 'info'), String(message.message ?? ''));
    return true;
  }

  /** Post the proficiency rank-up card under the unit’s speaker name. */
  #showRankUp(message) {
    if (!this.chat?.create || !message.actorUuid) return Promise.resolve(false);
    return this.chat.create({
      actorUuid: message.actorUuid,
      alias: message.actorName,
      rolls: [],
      content: renderWeaponRankCard(message),
      requester: message.requester ?? null
    });
  }

  #postEffectDamageCard(message) {
    if (!this.chat?.create || !message.sourceActorUuid) return Promise.resolve(false);
    return this.chat.create({
      actorUuid: message.sourceActorUuid,
      rolls: [],
      content: effectDamageCard(message),
      requester: message.requester ?? null
    });
  }

  /** The card follows the attacker's own roll mode, so a private attack does not report itself to the table. */
  #postAttackCard(message) {
    if (!this.chat?.create || !message.sourceActorUuid) return Promise.resolve(false);
    return this.chat.create({
      actorUuid: message.sourceActorUuid,
      rolls: [],
      content: attackCard(message),
      requester: message.requester ?? null
    });
  }
}

function attackDuration(message) {
  const activation = message.activationAnimation?.steps?.length
    ? 100 + animationDuration(message.activationAnimation, 0) : 0;
  return activation + animationDuration(message.attackAnimation, 0);
}

function animationDuration(animation, fallback) {
  return animation?.steps?.length && Number.isFinite(Number(animation.duration))
    ? Math.max(0, Number(animation.duration)) : fallback;
}

/* -------------------------------------------- */
/*  Beat holds                                  */
/* -------------------------------------------- */

/**
 * How long one exchange beat holds the table, from the presenter's fixed timings: the swing's authored animation
 * and any critical wind-up, a hit's shake, the letterbox's close. The host waits this out instead of its rendering.
 * @param {object} message Combat presentation message.
 * @returns {number} Milliseconds.
 */
export function combatBeatHoldMs(message) {
  switch (message?.beat) {
    case COMBAT_PRESENTATION_BEATS.WEAPON_ART: return COMBAT_BEAT_TIMING.weaponArtSound;
    case COMBAT_PRESENTATION_BEATS.ATTACK: return attackHoldMs(message);
    case COMBAT_PRESENTATION_BEATS.IMPACT:
      return message.result !== 'miss' && message.health?.kind === HEALTH_PRESENTATION_KIND
        ? healthBeatHoldMs(message.health) : 0;
    case COMBAT_PRESENTATION_BEATS.END: return cinematicCloseMs(message);
    default: return 0;
  }
}

/**
 * How long one activation beat holds the table: the lead-in under a letterbox, the cast with its authored animation,
 * and the letterbox's close.
 * @param {object} message Item activation presentation message.
 * @returns {number} Milliseconds.
 */
export function activationBeatHoldMs(message) {
  if (message?.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.LEAD_IN) {
    return message.cinematic === true ? ITEM_ACTIVATION_TIMING.castLeadIn : 0;
  }
  if (message?.beat === ITEM_ACTIVATION_PRESENTATION_BEATS.END) return cinematicCloseMs(message);
  if (message?.beat !== ITEM_ACTIVATION_PRESENTATION_BEATS.CAST) return 0;
  const animation = message.activationAnimation ?? message.attackAnimation;
  if (!animation?.steps?.length) return ITEM_ACTIVATION_TIMING.castAnimationDelay;
  const revertFallback = message.castHeld === false && !Number.isFinite(Number(animation.duration))
    ? ITEM_ACTIVATION_TIMING.castRevertFallback : 0;
  return ITEM_ACTIVATION_TIMING.castAnimationDelay + animationDuration(animation, 0) + revertFallback;
}

/**
 * How long one effect step's presentation holds its effect: an awaited animation's planned length, or a resist's
 * dodge. An animation with no authored length is measured from its own steps, never from its rendering.
 * @param {object} message Effect operation presentation message.
 * @returns {number} Milliseconds.
 */
export function effectOperationHoldMs(message) {
  const step = message?.operation?.step ?? {};
  if (step.kind === 'playResist') return TOKEN_DODGE_MS;
  if (step.kind !== 'animation' || !step.animation || step.await !== true || step.persistent === true) return 0;
  return plannedAnimationMs(step.animation);
}

function attackHoldMs(message) {
  const critical = message.result === 'crit';
  let hold = animationDuration(critical ? message.criticalAnimation : message.attackAnimation, 0);
  if (critical) {
    hold += COMBAT_BEAT_TIMING.criticalFlash + COMBAT_BEAT_TIMING.attackLead;
    if (message.source?.hasVoicePath) hold += CRITICAL_BANNER_MS;
  } else if (message.activationAnimation?.steps?.length) {
    hold += COMBAT_BEAT_TIMING.attackLead + animationDuration(message.activationAnimation, 0);
  }
  return hold;
}

function cinematicCloseMs(message) {
  return message?.cinematic === true && message?.objectTarget !== true ? CINEMATIC_CLOSE_MS : 0;
}

/** An animation's authored length, or else the longest its own delays, durations and waits add up to, capped. */
function plannedAnimationMs(animation) {
  if (Number.isFinite(Number(animation?.duration))) return Math.max(0, Number(animation.duration));
  let waits = 0;
  let longest = 0;
  for (const step of animation?.steps ?? []) {
    if (step?.kind === 'wait') waits += Math.max(0, Number(step.ms) || 0);
    else longest = Math.max(longest, (Number(step?.delay) || 0) + (Number(step?.duration) || 0));
  }
  return Math.min(EFFECT_ANIMATION_CEILING_MS, waits + longest);
}

/* -------------------------------------------- */
/*  Chat and floating text                      */
/* -------------------------------------------- */

function attackCard(message) {
  const result = String(message.check?.result ?? message.result ?? 'miss');
  const resultClass = result === 'crit' ? 'is-crit' : result === 'hit' ? 'is-hit' : 'is-miss';
  const resultLabel = result === 'crit' ? 'CRITICAL HIT!' : result === 'hit' ? 'HIT!' : 'MISS!';
  const source = message.source ?? {};
  const target = message.target ?? {};
  const weapon = source.weapon ?? {};
  const art = source.weaponArt;
  const artHtml = art?.image
    ? `<img class="emblem-atk-art" src="${escapeHtml(art.image)}" alt="weapon art" data-tooltip="Weapon Art">`
    : '';
  const weaponHtml = weapon.image
    ? `<img class="emblem-atk-wep" src="${escapeHtml(weapon.image)}" alt="weapon">`
    : '<i class="fas fa-hand-fist emblem-atk-wep emblem-atk-wep-fallback"></i>';
  const defeated = message.defeatStatus === 'claimed'
    ? '<span class="emblem-atk-defeated"><i class="fas fa-xmark"></i></span>' : '';
  return `<div class="emblem-roll-card emblem-skill-card emblem-atk-card">
    <header class="emblem-roll-header emblem-skill-header">
      <img src="${escapeHtml(source.actorImage || 'icons/svg/mystery-man.svg')}" alt="${escapeHtml(source.actorName ?? '')}"
        style="${avatarScaleStyle(source.avatarScale)}">
      <div class="emblem-skill-headtext">
        <span class="emblem-skill-actorname">${escapeHtml(source.actorName ?? '')}</span>
        <span class="emblem-skill-rollname">Attack Roll vs ${escapeHtml(target.actorName ?? '')}</span>
      </div>
    </header>
    <div class="emblem-skill-body emblem-atk-body">
      <div class="emblem-atk-matchup">${artHtml}${weaponHtml}
        <i class="fas fa-arrow-right emblem-atk-arrow"></i>
        <span class="emblem-atk-target-wrap">
          <img class="emblem-atk-target" src="${escapeHtml(target.actorImage || 'icons/svg/mystery-man.svg')}"
            alt="${escapeHtml(target.actorName ?? '')}" style="${avatarScaleStyle(target.avatarScale)}">${defeated}
        </span>
      </div>
      <div class="emblem-atk-rollline">${attackFormulaHtml(message.check)}</div>
      <div class="emblem-skill-total ${resultClass}">${escapeHtml(message.check?.total ?? '--')}</div>
      <div class="emblem-skill-verdict ${resultClass}">${resultLabel} (DC ${escapeHtml(message.check?.dc ?? '--')})</div>
      ${damageSectionHtml(message)}
    </div>
  </div>`;
}

function attackFormulaHtml(check = {}) {
  const line = index => {
    const natural = check.naturals?.[index] ?? check.natural ?? '--';
    const blessed = Number(check.blessedRolls?.[index]) || 0;
    let html = `<strong class="emblem-atk-natural">${escapeHtml(natural)}</strong>`
      + ` <span class="emblem-atk-term">+ ${escapeHtml(check.accuracyBonus ?? 0)} (Acc)</span>`;
    if (blessed) html += ` <span class="emblem-atk-term">+ ${escapeHtml(blessed)} (Blessed)</span>`;
    return html;
  };
  if (check.advantage || check.disadvantage) {
    const label = check.advantage ? 'Advantage' : 'Disadvantage';
    return `<div class="emblem-atk-formula-label">${label}</div>`
      + [0, 1].map(index => `<span class="emblem-atk-formula ${index === check.chosenIndex
        ? 'is-chosen' : 'is-discarded'}">${line(index)}</span>`).join(' ');
  }
  return `<span class="emblem-atk-formula">${line(check.chosenIndex ?? 0)}</span>`;
}

function damageSectionHtml(message) {
  if (!['hit', 'crit'].includes(String(message.check?.result ?? message.result))) return '';
  const damage = message.damage ?? {};
  const icon = damage.damageType && damage.damageType !== 'none'
    ? `<img class="emblem-atk-dmg-icon" src="systems/emblem-rpg/assets/ui/dmg-types/${escapeHtml(damage.damageType)}.png"
        data-tooltip="${escapeHtml(damage.damageType)}" alt="${escapeHtml(damage.damageType)}">` : '';
  const rows = [
    ['Attack', `${escapeHtml(damage.damageFormula ?? '0')} → <strong>${escapeHtml(damage.rolled ?? 0)}</strong>`]
  ];
  if (damage.effective) rows.push(['Effective', `×${escapeHtml(damage.effectivenessMultiplier)} (vs unit type)`]);
  if (Number(damage.mitigation) > 0 || damage.mitigationBroken === true) {
    const armored = Number(damage.mitigationArmor) > 0;
    const parts = [armored || damage.mitigationBroken === true
      ? `${escapeHtml(damage.mitigationStat)} ${escapeHtml(damage.mitigationBase)}`
      : escapeHtml(damage.mitigationStat)];
    if (armored) parts.push(`armor ${escapeHtml(damage.mitigationArmor)}`);
    const halved = damage.mitigationBroken === true ? ', halved on crit' : '';
    rows.push(['Mitigation', `−${escapeHtml(damage.mitigation)} (${parts.join(' + ')}${halved})`]);
  }
  if (message.critical) {
    const criticalTotal = Math.ceil((Number(damage.rolled) || 0) * Math.max(1, Number(damage.criticalMultiplier) || 1));
    rows.push(['Critical', `×${escapeHtml(damage.criticalMultiplier)} → <strong>${escapeHtml(criticalTotal)}</strong>`]);
  }
  // Immunity sets both totals to zero, so the card says why.
  if (damage.immunityApplied) {
    rows.push(['Immune', `${escapeHtml(damage.damageType || 'this damage type')} has no effect`]);
  }
  rows.push(['Damage dealt', `<strong>${escapeHtml(message.amount ?? 0)}</strong>`]);
  let breakReason = '';
  if (damage.immunityApplied) breakReason = ' (immune)';
  else if (damage.protectionApplied) breakReason = ' (resisted, capped)';
  else if (damage.vulnerabilityApplied) breakReason = ' (vulnerable, ×2)';
  else if (Number(damage.breakReduction) > 0) breakReason = ` (−${escapeHtml(damage.breakReduction)} reduction)`;
  const breakFinal = Number(damage.breakDamage) || 0;
  const breakBase = Number(damage.breakBase) || 0;
  const breakArrow = breakFinal !== breakBase ? ` → ${escapeHtml(breakFinal)}` : '';
  rows.push(['Brk', `${escapeHtml(breakBase)}${breakArrow}${breakReason}`]);
  return `<div class="emblem-atk-divider"></div>
    <div class="emblem-atk-damage">
      <span class="emblem-atk-dmg">Damage Dealt: <strong>${escapeHtml(message.amount ?? 0)}</strong> ${icon}</span>
      <span class="emblem-atk-brk">Brk: <strong>${escapeHtml(breakFinal)}</strong></span>
    </div>
    <details class="emblem-atk-details">
      <summary class="emblem-atk-summary"><i class="fas fa-caret-down emblem-atk-caret"></i> Details</summary>
      <div class="emblem-atk-breakdown">${rows.map(([key, value]) => `<div class="emblem-atk-row">
        <span class="emblem-atk-row-key">${escapeHtml(key)}</span><span class="emblem-atk-row-val">${value}</span>
      </div>`).join('')}</div>
    </details>`;
}

function effectDamageCard(message) {
  const item = message.item ?? {};
  const rows = (message.rows ?? []).map(row => {
    const icon = row.damageType && row.damageType !== 'none'
      ? `<img class="emblem-atk-dmg-icon" src="systems/emblem-rpg/assets/ui/dmg-types/${escapeHtml(row.damageType)}.png"
          data-tooltip="${escapeHtml(row.damageType)}" alt="${escapeHtml(row.damageType)}">` : '';
    const details = [
      [row.rolled ? 'Roll' : 'Base', `${escapeHtml(row.formula || row.total)} → <strong>${escapeHtml(row.total)}</strong>`]
    ];
    if (row.critical) details.push(['Critical', 'yes']);
    details.push(['Damage dealt', `<strong>${escapeHtml(row.dealt)}</strong>`]);
    return `<div class="emblem-atk-damage">
        <span class="emblem-atk-dmg">Damage Dealt: <strong>${escapeHtml(row.dealt)}</strong> ${icon}</span>
        <span class="emblem-atk-brk">Brk: <strong>${escapeHtml(row.stanceDealt)}</strong></span>
      </div>
      <details class="emblem-atk-details">
        <summary class="emblem-atk-summary"><i class="fas fa-caret-down emblem-atk-caret"></i> Details</summary>
        <div class="emblem-atk-breakdown">${details.map(([key, value]) => `<div class="emblem-atk-row">
          <span class="emblem-atk-row-key">${escapeHtml(key)}</span><span class="emblem-atk-row-val">${value}</span>
        </div>`).join('')}</div>
      </details>`;
  }).join('<div class="emblem-atk-divider"></div>');
  return `<div class="emblem-roll-card emblem-skill-card emblem-atk-card emblem-eff-card">
    <header class="emblem-roll-header emblem-skill-header">
      <img src="${escapeHtml(item.img || 'icons/svg/mystery-man.svg')}" alt="${escapeHtml(item.name ?? '')}">
      <div class="emblem-skill-headtext">
        <span class="emblem-skill-actorname">${escapeHtml(item.name ?? '')}</span>
        <span class="emblem-skill-rollname">Effect Damage</span>
      </div>
    </header>
    <div class="emblem-skill-body emblem-atk-body">${rows}</div>
  </div>`;
}
