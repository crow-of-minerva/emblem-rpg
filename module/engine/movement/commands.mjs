/** @layer engine/movement */
import { COMMAND_IDS, INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { KARMA_LEDGER_RESOURCE_KEY } from '../../contracts/domains/combat.mjs';
import { EVENT_IDS } from '../../contracts/events.mjs';
import {
  planCrossingAttempt,
  planFlightAuthoring,
  planFlightToggle,
  planFreeTakeOff,
  planMovementSettlement,
  planPermissionEnforcement
} from '../../game/movement/input-policy.mjs';
import {
  buildMovementGraph,
  crossingCandidates,
  landingBlocked,
  movementPathIsTraversable,
  movementStranded,
  resolveForcedStep,
  resolveMovementDestination,
  standsOverObstacle
} from '../../game/movement/pathfinding.mjs';
import { endUnitTurn, restoreRestingStance } from '../combat/encounters/commands.mjs';
import {
  crossingFallDamage,
  resolveCrossingCheck,
  resolveTeleportCost,
  resolveTeleportLanding,
  teleportPadAt
} from '../../game/terrain/rules.mjs';
import { CombatPersistenceError } from '../recovery/errors.mjs';
import {
  CROSSING_ATTEMPT_TIMING,
  FORCED_STEP_OUTCOMES,
  TELEPORT_SETTLEMENT_OUTCOMES
} from '../../contracts/domains/terrain.mjs';
import {
  DIAGNOSTIC_SEVERITIES, DIAGNOSTIC_SOURCES, diagnosticData, recordDiagnostic, requirePorts
} from '../../contracts/protocol.mjs';
import { DAMAGE_POLICIES } from '../../contracts/domains/damage.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { holdsResources } from '../dispatcher.mjs';
import { accept, refuse, RESULT_CODES } from '../../contracts/results.mjs';

/* -------------------------------------------- */
/*  Movement commands                           */
/* -------------------------------------------- */
/** What a driven route asks for once it arrives: keep planning, stand where it landed, or end the turn. */
const DRIVE_SETTLEMENTS = Object.freeze({ PLAN: 'plan', STAND: 'stand', END_TURN: 'end-turn' });

/**
 * The movement command definitions init/system.mjs registers with CommandDispatcher: movement plans, driven
 * routes, flight, teleports and terrain crossings, plus the internal forced crossing and permission sweep.
 */
export function createMovementCommandContribution({
  movements, events, authority, objects, inventory, diagnostics, checks, checkPresentation, skills, impacts, audio, wait
}) {
  requirePorts('createMovementCommandContribution', { movements, events, objects, inventory, diagnostics, checks,
    checkPresentation, skills, impacts, audio, wait });
  const services = { events, checks, checkPresentation, skills, impacts, audio, wait, diagnostics };
  const authorize = createCommandAuthorization(authority);
  const token = payload => payload.tokenUuid;
  const definition = (id, authorizeSlot, handler, sharedKeys = []) => ({
    id,
    authorize: authorizeSlot,
    handler,
    concurrencyKeys: async context => [
      ...await movements.resourceKeys(String(context.payload?.tokenUuid ?? '')), ...sharedKeys
    ]
  });
  return [
    definition(COMMAND_IDS.MOVEMENT.BEGIN, authorize.tokenController(token),
      context => beginMovement(context, movements)),
    definition(COMMAND_IDS.MOVEMENT.COMMIT, authorize.tokenController(token, { requirePlan: true }),
      context => commitMovement(context, movements, events, objects, services)),
    definition(COMMAND_IDS.MOVEMENT.CANCEL, authorize.tokenControllerOrAbsent(token),
      context => cancelMovement(context, movements, false, events, objects)),
    definition(COMMAND_IDS.MOVEMENT.ROLLBACK, authorize.tokenControllerOrAbsent(token),
      context => cancelMovement(context, movements, true, events, objects)),
    definition(COMMAND_IDS.MOVEMENT.DRIVE, authorize.activeGm(),
      context => driveMovement(context, movements, events, objects, services)),
    definition(COMMAND_IDS.MOVEMENT.TOGGLE_FLIGHT, authorize.tokenController(token, { requirePlan: true }),
      context => toggleFlight(context, movements, events, services)),
    definition(COMMAND_IDS.MOVEMENT.TAKE_OFF, authorize.tokenController(token),
      context => takeOff(context, movements, events, authority)),
    definition(COMMAND_IDS.MOVEMENT.SET_FLIGHT, authorize.tokenAuthor(token),
      context => setFlight(context, movements, events)),
    definition(COMMAND_IDS.MOVEMENT.TELEPORT, authorize.tokenController(token, { requirePlan: true }),
      context => useTeleport(context, movements, events, objects, services)),
    definition(COMMAND_IDS.MOVEMENT.CROSS, authorize.tokenController(token, { requirePlan: true }),
      context => crossTerrain(context, movements, services), [KARMA_LEDGER_RESOURCE_KEY]),
    {
      id: INTERNAL_COMMAND_IDS.MOVEMENT.FORCE_CROSSING,
      authorize: authorize.activeGm(),
      concurrencyKeys: context => movements.resourceKeys(String(context.payload?.tokenUuid ?? '')),
      handler: context => forceCrossing(context, movements, services)
    },
    {
      id: INTERNAL_COMMAND_IDS.MOVEMENT.ENFORCE_PERMISSIONS,
      authorize: authorize.activeGm(),
      concurrencyKeys: context => permissionSweepKeys(context, movements),
      handler: context => enforcePermissions(context, movements, inventory)
    }
  ];
}

/* -------------------------------------------- */
/*  Flight                                      */
/* -------------------------------------------- */

/**
 * The flight action: take off or land where the unit stands. The grounded flag is written first, then the plan
 * closes and ends the turn. The resting Stn (restoreRestingStance) comes back only once that close is written.
 */
async function toggleFlight(context, movements, events, services) {
  const checked = await ownedMovementSnapshot(context, movements, { requirePlan: true });
  if (!checked.ok) return checked.result;
  const snapshot = checked.snapshot;
  const plan = planFlightToggle({
    flying: snapshot.flying,
    levitating: snapshot.levitating,
    grounded: snapshot.grounded,
    permission: snapshot.permission,
    stanceBroken: snapshot.stanceBroken,
    actionAvailable: snapshot.standardAvailable,
    landingBlocked: landingBlocked(snapshot.current, snapshot.footprint, snapshot.terrainOcclusionCells)
  });
  if (!plan.ok) return refuse(plan.code);
  const graph = buildMovementGraph(snapshot);
  const resolution = resolveMovementDestination(graph, snapshot.current);
  if (!resolution) return refuse(RESULT_CODES.MOVEMENT_DESTINATION_INVALID);
  if (!await movements.setGrounded(snapshot, plan.grounded, context.operation)) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  if (!await movements.commit(snapshot, resolution,
    { resume: false, endTurn: true, operation: context.operation })) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  const stanceRestored = await restoreRestingStance(snapshot, true, services.impacts);
  const outcome = {
    tokenUuid: snapshot.tokenUuid,
    tokenName: snapshot.tokenName,
    actorUuid: snapshot.actorUuid,
    actorName: snapshot.actorName,
    sceneUuid: snapshot.sceneUuid,
    landing: plan.landing,
    grounded: plan.grounded,
    stanceRestored,
    requestId: context.requestId,
    userId: context.userId
  };
  events.publish(EVENT_IDS.FLIGHT_TOGGLED, outcome);
  return accept(RESULT_CODES.FLIGHT_TOGGLED, outcome);
}

/**
 * Lift a grounded flier off where it stands, which costs nothing and ends nothing.
 *
 * It refuses in different cases from the flight action, so it is a separate command. It backs the control on the
 * Grounded marker, and in combat only the GM may use it.
 */
async function takeOff(context, movements, events, authority) {
  const checked = await ownedMovementSnapshot(context, movements, { requirePlan: false });
  if (!checked.ok) return checked.result;
  const snapshot = checked.snapshot;
  const plan = planFreeTakeOff({
    flying: snapshot.flying,
    levitating: snapshot.levitating,
    grounded: snapshot.grounded,
    permission: snapshot.permission,
    stanceBroken: snapshot.stanceBroken,
    encounterActive: snapshot.encounterActive,
    userIsGm: authority.isGm(context.userId) === true
  });
  if (!plan.ok) return refuse(plan.code);
  if (!await movements.setActorGrounded(snapshot.actorUuid, plan.grounded, context.operation)) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  const outcome = {
    tokenUuid: snapshot.tokenUuid,
    tokenName: snapshot.tokenName,
    actorUuid: snapshot.actorUuid,
    actorName: snapshot.actorName,
    sceneUuid: snapshot.sceneUuid,
    landing: false,
    grounded: plan.grounded,
    requestId: context.requestId,
    userId: context.userId
  };
  events.publish(EVENT_IDS.FLIGHT_TOGGLED, outcome);
  return accept(RESULT_CODES.FLIGHT_TAKEN_OFF, outcome);
}

/**
 * Set a unit's flight state from the staff Token HUD control in ui/apps/foundry/token-hud.mjs. It costs no
 * action, ends no turn and needs no movement plan, so it takes the authoring authority rather than the
 * controller authority the flight action and the free take-off take.
 */
async function setFlight(context, movements, events) {
  const checked = await ownedMovementSnapshot(context, movements, { requirePlan: false });
  if (!checked.ok) return checked.result;
  const snapshot = checked.snapshot;
  const plan = planFlightAuthoring({
    flying: snapshot.flying,
    levitating: snapshot.levitating,
    grounded: snapshot.grounded,
    permission: snapshot.permission,
    landingBlocked: standsOverObstacle(snapshot),
    requested: context.payload?.grounded === true
  });
  if (!plan.ok) return refuse(plan.code);
  const changed = plan.grounded !== (snapshot.grounded === true);
  if (changed && !await movements.setActorGrounded(snapshot.actorUuid, plan.grounded, context.operation)) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  const outcome = {
    tokenUuid: snapshot.tokenUuid,
    tokenName: snapshot.tokenName,
    actorUuid: snapshot.actorUuid,
    actorName: snapshot.actorName,
    sceneUuid: snapshot.sceneUuid,
    landing: plan.grounded,
    grounded: plan.grounded,
    changed,
    requestId: context.requestId,
    userId: context.userId
  };
  if (changed) events.publish(EVENT_IDS.FLIGHT_TOGGLED, outcome);
  return accept(RESULT_CODES.FLIGHT_SET, outcome);
}

async function permissionSweepKeys(context, movements) {
  const sceneUuid = String(context.payload?.sceneUuid ?? '');
  const board = sceneUuid ? await movements.getPermissionBoard(sceneUuid) : null;
  return ['movement:board', ...(board?.units ?? []).map(unit => `actor:${unit.actorUuid}`)];
}

/** Ground every flier and dismount every rider a map's permission forbids, whoever placed them. */
async function enforcePermissions(context, movements, inventory) {
  const sceneUuid = String(context.payload?.sceneUuid ?? '');
  const board = sceneUuid ? await movements.getPermissionBoard(sceneUuid) : null;
  if (!board) return refuse(RESULT_CODES.SCENE_NOT_FOUND);
  const plan = planPermissionEnforcement(board.units, board.permission);
  let settled = 0;
  for (const entry of plan) {
    if (entry.ground && await movements.setActorGrounded(entry.actorUuid, true, context.operation)) settled += 1;
    if (entry.dismountItemId) {
      const result = await inventory.toggleEquipment({ actorUuid: entry.actorUuid, itemId: entry.dismountItemId });
      if (result?.ok) settled += 1;
    }
  }
  return accept(RESULT_CODES.MOVEMENT_PERMISSIONS_ENFORCED, { sceneUuid, permission: board.permission, settled });
}

async function beginMovement(context, movements) {
  const drivenHold = movements.getDrivenHold?.() ?? null;
  if (drivenHold) return refuse(RESULT_CODES.MOVEMENT_LOCKED, { holderName: drivenHold.label });
  const recovery = await settleStaleMovement(movements, context);
  if (!recovery.ok) return refuse(RESULT_CODES.MOVEMENT_STATE_STALE, recovery.data);
  const checked = await ownedMovementSnapshot(context, movements, { requirePlan: false });
  if (!checked.ok) return checked.result;
  const snapshot = checked.snapshot;
  if (!snapshot.supportedGrid) return refuse(RESULT_CODES.MOVEMENT_GRID_UNSUPPORTED);
  if (!snapshot.encounterActive && !snapshot.exploring) return refuse(RESULT_CODES.MOVEMENT_OUT_OF_PLAY);
  if (!snapshot.movementAvailable && !snapshot.standardAvailable) return refuse(RESULT_CODES.MOVEMENT_UNAVAILABLE);

  const started = await movements.begin(snapshot, context.userId, context.operation);
  if (!started.ok) {
    if (started.lock) return refuse(RESULT_CODES.MOVEMENT_LOCKED, { holderName: started.lock.holderName });
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  return accept(RESULT_CODES.MOVEMENT_STARTED, {
    tokenUuid: snapshot.tokenUuid,
    actorUuid: snapshot.actorUuid,
    anchor: snapshot.current
  });
}

/**
 * Close a leg of a plan the way planMovementSettlement says.
 *
 * A commit that ends the turn by the unit's own choice is a rest, and the resting Stn comes back only once the
 * close is written, so a refused close grants nothing. A canter's close is not a rest, because the exchange
 * already spent that turn. A stranded unit (movementStranded in game/movement/pathfinding.mjs) may still close
 * its plan where it stands, but never a leg that moved it.
 */
async function commitMovement(context, movements, events, objects, services) {
  const checked = await ownedMovementSnapshot(context, movements, { requirePlan: true });
  if (!checked.ok) return checked.result;
  const snapshot = checked.snapshot;
  const settlement = planMovementSettlement({
    canter: snapshot.canterPathfinding,
    exploring: snapshot.exploring,
    resume: context.payload?.resume !== false
  });
  if (movementStranded(snapshot) && !standsAtAnchor(snapshot)) return refuse(RESULT_CODES.MOVEMENT_STRANDED);
  if (!snapshot.movementAvailable && (settlement.resume || !standsAtAnchor(snapshot))) {
    return refuse(RESULT_CODES.MOVEMENT_UNAVAILABLE);
  }
  const graph = buildMovementGraph(snapshot);
  const resolution = resolveMovementDestination(graph, snapshot.current);
  if (!resolution) return refuse(RESULT_CODES.MOVEMENT_DESTINATION_INVALID);
  if (!await movements.commit(snapshot, resolution, { ...settlement, operation: context.operation })) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  const stanceRestored = settlement.rests === true
    ? await restoreRestingStance(snapshot, true, services.impacts)
    : 0;
  return settledMovement(context, snapshot, resolution, settlement, events, objects, { extra: { stanceRestored } });
}

async function settledMovement(context, snapshot, resolution, settlement, events, objects, {
  code = RESULT_CODES.MOVEMENT_COMMITTED, extra = null
} = {}) {
  const armamentReleased = await objects.releaseArmamentIfLeft(snapshot.tokenUuid) === true;
  const cost = settlement.charges === false ? 0 : resolution.cost;

  const outcome = {
    tokenUuid: snapshot.tokenUuid,
    tokenName: snapshot.tokenName,
    actorUuid: snapshot.actorUuid,
    actorName: snapshot.actorName,
    sceneUuid: snapshot.sceneUuid,
    origin: snapshot.start,
    destination: resolution.destination,
    cost,
    movementSpent: snapshot.movementSpent + cost,
    movementRemaining: Math.max(0, snapshot.allowance - cost),
    resumed: settlement.resume,
    turnEnded: settlement.endTurn,
    armamentReleased,
    ...(extra ?? {}),
    requestId: context.requestId,
    userId: context.userId
  };
  events.publish(EVENT_IDS.MOVEMENT_COMMITTED, outcome);
  return accept(code, outcome);
}

function standsAtAnchor(snapshot) {
  return snapshot.current.x === snapshot.start.x && snapshot.current.y === snapshot.start.y;
}

async function cancelMovement(context, movements, keepPlanning, events, objects) {
  const tokenUuid = String(context.payload?.tokenUuid ?? '');
  if (!tokenUuid) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const snapshot = await movements.getSnapshot(tokenUuid);
  if (!snapshot) {
    const released = await movements.releaseOrphan(tokenUuid, context.userId, context.operation);
    return released
      ? accept(RESULT_CODES.MOVEMENT_CANCELLED, { tokenUuid })
      : refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  }
  const checked = await validateOwnedSnapshot(context, movements, snapshot, { requirePlan: true });
  if (!checked.ok) return checked.result;
  const settlement = planMovementSettlement({ canter: snapshot.canterPathfinding, exploring: snapshot.exploring });
  if (settlement.forfeits) return abandonCanter(context, movements, snapshot, events, objects);
  const restoresAnchor = settlement.restoresAnchor !== false;
  const stillPlanning = keepPlanning && settlement.rollback;
  if (!await movements.cancel(snapshot,
    { keepPlanning: stillPlanning, restoreAnchor: restoresAnchor, operation: context.operation })) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  return accept(
    stillPlanning ? RESULT_CODES.MOVEMENT_ROLLED_BACK : RESULT_CODES.MOVEMENT_CANCELLED,
    { tokenUuid, actorUuid: snapshot.actorUuid, anchor: restoresAnchor ? snapshot.start : snapshot.current }
  );
}

/**
 * Give up a canter, which forfeits its movement and ends the turn where the exchange left the unit.
 *
 * The token returns to the anchor first and the plan is then settled from a fresh projection, so the
 * end-turn commit reads the restored square rather than the abandoned preview. Giving up counts as a cancel, so
 * the close also removes effects authored to end when a move is cancelled.
 */
async function abandonCanter(context, movements, snapshot, events, objects) {
  if (!await movements.cancel(snapshot, { keepPlanning: true, operation: context.operation })) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  const anchored = await movements.getSnapshot(snapshot.tokenUuid);
  if (!anchored) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const resolution = {
    destination: anchored.current,
    cost: 0,
    path: Object.freeze([anchored.current])
  };
  const settlement = { resume: false, endTurn: true, charges: true, cancelled: true };
  if (!await movements.commit(anchored, resolution, { ...settlement, operation: context.operation })) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  return settledMovement(context, anchored, resolution, settlement, events, objects);
}

/* -------------------------------------------- */
/*  Driven movement                             */
/* -------------------------------------------- */

/**
 * The drive command, api.movement.drive, which the Enemy AI uses to move a unit along a route it planned. The
 * route is checked against a fresh movement graph, the movement port walks the token, and the plan then closes as
 * the drive asks: keep planning, stand, or end the turn. Teleports use useTeleport instead. A stranded unit can't
 * walk, but a drive with an empty route still opens a plan, stands or ends the turn.
 */
async function driveMovement(context, movements, events, objects, services) {
  const intent = drivenMovementIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.MOVEMENT_DESTINATION_INVALID);
  const snapshot = await movements.getSnapshot(intent.tokenUuid);
  if (!snapshot) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  if (snapshot.actorType !== 'Character') return refuse(RESULT_CODES.CHARACTER_REQUIRED);
  if (!snapshot.encounterActive && !snapshot.exploring) return refuse(RESULT_CODES.MOVEMENT_OUT_OF_PLAY);
  if (!intent.path.length) return driveWithoutWalking(context, movements, snapshot, intent, events, objects, services);
  if (movementStranded(snapshot)) return refuse(RESULT_CODES.MOVEMENT_STRANDED);
  if (!snapshot.movementAvailable) return refuse(RESULT_CODES.MOVEMENT_UNAVAILABLE);
  if (!drivenRouteIsLegal(snapshot, intent.path)) return refuse(RESULT_CODES.MOVEMENT_DESTINATION_INVALID);
  const opened = await openDrivenPlan(movements, snapshot, context);
  if (opened) return opened;
  await movements.walk(snapshot, intent.path, context.operation);
  return settleDrivenWalk(context, movements, intent, events, objects, services);
}

/** Settle the leg the Token just walked, from a fresh projection of where it actually came to rest. */
async function settleDrivenWalk(context, movements, intent, events, objects, services, { moved = true } = {}) {
  const fresh = await movements.getSnapshot(intent.tokenUuid);
  if (!fresh) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const resolution = resolveMovementDestination(buildMovementGraph(fresh), fresh.current);
  if (!resolution) return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  const settlement = drivenSettlement(intent.then);
  if (!await movements.commit(fresh, resolution, { ...settlement, operation: context.operation })) {
    return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
  }
  const stanceRestored = intent.then === DRIVE_SETTLEMENTS.END_TURN
    ? await restoreRestingStance(fresh, intent.restoreStance, services.impacts)
    : 0;
  return settledMovement(context, fresh, resolution, settlement, events, objects, {
    code: RESULT_CODES.MOVEMENT_DRIVEN,
    extra: { driven: true, moved, stanceRestored }
  });
}

/** A drive that walks nowhere: the planner is opening a plan, standing where it is, or ending the turn. */
async function driveWithoutWalking(context, movements, snapshot, intent, events, objects, services) {
  if (intent.then === DRIVE_SETTLEMENTS.STAND && snapshot.movementPlanning) {
    return settleDrivenWalk(context, movements, intent, events, objects, services, { moved: false });
  }
  let ended = false;
  let stanceRestored = 0;
  if (intent.then === DRIVE_SETTLEMENTS.END_TURN) {
    const closed = await endUnitTurn(
      { tokenUuid: intent.tokenUuid, restoreStance: intent.restoreStance, userId: context.userId },
      { movements, impacts: services.impacts }
    );
    if (closed.ok !== true) return refuse(closed.code, closed.details);
    ended = closed.ended;
    stanceRestored = closed.stanceRestored;
  }
  if (intent.then === DRIVE_SETTLEMENTS.PLAN) {
    const opened = await openDrivenPlan(movements, snapshot, context);
    if (opened) return opened;
  }
  return accept(RESULT_CODES.MOVEMENT_DRIVEN, {
    tokenUuid: snapshot.tokenUuid,
    actorUuid: snapshot.actorUuid,
    driven: true,
    moved: false,
    ended,
    stanceRestored,
    requestId: context.requestId,
    userId: context.userId
  });
}

/** Whether the whole walked route is one legal chain of steps ending on a square the unit may stand on. */
function drivenRouteIsLegal(snapshot, path) {
  const graph = buildMovementGraph(snapshot, { teleports: false });
  if (!movementPathIsTraversable(graph, [snapshot.current, ...path])) return false;
  return resolveMovementDestination(graph, path.at(-1)) !== null;
}

/** Open a plan, taking the movement lock, for a drive that found none. A plan already open is simply continued. */
async function openDrivenPlan(movements, snapshot, context) {
  if (snapshot.movementPlanning) return null;
  const started = await movements.begin(snapshot, context.userId, context.operation);
  if (started.ok) return null;
  if (started.lock) return refuse(RESULT_CODES.MOVEMENT_LOCKED, { holderName: started.lock.holderName });
  return refuse(RESULT_CODES.MOVEMENT_STATE_STALE);
}

function drivenSettlement(then) {
  if (then === DRIVE_SETTLEMENTS.PLAN) return { resume: true, endTurn: false, charges: true };
  return { resume: false, endTurn: then === DRIVE_SETTLEMENTS.END_TURN, charges: true };
}

/** Read a driven route off the wire: a Token, an ordered list of whole squares, and what to do at the end. */
function drivenMovementIntent(payload) {
  const tokenUuid = String(payload?.tokenUuid ?? '');
  const then = String(payload?.then ?? '');
  if (!tokenUuid || !Object.values(DRIVE_SETTLEMENTS).includes(then)) return null;
  if (!Array.isArray(payload?.path)) return null;
  const path = [];
  for (const cell of payload.path) {
    const x = Math.floor(Number(cell?.x));
    const y = Math.floor(Number(cell?.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    path.push(Object.freeze({ x, y }));
  }
  return Object.freeze({
    tokenUuid, then, path: Object.freeze(path), restoreStance: payload?.restoreStance === true
  });
}

/* -------------------------------------------- */
/*  Transition squares                          */
/* -------------------------------------------- */

/**
 * The teleport command. The landing is checked before any cost is spent. When the hop ends the turn, the resting
 * Stn comes back only after the teleport has settled. A hop is the unit's own move, so a stranded unit can't take
 * one.
 */
async function useTeleport(context, movements, events, objects, services) {
  const checked = await ownedMovementSnapshot(context, movements, { requirePlan: true });
  if (!checked.ok) return checked.result;
  const snapshot = checked.snapshot;
  if (movementStranded(snapshot)) return refuse(RESULT_CODES.MOVEMENT_STRANDED);
  const graph = buildMovementGraph(snapshot);
  const resolution = resolveMovementDestination(graph, snapshot.current);
  if (!resolution) return refuse(RESULT_CODES.MOVEMENT_DESTINATION_INVALID);
  const pad = teleportPadAt(snapshot.terrainTeleports, snapshot.current);
  if (!pad) return refuse(RESULT_CODES.TELEPORT_UNAVAILABLE);
  const details = { letter: pad.letter, movementCost: pad.movementCost };

  const landing = resolveTeleportLanding(teleportBoard(snapshot), pad, snapshot.footprint);
  if (!landing.ok) return refuse(landing.code, details);
  const charge = resolveTeleportCost(pad, {
    exploring: snapshot.exploring,
    movementRemaining: Math.max(0, snapshot.allowance - resolution.cost),
    bonusAvailable: snapshot.bonusAvailable,
    actionAvailable: snapshot.standardAvailable
  });
  if (!charge.ok) return refuse(charge.code, details);
  const settlement = await movements.teleport(
    snapshot, { ...resolution, destination: landing.destination }, charge, context.operation);
  if (!settlement.ok) return refuseTeleportSettlement(services, settlement, details);
  const stanceRestored = charge.endTurn === true ? await restoreRestingStance(snapshot, true, services.impacts) : 0;
  const outcome = {
    tokenUuid: snapshot.tokenUuid,
    tokenName: snapshot.tokenName,
    actorUuid: snapshot.actorUuid,
    actorName: snapshot.actorName,
    sceneUuid: snapshot.sceneUuid,
    letter: pad.letter,
    origin: snapshot.current,
    destination: landing.destination,
    cost: resolution.cost + charge.movementSpent,
    resumed: charge.resume === true,
    turnEnded: charge.endTurn === true,
    stanceRestored,
    armamentReleased: await objects.releaseArmamentIfLeft(snapshot.tokenUuid) === true,
    requestId: context.requestId,
    userId: context.userId
  };
  events.publish(EVENT_IDS.MOVEMENT_COMMITTED, outcome);
  return accept(RESULT_CODES.TELEPORT_USED, outcome);
}

/**
 * Refuse a hop the settlement could not finish: stale facts refuse as ordinary movement staleness, a refused
 * write as a failed settlement. The operation the handler ran under puts the pad, the charge and the lock back.
 */
function refuseTeleportSettlement(services, settlement, details) {
  const code = String(settlement?.code ?? TELEPORT_SETTLEMENT_OUTCOMES.STALE);
  const data = { ...details, reasonCode: settlement?.reasonCode || code };
  if (code !== TELEPORT_SETTLEMENT_OUTCOMES.REVERTED) return refuse(RESULT_CODES.MOVEMENT_STATE_STALE, data);
  data.diagnostic = recordDiagnostic(services?.diagnostics, {
    sourcePath: 'foundry/adapters/document-writes/movement-settlements.mjs',
    source: DIAGNOSTIC_SOURCES.TERRAIN,
    severity: DIAGNOSTIC_SEVERITIES.WARNING,
    detail: `${code}:${data.reasonCode}`
  });
  return refuse(RESULT_CODES.TELEPORT_SETTLEMENT_FAILED, data);
}

/**
 * The board resolveTeleportLanding judges a hop's exit on. Its occupied squares are the snapshot's `occupiedCells`,
 * every square another unit stands on and this one can't stop on, allies' squares included. `blockedCells` holds
 * only the squares it can't walk through, which leaves an ally's square out. The unit's own Token is never in
 * either list (projectTokenOccupancy in foundry/adapters/projections/movement.mjs skips it), so it can't block its
 * own landing.
 */
function teleportBoard(snapshot) {
  const blocked = new Set([
    ...(snapshot.terrainImpassableCells ?? []).map(cell => `${cell.x},${cell.y}`),
    ...(snapshot.terrainOcclusionCells ?? []).map(cell => `${cell.x},${cell.y}`)
  ]);
  return {
    bounds: { columns: snapshot.columns, rows: snapshot.rows },
    occupied: new Set(snapshot.occupiedCells),
    elevations: snapshot.terrainElevations ?? {},
    blocked
  };
}

/* -------------------------------------------- */
/*  Terrain crossings                           */
/* -------------------------------------------- */

/**
 * The crossing command: attempt the terrain crossing to the requested square, if planCrossingAttempt allows it
 * from the square the unit's plan stands on.
 */
async function crossTerrain(context, movements, services) {
  const tokenUuid = String(context.payload?.tokenUuid ?? '');
  if (!tokenUuid) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const snapshot = await movements.getCrossingSnapshot(tokenUuid);
  if (!snapshot) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const checked = await validateOwnedSnapshot(context, movements, snapshot.movement, { requirePlan: true });
  if (!checked.ok) return checked.result;

  const standing = resolveMovementDestination(buildMovementGraph(snapshot.movement), snapshot.movement.current);
  if (!standing) return refuse(RESULT_CODES.MOVEMENT_DESTINATION_INVALID);
  const eligibility = planCrossingAttempt({
    exploring: snapshot.movement.exploring,
    airborne: snapshot.movement.airborne,
    stranded: movementStranded(snapshot.movement),
    mounted: snapshot.source.mounted,
    stance: snapshot.source.stance,
    actionAvailable: snapshot.movement.standardAvailable,
    movementRemaining: snapshot.movement.allowance - standing.cost
  });
  if (!eligibility.ok) return refuse(eligibility.code);

  const destination = {
    x: Math.floor(Number(context.payload?.destinationX)),
    y: Math.floor(Number(context.payload?.destinationY))
  };
  const crossing = crossingCandidates(snapshot.movement, snapshot.movement.current, destination)
    .find(option => option.to.x === destination.x && option.to.y === destination.y);
  if (!crossing) return refuse(RESULT_CODES.CROSSING_DESTINATION_INVALID);

  let outcome;
  try {
    outcome = await settleCrossing(snapshot, crossing, services, context, movements);
  } catch (error) {
    const diagnostic = recordDiagnostic(services?.diagnostics, {
      sourcePath: import.meta.url, error, detail: 'crossTerrain'
    });
    return refuse(RESULT_CODES.CROSSING_STALE, {
      reasonCode: error instanceof CombatPersistenceError ? error.code : 'movement.crossing-failed',
      diagnostic
    });
  }
  services.events.publish(EVENT_IDS.MOVEMENT_COMMITTED, outcome);
  return accept(RESULT_CODES.CROSSING_ATTEMPTED, outcome);
}

/**
 * Roll, move, then end the turn before any fall damage, since a lethal fall can remove the token. A refused turn
 * close throws and stops the rest of the crossing.
 */
async function settleCrossing(snapshot, crossing, services, context, movements) {
  await movements.captureCrossing(snapshot, context.operation);
  const { skillKey, check, roll, success } = await rollCrossingCheck(snapshot, crossing, services, context, movements);
  const moved = await settleCrossingMove(snapshot, crossing, services, movements, success, context.operation);
  if (!await movements.settleCrossingTurn(snapshot, { operation: context.operation })) {
    throw new CombatPersistenceError('movement.crossing-turn-settlement-failed');
  }
  const fall = moved && !success
    ? await settleCrossingFall(snapshot, crossing, services, { check, roll })
    : NO_FALL;
  return crossingOutcome(snapshot, crossing, context, {
    skillKey, check, success, moved, fall, turnEnded: true
  });
}

/**
 * A descent a push forces, run as a child command of the pushing effect (wired in init/system.mjs) inside its
 * operation. It doesn't end the pushed unit's turn.
 */
async function forceCrossing(context, movements, services) {
  const tokenUuid = String(context.payload?.tokenUuid ?? '');
  if (!tokenUuid) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const snapshot = await movements.getCrossingSnapshot(tokenUuid);
  if (!snapshot?.movement?.supportedGrid) return refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND);
  const destination = {
    x: Math.floor(Number(context.payload?.destinationX)),
    y: Math.floor(Number(context.payload?.destinationY))
  };
  const forced = resolveForcedStep(snapshot.movement, snapshot.movement.current, destination);
  if (forced.outcome !== FORCED_STEP_OUTCOMES.DESCENT) {
    return refuse(RESULT_CODES.CROSSING_DESTINATION_INVALID, { outcome: forced.outcome });
  }
  await movements.captureCrossing(snapshot, context.operation);
  const { skillKey, check, roll, success } = await rollCrossingCheck(
    snapshot, forced.crossing, services, context, movements);
  const moved = await settleCrossingMove(snapshot, forced.crossing, services, movements, success, context.operation);
  const fall = success ? NO_FALL
    : await settleCrossingFall(snapshot, forced.crossing, services, { check, roll });
  return accept(RESULT_CODES.CROSSING_ATTEMPTED, crossingOutcome(snapshot, forced.crossing, context, {
    skillKey, check, success, moved, fall, turnEnded: false
  }));
}

/**
 * Roll the crossing check, post its card, wait CROSSING_ATTEMPT_TIMING.diceSettleHold, then grant the skill XP.
 * FoundryMovementRepository.captureCrossing has already added the karma ledger the check may book to the operation.
 */
async function rollCrossingCheck(snapshot, crossing, services, context, movements) {
  const { skillKey, check } = resolveCrossingCheck(crossing, crossingUnit(snapshot.source));
  if (!check) throw new CombatPersistenceError('movement.crossing-check-unavailable');
  const roll = await services.checks.roll(snapshot.source.actorUuid, check,
    { requestId: context.requestId, operation: context.operation });
  await presentCrossingCheck(services, snapshot, crossing, check, roll, context);
  await services.wait(CROSSING_ATTEMPT_TIMING.diceSettleHold);
  await services.skills.grant({ actorUuid: snapshot.source.actorUuid, skillKey }, context);
  return { skillKey, check, roll, success: roll.success === true };
}

/** The command's result for one crossing, chosen or forced. */
function crossingOutcome(snapshot, crossing, context, { skillKey, check, success, moved, fall, turnEnded }) {
  return Object.freeze({
    tokenUuid: snapshot.source.tokenUuid,
    tokenName: snapshot.movement.tokenName,
    actorUuid: snapshot.source.actorUuid,
    actorName: snapshot.source.actorName,
    sceneUuid: snapshot.sceneUuid,
    origin: snapshot.movement.current,
    destination: moved ? crossing.to : snapshot.movement.current,
    zoneName: crossing.zoneName,
    skillKey,
    dc: check.dc,
    success,
    moved,
    fallDamage: fall.fallDamage,
    defeated: fall.defeated,
    cost: 0,
    resumed: false,
    turnEnded,
    requestId: context.requestId,
    userId: context.userId
  });
}

/** Move the unit across, or keep it in place after a failed climb. Returns true when the token moved. */
async function settleCrossingMove(snapshot, crossing, services, movements, success, operation) {
  if (!success && !crossing.descending) {
    await services.audio.error();
    await services.wait(CROSSING_ATTEMPT_TIMING.failedAscentHold);
    return false;
  }
  if (success) await services.audio.climb();
  if (!await movements.crossTerrain(snapshot, crossing.to, { operation })) {
    throw new CombatPersistenceError('movement.crossing-move-refused');
  }
  return true;
}

const NO_FALL = Object.freeze({ fallDamage: 0, defeated: false });

/**
 * Apply a failed descent's fall damage through the damage command, which joins this crossing's operation and
 * handles the Stn and defeat writes.
 */
async function settleCrossingFall(snapshot, crossing, services, { check, roll }) {
  const fallDamage = crossingFallDamage({
    levels: crossing.levels,
    miss: check.dc - (Number(roll.total) || 0),
    maxHp: snapshot.source.hpMax
  });
  if (!(fallDamage > 0)) return NO_FALL;
  const dealt = await services.impacts.applyDamage({
    actorUuid: snapshot.source.actorUuid,
    tokenUuid: snapshot.source.tokenUuid,
    amount: fallDamage,
    damageType: '',
    policy: DAMAGE_POLICIES.DAMAGE_OVER_TIME,
    unpreventable: true
  });
  return { fallDamage, defeated: dealt?.data?.defeatComplete === true };
}

async function presentCrossingCheck(services, snapshot, crossing, check, roll, context) {
  try {
    await services.checkPresentation.presentSkill({
      requester: context.requester ?? { userId: context.userId, messageMode: context.messageMode },
      actorUuid: snapshot.source.actorUuid,
      actorName: snapshot.source.actorName,
      actorImage: snapshot.source.actorImage,
      avatarScale: snapshot.source.avatarScale,
      dc: check.dc,
      natural: roll.natural,
      total: roll.total,
      success: roll.success,
      effectName: 'Terrain Crossing',
      targetName: crossing.zoneName,
      check,
      roll
    });
  } catch (diagnosticError) {
    recordDiagnostic(services?.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'presentCrossingCheck' });
  }
}

function crossingUnit(source) {
  return {
    skills: source.skills,
    attributes: source.attributes,
    factionRole: source.actorType,
    blessed: source.blessed
  };
}

/* -------------------------------------------- */
/*  Interrupted-plan recovery                   */
/* -------------------------------------------- */
/**
 * Release a plan whose holder left the table. The `recovery.clear-lock` command calls this through
 * init/system.mjs, the GM restore (engine/development.mjs) forces it on a live holder too, and beginMovement runs
 * the same settleStaleMovement first. Each passes its own operation, so a failure puts the plan back exactly as it
 * stood. Only a forced release frees a lock whose unit carries a plan the lock did not start;
 * FoundryMovementRepository.recoverStalePlan then closes that plan where its Token stands.
 */
export async function recoverStaleMovement(context, movements, options = {}) {
  const recovery = await settleStaleMovement(movements, context, options);
  return recovery.ok ? accept(RESULT_CODES.MOVEMENT_RECOVERED, recovery.data)
    : refuse(RESULT_CODES.COMMAND_FAILED, recovery.data);
}

async function settleStaleMovement(movements, context, options = {}) {
  const snapshot = await movements.getStaleRecoverySnapshot(options);
  if (!snapshot) return { ok: true, data: { recovered: false } };
  if (!holdsResources(context, await movements.resourceKeys(snapshot.tokenUuid))) {
    return { ok: false, data: { reasonCode: 'movement.stale-recovery-changed' } };
  }
  const settled = await movements.recoverStalePlan(snapshot, { ...options,
    operation: context.operation,
    resources: { hold: keys => holdsResources(context, keys) } });
  if (!settled.ok) return { ok: false, data: { ...diagnosticData(settled), reasonCode: settled.code } };
  return {
    ok: true,
    data: {
      recovered: true,
      tokenUuid: snapshot.tokenUuid,
      actorUuid: snapshot.actorUuid,
      restored: settled.restored === true
    }
  };
}

/* -------------------------------------------- */
/*  Authority checks                            */
/* -------------------------------------------- */
async function ownedMovementSnapshot(context, movements, { requirePlan }) {
  const tokenUuid = String(context.payload?.tokenUuid ?? '');
  if (!tokenUuid) return { ok: false, result: refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND) };
  const snapshot = await movements.getSnapshot(tokenUuid);
  if (!snapshot) return { ok: false, result: refuse(RESULT_CODES.MOVEMENT_TOKEN_NOT_FOUND) };
  return validateOwnedSnapshot(context, movements, snapshot, { requirePlan });
}

async function validateOwnedSnapshot(context, movements, snapshot, { requirePlan }) {
  if (snapshot.actorType !== 'Character') {
    return { ok: false, result: refuse(RESULT_CODES.CHARACTER_REQUIRED) };
  }
  if (requirePlan && !movements.canUserPlan(snapshot, context.userId)) {
    return { ok: false, result: refuse(RESULT_CODES.MOVEMENT_PLAN_REQUIRED) };
  }
  return { ok: true, snapshot };
}
