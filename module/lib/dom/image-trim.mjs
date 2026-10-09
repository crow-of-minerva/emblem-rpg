/** @layer lib/dom */

// Both caches are keyed by the image element's `src`, which the browser resolves to an absolute URL.
const trimmed = new Map();
const boxes = new Map();

/* -------------------------------------------- */
/*  Alpha trimming                              */
/* -------------------------------------------- */
/**
 * Crop transparent sprite padding for UI frames and cache it by the image's resolved URL. Return null for tight,
 * empty or unreadable images.
 * @param {HTMLImageElement} image A loaded image element.
 * @returns {Promise<string|null>} Cropped data URL, or null when nothing was cropped.
 */
export async function trimPngAlpha(image) {
  return (await trimmedSpriteBox(image))?.url ?? null;
}

/** A decoded image of a source path's crop, so a canvas caller can size a texture the moment it builds one. */
export async function trimmedImageElement(source) {
  const image = source ? await decodedImage(source) : null;
  const url = image ? await trimPngAlpha(image) : null;
  return url ? decodedImage(url) : null;
}

function decodedImage(source) {
  const image = new globalThis.Image();
  image.src = source;
  return image.decode().then(() => image).catch(() => null);
}

/**
 * Return a sprite crop and content dimensions for canvas sizing. Keep the original measurements with a null URL
 * when no crop is available.
 * @param {HTMLImageElement} image A loaded image element.
 * @returns {Promise<{url: string|null, width: number, height: number}|null>}
 */
export function trimmedSpriteBox(image) {
  return new Promise(resolve => {
    try {
      if (boxes.has(image.src)) return resolve(boxes.get(image.src));
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) return resolve(null);
      const source = Object.assign(globalThis.document.createElement('canvas'), { width, height });
      const context = source.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const bounds = opaqueBounds(context.getImageData(0, 0, width, height).data, width, height);
      const untrimmed = !bounds || (bounds.left === 0 && bounds.top === 0
        && bounds.right === width - 1 && bounds.bottom === height - 1);
      const box = untrimmed
        ? { url: null, width, height }
        : {
          url: cropToDataUrl(source, bounds),
          width: bounds.right - bounds.left + 1,
          height: bounds.bottom - bounds.top + 1
        };
      boxes.set(image.src, box);
      trimmed.set(image.src, box.url);
      resolve(box);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Read an already-computed crop without waiting, so a first paint can use it.
 * @param {string} source The image's resolved absolute URL. A relative path as authored does not match.
 * @returns {string|null} Cropped data URL, or null when it is absent or was not croppable.
 */
export function cachedTrimmedImage(source) {
  return trimmed.get(source) ?? null;
}

/**
 * Crop the `[data-sprite-src]` images in a rendered container, skipping any whose crop is already cached. After
 * the async crop, an image is replaced only if it is still on the page with the same source.
 * @param {HTMLElement} container Rendered container holding `[data-sprite-src]` images.
 */
export function trimContainerSprites(container) {
  for (const image of container?.querySelectorAll?.('img[data-sprite-src]') ?? []) {
    const source = image.dataset.spriteSrc;
    if (cachedTrimmedImage(source)) continue;
    const trim = () => trimPngAlpha(image).then(result => {
      if (result && image.isConnected && image.dataset.spriteSrc === source) image.src = result;
    });
    if (image.complete && image.naturalWidth) void trim();
    else image.addEventListener('load', trim, { once: true });
  }
}

/* -------------------------------------------- */
/*  Bounding box                                */
/* -------------------------------------------- */
function opaqueBounds(pixels, width, height) {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(((y * width) + x) * 4) + 3] === 0) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  return bottom < 0 ? null : { top, bottom, left, right };
}

function cropToDataUrl(source, bounds) {
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const target = Object.assign(globalThis.document.createElement('canvas'), { width, height });
  target.getContext('2d').drawImage(source, bounds.left, bounds.top, width, height, 0, 0, width, height);
  return target.toDataURL('image/png');
}
