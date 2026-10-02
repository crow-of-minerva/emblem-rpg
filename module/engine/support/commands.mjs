/** @layer engine/support */
import {
  COMMAND_IDS,
  INTERNAL_COMMAND_IDS,
  MAX_SETTLEMENT_ATTEMPTS
} from '../../contracts/commands.mjs';
import { normalizeSupportPartnersIntent, normalizeSupportXpGrantIntent, SUPPORT_MIRROR_RESOURCE_KEY } from '../../contracts/domains/progression.mjs';
import { createCommandAuthorization } from '../authorization.mjs';
import { planSupportMirror, planSupportXpGrant } from '../../game/support/rules.mjs';
import { accept, refuse, RESULT_CODES } from '../../contracts/results.mjs';
import { diagnosticData, requirePorts } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Support commands                            */
/* -------------------------------------------- */

/**
 * The support command definitions init/system.mjs registers with CommandDispatcher: granting support XP (a child
 * command of downtime activities), setting a unit's partners (api.character.support.setPartners), and the mirror
 * clean-up job foundry/hooks/actors.mjs submits.
 */
export function createSupportCommandContribution({ actors, authority }) {
  requirePorts('createSupportCommandContribution', { actors });
  const authorize = createCommandAuthorization(authority);
  return [
    {
      id: COMMAND_IDS.CHARACTER.SUPPORT.GRANT_XP,
      authorize: authorize.gm(),
      handler: context => settleSupportXpGrant(context, actors),
      concurrencyKeys: context => [
        String(context.payload?.sourceActorUuid ?? ''),
        ...(Array.isArray(context.payload?.partnerActorUuids) ? context.payload.partnerActorUuids : [])
      ].map(uuid => String(uuid ?? '')).filter(Boolean).map(uuid => `actor:${uuid}`)
        .concat([SUPPORT_MIRROR_RESOURCE_KEY]).sort()
    },
    {
      id: COMMAND_IDS.CHARACTER.SUPPORT.SET_PARTNERS,
      authorize: authorize.actorAuthor(payload => payload.actorUuid),
      handler: context => setSupportPartners(context, actors),
      concurrencyKeys: context => [`actor:${String(context.payload?.actorUuid ?? '')}`, SUPPORT_MIRROR_RESOURCE_KEY]
    },
    {
      id: INTERNAL_COMMAND_IDS.CHARACTER.SUPPORT.RECONCILE_MIRROR,
      authorize: authorize.activeGm(),
      handler: context => reconcileSupportMirror(context, actors),
      concurrencyKeys: () => [SUPPORT_MIRROR_RESOURCE_KEY]
    },

  ];
}

/**
 * Set a unit's support partners, then rebuild the matching entries on each partner (settleSupportMirror). It runs
 * as a host command because an owner's own edit can change only one actor.
 */
async function setSupportPartners(context, actors) {
  const intent = normalizeSupportPartnersIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.SUPPORT_INPUT_INVALID);

  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const source = await actors.getSupportSnapshot(intent.actorUuid);
    if (!source) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);

    const committed = await actors.settleSupportPartners(source, intent.partners.map(entry => ({ ...entry })), context);
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) {
      return refuse(RESULT_CODES.SUPPORT_SETTLEMENT_FAILED, diagnosticData(committed));
    }

    const mirrored = await settleSupportMirror(intent.actorUuid, actors, context);
    const outcome = { actorUuid: intent.actorUuid, partners: intent.partners.length, mirrored: mirrored.changed };
    // The unit's own list is the one that counts and is already saved, so a failed update of the partners'
    // copies still accepts, as SUPPORT_MIRROR_PENDING.
    if (mirrored.code) return accept(RESULT_CODES.SUPPORT_MIRROR_PENDING, { ...outcome, ...(mirrored.detail ?? {}) });
    return accept(RESULT_CODES.SUPPORT_PARTNERS_SET, outcome);
  }
  return refuse(RESULT_CODES.SUPPORT_STATE_CHANGED);
}

/**
 * The RECONCILE_MIRROR command foundry/hooks/actors.mjs submits after an actor's own support list changes:
 * rebuild the matching entries on its partners.
 */
async function reconcileSupportMirror(context, actors) {
  const actorUuid = String(context.payload?.actorUuid ?? '');
  if (!actorUuid) return refuse(RESULT_CODES.SUPPORT_INPUT_INVALID);

  const swept = await settleSupportMirror(actorUuid, actors, context);
  if (swept.code) return refuse(swept.code, swept.detail ?? {});
  return accept(RESULT_CODES.SUPPORT_MIRROR_RECONCILED, { changed: swept.changed });
}

/* -------------------------------------------- */
/*  Support XP                                  */
/* -------------------------------------------- */

/**
 * Write support XP to the source's bonds with each partner (planSupportXpGrant), taking any support ranks it
 * crosses, then rebuild the partners' side through settleSupportMirror.
 */
async function settleSupportXpGrant(context, actors) {
  const intent = normalizeSupportXpGrantIntent(context.payload);
  if (!intent) return refuse(RESULT_CODES.SUPPORT_INPUT_INVALID);

  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const source = await actors.getSupportSnapshot(intent.sourceActorUuid);
    if (!source) return refuse(RESULT_CODES.ACTOR_NOT_FOUND);

    const others = [];
    for (const partnerUuid of intent.partnerActorUuids) {
      const partner = await actors.getSupportSnapshot(partnerUuid);
      if (partner) others.push(partner);
    }

    const plan = planSupportXpGrant({
      source, others, gain: intent.amount, autoCreate: intent.autoCreate
    });
    if (!plan.partners) return refuse(RESULT_CODES.SUPPORT_INELIGIBLE, { gain: plan.gain });

    const committed = await actors.settleSupportPartners(source, plan.partners, context);
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) {
      return refuse(RESULT_CODES.SUPPORT_SETTLEMENT_FAILED, diagnosticData(committed));
    }

    const mirrored = await settleSupportMirror(source.uuid, actors, context);
    const outcome = {
      sourceActorUuid: source.uuid,
      sourceName: source.name,
      gain: plan.gain,
      recipients: plan.recipients,
      rankUps: plan.rankUps,
      mirrored: mirrored.changed
    };
    // As in setSupportPartners, a failed mirror still accepts.
    if (mirrored.code) return accept(RESULT_CODES.SUPPORT_MIRROR_PENDING, { ...outcome, ...(mirrored.detail ?? {}) });
    return accept(RESULT_CODES.SUPPORT_XP_GRANTED, outcome);
  }
  return refuse(RESULT_CODES.SUPPORT_STATE_CHANGED);
}

/* -------------------------------------------- */
/*  Bond mirror                                 */
/* -------------------------------------------- */

/**
 * Rebuild the support entries on each partner so they match the source actor's own list, which is the one that
 * counts.
 * @param {string} actorUuid The unit whose own list is copied to its partners.
 * @param {object} actors The Character writer.
 * @param {object} [context] The running command's context, so the writes share its undo record.
 * @returns {Promise<object>} Either a `changed` count or the result code that refused it.
 */
async function settleSupportMirror(actorUuid, actors, context = {}) {
  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const source = await actors.getSupportSnapshot(actorUuid);
    if (!source) return { changed: 0, code: RESULT_CODES.ACTOR_NOT_FOUND };
    const roster = await actors.getSupportRoster();
    const plans = planSupportMirror({ source, roster: roster?.units ?? [] });
    if (!plans.length) return { changed: 0 };

    const committed = await actors.settleSupportMirror(roster, plans, context);
    if (committed?.stale === true) continue;
    if (committed?.ok !== true) {
      return {
        changed: 0,
        code: RESULT_CODES.SUPPORT_SETTLEMENT_FAILED,
        detail: diagnosticData(committed)
      };
    }
    return { changed: Number(committed.settled ?? plans.length) || 0 };
  }
  return { changed: 0, code: RESULT_CODES.SUPPORT_STATE_CHANGED };
}
