/** @layer presentation/graphics */
import {
  PROGRESSION_PRESENTATION_BEATS,
  PROMOTION_STAT_KEYS,
  PROMOTION_STAT_LABELS
} from '../../contracts/domains/progression.mjs';
import { SOUND_DATABASE, SOUND_IDS } from '../audio/sound-database.mjs';
import { SYSTEM_ID, recordDiagnostic } from '../../contracts/protocol.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Promotion presentation                      */
/* -------------------------------------------- */
const PROMOTION_CONTAINER_CLASS = 'promotion-variant';
const FLOURISH_SOUND_IDS = Object.freeze({
  lightCharge: SOUND_IDS.MAGIC_LIGHT_CHARGE,
  electricCackle: SOUND_IDS.MAGIC_ELECTRIC_CACKLE,
  magicLoop: SOUND_IDS.MAGIC_LOOP,
  puffOfSmoke: SOUND_IDS.MAGIC_PUFF_OF_SMOKE,
  fanfare: SOUND_IDS.UI_FANFARE
});

/**
 * Show a promotion: the flourish over the unit and the panel of class base stats. The presentation message
 * handler in init/system.mjs sends the promotion beats here. The engine times the class swap on its own.
 */
export class PromotionPresentation {
  constructor({ progression, tokens = null, flourish = null, diagnostics = null } = {}) {
    this.progression = progression;
    this.tokens = tokens;
    this.flourish = flourish;
    this.diagnostics = diagnostics;
  }

  /**
   * Present one promotion beat the host sent: the flourish over the unit, or the stat panel.
   * @param {object} message A validated progression presentation message.
   * @returns {Promise<boolean|undefined>} False when this client skips the beat. A started flourish returns true at
   *   once; the stat panel resolves when it has finished.
   */
  async show(message) {
    if (message?.beat === PROGRESSION_PRESENTATION_BEATS.PROMOTION_FLOURISH) {
      return this.playPromotionFlourish(message.tokenUuid);
    }
    if (message?.beat === PROGRESSION_PRESENTATION_BEATS.PROMOTION_STATS) return this.showPromotionStats(message);
    return false;
  }

  /**
   * Start the promotion flourish on this client and return whether it started. A hidden page skips it. The
   * progression engine swaps the class on its own clock either way.
   * @param {string} tokenUuid Token being promoted.
   * @returns {Promise<boolean>} Whether the flourish started.
   */
  async playPromotionFlourish(tokenUuid) {
    if (pageHidden() || typeof this.flourish !== 'function') return false;
    const token = tokenUuid ? await this.tokens?.placeable?.(tokenUuid) : null;
    if (!token) return false;
    void Promise.resolve()
      .then(() => this.flourish(token, { sounds: flourishSoundFiles() }))
      .catch(error => recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: 'flourish' }));
    return true;
  }

  /** The stat panel in its promotion variant: every class base stat, rising from the old class to the new. */
  async showPromotionStats(message) {
    return this.progression.showLevelUpStats({
      actor: { image: message.actorImage, avatarScale: message.avatarScale, stats: {} },
      statResults: message.statResults,
      voiceClip: message.voiceClip,
      statKeys: PROMOTION_STAT_KEYS,
      statLabels: PROMOTION_STAT_LABELS,
      containerClass: PROMOTION_CONTAINER_CLASS
    });
  }
}

/* -------------------------------------------- */
/*  Sound resolution                            */
/* -------------------------------------------- */
function flourishSoundFiles() {
  return Object.fromEntries(Object.entries(FLOURISH_SOUND_IDS).map(([key, soundId]) => {
    const file = SOUND_DATABASE[soundId]?.file;
    return [key, file ? `systems/${SYSTEM_ID}/${file}` : ''];
  }));
}
