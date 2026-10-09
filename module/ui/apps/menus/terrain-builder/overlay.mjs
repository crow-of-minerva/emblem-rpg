/** @layer ui/apps/menus/terrain-builder */

/*
 * The Terrain Builder's canvas layer: it captures pointer and key input and draws the grid, zones, walls, selection
 * and drag previews. Selection changes and drawn or deleted walls go to listeners that app.mjs registers, and app.mjs
 * does all the saving.
 */
import { readTerrainGrid as getTerrainGrid, readTerrainZones as getZones } from '../../../../foundry/adapters/projections/terrain.mjs';
import { terrainKey, parseTerrainKey } from '../../../../game/terrain/rules.mjs';
import { drawZoneOutline, drawWallSegment, parseZoneColor } from '../../../../presentation/canvas/terrain.mjs';
import { createTerrainNotifier } from '../../../../presentation/interface/notifications.mjs';
import { fillCells } from '../../../../presentation/canvas/cell-overlays.mjs';
import { reportFoundryError, FoundryDiagnostics } from '../../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Appearance                                  */
/* -------------------------------------------- */

/** The builder's own colours: the grid, the selection, the add and remove previews, and the wall preview. */
const GRID_LINE_COLOR = 0x9ad0ff;
const GRID_LINE_ALPHA = 0.5;
const SEL_COLOR = 0x4a90e2;
const ADD_COLOR = 0x57d957;
const REMOVE_COLOR = 0xe24a4a;
const WALL_PREVIEW_COLOR = 0xffd24a;

/** The default and smallest freestyle bone: the pixels a freestyle stroke runs before it starts a new wall. */
export const FREE_BONE_DEFAULT = 36;
export const FREE_BONE_MIN = 4;

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/** State for the single Terrain Builder overlay and its in-progress gestures. */
let _overlay = null;
let _gridGfx = null;
let _zoneGfx = null;
let _wallVizGfx = null;
let _selGfx = null;
let _previewGfx = null;
let _selection = new Set();
let _active = false;
let _locked = false;
let _lockWarnedAt = 0;
let _showGrid = true;
let _mode = 'terrain';
let _snapMode = 'grid';
let _drag = null;
let _wallDrag = null;
let _chainAnchor = null;
let _freeStroke = [];
let _freeBoneLength = FREE_BONE_DEFAULT;
let _polyVerts = [];
let _listener = null;
let _wallListener = null;
let _wallDeleteListener = null;
let _wallChangeListener = null;
const notifications = createTerrainNotifier({ diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Selection                                   */
/* -------------------------------------------- */

/** Whether the builder's canvas layer is up. */
export function isTerrainModeActive() {
  return _active;
}

/** Set the callback run when the selection changes. TerrainBuilder._onRender sets one that re-renders the window. */
export function setTerrainSelectionListener(fn) {
  _listener = fn;
}

/** A copy of the current selection, so a caller can't change it. */
export function getTerrainSelection() {
  return new Set(_selection);
}

/** Replace the selection outright, as a zone row's select button does. */
export function setTerrainSelection(cells) {
  _selection = new Set(cells);
  _redrawSelection();
  _notify();
}

/**
 * Lock the selection against stray canvas clicks.
 *
 * The lock doesn't stop the builder's own selection calls, such as a zone row's select button. It guards against
 * clicking the map by accident, not against pressing a button on purpose.
 */
export function setTerrainSelectionLocked(locked) {
  _locked = !!locked;
}

/** Whether the selection is locked. */
export function isTerrainSelectionLocked() {
  return _locked;
}

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * Mount the Terrain Builder overlay on a square grid with an origin-zero hit area. Only the overlay receives pointer
 * events, and its graphics children ignore them.
 * @returns {boolean}             Whether the overlay went up.
 */
export function enterTerrainMode() {
  if (_active) return true;
  if (!canvas?.ready || !canvas.scene || !canvas.stage) return false;
  if (canvas.scene.grid.type !== CONST.GRID_TYPES.SQUARE) return false;

  _overlay = new PIXI.Container();
  _overlay.name = 'emblem-terrain-builder-overlay';
  _overlay.eventMode = 'static';
  // Cell coordinates are floor(pixel / gridSize). That matches Foundry's grid offsets only because the system forces
  // Scene padding to 0 (foundry/hooks/scene.mjs).
  _overlay.hitArea = new PIXI.Rectangle(0, 0, canvas.scene.width, canvas.scene.height);

  _gridGfx = _overlay.addChild(new PIXI.Graphics());
  _zoneGfx = _overlay.addChild(new PIXI.Graphics());
  _wallVizGfx = _overlay.addChild(new PIXI.Graphics());
  _selGfx = _overlay.addChild(new PIXI.Graphics());
  _previewGfx = _overlay.addChild(new PIXI.Graphics());
  for (const g of [_gridGfx, _zoneGfx, _wallVizGfx, _selGfx, _previewGfx]) g.eventMode = 'none';

  _overlay.on('pointerdown', _onPointerDown);
  _overlay.on('pointermove', _onPointerMove);
  _overlay.on('pointerup', _onPointerUp);
  _overlay.on('pointerupoutside', _onPointerUp);

  // Added straight to the stage, on top of the canvas groups. Foundry's canvas teardown doesn't remove it;
  // exitTerrainMode does when the builder closes.
  canvas.stage.addChild(_overlay);

  _active = true;
  _mode = 'terrain';
  _selection.clear();
  _drawGrid();
  if (_gridGfx) _gridGfx.visible = _showGrid;
  refreshZoneOutlines();
  refreshWallViz();
  _redrawSelection();
  _notify();
  return true;
}

/** Show or hide the builder's own grid, remembered so re-entering respects the choice. */
export function setBuilderGridVisible(visible) {
  _showGrid = !!visible;
  if (_gridGfx) _gridGfx.visible = _showGrid;
}

/**
 * Take the overlay down and clear the selection, the lock and any drawing in progress. The grid toggle, snap mode,
 * bone length and listeners are kept for the next open.
 */
export function exitTerrainMode() {
  if (!_active) return;
  _active = false;
  _drag = null;
  _removeWallListeners();
  if (_overlay && !_overlay.destroyed) {
    _overlay.off('pointerdown', _onPointerDown);
    _overlay.off('pointermove', _onPointerMove);
    _overlay.off('pointerup', _onPointerUp);
    _overlay.off('pointerupoutside', _onPointerUp);
    _overlay.destroy({ children: true });
  }
  _overlay = _gridGfx = _zoneGfx = _wallVizGfx = _selGfx = _previewGfx = null;
  _selection.clear();
  _locked = false;
  _wallDrag = null;
  _chainAnchor = null;
  _freeStroke = [];
  _polyVerts = [];
  _mode = 'terrain';
}

/* -------------------------------------------- */
/*  Wall Listeners                              */
/* -------------------------------------------- */

/** Set the callback that receives newly drawn wall segments (TerrainBuilder._onWallsDrawn). */
export function setWallDrawListener(fn) {
  _wallListener = fn;
}

/** Set the callback that receives the id of the wall the GM right-clicked to delete (TerrainBuilder._onWallDelete). */
export function setWallDeleteListener(fn) {
  _wallDeleteListener = fn;
}

/** Set the callback told after any wall on the viewed scene changes (TerrainBuilder._refreshWallCounts). */
export function setWallChangeListener(fn) {
  _wallChangeListener = fn;
}

/** Set how many pixels each freestyle wall runs before the stroke starts the next one. */
export function setFreeBoneLength(px) {
  _freeBoneLength = Math.max(FREE_BONE_MIN, Number(px) || FREE_BONE_DEFAULT);
}

/**
 * Choose how wall points are placed, clearing any drawing in progress.
 * @param {string} mode           Grid, free or polygon.
 */
export function setWallSnapMode(mode) {
  _snapMode = (mode === 'free' || mode === 'polygon') ? mode : 'grid';
  _polyVerts = [];
  _chainAnchor = null;
  _wallDrag = null;
  _freeStroke = [];
  _previewGfx?.clear();
}

/**
 * Switch between selecting terrain and drawing walls.
 *
 * Everything in progress is dropped on the way, and the selection drawing is cleared in wall mode so the two don't
 * read as one thing.
 * @param {string} mode           Terrain or walls.
 */
export function setTerrainBuilderMode(mode) {
  _mode = (mode === 'walls') ? 'walls' : 'terrain';
  _drag = null;
  _wallDrag = null;
  _chainAnchor = null;
  _freeStroke = [];
  _polyVerts = [];
  _previewGfx?.clear();
  if (_mode === 'walls') {
    _selGfx?.clear();
    _addWallListeners();
  } else {
    _removeWallListeners();
    _redrawSelection();
  }
  refreshWallViz();
}

/* -------------------------------------------- */
/*  Drawing                                     */
/* -------------------------------------------- */

/**
 * Redraw the scene's walls.
 *
 * Drawn in both modes, since terrain is usually painted against walls that are already there.
 */
export function refreshWallViz() {
  if (!_wallVizGfx) return;
  _wallVizGfx.clear();
  if (!canvas.scene) return;
  for (const wall of canvas.scene.walls) {
    const c = wall.c;
    drawWallSegment(_wallVizGfx, c[0], c[1], c[2], c[3], (wall.move ?? 0) !== 0, (wall.sight ?? 0) !== 0);
  }
}

/** Redraw the zone outlines, one per zone, in each zone's own colour. */
export function refreshZoneOutlines() {
  if (!_active || !_zoneGfx) return;
  const gs = _gridSize();
  _zoneGfx.clear();

  const grid = getTerrainGrid(canvas.scene);
  const zones = getZones(canvas.scene);
  const byZone = new Map();
  for (const [key, data] of Object.entries(grid)) {
    if (!data?.zoneId) continue;
    if (!byZone.has(data.zoneId)) byZone.set(data.zoneId, []);
    byZone.get(data.zoneId).push(key);
  }

  for (const [zoneId, cells] of byZone) {
    drawZoneOutline(_zoneGfx, cells, gs, parseZoneColor(zones[zoneId]?.color));
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Tell the listener the selection changed, guarded so a failing listener can't break the drag. */
function _notify() {
  try { _listener?.(new Set(_selection)); }
  catch (e) {
    reportFoundryError(import.meta.url, e, 'emblem-rpg | terrain selection listener failed:');
  }
}

function _gridSize() {
  return canvas.grid.size;
}

/** The scene's cell bounds, which every selection is clamped to. */
function _cellRange() {
  const gs = _gridSize();
  return {
    colMin: 0,
    rowMin: 0,
    colMax: Math.ceil(canvas.scene.width / gs) - 1,
    rowMax: Math.ceil(canvas.scene.height / gs) - 1
  };
}

/** The cell a pointer event landed on. */
function _cellFromEvent(e) {
  const p = e.getLocalPosition(_overlay);
  const gs = _gridSize();
  return { row: Math.floor(p.y / gs), col: Math.floor(p.x / gs) };
}

/** Every cell key in a rectangle, clamped to the scene, whichever corner the drag started from. */
function _boxCells(r0, c0, r1, c1) {
  const { colMin, rowMin, colMax, rowMax } = _cellRange();
  const rLo = Math.max(Math.min(r0, r1), rowMin);
  const rHi = Math.min(Math.max(r0, r1), rowMax);
  const cLo = Math.max(Math.min(c0, c1), colMin);
  const cHi = Math.min(Math.max(c0, c1), colMax);
  const cells = [];
  for (let r = rLo; r <= rHi; r++) {
    for (let c = cLo; c <= cHi; c++) cells.push(terrainKey(c, r));
  }
  return cells;
}

/**
 * Say the selection is locked, at most once a second.
 *
 * A GM clicking repeatedly on a locked selection should be told, not buried under a warning per click.
 */
function _warnLocked() {
  const now = Date.now();
  if (now - _lockWarnedAt < 1000) return;
  _lockWarnedAt = now;
  notifications.warn('Terrain selection is locked.');
}

/* -------------------------------------------- */
/*  Terrain Pointer                             */
/* -------------------------------------------- */

/**
 * Begin a terrain drag, or hand off to the wall handlers.
 *
 * The modifier decides the mode: Ctrl removes, Alt adds, and a plain drag replaces.
 */
function _onPointerDown(e) {
  if (_mode === 'walls') return _onWallPointerDown(e);
  // Left-click stops here so Foundry's own canvas selection doesn't start. Right-drag passes through to pan the map.
  if (e.button !== 0) return;
  e.stopPropagation();
  if (_locked) return _warnLocked();
  const { row, col } = _cellFromEvent(e);
  const mode = (e.ctrlKey || e.metaKey) ? 'remove' : e.altKey ? 'add' : 'replace';
  _drag = { startRow: row, startCol: col, mode, lastRow: row, lastCol: col };
  _drawPreview(row, col, row, col, mode);
}

/** Extend the preview rectangle as the drag moves. */
function _onPointerMove(e) {
  if (_mode === 'walls') return _onWallPointerMove(e);
  if (!_drag) return;
  e.stopPropagation();
  const { row, col } = _cellFromEvent(e);
  // A pointer reports many samples inside one square, and the rectangle only changes when the square does.
  if (_drag.lastRow === row && _drag.lastCol === col) return;
  _drag.lastRow = row;
  _drag.lastCol = col;
  _drawPreview(_drag.startRow, _drag.startCol, row, col, _drag.mode);
}

/** Commit the dragged rectangle to the selection. */
function _onPointerUp(e) {
  if (_mode === 'walls') return _onWallPointerUp(e);
  if (!_drag) return;
  e.stopPropagation();
  const { row, col } = _cellFromEvent(e);
  const cells = _boxCells(_drag.startRow, _drag.startCol, row, col);
  _commit(cells, _drag.mode);
  _drag = null;
  _previewGfx?.clear();
}

/* -------------------------------------------- */
/*  Wall Pointer                                */
/* -------------------------------------------- */

/**
 * The point a wall event lands on, snapped to the grid unless the mode is freehand or polygon.
 *
 * Snapped to the nearest corner rather than to a cell, since a wall runs along the grid lines rather than through the
 * squares.
 */
function _point(e) {
  const p = e.getLocalPosition(_overlay);
  if (_snapMode === 'free' || _snapMode === 'polygon') return { x: p.x, y: p.y };
  const gs = _gridSize();
  return { x: Math.round(p.x / gs) * gs, y: Math.round(p.y / gs) * gs };
}

/** Hand finished segments to the listener, guarded so a failure can't break the drawing. */
function _emitWalls(segments) {
  if (!segments.length) return;
  try { _wallListener?.(segments); }
  catch (err) {
    reportFoundryError(import.meta.url, err, 'emblem-rpg | wall draw listener failed:');
  }
}

/**
 * Start wall input. Right-click finishes a polygon in progress or deletes the nearest wall, and Alt-click chains a
 * wall from the previous point.
 */
function _onWallPointerDown(e) {
  if (e.button === 2) {
    if (_snapMode === 'polygon' && _polyVerts.length) { e.stopPropagation(); _emitPolygon(false); return; }
    _handleWallRightClick(e);
    return;
  }
  if (e.button !== 0) return;
  e.stopPropagation();
  const p = _point(e);
  if (_snapMode === 'polygon') { _polygonClick(p); return; }
  if (e.altKey) {
    // Contiguous polygon: each click chains a wall from the previous vertex.
    if (_chainAnchor) _emitWalls([{ x0: _chainAnchor.x, y0: _chainAnchor.y, x1: p.x, y1: p.y }]);
    _chainAnchor = p;
    _wallDrag = null;
    _freeStroke = [];
    _drawWallPreviewPath([p]);
  } else {
    _chainAnchor = null;
    _wallDrag = p;
    _freeStroke = [p];
  }
}

/**
 * Update the wall preview as the pointer moves.
 *
 * Freehand samples rather than recording every move, keeping points a minimum distance apart, so a slow stroke
 * doesn't produce hundreds of near-identical segments.
 */
function _onWallPointerMove(e) {
  const p = _point(e);
  if (_snapMode === 'polygon') {
    if (_polyVerts.length) { e.stopPropagation(); _drawPolygonPreview(p); }
    return;
  }
  if (_chainAnchor) { e.stopPropagation(); _drawWallPreviewPath([_chainAnchor, p]); return; }
  if (!_wallDrag) return;
  e.stopPropagation();
  if (_snapMode === 'free') {
    const last = _freeStroke[_freeStroke.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= _freeBoneLength) _freeStroke.push(p);
    _drawWallPreviewPath(_freeStroke.concat([p]));
  } else {
    _drawWallPreviewPath([_wallDrag, p]);
  }
}

/**
 * Finish a dragged wall and send it to the builder listener. Polygon clicks and Alt chains finish in their own
 * handlers.
 */
function _onWallPointerUp(e) {
  if (_snapMode === 'polygon') { e.stopPropagation(); return; } // polygon commits on click, not drag
  if (_chainAnchor) { e.stopPropagation(); return; } // chain continues until Alt is released
  if (!_wallDrag) return;
  e.stopPropagation();
  const p = _point(e);
  _previewGfx?.clear();

  let segments;
  if (_snapMode === 'free') {
    const pts = _freeStroke.concat([p]);
    segments = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.x !== b.x || a.y !== b.y) segments.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
    }
  } else {
    segments = (_wallDrag.x !== p.x || _wallDrag.y !== p.y)
      ? [{ x0: _wallDrag.x, y0: _wallDrag.y, x1: p.x, y1: p.y }] : [];
  }
  _wallDrag = null;
  _freeStroke = [];
  _emitWalls(segments);
}

/* -------------------------------------------- */
/*  Polygons                                    */
/* -------------------------------------------- */

/** Whether two points are close enough to count as the same, within a quarter of a square. */
function _samePoint(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= _gridSize() * 0.25;
}

/**
 * Add a vertex, or close the polygon where the click landed back on its first point.
 *
 * A click on the point just placed is ignored, so a double-click doesn't add a degenerate vertex.
 */
function _polygonClick(p) {
  const v = _polyVerts;
  if (v.length >= 3 && _samePoint(p, v[0])) { _emitPolygon(true); return; }
  const last = v[v.length - 1];
  if (last && _samePoint(p, last)) return;
  v.push(p);
  _drawPolygonPreview(p);
}

/**
 * Turn the collected vertices into wall segments and send them to the wall draw listener.
 * @param {boolean} close         Whether to join the last vertex back to the first.
 */
function _emitPolygon(close) {
  const v = _polyVerts;
  if (v.length >= 2) {
    const segs = [];
    for (let i = 1; i < v.length; i++) segs.push({ x0: v[i - 1].x, y0: v[i - 1].y, x1: v[i].x, y1: v[i].y });
    if (close && v.length >= 3) segs.push({ x0: v[v.length - 1].x, y0: v[v.length - 1].y, x1: v[0].x, y1: v[0].y });
    _emitWalls(segs);
  }
  _resetPolygon();
}

/** Abandon the polygon in progress. */
function _resetPolygon() {
  _polyVerts = [];
  _previewGfx?.clear();
}

/** Draw the polygon so far, with a trailing segment to the cursor when one is given. */
function _drawPolygonPreview(cursor) {
  _drawWallPreviewPath(cursor ? _polyVerts.concat([cursor]) : _polyVerts.slice());
}

/* -------------------------------------------- */
/*  Wall Deletion                               */
/* -------------------------------------------- */

/** Delete the wall nearest the right-click, through the wall delete listener. */
function _handleWallRightClick(e) {
  // Every right-click stops here, even with no wall nearby, so right-drag doesn't pan the map in wall mode.
  e.stopPropagation();
  const p = e.getLocalPosition(_overlay);
  const wall = _findNearestWall(p.x, p.y);
  if (!wall) return;
  try { _wallDeleteListener?.(wall.id); }
  catch (err) {
    reportFoundryError(import.meta.url, err, 'emblem-rpg | wall delete listener failed:');
  }
}

/**
 * The wall nearest a point, within 0.4 of a square.
 * @returns {WallDocument|null}
 */
function _findNearestWall(px, py) {
  if (!canvas.scene) return null;
  const threshold = _gridSize() * 0.4;
  let best = null, bestD = threshold;
  for (const wall of canvas.scene.walls) {
    const c = wall.c;
    const d = _pointToSegmentDistance(px, py, c[0], c[1], c[2], c[3]);
    if (d < bestD) { bestD = d; best = wall; }
  }
  return best;
}

/** The distance from a point to a segment, clamped to the segment's own extent. */
function _pointToSegmentDistance(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x0 + t * dx, cy = y0 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/* -------------------------------------------- */
/*  Previews                                    */
/* -------------------------------------------- */

/** Draw a wall preview: a dot at every point and a line between them. */
function _drawWallPreviewPath(points) {
  if (!_previewGfx) return;
  _previewGfx.clear();
  _previewGfx.beginFill(WALL_PREVIEW_COLOR, 0.95);
  for (const pt of points) _previewGfx.drawCircle(pt.x, pt.y, 4);
  _previewGfx.endFill();
  if (points.length < 2) return;
  _previewGfx.lineStyle(4, WALL_PREVIEW_COLOR, 0.95);
  _previewGfx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) _previewGfx.lineTo(points[i].x, points[i].y);
}

/* -------------------------------------------- */
/*  Wall Keys                                   */
/* -------------------------------------------- */

/** Wire the keyboard and context-menu handlers wall mode needs. */
function _addWallListeners() {
  window.addEventListener('keyup', _onWallKeyUp);
  // Capture phase, so it runs before Foundry's keyboard manager (a bubbling listener on window) and can keep
  // Escape and Enter from reaching Foundry's keybindings.
  window.addEventListener('keydown', _onWallKeyDown, true);
  canvas.app?.view?.addEventListener('contextmenu', _onCanvasContextMenu);
}

function _removeWallListeners() {
  window.removeEventListener('keyup', _onWallKeyUp);
  window.removeEventListener('keydown', _onWallKeyDown, true);
  canvas.app?.view?.removeEventListener('contextmenu', _onCanvasContextMenu);
}

/** End an Alt chain when Alt is released. */
function _onWallKeyUp(ev) {
  if (ev.key === 'Alt') { _chainAnchor = null; _previewGfx?.clear(); }
}

/**
 * While a polygon is being drawn, Escape abandons it and Enter finishes it without joining the last point to the
 * first. Neither key reaches anything else, even a text field the GM is typing in.
 */
function _onWallKeyDown(ev) {
  if (_snapMode !== 'polygon' || !_polyVerts.length) return;
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); _resetPolygon(); }
  else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); _emitPolygon(false); }
}

/** Suppress the browser menu in wall mode, where right-click means delete. */
function _onCanvasContextMenu(ev) {
  if (_active && _mode === 'walls') ev.preventDefault();
}

/** Redraw the builder's walls after a wall on the viewed scene is created, updated or deleted (from the Wall hooks). */
export function onTerrainWallChanged() {
  if (!_active) return;
  refreshWallViz();
  try { _wallChangeListener?.(); }
  catch (err) {
    reportFoundryError(import.meta.url, err, 'emblem-rpg | wall change listener failed:');
  }
}

/* -------------------------------------------- */
/*  Selection Drawing                           */
/* -------------------------------------------- */

/** Apply a dragged rectangle to the selection by the drag's mode: replace, add or remove. */
function _commit(cells, mode) {
  if (mode === 'replace') _selection = new Set(cells);
  else if (mode === 'add') for (const k of cells) _selection.add(k);
  else if (mode === 'remove') for (const k of cells) _selection.delete(k);
  _redrawSelection();
  _notify();
}

/** Draw the builder's grid across the scene. */
function _drawGrid() {
  if (!_gridGfx) return;
  const gs = _gridSize();
  const { colMin, rowMin, colMax, rowMax } = _cellRange();
  const x0 = colMin * gs, x1 = (colMax + 1) * gs;
  const y0 = rowMin * gs, y1 = (rowMax + 1) * gs;
  _gridGfx.clear();
  _gridGfx.lineStyle(1, GRID_LINE_COLOR, GRID_LINE_ALPHA, 0.5, true);
  for (let c = colMin; c <= colMax + 1; c++) { _gridGfx.moveTo(c * gs, y0); _gridGfx.lineTo(c * gs, y1); }
  for (let r = rowMin; r <= rowMax + 1; r++) { _gridGfx.moveTo(x0, r * gs); _gridGfx.lineTo(x1, r * gs); }
}

/** Redraw the selected squares. */
function _redrawSelection() {
  if (!_selGfx) return;
  const gs = _gridSize();
  _selGfx.clear();
  _selGfx.lineStyle(2, SEL_COLOR, 0.9);
  _selGfx.beginFill(SEL_COLOR, 0.30);
  fillCells(_selGfx, [..._selection].map(parseTerrainKey), gs);
  _selGfx.endFill();
}

/** Draw the rectangle a drag is currently covering, coloured by what it will do (replace, add or remove). */
function _drawPreview(r0, c0, r1, c1, mode) {
  if (!_previewGfx) return;
  const gs = _gridSize();
  const color = mode === 'add' ? ADD_COLOR : mode === 'remove' ? REMOVE_COLOR : SEL_COLOR;
  _previewGfx.clear();
  _previewGfx.lineStyle(2, color, 0.95);
  _previewGfx.beginFill(color, 0.25);
  fillCells(_previewGfx, _boxCells(r0, c0, r1, c1).map(parseTerrainKey), gs);
  _previewGfx.endFill();
}
