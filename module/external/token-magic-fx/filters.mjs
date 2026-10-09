/** @layer external/token-magic-fx */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { TOKEN_FX_FLAG_KEY, normalizeTokenFxConfig } from '../../contracts/domains/tokens.mjs';
import { hexColor } from '../../lib/core/runtime.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Combat impact filters                       */
/* -------------------------------------------- */
const FILTERS_BY_DAMAGE_TYPE = Object.freeze({
  fire: [{
    filterType: 'fire', filterId: 'renderDamage', autoDestroy: true,
    intensity: 1, color: 0xFFFFFF, amplitude: 1, time: 0, blend: 2, fireBlend: 1,
    animated: {
      time: { active: true, loopDuration: 1200, loops: 1, speed: -0.0074, animType: 'move' },
      intensity: { active: true, loopDuration: 1200, loops: 1, val1: 0.8, val2: 2, animType: 'syncCosOscillation' },
      amplitude: { active: true, loopDuration: 1200, loops: 1, val1: 1, val2: 1.4, animType: 'syncCosOscillation' }
    }
  }],
  ice: [
    {
      filterType: 'adjustment', filterId: 'renderDamageIce', autoDestroy: true,
      saturation: 0.3, brightness: 1.5, contrast: 1.8, gamma: 1.2,
      red: 0.6, green: 0.8, blue: 1.2, alpha: 1,
      animated: {
        brightness: {
          active: true, loopDuration: 200, loops: 2, animType: 'syncCosOscillation', val1: 0.8, val2: 2.2
        }
      }
    },
    {
      filterType: 'glow', filterId: 'renderDamage', autoDestroy: true,
      outerStrength: 4, innerStrength: 1, color: 0x68cdff, quality: 0.8, padding: 20,
      animated: {
        outerStrength: {
          active: true, loopDuration: 150, loops: 3, animType: 'syncSinOscillation', val1: 3, val2: 12
        }
      }
    }
  ],
  lightning: [{
    filterType: 'electric', filterId: 'renderDamage', autoDestroy: true,
    color: 0x00cfcf, time: 0, blend: 1, intensity: 8,
    animated: { time: { active: true, loopDuration: 200, loops: 3, animType: 'move', speed: 0.01 } }
  }],
  wind: [{
    filterType: 'wave', filterId: 'renderDamage', autoDestroy: true,
    time: 0, anchorX: 0.5, anchorY: 0.5, strength: 0.05, frequency: 60,
    color: 0xd1ff81, maxIntensity: 2, minIntensity: 0.5, padding: 10,
    animated: { time: { active: true, loopDuration: 120, loops: 3, animType: 'move', speed: 0.015 } }
  }],
  arcane: [{
    filterType: 'liquid', filterId: 'renderDamage', autoDestroy: true,
    color: 0xff92ff, time: 0, blend: 8, intensity: 6, spectral: true, scale: 1.2,
    animated: { time: { active: true, loopDuration: 100, loops: 3, animType: 'move', speed: 0.008 } }
  }],
  decay: [
    {
      filterType: 'adjustment', filterId: 'renderDamageDecay', autoDestroy: true,
      saturation: 0.4, brightness: 0.7, contrast: 2.5, gamma: 0.8,
      red: 0.3, green: 0.6, blue: 0.2, alpha: 1,
      animated: {
        brightness: {
          active: true, loopDuration: 180, loops: 3, animType: 'chaoticOscillation', val1: 0.3, val2: 1.2
        }
      }
    },
    {
      filterType: 'smoke', filterId: 'renderDamage', autoDestroy: true,
      color: 0x17791c, time: 0, blend: 6, dimX: 1.2, dimY: 1.2,
      animated: { time: { active: true, loopDuration: 150, loops: 3, animType: 'move', speed: 0.008 } }
    }
  ],
  shadow: [{
    filterType: 'adjustment', filterId: 'renderDamage', autoDestroy: true,
    saturation: 0.2, brightness: 0.3, contrast: 2, gamma: 0.8,
    red: 0.4, green: 0.1, blue: 0.8, alpha: 1,
    animated: {
      brightness: {
        active: true, loopDuration: 120, loops: 3, animType: 'chaoticOscillation', val1: 0.1, val2: 0.5
      }
    }
  }],
  holy: [
    {
      filterType: 'adjustment', filterId: 'renderDamageFlash', autoDestroy: true,
      saturation: 0.5, brightness: 3, contrast: 0.5, gamma: 1,
      red: 1, green: 1, blue: 1, alpha: 1,
      animated: {
        brightness: {
          active: true, loopDuration: 70, loops: 3, animType: 'syncCosOscillation', val1: 1, val2: 4
        }
      }
    },
    {
      filterType: 'glow', filterId: 'renderDamage', autoDestroy: true,
      outerStrength: 7, innerStrength: 2, color: 0xffee00, opacity: 0.5, quality: 1, padding: 20,
      animated: {
        outerStrength: {
          active: true, loopDuration: 100, loops: 3, animType: 'syncCosOscillation', val1: 5, val2: 15
        }
      }
    }
  ]
});

const PHYSICAL_DEFAULT = [{
  filterType: 'adjustment', filterId: 'renderDamage', autoDestroy: true,
  saturation: 1, brightness: 0.5, contrast: 0.4, gamma: 1,
  red: 1, green: 0, blue: 0, alpha: 1,
  animated: {
    brightness: {
      active: true, loopDuration: 200, loops: 3, animType: 'chaoticOscillation', val1: 0, val2: 4
    }
  }
}];

const PHYSICAL_ALT = [{
  filterType: 'adjustment', filterId: 'renderDamage', autoDestroy: true,
  saturation: 1, brightness: 0.5, contrast: 0.4, gamma: 1,
  red: 1, green: 0, blue: 0, alpha: 1,
  animated: {
    brightness: {
      active: true, loopDuration: 100, loops: 3, animType: 'chaoticOscillation', val1: 0, val2: 4
    }
  }
}];

const SOFT_HIT = [{
  filterType: 'adjustment', filterId: 'renderDamage', autoDestroy: true,
  saturation: 1, brightness: 0.8, contrast: 0.6, gamma: 1.8,
  red: 1, green: 0.5, blue: 0.1, alpha: 1,
  animated: {
    brightness: {
      active: true, loopDuration: 200, loops: 3, animType: 'chaoticOscillation', val1: 0.3, val2: 2.5
    }
  }
}];

const ABSORB = [
  {
    filterType: 'shockwave', filterId: 'renderAbsorb', autoDestroy: true,
    time: 0, amplitude: 14, wavelength: 70, brightness: 1.1, radius: -1,
    center: [0.5, 0.5], padding: 30,
    animated: { time: { active: true, speed: 0.004, animType: 'move', loopDuration: 900, loops: 1 } }
  },
  {
    filterType: 'adjustment', filterId: 'renderAbsorbTint', autoDestroy: true,
    saturation: 1, brightness: 1, contrast: 1, gamma: 1,
    red: 1, green: 1, blue: 1, alpha: 1,
    animated: {
      red: { active: true, loopDuration: 900, loops: 1, animType: 'syncCosOscillation', val1: 1, val2: 0.3 },
      green: { active: true, loopDuration: 900, loops: 1, animType: 'syncCosOscillation', val1: 1, val2: 1.15 },
      blue: { active: true, loopDuration: 900, loops: 1, animType: 'syncCosOscillation', val1: 1, val2: 1.25 }
    }
  }
];

/* -------------------------------------------- */
/*  Applying and removing filters               */
/* -------------------------------------------- */
/**
 * The owner id on this client's impact filters. It matches no user, so Token Magic's animation loop (its Anime
 * class) makes none of the flag updates or auto-destroy writes it makes for a filter the local user owns.
 * clearLocalImpacts removes the filters instead.
 */
const LOCAL_FILTER_OWNER = 'emblem-rpg:local-transient';
const LOCAL_FILTER_TAG = 'emblemLocalImpact';
const LOCAL_IMPACT_TAIL_MS = 250;
const LOCAL_IMPACT_MAX_MS = 15000;
const localImpacts = new Map();
let localFilterSequence = 0;

/**
 * Play hit filters for HealthPresentation (its `impacts` option, wired in init/system.mjs). Each client builds the
 * filters on its own copy of the token.
 */
export class TokenMagicCombatImpacts {
  constructor({ tokens }) {
    this.tokens = tokens;
  }

  /**
   * Play the filters for one health message on this client's token mesh. Nothing is written to the Token document,
   * so every client shows the effect without a write. A hidden page skips it and keeps nothing to replay. Returns
   * false when the message has no filters or the token isn't on the canvas.
   */
  async apply(message) {
    if (pageHidden()) return false;
    const filters = filtersFor(message);
    if (!filters) return false;
    const token = await this.tokens.placeable(message?.tokenUuid);
    return token ? applyLocalImpact(token, filters) : false;
  }
}

/**
 * Build the filters from Token Magic's filter classes and add them to the token's mesh, with no document write.
 * They're removed when their animation ends, when the token is destroyed (destroyToken) or on canvasTearDown.
 * They carry no Token Magic rank, and Token Magic may destroy them early when it redraws the token's own filters.
 */
function applyLocalImpact(token, filters) {
  const registry = globalThis.TokenMagic?.filterTypes;
  const mesh = token?.mesh;
  if (!registry || !token?.id || !mesh || mesh.destroyed) return false;
  const built = filters.map(parameters => buildLocalFilter(registry, token, parameters)).filter(Boolean);
  if (!built.length) return false;
  mesh.filters = [...(Array.isArray(mesh.filters) ? mesh.filters : []), ...built];
  const entry = localImpacts.get(token.id) ?? { token, filters: [], timer: null };
  entry.token = token;
  entry.filters.push(...built);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => clearLocalImpacts(token.id), localImpactDurationMs(filters));
  localImpacts.set(token.id, entry);
  return true;
}

/** Remove every filter this client built for one Token, and stop the animations Token Magic registered for them. */
export function clearLocalImpacts(subject) {
  const tokenId = typeof subject === 'string' ? subject : String(subject?.id ?? subject?.document?.id ?? '');
  const entry = tokenId ? localImpacts.get(tokenId) : null;
  if (!entry) return false;
  localImpacts.delete(tokenId);
  if (entry.timer) clearTimeout(entry.timer);
  stopLocalAnimations(tokenId, entry.filters);
  const mesh = entry.token?.mesh;
  if (mesh && !mesh.destroyed && Array.isArray(mesh.filters)) {
    const kept = mesh.filters.filter(filter => !entry.filters.includes(filter));
    mesh.filters = kept.length ? kept : null;
  }
  for (const filter of entry.filters) {
    if (filter?.destroyed !== true && typeof filter?.destroy === 'function') filter.destroy();
  }
  return true;
}

/** Remove every impact filter this client built. init/hooks.mjs calls it on canvasTearDown. */
export function clearAllLocalImpacts() {
  for (const tokenId of [...localImpacts.keys()]) clearLocalImpacts(tokenId);
}

function buildLocalFilter(registry, token, parameters) {
  const FilterClass = registry[String(parameters?.filterType ?? '')];
  if (typeof FilterClass !== 'function') return null;
  try {
    const filter = new FilterClass({
      ...structuredClone(parameters),
      placeableId: String(token.id),
      placeableType: String(token.document?.documentName ?? 'Token'),
      filterId: `${LOCAL_FILTER_TAG}:${parameters.filterId ?? parameters.filterType}`,
      filterInternalId: `${LOCAL_FILTER_TAG}:${++localFilterSequence}`,
      filterOwner: LOCAL_FILTER_OWNER,
      enabled: true
    });
    filter.transient = true;
    filter[LOCAL_FILTER_TAG] = true;
    return filter;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'buildLocalFilter');
    return null;
  }
}

/** Drop the animation entries Token Magic registered for these filters, so none keeps animating a removed filter. */
function stopLocalAnimations(tokenId, filters) {
  const animations = globalThis.TokenMagic?._getAnimeMap?.();
  if (!animations || typeof animations.delete !== 'function') return;
  const ids = new Set(filters.map(filter => filter?.filterId).filter(Boolean));
  for (const [key, anime] of [...animations]) {
    const puppet = anime?.puppet;
    if (String(puppet?.placeableId ?? '') === String(tokenId) && ids.has(puppet?.filterId)) animations.delete(key);
  }
}

/** How long the authored animation runs, so a treatment is released once its own effect is over. */
function localImpactDurationMs(filters) {
  let longest = 0;
  for (const parameters of filters) {
    for (const animated of Object.values(parameters?.animated ?? {})) {
      const loops = Number(animated?.loops);
      const duration = (Number(animated?.loopDuration) || 0) * (Number.isFinite(loops) ? Math.max(1, loops) : 1);
      longest = Math.max(longest, duration);
    }
  }
  return Math.min(LOCAL_IMPACT_MAX_MS, longest + LOCAL_IMPACT_TAIL_MS);
}

/* -------------------------------------------- */
/*  Treatment selection                         */
/* -------------------------------------------- */
function filtersFor(message) {
  if (message?.absorbed > 0 && message?.amount === 0) return ABSORB;
  if (message?.amount > 0) {
    return FILTERS_BY_DAMAGE_TYPE[message.damageType]
      ?? (message.physicalVariant === 'alt' ? PHYSICAL_ALT : PHYSICAL_DEFAULT);
  }
  if (message?.stanceAmount > 0 && message?.allowSoftHit === true) return SOFT_HIT;
  return null;
}

/* -------------------------------------------- */
/*  Authored filter identity                    */
/* -------------------------------------------- */
const TOKEN_FX_IDS = Object.freeze({
  adjust: 'emblem-fx-adjust',
  glow: 'emblem-fx-glow',
  bloom: 'emblem-fx-bloom',
  bevel: 'emblem-fx-bevel',
  distort: 'emblem-fx-distort',
  smoke: 'emblem-fx-smoke',
  transform: 'emblem-fx-transform'
});

const TOKEN_FX_ID_SET = new Set([
  ...Object.values(TOKEN_FX_IDS), 'emblem-fx-outline', 'emblem-fx-shadow'
]);

/* -------------------------------------------- */
/*  Filter derivation                           */
/* -------------------------------------------- */
/** Derive the Token Magic filter parameters an authored effect config asks for. */
export function buildTokenFxFilters(raw) {
  const config = normalizeTokenFxConfig(raw);
  const filters = [];
  if (config.adjustEnabled) filters.push(adjustmentFilter(config));
  if (config.glowEnabled) filters.push(glowFilter(config));
  if (config.bloomEnabled) filters.push(bloomFilter(config));
  if (config.bevelEnabled) filters.push(bevelFilter(config));
  if (config.distortEnabled) filters.push(distortionFilter(config));
  if (config.smokeEnabled) filters.push(smokeFilter(config));
  if (config.transformEnabled) filters.push(transformFilter(config));
  for (const filter of filters) filter.enabled = true;
  return filters;
}

function adjustmentFilter(config) {
  return {
    filterType: 'adjustment', filterId: TOKEN_FX_IDS.adjust,
    brightness: config.brightness, contrast: config.contrast, saturation: config.saturation,
    gamma: config.gamma, red: config.red, green: config.green, blue: config.blue, alpha: 1
  };
}

function glowFilter(config) {
  const filter = {
    filterType: 'glow', filterId: TOKEN_FX_IDS.glow,
    outerStrength: config.glowStrength, innerStrength: config.glowInner,
    color: hexColor(config.glowColor), quality: 0.5, distance: 10, padding: 12
  };
  if (!config.glowAnimEnabled) return filter;
  if (config.glowAnimType === 'pulse') {
    filter.animated = { outerStrength: {
      active: true, loopDuration: config.glowAnimDuration, animType: 'syncCosOscillation',
      val1: config.glowPulseMin, val2: config.glowPulseMax
    } };
    return filter;
  }
  filter.animated = { color: {
    active: true, loopDuration: config.glowAnimDuration, animType: config.glowAnimType,
    val1: hexColor(config.glowColor), val2: hexColor(config.glowColor2)
  } };
  return filter;
}

function bloomFilter(config) {
  return {
    filterType: 'xbloom', filterId: TOKEN_FX_IDS.bloom,
    threshold: config.bloomThreshold, bloomScale: config.bloomScale, blur: config.bloomBlur,
    brightness: config.bloomBrightness, quality: 4, padding: 10
  };
}

function bevelFilter(config) {
  return {
    filterType: 'bevel', filterId: TOKEN_FX_IDS.bevel,
    rotation: config.bevelRotation, thickness: config.bevelThickness,
    lightColor: hexColor(config.bevelLightColor), lightAlpha: config.bevelLightAlpha,
    shadowColor: hexColor(config.bevelShadowColor), shadowAlpha: config.bevelShadowAlpha, padding: 10
  };
}

function distortionFilter(config) {
  const filter = {
    filterType: 'distortion', filterId: TOKEN_FX_IDS.distort,
    maskPath: 'modules/tokenmagic/fx/assets/distortion-1.png',
    maskSpriteScaleX: config.distortStrength,
    maskSpriteScaleY: config.distortStrength * config.distortStretch, padding: 20
  };
  if (config.distortSpeed) {
    filter.animated = {
      maskSpriteX: { active: true, speed: config.distortSpeed, animType: 'move' },
      maskSpriteY: { active: true, speed: config.distortSpeed * 1.4, animType: 'move' }
    };
  }
  return filter;
}

function smokeFilter(config) {
  const filter = {
    filterType: 'smoke', filterId: TOKEN_FX_IDS.smoke,
    color: hexColor(config.smokeColor), time: 0, blend: Math.round(config.smokeBlend),
    dimX: config.smokeScale, dimY: config.smokeScale * config.smokeStretch
  };
  if (config.smokeSpeed) {
    filter.animated = { time: { active: true, speed: config.smokeSpeed, animType: 'move' } };
  }
  return filter;
}

function transformFilter(config) {
  const filter = {
    filterType: 'transform', filterId: TOKEN_FX_IDS.transform,
    scaleX: config.transformScale, scaleY: config.transformScale,
    rotation: config.transformRotation,
    translationX: config.transformTranslateX, translationY: config.transformTranslateY
  };
  if (config.transformTwist) {
    filter.twRotation = config.transformTwist;
    filter.twRadiusPercent = 100;
  }
  if (config.transformBulge) {
    filter.bpStrength = config.transformBulge;
    filter.bpRadiusPercent = 100;
  }
  return filter;
}

/* -------------------------------------------- */
/*  Prototype persistence                       */
/* -------------------------------------------- */
/**
 * The prototype token's new Token Magic filter list: filters from other sources stay, and this system's are
 * replaced by `filters`. The Actor Control Panel saves the result.
 */
export function buildPrototypeTokenFxFilters(actor, filters) {
  const owner = game.user.id;
  const foreign = (actor?.prototypeToken?.flags?.tokenmagic?.filters ?? [])
    .filter(entry => !TOKEN_FX_ID_SET.has(entry?.tmFilters?.tmFilterId));
  return foreign.concat(filters.map(filter => ({
    tmFilters: {
      tmFilterId: filter.filterId,
      tmFilterInternalId: foundry.utils.randomID(),
      tmFilterType: filter.filterType,
      tmFilterOwner: owner,
      tmParams: filter
    }
  })));
}

/* -------------------------------------------- */
/*  Placed-token sync                           */
/* -------------------------------------------- */
const tokenFxSyncs = new Map();

/**
 * Apply a Token FX config to the actor's placed Tokens on every Scene: the Actor Control Panel's live preview while
 * editing, and again after saving. A Token's own actor reaches only that Token. A world actor skips the unlinked
 * Tokens whose own actor data carries a Token FX config, since that Token's panel set it. Returns whether any Token
 * was queued.
 */
export function applyTokenFxToPlacedTokens(actor, config) {
  if (!actor || typeof globalThis.TokenMagic?.addUpdateFilters !== 'function') return false;
  const filters = buildTokenFxFilters(config);
  const tokens = actor.getDependentTokens({ concreteOnly: true })
    .filter(token => actor.isToken || !carriesOwnTokenFx(token));
  for (const token of tokens) queueTokenFxSync(token, filters);
  return tokens.length > 0;
}

/** Whether an unlinked Token's actor delta holds its own Token FX config. */
function carriesOwnTokenFx(token) {
  return !token.actorLink && token.delta?.flags?.[SYSTEM_ID]?.[TOKEN_FX_FLAG_KEY] !== undefined;
}

/**
 * Run one sync at a time per Token, keeping only the newest filters that arrive meanwhile. Token Magic reads a
 * Token's filter flag when called and writes the whole list back, so overlapping calls would overwrite each other.
 * When Token Magic sends a player's write to the GM instead, the call returns before the write lands, so those
 * syncs can still overlap.
 */
function queueTokenFxSync(token, filters) {
  const pending = tokenFxSyncs.get(token.uuid);
  if (pending) {
    pending.next = filters;
    return;
  }
  const entry = { next: filters };
  tokenFxSyncs.set(token.uuid, entry);
  void (async () => {
    while (entry.next) {
      const next = entry.next;
      entry.next = null;
      try {
        await syncTokenFx(token, next);
      } catch (diagnosticError) {
        reportFoundryError(import.meta.url, diagnosticError, 'applyTokenFxToPlacedTokens');
      }
    }
    tokenFxSyncs.delete(token.uuid);
  })();
}

/**
 * Bring one Token's Token Magic filters in line with `filters`: drop this system's filters that are no longer
 * enabled in one Token write, then add or update the enabled ones through Token Magic. Filters from other sources
 * stay. Token Magic writes its bookkeeping into the parameters it is given, so each Token gets its own copy.
 */
async function syncTokenFx(token, filters) {
  const active = new Set(filters.map(filter => filter.filterId));
  const current = token.getFlag('tokenmagic', 'filters') ?? [];
  const kept = current.filter(entry => {
    const id = entry?.tmFilters?.tmFilterId;
    return !TOKEN_FX_ID_SET.has(id) || active.has(id);
  });
  if (kept.length < current.length) {
    if (kept.length) await token.setFlag('tokenmagic', 'filters', kept);
    else await token.unsetFlag('tokenmagic', 'filters');
  }
  if (filters.length) await TokenMagic.addUpdateFilters(token, structuredClone(filters));
}
