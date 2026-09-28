/** @layer config */
import { SYSTEM_ID } from '../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Rally Ability                               */
/* -------------------------------------------- */

/** Rally's icon, shipped with the system beside the other Abilities it builds itself. */
export const RALLY_ABILITY_IMAGE = `systems/${SYSTEM_ID}/assets/abilities/active/Rally.png`;

/** How Rally's range grows with the caster's Cha: each threshold's Cha gives that many squares. */
export const RALLY_RANGE_SCALING = Object.freeze({
  factor: 'Stat', subject: 'cha', type: 'Threshold', multiplier: 1, formula: '', addToBase: false, roundDown: false,
  thresholds: Object.freeze([
    Object.freeze({ at: 1, uses: 1 }), Object.freeze({ at: 4, uses: 2 }), Object.freeze({ at: 6, uses: 3 }),
    Object.freeze({ at: 9, uses: 4 }), Object.freeze({ at: 14, uses: 5 })
  ])
});

/**
 * A fresh copy of the Rally Ability's data, less the name and description buildRallyAbility
 * (game/support/rally-ability.mjs) writes from the caster's affinity. Rally costs a Standard Action and has no use
 * limit; the per-unit limits live in RALLY_TARGET_LIMITS. Each call returns new objects, because Foundry stamps
 * fields onto the data it is handed.
 * @returns {object} Item creation data for an Ability.
 */
export function rallyAbilityData() {
  return {
    type: 'Ability',
    img: RALLY_ABILITY_IMAGE,
    system: {
      itemType: 'Active',
      actionType: 'Standard Action',
      uses: { current: 0, max: 0, type: 'infinite' },
      animV2: {
        attack: null,
        critical: null,
        activation: { melee: rallyCastArt(1020), ranged: rallyCastArt(1220), self: null }
      },
      effectsV2: [{
        trigger: 'onActivation',
        name: 'Rally Effect Animation',
        failedSave: null,
        itemNames: [],
        itemUuids: [],
        delayMs: 500,
        tokenAwaits: false,
        condition: null,
        action: {
          version: 2,
          steps: [{
            kind: 'animation',
            animation: {
              version: 2,
              steps: [{
                kind: 'effect', file: 'jb2a.condition.boon.01.002.blue', atLocation: 'target', perTarget: true,
                scaleToObject: 1
              }],
              duration: 1000
            }
          }]
        }
      }],
      effectData: {
        params: [],
        type: '',
        rng: '1',
        rngType: 'Multiple',
        rngShape: 'Normal',
        losRule: 'ignoreHeight',
        rngScaling: structuredClone(RALLY_RANGE_SCALING),
        targets: 6,
        targetType: 'Friendly',
        locationRng: 0,
        gridColor: 'Green',
        groundValidSquares: 'All',
        groundMaxElevDiff: 0,
        deliveryType: 'Saving Throw',
        savingThrowDC: {
          required: false, base: 0, attribute: 'None', targetAttribute: 'None', ignoreForFriendly: false
        },
        skillCheckDC: { required: false, base: 0, skill: 'None', targetAttribute: 'None', ignoreForFriendly: false },
        consumeOnFailure: true,
        groundUnoccupiedOnly: true
      }
    }
  };
}

/** The caster's cast art: a chime, a blue blessing and a soundwave, lasting `duration` milliseconds. */
function rallyCastArt(duration) {
  return {
    version: 2,
    steps: [
      { kind: 'sound', file: `systems/${SYSTEM_ID}/sound/combat/crit-flash.wav`, audioChannel: 'environment' },
      {
        kind: 'effect', file: 'animated-spell-effects-cartoon.level 01.bless.blue', atLocation: 'token',
        layer: 'aboveInterface', scaleToObject: 2, hue: -160, waitUntilFinished: 0
      },
      {
        kind: 'effect', file: 'jb2a.soundwave.01.multicolored02', atLocation: 'token', layer: 'aboveInterface',
        scaleToObject: 7
      },
      { kind: 'sound', file: 'blfx.sound.spell.spare_the_dying1.2', audioChannel: 'environment' }
    ],
    duration
  };
}
