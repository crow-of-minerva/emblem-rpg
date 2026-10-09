/** @layer game/support */
import { RALLY_ITEM_NAME, RALLY_TARGET_LIMITS } from '../../contracts/domains/progression.mjs';
import { RALLY_RANGE_SCALING, rallyAbilityData } from '../../config/rally.mjs';
import { capitalize, escapeHtml } from '../../lib/dom/html.mjs';
import { AFFINITY_TIERS, affinityAdjective, affinityLabel, affinityStatLabel, affinityStats } from './affinities.mjs';
import { formatRallyStatValue } from './rules.mjs';

/* -------------------------------------------- */
/*  Rally Ability                               */
/* -------------------------------------------- */

/** The word a Rally's description uses for an affinity the table gives no adjective, or for a unit with none. */
const FALLBACK_ADJECTIVE = 'supportive';

/**
 * The Rally Ability a unit with this affinity is granted. getInnateGrantSnapshot
 * (foundry/adapters/document-writes/characters.mjs) builds each unit's copy here for the innate grant in
 * game/character/innate-grants.mjs, so a unit whose affinity changes has its Rally renamed and rewritten on its
 * next sync. The Ability is named for the affinity, and its description lists every stat it moves at every tier.
 * @param {{table: object, affinity: string}} input The affinity table in force and the unit's affinity.
 * @returns {object} Item creation data for the Ability.
 */
export function buildRallyAbility({ table, affinity }) {
  const data = rallyAbilityData();
  data.name = rallyAbilityName({ table, affinity });
  data.system.description = rallyDescription(table, affinity, affinityStats(table, affinity));
  return data;
}

/**
 * The name buildRallyAbility gives a unit's Rally: "Rally: <Affinity>", or plain "Rally" for an affinity the table
 * doesn't list. The innate grant compares a held Rally's name with it to decide whether the unit needs a sync.
 */
export function rallyAbilityName({ table, affinity }) {
  return affinityStats(table, affinity) ? `${RALLY_ITEM_NAME}: ${affinityLabel(table, affinity)}` : RALLY_ITEM_NAME;
}

/** Whether an Ability's name marks it as a Rally, bare or named for an affinity, so the innate grant adopts it. */
export function isRallyAbilityName(name) {
  const text = String(name ?? '').trim();
  return text === RALLY_ITEM_NAME || text.startsWith(`${RALLY_ITEM_NAME}:`);
}

/* -------------------------------------------- */
/*  Description                                 */
/* -------------------------------------------- */

/** The description's three paragraphs: the flavor line, the stats by tier, then range and per-unit limits. */
function rallyDescription(table, affinity, stats) {
  const adjective = (stats && affinityAdjective(table, affinity)) || FALLBACK_ADJECTIVE;
  const flavor = `<i>You rally your allies with ${article(adjective)} ${escapeHtml(adjective)} stratagem.</i>`;
  const lead = 'Selected units within range of you gain modifiers to the stats associated with your Affinity '
    + 'for 1 round';
  const rows = Object.entries(stats ?? {}).map(([key, byTier]) => statRow(table, key, byTier));
  const effect = rows.length ? `${lead}:<br>${rows.join('<br>')}` : `${lead}.`;
  return [flavor, effect, `${rangeSentence()} ${limitSentence()}`].join('<br><br>');
}

/** One stat's line: its direction and label, then its value at every tier, as "+Mov ( None: +1, E: +2, ... )". */
function statRow(table, key, byTier) {
  const penalty = Number(byTier.find(value => value !== 0)) < 0;
  const values = AFFINITY_TIERS.map((tier, index) => `${tier}: ${formatRallyStatValue(key, byTier[index] ?? 0)}`);
  return `${penalty ? '-' : '+'}${escapeHtml(affinityStatLabel(table, key))} ( ${values.join(', ')} )`;
}

/** How far Rally reaches at its best, from the range scaling config/rally.mjs gives the Ability. */
function rangeSentence() {
  const top = RALLY_RANGE_SCALING.thresholds.at(-1);
  const stat = capitalize(RALLY_RANGE_SCALING.subject);
  return `This ability's Rng scales with the unit's ${stat} (max ${top.uses} Rng at ${top.at} ${stat}).`;
}

/** The tiers at which RALLY_TARGET_LIMITS lets a caster Rally the same unit more often, in one sentence. */
function limitSentence() {
  const base = RALLY_TARGET_LIMITS[AFFINITY_TIERS[0]] ?? 1;
  const raises = [];
  let previous = base;
  for (const tier of AFFINITY_TIERS.slice(1)) {
    const limit = RALLY_TARGET_LIMITS[tier] ?? previous;
    if (limit > previous) raises.push({ tier, limit });
    previous = limit;
  }
  if (!raises.length) return `It may affect the same unit ${times(base)} per map.`;
  const [first, ...rest] = raises;
  const more = rest.map(raise => `, and ${times(raise.limit)} at ${raise.tier} rank`).join('');
  return `It may affect the same unit ${times(first.limit)} per map at ${first.tier} rank Support${more}.`;
}

function times(count) {
  if (count === 1) return 'once';
  return count === 2 ? 'twice' : `${count} times`;
}

function article(word) {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}
