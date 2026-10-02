/** @layer ui/controls */

/**
 * Hold movement input while `work` runs, then turn it back on only if the same plan is still current, not handed
 * to targeting or a window, and not waiting on the host. movement.mjs wraps its short local steps in this, passing
 * a handle from movementInputHold in movement-state.mjs.
 */
export async function withPlanInputHeld(current, isCurrent, work) {
  current.inputEnabled = false;
  try { return await work(); }
  finally {
    if (isCurrent(current) && !current.suspended && !current.settling) current.inputEnabled = true;
  }
}
