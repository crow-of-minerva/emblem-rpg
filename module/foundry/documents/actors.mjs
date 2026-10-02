/** @layer foundry/documents */
import { FLIGHT_STATUS_MARKERS } from '../../config/statuses.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { prepareCharacterData } from '../data-models/actor/character.mjs';
import { admitNativeWrite } from '../adapters/services/authority.mjs';
import { isAirborneActor } from '../adapters/projections/combat-context.mjs';

/* -------------------------------------------- */
/*  Actor document                              */
/* -------------------------------------------- */
/**
 * The system's Actor class (CONFIG.Actor.documentClass, set in init/registrations.mjs). Characters compile their
 * derived data in prepareDerivedData, and every native write passes admitNativeWrite (services/authority.mjs).
 */
export class EmblemActor extends Actor {

  /**
   * Yield the armor effect first, then the actor's other effects, then transferred item effects. The armor effect
   * carries no changes, so the order only decides how effects are listed and iterated, status icons included.
   */
  *allApplicableEffects() {
    for (const effect of this.effects) if (effect.flags?.[SYSTEM_ID]?.isArmorEffect === true) yield effect;
    for (const effect of this.effects) if (effect.flags?.[SYSTEM_ID]?.isArmorEffect !== true) yield effect;
    if (CONFIG.ActiveEffect.legacyTransferral) return;
    for (const item of this.items) {
      for (const effect of item.effects) if (effect.transfer) yield effect;
    }
  }

  /**
   * The active temporary and status effects, plus the flight marker when no effect already shows it. The system's
   * token icons (projections/tokens.mjs) are drawn from this list; v14 core draws its own from appliedEffects.
   */
  get temporaryEffects() {
    const effects = [];
    for (const effect of this.allApplicableEffects()) {
      if (effect.active && (effect.isTemporary || effect.statuses.size > 0)) effects.push(effect);
    }
    const marker = this.flyingStatusMarker;
    if (!marker) return effects;
    const represented = effects.some(effect => effect.statuses.has(marker.name) || effect.name === marker.name);
    if (!represented) effects.push(marker);
    return effects;
  }

  /** The marker for this unit's flight state, or null when it does not fly at all. */
  get flyingStatusMarker() {
    if (this.system?.unitType?.flying !== true) return null;
    const marker = isAirborneActor(this) ? FLIGHT_STATUS_MARKERS.airborne : FLIGHT_STATUS_MARKERS.grounded;
    return this.#flightMarker(marker);
  }

  /**
   * Resolve a synthetic status marker for Token and HUD handlers that hold only its DOM id. Markers are absent
   * from effects and fromUuid.
   */
  syntheticEffect(id) {
    if (!id) return null;
    return Object.values(this.#flightMarkers ?? {}).find(effect => effect.id === id) ?? null;
  }

  get hasStandardAction() {
    return this.type === 'Character' && this.system.turn.actionAvailable;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (this.type !== 'Character') return;
    this.preparedChanceRolls = prepareCharacterData(this);
    evaluateConditionalItemUses(this);
  }

  /** A GM or Assistant GM may create units, and a Trusted player one they will own. A player's create is refused. */
  async _preCreate(data, options, user) {
    if (!admitNativeWrite(user, this, 'create')) return false;
    return super._preCreate(data, options, user);
  }

  /** A GM, Assistant GM or Trusted owner may delete directly. A player's delete is refused before Foundry sends it. */
  async _preDelete(options, user) {
    if (!admitNativeWrite(user, this, 'delete')) return false;
    return super._preDelete(options, user);
  }

  /**
   * Refuse a player's direct edit. Then, while an effect levitates the unit, clear its saved Grounded status so the
   * two don't conflict.
   */
  async _preUpdate(changes, options, user) {
    if (!admitNativeWrite(user, this, 'update', changes)) return false;
    await super._preUpdate(changes, options, user);
    if (this.type !== 'Character') return;
    const levitating = foundry.utils.getProperty(changes, 'system.combat.levitation')
      ?? this.system.combat.levitation;
    const grounded = foundry.utils.getProperty(changes, 'system.statuses.grounded')
      ?? this.system.statuses.grounded;
    if (levitating === true && grounded === true) {
      foundry.utils.setProperty(changes, 'system.statuses.grounded', false);
    }
  }

  #flightMarkers = null;

  /** Cache the flight marker per Actor so Token and HUD redraws preserve its identity and animation. */
  #flightMarker({ id, img }) {
    this.#flightMarkers ??= {};
    this.#flightMarkers[id] ??= new ActiveEffect({
      _id: foundry.utils.randomID(),
      name: id,
      img,
      statuses: [id],
      flags: { [SYSTEM_ID]: { syntheticFlying: true } }
    }, { parent: this });
    return this.#flightMarkers[id];
  }
}

/* -------------------------------------------- */
/*  Actor collection                            */
/* -------------------------------------------- */
const BaseActors = foundry.documents.collections.Actors;

/**
 * The world Actors collection. A unit imported from a compendium keeps the default ownership it was packed with,
 * when that's higher than the one Foundry would give it.
 */
export class EmblemActors extends BaseActors {
  fromCompendium(document, options = {}) {
    const data = super.fromCompendium(document, options);
    const packed = Number(document?.pack ? document._source?.ownership?.default : NaN);
    if (!Number.isInteger(packed) || packed <= Number(data.ownership?.default ?? 0)) return data;
    data.ownership = { ...(data.ownership ?? {}), default: packed };
    return data;
  }
}

/* -------------------------------------------- */
/*  Derived item uses                           */
/* -------------------------------------------- */
/**
 * Work out every conditional uses maximum once the owner's stats are totalled, and lower current uses that are now
 * over it.
 */
function evaluateConditionalItemUses(actor) {
  for (const item of actor.items) {
    const uses = item.system?.uses;
    if (uses?.type !== 'conditional') continue;
    uses.max = item.getEffectiveMaxUses();
    if (Number(uses.current) > uses.max) uses.current = uses.max;
  }
}
