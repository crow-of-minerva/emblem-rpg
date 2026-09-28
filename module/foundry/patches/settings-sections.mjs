/** @layer foundry/patches */
import { SETTING_SECTIONS } from '../../config/settings.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { installWrapperGroup } from '../../external/host.mjs';

/* -------------------------------------------- */
/*  Section headers                             */
/* -------------------------------------------- */
const HEADER_CLASS = 'emblem-settings-section';
const WRAPPER_GROUP_ID = 'settings-search-sync';
const SEARCH_FILTER_TARGET = 'foundry.applications.settings.SettingsConfig.prototype._onSearchFilter';

/** Head each section of the system tab in Configure Settings, then hide the heads the current filter empties. */
export function onRenderSettingsConfigSections(_application, element) {
  const category = systemCategory(element);
  if (!category) return false;
  insertSectionHeaders(category);
  syncHeaderVisibility(category);
  return true;
}

/** Keep the section heads in step with the settings search. Without libWrapper they just stop following it. */
export function installSettingsSections() {
  return installWrapperGroup({
    id: WRAPPER_GROUP_ID,
    required: false,
    wrappers: [{
      target: SEARCH_FILTER_TARGET,
      type: 'WRAPPER',
      fn(wrapped, ...args) {
        const result = wrapped(...args);
        const category = systemCategory(this.element);
        if (category) syncHeaderVisibility(category);
        return result;
      }
    }]
  });
}

/* -------------------------------------------- */
/*  DOM work                                    */
/* -------------------------------------------- */
function systemCategory(root) {
  const element = root instanceof globalThis.HTMLElement ? root : root?.[0] ?? root;
  return element?.querySelector?.('section.tab[data-category="system"]') ?? null;
}

function firstGroupOf(category, section) {
  for (const id of section.settingIds) {
    const group = category.querySelector(`[name="${SYSTEM_ID}.${id}"]`)?.closest('.form-group');
    if (group) return group;
  }
  return null;
}

function insertSectionHeaders(category) {
  for (const stale of category.querySelectorAll(`.${HEADER_CLASS}`)) stale.remove();
  for (const section of SETTING_SECTIONS) {
    const anchor = firstGroupOf(category, section);
    if (!anchor) continue;
    const header = globalThis.document.createElement('h3');
    header.className = `divider ${HEADER_CLASS}`;
    header.textContent = section.label;
    anchor.before(header);
  }
}

function syncHeaderVisibility(category) {
  for (const header of category.querySelectorAll(`.${HEADER_CLASS}`)) {
    let visible = false;
    for (let node = header.nextElementSibling; node; node = node.nextElementSibling) {
      if (node.classList.contains(HEADER_CLASS)) break;
      if (node.classList.contains('form-group') && !node.hidden) {
        visible = true;
        break;
      }
    }
    header.hidden = !visible;
  }
}
