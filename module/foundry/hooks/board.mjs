/** @layer foundry/hooks */
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { GUARD_BOND_FLAGS } from '../../contracts/domains/combat.mjs';
import {
  MOVEMENT_PERMISSIONS,
  MOVEMENT_PERMISSION_FLAG,
  MOVE_SCALING_FLAG,
  UNIT_MOVE_SCALING_FLAG,
  flyingForbidden,
  normalizeMovementPermission
} from '../../game/movement/input-policy.mjs';
import { RESTORE_WRITE_OPTION } from '../../contracts/domains/recovery.mjs';
import { terrainGridChanged } from '../../game/terrain/rules.mjs';
import { UNIT_FREE_TARGETING_FLAG } from '../../game/character/rules.mjs';
import { areFactionsHostile } from '../../game/character/rules.mjs';
import { collectionValues } from '../../lib/core/runtime.mjs';
import { projectAuraEmissionSignature, projectAuraGearReads } from '../adapters/projections/board.mjs';
import { isAirborneActor } from '../adapters/projections/combat-context.mjs';
import { sceneCombatActive, sceneExplorationActive } from '../adapters/projections/encounters.mjs';
import { isActiveGm as isCurrentCoordinator, isStanceBreakEffect } from '../adapters/services/host.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';
import { armamentFlagChanged } from './actors.mjs';

const RECONCILE_DELAY_MS = 200;
const LANDING_TIMEOUT_MS = 2000;

/** The flags that put an Item in a unit's hands, as game/character/compilation.mjs fills the gear slots from them. */
const EQUIP_FLAGS = Object.freeze(['isWielded', 'isWorn', 'isEquipped']);

/** The Item fields a unit's gear is read from, so editing gear already in hand changes what an aura sees. */
const GEAR_ITEM_PATHS = Object.freeze([
  'name', 'system.itemType', 'system.tier', 'system.weapon', 'system.armor', 'system.wgt', 'system.mountData',
  'system.unitType'
]);

/* -------------------------------------------- */
/*  Auras, terrain and movement limits          */
/* -------------------------------------------- */

/**
 * Run `settle` once with a token when its move animation ends, or after `landingTimeoutMs` if the animation never
 * finishes. The aura and terrain checks read the saved position either way. `whenLanded` returns false when the token
 * isn't animating, and the caller runs `settle` at once.
 */
function createLandingWait({ landingTimeoutMs, settle }) {
  const chained = new WeakMap();
  return {
    whenLanded(tokenDocument) {
      const animation = tokenDocument?.object?.movementAnimationPromise ?? null;
      if (!animation) return false;
      if (chained.get(tokenDocument) === animation) return true;
      chained.set(tokenDocument, animation);
      let landed = false;
      let fallback = null;
      const once = () => {
        if (landed) return;
        landed = true;
        if (fallback) clearTimeout(fallback);
        settle(tokenDocument);
      };
      fallback = setTimeout(once, landingTimeoutMs);
      animation.then(once, once);
      return true;
    }
  };
}

/**
 * Debounce one maintenance command per Scene. Each new schedule restarts the RECONCILE_DELAY_MS timer, so a move
 * across several squares runs the command once, for the final position. Only the host client schedules.
 * `failure` is the diagnostic detail if the command fails, and `accepts` filters the Scenes.
 */
function createSceneSettlement({ executeInternal, commandId, failure, accepts = () => true }) {
  const pending = new Set();
  let timer = null;
  const dispatchPending = () => {
    timer = null;
    const due = [...pending];
    pending.clear();
    for (const sceneUuid of due) {
      void executeInternal(commandId, { sceneUuid }).catch(error => {
        reportFoundryError(import.meta.url, error, failure);
      });
    }
  };
  return {
    schedule(scenes) {
      if (!isCurrentCoordinator()) return;
      let queued = false;
      for (const scene of scenes) {
        if (!scene?.uuid || !accepts(scene)) continue;
        pending.add(String(scene.uuid));
        queued = true;
      }
      if (!queued) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(dispatchPending, RECONCILE_DELAY_MS);
    }
  };
}

/**
 * Re-check auras on the Scenes in play a unit stands on after its equipment changes, but only where some aura reads
 * equipment. What each actor's auras read is cached until `forget`, which runs whenever any aura changes.
 * @param {{schedule: Function}} modifiers The aura and terrain debounce from createSceneSettlement.
 * @returns {{schedule: Function, forget: Function}}
 */
function createGearChangeGate(modifiers) {
  const reads = new Map();
  const readsOf = actor => {
    const actorUuid = String(actor?.uuid ?? '');
    const kept = reads.get(actorUuid);
    if (kept) return kept;
    const projected = projectAuraGearReads(actor);
    if (actorUuid) reads.set(actorUuid, projected);
    return projected;
  };
  return {
    schedule(actor) {
      if (!isCurrentCoordinator()) return;
      const ownGear = readsOf(actor).self;
      const scenes = actorScenes(actor).filter(scene => sceneInPlay(scene) && (ownGear
        || collectionValues(scene.tokens).some(tokenDocument => tokenDocument?.actor
          && readsOf(tokenDocument.actor).target)));
      modifiers.schedule(scenes);
    },
    forget() {
      reads.clear();
    }
  };
}

/**
 * Aura, terrain and movement-limit hook handlers (runtime.modifiers in init/hooks.mjs). They submit
 * RECONCILE_MODIFIERS (auras and terrain) and ENFORCE_PERMISSIONS (flight and mount limits) for the Scenes a change
 * touches, each with its own debounce.
 * Permission checks run only on maps that restrict movement.
 * @param {{executeInternal: Function, landingTimeoutMs?: number}} options The function that queues maintenance
 *   commands (MaintenanceScheduler.submit), and the longest wait for a token's move animation.
 * @returns {Readonly<object>} The handlers init/hooks.mjs calls.
 */
export function createBoardLifecycle({ executeInternal, landingTimeoutMs = LANDING_TIMEOUT_MS }) {
  const signatures = new Map();
  const modifiers = createSceneSettlement({
    executeInternal,
    commandId: INTERNAL_COMMAND_IDS.BOARD.RECONCILE_MODIFIERS,
    failure: 'Emblem RPG | Board modifier settlement failed'
  });
  const permissions = createSceneSettlement({
    executeInternal,
    commandId: INTERNAL_COMMAND_IDS.MOVEMENT.ENFORCE_PERMISSIONS,
    failure: 'Emblem RPG | Movement permission enforcement failed',
    accepts: restrictsMovement
  });
  const gear = createGearChangeGate(modifiers);
  const landing = createLandingWait({ landingTimeoutMs, settle: landed => modifiers.schedule([landed?.parent]) });

  function scheduleWhenLanded(tokenDocument) {
    if (!landing.whenLanded(tokenDocument)) modifiers.schedule([tokenDocument?.parent]);
  }

  function primeSignatures(scenes) {
    for (const scene of scenes) {
      for (const tokenDocument of collectionValues(scene?.tokens)) {
        const actor = tokenDocument?.actor;
        if (actor?.uuid) signatures.set(String(actor.uuid), projectAuraEmissionSignature(actor));
      }
    }
  }

  return Object.freeze({
    onReady() {
      const scenes = scenesInPlay();
      signatures.clear();
      gear.forget();
      primeSignatures(scenes);
      modifiers.schedule(scenes);
      permissions.schedule(scenes);
    },
    onCanvasReadyModifiers() {
      const drawn = [globalThis.canvas?.scene].filter(Boolean);
      primeSignatures(drawn);
      modifiers.schedule(drawn);
      permissions.schedule(drawn);
    },
    onTokenMovementSettling(tokenDocument) {
      if (!isCurrentCoordinator()) return;
      scheduleWhenLanded(tokenDocument);
    },
    /** A token placed or removed. Moves come through onTokenMovementSettling instead. */
    onTokenPlacementChanged(tokenDocument) {
      modifiers.schedule([tokenDocument?.parent]);
      permissions.schedule([tokenDocument?.parent]);
    },
    /**
     * Item writes happen on almost every action, so only a change to an actor's aura emissions, or to what it has in
     * hand, re-checks auras. `changes` is the update's diff. A created or deleted Item passes none.
     */
    onAuraItemChanged(item, changes = null) {
      const actor = item?.parent;
      const actorUuid = String(actor?.uuid ?? '');
      if (!actorUuid || actor.documentName !== 'Actor') return;
      const before = signatures.get(actorUuid);
      const after = projectAuraEmissionSignature(actor);
      signatures.set(actorUuid, after);
      if (before !== after) {
        gear.forget();
        modifiers.schedule(actorScenes(actor));
      } else if (gearItemChanged(item, changes)) gear.schedule(actor);
    },
    onModifierUnitChanged(actor, changes = {}) {
      if (armamentFlagChanged(changes)) gear.schedule(actor);
      if (!unitFactsChanged(changes)) return;
      modifiers.schedule(actorScenes(actor));
    },
    onTerrainGridWritten(scene, changes) {
      if (!terrainGridChanged(changes, SYSTEM_ID)) return;
      modifiers.schedule([scene]);
    },
    onScenePermissionChanged(scene, changes = {}) {
      const touched = path => foundry.utils.hasProperty(changes, `flags.${SYSTEM_ID}.${path}`);
      if (touched(MOVE_SCALING_FLAG)) modifiers.schedule([scene]);
      if (!touched(MOVEMENT_PERMISSION_FLAG)) return;
      permissions.schedule([scene]);
    },
    onMountItemChanged(item) {
      if (item?.parent?.documentName !== 'Actor' || String(item?.system?.itemType ?? '') !== 'Mount') return;
      permissions.schedule(actorScenes(item.parent));
    },
    /**
     * Sweep a map without flight the moment a write leaves a unit on it in the air: an Actor update, or an Item or
     * ActiveEffect it carries, such as a granted Flying type, a Class, or Levitation ending. Foundry prepares the
     * Actor before these hooks run, so the compiled airborne status is the one the write left. An undo restore is
     * skipped, as in every other handler here.
     */
    onUnitFlightChanged(document, options = {}) {
      if (options?.[RESTORE_WRITE_OPTION] === true) return;
      const actor = owningActor(document);
      if (actor?.type !== 'Character' || !isAirborneActor(actor) || actor.system?.combat?.levitation === true) return;
      permissions.schedule(actorScenes(actor).filter(scene => flyingForbidden(
        scene.getFlag(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG)
      )));
    }
  });
}

/* -------------------------------------------- */
/*  Threat overlay                              */
/* -------------------------------------------- */
/**
 * Threat overlay hook handlers (runtime.threat in init/hooks.mjs). Each change does the least work it needs:
 * rebuild the lines' geometry, regrade the matchups, or recolor the existing lines. Nothing runs while the overlay
 * is closed.
 * @param {{threatIndicators: object}} options The overlay.
 */
export function createThreatHookHandlers({ threatIndicators }) {
  const lines = threatIndicators;
  const has = (changes, path) => foundry.utils.hasProperty(changes, path);
  const alive = actor => (Number(actor?.system?.resources?.hp?.value) || 0) > 0;
  const affectsProjection = actor => {
    const mine = lines.selectedActorUuid();
    if (!actor || !mine) return false;
    if (String(actor.uuid ?? '') === mine) return true;
    const theirs = String(actor.system?.faction?.role ?? 'Neutral');
    return areFactionsHostile(theirs, lines.selectedFaction()) || areFactionsHostile(lines.selectedFaction(), theirs);
  };

  return Object.freeze({
    onControlToken() { lines.syncSelection(); },
    onInspectToken(token) {
      lines.syncInspect(token ?? null);
      if (!token) lines.syncSelection();
    },
    onCanvasReady() { lines.stop(); },
    onCombatStart() { if (!lines.running()) lines.syncSelection(); },
    onUpdateCombat() { if (!lines.running()) lines.syncSelection(); },
    onDeleteCombat() { if (lines.running()) lines.release(); },
    onTokenPlaced() { if (lines.running()) lines.invalidate(); },
    onUpdateToken(tokenDocument, changes = {}) {
      if (!lines.running()) return;
      if (guardBondChanged(changes)) return lines.invalidate();
      // The overlay checks the selected token's square itself every frame, so its own moves need no rebuild here.
      if (String(tokenDocument?.id ?? '') === lines.selectedTokenId()) return;
      if (TOKEN_GEOMETRY_KEYS.some(key => key in changes)) lines.invalidate();
    },
    onUpdateActor(actor, changes = {}) {
      if (!lines.running()) return;
      if (lines.tracksCompulsion(actor?.uuid) && !alive(actor)) return lines.invalidate();
      if (!affectsProjection(actor)) return;
      if (FLIGHT_PATHS.some(path => has(changes, path))) return lines.invalidate();
      if (REACH_PATHS.some(path => has(changes, path))) return lines.invalidateGrades();
      if (hasAuraChange(changes)) return lines.invalidateColours();
      if (has(changes, 'system.resources.stn')) return lines.invalidateColours();
      if (!has(changes, 'system.resources.hp')) return;
      if (String(actor.uuid ?? '') === lines.selectedActorUuid()) return lines.invalidateGrades();
      if (lines.hostileWasAlive(actor.uuid) !== alive(actor)) lines.invalidate();
    },
    onItemChanged(item) {
      if (lines.running() && affectsProjection(item?.parent)) lines.invalidateGrades();
    },
    onEffectChanged(effect) {
      if (!lines.running()) return;
      const parent = effect?.parent;
      if (isStanceBreakEffect(effect) && isAirborneActor(parent)
        && String(parent?.uuid ?? '') === lines.selectedActorUuid()) {
        // The selected flier's broken or recovered stance decides which melee hostiles can reach it at all.
        return lines.invalidate();
      }
      if (affectsProjection(parent) || lines.tracksCompulsion(parent?.uuid)) lines.invalidateGrades();
    },
    onUpdateScene(scene, changes = {}) {
      if (lines.running() && terrainGridChanged(changes, SYSTEM_ID)) lines.invalidate();
    }
  });
}

const TOKEN_GEOMETRY_KEYS = Object.freeze(['x', 'y', 'width', 'height', 'hidden', 'elevation']);
const FLIGHT_PATHS = Object.freeze(['system.statuses.grounded', 'system.combat.levitation', 'system.unitType.flying']);
const REACH_PATHS = Object.freeze([
  'system.stats.mov', 'system.stats.rng',
  `flags.${SYSTEM_ID}.${UNIT_MOVE_SCALING_FLAG}`, `flags.${SYSTEM_ID}.${UNIT_FREE_TARGETING_FLAG}`
]);
const GUARD_BOND_KEYS = Object.freeze([GUARD_BOND_FLAGS.GUARDER, `-=${GUARD_BOND_FLAGS.GUARDER}`]);

/** Whether a Token write formed or broke a Guard bond, which moves who a taunt is delivered to. */
function guardBondChanged(changes) {
  const flags = changes?.flags?.[SYSTEM_ID];
  if (!flags || typeof flags !== 'object') return false;
  return GUARD_BOND_KEYS.some(key => key in flags);
}

/** Whether an Actor write touched an aura value, which Foundry's diff reports under the stat it moved. */
function hasAuraChange(changes) {
  const stats = changes?.system?.stats;
  if (!stats || typeof stats !== 'object') return false;
  return Object.values(stats).some(node => node && typeof node === 'object' && 'aura' in node);
}

/* -------------------------------------------- */
/*  Change detection                            */
/* -------------------------------------------- */

/**
 * Whether an Actor write can change which auras reach a unit or which squares apply to it. Faction decides who an
 * aura can reach, and terrain exceptions match on name, faction and unit type. Flight decides whether the unit is
 * on the ground at all, so a landing has to apply the square it came down on.
 */
function unitFactsChanged(changes) {
  if (changes?.name !== undefined) return true;
  const system = changes?.system ?? {};
  return system.faction?.role !== undefined
    || changes['system.faction.role'] !== undefined
    || system.statuses?.grounded !== undefined
    || changes['system.statuses.grounded'] !== undefined
    || system.unitType !== undefined;
}

/**
 * Whether an Item write changed what its unit has in hand: an equip flag flipped, or gear already in a slot, or the
 * Class, was edited. A created or deleted Item carries no diff and counts when it is a Class or came or went equipped.
 */
function gearItemChanged(item, changes) {
  const inHand = item?.type === 'Class' || EQUIP_FLAGS.some(flag => item?.system?.[flag] === true);
  if (!changes || typeof changes !== 'object') return inHand;
  if (EQUIP_FLAGS.some(flag => touches(changes, `system.${flag}`))) return true;
  return inHand && GEAR_ITEM_PATHS.some(path => touches(changes, path));
}

/** Whether a document diff reaches a path, nested or as one dotted key. */
function touches(changes, path) {
  if (Object.hasOwn(changes, path)) return true;
  let node = changes;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

/**
 * Whether a Scene is being played on: the active one, one an encounter or exploration runs on, or the one the host
 * has drawn, which onCanvasReadyModifiers checks as well. Any other Scene is checked when it is drawn.
 */
function sceneInPlay(scene) {
  return scene === globalThis.game?.scenes?.active || scene?.active === true || sceneCombatActive(scene)
    || sceneExplorationActive(scene) || scene === globalThis.canvas?.scene;
}

/** Whether a map restricts flight or mounts, the only kind of map the permission sweep checks. */
function restrictsMovement(scene) {
  const permission = normalizeMovementPermission(scene.getFlag(SYSTEM_ID, MOVEMENT_PERMISSION_FLAG));
  return permission !== MOVEMENT_PERMISSIONS.ALLOWED;
}

/** The Actor a document belongs to: itself, the Actor owning an Item or ActiveEffect, or an Item's owner above that. */
function owningActor(document) {
  let current = document;
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (current.documentName === 'Actor') return current;
    current = current.parent;
  }
  return null;
}

/** Every Scene an Actor stands on: its own Token's for a synthetic Actor, each dependent Token's for a world one. */
function actorScenes(actor) {
  if (actor?.documentName !== 'Actor') return [];
  const tokens = actor.isToken ? [actor.token] : collectionValues(actor.getDependentTokens({ concreteOnly: true }));
  return uniqueScenes(tokens.map(token => token?.parent));
}

/** The Scenes in play when the world opens: the active one, and every one an encounter or exploration runs on. */
function scenesInPlay() {
  const scenes = [globalThis.game?.scenes?.active];
  for (const combat of collectionValues(globalThis.game?.combats)) scenes.push(combat?.scene);
  for (const scene of collectionValues(globalThis.game?.scenes)) {
    if (sceneExplorationActive(scene)) scenes.push(scene);
  }
  return uniqueScenes(scenes);
}

function uniqueScenes(scenes) {
  const unique = new Map();
  for (const scene of scenes) {
    if (scene?.uuid) unique.set(String(scene.uuid), scene);
  }
  return [...unique.values()];
}
