/** @layer lib/dom */

/* -------------------------------------------- */
/*  Page visibility                             */
/* -------------------------------------------- */

/**
 * Whether this browser page is hidden. Presentation delivery, Sequencer effects, audio and the camera check it, so
 * a hidden client skips transient effects.
 * @returns {boolean}
 */
export function pageHidden() {
  return globalThis.document?.hidden === true;
}
