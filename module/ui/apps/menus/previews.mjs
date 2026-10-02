/** @layer ui/apps/menus */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { trimPngAlpha } from '../../../lib/dom/image-trim.mjs';
import { playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import { captureForDialog, openBlockingDialog } from '../../dialogs.mjs';
import { finite as finiteNumber, isPlainObject } from '../../../lib/core/runtime.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { NotificationService } from '../../../presentation/interface/notifications.mjs';
import { cellCenter } from '../../../lib/core/geometry.mjs';
import { FoundryDiagnostics, reportFoundryError } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Effect, lock and haggle constants           */
/* -------------------------------------------- */
const EFFECT_PREVIEW_TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/effect-preview.hbs`;
const LOCK_TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/lock-preview.hbs`;
const HAGGLE_TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/haggle-preview.hbs`;
const HAGGLE_ICON = `systems/${SYSTEM_ID}/assets/ui/skills/trading.png`;
const HAGGLE_FALLBACK_IMAGE = 'icons/svg/mystery-man.svg';
const CAMERA_PAN_MS = 300;
const DIALOG_LOCATION_BUFFER = 220;

/* -------------------------------------------- */
/*  Effect preview                              */
/* -------------------------------------------- */
/**
 * Show what an activation is about to do and ask the player to confirm. Activation targeting in
 * ui/controls/targeting.mjs calls it with projectActivationPreview's output.
 *
 * A ground-aimed activation centres the camera on the chosen square and places the window clear of it. However the
 * player cancels, the camera pans back. Parameter selects are read from the DOM when the player confirms, so the
 * answer matches what they see.
 * @param {object} input The activation preview data.
 * @returns {Promise<{confirmed: boolean, params?: object}>}
 */
export async function openEffectPreview(input) {
  const content = await foundry.applications.handlebars.renderTemplate(EFFECT_PREVIEW_TEMPLATE, input);
  const targetLocation = input.targetLocation ?? null;
  const savedPivot = await panToLocationCenter(targetLocation);
  let confirmed = false;
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (!confirmed && savedPivot && globalThis.canvas?.ready) {
      globalThis.canvas.animatePan({ x: savedPivot.x, y: savedPivot.y, duration: CAMERA_PAN_MS });
    }
  };

  const classes = [SYSTEM_ID, 'effect-preview-window'];
  if (targetLocation) classes.push('effect-preview-location');

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: 'Confirm Effect', icon: 'fas fa-bolt', resizable: false },
    classes,
    content,
    buttons: [
      {
        action: 'confirm',
        icon: 'fas fa-check',
        label: 'Confirm',
        default: true,
        callback: (event, button, dialog) => {
          confirmed = true;
          playUiSound(SOUND_IDS.UI_CONFIRM);
          return { confirmed: true, params: readSelectedParams(dialog, input) };
        }
      },
      { action: 'cancel', icon: 'fas fa-times', label: 'Cancel', callback: () => ({ confirmed: false }) }
    ],
    render: (event, dialog) => {
      captureForDialog(dialog, { openSound: SOUND_IDS.UI_SELECT_ALT, onCancel: dismiss });
      trimTargetImages(dialog.element);
      if (targetLocation) positionDialogLeftOfLocation(dialog);
    }
  });

  if (!result?.confirmed) dismiss();
  return result ?? { confirmed: false };
}

/* -------------------------------------------- */
/*  Lock preview                                */
/* -------------------------------------------- */
/**
 * Confirm the lock command with a key-spend prompt or a Locktouch odds preview. attemptLock in
 * ui/controls/interaction.mjs calls it before sending the command.
 * @param {object} input The lock's details from the objects query, plus the chosen `method`.
 * @returns {Promise<boolean>}
 */
export async function openLockPreview(input) {
  if (input.method === 'key') return openKeyPrompt(input);
  const content = await foundry.applications.handlebars.renderTemplate(LOCK_TEMPLATE, { ...input, isKey: false });
  let confirmed = false;
  await foundry.applications.api.DialogV2.wait({
    window: { title: 'Locktouch', icon: 'fas fa-key', resizable: false },
    classes: [SYSTEM_ID, 'effect-preview-window'],
    content,
    buttons: [
      {
        action: 'confirm',
        icon: 'fas fa-check',
        label: 'Confirm',
        default: true,
        callback: () => {
          confirmed = true;
          playUiSound(SOUND_IDS.UI_CONFIRM);
        }
      },
      { action: 'cancel', icon: 'fas fa-times', label: 'Cancel' }
    ],
    render: (event, dialog) => {
      captureForDialog(dialog, { openSound: SOUND_IDS.UI_SELECT_ALT });
      trimTargetImages(dialog.element);
    }
  });
  return confirmed;
}

/** Open the key-spend confirmation through the blocking movement dialog. Treat dismissal as cancellation. */
async function openKeyPrompt(input) {
  let confirmed = false;
  const prompt = input.keyName
    ? `Use <span class="lock-key-name">${escapeHtml(input.keyName)}</span> to open ${escapeHtml(input.lockName)}?`
    : `Open ${escapeHtml(input.lockName)}?`;
  await openBlockingDialog({
    title: input.objectType === 'Door' ? 'Open Door' : 'Open Chest',
    content: prompt,
    buttons: [{ action: 'confirm', label: 'Yes', default: true, callback: () => { confirmed = true; } }]
  });
  return confirmed;
}

/* -------------------------------------------- */
/*  Haggle preview                              */
/* -------------------------------------------- */
/**
 * Ask before a unit spends its Downtime Action to haggle with a Vendor. The shop's Haggle button in
 * ui/apps/menus/vendor-app.mjs calls it and sends api.economy.haggle only on a confirm. The prompt opens over the
 * shop, so Cancel, Escape or a click outside closes just this window and hands focus back to the shop.
 * @param {{vendorName: string, vendorImage: string}} input The Vendor at the counter, from the shop view.
 * @returns {Promise<boolean>} Whether the player confirmed.
 */
export async function openHagglePreview({ vendorName = '', vendorImage = '' } = {}) {
  const content = await foundry.applications.handlebars.renderTemplate(HAGGLE_TEMPLATE, {
    vendorName: String(vendorName ?? ''),
    vendorImage: String(vendorImage || HAGGLE_FALLBACK_IMAGE),
    iconImage: HAGGLE_ICON
  });
  let confirmed = false;
  await foundry.applications.api.DialogV2.wait({
    window: { title: 'Haggle', icon: 'fas fa-handshake', resizable: false },
    classes: [SYSTEM_ID, 'effect-preview-window', 'haggle-preview-window'],
    content,
    buttons: [
      {
        action: 'confirm',
        icon: 'fas fa-check',
        label: 'Confirm',
        default: true,
        callback: () => {
          confirmed = true;
          playUiSound(SOUND_IDS.UI_CONFIRM);
        }
      },
      { action: 'cancel', icon: 'fas fa-times', label: 'Cancel' }
    ],
    render: (event, dialog) => {
      captureForDialog(dialog, { openSound: SOUND_IDS.UI_SELECT_ALT });
      trimTargetImages(dialog.element);
    }
  });
  return confirmed;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */
function readSelectedParams(dialog, input) {
  const params = {};
  for (const selector of dialog.element?.querySelectorAll('.param-selector') ?? []) {
    const index = String(selector.name ?? '').replace('param-', '');
    const name = input.params?.[index]?.name;
    if (name) params[name] = selector.value;
  }
  return params;
}

/* -------------------------------------------- */
/*  Camera and placement                        */
/* -------------------------------------------- */
async function panToLocationCenter(targetLocation) {
  const canvas = globalThis.canvas;
  if (!canvas?.ready || !targetLocation) return null;
  const gridSize = canvas.grid?.size ?? 100;
  const savedPivot = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y };
  await canvas.animatePan({
    ...cellCenter(targetLocation.x, targetLocation.y, gridSize),
    duration: CAMERA_PAN_MS
  });
  return savedPivot;
}

function positionDialogLeftOfLocation(dialog) {
  const element = dialog.element;
  if (!element) return;
  dialog.setPosition({
    left: Math.max(20, (globalThis.innerWidth / 2) - DIALOG_LOCATION_BUFFER - element.offsetWidth),
    top: Math.max(20, (globalThis.innerHeight / 2) - (element.offsetHeight / 2))
  });
}

function trimTargetImages(root) {
  for (const image of root?.querySelectorAll('.target-token-image') ?? []) {
    const trim = () => trimPngAlpha(image).then(source => {
      if (source) image.src = source;
    });
    if (image.complete && image.naturalWidth) void trim();
    else image.addEventListener('load', trim, { once: true });
  }
}

/* -------------------------------------------- */
/*  Combat preview constants                    */
/* -------------------------------------------- */
const COMBAT_PREVIEW_TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/combat-preview.hbs`;
const DESTRUCTIBLE_TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/destructible-preview.hbs`;
const PREVIEW_UNAVAILABLE_NOTICE = 'The combat preview could not be prepared.';
const ACTOR_TYPE_COLORS = Object.freeze({
  lord: '#0091FF', retainer: '#0091FF',
  ally: '#10A42E',
  neutral: '#8b56ec',
  enemy: '#C32929', boss: '#C32929'
});
const DEFAULT_IMAGE = 'icons/svg/mystery-man.svg';
const DEFAULT_WEAPON_IMAGE = `systems/${SYSTEM_ID}/assets/ui/dmg-types/none.png`;
const REFERENCE_IMAGE_HEIGHT = 180;
const originalImageHeights = new Map();
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Combat and Destructible previews            */
/* -------------------------------------------- */
/**
 * Show the Combat Preview and return the player's choices: the weapon, the damage type and any skipped attacks.
 * openPreviewForTarget in ui/controls/targeting.mjs calls it with projectFoundryCombatPreview's output and sends a
 * confirmed choice to the attack command, which the host checks and carries out.
 * @param {object} input The combat preview data.
 * @param {object} [options]
 * @param {Function|null} [options.resolvePreview] Called when the player picks another weapon or damage type. Returns
 *   `restore` when nothing changed, otherwise the updated preview and a `notice`: the reason the host would refuse
 *   the attack. A notice shows in the attack order's place, and Attack stays disabled.
 * @returns {Promise<object|null>} Confirmed choices, a cancellation result, or `null` when another preview is open.
 */
export async function openCombatPreview(input, { resolvePreview = null } = {}) {
  if (globalThis.document?.querySelector?.('.window-combat-preview')) return null;
  assertPreviewInput(input);

  const state = {
    input: await withOriginalImageHeights(input),
    view: null,
    notice: '',
    refreshGeneration: 0
  };
  state.view = prepareCombatPreviewView(state.input);
  const content = await renderPreviewTemplate(state.view);

  const result = await globalThis.foundry.applications.api.DialogV2.wait({
    window: { title: 'Combat Preview', resizable: false },
    classes: [SYSTEM_ID, 'window-combat-preview'],
    position: { width: 600, height: 800 },
    content,
    buttons: [
      {
        action: 'confirm',
        label: 'Attack',
        callback: (_event, _button, dialog) => {
          playPreviewSound(SOUND_IDS.UI_CONFIRM);
          return { confirmed: true, ...readPreviewChoices(dialog.element, state.view) };
        }
      },
      {
        action: 'cancel',
        label: 'Cancel',
        callback: () => ({ confirmed: false })
      }
    ],
    render: (_event, dialog) => {
      const root = dialog.element;
      wirePreview(root, state, resolvePreview);
      revealPreview(root);
      captureForDialog(dialog, {
        confirmLabel: 'Attack',
        openSound: SOUND_IDS.UI_SELECT_ALT,
        onRelease: () => removeCombatBackdrop(root)
      });
    }
  });

  return result ?? { confirmed: false };
}

/**
 * Show the attacker's break damage against a Destructible's Integrity, and return whether the player chose Attack.
 * openPreviewForTarget in ui/controls/targeting.mjs calls it when the clicked target is a Destructible.
 * @param {object} input The destructible preview data.
 * @returns {Promise<{confirmed: boolean}>} Whether the attack was confirmed.
 */
export async function openDestructiblePreview(input) {
  if (globalThis.document?.querySelector?.('.window-combat-preview, .destructible-preview-window')) {
    return { confirmed: false };
  }
  const view = prepareDestructiblePreviewView(input);
  const content = await globalThis.foundry.applications.handlebars.renderTemplate(DESTRUCTIBLE_TEMPLATE, view);
  const result = await globalThis.foundry.applications.api.DialogV2.wait({
    window: { title: 'Attack Destructible', icon: 'fas fa-hammer', resizable: false },
    classes: [SYSTEM_ID, 'effect-preview-window', 'destructible-preview-window'],
    content,
    buttons: [
      {
        action: 'confirm',
        label: 'Attack',
        default: true,
        callback: () => {
          playPreviewSound(SOUND_IDS.UI_CONFIRM);
          return { confirmed: true };
        }
      },
      { action: 'cancel', label: 'Cancel', callback: () => ({ confirmed: false }) }
    ],
    render: (_event, dialog) => {
      captureForDialog(dialog, { confirmLabel: 'Attack', openSound: SOUND_IDS.UI_SELECT_ALT });
      trimTargetImages(dialog.element);
    }
  });
  return result ?? { confirmed: false };
}

/** Build the destructible preview template's data. */
function prepareDestructiblePreviewView(input) {
  if (!isPlainObject(input) || !isPlainObject(input.weapon)) {
    throw new TypeError('Destructible preview requires a plain projection.');
  }
  const attackCount = Math.max(1, Number(input.attackCount) || 1);
  return Object.freeze({
    atkWepName: input.weapon.name ? stripRefinementSuffix(input.weapon.name) : 'Unarmed',
    atkWepImg: input.weapon.image || DEFAULT_WEAPON_IMAGE,
    atkWepUses: Number(input.weapon.usesCurrent) || 0,
    atkWepMaxUses: Number(input.weapon.usesMax) || 0,
    atkWepInfinite: input.weapon.infinite === true || !input.weapon.name,
    weaponArt: isPlainObject(input.weaponArt)
      ? Object.freeze({ name: String(input.weaponArt.name ?? ''), img: String(input.weaponArt.image ?? '') })
      : null,
    defName: String(input.name ?? ''),
    defImage: input.image || DEFAULT_IMAGE,
    integrity: String(input.integrity ?? ''),
    brk: Number(input.breakDamage) || 0,
    numAttacks: attackCount,
    multiHit: attackCount > 1,
    dmgType: String(input.damageType || 'none'),
    brkVulnerable: input.brkVulnerable === true,
    brkResisted: input.brkResisted === true,
    brkImmune: input.brkImmune === true
  });
}

/**
 * Build the combat preview template's data. The template marks each damage type with "(?)" when atkDmgRandomize
 * says the weapon rolls its type.
 * @param {object} input The combat preview data.
 * @param {string} [notice] Why the host would refuse this attack, shown in place of the attack order.
 * @returns {object} Detached Handlebars context.
 */
function prepareCombatPreviewView(input, notice = '') {
  assertPreviewInput(input);
  const attacker = normalizeSide(input.attacker);
  const defender = normalizeSide(input.defender);
  const defenderCanRespond = input.defenderCanRespond !== false;
  const layout = imageLayout(attacker, defender);
  const validWeapons = selectedWeaponFirst(attacker.validWeapons, attacker.weapon);
  const damageTypes = selectedDamageTypeFirst(attacker.damageTypes, attacker.selectedDamageType);

  return Object.freeze({
    atkName: attacker.name,
    atkNameColor: actorTypeColor(attacker.actorType),
    atkImage: attacker.image,
    atkWeaponId: attacker.weapon.id ?? '',
    atkHp: attacker.hp.value,
    atkStn: attacker.stance.value,
    atkWepName: attacker.weapon.name ? stripRefinementSuffix(attacker.weapon.name) : '--',
    atkWeaponIsFixed: attacker.weapon.fixed,
    atkWepImg: attacker.weapon.image,
    atkWepUses: attacker.weapon.uses.current,
    atkWepMaxUses: attacker.weapon.uses.max,
    atkWepInfinite: attacker.weapon.uses.infinite,
    atkWepColor: usesColor(attacker.weapon.uses.current, attacker.weapon.uses.max),
    atkDamage: attacker.damage,
    atkHitChance: percentLabel(attacker.hitChance),
    atkCritChance: percentLabel(attacker.critChance),
    atkDoubleText: attacker.attackCount > 1 ? `${attacker.attackCount}x!` : '',
    atkIsEffective: attacker.effective,
    atkHitColor: advantageColor(attacker.advantage, attacker.disadvantage),
    atkStnIcons: stanceIcons(attacker.stance.value, attacker.stance.max),
    atkHpBar: renderHealthBar(attacker.hp.value, attacker.hp.max, false),
    atkArrow: attacker.damageAffinity,
    atkHasAdvantage: attacker.advantage,
    atkHasDisadvantage: attacker.disadvantage,

    defName: defender.name,
    defNameColor: actorTypeColor(defender.actorType),
    defImage: defender.image,
    defHp: defender.hp.value,
    defStn: defender.stance.value,
    defWepName: defender.weapon.name ? stripRefinementSuffix(defender.weapon.name) : '--',
    defWepImg: defender.weapon.image,
    defWepUses: defender.weapon.uses.current,
    defWepMaxUses: defender.weapon.uses.max,
    defWepInfinite: defender.weapon.uses.infinite,
    defWepColor: usesColor(defender.weapon.uses.current, defender.weapon.uses.max),
    defDamage: defenderCanRespond ? defender.damage : '--',
    defHitChance: defenderCanRespond ? percentLabel(defender.hitChance) : '--',
    defCritChance: defenderCanRespond ? percentLabel(defender.critChance) : '--',
    defDoubleText: defenderCanRespond && defender.attackCount > 1 ? `${defender.attackCount}x!` : '',
    defIsEffective: defender.effective,
    defHitColor: advantageColor(defender.advantage, defender.disadvantage),
    defStnIcons: stanceIcons(defender.stance.value, defender.stance.max),
    defHpBar: renderHealthBar(defender.hp.value, defender.hp.max, true),
    defArrow: defender.damageAffinity,
    defWeapon: defender.weapon.present,
    defHasAdvantage: defender.advantage,
    defHasDisadvantage: defender.disadvantage,

    atkStnDamage: attacker.breakDamage > 0 ? attacker.breakDamage : null,
    defStnDamage: defenderCanRespond && defender.breakDamage > 0 ? defender.breakDamage : null,
    atkOnBreakText: attacker.onBreakAttackCount > 0 ? `${attacker.onBreakAttackCount}x on Break` : '',
    defOnBreakText: defenderCanRespond && defender.onBreakAttackCount > 0
      ? `${defender.onBreakAttackCount}x on Break` : '',

    atkWepTransform: '',
    defWepTransform: '',
    atkValidWeapons: validWeapons,
    atkDmgTypes: damageTypes,
    atkSelectedDmgType: attacker.selectedDamageType,
    atkDmgRandomize: attacker.randomizeDamageType,
    defDmgType: defender.selectedDamageType,

    attackSequence: String(input.attackSequence ?? ''),
    coloredAttackSequence: coloredAttackSequence(
      input.attackSequence,
      attacker.actorType,
      defender.actorType,
      attacker.onBreakAttackCount
    ),
    atkNumAttacks: attacker.attackCount,
    defNumAttacks: defender.attackCount,

    atkImageScale: layout.attackerScale,
    defImageScale: layout.defenderScale,
    atkAnchorX: layout.attackerAnchor,
    defAnchorX: layout.defenderAnchor,
    atkOriginalH: attacker.originalImageHeight || '',
    defOriginalH: defender.originalImageHeight || '',
    weaponArt: normalizeWeaponArt(input.weaponArt),
    previewNotice: String(notice ?? '')
  });
}

/** Drop a refinement suffix such as "+2" or "(+2)" from a weapon name, so it fits the preview's one-line label. */
function stripRefinementSuffix(name) {
  return String(name ?? '').replace(/\s*\(?\+\d+\)?\s*$/, '');
}

/* -------------------------------------------- */
/*  Dialog refresh                              */
/* -------------------------------------------- */
function wirePreview(root, state, resolvePreview) {
  wireSelectionRefresh(root, state, resolvePreview);
  wireAttackSequence(root);
  trimCharacterSprites(root);
  applyDynamicImageScaling(root);
  fitPreviewText(root);
}

/**
 * Send a weapon or damage-type choice to `resolvePreview` and show its answer in place. The selects and Attack wait
 * while it runs. A weapon change clears the skipped attacks, since the new weapon's attack order is a different one.
 */
function wireSelectionRefresh(root, state, resolvePreview) {
  for (const selector of ['#atk-weapon-select', '#atk-dmg-type-select']) {
    const select = root.querySelector(selector);
    if (!select || typeof resolvePreview !== 'function') continue;
    select.addEventListener('change', async () => {
      const generation = ++state.refreshGeneration;
      const choices = readPreviewChoices(root, state.view);
      const weaponChanged = (choices.weaponId ?? '') !== state.view.atkWeaponId;
      setPreviewRefreshPending(root, state, true);
      try {
        const answer = await resolvePreview(choices);
        if (generation !== state.refreshGeneration) return;
        if (answer?.restore) restorePreviewChoices(root, state.view);
        else await showPreviewAnswer(root, state, resolvePreview, answer, weaponChanged ? [] : choices.skippedAttacks);
      } catch (diagnosticError) {
        if (generation !== state.refreshGeneration) return;
        reportFoundryError(import.meta.url, diagnosticError, 'Refresh combat preview');
        state.notice = PREVIEW_UNAVAILABLE_NOTICE;
        showPreviewNotice(root, state.notice);
      } finally {
        if (generation === state.refreshGeneration) setPreviewRefreshPending(root, state, false);
      }
    });
  }
}

/**
 * Render refreshCombatPreview's answer. A notice that comes without an updated preview keeps the current body and
 * takes the attack order's place, so Attack stays disabled either way.
 */
async function showPreviewAnswer(root, state, resolvePreview, answer, skippedAttacks) {
  const notice = String(answer?.notice ?? '');
  if (notice && !state.notice) playPreviewSound(SOUND_IDS.UI_ERROR);
  state.notice = notice;
  if (!answer?.preview) {
    showPreviewNotice(root, notice || PREVIEW_UNAVAILABLE_NOTICE);
    return;
  }
  assertPreviewInput(answer.preview);
  state.input = await withOriginalImageHeights(answer.preview);
  state.view = prepareCombatPreviewView(state.input, notice);
  await replacePreviewBody(root, state, resolvePreview, skippedAttacks);
}

/** Show a notice in the attack order's line of the body already on screen. */
function showPreviewNotice(root, notice) {
  const body = root.querySelector('#combat-window');
  if (!body) return;
  let line = body.querySelector('.attack-sequence-display');
  if (!line) {
    line = globalThis.document.createElement('div');
    body.append(line);
  }
  line.className = 'attack-sequence-display combat-preview-notice';
  line.textContent = notice;
}

/** Hold the selects and Attack while a refresh runs, and keep Attack disabled while a notice shows. */
function setPreviewRefreshPending(root, state, pending) {
  root.setAttribute('aria-busy', String(pending));
  for (const selector of ['#atk-weapon-select', '#atk-dmg-type-select']) {
    const control = root.querySelector(selector);
    if (control) control.disabled = pending;
  }
  const blocked = Boolean(state.notice);
  root.classList.toggle('combat-preview-blocked', blocked);
  const confirm = root.querySelector('.form-footer button[data-action="confirm"]');
  if (confirm) confirm.disabled = pending || blocked;
}

function restorePreviewChoices(root, view) {
  const weapon = root.querySelector('#atk-weapon-select');
  const damageType = root.querySelector('#atk-dmg-type-select');
  if (weapon) weapon.value = view.atkValidWeapons[0]?.id ?? '';
  if (damageType) damageType.value = view.atkSelectedDmgType;
}

async function replacePreviewBody(root, state, resolvePreview, skippedAttacks) {
  const imageStates = captureImageStates(root);
  const content = await renderPreviewTemplate(state.view);
  const container = globalThis.document.createElement('div');
  container.innerHTML = content;
  applyImageStates(container, imageStates);
  const oldBody = root.querySelector('#combat-window');
  const newBody = container.querySelector('#combat-window');
  if (!oldBody || !newBody) return;
  oldBody.innerHTML = newBody.innerHTML;
  restoreSkippedAttacks(root, skippedAttacks);
  wirePreview(root, state, resolvePreview);
}

function readPreviewChoices(root, view) {
  const weapon = root?.querySelector('#atk-weapon-select')?.value
    ?? view.atkValidWeapons[0]?.id ?? null;
  const damageType = root?.querySelector('#atk-dmg-type-select')?.value
    ?? view.atkSelectedDmgType;
  const skippedAttacks = Array.from(root?.querySelectorAll('.attack-seq-atk.attack-skipped') ?? [])
    .map(element => String(element.dataset.attack ?? ''))
    .filter(Boolean);
  return { weaponId: weapon ? String(weapon) : null, damageType: String(damageType), skippedAttacks };
}

/* -------------------------------------------- */
/*  Attack sequence                             */
/* -------------------------------------------- */
function coloredAttackSequence(sequence, attackerType, defenderType, onBreakAttackCount) {
  const value = String(sequence ?? '');
  if (!value) return '';
  const attackerColor = actorTypeColor(attackerType);
  const defenderColor = actorTypeColor(defenderType);
  const parts = value.split(', ').map(rawPart => {
    const part = escapeHtml(rawPart);
    if (/^A\d+$/.test(rawPart)) {
      return `<span class="attack-seq-atk" data-attack="${part}" style="color: ${attackerColor};">${part}</span>`;
    }
    if (/^D\d+$/.test(rawPart)) return `<span class="attack-seq-def" style="color: ${defenderColor};">${part}</span>`;
    return part;
  });
  const currentAttacks = (value.match(/A\d+/g) ?? []).length;
  for (let index = currentAttacks + 1; index <= onBreakAttackCount; index += 1) {
    parts.push(`<span class="attack-seq-atk attack-seq-break" data-attack="A${index}" `
      + `style="color: ${attackerColor};">[A${index}]</span>`);
  }
  return parts.join(', ');
}

function wireAttackSequence(root) {
  const attacks = Array.from(root.querySelectorAll('.attack-seq-atk'));
  for (const attack of attacks) {
    attack.addEventListener('click', () => {
      if (attack.classList.contains('attack-skipped')) {
        attack.classList.remove('attack-skipped');
        playPreviewSound(SOUND_IDS.UI_CLICK);
        refreshAttackCountLabels(root);
        return;
      }
      if (!attack.classList.contains('attack-seq-break')) {
        const active = attacks.filter(entry => !entry.classList.contains('attack-seq-break')
          && !entry.classList.contains('attack-skipped')).length;
        if (active <= 1) {
          playPreviewSound(SOUND_IDS.UI_ERROR);
          return;
        }
      }
      attack.classList.add('attack-skipped');
      playPreviewSound(SOUND_IDS.UI_CLICK);
      refreshAttackCountLabels(root);
    });
  }
}

function refreshAttackCountLabels(root) {
  const attacks = Array.from(root.querySelectorAll('.attack-seq-atk'));
  if (!attacks.length) return;
  const active = attacks.filter(entry => !entry.classList.contains('attack-skipped'));
  const guaranteed = active.filter(entry => !entry.classList.contains('attack-seq-break')).length;
  const conditional = active.length - guaranteed;
  const double = root.querySelector('.atk-double-text');
  if (double) double.textContent = guaranteed > 1 ? `${guaranteed}x!` : '';
  const onBreak = root.querySelector('.atk-on-break-text');
  if (!onBreak) return;
  onBreak.textContent = conditional > 0 ? `${guaranteed + conditional}x on Break` : '';
  onBreak.style.display = conditional > 0 ? '' : 'none';
}

/**
 * Mark the attacks the player had skipped again after a refresh. When that would skip every certain attack, none
 * stays skipped, as wireAttackSequence never lets the last one go.
 */
function restoreSkippedAttacks(root, skippedAttacks) {
  const skipped = new Set(skippedAttacks);
  const attacks = Array.from(root.querySelectorAll('.attack-seq-atk'));
  const keepsOne = attacks.some(attack => !attack.classList.contains('attack-seq-break')
    && !skipped.has(String(attack.dataset.attack ?? '')));
  for (const attack of attacks) {
    attack.classList.toggle('attack-skipped', keepsOne && skipped.has(String(attack.dataset.attack ?? '')));
  }
  refreshAttackCountLabels(root);
}

/* -------------------------------------------- */
/*  Image presentation                          */
/* -------------------------------------------- */
async function withOriginalImageHeights(input) {
  const [attackerHeight, defenderHeight] = await Promise.all([
    originalImageHeight(input.attacker.image),
    originalImageHeight(input.defender.image)
  ]);
  return {
    ...input,
    attacker: { ...input.attacker, originalImageHeight: input.attacker.originalImageHeight || attackerHeight || 0 },
    defender: { ...input.defender, originalImageHeight: input.defender.originalImageHeight || defenderHeight || 0 }
  };
}

function originalImageHeight(source) {
  const src = String(source ?? '');
  if (!src || !globalThis.Image) return Promise.resolve(null);
  if (originalImageHeights.has(src)) return Promise.resolve(originalImageHeights.get(src));
  return new Promise(resolve => {
    const image = new globalThis.Image();
    image.onload = () => {
      originalImageHeights.set(src, image.naturalHeight);
      resolve(image.naturalHeight);
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function trimCharacterSprites(root) {
  for (const image of root.querySelectorAll('.atk-img, .def-img')) {
    const trim = () => trimPngAlpha(image).then(source => { if (source) image.src = source; });
    if (image.complete && image.naturalWidth) void trim();
    else image.addEventListener('load', trim, { once: true });
  }
}

function applyDynamicImageScaling(root) {
  applyImageScale(root.querySelector('.atk-img'), true);
  applyImageScale(root.querySelector('.def-img'), false);
}

function applyImageScale(image, mirrored) {
  if (!image) return;
  const originalHeight = finiteNumber(image.getAttribute('data-original-h'), 0);
  if (!originalHeight) return;
  const scale = (REFERENCE_IMAGE_HEIGHT * finiteNumber(image.getAttribute('data-scale'), 1)) / originalHeight;
  image.style.transform = `translate(-50%, -10px) ${mirrored ? 'rotateY(180deg) ' : ''}scale(${scale})`;
}

function captureImageStates(root) {
  return Object.fromEntries(['atk', 'def'].flatMap(side => {
    const image = root.querySelector(`.${side}-img`);
    if (!image) return [];
    return [[side, {
      src: image.src,
      transform: image.style.transform || '',
      scale: image.getAttribute('data-scale') || '1',
      originalHeight: image.getAttribute('data-original-h') || ''
    }]];
  }));
}

function applyImageStates(root, states) {
  for (const side of ['atk', 'def']) {
    const image = root.querySelector(`.${side}-img`);
    const state = states[side];
    if (!image || !state) continue;
    image.src = state.src;
    image.style.transform = state.transform;
    image.setAttribute('data-scale', state.scale);
    if (state.originalHeight) image.setAttribute('data-original-h', state.originalHeight);
  }
}

/* -------------------------------------------- */
/*  Window presentation                         */
/* -------------------------------------------- */
function fitPreviewText(root) {
  for (const container of root.querySelectorAll('.text-fit-container')) {
    const text = container.textContent.trim();
    container.classList.remove('text-truncated');
    container.textContent = text;
    let size = 20;
    let fits = false;
    while (size >= 16 && !fits) {
      container.style.fontSize = `${size}px`;
      fits = container.scrollHeight <= (size * 1.1 * 2) + 2;
      if (!fits) size -= 1;
    }
    if (!fits) {
      container.style.fontSize = '16px';
      container.classList.add('text-truncated');
    }
  }
}

function revealPreview(root) {
  root.style.opacity = '1';
  root.classList.add('cb-fade-in');
  createCombatBackdrop(root);
}

/**
 * The frame art is a fixed image on the page body rather than part of the dialog, so the window's clipping and
 * stacking don't affect it. It follows the dialog every frame and removes itself once the dialog is gone.
 */
function createCombatBackdrop(root) {
  const rect = root.getBoundingClientRect();
  const backdrop = globalThis.document.createElement('img');
  backdrop.className = 'combat-frame-img-bg-independent cb-fade-in';
  backdrop.src = `systems/${SYSTEM_ID}/assets/ui/combat-frame/CombatFrameBG.png`;
  backdrop.id = `combat-backdrop-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  backdrop.style.cssText = `position:fixed;left:${rect.left + 7}px;top:${rect.top + 7}px;`
    + 'width:532px;height:300px;z-index:9999;pointer-events:none;';
  root.dataset.backdropId = backdrop.id;
  globalThis.document.body.appendChild(backdrop);

  const track = () => {
    if (!root.isConnected) {
      backdrop.remove();
      return;
    }
    const current = root.getBoundingClientRect();
    backdrop.style.left = `${current.left + 7}px`;
    backdrop.style.top = `${current.top + 7}px`;
    globalThis.requestAnimationFrame(track);
  };
  globalThis.requestAnimationFrame(track);
}

function removeCombatBackdrop(root) {
  const id = root?.dataset?.backdropId;
  if (id) globalThis.document?.getElementById?.(id)?.remove?.();
  if (root?.dataset) delete root.dataset.backdropId;
}

function renderPreviewTemplate(view) {
  return globalThis.foundry.applications.handlebars.renderTemplate(COMBAT_PREVIEW_TEMPLATE, view);
}

/* -------------------------------------------- */
/*  View-model helpers                          */
/* -------------------------------------------- */
function assertPreviewInput(input) {
  if (!isPlainObject(input) || !isPlainObject(input.attacker) || !isPlainObject(input.defender)) {
    throw new TypeError('Combat preview requires plain attacker and defender projections.');
  }
}

function normalizeSide(raw) {
  const side = isPlainObject(raw) ? raw : {};
  const hp = numericTrack(side.hp);
  const stance = numericTrack(side.stance);
  const weapon = normalizeWeapon(side.weapon);
  const selectedDamageType = String(side.selectedDamageType ?? weapon.damageType ?? 'none');
  return {
    name: String(side.name ?? ''),
    actorType: String(side.actorType ?? ''),
    image: String(side.image || DEFAULT_IMAGE),
    originalImageHeight: finiteNumber(side.originalImageHeight, 0),
    tokenWidth: Math.max(1, finiteNumber(side.tokenWidth, 1)),
    tokenHeight: Math.max(1, finiteNumber(side.tokenHeight, 1)),
    textureScale: Math.abs(finiteNumber(side.textureScale, 1)),
    hp,
    stance,
    weapon,
    validWeapons: Array.isArray(side.validWeapons) ? side.validWeapons.map(normalizeWeaponChoice) : [],
    damageTypes: Array.isArray(side.damageTypes) ? side.damageTypes.map(String).filter(Boolean) : [],
    selectedDamageType,
    randomizeDamageType: side.randomizeDamageType === true,
    damage: side.damage ?? 0,
    hitChance: side.hitChance ?? 0,
    critChance: side.critChance ?? 0,
    attackCount: Math.max(0, Math.floor(finiteNumber(side.attackCount, 0))),
    onBreakAttackCount: Math.max(0, Math.floor(finiteNumber(side.onBreakAttackCount, 0))),
    breakDamage: Math.max(0, finiteNumber(side.breakDamage, 0)),
    effective: side.effective === true,
    advantage: side.advantage === true,
    disadvantage: side.disadvantage === true,
    damageAffinity: ['effective', 'ineffective'].includes(side.damageAffinity) ? side.damageAffinity : null
  };
}

function normalizeWeapon(raw) {
  const weapon = isPlainObject(raw) ? raw : {};
  const uses = isPlainObject(weapon.uses) ? weapon.uses : {};
  return {
    id: weapon.id == null ? null : String(weapon.id),
    name: String(weapon.name ?? ''),
    image: String(weapon.image || weapon.img || DEFAULT_WEAPON_IMAGE),
    damageType: String(weapon.damageType ?? 'none'),
    fixed: weapon.fixed === true,
    present: weapon.present !== false && Boolean(weapon.id || weapon.name || weapon.image || weapon.img),
    uses: {
      current: Math.max(0, finiteNumber(uses.current, 0)),
      max: Math.max(0, finiteNumber(uses.max, 0)),
      infinite: uses.infinite === true || uses.type === 'infinite'
    }
  };
}

/** One weapon option for the template, greyed out when wielding it would take off the shield (`shieldBlocked`). */
function normalizeWeaponChoice(raw) {
  const weapon = normalizeWeapon(raw);
  return { id: weapon.id ?? '', image: weapon.image, img: weapon.image, damageType: weapon.damageType,
    name: stripRefinementSuffix(weapon.name), shieldBlocked: raw?.shieldBlocked === true };
}

function normalizeWeaponArt(raw) {
  if (!isPlainObject(raw) || (!raw.name && !raw.image && !raw.img)) return null;
  return { name: String(raw.name ?? ''), img: String(raw.image || raw.img || DEFAULT_WEAPON_IMAGE) };
}

/**
 * The weapon choices with the weapon in hand first, so the select shows what the unit holds. A held weapon that
 * can't reach the target is missing from the list, so it is added back here.
 */
function selectedWeaponFirst(choices, selected) {
  const options = [...choices];
  const index = options.findIndex(option => option.id && option.id === selected.id);
  if (index > 0) options.unshift(options.splice(index, 1)[0]);
  else if (index < 0 && selected.present) options.unshift(normalizeWeaponChoice(selected));
  return options;
}

function selectedDamageTypeFirst(types, selected) {
  const options = [...new Set(types.length ? types : [selected])];
  if (!options.includes(selected)) options.unshift(selected);
  return options.filter(Boolean);
}

function numericTrack(raw) {
  const track = isPlainObject(raw) ? raw : {};
  return {
    value: Math.max(0, finiteNumber(track.value, 0)),
    max: Math.max(0, finiteNumber(track.max, 0))
  };
}

function imageLayout(attacker, defender) {
  const attackerDimension = Math.max(attacker.tokenWidth, attacker.tokenHeight);
  const defenderDimension = Math.max(defender.tokenWidth, defender.tokenHeight);
  const maximumDimension = Math.max(attackerDimension, defenderDimension);
  const baseCompensation = maximumDimension <= 1 ? 1 : Math.max(0.4, 1.5 / maximumDimension);
  const compensation = dimension => maximumDimension <= 1
    ? 1 : baseCompensation + (dimension < maximumDimension ? 0.05 : 0);
  return {
    attackerScale: attackerDimension * attacker.textureScale * compensation(attackerDimension),
    defenderScale: defenderDimension * defender.textureScale * compensation(defenderDimension),
    attackerAnchor: 130 - (Math.max(0, attackerDimension - 1) * 35),
    defenderAnchor: 398 + (Math.max(0, defenderDimension - 1) * 35)
  };
}

function stanceIcons(current, maximum) {
  return Array.from({ length: Math.floor(maximum) }, (_value, index) => ({
    class: index < current ? 'fa-solid fa-shield' : 'fa-regular fa-shield-slash',
    color: index < current ? 'orange' : '#888'
  }));
}

function renderHealthBar(current, maximum, defender) {
  const rowCap = 30;
  const firstMaximum = Math.min(maximum, rowCap);
  const secondMaximum = Math.max(0, Math.min(maximum - rowCap, rowCap));
  const firstValue = Math.min(current, firstMaximum);
  const secondValue = Math.max(0, current - firstValue);
  const firstWidth = firstMaximum <= 10 ? 80 : 80 + (((firstMaximum - 10) * 120) / 20);
  const secondWidth = secondMaximum ? 200 * (secondMaximum / rowCap) : 0;
  const prefix = defender ? 'def' : 'atk';
  let html = `\n      <div class="${prefix}-bar-align combat-hp-bar-align">\n`
    + `        <div class="${prefix}-hp-bar combat-hp-bar" style="width:${firstWidth}px;">\n`
    + `          <div class="combat-hp-fill" `
    + `style="width:${firstMaximum ? (firstValue / firstMaximum) * 100 : 0}%;"></div>\n`
    + `          <div class="combat-hp-label">${firstValue}/${firstMaximum}</div>\n        </div>\n`;
  if (secondWidth) {
    html += `        <div class="${prefix}-hp-bar2 combat-hp-bar" style="width:${secondWidth}px;">\n`
      + `          <div class="combat-hp-fill" style="width:${(secondValue / secondMaximum) * 100}%;"></div>\n`
      + `          <div class="combat-hp-label">${secondValue}/${secondMaximum}</div>\n        </div>\n`;
  }
  return `${html}      </div>`;
}

function actorTypeColor(actorType) {
  return ACTOR_TYPE_COLORS[actorType.toLowerCase()] ?? '#FFFFFF';
}

function usesColor(current, maximum) {
  const ratio = maximum > 0 ? current / maximum : 0;
  if (ratio > 2 / 3) return 'rgba(0,255,100,1)';
  if (ratio > 1 / 3) return 'rgb(255, 217, 0)';
  return 'rgba(255,0,0,1)';
}

function advantageColor(advantage, disadvantage) {
  if (advantage) return '#10A42E';
  if (disadvantage) return '#C32929';
  return 'rgba(220,220,220,1)';
}

function percentLabel(value) {
  if (typeof value === 'string' && value.trim().endsWith('%')) return value.trim();
  return `${Math.min(finiteNumber(value, 0), 100)}%`;
}

function playPreviewSound(soundId) {
  playUiSound(soundId);
}
