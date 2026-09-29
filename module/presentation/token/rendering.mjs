/** @layer presentation/token */
import { ENCOUNTER_PHASE_FACTIONS, ENCOUNTER_PHASE_FLAG } from '../../contracts/domains/combat.mjs';
import { DEFEAT_PRESENTATION_TIMING } from '../../contracts/domains/damage.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { STATUS_ICON_SLOT, TOKEN_MOVEMENT_WRITE_KEYS } from '../../contracts/domains/tokens.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Indicator assets                            */
/* -------------------------------------------- */
const SELECTION_FRAME = `systems/${SYSTEM_ID}/assets/ui/cursor/selection.svg`;
const PATHFINDING_ARROW = `systems/${SYSTEM_ID}/assets/ui/cursor/navigation_s.svg`;
const TARGET_FRAME = `systems/${SYSTEM_ID}/assets/ui/cursor/target.svg`;
const SELECTION_LAYER = 'emblem-selection-brackets';
const PATHFINDING_LAYER = 'emblem-pathfinding-arrows';
const TARGET_LAYER = 'emblem-target-reticles';
const CORNERS = Object.freeze(['nw', 'ne', 'sw', 'se']);
const AIRBORNE_SORT_OFFSET = 1_000_000;
const CORNER_ANCHORS = Object.freeze({ nw: [0, 0], ne: [1, 0], sw: [0, 1], se: [1, 1] });

const selectionIndicators = new Map();
const pathfindingIndicators = new Map();
const exchangingTokens = new Set();
let facadeSelectionTokenId = null;
const targetIndicators = new Map();
const nearestScalingTimers = new Map();
const footstepBounces = new Map();
const tokenShakes = new Map();
const tokenDodges = new Map();
const tokenDefeatFades = new Map();
const TURN_GREY_FILTER = 'emblemTurnGrey';
const MOVEMENT_ONLY_KEYS = new Set([...TOKEN_MOVEMENT_WRITE_KEYS, 'rotation']);
const DEFEAT_FADE_FILTER = 'emblemDefeatFade';
const DEFEAT_FADE_ALPHA = 0.55;
const OUTLINE_TOLERANCE = 0.02;
const OUTLINE_FRAGMENT = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec3 uSrc;
uniform vec3 uDst;
uniform float uTol;
void main(void) {
  vec4 c = texture2D(uSampler, vTextureCoord);
  if (c.a <= 0.0) { gl_FragColor = c; return; }
  vec3 rgb = c.rgb / max(c.a, 0.0001);
  if (distance(rgb, uSrc) <= uTol) {
    gl_FragColor = vec4(uDst * c.a, c.a);
  } else {
    gl_FragColor = c;
  }
}
`;
const FOOTSTEP_BOUNCE_MS = 200;
const DODGE_OUT_MS = 100;
const DODGE_HOLD_MS = 500;
const DODGE_BACK_MS = 120;

/** The whole length of a dodge: out, hold and back. effectOperationHoldMs holds a resist step for this long. */
export const TOKEN_DODGE_MS = DODGE_OUT_MS + DODGE_HOLD_MS + DODGE_BACK_MS;

const reportedUnconfiguredPorts = new Set();
/**
 * Report once per session, for each missing function, that configureTokenPresentation or
 * configureTokenEffectPresentation was never called. `presentation/` may not import the `foundry/` diagnostics
 * adapter, and neither configure call passes in diagnostics, so this writes to the console and shows an error
 * notification instead. It never throws. Every caller runs inside the PIXI ticker or a libWrapper override of
 * Foundry's token effect drawing, and PIXI's Ticker#_tick stops scheduling frames once a listener throws, which
 * would freeze the whole canvas.
 */
function warnUnconfiguredPort(port, configureFn) {
  if (reportedUnconfiguredPorts.has(port)) return;
  reportedUnconfiguredPorts.add(port);
  const message = `presentation/token/rendering.mjs: ${port} was used before init/system.mjs called ${configureFn}.`;
  globalThis.console?.error?.(message);
  globalThis.ui?.notifications?.error?.(message);
}
const unconfiguredVerticalAdjustment = () => warnUnconfiguredPort('applyVerticalAdjustment', 'configureTokenPresentation');
const unconfiguredOutlineColours = () => {
  warnUnconfiguredPort('readOutlineColours', 'configureTokenPresentation');
  return null;
};
let applyVerticalAdjustment = unconfiguredVerticalAdjustment;
let readOutlineColours = unconfiguredOutlineColours;

/* -------------------------------------------- */
/*  Presentation configuration                  */
/* -------------------------------------------- */
/**
 * init/system.mjs calls this once with two functions from `foundry/`, which this file may not import:
 * `applyVerticalAdjustment` (onRefreshTokenArt, which reapplies a token's art offset) and `outlineColours`
 * (tokenOutlineColours, the scene's outline recolour).
 */
export function configureTokenPresentation(configuration = {}) {
  applyVerticalAdjustment = configuration.applyVerticalAdjustment ?? unconfiguredVerticalAdjustment;
  readOutlineColours = configuration.outlineColours ?? unconfiguredOutlineColours;
}

/** Bob a visible Token once while preserving its authored vertical art offset. */
export function animateTokenFootstep(token) {
  const ticker = canvasTicker();
  if (!token?.id || !token.mesh || token.mesh.destroyed || !ticker || footstepBounces.has(token.id) || pageHidden()) {
    return false;
  }
  const amplitude = Number(canvas.grid?.size) * 0.07;
  let elapsed = 0;
  const tick = frame => {
    if (!token.mesh || token.mesh.destroyed) {
      clearFootstepBounce(token);
      return;
    }
    elapsed += Number(frame?.deltaMS ?? ticker.deltaMS) || (1000 / 60);
    const progress = Math.min(1, elapsed / FOOTSTEP_BOUNCE_MS);
    token._emblemTransientY = -amplitude * (1 - Math.abs((2 * progress) - 1));
    applyVerticalAdjustment(token);
    if (progress >= 1) clearFootstepBounce(token);
  };
  footstepBounces.set(token.id, { token, tick });
  ticker.add(tick);
  return true;
}

/** Stop an active footstep bob and restore the Token's authored vertical offset. */
export function stopTokenFootstepAnimation(token) {
  clearFootstepBounce(token);
}

/** Apply the combat impact’s decaying five-cycle shake to a visible Token. */
export function animateTokenShake(token, amplitude = 0.11, duration = 420) {
  const ticker = canvasTicker();
  if (!token?.id || !token.mesh || token.mesh.destroyed || !ticker || pageHidden()) return Promise.resolve(false);
  clearTokenShake(token);
  return new Promise(resolve => {
    const baseX = token.mesh.position.x;
    const distance = Number(canvas.grid?.size) * amplitude;
    let elapsed = 0;
    let currentOffset = 0;
    let settled = false;
    const apply = () => {
      if (token.mesh && !token.mesh.destroyed) token.mesh.position.x = baseX + currentOffset;
    };
    const refreshHookId = Hooks.on('refreshToken', refreshed => {
      if (refreshed === token) apply();
    });
    const finish = result => {
      if (settled) return;
      settled = true;
      ticker.remove(tick);
      Hooks.off('refreshToken', refreshHookId);
      currentOffset = 0;
      apply();
      tokenShakes.delete(token.id);
      resolve(result);
    };
    const tick = frame => {
      if (!token.mesh || token.mesh.destroyed) {
        finish(false);
        return;
      }
      elapsed += Number(frame?.deltaMS ?? ticker.deltaMS) || (1000 / 60);
      const progress = Math.min(1, elapsed / duration);
      const decay = (1 - progress) ** 2;
      currentOffset = Math.sin(progress * 5 * 2 * Math.PI) * distance * decay;
      apply();
      if (progress >= 1) finish(true);
    };
    tokenShakes.set(token.id, { token, tick, baseX, finish });
    ticker.add(tick);
  });
}

/**
 * Hide a unit's pathfinding arrow and selection brackets while `exchanging` is true, and bring them back when it is
 * false. CombatPresentation hides them through an exchange or activation, the targeting controls while a
 * confirmed attack or activation is being resolved, and the Promote menu while a promotion runs.
 */
export function holdPathfindingIndicator(token, exchanging) {
  if (!token?.id) return;
  if (exchanging) exchangingTokens.add(token.id);
  else exchangingTokens.delete(token.id);
  refreshControlIndicator(token);
}

/** Slide a Token away from its attacker, hold, and restore its exact visual origin. */
export function animateTokenDodge(token, attacker) {
  const ticker = canvasTicker();
  if (!token?.id || !token.mesh || token.mesh.destroyed || !ticker || pageHidden()) return Promise.resolve(false);
  clearTokenDodge(token);
  const displacement = dodgeDisplacement(token, attacker);
  return new Promise(resolve => {
    const baseX = token.mesh.position.x;
    const totalDuration = DODGE_OUT_MS + DODGE_HOLD_MS + DODGE_BACK_MS;
    let elapsed = 0;
    let currentX = 0;
    let currentY = 0;
    let settled = false;
    const apply = () => {
      if (!token.mesh || token.mesh.destroyed) return;
      token.mesh.position.x = baseX + currentX;
      token._emblemTransientY = currentY;
      applyVerticalAdjustment(token);
    };
    const refreshHookId = Hooks.on('refreshToken', refreshed => {
      if (refreshed === token) apply();
    });
    const finish = result => {
      if (settled) return;
      settled = true;
      ticker.remove(tick);
      Hooks.off('refreshToken', refreshHookId);
      currentX = 0;
      currentY = 0;
      token._emblemTransientY = 0;
      if (token.mesh && !token.mesh.destroyed) token.mesh.position.x = baseX;
      applyVerticalAdjustment(token);
      tokenDodges.delete(token.id);
      resolve(result);
    };
    const tick = frame => {
      if (!token.mesh || token.mesh.destroyed) {
        finish(false);
        return;
      }
      elapsed += Number(frame?.deltaMS ?? ticker.deltaMS) || (1000 / 60);
      if (elapsed < DODGE_OUT_MS) {
        const progress = easeOutCubic(elapsed / DODGE_OUT_MS);
        currentX = displacement.x * progress;
        currentY = displacement.y * progress;
      } else if (elapsed < DODGE_OUT_MS + DODGE_HOLD_MS) {
        currentX = displacement.x;
        currentY = displacement.y;
      } else {
        const progress = Math.min(1, (elapsed - DODGE_OUT_MS - DODGE_HOLD_MS) / DODGE_BACK_MS);
        const remaining = 1 - easeOutCubic(progress);
        currentX = displacement.x * remaining;
        currentY = displacement.y * remaining;
      }
      apply();
      if (elapsed >= totalDuration) finish(true);
    };
    tokenDodges.set(token.id, { token, tick, finish });
    ticker.add(tick);
  });
}

/**
 * Fade a defeated unit's mesh on this client only, with no document write, for HealthPresentation's defeat beat.
 * A hidden page skips it. The filters stay on the mesh until clearTokenDefeatFade removes them.
 */
export function animateTokenDefeatFade(token, durationMs = DEFEAT_PRESENTATION_TIMING.fadeDuration) {
  const ticker = canvasTicker();
  if (!token?.id || !token.mesh || token.mesh.destroyed || !ticker || !globalThis.PIXI || pageHidden()) {
    return Promise.resolve(false);
  }
  clearTokenDefeatFade(token);
  return new Promise(resolve => {
    const colour = new PIXI.ColorMatrixFilter();
    colour.desaturate();
    colour[DEFEAT_FADE_FILTER] = true;
    const alpha = new PIXI.AlphaFilter(DEFEAT_FADE_ALPHA);
    alpha[DEFEAT_FADE_FILTER] = true;
    let elapsed = 0;
    let stopped = false;
    const apply = () => {
      const mesh = token.mesh;
      if (!mesh || mesh.destroyed) return;
      const filters = Array.isArray(mesh.filters) ? mesh.filters : [];
      if (!filters.includes(alpha)) mesh.filters = [...filters, colour, alpha];
    };
    const refreshHookId = Hooks.on('refreshToken', refreshed => {
      if (refreshed === token) apply();
    });
    const stop = result => {
      if (stopped) return;
      stopped = true;
      ticker.remove(tick);
      resolve(result);
    };
    const tick = frame => {
      const mesh = token.mesh;
      if (!mesh || mesh.destroyed) {
        stop(false);
        return;
      }
      elapsed += Number(frame?.deltaMS ?? ticker.deltaMS) || (1000 / 60);
      const progress = Math.min(1, elapsed / Math.max(1, Number(durationMs) || 1));
      alpha.alpha = DEFEAT_FADE_ALPHA * ((1 + Math.cos(progress * Math.PI)) / 2);
      apply();
      if (progress >= 1) stop(true);
    };
    const clear = () => {
      stop(false);
      Hooks.off('refreshToken', refreshHookId);
      tokenDefeatFades.delete(token.id);
      removeDefeatFadeFilters(token);
    };
    tokenDefeatFades.set(token.id, { token, clear });
    apply();
    ticker.add(tick);
  });
}

/**
 * Remove the defeat fade from a unit's mesh. HealthPresentation calls it for the clear-fade beat, and
 * onDestroyTokenPresentation when the token is removed.
 */
export function clearTokenDefeatFade(subject) {
  const tokenId = subject?.id ?? subject?.document?.id;
  const entry = tokenId ? tokenDefeatFades.get(tokenId) : null;
  if (entry) {
    entry.clear();
    return true;
  }
  return removeDefeatFadeFilters(subject);
}

/** Drop only this effect's own filters, leaving the greyout and any authored filter in place. */
function removeDefeatFadeFilters(subject) {
  const mesh = tokenPlaceable(subject)?.mesh;
  if (!mesh || mesh.destroyed) return false;
  const filters = Array.isArray(mesh.filters) ? mesh.filters : [];
  const kept = filters.filter(filter => filter?.[DEFEAT_FADE_FILTER] !== true);
  if (kept.length === filters.length) return false;
  mesh.filters = kept.length ? kept : undefined;
  return true;
}

/* -------------------------------------------- */
/*  Hook handlers                               */
/* -------------------------------------------- */
/** Prepare every drawn token with Emblem's SVG selection and target effects. */
export function onCanvasReadyTokenPresentation() {
  clearTokenIndicators();
  for (const token of canvas.tokens?.placeables ?? []) {
    scheduleNearestTokenScaling(token);
    hideCoreTokenDecorations(token);
    refreshTokenTurnGreyout(token);
    refreshControlIndicator(token);
    applyTokenOutline(token);
    if (isOwnTarget(token)) showTargetIndicator(token);
  }
}

/** Remove every animation and indicator this file drew before the canvas is torn down. */
export function onCanvasTearDownTokenPresentation() {
  clearTransientTokenAnimations();
  clearTokenIndicators();
}

/** Hide Foundry decorations as soon as a token enters the canvas. */
export function onDrawTokenPresentation(token) {
  if (token?.isPreview) {
    applyNearestTokenScaling(token);
    hideCoreTokenDecorations(token);
    refreshTokenTurnGreyout(token);
    return;
  }
  scheduleNearestTokenScaling(token);
  hideCoreTokenDecorations(token);
  refreshTokenTurnGreyout(token);
  refreshControlIndicator(token);
  applyAirborneSort(token);
  applyTokenOutline(token);
  if (isOwnTarget(token)) showTargetIndicator(token);
}

/**
 * On every token refresh, reapply what Foundry's refresh would undo: pixel-art sampling, the hidden core
 * decorations, the turn greyout and the airborne sort.
 */
export function onRefreshTokenPresentation(token) {
  applyNearestTokenScaling(token);
  hideCoreTokenDecorations(token);
  refreshTokenTurnGreyout(token);
  applyAirborneSort(token);
}

/**
 * Sort airborne Token meshes above ground units during rendering, without writing Scene sort values. Presentation
 * cannot import isAirborneActor from foundry/adapters/projections/combat-context.mjs, so this reads the same two
 * facts: a Character's compiled airborne status, and any other Actor's flying type.
 */
function applyAirborneSort(token) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed) return false;
  const actor = token.actor;
  const airborne = actor?.type === 'Character'
    ? actor.system.statuses.airborne === true
    : actor?.system?.unitType?.flying === true;
  mesh.sort = token.document.sort + (airborne ? AIRBORNE_SORT_OFFSET : 0);
  return airborne;
}

/**
 * Reapply nearest sampling after Foundry replaces a token mesh texture. A movement write or a turn replaces none,
 * and every refresh while the Token walks applies the sampling anyway, so neither schedules the retries.
 */
export function onUpdateTokenPresentation(tokenDocument, changes = null) {
  const keys = Object.keys(changes ?? {});
  if (keys.length && keys.every(key => MOVEMENT_ONLY_KEYS.has(key))) return;
  scheduleNearestTokenScaling(tokenDocument);
}

/** Re-read every token's greyout when the Scene turns the phase over, which changes who can be spent. */
export function onScenePhaseTokenPresentation(scene, changes) {
  const flags = changes?.flags?.[SYSTEM_ID];
  if (!flags || !(ENCOUNTER_PHASE_FLAG in flags || `-=${ENCOUNTER_PHASE_FLAG}` in flags)) return;
  if (scene?.id !== canvas.scene?.id) return;
  const acting = actingPhaseFactions(scene);
  for (const token of canvas.tokens?.placeables ?? []) refreshTokenTurnGreyout(token, acting);
}

/** After an Actor update, refresh its tokens' turn greyout, indicators and airborne sort. */
export function onUpdateActorTokenPresentation(actor) {
  for (const token of canvas.tokens?.placeables ?? []) {
    if (token.actor?.uuid !== actor?.uuid) continue;
    refreshTokenTurnGreyout(token);
    refreshControlIndicator(token);
    applyAirborneSort(token);
  }
}

/** Reapply nearest filtering when Foundry rebuilds status icons for an ActiveEffect. */
export function onActiveEffectTokenPresentation(effect) {
  const actorUuid = effect?.parent?.uuid;
  if (!actorUuid) return;
  for (const token of canvas.tokens?.placeables ?? []) {
    if (token.actor?.uuid !== actorUuid) continue;
    token._refreshEffects?.();
    scheduleNearestTokenScaling(token);
  }
}

/** Suppress Foundry’s hover frame during Token presentation refresh. */
export function onHoverTokenPresentation(token) {
  hideCoreTokenDecorations(token);
}

/** Show the pathfinding arrow for a moving unit and reserve corner brackets for ordinary GM selection. */
export function onControlTokenPresentation(token, controlled) {
  hideCoreTokenDecorations(token);
  refreshControlIndicator(token, controlled);
}

/**
 * Replace Foundry target arrows and pips with Emblem’s pulsing SVG reticle. The hook fires on every client for
 * every user's targeting, so the reticle follows only this user's own targets.
 */
export function onTargetTokenPresentation(_user, token) {
  hideCoreTokenDecorations(token);
  if (isOwnTarget(token)) showTargetIndicator(token);
  else clearTargetIndicator(token);
}

/** Release PIXI resources held for a removed token. */
export function onDestroyTokenPresentation(token) {
  if (token?.isPreview) return;
  if (facadeSelectionTokenId === token?.id) facadeSelectionTokenId = null;
  clearFootstepBounce(token);
  clearTokenShake(token);
  clearTokenDodge(token);
  clearTokenDefeatFade(token);
  clearNearestScalingTimers(token);
  clearSelectionIndicator(token);
  clearPathfindingIndicator(token);
  clearTargetIndicator(token);
}

/* -------------------------------------------- */
/*  Pixel-art filtering                         */
/* -------------------------------------------- */
/** Force a token mesh to sample its shared texture with nearest-neighbor filtering. */
function applyNearestTokenScaling(token) {
  const texture = token?.mesh?.texture;
  const nearest = globalThis.PIXI?.SCALE_MODES?.NEAREST ?? 0;
  applyNearestTexture(texture, nearest);
  applyNearestEffectScaling(token, nearest);
}

/** Cover the short v14 window where a draw or animated update replaces the current PIXI texture. */
function scheduleNearestTokenScaling(subject) {
  const token = tokenPlaceable(subject);
  const tokenId = token?.id ?? subject?.id;
  if (!tokenId) return;
  clearNearestScalingTimers({ id: tokenId });
  applyNearestTokenScaling(token);
  const timers = [50, 250].map((delay, index, delays) => setTimeout(() => {
    applyNearestTokenScaling(canvas.tokens?.get(tokenId));
    if (index === delays.length - 1) nearestScalingTimers.delete(tokenId);
  }, delay));
  nearestScalingTimers.set(tokenId, timers);
}

function clearNearestScalingTimers(subject) {
  const tokenId = subject?.id ?? subject?.document?.id;
  if (!tokenId) return;
  for (const timer of nearestScalingTimers.get(tokenId) ?? []) clearTimeout(timer);
  nearestScalingTimers.delete(tokenId);
}

function applyNearestEffectScaling(token, nearest) {
  const pending = [...(token?.effects?.children ?? [])];
  while (pending.length) {
    const display = pending.pop();
    applyNearestTexture(display?.texture, nearest);
    pending.push(...(display?.children ?? []));
  }
}

/** Force one texture to sample with nearest-neighbour filtering, which is what pixel art wants. */
export function applyNearestTexture(texture, nearest = globalThis.PIXI?.SCALE_MODES?.NEAREST ?? 0) {
  const base = texture?.baseTexture ?? texture?.source;
  if (!base || base.scaleMode === nearest) return;
  base.scaleMode = nearest;
  base.update?.();
}

function clearFootstepBounce(subject) {
  const tokenId = subject?.id ?? subject?.document?.id;
  const entry = tokenId ? footstepBounces.get(tokenId) : null;
  if (!entry) return;
  canvasTicker()?.remove(entry.tick);
  entry.token._emblemTransientY = 0;
  applyVerticalAdjustment(entry.token);
  footstepBounces.delete(tokenId);
}

function clearTokenShake(subject) {
  const tokenId = subject?.id ?? subject?.document?.id;
  const entry = tokenId ? tokenShakes.get(tokenId) : null;
  if (!entry) return;
  entry.finish(false);
}

function clearTokenDodge(subject) {
  const tokenId = subject?.id ?? subject?.document?.id;
  const entry = tokenId ? tokenDodges.get(tokenId) : null;
  if (!entry) return;
  entry.finish(false);
}

function clearTransientTokenAnimations() {
  for (const tokenId of [...footstepBounces.keys()]) clearFootstepBounce({ id: tokenId });
  for (const tokenId of [...tokenShakes.keys()]) clearTokenShake({ id: tokenId });
  for (const tokenId of [...tokenDodges.keys()]) clearTokenDodge({ id: tokenId });
  for (const tokenId of [...tokenDefeatFades.keys()]) clearTokenDefeatFade({ id: tokenId });
}

function dodgeDisplacement(token, attacker) {
  let directionX = 0;
  let directionY = 0;
  if (attacker) {
    const differenceX = (Number(attacker.x) || 0) - (Number(token.x) || 0);
    const differenceY = (Number(attacker.y) || 0) - (Number(token.y) || 0);
    if (differenceX > 0) directionX = -1;
    else if (differenceX < 0) directionX = 1;
    else if (differenceY > 0) directionY = -1;
    else directionX = Math.random() < 0.5 ? -1 : 1;
  } else directionX = Math.random() < 0.5 ? -1 : 1;
  const offset = (Number(canvas.grid?.size) || 100) * 0.25;
  return { x: directionX * offset, y: directionY * offset };
}

function easeOutCubic(progress) {
  return 1 - ((1 - Math.max(0, Math.min(1, progress))) ** 3);
}

function tokenPlaceable(subject) {
  if (subject?.mesh) return subject;
  return subject?.object ?? canvas.tokens?.get(subject?.id) ?? null;
}

/* -------------------------------------------- */
/*  Core suppression                            */
/* -------------------------------------------- */
/** Hide the native hover, control, and target graphics without removing Foundry's internal containers. */
function hideCoreTokenDecorations(token) {
  if (!token) return;
  if (token.border) {
    token.border.alpha = 0;
    token.border.visible = false;
    token.border.clear?.();
  }
  for (const graphic of [token.targetArrows, token.targetPips]) {
    if (!graphic) continue;
    graphic.visible = false;
    graphic.clear?.();
  }
}

/* -------------------------------------------- */
/*  Turn greyout                                */
/* -------------------------------------------- */
/** Whose turn it currently is, or null outside a phase, which is when nothing is spent. */
function actingPhaseFactions(scene) {
  const phase = String(scene?.getFlag(SYSTEM_ID, ENCOUNTER_PHASE_FLAG) ?? '');
  return ENCOUNTER_PHASE_FACTIONS[phase] ?? null;
}

/** Desaturate and fade a Character of the acting faction after both of its turn actions are spent. */
function refreshTokenTurnGreyout(token, acting = actingPhaseFactions(token?.scene ?? canvas.scene)) {
  const mesh = token?.mesh;
  if (!mesh || !globalThis.PIXI) return;
  const filters = Array.isArray(mesh.filters) ? mesh.filters : [];
  const withoutGrey = filters.filter(filter => filter?.[TURN_GREY_FILTER] !== true);
  const turn = token.actor?.system?.turn;
  const ended = Array.isArray(acting)
    && token.actor?.type === 'Character'
    && acting.includes(String(token.actor.system.faction.role ?? ''))
    && turn.actionAvailable === false
    && turn.movementAvailable === false;
  if (!ended) {
    if (withoutGrey.length !== filters.length) mesh.filters = withoutGrey.length ? withoutGrey : undefined;
    return;
  }
  if (withoutGrey.length !== filters.length) return;

  const color = new PIXI.ColorMatrixFilter();
  color.desaturate();
  color[TURN_GREY_FILTER] = true;
  const alpha = new PIXI.AlphaFilter(0.8);
  alpha[TURN_GREY_FILTER] = true;
  mesh.filters = [...withoutGrey, color, alpha];
}

/* -------------------------------------------- */
/*  Control indicators                          */
/* -------------------------------------------- */
/**
 * Show an inspection frame without controlling the Token. Keep only one and preserve an existing pathfinding
 * arrow.
 */
export function showFacadeSelection(token) {
  const tokenId = token?.id ?? null;
  if (!tokenId || facadeSelectionTokenId === tokenId) return false;
  clearFacadeSelection();
  facadeSelectionTokenId = tokenId;
  refreshControlIndicator(token);
  return true;
}

/** The token the pretend selection frame is on, so a key press can act on the unit the player last pressed. */
export function facadeSelectedTokenId() {
  return facadeSelectionTokenId;
}

/** Take the pretend selection down, leaving a real selection's own frame in place. */
export function clearFacadeSelection() {
  const tokenId = facadeSelectionTokenId;
  if (!tokenId) return false;
  facadeSelectionTokenId = null;
  refreshControlIndicator(canvas.tokens?.get(tokenId) ?? { id: tokenId });
  return true;
}

function refreshControlIndicator(token, controlled = token?.controlled) {
  if (!token) return;
  const planning = token.actor?.system?.turn?.movementPlanning === true;
  const held = exchangingTokens.has(token.id);
  if (!planning || held) clearPathfindingIndicator(token);
  else if (controlled) showPathfindingIndicator(token);
  // A held unit is mid-action, so it shows neither the arrow nor the selection brackets.
  if (held || pathfindingIndicators.has(token.id) || !wearsSelectionFrame(token, controlled)) {
    clearSelectionIndicator(token);
    return;
  }
  if (!selectionIndicators.has(token.id)) showSelectionIndicator(token);
}

/** The frame stands for the GM's own selection and for the pretend selection a player's press leaves behind. */
function wearsSelectionFrame(token, controlled) {
  if (facadeSelectionTokenId === token.id) return true;
  return controlled === true && game.user.isGM === true;
}

function showPathfindingIndicator(token) {
  if (!canDraw(token) || pathfindingIndicators.has(token.id)) return;
  const layer = overlayLayer(PATHFINDING_LAYER, 999998);
  const texture = PIXI.Texture.from(PATHFINDING_ARROW, { resourceOptions: { scale: 3 } });
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 1);
  layer.addChild(sprite);

  const applySize = () => {
    const current = canvas.tokens?.get(token.id);
    if (!current || sprite.destroyed) return;
    const size = current.w * 0.35;
    sprite.width = size;
    sprite.height = size;
  };
  let onLoaded = null;
  if (texture.baseTexture.valid) applySize();
  else {
    onLoaded = applySize;
    texture.baseTexture.once('loaded', onLoaded);
  }

  const gap = canvas.grid.size * 0.15;
  const lower = canvas.grid.size * 0.3;
  const amplitude = canvas.grid.size * 0.1;
  let phase = 0;
  const tick = () => {
    const current = canvas.tokens?.get(token.id);
    if (!current) return;
    phase += 0.05;
    sprite.position.set(
      current.center.x,
      current.y - gap + lower + (Math.sin(phase) * amplitude)
    );
  };
  tick();
  canvas.app.ticker.add(tick);
  pathfindingIndicators.set(token.id, { sprite, tick, texture, onLoaded });
}

function clearPathfindingIndicator(token) {
  const tokenId = token?.id;
  const entry = tokenId ? pathfindingIndicators.get(tokenId) : null;
  if (!entry) return;
  canvasTicker()?.remove(entry.tick);
  if (entry.onLoaded) entry.texture?.baseTexture?.off('loaded', entry.onLoaded);
  destroyDisplayObject(entry.sprite);
  pathfindingIndicators.delete(tokenId);
}

/* -------------------------------------------- */
/*  Selection frame                             */
/* -------------------------------------------- */
function showSelectionIndicator(token) {
  if (!canDraw(token)) return;
  clearSelectionIndicator(token);

  const layer = overlayLayer(SELECTION_LAYER, 999997);
  const baseTexture = PIXI.Texture.from(SELECTION_FRAME, { resourceOptions: { scale: 3 } });
  const corners = {};
  for (const key of CORNERS) {
    const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
    sprite.anchor.set(...CORNER_ANCHORS[key]);
    layer.addChild(sprite);
    corners[key] = sprite;
  }

  const alive = () => CORNERS.every(key => !corners[key].destroyed);
  const sizeCorners = () => {
    const current = canvas.tokens?.get(token.id);
    if (!current || !alive()) return;
    const size = Math.min(current.w, current.h) / 4;
    for (const key of CORNERS) {
      corners[key].width = size;
      corners[key].height = size;
    }
  };
  const applyFrames = () => {
    if (!alive()) return;
    const halfWidth = baseTexture.width / 2;
    const halfHeight = baseTexture.height / 2;
    const frames = {
      nw: new PIXI.Rectangle(0, 0, halfWidth, halfHeight),
      ne: new PIXI.Rectangle(halfWidth, 0, halfWidth, halfHeight),
      sw: new PIXI.Rectangle(0, halfHeight, halfWidth, halfHeight),
      se: new PIXI.Rectangle(halfWidth, halfHeight, halfWidth, halfHeight)
    };
    for (const key of CORNERS) corners[key].texture = new PIXI.Texture(baseTexture.baseTexture, frames[key]);
    sizeCorners();
  };

  let onLoaded = null;
  if (baseTexture.baseTexture.valid) applyFrames();
  else {
    onLoaded = applyFrames;
    baseTexture.baseTexture.once('loaded', onLoaded);
  }

  const baseOffset = canvas.grid.size * 0.016;
  const amplitude = canvas.grid.size * 0.0278;
  let phase = 0;
  const tick = () => {
    const current = canvas.tokens?.get(token.id);
    if (!current) return;
    phase += 0.035;
    const offset = baseOffset - Math.sin(phase) * amplitude;
    const x0 = current.x - offset;
    const y0 = current.y - offset;
    const x1 = current.x + current.w + offset;
    const y1 = current.y + current.h + offset;
    corners.nw.position.set(x0, y0);
    corners.ne.position.set(x1, y0);
    corners.sw.position.set(x0, y1);
    corners.se.position.set(x1, y1);
  };
  tick();
  canvas.app.ticker.add(tick);
  selectionIndicators.set(token.id, { corners, tick, baseTexture, onLoaded });
}

function clearSelectionIndicator(token) {
  const tokenId = token?.id;
  const entry = tokenId ? selectionIndicators.get(tokenId) : null;
  if (!entry) return;
  canvasTicker()?.remove(entry.tick);
  if (entry.onLoaded) entry.baseTexture?.baseTexture?.off('loaded', entry.onLoaded);
  for (const key of CORNERS) destroyDisplayObject(entry.corners[key]);
  selectionIndicators.delete(tokenId);
}

/* -------------------------------------------- */
/*  Target reticle                              */
/* -------------------------------------------- */
function showTargetIndicator(token) {
  if (!canDraw(token)) return;
  clearTargetIndicator(token);
  const layer = overlayLayer(TARGET_LAYER, 999996);
  const texture = PIXI.Texture.from(TARGET_FRAME, { resourceOptions: { scale: 10 } });
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  layer.addChild(sprite);

  let phase = 0;
  const tick = () => {
    const current = canvas.tokens?.get(token.id);
    if (!current) return;
    sprite.visible = current.visible === true;
    if (!sprite.visible) return;
    phase += 0.0125;
    sprite.position.set(current.center.x, current.center.y);
    if (sprite.texture.baseTexture.valid) {
      const size = Math.min(current.w, current.h) * 0.95 * (1 + Math.sin(phase) * 0.12);
      sprite.width = size;
      sprite.height = size;
    }
  };
  tick();
  canvas.app.ticker.add(tick);
  targetIndicators.set(token.id, { sprite, tick });
}

/** Whether this client's user targets the token; Token#isTargeted is true for any user's target. */
function isOwnTarget(token) {
  return token?.targeted?.has?.(game.user) === true;
}

function clearTargetIndicator(token) {
  const tokenId = token?.id;
  const entry = tokenId ? targetIndicators.get(tokenId) : null;
  if (!entry) return;
  canvasTicker()?.remove(entry.tick);
  destroyDisplayObject(entry.sprite);
  targetIndicators.delete(tokenId);
}

/* -------------------------------------------- */
/*  PIXI lifecycle                              */
/* -------------------------------------------- */
function clearTokenIndicators() {
  exchangingTokens.clear();
  facadeSelectionTokenId = null;
  for (const tokenId of [...selectionIndicators.keys()]) clearSelectionIndicator({ id: tokenId });
  for (const tokenId of [...pathfindingIndicators.keys()]) clearPathfindingIndicator({ id: tokenId });
  for (const tokenId of [...targetIndicators.keys()]) clearTargetIndicator({ id: tokenId });
}

function overlayLayer(name, zIndex) {
  let layer = canvas.stage.children.find(child => child.name === name);
  if (!layer) {
    layer = new PIXI.Container();
    layer.name = name;
    layer.zIndex = zIndex;
    layer.eventMode = 'none';
    canvas.stage.addChild(layer);
  }
  return layer;
}

function canDraw(token) {
  return Boolean(token?.id && globalThis.PIXI && canvas.stage && canvas.app?.ticker && canvas.tokens);
}

function canvasTicker() {
  return canvas.app?.ticker ?? null;
}

function destroyDisplayObject(displayObject) {
  if (!displayObject || displayObject.destroyed) return;
  displayObject.parent?.removeChild?.(displayObject);
  displayObject.destroy?.();
}

/* -------------------------------------------- */
/*  Outline recolour                            */
/* -------------------------------------------- */
/**
 * Recolour the outline baked into a unit's sprite to whatever this scene asks for.
 *
 * A shader rather than a tint, because only the pixels close to the authored outline colour may change. Everything
 * else in the sprite stays exactly as painted.
 */
function applyTokenOutline(token) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed || !globalThis.PIXI?.Filter) return false;
  const colours = readOutlineColours(token.scene ?? token.document?.parent ?? canvas.scene);
  const source = unitRgb(colours?.src);
  const destination = unitRgb(colours?.dst);
  if (!source || !destination || sameColour(source, destination)) {
    removeTokenOutline(token);
    return false;
  }
  const filter = token.emblemOutlineFilter
    ?? (token.emblemOutlineFilter = new PIXI.Filter(undefined, OUTLINE_FRAGMENT, {
      uSrc: source, uDst: destination, uTol: OUTLINE_TOLERANCE
    }));
  filter.uniforms.uSrc = source;
  filter.uniforms.uDst = destination;
  const filters = mesh.filters ?? [];
  if (!filters.includes(filter)) mesh.filters = [...filters, filter];
  return true;
}

/** Drop the recolour from one token, leaving every other filter on its mesh alone. */
function removeTokenOutline(token) {
  const filter = token.emblemOutlineFilter;
  if (!filter || !Array.isArray(token.mesh?.filters)) return;
  token.mesh.filters = token.mesh.filters.filter(entry => entry !== filter);
}

/** Re-read the colours for every placed token, after a scene override or the world default changed. */
export function refreshTokenOutlines(tokens = canvas.tokens?.placeables ?? []) {
  for (const token of tokens) applyTokenOutline(token);
}

function unitRgb(value) {
  const hex = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!hex) return null;
  const number = Number.parseInt(hex[1], 16);
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}

function sameColour(left, right) {
  return left.every((channel, index) => Math.abs(channel - right[index]) < 1e-6);
}

/* -------------------------------------------- */
/*  Effect presentation                         */
/* -------------------------------------------- */
const STATUS_BG_PATH = `systems/${SYSTEM_ID}/assets/status/bg.png`;
const STACK_BADGE_FRACTION = 0.4;
const STACK_BADGE_DESIGN_RADIUS = 32;
const unconfiguredProjectEffects = () => {
  warnUnconfiguredPort('projectEffects', 'configureTokenEffectPresentation');
  return [];
};
let projectEffects = unconfiguredProjectEffects;

/**
 * init/hooks.mjs calls this once with projectFoundryTokenEffects, which lists the status icons a token shows.
 * `presentation/` may not import it directly.
 */
export function configureTokenEffectPresentation(configuration = {}) {
  projectEffects = configuration.projectEffects ?? unconfiguredProjectEffects;
}

/**
 * Draw Emblem's status icons in place of Foundry's token effects. init/hooks.mjs installs it as a libWrapper
 * override of Token#_drawEffects, so `this` is the Token.
 */
export async function drawEmblemTokenEffects() {
  this.effects.renderable = false;
  this.effects.removeChildren().forEach(child => child.destroy());
  this.effects.bg = this.effects.addChild(new PIXI.Graphics());
  this.effects.bg.zIndex = -1;
  this.effects.overlay = null;

  const visible = projectEffects(this).filter(effect => !effect.armor && !effect.mount);
  const overlay = visible.findLast(effect => effect.img && effect.overlay);
  const ordered = visible
    .filter(effect => effect !== overlay)
    .sort((left, right) => Number(right.wield) - Number(left.wield));
  if (overlay) ordered.push(overlay);

  const promises = [];
  for (const [index, effect] of ordered.entries()) {
    if (!effect.img) continue;
    const promise = (effect === overlay
      ? this._drawOverlay(effect.img, effect.tint)
      : this._drawEffect(effect.img, effect.tint)
    ).then(icon => {
      if (!icon) return;
      icon.zIndex = index;
      icon.emblemEffect = effect;
      applyNearestTexture(icon.texture);
    });
    promises.push(promise);
  }

  await Promise.allSettled(promises);
  this.effects.sortChildren();
  this._refreshEffects();
  this.effects.renderable = true;
  this.renderFlags.set({ refreshEffects: true });
}

/**
 * Lay out status icons in fixed slots, with the bottom-left slot kept for the wield icon. init/hooks.mjs installs
 * it as a libWrapper override of Token#_refreshEffects, so `this` is the Token.
 */
export function refreshEmblemTokenEffects() {
  if (!this.effects?.bg) return;
  const scale = canvas.dimensions.uiScale;
  const size = STATUS_ICON_SLOT * scale;
  const tokenHeight = this.document.getSize().height;
  const rows = Math.max(1, Math.floor((tokenHeight / size) + 1e-6));
  const backgroundTexture = PIXI.Texture.from(STATUS_BG_PATH);
  applyNearestTexture(backgroundTexture);

  for (const child of Array.from(this.effects.children)) {
    if (!child.emblemSlotBackground && !child.emblemStackCount) continue;
    this.effects.removeChild(child).destroy();
  }

  const background = this.effects.bg.clear()
    .beginFill('#af9e8aff', backgroundTexture ? 0 : 1)
    .lineStyle(scale, 0x000000, 1);
  const icons = this.effects.children.slice();
  const wieldIcon = icons.find(icon => isStatusIcon(icon, background) && icon.emblemEffect?.wield === true);
  const blockedSlot = wieldIcon ? rows - 1 : -1;
  let index = 0;

  for (const icon of icons) {
    if (!isStatusIcon(icon, background) || icon === wieldIcon) continue;
    if (icon === this.effects.overlay) {
      placeOverlay(this, icon);
      continue;
    }
    let slot = index;
    if (blockedSlot >= 0 && slot >= blockedSlot) slot += 1;
    placeStatusIcon(this, icon, Math.floor(slot / rows) * size, (slot % rows) * size, size, backgroundTexture);
    index += 1;
  }
  if (wieldIcon) placeStatusIcon(this, wieldIcon, 0, tokenHeight - size, size, backgroundTexture);
  addStackCountBadges(this, size);
}

/* -------------------------------------------- */
/*  Icon layout                                 */
/* -------------------------------------------- */
function isStatusIcon(icon, background) {
  return icon !== background && !icon?.emblemSlotBackground && !icon?.emblemStackCount;
}

function placeStatusIcon(token, icon, slotX, slotY, size, backgroundTexture) {
  const scale = canvas.dimensions.uiScale;
  const padding = 1;
  const rectX = slotX + scale - padding;
  const rectY = slotY + scale - padding;
  const rectSize = size - (2 * scale) + (2 * padding);
  if (backgroundTexture) {
    const slotBackground = new PIXI.Sprite(backgroundTexture);
    slotBackground.emblemSlotBackground = true;
    slotBackground.width = rectSize;
    slotBackground.height = rectSize;
    slotBackground.x = rectX;
    slotBackground.y = rectY;
    token.effects.addChildAt(slotBackground, Math.max(0, token.effects.getChildIndex(icon)));
  } else {
    token.effects.bg.drawRoundedRect(rectX, rectY, rectSize, rectSize, (2 * scale) + padding);
  }
  const iconSize = size * (2 / 3);
  const offset = (size - iconSize) / 2;
  icon.width = icon.height = iconSize;
  icon.x = slotX + offset;
  icon.y = slotY + offset;
}

function placeOverlay(token, icon) {
  const { width, height } = token.document.getSize();
  const size = Math.min(width * 0.6, height * 0.6);
  icon.width = icon.height = size;
  icon.position = token.document.getCenterPoint({ x: 0, y: 0 });
  icon.anchor.set(0.5, 0.5);
}

function addStackCountBadges(token, slotSize) {
  const icons = token.effects.children.filter(icon =>
    isStatusIcon(icon, token.effects.bg) && icon !== token.effects.overlay && icon.emblemEffect
  );
  for (const icon of icons) {
    const count = icon.emblemEffect.stackCount;
    if (!icon.emblemEffect.stackable || count <= 1) continue;
    const diameter = slotSize * STACK_BADGE_FRACTION;
    const radius = diameter / 2;
    const slotX = icon.x - (slotSize - icon.width) / 2;
    const slotY = icon.y - (slotSize - icon.height) / 2;
    const badge = new PIXI.Graphics();
    badge.emblemStackCount = true;
    badge.beginFill(0x00AA00, 0.9)
      .lineStyle(STACK_BADGE_DESIGN_RADIUS * 0.12, 0x000000, 9)
      .drawCircle(0, 0, STACK_BADGE_DESIGN_RADIUS);
    const text = new PIXI.Text(String(count), new PIXI.TextStyle({
      fontFamily: 'Signika',
      fontSize: STACK_BADGE_DESIGN_RADIUS * 6.1,
      fill: 0xFFFFFF,
      fontWeight: 'bold',
      stroke: 0x000000,
      strokeThickness: STACK_BADGE_DESIGN_RADIUS * 1.18,
      align: 'center'
    }));
    text.anchor.set(0.5, 0.53);
    const fit = (STACK_BADGE_DESIGN_RADIUS * 2.6) / Math.max(text.width, text.height);
    if (fit < 1) text.scale.set(fit);
    badge.addChild(text);
    badge.scale.set(diameter / badge.getLocalBounds().width);
    badge.x = slotX + slotSize - radius;
    badge.y = slotY + slotSize - radius;
    token.effects.addChild(badge);
  }
}
