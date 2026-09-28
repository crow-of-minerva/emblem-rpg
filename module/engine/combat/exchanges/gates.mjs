/** @layer engine/combat/exchanges */
import { RESULT_CODES, refuse } from '../../../contracts/results.mjs';
import { StaleCombatError } from '../../recovery/errors.mjs';
import { planForcedLanding } from '../../../game/movement/input-policy.mjs';
import { standsOverObstacle } from '../../../game/movement/pathfinding.mjs';

/** Why an exchange refused when the host cannot test the walls of the Scene it is fought on. */
const SCENE_GEOMETRY_UNAVAILABLE = 'combat.scene-geometry-unavailable';

/** Refuse an exchange whose fresh projection no longer satisfies the preview it was confirmed from. */
export function validateSnapshot(snapshot, intent, userId) {
  if (!snapshot) return refuse(RESULT_CODES.COMBAT_EXCHANGE_UNAVAILABLE);
  if (snapshot.explorationActive === true) return refuse(RESULT_CODES.ITEM_ACTIVATION_EXPLORATION_FORBIDDEN);
  if (snapshot.sceneGeometryAvailable === false) {
    return refuse(RESULT_CODES.COMBAT_EXCHANGE_UNAVAILABLE, { reasonCode: SCENE_GEOMETRY_UNAVAILABLE });
  }
  if (intent.previewFingerprint && intent.previewFingerprint !== snapshot.fingerprint) {
    return refuse(RESULT_CODES.COMBAT_EXCHANGE_STALE);
  }
  if (snapshot.sourceRequirementsMet === false) {
    return refuse(snapshot.sourceRequirementCode || RESULT_CODES.COMBAT_EXCHANGE_UNAVAILABLE, {
      requirementNames: [...(snapshot.sourceRequirementNames ?? [])]
    });
  }
  if (snapshot.lineOfSightBlocked || !snapshot.sourceInRange
    || !snapshot.targetFactionValid || !snapshot.targetEligibilityValid
    || !snapshot.targetAlive || !snapshot.sourceItemWielded
    || !snapshot.sourceItemUsable || !snapshot.sourceMagicAvailable || !snapshot.sourceWeaponArtValid
    || !snapshot.sourceStandardAvailable) {
    return refuse(RESULT_CODES.COMBAT_EXCHANGE_UNAVAILABLE);
  }
  const landing = planForcedLanding({
    grounds: snapshot.source.groundOnArmamentUse === true, landingBlocked: standsOverObstacle(snapshot.movement)
  });
  if (!landing.ok) return refuse(landing.code);
  if (!snapshot.sourceOwnsMovementPlan || snapshot.movement.movementControllerId !== userId) {
    return refuse(RESULT_CODES.MOVEMENT_PLAN_REQUIRED);
  }
  return null;
}

/**
 * Project the exchange again once its modifier chances are drawn. A refusal now means the board changed
 * (StaleCombatError), not that the preview no longer matches.
 */
export async function requireOpeningExchangeSnapshot(combatState, intent, userId) {
  const snapshot = await combatState.getSnapshot({ ...intent, previewFingerprint: '' });
  if (validateSnapshot(snapshot, { ...intent, previewFingerprint: '' }, userId)) throw new StaleCombatError();
  return snapshot;
}

/** Project the exchange again between blows. The source must still hold its plan, action and Item. */
export async function requireActiveExchangeSnapshot(combatState, intent, userId) {
  const snapshot = await combatState.getSnapshot({ ...intent, previewFingerprint: '' });
  if (!snapshot) throw new StaleCombatError();
  if (!snapshot.sourceItemWielded
    || !snapshot.sourceItemUsable || !snapshot.sourceMagicAvailable || !snapshot.sourceWeaponArtValid
    || !snapshot.sourceStandardAvailable
    || !snapshot.sourceOwnsMovementPlan || snapshot.movement.movementControllerId !== userId) {
    throw new StaleCombatError();
  }
  return snapshot;
}

/** Project the exchange again for settlement. A defeated side is fine here, but a vanished one is not. */
export async function requireSettlementSnapshot(combatState, intent) {
  const snapshot = await combatState.getSnapshot({ ...intent, previewFingerprint: '' });
  if (!snapshot) throw new StaleCombatError();
  return snapshot;
}

