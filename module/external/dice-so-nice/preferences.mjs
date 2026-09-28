/** @layer external/dice-so-nice */
import { moduleActive } from '../host.mjs';
import { reportFoundryError } from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Enforced preferences                        */
/* -------------------------------------------- */
const MODULE_ID = 'dice-so-nice';
const SETTINGS_FLAG = 'settings';

let enforcing = null;

/**
 * Turn on Dice So Nice's skipAnimationOnInactiveTab option, so rolls made while this tab is hidden aren't animated
 * one after another when the player comes back. The option lives in the user's Dice So Nice flag. It is set on
 * ready, whenever this user's User document is updated (init/hooks.mjs), and at the start of every roll
 * (faction-dice.mjs). Overlapping calls share one write.
 * @param {object} [user] The user this client is running as.
 * @returns {Promise<boolean>} Whether a preference was written.
 */
export function enforceDiceSoNiceInactiveTabSkip(user = game.user) {
  if (enforcing) return enforcing;
  enforcing = writePreference(user).finally(() => { enforcing = null; });
  return enforcing;
}

async function writePreference(user) {
  if (!moduleActive(MODULE_ID)) return false;
  const stored = user.getFlag(MODULE_ID, SETTINGS_FLAG);
  if (stored?.skipAnimationOnInactiveTab === true) return false;
  const settings = { ...(stored && typeof stored === 'object' ? structuredClone(stored) : {}) };
  settings.skipAnimationOnInactiveTab = true;
  try {
    await user.setFlag(MODULE_ID, SETTINGS_FLAG, settings);
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'enforceDiceSoNiceInactiveTabSkip', null, false);
    return false;
  }
}
