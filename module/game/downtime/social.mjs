/** @layer game/downtime */
import { PROFICIENCIES } from '../../contracts/domains/characters.mjs';
import { DOWNTIME_LANES } from '../../contracts/domains/downtime.mjs';
import { PROFICIENCY_RANK_LETTERS, WEAPON_PROFICIENCIES } from '../../contracts/domains/items.mjs';
import { RESULT_CODES, refuse } from '../../contracts/results.mjs';
import { statBonus } from '../character/rules.mjs';
import { computeSparExperience, scaleCharacterExperience } from '../progression/rules.mjs';
import { resolveParticipants } from './rules.mjs';

/* -------------------------------------------- */
/*  Rewards                                     */
/* -------------------------------------------- */
/** Support experience a conversation banks: both units' Sociability totals added together, a negative one as 0. */
export function socialSupportExperience(firstTotal, secondTotal) {
  return wholeNumber(firstTotal) + wholeNumber(secondTotal);
}

/** Proficiency experience the trainee earns before its multiplier: the trainer's whole Command total. */
export function trainingProficiencyExperience(total) {
  return wholeNumber(total);
}

/**
 * The level experience each side of a training session would earn, for the social menu's preview. It is scaled
 * as engine/character/progression.mjs will scale it: by the unit's own experience multiplier and the world's.
 * @param {object} entry An eligibleTraining row, whose trainer and trainee carry `level` and `experienceMultiplier`.
 * @param {number} worldExperienceMultiplier The world's experience multiplier setting.
 * @returns {Readonly<{trainer: number, trainee: number}>}
 */
export function trainingRewardPreview(entry, worldExperienceMultiplier = 1) {
  const raw = sparExperience(entry?.trainer, entry?.trainee);
  return Object.freeze({
    trainer: scaleCharacterExperience(raw.trainer, entry?.trainer?.experienceMultiplier, worldExperienceMultiplier),
    trainee: scaleCharacterExperience(raw.trainee, entry?.trainee?.experienceMultiplier, worldExperienceMultiplier)
  });
}

/* -------------------------------------------- */
/*  Training direction                          */
/* -------------------------------------------- */
/** How the social menu and the training card print a proficiency total: -- untrained, else its rank letter. */
function proficiencyRankLabel(total) {
  const rank = proficiencyTotal({ total });
  if (rank < 1) return '--';
  return PROFICIENCY_RANK_LETTERS[Math.min(PROFICIENCY_RANK_LETTERS.length, rank) - 1];
}

/**
 * Decide who teaches whom in one proficiency. The higher total teaches. A tie goes to the better instructor by
 * Charisma bonus (the Command skill's stat), and a second tie to `first`, which callers pass as the visited unit.
 * @param {object} first The visited unit, a downtime roster entry carrying `proficiencies` and `attributes`.
 * @param {object} second The acting unit.
 * @param {string} key A weapon proficiency key.
 * @returns {?{trainer: object, trainee: object, trainerRank: number, traineeRank: number, equal: boolean}}
 *   Null when neither unit holds the proficiency.
 */
function trainingDirection(first, second, key) {
  const firstRank = proficiencyTotal(first?.proficiencies?.[key]);
  const secondRank = proficiencyTotal(second?.proficiencies?.[key]);
  if (firstRank < 1 && secondRank < 1) return null;
  const equal = firstRank === secondRank;
  const secondTeaches = secondRank > firstRank
    || (equal && statBonus(second?.attributes?.cha) > statBonus(first?.attributes?.cha));
  return secondTeaches
    ? { trainer: second, trainee: first, trainerRank: secondRank, traineeRank: firstRank, equal }
    : { trainer: first, trainee: second, trainerRank: firstRank, traineeRank: secondRank, equal };
}

/**
 * Every weapon proficiency the pair can train, in WEAPON_PROFICIENCIES order, with its direction resolved and
 * labelled for the social menu. `first` is the visited unit, as in trainingDirection.
 */
export function eligibleTraining(first, second) {
  const rows = [];
  for (const key of WEAPON_PROFICIENCIES) {
    const direction = trainingDirection(first, second, key);
    if (!direction) continue;
    const vocabulary = PROFICIENCIES.find(entry => entry.key === key);
    rows.push(Object.freeze({
      key,
      label: vocabulary?.label ?? key,
      icon: vocabulary?.icon ?? '',
      ...direction,
      trainerRankLabel: proficiencyRankLabel(direction.trainerRank),
      traineeRankLabel: proficiencyRankLabel(direction.traineeRank)
    }));
  }
  return Object.freeze(rows);
}

/* -------------------------------------------- */
/*  Plans                                       */
/* -------------------------------------------- */
/**
 * Validate a socialize before anything is rolled or written. The pair is the acting unit and the unit it visited.
 * Both must be distinct units of the same party standing adjacent in free exploration, and both must still have
 * their Downtime Action. The partner's owner is never asked.
 * @param {object} snapshot `exploring`, the acting unit (`cursor`), `partner`, `inReach` and `roster` (downtime
 *   units carrying `partyId`, `level`, `experienceMultiplier` and `proficiencies`).
 * @returns {Readonly<object>} A refusal, or `{ok: true, code, data}` with `{cursor, partner}` also under `plan`.
 */
export function planSocialize(snapshot = {}) {
  const pair = resolvePair(snapshot);
  if (!pair.ok) return pair;
  const plan = Object.freeze({ cursor: pair.cursor, partner: pair.partner });
  return Object.freeze({ ok: true, code: RESULT_CODES.DOWNTIME_SOCIALIZED, data: plan, plan });
}

/**
 * Validate a training session: the pair checks of planSocialize, then the chosen proficiency must be one the pair
 * can train. The plan names the direction, both labelled ranks and the raw spar experience each side earns before
 * multipliers.
 * @param {object} snapshot As planSocialize.
 * @param {object} intent A normalizeTrainingIntent result.
 * @returns {Readonly<object>} A refusal, or `{ok: true, code, data}` with the plan also under `plan`.
 */
export function planTraining(snapshot = {}, intent = {}) {
  const pair = resolvePair(snapshot);
  if (!pair.ok) return pair;
  const { cursor, partner } = pair;
  const entry = eligibleTraining(partner, cursor).find(row => row.key === intent?.proficiencyKey) ?? null;
  if (!entry) {
    return refuse(RESULT_CODES.DOWNTIME_PROFICIENCY_INVALID, { actorName: cursor.name, partnerName: partner.name });
  }
  const plan = Object.freeze({
    cursor,
    partner,
    trainer: entry.trainer,
    trainee: entry.trainee,
    key: entry.key,
    label: entry.label,
    icon: entry.icon,
    trainerRank: entry.trainerRank,
    traineeRank: entry.traineeRank,
    trainerRankLabel: entry.trainerRankLabel,
    traineeRankLabel: entry.traineeRankLabel,
    equal: entry.equal,
    levelExperience: sparExperience(entry.trainer, entry.trainee)
  });
  return Object.freeze({ ok: true, code: RESULT_CODES.DOWNTIME_TRAINED, data: plan, plan });
}

/**
 * Why a unit cannot spend its Downtime Action, or empty when it can. Ownership is not checked: the command already
 * checks the acting unit's Token, and the partner may belong to another player.
 */
export function actionLaneBlock(unit) {
  const [row] = resolveParticipants([{ ...unit, owned: true }], { lane: DOWNTIME_LANES.ACTION });
  return row?.blocked ?? '';
}

/**
 * The checks both plans share, in the order the social menu reports them: exploration, the acting unit and the
 * partner in the roster, self-pairing, the pair's shared party, adjacency, then whether each unit still has its
 * Downtime Action. A unit in no party pairs with nobody, and two units pair only inside the same party.
 */
function resolvePair(snapshot) {
  if (snapshot?.exploring !== true) return refuse(RESULT_CODES.DOWNTIME_EXPLORATION_REQUIRED);
  const roster = Array.isArray(snapshot.roster) ? snapshot.roster : [];
  const cursor = roster.find(entry => entry.actorUuid === snapshot.cursor?.actorUuid) ?? null;
  const partnerName = String(snapshot.partner?.name ?? '');
  if (!cursor) {
    return refuse(RESULT_CODES.DOWNTIME_UNAVAILABLE,
      { pair: true, actorName: String(snapshot.cursor?.name ?? ''), partnerName });
  }
  const partner = roster.find(entry => entry.actorUuid === snapshot.partner?.actorUuid) ?? null;
  if (!partner) return refuse(RESULT_CODES.DOWNTIME_PARTNER_OUTSIDE_ROSTER, { partnerName });
  if (cursor.actorUuid === partner.actorUuid) return refuse(RESULT_CODES.DOWNTIME_SELF_PAIRING);
  if (!cursor.partyId || cursor.partyId !== partner.partyId) {
    return refuse(RESULT_CODES.DOWNTIME_PARTNER_OUTSIDE_ROSTER, { partnerName: partner.name });
  }
  if (snapshot.inReach !== true) {
    return refuse(RESULT_CODES.DOWNTIME_OUT_OF_REACH, { actorName: cursor.name, partnerName: partner.name });
  }
  const cursorBlock = actionLaneBlock(cursor);
  if (cursorBlock) {
    return refuse(RESULT_CODES.DOWNTIME_PERFORMER_INELIGIBLE, { actorName: cursor.name, blocked: cursorBlock });
  }
  const partnerBlock = actionLaneBlock(partner);
  if (partnerBlock) {
    return refuse(RESULT_CODES.DOWNTIME_PARTNER_INELIGIBLE, { partnerName: partner.name, blocked: partnerBlock });
  }
  return { ok: true, cursor, partner };
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
function sparExperience(trainer, trainee) {
  const trainerLevel = unitLevel(trainer);
  const traineeLevel = unitLevel(trainee);
  return Object.freeze({
    trainer: computeSparExperience(trainerLevel, traineeLevel),
    trainee: computeSparExperience(traineeLevel, trainerLevel)
  });
}

function unitLevel(unit) {
  return Math.max(1, Math.floor(Number(unit?.level)) || 1);
}

function proficiencyTotal(proficiency) {
  return wholeNumber(proficiency?.total);
}

function wholeNumber(value) {
  return Math.max(0, Math.floor(Number(value)) || 0);
}
