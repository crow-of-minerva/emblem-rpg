/** @layer foundry/patches */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { projectEncounterSceneLock } from '../adapters/projections/encounters.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

const SCENE_VIEW_TARGET = 'foundry.documents.Scene.prototype.view';

/* -------------------------------------------- */
/*  Encounter Scene lock                        */
/* -------------------------------------------- */

/**
 * Wrap Scene.view to keep clients on the running encounter's Scene. Views of other Scenes and GM activation changes
 * are refused, and joining clients are moved to the encounter. Pausing or ending the encounter releases the lock.
 * @param {{notify?: Function, defer?: Function, mark?: Function}} [ports] The notice a refused change shows, how a
 *   move waits for the hook that raised it to return, and how the lock is announced to this client's interface.
 * @returns {Readonly<object>} `install` and the handlers the hook catalogue routes here.
 */
export function createEncounterSceneLock({ notify = null, defer = task => setTimeout(task, 0), mark = null } = {}) {
  let arriving = '';

  const refuse = lock => notify?.(`Pause the encounter on ${lock.sceneName || 'its Scene'} before changing Scenes.`);

  /** Draw the encounter's Scene once, however many hooks ask for it before that draw finishes. */
  const moveTo = lock => {
    const scene = game.scenes.get(lock.sceneId) ?? null;
    if (!scene || arriving === lock.sceneId) return Promise.resolve(scene);
    arriving = lock.sceneId;
    return Promise.resolve()
      .then(() => scene.view())
      .catch(error => {
        reportFoundryError(import.meta.url, error, 'Emblem RPG | Moving to the encounter Scene failed');
        return scene;
      })
      .finally(() => {
        if (arriving === lock.sceneId) arriving = '';
      });
  };

  /** Refuse a view of any other Scene while an encounter runs, and take a client standing elsewhere to it. */
  function guardView(wrapped, ...args) {
    const lock = projectEncounterSceneLock();
    if (!lock || String(this.id ?? '') === lock.sceneId) return wrapped(...args);
    const shown = globalThis.canvas?.scene ?? null;
    if (shown) refuse(lock);
    if (String(shown?.id ?? '') === lock.sceneId) return Promise.resolve(shown);
    return moveTo(lock);
  }

  /** Schedule the encounter Scene after the current hook, then refresh navigation to show which Scenes are locked. */
  function enforce() {
    const lock = projectEncounterSceneLock();
    mark?.(Boolean(lock));
    const canvas = globalThis.canvas;
    if (!lock || canvas?.ready !== true || canvas.loading || String(canvas.scene?.id ?? '') === lock.sceneId) {
      return false;
    }
    defer(() => {
      const current = projectEncounterSceneLock();
      if (current && String(globalThis.canvas?.scene?.id ?? '') !== current.sceneId) void moveTo(current);
    });
    return true;
  }

  return Object.freeze({
    /** Wrap Scene viewing, returning whether libWrapper was present to do it. */
    install() {
      if (!globalThis.libWrapper) {
        reportFoundryError(import.meta.url, null,
          'Emblem RPG | libWrapper is required for the encounter Scene lock.');
        return false;
      }
      globalThis.libWrapper.register(SYSTEM_ID, SCENE_VIEW_TARGET, guardView, 'MIXED');
      return true;
    },

    /** A GM's activation of another Scene, or deactivation of the encounter's own, is refused before it is written. */
    onPreUpdateScene(scene, changed) {
      if (!Object.hasOwn(changed, 'active')) return undefined;
      const lock = projectEncounterSceneLock();
      if (!lock) return undefined;
      const own = String(scene.id ?? '') === lock.sceneId;
      if (changed.active === true ? own : !own) return undefined;
      refuse(lock);
      return false;
    },

    /** A client that drew another Scene while an encounter runs, after joining or reconnecting, is taken back. */
    onCanvasReady: () => enforce(),

    /** An encounter that starts or resumes brings every client standing elsewhere to its Scene. */
    onEncounterChanged: () => enforce()
  });
}
