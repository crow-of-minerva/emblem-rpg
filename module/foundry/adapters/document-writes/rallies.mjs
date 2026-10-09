/** @layer foundry/adapters/document-writes */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { RALLY_RECORD_FLAG } from '../../../contracts/domains/progression.mjs';
import { planRallyCount } from '../../../game/support/rules.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { resolveActor } from '../services/host.mjs';

/* -------------------------------------------- */
/*  Rally writes                                */
/* -------------------------------------------- */

/** Rally's writes carry the same option as the rest of an item use's effect writes. */
const rallyOptions = () => ({ emblemEffectSettlement: true });

/** The caster's record of this map's Rallies, which rallyRecordUpdate counts in. */
const RALLY_RECORD_PATH = `flags.${SYSTEM_ID}.${RALLY_RECORD_FLAG}`;

/**
 * Apply one Rally that planRallyEffect (game/support/rules.mjs) planned, under a pre-picked effect id recorded for
 * undo first. Its bonuses are stored in flags, not in changes.
 * @param {string} actorUuid The unit being rallied.
 * @param {object} intent The planned Rally.
 * @param {object|null} [operation] The item use's undo record.
 * @returns {Promise<boolean>} Whether the effect was created.
 */
export async function applyRallyEffect(actorUuid, intent, operation = null) {
  const actor = await resolveActor(actorUuid);
  if (!actor || !intent) return false;
  const id = foundry.utils.randomID();
  await operation?.capture({ creating: [{ parent: actor, documentName: 'ActiveEffect', ids: [id] }] });
  const created = await actor.createEmbeddedDocuments('ActiveEffect',
    [{ ...rallyEffectData(intent), _id: id }], { ...rallyOptions(), keepId: true });
  return Boolean(created?.length);
}

/**
 * The update fragment that counts one more Rally on each unit in the caster's record of this map's Rallies
 * (RALLY_RECORD_FLAG), after recording that path for undo. The record is read fresh and each target is folded in
 * turn, so several targets in one use each add their own, as one write per target would. The record is a list, not
 * a map keyed by uuid, because Foundry would expand the dots in a uuid key. The caller writes the fragment, with
 * rallyOptions' flag, in its own update of the caster.
 * @param {Actor} actor The caster's Actor.
 * @param {string[]} targetActorUuids The units this use Rallied, in the order they were Rallied.
 * @param {object|null} [operation] The item use's undo record.
 * @returns {Promise<object>} The fragment, empty when no unit was Rallied.
 */
export async function rallyRecordUpdate(actor, targetActorUuids, operation = null) {
  if (!targetActorUuids.length) return {};
  let rallies = actor.flags?.[SYSTEM_ID]?.[RALLY_RECORD_FLAG];
  for (const targetActorUuid of targetActorUuids) rallies = planRallyCount(rallies, targetActorUuid);
  await operation?.capture({ documents: [{ document: actor, paths: [RALLY_RECORD_PATH] }] });
  return { [RALLY_RECORD_PATH]: rallies };
}

/** The ActiveEffect data for a Rally that planRallyEffect planned. */
function rallyEffectData(intent) {
  return {
    name: intent.name,
    img: `systems/${SYSTEM_ID}/assets/status/Rally.png`,
    changes: [],
    statuses: [intent.statusId],
    description: `Rallied by ${escapeHtml(intent.casterName)}: Rank ${intent.rankLetter}<br>${intent.statLine}`,
    flags: {
      core: { statusId: intent.statusId },
      [SYSTEM_ID]: {
        rally: {
          casterUuid: intent.casterUuid,
          casterName: intent.casterName,
          affinity: intent.affinity,
          rank: intent.rank,
          stats: { ...intent.stats }
        },
        duration: intent.durationPhases,
        removeOnFactionPhase: true,
        beneficial: true
      }
    }
  };
}
