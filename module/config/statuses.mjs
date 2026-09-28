/** @layer config */
import { SYSTEM_ID } from '../contracts/protocol.mjs';
import { ACTOR_TYPES } from './constants.mjs';
import { STANCE_BREAK_EFFECT_NAME, STANCE_BREAK_STATUS_ID } from '../contracts/domains/damage.mjs';
import { ENCOUNTER_DECAY_FLAGS, GUARD_BOND_EFFECT_NAME } from '../contracts/domains/combat.mjs';
import {
  BLEEDING_STATUS_ID, REGISTERED_STATUS_KEYS as CONTRACT_STATUS_KEYS
} from '../contracts/domains/characters.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

/**
 * Folder every status icon is read from.
 * @type {string}
 */
const IMG = `systems/${SYSTEM_ID}/assets/status/`;

/**
 * Most stacks of Bleeding a unit can carry. Further applications are absorbed rather than stacking past it.
 * @type {number}
 */
const BLEEDING_STACK_LIMIT = 5;

/* -------------------------------------------- */
/*  Mechanical effects                          */
/* -------------------------------------------- */
/**
 * The Stance Break effect. document-writes/stances.mjs creates it when a stance breaks and compares existing break
 * effects with it. Its stat losses go in the `penalty` keys rather than `mod`, so the character sheet shows them as
 * penalties.
 */
export const STANCE_BREAK_EFFECT_DATA = Object.freeze({
  name: STANCE_BREAK_EFFECT_NAME,
  img: `${IMG}stance-broken.png`,
  changes: Object.freeze([
    effectChange('system.stats.hpMax.mod', 4),
    effectChange('system.stats.mgt.penalty', -4),
    effectChange('system.stats.agi.penalty', -4),
    effectChange('system.stats.tqn.penalty', -4),
    effectChange('system.stats.wit.penalty', -4),
    effectChange('system.stats.cha.penalty', -4)
  ]),
  statuses: Object.freeze([STANCE_BREAK_STATUS_ID]),
  flags: Object.freeze({ core: Object.freeze({ statusId: STANCE_BREAK_STATUS_ID }) })
});

/**
 * The Guarded effect that document-writes/tokens.mjs puts on both units of a Guard bond. The writer adds each
 * unit's role, partner and description.
 */
export const GUARD_BOND_EFFECT_DATA = Object.freeze({
  name: GUARD_BOND_EFFECT_NAME,
  img: `${IMG}Protected.png`,
  statuses: Object.freeze([GUARD_BOND_EFFECT_NAME]),
  flags: Object.freeze({ core: Object.freeze({ statusId: GUARD_BOND_EFFECT_NAME }) })
});

/**
 * The two markers that stand in for flight, which has no effect of its own to draw.
 * @enum {{id: string, img: string}}
 */
export const FLIGHT_STATUS_MARKERS = Object.freeze({
  airborne: Object.freeze({ id: 'Flying', img: `${IMG}Flying.png` }),
  grounded: Object.freeze({ id: 'Grounded', img: `${IMG}Grounded.png` })
});

/* -------------------------------------------- */
/*  Status Registry                             */
/* -------------------------------------------- */

/**
 * Every registered status: its label, icon, description and rule flags, keyed like `system.statuses`. The effect
 * editor lists them, document-writes/effect-execution.mjs writes them as ActiveEffects, game/effects/statuses.mjs
 * reads their flags, and tokenHudStatusEffects below builds the Token HUD palette from them.
 * @enum {object}
 */
export const STATUS_EFFECTS = Object.freeze({
  // protected: {
  //   label: 'Protected',
  //   id: 'Protected',
  //   img: `${IMG}Protected.png`,
  //   beneficial: true,
  //   description: 'Shielded from harm by an outside force.'
  // },
  // lastStand: {
  //   label: 'Last Stand',
  //   id: 'LastStand',
  //   img: `${IMG}LastStand.png`,
  //   beneficial: true,
  //   description: 'Cannot be reduced below 1 HP, so a killing blow leaves this unit standing.'
  // },
  blessed: {
    label: 'Blessed',
    id: 'Blessed',
    img: `${IMG}Blessed.png`,
    beneficial: true,
    description: 'Adds 1d4 to its attack rolls, skill checks and saving throws'
  },
  sanctuary: {
    label: 'Sanctuary',
    id: 'Sanctuary',
    img: `${IMG}Sanctuary.png`,
    beneficial: true,
    description: 'Cannot be targeted by hostile actions, and cannot make them'
  },
  // mageArmor: {
  //   label: 'Mage Armor',
  //   id: 'MageArmor',
  //   img: `${IMG}MageArmor.png`,
  //   beneficial: true,
  //   description: 'Warded by arcane armor.'
  // },
  truestrike: {
    label: 'Truestrike',
    id: 'Truestrike',
    img: `${IMG}Truestrike.png`,
    beneficial: true,
    description: 'Its attack rolls gain Advantage'
  },
  sneak: {
    label: 'Sneak',
    id: 'Sneak',
    img: `${IMG}Sneak.png`,
    beneficial: true,
    description: 'Enemies attack it only when they cannot attack anyone else'
  },
  charged: {
    label: 'Charged',
    id: 'Charged',
    img: `${IMG}Charged.png`,
    beneficial: true,
    duration: 2,
    flags: { removeOnStanceBreak: true },
    description: 'Only matters to items that check for it, and is lost if the stance breaks'
  },
  // drunk: {
  //   label: 'Drunk',
  //   id: 'Drunk',
  //   img: `${IMG}Drunk.png`,
  //   beneficial: true,
  //   description: '-3 Acc, +4 Spd, +4 Atk.',
  //   extraChanges: [
  //     { key: 'system.stats.acc.mod', type: 'add', value: -3, priority: 20 },
  //     { key: 'system.stats.spd.mod', type: 'add', value: 4,  priority: 20 },
  //     { key: 'system.stats.atk.mod', type: 'add', value: 4,  priority: 20 }
  //   ]
  // },
  // devourTheLiving: {
  //   label: 'Devour the Living',
  //   id: 'DevourTheLiving',
  //   img: `${IMG}DevourTheLiving.png`,
  //   beneficial: true,
  //   description: 'Feeding on the fallen. A counter, not a toggle, so each application adds one.',
  //   changes: [
  //     { key: 'system.statuses.devourTheLiving', type: 'add', value: 1, priority: 20 }
  //   ]
  // },

  shine: {
    label: 'Shine',
    id: 'Shine',
    img: `${IMG}Shine.png`,
    harmful: true,
    duration: 2,
    flags: { removeWhenAttacked: true },
    description: 'The next single attack roll against this unit gains Advantage'
  },
  /** A Mark ends with the phase it was applied in, whichever side's phase that is, not with its bearer's own. */
  marked: {
    label: 'Marked',
    id: 'Marked',
    img: `${IMG}Marked.png`,
    harmful: true,
    flags: { [ENCOUNTER_DECAY_FLAGS.PHASE_END]: false, [ENCOUNTER_DECAY_FLAGS.ANY_PHASE_END]: true },
    description: 'The marking unit\'s allies gain bonuses against it'
  },
  taunted: {
    label: 'Taunted',
    id: 'Taunted',
    img: `${IMG}Taunted.png`,
    harmful: true,
    description: 'Forced to act against the taunter on its next turn'
  },
  flanked: {
    label: 'Flanked',
    id: 'Flanked',
    img: `${IMG}Flanked.png`,
    harmful: true,
    description: 'Melee attacks against it gain Advantage, and its own suffer Disadvantage'
  },
  unbalanced: {
    label: 'Unbalanced',
    id: 'Unbalanced',
    img: `${IMG}Unbalanced.png`,
    harmful: true,
    description: 'Loses the Agility half of its Evasion'
  },
  restrained: {
    label: 'Restrained',
    id: 'Restrained',
    img: `${IMG}Restrained.png`,
    harmful: true,
    description: 'Cannot move',
    extraChanges: [
      { key: 'system.stats.mov.mod', type: 'add', value: -999, priority: 20 }
    ]
  },
  // web: {
  //   label: 'Web',
  //   id: 'Web',
  //   img: `${IMG}Web.png`,
  //   harmful: true,
  //   description: 'Snared in webbing.'
  // },
  frozen: {
    label: 'Frozen',
    id: 'Frozen',
    img: `${IMG}Frozen.png`,
    harmful: true,
    description: 'Loses its entire turn',
    extraChanges: [
      {
          "key": "system.flags.isTurnOver",
          "value": true,
          "priority": 99,
          "type": "override"
        },
        {
          "key": "system.turn.actionAvailable",
          "value": false,
          "priority": 99,
          "type": "override"
        },
        {
          "key": "system.turn.bonusActionAvailable",
          "value": false,
          "priority": 99,
          "type": "override"
        },
        {
          "key": "system.turn.movementAvailable",
          "value": false,
          "priority": 99,
          "type": "override"
        },
        {
          "key": "system.combat.cannotCounter",
          "value": true,
          "priority": 99,
          "type": "override"
        }
    ]
  },
  stunned: {
    label: 'Stunned',
    id: 'Stunned',
    img: `${IMG}Stasis.png`,
    harmful: true,
    description: 'Cannot act on its turn',
    extraChanges: [
    {
        "key": "system.flags.isTurnOver",
        "value": true,
        "priority": 99,
        "type": "override"
      },
      {
        "key": "system.turn.actionAvailable",
        "value": false,
        "priority": 99,
        "type": "override"
      },
      {
        "key": "system.turn.bonusActionAvailable",
        "value": false,
        "priority": 99,
        "type": "override"
      },
      {
        "key": "system.turn.movementAvailable",
        "value": false,
        "priority": 99,
        "type": "override"
      },
      {
        "key": "system.combat.cannotCounter",
        "value": true,
        "priority": 99,
        "type": "override"
      }
    ]
  },
  /**
   * Fear takes both actions and leaves movement alone: a feared player unit still moves, and is expected to flee
   * with it, while the Enemy AI drives its own feared units into a retreat.
   */
  fear: {
    label: 'Fear',
    id: 'Fear',
    img: `${IMG}Fear.png`,
    harmful: true,
    description: '-4 Tqn. Cannot take a Standard or Bonus Action, but may still move and should flee',
    extraChanges: [
      { key: 'system.stats.tqn.penalty',         type: 'add',      value: -4,    priority: 20 },
      { key: 'system.turn.actionAvailable',      type: 'override', value: false, priority: 99 },
      { key: 'system.turn.bonusActionAvailable', type: 'override', value: false, priority: 99 }
    ]
  },
  // berserk: {
  //   label: 'Berserk',
  //   id: 'Berserk',
  //   img: `${IMG}Berserk.png`,
  //   harmful: true,
  //   description: 'Lost to rage.'
  // },
  // dominated: {
  //   label: 'Dominated',
  //   id: 'Dominated',
  //   img: `${IMG}Confused.png`,
  //   harmful: true,
  //   description: 'Acting under another\'s will.'
  // },
  // bane: {
  //   label: 'Bane',
  //   id: 'Bane',
  //   img: `${IMG}Bane.png`,
  //   harmful: true,
  //   description: 'Cursed, so rolls this unit makes are hexed.'
  // },
  bleeding: {
    label: 'Bleeding',
    id: BLEEDING_STATUS_ID,
    img: `${IMG}Bleeding.png`,
    harmful: true,
    flags: { stackable: true, stackCount: 1, stackLimit: BLEEDING_STACK_LIMIT, removeOnFactionPhaseEnd: false },
    description: 'Each stack inflicts 1d4 unpreventable damage at the start of its faction phase, then one stack fades'
  },
  poisoned: {
    label: 'Poisoned',
    id: 'Poisoned',
    img: `${IMG}Poisoned.png`,
    harmful: true,
    description: 'Takes 1d6 decay damage at the start of its faction phase. -5 Bld',
    extraChanges: [
      { key: 'system.stats.bld.penalty', type: 'add', value: -5, priority: 20 }
    ]
  },
  silenced: {
    label: 'Silenced',
    id: 'Silenced',
    img: `${IMG}Silenced.png`,
    harmful: true,
    description: 'Cannot cast magic'
  },
  blinded: {
    label: 'Blinded',
    id: 'Blinded',
    img: `${IMG}Blinded.png`,
    harmful: true,
    description: 'Disadvantage on attacks, and vision restricted to 1 Rng'
  },
  // corpseRot: {
  //   label: 'Corpse Rot',
  //   id: 'CorpseRot',
  //   img: `${IMG}CorpseRot.png`,
  //   harmful: true,
  //   flags: { dotCanKillPlayer: true },
  //   description: 'Takes 2d8 decay damage and 1 stance at the start of its faction phase.'
  // }
});

/**
 * The registered status keys, REGISTERED_STATUS_KEYS from contracts/domains/characters.mjs, in authored order.
 * That file's own STATUS_KEYS also lists the statuses that are not registered.
 * @type {readonly string[]}
 */
export const STATUS_KEYS = CONTRACT_STATUS_KEYS;

/**
 * Labels for STATUS_KEYS, suggested by the status name field in ui/apps/sheets/item/editors/effects.mjs.
 * @type {readonly string[]}
 */
export const STATUS_NAMES = Object.freeze(STATUS_KEYS.map(k => STATUS_EFFECTS[k].label));

/**
 * The statuses a Gamemaster hands out from the Token HUD, in the order the palette shows them.
 * @type {readonly string[]}
 */
const TOKEN_HUD_STATUS_KEYS = Object.freeze([
  'blessed', 'truestrike', 'charged', 'unbalanced', 'restrained', 'stunned',
  'sneak', 'fear', 'bleeding', 'poisoned', 'silenced', 'blinded'
]);

/* -------------------------------------------- */
/*  Accessors                                   */
/* -------------------------------------------- */

/**
 * Look up a STATUS_EFFECTS label for UI display, falling back to the key.
 * @param {string} key     Registry key.
 * @returns {string}
 */
export function statusLabel(key) {
  return STATUS_EFFECTS[key]?.label ?? key;
}

/**
 * Map a Foundry ActiveEffect status id back to its STATUS_EFFECTS registry key.
 * @param {string} statusId The `statuses` entry an ActiveEffect carries.
 * @returns {string|null}
 */
export function statusKeyForId(statusId) {
  const wanted = String(statusId ?? '');
  return STATUS_KEYS.find(key => STATUS_EFFECTS[key].id === wanted) ?? null;
}

/**
 * Build the Character-only CONFIG.statusEffects palette registered by init/registrations.mjs.
 * @returns {Array<{id: string, name: string, img: string, order: number, hud: {actorTypes: string[]}}>}
 */
export function tokenHudStatusEffects() {
  return TOKEN_HUD_STATUS_KEYS.map((key, order) => ({
    id: STATUS_EFFECTS[key].id,
    name: STATUS_EFFECTS[key].label,
    img: STATUS_EFFECTS[key].img,
    order,
    hud: { actorTypes: [ACTOR_TYPES.CHARACTER] }
  }));
}

function effectChange(key, value) {
  return Object.freeze({ key, type: 'add', value, priority: 20 });
}
