/** @layer contracts/domains */
import { DAMAGE_TYPES } from './damage.mjs';

/* -------------------------------------------- */
/*  Stat vocabulary                             */
/* -------------------------------------------- */

/** Every stat. Its `key` is both the schema key and the name authors write. */
export const STATS = Object.freeze([
  { key: 'hpMax', label: 'Max HP', growth: 'hp', short: 'HP' },
  { key: 'stnMax', label: 'Max Stance', short: 'Stn' },
  { key: 'stnRegen', label: 'Stance Regen', short: 'Stn Regen', base: 3 },
  { key: 'mov', label: 'Movement', short: 'Mov' },
  { key: 'bld', label: 'Build' , short: 'Bld' },
  { key: 'mgt', label: 'Might', growth: 'mgt' , short: 'Mgt' },
  { key: 'agi', label: 'Agility', growth: 'agi' , short: 'Agi' },
  { key: 'tqn', label: 'Technique', growth: 'tqn' , short: 'Tqn' },
  { key: 'wit', label: 'Wit', growth: 'wit' , short: 'Wit' },
  { key: 'cha', label: 'Charisma', growth: 'cha' , short: 'Cha' },
  { key: 'def', label: 'Defense', growth: 'def' , short: 'Def' },
  { key: 'res', label: 'Resistance', growth: 'res' , short: 'Res' },
  { key: 'wgt', label: 'Weight' , short: 'Wgt' },
  { key: 'rng', label: 'Range', kind: 'formula' , short: 'Rng' },
  { key: 'eva', label: 'Evasion' , short: 'Eva' },
  { key: 'acc', label: 'Accuracy' , short: 'Acc' },
  { key: 'spd', label: 'Speed' , short: 'Spd' },
  { key: 'crit', label: 'Critical' , short: 'Crit' },
  { key: 'atk', label: 'Attack', kind: 'formula' , short: 'Atk' },
  { key: 'brk', label: 'Break' , short: 'Brk' },
  { key: 'critDmg', label: 'Crit Damage', kind: 'ratio' , short: 'Crit Dmg' },
  { key: 'critRed', label: 'Crit Reduction' , short: 'Crit Red.' },
  { key: 'brkRed', label: 'Break Reduction' , short: 'Brk Red.' },
  { key: 'wgtRed', label: 'Weight Reduction' , short: 'Weight Red.' },
  { key: 'sight', label: 'Sight Bonus (squares)', short: 'Sight' },
  { key: 'expMultiplier', label: 'XP Multiplier (%)', short: 'XP %', base: 100 }
]);

/** Stats that carry a growth rate and a cap. */
export const GROWTH_KEYS = Object.freeze(['hp', 'mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res']);

/** Stat components an author may read, e.g. `stats.mgt.aura`. */
const STAT_LEAVES = Object.freeze(['base', 'class', 'item', 'passive', 'mod', 'penalty', 'aura']);

/**
 * The stat components a modifier may write by name (plus `override` on a formula stat). Character preparation
 * works out the others and would overwrite them. A bare stat name such as `mgt` writes the `passive` component.
 */
const WRITABLE_STAT_LEAVES = Object.freeze(['mod', 'penalty']);

/** The component a formula stat's total uses instead when it's set: a whole authored formula or range, e.g. `"3-3"`. */
const FORMULA_OVERRIDE_LEAF = 'override';

/* -------------------------------------------- */
/*  Statuses                                    */
/* -------------------------------------------- */

/** Status vocabulary shared by character preparation, effect authoring and game rules. */
export const STATUSES = Object.freeze([
  { key: 'airborne', label: 'Is flying (aloft now)', source: 'structural' },
  { key: 'grounded', label: 'Is grounded', source: 'authored' },
  { key: 'mounted', label: 'Is mounted', source: 'structural' },
  { key: 'stanceBroken', label: 'Stance broken', source: 'structural' },
  { key: 'guarding', label: 'Is guarding an ally', source: 'effect' },
  { key: 'passing', label: 'Can pass through others', source: 'effect' },
  { key: 'passable', label: 'Others can pass through', source: 'effect' },
  { key: 'blessed', label: 'Blessed', source: 'effect', registered: true },
  { key: 'sanctuary', label: 'Sanctuary', source: 'effect', registered: true },
  { key: 'truestrike', label: 'Truestrike', source: 'effect', registered: true },
  { key: 'sneak', label: 'Sneak', source: 'effect', registered: true },
  { key: 'charged', label: 'Charged', source: 'effect', registered: true },
  { key: 'shine', label: 'Shine', source: 'effect', registered: true },
  { key: 'marked', label: 'Marked', source: 'effect', registered: true },
  { key: 'taunted', label: 'Taunted', source: 'effect', registered: true },
  { key: 'flanked', label: 'Flanked', source: 'effect', registered: true },
  { key: 'unbalanced', label: 'Unbalanced', source: 'effect', registered: true },
  { key: 'restrained', label: 'Restrained', source: 'effect', registered: true },
  { key: 'frozen', label: 'Frozen', source: 'effect', registered: true },
  { key: 'stunned', label: 'Stunned', source: 'effect', registered: true },
  { key: 'fear', label: 'Fear', source: 'effect', registered: true },
  { key: 'bleeding', label: 'Bleeding', source: 'effect', registered: true },
  { key: 'poisoned', label: 'Poisoned', source: 'effect', registered: true },
  { key: 'silenced', label: 'Silenced', source: 'effect', registered: true },
  { key: 'blinded', label: 'Blinded', source: 'effect', registered: true },
  { key: 'bane', label: 'Bane', source: 'effect' },
  { key: 'drunk', label: 'Drunk', source: 'effect' },
  { key: 'uncannyDodge', label: 'Uncanny Dodge', source: 'effect' },
  { key: 'lastStand', label: 'Last Stand', source: 'effect' },
  { key: 'devourTheLiving', label: 'Devour the Living', source: 'effect' }
]);

export const STATUS_KEYS = Object.freeze(STATUSES.map(entry => entry.key));
export const DEFAULT_STATUS_DURATION = 1;

/**
 * The turn fields a movement plan writes as bookkeeping when a unit is picked up or put down.
 */
export const MOVEMENT_PLAN_PATHS = Object.freeze([
  'system.turn.movementPlanning',
  'system.turn.movementControllerId',
  'system.turn.movementAnchorX',
  'system.turn.movementAnchorY',
  'system.turn.movementPlanStartedAt'
]);
export const BLEEDING_STATUS_ID = 'Bleeding';

/** The statuses that carry art and can be applied as a Foundry status. */
export const REGISTERED_STATUS_KEYS = Object.freeze(
  STATUSES.filter(entry => entry.registered === true).map(entry => entry.key)
);

/**
 * Reduce a status name, effect name, status id or registry key to lower-case letters and digits, so any two of them
 * compare: "Last Stand", "last-stand" and "LastStand" are one key.
 * @param {unknown} value
 * @returns {string}
 */
export function statusKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* -------------------------------------------- */
/*  Combat flags                                */
/* -------------------------------------------- */

/**
 * Passive capabilities items or effects grant, set under `combat` on the unit. Most are combat rules, but movement,
 * map, token and audio code read Levitation too.
 */
const COMBAT_FLAGS = Object.freeze([
  { key: 'canter', label: 'Canter' },
  { key: 'multiAttack', label: 'Multi-Attack' },
  { key: 'adaptive', label: 'Adaptive' },
  { key: 'counterlock', label: 'Counterlock' },
  { key: 'outflank', label: 'Outflank' },
  { key: 'impervious', label: 'Impervious' },
  { key: 'firstStrike', label: 'First Strike' },
  { key: 'magicSaveAdvantage', label: 'Magic Save Advantage' },
  { key: 'levitation', label: 'Levitation' },
  { key: 'cannotCounter', label: 'Cannot counter' },
  { key: 'cannotBeCountered', label: 'Cannot be countered' },
  { key: 'critDefenseBreak', label: 'Crit halves Def' }
]);

export const COMBAT_FLAG_KEYS = Object.freeze(COMBAT_FLAGS.map(entry => entry.key));

/** How a unit reaches its current foe: adjacent within one floor of height, or anything further or higher. */
export const ENGAGEMENT_KINDS = Object.freeze({ MELEE: 'melee', RANGED: 'ranged' });

/** Engagement kinds as the literals an authored `distance` or `engagement` compare accepts. */
export const ENGAGEMENT_CHOICES = Object.freeze(Object.values(ENGAGEMENT_KINDS));

/* -------------------------------------------- */
/*  Unit types                                  */
/* -------------------------------------------- */

export const UNIT_TYPES = Object.freeze([
  { key: 'infantry', label: 'Infantry' },
  { key: 'armored', label: 'Armored' },
  { key: 'cavalry', label: 'Cavalry' },
  { key: 'flying', label: 'Flier (can fly)' },
  { key: 'dragon', label: 'Dragon' },
  { key: 'beast', label: 'Beast' },
  { key: 'monster', label: 'Monster' },
  { key: 'undead', label: 'Undead' }
]);

export const UNIT_TYPE_KEYS = Object.freeze(UNIT_TYPES.map(entry => entry.key));

/** The unit type no sheet draws: a wielded Spell or an effect grants it, and effectiveness and conditions read it. */
const HIDDEN_UNIT_TYPES = Object.freeze([{ key: 'magic', label: 'Is magical' }]);

/** Every unit type a unit can carry, drawn or not. */
export const ALL_UNIT_TYPE_KEYS = Object.freeze([...UNIT_TYPES, ...HIDDEN_UNIT_TYPES].map(entry => entry.key));

/** Unit types a Class item may grant. A Class cannot make a unit armored, mounted or airborne. */
export const CLASS_UNIT_TYPE_KEYS = Object.freeze(['infantry', 'dragon', 'monster', 'beast', 'undead']);

/* -------------------------------------------- */
/*  Skills, proficiencies, saves                */
/* -------------------------------------------- */

export const SKILLS = Object.freeze([
  { key: 'athletics', label: 'Athletics', stat: 'mgt' },
  { key: 'finesse', label: 'Finesse', stat: 'agi' },
  { key: 'trading', label: 'Trading', stat: 'cha' },
  { key: 'civics', label: 'Civics', stat: 'wit' },
  { key: 'handicraft', label: 'Handicraft', stat: 'tqn' },
  { key: 'sociability', label: 'Sociability', stat: 'cha' },
  { key: 'command', label: 'Command', stat: 'cha' },
  { key: 'nature', label: 'Nature', stat: 'tqn' },
  { key: 'perception', label: 'Perception', stat: 'tqn' },
  { key: 'performance', label: 'Performance', stat: 'cha' },
  { key: 'reason', label: 'Reason', stat: 'wit' },
  { key: 'esoteric', label: 'Esoteric', stat: 'cha' }
]);

export const PROFICIENCIES = Object.freeze([
  { key: 'brawling', label: 'Brawling', icon: 'prof-brawling' },
  { key: 'blade', label: 'Blade', icon: 'prof-blade' },
  { key: 'polearm', label: 'Polearm', icon: 'prof-polearm' },
  { key: 'heavy', label: 'Heavy', icon: 'prof-heavy' },
  { key: 'bow', label: 'Bow', icon: 'prof-bow' },
  { key: 'covert', label: 'Covert', icon: 'prof-covert' },
  { key: 'arcane', label: 'Arcane', icon: 'prof-arcane' },
  { key: 'elemental', label: 'Elemental', icon: 'prof-element' },
  { key: 'divine', label: 'Divine', icon: 'prof-divine' },
  { key: 'occult', label: 'Occult', icon: 'prof-occult' },
  { key: 'armor', label: 'Armor', icon: 'prof-armor', misc: true },
  { key: 'riding', label: 'Riding', icon: 'prof-riding', misc: true }
]);

/** Attributes that can carry a saving-throw modifier. */
export const SAVE_KEYS = Object.freeze(['mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res']);

/* -------------------------------------------- */
/*  Turn state                                  */
/* -------------------------------------------- */

export const TURN_FACTS = Object.freeze([
  { key: 'hasAction', label: 'Has an unspent action', kind: 'boolean' },
  { key: 'hasBonusAction', label: 'Has an unspent bonus action', kind: 'boolean' },
  { key: 'hasMovement', label: 'Has movement left', kind: 'boolean' },
  { key: 'hasMoved', label: 'Has moved this phase', kind: 'boolean' },
  { key: 'usedExtraAction', label: 'Has used an Extra Action', kind: 'boolean' },
  { key: 'attackIndex', label: 'Attack index (0 = first hit)', kind: 'number' },
  { key: 'movementSpent', label: 'Squares moved this turn', kind: 'number' }
]);

/* -------------------------------------------- */
/*  Resources and special pools                 */
/* -------------------------------------------- */

/** Current-and-maximum pairs, read as `hp` and `maxHp`. */
const RESOURCES = Object.freeze([
  { key: 'hp', max: 'maxHp', label: 'HP' },
  { key: 'stn', max: 'maxStn', label: 'Stance' }
]);

export const SPECIAL_POOLS = Object.freeze([
  { key: 'willpower', max: 'maxWillpower', label: 'Willpower' },
  { key: 'extraActions', max: 'maxExtraActions', label: 'Extra Actions' },
  { key: 'dexterity', max: 'maxDexterity', label: 'Dexterity' },
  { key: 'extraLives', max: 'maxExtraLives', label: 'Extra Lives' }
]);

/* -------------------------------------------- */
/*  Faction roles                               */
/* -------------------------------------------- */

export const FACTION_ROLES = Object.freeze(['Lord', 'Retainer', 'Ally', 'Enemy', 'Boss', 'Neutral']);

/** The three relation groups every authored faction role belongs to. One side is one group. */
export const FACTION_GROUPS = Object.freeze({
  player: Object.freeze(['Lord', 'Retainer', 'Ally']),
  enemy: Object.freeze(['Enemy', 'Boss']),
  neutral: Object.freeze(['Neutral'])
});

/**
 * The flag, under the system's flags on a status's ActiveEffect, that holds what a change faction step tied to that
 * status changed on the unit, so it can be changed back when the status is deleted (game/effects/faction-links.mjs).
 */
export const FACTION_LINK_FLAG = 'factionLink';

/** The player-owned unit factions. An Ally fights on their side but isn't one of them. */
export const OWNED_UNIT_FACTIONS = Object.freeze(['Lord', 'Retainer']);

/** Weapon families as authored on `weapon.req`, which is capitalized. */
const WEAPON_FAMILIES = Object.freeze([
  'Brawling', 'Blade', 'Polearm', 'Heavy', 'Bow', 'Covert', 'Arcane', 'Elemental', 'Divine', 'Occult'
]);

/** Armor weight classes as authored on `armor.req`. */
const ARMOR_CLASSES = Object.freeze(['None', 'Light', 'Medium', 'Heavy']);

/* -------------------------------------------- */
/*  Context roots                               */
/* -------------------------------------------- */

/** The names a condition may use as a root. A bare name reads from `self`. */
export const CONTEXT_ROOTS = Object.freeze([
  { key: 'self', label: 'This unit' },
  { key: 'target', label: 'Target' },
  { key: 'caster', label: 'Caster' }
]);

/* -------------------------------------------- */
/*  The table                                   */
/* -------------------------------------------- */

function statEntries() {
  return STATS.map(stat => ({
    name: stat.key,
    group: 'Stats',
    label: `${stat.label} (total)`,
    kind: stat.kind === 'formula' ? 'text' : 'number',
    target: `stats.${stat.key}.passive`
  }));
}

function statLeafEntries() {
  const rows = [];
  for (const stat of STATS) {
    for (const leaf of STAT_LEAVES) {
      rows.push({
        name: `stats.${stat.key}.${leaf}`,
        group: 'Stat components',
        label: `${stat.label}: ${leaf}`,
        kind: 'number',
        target: WRITABLE_STAT_LEAVES.includes(leaf) ? `stats.${stat.key}.${leaf}` : undefined,
        advanced: true
      });
    }
    if (stat.kind !== 'formula') continue;
    rows.push({
      name: `stats.${stat.key}.${FORMULA_OVERRIDE_LEAF}`,
      group: 'Stat components',
      label: `${stat.label}: ${FORMULA_OVERRIDE_LEAF}`,
      kind: 'text',
      target: `stats.${stat.key}.${FORMULA_OVERRIDE_LEAF}`,
      advanced: true
    });
  }
  return rows;
}

function resourceEntries() {
  const rows = [];
  for (const resource of RESOURCES) {
    rows.push({ name: resource.key, group: 'Life', label: `${resource.label} (current)`, kind: 'number' });
    rows.push({ name: resource.max, group: 'Life', label: `${resource.label} (max)`, kind: 'number' });
  }
  rows.push({ name: 'shields', group: 'Life', label: 'Shield points', kind: 'number' });
  rows.push({ name: 'level', group: 'Life', label: 'Level', kind: 'number' });
  rows.push({ name: 'exp', group: 'Life', label: 'Experience', kind: 'number' });
  return rows;
}

function specialEntries() {
  return SPECIAL_POOLS.flatMap(pool => [
    { name: pool.key, group: 'Special', label: `${pool.label} (current)`, kind: 'number' },
    {
      name: pool.max, group: 'Special', label: `${pool.label} (max)`, kind: 'number',
      target: `special.${pool.key}.max`, grants: true
    }
  ]);
}

/** Unit types, read as bare names. As a modifier target, each sets or clears a type compileCharacterData worked out. */
function unitTypeEntries() {
  return [...UNIT_TYPES, ...HIDDEN_UNIT_TYPES].map(type => ({
    name: type.key, group: 'Unit type', label: type.label, kind: 'boolean', target: `unitType.${type.key}`
  }));
}

function statusEntries() {
  return STATUSES.map(status => ({
    name: status.key,
    group: 'Status',
    label: status.label,
    kind: 'boolean',
    target: status.source === 'effect' ? `statuses.${status.key}` : undefined
  }));
}

function combatFlagEntries() {
  return COMBAT_FLAGS.map(flag => ({
    name: `combat.${flag.key}`, group: 'Combat flags', label: flag.label, kind: 'boolean',
    target: `combat.${flag.key}`
  }));
}

function turnEntries() {
  return TURN_FACTS.map(fact => ({ name: fact.key, group: 'Turn', label: fact.label, kind: fact.kind }));
}

function skillEntries() {
  return [
    ...SKILLS.map(skill => ({
      name: `skills.${skill.key}`, group: 'Skills', label: skill.label, kind: 'number',
      target: `skills.${skill.key}.passive`
    })),
    ...PROFICIENCIES.map(prof => ({
      name: `prof.${prof.key}`, group: 'Proficiencies', label: prof.label, kind: 'number',
      target: `prof.${prof.key}.passive`
    })),
    ...SAVE_KEYS.map(key => ({
      name: `saves.${key}`, group: 'Saves', label: `${key.toUpperCase()} save modifier`, kind: 'number',
      target: `saves.${key}`
    })),
    ...GROWTH_KEYS.map(key => ({
      name: `growth.${key}`, group: 'Growth', label: `${key.toUpperCase()} growth rate`, kind: 'number',
      target: `growth.${key}.passive`
    })),
    ...GROWTH_KEYS.map(key => ({
      name: `caps.${key}`, group: 'Growth', label: `${key.toUpperCase()} cap`, kind: 'number',
      target: `caps.${key}.passive`
    }))
  ];
}

/**
 * A protection, a vulnerability and an immunity per damage type. As a modifier target, each sets its flag on or off.
 * compileCharacterData ranks a protection or vulnerability modifier above worn armor and below an effect's override.
 */
function damageTypeEntries() {
  return DAMAGE_TYPES.flatMap(type => [
    {
      name: `prots.${type}`, group: 'Damage types', label: `Protections: ${type}`, kind: 'boolean',
      target: `equipment.prots.${type}`
    },
    {
      name: `vulns.${type}`, group: 'Damage types', label: `Vulnerabilities: ${type}`, kind: 'boolean',
      target: `equipment.vulns.${type}`
    },
    {
      name: `imms.${type}`, group: 'Damage types', label: `Immune to ${type}`, kind: 'boolean',
      target: `equipment.imms.${type}`
    }
  ]);
}

function gearEntries() {
  return [
    { name: 'weapon', group: 'Gear', label: 'Has a wielded weapon', kind: 'object' },
    { name: 'weapon.type', group: 'Gear', label: 'Wielded weapon type', kind: 'text', choices: WEAPON_FAMILIES },
    { name: 'weapon.name', group: 'Gear', label: 'Wielded weapon name', kind: 'text' },
    { name: 'weapon.twoHanded', group: 'Gear', label: 'Wielded weapon is two-handed', kind: 'boolean' },
    { name: 'weapon.itemType', group: 'Gear', label: 'Wielded item type', kind: 'text' },
    { name: 'weapon.wgt', group: 'Gear', label: 'Wielded weapon weight', kind: 'number' },
    { name: 'armor', group: 'Gear', label: 'Is wearing armor', kind: 'object' },
    { name: 'armor.type', group: 'Gear', label: 'Armor weight class', kind: 'text', choices: ARMOR_CLASSES },
    { name: 'armor.wgt', group: 'Gear', label: 'Worn armor weight', kind: 'number' },
    { name: 'shield', group: 'Gear', label: 'Has a shield', kind: 'object' },
    { name: 'shield.type', group: 'Gear', label: 'Shield weight class', kind: 'text', choices: ARMOR_CLASSES },
    { name: 'shield.wgt', group: 'Gear', label: 'Equipped shield weight', kind: 'number' },
    { name: 'mount', group: 'Gear', label: 'Has a mount', kind: 'object' },
    { name: 'class', group: 'Gear', label: 'Has a class', kind: 'object' },
    { name: 'class.name', group: 'Gear', label: 'Class name', kind: 'text' },
    { name: 'class.tier', group: 'Gear', label: 'Class tier', kind: 'text' },
    {
      name: 'equipmentSlots', group: 'Gear', label: 'Equipment slots', kind: 'number',
      target: 'equipment.slots'
    }
  ];
}

function identityEntries() {
  return [
    { name: 'name', group: 'Identity', label: 'Unit name', kind: 'text' },
    { name: 'uuid', group: 'Identity', label: 'Unit uuid', kind: 'text' },
    { name: 'faction', group: 'Identity', label: 'Faction role', kind: 'text', choices: FACTION_ROLES },
    { name: 'size', group: 'Identity', label: 'Token size (squares)', kind: 'number' }
  ];
}

function combatFactEntries() {
  return [
    { name: 'distance', group: 'Combat facts', label: 'Distance to the current foe', kind: 'number', bareOnly: true },
    {
      name: 'engagement', group: 'Combat facts', label: 'Engagement with the current foe', kind: 'text',
      choices: ENGAGEMENT_CHOICES, bareOnly: true
    },
    {
      name: 'inMeleeRange', group: 'Combat facts',
      label: 'Is in melee reach (adjacent, within a floor)', kind: 'boolean'
    },
    { name: 'attacking', group: 'Combat facts', label: 'Is attacking', kind: 'boolean', bareOnly: true },
    { name: 'defending', group: 'Combat facts', label: 'Is defending', kind: 'boolean', bareOnly: true },
    { name: 'usingWeaponArt', group: 'Combat facts', label: 'Is using a Weapon Art', kind: 'boolean', bareOnly: true },
    { name: 'targetSlain', group: 'Combat facts', label: 'The attack slew its target', kind: 'boolean', bareOnly: true },
    {
      name: 'physicalWeaponTypesCarried', group: 'Combat facts',
      label: 'Physical weapon families carried', kind: 'number', bareOnly: true
    },
    {
      name: 'hasStealables', group: 'Combat facts',
      label: 'Carries something stealable', kind: 'boolean', bareOnly: true
    }
  ];
}

/** Every name an author can use, in one flat list. The name is also the path a condition reads the value from. */
const VOCABULARY = Object.freeze([
  ...identityEntries(),
  ...resourceEntries(),
  ...statEntries(),
  ...specialEntries(),
  ...unitTypeEntries(),
  ...statusEntries(),
  ...combatFlagEntries(),
  ...turnEntries(),
  ...gearEntries(),
  ...damageTypeEntries(),
  ...skillEntries(),
  ...combatFactEntries(),
  ...statLeafEntries()
].map(entry => Object.freeze(entry)));

/**
 * Lookup by authored name. Treat it as read-only: freezing a Map doesn't block set or delete.
 * @type {ReadonlyMap<string, object>}
 */
export const VOCABULARY_BY_NAME = Object.freeze(new Map(VOCABULARY.map(entry => [entry.name, entry])));

/** Writable names mapped to the schema path each reaches. @type {ReadonlyMap<string, string>} */
const WRITABLE_TARGETS = Object.freeze(new Map(
  VOCABULARY.filter(entry => typeof entry.target === 'string').map(entry => [entry.name, entry.target])
));

/**
 * Resolve an authored modifier target to the schema path it writes.
 * @param {string} name Authored name, e.g. `atk` or `stats.mgt.penalty`.
 * @returns {string|null} Schema path under `system`, or null when the name is not writable.
 */
export function resolveTarget(name) {
  return WRITABLE_TARGETS.get(String(name ?? '').trim()) ?? null;
}

/* -------------------------------------------- */
/*  Editor grouping                             */
/* -------------------------------------------- */

/**
 * Build the condition editor's option groups in render order (ui/apps/sheets/item/editors/conditions.mjs).
 * @returns {ReadonlyArray<object>}
 */
export function pickerGroups() {
  const order = [
    'Identity', 'Life', 'Stats', 'Special', 'Unit type', 'Status', 'Combat flags',
    'Turn', 'Gear', 'Damage types', 'Skills', 'Proficiencies', 'Saves', 'Growth',
    'Combat facts', 'Stat components'
  ];
  return Object.freeze(order.map(group => Object.freeze({
    id: group.toLowerCase().replace(/\s+/g, '-'),
    label: group,
    entries: Object.freeze(VOCABULARY.filter(entry => entry.group === group))
  })).filter(group => group.entries.length > 0));
}
