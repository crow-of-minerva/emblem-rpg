/** @layer game/character */
import { RESULT_CODES } from '../../contracts/results.mjs';
import { unitTurnComplete } from '../combat/phases.mjs';

/* -------------------------------------------- */
/*  Counterattack mode                          */
/* -------------------------------------------- */

/**
 * Whether a player is locked out of changing a unit's counterattack setting: during a started encounter, once the
 * unit's turn is used up (unitTurnComplete in game/combat/phases.mjs). A GM is never locked out. During the other
 * faction's phase every unit outside it counts as used up, because starting a phase marks their turns inactive. The
 * BG3 HUD greys out its toggle on it, and planPacifistChange refuses on it.
 * @param {{gm?: boolean, encounterActive?: boolean, turn?: object}} facts Whether the requester is a GM, whether an
 *   encounter has started, and the unit's turn state.
 * @returns {boolean}
 */
export function counterModeLocked({ gm, encounterActive, turn } = {}) {
  return gm !== true && encounterActive === true && unitTurnComplete(turn);
}

/**
 * Plan a counterattack mode change for setPacifist in engine/character/commands.mjs. Asking for the mode the unit
 * already holds changes nothing and is never refused; only a real change while counterModeLocked holds is.
 * @param {object} facts `gm`, `encounterActive` and `turn` as counterModeLocked reads them, the unit's `current`
 *   mode and the `requested` one, each true for a unit that never counterattacks.
 * @returns {{ok: true, changed: boolean}|{ok: false, code: string}}
 */
export function planPacifistChange({ gm, encounterActive, turn, current, requested } = {}) {
  const changed = (requested === true) !== (current === true);
  if (changed && counterModeLocked({ gm, encounterActive, turn })) {
    return { ok: false, code: RESULT_CODES.PACIFIST_LOCKED };
  }
  return { ok: true, changed };
}
