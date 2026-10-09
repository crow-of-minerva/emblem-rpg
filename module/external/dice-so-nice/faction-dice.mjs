/** @layer external/dice-so-nice */
import { FACTION_BAR_COLORS } from '../barbrawl/resource-bars.mjs';
import { enforceDiceSoNiceInactiveTabSkip } from './preferences.mjs';

/* -------------------------------------------- */
/*  Faction appearances                         */
/* -------------------------------------------- */
const FACTION_DICE_APPEARANCE = Object.freeze(Object.fromEntries(
  Object.entries(FACTION_BAR_COLORS).map(([type, colors]) => [type, Object.freeze({
    colorset: 'custom',
    foreground: '#FFFFFF',
    background: colors.maxcolor,
    outline: 'none',
    edge: colors.maxcolor,
    texture: 'none',
    material: 'plastic',
    font: 'Modesto Condensed',
    system: 'standard'
  })])
));

/* -------------------------------------------- */
/*  Dice So Nice hook                           */
/* -------------------------------------------- */
/**
 * Handle Dice So Nice's diceSoNiceRollStart hook (init/hooks.mjs): color every die by the faction of the unit that
 * rolled, and set the hidden-tab preference again (enforceDiceSoNiceInactiveTabSkip).
 */
export function onDiceSoNiceRollStart(messageId, context) {
  void enforceDiceSoNiceInactiveTabSkip();
  const roll = context?.dsnRoll ?? context?.roll;
  if (!roll?.dice?.length) return;
  const message = messageId ? game.messages.get(messageId) : null;
  const actor = ChatMessage.getSpeakerActor(message?.speaker);
  if (!actor) return;
  const faction = String(actor.system?.faction?.role ?? '').toLowerCase();
  const appearance = FACTION_DICE_APPEARANCE[faction];
  if (!appearance) return;
  for (const die of roll.dice) die.options.appearance = structuredClone(appearance);
}
