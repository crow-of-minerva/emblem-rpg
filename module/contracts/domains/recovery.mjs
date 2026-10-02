/** @layer contracts/domains */

/* -------------------------------------------- */
/*  Operation records                           */
/* -------------------------------------------- */

/**
 * The world setting that holds the undo record of the command being written. It's declared in config/settings.mjs,
 * and read and written by foundry/adapters/recovery/operation-store.mjs. It is `null` once the command finishes.
 */
export const OPERATION_RECORD_SETTING = 'operationRecord';
export const OPERATION_RECORD_VERSION = 1;

/**
 * Where one undo record stands. `open` means the old values are saved and the writes may be half done.
 * `restoring` means the old values are being put back. engine/recovery/operations.mjs moves it between the two.
 */
export const OPERATION_STATES = Object.freeze({ OPEN: 'open', RESTORING: 'restoring' });

/**
 * The option every undo write carries, so movement handling, footstep audio and the other Foundry hooks treat the
 * change as a restore rather than a player action.
 */
export const RESTORE_WRITE_OPTION = 'emblemOperationRestore';
