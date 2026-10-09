/** @layer ui/apps/menus */
import { defaultPerformer, pickableFirst, resolvePerformer } from './downtime-performer.mjs';
import {
  energyPips, menuShown, performerRows, rerenderMenu, rollLine, selectPerformer, showDowntimeMenu, submitMenu
} from './downtime-menu.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import {
  CRAFTING_KINDS, DEFAULT_BREW_SKILL, DEFAULT_FORGE_SKILL, materialNeeds, planBrewDelivery
} from '../../../game/downtime/crafting.mjs';
import { sanitizeHtml } from '../../../lib/dom/html.mjs';
import { playMenuSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/crafting-menu.hbs`;
const WINDOW_CLASS = 'window-crafting-menu';
const MENU_WIDTH = 1120;
const MENU_HEIGHT = 680;
const STATION_LABELS = Object.freeze({ [CRAFTING_KINDS.WORKSHOP]: 'Workshop', [CRAFTING_KINDS.LABORATORY]: 'Laboratory' });
/**
 * The kind filters for each station's list. The brewing filter lists recipes. The others list item copies in the
 * crafter's reach: its own and those in a Convoy it can reach.
 */
const KIND_FILTERS = Object.freeze({
  [CRAFTING_KINDS.WORKSHOP]: Object.freeze([
    Object.freeze({ key: 'all', label: 'All', kinds: Object.freeze(['weapon', 'armor']), title: 'Equipment', noun: 'equipment', one: 'a weapon or armor' }),
    Object.freeze({ key: 'weapons', label: 'Weapons', kinds: Object.freeze(['weapon']), title: 'Equipment', noun: 'weapons', one: 'a weapon' }),
    Object.freeze({ key: 'armor', label: 'Armor', kinds: Object.freeze(['armor']), title: 'Equipment', noun: 'armor', one: 'armor' })
  ]),
  [CRAFTING_KINDS.LABORATORY]: Object.freeze([
    Object.freeze({ key: 'consumables', label: 'Consumables', brew: true, kinds: Object.freeze([]), title: 'Recipes', noun: 'recipes', one: 'a recipe' }),
    Object.freeze({ key: 'staves', label: 'Staves', kinds: Object.freeze(['staff']), title: 'Staves', noun: 'staves', one: 'a staff' })
  ])
});
const OWNER_FILTERS = Object.freeze(['All', 'Carried', 'Convoy']);
/** The second filter group on the recipe list: each label keeps one Consumable subtype. */
const SUBTYPE_FILTERS = Object.freeze({ All: '', Potions: 'Potion', Bombs: 'Bomb' });
const KIND_NAMES = Object.freeze({ weapon: 'weapon', armor: 'armor', staff: 'staff' });

/* -------------------------------------------- */
/*  Crafting menu                               */
/* -------------------------------------------- */
/**
 * Show a Workshop's or Laboratory's jobs and the units that can work them, from the api.downtime.inspectCrafting
 * view. The button sends one api.downtime.forge or api.downtime.brew command, which rolls the check and applies the
 * result. A refusal made on this client, such as a busy host or a paused table, leaves the window open with the
 * picks; otherwise the window closes while the host runs the command.
 * @param {object} view The downtime query's crafting view.
 * @param {{refresh?: Function}} [handlers] Re-reads the view before the window is rebuilt.
 * @returns {Promise<boolean>} Resolves when the window closes, which is before the command answers, so the value
 *   does not report the outcome.
 */
export async function openCraftingMenu(view, { refresh = null } = {}) {
  if (menuShown(WINDOW_CLASS)) return false;
  const state = {
    tab: KIND_FILTERS[view.kind]?.[0]?.key ?? '', owner: OWNER_FILTERS[0], subtype: 'All', performerUuid: defaultPerformer(view),
    subjectUuid: null, tier: null, crafted: false, busy: false
  };
  await showDowntimeMenu({
    title: `${STATION_LABELS[view.kind] ?? 'Station'}: ${view.station.name}`,
    classes: [WINDOW_CLASS, `window-${view.kind}-menu`],
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    view, state, refresh, render, body: '.crafting-menu', confirmAction: 'craft', confirm: beginCrafting,
    actions: {
      filterKind: (menu, kind) => setFilter(menu, 'tab', kind.dataset.key),
      filterScope: (menu, scope) => setFilter(menu, scope.dataset.field, scope.dataset.label),
      previewTier,
      selectPerformer,
      selectItem: selectSubject
    }
  });
  return state.crafted;
}

/* -------------------------------------------- */
/*  View                                        */
/* -------------------------------------------- */
/**
 * Build the crafting template's context from the inspect view and the menu's picks. The first filter group picks
 * the kind of job. The second narrows item copies by owner, or recipes by Consumable subtype. Filters only hide rows,
 * so a picked job stays picked when a filter hides it. Rows the crafter can't work are listed after the ones it can,
 * and the footer line describes the job the button would send.
 */
function prepareCraftingView(view, state) {
  const filters = KIND_FILTERS[view.kind] ?? [];
  const filter = filters.find(entry => entry.key === state.tab) ?? filters[0];
  const brewing = filter?.brew === true;
  const active = resolvePerformer(view, state.performerUuid);
  const pool = brewing ? view.recipes ?? [] : reachableItems(view, filters, active);
  const subject = pool.find(entry => (brewing ? entry.uuid : entry.itemUuid) === state.subjectUuid) ?? null;
  const detail = subject && active
    ? (brewing ? brewDetail(subject, active, view.critMargin) : forgeDetail(subject, active, state)) : null;
  const skillSource = subject ?? sharedSkill(pool);
  const skillKey = skillSource?.skillKey ?? (brewing ? DEFAULT_BREW_SKILL : DEFAULT_FORGE_SKILL).toLowerCase();
  const skillLabel = skillSource?.skillLabel ?? (brewing ? DEFAULT_BREW_SKILL : DEFAULT_FORGE_SKILL);
  const performers = performerRows(view.performers ?? [], active, {
    skillLabel,
    dice: entry => ({ skillDie: entry.checks?.[skillKey]?.die, skillBonus: entry.checks?.[skillKey]?.bonus }),
    extra: entry => ({ pips: energyPips(entry) })
  });
  const owner = !brewing && OWNER_FILTERS.includes(state.owner) ? state.owner : OWNER_FILTERS[0];
  const subtype = brewing && Object.hasOwn(SUBTYPE_FILTERS, state.subtype) ? state.subtype : 'All';
  const visible = pool.filter(entry => (brewing
    ? !SUBTYPE_FILTERS[subtype] || entry.itemType === SUBTYPE_FILTERS[subtype]
    : filter.kinds.includes(entry.kind) && ownedBy(entry, owner, active)));
  const staves = !brewing && filter?.kinds.includes('staff');
  const rows = pickableFirst(visible.map(entry => subjectRow(entry, brewing, subject, active)), row => !row.short);
  const insufficient = Boolean(detail) && detail.materialsOk === false;
  const listEmpty = brewing
    ? 'No Consumable in this world has a crafting recipe authored.'
    : `No ${filter?.noun ?? 'items'} ${owner === 'Convoy' ? 'in the Convoy' : 'carried by this unit or the Convoy'} can be ${staves ? 'repaired' : 'forged'}.`;
  const selectPrompt = brewing ? 'Select a recipe to craft.' : `Select ${filter?.one ?? 'an item'} to ${staves ? 'repair' : 'forge'}.`;
  let blockTitle = '';
  if (!performers.length) blockTitle = 'No party member is on this map.';
  else if (!active) blockTitle = 'No party member can craft right now.';
  else if (!pool.length) blockTitle = listEmpty;
  else if (!detail) blockTitle = selectPrompt;
  else if (!detail.canCraft) blockTitle = detail.warning;
  const crafter = performers.find(entry => entry.selected) ?? null;
  return Object.freeze({
    station: view.station,
    stationLabel: STATION_LABELS[view.kind] ?? '',
    modeDesc: modeDescription(brewing, staves, view.critMargin),
    kindFilters: Object.freeze(filters.map(entry => Object.freeze({ key: entry.key, label: entry.label, selected: entry === filter }))),
    scopeFilters: Object.freeze((brewing ? Object.keys(SUBTYPE_FILTERS) : OWNER_FILTERS).map(label =>
      Object.freeze({ label, selected: label === (brewing ? subtype : owner) }))),
    isBrew: brewing,
    isForge: !brewing,
    listTitle: filter?.title ?? '',
    listMeta: brewing ? `${rows.length} of ${pool.length} recipe${pool.length === 1 ? '' : 's'}` : `${rows.length} of ${pool.length} in reach`,
    listEmpty: pool.length ? 'Nothing matches these filters.' : listEmpty,
    selectPrompt,
    performers,
    hasPerformers: performers.length > 0,
    onHand: onHandRows(active, detail),
    items: Object.freeze(rows),
    hasItems: rows.length > 0,
    subjectUuid: subject ? (brewing ? subject.uuid : subject.itemUuid) : '',
    detail,
    hasSelection: Boolean(detail),
    energyCost: view.energyCost,
    ticket: Object.freeze({
      blocked: blockTitle,
      bad: Boolean(detail) && !detail.canCraft,
      crafter: active?.name ?? '',
      verb: brewing ? 'crafts' : (detail?.repair ? 'repairs' : 'forges'),
      subject: detail?.title ?? '',
      roll: crafter ? rollLine(crafter, crafter.skillLabel) : ''
    }),
    canCraft: Boolean(detail?.canCraft) && Boolean(active) && state.busy !== true,
    buttonInsufficient: insufficient,
    buttonLabel: insufficient
      ? 'Insufficient Materials' : (detail?.buttonLabel ?? (brewing ? 'Craft' : staves ? 'Begin Repair' : 'Begin Forging')),
    buttonTitle: detail && !detail.canCraft && detail.warning ? detail.warning : ''
  });
}

/** The first job when every job in the list rolls the same skill, so the tiles can show it before a pick. */
function sharedSkill(pool) {
  const keys = new Set(pool.map(entry => entry.skillKey));
  return keys.size === 1 ? pool[0] : null;
}

/** Every item copy of a kind this station works on that the crafter can reach, or every copy with no crafter. */
function reachableItems(view, filters, active) {
  const kinds = new Set(filters.flatMap(entry => entry.kinds));
  return (view.items ?? []).filter(item => kinds.has(item.kind) && (!active || active.reach.includes(item.ownerUuid)));
}

function ownedBy(item, owner, active) {
  if (owner === 'All' || !active) return true;
  return (owner === 'Carried') === (item.ownerUuid === active.actorUuid);
}

function subjectRow(entry, brewing, subject, active) {
  const materialsOk = !active || materialNeeds(entry.materials, active.supplies ?? {}).every(need => need.ok);
  if (brewing) {
    return Object.freeze({
      uuid: entry.uuid, name: entry.name, image: entry.image, sub: entry.itemType, tier: '',
      tag: `DC ${entry.dc}`, tagClass: '', selected: subject === entry,
      short: !materialsOk, reason: materialsOk ? '' : 'Not enough Materials'
    });
  }
  let reason = '';
  if (entry.atFull) reason = `At full ${entry.kind === 'staff' ? 'Uses' : 'Durability'}`;
  else if (!materialsOk) reason = 'Not enough Materials';
  return Object.freeze({
    uuid: entry.itemUuid, name: entry.name, image: entry.image, sub: entry.ownerLabel, tier: entry.tier > 0 ? `+${entry.tier}` : '',
    tag: `${entry.usesCurrent}/${entry.usesMax}`, tagClass: durabilityClass(entry.usesCurrent, entry.usesMax),
    selected: subject === entry, short: Boolean(reason), reason
  });
}

/** Which band a durability figure falls into, for colouring. */
function durabilityClass(current, max) {
  const ratio = max > 0 ? current / max : 0;
  if (ratio >= 0.5) return 'dur-good';
  if (ratio >= 0.25) return 'dur-warn';
  return 'dur-bad';
}

/**
 * What the crafter can spend, one row per Resource name: the picked job's materials first with have/need, then the
 * rest. Food is left out unless the job asks for it, so a full larder does not bury the forge's materials.
 */
function onHandRows(active, detail) {
  if (!active) return Object.freeze([]);
  const needs = new Map((detail?.materials ?? []).map(entry => [entry.name, entry]));
  const stocked = active.onHand ?? Object.entries(active.supplies ?? {}).map(([name, amount]) => ({ name, image: '', amount }));
  const held = new Set(stocked.map(entry => entry.name));
  const missing = [...needs.values()].filter(entry => !held.has(entry.name))
    .map(entry => ({ name: entry.name, image: entry.image, amount: 0 }));
  const rows = [...missing, ...stocked].filter(entry => needs.has(entry.name) || (entry.food !== true && entry.amount > 0));
  return Object.freeze(pickableFirst(rows, entry => needs.has(entry.name)).map(entry => {
    const need = needs.get(entry.name) ?? null;
    return Object.freeze({
      name: entry.name, image: entry.image || need?.image || '', needed: Boolean(need), ok: need ? need.ok : true,
      amount: need ? `${need.have}/${need.need}` : String(entry.amount)
    });
  }));
}

function forgeDetail(item, performer, state) {
  const materials = materialNeeds(item.materials, performer.supplies ?? {});
  const materialsOk = materials.every(entry => entry.ok);
  const staff = item.kind === 'staff';
  let warning = '';
  if (item.atFull) warning = `This ${KIND_NAMES[item.kind] ?? 'item'} is at full ${staff ? 'Uses' : 'Durability'}`;
  else if (!materialsOk) warning = 'Not enough Materials';
  return Object.freeze({
    title: item.tier > 0 ? `${item.name} +${item.tier}` : item.name,
    name: item.name,
    tierLabel: item.tier > 0 ? `+${item.tier}` : '',
    image: item.image,
    description: sanitizeHtml(item.description ?? '').trim(),
    skill: item.skillLabel,
    forgeMult: item.forgeMult,
    materials,
    hasMaterials: materials.length > 0,
    materialsOk,
    refinement: staff ? null : refinementPreview(item, state.tier),
    repair: staff ? usesPreview(item) : null,
    canCraft: !item.atFull && materialsOk,
    warning,
    buttonLabel: staff ? 'Begin Repair' : 'Begin Forging'
  });
}

/** A staff's charges in place of the tier tabs: a staff is never refined, so its card shows what a repair refills. */
function usesPreview(item) {
  const max = Math.max(0, Number(item.usesMax) || 0);
  const current = Math.max(0, Number(item.usesCurrent) || 0);
  return Object.freeze({
    tallyText: `${current} / ${max}`,
    tallyPercent: max > 0 ? Math.min(100, Math.round(current / max * 100)) : 0,
    full: item.atFull === true,
    note: `A repair restores the ${item.skillLabel} roll ×${item.forgeMult} in Uses, up to ${Math.max(0, max - current)} more.`
  });
}

/**
 * The tier tabs under the card: one per tier the copy can reach, opening on the next one. The tally readout and the
 * bonus grid follow the open tab, and a tier the copy already holds reads as reached.
 */
function refinementPreview(item, pickedTier) {
  const tiers = item.tiers ?? [];
  if (!tiers.length) return null;
  const next = Math.min(item.tier + 1, tiers.length);
  const open = tiers.find(entry => entry.tier === pickedTier) ?? tiers[next - 1];
  const tally = Math.max(0, Number(item.forgingXP) || 0);
  return Object.freeze({
    heading: item.tier >= tiers.length ? `Top Tier (+${item.tier})` : `Next Tier (+${next})`,
    tabs: Object.freeze(tiers.map(entry => Object.freeze({
      tier: entry.tier, label: `+${entry.tier}`, reached: entry.reached, selected: entry === open
    }))),
    reached: open.reached,
    tallyText: open.reached ? 'Reached' : `${tally} / ${open.xpReq} Forging XP`,
    tallyPercent: open.reached || open.xpReq <= 0 ? 100 : Math.min(100, Math.round(tally / open.xpReq * 100)),
    bonuses: open.bonuses,
    gridClass: item.kind === 'armor' ? 'is-armor' : 'is-weapon'
  });
}

function brewDetail(recipe, performer, critMargin) {
  const materials = materialNeeds(recipe.materials, performer.supplies ?? {});
  const materialsOk = materials.every(entry => entry.ok);
  const delivery = brewDelivery(performer);
  let warning = '';
  if (!materialsOk) warning = 'Not enough Materials';
  else if (!delivery.ok) warning = `No room for it: ${performer.name}'s pockets are full and no Convoy is in reach`;
  return Object.freeze({
    title: recipe.name,
    name: recipe.name,
    tierLabel: '',
    image: recipe.image,
    description: sanitizeHtml(recipe.description ?? '').trim(),
    skill: recipe.skillLabel,
    dc: recipe.dc,
    materials,
    hasMaterials: materials.length > 0,
    materialsOk,
    yields: yieldBands(recipe.dc, critMargin),
    delivery,
    canCraft: materialsOk && delivery.ok,
    warning,
    buttonLabel: `Craft ${recipe.name}`
  });
}

/** Yield bands under a recipe: fail at the DC or below, make 1 above it, make 2 at DC + crit margin or more. */
function yieldBands(dc, critMargin) {
  const one = Math.max(0, Number(dc) || 0) + 1;
  const two = one - 1 + Math.max(1, Number(critMargin) || 1);
  return Object.freeze([
    Object.freeze({ label: `${one - 1} or less`, value: 'Fails', bad: true }),
    Object.freeze({ label: two - 1 > one ? `${one} to ${two - 1}` : String(one), value: 'Makes 1' }),
    Object.freeze({ label: `${two} or more`, value: 'Makes 2' })
  ]);
}

/**
 * Where the first brewed copy would go, worked out by planBrewDelivery, the plan the brew command delivers with.
 * `performer.reach` lists the unit first and the Convoy in its reach, if any, second.
 */
function brewDelivery(performer) {
  const limit = Number(performer.pocketLimit);
  const plan = planBrewDelivery({
    count: 1, pocketCount: performer.pocketCount, pocketLimit: Number.isFinite(limit) && limit > 0 ? limit : Infinity,
    performerUuid: performer.actorUuid, convoyUuid: performer.reach?.[1] ?? ''
  });
  const pockets = Number.isFinite(limit) && limit > 0 ? ` (${Number(performer.pocketCount) || 0}/${limit})` : '';
  if (plan.lost > 0) return Object.freeze({ ok: false, text: 'Nowhere (pockets full)' });
  return Object.freeze({
    ok: true,
    text: plan.deliveries[0]?.kind === 'convoy' ? 'The Convoy (pockets full)' : `${performer.name}'s pockets${pockets}`
  });
}

function modeDescription(brewing, staves, critMargin) {
  if (brewing) {
    return `Beat the DC on a skill check to craft one, or beat it by ${critMargin} for two. A failed craft still spends its materials.`;
  }
  if (staves) return 'Roll a skill check to restore the Uses of a Staff. Staves are repaired, never refined.';
  return "Roll a skill check to restore an item's Durability. Every point restored is tallied towards the item's next Refinement rank.";
}

async function render(view, state) {
  return globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, prepareCraftingView(view, state));
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */
/** Narrow the list by kind, owner or subtype and scroll it to the top. The picked job stays picked while hidden. */
function setFilter(menu, field, value) {
  if (menu.state.busy || !['tab', 'owner', 'subtype'].includes(field)) return;
  const next = String(value ?? '');
  if (!next || next === menu.state[field]) return;
  menu.state[field] = next;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu).then(() => menu.root.querySelector('.ws-items-panel .gm-panel-scroll')?.scrollTo(0, 0));
}

function previewTier(menu, tab) {
  if (menu.state.busy) return;
  menu.state.tier = Number(tab.dataset.tier) || null;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

function selectSubject(menu, row) {
  if (menu.state.busy) return;
  const uuid = String(row.dataset.uuid ?? '');
  if (uuid !== menu.state.subjectUuid) menu.state.tier = null;
  menu.state.subjectUuid = uuid;
  playMenuSound(SOUND_IDS.UI_BLIP_1);
  void rerenderMenu(menu);
}

/** Send the forge or brew command with the chosen crafter and item or recipe. */
async function beginCrafting(menu) {
  const { view, state } = menu;
  const prepared = prepareCraftingView(view, state);
  const performer = resolvePerformer(view, state.performerUuid);
  if (!performer || !prepared.canCraft || !prepared.subjectUuid || state.busy) return;
  const result = await submitMenu(menu, () => {
    const intent = {
      cursorTokenUuid: view.cursorTokenUuid, stationTokenUuid: view.stationTokenUuid, performerUuid: performer.actorUuid
    };
    return prepared.isBrew
      ? game.emblemRpg.api.downtime.brew({ ...intent, recipeUuid: prepared.subjectUuid })
      : game.emblemRpg.api.downtime.forge({ ...intent, itemUuid: prepared.subjectUuid });
  });
  state.crafted = result?.ok === true;
  state.busy = false;
}
