/** @layer foundry/data-models/item */
import { AURA_TARGET_TYPES, WEAPON_PROFICIENCIES } from '../../../contracts/domains/items.mjs';
import { migrateLegacyTarget } from '../../../contracts/domains/characters.mjs';
import { UNIT_TYPES } from '../../../game/character/rules.mjs';
import { ARMOR_DURABILITY_DEFAULTS, baseDurability, seedTierXpRequirement } from '../../../game/items/rules.mjs';
import { DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import { REQUIREMENT_TYPES } from '../../../contracts/dsl/requirements.mjs';

/* -------------------------------------------- */
/*  Item schema                                 */
/* -------------------------------------------- */
const USE_TYPES = ['limited', 'infinite', 'conditional'];
const ACTION_TYPES = ['Standard Action', 'Bonus Action'];
const TIER_MODIFIER_KEYS = ['atk', 'brk', 'wgt', 'acc', 'crit', 'durability', 'stn', 'def', 'res', 'wgtRed'];
const REFINEMENT_TIER_COUNT = 5;
const DEFAULT_FORGE_SKILL = 'Handicraft';
const INT_RE = /^-?\d+$/;

const round2 = number => Math.round(number * 100) / 100;


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
      uses: new F.SchemaField({
        current: number(0), max: number(0),
        type: new F.StringField({ initial: 'limited', choices: USE_TYPES }),
        scaling: scaling('Level', ['Level', 'Proficiency', 'Stat', 'Skill'])
      }),
      animV2: new F.SchemaField({
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
      effectsV2: new F.ArrayField(new F.SchemaField({
        trigger: new F.StringField({ initial: '' }), name: new F.StringField({ initial: '' }),
        failedSave: new F.BooleanField({ required: false, nullable: true, initial: null }),
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
          // Default tiers are already relative, so migrateRefinementToRelative leaves a defaulted refinement as built.
          relative: bool(true),
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

  /** Update older saved item data to the current schema, through the migrate* functions below. */
  static migrateData(source, options) {
    migrateItemVocabulary(source);
    if (source?.weapon?.atkStat === 'Conditional') source.weapon.atkStat = 'Hybrid';
    if (typeof source?.actionType === 'string' && !ACTION_TYPES.includes(source.actionType)) source.actionType = 'Standard Action';
    if (source?.itemType === 'Booster' && typeof source.actionType === 'string') source.actionType = 'Standard Action';
    migrateCraftingOptIn(source?.craftingData);
    migrateRefinementToRelative(source);
    migrateRepairToForging(source);
    // Foundry migrates an update's partial diff too, and an infinite item's sheet submits no maximum, so only a whole
    // Armor source gets the default durability.
    if (source?.itemType === 'Armor' && options?.partial !== true) {
      const uses = source.uses ?? (source.uses = {});
      if (uses.type !== 'infinite' && !(Number(uses.max) > 0)) {
        const maximum = ARMOR_DURABILITY_DEFAULTS[source.armor?.req] ?? 10;
        uses.max = maximum; uses.current = maximum; uses.type = 'limited';
      }
    }
    return super.migrateData(source);
  }
}
/* -------------------------------------------- */
/*  Source migration                            */
/* -------------------------------------------- */
/** Rename the old armor reduction keys and modifier targets, and drop the old weapon.prfActor. */
function migrateItemVocabulary(source) {
  if (!source || typeof source !== 'object') return;
  const armor = source.armor;
  if (armor && typeof armor === 'object') {
    if (armor.brkRed === undefined && armor.brkReduction !== undefined) armor.brkRed = armor.brkReduction;
    if (armor.critRed === undefined && armor.critReduction !== undefined) armor.critRed = armor.critReduction;
    delete armor.brkReduction;
    delete armor.critReduction;
  }
  if (source.weapon && typeof source.weapon === 'object') delete source.weapon.prfActor;
  if (!Array.isArray(source.modifiers)) return;
  for (const modifier of source.modifiers) {
    if (!modifier || typeof modifier !== 'object' || typeof modifier.target !== 'string') continue;
    const target = migrateLegacyTarget(modifier.target);
    if (target !== modifier.target) modifier.target = target;
  }
}

/* -------------------------------------------- */
/*  Crafting data migration                     */
/* -------------------------------------------- */
/** Whether a refinement tier holds any authored materials, DC or modifiers. */
function hasTierData(tier) {
  if ((tier?.materials?.length ?? 0) > 0 || (tier?.difficultyClass ?? 0) > 0) return true;
  const modifiers = tier?.modifiers;
  if (!modifiers) return false;
  if (modifiers.prot || Object.values(modifiers.prots ?? {}).some(Boolean)) return true;
  return TIER_MODIFIER_KEYS.some(key => modifiers[key] !== null && modifiers[key] !== undefined && modifiers[key] !== '');
}

/**
 * Older data marked repair and refinement with `disabled` rather than `enabled`. Each counts as enabled when it has
 * authored data and wasn't disabled. A tier's single `prot` also moves into its `prots` map.
 */
function migrateCraftingOptIn(crafting) {
  if (!crafting) return;
  const repair = crafting.repair;
  if (repair && repair.enabled === undefined) {
    repair.enabled = repair.disabled !== true && (
      (repair.materials?.length ?? 0) > 0 || (repair.durabilityRestored ?? 0) > 0 || (repair.difficultyClass ?? 0) > 0
    );
  }
  const refinement = crafting.refinement;
  if (!refinement) return;
  if (refinement.enabled === undefined) refinement.enabled = refinement.disabled !== true && (refinement.tiers ?? []).some(hasTierData);
  for (const tier of refinement.tiers ?? []) {
    const modifiers = tier?.modifiers;
    if (!modifiers?.prot) continue;
    modifiers.prots = { ...(modifiers.prots ?? {}), [modifiers.prot]: true };
    modifiers.prot = '';
  }
}

/**
 * Older refinement tiers held a weapon's absolute values. Convert them to changes from the base weapon, with weight
 * as a reduction, and mark the refinement `relative`. Other items keep their tier values, except that `atk` survives
 * only as an integer.
 */
function migrateRefinementToRelative(source) {
  const refinement = source?.craftingData?.refinement;
  if (!refinement || refinement.relative === true) return;
  refinement.relative = true;
  if (!Array.isArray(refinement.tiers)) return;
  const weapon = source.itemType === 'Weapon';
  const baseAttack = String(source.weapon?.atk ?? '').trim();
  const attackIsInteger = INT_RE.test(baseAttack);
  const delta = (absolute, base) => absolute === null || absolute === undefined || absolute === ''
    ? null : round2(Number(absolute) - (Number(base) || 0));
  for (const tier of refinement.tiers) {
    const modifiers = tier?.modifiers;
    if (!modifiers) continue;
    const rawAttack = String(modifiers.atk ?? '').trim();
    if (!weapon) {
      modifiers.atk = INT_RE.test(rawAttack) ? Number(rawAttack) : null;
      continue;
    }
    modifiers.atk = attackIsInteger && INT_RE.test(rawAttack) ? Number(rawAttack) - Number(baseAttack) : null;
    modifiers.brk = delta(modifiers.brk, source.weapon?.brk);
    modifiers.acc = delta(modifiers.acc, source.weapon?.acc);
    modifiers.crit = delta(modifiers.crit, source.weapon?.crit);
    modifiers.durability = delta(modifiers.durability, source.uses?.max);
    modifiers.wgt = modifiers.wgt === null || modifiers.wgt === undefined ? null
      : round2((Number(source.wgt) || 0) - Number(modifiers.wgt));
  }
}

/** Repair becomes the forging base, and each authored tier gains its own gate and a seeded XP requirement. */
function migrateRepairToForging(source) {
  const crafting = source?.craftingData;
  if (!crafting) return;
  const repair = crafting.repair;
  if (crafting.forging === undefined && repair) {
    crafting.forging = {
      enabled: repair.enabled === true,
      forgeMult: Number(repair.repairMult) > 0 ? Number(repair.repairMult) : 1,
      skillCheck: repair.skillCheck || DEFAULT_FORGE_SKILL,
      materials: Array.isArray(repair.materials) ? repair.materials : []
    };
  }
  delete crafting.repair;
  const refinement = crafting.refinement;
  if (!refinement) return;
  const baseSkill = crafting.forging?.skillCheck || DEFAULT_FORGE_SKILL;
  const durability = baseDurability(source);
  (refinement.tiers ?? []).forEach((tier, index) => {
    if (!tier || typeof tier !== 'object' || tier.xpReq !== undefined) return;
    const authored = hasTierData(tier);
    tier.enabled = refinement.enabled === true && authored;
    tier.xpReq = seedTierXpRequirement(index, durability);
    tier.forgeMult = null;
    tier.skillCheck = authored && tier.skillCheck && tier.skillCheck !== baseSkill ? tier.skillCheck : '';
    delete tier.energyCost;
    delete tier.difficultyClass;
  });
  delete refinement.enabled;
  delete refinement.disabled;
}

/* -------------------------------------------- */
/*  Schema helpers                              */
/* -------------------------------------------- */
function booleanMap(F, keys) {
  return new F.SchemaField(Object.fromEntries(keys.map(key => [key, new F.BooleanField({ initial: false })])));
}
