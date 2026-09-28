/** @layer foundry/data-models/actor */
import { OBJECT_TYPES, TARGET_AREA_KEYS, TARGET_SHAPES } from '../../../contracts/domains/objects.mjs';
import { WEAPON_PROFICIENCIES } from '../../../contracts/domains/items.mjs';
import { ALL_UNIT_TYPE_KEYS, UNIT_TYPE_KEYS } from '../../../contracts/domains/characters.mjs';
import { DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import {
  DOWNTIME_STATION_TYPES, FACTION_RELATIONS, FACTION_WEALTH, REQUISITION_LIMITS, normalizeFactions
} from '../../../contracts/domains/downtime.mjs';

/* -------------------------------------------- */
/*  Object schema                               */
/* -------------------------------------------- */
const ART_STATES = Object.freeze(['intact', 'destroyed', 'closed', 'opened']);
/**
 * The lock art states (a Chest's or Door's closed and opened art) start with no scale of their own, so they use the
 * prototype token's scale until the Object sheet sets one.
 */
const LOCK_ART_STATES = Object.freeze(['closed', 'opened']);
const ALTAR_TIER_MINIMUMS = Object.freeze({ t2: 1000, t3: 2000, t4: 4000, t5: 8000 });
const ARMAMENT_REQ = Object.freeze([
  'None', 'Brawling', 'Blade', 'Polearm', 'Heavy', 'Bow', 'Covert', 'Arcane', 'Elemental', 'Divine', 'Occult'
]);

/** The Object schema: fixtures, containers and destructibles, in the same families a Character uses. */
export class ObjectDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const F = foundry.data.fields;
    const bools = keys => new F.SchemaField(Object.fromEntries(
      keys.map(key => [key, new F.BooleanField({ initial: false })])
    ));
    const num = (initial = 0, options = {}) => new F.NumberField({ initial, ...options });
    const stat = () => new F.SchemaField({
      base: num(0),
      total: num(0, { persisted: false })
    });
    const resource = () => new F.SchemaField({ value: num(1, { min: 0 }), max: num(1, { min: 0 }) });
    const artState = (scale = 1) => new F.SchemaField({
      scale: num(scale, { nullable: true, min: 0.2, max: 3 }),
      tint: new F.StringField({ initial: '', blank: true }),
      offsetX: num(0),
      offsetY: num(0)
    });

    return {
      objectType: new F.StringField({ initial: '', blank: true, choices: OBJECT_TYPES }),
      key: new F.StringField({ initial: '', blank: true }),
      locked: new F.BooleanField({ initial: true }),
      difficultyClass: num(10),
      isDropChest: new F.BooleanField({ initial: false }),
      blockFlyers: new F.BooleanField({ initial: false }),
      faction: new F.SchemaField({
        role: new F.StringField({ initial: 'Neutral' }),
        name: new F.StringField({ initial: '' }),
        color: new F.StringField({ initial: '' })
      }),
      statuses: new F.SchemaField({
        passing: new F.BooleanField({ initial: false }),
        passable: new F.BooleanField({ initial: false }),
        lastStand: new F.BooleanField({ initial: false, persisted: false })
      }),
      resources: new F.SchemaField({ hp: resource(), stn: resource() }),
      special: new F.SchemaField({
        extraLives: new F.SchemaField({
          value: num(0, { integer: true, min: 0 }),
          max: num(0, { integer: true, min: 0 })
        })
      }),
      stats: new F.SchemaField({ def: stat(), res: stat() }),
      unitType: bools(UNIT_TYPE_KEYS),
      prots: bools(DAMAGE_TYPES),
      vulns: bools(DAMAGE_TYPES),
      imms: bools(DAMAGE_TYPES),
      art: new F.SchemaField({
        altImagePath: new F.StringField({ initial: '', blank: true }),
        destroyedImagePath: new F.StringField({ initial: '', blank: true }),
        ...Object.fromEntries(ART_STATES.map(state => [state, artState(LOCK_ART_STATES.includes(state) ? null : 1)]))
      }),
      anim: new F.SchemaField({
        attack: new F.ObjectField({ required: false, nullable: true, initial: null }),
        critical: new F.ObjectField({ required: false, nullable: true, initial: null }),
        activation: new F.ObjectField({ required: false, nullable: true, initial: null })
      }),
      armament: new F.SchemaField({
        req: new F.StringField({ initial: 'None', choices: ARMAMENT_REQ }),
        rank: num(0, { integer: true, min: 0, max: 6 }),
        durability: new F.SchemaField({
          value: num(0, { min: 0 }),
          max: num(0, { min: 0 }),
          type: new F.StringField({ initial: 'limited', choices: ['limited', 'infinite'] })
        }),
        atkStat: new F.StringField({ initial: 'None', choices: ['None', 'Might', 'Wit', 'Technique'] }),
        atk: new F.StringField({ initial: '0' }),
        brk: num(0),
        rng: new F.StringField({ initial: '1' }),
        wgt: num(0),
        acc: num(0),
        crit: num(0),
        dmgTypes: bools(DAMAGE_TYPES),
        effectiveAgainst: bools(ALL_UNIT_TYPE_KEYS),
        breaker: bools(WEAPON_PROFICIENCIES),
        extraAttacks: num(0, { min: 0 }),
        noExtraAttacks: new F.BooleanField({ initial: false }),
        targetShape: new F.StringField({ initial: 'Cross', choices: TARGET_SHAPES }),
        targetArea: new F.SchemaField(Object.fromEntries(TARGET_AREA_KEYS.map(key => [
          key, new F.BooleanField({ initial: true })
        ])))
      }),
      effects: new F.ArrayField(new F.ObjectField(), { initial: () => [] }),
      ...downtimeStationSchema(F, num)
    };
  }

  /**
   * Clamp current HP and Integrity to their maximums (a Destructible keeps at least 1 HP), total the defenses, and
   * tidy the Altar and Stationary blocks.
   */
  prepareDerivedData() {
    const resources = this.resources;
    resources.hp.value = Math.min(Number(resources.hp.value) || 0, Number(resources.hp.max) || 0);
    resources.stn.value = Math.min(Number(resources.stn.value) || 0, Number(resources.stn.max) || 0);
    if (this.objectType === 'Destructible') {
      resources.hp.max = Math.max(1, Number(resources.hp.max) || 0);
      resources.hp.value = Math.max(1, Number(resources.hp.value) || 0);
    }
    this.stats.def.total = Number(this.stats.def.base) || 0;
    this.stats.res.total = Number(this.stats.res.base) || 0;
    if (this.objectType === 'Altar') prepareAltarData(this.altar);
    if (this.objectType === DOWNTIME_STATION_TYPES.REQUISITION) {
      prepareRequisitionData(this.requisition);
    }
  }
}

/* -------------------------------------------- */
/*  Derived clamps                              */
/* -------------------------------------------- */

/**
 * Clamp an Altar's numbers. A blank tier minimum stays null, which disables that tier. Other minimums and the energy
 * cost floor at 0, a boon's percent stays within 0 to 100, and its tier within 1 to 5.
 */
function prepareAltarData(altar) {
  const tierMin = value => (value === null || value === undefined || value === '') ? null : Math.max(0, Number(value) || 0);
  altar.energyCost = Math.max(0, Number(altar.energyCost) || 0);
  altar.minOffering = tierMin(altar.minOffering);
  for (const tier of Object.keys(ALTAR_TIER_MINIMUMS)) altar.tierMins[tier] = tierMin(altar.tierMins[tier]);
  for (const boon of altar.boons) {
    boon.percent = Math.min(100, Math.max(0, Number(boon.percent) || 0));
    boon.tier = Math.min(5, Math.max(1, Math.floor(Number(boon.tier) || 1)));
  }
  return altar;
}

/**
 * A Stationary's faction rows through normalizeFactions in contracts/domains/downtime.mjs: a bounded name, a known
 * relation and wealth, an id on every row, and the table held to its size, as the requisition snapshot reads them.
 */
function prepareRequisitionData(requisition) {
  requisition.factions = normalizeFactions(requisition.factions);
  return requisition;
}

/* -------------------------------------------- */
/*  Downtime station fields                     */
/* -------------------------------------------- */

/** The Gathering Node, Altar and Stationary blocks: authored on the sheet here, consumed by the downtime activities. */
function downtimeStationSchema(F, num) {
  return {
    gathering: new F.SchemaField({
      description: new F.StringField({ initial: '', blank: true }),
      skill: new F.StringField({ initial: 'Athletics', choices: ['Athletics', 'Nature', 'Finesse'] }),
      multiplier: num(1, { min: 0.1, max: 2 }),
      animType: new F.StringField({
        initial: 'harvesting', choices: ['harvesting', 'mining', 'logging', 'shoveling', 'fishing']
      }),
      items: new F.ArrayField(new F.SchemaField({
        uuid: new F.StringField({ initial: '' }),
        name: new F.StringField({ initial: '' }),
        img: new F.StringField({ initial: '' }),
        total: num(1, { min: 0 }),
        weight: num(1, { min: 0.1, max: 1 }),
        hidden: new F.BooleanField({ initial: false })
      }), { initial: () => [] })
    }),
    altar: new F.SchemaField({
      deity: new F.StringField({ initial: '' }),
      religion: new F.StringField({ initial: '' }),
      description: new F.StringField({ initial: '' }),
      energyCost: num(1, { min: 0 }),
      minOffering: num(500, { nullable: true, min: 0 }),
      tierMins: new F.SchemaField(Object.fromEntries(Object.entries(ALTAR_TIER_MINIMUMS).map(([tier, initial]) => [
        tier, num(initial, { nullable: true, min: 0 })
      ]))),
      boons: new F.ArrayField(new F.SchemaField({
        uuid: new F.StringField({ initial: '' }),
        name: new F.StringField({ initial: '' }),
        img: new F.StringField({ initial: '' }),
        percent: num(5, { min: 0, max: 100 }),
        tier: num(1, { integer: true, min: 1, max: 5 })
      }), { initial: () => [] })
    }),
    requisition: new F.SchemaField({
      factions: new F.ArrayField(new F.SchemaField({
        _id: new F.StringField({ initial: () => foundry.utils.randomID() }),
        name: new F.StringField({ initial: '', blank: true }),
        relation: new F.StringField({ initial: 'Neutral', choices: FACTION_RELATIONS }),
        wealth: new F.StringField({ initial: 'Average', choices: FACTION_WEALTH }),
        enabled: new F.BooleanField({ initial: true }),
        requisitioned: new F.BooleanField({ initial: false })
      }), { initial: () => [], max: REQUISITION_LIMITS.maxFactions })
    })
  };
}
