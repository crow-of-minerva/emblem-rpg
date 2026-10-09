/** @layer presentation/graphics */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import {
  BUDDING_TALENT,
  BUDDING_TALENT_ACTIONS,
  LEVEL_UP_STAT_KEYS,
  LEVEL_UP_STAT_LABELS,
  PROGRESSION_PRESENTATION_BEATS,
  PROMOTION_STAT_KEYS
} from '../../contracts/domains/progression.mjs';
import { AUDIO_CHANNELS } from '../../contracts/domains/tokens.mjs';
import { avatarScaleStyle, escapeHtml } from '../../lib/dom/html.mjs';
import { SOUND_IDS } from '../audio/sound-database.mjs';
import { voiceLinesMuted } from '../audio/service.mjs';
import { NOTIFICATION_IDS } from '../interface/notification-ids.mjs';
import { finite as finiteNumber, whole } from '../../lib/core/runtime.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Presentation timing                         */
/* -------------------------------------------- */
/**
 * The overlays' own timings, in milliseconds. Not the same as PROGRESSION_PRESENTATION_TIMING in
 * contracts/domains/progression.mjs, which sets how long the engine waits.
 */
const PROGRESSION_PRESENTATION_TIMING = Object.freeze({
  reveal: 50,
  fadeOut: 300,
  experienceTick: 35,
  experienceLeadIn: 300,
  levelWrapPause: 200,
  experienceSettle: 500,
  splashReveal: 15,
  splashSettle: 195,
  splashHold: 1600,
  splashFadeOut: 350,
  statsLeadIn: 200,
  statStep: 500,
  statsMinimumLinger: 2000
});

/**
 * How long one progression beat holds the table, from the overlay's fixed timings: the bar counting up its award,
 * the splash, or a stat panel and its voice line.
 * @param {object} message Progression presentation message.
 * @returns {number} Milliseconds.
 */
export function progressionBeatHoldMs(message) {
  const timing = PROGRESSION_PRESENTATION_TIMING;
  switch (message?.beat) {
    case PROGRESSION_PRESENTATION_BEATS.EXPERIENCE: {
      const { ticks, wraps } = experienceBarSteps(message);
      return timing.experienceLeadIn + (ticks * timing.experienceTick) + (wraps * timing.levelWrapPause)
        + timing.experienceSettle + timing.fadeOut;
    }
    case PROGRESSION_PRESENTATION_BEATS.SPLASH: return timing.splashHold + timing.splashFadeOut;
    case PROGRESSION_PRESENTATION_BEATS.STATS: return statsPanelHoldMs(LEVEL_UP_STAT_KEYS.length, message.voiceClip);
    case PROGRESSION_PRESENTATION_BEATS.PROMOTION_STATS:
      return statsPanelHoldMs(PROMOTION_STAT_KEYS.length, message.voiceClip);
    default: return 0;
  }
}

function statsPanelHoldMs(statCount, voiceClip) {
  const timing = PROGRESSION_PRESENTATION_TIMING;
  const voice = Math.max(0, finiteNumber(voiceClip?.durationMs));
  return timing.statsLeadIn + (statCount * timing.statStep) + Math.max(timing.statsMinimumLinger, voice) + timing.fadeOut;
}

/** The one-point ticks and level wraps the bar shows for one award, counted the same way #fillExperienceBar does. */
function experienceBarSteps({ currentLevel, maxLevel, currentExperience, experienceThreshold, awardedExperience }) {
  const threshold = Math.max(1, whole(experienceThreshold) || 100);
  const level = whole(currentLevel);
  const levelCap = Math.max(1, whole(maxLevel) || 30);
  let left = whole(awardedExperience);
  let current = whole(currentExperience);
  let ticks = 0;
  let wraps = 0;
  while (left > 0 && level + wraps < levelCap) {
    const needed = threshold - current;
    if (left <= needed) {
      ticks += left;
      left = 0;
    } else {
      ticks += Math.max(0, needed);
      wraps += 1;
      current = 0;
      left -= needed;
    }
  }
  return { ticks, wraps };
}

/* -------------------------------------------- */
/*  Progression presentation                    */
/* -------------------------------------------- */
/**
 * Show XP gains and level-ups once they are saved, and post the class-feature notices and the
 * Budding Talent card. The presentation message handler in init/system.mjs sends progression messages here, and
 * PromotionPresentation borrows its stat panel.
 */
export class ProgressionPresentation {
  constructor({ diagnostics = null,
    audio = null,
    chat = null,
    notifications = null,
    document = globalThis.document,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  } = {}) {
    this.diagnostics = diagnostics;
    this.audio = audio;
    this.chat = chat;
    this.notifications = notifications;
    this.document = document;
    this.wait = wait;
  }

  /**
   * Show one progression beat the host broadcast. Each client draws the overlay and plays the sounds itself, so
   * its own volume and voice-line settings apply rather than the host's. A hidden page skips it.
   */
  async show(message) {
    switch (message?.beat) {
      case PROGRESSION_PRESENTATION_BEATS.EXPERIENCE: return this.showExperienceGain(message);
      case PROGRESSION_PRESENTATION_BEATS.SPLASH: return this.showLevelUpSplash();
      case PROGRESSION_PRESENTATION_BEATS.STATS: return this.showLevelUpStats({
        actor: { image: message.actorImage, avatarScale: message.avatarScale, stats: message.stats },
        statResults: message.statResults,
        voiceClip: message.voiceClip
      });
      default: return false;
    }
  }

  /** Tell this client's user which class features the unit gained, had replaced, lost, or is missing. */
  async presentFeatureChanges({ actorName, gained = [], replaced = [], missing = null, uniqueRemoved = null }) {
    if (!this.notifications) return false;
    for (const featureName of gained) {
      this.notifications.show(NOTIFICATION_IDS.CLASS_FEATURE_GAINED, { actorName, featureName });
    }
    if (replaced.length) this.notifications.show(NOTIFICATION_IDS.CLASS_FEATURES_REPLACED, { actorName, featureNames: replaced });
    for (const featureName of missing?.names ?? []) {
      this.notifications.show(NOTIFICATION_IDS.CLASS_FEATURE_MISSING, { className: missing.className, featureName });
    }
    if (uniqueRemoved?.names?.length) {
      this.notifications.show(NOTIFICATION_IDS.CLASS_UNIQUE_FEATURES_REMOVED, {
        actorName, className: uniqueRemoved.className, featureNames: uniqueRemoved.names
      });
    }
    return true;
  }

  /** Animate one saved XP award without reading or changing an Actor. */
  async showExperienceGain({
    actorName,
    currentLevel,
    maxLevel,
    currentExperience,
    experienceThreshold,
    awardedExperience
  }) {
    if (pageHidden()) return false;
    const threshold = Math.max(1, whole(experienceThreshold) || 100);
    const overlay = this.#mount({
      id: 'xp-gain-container',
      interactive: true,
      html: `
        <div class="xp-body">
          <div class="xp-actor-name">${escapeHtml(actorName)} Lv ${whole(currentLevel)}</div>
          <div class="xp-progress-track">
            <div id="xp-progress-bar" style="width: ${(whole(currentExperience) / threshold) * 100}%;"></div>
          </div>
          <div class="xp-counter"><span id="current-xp">${whole(currentExperience)}</span>`
            + `/<span id="max-xp">${threshold}</span></div>
        </div>
      `
    });
    void this.#show(overlay);

    let loop = null;
    try {
      loop = await this.audio?.start?.(SOUND_IDS.PROGRESSION_XP_GAIN, {
        volume: 0.3,
        loop: true,
        channel: 'interface'
      });
      await this.wait(PROGRESSION_PRESENTATION_TIMING.experienceLeadIn);
      await this.#fillExperienceBar(overlay, {
        currentLevel: whole(currentLevel),
        maxLevel: Math.max(1, whole(maxLevel) || 30),
        currentExperience: whole(currentExperience),
        experienceThreshold: threshold,
        awardedExperience: whole(awardedExperience)
      });
    } finally {
      loop?.stop?.();
    }

    await this.wait(PROGRESSION_PRESENTATION_TIMING.experienceSettle);
    this.#hide(overlay);
    await this.wait(PROGRESSION_PRESENTATION_TIMING.fadeOut);
    overlay.remove();
  }

  /** Show the LEVEL UP splash after the new level is saved. */
  async showLevelUpSplash() {
    if (pageHidden()) return false;
    const splash = this.#mount({ id: 'levelup-splash' });
    splash.textContent = 'LEVEL UP!';
    void this.audio?.play?.(SOUND_IDS.PROGRESSION_LEVEL_UP, { channel: 'interface' });

    await this.wait(PROGRESSION_PRESENTATION_TIMING.splashReveal);
    splash.style.opacity = '1';
    splash.style.transform = 'translate(-50%, -50%) scale(1.1)';
    await this.wait(PROGRESSION_PRESENTATION_TIMING.splashSettle
      - PROGRESSION_PRESENTATION_TIMING.splashReveal);
    splash.style.transform = 'translate(-50%, -50%) scale(1.0)';
    await this.wait(PROGRESSION_PRESENTATION_TIMING.splashHold
      - PROGRESSION_PRESENTATION_TIMING.splashSettle);
    splash.style.opacity = '0';
    splash.style.transform = 'translate(-50%, -50%) scale(0.85)';
    await this.wait(PROGRESSION_PRESENTATION_TIMING.splashFadeOut);
    splash.remove();
  }

  /**
   * Reveal the saved stat results one by one, then play the voice clip the host picked, if any.
   *
   * Serves level-ups and promotions, which is why the stat set, labels and container class are overridable.
   */
  async showLevelUpStats({
    actor,
    statResults = null,
    voiceClip = null,
    statKeys = LEVEL_UP_STAT_KEYS,
    statLabels = LEVEL_UP_STAT_LABELS,
    containerClass = ''
  }) {
    if (pageHidden()) return false;
    const stats = Object.fromEntries(statKeys.map(statKey => [
      statKey,
      statResults?.[statKey]?.oldValue ?? finiteNumber(actor.stats?.[statKey])
    ]));
    const statsHtml = statKeys.map(statKey => `
      <div class="stat-col">
        <span class="stat-label">${statLabels[statKey]}</span>
        <span class="stat-num" id="stat-num-${statKey}">${stats[statKey]}</span>
      </div>
    `).join('');
    const overlay = this.#mount({
      id: 'levelup-stats-container',
      className: containerClass,
      interactive: true,
      html: `
        <div class="levelup-row">
          <img class="levelup-portrait" src="${escapeHtml(actor.image || 'icons/svg/mystery-man.svg')}"
            style="${avatarScaleStyle(actor.avatarScale)}">
          <div class="levelup-stats-row">${statsHtml}</div>
        </div>
      `
    });
    void this.#show(overlay);
    await this.wait(PROGRESSION_PRESENTATION_TIMING.statsLeadIn);

    for (const statKey of statKeys) {
      await this.wait(PROGRESSION_PRESENTATION_TIMING.statStep);
      const element = overlay.querySelector?.(`#stat-num-${statKey}`);
      if (!element) continue;
      const result = statResults?.[statKey];
      if (!result) {
        element.style.color = '#808080';
        continue;
      }
      if (result.increased) {
        element.textContent = String(result.newValue);
        element.classList.add('is-increased');
        element.style.color = result.zenith ? '#40e0d0' : '#3fb400';
        if (result.zenith) element.classList.add('is-zenith');
        void this.audio?.play?.(SOUND_IDS.PROGRESSION_LEVEL_DING, { channel: 'interface' });
      } else if (result.zenith) {
        element.style.color = '#40e0d0';
        element.classList.add('is-zenith');
      } else {
        element.style.color = '#808080';
      }
    }

    const voiceDuration = Math.max(0, finiteNumber(voiceClip?.durationMs));
    if (voiceClip?.file && !voiceLinesMuted()) {
      void this.audio?.playFile?.(voiceClip.file, { channel: AUDIO_CHANNELS.VOICE_OVER });
    }
    await this.wait(Math.max(PROGRESSION_PRESENTATION_TIMING.statsMinimumLinger, voiceDuration));
    this.#hide(overlay);
    await this.wait(PROGRESSION_PRESENTATION_TIMING.fadeOut);
    overlay.remove();
  }

  /** Announce a skill rank climbed by use, through the injected chat output. */
  async createSkillRankUp(outcome) {
    if (typeof this.chat?.createSkillRankUp !== 'function') return false;
    await this.chat.createSkillRankUp(outcome);
    return true;
  }

  /** Post the Budding Talent outcome after the progression stat panel closes. */
  async presentBuddingTalent({ actorUuid, actorName, actorImage, avatarScale, notice }) {
    const gained = notice?.action === BUDDING_TALENT_ACTIONS.GAIN;
    const removed = notice?.action === BUDDING_TALENT_ACTIONS.REMOVE;
    if ((!gained && !removed) || !this.chat?.create) return false;
    const reason = gained ? `Gained because ${escapeHtml(notice.reason)} this level.`
      : 'Removed because a stat other than HP grew this level.';
    const note = gained
      ? `<strong>+${BUDDING_TALENT.growthBonus}</strong> to every growth rate until a stat other than HP grows.`
      : 'The growth rate bonus ends.';
    const content = `
      <div class="emblem-roll-card emblem-skill-card emblem-talent-card emblem-progression-talent-card`
        + ` ${gained ? 'is-gained' : 'is-lost'}">
        <header class="emblem-roll-header emblem-skill-header">
          <img src="${escapeHtml(actorImage || 'icons/svg/mystery-man.svg')}" alt="${escapeHtml(actorName)}"
            style="${avatarScaleStyle(avatarScale)}">
          <div class="emblem-skill-headtext">
            <span class="emblem-skill-actorname">${escapeHtml(actorName)}</span>
            <span class="emblem-skill-rollname">Level-Up Growth</span>
          </div>
        </header>
        <div class="emblem-skill-body">
          <img class="emblem-skill-icon" src="systems/${SYSTEM_ID}/assets/abilities/passive/Budding Talent.png"
            alt="${BUDDING_TALENT.name}">
          <div class="emblem-skill-verdict">${gained ? 'BUDDING TALENT' : 'TALENT BLOSSOMED'}</div>
          <div class="emblem-talent-sub">${reason}</div>
          <div class="emblem-talent-note">${note}</div>
        </div>
      </div>`;
    await this.chat.create({ actorUuid, content });
    return true;
  }

  async #fillExperienceBar(overlay, state) {
    let experienceLeft = state.awardedExperience;
    let currentExperience = state.currentExperience;
    let displayedLevels = 0;
    const update = () => {
      const bar = overlay.querySelector?.('#xp-progress-bar');
      const counter = overlay.querySelector?.('#current-xp');
      if (bar) bar.style.width = `${(currentExperience / state.experienceThreshold) * 100}%`;
      if (counter) counter.textContent = String(currentExperience);
    };

    while (experienceLeft > 0 && state.currentLevel + displayedLevels < state.maxLevel) {
      const needed = state.experienceThreshold - currentExperience;
      if (experienceLeft <= needed) {
        const target = currentExperience + experienceLeft;
        while (currentExperience < target) {
          currentExperience = Math.min(currentExperience + 1, target);
          update();
          await this.wait(PROGRESSION_PRESENTATION_TIMING.experienceTick);
        }
        experienceLeft = 0;
      } else {
        while (currentExperience < state.experienceThreshold) {
          currentExperience += 1;
          update();
          await this.wait(PROGRESSION_PRESENTATION_TIMING.experienceTick);
        }
        displayedLevels += 1;
        currentExperience = 0;
        experienceLeft -= needed;
        update();
        await this.wait(PROGRESSION_PRESENTATION_TIMING.levelWrapPause);
      }
    }
  }

  #mount({ id, html = '', interactive = false, className = '' }) {
    this.document.getElementById?.(id)?.remove?.();
    const element = this.document.createElement('div');
    element.id = id;
    if (className) element.className = className;
    if (html) element.innerHTML = html;
    if (!interactive) element.style.pointerEvents = 'none';
    this.document.body.appendChild(element);
    return element;
  }

  async #show(element) {
    await this.wait(PROGRESSION_PRESENTATION_TIMING.reveal);
    if (element.isConnected !== false) element.style.opacity = '1';
  }

  #hide(element) {
    element.style.opacity = '0';
  }
}
