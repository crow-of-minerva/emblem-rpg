/** @layer foundry/patches */
import { installWrapperGroup } from '../../external/host.mjs';

/* -------------------------------------------- */
/*  Combat tracker renders on related updates   */
/* -------------------------------------------- */
const ROSTER_RENDER_GROUP = 'roster-render';
const RELATED_UPDATE_TARGET = 'CONFIG.Token.documentClass.prototype._onRelatedUpdate';

/**
 * Stop core re-rendering the combat tracker for Actor writes no roster row reads. TokenDocument#_onRelatedUpdate
 * calls ui.combat.render() for every write to a combatant's Actor, so picking a unit up re-rendered the whole roster.
 * init/hooks.mjs passes the relevance rule (game/combat/phases.mjs) and the render hold (the combat tracker).
 * @param {{affectsRoster: Function, holdRender: Function}} options
 */
export function installRosterRenderGate({ affectsRoster, holdRender }) {
  installWrapperGroup({
    id: ROSTER_RENDER_GROUP,
    required: false,
    wrappers: [{
      target: RELATED_UPDATE_TARGET,
      fn: function (wrapped, update = {}, ...args) {
        const updates = Array.isArray(update) ? update : [update];
        if (updates.some(change => affectsRoster(change))) return wrapped(update, ...args);
        return holdRender(() => wrapped(update, ...args));
      },
      type: 'WRAPPER'
    }]
  });
}
