/** @layer ui/controls */
const GEOMETRY = Object.freeze(['x', 'y', 'width', 'height', 'elevation', 'hidden']);

/**
 * Batch token geometry changes on the viewed Scene into one overlay refresh per animation frame. installSystemHooks
 * in init/hooks.mjs builds it, calls `invalidate` from createToken, updateToken and deleteToken, and calls `cancel`
 * on canvasTearDown. Its `refresh` redraws the movement, targeting and interaction overlays. That work is
 * asynchronous, so it gets a `current()` check and must drop its results once a later change or a Scene switch
 * has made them stale.
 */
export function createOverlayRefresh({ sceneUuid, refresh, report,
  frame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) }) {
  let pending = null;
  let pendingScene = '';
  let version = 0;
  const changed = new Set();
  const cancel = () => {
    version += 1;
    if (pending !== null) cancelFrame(pending);
    pending = null;
    changed.clear();
  };
  return Object.freeze({ cancel, invalidate(token, changes = null) {
    const scene = token?.parent?.uuid;
    if (!scene || scene !== sceneUuid() || (changes && !GEOMETRY.some(key => Object.hasOwn(changes, key)))) return false;
    if (pending !== null && pendingScene !== scene) cancel();
    version += 1;
    changed.add(String(token.uuid));
    if (pending !== null) return true;
    pendingScene = scene;
    pending = frame(async () => {
      pending = null;
      const readVersion = version;
      const facts = { sceneUuid: scene, tokenUuids: [...changed].sort() };
      changed.clear();
      const current = () => version === readVersion && sceneUuid() === scene;
      if (!current()) return;
      try { await refresh(facts, current); }
      catch (error) { report(error); }
    });
    return true;
  } });
}
