/** @layer foundry/adapters/projections */
import { readEffectFlags as effectFlags } from '../services/host.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { LOCKABLE_OBJECT_TYPES } from '../../../contracts/domains/objects.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { speedAdvantageBand } from '../../../game/combat/exchange.mjs';
import { isAttackItem } from './combat-context.mjs';
import { compileCharacterAs } from './characters.mjs';
import {
  objectIsNameOnlyFixture, objectLockDifficulty, objectLockIsPickable, resolveTargetKind, TARGET_KINDS
} from '../../../game/objects/rules.mjs';
import { INSPECTION_KINDS } from '../../../contracts/domains/board.mjs';
import { GUARD_BOND_FLAGS, GUARD_BOND_ROLES } from '../../../contracts/domains/combat.mjs';
import { FACTION_ROLES } from '../../../contracts/domains/characters.mjs';

/* -------------------------------------------- */
/*  Effect projection                           */
/* -------------------------------------------- */
/**
 * The status icons a token draws: one plain record per temporary effect on its actor. init/hooks.mjs hands this to
 * the token effect renderer, and the Bar Brawl bars read it to leave room for a wield badge.
 */
export function projectFoundryTokenEffects(token) {
  const effects = token?.actor?.temporaryEffects ?? [];
  return Object.freeze(effects.map(effect => {
    const flags = effectFlags(effect);
    return Object.freeze({
      id: String(effect?.id ?? effect?._id ?? ''),
      img: String(effect?.img ?? ''),
      tint: effect?.tint ?? null,
      overlay: effect?.flags?.core?.overlay === true,
      armor: flags.isArmorEffect === true,
      mount: flags.isMountEffect === true,
      wield: flags.isWieldEffect === true,
      stackable: flags.stackable === true,
      stackCount: Math.max(0, Math.floor(Number(flags.stackCount) || 0))
    });
  }));
}

const COMBATANT_ACTOR_TYPE = 'Character';

/* -------------------------------------------- */
/*  Guard bond partner                          */
/* -------------------------------------------- */

/** The TokenDocument on the other side of a Token's Guard bond, from either half, or null when it stands alone. */
export function guardBondPartnerToken(tokenLike) {
  const token = tokenLike?.documentName === 'Token' ? tokenLike : tokenLike?.document;
  if (!token?.parent) return null;
  const tokens = collectionValues(token.parent.tokens);
  const guarderUuid = String(token.getFlag?.(SYSTEM_ID, GUARD_BOND_FLAGS.GUARDER) ?? '');
  if (guarderUuid) return tokens.find(candidate => String(candidate.uuid ?? '') === guarderUuid) ?? null;
  return tokens.find(candidate => (
    String(candidate.getFlag?.(SYSTEM_ID, GUARD_BOND_FLAGS.GUARDER) ?? '') === String(token.uuid ?? '')
  )) ?? null;
}

/**
 * The Guard bond partner, but only while both units still wear a Guard bond effect, so a bond flag left behind
 * after the bond broke is ignored. Movement occupancy reads it (movement.mjs).
 */
export function liveGuardBondPartnerToken(tokenLike) {
  const partner = guardBondPartnerToken(tokenLike);
  if (!partner) return null;
  const token = tokenLike?.documentName === 'Token' ? tokenLike : tokenLike?.document;
  return wearsGuardBond(token.actor) && wearsGuardBond(partner.actor) ? partner : null;
}

function wearsGuardBond(actor) {
  return collectionValues(actor?.effects).some(effect => (
    effect?.disabled !== true && Boolean(effect?.flags?.[SYSTEM_ID]?.guardRole)
  ));
}

/* -------------------------------------------- */
/*  Hostile target redirection                  */
/* -------------------------------------------- */

/**
 * The token that takes an attack aimed at this one: its guarder while a Guard bond covers it (from the token's
 * bond flag or its guardee effect), otherwise the token itself. The exchange, item targeting, the unit board and
 * the taunt checks all redirect through here.
 */
export function redirectFoundryHostileToken(tokenLike) {
  const token = tokenLike?.documentName === 'Token' ? tokenLike : tokenLike?.document;
  if (!token?.actor || !token.parent) return token ?? null;
  const flaggedTokenUuid = token.getFlag?.(SYSTEM_ID, GUARD_BOND_FLAGS.GUARDER);
  if (flaggedTokenUuid) {
    const flagged = collectionValues(token.parent.tokens)
      .find(candidate => String(candidate.uuid ?? '') === String(flaggedTokenUuid));
    if (flagged?.actor) return flagged;
  }
  const effect = collectionValues(token.actor.effects).find(candidate => (
    candidate.disabled !== true
      && candidate.flags?.[SYSTEM_ID]?.guardRole === GUARD_BOND_ROLES.GUARDEE
      && candidate.flags?.[SYSTEM_ID]?.partnerUuid
  ));
  const partnerUuid = String(effect?.flags?.[SYSTEM_ID]?.partnerUuid ?? '');
  if (!partnerUuid) return token;
  return collectionValues(token.parent.tokens)
    .find(candidate => String(candidate.actor?.uuid ?? '') === partnerUuid) ?? token;
}

/* -------------------------------------------- */
/*  Fixture click redirection                   */
/* -------------------------------------------- */

/**
 * Where a targeting click on a token really lands. A click on anything other than a unit goes to a unit sharing its
 * square. Scenery with no unit on it is refused, and a Destructible stays the target because attacks can damage its
 * Integrity, unless it is hidden, which makes it scenery (resolveTargetKind). Used by the attack and item targeting
 * projections and by ui/controls/targeting.mjs.
 * @param {object} tokenLike Clicked Token or TokenDocument.
 * @returns {{token: object|null, redirected: boolean, refused: boolean}}
 */
export function redirectFoundryFixtureToken(tokenLike) {
  const token = tokenLike?.documentName === 'Token' ? tokenLike : tokenLike?.document;
  const actor = token?.actor ?? null;
  if (!actor || !token.parent) return outcome(token ?? null, false, false);
  if (actor.type === COMBATANT_ACTOR_TYPE) return outcome(token, false, false);

  const occupied = new Set(tokenCellKeys(token));
  const standing = collectionValues(token.parent.tokens).find(candidate => (
    candidate !== token
      && candidate.actor?.type === COMBATANT_ACTOR_TYPE
      && tokenCellKeys(candidate).some(key => occupied.has(key))
  ));
  if (standing) return outcome(standing, true, false);

  const kind = resolveTargetKind({
    documentType: actor.type, objectType: actor.system?.objectType, hidden: token.hidden === true
  });
  const refused = kind === TARGET_KINDS.SCENERY;
  return outcome(refused ? null : token, false, refused);
}

function outcome(token, redirected, refused) {
  return { token, redirected, refused };
}

function tokenCellKeys(token) {
  const gridSize = Math.max(1, Number(token?.parent?.grid?.size) || 1);
  const x = Math.floor(Number(token?.x) / gridSize);
  const y = Math.floor(Number(token?.y) / gridSize);
  const width = Math.max(1, Math.round(Number(token?.width) || 1));
  const height = Math.max(1, Math.round(Number(token?.height) || 1));
  const keys = [];
  for (let column = 0; column < width; column += 1) {
    for (let row = 0; row < height; row += 1) keys.push(`${x + column},${y + row}`);
  }
  return keys;
}

/* -------------------------------------------- */
/*  Inspection vocabulary                       */
/* -------------------------------------------- */
const EFFECTIVE_LABELS = Object.freeze({
  armored: 'Armor', infantry: 'Infantry', cavalry: 'Cavalry', flying: 'Flying',
  beast: 'Beast', dragon: 'Dragon', undead: 'Undead', monster: 'Monster', magic: 'Magic'
});
const INSPECTED_ATTACK_LIMIT = 5;

/* -------------------------------------------- */
/*  Unit inspection                             */
/* -------------------------------------------- */
/**
 * What the inspection tooltip (ui/controls/interaction.mjs) shows for a placed token, shaped by what kind of thing
 * it is: a unit's stats and attacks, a lock, an Armament, a Destructible, or just a name.
 * @param {object} token Placed Token whose Actor is described.
 * @param {object|null} [reference] Token the description is read against, for comparative stats.
 * @param {number|null} [previewAttackIndex] Attack to describe the unit as wielding, instead of the one it holds.
 * @returns {object|null} Immutable inspection record, or `null` when the Token carries no Actor.
 */
export function projectInspectedUnit(token, reference = null, previewAttackIndex = null) {
  const actor = token?.actor;
  if (!actor) return null;
  const system = actor.system ?? {};
  const name = String(token.name ?? actor.name ?? '');
  const objectType = String(system.objectType ?? '');

  if (actor.type === 'Vendor' || actor.type === 'Convoy') return nameOnly(name, actor.type);
  if (actor.type === 'Object') {
    if (objectIsNameOnlyFixture(objectType)) return nameOnly(name, 'Object');
    if (LOCKABLE_OBJECT_TYPES.includes(objectType)) return lock(name, system);
    if (objectType === 'Armament') return armament(name, system);
    if (objectType === 'Destructible') return destructible(name, system);
  }
  return unit(name, actor, reference, previewAttackIndex);
}

/* -------------------------------------------- */
/*  Inspection shapes                           */
/* -------------------------------------------- */
function nameOnly(name, kindLabel) {
  return Object.freeze({ kind: INSPECTION_KINDS.NAME_ONLY, kindLabel, name });
}

function lock(name, system) {
  return Object.freeze({
    kind: INSPECTION_KINDS.LOCK,
    kindLabel: 'Lock',
    name,
    unlocked: system.locked === false,
    unpickable: !objectLockIsPickable(system.difficultyClass),
    difficultyClass: objectLockDifficulty(system.difficultyClass)
  });
}

function armament(name, system) {
  const weapon = system.armament ?? {};
  const durability = weapon.durability ?? {};
  const infinite = durability.type === 'infinite';
  const remaining = Number(durability.value) || 0;
  return Object.freeze({
    kind: INSPECTION_KINDS.ARMAMENT,
    kindLabel: 'Armament',
    name,
    durability: infinite ? '∞' : `${remaining}/${Number(durability.max) || 0}`,
    broken: !infinite && remaining < 1,
    stats: Object.freeze({
      atk: formula(weapon.atk),
      brk: Number(weapon.brk) || 0,
      acc: Number(weapon.acc) || 0,
      crit: Number(weapon.crit) || 0,
      rng: formula(weapon.rng)
    }),
    damageTypes: enabledKeys(weapon.dmgTypes).filter(type => type !== 'randomize'),
    effectiveAgainst: Object.freeze(enabledKeys(weapon.effectiveAgainst).map(key => Object.freeze({
      key,
      label: EFFECTIVE_LABELS[key] ?? key
    })))
  });
}

function destructible(name, system) {
  return Object.freeze({
    kind: INSPECTION_KINDS.DESTRUCTIBLE,
    kindLabel: 'Object',
    name,
    integrity: `${Number(system.resources?.stn?.value) || 0}/${Number(system.resources?.stn?.max) || 0}`,
    vulnerableTypes: enabledKeys(system.vulns),
    protectedTypes: enabledKeys(system.prots),
    immuneTypes: enabledKeys(system.imms)
  });
}

function unit(name, actor, reference, previewAttackIndex) {
  const attacks = inspectedAttacks(actor);
  const previewed = previewedAttack(actor, attacks, previewAttackIndex);
  const system = previewed ? compileCharacterAs(actor, { wieldedItemId: previewed.id }) : actor.system ?? {};
  const speed = statValue(system.stats?.spd?.total);
  return Object.freeze({
    kind: INSPECTION_KINDS.UNIT,
    kindLabel: unitKindLabel(actor),
    name,
    stats: Object.freeze({
      atk: formula(system.stats?.atk?.total),
      brk: statValue(system.stats?.brk?.total),
      acc: statValue(system.stats?.acc?.total),
      crit: statValue(system.stats?.crit?.total),
      def: statValue(system.stats?.def?.total),
      res: statValue(system.stats?.res?.total),
      eva: statValue(system.stats?.eva?.total),
      spd: speed
    }),
    speedBand: speedBandAgainst(speed, reference),
    damageTypes: enabledKeys(system.equipment?.damageTypes).filter(type => type !== 'randomize'),
    vulnerableTypes: enabledKeys(system.equipment?.vulns),
    protectedTypes: enabledKeys(system.equipment?.prots),
    immuneTypes: enabledKeys(system.equipment?.imms),
    attacks: previewed ? markWielded(attacks, previewed.id) : attacks
  });
}

/** A Character's faction role names it, and any other unit reads as a plain Unit. */
function unitKindLabel(actor) {
  const role = String(actor.system?.faction?.role ?? '');
  return actor.type === 'Character' && FACTION_ROLES.includes(role) ? role : 'Unit';
}

/** The attack a preview describes the unit as holding, which only a Character can be measured for. */
function previewedAttack(actor, attacks, previewAttackIndex) {
  if (actor.type !== 'Character' || !Number.isInteger(previewAttackIndex)) return null;
  return attacks[previewAttackIndex] ?? null;
}

function markWielded(attacks, wieldedId) {
  return Object.freeze(attacks.map(attack => Object.freeze({ ...attack, wielded: attack.id === wieldedId })));
}

/** The attacks a unit can still make, shown as icons along the edge of its inspection tooltip. */
function inspectedAttacks(actor) {
  return Object.freeze(collectionValues(actor.items)
    .filter(item => isAttackItem(item) && attackHasUses(item))
    .slice(0, INSPECTED_ATTACK_LIMIT)
    .map(item => Object.freeze({
      id: String(item.id ?? ''),
      name: String(item.name ?? ''),
      img: String(item.img ?? ''),
      wielded: item.system?.isWielded === true
    })));
}

function attackHasUses(item) {
  const uses = item?.system?.uses ?? {};
  return uses.type === 'infinite' || (Number(uses.current) || 0) >= 1;
}

/* -------------------------------------------- */
/*  Value reading                               */
/* -------------------------------------------- */
function speedBandAgainst(speed, reference) {
  const referenceActor = reference?.actor;
  if (!referenceActor) return 0;
  return speedAdvantageBand(statValue(referenceActor.system?.stats?.spd?.total) - speed);
}

function statValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') {
    const leading = value.match(/^(\d+)/);
    return leading ? Number.parseInt(leading[1], 10) : 0;
  }
  return Number(value) || 0;
}

function formula(value) {
  if (value === null || value === undefined) return '0';
  const text = String(value).trim();
  return text.length ? text : '0';
}

function enabledKeys(record) {
  return Object.freeze(Object.entries(record ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key));
}
