/** @layer foundry/adapters/document-writes */
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { resolveActor, resolveDocument } from '../services/host.mjs';

/* -------------------------------------------- */
/*  Journal access                              */
/* -------------------------------------------- */
const JOURNAL_DOCUMENT_TYPES = new Set(['JournalEntry', 'JournalEntryPage']);

/**
 * Reads who may see a journal entry a unit links, and grants Observer on it. Used by the grantJournalAccess
 * command in engine/character/commands.mjs.
 */
export class FoundryJournalRepository {
  /**
   * Facts about the journal entry a request names (a page counts as its parent entry): whether the unit links the
   * entry or one of its pages, each owner of the unit with their current level on the entry, and whether the
   * requester can already read it. null if the actor or entry can't be found.
   */
  async getAccessSnapshot(actorUuid, journalUuid, requesterId = '') {
    const [actor, document] = await Promise.all([
      resolveActor(String(actorUuid ?? '')),
      resolveDocument(String(journalUuid ?? ''))
    ]);
    const journal = journalEntryOf(document);
    if (!actor || !journal) return null;
    const observerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    const entryUuid = String(journal.uuid);
    const links = Array.isArray(actor.system?.knowledge?.journals) ? actor.system.knowledge.journals.map(String) : [];
    const requester = game.users.get(String(requesterId ?? '')) ?? null;
    const owners = [];
    for (const user of collectionValues(game.users)) {
      const level = Number(actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0);
      if (level < ownerLevel) continue;
      owners.push(Object.freeze({
        userId: String(user.id),
        isGM: user.isGM === true,
        level: Number(journal.ownership?.[user.id] ?? -1)
      }));
    }
    return Object.freeze({
      actorUuid: String(actor.uuid),
      actorName: String(actor.name ?? ''),
      journalUuid: entryUuid,
      journalName: String(journal.name ?? ''),
      observerLevel,
      linked: links.some(link => link === entryUuid || link.startsWith(`${entryUuid}.`)),
      requesterCanObserve: Boolean(requester) && journal.testUserPermission?.(requester, observerLevel) === true,
      owners: Object.freeze(owners)
    });
  }

  /** Raise the named users to Observer on the entry. Nothing is written when the list is empty. */
  async grantObserver(snapshot, userIds) {
    const ids = (userIds ?? []).map(String).filter(Boolean);
    if (!ids.length) return Object.freeze({ ok: true, changed: false });
    const journal = journalEntryOf(await resolveDocument(snapshot.journalUuid));
    if (!journal) return Object.freeze({ ok: false, changed: false });
    const ownership = Object.fromEntries(ids.map(id => [id, snapshot.observerLevel]));
    await journal.update({ ownership });
    return Object.freeze({ ok: true, changed: true });
  }
}

function journalEntryOf(document) {
  if (!document || !JOURNAL_DOCUMENT_TYPES.has(document.documentName)) return null;
  const journal = document.documentName === 'JournalEntryPage' ? document.parent : document;
  return journal?.documentName === 'JournalEntry' ? journal : null;
}
