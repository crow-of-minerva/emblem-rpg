/** @layer foundry/adapters/services */
import { AUTHORITY_LEVELS, canAuthorSystemDocuments, normalizeRollMessageMode } from '../../../contracts/protocol.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { USER_LOCK_SETTING } from '../../../config/settings.mjs';
import { ACTOR_TYPES } from '../../../config/constants.mjs';
import { projectLinkedConvoys } from '../projections/economy.mjs';
import { readPartyState } from '../projections/parties.mjs';
import { projectHostAuthority, resolveDocument, resolveSync } from './host.mjs';
import { notifyFoundry } from './diagnostics.mjs';

/* -------------------------------------------- */
/*  User authority                              */
/* -------------------------------------------- */
/**
 * A user's authority level (AUTHORITY_LEVELS) from their Foundry role. The tier checks below use it, and the public
 * API returns it for the local user (`authority` in init/system.mjs).
 */
export function projectFoundryUserAuthority(user, roles = CONST.USER_ROLES) {
  const role = Number(user?.role) || 0;
  let level = AUTHORITY_LEVELS.NONE;
  if (role >= roles.GAMEMASTER) level = AUTHORITY_LEVELS.GAMEMASTER;
  else if (role >= roles.ASSISTANT) level = AUTHORITY_LEVELS.ASSISTANT;
  else if (role >= roles.TRUSTED) level = AUTHORITY_LEVELS.TRUSTED;
  else if (role >= roles.PLAYER) level = AUTHORITY_LEVELS.PLAYER;
  return Object.freeze({ userId: String(user?.id ?? ''), level });
}

/**
 * What the command gateway needs to know about this client: new request ids, this browser tab's session id, the
 * local user, the chat message mode, and who the host is. Each page load gets a new session id, so requests
 * addressed to an earlier host tab are rejected.
 */
export function createFoundryGatewayIdentity() {
  const sessionId = globalThis.crypto?.randomUUID?.() ?? foundry.utils.randomID(32);
  return Object.freeze({
    requestId: () => globalThis.crypto?.randomUUID?.() ?? foundry.utils.randomID(),
    sessionId: () => sessionId,
    localUserId: () => String(game.user?.id ?? ''),
    messageMode: () => normalizeRollMessageMode(game.settings.get('core', 'messageMode')),
    host: () => projectHostAuthority(),
    activeGmId: () => projectHostAuthority().hostUserId,
    isGmUser: userId => game.users?.get?.(String(userId ?? ''))?.isGM === true,
    localUserIsActiveGm: () => projectHostAuthority().localIsHost
  });
}

/* -------------------------------------------- */
/*  Command authority                           */
/* -------------------------------------------- */

/**
 * The permission checks behind each command's `authorize` (engine/authorization.mjs): is the user a GM, who holds
 * the control lock, and may the user own, control or edit a unit or take from a Convoy.
 */
export function createFoundryCommandAuthority() {
  const owner = () => globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER;
  const user = userId => game.users?.get?.(String(userId ?? '')) ?? null;
  return Object.freeze({
    isGm: userId => user(userId)?.isGM === true,
    getControlLock: () => game.settings.get(SYSTEM_ID, USER_LOCK_SETTING),

    /** Whether `userId` is the host and this browser tab is the host client. */
    isActiveGm(userId) {
      const host = projectHostAuthority();
      return host.localIsHost && host.hostUserId === String(userId ?? '');
    },

    async canUserOwnActor(actorUuid, userId) {
      const caller = user(userId);
      if (!caller) return false;
      if (caller.isGM) return true;
      const actor = await resolveDocument(actorUuid);
      return actor?.documentName === 'Actor' && actor.testUserPermission(caller, owner()) === true;
    },

    /**
     * Whether the user controls the token's actor, or null when the token no longer exists. While a control lock is
     * held, only the user holding it controls, and only the locked token. `requirePlan` also demands that user's own
     * open movement plan; with it, a missing token gives false rather than null.
     */
    async canUserControlToken(tokenUuid, userId, { requirePlan = false } = {}) {
      const caller = user(userId);
      if (!caller) return false;
      const lock = game.settings.get(SYSTEM_ID, USER_LOCK_SETTING);
      const held = Boolean(lock?.holderId && lock?.tokenUuid);
      const controls = held && lock.holderId === userId && lock.tokenUuid === tokenUuid;
      if (held && !controls) return false;
      const token = await resolveDocument(tokenUuid);
      if (requirePlan && (!controls || token?.actor?.system?.turn?.movementPlanning !== true
        || token.actor.system.turn.movementControllerId !== userId)) return false;
      if (token?.documentName !== 'Token' || !token.actor) return null;
      if (caller.isGM) return true;
      return token.actor.testUserPermission(caller, owner()) === true;
    },

    /**
     * Whether the user may edit the actor directly: a GM or Assistant GM, or a Trusted player who owns it. The
     * compendium lock isn't checked here, because Foundry refuses a write to a locked pack itself.
     */
    async canUserAuthorActor(actorUuid, userId) {
      const caller = user(userId);
      const actor = caller ? await resolveDocument(actorUuid) : null;
      return actor?.documentName === 'Actor' && canFoundryUserAuthorIgnoringLock(caller, actor);
    },

    /** Whether the user may edit the Token's Actor directly: a GM or Assistant GM, or a Trusted player who owns it. */
    async canUserAuthorToken(tokenUuid, userId) {
      const caller = user(userId);
      const token = caller ? await resolveDocument(tokenUuid) : null;
      if (token?.documentName !== 'Token' || !token.actor) return false;
      return canFoundryUserAuthorIgnoringLock(caller, token.actor);
    },

    /** Authorize a Convoy withdrawal when the requester owns the receiving unit and its party links that Convoy. */
    async canUserDrawFromConvoy(convoyUuid, targetActorUuid, userId) {
      const caller = user(userId);
      if (!caller) return false;
      const [convoy, target] = await Promise.all([resolveDocument(convoyUuid), resolveDocument(targetActorUuid)]);
      if (convoy?.documentName !== 'Actor' || convoy.type !== ACTOR_TYPES.CONVOY) return false;
      if (target?.documentName !== 'Actor') return false;
      if (!caller.isGM && target.testUserPermission(caller, owner()) !== true) return false;
      return projectLinkedConvoys(target, PARTY_CONVOY_LINKS).some(entry => entry.actorUuid === String(convoy.uuid));
    }
  });
}

/** The party data and Convoy lookup used to find which Convoys a unit's party is linked to. */
const PARTY_CONVOY_LINKS = Object.freeze({
  readState: () => readPartyState(),
  resolveConvoy: uuid => {
    const actor = resolveSync(uuid, 'Actor');
    return actor?.type === ACTOR_TYPES.CONVOY ? actor : null;
  }
});

/* -------------------------------------------- */
/*  Direct document edits                       */
/* -------------------------------------------- */
const REFUSAL_NOTICE_MS = 1500;
const refusalNotices = new Map();

/**
 * Whether a user may edit a document directly, through its sheet or another native edit. A GM or Assistant GM may
 * edit any document, and a Trusted player the documents they own. A player's changes go through the host's
 * commands instead. An embedded Item or effect follows the ownership of the document it belongs to. Nobody, the GM
 * included, edits a document in a locked compendium.
 * @param {object} user A Foundry User.
 * @param {object} document The document to change.
 * @returns {boolean}
 */
export function canFoundryUserAuthorDocument(user, document) {
  return !inLockedCompendium(document) && canFoundryUserAuthorIgnoringLock(user, document);
}

/**
 * The same check, ignoring compendium locks. The Item sheet's Copy As Staff button uses it to offer an import from a
 * locked pack, and the command permission checks use it, since Foundry refuses writes to a locked pack by itself.
 * @param {object} user A Foundry User.
 * @param {object} document The document to read or change.
 * @returns {boolean}
 */
export function canFoundryUserAuthorIgnoringLock(user, document) {
  const level = projectFoundryUserAuthority(user).level;
  if (canAuthorSystemDocuments({ level })) return true;
  return level === AUTHORITY_LEVELS.TRUSTED && ownsCarrier(user, document);
}

/**
 * Whether a user may use a unit's gameplay controls, which act through the host's commands. A GM or Assistant GM may
 * for every unit, anyone else only for units they own; viewing another unit doesn't count. Nobody may for a
 * document in a locked compendium, since every one of those controls writes to it.
 * @param {object} user A Foundry User.
 * @param {object} document The unit, or a part of it.
 * @returns {boolean}
 */
export function canFoundryUserPlayDocument(user, document) {
  if (inLockedCompendium(document)) return false;
  const level = projectFoundryUserAuthority(user).level;
  if (canAuthorSystemDocuments({ level })) return true;
  return level !== AUTHORITY_LEVELS.NONE && ownsCarrier(user, document);
}

/**
 * Whether this client lets a native create, update or delete go out. A Trusted player creates world documents they
 * will own, and embedded ones only inside what they already own. A player's client sends none of them; see
 * admitNativeWrite for what this check can and can't stop.
 * @param {object} user The user issuing the write.
 * @param {object} document The document being written.
 * @param {'create'|'update'|'delete'} action The native operation.
 * @returns {boolean}
 */
function canFoundryUserWriteDocument(user, document, action) {
  const level = projectFoundryUserAuthority(user).level;
  if (canAuthorSystemDocuments({ level })) return true;
  if (level !== AUTHORITY_LEVELS.TRUSTED) return false;
  if (action === 'create' && !carrierOf(document)) return true;
  return ownsCarrier(user, document);
}

/**
 * Decide whether a native create, update or delete of a system document may go ahead. The _preCreate, _preUpdate
 * and _preDelete of EmblemActor, EmblemItem, EmblemActiveEffect and EmblemActorDelta call it, so it covers sheet
 * saves, macros, API and HUD writes made through those documents. Token documents are not covered.
 *
 * This is a fair-play guard on the client sending the write, not a security boundary. Foundry's server checks only
 * document ownership, and players own their units, so a player who bypasses these methods from the console can
 * still write to them.
 *
 * While the host client is busy, writes from other clients are refused first, without a warning. Otherwise a
 * refused write warns the user, at most once per document every REFUSAL_NOTICE_MS, except a flags-only update,
 * which modules write during HUD refreshes. That one is refused quietly.
 * @param {object} user The user issuing the write.
 * @param {object} document The document being written.
 * @param {'create'|'update'|'delete'} action The native operation.
 * @param {object} [changes] The pending update, for an update.
 * @returns {boolean} Whether the write may proceed.
 */
export function admitNativeWrite(user, document, action, changes = null, blocker = document?.constructor?.processingBlocker ?? null) {
  if (blocker && !blocker.admitNativeWrite()) return false;
  if (canFoundryUserWriteDocument(user, document, action)) return true;
  if (!(action === 'update' && flagsOnly(changes))) warnRefusedWrite(user, document);
  return false;
}

/**
 * The document an embedded one belongs to, or null for a world document: its Actor or Item, or for an unlinked
 * token's actor, its ActorDelta and then its Token (a Token takes its ownership from the actor it stands for).
 */
function carrierOf(document) {
  const parent = document?.parent;
  return parent && ['Actor', 'Item', 'ActorDelta', 'Token'].includes(parent.documentName) ? parent : null;
}

/**
 * Whether the document lives in a locked compendium, which takes no writes. An embedded one carries its parent's
 * pack. The Item sheet's Copy As Staff reads it to ask for an import instead of creating the Staff in that pack.
 */
export function inLockedCompendium(document) {
  const pack = document?.pack;
  return Boolean(pack) && game.packs.get(pack)?.locked === true;
}

/** Whether the user owns the top-level document this one belongs to, which is where Foundry keeps ownership. */
function ownsCarrier(user, document) {
  const owner = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER;
  if (owner === undefined || !user || !document) return false;
  let carrier = document;
  while (carrierOf(carrier)) carrier = carrierOf(carrier);
  return carrier.testUserPermission?.(user, owner) === true;
}

function flagsOnly(changes) {
  if (!changes || typeof changes !== 'object') return false;
  const keys = Object.keys(changes).filter(key => key !== '_id' && key !== '_stats');
  return keys.length > 0 && keys.every(key => key === 'flags' || key.startsWith('flags.'));
}

function warnRefusedWrite(user, document) {
  let carrier = document;
  while (carrierOf(carrier)) carrier = carrierOf(carrier);
  const key = `${user?.id ?? ''}:${carrier?.uuid ?? carrier?.id ?? ''}`;
  const now = Date.now();
  if (now - (refusalNotices.get(key) ?? -Infinity) < REFUSAL_NOTICE_MS) return;
  if (refusalNotices.size > 200) refusalNotices.clear();
  refusalNotices.set(key, now);
  notifyFoundry(import.meta.url, 'warn', `Only a GM or a Trusted owner can edit ${carrier?.name || 'this document'}.`);
}
