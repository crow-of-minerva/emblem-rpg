/** @layer ui/apps/sheets/character */
import { SYSTEM_ID } from '../../../../contracts/protocol.mjs';
import { CLASS_TIERS } from '../../../../contracts/domains/items.mjs';
import { skillRankLabel } from '../../../../game/character/rules.mjs';
import { PROFICIENCY_RANK_MAX, SKILL_RANK_MAX, SKILL_RANK_XP } from '../../../../game/progression/rules.mjs';
import { SUPPORT_MAX_RANK, SUPPORT_UNRANKED } from '../../../../contracts/domains/progression.mjs';
import {
  clampSupportRank,
  isSupportEligible,
  supportRankLetter,
  supportXpNeeded
} from '../../../../game/support/rules.mjs';
import { wireSearchDropdown } from '../../../../lib/dom/search-dropdown.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../../presentation/interface/notifications.mjs';

import { isDialogSubmission } from '../../../dialogs.mjs';
import { readItemCatalog } from '../../../../foundry/adapters/projections/items.mjs';
import { reportFoundryError, FoundryDiagnostics } from '../../../../foundry/adapters/services/diagnostics.mjs';

const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });
/**
 * The "Blank Novice/Intermediate/Advanced" choices in the Class picker. Their keys must match the Class item's
 * system fields, since any other key is dropped when the Class is created.
 */
const DEFAULT_CLASS_TEMPLATES = Object.freeze({
  Novice: {
    name: 'Novice', tier: 'Novice',
    baseStats: { hp: 20, stn: 1, mov: 5, bld: 5, mgt: 4, agi: 4, tqn: 4, wit: 4, cha: 4, def: 0, res: 0, spd: 0, eva: 8, acc: 0, crit: 0 },
    baseGrowths: { hp: 25, mgt: 25, agi: 25, tqn: 25, wit: 25, cha: 25, def: 25, res: 25 },
    baseCaps: { hp: 40, mgt: 10, agi: 10, tqn: 10, wit: 10, cha: 10, def: 10, res: 10 }
  },
  Intermediate: {
    name: 'Intermediate', tier: 'Intermediate',
    baseStats: { hp: 30, stn: 2, mov: 5, bld: 6, mgt: 6, agi: 6, tqn: 6, wit: 6, cha: 6, def: 0, res: 0, spd: 2, eva: 10, acc: 2, crit: 0 },
    baseGrowths: { hp: 30, mgt: 30, agi: 30, tqn: 30, wit: 30, cha: 30, def: 30, res: 30 },
    baseCaps: { hp: 50, mgt: 15, agi: 15, tqn: 15, wit: 15, cha: 15, def: 15, res: 15 }
  },
  Advanced: {
    name: 'Advanced', tier: 'Advanced',
    baseStats: { hp: 40, stn: 3, mov: 6, bld: 8, mgt: 8, agi: 8, tqn: 8, wit: 8, cha: 8, def: 0, res: 0, spd: 3, eva: 12, acc: 3, crit: 0 },
    baseGrowths: { hp: 35, mgt: 35, agi: 35, tqn: 35, wit: 35, cha: 35, def: 35, res: 35 },
    baseCaps: { hp: 60, mgt: 20, agi: 20, tqn: 20, wit: 20, cha: 20, def: 20, res: 20 }
  }
});

/* -------------------------------------------- */
/*  Character stat authoring                    */
/* -------------------------------------------- */
/**
 * Edit one stat's base value and base growth, and the shield value beside max HP. The class and modifier values are
 * shown read-only.
 */
export async function editCharacterStat(actor, stat) {
  const node = actor.system.stats[stat.key];
  const growth = stat.growth ? actor.system.growth[stat.growth] : null;
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/editors/stat-editor.hbs`,
    {
      value: node.base,
      classValue: node.class,
      modifiers: sumContributions(node),
      total: node.total,
      showShields: stat.key === 'hpMax',
      shields: actor.system.resources.shields.value ?? 0,
      showGrowth: Boolean(growth),
      growthValue: growth?.base ?? 0,
      growthClass: growth?.class ?? 0,
      growthModifiers: growth ? sumContributions(growth) : 0,
      growthTotal: growth?.total ?? 0
    }
  );
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Edit ${stat.label} Stat` },
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-stat-editor'],
    position: { width: 250 },
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'save', label: 'Save', icon: 'fas fa-save', default: true,
        callback: (_event, button) => ({
          value: Number(button.form.elements.value.value) || 0,
          shields: Math.max(0, Math.round(Number(button.form.elements.shields?.value) || 0)),
          growth: Number(button.form.elements.growthValue?.value) || 0
        })
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-times' }
    ]
  });
  if (!isDialogSubmission(result)) return;
  const update = { [`system.stats.${stat.key}.base`]: result.value };
  if (stat.key === 'hpMax') update['system.resources.shields.value'] = result.shields;
  if (stat.growth) update[`system.growth.${stat.growth}.base`] = result.growth;
  await actor.update(update);
}

/** Edit the unit's stored level and experience. An out-of-range entry shows a warning and keeps the dialog open. */
export async function editLevelExperience(actor) {
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/editors/level-xp-editor.hbs`,
    { level: actor.system.progression.level, experience: actor.system.progression.experience }
  );
  return openValidatedEditor({
    title: 'Edit Level & Experience',
    classes: ['dialog-level-xp-editor'],
    content,
    gather: form => {
      const level = Number(form.elements.level.value);
      const experience = Number(form.elements.experience.value);
      if (!(level >= 1 && level <= 99)) return warnEditor('Level must be 1 to 99.');
      if (!(experience >= 0 && experience <= 100)) return warnEditor('EXP must be 0 to 100.');
      return { level, experience };
    },
    apply: ({ level, experience }) => actor.update({
      'system.progression.level': level,
      'system.progression.experience': experience
    })
  });
}

/** Open an editor dialog. When `gather` returns nothing, Save does nothing and the window stays open. */
function openValidatedEditor({ title, classes = [], content, gather, apply, width = 250 }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dialog = new foundry.applications.api.DialogV2({
      window: { title },
      classes: [SYSTEM_ID, 'dialog-editor', ...classes],
      position: { width },
      content,
      form: { closeOnSubmit: false },
      buttons: [
        {
          action: 'save', label: 'Save', icon: 'fas fa-save', default: true,
          callback: (_event, button) => gather(button.form) ?? null
        },
        { action: 'cancel', label: 'Cancel', icon: 'fas fa-times', callback: () => 'cancel' }
      ],
      submit: async (result, app) => {
        if (result === 'cancel') return app.close();
        if (!result || typeof result !== 'object') return;
        await apply(result);
        finish(result);
        return app.close();
      }
    });
    dialog.addEventListener('close', () => finish(null));
    dialog.render({ force: true });
  });
}

function warnEditor(message) {
  notifications.show(NOTIFICATION_IDS.CHARACTER_SHEET_WARNING, { message });
  return undefined;
}

/* -------------------------------------------- */
/*  Skill and proficiency authoring             */
/* -------------------------------------------- */
/** Edit a skill's earned rank and experience. The class rank, total and die are shown read-only. */
export async function editSkill(actor, skill) {
  const node = actor.system.skills[skill.key];
  const total = Math.max(0, Math.min(SKILL_RANK_MAX, Number(node.total) || 0));
  const classRank = Number(node.class) || 0;
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/editors/skill-editor.hbs`,
    {
      value: Number(node.base) || 0,
      classLabel: classRank > 0 ? skillRankLabel(classRank) : '--',
      totalLabel: total > 0 ? `${total} (${skillRankLabel(total)})` : '0 (no die)',
      xp: Number(node.xp) || 0,
      xpMax: total >= SKILL_RANK_MAX ? '-- (max rank)' : SKILL_RANK_XP[total]
    }
  );
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Edit ${skill.label} Skill` },
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-skill-editor'],
    position: { width: 250 },
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'save', label: 'Save', icon: 'fas fa-save', default: true,
        callback: (_event, button) => ({
          value: Math.max(0, Math.floor(Number(button.form.elements.value.value) || 0)),
          xp: Math.max(0, Math.floor(Number(button.form.elements.xpValue.value) || 0))
        })
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-times' }
    ]
  });
  if (!isDialogSubmission(result)) return;
  await actor.update({
    [`system.skills.${skill.key}.base`]: result.value,
    [`system.skills.${skill.key}.xp`]: result.xp
  });
}

/** Edit a proficiency's earned rank and experience. The class rank and total are shown read-only. */
export async function editProficiency(actor, proficiency) {
  const node = actor.system.prof[proficiency.key];
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/editors/proficiency-editor.hbs`,
    {
      profValue: Number(node.base) || 0,
      profClass: Number(node.class) || 0,
      profTotal: Number(node.total) || 0,
      xpValue: Number(node.xp) || 0,
      neededXP: (Number(node.xpMax) || 0) - (Number(node.xp) || 0)
    }
  );
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Edit ${proficiency.label} Proficiency` },
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-proficiency-editor'],
    position: { width: 250 },
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'save', label: 'Save', icon: 'fas fa-save', default: true,
        callback: (_event, button) => ({
          value: Math.max(0, Math.min(PROFICIENCY_RANK_MAX, Math.floor(Number(button.form.elements.value.value) || 0))),
          xp: Math.max(0, Math.floor(Number(button.form.elements.xpValue.value) || 0))
        })
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-times' }
    ]
  });
  if (!isDialogSubmission(result)) return;
  await actor.update({
    [`system.prof.${proficiency.key}.base`]: result.value,
    [`system.prof.${proficiency.key}.xp`]: result.xp
  });
}

/* -------------------------------------------- */
/*  Support authoring                           */
/* -------------------------------------------- */
/**
 * Pick a unit to bond with. Returns the chosen uuid so the sheet, not the picker, records the bond.
 * @param {Actor} actor Character gaining the bond.
 * @returns {Promise<string|null>}
 */
export async function openAddSupportDialog(actor) {
  const candidates = eligibleSupportPartners(actor);
  if (!candidates.length) {
    notifications.show(NOTIFICATION_IDS.SUPPORT_WARNING, { message: 'No eligible actors to add as a Support.' });
    return null;
  }
  let chosen = null;
  await foundry.applications.api.DialogV2.wait({
    window: { title: 'Add Support', icon: 'fas fa-heart' },
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-add-support'],
    position: { width: 340 },
    content: '<div class="ed-container"><div class="support-add-search"><input type="text" placeholder="Search actors..." autocomplete="off"></div></div>',
    rejectClose: false,
    buttons: [{ action: 'cancel', label: 'Cancel', icon: 'fas fa-times' }],
    render: (_event, dialog) => {
      const input = dialog.element.querySelector('.support-add-search input');
      if (!input) return;
      wireSearchDropdown(input, {
        candidates: () => eligibleSupportPartners(actor),
        emptyText: 'No matching actors found',
        onPick: candidate => {
          chosen = candidate.uuid;
          dialog.close();
        }
      });
      input.focus();
    }
  });
  return chosen;
}

/**
 * Edit one of the Character's Support bonds and submit the list through commitSupportPartners. The GM's client
 * updates the matching entries on the old and new partner.
 * @param {Actor} actor Character whose bond is being edited.
 * @param {number} index Position of the bond on that Character.
 */
export async function openSupportEditorDialog(actor, index) {
  const partners = actor.system.support.partners.map(entry => ({ ...entry }));
  const entry = partners[index];
  if (!entry) return;

  const rank = clampSupportRank(entry.rank);
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/editors/support-editor.hbs`,
    {
      partnerOptions: supportPartnerOptions(actor, entry),
      rankOptions: supportRankOptions(rank),
      xp: Math.max(0, Number(entry.xp) || 0),
      needed: supportXpNeeded(rank)
    }
  );
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: 'Edit Support' },
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-support-editor'],
    position: { width: 340 },
    content,
    rejectClose: false,
    render: (_event, dialog) => wireSupportRankReadout(dialog.element),
    buttons: [
      {
        action: 'save',
        label: 'Save',
        icon: 'fas fa-save',
        default: true,
        callback: (_event, button) => ({
          partnerUuid: String(button.form.elements.partner.value ?? ''),
          rank: clampSupportRank(button.form.elements.rank.value),
          xp: Math.max(0, Math.trunc(Number(button.form.elements.xp.value) || 0))
        })
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-times' }
    ]
  });
  if (!isDialogSubmission(result)) return;
  if (partners.some((other, position) => position !== index && other.actorUUID === result.partnerUuid)) {
    return notifications.show(NOTIFICATION_IDS.SUPPORT_WARNING, { message: 'That actor is already a Support.' });
  }
  const partner = fromUuidSync(result.partnerUuid);
  partners[index] = {
    actorUUID: result.partnerUuid,
    name: partner?.name ?? entry.name ?? '',
    rank: result.rank,
    xp: result.xp
  };
  await commitSupportPartners(actor, partners);
}

/**
 * Send support edits as a command the GM's client runs, so both units update together even when the requester owns
 * only one. Refusals are already shown by the API, so none is added here.
 * @param {Actor} actor Character whose bonds are being replaced.
 * @param {Array<object>} partners The complete replacement list.
 * @returns {Promise<boolean>} Whether the edit was accepted.
 */
export async function commitSupportPartners(actor, partners) {
  const result = await game.emblemRpg.api.character.support.setPartners({
    actorUuid: actor.uuid,
    partners: partners.map(entry => ({
      actorUUID: String(entry.actorUUID ?? ''),
      name: String(entry.name ?? ''),
      rank: Math.trunc(Number(entry.rank ?? SUPPORT_UNRANKED)),
      xp: Math.max(0, Math.trunc(Number(entry.xp) || 0))
    }))
  });
  return result?.ok === true;
}

/* -------------------------------------------- */
/*  Support authoring helpers                   */
/* -------------------------------------------- */
function eligibleSupportPartners(actor) {
  const held = new Set(actor.system.support.partners.map(entry => entry.actorUUID));
  return game.actors
    .filter(candidate => candidate.uuid !== actor.uuid && !held.has(candidate.uuid)
      && isSupportEligible({ type: candidate.type, actorType: candidate.system.faction.role }))
    .map(candidate => ({ uuid: candidate.uuid, name: candidate.name, img: candidate.img }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function supportPartnerOptions(actor, entry) {
  const options = eligibleSupportPartners(actor);
  const current = fromUuidSync(entry.actorUUID);
  if (!options.some(option => option.uuid === entry.actorUUID)) {
    options.unshift({ uuid: entry.actorUUID, name: current?.name ?? entry.name ?? 'Unknown', img: current?.img });
  }
  return options.map(option => ({ ...option, selected: option.uuid === entry.actorUUID }));
}

function supportRankOptions(current) {
  return Array.from({ length: SUPPORT_MAX_RANK - SUPPORT_UNRANKED + 1 }, (_unused, offset) => {
    const value = SUPPORT_UNRANKED + offset;
    return {
      value,
      label: value < 0 ? 'Unranked' : `Rank ${supportRankLetter(value)}`,
      needed: supportXpNeeded(value),
      selected: value === current
    };
  });
}

/** Keep the read-only next-rank cost in step with the rank chosen in the editor. */
function wireSupportRankReadout(element) {
  const select = element.querySelector('select[name="rank"]');
  const readout = element.querySelector('.support-editor-needed');
  if (!select || !readout) return;
  select.addEventListener('change', () => {
    readout.value = select.selectedOptions[0]?.dataset.needed ?? readout.value;
  });
}

/* -------------------------------------------- */
/*  Class selection                             */
/* -------------------------------------------- */
/**
 * Open the tiered Class picker and replace the Character's Class through api.character.classes.assign. Called by the
 * Character sheet's selectClass action.
 * @param {Actor} actor Character being edited.
 * @param {Application} sheetApp Character sheet to refresh after assignment.
 * @returns {Promise<unknown>}
 */
export async function openClassSelectionDialog(actor, sheetApp) {
  const currentClass = actor.items.find(item => item.type === 'Class') ?? null;
  const allClasses = await collectClassEntries();
  if (!allClasses.length) return notifications.show(NOTIFICATION_IDS.CLASS_CATALOG_EMPTY);

  const grouped = Object.fromEntries(CLASS_TIERS.map(tier => [tier, []]));
  for (const entry of allClasses) grouped[entry.tier].push(entry);
  for (const tier of CLASS_TIERS) grouped[tier].sort((a, b) => a.name.localeCompare(b.name));

  const currentSource = currentClass?._stats?.compendiumSource ?? '';
  const currentName = normal(currentClass?.name);
  const selectedId = allClasses.find(entry => currentSource && entry.uuid === currentSource)?.uuid
    ?? allClasses.find(entry => currentName && normal(entry.name) === currentName)?.uuid
    ?? '';
  const byUuid = new Map(allClasses.map(entry => [entry.uuid, entry]));
  const sections = CLASS_TIERS.map(tier => ({
    tier,
    defaultId: DEFAULT_CLASS_TEMPLATES[tier] ? `default-${tier.toLowerCase()}` : null,
    defaultLabel: DEFAULT_CLASS_TEMPLATES[tier] ? `Blank ${tier}` : null,
    classes: grouped[tier].map(entry => ({
      id: entry.uuid, name: entry.name, img: entry.img, source: entry.source
    }))
  }));
  const content = await foundry.applications.handlebars.renderTemplate(
    `systems/${SYSTEM_ID}/templates/dialogs/class-selection.hbs`,
    { sections, selectedId }
  );

  return foundry.applications.api.DialogV2.wait({
    window: { title: 'Choose Class', resizable: false },
    position: { width: 450, height: 550 },
    classes: [SYSTEM_ID, 'dialog-editor', 'dialog-class-selection'],
    content,
    buttons: [
      {
        action: 'confirm', label: 'Confirm', icon: 'fas fa-save', default: true,
        callback: async (_event, _button, dialog) => {
          const selected = dialog.element.querySelector('.class-checkbox.checked')?.dataset.value;
          if (!selected) return notifications.show(NOTIFICATION_IDS.CLASS_SELECTION_REQUIRED);
          try {
            const selection = await resolveClassSelection(selected);
            if (!selection) return;
            const result = await game.emblemRpg.api.character.classes.assign({
              actorUuid: actor.uuid,
              classData: selection.data
            });
            if (result.ok) sheetApp.render();
          } catch (error) {
            reportFoundryError(import.meta.url, error, 'Emblem RPG | Class assignment failed');
            notifications.show(NOTIFICATION_IDS.CLASS_UPDATE_FAILED);
          }
        }
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-times' }
    ],
    render: (_event, dialog) => wireClassSelection(dialog.element, byUuid)
  });
}

/* -------------------------------------------- */
/*  Class selection helpers                     */
/* -------------------------------------------- */
async function collectClassEntries() {
  const entries = [];
  const seen = new Set();
  const add = (name, img, tier, uuid, source) => {
    const key = normal(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({ uuid, name, img, tier: CLASS_TIERS.includes(tier) ? tier : 'Unique', source });
  };
  for (const entry of await readItemCatalog(['Class'], { fields: ['system.tier'] })) {
    add(entry.name, entry.img, entry.system?.tier, entry.uuid, entry.source || null);
  }
  return entries;
}

async function resolveClassSelection(selected) {
  if (selected.startsWith('default-')) {
    const tier = CLASS_TIERS.find(value => normal(value) === selected.slice('default-'.length));
    const data = buildDefaultClassData(tier);
    if (!data) {
      notifications.show(NOTIFICATION_IDS.CLASS_TEMPLATE_UNAVAILABLE, { tier: tier ?? selected });
      return null;
    }
    return { data, label: `Blank ${tier} class` };
  }
  const selectedItem = await fromUuid(selected).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'selectedItem'); return null; });
  if (!selectedItem || selectedItem.type !== 'Class') {
    notifications.show(NOTIFICATION_IDS.CLASS_SOURCE_NOT_FOUND);
    return null;
  }
  const data = selectedItem.toObject();
  delete data._id;
  data._stats ??= {};
  data._stats.compendiumSource = selectedItem.uuid;
  return { data, label: `Class "${selectedItem.name}"` };
}

function buildDefaultClassData(tier) {
  const template = DEFAULT_CLASS_TEMPLATES[tier];
  if (!template) return null;
  return {
    name: template.name,
    type: 'Class',
    img: `systems/${SYSTEM_ID}/assets/ui/empty.png`,
    system: {
      tier: template.tier,
      baseStats: { ...template.baseStats },
      baseGrowths: { ...template.baseGrowths },
      baseCaps: { ...template.baseCaps }
    }
  };
}

function wireClassSelection(html, byUuid) {
  html.querySelectorAll('.class-tier-button').forEach(button => {
    button.addEventListener('click', event => {
      const tier = event.currentTarget.dataset.tier;
      html.querySelectorAll('.class-tier-button').forEach(entry => entry.classList.remove('is-active'));
      event.currentTarget.classList.add('is-active');
      html.querySelectorAll('.class-section').forEach(section => {
        section.classList.toggle('hidden', section.dataset.tier !== tier);
      });
    });
  });
  html.querySelectorAll('.class-label').forEach(label => {
    label.addEventListener('click', async event => {
      event.stopPropagation();
      event.preventDefault();
      const id = event.currentTarget.dataset.classId;
      if (!id || !byUuid.has(id)) return;
      const document = await fromUuid(id).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'document'); return null; });
      document?.sheet?.render(true);
    });
  });
  const selectClass = element => {
    html.querySelectorAll('.class-checkbox').forEach(entry => entry.classList.remove('checked'));
    html.querySelectorAll('.class-select-item').forEach(entry => entry.classList.remove('selected'));
    const item = element.classList.contains('class-checkbox') ? element.closest('.class-select-item') : element;
    item?.querySelector('.class-checkbox')?.classList.add('checked');
    item?.classList.add('selected');
  };
  html.querySelectorAll('.class-checkbox').forEach(checkbox => {
    checkbox.addEventListener('click', event => {
      event.stopPropagation();
      selectClass(event.currentTarget);
    });
  });
  html.querySelectorAll('.class-select-item').forEach(item => {
    item.addEventListener('click', event => {
      if (!event.target.classList.contains('class-label')) selectClass(event.currentTarget);
    });
  });
}

function normal(value) {
  return String(value ?? '').trim().toLowerCase();
}

function sumContributions(node) {
  return ['mod', 'penalty', 'item', 'passive'].reduce((total, key) => total + (Number(node[key]) || 0), 0);
}
