/** @layer presentation/interface */
import { DOWNTIME_PRESENTATION_EVENTS, REQUISITION_KIND_LABELS } from '../../contracts/domains/downtime.mjs';
import {
  ECONOMY_PRESENTATION_EVENTS, HAGGLE_SKILL_KEY, VENDOR_CHECKOUT_MODES
} from '../../contracts/domains/economy.mjs';
import { SYSTEM_ID, recordDiagnostic } from '../../contracts/protocol.mjs';
import { avatarScaleStyle, capitalize, escapeHtml } from '../../lib/dom/html.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';
import { SOUND_IDS } from '../audio/sound-database.mjs';
import { CONVERSATION_BANNER_HOLD, WORK_BANNER_HOLD } from '../graphics/banners.mjs';

/* -------------------------------------------- */
/*  Card assets                                 */
/* -------------------------------------------- */
const PROFICIENCY_ICON_PATH = `systems/${SYSTEM_ID}/assets/ui/proficiencies`;
const SKILL_ICON_PATH = `systems/${SYSTEM_ID}/assets/ui/skills`;
const UNRANKED_LABEL = '--';
const ACTOR_FALLBACK = 'icons/svg/mystery-man.svg';
const ITEM_FALLBACK = 'icons/svg/item-bag.svg';

/* -------------------------------------------- */
/*  Rank cards                                  */
/* -------------------------------------------- */

/**
 * The weapon proficiency rank-up card that presentation/canvas/combat-exchange.mjs posts: rank badges before and
 * after, and the rank reached as its verdict.
 */
export function renderWeaponRankCard({ actorName, actorImage, avatarScale, proficiencyKey, rankLetter, rank }) {
  const type = String(proficiencyKey ?? '').toLowerCase();
  const newRank = Math.max(1, Math.floor(Number(rank) || 1));
  const previousBadge = newRank > 1 ? `rank${newRank - 1}.png` : 'norank.png';
  const letter = escapeHtml(rankLetter ?? '');
  return renderRankCard({
    actorName,
    actorImage,
    avatarScale,
    title: `${escapeHtml(capitalize(type))} Proficiency`,
    icon: type ? { image: `${PROFICIENCY_ICON_PATH}/prof-${type}.png`, alt: type } : null,
    track: `<img class="emblem-rank-badge is-prev" src="${PROFICIENCY_ICON_PATH}/${previousBadge}" alt="">
            <i class="fas fa-arrow-right emblem-rank-arrow"></i>
            <img class="emblem-rank-badge is-new" src="${PROFICIENCY_ICON_PATH}/rank${newRank}.png" alt="${letter}">`,
    verdict: `RANK ${letter}`
  });
}

/** The skill rank-up card FoundryProgressionChatOutput posts: the die before and after, and RANK UP as its verdict. */
export function renderSkillRankCard({ actorName, actorImage, avatarScale, skillKey, skillLabel, previousDie, newDie }) {
  const key = String(skillKey ?? '').toLowerCase();
  const label = String(skillLabel ?? capitalize(key));
  return renderRankCard({
    actorName,
    actorImage,
    avatarScale,
    title: `${escapeHtml(label)} Skill`,
    icon: key ? { image: `${SKILL_ICON_PATH}/${key}.png`, alt: label } : null,
    track: `<span class="emblem-rank-step is-prev">${escapeHtml(previousDie || UNRANKED_LABEL)}</span>
            <i class="fas fa-arrow-right emblem-rank-arrow"></i>
            <span class="emblem-rank-step is-new">${escapeHtml(newDie || UNRANKED_LABEL)}</span>`,
    verdict: 'RANK UP'
  });
}

/* -------------------------------------------- */
/*  Economy verdicts                            */
/* -------------------------------------------- */

/**
 * Show the economy's verdicts for the presentation handler in init/system.mjs. A theft plays its cue on every client
 * and gets a card, a finished purchase or sale gets a receipt, and a haggle plays a cue when the disposition moved
 * and gets its card. FoundryChatOutput posts cards from the active GM only.
 */
export class EconomyOutcomePresentation {
  constructor({ audio, chat }) {
    this.audio = audio;
    this.chat = chat;
  }

  async show(message) {
    if (message?.event === ECONOMY_PRESENTATION_EVENTS.SHOP_SETTLED) {
      await this.chat.create({
        actorUuid: String(message.actorUuid ?? ''),
        alias: String(message.actorName ?? ''),
        content: renderShopReceiptCard(message)
      });
      return true;
    }
    if (message?.event === ECONOMY_PRESENTATION_EVENTS.HAGGLE_SETTLED) return this.#showHaggle(message);
    const succeeded = message?.event === ECONOMY_PRESENTATION_EVENTS.STEAL_SUCCEEDED;
    await Promise.allSettled([
      pageHidden() ? false : this.audio.play(succeeded ? SOUND_IDS.UI_SUCCESS : SOUND_IDS.UI_FAILURE),
      this.chat.create({
        actorUuid: String(message?.actorUuid ?? ''),
        alias: String(message?.actorName ?? ''),
        content: renderStealOutcomeCard({ ...message, succeeded }),
        requester: message?.requester ?? null
      })
    ]);
    return true;
  }

  /** A gain plays the success cue and a loss the failure cue; no change and a hidden page play nothing. */
  async #showHaggle(message) {
    const sound = HAGGLE_SOUNDS[haggleState(message.shift)];
    await Promise.allSettled([
      !sound || pageHidden() ? false : this.audio.play(sound),
      this.chat.create({
        actorUuid: String(message.actorUuid ?? ''),
        alias: String(message.actorName ?? ''),
        content: renderHaggleCard(message),
        requester: message.requester ?? null
      })
    ]);
    return true;
  }
}

/** The steal verdict card: the thief, the items reached for, and whether the steal succeeded. */
function renderStealOutcomeCard({ actorName, actorImage, avatarScale, items = [], succeeded = false }) {
  const names = items.map(item => String(item?.name ?? '')).filter(Boolean);
  const label = names.length ? names.join(', ') : 'nothing';
  const state = succeeded ? 'is-success' : 'is-failure';
  const verdict = succeeded
    ? `${actorName ?? ''} successfully stole ${label}!`
    : `${actorName ?? ''} failed to steal ${label}`;
  const loot = items.map(item => `<img class="emblem-steal-item" src="${escapeHtml(item?.image || ITEM_FALLBACK)}"
          alt="${escapeHtml(item?.name ?? '')}" data-tooltip="${escapeHtml(item?.name ?? '')}">`).join('');
  const blocked = succeeded ? '' : '<i class="fas fa-xmark emblem-steal-block"></i>';
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-steal-card ${state}">
      <div class="emblem-skill-body emblem-steal-body">
        <div class="emblem-steal-reach">
          <img class="emblem-steal-thief" src="${escapeHtml(actorImage || ACTOR_FALLBACK)}"
            alt="${escapeHtml(actorName ?? '')}" style="${avatarScaleStyle(avatarScale)}">
          <span class="emblem-steal-arrow"><i class="fas fa-arrow-left"></i>${blocked}</span>
          <span class="emblem-steal-loot">${loot}</span>
        </div>
        <div class="emblem-skill-verdict ${state}">${escapeHtml(verdict)}</div>
      </div>
    </div>`;
}

/* -------------------------------------------- */
/*  Shop receipt                                */
/* -------------------------------------------- */

/** The shop receipt as a ledger: each line bought or sold with its cost, the total, and both purses under Details. */
export function renderShopReceiptCard(message) {
  const selling = message.mode === VENDOR_CHECKOUT_MODES.SELL;
  const items = Array.isArray(message.items) ? message.items : [];
  const failed = Number(message.failed) || 0;
  const state = selling ? 'is-success' : 'is-hit';
  const purses = [
    [message.actorName ?? '', purseHtml(message.purse)],
    [message.vendorName ?? 'Vendor', purseHtml(message.vendor)]
  ];
  if (message.holdingName) purses.push([selling ? 'Sold from' : 'Sent to', escapeHtml(message.holdingName), 'is-holding']);
  if (failed > 0) purses.push(['Not settled', `${escapeHtml(failed)} line${failed === 1 ? '' : 's'}`]);
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-atk-card emblem-shop-card ${selling ? 'is-sale' : 'is-purchase'}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(message.actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(message.actorName ?? '')}"
          style="${avatarScaleStyle(message.avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(message.actorName ?? '')}</span>
          <span class="emblem-skill-rollname">${selling ? 'Sale to' : 'Purchase from'} ${escapeHtml(message.vendorName ?? '')}</span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-shop-body">
        <div class="emblem-shop-lines">${items.map(receiptLineHtml).join('')}</div>${failed > 0
          ? `<div class="emblem-shop-note">${escapeHtml(failed)} not settled</div>` : ''}
        <div class="emblem-shop-total">
          <span class="emblem-skill-verdict ${state}">${selling ? 'GP RECEIVED' : 'GP SPENT'}</span>
          <span class="emblem-skill-total ${state}">${selling ? '+' : '−'}${escapeHtml(Number(message.gold) || 0)}</span>
        </div>
        <details class="emblem-atk-details">
          <summary class="emblem-atk-summary"><i class="fas fa-caret-down emblem-atk-caret"></i> Details</summary>
          <div class="emblem-atk-breakdown">${purses.map(([key, value, extra = '']) => `<div class="emblem-atk-row ${extra}"><span class="emblem-atk-row-key">${escapeHtml(key)}</span><span class="emblem-atk-row-val">${value}</span></div>`).join('')}</div>
        </details>
      </div>
    </div>`;
}

function receiptLineHtml(item) {
  const name = escapeHtml(item.name ?? '');
  return `<div class="emblem-shop-line">
      <img class="emblem-shop-icon" src="${escapeHtml(item.image || ITEM_FALLBACK)}" alt="${name}">
      <span class="emblem-shop-name">${name}<span class="emblem-shop-qty">×${escapeHtml(Number(item.units) || 0)}</span></span>
      <span class="emblem-shop-cost">${escapeHtml(Number(item.gold) || 0)}<span class="emblem-shop-gp">GP</span></span>
    </div>`;
}

function purseHtml(purse) {
  return `${escapeHtml(purse?.before ?? 0)} → <strong>${escapeHtml(purse?.after ?? 0)}</strong> GP`;
}

/* -------------------------------------------- */
/*  Haggle                                      */
/* -------------------------------------------- */
const HAGGLE_SOUNDS = Object.freeze({ 'is-success': SOUND_IDS.UI_SUCCESS, 'is-failure': SOUND_IDS.UI_FAILURE });

/**
 * The haggle card: the vendor with the disposition shift as its verdict, the haggler's Trading total, and the
 * disposition the party sees at that vendor before and after. engine/economy/trade.mjs builds the message.
 */
function renderHaggleCard({
  actorName, actorImage, avatarScale, vendorName, vendorImage, total = 0, shift = 0, dispositionBefore = 0,
  dispositionAfter = 0
}) {
  const step = Math.trunc(Number(shift) || 0);
  const state = haggleState(step);
  const stateClass = state ? ` ${state}` : '';
  const verdict = step === 0 ? 'No change' : `Disposition ${step > 0 ? '+' : ''}${step}`;
  const before = escapeHtml(Number(dispositionBefore) || 0);
  const after = escapeHtml(Number(dispositionAfter) || 0);
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-haggle-card${stateClass}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">Haggled with ${escapeHtml(vendorName || 'a vendor')}</span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-haggle-body">
        <div class="emblem-haggle-head">
          <img src="${escapeHtml(vendorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(vendorName ?? '')}">
          <div class="emblem-haggle-outcome${stateClass}">${escapeHtml(verdict)}</div>
        </div>
        <div class="emblem-haggle-roll${stateClass}">
          <img src="${SKILL_ICON_PATH}/${HAGGLE_SKILL_KEY}.png" alt="Trading">
          <span>Trading</span>
          <strong>${escapeHtml(Number(total) || 0)}</strong>
        </div>
        <div class="emblem-haggle-disposition">Disposition: ${before} → <strong>${after}</strong></div>
      </div>
    </div>`;
}

/** The card and cue state of a shift: a gain succeeds, a loss fails, and no change is neither. */
function haggleState(shift) {
  const step = Number(shift) || 0;
  if (step > 0) return 'is-success';
  return step < 0 ? 'is-failure' : '';
}

/* -------------------------------------------- */
/*  Downtime                                    */
/* -------------------------------------------- */
const GATHER_BEAT_SOUNDS = Object.freeze({
  harvesting: SOUND_IDS.DOWNTIME_GATHER_HARVESTING,
  mining: SOUND_IDS.DOWNTIME_GATHER_MINING,
  logging: SOUND_IDS.DOWNTIME_GATHER_LOGGING,
  shoveling: SOUND_IDS.DOWNTIME_GATHER_SHOVELING,
  fishing: SOUND_IDS.DOWNTIME_GATHER_FISHING
});
const GATHER_BANNER_COLOURS = Object.freeze({
  harvesting: Object.freeze({ flashColor: '#3a5a24', settleColor: '#13200e' }),
  mining: Object.freeze({ flashColor: '#6a2a24', settleColor: '#26100e' }),
  logging: Object.freeze({ flashColor: '#7a5a1e', settleColor: '#2a1f0c' }),
  shoveling: Object.freeze({ flashColor: '#5a3d22', settleColor: '#20150c' }),
  fishing: Object.freeze({ flashColor: '#24456a', settleColor: '#0e1a28' })
});

const FORGE_STRIKES = 4;
const FORGE_BANNER = Object.freeze({
  flashColor: '#806030', settleColor: '#1a1210',
  sparks: 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/sparks/sparks_009_800x800.webm'
});
const BREW_BANNER = Object.freeze({
  flashColor: '#6a7a24', settleColor: '#1c260e',
  sparks: 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/level 01/cure_wounds_green_800x800.webm'
});
const COOK_BANNER = Object.freeze({
  flashColor: '#8a4218', settleColor: '#2a1408',
  sparks: 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/fire/fire_03_800x800.webm'
});
const PERFORM_BANNER = Object.freeze({
  flashColor: '#5a3a7a', settleColor: '#1c1228',
  sparks: 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/misc/music_SQUARE_01.webm'
});
const REQUISITION_BANNER = Object.freeze({
  flashColor: '#5c5c5c', settleColor: '#1c1c1c',
  sparks: 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/level 01/divine_favor_yellow_800x800.webm',
  sparksFilter: 'grayscale(1)'
});
const WORK_END_EVENTS = new Set([
  DOWNTIME_PRESENTATION_EVENTS.GATHER_END, DOWNTIME_PRESENTATION_EVENTS.FORGE_END, DOWNTIME_PRESENTATION_EVENTS.BREW_END,
  DOWNTIME_PRESENTATION_EVENTS.COOK_END, DOWNTIME_PRESENTATION_EVENTS.PERFORM_END,
  DOWNTIME_PRESENTATION_EVENTS.REQUISITION_END
]);
const WORK_CARDS = Object.freeze({
  [DOWNTIME_PRESENTATION_EVENTS.GATHER_SETTLED]: message => renderGatherCard(message),
  [DOWNTIME_PRESENTATION_EVENTS.FORGE_SETTLED]: message => renderForgeCard(message),
  [DOWNTIME_PRESENTATION_EVENTS.BREW_SETTLED]: message => renderBrewCard(message),
  [DOWNTIME_PRESENTATION_EVENTS.COOK_SETTLED]: message => renderCookCard(message),
  [DOWNTIME_PRESENTATION_EVENTS.PERFORM_SETTLED]: message => renderPerformanceCard(message),
  [DOWNTIME_PRESENTATION_EVENTS.SOCIAL_SETTLED]: message => renderSocialCard(message),
  [DOWNTIME_PRESENTATION_EVENTS.TRAIN_SETTLED]: message => renderTrainingCard(message),
  [DOWNTIME_PRESENTATION_EVENTS.REQUISITION_SETTLED]: message => renderRequisitionCard(message)
});
const MEAL_VERDICT_CLASSES = Object.freeze({ special: 'is-exceptional', success: 'is-success', fail: 'is-failure' });
const PERFORMANCE_GRADE_CLASSES = Object.freeze({
  failure: 'is-failure', lesser: 'is-lesser', success: 'is-success', greater: 'is-greater', triumph: 'is-triumph'
});
const WORK_BEGIN_EVENTS = new Set([
  DOWNTIME_PRESENTATION_EVENTS.GATHER_BEGIN, DOWNTIME_PRESENTATION_EVENTS.FORGE_BEGIN,
  DOWNTIME_PRESENTATION_EVENTS.BREW_BEGIN, DOWNTIME_PRESENTATION_EVENTS.COOK_BEGIN,
  DOWNTIME_PRESENTATION_EVENTS.PERFORM_BEGIN, DOWNTIME_PRESENTATION_EVENTS.REQUISITION_BEGIN
]);
const SOCIAL_BEAT_EVENTS = new Set([
  DOWNTIME_PRESENTATION_EVENTS.SOCIAL_BEGIN, DOWNTIME_PRESENTATION_EVENTS.SOCIAL_END,
  DOWNTIME_PRESENTATION_EVENTS.TRAIN_BEGIN, DOWNTIME_PRESENTATION_EVENTS.TRAIN_END
]);

/**
 * How long one downtime beat holds the table, read by presentationHoldMs in delivery.mjs: a banner's opening, or its
 * close once the work is done. The spar holds nothing here; engine/downtime/resolvers.mjs waits out its passes on
 * its own clock.
 * @param {object} message Downtime presentation message.
 * @returns {number} Milliseconds.
 */
export function downtimeBeatHoldMs(message) {
  const event = message?.event;
  if (event === DOWNTIME_PRESENTATION_EVENTS.SOCIAL_BEGIN) return CONVERSATION_BANNER_HOLD.open;
  if (event === DOWNTIME_PRESENTATION_EVENTS.SOCIAL_END) return CONVERSATION_BANNER_HOLD.close;
  if (WORK_END_EVENTS.has(event)) return WORK_BANNER_HOLD.close;
  return WORK_BEGIN_EVENTS.has(event) ? WORK_BANNER_HOLD.open : 0;
}

/**
 * Play a downtime activity's beats on every client: the working or conversation banner and its close, the training
 * spar, and the card the GM posts. `conversation` is a ConversationBanner, `animation` plays one authored animation
 * locally, and `faceTokens` turns the sparring pair toward each other where this client may write it (init gates it
 * to the active GM).
 */
export class DowntimePresentation {
  constructor({
    banner, conversation = null, animation = null, faceTokens = null, chat, tokens = null, diagnostics = null
  }) {
    this.banner = banner;
    this.conversation = conversation;
    this.animation = animation;
    this.faceTokens = faceTokens;
    this.chat = chat;
    this.tokens = tokens;
    this.diagnostics = diagnostics;
  }

  /**
   * A hidden browser tab skips the banner and camera pan, but still closes a banner it opened, and the host still
   * posts the card.
   */
  async show(message) {
    const event = message?.event;
    if (SOCIAL_BEAT_EVENTS.has(event)) return this.#showSocialBeat(message);
    if (WORK_BEGIN_EVENTS.has(event) && pageHidden()) return false;
    if (event === DOWNTIME_PRESENTATION_EVENTS.GATHER_BEGIN) {
      await this.#focus(message.stationTokenUuid);
      const method = GATHER_BEAT_SOUNDS[message.method] ? message.method : 'harvesting';
      return this.banner.show({
        image: message.iconImage, beatSoundId: GATHER_BEAT_SOUNDS[method], ...GATHER_BANNER_COLOURS[method]
      });
    }
    if (event === DOWNTIME_PRESENTATION_EVENTS.FORGE_BEGIN) {
      await this.#focus(message.stationTokenUuid);
      return this.banner.show({
        image: message.iconImage, beatSoundId: SOUND_IDS.DOWNTIME_FORGE, beatIndex: () => Math.floor(Math.random() * FORGE_STRIKES),
        ...FORGE_BANNER
      });
    }
    if (event === DOWNTIME_PRESENTATION_EVENTS.BREW_BEGIN) {
      await this.#focus(message.stationTokenUuid);
      return this.banner.show({ image: message.iconImage, beatSoundId: SOUND_IDS.DOWNTIME_BREW, beatIndex: () => 0, ...BREW_BANNER });
    }
    if (event === DOWNTIME_PRESENTATION_EVENTS.COOK_BEGIN) {
      await this.#focus(message.stationTokenUuid);
      return this.banner.show({ image: message.iconImage, openSoundId: SOUND_IDS.DOWNTIME_COOK, ...COOK_BANNER });
    }
    if (event === DOWNTIME_PRESENTATION_EVENTS.PERFORM_BEGIN) {
      await this.#focus(message.stationTokenUuid);
      const trackPlaying = message.trackPlaying === true;
      return this.banner.show({
        image: message.iconImage, openSoundId: trackPlaying ? null : SOUND_IDS.UI_FANFARE, sustained: trackPlaying,
        ...PERFORM_BANNER
      });
    }
    if (event === DOWNTIME_PRESENTATION_EVENTS.REQUISITION_BEGIN) {
      await this.#focus(message.stationTokenUuid);
      return this.banner.show({ image: message.iconImage, openSoundId: SOUND_IDS.UI_PURCHASE, ...REQUISITION_BANNER });
    }
    if (WORK_END_EVENTS.has(event)) return this.banner.finish(workClose(message));
    const card = WORK_CARDS[event];
    if (!card) return false;
    await this.chat.create({
      actorUuid: String(message.actorUuid ?? ''),
      alias: String(message.actorName ?? ''),
      content: card(message),
      requester: message.requester ?? null
    });
    return true;
  }

  async #focus(tokenUuid) {
    const token = tokenUuid ? await this.tokens?.placeable?.(String(tokenUuid)) : null;
    if (!token?.center) return;
    // The camera pan is cosmetic, so an error starting it is ignored.
    try {
      canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 400 });
    } catch {  }
  }

  /**
   * The socialize and training beats: the conversation banner opens with the camera on the acting unit and closes on
   * the social-end beat; the training spar plays on its own. A training close has nothing open to close.
   */
  async #showSocialBeat(message) {
    const events = DOWNTIME_PRESENTATION_EVENTS;
    switch (message.event) {
      case events.SOCIAL_BEGIN:
        if (pageHidden() || !this.conversation) return false;
        await this.#focus(message.cursorTokenUuid);
        return this.conversation.show({ left: message.left, right: message.right });
      case events.SOCIAL_END:
        return this.conversation ? this.conversation.finish({ success: message.success !== false }) : false;
      case events.TRAIN_BEGIN:
        return this.#spar(message);
      default:
        return false;
    }
  }

  /**
   * Turn the pair to face each other, then play the authored spar locally: `passes` passes alternating trainer to
   * trainee and back, `passDurationMs` apart. The pacing is presentation only; the host's resolver waits on its own
   * clock, so a pass that fails is recorded and the spar moves on.
   */
  async #spar(message) {
    this.#faceTokens(message.trainerTokenUuid, message.traineeTokenUuid);
    if (pageHidden()) return false;
    await this.#focus(message.trainerTokenUuid);
    const passes = Math.max(0, Math.floor(Number(message.passes)) || 0);
    if (!message.animation || passes < 1 || typeof this.animation !== 'function') return true;
    const [trainer, trainee] = await Promise.all([
      this.tokens?.placeable?.(String(message.trainerTokenUuid)),
      this.tokens?.placeable?.(String(message.traineeTokenUuid))
    ]);
    if (!trainer || !trainee) return false;
    const pause = Math.max(0, Number(message.passDurationMs) || 0);
    for (let pass = 0; pass < passes && !pageHidden(); pass += 1) {
      const [token, target] = pass % 2 === 0 ? [trainer, trainee] : [trainee, trainer];
      try {
        await this.animation(message.animation, { token, target, distance: 1 }, {});
      } catch (error) {
        this.#record(error, 'spar-pass');
      }
      if (pass < passes - 1) await sleep(pause);
    }
    return true;
  }

  #faceTokens(trainerTokenUuid, traineeTokenUuid) {
    if (typeof this.faceTokens !== 'function') return;
    void Promise.resolve()
      .then(() => this.faceTokens(String(trainerTokenUuid ?? ''), String(traineeTokenUuid ?? '')))
      .catch(error => this.#record(error, 'spar-facing'));
  }

  #record(error, detail) {
    recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: `downtime:${detail}` });
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * How WorkBanner.finish closes a banner: a performance whose track plays on closes without the success sound, and
 * one whose track was cut off greys its icon in a dark red glow as the banner leaves.
 */
function workClose(message) {
  const success = message.success !== false;
  if (message.trackPlaying === true) return { success, sound: false };
  if (message.trackStopped === true) return { success, trackStopped: true };
  return { success };
}

/** The gather card: the performer, the node, every yield with its count, and where the goods went. */
function renderGatherCard({ actorName, actorImage, avatarScale, stationName, stationImage, destinationName, items = [] }) {
  const rows = items.map(item => {
    const note = item.leftBehind ? '<span class="emblem-gather-row-note is-left">Left behind: no room</span>' : '';
    const name = String(item.name ?? '');
    return `<div class="emblem-gather-row${item.leftBehind ? ' is-left' : ''}">
        <img class="emblem-gather-row-img" src="${escapeHtml(item.image || ITEM_FALLBACK)}" alt="${escapeHtml(name)}">
        <span class="emblem-gather-row-name">${escapeHtml(name)}</span>${note}
        <span class="emblem-gather-row-count">×${escapeHtml(Number(item.count) || 0)}</span>
      </div>`;
  }).join('');
  const body = rows
    ? `<div class="emblem-gather-list">${rows}</div>`
    : '<div class="emblem-gather-empty">Nothing could be gathered.</div>';
  const icon = stationImage
    ? `<img class="emblem-skill-icon" src="${escapeHtml(stationImage)}" alt="${escapeHtml(stationName ?? '')}">` : '';
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-gather-card">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">Gathered from ${escapeHtml(stationName ?? '')}</span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-gather-body">
        ${icon}
        ${body}
        <div class="emblem-gather-foot">Sent to ${escapeHtml(destinationName || 'nowhere')}</div>
      </div>
    </div>`;
}

/** Render consumed materials as one line in downtime cards. */
function materialsLine(materials = []) {
  return materials
    .filter(entry => entry?.name && Number(entry.quantity) > 0)
    .map(entry => `${escapeHtml(entry.name)} ×${escapeHtml(Number(entry.quantity))}`)
    .join(', ');
}

/** The crafting card shell the workshop and the laboratory share: the deed line, the subject's icon, the lines. */
function renderWorkCard({ actorName, actorImage, avatarScale, title, image, alt, lines, failed = false, extraClass = '' }) {
  const rows = lines.filter(Boolean).map(line => `<div class="emblem-forge-line">${line}</div>`).join('');
  const icon = image ? `<img class="emblem-skill-icon" src="${escapeHtml(image)}" alt="${escapeHtml(alt ?? '')}">` : '';
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-forge-card${failed ? ' is-failure' : ''}${extraClass ? ` ${extraClass}` : ''}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">${title}</span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-forge-body">
        ${icon}
        <div class="emblem-forge-lines">${rows}</div>
      </div>
    </div>`;
}

/** The forge card: the durability restored, the tally, a tier climbed, and the materials it took. */
function renderForgeCard({
  itemName, newName, itemImage, itemKind, usesBefore, usesAfter, usesMax, restored, tierBefore, tierAfter,
  forgingBefore, forgingXP, materials = [], ...actor
}) {
  const climbed = Number(tierAfter) > Number(tierBefore);
  const track = itemKind === 'staff' ? 'Uses' : 'Durability';
  const gain = Number(usesAfter) - Number(usesBefore);
  const spent = materialsLine(materials);
  return renderWorkCard({
    ...actor,
    title: climbed
      ? `Refined ${escapeHtml(itemName ?? '')} → ${escapeHtml(newName ?? '')}`
      : `${itemKind === 'staff' ? 'Repaired' : 'Forged'} ${escapeHtml(newName || itemName || '')}`,
    image: itemImage,
    alt: newName || itemName,
    lines: [
      `${track} ${escapeHtml(usesBefore ?? 0)} → <strong>${escapeHtml(usesAfter ?? 0)}</strong> / ${escapeHtml(usesMax ?? 0)} `
        + `<span class="emblem-forge-gain">(+${escapeHtml(gain)})</span>`,
      Number(forgingXP) !== Number(forgingBefore)
        ? `Forging XP ${escapeHtml(forgingBefore ?? 0)} → <strong>${escapeHtml(forgingXP ?? 0)}</strong>`
        : null,
      climbed ? `Reached <strong>(+${escapeHtml(tierAfter)})</strong>, new maximum ${escapeHtml(usesMax ?? 0)}` : null,
      spent ? `Materials: ${spent}` : null
    ]
  });
}

/** The brew card: the copies made and where they went, or the failure and the materials it still cost. */
function renderBrewCard({ recipeName, recipeImage, success, count, lost, destinations = [], materials = [], ...actor }) {
  const spent = materialsLine(materials);
  const made = Number(count) || 0;
  if (!success || made <= 0) {
    return renderWorkCard({
      ...actor,
      failed: true,
      title: `Failed to craft ${escapeHtml(recipeName ?? '')}`,
      image: recipeImage,
      alt: recipeName,
      lines: [spent ? `Materials lost: ${spent}` : null]
    });
  }
  const landed = made - (Number(lost) || 0);
  return renderWorkCard({
    ...actor,
    title: made > 1 ? `Crafted ${escapeHtml(recipeName ?? '')} ×${escapeHtml(made)}` : `Crafted ${escapeHtml(recipeName ?? '')}`,
    image: recipeImage,
    alt: recipeName,
    lines: [
      made > 1 ? '<em>1 extra made.</em>' : null,
      landed > 0 ? `Delivered to <strong>${escapeHtml(destinations.join(', ') || 'nowhere')}</strong>` : null,
      Number(lost) > 0 ? `<span class="emblem-forge-note">${escapeHtml(lost)} left behind: no room</span>` : null,
      spent ? `Materials: ${spent}` : null
    ]
  });
}

/**
 * The cook card: the recipe and the roll, the meal as its verdict, the special ingredient applied or wasted, every
 * diner with what the meal gave them, and the support experience the table shared.
 */
function renderCookCard({
  actorName, actorImage, avatarScale, stationName, stationImage, recipeName, total, dc, outcome, mealName,
  specialName = '', specialStat = '', diners = [], supportGain = 0, supportRecipients = [], rankUps = []
}) {
  const state = MEAL_VERDICT_CLASSES[outcome] ?? MEAL_VERDICT_CLASSES.fail;
  const exclaim = outcome === 'fail' ? '' : '!';
  const icon = stationImage
    ? `<img class="emblem-skill-icon" src="${escapeHtml(stationImage)}" alt="${escapeHtml(stationName ?? '')}">` : '';
  let special = '';
  if (specialName) {
    special = outcome === 'special'
      ? `<div class="emblem-cook-extra is-applied"><i class="fas fa-star"></i> Special ingredient: <strong>${escapeHtml(specialName)}</strong> → ${escapeHtml(specialStat)} +1</div>`
      : `<div class="emblem-cook-extra"><i class="fas fa-star"></i>
          ${escapeHtml(specialName)} wasted (DC not beaten by 5).</div>`;
  }
  const rows = diners.map(diner => `
        <div class="emblem-cook-diner">
          <img class="emblem-cook-diner-img" src="${escapeHtml(diner.image || ACTOR_FALLBACK)}" alt="${escapeHtml(diner.name ?? '')}"
            style="${avatarScaleStyle(diner.avatarScale)}">
          <span class="emblem-cook-diner-name">${escapeHtml(diner.name ?? '')}</span>
          <span class="emblem-cook-diner-buff">${escapeHtml(diner.summary || 'no lasting benefit')}</span>
        </div>`).join('');
  const support = supportRecipients.length
    ? `<div class="emblem-cook-section">
          <div class="emblem-cook-section-title">Support</div>
          <div class="emblem-cook-support">+${escapeHtml(Number(supportGain) || 0)} XP with ${escapeHtml(actorName ?? '')}: ${escapeHtml(supportRecipients.join(', '))}</div>
          ${rankUps.map(line => `<div class="emblem-cook-ready"><i class="fas fa-heart"></i> ${escapeHtml(line)}</div>`).join('')}
        </div>`
    : '';
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-cook-card ${state}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">Cooked ${escapeHtml(recipeName || 'a meal')}</span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-cook-body">
        ${icon}
        <div class="emblem-skill-verdict ${state}">${escapeHtml(mealName ?? '')}${exclaim}</div>
        <div class="emblem-cook-sub">Roll ${escapeHtml(total ?? 0)} vs DC ${escapeHtml(dc ?? 0)}</div>
        ${special}
        <div class="emblem-cook-section">
          <div class="emblem-cook-section-title">Diners</div>
          <div class="emblem-cook-diners">${rows}</div>
        </div>
        ${support}
      </div>
    </div>`;
}

/**
 * The performance card: the song and its grade, every performer's roll against the difficulty, the bonuses the
 * audience took or the Uninspired a failure left, how many units it reached, and the support it built. A failed
 * performance shows its grade without the song's art.
 */
function renderPerformanceCard({
  actorName, actorImage, avatarScale, stationName, stationImage, songName, songImage, grade, gradeLabel, dc,
  performers = [], bonuses = [], affectedCount = 0, listenerCount = 0, performerGain = 0, listenerGain = 0,
  supportRecipients = [], rankUps = []
}) {
  const state = PERFORMANCE_GRADE_CLASSES[grade] ?? PERFORMANCE_GRADE_CLASSES.failure;
  const icon = stationImage
    ? `<img class="emblem-skill-icon" src="${escapeHtml(stationImage)}" alt="${escapeHtml(stationName ?? '')}">` : '';
  const failed = grade === 'failure';
  const song = songImage && !failed ? `<img src="${escapeHtml(songImage)}" alt="${escapeHtml(songName ?? '')}">` : '';
  const rolls = performers.map(entry => `
          <div class="emblem-performance-roll ${entry.success ? 'is-success' : 'is-failure'}">
            <img src="${escapeHtml(entry.image || ACTOR_FALLBACK)}" alt="${escapeHtml(entry.name ?? '')}"
              style="${avatarScaleStyle(entry.avatarScale)}">
            <span>${escapeHtml(entry.name ?? '')}</span>
            <strong>${escapeHtml(Number(entry.total) || 0)}</strong>
          </div>`).join('');
  const granted = failed
    ? '<div class="emblem-performance-bonuses is-uninspired">'
      + 'Uninspired: no performance reaches them until the party rests.</div>'
    : '<div class="emblem-performance-bonuses">Inspired: '
      + `<strong>${escapeHtml(bonuses.join(', ') || 'no lasting benefit')}</strong></div>`;
  const reached = Number(affectedCount) || 0;
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-performance-card ${state}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">
            Performed ${escapeHtml(songName || 'a song')} (DC ${escapeHtml(dc ?? 0)})
          </span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-performance-body">
        ${icon}
        <div class="emblem-performance-head">
          ${song}
          <div class="emblem-performance-grade ${state}">${escapeHtml(gradeLabel ?? '')}${failed ? '' : '!'}</div>
        </div>
        <div class="emblem-performance-rolls">${rolls}</div>
        ${granted}
        <div class="emblem-performance-audience">${escapeHtml(reached)} unit${reached === 1 ? '' : 's'} affected</div>
        ${performanceSupport({ performers, performerGain, listenerGain, listenerCount, supportRecipients, rankUps })}
      </div>
    </div>`;
}

/** The support lines of the performance card: between performers, with the listeners, and every rank reached. */
function performanceSupport({ performers, performerGain, listenerGain, listenerCount, supportRecipients, rankUps }) {
  const lines = [];
  if (performers.length > 1 && Number(performerGain) > 0) {
    lines.push(`+${escapeHtml(Number(performerGain))} support XP between the performers`);
  }
  if (Number(listenerCount) > 0 && Number(listenerGain) > 0) {
    lines.push(`+${escapeHtml(Number(listenerGain))} support XP between each performer and every listener`);
  }
  if (!lines.length || !supportRecipients.length) return '';
  return `<div class="emblem-performance-support">
          ${lines.map(line => `<div>${line}</div>`).join('')}
          <div>Bonds grew with: ${escapeHtml(supportRecipients.join(', '))}</div>
          ${rankUps.map(line => `<div><i class="fas fa-heart"></i> ${escapeHtml(line)}</div>`).join('')}
        </div>`;
}

/**
 * The requisition card: the faction's answer as its verdict beside the Stationary, the requisitioner's Civics roll
 * against the difficulty, and the demand with where it went or who declined it. The request's kind travels as
 * `requestKind`, because `kind` on the message already names the presentation kind.
 */
function renderRequisitionCard({
  actorName, actorImage, avatarScale, stationName, stationImage, factionName, requestKind, demand = 0, dc = 0,
  total = 0, success = false, summary = ''
}) {
  const state = success ? 'is-success' : 'is-failure';
  const kind = REQUISITION_KIND_LABELS[requestKind] ?? capitalize(String(requestKind ?? ''));
  const station = stationImage
    ? `<img src="${escapeHtml(stationImage)}" alt="${escapeHtml(stationName ?? '')}">` : '';
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-requisition-card ${state}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">
            Requisitioned ${escapeHtml(kind)} from ${escapeHtml(factionName || 'a faction')}
          </span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-requisition-body">
        <div class="emblem-requisition-head">
          ${station}
          <div class="emblem-requisition-outcome ${state}">${success ? 'Granted!' : 'Declined'}</div>
        </div>
        <div class="emblem-requisition-roll ${state}">
          <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
            style="${avatarScaleStyle(avatarScale)}">
          <span>Civics vs DC ${escapeHtml(Number(dc) || 0)}</span>
          <strong>${escapeHtml(Number(total) || 0)}</strong>
        </div>
        <div class="emblem-requisition-demand${success ? '' : ' is-failure'}">
          ${escapeHtml(kind)}: <strong>${escapeHtml(Math.max(0, Math.floor(Number(demand) || 0)))} GP</strong>
          | ${escapeHtml(summary)}
        </div>
      </div>
    </div>`;
}

/**
 * The socialize card: both units' Sociability rolls, and the Support experience their sum banked. The speaker is the
 * acting unit, and the first total is its own roll.
 */
function renderSocialCard({
  actorName, actorImage, avatarScale, partnerName, partnerImage, partnerAvatarScale, firstTotal = 0,
  secondTotal = 0, supportGain = 0, supportRecipients = [], rankUps = []
}) {
  const first = Number(firstTotal) || 0;
  const second = Number(secondTotal) || 0;
  const gain = Number(supportGain) || 0;
  const rows = [
    socialRow(actorImage, avatarScale, actorName, `rolled <strong>${escapeHtml(first)}</strong>`),
    socialRow(partnerImage, partnerAvatarScale, partnerName, `rolled <strong>${escapeHtml(second)}</strong>`)
  ].join('');
  return socialCardShell({
    kind: 'emblem-social-card', actorName, actorImage, avatarScale,
    title: `Socialized with ${escapeHtml(partnerName ?? '')}`,
    body: `<div class="emblem-skill-verdict is-success">Camaraderie!</div>
        <div class="emblem-social-sub">
          ${escapeHtml(first)} + ${escapeHtml(second)} = ${escapeHtml(gain)} Support XP
        </div>
        ${socialSection('Rolls', rows)}
        ${socialSupport(gain, supportRecipients, rankUps)}`
  });
}

/**
 * The training card: the trainer's Command roll and both ranks, the proficiency experience the trainee took and a
 * rank it reached, the level experience both units earned from the spar, and the Support it built. The speaker is the
 * trainer.
 */
function renderTrainingCard({
  actorName, actorImage, avatarScale, traineeName, traineeImage, traineeAvatarScale, proficiencyLabel = '',
  proficiencyIcon = '', trainerRankLabel = '', traineeRankLabel = '', roll = 0, proficiencyExperience = 0,
  rankedUp = false, newRankLetter = null, trainerLevelExperience = 0, traineeLevelExperience = 0, supportGain = 0,
  supportRecipients = [], rankUps = []
}) {
  const label = escapeHtml(proficiencyLabel);
  const gained = Number(proficiencyExperience) || 0;
  const letter = newRankLetter ? ` ${escapeHtml(newRankLetter)}` : '';
  const ranked = rankedUp === true ? ` <span class="emblem-training-rankup">Rank Up!${letter}</span>` : '';
  const proficiency = gained > 0
    ? `<strong>+${escapeHtml(gained)} XP</strong>${ranked}`
    : '<span class="emblem-training-cap">at the cap, so no proficiency XP</span>';
  const icon = proficiencyIcon
    ? `<img class="emblem-skill-icon" src="${escapeHtml(proficiencyIconPath(proficiencyIcon))}" alt="${label}">` : '';
  const earned = amount => `<strong>+${escapeHtml(Number(amount) || 0)} XP</strong>`;
  const level = [
    socialRow(actorImage, avatarScale, actorName, earned(trainerLevelExperience)),
    socialRow(traineeImage, traineeAvatarScale, traineeName, earned(traineeLevelExperience))
  ].join('');
  const ranks = `${escapeHtml(trainerRankLabel)} → ${escapeHtml(traineeRankLabel)}`;
  return socialCardShell({
    kind: 'emblem-training-card', actorName, actorImage, avatarScale,
    title: `Trained ${escapeHtml(traineeName ?? '')} in ${label}`,
    body: `${icon}
        <div class="emblem-skill-verdict is-success">Training!</div>
        <div class="emblem-social-sub">Command ${escapeHtml(Number(roll) || 0)} | ${ranks}</div>
        ${socialSection(`${label} Proficiency`, socialRow(traineeImage, traineeAvatarScale, traineeName, proficiency))}
        ${socialSection('Level XP', level)}
        ${socialSupport(Number(supportGain) || 0, supportRecipients, rankUps)}`
  });
}

/** The skill card's frame the socialize and training cards share: the speaker's header, then the body lines. */
function socialCardShell({ kind, actorName, actorImage, avatarScale, title, body }) {
  return `
    <div class="emblem-roll-card emblem-skill-card ${kind}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || ACTOR_FALLBACK)}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">${title}</span>
        </div>
      </header>
      <div class="emblem-skill-body emblem-social-body">
        ${body}
      </div>
    </div>`;
}

function socialSection(title, content) {
  return `<div class="emblem-social-section">
          <div class="emblem-social-section-title">${title}</div>
          ${content}
        </div>`;
}

/** One unit's line on a socialize or training card; `value` is markup its caller has already escaped. */
function socialRow(image, avatarScale, name, value) {
  return `<div class="emblem-social-row">
            <img src="${escapeHtml(image || ACTOR_FALLBACK)}" alt="${escapeHtml(name ?? '')}"
              style="${avatarScaleStyle(avatarScale)}">
            <span class="emblem-social-row-name">${escapeHtml(name ?? '')}</span>
            <span class="emblem-social-row-value">${value}</span>
          </div>`;
}

/** The Support section: the bond's gain and one heart line per rank it reached, omitted when no bond grew. */
function socialSupport(gain, recipients = [], rankUps = []) {
  if (!Array.isArray(recipients) || !recipients.length) return '';
  const lines = (Array.isArray(rankUps) ? rankUps : [])
    .map(line => `<div class="emblem-social-ready"><i class="fas fa-heart"></i> ${escapeHtml(line)}</div>`).join('');
  return socialSection('Support', `<div class="emblem-social-support">+${escapeHtml(gain)} Support XP</div>
          ${lines}`);
}

/** A proficiency icon name from the PROFICIENCIES vocabulary, or a full path the beat already carried. */
function proficiencyIconPath(icon) {
  const value = String(icon);
  return value.includes('/') ? value : `${PROFICIENCY_ICON_PATH}/${value}.png`;
}

/* -------------------------------------------- */
/*  Card shell                                  */
/* -------------------------------------------- */

function renderRankCard({ actorName, actorImage, avatarScale, title, icon, track, verdict }) {
  const iconHtml = icon?.image
    ? `<img class="emblem-skill-icon" src="${escapeHtml(icon.image)}" alt="${escapeHtml(icon.alt ?? '')}">`
    : '';
  return `
    <div class="emblem-roll-card emblem-skill-card emblem-rank-card">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || 'icons/svg/mystery-man.svg')}" alt="${escapeHtml(actorName ?? '')}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName ?? '')}</span>
          <span class="emblem-skill-rollname">${title}</span>
        </div>
      </header>
      <div class="emblem-skill-body">
        ${iconHtml}
        <div class="emblem-rank-track">
          ${track}
        </div>
        <div class="emblem-skill-verdict is-rankup">${verdict}</div>
      </div>
    </div>`;
}
