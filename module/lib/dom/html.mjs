/** @layer lib/dom */

/* -------------------------------------------- */
/*  Authored HTML                               */
/* -------------------------------------------- */
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

export function capitalize(value) {
  return String(value ?? '').replace(/^./, first => first.toUpperCase());
}

/** Portrait zoom for a chat or overlay avatar, cropping the overflow the scale creates. */
export function avatarScaleStyle(rawScale) {
  const scale = Math.max(0.5, Math.min(3, Number(rawScale) || 1.25));
  const inset = Math.max(0, ((scale - 1) / scale) * 50);
  return `transform: scale(${scale}); transform-origin: center center; clip-path: inset(${inset.toFixed(3)}%);`;
}

/* -------------------------------------------- */
/*  HTML sanitizing                             */
/* -------------------------------------------- */
/** Strip executable elements, event handlers, and script URL schemes from authored rich text. */
export function sanitizeHtml(value) {
  const markup = String(value ?? '');
  if (!markup) return '';
  try {
    const document = new DOMParser().parseFromString(markup, 'text/html');
    document.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form').forEach(element => element.remove());
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on')) element.removeAttribute(attribute.name);
        else if (/^(?:src|href|xlink:href|action|formaction)$/.test(name)
          && /^\s*(?:javascript|vbscript):/i.test(attribute.value)) element.removeAttribute(attribute.name);
      }
    }
    return document.body.innerHTML;
  } catch {
    return escapeHtml(markup);
  }
}
