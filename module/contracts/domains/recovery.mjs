/** @layer contracts/domains */

/* -------------------------------------------- */
/*  Operation records                           */
/* -------------------------------------------- */

/**
 * The world setting that holds the open operation record. It's declared in config/settings.mjs, and read and written
 * by foundry/adapters/recovery/operation-store.mjs. A committed operation leaves the setting `null`.
 */
export const OPERATION_RECORD_SETTING = 'operationRecord';
export const OPERATION_RECORD_VERSION = 1;

/**
 * Where one operation record stands. `open` means its before-images are saved and its writes may be unfinished.
 * `restoring` means a restoration started. engine/recovery/operations.mjs owns both transitions.
 */
export const OPERATION_STATES = Object.freeze({ OPEN: 'open', RESTORING: 'restoring' });

/**
 * The write option every restoration write carries, so movement input classification, footstep audio and the
 * lifecycle fills in foundry/ treat a restored value as a restore rather than a player action.
 */
export const RESTORE_WRITE_OPTION = 'emblemOperationRestore';
