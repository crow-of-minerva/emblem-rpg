/** @layer ui/apps/foundry */
import { ACTOR_TYPES } from '../../../config/constants.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { reportFoundryError } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Token configuration                         */
/* -------------------------------------------- */
/**
 * Token config tabs hidden for an Object: it does not see, is not lit from within, and has no bars. Foundry v14
 * has only the vision, light and resources tabs; the other ids match nothing.
 */
const OBJECT_HIDDEN_TABS = Object.freeze([
  'vision', 'light', 'resources', 'detection', 'detectionModes', 'attributes'
]);
const SIZE_MARKER = 'emblemSizeReplaced';
const ALT_FIELD_MARKER = 'data-emblem-alt-field';
const ALT_CONTAINER_MARKER = 'emblemAltInjected';
const ALT_RETRY_DELAY_MS = 100;

/**
 * Adjust the token config for its actor type: no elevation anywhere, Objects stripped, Characters sized 1x1 or 2x2.
 * init/hooks.mjs runs this on renderTokenConfig and renderPrototypeTokenConfig.
 */
export function onRenderTokenConfig(application, html) {
  const actor = resolveActor(application);
  const root = html instanceof globalThis.HTMLElement ? html : application?.element;
  if (!root) return null;
  disableElevationField(root);
  if (actor?.type === ACTOR_TYPES.OBJECT) {
    stripObjectTokenConfig(root, actor);
    return 'object';
  }
  if (actor?.type !== ACTOR_TYPES.CHARACTER) return 'default';
  const document = application.document ?? application.token ?? application.object;
  replaceDimensionsWithSizeSelect(
    root,
    document?.width ?? actor.prototypeToken?.width ?? 1,
    document?.height ?? actor.prototypeToken?.height ?? 1
  );
  return 'character';
}

/* -------------------------------------------- */
/*  Character tokens                            */
/* -------------------------------------------- */
/**
 * Replace the token's size row with a Standard (1×1) / Large (2×2) select that fills hidden width and height
 * inputs. The row's v14 Z (depth) field is removed with it.
 */
function replaceDimensionsWithSizeSelect(root, currentWidth, currentHeight) {
  const widthInput = root.querySelector('input[name="width"]');
  const group = widthInput?.closest('.form-group');
  if (!group || group.dataset[SIZE_MARKER] === '1') return;
  const large = Number(currentWidth) === 2 && Number(currentHeight) === 2;
  const widthId = widthInput.id || '';
  const heightId = root.querySelector('input[name="height"]')?.id || '';

  group.dataset[SIZE_MARKER] = '1';
  group.innerHTML = `
    <label>Size</label>
    <div class="form-fields">
      <select name="_emblemTokenSize">
        <option value="standard" ${large ? '' : 'selected'}>Standard (1×1)</option>
        <option value="large" ${large ? 'selected' : ''}>Large (2×2)</option>
      </select>
      <input type="hidden" name="width" value="${large ? 2 : 1}" id="${widthId}">
      <input type="hidden" name="height" value="${large ? 2 : 1}" id="${heightId}">
    </div>
  `;
  const select = group.querySelector('select');
  const hiddenWidth = group.querySelector('input[name="width"]');
  const hiddenHeight = group.querySelector('input[name="height"]');
  select.addEventListener('change', () => {
    const size = select.value === 'large' ? '2' : '1';
    hiddenWidth.value = size;
    hiddenHeight.value = size;
  });
}

/* -------------------------------------------- */
/*  Object tokens                               */
/* -------------------------------------------- */
function stripObjectTokenConfig(root, actor) {
  for (const tab of OBJECT_HIDDEN_TABS) {
    for (const node of root.querySelectorAll(`[data-tab="${tab}"]`)) node.style.display = 'none';
    for (const node of root.querySelectorAll(`[data-application-part="${tab}"]`)) node.style.display = 'none';
  }
  hideDynamicTokenRingSection(root);
  injectAltImageField(root, actor);
  // If the image field wasn't there yet, try again on the next frame, after a short delay, and on each tab click.
  if (root.querySelector(`[${ALT_FIELD_MARKER}="1"]`)) return;
  const retry = () => injectAltImageField(root, actor);
  globalThis.requestAnimationFrame?.(retry);
  setTimeout(retry, ALT_RETRY_DELAY_MS);
  for (const tab of root.querySelectorAll('[data-group], nav .item, [data-action="tab"]')) {
    tab.addEventListener('click', () => globalThis.requestAnimationFrame?.(retry));
  }
}

/** Found by its English legend text, so the section stays visible when Foundry runs in another language. */
function hideDynamicTokenRingSection(root) {
  for (const legend of root.querySelectorAll('legend')) {
    if (legend.textContent?.trim() !== 'Dynamic Token Ring') continue;
    const fieldset = legend.closest('fieldset');
    if (fieldset) fieldset.style.display = 'none';
    else if (legend.parentElement) legend.parentElement.style.display = 'none';
  }
}

/**
 * Add the Object's alt image path under its texture. The path is saved to the actor as soon as it changes, not
 * with the form, so the config's Cancel does not undo it.
 */
function injectAltImageField(root, actor) {
  const source = root.querySelector('[name="texture.src"]');
  const container = source?.closest('.form-group') ?? source?.closest('fieldset') ?? source?.parentElement;
  if (!container || container.dataset[ALT_CONTAINER_MARKER] === '1') return false;
  container.dataset[ALT_CONTAINER_MARKER] = '1';

  const wrapper = document.createElement('div');
  wrapper.className = 'form-group';
  wrapper.setAttribute(ALT_FIELD_MARKER, '1');
  wrapper.innerHTML = `
    <label>Image Path Alt</label>
    <div class="form-fields">
      <input type="text" name="_emblemAltImagePath" value="${escapeHtml(actor.system?.art?.altImagePath ?? '')}"
        placeholder="Image path" style="flex:1"/>
    </div>
  `;
  container.parentNode.insertBefore(wrapper, container.nextSibling);
  const input = wrapper.querySelector('input');
  input.addEventListener('change', () => {
    void actor.update({ 'system.art.altImagePath': input.value }).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'injectAltImageField'); return null; });
  });
  return true;
}

/* -------------------------------------------- */
/*  All tokens                                  */
/* -------------------------------------------- */
function disableElevationField(root) {
  for (const field of root.querySelectorAll('[name="elevation"], [name="prototypeToken.elevation"]')) {
    const group = field.closest('.form-group') ?? field.parentElement;
    if (group) group.style.display = 'none';
  }
}

function resolveActor(application) {
  const document = application?.document ?? application?.token ?? application?.object;
  if (!document) return null;
  if (document.documentName === 'Actor') return document;
  if (document.actor) return document.actor;
  return document.parent?.documentName === 'Actor' ? document.parent : null;
}
