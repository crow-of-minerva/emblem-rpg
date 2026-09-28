/** @layer foundry/hooks */
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { isCoinpurseItem } from '../../game/economy/coinpurse.mjs';
import { isInboundItem } from '../../game/economy/inbound.mjs';
import { isActiveGm as isCurrentCoordinator } from '../adapters/services/host.mjs';

/* -------------------------------------------- */
/*  Coinpurse arrival                           */
/* -------------------------------------------- */

/**
 * Route a Coinpurse landing on an Actor into the reconciliation that keeps gold one purse per carrier. A purse
 * created inbound on a Convoy is not the Convoy's gold yet, so it waits for a staff delivery.
 */
export function createCoinpurseLifecycle({ executeInternal, notify = null }) {
  return Object.freeze({
    async onCoinpurseItemCreated(item, options = {}) {
      const actor = item?.parent;
      if (!isCurrentCoordinator() || actor?.documentName !== 'Actor' || actor.pack) return;
      if (options.emblemCoinpurseSettlement === true) return;
      if (!isCoinpurseItem({ type: item.type, itemType: item.system?.itemType }) || isInboundItem(item)) return;
      const result = await executeInternal(
        INTERNAL_COMMAND_IDS.ECONOMY.RECONCILE_COINPURSE,
        { actorUuid: String(actor.uuid) }
      );
      if (result?.ok) notify?.showResult(result);
    }
  });
}
