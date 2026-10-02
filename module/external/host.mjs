/** @layer external */
import { SYSTEM_ID } from '../contracts/protocol.mjs';
import { reportFoundryError } from '../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Module presence                             */
/* -------------------------------------------- */
/** Whether a module is installed and enabled in this world. */
export function moduleActive(id) {
  return globalThis.game?.modules?.get?.(String(id))?.active === true;
}

/* -------------------------------------------- */
/*  Wrapper groups                              */
/* -------------------------------------------- */
/**
 * Look up a dotted libWrapper target, such as a Foundry method path, on globalThis. Returns null when a segment is
 * missing or the target isn't a function, so a Foundry update that renames a private method is caught before
 * anything registers.
 */
function resolveTarget(target) {
  const segments = String(target ?? '').split('.');
  let node = globalThis;
  for (const segment of segments) {
    node = node?.[segment];
    if (node === undefined || node === null) return null;
  }
  return typeof node === 'function' ? node : null;
}

/**
 * Install a named group of libWrapper registrations, all or nothing. The Foundry patches in foundry/patches/ use
 * it. Every target is checked before anything registers, and if a registration throws, the ones already made are
 * removed. So a mechanic never runs half on Foundry's code and half on the system's. A failed required group (only
 * vision groups are required) is logged as an error rather than a warning, because a vision patch that silently
 * doesn't apply can reveal parts of the map.
 * @param {object} group The group id, whether it is required, and its `{target, fn, type}` registrations.
 * @returns {{ok: boolean, failures: string[]}}
 */
export function installWrapperGroup({ id, required = false, wrappers = [] }) {
  const failures = [];
  if (!globalThis.libWrapper) failures.push('libWrapper is not active');
  for (const { target } of wrappers) {
    if (!resolveTarget(target)) failures.push(`target is missing or not callable: ${target}`);
  }
  if (failures.length) {
    report(id, required, failures);
    return { ok: false, failures };
  }

  const registered = [];
  try {
    for (const { target, fn, type } of wrappers) {
      globalThis.libWrapper.register(SYSTEM_ID, target, fn, type);
      registered.push(target);
    }
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'installWrapperGroup');
    for (const target of registered.reverse()) globalThis.libWrapper.unregister?.(SYSTEM_ID, target);
    const failure = `registration threw: ${error?.message ?? error}`;
    report(id, required, [failure]);
    return { ok: false, failures: [failure] };
  }
  return { ok: true, failures: [] };
}

function report(id, required, failures) {
  const level = required ? 'error' : 'warn';
  console[level](`Emblem RPG | wrapper group "${id}" not installed:`, failures.join('; '));
}
