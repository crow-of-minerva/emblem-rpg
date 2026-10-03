/** @layer foundry/data-models/item */
import { AURA_TARGET_TYPES, WEAPON_PROFICIENCIES } from '../../../contracts/domains/items.mjs';
import { UNIT_TYPES } from '../../../game/character/rules.mjs';
import { DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import { REQUIREMENT_TYPES } from '../../../contracts/dsl/requirements.mjs';

/* -------------------------------------------- */
/*  Item schema                                 */
/* -------------------------------------------- */
const USE_TYPES = ['limited', 'infinite', 'conditional'];
const ACTION_TYPES = ['Standard Action', 'Bonus Action'];
const REFINEMENT_TIER_COUNT = 5;
const DEFAULT_FORGE_SKILL = 'Handicraft';

/**
 * The field shapes a general Item schema is written in.
 * @returns {object} The Foundry field namespace and the builders, ready to destructure.
 */
function itemFieldShapes() {
  const F = foundry.data.fields;
  const number = (initial = 0, options = {}) => new F.NumberField({ initial, nullable: true, optional: true, ...options });
  const bool = initial => new F.BooleanField({ initial });
  const material = () => new F.SchemaField({
    uuid: new F.StringField({ initial: '' }),
    name: new F.StringField({ initial: '' }),
    img: new F.StringField({ initial: '' }),
    quantity: new F.NumberField({ initial: 1, nullable: false })
  });
  const scaling = (factor, choices = ['None', 'Level', 'Proficiency', 'Stat', 'Skill']) => new F.SchemaField({
    factor: new F.StringField({ initial: factor, choices }),
    subject: new F.StringField({ initial: '' }),
    type: new F.StringField({ initial: 'Additive', choices: ['Threshold', 'Multiple', 'Additive', 'Formula'] }),
    multiplier: number(1),
    thresholds: new F.ArrayField(new F.SchemaField({ at: number(0), uses: number(0) }), { initial: () => [] }),
    formula: new F.StringField({ initial: '' }),
    addToBase: bool(false),
    roundDown: bool(false)
  });
  // Each damage type has an on/off flag and an optional `<type>ConditionTree`: a condition that must also hold for
  // the weapon to deal that type. Code listing a weapon's damage types must test `=== true` to skip the trees.
  const damageTypeFields = Object.fromEntries(DAMAGE_TYPES.flatMap(key => [
    [key, bool(false)],
    [`${key}ConditionTree`, new F.ObjectField({ required: false, nullable: true, initial: null })]
  ]));
  const nullableTierNumber = () => new F.NumberField({ initial: null, nullable: true });
  const refinementTier = () => new F.SchemaField({
    enabled: bool(false),
    xpReq: new F.NumberField({ initial: 0, nullable: false, min: 0, integer: true }),
    forgeMult: new F.NumberField({ initial: null, nullable: true, min: 0.1 }),
    skillCheck: new F.StringField({ initial: '' }),
    materials: new F.ArrayField(material(), { initial: () => [] }),
    modifiers: new F.SchemaField({
      atk: nullableTierNumber(), brk: nullableTierNumber(), wgt: nullableTierNumber(),
      acc: nullableTierNumber(), crit: nullableTierNumber(), durability: nullableTierNumber(),
      stn: nullableTierNumber(), def: nullableTierNumber(), res: nullableTierNumber(),
      wgtRed: nullableTierNumber(), prots: booleanMap(F, DAMAGE_TYPES), dmgTypes: booleanMap(F, DAMAGE_TYPES),
      prot: new F.StringField({ initial: '' })
    })
  });
  return {
    F,
    number,
    bool,
    material,
    scaling,
    damageTypeFields,
    nullableTierNumber,
    refinementTier
  };
}

/**
 * An Item's authored effect: its parameters, its entries and the steps each entry runs.
 * @param {object} shapes   The field shapes the schema is written in.
 * @returns {object} The effect-data schema field.
 */
function itemEffectDataField({ F, number, bool, scaling }) {
  return new F.SchemaField({
    params: new F.ArrayField(new F.SchemaField({
      name: new F.StringField({ initial: '' }), options: new F.StringField({ initial: '' }), numeric: bool(false)
    }), { initial: () => [] }),
    type: new F.StringField({ initial: '' }), rng: new F.StringField({ initial: '1' }),
    rngType: new F.StringField({ initial: 'Single' }), rngShape: new F.StringField({ initial: 'Normal' }),
    losRule: new F.StringField({ initial: 'normal', choices: ['normal', 'ignoreHeight', 'ignoreLoS'] }),
    rngScaling: scaling('None'), targets: number(1), targetType: new F.StringField({ initial: 'Any' }),
    locationRng: number(0), gridColor: new F.StringField({ initial: 'Red', choices: ['Red', 'Green', 'Purple', 'Blue', 'Orange'] }),
    groundValidSquares: new F.StringField({ initial: 'All', choices: ['All', 'Walkable', 'Flyable'] }),
    groundUnoccupiedOnly: new F.BooleanField({ initial: true }),
    groundMaxElevDiff: number(0), deliveryType: new F.StringField({ initial: 'Saving Throw' }),
    savingThrowDC: new F.SchemaField({
      required: bool(false), base: number(0), attribute: new F.StringField({ initial: 'None' }),
      targetAttribute: new F.StringField({ initial: 'None' }), ignoreForFriendly: bool(false)
    }),
    skillCheckDC: new F.SchemaField({
      required: bool(false), base: number(0), skill: new F.StringField({ initial: 'None' }),
      targetAttribute: new F.StringField({ initial: 'None' }), ignoreForFriendly: bool(false)
    }),
    consumeOnFailure: bool(true)
      });
}

export class ItemDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const {
      F,
      number,
      bool,
      material,
      scaling,
      damageTypeFields,
      nullableTierNumber,
      refinementTier
    } = itemFieldShapes();

    return {
      isWielded: bool(false), isWorn: bool(false), isEquipped: bool(false),
      description: new F.StringField({ initial: '' }),
      itemType: new F.StringField({ initial: '' }), refreshes: bool(false),
      cost: number(0), tradeDisabled: bool(false), wgt: number(0),
      stealable: new F.SchemaField({
        flag: new F.StringField({ initial: 'None', choices: ['None', 'Drops', 'Stealable'] }),
        dc: number(10)
      }),
      actionType: new F.StringField({ initial: 'Standard Action', choices: ACTION_TYPES }),
      // Whether a use can be taken back with Cancel until the unit moves or acts again. Only a bonus action that
      // targets Self may be retractable (retractableAllowed in contracts/domains/items.mjs).
      retractable: bool(false),
      uses: new F.SchemaField({
        current: number(0), max: number(0),
        type: new F.StringField({ initial: 'limited', choices: USE_TYPES }),
        scaling: scaling('Level', ['Level', 'Proficiency', 'Stat', 'Skill'])
      }),
      anim: new F.SchemaField({
        attack: new F.ObjectField({ required: false, nullable: true, initial: null }),
        critical: new F.ObjectField({ required: false, nullable: true, initial: null }),
        activation: new F.ObjectField({ required: false, nullable: true, initial: null })
      }),
      aura: new F.SchemaField({ enabled: bool(false), rng: number(0) }),
      wepArtData: new F.SchemaField({
        cost: number(0),
        ...Object.fromEntries(WEAPON_PROFICIENCIES.slice(0, 6).map(key => [key, bool(false)])),
        validTypes: new F.ArrayField(new F.StringField(), { initial: () => [], persisted: false })
      }),
      effects: new F.ArrayField(new F.SchemaField({
        trigger: new F.StringField({ initial: '' }), name: new F.StringField({ initial: '' }),
        itemNames: new F.ArrayField(new F.StringField(), { initial: () => [] }),
        itemUuids: new F.ArrayField(new F.StringField(), { initial: () => [] }),
        delayMs: number(0), tokenAwaits: bool(false),
        condition: new F.ObjectField({ required: false, nullable: true, initial: null }),
        action: new F.ObjectField({ required: false, nullable: true, initial: null })
      }), { initial: () => [] }),
      requirements: new F.ArrayField(new F.SchemaField({
        type: new F.StringField({ initial: 'condition', choices: [...REQUIREMENT_TYPES] }),
        name: new F.StringField({ initial: '' }),
        predicates: new F.ArrayField(new F.ObjectField({ required: false, nullable: true, initial: () => ({}) }), { initial: () => [] })
      }), { initial: () => [] }),
      modifiers: new F.ArrayField(new F.SchemaField({
        name: new F.StringField({ initial: '' }), target: new F.StringField({ initial: '' }),
        quantity: new F.StringField({ initial: '0' }), condition: new F.StringField({ initial: '' }),
        conditionTree: new F.ObjectField({ required: false, nullable: true, initial: null }),
        requiresEquipped: bool(false), requiresActivation: bool(false), stackable: bool(false),
        kind: new F.StringField({ initial: 'standard', choices: ['standard', 'aura'] }),
        targetType: new F.StringField({ initial: 'All', choices: AURA_TARGET_TYPES })
      }), { initial: () => [] }),
      effectData: itemEffectDataField({ F, number, bool, scaling }),
      consumableData: new F.SchemaField({
        effect: new F.StringField({ initial: '' }),
        stat: new F.StringField({ initial: '' }), statValue: number(0),
        growth: new F.StringField({ initial: '' }), growthValue: number(0)
      }),
      weapon: new F.SchemaField({
        req: new F.StringField({ initial: '' }), rank: number(0), twoHanded: bool(false),
        dmgTypes: new F.SchemaField({ ...damageTypeFields, randomize: bool(false) }),
        atkStat: new F.StringField({ initial: '' }), atk: new F.StringField({ initial: '0' }),
        rng: new F.StringField({ initial: '1' }), acc: number(0), brk: number(0), crit: number(0),
        extraAttacks: number(0), noExtraAttacks: bool(false),
        effectiveAgainst: booleanMap(F, [...UNIT_TYPES.map(entry => entry.key), 'magic']),
        breaker: booleanMap(F, WEAPON_PROFICIENCIES)
      }),
      armor: new F.SchemaField({
        req: new F.StringField({ initial: '' }), def: number(0), res: number(0), stn: number(0), eva: number(0),
        brkRed: number(0), critRed: number(0),
        vulns: booleanMap(F, DAMAGE_TYPES), prots: booleanMap(F, DAMAGE_TYPES)
      }),
      mountData: new F.SchemaField({
        stats: new F.SchemaField(Object.fromEntries(['mov', 'hp', 'stn', 'eva', 'atk', 'spd', 'acc', 'crit'].map(key => [key, number(0)]))),
        unitTypes: booleanMap(F, ['cavalry', 'flying', 'dragon', 'beast', 'monster', 'undead'])
      }),
      craftingData: new F.SchemaField({
        forgingXP: new F.NumberField({ initial: 0, nullable: false, min: 0, integer: true }),
        forging: new F.SchemaField({
          enabled: bool(false),
          forgeMult: new F.NumberField({ initial: 1, nullable: false, min: 0.1 }),
          skillCheck: new F.StringField({ initial: DEFAULT_FORGE_SKILL }),
          materials: new F.ArrayField(material(), { initial: () => [] })
        }),
        refinement: new F.SchemaField({
          tiers: new F.ArrayField(refinementTier(), { initial: () => Array.from({ length: REFINEMENT_TIER_COUNT }, () => ({
            enabled: false, xpReq: 0, forgeMult: null, skillCheck: '', materials: [],
            modifiers: {
              atk: null, brk: null, wgt: null, acc: null, crit: null, durability: null,
              stn: null, def: null, res: null, wgtRed: null, prot: '',
              prots: Object.fromEntries(DAMAGE_TYPES.map(key => [key, false])),
              dmgTypes: Object.fromEntries(DAMAGE_TYPES.map(key => [key, false]))
            }
          })) })
        }),
        creation: new F.SchemaField({
          materials: new F.ArrayField(material(), { initial: () => [] }),
          difficultyClass: number(0), skillCheck: new F.StringField({ initial: 'Nature' })
        })
      })
    };
  }
}

/* -------------------------------------------- */
/*  Schema helpers                              */
/* -------------------------------------------- */
function booleanMap(F, keys) {
  return new F.SchemaField(Object.fromEntries(keys.map(key => [key, new F.BooleanField({ initial: false })])));
}
