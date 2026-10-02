/** @layer foundry/hooks */
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { isCoinpurseItem } from '../../game/economy/coinpurse.mjs';
import { isInboundItem } from '../../game/economy/inbound.mjs';
import { isActiveGm as isCurrentCoordinator } from '../adapters/services/host.mjs';

/* -------------------------------------------- */
/*  Coinpurse arrival                           */
/* -------------------------------------------- */

/**
 * On the host client, merge a Coinpurse added to an Actor so each actor keeps its gold in one purse. A purse sent
 * inbound to a Convoy isn't the Convoy's gold yet, so it waits until the GM delivers it.
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
