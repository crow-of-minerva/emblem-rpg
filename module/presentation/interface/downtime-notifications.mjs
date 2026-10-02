/** @layer presentation/interface */
import { REQUISITION_KIND_LABELS } from '../../contracts/domains/downtime.mjs';
import { NOTIFICATION_IDS } from './notification-ids.mjs';

/* -------------------------------------------- */
/*  Downtime notification text                  */
/* -------------------------------------------- */
/**
 * The text and level of every downtime notice: gathering, the workshop, the laboratory, cooking, performances,
 * requisitions, socializing and training, and the GM's Reset Downtime. notification-catalog.mjs spreads these
 * into NOTIFICATIONS, where NotificationService (notifications.mjs) looks each one up by id.
 */
export const DOWNTIME_NOTIFICATIONS = Object.freeze({
  [NOTIFICATION_IDS.DOWNTIME_GATHERED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_FORGED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_BREWED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_INPUT_INVALID]: { level: 'warn', text: () => 'That downtime request could not be read.' },
  [NOTIFICATION_IDS.DOWNTIME_UNAVAILABLE]: {
    level: 'warn',
    /** A socialize or training pair's refusal sets `pair`, and names both units that are still there. */
    text: data => {
      if (data.pair !== true) return 'There is no station to work here.';
      const names = [data.actorName, data.partnerName].filter(Boolean);
      if (names.length === 1) return `${names[0]} cannot take part in downtime right now.`;
      return `${names.join(' and ') || 'These units'} cannot spend downtime together right now.`;
    }
  },
  [NOTIFICATION_IDS.DOWNTIME_STATION_INVALID]: { level: 'warn', text: () => 'That is not a station this activity is worked at.' },
  [NOTIFICATION_IDS.DOWNTIME_OUT_OF_REACH]: {
    level: 'warn',
    text: data => (data.partnerName
      ? `${data.actorName || 'This unit'} is not standing beside ${data.partnerName}.`
      : `${data.actorName ?? 'This unit'} is not standing at that station.`)
  },
  [NOTIFICATION_IDS.DOWNTIME_SUBJECT_OUT_OF_REACH]: {
    level: 'warn', text: () => 'That item is not in this unit’s pack or the party Convoy.'
  },
  [NOTIFICATION_IDS.DOWNTIME_SUBJECT_INVALID]: {
    level: 'warn', text: data => `${data.itemName ?? 'That item'} is not something this station works on.`
  },
  [NOTIFICATION_IDS.DOWNTIME_NOTHING_TO_RESTORE]: {
    level: 'warn', text: data => `${data.itemName ?? 'That item'} is at full Durability.`
  },
  [NOTIFICATION_IDS.DOWNTIME_MATERIALS_SHORT]: {
    level: 'warn', text: data => `Not enough ${data.materials ?? 'Materials'}.`
  },
  [NOTIFICATION_IDS.DOWNTIME_RECIPE_UNKNOWN]: {
    level: 'warn',
    text: data => (data.performerName ? `${data.performerName} does not know that recipe.` : 'That is not a recipe this world offers.')
  },
  [NOTIFICATION_IDS.DOWNTIME_COOKED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_ALREADY_FED]: {
    level: 'warn', text: data => `${data.actorName ?? 'That unit'} is already fed${data.mealName ? ` (${data.mealName})` : ''}.`
  },
  [NOTIFICATION_IDS.DOWNTIME_DINER_OUTSIDE_ROSTER]: {
    level: 'warn', text: () => 'A chosen diner is not part of this downtime.'
  },
  [NOTIFICATION_IDS.DOWNTIME_SPECIAL_INVALID]: {
    level: 'warn', text: data => `${data.itemName ?? 'That ingredient'} is not a food this chef can add to the pot.`
  },
  [NOTIFICATION_IDS.DOWNTIME_RECIPE_LIBRARY_SAVED]: {
    level: 'info', text: data => `Recipe Library saved: ${Number(data.count) || 0} recipe${Number(data.count) === 1 ? '' : 's'}.`
  },
  [NOTIFICATION_IDS.DOWNTIME_RECIPE_LIBRARY_REPAIRED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_PERFORMED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_ALREADY_INSPIRED]: {
    level: 'warn',
    text: data => `${data.actorName ?? 'That unit'} is `
      + `${data.performanceMark === 'Uninspired' ? 'Uninspired' : 'already inspired'}`
      + ' and cannot take part in another performance until the party rests.'
  },
  [NOTIFICATION_IDS.DOWNTIME_SONG_UNKNOWN]: {
    level: 'warn',
    text: data => (data.performerName
      ? `${data.performerName} does not know that song.` : 'That is not a song this world offers.')
  },
  [NOTIFICATION_IDS.DOWNTIME_ACCOMPANIMENT_INVALID]: { level: 'warn', text: accompanimentInvalidText },
  [NOTIFICATION_IDS.DOWNTIME_ACCOMPANIMENT_COUNT]: {
    level: 'warn',
    text: data => {
      const required = Number(data.required) || 0;
      return `${data.songName || 'That song'} needs ${required} accompaniment${required === 1 ? '' : 's'}, but `
        + `${Number(data.given) || 0} ${Number(data.given) === 1 ? 'was' : 'were'} chosen.`;
    }
  },
  [NOTIFICATION_IDS.DOWNTIME_SONG_LIBRARY_SAVED]: {
    level: 'info',
    text: data => `Song Library saved: ${Number(data.count) || 0} song${Number(data.count) === 1 ? '' : 's'}.`
  },
  [NOTIFICATION_IDS.DOWNTIME_SONG_LIBRARY_REPAIRED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_REQUISITIONED]: {
    level: 'info',
    text: data => `${data.performerName || 'The requisitioner'}: ${data.summary || 'requisition settled.'}`
  },
  [NOTIFICATION_IDS.DOWNTIME_FACTION_UNKNOWN]: { level: 'warn', text: () => 'That faction cannot be asked here.' },
  [NOTIFICATION_IDS.DOWNTIME_FACTION_LOCKED]: {
    level: 'warn', text: data => `${data.factionName || 'That faction'} was already requisitioned this downtime.`
  },
  [NOTIFICATION_IDS.DOWNTIME_DEMAND_INVALID]: {
    level: 'warn',
    text: data => `Ask for a multiple of ${Number(data.step) || 100} GP, up to ${Number(data.cap) || 0} GP.`
  },
  [NOTIFICATION_IDS.DOWNTIME_KIND_UNAVAILABLE]: {
    level: 'warn', text: data => `${REQUISITION_KIND_LABELS[data.kind] ?? 'Those'} requests are not yet available.`
  },
  [NOTIFICATION_IDS.DOWNTIME_CONVOY_REQUIRED]: {
    level: 'warn', text: data => `${data.performerName || 'That unit'} has no Convoy linked to receive the gold.`
  },
  [NOTIFICATION_IDS.DOWNTIME_UNIT_MISSING]: {
    level: 'warn', text: () => 'That unit is no longer on this map.'
  },
  [NOTIFICATION_IDS.DOWNTIME_ACTIVITY_RESET]: {
    level: 'info', text: data => `${data.actorName ?? 'That unit'} can take a downtime activity again.`
  },
  [NOTIFICATION_IDS.DOWNTIME_NOTHING_TO_RESET]: {
    level: 'warn', text: data => `${data.actorName ?? 'That unit'} has not spent any downtime yet.`
  },
  [NOTIFICATION_IDS.DOWNTIME_ENERGY_RESTORED]: {
    level: 'info',
    text: data => `${data.actorName ?? 'That unit'} recovers ${Number(data.restored) || 0} Energy`
      + ` (${Number(data.energy) || 0} / ${Number(data.energyMax) || 0}).`
  },
  [NOTIFICATION_IDS.DOWNTIME_ENERGY_NOT_RESTORABLE]: {
    level: 'warn',
    text: data => `${data.actorName ?? 'That unit'} has no spent Energy to recover.`
  },
  [NOTIFICATION_IDS.DOWNTIME_RESET_DONE]: {
    level: 'info',
    text: data => `Downtime reset: ${counted(data.units, 'unit')} refreshed, ${counted(data.buffs, 'buff')} cleared, `
      + `${counted(data.stations, 'station')} unlocked`
      + `${Number(data.haggles) > 0 ? `, ${counted(data.haggles, 'haggle')} cleared` : ''}.`
  },
  [NOTIFICATION_IDS.DOWNTIME_NO_ROOM]: {
    level: 'warn', text: data => `${data.performerName ?? 'That unit'} has no room for ${data.itemName ?? 'the product'} and no Convoy to send it to.`
  },
  [NOTIFICATION_IDS.DOWNTIME_NODE_EXHAUSTED]: {
    level: 'warn', text: data => `${data.stationName ?? 'This node'} is exhausted.`
  },
  [NOTIFICATION_IDS.DOWNTIME_PERFORMER_OUTSIDE_ROSTER]: {
    level: 'warn', text: () => 'That unit is not part of this downtime.'
  },
  [NOTIFICATION_IDS.DOWNTIME_PERFORMER_INELIGIBLE]: {
    level: 'warn',
    text: data => `${data.performerName || data.actorName || 'That unit'} cannot take part: `
      + `${data.blocked || 'ineligible'}.`
  },
  [NOTIFICATION_IDS.DOWNTIME_SETTLEMENT_FAILED]: {
    backend: 'foundry/adapters/document-writes/downtime.mjs', level: 'error',
    text: () => 'The work did not go through. Try again.'
  },
  [NOTIFICATION_IDS.DOWNTIME_ACTIVITY_FAILED]: {
    backend: 'engine/downtime/commands.mjs', level: 'error', text: () => 'The work stopped part-way.'
  },
  [NOTIFICATION_IDS.DOWNTIME_STALE]: {
    level: 'warn', text: () => 'The party changed while that was being prepared, so nothing was spent. Try again.'
  },
  [NOTIFICATION_IDS.DOWNTIME_SOCIALIZED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_TRAINED]: { silent: true, text: () => '' },
  [NOTIFICATION_IDS.DOWNTIME_EXPLORATION_REQUIRED]: {
    level: 'warn', text: () => 'Downtime activities happen in free exploration.'
  },
  [NOTIFICATION_IDS.DOWNTIME_PARTNER_OUTSIDE_ROSTER]: {
    level: 'warn', text: data => `${data.partnerName || 'That unit'} is not in this party.`
  },
  [NOTIFICATION_IDS.DOWNTIME_PARTNER_INELIGIBLE]: {
    level: 'warn', text: data => `${data.partnerName || 'That unit'}: ${data.blocked || 'ineligible'}.`
  },
  [NOTIFICATION_IDS.DOWNTIME_SELF_PAIRING]: { level: 'warn', text: () => 'A unit cannot pair with itself.' },
  [NOTIFICATION_IDS.DOWNTIME_PROFICIENCY_INVALID]: {
    level: 'warn', text: () => 'These two cannot train that proficiency.'
  }
});

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */
/** Why a chosen accompaniment was refused: the lead itself, a unit picked twice, or one outside this downtime. */
function accompanimentInvalidText(data = {}) {
  const name = data.actorName || 'That unit';
  if (data.reason === 'lead') return 'The lead performer cannot also accompany the song.';
  if (data.reason === 'duplicate') return `${name} was chosen to accompany twice.`;
  return 'A chosen accompaniment is not part of this downtime.';
}

/**
 * A whole count with its noun, pluralised: "1 unit", "3 buffs". notification-catalog.mjs counts the Convoy
 * delivery's items with it too.
 */
export function counted(count, noun) {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
