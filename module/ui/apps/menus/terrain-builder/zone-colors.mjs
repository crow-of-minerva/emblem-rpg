/** @layer ui/apps/menus/terrain-builder */

/* -------------------------------------------- */
/*  Zone outline colours                        */
/* -------------------------------------------- */

/** The outline colour a scene's first zone gets, and the one a zone that stores none is drawn in. */
export const DEFAULT_ZONE_COLOR = '#ffd24a';

/**
 * The outline colours a new zone may be given: a saturated hue wheel in three lightness bands. Every one reads as a
 * dashed outline on a battle map, so the pick only has to worry about telling zones apart.
 * @type {ReadonlyArray<string>}
 */
const CANDIDATE_COLORS = Object.freeze(
  [60, 50, 75].flatMap(lightness => Array.from({ length: 24 }, (_, step) => hslHex(step * 15, 90, lightness))));

/**
 * The outline colour for a new zone: the candidate farthest from every colour the scene's zones already use.
 *
 * Distance is measured in OKLab, where equal steps look equally different, and the candidate whose nearest used colour
 * is farthest away wins. A scene with no zones gets `DEFAULT_ZONE_COLOR`, and ties go to the earlier candidate so the
 * same scene always suggests the same colour.
 * @param {Iterable<string>} usedColors The `#rrggbb` colours already on the scene; anything unreadable is skipped.
 * @returns {string} A lowercase `#rrggbb` colour.
 */
export function nextZoneColor(usedColors) {
  const used = [...usedColors].map(hexToOklab).filter(Boolean);
  if (used.length === 0) return DEFAULT_ZONE_COLOR;
  let best = DEFAULT_ZONE_COLOR;
  let bestDistance = -1;
  for (const candidate of CANDIDATE_COLORS) {
    const lab = hexToOklab(candidate);
    const nearest = Math.min(...used.map(other => oklabDistance(lab, other)));
    if (nearest > bestDistance) {
      best = candidate;
      bestDistance = nearest;
    }
  }
  return best;
}

/* -------------------------------------------- */
/*  Colour maths                                */
/* -------------------------------------------- */

/** An HSL colour, hue in degrees and the rest in percent, as a lowercase `#rrggbb` string. */
function hslHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = n => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * A `#rrggbb` colour in OKLab, or null when the text is not one.
 * @param {string} hex
 * @returns {[number, number, number] | null}
 */
function hexToOklab(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!match) return null;
  const packed = Number.parseInt(match[1], 16);
  const [r, g, b] = [packed >> 16, (packed >> 8) & 0xff, packed & 0xff].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ];
}

/** One 0 to 255 sRGB channel as linear light. */
function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The straight-line distance between two OKLab colours. */
function oklabDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
