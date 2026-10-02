/** @layer game/effects */
import { STATS } from '../../contracts/domains/characters.mjs';
import { GUARD_BOND_REFUSALS, GUARD_BOND_ROLES } from '../../contracts/domains/combat.mjs';
import {
  EFFECT_PLAN_ERRORS,
  effectCarrier,
  isPopulated as actionIsPopulated,
  validateEffectEntry
} from '../../contracts/dsl/effects.mjs';
import { isEmpty as conditionIsEmpty } from '../../contracts/dsl/conditions.mjs';
import { chanceNodePaths, evaluate as evaluateConditionTree } from './conditions.mjs';
import { SafeEval } from '../../lib/core/safe-eval.mjs';
import { canonicalJson, digest } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Operation vocabulary                        */
/* -------------------------------------------- */

const PRESENTATION_STEPS = new Set([
  'animation', 'floatingText', 'playVoice', 'playResist', 'refreshPathfinding'
]);
const CONTROL_STEPS = new Set(['wait', 'expr']);

/** Choose the channel engine/effects/execution.mjs uses to execute a planned step. */
function effectOperationChannel(kind) {
  if (PRESENTATION_STEPS.has(kind)) return 'presentation';
  if (CONTROL_STEPS.has(kind)) return 'control';
  return 'mechanical';
}

/**
 * Turn an authored amount into a fixed number, or into a dice formula for the Foundry dice adapter to roll, for
 * engine/effects/execution.mjs. Embedded expressions and shorthands such as casterMgt are filled in first. A
 * `${...}` expression that fails becomes 0.
 */
export function resolveEffectAmountFormula(value, context = {}) {
  if (typeof value === 'number') return { fixed: value, formula: String(value) };
  if (typeof value !== 'string' || !value.trim()) return { fixed: 0, formula: '0' };
  let formula = value.trim().replace(/\$\{([^}]+)\}/g, (_match, expression) => {
    try { return String(SafeEval.evaluate(expression.trim(), context) ?? 0); } catch { return '0'; }
  });
  formula = formula.replace(/\b(caster|target|self)([A-Z][a-zA-Z]*)\b/g, token => {
    const resolved = context[token];
    return typeof resolved === 'number' ? String(resolved) : token;
  });
  if (/\bd\d+\b|\d+d\d+/i.test(formula)) return { fixed: null, formula };
  try {
    const fixed = Number(SafeEval.evaluate(formula, context));
    return { fixed: Number.isFinite(fixed) ? fixed : 0, formula };
  } catch {
    const fixed = Number(formula);
    return { fixed: Number.isFinite(fixed) ? fixed : 0, formula };
  }
}

/** Evaluate every `{expr}` value in an authored step for engine/effects/execution.mjs. A failed one is undefined. */
export function resolveEffectValue(value, context = {}) {
  if (Array.isArray(value)) return value.map(entry => resolveEffectValue(entry, context));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.expr === 'string' && Object.keys(value).length === 1) {
    try { return structuredClone(SafeEval.evaluate(value.expr, context)); } catch { return undefined; }
  }
  const resolved = {};
  for (const [key, entry] of Object.entries(value)) resolved[key] = resolveEffectValue(entry, context);
  return resolved;
}

/**
 * Flatten both units' stat totals into the authored `casterMgt` / `targetDef` shorthands.
 * @param {object} self The acting unit's condition data.
 * @param {object} target The target's condition data.
 * @returns {object} One numeric entry per stat and prefix.
 */
export function effectAttributeShorthands(self, target) {
  const values = {};
  const named = ['hp', 'maxHp', 'stn', 'maxStn', 'level', ...STATS.map(stat => stat.key)];
  for (const [prefix, facts] of [['self', self], ['caster', self], ['target', target]]) {
    for (const key of named) {
      const amount = Number(facts?.[key]);
      values[`${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`] = Number.isFinite(amount) ? amount : 0;
    }
  }
  return values;
}

/** Item subtypes a heal-echo policy's `staff` source names: attack staves and utility staves alike. */
const HEAL_ECHO_STAFF_SUBTYPES = new Set(['Staff', 'Staff (U)']);

/**
 * How much HP the caster gets back after healing someone else with a matching item, for
 * engine/effects/execution.mjs. It is a fraction of the rolled heal, so overhealing counts, and only a heal from the
 * activated Item's own entry counts, not a passive running beside it. A policy (from projectHealEchoPolicies)
 * matches the Item by name in `items`, or by kind in `sources`: `spell` for a Spell, `staff` for either staff
 * subtype. The best matching fraction wins.
 * @param {object} input
 * @param {number} input.rolledAmount The step's rolled heal, before the target's missing HP caps it.
 * @param {string} input.casterActorUuid
 * @param {string[]} [input.healedActorUuids] Units the step healed.
 * @param {{uuid?: string, name?: string, type?: string, itemType?: string}} [input.activatedItem] Plain item data.
 * @param {string} [input.healEntryIdentity] The id effectEntryIdentities gave the step's entry, which begins with
 *   that entry's source Item UUID.
 * @param {object[]} [input.policies]
 * @returns {number} HP the caster regains, or 0.
 */
export function resolveHealEchoAmount({
  rolledAmount,
  casterActorUuid,
  healedActorUuids = [],
  activatedItem = null,
  healEntryIdentity = '',
  policies = []
} = {}) {
  const amount = Math.max(0, Number(rolledAmount) || 0);
  const caster = String(casterActorUuid ?? '');
  const itemUuid = String(activatedItem?.uuid ?? '').split('#')[0];
  if (!amount || !caster || !itemUuid || !(healedActorUuids ?? []).some(uuid => String(uuid) !== caster)) return 0;
  if (String(healEntryIdentity ?? '').split('#')[0] !== itemUuid) return 0;
  const itemName = String(activatedItem?.name ?? '').toLowerCase();
  const kinds = new Set();
  if (activatedItem?.type === 'Spell') kinds.add('spell');
  if (HEAL_ECHO_STAFF_SUBTYPES.has(activatedItem?.itemType)) kinds.add('staff');
  let fraction = 0;
  for (const policy of policies ?? []) {
    const names = Array.isArray(policy?.items) ? policy.items : [];
    const sources = Array.isArray(policy?.sources) ? policy.sources : [];
    const matched = (itemName && names.some(name => String(name).toLowerCase() === itemName))
      || sources.some(source => kinds.has(String(source).toLowerCase()));
    if (!matched) continue;
    const candidate = Number(policy?.fraction);
    if (Number.isFinite(candidate) && candidate > fraction) fraction = candidate;
  }
  return fraction > 0 ? Math.ceil(amount * fraction) : 0;
}

/* -------------------------------------------- */
/*  Entry ids                                   */
/* -------------------------------------------- */

const ENTRY_IDENTITY_FIELDS = Object.freeze([
  'trigger', 'itemNames', 'itemUuids', 'delayMs', 'tokenAwaits', 'condition', 'action'
]);

/**
 * A stable id for each authored effect entry, built from its item and content plus its place among identical
 * copies, so adding, removing or reordering other entries doesn't change it. engine/effects/execution.mjs uses it to
 * name the step it's running.
 * @param {object[]} entries Authored entries, each carrying its `sourceItemUuid`.
 * @returns {string[]} One id per entry, aligned with the input.
 */
export function effectEntryIdentities(entries) {
  const contents = (Array.isArray(entries) ? entries : []).map(entry =>
    `${String(entry?.sourceItemUuid ?? '').split('#')[0]}#${digest(entryContentText(entry))}`);
  const counts = new Map();
  for (const content of contents) counts.set(content, (counts.get(content) ?? 0) + 1);
  const seen = new Map();
  return contents.map(content => {
    const ordinal = seen.get(content) ?? 0;
    seen.set(content, ordinal + 1);
    return `${content}#${ordinal}/${counts.get(content)}`;
  });
}

function entryContentText(entry) {
  return canonicalJson(Object.fromEntries(ENTRY_IDENTITY_FIELDS.map(field => [field, entry?.[field] ?? null])));
}

/**
 * Expand the authored entries that fire for these triggers into ordered operations for engine/effects/execution.mjs.
 * Nothing is written or rolled here. The engine and the Foundry adapters handle writes, dice and presentation.
 * Each entry is checked against the item it came from (its `sourceItem`), so an entry its trigger can't support there
 * is invalid too. An invalid entry is skipped, and listed as one error carrying all its problems only when its
 * trigger is one being planned, which is the moment it would have fired. A valid entry's warnings are listed the same
 * way, and it still runs. A condition that fails to evaluate is listed too, and skips its entry or `if` step.
 * @param {object} input `entries`, `triggers` (one or a list), `context`, `activatedItem`, and `chanceRolls` (one
 *   number, or draws keyed by chance path).
 * @returns {{entries: object[], operations: object[], errors: object[], warnings: object[]}}
 */
export function planEffectEntries(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const triggerSet = new Set(Array.isArray(input.triggers) ? input.triggers : [input.triggers].filter(Boolean));
  const plannedEntries = [];
  const operations = [];
  const errors = [];
  const warnings = [];
  const identities = effectEntryIdentities(entries);

  entries.forEach((entry, entryIndex) => {
    const carrier = entry?.sourceItem ? effectCarrier(entry.sourceItem) : null;
    const validation = validateEffectEntry(entry, { path: `entries[${entryIndex}]`, carrier });
    if (!validation.valid) {
      if (!triggerSet.has(entry?.trigger)) return;
      errors.push({ code: EFFECT_PLAN_ERRORS.INVALID_ENTRY, entryIndex, message: validation.errors.join(' ') });
      return;
    }
    if (!triggerSet.has(entry.trigger) || !actionIsPopulated(entry.action)) return;
    if (validation.warnings.length) {
      warnings.push({ code: EFFECT_PLAN_ERRORS.ENTRY_WARNING, entryIndex, message: validation.warnings.join(' ') });
    }
    if (!passesOutcomeGate(entry, input.context ?? {})) return;
    if (!passesActivatedItemGate(entry, input.activatedItem)) return;
    if (!passesConditionGate(entry.condition, input.context ?? {}, input.chanceRolls,
      identities[entryIndex], entryIndex, errors)) return;

    const actionPlan = planEffectAction(entry.action, input.context ?? {}, {
      chanceRolls: input.chanceRolls,
      entryIdentity: identities[entryIndex],
      entryIndex
    });
    errors.push(...actionPlan.errors);
    const planned = {
      entryIndex,
      name: entry.name ?? '',
      trigger: entry.trigger,
      delayMs: Math.max(0, Number(entry.delayMs) || 0),
      tokenAwaits: entry.tokenAwaits === true,
      operations: actionPlan.operations
    };
    plannedEntries.push(planned);
    operations.push(...actionPlan.operations.map(operation => ({ ...operation, entryIndex })));
  });

  return { entries: plannedEntries, operations, errors, warnings };
}

/** List chance draws the engine must record before planEffectEntries resolves branches. */
export function effectChanceRequirements(entries = []) {
  const requirements = [];
  const seen = new Set();
  const identities = effectEntryIdentities(entries);
  const addTree = (tree, entryIndex, owner) => {
    for (const nodePath of chanceNodePaths(tree)) {
      const entryIdentity = identities[entryIndex];
      const key = `${entryIdentity}:${owner}:${nodePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requirements.push({ key, entryIndex, entryIdentity, path: `${owner}:${nodePath}` });
    }
  };
  const visitSteps = (steps, entryIndex, prefix = []) => {
    for (let index = 0; index < (steps?.length ?? 0); index += 1) {
      const step = steps[index];
      const path = [...prefix, index];
      if (step?.kind !== 'if') continue;
      addTree(step.condition, entryIndex, `step:${path.join('.')}`);
      visitSteps(step.then, entryIndex, path);
      visitSteps(step.else, entryIndex, path);
    }
  };
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    addTree(entry?.condition, entryIndex, 'entry');
    visitSteps(entry?.action?.steps, entryIndex);
  }
  return requirements;
}

function passesOutcomeGate(entry, context) {
  const savingThrow = context.savingThrowResult;
  const skillCheck = context.skillCheckResult;
  switch (entry.trigger) {
    case 'onFailedSave': return Boolean(savingThrow && savingThrow.success === false);
    case 'onSucceedSave': return Boolean(savingThrow && savingThrow.success === true);
    case 'onFailedCheck': return Boolean(skillCheck && skillCheck.success === false);
    case 'onSucceedCheck': return Boolean(skillCheck && skillCheck.success === true);
    default: return true;
  }
}

function passesActivatedItemGate(entry, activatedItem) {
  if (entry.trigger !== 'onUseItem') return true;
  const names = Array.isArray(entry.itemNames) ? entry.itemNames : [];
  const uuids = Array.isArray(entry.itemUuids) ? entry.itemUuids : [];
  if (names.length === 0 && uuids.length === 0) return false;
  return names.includes(activatedItem?.name) || uuids.includes(activatedItem?.uuid);
}

function passesConditionGate(tree, context, chanceRolls, entryIdentity, entryIndex, errors) {
  if (conditionIsEmpty(tree)) return true;
  try {
    return evaluateConditionTree(tree, context,
      nodePath => chanceRollFor(chanceRolls, `${entryIdentity}:entry:${nodePath}`));
  } catch {
    errors.push({ code: EFFECT_PLAN_ERRORS.CONDITION_FAILED, entryIndex, path: 'entry.condition' });
    return false;
  }
}

/* -------------------------------------------- */
/*  Step planning                               */
/* -------------------------------------------- */

/** Expand an entry's steps into ordered operations for planEffectEntries, following each `if` step's branch. */
function planEffectAction(action, context = {}, options = {}) {
  const operations = [];
  const errors = [];
  if (!actionIsPopulated(action)) return { operations, errors };
  planSteps(action.steps, context, options, [], operations, errors);
  return { operations, errors };
}

function planSteps(steps, context, options, prefix, operations, errors) {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const path = [...prefix, index];
    if (step.kind === 'if') {
      let passes = true;
      if (!conditionIsEmpty(step.condition)) {
        try {
          const owner = `step:${path.join('.')}`;
          passes = evaluateConditionTree(step.condition, context,
            nodePath => chanceRollFor(options.chanceRolls, `${options.entryIdentity}:${owner}:${nodePath}`));
        } catch {
          errors.push({
            code: EFFECT_PLAN_ERRORS.CONDITION_FAILED,
            entryIndex: options.entryIndex ?? null,
            path: `steps.${path.join('.')}.condition`
          });
          continue;
        }
      }
      const branch = passes ? step.then : step.else;
      planSteps(Array.isArray(branch) ? branch : [], context, options, path, operations, errors);
      continue;
    }
    operations.push({
      path,
      kind: step.kind,
      channel: effectOperationChannel(step.kind),
      delayMs: Math.max(0, Number(step.delay) || 0),
      step: structuredClone(step)
    });
  }
}

function chanceRollFor(chanceRolls, key) {
  if (typeof chanceRolls === 'number') return chanceRolls;
  const candidate = chanceRolls?.[key];
  return Number.isFinite(Number(candidate)) ? Number(candidate) : 100;
}

/* -------------------------------------------- */
/*  Guard bonds                                 */
/* -------------------------------------------- */

/**
 * Check a Guard pair before a bond is made: both units placed and unbonded, the guarder at least as wide and as
 * tall as the guardee, and no grounded unit guarding a flier. Flying means the flying unit type, not whether the
 * unit is airborne right now. Checked before any write when the item is used, and again when the bond is written.
 * @param {object} facts Both halves as `{tokenUuid, name, flying, width, height, bonded}`.
 * @returns {{ok: boolean, code?: string, actorName?: string}}
 */
export function resolveGuardBond({ guarder, guarded } = {}) {
  const guarderUuid = String(guarder?.tokenUuid ?? '');
  const guardedUuid = String(guarded?.tokenUuid ?? '');
  if (guarderUuid && guarderUuid === guardedUuid) return refusedBond(GUARD_BOND_REFUSALS.SELF);
  if (guarder?.bonded === true) return refusedBond(GUARD_BOND_REFUSALS.GUARDER_BONDED, guarder);
  if (guarded?.bonded === true) return refusedBond(GUARD_BOND_REFUSALS.GUARDED_BONDED, guarded);
  if (!guarderUuid || !guardedUuid) return refusedBond(GUARD_BOND_REFUSALS.OFF_MAP);
  if (guarded?.flying === true && guarder?.flying !== true) return refusedBond(GUARD_BOND_REFUSALS.GROUNDED);
  const guarderSize = footprintSize(guarder);
  const guardedSize = footprintSize(guarded);
  if (guarderSize.width < guardedSize.width || guarderSize.height < guardedSize.height) {
    return refusedBond(GUARD_BOND_REFUSALS.SMALLER);
  }
  return { ok: true };
}

function refusedBond(code, named = null) {
  return Object.freeze({ ok: false, code, actorName: String(named?.name ?? '') });
}

/**
 * Whether every use of an Item reaches a Guard step: an entry with no condition that runs on `onActivation` lists
 * one among its top-level steps. When it does, engine/items/activation.mjs checks the bonds with resolveGuardBond
 * before it writes anything. A Guard step behind a save outcome or a condition is checked only when its effect runs.
 * @param {readonly object[]} entries The Item's activation entries.
 * @returns {boolean}
 */
export function entriesAlwaysGuard(entries) {
  return (entries ?? []).some(entry => runsOnEveryUse(entry)
    && (entry.action?.steps ?? []).some(step => step?.kind === 'guard'));
}

function runsOnEveryUse(entry) {
  if (!validateEffectEntry(entry).valid || !conditionIsEmpty(entry.condition)) return false;
  return entry.trigger === 'onActivation';
}

/**
 * Plan the Foundry Guard-bond writes: co-locate units, place the guardee behind and link both effects.
 * @param {object} facts Both halves as `{tokenUuid, actorUuid, name, x, y, sort}`.
 * @returns {object}
 */
export function planGuardBond({ guarder, guarded } = {}) {
  const guarderSort = Number(guarder?.sort) || 0;
  return {
    guarderTokenUuid: String(guarder?.tokenUuid ?? ''),
    guardedTokenUuid: String(guarded?.tokenUuid ?? ''),
    destination: { x: Math.floor(Number(guarded?.x) || 0), y: Math.floor(Number(guarded?.y) || 0) },
    guardedSort: guarderSort - 1,
    originalSort: Number(guarded?.sort) || 0,
    effects: [
      bondHalf(guarder, GUARD_BOND_ROLES.GUARDER, guarded),
      bondHalf(guarded, GUARD_BOND_ROLES.GUARDEE, guarder)
    ]
  };
}

function bondHalf(side, role, partner) {
  return {
    actorUuid: String(side?.actorUuid ?? ''),
    role,
    partnerActorUuid: String(partner?.actorUuid ?? ''),
    partnerName: String(partner?.name ?? '')
  };
}

/**
 * Whether a Guard bond still holds: the guardee must stay inside the guarder's footprint.
 * @param {object} facts Both halves as `{x, y, width, height}` in grid cells.
 * @returns {boolean}
 */
export function guardBondHolds({ guarder, guarded } = {}) {
  if (!guarder || !guarded) return false;
  const outer = footprintRect(guarder);
  const inner = footprintRect(guarded);
  return inner.x >= outer.x && inner.x + inner.width <= outer.x + outer.width
    && inner.y >= outer.y && inner.y + inner.height <= outer.y + outer.height;
}

function footprintRect(side) {
  return { x: Math.floor(Number(side?.x) || 0), y: Math.floor(Number(side?.y) || 0), ...footprintSize(side) };
}

function footprintSize(side) {
  return {
    width: Math.max(1, Math.floor(Number(side?.width) || 1)),
    height: Math.max(1, Math.floor(Number(side?.height) || 1))
  };
}
