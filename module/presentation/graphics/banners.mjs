/** @layer presentation/graphics */
import { BANNER_VARIANTS } from '../../contracts/domains/combat.mjs';
import { DIAGNOSTIC_SOURCES, createDiagnostic } from '../../contracts/protocol.mjs';
import { SOUND_IDS } from '../audio/sound-database.mjs';
import { avatarScaleStyle } from '../../lib/dom/html.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Encounter banners                           */
/* -------------------------------------------- */

const BANNER_CLASS = 'emblem-phase-banner';
const BANNER_FADE_MS = 400;
const BANNER_HOLD_MS = 1400;
const WARNING_ID = 'emblem-round-warning';
const WARNING_THRESHOLD = 5;
const WARNING_SIDEBAR_GAP = 14;

/** The sound each banner variant plays. */
const BANNER_CUES = Object.freeze({
  [BANNER_VARIANTS.GENERIC]: SOUND_IDS.COMBAT_BEGIN,
  [BANNER_VARIANTS.PLAYER]: SOUND_IDS.COMBAT_PHASE_PLAYER,
  [BANNER_VARIANTS.ENEMY]: SOUND_IDS.COMBAT_PHASE_ENEMY,
  [BANNER_VARIANTS.EXPLORATION]: SOUND_IDS.COMBAT_EXPLORATION_BEGIN,
  [BANNER_VARIANTS.VICTORY]: SOUND_IDS.COMBAT_MAP_CLEARED,
  [BANNER_VARIANTS.DEFEAT]: SOUND_IDS.COMBAT_MAP_DEFEAT
});

/**
 * Announce a phase, a start, or a map's outcome across the whole screen. The presentation message handler in
 * init/system.mjs sends banner messages here.
 */
export class BannerPresentation {
  constructor({ audio = null } = {}) {
    this.audio = audio;
    this.element = null;
  }

  /** Draw one banner, replacing whichever is on screen. */
  show({ variant = BANNER_VARIANTS.GENERIC, text = '' } = {}) {
    const body = globalThis.document?.body;
    if (!body || pageHidden()) return false;
    this.#clear();
    const root = document.createElement('div');
    root.className = BANNER_CLASS;
    root.style.opacity = '0';
    root.innerHTML = '<div class="phase-banner-overlay is-top"></div>'
      + '<div class="phase-banner-overlay is-bottom"></div>'
      + `<div class="phase-banner-text is-${String(variant)}"></div>`;
    const label = root.querySelector('.phase-banner-text');
    if (label) label.textContent = String(text);
    body.appendChild(root);
    this.element = root;

    const cue = BANNER_CUES[String(variant)];
    if (cue) void this.audio?.play?.(cue, { channel: 'interface' });

    // Reading offsetHeight forces a layout, so the fade-in below starts from opacity 0.
    void root.offsetHeight;
    root.style.transition = `opacity ${BANNER_FADE_MS}ms ease-in-out`;
    root.style.opacity = '1';
    setTimeout(() => {
      root.style.opacity = '0';
      setTimeout(() => {
        if (this.element === root) this.element = null;
        root.remove();
      }, BANNER_FADE_MS);
    }, BANNER_FADE_MS + BANNER_HOLD_MS);
    return true;
  }

  #clear() {
    this.element?.remove();
    this.element = null;
  }
}

/* -------------------------------------------- */
/*  Round warning                               */
/* -------------------------------------------- */

/**
 * Count the map's remaining rounds down beside the sidebar.
 *
 * One element is reused for the life of the session rather than rebuilt per round, so the CSS
 * transition it carries is not restarted every time the text changes.
 */
export function refreshRoundWarning({ limit = 0, kind = null, round = 0, running = false } = {}) {
  if (!globalThis.document?.body) return false;
  if (!running || !limit || round < 1) return hideRoundWarning();
  const remaining = limit - round + 1;
  if (remaining < 1 || remaining > WARNING_THRESHOLD) return hideRoundWarning();

  const element = warningElement();
  element.textContent = remaining === 1 ? 'LAST ROUND!' : `${remaining} Rounds Remaining!`;
  element.classList.toggle('is-last', remaining === 1);
  element.classList.toggle('is-victory', kind === 'victory');
  element.classList.add('is-visible');
  anchorRoundWarning(element);
  return true;
}

/** Take the countdown down without destroying it. */
function hideRoundWarning() {
  globalThis.document?.getElementById(WARNING_ID)?.classList.remove('is-visible');
  return false;
}

/** Re-measure the countdown's position after a sidebar collapse or a window resize. */
export function anchorRoundWarning(element = globalThis.document?.getElementById(WARNING_ID)) {
  if (!element?.classList.contains('is-visible')) return;
  const rect = globalThis.document?.getElementById('sidebar')?.getBoundingClientRect();
  const right = rect && rect.width > 0
    ? Math.max(WARNING_SIDEBAR_GAP, window.innerWidth - rect.left + WARNING_SIDEBAR_GAP)
    : WARNING_SIDEBAR_GAP;
  element.style.right = `${Math.round(right)}px`;
}

function warningElement() {
  let element = document.getElementById(WARNING_ID);
  if (!element) {
    element = document.createElement('div');
    element.id = WARNING_ID;
    element.className = 'emblem-round-warning';
    document.body.appendChild(element);
  }
  return element;
}

/* -------------------------------------------- */
/*  Working banner                              */
/* -------------------------------------------- */
const BAND_OPENING = 'height 0.4s cubic-bezier(0, 0.4, 0.038, 1), background-color 0.6s ease-out';
const WORK_CLASS = 'emblem-work-banner';
const WORK_TIMING = Object.freeze({
  settleFrame: 50, colourShift: 80, overshoot: 250, settle: 200, reveal: 150,
  strikes: 4, strikeSpan: 3800, outcomeHold: 1700, outcomeFade: 300
});

/**
 * How long the work banner holds up the downtime flow while it opens and while it closes, from its own fixed
 * timings. downtimeBeatHoldMs in chat-cards.mjs reads it.
 */
export const WORK_BANNER_HOLD = Object.freeze({
  open: WORK_TIMING.settleFrame + WORK_TIMING.overshoot + WORK_TIMING.settle + WORK_TIMING.reveal,
  close: WORK_TIMING.outcomeHold + WORK_TIMING.outcomeFade
});
const WORK_SPARKS = 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/cantrips/mending_yellow_800x800.webm';
const WORK_SUCCESS_LOOP = 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/misc/repeating_spark_CIRCLE_01.webm';
const WORK_GLOW = 'drop-shadow(0 0 14px rgba(200, 162, 78, 0.7))';
const WORK_FLARE = 'drop-shadow(0 0 20px rgba(255, 200, 60, 0.95))';
const WORK_LIT = 'drop-shadow(0 0 30px rgba(255, 220, 80, 1)) drop-shadow(0 0 60px rgba(255, 180, 40, 0.6))';
const WORK_DIMMED = 'drop-shadow(0 0 24px rgba(255, 50, 50, 0.9)) drop-shadow(0 0 50px rgba(200, 30, 30, 0.5)) grayscale(1)';
const WORK_STRIKE = Object.freeze([
  { transform: 'translate(0, 0) rotate(0deg)' },
  { transform: 'translate(-3px, 2px) rotate(-1.5deg)' },
  { transform: 'translate(4px, -1px) rotate(2deg)' },
  { transform: 'translate(-2px, -2px) rotate(-1deg)' },
  { transform: 'translate(3px, 1px) rotate(1.5deg)' },
  { transform: 'translate(0, 0) rotate(0deg)' }
]);

/**
 * The banner that plays while a unit works a downtime station, opened and closed by DowntimePresentation
 * (chat-cards.mjs). It opens on an image of what is being made or taken, strikes in time with the station's
 * sounds, and closes lit for a success or dimmed for a failure.
 */
export class WorkBanner {
  constructor({ audio = null, diagnostics = null } = {}) {
    this.audio = audio;
    this.diagnostics = diagnostics;
    this.elements = null;
    this.working = null;
  }

  /**
   * Open the banner on an image and start its strikes. Resolves once the banner is up, while the strikes carry on
   * behind it. A variant with one continuous track plays it once as the banner opens and strikes in silence. A
   * `sustained` banner, which a performance with its own music opens, keeps striking until `finish` closes it.
   * `sparksFilter` is a CSS filter laid over the strike effect, for a variant that recolours it.
   */
  async show({
    image = '', beatSoundId = null, beatIndex = beat => beat % 2, openSoundId = null, sparks = WORK_SPARKS,
    flashColor = '#3a5a24', settleColor = '#13200e', sustained = false, sparksFilter = ''
  } = {}) {
    if (this.elements || !globalThis.document?.body || pageHidden()) return false;
    try {
      const elements = this.#create(image, sparks, sparksFilter);
      elements.sustained = sustained === true;
      if (openSoundId) void this.audio?.play?.(openSoundId, { channel: 'interface' });
      elements.container.style.backgroundColor = flashColor;
      elements.container.style.transition = BAND_OPENING;
      await imageSettled(elements.image);
      await raiseBand(elements.container, settleColor, WORK_TIMING);
      elements.imageContainer.style.opacity = '1';
      await wait(WORK_TIMING.reveal);
      this.working = this.#beats(elements, beatSoundId, beatIndex).catch(error => this.#record(error, 'beats'));
      return true;
    } catch (error) {
      this.#record(error, 'show');
      this.#teardown();
      return false;
    }
  }

  /**
   * Close the banner once its strikes are done, or at once for a sustained banner: lit and looping for a success,
   * dimmed and reddened for a failure. `sound: false` closes it without the outcome sound, for a performance whose
   * own track carries on. `trackStopped` marks a performance whose track was cut off: its icon turns grey in a dark
   * red glow (the `is-track-stopped` rule in styles/emblem-rpg.css) and leaves with the banner.
   */
  async finish({ success = true, sound = true, trackStopped = false } = {}) {
    const elements = this.elements;
    if (!elements) return false;
    if (pageHidden()) {
      this.#teardown();
      return true;
    }
    if (elements.sustained) elements.closing = true;
    else await this.working;
    if (this.elements !== elements) return false;
    if (sound) void this.audio?.play?.(success ? SOUND_IDS.UI_SUCCESS : SOUND_IDS.UI_FAILURE, { channel: 'interface' });
    const { image, successVideo, container } = elements;
    image.style.transition = 'filter 0.15s ease-out, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
    if (trackStopped && !success) {
      image.style.filter = '';
      image.classList.add('is-track-stopped');
    } else image.style.filter = success ? WORK_LIT : WORK_DIMMED;
    image.style.transform = success ? 'scale(1.15)' : 'scale(1.05)';
    if (success) {
      successVideo.currentTime = 0;
      successVideo.style.opacity = '1';
      successVideo.play?.()?.catch?.(() => {});
    }
    await wait(WORK_TIMING.outcomeHold);
    container.style.transition = 'opacity 0.3s ease-out';
    container.style.opacity = '0';
    successVideo.style.transition = 'opacity 0.3s ease-out';
    successVideo.style.opacity = '0';
    await wait(WORK_TIMING.outcomeFade);
    this.#teardown();
    return true;
  }

  /** Play the strikes: WORK_TIMING.strikes of them, or until `finish` marks a sustained banner closing. */
  async #beats(elements, beatSoundId, beatIndex) {
    const interval = WORK_TIMING.strikeSpan / WORK_TIMING.strikes;
    const beating = beat => (elements.sustained ? !elements.closing : beat < WORK_TIMING.strikes);
    for (let beat = 0; beating(beat); beat += 1) {
      if (this.elements !== elements) return;
      const started = performance.now();
      if (beatSoundId) void this.audio?.play?.(beatSoundId, { index: beatIndex(beat), channel: 'interface' });
      const sparks = elements.sparks;
      sparks.currentTime = 0;
      sparks.style.transition = 'none';
      sparks.style.opacity = '1';
      sparks.play?.()?.catch?.(() => {});
      elements.image.style.filter = WORK_FLARE;
      const strike = elements.imageContainer.animate?.(WORK_STRIKE, { duration: 160, easing: 'ease-in-out' });
      await strike?.finished?.catch?.(() => null);
      if (elements.closing) return;
      elements.image.style.filter = WORK_GLOW;
      sparks.style.transition = 'opacity 0.5s ease-out';
      sparks.style.opacity = '0';
      const remaining = interval - (performance.now() - started);
      if (remaining > 0 && (elements.sustained || beat < WORK_TIMING.strikes - 1)) await wait(remaining);
    }
  }

  #create(image, sparksSource, sparksFilter = '') {
    this.#teardown();
    const wrapper = document.createElement('div');
    wrapper.className = `${WORK_CLASS}-wrapper`;
    const container = document.createElement('div');
    container.className = `${WORK_CLASS}-container`;
    const sparks = document.createElement('video');
    sparks.className = `${WORK_CLASS}-sparks`;
    Object.assign(sparks, {
      src: String(sparksSource || WORK_SPARKS), autoplay: false, loop: false, muted: true, playsInline: true, preload: 'auto'
    });
    if (sparksFilter) sparks.style.filter = String(sparksFilter);
    const successVideo = document.createElement('video');
    successVideo.className = `${WORK_CLASS}-success`;
    Object.assign(successVideo, {
      src: WORK_SUCCESS_LOOP, autoplay: false, loop: true, muted: true, playsInline: true, preload: 'auto'
    });
    const imageContainer = document.createElement('div');
    imageContainer.className = `${WORK_CLASS}-image-container`;
    const picture = document.createElement('img');
    picture.className = `${WORK_CLASS}-image`;
    picture.src = String(image || 'icons/svg/item-bag.svg');
    imageContainer.append(picture);
    container.append(sparks, successVideo, imageContainer);
    wrapper.append(container);
    document.body.append(wrapper);
    sparks.load?.();
    successVideo.load?.();
    this.elements = { wrapper, container, imageContainer, image: picture, sparks, successVideo };
    return this.elements;
  }

  #teardown() {
    this.elements?.wrapper?.remove?.();
    this.elements = null;
    this.working = null;
  }

  #record(error, detail) {
    this.diagnostics?.record?.(createDiagnostic({
      sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.PRESENTATION, detail: `work-banner:${detail}`, error
    }));
  }
}

/* -------------------------------------------- */
/*  Conversation banner                         */
/* -------------------------------------------- */
const CONVERSATION_CLASS = 'emblem-conversation-banner';
const CONVERSATION_TIMING = Object.freeze({
  settleFrame: 50, colourShift: 80, overshoot: 250, settle: 200, reveal: 150,
  beats: 6, beatSpan: 3400, beatLength: 360, outcomeHold: 1700, outcomeFade: 300
});

/**
 * How long the conversation banner holds up the downtime flow while it opens and while it closes, from its own
 * fixed timings. downtimeBeatHoldMs in chat-cards.mjs reads it.
 */
export const CONVERSATION_BANNER_HOLD = Object.freeze({
  open: CONVERSATION_TIMING.settleFrame + CONVERSATION_TIMING.overshoot + CONVERSATION_TIMING.settle
    + CONVERSATION_TIMING.reveal,
  close: CONVERSATION_TIMING.outcomeHold + CONVERSATION_TIMING.outcomeFade
});
const CONVERSATION_COLOURS = Object.freeze({ flashColor: '#5a2438', settleColor: '#1a0e14' });
const CONVERSATION_BLIPS = Object.freeze([SOUND_IDS.UI_BLIP_2, SOUND_IDS.UI_BLIP_4]);
const CONVERSATION_BLIP_VOLUME = 0.3;
const CONVERSATION_REST = 'drop-shadow(0 0 12px rgba(0, 0, 0, 0.6))';
const CONVERSATION_SPEAKING = 'drop-shadow(0 0 18px rgba(255, 170, 200, 0.85))';
const CONVERSATION_BONDED = 'drop-shadow(0 0 26px rgba(255, 150, 190, 1)) '
  + 'drop-shadow(0 0 50px rgba(255, 110, 160, 0.5))';
const CONVERSATION_DIMMED = 'grayscale(1) brightness(0.6)';
const CONVERSATION_BOB = Object.freeze([
  { transform: 'translateY(0)' },
  { transform: 'translateY(-7px)' },
  { transform: 'translateY(0)' },
  { transform: 'translateY(-3px)' },
  { transform: 'translateY(0)' }
]);
const CONVERSATION_PULSE = Object.freeze([
  { transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }
]);
const CONVERSATION_HANDSHAKE = Object.freeze([
  { transform: 'scale(0.6)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1.1)' }
]);

/**
 * The inline style of one conversation portrait. All portrait art faces left, so the left speaker is mirrored to
 * face the right one. The mirror is put at the start of avatarScaleStyle's transform. The zoom's clip is symmetric,
 * so the mirror doesn't change it.
 * @param {number} avatarScale The unit's portrait zoom.
 * @param {{mirrored?: boolean}} [options] Whether this portrait sits on the left and turns to face right.
 * @returns {string}
 */
export function conversationPortraitStyle(avatarScale, { mirrored = false } = {}) {
  const style = avatarScaleStyle(avatarScale);
  return mirrored ? style.replace('transform: ', 'transform: scaleX(-1) ') : style;
}

/**
 * The banner that plays while two units socialize, opened by DowntimePresentation on the social-begin event. The
 * two portraits face each other and take turns speaking, and the social-end event closes it on a handshake for a
 * success or dimmed for a failure.
 */
export class ConversationBanner {
  constructor({ audio = null, diagnostics = null } = {}) {
    this.audio = audio;
    this.diagnostics = diagnostics;
    this.elements = null;
    this.talking = null;
  }

  /**
   * Open the banner on both speakers and start the conversation. Resolves once the banner is up, while the chatter
   * carries on behind it.
   * @param {{left?: object, right?: object}} speakers `{name, image, avatarScale}` for the acting unit on the left
   *   and the unit it visits on the right.
   * @returns {Promise<boolean>} Whether the banner opened.
   */
  async show({ left = {}, right = {} } = {}) {
    if (this.elements || !globalThis.document?.body || pageHidden()) return false;
    try {
      const elements = this.#create(left, right);
      elements.container.style.backgroundColor = CONVERSATION_COLOURS.flashColor;
      elements.container.style.transition = BAND_OPENING;
      await Promise.all([imageSettled(elements.leftImage), imageSettled(elements.rightImage)]);
      await raiseBand(elements.container, CONVERSATION_COLOURS.settleColor, CONVERSATION_TIMING);
      elements.stage.style.opacity = '1';
      await wait(CONVERSATION_TIMING.reveal);
      this.talking = this.#chatter(elements).catch(error => this.#record(error, 'chatter'));
      return true;
    } catch (error) {
      this.#record(error, 'show');
      this.#teardown();
      return false;
    }
  }

  /** Close the banner when the conversation ends: a handshake and both portraits lit, or both dimmed on a failure. */
  async finish({ success = true } = {}) {
    const elements = this.elements;
    if (!elements) return false;
    if (pageHidden()) {
      this.#teardown();
      return true;
    }
    await this.talking;
    if (this.elements !== elements) return false;
    const { left, right, icon, container } = elements;
    for (const frame of [left, right]) frame.style.transition = 'filter 0.2s ease-out';
    if (success) {
      void this.audio?.play?.(SOUND_IDS.UI_SUCCESS, { channel: 'interface' });
      icon.classList.remove('fa-comments');
      icon.classList.add('fa-handshake', 'is-success');
      icon.animate?.(CONVERSATION_HANDSHAKE, { duration: 450, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
      for (const frame of [left, right]) frame.style.filter = CONVERSATION_BONDED;
      await wait(CONVERSATION_TIMING.outcomeHold);
    } else {
      icon.classList.add('is-failure');
      for (const frame of [left, right]) frame.style.filter = CONVERSATION_DIMMED;
      await wait(CONVERSATION_TIMING.outcomeFade);
    }
    container.style.transition = 'opacity 0.3s ease-out';
    container.style.opacity = '0';
    await wait(CONVERSATION_TIMING.outcomeFade);
    this.#teardown();
    return true;
  }

  /** Six turns of speech, left then right: the speaker bobs and glows while the icon pulses and a blip plays. */
  async #chatter(elements) {
    const interval = CONVERSATION_TIMING.beatSpan / CONVERSATION_TIMING.beats;
    for (let beat = 0; beat < CONVERSATION_TIMING.beats; beat += 1) {
      if (this.elements !== elements) return;
      const started = performance.now();
      const speaker = beat % 2 === 0 ? elements.left : elements.right;
      void this.audio?.play?.(CONVERSATION_BLIPS[beat % 2], { volume: CONVERSATION_BLIP_VOLUME, channel: 'interface' });
      speaker.style.filter = CONVERSATION_SPEAKING;
      const timing = { duration: CONVERSATION_TIMING.beatLength, easing: 'ease-in-out' };
      const bob = speaker.animate?.(CONVERSATION_BOB, timing);
      const pulse = elements.icon.animate?.(CONVERSATION_PULSE, timing);
      await Promise.all([bob?.finished?.catch?.(() => null), pulse?.finished?.catch?.(() => null)]);
      speaker.style.filter = CONVERSATION_REST;
      const remaining = interval - (performance.now() - started);
      if (remaining > 0 && beat < CONVERSATION_TIMING.beats - 1) await wait(remaining);
    }
  }

  #create(leftSpeaker, rightSpeaker) {
    this.#teardown();
    const wrapper = document.createElement('div');
    wrapper.className = `${CONVERSATION_CLASS}-wrapper`;
    const container = document.createElement('div');
    container.className = `${CONVERSATION_CLASS}-container`;
    const stage = document.createElement('div');
    stage.className = `${CONVERSATION_CLASS}-stage`;
    const left = this.#portrait(leftSpeaker, 'is-left');
    const icon = document.createElement('i');
    icon.className = `fas fa-comments ${CONVERSATION_CLASS}-icon`;
    const right = this.#portrait(rightSpeaker, 'is-right');
    stage.append(left.frame, icon, right.frame);
    container.append(stage);
    wrapper.append(container);
    document.body.append(wrapper);
    this.elements = {
      wrapper, container, stage, icon,
      left: left.frame, right: right.frame, leftImage: left.image, rightImage: right.image
    };
    return this.elements;
  }

  /** One speaker: a frame that bobs and glows around a portrait that keeps its zoom, and its mirror on the left. */
  #portrait(speaker, side) {
    const frame = document.createElement('div');
    frame.className = `${CONVERSATION_CLASS}-portrait ${side}`;
    frame.style.filter = CONVERSATION_REST;
    const image = document.createElement('img');
    image.className = `${CONVERSATION_CLASS}-avatar`;
    image.src = String(speaker?.image || 'icons/svg/mystery-man.svg');
    image.alt = String(speaker?.name ?? '');
    image.style.cssText = conversationPortraitStyle(speaker?.avatarScale, { mirrored: side === 'is-left' });
    frame.append(image);
    return { frame, image };
  }

  #teardown() {
    this.elements?.wrapper?.remove?.();
    this.elements = null;
    this.talking = null;
  }

  #record(error, detail) {
    this.diagnostics?.record?.(createDiagnostic({
      sourcePath: import.meta.url, source: DIAGNOSTIC_SOURCES.PRESENTATION,
      detail: `conversation-banner:${detail}`, error
    }));
  }
}

/**
 * Snap a banner open from nothing: one frame to lay it out, an overshoot past 28% of the viewport while the flash
 * colour changes, then a drop back to that height. WorkBanner and ConversationBanner share it.
 */
async function raiseBand(container, settleColor, timing) {
  // Reading offsetHeight forces a layout, so the height transition starts from the closed banner.
  void container.offsetHeight;
  await wait(timing.settleFrame);
  const target = window.innerHeight * 0.28;
  container.style.transition = 'height 0.3s cubic-bezier(0.42, 0, 0.58, 1), background-color 0.6s ease-out';
  container.style.height = `${target * 1.25}px`;
  setTimeout(() => { container.style.backgroundColor = settleColor; }, timing.colourShift);
  await wait(timing.overshoot);
  container.style.transition = 'height 0.2s cubic-bezier(0.42, 0, 0.58, 1)';
  container.style.height = `${target}px`;
  await wait(timing.settle);
}

function imageSettled(image) {
  return new Promise(resolve => {
    if (image.complete) { resolve(); return; }
    image.onload = () => resolve();
    image.onerror = () => resolve();
  });
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
