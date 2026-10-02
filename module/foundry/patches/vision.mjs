/** @layer foundry/patches */
import { installWrapperGroup } from '../../external/host.mjs';
import {
  boundsFromPoints,
  cellRange,
  footprintCells,
  footprintFromCenter,
  padRectilinearPolygon,
  selectVisibleCells,
  traceCellBoundary
} from '../../game/vision/cells.mjs';
import {
  cappedSightRange,
  committedSightAnchor,
  fogCommitRedundant,
  resolveSightPool,
  revealReady,
  sharesPoolSight,
  sightRangeWithBonus,
  sightReinitializationNeeded
} from '../../game/vision/sight.mjs';
import {
  projectPartySightFacts,
  projectSightAnchorFacts,
  projectSightBlinded,
  projectSightBonusSquares,
  projectSightPoolContext,
  projectSightReinitializationFacts
} from '../adapters/projections/vision.mjs';
import { cellKey, footprintDistance } from '../../lib/core/geometry.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Installation                                */
/* -------------------------------------------- */
const visibleCellCache = new WeakMap();
const sightTraces = new WeakMap();
const sightRecords = new WeakMap();
const sourceIds = new WeakMap();
let sightInvalidation = 0;
let nextSourceId = 0;
let revealedTexture = null;
let revealing = false;

/**
 * Install the system's vision rules in Foundry's canvas, from the `setup` hook (init/hooks.mjs): square-by-square
 * sight and light, sight from the committed square while a unit plans a move, shared party sight, the sight-range
 * bonus, doors that stay visible, the sight re-initialisation gate and the Map Visible fog gate. A group that can't
 * be installed is logged, as an error for a required group and a warning otherwise, and the other groups still
 * install.
 */
export function installVisionPatches() {
  installWrapperGroup({
    id: 'rectilinear-vision',
    required: true,
    wrappers: [
      {
        target: 'foundry.canvas.sources.PointVisionSource.prototype._createRestrictedPolygon',
        fn: rectilinearRestrictedPolygon,
        type: 'OVERRIDE'
      },
      {
        target: 'foundry.canvas.sources.PointVisionSource.prototype._createLightPolygon',
        fn: rectilinearLightPolygon,
        type: 'OVERRIDE'
      },
      {
        target: 'foundry.canvas.perception.DetectionMode.prototype._testRange',
        fn: rectilinearTestRange,
        type: 'OVERRIDE'
      },
      {
        target: 'foundry.canvas.perception.DetectionMode.prototype._testLOS',
        fn: rectilinearTestLOS,
        type: 'OVERRIDE'
      }
    ]
  });
  installWrapperGroup({
    id: 'rectilinear-light',
    required: true,
    wrappers: [
      {
        target: 'foundry.canvas.sources.PointLightSource.prototype._createShapes',
        fn: rectilinearLightShapes,
        type: 'WRAPPER'
      },
      {
        target: 'foundry.canvas.sources.PointLightSource.prototype._configure',
        fn: rectilinearLightConfigure,
        type: 'WRAPPER'
      }
    ]
  });
  installWrapperGroup({
    id: 'movement-vision-gate',
    required: true,
    wrappers: [{
      target: 'foundry.canvas.placeables.Token.prototype._getVisionSourceData',
      fn: anchoredVisionSourceData,
      type: 'WRAPPER'
    }]
  });
  installWrapperGroup({
    id: 'shared-party-vision',
    required: true,
    wrappers: [{
      target: 'foundry.canvas.placeables.Token.prototype._isVisionSource',
      fn: pooledVisionSource,
      type: 'MIXED'
    }]
  });
  installWrapperGroup({
    id: 'vision-bonus',
    required: false,
    wrappers: [{
      target: 'foundry.documents.TokenDocument.prototype.prepareBaseData',
      fn: bonusSightPreparation,
      type: 'WRAPPER'
    }]
  });
  installWrapperGroup({
    id: 'door-visibility',
    required: false,
    wrappers: [{
      target: 'foundry.canvas.groups.CanvasVisibility.prototype.testVisibility',
      fn: doorAlwaysVisible,
      type: 'MIXED'
    }]
  });
  installWrapperGroup({
    id: 'sight-reinitialization-gate',
    required: false,
    wrappers: [{
      target: 'foundry.canvas.placeables.Token.prototype.initializeSources',
      fn: gatedInitializeSources,
      type: 'MIXED'
    }]
  });
  installWrapperGroup({
    id: 'map-visible-fog-commit',
    required: false,
    wrappers: [{
      target: 'foundry.canvas.perception.FogManager.prototype.commit',
      fn: gatedFogCommit,
      type: 'MIXED'
    }]
  });
}

/* -------------------------------------------- */
/*  Rectilinear sight                           */
/* -------------------------------------------- */

/** A sight range with the blindness cap applied, in scene distance units. */
function effectiveRange(tokenDocument, range) {
  return cappedSightRange({
    range,
    blinded: projectSightBlinded(tokenDocument?.actor),
    gridDistance: canvas.dimensions.distance
  });
}

/**
 * The footprint sight is measured from: the vision source's position, which anchoredVisionSourceData keeps on the
 * committed square. Reading the preview token instead would reveal a route the player hasn't committed to.
 * @param {object} source The vision source.
 * @param {TokenDocument} tokenDocument Its token document.
 * @param {number} g Grid size.
 * @returns {{tc: number, tr: number, tw: number, th: number}}
 */
function sourceFootprint(source, tokenDocument, g) {
  const tw = Math.max(1, Math.round(tokenDocument.width));
  const th = Math.max(1, Math.round(tokenDocument.height));
  const { tc, tr } = footprintFromCenter(source.x, source.y, tw, th, g);
  return { tc, tr, tw, th };
}

/**
 * Pad the traced polygon to the gridline by Foundry's light-edge offset, so light and sight meet without gaps. Soft
 * edges are read from canvas.performance, because the source's own flag is set only after its shapes are built.
 * @param {number[]} traced The traced outline.
 * @param {object} source The source being shaped.
 * @param {number} g Grid size in pixels.
 * @returns {number[]}
 */
function paddedStaircase(traced, source, g) {
  if (!globalThis.canvas?.performance?.lightSoftEdges || source.isPreview) return traced;
  const offset = foundry.canvas.sources.PointLightSource.EDGE_OFFSET;
  const pad = Math.abs(offset) * (g / 100);
  return pad > 0 ? padRectilinearPolygon(traced, pad) : traced;
}

/**
 * The cells within range that the core's own wall-clipped shape still covers, traced into an outline, or null
 * where the trace is too small to be a polygon.
 * @param {object} source The vision source.
 * @returns {{polygon: PIXI.Polygon, cells: Set<string>}|null}
 */
function rectilinearSightShape(source) {
  const tokenDocument = source.object?.document;
  if (!tokenDocument) return null;
  const los = source.los;
  const trace = sightTrace(source, tokenDocument, los);
  if (!trace.points) return null;
  const polygon = new los.constructor();
  polygon.origin = { x: source.x, y: source.y };
  polygon.points = [...trace.points];
  polygon.bounds = new PIXI.Rectangle(trace.bounds.x, trace.bounds.y, trace.bounds.width, trace.bounds.height);
  return { polygon, cells: trace.cells };
}

/**
 * The cell scan and outline behind rectilinearSightShape, done once per line-of-sight polygon.
 *
 * Foundry's PointVisionSource#_createShapes builds a fresh `los`, then asks for the light polygon and the restricted
 * polygon from it. Both overrides here need the same scan, so the second reuses the first. The inputs are part of
 * the key as well, so a later call against the same `los` with a changed range or footprint scans again.
 * @returns {{key: string, cells: Set<string>, points: number[]|null, bounds: object|null}}
 */
function sightTrace(source, tokenDocument, los) {
  const g = canvas.dimensions.size;
  const range = effectiveRange(tokenDocument, tokenDocument.sight?.range ?? 0);
  // A token with no vision range set sees without limit, so it keeps Foundry's own shape.
  if (range === Infinity) return { key: 'unlimited', cells: new Set(), points: null, bounds: null };
  // A very long range is held to the scene's size, as Foundry does for its own polygons.
  const R = cellRange(range, canvas.dimensions.distance, Math.ceil(canvas.dimensions.maxR / g));
  const { tc, tr, tw, th } = sourceFootprint(source, tokenDocument, g);
  const padded = Boolean(globalThis.canvas?.performance?.lightSoftEdges) && !source.isPreview;
  const key = [g, R, tc, tr, tw, th, padded].join('|');
  const kept = sightTraces.get(los);
  if (kept?.key === key) return kept;
  const cells = selectVisibleCells(footprintCells(tc, tr, tw, th, R), (x, y) => los.contains(x, y), g);
  const traced = traceCellBoundary(cells, g);
  const points = traced.length < 6 ? null : paddedStaircase(traced, source, g);
  const trace = { key, cells, points, bounds: points ? boundsFromPoints(points) : null };
  sightTraces.set(los, trace);
  return trace;
}

/**
 * The polygon bounding what a unit can see. A trace too small to be a polygon falls back to the core's own
 * shape, and the cached cell set is dropped with it so range and line-of-sight answers stay consistent.
 * @returns {PIXI.Polygon}
 */
function rectilinearRestrictedPolygon() {
  const shape = rectilinearSightShape(this);
  if (!shape) {
    visibleCellCache.delete(this);
    return this.los;
  }
  visibleCellCache.set(this, shape.cells);
  return shape.polygon;
}

/**
 * Limit Foundry light perception to the same cell range as sight so global illumination cannot reveal the whole
 * map.
 * @returns {PIXI.Polygon}
 */
function rectilinearLightPolygon() {
  return rectilinearSightShape(this)?.polygon ?? this.los;
}

/**
 * Whether a point is within sight range, measured in cells from the footprint.
 * @param {object} visionSource The source.
 * @param {object} mode The detection mode.
 * @param {object} _target The target.
 * @param {object} test The point being tested.
 * @returns {boolean}
 */
function rectilinearTestRange(visionSource, mode, _target, test) {
  const tokenDocument = visionSource.object?.document;
  if (!tokenDocument) return false;
  const range = effectiveRange(tokenDocument, mode.range);
  if (range <= 0) return false;
  if (range === Infinity) return true;
  const g = canvas.dimensions.size;
  const R = cellRange(range, canvas.dimensions.distance);
  const { tc, tr, tw, th } = sourceFootprint(visionSource, tokenDocument, g);
  const c = Math.floor(test.point.x / g);
  const r = Math.floor(test.point.y / g);
  return footprintDistance(c, r, 1, 1, tc, tr, tw, th) <= R;
}

/**
 * Whether a point is in line of sight, read from the cached cell set.
 *
 * Falls back to the core's own shape where no cache exists, which is the case for a source whose polygon has not
 * been built this frame or fell back to the core shape.
 * @param {object} visionSource The source.
 * @param {object} _mode The detection mode.
 * @param {object} _target The target.
 * @param {object} test The point being tested.
 * @returns {boolean}
 */
function rectilinearTestLOS(visionSource, _mode, _target, test) {
  const cells = visibleCellCache.get(visionSource);
  if (!cells) {
    const los = visionSource.los;
    return !!los?.contains(test.point.x, test.point.y);
  }
  const g = canvas.dimensions.size;
  const c = Math.floor(test.point.x / g);
  const r = Math.floor(test.point.y / g);
  return cells.has(cellKey(c, r));
}

/* -------------------------------------------- */
/*  Rectilinear light                           */
/* -------------------------------------------- */

/**
 * Re-derive the bright-to-dim ratio against the reshaped radius.
 *
 * The staircase reaches further into the corners than the circle it replaced, so the shape's radius grows. Left
 * alone, the ratio would shrink the bright region relative to the light as drawn. Foundry's _configure sets the
 * ratio from the light's own radius and runs after _createShapes, so the correction goes here, after it, rather
 * than in the shape wrapper.
 */
function rectilinearLightConfigure(wrapped, ...args) {
  const result = wrapped.call(this, ...args);
  const radius = this.shape?.config?.radius;
  if (Number.isFinite(radius) && radius > (this.data?.radius ?? 0) && this.data?.radius > 0) {
    this.ratio = Math.clamp(Math.abs(this.data.bright) / radius, 0, 1);
  }
  return result;
}

/**
 * Reshape the light's sweep polygon into the same cell staircase token sight uses.
 *
 * Errors are caught and reported, since a throw here would take the whole lighting refresh down and leave the
 * scene unlit.
 */
function rectilinearLightShapes(wrapped, ...args) {
  const result = wrapped.call(this, ...args);
  try {
    applyStaircaseShape(this);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | rectilinear light shaping failed:');
  }
  return result;
}

/**
 * Reshape Foundry’s wall-clipped light polygon into cell boundaries in place, preserving mesher config and origin.
 * Pad soft edges and expand the radius to the furthest corner. Leave unexpected shapes unchanged.
 * @param {object} source The light source.
 */
function applyStaircaseShape(source) {
  const shape = source.shape;
  if (!shape || typeof shape.contains !== 'function' || !shape.config) return;

  const g = canvas.dimensions?.size;
  if (!(g > 0)) return;

  const radiusPx = source.data?.radius ?? 0;
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return;
  // A very large radius is held to the scene's size, as for sight.
  const R = cellRange(radiusPx, g, Math.ceil(canvas.dimensions.maxR / g));
  if (R <= 0) return;

  const origin = shape.origin ?? { x: source.x, y: source.y };
  const tokenDocument = source.object?.document;
  const tw = Math.max(1, Math.round(tokenDocument?.width ?? 1));
  const th = Math.max(1, Math.round(tokenDocument?.height ?? 1));
  const { tc, tr } = footprintFromCenter(origin.x, origin.y, tw, th, g);

  const cells = selectVisibleCells(footprintCells(tc, tr, tw, th, R), (x, y) => shape.contains(x, y), g);
  const traced = traceCellBoundary(cells, g);
  if (traced.length < 6) return;

  const pts = paddedStaircase(traced, source, g);

  shape.points = pts;
  const bounds = boundsFromPoints(pts);
  shape.bounds = new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);

  let maxDistance = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const distance = Math.hypot(pts[i] - origin.x, pts[i + 1] - origin.y);
    if (distance > maxDistance) maxDistance = distance;
  }
  if (maxDistance > shape.config.radius) shape.config.radius = maxDistance;
}

/* -------------------------------------------- */
/*  Door visibility                             */
/* -------------------------------------------- */

/**
 * Keep a Door's own token visible through the wall box built around it.
 *
 * A shut door's box would otherwise occlude the door itself from a unit standing next to it, because the
 * token's centre sits behind the wall.
 */
function doorAlwaysVisible(wrapped, point, options = {}) {
  const actor = options?.object?.document?.actor ?? options?.object?.actor;
  if (actor?.type === 'Object' && String(actor.system?.objectType ?? '') === 'Door') return true;
  return wrapped(point, options);
}

/* -------------------------------------------- */
/*  Movement vision gate                        */
/* -------------------------------------------- */
/**
 * While a unit plans a move, its vision source stays on the square it committed to (committedSightAnchor in
 * game/vision/sight.mjs), so dragging the preview doesn't reveal the map.
 */
function anchoredVisionSourceData(wrapped, ...args) {
  const data = wrapped(...args);
  const facts = projectSightAnchorFacts(this.document);
  const anchor = committedSightAnchor({
    planning: facts.planning,
    exploring: facts.exploring,
    anchor: facts.anchor,
    cornerX: this.document.x,
    cornerY: this.document.y,
    centerX: this.center?.x,
    centerY: this.center?.y
  });
  if (anchor) {
    data.x = anchor.x;
    data.y = anchor.y;
  }
  return data;
}

/* -------------------------------------------- */
/*  Sight re-initialisation gate                */
/* -------------------------------------------- */
/**
 * Forget every unit's last sight initialisation, so each unit's next initializeSources call reaches Foundry.
 * init/hooks.mjs calls it on canvasReady and whenever a Scene, wall, light or region changes.
 */
export function invalidateSightGate() {
  sightInvalidation += 1;
}

/** Skip Token#initializeSources when nothing that shapes the unit's sight has changed (sightReinitializationNeeded). */
function gatedInitializeSources(wrapped, ...args) {
  const options = args[0] ?? {};
  let facts = null;
  try {
    facts = projectSightReinitializationFacts(this, {
      deleted: options.deleted === true, sourceId: sourceIdOf(this.vision), invalidation: sightInvalidation
    });
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Sight gate facts');
  }
  if (facts && !sightReinitializationNeeded(sightRecords.get(this), facts)) return undefined;
  sightRecords.delete(this);
  const result = wrapped(...args);
  if (facts && !facts.deleted && facts.eligible && this.vision) {
    sightRecords.set(this, Object.freeze({ ...facts, sourceId: sourceIdOf(this.vision) }));
  }
  return result;
}

function sourceIdOf(source) {
  if (!source || typeof source !== 'object') return null;
  if (!sourceIds.has(source)) sourceIds.set(source, nextSourceId += 1);
  return sourceIds.get(source);
}

/* -------------------------------------------- */
/*  Shared party sight                          */
/* -------------------------------------------- */
/** Make a unit a vision source on this client when it shares the sight pool resolveSightPool chose here. */
/** Also ensures NPCs with OBSERVER level permissions for players don't add to their vision*/
function pooledVisionSource(wrapped, ...args) {
  const pool = resolveSightPool(projectSightPoolContext());
  if (pool !== null
      && canvas.visibility.tokenVision
      && this.hasSight
      && !this.document.hidden
      && sharesPoolSight(pool, projectPartySightFacts(this.actor))) {
    return true;
  }
  if (!game.user.isGM && !this.actor?.isOwner) return false;
  return wrapped(...args);
}

/* -------------------------------------------- */
/*  Sight-range bonus                           */
/* -------------------------------------------- */
/** Wraps TokenDocument#prepareBaseData so every prepared token carries its actor's sight bonus. */
function bonusSightPreparation(wrapped, ...args) {
  applySightBonus(this);
  return wrapped(...args);
}

/**
 * Fold the actor's bonus into a token's prepared sight range.
 *
 * Computed from source data rather than the prepared value, so re-preparing a document without resetting it
 * cannot compound the bonus. A null source range means unlimited sight and is left alone.
 * @param {TokenDocument} tokenDocument The token document being prepared.
 */
function applySightBonus(tokenDocument) {
  const folded = sightRangeWithBonus({
    baseRange: tokenDocument?._source?.sight?.range,
    bonusSquares: projectSightBonusSquares(tokenDocument?.actor),
    gridDistance: sceneGridDistance(tokenDocument)
  });
  if (folded !== null) tokenDocument.sight.range = folded;
}

function sceneGridDistance(tokenDocument) {
  const distance = Number(tokenDocument?.parent?.grid?.distance ?? globalThis.canvas?.dimensions?.distance);
  return distance > 0 ? distance : 1;
}

/* -------------------------------------------- */
/*  Map Visible reveal                          */
/* -------------------------------------------- */

/**
 * Whether a scene is in Map Visible mode: fog of war stays on, but the whole map starts explored, so what a unit
 * currently sees is bright and the rest shows as remembered rather than as darkness.
 */
export function isMapVisible(scene) {
  return !!scene?.getFlag?.(SYSTEM_ID, 'mapVisible');
}

/**
 * Commit a full-map rectangle to Foundry's fog for Map Visible mode. It needs a valid fog texture, with token vision
 * and fog exploration on. The temporary rectangle is removed in `finally`, so it can't cover the Scene after a
 * failure.
 * @returns {boolean} Whether the reveal happened.
 */
function revealEntireFog() {
  const fog = globalThis.canvas?.fog;
  const vision = globalThis.canvas?.visibility?.vision;
  if (!vision) return false;
  const ready = revealReady({
    spriteValid: fog?.sprite?.texture?.valid === true,
    fogExploration: fog?.fogExploration === true,
    tokenVision: fog?.tokenVision === true
  });
  if (!ready) return false;

  const dims = canvas.dimensions;
  const g = new PIXI.Graphics();
  g.beginFill(0xFFFFFF, 1).drawRect(dims.sceneX, dims.sceneY, dims.sceneWidth, dims.sceneHeight).endFill();
  vision.addChild(g);
  revealing = true;
  try {
    if (!(fog.sprite.texture instanceof PIXI.RenderTexture)) fog.commit();
    fog.commit();
    const landed = fog.sprite?.texture;
    revealedTexture = landed instanceof PIXI.RenderTexture ? new WeakRef(landed) : null;
  } finally {
    revealing = false;
    vision.removeChild(g);
    g.destroy();
  }
  return revealedTexture !== null;
}

/** Whether the last reveal went into the texture this fog holds now, and that texture is still valid. */
function revealLanded(fog) {
  const revealed = revealedTexture?.deref();
  return revealed?.valid === true && revealed === fog?.sprite?.texture;
}

/** Skip a fog commit that would only redraw a fully revealed Map Visible scene. */
function gatedFogCommit(wrapped, ...args) {
  const redundant = fogCommitRedundant({
    mapVisible: isMapVisible(globalThis.canvas?.scene),
    revealing,
    revealLanded: revealLanded(this)
  });
  if (redundant) return;
  return wrapped(...args);
}

/** Keep committing the reveal until it lands in the texture the fog holds, bounded so an unready scene cannot spin. */
export function scheduleFogReveal(attempts = 30) {
  if (revealLanded(globalThis.canvas?.fog)) return;
  revealEntireFog();
  if (attempts <= 0) return;
  setTimeout(() => scheduleFogReveal(attempts - 1), 100);
}
