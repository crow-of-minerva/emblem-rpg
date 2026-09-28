/** @layer game/character */
import { RESULT_CODES } from '../../contracts/results.mjs';
import { unitTurnComplete } from '../combat/phases.mjs';

/* -------------------------------------------- */
/*  Counterattack mode                          */
/* -------------------------------------------- */

/**
 * Whether a unit's counterattack mode is frozen for the requester: a non-GM, while a started encounter runs, once
 * the unit's turn is spent (unitTurnComplete in game/combat/phases.mjs). The opposing faction's whole phase counts
 * as spent, since opening a phase writes an inactive turn to every unit outside it. projectBg3HudView in
 * external/bg3-hud/document-projection.mjs reads it to leave the HUD toggle unclickable, and planPacifistChange
 * refuses on it.
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
