/** @layer presentation/canvas */
import { THREAT_TIERS } from '../../contracts/domains/combat.mjs';
import { movementOverlayLayer } from './cell-overlays.mjs';
import { recordDiagnostic } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Appearance                                  */
/* -------------------------------------------- */
const LAYER_NAME = 'threatLayer';
const CORE_ALPHA = 0.5;
const GLOW_LAYERS = Object.freeze([
  Object.freeze({ scale: 7, alpha: 0.2 }),
  Object.freeze({ scale: 4.5, alpha: 0.28 }),
  Object.freeze({ scale: 2.4, alpha: 0.4 })
]);
const TIER_STYLE = Object.freeze({
  [THREAT_TIERS.INERT]: Object.freeze({ color: 0xE0DFD7, width: 2, alpha: 0.66, glow: false }),
  [THREAT_TIERS.MINOR]: Object.freeze({ color: 0xBD3619, width: 1, alpha: 0.5, glow: true }),
  [THREAT_TIERS.SEVERE]: Object.freeze({ color: 0xFF0000, width: 2, alpha: 0.75, glow: true }),
  [THREAT_TIERS.LETHAL]: Object.freeze({ color: 0xFF0000, width: 5, alpha: 1, glow: true })
});
const DEFAULT_TIER = THREAT_TIERS.SEVERE;

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */
const PULSE_PERIOD_MS = 1400;
const PULSE_MIN = 0.5;
const PULSE_MAX = 1;
const FADE_IN_MS = 260;
const FADE_OUT_MS = 220;
const DRAW_MS = 600;
const ALPHA_EPSILON = 0.004;
const SETTLE_QUIET_MS = 220;
const BUILD_BUDGET_MIN_MS = 2;
const BUILD_BUDGET_MAX_MS = 8;
const BUILD_BUDGET_FRACTION = 0.4;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function styleFor(tier) {
  return TIER_STYLE[tier] ?? TIER_STYLE[DEFAULT_TIER];
}

/* -------------------------------------------- */
/*  Threat lines                                */
/* -------------------------------------------- */
/**
 * The threat lines. With one of the player's units selected in an encounter, a line runs to it from each hostile
 * that could reach it, coloured by how hard that hostile would hit (graded by engine/combat/threat.mjs). With a
 * hostile selected and an intent provider set, one line shows the unit it plans to attack instead.
 *
 * Nothing is measured until the board has been quiet for SETTLE_QUIET_MS, so a burst of writes causes one rebuild.
 * Reach is then measured in small slices per frame, and one line is graded per frame.
 */
export class ThreatIndicators {
  #assess;
  #isBusy;
  #actionWindowOpen;
  #encounterActive;
  #now;
  #ticker;
  #tokens;
  #layer;
  #glow = null;
  #core = null;
  #phase = 0;
  #selected = null;
  #viewOnly = false;
  #running = false;
  #threats = [];
  #building = null;
  #anchor = null;
  #cellX = null;
  #cellY = null;
  #prefilter = null;
  #dirty = false;
  #regrade = false;
  #reprocessing = false;
  #assessDeferred = false;
  #windowWasOpen = false;
  #invalidatedAt = 0;
  #liveHostiles = new Set();
  #compulsionSources = new Set();
  #drawnCount = -1;
  #drawnAnchorX = null;
  #drawnAnchorY = null;
  #focus = null;
  #playerSelected = true;
  #intentProvider = null;
  #intentFor = null;
  #intentRequest = null;

  /**
   * Takes the threat assessment, the checks for a busy board, an open action window and a running encounter, and
   * the clock, ticker, token layer and drawing layer to use.
   */
  constructor({ diagnostics = null,
    assess,
    isBusy = () => false,
    actionWindowOpen = () => false,
    encounterActive = () => game.combat?.started === true,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    ticker = () => canvas.app?.ticker ?? null,
    tokens = () => canvas.tokens ?? null,
    layer = () => movementOverlayLayer(LAYER_NAME)
  }) {
    this.diagnostics = diagnostics;
    this.#assess = assess;
    this.#isBusy = isBusy;
    this.#actionWindowOpen = actionWindowOpen;
    this.#encounterActive = encounterActive;
    this.#now = now;
    this.#ticker = ticker;
    this.#tokens = tokens;
    this.#layer = layer;
    this.tick = this.tick.bind(this);
  }

  /** Follow the canvas selection: show lines while exactly one unit is controlled, and let them fade otherwise. */
  syncSelection() {
    if (!this.#encounterActive()) {
      if (this.#running) this.release();
      return false;
    }
    const controlled = (this.#tokens()?.controlled ?? []).filter(token => token.actor);
    if (controlled.length === 1) return this.#start(controlled[0]);
    if (this.#running && !this.#viewOnly) this.release();
    return false;
  }

  /** Show the lines for a unit a player inspects rather than controls. Null ends a view-only display. */
  syncInspect(token) {
    if (token?.actor) return this.#start(token, { viewOnly: true });
    if (this.#viewOnly) this.release();
    return false;
  }

  /**
   * Set the planner that works out what a selected hostile intends, or null to remove the intent line. The Enemy AI
   * registers one through api.presentation.threat.registerIntentProvider.
   * The provider is called as `provider(tokenUuid, {signal})`. Its plan may take seconds, so it should work between
   * frames and stop once the signal aborts, which happens whenever the answer is no longer wanted.
   * @param {?function(string, {signal: AbortSignal}): (object|Promise<object|null>|null)} provider
   *   Returns `{targetTokenUuid, tier}`.
   * @returns {boolean} Whether a provider is now set.
   */
  setIntentProvider(provider) {
    this.#intentProvider = typeof provider === 'function' ? provider : null;
    this.#abandonIntent();
    this.#intentFor = null;
    this.invalidate();
    return this.#intentProvider !== null;
  }

  /**
   * The board changed (a token moved, appeared or fell, for example): measure reach again once it settles. Grades
   * are kept, and the lines stay up while the set of threatening hostiles is rechecked, so they don't flicker.
   */
  invalidate() {
    this.#dirty = true;
    this.#invalidatedAt = this.#now();
  }

  /**
   * The matchups changed (reach stats, items, the selected unit's HP, or an action on the board), so every grade is
   * stale. The lines fade out while reach and grades are recomputed, instead of changing colour one by one.
   */
  invalidateGrades() {
    this.#regrade = true;
    this.#reprocessing = true;
    this.invalidate();
  }

  /** Only the grades changed (an aura or stance moved), so the lines stay up and recolour as each is graded again. */
  invalidateColours() {
    this.#regrade = true;
    this.#invalidatedAt = this.#now();
  }

  running() { return this.#running; }
  selectedActorUuid() { return String(this.#selected?.actor?.uuid ?? ''); }
  selectedTokenId() { return String(this.#selected?.id ?? ''); }
  selectedFaction() { return String(this.#selected?.actor?.system?.faction?.role ?? ''); }
  hostileWasAlive(actorUuid) { return this.#liveHostiles.has(String(actorUuid ?? '')); }
  tracksCompulsion(actorUuid) { return this.#compulsionSources.has(String(actorUuid ?? '')); }

  /** Let the lines fade: the selection is dropped but the anchors stay until every line has gone. */
  release() {
    this.#selected = null;
    this.#viewOnly = false;
    this.#building = null;
    this.#abandonIntent();
  }

  /** Drop the ticker and the graphics outright, when a canvas is drawn or nothing is left to show. */
  stop() {
    if (this.#running) {
      this.#ticker()?.remove?.(this.tick);
      this.#running = false;
    }
    if (this.#glow && !this.#glow.destroyed) this.#glow.destroy();
    if (this.#core && !this.#core.destroyed) this.#core.destroy();
    this.#glow = null;
    this.#core = null;
    this.#phase = 0;
    this.#threats = [];
    this.#building = null;
    this.#selected = null;
    this.#viewOnly = false;
    this.#anchor = null;
    this.#cellX = null;
    this.#cellY = null;
    this.#prefilter = null;
    this.#dirty = false;
    this.#regrade = false;
    this.#reprocessing = false;
    this.#assessDeferred = false;
    this.#windowWasOpen = false;
    this.#invalidatedAt = 0;
    this.#drawnCount = -1;
    this.#drawnAnchorX = null;
    this.#drawnAnchorY = null;
    this.#focus = null;
    this.#playerSelected = true;
    this.#abandonIntent();
    this.#intentFor = null;
    this.#liveHostiles.clear();
    this.#compulsionSources.clear();
  }

  /**
   * A ticker callback may not throw: an exception there stops Foundry's canvas ticker for every other listener.
   * On an error, log it and take the lines down until a unit is selected again.
   */
  tick(frame) {
    try {
      this.#frame(frame);
    } catch (error) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: 'tick' });
      this.stop();
    }
  }

  /** One animation frame: settle the board if it is quiet, advance every line, redraw what changed. */
  #frame(frame) {
    if (!this.#glow || this.#glow.destroyed || !this.#core || this.#core.destroyed) return this.stop();
    const active = Boolean(this.#selected) && !this.#selected.destroyed && this.#encounterActive()
      && (this.#viewOnly || this.#selected.controlled === true);
    const delta = Number(frame?.deltaMS ?? this.#ticker()?.deltaMS) || (1000 / 60);
    if (active) this.#settle(delta);
    this.#phase = (this.#phase + delta) % PULSE_PERIOD_MS;
    const wave = 0.5 + 0.5 * Math.sin((this.#phase / PULSE_PERIOD_MS) * Math.PI * 2);
    this.#glow.alpha = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * wave;
    const { changed, visible } = this.#advance(active, delta);
    if (changed) this.#redraw(visible);
    if (!active && !visible) this.stop();
  }

  /** A plain copy of the internal state. Only tests read it. */
  inspectState() {
    return {
      running: this.#running, viewOnly: this.#viewOnly, dirty: this.#dirty, regrade: this.#regrade,
      reprocessing: this.#reprocessing, building: this.#building !== null, drawnCount: this.#drawnCount,
      threats: this.#threats.map(threat => ({
        tokenId: threat.tokenId, tier: threat.tier, graded: threat.graded, threatening: threat.threatening,
        alpha: threat.alpha, grow: threat.grow, visible: threat.visible === true
      }))
    };
  }

  #start(token, { viewOnly = false } = {}) {
    if (!this.#encounterActive()) return false;
    if (token?.actor?.type !== 'Character') {
      if (this.#running) this.release();
      return false;
    }
    this.#viewOnly = viewOnly;
    if (this.#selected === token && this.#running) {
      this.#dirty = true;
      return true;
    }
    const parent = this.#layer();
    if (!parent || !globalThis.PIXI) return false;
    if (!this.#glow || this.#glow.destroyed) {
      this.#glow = new PIXI.Graphics();
      this.#glow.eventMode = 'none';
      this.#glow.blendMode = PIXI.BLEND_MODES.ADD;
    }
    if (!this.#core || this.#core.destroyed) {
      this.#core = new PIXI.Graphics();
      this.#core.eventMode = 'none';
    }
    if (this.#glow.parent !== parent) parent.addChild(this.#glow);
    if (this.#core.parent !== parent) parent.addChild(this.#core);
    this.#selected = token;
    this.#cellX = null;
    this.#cellY = null;
    this.#dirty = false;
    this.#drawnCount = -1;
    this.#drawnAnchorX = null;
    this.#drawnAnchorY = null;
    this.#regrade = true;
    this.#reprocessing = true;
    this.#abandonIntent();
    this.#intentFor = null;
    this.#invalidatedAt = this.#now();
    this.#focus = token;
    this.#anchor = { x: token.center.x, y: token.center.y };
    if (!this.#openBuild({ keepAnimation: false })) this.#land([], { keepAnimation: false });
    if (!this.#playerSelected) {
      this.#focus = null;
      this.#anchor = null;
      this.#threats = [];
    }
    if (!this.#running) {
      this.#running = true;
      this.#ticker()?.add?.(this.tick);
    }
    return true;
  }

  #selectedUuid() {
    return this.#selected?.document?.uuid ?? this.#selected?.uuid ?? '';
  }

  /**
   * Start measuring hostiles for the selected unit. Returns false when there is nothing to measure, so the caller
   * can land an empty result at once.
   */
  #openBuild({ keepAnimation }) {
    const inspection = this.#assess.beginInspection(this.#selectedUuid());
    this.#liveHostiles = new Set(inspection?.liveHostiles ?? []);
    this.#compulsionSources = new Set(inspection?.compulsionSources ?? []);
    this.#prefilter = inspection?.prefilter ?? null;
    this.#playerSelected = inspection?.selected?.playerUnit === true;
    this.#building = inspection && this.#playerSelected
      ? { inspection, keepAnimation, regrade: this.#regrade }
      : null;
    return this.#building !== null;
  }

  /** Measure hostiles until this frame's time budget runs out. Returns true once all are measured and landed. */
  #advanceBuild(budget) {
    const building = this.#building;
    const deadline = this.#now() + budget;
    if (!building.inspection.advance(() => this.#now() >= deadline)) return false;
    this.#building = null;
    this.#regrade = this.#regrade || building.regrade;
    this.#land(this.#threatsOf(building.inspection), { keepAnimation: building.keepAnimation });
    return true;
  }

  #land(next, { keepAnimation }) {
    this.#threats = this.#merge(next, { keepAnimation });
    this.#regrade = false;
    this.#cellX = null;
    this.#cellY = null;
  }

  #threatsOf(inspection) {
    const threats = [];
    for (const threat of inspection.threats()) {
      const token = this.#tokens()?.get?.(threat.tokenId) ?? null;
      if (!token) continue;
      threats.push({
        token, tokenId: threat.tokenId, tokenUuid: threat.tokenUuid, actorUuid: threat.actorUuid,
        reach: threat.reach, occluded: threat.occluded,
        alpha: 0, grow: 0, threatening: false,
        tier: threat.tier ?? DEFAULT_TIER, graded: false,
        anchor: { x: token.center?.x ?? 0, y: token.center?.y ?? 0 }
      });
    }
    return threats;
  }

  #buildBudget(delta) {
    return Math.min(BUILD_BUDGET_MAX_MS, Math.max(BUILD_BUDGET_MIN_MS, delta * BUILD_BUDGET_FRACTION));
  }

  #merge(next, { keepAnimation = true } = {}) {
    const byId = new Map(next.map(threat => [threat.tokenId, threat]));
    for (const old of this.#threats) {
      const match = byId.get(old.tokenId);
      if (match) {
        if (keepAnimation) {
          match.alpha = old.alpha;
          match.grow = old.grow;
        }
        match.threatening = old.threatening;
        if (old.graded) match.tier = old.tier;
        if (!this.#regrade && old.graded) match.graded = true;
      } else if (old.alpha > ALPHA_EPSILON) {
        old.threatening = false;
        old.reach = new Set();
        next.push(old);
      }
    }
    return next;
  }

  #refreshMembership() {
    const focus = this.#selected;
    if (!focus || this.#intentMode()) return;
    const gridSize = Number(canvas.grid?.size) || 1;
    const gridX = Math.round(focus.x / gridSize);
    const gridY = Math.round(focus.y / gridSize);
    if (gridX === this.#cellX && gridY === this.#cellY) return;
    this.#cellX = gridX;
    this.#cellY = gridY;
    const cell = {
      x: gridX, y: gridY,
      width: Number(focus.document?.width) || 1, height: Number(focus.document?.height) || 1,
      airborne: focus.actor?.system?.statuses?.airborne === true
    };
    if (this.#assess.leftEnvelope(this.#prefilter, cell)) this.#dirty = true;
    for (const threat of this.#threats) threat.threatening = this.#assess.covers(threat, cell);
  }

  #gradeOne() {
    if (this.#isBusy()) {
      this.#assessDeferred = true;
      return;
    }
    const threat = this.#threats.find(entry => !entry.graded && entry.threatening
      && entry.token && !entry.token.destroyed);
    if (!threat) return;
    threat.graded = true;
    const verdict = this.#assess.grade(threat.tokenUuid, this.#selectedUuid());
    threat.tier = verdict?.tier ?? DEFAULT_TIER;
  }

  #settle(delta) {
    const actionWindow = this.#actionWindowOpen();
    if (this.#isBusy() || (this.#windowWasOpen && !actionWindow)) this.invalidateGrades();
    this.#windowWasOpen = actionWindow;
    if (this.#assessDeferred && !this.#isBusy()) {
      this.#assessDeferred = false;
      this.#regrade = true;
      this.#reprocessing = true;
      this.#dirty = true;
    }
    const quiet = !this.#isBusy() && (this.#now() - this.#invalidatedAt) >= SETTLE_QUIET_MS;
    if (this.#intentMode()) this.#settleIntent(quiet);
    else this.#settleIncoming(quiet, this.#buildBudget(delta));
    if (this.#reprocessing && quiet && !this.#dirty && !this.#intentRequest && !this.#building
      && !this.#threats.some(threat => threat.threatening && !threat.graded)) {
      this.#reprocessing = false;
    }
    if (this.#focus && !this.#focus.destroyed) {
      this.#anchor ??= { x: 0, y: 0 };
      this.#anchor.x = this.#focus.center.x;
      this.#anchor.y = this.#focus.center.y;
    }
  }

  #settleIncoming(quiet, budget) {
    if (this.#dirty) {
      this.#building = null;
      if (quiet) {
        this.#dirty = false;
        if (!this.#openBuild({ keepAnimation: true })) this.#land([], { keepAnimation: true });
      }
    }
    const landed = this.#building ? this.#advanceBuild(budget) : false;
    if (!this.#building && !landed && this.#regrade && quiet) {
      this.#regrade = false;
      for (const threat of this.#threats) threat.graded = false;
    }
    this.#refreshMembership();
    if (quiet && !this.#actionWindowOpen() && !this.#building && !landed) this.#gradeOne();
  }

  #settleIntent(quiet) {
    if (!quiet || this.#actionWindowOpen()) return;
    if (this.#dirty || this.#regrade) {
      this.#abandonIntent();
      this.#intentFor = null;
    }
    this.#dirty = false;
    this.#regrade = false;
    this.#resolveIntent(this.#selectedUuid());
  }

  #intentMode() {
    return this.#intentProvider !== null && this.#playerSelected === false;
  }

  /** Abort the provider's current request, so it stops planning an answer nobody will use. */
  #abandonIntent() {
    this.#intentRequest?.abort();
    this.#intentRequest = null;
  }

  /**
   * Ask the provider what the selected hostile intends, once per selection and again each time the board settles
   * after a change. A newer question aborts the one in flight instead of queueing behind it, and only the answer to
   * the current request is drawn.
   */
  #resolveIntent(selectedUuid) {
    if (this.#isBusy() || !selectedUuid) return;
    if (this.#intentFor === selectedUuid) return;
    this.#abandonIntent();
    this.#intentFor = selectedUuid;
    const request = new AbortController();
    this.#intentRequest = request;
    const enemy = this.#selected;
    new Promise(resolve => resolve(this.#intentProvider(selectedUuid, { signal: request.signal })))
      .then(intent => {
        if (this.#intentRequest !== request) return;
        if (this.#selectedUuid() !== selectedUuid || !this.#intentMode()) return;
        this.#applyIntent(enemy, intent);
      })
      .catch(diagnosticError => {
        recordDiagnostic(this.diagnostics, {
          sourcePath: import.meta.url, error: diagnosticError, detail: 'resolveIntent'
        });
        if (this.#intentRequest !== request) return;
        this.#focus = null;
        this.#threats = [];
      })
      .finally(() => { if (this.#intentRequest === request) this.#intentRequest = null; });
  }

  #applyIntent(enemy, intent) {
    const victim = this.#tokenByUuid(intent?.targetTokenUuid);
    if (!victim || !enemy || enemy.destroyed) {
      this.#focus = null;
      this.#threats = [];
      return;
    }
    const previous = this.#threats[0];
    const unchanged = previous?.token === enemy && this.#focus === victim;
    this.#focus = victim;
    this.#threats = [{
      token: enemy, tokenId: String(enemy.id ?? ''), tokenUuid: String(enemy.document?.uuid ?? enemy.uuid ?? ''),
      actorUuid: String(enemy.actor?.uuid ?? ''), reach: null, occluded: null,
      alpha: unchanged ? previous.alpha : 0, grow: unchanged ? previous.grow : 0,
      threatening: true, tier: intent?.tier ?? DEFAULT_TIER, graded: true,
      anchor: { x: enemy.center?.x ?? 0, y: enemy.center?.y ?? 0 }
    }];
  }

  #tokenByUuid(uuid) {
    const key = String(uuid ?? '');
    if (!key) return null;
    for (const token of this.#tokens()?.placeables ?? []) {
      if (String(token?.document?.uuid ?? token?.uuid ?? '') === key) return token;
    }
    return null;
  }

  #advance(active, delta) {
    const suppressed = this.#reprocessing || this.#actionWindowOpen() || this.#isBusy();
    let changed = false;
    let visible = 0;
    for (const threat of this.#threats) {
      const standing = threat.token && !threat.token.destroyed;
      if (standing) {
        const { x, y } = threat.token.center;
        if (threat.anchor.x !== x || threat.anchor.y !== y) {
          threat.anchor.x = x;
          threat.anchor.y = y;
          changed = true;
        }
      }
      const wants = active && standing && threat.threatening && !suppressed
        && threat.token.visible !== false && (Number(threat.token.actor?.system?.resources?.hp?.value) || 0) > 0;
      const previousAlpha = threat.alpha;
      const previousGrow = threat.grow;
      threat.alpha = Math.max(0, Math.min(1, threat.alpha + (wants ? delta / FADE_IN_MS : -delta / FADE_OUT_MS)));
      if (wants) threat.grow = Math.min(1, threat.grow + delta / DRAW_MS);
      else if (threat.alpha <= 0 && !threat.threatening) threat.grow = 0;
      if (threat.alpha !== previousAlpha || threat.grow !== previousGrow) changed = true;
      threat.fade = smoothstep(threat.alpha);
      threat.extent = easeOutCubic(threat.grow);
      if (threat.tier !== threat.drawnTier) {
        threat.drawnTier = threat.tier;
        changed = true;
      }
      threat.visible = threat.alpha > ALPHA_EPSILON && Boolean(this.#anchor);
      if (threat.visible) visible += 1;
    }
    if (visible !== this.#drawnCount) changed = true;
    if (this.#anchor && (this.#anchor.x !== this.#drawnAnchorX || this.#anchor.y !== this.#drawnAnchorY)) {
      changed = true;
    }
    return { changed, visible };
  }

  #drawnTip(threat) {
    const extent = threat.extent ?? 1;
    return {
      x: threat.anchor.x + (this.#anchor.x - threat.anchor.x) * extent,
      y: threat.anchor.y + (this.#anchor.y - threat.anchor.y) * extent
    };
  }

  #redraw(visible) {
    this.#glow.clear();
    this.#core.clear();
    for (const pass of GLOW_LAYERS) {
      for (const threat of this.#threats) {
        if (!threat.visible) continue;
        const style = styleFor(threat.tier);
        if (!style.glow) continue;
        const tip = this.#drawnTip(threat);
        this.#glow.lineStyle({ width: style.width * pass.scale, color: style.color, alpha: threat.fade * pass.alpha });
        this.#glow.moveTo(threat.anchor.x, threat.anchor.y);
        this.#glow.lineTo(tip.x, tip.y);
      }
    }
    for (const threat of this.#threats) {
      if (!threat.visible) continue;
      const style = styleFor(threat.tier);
      const tip = this.#drawnTip(threat);
      this.#core.lineStyle({
        width: style.width, color: style.color, alpha: threat.fade * (style.alpha ?? CORE_ALPHA)
      });
      this.#core.moveTo(threat.anchor.x, threat.anchor.y);
      this.#core.lineTo(tip.x, tip.y);
    }
    this.#drawnCount = visible;
    this.#drawnAnchorX = this.#anchor?.x ?? null;
    this.#drawnAnchorY = this.#anchor?.y ?? null;
  }
}
