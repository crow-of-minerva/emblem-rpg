/** @layer presentation/canvas */
import { CROSSING_DIRECTIONS, parseTerrainKey, terrainKey } from '../../contracts/domains/terrain.mjs';
import { collectionValues, hexColor } from '../../lib/core/runtime.mjs';
import { cellCenter } from '../../lib/core/geometry.mjs';
import { trimmedImageElement } from '../../lib/dom/image-trim.mjs';
import { SOUND_IDS } from '../audio/sound-database.mjs';
import { applyNearestTexture } from '../token/rendering.mjs';
import { createSortedOverlay } from './cell-overlays.mjs';
import { recordDiagnostic } from '../../contracts/protocol.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Canvas lifecycle                            */
/* -------------------------------------------- */
const OVERLAY_NAME = 'emblem-terrain-overlay';
const ANNOTATION_OVERLAY_NAME = 'emblem-terrain-annotation-overlay';
const SORT_BELOW_TOKENS = 650;
const SORT_ABOVE_TOKENS = 750;
const TELEPORT_COST_STYLE = Object.freeze({
  standard: Object.freeze({ color: '#ff5a5a', caption: 'Action', size: 0.26, drop: 0.344 }),
  bonus: Object.freeze({ color: '#3fe0cf', caption: 'Bns Action', size: 0.26, drop: 0.344 }),
  movement: Object.freeze({ color: '#ffffff', caption: null, size: 0.42, drop: 0.219 })
});
const TELEPORT_LETTER_RISE = 0.30;
const SPAWN_PAN_MS = 400;
let overlay = null;
let annotationOverlay = null;
let annotationsVisible = false;
let spawnGeneration = 0;
const spawnArt = new Map();
let reachableTeleports = null;
let crossingArrows = null;
const CROSSING_ARROW_STEPS = Object.freeze({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] });
const CROSSING_ARROW_LENGTH = 0.075;
const CROSSING_ARROW_HALF_WIDTH = 0.045;
const CROSSING_ARROW_THICKNESS = 0.022;
const CROSSING_ARROW_ALPHA = 0.9;
const FOOTSTEPS_GLYPH = '\uf54b';
const CROSSING_BAND_COLORS = Object.freeze({
  'very-high-chance': 0x00d200,
  'high-chance': 0xa6e18b,
  'medium-chance': 0xffe600,
  'low-chance': 0xec2626
});

/** Build the authored terrain presentation for the current Scene. */
function rebuildTerrainVisualization(state = { cells: [], zones: {} }, diagnostics = null) {
  destroyOverlay();
  const root = ensureOverlay();
  if (!root) return;
  const annotationRoot = ensureAnnotationOverlay();
  if (!annotationRoot) return;
  const gridSize = Number(canvas.grid?.size) || 0;
  if (!gridSize) return;

  const ground = root.addChild(new PIXI.Container());
  ground.name = 'emblem-terrain-authoring-markings';
  ground.visible = annotationsVisible;
  const objectives = root.addChild(new PIXI.Container());
  const annotations = annotationRoot.addChild(new PIXI.Container());
  annotations.name = 'emblem-terrain-annotations';
  annotations.visible = annotationsVisible;

  drawObstacleHatch(ground, state.cells, gridSize);
  drawZoneOverlays(ground, state.cells, state.zones, gridSize);
  drawSceneWalls(ground);
  drawObjectiveMarkers(objectives, state.cells, gridSize);
  void drawSpawnMarkers(ground, state.cells, gridSize, diagnostics);
  drawTransitionMarkers(annotations, state.cells, gridSize);
  drawCellInformation(annotations, state.cells, gridSize);
}

/**
 * Light the teleport squares a movement plan can reach, and their far sides with them.
 *
 * The letters drawn by the Terrain Builder's annotations stay hidden in play. This is the play-time layer, and it
 * shows a pair only once one of its ends is somewhere the unit could stand.
 * @param {readonly object[]} pads Teleport pads with their square, letter, price and exit.
 * @param {Iterable<string>} reachable Cell keys the movement plan covers.
 * @returns {number} How many squares were lit.
 */
export function showReachableTeleports(pads = [], reachable = []) {
  clearReachableTeleports();
  const gridSize = Number(canvas.grid?.size) || 0;
  const root = ensureAnnotationOverlay();
  if (!gridSize || !root) return 0;
  const keys = reachable instanceof Set ? reachable : new Set(reachable);
  const lit = [];
  for (const pad of pads) {
    const own = `${pad.x},${pad.y}`;
    const far = pad.exit ? `${pad.exit.x},${pad.exit.y}` : '';
    if (!keys.has(own) && !(far && keys.has(far))) continue;
    lit.push({ x: pad.x, y: pad.y, transition: 'teleport', teleportLetter: pad.letter,
      teleportCost: pad.cost, teleportMov: pad.movementCost });
    if (pad.exit) {
      lit.push({ x: pad.exit.x, y: pad.exit.y, transition: 'teleport', teleportLetter: pad.letter,
        teleportCost: pad.cost, teleportMov: pad.movementCost });
    }
  }
  if (!lit.length) return 0;
  reachableTeleports = root.addChild(new PIXI.Container());
  reachableTeleports.name = 'emblem-terrain-reachable-teleports';
  drawTransitionMarkers(reachableTeleports, lit, gridSize);
  return lit.length;
}

/**
 * Draw an arrow out of every square a crossing can be attempted from, coloured by how likely it is.
 *
 * One arrow per square and direction at the best odds available, so a fork in a bridge network shows as one
 * offer rather than as several overlapping ones.
 * @param {readonly object[]} crossings One entry per offer, carrying its direction and success band.
 * @returns {number} How many arrows were drawn.
 */
export function drawCrossingArrows(crossings = []) {
  clearCrossingArrows();
  const gridSize = Number(canvas.grid?.size) || 0;
  const layer = ensureAnnotationOverlay();
  if (!gridSize || !layer || !crossings.length) return 0;
  const length = gridSize * CROSSING_ARROW_LENGTH;
  const halfWidth = gridSize * CROSSING_ARROW_HALF_WIDTH;
  const thickness = Math.max(2, gridSize * CROSSING_ARROW_THICKNESS);
  const arrows = new PIXI.Graphics();
  arrows.alpha = CROSSING_ARROW_ALPHA;
  for (const crossing of crossings) {
    const [dx, dy] = CROSSING_ARROW_STEPS[crossing.direction] ?? [0, 0];
    if (!dx && !dy) continue;
    const edgeX = (crossing.from.x + 0.5 + (dx * 0.5)) * gridSize;
    const edgeY = (crossing.from.y + 0.5 + (dy * 0.5)) * gridSize;
    const tipX = edgeX + (dx * length * 0.55);
    const tipY = edgeY + (dy * length * 0.55);
    const backX = edgeX - (dx * length * 0.45);
    const backY = edgeY - (dy * length * 0.45);
    const spreadX = -dy * halfWidth;
    const spreadY = dx * halfWidth;
    arrows.lineStyle({
      width: thickness,
      color: CROSSING_BAND_COLORS[crossing.band] ?? CROSSING_BAND_COLORS['low-chance'],
      alpha: 1,
      cap: globalThis.PIXI?.LINE_CAP?.ROUND ?? 'round',
      join: globalThis.PIXI?.LINE_JOIN?.ROUND ?? 'round'
    });
    arrows.moveTo(backX + spreadX, backY + spreadY);
    arrows.lineTo(tipX, tipY);
    arrows.lineTo(backX - spreadX, backY - spreadY);
  }
  arrows.name = 'emblem-terrain-crossing-arrows';
  crossingArrows = layer.addChild(arrows);
  return crossings.length;
}

/** Take the crossing arrows down again. */
export function clearCrossingArrows() {
  if (!crossingArrows) return false;
  destroyDisplayObject(crossingArrows);
  crossingArrows = null;
  return true;
}

/** Take the play-time transition letters down again. */
export function clearReachableTeleports() {
  if (!reachableTeleports) return false;
  destroyDisplayObject(reachableTeleports);
  reachableTeleports = null;
  return true;
}

/**
 * Show or hide the Terrain Builder's cell annotations and ground markings (obstacles, zones, walls and spawn points)
 * together. Objective markers stay visible either way. The Terrain Builder and the terrain tips keybinding call it.
 */
export function setTerrainVisualizationVisible(visible) {
  annotationsVisible = Boolean(visible);
  const annotationLayer = annotationOverlay?.getChildByName?.('emblem-terrain-annotations');
  const markings = overlay?.getChildByName?.('emblem-terrain-authoring-markings');
  if (annotationLayer) annotationLayer.visible = annotationsVisible;
  if (markings) markings.visible = annotationsVisible;
}

/** Draw the scene's terrain when the canvas becomes ready. */
export function onCanvasReadyTerrainPresentation(state, diagnostics = null) {
  rebuildTerrainVisualization(state, diagnostics);
}

/**
 * Rebuild the terrain drawing after the scene's terrain flags or walls change. refreshTerrainRuntime in
 * init/hooks.mjs calls it.
 */
export function onTerrainPresentationChanged(state, diagnostics = null) {
  rebuildTerrainVisualization(state, diagnostics);
}

/** Release every terrain display object before Canvas teardown. */
export function onCanvasTearDownTerrainPresentation() {
  destroyOverlay();
}

/* -------------------------------------------- */
/*  Spawn arrival                               */
/* -------------------------------------------- */

/**
 * Ping the spawn square where a unit just arrived. Every client runs this for the terrain spawn message.
 *
 * The camera only moves when the square is off screen, so an arrival in view never yanks the map away from
 * whoever is watching it.
 * @param {{x: number, y: number}} message The arrival point in scene coordinates.
 * @returns {Promise<boolean>}
 */
export async function showTerrainSpawnArrival(message) {
  const canvas = globalThis.canvas;
  if (!canvas.ready || pageHidden()) return false;
  const point = { x: Number(message?.x) || 0, y: Number(message?.y) || 0 };
  const screen = canvas.app?.screen;
  const projected = canvas.stage?.toGlobal?.(point);
  const onScreen = Boolean(screen && projected
    && projected.x >= 0 && projected.y >= 0
    && projected.x <= screen.width && projected.y <= screen.height);
  if (!onScreen) await canvas.animatePan({ ...point, duration: SPAWN_PAN_MS });
  // Ping and play the sound on this client only. Every client gets the message, so a broadcast ping would double up.
  void game.emblemRpg.api.presentation.audio.play(SOUND_IDS.UI_PING);
  await canvas.controls?.drawPing?.(point, { user: game.user });
  return true;
}

/* -------------------------------------------- */
/*  Shared zone and wall language               */
/* -------------------------------------------- */

/** Parse Terrain Builder zone colors, defaulting to yellow. */
export function parseZoneColor(hex, fallback = 0xffd24a) {
  return hexColor(hex, fallback);
}

/** Draw the inset dashed outline for a Terrain Builder zone. */
export function drawZoneOutline(graphics, cells, gridSize, color, options = {}) {
  const { inset = 7, dash = 16, gap = 10, width = 5, alpha = 0.95 } = options;
  const segments = computeZoneBoundarySegments(cells);
  graphics.lineStyle(width, color, alpha);
  const corners = cornerIndex(segments);

  for (const run of mergeRuns(segments)) {
    const interior = run.normal > 0 ? run.line : run.line - 1;
    const index = run.horizontal ? corners.vertical : corners.horizontal;
    const startNormal = cornerNormal(index, run.line, run.a, run.horizontal, interior);
    const endNormal = cornerNormal(index, run.line, run.b, run.horizontal, interior);
    const from = run.a * gridSize + startNormal * inset;
    const to = run.b * gridSize + endNormal * inset;
    const offset = run.line * gridSize + run.normal * inset;
    if (run.horizontal) drawEvenDashedLine(graphics, from, offset, to, offset, dash, gap);
    else drawEvenDashedLine(graphics, offset, from, offset, to, dash, gap);
  }
}

/** Draw the Terrain Builder’s movement, sight or combined wall style. */
export function drawWallSegment(graphics, x0, y0, x1, y1, blocksMove, blocksSight) {
  if (blocksMove && blocksSight) {
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / length;
    const ny = (x1 - x0) / length;
    graphics.lineStyle(3, 0xff3333, 0.95);
    graphics.moveTo(x0 + nx * 3, y0 + ny * 3);
    graphics.lineTo(x1 + nx * 3, y1 + ny * 3);
    graphics.moveTo(x0 - nx * 3, y0 - ny * 3);
    graphics.lineTo(x1 - nx * 3, y1 - ny * 3);
  } else if (blocksMove) {
    graphics.lineStyle(5, 0xff8c1a, 0.95);
    graphics.moveTo(x0, y0);
    graphics.lineTo(x1, y1);
  } else if (blocksSight) {
    graphics.lineStyle(4, 0xffe14a, 0.95);
    drawDashedLine(graphics, x0, y0, x1, y1, 4, 8);
  }
}

/* -------------------------------------------- */
/*  Terrain markings                            */
/* -------------------------------------------- */
function drawObstacleHatch(parent, cells, gridSize) {
  const graphics = parent.addChild(new PIXI.Graphics());
  for (const entry of cells) {
    const { x, y } = entry;
    const left = x * gridSize;
    const top = y * gridSize;
    const blockedColor = entry.impassable ? 0xff3333 : entry.obstacle ? 0x9aa0aa : null;
    if (blockedColor !== null) {
      graphics.lineStyle(0);
      graphics.beginFill(0x000000, 0.45);
      graphics.drawRect(left, top, gridSize, gridSize);
      graphics.endFill();
      drawCrosshatch(graphics, left, top, gridSize, blockedColor);
    } else if (Number(entry.movementCost ?? 1) > 1) {
      drawDiagonalBars(graphics, left, top, gridSize, 0xe0b34a);
    }
  }
}

function drawZoneOverlays(parent, cells, zones, gridSize) {
  const grouped = new Map();
  for (const entry of cells) {
    if (!entry.zoneId) continue;
    if (!grouped.has(entry.zoneId)) grouped.set(entry.zoneId, []);
    grouped.get(entry.zoneId).push(entry.key);
  }
  for (const [zoneId, zoneCells] of grouped) {
    const zone = zones[zoneId] ?? {};
    const graphics = parent.addChild(new PIXI.Graphics());
    drawZoneOutline(graphics, zoneCells, gridSize, parseZoneColor(zone.color));
    const fontSize = Math.max(14, Math.round(gridSize * 0.3));
    for (const region of splitContiguousRegions(zoneCells)) {
      const center = closestCellCenter(region, gridSize);
      if (!center) continue;
      const label = parent.addChild(new PIXI.Text(`Lv ${zone.level ?? 0}`, {
        fontFamily: 'Jersey 10',
        fontWeight: 'bold',
        fontSize,
        fill: zone.color || '#ffd24a',
        stroke: '#000000',
        strokeThickness: Math.max(2, Math.round(fontSize * 0.16))
      }));
      label.anchor?.set?.(0.5, 0.5);
      label.position.set(center.x, center.y);
    }
  }
}

function drawSceneWalls(parent) {
  const graphics = parent.addChild(new PIXI.Graphics());
  for (const wall of collectionValues(canvas.scene?.walls)) {
    const coordinates = wall.c;
    drawWallSegment(graphics, ...coordinates, Number(wall.move) !== 0, Number(wall.sight) !== 0);
  }
}

function drawObjectiveMarkers(parent, cells, gridSize) {
  const graphics = parent.addChild(new PIXI.Graphics());
  for (const entry of cells) {
    if (!['arrive', 'defend'].includes(entry.objectivePoint)) continue;
    const { x, y } = entry;
    const color = entry.objectivePoint === 'arrive' ? 0xffd24a : 0x4a90e2;
    const left = x * gridSize;
    const top = y * gridSize;
    const inset = Math.max(2, Math.round(gridSize * 0.06));
    const frame = Math.max(2, Math.round(gridSize * 0.04));
    graphics.lineStyle(0);
    graphics.beginFill(color, 0.18);
    graphics.drawRect(left, top, gridSize, gridSize);
    graphics.endFill();
    graphics.lineStyle(frame, color, 0.85);
    graphics.drawRect(left + inset, top + inset, gridSize - inset * 2, gridSize - inset * 2);
    if (entry.objectivePoint === 'arrive') drawObjectiveFlag(graphics, left, top, gridSize, color);
    else drawObjectiveShield(graphics, left, top, gridSize, color);
  }
}

async function spawnTexture(path, diagnostics = null) {
  const cached = spawnArt.get(path);
  if (cached && !cached.baseTexture?.destroyed) return cached;
  spawnArt.delete(path);
  let texture = null;
  try {
    const cropped = await trimmedImageElement(path);
    if (cropped) texture = PIXI.Texture.from(cropped);
    else texture = await foundry.canvas.loadTexture(path);
  } catch (_) {
    recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error: _, detail: 'spawnTexture' });
  }
  if (!texture) return null;
  applyNearestTexture(texture);
  spawnArt.set(path, texture);
  return texture;
}

async function drawSpawnMarkers(parent, cells, gridSize, diagnostics = null) {
  const generation = ++spawnGeneration;
  const entries = cells.filter(entry => entry.spawns.some(spawn => spawn.image));
  if (!entries.length) return;
  const paths = [...new Set(entries.flatMap(entry => entry.spawns.map(spawn => spawn.image).filter(Boolean)))];
  const textures = new Map();
  await Promise.all(paths.map(async path => {
    const texture = await spawnTexture(path, diagnostics);
    if (texture) textures.set(path, texture);
  }));
  if (generation !== spawnGeneration || parent.destroyed) return;

  const size = gridSize * 0.3;
  const padding = gridSize * 0.05;
  for (const entry of entries) {
    const spawnTextures = entry.spawns.map(spawn => textures.get(spawn.image)).filter(Boolean);
    if (!spawnTextures.length) continue;
    const span = gridSize - padding * 2 - size;
    const step = spawnTextures.length > 1
      ? Math.min(size + gridSize * 0.04, span / (spawnTextures.length - 1))
      : 0;
    const left = (entry.x + 1) * gridSize - padding - size;
    const radius = size / 2;
    for (let index = spawnTextures.length - 1; index >= 0; index -= 1) {
      const texture = spawnTextures[index];
      const top = entry.y * gridSize + padding + index * step;
      const centerX = left + radius;
      const centerY = top + radius;
      const backing = parent.addChild(new PIXI.Graphics());
      backing.lineStyle(0);
      backing.beginFill(0xffeaa8, 0.35);
      backing.drawCircle(centerX, centerY, radius);
      backing.endFill();
      const sprite = parent.addChild(new PIXI.Sprite(texture));
      const width = texture.width || size;
      const height = texture.height || size;
      const scale = (size * 0.94) / (Math.hypot(width, height) || size);
      sprite.width = width * scale;
      sprite.height = height * scale;
      sprite.position.set(centerX - sprite.width / 2, centerY - sprite.height / 2);
      const frame = parent.addChild(new PIXI.Graphics());
      frame.lineStyle(1, 0xffd24a, 0.9);
      frame.drawCircle(centerX, centerY, radius);
    }
  }
}

/* -------------------------------------------- */
/*  Terrain annotations                         */
/* -------------------------------------------- */
function drawCellInformation(parent, cells, gridSize) {
  for (const entry of cells) {
    const movementCost = Number(entry.movementCost ?? 1);
    const statModifiers = [
      ['Eva', Number(entry.evasionMod ?? 0)],
      ['Def', Number(entry.defMod ?? 0)],
      ['Res', Number(entry.resMod ?? 0)]
    ].filter(([, value]) => value !== 0);
    const effects = entry.tileEffects;
    if (movementCost === 1 && !statModifiers.length && !effects.length) continue;
    const { x, y } = entry;
    const group = parent.addChild(new PIXI.Container());
    group.name = 'emblem-cell-info';
    group.eventMode = 'none';
    group.alpha = 0.85;
    group.position.set(x * gridSize, y * gridSize);
    const fontSize = Math.max(8, Math.round(gridSize * 0.14));
    const padding = Math.round(gridSize * 0.08);
    const strokeThickness = Math.max(1, Math.round(fontSize * 0.14));
    const lineGap = Math.round(fontSize * 0.12);
    let lineY = padding;
    if (movementCost !== 1) {
      const icon = group.addChild(new PIXI.Text(FOOTSTEPS_GLYPH, {
        fontFamily: 'Font Awesome 6 Free, Font Awesome 6 Pro, FontAwesome',
        fontWeight: '900',
        fontSize: Math.round(fontSize * 0.9),
        fill: '#e0b34a',
        stroke: '#000000',
        strokeThickness
      }));
      icon.anchor?.set?.(0, 0);
      icon.position.set(padding, lineY + Math.round(fontSize * 0.08));
      const cost = group.addChild(new PIXI.Text(String(movementCost), terrainTextStyle(fontSize, '#e0b34a')));
      cost.anchor?.set?.(0, 0);
      cost.position.set(padding + icon.width + Math.round(fontSize * 0.3), lineY);
      lineY += Math.max(icon.height, cost.height) + lineGap;
    }
    for (const [label, value] of statModifiers) {
      const text = group.addChild(new PIXI.Text(`${label} ${signed(value)}`, terrainTextStyle(fontSize, '#cccccc')));
      text.anchor?.set?.(0, 0);
      text.position.set(padding, lineY);
      lineY += text.height + lineGap;
    }
    for (const effect of effects) {
      const healing = effect.type === 'healing';
      const text = group.addChild(new PIXI.Text(
        `${healing ? 'Heal' : 'Hzd'} ${effect.value}`,
        terrainTextStyle(fontSize, healing ? '#5ce08a' : '#ff5a5a')
      ));
      text.anchor?.set?.(0, 0);
      text.position.set(padding, lineY);
      lineY += text.height + lineGap;
    }
  }
}

function drawTransitionMarkers(parent, cells, gridSize) {
  for (const entry of cells) {
    if (!entry.transition) continue;
    const { x, y } = entry;
    const { x: cx, y: cy } = cellCenter(x, y, gridSize);
    if (entry.transition === 'teleport') {
      const fontSize = Math.max(16, Math.round(gridSize * 0.4));
      const style = TELEPORT_COST_STYLE[entry.teleportCost] ?? TELEPORT_COST_STYLE.standard;
      const text = parent.addChild(new PIXI.Text(String(entry.teleportLetter || '?'), {
        fontFamily: 'Libertinus Sans',
        fontWeight: 'bold',
        fontSize,
        fill: style.color,
        stroke: '#000000',
        strokeThickness: Math.max(2, Math.round(fontSize * 0.16))
      }));
      text.anchor?.set?.(0.5, 0.5);
      text.position.set(cx, cy - fontSize * TELEPORT_LETTER_RISE);
      const captionSize = Math.max(10, Math.round(fontSize * style.size));
      const caption = parent.addChild(new PIXI.Text(style.caption ?? String(entry.teleportMov || 0), {
        fontFamily: 'Libertinus Sans',
        fontWeight: 'bold',
        fontSize: captionSize,
        fill: style.color,
        stroke: '#000000',
        strokeThickness: Math.max(2, Math.round(captionSize * 0.16))
      }));
      caption.anchor?.set?.(0.5, 0);
      caption.position.set(cx, cy + fontSize * style.drop);
      const maximumWidth = gridSize * 0.86;
      if (caption.width > maximumWidth) caption.scale.set(maximumWidth / caption.width);
      continue;
    }
    const directions = entry.transitionDirections;
    const graphics = parent.addChild(new PIXI.Graphics());
    graphics.lineStyle(3, 0x00e5ff, 0.95);
    for (const direction of CROSSING_DIRECTIONS) {
      if (!directions[direction]) continue;
      const [dx, dy] = directionVector(direction);
      const length = gridSize * 0.5;
      const endX = cx + dx * length / 2;
      const endY = cy + dy * length / 2;
      const head = length * 0.2;
      graphics.moveTo(cx, cy);
      graphics.lineTo(endX, endY);
      graphics.moveTo(endX, endY);
      graphics.lineTo(endX - (dx + dy) * head, endY - (dy + dx) * head);
      graphics.moveTo(endX, endY);
      graphics.lineTo(endX - (dx - dy) * head, endY - (dy - dx) * head);
    }
  }
}

/* -------------------------------------------- */
/*  Geometry helpers                            */
/* -------------------------------------------- */
function drawCrosshatch(graphics, left, top, size, color) {
  const step = Math.max(10, Math.round(size / 6));
  const right = left + size;
  const bottom = top + size;
  graphics.lineStyle(2, color, 0.7);
  for (let intercept = top - right; intercept <= bottom - left; intercept += step) {
    const start = Math.max(left, top - intercept);
    const end = Math.min(right, bottom - intercept);
    if (start < end) {
      graphics.moveTo(start, start + intercept);
      graphics.lineTo(end, end + intercept);
    }
  }
  for (let intercept = top + left; intercept <= bottom + right; intercept += step) {
    const start = Math.max(left, intercept - bottom);
    const end = Math.min(right, intercept - top);
    if (start < end) {
      graphics.moveTo(start, intercept - start);
      graphics.lineTo(end, intercept - end);
    }
  }
}

function drawDiagonalBars(graphics, left, top, size, color) {
  const step = Math.max(8, Math.round(size / 6));
  const right = left + size;
  const bottom = top + size;
  graphics.lineStyle(1.5, color, 0.6);
  for (let intercept = top - right; intercept <= bottom - left; intercept += step) {
    const start = Math.max(left, top - intercept);
    const end = Math.min(right, bottom - intercept);
    if (start < end) {
      graphics.moveTo(start, start + intercept);
      graphics.lineTo(end, end + intercept);
    }
  }
}

function drawObjectiveFlag(graphics, left, top, size, color) {
  const poleX = left + size * 0.34;
  const flagTop = top + size * 0.22;
  graphics.lineStyle(Math.max(2, size * 0.05), color, 1);
  graphics.moveTo(poleX, flagTop);
  graphics.lineTo(poleX, top + size * 0.8);
  graphics.lineStyle(0);
  graphics.beginFill(color, 1);
  graphics.drawPolygon([
    poleX, flagTop,
    left + size * 0.72, flagTop + size * 0.13,
    poleX, flagTop + size * 0.28
  ]);
  graphics.endFill();
}

function drawObjectiveShield(graphics, left, top, size, color) {
  const centerX = left + size / 2;
  const shieldTop = top + size * 0.2;
  const width = size * 0.38;
  graphics.lineStyle(0);
  graphics.beginFill(color, 1);
  graphics.drawPolygon([
    centerX - width / 2, shieldTop,
    centerX + width / 2, shieldTop,
    centerX + width / 2, shieldTop + size * 0.3,
    centerX, shieldTop + size * 0.58,
    centerX - width / 2, shieldTop + size * 0.3
  ]);
  graphics.endFill();
}

function splitContiguousRegions(cellKeys) {
  const remaining = new Set(cellKeys);
  const regions = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(first);
    const region = new Set([first]);
    const queue = [first];
    while (queue.length) {
      const { x, y } = parseTerrainKey(queue.shift());
      for (const neighbor of [
        terrainKey(x + 1, y), terrainKey(x - 1, y), terrainKey(x, y + 1), terrainKey(x, y - 1)
      ]) {
        if (!remaining.delete(neighbor)) continue;
        region.add(neighbor);
        queue.push(neighbor);
      }
    }
    regions.push(region);
  }
  return regions;
}

function closestCellCenter(region, gridSize) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const points = [];
  for (const key of region) {
    const { x, y } = parseTerrainKey(key);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = cellCenter(x, y, gridSize);
    points.push(point);
    sumX += point.x;
    sumY += point.y;
    count += 1;
  }
  if (!count) return null;
  const centerX = sumX / count;
  const centerY = sumY / count;
  return points.reduce((closest, point) => {
    const distance = (point.x - centerX) ** 2 + (point.y - centerY) ** 2;
    return !closest || distance < closest.distance ? { ...point, distance } : closest;
  }, null);
}

function computeZoneBoundarySegments(cellKeys) {
  const cells = cellKeys instanceof Set ? cellKeys : new Set(cellKeys);
  const segments = [];
  for (const key of cells) {
    const { x, y } = parseTerrainKey(key);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!cells.has(terrainKey(x, y - 1))) segments.push({ x0: x, y0: y, x1: x + 1, y1: y, nx: 0, ny: 1 });
    if (!cells.has(terrainKey(x, y + 1))) segments.push({ x0: x, y0: y + 1, x1: x + 1, y1: y + 1, nx: 0, ny: -1 });
    if (!cells.has(terrainKey(x - 1, y))) segments.push({ x0: x, y0: y, x1: x, y1: y + 1, nx: 1, ny: 0 });
    if (!cells.has(terrainKey(x + 1, y))) segments.push({ x0: x + 1, y0: y, x1: x + 1, y1: y + 1, nx: -1, ny: 0 });
  }
  return segments;
}

function cornerIndex(segments) {
  const vertical = new Map();
  const horizontal = new Map();
  const add = (map, key, entry) => map.set(key, [...(map.get(key) ?? []), entry]);
  for (const segment of segments) {
    if (segment.y0 === segment.y1) {
      const entry = { n: segment.ny, cell: segment.x0 };
      add(horizontal, `${segment.x0},${segment.y0}`, entry);
      add(horizontal, `${segment.x1},${segment.y0}`, entry);
    } else {
      const entry = { n: segment.nx, cell: segment.y0 };
      add(vertical, `${segment.x0},${segment.y0}`, entry);
      add(vertical, `${segment.x0},${segment.y1}`, entry);
    }
  }
  return { vertical, horizontal };
}

function cornerNormal(index, line, at, horizontal, interior) {
  const entries = index.get(horizontal ? `${at},${line}` : `${line},${at}`);
  return entries?.length ? (entries.find(entry => entry.cell === interior) ?? entries[0]).n : 0;
}

function mergeRuns(segments) {
  const lines = new Map();
  for (const segment of segments) {
    const horizontal = segment.y0 === segment.y1;
    const line = horizontal ? segment.y0 : segment.x0;
    const normal = horizontal ? segment.ny : segment.nx;
    const key = `${horizontal ? 'h' : 'v'}:${line}:${normal}`;
    const span = horizontal ? [segment.x0, segment.x1] : [segment.y0, segment.y1];
    const current = lines.get(key) ?? { horizontal, line, normal, spans: [] };
    current.spans.push(span);
    lines.set(key, current);
  }
  const runs = [];
  for (const line of lines.values()) {
    line.spans.sort((a, b) => a[0] - b[0]);
    let [start, end] = line.spans[0];
    for (const span of line.spans.slice(1)) {
      if (span[0] === end) end = span[1];
      else {
        runs.push({ ...line, spans: undefined, a: start, b: end });
        [start, end] = span;
      }
    }
    runs.push({ ...line, spans: undefined, a: start, b: end });
  }
  return runs;
}

function drawDashedLine(graphics, x0, y0, x1, y1, dash, gap) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const ux = dx / length;
  const uy = dy / length;
  for (let offset = 0; offset < length; offset += dash + gap) {
    const end = Math.min(offset + dash, length);
    graphics.moveTo(x0 + ux * offset, y0 + uy * offset);
    graphics.lineTo(x0 + ux * end, y0 + uy * end);
  }
}

function drawEvenDashedLine(graphics, x0, y0, x1, y1, dash, gap) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const ux = dx / length;
  const uy = dy / length;
  const count = Math.max(2, Math.round((length + gap) / (dash + gap)));
  const size = Math.min(dash, length / count);
  const spacing = (length - count * size) / (count - 1);
  for (let index = 0; index < count; index += 1) {
    const start = index * (size + spacing);
    graphics.moveTo(x0 + ux * start, y0 + uy * start);
    graphics.lineTo(x0 + ux * (start + size), y0 + uy * (start + size));
  }
}

/* -------------------------------------------- */
/*  PIXI helpers                                */
/* -------------------------------------------- */
function ensureOverlay() {
  if (overlay && !overlay.destroyed) return overlay;
  if (!globalThis.PIXI || !canvas.ready) return null;
  overlay = createSortedOverlay(OVERLAY_NAME, SORT_BELOW_TOKENS,
    [canvas.primary, canvas.environment, canvas.stage]);
  return overlay;
}

function ensureAnnotationOverlay() {
  if (annotationOverlay && !annotationOverlay.destroyed) return annotationOverlay;
  if (!globalThis.PIXI || !canvas.ready) return null;
  annotationOverlay = createSortedOverlay(ANNOTATION_OVERLAY_NAME, SORT_ABOVE_TOKENS,
    [canvas.primary, canvas.environment, canvas.stage]);
  return annotationOverlay;
}

/**
 * Destroy both terrain containers. This also takes down the movement controls' teleport letters and crossing
 * arrows, which are drawn inside the annotation container.
 */
function destroyOverlay() {
  spawnGeneration += 1;
  destroyDisplayObject(overlay);
  overlay = null;
  destroyDisplayObject(annotationOverlay);
  annotationOverlay = null;
  reachableTeleports = null;
  crossingArrows = null;
}

function destroyDisplayObject(object) {
  if (!object || object.destroyed) return;
  object.parent?.removeChild?.(object);
  object.destroy?.({ children: true });
}

function terrainTextStyle(size, fill) {
  return {
    fontFamily: 'Jersey 10',
    fontSize: size,
    fill,
    stroke: '#000000',
    strokeThickness: Math.max(1, Math.round(size * 0.14)),
    fontWeight: 'bold',
    align: 'left'
  };
}

function directionVector(direction) {
  if (direction === 'up') return [0, -1];
  if (direction === 'down') return [0, 1];
  if (direction === 'left') return [-1, 0];
  return [1, 0];
}

function signed(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${number}`;
}
