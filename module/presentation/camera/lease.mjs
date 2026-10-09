/** @layer presentation/camera */

/**
 * Who may move this client's camera. `CombatCinematicPresentation` holds the lease for a whole cinematic or phase
 * camera sequence, from its first pan until its letterbox closes or its overview hands the zoom back, and
 * `UnitCameraPresentation` does not follow a walking unit while any hold is out. `init/system.mjs` builds one lease
 * and hands it to both.
 */
export class CameraLease {
  #holds = new Set();

  /** Whether any camera sequence holds the camera now. */
  get held() {
    return this.#holds.size > 0;
  }

  /**
   * Take the camera for one sequence.
   * @returns {() => void} Gives this hold back. Calling it again does nothing.
   */
  acquire() {
    const hold = Symbol('camera hold');
    this.#holds.add(hold);
    return () => {
      this.#holds.delete(hold);
    };
  }
}
