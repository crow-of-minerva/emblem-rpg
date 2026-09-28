/** @layer ui/apps/sheets/class */
import { SYSTEM_ID } from '../../../../contracts/protocol.mjs';
import { GROWTH_STATS, PROFICIENCIES, SKILL_RANK_DICE, SKILLS } from '../../../../game/character/rules.mjs';
import { SKILL_RANK_MAX } from '../../../../game/progression/rules.mjs';
import { resolveClassBundleStates } from '../../../../game/classes/rules.mjs';
import { CLASS_TIERS } from '../../../../contracts/domains/items.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../../presentation/interface/notifications.mjs';
import { canCurrentUserAuthor, EmblemSheetMixin, showTabPanels } from '../base.mjs';
import { escapeHtml } from '../../../../lib/dom/html.mjs';
import { getTooltip } from '../../../tooltips.mjs';
import { wireSearchDropdown } from '../../../../lib/dom/search-dropdown.mjs';
import { openEditor } from '../../../dialogs.mjs';
import { readDropPayload } from '../../../../foundry/adapters/services/host.mjs';
import { readItemCatalog } from '../../../../foundry/adapters/projections/items.mjs';
import { FoundryDiagnostics , reportFoundryError } from '../../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Class sheet                                 */
/* -------------------------------------------- */
const STAT_ROWS = Object.freeze([
  [['mgt', 'Mgt'], ['agi', 'Agi'], ['tqn', 'Tqn'], ['wit', 'Wit'], ['cha', 'Cha']],
  [['hp', 'HP'], ['stn', 'Stn'], ['def', 'Def'], ['res', 'Res'], ['eva', 'Eva']],
  [['mov', 'Mov'], ['bld', 'Bld'], ['spd', 'Spd'], ['acc', 'Acc'], ['crit', 'Crit']]
]);
const GROWTH_LABELS = Object.freeze({ hp: 'HP', mgt: 'Mgt', agi: 'Agi', tqn: 'Tqn', wit: 'Wit', cha: 'Cha', def: 'Def', res: 'Res' });
const UNIT_TYPES = Object.freeze([
  ['infantry', 'Infantry'], ['dragon', 'Dragon'], ['beast', 'Beast'], ['monster', 'Monster'], ['undead', 'Undead']
]);
const PROFICIENCY_PATH = `systems/${SYSTEM_ID}/assets/ui/proficiencies`;
const SKILL_PATH = `systems/${SYSTEM_ID}/assets/ui/skills`;
const UNIT_PATH = `systems/${SYSTEM_ID}/assets/ui/unit-types`;
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/** The sheet for Class items, registered in init/registrations.mjs. */
export class ClassSheet extends EmblemSheetMixin(foundry.applications.sheets.ItemSheetV2) {
  /* -------------------------------------------- */
  /*  Sheet configuration                         */
  /* -------------------------------------------- */
  static DEFAULT_TAB = 'overview';
  static DEFAULT_OPTIONS = {
    classes: ['item', 'class-sheet'],
    position: { width: 500, height: 545 },
    actions: {
      addBundle: ClassSheet.addBundle, addPromotion: ClassSheet.addPromotion,
      deleteBundle: ClassSheet.deleteBundle, deletePromotion: ClassSheet.deletePromotion,
      editBundle: ClassSheet.editBundle, editPromotion: ClassSheet.editPromotion,
      openUuid: ClassSheet.openUuid, selectFeature: ClassSheet.selectFeature, setTab: ClassSheet.setTab,
      stepProficiency: ClassSheet.stepProficiency, stepSkill: ClassSheet.stepSkill, toggleUnitType: ClassSheet.toggleUnitType
    },
    window: { title: 'Class Sheet', icon: 'fas fa-graduation-cap' }
  };

  /** Tabs and the feature and promotion links only change what is shown, so a read-only sheet keeps them. */
  static NAVIGATION_CONTROLS = ['.tab-button', '.feature-link', '.promotion-image', '.promotion-name'];

  /** Feature-choice boxes stay usable for owners, since a pick goes through the selectFeatures command. */
  static GAMEPLAY_CONTROLS = ['.feature-select-box'];

  static PARTS = { main: { template: `systems/${SYSTEM_ID}/templates/sheets/class-sheet.hbs` } };
  static SHEET_OPTIONS = {
    preserveScroll: false,
    imageStudio: true,
    editImage: { gmOnly: true, attrFromTarget: true, position: true }
  };

  /* -------------------------------------------- */
  /*  Sheet actions                               */
  /* -------------------------------------------- */
  static setTab(_event, target) {
    const tab = target.dataset.tab || 'overview';
    this._activeTab = tab;
    showTabPanels(this.element, tab, { controls: '.class-tab-nav [data-tab]', panels: '.class-tab-content[data-tab]' });
  }

  static async stepProficiency(_event, target) {
    if (!canCurrentUserAuthor(this.document)) return;
    const key = target.dataset.key;
    const current = this.document.system.proficiencies[key];
    const changes = {};
    let value;
    if (target.dataset.type === 'boolean') {
      value = !current;
      if (value && key === 'riding') changes['system.proficiencies.flying'] = false;
      if (value && key === 'flying') changes['system.proficiencies.riding'] = false;
    } else value = (Number(current) + 1) % (key === 'armor' ? 4 : 7);
    changes[`system.proficiencies.${key}`] = value;
    return this.document.update(changes);
  }

  static async stepSkill(_event, target) {
    if (!canCurrentUserAuthor(this.document)) return;
    const key = target.dataset.key;
    return this.document.update({ [`system.skills.${key}`]: ((Number(this.document.system.skills[key]) || 0) + 1) % (SKILL_RANK_MAX + 1) });
  }

  static async toggleUnitType(_event, target) {
    if (!canCurrentUserAuthor(this.document)) return;
    const key = target.dataset.key;
    return this.document.update({ [`system.unitType.${key}`]: !this.document.system.unitType[key] });
  }

  static addBundle() { if (canCurrentUserAuthor(this.document)) return openBundleEditor(this.document); }
  static addPromotion() { if (canCurrentUserAuthor(this.document)) return openPromotionEditor(this.document); }

  static editBundle(_event, target) {
    if (!canCurrentUserAuthor(this.document)) return;
    const id = target.closest('[data-bundle-id]')?.dataset.bundleId;
    const bundle = Array.from(this.document.system.features).find(entry => entry._id === id);
    if (!bundle) return;
    const reopenable = game.user.isGM && bundleStates(this.document, [normalizeBundle(bundle)])[0].skipped.some(Boolean);
    return openBundleEditor(this.document, bundle, { reopenable });
  }

  static editPromotion(_event, target) {
    if (!canCurrentUserAuthor(this.document)) return;
    const id = target.closest('[data-promotion-id]')?.dataset.promotionId;
    const promotion = Array.from(this.document.system.promotions).find(entry => entry._id === id);
    if (promotion) return openPromotionEditor(this.document, promotion);
  }

  static async deleteBundle(_event, target) {
    if (!canCurrentUserAuthor(this.document)) return;
    const id = target.closest('[data-bundle-id]')?.dataset.bundleId;
    return this.document.update({ 'system.features': foundry.utils.deepClone(Array.from(this.document.system.features)).filter(entry => entry._id !== id) });
  }

  static async deletePromotion(_event, target) {
    if (!canCurrentUserAuthor(this.document)) return;
    const id = target.closest('[data-promotion-id]')?.dataset.promotionId;
    return this.document.update({ 'system.promotions': foundry.utils.deepClone(Array.from(this.document.system.promotions)).filter(entry => entry._id !== id) });
  }

  static async openUuid(_event, target) {
    const uuid = target.dataset.uuid || target.closest('[data-uuid]')?.dataset.uuid;
    if (uuid) (await fromUuid(uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'openUuid'); return null; }))?.sheet?.render(true);
  }

  /**
   * Tick a feature box in a ready bundle on a Character's Class. Once the bundle's choice count is reached, confirm
   * the picks and send them to api.character.classes.selectFeatures.
   */
  static async selectFeature(_event, target) {
    const bundleElement = target.closest('[data-bundle-id]');
    const bundleId = bundleElement?.dataset.bundleId;
    const bundle = Array.from(this.document.system.features).find(entry => entry._id === bundleId);
    if (!bundle || this.document.parent?.type !== 'Character') return;
    target.classList.toggle('is-checked');
    const boxes = [...bundleElement.querySelectorAll('.feature-select-box')];
    const required = Math.min(Math.max(1, Number(bundle.choiceCount) || 1), boxes.length);
    const selected = boxes.filter(control => control.classList.contains('is-checked'));
    if (selected.length < required) return;
    if (selected.length > required) {
      target.classList.remove('is-checked');
      return notifications.show(NOTIFICATION_IDS.CLASS_FEATURE_CHOICE_INVALID, { required });
    }
    const indices = selected.map(control => Number(control.dataset.index));
    if (!await confirmClassFeatures(bundle, indices.map(index => bundle.items[index]))) {
      target.classList.remove('is-checked'); return;
    }
    const result = await game.emblemRpg.api.character.classes.selectFeatures({
      classUuid: this.document.uuid,
      bundleId,
      selectedIndices: indices
    });
    if (result.ok) this.render(false);
  }

  /* -------------------------------------------- */
  /*  Rendering and submission                    */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    if (!canCurrentUserAuthor(this.document)) return;
    this.element.querySelectorAll('[data-action="stepProficiency"],[data-action="toggleUnitType"]').forEach(control => control.addEventListener('contextmenu', event => {
      event.preventDefault();
      const path = control.dataset.action === 'toggleUnitType' ? `system.unitType.${control.dataset.key}` : `system.proficiencies.${control.dataset.key}`;
      this.document.update({ [path]: control.dataset.type === 'numeric' ? 0 : false });
    }));
    this.element.querySelectorAll('[data-action="stepSkill"]').forEach(control => control.addEventListener('contextmenu', event => {
      event.preventDefault(); this.document.update({ [`system.skills.${control.dataset.key}`]: 0 });
    }));
  }

  _prepareSubmitData(event, form, formData) {
    if (!canCurrentUserAuthor(this.document)) return {};
    const data = super._prepareSubmitData(event, form, formData);
    if ((data.system?.tier ?? this.document.system.tier) === 'Unplayable') return data;
    data.system ??= {}; data.system.baseStats ??= {};
    for (const key of GROWTH_STATS) {
      const stat = Number(data.system.baseStats[key] ?? this.document.system.baseStats[key]) || 0;
      const cap = Number(data.system.baseCaps?.[key] ?? this.document.system.baseCaps[key]) || 0;
      if (cap > 0 && stat > cap) data.system.baseStats[key] = cap;
    }
    return data;
  }

  /* -------------------------------------------- */
  /*  Sheet context                               */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.document;
    const actor = item.parent?.type === 'Character' ? item.parent : null;
    context.item = item; context.systemPath = `systems/${SYSTEM_ID}`; context.activeTab = this._activeTab ?? 'overview';
    context.pixelArt = item.getFlag(SYSTEM_ID, 'pixelArt') === true;
    const bust = context.pixelArt ? `?${item._stats?.modifiedTime ?? Date.now()}` : '';
    context.profileImg = `${item.img}${bust}`;
    context.tiers = CLASS_TIERS.map(value => ({ value, selected: value === item.system.tier }));
    context.isUnplayable = item.system.tier === 'Unplayable';
    context.statRows = STAT_ROWS.map(row => row.map(([key, label]) => ({ key, label, value: item.system.baseStats[key] })));
    context.growths = GROWTH_STATS.map(key => ({ key, label: GROWTH_LABELS[key], value: item.system.baseGrowths[key] }));
    context.caps = GROWTH_STATS.map(key => ({ key, label: GROWTH_LABELS[key], value: item.system.baseCaps[key] }));
    context.proficiencies = PROFICIENCIES.filter(entry => !entry.misc).map(entry => {
      const rank = Number(item.system.proficiencies[entry.key]) || 0;
      return { ...entry, rank, image: `${PROFICIENCY_PATH}/${entry.icon}${rank ? '' : '-off'}.png`, rankImage: `${PROFICIENCY_PATH}/${rank ? `rank${rank}` : 'norank'}.png` };
    });
    const armor = Number(item.system.proficiencies.armor) || 0;
    context.miscProficiencies = [
      { key: 'armor', label: ['None', 'Light Armor', 'Medium Armor', 'Heavy Armor'][armor], rank: armor, type: 'numeric', image: `${PROFICIENCY_PATH}/${['prof-armor-none', 'prof-armor-l', 'prof-armor-m', 'prof-armor-h'][armor]}.png` },
      { key: 'riding', label: 'Riding', type: 'boolean', active: item.system.proficiencies.riding, image: `${PROFICIENCY_PATH}/prof-riding${item.system.proficiencies.riding ? '' : '-off'}.png` },
      { key: 'flying', label: 'Flying', type: 'boolean', active: item.system.proficiencies.flying, image: `${PROFICIENCY_PATH}/prof-flying${item.system.proficiencies.flying ? '' : '-off'}.png` }
    ];
    context.unitTypes = UNIT_TYPES.map(([key, label]) => ({
      key, label, active: item.system.unitType[key],
      image: `${UNIT_PATH}/${key}${item.system.unitType[key] ? '' : '-off'}.png`
    }));
    context.skills = SKILLS.map(skill => {
      const rank = Number(item.system.skills[skill.key]) || 0;
      return {
        ...skill, rank, mastery: rank === SKILL_RANK_MAX, image: `${SKILL_PATH}/${skill.key}${rank ? '' : '-off'}.png`,
        badge: rank ? `d${SKILL_RANK_DICE[rank]}` : '--'
      };
    });

    const bundles = Array.from(item.system.features).map(normalizeBundle).sort((a, b) => a.lvl - b.lvl);
    const states = bundleStates(item, bundles);
    context.features = bundles.map((bundle, position) => {
      const { state, ownership, eligibility, skipped } = states[position];
      bundle.state = state;
      bundle.items = bundle.items.map((feature, index) => ({ ...feature, acquired: ownership[index], skipped: skipped[index], blocked: Boolean(actor) && !ownership[index] && !eligibility[index], opaque: !actor || ownership[index] || skipped[index] || (state === 'ready' && eligibility[index]), selectable: Boolean(actor) && state === 'ready' && !ownership[index] && eligibility[index], index }));
      return bundle;
    });
    context.needsFeaturePick = context.features.some(bundle => bundle.state === 'ready');
    context.promotions = Array.from(item.system.promotions).slice().sort((a, b) => Number(a.lvl) - Number(b.lvl)).map(promotion => {
      const proficiencyRequirements = PROFICIENCIES.filter(entry => !entry.misc && Number(promotion.proficiencies[entry.key]) > 0).map(entry => ({ ...entry, rank: promotion.proficiencies[entry.key], rankImage: `${PROFICIENCY_PATH}/rank${promotion.proficiencies[entry.key]}.png`, image: `${PROFICIENCY_PATH}/${entry.icon}.png` }));
      const skillRequirements = SKILLS.filter(entry => Number(promotion.skills[entry.key]) > 0).map(entry => ({ ...entry, badge: `d${SKILL_RANK_DICE[promotion.skills[entry.key]]}`, image: `${SKILL_PATH}/${entry.key}.png` }));
      return { ...promotion, proficiencyRequirements, skillRequirements, hasRequirements: proficiencyRequirements.length + skillRequirements.length > 0 };
    });
    return context;
  }
}
/* -------------------------------------------- */
/*  Class sheet helpers                         */
/* -------------------------------------------- */
function actorItemProjection(actor) {
  return [...(actor?.items ?? [])].map(item => ({ uuid: item.uuid, sourceId: String(item.flags?.core?.sourceId ?? ''), name: item.name }));
}

/** resolveClassBundleStates for these bundles of a Class, read against the Character holding it, if any. */
function bundleStates(classItem, bundles) {
  const actor = classItem.parent?.type === 'Character' ? classItem.parent : null;
  return resolveClassBundleStates({
    bundles,
    actorItems: actorItemProjection(actor),
    actorLevel: Number(actor?.system.progression.level) || 0,
    recordedBundles: actor?.flags?.[SYSTEM_ID]?.classChoices?.[classItem.id] ?? {}
  }, { owned: Boolean(actor) });
}

function normalizeBundle(value) {
  return {
    _id: value._id || foundry.utils.randomID(),
    lvl: Math.max(1, Number(value.lvl) || 1), acquisitionType: value.acquisitionType || 'all',
    choiceCount: Math.max(1, Number(value.choiceCount) || 1), unique: value.unique === true,
    exceptions: String(value.exceptions ?? ''),
    items: Array.from(value.items ?? []).map(item => ({
      uuid: String(item.uuid ?? ''), name: String(item.name ?? 'Unnamed'), img: String(item.img ?? 'icons/svg/item-bag.svg'),
      type: String(item.type ?? 'Ability'), replace: item.replace ?? { uuid: '', name: '', img: '' },
      replaceName: String(item.replace?.name ?? '')
    }))
  };
}

/* -------------------------------------------- */
/*  Feature bundles                             */
/* -------------------------------------------- */
const GRANT_TYPES = new Set(['Ability', 'Spell']);

/**
 * Add or edit a feature bundle: the Abilities and Spells the Class grants at a level, how many a unit picks, and
 * what each one replaces. openEditor saves it into `system.features`. `reopenable` offers a GM the reopen box for an
 * automatic bundle that skipped an upgrade; saving with it ticked sends api.character.classes.reopenBundle.
 */
async function openBundleEditor(classItem, existing = null, { reopenable = false } = {}) {
  const bundle = foundry.utils.deepClone(existing ?? {
    _id: foundry.utils.randomID(), lvl: 1, acquisitionType: 'all', choiceCount: 1,
    unique: false, exceptions: '', items: []
  });
  bundle._id ||= foundry.utils.randomID();
  const pool = async () => (await candidates()).map(entry => ({ ...entry, tag: entry.source }));
  const content = foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/dialogs/class/bundle-editor.hbs`, { bundle, reopenable }
  );

  return openEditor({
    document: classItem,
    title: existing ? 'Edit Feature Bundle' : 'New Feature Bundle',
    classes: ['dialog-bundle-editor'], position: { width: 460 }, content,
    wire: root => {
      const list = root.querySelector('.bundle-items');
      const refresh = () => {
        list.innerHTML = bundle.items.map(rowMarkup).join('');
        list.querySelectorAll('.bundle-item-img,.bundle-item-name').forEach(control => control.addEventListener('click', async () => {
          const ref = bundle.items[Number(control.closest('[data-index]').dataset.index)];
          (await fromUuid(ref.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'refresh'); return null; }))?.sheet?.render(true);
        }));
        list.querySelectorAll('.bundle-item-delete').forEach(button => button.addEventListener('click', () => {
          bundle.items.splice(Number(button.dataset.index), 1); refresh();
        }));
        list.querySelectorAll('.bundle-replace-clear').forEach(button => button.addEventListener('click', () => {
          bundle.items[Number(button.dataset.index)].replace = { uuid: '', name: '', img: '' }; refresh();
        }));
        list.querySelectorAll('.bundle-replace-drop').forEach(zone => {
          zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('is-hover'); });
          zone.addEventListener('dragleave', () => zone.classList.remove('is-hover'));
          zone.addEventListener('drop', async event => {
            event.preventDefault(); zone.classList.remove('is-hover');
            const data = readDropPayload(event);
            const dropped = data?.uuid ? await fromUuid(data.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'dropped'); return null; }) : null;
            if (!dropped || !GRANT_TYPES.has(dropped.type)) return notifications.show(NOTIFICATION_IDS.FEATURE_TYPE_REQUIRED);
            bundle.items[Number(zone.dataset.index)].replace = { uuid: dropped.uuid, name: dropped.name, img: dropped.img };
            refresh();
          });
        });
      };
      refresh();
      const acquisition = root.querySelector('[name="bundleAcquisitionType"]');
      acquisition.addEventListener('change', () => root.querySelector('.bundle-editor-choice-count').classList.toggle('is-hidden', acquisition.value !== 'choice'));
      const unique = root.querySelector('[name="bundleUnique"]');
      unique.addEventListener('change', () => root.querySelector('.bundle-editor-exceptions').classList.toggle('is-hidden', !unique.checked));
      wireSearchDropdown(root.querySelector('[name="itemSearch"]'), {
        container: root.querySelector('.bundle-editor-add'),
        candidates: pool,
        limit: 30,
        emptyText: 'No matching items found',
        onPick: async candidate => {
        if (bundle.items.some(item => item.uuid === candidate.uuid)) return;
        const item = await fromUuid(candidate.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'item'); return null; });
        if (!item) return notifications.show(NOTIFICATION_IDS.FEATURE_NOT_FOUND, { name: candidate.name });
        if (item.type === 'Ability' && item.system?.itemType === 'Mount') {
          const known = await pool();
          const currentMount = bundle.items.some(ref => known.find(entry => entry.uuid === ref.uuid)?.itemType === 'Mount');
          if (currentMount || await hasAnotherMount(classItem, bundle)) return notifications.show(NOTIFICATION_IDS.CLASS_MOUNT_EXISTS);
        }
        bundle.items.push({ uuid: item.uuid, name: item.name, img: item.img, type: item.type, replace: { uuid: '', name: '', img: '' } });
        refresh();
        }
      });
    },
    gather: root => ({
      lvl: Math.max(1, Number(root.querySelector('[name="bundleLvl"]').value) || 1),
      acquisitionType: root.querySelector('[name="bundleAcquisitionType"]').value,
      choiceCount: Math.max(1, Number(root.querySelector('[name="bundleChoiceCount"]').value) || 1),
      unique: root.querySelector('[name="bundleUnique"]').checked,
      exceptions: root.querySelector('[name="bundleUnique"]').checked ? root.querySelector('[name="bundleExceptions"]').value.trim() : '',
      reopen: root.querySelector('[name="bundleReopen"]')?.checked === true
    }),
    apply: async ({ reopen, ...fields }) => {
      const features = foundry.utils.deepClone(Array.from(classItem.system.features));
      const index = features.findIndex(entry => entry._id === bundle._id);
      const value = { ...bundle, ...fields };
      if (index < 0) features.push(value); else features[index] = value;
      await classItem.update({ 'system.features': features });
      if (reopen) await game.emblemRpg.api.character.classes.reopenBundle({ classUuid: classItem.uuid, bundleId: bundle._id });
    }
  });
}

async function candidates() {
  const entries = [];
  for (const entry of await readItemCatalog(GRANT_TYPES, { fields: ['system.itemType'] })) {
    entries.push({
      uuid: entry.uuid,
      name: entry.name,
      img: entry.img,
      type: entry.type,
      itemType: entry.system?.itemType ?? '',
      source: entry.source
    });
  }
  return entries;
}

/** Whether another bundle on this Class already grants a Mount, since a Class may grant only one. */
async function hasAnotherMount(classItem, current) {
  for (const bundle of classItem.system.features) {
    if (bundle._id === current._id) continue;
    for (const ref of bundle.items) {
      const item = await fromUuid(ref.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'item'); return null; });
      if (item?.type === 'Ability' && item.system?.itemType === 'Mount') return true;
    }
  }
  return false;
}

function rowMarkup(item, index) {
  const replace = item.replace.name
    ? `<img src="${escapeHtml(item.replace.img)}" class="bundle-replace-img">`
      + `<span class="bundle-replace-name">${escapeHtml(item.replace.name)}</span>`
      + `<button type="button" class="bundle-replace-clear" data-index="${index}">`
      + '<i class="fas fa-times"></i></button>'
    : '<span class="bundle-replace-placeholder">Drag Feature to Replace</span>';
  const feature = `<img src="${escapeHtml(item.img)}" class="bundle-item-img">`
    + `<span class="bundle-item-name">${escapeHtml(item.name)}</span><small>(${escapeHtml(item.type)})</small>`;
  return `<li class="bundle-item" data-index="${index}">
    <div class="bundle-item-row">${feature}</div>
    <div class="bundle-replace-drop ${item.replace.name ? 'is-filled' : ''}" data-index="${index}" data-tooltip="${escapeHtml(getTooltip('class.bundle-replace'))}">${replace}</div>
    <button type="button" class="bundle-item-delete" data-index="${index}"><i class="fas fa-trash"></i></button>
  </li>`;
}

/* -------------------------------------------- */
/*  Promotions                                  */
/* -------------------------------------------- */
const PROMOTION_PROFICIENCIES = PROFICIENCIES.filter(entry => !entry.misc);

/**
 * Add or edit a promotion: the Class it leads to, its level, the Promotion item it uses, and the proficiency and
 * skill ranks it requires. openEditor saves it into `system.promotions`.
 */
async function openPromotionEditor(classItem, existing = null) {
  const promotion = normalizePromotion(existing);
  const pool = async () => (await classCandidates()).map(entry => ({ ...entry, tag: entry.source }));
  const context = {
    promotion,
    systemPath: `systems/${SYSTEM_ID}`,
    proficiencies: PROMOTION_PROFICIENCIES.map(entry => ({ ...entry, rank: promotion.proficiencies[entry.key] })),
    skills: SKILLS.map(entry => ({ ...entry, rank: promotion.skills[entry.key], badge: skillBadge(promotion.skills[entry.key]) }))
  };
  const content = foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/dialogs/class/promotion-editor.hbs`, context
  );
  return openEditor({
    document: classItem,
    title: existing ? 'Edit Promotion' : 'New Promotion',
    classes: ['dialog-promotion-editor'], position: { width: 440 }, content,
    wire: root => {
      const selected = root.querySelector('.selected-class');
      const promotionDrop = root.querySelector('.promotion-item-drop');
      const refreshClass = () => {
        selected.innerHTML = promotion.classUuid
          ? `<img src="${escapeHtml(promotion.classImg)}" class="selected-class-img">`
            + `<span class="selected-class-name">${escapeHtml(promotion.className)}</span>`
            + '<button type="button" class="clear-class"><i class="fas fa-times"></i></button>'
          : '<span class="selected-class-empty">No class selected</span>';
        selected.querySelector('.clear-class')?.addEventListener('click', () => {
          promotion.classUuid = ''; promotion.className = ''; promotion.classImg = 'icons/svg/item-bag.svg'; refreshClass();
        });
      };
      const refreshPromotionItem = () => {
        promotionDrop.classList.toggle('has-item', Boolean(promotion.promotionItem.uuid));
        promotionDrop.innerHTML = promotion.promotionItem.uuid
          ? `<img src="${escapeHtml(promotion.promotionItem.img)}" class="promotion-item-img">`
            + `<span class="promotion-item-name">${escapeHtml(promotion.promotionItem.name)}</span>`
            + '<button type="button" class="clear-promotion-item"><i class="fas fa-times"></i></button>'
          : '<span class="promotion-item-empty">Drop a Promotion item here</span>';
        promotionDrop.querySelector('.clear-promotion-item')?.addEventListener('click', () => {
          promotion.promotionItem = { uuid: '', name: '', img: '' }; refreshPromotionItem();
        });
      };
      refreshClass(); refreshPromotionItem();
      wireSearchDropdown(root.querySelector('[name="classSearch"]'), {
        container: root.querySelector('.class-add'),
        candidates: pool,
        limit: 30,
        emptyText: 'No matching classes found',
        onPick: entry => {
          promotion.classUuid = entry.uuid;
          promotion.className = entry.name;
          promotion.classImg = entry.img;
          refreshClass();
        }
      });
      promotionDrop.addEventListener('dragover', event => { event.preventDefault(); promotionDrop.classList.add('drag-over'); });
      promotionDrop.addEventListener('dragleave', () => promotionDrop.classList.remove('drag-over'));
      promotionDrop.addEventListener('drop', async event => {
        event.preventDefault(); promotionDrop.classList.remove('drag-over');
        const data = readDropPayload(event);
        const item = data?.uuid ? await fromUuid(data.uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'item'); return null; }) : null;
        if (!item || item.type !== 'Consumable' || item.system?.itemType !== 'Promotion') return notifications.show(NOTIFICATION_IDS.PROMOTION_ITEM_REQUIRED);
        promotion.promotionItem = { uuid: item.uuid, name: item.name, img: item.img }; refreshPromotionItem();
      });
      root.querySelectorAll('.pe-prof-item').forEach(control => {
        const key = control.dataset.key;
        const refresh = () => {
          const rank = promotion.proficiencies[key];
          control.querySelector('.pe-rank-icon').src = `systems/${SYSTEM_ID}/assets/ui/proficiencies/${PROMOTION_PROFICIENCIES.find(entry => entry.key === key).icon}${rank ? '' : '-off'}.png`;
          control.querySelector('.pe-rank-badge').src = `systems/${SYSTEM_ID}/assets/ui/proficiencies/${rank ? `rank${rank}` : 'norank'}.png`;
        };
        control.addEventListener('click', () => { promotion.proficiencies[key] = (promotion.proficiencies[key] + 1) % 7; refresh(); });
        control.addEventListener('contextmenu', event => { event.preventDefault(); promotion.proficiencies[key] = 0; refresh(); });
      });
      root.querySelectorAll('.pe-skill-item').forEach(control => {
        const key = control.dataset.key;
        const refresh = () => {
          const rank = promotion.skills[key];
          control.querySelector('.pe-rank-icon').src = `systems/${SYSTEM_ID}/assets/ui/skills/${key}${rank ? '' : '-off'}.png`;
          control.querySelector('.pe-skill-badge').textContent = skillBadge(rank);
          control.querySelector('.pe-skill-badge').classList.toggle('is-zero', !rank);
        };
        control.addEventListener('click', () => { promotion.skills[key] = (promotion.skills[key] + 1) % (SKILL_RANK_MAX + 1); refresh(); });
        control.addEventListener('contextmenu', event => { event.preventDefault(); promotion.skills[key] = 0; refresh(); });
      });
    },
    gather: root => {
      if (!promotion.classUuid) { notifications.show(NOTIFICATION_IDS.PROMOTION_CLASS_REQUIRED); return undefined; }
      return { lvl: Math.max(1, Number(root.querySelector('[name="promotionLvl"]').value) || 1) };
    },
    apply: fields => {
      const promotions = foundry.utils.deepClone(Array.from(classItem.system.promotions));
      const index = promotions.findIndex(entry => entry._id === promotion._id);
      const value = { ...promotion, ...fields };
      if (index < 0) promotions.push(value); else promotions[index] = value;
      return classItem.update({ 'system.promotions': promotions });
    }
  });
}

function skillBadge(rank) {
  return rank > 0 ? `d${[0, 4, 6, 8, 10][rank]}` : '--';
}

async function classCandidates() {
  const out = [];
  for (const entry of await readItemCatalog(['Class'])) {
    out.push({ uuid: entry.uuid, name: entry.name, img: entry.img, source: entry.source });
  }
  return out;
}

function normalizePromotion(existing) {
  const value = foundry.utils.deepClone(existing ?? {});
  value._id ||= foundry.utils.randomID();
  value.lvl = Math.max(1, Number(value.lvl) || 1);
  value.classUuid ||= '';
  value.className ||= '';
  value.classImg ||= 'icons/svg/item-bag.svg';
  value.promotionItem ??= { uuid: '', name: '', img: '' };
  value.proficiencies ??= {};
  value.skills ??= {};
  for (const entry of PROMOTION_PROFICIENCIES) value.proficiencies[entry.key] = Number(value.proficiencies[entry.key]) || 0;
  for (const entry of SKILLS) value.skills[entry.key] = Number(value.skills[entry.key]) || 0;
  return value;
}

/* -------------------------------------------- */
/*  Feature choices                             */
/* -------------------------------------------- */
/** Ask the player to confirm the features picked in a bundle before selectFeature sends them. */
async function confirmClassFeatures(bundle, selectedItems) {
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/dialogs/class/feature-selector.hbs`,
    { count: selectedItems.length, items: selectedItems.map(item => ({ ...item, replaceName: item.replace?.name ?? '' })) }
  );
  return (await foundry.applications.api.DialogV2.wait({
    window: { title: `Confirm Features: Level ${bundle.lvl}`, resizable: false },
    position: { width: 520 },
    classes: [SYSTEM_ID, 'dialog-feature-selector'],
    content,
    buttons: [
      { action: 'ok', label: 'Confirm Selection', icon: 'fas fa-check', default: true, callback: () => true },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-times', callback: () => false }
    ]
  })) === true;
}
