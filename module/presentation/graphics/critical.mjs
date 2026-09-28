/** @layer presentation/graphics */
import { clamp } from '../../lib/core/runtime.mjs';
import { recordDiagnostic } from '../../contracts/protocol.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Critical flourish                          */
/* -------------------------------------------- */

/** The critical banner's steps in milliseconds: it settles, rises, drops, shakes, then closes. */
const CRITICAL_BANNER_TIMING = Object.freeze({ settle: 50, rise: 210, drop: 240, shake: 1400, close: 500 });

/** How long one critical banner holds the screen, from its first frame to the end of its close. */
export const CRITICAL_BANNER_MS = CRITICAL_BANNER_TIMING.settle + CRITICAL_BANNER_TIMING.rise
  + CRITICAL_BANNER_TIMING.shake + CRITICAL_BANNER_TIMING.close;

/**
 * The full-screen critical-hit banner with the attacker's portrait. CombatPresentation shows it when a unit with a
 * voice lands a critical hit.
 */
export class CriticalPresentation {
  constructor({ diagnostics = null, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    this.diagnostics = diagnostics;
    this.wait = wait;
    this.active = false;
    this.wrapper = null;
  }

  /**
   * Play one critical banner, unless one is already showing.
   *
   * Its steps are paced by fixed waits, never by the banner's own animations, so it ends on schedule on every
   * client. A hidden page skips it.
   */
  async show({ actorImage, avatarScale = 1.25, factionColor = '#9f7dc5' } = {}) {
    if (this.active || !globalThis.document?.body || pageHidden()) return false;
    this.active = true;
    try {
      const elements = this.#create();
      elements.container.style.backgroundColor = '#ffffff';
      elements.image.src = String(actorImage || 'icons/svg/mystery-man.svg');
      elements.image.style.transform = `scaleX(-1) scale(${clamp(avatarScale, 0.5, 3)})`;
      await imageReady(elements.image);
      if (elements.image.naturalWidth > 0) {
        const ratio = window.innerWidth / elements.image.naturalWidth;
        elements.image.style.width = `${ratio * elements.image.naturalWidth * 0.255}px`;
        elements.image.style.height = `${ratio * elements.image.naturalHeight * 0.255}px`;
      }
      void elements.container.offsetHeight;
      await this.wait(CRITICAL_BANNER_TIMING.settle);
      this.#animatePortrait(elements.imageWrapper);
      const target = window.innerHeight * 0.35;
      elements.container.style.transition = 'height 0.32s cubic-bezier(0.42, 0, 0.58, 1), background-color 0.8s ease-out';
      elements.container.style.height = `${target * 1.33}px`;
      setTimeout(() => { elements.container.style.backgroundColor = String(factionColor || '#9f7dc5'); }, 100);
      await this.wait(CRITICAL_BANNER_TIMING.rise);
      elements.container.style.height = `${target * 0.75}px`;
      void elements.container.animate([
        { transform: 'translateY(0)' }, { transform: 'translateY(3px)' },
        { transform: 'translateY(-3px)' }, { transform: 'translate(0, 0)' }
      ], { duration: CRITICAL_BANNER_TIMING.shake, easing: 'ease-in-out' }).finished.catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'shake' }); return null; });
      await this.wait(CRITICAL_BANNER_TIMING.drop);
      elements.container.style.transition = 'height 0.22s cubic-bezier(0.42, 0, 0.58, 1), background-color 0.2s ease-out';
      elements.container.style.height = `${target}px`;
      await this.wait(CRITICAL_BANNER_TIMING.shake - CRITICAL_BANNER_TIMING.drop);
      elements.container.style.transition = 'height 0.5s ease-out, opacity 0.75s ease-out';
      elements.container.style.height = '0';
      elements.container.style.opacity = '0';
      await this.wait(CRITICAL_BANNER_TIMING.close);
      return true;
    } finally {
      this.wrapper?.remove();
      this.wrapper = null;
      this.active = false;
    }
  }

  #create() {
    this.wrapper?.remove();
    const wrapper = document.createElement('div');
    wrapper.className = 'emblem-crit-wrapper';
    const container = document.createElement('div');
    container.className = 'emblem-crit-container';
    const video = document.createElement('video');
    video.className = 'emblem-crit-electricity';
    video.src = 'modules/animated-spell-effects-cartoon/spell-effects/cartoon/electricity/electricity_24_800x800.webm';
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    const imageWrapper = document.createElement('div');
    imageWrapper.className = 'emblem-crit-img-wrapper';
    const imageContainer = document.createElement('div');
    imageContainer.className = 'emblem-crit-img-container';
    const image = document.createElement('img');
    image.className = 'emblem-crit-img';
    imageContainer.append(image);
    imageWrapper.append(imageContainer);
    container.append(video, imageWrapper);
    wrapper.append(container);
    document.body.append(wrapper);
    this.wrapper = wrapper;
    return { container, imageWrapper, image };
  }

  #animatePortrait(element) {
    const duration = 1280;
    const points = Array.from({ length: 101 }, (_unused, index) => {
      const progress = index / 100;
      const angle = progress * Math.PI * 2.5;
      const radius = 6 * Math.max(0.1, 1 - (progress * 0.8));
      return {
        top: `${40 + (Math.sin(angle) * radius)}%`,
        left: `${39 + (Math.cos(angle) * radius)}%`,
        transform: `translate(-50%, -50%) scale(${1.15 - (Math.min(0.8, progress) * 0.15)})`,
        offset: progress
      };
    });
    element.animate(points, { duration, easing: 'linear', fill: 'forwards' });
  }
}

/* -------------------------------------------- */
/*  Presentation helpers                       */
/* -------------------------------------------- */

function imageReady(image) {
  return new Promise(resolve => {
    if (image.complete) { resolve(); return; }
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', resolve, { once: true });
  });
}
