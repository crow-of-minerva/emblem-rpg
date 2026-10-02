/** @layer ui/apps/sheets/item/editors */
/*
 * The condition tree builder used by the modifier, requirement and damage-type condition editors and by the effect
 * editor's if steps, plus the one-line condition summaries they show. The builder reads the DOM back into a tree
 * before each edit and repaints the result. Nodes carry temporary ids while painted, and the ids are stripped before
 * a tree is handed out.
 */
import { createItemEditorNotifier } from '../../../../../presentation/interface/notifications.mjs';
import {
  COMPARE_OPS,
  CONTAINS_OPS,
  empty as emptyTree,
  GROUP_OPS,
  isEmpty as isTreeEmpty,
  LEAF_KINDS,
  STATUS_SIDES,
  validate as validateTree
} from '../../../../../contracts/dsl/conditions.mjs';
import {
  CONTEXT_ROOTS,
  ENGAGEMENT_CHOICES,
  ENGAGEMENT_KINDS,
  pickerGroups,
  resolveTarget
} from '../../../../../contracts/domains/characters.mjs';
import { resolveAuraTarget } from '../../../../../game/effects/auras.mjs';
import { escapeHtml } from '../../../../../lib/dom/html.mjs';
import { wireCatalogPicker } from '../../../../../lib/dom/search-dropdown.mjs';
import { FoundryDiagnostics } from '../../../../../foundry/adapters/services/diagnostics.mjs';

const notify = createItemEditorNotifier({ sourcePath: import.meta.url, diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Condition summaries                         */
/* -------------------------------------------- */

/**
 * Split a condition tree into the single line every condition preview shows: the root group's operator, then its
 * rules by their authored paths, joined with && or ||. `summarizeCondition`, `conditionLineHtml` and
 * `paintConditionLine` all render these two parts, so every condition preview reads alike.
 * @param {object|null} tree      The tree.
 * @returns {{op: string, text: string}} `op` is empty when the tree holds nothing to evaluate.
 */
export function conditionLineParts(tree) {
  if (isTreeEmpty(tree)) return { op: '', text: 'always' };
  const root = tree.kind === 'group' ? tree : { kind: 'group', op: 'and', children: [tree] };
  return { op: root.op === 'or' ? 'OR' : 'AND', text: joinConditionLine(root) || 'always' };
}

/** The condition line as plain text, such as `OR : target.vulns.shadow || 25% chance`. */
export function summarizeCondition(tree) {
  const { op, text } = conditionLineParts(tree);
  return op ? `${op} : ${text}` : text;
}

/** The condition line as markup, with the operator in its own span so a stylesheet can tint it. */
export function conditionLineHtml(tree) {
  const { op, text } = conditionLineParts(tree);
  const opHtml = op ? `<span class="cond-line-op">${op} :</span> ` : '';
  return `${opHtml}<span class="cond-line-text">${escapeHtml(text)}</span>`;
}

/** Write the condition line into a preview element. The builder calls this after every paint and input. */
export function paintConditionLine(el, tree) {
  if (el) el.innerHTML = conditionLineHtml(tree);
}

/** Join a group's rules with its operator, skipping children that hold nothing. */
function joinConditionLine(group) {
  return (group.children || [])
    .map(conditionLineTerm)
    .filter(Boolean)
    .join(group.op === 'or' ? ' || ' : ' && ');
}

/** One rule of the condition line. A nested group of several rules is parenthesised. */
function conditionLineTerm(node) {
  switch (node?.kind) {
    case 'group': {
      const terms = (node.children || []).map(conditionLineTerm).filter(Boolean);
      return terms.length < 2 ? (terms[0] ?? '') : `(${joinConditionLine(node)})`;
    }
    case 'compare': {
      const anyCase = CONTAINS_OPS.includes(node.op) && node.right?.ignoreCase === true ? ' (any case)' : '';
      return `${node.left} ${node.op} ${formatOperand(node.right)}${anyCase}`;
    }
    case 'truthy': return `${node.negate === true ? '!' : ''}${node.expr ?? ''}`;
    case 'status': {
      const side = node.side === 'target' ? 'target ' : '';
      return `${side}${node.negate === true ? 'lacks' : 'has'} "${node.name ?? ''}"`;
    }
    case 'chance': return `${node.percent}% chance`;
    default: return '';
  }
}

function formatOperand(operand) {
  if (!operand) return '--';
  if ('literal' in operand) {
    if (Array.isArray(operand.literal)) return `[${operand.literal.map(formatLiteral).join(', ')}]`;
    return formatLiteral(operand.literal);
  }
  return operand.expr;
}

function formatLiteral(value) {
  if (ENGAGEMENT_CHOICES.includes(value)) return value;
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  return value === undefined ? '--' : String(value);
}

/* -------------------------------------------- */
/*  Node Ids                                    */
/* -------------------------------------------- */

/**
 * Counter for the temporary ids each node gets while the tree is drawn, reset on every redraw so ids stay small.
 * @type {number}
 */
let _nextNodeId = 0;

/** Stamp every node with an id, in place. */
function assignIds(tree) {
  if (!tree || typeof tree !== 'object') return tree;
  tree._id = ++_nextNodeId;
  if (tree.kind === 'group') tree.children?.forEach(assignIds);
  return tree;
}

/** A copy of the tree with the temporary ids removed. Callers outside the builder only ever get this copy. */
function stripIds(tree) {
  if (!tree || typeof tree !== 'object') return tree;
  const clone = { ...tree };
  delete clone._id;
  if (clone.kind === 'group') clone.children = (clone.children || []).map(stripIds);
  return clone;
}

function findNode(tree, id) {
  if (!tree) return null;
  if (tree._id === id) return tree;
  if (tree.kind === 'group') {
    for (const c of (tree.children || [])) {
      const hit = findNode(c, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** The parent of the node carrying an id, or null where it is the root. */
function findParent(tree, id, parent = null) {
  if (!tree) return null;
  if (tree._id === id) return parent;
  if (tree.kind === 'group') {
    for (const c of (tree.children || [])) {
      const hit = findParent(c, id, tree);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * How each comparison operator reads in the selector, in words where words are clearer than symbols.
 * @type {Record<string, string>}
 */
const COMPARE_OP_LABELS = {
  '===': 'is', '!==': 'is not',
  '<': '<', '>': '>', '<=': '≤', '>=': '≥',
  'includes': 'is one of', 'not-includes': 'is not one of',
  'contains': 'contains', 'not-contains': 'does not contain'
};

/** How the change-kind button names each leaf kind in its tooltip, in the order it steps through them. */
const LEAF_KIND_LABELS = { compare: 'compare', truthy: 'truthy', chance: 'chance', status: 'status effect' };

/** How the status leaf names each side in its selector. */
const STATUS_SIDE_LABELS = { self: 'self', target: 'target' };

/** Operators that order two values, which only make sense for a numeric field. */
const ORDERING_OPS = Object.freeze(['<', '>', '<=', '>=']);

/**
 * Offer the operators that suit the chosen field. A known non-numeric path drops the ordering
 * operators, which the evaluator in `game/effects/conditions.mjs` would otherwise compare as strings. An
 * unrecognised path is a hand-written expression whose type nobody knows, so it keeps every operator, and an
 * operator already authored is always kept so loading an existing tree never silently rewrites it.
 * @param {string} left    The authored left-hand path or expression.
 * @param {string} current The operator the leaf already holds.
 * @returns {ReadonlyArray<string>}
 */
function operatorsForPath(left, current) {
  const kind = PATH_KINDS.get(String(left ?? '').trim());
  if (!kind || kind === 'number') return COMPARE_OPS;
  return COMPARE_OPS.filter(op => !ORDERING_OPS.includes(op) || op === current);
}

/**
 * The right-hand side of a comparison, as either a literal or an expression.
 *
 * A list operator takes its literal as a comma-separated string, which is split on read. The placeholder says so,
 * since nothing else in the row would. A `contains` or `not-contains` comparison adds the "any case" mode, a
 * literal stored with `ignoreCase` that the evaluator in game/effects/conditions.mjs matches without regard to letter
 * case. The mode is offered only beside those operators, so `mountConditionTreeBuilder` redraws the whole tree when
 * an operator changes.
 * @param {string} op             The comparison's operator, which decides the modes on offer.
 */
function renderRightOperand(operand, op) {
  const isLiteral = operand && 'literal' in operand;
  const searches = CONTAINS_OPS.includes(op);
  const anyCase = searches && isLiteral && operand.ignoreCase === true;
  const mode = anyCase ? 'anycase' : (isLiteral ? 'literal' : 'expr');
  const value = isLiteral
    ? (Array.isArray(operand.literal) ? operand.literal.join(', ') : String(operand.literal ?? ''))
    : (operand?.expr ?? '');
  const placeholder = mode === 'expr'
    ? 'SafeEval expression'
    : (searches ? 'text to find' : 'value (or comma-separated for "is one of")');
  const anyCaseOption = searches
    ? `<option value="anycase"${mode === 'anycase' ? ' selected' : ''}>any case</option>`
    : '';
  return `
    <span class="mod-right-operand">
      <select class="mod-right-mode" data-right-mode>
        <option value="literal"${mode === 'literal' ? ' selected' : ''}>literal</option>
        ${anyCaseOption}
        <option value="expr"${mode === 'expr' ? ' selected' : ''}>expression</option>
      </select>
      <input type="text" class="mod-right-value" data-right-value
             value="${escapeHtml(value)}" placeholder="${placeholder}" />
    </span>`;
}

/** The leaves that carry their own `negate`. A comparison is negated by its operator, a chance by its percent. */
const NEGATABLE_KINDS = Object.freeze(['truthy', 'status']);

/** The controls a leaf carries: change kind and delete, plus negate on the leaves in `NEGATABLE_KINDS`. */
function leafButtons(kind) {
  const negate = NEGATABLE_KINDS.includes(kind) ? `
      <button type="button" class="mod-leaf-kind-btn" data-action="negate-node" data-tooltip="Negate">
        <span class="mod-not-glyph">¬</span>
      </button>` : '';
  const cycle = LEAF_KINDS.map(entry => LEAF_KIND_LABELS[entry]).join(' → ');
  return `
    <div class="mod-actions-cluster">${negate}
      <button type="button" class="mod-leaf-kind-btn" data-action="change-kind" data-tooltip="Change leaf type (${cycle})">
        <i class="fas fa-exchange-alt"></i>
      </button>
      <button type="button" class="mod-leaf-del" data-action="delete-node" data-tooltip="Delete">
        <i class="fas fa-trash"></i>
      </button>
    </div>`;
}

/**
 * One leaf row, by kind. A comparison takes a path, an operator and a value. A truthy leaf takes only a path, a
 * chance leaf only a percentage, and a status leaf a side and a status name. The truthy and status leaves keep
 * their `negate` on the row as `data-negate`, which the negate button flips and `readLeafFromDom` reads back.
 */
function renderLeaf(node) {
  const id = node._id;
  switch (node.kind) {
    case 'compare': {
      const opOptions = operatorsForPath(node.left, node.op).map(op =>
        `<option value="${op}"${op === node.op ? ' selected' : ''}>${COMPARE_OP_LABELS[op]}</option>`
      ).join('');
      return `
        <div class="mod-leaf mod-leaf-compare" data-node-id="${id}" data-kind="compare">
          <input type="text" class="mod-left-input" data-left-input data-path-input="path"
                 value="${escapeHtml(node.left)}" placeholder="property path or expression" autocomplete="off" />
          <select class="mod-compare-op" data-compare-op>${opOptions}</select>
          ${renderRightOperand(node.right, node.op)}
          ${leafButtons('compare')}
        </div>`;
    }
    case 'truthy': {
      const negated = node.negate === true;
      return `
        <div class="mod-leaf mod-leaf-unary${negated ? ' mod-leaf-negated' : ''}" data-node-id="${id}"
             data-kind="truthy" data-negate="${negated}">
          <input type="text" class="mod-left-input" data-left-input data-path-input="path"
                 value="${escapeHtml(node.expr)}" placeholder="property path" autocomplete="off" />
          <span class="mod-unary-verb">${negated ? 'is falsy' : 'is truthy'}</span>
          ${leafButtons('truthy')}
        </div>`;
    }
    case 'chance': {
      return `
        <div class="mod-leaf mod-leaf-chance" data-node-id="${id}" data-kind="chance">
          <input type="number" class="mod-chance-input" data-chance-input min="0" max="100" step="1"
                 value="${escapeHtml(String(node.percent ?? 0))}" />
          <span class="mod-unary-verb">% chance</span>
          ${leafButtons('chance')}
        </div>`;
    }
    case 'status': {
      const negated = node.negate === true;
      const side = STATUS_SIDES.includes(node.side) ? node.side : 'self';
      const sideOptions = STATUS_SIDES.map(entry =>
        `<option value="${entry}"${entry === side ? ' selected' : ''}>${STATUS_SIDE_LABELS[entry]}</option>`
      ).join('');
      return `
        <div class="mod-leaf mod-leaf-status${negated ? ' mod-leaf-negated' : ''}" data-node-id="${id}"
             data-kind="status" data-negate="${negated}">
          <select class="mod-status-side" data-status-side data-tooltip="Whose statuses to check">${sideOptions}</select>
          <span class="mod-unary-verb">${negated ? 'does not have' : 'has'}</span>
          <input type="text" class="mod-left-input" data-status-name
                 value="${escapeHtml(node.name ?? '')}" placeholder="status effect name" autocomplete="off" />
          ${leafButtons('status')}
        </div>`;
    }
  }
  return '';
}

/**
 * Render a condition node and everything under it. The root group has no delete control.
 * @param {string} [rootActionsHtml]      Caller markup placed first in the root group's action cluster.
 */
function renderNode(node, depth = 0, rootActionsHtml = '') {
  if (!node) return '';
  if (node.kind === 'group') {
    const opOptions = GROUP_OPS.map(op =>
      `<option value="${op}"${op === node.op ? ' selected' : ''}>${op}</option>`
    ).join('');
    const children = (node.children || []).map(c => renderNode(c, depth + 1)).join('');
    const isRoot = depth === 0;
    return `
      <div class="mod-group" data-node-id="${node._id}" data-depth="${depth}">
        <div class="mod-group-header">
          <select class="mod-group-op" data-group-op>${opOptions}</select>
          <div class="mod-actions-cluster">
            ${isRoot ? rootActionsHtml : ''}
            <button type="button" class="mod-group-btn" data-action="add-rule" data-tooltip="Add comparison rule">
              + rule
            </button>
            <button type="button" class="mod-group-btn" data-action="add-group" data-tooltip="Add nested AND/OR group">
              + group
            </button>
            ${isRoot ? '' : `
              <button type="button" class="mod-group-btn mod-group-del" data-action="delete-node" data-tooltip="Delete group">
                <i class="fas fa-trash"></i>
              </button>`}
          </div>
        </div>
        <div class="mod-group-children">${children}</div>
      </div>`;
  }
  return renderLeaf(node);
}

/**
 * Bind the property-path picker on the dialog, so it keeps working when a condition tree is repainted.
 * @param {HTMLElement} scopeEl           The dialog's content.
 * @param {object} [options]
 * @param {object[]} [options.categories] Which paths to offer.
 * @param {string} [options.selector]     Which fields open it.
 * @returns {{close: Function}}
 */
export function mountPathPicker(scopeEl, { categories = PATH_CATEGORIES, selector = '[data-path-input="path"]' } = {}) {
  return wireCatalogPicker(scopeEl, {
    selector,
    groups: categories.map(category => ({
      label: category.label,
      entries: category.paths.map(descriptor => ({ value: descriptor.path, label: descriptor.label }))
    }))
  });
}

/* -------------------------------------------- */
/*  Clipboard                                   */
/* -------------------------------------------- */

/**
 * The condition clipboard. The modifier and requirement editors share it, so a condition copied in one can be pasted
 * in the other.
 * @type {object|null}
 */
let _conditionClipboard = null;

/** Put a tree on the clipboard, cloned so later edits to the original don't reach it. */
export function setConditionClipboard(tree) {
  _conditionClipboard = tree ? foundry.utils.deepClone(tree) : null;
}

/**
 * Take a copy of the clipboard's tree.
 * @returns {object|null}
 */
export function getConditionClipboard() {
  return _conditionClipboard ? foundry.utils.deepClone(_conditionClipboard) : null;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/**
 * Turn typed text into the value it most likely means. Booleans, null and numbers are recognised, so a comparison
 * against `true` tests the boolean rather than the string. Anything else stays text. The field's kind is not
 * checked, so text that looks like a number is always stored as a number.
 */
function coerceLiteral(s) {
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Read one leaf out of its row. A list operator splits its literal on commas and drops the empty pieces, so trailing
 * commas and stray spaces don't become entries.
 */
function readLeafFromDom(card, kind) {
  if (kind === 'compare') {
    const left = card.querySelector('[data-left-input]')?.value ?? '';
    const op = card.querySelector('[data-compare-op]')?.value ?? '===';
    const mode = card.querySelector('[data-right-mode]')?.value ?? 'literal';
    const value = card.querySelector('[data-right-value]')?.value ?? '';
    let right;
    if (mode === 'expr') {
      right = { expr: value };
    } else if (CONTAINS_OPS.includes(op)) {
      right = mode === 'anycase' ? { literal: value, ignoreCase: true } : { literal: value };
    } else if (op === 'includes' || op === 'not-includes') {
      const parts = value.split(',').map(s => coerceLiteral(s.trim())).filter(s => s !== '');
      right = { literal: parts };
    } else {
      right = { literal: coerceLiteral(value) };
    }
    return { kind: 'compare', left, op, right };
  }
  const negate = card.dataset.negate === 'true' ? { negate: true } : {};
  if (kind === 'truthy') {
    return { kind, expr: card.querySelector('[data-left-input]')?.value ?? '', ...negate };
  }
  if (kind === 'status') {
    const side = card.querySelector('[data-status-side]')?.value;
    return {
      kind, name: (card.querySelector('[data-status-name]')?.value ?? '').trim(),
      side: STATUS_SIDES.includes(side) ? side : 'self', ...negate
    };
  }
  if (kind === 'chance') {
    const percent = Number(card.querySelector('[data-chance-input]')?.value);
    return { kind: 'chance', percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0 };
  }
  return null;
}

/**
 * Read a node and everything under it out of the DOM. Children are read only from the node's own children
 * container, so a nested group's rows are read by that group and not twice.
 */
function readNode(el) {
  const id = parseInt(el.dataset.nodeId);
  if (el.classList.contains('mod-group')) {
    const op = el.querySelector(':scope > .mod-group-header > .mod-group-op')?.value ?? 'and';
    const childrenContainer = el.querySelector(':scope > .mod-group-children');
    const children = [];
    for (const childEl of childrenContainer.children) {
      const child = readNode(childEl);
      if (child) children.push(child);
    }
    return { kind: 'group', op, children, _id: id };
  }
  const kind = el.dataset.kind;
  const leaf = readLeafFromDom(el, kind);
  if (leaf) leaf._id = id;
  return leaf;
}

function readTreeFromContainer(containerEl) {
  const rootEl = containerEl.querySelector(':scope > .mod-group');
  if (!rootEl) return emptyTree();
  return readNode(rootEl) || emptyTree();
}

/* -------------------------------------------- */
/*  Editing                                     */
/* -------------------------------------------- */

function newLeafOfKind(kind) {
  if (kind === 'compare') return { kind: 'compare', left: '', op: '===', right: { literal: '' } };
  if (kind === 'truthy')  return { kind: 'truthy',  expr: '' };
  if (kind === 'chance')  return { kind: 'chance',  percent: 50 };
  if (kind === 'status')  return { kind: 'status',  name: '', side: 'self' };
  return null;
}

/** The next leaf kind in the cycle the change-kind button steps through. It opens no prompt. */
function promptChangeKind(currentKind) {
  const idx = LEAF_KINDS.indexOf(currentKind);
  return LEAF_KINDS[(idx + 1) % LEAF_KINDS.length];
}

/**
 * Repaint the condition tree, its summary and its JSON. A root that isn't a group is wrapped in one, so the editor
 * can add rules beside it.
 * @param {object|null} summaryEls        The summary and JSON elements, where the caller supplied them.
 */
function paintTreeInternal(state, containerEl, summaryEls) {
  state.tree = state.tree || emptyTree();
  if (state.tree.kind !== 'group') state.tree = { kind: 'group', op: 'and', children: [state.tree] };

  _nextNodeId = 0;
  assignIds(state.tree);
  containerEl.innerHTML = renderNode(state.tree, 0, state.rootActionsHtml);

  paintConditionLine(summaryEls?.summary, state.tree);
  if (summaryEls?.json) summaryEls.json.value = JSON.stringify(stripIds(state.tree), null, 2);
}

/* -------------------------------------------- */
/*  Mounting                                    */
/* -------------------------------------------- */


/**
 * Read a condition tree out of a mounted builder's markup. The markup is the builder's source of truth (it reads
 * the tree back from it before every edit), so the effect editor can read a tree without holding the handle.
 * @param {HTMLElement} containerEl   The container a builder was mounted on.
 * @returns {object|null} The tree, or `null` when it holds nothing to evaluate.
 */
export function readConditionTree(containerEl) {
  if (!containerEl) return null;
  const tree = readTreeFromContainer(containerEl);
  return isTreeEmpty(tree) ? null : stripIds(tree);
}

/**
 * Apply one builder control's edit to the tree just read from the markup. The mounted builder repaints the result.
 * @param {object} tree      The tree read out of the markup, edited in place.
 * @param {string} action    The edit the clicked control asked for.
 * @param {number|null} nodeId  The node it was clicked on, where the edit names one.
 * @param {HTMLElement} btn  The clicked control (unused).
 * @returns {Promise<object|null>} The edited tree, or null for an unknown action.
 */
async function applyConditionEdit(tree, action, nodeId, btn) {
  if (action === 'add-rule') {
    const group = findNode(tree, nodeId);
    if (group?.kind === 'group') {
      group.children = group.children || [];
      group.children.push(newLeafOfKind('compare'));
    }
  } else if (action === 'add-group') {
    const group = findNode(tree, nodeId);
    if (group?.kind === 'group') {
      group.children = group.children || [];
      group.children.push({ kind: 'group', op: 'and', children: [] });
    }
  } else if (action === 'delete-node') {
    const parent = findParent(tree, nodeId);
    if (parent?.kind === 'group') {
      parent.children = parent.children.filter(c => c._id !== nodeId);
    }
  } else if (action === 'negate-node') {
    const node = findNode(tree, nodeId);
    if (!node || !NEGATABLE_KINDS.includes(node.kind)) return tree;
    if (node.negate === true) delete node.negate;
    else node.negate = true;
  } else if (action === 'change-kind') {
    const node = findNode(tree, nodeId);
    if (node && node.kind !== 'group') {
      const next = await promptChangeKind(node.kind);
      const replacement = newLeafOfKind(next);
      replacement._id = node._id;
      const currentExpr = node.expr ?? node.left ?? '';
      if (replacement.kind === 'compare') replacement.left = currentExpr;
      else if (replacement.kind === 'truthy') replacement.expr = currentExpr;
      const parent = findParent(tree, nodeId);
      if (parent?.kind === 'group') {
        const idx = parent.children.findIndex(c => c._id === nodeId);
        if (idx >= 0) parent.children[idx] = replacement;
      }
    }
  } else {
    return null;
  }
  return tree;
}

/**
 * Mount a condition builder on a container and return its handle.
 * @param {HTMLElement} containerEl               Where the tree is drawn.
 * @param {object} [options]
 * @param {object|null} [options.initialTree]     The tree to start from.
 * @param {HTMLElement} [options.scopeEl]         The element whose events the builder listens to.
 * @param {object} [options.summaryEls]           Summary and JSON elements the builder keeps current.
 * @param {string} [options.rootActionsHtml]      Markup placed first in the root group's action cluster, repainted
 *                                                with the tree. The caller handles its events.
 * @param {string} [options.surface]              Which editor the condition belongs to (effect, modifier, aura,
 *                                                requirement or damageType), for checking pasted JSON. Defaults
 *                                                to effect.
 * @returns {{getTree: Function, isEmpty: Function, setTree: Function, repaint: Function}}
 */
export function mountConditionTreeBuilder(containerEl, options = {}) {
  const summaryEls = options.summaryEls || null;
  const scopeEl = options.scopeEl || containerEl;
  const surface = options.surface || 'effect';

  const state = {
    tree: options.initialTree
      ? foundry.utils.deepClone(options.initialTree)
      : emptyTree(),
    rootActionsHtml: options.rootActionsHtml || ''
  };

  const repaint = () => paintTreeInternal(state, containerEl, summaryEls);

  scopeEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn || !containerEl.contains(btn)) return;

    state.tree = readTreeFromContainer(containerEl);

    const container = btn.closest('[data-node-id]');
    const nodeId = container ? parseInt(container.dataset.nodeId) : null;
    const action = btn.dataset.action;

    const edited = await applyConditionEdit(state.tree, action, nodeId, btn);
    if (!edited) return;
    state.tree = edited;

    repaint();
  });

  // A committed left-hand path decides which operators the row may offer, so repaint once the author leaves it.
  // This listens for `change` rather than `input` so the field is not torn out from under the caret mid-typing.
  scopeEl.addEventListener('change', (ev) => {
    if (!ev.target.matches('[data-left-input]') || !containerEl.contains(ev.target)) return;
    state.tree = readTreeFromContainer(containerEl);
    repaint();
  });

  scopeEl.addEventListener('input', (ev) => {
    if (!ev.target.closest('[data-node-id]')) return;
    if (!containerEl.contains(ev.target)) return;
    state.tree = readTreeFromContainer(containerEl);
    if (ev.target.matches('[data-compare-op]')) {
      repaint();
      return;
    }
    paintConditionLine(summaryEls?.summary, state.tree);
    if (summaryEls?.json && document.activeElement !== summaryEls.json) {
      summaryEls.json.value = JSON.stringify(stripIds(state.tree), null, 2);
    }
  });

  if (summaryEls?.json) {
    summaryEls.json.addEventListener('blur', () => {
      if (summaryEls.json.value.trim() === '') return;
      try {
        const parsed = JSON.parse(summaryEls.json.value);
        const r = validateTree(parsed, { surface });
        if (!r.valid) {
          notify.warn(`This condition was not applied. ${r.errors.join(' ')}`);
          return;
        }
        if (r.warnings.length) notify.warn(r.warnings.join(' '));
        state.tree = parsed;
        assignIds(state.tree);
        repaint();
      } catch (err) {
        notify.warn('This condition was not applied. Its text is not valid JSON.');
      }
    });
  }

  repaint();

  return {
    getTree: () => {
      state.tree = readTreeFromContainer(containerEl);
      return isTreeEmpty(state.tree) ? null : stripIds(state.tree);
    },
    isEmpty: () => {
      const t = readTreeFromContainer(containerEl);
      return isTreeEmpty(t);
    },
    setTree: (tree) => {
      state.tree = tree ? foundry.utils.deepClone(tree) : emptyTree();
      repaint();
    },
    repaint
  };
}

/* -------------------------------------------- */
/*  Categories                                  */
/* -------------------------------------------- */

/**
 * The path picker's optgroups, in the order the vocabulary renders them.
 * @type {ReadonlyArray<object>}
 */
const PATH_CATEGORIES = Object.freeze(pickerGroups().map(group => Object.freeze({
  id: group.id,
  label: group.label,
  paths: descriptorsFor(group.entries)
})));

/**
 * Turn vocabulary entries into the `{ path, label }` descriptors the editors render.
 * @param {ReadonlyArray<object>} entries Vocabulary entries.
 * @param {string} [root] Context root to prefix, e.g. `caster`.
 * @param {string} [rootLabel] Label prefix that names the side, e.g. `Caster`.
 * @returns {ReadonlyArray<object>}
 */
function descriptorsFor(entries, root = '', rootLabel = '') {
  return Object.freeze(entries.map(entry => Object.freeze({
    path: root ? `${root}.${entry.name}` : entry.name,
    label: rootLabel ? `${rootLabel}: ${entry.label}` : entry.label,
    kind: entry.kind ?? ''
  })));
}

/**
 * The picker's optgroups as offered on a modifier's target field: only the names a modifier can write. A name
 * outside this set compiles to nothing, so the field offers no others.
 * @type {ReadonlyArray<object>}
 */
export const MODIFIER_TARGET_CATEGORIES = Object.freeze(pickerGroups()
  .map(group => Object.freeze({
    id: group.id,
    label: group.label,
    paths: descriptorsFor(group.entries.filter(entry => resolveTarget(entry.name)))
  }))
  .filter(group => group.paths.length > 0));

/**
 * The same optgroups as offered on an aura modifier's target. An aura reaches only a receiving unit's stats, as
 * resolveAuraTarget in game/effects/auras.mjs decides, so names such as `equipmentSlots` that only a unit's own
 * items may grant are not offered here.
 * @type {ReadonlyArray<object>}
 */
export const AURA_TARGET_CATEGORIES = Object.freeze(pickerGroups()
  .map(group => Object.freeze({
    id: group.id,
    label: group.label,
    paths: descriptorsFor(group.entries.filter(entry => resolveTarget(entry.name) && resolveAuraTarget(entry.name)))
  }))
  .filter(group => group.paths.length > 0));

/* -------------------------------------------- */
/*  Requirement Paths                           */
/* -------------------------------------------- */

/**
 * The picker's optgroups as offered in the requirement editor: every general path (a bare name reads the caster),
 * plus the same paths under `caster.` and `target.`.
 * @type {ReadonlyArray<object>}
 */
export const REQUIREMENT_PATH_CATEGORIES = Object.freeze([
  ...PATH_CATEGORIES,
  Object.freeze({ id: 'req-caster', label: 'Caster (requirements)', paths: mirrorSide('caster') }),
  Object.freeze({ id: 'req-target', label: 'Target (requirements)', paths: mirrorSide('target') })
]);

/**
 * Every offerable path mapped to its vocabulary kind, covering the bare names and both requirement roots.
 * `operatorsForPath` reads it to decide which comparison operators suit a chosen field.
 * @type {ReadonlyMap<string, string>}
 */
const PATH_KINDS = Object.freeze(new Map(
  REQUIREMENT_PATH_CATEGORIES.flatMap(category => category.paths.map(entry => [entry.path, entry.kind]))
));

/**
 * Re-root every vocabulary name onto one side of a requirement context.
 * @param {string} root Context root, e.g. `caster`.
 * @returns {ReadonlyArray<object>} Descriptors for that side, leaving out advanced names and names that
 *   only work without a root.
 */
function mirrorSide(root) {
  const label = CONTEXT_ROOTS.find(entry => entry.key === root)?.label ?? root;
  const entries = pickerGroups().flatMap(group => group.entries.filter(entry => entry.bareOnly !== true && entry.advanced !== true));
  return descriptorsFor(entries, root, label);
}

/* -------------------------------------------- */
/*  Node Builders                               */
/* -------------------------------------------- */

/**
 * Build an `and` group node.
 * @param {object[]} children  Child nodes, all of which must pass.
 * @returns {object}
 */
const andOf  = (children) => ({ kind: 'group', op: 'and', children });

/**
 * Build a `chance` node, which passes on a random roll.
 * @param {number} percent  Chance to pass, 0 to 100.
 * @returns {object}
 */
export const chance = (percent) => ({ kind: 'chance', percent });

/**
 * Build a `compare` node.
 * @param {string} left           Vocabulary name resolved against the evaluation context.
 * @param {string} op             Comparison operator drawn from `COMPARE_OPS`.
 * @param {*} right               Right-hand side: a literal value, or expression source when `expr` is set.
 * @param {boolean} [expr=false]  Treat `right` as an expression to evaluate rather than a literal.
 * @returns {object}
 */
const cmp = (left, op, right, expr = false) => ({
  kind: 'compare', left, op, right: expr ? { expr: right } : { literal: right }
});

/**
 * Build a `truthy` node.
 * @param {string} expr  Expression whose result must be truthy.
 * @returns {object}
 */
const truthy = (expr) => ({ kind: 'truthy', expr });

/* -------------------------------------------- */
/*  Templates                                   */
/* -------------------------------------------- */

/**
 * Condition templates for the effect editor's template picker, grouped in display order. The trees use the
 * authoring vocabulary and target roots. The blank key clears the condition.
 * @type {object[]}
 */
export const CONDITION_TEMPLATES = [
  { key: '',                        label: 'template',         group: '',                  tree: null },

  { key: 'distMelee',               label: 'Distance: melee (adjacent, within 1 level)', group: 'Distance', tree: cmp('engagement', '===', ENGAGEMENT_KINDS.MELEE) },
  { key: 'distRangedEngagement',    label: 'Distance: ranged (further, or over a drop)', group: 'Distance', tree: cmp('engagement', '===', ENGAGEMENT_KINDS.RANGED) },
  { key: 'distAdjacent',            label: 'Distance: exactly 1 sq',      group: 'Distance',          tree: cmp('distance', '===', 1) },
  { key: 'distRanged',              label: 'Distance: >1 sq',             group: 'Distance',          tree: cmp('distance', '>', 1) },
  { key: 'distAtLeast2',            label: 'Distance: ≥2 sq',             group: 'Distance',          tree: cmp('distance', '>=', 2) },
  { key: 'distAtLeast3',            label: 'Distance: ≥3 sq',             group: 'Distance',          tree: cmp('distance', '>=', 3) },
  { key: 'distExact2',              label: 'Distance: exactly 2 sq',      group: 'Distance',          tree: cmp('distance', '===', 2) },

  { key: 'isAttacking',             label: 'Owner is attacking',          group: 'Owner state',       tree: truthy('attacking') },
  { key: 'isDefending',             label: 'Owner is defending',          group: 'Owner state',       tree: truthy('defending') },
  { key: 'isUsingWeaponArt',        label: 'Owner is using a Weapon Art', group: 'Owner state',       tree: truthy('usingWeaponArt') },
  { key: 'hasAction',               label: 'Owner has unspent action',    group: 'Owner state',       tree: truthy('hasAction') },
  { key: 'hasMoved',                label: 'Owner has moved this phase',  group: 'Owner state',       tree: truthy('hasMoved') },
  { key: 'firstAttack',             label: 'First attack of round (attackIndex === 0)', group: 'Owner state', tree: cmp('attackIndex', '===', 0) },
  { key: 'isActiveItem',            label: 'This is the active ability',   group: 'Owner state',       tree: andOf([
                                                                            truthy('activeItem'),
                                                                            cmp('activeItem.uuid', '===', 'item.uuid', true)
                                                                          ]) },

  { key: 'hpFull',                  label: 'Owner at full HP',            group: 'Owner HP',          tree: cmp('hp', '>=', 'maxHp', true) },
  { key: 'hpBelowHalf',             label: 'Owner below half HP',         group: 'Owner HP',          tree: cmp('hp', '<', 'maxHp / 2', true) },
  { key: 'hpBelowQuarter',          label: 'Owner below quarter HP',      group: 'Owner HP',          tree: cmp('hp', '<', 'maxHp / 4', true) },

  { key: 'hasWielded',              label: 'Owner has a wielded weapon',  group: 'Wielded weapon',    tree: truthy('weapon') },
  { key: 'wieldedTwoHanded',        label: 'Wielded weapon is two-handed', group: 'Wielded weapon',   tree: truthy('weapon.twoHanded') },
  { key: 'wieldedBlade',            label: 'Wielded type: Blade',         group: 'Wielded weapon',    tree: cmp('weapon.type', '===', 'Blade') },
  { key: 'wieldedPolearm',          label: 'Wielded type: Polearm',       group: 'Wielded weapon',    tree: cmp('weapon.type', '===', 'Polearm') },
  { key: 'wieldedBrawling',         label: 'Wielded type: Brawling',      group: 'Wielded weapon',    tree: cmp('weapon.type', '===', 'Brawling') },
  { key: 'wieldedHeavy',            label: 'Wielded type: Heavy',         group: 'Wielded weapon',    tree: cmp('weapon.type', '===', 'Heavy') },
  { key: 'wieldedBow',              label: 'Wielded type: Bow',           group: 'Wielded weapon',    tree: cmp('weapon.type', '===', 'Bow') },
  { key: 'wieldedCovert',           label: 'Wielded type: Covert',        group: 'Wielded weapon',    tree: cmp('weapon.type', '===', 'Covert') },
  { key: 'wieldedMagic',            label: 'Wielded type: any magic',     group: 'Wielded weapon',    tree: cmp('weapon.type', 'includes', ['Arcane', 'Elemental', 'Divine', 'Occult']) },

  { key: 'hasShield',               label: 'Owner has a shield equipped', group: 'Equipment',         tree: truthy('shield') },
  { key: 'hasHeavyShield',          label: 'Owner has a Heavy shield',    group: 'Equipment',         tree: andOf([
                                                                            truthy('shield'),
                                                                            cmp('shield.type', '===', 'Heavy')
                                                                          ]) },
  { key: 'hasArmor',                label: 'Owner is wearing armor',      group: 'Equipment',         tree: truthy('armor') },

  { key: 'ownerInfantry',           label: 'Owner is infantry',           group: 'Owner unit type',   tree: truthy('infantry') },
  { key: 'ownerCavalry',            label: 'Owner is cavalry',            group: 'Owner unit type',   tree: truthy('cavalry') },
  { key: 'ownerArmored',            label: 'Owner is armored',            group: 'Owner unit type',   tree: truthy('armored') },
  { key: 'ownerFlying',             label: 'Owner is flying',             group: 'Owner unit type',   tree: truthy('airborne') },
  { key: 'ownerDragon',             label: 'Owner is a dragon',           group: 'Owner unit type',   tree: truthy('dragon') },
  { key: 'ownerBeast',              label: 'Owner is a beast',            group: 'Owner unit type',   tree: truthy('beast') },
  { key: 'ownerMonster',            label: 'Owner is a monster',          group: 'Owner unit type',   tree: truthy('monster') },
  { key: 'ownerUndead',             label: 'Owner is undead',             group: 'Owner unit type',   tree: truthy('undead') },
  { key: 'ownerMagic',              label: 'Owner is magical',            group: 'Owner unit type',   tree: truthy('magic') },

  { key: 'targetInfantry',          label: 'Target is infantry',          group: 'Target unit type',  tree: truthy('target.infantry') },
  { key: 'targetCavalry',           label: 'Target is cavalry',           group: 'Target unit type',  tree: truthy('target.cavalry') },
  { key: 'targetArmored',           label: 'Target is armored',           group: 'Target unit type',  tree: truthy('target.armored') },
  { key: 'targetFlying',            label: 'Target is flying',            group: 'Target unit type',  tree: truthy('target.airborne') },
  { key: 'targetDragon',            label: 'Target is a dragon',          group: 'Target unit type',  tree: truthy('target.dragon') },
  { key: 'targetBeast',             label: 'Target is a beast',           group: 'Target unit type',  tree: truthy('target.beast') },
  { key: 'targetMonster',           label: 'Target is a monster',         group: 'Target unit type',  tree: truthy('target.monster') },
  { key: 'targetUndead',            label: 'Target is undead',            group: 'Target unit type',  tree: truthy('target.undead') },
  { key: 'targetMagic',             label: 'Target is magical',           group: 'Target unit type',  tree: truthy('target.magic') },

  { key: 'targetExists',            label: 'Has a current target',        group: 'Target state',      tree: truthy('target') },
  { key: 'targetFullHp',            label: 'Target at full HP',           group: 'Target state',      tree: cmp('target.hp', '>=', 'target.maxHp', true) },
  { key: 'targetBelowHalf',         label: 'Target below half HP',        group: 'Target state',      tree: cmp('target.hp', '<', 'target.maxHp / 2', true) },
  { key: 'targetBelowQuarter',      label: 'Target below quarter HP',     group: 'Target state',      tree: cmp('target.hp', '<', 'target.maxHp / 4', true) },

  { key: 'targetIsBoss',            label: 'Target is a Boss',            group: 'Target faction',    tree: cmp('target.faction', '===', 'Boss') },
  { key: 'targetIsEnemy',           label: 'Target is an Enemy',          group: 'Target faction',    tree: cmp('target.faction', '===', 'Enemy') },
  { key: 'targetIsLord',            label: 'Target is the Lord',          group: 'Target faction',    tree: cmp('target.faction', '===', 'Lord') },
  { key: 'targetIsRetainer',        label: 'Target is a Retainer',        group: 'Target faction',    tree: cmp('target.faction', '===', 'Retainer') },

  { key: 'chance10',                label: 'Chance: 10%',                 group: 'Chance',            tree: chance(10) },
  { key: 'chance25',                label: 'Chance: 25%',                 group: 'Chance',            tree: chance(25) },
  { key: 'chance33',                label: 'Chance: 33%',                 group: 'Chance',            tree: chance(33) },
  { key: 'chance50',                label: 'Chance: 50%',                 group: 'Chance',            tree: chance(50) },
  { key: 'chance75',                label: 'Chance: 75%',                 group: 'Chance',            tree: chance(75) },

  { key: 'adjacentVsBoss',          label: 'Adjacent AND target is Boss', group: 'Combined',          tree: andOf([
                                                                            cmp('distance', '===', 1),
                                                                            cmp('target.faction', '===', 'Boss')
                                                                          ]) },
  { key: 'rangedVsCavalry',         label: 'Ranged AND target is cavalry', group: 'Combined',         tree: andOf([
                                                                            cmp('distance', '>', 1),
                                                                            truthy('target.cavalry')
                                                                          ]) },
  { key: 'lowHpDesperation',        label: 'Owner below half HP (desperation)', group: 'Combined',    tree: cmp('hp', '<', 'maxHp / 2', true) }
];

/* -------------------------------------------- */
/*  Lookup                                      */
/* -------------------------------------------- */

/**
 * Group the templates for rendering as optgroups, preserving declaration order. The blank-key "no condition"
 * entry carries no group and is omitted.
 * @returns {Array<{label: string, items: object[]}>}  Groups in first-seen order, each holding its templates.
 */
export function conditionTemplateGroups() {
  const groups = [];
  for (const t of CONDITION_TEMPLATES) {
    if (!t.group) continue;
    let g = groups.find(x => x.label === t.group);
    if (!g) groups.push(g = { label: t.group, items: [] });
    g.items.push(t);
  }
  return groups;
}

/**
 * Look up a template's tree by key. The result is deep-cloned so the caller may edit it without mutating the
 * shared template table.
 * @param {string} key             Template key.
 * @returns {object|null}   Fresh copy of the tree, or `null` for an unknown or condition-less key.
 */
export function conditionTemplateTree(key) {
  const entry = CONDITION_TEMPLATES.find(c => c.key === key);
  return entry?.tree ? JSON.parse(JSON.stringify(entry.tree)) : null;
}
