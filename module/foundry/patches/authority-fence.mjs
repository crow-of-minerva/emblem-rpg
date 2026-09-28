/** @layer foundry/patches */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Authority fence                             */
/* -------------------------------------------- */

const FENCED_METHODS = Object.freeze([
  'foundry.data.ClientDatabaseBackend.prototype._createDocuments',
  'foundry.data.ClientDatabaseBackend.prototype._updateDocuments',
  'foundry.data.ClientDatabaseBackend.prototype._deleteDocuments'
]);

/**
 * Refuse this page's database writes while its dispatcher still holds world execution but the page is no longer the
 * command host. Native edits made outside a running command are left to the document authoring guards
 * (admitNativeWrite). Installed from init/system.mjs at startup.
 * @param {object} ports
 * @param {Function} ports.executionHeld Whether this client's dispatcher holds world execution.
 * @param {Function} ports.isHost Whether this client is still the eligible host.
 * @param {Function} [ports.onFenced] Told about every refused write.
 * @returns {boolean} Whether libWrapper was present to install the fence.
 */
export function installAuthorityFence({ executionHeld, isHost, onFenced = () => {} }) {
  if (!globalThis.libWrapper) {
    reportFoundryError(import.meta.url, null, 'Emblem RPG | libWrapper is required for the authority fence.');
    return false;
  }
  for (const target of FENCED_METHODS) {
    globalThis.libWrapper.register(SYSTEM_ID, target, function (wrapped, documentClass, operation, user) {
      if (!executionHeld() || isHost()) return wrapped(documentClass, operation, user);
      const documentName = String(documentClass?.documentName ?? 'Document');
      const error = new Error(`${documentName} write refused: this client is no longer the command host.`);
      onFenced(error, { target, documentName });
      return Promise.reject(error);
    }, 'MIXED');
  }
  return true;
}
