/** @layer foundry/data-models/actor */

/* -------------------------------------------- */
/*  Convoy schema                               */
/* -------------------------------------------- */

/** The Convoy schema: the party's shared store. */
export class ConvoyDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const F = foundry.data.fields;
    return {
      faction: new F.SchemaField({
        name: new F.StringField({ initial: '' }),
        color: new F.StringField({ initial: '#808080' })
      }),
      capacity: new F.NumberField({ initial: 100, min: 0 }),
      gp: new F.NumberField({ initial: 0, min: 0 }),
      /** Gold on its way to the Convoy from a granted requisition or staff authoring. A delivery moves it into gp. */
      inboundGp: new F.NumberField({ initial: 0, min: 0 }),
      notes: new F.SchemaField({ description: new F.StringField({ initial: '' }) })
    };
  }
}

/* -------------------------------------------- */
/*  Vendor schema                               */
/* -------------------------------------------- */
const MERCHANDISE = Object.freeze([
  'weapon', 'staff', 'armor', 'shield', 'accessory', 'miscellaneous',
  'potion', 'bomb', 'booster', 'promotion',
  'material', 'textile', 'reagent', 'ingredient'
]);

/** The Vendor schema: a merchant actor with its own stock and disposition. */
export class VendorDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const F = foundry.data.fields;
    const accepted = Object.fromEntries(MERCHANDISE.map(key => [key, new F.BooleanField({ initial: true })]));
    return {
      faction: new F.SchemaField({
        name: new F.StringField({ initial: '' }),
        color: new F.StringField({ initial: '#808080' })
      }),
      art: new F.SchemaField({
        avatarScale: new F.NumberField({ initial: 1.25, min: 0.25, max: 4 })
      }),
      capacity: new F.NumberField({ initial: 100, min: 0 }),
      disposition: new F.NumberField({ initial: 0, integer: true, min: -10, max: 10 }),
      gp: new F.NumberField({ initial: 0, min: 0 }),
      notes: new F.SchemaField({ description: new F.StringField({ initial: '' }) }),
      acceptedMerchandise: new F.SchemaField(accepted),
      /** Each party's haggle with this Vendor since the last Reset Downtime (game/economy/haggle.mjs). */
      haggles: new F.ArrayField(new F.SchemaField({
        key: new F.StringField({ initial: '' }),
        bonus: new F.NumberField({ initial: 0, integer: true, min: -10, max: 10 })
      }), { initial: () => [] })
    };
  }
}
