/** @layer game/targeting */

/* -------------------------------------------- */
/*  Sanctuary vocabulary                        */
/* -------------------------------------------- */

/** Range types that pick their units one by one. Every other shape catches whoever stands in it. */
const DIRECT_RNG_TYPES = new Set(['Single', 'Multiple']);

/** Item subtypes whose use is an attack exchange, which is always hostile and always aimed at one unit. */
const ATTACK_ITEM_SUBTYPES = new Set(['Weapon', 'Attack', 'Staff', 'Weapon Art']);

/* -------------------------------------------- */
/*  Direct targeting                            */
/* -------------------------------------------- */

/**
 * Whether Sanctuary stops an item use from picking this unit. A hostile action can't pick a Sanctuary unit: an
 * attack, or a Single or Multiple use whose target type is not Friendly. An area shape (Line, Cone, Location, Area)
 * still catches it, a Friendly use still reaches it, and a caster may still target itself. Checked on the clicking
 * client and on the host client, and behind api.combat.canUse, which is how the Enemy AI learns it can't target the
 * unit.
 * @param {{attack?: boolean, targetType?: string, rngType?: string}} aim How the use picks its targets: the
 *   activation details from deriveActivationEnvelope, or itemSanctuaryAim's reading of an item.
 * @param {string} sourceActorUuid The acting unit.
 * @param {{actorUuid?: string, sanctuary?: boolean, objectTarget?: boolean}} target One picked unit's data.
 * @returns {boolean}
 */
export function sanctuaryBlocksPick(aim = {}, sourceActorUuid = '', target = {}) {
  if (target?.sanctuary !== true || target?.objectTarget === true) return false;
  if (String(target.actorUuid ?? '') === String(sourceActorUuid ?? '')) return false;
  if (aim?.attack === true) return true;
  return String(aim?.targetType ?? 'Any') !== 'Friendly' && DIRECT_RNG_TYPES.has(String(aim?.rngType ?? 'Single'));
}

/**
 * Build the aim sanctuaryBlocksPick checks from an item's data, with the same defaults deriveActivationEnvelope
 * gives an item that authored none. Used by projectItemUsability (foundry/adapters/projections/attack-targeting.mjs).
 * @param {{system?: object}} item Plain item data.
 * @returns {{attack: boolean, targetType: string, rngType: string}}
 */
export function itemSanctuaryAim(item = {}) {
  const system = item?.system ?? {};
  return {
    attack: ATTACK_ITEM_SUBTYPES.has(String(system.itemType ?? '')),
    targetType: String(system.effectData?.targetType ?? 'Any'),
    rngType: String(system.effectData?.rngType ?? 'Single')
  };
}
