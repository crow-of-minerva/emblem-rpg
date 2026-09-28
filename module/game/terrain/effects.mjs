/** @layer game/terrain */
import { ENCOUNTER_PHASES, ENCOUNTER_PHASE_FACTIONS } from '../../contracts/domains/combat.mjs';
import { TERRAIN_SPAWN_STAGES } from '../../contracts/domains/terrain.mjs';
import {
  cellExemptions,
  sanitizeTileEffect,
  terrainCellAt,
  tileEffectIsActive,
  tileEffectsOf
} from './rules.mjs';
import { hpFloor } from '../combat/damage.mjs';

/** A step number the author filled in. A blank field reads as undefined, so it is never mistaken for zero. */
const authored = value => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/* -------------------------------------------- */
/*  Terrain effect patches                      */
/* -------------------------------------------- */

const STAT_KEYS = Object.freeze({ eva: 'evasionMod', def: 'defMod', res: 'resMod', mov: 'movementCost' });
const STAT_DEFAULTS = Object.freeze({ evasionMod: 0, defMod: 0, resMod: 0, movementCost: 1 });
const GROUP_PRESENT = Object.freeze({
  hazard: entry => entry.tileEffects !== undefined,
  vfx: entry => entry.effect !== undefined,
  light: entry => entry.light !== undefined || entry.lightKey !== undefined
});
const OVERWRITE_BEHAVIORS = new Set(['forbid', 'clear', 'clearRespawn']);

/**
 * Build the grouped patch an authored terrainEdit step applies, for that step's writer in
 * foundry/adapters/document-writes/effect-execution.mjs.
 */
export function buildTerrainEffectPatch(step, lightKey = 'terrain-edit') {
  const patch = {};
  const stats = {};
  for (const [source, target] of Object.entries(STAT_KEYS)) {
    const value = authored(step?.[source]);
    if (value === undefined) continue;
    stats[target] = value === STAT_DEFAULTS[target] ? null : value;
  }
  if (Object.keys(stats).length) patch.stats = stats;

  const hazardType = typeof step?.effect === 'string' ? step.effect.trim() : '';
  if (hazardType) {
    const effect = sanitizeTileEffect({
      type: hazardType,
      value: Math.max(0, authored(step.variable) ?? 0),
      stn: Math.max(0, authored(step.stn) ?? 0),
      canKillPlayer: step.canKillPlayer === true
    });
    patch.hazard = { tileEffects: tileEffectIsActive(effect) ? [effect] : null };
  }

  const vfx = typeof step?.vfxEffect === 'string' ? step.vfxEffect.trim() : '';
  if (vfx) {
    const scale = authored(step.vfxScale);
    const opacity = authored(step.vfxOpacity);
    const rotation = authored(step.vfxRotation);
    patch.vfx = {
      effect: vfx,
      effectScale: scale !== undefined && scale > 0 && scale !== 1 ? scale : null,
      effectOpacity: opacity !== undefined && opacity >= 0 && opacity !== 1 ? opacity : null,
      effectRotation: rotation ? rotation : null,
      effectMirrorX: step.vfxMirrorX === true ? true : null,
      effectMirrorY: step.vfxMirrorY === true ? true : null,
      effectSpanW: null,
      effectSpanH: null
    };
  }

  const dim = Math.max(0, authored(step?.lightDim) ?? 0);
  const bright = Math.max(0, authored(step?.lightBright) ?? 0);
  if (dim > 0 || bright > 0) {
    patch.light = {
      lightKey,
      light: {
        dim,
        bright,
        walls: step.lightWalls !== false,
        color: typeof step.lightColor === 'string' && step.lightColor ? step.lightColor : '#ffffff',
        alpha: authored(step.lightAlpha) ?? 0.5,
        animType: typeof step.lightAnimType === 'string' ? step.lightAnimType : '',
        animSpeed: authored(step.lightAnimSpeed) ?? 5,
        animIntensity: authored(step.lightAnimIntensity) ?? 5,
        vision: step.lightVision !== false,
        coloration: authored(step.lightColoration) ?? 1,
        luminosity: authored(step.lightLuminosity) ?? 0.5,
        attenuation: authored(step.lightAttenuation) ?? 0.5,
        saturation: authored(step.lightSaturation) ?? 0,
        contrast: authored(step.lightContrast) ?? 0,
        shadows: authored(step.lightShadows) ?? 0
      }
    };
  }
  return patch;
}

/** Report whether an authored terrain step has any mechanical or visual field to apply. */
export function terrainEffectPatchIsEmpty(patch) {
  return !patch?.stats && !patch?.hazard && !patch?.vfx && !patch?.light;
}

/* -------------------------------------------- */
/*  Pure edit planning                          */
/* -------------------------------------------- */

/**
 * Plan the Scene cells and timed-edit records a terrainEdit step replaces, from detached data, for the step's writer
 * in foundry/adapters/document-writes/effect-execution.mjs.
 */
export function planTerrainEffectEdit({
  grid = {}, records = {}, cells = [], patch, overwrite = false, duration = 0,
  replacePrevious = false, casterUuid = '', itemUuid = '', castId, ticksOn = 'Enemy', inCombat = false
}) {
  const nextGrid = structuredClone(grid);
  const nextRecords = structuredClone(records);
  const touched = new Set();
  if (replacePrevious && casterUuid && itemUuid) {
    for (const [key, record] of Object.entries(nextRecords)) {
      if (record?.casterUuid !== casterUuid || record?.itemUuid !== itemUuid || record.castId === castId
        || isPendingRespawn(record)) continue;
      const current = nextGrid[key] ?? null;
      if (record.clearBehavior === 'clearRespawn' && inCombat) {
        setCell(nextGrid, key, revertCell(current, null));
        nextRecords[key] = pendingRespawn(record);
      } else {
        setCell(nextGrid, key, revertCell(current, record.clearBehavior === 'clear' ? null : record.original));
        delete nextRecords[key];
      }
      touched.add(key);
    }
  }

  let applied = 0;
  for (const key of [...new Set(cells.map(String))]) {
    const previousRecord = nextRecords[key];
    if (previousRecord?.castId === castId) continue;
    let base = nextGrid[key] ?? null;
    if (overwriteBehavior(base) === 'forbid') continue;
    let reverted = false;
    if (previousRecord) {
      base = revertCell(base, previousRecord.original ?? null);
      delete nextRecords[key];
      reverted = true;
    }
    const behavior = overwriteBehavior(base);
    if (behavior === 'forbid') continue;
    const cellPatch = patch.light
      ? { ...patch, light: { ...patch.light, lightKey: `${castId}:${key}` } }
      : patch;
    const result = applyPatch(base, cellPatch, overwrite);
    if (!result.changed && !reverted) continue;
    setCell(nextGrid, key, result.entry);
    if (result.changed) {
      const record = {
        original: base ? structuredClone(base) : null,
        casterUuid: casterUuid || null,
        itemUuid: itemUuid || null,
        castId,
        remaining: duration > 0 ? Math.floor(duration) : null,
        ticksOn: duration > 0 || behavior === 'clearRespawn' ? ticksOn : null
      };
      if (behavior === 'clear') record.clearBehavior = 'clear';
      else if (behavior === 'clearRespawn') {
        record.clearBehavior = 'clearRespawn';
        record.respawnRounds = Math.max(1, Math.floor(Number(base?.respawnRounds)) || 1);
      }
      nextRecords[key] = record;
    }
    touched.add(key);
    applied += 1;
  }

  return {
    applied,
    cells: [...touched].map(key => ({
      key,
      entry: nextGrid[key] ? structuredClone(nextGrid[key]) : null,
      record: nextRecords[key] ? structuredClone(nextRecords[key]) : null
    }))
  };
}

/* -------------------------------------------- */
/*  Standing consequences                       */
/* -------------------------------------------- */
const PHYSICAL_TYPES = Object.freeze(['slashing', 'piercing', 'crushing', 'missile', 'none', '']);
const MAGICAL_TYPES = Object.freeze(['fire', 'ice', 'lightning', 'wind', 'arcane', 'decay', 'shadow', 'holy']);

/**
 * Scan the hazards under a unit's footprint, for the phase-participant projection in
 * foundry/adapters/projections/encounters.mjs and projectTerrainHazardAt in projections/board.mjs. Each damage type
 * and each kind of healing takes its highest value across the tiles, not the sum. Tiles the unit is exempt from are
 * skipped. When two tiles tie for a damage type, either one's lethal flag counts.
 * @param {object} grid Persisted terrain grid.
 * @param {Array<[number, number]>} cells Footprint cells as column and row pairs.
 * @param {object|null} profile Normalized exception profile for the unit standing there.
 * @returns {{damage: ReadonlyArray<{type: string, value: number, canKillPlayer: boolean}>, healHp: number,
 *   healStance: number}|null}
 */
export function scanTerrainImpacts(grid, cells, profile) {
  const damage = new Map();
  let healHp = 0;
  let healStance = 0;
  for (const [x, y] of cells ?? []) {
    const entry = terrainCellAt(grid, x, y);
    if (!entry || cellExemptions(entry.exceptions, profile).effect) continue;
    for (const effect of tileEffectsOf(entry)) {
      if (effect.type === 'healing') {
        healHp = Math.max(healHp, effect.value);
        healStance = Math.max(healStance, effect.stn ?? 0);
      } else if (effect.value > 0) {
        const held = damage.get(effect.type);
        const canKillPlayer = effect.canKillPlayer === true;
        if (!held || effect.value > held.value) damage.set(effect.type, { value: effect.value, canKillPlayer });
        else if (effect.value === held.value && canKillPlayer) held.canKillPlayer = true;
      }
    }
  }
  if (damage.size === 0 && healHp <= 0 && healStance <= 0) return null;
  return Object.freeze({
    damage: Object.freeze([...damage].map(([type, held]) => Object.freeze({ type, ...held }))),
    healHp,
    healStance
  });
}

/**
 * Apply defenses to scanTerrainImpacts output before engine health settlement.
 * Defense and Resistance reduce only damage types the unit is protected against.
 * @param {object|null} scan Result of `scanTerrainImpacts`.
 * @param {object} defenses Detached `protections`, `defense` and `resistance` facts for the unit.
 * @returns {{heal: {hp: number, stance: number}|null, damage: Array<{type: string, amount: number}>}}
 */
export function resolveTerrainImpacts(scan, defenses = {}) {
  const protections = new Set((defenses.protections ?? []).map(String));
  const applied = [];
  for (const effect of scan?.damage ?? []) {
    const amount = mitigateTerrainDamage(effect, protections, defenses);
    if (amount > 0) {
      applied.push({ type: effect.type, amount, canKillPlayer: effect.canKillPlayer === true });
    }
  }
  const healHp = Math.max(0, Number(scan?.healHp) || 0);
  const healStance = Math.max(0, Number(scan?.healStance) || 0);
  return {
    heal: healHp > 0 || healStance > 0 ? { hp: healHp, stance: healStance } : null,
    damage: applied
  };
}

/**
 * Cap terrain damage before engine health settlement, in application order. Player HP is protected only from
 * non-lethal entries, and the damage resolver handles lethal overkill. Zero-damage entries are left out.
 * @param {ReadonlyArray<{type: string, amount: number, canKillPlayer?: boolean}>} damage Resolved hazard damage.
 * @param {{hp?: number, actorType?: string}} [standing] The unit's health as the damage begins, and its faction role.
 * @returns {Array<{type: string, amount: number, canKillPlayer: boolean}>}
 */
export function capTerrainDamage(damage, { hp = 0, actorType = '' } = {}) {
  let remaining = Math.max(0, Number(hp) || 0);
  const capped = [];
  for (const entry of damage) {
    const canKillPlayer = entry.canKillPlayer;
    const floor = hpFloor(actorType, canKillPlayer);
    const resolved = entry.amount;
    const amount = floor > 0 ? Math.min(resolved, Math.max(0, remaining - floor)) : resolved;
    if (amount <= 0) continue;
    remaining = Math.max(0, remaining - amount);
    capped.push({ type: String(entry.type ?? ''), amount, canKillPlayer });
  }
  return capped;
}

function mitigateTerrainDamage(effect, protections, defenses) {
  let amount = Number(effect?.value) || 0;
  const type = String(effect?.type ?? '');
  if (protections.has(type)) {
    if (PHYSICAL_TYPES.includes(type)) amount -= Number(defenses.defense) || 0;
    else if (MAGICAL_TYPES.includes(type)) amount -= Number(defenses.resistance) || 0;
  }
  return Math.max(0, Math.round(amount));
}

/* -------------------------------------------- */
/*  Spawn eligibility                           */
/* -------------------------------------------- */

/**
 * The phase a spawned unit arrives in, for engine/terrain/effects.mjs. Neutrals arrive in the Enemy phase.
 * @param {string} actorType Faction of the unit being spawned.
 * @returns {string}
 */
export function spawnPhaseFor(actorType) {
  return ENCOUNTER_PHASE_FACTIONS[ENCOUNTER_PHASES.PLAYER].includes(String(actorType))
    ? ENCOUNTER_PHASES.PLAYER
    : ENCOUNTER_PHASES.ENEMY;
}

/**
 * Select terrain spawns for engine phase opening in stable cell-key order: each square whose round window is open
 * and whose last arrival is off cooldown.
 * @param {object} grid Persisted terrain grid.
 * @param {number} round Current round.
 * @param {object} state Per-square arrival records.
 * @returns {Array<{spawn: object, x: number, y: number, stateKey: string}>}
 */
export function collectDueTerrainSpawns(grid, round, state = {}) {
  const due = [];
  for (const [key, entry] of Object.entries(grid ?? {})) {
    const spawns = Array.isArray(entry?.spawns) ? entry.spawns : [];
    if (!spawns.length) continue;
    const { x, y } = parseSpawnKey(key);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    spawns.forEach((spawn, index) => {
      if (!spawn?.uuid) return;
      const stateKey = key + '#' + index;
      if (!isSpawnRoundInWindow(spawn, round)) return;
      if (!isSpawnOffCooldown(state?.[stateKey], round, spawn.cooldown)) return;
      due.push({ spawn: { ...spawn }, x, y, stateKey });
    });
  }
  return due.sort((first, second) => first.stateKey.localeCompare(second.stateKey));
}

function parseSpawnKey(key) {
  const text = String(key);
  const dash = text.indexOf('-');
  return { y: Number(text.slice(0, dash)), x: Number(text.slice(dash + 1)) };
}

/** Whether a spawn's round window is open. Zero leaves that end unbounded. */
function isSpawnRoundInWindow(spawn, round) {
  const start = Number(spawn?.startRound) || 0;
  const end = Number(spawn?.endRound) || 0;
  if (start > 0 && round < start) return false;
  return !(end > 0 && round > end);
}

/** Whether a spawn square is ready to fire again. A square that never fired is always ready. */
function isSpawnOffCooldown(entry, round, cooldown) {
  const lastRound = spawnArrivalRound(entry);
  if (!Number.isFinite(lastRound)) return true;
  return (round - lastRound) > (Number(cooldown) || 0);
}

/** The round a square's last arrival recorded. A square with no completed arrival has none. */
function spawnArrivalRound(entry) {
  if (entry?.stage !== TERRAIN_SPAWN_STAGES.COMPLETED) return Number.NaN;
  return Number(entry.round);
}

/* -------------------------------------------- */
/*  Spawn arrival records                       */
/* -------------------------------------------- */

/**
 * Build the record `TerrainPhaseService` writes through `recordSpawnState` once a square's arrival completed. It
 * puts the square on cooldown, which `spawnArrivalRound` reads on later phases.
 * @param {number} round Round the arrival happened in.
 * @returns {{stage: string, round: number}}
 */
export function projectSpawnRecord(round) {
  return Object.freeze({ stage: TERRAIN_SPAWN_STAGES.COMPLETED, round: Number(round) || 0 });
}

/* -------------------------------------------- */
/*  Timed edit expiry                           */
/* -------------------------------------------- */

/**
 * Plan timed terrain expiry for engine phase changes and encounter end.
 * Phase sweeps decrement matching records. Encounter end expires all records without scheduling respawn.
 * Each cell either restores its original value, clears or clears and schedules respawn.
 * @param {object} grid Persisted terrain grid.
 * @param {object} records Persisted terrain edit journals.
 * @param {object} options `decrement` and the `closingPhase` a record must tick on.
 * @returns {{cells: Array<object>, counters: Array<object>}}
 */
export function planTerrainEditSweep(grid, records, { decrement = true, closingPhase = null } = {}) {
  const cells = [];
  const counters = [];
  for (const [key, record] of Object.entries(records ?? {})) {
    const pending = isPendingRespawn(record);
    const timed = record?.remaining !== null && record?.remaining !== undefined;
    if (!pending && !timed) continue;
    if (decrement && (record.ticksOn ?? 'Enemy') !== closingPhase) continue;
    const current = grid?.[key] ?? null;
    if (pending) {
      const left = decrement ? Number(record.respawnRemaining) - 1 : 0;
      if (left > 0) counters.push({ key, field: 'respawnRemaining', value: left });
      else cells.push(expiredCell(key, current, record.original ?? null));
      continue;
    }
    const left = decrement ? Number(record.remaining) - 1 : 0;
    if (left > 0) {
      counters.push({ key, field: 'remaining', value: left });
    } else if (record.clearBehavior === 'clear') {
      cells.push(expiredCell(key, current, null));
    } else if (record.clearBehavior === 'clearRespawn' && decrement) {
      cells.push({ key, entry: revertCell(current, null), record: pendingRespawn(record) });
    } else {
      cells.push(expiredCell(key, current, record.original ?? null));
    }
  }
  return { cells, counters };
}

/**
 * Name the terrain squares and counters one sweep will rewrite, so `TerrainPhaseService.projectTimedExpiry` can
 * tell the phase change which Scene flag entries to capture before its first write.
 * @param {object} plan The sweep {@link planTerrainEditSweep} produced.
 * @returns {Readonly<{counters: ReadonlyArray<object>, cells: ReadonlyArray<object>}>} Square keys alone.
 */
export function projectTerrainSweepTargets(plan = {}) {
  return Object.freeze({
    counters: Object.freeze((plan.counters ?? []).map(entry =>
      Object.freeze({ key: String(entry.key), field: String(entry.field) }))),
    cells: Object.freeze((plan.cells ?? []).map(entry => Object.freeze({ key: String(entry.key) })))
  });
}

function expiredCell(key, current, original) {
  return { key, entry: revertCell(current, original), record: null };
}

function applyPatch(existing, patch, overwrite) {
  const entry = existing ? structuredClone(existing) : {};
  let changed = false;
  for (const [field, value] of Object.entries(patch.stats ?? {})) {
    if (!overwrite && entry[field] !== undefined) continue;
    changed = assign(entry, { [field]: value }) || changed;
  }
  for (const group of ['hazard', 'vfx', 'light']) {
    if (!patch[group] || (!overwrite && GROUP_PRESENT[group](entry))) continue;
    changed = assign(entry, patch[group]) || changed;
  }
  return { entry: Object.keys(entry).length ? entry : null, changed };
}

function assign(entry, fields) {
  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      if (entry[key] !== undefined) { delete entry[key]; changed = true; }
    } else if (JSON.stringify(entry[key]) !== JSON.stringify(value)) {
      entry[key] = typeof value === 'object' ? structuredClone(value) : value;
      changed = true;
    }
  }
  return changed;
}

function revertCell(current, original) {
  const result = original ? structuredClone(original) : {};
  delete result.zoneId;
  delete result.elevation;
  if (current?.zoneId) result.zoneId = current.zoneId;
  if (current?.elevation !== undefined) result.elevation = current.elevation;
  return Object.keys(result).length ? result : null;
}

function setCell(grid, key, value) {
  if (value) grid[key] = value;
  else delete grid[key];
}

function overwriteBehavior(entry) {
  return OVERWRITE_BEHAVIORS.has(entry?.overwriteBehavior) ? entry.overwriteBehavior : '';
}

function pendingRespawn(record) {
  return {
    original: record?.original ? structuredClone(record.original) : null,
    casterUuid: record?.casterUuid ?? null,
    itemUuid: record?.itemUuid ?? null,
    castId: record?.castId ?? null,
    respawnRemaining: Math.max(1, Math.floor(Number(record?.respawnRounds)) || 1),
    ticksOn: record?.ticksOn ?? 'Enemy'
  };
}

function isPendingRespawn(record) {
  return record?.respawnRemaining !== null && record?.respawnRemaining !== undefined;
}
