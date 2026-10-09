/** @layer foundry/adapters/projections */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { SUMMON_REMAINING_FLAG, SUMMON_TICKS_ON_FLAG, SUMMONED_BY_FLAG } from '../../../contracts/domains/combat.mjs';
import { AREA_FACTIONS, EFFECT_STEP_PRECONDITION_FAILURES as PRECONDITION } from '../../../contracts/dsl/effects.mjs';
import { factionGroup } from '../../../game/character/rules.mjs';
import { resolveMovementOccupancy } from '../../../game/movement/pathfinding.mjs';
import { resolveTargetKind, TARGET_KINDS } from '../../../game/objects/rules.mjs';
import { effectAreaRadius } from '../../../game/targeting/shapes.mjs';
import { rectDistance } from '../../../lib/core/geometry.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { persistedTokenPosition, resolveActor, resolveScene, resolveToken } from '../services/host.mjs';

/* -------------------------------------------- */
/*  Effect targets                              */
/* -------------------------------------------- */

const SPAWN_SOURCE_MISSING = Object.freeze({ ok: false, code: PRECONDITION.SPAWN_SOURCE_MISSING });
const SPAWN_LOCATION_MISSING = Object.freeze({ ok: false, code: PRECONDITION.SPAWN_LOCATION_MISSING });

/**
 * The units an effect step's target names: 'self' (or 'caster'), 'target', an explicit actor or token, or an
 * area. When the run has no target, 'target' and an area centred on it name nobody. Any other string, such as a remove
 * status step's 'scene', names nobody here; that step finds its units in operationReach.
 */
export async function resolveEffectTargets(reference, runtime) {
  if (reference === 'self' || reference === 'caster') return identified(runtime.self);
  if (reference === 'target') return identified(runtime.target);
  if (reference?.actorUuid || reference?.tokenUuid) return identified(reference);
  if (reference?.area) return areaTargets(reference.area, runtime);
  return [];
}

/**
 * The documents one effect step will write, listed before it writes any: the units it targets (every unit on the
 * scene for a remove status step on the whole map), the Guard partners of any unit it moves, and the scenes it
 * changes. The host client locks these actors and scenes before the step runs. Only units count as targets, so a
 * Destructible or scenery the step names is left untouched.
 * @param {object} operation Prepared effect operation.
 * @param {object} runtime Effect runtime.
 * @param {{guardBonds?: object|null}} [options] The Guard bond service, used to find a moved token's partner.
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

/**
 * The actors, tokens and scenes a step kind writes where they differ from its targets' actors. A remove status step
 * on the whole map reaches every unit on the scene but the one its `except` names.
 */
async function operationReach(step, targets, runtime, guardBonds) {
  switch (step.kind) {
    case 'setFaction': return { tokenUuids: targets.map(target => target.tokenUuid) };
    case 'removeEffect': return step.target === 'scene' ? { actorUuids: await sceneUnitActorUuids(step, runtime) } : {};
    case 'moveToken': return tokensReach(await movedTokens(step, targets, runtime, guardBonds));
    case 'guard': {
      const pair = [resolveToken(runtime.self?.tokenUuid), resolveToken(targets[0]?.tokenUuid)];
      return tokensReach(await Promise.all(pair));
    }
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

/**
 * The actors of every unit with a token on the run's scene, less the unit the step's `except` names. When `except`
 * names nobody in this run, nobody is left out.
 */
async function sceneUnitActorUuids(step, runtime) {
  const scene = await resolveScene(runtime.sceneUuid);
  const [spared] = step.except ? await resolveEffectTargets(step.except, runtime) : [];
  return collectionValues(scene?.tokens).map(token => token.actor)
    .filter(actor => isUnit(actor) && actor.uuid !== spared?.actorUuid)
    .map(actor => actor.uuid);
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
    if (isUnit(actor)) units.push(target);
  }
  return units;
}

/** Whether an Actor is a unit (a Character), not a Destructible or scenery. */
function isUnit(actor) {
  return resolveTargetKind({ documentType: actor?.type, objectType: actor?.system?.objectType }) === TARGET_KINDS.UNIT;
}

function distinct(values) {
  return Object.freeze([...new Set(values.map(value => String(value ?? '')).filter(Boolean))]);
}

/* -------------------------------------------- */
/*  Summons                                     */
/* -------------------------------------------- */

/**
 * Build a summon's token data without creating anything, for FoundryEffectRepository.prepareSpawn. Each summon gets
 * a new random token id. The token is flagged with its summoner under `SUMMONED_BY_FLAG`, which is how an ending
 * encounter finds the summons to remove. No Actor is created: the token points at the step's Actor by id, so that
 * Actor must be a world Actor; an unlinked token gets its own copy, deleted with the token. A timed summon also
 * carries its phase countdown. With "replace on recast", it also lists the caster's earlier summons of this Actor
 * (other than those in `placed`) so they can be removed, and every actor their removal writes. A square another
 * token takes is refused as no square to summon onto; the summons a recast replaces don't count, since they are
 * removed before the new one is placed.
 * @param {object} step Prepared spawn step.
 * @param {object} runtime Effect runtime.
 * @param {{reserved?: object|null, randomId: function(): string, guardBonds?: object|null, placed?: Set<string>}}
 *   options A token id and square to reuse (always null today), an id source, the Guard bond service, and the
 *   tokens this command already placed.
 * @returns {Promise<Readonly<object>>} The prepared summon, or `{ok: false, code}`.
 */
export async function prepareEffectSpawn(step, runtime, {
  reserved = null, randomId, guardBonds = null, placed = new Set()
}) {
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
    // The system forces scene padding to 0 and allows only square or gridless scenes (hooks/scene.mjs), so a cell
    // times the grid size is the token's pixel position.
    x: Number(location.x) * grid,
    y: Number(location.y) * grid
  };
  data.flags = summonFlags(data.flags, runtime.self?.actorUuid, await summonTimer(step, runtime));
  const replaced = step.replaceOnRecast === true ? replacedSummons(scene, actor, runtime, guardBonds, placed) : null;
  if (!existing && summonSquareTaken(scene, location, data, new Set(replaced?.tokenUuids ?? []))) {
    return SPAWN_LOCATION_MISSING;
  }
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
    replacedTokenUuids: Object.freeze(replaced?.tokenUuids ?? []),
    replacedActorUuids: distinct(replaced?.actorUuids ?? []),
    data
  });
}

/** A summon's Token flags with its summoner's actor uuid and countdown added to this system's scope, copied. */
function summonFlags(flags, casterUuid, timer) {
  const copied = structuredClone(flags ?? {});
  copied[SYSTEM_ID] = { ...(copied[SYSTEM_ID] ?? {}), [SUMMONED_BY_FLAG]: String(casterUuid ?? ''), ...timer };
  return copied;
}

/** A timed summon's countdown, ticking at the end of the opposing side's phase; none when it lasts the encounter. */
async function summonTimer(step, runtime) {
  const duration = Math.floor(Number(step.duration) || 0);
  if (duration < 1) return {};
  const caster = await resolveActor(runtime.self?.actorUuid);
  const ticksOn = factionGroup(caster?.system?.faction?.role) === 'enemy' ? 'Player' : 'Enemy';
  return { [SUMMON_REMAINING_FLAG]: duration, [SUMMON_TICKS_ON_FLAG]: ticksOn };
}

/**
 * Whether another token stands on the squares a new summon would cover. Tokens movement ignores (a hidden fixture,
 * an open Door, a broken Destructible, a Convoy) don't count, nor do the summons a recast is about to remove.
 */
function summonSquareTaken(scene, location, data, leaving) {
  const footprint = {
    x: Number(location.x),
    y: Number(location.y),
    width: Math.max(1, Math.round(Number(data.width) || 1)),
    height: Math.max(1, Math.round(Number(data.height) || 1))
  };
  return collectionValues(scene.tokens).some(token => !leaving.has(token.uuid)
    && resolveMovementOccupancy(null, occupantFacts(token)).occupiesLanding
    && rectDistance(footprint, tokenGridRect(token)) === 0);
}

/** What the movement rules read to decide whether a token takes its square. */
function occupantFacts(token) {
  const actor = token.actor;
  if (!actor) return null;
  return {
    actorType: actor.type,
    hidden: token.hidden === true,
    objectType: actor.system?.objectType ?? '',
    locked: actor.system?.locked !== false,
    stance: Number(actor.system?.resources?.stn?.value) || 0
  };
}

/** The caster's earlier summons of `actor` on the Scene a recast removes, with the Guard partners each leaves. */
function replacedSummons(scene, actor, runtime, guardBonds, placed) {
  const casterUuid = String(runtime.self?.actorUuid ?? '');
  if (!casterUuid) return null;
  const tokens = collectionValues(scene.tokens).filter(token => token.actorId === actor.id
    && token.getFlag?.(SYSTEM_ID, SUMMONED_BY_FLAG) === casterUuid && !placed.has(token.uuid));
  const partners = tokens.map(token => guardBonds?.bondOf?.(token)).flatMap(bond => [bond?.guarded, bond?.guarder]);
  return { tokenUuids: tokens.map(token => token.uuid), actorUuids: tokensReach([...tokens, ...partners]).actorUuids };
}

/* -------------------------------------------- */
/*  Map geometry                                */
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
 * corner rounded to the nearest square. The combat code rounds the corner down instead (tokenGridRect in
 * combat-context.mjs).
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

/**
 * The units within an area's radius of its centre token. The faction filter is judged from the caster's side, not
 * the centre's, and an unknown filter catches nobody. The centre unit is caught only with `includeCenter`.
 */
async function areaTargets(area, runtime) {
  const scene = await resolveScene(runtime.sceneUuid);
  const centre = (area.center ?? 'self') === 'target' ? runtime.target : runtime.self;
  const origin = await resolveToken(centre?.tokenUuid);
  const filter = area.faction ?? 'all';
  if (!scene || !origin || !AREA_FACTIONS.includes(filter)) return [];
  const caster = await resolveActor(runtime.self?.actorUuid);
  const radius = effectAreaRadius(area.radius ?? 1);
  const originRect = tokenGridRect(origin);
  return collectionValues(scene.tokens).filter(token => {
    if (token.actor?.type !== 'Character') return false;
    if (token.uuid === origin.uuid && area.includeCenter !== true) return false;
    return rectDistance(originRect, tokenGridRect(token)) <= radius
      && areaFactionAllowed(token.actor, caster, filter);
  }).map(token => ({ actorUuid: token.actor.uuid, tokenUuid: token.uuid }));
}

/** Whether a unit passes an area's faction filter, judged from the caster's side. */
function areaFactionAllowed(candidate, caster, filter) {
  if (filter === 'all') return true;
  const candidateSide = factionGroup(candidate.system.faction.role ?? 'Neutral') ?? 'neutral';
  const casterSide = factionGroup(caster?.system?.faction?.role ?? 'Neutral') ?? 'neutral';
  if (filter === 'allies') return candidateSide === casterSide;
  if (filter === 'enemies') return candidateSide !== 'neutral' && candidateSide !== casterSide;
  return candidateSide !== casterSide;
}

function identified(target) { return target?.actorUuid || target?.tokenUuid ? [target] : []; }
