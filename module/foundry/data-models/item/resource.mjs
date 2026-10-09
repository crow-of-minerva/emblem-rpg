/** @layer foundry/data-models/item */
import { FOOD_TYPES } from '../../../contracts/domains/items.mjs';

/* -------------------------------------------- */
/*  Resource schema                             */
/* -------------------------------------------- */
export class ResourceDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const F = foundry.data.fields;
    const number = (initial = 0) => new F.NumberField({ initial, nullable: true, optional: true });
    return {
      description: new F.StringField({ initial: '' }),
      resourceType: new F.StringField({ initial: 'Material' }),
      foodType: new F.StringField({ initial: '', blank: true, choices: ['', ...FOOD_TYPES] }),
      amount: number(1),
      cost: new F.SchemaField({
        perUnit: number(0),
        total: new F.NumberField({ initial: 0, nullable: true, optional: true, persisted: false })
      }),
      stealable: new F.SchemaField({
        flag: new F.StringField({ initial: 'None', choices: ['None', 'Drops', 'Stealable'] }),
        dc: number(10),
        chance: number(100)
      })
    };
  }

  prepareDerivedData() {
    this.cost.total = Math.max(0, Number(this.amount) || 0) * Math.max(0, Number(this.cost.perUnit) || 0);
  }
}
