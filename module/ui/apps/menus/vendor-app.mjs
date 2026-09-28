/** @layer ui/apps/menus */
import { VENDOR_CHECKOUT_MODES } from '../../../contracts/domains/economy.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { MAX_VENDOR_QUANTITY, clampDisposition } from '../../../game/economy/vendor.mjs';
import { playMenuSound, playUiSound } from '../../../presentation/audio/service.mjs';
import { SOUND_IDS } from '../../../presentation/audio/sound-database.mjs';
import { captureForDialog } from '../../dialogs.mjs';
import { SHEET_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';
import { buildContainerCategories } from '../sheets/containers.mjs';
import { openHagglePreview } from './previews.mjs';
import { openRowItemSheet } from './trade-app.mjs';

const TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/vendor-shop.hbs`;
const SORT_FIELDS = Object.freeze(['az', 'cost', 'type']);
const SORT_LABELS = Object.freeze({ az: 'A-Z', cost: 'Cost', type: 'Type' });
const SHOP_HEIGHT = 606;
const CART_FOOTER_HEIGHT = 56;

/** Each buyer's remembered shop: the mode it was left in, where it was selling from, and the basket. */
const VENDOR_SHOP_STATE = new Map();

/* -------------------------------------------- */
/*  Vendor shop window                          */
/* -------------------------------------------- */

/**
 * Show a Vendor's shop with a basket remembered per buyer. openShopFor (ui/controls/interaction.mjs) opens it with
 * the api.economy.inspectShop view. Checkout sends the basket as one api.economy.vendorCheckout command, which the
 * host settles before posting the receipt. In free exploration the footer also offers Haggle (see haggle below). The
 * window stays open until the player closes it.
 * @param {object} view The economy query's shop view.
 * @param {{refresh?: Function}} [handlers] Re-reads the view, so the shop shows current stock, gold and prices after
 *   a checkout or a haggle.
 * @returns {Promise<boolean>} Whether anything was traded or haggled.
 */
export async function openVendorShop(view, { refresh = null } = {}) {
  if (globalThis.document?.querySelector?.('.window-vendor-shop')) return false;
  const state = restoreShopState(view);
  const content = await render(view, state);
  await globalThis.foundry.applications.api.DialogV2.wait({
    window: { title: `Shop: ${view.vendor.name}`, resizable: false },
    classes: [SYSTEM_ID, 'window-trade-menu', 'window-vendor-shop'],
    position: { width: 760, height: 560 },
    content,
    buttons: [{ action: 'close', label: 'Close', callback: () => {} }],
    render: (_event, dialog) => {
      const root = dialog.element;
      root.classList.add('trade-menu-dialog');
      captureForDialog(dialog, {
        root, mode: 'shaped', confirmAction: null, outsideClickCancels: false, openSound: SOUND_IDS.UI_SELECT_ALT
      });
      pinShopHeight(dialog, root);
      void mount({ dialog, view, state, refresh, root: null });
    }
  });
  return state.traded;
}

async function render(view, state) {
  const context = prepareShopView(view, state);
  state.lines = new Map(context.categoryList[0].items.map(row => [row.id, row]));
  return globalThis.foundry.applications.handlebars.renderTemplate(TEMPLATE, context);
}

/** Fix shop body height and offset the dialog by its basket footer height. */
function pinShopHeight(dialog, app) {
  const pin = () => {
    app.style.setProperty('height', `${SHOP_HEIGHT}px`, 'important');
    app.style.setProperty('max-height', `${SHOP_HEIGHT}px`, 'important');
  };
  pin();
  globalThis.requestAnimationFrame?.(() => {
    if (!dialog.element) return;
    const top = app.getBoundingClientRect().top;
    dialog.setPosition({ top: Math.max(0, Math.round(top - CART_FOOTER_HEIGHT)) });
    pin();
  });
}

/* -------------------------------------------- */
/*  Shop state                                  */
/* -------------------------------------------- */

/** Start from the basket this buyer left behind, if any. pruneCart trims it to the listing once the body mounts. */
function restoreShopState(view) {
  const state = {
    mode: 'buy',
    activeTab: 'all',
    sortBy: 'az',
    sortDirection: 'asc',
    sendToConvoy: true,
    convoyUuid: view.convoys?.[0]?.uuid ?? '',
    sellSourceUuid: view.buyer.actorUuid,
    cart: new Map(),
    lines: new Map(),
    busy: false,
    haggling: false,
    traded: false
  };
  const saved = VENDOR_SHOP_STATE.get(view.buyer.actorUuid);
  if (saved) {
    state.mode = saved.mode === 'sell' ? 'sell' : 'buy';
    state.cart = new Map(saved.cart);
    if (state.mode === 'sell' && saved.sellSourceUuid) state.sellSourceUuid = saved.sellSourceUuid;
  }
  settleSellSource(view, state);
  return state;
}

function persistShopState(view, state) {
  VENDOR_SHOP_STATE.set(view.buyer.actorUuid, {
    mode: state.mode, sellSourceUuid: state.sellSourceUuid, cart: [...state.cart]
  });
}

/** A remembered source the buyer can no longer sell through falls back to the buyer's own pockets. */
function settleSellSource(view, state) {
  const known = state.sellSourceUuid === view.buyer.actorUuid
    || (view.convoys ?? []).some(convoy => convoy.uuid === state.sellSourceUuid);
  if (!known) state.sellSourceUuid = view.buyer.actorUuid;
}

/* -------------------------------------------- */
/*  Shop view                                   */
/* -------------------------------------------- */

/** Map the shop projection and basket state into the vendor template. */
function prepareShopView(view, state) {
  const buying = state.mode === 'buy';
  const source = sellSource(view, state);
  const rows = sortRows((buying ? view.vendor.stock : source.goods).map(item => shopRow(item, buying)), state);
  const vendorSide = Object.freeze({ name: view.vendor.name, img: view.vendor.image });
  const buyerSide = Object.freeze({ name: view.buyer.name, img: view.buyer.image });
  const gold = availableGold(view, state);
  return Object.freeze({
    mode: state.mode,
    left: buying ? buyerSide : vendorSide,
    right: buying ? vendorSide : Object.freeze({ name: source.name, img: '' }),
    showSend: buying && (view.convoys?.length ?? 0) > 0,
    showSourceSelector: !buying,
    sourceOptions: sourceOptions(view, state),
    modeToggleLabel: buying ? 'Switch to Selling' : 'Switch to Buying',
    confirmLabel: buying ? 'Confirm Purchase' : 'Confirm Sale',
    cartTotalLabel: buying ? 'Total Cost' : 'Total Revenue',
    disposition: clampDisposition(view.disposition),
    dispositionColor: dispositionColor(view.disposition),
    haggle: haggleButton(view),
    leftGp: gold.total,
    leftGpBreakdown: gold.breakdown,
    sortByLabel: SORT_LABELS[state.sortBy],
    sortDirectionIcon: state.sortDirection === 'asc' ? 'fa-arrow-up-short-wide' : 'fa-arrow-down-wide-short',
    tooltips: shopTooltips(view, state),
    categoryList: buildContainerCategories(rows, state.activeTab, row => row, { sorted: false })
  });
}

/**
 * The Haggle button, offered only in free exploration. Its tooltip says why it is disabled: this party already
 * haggled here, the unit is outside the downtime roster, or it cannot spend its Downtime Action. updateFooter
 * decides whether it is enabled.
 */
function haggleButton(view) {
  const standing = view.haggle ?? {};
  const tooltip = standing.haggled === true
    ? getTooltip(SHEET_TOOLTIP_IDS.SHOP_HAGGLE_LOCKED)
    : standing.rostered === false
      ? getTooltip(SHEET_TOOLTIP_IDS.SHOP_HAGGLE_OUTSIDE_ROSTER)
      : String(standing.blocked ?? '');
  return Object.freeze({ offered: standing.offered === true, tooltip });
}

/** What the left panel can spend: the vendor's coin when selling, else the purse plus the chosen Convoy's gold. */
function availableGold(view, state) {
  if (state.mode === 'sell') return { total: Number(view.vendor.gp) || 0, breakdown: '' };
  const convoy = destinationConvoy(view, state);
  const purse = Number(view.buyer.purseGp) || 0;
  const pooled = convoy ? Number(convoy.gp) || 0 : 0;
  return { total: purse + pooled, breakdown: convoy ? `${purse} + ${pooled}` : '' };
}

/** The basket's worth at the quoted unit prices. */
function cartTotal(state) {
  let total = 0;
  for (const [itemId, quantity] of state.cart) total += (state.lines.get(itemId)?.price ?? 0) * quantity;
  return total;
}

/** Fixed shop tooltips. The disposition tooltip names the party's haggle when it moved the disposition. */
function shopTooltips(view, state) {
  const haggleBonus = Number(view.haggleBonus) || 0;
  return Object.freeze({
    preview: getTooltip(SHEET_TOOLTIP_IDS.SHOP_PREVIEW),
    addOne: getTooltip(SHEET_TOOLTIP_IDS.SHOP_ADD_ONE),
    removeOne: getTooltip(SHEET_TOOLTIP_IDS.SHOP_REMOVE_ONE),
    disposition: haggleBonus === 0
      ? getTooltip(SHEET_TOOLTIP_IDS.SHOP_DISPOSITION)
      : getTooltip(SHEET_TOOLTIP_IDS.SHOP_DISPOSITION_HAGGLED, { bonus: haggleBonus }),
    sortField: getTooltip(SHEET_TOOLTIP_IDS.SHOP_SORT_FIELD),
    sortDirection: getTooltip(state.sortDirection === 'asc'
      ? SHEET_TOOLTIP_IDS.SHOP_SORT_ASCENDING : SHEET_TOOLTIP_IDS.SHOP_SORT_DESCENDING)
  });
}

/**
 * One listing row: a shelf entry priced for the buyer, or a possession priced for the vendor. A possession this
 * Vendor sold (`soldHere`) says so in its tooltip.
 */
function shopRow(item, buying) {
  const resource = item.type === 'Resource';
  const shelf = resource ? item.amount : (buying ? item.stock : 1);
  const stock = shelf === null || shelf === undefined ? null : Math.max(0, Math.floor(Number(shelf) || 0));
  const max = stock === null ? MAX_VENDOR_QUANTITY : stock;
  const accepted = buying || item.accepted !== false;
  return {
    id: item.id,
    name: item.name,
    img: item.image,
    type: item.type,
    subtype: item.itemType,
    system: { itemType: item.itemType, weapon: { req: item.weaponFamily } },
    price: Number(item.price) || 0,
    isResource: resource,
    max,
    outOfStock: buying && stock === 0,
    notAccepted: !accepted,
    subLabel: subLabel(item, buying, stock),
    addTooltip: getTooltip(accepted ? SHEET_TOOLTIP_IDS.SHOP_ADD_TO_CART
      : item.soldHere === true ? SHEET_TOOLTIP_IDS.SHOP_SOLD_HERE : SHEET_TOOLTIP_IDS.SHOP_UNACCEPTED),
    quantityTooltip: getTooltip(SHEET_TOOLTIP_IDS.SHOP_QUANTITY, { max })
  };
}

function subLabel(item, buying, stock) {
  if (buying) return `In Stock: ${stock === null ? 'Unlimited' : stock}`;
  if (item.type === 'Resource') return `×${stock ?? 0}`;
  if (item.usesType === 'limited' && Number(item.usesMax) > 0) {
    return `${Number(item.usesCurrent) || 0}/${Number(item.usesMax) || 0}`;
  }
  return '';
}

function sellSource(view, state) {
  const convoy = (view.convoys ?? []).find(entry => entry.uuid === state.sellSourceUuid) ?? null;
  return convoy ?? { uuid: view.buyer.actorUuid, name: view.buyer.name, goods: view.buyer.goods };
}

function destinationConvoy(view, state) {
  if (state.mode !== 'buy' || state.sendToConvoy !== true) return null;
  return (view.convoys ?? []).find(entry => entry.uuid === state.convoyUuid) ?? null;
}

function sourceOptions(view, state) {
  return [
    { uuid: view.buyer.actorUuid, name: view.buyer.name, selected: state.sellSourceUuid === view.buyer.actorUuid },
    ...(view.convoys ?? []).map(convoy => ({
      uuid: convoy.uuid, name: convoy.name, selected: state.sellSourceUuid === convoy.uuid
    }))
  ];
}

const COMPARATORS = Object.freeze({
  az: (left, right) => left.name.localeCompare(right.name),
  cost: (left, right) => (left.price - right.price) || left.name.localeCompare(right.name),
  type: (left, right) => String(left.type ?? '').localeCompare(String(right.type ?? ''))
    || String(left.subtype ?? '').localeCompare(String(right.subtype ?? ''))
    || left.name.localeCompare(right.name)
});

function sortRows(rows, state) {
  const sorted = [...rows].sort(COMPARATORS[state.sortBy] ?? COMPARATORS.az);
  return state.sortDirection === 'desc' ? sorted.reverse() : sorted;
}

/** Color the disposition display red below neutral, yellow at neutral and green above. */
function dispositionColor(disposition) {
  return `hsl(${60 + (clampDisposition(disposition) / 10) * 60}, 100%, 50%)`;
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */

async function mount(shop) {
  const root = shop.dialog.element?.querySelector('.vendor-shop-container');
  if (!root) return;
  shop.root = root;
  wireTabs(shop);
  wireSorting(shop);
  wireMode(shop);
  wireDestination(shop);
  wireRows(shop);
  wireCart(shop);
  pruneCart(shop);
  refreshGold(shop);
  updateFooter(shop);
}

/** Re-read the view and rebuild the shop body. The new body goes in before the old one goes, so nothing blanks. */
async function rerender(shop) {
  if (shop.refresh) {
    const fresh = await shop.refresh();
    if (fresh) shop.view = fresh;
  }
  settleSellSource(shop.view, shop.state);
  const holder = shop.dialog.element?.querySelector('.vendor-shop-container');
  if (!holder) return;
  holder.insertAdjacentHTML('afterend', await render(shop.view, shop.state));
  holder.remove();
  await mount(shop);
}

function wireTabs({ root, state }) {
  const tabs = [...root.querySelectorAll('.vendor-shop-tab')];
  const panes = [...root.querySelectorAll('.vendor-shop-tab-content')];
  for (const button of tabs) {
    button.addEventListener('click', event => {
      event.preventDefault();
      const tab = String(button.dataset.tab ?? 'all');
      state.activeTab = tab;
      for (const other of tabs) other.classList.toggle('active', other === button);
      for (const pane of panes) pane.classList.toggle('active', pane.dataset.tab === tab);
      playMenuSound(SOUND_IDS.UI_BLIP_1);
    });
  }
}

function wireSorting(shop) {
  const { root, state } = shop;
  root.querySelector('.vendor-shop-sort-by')?.addEventListener('click', event => {
    event.preventDefault();
    if (state.busy) return;
    state.sortBy = SORT_FIELDS[(SORT_FIELDS.indexOf(state.sortBy) + 1) % SORT_FIELDS.length];
    playMenuSound(SOUND_IDS.UI_BLIP_1);
    void rerender(shop);
  });
  root.querySelector('.vendor-shop-sort-dir')?.addEventListener('click', event => {
    event.preventDefault();
    if (state.busy) return;
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    playMenuSound(SOUND_IDS.UI_BLIP_1);
    void rerender(shop);
  });
}

/** Use the selected delivery Convoy as the initial source when switching to selling. */
function wireMode(shop) {
  const { root, state, view } = shop;
  root.querySelector('.vendor-shop-mode-toggle')?.addEventListener('click', () => {
    if (state.busy) return;
    if (state.mode === 'buy') {
      state.mode = 'sell';
      state.sellSourceUuid = state.sendToConvoy && state.convoyUuid ? state.convoyUuid : view.buyer.actorUuid;
    } else {
      state.mode = 'buy';
    }
    state.activeTab = 'all';
    state.cart.clear();
    playMenuSound(SOUND_IDS.UI_BLIP_1);
    void rerender(shop);
  });
}

function wireDestination(shop) {
  const { root, state } = shop;
  const send = root.querySelector('.vendor-shop-send-check');
  if (send) send.checked = state.sendToConvoy === true;
  send?.addEventListener('change', () => {
    state.sendToConvoy = send.checked === true;
    refreshGold(shop);
    updateFooter(shop);
    playMenuSound(SOUND_IDS.UI_BLIP_1);
  });
  root.querySelector('.vendor-shop-source-select')?.addEventListener('change', event => {
    state.sellSourceUuid = String(event.currentTarget.value ?? '');
    state.cart.clear();
    playMenuSound(SOUND_IDS.UI_BLIP_1);
    void rerender(shop);
  });
}

function wireRows(shop) {
  const { root, state, view } = shop;
  const stop = handler => event => {
    event.preventDefault();
    event.stopPropagation();
    handler();
  };
  for (const row of root.querySelectorAll('.vendor-shop-item')) {
    const itemId = String(row.dataset.itemId ?? '');
    row.addEventListener('click', event => {
      if (event.target?.closest?.('.vendor-shop-item-actions')) return;
      event.preventDefault();
      void openRowItemSheet(state.mode === 'buy' ? view.vendor.actorUuid : state.sellSourceUuid, itemId);
    });
    row.querySelector('.vendor-shop-add-btn')?.addEventListener('click', stop(() => addToCart(shop, itemId)));
    row.querySelector('.vendor-shop-qty-inc')?.addEventListener('click', stop(() => addToCart(shop, itemId)));
    row.querySelector('.vendor-shop-qty-dec')?.addEventListener('click', stop(() => removeFromCart(shop, itemId)));
    row.querySelector('.vendor-shop-qty-input')?.addEventListener('input', event => {
      typeQuantity(shop, itemId, event.currentTarget);
    });
  }
}

function wireCart(shop) {
  const { root, state } = shop;
  root.querySelector('.vendor-shop-clear-btn')?.addEventListener('click', () => {
    if (state.busy || !state.cart.size) return;
    state.cart.clear();
    playShopSound(SOUND_IDS.UI_UNSELECT);
    void rerender(shop);
  });
  root.querySelector('.vendor-shop-confirm-btn')?.addEventListener('click', event => {
    if (event.currentTarget.disabled || state.busy) return;
    void checkout(shop);
  });
  root.querySelector('.vendor-shop-haggle-btn')?.addEventListener('click', event => {
    if (event.currentTarget.disabled || state.busy) return;
    void haggle(shop);
  });
}

/* -------------------------------------------- */
/*  Basket                                      */
/* -------------------------------------------- */

/**
 * Add one of a line to the basket. Plays the error sound instead when the shelf is empty, the vendor won't take the
 * item, or the count is at its cap.
 */
function addToCart(shop, itemId) {
  const { state } = shop;
  const line = state.lines.get(itemId);
  if (state.busy || !line) return;
  const held = state.cart.get(itemId) ?? 0;
  if (line.outOfStock || line.notAccepted || (line.max > 0 && held >= line.max)) {
    playShopSound(SOUND_IDS.UI_ERROR);
    return;
  }
  state.cart.set(itemId, held + 1);
  syncLine(shop, itemId);
  updateFooter(shop);
  playMenuSound(SOUND_IDS.UI_BLIP_1);
}

function removeFromCart(shop, itemId) {
  const { state } = shop;
  if (state.busy) return;
  const held = state.cart.get(itemId) ?? 0;
  if (held <= 0) return;
  if (held === 1) state.cart.delete(itemId);
  else state.cart.set(itemId, held - 1);
  syncLine(shop, itemId);
  updateFooter(shop);
  playMenuSound(SOUND_IDS.UI_BLIP_1);
}

/** Set a Resource line's count from the typed value, up to what's there. A blank or zero removes the line. */
function typeQuantity(shop, itemId, input) {
  const { state } = shop;
  const line = state.lines.get(itemId);
  if (state.busy || !line || line.outOfStock || line.notAccepted) return;
  let value = Math.max(0, Math.floor(Number(input.value) || 0));
  if (line.max > 0 && value > line.max) {
    value = line.max;
    input.value = String(line.max);
  }
  if (value <= 0) state.cart.delete(itemId);
  else state.cart.set(itemId, value);
  syncLine(shop, itemId);
  updateFooter(shop);
}

/** Reflect one line's count on every row that shows it: the All tab and its own category. */
function syncLine({ root, state }, itemId) {
  const quantity = state.cart.get(itemId) ?? 0;
  for (const row of root.querySelectorAll(`.vendor-shop-item[data-item-id="${itemId}"]`)) {
    row.classList.toggle('in-cart', quantity > 0);
    const value = row.querySelector('.vendor-shop-qty-val');
    if (value) value.textContent = String(quantity);
    const input = row.querySelector('.vendor-shop-qty-input');
    if (input && globalThis.document?.activeElement !== input) input.value = quantity > 0 ? String(quantity) : '';
  }
}

/** Reconcile a remembered basket with the listing: gone lines are dropped, counts clamped, the rest reflected. */
function pruneCart(shop) {
  const { state } = shop;
  for (const [itemId, quantity] of [...state.cart]) {
    const line = state.lines.get(itemId);
    if (!line) {
      state.cart.delete(itemId);
      continue;
    }
    if (line.max > 0 && quantity > line.max) state.cart.set(itemId, line.max);
    syncLine(shop, itemId);
  }
}

function refreshGold({ root, state, view }) {
  const gold = availableGold(view, state);
  const value = root.querySelector('.vendor-shop-gp-value');
  const breakdown = root.querySelector('.vendor-shop-gp-breakdown');
  if (value) value.textContent = String(gold.total);
  if (breakdown) breakdown.textContent = gold.breakdown;
}

/**
 * The footer's total and buttons: a purchase over budget cannot be confirmed, a sale may (the vendor pays short).
 * Haggle is enabled only while the view says the unit may haggle and no command is running.
 */
function updateFooter(shop) {
  const { root, state, view } = shop;
  const empty = state.cart.size === 0;
  const total = cartTotal(state);
  const over = total > availableGold(view, state).total;
  const value = root.querySelector('.vendor-shop-cart-value');
  if (value) value.textContent = String(total);
  root.querySelector('.vendor-shop-cart-footer')?.classList.toggle('over-budget', over && !empty);
  const confirm = root.querySelector('.vendor-shop-confirm-btn');
  const clear = root.querySelector('.vendor-shop-clear-btn');
  const haggleControl = root.querySelector('.vendor-shop-haggle-btn');
  if (confirm) confirm.disabled = empty || (state.mode === 'buy' && over) || state.busy;
  if (clear) clear.disabled = empty || state.busy;
  if (haggleControl) haggleControl.disabled = view.haggle?.available !== true || state.busy;
  persistShopState(view, state);
}

/* -------------------------------------------- */
/*  Checkout                                    */
/* -------------------------------------------- */

/**
 * Send the basket as one api.economy.vendorCheckout command, which settles it line by line and posts the receipt to
 * chat. The basket is then cleared and the shop rebuilt, whatever the result.
 */
async function checkout(shop) {
  const { state, view } = shop;
  const lines = [...state.cart].filter(([, quantity]) => quantity > 0)
    .map(([itemId, quantity]) => ({ itemId, quantity }));
  if (!lines.length) return;
  const selling = state.mode === 'sell';
  if (selling && !await confirmShortSale(view, cartTotal(state))) return;
  state.busy = true;
  updateFooter(shop);
  let result = null;
  try {
    result = await game.emblemRpg.api.economy.vendorCheckout(checkoutIntent(view, state, lines));
  } finally {
    state.busy = false;
  }
  if (result?.ok === true) {
    state.traded = true;
    playShopSound(SOUND_IDS.UI_PURCHASE);
  }
  state.cart.clear();
  await rerender(shop);
}

/** Confirm a short sale before checkout when the vendor cannot pay the quoted total. */
async function confirmShortSale(view, total) {
  const gold = Number(view.vendor.gp) || 0;
  if (total <= gold) return true;
  const escape = foundry.utils.escapeHTML;
  const confirmed = await globalThis.foundry.applications.api.DialogV2.confirm({
    window: { title: 'Confirm Sale', icon: 'fas fa-hand-holding-dollar' },
    modal: true,
    content: `<p><strong>${escape(view.vendor.name)}</strong> only has <strong>${gold} GP</strong>, but this sale is `
      + `worth <strong>${total} GP</strong>.</p><p>Sell anyway? You will receive only the <strong>${gold} GP</strong> `
      + 'the vendor can pay, not the full value.</p>',
    yes: { label: 'Sell Anyway', default: true },
    no: { label: 'Cancel' }
  });
  return confirmed === true;
}

/** The whole basket as the checkout command reads it: the pair at the counter, the Convoy involved, the lines. */
function checkoutIntent(view, state, lines) {
  const selling = state.mode === 'sell';
  const holding = selling ? state.sellSourceUuid : destinationConvoy(view, state)?.uuid ?? '';
  return {
    mode: selling ? VENDOR_CHECKOUT_MODES.SELL : VENDOR_CHECKOUT_MODES.BUY,
    buyerActorUuid: view.buyer.actorUuid,
    buyerTokenUuid: view.buyer.tokenUuid,
    vendorUuid: view.vendor.actorUuid,
    vendorTokenUuid: view.vendor.tokenUuid,
    holdingUuid: holding === view.buyer.actorUuid ? '' : holding,
    lines
  };
}

function playShopSound(id) {
  playUiSound(id);
}

/* -------------------------------------------- */
/*  Haggle                                      */
/* -------------------------------------------- */

/**
 * Spend the unit's Downtime Action on a haggle with this Vendor. openHagglePreview (./previews.mjs) asks first, and
 * a cancel changes nothing. A confirm sends one api.economy.haggle command: the host rolls the unit's Trading check
 * and stores the disposition shift for the unit's party. The shop then re-reads its view, so the prices, the
 * disposition and the Haggle button show the new standing. The basket is kept.
 */
async function haggle(shop) {
  const { state } = shop;
  if (state.busy || state.haggling || shop.view.haggle?.available !== true) return;
  state.haggling = true;
  let confirmed = false;
  try {
    confirmed = await openHagglePreview({ vendorName: shop.view.vendor.name, vendorImage: shop.view.vendor.image });
  } finally {
    state.haggling = false;
  }
  if (!confirmed || state.busy) return;
  state.busy = true;
  updateFooter(shop);
  let result = null;
  try {
    result = await game.emblemRpg.api.economy.haggle(haggleIntent(shop.view));
  } finally {
    state.busy = false;
  }
  if (result?.ok === true) state.traded = true;
  await rerender(shop);
}

/** The pair at the counter, as api.economy.haggle reads it. */
function haggleIntent(view) {
  return {
    buyerActorUuid: view.buyer.actorUuid,
    buyerTokenUuid: view.buyer.tokenUuid,
    vendorUuid: view.vendor.actorUuid,
    vendorTokenUuid: view.vendor.tokenUuid
  };
}
