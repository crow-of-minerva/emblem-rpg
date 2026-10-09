/** @layer api */
import { SETTLE_BARRIER_TIMING } from '../contracts/domains/combat.mjs';

/* -------------------------------------------- */
/*  Measurement API                             */
/* -------------------------------------------- */

/**
 * The read-only map questions Enemy AI and other planning modules ask through api/facade.mjs: encounter state,
 * matchups, sight, flanking, passing through units, terrain, auras and factions. A Scene read uses the Scene it's
 * given, or the one this client is viewing. Nothing here writes documents. All reads are synchronous except
 * board.awaitSettled, and a read for a missing unit or Scene returns null. The returned records are described in
 * api/types.mjs.
 * @param {object} [ports] The read functions and services init/system.mjs passes in.
 * @returns {Readonly<object>} The `encounters`, `combat`, `movement`, `terrain`, `board` and `factions`
 *   namespaces.
 */
export function createMeasurementApi({ encounters, combat, movement, terrain, board, factions } = {}) {
  return Object.freeze({
    encounters: encounterMeasurement(encounters),
    combat: combatMeasurement(combat),
    movement: movementMeasurement(movement),
    terrain: terrainMeasurement(terrain),
    board: boardMeasurement(board),
    factions: factionMeasurement(factions)
  });
}

/* -------------------------------------------- */
/*  Encounter reads                             */
/* -------------------------------------------- */

function encounterMeasurement(ports) {
  return Object.freeze({
    /**
     * A Scene's phase, round and encounter flags.
     * @param {string} [sceneUuid] The Scene to read, or the one this client is viewing.
     * @returns {import('./types.mjs').EncounterState|null} Null when the Scene can't be found.
     */
    getState: (sceneUuid = '') => ports.getState(String(sceneUuid ?? '')),
    /**
     * Every token on a Scene, with its stats, statuses and turn state.
     * @param {string} [sceneUuid] The Scene to read, or the one this client is viewing.
     * @returns {import('./types.mjs').UnitBoard|null} Null when the Scene can't be found.
     */
    getBoard: (sceneUuid = '') => ports.getBoard(String(sceneUuid ?? ''))
  });
}

/* -------------------------------------------- */
/*  Combat reads                                */
/* -------------------------------------------- */

function combatMeasurement(ports) {
  return Object.freeze({
    /**
     * The forecast of one exchange from a square the attacker is considering. Nothing is written.
     * @param {object} intent The attacker, defender, weapon, distance and square (see matchupIntent below).
     * @returns {import('./types.mjs').Matchup|null} Null when either token or the weapon can't be found.
     */
    measure: intent => ports.measure(matchupIntent(intent)),
    canEngage: intent => ports.canEngage({
      ...moverIntent(intent),
      range: {
        minRange: Math.max(0, Math.floor(Number(intent?.range?.minRange) || 0)),
        maxRange: Math.max(0, Math.floor(Number(intent?.range?.maxRange) || 0))
      },
      losRule: String(intent?.losRule ?? 'normal')
    }),
    sightBlocked: intent => ports.sightBlocked({
      ...moverIntent(intent),
      losRule: String(intent?.losRule ?? 'normal')
    }),
    flanking: intent => ports.flanking(moverIntent(intent)),
    /**
     * Everything a unit carries, with each item's range, uses and whether it can be used now.
     * @param {string} tokenUuid The unit's token.
     * @returns {import('./types.mjs').Loadout|null} Null when the token can't be found.
     */
    loadout: tokenUuid => ports.loadout(String(tokenUuid ?? '')),
    /**
     * Whether a unit can use one of its items, on a target when one is given.
     * @param {{tokenUuid: string, itemId: string, targetTokenUuid?: string|null}} intent The unit, item and target.
     * @returns {import('./types.mjs').ItemUsability|null} Null when the token or the item can't be found.
     */
    canUse: intent => ports.canUse({
      tokenUuid: String(intent?.tokenUuid ?? ''),
      itemId: String(intent?.itemId ?? ''),
      targetTokenUuid: intent?.targetTokenUuid ? String(intent.targetTokenUuid) : null
    }),
    airborneBeyondMelee: facts => ports.airborneBeyondMelee(flightReach(facts))
  });
}

/**
 * The facts the melee-against-airborne rule (airborneBeyondMelee in game/targeting/attack-grid.mjs) checks, so a
 * planner asks it the same way the attack grid does: whether the attacker and the target are airborne, whether the
 * target's stance is broken, whether the world uses Classic flyer targeting, and whether the map forbids flight.
 */
function flightReach(facts) {
  return {
    sourceAirborne: facts?.sourceAirborne === true,
    targetAirborne: facts?.targetAirborne === true,
    targetStanceBroken: facts?.targetStanceBroken === true,
    classicFlyers: facts?.classicFlyers === true,
    flightForbidden: facts?.flightForbidden === true
  };
}

/**
 * Build the combat forecast request. Omit defenderWeaponId to use the defender's equipped weapon. A planner that
 * has already read the standing square's ground may pass it back as `terrainModifiers`, `auraFields` or both.
 * `hypotheticalGround` in `projections/attack-targeting.mjs` reads whichever one is missing.
 */
function matchupIntent(intent) {
  const named = intent?.defenderWeaponId !== undefined;
  const terrainModifiers = groundRecord(intent?.terrainModifiers);
  const auraFields = groundRecord(intent?.auraFields);
  return {
    attackerTokenUuid: String(intent?.attackerTokenUuid ?? ''),
    defenderTokenUuid: String(intent?.defenderTokenUuid ?? ''),
    weaponId: String(intent?.weaponId ?? ''),
    distance: Math.max(0, Math.floor(Number(intent?.distance) || 0)),
    damageType: intent?.damageType ? String(intent.damageType) : null,
    standing: square(intent?.standing),
    attackerFlanked: intent?.attackerFlanked === true,
    targetFlanked: intent?.targetFlanked === true,
    ...(terrainModifiers ? { terrainModifiers } : {}),
    ...(auraFields ? { auraFields } : {}),
    ...(named ? { defenderWeaponId: String(intent.defenderWeaponId ?? '') } : {})
  };
}

/**
 * A caller's ground record as finite numbers by key, or null when none was supplied. An empty record means no
 * bonuses at that square, and the ground isn't read again.
 */
function groundRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .map(([key, amount]) => [String(key), Number(amount)])
    .filter(([, amount]) => Number.isFinite(amount))));
}

function moverIntent(intent) {
  return {
    tokenUuid: String(intent?.tokenUuid ?? ''),
    standing: square(intent?.standing),
    targetTokenUuid: String(intent?.targetTokenUuid ?? '')
  };
}

/* -------------------------------------------- */
/*  Movement reads                              */
/* -------------------------------------------- */

function movementMeasurement(ports) {
  return Object.freeze({
    /**
     * Whether the first token's unit may move through the second one's squares, and whether those squares are taken
     * so it can't stop there, by the rule the system's own pathfinding uses.
     * @param {{tokenUuid: string, otherTokenUuid: string}} intent The moving token and the token in its way.
     * @returns {import('./types.mjs').PairOccupancy|null} Null when either token is missing.
     */
    canPass: intent => ports.canPass(String(intent?.tokenUuid ?? ''), String(intent?.otherTokenUuid ?? ''))
  });
}

/* -------------------------------------------- */
/*  Terrain reads                               */
/* -------------------------------------------- */

function terrainMeasurement(ports) {
  const at = intent => ({
    tokenUuid: String(intent?.tokenUuid ?? ''),
    standing: square(intent?.standing)
  });
  return Object.freeze({
    /**
     * The whole map's terrain: Defend squares, teleports, heights and the map's size.
     * @param {string} [sceneUuid] The Scene to read, or the one this client is viewing.
     * @returns {import('./types.mjs').TerrainBoard|null} Null when the Scene can't be found.
     */
    getBoard: (sceneUuid = '') => ports.getBoard(String(sceneUuid ?? '')),
    modifiersAt: intent => ports.modifiersAt(at(intent)),
    hazardAt: intent => ports.hazardAt(at(intent)),
    elevationAt: intent => ports.elevationAt({
      sceneUuid: String(intent?.sceneUuid ?? ''),
      standing: square(intent?.standing),
      width: Math.max(1, Math.floor(Number(intent?.width) || 1)),
      height: Math.max(1, Math.floor(Number(intent?.height) || 1))
    }),
    auraFieldsAt: intent => ports.auraFieldsAt(at(intent)),
    auraFieldsAtMany: intent => ports.auraFieldsAtMany({
      tokenUuid: String(intent?.tokenUuid ?? ''),
      standings: (Array.isArray(intent?.standings) ? intent.standings : []).map(square).filter(Boolean)
    })
  });
}

/* -------------------------------------------- */
/*  Waiting for the map to go quiet             */
/* -------------------------------------------- */

function boardMeasurement(ports) {
  return Object.freeze({
    awaitSettled: (options = {}) => ports.awaitSettled({
      stableMs: milliseconds(options?.stableMs, SETTLE_BARRIER_TIMING.stableMs),
      timeoutMs: milliseconds(options?.timeoutMs, SETTLE_BARRIER_TIMING.timeoutMs),
      pollMs: milliseconds(options?.pollMs, SETTLE_BARRIER_TIMING.pollMs),
      abort: typeof options?.abort === 'function' ? options.abort : null,
      label: String(options?.label ?? '')
    })
  });
}

/* -------------------------------------------- */
/*  Faction rules                               */
/* -------------------------------------------- */

function factionMeasurement(ports) {
  return Object.freeze({
    hostile: (a, b) => ports.hostile(String(a ?? ''), String(b ?? '')),
    friendly: (a, b) => ports.friendly(String(a ?? ''), String(b ?? ''))
  });
}

/* -------------------------------------------- */
/*  Intent helpers                              */
/* -------------------------------------------- */

/** Normalize a grid cell for measurement reads. Null means the unit's current cell. */
function square(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!value || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Object.freeze({ x: Math.floor(x), y: Math.floor(y) });
}

function milliseconds(value, fallback) {
  const span = Number(value);
  return Number.isFinite(span) && span >= 0 ? span : fallback;
}
