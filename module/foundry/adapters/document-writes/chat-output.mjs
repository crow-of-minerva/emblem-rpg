/** @layer foundry/adapters/document-writes */
import { resolveAvatarScale, skillRankLabel } from '../../../game/character/rules.mjs';
import { isActiveGm } from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/** How long a card whose creation never finishes holds up the next card before the queue moves on. */
const CARD_ORDER_BOUND_MS = 10000;

/** Foundry's message modes, with the roll-mode names v14 still maps onto them. */
const MESSAGE_MODES = Object.freeze({
  public: 'public', publicroll: 'public', roll: 'public', ic: 'public', ooc: 'public',
  gm: 'gm', gmroll: 'gm', blind: 'blind', blindroll: 'blind', self: 'self', selfroll: 'self'
});

let cardTail = Promise.resolve();

/* -------------------------------------------- */
/*  Chat Output                                 */
/* -------------------------------------------- */

/**
 * Resolve roll-card author and visibility from the requester. Foundry’s default helper uses the creating client,
 * which would attribute a player’s host-posted card and self roll to the GM.
 * @param {{userId?: string, messageMode?: string}} requester The authenticated caller and the mode they rolled in.
 * @param {string[]} gmUserIds Every Gamemaster and Assistant a GM or blind card is whispered to.
 * @returns {{author: string, whisper: string[], blind: boolean}}
 */
function rollCardVisibility({ userId = '', messageMode = 'public' } = {}, gmUserIds = []) {
  const author = String(userId ?? '');
  const mode = MESSAGE_MODES[String(messageMode ?? '')] ?? 'public';
  if (mode === 'self') return { author, whisper: author ? [author] : [], blind: false };
  if (mode === 'gm' || mode === 'blind') {
    const whisper = [...new Set(gmUserIds.map(String))];
    return { author, whisper, blind: mode === 'blind' };
  }
  return { author, whisper: [], blind: false };
}

/**
 * Posts rendered chat cards from the active GM. A roll card carries its dice and plays the dice sound, and other
 * cards have neither. init/system.mjs builds one for general cards and one, with the check service as its roll
 * source, for CharacterCheckChatPresenter's skill and saving-throw cards.
 */
export class FoundryChatOutput {
  constructor(rollSource = null) {
    this.rollSource = rollSource;
  }

  /**
   * Create the ChatMessage after any cards already queued, with the requester's author and visibility. Returns
   * null on any client but the active GM's. `waitForDice` doesn't wait: it only marks a roll card, so the dice
   * sound plays even with no rolls attached. Dice So Nice animates on its own, and the engine clock paces play.
   */
  async create({ actorUuid, content, alias = '', rolls = null, rollReference = '', waitForDice = false, whisper = [],
    requester = null }) {
    if (!isActiveGm()) return null;
    let actor = null;
    try { actor = actorUuid ? await fromUuid(actorUuid) : null; } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'create');
      actor = null;
    }
    const attachedRolls = rolls ?? this.rollSource?.takeRolls(rollReference) ?? [];
    const rollCard = waitForDice || attachedRolls.length > 0;
    const visibility = requesterVisibility(requester);
    const message = await inCardOrder(() => ChatMessage.create({
      speaker: alias ? { alias } : ChatMessage.getSpeaker({ actor }),
      content,
      rolls: [...attachedRolls],
      ...(whisper.length ? { whisper: [...whisper] } : {}),
      ...(visibility ?? {}),
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      ...(rollCard ? { sound: CONFIG.sounds?.dice } : {})
    }));
    return message;
  }
}

/**
 * Resolve requester attribution and whispers for FoundryChatOutput. If the requester is unknown,
 * keep private rolls staff-only and omit the author instead of publishing them to the table.
 */
function requesterVisibility(requester) {
  if (!requester) return null;
  const userId = String(requester.userId ?? '');
  const staff = [...game.users].filter(user => user?.isGM === true).map(user => String(user.id));
  if (!userId || !game.users.get(userId)) {
    const mode = MESSAGE_MODES[String(requester.messageMode ?? '')] ?? 'public';
    if (mode === 'public') return null;
    return { author: '', blind: mode === 'blind', whisper: [...new Set(staff)] };
  }
  const { author, whisper, blind } = rollCardVisibility(requester, staff);
  return { author, blind, ...(whisper.length ? { whisper: [...whisper] } : {}) };
}

/** Create cards one after another in the order they were asked for, so no card overtakes an earlier one. */
function inCardOrder(work) {
  const created = cardTail.then(work);
  let timer = null;
  const bound = new Promise(resolve => { timer = setTimeout(resolve, CARD_ORDER_BOUND_MS); });
  cardTail = Promise.race([created.then(() => null, () => null), bound]).finally(() => clearTimeout(timer));
  return created;
}

/* -------------------------------------------- */
/*  Progression chat output                     */
/* -------------------------------------------- */
/**
 * Posts progression chat cards, with no dice sound, for ProgressionPresentation
 * (presentation/graphics/progression.mjs).
 */
export class FoundryProgressionChatOutput {
  constructor({ renderSkillRankUp = null } = {}) {
    this.renderSkillRankUp = renderSkillRankUp;
  }

  async create({ actorUuid, content, alias = '' }) {
    if (!isActiveGm()) return null;
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    return inCardOrder(() => ChatMessage.create({
      speaker: alias ? { alias } : ChatMessage.getSpeaker({ actor }),
      content,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER
    }));
  }

  /** Announce a skill rank climbed by use, projecting the portrait and die labels the card renderer draws. */
  async createSkillRankUp({ actorUuid, actorName, skillKey, skillLabel, total, ranksGained }) {
    if (typeof this.renderSkillRankUp !== 'function') return null;
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    const climbed = Math.max(1, Math.floor(Number(ranksGained) || 1));
    return this.create({
      actorUuid,
      alias: String(actorName ?? actor?.name ?? ''),
      content: this.renderSkillRankUp({
        actorName: String(actorName ?? actor?.name ?? ''),
        actorImage: String(actor?.img ?? ''),
        avatarScale: resolveAvatarScale(actor?.system?.art?.avatarScale),
        skillKey,
        skillLabel,
        previousDie: skillRankLabel((Number(total) || 0) - climbed),
        newDie: skillRankLabel(total)
      })
    });
  }
}
