/** @layer foundry/patches */
import { installWrapperGroup } from '../../external/host.mjs';

/* -------------------------------------------- */
/*  Clearance vocabulary                        */
/* -------------------------------------------- */
const NOTIFICATION_GATE_GROUP = 'chat-notification-gate';

/** Clear space demanded between the hotbar HUD's right edge and the floating messenger. */
const CLEARANCE_GAP = 16;

/** The sidebar animates its margin for 250 ms, so measure once that has settled, with slack. */
const SIDEBAR_SETTLE_MS = 350;

let settleTimer = null;

/* -------------------------------------------- */
/*  Installation                                */
/* -------------------------------------------- */
/**
 * Keep Foundry's floating chat notifications off the BG3 hotbar HUD.
 *
 * Core shows `#chat-notifications` over the canvas whenever the Chat tab is not the visible sidebar tab and the
 * viewport clears its own width test (`ChatLog#_shouldShowNotifications`). Core compensates by sliding its
 * `#hotbar` left, which this system never receives because the BG3 HUD replaces the macro bar. This wrapper adds
 * one condition: while the sidebar is expanded, the messenger appears only when the HUD actually leaves room for
 * it. Refusing it makes Core re-parent the chat input into the sidebar's own `.chat-form`, so the Chat tab stays
 * the way to read and type.
 */
export function installChatNotificationGate() {
  installWrapperGroup({
    id: NOTIFICATION_GATE_GROUP,
    required: false,
    wrappers: [
      {
        target: 'foundry.applications.sidebar.tabs.ChatLog.prototype._shouldShowNotifications',
        fn: gateOnHudClearance,
        type: 'MIXED'
      }
    ]
  });
}

/**
 * Re-measure once the sidebar has finished animating.
 *
 * `Sidebar#toggleExpanded` calls `ui.chat._toggleNotifications()` before raising `collapseSidebar`, so the
 * measurement Core takes lands mid-transition and reads the outgoing geometry. Settle, ask Core again, and
 * re-toggle only when the answer disagrees with what is on screen.
 */
export function onCollapseSidebarNotifications() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const chat = globalThis.ui?.chat;
    const log = messengerElement()?.querySelector('.chat-log');
    if (!log || typeof chat?._shouldShowNotifications !== 'function') return;
    if (chat._shouldShowNotifications() === !log.hidden) return;
    chat._toggleNotifications();
  }, SIDEBAR_SETTLE_MS);
}

/* -------------------------------------------- */
/*  Clearance measurement                       */
/* -------------------------------------------- */
/** Withhold the messenger from an expanded sidebar unless the HUD leaves room for it beside the hotbar. */
function gateOnHudClearance(wrapped, ...args) {
  if (wrapped(...args) === false) return false;
  if (globalThis.ui?.sidebar?.expanded !== true) return true;
  return hudClearsMessenger();
}

/**
 * Whether the messenger can sit beside the HUD rather than on top of it. An absent HUD, an absent messenger and an
 * unmeasurable one all leave Core's own answer standing.
 */
function hudClearsMessenger() {
  const pane = messengerElement()?.getBoundingClientRect();
  if (!pane?.width) return true;
  const edge = hudRightEdge();
  return edge === null || edge + CLEARANCE_GAP <= pane.left;
}

/**
 * The right edge of everything the BG3 HUD is displaying, or null when it is displaying nothing.
 *
 * `#bg3-hotbar-container` spans the whole viewport and centres its three regions inside itself, so its own
 * rectangle says nothing about how far the HUD reaches. Only the region children carry the visible extent, and the
 * widest is the action-button rail in `.bg3-hud-region-right` when a unit HUD is up. A Player with nothing
 * selected, and a HUD switched off from the scene controls, leave those children unlaid out, which is how this
 * reports that no HUD is on screen.
 */
function hudRightEdge() {
  const root = globalThis.ui?.BG3HUD_APP?.element;
  if (!root?.isConnected) return null;
  let edge = null;
  for (const part of root.querySelectorAll('#bg3-hotbar-container .bg3-hud-region > *')) {
    const rect = part.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    edge = edge === null ? rect.right : Math.max(edge, rect.right);
  }
  return edge;
}

function messengerElement() {
  return globalThis.document?.getElementById('chat-notifications') ?? null;
}
