/** @layer foundry/hooks */
import { INTERNAL_COMMAND_IDS } from '../../contracts/commands.mjs';
import {
  innateGrantsAffectedByActorChange,
  innateGrantsAffectedByEffectChange,
  innateGrantsAffectedByItemChange
} from '../../game/character/innate-grants.mjs';
import {
  clearInnateSourceCache,
  invalidateInnateSource,
  unitHoldsInnateGrants
} from '../adapters/document-writes/characters.mjs';
import { isActiveGm as isCurrentCoordinator } from '../adapters/services/host.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';
import { changeLeafPaths } from '../../lib/core/runtime.mjs';

/* -------------------------------------------- */
/*  Innate grant lifecycle                      */
/* -------------------------------------------- */

/**
 * Innate grant hook handlers, on the host client. When a Character's grant conditions or a grant's source item
 * change, submit RECONCILE for it through `executeInternal` (MaintenanceScheduler.submit). Compendium actors are
 * skipped, and so is a unit that already holds its grants under their current names (unitHoldsInnateGrants). Every
 * startup sweeps all world and token Characters, so a unit missing a grant, holding an extra one or holding a Rally
 * named for an old affinity is fixed on the next load.
 */
export function createInnateGrantLifecycle({ executeInternal, notify = null }) {
  async function reconcile(actor) {
    if (!isCurrentCoordinator() || actor?.type !== 'Character' || actor.pack) return;
    if (await unitHoldsInnateGrants(actor)) return;
    const result = await executeInternal(
      INTERNAL_COMMAND_IDS.CHARACTER.INNATE_GRANTS.RECONCILE,
      { actorUuid: String(actor.uuid ?? '') }
    );
    if (result && result.ok === false && result.code !== RESULT_CODES.ACTOR_NOT_FOUND) notify?.showResult(result);
  }

  /**
   * Check every unit that could hold an innate item: each world actor and each token's actor on every Scene,
   * displayed or not. One at a time, so a large world doesn't read the packs for all of them at once.
   */
  async function reconcileAll() {
    if (!isCurrentCoordinator()) return;
    const seen = new Set();
    const queue = [];
    const add = actor => {
      if (actor?.type !== 'Character' || actor.pack || seen.has(actor.uuid)) return;
      seen.add(actor.uuid);
      queue.push(actor);
    };
    for (const actor of game.actors) add(actor);
    for (const scene of game.scenes) {
      for (const token of scene.tokens) add(token.actor);
    }
    for (const actor of queue) await reconcile(actor);
  }

  /**
   * Whether an item edit changed a grant source rather than one unit's inventory. A source lives in the world or a
   * compendium, so an owned item never is one. A source edit drops the cached lookup and checks every unit again.
   */
  function sourceChanged(item) {
    if (item?.parent?.documentName === 'Actor') return false;
    if (!invalidateInnateSource(item?.name)) return false;
    void reconcileAll();
    return true;
  }

  return Object.freeze({
    onReady() {
      clearInnateSourceCache();
      void reconcileAll();
    },
    onActorCreated(actor) {
      void reconcile(actor);
    },
    onActorUpdated(actor, changes) {
      if (!innateGrantsAffectedByActorChange(changeLeafPaths(changes))) return;
      void reconcile(actor);
    },
    onTokenCreated(token) {
      void reconcile(token?.actor);
    },
    onItemChanged(item) {
      if (sourceChanged(item)) return;
      void reconcile(item?.parent);
    },
    onItemUpdated(item, changes) {
      if (item?.parent?.documentName !== 'Actor') { sourceChanged(item); return; }
      if (!innateGrantsAffectedByItemChange(item, changeLeafPaths(changes))) return;
      void reconcile(item.parent);
    },
    onActiveEffectChanged(effect) {
      if (!innateGrantsAffectedByEffectChange(effectChanges(effect))) return;
      void reconcile(effect?.parent);
    }
  });
}

/* -------------------------------------------- */
/*  Change inspection                           */
/* -------------------------------------------- */

/** The effect's change rows, read from the document alias or the v14 system block behind it. */
function effectChanges(effect) {
  const changes = effect?.changes ?? effect?.system?.changes;
  return Array.isArray(changes) ? changes : [];
}
