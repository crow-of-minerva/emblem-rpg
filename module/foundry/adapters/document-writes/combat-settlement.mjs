/** @layer foundry/adapters/document-writes */
import { COMBAT_CONTINUATIONS } from '../../../contracts/domains/combat.mjs';
import { TURN_REFRESH } from '../../../game/combat/phases.mjs';
import { KARMA_LEDGER_SETTING, USER_LOCK_SETTING } from '../../../config/settings.mjs';
import { bookKarmaSequence } from '../dice/karma.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import { clone, resolveActor, resolveArmamentActor, resolveItem, resolveToken } from '../services/host.mjs';

const settlementOptions = () => ({ emblemCombatSettlement: true });

/**
 * The world settings an exchange may rewrite: the karma ledger, and the movement lock (USER_LOCK_SETTING) released
 * when the attacker's movement plan closes. captureExchange saves both for undo up front, because either may be
 * written long after the first Actor write.
 */
const EXCHANGE_SETTINGS = Object.freeze([KARMA_LEDGER_SETTING, USER_LOCK_SETTING]);

/**
 * An exchange changes only the uses of a weapon, Weapon Art or armor, and the durability of a rack armament, so
 * captureExchange saves just those fields for undo rather than the whole Item. commitItemUses and
 * FoundryHealthRepository write exactly these paths.
 */
const ITEM_USE_PATHS = Object.freeze(['system.uses']);
const ARMAMENT_DURABILITY_PATHS = Object.freeze(['system.armament.durability']);

/**
 * Saves the results of a combat exchange for engine/combat/exchanges (resolution.mjs, blows.mjs, settlement.mjs).
 *
 * Each write first saves the old values on the command's operation (its undo record), which the engine passes in.
 * Most methods take it as an argument (the exchange carries it as `exchange.operation`), and
 * settleSourceContinuation reads it from `snapshot.operation`. commitKarma saves nothing itself, since
 * captureExchange already saved the ledger. CommandDispatcher keeps the changes when the command returns ok and puts
 * the old values back otherwise.
 */
export class FoundryCombatSettlementRepository {
  constructor({ health, movements }) {
    this.health = health;
    this.movements = movements;
  }

  /* -------------------------------------------- */
  /*  Undo record for the exchange                */
  /* -------------------------------------------- */

  /**
   * Save for undo, in one call, the old values of everything an exchange always touches: both units' Actors and
   * Tokens whole, the uses of the Items the blows spend and of each side's worn armor, the durability of the
   * armament Actor behind a rack weapon, and the two world settings. resolveExchange (exchanges/resolution.mjs)
   * calls this before its first write. Later writes save only what this leaves out, such as other fields of these
   * Items.
   * @param {object} snapshot The exchange's starting state, read again just before the exchange.
   * @param {object|null} operation The dispatcher operation (the command's undo record), or null outside a command.
   */
  async captureExchange(snapshot, operation = null) {
    if (!operation) return true;
    const documents = [];
    const seen = new Set();
    const add = (document, paths = null) => {
      if (!document || seen.has(document)) return;
      seen.add(document);
      documents.push(paths ? { document, paths } : document);
    };
    for (const uuid of [snapshot.sourceActorUuid, snapshot.targetActorUuid]) add(await resolveActor(uuid));
    for (const uuid of [snapshot.sourceTokenUuid, snapshot.targetTokenUuid]) add(await resolveToken(uuid));
    for (const uuid of [snapshot.sourceItemUuid, snapshot.sourceWeaponArtUuid, snapshot.targetItemUuid,
      snapshot.source?.healthSnapshot?.armor?.itemUuid, snapshot.target?.healthSnapshot?.armor?.itemUuid]) {
      if (!uuid) continue;
      const item = await resolveItem(uuid);
      if (item) add(item, ITEM_USE_PATHS);
      else add(await resolveArmamentActor(uuid), ARMAMENT_DURABILITY_PATHS);
    }
    await operation.capture({ documents, settings: EXCHANGE_SETTINGS });
    return true;
  }

  /* -------------------------------------------- */
  /*  Blows                                       */
  /* -------------------------------------------- */

  /** Save a resolved blow through FoundryHealthRepository, with undo through the exchange's operation. */
  async commitBlow(side, resolution, operation = null) {
    return this.health.commitDamage(side.healthSnapshot, resolution, { operation });
  }

  /**
   * Remove the effects an attack ends as soon as it is declared: the attacker's Sanctuary and its effects that end
   * on a hostile action, and the target's effects that end when targeted. Then apply Flanked to each flanked side.
   */
  async prepareExchange(snapshot, operation = null) {
    await removeActorEffects(operation, snapshot.sourceActorUuid, [
      snapshot.source.effectLifecycle?.sanctuaryEffectId,
      ...(snapshot.source.effectLifecycle?.hostileActionEffectIds ?? [])
    ]);
    await removeActorEffects(operation, snapshot.targetActorUuid,
      snapshot.target.effectLifecycle?.hostileTargetedEffectIds);
    if (snapshot.source.exchangeFlanked) await applyFlankedEffect(operation, snapshot.sourceActorUuid);
    if (snapshot.target.exchangeFlanked) await applyFlankedEffect(operation, snapshot.targetActorUuid);
    return true;
  }

  /** Ground a flier attacking with an Armament, once the attack is accepted. */
  async settleGrounding(side, operation = null) {
    if (side.groundOnArmamentUse !== true) return true;
    const actor = await resolveActor(side.actorUuid);
    if (!actor) throw new Error('Combat source Actor disappeared.');
    if (!actor.getFlag(SYSTEM_ID, 'armamentUuid') || actor.system?.statuses?.grounded === true) return true;
    await writeCombatActor(operation, actor, { 'system.statuses.grounded': true });
    return true;
  }

  /** Consume an ally's Mark as soon as the empowered blow is aimed. */
  async consumeMarkedEffect(side, operation = null) {
    if (!side.markedEffect) return true;
    await removeActorEffects(operation, side.markedEffect.actorUuid, [side.markedEffect.effectId]);
    return true;
  }

  /**
   * After each blow: if it landed, thin the defender's stacks, then remove the defender's effects that end when
   * attacked and advance the attacker's attack index.
   */
  async completeBlow(acting, defending, { landed, operation = null }) {
    if (landed) await removeEffectStacks(operation, defending.actorUuid);
    await removeCapturedEffects(operation, defending.actorUuid, defending.effectLifecycle?.removeWhenAttacked);
    const actor = await resolveActor(acting.actorUuid);
    if (!actor) throw new Error('Combat acting Actor disappeared.');
    const attackIndex = Math.max(0, Math.floor(finite(actor.system?.turn?.attackIndex)));
    await writeCombatActor(operation, actor, { 'system.turn.attackIndex': attackIndex + 1 });
    return true;
  }

  /** Remove the effects spent by rolling a save: flagged for any save, or naming the attribute just rolled. */
  async consumeSavingThrowEffects(actorUuid, targetAttribute, operation = null) {
    const actor = await resolveActor(actorUuid);
    if (!actor) return false;
    const rolled = String(targetAttribute ?? '').toLowerCase();
    const ids = collectionValues(actor.effects).filter(effect => {
      const spec = effect.flags?.[SYSTEM_ID]?.removeOnSavingThrow;
      return spec === true || (typeof spec === 'string' && spec !== '' && spec.toLowerCase() === rolled);
    }).map(effect => effect.id);
    await removeActorEffects(operation, actorUuid, ids);
    return true;
  }

  /** Switch the defender's Adaptive weapon after its counterattack resolves. */
  async settleAdaptive(target, defenderCountered, operation = null) {
    if (defenderCountered && target.adaptive && target.hp.value > 0) {
      await switchAdaptiveWeapon(operation, target.actorUuid);
    }
    return true;
  }

  /** Once the exchange is over, remove both sides' effects that last only for it and reset their attack indexes. */
  async cleanupExchange(source, target, operation = null) {
    await removeActorEffects(operation, source.actorUuid, source.effectLifecycle?.combatEndEffectIds);
    await removeActorEffects(operation, target.actorUuid, target.effectLifecycle?.combatEndEffectIds);
    await resetAttackIndex(operation, source.actorUuid);
    await resetAttackIndex(operation, target.actorUuid);
    return true;
  }

  /** Spend one defender Dexterity point for every attack faced, whether or not the attacker cancelled it. */
  async spendDexterity(actorUuid, operation = null) {
    const actor = await resolveActor(actorUuid);
    const current = Math.max(0, finite(actor?.system?.special?.dexterity?.value));
    if (!actor || current < 1) return true;
    await writeCombatActor(operation, actor, { 'system.special.dexterity.value': current - 1 });
    return true;
  }

  /* -------------------------------------------- */
  /*  Exchange results                            */
  /* -------------------------------------------- */

  /** Spend the uses the blows added up, once every blow is resolved. A rack armament loses durability instead. */
  async commitItemUses(useLedger, operation = null) {
    for (const [itemUuid, uses] of Object.entries(useLedger ?? {})) {
      const item = await resolveItem(itemUuid);
      const armament = item ? null : await resolveArmamentActor(itemUuid);
      if (!item && !armament) throw new Error('Combat Item disappeared during settlement.');
      if (armament) {
        const durability = armament.system?.armament?.durability ?? {};
        if (durability.type === 'infinite') continue;
        const next = Math.max(0, Math.max(0, finite(durability.value)) - Math.max(0, Math.floor(finite(uses))));
        await operation?.capture({ documents: [{ document: armament, paths: ARMAMENT_DURABILITY_PATHS }] });
        await armament.update({ 'system.armament.durability.value': next }, settlementOptions());
        continue;
      }
      if (item.system?.uses?.type === 'infinite') continue;
      const current = Math.max(0, finite(item.system?.uses?.current));
      const next = Math.max(0, current - Math.max(0, Math.floor(finite(uses))));
      await operation?.capture({ documents: [{ document: item, paths: ITEM_USE_PATHS }] });
      await item.update({ 'system.uses.current': next }, settlementOptions());
    }
  }

  /** Save the weapon proficiency and experience updates the rules prepared for each Character. */
  async commitProgression(updates = {}, operation = null) {
    for (const [actorUuid, actorUpdates] of Object.entries(updates)) {
      if (!actorUpdates || Object.keys(actorUpdates).length === 0) continue;
      const actor = await resolveActor(actorUuid);
      if (!actor) throw new Error('Combat progression Actor disappeared.');
      await writeCombatActor(operation, actor, actorUpdates);
    }
  }

  /**
   * Book the exchange's own karma, in the order its blows decided it, only once the exchange is otherwise complete.
   * Karma is booked on top of the ledger as it stands now, so a booking another command made meanwhile is kept.
   * @returns {Promise<ReadonlyArray<object>>} Each `KarmaBooking` with the debt it read and left as booked.
   */
  async commitKarma(bookings = []) {
    return bookKarmaSequence(bookings);
  }

  /**
   * Apply the attacker's automatic follow-up to the exchange, such as resuming movement or ending the turn. A
   * follow-up that waits for a choice or for an animation is saved on the turn as `continuationPending`. An Extra
   * Action choice also saves `cantersAfter`, whether the action that offered it lets a declining unit Canter. Undo
   * goes through the exchange's operation, read from `snapshot.operation`.
   */
  async settleSourceContinuation(snapshot, movementResolution, continuation, requestId, { cantersAfter = false } = {}) {
    const operation = snapshot.operation ?? null;
    const actor = await resolveActor(snapshot.sourceActorUuid);
    if (!actor) return false;
    switch (continuation.kind) {
      case COMBAT_CONTINUATIONS.EXPLORATION:
        return this.movements.commit(snapshot.movement, movementResolution,
          movementSettlement(operation, { resume: true, endTurn: false }));
      case COMBAT_CONTINUATIONS.MULTIATTACK:
        if (!await this.movements.commit(snapshot.movement, movementResolution,
          movementSettlement(operation, { resume: true, endTurn: false, anchor: true }))) return false;
        await writeCombatActor(operation, actor, { 'system.turn.bonusActionAvailable': false });
        return true;
      case COMBAT_CONTINUATIONS.EXTRA_ACTION_CHOICE:
        if (!await this.movements.commit(snapshot.movement, movementResolution,
          movementSettlement(operation, { resume: true, endTurn: true }))) return false;
        await writeCombatActor(operation, actor, {
          'system.turn.continuationPending': COMBAT_CONTINUATIONS.EXTRA_ACTION_CHOICE,
          'system.turn.continuationRequestId': String(requestId ?? ''),
          'system.turn.continuationCanters': cantersAfter === true
        });
        return true;
      case COMBAT_CONTINUATIONS.CANTER:
        return this.movements.commit(snapshot.movement, movementResolution,
          movementSettlement(operation, { resume: true, endTurn: true, canter: true }));
      case COMBAT_CONTINUATIONS.BONUS_ACTION:
        if (snapshot.movement?.movementPlanning !== true) {
          await writeCombatActor(operation, actor, { 'system.turn.movementAvailable': false });
          return true;
        }
        return this.movements.commit(snapshot.movement, movementResolution,
          movementSettlement(operation, { resume: true, endTurn: false, anchor: true }));
      case COMBAT_CONTINUATIONS.END_TURN:
        if (!await this.movements.commit(snapshot.movement, movementResolution,
          movementSettlement(operation, { resume: false, endTurn: false }))) return false;
        if (snapshot.source?.hp?.value <= 0) return true;
        await writeCombatActor(operation, actor, {
          'system.turn.continuationPending': COMBAT_CONTINUATIONS.END_TURN,
          'system.turn.continuationRequestId': String(requestId ?? '')
        });
        return true;
      default:
        return false;
    }
  }

  /**
   * Carry out a follow-up saved as pending, once the player has chosen or the animation it waited for has played. An
   * Extra Action spends one from the pool, gives the Action and Bonus Action back, and adds one square to the
   * movement the turn has left (`movementBonus`). An end of turn keeps the slots effects gave the attacker during
   * the exchange (`keptSlots`).
   */
  async settlePendingContinuation(snapshot, continuation, operation = null) {
    const owner = operation ?? snapshot.operation ?? null;
    const actor = await resolveActor(snapshot.sourceActorUuid);
    if (!actor) return false;
    if (continuation.kind === COMBAT_CONTINUATIONS.EXTRA_ACTION) {
      const remaining = Math.max(0, finite(actor.system?.special?.extraActions?.value));
      if (remaining < 1 || actor.system?.turn?.extraActionUsed === true) return false;
      await writeCombatActor(owner, actor, {
        'system.special.extraActions.value': remaining - 1,
        'system.turn.actionAvailable': true,
        'system.turn.bonusActionAvailable': true,
        'system.turn.movementAvailable': true,
        'system.turn.movementBonus': Math.max(0, finite(actor.system?.turn?.movementBonus)) + 1,
        'system.turn.extraActionUsed': true,
        'system.turn.continuationPending': '',
        'system.turn.continuationRequestId': ''
      });
      return true;
    }
    if (continuation.kind === COMBAT_CONTINUATIONS.CANTER) {
      await writeCombatActor(owner, actor, {
        'system.turn.movementPlanning': true,
        'system.turn.movementAvailable': true,
        'system.turn.canterPathfinding': true,
        'system.turn.continuationPending': '',
        'system.turn.continuationRequestId': ''
      });
      return true;
    }
    if (continuation.kind !== COMBAT_CONTINUATIONS.END_TURN) return false;
    if (snapshot.continuationPending === COMBAT_CONTINUATIONS.END_TURN
      && snapshot.movement?.movementPlanning !== true) {
      const kept = continuation.keptSlots ?? {};
      await writeCombatActor(owner, actor, {
        'system.turn.actionAvailable': kept.action === true,
        'system.turn.bonusActionAvailable': kept.bonus === true,
        'system.turn.movementAvailable': kept.movement === true,
        ...(kept.turn === true ? TURN_REFRESH : {}),
        'system.turn.continuationPending': '',
        'system.turn.continuationRequestId': ''
      });
      return true;
    }
    return this.movements.commit(snapshot.movement, {
      destination: snapshot.movement.current,
      cost: 0,
      path: Object.freeze([snapshot.movement.current])
    }, movementSettlement(owner, { resume: false, endTurn: true }));
  }

  /* -------------------------------------------- */
  /*  Defeat                                      */
  /* -------------------------------------------- */

  /** Check a pending defeat again once the exchange is committed (FoundryHealthRepository.revalidateDefeat). */
  async defeatStatus(actorUuid, tokenUuid, options = {}) {
    return this.health.revalidateDefeat(actorUuid, tokenUuid, options);
  }

  async finishDefeat(actorUuid, tokenUuid, options = {}) {
    return this.health.finishDefeat(actorUuid, tokenUuid, options);
  }
}

/* -------------------------------------------- */
/*  Writes                                      */
/* -------------------------------------------- */

/** The options `FoundryMovementRepository.commit` takes, with the operation its own writes save their undo on. */
function movementSettlement(operation, options) {
  return { ...options, operation };
}

/** Save one Actor for undo, then write the changes with the combat marker its hooks check. */
async function writeCombatActor(operation, actor, changes) {
  await operation?.capture({ documents: [actor] });
  await actor.update(changes, settlementOptions());
}

async function removeActorEffects(operation, actorUuid, effectIds = []) {
  const actor = await resolveActor(actorUuid);
  const ids = [...new Set((effectIds ?? []).map(String).filter(id => id && actor?.effects.get(id)))];
  if (!ids.length) return;
  await operation?.capture({ deleting: ids.map(id => actor.effects.get(id)) });
  await actor.deleteEmbeddedDocuments('ActiveEffect', ids, settlementOptions());
}

async function applyFlankedEffect(operation, actorUuid) {
  const actor = await resolveActor(actorUuid);
  if (!actor || collectionValues(actor.effects).some(effect => String(effect.name ?? '') === 'Flanked')) return;
  const id = documentId();
  await operation?.capture({ creating: [{ parent: actor, documentName: 'ActiveEffect', ids: [id] }] });
  const created = await actor.createEmbeddedDocuments('ActiveEffect', [{
    _id: id,
    name: 'Flanked',
    img: 'systems/emblem-rpg/assets/status/Flanked.png',
    changes: [{ key: 'system.statuses.flanked', type: 'override', value: true, priority: 20 }],
    statuses: ['Flanked'],
    flags: {
      core: { statusId: 'Flanked' },
      [SYSTEM_ID]: { removeOnCombatSequenceEnd: true }
    }
  }], { ...settlementOptions(), keepId: true });
  if (!created?.length) throw new Error('The Flanked status could not be applied.');
}

/**
 * Remove the defender's effects that end when attacked, but only those still at the apply count read before the
 * exchange, so an effect applied again meanwhile stays.
 */
async function removeCapturedEffects(operation, actorUuid, checkpoints = []) {
  const actor = await resolveActor(actorUuid);
  if (!actor) throw new Error('Combat target Actor disappeared.');
  const ids = (checkpoints ?? []).filter(checkpoint => {
    const effect = actor.effects.get(checkpoint.id);
    return effect && (finite(effect.flags?.[SYSTEM_ID]?.applyCount) || 1) === checkpoint.applyCount;
  }).map(checkpoint => checkpoint.id);
  await removeActorEffects(operation, actorUuid, ids);
}

/**
 * Drop or thin every stack a landed blow spends, one effect at a time, saving each for undo before it changes. Only
 * `add` changes are scaled to the new stack count; other change types keep their value at any stack size.
 */
async function removeEffectStacks(operation, actorUuid) {
  const actor = await resolveActor(actorUuid);
  if (!actor) throw new Error('Combat target Actor disappeared.');
  const effects = collectionValues(actor.effects)
    .filter(effect => effect.flags?.[SYSTEM_ID]?.removeStackWhenHit === true);
  for (const effect of effects) {
    const flags = effect.flags?.[SYSTEM_ID] ?? {};
    const count = Math.max(1, Math.floor(finite(flags.stackCount) || 1));
    if (flags.stackable !== true || count - 1 < 1) {
      await removeActorEffects(operation, actorUuid, [effect.id]);
      continue;
    }
    const next = count - 1;
    const changes = collectionValues(effect._source?.system?.changes ?? effect.system?.changes ?? effect.changes)
      .map(raw => {
        const change = clone(raw);
        if (change.type !== 'add') return change;
        return { ...change, value: (Number(change.value) / count) * next };
      });
    await operation?.capture({ documents: [effect] });
    await effect.update({
      'system.changes': changes,
      [`flags.${SYSTEM_ID}.stackCount`]: next
    }, settlementOptions());
  }
}

async function resetAttackIndex(operation, actorUuid) {
  const actor = await resolveActor(actorUuid);
  if (!actor) throw new Error('Combat Actor disappeared during cleanup.');
  await writeCombatActor(operation, actor, { 'system.turn.attackIndex': 0 });
}

async function switchAdaptiveWeapon(operation, actorUuid) {
  const actor = await resolveActor(actorUuid);
  if (!actor) throw new Error('Adaptive Actor disappeared.');
  const wieldable = collectionValues(actor.items).filter(item => ['Weapon', 'Attack', 'Staff']
    .includes(String(item.system?.itemType ?? '')));
  const currentIndex = wieldable.findIndex(item => item.system?.isWielded === true);
  if (currentIndex < 0) return false;
  let next = null;
  for (let offset = 1; offset <= wieldable.length; offset += 1) {
    const candidate = wieldable[(currentIndex + offset) % wieldable.length];
    const usable = candidate.system?.uses?.type === 'infinite' || finite(candidate.system?.uses?.current) > 0;
    if (candidate.id !== wieldable[currentIndex].id && usable) { next = candidate; break; }
  }
  if (!next) return false;
  await operation?.capture({ documents: [wieldable[currentIndex], next] });
  await actor.updateEmbeddedDocuments('Item', [
    { _id: wieldable[currentIndex].id, 'system.isWielded': false },
    { _id: next.id, 'system.isWielded': true }
  ], settlementOptions());
  return true;
}

function documentId() {
  return foundry.utils.randomID();
}
