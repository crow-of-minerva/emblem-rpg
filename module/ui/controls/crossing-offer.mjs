/** @layer ui/controls */
import { CROSSING_SKILLS, FALL_MARGIN } from '../../contracts/domains/terrain.mjs';
import { crossingFallDamage, resolveCrossingCheck } from '../../game/terrain/rules.mjs';
import { SKILL_BY_KEY } from '../../game/character/rules.mjs';
import { successChanceBand } from '../../game/objects/rules.mjs';
import { SOUND_IDS } from '../../presentation/audio/sound-database.mjs';
import { playUiSound } from '../../presentation/audio/service.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { captureForDialog } from '../dialogs.mjs';
import { escapeHtml } from '../../lib/dom/html.mjs';
import { trimContainerSprites } from '../../lib/dom/image-trim.mjs';

/* -------------------------------------------- */
/*  Crossing offer                              */
/* -------------------------------------------- */

/**
 * Ask whether to attempt a terrain crossing that a refused step leads to. movement.mjs (promptCrossing) holds the
 * plan in its CROSSING state while this dialog is open, and sends `movement.cross` for the crossing the player
 * confirms. This file writes nothing, and the only live thing it reads is the unit's token image.
 *
 * When one step can reach more than one landing, the dialog opens with a destination select and redraws its body
 * when the choice changes. With a single destination there is no select.
 * @param {object} snapshot The plan's movement snapshot, which names the unit and its odds.
 * @param {object[]} options The crossings this step leads to.
 * @returns {Promise<object|null>} The confirmed crossing, or null when the player declined.
 */
export async function crossingDialog(snapshot, options) {
  let chosen = options[0];
  const picker = options.length > 1
    ? `<div class="crossing-target-row"><select class="crossing-target-select">${options.map((option, index) => (
      `<option value="${index}">${escapeHtml(crossingLabel(option, options))}</option>`
    )).join('')}</select></div>`
    : '';
  const content = `<div class="effect-preview-dialog crossing-dialog">
    ${picker}
    <div class="crossing-body">${crossingOfferContent(snapshot, chosen)}</div>
  </div>`;
  let confirmed = false;
  await foundry.applications.api.DialogV2.wait({
    window: { title: 'Cross Terrain', icon: 'fas fa-person-hiking', resizable: false },
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
      { action: 'cancel', icon: 'fas fa-times', label: 'Cancel', callback: () => {} }
    ],
    render: (_event, dialog) => {
      const html = dialog.element;
      trimContainerSprites(html);
      const select = html.querySelector('.crossing-target-select');
      select?.addEventListener('change', () => {
        chosen = options[Number(select.value)] ?? options[0];
        const body = html.querySelector('.crossing-body');
        if (body) body.innerHTML = crossingOfferContent(snapshot, chosen);
        trimContainerSprites(html);
        playUiSound(SOUND_IDS.UI_SELECT_ALT);
      });
      captureForDialog(dialog, { openSound: SOUND_IDS.UI_SELECT_ALT });
    }
  });
  return confirmed ? chosen : null;
}

/* -------------------------------------------- */
/*  Offer content                               */
/* -------------------------------------------- */

const CROSSING_APPROACH_WORDS = Object.freeze({
  up: 'North', down: 'South', left: 'West', right: 'East'
});

/** A destination's label in the select: zone and level, plus the approach side when two would otherwise match. */
function crossingLabel(option, all) {
  const base = `${option.zoneName} (Lv ${option.toElevation})`;
  const shared = all.filter(other => `${other.zoneName} (Lv ${other.toElevation})` === base).length > 1;
  const approach = CROSSING_APPROACH_WORDS[option.approach];
  return shared && approach ? `${base} | ${approach}` : base;
}

/** The body of the offer: the odds this unit crosses at and, for a descent, the worst case. */
function crossingOfferContent(snapshot, option) {
  const odds = resolveCrossingCheck(option, snapshot);
  const band = successChanceBand(odds.chance);
  const skill = SKILL_BY_KEY[odds.skillKey];
  const skillLabel = option.skillType === CROSSING_SKILLS.EITHER
    ? `${skill?.label ?? odds.skillKey} (Athletics/Finesse)`
    : skill?.label ?? option.skillType;
  const fall = option.descending
    ? `<div class="failure-chance low-chance">Fall risk on failure: up to ${
      Math.round(crossingFallDamage({ levels: option.levels, miss: FALL_MARGIN, maxHp: 100 }))}% max HP</div>`
    : '';
  const zone = escapeHtml(option.zoneName);
  const name = escapeHtml(snapshot.actorName);
  const art = escapeHtml(crossingTokenArt(snapshot));
  return `<div class="effect-header">
      <div class="effect-confirmation-prompt">
        <span class="confirmation-text">Cross into "${zone}" (Lv ${option.toElevation})?</span>
      </div>
    </div>
    <hr class="effect-preview-divider" />
    <div class="target-grid-container">
      <div class="target-grid single-target">
        <div class="target-token-container centered">
          <div class="target-token-frame">
            <img src="${art}" data-sprite-src="${art}" alt="${name}" class="target-token-image crossing-token-image" />
          </div>
          <label class="target-name">${name}</label>
          <div class="skill-check-dc">
            <div class="skill-info">${escapeHtml(skillLabel)} vs DC ${option.dc}</div>
            <div class="failure-chance ${band}">Success Rate: ${odds.chance}%</div>
            ${fall}
          </div>
        </div>
      </div>
    </div>`;
}

/** The crossing unit's board sprite, which the prompt frames instead of its avatar. */
function crossingTokenArt(snapshot) {
  const texture = globalThis.canvas?.tokens?.get?.(snapshot.tokenId)?.document?.texture?.src;
  return String(texture || snapshot.tokenImg || '');
}
