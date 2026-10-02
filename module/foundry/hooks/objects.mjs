/** @layer foundry/hooks */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { ARMAMENT_FLAGS, LOCKABLE_OBJECT_TYPES } from '../../contracts/domains/objects.mjs';
import { RESTORE_WRITE_OPTION } from '../../contracts/domains/recovery.mjs';
import { convoyArtDefaults, objectHasArtStates } from '../../game/objects/rules.mjs';
import {
  planObjectPrototypeWrites,
  syncObjectTokenAppearance,
  syncObjectTokenParameters
} from '../adapters/document-writes/objects.mjs';
import {
  enforceFixtureTokenRules,
  settleFixtureTokenOnPlacement
} from '../adapters/document-writes/tokens.mjs';
import { isActiveGm, localUserId } from '../adapters/services/host.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Object lifecycle                            */
/* -------------------------------------------- */

const INTEGRITY_PATH = 'system.resources.stn.value';
const ART_STATE_PATHS = Object.freeze([
  'system.art.altImagePath', 'system.art.destroyedImagePath', INTEGRITY_PATH,
  'system.art.intact', 'system.art.destroyed', 'system.art.closed', 'system.art.opened',
  'prototypeToken.texture.tint'
]);
const PARAMETER_PATHS = Object.freeze([
  'name', 'prototypeToken.width', 'prototypeToken.height',
  'prototypeToken.texture.scaleX', 'prototypeToken.texture.scaleY', 'prototypeToken.texture.tint'
]);
/**
 * Keep an Object's token art and size in step with its sheet, and give a new Convoy its default art. An Object
 * destroyed in play (not by a sheet edit) is hidden behind a smoke effect, and a lock change plays its sound on the
 * client that made it.
 * @param {{present?: Function, cue?: Function}} [options] Shows the smoke effect on every client, and plays the lock
 *   sound.
 * @returns {object} The handlers `init/hooks.mjs` composes onto the Actor and Token lifecycle.
 */
export function createObjectLifecycleHandlers({ present = null, cue = null } = {}) {
  return Object.freeze({
    onPreCreateFixtureActor(actor) {
      if (actor?.type === 'Convoy') { actor.updateSource(convoyArtSeeds(actor)); return; }
      if (actor?.type !== 'Object') return;
      actor.updateSource(planObjectPrototypeWrites(actor, null));
    },

    onPreUpdateFixtureActor(actor, changes) {
      if (actor?.type === 'Convoy') { Object.assign(changes, convoyArtSeeds(actor, changes)); return; }
      if (actor?.type !== 'Object') return;
      Object.assign(changes, planObjectPrototypeWrites(actor, changes));
    },

    onUpdateObjectActor(actor, changes, options = {}, userId = null) {
      if (actor?.type !== 'Object') return;
      if (objectHasArtStates(actor.system?.objectType)) refreshObjectSprites(actor);
      if (options[RESTORE_WRITE_OPTION] === true && touches(changes, ['system.locked'])) return;
      if (touches(changes, ['system.locked']) && String(userId ?? '') === localUserId()) playLockCue(actor, cue);
      if (options.emblemObjectSettlement === true || !isActiveGm()) return;
      if (touches(changes, ART_STATE_PATHS) || touches(changes, ['img', 'system.objectType', 'system.locked'])) {
        const destructionFx = touches(changes, [INTEGRITY_PATH]) && options.emblemSheetEdit !== true;
        void syncObjectTokenAppearance(actor, { destructionFx, present })
          .catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'createObjectLifecycleHandlers'); return null; });
      }
      if (touches(changes, PARAMETER_PATHS)) void syncObjectTokenParameters(actor, changes).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'createObjectLifecycleHandlers'); return null; });
    },

    onPreCreateFixtureToken(tokenDocument) {
      settleFixtureTokenOnPlacement(tokenDocument);
    },

    onPreUpdateFixtureToken(tokenDocument, changes) {
      enforceFixtureTokenRules(tokenDocument, changes);
    }
  });
}

/**
 * The Convoy's default portrait and token art, for the pre-create and pre-update handlers above. `convoyArtDefaults` in
 * `game/objects/rules.mjs` seeds only the fields still holding Foundry's placeholder, and a pending edit that
 * already carries art of its own is left alone.
 */
function convoyArtSeeds(actor, changes = null) {
  const seeds = convoyArtDefaults({
    img: String(actor?.img ?? ''),
    prototypeSrc: String(actor?.prototypeToken?.texture?.src ?? ''),
    placeholderArt: CONST.DEFAULT_TOKEN
  });
  if (!changes) return seeds;
  const writes = {};
  for (const [field, value] of Object.entries(seeds)) {
    if (!foundry.utils.hasProperty(changes, field)) writes[field] = value;
  }
  return writes;
}

/* -------------------------------------------- */
/*  Armament release                            */
/* -------------------------------------------- */

/**
 * Build the hook that hands a borrowed Armament back the moment its wielder's Token leaves the rack, whatever
 * moved it: a planned move, being pushed, a teleport or a drag. The host client hands it back.
 * @param {{objects: object}} options The Object writer that checks whether the token left the rack and hands the
 *   Armament back.
 * @returns {object} The handler `init/hooks.mjs` composes onto the Token lifecycle.
 */
export function createArmamentReleaseHandlers({ objects }) {
  return Object.freeze({
    onUpdateTokenArmamentRelease(tokenDocument, changes = null) {
      if (!isActiveGm() || !changes || (!('x' in changes) && !('y' in changes))) return;
      const actor = tokenDocument?.actor;
      if (actor?.type !== 'Character' || !actor.getFlag(SYSTEM_ID, ARMAMENT_FLAGS.UUID)) return;
      void objects.releaseArmamentIfLeft(String(tokenDocument.uuid ?? ''))
        .catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'createArmamentReleaseHandlers'); return null; });
    }
  });
}

/** Play the lock or unlock sound on the client that changed the lock. */
function playLockCue(actor, cue) {
  const objectType = String(actor.system?.objectType ?? '');
  if (!LOCKABLE_OBJECT_TYPES.includes(objectType) || typeof cue !== 'function') return;
  void Promise.resolve(cue({ objectType, opened: actor.system?.locked === false }))
    .catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'playLockCue'); return null; });
}

/** Re-flag every placed Token of an Object so its sprite offset is re-applied after a state change. */
function refreshObjectSprites(actor) {
  const tokens = actor.isToken
    ? [actor.token?.object].filter(Boolean)
    : (globalThis.canvas?.tokens?.placeables ?? []).filter(token => token.document?.actorId === actor.id);
  for (const token of tokens) token.renderFlags?.set?.({ refreshPosition: true });
}

function touches(changes, paths) {
  return paths.some(path => foundry.utils.hasProperty(changes ?? {}, path));
}
