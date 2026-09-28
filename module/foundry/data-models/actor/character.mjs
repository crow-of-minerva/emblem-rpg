/** @layer foundry/data-models/actor */
import {
  ALL_UNIT_TYPE_KEYS,
  COMBAT_FLAG_KEYS,
  GROWTH_KEYS,
  PROFICIENCIES,
  SAVE_KEYS,
  SKILLS,
  STATS,
  STATUSES,
  UNIT_TYPE_KEYS
} from '../../../contracts/domains/characters.mjs';
import { compileCharacterData } from '../../../game/character/compilation.mjs';
import { WEAPON_PROFICIENCIES } from '../../../contracts/domains/items.mjs';
import { SKILL_RANK_MAX } from '../../../game/progression/rules.mjs';
import {
  CHARACTER_EXPERIENCE_THRESHOLD,
  CHARACTER_MAX_LEVEL,
  SUPPORT_MAX_RANK,
  SUPPORT_UNRANKED
} from '../../../contracts/domains/progression.mjs';
import { CRITICAL_MULTIPLIER_BASE, isDifficultyTarget } from '../../../game/character/rules.mjs';
import { projectCharacterSource } from '../../adapters/projections/characters.mjs';
import { DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import { DOWNTIME_ENERGY_BASE } from '../../../contracts/domains/downtime.mjs';

/* -------------------------------------------- */
/*  Character schema                            */
/* -------------------------------------------- */


/**
 * The field builders CharacterDataModel's schema is written with: stats, resources, skills, proficiencies and art.
 * @returns {object} The Foundry field namespace and the builders, ready to destructure.
 */
function characterFieldShapes() {
  const F = foundry.data.fields;
  const number = (initial = 0, options = {}) => new F.NumberField({ initial, nullable: false, ...options });
  const derivedNumber = (initial = 0) => number(initial, { persisted: false });
  const derivedString = initial => new F.StringField({ initial, persisted: false });
  const derivedBoolean = initial => new F.BooleanField({ initial, persisted: false });

  /** A stat node: `base` is authored, the rest are contributions the compiler totals. */
  const stat = (initial = 0) => new F.SchemaField({
    base: number(initial, { integer: true }),
    mod: number(0, { integer: true }),
    penalty: number(0, { integer: true }),
    aura: number(0, { integer: true }),
    class: derivedNumber(0),
    item: derivedNumber(0),
    passive: derivedNumber(0),
    total: derivedNumber(initial)
  });
  const ratioStat = initial => new F.SchemaField({
    base: number(initial), mod: number(0), penalty: number(0), aura: number(0),
    class: derivedNumber(0), item: derivedNumber(0), passive: derivedNumber(0), total: derivedNumber(initial)
  });
  const formulaStat = initial => new F.SchemaField({
    base: number(0, { integer: true }), mod: number(0, { integer: true }),
    penalty: number(0, { integer: true }), aura: number(0, { integer: true }),
    class: derivedNumber(0), item: derivedString(initial), passive: derivedNumber(0),
    override: derivedString(''), total: derivedString(initial)
  });
  const statFor = entry => (entry.kind === 'formula' ? formulaStat(entry.key === 'rng' ? '1' : '0')
    : entry.kind === 'ratio' ? ratioStat(entry.base ?? CRITICAL_MULTIPLIER_BASE)
      : stat(entry.base ?? 0));

  const resource = (initial, { integer = true } = {}) => new F.SchemaField({
    value: number(initial, { integer, min: 0 }),
    max: derivedNumber(initial)
  });
  const pool = initial => new F.SchemaField({
    value: number(initial, { integer: true, min: 0 }),
    max: number(initial, { integer: true, min: 0 })
  });
  const skill = () => new F.SchemaField({
    base: number(0, { integer: true, min: 0, max: SKILL_RANK_MAX }),
    xp: number(0, { integer: true, min: 0 }),
    class: derivedNumber(0), passive: derivedNumber(0), total: derivedNumber(0), xpMax: derivedNumber(40)
  });
  const proficiency = () => new F.SchemaField({
    base: number(0, { integer: true, min: 0, max: 6 }),
    xp: number(0, { integer: true, min: 0 }),
    maxE: number(50, { integer: true, min: 1 }), maxD: number(50, { integer: true, min: 1 }),
    maxC: number(75, { integer: true, min: 1 }), maxB: number(100, { integer: true, min: 1 }),
    maxA: number(125, { integer: true, min: 1 }), maxS: number(150, { integer: true, min: 1 }),
    class: derivedNumber(0), passive: derivedNumber(0), total: derivedNumber(0), xpMax: derivedNumber(50)
  });
  const derivedBoolMap = keys => new F.SchemaField(Object.fromEntries(
    keys.map(key => [key, derivedBoolean(false)])
  ));
  const savedBoolMap = keys => new F.SchemaField(Object.fromEntries(
    keys.map(key => [key, new F.BooleanField({ initial: false })])
  ));
  const footsteps = () => new F.SchemaField({
    preset: new F.StringField({ initial: 'default' }),
    customPath: new F.StringField({ initial: '' })
  });
  const tokenArt = () => new F.SchemaField({
    default: new F.StringField({ initial: '' }), armored: new F.StringField({ initial: '' }),
    cavalry: new F.StringField({ initial: '' }), armoredCavalry: new F.StringField({ initial: '' }),
    flying: new F.StringField({ initial: '' })
  });
  const tokenScales = (avatar = false) => new F.SchemaField({
    default: number(1), armored: number(1), cavalry: number(1), armoredCavalry: number(1), flying: number(1),
    ...(avatar ? { avatar: number(1.25) } : {})
  });
  const tokenOffsets = () => new F.SchemaField({
    default: number(0), armored: number(0), cavalry: number(0), armoredCavalry: number(0), flying: number(0)
  });

  const statusFields = Object.fromEntries(STATUSES.map(entry => [
    entry.key,
    entry.source === 'authored' ? new F.BooleanField({ initial: false }) : derivedBoolean(false)
  ]));
  return {
    F,
    number,
    derivedNumber,
    derivedString,
    derivedBoolean,
    stat,
    ratioStat,
    formulaStat,
    statFor,
    resource,
    pool,
    skill,
    proficiency,
    derivedBoolMap,
    savedBoolMap,
    footsteps,
    tokenArt,
    tokenScales,
    tokenOffsets,
    statusFields
  };
}

/**
 * A Character's art: its avatar, its voice, its footsteps and the token sets its Classes wear.
 * @param {object} shapes   The field shapes the schema is written in.
 * @returns {object} The art schema field.
 */
function characterArtField({ F, number, footsteps, tokenArt, tokenScales, tokenOffsets }) {
  return new F.SchemaField({
    avatarScale: number(1.25, { min: 0.5, max: 3 }),
    voicePath: new F.StringField({ initial: '' }),
    footsteps: new F.SchemaField({
      onFoot: footsteps(), armored: footsteps(), mounted: footsteps(), flying: footsteps()
    }),
    tokens: tokenArt(),
    tokenScales: tokenScales(true),
    tokenOffsetsY: tokenOffsets(),
    tabs: new F.ArrayField(new F.SchemaField({
      id: new F.StringField({ initial: '' }),
      name: new F.StringField({ initial: '' }),
      avatar: new F.StringField({ initial: '' }),
      tokens: tokenArt(),
      tokenScales: tokenScales(),
      tokenOffsetsY: tokenOffsets(),
      entries: new F.ArrayField(new F.SchemaField({
        id: new F.StringField({ initial: '' }),
        name: new F.StringField({ initial: '' }),
        triggers: new F.ArrayField(new F.StringField({ initial: '' }), { initial: () => [] }),
        guards: new F.ArrayField(new F.StringField({ initial: '' }), { initial: () => [] }),
        // Comma-separated Item names the keyed conditions read (see TOKEN_ENTRY_REFERENCE_FIELDS).
        specificItemUuid: new F.StringField({ initial: '' }),
        specificAbilityIds: new F.StringField({ initial: '' }),
        specificSpellNames: new F.StringField({ initial: '' }),
        tokens: tokenArt()
      }), { initial: () => [] })
    }), { initial: () => [] })
      });
}

/**
 * A Character's turn state in the current phase: what it has left to spend and the movement plan in progress.
 * planPhaseTurnUpdates in game/combat/phases.mjs replaces it whole when a phase opens.
 * @param {object} shapes   The field shapes the schema is written in.
 * @returns {object} The turn schema field.
 */
function characterTurnField({ F, number }) {
  return new F.SchemaField({
    actionAvailable: new F.BooleanField({ initial: true }),
    bonusActionAvailable: new F.BooleanField({ initial: true }),
    movementAvailable: new F.BooleanField({ initial: true }),
    movementSpent: number(0, { min: 0 }),
    movementBonus: number(0, { integer: true, min: 0 }),
    extraActionUsed: new F.BooleanField({ initial: false }),
    traded: new F.BooleanField({ initial: false }),
    attackIndex: number(0, { integer: true, min: 0 }),
    continuationPending: new F.StringField({ initial: '' }),
    continuationRequestId: new F.StringField({ initial: '' }),
    continuationCanters: new F.BooleanField({ initial: false }),
    movementPlanning: new F.BooleanField({ initial: false }),
    canterPathfinding: new F.BooleanField({ initial: false }),
    movementControllerId: new F.StringField({ initial: '' }),
    movementAnchorX: number(0),
    movementAnchorY: number(0),
    movementPlanStartedAt: number(0, { min: 0 })
  });
}

export class CharacterDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const {
      F,
      number,
      derivedNumber,
      derivedString,
      derivedBoolean,
      stat,
      ratioStat,
      formulaStat,
      statFor,
      resource,
      pool,
      skill,
      proficiency,
      derivedBoolMap,
      savedBoolMap,
      footsteps,
      tokenArt,
      tokenScales,
      tokenOffsets,
      statusFields
    } = characterFieldShapes();

    return {
      notes: new F.SchemaField({
        biography: new F.StringField({ initial: '' }),
        gm: new F.StringField({ initial: '' })
      }),
      faction: new F.SchemaField({
        role: new F.StringField({ initial: 'Neutral' }),
        name: new F.StringField({ initial: '' }),
        color: new F.StringField({ initial: '#808080' }),
        icon: new F.StringField({ initial: '' })
      }),
      art: characterArtField({ F, number, footsteps, tokenArt, tokenScales, tokenOffsets }),
      progression: new F.SchemaField({
        level: number(1, { integer: true, min: 1 }),
        experience: number(0, { integer: true, min: 0 }),
        maxLevel: number(CHARACTER_MAX_LEVEL, { integer: true, min: 1 }),
        experienceThreshold: number(CHARACTER_EXPERIENCE_THRESHOLD, { integer: true, min: 1 })
      }),
      support: new F.SchemaField({
        affinity: new F.StringField({ initial: '' }),
        /** A bond not yet earned sits at SUPPORT_UNRANKED (-1), below rank E, and prices no better than no bond. */
        partners: new F.ArrayField(new F.SchemaField({
          actorUUID: new F.StringField({ initial: '' }),
          name: new F.StringField({ initial: '' }),
          rank: number(SUPPORT_UNRANKED, {
            integer: true, required: true, min: SUPPORT_UNRANKED, max: SUPPORT_MAX_RANK
          }),
          xp: number(0, { integer: true, required: true, min: 0 })
        }), { initial: () => [] })
      }),
      knowledge: new F.SchemaField({
        journals: new F.ArrayField(new F.StringField({ initial: '' }), { initial: () => [] }),
        recipes: new F.ArrayField(new F.StringField({ initial: '' }), { initial: () => [] }),
        songs: new F.ArrayField(new F.StringField({ initial: '' }), { initial: () => [] })
      }),
      stats: new F.SchemaField(Object.fromEntries(STATS.map(entry => [entry.key, statFor(entry)]))),
      resources: new F.SchemaField({
        hp: resource(0),
        stn: resource(0, { integer: false }),
        energy: new F.SchemaField({
          value: number(DOWNTIME_ENERGY_BASE, { integer: true, min: 0 }),
          mod: number(0, { integer: true }),
          max: derivedNumber(DOWNTIME_ENERGY_BASE)
        }),
        shields: new F.SchemaField({ value: number(0, { integer: true, min: 0 }) })
      }),
      special: new F.SchemaField({
        extraLives: pool(0), willpower: pool(0), extraActions: pool(0), dexterity: pool(0)
      }),
      statuses: new F.SchemaField(statusFields),
      combat: derivedBoolMap(COMBAT_FLAG_KEYS),
      /**
       * The counterattack mode the BG3 HUD toggle sets through api.character.setPacifist. It is persisted beside the
       * derived `combat` map, which preparation rebuilds, and projectCombatRuleFacts reads it as cannotCounter.
       */
      pacifist: new F.BooleanField({ initial: false }),
      innateUnitType: savedBoolMap(UNIT_TYPE_KEYS),
      unitType: derivedBoolMap(ALL_UNIT_TYPE_KEYS),
      growth: new F.SchemaField(Object.fromEntries(GROWTH_KEYS.map(key => [key, stat(0)]))),
      caps: new F.SchemaField(Object.fromEntries(GROWTH_KEYS.map(key => [key, stat(0)]))),
      skills: new F.SchemaField(Object.fromEntries(SKILLS.map(({ key }) => [key, skill()]))),
      prof: new F.SchemaField(Object.fromEntries(PROFICIENCIES.map(({ key }) => [key, proficiency()]))),
      saves: new F.SchemaField(Object.fromEntries(SAVE_KEYS.map(key => [key, derivedNumber(0)]))),
      facts: new F.SchemaField({
        physicalWeaponTypesCarried: derivedNumber(0),
        hasStealables: derivedBoolean(false)
      }),
      equipment: new F.SchemaField({
        slots: derivedNumber(0),
        weaponId: derivedString(''), armorId: derivedString(''), shieldId: derivedString(''),
        mountId: derivedString(''), classId: derivedString(''),
        atkStat: derivedString(''), extraAttacks: derivedNumber(0),
        noExtraAttacks: derivedBoolean(false),
        damageTypes: derivedBoolMap(DAMAGE_TYPES),
        effectiveAgainst: derivedBoolMap(ALL_UNIT_TYPE_KEYS),
        breaker: derivedBoolMap(WEAPON_PROFICIENCIES),
        prots: derivedBoolMap(DAMAGE_TYPES),
        vulns: derivedBoolMap(DAMAGE_TYPES),
        imms: derivedBoolMap(DAMAGE_TYPES)
      }),
      turn: characterTurnField({ F, number })
    };
  }
}

/* -------------------------------------------- */
/*  Difficulty changes                          */
/* -------------------------------------------- */

/**
 * Re-prepare every hostile unit when the world difficulty changes, so the new tier applies without a reload. The
 * difficulty setting's onChange (init/registrations.mjs) calls it.
 */
export function onDifficultyChanged() {
  for (const actor of globalThis.game?.actors ?? []) {
    if (!difficultyTargetActor(actor)) continue;
    actor.reset();
    actor.sheet?.render(false);
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    const actor = token.actor;
    if (!difficultyTargetActor(actor)) continue;
    if (token.document?.isLinked !== true) actor.reset();
    token.renderFlags?.set({ refreshBars: true });
  }
}

function difficultyTargetActor(actor) {
  return actor?.type === 'Character' && isDifficultyTarget(actor.system?.faction?.role);
}

/* -------------------------------------------- */
/*  Derived data preparation                    */
/* -------------------------------------------- */

/**
 * Fill a Character's derived fields from compileCharacterData, during EmblemActor#prepareDerivedData. Chance
 * modifiers use only the rolls the host's action scope supplied.
 * @returns {Readonly<object>} The drawn chance rolls this preparation replayed, by modifier key and node path.
 */
export function prepareCharacterData(actor) {
  const projected = projectCharacterSource(actor);
  const compiled = compileCharacterData(projected);
  const system = actor.system;
  assignNodes(system.stats, compiled.stats);
  assignNodes(system.growth, compiled.growth);
  assignNodes(system.caps, compiled.caps);
  assignNodes(system.skills, compiled.skills);
  assignNodes(system.prof, compiled.prof);
  Object.assign(system.unitType, compiled.unitType);
  Object.assign(system.statuses, compiled.statuses);
  Object.assign(system.combat, compiled.combat);
  Object.assign(system.saves, compiled.saves);
  Object.assign(system.facts, compiled.facts);
  Object.assign(system.resources.hp, compiled.resources.hp);
  Object.assign(system.resources.stn, compiled.resources.stn);
  Object.assign(system.resources.energy, compiled.resources.energy);
  Object.assign(system.equipment, compiled.equipment);
  for (const [key, pool] of Object.entries(compiled.special)) {
    if (system.special[key]) system.special[key].max = pool.max;
  }
  return Object.freeze(projected.modifierContext.chanceRolls ?? {});
}

/* -------------------------------------------- */
/*  Preparation helpers                         */
/* -------------------------------------------- */

function assignNodes(target, compiled) {
  for (const [key, node] of Object.entries(compiled)) {
    if (target[key]) Object.assign(target[key], node);
  }
}
