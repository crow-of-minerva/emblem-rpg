/** @layer engine/effects */
import {
  DAMAGE_POLICIES,
  DEFEAT_STATUSES,
  HEALTH_CHANGE_TYPES,
  healthPresentationMessage,
  STANCE_BREAK_OUTCOMES,
  STANCE_BREAK_PRESENTATION_KIND
} from '../../contracts/domains/damage.mjs';
import { GUARD_BOND_REFUSALS } from '../../contracts/domains/combat.mjs';
import { isEffectPreconditionFailure } from '../../contracts/dsl/effects.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import {
  resolveDamage,
  resolveHealing,
  resolveStanceBreak
} from '../../game/combat/damage.mjs';
import {
  effectChanceRequirements,
  effectEntryIdentities,
  planEffectEntries,
  resolveHealEchoAmount,
  resolveEffectAmountFormula,
  resolveEffectValue
} from '../../game/effects/planning.mjs';
import { MAX_SETTLEMENT_ATTEMPTS } from '../../contracts/commands.mjs';
import {
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  recordDiagnostic,
  diagnosticData,
  requirePorts
} from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Effect execution                            */
/* -------------------------------------------- */

const GUARD_BOND_NOTICES = new Set(Object.values(GUARD_BOND_REFUSALS));
const SPAWN_UNPREPARED = Object.freeze({ ok: false, code: 'effect.spawn-failed' });
/** Steps that write only the units they target, so they have nothing to do when every target is scenery or slain. */
const UNIT_WRITING_STEPS = new Set(['modShield', 'applyEffect', 'setFaction', 'moveToken', 'restoreAction', 'unequip', 'guard']);

/**
 * Run effect entries. game/effects/planning.mjs plans the steps, and this service rolls their amounts, records what
 * they write in the command's resource keys, and hands them to the Foundry writers (FoundryEffectRepository) and the
 * presentation service. Built in init/system.mjs and shared by item activation, the combat exchange and phase
 * triggers.
 */
export class EffectExecutionService {
  /** The authoring problems this session has already reported, by entry identity, path and code. */
  #reported = new Set();

  /**
   * @param {object} ports
   * @param {Function} ports.notifyGm Shows the GM one notice for a skipped step or entry, given
   *   `{itemName, trigger, entryName, stepKind, code}`. init/system.mjs shows it only on the active GM.
   */
  constructor({ diagnostics, effects, notifyGm, present, stances, wait }) {
    requirePorts('EffectExecutionService', { diagnostics, effects, notifyGm, present, stances, wait });
    this.diagnostics = diagnostics;
    this.effects = effects;
    this.notifyGm = notifyGm;
    this.present = present;
    this.stances = stances;
    this.wait = wait;
  }

  /**
   * Run the effect entries that fire for `triggers`, inside the calling command. Every chance roll, formula roll
   * and random placement is drawn here, once for this run. The writers save old values into `runtime.operation`
   * before changing anything, so a failed command is undone. A busy refusal stops the run; other failed steps do
   * not. Notices go only to the users in `audience`.
   * A step that fails an authoring precondition (isEffectPreconditionFailure) wrote nothing, so it is skipped and
   * the run goes on. The GM hears about it, and about each plan error, once.
   * `combatContext` (exchanges only) reaches the health reads and nothing else. It stays out of the runtime because
   * the runtime is sent to every client in presentation messages, and the context holds the host's chance draws.
   */
  async run({
    entries, triggers, runtime, context = {}, activatedItem = null, resources = null, audience = null,
    combatContext = null
  }) {
    const executionRuntime = { ...runtime };
    const chanceRolls = {};
    for (const requirement of effectChanceRequirements(entries)) {
      chanceRolls[requirement.key] = await this.effects.randomPercent();
    }
    const plan = planEffectEntries({ entries, triggers, context, activatedItem, chanceRolls });
    const identities = effectEntryIdentities(entries);
    for (const error of plan.errors) {
      const path = String(error.path ?? 'entry');
      const kind = path.startsWith('steps.') ? 'if' : '';
      this.#report({ ...error, path, kind }, entries, identities, context);
    }
    for (const warning of plan.warnings) {
      this.#report({ ...warning, path: 'entry', kind: '' }, entries, identities, context, { notify: false });
    }
    const held = { runtime: executionRuntime, context, resources, audience: noticeAudience(audience), combatContext };
    const outcomes = [];
    // Delays, and `wait` steps in #execute, run while the command holds the command slot, so nothing else at the
    // table runs meanwhile. They have no upper limit.
    for (const entry of plan.entries) {
      if (entry.delayMs > 0) await this.wait(entry.delayMs);
      for (const operation of entry.operations) {
        if (operation.delayMs > 0) await this.wait(operation.delayMs);
        const addressed = { ...operation, entryIdentity: identities[entry.entryIndex] };
        const outcome = skippedPrecondition(await this.#execute(addressed, held), operation.kind);
        if (outcome?.skipped === PRECONDITION_SKIP) {
          const path = `steps.${operation.path.join('.')}`;
          this.#report({ entryIndex: entry.entryIndex, path, kind: operation.kind, code: outcome.code }, entries,
            identities, context);
        }
        outcomes.push(outcome);
        if (outcome?.code === RESULT_CODES.COMMAND_RESOURCE_BUSY) {
          return settledRun(outcomes, plan.errors, outcome);
        }
      }
    }
    return settledRun(outcomes, plan.errors, null);
  }

  async #execute(operation, { runtime, context, resources, audience, combatContext }) {
    const step = await this.#prepareStep(operation.step, context, operation);
    const prepared = Object.freeze({ ...operation, step: Object.freeze(step) });
    if (operation.channel === 'presentation') {
      const projected = await this.effects.preparePresentation?.(prepared, runtime) ?? prepared;
      const shown = projected
        ? await this.#presentSafely(Object.freeze({ kind: 'effect-operation', operation: projected, runtime }))
        : false;
      return { ok: true, presentation: shown, kind: step.kind };
    }
    if (operation.channel === 'control') {
      if (step.kind === 'wait') await this.wait(Math.max(0, await this.#rollAmount(step.ms ?? 0, context)));
      if (step.kind === 'expr' && typeof step.expr === 'string') resolveEffectValue({ expr: step.expr }, context);
      return { ok: true, control: true, kind: step.kind };
    }
    if (step.kind === 'damage' || step.kind === 'heal') {
      return this.#settleHealth(prepared, runtime, context, resources, combatContext);
    }
    if (step.kind === 'spawnToken') return this.#spawn(prepared, runtime, resources);
    const resolved = await this.effects.resolveWrites(prepared, runtime);
    const writes = spareSlain(resolved, runtime);
    if (await this.#aimedOnlyAtSlain(step, resolved, writes, runtime)) return slainOutcome({ kind: step.kind });
    if (await this.#aimedOnlyAtScenery(step, writes, runtime)) return sceneryOutcome({ kind: step.kind });
    const busy = claimWrites(resources, writes.actorUuids, writes.sceneUuids);
    if (busy) return busy;
    const executed = await this.effects.executeMechanical(prepared, runtime, writes, placementChoices(this.effects));
    const outcome = withMechanicalImpacts(step.kind, executed);
    for (const linked of outcome?.linkedAnimations ?? []) {
      const records = runtime.linkedAnimationTags ??= {};
      const record = records[linked.baseTag] ??= { byActor: {}, last: null };
      const entry = { tag: linked.tag, created: linked.created === true };
      record.byActor[linked.actorUuid] = entry;
      record.last = entry;
    }
    await this.#presentMechanicalOutcome(outcome, runtime, audience);
    return outcome;
  }

  /** Skip unit-only writes when every target is scenery. Item activation still succeeds and pays its costs. */
  async #aimedOnlyAtScenery(step, writes, runtime) {
    if (!UNIT_WRITING_STEPS.has(step.kind) || !Array.isArray(writes.targets) || writes.targets.length > 0) return false;
    return (await this.effects.resolveTargets(step.target, runtime)).length > 0;
  }

  /**
   * Skip a unit-only write that a killing blow left with nobody living to reach: every unit it named was slain, or
   * the partner a swap trades places with was. A step that still reaches a living unit runs for that unit alone.
   */
  async #aimedOnlyAtSlain(step, resolved, spared, runtime) {
    if (!UNIT_WRITING_STEPS.has(step.kind) || !runtime.slainActorUuids?.length) return false;
    if (resolved.targets?.length > 0 && spared.targets.length === 0) return true;
    if (step.kind !== 'moveToken' || step.mode !== 'swap') return false;
    const pair = await this.effects.resolveTargets(step.pair ?? 'self', runtime);
    return pair.length > 0 && livingTargets(pair, runtime).length === 0;
  }

  /**
   * Claim the summoned unit's Actor, and those the earlier summons it replaces reach, then create its Token. The
   * writer records the new Token's id in the run's undo record before creating it.
   */
  async #spawn(operation, runtime, resources) {
    const spawn = await this.effects.prepareSpawn(operation, runtime);
    if (spawn?.ok !== true) return spawn ?? SPAWN_UNPREPARED;
    const busy = claimWrites(resources, [spawn.actorUuid, ...(spawn.replacedActorUuids ?? [])]);
    if (busy) return busy;
    const outcome = await this.effects.createSpawn(spawn, operation, runtime);
    adoptSpawn(runtime, outcome?.spawned);
    return outcome;
  }

  /**
   * Show the table what a mechanical step changed, and tell the requester alone why part of it did not land.
   * A refused Guard bond or an immunity is a notice for the person whose action it was, never a table-wide toast.
   */
  async #presentMechanicalOutcome(outcome, runtime, audience) {
    if (GUARD_BOND_NOTICES.has(outcome?.code)) {
      await this.#presentNotice(effectPresentation({
        kind: 'effectNotice',
        notice: outcome.code,
        actorName: String(outcome.actorName ?? '')
      }, runtime), audience);
    }
    for (const shield of outcome?.shieldChanges ?? []) {
      if (!(shield.gained > 0) || !shield.tokenUuid) continue;
      await this.#presentSafely(effectPresentation({
        kind: 'shieldChange',
        tokenUuid: shield.tokenUuid,
        gained: shield.gained
      }, runtime));
    }
    for (const application of outcome?.applications ?? []) {
      if (application.reason !== 'immune') continue;
      await this.#presentNotice(effectPresentation({
        kind: 'effectNotice',
        notice: 'immune',
        actorName: application.actorName,
        effectName: application.effectName,
        sourceName: application.immunitySourceName
      }, runtime), audience);
    }
  }

  async #prepareStep(step, context) {
    const prepared = resolveEffectValue(step, context) ?? {};
    if (step.kind === 'modShield') {
      prepared.formula = await this.#rollAmount(step.formula ?? 0, context);
      if (step.cap !== undefined && step.cap !== null && step.cap !== '') {
        prepared.cap = await this.#rollAmount(step.cap, context);
      }
    }
    if (step.kind === 'moveToken') {
      for (const key of ['distance', 'dx', 'dy']) {
        if (step[key] !== undefined) prepared[key] = await this.#rollAmount(step[key], context);
      }
    }
    return prepared;
  }

  /**
   * Write one damage or heal step on each living unit it names. Each amount is worked out against the unit's
   * `ruleTarget` data, which the effect host reads under `combatContext` when an exchange fired the run, and is
   * written against the unit's data as it was read. Each unit's outcome lists its `impacts` (see `unitImpact`). A
   * heal echo lists none, because it is the caster's passive reacting to the heal rather than the step's own work.
   * A heal skips slain units.
   */
  async #settleHealth(operation, runtime, context, resources = null, combatContext = null) {
    const step = operation.step;
    const named = await this.effects.resolveTargets(step.target, runtime);
    const targets = livingTargets(named, runtime);
    const outcomes = step.kind !== 'heal' ? [] : named.filter(target => !targets.includes(target))
      .map(target => slainOutcome({ actorUuid: target.actorUuid, tokenUuid: target.tokenUuid }));
    if (targets.length === 0) return { ok: true, outcomes };
    const echoed = step.kind === 'heal' && (runtime.healEchoes ?? []).length > 0 ? [runtime.self?.actorUuid] : [];
    const busy = claimWrites(resources, [...targets.map(target => target.actorUuid), ...echoed]);
    if (busy) return busy;
    const rolledAmount = await this.#rollAmountDetailed(step.formula ?? '0', context);
    const amount = rolledAmount.total;
    const stanceAmount = await this.#rollAmount(step.kind === 'heal' ? step.stnAmount ?? 0 : step.brk ?? 0, context);
    for (const target of targets) {
      const snapshot = await this.effects.healthSnapshot(target.actorUuid, target.tokenUuid, runtime, combatContext);
      if (!snapshot) continue;
      if (step.kind === 'heal' && snapshot.target?.destructible === true) {
        outcomes.push(sceneryOutcome({ actorUuid: snapshot.actorUuid, tokenUuid: snapshot.tokenUuid }));
        continue;
      }
      if (step.kind === 'heal') {
        const resolution = resolveHealing({ amount, stanceAmount, target: snapshot.ruleTarget });
        let { persisted, stanceBreak } = await this.#settleWrite('commitHealing', snapshot, resolution, runtime);
        const health = effectHealthMessage(snapshot, resolution, persisted, HEALTH_CHANGE_TYPES.HEAL, step);
        if (persisted?.ok === true) stanceBreak = await this.#presentHealthAndStance(health, stanceBreak);
        outcomes.push({
          ...persisted,
          ok: persisted?.ok === true && !stanceTransitionFailed(stanceBreak),
          actorUuid: snapshot.actorUuid,
          tokenUuid: snapshot.tokenUuid,
          amount: resolution.amount,
          stanceAmount: resolution.stanceAmount,
          formula: rolledAmount.formula,
          rolled: rolledAmount.rolled,
          stanceBreak,
          health,
          impacts: persisted?.ok === true ? [unitImpact(snapshot.actorUuid, {
            helpful: { hp: resolution.amount, stn: resolution.stanceAmount }
          })] : []
        });
        continue;
      }
      const critical = step.isCrit === true || (step.isCrit === undefined && context.isCrit === true);
      const resolution = resolveDamage({
        policy: step.alt === false ? DAMAGE_POLICIES.WEAPON : DAMAGE_POLICIES.ABILITY,
        damage: amount,
        stanceDamage: stanceAmount,
        damageType: String(step.dmgType ?? 'none'),
        critical,
        criticalMultiplier: 2,
        target: snapshot.ruleTarget
      });
      let { persisted, stanceBreak } = await this.#settleWrite('commitDamage', snapshot, resolution, runtime);
      const health = effectHealthMessage(snapshot, resolution, persisted, HEALTH_CHANGE_TYPES.DAMAGE, {
        ...step,
        isCrit: critical
      });
      if (persisted?.ok === true) stanceBreak = await this.#presentHealthAndStance(health, stanceBreak);
      outcomes.push({
        ...persisted,
        ok: persisted?.ok === true && !stanceTransitionFailed(stanceBreak),
        actorUuid: snapshot.actorUuid,
        tokenUuid: snapshot.tokenUuid,
        amount: resolution.amount,
        stanceAmount: resolution.stanceAmount,
        formula: rolledAmount.formula,
        rolled: rolledAmount.rolled,
        damageType: String(step.dmgType ?? 'none'),
        critical,
        hpDealt: Math.max(0, Number(resolution.hpBefore) - Number(persisted?.hpAfter ?? resolution.hpAfter)),
        stanceDealt: Math.max(0, Number(resolution.stanceBefore ?? 0)
          - Number(persisted?.stanceAfter ?? resolution.stanceAfter ?? 0)),
        stanceBreak,
        health,
        impacts: persisted?.ok === true ? [damageImpact(snapshot.actorUuid, resolution, persisted)] : []
      });
    }
    if (step.kind === 'heal') {
      const echo = resolveHealEchoAmount({
        rolledAmount: amount,
        casterActorUuid: runtime.self?.actorUuid,
        healedActorUuids: outcomes.filter(outcome => outcome?.ok === true && !outcome.skipped)
          .map(outcome => outcome.actorUuid),
        activatedItem: {
          uuid: runtime.activatedItemUuid,
          name: context.item?.name,
          type: context.item?.type,
          itemType: context.item?.system?.itemType
        },
        healEntryIdentity: operation.entryIdentity,
        policies: runtime.healEchoes
      });
      if (echo > 0) {
        const snapshot = await this.effects.healthSnapshot(runtime.self.actorUuid, runtime.self.tokenUuid, runtime,
          combatContext);
        if (snapshot) {
          const resolution = resolveHealing({ amount: echo, stanceAmount: 0, target: snapshot.ruleTarget });
          const { persisted } = await this.#settleWrite('commitHealing', snapshot, resolution, runtime,
            { breaks: false });
          const health = effectHealthMessage(snapshot, resolution, persisted, HEALTH_CHANGE_TYPES.HEAL, step);
          if (persisted?.ok === true) await this.#presentSafely(health);
          outcomes.push({
            ...persisted,
            ok: persisted?.ok === true,
            actorUuid: snapshot.actorUuid,
            tokenUuid: snapshot.tokenUuid,
            amount: resolution.amount,
            stanceAmount: 0,
            health,
            healEcho: true
          });
        }
      }
    }
    return { ok: outcomes.every(outcome => outcome?.ok === true), outcomes };
  }

  async #rollAmount(value, context) {
    return (await this.#rollAmountDetailed(value, context)).total;
  }

  async #rollAmountDetailed(value, context) {
    const resolved = resolveEffectAmountFormula(value, context);
    if (resolved.fixed !== null) {
      return { total: resolved.fixed, formula: resolved.formula, rolled: false };
    }
    return {
      total: await this.effects.rollFormula(resolved.formula), formula: resolved.formula, rolled: true
    };
  }

  async #presentSafely(message) {
    try { await this.present(message); return true; }
    catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'presentSafely' });
      return false;
    }
  }

  /** Send one notice to the users in the run's audience. With no audience, nothing is sent. */
  async #presentNotice(message, audience) {
    if (!audience.length) return false;
    try { await this.present(message, { audience: [...audience] }); return true; }
    catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, {
        sourcePath: import.meta.url, error: diagnosticError, detail: 'presentNotice'
      });
      return false;
    }
  }

  /**
   * Tell the GM, once per session, about a step or entry that could not run: a skipped step (`kind` is its kind),
   * an invalid entry (`path` is 'entry'), or a condition that threw (`kind` is 'if' when it guards a step). The
   * warning diagnostic raises no toast of its own, so the GM sees the one notice rather than a generic error toast.
   * Per-blow and per-phase triggers repeat the same problem, so it is remembered by entry identity, path and code.
   * An entry that ran but has validation warnings passes `notify: false`: it is logged and the GM gets no notice.
   * @param {{entryIndex: number, path: string, kind: string, code: string, message?: string}} problem
   */
  #report({ entryIndex, path, kind, code, message = '' }, entries, identities, context, { notify = true } = {}) {
    const key = [identities[entryIndex], path, code].join('|');
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    const source = entries[entryIndex];
    const itemName = String(source?.sourceItemName || context?.item?.name || '');
    const trigger = String(source?.trigger ?? '');
    const entryName = String(source?.name ?? '');
    const place = `item "${itemName || 'unknown'}", trigger ${trigger || 'none'}, entry ${entryIndex}`
      + (entryName ? ` "${entryName}"` : '');
    const step = kind ? ` (${kind})` : '';
    const why = message ? ` (${message})` : '';
    recordDiagnostic(this.diagnostics, {
      sourcePath: import.meta.url,
      source: DIAGNOSTIC_SOURCES.EFFECTS,
      severity: DIAGNOSTIC_SEVERITIES.WARNING,
      detail: `Effect ${kind ? 'step' : 'entry'} ${notify ? 'skipped' : 'has warnings'}: ${place}, ${path}${step}: `
        + `${code}${why}`,
      notify: false
    });
    if (!notify) return;
    try { this.notifyGm(Object.freeze({ itemName, trigger, entryName, stepKind: kind, code })); }
    catch (diagnosticError) {
      recordDiagnostic(this.diagnostics, { sourcePath: import.meta.url, error: diagnosticError, detail: 'notifyGm' });
    }
  }

  /** Apply any Stance Break through the run's undo record, so it is undone with the rest of the action. */
  async #settleStance(actorUuid, runtime) {
    return settleStanceBreak(this.stances, actorUuid, runtime.operation ?? null);
  }

  /** Write health, then the Stance Break it may cause. A refused break fails the step, and the command is undone. */
  async #settleWrite(entry, snapshot, resolution, runtime, { breaks = true } = {}) {
    const persisted = await this.effects[entry](snapshot, resolution, runtime);
    if (persisted?.ok !== true) return { persisted, stanceBreak: null };
    const stanceBreak = breaks ? await this.#settleStance(snapshot.actorUuid, runtime) : null;
    if (stanceTransitionFailed(stanceBreak)) {
      return { persisted: healthFailure(persisted, 'health.stance-break-failed'), stanceBreak };
    }
    return { persisted, stanceBreak };
  }

  async #presentHealthAndStance(health, stanceBreak) {
    const healthPresentation = this.#presentSafely(health);
    if (stanceBreak?.outcome !== STANCE_BREAK_OUTCOMES.APPLIED || !stanceBreak.tokenUuid) {
      await healthPresentation;
      return stanceBreak;
    }
    const breakPresentation = this.#presentSafely(Object.freeze({
      kind: STANCE_BREAK_PRESENTATION_KIND,
      tokenUuid: stanceBreak.tokenUuid
    }));
    const [, presented] = await Promise.all([healthPresentation, breakPresentation]);
    return Object.freeze({ ...stanceBreak, presented });
  }
}

/** The map choices a mechanical step can ask for. A random placement is drawn here, once for this run. */
function placementChoices(effects) {
  return Object.freeze({ placement: candidates => drawnPlacement(candidates, effects) });
}

/** One square drawn from the candidates, or none when no square qualifies. */
function drawnPlacement(candidates, effects) {
  if (!candidates?.length) return null;
  const cell = candidates[effects.randomIndex(candidates.length)];
  return Number.isFinite(cell?.x) && Number.isFinite(cell?.y) ? { x: cell.x, y: cell.y } : null;
}

/**
 * Add the Actors and Scenes a step is about to write to the calling command's resource keys before it writes.
 * `resources.hold` is holdsResources in engine/dispatcher.mjs, bound to the command.
 * @returns {object|null} Null when the command holds them all, otherwise the refusal naming every key.
 */
function claimWrites(resources, actorUuids = [], sceneUuids = []) {
  if (!resources) return null;
  const keys = [
    ...actorUuids.filter(Boolean).map(actorUuid => `actor:${actorUuid}`),
    ...sceneUuids.filter(Boolean).map(sceneUuid => `scene:${sceneUuid}`)
  ];
  if (!keys.length || resources.hold(keys) === true) return null;
  return { ok: false, code: RESULT_CODES.COMMAND_RESOURCE_BUSY, keys };
}

/** Point later presentation steps at the summon a step created. */
function adoptSpawn(runtime, spawned) {
  if (!spawned?.tokenUuid) return;
  runtime.lastSpawnedTokenUuid = spawned.tokenUuid;
  runtime.lastSpawnedActorUuid = spawned.actorUuid;
}

function settledRun(outcomes, errors, interrupted) {
  return { outcomes, errors, interrupted };
}

/** The distinct user ids a run's notices go to. Anything but a list names nobody. */
function noticeAudience(audience) {
  const ids = (Array.isArray(audience) ? audience : []).map(id => String(id ?? '')).filter(Boolean);
  return [...new Set(ids)];
}

function effectPresentation(step, runtime) {
  return Object.freeze({
    kind: 'effect-operation',
    operation: Object.freeze({ channel: 'presentation', step: Object.freeze(step) }),
    runtime
  });
}

async function settleStanceBreak(stances, actorUuid, operation = null) {
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const snapshot = await stances.getSnapshot(actorUuid);
    if (!snapshot) return null;
    const transition = resolveStanceBreak(snapshot);
    if (!transition.createBreakEffect && transition.deleteEffectIds.length === 0) {
      return Object.freeze({ outcome: transition.outcome, actorUuid, tokenUuid: snapshot.tokenUuid });
    }
    const committed = await stances.commit(snapshot, transition, { operation });
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) {
      return Object.freeze({ ...diagnosticData(committed),
        outcome: STANCE_BREAK_OUTCOMES.FAILED,
        actorUuid,
        tokenUuid: snapshot.tokenUuid
      });
    }
    return Object.freeze({
      outcome: transition.outcome,
      actorUuid,
      actorName: snapshot.actorName,
      tokenUuid: committed.tokenUuid ?? snapshot.tokenUuid
    });
  }
  return Object.freeze({ outcome: STANCE_BREAK_OUTCOMES.STALE, actorUuid, tokenUuid: '' });
}

function healthFailure(persisted, code) {
  return { ...persisted, ok: false, code };
}

/** The outcome of a unit-only step with no unit target, or of a heal aimed at a Destructible. */
function sceneryOutcome(detail) {
  return { ok: true, skipped: 'scenery', ...detail };
}

/* -------------------------------------------- */
/*  Authoring problems                          */
/* -------------------------------------------- */

/** The `skipped` value of a step that failed an authoring precondition. */
const PRECONDITION_SKIP = 'precondition';

/**
 * A failed step's outcome, or a skipped success when the step failed an authoring precondition. Such a step wrote
 * nothing, so the exchange, activation or phase change that ran it carries on. Any other failure stays failed.
 */
function skippedPrecondition(outcome, kind) {
  if (outcome?.ok !== false || !isEffectPreconditionFailure(outcome.code)) return outcome;
  return { ok: true, skipped: PRECONDITION_SKIP, code: outcome.code, kind };
}

/* -------------------------------------------- */
/*  Slain units                                 */
/* -------------------------------------------- */

/** The targets a killing blow left standing. The unit it slew takes no further write. */
function livingTargets(targets, runtime) {
  const slain = runtime.slainActorUuids ?? [];
  if (!slain.length) return targets;
  return targets.filter(target => !slain.includes(target?.actorUuid));
}

/** The writes a step makes once the slain unit is dropped from the units it targets and claims. */
function spareSlain(writes, runtime) {
  const slain = runtime.slainActorUuids ?? [];
  if (!slain.length) return writes;
  return Object.freeze({
    ...writes,
    targets: Object.freeze(livingTargets(writes.targets ?? [], runtime)),
    actorUuids: Object.freeze((writes.actorUuids ?? []).filter(actorUuid => !slain.includes(actorUuid)))
  });
}

/** The outcome of a unit-only step when the blow that fired the run slew every unit it targets. */
function slainOutcome(detail) {
  return { ok: true, skipped: 'slain', ...detail };
}

function stanceTransitionFailed(result) {
  return result?.outcome === STANCE_BREAK_OUTCOMES.FAILED || result?.outcome === STANCE_BREAK_OUTCOMES.STALE;
}

/* -------------------------------------------- */
/*  Unit impacts                                */
/* -------------------------------------------- */

/**
 * What one finished step actually did to one unit. engine/items/activation.mjs sums these per unit to grade the
 * activation's XP. `harmful` and `helpful` hold the HP and Stance removed or restored after clamping, and
 * whether a status of that kind was newly applied. `moved` means the step put the unit on another square, and
 * `slain` means the step claimed its defeat. A step that changed nothing reports no impact at all. Item activation
 * also builds one for the Rally it applies outside any effect step.
 * @param {string} actorUuid The unit's Actor.
 * @param {object} [parts] The halves the step touched.
 * @returns {Readonly<object>}
 */
export function unitImpact(actorUuid, { harmful = {}, helpful = {}, moved = false, slain = false } = {}) {
  const half = part => Object.freeze({
    hp: Math.max(0, Number(part.hp) || 0),
    stn: Math.max(0, Number(part.stn) || 0),
    status: part.status === true
  });
  return Object.freeze({
    actorUuid: String(actorUuid ?? ''), harmful: half(harmful), helpful: half(helpful), moved, slain
  });
}

/**
 * The HP and Stance a damage write removed, which resolveDamage has already held to what the unit had, and whether
 * the write claimed its defeat. An Extra Life still counts the HP it took, but only a claimed defeat is a kill.
 */
function damageImpact(actorUuid, resolution, persisted) {
  return unitImpact(actorUuid, {
    harmful: {
      hp: Number(resolution.hpBefore) - Number(resolution.hpAfter),
      stn: Number(resolution.stanceBefore) - Number(resolution.stanceAfter)
    },
    slain: persisted.defeatStatus === DEFEAT_STATUSES.CLAIMED
  });
}

/**
 * Attach the unit impacts of one mechanical step to the outcome FoundryEffectRepository.executeMechanical returned.
 * A status counts only when it was created, so a repeat on a unit that already had it does not. It is helpful when
 * the ActiveEffect is flagged beneficial, and harmful otherwise. A restored turn slot that had been spent and a
 * Shield that actually rose are helpful statuses. A displaced unit counts as moved, and as slain if a forced
 * crossing killed it.
 */
function withMechanicalImpacts(kind, outcome) {
  const impacts = mechanicalImpacts(kind, outcome);
  return impacts.length ? { ...outcome, impacts } : outcome;
}

function mechanicalImpacts(kind, outcome) {
  if (outcome?.ok !== true) return [];
  switch (kind) {
    case 'applyEffect':
      return (outcome.applications ?? []).filter(application => application.created === true)
        .map(application => unitImpact(application.actorUuid, application.beneficial === true
          ? { helpful: { status: true } } : { harmful: { status: true } }));
    case 'moveToken':
      return (outcome.displaced ?? []).map(actorUuid => unitImpact(actorUuid, {
        moved: true, slain: outcome.crossing?.defeated === true
      }));
    case 'restoreAction':
      return (outcome.restored ?? []).map(actorUuid => unitImpact(actorUuid, { helpful: { status: true } }));
    case 'modShield':
      return (outcome.shieldChanges ?? []).filter(change => change.gained > 0)
        .map(change => unitImpact(change.actorUuid, { helpful: { status: true } }));
    default:
      return [];
  }
}

/* -------------------------------------------- */
/*  Health presentation                         */
/* -------------------------------------------- */
function effectHealthMessage(snapshot, resolution, persisted, change, step) {
  return healthPresentationMessage({
    tokenUuid: snapshot.tokenUuid,
    change,
    resolution,
    persisted,
    critical: step.isCrit === true,
    physicalVariant: step.alt !== false ? 'alt' : 'default'
  });
}
