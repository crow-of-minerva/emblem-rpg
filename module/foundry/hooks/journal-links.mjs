/** @layer foundry/hooks */

/* -------------------------------------------- */
/*  Journal rename input                        */
/* -------------------------------------------- */
/** Whether a Character's linked journals name a document or anything under it. */
function characterLinksJournal(actor, uuid) {
  return actor.system.knowledge.journals.some(entry => entry === uuid || String(entry ?? '').startsWith(`${uuid}.`));
}

/** Re-render every open Character sheet whose Notes tab names a renamed journal entry or page. */
export function onLinkedJournalRenamed(document, changes) {
  if (!('name' in changes)) return;
  const uuid = String(document.uuid ?? '');
  if (!uuid) return;
  const open = [
    ...foundry.applications.instances.values(),
    ...Object.values(ui.windows)
  ];
  for (const app of open) {
    const actor = app?.document;
    if (actor?.documentName !== 'Actor' || actor.type !== 'Character') continue;
    if (characterLinksJournal(actor, uuid)) app.render(false);
  }
}
