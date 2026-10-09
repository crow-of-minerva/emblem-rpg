/** @layer foundry/adapters/document-writes */
import { TOKEN_ROTATION_LOCK_SETTING } from '../../../config/settings.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import {
  GUARD_BOND_BREAKS,
  GUARD_BOND_EFFECT_NAME,
  GUARD_BOND_FLAGS,
  GUARD_BOND_RECORD_FAILED,
  GUARD_BOND_ROLES
} from '../../../contracts/domains/combat.mjs';
import { EFFECT_STEP_PRECONDITION_FAILURES } from '../../../contracts/dsl/effects.mjs';
import { GUARD_BOND_EFFECT_DATA } from '../../../config/statuses.mjs';
import { guardBondHolds } from '../../../game/effects/planning.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import {
  displaceToken,
  forcedDeletion,
  isActiveGm as isDrivingGM,
  persistedTokenPosition,
  resolveActor as resolveActorDocument,
  resolveToken
} from '../services/host.mjs';
import { RESTORE_WRITE_OPTION } from '../../../contracts/domains/recovery.mjs';
import { TOKEN_BASE_MAGNIFICATION, legacyTokenPath } from '../../../contracts/domains/tokens.mjs';
import { objectSpriteOffset, objectTokenAppearance } from '../../../game/objects/rules.mjs';
import {
  activeTokenOffsetY, selectActiveTokenArt, selectTransientTokenArt
} from '../../../game/character/token-art.mjs';
import { isVisuallyDestroyed, projectObjectArtFacts } from './objects.mjs';
import { guardBondPartnerToken } from '../projections/tokens.mjs';
import { isAirborneActor } from '../projections/combat-context.mjs';
import { tokenGridPosition, tokenGridRect } from '../projections/effect-targets.mjs';
import { reportFoundryError, reportFoundryProbe } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Setting translation                         */
/* -------------------------------------------- */
/** The prototype sight a new Character is created with, in grid units. The Actor Control Panel changes it. */
const DEFAULT_UNIT_SIGHT_RANGE = 5;

/** Whether the world setting locks Token rotation. A setting that can't be read counts as locked. */
function isTokenRotationLocked() {
  try {
    return game.settings.get(SYSTEM_ID, TOKEN_ROTATION_LOCK_SETTING) !== false;
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'isTokenRotationLocked', globalThis.game?.ready !== true && /is not a registered game setting$/.test(String(diagnosticError?.message ?? '')));
    return true;
  }
}

/* -------------------------------------------- */
/*  Creation locks                              */
/* -------------------------------------------- */
/** preCreateActor handler: lock rotation on a new prototype token while the world setting is on. */
export function onPreCreateActorTokenRotation(actor) {
  if (!isTokenRotationLocked() || actor?.prototypeToken?.lockRotation) return;
  actor.updateSource?.({ 'prototypeToken.lockRotation': true });
}

/** preCreateToken handler: lock a new token's rotation while the world setting is on, unless its prototype is unlocked. */
export function onPreCreateTokenRotation(tokenDocument) {
  if (!isTokenRotationLocked() || tokenDocument?.lockRotation) return;
  if (tokenDocument?.actor?.prototypeToken?.lockRotation === false) return;
  tokenDocument.updateSource?.({ lockRotation: true });
}

/* -------------------------------------------- */
/*  Unit sight                                  */
/* -------------------------------------------- */
/**
 * preCreateActor handler: give a new Character working sight, which Foundry otherwise creates switched off. The
 * Actor Control Panel's sight fields edit the same prototype afterwards. An Actor whose creation data already
 * carries prototype sight (an import, a duplicate or a paste) keeps it. Only Characters are seeded, and
 * planObjectPrototypeWrites keeps every fixture blind.
 * @param {Actor} actor The Actor being created.
 * @param {object} data The creation data Foundry was handed.
 */
export function onPreCreateActorSight(actor, data) {
  if (!isCharacter(actor) || foundry.utils.hasProperty(data ?? {}, 'prototypeToken.sight')) return;
  actor.updateSource?.({
    'prototypeToken.sight.enabled': true,
    'prototypeToken.sight.range': DEFAULT_UNIT_SIGHT_RANGE
  });
}

/* -------------------------------------------- */
/*  Character size invariant                    */
/* -------------------------------------------- */
/** Whether a Character token footprint is one of the two the art and the range maths are drawn for. */
function isValidCharacterTokenSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  return (w === 1 && h === 1) || (w === 2 && h === 2);
}

/**
 * preUpdateActor and preUpdateToken handlers that refuse any Character footprint other than 1x1 or 2x2, on the
 * prototype and on a placed token.
 * @param {{tokenSizeInvalid: () => void}} notify The presentation surface the refusal is announced through.
 */
export function createCharacterTokenSizeGuards(notify) {
  const refuse = (width, height) => {
    if (isValidCharacterTokenSize(width, height)) return undefined;
    notify.tokenSizeInvalid();
    return false;
  };
  return Object.freeze({
    onPreUpdateActorSize(actor, update) {
      if (!isCharacter(actor)) return undefined;
      const width = getPath(update, 'prototypeToken.width');
      const height = getPath(update, 'prototypeToken.height');
      if (width === undefined && height === undefined) return undefined;
      return refuse(width ?? actor.prototypeToken?.width, height ?? actor.prototypeToken?.height);
    },
    onPreUpdateTokenSize(tokenDocument, update) {
      if (!isCharacter(tokenDocument?.actor)) return undefined;
      if (update?.width === undefined && update?.height === undefined) return undefined;
      return refuse(update.width ?? tokenDocument.width, update.height ?? tokenDocument.height);
    }
  });
}

/* -------------------------------------------- */
/*  World enforcement                           */
/* -------------------------------------------- */
/** Re-lock every placed token in the supplied scenes from the active GM client. */
async function enforceTokenRotationLock(scenes) {
  if (!isDrivingGM() || !isTokenRotationLocked()) return;
  for (const scene of collectionValues(scenes)) {
    const updates = collectionValues(scene.tokens)
      .filter(token => !token.lockRotation)
      .map(token => ({ _id: token.id, lockRotation: true }));
    if (updates.length > 0) await scene.updateEmbeddedDocuments('Token', updates);
  }
}

/** updateSetting handler: when the world rotation lock is turned on, lock every placed Token in every Scene. */
export function onUpdateTokenRotationSetting(setting) {
  if (setting?.key !== `${SYSTEM_ID}.${TOKEN_ROTATION_LOCK_SETTING}`) return;
  void enforceTokenRotationLock(game.scenes);
}

/**
 * At ready, the active GM turns off sight on every Object in the world, prototype and placed Token alike. The
 * placement and edit rules keep a new Object blind, and this sweep catches ones imported or made before those rules.
 */
export async function enforceObjectTokenSight() {
  if (!isDrivingGM()) return false;
  let corrected = 0;
  try {
    for (const actor of collectionValues(game.actors)) {
      if (actor?.type !== 'Object' || actor.isToken || actor.prototypeToken?.sight?.enabled !== true) continue;
      await actor.update({ 'prototypeToken.sight.enabled': false });
      corrected += 1;
    }
    for (const scene of collectionValues(game.scenes)) {
      const updates = collectionValues(scene.tokens)
        .filter(token => token.actor?.type === 'Object' && token.sight?.enabled === true)
        .map(token => ({ _id: token.id, 'sight.enabled': false }));
      if (updates.length > 0) await scene.updateEmbeddedDocuments('Token', updates);
      corrected += updates.length;
    }
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'enforceObjectTokenSight');
    return false;
  }
  return corrected > 0;
}

/**
 * createToken handler: fill a newly placed unlinked unit or Object to full HP and stance, and reset its rotation.
 * Linked Tokens, effect spawns and Tokens re-created by undo are skipped, since they already carry their health.
 * It waits one tick (setTimeout 0) for creation to finish, then refills HP and Stance only if they haven't changed
 * since, so it can't overwrite damage taken meanwhile. Rotation is reset only if it hasn't changed either.
 * @param {TokenDocument} tokenDocument The Token just created.
 * @param {object} [options] The creation options the `createToken` hook received.
 */
export async function fillPlacedToken(tokenDocument, options = {}) {
  if (options?.[RESTORE_WRITE_OPTION] === true || options?.emblemEffectSettlement === true) return false;
  if (!isDrivingGM() || tokenDocument?.actorLink) return false;
  const actor = tokenDocument?.actor;
  if (!['Character', 'Object'].includes(String(actor?.type ?? ''))) return false;
  const placed = { hp: actor.system?.resources?.hp?.value, stn: actor.system?.resources?.stn?.value,
    rotation: tokenDocument._source?.rotation };
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!isDrivingGM() || tokenDocument.parent?.tokens?.has?.(tokenDocument.id) === false) return false;
  try {
    const resources = actor.system?.resources ?? {};
    const maxHp = Number(resources.hp?.max) || 0;
    const maxStance = Number(resources.stn?.max) || 0;
    const changes = {};
    if (resources.hp?.value === placed.hp && placed.hp !== maxHp) changes['system.resources.hp.value'] = maxHp;
    if (resources.stn?.value === placed.stn && placed.stn !== maxStance) changes['system.resources.stn.value'] = maxStance;
    if (Object.keys(changes).length) await actor.update(changes);
    if (tokenDocument._source?.rotation === placed.rotation) await tokenDocument.update({ rotation: 0 });
    return true;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'fillPlacedToken');
    return false;
  }
}

/* -------------------------------------------- */
/*  Fixture placement                           */
/* -------------------------------------------- */

/** Where a fixture draws: under every unit, whatever a Token config was saved with. */
const FIXTURE_TOKEN_SORT = -1000;

const FIXTURE_TYPES = Object.freeze(['Object', 'Vendor', 'Convoy']);

/**
 * Set a fixture Token's art, scale and layering before it is placed.
 *
 * Elevation is flattened, since the system has its own elevation model rather than the core field. An Object
 * arrives showing the art state it is actually in. A Vendor arrives at the base magnification with whatever
 * mirroring it already had. A Convoy is always linked and shows the Actor's own portrait. Called from the
 * preCreateToken handler in foundry/hooks/objects.mjs.
 * @param {TokenDocument} tokenDocument The Token about to be created.
 * @returns {boolean} Whether the Token was a fixture and was settled.
 */
export function settleFixtureTokenOnPlacement(tokenDocument) {
  const actor = tokenDocument?.actor;
  if (!FIXTURE_TYPES.includes(String(actor?.type ?? ''))) return false;
  if (tokenDocument.elevation) tokenDocument.updateSource({ elevation: 0 });
  const writes = { sort: FIXTURE_TOKEN_SORT, lockRotation: true };
  if (actor.type === 'Object') {
    writes['sight.enabled'] = false;
    const appearance = objectTokenAppearance(projectObjectArtFacts(actor));
    if (appearance.src) writes['texture.src'] = appearance.src;
    if (appearance.scale !== null) {
      writes['texture.scaleX'] = appearance.scale;
      writes['texture.scaleY'] = appearance.scale;
    }
    if (appearance.tint !== null) writes['texture.tint'] = appearance.tint;
  }
  if (actor.type === 'Vendor') {
    const sign = (Number(tokenDocument.texture?.scaleX) || 1) < 0 ? -1 : 1;
    writes['texture.scaleX'] = sign * TOKEN_BASE_MAGNIFICATION;
    writes['texture.scaleY'] = TOKEN_BASE_MAGNIFICATION;
  }
  if (actor.type === 'Convoy') {
    writes.actorLink = true;
    if (actor.img) writes['texture.src'] = actor.img;
  }
  tokenDocument.updateSource(writes);
  return true;
}

/**
 * Hold a fixture to its rules on every later edit: its sort is forced back rather than refused, an Object never
 * gets sight, and a Convoy stays linked. Called from the preUpdateToken handler in foundry/hooks/objects.mjs.
 * @param {TokenDocument} tokenDocument The Token being updated.
 * @param {object} update The pending update, edited in place.
 * @returns {boolean} Whether the Token was a fixture.
 */
export function enforceFixtureTokenRules(tokenDocument, update) {
  const actor = tokenDocument?.actor;
  if (!FIXTURE_TYPES.includes(String(actor?.type ?? ''))) return false;
  if (update.sort !== undefined && update.sort !== FIXTURE_TOKEN_SORT) update.sort = FIXTURE_TOKEN_SORT;
  if (actor.type === 'Object' && fixtureSightRequested(update)) {
    if (Object.hasOwn(update, 'sight.enabled')) update['sight.enabled'] = false;
    else setPath(update, 'sight.enabled', false);
  }
  if (actor.type === 'Convoy' && update.actorLink === false) update.actorLink = true;
  return true;
}

/* -------------------------------------------- */
/*  Fixture rendering                           */
/* -------------------------------------------- */

/** A Destructible draws at tile depth, under every unit, because it is scenery that happens to have health. */
const DESTRUCTIBLE_SORT_LAYER = 500;
const TOKEN_SORT_LAYER = 700;

/**
 * drawToken and refreshToken handler: set an Object Token's draw depth and sprite offset. The core position is
 * tracked separately so offsets don't pile up across refreshes.
 * @param {Token} token The Token being refreshed.
 * @returns {boolean} Whether it was an Object Token.
 */
export function onRefreshFixtureToken(token) {
  const actor = token?.actor;
  if (actor?.type !== 'Object' || !token.mesh || token.mesh.destroyed) return false;
  const wanted = actor.system?.objectType === 'Destructible' ? DESTRUCTIBLE_SORT_LAYER : TOKEN_SORT_LAYER;
  if (token.mesh.sortLayer !== wanted) {
    token.mesh.sortLayer = wanted;
    if (globalThis.canvas?.primary) canvas.primary.sortDirty = true;
  }
  applyFixtureMeshOffset(token, actor);
  return true;
}

function applyFixtureMeshOffset(token, actor) {
  const mesh = token.mesh;
  const offset = objectSpriteOffset({
    ...projectObjectArtFacts(actor),
    destroyed: isVisuallyDestroyed(token)
  });
  const state = FIXTURE_MESH_STATE.get(token) ?? {};
  if (mesh.position.x !== state.lastX) state.naturalX = mesh.position.x;
  if (mesh.position.y !== state.lastY) state.naturalY = mesh.position.y;
  const x = (Number.isFinite(state.naturalX) ? state.naturalX : mesh.position.x) + offset.x;
  const y = (Number.isFinite(state.naturalY) ? state.naturalY : mesh.position.y) + offset.y;
  if (mesh.position.x !== x) mesh.position.x = x;
  if (mesh.position.y !== y) mesh.position.y = y;
  state.lastX = x;
  state.lastY = y;
  FIXTURE_MESH_STATE.set(token, state);
}

const FIXTURE_MESH_STATE = new WeakMap();

/** A pre-update diff spells a nested field either way, so both spellings are read before sight is refused. */
function fixtureSightRequested(update) {
  return update?.['sight.enabled'] === true || update?.sight?.enabled === true;
}

/* -------------------------------------------- */
/*  Guard bonds                                 */
/* -------------------------------------------- */
const bondOptions = () => ({ animate: false, emblemEffectSettlement: true });

/**
 * Forms, keeps and breaks Guard bonds: the Token flags a bond is recorded in, and the status both units wear.
 */
export class FoundryGuardBondRepository {
  constructor({ notify = null } = {}) {
    this.notify = notify;
  }

  /** The bond a Token stands in from either side, a guarder whose charge has gone, or null. */
  bondOf(token) {
    if (!token?.parent) return null;
    const partner = guardBondPartnerToken(token);
    if (token.getFlag(SYSTEM_ID, GUARD_BOND_FLAGS.GUARDER)) return { guarded: token, guarder: partner };
    if (partner) return { guarded: partner, guarder: token };
    return guardBondEffects(token.actor).length ? { guarded: null, guarder: token } : null;
  }

  /**
   * One half of a Guard pair as resolveGuardBond and planGuardBond in game/effects/planning.mjs read it: the square
   * its move landed on, rounded to the nearest one, its size and flight, and whether it already stands in a bond.
   */
  sideOf(token) {
    if (!token) return { tokenUuid: '', name: '', flying: false, width: 1, height: 1, bonded: false };
    const gridSize = token.parent.grid.size;
    const position = persistedTokenPosition(token);
    return {
      ...tokenGridPosition(position, gridSize),
      tokenUuid: String(token.uuid ?? ''),
      actorUuid: String(token.actor?.uuid ?? ''),
      name: String(token.actor?.name ?? ''),
      flying: token.actor?.system?.unitType?.flying === true,
      width: position.width,
      height: position.height,
      sort: Number(token.sort) || 0,
      bonded: this.bondOf(token) !== null
    };
  }

  /**
   * Form the bond a plan describes. Both Tokens and the two bond effects are recorded in the caller's undo record
   * before the first write, so a refused command leaves neither unit bonded nor moved.
   * @param {object} plan The plan from game/effects/planning.mjs.
   * @param {{operation?: object|null}} [context] The running command's undo record, if any.
   */
  async establish(plan, { operation = null } = {}) {
    const guarder = await resolveToken(plan.guarderTokenUuid);
    const guarded = await resolveToken(plan.guardedTokenUuid);
    if (!guarder?.actor || !guarded?.actor) {
      return Object.freeze({ ok: false, code: EFFECT_STEP_PRECONDITION_FAILURES.GUARD_TARGET_MISSING });
    }
    const halves = [];
    for (const half of plan.effects) {
      const actor = await resolveActorDocument(half.actorUuid);
      if (actor) halves.push({ actor, data: { ...guardBondEffectData(half), _id: documentId() } });
    }
    await operation?.capture({
      documents: [guarder, guarded],
      creating: halves.map(half => ({ parent: half.actor, documentName: 'ActiveEffect', ids: [half.data._id] }))
    });
    const gridSize = guarded.parent.grid.size;
    // displaceToken moves with the 'displace' action; Foundry v14 ignores the `teleport` option.
    if (!await displaceToken(guarder, plan.destination, gridSize, { ...bondOptions(), teleport: true })) {
      return Object.freeze({ ok: false, code: 'effect.move-refused' });
    }
    await guarded.update(guardBondWrite(plan, guarder), bondOptions());
    for (const half of halves) {
      const created = await half.actor.createEmbeddedDocuments('ActiveEffect', [half.data],
        { ...bondOptions(), keepId: true }) ?? [];
      if (!created.length) return Object.freeze({ ok: false, code: GUARD_BOND_RECORD_FAILED });
    }
    return Object.freeze({ ok: true });
  }

  /** Break every bond a moved Token no longer stands in. A guarder whose charge has gone is released too. */
  async recheck(tokenUuids, { operation = null } = {}) {
    const broken = [];
    const seen = new Set();
    for (const tokenUuid of tokenUuids) {
      const token = await resolveToken(tokenUuid);
      const bond = this.bondOf(token);
      const key = String(bond?.guarded?.uuid ?? bond?.guarder?.uuid ?? '');
      if (!bond || seen.has(key)) continue;
      seen.add(key);
      if (bond.guarded && bond.guarder && guardBondHolds({
        guarder: tokenGridRect(bond.guarder), guarded: tokenGridRect(bond.guarded)
      })) continue;
      const reason = bond.guarded && bond.guarder ? GUARD_BOND_BREAKS.LEFT : GUARD_BOND_BREAKS.PARTNER_MISSING;
      broken.push(await this.#break(bond, reason, token.actor?.name, operation));
    }
    return Object.freeze(broken);
  }

  /**
   * Break the bond a Token stands in because it fell, left the map or its encounter ended, recording both bond
   * effects in the caller's undo record.
   */
  async breakFor(tokenUuid, reason, { operation = null } = {}) {
    const token = await resolveToken(tokenUuid);
    const bond = this.bondOf(token);
    if (!bond) return null;
    return this.#break(bond, reason, token.actor?.name, operation);
  }

  /**
   * What breaking one Token's bond would change, so a caller can record it for undo together with its own writes,
   * such as the Tokens it removes.
   * @returns {{documents: Array<object>, deleting: Array<object>}} Arguments for `operation.capture`, empty when
   *   nothing is bonded.
   */
  breakCaptures(token) {
    const bond = this.bondOf(token);
    return bond ? bondCaptures(bond) : { documents: [], deleting: [] };
  }

  async #break(bond, reason, actorName, operation = null) {
    const guarded = bond.guarded;
    const halves = [guarded?.actor, bond.guarder?.actor]
      .map(actor => ({ actor, effects: guardBondEffects(actor) })).filter(half => half.effects.length);
    await operation?.capture(bondCaptures(bond));
    for (const half of halves) {
      await half.actor.deleteEmbeddedDocuments('ActiveEffect',
        half.effects.map(effect => String(effect.id)), bondOptions());
    }
    if (guarded) {
      const originalSort = guarded.getFlag(SYSTEM_ID, GUARD_BOND_FLAGS.ORIGINAL_SORT);
      if (typeof originalSort === 'number') await guarded.update({ sort: originalSort }, bondOptions());
      for (const flag of [GUARD_BOND_FLAGS.GUARDER, GUARD_BOND_FLAGS.ORIGINAL_SORT]) {
        await guarded.update(forcedDeletion(`flags.${SYSTEM_ID}.${flag}`), {});
      }
    }
    const broken = Object.freeze({ reason, actorName: String(actorName ?? '') });
    if (reason !== GUARD_BOND_BREAKS.ENCOUNTER_ENDED) this.notify?.guardBondBroken?.(broken);
    return broken;
  }
}

function documentId() {
  return foundry.utils.randomID();
}

/** The one guarded-Token write a bond makes: its draw order, and the two flags the bond is recorded in. */
function guardBondWrite(plan, guarder) {
  return {
    sort: plan.guardedSort,
    [`flags.${SYSTEM_ID}.${GUARD_BOND_FLAGS.GUARDER}`]: guarder.uuid,
    [`flags.${SYSTEM_ID}.${GUARD_BOND_FLAGS.ORIGINAL_SORT}`]: plan.originalSort
  };
}

function guardBondEffects(actor) {
  return collectionValues(actor?.effects).filter(effect => (
    effect?.name === GUARD_BOND_EFFECT_NAME && Boolean(effect?.flags?.[SYSTEM_ID]?.guardRole)
  ));
}

/** What breaking one bond changes, for undo: the guarded Token, whose flags and sort change, and both statuses. */
function bondCaptures(bond) {
  return {
    documents: bond.guarded ? [bond.guarded] : [],
    deleting: [bond.guarded?.actor, bond.guarder?.actor].flatMap(actor => guardBondEffects(actor))
  };
}

function guardBondEffectData(half) {
  const guarder = half.role === GUARD_BOND_ROLES.GUARDER;
  return {
    ...GUARD_BOND_EFFECT_DATA,
    statuses: [...GUARD_BOND_EFFECT_DATA.statuses],
    description: guarder
      ? `Guarding ${half.partnerName}`
      : `Guarded by ${half.partnerName}, and hostile actions are redirected to them`,
    flags: {
      core: { ...GUARD_BOND_EFFECT_DATA.flags.core },
      [SYSTEM_ID]: {
        beneficial: true,
        guardRole: half.role,
        partnerUuid: half.partnerActorUuid,
        partnerName: half.partnerName
      }
    }
  };
}

/* -------------------------------------------- */
/*  Update path helpers                         */
/* -------------------------------------------- */

function getPath(object, path) {
  return foundry.utils.getProperty(object, path);
}

function setPath(object, path, value) {
  foundry.utils.setProperty(object, path, value);
}

/* -------------------------------------------- */
/*  Token art state                             */
/* -------------------------------------------- */
const TOKEN_ART_TRANSITION_METHODS = Object.freeze([
  'clearTransient', 'timing', 'beginTransient', 'waitForTransient', 'transient',
  'settleWrite', 'enqueueWrite', 'desiredWrite', 'scheduleRefresh'
]);

/**
 * Placeholder that throws a clear error if token art is used before init/system.mjs calls configureFoundryTokenArt.
 */
function unconfiguredTokenArtPort(name, methods) {
  return Object.freeze(Object.fromEntries(methods.map(method => [method, () => {
    throw new Error(`foundry/adapters/document-writes/tokens.mjs: ${name}.${method} was used before `
      + 'init/system.mjs called configureFoundryTokenArt.');
  }])));
}

let transitions = unconfiguredTokenArtPort('transitions', TOKEN_ART_TRANSITION_METHODS);
const ART_PATHS = Object.freeze([
  'system.art.legacyToken',
  'system.art.tokens.default',
  'system.art.tokenScales',
  'system.art.tokenOffsetsY',
  'system.art.tabs',
  'system.statuses.grounded',
  'system.unitType'
]);

/**
 * Install the object that times and queues token art changes, built in init/system.mjs. The art itself is chosen
 * by game/character/token-art.mjs.
 */
export function configureFoundryTokenArt(configuration = {}) {
  transitions = configuration.transitions ?? unconfiguredTokenArtPort('transitions', TOKEN_ART_TRANSITION_METHODS);
}

/* -------------------------------------------- */
/*  Actor art data                              */
/* -------------------------------------------- */

/** Read a live Character into the plain data game/character/token-art.mjs selects its art from. */
function projectTokenArtFacts(actor, usedItem = null) {
  const art = actor?.system?.art ?? {};
  const tokens = art.tokens ?? {};
  const items = Array.from(actor?.items ?? []);
  const className = items.find(item => item?.type === 'Class')?.name ?? '';
  return {
    className,
    unitType: foundry.utils.deepClone(actor?.system?.unitType ?? {}),
    airborne: isAirborneActor(actor),
    mounted: actor?.system?.statuses?.mounted === true,
    paths: { default: String(tokens.default ?? '') },
    scales: foundry.utils.deepClone(art.tokenScales ?? {}),
    offsets: foundry.utils.deepClone(art.tokenOffsetsY ?? {}),
    tabs: foundry.utils.deepClone(art.tabs ?? []),
    items: items.map(projectFoundryTokenArtItem),
    activeItem: projectFoundryTokenArtItem(usedItem ?? actor?.activeItem)
  };
}

/**
 * Read only what activeTokenOffsetY needs, without cloning, for the per-frame mesh refresh. The art objects are
 * passed through live and must only be read.
 */
function projectTokenOffsetFacts(actor) {
  const art = actor?.system?.art ?? {};
  let className = '';
  for (const item of actor?.items ?? []) {
    if (item?.type === 'Class') {
      className = item.name ?? '';
      break;
    }
  }
  return {
    className,
    unitType: actor?.system?.unitType ?? {},
    airborne: isAirborneActor(actor),
    mounted: actor?.system?.statuses?.mounted === true,
    offsets: art.tokenOffsetsY ?? {},
    tabs: art.tabs ?? []
  };
}

/** Resolve an Actor UUID and refresh its persistent token art. */
export async function refreshActorTokenArt(actorUuid, options = {}) {
  const actor = await resolveActor(actorUuid);
  return actor ? applyActorTokenArt(actor, options) : false;
}

/** Resolve an Actor UUID and apply one transient condition. */
export async function fireActorTokenCondition(actorUuid, conditionName, options = {}) {
  const actor = await resolveActor(actorUuid);
  return actor ? fireConditionalTokenEvent(actor, conditionName, options) : false;
}

/** Resolve an Actor UUID and revert its transient condition. */
export async function revertActorTokenCondition(actorUuid, options = {}) {
  const actor = await resolveActor(actorUuid);
  return actor ? revertConditionalTokenEvent(actor, options) : false;
}

/** Resolve an Actor UUID and put back any token still showing temporary art instead of its current art. */
export async function ensureActorTokenArtBaseline(actorUuid) {
  const actor = await resolveActor(actorUuid);
  return actor ? ensureActorTokenBaseline(actor) : false;
}

/* -------------------------------------------- */
/*  Token art application                       */
/* -------------------------------------------- */
/**
 * preCreateToken handler: give a new Character token the art game/character/token-art.mjs selects, at 2x scale. A
 * Legacy Token is left as Foundry copies it from the prototype.
 */
export function onPreCreateTokenArt(tokenDocument) {
  const actor = tokenDocument?.actor;
  if (!isCharacter(actor) || legacyTokenOf(actor)) return;
  const active = selectActiveTokenArt(projectTokenArtFacts(actor));
  if (!active.path) return;
  const sign = Number(tokenDocument.texture?.scaleX) < 0 ? -1 : 1;
  const magnification = active.scale * TOKEN_BASE_MAGNIFICATION;
  tokenDocument.updateSource?.({
    'texture.src': active.path,
    'texture.scaleX': sign * magnification,
    'texture.scaleY': magnification
  });
}

/**
 * Recompute every placed token and the prototype after an authored art or state change, or put on the Legacy Token
 * the Character names. When the Legacy Token is cleared the Emblem art comes back, unless the Character has no
 * Emblem token art, which leaves the texture as it is.
 */
async function applyActorTokenArt(actor, { force = false, fadeMs = 180 } = {}) {
  if (!isCharacter(actor)) return;
  const legacy = legacyTokenOf(actor);
  if (legacy) return applyLegacyTokenArt(actor, legacy);
  const active = selectActiveTokenArt(projectTokenArtFacts(actor));
  if (!active.path) return;
  for (const token of artTokenDocuments(actor)) {
    await writeTokenTexture(token, active.path, active.scale, { force, fadeMs });
  }
  refreshActiveTokenSurfaces(actor);
  if (actor.isToken || actor.canUserModify(game.user, 'update') === false || !active.baselinePath) return;
  const prototype = actor.prototypeToken?.texture ?? {};
  const magnification = active.baselineScale * TOKEN_BASE_MAGNIFICATION;
  const currentPath = stripQuery(prototype.src);
  const epsilon = 1e-6;
  if (!force && currentPath === stripQuery(active.baselinePath)
    && Math.abs(Math.abs(Number(prototype.scaleX) || 0) - magnification) < epsilon
    && Math.abs(Math.abs(Number(prototype.scaleY) || 0) - magnification) < epsilon) return;
  await actor.update({
    'prototypeToken.texture.src': active.baselinePath,
    'prototypeToken.texture.scaleX': magnification,
    'prototypeToken.texture.scaleY': magnification
  }, { diff: false });
}

/**
 * Put a Legacy Token on every placed token and on the prototype at scale 1, keeping a mirrored token mirrored. A
 * texture already showing the file is not written, so the GM's later edits to its scale, anchor or fit are kept.
 */
async function applyLegacyTokenArt(actor, path) {
  const expected = stripQuery(path);
  // Drop any held art swap: its revert would put the Emblem art back over the legacy file.
  transitions.clearTransient(actor.uuid ?? actor.id);
  for (const token of artTokenDocuments(actor)) {
    if (token.canUserModify(game.user, 'update') === false) continue;
    // Let a queued art write land first, so it can't cover the legacy file afterwards.
    await transitions.settleWrite(token.uuid ?? token.id);
    const texture = token._source?.texture ?? token.texture ?? {};
    if (stripQuery(texture.src) === expected) continue;
    const sign = Number(texture.scaleX) < 0 ? -1 : 1;
    await token.update({ texture: { src: path, scaleX: sign, scaleY: 1 } });
  }
  // Refresh the drawn tokens so the Emblem art's Y offset comes off.
  refreshActiveTokenSurfaces(actor);
  if (actor.isToken || actor.canUserModify(game.user, 'update') === false) return;
  if (stripQuery(actor.prototypeToken?.texture?.src) === expected) return;
  await actor.update({
    'prototypeToken.texture.src': path,
    'prototypeToken.texture.scaleX': 1,
    'prototypeToken.texture.scaleY': 1
  });
}

/** updateActor handler: refresh a Character's token art when its art, grounded status or unit type changes. */
export function onUpdateActorTokenArt(actor, changes) {
  if (!isDrivingGM()) return;
  if (!isCharacter(actor) || !ART_PATHS.some(path => hasPath(changes, path))) return;
  void applyActorTokenArt(actor).catch(error => {
    reportFoundryError(import.meta.url, error, 'Emblem RPG | Character token refresh failed');
  });
}

/** Item create, update and delete handler: pick the token art again when the class, armor or wielded item changes. */
export function onEmbeddedItemTokenArt(item, changes = null) {
  const actor = item?.parent;
  if (!isDrivingGM() || !isCharacter(actor)) return;
  const classChanged = item.type === 'Class' && (!changes || hasPath(changes, 'name'));
  const armorChanged = item.system?.itemType === 'Armor' && (!changes || hasPath(changes, 'system.isWorn'));
  const wieldedType = ['Weapon', 'Staff', 'Attack'].includes(item.system?.itemType) || item.type === 'Spell';
  const wieldChanged = wieldedType && (!changes || hasPath(changes, 'system.isWielded'));
  if (classChanged || armorChanged || wieldChanged) scheduleActorTokenArt(actor);
}

/** ActiveEffect create and delete handler: pick the token art again when a Mounted effect appears or goes. */
export function onMountEffectTokenArt(effect) {
  if (!isDrivingGM() || !isCharacter(effect?.parent) || !isMountEffect(effect)) return;
  scheduleActorTokenArt(effect.parent);
}

/** canvasReady handler: bring every Character token on the drawn Scene back to its current art. */
export function onCanvasReadyTokenArt() {
  if (!isDrivingGM()) return;
  const actors = new Set((globalThis.canvas?.tokens?.placeables ?? []).map(token => token.actor).filter(isCharacter));
  for (const actor of actors) void applyActorTokenArt(actor);
}

/**
 * drawToken and refreshToken handler: move the mesh by the authored Y offset and by any footstep or dodge offset,
 * exactly once per mesh refresh. A Legacy Token has no authored offset.
 */
export function onRefreshTokenArt(token) {
  if (!isCharacter(token?.actor) || !token?.mesh || !globalThis.canvas?.grid) return;
  const lift = legacyTokenOf(token.actor)
    ? 0 : activeTokenOffsetY(projectTokenOffsetFacts(token.actor)) * canvas.grid.size;
  const adjustment = (Number(token._emblemTransientY) || 0) - lift;
  if (token.mesh.position.y !== token._emblemVLastWritten) token._emblemVNaturalY = token.mesh.position.y;
  const natural = Number.isFinite(token._emblemVNaturalY) ? token._emblemVNaturalY : token.mesh.position.y;
  const desired = natural + adjustment;
  if (token.mesh.position.y !== desired) token.mesh.position.y = desired;
  token._emblemVLastWritten = desired;
}

/* -------------------------------------------- */
/*  Transient conditional art                   */
/* -------------------------------------------- */
/**
 * Find all placed Tokens for Actor art writes, whichever Scene the host client is showing.
 * A transient change with an explicit Token UUID affects only that placement.
 * @param {Actor} actor The Character whose art changes.
 * @param {string} [tokenUuid] The one Token a transient swap belongs to.
 * @returns {TokenDocument[]}
 */
function artTokenDocuments(actor, tokenUuid = '') {
  const tokens = (actor?.getDependentTokens({ concreteOnly: true }) ?? [])
    .filter(token => token?.documentName === 'Token');
  const named = tokenUuid ? tokens.filter(token => token.uuid === tokenUuid) : [];
  return named.length ? named : tokens;
}

/**
 * Apply a conditional token-art event and optionally hold it until revertConditionalTokenEvent. A Legacy Token never
 * swaps.
 */
async function fireConditionalTokenEvent(actor, conditionName, options = {}) {
  if (legacyTokenOf(actor)) return false;
  const selection = selectTransientTokenArt(projectTokenArtFacts(actor, options.usedItem), conditionName, {
    ...options,
    usedItem: projectFoundryTokenArtItem(options.usedItem ?? actor?.activeItem)
  });
  const tokens = artTokenDocuments(actor, String(options.tokenUuid ?? ''));
  if (!selection || !tokens.length) return false;
  const key = actor.uuid ?? actor.id;
  transitions.clearTransient(key);
  const snapshots = new Map(tokens.map(token => [token.uuid ?? token.id, {
    path: readTokenTextureState(token).src,
    scale: Math.abs(Number(readTokenTextureState(token).scaleX) || TOKEN_BASE_MAGNIFICATION)
      / TOKEN_BASE_MAGNIFICATION
  }]));
  const timing = transitions.timing(selection.condition, options);
  try {
    for (const token of tokens) {
      await writeTokenTexture(token, selection.path, selection.scale,
        { force: false, fadeMs: timing.swapFadeMs });
    }
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'fireConditionalTokenEvent');
    return false;
  } finally {
    transitions.beginTransient(key, {
      snapshots,
      timing,
      manualRevert: options.manualRevert === true,
      revert: lock => restoreActorTokenArt(actor, lock)
    });
  }
  return true;
}

/** Release a manually held conditional texture. */
async function revertConditionalTokenEvent(actor, options = {}) {
  const key = actor?.uuid ?? actor?.id;
  const lock = transitions.clearTransient(key);
  if (lock && Number.isFinite(options.fadeMs)) lock.revertFadeMs = options.fadeMs;
  await restoreActorTokenArt(actor, lock);
}

/**
 * Wait for queued combat art swaps to finish, then put any token not on its current art back on it. A Legacy Token
 * is left alone.
 */
async function ensureActorTokenBaseline(actor) {
  if (!actor || legacyTokenOf(actor)) return false;
  const key = actor.uuid ?? actor.id;
  await transitions.waitForTransient(key);
  if (transitions.transient(key)) await revertConditionalTokenEvent(actor);
  const tokens = artTokenDocuments(actor);
  await Promise.all(tokens.map(token => transitions.settleWrite(token.uuid ?? token.id)));
  const active = selectActiveTokenArt(projectTokenArtFacts(actor));
  if (!active.path) return false;
  const expected = stripQuery(active.path);
  const stuck = tokens.filter(token => stripQuery(token._source?.texture?.src ?? token.texture?.src) !== expected
    && token.canUserModify(game.user, 'update') !== false);
  for (const token of stuck) {
    await writeTokenTexture(token, active.path, active.scale, { force: true, fadeMs: 280 });
  }
  return stuck.length > 0;
}

/**
 * End a held art swap: put each token on its current art, or back on the art it showed before the swap when the
 * Character has none. A Legacy Token is left alone.
 */
async function restoreActorTokenArt(actor, lock) {
  if (legacyTokenOf(actor)) return;
  const active = selectActiveTokenArt(projectTokenArtFacts(actor));
  for (const token of artTokenDocuments(actor)) {
    const snapshot = lock?.snapshots?.get(token.uuid ?? token.id);
    const path = active.path || snapshot?.path;
    const scale = active.path ? active.scale : snapshot?.scale;
    if (path) await writeTokenTexture(token, path, scale, { fadeMs: lock?.revertFadeMs ?? 300 });
  }
}

/* -------------------------------------------- */
/*  Combat facing                               */
/* -------------------------------------------- */
/** How long a Token takes to turn, for a saved turn and for the local turn shown while aiming. */
export const FACING_FLIP_MS = 180;
const FACING_MINIMUM_MAGNITUDE = 0.95;

/**
 * Turn two Character tokens to face each other and save it: the host client does so when an exchange or activation
 * starts, and for a training session, and the Enemy AI through api tokenArt.faceTargets. Aiming saves nothing (see
 * turnFoundryAimFacing in projections/attack-targeting.mjs).
 */
export async function faceTokensTowardEachOther(sourceTokenUuid, targetTokenUuid) {
  const sourceUuid = String(sourceTokenUuid ?? '');
  const targetUuid = String(targetTokenUuid ?? '');
  if (!sourceUuid || !targetUuid || sourceUuid === targetUuid) return false;
  const [source, target] = await Promise.all([resolveToken(sourceUuid), resolveToken(targetUuid)]);
  if (!source || !target) return false;
  const turned = await Promise.all([writeTokenFacing(source, target), writeTokenFacing(target, source)]);
  return turned.some(Boolean);
}

async function writeTokenFacing(tokenDocument, otherDocument) {
  if (!isCharacter(tokenDocument.actor)) return false;
  if (tokenDocument.canUserModify(game.user, 'update') === false) return false;
  const current = readTokenTextureState(tokenDocument);
  const scaleX = facingScaleToward(tokenDocument, otherDocument);
  if (scaleX === null || Math.abs(Number(current.scaleX) - scaleX) < 1e-6) return false;
  const key = tokenDocument.uuid ?? tokenDocument.id;
  await transitions.enqueueWrite(key, { ...current, scaleX }, async () => {
    if (tokenDocument.parent && !tokenDocument.parent.tokens.get(tokenDocument.id)) return;
    await tokenDocument.update({ 'texture.scaleX': scaleX }, { animation: { duration: FACING_FLIP_MS } });
  });
  return true;
}

/**
 * The signed X scale that turns a Token toward another from the facing it is saved at, or that a queued art write is
 * about to save, or null when it does not turn: only a Character turns, never one that names a Legacy Token, and
 * never while its texture is scaled below FACING_MINIMUM_MAGNITUDE. writeTokenFacing writes it, and
 * turnFoundryAimFacing in projections/attack-targeting.mjs shows it on the aiming client alone.
 */
export function facingScaleToward(tokenDocument, otherDocument) {
  if (!isCharacter(tokenDocument.actor) || legacyTokenOf(tokenDocument.actor)) return null;
  const current = readTokenTextureState(tokenDocument);
  const magnitude = Math.abs(Number(current.scaleY)) || Math.abs(Number(current.scaleX)) || 1;
  if (magnitude < FACING_MINIMUM_MAGNITUDE) return null;
  return tokenCenterX(otherDocument) > tokenCenterX(tokenDocument) ? -magnitude : magnitude;
}

/** The signed X scale a Token's facing is saved at, or that a queued art write is about to save. */
export function savedFacingScale(tokenDocument) {
  return Number(readTokenTextureState(tokenDocument).scaleX) || 1;
}

/**
 * The horizontal pixel centre of a Token where its move landed (persistedTokenPosition), which decides the way
 * facingScaleToward turns it.
 */
function tokenCenterX(tokenDocument) {
  const gridSize = Math.max(1, Number(tokenDocument?.parent?.grid?.size ?? 100));
  const position = persistedTokenPosition(tokenDocument);
  return position.x + (Math.max(1, position.width) * gridSize / 2);
}

/* -------------------------------------------- */
/*  Texture writes                              */
/* -------------------------------------------- */
/**
 * Queue an art write for one Token. Its facing is read from the saved texture when the write runs, so a facing
 * change made in between is kept.
 */
async function writeTokenTexture(tokenDocument, path, scale, { force = false, fadeMs = 180 } = {}) {
  if (!tokenDocument || !path || tokenDocument.canUserModify(game.user, 'update') === false) return;
  const key = tokenDocument.uuid ?? tokenDocument.id;
  const current = readTokenTextureState(tokenDocument);
  const desiredPath = stripQuery(path);
  const sign = Number(current.scaleX) < 0 ? -1 : 1;
  const magnification = Math.abs(Number(scale) || 1) * TOKEN_BASE_MAGNIFICATION;
  const scaleX = sign * magnification;
  const scaleY = magnification;
  const epsilon = 1e-6;
  if (!force && current.src === desiredPath
    && Math.abs(Number(current.scaleX) - scaleX) < epsilon
    && Math.abs(Number(current.scaleY) - scaleY) < epsilon) return;
  const sourceChanged = force || current.src !== desiredPath;
  const desired = { src: desiredPath, scaleX, scaleY };
  return transitions.enqueueWrite(key, desired, async () => {
    if (tokenDocument.parent && !tokenDocument.parent.tokens.get(tokenDocument.id)) return;
    const persisted = tokenDocument._source?.texture ?? tokenDocument.texture ?? {};
    const facedScaleX = (Number(persisted.scaleX) < 0 ? -1 : 1) * magnification;
    if (!sourceChanged && Math.abs(Number(persisted.scaleX) - facedScaleX) < epsilon
      && Math.abs(Number(persisted.scaleY) - scaleY) < epsilon) return;
    // A new source gets a timestamp query so Foundry sees a changed src and plays the fade, even on a forced
    // refresh of the same path. `diff: false` sends the update even when nothing differs from the saved data.
    const source = sourceChanged ? `${desiredPath}?${Date.now()}` : tokenDocument.texture.src;
    const options = sourceChanged ? { diff: false, animation: { duration: fadeMs } } : { diff: false, animate: false };
    await tokenDocument.update({ texture: { src: source, scaleX: facedScaleX, scaleY } }, options);
  });
}

function readTokenTextureState(tokenDocument) {
  const key = tokenDocument?.uuid ?? tokenDocument?.id;
  // Animation frames change scaleX on the live document, so the saved source is the reliable value to read.
  const texture = tokenDocument?._source?.texture ?? tokenDocument?.texture ?? {};
  return transitions.desiredWrite(key) ?? {
    src: stripQuery(texture.src),
    scaleX: texture.scaleX ?? 1,
    scaleY: texture.scaleY ?? 1
  };
}

function scheduleActorTokenArt(actor) {
  const key = actor.uuid ?? actor.id;
  transitions.scheduleRefresh(key, () => applyActorTokenArt(actor));
}

function refreshActiveTokenSurfaces(actor) {
  for (const token of actor?.getActiveTokens() ?? []) {
    token?.renderFlags.set({ refresh: true, refreshShape: true });
    token?.drawEffects();
    onRefreshTokenArt(token);
  }
}

/* -------------------------------------------- */
/*  Token art helpers                           */
/* -------------------------------------------- */

function isCharacter(actor) {
  return actor?.documentName === 'Actor' && actor.type === 'Character';
}

/**
 * The Legacy Token file a Character names, or '' when it names none. While it names one, Foundry draws its tokens:
 * no art swaps, 2x scale, Y offset or facing flips.
 */
function legacyTokenOf(actor) {
  return isCharacter(actor) ? legacyTokenPath(actor.system?.art) : '';
}

function isMountEffect(effect) {
  return effect?.flags?.[SYSTEM_ID]?.isMountEffect === true
    || effect?.statuses?.has?.('Mounted')
    || String(effect?.name ?? '').startsWith('Mounted: ');
}

/** Read a live or detached Item into the plain data game/character/token-art.mjs reads. */
export function projectFoundryTokenArtItem(item) {
  if (!item || typeof item !== 'object') return null;
  const system = item.system ?? {};
  return Object.freeze({
    id: String(item.id ?? ''),
    uuid: String(item.uuid ?? ''),
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    itemType: String(item.itemType ?? system.itemType ?? item.subtype ?? ''),
    isWielded: item.isWielded === true || system.isWielded === true,
    weaponRequirement: String(item.weaponRequirement ?? system.weapon?.req ?? ''),
    compendiumSource: String(item.compendiumSource ?? item._stats?.compendiumSource ?? '')
  });
}

function hasPath(object, path) {
  if (Object.hasOwn(object ?? {}, path)) return true;
  return foundry.utils.hasProperty(object, path);
}

function stripQuery(path) {
  return String(path ?? '').split('?')[0];
}

async function resolveActor(actorUuid) {
  const actor = await resolveActorDocument(actorUuid);
  return isCharacter(actor) ? actor : null;
}
