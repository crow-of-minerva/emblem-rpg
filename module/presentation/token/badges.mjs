/** @layer presentation/token */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Badge assets                                */
/* -------------------------------------------- */
const OBJECTIVE_ICON = `systems/${SYSTEM_ID}/assets/ui/objective.png`;
const PROTECT_ICON = `systems/${SYSTEM_ID}/assets/ui/protect.png`;
const EXTRA_LIFE_ICON = `systems/${SYSTEM_ID}/assets/ui/extra-life.png`;
const STRIP_NAME = 'emblemTokenIcons';
const ICON_SPACING = 2;
const ICON_OVERSIZE = 1.1;
const STRIP_GAP = 6;
const LARGE_TOKEN_HEIGHT_MULTIPLIER = 1.6;
const MINIMUM_ICON_SIZE = 8;
const GRID_ICON_DIVISOR = 12;

/* -------------------------------------------- */
/*  Badge strip                                 */
/* -------------------------------------------- */
/**
 * Draw the objective, protected and extra-life badges above a token's Bar Brawl bars, from the encounter's cached
 * marker ids. init/hooks.mjs builds it. The bar positions are part of the drawn signature, so a later bar layout
 * change moves the badges too.
 */
export class TokenBadgeStrip {
  /** @param {{projectMarkers: () => {defeat: string[], protected: string[]}}} ports */
  constructor({ projectMarkers }) {
    this.projectMarkers = projectMarkers;
    this.defeat = new Set();
    this.protected = new Set();
  }

  /** Re-read the encounter's marked tokens, and return whether the marked set changed. */
  syncMarkers() {
    const markers = this.projectMarkers() ?? {};
    const defeat = new Set(markers.defeat ?? []);
    const guarded = new Set(markers.protected ?? []);
    if (sameIds(defeat, this.defeat) && sameIds(guarded, this.protected)) return false;
    this.defeat = defeat;
    this.protected = guarded;
    return true;
  }

  /** Re-read the marked tokens and redraw every token's badges when they changed. */
  refresh(tokens = canvas.tokens?.placeables ?? []) {
    if (!this.syncMarkers()) return false;
    for (const token of tokens) this.draw(token, { force: true });
    return true;
  }

  /** Draw the objective, protected and extra-life icons above a Token's bars. */
  draw(token, { force = false } = {}) {
    const actor = token?.actor;
    if (!actor || !globalThis.PIXI?.Container) return;
    const sources = this.badgeSources(token, actor);
    const geometry = stripGeometry(token, sources);
    const signature = `${sources.join('|')}@${geometry.x},${geometry.y},${geometry.size}`;
    if (!force && token.emblemBadgeSignature === signature) return;
    token.emblemBadgeSignature = signature;
    removeStrip(token);
    if (sources.length === 0) return;
    token.addChild?.(buildStrip(sources, geometry));
  }

  /** Forget the drawn signature so the next draw repaints from scratch. */
  release(token) {
    if (token) delete token.emblemBadgeSignature;
  }

  /** Order Token badges as objective, protected, then one heart per extra life. */
  badgeSources(token, actor) {
    const tokenId = String(token?.document?.id ?? token?.id ?? '');
    const extraLives = Math.max(0, Math.floor(Number(actor?.system?.special?.extraLives?.value) || 0));
    const sources = [];
    if (this.defeat.has(tokenId)) sources.push(OBJECTIVE_ICON);
    if (this.protected.has(tokenId)) sources.push(PROTECT_ICON);
    for (let index = 0; index < extraLives; index += 1) sources.push(EXTRA_LIFE_ICON);
    return sources;
  }
}

/* -------------------------------------------- */
/*  Strip geometry                              */
/* -------------------------------------------- */
function stripGeometry(token, sources) {
  const size = badgeIconSize(token);
  const total = (size * sources.length) + (ICON_SPACING * (sources.length - 1));
  return { size, x: ((Number(token.w) || 0) - total) / 2, y: stripTop(token, size) };
}

function buildStrip(sources, { size, x, y }) {
  const container = new PIXI.Container();
  container.name = STRIP_NAME;
  const stride = size + ICON_SPACING;
  for (const [index, source] of sources.entries()) {
    const sprite = new PIXI.Sprite(PIXI.Texture.from(source));
    sprite.width = size * ICON_OVERSIZE;
    sprite.height = size * ICON_OVERSIZE;
    sprite.x = index * stride;
    sprite.y = 0;
    container.addChild(sprite);
  }
  container.x = x;
  container.y = y;
  return container;
}

function stripTop(token, size) {
  const bars = token?.bars?.children ?? [];
  if (bars.length > 0) return Math.min(...bars.map(bar => Number(bar.y) || 0)) - size - STRIP_GAP;
  return (Number(token.h) || 0) - size - STRIP_GAP;
}

function badgeIconSize(token) {
  const grid = Number(canvas.dimensions?.size) || 0;
  let size = Math.max(grid / GRID_ICON_DIVISOR, MINIMUM_ICON_SIZE);
  if (Number(token?.document?.height) >= 2) size *= LARGE_TOKEN_HEIGHT_MULTIPLIER;
  return size;
}

function removeStrip(token) {
  const existing = token?.children?.find(child => child?.name === STRIP_NAME);
  if (!existing) return;
  token.removeChild?.(existing);
  existing.destroy?.();
}

function sameIds(left, right) {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}
