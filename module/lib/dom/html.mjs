/** @layer lib/dom */

/* -------------------------------------------- */
/*  HTML helpers                                */
/* -------------------------------------------- */
/** Escape `& < > " '` so a value is safe as HTML text or inside a quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}


/**
 * Build the `<option>` markup of one select.
 * @param {Iterable} entries    `{value, label}` pairs, or plain values that label themselves.
 * @param {*} [selected]        The value that carries the `selected` attribute.
 * @returns {string}
 */
export function optionMarkup(entries, selected = '') {
  let markup = '';
  for (const entry of entries) {
    const value = entry?.value ?? entry;
    const label = entry?.label ?? entry;
    const chosen = String(value) === String(selected ?? '') ? ' selected' : '';
    markup += `<option value="${escapeHtml(value)}"${chosen}>${escapeHtml(label)}</option>`;
  }
  return markup;
}

/** The value as a string, with its first character upper-cased. */
export function capitalize(value) {
  return String(value ?? '').replace(/^./, first => first.toUpperCase());
}

/**
 * The portrait zoom reported for a legacy avatar: the image is drawn as Foundry draws it, with no zoom and no pixel
 * sampling. characterAvatarScale in game/character/rules.mjs reports it, and avatarScaleStyle draws it.
 */
export const LEGACY_AVATAR_SCALE = 0;

/**
 * The inline style of a legacy avatar: no zoom, no crop, and the browser's smooth sampling. The `!important` beats
 * the stylesheet rules that draw the system's pixel-art portraits unsmoothed.
 */
export const LEGACY_AVATAR_STYLE = 'transform: none; clip-path: none; image-rendering: auto !important;';

/**
 * Portrait zoom for a chat or overlay avatar, cropping the overflow the scale creates. A legacy avatar, reported as
 * LEGACY_AVATAR_SCALE, gets LEGACY_AVATAR_STYLE instead.
 */
export function avatarScaleStyle(rawScale) {
  if (rawScale === LEGACY_AVATAR_SCALE) return LEGACY_AVATAR_STYLE;
  const scale = Math.max(0.5, Math.min(3, Number(rawScale) || 1.25));
  const inset = Math.max(0, ((scale - 1) / scale) * 50);
  return `transform: scale(${scale}); transform-origin: center center; clip-path: inset(${inset.toFixed(3)}%);`;
}

/* -------------------------------------------- */
/*  HTML sanitizing                             */
/* -------------------------------------------- */
/** Elements authored rich text keeps. Any other element loses its tags but keeps its text. */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'div', 'dl', 'dt', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's',
  'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
]);

/** Elements dropped together with everything inside them. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'svg', 'math', 'link', 'meta', 'base', 'title', 'head', 'form', 'input', 'button', 'select', 'textarea'
]);

/** Attributes any kept element may carry. `style` is kept as written, unfiltered. */
const GLOBAL_ATTRIBUTES = new Set(['class', 'style', 'title']);

/** Attributes kept only on their own element. */
const ELEMENT_ATTRIBUTES = Object.freeze({
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  ol: new Set(['start', 'type', 'reversed']),
  li: new Set(['value'])
});

/**
 * The schemes each URL attribute accepts. A value is read with the browser's own URL parser, so a scheme hidden
 * behind entities, tabs or control characters is seen the way a click would see it. A relative path resolves
 * against the placeholder base and reads as https.
 */
const URL_SCHEMES = Object.freeze({
  href: new Set(['http:', 'https:', 'mailto:']),
  src: new Set(['http:', 'https:', 'data:'])
});
const URL_BASE = 'https://sanitize.invalid/';

/** Whether a URL attribute's value resolves to a scheme it accepts. */
function allowedUrl(name, value) {
  const schemes = URL_SCHEMES[name];
  if (!schemes) return true;
  const url = URL.parse(value, URL_BASE);
  return url !== null && schemes.has(url.protocol);
}

/** Rebuild one parsed node from the allowlists, into a fragment of the output document. */
function cleanNode(node, output) {
  if (node.nodeType === Node.TEXT_NODE) return output.createTextNode(node.data);
  const fragment = output.createDocumentFragment();
  if (node.nodeType !== Node.ELEMENT_NODE) return fragment;
  const tag = node.localName;
  if (DROPPED_TAGS.has(tag) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return fragment;
  if (!ALLOWED_TAGS.has(tag)) {
    for (const child of node.childNodes) fragment.appendChild(cleanNode(child, output));
    return fragment;
  }
  const element = output.createElement(tag);
  for (const { name, value } of node.attributes) {
    if (!GLOBAL_ATTRIBUTES.has(name) && !ELEMENT_ATTRIBUTES[tag]?.has(name)) continue;
    if (!allowedUrl(name, value)) continue;
    element.setAttribute(name, value);
  }
  for (const child of node.childNodes) element.appendChild(cleanNode(child, output));
  return element;
}

/**
 * Rebuild authored rich text from an allowlist of elements, attributes and URL schemes. Nothing is copied that
 * isn't listed, so event handlers, script URLs, SVG and form controls never reach the page.
 */
export function sanitizeHtml(value) {
  const markup = String(value ?? '');
  if (!markup) return '';
  try {
    const source = new DOMParser().parseFromString(markup, 'text/html');
    const output = document.implementation.createHTMLDocument('');
    for (const child of source.body.childNodes) output.body.appendChild(cleanNode(child, output));
    return output.body.innerHTML;
  } catch {
    return escapeHtml(markup);
  }
}
