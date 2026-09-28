/** @layer ui/controls */

/**
 * Hold movement input while `work` runs, then reopen it only if the same plan is still current and is neither
 * suspended nor settling. movement.mjs wraps its short local steps in this (confirmPlan, stepCancelPlan and
 * resumeMovementAfterTargeting), passing a handle from movementInputHold in movement-state.mjs.
 */
export async function withPlanInputHeld(current, isCurrent, work) {
  current.inputEnabled = false;
  try { return await work(); }
  finally {
    if (isCurrent(current) && !current.suspended && !current.settling) current.inputEnabled = true;
  }
}
