/** @layer lib/dom */

/* -------------------------------------------- */
/*  Pacing clock                                */
/* -------------------------------------------- */

/** The timer loop a dedicated worker runs. A worker's timers keep time while its page is in the background. */
const WORKER_SOURCE = [
  'const timers = new Map();',
  'onmessage = event => {',
  '  const { id, ms } = event.data ?? {};',
  '  timers.set(id, setTimeout(() => { timers.delete(id); postMessage(id); }, ms));',
  '};'
].join('\n');

/**
 * The clock behind presentation delivery's `wait` (presentation/interface/delivery.mjs), which paces engine holds
 * and retries as well as presentation. Its timers run in a worker, because a hidden page throttles its own timers.
 * If the worker can't start or fails, pending and later waits move to ordinary timers, so every wait still resolves.
 * @returns {{wait: Function}}
 */
export function createPacingClock() {
  const pending = new Map();
  let worker;
  let sequence = 0;

  const fallBack = () => {
    const outstanding = [...pending.values()];
    pending.clear();
    try { worker?.terminate?.(); } catch { /* the worker is gone already */ }
    worker = null;
    for (const entry of outstanding) setTimeout(entry.resolve, Math.max(0, entry.due - Date.now()));
  };

  const timerWorker = () => {
    if (worker !== undefined) return worker;
    try { worker = createTimerWorker(); } catch { worker = null; }
    if (!worker) return null;
    worker.onmessage = event => {
      const entry = pending.get(event?.data);
      if (!entry) return;
      pending.delete(event.data);
      entry.resolve();
    };
    worker.onerror = () => fallBack();
    return worker;
  };

  return Object.freeze({
    /** Resolve once an explicit number of milliseconds has passed. */
    wait(milliseconds) {
      const ms = Math.max(0, Number(milliseconds) || 0);
      return new Promise(resolve => {
        const timer = ms > 0 ? timerWorker() : null;
        if (!timer) {
          setTimeout(resolve, ms);
          return;
        }
        const id = ++sequence;
        pending.set(id, { resolve, due: Date.now() + ms });
        try { timer.postMessage({ id, ms }); } catch { fallBack(); }
      });
    }
  });
}

/** A dedicated worker running the timer loop, or null where this page cannot start one. */
function createTimerWorker() {
  const { Worker, Blob, URL } = globalThis;
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
    return null;
  }
  return new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
}
