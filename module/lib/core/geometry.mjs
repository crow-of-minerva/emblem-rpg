/** @layer lib/core */

/*
 * Shared square-grid geometry for game rules and canvas projections. Cell keys are "column,row", and distances are
 * measured between footprint edges.
 */

/** The "column,row" key for a cell. Coordinates are floored, and anything non-numeric counts as 0. */
export function cellKey(x, y) {
  return `${Math.floor(Number(x) || 0)},${Math.floor(Number(y) || 0)}`;
}

/** The key for a cell held as an `{x, y}` record. */
export function cellKeyOf(cell) {
  return cellKey(cell?.x, cell?.y);
}

/** The `{x, y}` cell a cellKey key names. */
export function parseCellKey(key) {
  const text = String(key);
  const comma = text.indexOf(',');
  return { x: Number(text.slice(0, comma)), y: Number(text.slice(comma + 1)) };
}

/** Every cell a footprint covers, given its top-left square and its size in squares. */
export function footprintCells(x, y, width, height) {
  const left = Math.floor(Number(x) || 0);
  const top = Math.floor(Number(y) || 0);
  const cells = [];
  for (let dx = 0; dx < Math.max(1, Math.floor(Number(width) || 1)); dx += 1) {
    for (let dy = 0; dy < Math.max(1, Math.floor(Number(height) || 1)); dy += 1) {
      cells.push({ x: left + dx, y: top + dy });
    }
  }
  return cells;
}

/** The pixel centre of one cell on a square grid of `size` pixels. */
export function cellCenter(x, y, size) {
  const grid = Math.max(1, Number(size) || 1);
  return { x: (Math.floor(Number(x) || 0) + 0.5) * grid, y: (Math.floor(Number(y) || 0) + 0.5) * grid };
}

/** The keys of every cell in a rectangle, given its top-left square and its size in squares. */
export function rectKeys(x, y, width, height) {
  const keys = [];
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < height; dy++) keys.push(cellKey(x + dx, y + dy));
  }
  return keys;
}

/* -------------------------------------------- */
/*  Footprints                                  */
/* -------------------------------------------- */

/** The gap between two footprints along one axis, zero when they overlap on it. */
function axisGap(aStart, aSize, bStart, bSize) {
  return Math.max(0, aStart - (bStart + bSize - 1), bStart - (aStart + aSize - 1));
}

/**
 * Manhattan distance between the edges of two footprints, each given as column, row, width and height, for range
 * rules and planning. An axis on which they overlap adds nothing, and a diagonal step costs two.
 */
export function footprintDistance(ax, ay, aw, ah, bx, by, bw, bh) {
  return axisGap(ax, aw, bx, bw) + axisGap(ay, ah, by, bh);
}

/** footprintDistance for two footprints held as `{x, y, width, height}` rectangles. */
export function rectDistance(a, b) {
  return footprintDistance(a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height);
}
