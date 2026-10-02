/** @layer presentation/camera */

import { recordDiagnostic } from '../../contracts/protocol.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';
/* -------------------------------------------- */
/*  Combat cinematic                           */
/* -------------------------------------------- */

const LETTERBOX_ID = 'letterbox-container';
const DICE_CANVAS_ID = 'dice-box-canvas';
const FADE_SELECTORS = Object.freeze([
  '#interface', '#hud', '#bg3-hotbar', '#bg3-tooltip', '.emblem-token-tooltip', '#tooltip', '#notifications'
]);
const SCREEN_FRACTION_AT_1X = 2 / 3;

/** How long the letterbox takes to close, which the end of an exchange or activation holds the table for. */
export const CINEMATIC_CLOSE_MS = 800;

/** How long an open letterbox waits for its exchange's next beat before this client closes it by itself. */
const CINEMATIC_WATCHDOG_MS = 30000;

/** Calculate camera scale for combat framing using this client’s cinematic setting. */
function calculateCombatCinematicScale(width, height, viewportWidth, viewportHeight, zoom = 1.5) {
  const fitScale = Math.min(
    Math.max(1, Number(viewportWidth)) / Math.max(1, Number(width)),
    Math.max(1, Number(viewportHeight)) / Math.max(1, Number(height))
  );
  const selectedZoom = Number.isFinite(Number(zoom)) && Number(zoom) > 0 ? Number(zoom) : 1.5;
  const boundedZoom = Math.min(3, Math.max(0.5, selectedZoom));
  return Math.max(0.1, boundedZoom * SCREEN_FRACTION_AT_1X * fitScale);
}

/**
 * Runs this client's combat letterbox, camera framing and UI fade. CombatPresentation opens and closes the
 * letterbox, and the presentation message handler in init/system.mjs sends the phase camera messages here.
 *
 * While a letterbox, the enemy-phase overview or a framing pan is running, it holds the shared `CameraLease`, so the
 * walking-unit camera stays still. A letterbox holds it until `end` finishes closing it or `dispose` removes it, and
 * the overview until `endEnemyPhaseOverview`.
 */
export class CombatCinematicPresentation {
  constructor({ diagnostics = null, tokens, zoom = () => 1.5, phaseCamera = () => true, enemyPhaseZoom = () => 1,
    lease = null,
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancelSchedule = handle => clearTimeout(handle) }) {
    this.diagnostics = diagnostics;
    this.tokens = tokens;
    this.zoom = zoom;
    this.phaseCamera = phaseCamera;
    this.enemyPhaseZoom = enemyPhaseZoom;
    this.lease = lease;
    this.holds = new Map();
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.preZoom = null;
    this.prePhaseZoom = null;
    this.phaseOverviewScale = null;
    this.diceObserver = null;
    this.dicePreviousZ = null;
    this.watchdog = null;
    this.fadedElements = new Set();
  }

  /** Frame both combatants and open the ten-percent letterbox for an exchange. Skip hidden clients. */
  async start(message) {
    if (message.cinematic !== true || !globalThis.document?.body || pageHidden()) return false;
    const [source, target] = await Promise.all([
      this.tokens.placeable(message.sourceTokenUuid),
      this.tokens.placeable(message.targetTokenUuid)
    ]);
    if (!source || !target) return false;
    if (message.objectTarget === true) {
      const framing = this.#holdWhile(() => this.#frame([tokenBox(source), tokenBox(target)], { keepZoom: true }));
      void framing.catch((diagnosticError) => {
        recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'start' });
        return false;
      });
      return true;
    }
    return this.#open([tokenBox(source), tokenBox(target)]);
  }

  /**
   * Frame an activation, which may be aimed at units, at a square, or at nobody but its own caster.
   * @param {object} message The activation's lead-in message.
   * @returns {Promise<boolean>} Whether the letterbox was opened.
   */
  async startActivation(message) {
    if (message.cinematic !== true || !globalThis.document?.body || pageHidden()) return false;
    const source = await this.tokens.placeable(message.sourceTokenUuid);
    if (!source) return false;
    const target = await this.tokens.placeable(message.targetTokenUuids?.[0]);
    const boxes = [tokenBox(source)];
    if (target) boxes.push(tokenBox(target));
    else if (message.targetLocation) boxes.push(locationBox(source, message.targetLocation));
    return this.#open(boxes);
  }

  /**
   * Pan to the units starting a phase, or to this player's own units, keeping the current zoom. Players who turned
   * the phase camera off are not moved.
   * @param {object} message The phase camera message.
   * @returns {Promise<boolean>} Whether the camera moved.
   */
  async panPhase(message) {
    if (this.phaseCamera() === false || pageHidden()) return false;
    const placeables = message.focus === true
      ? (await this.tokens.phaseFocusPlaceables?.()) ?? []
      : (await Promise.all((message.tokenUuids ?? []).map(uuid => this.tokens.placeable(uuid)))).filter(Boolean);
    if (!placeables.length) return false;
    await this.#holdWhile(() => this.#frame(placeables.map(tokenBox), { keepZoom: true, duration: message.duration }));
    return true;
  }

  /**
   * Pull back to the enemy-phase overview by this client's configured factor, remembering where the zoom was.
   * The enemy-phase end message releases this camera hold. If it never arrives (the GM's client reloads during the
   * enemy phase), the walking-unit camera stays off until the next enemy-phase end, a scene change or `dispose`.
   */
  beginEnemyPhaseOverview(duration = 600) {
    if (this.phaseCamera() === false || pageHidden()) return false;
    const scale = canvas.stage?.scale?.x;
    if (!Number.isFinite(scale)) return false;
    this.prePhaseZoom ??= scale;
    this.phaseOverviewScale = Math.max(0.1, this.prePhaseZoom * enemyPhaseZoomFactor(this.enemyPhaseZoom()));
    this.#hold('overview');
    canvas.animatePan({ scale: this.phaseOverviewScale, duration });
    return true;
  }

  /** Drift to the unit about to act at the overview zoom. While a letterbox is up, it has the camera instead. */
  async focusEnemyPhaseUnit(tokenUuid, duration = 500) {
    if (this.phaseCamera() === false || this.phaseOverviewScale === null || pageHidden()) return false;
    if (globalThis.document?.getElementById?.(LETTERBOX_ID)) return false;
    const token = await this.tokens.placeable(tokenUuid);
    if (!token) return false;
    const grid = Number(canvas.grid?.size) || 100;
    const box = tokenBox(token);
    canvas.animatePan({
      x: box.x + (box.width * grid) / 2,
      y: box.y + (box.height * grid) / 2,
      scale: this.phaseOverviewScale,
      duration
    });
    return true;
  }

  /** Hand the zoom back once the enemy phase closes. A hidden page does it at once, without animating. */
  endEnemyPhaseOverview(duration = 600) {
    this.phaseOverviewScale = null;
    this.#letGo('overview');
    if (this.prePhaseZoom === null) return false;
    const scale = this.prePhaseZoom;
    this.prePhaseZoom = null;
    if (pageHidden()) this.#panInstantly(scale);
    else canvas.animatePan({ scale, duration });
    return true;
  }

  /** Keep an open letterbox alive while its exchange is still sending beats. */
  touch() {
    if (this.watchdog !== null) this.#armWatchdog();
  }

  /**
   * Put this client's view back at once: letterbox gone, interface restored, zoom returned, overview and camera lease
   * released.
   *
   * A canvas teardown, an end beat that reaches a hidden page, and an exchange whose end never arrives all come here,
   * so nothing a cinematic dimmed or disabled is left that way.
   * @returns {boolean}
   */
  dispose() {
    this.#clearWatchdog();
    globalThis.document?.getElementById?.(LETTERBOX_ID)?.remove?.();
    this.#restoreUiInstantly();
    const zoom = this.preZoom ?? this.prePhaseZoom;
    this.preZoom = null;
    this.prePhaseZoom = null;
    this.phaseOverviewScale = null;
    this.#panInstantly(zoom);
    this.#dropDice();
    for (const sequence of [...this.holds.keys()]) this.#letGo(sequence);
    return true;
  }

  #open(boxes) {
    this.preZoom ??= canvas.stage?.scale?.x ?? null;
    this.#hold('letterbox');
    this.#fadeUi(true, 700);
    this.#showLetterbox();
    this.#armWatchdog();
    void Promise.resolve(this.#frame(boxes)).catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'open' }); return false; });
    return true;
  }

  /**
   * Close the letterbox and restore the UI and zoom without moving the camera's center.
   *
   * A non-cinematic or object-target beat with no letterbox open has nothing to close. A hidden page closes at once
   * instead of animating. The letterbox's camera hold is released once the close has finished, unless a newer
   * letterbox has taken it in the meantime.
   */
  async end(message) {
    const hold = this.holds.get('letterbox');
    try {
      return await this.#close(message);
    } finally {
      this.#letGo('letterbox', hold);
    }
  }

  async #close(message) {
    const container = globalThis.document?.getElementById?.(LETTERBOX_ID) ?? null;
    if (!container && (message.objectTarget === true || message.cinematic !== true)) return true;
    this.#clearWatchdog();
    if (pageHidden()) return this.dispose();
    const duration = CINEMATIC_CLOSE_MS;
    this.#fadeUi(false, duration);
    const zoom = this.preZoom;
    this.preZoom = null;
    if (Number.isFinite(zoom)) canvas.animatePan({ scale: zoom, duration });
    const bars = [...(container?.querySelectorAll?.('.letterbox-bar') ?? [])];
    if (!container || bars.length !== 2) {
      container?.remove();
      this.#dropDice();
      return true;
    }
    const animations = bars.map(bar => bar.animate([
      { height: `${bar.getBoundingClientRect().height}px` }, { height: '0px' }
    ], { duration, easing: 'ease-in', fill: 'forwards' }).finished.catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'animations' }); return null; }));
    await Promise.all(animations);
    container.remove();
    this.#dropDice();
    return true;
  }

  #armWatchdog() {
    this.#clearWatchdog();
    this.watchdog = this.schedule(() => {
      this.watchdog = null;
      this.dispose();
    }, CINEMATIC_WATCHDOG_MS);
  }

  #clearWatchdog() {
    if (this.watchdog !== null) this.cancelSchedule(this.watchdog);
    this.watchdog = null;
  }

  /** Take the camera lease for a named sequence, replacing that sequence's earlier hold. */
  #hold(sequence) {
    const previous = this.holds.get(sequence);
    if (this.lease) this.holds.set(sequence, this.lease.acquire());
    previous?.();
  }

  /** Release a sequence's hold. `end` passes the hold it saw when it started, so a newer letterbox's hold is kept. */
  #letGo(sequence, hold = this.holds.get(sequence)) {
    if (this.holds.get(sequence) === hold) this.holds.delete(sequence);
    hold?.();
  }

  /** Hold the camera lease for the length of one framing pan that belongs to no letterbox or overview. */
  async #holdWhile(pan) {
    const release = this.lease?.acquire() ?? null;
    try {
      return await pan();
    } finally {
      release?.();
    }
  }

  /** Undo every fade this presenter applied, at once, without waiting for any animation to finish. */
  #restoreUiInstantly() {
    for (const element of this.fadedElements) {
      element._emblemCombatFade?.cancel?.();
      element._emblemCombatFade = null;
      element.style.opacity = '';
      element.style.pointerEvents = '';
    }
    this.fadedElements.clear();
  }

  #panInstantly(scale) {
    const canvas = globalThis.canvas;
    if (!Number.isFinite(scale) || !canvas.ready) return;
    try {
      canvas.pan({ scale });
    } catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'panInstantly' });
    }
  }

  #showLetterbox() {
    document.getElementById(LETTERBOX_ID)?.remove();
    const container = document.createElement('div');
    container.id = LETTERBOX_ID;
    container.innerHTML = '<div class="letterbox-bar letterbox-top"></div><div class="letterbox-bar letterbox-bottom"></div>';
    document.body.append(container);
    const height = window.innerHeight * 0.1;
    for (const bar of container.querySelectorAll('.letterbox-bar')) {
      bar.animate([{ height: '0px' }, { height: `${height}px` }], {
        duration: 1400,
        easing: 'ease-out',
        fill: 'forwards'
      });
    }
    this.#liftDice(container);
  }

  async #frame(inputBoxes, { keepZoom = false, duration = 1500 } = {}) {
    const grid = Number(canvas.grid?.size) || 100;
    const padding = grid * 2;
    let boxes = inputBoxes.map(box => [
      box.x - padding,
      box.y - padding,
      (box.width * grid) + (padding * 2),
      (box.height * grid) + (padding * 2)
    ]);
    if (boxes.length > 1) {
      const minY = Math.min(...boxes.map(box => box[1]));
      const maxY = Math.max(...boxes.map(box => box[1] + box[3]));
      const extra = ((maxY - minY) / 0.7) - (maxY - minY);
      boxes = boxes.map(box => [box[0], box[1] - (extra / 2), box[2], box[3] + extra]);
    }
    const minX = Math.min(...boxes.map(box => box[0]));
    const maxX = Math.max(...boxes.map(box => box[0] + box[2]));
    const top = Math.min(...boxes.map(box => box[1]));
    const bottom = Math.max(...boxes.map(box => box[1] + box[3]));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, bottom - top);
    const scale = keepZoom
      ? (canvas.stage?.scale?.x ?? undefined)
      : calculateCombatCinematicScale(width, height, window.innerWidth, window.innerHeight, this.zoom());
    return canvas.animatePan({
      x: minX + (width / 2),
      y: top + (height / 2),
      scale,
      duration
    });
  }

  #fadeUi(hide, duration) {
    const elements = new Set();
    for (const selector of FADE_SELECTORS) document.querySelectorAll(selector).forEach(element => elements.add(element));
    for (const element of elements) {
      const start = Number(getComputedStyle(element).opacity);
      element._emblemCombatFade?.cancel?.();
      element.style.pointerEvents = hide ? 'none' : '';
      if (hide) this.fadedElements.add(element);
      else this.fadedElements.delete(element);
      const animation = element.animate([
        { opacity: Number.isFinite(start) ? start : hide ? 1 : 0 }, { opacity: hide ? 0 : 1 }
      ], { duration, easing: 'ease', fill: 'forwards' });
      element._emblemCombatFade = animation;
      if (!hide) animation.finished.then(() => {
        if (element._emblemCombatFade !== animation) return;
        animation.cancel();
        element.style.opacity = '';
        element.style.pointerEvents = '';
        element._emblemCombatFade = null;
      }).catch((diagnosticError) => { recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'fadeUi' }); });
    }
  }

  #liftDice(container) {
    const dice = document.getElementById(DICE_CANVAS_ID);
    if (!dice) return;
    if (!this.diceObserver) this.dicePreviousZ = dice.style.zIndex;
    else this.diceObserver.disconnect();
    const apply = () => { if (Number(dice.style.zIndex) < 1001) dice.style.zIndex = '1001'; };
    apply();
    this.diceObserver = new MutationObserver(apply);
    this.diceObserver.observe(dice, { attributes: true, attributeFilter: ['style'] });
  }

  #dropDice() {
    this.diceObserver?.disconnect();
    this.diceObserver = null;
    const dice = document.getElementById(DICE_CANVAS_ID);
    if (dice) dice.style.zIndex = this.dicePreviousZ ?? '';
    this.dicePreviousZ = null;
  }
}

function enemyPhaseZoomFactor(value) {
  const factor = Number(value);
  return Number.isFinite(factor) && factor > 0 ? factor : 0.6;
}

function tokenBox(token) {
  return {
    x: Number(token.document?.x) || 0,
    y: Number(token.document?.y) || 0,
    width: Number(token.document?.width) || 1,
    height: Number(token.document?.height) || 1
  };
}

function locationBox(source, cell) {
  const grid = Number(canvas.grid?.size) || 100;
  return {
    x: (Number(cell.x) || 0) * grid,
    y: (Number(cell.y) || 0) * grid,
    width: Number(source.document?.width) || 1,
    height: Number(source.document?.height) || 1
  };
}
