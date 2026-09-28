/** @layer foundry/adapters/dice */
import {
  modifierChanceRequirements,
  modifierChanceRolls,
  modifierChancesFire
} from '../../../game/character/compilation.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { projectWieldedArmament } from '../projections/combat-context.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';
import { isActiveGm } from '../services/host.mjs';

/** The open action scope on the host. CommandDispatcher runs one root command at a time, and nested work joins it. */
let running = null;

/* -------------------------------------------- */
/*  Action scopes                               */
/* -------------------------------------------- */

/**
 * Roll each unit's chance modifiers once per host action, and give the rolls to Character preparation while the
 * action runs. A unit is prepared again only when a roll makes one of its modifiers apply. Previews and other clients
 * never see the rolls. engine/effects/modifier-chances.mjs opens and closes a scope around every command handler.
 */
export class FoundryModifierChanceScopes {
  /**
   * Open the scope of one host action, or join the scope the running action opened.
   * @param {{eager?: boolean}} [options] `eager` draws every chance-bearing Character in the world as the scope opens.
   *   Otherwise a unit is drawn only when `actionModifierChances` asks for it.
   * @returns {Promise<Readonly<object>|null>} The handle to pass to `close`, or null on a client that isn't the
   *   command host.
   */
  async open({ eager = false } = {}) {
    if (!isActiveGm()) return null;
    if (running) {
      running.depth += 1;
      return running.handle;
    }
    running = new ModifierChanceScope();
    if (eager) drawWorld(running);
    return running.handle;
  }

  /**
   * Close one opening of a scope. When the root closes it, every actor given rolls loses them and is prepared again.
   * @param {object|null} handle The handle `open` returned.
   * @returns {Promise<void>}
   */
  async close(handle) {
    if (!handle || running?.handle !== handle) return;
    running.depth -= 1;
    if (running.depth > 0) return;
    const scope = running;
    running = null;
    scope.release();
  }
}

/**
 * Take the action's rolls off some actors while a preview reads them unrolled, and put them back after the read,
 * even if it fails. Used by the combat exchange snapshot (projections/combat-exchange.mjs).
 * @param {Iterable<Actor>|null} actors The units to read unrolled, or null for every unit the action gave rolls.
 * @param {Function} read The read.
 * @returns {Promise<*>} What the read returns.
 */
export async function withUndrawnModifierChances(actors, read) {
  const taken = [...(actors ?? running?.lentActors() ?? [])]
    .filter(actor => actor && Object.hasOwn(actor, 'modifierChanceRolls'))
    .map(actor => ({ actor, rolls: actor.modifierChanceRolls }));
  for (const { actor } of taken) {
    delete actor.modifierChanceRolls;
    prepareAgain(actor);
  }
  try {
    return await read();
  } finally {
    for (const { actor, rolls } of taken) {
      actor.modifierChanceRolls = rolls;
      prepareAgain(actor);
    }
  }
}

/**
 * The rolls one unit carries through the running action, drawn now if the action has not drawn them yet. Outside an
 * action they are drawn afresh and kept by nothing.
 * @param {Actor} actor A Character Actor.
 * @returns {Readonly<object>} Rolls by modifier key, then node path.
 */
export function actionModifierChances(actor) {
  return running ? running.rollsFor(actor) : drawRolls(actor);
}

/**
 * One percentile for each chance node a host action resolves, drawn on the host that runs the action.
 * @param {ReadonlyArray<object>} requirements The chance nodes to resolve.
 * @returns {number[]} One percentile in [0, 100) per requirement, in order.
 */
export function drawModifierChances(requirements = []) {
  return requirements.map(() => Math.random() * 100);
}

/* -------------------------------------------- */
/*  One action's rolls                          */
/* -------------------------------------------- */

/** One action's rolls: every unit it rolled for, and the actors holding rolls that make a modifier apply. */
class ModifierChanceScope {
  depth = 1;
  #resolved = new Map();
  #lent = new Map();

  /** The handle FoundryModifierChanceScopes.close matches, by identity, to find this scope. */
  constructor() {
    this.handle = Object.freeze({});
  }

  /** A unit's rolls for this action, rolled the first time the action reads it. */
  rollsFor(actor) {
    const uuid = String(actor?.uuid ?? '');
    if (this.#resolved.has(uuid)) return this.#resolved.get(uuid);
    return this.#resolve(actor, requirements => modifierChanceRolls(requirements, drawModifierChances(requirements)));
  }

  /** The actors this action gave rolls to. */
  lentActors() {
    return [...this.#lent.keys()];
  }

  /** Take the rolls back from every actor and prepare each again, so nothing read after the action carries a roll. */
  release() {
    for (const actor of this.#lent.keys()) {
      delete actor.modifierChanceRolls;
      prepareAgain(actor);
    }
    this.#lent.clear();
  }

  /** Roll for a unit once, and give the rolls to the actor when one of them makes a modifier apply. */
  #resolve(actor, rollsOf) {
    const uuid = String(actor?.uuid ?? '');
    if (this.#resolved.has(uuid)) return this.#resolved.get(uuid);
    const requirements = chanceRequirements(actor);
    const rolls = Object.freeze(rollsOf(requirements));
    this.#resolved.set(uuid, rolls);
    if (modifierChancesFire(requirements, rolls)) {
      actor.modifierChanceRolls = rolls;
      this.#lent.set(actor, rolls);
      prepareAgain(actor);
    }
    return rolls;
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Roll for every chance-bearing Character in the world. A unit that can't be read is reported and left unrolled. */
function drawWorld(scope) {
  try {
    for (const actor of worldCharacters()) scope.rollsFor(actor);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'modifier-chance-world');
  }
}

/** Every Character in the world: its Actors, and the unlinked Token Actors each Scene's Tokens carry. */
function worldCharacters() {
  const characters = new Set(collectionValues(globalThis.game?.actors).filter(actor => actor?.type === 'Character'));
  for (const scene of collectionValues(globalThis.game?.scenes)) {
    for (const token of collectionValues(scene?.tokens)) {
      if (token?.actorLink === true) continue;
      if (token?.actor?.type === 'Character') characters.add(token.actor);
    }
  }
  return [...characters];
}

/**
 * The chance nodes a unit's modifiers can read, from the stored modifiers of everything it carries plus a borrowed
 * Armament. Only an Item's id and modifiers decide them, so nothing else is projected: drawWorld asks this of every
 * Character in the world on each gameplay action. A unit whose items can't be read gets none.
 */
function chanceRequirements(actor) {
  try {
    const armament = projectWieldedArmament(actor)?.weapon ?? null;
    const items = armament ? [...actor.items, armament] : [...actor.items];
    return modifierChanceRequirements(items.map(chanceItem));
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'modifier-chance-requirements');
    return [];
  }
}

/** An Item as modifierChanceRequirements reads it: its id and its stored modifiers. */
function chanceItem(item) {
  return { id: item.id, modifiers: (item._source?.system ?? item.system ?? {}).modifiers ?? [] };
}

/** Fresh rolls for a unit that no action keeps. */
function drawRolls(actor) {
  const requirements = chanceRequirements(actor);
  return modifierChanceRolls(requirements, drawModifierChances(requirements));
}

/** Prepare a unit again from its source, reporting rather than throwing when that preparation fails. */
function prepareAgain(actor) {
  try {
    actor.reset?.();
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'modifier-chance-prepare');
  }
}
