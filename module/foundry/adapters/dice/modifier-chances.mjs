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

/** The rolls for the command running on the host, or null. One command runs at a time, and nested ones share it. */
let running = null;

/* -------------------------------------------- */
/*  Per-command rolls                           */
/* -------------------------------------------- */

/**
 * On the host, roll each unit's percent-chance modifiers once per command and keep the results on the actor
 * (`modifierChanceRolls`) until the command ends. A unit is prepared again only when a roll makes one of its
 * modifiers apply. Other clients never see the rolls, but on the host a sheet or HUD drawn during the command shows
 * the rolled stats. engine/effects/modifier-chances.mjs opens and closes one around every command handler.
 */
export class FoundryModifierChanceScopes {
  /**
   * Start the rolls for one host command, or join those of the command already running.
   * @param {{eager?: boolean}} [options] `eager` rolls at once for every Character in the world with chance
   *   modifiers. Otherwise a unit is rolled for only when `actionModifierChances` asks for it.
   * @returns {Promise<Readonly<object>|null>} The handle to pass to `close`, or null on any client but the host.
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
   * Close one `open`. When the outermost one closes, every actor holding rolls loses them and is prepared again.
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
 * Temporarily remove this command's chance rolls so a preview shows stats without them, then put them back, even if
 * the read fails.
 * @param {Iterable<Actor>|null} actors The units to read without rolls, or null for every unit holding them.
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
 * A unit's rolls for the running command, rolled now if the command hasn't rolled for it yet. Outside a command
 * they are rolled fresh and not kept.
 * @param {Actor} actor A Character Actor.
 * @returns {Readonly<object>} Rolls by modifier key, then node path.
 */
export function actionModifierChances(actor) {
  return running ? running.rollsFor(actor) : drawRolls(actor);
}

/**
 * One percentile for each chance condition a host command resolves, rolled on the host.
 * @param {ReadonlyArray<object>} requirements The chance conditions to resolve.
 * @returns {number[]} One percentile in [0, 100) per requirement, in order.
 */
export function drawModifierChances(requirements = []) {
  return requirements.map(() => Math.random() * 100);
}

/* -------------------------------------------- */
/*  One command's rolls                         */
/* -------------------------------------------- */

/** One command's rolls: every unit it rolled for, and the actors holding rolls that make a modifier apply. */
class ModifierChanceScope {
  depth = 1;
  #resolved = new Map();
  #lent = new Map();

  /** The handle FoundryModifierChanceScopes.close matches, by identity, to find this scope. */
  constructor() {
    this.handle = Object.freeze({});
  }

  /** A unit's rolls for this command, rolled the first time the command reads it. */
  rollsFor(actor) {
    const uuid = String(actor?.uuid ?? '');
    if (this.#resolved.has(uuid)) return this.#resolved.get(uuid);
    return this.#resolve(actor, requirements => modifierChanceRolls(requirements, drawModifierChances(requirements)));
  }

  /** The actors this command gave rolls to. */
  lentActors() {
    return [...this.#lent.keys()];
  }

  /** Take the rolls back from every actor and prepare each again, so nothing read after the command carries a roll. */
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
 * The chance conditions a unit's modifiers can read, from the saved modifiers of everything it carries plus a
 * borrowed Armament. Only each Item's id and modifiers are read, since drawWorld runs this for every Character in
 * the world. A unit whose items can't be read gets none.
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

/** Fresh rolls for a unit outside any command. */
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
