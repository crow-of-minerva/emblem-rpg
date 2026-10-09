/** @layer foundry/adapters/services */
import { SCHEMA_VERSION } from '../../../config/constants.mjs';
import { ENFORCED_CORE_SETTINGS, ENFORCED_SEQUENCER_SETTINGS } from '../../../config/enforced-settings.mjs';
import { FLYER_TARGETING_MODES } from '../../../contracts/domains/combat.mjs';
import {
  FLYER_TARGETING_SETTING,
  PLAYER_CRITICAL_BONUS_RANGE,
  PLAYER_CRITICAL_BONUS_SETTING,
  SCHEMA_VERSION_SETTING,
  TOKEN_OUTLINE_COLOUR_SETTING,
  TOKEN_OUTLINE_DEFAULT_COLOUR,
  XP_MULTIPLIER_SETTING
} from '../../../config/settings.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { isActiveGm as localUserIsActiveGm } from './host.mjs';
import { reportFoundryError, reportFoundryProbe } from './diagnostics.mjs';

/* -------------------------------------------- */
/*  Foundry settings policy                     */
/* -------------------------------------------- */
const SETTINGS_CATEGORY_TARGET =
  'foundry.applications.settings.SettingsConfig.prototype._prepareCategoryData';
const ENFORCED_SETTINGS = Object.freeze([...ENFORCED_CORE_SETTINGS, ...ENFORCED_SEQUENCER_SETTINGS]);
const HIDDEN_SETTING_IDS = new Set(
  ENFORCED_SETTINGS.filter(setting => setting.hidden).map(setting => setting.id)
);
const SETTINGS_BY_ID = new Map(ENFORCED_SETTINGS.map(setting => [setting.id, setting]));

/**
 * Hide the enforced core and Sequencer settings marked `hidden` from Foundry's Settings Configuration window.
 * Installed from the `setup` hook (init/hooks.mjs).
 */
export function initializeCoreSettingsPolicy() {
  if (!globalThis.libWrapper) {
    reportFoundryError(import.meta.url, null, `${SYSTEM_ID} | Core settings policy could not hide Foundry controls because libWrapper is unavailable.`);
    return;
  }

  try {
    globalThis.libWrapper.register(
      SYSTEM_ID,
      SETTINGS_CATEGORY_TARGET,
      function (wrapped, ...args) {
        return hideEnforcedSettings(wrapped.call(this, ...args));
      },
      'WRAPPER'
    );
  } catch (error) {
    reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not hide enforced core settings.`);
  }
}

/**
 * On the host client, set the core and Sequencer settings this system requires. Runs on `ready` and whenever
 * onEnforcedCoreSettingChanged sees one change.
 */
export async function enforceCoreSettingsPolicy() {
  if (!localUserIsActiveGm()) return;

  for (const setting of ENFORCED_SETTINGS) {
    const value = enforcedValue(setting);
    if (value === undefined) continue;
    try {
      const current = game.settings.get(setting.namespace, setting.key);
      if (current !== value) {
        await game.settings.set(setting.namespace, setting.key, value);
      }
    } catch (error) {
      reportFoundryError(import.meta.url, error, `${SYSTEM_ID} | Could not enforce ${setting.id}.`);
    }
  }
}

/**
 * Restore an enforced value if another integration changes it while the world is running. Every client runs this
 * from the updateSetting hook. An entry marked `rebuildsControls` also re-prepares this client's scene controls,
 * because Sequencer reads its permission level only while building them.
 * @param {object} setting Foundry's updated setting document.
 */
export function onEnforcedCoreSettingChanged(setting) {
  const settingId = readSettingId(setting);
  const policy = SETTINGS_BY_ID.get(settingId);
  if (!policy) return;
  if (policy.rebuildsControls) globalThis.ui?.controls?.render?.({ reset: true });
  if (setting?.value === enforcedValue(policy)) return;
  void enforceCoreSettingsPolicy();
}

/** The value one enforced entry holds, resolving a named CONST path when the entry carries one. */
function enforcedValue(setting) {
  if (!setting?.constant) return setting?.value;
  return String(setting.constant).split('.').reduce(
    (node, part) => (node === null || node === undefined ? undefined : node[part]),
    globalThis.CONST
  );
}

/* -------------------------------------------- */
/*  World schema stamp                          */
/* -------------------------------------------- */
export const WORLD_SCHEMA_STATES = Object.freeze({
  STAMPED: 'stamped',
  CURRENT: 'current',
  BEHIND: 'behind',
  AHEAD: 'ahead',
  SKIPPED: 'skipped'
});

/** Stamp a fresh world with the system schema version, or report the stored version for startup diagnostics. */
export async function stampWorldSchema() {
  const current = SCHEMA_VERSION;
  const stored = Number(readSystemSetting(SCHEMA_VERSION_SETTING)) || 0;
  if (stored === current) return { state: WORLD_SCHEMA_STATES.CURRENT, stored, current };
  if (stored === 0) {
    if (!localUserIsActiveGm()) return { state: WORLD_SCHEMA_STATES.SKIPPED, stored, current };
    await globalThis.game.settings.set(SYSTEM_ID, SCHEMA_VERSION_SETTING, current);
    return { state: WORLD_SCHEMA_STATES.STAMPED, stored, current };
  }
  const state = stored < current ? WORLD_SCHEMA_STATES.BEHIND : WORLD_SCHEMA_STATES.AHEAD;
  return { state, stored, current };
}

/**
 * Record the system schema version on a world `migrateWorldContent` (init/migrate-world.mjs) has just brought up to
 * date. Only the host client writes it, and a world a newer build stamped keeps its version.
 * @returns {Promise<boolean>} Whether the version was written.
 */
export async function stampMigratedWorldSchema() {
  const stored = Number(readSystemSetting(SCHEMA_VERSION_SETTING)) || 0;
  if (stored >= SCHEMA_VERSION || !localUserIsActiveGm()) return false;
  await globalThis.game.settings.set(SYSTEM_ID, SCHEMA_VERSION_SETTING, SCHEMA_VERSION);
  return true;
}

/* -------------------------------------------- */
/*  Gameplay setting reads                      */
/* -------------------------------------------- */
/** The world XP multiplier, or 1 when the setting is unreadable or negative. */
export function worldExperienceMultiplier() {
  const value = Number(readSystemSetting(XP_MULTIPLIER_SETTING));
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

/**
 * The world scale on a critical's bonus damage against a Lord or Retainer, clamped to the slider's range, or 1 when
 * the setting is unreadable.
 */
export function worldPlayerCriticalBonusScale() {
  const value = Number(readSystemSetting(PLAYER_CRITICAL_BONUS_SETTING));
  if (!Number.isFinite(value)) return 1;
  return Math.min(PLAYER_CRITICAL_BONUS_RANGE.max, Math.max(PLAYER_CRITICAL_BONUS_RANGE.min, value));
}

/** Whether the world plays Classic flyer targeting, where melee weapons may strike airborne units. */
export function worldClassicFlyerTargeting() {
  return readSystemSetting(FLYER_TARGETING_SETTING) === FLYER_TARGETING_MODES.CLASSIC;
}

/**
 * The pair of colours the token outline recolour needs: the colour the art was drawn with, and the colour this
 * scene wants it shown in. A scene that names no override is shown the world colour, which recolours nothing.
 * @param {object} [scene] The scene whose override is read.
 * @returns {{src: string, dst: string}}
 */
export function tokenOutlineColours(scene = globalThis.canvas?.scene) {
  const src = String(readSystemSetting(TOKEN_OUTLINE_COLOUR_SETTING) ?? TOKEN_OUTLINE_DEFAULT_COLOUR);
  const override = scene?.getFlag?.(SYSTEM_ID, TOKEN_OUTLINE_COLOUR_SETTING);
  return { src, dst: typeof override === 'string' && override.length ? override : src };
}

function readSystemSetting(key) {
  try {
    return globalThis.game?.settings?.get(SYSTEM_ID, key);
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'readSystemSetting', globalThis.game?.ready !== true && /is not a registered game setting$/.test(String(diagnosticError?.message ?? '')));
    return undefined;
  }
}

/* -------------------------------------------- */
/*  Settings Configuration filter               */
/* -------------------------------------------- */
function hideEnforcedSettings(categories) {
  for (const category of Object.values(categories ?? {})) {
    if (!Array.isArray(category?.entries)) continue;
    category.entries = category.entries.filter(entry => !HIDDEN_SETTING_IDS.has(readSettingId(entry)));
  }
  return categories;
}

/**
 * The namespaced id of a Settings Configuration entry (`field.name`), a registered setting configuration
 * (`namespace` and `key`) or a stored Setting document, whose `key` is already namespaced and whose `id` is its
 * document id.
 */
function readSettingId(setting) {
  if (typeof setting?.field?.name === 'string') return setting.field.name;
  if (typeof setting?.namespace === 'string' && typeof setting?.key === 'string') {
    return `${setting.namespace}.${setting.key}`;
  }
  if (typeof setting?.key === 'string') return setting.key;
  return '';
}
