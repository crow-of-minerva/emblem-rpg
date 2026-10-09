/** @layer init */
import { SYSTEM_ID, recordDiagnostic } from '../contracts/protocol.mjs';
import { NOTIFICATION_IDS } from '../presentation/interface/notification-ids.mjs';

/* -------------------------------------------- */
/*  World content migration                     */
/* -------------------------------------------- */

/** The Migrate World Content macro in the system's GM Macros pack, which makes every write the migration needs. */
const MIGRATOR = Object.freeze({ pack: `${SYSTEM_ID}.macros`, id: 'H2ZGhJFCQBBXc0Qy' });

/**
 * Bring an older world, and the Actor and Item compendiums of its enabled modules, up to this version's schema by
 * running the Migrate World Content macro. completeStartup in
 * init/system.mjs calls this on the host client once commands are accepted, when stampWorldSchema reports the world
 * behind. The host holds the command lock for the whole run, so every client shows the hourglass and refuses
 * gameplay and edits. The GM sees a notice while it runs and another when it ends. A run that reaches the end
 * records the new version even when some documents failed, so the same failure doesn't block every load; the GM is
 * told to fix them and run the macro by hand. A run that stops early records nothing and runs again next load.
 * @param {object} ports
 * @param {Function} ports.openSegment Takes the command lock on the host client, resolving `data.segment` or the
 *   refusal.
 * @param {Function} ports.recordSchema Records the current schema version (stampMigratedWorldSchema).
 * @param {object} ports.notifications NotificationService.
 * @param {object} ports.diagnostics Diagnostics sink.
 * @returns {Promise<boolean>} Whether the run reached the end and recorded the new schema version.
 */
export async function migrateWorldContent({ openSegment, recordSchema, notifications, diagnostics }) {
  const notice = notifications.show(NOTIFICATION_IDS.WORLD_MIGRATION_STARTED);
  let summary = null;
  try {
    summary = await underSegment(openSegment, async () => {
      const result = await runMigrator();
      await recordSchema();
      return result;
    });
  } catch (error) {
    summary = null;
    recordDiagnostic(diagnostics, { sourcePath: import.meta.url, error, detail: 'world-migration', notify: false });
  } finally {
    notifications.dismiss(notice);
  }
  if (summary === null) {
    notifications.show(NOTIFICATION_IDS.WORLD_MIGRATION_FAILED);
    return false;
  }
  if (summary.conflicts.length) {
    notifications.show(NOTIFICATION_IDS.WORLD_MIGRATION_CONFLICTS, { count: summary.conflicts.length });
  }
  if (summary.errors.length) {
    recordDiagnostic(diagnostics, { sourcePath: import.meta.url, detail: 'world-migration', notify: false,
      error: new Error(`world-migration.incomplete:${summary.errors.length}`) });
    notifications.show(NOTIFICATION_IDS.WORLD_MIGRATION_INCOMPLETE, { count: summary.errors.length });
  } else {
    notifications.show(NOTIFICATION_IDS.WORLD_MIGRATION_COMPLETED);
  }
  return true;
}

/** Hold the command lock while `work` runs, and release it whatever `work` does. */
async function underSegment(openSegment, work) {
  const opened = await openSegment();
  const segment = opened?.data?.segment;
  if (!segment) throw new Error(`world-migration.segment-refused:${opened?.code ?? 'unknown'}`);
  try {
    return await work();
  } finally {
    await segment.close();
  }
}

/**
 * Run the Migrate World Content macro unattended, which skips its confirmation and its own notices, and read back
 * the summary it returns: the actors and items it updated, the items it left alone because they hold animations or
 * effects under both names, and the writes that failed.
 */
async function runMigrator() {
  const macro = await globalThis.game.packs.get(MIGRATOR.pack)?.getDocument(MIGRATOR.id);
  if (!macro) throw new Error(`world-migration.migrator-missing:${MIGRATOR.pack}.${MIGRATOR.id}`);
  const summary = await macro.execute({ automatic: true });
  if (!Array.isArray(summary?.errors) || !Array.isArray(summary?.conflicts)) {
    throw new Error('world-migration.summary-unreadable');
  }
  return summary;
}
