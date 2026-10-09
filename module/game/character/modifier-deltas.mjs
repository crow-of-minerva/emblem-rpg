/** @layer game/character */
import { STATS } from '../../contracts/domains/characters.mjs';
import { compileCharacterData, formulaStatContribution } from './compilation.mjs';
import { MOVE_SCALINGS, normalizeMoveScaling } from '../movement/input-policy.mjs';

/* -------------------------------------------- */
/*  Modifier sources                            */
/* -------------------------------------------- */
const STAT_KEYS = Object.freeze(STATS.map(entry => entry.key));

/** Whether an aura, the terrain, a Rally, move scaling or an active effect changes any stat in this source. */
function hasStatModifierSources(source) {
  const stats = source.system.stats;
  if (Object.values(stats).some(node => Number(node?.aura) || 0)) return true;
  if (Object.values(source.terrainModifiers ?? {}).some(value => Number(value) || 0)) return true;
  if (Object.values(source.rallyModifiers ?? {}).some(value => Number(value) || 0)) return true;
  if (normalizeMoveScaling(source.moveScaling) !== MOVE_SCALINGS.NONE) return true;
  return (source.effectModifiers ?? []).length > 0 || Object.keys(source.effectOverrides ?? {}).length > 0;
}

/** The same source without its aura, terrain, Rally, move-scaling and effect contributions: the unit's own build. */
function stripStatModifierSources(source) {
  const stats = Object.fromEntries(Object.entries(source.system.stats)
    .map(([key, node]) => [key, { ...node, aura: 0 }]));
  return {
    ...source,
    system: { ...source.system, stats },
    terrainModifiers: null,
    rallyModifiers: null,
    effectModifiers: [],
    effectOverrides: {},
    moveScaling: MOVE_SCALINGS.NONE
  };
}

/* -------------------------------------------- */
/*  Measured deltas                             */
/* -------------------------------------------- */
/**
 * How much auras, terrain, a Rally, move scaling and active effects change each stat, measured by compiling the
 * unit with and without them. Summing the modifiers instead wouldn't work, because compilation isn't linear. The
 * BG3 HUD's modifier rows use the result (measureHudStatDeltas in external/bg3-hud/document-projection.mjs).
 * @param {object} source The Character compile source.
 * @param {string[]} [keys] Stat keys to measure.
 * @returns {Record<string, number>|null} Per-key deltas, or null when nothing modifies the unit.
 */
export function statModifierDeltas(source, keys = STAT_KEYS) {
  if (!source?.system?.stats || !hasStatModifierSources(source)) return null;
  const stripped = stripStatModifierSources(source);
  const modified = compileCharacterData(source);
  const baseline = compileCharacterData(stripped);
  const deltas = {};
  for (const key of keys) {
    deltas[key] = comparable(modified, key, source) - comparable(baseline, key, stripped);
  }
  return Object.freeze(deltas);
}

/** A stat's total, or its numeric contribution when the total is a formula rather than a number. */
function comparable(compiled, key, source) {
  const total = Number(compiled.stats[key].total);
  return Number.isFinite(total) ? total : formulaStatContribution(compiled, key, source);
}
