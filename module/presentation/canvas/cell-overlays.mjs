/** @layer presentation/canvas */
import { footprintCells } from '../../lib/core/geometry.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { applyNearestTexture } from '../token/rendering.mjs';

/* -------------------------------------------- */
/*  Targeting presentation                      */
/* -------------------------------------------- */
const TARGETING_OVERLAY_NAME = 'emblem-rpg-attack-targeting';
const AREA_OVERLAY_NAME = 'emblem-rpg-activation-area';
const TARGET_COLOR = 0xAB0E0E;
const TARGET_ALPHA = 0.5;
const OCCLUDED_ALPHA = 0.25;
const AREA_FILL_ALPHA = 0.6;
const AREA_LINE_ALPHA = 0.9;
const AREA_LINE_WIDTH = 3;
const TARGETING_TILE_INSET = 4;

const GRID_COLORS = Object.freeze({
  Red: 0xAB0E0E,
  Green: 0x2ECC71,
  Purple: 0x9B59B6,
  Blue: 0x0335FC,
  Orange: 0xD4920E
});

/** Colors used by interaction controls for trade, theft, door and socialize target grids. */
export const INTERACTION_GRID_COLORS = Object.freeze({ trade: 0xD4920E, door: 0x5AAAC8, social: 0x2ECC71 });

/** Pale-blue grid used by placement targeting controls. */
export const PLACEMENT_GRID_COLOR = 0x7DD3FC;

const RALLY_BADGE_STYLE = Object.freeze({
  fontFamily: 'Jersey 10, sans-serif',
  fontSize: 62,
  fill: '#ffffff',
  stroke: '#000000',
  strokeThickness: 6,
  dropShadow: true,
  dropShadowColor: '#000000',
  dropShadowDistance: 0,
  dropShadowBlur: 4
});

let targetingOverlay = null;
let areaOverlay = null;
let rallyBadges = [];

/** Resolve the Item’s targeting color for grid rendering, defaulting to red. */
export function targetingGridColor(name) {
  return GRID_COLORS[String(name ?? '')] ?? TARGET_COLOR;
}

/**
 * Draw the targeting field on the map, above the background and tiles and under the Tokens.
 *
 * Cells whose ground is hidden by terrain height draw at half opacity, because only a flying occupant there is
 * still reachable.
 * @param {object} grid Cell size, targetable cells, height-occluded keys, and the authored colour.
 */
export function drawAttackTargetingGrid(grid) {
  clearAttackTargetingGrid();
  if (!canDraw() || !grid?.gridSize || !Array.isArray(grid.targetableCells)) return;
  targetingOverlay = createSortedOverlay(TARGETING_OVERLAY_NAME, 641);

  const color = Number.isFinite(grid.color) ? grid.color : TARGET_COLOR;
  const occluded = grid.flyersOnlyKeys instanceof Set ? grid.flyersOnlyKeys : new Set();
  const plain = grid.targetableCells.filter(cell => !occluded.has(`${cell.x},${cell.y}`));
  const dimmed = grid.targetableCells.filter(cell => occluded.has(`${cell.x},${cell.y}`));
  if (plain.length) targetingOverlay.addChild(tileBatch(plain, grid.gridSize, color, TARGET_ALPHA));
  if (dimmed.length) targetingOverlay.addChild(tileBatch(dimmed, grid.gridSize, color, OCCLUDED_ALPHA));
  addToScene(targetingOverlay);
}

/** Remove the current targeting field. */
export function clearAttackTargetingGrid() {
  targetingOverlay = destroyTargetingOverlay(targetingOverlay);
}

/**
 * Draw the cells an aimed activation covers, so the player confirms against what will actually resolve.
 * @param {object} area Cell size, covered cells, and the authored colour.
 */
export function drawActivationAreaOverlay(area) {
  clearActivationAreaOverlay();
  if (!canDraw() || !area?.gridSize || !Array.isArray(area.cells) || !area.cells.length) return;
  areaOverlay = createSortedOverlay(AREA_OVERLAY_NAME, 642);

  const color = Number.isFinite(area.color) ? area.color : TARGET_COLOR;
  const graphics = new PIXI.Graphics();
  graphics.beginFill(color, AREA_FILL_ALPHA);
  graphics.lineStyle(AREA_LINE_WIDTH, color, AREA_LINE_ALPHA);
  for (const cell of area.cells) {
    graphics.drawRect(cell.x * area.gridSize, cell.y * area.gridSize, area.gridSize, area.gridSize);
  }
  graphics.endFill();
  areaOverlay.addChild(graphics);
  addToScene(areaOverlay);
}

/** Remove the aimed activation's area overlay. */
export function clearActivationAreaOverlay() {
  areaOverlay = destroyTargetingOverlay(areaOverlay);
}

/**
 * Show the player which units a multi-target activation has collected so far.
 * @param {readonly string[]} tokenUuids Token UUIDs currently selected.
 */
export function markTargetedTokens(tokenUuids = []) {
  const selected = new Set(tokenUuids.map(String));
  for (const token of canvas.tokens?.placeables ?? []) {
    const uuid = String(token?.document?.uuid ?? '');
    const wanted = selected.has(uuid);
    if ((token.targeted?.has?.(game.user) === true) === wanted) continue;
    token.setTarget?.(wanted, { releaseOthers: false });
  }
}

/**
 * Float the rank letter of every ally a Rally could reach over that ally's Token.
 *
 * Each badge is a child of the Token it labels, so it follows a unit that moves while targeting is open.
 * @param {readonly object[]} entries Token UUID and rank letter for each eligible ally.
 */
export function drawRallySupportBadges(entries = []) {
  clearRallySupportBadges();
  if (!canDraw() || !entries.length) return;
  const byUuid = new Map(entries.map(entry => [String(entry.tokenUuid), String(entry.letter ?? '')]));
  for (const token of canvas.tokens?.placeables ?? []) {
    const letter = byUuid.get(String(token?.document?.uuid ?? ''));
    if (!letter) continue;
    const badge = rallyBadge(letter);
    badge.position.set(token.w / 2, token.h / 2);
    token.addChild(badge);
    rallyBadges.push(badge);
  }
}

/** Remove the rank letters, leaving any other Token children untouched. */
export function clearRallySupportBadges() {
  for (const badge of rallyBadges) {
    if (badge?.destroyed) continue;
    badge.parent?.removeChild?.(badge);
    badge.destroy?.({ children: true });
  }
  rallyBadges = [];
}

/** Remove every targeting drawing and target mark. onCanvasTearDownAttackTargeting calls it before the canvas goes. */
export function disposeAttackTargetingPresentation() {
  clearAttackTargetingGrid();
  clearActivationAreaOverlay();
  clearRallySupportBadges();
  markTargetedTokens([]);
}

/* -------------------------------------------- */
/*  Canvas placement                            */
/* -------------------------------------------- */
/**
 * Build one non-interactive canvas overlay and attach it to the first parent that will take it.
 * Primary-group children sort by elevation, then sortLayer, then sort. Set all three so the overlay sits above tiles
 * and drawings and below Tokens.
 * @param {string} name                 Container name, which is also how it is found again.
 * @param {number} sortLayer            Primary-group sort layer.
 * @param {Array} [parents]             Candidate parents in order of preference. With none, it stays detached.
 * @returns {object} The overlay container.
 */
export function createSortedOverlay(name, sortLayer, parents = []) {
  const container = new PIXI.Container();
  container.name = name;
  container.eventMode = 'none';
  container.interactiveChildren = false;
  container.elevation = 0;
  container.sortLayer = sortLayer;
  container.sort = 0;
  for (const parent of parents) {
    if (!parent || parent.destroyed || typeof parent.addChild !== 'function') continue;
    parent.addChild(container);
    break;
  }
  return container;
}

/**
 * Draw one square per cell into an already-styled Graphics.
 * @param {object} graphics             Graphics with its line and fill styles set.
 * @param {Iterable} cells              Grid cells as `{x, y}`.
 * @param {number} gridSize             Canvas pixels per square.
 * @param {number} [inset]              Pixels held back from each grid line.
 * @returns {object} The same Graphics.
 */
export function fillCells(graphics, cells, gridSize, inset = 0) {
  for (const cell of cells) {
    if (!Number.isFinite(cell?.x) || !Number.isFinite(cell?.y)) continue;
    graphics.drawRect(
      (cell.x * gridSize) + inset,
      (cell.y * gridSize) + inset,
      gridSize - (inset * 2),
      gridSize - (inset * 2)
    );
  }
  return graphics;
}

function rallyBadge(letter) {
  const badge = new PIXI.Text(letter, { ...RALLY_BADGE_STYLE });
  badge.anchor.set(0.5, 0.5);
  badge.eventMode = 'none';
  return badge;
}

function tileBatch(cells, gridSize, color, alpha) {
  const graphics = new PIXI.Graphics();
  graphics.alpha = alpha;
  graphics.beginFill(color, 1);
  fillCells(graphics, cells, gridSize, TARGETING_TILE_INSET);
  graphics.endFill();
  return graphics;
}

function destroyTargetingOverlay(container) {
  if (!container || container.destroyed) return null;
  container.parent?.removeChild?.(container);
  container.destroy?.({ children: true });
  return null;
}

/**
 * Add an overlay to the primary canvas group (`canvas.environment.children[0]`). The fallback puts it in the
 * rendered group just above the fog layer, where fog cannot cover it.
 */
function addToScene(container) {
  const sceneLayer = canvas.environment?.children?.[0];
  if (sceneLayer && !sceneLayer.destroyed) {
    sceneLayer.addChild(container);
    return;
  }
  if (canvas.rendered?.addChild) {
    const visibilityIndex = canvas.rendered.children?.indexOf(canvas.visibility) ?? -1;
    if (visibilityIndex >= 0) canvas.rendered.addChildAt(container, visibilityIndex + 1);
    else canvas.rendered.addChild(container);
    return;
  }
  canvas.stage.addChild(container);
}

function canDraw() {
  return Boolean(globalThis.PIXI && canvas.ready && (canvas.environment || canvas.rendered || canvas.stage));
}

/* -------------------------------------------- */
/*  Overlay configuration                       */
/* -------------------------------------------- */
const MOVEMENT_OVERLAY_NAME = 'emblem-movement-movementOverlay';
const GRID_LAYER_NAME = 'emblem-movement-grid';
const MOVEMENT_TILE_INSET = 4;
const MOVEMENT_COLOR = 0x0335fc;
const START_COLOR = 0x037bfc;
const ATTACK_COLOR = 0xAB0E0E;
const GREY_RANGE_COLOR = '#7e899907';
const RULER_PATH_COLOR = 0x78C2FF;
const RULER_GRID_COLOR = 0x0066FF;
const RULER_SETTLE_DELAY = 50;
const HINT_ELEVATION = 1e6;
const HINT_SORT_LAYER = 9999;
const HINT_PADDING = 4;
const HINT_STACK_GAP = 2;
const HINT_ALPHA = 0.9;
const HINT_MIN_SIZE = 16;
const HINT_GRID_FRACTION = 0.15;
const HINT_IMAGES = Object.freeze({
  effective: `systems/${SYSTEM_ID}/assets/ui/danger.png`,
  stealable: `systems/${SYSTEM_ID}/assets/ui/stealable.png`
});
let movementOverlay = null;
let drawings = [];
let hintSprites = [];
let greyReaches = new Map();
let greyDrawing = null;
let lockElement = null;
let lockFrame = null;

/* -------------------------------------------- */
/*  Canvas lifecycle                            */
/* -------------------------------------------- */
/**
 * On canvasReady, rebuild the empty movement overlay for the new scene and show the "Controlling" banner for the
 * current movement lock, or for a companion module (such as the Enemy AI) that holds the map for a phase.
 */
export function onCanvasReadyMovementPresentation(lock = null, localUserId = '', drivenHold = null) {
  destroyMovementOverlay();
  ensureOverlay();
  renderMovementLock(lock, localUserId, drivenHold);
}

/** Remove every movement drawing before the current Canvas is discarded. */
export function onCanvasTearDownMovementPresentation() {
  destroyMovementOverlay();
}

/** Redraw the "Controlling" banner when the movement lock or the companion-module hold setting changes. */
export function onMovementLockSetting(lock, localUserId = '', drivenHold = null) {
  renderMovementLock(lock, localUserId, drivenHold);
}

/* -------------------------------------------- */
/*  Ruler presentation                          */
/* -------------------------------------------- */
/** Apply Emblem’s pale-blue path style to Foundry’s movement ruler. */
export function applyMovementRulerPathStyle(ruler, style) {
  if (ruler?.token?.actor?.system?.turn?.movementPlanning !== true) return style;
  return { ...style, color: RULER_PATH_COLOR, alpha: 0.8 };
}

/** Apply Emblem’s blue cell style to Foundry’s movement ruler. */
export function applyMovementRulerGridStyle(ruler, style) {
  if (ruler?.token?.actor?.system?.turn?.movementPlanning !== true) return style;
  return { ...style, color: RULER_GRID_COLOR, alpha: 0.4 };
}

/**
 * Mark the token's movement ruler as held, so it stays drawn from the drag through the move animation.
 * ui/controls/drag-route.mjs calls it as a pathed drag starts, drops and finishes.
 */
export function activateMovementRuler(token) {
  if (!token) return;
  token._emblemMovementRulerActive = true;
  token._emblemMovementRulerDismissed = false;
  token._emblemMovementRulerGeneration = Number(token._emblemMovementRulerGeneration ?? 0) + 1;
}

/** Keep Foundry from rebuilding a held ruler against the Token's animated position. */
export function movementRulerRefreshMode(token) {
  if (!token || token.isDragged) return 'normal';
  if (token.actor?.system?.turn?.movementPlanning !== true) return 'normal';
  if (token._emblemMovementRulerDismissed && token.ruler) return 'clear';
  const animating = token.animationContexts?.has?.(token.movementAnimationName) === true;
  return token._emblemMovementRulerActive && animating ? 'freeze' : 'normal';
}

/**
 * Clear a held ruler after the movement animation has finished. The first short wait gives Foundry time to start
 * the token's move animation; the second lets the token's last animation frame draw before the ruler goes.
 */
export function scheduleMovementRulerCleanup(token) {
  if (!token) return;
  const generation = token._emblemMovementRulerGeneration;
  setTimeout(() => {
    if (token._emblemMovementRulerGeneration !== generation) return;
    const animating = token.animationContexts?.has?.(token.movementAnimationName) === true;
    const animation = animating ? token.movementAnimationPromise : null;
    if (animation?.then) {
      Promise.resolve(animation).then(
        () => setTimeout(() => dismissMovementRuler(token, generation), RULER_SETTLE_DELAY),
        () => setTimeout(() => dismissMovementRuler(token, generation), RULER_SETTLE_DELAY)
      );
      return;
    }
    setTimeout(() => dismissMovementRuler(token, generation), RULER_SETTLE_DELAY);
  }, RULER_SETTLE_DELAY);
}

/* -------------------------------------------- */
/*  Plan rendering                              */
/* -------------------------------------------- */
/**
 * Draw movement reach in blue and attack reach in red from the pathfinding graph, with the starting footprint
 * marked.
 */
export function drawMovementPlan(snapshot, graph, { attackReach = true } = {}) {
  clearMovementPlan();
  const range = paintRange(snapshot, graph, MOVEMENT_COLOR, START_COLOR, attackReach);
  if (!range) return;
  drawings.push(range);
}

/** Remove the current movement range and hint icons. The movement overlay itself stays for reuse. */
export function clearMovementPlan() {
  for (const drawing of drawings) destroyDisplayObject(drawing);
  drawings = [];
  clearMovementHints();
}

/* -------------------------------------------- */
/*  Hostile hints                               */
/* -------------------------------------------- */
/**
 * Mark the hostiles a plan singled out: the danger icon in a Token's top-right corner, and the steal dot
 * stacked below it rather than drawn over it where both apply.
 * @param {readonly object[]} hints One `{x, y, width, effective, stealable}` per marked Token, in grid units.
 * @param {number} gridSize Canvas pixels per square.
 * @returns {number} How many icons were drawn.
 */
export function drawMovementHints(hints = [], gridSize) {
  clearMovementHints();
  if (!canDraw() || !(gridSize > 0)) return 0;
  const iconSize = Math.max(HINT_MIN_SIZE, gridSize * HINT_GRID_FRACTION);
  for (const hint of hints) {
    let stack = 0;
    if (hint.effective) stack += drawHintSprite(HINT_IMAGES.effective, hint, gridSize, iconSize, stack);
    if (hint.stealable) drawHintSprite(HINT_IMAGES.stealable, hint, gridSize, iconSize, stack);
  }
  return hintSprites.length;
}

/** Take every hint icon down. */
function clearMovementHints() {
  for (const sprite of hintSprites) destroyDisplayObject(sprite);
  hintSprites = [];
}

function drawHintSprite(image, hint, gridSize, iconSize, stack) {
  const sprite = PIXI.Sprite.from(image);
  if (sprite.texture) applyNearestTexture(sprite.texture);
  sprite.width = iconSize;
  sprite.height = iconSize;
  sprite.x = (hint.x * gridSize) + (hint.width * gridSize) - iconSize - HINT_PADDING;
  sprite.y = (hint.y * gridSize) + HINT_PADDING + (stack * (iconSize + HINT_STACK_GAP));
  sprite.alpha = HINT_ALPHA;
  sprite.eventMode = 'none';
  sprite.elevation = HINT_ELEVATION;
  sprite.sortLayer = HINT_SORT_LAYER;
  sprite.sort = HINT_SORT_LAYER;
  sprite.emblemHintImage = image;
  addToScene(sprite);
  hintSprites.push(sprite);
  return 1;
}

/* -------------------------------------------- */
/*  Inspected range                             */
/* -------------------------------------------- */
/**
 * Draw one unit's grey reach, which stays up and can be shown for several units at once.
 *
 * During Free Exploration a unit has unlimited movement (`projectMovementSnapshot` in
 * `foundry/adapters/projections/movement.mjs`), so nothing is drawn and any grey reach that unit already had is
 * taken down.
 */
export function drawGreyMovementGrid(tokenId, snapshot, graph) {
  if (!tokenId) return false;
  const had = greyReaches.delete(tokenId);
  if (snapshot?.exploring === true || !snapshot?.gridSize || !graph || !ensureOverlay()) {
    if (had) repaintGreyReaches();
    return false;
  }
  const cells = rangeCells(graph);
  greyReaches.set(tokenId, {
    gridSize: snapshot.gridSize,
    reach: [...cells.movement, ...cells.start],
    attack: cells.attack,
    flyersOnlyAttack: cells.flyersOnlyAttack
  });
  repaintGreyReaches();
  return true;
}

/** Report whether one unit currently shows a grey reach. */
export function hasGreyMovementGrid(tokenId) {
  return greyReaches.has(tokenId);
}

/** Remove one unit's grey reach, leaving every other one drawn. */
export function clearGreyMovementGrid(tokenId) {
  if (!greyReaches.delete(tokenId)) return false;
  repaintGreyReaches();
  return true;
}

/** Remove every grey reach on the map. */
export function clearGreyMovementGrids() {
  if (greyReaches.size === 0) return false;
  greyReaches = new Map();
  repaintGreyReaches();
  return true;
}

/**
 * Merge every shown grey reach into one drawing, one square per cell. A cell any of those units can attack shows
 * red and covers grey outright, so overlapping reaches never stack their opacity.
 */
function repaintGreyReaches() {
  destroyDisplayObject(greyDrawing);
  greyDrawing = null;
  if (greyReaches.size === 0) return;
  const reach = new Map();
  const attack = new Map();
  const flyersOnlyAttack = new Map();
  let gridSize = 0;
  for (const entry of greyReaches.values()) {
    gridSize = entry.gridSize;
    for (const cell of entry.reach) reach.set(`${cell.x},${cell.y}`, cell);
    for (const cell of entry.attack) attack.set(`${cell.x},${cell.y}`, cell);
    for (const cell of entry.flyersOnlyAttack) flyersOnlyAttack.set(`${cell.x},${cell.y}`, cell);
  }
  for (const key of attack.keys()) flyersOnlyAttack.delete(key);
  for (const key of [...attack.keys(), ...flyersOnlyAttack.keys()]) reach.delete(key);
  greyDrawing = paintCells(gridSize, [
    [reach.values(), GREY_RANGE_COLOR],
    [attack.values(), ATTACK_COLOR],
    [flyersOnlyAttack.values(), ATTACK_COLOR, 0.5]
  ]);
}

/* -------------------------------------------- */
/*  Drawing helpers                             */
/* -------------------------------------------- */
function paintRange(snapshot, graph, movementColor, startColor, attackReach = true) {
  if (!canDraw() || !snapshot?.gridSize || !graph) return null;
  const cells = rangeCells(graph, attackReach);
  return paintCells(snapshot.gridSize, [
    [cells.movement, movementColor],
    [cells.start, startColor],
    [cells.attack, ATTACK_COLOR],
    [cells.flyersOnlyAttack, ATTACK_COLOR, 0.5]
  ]);
}

/** Split a pathfinding graph into its movement, starting footprint, attack and flyers-only attack cells. */
function rangeCells(graph, attackReach = true) {
  const start = footprintCells(graph.start?.x, graph.start?.y, graph.footprint?.width, graph.footprint?.height);
  const startKeys = new Set(start.map(cell => `${cell.x},${cell.y}`));
  const movementKeys = new Set(graph.walkableTiles.map(cell => `${cell.x},${cell.y}`));
  const flyersOnlyKeys = new Set((graph.flyersOnlyTiles ?? []).map(cell => `${cell.x},${cell.y}`));
  const attackCells = attackReach
    ? (graph.attackableTiles ?? []).filter(cell => !movementKeys.has(`${cell.x},${cell.y}`))
    : [];
  return {
    movement: graph.walkableTiles.filter(cell => !startKeys.has(`${cell.x},${cell.y}`)),
    start,
    attack: attackCells.filter(cell => !flyersOnlyKeys.has(`${cell.x},${cell.y}`)),
    flyersOnlyAttack: attackCells.filter(cell => flyersOnlyKeys.has(`${cell.x},${cell.y}`))
  };
}

/** Draw colored cell batches into one Graphics on the movement grid layer, later batches on top. */
function paintCells(gridSize, batches) {
  const layer = ensureOverlay()?.gridLayer;
  if (!layer) return null;
  const range = new PIXI.Graphics();
  range.alpha = 0.4;
  for (const [cells, color, alpha] of batches) drawCells(range, cells, gridSize, color, alpha);
  layer.addChild(range);
  return range;
}

function drawCells(graphics, cells, gridSize, color, alpha = 1) {
  graphics.beginFill(color, alpha);
  for (const cell of cells) {
    graphics.drawRect(
      (cell.x * gridSize) + MOVEMENT_TILE_INSET,
      (cell.y * gridSize) + MOVEMENT_TILE_INSET,
      gridSize - (MOVEMENT_TILE_INSET * 2),
      gridSize - (MOVEMENT_TILE_INSET * 2)
    );
  }
  graphics.endFill();
}

function dismissMovementRuler(token, generation) {
  if (token._emblemMovementRulerGeneration !== generation) return;
  token._emblemMovementRulerActive = false;
  token._emblemMovementRulerDismissed = true;
  token.renderFlags?.set?.({ refreshRuler: true, refreshState: true });
}

/* -------------------------------------------- */
/*  Movement-lock banner                        */
/* -------------------------------------------- */
/**
 * Work out what the "Controlling" banner shows from the movement lock and any companion-module hold. With neither,
 * there is no banner.
 * @param {object|null} lock The normalized control lock, or null once released.
 * @param {string} localUserId The viewing user, whose own portrait is not repeated back to them.
 * @param {object|null} drivenHold The hold a companion module (such as the Enemy AI) takes for a phase. It is shown
 *   instead of the lock.
 * @returns {{visible: boolean, user?: string, token?: string, image?: string}}
 */
export function projectLockBanner(lock, localUserId = '', drivenHold = null) {
  const standing = drivenHold ?? lock;
  if (!standing?.holderId) return { visible: false };
  const showImage = Boolean(standing.tokenImg) && (Boolean(drivenHold) || standing.holderId !== localUserId);
  return {
    visible: true,
    user: drivenHold ? (drivenHold.label || 'Automation') : (lock?.holderName ?? 'Someone'),
    token: standing.tokenName || 'a Token',
    image: showImage ? String(standing.tokenImg) : ''
  };
}

function renderMovementLock(lock, localUserId, drivenHold = null) {
  const element = ensureLockElement();
  if (!element) return;
  const banner = projectLockBanner(lock, localUserId, drivenHold);
  cancelLockFrame();
  if (!banner.visible) {
    element.classList.remove('is-visible');
    return;
  }
  element.querySelector('.emblem-user-lock-user').textContent = banner.user;
  element.querySelector('.emblem-user-lock-token').textContent = banner.token;
  const image = element.querySelector('.emblem-user-lock-actor-img');
  if (banner.image) {
    image.src = banner.image;
    image.hidden = false;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
  }
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== 'function') {
    element.classList.add('is-visible');
    return;
  }
  lockFrame = raf(() => {
    lockFrame = null;
    element.classList.add('is-visible');
  });
}

/**
 * Showing the banner waits one frame so its CSS transition plays. A release during that frame cancels the pending
 * show, so the banner doesn't come back after it.
 */
function cancelLockFrame() {
  if (lockFrame === null) return;
  globalThis.cancelAnimationFrame?.(lockFrame);
  lockFrame = null;
}

function ensureLockElement() {
  if (lockElement?.isConnected) return lockElement;
  const element = globalThis.document?.createElement?.('aside');
  if (!element) return null;
  element.id = 'emblem-user-lock';
  element.setAttribute('aria-live', 'polite');
  element.innerHTML = `
    <div class="emblem-user-lock-main">
      <span class="emblem-user-lock-icon fa-spin" aria-hidden="true"></span>
      <span class="emblem-user-lock-label">
        <span class="emblem-user-lock-user"></span>
        <span class="emblem-user-lock-sep"> Controlling: </span>
        <span class="emblem-user-lock-token"></span>
      </span>
      <img class="emblem-user-lock-actor-img" alt="" hidden />
    </div>`;
  document.body?.appendChild?.(element);
  lockElement = element;
  return element;
}

/* -------------------------------------------- */
/*  PIXI lifecycle                              */
/* -------------------------------------------- */
function ensureOverlay() {
  if (movementOverlay && !movementOverlay.destroyed) return movementOverlay;
  if (!canDraw()) return null;

  movementOverlay = createSortedOverlay(MOVEMENT_OVERLAY_NAME, 640);
  movementOverlay.gridLayer = movementOverlay.addChild(new PIXI.Container());
  movementOverlay.gridLayer.name = GRID_LAYER_NAME;

  // Same placement as addToScene: the primary canvas group, or just above the fog layer.
  const sceneLayer = canvas.environment?.children?.[0];
  if (sceneLayer && !sceneLayer.destroyed) sceneLayer.addChild(movementOverlay);
  else if (canvas.rendered?.addChild) {
    const visibilityIndex = canvas.rendered.children?.indexOf(canvas.visibility) ?? -1;
    if (visibilityIndex >= 0) canvas.rendered.addChildAt(movementOverlay, visibilityIndex + 1);
    else canvas.rendered.addChild(movementOverlay);
  } else canvas.stage.addChild(movementOverlay);
  return movementOverlay;
}

/** A named sibling layer above the grid tiles and under the Tokens, created on first use and reused after. */
export function movementOverlayLayer(name) {
  const overlay = ensureOverlay();
  if (!overlay) return null;
  if (overlay[name] && !overlay[name].destroyed) return overlay[name];
  const layer = overlay.addChild(new PIXI.Container());
  layer.name = name;
  layer.eventMode = 'none';
  layer.interactiveChildren = false;
  overlay[name] = layer;
  return layer;
}

function destroyMovementOverlay() {
  clearMovementPlan();
  clearGreyMovementGrids();
  destroyDisplayObject(movementOverlay, true);
  movementOverlay = null;
}

function destroyDisplayObject(displayObject, children = false) {
  if (!displayObject || displayObject.destroyed) return;
  displayObject.parent?.removeChild?.(displayObject);
  displayObject.destroy?.(children ? { children: true } : undefined);
}
