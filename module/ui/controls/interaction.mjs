/** @layer ui/controls */
import {
  DOWNTIME_PICK_MODES, DOWNTIME_ROSTER_FACTIONS, DOWNTIME_STATION_TYPES
} from '../../contracts/domains/downtime.mjs';
import { TRADE_MODES } from '../../contracts/domains/economy.mjs';
import { LOCK_METHODS } from '../../contracts/domains/objects.mjs';
import { INSPECTION_KINDS } from '../../contracts/domains/board.mjs';
import { recordDiagnostic } from '../../contracts/protocol.mjs';
import { projectTargetingBoard } from '../../foundry/adapters/projections/board.mjs';
import {
  clearFoundryActiveItem,
  stageFoundryActiveItem
} from '../../foundry/adapters/projections/attack-targeting.mjs';
import { areFactionsFriendly, areFactionsHostile } from '../../game/character/rules.mjs';
import { resolveStealRoom } from '../../game/economy/trade.mjs';
import { cellsAdjacent, doorsOnPickRing, interactionPickCells, resolveInteractionTarget } from '../../game/objects/rules.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../presentation/interface/notifications.mjs';
import { playUiSound } from '../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../presentation/audio/sound-database.mjs';
import {
  INTERACTION_GRID_COLORS,
  clearAttackTargetingGrid,
  drawAttackTargetingGrid,
  markTargetedTokens
} from '../../presentation/canvas/cell-overlays.mjs';
import { openCookingMenu } from '../apps/menus/cooking-app.mjs';
import { openCraftingMenu } from '../apps/menus/crafting-app.mjs';
import { openGatheringMenu } from '../apps/menus/gathering-app.mjs';
import { openPerformanceMenu } from '../apps/menus/performance-app.mjs';
import { openRequisitionMenu } from '../apps/menus/requisition-app.mjs';
import { openSocialMenu } from '../apps/menus/social-app.mjs';
import { openLockPreview } from '../apps/menus/previews.mjs';
import { openTradeWindow } from '../apps/menus/trade-app.mjs';
import { openVendorShop } from '../apps/menus/vendor-app.mjs';
import {
  localUserFrozenByPause,
  readSetting,
  resolveSync,
  resolveToken
} from '../../foundry/adapters/services/host.mjs';
import { projectInspectedUnit } from '../../foundry/adapters/projections/tokens.mjs';
import { projectDoorVisibilityByUuid } from '../../foundry/adapters/projections/vision.mjs';
import { TOKEN_TOOLTIP_DEFAULT_SCALE, TOKEN_TOOLTIP_SCALE_SETTING } from '../../config/settings.mjs';
import {
  hideTokenTooltip,
  isTokenTooltipVisible,
  positionTokenTooltip,
  showTokenTooltip
} from '../../presentation/interface/token-tooltip.mjs';
import { FoundryDiagnostics , notifyFoundry } from '../../foundry/adapters/services/diagnostics.mjs';
import {
  INSPECT_EVENTS,
  INSPECT_STATES,
  PICK_EVENTS,
  PICK_STATES,
  activePick,
  advanceInspection,
  advanceInteractionPick,
  inspectStateName,
  inspectedAttackIndex,
  inspectedToken,
  interactionHoldsBoard,
  pickOwnsCanvas,
  pickStateName,
  stagedPickActivation
} from './interaction-state.mjs';

/* -------------------------------------------- */
/*  Interaction state                           */
/* -------------------------------------------- */

/*
 * The Interact, Trade and Steal presses, and the door and unit picks they draw on the map. Which pick is drawn,
 * whether its click is still being answered and how many windows are open all live in
 * ui/controls/interaction-state.mjs. The second half of the file is unit inspection: the token tooltip shown while
 * the Show Token Tooltip key is held. Refused commands are shown through NotificationService, so a refused lock,
 * theft, trade or Armament says why instead of only playing the error cue.
 */
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Interact press                              */
/* -------------------------------------------- */

/**
 * The Interact press (the Interact key, or the BG3 HUD's interact action) for the unit whose plan is open.
 * resolveInteractionTarget picks what it works on: an Armament, a downtime station, loot or a chest under the
 * unit, or a locked door beside it. With none of those during free exploration, a Lord or Retainer opens the
 * socialize pick on the party units beside it.
 * @param {object|null} plan The caller's inspected movement plan. Nothing happens without one.
 * @param {{attack?: Function, resume?: Function, suspend?: Function, release?: Function, inspect?: Function}}
 *   [handlers] `attack` starts attack targeting with a picked-up Armament. `suspend` hides the movement grid
 *   while a pick is drawn, and `resume` redraws the plan afterwards. `release` closes the plan where the unit
 *   stands after a door is worked outside an encounter. `inspect` rereads the plan when the socialize pick
 *   reopens after a window closes with nothing spent; it defaults to the pressed plan, marked as held (heldPlan).
 * @returns {Promise<boolean>} Whether the press was consumed.
 */
export async function runInteract(plan, {
  attack = null, resume = null, suspend = null, release = null, inspect = null
} = {}) {
  if (!plan || !plan.inputReady || activePick()) return false;
  if (localUserFrozenByPause()) return refuseWhileTablePaused();
  const board = projectTargetingBoard(resolveSync(plan.tokenUuid, 'Token')?.parent ?? null);
  const unit = board?.units.find(entry => entry.tokenUuid === plan.tokenUuid);
  if (!unit) return false;
  const target = resolveInteractionTarget({
    unitCells: unit.cells,
    objects: board.units.filter(entry => entry.actorType === 'Object'),
    exploring: board.explorationActive === true,
    doorVisible: door => projectDoorVisibilityByUuid(plan.tokenUuid, door.tokenUuid)
  });
  if (target.kind === 'armament') return takeUpArmament(plan.tokenUuid, target.object, attack);
  if (target.kind === 'station') return interactWithStation(plan.tokenUuid, target.object);
  if (target.kind === 'loot' || target.kind === 'chest') return interactWithContainer(plan.tokenUuid, target.object, resume);
  if (target.kind === 'doors') return beginDoorPick(plan, unit, board, { suspend, resume, release });
  const socializes = board.explorationActive === true && DOWNTIME_ROSTER_FACTIONS.includes(unit.faction);
  if (target.kind === 'none' && socializes) {
    const reread = inspect ?? (() => heldPlan(plan));
    return beginUnitPick(plan, DOWNTIME_PICK_MODES.SOCIAL, areFactionsFriendly,
      pickHandlers({ suspend, resume, inspect: reread }));
  }
  return false;
}

/**
 * The plan a socialize pick reopens from when its caller supplied no inspection: the pressed plan, marked as the
 * suspended plan the pick still holds. beginUnitPick asks `suspend` again before drawing, which refuses once the
 * movement plan behind it is gone.
 */
function heldPlan(plan) {
  return { ...plan, inputReady: false, suspended: true };
}

const STATION_MENUS = Object.freeze({
  [DOWNTIME_STATION_TYPES.COOKING]: Object.freeze({ inspect: 'inspectCooking', open: openCookingMenu }),
  [DOWNTIME_STATION_TYPES.GATHERING]: Object.freeze({ inspect: 'inspectGathering', open: openGatheringMenu }),
  [DOWNTIME_STATION_TYPES.PERFORMANCE]: Object.freeze({ inspect: 'inspectPerformance', open: openPerformanceMenu }),
  [DOWNTIME_STATION_TYPES.REQUISITION]: Object.freeze({ inspect: 'inspectRequisition', open: openRequisitionMenu })
});
const CRAFTING_MENU = Object.freeze({ inspect: 'inspectCrafting', open: openCraftingMenu });

/** Open the menu of the downtime station under the unit, or show the station's refusal instead. */
async function interactWithStation(sourceTokenUuid, station) {
  const { downtime } = game.emblemRpg.api;
  const menu = STATION_MENUS[station.objectType] ?? CRAFTING_MENU;
  const intent = { cursorTokenUuid: sourceTokenUuid, stationTokenUuid: station.tokenUuid };
  const inspect = () => downtime[menu.inspect](intent);
  const view = await inspect();
  if (!view) return false;
  if (view.refusal) {
    notifications.show(view.refusal, view.refusalData);
    return true;
  }
  advanceInteractionPick(PICK_EVENTS.WINDOW_OPENED);
  try {
    await menu.open(view, { refresh: inspect });
  } finally {
    advanceInteractionPick(PICK_EVENTS.WINDOW_CLOSED);
  }
  return true;
}

async function interactWithContainer(sourceTokenUuid, object, resume) {
  if (object.locked === false) return openTradeFor(sourceTokenUuid, object.tokenUuid, TRADE_MODES.LOOT, { resume });
  return attemptLock(sourceTokenUuid, object.tokenUuid, { resume });
}

/**
 * Refuse interaction targeting while the unit is still moving, its stance is broken, or it shares its square
 * with another unit. Play the error cue, except for a broken stance, whose notification has its own cue and text.
 */
function pickRefused(plan, unit) {
  if (plan.moving === true) return cueRefusal();
  if (Number.isFinite(unit?.stance) && unit.stance <= 0) {
    notifications.show(NOTIFICATION_IDS.OBJECT_STANCE_BROKEN);
    return true;
  }
  if (plan.squareShared === true) return cueRefusal();
  return false;
}

function cueRefusal() {
  playUiSound(SOUND_IDS.UI_ERROR);
  return true;
}

/* -------------------------------------------- */
/*  Trade and steal picks                       */
/* -------------------------------------------- */

/**
 * The Trade press (the Trade key, or the BG3 HUD's trade action) for the unit whose plan is open: every friendly
 * unit and Vendor beside it is marked, and the player clicks one.
 * @param {object|null} plan The caller's inspected movement plan. Nothing happens without one.
 * @param {{inspect?: Function, suspend?: Function, resume?: Function, release?: Function}} [handlers] `inspect`
 *   rereads the plan so the pick can reopen after a window closes unconfirmed. `suspend` hides the movement grid
 *   while the pick is drawn. `resume` redraws the plan once the pick is abandoned or the trade is done.
 *   `release` ends the turn where the unit stands after it leaves a shop it traded at during an encounter.
 * @returns {Promise<boolean>} Whether the press was consumed.
 */
export async function runTrade(plan, handlers = {}) {
  return beginUnitPick(plan, TRADE_MODES.TRADE, areFactionsFriendly, pickHandlers(handlers));
}

/**
 * The Steal press: every hostile unit beside the thief is marked, and the player clicks one. activateHotbarItem
 * in targeting.mjs calls this when the pressed hotbar cell holds the Steal ability.
 * @param {object|null} plan The caller's inspected movement plan. Nothing happens without one.
 * @param {{inspect?: Function, suspend?: Function, resume?: Function, activation?: object}} [handlers] `inspect`
 *   rereads the plan, `suspend` hides the movement grid while the pick is drawn and the host rolls, and
 *   `resume` redraws the plan once the attempt is over. `activation` is the hotbar cell the press came from,
 *   shown as the unit's active item while the pick is drawn.
 * @returns {Promise<boolean>} Whether the press was consumed.
 */
export async function runSteal(plan, handlers = {}) {
  return beginUnitPick(plan, TRADE_MODES.STEAL, areFactionsHostile, pickHandlers(handlers));
}

function pickHandlers({ inspect = null, suspend = null, resume = null, release = null, activation = null } = {}) {
  return Object.freeze({ inspect, suspend, resume, release, activation });
}

/** Mark the pressed Ability as the unit's active item, so its hotbar cell shows as pending like any other. */
async function markPickActivation(activation) {
  if (!activation || stagedPickActivation()) return;
  advanceInteractionPick(PICK_EVENTS.STAGE_ACTIVATION, { activation });
  await stageFoundryActiveItem(activation);
}

/** Drop that mark: the attempt is over, whether it was abandoned, refused, or done. */
async function clearPickActivation() {
  const staged = stagedPickActivation();
  if (!staged) return;
  advanceInteractionPick(PICK_EVENTS.CLEAR_ACTIVATION);
  await clearFoundryActiveItem(staged);
}

/** After a reopen, keep that mark only if the unit pick was actually drawn again. */
function settlePickActivation() {
  if (pickStateName() !== PICK_STATES.UNITS) void clearPickActivation();
}

/** A press opens a pick on a plan taking input. A reopen also accepts the plan the same pick already holds. */
function planAcceptsPick(plan, held) {
  if (!plan) return false;
  return plan.inputReady === true || (held === true && plan.suspended === true);
}

/**
 * Draw a unit pick (trade, steal or socialize) around the plan's unit and mark the units a click may land on. A
 * unit on another unit's square can't pick until it steps off, and a spent bonus action bars a trade. `held` is
 * set when a pick reopens over a plan it already suspended.
 */
function beginUnitPick(plan, mode, related, handlers, { quiet = false, held = false } = {}) {
  if (!planAcceptsPick(plan, held) || activePick()) return false;
  if (localUserFrozenByPause()) return refuseWhileTablePaused();
  if (mode === TRADE_MODES.TRADE && plan.tradeAvailable === false) return true;
  const board = projectTargetingBoard(resolveSync(plan.tokenUuid, 'Token')?.parent ?? null);
  const unit = board?.units.find(entry => entry.tokenUuid === plan.tokenUuid) ?? null;
  if (!held && pickRefused(plan, unit)) return true;
  if (!unit) return false;
  const candidates = board.units.filter(entry => entry.tokenUuid !== unit.tokenUuid && entry.hidden !== true
    && pickAdmits(mode, unit, entry, related) && cellsAdjacent(unit.cells, entry.cells));
  if (!candidates.length) {
    playUiSound(SOUND_IDS.UI_ERROR);
    return true;
  }
  if (handlers.suspend && handlers.suspend(plan.tokenUuid) !== true) return false;
  advanceInteractionPick(PICK_EVENTS.OPEN_UNITS, {
    pick: Object.freeze({
      sourceTokenUuid: plan.tokenUuid, mode, related, handlers,
      suspended: Boolean(handlers.suspend), tokenUuids: candidates.map(c => c.tokenUuid)
    })
  });
  drawPickGrid(board, unit, pickColor(mode));
  void markPickActivation(handlers.activation);
  if (!quiet) playUiSound(SOUND_IDS.UI_SELECT);
  return true;
}

/**
 * Who a pick may land on: a related unit, or for a trade the Vendor beside it, which answers to no faction. A
 * socialize pick lands only on the Lords and Retainers a downtime roster is drawn from, in the picking unit's own
 * party, so a unit in no party has nobody to visit.
 */
function pickAdmits(mode, unit, entry, related) {
  if (mode === DOWNTIME_PICK_MODES.SOCIAL) {
    return entry.combatant === true && DOWNTIME_ROSTER_FACTIONS.includes(entry.faction)
      && related(unit.faction, entry.faction) && Boolean(unit.partyId) && entry.partyId === unit.partyId;
  }
  if (entry.combatant) return related(unit.faction, entry.faction);
  return mode === TRADE_MODES.TRADE && entry.actorType === 'Vendor';
}

/** The colour a unit pick is drawn in: green for a socialize pick, amber for a trade or a steal. */
function pickColor(mode) {
  return mode === DOWNTIME_PICK_MODES.SOCIAL ? INTERACTION_GRID_COLORS.social : INTERACTION_GRID_COLORS.trade;
}

/** Reopen the pick a window was opened from, without the select sound, since to the player it never closed. */
function reopenUnitPick(pick) {
  const plan = pick.handlers.inspect?.() ?? null;
  const held = pick.suspended === true;
  const reopened = beginUnitPick(plan, pick.mode, pick.related, pick.handlers, { quiet: true, held });
  settlePickActivation();
  return reopened;
}

/** The range-1 grid a pick is drawn on, in the colour that tells the player what the click will do. */
function drawPickGrid(board, unit, color) {
  drawAttackTargetingGrid({ gridSize: board.gridSize, targetableCells: interactionPickCells(unit.cells), color });
}

/**
 * Read both sides, open the window, send what it confirms, and return to the pick when nothing was spent. When
 * the pick can't be drawn again, returnToPick hands the held plan back instead. The unit pick's click lands here
 * in every mode, and a socialize click is passed on to openSocialFor. Loose loot and opened chests come here too,
 * from interactWithContainer and attemptLock.
 */
async function openTradeFor(sourceTokenUuid, targetTokenUuid, mode, handlers = {}) {
  if (mode === DOWNTIME_PICK_MODES.SOCIAL) return openSocialFor(sourceTokenUuid, targetTokenUuid, handlers);
  const { resume = null, suspend = null, release = null, reopen = null, held = false } = handlers;
  const restore = async ({ announce = false } = {}) => {
    await clearPickActivation();
    if (held && typeof resume === 'function') await resume(sourceTokenUuid, { announce });
  };
  const { economy } = game.emblemRpg.api;
  const stealing = mode === TRADE_MODES.STEAL;
  if (!stealing && await isVendorToken(targetTokenUuid)) {
    return openShopFor(economy, sourceTokenUuid, targetTokenUuid, { restore, release, reopen });
  }
  const view = await economy.inspectTrade({ sourceTokenUuid, targetTokenUuid, mode });
  if (!view) {
    await restore();
    return false;
  }
  if (view.refusal) {
    notifications.show(view.refusal, view.refusalData);
    await returnToPick(reopen, restore);
    return true;
  }
  if (stealing && !view.target.items.length) {
    notifications.show(NOTIFICATION_IDS.STEAL_NOTHING_TO_TAKE, { targetName: view.target.name });
    await returnToPick(reopen, restore);
    return true;
  }
  const confirm = stealing
    ? choices => confirmStealRoom(view, choices)
    : choices => settleTrade(economy, { sourceTokenUuid, targetTokenUuid, ...choices });
  const rowResume = held && typeof suspend === 'function'
    ? async uuid => {
      if (typeof resume === 'function') await resume(uuid);
      suspend(uuid);
    }
    : resume;
  let choice;
  advanceInteractionPick(PICK_EVENTS.WINDOW_OPENED);
  try {
    choice = await openTradeWindow(view, {
      confirm,
      resume: rowResume,
      refresh: stealing ? null : () => economy.inspectTrade({ sourceTokenUuid, targetTokenUuid, mode })
    });
  } finally {
    advanceInteractionPick(PICK_EVENTS.WINDOW_CLOSED);
  }
  if (!choice?.confirmed) {
    await returnToPick(reopen, restore);
    return true;
  }
  if (stealing) {
    const intent = { sourceTokenUuid, targetTokenUuid, itemIds: choice.takeItemIds };
    return attemptSteal(economy, intent, { suspend, resume, reopen });
  }
  if (typeof resume === 'function') await resume(sourceTokenUuid, { announce: true });
  return true;
}

/** Send the confirmed trade. A refusal is shown and keeps the trade window open. */
async function settleTrade(economy, { sourceTokenUuid, targetTokenUuid, giveItemIds, takeItemIds }) {
  const result = await economy.trade({ sourceTokenUuid, targetTokenUuid, giveItemIds, takeItemIds });
  if (result?.ok === true) return true;
  notifications.showResult(result);
  return false;
}

/** Refuse a selection the thief can't carry before the window closes, so the player can change it. */
function confirmStealRoom(view, choices) {
  const items = view.target.items.filter(item => choices.takeItemIds.includes(item.id));
  const thief = { kind: view.source.kind, name: view.source.name, ...view.source.room };
  const room = resolveStealRoom(thief, items);
  if (room.ok) return true;
  notifications.show(room.code, room.data);
  return false;
}

/** Suspend the plan while the host rolls the theft, then hand it back. A refusal is shown and reopens the pick. */
async function attemptSteal(economy, intent, { suspend, resume, reopen }) {
  let result;
  try {
    suspend?.(intent.sourceTokenUuid);
    result = await economy.steal(intent);
  } finally { if (typeof resume === 'function') await resume(intent.sourceTokenUuid); }
  if (result?.ok !== true) {
    notifications.showResult(result);
    reopen?.();
  }
  else await clearPickActivation();
  return true;
}

async function isVendorToken(tokenUuid) {
  return (await resolveToken(tokenUuid))?.actor?.type === 'Vendor';
}

/**
 * Open the Vendor shop from a trade pick. Return to the pick (or hand the plan back when it can't be redrawn) on a
 * refusal or a visit that traded nothing. Leaving after a trade ends the turn where the unit stands in an
 * encounter. While exploring, it hands the plan back.
 */
async function openShopFor(economy, sourceTokenUuid, targetTokenUuid, { restore, release, reopen }) {
  const inspect = () => economy.inspectShop({ buyerTokenUuid: sourceTokenUuid, vendorTokenUuid: targetTokenUuid });
  const view = await inspect();
  if (!view) {
    await restore();
    return false;
  }
  if (view.refusal) {
    notifications.show(view.refusal, view.refusalData);
    await returnToPick(reopen, restore);
    return true;
  }
  advanceInteractionPick(PICK_EVENTS.WINDOW_OPENED);
  let traded = false;
  try {
    traded = await openVendorShop(view, { refresh: inspect });
  } finally {
    advanceInteractionPick(PICK_EVENTS.WINDOW_CLOSED);
  }
  if (!traded) {
    await returnToPick(reopen, restore);
    return true;
  }
  if (view.exploring !== true && typeof release === 'function') {
    await clearPickActivation();
    if (await release(sourceTokenUuid)) return true;
  }
  await restore({ announce: true });
  return true;
}

/** Wield the Armament through the object command, then start attack targeting. */
async function takeUpArmament(sourceTokenUuid, armament, attack) {
  const result = await game.emblemRpg.api.objects.wieldArmament({
    sourceTokenUuid, armamentTokenUuid: armament.tokenUuid
  });
  if (!result?.ok) {
    notifications.showResult(result);
    playUiSound(SOUND_IDS.UI_ERROR);
    return true;
  }
  if (typeof attack === 'function') await attack(armament.tokenUuid);
  return true;
}

/* -------------------------------------------- */
/*  Socialize pick                              */
/* -------------------------------------------- */

/**
 * Answer a socialize pick's click. Read the pair through api.downtime.inspectSocial, then either show its refusal
 * and return to the pick, or open the social menu. A menu closed with nothing done returns to the pick. A
 * finished socialize or training hands the plan back with the selection sound, as a completed trade does.
 * @param {string} sourceTokenUuid The acting unit's Token.
 * @param {string} targetTokenUuid The visited unit's Token.
 * @param {{resume?: Function, held?: boolean, reopen?: Function}} [handlers] The pick's plan hand-back, whether the
 *   pick holds a suspended plan, and its reopening.
 * @returns {Promise<boolean>} Whether the click was answered.
 */
async function openSocialFor(sourceTokenUuid, targetTokenUuid, { resume = null, held = false, reopen = null } = {}) {
  const restore = async ({ announce = false } = {}) => {
    if (held && typeof resume === 'function') await resume(sourceTokenUuid, { announce });
  };
  const intent = { cursorTokenUuid: sourceTokenUuid, partnerTokenUuid: targetTokenUuid };
  const inspect = () => game.emblemRpg.api.downtime.inspectSocial(intent);
  const view = await inspect();
  if (!view) {
    await restore();
    return false;
  }
  if (view.refusal) {
    notifications.show(view.refusal, view.refusalData);
    await returnToPick(reopen, restore);
    return true;
  }
  let settled = false;
  advanceInteractionPick(PICK_EVENTS.WINDOW_OPENED);
  try {
    settled = await openSocialMenu(view, { refresh: inspect });
  } catch (error) {
    recordDiagnostic(notifications.diagnostics, { sourcePath: import.meta.url, error, detail: 'openSocialFor' });
  } finally {
    advanceInteractionPick(PICK_EVENTS.WINDOW_CLOSED);
  }
  if (!settled) {
    await returnToPick(reopen, restore);
    return true;
  }
  await restore({ announce: true });
  return true;
}

/** Reopen the pick. If it can't be drawn again, hand the held plan back instead of leaving it suspended. */
async function returnToPick(reopen, restore) {
  reopen?.();
  if (!activePick()) await restore();
}

/* -------------------------------------------- */
/*  Door pick                                   */
/* -------------------------------------------- */

/**
 * Replace the movement overlay with the door targeting ring. Only doors on the Manhattan range-one grid accept
 * clicks.
 */
function beginDoorPick(plan, unit, board, handlers) {
  if (pickRefused(plan, unit)) return true;
  if (handlers.suspend && handlers.suspend(plan.tokenUuid) !== true) return false;
  const objects = board.units.filter(entry => entry.actorType === 'Object');
  advanceInteractionPick(PICK_EVENTS.OPEN_DOORS, {
    pick: Object.freeze({
      sourceTokenUuid: unit.tokenUuid,
      doorTokenUuids: doorsOnPickRing(unit.cells, objects,
        door => projectDoorVisibilityByUuid(unit.tokenUuid, door.tokenUuid)).map(door => door.tokenUuid),
      handlers, suspended: Boolean(handlers.suspend)
    })
  });
  drawPickGrid(board, unit, INTERACTION_GRID_COLORS.door);
  playUiSound(SOUND_IDS.UI_SELECT);
  return true;
}

/**
 * Take a token click for the interaction pick. The Token#_onClickLeft wrapper in foundry/patches/token-drag.mjs
 * asks this before attack targeting. While a pick is drawn, or its click is still being answered, the click is
 * consumed, so it can't also select the clicked unit.
 */
export function onTokenClickInteraction(token) {
  const drawn = activePick();
  if (!drawn) return pickOwnsCanvas();
  const tokenUuid = String(token.document.uuid ?? '');
  if (pickStateName() === PICK_STATES.UNITS) return clickUnitPick(drawn, tokenUuid);
  if (!drawn.doorTokenUuids.includes(tokenUuid)) {
    playUiSound(SOUND_IDS.UI_ERROR);
    return true;
  }
  closePick({ restore: false });
  void whilePickSettles(() =>
    attemptLock(drawn.sourceTokenUuid, tokenUuid, { ...drawn.handlers, held: drawn.suspended === true }));
  return true;
}

/** Keep the pick state in SETTLING while the window or attempt its click opened is still running. */
async function whilePickSettles(work) {
  advanceInteractionPick(PICK_EVENTS.SETTLE_START);
  try { return await work(); }
  finally { advanceInteractionPick(PICK_EVENTS.SETTLE_END); }
}

/** A click on an unmarked unit plays the error cue and leaves the pick open, as the other targeting grids do. */
function clickUnitPick(pick, tokenUuid) {
  if (!pick.tokenUuids.includes(tokenUuid)) {
    playUiSound(SOUND_IDS.UI_ERROR);
    return true;
  }
  closePick({ restore: false });
  void whilePickSettles(() => openTradeFor(pick.sourceTokenUuid, tokenUuid, pick.mode, {
    resume: pick.handlers.resume,
    suspend: pick.handlers.suspend,
    release: pick.handlers.release,
    held: pick.suspended === true,
    reopen: () => reopenUnitPick(pick)
  }));
  return true;
}

/** Whether this client is mid-interaction: a pick is drawn or answering its click, or any interaction window is up. */
export function isTradeInteractionActive() {
  return interactionHoldsBoard();
}

/** Whether a door or unit pick owns the canvas: drawn and awaiting its click, or still answering the click it took. */
export function isInteractionPickActive() {
  return pickOwnsCanvas();
}

/**
 * Redraw an open pick when tokens on its Scene move (the overlay refresh in init/hooks.mjs). The candidates are
 * worked out again too, so a unit that moved away can't still be clicked.
 */
export function refreshInteractionOverlays({ sceneUuid }, valid) {
  const pick = activePick();
  if (!pick) return false;
  const scene = resolveSync(pick.sourceTokenUuid, 'Token')?.parent;
  if (scene?.uuid !== sceneUuid || !valid()) return false;
  const board = projectTargetingBoard(scene);
  const unit = board?.units.find(entry => entry.tokenUuid === pick.sourceTokenUuid);
  if (!unit) return false;
  if (pickStateName() === PICK_STATES.UNITS) {
    const candidates = board.units.filter(entry => entry.tokenUuid !== unit.tokenUuid && entry.hidden !== true
      && pickAdmits(pick.mode, unit, entry, pick.related) && cellsAdjacent(unit.cells, entry.cells));
    advanceInteractionPick(PICK_EVENTS.REFRESH, {
      pick: Object.freeze({ ...pick, tokenUuids: candidates.map(entry => entry.tokenUuid) })
    });
    drawPickGrid(board, unit, pickColor(pick.mode));
  } else {
    const objects = board.units.filter(entry => entry.actorType === 'Object');
    advanceInteractionPick(PICK_EVENTS.REFRESH, {
      pick: Object.freeze({ ...pick, doorTokenUuids: doorsOnPickRing(unit.cells, objects,
        door => projectDoorVisibilityByUuid(unit.tokenUuid, door.tokenUuid)).map(door => door.tokenUuid) })
    });
    drawPickGrid(board, unit, INTERACTION_GRID_COLORS.door);
  }
  return true;
}

/** Take the pick down: an abandoned one hands the movement plan back, a handoff to a window leaves it held. */
function closePick({ restore = true } = {}) {
  const abandoned = activePick();
  if (!abandoned) return false;
  advanceInteractionPick(PICK_EVENTS.CLOSE);
  clearAttackTargetingGrid();
  markTargetedTokens([]);
  if (!restore) return true;
  playUiSound(SOUND_IDS.UI_UNSELECT);
  void clearPickActivation();
  if (abandoned.suspended === true) void abandoned.handlers.resume?.(abandoned.sourceTokenUuid);
  return true;
}

/** Back out of an open pick for the Cancel key (keybindings.mjs). Returns whether there was one. */
export function cancelInteraction() {
  return closePick();
}

/* -------------------------------------------- */
/*  Lock attempt                                */
/* -------------------------------------------- */

/**
 * Offer a carried key or Locktouch, then send the lock command for the host to check. In an encounter, the host
 * ends the unit's turn on any attempt it accepts. In free exploration a pick costs Energy, and a unit that can't pick
 * for a downtime reason is told which. The held plan is handed back when the attempt ends, including
 * after a cancel or a refusal. An opened chest goes on to its loot window instead. While exploring, any other
 * accepted attempt closes the plan where the unit stands through `release`.
 */
async function attemptLock(sourceTokenUuid, lockTokenUuid, handlers = {}) {
  const { resume = null, release = null, held = false } = handlers;
  const handBack = async () => { if (held && typeof resume === 'function') await resume(sourceTokenUuid); };
  let handedOff = false;
  try {
    const { objects } = game.emblemRpg.api;
    const facts = await objects.inspectLock({ sourceTokenUuid, lockTokenUuid });
    if (!facts) {
      return false;
    }
    if (!facts.locked) {
      playUiSound(SOUND_IDS.UI_UNSELECT);
      return true;
    }
    const method = facts.canUseKey ? LOCK_METHODS.KEY : facts.canPick ? LOCK_METHODS.LOCKTOUCH : null;
    if (!method) {
      if (facts.pickBlocked) {
        notifications.show(NOTIFICATION_IDS.OBJECT_LOCKPICK_BLOCKED,
          { actorName: facts.actorName, blocked: facts.pickBlocked });
      } else {
        notify('warn', `${facts.lockName} is locked.`);
      }
      playUiSound(SOUND_IDS.UI_ERROR);
      return true;
    }
    const confirmed = await openLockPreview({ ...facts, method });
    if (!confirmed) {
      return true;
    }
    const result = await objects.openLock({ sourceTokenUuid, lockTokenUuid, method });
    if (result?.ok !== true) {
      notifications.showResult(result);
      return true;
    }
    if (result.data?.objectType === 'Chest') {
      if (result.data.opened === true) {
        await openTradeFor(sourceTokenUuid, lockTokenUuid, TRADE_MODES.LOOT, { resume });
        handedOff = true;
      }
      return true;
    }
    if (facts.exploring === true && typeof release === 'function') await release(sourceTokenUuid);
    return true;
  } finally { if (!handedOff) await handBack(); }
}

/** Report the pause refusal before opening interact, trade or theft targeting. */
function refuseWhileTablePaused() {
  notifications.show(NOTIFICATION_IDS.COMMAND_TABLE_PAUSED);
  playUiSound(SOUND_IDS.UI_ERROR);
  return true;
}

function notify(level, message) {
  notifyFoundry(import.meta.url, level, message);
}

/* -------------------------------------------- */
/*  Unit inspection                             */
/* -------------------------------------------- */
const REPOSITION_SETTLE_MS = 10;

/* -------------------------------------------- */
/*  Canvas lifecycle                            */
/* -------------------------------------------- */
/**
 * Install the window and document listeners that end inspection when the browser won't report the tooltip key's
 * release (the window losing focus) or when Escape is pressed. Any mouse press hides the tooltip. init/hooks.mjs
 * calls this once, during setup.
 */
export function initializeInspectionControls() {
  const browserWindow = globalThis.window;
  const browserDocument = globalThis.document;
  if (typeof browserWindow?.addEventListener !== 'function') return;
  browserWindow.addEventListener('blur', () => dismissInspection());
  browserDocument?.addEventListener?.('mousedown', () => hideTokenTooltip());
  browserDocument?.addEventListener?.('keydown', event => {
    if (event?.code === 'Escape') dismissInspection();
  });
}

/** Drop the hovered Token and its tooltip before the Canvas is replaced. */
export function onCanvasTearDownInspection() {
  advanceInspection(INSPECT_EVENTS.UNHOVER);
  hideTokenTooltip();
}

/** Forget the hovered Token once its canvas object is destroyed, which never reports a hover-out. */
export function onDestroyTokenInspection(token) {
  if (inspectedToken() !== token) return;
  advanceInspection(INSPECT_EVENTS.UNHOVER);
  hideTokenTooltip();
}

/* -------------------------------------------- */
/*  Hovered Token                               */
/* -------------------------------------------- */
/** The Token currently under the pointer, which every hover-driven gesture reads. */
export function hoveredCanvasToken() {
  return inspectedToken();
}

/** Track the hovered Token and follow it with the tooltip while the modifier is held. */
export function onHoverTokenInspection(token, hovered) {
  if (hovered && token.actor) {
    const same = inspectedToken()?.id === token.id;
    advanceInspection(same ? INSPECT_EVENTS.REHOVER : INSPECT_EVENTS.HOVER, { token });
    if (inspectStateName() !== INSPECT_STATES.IDLE) refreshTooltip();
    return;
  }
  if (hovered || inspectedToken()?.id === token.id) {
    advanceInspection(INSPECT_EVENTS.UNHOVER);
    hideTokenTooltip();
  }
}

/** Follow a described Token that has moved, once its own transform has caught up. */
export function onUpdateTokenInspection(tokenDocument) {
  if (!isTokenTooltipVisible() || inspectedToken()?.id !== tokenDocument.id) return;
  setTimeout(() => {
    const token = inspectedToken();
    if (isTokenTooltipVisible() && token) positionTokenTooltip(tokenAnchor(token));
  }, REPOSITION_SETTLE_MS);
}

/** Drop a tooltip placed in screen space once the map it describes has moved under it. */
export function onCanvasPanInspection() {
  if (isTokenTooltipVisible()) hideTokenTooltip();
}

/* -------------------------------------------- */
/*  Inspection modifier                         */
/* -------------------------------------------- */
/**
 * Hold or release the inspection modifier, which shows the hovered Token's tooltip.
 * @param {boolean} held Whether the modifier is now down.
 * @returns {boolean} False, so the press reaches the other actions bound to the same key.
 */
export function setInspectModifierHeld(held) {
  advanceInspection(held === true ? INSPECT_EVENTS.HOLD : INSPECT_EVENTS.RELEASE);
  if (held === true) refreshTooltip();
  else hideTokenTooltip();
  return false;
}

/**
 * Describe the hovered unit as wielding its next attack, so a reader can weigh what it could switch to.
 * @returns {boolean} True when a preview moved, which keeps the press off the bindings sharing this key.
 */
export function advanceInspectedAttackPreview() {
  const token = inspectedToken();
  if (inspectStateName() === INSPECT_STATES.IDLE || !isTokenTooltipVisible() || !token?.actor) return false;
  const base = projectInspectedUnit(token, referenceToken());
  const attacks = base?.kind === INSPECTION_KINDS.UNIT ? base.attacks ?? [] : [];
  if (attacks.length < 2) return false;
  const held = attacks.findIndex(attack => attack.wielded);
  const next = ((inspectedAttackIndex() ?? held) + 1) % attacks.length;
  if (next === held) advanceInspection(INSPECT_EVENTS.PREVIEW_CLEARED);
  else advanceInspection(INSPECT_EVENTS.PREVIEW_ATTACK, { attackIndex: next });
  refreshTooltip();
  return true;
}

/* -------------------------------------------- */
/*  Tooltip presentation                        */
/* -------------------------------------------- */
function refreshTooltip() {
  const token = inspectedToken();
  if (!token?.actor) {
    hideTokenTooltip();
    return;
  }
  const inspection = projectInspectedUnit(token, referenceToken(), inspectedAttackIndex());
  if (!inspection) {
    hideTokenTooltip();
    return;
  }
  const scale = readSetting(TOKEN_TOOLTIP_SCALE_SETTING, TOKEN_TOOLTIP_DEFAULT_SCALE);
  showTokenTooltip(inspection, tokenAnchor(token), scale);
}

function referenceToken() {
  return globalThis.canvas?.tokens?.controlled?.[0] ?? null;
}

function dismissInspection() {
  advanceInspection(INSPECT_EVENTS.RELEASE);
  hideTokenTooltip();
}

function tokenAnchor(token) {
  const transform = token.worldTransform;
  if (!transform) return null;
  const scale = globalThis.canvas?.stage?.scale?.x || 1;
  return { left: transform.tx, top: transform.ty, width: (token.bounds?.width ?? 0) * scale };
}
