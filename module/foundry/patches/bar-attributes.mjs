/** @layer foundry/patches */
import { installWrapperGroup } from '../../external/host.mjs';

/* -------------------------------------------- */
/*  Fractional bar resources                    */
/* -------------------------------------------- */
const BAR_ATTRIBUTE_GROUP = 'bar-attributes';
const BAR_ATTRIBUTE_TARGET = 'CONFIG.Token.documentClass.prototype.getBarAttribute';

/**
 * Keep fractional resources in Foundry's token bars. Core truncates them with parseInt, so the exact values replace
 * core's once it has resolved the bar, and both the display and relative edits use the real resource.
 */
export function installBarAttributePatch() {
  installWrapperGroup({
    id: BAR_ATTRIBUTE_GROUP,
    required: false,
    wrappers: [{
      target: BAR_ATTRIBUTE_TARGET,
      fn: function (wrapped, ...args) { return preciseBarAttribute(wrapped(...args), this.actor?.system); },
      type: 'WRAPPER'
    }]
  });
}

/**
 * Restore the untruncated value and maximum of one resolved bar attribute.
 * @param {object|null} bar Core's answer for the bar, or null when the attribute resolves to nothing.
 * @param {object} [system] The actor system data the attribute path was read from.
 * @returns {object|null} The bar with its exact numbers, or core's own answer when nothing can be read.
 */
function preciseBarAttribute(bar, system) {
  if (bar?.type !== 'bar' || !system) return bar ?? null;
  const source = readPath(system, bar.attribute);
  if (!source || typeof source !== 'object') return bar;
  return { ...bar, value: exactNumber(source.value, bar.value), max: exactNumber(source.max, bar.max) };
}

/* -------------------------------------------- */
/*  Reading helpers                             */
/* -------------------------------------------- */
function readPath(root, path) {
  return String(path ?? '').split('.').reduce((node, key) => (node == null ? undefined : node[key]), root);
}

/** The unrounded reading when it is a real number, and core's own answer otherwise. */
function exactNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
