/** @layer foundry/adapters/projections */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { SUMMONED_BY_FLAG } from '../../../contracts/domains/combat.mjs';
import { factionGroup } from '../../../game/character/rules.mjs';
import { resolveTargetKind, TARGET_KINDS } from '../../../game/objects/rules.mjs';
import { rectDistance } from '../../../lib/core/geometry.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { persistedTokenPosition, resolveActor, resolveScene, resolveToken } from '../services/host.mjs';
import { placedActorUuids } from './encounters.mjs';

/* -------------------------------------------- */
/*  Effect targets                              */
/* -------------------------------------------- */

const SPAWN_SOURCE_MISSING = Object.freeze({ ok: false, code: 'effect.spawn-source-missing' });
const SPAWN_LOCATION_MISSING = Object.freeze({ ok: false, code: 'effect.spawn-location-missing' });

/**
 * The units an effect step's target reference names: 'self', 'target', an explicit actor or token, or an area.
 * FoundryEffectRepository.resolveTargets (document-writes/effect-execution.mjs) calls it, and so do the resolvers
 * below.
 */
export async function resolveEffectTargets(reference, runtime) {
  if (reference === 'self') return identified(runtime.self);
  if (reference === 'target') return identified(runtime.target);
  if (reference?.actorUuid || reference?.tokenUuid) return identified(reference);
  if (reference?.area) return areaTargets(reference.area, runtime);
  return [];
}

/**
 * The documents one mechanical effect step will write, named before it writes any: the units it targets, the Guard
 * partners of any unit it moves, and the Scenes it changes. EffectExecutionService (engine/effects/execution.mjs)
 * claims those actors and Scenes before the step runs. Only units are kept as targets, so a Destructible or scenery
 * named by a mechanical step is left untouched.
 * @param {object} operation Prepared effect operation.
 * @param {object} runtime Effect runtime.
 * @param {{guardBonds?: object|null}} [ports] The bond service a moved Token's partner is read from.
 * @returns {Promise<Readonly<{targets: object[], actorUuids: string[], tokenUuids: string[], sceneUuids: string[]}>>}
 */
export async function resolveEffectWrites(operation, runtime, { guardBonds = null } = {}) {
  const step = operation.step;
  const targets = await affectedUnits(await resolveEffectTargets(step.target, runtime));
  const reach = await operationReach(step, targets, runtime, guardBonds);
  return Object.freeze({
    targets: Object.freeze(targets),
    actorUuids: distinct(reach.actorUuids ?? targets.map(target => target.actorUuid)),
    tokenUuids: distinct(reach.tokenUuids ?? []),
    sceneUuids: distinct(reach.sceneUuids ?? [])
  });
}

async function operationReach(step, targets, runtime, guardBonds) {
  switch (step.kind) {
    case 'setFaction': return { tokenUuids: targets.map(target => target.tokenUuid) };
    case 'removeEffect':
      return step.scope === 'global' ? { actorUuids: placedActorUuids(await resolveScene(runtime.sceneUuid)) } : {};
    case 'moveToken': return tokensReach(await movedTokens(step, targets, runtime, guardBonds));
    case 'guard': {
      const pair = [resolveToken(runtime.self?.tokenUuid), resolveToken(targets[0]?.tokenUuid)];
      return tokensReach(await Promise.all(pair));
    }
    case 'despawnToken': return tokensReach(despawnedTokens(await resolveScene(runtime.sceneUuid), step));
    case 'terrainEdit': return { actorUuids: [], sceneUuids: [runtime.sceneUuid] };
    default: return {};
  }
}

/** The Tokens a move displaces, with the Guard partner each may leave behind. */
async function movedTokens(step, targets, runtime, guardBonds) {
  const moving = await resolveToken(targets[0]?.tokenUuid);
  const pair = step.mode === 'swap'
    ? await resolveToken((await resolveEffectTargets(step.pair ?? 'self', runtime))[0]?.tokenUuid)
    : null;
  const moved = [moving, pair].filter(Boolean);
  const partners = moved.map(token => guardBonds?.bondOf?.(token)).flatMap(bond => [bond?.guarded, bond?.guarder]);
  return [...moved, ...partners];
}

/** Every Token on a Scene a despawn step's flag filter selects. */
function despawnedTokens(scene, step) {
  return collectionValues(scene?.tokens)
    .filter(token => token.getFlag?.(SYSTEM_ID, step.filter?.flagPath) === step.filter?.value);
}

function tokensReach(tokens) {
  const placed = tokens.filter(Boolean);
  return { tokenUuids: placed.map(token => token.uuid), actorUuids: placed.map(token => token.actor?.uuid) };
}

/** The targets that are units: a Destructible or scenery named by a mechanical step is left untouched. */
async function affectedUnits(targets) {
  const units = [];
  for (const target of targets) {
    const actor = target.actorUuid
      ? await resolveActor(target.actorUuid)
      : (await resolveToken(target.tokenUuid))?.actor ?? null;
    const kind = resolveTargetKind({ documentType: actor?.type, objectType: actor?.system?.objectType });
    if (kind === TARGET_KINDS.UNIT) units.push(target);
  }
  return units;
}

function distinct(values) {
  return Object.freeze([...new Set(values.map(value => String(value ?? '')).filter(Boolean))]);
}

/* -------------------------------------------- */
/*  Summons                                     */
/* -------------------------------------------- */

/**
 * Build a summon's Token data and identity without creating anything, for FoundryEffectRepository.prepareSpawn. The
 * code can take a reserved id and square and adopt a Token already under that id, but the only caller passes no
 * reservation, so every summon gets a fresh random id. The Token is stamped with its summoner under
 * `SUMMONED_BY_FLAG`, beside whatever flags its prototype and the step's overrides carry, which is how an ending
 * encounter finds the summons to remove. No world Actor is created: the Token shows the step's Actor, or an unlinked
 * copy of it that is deleted with the Token.
 * @param {object} step Prepared spawn step.
 * @param {object} runtime Effect runtime.
 * @param {{reserved?: object|null, randomId: function(): string}} options The recorded reservation and an id source.
 * @returns {Promise<Readonly<object>>} The prepared summon, or `{ok: false, code}`.
 */
export async function prepareEffectSpawn(step, runtime, { reserved = null, randomId }) {
  const actor = await resolveActor(step.actorUuid);
  const scene = await resolveScene(runtime.sceneUuid);
  if (!actor || !scene) return SPAWN_SOURCE_MISSING;
  const grid = Number(scene.grid?.size) || 1;
  const tokenId = String(reserved?.tokenId || randomId());
  const existing = scene.tokens?.get?.(tokenId) ?? null;
  const location = existing
    ? tokenGridPosition(existing, grid)
    : reserved?.location ?? await resolveEffectLocation(step.location ?? runtime.targetLocation, runtime, grid);
  if (!location) return SPAWN_LOCATION_MISSING;
  const source = (await actor.getTokenDocument()).toObject();
  const data = {
    ...source,
    ...step.tokenOverrides,
    _id: tokenId,
    name: step.name || source?.name,
    actorId: actor.id,
    x: Number(location.x) * grid,
    y: Number(location.y) * grid,
    rotation: Number(step.rotation) || 0
  };
  data.flags = summonFlags(data.flags, runtime.self?.actorUuid);
  const tokenUuid = String(existing?.uuid ?? `${scene.uuid}.Token.${tokenId}`);
  const actorUuid = existing?.actor?.uuid ?? (data.actorLink === true ? actor.uuid : `${tokenUuid}.Actor.${actor.id}`);
  return Object.freeze({
    ok: true,
    sceneUuid: String(scene.uuid),
    tokenId,
    tokenUuid,
    actorUuid: String(actorUuid),
    location: Object.freeze({ x: Number(location.x), y: Number(location.y) }),
    existed: Boolean(existing),
    data
  });
}

/** A summon's Token flags with its summoner's actor uuid added to this system's scope, copied rather than shared. */
function summonFlags(flags, casterUuid) {
  const copied = structuredClone(flags ?? {});
  copied[SYSTEM_ID] = { ...(copied[SYSTEM_ID] ?? {}), [SUMMONED_BY_FLAG]: String(casterUuid ?? '') };
  return copied;
}

/* -------------------------------------------- */
/*  Board geometry                              */
/* -------------------------------------------- */

/** A grid square an effect names: explicit coordinates, the aimed location, or a Token reference's own square. */
export async function resolveEffectLocation(location, runtime, gridSize) {
  if (location && Number.isFinite(Number(location.x)) && Number.isFinite(Number(location.y))) {
    return { x: Number(location.x), y: Number(location.y) };
  }
  if (typeof location !== 'string') return null;
  if (location === 'targetLocation' && runtime.targetLocation) return { ...runtime.targetLocation };
  const [reference] = await resolveEffectTargets(location, runtime);
  const token = await resolveToken(reference?.tokenUuid);
  return token ? tokenGridPosition(token, gridSize) : null;
}

/** A token's top-left grid square, rounded to the nearest cell. */
export function tokenGridPosition(token, gridSize) {
  return { x: Math.round((Number(token?.x) || 0) / gridSize), y: Math.round((Number(token?.y) || 0) / gridSize) };
}

/**
 * A token's footprint in grid cells, from its saved position (persistedTokenPosition in services/host.mjs) with the
 * corner rounded to the nearest square. Used for effect areas, geometry anchors in
 * document-writes/effect-execution.mjs and the Guard bond check in document-writes/tokens.mjs. The combat
 * projections round the corner down instead (tokenGridRect in combat-context.mjs).
 */
export function tokenGridRect(token) {
  if (!token) return null;
  const gridSize = Number(token.parent?.grid?.size) || 1;
  const position = persistedTokenPosition(token);
  return {
    ...tokenGridPosition(position, gridSize),
    width: Math.max(1, Math.floor(position.width)),
    height: Math.max(1, Math.floor(position.height)),
    tokenUuid: token.uuid
  };
}

async function areaTargets(area, runtime) {
  const scene = await resolveScene(runtime.sceneUuid);
  const centre = (area.center ?? 'self') === 'target' ? runtime.target : runtime.self;
  const origin = await resolveToken(centre?.tokenUuid);
  if (!scene || !origin) return [];
  const radius = Math.max(0, Math.floor(Number(area.radius ?? 1)) || 0);
  const originRect = tokenGridRect(origin);
  return collectionValues(scene.tokens).filter(token => {
    if (token.uuid === origin.uuid || token.actor?.type !== 'Character') return false;
    return rectDistance(originRect, tokenGridRect(token)) <= radius
      && areaFactionAllowed(token.actor, origin.actor, area.faction);
  }).map(token => ({ actorUuid: token.actor.uuid, tokenUuid: token.uuid }));
}

function areaFactionAllowed(candidate, origin, filter = 'all') {
  if (filter === 'all') return true;
  const candidateSide = factionGroup(candidate.system.faction.role ?? 'Neutral') ?? 'neutral';
  const originSide = factionGroup(origin?.system?.faction?.role ?? 'Neutral') ?? 'neutral';
  if (filter === 'allies') return candidateSide === originSide;
  if (filter === 'enemies') return candidateSide !== 'neutral' && candidateSide !== originSide;
  if (filter === 'enemiesAndNeutrals') return candidateSide !== originSide;
  return true;
}

function identified(target) { return target?.actorUuid || target?.tokenUuid ? [target] : []; }
