/** @layer foundry/adapters/document-writes */
import { STATUS_EFFECTS } from '../../../config/statuses.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import {
  DRIVEN_WALK_TIMING, FORCED_STEP_OUTCOMES, TERRAIN_EDIT_RECORDS_FLAG, TERRAIN_GRID_FLAG, terrainKey
} from '../../../contracts/domains/terrain.mjs';
import { resolveForcedStep, resolveLanding } from '../../../game/movement/pathfinding.mjs';
import { normalizeGeometry } from '../../../contracts/dsl/terrain-geometry.mjs';
import { factionGroup } from '../../../game/character/rules.mjs';
import { TURN_REFRESH } from '../../../game/combat/phases.mjs';
import { planGuardBond, resolveGuardBond } from '../../../game/effects/planning.mjs';
import {
  isFactionLinkRecord, nextFactionLinkOrder, planFactionChange, planFactionRevert
} from '../../../game/effects/faction-links.mjs';
import { generateAreaCells, geometryPlacementBudget, resolveGeometryPlacements } from '../../../game/targeting/shapes.mjs';
import {
  buildTerrainEffectPatch,
  planTerrainEffectEdit,
  terrainEffectPatchIsEmpty
} from '../../../game/terrain/effects.mjs';
import { parseCellKey, rectKeys } from '../../../lib/core/geometry.mjs';
import { collectionValues, delay } from '../../../lib/core/runtime.mjs';
import {
  displaceToken,
  forcedDeletion,
  resolveActor,
  resolveDocument,
  resolveItem,
  resolveScene,
  resolveToken,
  stackRescale as rescaleStackChanges
} from '../services/host.mjs';
import { EFFECT_MOVE_ACTION, EFFECT_MOVE_ANIMATION, ENCOUNTER_DECAY_FLAGS } from '../../../contracts/domains/combat.mjs';
import { STANCE_BREAK_EFFECT_NAME, STANCE_BREAK_STATUS_ID } from '../../../contracts/domains/damage.mjs';
import { DEFAULT_STATUS_DURATION, FACTION_LINK_FLAG } from '../../../contracts/domains/characters.mjs';
import { EFFECT_STEP_PRECONDITION_FAILURES as PRECONDITION } from '../../../contracts/dsl/effects.mjs';
import { normalizeCustomStatus } from '../../../contracts/dsl/custom-status.mjs';
import { ACTIVATION_EXPERIENCE_USES_FLAG } from '../../../contracts/domains/progression.mjs';
import { applyRallyEffect, rallyRecordUpdate } from './rallies.mjs';
import { removeSummons } from './encounters.mjs';
import { projectActivationExperienceUses } from '../projections/items.mjs';
import { projectGeometrySight } from '../projections/terrain.mjs';
import { projectExchangeHealthTarget } from '../projections/combat-exchange.mjs';
import {
  prepareEffectSpawn,
  resolveEffectLocation,
  resolveEffectTargets,
  resolveEffectWrites,
  tokenGridPosition,
  tokenGridRect
} from '../projections/effect-targets.mjs';

/** Marks effect writes, so the Stance hook and the placed-token fill leave them alone. */
const effectOptions = () => ({ emblemEffectSettlement: true });

/** Summon Tokens already placed by each running command, so a second cast in the same command keeps them. */
const placedSummons = new WeakMap();

/**
 * The commands (by undo record, or by run when there is none) whose square picked before the use was confirmed has
 * been spent. It belongs to the one prompted move it was picked for, so later steps and targets work out their own.
 */
const spentPlacements = new WeakSet();

/** The only field `FoundryItemActivationSettlement.settleActivation` writes on the Item a use activates. */
const ACTIVATED_ITEM_PATHS = Object.freeze(['system.uses']);

const FACTION_DISPOSITIONS = Object.freeze({
  Lord: 1, Retainer: 1, Ally: 1, Enemy: -1, Boss: -1, Neutral: 0
});

/* -------------------------------------------- */
/*  Effect host execution                       */
/* -------------------------------------------- */

/**
 * Writes for effect steps, used by EffectExecutionService (engine/effects/execution.mjs).
 *
 * Each writer records what it is about to change in `runtime.operation` (the running command's undo record), so a
 * failed command can be undone, then makes ordinary Foundry writes. In the step methods, the argument named
 * `operation` is the prepared effect step, not that undo record.
 */
export class FoundryEffectRepository {
  constructor({ health, movements = null, unitAudio = null, guardBonds = null, crossings = null, wait = delay }) {
    this.health = health;
    this.movements = movements;
    this.unitAudio = unitAudio;
    this.guardBonds = guardBonds;
    this.crossings = crossings;
    this.wait = wait;
  }

  /** One percentile drawn in [0, 100), for a chance node. */
  randomPercent() { return Math.random() * 100; }

  /** One index drawn uniformly below `count`, for a random pick among that many squares. */
  randomIndex(count) { return Math.floor(Math.random() * Math.max(0, Math.floor(Number(count) || 0))); }

  randomId() { return documentId(); }

  /**
   * Record the unit before its first health change, then read its health. `ruleTarget` is the health the damage or
   * healing is worked out against: as the current combat exchange sees it if the unit is in one, otherwise its own.
   */
  async healthSnapshot(actorUuid, tokenUuid, runtime = null, combatContext = null) {
    await captureUnit(runtime, actorUuid, tokenUuid);
    const snapshot = await this.health.getSnapshot(actorUuid, tokenUuid);
    if (!snapshot) return null;
    const ruleTarget = await projectExchangeHealthTarget(combatContext, snapshot);
    return Object.freeze({ ...snapshot, ruleTarget });
  }

  /** Write damage through FoundryHealthRepository, recorded in the running command's undo record. */
  commitDamage(snapshot, resolution, runtime = null) {
    return this.health.commitDamage(snapshot, resolution, { operation: runtime?.operation ?? null });
  }

  commitHealing(snapshot, resolution, runtime = null) {
    return this.health.commitHealing(snapshot, resolution, { operation: runtime?.operation ?? null });
  }

  async rollFormula(formula) {
    const roll = await new Roll(String(formula || '0')).evaluate();
    return Number(roll.total) || 0;
  }

  /** Turn a step's target reference, such as `self`, `target` or an area, into units (resolveEffectTargets). */
  resolveTargets(reference, runtime) {
    return resolveEffectTargets(reference, runtime);
  }

  /** Name every document one mechanical step writes, before it writes any (resolveEffectWrites). */
  resolveWrites(operation, runtime) {
    return resolveEffectWrites(operation, runtime, { guardBonds: this.guardBonds });
  }

  /**
   * Prepare a summon's Token data and id without creating it (prepareEffectSpawn). A recast never replaces a summon
   * this command already placed, for another target of the same use or an earlier step.
   */
  prepareSpawn(operation, runtime) {
    const placed = new Set([...(placedSummons.get(runtime.operation) ?? []), runtime.lastSpawnedTokenUuid]);
    return prepareEffectSpawn(operation.step, runtime, {
      reserved: null, randomId: () => this.randomId(), guardBonds: this.guardBonds, placed
    });
  }

  /** Remove the summons this one replaces, then create the new summon Token under its pre-picked id. */
  createSpawn(spawn, operation, runtime) {
    return createEffectSpawn(spawn, operation.step, runtime, this.guardBonds);
  }

  /** Add the voice clip or linked status only the host client can read to a presentation step, or null to skip it. */
  async preparePresentation(operation, runtime) {
    if (operation.step.kind === 'playVoice') {
      const [target] = await this.resolveTargets(operation.step.target, runtime);
      if (!target?.actorUuid) return null;
      if (operation.step.skipIfSelf === true && target.actorUuid === runtime.self?.actorUuid) return null;
      const voiceFile = await this.unitAudio?.voiceCategoryClip?.(target.actorUuid, operation.step.category);
      if (!voiceFile) return null;
      return Object.freeze({
        ...operation,
        step: Object.freeze({ ...operation.step, voiceFile })
      });
    }
    if (operation.step.kind === 'animation') return prepareEffectAnimation(operation, runtime, this);
    return operation;
  }

  /**
   * Run one non-health mechanical step against the documents resolved for it earlier. `choices` carries choices
   * already made for the step, such as the random square EffectExecutionService draws once.
   */
  async executeMechanical(operation, runtime, writes, choices = null) {
    const step = operation.step;
    const targets = writes.targets;
    switch (step.kind) {
      case 'modShield': return modifyShield(targets, step, runtime);
      case 'applyEffect': return applyEffects(targets, step, this, runtime);
      case 'removeEffect': return removeEffects(writes, step, runtime, this);
      case 'setFaction': return setFaction(targets, step, runtime);
      case 'moveToken': return moveTokens(targets, step, runtime, this, choices);
      case 'restoreAction': return restoreActions(targets, step, runtime);
      case 'unequip': return unequip(targets, runtime);
      case 'guard': return guard(targets, runtime, this);
      case 'terrainEdit': return applyTerrainEffect(step, runtime, this);
      default: return Object.freeze({ ok: true, skipped: true, kind: step.kind });
    }
  }
}

/* -------------------------------------------- */
/*  Captures                                    */
/* -------------------------------------------- */

/**
 * Record everything one step is about to write in the command's undo record, in one save. Documents already
 * recorded are skipped. If the record can't be saved this throws `OperationCaptureError`, so the step stops before
 * writing.
 */
async function captureDocuments(runtime, documents) {
  const named = documents.filter(Boolean);
  if (named.length) await runtime?.operation?.capture({ documents: named });
}

/** Record one unit's Actor and Token together, before a health change or a forced move. */
async function captureUnit(runtime, actorUuid, tokenUuid) {
  if (!runtime?.operation) return;
  await captureDocuments(runtime, [await resolveActor(actorUuid), await resolveToken(tokenUuid)]);
}

function documentId() {
  return foundry.utils.randomID();
}

/* -------------------------------------------- */
/*  Mechanical operations                       */
/* -------------------------------------------- */

/**
 * Add the step's amount to each target's Shield, never below 0. A cap limits gains only: a unit already at or over
 * the cap gains nothing, and a negative amount always applies in full.
 */
async function modifyShield(targets, step, runtime) {
  const delta = Math.round(Number(step.formula) || 0);
  const hasCap = delta > 0 && step.cap !== undefined && step.cap !== null && step.cap !== '';
  const maximum = hasCap ? Math.round(Number(step.cap) || 0) : null;
  const writes = [];
  for (const { target, actor } of await resolveTargetActors(targets)) {
    const current = Number(actor.system?.resources?.shields?.value) || 0;
    if (hasCap && current >= maximum) continue;
    const next = Math.max(0, hasCap ? Math.min(maximum, current + delta) : current + delta);
    if (next !== current) writes.push({ target, actor, current, next });
  }
  await captureDocuments(runtime, writes.map(write => write.actor));
  const shieldChanges = [];
  for (const { target, actor, current, next } of writes) {
    await actor.update({ 'system.resources.shields.value': next }, effectOptions());
    shieldChanges.push(Object.freeze({
      actorUuid: actor.uuid,
      tokenUuid: String(target.tokenUuid ?? ''),
      gained: next - current
    }));
  }
  return Object.freeze({ ok: true, shieldChanges: Object.freeze(shieldChanges) });
}

/**
 * Plan every target's status first, so the whole step is recorded in one save, then write them in order. An
 * application an immunity refuses writes nothing. Each result says whether the status was created and whether it is
 * beneficial; activation XP uses both. A step with a linked animation tag also lists, per unit, the id of the
 * ActiveEffect that carries the status, which persistent animations and change faction steps tie themselves to.
 */
async function applyEffects(targets, step, repository, runtime) {
  const definition = step.preset === 'custom' ? step.customData
    : STATUS_EFFECTS[step.preset];
  if (!definition) return Object.freeze({ ok: false, code: PRECONDITION.PRESET_MISSING });
  const caster = await resolveActor(runtime.self?.actorUuid);
  const plans = (await resolveTargetActors(targets)).map(({ actor }) =>
    planEffectApplication(actor, activeEffectData(definition, step, caster, repository.randomId())));
  await runtime?.operation?.capture({
    creating: plans.filter(plan => plan.createId)
      .map(plan => ({ parent: plan.actor, documentName: 'ActiveEffect', ids: [plan.createId] })),
    documents: plans.map(plan => plan.effect).filter(Boolean)
  });

  const linkedAnimations = [];
  const applications = [];
  for (const plan of plans) {
    const application = await applyPlannedEffect(plan);
    applications.push(Object.freeze({
      actorUuid: plan.actor.uuid,
      beneficial: plan.data.flags?.[SYSTEM_ID]?.beneficial === true,
      ...application
    }));
    if (!step.linkAnimationTag) continue;
    linkedAnimations.push(Object.freeze({
      baseTag: step.linkAnimationTag,
      actorUuid: plan.actor.uuid,
      tag: application.linkedAnimationTag ?? plan.data.flags?.[SYSTEM_ID]?.linkedAnimationTag ?? step.linkAnimationTag,
      created: application.created === true,
      effectId: application.created === true ? plan.createId : String(plan.effect?.id ?? '')
    }));
  }
  return Object.freeze({
    ok: true,
    applications: Object.freeze(applications),
    linkedAnimations: Object.freeze(linkedAnimations)
  });
}

/**
 * Remove the statuses the step selects from each unit it reaches. A "placed by" unit that names nobody in this run
 * removes nothing.
 */
async function removeEffects(writes, step, runtime, repository) {
  const actors = await Promise.all(writes.actorUuids.map(actorUuid => resolveActor(actorUuid)));
  const placedBy = step.placedByActor
    ? String((await repository.resolveTargets(step.placedByActor, runtime))[0]?.actorUuid ?? '')
    : '';
  if (step.placedByActor && !placedBy) return Object.freeze({ ok: true });
  const excluded = step.scope === 'global' && step.excludeTarget === true ? runtime.target?.actorUuid : '';
  const removals = [];
  for (const actor of actors.filter(Boolean)) {
    if (actor.uuid === excluded) continue;
    const effects = collectionValues(actor.effects).filter(effect => shouldRemoveEffect(effect, step, placedBy));
    if (effects.length) removals.push({ actor, effects });
  }
  if (!removals.length) return Object.freeze({ ok: true });
  await runtime?.operation?.capture({ deleting: removals.flatMap(removal => removal.effects) });
  for (const { actor, effects } of removals) {
    await actor.deleteEmbeddedDocuments('ActiveEffect', effects.map(effect => effect.id), effectOptions());
  }
  return Object.freeze({ ok: true });
}

/**
 * Change each target's faction role and token disposition, and with `grantOwnership` make the caster's players its
 * owners, for as long as the status named by `linkStatusTag` lasts. What changed is saved on that status's
 * ActiveEffect, and revertFactionLink writes it back when the status is deleted. A unit the tagged status did not
 * reach in this run (it was immune, or the status step never ran) is left alone; when no unit has it, the step is
 * skipped with FACTION_STATUS_MISSING.
 */
async function setFaction(targets, step, runtime) {
  const linked = runtime.linkedAnimationTags?.[String(step.linkStatusTag ?? '')]?.byActor ?? {};
  const caster = await resolveActor(runtime.self?.actorUuid);
  const grants = step.grantOwnership === true ? Object.keys(playerOwnerUpdates(caster))
    .map(path => path.slice('ownership.'.length)) : [];
  const disposition = FACTION_DISPOSITIONS[String(step.actorType ?? '')] ?? null;
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const units = [];
  for (const { target, actor } of await resolveTargetActors(targets)) {
    const effect = actor.effects?.get?.(String(linked[actor.uuid]?.effectId ?? '')) ?? null;
    if (!effect) continue;
    const token = disposition === null ? null : await resolveToken(target.tokenUuid);
    const plan = planFactionChange({
      record: effect.flags?.[SYSTEM_ID]?.[FACTION_LINK_FLAG] ?? null,
      order: nextFactionLinkOrder(factionLinkRecords(actor).map(entry => entry.record)),
      role: String(step.actorType),
      disposition: token ? disposition : null,
      current: {
        role: actor._source?.system?.faction?.role,
        tokenUuid: token?.uuid,
        disposition: token?.disposition,
        ownership: actor._source?.ownership ?? actor.ownership
      },
      grants,
      ownerLevel
    });
    units.push({ actor, token, effect, plan });
  }
  if (!units.length) return Object.freeze({ ok: false, code: PRECONDITION.FACTION_STATUS_MISSING });
  await captureDocuments(runtime, units.flatMap(unit => [unit.actor, unit.token, unit.effect]));
  for (const { actor, token, effect, plan } of units) {
    const ownership = Object.fromEntries(Object.entries(plan.ownership)
      .map(([userId, level]) => [`ownership.${userId}`, level]));
    await effect.update({ [`flags.${SYSTEM_ID}.${FACTION_LINK_FLAG}`]: plan.record }, effectOptions());
    await actor.update({ 'system.faction.role': step.actorType, ...ownership }, effectOptions());
    if (token) await token.update({ disposition }, effectOptions());
  }
  return Object.freeze({ ok: true });
}

/** Every faction change record on an actor's statuses, with the id of the ActiveEffect holding it. */
function factionLinkRecords(actor) {
  return collectionValues(actor?.effects)
    .map(effect => ({ effectId: String(effect.id ?? ''), record: effect.flags?.[SYSTEM_ID]?.[FACTION_LINK_FLAG] }))
    .filter(entry => isFactionLinkRecord(entry.record));
}

/**
 * Write back what a change faction step changed, once the status it was tied to has been deleted. The internal
 * faction revert command runs this on the host client, inside the command that deleted the status when there is one,
 * and records the writes in that command's undo record (`operation`). A missing actor or token is skipped. When the
 * status is back (an undo recreated it), nothing is written.
 * @param {{actorUuid: string, effectId: string, record: object}} payload The deleted status's actor, its id, and the
 *   faction change record it held.
 * @param {object|null} operation The running command's undo record.
 * @returns {Promise<{ok: boolean, reverted: boolean}>}
 */
export async function revertFactionLink({ actorUuid, effectId, record } = {}, operation = null) {
  const actor = await resolveActor(actorUuid);
  if (!actor || !isFactionLinkRecord(record) || actor.effects?.get?.(String(effectId ?? ''))) {
    return Object.freeze({ ok: true, reverted: false });
  }
  const token = record.tokenUuid ? await resolveToken(record.tokenUuid) : null;
  const plan = planFactionRevert({
    record,
    others: factionLinkRecords(actor),
    current: {
      role: actor._source?.system?.faction?.role,
      disposition: token?.disposition ?? null,
      ownership: actor._source?.ownership ?? actor.ownership
    },
    ownerLevel: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
  });
  const actorUpdate = {};
  if (plan.role !== null) actorUpdate['system.faction.role'] = plan.role;
  for (const [userId, level] of Object.entries(plan.grant)) actorUpdate[`ownership.${userId}`] = level;
  for (const userId of plan.revoke) Object.assign(actorUpdate, forcedDeletion(`ownership.${userId}`));
  const tokenUpdate = token && plan.disposition !== null ? { disposition: plan.disposition } : null;
  const handOff = plan.handOff ? actor.effects.get(plan.handOff.effectId) ?? null : null;
  const writesActor = Object.keys(actorUpdate).length > 0;
  await operation?.capture({ documents: [writesActor ? actor : null, tokenUpdate ? token : null, handOff]
    .filter(Boolean) });
  if (handOff) {
    await handOff.update({ [`flags.${SYSTEM_ID}.${FACTION_LINK_FLAG}`]: plan.handOff.record }, effectOptions());
  }
  if (writesActor) await actor.update(actorUpdate, effectOptions());
  if (tokenUpdate) await token.update(tokenUpdate, effectOptions());
  return Object.freeze({ ok: true, reverted: writesActor || Boolean(tokenUpdate) || Boolean(handOff) });
}

/** The turn slots a restore can hand back. A unit whose slot was spent is listed in `restored`. */
const RESTORABLE_TURN_SLOTS = Object.freeze([
  'system.turn.actionAvailable', 'system.turn.bonusActionAvailable', 'system.turn.movementAvailable'
]);

/** Hand back the step's turn slots. `refreshed` lists the slots each unit got, for a combat exchange to keep. */
async function restoreActions(targets, step, runtime) {
  const changes = {};
  if (step.actions?.includes('standard')) changes['system.turn.actionAvailable'] = true;
  if (step.actions?.includes('bonus')) changes['system.turn.bonusActionAvailable'] = true;
  if (step.actions?.includes('movement')) changes['system.turn.movementAvailable'] = true;
  if (step.actions?.includes('turn')) {
    Object.assign(changes, TURN_REFRESH);
    changes['system.turn.continuationPending'] = '';
    changes['system.turn.continuationRequestId'] = '';
  }
  const actors = (await resolveTargetActors(targets)).map(unit => unit.actor);
  const restored = actors.filter(actor => RESTORABLE_TURN_SLOTS
    .some(path => path in changes && foundry.utils.getProperty(actor._source, path) === false))
    .map(actor => actor.uuid);
  const slots = {
    action: changes['system.turn.actionAvailable'] === true,
    bonus: changes['system.turn.bonusActionAvailable'] === true,
    movement: changes['system.turn.movementAvailable'] === true,
    turn: step.actions?.includes('turn') === true
  };
  await captureDocuments(runtime, actors);
  for (const actor of actors) await actor.update(changes, effectOptions());
  return Object.freeze({
    ok: true,
    restored: Object.freeze(restored),
    refreshed: Object.freeze(actors.map(actor => Object.freeze({ actorUuid: actor.uuid, ...slots })))
  });
}

async function unequip(targets, runtime) {
  const items = [];
  for (const { actor } of await resolveTargetActors(targets)) {
    const item = collectionValues(actor.items).find(candidate => candidate.system?.isWielded === true);
    if (item) items.push(item);
  }
  await captureDocuments(runtime, items);
  for (const item of items) await item.update({ 'system.isWielded': false }, effectOptions());
  return Object.freeze({ ok: true });
}

async function guard(targets, runtime, repository) {
  const bonds = repository.guardBonds;
  if (!bonds) return Object.freeze({ ok: false, code: 'effect.guard-unavailable' });
  const token = await resolveToken(targets[0]?.tokenUuid);
  if (!token) return Object.freeze({ ok: false, code: PRECONDITION.GUARD_TARGET_MISSING });
  const guarderToken = await resolveToken(runtime.self?.tokenUuid);
  const guarder = bonds.sideOf(guarderToken);
  const guarded = bonds.sideOf(token);
  const verdict = resolveGuardBond({ guarder, guarded });
  if (!verdict.ok) return verdict;
  await captureDocuments(runtime, [guarderToken, token,
    await resolveActor(guarder.actorUuid), await resolveActor(guarded.actorUuid)]);
  return bonds.establish(planGuardBond({ guarder, guarded }), { operation: runtime.operation ?? null });
}

/** The live Actor behind each target a step names, in order, skipping units that have gone. */
async function resolveTargetActors(targets) {
  const units = [];
  for (const target of targets ?? []) {
    const actor = await resolveActor(target.actorUuid);
    if (actor) units.push({ target, actor });
  }
  return units;
}

async function moveTokens(targets, step, runtime, repository, choices = null) {
  const moving = await resolveToken(targets[0]?.tokenUuid);
  if (!moving) return Object.freeze({ ok: false, code: PRECONDITION.MOVE_TARGET_MISSING });
  const scene = moving.parent;
  const gridSize = scene.grid.size;
  const teleport = step.bypassWalls === true;
  // A wall-ignoring move is an instant 'displace'. Other forced moves use the system's 'charge' action, which
  // animates the slide and has no wall or cost check of its own. Foundry v14 ignores the `teleport` option.
  const moveOptions = teleport
    ? { teleport, animate: false, emblemEffectSettlement: true }
    : { teleport, animate: true, animation: { ...EFFECT_MOVE_ANIMATION }, emblemEffectSettlement: true };
  const moveAction = teleport ? 'displace' : EFFECT_MOVE_ACTION;

  if (step.mode === 'swap') {
    const pair = await resolveToken((await repository.resolveTargets(step.pair ?? 'self', runtime))[0]?.tokenUuid);
    if (!pair) return Object.freeze({ ok: false, code: PRECONDITION.MOVE_PAIR_MISSING });
    const left = tokenGridPosition(moving, gridSize);
    const right = tokenGridPosition(pair, gridSize);
    if (!await swapLandsFree(moving, pair, right, repository) || !await swapLandsFree(pair, moving, left, repository)) {
      return Object.freeze({ ok: false, code: PRECONDITION.MOVE_BLOCKED });
    }
    await captureDocuments(runtime, [moving, pair]);
    if (!await displaceToken(moving, right, gridSize, moveOptions, moveAction)) {
      return Object.freeze({ ok: false, code: 'effect.move-refused' });
    }
    if (!await displaceToken(pair, left, gridSize, moveOptions, moveAction)) {
      return Object.freeze({ ok: false, code: 'effect.move-refused' });
    }
    await awaitTokenSlide(repository, left, right, teleport);
    return recheckGuardBonds([moving, pair], repository, runtime,
      { ok: true, displaced: displacedUnits([moving, pair]) });
  }

  let destination = null;
  if (step.mode === 'teleport') {
    destination = await resolveEffectLocation(step.location ?? runtime.targetLocation, runtime, gridSize);
  } else if (step.mode === 'shift') {
    const current = tokenGridPosition(moving, gridSize);
    destination = {
      x: current.x + Math.round(Number(step.dx) || 0),
      y: current.y + Math.round(Number(step.dy) || 0)
    };
  } else if (step.mode === 'push' || step.mode === 'pull') {
    const pair = await resolveToken((await repository.resolveTargets(step.pair ?? 'self', runtime))[0]?.tokenUuid);
    // A unit can't be pushed away from or pulled toward itself: there is no direction to go.
    if (!pair || pair.uuid === moving.uuid) return Object.freeze({ ok: false, code: PRECONDITION.MOVE_PAIR_MISSING });
    const current = tokenGridPosition(moving, gridSize);
    const reference = tokenGridPosition(pair, gridSize);
    const dx = current.x - reference.x;
    const dy = current.y - reference.y;
    const direction = step.mode === 'push' ? 1 : -1;
    const distance = Math.max(1, Math.floor(Number(step.distance) || 1));
    destination = { ...current };
    if (Math.abs(dx) >= Math.abs(dy)) destination.x += (dx >= 0 ? 1 : -1) * distance * direction;
    else destination.y += (dy >= 0 ? 1 : -1) * distance * direction;
  } else if (step.mode === 'terrainGeometry') {
    destination = await resolveGeometryDestination(moving, step, runtime, repository, choices);
  } else {
    return Object.freeze({ ok: false, code: PRECONDITION.MOVE_MODE_UNKNOWN });
  }

  if (!destination) return Object.freeze({ ok: false, code: PRECONDITION.MOVE_DESTINATION_MISSING });
  if (destination.standing === true) {
    const stood = Object.freeze({ x: destination.x, y: destination.y });
    return recheckGuardBonds([moving], repository, runtime, { ok: true, destination: stood });
  }
  if (step.mode === 'teleport' && !await teleportLandsFree(moving, destination, teleport, repository)) {
    return Object.freeze({ ok: false, code: PRECONDITION.MOVE_BLOCKED });
  }
  if (FORCED_STEP_MODES.has(step.mode)) {
    const forced = await judgeForcedStep(moving, destination, teleport, repository);
    if (forced.outcome === FORCED_STEP_OUTCOMES.DESCENT) return forceCrossing(moving, destination, runtime, repository);
    if (forced.outcome !== FORCED_STEP_OUTCOMES.WALK) {
      return Object.freeze({ ok: true, blocked: forced.outcome, destination: Object.freeze(destination) });
    }
  }
  await captureDocuments(runtime, [moving]);
  const origin = tokenGridPosition(moving, gridSize);
  if (!await displaceToken(moving, destination, gridSize, moveOptions, moveAction)) {
    return Object.freeze({ ok: false, code: 'effect.move-refused' });
  }
  await awaitTokenSlide(repository, origin, destination, teleport);
  const displaced = origin.x !== destination.x || origin.y !== destination.y ? displacedUnits([moving]) : [];
  return recheckGuardBonds([moving], repository, runtime,
    { ok: true, destination: Object.freeze(destination), displaced: Object.freeze(displaced) });
}

/**
 * The Actors of the Tokens a move step put on another square, which EffectExecutionService reports as displaced
 * units for activation XP. A standing placement or a blocked forced step displaces nobody.
 */
function displacedUnits(tokens) {
  return Object.freeze(tokens.map(token => String(token.actor?.uuid ?? '')).filter(Boolean));
}

/** Move modes that force a unit onto a square it did not choose. judgeForcedStep checks the map for these first. */
const FORCED_STEP_MODES = new Set(['push', 'pull', 'shift']);

/**
 * Check a forced step against the mover's scene with the movement rules. A scene without a square grid can't be
 * checked, so the step goes ahead as written.
 */
async function judgeForcedStep(moving, destination, ignoreWalls, repository) {
  const board = await repository.movements?.getSnapshot?.(moving.uuid);
  if (!board?.supportedGrid) return { outcome: FORCED_STEP_OUTCOMES.WALK, crossing: null };
  return resolveForcedStep(board, board.current, destination, { ignoreWalls });
}

/**
 * Whether a teleport may land on its square: no other token takes it, it is on the map and not blocked, and, unless
 * the step passes through walls, no wall stands on the straight line there. A scene without a square grid can't be
 * checked, so the teleport goes ahead.
 */
async function teleportLandsFree(moving, destination, ignoreWalls, repository) {
  const board = await repository.movements?.getSnapshot?.(moving.uuid);
  if (!board?.supportedGrid) return true;
  return resolveLanding(board, board.current, destination, { ignoreWalls }) === FORCED_STEP_OUTCOMES.WALK;
}

/**
 * Whether one side of a swap may land on the other's square: no third token takes the squares it would cover and
 * they are on the map and not blocked. The partner leaving that square doesn't count. Walls are not checked.
 */
async function swapLandsFree(token, partner, destination, repository) {
  const board = await repository.movements?.getSnapshot?.(token.uuid);
  if (!board?.supportedGrid) return true;
  const rect = tokenGridRect(partner);
  const leaving = new Set(rectKeys(rect.x, rect.y, rect.width, rect.height));
  const cleared = {
    ...board,
    blockedCells: (board.blockedCells ?? []).filter(key => !leaving.has(key)),
    occupiedCells: (board.occupiedCells ?? []).filter(key => !leaving.has(key))
  };
  return resolveLanding(cleared, board.current, destination, { ignoreWalls: true }) === FORCED_STEP_OUTCOMES.WALK;
}

/**
 * Hand a forced drop to the movement crossing command, which runs inside this command and shares its undo record.
 * That command rolls the check, moves the unit and applies fall damage, removing the Token if the unit is defeated.
 */
async function forceCrossing(moving, destination, runtime, repository) {
  if (typeof repository.crossings?.force !== 'function') {
    return Object.freeze({ ok: false, code: 'effect.move-crossing-unavailable' });
  }
  await captureDocuments(runtime, [moving, moving.actor]);
  const displaced = displacedUnits([moving]);
  const crossed = await repository.crossings.force({
    tokenUuid: moving.uuid, destinationX: destination.x, destinationY: destination.y
  });
  if (crossed?.ok !== true) return Object.freeze({ ok: false, code: String(crossed?.code ?? 'effect.move-refused') });
  const moved = Object.freeze({
    ok: true,
    destination: Object.freeze({ ...destination }),
    crossing: crossed.data,
    displaced: crossed.data?.moved === true ? displaced : Object.freeze([])
  });
  if (crossed.data?.defeated === true) return moved;
  const walkingSpeed = Number(globalThis.CONFIG?.Token?.movement?.defaultSpeed) || 6;
  await awaitTokenSlide(repository, crossed.data?.origin, crossed.data?.destination, false, walkingSpeed);
  return recheckGuardBonds([moving], repository, runtime, moved);
}

/**
 * Wait as long as the slide takes before the next effect step. This uses a timer, not the canvas animation, which
 * may not play on the host client or may be cut short.
 * @param {{wait?: Function}} repository The effect repository, whose `wait` times the slide.
 * @param {{x: number, y: number}|null|undefined} from Grid square the unit left.
 * @param {{x: number, y: number}|null|undefined} to Grid square the unit was written to.
 * @param {boolean} teleport Whether the move was written without animation.
 * @param {number} [speed] Grid squares per second the move animates at.
 * @returns {Promise<void>}
 */
async function awaitTokenSlide(repository, from, to, teleport, speed = EFFECT_MOVE_ANIMATION.movementSpeed) {
  if (teleport || !from || !to) return;
  const squares = Math.hypot((Number(to.x) || 0) - (Number(from.x) || 0), (Number(to.y) || 0) - (Number(from.y) || 0));
  const pace = Number(speed) > 0 ? Number(speed) : EFFECT_MOVE_ANIMATION.movementSpeed;
  const milliseconds = Math.min(DRIVEN_WALK_TIMING.SETTLE_MAX_MS, Math.round((squares / pace) * 1000));
  if (milliseconds <= 0) return;
  await (typeof repository?.wait === 'function' ? repository.wait(milliseconds) : delay(milliseconds));
}

/**
 * Full HP and Stance for an unlinked unit or Object an effect has just placed, as fillPlacedToken gives a token
 * placed by hand.
 * @param {object} token The placed Token.
 * @param {object} actor Its Actor.
 * @returns {object} Actor changes, empty when the unit is linked, of another type, or already whole.
 */
function placementFill(token, actor) {
  if (token.actorLink === true || !['Character', 'Object'].includes(actor.type)) return {};
  const resources = actor.system.resources;
  const fill = {};
  const maxHp = Number(resources.hp.max) || 0;
  const maxStance = Number(resources.stn.max) || 0;
  if (resources.hp.value !== maxHp) fill['system.resources.hp.value'] = maxHp;
  if (resources.stn.value !== maxStance) fill['system.resources.stn.value'] = maxStance;
  return fill;
}

/**
 * Create the summon Token under its pre-picked id, or reuse one already on the scene with that id, then set it up.
 * The summons it replaces are removed first, the same way an expired summon is. A failed command deletes a Token
 * created here outright, so only a reused one has its current state recorded.
 */
async function createEffectSpawn(spawn, step, runtime, guardBonds = null) {
  const scene = await resolveScene(spawn.sceneUuid);
  if (!scene) return Object.freeze({ ok: false, code: PRECONDITION.SPAWN_SOURCE_MISSING });
  const replaced = (await Promise.all((spawn.replacedTokenUuids ?? []).map(uuid => resolveToken(uuid))))
    .filter(token => token?.parent === scene);
  if (replaced.length && !await removeSummons(scene, replaced, guardBonds, runtime?.operation ?? null)) {
    return Object.freeze({ ok: false, code: 'effect.spawn-failed' });
  }
  let created = scene.tokens.get(spawn.tokenId) ?? null;
  const placedNow = !created;
  if (!created) {
    await runtime?.operation?.capture({
      creating: [{ parent: scene, documentName: 'Token', ids: [spawn.tokenId] }]
    });
    [created] = await scene.createEmbeddedDocuments('Token', [{ ...spawn.data }], {
      keepId: true, emblemEffectSettlement: true
    });
  }
  if (!created) return Object.freeze({ ok: false, code: 'effect.spawn-failed' });
  if (runtime?.operation) {
    const placed = placedSummons.get(runtime.operation) ?? new Set();
    placedSummons.set(runtime.operation, placed.add(String(created.uuid)));
  }
  const spawnedActor = created.actor;
  if (spawnedActor) {
    const caster = await resolveActor(runtime.self?.actorUuid);
    const actorUpdates = {};
    if (step.isFriendly === true) actorUpdates['system.faction.role'] = friendlyFaction(caster?.system?.faction?.role);
    if (step.grantOwnership === true) Object.assign(actorUpdates, playerOwnerUpdates(caster));
    if (step.summoningSickness === true) {
      actorUpdates['system.turn.actionAvailable'] = false;
      actorUpdates['system.turn.bonusActionAvailable'] = false;
      actorUpdates['system.turn.movementAvailable'] = false;
    }
    const fill = placedNow ? placementFill(created, spawnedActor) : {};
    Object.assign(actorUpdates, fill);
    const tokenUpdates = {};
    const disposition = FACTION_DISPOSITIONS[String(actorUpdates['system.faction.role'] ?? '')];
    if (disposition !== undefined) tokenUpdates.disposition = disposition;
    if (placedNow && created.actorLink !== true && ['Character', 'Object'].includes(spawnedActor.type)
      && Number(created.rotation ?? 0) !== 0) tokenUpdates.rotation = 0;
    if (!placedNow) await captureDocuments(runtime, [spawnedActor, created]);
    if (Object.keys(actorUpdates).length) await spawnedActor.update(actorUpdates, effectOptions());
    if (Object.keys(tokenUpdates).length) await created.update(tokenUpdates, effectOptions());
  }
  return Object.freeze({
    ok: true,
    spawned: Object.freeze({ actorUuid: String(created.actor?.uuid ?? ''), tokenUuid: String(created.uuid ?? '') })
  });
}

/**
 * Write the terrain cells an effect edits onto the scene. Each cell is deleted first so no old keys survive the
 * merge, then its new value is written. Only those flag paths are recorded for undo; the whole scene is too large.
 */
async function applyTerrainEffect(step, runtime, repository) {
  const scene = await resolveScene(runtime.sceneUuid);
  if (!scene) return Object.freeze({ ok: false, code: 'effect.scene-missing' });
  const keys = await terrainEffectCellKeys(step, runtime, scene);
  const patch = buildTerrainEffectPatch(step, repository.randomId());
  if (!keys.length || terrainEffectPatchIsEmpty(patch)) return Object.freeze({ ok: true, applied: 0 });
  const caster = await resolveActor(runtime.self?.actorUuid);
  const plan = planTerrainEffectEdit({
    grid: structuredClone(scene.getFlag(SYSTEM_ID, TERRAIN_GRID_FLAG) ?? {}),
    records: structuredClone(scene.getFlag(SYSTEM_ID, TERRAIN_EDIT_RECORDS_FLAG) ?? {}),
    cells: keys,
    patch,
    overwrite: step.overwrite === true,
    duration: Math.max(0, Math.floor(Number(step.duration) || 0)),
    replacePrevious: step.replacePrevious === true,
    casterUuid: String(runtime.self?.actorUuid ?? ''),
    itemUuid: String(runtime.activatedItemUuid ?? ''),
    castId: repository.randomId(),
    ticksOn: factionGroup(caster?.system?.faction?.role) === 'enemy' ? 'Player' : 'Enemy',
    inCombat: Boolean(scene.getFlag(SYSTEM_ID, 'combatPhase'))
  });
  if (!plan.cells.length) return Object.freeze({ ok: true, applied: 0 });

  const deletions = {};
  const replacements = {};
  const paths = [];
  for (const cell of plan.cells) {
    const gridPath = `flags.${SYSTEM_ID}.${TERRAIN_GRID_FLAG}.${cell.key}`;
    const recordPath = `flags.${SYSTEM_ID}.${TERRAIN_EDIT_RECORDS_FLAG}.${cell.key}`;
    paths.push(gridPath, recordPath);
    Object.assign(deletions, forcedDeletion(gridPath), forcedDeletion(recordPath));
    if (cell.entry) replacements[gridPath] = cell.entry;
    if (cell.record) replacements[recordPath] = cell.record;
  }
  await runtime?.operation?.capture({ documents: [{ document: scene, paths }] });
  await scene.update(deletions, effectOptions());
  if (Object.keys(replacements).length) await scene.update(replacements, effectOptions());
  return Object.freeze({ ok: true, applied: plan.applied });
}

async function terrainEffectCellKeys(step, runtime, scene) {
  const grid = scene.getFlag(SYSTEM_ID, TERRAIN_GRID_FLAG) ?? {};
  const size = scene.grid.size;
  const columns = Math.ceil((Number(scene.width) || 0) / size);
  const rows = Math.ceil((Number(scene.height) || 0) / size);
  const coordinates = await terrainEffectCoordinates(step, runtime, { size, columns, rows });
  return [...new Set(coordinates
    .filter(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < columns && y < rows)
    .map(({ x, y }) => terrainKey(x, y))
    .filter(key => !grid[key]?.obstacle && !grid[key]?.impassable))];
}

/**
 * The squares a terrain step names: an area, a unit's own squares, or else the cast area (the use's covered squares,
 * then its clicked square). With no cast area it names none, rather than the squares under a unit.
 */
async function terrainEffectCoordinates(step, runtime, { size, columns, rows }) {
  const reference = step.target;
  if (reference?.area) {
    const centre = (reference.area.center ?? 'self') === 'target' ? runtime.target : runtime.self;
    const origin = await resolveToken(centre?.tokenUuid);
    if (!origin) return [];
    return [...generateAreaCells({
      source: tokenGridPosition(origin, size),
      footprint: { width: origin.width, height: origin.height },
      radius: reference.area.radius ?? 1,
      includeSource: reference.area.includeCenter === true,
      columns,
      rows
    })].map(parseCellKey);
  }
  if (typeof reference === 'string') {
    const token = await resolveToken((reference === 'target' ? runtime.target : runtime.self)?.tokenUuid);
    return token ? tokenFootprintCoordinates(token, size) : [];
  }
  if (runtime.effectTiles && typeof runtime.effectTiles[Symbol.iterator] === 'function'
    && typeof runtime.effectTiles !== 'string') {
    const tiles = [...runtime.effectTiles].map(value => parseCellKey(value));
    if (tiles.length) return tiles;
  }
  if (runtime.targetLocation
    && Number.isFinite(Number(runtime.targetLocation.x)) && Number.isFinite(Number(runtime.targetLocation.y))) {
    return [{ x: Number(runtime.targetLocation.x), y: Number(runtime.targetLocation.y) }];
  }
  return [];
}

function tokenFootprintCoordinates(token, size) {
  const start = tokenGridPosition(token, size);
  const width = Math.max(1, Math.floor(Number(token.width) || 1));
  const height = Math.max(1, Math.floor(Number(token.height) || 1));
  const coordinates = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) coordinates.push({ x: start.x + x, y: start.y + y });
  }
  return coordinates;
}

/* -------------------------------------------- */
/*  Effect move helpers                         */
/* -------------------------------------------- */

/**
 * The square a terrainGeometry move sends the unit to. The first prompted move in a command takes the square the
 * user picked before confirming the use; any other works out its own from the geometry.
 */
async function resolveGeometryDestination(moving, step, runtime, repository, choices = null) {
  const geometry = normalizeGeometry(step.geometry);
  const picked = runtime.prePickedPlacement;
  const owner = runtime.operation ?? runtime;
  if (geometry.pick === 'prompt' && picked && !spentPlacements.has(owner)
    && Number.isFinite(Number(picked.x)) && Number.isFinite(Number(picked.y))) {
    spentPlacements.add(owner);
    return { x: Number(picked.x), y: Number(picked.y) };
  }
  const anchor = geometry.anchor === 'targetLocation'
    ? runtime.targetLocation
    : tokenGridRect(await resolveToken((geometry.anchor === 'self' ? runtime.self : runtime.target)?.tokenUuid));
  if (!anchor || (anchor.tokenUuid && anchor.tokenUuid === moving.uuid)) return null;
  const movement = await repository.movements?.getSnapshot?.(moving.uuid);
  if (!movement?.supportedGrid) return null;
  const anchorRect = anchor.width
    ? anchor
    : { x: Math.floor(Number(anchor.x)), y: Math.floor(Number(anchor.y)), width: 1, height: 1 };
  const budget = geometryPlacementBudget(geometry, {
    totalMovement: movement.totalMovement,
    effectRange: runtime.effectRange
  });
  const sight = projectGeometrySight(movement, anchorRect, movement.footprint, geometry);
  const candidates = resolveGeometryPlacements({ ...movement, sight }, anchorRect, geometry, budget);
  if (geometry.pick === 'random') return randomPlacement(candidates, movement.current, moving, repository, choices);
  if (!candidates.length) return null;
  return candidates[0];
}

/**
 * Pick a random square through `choices.placement` (drawn in EffectExecutionService), or draw here without choices.
 * The mover's own square means it stays put, and a square outside the candidates returns null.
 */
async function randomPlacement(candidates, current, moving, repository, choices) {
  const offered = candidates.map(({ x, y }) => Object.freeze({ x, y }));
  const cell = typeof choices?.placement === 'function'
    ? await choices.placement(offered, moving.uuid)
    : offered.length ? offered[repository.randomIndex(offered.length)] : null;
  if (!Number.isFinite(cell?.x) || !Number.isFinite(cell?.y)) return null;
  const standing = Number(current?.x) === cell.x && Number(current?.y) === cell.y;
  if (standing) return { x: cell.x, y: cell.y, standing: true };
  return offered.some(({ x, y }) => x === cell.x && y === cell.y) ? { x: cell.x, y: cell.y } : null;
}

async function recheckGuardBonds(tokens, repository, runtime, moved = { ok: true }) {
  await repository.guardBonds?.recheck(tokens.map(token => token.uuid), { operation: runtime.operation ?? null });
  return Object.freeze(moved);
}

/* -------------------------------------------- */
/*  Effect data helpers                         */
/* -------------------------------------------- */

function friendlyFaction(actorType) {
  const group = factionGroup(actorType);
  return group === 'enemy' ? 'Enemy' : group === 'neutral' ? 'Neutral' : 'Ally';
}

function playerOwnerUpdates(actor) {
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const updates = {};
  for (const [userId, level] of Object.entries(actor?.ownership ?? {})) {
    if (userId === 'default' || Number(level) < owner || game.users.get(userId)?.isGM !== false) continue;
    updates[`ownership.${userId}`] = owner;
  }
  return updates;
}

/**
 * The ActiveEffect data one apply status step creates. A custom status is brought to the current shape by
 * normalizeCustomStatus and keeps its own duration, where 0 means it lasts until a trigger removes it. A registry
 * status lasts the step's duration, else its configured one, else the default, and never less than 1 phase. It gets
 * no `triggerSheds`, so its end triggers keep the older rule in planStatusTicks. Either kind takes its linked
 * animation tag from the step.
 */
function activeEffectData(definition, step, caster, randomId) {
  const custom = step.preset === 'custom';
  const base = custom ? normalizeCustomStatus(definition, step) : {};
  const statuses = base.statuses ?? definition.statuses ?? (definition.id ? [definition.id] : []);
  const flags = structuredClone(base.flags ?? {});
  const statusFlags = custom
    ? { ...(flags[SYSTEM_ID] ?? {}) }
    : {
      [ENCOUNTER_DECAY_FLAGS.PHASE_END]: true,
      ...(definition.beneficial === true ? { beneficial: true } : {}),
      ...(definition.harmful === true ? { harmful: true } : {}),
      ...(definition.flags ?? {})
    };
  // Every status remembers who applied it, which a remove status step's "placed by" matches.
  if (caster) statusFlags.placedBy = { actorUuid: caster.uuid };
  if (step.preset === 'marked' && caster) {
    statusFlags.markedBy = { actorUuid: caster.uuid, actorType: caster.system?.faction?.role };
  }
  if (step.preset === 'taunted' && caster) {
    statusFlags.tauntedBy = {
      actorUuid: caster.uuid,
      name: String(caster.name ?? ''),
      actorType: caster.system?.faction?.role
    };
  }
  if (!custom) {
    const requested = Number(step.durationPhases);
    const configured = Number(statusFlags.duration ?? definition.duration);
    statusFlags.duration = Number.isFinite(requested) && requested >= 1
      ? requested : Number.isFinite(configured) && configured >= 1 ? configured : DEFAULT_STATUS_DURATION;
  }
  if (step.durationStacks === true) statusFlags.durationStacks = true;
  if (step.linkAnimationTag) {
    statusFlags.linkedAnimationBase = step.linkAnimationTag;
    statusFlags.linkedAnimationTag = `${step.linkAnimationTag}-${randomId}`;
  }
  flags[SYSTEM_ID] = statusFlags;
  flags.core = { ...(flags.core ?? {}), ...(statuses[0] ? { statusId: statuses[0] } : {}) };
  return {
    ...base,
    name: base.name ?? definition.name ?? definition.label ?? step.preset,
    img: base.img ?? definition.img,
    description: String(base.description ?? definition.description ?? ''),
    changes: structuredClone(base.changes ?? definition.changes ?? definition.extraChanges ?? []),
    statuses: structuredClone(statuses),
    flags
  };
}

/**
 * Decide what applying one status to one unit writes, without writing it: an immunity refuses, a new status names the
 * id it will be created under, and a repeat names the ActiveEffect it updates. A repeat of a stackable status adds
 * its stacks up to the limit, and at the limit still counts as applied. A repeat's phases are added to those left
 * when either the step or the effect stacks duration, and otherwise replace them, 0 included.
 * `applyEffects` records every plan in one save before `applyPlannedEffect` writes them.
 */
function planEffectApplication(actor, data) {
  const incomingFlags = data.flags?.[SYSTEM_ID] ?? {};
  const immunity = collectionValues(actor.items).find(item => {
    const names = item.flags?.[SYSTEM_ID]?.statusImmunities;
    return Array.isArray(names) && names.some(name => effectIdentityMatches(data, name));
  });
  if (immunity) {
    return { actor, data, outcome: Object.freeze({
      applied: false,
      created: false,
      reason: 'immune',
      actorName: String(actor.name ?? ''),
      effectName: String(data.name ?? ''),
      immunitySourceName: String(immunity.name ?? ''),
      linkedAnimationTag: null
    }) };
  }

  const existing = collectionValues(actor.effects).find(effect => String(effect.name ?? '') === String(data.name ?? ''));
  if (!existing) return { actor, data, createId: documentId() };

  const currentFlags = existing.flags?.[SYSTEM_ID] ?? {};
  const update = {
    [`flags.${SYSTEM_ID}.applyCount`]: Math.max(1, Math.floor(Number(currentFlags.applyCount) || 1)) + 1
  };
  if (incomingFlags.stackable === true) {
    const current = Math.max(1, Math.floor(Number(currentFlags.stackCount) || 1));
    const limit = Math.max(0, Math.floor(Number(incomingFlags.stackLimit) || 0));
    const incoming = Math.max(1, Math.floor(Number(incomingFlags.stackCount) || 1));
    const next = limit > 0 ? Math.max(current, Math.min(limit, current + incoming)) : current + incoming;
    if (next !== current) {
      update['system.changes'] = rescaleStackChanges(existing, current, next);
      update[`flags.${SYSTEM_ID}.stackCount`] = next;
    }
  }
  const incomingDuration = Number(incomingFlags.duration);
  const existingDuration = Number(currentFlags.duration);
  if (incomingFlags.durationStacks === true || currentFlags.durationStacks === true) {
    update[`flags.${SYSTEM_ID}.duration`] = (Number.isFinite(existingDuration) ? existingDuration : 0)
      + (Number.isFinite(incomingDuration) ? incomingDuration : 0);
    update[`flags.${SYSTEM_ID}.durationStacks`] = true;
  } else if (Number.isFinite(incomingDuration)) {
    update[`flags.${SYSTEM_ID}.duration`] = incomingDuration;
  }
  return { actor, data, effect: existing, update };
}

/** Write one application planEffectApplication planned, after applyEffects has recorded it. */
async function applyPlannedEffect({ actor, data, outcome, createId, effect, update }) {
  if (outcome) return outcome;
  if (createId) {
    const [created] = await actor.createEmbeddedDocuments('ActiveEffect', [{ ...data, _id: createId }],
      { ...effectOptions(), keepId: true }) ?? [];
    return Object.freeze({
      applied: Boolean(created),
      created: Boolean(created),
      linkedAnimationTag: created?.flags?.[SYSTEM_ID]?.linkedAnimationTag
        ?? data.flags?.[SYSTEM_ID]?.linkedAnimationTag ?? null
    });
  }
  await effect.update(update, effectOptions());
  return Object.freeze({
    applied: true,
    created: false,
    linkedAnimationTag: effect.flags?.[SYSTEM_ID]?.linkedAnimationTag ?? null
  });
}

function effectIdentityMatches(data, identity) {
  const wanted = String(identity ?? '').toLowerCase();
  return Boolean(wanted) && (String(data.name ?? '').toLowerCase() === wanted
    || collectionValues(data.statuses).some(status => String(status).toLowerCase() === wanted));
}

/**
 * Name a persistent animation after the status its tag links it to, and tie it to that status's ActiveEffect so
 * Sequencer ends it when the status goes. `attachToEffectName` names the effect outright. Without it, the effect
 * carrying the linked tag is the one tied, since nothing else would ever end the animation. A tied visual
 * attaches to the step's `attachTarget`, the unit whose status owns the animation, unless the visual names its own.
 */
async function prepareEffectAnimation(operation, runtime, repository) {
  const step = operation.step;
  if (!step.persistent || !step.animation) return operation;
  let tag = step.tag;
  let tieName = String(step.attachToEffectName ?? '');
  if (tag) {
    const [target] = await repository.resolveTargets(step.attachTarget ?? 'target', runtime);
    const record = runtime.linkedAnimationTags?.[step.tag];
    const linked = (target?.actorUuid && record?.byActor?.[target.actorUuid]) ?? record?.last ?? null;
    if (linked?.created === false) return null;
    const actor = target?.actorUuid && !(linked?.tag && tieName) ? await resolveActor(target.actorUuid) : null;
    const effects = collectionValues(actor?.effects);
    const effect = effects.find(candidate => candidate.flags?.[SYSTEM_ID]?.linkedAnimationBase === step.tag);
    tag = linked?.tag || effect?.flags?.[SYSTEM_ID]?.linkedAnimationTag || step.tag;
    tieName ||= String(effects.find(candidate =>
      candidate.flags?.[SYSTEM_ID]?.linkedAnimationTag === tag)?.name ?? '');
  }
  const animation = structuredClone(step.animation);
  for (const animationStep of animation?.steps ?? []) {
    if (animationStep.kind !== 'effect') continue;
    animationStep.persist = true;
    if (tag) animationStep.name = tag;
    if (tieName) {
      animationStep.tieToEffectName = tieName;
      animationStep.attachTo ||= step.attachTarget ?? 'target';
    }
  }
  return Object.freeze({
    ...operation,
    step: Object.freeze({ ...step, tag, animation: Object.freeze(animation) })
  });
}

/**
 * Whether a removeEffect step takes this status off. Every selector the step sets must match: the name, a dispel
 * (harmful or beneficial), and the unit that applied it (a Mark applied before statuses recorded that still carries
 * it as its marker). A step with no selector removes nothing, and the system's own effects are never removed.
 */
function shouldRemoveEffect(effect, step, placedBy = '') {
  if (isSystemEffect(effect)) return false;
  const flags = effect.flags?.[SYSTEM_ID] ?? {};
  const dispels = step.dispelHarmful === true || step.dispelBeneficial === true;
  if (step.name && String(effect.name ?? '') !== String(step.name)) return false;
  if (dispels && !((step.dispelHarmful === true && flags.harmful === true)
    || (step.dispelBeneficial === true && flags.beneficial === true))) return false;
  const placer = String(flags.placedBy?.actorUuid ?? flags.markedBy?.actorUuid ?? '');
  if (placedBy && placer !== placedBy) return false;
  return Boolean(step.name || dispels || placedBy);
}

/** Status ids of effects the system keeps itself: Stance Break and the equipment and mount markers. */
const SYSTEM_STATUS_IDS = new Set([STANCE_BREAK_STATUS_ID, 'Wielding', 'Wearing', 'Mounted']);

/**
 * Whether an ActiveEffect belongs to the system rather than to a status an effect applied: Stance Break, a Guard
 * bond half, a Rally, or a wield, armor or mount effect. Each has its own rule for when it ends.
 */
function isSystemEffect(effect) {
  const flags = effect.flags?.[SYSTEM_ID] ?? {};
  if (flags.isWieldEffect === true || flags.isArmorEffect === true || flags.isMountEffect === true) return true;
  if (flags.guardRole || flags.rally) return true;
  const name = String(effect.name ?? '');
  if (name === STANCE_BREAK_EFFECT_NAME) return true;
  return collectionValues(effect.statuses).some(id => SYSTEM_STATUS_IDS.has(String(id)));
}

/* -------------------------------------------- */
/*  Token HUD statuses                          */
/* -------------------------------------------- */
/** A unit's applied registry status as the Token HUD reads it: the effect, its stacks, and whether it stacks. */
export function projectAppliedStatus(actor, key) {
  const definition = STATUS_EFFECTS[key];
  if (!definition) return null;
  const effect = collectionValues(actor?.effects).find(candidate =>
    collectionValues(candidate.statuses).includes(definition.id)) ?? null;
  const stackable = definition.flags?.stackable === true;
  const stacks = effect ? Math.max(1, Math.floor(Number(effect.flags?.[SYSTEM_ID]?.stackCount) || 1)) : 0;
  return { definition, effect, stackable, stacks };
}

/**
 * Apply a registry status from the Token HUD through the same status data as effects.
 * Stacking statuses gain or lose one stack within their limit. Other statuses toggle or clear.
 */
export async function adjustAppliedStatus(actor, key, { shed = false } = {}) {
  const applied = projectAppliedStatus(actor, key);
  if (!applied || !actor) return { ok: false, code: 'effect.preset-missing' };
  const { definition, effect, stackable, stacks } = applied;
  if (!effect) {
    if (shed) return { ok: true, changed: false, stacks: 0 };
    const data = activeEffectData(definition, { preset: key }, null, foundry.utils.randomID());
    await actor.createEmbeddedDocuments('ActiveEffect', [data]);
    return { ok: true, changed: true, stacks: 1 };
  }
  if (!stackable || (shed && stacks <= 1)) {
    await effect.delete();
    return { ok: true, changed: true, stacks: 0 };
  }
  const limit = Math.max(0, Math.floor(Number(definition.flags?.stackLimit) || 0));
  const next = shed ? stacks - 1 : limit > 0 ? Math.min(limit, stacks + 1) : stacks + 1;
  if (next === stacks) return { ok: true, changed: false, stacks };
  await effect.update({
    'system.changes': rescaleStackChanges(effect, stacks, next),
    [`flags.${SYSTEM_ID}.stackCount`]: next
  });
  return { ok: true, changed: true, stacks: next };
}

/* -------------------------------------------- */
/*  Item activation settlement                  */
/* -------------------------------------------- */

/**
 * Writes for an item use, recorded in the use's undo record (`snapshot.operation`).
 *
 * The command calls `captureUse` once, before its first write. Each method below then records only what it newly
 * touches, such as a new Rally effect or a used-up Item. Continuation, progression and saving-throw writes go
 * through FoundryCombatSettlementRepository, into the same undo record.
 */
export class FoundryItemActivationSettlement {
  constructor({ settlement }) {
    this.settlement = settlement;
  }

  /**
   * Record, in one save, what every item use can change: the caster's and each target's Actor and Token, and the
   * activated Item's charges. A use that destroys the Item records it as a deletion in settleActivation instead.
   * @param {object} snapshot The item use's state, including the command's `operation`.
   */
  async captureUse(snapshot) {
    const operation = snapshot.operation ?? null;
    if (!operation) return true;
    const itemUuid = String(snapshot.envelope?.itemUuid ?? '');
    const uuids = [snapshot.source?.actorUuid, snapshot.source?.tokenUuid, itemUuid,
      ...(snapshot.targets ?? []).flatMap(target => [target.actorUuid, target.tokenUuid])];
    const documents = [];
    for (const uuid of [...new Set(uuids.map(value => String(value ?? '')).filter(Boolean))]) {
      const document = await resolveDocument(uuid);
      if (document) documents.push(uuid === itemUuid ? { document, paths: ACTIVATED_ITEM_PATHS } : document);
    }
    await operation.capture({ documents });
    return true;
  }

  /** Spend the Willpower charge a target used for advantage on its save. */
  async spendWillpower(actorUuid, snapshot) {
    const actor = await resolveActor(actorUuid);
    if (!actor) return false;
    const current = Math.max(0, Number(actor.system?.special?.willpower?.value) || 0);
    if (current < 1) return true;
    await snapshot.operation?.capture({ documents: [actor] });
    await actor.update({ 'system.special.willpower.value': current - 1 }, effectOptions());
    return true;
  }

  /** Apply one Rally under a pre-picked effect id; see applyRallyEffect in rallies.mjs. */
  applyRally(actorUuid, intent, snapshot) {
    return applyRallyEffect(actorUuid, intent, snapshot.operation ?? null);
  }

  /** Raise the user's stats and growths by the planned Booster gains. HP or Stance rises with its maximum. */
  async applyBooster(actorUuid, plan, snapshot) {
    const actor = await resolveActor(actorUuid);
    if (!actor || !plan) return false;
    const updates = {};
    for (const stat of plan.stats ?? []) {
      if (stat.gain !== 0) updates[`system.stats.${stat.key}.base`] = stat.to;
    }
    for (const growth of plan.growths ?? []) {
      if (growth.gain !== 0) updates[`system.growth.${growth.key}.base`] = growth.to;
    }
    for (const resource of plan.resources ?? []) {
      const current = Number(actor._source?.system?.resources?.[resource.key]?.value) || 0;
      updates[`system.resources.${resource.key}.value`] = Math.max(0, current + resource.gain);
    }
    if (!Object.keys(updates).length) return true;
    await snapshot.operation?.capture({ documents: [actor] });
    await actor.update(updates, effectOptions());
    return true;
  }

  /** Spend the effects consumed by the act of rolling a save, whatever its result. */
  consumeSavingThrowEffects(actorUuid, targetAttribute, snapshot) {
    return this.settlement.consumeSavingThrowEffects(actorUuid, targetAttribute, snapshot.operation ?? null);
  }

  /**
   * Count one XP-granting use of an activation XP entry on the caster; see recordActivationExperienceUse.
   * @param {object} snapshot The item use's state, including the command's `operation`.
   * @param {{encounterId: string, key: string}} use The running encounter's id and the entry's key.
   */
  recordExperienceUse(snapshot, use) {
    return recordActivationExperienceUse(snapshot.source.actorUuid, use, snapshot.operation ?? null);
  }

  /** Save the proficiency experience an Item use earned, through FoundryCombatSettlementRepository. */
  async commitProgression(updates, snapshot) {
    await this.settlement.commitProgression(updates, snapshot.operation ?? null);
    return true;
  }

  /** Drop the caster's Sanctuary when it aims at anything other than an ally. */
  async removeSanctuary(actorUuid, effectId, snapshot) {
    const actor = await resolveActor(actorUuid);
    if (!actor || !effectId) return false;
    const effect = actor.effects.get(String(effectId));
    if (!effect) return true;
    await snapshot.operation?.capture({ deleting: [effect] });
    await actor.deleteEmbeddedDocuments('ActiveEffect', [effect.id], effectOptions());
    return true;
  }

  /**
   * Spend the activation's use and action, destroying a consumable that reaches zero, and count the units a Rally
   * reached in the caster's record of this map's Rallies (rallyRecordUpdate in rallies.mjs). The action spend and the
   * Rally record go to the caster in one write; the Rally path is recorded for undo before any of this method's
   * writes.
   * @param {object} snapshot The item use's state, including the command's `operation`.
   * @param {{consumption: object, actionSpend: object, ralliedActorUuids?: string[]}} settlement What the use spends,
   *   and the units it Rallied, in the order they were Rallied.
   * @returns {Promise<boolean>} False when the caster or the Item is gone.
   */
  async settleActivation(snapshot, { consumption, actionSpend, ralliedActorUuids = [] }) {
    const actor = await resolveActor(snapshot.source.actorUuid);
    if (!actor) return false;
    const rallyRecord = await rallyRecordUpdate(actor, ralliedActorUuids, snapshot.operation ?? null);
    const item = await resolveItem(snapshot.envelope.itemUuid);
    if (!item) return false;
    if (consumption.consume) {
      await item.update({ 'system.uses.current': consumption.remaining }, effectOptions());
    }
    if (consumption.destroy && item.id) {
      await snapshot.operation?.capture({ deleting: [item] });
      await actor.deleteEmbeddedDocuments('Item', [item.id], effectOptions());
    }
    const casterUpdate = { ...actionSpend, ...rallyRecord };
    if (Object.keys(casterUpdate).length) await actor.update(casterUpdate, effectOptions());
    return true;
  }

  /**
   * Apply the caster's after-use continuation now, or save it to apply later. `cantersAfter` says whether declining
   * an Extra Action choice the use offers may Canter.
   */
  settleContinuation(state, movementResolution, continuation, requestId, operation = null,
    { cantersAfter = false } = {}) {
    return this.settlement.settleSourceContinuation(
      continuationSubject(state, operation), movementResolution, continuation, requestId, { cantersAfter }
    );
  }

  /** Apply a saved end-of-turn continuation once the use's animation has finished. */
  settlePendingContinuation(state, continuation, operation = null) {
    return this.settlement.settlePendingContinuation(continuationSubject(state, operation), continuation, operation);
  }
}

/** The state the combat continuation writers expect. `source.hp.value` (0 or 1) says whether the caster is down. */
function continuationSubject(state, operation = null) {
  return {
    ...state,
    operation,
    source: { hp: { value: state.sourceDefeated === true ? 0 : 1 } }
  };
}

/**
 * Count one XP-granting use of an activation XP entry on the caster, stamped with the encounter it was made in, after
 * recording the caster for undo. A record left from another encounter is replaced rather than added to;
 * projectActivationExperienceUses reads it back.
 * @param {string} actorUuid The caster's Actor.
 * @param {{encounterId: string, key: string}} use The running encounter's id and the entry's key.
 * @param {object|null} operation The running command's undo record.
 * @returns {Promise<boolean>} False when the caster is gone.
 */
export async function recordActivationExperienceUse(actorUuid, { encounterId, key }, operation = null) {
  const actor = await resolveActor(actorUuid);
  if (!actor) return false;
  const uses = projectActivationExperienceUses(actor, encounterId);
  const counted = uses.find(use => use.key === key);
  if (counted) counted.count += 1;
  else uses.push({ key, count: 1 });
  await operation?.capture({ documents: [actor] });
  await actor.update({ [`flags.${SYSTEM_ID}.${ACTIVATION_EXPERIENCE_USES_FLAG}`]: { encounterId, uses } },
    effectOptions());
  return true;
}
