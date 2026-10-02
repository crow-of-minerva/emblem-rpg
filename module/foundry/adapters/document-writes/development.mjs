/** @layer foundry/adapters/document-writes */
import { DEVELOPMENT_SCOPES } from '../../../contracts/domains/development.mjs';
import { RALLY_RECORD_FLAG } from '../../../contracts/domains/progression.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { normalizeRallyRecord } from '../../../game/support/rules.mjs';
import { projectEquipmentEffectIdentity } from './characters.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { resolveActor, resolveScene } from '../services/host.mjs';
import { FoundryDiagnostics } from '../services/diagnostics.mjs';
import { turnUpdate } from '../../../game/combat/phases.mjs';
import { recordDiagnostic } from '../../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Write intent                                */
/* -------------------------------------------- */
/** Marks the restore's writes, so the stance hook (foundry/hooks/actors.mjs) skips stance the restore already set. */
const developmentOptions = () => ({ emblemDevelopmentReset: true });

/** The only Item field a restore or repair writes, and so the only item path recorded for rollback. */
const ITEM_USES_PATH = 'system.uses.current';

/* -------------------------------------------- */
/*  Development repository                      */
/* -------------------------------------------- */

/**
 * Reads and rewrites the Character units a GM restore or repair covers. engine/development.mjs works out each
 * unit's restored values (through game/character/rules.mjs); this class saves them, with undo through the command's
 * operation.
 */
export class FoundryDevelopmentRepository {
  /**
   * The Character units a restore or repair covers, each Actor once, with its resources, faction role, Item uses
   * and effects (id, kind and statuses) as plain data. Units whose role the intent excludes are left out.
   * @param {object} intent A normalized restore or repair intent.
   * @returns {Promise<object|null>} The units, or null when a Scene intent names no live Scene.
   */
  async getSnapshot(intent) {
    const units = new Map();
    const scope = String(intent?.scope ?? '');
    let scopeName = '';
    let sceneUuid = '';
    if (scope === DEVELOPMENT_SCOPES.SCENE) {
      const scene = await resolveScene(String(intent?.sceneUuid ?? ''));
      if (!scene) return null;
      scopeName = scene.name ?? 'Scene';
      sceneUuid = String(scene.uuid ?? '');
      collectSceneUnits(scene, units);
    } else if (scope === DEVELOPMENT_SCOPES.WORLD) {
      scopeName = game.world.title ?? 'World';
      for (const actor of collectionValues(game.actors)) admitUnit(actor, units);
      for (const scene of collectionValues(game.scenes)) collectSceneUnits(scene, units);
    } else {
      scopeName = 'Selection';
      for (const uuid of intent?.actorUuids ?? []) admitUnit(await resolveActor(uuid), units);
    }
    const excluded = new Set((intent?.excludeRoles ?? []).map(String));
    const admitted = [...units.values()].filter(unit => !excluded.has(unit.role));
    return { scope, scopeName, sceneUuid, units: admitted };
  }

  /**
   * What a restore or repair writes to, for CommandDispatcher's locks: every Actor it touches, plus the Scene when
   * the intent names one.
   * @param {object} intent A normalized restore or repair intent.
   * @returns {Promise<string[]>} Resource keys for CommandDispatcher.
   */
  async resourceKeys(intent) {
    const snapshot = await this.getSnapshot(intent);
    const sceneUuid = String(intent?.sceneUuid ?? '');
    const scene = sceneUuid ? [`scene:${sceneUuid}`] : [];
    if (!snapshot) return scene;
    return [...scene, ...snapshot.units.map(unit => `actor:${unit.actorUuid}`)];
  }

  /** Save resources, turn state and Item uses, and remove the listed effects, for every unit resolved. */
  async restoreUnits(resolutions, operation = null) {
    return this.#persist(resolutions, 'restoreUnits', operation, (actor, resolution) => ({
      changes: restoreUpdate(resolution),
      items: presentItems(actor, resolution.items),
      effects: presentEffects(actor, resolution.removeEffectIds)
    }));
  }

  /** Save Item uses only, leaving resources, the turn and every effect as they are. */
  async repairItems(resolutions, operation = null) {
    return this.#persist(resolutions, 'repairItems', operation, (actor, resolution) => ({
      changes: null,
      items: presentItems(actor, resolution.items),
      effects: []
    }));
  }

  /**
   * Look up every unit, save everything about to change on the operation for undo in one call, then write each
   * unit. A failed write throws on to engine/development.mjs, which refuses the command so CommandDispatcher puts
   * every unit back.
   */
  async #persist(resolutions, detail, operation, plan) {
    const units = [];
    for (const resolution of resolutions) {
      const actor = await resolveActor(resolution.actorUuid);
      if (actor?.type !== 'Character') throw new Error('A unit in reach no longer exists.');
      units.push({ actor, ...plan(actor, resolution) });
    }
    await operation?.capture({
      documents: units.flatMap(unit => [
        ...(unit.changes ? [{ document: unit.actor, paths: Object.keys(unit.changes) }] : []),
        ...unit.items.map(item => ({ document: item.document, paths: [ITEM_USES_PATH] }))
      ]),
      deleting: units.flatMap(unit => unit.effects)
    });
    try {
      for (const unit of units) await writeUnit(unit);
    } catch (error) {
      recordDiagnostic(new FoundryDiagnostics(), { sourcePath: import.meta.url, error, detail });
      throw new Error('Development persistence failed.', { cause: error });
    }
    return {
      unitCount: resolutions.length,
      itemCount: units.reduce((count, unit) => count + unit.items.length, 0),
      effectCount: units.reduce((count, unit) => count + unit.effects.length, 0)
    };
  }
}

/* -------------------------------------------- */
/*  Unit discovery                              */
/* -------------------------------------------- */

/** Add every Character placed on a Scene, recording each token against its Actor. */
function collectSceneUnits(scene, units) {
  for (const token of collectionValues(scene?.tokens)) {
    const unit = admitUnit(token?.actor, units);
    if (unit) unit.tokenUuids.push(String(token.uuid ?? ''));
  }
}

/** Add a Character once, keyed by Actor UUID so linked tokens share one resolution. */
function admitUnit(actor, units) {
  if (actor?.type !== 'Character') return null;
  const actorUuid = String(actor.uuid ?? '');
  if (!actorUuid) return null;
  const existing = units.get(actorUuid);
  if (existing) return existing;
  const unit = projectUnit(actor);
  units.set(actorUuid, unit);
  return unit;
}

/* -------------------------------------------- */
/*  Unit data                                   */
/* -------------------------------------------- */
function projectUnit(actor) {
  const special = Object.fromEntries(Object.entries(actor.system?.special ?? {}).map(([key, pool]) => [key, {
    value: Number(pool?.value) || 0,
    max: Number(pool?.max) || 0
  }]));
  return {
    actorUuid: actor.uuid,
    actorName: actor.name ?? 'Character',
    role: String(actor.system?.faction?.role ?? 'Neutral'),
    tokenUuids: [],
    resources: {
      hp: resourceState(actor.system?.resources?.hp, actor.system?.stats?.hpMax?.total),
      stn: resourceState(actor.system?.resources?.stn, actor.system?.stats?.stnMax?.total),
      shields: Number(actor.system?.resources?.shields?.value) || 0
    },
    special,
    items: collectionValues(actor.items).map(projectItemUses),
    effects: collectionValues(actor.effects).map(projectEffectIdentity),
    /** Whether the unit has Rallied anyone this map, so a restore knows to clear its record. */
    rallied: normalizeRallyRecord(actor.flags?.[SYSTEM_ID]?.[RALLY_RECORD_FLAG]).length > 0
  };
}

/** An Item's uses and its Refreshes switch. A restore tops up only refreshing Items, and a repair tops up all. */
function projectItemUses(item) {
  const uses = item?.system?.uses ?? {};
  const maximum = typeof item?.getEffectiveMaxUses === 'function'
    ? item.getEffectiveMaxUses() : Number(uses.max) || 0;
  return {
    id: String(item?.id ?? item?._id ?? ''),
    name: String(item?.name ?? ''),
    refreshes: item?.system?.refreshes === true,
    uses: {
      current: Number(uses.current) || 0,
      max: Math.max(0, Number(maximum) || 0),
      type: String(uses.type ?? '')
    }
  };
}

function projectEffectIdentity(effect) {
  return {
    id: String(effect?.id ?? effect?._id ?? ''),
    kind: projectEquipmentEffectIdentity(effect).kind,
    statuses: [...(effect?.statuses ?? [])].map(String)
  };
}

function resourceState(resource, fallbackMax) {
  return {
    value: Number(resource?.value) || 0,
    max: Math.max(0, Number(resource?.max ?? fallbackMax) || 0)
  };
}

/* -------------------------------------------- */
/*  Persistence                                 */
/* -------------------------------------------- */

/** The Items a restore or repair tops up that the unit still carries. Only these are saved for undo and counted. */
function presentItems(actor, items = []) {
  return items
    .map(item => ({ document: actor.items.get(String(item.id ?? '')), uses: item.uses }))
    .filter(entry => entry.document);
}

/** The effects a restore removes that the unit still carries. */
function presentEffects(actor, effectIds = []) {
  return effectIds.map(id => actor.effects.get(String(id))).filter(Boolean);
}

/** One unit's writes, in order: resources and turn, then Item uses, then effect removal. */
async function writeUnit({ actor, changes, items, effects }) {
  if (changes) await actor.update(changes, developmentOptions());
  if (items.length) {
    await actor.updateEmbeddedDocuments('Item', items.map(item => ({
      _id: item.document.id, [ITEM_USES_PATH]: item.uses
    })), developmentOptions());
  }
  if (effects.length) {
    await actor.deleteEmbeddedDocuments('ActiveEffect', effects.map(effect => effect.id), developmentOptions());
  }
}

function restoreUpdate(resolution) {
  const update = {
    'system.resources.hp.value': resolution.resources.hp,
    'system.resources.stn.value': resolution.resources.stn,
    'system.resources.shields.value': resolution.resources.shields,
    ...turnUpdate(resolution.turn)
  };
  for (const [key, pool] of Object.entries(resolution.special)) {
    update[`system.special.${key}.value`] = pool.value;
  }
  if (resolution.clearRallies) update[`flags.${SYSTEM_ID}.${RALLY_RECORD_FLAG}`] = [];
  return update;
}

