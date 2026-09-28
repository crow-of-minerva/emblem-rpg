/** @layer config */

/* -------------------------------------------- */
/*  Enforced core settings                      */
/* -------------------------------------------- */
/**
 * Core values applied by foundry/adapters/services/settings-policy.mjs. An entry with `constant` takes its value
 * from that path in Foundry's CONST.
 */
export const ENFORCED_CORE_SETTINGS = Object.freeze([
  Object.freeze({
    id: 'core.scrollingStatusText',
    namespace: 'core',
    key: 'scrollingStatusText',
    value: false,
    hidden: true
  }),
  Object.freeze({
    id: 'core.tokenAutoRotate',
    namespace: 'core',
    key: 'tokenAutoRotate',
    value: false,
    hidden: true
  }),
  Object.freeze({
    id: 'core.gridDiagonals',
    namespace: 'core',
    key: 'gridDiagonals',
    constant: 'GRID_DIAGONALS.RECTILINEAR',
    hidden: true
  })
]);

/* -------------------------------------------- */
/*  Enforced Sequencer settings                 */
/* -------------------------------------------- */
/**
 * Sequencer values applied by foundry/adapters/services/settings-policy.mjs. Sequencer admits a user whose role is
 * above the stored level, so 2 keeps its scene control group, Effect Manager and Database viewer to Assistant GMs and
 * the Gamemaster. Its effect-create permission stays open because every client plays its own local visuals. Sequencer
 * reads the level only while building scene controls, so each client rebuilds them when the value changes.
 */
export const ENFORCED_SEQUENCER_SETTINGS = Object.freeze([
  Object.freeze({
    id: 'sequencer.permissions-sidebar-tools',
    namespace: 'sequencer',
    key: 'permissions-sidebar-tools',
    value: 2,
    hidden: true,
    rebuildsControls: true
  })
]);

/* -------------------------------------------- */
/*  Enforced BG3 HUD Core settings              */
/* -------------------------------------------- */
/**
 * BG3 HUD values applied by foundry/adapters/services/settings-policy.mjs.
 * Each client hides its macro bar, and the host turns on the GM hotbar once for the world.
 */
export const ENFORCED_BG3_HUD_SETTINGS = Object.freeze([
  Object.freeze({ key: 'collapseMacrobar', scope: 'client', value: 'always' }),
  Object.freeze({ key: 'enableGMHotbar', scope: 'world', value: true })
]);
