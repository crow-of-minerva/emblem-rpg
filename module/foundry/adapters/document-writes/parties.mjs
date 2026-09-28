/** @layer foundry/adapters/document-writes */
import { ACTOR_TYPES } from '../../../config/constants.mjs';
import { CAMPAIGN_PARTIES_SETTING } from '../../../config/settings.mjs';
import { SYSTEM_ID , recordDiagnostic } from '../../../contracts/protocol.mjs';
import { collectionValues, structurallyEqual } from '../../../lib/core/runtime.mjs';
import { normalizePartyState, projectOwnershipLevel, readPartyState } from '../projections/parties.mjs';
import { RESULT_CODES } from '../../../contracts/results.mjs';
import { forcedReplacement, resolveSync } from '../services/host.mjs';
import { reportFoundryError , FoundryDiagnostics } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Party state                                 */
/* -------------------------------------------- */
const PARTY_ACCESS_FLAG = 'partyObserverGrants';
const CONVOY_ACCESS_FLAG = 'convoyAccess';

/** The persisted paths a party change writes. */
const PARTY_ACCESS_PATH = `flags.${SYSTEM_ID}.${PARTY_ACCESS_FLAG}`;
const CONVOY_ACCESS_PATH = `flags.${SYSTEM_ID}.${CONVOY_ACCESS_FLAG}`;
const UNIT_TYPE_PATH = 'system.faction.role';
const ownershipPath = userId => `ownership.${userId}`;

/**
 * The Convoy access record's version. On a Convoy without a record at this version, the first sync clears every
 * player's ownership entry before granting access, since it can't tell its own grants from manual ones.
 */
const CONVOY_ACCESS_VERSION = 1;

/* -------------------------------------------- */
/*  Foundry party repository                    */
/* -------------------------------------------- */
/**
 * Saves the campaign party setting and the Foundry ownership it implies. PartyService (engine/authoring.mjs) calls
 * it for the GM's party tools, and the player-character hooks in foundry/hooks/actors.mjs keep Lords and party
 * access in step. None of this runs inside a command operation, so a failed write is not rolled back.
 */
export class FoundryPartyRepository {
  /** The campaign party state from its world setting. */
  readState() {
    return readPartyState();
  }

  /** What the party tools show: the party state, each player with the units they own, and the world's Convoys. */
  snapshot() {
    const players = this.players().map(user => Object.freeze({
      id: user.id,
      name: user.name,
      color: user.color?.css ?? user.color ?? '#888'
    }));
    const unitsByUser = Object.fromEntries(players.map(user => [user.id, this.ownedUnitsFor(user.id)]));
    const convoys = collectionValues(game.actors).filter(isConvoy).map(actor => Object.freeze({
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img || defaultActorImage()
    }));
    return Object.freeze({
      state: Object.freeze(this.readState()),
      players: Object.freeze(players),
      unitsByUser: Object.freeze(unitsByUser),
      convoys: Object.freeze(convoys)
    });
  }

  /** Plain facts about an Actor a party request names, or null if the UUID isn't an Actor. */
  async actorCandidate(uuid) {
    const actor = await this.resolveActor(uuid);
    if (!actor) return null;
    return Object.freeze({
      uuid: actor.uuid,
      documentName: actor.documentName,
      type: actor.type,
      name: actor.name,
      img: actor.img || defaultActorImage(),
      actorType: String(actor.system?.faction?.role ?? ''),
      imported: !actor.pack
    });
  }

  /** Rewrite the campaign party setting, then every ownership it derives. */
  async reconcileState(state) {
    const normalized = normalizePartyState(state);
    try {
      await game.settings.set(SYSTEM_ID, CAMPAIGN_PARTIES_SETTING, normalized);
      await this.syncConvoyOwnership(normalized);
      await this.syncPartyAccess(normalized);
      return Object.freeze({ ok: true, state: normalized });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/parties.mjs', error: diagnosticError, detail: 'reconcileState'
      });
      return Object.freeze({ ok: false, code: RESULT_CODES.PARTY_STATE_UPDATE_FAILED, diagnostic });
    }
  }

  /** Make a player Owner of a world Actor, then refresh party-mate access. */
  async grantOwnership(userId, actorUuid) {
    const actor = await this.resolveActor(actorUuid);
    if (!actor) return Object.freeze({ ok: false, code: RESULT_CODES.PARTY_ACTOR_UUID_INVALID });
    if (actor.pack) return Object.freeze({ ok: false, code: 'party.actor-import-required' });
    try {
      await this.updateOwnership(actor, { [userId]: ownerLevel() });
      await this.syncPartyAccess(this.readState());
      return Object.freeze({ ok: true, actorName: actor.name });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/parties.mjs', error: diagnosticError, detail: 'grantOwnership'
      });
      return Object.freeze({ ok: false, code: 'party.ownership-grant-failed', diagnostic });
    }
  }

  /**
   * Give a player a Character as their Lord or a Retainer: make them Owner (taking it from `fromUserId` when the
   * unit moves between players), set the unit type the role needs (a different type needs `changeType`), record a
   * Lord in the party setting and as the player's Character, then refresh party-mate access.
   */
  async assignUnit({ userId, actorUuid, role, fromUserId = '', changeType = false }) {
    const actor = await this.resolveActor(actorUuid);
    if (!isCharacter(actor)) return Object.freeze({ ok: false, code: 'party.character-required' });
    if (actor.pack) return Object.freeze({ ok: false, code: 'party.actor-import-required' });
    const requiredType = role === 'lord' ? 'Lord' : 'Retainer';
    const previousType = String(actor.system?.faction?.role ?? '');
    if (previousType !== requiredType && !changeType) {
      return Object.freeze({ ok: false, code: 'party.unit-type-confirmation-required', data: {
        actorName: actor.name, actorType: previousType || 'Neutral', requiredType
      } });
    }
    const ownership = { [userId]: ownerLevel() };
    if (fromUserId && fromUserId !== userId) ownership[fromUserId] = noneLevel();
    try {
      // Ownership goes first. Party administration runs outside any operation, so a later failure isn't rolled
      // back. The next assignment repairs ownership, but it wouldn't repair a half-changed unit type.
      await this.updateOwnership(actor, ownership);
      if (previousType !== requiredType) await this.updateUnitType(actor, requiredType);
      const state = this.readState();
      if (role === 'lord') state.lords[userId] = actor.uuid;
      else if (state.lords[userId] === actor.uuid) delete state.lords[userId];
      if (fromUserId && fromUserId !== userId && state.lords[fromUserId] === actor.uuid) {
        delete state.lords[fromUserId];
      }
      await game.settings.set(SYSTEM_ID, CAMPAIGN_PARTIES_SETTING, normalizePartyState(state));
      if (role === 'lord') await this.syncPlayerCharacter(userId, actor);
      await this.syncPartyAccess(this.readState());
      return Object.freeze({ ok: true, actorName: actor.name, requiredType });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/parties.mjs', error: diagnosticError, detail: 'assignUnit'
      });
      return Object.freeze({ ok: false, code: 'party.unit-assignment-failed', diagnostic });
    }
  }

  /** Take a unit away from a player, drop it as their Lord, then refresh party-mate access. */
  async removeUnit(userId, actorUuid) {
    const actor = await this.resolveActor(actorUuid);
    if (!actor) return Object.freeze({ ok: false, code: RESULT_CODES.PARTY_ACTOR_UUID_INVALID });
    try {
      await this.updateOwnership(actor, { [userId]: noneLevel() });
      const state = normalizePartyState(this.readState());
      if (state.lords[userId] === actor.uuid) delete state.lords[userId];
      await game.settings.set(SYSTEM_ID, CAMPAIGN_PARTIES_SETTING, state);
      await this.syncPartyAccess(state);
      return Object.freeze({ ok: true, actorName: actor.name });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'removeUnit');
      return Object.freeze({ ok: false, code: 'party.ownership-revoke-failed' });
    }
  }

  /**
   * Give party members Observer on their party's Convoy, so they can view it and move items through commands. A
   * Convoy's ownership and its record of the grants this sync made are written together, only when either changes.
   * @param {PartyState} [state]
   */
  async syncConvoyOwnership(state = this.readState()) {
    const playerIds = this.players().map(user => String(user.id));
    if (!playerIds.length) return;
    const members = convoyMembers(state, playerIds);
    const levels = { none: noneLevel(), observer: observerLevel() };
    const settlements = [];
    for (const actor of collectionValues(game.actors)) {
      if (!isConvoy(actor)) continue;
      const plan = planConvoyAccess({
        ownership: actor.ownership,
        record: actor.flags?.[SYSTEM_ID]?.[CONVOY_ACCESS_FLAG] ?? null,
        playerIds,
        memberIds: [...(members.get(actor.uuid) ?? [])],
        levels
      });
      const changes = convoyAccessChanges(plan, actor.ownership);
      if (Object.keys(changes).length) settlements.push({ actor, changes });
    }
    await settleAccessWrites(settlements);
  }

  /**
   * Give party-mates at least Observer on each other's units. Each raise is recorded on the unit, so it can be
   * undone when the players no longer share a party.
   */
  async syncPartyAccess(state = this.readState()) {
    const players = this.players();
    if (!players.length) return;
    const partyIds = new Set(state.parties.map(party => party.id));
    const partyOf = new Map();
    for (const user of players) {
      if (partyIds.has(state.membership[user.id])) partyOf.set(user.id, state.membership[user.id]);
    }
    const settlements = partyAccessCarriers()
      .map(unit => planPartyAccess(unit, players, partyOf))
      .filter(Boolean);
    await settleAccessWrites(settlements);
  }

  /** Every user who isn't a GM. */
  players() {
    return collectionValues(game.users).filter(user => !user.isGM);
  }

  /**
   * Return world Characters and unlinked token Actors owned by one player.
   * @param {string} userId
   * @returns {object[]}
   */
  ownedUnitsFor(userId) {
    const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    const units = [];
    for (const actor of collectionValues(game.actors)) {
      if (!isCharacter(actor) || projectOwnershipLevel(actor.ownership, userId) < owner) continue;
      units.push(unitView(actor, { isToken: false, scene: '' }));
    }
    for (const scene of collectionValues(game.scenes)) {
      for (const token of collectionValues(scene.tokens)) {
        if (token.actorLink) continue;
        const ownership = token.delta?._source?.ownership;
        if (projectOwnershipLevel(ownership, userId) < owner) continue;
        const actor = token.actor;
        units.push({
          uuid: actor?.uuid ?? `${token.uuid}.Actor.${token.actorId}`,
          name: token.name || actor?.name || 'Token',
          img: token.texture?.src || actor?.img || defaultActorImage(),
          isToken: true,
          scene: scene.name ?? ''
        });
      }
    }
    return units.sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * The Convoy Actor a UUID names, or null. Synchronous, for FoundryTradeRepository and the economy projection
   * (projections/economy.mjs).
   */
  resolveConvoy(uuid) {
    const actor = resolveSync(uuid);
    return isConvoy(actor) ? actor : null;
  }

  /** Resolve an Actor, Token, or ActorDelta UUID to its Actor. */
  async resolveActor(uuid) {
    if (!uuid) return null;
    let document = null;
    try { document = await resolveUuid(uuid); } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'resolveActor');
      return null;
    }
    if (!document) return null;
    if (document.documentName === 'Actor') return document;
    if (document.documentName === 'Token') return document.actor ?? null;
    if (document.documentName === 'ActorDelta') {
      return document.syntheticActor ?? document.parent?.actor ?? null;
    }
    return null;
  }

  /** Set ownership levels on an Actor, keyed by user id. */
  async updateOwnership(actor, ownership) {
    const changes = Object.fromEntries(
      Object.entries(ownership).map(([userId, level]) => [ownershipPath(userId), level])
    );
    await actor.update(changes);
  }

  /** Set an Actor's unit type, 'Lord' or 'Retainer'. */
  async updateUnitType(actor, actorType) {
    await actor.update({ [UNIT_TYPE_PATH]: actorType });
  }

  /** Restore the Owner grant a recorded Lord needs to stay inside its player's party. */
  async restoreLordOwnership(userId, actor) {
    const user = game.users.get(userId);
    if (!user || user.isGM || !isCharacter(actor) || actor.pack) return false;
    if (projectOwnershipLevel(actor.ownership, userId) >= ownerLevel()) return false;
    await this.updateOwnership(actor, { [userId]: ownerLevel() });
    return true;
  }

  /** Mirror a world-Actor Lord into Foundry's Player Character field. */
  async syncPlayerCharacter(userId, actor) {
    const user = game.users.get(userId);
    if (!user || user.isGM || !isCharacter(actor)) return false;
    if (game.actors.get(actor.id) !== actor) return false;
    const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    if (projectOwnershipLevel(actor.ownership, userId) < owner) return false;
    const currentId = user.character?.id ?? user._source?.character ?? null;
    if (currentId === actor.id) return false;
    await user.update({ character: actor.id });
    return true;
  }
}

/* -------------------------------------------- */
/*  Foundry helpers                             */
/* -------------------------------------------- */

function isCharacter(actor) {
  return actor?.documentName === 'Actor' && actor.type === ACTOR_TYPES.CHARACTER;
}

function isConvoy(actor) {
  return actor?.documentName === 'Actor' && actor.type === ACTOR_TYPES.CONVOY;
}

function unitView(actor, { isToken, scene }) {
  return Object.freeze({
    uuid: actor.uuid,
    name: actor.name,
    img: actor.img || defaultActorImage(),
    isToken,
    scene
  });
}

function defaultActorImage() {
  return CONST.DEFAULT_TOKEN;
}


function resolveUuid(uuid) {
  return fromUuid(uuid);
}

function ownerLevel() {
  return CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
}

function noneLevel() {
  return CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
}

function observerLevel() {
  return CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
}

/* -------------------------------------------- */
/*  Party-mate access                           */
/* -------------------------------------------- */

/** Every Character, world Actor or unlinked token, with its own ownership and recorded party grants. */
function partyAccessCarriers() {
  const carriers = [];
  for (const actor of collectionValues(game.actors)) {
    if (!isCharacter(actor)) continue;
    carriers.push({ actor, ownership: actor.ownership, grants: actor.flags?.[SYSTEM_ID]?.[PARTY_ACCESS_FLAG] });
  }
  for (const scene of collectionValues(game.scenes)) {
    for (const token of collectionValues(scene.tokens)) {
      if (token.actorLink || !isCharacter(token.actor)) continue;
      const source = token.delta?._source;
      carriers.push({ actor: token.actor, ownership: source?.ownership, grants: source?.flags?.[SYSTEM_ID]?.[PARTY_ACCESS_FLAG] });
    }
  }
  return carriers;
}

/**
 * Plan party-mate access on one unit for syncPartyAccess: the ownership raises and restorations to write, and the
 * grant record to keep. null when nothing changes.
 */
function planPartyAccess({ actor, ownership, grants }, players, partyOf) {
  const observer = observerLevel();
  const owners = new Set(players
    .filter(user => projectOwnershipLevel(ownership, user.id) >= ownerLevel())
    .map(user => user.id));
  const parties = new Set([...owners].map(id => partyOf.get(id)).filter(Boolean));
  const wanted = new Set(players
    .filter(user => !owners.has(user.id) && parties.has(partyOf.get(user.id)))
    .map(user => user.id));
  const recorded = recordedGrants(grants);
  const kept = [];
  const changes = {};
  const raise = userId => {
    changes[`ownership.${userId}`] = observer;
  };
  for (const grant of recorded) {
    const current = projectOwnershipLevel(actor.ownership, grant.user);
    if (wanted.has(grant.user)) {
      if (current > observer) continue;
      if (current < observer) raise(grant.user);
      kept.push(grant);
    } else if (current === observer) {
      changes[`ownership.${grant.user}`] = grant.level;
    }
  }
  const tracked = new Set(recorded.map(grant => grant.user));
  for (const userId of wanted) {
    if (tracked.has(userId)) continue;
    const current = projectOwnershipLevel(actor.ownership, userId);
    if (current >= observer) continue;
    raise(userId);
    kept.push({ user: userId, level: current });
  }
  const grantsChanged = JSON.stringify(kept) !== JSON.stringify(recorded);
  if (!Object.keys(changes).length && !grantsChanged) return null;
  const clearGrants = !kept.length && recorded.length > 0;
  if (kept.length) changes[PARTY_ACCESS_PATH] = kept;
  return { actor, changes, clearGrants };
}

/** Write each unit's ownership changes and grant record. */
async function settleAccessWrites(settlements) {
  for (const { actor, changes, clearGrants } of settlements) {
    if (Object.keys(changes).length) await actor.update(changes);
    if (clearGrants) await actor.unsetFlag(SYSTEM_ID, PARTY_ACCESS_FLAG);
  }
}

function recordedGrants(grants) {
  if (!Array.isArray(grants)) return [];
  return grants
    .filter(grant => grant?.user)
    .map(grant => ({ user: String(grant.user), level: Number(grant.level) || 0 }));
}

/* -------------------------------------------- */
/*  Convoy access                               */
/* -------------------------------------------- */

/**
 * Plan party-based Observer access for one Convoy. Each grant records the player's previous level, so leaving the
 * party restores only what this sync granted, and a GM's later manual change is kept. A Convoy without a current
 * record first has every player's entry cleared (see CONVOY_ACCESS_VERSION).
 * @param {object} input
 * @param {Record<string, number>} input.ownership The Convoy's stored ownership.
 * @param {object|null} input.record Its stored access record.
 * @param {string[]} input.playerIds Every user who is not staff.
 * @param {string[]} input.memberIds The users whose party links this Convoy.
 * @param {{none: number, observer: number}} input.levels Foundry's ownership levels.
 * @returns {{set: Record<string, number>, remove: string[], record: object, recordChanged: boolean}}
 */
function planConvoyAccess({ ownership = {}, record = null, playerIds = [], memberIds = [], levels }) {
  const migrated = record?.version === CONVOY_ACCESS_VERSION;
  const recorded = migrated ? recordedConvoyGrants(record.grants) : [];
  const entries = { ...(ownership ?? {}) };
  const set = {};
  const remove = migrated ? [] : playerIds.filter(userId => Object.hasOwn(entries, userId));
  for (const userId of remove) delete entries[userId];
  const assign = (userId, level) => {
    set[userId] = level;
    if (remove.includes(userId)) remove.splice(remove.indexOf(userId), 1);
  };
  const members = new Set(memberIds);
  const grants = [];
  for (const userId of playerIds) {
    const current = Number(entries[userId] ?? entries.default ?? levels.none) || 0;
    const grant = recorded.find(entry => entry.user === userId);
    if (members.has(userId)) {
      if (grant && current > levels.observer) continue;
      if (current < levels.observer) assign(userId, levels.observer);
      if (grant || current < levels.observer) {
        grants.push(grant ?? { user: userId, level: Object.hasOwn(entries, userId) ? current : null });
      }
    } else if (grant && current === levels.observer) {
      if (grant.level === null) remove.push(userId);
      else assign(userId, grant.level);
    }
  }
  return {
    set,
    remove,
    record: { version: CONVOY_ACCESS_VERSION, grants },
    recordChanged: !migrated || !structurallyEqual(recorded, grants)
  };
}

/** The non-staff users whose party links each Convoy, keyed by the Convoy's uuid. */
function convoyMembers(state, playerIds) {
  const members = new Map();
  for (const party of state?.parties ?? []) {
    if (!party.convoyUuid) continue;
    const ids = members.get(party.convoyUuid) ?? new Set();
    for (const userId of playerIds) if (state.membership?.[userId] === party.id) ids.add(userId);
    members.set(party.convoyUuid, ids);
  }
  return members;
}

/**
 * One Convoy write for a plan: raised and restored levels, removed entries, and the record when it changed. Foundry
 * v14's ownership field accepts only ownership levels inside `ownership`, so one user's entry can't be deleted on its
 * own. A write that removes anyone replaces the whole map without them, as core's DocumentOwnershipConfig does.
 * @param {object} plan What planConvoyAccess returned for this Convoy.
 * @param {Record<string, number>} ownership The Convoy's stored ownership.
 */
function convoyAccessChanges(plan, ownership) {
  const changes = {};
  if (plan.remove.length) {
    const levels = { ...ownership, ...plan.set };
    for (const userId of plan.remove) delete levels[userId];
    Object.assign(changes, forcedReplacement('ownership', levels));
  } else {
    for (const [userId, level] of Object.entries(plan.set)) changes[ownershipPath(userId)] = level;
  }
  if (plan.recordChanged) changes[CONVOY_ACCESS_PATH] = plan.record;
  return changes;
}

function recordedConvoyGrants(grants) {
  if (!Array.isArray(grants)) return [];
  return grants.filter(grant => grant?.user).map(grant => ({
    user: String(grant.user),
    level: grant.level === null || grant.level === undefined ? null : Number(grant.level) || 0
  }));
}
