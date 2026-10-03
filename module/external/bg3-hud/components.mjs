/** @layer external/bg3-hud */
import { BG3_HUD_SCALE } from '../../contracts/domains/bg3-hud.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { resolveAvatarScale } from '../../game/character/rules.mjs';
import { escapeHtml, sanitizeHtml } from '../../lib/dom/html.mjs';
import { playMountFlourish } from '../sequencer/animation-dispatch.mjs';
import { equipmentMarkerItem, projectBg3Progression } from './document-projection.mjs';
import { reportFoundryError, reportFoundryProbe } from '../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Public component factory                    */
/* -------------------------------------------- */
/**
 * Import Core's PortraitContainer, PassivesContainer and BG3Component classes, then build this system's
 * subclasses. initializeEmblemBg3Core (core-runtime.mjs) registers the two containers with Core.
 */
export async function createEmblemBg3Components(importExport) {
  const [PortraitContainer, PassivesContainer, BG3Component] = await Promise.all([
    importExport('modules/bg3-hud-core/scripts/components/containers/PortraitContainer.js', 'PortraitContainer'),
    importExport('modules/bg3-hud-core/scripts/components/containers/PassivesContainer.js', 'PassivesContainer'),
    importExport('modules/bg3-hud-core/scripts/components/BG3Component.js', 'BG3Component')
  ]);
  return {
    PortraitContainer: buildPortraitContainer(PortraitContainer, BG3Component),
    PassivesContainer: buildPassivesContainer(PassivesContainer)
  };
}

/* -------------------------------------------- */
/*  Portrait and nameplate                      */
/* -------------------------------------------- */
/** The portrait container: the actor's art, sized by its avatar scale, and a nameplate with faction and progress. */
function buildPortraitContainer(PortraitContainer, BG3Component) {
  class EmblemPortraitNameplate extends BG3Component {
    constructor(options = {}) {
      super(options);
      this.actor = options.actor;
      this.token = options.token;
    }

    async render() {
      this.element ??= this.createElement('div', ['emblem-nameplate']);
      this.element.replaceChildren();
      const details = this.actor?.system?.faction ?? {};
      const variants = ['lord', 'retainer', 'boss', 'npc'];
      const role = String(details.role ?? '').toLowerCase();
      const border = variants.includes(role) ? role : 'npc';
      for (const variant of variants) this.element.classList.toggle(`nameplate-border-${variant}`, variant === border);

      const titles = this.createElement('div', ['nameplate-titles']);
      const iconPath = String(details.icon ?? '').trim();
      if (iconPath) {
        const icon = document.createElement('img');
        icon.className = 'nameplate-faction-icon';
        icon.src = iconPath;
        icon.alt = String(details.name || 'Faction');
        titles.append(icon);
      }
      this.element.classList.toggle('nameplate-centered', !iconPath);

      const name = this.createElement('div', ['nameplate-text', 'clickable']);
      name.textContent = this.actor?.name || 'Unknown';
      this.addEventListener(name, 'click', event => {
        event.stopPropagation();
        this.actor?.sheet?.render?.(true);
      });
      titles.append(name);
      if (details.name) {
        const faction = this.createElement('div', ['nameplate-faction-name']);
        faction.textContent = details.name;
        if (details.color) faction.style.color = details.color;
        titles.append(faction);
      }
      this.element.append(titles);
      const progression = buildProgression(this, projectBg3Progression(this.actor));
      if (progression) this.element.append(progression);
      return this.element;
    }

    async updateNameplate() { await this.render(); }
  }

  return class EmblemPortraitContainer extends PortraitContainer {
    async render() {
      await super.render();
      if (!this.token || !this.actor) return this.element;
      const imageContainer = this.element.querySelector('.portrait-image-subcontainer');
      if (imageContainer && this.actor.img) {
        imageContainer.replaceChildren();
        const image = this._createMediaElement(this.actor.img, this.actor.name || 'Portrait');
        imageContainer.append(image);
        decoratePortraitMedia(image, this.actor);
      }
      this.nameplateComponent?.destroy?.();
      this.nameplateComponent = new EmblemPortraitNameplate({ actor: this.actor, token: this.token, parent: this });
      const nameplate = await this.nameplateComponent.render();
      this.element.querySelector('.emblem-nameplate')?.remove();
      const portrait = this.element.querySelector('.portrait-image-container');
      if (portrait) portrait.insertAdjacentElement('afterend', nameplate);
      else this.element.append(nameplate);
      return this.element;
    }

    async swapTokenContext(actor, token) {
      await super.swapTokenContext(actor, token);
      if (this.nameplateComponent) {
        this.nameplateComponent.actor = actor;
        this.nameplateComponent.token = token;
        await this.nameplateComponent.updateNameplate();
      }
      const media = this.element?.querySelector('.portrait-image-subcontainer .portrait-image, '
        + '.portrait-image-subcontainer .portrait-video');
      if (media) decoratePortraitMedia(media, actor);
      return this.element;
    }

    async getPortraitImage() { return this.actor?.img || this.token?.document?.texture?.src || ''; }

    getHealth() {
      const value = Number(this.actor?.system?.resources?.hp?.value) || 0;
      const max = Math.max(1, Number(this.actor?.system?.resources?.hp?.max) || 1);
      return { current: value, max, percent: Math.max(0, Math.min(100, value / max * 100)), damage: max - value };
    }

    getPortraitScale() { return { enabled: false, scale: 1 }; }
    async updateNameplate() { await this.nameplateComponent?.updateNameplate?.(); }
  };
}

function decoratePortraitMedia(media, actor) {
  media.classList.add('emblem-pixel-art');
  media.style.imageRendering = 'pixelated';
  if (media.tagName !== 'IMG') return;
  media.style.removeProperty('transform');
  media.style.removeProperty('transform-origin');
  media.style.removeProperty('clip-path');
  const anchor = () => requestAnimationFrame(() => anchorPortrait(media, actor));
  media.addEventListener('load', anchor, { once: true });
  if (media.complete && media.naturalWidth) anchor();
}

/** The level, class and experience block, or null for a unit that has none of them to show. */
function buildProgression(component, progression) {
  if (!progression) return null;
  const panel = component.createElement('div', ['emblem-progression-panel']);
  const row = component.createElement('div', ['progression-row']);
  const identity = component.createElement('div', ['progression-identity']);
  if (progression.level !== null) {
    const levelElement = document.createElement('span');
    levelElement.className = 'nameplate-lvl';
    levelElement.textContent = `Lvl ${progression.level}`;
    identity.append(levelElement);
  }
  if (progression.className) {
    const className = document.createElement('span');
    className.className = 'nameplate-class-name';
    className.textContent = progression.className;
    identity.append(className);
  }
  if (progression.pendingChoices.length) identity.append(buildFeatureAlert(component, progression.pendingChoices[0]));
  row.append(identity);
  if (progression.className && progression.classImage) {
    const icon = document.createElement('img');
    icon.className = 'nameplate-class-icon emblem-pixel-art';
    icon.src = progression.classImage;
    icon.alt = progression.className;
    row.append(icon);
  }
  panel.append(row);
  if (progression.progressing) {
    const track = component.createElement('div', ['nameplate-xp-track']);
    track.dataset.tooltip = `${progression.experience} / ${progression.experienceMax} XP to next level`;
    const fill = document.createElement('div');
    fill.className = 'nameplate-xp-fill';
    fill.style.width = `${progression.experiencePercent}%`;
    track.append(fill);
    panel.append(track);
  }
  return panel;
}

/** The alert icon for a pending feature choice. Clicking it opens that class's sheet on its features tab. */
function buildFeatureAlert(component, pending) {
  const alert = component.createElement('i', ['nameplate-feature-alert', 'clickable', 'fas', 'fa-exclamation-circle']);
  alert.dataset.tooltip = 'New feature available';
  component.addEventListener(alert, 'click', async event => {
    event.stopPropagation();
    const classItem = await fromUuid(pending.classUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'classItem'); return null; });
    if (!classItem?.sheet) return;
    classItem.sheet._activeTab = 'features';
    classItem.sheet.render(true);
  });
  return alert;
}

/**
 * Scale the portrait image by the actor's avatar scale, anchored at the bottom of the visible art rather than the
 * image's transparent padding, and clip whatever spills outside the frame.
 */
function anchorPortrait(image, actor) {
  const container = image.closest('.portrait-image-subcontainer') ?? image.parentElement;
  const boxWidth = container?.clientWidth;
  const boxHeight = container?.clientHeight;
  if (!boxWidth || !boxHeight || !image.naturalWidth || !image.naturalHeight) return;
  const scale = resolveAvatarScale(actor?.system?.art?.avatarScale);
  const bottomPad = measureBottomPad(image);
  if (bottomPad === null) return;
  const fit = Math.min(boxWidth / image.naturalWidth, boxHeight / image.naturalHeight);
  const contentGap = bottomPad * image.naturalHeight * fit;
  const shift = contentGap * scale;
  const insetTop = Math.max(0, boxHeight - (boxHeight + shift) / scale);
  const insetSide = boxWidth / 2 * (1 - 1 / scale);
  image.style.transformOrigin = 'center bottom';
  image.style.transform = `translateY(${shift}px) scale(${scale})`;
  image.style.clipPath = `inset(${insetTop}px ${insetSide}px ${contentGap}px ${insetSide}px)`;
}

const bottomPadCache = new Map();
/**
 * The share of the image's height taken by transparent rows at the bottom, cached per file. Returns null when the
 * pixels can't be read, as for a cross-origin image.
 */
function measureBottomPad(image) {
  const source = image.currentSrc || image.src;
  if (bottomPadCache.has(source)) return bottomPadCache.get(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let bottom = -1;
    for (let row = canvas.height - 1; row >= 0 && bottom < 0; row -= 1) {
      for (let column = 0; column < canvas.width; column += 1) {
        if (pixels[(row * canvas.width + column) * 4 + 3] > 16) { bottom = row; break; }
      }
    }
    const pad = bottom < 0 ? 0 : (canvas.height - 1 - bottom) / canvas.height;
    bottomPadCache.set(source, pad);
    return pad;
  } catch (diagnosticError) {
    reportFoundryProbe(import.meta.url, diagnosticError, 'measureBottomPad', diagnosticError?.name === 'SecurityError');
    return null;
  }
}

/* -------------------------------------------- */
/*  Passive features                            */
/* -------------------------------------------- */
function buildPassivesContainer(PassivesContainer) {
  return class EmblemPassivesContainer extends PassivesContainer {
    render(...args) { return takeRenderTurn(this, () => super.render(...args)); }

    getPassiveItems() {
      return [...(this.actor?.items ?? [])].filter(item =>
        item.type === 'Ability' && item.system?.itemType === 'Passive');
    }
    getSelectedPassives() { return new Set(this.getPassiveItems().map(item => item.uuid)); }
    getDisplayedPassives() { return this.getPassiveItems(); }
    async showConfigurationDialog() {}
  };
}

/**
 * Run a component's renders one at a time, because Core loses track of a button that an overlapping render added.
 * Used by EmblemPassivesContainer and the patched effect strip (core-runtime.mjs).
 */
export function takeRenderTurn(component, render) {
  const previous = component._emblemRenderTurn ?? Promise.resolve();
  const turn = previous.catch(() => {}).then(render);
  const release = () => { if (component._emblemRenderTurn === turn) component._emblemRenderTurn = null; };
  turn.then(release, release);
  component._emblemRenderTurn = turn;
  return turn;
}

/* -------------------------------------------- */
/*  HUD scale                                   */
/* -------------------------------------------- */
/** Clamp HUD scale before forwarding it to BG3 HUD Core’s client setting. */
export function normalizeBg3HudScale(value) {
  const number = Number(value);
  const clamped = Math.max(BG3_HUD_SCALE.min, Math.min(BG3_HUD_SCALE.max, Number.isFinite(number) ? number : 1));
  return Math.round(clamped / BG3_HUD_SCALE.step) * BG3_HUD_SCALE.step;
}

/* -------------------------------------------- */
/*  Active-effect observer                      */
/* -------------------------------------------- */
let activeObserver = null;

/**
 * Take over the HUD's effect icons, and keep doing so as Core redraws them. A click shows the effect's description,
 * or opens the item behind a wield or armor marker. A right-click takes off from the Grounded marker, unequips
 * through a wield or armor marker, or lets a GM delete the effect. Called after every HUD render.
 */
export function observeEmblemBg3Effects(root) {
  const container = root?.querySelector?.('.bg3-actives-container');
  if (!container) return;
  patchEffectIcons(container);
  activeObserver?.disconnect();
  activeObserver = new MutationObserver(() => patchEffectIcons(container));
  activeObserver.observe(container, { childList: true, subtree: true });
}

/* -------------------------------------------- */
/*  Icon interaction                            */
/* -------------------------------------------- */
function patchEffectIcons(container) {
  for (const icon of container.querySelectorAll('.active-effect-icon')) {
    icon.style.imageRendering = 'pixelated';
    if (icon.dataset.emblemObserved) continue;
    icon.dataset.emblemObserved = 'true';
    icon.addEventListener('click', onEffectClick, true);
    icon.addEventListener('contextmenu', onEffectContext, true);
  }
}

async function onEffectClick(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const effect = await effectForIcon(event.currentTarget);
  if (!effect) return;
  if ((effect.flags?.[SYSTEM_ID]?.isWieldEffect || effect.flags?.[SYSTEM_ID]?.isArmorEffect) && effect.origin) {
    equipmentMarkerItem(effect)?.sheet?.render?.(true);
    return;
  }
  await showBg3EffectDescription(effect);
}

async function onEffectContext(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const effect = await effectForIcon(event.currentTarget);
  if (!effect) return;
  const flags = effect.flags?.[SYSTEM_ID] ?? {};
  if (flags.syntheticFlying) {
    await takeOffFromMarker(effect);
    return;
  }
  if ((flags.isWieldEffect || flags.isArmorEffect) && effect.origin) {
    await unequipFromMarker(effect, flags.isWieldEffect === true);
    return;
  }
  if (!game.user.isGM) return;
  const effectName = effect.name || effect.label || 'Effect';
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: 'Delete Effect' },
    content: `<p>Are you sure you want to delete <strong>"${escapeHtml(effectName)}"</strong>?</p>`,
    modal: true
  });
  if (confirmed) await effect.delete?.();
}

/**
 * Unequip the item behind a wield or armor marker through the inventory API. A wield marker works only on the
 * controlled unit, and then any targeting in progress is cancelled.
 */
async function unequipFromMarker(effect, wield) {
  const item = equipmentMarkerItem(effect);
  const actor = item?.actor ?? null;
  if (!actor?.isOwner) return;
  const token = globalThis.canvas?.tokens?.controlled?.[0] ?? null;
  if (wield && (!token || token.actor !== actor)) return;
  const wasEquipped = item.system?.isEquipped === true;
  const toggled = await game.emblemRpg.api.character.inventory.toggleEquipment({
    actorUuid: actor.uuid,
    itemId: item.id
  });
  if (toggled?.ok && item.system?.itemType === 'Mount') void playMountFlourish(actor, { dismount: wasEquipped });
  if (wield && toggled?.ok && actor.activeItem) emitBg3HudAction('cancel-targeting', ui.BG3HUD_APP);
}

/** Fire emblemRpg.bg3HudAction with the HUD's shown token and actor. onBg3HudAction in init/hooks.mjs handles it. */
export function emitBg3HudAction(intent, app, extra = null) {
  Hooks.callAll('emblemRpg.bg3HudAction', intent, app?.currentToken, app?.currentActor, extra);
}

/* -------------------------------------------- */
/*  Effect description                          */
/* -------------------------------------------- */
const DESCRIPTION_TEMPLATE = `systems/${SYSTEM_ID}/templates/dialogs/effect-description.hbs`;

/** Render effect details in the shared description dialog. */
export async function showBg3EffectDescription(effect) {
  if (!effect) return null;
  const effectName = effect.name || effect.label || 'Effect';
  const content = await globalThis.foundry.applications.handlebars.renderTemplate(DESCRIPTION_TEMPLATE, {
    effectName,
    effectImg: effect.img || effect.icon || 'icons/svg/aura.svg',
    description: sanitizeHtml(effect.description ?? '') || 'No description available.',
    ...describeDuration(effect.flags?.[SYSTEM_ID]?.duration)
  });
  return globalThis.foundry.applications.api.DialogV2.wait({
    window: { title: effectName },
    classes: [SYSTEM_ID, 'dialog-effect-description'],
    content,
    buttons: [{ action: 'ok', label: 'OK', icon: 'fas fa-check', default: true }]
  });
}

/** The duration lines of the description dialog. A duration of 0 lasts until an end trigger removes the status. */
function describeDuration(duration) {
  const hasDuration = duration !== undefined && duration !== null;
  return {
    hasDuration,
    duration: hasDuration ? Number(duration) : null,
    untilRemoved: hasDuration && Number(duration) === 0,
    plural: !hasDuration || Number(duration) !== 1
  };
}

/** Take off by right-clicking a grounded flier's Grounded marker, then play its Mount's take-off animation. */
async function takeOffFromMarker(effect) {
  const actor = effect?.parent ?? null;
  if (!actor?.isOwner || actor.system?.statuses?.grounded !== true) return;
  const token = actor.getActiveTokens?.()?.[0]?.document ?? actor.token ?? null;
  const tokenUuid = String(token?.uuid ?? '');
  if (!tokenUuid) return;
  const result = await game.emblemRpg.api.movement.takeOff(tokenUuid);
  if (result?.ok) void playMountFlourish(actor, { dismount: false });
}

async function effectForIcon(icon) {
  if (icon?.dataset?.uuid) {
    const effect = await fromUuid(icon.dataset.uuid);
    if (effect) return effect;
  }
  return ui.BG3HUD_APP?.currentActor?.syntheticEffect?.(icon?.dataset?.effectId) ?? null;
}
