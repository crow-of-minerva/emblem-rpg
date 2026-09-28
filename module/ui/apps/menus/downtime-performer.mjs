/** @layer ui/apps/menus */

/* -------------------------------------------- */
/*  Performer choice                            */
/* -------------------------------------------- */

/**
 * Which unit performs a downtime action in the gathering, cooking, crafting, performance and requisition menus: the
 * explicit pick while it is still eligible, else the unit that walked up to the station, else anyone who can.
 * @param {{performers?: object[]}} view A downtime view from api.downtime.inspect*, or any object with a
 *   `performers` list (the performance and requisition menus pass their own list with stricter eligibility).
 * @param {string|null} performerUuid The Actor the user picked, or null for the default.
 * @returns {object|null} The chosen performer entry.
 */
export function resolvePerformer(view, performerUuid) {
  const performers = view.performers ?? [];
  const chosen = performers.find(entry => entry.actorUuid === performerUuid && entry.eligible);
  if (chosen) return chosen;
  return performers.find(entry => entry.isCursor && entry.eligible) ?? performers.find(entry => entry.eligible) ?? null;
}

/** List the entries a player can pick ahead of the blocked ones, keeping each group's order. */
export function pickableFirst(entries, pickable) {
  return [...entries.filter(entry => pickable(entry)), ...entries.filter(entry => !pickable(entry))];
}

/** The Actor uuid a freshly opened menu starts with, or null when nobody at the station can perform. */
export function defaultPerformer(view) {
  return resolvePerformer(view, null)?.actorUuid ?? null;
}
