/** @layer lib/dom */
/*
 * Shared pickers for sheets and editors. wireSearchDropdown searches document names, and wireCatalogPicker picks from
 * a grouped vocabulary.
 */
import { escapeHtml } from './html.mjs';

/* -------------------------------------------- */
/*  Search ranking and presentation             */
/* -------------------------------------------- */

/** CSS class of the search dropdown. styles/emblem-rpg.css lays it out. */
const SEARCH_DROPDOWN_CLASS = 'emblem-search-dropdown';

/**
 * Rank matches: names that start with the term first, then alphabetical.
 * @param {object[]} matches      Candidates that contain the term.
 * @param {string} needle         The lowercase term.
 * @returns {object[]}
 */
function rankMatches(matches, needle) {
  return matches.sort((a, b) => {
    const ap = String(a.name ?? '').toLowerCase().startsWith(needle) ? 0 : 1;
    const bp = String(b.name ?? '').toLowerCase().startsWith(needle) ? 0 : 1;
    return ap - bp || String(a.name ?? '').localeCompare(String(b.name ?? ''));
  });
}

/**
 * The default row: an image, the name, and an optional tag.
 * @param {object} candidate      A candidate with name, img and optionally tag / source.
 * @returns {string}
 */
function defaultSearchRow(candidate) {
  const tag = candidate.tag
    ? `<span class="emblem-search-tag"${candidate.source ? ` data-tooltip="${escapeHtml(candidate.source)}"` : ''}>${escapeHtml(candidate.tag)}</span>`
    : '';
  return `
    <div class="emblem-search-result" data-key="${escapeHtml(candidate.key ?? candidate.uuid ?? candidate.id ?? '')}">
      ${candidate.img ? `<img src="${escapeHtml(candidate.img)}" class="emblem-search-img" />` : ''}
      <span class="emblem-search-name">${escapeHtml(candidate.name ?? '')}</span>
      ${tag}
    </div>`;
}

/**
 * Bind a document search picker to an input, for the character authoring sheet, the class sheet and the crafting
 * editor. Each candidate needs a name, and a key, uuid or id for its row. The list follows the input as the page
 * scrolls or resizes, and closes on Escape, an outside click or the input's removal.
 * @param {HTMLInputElement} input The search box.
 * @param {object} options
 * @param {object[]|function(string): (object[]|Promise<object[]>)} options.candidates What can be picked.
 * @param {function(object): (void|Promise<void>)} options.onPick Called with the chosen candidate.
 * @param {function(object): string} [options.render] Row markup. Defaults to `defaultSearchRow`.
 * @param {number} [options.limit=12] Most rows shown.
 * @param {boolean} [options.rankPrefix=true] Whether names starting with the term come first.
 * @param {string} [options.emptyText='No matches.'] Shown when nothing matches.
 * @param {boolean} [options.clearOnPick=true] Whether to empty the input after a pick.
 * @param {HTMLElement} [options.container] Clicks inside it don't close the list. Defaults to the input's parent.
 * @returns {{close: Function, destroy: Function, refresh: Function}}
 */
export function wireSearchDropdown(input, {
  candidates,
  onPick,
  render = defaultSearchRow,
  limit = 12,
  rankPrefix = true,
  emptyText = 'No matches.',
  clearOnPick = true,
  container = input.parentElement
} = {}) {
  const dropdown = document.createElement('div');
  dropdown.className = `emblem-rpg ${SEARCH_DROPDOWN_CLASS}`;
  document.body.appendChild(dropdown);

  let current = [];
  let seq = 0;

  const position = () => {
    if (!input.isConnected) { close(); return; }
    const r = input.getBoundingClientRect();
    dropdown.style.top = `${r.bottom}px`;
    dropdown.style.left = `${r.left}px`;
    dropdown.style.width = `${r.width}px`;
    dropdown.style.maxHeight = `${Math.min(240, Math.max(120, window.innerHeight - r.bottom - 12))}px`;
  };

  const open = () => {
    position();
    dropdown.classList.add('is-open');
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
  };

  function close() {
    dropdown.classList.remove('is-open');
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
  }

  const pick = async (candidate) => {
    close();
    if (clearOnPick) input.value = '';
    await onPick(candidate);
  };

  const refresh = async () => {
    const term = input.value.trim();
    if (!term) { close(); return; }
    const mine = ++seq;
    const pool = typeof candidates === 'function' ? await candidates(term) : candidates;
    if (mine !== seq || !input.isConnected) return;
    const needle = term.toLowerCase();
    let matches = (pool ?? []).filter(c => String(c.name ?? '').toLowerCase().includes(needle));
    if (rankPrefix) matches = rankMatches(matches, needle);
    current = matches.slice(0, limit);
    if (!current.length) {
      dropdown.innerHTML = `<div class="emblem-search-empty">${escapeHtml(emptyText)}</div>`;
    } else {
      dropdown.innerHTML = current.map(render).join('');
      dropdown.querySelectorAll('.emblem-search-result').forEach((el, i) => {
        el.addEventListener('click', () => pick(current[i]));
      });
    }
    open();
  };

  const onDocClick = (event) => {
    if (container?.contains(event.target) || dropdown.contains(event.target)) return;
    close();
  };

  input.addEventListener('input', refresh);
  input.addEventListener('focus', () => { if (input.value.trim()) refresh(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); input.blur(); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (dropdown.classList.contains('is-open') && current.length) pick(current[0]);
    }
  });
  document.addEventListener('click', onDocClick);

  const destroy = () => {
    close();
    document.removeEventListener('click', onDocClick);
    observer.disconnect();
    dropdown.remove();
  };

  const observer = new MutationObserver(() => {
    if (!input.isConnected) destroy();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return { close, destroy, refresh };
}

/* -------------------------------------------- */
/*  Catalog picking                             */
/* -------------------------------------------- */

/** CSS class of the catalog dropdown. styles/emblem-rpg.css lays it out. */
const CATALOG_PICKER_CLASS = 'emblem-catalog-picker';

/** One catalog row: the value that is written, and the label that explains it. `index` is its place in the matches. */
function catalogRow(entry, index) {
  return `
    <div class="emblem-catalog-row" data-index="${index}" data-value="${escapeHtml(entry.value)}">
      <span class="emblem-catalog-value">${escapeHtml(entry.value)}</span>
      <span class="emblem-catalog-label">${escapeHtml(entry.label ?? '')}</span>
    </div>`;
}

/**
 * Attach a vocabulary picker to the inputs matching `selector` inside an editor, for the condition and effect
 * editors. Events are delegated from `scopeEl`, so the binding survives rerenders. Focus opens the full vocabulary,
 * and typing filters it. The dropdown is mounted on the body so the editor can't clip it.
 * @param {HTMLElement} scopeEl The element holding the inputs.
 * @param {object} options
 * @param {string} options.selector Which inputs inside it open the catalog.
 * @param {object[]|function(): object[]} options.groups Sections, each `{ label, entries: [{ value, label }] }`.
 * @param {number} [options.rows=20] Rows shown before the list scrolls.
 * @param {string} [options.emptyText='No matching field.'] Shown when nothing matches.
 * @returns {{close: Function}}
 */
export function wireCatalogPicker(scopeEl, { selector, groups, rows = 20, emptyText = 'No matching field.' } = {}) {
  const catalog = () => (typeof groups === 'function' ? groups() : groups) ?? [];

  let dropdown = null;
  let input = null;
  let matches = [];
  let active = -1;
  let picking = false;

  const position = () => {
    if (!dropdown) return;
    if (!scopeEl.isConnected || !input.isConnected) { close(); return; }
    const anchor = input.getBoundingClientRect();
    const rowHeight = parseFloat(getComputedStyle(dropdown).getPropertyValue('--emblem-catalog-row-h')) || 20;
    const wanted = rows * rowHeight;
    const below = window.innerHeight - anchor.bottom - 8;
    const above = anchor.top - 8;
    const flip = below < Math.min(wanted, above);
    dropdown.style.left = `${anchor.left}px`;
    dropdown.style.width = `${anchor.width}px`;
    dropdown.style.maxHeight = `${Math.max(80, Math.min(wanted, flip ? above : below))}px`;
    dropdown.style.top = flip ? '' : `${anchor.bottom}px`;
    dropdown.style.bottom = flip ? `${window.innerHeight - anchor.top}px` : '';
  };

  const markActive = (scroll) => {
    dropdown.querySelectorAll('.emblem-catalog-row').forEach((row, index) => {
      row.classList.toggle('is-active', index === active);
      if (scroll && index === active) row.scrollIntoView({ block: 'nearest' });
    });
  };

  const paint = (showAll = false) => {
    const needle = input.value.trim().toLowerCase();
    const parts = [];
    matches = [];
    for (const group of catalog()) {
      const hits = (group.entries ?? []).filter(entry => showAll || !needle
        || entry.value.toLowerCase().includes(needle)
        || String(entry.label ?? '').toLowerCase().includes(needle));
      if (!hits.length) continue;
      parts.push(`<div class="emblem-catalog-group">${escapeHtml(group.label ?? '')}</div>`);
      for (const hit of hits) {
        parts.push(catalogRow(hit, matches.length));
        matches.push(hit);
      }
    }
    dropdown.innerHTML = parts.length
      ? parts.join('')
      : `<div class="emblem-catalog-empty">${escapeHtml(emptyText)}</div>`;
    active = matches.findIndex(entry => entry.value.toLowerCase() === needle);
    markActive(active >= 0);
  };

  const onOutside = (event) => {
    if (dropdown?.contains(event.target) || event.target === input) return;
    close();
  };

  function close() {
    if (!dropdown) return;
    dropdown.remove();
    dropdown = null;
    input = null;
    matches = [];
    active = -1;
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    document.removeEventListener('mousedown', onOutside, true);
  }

  const pick = (entry) => {
    const field = input;
    if (!entry || !field) return;
    close();
    picking = true;
    field.value = entry.value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    picking = false;
  };

  const open = (target) => {
    if (dropdown && input === target) { paint(true); position(); return; }
    close();
    input = target;
    dropdown = document.createElement('div');
    dropdown.className = `emblem-rpg ${CATALOG_PICKER_CLASS}`;
    dropdown.addEventListener('mousedown', (event) => {
      const row = event.target.closest('.emblem-catalog-row');
      if (!row && !event.target.closest('.emblem-catalog-group')) return;
      event.preventDefault();
      if (row) pick(matches[Number(row.dataset.index)]);
    });
    document.body.appendChild(dropdown);
    paint(true);
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('mousedown', onOutside, true);
  };

  scopeEl.addEventListener('focusin', (event) => {
    const target = event.target.closest?.(selector);
    if (target) open(target);
  });

  scopeEl.addEventListener('input', (event) => {
    if (picking) return;
    const target = event.target.closest?.(selector);
    if (!target) return;
    if (dropdown && input === target) { paint(); position(); }
    else open(target);
  });

  scopeEl.addEventListener('keydown', (event) => {
    if (!dropdown || event.target !== input) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!matches.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = active < 0
        ? (step > 0 ? 0 : matches.length - 1)
        : (active + step + matches.length) % matches.length;
      markActive(true);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      event.stopPropagation();
      pick(matches[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  });

  return { close };
}
