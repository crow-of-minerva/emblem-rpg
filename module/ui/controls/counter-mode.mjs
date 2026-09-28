/** @layer ui/controls */
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Counterattack mode                          */
/* -------------------------------------------- */

/**
 * Send a press on the BG3 HUD's swords and dove pair to the host. buildCounterModePair in
 * presentation/interface/bg3-hud.mjs emits the `counter-mode` action, and onBg3HudAction in init/hooks.mjs passes
 * the HUD unit's uuid here, which names a Token's synthetic Actor for an unlinked unit. The host's
 * `character.counter.set-pacifist` rechecks ownership and the after-turn lock, the facade shows its result, and the
 * HUD redraws the pair from the written `system.pacifist`.
 * @param {{actorUuid: string, pacifist: boolean}} intent The unit, and whether it should stop counterattacking.
 * @returns {Promise<object|null>} The command result, or null when the call threw.
 */
export async function setCounterMode({ actorUuid, pacifist }) {
  try {
    return await game.emblemRpg.api.character.setPacifist({ actorUuid, pacifist });
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'setCounterMode');
    return null;
  }
}
