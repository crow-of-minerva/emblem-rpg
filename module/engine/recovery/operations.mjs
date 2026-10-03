/** @layer engine/recovery */
import { OPERATION_RECORD_VERSION, OPERATION_STATES } from '../../contracts/domains/recovery.mjs';
import { recordDiagnostic, requirePorts } from '../../contracts/protocol.mjs';

/* -------------------------------------------- */
/*  Failures                                    */
/* -------------------------------------------- */

/**
 * Thrown by `Operation#capture` when the old values could not be read or saved.
 * The writer must not make the write the capture was protecting.
 */
class OperationCaptureError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'OperationCaptureError';
  }
}

/** The saved old value of a path that held nothing: an undo removes the path rather than writing a value back. */
const ABSENT = Symbol('operation-absent');

/**
 * What `Operation#settle` tells CommandDispatcher. `restored: false` means not every write was undone: entries
 * were left unresolved and reported, or the run was abandoned and its record waits for the next startup.
 */
const SETTLEMENTS = Object.freeze({
  NONE: Object.freeze({ outcome: 'none', restored: true }),
  COMMITTED: Object.freeze({ outcome: 'committed', restored: true }),
  ABANDONED: Object.freeze({ outcome: 'abandoned', restored: false })
});

/* -------------------------------------------- */
/*  Operation recovery                          */
/* -------------------------------------------- */

/**
 * Keeps the world's one undo record, saved in a world setting. Before a command writes a document, the old values
 * are saved here (`capture`). When the command finishes, the record is cleared if it succeeded, or the old values
 * are written back if it failed (`settle`).
 *
 * CommandDispatcher (`engine/dispatcher.mjs`) opens a handle per run and hands it to the handler as
 * `context.operation`. init/system.mjs calls `restoreUnfinished()` on the host during the RECOVERING startup step,
 * before gameplay is allowed.
 */
export class OperationRecovery {
  #ports;

  /**
   * @param {object} ports Injected by init/system.mjs.
   * @param {{read: Function, write: Function, clear: Function}} ports.store Reads, writes and clears the setting.
   * @param {{capture: Function, restore: Function}} ports.snapshots Reads old values and writes them back.
   * @param {Function} ports.notifyGm Shows the one GM notice when an undo leaves entries unresolved.
   * @param {{record: Function}} ports.diagnostics Where the detail of every failure is written.
   * @param {Function} [ports.now] Clock for the record's `startedAt`.
   */
  constructor({ store, snapshots, notifyGm, diagnostics, now = () => Date.now() }) {
    requirePorts('OperationRecovery', { store, snapshots, notifyGm, diagnostics });
    this.#ports = Object.freeze({
      store, snapshots, now, diagnostics,
      report: (record, unresolved) => report({ diagnostics, notifyGm }, record, unresolved)
    });
  }

  /**
   * The handle one command run saves its old values through. Nothing is saved until a capture adds something.
   * @param {{id: string, label?: string, userId?: string}} intent The root request id, its command id and requester.
   * @returns {Operation}
   */
  open({ id, label = '', userId = '' } = {}) {
    return new Operation(this.#ports, {
      id: String(id ?? ''), label: String(label ?? ''), userId: String(userId ?? '')
    });
  }

  /**
   * Undo what an interrupted host left behind. An `open` record is undone. A `restoring` record means the previous
   * undo was interrupted, so every entry is reported unverified and the record is cleared without a second attempt.
   * @returns {Promise<boolean>} Whether a record was found and fully restored.
   */
  async restoreUnfinished() {
    let record = null;
    try {
      record = await this.#ports.store.read();
    } catch (error) {
      recordDiagnostic(this.#ports.diagnostics,
        { sourcePath: import.meta.url, error, detail: 'operation-record-read' });
      return false;
    }
    if (!record || typeof record !== 'object') return false;
    if (record.version !== OPERATION_RECORD_VERSION || record.state !== OPERATION_STATES.OPEN) {
      await this.#discard(record);
      return false;
    }
    return restoreRecord(this.#ports, record);
  }

  /** Report a record nothing may act on, then clear it. Nothing retries it and no failure state is kept. */
  async #discard(record) {
    const identity = String(record?.id ?? '');
    const unresolved = recordEntryKeys(record).map(key => ({ key, reason: 'unverified' }));
    try {
      await this.#ports.store.clear();
    } catch (error) {
      recordDiagnostic(this.#ports.diagnostics,
        { sourcePath: import.meta.url, error, detail: 'operation-record-clear', notify: false });
      unresolved.push({ key: identity, reason: 'record-not-cleared' });
    }
    this.#ports.report(record, unresolved.length ? unresolved : [{ key: identity, reason: 'unverified' }]);
  }
}

/* -------------------------------------------- */
/*  The operation handle                        */
/* -------------------------------------------- */

/**
 * One run's undo record: old values are saved before each write, then cleared on success or written back on
 * failure. Handlers receive it as `context.operation` and the document writers as an `operation` parameter. Child
 * commands run through `invokeWithin` receive `joined()`, which saves into this same record.
 */
class Operation {
  #ports;
  #id;
  #label;
  #userId;
  #record = null;
  #callbacks = [];
  #recorded = new Set();
  #queue = Promise.resolve();
  #abandoned = false;
  #settled = false;
  #child = null;

  constructor(ports, { id, label, userId }) {
    this.#ports = ports;
    this.#id = id;
    this.#label = label;
    this.#userId = userId;
  }

  /** The record's identity, which is the root request id CommandDispatcher opened this run with. */
  get id() {
    return this.#id;
  }

  /** The root command id, for diagnostics. */
  get label() {
    return this.#label;
  }

  /**
   * Save the old values of everything the caller is about to change, in one write to the setting.
   * Anything already in the record is neither read nor saved again, so a call that adds nothing is free.
   * Captures run one at a time: each one merges and saves before the next begins, so writers running in parallel
   * cannot interleave two merges of the same record.
   * @param {object} [request] `{documents, deleting, creating, settings}`. See foundry/adapters/recovery.
   * @returns {Promise<boolean>} Whether this call added anything to the record.
   */
  capture(request = {}) {
    const attempt = this.#queue.then(() => this.#captureNow(request));
    this.#queue = attempt.then(() => undefined, () => undefined);
    return attempt;
  }

  async #captureNow(request) {
    if (this.#abandoned) throw new OperationCaptureError(`Operation ${this.id} was abandoned.`);
    if (this.#settled) throw new OperationCaptureError(`Operation ${this.id} already settled.`);
    const wanted = this.#unrecorded(request);
    if (!wanted) return false;
    if (!this.#record) await this.#claimSlot();
    let fragment = null;
    try {
      fragment = await this.#ports.snapshots.capture(wanted);
    } catch (error) {
      throw new OperationCaptureError(`Operation ${this.id} could not read a before-image.`, { cause: error });
    }
    const next = mergeRecord(this.#record ?? this.#blank(), fragment);
    if (next) {
      const previous = this.#record;
      this.#record = next;
      try {
        await this.#ports.store.write(next);
      } catch (error) {
        this.#record = previous;
        throw new OperationCaptureError(`Operation ${this.id} could not save its record.`, { cause: error });
      }
    }
    this.#remember(wanted);
    return Boolean(next);
  }

  /**
   * A copy of the record as it stands, for a command that keeps its undo past its own end: a retractable item use
   * saves it on the unit so Cancel can write the old values back later. The world setting is still cleared when the
   * run succeeds and still written back when it fails. Captures made after this call are not in the copy.
   * @returns {Promise<object|null>} The record, or null when nothing has been saved yet.
   */
  async retain() {
    await this.#queue;
    return this.#record ? structuredClone(this.#record) : null;
  }

  /** Run `callback` once the record is committed (cleared after success). An undo drops it instead. */
  onCommit(callback) {
    if (typeof callback === 'function') this.#callbacks.push(callback);
  }

  /**
   * Finish the record once the handler returned: clear it when the handler succeeded, write the old values back
   * otherwise. A capture the handler already asked for finishes first. An abandoned run does nothing, so its record
   * stays for the next startup. Once this returns, later captures throw.
   * @param {boolean} ok Whether the handler's result was accepted.
   * @returns {Promise<{outcome: string, restored: boolean}>}
   */
  async settle(ok) {
    try {
      await this.#queue;
      if (this.#abandoned) return SETTLEMENTS.ABANDONED;
      if (ok === true) {
        const pending = Boolean(this.#record) || this.#callbacks.length > 0;
        try {
          await this.#commit();
        } catch (error) {
          recordDiagnostic(this.#ports.diagnostics, { sourcePath: import.meta.url, error, detail: 'operation-commit' });
          return Object.freeze({ outcome: 'commit-failed', restored: await this.#restore() });
        }
        return pending ? SETTLEMENTS.COMMITTED : SETTLEMENTS.NONE;
      }
      if (!this.#record) {
        this.#callbacks.length = 0;
        return SETTLEMENTS.NONE;
      }
      return Object.freeze({ outcome: 'restored', restored: await this.#restore() });
    } finally {
      this.#settled = true;
    }
  }

  /**
   * Give up on this run without touching the record, for the forced `recovery.clear-busy` and for page unload.
   * A later capture throws, `settle` does nothing, and the next startup undoes whatever is still recorded.
   * @returns {boolean} Whether a durable record is open.
   */
  abandon() {
    this.#abandoned = true;
    this.#callbacks.length = 0;
    return Boolean(this.#record);
  }

  /** The handle child commands run through `invokeWithin` receive: they save into this record, finished here. */
  joined() {
    const root = this;
    this.#child ??= Object.freeze({
      get id() { return root.id; },
      get label() { return root.label; },
      capture: request => root.capture(request),
      onCommit: callback => root.onCommit(callback),
      joined: () => root.joined()
    });
    return this.#child;
  }

  /**
   * Commit the record: one clear of the setting, then the after-commit callbacks. Only `settle` calls this. A failed
   * callback cannot turn committed work into an undo.
   */
  async #commit() {
    if (this.#record) {
      await this.#ports.store.clear();
      this.#close();
    }
    for (const callback of this.#callbacks.splice(0)) {
      try {
        await callback();
      } catch (error) {
        recordDiagnostic(this.#ports.diagnostics, {
          sourcePath: import.meta.url, error, detail: 'operation-commit-callback'
        });
      }
    }
  }

  /**
   * Drop everything the record already holds, so a repeated capture reads no document and saves nothing.
   * @returns {object|null} What is left to read, or null when the call adds nothing.
   */
  #unrecorded({ documents = [], deleting = [], creating = [], settings = [] } = {}) {
    const wanted = { documents: [], deleting: [], creating: [], settings: [] };
    for (const entry of documents) {
      const uuid = documentKey(entry);
      const paths = [...(entry?.paths ?? [])].map(String).filter(Boolean);
      if (!uuid || !paths.length) {
        if (uuid && this.#recorded.has(`${uuid}|*`)) continue;
        wanted.documents.push(entry);
        continue;
      }
      const covered = this.#coveredPaths(uuid);
      const missing = paths.filter(path => !covered.some(known => isCoveredBy(path, known)));
      if (missing.length) wanted.documents.push({ document: entry.document ?? entry, paths: missing });
    }
    for (const entry of deleting) {
      const uuid = String(entry?.uuid ?? '');
      if (!uuid || !this.#recorded.has(`delete|${uuid}`)) wanted.deleting.push(entry);
    }
    for (const entry of creating) {
      const ids = [...(entry?.ids ?? [])].map(String).filter(id => !this.#recorded.has(creationKey(entry, id)));
      if (ids.length) wanted.creating.push({ ...entry, ids });
    }
    for (const key of settings) {
      if (!this.#recorded.has(`setting|${String(key ?? '')}`)) wanted.settings.push(key);
    }
    return Object.values(wanted).some(group => group.length) ? wanted : null;
  }

  /** The paths this record already holds on one document. A path under any of them isn't read again. */
  #coveredPaths(uuid) {
    const entry = this.#record?.documents.find(item => item.uuid === uuid);
    return entry ? [...Object.keys(entry.fields), ...entry.absent] : [];
  }

  /**
   * Remember the requests this record now answers. Document paths are read back from the record itself, so a
   * whole-document capture and a path-by-path one agree. mergeDocument still makes sure each leaf is recorded once.
   */
  #remember({ documents, deleting, creating, settings }) {
    for (const entry of documents) {
      const uuid = documentKey(entry);
      if (uuid && ![...(entry?.paths ?? [])].length) this.#recorded.add(`${uuid}|*`);
    }
    for (const entry of deleting) if (entry?.uuid) this.#recorded.add(`delete|${entry.uuid}`);
    for (const entry of creating) for (const id of entry.ids) this.#recorded.add(creationKey(entry, id));
    for (const key of settings) this.#recorded.add(`setting|${String(key ?? '')}`);
  }

  /** The world holds one record at a time: if another command's record is still there, refuse, never overwrite. */
  async #claimSlot() {
    let held = null;
    try {
      held = await this.#ports.store.read();
    } catch (error) {
      throw new OperationCaptureError(`Operation ${this.id} could not read the record slot.`, { cause: error });
    }
    if (!held) return;
    recordDiagnostic(this.#ports.diagnostics, {
      sourcePath: import.meta.url,
      error: new Error(`operation.record-occupied:${held.id ?? ''}`),
      detail: `${this.label} found the record of ${held.label ?? ''} still open`
    });
    throw new OperationCaptureError(`Operation ${this.id} found another operation record open.`);
  }

  async #restore() {
    const record = this.#record;
    this.#callbacks.length = 0;
    if (!record) return true;
    this.#close();
    return restoreRecord(this.#ports, record);
  }

  #close() {
    this.#record = null;
    this.#recorded.clear();
  }

  #blank() {
    return {
      version: OPERATION_RECORD_VERSION, id: this.#id, label: this.#label, userId: this.#userId,
      startedAt: this.#ports.now(), state: OPERATION_STATES.OPEN,
      documents: [], deleted: [], created: [], settings: []
    };
  }
}

/* -------------------------------------------- */
/*  Restoration                                 */
/* -------------------------------------------- */

/**
 * Mark the record as being undone, have the snapshots service write the old values back, then clear it.
 * Each entry is attempted once. Anything still unresolved is reported, and nothing is retried.
 * @returns {Promise<boolean>} Whether every entry was resolved.
 */
async function restoreRecord(ports, record) {
  const restoring = { ...record, state: OPERATION_STATES.RESTORING };
  try {
    await ports.store.write(restoring);
  } catch (error) {
    recordDiagnostic(ports.diagnostics,
      { sourcePath: import.meta.url, error, detail: 'operation-restore-start', notify: false });
    ports.report(record, [{ key: String(record?.id ?? ''), reason: 'restore-not-started' }]);
    return false;
  }
  let unresolved = [];
  try {
    unresolved = [...(await ports.snapshots.restore(restoring) ?? [])];
  } catch (error) {
    unresolved = [{ key: String(record?.id ?? ''), reason: String(error?.message ?? error) }];
  }
  try {
    await ports.store.clear();
  } catch (error) {
    recordDiagnostic(ports.diagnostics,
      { sourcePath: import.meta.url, error, detail: 'operation-record-clear', notify: false });
    unresolved.push({ key: String(record?.id ?? ''), reason: 'record-not-cleared' });
  }
  if (!unresolved.length) return true;
  ports.report(record, unresolved);
  return false;
}

/**
 * The whole report: one GM notice, and one console diagnostic naming the operation, its label, every unresolved
 * key with its reason and the old value each one still held, because the record is cleared straight after and
 * the GM repairs those documents by hand. The diagnostic raises no notice of its own, so the GM sees the one
 * notice rather than a stack of generic error toasts.
 */
function report({ diagnostics, notifyGm }, record, unresolved) {
  const entries = unresolved ?? [];
  recordDiagnostic(diagnostics, {
    sourcePath: import.meta.url,
    notify: false,
    detail: `operation ${record?.id ?? ''} (${record?.label ?? ''}) left ${entries.length} unresolved: `
      + entries.map(entry => `${entry.key}: ${entry.reason}`).join('; '),
    stack: JSON.stringify(entries.map(entry => ({ ...entry, before: beforeImage(record, entry.key) })), null, 1)
  });
  try {
    notifyGm();
  } catch (error) {
    recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'operation-restore-notice' });
  }
}

/** What the record still holds for one unresolved key, whichever kind of entry recorded it. */
function beforeImage(record, key) {
  return (record?.documents ?? []).find(entry => entry.uuid === key)
    ?? (record?.deleted ?? []).find(entry => entry.uuid === key)
    ?? (record?.created ?? []).find(entry => createdUuid(entry) === key)
    ?? (record?.settings ?? []).find(entry => entry.key === key)
    ?? null;
}

/* -------------------------------------------- */
/*  Record merging                              */
/* -------------------------------------------- */

/**
 * Add what a capture read to the open record, keeping the value saved first for a path already recorded.
 * @returns {object|null} The record to save, or null when the capture added nothing.
 */
function mergeRecord(record, fragment) {
  const next = structuredClone(record);
  let added = false;
  for (const entry of fragment?.created ?? []) {
    if (next.created.some(known => createdUuid(known) === createdUuid(entry))) continue;
    next.created.push(entry);
    added = true;
  }
  const created = new Set(next.created.map(createdUuid));
  for (const entry of fragment?.documents ?? []) {
    if (created.has(entry.uuid)) continue;
    added = mergeDocument(next, entry) || added;
  }
  for (const entry of fragment?.deleted ?? []) {
    if (created.has(entry.uuid) || next.deleted.some(known => known.uuid === entry.uuid)) continue;
    next.deleted.push(entry);
    added = true;
  }
  for (const entry of fragment?.settings ?? []) {
    if (next.settings.some(known => known.key === entry.key)) continue;
    next.settings.push(entry);
    added = true;
  }
  return added ? next : null;
}

/** Merge one document's old values, so the record holds every leaf once, at the value saved first. */
function mergeDocument(record, entry) {
  const known = record.documents.find(item => item.uuid === entry.uuid);
  const target = known ?? { uuid: entry.uuid, fields: {}, absent: [] };
  let added = false;
  for (const [path, value] of Object.entries(entry.fields ?? {})) added = recordPath(target, path, value) || added;
  for (const path of entry.absent ?? []) added = recordPath(target, path, ABSENT) || added;
  if (added && !known) record.documents.push(target);
  return added;
}

/**
 * Record one path's old value. A path an earlier capture already covers is dropped. A path that covers earlier
 * ones takes in their values first, so a broader capture made after the command already wrote cannot record a
 * value the command itself wrote. The entry never holds two paths for the same leaf.
 * @returns {boolean} Whether the record changed.
 */
function recordPath(entry, path, value) {
  const recorded = [...Object.keys(entry.fields), ...entry.absent];
  if (recorded.some(known => isCoveredBy(path, known))) return false;
  const covered = recorded.filter(known => isCoveredBy(known, path));
  const merged = overlay(entry, path, value, covered);
  for (const known of covered) delete entry.fields[known];
  entry.absent = entry.absent.filter(known => !covered.includes(known));
  if (merged === ABSENT) entry.absent.push(path);
  else entry.fields[path] = merged;
  return true;
}

/** Put every earlier saved value back inside a broader capture, at the position it was saved under. */
function overlay(entry, path, value, covered) {
  let merged = value === ABSENT ? undefined : structuredClone(value);
  for (const known of covered) {
    const segments = known.slice(path.length + 1).split('.');
    merged = Object.hasOwn(entry.fields, known)
      ? assignAt(merged, segments, entry.fields[known])
      : removeAt(merged, segments);
  }
  return merged === undefined ? ABSENT : merged;
}

/** Write one value inside a saved subtree, creating the branches it needs. */
function assignAt(subtree, segments, value) {
  const root = branch(subtree);
  let node = root;
  for (const key of segments.slice(0, -1)) {
    node[key] = branch(node[key]);
    node = node[key];
  }
  node[segments.at(-1)] = structuredClone(value);
  return root;
}

/** Take one position out of a saved subtree, so a later capture cannot bring back what held nothing. */
function removeAt(subtree, segments) {
  if (subtree === undefined) return undefined;
  const root = branch(subtree);
  let node = root;
  for (const key of segments.slice(0, -1)) {
    if (!isBranch(node[key])) return root;
    node = node[key];
  }
  delete node[segments.at(-1)];
  return root;
}

/** Whether one dot-path lies at or under another. */
function isCoveredBy(path, ancestor) {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

function isBranch(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function branch(value) {
  return isBranch(value) ? value : {};
}

/**
 * The key a capture target is remembered under. A document without a uuid is always read again and de-duplicated
 * by mergeRecord, so no two documents can share one key.
 */
function documentKey(entry) {
  return String(entry?.document?.uuid ?? entry?.uuid ?? '');
}

/** The key one planned creation is remembered under, before the document exists. */
function creationKey(entry, id) {
  return `create|${String(entry?.parent?.uuid ?? '')}|${String(entry?.documentName ?? '')}|${id}`;
}

/** The uuid a planned creation will have, so a document the command creates is never also saved as changed. */
function createdUuid(entry) {
  return entry?.parentUuid
    ? `${entry.parentUuid}.${entry.documentName}.${entry.id}`
    : `${entry?.documentName}.${entry?.id}`;
}

/** Every key a record names, for the report of an undo nobody can verify. */
function recordEntryKeys(record) {
  return [
    ...(record?.documents ?? []).map(entry => entry.uuid),
    ...(record?.deleted ?? []).map(entry => entry.uuid),
    ...(record?.created ?? []).map(createdUuid),
    ...(record?.settings ?? []).map(entry => entry.key)
  ].map(String);
}
