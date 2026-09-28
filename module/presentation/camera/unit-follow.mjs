/** @layer presentation/camera */

import { recordDiagnostic } from '../../contracts/protocol.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Configuration                               */
/* -------------------------------------------- */

const UNIT_CAMERA = Object.freeze({
  margins: Object.freeze({ tight: 0.30, loose: 0.40, centered: 0.50 }),
  centerDuration: 520,
  followDuration: 250,
  speedMultiplier: Object.freeze({ instant: 0, smooth: 1, verySmooth: 2 }),
  /**
   * Screen pixels. Every `canvas.pan` makes Foundry run its pan hooks, HUD alignment, mask invalidation and hover
   * tests, so the follow only pans once the view would move by `visibleShift`. It comes to rest once it is within
   * `restDistance` of its target and slower than `restSpeed` per second: it snaps onto the target and removes its
   * ticker callback.
   */
  visibleShift: 0.25,
  restDistance: 0.25,
  restSpeed: 10,
  /** A view difference below this many canvas pixels is the follow's own rounding, not another camera mover. */
  viewTolerance: 0.01,
  /** How many recent frames give the display's normal frame time, and how far past it one frame may advance. */
  frameWindow: 15,
  frameAllowance: 1.1
});

/** The name every `canvas.animatePan` runs under, this camera's own centering pan included. */
const PAN_ANIMATION = 'canvas.animatePan';

/** How far into its duration the cosine easing of `canvas.animatePan` has covered 95% of a pan. */
const GLIDE_95 = Math.acos(-0.9) / Math.PI;

/** A critically damped follow starting still covers 95% of a step after this many 1/rate: (1 + u)e^-u = 0.05. */
const FOLLOW_95 = 4.7439;

/**
 * The follow's stiffness for a Follow Speed choice, per second. A single step covers 95% of its distance in the
 * same time as a `followDuration` glide by `canvas.animatePan` would. Instant has no smoothing at all.
 * @param {string} speed A `CAMERA_FOLLOW_SPEED_SETTING` choice.
 * @returns {number}
 */
export function followRate(speed) {
  const multiplier = UNIT_CAMERA.speedMultiplier[speed] ?? 1;
  if (multiplier === 0) return Infinity;
  return FOLLOW_95 / (GLIDE_95 * multiplier * (UNIT_CAMERA.followDuration / 1000));
}

/**
 * Advance one axis of the follow by `seconds` toward `target`, keeping its velocity. The step is the exact critically
 * damped motion for a target that holds still over the frame, so the path does not depend on the frame rate, and a
 * target that starts moving again never restarts the camera from a standstill.
 * @param {{position: number, velocity: number}} axis Updated in place, because the ticker steps it every frame.
 * @param {number} target
 * @param {number} rate From `followRate`. Infinity puts the axis on its target.
 * @param {number} seconds
 * @returns {{position: number, velocity: number}}
 */
export function stepFollowAxis(axis, target, rate, seconds) {
  if (!Number.isFinite(rate)) {
    axis.position = target;
    axis.velocity = 0;
    return axis;
  }
  const offset = axis.position - target;
  const drive = axis.velocity + (rate * offset);
  const decay = Math.exp(-rate * seconds);
  axis.position = target + ((offset + (drive * seconds)) * decay);
  axis.velocity = (axis.velocity - (rate * drive * seconds)) * decay;
  return axis;
}

/* -------------------------------------------- */
/*  Unit camera                                 */
/* -------------------------------------------- */

/**
 * Centre on a unit as its move opens, and keep this client's own walking unit in view by Edge Pan or Locked Center.
 *
 * `init/system.mjs` routes `controlToken` to `centerOnUnit` and `updateToken` to `followUnit`. An accepted move arms
 * one ticker callback that eases the camera after the unit's drawn position every frame and carries the camera's
 * velocity from one keyboard step into the next, until the walk ends and the camera comes to rest. Any camera move
 * the follow did not make, a cinematic or phase camera holding the `CameraLease`, or a hidden page ends the follow.
 * Only the next accepted move starts it again.
 */
export class UnitCameraPresentation {
  constructor({
    diagnostics = null, settings, lease = null,
    canvas = () => globalThis.canvas,
    animations = () => foundry.canvas.animation.CanvasAnimation,
    page = () => globalThis.document ?? null
  }) {
    this.diagnostics = diagnostics;
    this.settings = settings;
    this.lease = lease;
    this.canvas = canvas;
    this.animations = animations;
    this.page = page;
    this.follow = null;
    this.hiddenToken = null;
    this.centering = null;
    this.watching = null;
    this.frameTimes = [];
    this.tick = () => this.#tick();
    this.onVisibility = () => this.#onVisibility();
  }

  /* -------------------------------------------- */
  /*  Public actions                              */
  /* -------------------------------------------- */

  /** Pan to the unit whose move just opened, where the client asks for it. */
  centerOnUnit(token) {
    if (!token || this.settings.centerOnSelect() === false) return false;
    const center = token.center;
    const duration = this.#duration('centerSpeed', UNIT_CAMERA.centerDuration);
    const moved = this.#pan(center?.x, center?.y, duration);
    this.centering = moved && duration > 0 ? (this.animations()?.getAnimation?.(PAN_ANIMATION) ?? null) : null;
    return moved;
  }

  /**
   * Follow this client's controlled unit through a move it is planning. Every other token update leaves the camera
   * alone. Keyboard steps and dragged walks start the same follow, and a step that lands while the camera is still
   * easing after the last one keeps its velocity.
   */
  followUnit(tokenDocument, changes) {
    if (!('x' in (changes ?? {})) && !('y' in (changes ?? {}))) return false;
    const token = this.#followedToken(tokenDocument);
    if (!token || token.isPreview) return false;
    if (pageHidden()) return this.#awaitReturn(token);
    const host = this.canvas();
    if (!host?.ready || !host.stage || this.lease?.held || !this.#claimView(host)) return this.#stop();
    this.#arm(host, token, changes);
    return true;
  }

  /** Stop following and forget every unit and pan, for canvas teardown. */
  dispose() {
    this.hiddenToken = null;
    this.centering = null;
    this.#stop();
  }

  /* -------------------------------------------- */
  /*  Following                                   */
  /* -------------------------------------------- */

  #arm(host, token, changes) {
    const kept = this.follow?.token === token ? this.follow : null;
    if (!kept) this.#stop();
    const view = readView(host.stage);
    const drawn = { x: Number(token.x) || 0, y: Number(token.y) || 0 };
    const heading = {
      x: Math.sign((Number(changes.x ?? drawn.x) || 0) - drawn.x),
      y: Math.sign((Number(changes.y ?? drawn.y) || 0) - drawn.y)
    };
    this.follow = {
      token,
      x: { position: view.x, velocity: kept?.x.velocity ?? 0 },
      y: { position: view.y, velocity: kept?.y.velocity ?? 0 },
      view,
      drawn,
      move: heading.x || heading.y ? heading : (kept?.move ?? heading),
      ticker: kept?.ticker ?? startTicker(host, this.tick)
    };
    this.#watchPage(true);
  }

  /** A ticker callback may not throw: an exception there stops Foundry's canvas ticker for every other listener. */
  #tick() {
    try {
      this.#advance();
    } catch (error) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error, detail: 'follow' });
      this.#stop();
    }
  }

  /** One frame: end the follow if anything else now owns the view, else ease one step after the drawn unit. */
  #advance() {
    const follow = this.follow;
    const host = this.canvas();
    if (!follow || !host?.ready || !host.stage) return this.#stop();
    const token = follow.token;
    if (pageHidden()) return this.#awaitReturn(token);
    if (token.destroyed || this.#followedToken(token.document) !== token || this.lease?.held) return this.#stop();
    if (!this.#claimView(host) || viewMoved(readView(host.stage), follow.view)) return this.#stop();
    const drawn = { x: Number(token.x) || 0, y: Number(token.y) || 0 };
    const moved = { x: drawn.x - follow.drawn.x, y: drawn.y - follow.drawn.y };
    const moving = moved.x !== 0 || moved.y !== 0;
    if (moving) follow.move = moved;
    follow.drawn = drawn;
    const target = this.#target(host, token, drawn, follow);
    const before = { x: follow.x.position, y: follow.y.position };
    const rate = followRate(this.settings.followSpeed());
    const seconds = this.#frameSeconds(follow.ticker?.deltaMS);
    stepFollowAxis(follow.x, target.x, rate, seconds);
    stepFollowAxis(follow.y, target.y, rate, seconds);
    if (this.settings.followMode() !== 'lockedCenter') holdAgainstMovement(follow, before);
    const resting = !moving && !token.movementAnimationPromise && atRest(follow, target);
    if (resting) holdStill(follow, target);
    applyView(host, follow, { settling: resting });
    if (resting) this.#stop();
    return true;
  }

  /**
   * How far this frame advances the follow. A frame that ran long because the display missed a refresh advances it
   * no further than a normal frame: the view holds for that refresh instead of jumping to catch up, and the follow's
   * trail absorbs the time. The normal frame is the median of the last few, so a lasting change of frame rate is
   * followed within a few frames while a single slow frame is not.
   */
  #frameSeconds(deltaMS) {
    const elapsed = Math.max(0, Number(deltaMS) || 0);
    this.frameTimes.push(elapsed);
    if (this.frameTimes.length > UNIT_CAMERA.frameWindow) this.frameTimes.shift();
    const normal = [...this.frameTimes].sort((left, right) => left - right)[Math.floor(this.frameTimes.length / 2)];
    return Math.min(elapsed, normal * UNIT_CAMERA.frameAllowance) / 1000;
  }

  /** Where the follow eases this frame: the drawn unit's centre, or the least Edge Pan shift that frames it. */
  #target(host, token, drawn, follow) {
    const center = token.getCenterPoint?.(drawn) ?? token.center;
    if (this.settings.followMode() === 'lockedCenter') return constrainView(host, center.x, center.y);
    const offset = this.#edgeOffset(host, center, follow.move);
    return constrainView(host, follow.x.position + offset.x, follow.y.position + offset.y);
  }

  #edgeOffset(host, center, move) {
    const stage = host.stage;
    const margin = UNIT_CAMERA.margins[this.settings.followMargin()] ?? UNIT_CAMERA.margins.tight;
    const point = stage.toGlobal({ x: center.x, y: center.y });
    return edgePanOffset({ point, screen: host.app.screen, margin, scale: stage.scale?.x, move });
  }

  /**
   * Whether the view is free for the follow. A running `canvas.animatePan` owns the view, unless it is this camera's
   * own centering pan. The follow then stops that pan and takes over from where it got to.
   */
  #claimView(host) {
    const Animation = this.animations();
    const running = Animation?.getAnimation?.(PAN_ANIMATION);
    if (!running || !animationActive(running, Animation)) return true;
    if (running !== this.centering) return false;
    Animation.terminateAnimation(PAN_ANIMATION);
    this.centering = null;
    if (this.follow) {
      this.follow.view = readView(host.stage);
      holdStill(this.follow, this.follow.view);
    }
    return true;
  }

  #stop() {
    const follow = this.follow;
    this.follow = null;
    follow?.ticker?.remove?.(this.tick);
    if (!this.hiddenToken) this.#watchPage(false);
    return false;
  }

  /* -------------------------------------------- */
  /*  Hidden page                                 */
  /* -------------------------------------------- */

  /** Drop the follow and its velocity while the page is hidden, keeping only which unit it was on. */
  #awaitReturn(token) {
    this.#stop();
    this.hiddenToken = token;
    this.#watchPage(true);
    return false;
  }

  #onVisibility() {
    if (pageHidden()) {
      if (this.follow) this.#awaitReturn(this.follow.token);
      return;
    }
    const token = this.hiddenToken;
    this.hiddenToken = null;
    if (!this.follow) this.#watchPage(false);
    if (token) this.#frameOnce(token);
  }

  /**
   * Frame a unit that walked while the page was hidden, at once and only once. Its persisted position is where the
   * walk ends, so nothing eases toward a stale target, and nothing follows until its next move.
   */
  #frameOnce(token) {
    const host = this.canvas();
    if (!host?.ready || !host.stage || token.destroyed || this.#followedToken(token.document) !== token) return false;
    if (this.lease?.held || !this.#claimView(host)) return false;
    const source = token.document?._source ?? token.document ?? {};
    const center = token.getCenterPoint?.({ x: source.x, y: source.y }) ?? token.center;
    if (this.settings.followMode() === 'lockedCenter') return this.#pan(center?.x, center?.y, 0);
    const offset = this.#edgeOffset(host, center, { x: 0, y: 0 });
    if (offset.x === 0 && offset.y === 0) return false;
    return this.#pan(host.stage.pivot.x + offset.x, host.stage.pivot.y + offset.y, 0);
  }

  #watchPage(on) {
    const page = on ? this.page() : this.watching;
    if (!page?.addEventListener || Boolean(this.watching) === on) return;
    if (on) page.addEventListener('visibilitychange', this.onVisibility);
    else page.removeEventListener('visibilitychange', this.onVisibility);
    this.watching = on ? page : null;
  }

  /* -------------------------------------------- */
  /*  Helpers                                     */
  /* -------------------------------------------- */

  #followedToken(tokenDocument) {
    if (this.settings.followMode() === 'off') return null;
    if (tokenDocument?.actor?.system?.turn?.movementPlanning !== true) return null;
    const token = tokenDocument.object;
    return token?.controlled ? token : null;
  }

  #duration(speedKey, base) {
    return base * (UNIT_CAMERA.speedMultiplier[this.settings[speedKey]()] ?? 1);
  }

  #pan(x, y, duration) {
    const host = this.canvas();
    if (!host?.ready || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (duration > 0) host.animatePan({ x, y, duration });
    else host.pan({ x, y });
    return true;
  }
}

/**
 * Run the follow once a frame in the slot `canvas.animatePan` uses: after the Token's movement animation and its
 * render flags have moved the drawn unit, and before the stage renders.
 */
function startTicker(host, tick) {
  const ticker = host.app?.ticker ?? null;
  const low = globalThis.PIXI?.UPDATE_PRIORITY?.LOW ?? -25;
  ticker?.add?.(tick, undefined, low + 1);
  return ticker;
}

/** The least pan that brings a screen point back inside the margin band, never against the unit's own movement. */
function edgePanOffset({ point, screen, margin, scale = 1, move = { x: 0, y: 0 } }) {
  const insetX = screen.width * margin;
  const insetY = screen.height * margin;
  const targetX = Math.min(Math.max(point.x, insetX), screen.width - insetX);
  const targetY = Math.min(Math.max(point.y, insetY), screen.height - insetY);
  const unit = scale || 1;
  let x = (point.x - targetX) / unit;
  let y = (point.y - targetY) / unit;
  if (move.x !== 0 && x * move.x < 0) x = 0;
  if (move.y !== 0 && y * move.y < 0) y = 0;
  return { x, y };
}

/** Edge Pan's rule applied to the camera's own motion: momentum never carries the view against the unit's movement. */
function holdAgainstMovement(follow, before) {
  for (const key of ['x', 'y']) {
    const axis = follow[key];
    if (follow.move[key] === 0 || (axis.position - before[key]) * follow.move[key] >= 0) continue;
    axis.position = before[key];
    axis.velocity = 0;
  }
}

/**
 * Pan once to the follow's position when it has moved far enough to see, then keep what Foundry's view limits let it
 * reach. Smaller moves wait and add up. The settling pan that puts the view exactly on target is always made.
 */
function applyView(host, follow, { settling = false } = {}) {
  const tolerance = UNIT_CAMERA.viewTolerance;
  const visible = settling ? tolerance : Math.max(tolerance, UNIT_CAMERA.visibleShift / follow.view.scale);
  const shift = Math.max(Math.abs(follow.x.position - follow.view.x), Math.abs(follow.y.position - follow.view.y));
  if (shift < visible) return false;
  host.pan({ x: follow.x.position, y: follow.y.position });
  const view = readView(host.stage);
  for (const key of ['x', 'y']) {
    if (Math.abs(view[key] - follow[key].position) < tolerance) continue;
    follow[key].position = view[key];
    follow[key].velocity = 0;
  }
  follow.view = view;
  return true;
}

/** Put the follow at a point with no velocity: settled on its target, or taking over a view it did not make. */
function holdStill(follow, point) {
  follow.x = { position: point.x, velocity: 0 };
  follow.y = { position: point.y, velocity: 0 };
}

/** Whether the follow is within `restDistance` of its target and slower than `restSpeed`, both on screen. */
function atRest(follow, target) {
  const scale = follow.view.scale;
  return ['x', 'y'].every(key => Math.abs(follow[key].position - target[key]) * scale < UNIT_CAMERA.restDistance
    && Math.abs(follow[key].velocity) * scale < UNIT_CAMERA.restSpeed);
}

function constrainView(host, x, y) {
  const view = host._constrainView?.({ x, y, scale: host.stage.scale?.x }) ?? { x, y };
  return { x: Number(view.x), y: Number(view.y) };
}

function readView(stage) {
  return { x: Number(stage.pivot?.x) || 0, y: Number(stage.pivot?.y) || 0, scale: Number(stage.scale?.x) || 1 };
}

function viewMoved(view, recorded) {
  const tolerance = UNIT_CAMERA.viewTolerance;
  return Math.abs(view.x - recorded.x) > tolerance || Math.abs(view.y - recorded.y) > tolerance
    || Math.abs(view.scale - recorded.scale) > 1e-9;
}

function animationActive(animation, Animation) {
  const states = Animation?.STATES;
  if (!states) return true;
  return animation.state === states.WAITING || animation.state === states.RUNNING;
}
