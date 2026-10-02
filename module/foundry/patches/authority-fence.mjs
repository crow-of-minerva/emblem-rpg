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
 * Block this client's document writes if it is still running a command after it stopped being the host client.
 * Foundry and sheet edits made outside a running command are left to the document write guards (admitNativeWrite).
 * Installed from init/system.mjs at startup.
 * @param {object} options
 * @param {Function} options.executionHeld Whether this client is in the middle of running a system command.
 * @param {Function} options.isHost Whether this client is still the host client.
 * @param {Function} [options.onFenced] Told about every refused write.
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
