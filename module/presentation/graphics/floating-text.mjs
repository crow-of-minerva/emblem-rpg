/** @layer presentation/graphics */
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Floating text                               */
/* -------------------------------------------- */

/** The stage container every float shares. clearFloats removes it once empty, but only if this module created it. */
const FLOAT_LAYER = 'floatLayer';
/** Each float pops in until POP_MS, holds until HOLD_MS, then rises and fades for the rest of its duration. */
const POP_MS = 300;
const HOLD_MS = 500;

const activeFloats = new Set();
let ownsLayer = false;

/** The eased overshoot every float pops in with. */
function easeOutBack(progress) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + (c3 * ((progress - 1) ** 3)) + (c1 * ((progress - 1) ** 2));
}

/** The shared stage container floats are drawn into, created on first use. */
function floatLayer() {
  const stage = canvas.stage;
  if (!stage || !globalThis.PIXI) return null;
  const existing = stage.children?.find(child => child.name === FLOAT_LAYER);
  if (existing) return existing;
  const layer = new globalThis.PIXI.Container();
  layer.name = FLOAT_LAYER;
  layer.zIndex = 999999;
  layer.eventMode = 'none';
  stage.addChild(layer);
  ownsLayer = true;
  return layer;
}

/**
 * Animate one display object off a token and dispose of it when it finishes.
 * @param {object} display PIXI display object, already positioned.
 * @param {object} [options] `floatDistance`, `durationMs`, `maxScale`, and the `group` that owns it.
 * @returns {boolean} Whether the float was started.
 */
export function addFloat(display, { floatDistance = 0, durationMs = 1000, maxScale = 1, group = '' } = {}) {
  const layer = floatLayer();
  const ticker = canvas.app?.ticker;
  if (!layer || !ticker || pageHidden()) {
    display?.destroy?.({ children: true });
    return false;
  }
  layer.addChild(display);
  const startY = display.y;
  const duration = Math.max(1, Number(durationMs) || 1);
  let elapsed = 0;
  const tick = frame => {
    elapsed += Number(frame?.deltaMS ?? ticker.deltaMS) || (1000 / 60);
    if (elapsed < POP_MS) {
      display.scale.set(Math.min(easeOutBack(elapsed / POP_MS) * maxScale, maxScale));
      display.alpha = 1;
    } else if (elapsed < HOLD_MS) {
      display.scale.set(maxScale);
      display.alpha = 1;
    } else {
      const progress = Math.min(1, (elapsed - HOLD_MS) / Math.max(1, duration - HOLD_MS));
      display.y = startY - (floatDistance * progress);
      display.alpha = 1 - progress;
    }
    if (elapsed >= duration) clearFloat(entry);
  };
  const entry = { display, tick, ticker, group: String(group ?? '') };
  activeFloats.add(entry);
  ticker.add(tick);
  return true;
}

/**
 * Draw one line of floating text above a token.
 * @param {object} token Placeable with a `center`.
 * @param {string} text Line to draw.
 * @param {object} [options] Colour, size, offset, distance, duration and owning group.
 * @returns {boolean} Whether the float was started.
 */
export function showFloatingText(token, text, {
  color = '#FFFFFF',
  fontSize = null,
  fontScale = 0.4,
  offsetY = 0,
  floatDistance = null,
  durationMs = 1500,
  maxScale = 1,
  group = ''
} = {}) {
  if (!token?.center || !globalThis.PIXI || pageHidden()) return false;
  const grid = Number(canvas.grid?.size) || 100;
  const size = Number.isFinite(Number(fontSize)) && fontSize !== null
    ? Math.max(1, Number(fontSize))
    : Math.floor(grid * (Number(fontScale) || 0.4));
  const label = new globalThis.PIXI.Text(text, floatTextStyle(size, color));
  label.anchor?.set?.(0.5);
  label.position?.set?.(token.center.x, token.center.y + (Number(offsetY) || 0));
  label.zIndex = 999999;
  label.scale?.set?.(0);
  return addFloat(label, {
    floatDistance: Number.isFinite(Number(floatDistance)) && floatDistance !== null
      ? Number(floatDistance) : grid * 0.45,
    durationMs,
    maxScale,
    group
  });
}

/** The text style every float shares. */
export function floatTextStyle(fontSize, color) {
  return {
    fontFamily: 'Jersey 10',
    fontSize,
    fill: color ?? '#FFFFFF',
    stroke: 0x000000,
    strokeThickness: 4,
    align: 'center'
  };
}

/** Stop and dispose of one float. */
function clearFloat(entry) {
  entry.ticker?.remove?.(entry.tick);
  entry.display?.parent?.removeChild?.(entry.display);
  entry.display?.destroy?.({ children: true });
  activeFloats.delete(entry);
}

/**
 * Stop every float, or only one group's, and drop the layer when this module created it and nothing is left.
 * @param {string} [group] Group to clear, or every float when omitted.
 */
export function clearFloats(group = '') {
  for (const entry of [...activeFloats]) {
    if (!group || entry.group === group) clearFloat(entry);
  }
  if (activeFloats.size) return;
  const layer = canvas.stage?.children?.find(child => child.name === FLOAT_LAYER);
  if (ownsLayer && layer?.children?.length === 0) {
    layer.parent?.removeChild?.(layer);
    layer.destroy?.();
  }
  ownsLayer = false;
}
