/** @layer foundry/documents */
import { admitNativeWrite } from '../adapters/services/authority.mjs';

/* -------------------------------------------- */
/*  Actor delta document                        */
/* -------------------------------------------- */

/**
 * The system's ActorDelta class (set in init/registrations.mjs). An edit made through an unlinked token's actor is
 * already checked by EmblemActor, whose _preUpdate runs before Foundry sends it to the ActorDelta. This class adds
 * the check for writes made to the ActorDelta directly, and for its deletion. Every native write passes
 * admitNativeWrite (services/authority.mjs) first.
 */
export class EmblemActorDelta extends ActorDelta {
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
