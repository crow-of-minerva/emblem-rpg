/** @layer engine/effects */
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import { RESULT_CODES, accept } from '../../contracts/results.mjs';
import { requirePorts } from '../../contracts/protocol.mjs';
import { createCommandAuthorization } from '../authorization.mjs';

/* -------------------------------------------- */
/*  Faction revert command                      */
/* -------------------------------------------- */

/**
 * The REVERT_LINK command definition: change a unit back after the status its faction change was tied to is deleted.
 * foundry/hooks/faction-links.mjs runs it on the host client, inside the command that deleted the status when there
 * is one, or queued as maintenance when the GM deleted the status by hand.
 * @param {object} ports
 * @param {{revert: Function}} ports.factionLinks Writes the old faction, disposition and ownership back
 *   (revertFactionLink in foundry/adapters/document-writes/effect-execution.mjs).
 * @param {object} ports.authority The permission checks behind each command's authorize.
 */
export function createFactionLinkCommandContribution({ factionLinks, authority }) {
  requirePorts('createFactionLinkCommandContribution', { factionLinks });
  return [{
    id: INTERNAL_COMMAND_IDS.CHARACTER.FACTION.REVERT_LINK,
    authorize: createCommandAuthorization(authority).activeGm(),
    handler: async context => {
      const outcome = await factionLinks.revert(context.payload ?? {}, context.operation ?? null);
      return accept(RESULT_CODES.FACTION_LINK_REVERTED, { reverted: outcome?.reverted === true });
    },
    concurrencyKeys: context => {
      const actorUuid = String(context.payload?.actorUuid ?? '');
      return actorUuid ? [`actor:${actorUuid}`] : [];
    }
  }];
}
