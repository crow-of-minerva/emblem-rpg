/** @layer ui/apps/sheets/item/editors */

/*
 * The reorderable card list the effect and animation editors are built on.
 *
 * The list operations below are plain array work with no DOM access. Most return a new array, and writeCards
 * refills the caller's array in place. `createCardList` binds them to one editor's markup, and `CardListState` holds
 * the display state (collapsed cards, folded conditions, unfinished JSON text) that must never reach the saved data.
 */

/* -------------------------------------------- */
/*  List operations                             */
/* -------------------------------------------- */

/** Whether an index points at a card in the list. */
function holds(cards, index) {
  return Array.isArray(cards) && Number.isInteger(index) && index >= 0 && index < cards.length;
}

/** The list with one more card at its end. */
export function addCard(cards, card) {
  return [...cards, card];
}

/** The list with one card inserted at `index`, clamped to the ends. */
export function insertCard(cards, index, card) {
  const next = [...cards];
  next.splice(Math.max(0, Math.min(Number.isInteger(index) ? index : next.length, next.length)), 0, card);
  return next;
}

/** The list without the card at `index`. An index outside the list leaves the list as it was. */
export function removeCard(cards, index) {
  if (!holds(cards, index)) return cards;
  const next = [...cards];
  next.splice(index, 1);
  return next;
}

/**
 * The list with a copy of one card directly after it.
 * @param {object[]} cards        The list.
 * @param {number} index          The card being copied.
 * @param {Function} [clone]      How deep the copy goes. Editors pass their own deep clone.
 * @returns {object[]}
 */
export function duplicateCard(cards, index, clone = card => card) {
  if (!holds(cards, index)) return cards;
  const next = [...cards];
  next.splice(index + 1, 0, clone(cards[index]));
  return next;
}

/** The list with one card taken out at `from` and put back at `to`. */
export function moveCard(cards, from, to) {
  if (!holds(cards, from)) return cards;
  const next = [...cards];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(Number.isInteger(to) ? to : next.length, next.length)), 0, moved);
  return next;
}

/**
 * Move one card from one list into another. The effect editor's drag uses it, including a move into or out of an if
 * branch. Passing the same list twice reorders it, with `toIndex` read against the list as it stands once the card
 * is out of it.
 * @param {object[]} fromCards            The list losing the card.
 * @param {number} fromIndex              Which card.
 * @param {object[]} toCards              The list gaining it.
 * @param {number} toIndex                Where it lands, clamped to the ends.
 * @returns {{from: object[], to: object[]}} Both lists as they stand after the move.
 */
export function transferCard(fromCards, fromIndex, toCards, toIndex) {
  if (!holds(fromCards, fromIndex)) return { from: fromCards, to: toCards };
  const from = [...fromCards];
  const [moved] = from.splice(fromIndex, 1);
  const to = fromCards === toCards ? from : [...toCards];
  to.splice(Math.max(0, Math.min(Number.isInteger(toIndex) ? toIndex : to.length, to.length)), 0, moved);
  return { from, to };
}

/**
 * Put an operation's result back into the array the caller already holds.
 *
 * An effect branch lives inside the step that owns it, so the editor can't swap in a new array. It writes the new
 * contents into the one it has instead. A result that is the same array means the operation changed nothing.
 * @param {object[]} cards        The array to fill.
 * @param {object[]} next         What it should hold.
 * @returns {boolean}             Whether anything changed.
 */
export function writeCards(cards, next) {
  if (next === cards) return false;
  cards.splice(0, cards.length, ...next);
  return true;
}

/* -------------------------------------------- */
/*  Authored JSON                               */
/* -------------------------------------------- */

/**
 * Read one JSON field an author typed into a card.
 *
 * Text that does not parse comes back as it was typed rather than as nothing, so the editor can hold it in
 * `CardListState` and paint it again instead of replacing half-finished work with a default.
 * @param {string} raw            The field's text.
 * @returns {{empty: true}|{value: *}|{invalid: string}} Blank, the parsed value, or the text exactly as typed.
 */
export function parseCardJson(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return { empty: true };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { invalid: text };
  }
}

/**
 * The validation sentences a save refusal shows for the JSON fields still unparsed, naming the card each one sits on.
 * @param {Array<{index: number, field: string}>} unparsed   Card positions and field names in words, in reading order.
 * @param {string} noun                                      What the editor calls one card, such as `step`.
 * @returns {string[]}                                       One sentence per field, none when every field parses.
 */
export function unparsedJsonErrors(unparsed, noun) {
  return unparsed.map(({ index, field }) =>
    `The ${field} box in ${Number.isInteger(index) ? `${noun} ${index + 1}` : `a ${noun}`} is not valid JSON.`);
}

/* -------------------------------------------- */
/*  Transient card state                        */
/* -------------------------------------------- */

/**
 * The display state an editor keeps while its dialog is open: which cards are collapsed, which conditions are folded
 * away, and the text of any field an author has typed but not finished.
 *
 * None of it belongs to the authored data, so it is held here against an id made for each card and written into the
 * card's markup as `data-card-id`. Reading a list back links each newly read card object to the id its element
 * carried, so a flag follows its card through a reorder and is never saved with it.
 */
export class CardListState {
  /** @type {WeakMap<object, string>} */
  #ids = new WeakMap();

  /** @type {Map<string, Set<string>>} */
  #flags = new Map();

  /** @type {Map<string, Map<string, string>>} */
  #texts = new Map();

  #minted = 0;

  /** This card's id, creating one the first time the editor renders it. */
  identify(card) {
    if (!card || typeof card !== 'object') return '';
    const known = this.#ids.get(card);
    if (known) return known;
    const id = `card-${++this.#minted}`;
    this.#ids.set(card, id);
    return id;
  }

  /** Link a card just read from the DOM to the id its element carried, or create one when it had none. */
  adopt(card, id) {
    if (!card || typeof card !== 'object') return '';
    if (!id) return this.identify(card);
    this.#ids.set(card, id);
    return id;
  }

  /** Whether a flag is set on this card id. */
  isSet(id, flag) {
    return this.#flags.get(id)?.has(flag) === true;
  }

  /** Set or clear one flag. Clearing a card's last flag drops its entry. */
  set(id, flag, on) {
    if (!id) return;
    const flags = this.#flags.get(id) ?? new Set();
    if (on) flags.add(flag);
    else flags.delete(flag);
    if (flags.size) this.#flags.set(id, flags);
    else this.#flags.delete(id);
  }

  /** The text held for one of this card's fields, or an empty string where it has none. */
  text(id, field) {
    return this.#texts.get(id)?.get(field) ?? '';
  }

  /** Hold a field's text as typed, or, given nothing, forget it because the field reads cleanly again. */
  setText(id, field, value) {
    if (!id) return;
    const texts = this.#texts.get(id) ?? new Map();
    if (value) texts.set(field, String(value));
    else texts.delete(field);
    if (texts.size) this.#texts.set(id, texts);
    else this.#texts.delete(id);
  }

  /** Give a duplicated card its own id, showing what the card it was copied from shows. */
  inherit(sourceCard, card) {
    const source = this.#ids.get(sourceCard);
    const id = this.identify(card);
    const flags = source ? this.#flags.get(source) : null;
    if (flags?.size) this.#flags.set(id, new Set(flags));
    const texts = source ? this.#texts.get(source) : null;
    if (texts?.size) this.#texts.set(id, new Map(texts));
    return id;
  }
}

/**
 * Whether any of these cards is expanded, which decides what a collapse-all control does next and what its label
 * says.
 * @param {CardListState} state   The editor's display state.
 * @param {string[]} ids          The card ids the control acts on.
 * @returns {boolean}
 */
export function anyCardExpanded(state, ids) {
  return ids.some(id => !state.isSet(id, 'collapsed'));
}

/* -------------------------------------------- */
/*  DOM adapter                                 */
/* -------------------------------------------- */

/**
 * Bind the operations above to one editor's markup.
 *
 * Each editor supplies the selector matching one of its cards, the renderer that builds a card and the reader that
 * parses one back, and so keeps its own classes, labels and data-action names. The controller itself decides
 * nothing about a card's contents.
 * @param {object} options
 * @param {string} options.cardSelector            The selector matching one card element.
 * @param {Function} options.renderCard            `(card, index, context) => string` of markup.
 * @param {Function} options.readCard              `(cardElement, context) => object|null`. Null drops the card.
 * @param {string} [options.emptyHtml]             Painted in place of a list with no cards.
 * @param {string} [options.indexSelector]         The element showing a card's ordinal, for `reindex`.
 * @param {string} [options.indexAttribute]        The dataset key holding a card's index, for `reindex`.
 * @returns {object}
 */
export function createCardList({
  cardSelector,
  renderCard,
  readCard,
  emptyHtml = '',
  indexSelector = '',
  indexAttribute = 'stepIdx'
}) {
  const state = new CardListState();

  return {
    state,

    /** One card's markup, for an editor that inserts a card without repainting the list around it. */
    renderOne(card, index, context) {
      return renderCard(card, index, context);
    },

    /** Draw a whole list, or its empty marker where it has no cards. */
    paint(listEl, cards, context) {
      if (!listEl) return;
      const html = (cards ?? []).map((card, index) => renderCard(card, index, context)).join('');
      listEl.innerHTML = html || emptyHtml;
    },

    /** Read a list back from its direct child cards only, so a nested list is read by the card that owns it. */
    read(listEl, context) {
      const cards = [];
      if (!listEl) return cards;
      for (const element of listEl.querySelectorAll(`:scope > ${cardSelector}`)) {
        const card = readCard(element, context);
        if (card) cards.push(card);
      }
      return cards;
    },

    /**
     * Renumber the cards of a list an editor changed in place instead of repainting. Unlike `read`, this numbers
     * every matching card inside the list, nested ones included.
     */
    reindex(listEl) {
      if (!listEl) return;
      listEl.querySelectorAll(cardSelector).forEach((element, index) => {
        element.dataset[indexAttribute] = index;
        const ordinal = indexSelector ? element.querySelector(indexSelector) : null;
        if (ordinal) ordinal.textContent = `#${index + 1}`;
      });
    }
  };
}
