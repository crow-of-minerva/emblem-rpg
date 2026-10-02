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
}
