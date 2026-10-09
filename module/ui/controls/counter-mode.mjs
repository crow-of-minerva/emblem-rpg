/** @layer ui/controls */
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Counterattack mode                          */
/* -------------------------------------------- */

/**
 * Ask the host to turn this unit's counterattacks on or off (the swords and dove buttons on the BG3 HUD). For an
 * unlinked unit the uuid names the token's synthetic actor. The host rechecks ownership and the after-turn lock,
 * and the HUD redraws the buttons from the saved `system.pacifist`.
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
