/** @layer contracts/domains */
import { OWNED_UNIT_FACTIONS } from './characters.mjs';
import { plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Progression rules and vocabulary            */
/* -------------------------------------------- */
export const CHARACTER_EXPERIENCE_ACTOR_TYPES = OWNED_UNIT_FACTIONS;
export const CHARACTER_EXPERIENCE_THRESHOLD = 100;
export const CHARACTER_MAX_LEVEL = 30;
/**
 * The caster Actor's flag counting its XP-granting Item uses per activation XP entry, stamped with the id of the
 * encounter they were made in, so a count from any other encounter reads as none.
 */
export const ACTIVATION_EXPERIENCE_USES_FLAG = 'activationExperienceUses';
/**
 * The turn fields a promotion writes to end the unit's turn when it has no open movement plan to close instead
 * (FoundryClassFeatureRepository.spendPromotionTurn).
 */
export const PROMOTION_TURN_SPENT = Object.freeze({
  'system.turn.actionAvailable': false,
  'system.turn.movementAvailable': false,
  'system.turn.bonusActionAvailable': false,
  'system.turn.movementPlanning': false,
  'system.turn.canterPathfinding': false,
  'system.turn.movementControllerId': '',
  'system.turn.movementPlanStartedAt': 0,
  'system.turn.continuationPending': '',
  'system.turn.continuationRequestId': ''
});
export const LEVEL_UP_STAT_KEYS = Object.freeze(['hp', 'mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res']);
export const LEVEL_UP_STAT_LABELS = Object.freeze({
  hp: 'HP',
  mgt: 'MGT',
  agi: 'AGI',
  tqn: 'TQN',
  wit: 'WIT',
  cha: 'CHA',
  def: 'DEF',
  res: 'RES'
});
export const BUDDING_TALENT_ACTIONS = Object.freeze({
  KEEP: 'keep',
  GAIN: 'gain',
  REMOVE: 'remove'
});
export const BUDDING_TALENT = Object.freeze({
  name: 'Budding Talent',
  growthBonus: 10,
  description: 'Grants +10 to all stat growth rates during level-ups.'
});
export const LEVEL_UP_VOICE_QUALITIES = Object.freeze({
  GOOD: 'good',
  BAD: 'bad'
});

/**
 * The class base stats the promotion panel compares. A level-up raises only LEVEL_UP_STAT_KEYS, but a new class can
 * change every one of these.
 */
export const PROMOTION_STAT_KEYS = Object.freeze([
  'mgt', 'agi', 'tqn', 'wit', 'cha', 'hp', 'stn', 'def', 'res', 'eva', 'mov', 'bld', 'spd', 'acc', 'crit'
]);
export const PROMOTION_STAT_LABELS = Object.freeze({
  mgt: 'MGT', agi: 'AGI', tqn: 'TQN', wit: 'WIT', cha: 'CHA', hp: 'HP', stn: 'STN', def: 'DEF', res: 'RES',
  eva: 'EVA', mov: 'MVMT', bld: 'BLD', spd: 'SPD', acc: 'ACC', crit: 'CRIT'
});
/** The promotion window's two bar columns, each listed top to bottom. */
export const PROMOTION_BAR_COLUMNS = Object.freeze({
  left: Object.freeze(['hp', 'stn', 'bld', 'mov', 'eva', 'spd', 'acc', 'crit']),
  right: Object.freeze(['mgt', 'agi', 'tqn', 'wit', 'cha', 'def', 'res'])
});
/** Each bar's full width, a fixed ceiling per stat so bars compare across classes and units. */
export const PROMOTION_BAR_MAXIMA = Object.freeze({
  hp: 100, stn: 15, bld: 20, mov: 10, eva: 30, spd: 10, acc: 10, crit: 50,
  mgt: 20, agi: 20, tqn: 20, wit: 20, cha: 20, def: 20, res: 20
});
/** The promotion window's bar labels: the shared promotion labels, with the shorter MOV for movement. */
export const PROMOTION_BAR_LABELS = Object.freeze({ ...PROMOTION_STAT_LABELS, mov: 'MOV' });

/** The weapon families a promotion path may require, in the order the preview lists them. */
export const PROMOTION_PROFICIENCY_KEYS = Object.freeze([
  'brawling', 'blade', 'polearm', 'heavy', 'bow', 'covert', 'elemental', 'divine', 'occult', 'arcane'
]);

/** Only these factions may hold or be held as a Support bond. */
export const SUPPORT_ELIGIBLE_ACTOR_TYPES = OWNED_UNIT_FACTIONS;

export const SUPPORT_RANKS = Object.freeze(['E', 'D', 'C', 'B', 'A', 'S']);

/** XP needed to leave each rank. A new bond needs E's own threshold to reach E. */
export const SUPPORT_XP_THRESHOLDS = Object.freeze({ E: 50, D: 50, C: 75, B: 100, A: 125, S: 150 });

/** A bond that exists but has not been earned yet sits one step below E. */
export const SUPPORT_UNRANKED = -1;
export const SUPPORT_MAX_RANK = SUPPORT_RANKS.length - 1;
export const SUPPORT_UNRANKED_LETTER = '--';

/**
 * The affinity table's tier below E, keyed by this name in affinities.json. A Rally prices a party member it holds
 * no earned bond with at this tier.
 */
export const SUPPORT_NONE_TIER = 'None';

/**
 * The resource key the Support commands in engine/support/commands.mjs name for mirror writes. A mirror sweep may
 * rewrite any Character's partners, so the key stands for the whole world. Like every resource key, it records
 * what a command touches and locks nothing.
 */
export const SUPPORT_MIRROR_RESOURCE_KEY = 'support-mirror:world';

/**
 * The Rally Ability's base name. buildRallyAbility (game/support/rally-ability.mjs) names a unit's Rally after its
 * affinity, as "Rally: Audacity", and the innate grant adopts an Ability named either way.
 */
export const RALLY_ITEM_NAME = 'Rally';
export const RALLY_STATUS_ID = 'Rally';

/**
 * The innate grant key every Support-eligible unit's Rally carries (game/character/innate-grants.mjs). Item
 * activation recognises Rally by this key, since the Ability's name changes with the caster's affinity.
 */
export const RALLY_GRANT_KEY = 'support-rally';

/**
 * A Rally lasts one faction phase. It counts down at the start of the bearer's next phase, so it covers the rest of
 * the phase it was called in and the enemy phase after it.
 */
export const RALLY_DURATION_PHASES = 1;

/**
 * How many times one caster may Rally the same unit in a map, by the support tier the Rally lands at. Each tier is
 * a key of the affinity table: None, then the support ranks.
 */
export const RALLY_TARGET_LIMITS = Object.freeze({ None: 1, E: 1, D: 1, C: 2, B: 2, A: 2, S: 3 });

/**
 * The caster Actor's flag counting its Rallies on each unit this map, as `[{actorUuid, count}]`. An encounter's
 * start and end clear it, and so does a GM restore of the caster.
 */
export const RALLY_RECORD_FLAG = 'rallyTargets';

/** Support XP a caster and a unit share the first time the caster Rallies that unit in a map. */
export const RALLY_SUPPORT_XP = 5;

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */
const PROMOTION_INTENT_KEYS = new Set([
  'actorUuid', 'tokenUuid', 'promotionId', 'usedItemId', 'bypassItem', 'bypassRequirements', 'cinematic'
]);
const SUPPORT_LIMITS = Object.freeze({
  maxPartnersPerGrant: 32,
  maxXpGrant: 1000
});
const SUPPORT_XP_INTENT_KEYS = new Set(['sourceActorUuid', 'partnerActorUuids', 'amount', 'autoCreate']);
const SUPPORT_PARTNERS_INTENT_KEYS = new Set(['actorUuid', 'partners']);
const SUPPORT_PARTNER_ENTRY_KEYS = new Set(['actorUUID', 'name', 'rank', 'xp']);

/** Validate and detach a promotion request. The promotion rules check every requirement again against fresh state. */
export function normalizePromotionIntent(payload = {}) {
  if (!plainRecord(payload) || Object.keys(payload).some(key => !PROMOTION_INTENT_KEYS.has(key))) return null;
  const actorUuid = String(payload.actorUuid ?? '');
  const promotionId = String(payload.promotionId ?? '');
  if (!actorUuid || actorUuid.length > 512 || !promotionId || promotionId.length > 64) return null;
  const tokenUuid = String(payload.tokenUuid ?? '');
  const usedItemId = String(payload.usedItemId ?? '');
  if (tokenUuid.length > 512 || usedItemId.length > 64) return null;
  return Object.freeze({
    actorUuid,
    tokenUuid,
    promotionId,
    usedItemId,
    bypassItem: payload.bypassItem === true,
    bypassRequirements: payload.bypassRequirements === true,
    cinematic: payload.cinematic === true
  });
}

/** Validate and detach a Support XP grant request. It names the units and the amount, and nothing about ranks. */
export function normalizeSupportXpGrantIntent(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).some(key => !SUPPORT_XP_INTENT_KEYS.has(key))) return null;

  const sourceActorUuid = String(payload.sourceActorUuid ?? '');
  if (!sourceActorUuid || sourceActorUuid.length > 512) return null;

  const rawPartners = payload.partnerActorUuids ?? [];
  if (!Array.isArray(rawPartners) || rawPartners.length < 1) return null;
  if (rawPartners.length > SUPPORT_LIMITS.maxPartnersPerGrant) return null;
  if (!rawPartners.every(uuid => typeof uuid === 'string' && uuid && uuid.length <= 512)) return null;
  const partnerActorUuids = [...new Set(rawPartners)];
  if (partnerActorUuids.length !== rawPartners.length) return null;

  const amount = payload.amount;
  if (!Number.isInteger(amount) || amount < 1 || amount > SUPPORT_LIMITS.maxXpGrant) return null;

  return Object.freeze({
    sourceActorUuid,
    partnerActorUuids: Object.freeze(partnerActorUuids),
    amount,
    autoCreate: payload.autoCreate !== false
  });
}

/** Validate and detach a whole replacement partner list for one unit's own side of its bonds. */
export function normalizeSupportPartnersIntent(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).some(key => !SUPPORT_PARTNERS_INTENT_KEYS.has(key))) return null;

  const actorUuid = String(payload.actorUuid ?? '');
  if (!actorUuid || actorUuid.length > 512) return null;

  const rawPartners = payload.partners;
  if (!Array.isArray(rawPartners) || rawPartners.length > SUPPORT_LIMITS.maxPartnersPerGrant) return null;

  const partners = [];
  for (const entry of rawPartners) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (Object.keys(entry).some(key => !SUPPORT_PARTNER_ENTRY_KEYS.has(key))) return null;
    const partnerUuid = String(entry.actorUUID ?? '');
    if (!partnerUuid || partnerUuid.length > 512 || partnerUuid === actorUuid) return null;
    const rank = entry.rank;
    if (!Number.isInteger(rank) || rank < SUPPORT_UNRANKED || rank > SUPPORT_MAX_RANK) return null;
    const xp = entry.xp;
    if (!Number.isInteger(xp) || xp < 0 || xp > SUPPORT_LIMITS.maxXpGrant) return null;
    partners.push(Object.freeze({
      actorUUID: partnerUuid,
      name: String(entry.name ?? '').slice(0, 256),
      rank,
      xp
    }));
  }
  if (new Set(partners.map(entry => entry.actorUUID)).size !== partners.length) return null;

  return Object.freeze({ actorUuid, partners: Object.freeze(partners) });
}

/* -------------------------------------------- */
/*  Refusals and receipts                       */
/* -------------------------------------------- */
/** Promotion refusal reasons displayed by the class-path preview. */
export const PROMOTION_UNAVAILABLE_REASONS = Object.freeze({
  REQUIREMENTS: 'Requirements Not Met',
  NO_ITEM: 'No promotion item set'
});

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */
/** Level splash, stat panel and XP bar timing used by the progression engine, in milliseconds. */
export const PROGRESSION_PRESENTATION_TIMING = Object.freeze({
  splashToPanel: 2100,
  experienceBarCap: 6000
});

/**
 * Promotion flourish timing used by the progression engine: class-swap cover and total duration, in milliseconds.
 * The engine waits on these times rather than on client rendering, which a hidden tab may suspend.
 */
export const PROMOTION_FLOURISH_TIMING = Object.freeze({ burst: 3300, total: 13800 });

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */
export const PROGRESSION_PRESENTATION_KIND = 'progression';
export const PROGRESSION_PRESENTATION_BEATS = Object.freeze({
  EXPERIENCE: 'experience',
  SPLASH: 'splash',
  STATS: 'stats',
  PROMOTION_STATS: 'promotion-stats',
  PROMOTION_FLOURISH: 'promotion-flourish'
});

/** Build the serializable progression overlay message every client renders. */
export function progressionPresentationMessage(beat, data = {}) {
  if (!Object.values(PROGRESSION_PRESENTATION_BEATS).includes(beat)) {
    throw new TypeError(`Unknown progression presentation beat: ${beat}`);
  }
  return Object.freeze({ kind: PROGRESSION_PRESENTATION_KIND, beat, ...structuredClone(data) });
}

/** Accept only a bounded progression overlay message at the presentation socket. */
export function isProgressionPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== PROGRESSION_PRESENTATION_KIND) return false;
  if (!Object.values(PROGRESSION_PRESENTATION_BEATS).includes(value.beat)) return false;
  try { return JSON.stringify(value).length <= 20000; } catch { return false; }
}

/**
 * The message kind for the notice sent to whoever asked for a class change: features gained, replaced, missing or
 * removed.
 */
export const PROGRESSION_FEATURE_NOTICE_KIND = 'progression-feature-notice';

const FEATURE_NOTICE_NAME_LIMIT = 64;

/**
 * Build the serializable class feature notice addressed to the user who asked for the change.
 * @param {{actorName?: string, gained?: string[], replaced?: string[], missing?: object|null,
 *   uniqueRemoved?: object|null}} changes The names each notice line reports.
 * @returns {Readonly<object>} The message.
 */
export function progressionFeatureNoticeMessage({ actorName = '', gained = [], replaced = [], missing = null,
  uniqueRemoved = null } = {}) {
  const names = list => (Array.isArray(list) ? list : []).slice(0, FEATURE_NOTICE_NAME_LIMIT)
    .map(name => String(name ?? ''));
  const group = entry => (entry
    ? Object.freeze({ className: String(entry.className ?? ''), names: names(entry.names) })
    : null);
  return Object.freeze({ kind: PROGRESSION_FEATURE_NOTICE_KIND, actorName: String(actorName ?? ''),
    gained: names(gained), replaced: names(replaced), missing: group(missing), uniqueRemoved: group(uniqueRemoved) });
}

/** Accept only a bounded class feature notice at the presentation socket. */
export function isProgressionFeatureNoticeMessage(value) {
  if (!plainRecord(value) || value.kind !== PROGRESSION_FEATURE_NOTICE_KIND) return false;
  const names = list => Array.isArray(list) && list.length <= FEATURE_NOTICE_NAME_LIMIT
    && list.every(name => typeof name === 'string');
  const group = entry => entry === null
    || (plainRecord(entry) && typeof entry.className === 'string' && names(entry.names));
  if (typeof value.actorName !== 'string' || !names(value.gained) || !names(value.replaced)) return false;
  if (!group(value.missing) || !group(value.uniqueRemoved)) return false;
  try { return JSON.stringify(value).length <= 20000; } catch { return false; }
}
