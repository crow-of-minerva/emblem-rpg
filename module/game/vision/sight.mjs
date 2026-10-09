/** @layer game/vision */
import { FACTION_GROUPS } from '../../contracts/domains/characters.mjs';

/* -------------------------------------------- */
/*  Map Visible policy                          */
/* -------------------------------------------- */

/**
 * The Scene settings that go with a Map Visible change, for onPreUpdateSceneMapVisible in
 * foundry/adapters/document-writes/vision.mjs. Turning it on enables token vision, and fog exploration only if it
 * was disabled, so an existing exploration mode is kept. Turning it off asks for a fog reset.
 * @param {object} input Whether the toggle is being enabled and whether exploration is currently disabled.
 * @returns {{enableExploration: boolean, forceTokenVision: boolean, resetFog: boolean}}
 */
export function resolveMapVisibleFold(input = {}) {
  if (input.enabled) {
    return {
      enableExploration: input.explorationDisabled === true,
      forceTokenVision: true,
      resetFog: false
    };
  }
  return { enableExploration: false, forceTokenVision: false, resetFog: true };
}

/**
 * Whether a Scene update needs another full-map reveal: it touched Map Visible, the fog mode or token vision while
 * Map Visible is on. onSceneFogChanged in foundry/hooks/scene.mjs schedules the reveal.
 * @param {object} input Which keys the update touched, and whether Map Visible is on.
 * @returns {boolean}
 */
export function revealRefreshRequired(input = {}) {
  const touched = input.touchedMapVisible === true
    || input.touchedFogMode === true
    || input.touchedTokenVision === true;
  return touched && input.mapVisible === true;
}

/**
 * Whether the Map Visible reveal in foundry/patches/vision.mjs can commit the full-map fog: the fog texture is ready
 * and the Scene has fog exploration and token vision on.
 * @param {object} input Sprite readiness and the two settings the reveal rides on.
 * @returns {boolean}
 */
export function revealReady(input = {}) {
  return input.spriteValid === true && input.fogExploration === true && input.tokenVision === true;
}

/**
 * Whether gatedFogCommit in foundry/patches/vision.mjs can skip a fog commit: Map Visible is on, the commit is not
 * the reveal's own, and the reveal has landed in the live fog texture.
 */
export function fogCommitRedundant(input = {}) {
  return input.mapVisible === true && input.revealing !== true && input.revealLanded === true;
}

/* -------------------------------------------- */
/*  New scene defaults                          */
/* -------------------------------------------- */

/**
 * Fog defaults for a new Scene, for onPreCreateSceneFogDefaults in foundry/adapters/document-writes/vision.mjs:
 * token vision and fog exploration start off. A GM turns them on where needed, and Map Visible turns on both.
 * @param {object} input The pending scene's token vision and whether its exploration is already disabled.
 * @returns {{disableTokenVision: boolean, disableExploration: boolean}}
 */
export function newSceneFogDefaults(input = {}) {
  return {
    disableTokenVision: input.tokenVision !== false,
    disableExploration: input.explorationDisabled !== true
  };
}

/* -------------------------------------------- */
/*  Party pooling                               */
/* -------------------------------------------- */
const PARTY_SIGHT_TYPES = Object.freeze(new Set(FACTION_GROUPS.player));
const BLINDED_SIGHT_CELLS = 1;

/** Whether a faction pools sight with a party at all. */
function poolsPartySight(actorType) {
  return PARTY_SIGHT_TYPES.has(String(actorType ?? ''));
}

/**
 * Choose whose sight this client pools, for pooledVisionSource in foundry/patches/vision.mjs. A controlled party
 * unit picks its own party, or the empty-string pool when it has none. With no party unit controlled, a player
 * uses their assigned party and a GM sees everything.
 * @param {object} input The controlled units' faction and party, the caller's role, and their assigned party.
 * @returns {string|null} Pooling party id, the empty string for the unassigned pool, or null.
 */
export function resolveSightPool(input = {}) {
  const controlled = Array.isArray(input.controlled) ? input.controlled : [];
  const anchor = controlled.find(unit => poolsPartySight(unit?.actorType));
  if (anchor) return anchor.partyId ?? '';
  if (input.isGM === true) return null;
  return input.userPartyId ?? null;
}

/**
 * Whether a unit's sight joins the pool resolveSightPool chose. A unit joins its own party's pool. An Ally with no
 * party joins any pool, but a Lord or Retainer with no party joins none.
 * @param {string} pool Pooling party id, or the empty string for the unassigned pool.
 * @param {object} unit The unit's faction and party membership.
 * @returns {boolean}
 */
export function sharesPoolSight(pool, unit = {}) {
  if (!poolsPartySight(unit.actorType)) return false;
  const unitParty = unit.partyId ?? null;
  if (pool && pool === unitParty) return true;
  if (!unitParty && unit.actorType === 'Ally') return true;
  return false;
}

/* -------------------------------------------- */
/*  Sight range                                 */
/* -------------------------------------------- */

/**
 * Cap a blinded unit's sight at one square, for foundry/patches/vision.mjs. A range already shorter is kept.
 * @param {object} input The ordinary range, whether the unit is blinded, and units per square.
 * @returns {number}
 */
export function cappedSightRange(input = {}) {
  const range = Number(input.range) || 0;
  if (input.blinded !== true) return range;
  const distance = Number(input.gridDistance) > 0 ? Number(input.gridDistance) : 1;
  return Math.min(range, BLINDED_SIGHT_CELLS * distance);
}

/**
 * Add a unit's sight bonus, in squares, to its token's source sight range, for applySightBonus in
 * foundry/patches/vision.mjs. A null range means unlimited sight, so the answer is null and nothing is written.
 * @param {object} input The source range, the bonus in squares, and units per square.
 * @returns {number|null}
 */
export function sightRangeWithBonus(input = {}) {
  if (typeof input.baseRange !== 'number') return null;
  const bonus = Number(input.bonusSquares);
  const distance = Number(input.gridDistance) > 0 ? Number(input.gridDistance) : 1;
  return Math.max(0, input.baseRange + ((Number.isFinite(bonus) ? bonus : 0) * distance));
}

/* -------------------------------------------- */
/*  Movement anchoring                          */
/* -------------------------------------------- */

/**
 * Where a unit sees from while it plans a move, for anchoredVisionSourceData in foundry/patches/vision.mjs: the
 * square it committed to, not the preview, keeping the footprint's centre offset for large units. Null outside
 * planning and while exploring, so sight follows the live position.
 * @param {object} input Whether the unit is planning a move or exploring, the committed square, and the token's
 *   corner and centre.
 * @returns {{x: number, y: number}|null}
 */
export function committedSightAnchor(input = {}) {
  if (input.planning !== true || input.exploring === true) return null;
  const anchor = input.anchor;
  if (!Number.isFinite(anchor?.x) || !Number.isFinite(anchor?.y)) return null;
  if (!Number.isFinite(input.centerX) || !Number.isFinite(input.centerY)) return null;
  return {
    x: exactPixel(anchor.x + (input.centerX - (Number(input.cornerX) || 0))),
    y: exactPixel(anchor.y + (input.centerY - (Number(input.cornerY) || 0)))
  };
}

function exactPixel(value) {
  return Math.round(value * 1000) / 1000;
}

/* -------------------------------------------- */
/*  Re-initialisation gate                      */
/* -------------------------------------------- */

/**
 * Whether gatedInitializeSources in foundry/patches/vision.mjs must let core rebuild a token's sight source. Only an
 * unchanged source that emits no light, held at the committed square while its unit plans a move, is skipped. Any
 * lifecycle, visibility or environment change rebuilds it.
 * @param {object|null} previous The values recorded at the last rebuild core performed, or null.
 * @param {object} current The same values for the call being decided.
 * @returns {boolean}
 */
export function sightReinitializationNeeded(previous, current = {}) {
  if (!previous || !current) return true;
  if (current.deleted === true || current.preview === true || current.emitsLight !== false) return true;
  if (previous.emitsLight !== false) return true;
  if (current.planning !== true || current.exploring === true) return true;
  if (current.eligible !== true || previous.eligible !== true) return true;
  if (!current.sourceId || current.sourceId !== previous.sourceId) return true;
  if (current.invalidation !== previous.invalidation) return true;
  if (current.visible !== previous.visible) return true;
  return !sameSightRecord(previous.data, current.data) || !sameSightRecord(previous.blinded, current.blinded);
}

function sameSightRecord(left = {}, right = {}) {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  for (const key of keys) {
    const a = left?.[key];
    const b = right?.[key];
    if (a === b) continue;
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    return false;
  }
  return true;
}
