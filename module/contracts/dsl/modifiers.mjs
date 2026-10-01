/** @layer contracts/dsl */
import { isPlainObject } from '../../lib/core/runtime.mjs';
import { resolveTarget } from '../domains/characters.mjs';
import { ITEM_SUBTYPES } from '../domains/items.mjs';
import { conditionPaths, expressionPaths, hasConditionTree, validate as validateCondition } from './conditions.mjs';
import { say, warn } from './messages.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** Facts that hold only inside an exchange. A modifier that reads one applies only in combat. */
const COMBAT_FACTS = Object.freeze([
  'target', 'distance', 'engagement', 'inMeleeRange', 'attacking', 'defending', 'usingWeaponArt', 'attackIndex'
]);

/** Turn facts that change as the unit moves, so an allowance gated on them collapses after the first leg. */
const MOVEMENT_FACTS = Object.freeze(['movementSpent', 'hasMoved', 'hasMovement']);

/** Combat flags that decide the order of blows, which the exchange preview reads before the first one. */
const SEQUENCE_FLAGS = Object.freeze([
  'multiAttack', 'firstStrike', 'counterlock', 'cannotCounter', 'cannotBeCountered'
]);

/** Roots that read the modifier's own unit. */
const SELF_ROOTS = Object.freeze(['self', 'caster', 'actor']);

/** Item subtypes whose item can be wielded, worn or equipped. */
const EQUIPPABLE_SUBTYPES = Object.freeze(['Weapon', 'Staff', 'Attack', 'Armor', 'Shield', 'Accessory', 'Mount']);

/** Item subtypes that are never the active item. */
const NEVER_ACTIVE_SUBTYPES = Object.freeze(['Passive', 'Armor', 'Shield', 'Accessory']);

/** Item subtypes that are used rather than worn, whose modifiers otherwise apply while the item sits in the bag. */
const USED_SUBTYPES = Object.freeze(['Active', 'Weapon Art', 'Consumable', ...ITEM_SUBTYPES.Consumable]);

/** Read names that reach the same stat as a written one under another name. */
const READ_ALIASES = Object.freeze({ maxHp: 'stats.hpMax', maxStn: 'stats.stnMax' });

/** How the protection, weakness and immunity lists read in a message. */
const DEFENCE_LIST_WORDS = Object.freeze({ prots: 'protections', vulns: 'weaknesses', imms: 'immunities' });

/** Every message here is about the one modifier being edited. */
const MODIFIER = 'this modifier';

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */
/**
 * Validate one item modifier against the authoring rules: its condition tree on the modifier or aura surface, the
 * stats a combat-only or turn-state condition may not write, the equip and activation flags for the item's subtype,
 * and an aura's numeric quantity. Reading the stat it writes is a warning.
 * @param {object} modifier
 * @param {{itemType?: string, kind?: string, knownStatuses?: string[]}} [options] `itemType` is the item's subtype,
 *   or its document type where it has none; `kind` defaults to the modifier's own.
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateModifier(modifier, { itemType = '', kind, knownStatuses = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(modifier)) return { valid: false, errors: [say(MODIFIER, 'cannot be read')], warnings };
  const aura = (kind ?? modifier.kind) === 'aura';
  const tree = hasConditionTree(modifier.conditionTree) ? modifier.conditionTree : null;
  if (tree) {
    const result = validateCondition(tree, {
      path: 'conditionTree', surface: aura ? 'aura' : 'modifier', knownStatuses
    });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  const reads = [...(tree ? conditionPaths(tree) : []), ...quantityPaths(modifier.quantity)];
  const name = String(modifier.target ?? '').trim();
  const written = resolveTarget(name) ?? name.replace(/^system\./, '');
  const [root, key] = written.split('.');
  const stat = root === 'stats' ? key : null;

  // An aura's condition reads the receiver as its target, so only a standard modifier becomes combat-only.
  if (!aura) {
    const combat = [...new Set(reads.filter(readsCombat))];
    const family = combatOnlyFamily(written, stat, modifier.quantity);
    if (combat.length && family) {
      const gate = tree && conditionPaths(tree).some(readsCombat)
        ? 'its condition only holds in combat'
        : 'its amount reads facts that only exist in combat';
      const verb = /s$/.test(family) ? 'are' : 'is';
      errors.push(say(MODIFIER, `changes ${family} but ${gate}. `
        + `${family.charAt(0).toUpperCase()}${family.slice(1)} ${verb} read outside combat too`));
    }
    const own = reads.map(ownFact);
    const movement = MOVEMENT_FACTS.filter(fact => own.includes(fact));
    if (movement.length && stat === 'mov') {
      errors.push(say(MODIFIER, 'changes movement but its condition depends on how the unit has moved this turn. '
        + 'The allowance would change as the unit moves'));
    }
    if (own.includes('attackIndex') && (stat === 'spd' || (root === 'combat' && SEQUENCE_FLAGS.includes(key)))) {
      const what = stat === 'spd' ? 'speed' : 'the order of attacks';
      errors.push(say(MODIFIER, `changes ${what} but its condition reads which attack this is. The follow up `
        + 'attacks the preview promised would vanish'));
    }
  }

  const writtenKey = statKey(written);
  const selfRead = writtenKey && reads.find(path => readKey(path) === writtenKey);
  if (selfRead) {
    warnings.push(warn(MODIFIER, 'reads the same stat it changes. It sees the value from before the modifier '
      + 'applies'));
  }

  if (modifier.requiresEquipped === true) {
    if (aura) errors.push(say(MODIFIER, 'is an aura, so it cannot require the item to be equipped'));
    else if (itemType && !EQUIPPABLE_SUBTYPES.includes(itemType)) {
      errors.push(say(MODIFIER, 'requires the item to be equipped, but this kind of item is never equipped'));
    }
  }
  if (modifier.requiresActivation === true && NEVER_ACTIVE_SUBTYPES.includes(itemType)) {
    errors.push(say(MODIFIER, 'requires the item to be active, but this kind of item is never the active item'));
  }
  if (!aura && modifier.requiresActivation !== true && USED_SUBTYPES.includes(itemType)) {
    warnings.push(warn(MODIFIER, 'does not require activation, so it applies while the item sits in the bag'));
  }
  if (aura && !isNumericQuantity(modifier.quantity)) {
    errors.push(say(MODIFIER, 'is an aura, so its amount must be a plain number'));
  }
  return { valid: errors.length === 0, errors, warnings };
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
/** The paths a quantity expression reads. A number, boolean or quoted string reads nothing. */
function quantityPaths(quantity) {
  if (typeof quantity !== 'string') return [];
  const text = quantity.trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text) || text === 'true' || text === 'false' || /^(['"]).*\1$/s.test(text)) return [];
  return expressionPaths(text);
}

/** A path with any root naming the unit itself removed, e.g. `self.hasMoved` becomes `hasMoved`. */
function ownFact(path) {
  const segments = path.split('.');
  return SELF_ROOTS.includes(segments[0]) ? segments.slice(1).join('.') : path;
}

/** Whether a read path needs a combat context: the target, a target shorthand, or a combat fact. */
function readsCombat(path) {
  const fact = ownFact(path);
  const [first] = fact.split('.');
  return COMBAT_FACTS.includes(first) || /^target[A-Z]/.test(first);
}

/** The stat family a combat-only modifier may not write, in the words the error uses, or null. */
function combatOnlyFamily(written, stat, quantity) {
  const [root, key, leaf] = written.split('.');
  if (stat === 'mov') return 'movement';
  if (stat === 'rng') return 'range';
  if ((stat === 'hpMax' || stat === 'stnMax') && isNegative(quantity)) return stat === 'hpMax' ? 'max HP' : 'max stance';
  if (root === 'growth') return 'growth rates';
  if (root === 'caps') return 'stat caps';
  if (stat === 'expMultiplier') return 'experience gain';
  if (root === 'special' && leaf === 'max') return 'a special maximum';
  if (written === 'equipment.slots') return 'equipment slots';
  // Status flags a modifier grants are compiled facts, not document writes, so combat may gate them.
  if (root === 'unitType') return 'unit type';
  // Combat flags only matter in combat, except Levitation, which also makes the unit fly on the map.
  if (root === 'combat' && key === 'levitation') return 'levitation';
  if (root === 'equipment' && Object.hasOwn(DEFENCE_LIST_WORDS, key)) return DEFENCE_LIST_WORDS[key];
  return null;
}

function isNegative(quantity) {
  if (typeof quantity === 'number') return quantity < 0;
  return typeof quantity === 'string' && quantity.trim().startsWith('-');
}

function isNumericQuantity(quantity) {
  if (typeof quantity === 'number') return Number.isFinite(quantity);
  return typeof quantity === 'string' && quantity.trim() !== '' && Number.isFinite(Number(quantity));
}

/** The stat a schema path writes, such as `stats.mgt` for `stats.mgt.mod`, or the path itself for a flag. */
function statKey(written) {
  if (!written) return null;
  const parts = written.split('.');
  if (parts[0] === 'stats') return parts.slice(0, 2).join('.');
  return parts.at(-1) === 'passive' ? parts.slice(0, -1).join('.') : written;
}

/** The stat a read path reaches on the modifier's own unit, in statKey's form, or null. */
function readKey(path) {
  if (path.split('.')[0] === 'target') return null;
  const fact = ownFact(path);
  const shorthand = /^(?:self|caster)([A-Z]\w*)$/.exec(fact);
  const name = shorthand ? `${shorthand[1].charAt(0).toLowerCase()}${shorthand[1].slice(1)}` : fact;
  if (READ_ALIASES[name]) return READ_ALIASES[name];
  if (name.startsWith('stats.')) return name.split('.').slice(0, 2).join('.');
  const target = resolveTarget(name);
  return target ? statKey(target) : null;
}
