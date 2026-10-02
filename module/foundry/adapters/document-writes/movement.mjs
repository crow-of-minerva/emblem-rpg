/** @layer foundry/adapters/document-writes */
import { KARMA_LEDGER_SETTING, USER_LOCK_SETTING } from '../../../config/settings.mjs';
import {
  createDiagnostic,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  SYSTEM_ID
, recordDiagnostic } from '../../../contracts/protocol.mjs';
import { DRIVEN_WALK_TIMING, TELEPORT_SETTLEMENT_OUTCOMES } from '../../../contracts/domains/terrain.mjs';
import {
  GROUNDED_BY_STANCE_BREAK_FLAG, MOVEMENT_INPUT_KINDS, planMovementSpend
} from '../../../game/movement/input-policy.mjs';
import {
  projectForcedMovementBoards,
  projectGeometryResolver,
  projectMovementCrossings,
  projectMovementField,
  projectMovementSnapshot,
  scenePermission
} from '../projections/movement.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { clone, forcedDeletion, resolveActor, resolveScene, resolveToken } from '../services/host.mjs';
import { projectFoundryMovementInput } from '../projections/board.mjs';
import { projectDrivenHold } from '../projections/encounters.mjs';
import {
  closeMovementPlan, lockIsStale, movementActorCapture, movementLockNow, movementRestoreOptions, normalizeLock,
  planEndCaptures, sameLock, samePosition, settlePlanEnd, settleTeleportHop, snapshotStillCurrent, teleportOutcome,
  turnChangesLanded
} from './movement-settlements.mjs';
import { reportFoundryError , FoundryDiagnostics } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Movement constants                          */
/* -------------------------------------------- */
const FACING_COOLDOWN_MS = 150;
const facingStates = new WeakMap();

/* -------------------------------------------- */
/*  Movement facing                             */
/* -------------------------------------------- */
/**
 * Flip a Token to face the way a user moves it sideways by keyboard or drag, without delaying the move. Called
 * from the preUpdateToken hook in init/hooks.mjs.
 */
export function applyMovementFacing(tokenDocument, changes, options = {}) {
  if (!Number.isFinite(changes?.x) || Number(changes.x) === Number(tokenDocument?.x)) return false;
  const inputKind = projectFoundryMovementInput(tokenDocument, options);
  if (inputKind !== MOVEMENT_INPUT_KINDS.KEYBOARD && inputKind !== MOVEMENT_INPUT_KINDS.MOUSE_DRAG) return false;
  // While a flip animates, scaleX passes through zero, so the saved scaleY gives the Token's true size.
  const sourceTexture = tokenDocument?._source?.texture ?? tokenDocument?.texture ?? {};
  const currentScale = Number(sourceTexture.scaleX) || 1;
  const magnitude = Math.abs(Number(sourceTexture.scaleY)) || Math.abs(currentScale) || 1;
  const targetScale = Number(changes.x) > Number(tokenDocument.x) ? -magnitude : magnitude;
  const token = tokenDocument?.object ?? tokenDocument;
  const state = facingStates.get(token) ?? { lastFlipAt: 0 };
  if (currentScale === targetScale) return false;
  const now = Date.now();
  if (now - state.lastFlipAt < FACING_COOLDOWN_MS) return false;
  state.lastFlipAt = now;
  facingStates.set(token, state);
  Promise.resolve()
    .then(() => tokenDocument.update(
      { 'texture.scaleX': targetScale },
      { animation: { duration: 0 }, emblemFacingUpdate: true }
    ))
    .catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'applyMovementFacing'); });
  return true;
}

/* -------------------------------------------- */
/*  Movement repository                         */
/* -------------------------------------------- */
/**
 * Reads and writes for engine/movement: movement snapshots, the board lock, a plan's anchor and preview position,
 * flight state, teleports and terrain crossings.
 *
 * Every write that matters takes the `operation` its command received from CommandDispatcher and captures the
 * Actor, Token and board-lock setting it will change before touching them. The dispatcher restores them if the
 * command is refused or throws.
 */
export class FoundryMovementRepository {
  constructor({
    guardBonds = null,
    diagnostics = null,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  } = {}) {
    this.guardBonds = guardBonds;
    this.diagnostics = diagnostics;
    this.wait = wait;
  }

  /**
   * CommandDispatcher lock keys for a move: the shared board, plus the Scenes and Actors of the moving unit, the
   * unit whose plan holds the board lock, and their Guard-bond partners.
   */
  async resourceKeys(tokenUuid = '') {
    const lock = this.getLock();
    const tokenUuids = new Set([String(tokenUuid || ''), String(lock?.tokenUuid ?? '')]);
    const actorUuids = new Set();
    const sceneUuids = new Set();
    for (const uuid of tokenUuids) {
      const token = await resolveToken(uuid);
      if (token?.actor?.uuid) actorUuids.add(String(token.actor.uuid));
      if (token?.parent?.uuid) sceneUuids.add(String(token.parent.uuid));
      const bond = token ? this.guardBonds?.bondOf?.(token) : null;
      for (const partner of [bond?.guarder, bond?.guarded].filter(Boolean)) {
        if (partner.actor?.uuid) actorUuids.add(String(partner.actor.uuid));
        if (partner.parent?.uuid) sceneUuids.add(String(partner.parent.uuid));
      }
    }
    if (lock?.actorUuid) actorUuids.add(lock.actorUuid);
    return [
      'movement:board',
      ...[...sceneUuids].sort().map(sceneUuid => `scene:${sceneUuid}`),
      ...[...actorUuids].sort().map(actorUuid => `actor:${actorUuid}`)
    ];
  }

  /** Return the current world lock as plain data. */
  getLock() {
    return normalizeLock(game.settings.get(SYSTEM_ID, USER_LOCK_SETTING));
  }

  isLockSetting(setting) {
    const key = setting?.key ?? setting?.name;
    return key === `${SYSTEM_ID}.${USER_LOCK_SETTING}`;
  }

  /** The hold a companion module has on the board, or null. No player may move while it stands. */
  getDrivenHold() {
    return projectDrivenHold();
  }

  /** Resolve a Token UUID into the plain data required by pure pathfinding. */
  async getSnapshot(tokenUuid) {
    const token = await resolveToken(tokenUuid);
    return token ? projectMovementSnapshot(token) : null;
  }

  /** Measure one unit's reachable board synchronously, for a planner deciding where to send it. */
  getField(tokenUuid, options = {}) {
    return projectMovementField(String(tokenUuid ?? ''), options);
  }

  /** Read every elevation boundary one unit could attempt, with its odds and its worst fall. */
  getCrossings(tokenUuid) {
    return projectMovementCrossings(String(tokenUuid ?? ''));
  }

  /** Read the boards a Shove or a Retrieve is judged on: the caster's, and the moved unit's without the caster. */
  getForcedMovementBoards(sourceTokenUuid, targetTokenUuid) {
    return projectForcedMovementBoards(String(sourceTokenUuid ?? ''), String(targetTokenUuid ?? ''));
  }

  /** Build the placement resolver an authored geometry requirement reads, on the live Scene. */
  geometryResolver(request = {}) {
    return projectGeometryResolver(request);
  }

  /**
   * Move along a validated route, wait for the walk animation's duration, then check the saved position and place
   * the Token at the destination if the move fell short. The wait is timed, because rendering on the host's canvas
   * isn't a reliable sign of arrival.
   */
  async walk(snapshot, path = [], operation = null) {
    const token = await resolveToken(snapshot.tokenUuid);
    if (!token || !path.length) return { arrived: false, placed: false };
    const gridSize = Number(snapshot.gridSize) || 0;
    const destination = { x: path.at(-1).x * gridSize, y: path.at(-1).y * gridSize };
    await operation?.capture({ documents: [token] });
    await token.move(
      path.map(cell => ({ x: cell.x * gridSize, y: cell.y * gridSize })),
      { showRuler: false, autoRotate: false }
    );
    await this.wait(walkAnimationMs([snapshot.current, ...path].filter(Boolean)));
    if (samePosition(token._source, destination)) {
      return { arrived: true, placed: false };
    }
    this.diagnostics?.record?.(createDiagnostic({ sourcePath: import.meta.url,
      source: DIAGNOSTIC_SOURCES.MOVEMENT,
      severity: DIAGNOSTIC_SEVERITIES.WARNING,
      detail: `walk did not settle: ${snapshot.tokenUuid} placed at ${path.at(-1).x},${path.at(-1).y}`
    }));
    const placed = await token.move({ ...destination, action: 'displace' }, movementRestoreOptions());
    return { arrived: false, placed: placed !== false && samePosition(token._source, destination) };
  }

  /** Take the board lock and record where the move starts (its anchor). A holder resuming their own plan keeps it. */
  async begin(snapshot, userId, operation = null) {
    const token = await resolveToken(snapshot.tokenUuid);
    const actor = token?.actor;
    if (!token || !actor) return { ok: false, stale: true };
    const standing = this.getLock();
    if (standing) {
      if (lockIsStale(standing)) return { ok: false, stale: true };
      const resumesCurrentPlan = standing.holderId === userId
        && standing.tokenUuid === snapshot.tokenUuid
        && snapshot.movementPlanning
        && snapshot.movementControllerId === userId;
      return resumesCurrentPlan ? { ok: true, lock: standing, resumed: true } : { ok: false, lock: standing };
    }

    const lock = {
      holderId: userId,
      holderName: game.users.get(userId)?.name ?? 'Someone',
      tokenUuid: token.uuid,
      actorUuid: String(actor.uuid ?? ''),
      tokenName: snapshot.tokenName,
      tokenImg: snapshot.tokenImg,
      acquiredAt: Date.now()
    };
    await operation?.capture({ documents: [movementActorCapture(actor), token], settings: [USER_LOCK_SETTING] });
    await game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, lock);
    const changes = {
      'system.turn.movementPlanning': true,
      'system.turn.movementControllerId': userId,
      'system.turn.movementAnchorX': token._source.x,
      'system.turn.movementAnchorY': token._source.y,
      'system.turn.movementPlanStartedAt': lock.acquiredAt
    };
    await actor.update({ ...changes }, {});
    if (!turnChangesLanded(actor, changes)) throw new Error('movement.begin-write-refused');
    return { ok: true, lock };
  }

  /** Write the unit's grounded state ahead of the commit that ends its turn. */
  async setGrounded(snapshot, grounded, operation = null) {
    const token = await resolveToken(snapshot.tokenUuid);
    const actor = token?.actor;
    if (!token || !actor || !snapshotStillCurrent(token, actor, snapshot)) return false;
    try {
      await operation?.capture({ documents: [movementActorCapture(actor, { grounds: true })] });
      await actor.update(flightChanges(actor, grounded));
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'setGrounded');
      return false;
    }
  }

  /** Project the map's permission and every placed Character's flight and mount facts. */
  async getPermissionBoard(sceneUuid) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return null;
    const units = [];
    for (const token of collectionValues(scene.tokens)) {
      const actor = token.actor;
      if (!actor || actor.type !== 'Character') continue;
      const mount = collectionValues(actor.items).find(item => (
        item?.system?.itemType === 'Mount' && item?.system?.isEquipped === true
      ));
      units.push(Object.freeze({
        actorUuid: String(actor.uuid ?? ''),
        flying: actor.system?.unitType?.flying === true,
        grounded: actor.system?.statuses?.grounded === true,
        levitating: actor.system?.combat?.levitation === true,
        mountItemId: mount ? String(mount.id) : ''
      }));
    }
    return Object.freeze({ sceneUuid: String(scene.uuid ?? ''), permission: scenePermission(scene), units: Object.freeze(units) });
  }

  /**
   * Record, in one capture, everything a terrain crossing touches: the Token that steps down, the unit's turn block
   * and grounded status, the board lock a settled crossing releases, and the karma ledger its check books. The
   * crossing commands in engine/movement/commands.mjs call this before the check rolls, so the captures made by
   * the writers that follow (crossTerrain, settleCrossingTurn and FoundryCharacterCheckService) add nothing new.
   * A fall's damage is captured by FoundryHealthRepository when it reaches the Actor.
   */
  async captureCrossing(snapshot, operation = null) {
    if (!operation) return true;
    const token = await resolveToken(snapshot?.movement?.tokenUuid ?? snapshot?.source?.tokenUuid);
    const actor = token?.actor ?? await resolveActor(snapshot?.source?.actorUuid);
    await operation.capture({
      documents: [token, actor && movementActorCapture(actor, { grounds: true })].filter(Boolean),
      settings: [USER_LOCK_SETTING, KARMA_LEDGER_SETTING]
    });
    return true;
  }

  /** Set a unit's grounded state outside a movement plan, as a free take-off does. */
  async setActorGrounded(actorUuid, grounded = true, operation = null) {
    const actor = await resolveActor(actorUuid);
    if (!actor) return false;
    try {
      await operation?.capture({ documents: [movementActorCapture(actor, { grounds: true })] });
      await actor.update(flightChanges(actor, grounded));
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'setActorGrounded');
      return false;
    }
  }

  /** Whether this user controls the unit's live plan and holds the board lock. */
  canUserPlan(snapshot, userId) {
    const lock = this.getLock();
    return snapshot.movementPlanning
      && snapshot.movementControllerId === userId
      && lock?.holderId === userId
      && lock?.tokenUuid === snapshot.tokenUuid;
  }

  /**
   * Commit the preview position with the movement charge engine/movement worked out, then keep the plan open or
   * close it. A resumed leg writes only the Actor's turn. A close goes through closeMovementPlan
   * (document-writes/movement-settlements.mjs), which also releases the board lock and settles the plan's end. A
   * cancelled close removes the effects that lapse on cancel, and a confirmed one keeps them.
   */
  async commit(snapshot, resolution, {
    resume = true, endTurn = !resume, canter = false, charges = true, anchor = false,
    cancelled = false, operation = null
  } = {}) {
    const token = await resolveToken(snapshot.tokenUuid);
    const actor = token?.actor;
    if (!token || !actor || !snapshotStillCurrent(token, actor, snapshot)) return false;
    const changes = {
      'system.turn.movementSpent': planMovementSpend({
        priorSpent: snapshot.movementSpent, legCost: resolution.cost, charges
      }),
      'system.turn.movementAvailable': charges === false ? snapshot.movementAvailable : resume && anchor !== true,
      'system.turn.movementPlanning': resume,
      'system.turn.canterPathfinding': resume && canter === true,
      'system.turn.movementControllerId': resume ? snapshot.movementControllerId : '',
      'system.turn.movementAnchorX': token._source.x,
      'system.turn.movementAnchorY': token._source.y,
      'system.turn.movementPlanStartedAt': resume ? snapshot.movementPlanStartedAt : 0
    };
    if (endTurn) changes['system.turn.actionAvailable'] = false;
    if (endTurn && !resume) {
      changes['system.turn.bonusActionAvailable'] = false;
      changes['system.turn.continuationPending'] = '';
      changes['system.turn.continuationRequestId'] = '';
    }
    if (!resume) {
      return closeMovementPlan({ token, actor, changes, guardBonds: this.guardBonds, cancelled, operation });
    }
    await operation?.capture({ documents: [movementActorCapture(actor)] });
    await actor.update({ ...changes }, {});
    return turnChangesLanded(actor, changes);
  }

  /**
   * Settle a teleport hop once the unit has walked onto the pad (settleTeleportHop in movement-settlements.mjs).
   * The command's operation already holds the walk, so a refused hop puts the unit back where the walk started,
   * not just on the pad.
   */
  async teleport(snapshot, resolution, charge, operation = null) {
    const token = await resolveToken(snapshot.tokenUuid);
    const actor = token?.actor;
    if (!token || !actor || !snapshotStillCurrent(token, actor, snapshot)) {
      return teleportOutcome(TELEPORT_SETTLEMENT_OUTCOMES.STALE, 'movement.teleport-aggregate-missing');
    }
    return settleTeleportHop(snapshot, resolution, charge, token, actor, operation);
  }

  /**
   * Restore the anchor, either keeping the committed plan or releasing it completely.
   *
   * Exploration has no anchor to return to, so a plan closed there leaves the unit where it stands. Releasing
   * the plan is a cancel, so the effects authored to lapse with a cancelled move go with it.
   */
  async cancel(snapshot, { keepPlanning = false, restoreAnchor = true, operation = null } = {}) {
    const token = await resolveToken(snapshot.tokenUuid);
    const actor = token?.actor;
    if (!token || !actor || !snapshotStillCurrent(token, actor, snapshot)) return false;
    const cleanup = keepPlanning
      ? { documents: [], deleting: [] }
      : planEndCaptures(actor, token, { guardBonds: this.guardBonds, cancelled: true });
    await operation?.capture({
      documents: [movementActorCapture(actor), token, ...cleanup.documents],
      deleting: cleanup.deleting,
      settings: [USER_LOCK_SETTING]
    });
    const previewPosition = { x: token._source.x, y: token._source.y };
    const displaced = restoreAnchor
      && (previewPosition.x !== snapshot.anchorPosition.x || previewPosition.y !== snapshot.anchorPosition.y);
    if (displaced) {
      const moved = await token.move({ ...snapshot.anchorPosition, action: 'displace' }, movementRestoreOptions());
      if (moved === false || !samePosition(token, snapshot.anchorPosition)) {
        throw new Error('movement.cancel-move-refused');
      }
    }
    if (keepPlanning) return true;
    const changes = {
      'system.turn.movementPlanning': false,
      'system.turn.canterPathfinding': false,
      'system.turn.movementControllerId': '',
      'system.turn.movementAnchorX': token._source.x,
      'system.turn.movementAnchorY': token._source.y,
      'system.turn.movementPlanStartedAt': 0
    };
    await actor.update({ ...changes }, {});
    if (!turnChangesLanded(actor, changes)) throw new Error('movement.cancel-write-refused');
    await game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, null);
    await settlePlanEnd(actor, token, { cancelled: true, guardBonds: this.guardBonds, operation });
    return true;
  }

  /** Release a lock whose Token disappeared before ordinary cancellation could settle. */
  async releaseOrphan(tokenUuid, userId, operation = null) {
    const lock = this.getLock();
    if (lock?.tokenUuid !== tokenUuid || lock?.holderId !== userId) return false;
    await operation?.capture({ settings: [USER_LOCK_SETTING] });
    await game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, null);
    return true;
  }

  /* -------------------------------------------- */
  /*  Terrain crossings                           */
  /* -------------------------------------------- */

  /** Read one live plan as the crossing settlement reads it: the plan, and the unit rolling the check. */
  async getCrossingSnapshot(tokenUuid) {
    const movement = await this.getSnapshot(tokenUuid);
    if (!movement) return null;
    return Object.freeze({
      sceneUuid: movement.sceneUuid,
      movement,
      source: Object.freeze({
        actorUuid: movement.actorUuid,
        tokenUuid: movement.tokenUuid,
        actorName: movement.actorName,
        actorImage: movement.actorImage,
        avatarScale: movement.avatarScale,
        actorType: movement.factionRole,
        blessed: movement.blessed,
        stance: movement.stance,
        hpMax: movement.hpMax,
        mounted: movement.mounted,
        skills: movement.skills,
        attributes: movement.attributes
      })
    });
  }

  /**
   * Move to the crossing destination without wall checks or movement cost. Report native vetoes as refusals
   * so the engine cannot end the turn or apply fall damage for a move that never happened.
   */
  async crossTerrain(snapshot, destination, { operation = null } = {}) {
    const token = await resolveToken(snapshot.movement.tokenUuid);
    if (!token) return false;
    const gridSize = snapshot.movement.gridSize;
    await operation?.capture({ documents: [token] });
    return await token.move({
      x: destination.x * gridSize,
      y: destination.y * gridSize,
      action: 'displace'
    }, {
      animate: true,
      emblemMovementRestore: true,
      constrainOptions: { ignoreWalls: true, ignoreCost: true }
    }) !== false;
  }

  /** Spend the action, the bonus and the movement a crossing costs, and close the plan on the far side. */
  async settleCrossingTurn(snapshot, { operation = null } = {}) {
    const token = await resolveToken(snapshot.movement.tokenUuid);
    const actor = token?.actor;
    if (!token || !actor) return false;
    const changes = {
      'system.turn.actionAvailable': false,
      'system.turn.bonusActionAvailable': false,
      'system.turn.movementAvailable': false,
      'system.turn.movementPlanning': false,
      'system.turn.canterPathfinding': false,
      'system.turn.movementControllerId': '',
      'system.turn.movementAnchorX': token._source.x,
      'system.turn.movementAnchorY': token._source.y,
      'system.turn.movementPlanStartedAt': 0
    };
    const cleanup = planEndCaptures(actor, token, { guardBonds: this.guardBonds });
    await operation?.capture({
      documents: [movementActorCapture(actor), token, ...cleanup.documents],
      deleting: cleanup.deleting,
      settings: [USER_LOCK_SETTING]
    });
    await actor.update({ ...changes }, {});
    if (!turnChangesLanded(actor, changes)) return false;
    await game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, null);
    await settlePlanEnd(actor, token, { guardBonds: this.guardBonds, operation });
    return true;
  }

  /* -------------------------------------------- */
  /*  Interrupted plans                           */
  /* -------------------------------------------- */

  /** Lock keys for stale-plan recovery, which may restore the holder's Actor and Token as well as clear the lock. */
  recoveryKeys() { return this.resourceKeys(''); }

  /** Project an abandoned lock and its persisted movement anchor, without writing anything. */
  async getStaleRecoverySnapshot({ force = false } = {}) {
    const lock = this.getLock();
    if (!lock || (!force && !lockIsStale(lock))) return null;
    const token = await resolveToken(lock.tokenUuid);
    const actor = token?.actor ?? await resolveActor(lock.actorUuid);
    const turn = actor?.system?.turn ?? {};
    const movementPlanning = turn.movementPlanning === true;
    const ownsPlan = movementPlanning
      && String(turn.movementControllerId ?? '') === lock.holderId
      && (Number(turn.movementPlanStartedAt) || 0) === lock.acquiredAt;
    if (movementPlanning && !ownsPlan) {
      return Object.freeze({
        tokenUuid: lock.tokenUuid,
        actorUuid: String(actor?.uuid ?? lock.actorUuid ?? ''),
        lock,
        conflict: true
      });
    }
    return Object.freeze({
      tokenUuid: lock.tokenUuid,
      actorUuid: String(actor?.uuid ?? lock.actorUuid ?? ''),
      lock,
      conflict: false,
      movementPlanning: ownsPlan,
      anchorPosition: ownsPlan
        ? Object.freeze({ x: Number(turn.movementAnchorX) || 0, y: Number(turn.movementAnchorY) || 0 })
        : null,
      sourcePosition: token
        ? Object.freeze({ x: token._source.x, y: token._source.y })
        : null
    });
  }

  /**
   * Release a plan whose holder left the table: send the Token back to its anchor, clear the turn and drop the
   * board lock. A forced release is a cancellation, so it also runs the cancel cleanup a live cancel runs.
   *
   * When the lock's unit carries a plan the lock did not start (another controller or start time), only a forced
   * release goes ahead: it closes that plan where the Token stands, because its anchor was not recorded under this
   * lock, and drops the lock. Unforced recovery refuses that conflict, and every release refuses a lock that
   * changed after getStaleRecoverySnapshot read it.
   */
  async recoverStalePlan(snapshot, { force = false, resources = null, operation = null } = {}) {
    const lock = normalizeLock(movementLockNow());
    if (!sameLock(lock, snapshot.lock) || (!force && (snapshot.conflict || !lockIsStale(lock)))) {
      return Object.freeze({ ok: false, code: 'movement.stale-recovery-conflict' });
    }
    const token = await resolveToken(snapshot.tokenUuid);
    const actor = token?.actor ?? await resolveActor(snapshot.actorUuid);
    if (!staleRecoveryStillCurrent(token, actor, snapshot)) {
      return Object.freeze({ ok: false, code: 'movement.stale-recovery-changed' });
    }
    const closes = Boolean(actor && (snapshot.conflict || snapshot.movementPlanning));
    const cancels = force && Boolean(token) && closes;
    if (cancels && resources && !resources.hold(await this.resourceKeys(token.uuid))) {
      return Object.freeze({ ok: false, code: 'movement.cancel-resources-busy' });
    }
    const displaced = Boolean(token && snapshot.anchorPosition && !samePosition(token, snapshot.anchorPosition));
    try {
      await this.#releaseStalePlan(token, actor, snapshot, { closes, cancels, displaced, operation });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'recoverStalePlan');
      return Object.freeze({ ok: false, code: 'movement.stale-recovery-persistence-failed' });
    }
    return Object.freeze({ ok: true, restored: displaced });
  }

  /** The writes a stale release makes, in the order a live cancel makes them. */
  async #releaseStalePlan(token, actor, snapshot, { closes, cancels, displaced, operation }) {
    const cleanup = planEndCaptures(actor, token, { guardBonds: this.guardBonds, cancelled: cancels });
    await operation?.capture({
      documents: [token, actor && movementActorCapture(actor), ...cleanup.documents].filter(Boolean),
      deleting: cleanup.deleting,
      settings: [USER_LOCK_SETTING]
    });
    if (displaced) {
      const moved = await token.move({ ...snapshot.anchorPosition, action: 'displace' }, movementRestoreOptions());
      if (moved === false || !samePosition(token, snapshot.anchorPosition)) {
        throw new Error('movement.stale-anchor-refused');
      }
    }
    if (closes) {
      const changes = {
        'system.turn.movementPlanning': false,
        'system.turn.canterPathfinding': false,
        'system.turn.movementControllerId': '',
        'system.turn.movementPlanStartedAt': 0
      };
      await actor.update({ ...changes }, {});
      if (!turnChangesLanded(actor, changes)) throw new Error('movement.stale-release-refused');
    }
    await game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, null);
    if (!cancels) return;
    await settlePlanEnd(actor, token, { cancelled: true, guardBonds: this.guardBonds, operation });
  }

  /**
   * Snap every open plan on one Scene back to its anchor and drop the board lock. Called when an encounter starts
   * or a phase opens (applyPhaseTurns in engine/combat/encounters/phases.mjs), and by the GM restore and repair
   * tools (engine/development.mjs).
   */
  async recoverScenePlans(sceneUuid, operation = null) {
    const scene = await resolveScene(sceneUuid);
    if (!scene) return { ok: false, code: 'movement.scene-missing' };
    const previousLock = clone(game.settings.get(SYSTEM_ID, USER_LOCK_SETTING));
    const planning = collectionValues(scene.tokens)
      .filter(token => token.actor?.system?.turn?.movementPlanning === true);
    const records = [];
    try {
      if (planning.length || previousLock?.tokenUuid) {
        await operation?.capture({
          documents: planning, settings: previousLock?.tokenUuid ? [USER_LOCK_SETTING] : []
        });
      }
      for (const token of planning) {
        const record = scenePlanRecord(token);
        records.push(record);
        if (samePosition(token, record.anchor)) continue;
        const moved = await token.move({ ...record.anchor, action: 'displace' }, movementRestoreOptions());
        if (moved === false || !samePosition(token, record.anchor)) throw new Error('movement.scene-anchor-refused');
      }
      if (previousLock?.tokenUuid) await game.settings.set(SYSTEM_ID, USER_LOCK_SETTING, null);
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: import.meta.url, error: diagnosticError, detail: 'recoverScenePlans'
      });
      return { ok: false, code: 'movement.recovery-failed', diagnostic };
    }
    return {
      ok: true,
      sceneUuid: scene.uuid,
      previousLock: previousLock ?? {},
      records
    };
  }

  /**
   * No-ops that nothing calls. The operation that captured a Scene reset in recoverScenePlans already handles
   * undoing or keeping it, so there is nothing left for these to do.
   */
  restoreScenePlans() { return Promise.resolve(true); }

  commitScenePlans() { return Promise.resolve(true); }
}

/* -------------------------------------------- */
/*  Plan facts                                  */
/* -------------------------------------------- */

/**
 * The update for one flight change: the Grounded status and, on taking off, removal of the flag a stance break set
 * when it grounded the unit (document-writes/stances.mjs).
 */
function flightChanges(actor, grounded) {
  const changes = { 'system.statuses.grounded': grounded === true };
  if (grounded !== true && actor.flags?.[SYSTEM_ID]?.[GROUNDED_BY_STANCE_BREAK_FLAG] !== undefined) {
    Object.assign(changes, forcedDeletion(`flags.${SYSTEM_ID}.${GROUNDED_BY_STANCE_BREAK_FLAG}`));
  }
  return changes;
}

/** Where one Token stands now and where its plan started, for the result of recoverScenePlans. */
function scenePlanRecord(token) {
  const turn = token.actor?.system?.turn ?? {};
  return {
    tokenUuid: String(token.uuid),
    preview: {
      x: token._source.x, y: token._source.y
    },
    anchor: {
      x: Number(turn.movementAnchorX) || 0, y: Number(turn.movementAnchorY) || 0
    }
  };
}

/**
 * Whether the abandoned plan still stands exactly as the stale-lock projection read it. A conflict snapshot records
 * no anchor or square, so it stands while the unit still carries a plan the lock did not start.
 */
function staleRecoveryStillCurrent(token, actor, snapshot) {
  const turn = actor?.system?.turn ?? {};
  const lockStartedPlan = turn.movementPlanning === true
    && String(turn.movementControllerId ?? '') === snapshot.lock.holderId
    && (Number(turn.movementPlanStartedAt) || 0) === snapshot.lock.acquiredAt;
  if (snapshot.conflict) return turn.movementPlanning === true && !lockStartedPlan;
  if (snapshot.sourcePosition && (!token || !samePosition(token, snapshot.sourcePosition))) return false;
  if (!snapshot.movementPlanning) return turn.movementPlanning !== true;
  return lockStartedPlan
    && (Number(turn.movementAnchorX) || 0) === snapshot.anchorPosition?.x
    && (Number(turn.movementAnchorY) || 0) === snapshot.anchorPosition?.y;
}

/** Calculate Foundry’s walk animation duration for the engine pacing clock, bounded by DRIVEN_WALK_TIMING. */
function walkAnimationMs(cells) {
  const speed = Number(globalThis.CONFIG?.Token?.movement?.defaultSpeed) || 6;
  let squares = 0;
  for (let index = 1; index < cells.length; index += 1) {
    squares += Math.hypot((Number(cells[index].x) || 0) - (Number(cells[index - 1].x) || 0),
      (Number(cells[index].y) || 0) - (Number(cells[index - 1].y) || 0));
  }
  return Math.min(DRIVEN_WALK_TIMING.SETTLE_MAX_MS, Math.round((squares / speed) * 1000));
}
