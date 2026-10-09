/** @layer ui/apps/foundry */
import { ACTOR_TYPES } from '../../../config/constants.mjs';
import { FLIGHT_STATUS_MARKERS } from '../../../config/statuses.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { NotificationService } from '../../../presentation/interface/notifications.mjs';
import { unitIgnoresLineOfSight } from '../../../game/character/rules.mjs';
import { canFoundryUserAuthorDocument } from '../../../foundry/adapters/services/authority.mjs';
import { localUserIsStaff } from '../../../foundry/adapters/services/host.mjs';
import { playMountFlourish } from '../../../external/sequencer/animation-dispatch.mjs';
import { FoundryDiagnostics, reportFoundryError } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Token HUD controls                          */
/* -------------------------------------------- */
const FLIGHT_CLASS = 'emblem-flight-toggle';
const FREE_TARGETING_CLASS = 'emblem-free-targeting-toggle';
const FLIGHT_TOOLTIPS = Object.freeze({ ground: 'Set Grounded', lift: 'Set Airborne' });
const FREE_TARGETING_TOOLTIP = 'Free Targeting';

const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/**
 * Add the system's unit controls to the Token HUD's right column.
 *
 * init/hooks.mjs calls this on renderTokenHUD, after foundry/patches/ui-chrome.mjs has removed the core
 * controls the system replaces. Free targeting goes under Foundry's Hide button and flight under the
 * status-effect palette, the order the column already renders them in. Each control has its own conditions,
 * so a unit can get one without the other.
 * @param {object} hud The TokenHUD.
 * @param {HTMLElement|HTMLElement[]} html Its rendered root.
 * @returns {Readonly<{flight: HTMLElement|null, freeTargeting: HTMLElement|null}>} What was installed.
 */
export function onRenderUnitTokenHud(hud, html) {
  const root = typeof html?.querySelectorAll === 'function' ? html : html?.[0];
  const actor = hud.actor ?? null;
  const tokenUuid = String(hud.document?.uuid ?? '');
  const column = root?.querySelector?.('.col.right') ?? null;
  if (!column || !tokenUuid || actor?.type !== ACTOR_TYPES.CHARACTER) {
    return Object.freeze({ flight: null, freeTargeting: null });
  }
  return Object.freeze({
    freeTargeting: installFreeTargetingControl(column, actor),
    flight: installFlightControl(column, actor, tokenUuid)
  });
}

/** Build one HUD button in the core shape, with a Font Awesome glyph and the HUD's own toggled styling. */
function hudControl(className, icon) {
  const control = document.createElement('button');
  const glyph = document.createElement('i');
  control.type = 'button';
  control.className = `control-icon ${className}`;
  control.setAttribute('data-tooltip', '');
  glyph.className = icon;
  glyph.setAttribute('inert', '');
  control.append(glyph);
  return control;
}

/** Show a toggle's state the way the HUD's own toggles do, and name it for the tooltip and for screen readers. */
function showToggleState(control, className, label, on) {
  control.className = `control-icon ${className}${on ? ' active' : ''}`;
  control.setAttribute('aria-pressed', on ? 'true' : 'false');
  control.setAttribute('aria-label', label);
}

/* -------------------------------------------- */
/*  Free targeting                              */
/* -------------------------------------------- */
/**
 * Add the free-targeting override under Foundry's Hide button. While it is on, the unit's actions ignore line
 * of sight: game/character/rules.mjs turns the flag into an `ignoreLoS` rule for every targeting grid,
 * line-of-sight check and attack check. Only the GM sees it, and the host rechecks that
 * (`character.targeting.set-free-targeting`).
 */
function installFreeTargetingControl(column, actor) {
  if (!localUserIsStaff() || column.querySelector(`.${FREE_TARGETING_CLASS}`)) return null;
  const control = hudControl(FREE_TARGETING_CLASS, 'fa-solid fa-crosshairs');
  showToggleState(control, FREE_TARGETING_CLASS, FREE_TARGETING_TOOLTIP,
    unitIgnoresLineOfSight(actor.flags?.[SYSTEM_ID]));
  const hide = column.querySelector('[data-action="visibility"]');
  if (hide) hide.after(control);
  else column.prepend(control);
  control.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void setFreeTargeting(actor, control);
  });
  return control;
}

/** Ask for the opposite of the state the unit holds now, then show the state the host reports back. */
async function setFreeTargeting(actor, control) {
  try {
    const enabled = !unitIgnoresLineOfSight(actor.flags?.[SYSTEM_ID]);
    const result = await game.emblemRpg.api.character.setFreeTargeting({ actorUuid: actor.uuid, enabled });
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    showToggleState(control, FREE_TARGETING_CLASS, FREE_TARGETING_TOOLTIP, result.data?.freeTargeting === true);
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'setFreeTargeting');
  }
}

/* -------------------------------------------- */
/*  Flight                                      */
/* -------------------------------------------- */
/**
 * Add the flight control directly under the status-effect palette. It shows only for a flier that controls its
 * own flight (a levitating unit is held up by an effect instead), and only for a user who may author the unit.
 * In practice that means the GM, because the TokenHUD#bind wrapper in foundry/patches/token-drag.mjs opens the
 * HUD for GMs alone. Its click sends `movement.set-flight`, and the host checks the same conditions again.
 */
function installFlightControl(column, actor, tokenUuid) {
  if (!flightIsAdjustable(actor) || column.querySelector(`.${FLIGHT_CLASS}`)) return null;
  const control = document.createElement('button');
  const icon = document.createElement('img');
  control.type = 'button';
  control.setAttribute('data-tooltip', '');
  control.append(icon);
  showFlightState(control, icon, actor.system?.statuses?.grounded === true);
  const palette = column.querySelector('.palette.status-effects');
  if (palette) palette.after(control);
  else column.append(control);
  control.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void setFlight({ actor, tokenUuid, control, icon });
  });
  return control;
}

/** A flier the table can put up or down: not a levitating unit, whose effect decides for it. */
function flightIsAdjustable(actor) {
  if (actor.system?.unitType?.flying !== true || actor.system?.combat?.levitation === true) return false;
  return canFoundryUserAuthorDocument(game.user, actor);
}

/**
 * Show the unit's flight state on the control, and label it with what a click will do. The markup copies the
 * status-effect button's, so the control picks up the HUD's own button styling. The pixel marker image is styled
 * by `#token-hud .control-icon.emblem-flight-toggle img` in styles/emblem-rpg.css.
 */
function showFlightState(control, icon, grounded) {
  const marker = grounded ? FLIGHT_STATUS_MARKERS.grounded : FLIGHT_STATUS_MARKERS.airborne;
  control.className = `control-icon ${FLIGHT_CLASS}${grounded ? '' : ' active'}`;
  control.setAttribute('aria-label', grounded ? FLIGHT_TOOLTIPS.lift : FLIGHT_TOOLTIPS.ground);
  icon.src = marker.img;
  icon.alt = marker.id;
}

/**
 * Ask for the opposite of the unit's current flight state, then show the state the host reports rather than
 * the local Actor's, which may not have caught up yet on a client other than the host. A refusal is shown through
 * NotificationService. The mount flourish plays after the write and never holds it up.
 */
async function setFlight({ actor, tokenUuid, control, icon }) {
  try {
    const grounded = actor.system?.statuses?.grounded === true;
    const result = await game.emblemRpg.api.movement.setFlight({ tokenUuid, grounded: !grounded });
    if (!result.ok) {
      notifications.showResult(result);
      return;
    }
    showFlightState(control, icon, result.data?.grounded === true);
    void playMountFlourish(actor, { dismount: !grounded });
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'setFlight');
  }
}
