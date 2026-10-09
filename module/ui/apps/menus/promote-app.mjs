/** @layer ui/apps/menus */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { PROFICIENCY_RANK_LETTERS } from '../../../contracts/domains/items.mjs';
import { PROMOTION_PROFICIENCY_KEYS } from '../../../contracts/domains/progression.mjs';
import {
  currentProficiencies,
  promotionBarRows,
  resolveClassPreviewArt,
  resolvePromotionOptions,
  utilityProficiencyRows
} from '../../../game/classes/promotion.mjs';
import { activationCinematicCategory } from '../../../game/items/activation.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { trimmedSpriteBox } from '../../../lib/dom/image-trim.mjs';
import { projectPromotionPreview } from '../../../foundry/adapters/projections/characters.mjs';
import { resolveItem } from '../../../foundry/adapters/services/host.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../presentation/interface/notifications.mjs';
import { playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import {
  holdMovementIndicator,
  resumeMovementAfterTargeting,
  settleMovementAnimation,
  suspendMovementForTargeting
} from '../../controls/movement.mjs';
import { captureForDialog, openBlockingDialog } from '../../dialogs.mjs';
import { FoundryDiagnostics } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Preview vocabulary                          */
/* -------------------------------------------- */
const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/promote-preview.hbs`;
const PROFICIENCY_PATH = `systems/${SYSTEM_ID}/assets/ui/proficiencies`;
const UNIT_TYPE_PATH = `systems/${SYSTEM_ID}/assets/ui/unit-types`;
const PROFICIENCY_LABELS = Object.freeze({
  brawling: 'Brawling', blade: 'Blade', polearm: 'Polearm', heavy: 'Heavy', bow: 'Bow', covert: 'Covert',
  elemental: 'Elemental', divine: 'Divine', occult: 'Occult', arcane: 'Arcane', riding: 'Riding', armor: 'Armor'
});

/** The icon under assets/ui/unit-types for each unit type label that mountSummary gives a Mount. */
const MOUNT_TYPE_ICONS = Object.freeze({
  Cavalry: 'cavalry', Flying: 'flying', Dragon: 'dragon', Beast: 'beast', Monstrosity: 'monster', Undead: 'undead'
});
const MOUNT_FALLBACK_ICON = `${PROFICIENCY_PATH}/prof-riding-on.png`;
const WINDOW_WIDTH = 860;

/** The header's sprite box. A trimmed figure is drawn at 1x inside it and shrinks only when it would not fit. */
const THUMB_WIDTH = 48;
const THUMB_HEIGHT = 54;
/** The art resolveClassPreviewArt gives a class with none, and what a header box shows when its art fails. */
const THUMB_FALLBACK = 'icons/svg/mystery-man.svg';
const TONES = Object.freeze(['is-up', 'is-down', 'is-none']);
const PROMOTION_CINEMATIC_CATEGORY = activationCinematicCategory({ type: 'Consumable', subtype: 'Promotion' });

const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Promotion sequence                          */
/* -------------------------------------------- */

/**
 * Show a unit's promotion paths from projectPromotionPreview and send the chosen one to
 * api.character.classes.promote. This is the public api.character.classes.openPromotion (wired in init/system.mjs),
 * and activatePromotionItem below calls it too. Paths the unit can't take are listed with their requirements.
 * Movement is suspended while the host checks and applies the promotion.
 * @param {string} tokenUuid Token being promoted.
 * @param {string} actorUuid Its unit.
 * @param {string} [usedItemId] The Promotion item being spent, when one is.
 * @param {{bypassItem?: boolean, bypassRequirements?: boolean, namedTurnRefusal?: boolean}} [options]
 *   `bypassRequirements` is the GM Macros compendium's Promote Unit: every path is offered, whatever the unit's
 *   level, proficiencies, skills or remaining turn.
 * @returns {Promise<boolean>} Whether the promote command succeeded.
 */
export async function beginPromotionSequence(tokenUuid, actorUuid, usedItemId = '',
  { bypassItem = false, bypassRequirements = false, namedTurnRefusal = false } = {}) {
  const snapshot = await projectPromotionPreview(actorUuid, { usedItemId, tokenUuid });
  if (!snapshot) return refuse('No actor found to promote.');
  if (snapshot.turnOver && !bypassRequirements) {
    return refuse(namedTurnRefusal ? `${snapshot.actorName}'s turn is over.` : 'Turn is over.');
  }
  const resolution = resolvePromotionOptions(snapshot, { bypassItem, bypassRequirements });
  if (!resolution.options.length) return refuse(resolution.refusal ?? 'That promotion is unavailable.');

  const chosen = await promptForPath(snapshot, resolution);
  if (!chosen) return false;
  if (!await confirmPromotion(snapshot.actorName, chosen.className)) {
    void playUiSound(SOUND_IDS.UI_UNSELECT);
    return false;
  }
  void playUiSound(SOUND_IDS.UI_CONFIRM);
  return raisePromotion({ actorUuid, tokenUuid, promotionId: chosen.id, usedItemId, bypassItem,
    bypassRequirements });
}

/**
 * Send the promote command with the unit's movement plan suspended and its movement indicator held. The plan is
 * resumed after a refusal, or when the promotion didn't end the unit's turn.
 */
async function raisePromotion(intent) {
  const tokenUuid = intent.tokenUuid;
  await settleMovementAnimation(tokenUuid);
  suspendMovementForTargeting(tokenUuid);
  let result;
  try {
    holdMovementIndicator(tokenUuid, true);
    result = await game.emblemRpg.api.character.classes.promote({
      ...intent, cinematicCategory: PROMOTION_CINEMATIC_CATEGORY
    });
    notifications.showResult(result);
    return result?.ok === true;
  } finally {
    try { holdMovementIndicator(tokenUuid, false); }
    finally {
      if (result?.ok !== true || result.data?.turnEnded !== true) await resumeMovementAfterTargeting(tokenUuid);
    }
  }
}

/**
 * Open the promotion window when the BG3 HUD activates a Promotion item (through the HUD's activateItem handler set
 * up in init/system.mjs). Returns false for any other Item, so the normal hotbar activation runs instead.
 * @param {string} itemUuid The activated Item.
 * @param {string} [tokenUuid] The acting token. Defaults to the actor's first active token, and the HUD passes none.
 * @returns {Promise<boolean>} Whether this activation was a promotion.
 */
export async function activatePromotionItem(itemUuid, tokenUuid = '') {
  const item = await resolveItem(itemUuid);
  if (item?.type !== 'Consumable' || item.system.itemType !== 'Promotion') return false;
  const actor = item.parent;
  if (actor?.documentName !== 'Actor') return false;
  const token = tokenUuid || String(actor.getActiveTokens()[0]?.document.uuid ?? '');
  await beginPromotionSequence(token, String(actor.uuid), item.id, { namedTurnRefusal: true });
  return true;
}

function refuse(message) {
  notifications.show(NOTIFICATION_IDS.PROMOTION_UNAVAILABLE, { message });
  return false;
}

/* -------------------------------------------- */
/*  Preview window                              */
/* -------------------------------------------- */

/**
 * Open the comparison and return the path the player picked, or null when they backed out. The window uses the
 * trade menus' frameless style, which hides the DialogV2 footer, so its own Cancel and Promote buttons close it.
 * Promote refuses an unavailable path and leaves the window open.
 */
async function promptForPath(snapshot, resolution) {
  const view = preparePromotionView(snapshot, resolution);
  const content = await globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, view);
  let chosen = null;
  await globalThis.foundry.applications.api.DialogV2.wait({
    window: { title: `Promote ${snapshot.actorName}`, resizable: false },
    classes: [SYSTEM_ID, 'window-promote-preview'],
    position: { width: WINDOW_WIDTH, height: 'auto' },
    content,
    buttons: [{ action: 'close', label: 'Close', callback: () => null }],
    render: (_event, dialog) => {
      const root = dialog.element;
      root.classList.add('trade-menu-dialog');
      const capture = captureForDialog(dialog, {
        root,
        mode: 'shaped',
        confirmAction: null,
        outsideClickCancels: false,
        onConfirm: () => {
          root.querySelector('.promote-pill[data-promote="confirm"]')?.click();
          return true;
        },
        cancelSound: null
      });
      wireComparison(root, view);
      root.querySelector('.promote-pill[data-promote="cancel"]')?.addEventListener('click', () => {
        void dialog.close();
      });
      root.querySelector('.promote-pill[data-promote="confirm"]')?.addEventListener('click', () => {
        const option = selectedPath(root, resolution.options);
        if (!option) return;
        chosen = option;
        capture.resolve();
        void dialog.close();
      });
    }
  });
  if (!chosen) void playUiSound(SOUND_IDS.UI_UNSELECT);
  return chosen;
}

/** The path the select names, or null after the unavailable notice when that path cannot be taken. */
function selectedPath(root, options) {
  const id = root.querySelector('.promotion-select')?.value;
  const option = options.find(entry => entry.id === id);
  if (option?.selectable) return option;
  notifications.show(NOTIFICATION_IDS.PROMOTION_UNAVAILABLE, { message: 'That promotion is unavailable.' });
  return null;
}

/** The final confirmation, which says plainly that it cannot be undone. */
async function confirmPromotion(actorName, className) {
  const result = await openBlockingDialog({
    title: 'Confirm Promotion',
    width: 300,
    height: 'auto',
    dialogClass: 'promote-confirmation',
    openSound: null,
    cancelSound: null,
    content: `
      <div class="promote-confirm-title">Promote <strong>${escapeHtml(actorName)}</strong> to
        <strong>${escapeHtml(className)}</strong>?</div>
      <div class="promote-confirm-warning">This cannot be undone</div>
    `,
    buttons: [
      { action: 'yes', label: 'Promote', default: true, callback: () => true },
      { action: 'no', label: 'Cancel', callback: () => false }
    ]
  });
  return result === true;
}

/* -------------------------------------------- */
/*  Comparison view                             */
/* -------------------------------------------- */

/**
 * Build promote-preview.hbs's context from projectPromotionPreview and resolvePromotionOptions: the current class,
 * the select's entries, and every path's header, bars, ranks and utility tiles, opening on the first selectable
 * path. Thumb sources stay the raw class art, and fitThumb trims and places them once the window exists.
 * @param {object} snapshot The promotion preview data.
 * @param {{options: object[], available: object[]}} resolution The resolved paths.
 * @returns {{current: object, selected: object, options: object[], paths: object[]}}
 */
function preparePromotionView(snapshot, resolution) {
  const current = currentSide(snapshot);
  const paths = resolution.options.map(option => pathView(snapshot, option, current.proficiencies));
  const firstId = (resolution.available[0] ?? resolution.options[0])?.id;
  const selected = paths.find(path => path.id === firstId) ?? paths[0];
  const options = paths.map(path => ({
    id: path.id,
    className: path.className,
    classUuid: path.classUuid,
    selectable: path.selectable,
    unavailableReason: path.unavailableReason,
    selected: path === selected
  }));
  return { current, selected, options, paths };
}

/** What the unit has today: its class name, that class's art and the ranks it currently holds. */
function currentSide(snapshot) {
  const classItem = snapshot.classItem;
  const capabilities = {
    hasMount: Boolean(classItem?.mount),
    hasFlying: Boolean(classItem?.proficiencies?.flying),
    hasHeavyArmor: Number(classItem?.proficiencies?.armor) === 3
  };
  const art = resolveClassPreviewArt(snapshot.art, classItem?.name ?? '', capabilities, snapshot.tokenImage, {
    allowGlobalFallback: true
  });
  return {
    className: classItem?.name || 'Unknown',
    thumb: art.img,
    proficiencies: currentProficiencies(snapshot.proficiencies ?? {})
  };
}

/** One path as the window draws it: its header, its promotionBarRows bars, and its ranks against today's. */
function pathView(snapshot, option, currentRanks) {
  const bars = promotionBarRows(snapshot, option);
  return {
    id: option.id,
    className: option.className,
    classUuid: option.classUuid,
    selectable: option.selectable,
    unavailableReason: option.unavailableReason,
    thumb: resolveClassPreviewArt(snapshot.art, option.className, option.capabilities, '').img,
    mount: mountChips(option.mount, snapshot.targetClasses?.[option.classUuid]?.mount?.img),
    columns: [bars.left.map(barView), bars.right.map(barView)],
    proficiencies: proficiencyCells(currentRanks, option.promotedProficiencies),
    utility: utilityTiles(currentRanks, option.promotedProficiencies)
  };
}

/**
 * One bar row's numbers, bonus slots and track geometry. The track's CSS variables place its segments in order:
 * the kept value, the class gain, the mount's share and the headroom up to the promoted cap, then the hatched loss
 * and both cap lines on top.
 */
function barView(row) {
  const fillEnd = Math.max(row.afterPct, row.mountedPct);
  const track = {
    '--base': percent(Math.min(row.nowPct, row.afterPct)),
    '--gain': percent(row.afterPct - row.nowPct),
    '--mount': percent(row.mountedPct - row.afterPct),
    '--room': percent(row.capped ? row.capNewPct - fillEnd : 0),
    '--loss-at': percent(row.afterPct),
    '--loss': percent(row.nowPct - row.afterPct),
    '--cap-now': percent(row.capNowPct),
    '--cap-new': percent(row.capNewPct)
  };
  return {
    key: row.key,
    label: row.label,
    now: row.now,
    after: row.after,
    capped: row.capped,
    classBonus: row.delta ? signed(row.delta) : '',
    classTone: toneOf(row.delta),
    mountBonus: row.mount ? signed(row.mount) : '',
    track,
    trackStyle: Object.entries(track).map(([name, value]) => `${name}:${value}`).join(';')
  };
}

/**
 * The mount line's chips: the Mount's name beside its image, or the riding icon when the preview data has none,
 * and one chip per unit type it grants. The template holds a chip for every unit type, so a path change only shows
 * or hides them.
 */
function mountChips(mount, image) {
  const has = mount?.has === true;
  return {
    has,
    name: has ? mount.name : '',
    icon: image || MOUNT_FALLBACK_ICON,
    types: Object.entries(MOUNT_TYPE_ICONS).map(([label, key]) => ({
      key, label, icon: `${UNIT_TYPE_PATH}/${key}-type.png`, shown: has && mount.unitTypes.includes(label)
    }))
  };
}

/**
 * The ten weapon rank cells for a path. A rank that rises is marked up and one that falls is marked down. A rank
 * that falls to nothing shows the unranked badge with the lost rank's letter struck through.
 */
function proficiencyCells(currentRanks, promotedRanks) {
  return PROMOTION_PROFICIENCY_KEYS.map(key => {
    const before = rankOf(currentRanks?.[key]);
    const rank = rankOf(promotedRanks?.[key]);
    return {
      key,
      label: PROFICIENCY_LABELS[key],
      icon: `${PROFICIENCY_PATH}/prof-${key}${rank > 0 ? '' : '-off'}.png`,
      badge: `${PROFICIENCY_PATH}/${rank > 0 ? `rank${rank}` : 'norank'}.png`,
      lostLetter: rank === 0 && before > 0 ? PROFICIENCY_RANK_LETTERS[before - 1] : '',
      tone: toneOf(rank - before)
    };
  });
}

/** The riding and armor tiles for a path, coloured by whether each rank rises or falls from today's. */
function utilityTiles(currentRanks, promotedRanks) {
  return utilityProficiencyRows(promotedRanks).map(row => ({
    key: row.key,
    name: PROFICIENCY_LABELS[row.key],
    label: row.label,
    image: `${PROFICIENCY_PATH}/${row.icon}`,
    tone: toneOf(row.value - (Number(currentRanks?.[row.key]) || 0)) || (row.none ? 'is-none' : '')
  }));
}

/** A rank clamped to the six lettered ranks the badges draw. */
function rankOf(value) {
  return Math.max(0, Math.min(PROFICIENCY_RANK_LETTERS.length, Math.trunc(Number(value) || 0)));
}

function toneOf(delta) {
  if (delta > 0) return 'is-up';
  return delta < 0 ? 'is-down' : '';
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

/** A share of a bar as a CSS percentage. A negative share, such as a gain on a falling stat, draws nothing. */
function percent(fraction) {
  return `${Math.round(Math.max(0, fraction) * 10000) / 100}%`;
}

/* -------------------------------------------- */
/*  Live comparison                             */
/* -------------------------------------------- */

/**
 * Follow the select so the window shows whichever path it names. Every element is repainted in place rather than
 * re-rendered, so switching paths is instant and nothing in the window changes size.
 */
function wireComparison(root, view) {
  const select = root.querySelector('.promotion-select');
  const show = () => paintPath(root, view.paths.find(path => path.id === select?.value) ?? view.selected);
  void fitThumb(root.querySelector('.promote-thumb-img[data-thumb="current"]'), view.current.thumb);
  show();
  select?.addEventListener('change', show);
}

/** Repaint the target half of the header, the bars, the rank cells and the utility tiles for one path. */
function paintPath(root, path) {
  setText(root.querySelector('.promote-class-name[data-target-name]'), path.className);
  paintMountLine(root, path.mount);
  paintBars(root, path.columns);
  paintProficiencies(root, path.proficiencies);
  paintUtilityTiles(root, path.utility);
  void fitThumb(root.querySelector('.promote-thumb-img[data-thumb="target"]'), path.thumb);
}

function paintMountLine(root, mount) {
  const chip = root.querySelector('.promote-chip[data-mount-chip]');
  if (chip) {
    chip.hidden = !mount.has;
    const icon = chip.querySelector('.promote-chip-icon');
    if (icon) icon.src = mount.icon;
    setText(chip.querySelector('.promote-chip-label'), mount.name);
  }
  for (const type of mount.types) {
    const element = root.querySelector(`.promote-chip[data-unit-type="${type.key}"]`);
    if (element) element.hidden = !type.shown;
  }
}

function paintBars(root, columns) {
  for (const row of columns.flat()) {
    const track = root.querySelector(`.promote-track[data-stat="${row.key}"]`);
    if (track) {
      for (const [name, value] of Object.entries(row.track)) track.style.setProperty(name, value);
      track.classList.toggle('is-capped', row.capped);
    }
    setText(root.querySelector(`.promote-bar-after[data-stat="${row.key}"]`), row.after);
    const bonus = root.querySelector(`.promote-bar-bonus[data-stat="${row.key}"]`);
    setText(bonus, row.classBonus);
    setTone(bonus, row.classTone);
    setText(root.querySelector(`.promote-bar-mount[data-stat="${row.key}"]`), row.mountBonus);
  }
}

function paintProficiencies(root, cells) {
  for (const cell of cells) {
    const element = root.querySelector(`.promote-prof[data-prof="${cell.key}"]`);
    if (!element) continue;
    setTone(element, cell.tone);
    const icon = element.querySelector('.promote-prof-icon');
    if (icon) icon.src = cell.icon;
    const badge = element.querySelector('.promote-rank-img');
    if (badge) badge.src = cell.badge;
    setText(element.querySelector('.promote-rank-lost'), cell.lostLetter);
  }
}

function paintUtilityTiles(root, tiles) {
  for (const tile of tiles) {
    const element = root.querySelector(`.promote-utility[data-prof="${tile.key}"]`);
    if (!element) continue;
    setTone(element, tile.tone);
    const icon = element.querySelector('.promote-utility-icon');
    if (icon) icon.src = tile.image;
    setText(element.querySelector('.promote-utility-label'), tile.label);
  }
}

function setText(element, value) {
  if (element) element.textContent = String(value);
}

/** Replace an element's up, down or none colouring with the given tone, or clear it. */
function setTone(element, tone) {
  if (!element) return;
  element.classList.remove(...TONES);
  if (tone) element.classList.add(tone);
}

/* -------------------------------------------- */
/*  Header thumbs                               */
/* -------------------------------------------- */

/**
 * Draw a class sprite in its header box at 1x, trimmed of transparent padding by trimmedSpriteBox and centred.
 * A figure larger than the box is scaled down to fit, never up. Art that is missing, fails to load or has no size
 * is replaced by THUMB_FALLBACK scaled to fit, and the box is left empty if that fails too, so a broken image never
 * shows. When the path changes before the art has loaded, the newer source wins.
 */
async function fitThumb(element, source) {
  if (!element) return;
  const wanted = source || THUMB_FALLBACK;
  element.dataset.source = wanted;
  const sprite = wanted === THUMB_FALLBACK ? null : await loadThumb(wanted, true);
  const figure = sprite ?? await loadThumb(THUMB_FALLBACK, false);
  if (element.dataset.source !== wanted) return;
  if (!figure) {
    element.style.opacity = '0';
    return;
  }
  const fitted = Math.min(THUMB_WIDTH / figure.width, THUMB_HEIGHT / figure.height);
  const scale = sprite ? Math.min(1, fitted) : fitted;
  const drawnWidth = Math.max(1, Math.round(figure.width * scale));
  const drawnHeight = Math.max(1, Math.round(figure.height * scale));
  element.src = figure.url;
  element.style.width = `${drawnWidth}px`;
  element.style.height = `${drawnHeight}px`;
  element.style.left = `${Math.floor((THUMB_WIDTH - drawnWidth) / 2)}px`;
  element.style.top = `${Math.ceil((THUMB_HEIGHT - drawnHeight) / 2)}px`;
  element.style.opacity = '1';
}

/**
 * Load one fitThumb source and measure what it would draw. A class sprite is measured after trimmedSpriteBox crops
 * it, and the vector fallback keeps its own size. Returns null when the source fails to load or has no size.
 */
async function loadThumb(source, trim) {
  const image = new globalThis.Image();
  const loaded = await new Promise(resolve => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = source;
  });
  if (!loaded) return null;
  const box = trim ? await trimmedSpriteBox(image) : null;
  const width = box?.width || image.naturalWidth;
  const height = box?.height || image.naturalHeight;
  return width > 0 && height > 0 ? { url: box?.url || source, width, height } : null;
}
