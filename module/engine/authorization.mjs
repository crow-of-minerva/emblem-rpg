/** @layer engine */
import { AUTHORITY_LEVELS } from '../contracts/protocol.mjs';
import { RESULT_CODES, refuse } from '../contracts/results.mjs';

const AUTHORITY_METHODS = ['isGm', 'isActiveGm', 'canUserOwnActor', 'canUserControlToken', 'getControlLock'];

/* -------------------------------------------- */
/*  Command authorization                       */
/* -------------------------------------------- */

/**
 * Build the authorize slots for CommandDispatcher definitions from the authority port
 * (foundry/adapters/services/authority.mjs). Each slot resolves to null to admit the request, or to a refusal that
 * stops the handler.
 * @param {object} authority Injected caller authority port.
 * @returns {object} Policy factories.
 */
export function createCommandAuthorization(authority) {
  for (const method of AUTHORITY_METHODS) {
    if (typeof authority?.[method] !== 'function') throw new Error(`Authority port is missing ${method}.`);
  }
  return Object.freeze({
    /** Any Gamemaster user. */
    gm: () => async context => (authority.isGm(context.userId) ? null : refuse(RESULT_CODES.GM_REQUIRED)),

    /** Only the active GM, whose client runs the commands. Internal commands and api.movement.drive use this. */
    activeGm: () => async context => (
      authority.isActiveGm(context.userId) ? null : refuse(RESULT_CODES.GM_REQUIRED)
    ),

    /** The owner of every actor the selector names on the payload. A GM owns everything. */
    actorOwner: select => async context => {
      for (const actorUuid of selected(select, context)) {
        if (!await authority.canUserOwnActor(actorUuid, context.userId)) return refuse(RESULT_CODES.OWNER_REQUIRED);
      }
      return null;
    },

    /**
     * Authorize staff or Trusted Players to edit every selected Actor. Player ownership grants gameplay, not
     * authoring.
     */
    actorAuthor: select => async context => {
      if (authority.isGm(context.userId)) return null;
      for (const actorUuid of selected(select, context)) {
        if (await authority.canUserAuthorActor(actorUuid, context.userId) !== true) {
          return refuse(RESULT_CODES.AUTHOR_REQUIRED);
        }
      }
      return null;
    },

    /**
     * Authorize staff or a Trusted Player who owns it to edit the Actor behind every selected Token. Player
     * ownership grants gameplay, not authoring, so a Player is refused where tokenController would admit them.
     */
    tokenAuthor: select => async context => {
      for (const tokenUuid of selected(select, context)) {
        if (await authority.canUserAuthorToken(tokenUuid, context.userId) !== true) {
          return refuse(RESULT_CODES.AUTHOR_REQUIRED);
        }
      }
      return null;
    },

    /** The controller of the token the selector names. A token that no longer exists is refused. */
    tokenController: (select, options = {}) => async context => {
      for (const tokenUuid of selected(select, context)) {
        const held = controllerRefusal(authority.getControlLock(), tokenUuid, context.userId);
        if (held) return held;
        if (await authority.canUserControlToken(tokenUuid, context.userId, options) !== true) {
          return refuse(RESULT_CODES.OWNER_REQUIRED);
        }
      }
      return null;
    },

    /** Like tokenController, but a Token that no longer exists passes so the handler can release its orphan. */
    tokenControllerOrAbsent: (select, options = {}) => async context => {
      for (const tokenUuid of selected(select, context)) {
        const held = controllerRefusal(authority.getControlLock(), tokenUuid, context.userId);
        if (held) return held;
        if (await authority.canUserControlToken(tokenUuid, context.userId, options) === false) {
          return refuse(RESULT_CODES.OWNER_REQUIRED);
        }
      }
      return null;
    },

    /** A payload option only a Gamemaster may set. The selector says whether the request set it. */
    gmOption: select => async context => (
      !select(context.payload ?? {}, context) || authority.isGm(context.userId) ? null : refuse(RESULT_CODES.GM_REQUIRED)
    ),

    /** Every policy in turn. The first refusal stands. */
    all: (...policies) => async context => {
      for (const policy of policies) {
        const refusal = await policy(context);
        if (refusal) return refusal;
      }
      return null;
    }
  });
}

function controllerRefusal(lock, tokenUuid, userId) {
  if (!lock?.holderId || !lock?.tokenUuid || (lock.holderId === userId && lock.tokenUuid === tokenUuid)) return null;
  return refuse(RESULT_CODES.MOVEMENT_LOCKED, { holderName: lock.holderName });
}

function selected(select, context) {
  const value = select(context.payload ?? {}, context);
  const values = Array.isArray(value) ? value : [value];
  return values.map(entry => String(entry ?? ''));
}

/* -------------------------------------------- */
/*  Facade callers                              */
/* -------------------------------------------- */

/** Whether a bounded caller projection from the local facade is a Gamemaster. */
export function callerIsGamemaster(caller) {
  return caller?.level === AUTHORITY_LEVELS.GAMEMASTER;
}
