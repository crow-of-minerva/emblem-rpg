/** @layer foundry/patches */
import { CORE_KEYBINDING_DEFAULTS } from '../../config/keybindings.mjs';
import { installWrapperGroup } from '../../external/host.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Core keybinding defaults                    */
/* -------------------------------------------- */
const CORE_KEYBINDING_GROUP = 'core-keybinding-defaults';
const CORE_KEYBINDING_TARGET = 'foundry.helpers.interaction.ClientKeybindings.prototype._registerCoreKeybindings';

/**
 * Replace the Foundry defaults listed in config/keybindings.mjs, so this system's own bindings do not share a key
 * with a core action. Core registers its actions in `Game#initializeKeyboard`, between the setup hook where
 * init/hooks.mjs installs this and `ClientKeybindings#initialize`, which is where the changed default takes effect
 * and the keybindings configuration reads it as the value "reset to default" restores.
 */
export function installCoreKeybindingDefaults() {
  installWrapperGroup({
    id: CORE_KEYBINDING_GROUP,
    required: false,
    wrappers: [{
      target: CORE_KEYBINDING_TARGET,
      fn: function (wrapped, ...args) {
        const result = wrapped(...args);
        applyCoreKeybindingDefaults(this.actions, storedCoreBindings());
        return result;
      },
      type: 'WRAPPER'
    }]
  });
}

/**
 * Rewrite the editable default of each listed core action, leaving anything this client has already rebound alone.
 * @param {Map<string, {editable: Array<object>}>} actions The registry `game.keybindings.actions`.
 * @param {object|null} stored The client's saved `core.keybindings` overrides, or null when they cannot be read.
 * @returns {string[]} The action ids whose default was replaced.
 */
function applyCoreKeybindingDefaults(actions, stored) {
  if (!stored) return [];
  const changed = [];
  for (const { action, keys, modifiers } of CORE_KEYBINDING_DEFAULTS) {
    const config = actions?.get?.(action);
    if (!config || Object.hasOwn(stored, action)) continue;
    // Each binding carries its own modifiers array. This writes past ClientKeybindings' own binding validation, and
    // both the controls configuration and KeyboardManager read `binding.modifiers` without a guard.
    config.editable = keys.map(key => ({ key, modifiers: [...(modifiers ?? [])] }));
    changed.push(action);
  }
  return changed;
}

/**
 * The client's saved core keybinding overrides. A failure to read them returns null, which leaves every core default
 * as Foundry registered it rather than risk replacing a binding the user chose.
 * @returns {object|null}
 */
function storedCoreBindings() {
  try {
    const stored = globalThis.game?.settings?.get('core', 'keybindings');
    return stored && typeof stored === 'object' ? stored : {};
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'storedCoreBindings');
    return null;
  }
}
