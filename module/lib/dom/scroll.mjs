/** @layer lib/dom */

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */
/**
 * Remember scroll positions and open `<details>` sections below an application root, so a re-render doesn't jump
 * to the top. `<details>` marked `data-managed-open` are left to the application. The ui-chrome patch
 * (foundry/patches/ui-chrome.mjs) calls this before an application re-renders.
 * @param {Element} root The application's root element.
 * @returns {Map<string, {top?: number, left?: number, open?: boolean}> | null}
 */
export function captureScrollPositions(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const saved = new Map();
  const scrollCounts = new Map();
  const detailCounts = new Map();
  for (const element of root.querySelectorAll('*')) {
    if (element.tagName === 'DETAILS') captureDisclosure(element, saved, detailCounts);
    if (!isScrollable(element)) continue;
    const key = ordinalKey(elementSignature(element), scrollCounts);
    if (element.scrollTop > 0 || element.scrollLeft > 0) {
      saved.set(key, { top: element.scrollTop, left: element.scrollLeft });
    }
  }
  return saved.size > 0 ? saved : null;
}

/**
 * Put the saved scroll positions and open sections back after a re-render. Elements are matched by tag, id,
 * classes, a few data attributes and their order among matching elements.
 * @param {Element} root The rerendered root element.
 * @param {Map<string, {top?: number, left?: number, open?: boolean}> | null} saved
 */
export function restoreScrollPositions(root, saved) {
  if (!root || typeof root.querySelectorAll !== 'function' || !saved?.size) return;
  const detailCounts = new Map();
  for (const element of root.querySelectorAll('details')) {
    const key = `details:${ordinalKey(elementSignature(element), detailCounts)}`;
    if (saved.get(key)?.open && element.dataset?.managedOpen === undefined) element.open = true;
  }
  const scrollCounts = new Map();
  for (const element of root.querySelectorAll('*')) {
    if (!isScrollable(element)) continue;
    const position = saved.get(ordinalKey(elementSignature(element), scrollCounts));
    if (!position) continue;
    if (position.top) element.scrollTop = position.top;
    if (position.left) element.scrollLeft = position.left;
  }
}

/* -------------------------------------------- */
/*  Element matching                            */
/* -------------------------------------------- */
function captureDisclosure(element, saved, counts) {
  const key = `details:${ordinalKey(elementSignature(element), counts)}`;
  if (element.open && element.dataset?.managedOpen === undefined) saved.set(key, { open: true });
}

function ordinalKey(signature, counts) {
  const ordinal = counts.get(signature) ?? 0;
  counts.set(signature, ordinal + 1);
  return `${signature}#${ordinal}`;
}

function elementSignature(element) {
  const classes = typeof element.className === 'string' ? element.className : '';
  const data = element.dataset ?? {};
  return [
    element.tagName,
    element.id ?? '',
    classes,
    data.scrollKey ?? '',
    data.tab ?? '',
    data.tabId ?? '',
    data.group ?? '',
    data.applicationPart ?? '',
    data.itemId ?? '',
    data.category ?? '',
    data.entryIndex ?? '',
    data.bundleId ?? '',
    data.promotionId ?? ''
  ].join('|');
}

function isScrollable(element) {
  return element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
}
