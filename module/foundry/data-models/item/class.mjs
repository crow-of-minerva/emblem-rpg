/** @layer foundry/data-models/item */
import { GROWTH_STATS, PROFICIENCIES, SKILLS } from '../../../game/character/rules.mjs';
import { SKILL_RANK_MAX } from '../../../game/progression/rules.mjs';

/* -------------------------------------------- */
/*  Class schema                                */
/* -------------------------------------------- */
export class ClassDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const F = foundry.data.fields;
    const number = (initial = 0) => new F.NumberField({ initial, nullable: true, optional: true });
    const skillRank = () => new F.NumberField({ initial: 0, nullable: false, required: true, integer: true, min: 0, max: SKILL_RANK_MAX });
    const stats = keys => new F.SchemaField(Object.fromEntries(keys.map(key => [key, number(0)])));

    return {
      description: new F.StringField({ initial: '' }),
      tier: new F.StringField({ initial: '' }),
      baseStats: stats(['hp', 'stn', 'mov', 'bld', 'mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res', 'spd', 'eva', 'acc', 'crit']),
      baseGrowths: stats(GROWTH_STATS),
      baseCaps: stats(GROWTH_STATS),
      proficiencies: new F.SchemaField({
        ...Object.fromEntries(PROFICIENCIES.filter(entry => !entry.misc).map(({ key }) => [key, number(0)])),
        armor: number(0),
        riding: new F.BooleanField({ initial: false }),
        flying: new F.BooleanField({ initial: false })
      }),
      skills: new F.SchemaField(Object.fromEntries(SKILLS.map(({ key }) => [key, skillRank()]))),
      unitType: new F.SchemaField(Object.fromEntries(
        ['infantry', 'dragon', 'monster', 'beast', 'undead'].map(key => [key, new F.BooleanField({ initial: false })])
      )),
      features: new F.ArrayField(new F.SchemaField({
        _id: new F.StringField({ initial: () => foundry.utils.randomID() }),
        lvl: new F.NumberField({ initial: 1, min: 1 }),
        acquisitionType: new F.StringField({ initial: 'all', choices: ['all', 'choice'] }),
        choiceCount: new F.NumberField({ initial: 1, min: 1 }),
        unique: new F.BooleanField({ initial: false }),
        exceptions: new F.StringField({ initial: '' }),
        items: new F.ArrayField(new F.SchemaField({
          uuid: new F.StringField({ initial: '' }),
          name: new F.StringField({ initial: 'Unnamed' }),
          img: new F.StringField({ initial: 'icons/svg/item-bag.svg' }),
          type: new F.StringField({ initial: 'Ability' }),
          replace: new F.SchemaField({
            uuid: new F.StringField({ initial: '' }),
            name: new F.StringField({ initial: '' }),
            img: new F.StringField({ initial: '' })
          })
        }), { initial: () => [] })
      }), { initial: () => [] }),
      promotions: new F.ArrayField(new F.SchemaField({
        _id: new F.StringField({ initial: () => foundry.utils.randomID() }),
        lvl: new F.NumberField({ initial: 1, min: 1 }),
        classUuid: new F.StringField({ initial: '' }),
        className: new F.StringField({ initial: '' }),
        classImg: new F.StringField({ initial: 'icons/svg/item-bag.svg' }),
        promotionItem: new F.SchemaField({
          uuid: new F.StringField({ initial: '' }),
          name: new F.StringField({ initial: '' }),
          img: new F.StringField({ initial: '' })
        }),
        proficiencies: new F.SchemaField(Object.fromEntries(
          PROFICIENCIES.filter(entry => !entry.misc).map(({ key }) => [key, number(0)])
        )),
        skills: new F.SchemaField(Object.fromEntries(SKILLS.map(({ key }) => [key, skillRank()])))
      }), { initial: () => [] })
    };
  }
}
