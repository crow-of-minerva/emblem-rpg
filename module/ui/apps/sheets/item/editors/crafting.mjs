/** @layer ui/apps/sheets/item/editors */
/*
 * The crafting settings dialogs. Equipment gets its forging cost and five refinement tiers, where each tier
 * replaces the one below rather than adding to it, and cascade and sync controls save retyping. A Potion or Bomb gets
 * its creation recipe. The material list and Resource search are shared with the Recipe Library.
 */
import { openEditor } from '../../../../dialogs.mjs';
import { escapeHtml } from '../../../../../lib/dom/html.mjs';
import { wireSearchDropdown } from '../../../../../lib/dom/search-dropdown.mjs';
import { SYSTEM_ID } from '../../../../../contracts/protocol.mjs';
import { DAMAGE_TYPES } from '../../../../../contracts/domains/damage.mjs';
import { readItemCatalog } from '../../../../../foundry/adapters/projections/items.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/editors/crafting-settings.hbs`;
const CONSUMABLE_TEMPLATE = `systems/${SYSTEM_ID}/templates/editors/consumable-crafting.hbs`;
const CONSUMABLE_CRAFTING_SKILLS = Object.freeze(['Nature', 'Handicraft', 'Reason']);
const FORGING_SKILLS = Object.freeze(['Handicraft', 'Nature', 'Esoteric', 'Reason']);
const TIER_COUNT = 5;
const ARMOR_TIER_FIELDS = Object.freeze([['stn', 'Stn'], ['def', 'Def'], ['res', 'Res'], ['wgtRed', 'WgtRed'], ['durability', 'Dur']]);
const WEAPON_TIER_FIELDS = Object.freeze([['atk', 'Atk'], ['brk', 'Brk'], ['wgt', 'Wgt'], ['acc', 'Acc'], ['crit', 'Crit'], ['durability', 'Dur']]);
const MATERIAL_RESOURCE_TYPES = Object.freeze(['Material', 'Textile', 'Reagent']);
const RESOURCE_FALLBACK_IMG = 'icons/svg/item-bag.svg';
/* -------------------------------------------- */
/*  Applicability                               */
/* -------------------------------------------- */

/**
 * The item types that cannot be refined, and so show no refinement tab.
 * @type {Set<string>}
 */
const NO_REFINEMENT_ITEM_TYPES = new Set(['Staff', 'Staff (U)']);
const FALLBACK_IMG = RESOURCE_FALLBACK_IMG;

/* -------------------------------------------- */
/*  Form Data                                   */
/* -------------------------------------------- */

/**
 * Collect the forging and refinement fields for the Item update. A blank tier cost, skill or material list keeps
 * the one from the tier below (forgingTerms in game/items/rules.mjs), and a blank tier stat is saved as null, which
 * leaves the item's base stat as it is. The tiers are saved with `relative: true` so the Item migration doesn't
 * convert them again.
 * @param {object} forging                The forging working copy, carrying its materials.
 * @param {boolean} showRefinement        Whether refinement is offered at all.
 * @param {boolean} isArmor               Which stat set to read.
 */
function gatherFormData(el, forging, tiers, showRefinement, isArmor) {
  const forgeMult = Math.max(0.1, Number(el.querySelector("[name='forgeMult']").value) || 1);
  const skillCheck = el.querySelector("[name='forgingSkillCheck']").value || 'Handicraft';
  const enabled = el.querySelector("[name='forgingEnabled']")?.checked || false;
  const xpInput = el.querySelector("[name='forgingXP']");
  const forgingXP = xpInput ? Math.max(0, Math.floor(Number(xpInput.value) || 0)) : null;

  if (showRefinement) {
    for (let i = 0; i < TIER_COUNT; i++) {
      tiers[i].enabled = el.querySelector(`[name='tierEnabled_${i}']`)?.checked || false;
      tiers[i].xpReq = Math.max(0, Math.floor(Number(el.querySelector(`[name='tierXpReq_${i}']`).value) || 0));
      const mult = el.querySelector(`[name='tierForgeMult_${i}']`).value;
      tiers[i].forgeMult = mult !== '' && Number(mult) > 0 ? Math.max(0.1, Number(mult)) : null;
      tiers[i].skillCheck = el.querySelector(`[name='tierSkill_${i}']`).value || '';
      for (const [field, name] of isArmor ? ARMOR_TIER_FIELDS : WEAPON_TIER_FIELDS) {
        const v = el.querySelector(`[name='tier${name}_${i}']`).value;
        tiers[i].modifiers[field] = v !== '' ? Number(v) : null;
      }
      const prefix = isArmor ? 'tierProt' : 'tierDmg';
      const granted = Object.fromEntries(DAMAGE_TYPES.map(type => [
        type, el.querySelector(`[name='${prefix}_${i}_${type}']`)?.checked || false
      ]));
      if (isArmor) tiers[i].modifiers.prots = granted;
      else tiers[i].modifiers.dmgTypes = granted;
      tiers[i].modifiers.prot = '';
    }
  }

  return {
    forgingData: { enabled, forgeMult, skillCheck, materials: forging.materials },
    forgingXP,
    refinementData: { tiers, relative: true }
  };
}

/* -------------------------------------------- */
/*  Material Lists                              */
/* -------------------------------------------- */

function buildMaterialRow(mat, idx) {
  const li = document.createElement('li');
  li.className = 'craft-material-item';
  li.dataset.idx = idx;
  li.innerHTML = `
    <img src="${escapeHtml(mat.img || FALLBACK_IMG)}" class="craft-material-img" data-tooltip="${escapeHtml(mat.name)}" />
    <span class="craft-material-name">${escapeHtml(mat.name)}</span>
    <span class="craft-material-x">×</span>
    <input type="number" class="craft-material-qty" value="${mat.quantity}" min="1" />
    <button type="button" class="craft-material-delete" data-tooltip="Remove"><i class="fas fa-trash"></i></button>
  `;
  return li;
}

/** The placeholder row for an empty list: a base that costs nothing, or a tier that inherits. */
function buildEmptyMessage(text) {
  const li = document.createElement('li');
  li.className = 'craft-material-empty';
  li.textContent = text;
  return li;
}

/** One row of the resource search dropdown, tagged with its type and its compendium. */
function buildSearchResult(entry) {
  const tag = entry.source
    ? `<span class="emblem-search-tag" data-tooltip="${escapeHtml(entry.source)}"><i class="fas fa-book"></i> ${escapeHtml(entry.resourceType)}</span>`
    : `<span class="emblem-search-tag">${escapeHtml(entry.resourceType)}</span>`;
  return `
    <div class="emblem-search-result" data-key="${escapeHtml(entry.uuid)}">
      <img src="${escapeHtml(entry.img || FALLBACK_IMG)}" class="emblem-search-img" />
      <span class="emblem-search-name">${escapeHtml(entry.name)}</span>
      ${tag}
    </div>
  `;
}

/**
 * Wire a material list, and return the function that redraws it. Also used by the Recipe Library's ingredients.
 *
 * The list is rebuilt on every change, since removing a row shifts every index below it. The array is changed in
 * place rather than replaced, because the search wired against it holds the same array.
 * @param {HTMLElement} list              The list element.
 * @param {object[]} materials            The working array.
 * @param {Function} [onChange]           Called after a removal.
 * @param {string} [emptyText]            The placeholder for an empty list.
 * @returns {Function}                    Redraws the list.
 */
export function wireMaterialList(list, materials, onChange, emptyText = 'No materials required') {
  const refresh = () => {
    list.innerHTML = '';
    if (materials.length === 0) {
      list.appendChild(buildEmptyMessage(emptyText));
      return;
    }
    materials.forEach((mat, idx) => {
      const li = buildMaterialRow(mat, idx);
      const openSheet = async () => {
        const item = await fromUuid(mat.uuid);
        if (item) item.sheet.render(true);
      };
      li.querySelector('.craft-material-img').addEventListener('click', openSheet);
      li.querySelector('.craft-material-name').addEventListener('click', openSheet);
      li.querySelector('.craft-material-qty').addEventListener('change', e => {
        materials[idx].quantity = Math.max(1, Number(e.target.value) || 1);
      });
      li.querySelector('.craft-material-delete').addEventListener('click', () => {
        materials.splice(idx, 1);
        refresh();
        onChange?.();
      });
      list.appendChild(li);
    });
  };
  refresh();
  return refresh;
}

/* -------------------------------------------- */
/*  Resource Search                             */
/* -------------------------------------------- */

/**
 * Bind the Resource search shared by the crafting dialogs and the Recipe Library. A pick matches an existing row by
 * name as well as UUID, because crafting consumes materials by name.
 * @param {HTMLElement} searchContainer                   The search box's container.
 * @param {HTMLInputElement} searchInput                  The search input.
 * @param {object[]} materials                            The working array.
 * @param {Function} refreshList                          Redraws the list.
 * @param {object} [options]
 * @param {string[]} [options.resourceTypes]              Which resource types to offer.
 * @returns {{close: Function, destroy: Function, refresh: Function}}
 */
export function wireSearch(searchContainer, searchInput, materials, refreshList, { resourceTypes = MATERIAL_RESOURCE_TYPES } = {}) {
  return wireSearchDropdown(searchInput, {
    candidates: () => resourcePool(resourceTypes),
    render: buildSearchResult,
    emptyText: 'No matching resources found',
    container: searchContainer,
    onPick: selected => {
      const existing = materials.find(m => m.uuid === selected.uuid || m.name === selected.name);
      if (existing) existing.quantity += 1;
      else materials.push({ uuid: selected.uuid, name: selected.name, img: selected.img || FALLBACK_IMG, quantity: 1 });
      refreshList();
    }
  });
}

/* -------------------------------------------- */
/*  Tabs                                        */
/* -------------------------------------------- */

/** Wire both levels of tab: forging against refinement, and the five tiers within refinement. */
function wireTabs(html) {
  const tabButtons = html.querySelectorAll('.craft-tab-btn');
  const tabPanes = html.querySelectorAll('.craft-tab-pane');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.toggle('is-active', b.dataset.tab === target));
      tabPanes.forEach(p => p.classList.toggle('is-hidden', p.dataset.tab !== target));
    });
  });

  const tierBtns = html.querySelectorAll('.craft-tier-btn');
  const tierPanels = html.querySelectorAll('.craft-tier-panel');
  tierBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tier;
      tierBtns.forEach(b => b.classList.toggle('active', b.dataset.tier === target));
      tierPanels.forEach(p => p.classList.toggle('is-hidden', p.dataset.tier !== target));
    });
  });
}

/* -------------------------------------------- */
/*  Tier Cascade                                */
/* -------------------------------------------- */

/**
 * The fields that cascade up through the tiers: the attack bonus is copied as is, and the XP requirement scales.
 * @type {Record<string, Function>}
 */
const CASCADE_FIELDS = {
  tierAtk: (value) => value,
  tierXpReq: (value, from, to) => String(Math.round((Number(value) || 0) * (to + 1) / (from + 1)))
};

/**
 * Whether a cascade field already holds a value someone chose. Blank and zero both count as unset, so a tier left at
 * its default can still be filled by the cascade.
 */
function isCascadeSet(field, value) {
  const v = String(value ?? '').trim();
  if (v === '') return false;
  return Number(v) !== 0;
}

/** Cascade values into untouched higher-tier fields. Manually edited fields are marked so later cascades skip them. */
function wireTierCascade(html) {
  for (const [field, project] of Object.entries(CASCADE_FIELDS)) {
    const inputs = Array.from({ length: TIER_COUNT }, (_, i) => html.querySelector(`[name='${field}_${i}']`));
    inputs.forEach(inp => {
      if (inp && isCascadeSet(field, inp.value)) inp.dataset.userset = 'true';
    });
    inputs.forEach((inp, i) => {
      if (!inp) return;
      inp.addEventListener('change', () => {
        inp.dataset.userset = 'true';
        const val = inp.value;
        for (let j = i + 1; j < TIER_COUNT; j++) {
          const higher = inputs[j];
          if (!higher || higher.dataset.userset === 'true') continue;
          higher.value = project(val, i, j);
        }
      });
    });
  }
}

/* -------------------------------------------- */
/*  Enable Toggles                              */
/* -------------------------------------------- */

/** A checkbox that greys its pane's body while off. The checkbox itself stays usable so it can be turned back on. */
function wireEnableToggle(html, name, paneSelector) {
  const box = html.querySelector(`[name='${name}']`);
  const pane = html.querySelector(paneSelector);
  if (!box || !pane) return;
  const apply = on => pane.classList.toggle('is-body-disabled', !on);
  apply(box.checked);
  box.addEventListener('change', () => apply(box.checked));
}

/**
 * The tier switches, kept in an unbroken run: switching a tier off switches off every tier above it, switching one
 * on switches on every tier below it, and each panel greys by its own switch.
 */
function wireTierGates(html) {
  const boxes = Array.from({ length: TIER_COUNT }, (_, i) => html.querySelector(`[name='tierEnabled_${i}']`));
  const apply = () => boxes.forEach((box, i) => {
    if (!box) return;
    html.querySelector(`.craft-tier-panel[data-tier="${i}"]`)?.classList.toggle('is-body-disabled', !box.checked);
    html.querySelector(`.craft-tier-btn[data-tier="${i}"]`)?.classList.toggle('is-off', !box.checked);
  });
  boxes.forEach((box, i) => box?.addEventListener('change', () => {
    if (box.checked) for (let j = 0; j < i; j++) { if (boxes[j]) boxes[j].checked = true; }
    else for (let j = i + 1; j < TIER_COUNT; j++) { if (boxes[j]) boxes[j].checked = false; }
    apply();
  }));
  apply();
}

/* -------------------------------------------- */
/*  Tier Sync                                   */
/* -------------------------------------------- */

/**
 * Controls the tier sync must not copy: the on switch and the XP requirement, which are this tier's own, and the
 * search boxes, which hold typed text rather than data.
 * @type {string[]}
 */
const SYNC_SKIP_PREFIXES = ['tierEnabled_', 'tierXpReq_', 'tierMaterialSearch_'];

/** The controls on a tier panel that the sync should copy. */
function syncableControls(panel) {
  return Array.from(panel.querySelectorAll('input[name], select[name]'))
    .filter(el => !SYNC_SKIP_PREFIXES.some(prefix => el.name.startsWith(prefix)));
}

/**
 * Copy the tier below into this one, except for its switch and XP requirement. The materials array is refilled in
 * place, because wireMaterialList and wireSearch hold on to it.
 * @param {Map} refreshers                The material-list redraw functions, by tier.
 */
function syncTierFromPrevious(html, tiers, index, refreshers) {
  const from = html.querySelector(`.craft-tier-panel[data-tier="${index - 1}"]`);
  const to = html.querySelector(`.craft-tier-panel[data-tier="${index}"]`);
  if (!from || !to) return;

  const sources = syncableControls(from);
  const targets = syncableControls(to);
  if (sources.length !== targets.length) return;

  for (let i = 0; i < targets.length; i++) {
    const src = sources[i];
    const dst = targets[i];
    if (dst.disabled) continue;
    if (dst.type === 'checkbox') {
      dst.checked = src.checked;
      const img = dst.closest('.craft-prot-toggle')?.querySelector('img');
      if (img) img.style.opacity = dst.checked ? '1' : '0.2';
    } else {
      dst.value = src.value;
      if (Object.keys(CASCADE_FIELDS).some(field => dst.name.startsWith(`${field}_`))) dst.dataset.userset = 'true';
    }
  }


  const materials = tiers[index].materials;
  materials.length = 0;
  materials.push(...foundry.utils.deepClone(tiers[index - 1].materials));
  refreshers.get(index)?.();
}

function wireTierSync(html, tiers, refreshers) {
  html.querySelectorAll('.craft-tier-sync').forEach(btn => {
    const index = Number(btn.dataset.tier);
    if (!(index > 0)) return;
    btn.addEventListener('click', () => syncTierFromPrevious(html, tiers, index, refreshers));
  });
}

/* -------------------------------------------- */
/*  Protections                                 */
/* -------------------------------------------- */

/** Dim a protection icon that isn't granted, so what a tier adds is readable at a glance. */
function wireProtToggles(html) {
  html.querySelectorAll('.craft-prot-toggle').forEach(toggle => {
    const cb = toggle.querySelector('input');
    const img = toggle.querySelector('img');
    if (!cb || !img || cb.disabled) return;
    cb.addEventListener('change', () => { img.style.opacity = cb.checked ? '1' : '0.2'; });
  });
}

/* -------------------------------------------- */
/*  Editor                                      */
/* -------------------------------------------- */

/** Wire the whole editor: tabs, switches, every material list and the tier helpers. */
function activateEditor(html, forging, tiers, showRefinement) {
  wireTabs(html);
  wireEnableToggle(html, 'forgingEnabled', '.craft-tab-pane[data-tab="forging"]');

  const forgingPane = html.querySelector('.craft-tab-pane[data-tab="forging"]');
  const forgingList = forgingPane?.querySelector('.craft-material-list');
  const forgingSearchContainer = forgingPane?.querySelector('.craft-material-search');
  const forgingSearchInput = html.querySelector("[name='materialSearch']");
  if (forgingList && forgingSearchContainer && forgingSearchInput) {
    const refreshForging = wireMaterialList(forgingList, forging.materials);
    wireSearch(forgingSearchContainer, forgingSearchInput, forging.materials, refreshForging);
  }

  if (!showRefinement) return;

  wireTierGates(html);
  wireTierCascade(html);
  wireProtToggles(html);

  const refreshers = new Map();
  for (let i = 0; i < TIER_COUNT; i++) {
    const tier = tiers[i];
    const list = html.querySelector(`.craft-material-list[data-tier="${i}"]`);
    const container = html.querySelector(`.craft-material-search[data-tier="${i}"]`);
    const input = html.querySelector(`[name='tierMaterialSearch_${i}']`);
    if (!list || !container || !input) continue;
    const refresh = wireMaterialList(list, tier.materials, undefined, 'Inherited');
    wireSearch(container, input, tier.materials, refresh);
    refreshers.set(i, refresh);
  }
  wireTierSync(html, tiers, refreshers);
}

/* -------------------------------------------- */
/*  Defaults                                    */
/* -------------------------------------------- */

/**
 * An empty tier, carrying both the weapon and armor stat fields so either kind of item can be authored into it.
 * @type {Function}
 */
const DEFAULT_TIER = () => ({
  enabled: false,
  xpReq: 0,
  forgeMult: null,
  skillCheck: '',
  materials: [],
  modifiers: {
    atk: null, brk: null, wgt: null, acc: null, crit: null, durability: null,
    stn: null, def: null, res: null, wgtRed: null, prots: {}, dmgTypes: {}, prot: ''
  }
});

/**
 * The damage-type toggles for a tier. The item's own types show as on and locked, because a tier can't take away
 * what the item already has. The caller reads them from `_source`, so an applied refinement's grants aren't
 * mistaken for the item's own.
 * @param {object} granted                The tier's own grants.
 * @param {object} base                   The item's own types.
 */
function typeIcons(granted, base) {
  return DAMAGE_TYPES.map(key => ({
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    img: `systems/${SYSTEM_ID}/assets/ui/dmg-types/${key}.png`,
    on: !!granted?.[key],
    locked: !!base?.[key]
  }));
}

/* -------------------------------------------- */
/*  Crafting Settings                           */
/* -------------------------------------------- */

/**
 * Open the equipment crafting settings from the Item sheet or the Item directory menu: forging cost and materials,
 * and five refinement tiers (staves have none). Forging XP shows only on an embedded copy, and the Item document
 * derives its name suffix from the saved tally.
 * @param {Item} item                     The weapon or armor.
 * @returns {Promise<void>}
 */
export async function openCraftingSettingsDialog(item) {

  const showRefinement = !NO_REFINEMENT_ITEM_TYPES.has(item.system.itemType);
  const isArmor = subtype(item) === 'Armor';
  const embedded = !!item.isEmbedded;

  const forging = foundry.utils.deepClone(item.system.craftingData.forging);
  if (!(Number(forging.forgeMult) > 0)) forging.forgeMult = 1;
  const forgingXP = Math.max(0, Number(item.system.craftingData.forgingXP) || 0);

  const storedTiers = item.system.craftingData.refinement.tiers;
  const tiers = Array.from({ length: TIER_COUNT }, (_, i) => foundry.utils.deepClone(storedTiers[i] ?? DEFAULT_TIER()));
  const base = isArmor ? item._source?.system?.armor?.prots : item._source?.system?.weapon?.dmgTypes;
  const tierViews = tiers.map((tier, index) => ({
    ...tier, index, typeIcons: typeIcons(isArmor ? tier.modifiers.prots : tier.modifiers.dmgTypes, base)
  }));

  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    forging, forgingXP, embedded, tiers: tierViews, showRefinement, isArmor, skills: FORGING_SKILLS
  });

  return openEditor({
    document: item,
    title: `Crafting Settings: ${item.name}`,
    icon: 'fas fa-hammer',
    resizable: false,
    position: { width: 450 },
    classes: ['dialog-crafting-settings'],
    content,
    gather: (root) => {
      const { forgingData, refinementData, forgingXP: tally } = gatherFormData(root, forging, tiers, showRefinement, isArmor);
      const updates = { 'system.craftingData.forging': forgingData };
      if (showRefinement) updates['system.craftingData.refinement'] = refinementData;
      if (embedded && tally !== null) updates['system.craftingData.forgingXP'] = tally;
      return updates;
    },
    apply: (updates) => item.update(updates),
    wire: (root) => activateEditor(root, forging, tiers, showRefinement)
  });
}

/* -------------------------------------------- */
/*  Consumable Crafting                         */
/* -------------------------------------------- */

/** Open a Potion's or Bomb's creation recipe from the Item sheet: materials, skill check and DC. */
export async function openConsumableCraftingDialog(item) {
  const creation = foundry.utils.deepClone(item.system.craftingData.creation);
  const content = await foundry.applications.handlebars.renderTemplate(CONSUMABLE_TEMPLATE, {
    creation,
    skills: CONSUMABLE_CRAFTING_SKILLS
  });
  return openEditor({
    document: item,
    title: `Crafting Settings: ${item.name}`,
    icon: 'fas fa-hammer',
    resizable: false,
    position: { width: 420 },
    classes: ['dialog-crafting-settings', 'dialog-consumable-crafting'],
    content,
    gather: root => gatherConsumableCreation(root, creation),
    apply: data => item.update({ 'system.craftingData.creation': data }),
    wire: root => wireConsumableCrafting(root, creation)
  });
}

function gatherConsumableCreation(root, creation) {
  return {
    materials: creation.materials,
    skillCheck: root.querySelector("[name='creationSkillCheck']").value || 'Nature',
    difficultyClass: Number(root.querySelector("[name='creationDC']").value) || 0
  };
}

function wireConsumableCrafting(root, creation) {
  const list = root.querySelector('.craft-material-list');
  const search = root.querySelector('.craft-material-search');
  const input = root.querySelector("[name='materialSearch']");
  if (!list || !search || !input) return;
  const refresh = wireMaterialList(list, creation.materials);
  wireSearch(search, input, creation.materials, refresh);
}

/* -------------------------------------------- */
/*  Item and Resource Queries                   */
/* -------------------------------------------- */

function subtype(item) {
  return item.system.itemType ?? '';
}

async function resourcePool(resourceTypes = MATERIAL_RESOURCE_TYPES) {
  const wanted = new Set(resourceTypes);
  const seen = new Set();
  const output = [];
  const add = entry => {
    const key = String(entry.name ?? '').toLowerCase();
    if (!wanted.has(entry.resourceType) || !key || seen.has(key)) return;
    seen.add(key);
    output.push(entry);
  };
  for (const entry of await readItemCatalog(['Resource'], { fields: ['system.resourceType'] })) {
    add({
      uuid: entry.uuid, name: entry.name, img: entry.img,
      resourceType: entry.system?.resourceType ?? '', source: entry.source
    });
  }
  return output.sort((left, right) => left.name.localeCompare(right.name));
}
