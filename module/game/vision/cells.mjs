/** @layer game/vision */
/*
 * Grid geometry for the square-by-square sight patch in foundry/patches/vision.mjs: which cells within range a
 * vision source covers, and the outline that becomes its sight polygon.
 */
import { cellKey, parseCellKey, footprintDistance } from '../../lib/core/geometry.mjs';

/* -------------------------------------------- */
/*  Measurement                                 */
/* -------------------------------------------- */

/**
 * A range in scene distance units, as a whole number of cells.
 * @param {number} rangeUnits Range in distance units.
 * @param {number} gridDistance Distance units per square.
 * @param {number} [maxCells] Largest answer allowed; an unlimited range comes back as this.
 * @returns {number}
 */
export function cellRange(rangeUnits, gridDistance, maxCells = 0) {
  if (!(gridDistance > 0)) return 0;
  const cells = Math.max(0, Math.round(rangeUnits / gridDistance));
  if (Number.isNaN(cells)) return 0;
  const cap = Number.isFinite(maxCells) && maxCells > 0 ? maxCells : Number.MAX_SAFE_INTEGER;
  return Math.min(cells, cap);
}

/**
 * Convert the Foundry vision source center to a grid footprint. Round small off-grid offsets to the visible cell.
 * @param {number} cx Centre x in pixels.
 * @param {number} cy Centre y in pixels.
 * @param {number} tw Width in squares.
 * @param {number} th Height in squares.
 * @param {number} g Grid size in pixels.
 * @returns {{tc: number, tr: number}}
 */
export function footprintFromCenter(cx, cy, tw, th, g) {
  return {
    tc: Math.round((cx - (tw * g) / 2) / g),
    tr: Math.round((cy - (th * g) / 2) / g)
  };
}

/**
 * The bounding rectangle of a flat point array, as a plain record.
 * @param {number[]} pts Points, as alternating x and y.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function boundsFromPoints(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* -------------------------------------------- */
/*  Cell coverage                               */
/* -------------------------------------------- */
const VISIBILITY_THRESHOLD = 1 / 3;
const SAMPLES_PER_AXIS = 6;

/**
 * Every cell within a range of a footprint, measured edge to edge with diagonals costing two.
 * @param {number} tc Footprint column.
 * @param {number} tr Footprint row.
 * @param {number} tw Footprint width in squares.
 * @param {number} th Footprint height in squares.
 * @param {number} R Range in cells.
 * @returns {{col: number, row: number}[]}
 */
export function footprintCells(tc, tr, tw, th, R) {
  const cells = [];
  if (!Number.isFinite(R)) return cells;
  for (let row = tr - R; row <= tr + th - 1 + R; row++) {
    for (let col = tc - R; col <= tc + tw - 1 + R; col++) {
      if (footprintDistance(col, row, 1, 1, tc, tr, tw, th) <= R) cells.push({ col, row });
    }
  }
  return cells;
}

/**
 * Whether at least `threshold` of a cell lies inside the shape, for selectVisibleCells. The samples sit at sub-cell
 * centres, so none falls on a grid edge that the next cell would count again.
 */
function cellCoversThreshold(containsFn, col, row, g, threshold, samplesPerAxis = SAMPLES_PER_AXIS) {
  const n = Math.max(1, samplesPerAxis);
  const total = n * n;
  let inside = 0;
  let remaining = total;
  for (let i = 0; i < n; i++) {
    const x = (col + (i + 0.5) / n) * g;
    for (let j = 0; j < n; j++) {
      const y = (row + (j + 0.5) / n) * g;
      if (containsFn(x, y)) inside++;
      remaining--;
      // The answer is settled once the samples still to take cannot change it, either way.
      if (inside / total + 1e-9 >= threshold) return true;
      if ((inside + remaining) / total + 1e-9 < threshold) return false;
    }
  }
  return inside / total + 1e-9 >= threshold;
}

/**
 * The cells a vision source sees: those at least one-third inside its wall-clipped shape. The low threshold keeps
 * narrow diagonal sightlines, and a small epsilon absorbs floating-point error at the threshold.
 * @param {{col: number, row: number}[]} candidates Cells to test.
 * @param {(x: number, y: number) => boolean} containsFn Point-in-shape test.
 * @param {number} g Grid size in pixels.
 * @param {number} [threshold] Coverage fraction that counts.
 * @param {number} [samples] Sampling density.
 * @returns {Set<string>} Covered cell keys.
 */
export function selectVisibleCells(candidates, containsFn, g, threshold = VISIBILITY_THRESHOLD, samples = SAMPLES_PER_AXIS) {
  const set = new Set();
  for (const { col, row } of candidates) {
    if (cellCoversThreshold(containsFn, col, row, g, threshold, samples)) set.add(cellKey(col, row));
  }
  return set;
}

/* -------------------------------------------- */
/*  Boundary tracing                            */
/* -------------------------------------------- */
function polyArea(pts) {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  }
  return a / 2;
}

/**
 * Choose the next edge for traceCellBoundary where several leave one corner. Reversals are skipped and the
 * sharpest turn wins, so two cells touching only at a corner don't split the outline.
 */
function pickNext(inEdge, candidates, edges) {
  if (candidates.length === 1) return candidates[0];
  const idx = Math.sign(inEdge[2] - inEdge[0]);
  const idy = Math.sign(inEdge[3] - inEdge[1]);
  let best = candidates[0];
  let bestCross = -Infinity;
  for (const i of candidates) {
    const e = edges[i];
    const odx = Math.sign(e[2] - e[0]);
    const ody = Math.sign(e[3] - e[1]);
    const dot = idx * odx + idy * ody;
    if (dot < -0.5) continue;
    const cross = idx * ody - idy * odx;
    if (cross > bestCross) {
      bestCross = cross;
      best = i;
    }
  }
  return best;
}

/**
 * Trace the outline of a set of cells from their exposed edges. Only the largest loop is kept, so holes are filled,
 * because the sight shape in foundry/patches/vision.mjs is a single polygon.
 * @param {Set<string>} cellSet Cell keys.
 * @param {number} g Grid size in pixels.
 * @returns {number[]} Outline, as alternating x and y.
 */
export function traceCellBoundary(cellSet, g) {
  const edges = [];
  for (const key of cellSet) {
    const { x: c, y: r } = parseCellKey(key);
    if (!cellSet.has(cellKey(c, r - 1))) edges.push([c, r, c + 1, r]);
    if (!cellSet.has(cellKey(c + 1, r))) edges.push([c + 1, r, c + 1, r + 1]);
    if (!cellSet.has(cellKey(c, r + 1))) edges.push([c + 1, r + 1, c, r + 1]);
    if (!cellSet.has(cellKey(c - 1, r))) edges.push([c, r + 1, c, r]);
  }
  if (!edges.length) return [];
  const byStart = new Map();
  edges.forEach((e, i) => {
    const k = cellKey(e[0], e[1]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(i);
  });
  const used = new Array(edges.length).fill(false);
  const loops = [];
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    const loop = [];
    let ei = s;
    while (ei != null && !used[ei]) {
      used[ei] = true;
      const e = edges[ei];
      loop.push(e[0] * g, e[1] * g);
      const cand = (byStart.get(cellKey(e[2], e[3])) || []).filter(i => !used[i]);
      ei = cand.length ? pickNext(e, cand, edges) : null;
    }
    if (loop.length >= 6) loops.push(loop);
  }
  let best = loops[0] || [];
  let bestA = Math.abs(polyArea(best));
  for (const l of loops) {
    const a = Math.abs(polyArea(l));
    if (a > bestA) {
      best = l;
      bestA = a;
    }
  }
  return simplifyRectilinear(best);
}

/* -------------------------------------------- */
/*  Polygon cleanup                             */
/* -------------------------------------------- */

/**
 * Push a traceCellBoundary outline outward by `pad` pixels. The winding is normalised first, then each corner moves
 * along its two edges' directions, so the outline stays closed and rectilinear.
 * @param {number[]} pts Outline points.
 * @param {number} pad Distance to push outward, in pixels.
 * @returns {number[]}
 */
export function padRectilinearPolygon(pts, pad) {
  const n = pts.length / 2;
  if (n < 4 || !(pad > 0)) return pts;
  const oriented = polyArea(pts) >= 0 ? pts : reversePoints(pts);
  const out = new Array(oriented.length);
  for (let i = 0; i < n; i++) {
    const px = oriented[((i - 1 + n) % n) * 2];
    const py = oriented[((i - 1 + n) % n) * 2 + 1];
    const cx = oriented[i * 2];
    const cy = oriented[i * 2 + 1];
    const nx = oriented[((i + 1) % n) * 2];
    const ny = oriented[((i + 1) % n) * 2 + 1];
    const inx = Math.sign(cx - px);
    const iny = Math.sign(cy - py);
    const onx = Math.sign(nx - cx);
    const ony = Math.sign(ny - cy);
    out[i * 2] = cx + (iny + ony) * pad;
    out[i * 2 + 1] = cy - (inx + onx) * pad;
  }
  return out;
}

function reversePoints(pts) {
  const out = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

/** Drop the points that sit in the middle of a straight run, leaving one point per actual turn. */
function simplifyRectilinear(pts) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const px = pts[((i - 1 + n) % n) * 2];
    const py = pts[((i - 1 + n) % n) * 2 + 1];
    const cx = pts[i * 2];
    const cy = pts[i * 2 + 1];
    const nx = pts[((i + 1) % n) * 2];
    const ny = pts[((i + 1) % n) * 2 + 1];
    const collinear = (cx - px) * (ny - cy) - (cy - py) * (nx - cx) === 0;
    if (!collinear) out.push(cx, cy);
  }
  return out;
}
