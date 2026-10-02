/** @layer foundry/adapters/recovery */
import { RESTORE_WRITE_OPTION } from '../../../contracts/domains/recovery.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { isPlainObject, structurallyEqual } from '../../../lib/core/runtime.mjs';
import { clone, forcedDeletion, forcedReplacement, readSetting, resolveDocument } from '../services/host.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/** Source keys no capture records: Foundry owns the identity, and the stats block follows every write. */
const SKIPPED_KEYS = new Set(['_id', '_stats']);

/**
 * Documents whose flags also hold other modules' data. Only this system's scope is captured, since gameplay writes
 * no other.
 */
const NARROWED_FLAGS = new Set(['Actor', 'ActorDelta']);

/** The only source root Foundry stores as free-form data rather than as declared schema fields. */
const FREE_FORM_ROOT = 'flags';

/** The source root holding a document's map of user ids to ownership levels, which Foundry validates whole. */
const OWNERSHIP_ROOT = 'ownership';

/* -------------------------------------------- */
/*  Snapshots                                   */
/* -------------------------------------------- */

/**
 * Read live documents and settings into the serializable entries of an operation record, and apply a record back.
 *
 * OperationRecovery (engine/recovery/operations.mjs) is the only caller. It merges what `capture` returns into the
 * record FoundryOperationStore keeps, and hands the whole record to `restore` when the operation failed or a startup
 * found it.
 */
export class FoundryDocumentSnapshots {
  /**
   * The current saved values of everything one capture call names.
   * @param {object} request Documents (`Document` or `{document, paths}`), documents being deleted, reserved
   *   creations (`{parent, documentName, ids, pack}`) and world-setting keys.
   * @returns {Promise<object>} Record entries, ready to merge.
   */
  async capture({ documents = [], deleting = [], creating = [], settings = [] } = {}) {
    return {
      documents: documents.map(entry => captureDocument(entry)).filter(Boolean),
      deleted: deleting.map(document => captureDeletion(document)).filter(Boolean),
      created: creating.flatMap(entry => captureCreation(entry)),
      settings: settings.map(key => captureSetting(key)).filter(Boolean)
    };
  }

  /**
   * Put a record's entries back, in the only order that works: recreate deleted documents parents first, restore
   * fields, remove created documents children first, then restore settings.
   *
   * Each entry is attempted once and then checked against the world, because Foundry refuses a write without
   * throwing: a `preUpdate`, `preCreate` or `preDelete` veto, or a validation error, makes `ClientDatabaseBackend`
   * drop the entry and hand the caller the empty remainder. An entry counts as resolved only when the protected
   * paths hold their captured values, a recreated document resolves at its uuid and a removed one no longer does.
   * Nothing is retried. An entry that failed either check is collected, so the rest still run and the caller
   * reports it once.
   * @param {object} record The record as it stands, in state `restoring`.
   * @returns {Promise<Array<{key: string, reason: string}>>} Everything left unresolved.
   */
  async restore(record) {
    const unresolved = [];
    for (const entry of [...(record?.deleted ?? [])].sort(byParentDepth)) await recreate(entry, unresolved);
    for (const entry of record?.documents ?? []) await restoreFields(entry, unresolved);
    for (const entry of [...(record?.created ?? [])].sort(byParentDepth).reverse()) await remove(entry, unresolved);
    for (const entry of record?.settings ?? []) await restoreSetting(entry, unresolved);
    return unresolved;
  }
}

/* -------------------------------------------- */
/*  Capture                                     */
/* -------------------------------------------- */

/** One update target's persisted values, keyed by the paths the writer protected. */
function captureDocument(entry) {
  const document = captureTarget(entry?.document ?? entry);
  const source = document?._source;
  if (!source) return null;
  const explicit = [...(entry?.paths ?? [])].map(String).filter(Boolean);
  if (!explicit.length && document.documentName === 'Scene') {
    throw new Error('A Scene capture must name the paths it protects.');
  }
  const fields = {};
  const absent = [];
  for (const path of explicit.length ? explicit : defaultPaths(document, source)) {
    const value = readPath(source, path);
    if (value === undefined) absent.push(path);
    else fields[path] = clone(value);
  }
  return { uuid: String(document.uuid), fields, absent };
}

/**
 * A synthetic Actor is persisted as its Token's ActorDelta, never as the prepared data the Token shows, so the
 * delta is what is captured and what a restore writes.
 */
function captureTarget(document) {
  if (document?.documentName !== 'Actor' || document.isToken !== true) return document;
  return document.parent?.delta ?? document.token?.delta ?? document;
}

/** Every own source key but the identity, the stats block and the embedded collections. */
function defaultPaths(document, source) {
  const embedded = Object.keys(document.constructor?.hierarchy ?? {});
  const paths = Object.keys(source)
    .filter(key => key !== 'flags' && !SKIPPED_KEYS.has(key) && !embedded.includes(key));
  paths.push(NARROWED_FLAGS.has(document.documentName) ? `flags.${SYSTEM_ID}` : 'flags');
  return paths;
}

/** A document about to be deleted: its whole source, plus where it hangs, so a restore can recreate it. */
function captureDeletion(document) {
  if (!document?.uuid) return null;
  return {
    uuid: String(document.uuid),
    parentUuid: String(document.parent?.uuid ?? ''),
    documentName: String(document.documentName ?? ''),
    pack: String(document.pack ?? ''),
    source: clone(document)
  };
}

/** Identities reserved before the create is issued, so a restore can find and delete what the writer created. */
function captureCreation(entry) {
  const parentUuid = String(entry?.parent?.uuid ?? '');
  const documentName = String(entry?.documentName ?? '');
  const pack = String(entry?.pack ?? '');
  return [...(entry?.ids ?? [])].map(String).filter(Boolean)
    .map(id => ({ parentUuid, documentName, id, pack }));
}

function captureSetting(key) {
  const name = String(key ?? '');
  return name ? { key: name, value: clone(readSetting(name, null)) } : null;
}

/* -------------------------------------------- */
/*  Restore                                     */
/* -------------------------------------------- */

async function recreate(entry, unresolved) {
  const options = restoreOptions();
  options.keepId = true;
  if (entry.pack) options.pack = entry.pack;
  try {
    if (await resolveDocument(entry.uuid)) return;
    const parent = entry.parentUuid ? await resolveDocument(entry.parentUuid) : null;
    if (parent) await parent.createEmbeddedDocuments(entry.documentName, [clone(entry.source)], options);
    else await globalThis.CONFIG?.[entry.documentName]?.documentClass?.create(clone(entry.source), options);
    if (!await resolveDocument(entry.uuid)) unresolved.push({ key: entry.uuid, reason: 'not-recreated' });
  } catch (error) {
    reportFoundryError(import.meta.url, error, `operation-restore-recreate:${entry.uuid}`, null, false);
    unresolved.push({ key: entry.uuid, reason: 'not-recreated' });
  }
}

/** One update per document, whatever an intervening edit did to the paths this operation protected. */
async function restoreFields(entry, unresolved) {
  try {
    const document = await resolveDocument(entry.uuid);
    if (!document) {
      unresolved.push({ key: entry.uuid, reason: 'missing' });
      return;
    }
    const changes = fieldChanges(document, entry);
    if (!Object.keys(changes).length) return;
    await document.update(changes, updateOptions(document));
    const outstanding = Object.keys(fieldChanges(document, entry));
    if (outstanding.length) unresolved.push({ key: entry.uuid, reason: 'not-restored', paths: outstanding });
  } catch (error) {
    reportFoundryError(import.meta.url, error, `operation-restore-fields:${entry.uuid}`, null, false);
    unresolved.push({ key: entry.uuid, reason: 'not-restored' });
  }
}

async function remove(entry, unresolved) {
  const uuid = createdUuid(entry);
  const options = restoreOptions();
  if (entry.pack) options.pack = entry.pack;
  try {
    const document = await resolveDocument(uuid);
    if (!document) return;
    const parent = entry.parentUuid ? await resolveDocument(entry.parentUuid) : null;
    if (parent) await parent.deleteEmbeddedDocuments(entry.documentName, [entry.id], options);
    else await document.delete(options);
    if (await resolveDocument(uuid)) unresolved.push({ key: uuid, reason: 'not-removed' });
  } catch (error) {
    reportFoundryError(import.meta.url, error, `operation-restore-remove:${uuid}`, null, false);
    unresolved.push({ key: uuid, reason: 'not-removed' });
  }
}

async function restoreSetting(entry, unresolved) {
  try {
    await game.settings.set(SYSTEM_ID, entry.key, clone(entry.value));
    // Read the stored value back the way the capture read it, so a typed setting is compared as its own source.
    if (!structurallyEqual(clone(readSetting(entry.key, null)), entry.value ?? null)) {
      unresolved.push({ key: entry.key, reason: 'not-restored' });
    }
  } catch (error) {
    reportFoundryError(import.meta.url, error, `operation-restore-setting:${entry.key}`, null, false);
    unresolved.push({ key: entry.key, reason: 'not-restored' });
  }
}

/**
 * The update that puts one document back: every captured leaf that differs is written, and everything the
 * operation introduced is deleted. Only free-form data is deleted at an ancestor. A schema-backed container such
 * as `system.resources` may not be undefined, so there only its leaves go, and an emptied container is left as
 * harmless residue. Whole subtrees are never replaced, because a replaced sparse ActorDelta would leave its
 * synthetic Actor holding the wrong data. The one exception is an `ownership` map that holds an entry the capture
 * did not (see ownershipReplacement). An ActorDelta map captured without a `default` counts as restored while its
 * stored default is the one pinnedOwnershipDefault gives it.
 */
function fieldChanges(document, entry) {
  const source = document._source;
  const changes = {};
  for (const [path, value] of Object.entries(entry.fields ?? {})) {
    const captured = new Map(leaves(value, path));
    const pinned = path === OWNERSHIP_ROOT ? pinnedOwnershipDefault(document, value) : undefined;
    const removals = new Set();
    for (const [leaf, current] of leaves(readPath(source, path), path)) {
      if (captured.has(leaf) || (leaf === `${OWNERSHIP_ROOT}.default` && current === pinned)) continue;
      removals.add(freeForm(path) ? removablePath(path, leaf, [...captured.keys()]) : leaf);
    }
    if (path === OWNERSHIP_ROOT && removals.size) {
      Object.assign(changes, ownershipReplacement(value, pinned));
      continue;
    }
    for (const removal of removals) Object.assign(changes, forcedDeletion(removal));
    for (const [leaf, before] of captured) {
      if (!structurallyEqual(readPath(source, leaf), before)) changes[leaf] = clone(before);
    }
  }
  for (const path of entry.absent ?? []) {
    const current = readPath(source, path);
    if (current === undefined) continue;
    if (freeForm(path)) Object.assign(changes, forcedDeletion(path));
    else for (const [leaf] of leaves(current, path)) Object.assign(changes, forcedDeletion(leaf));
  }
  return changes;
}

/**
 * The write that puts a captured `ownership` map back when the stored map holds an entry it did not. v14's
 * DocumentOwnershipField refuses a deletion inside the map, and ClientDatabaseBackend then drops the whole update
 * without throwing, so the captured map is written whole, the way core's ownership configuration writes it. The
 * value is the document's own persisted one, so an ActorDelta that held no ownership of its own gets null back and
 * its synthetic Actor reads the base Actor's ownership again. An ActorDelta map captured without a default is
 * written with the pinned one.
 */
function ownershipReplacement(captured, pinned) {
  if (captured === null) return { [OWNERSHIP_ROOT]: null };
  const levels = clone(captured);
  if (pinned !== undefined) levels.default = pinned;
  return forcedReplacement(OWNERSHIP_ROOT, levels);
}

/**
 * The `default` an ActorDelta's own ownership map is written back with when its capture held none. Foundry fills
 * a replaced map's missing default with NONE, and BaseActorDelta.applyDelta merges the delta's map over the base
 * Actor's, so that NONE would override the base Actor's default for every user without an entry of their own. The
 * base Actor's current default keeps those users at the level the merge gave them before the restore. Without a
 * base Actor there is no merge, and NONE is what the delta's own map already meant. Undefined for any other
 * document, for a null capture and for a captured map that holds a default.
 */
function pinnedOwnershipDefault(document, captured) {
  if (document.documentName !== 'ActorDelta' || !isPlainObject(captured) || Object.hasOwn(captured, 'default')) {
    return undefined;
  }
  const level = document.parent?.baseActor?._source?.ownership?.default;
  return Number.isInteger(level) ? level : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
}

/** Whether a path names free-form data, the only place a whole introduced branch may be deleted at its root. */
function freeForm(path) {
  return path === FREE_FORM_ROOT || path.startsWith(`${FREE_FORM_ROOT}.`);
}

/**
 * The shallowest path below the captured root that holds nothing this operation captured, so a whole introduced
 * branch goes in one deletion and a branch with captured siblings loses only the leaf.
 */
function removablePath(root, leaf, captured) {
  const segments = leaf.split('.');
  for (let depth = root.split('.').length + 1; depth < segments.length; depth += 1) {
    const candidate = segments.slice(0, depth).join('.');
    if (!captured.some(path => path === candidate || path.startsWith(`${candidate}.`))) return candidate;
  }
  return leaf;
}

/**
 * Restoration options, built fresh per write: a Token snaps back without animating or sounding like a move, and
 * as an undo, so walls never block it the way they block a walk.
 */
function updateOptions(document) {
  const options = restoreOptions();
  if (document.documentName !== 'Token') return options;
  options.animate = false;
  options.isUndo = true;
  options.emblemMovementRestore = true;
  return options;
}

function restoreOptions() {
  return { [RESTORE_WRITE_OPTION]: true };
}

/* -------------------------------------------- */
/*  Values                                      */
/* -------------------------------------------- */

/** Flatten a value into its leaf paths. An array and an object with dotted keys are leaves, and `{}` has none. */
function leaves(value, prefix) {
  const found = [];
  const visit = (entry, path) => {
    if (entry === undefined) return;
    const keys = isPlainObject(entry) ? Object.keys(entry) : null;
    if (!keys || keys.some(key => key.includes('.'))) {
      found.push([path, entry]);
      return;
    }
    for (const key of keys) visit(entry[key], `${path}.${key}`);
  };
  visit(value, String(prefix));
  return found;
}

/** The persisted value at a dot-path, or undefined when nothing is stored there. */
function readPath(source, path) {
  let value = source;
  for (const segment of String(path).split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

/** The uuid a reserved creation carries once the writer has created it. */
function createdUuid(entry) {
  return entry.parentUuid
    ? `${entry.parentUuid}.${entry.documentName}.${entry.id}`
    : `${entry.documentName}.${entry.id}`;
}

function byParentDepth(left, right) {
  return String(left.parentUuid ?? '').split('.').length - String(right.parentUuid ?? '').split('.').length;
}
