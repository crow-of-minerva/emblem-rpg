/** @layer foundry/documents */
import { admitNativeWrite } from '../adapters/services/authority.mjs';

/* -------------------------------------------- */
/*  Active Effect document                      */
/* -------------------------------------------- */

/**
 * The system's ActiveEffect class (CONFIG.ActiveEffect.documentClass, set in init/registrations.mjs). Every native
 * create, update and delete passes admitNativeWrite (services/authority.mjs) first. GMs, Assistant GMs and Trusted
 * owners may edit effects directly; a player's changes go through the host.
 */
export class EmblemActiveEffect extends ActiveEffect {
  async _preCreate(data, options, user) {
    if (!admitNativeWrite(user, this, 'create')) return false;
    return super._preCreate(data, options, user);
  }

  async _preUpdate(changed, options, user) {
    if (!admitNativeWrite(user, this, 'update', changed)) return false;
    return super._preUpdate(changed, options, user);
  }

  async _preDelete(options, user) {
    if (!admitNativeWrite(user, this, 'delete')) return false;
    return super._preDelete(options, user);
  }

  /**
   * After effects are deleted, on every client, change back any faction change tied to them (`factionLinks`, set in
   * init/system.mjs to the handlers in foundry/hooks/faction-links.mjs). Foundry awaits this before the deleting
   * client's delete call returns, which a revert inside the running command relies on.
   */
  static async _onDeleteOperation(documents, operation, user) {
    await super._onDeleteOperation(documents, operation, user);
    await this.factionLinks?.onEffectsDeleted(documents, operation, user);
  }
}
