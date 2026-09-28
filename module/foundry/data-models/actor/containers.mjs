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

  /** Bring older saved Convoy data up to the current schema (migrateContainerSource). */
  static migrateData(source) {
    if (source && typeof source === 'object') migrateContainerSource(source);
    return super.migrateData(source);
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

  /** Bring older saved Vendor data up to the current schema (migrateContainerSource). */
  static migrateData(source) {
    if (source && typeof source === 'object') migrateContainerSource(source);
    return super.migrateData(source);
  }
}

/* -------------------------------------------- */
/*  Source migration                            */
/* -------------------------------------------- */
/**
 * Older Convoys and Vendors kept faction, capacity and avatar scale in flags, and the description as a top-level
 * string. Move each into its current place.
 */
function migrateContainerSource(source) {
  const flags = source.flags;
  if (flags && typeof flags === 'object') {
    const faction = source.faction ?? (source.faction = {});
    if (faction.name === undefined && flags.factionName !== undefined) faction.name = flags.factionName;
    if (faction.color === undefined && flags.factionColor !== undefined) faction.color = flags.factionColor;
    if (source.capacity === undefined && flags.capacity !== undefined) source.capacity = flags.capacity;
    const avatarScale = flags.tokenScales?.avatar;
    if (avatarScale !== undefined) {
      const art = source.art ?? (source.art = {});
      if (art.avatarScale === undefined) art.avatarScale = avatarScale;
    }
    delete source.flags;
  }
  if (typeof source.description === 'string') {
    const notes = source.notes ?? (source.notes = {});
    if (notes.description === undefined) notes.description = source.description;
    delete source.description;
  }
}
