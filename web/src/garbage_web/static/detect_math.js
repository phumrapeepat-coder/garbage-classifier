"use strict";
/*
 * Pure helpers for the pick-an-object step. No DOM: the browser loads it with a <script> tag (exposes
 * `DetectMath`) and Node loads it with require() for tests. Units: "natural" = pixels of the photo as the
 * browser shows it (EXIF applied), the same units as CropMath.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DetectMath = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PAD_FRAC = 0.12; // margin added around a detected object before cropping (12% of its size per side)
  const MIN_PAD_PX = 8;
  const MAX_PICK = 9; // keys 1-9
  // Distinct, readable on photos; index = object number - 1 (wraps around).
  const COLORS = ["#ff3b30", "#0a84ff", "#34c759", "#ff9f0a", "#af52de", "#00c7be", "#ff2d55", "#ffd60a", "#5e5ce6"];

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const finite = (...vals) => vals.every((v) => typeof v === "number" && Number.isFinite(v));

  /**
   * Server boxes (in the server's decoded size) -> natural-pixel rects of the image the page shows.
   * Normally both sizes are equal; scaling keeps the boxes right if a browser decodes at another size.
   * Invalid or empty boxes are dropped; the order is kept (the server numbers them left to right).
   */
  function scaleBoxes(objects, fromW, fromH, toW, toH) {
    if (!Array.isArray(objects) || !finite(fromW, fromH, toW, toH) || fromW <= 0 || fromH <= 0 || toW <= 0 || toH <= 0) {
      return [];
    }
    const sx = toW / fromW;
    const sy = toH / fromH;
    const out = [];
    for (const o of objects) {
      if (!o || !finite(o.x, o.y, o.width, o.height)) continue;
      const x = clamp(o.x * sx, 0, toW);
      const y = clamp(o.y * sy, 0, toH);
      const right = clamp((o.x + o.width) * sx, 0, toW);
      const bottom = clamp((o.y + o.height) * sy, 0, toH);
      if (right - x < 1 || bottom - y < 1) continue;
      out.push({ x, y, width: right - x, height: bottom - y });
    }
    return out.slice(0, MAX_PICK);
  }

  /** The crop that goes to the model: the object plus a margin, whole pixels, inside the image. */
  function paddedRect(box, imgW, imgH, padFrac = PAD_FRAC, minPad = MIN_PAD_PX) {
    if (!box || !finite(box.x, box.y, box.width, box.height, imgW, imgH) || imgW <= 0 || imgH <= 0) return null;
    const px = Math.max(minPad, box.width * padFrac);
    const py = Math.max(minPad, box.height * padFrac);
    const x = clamp(Math.floor(box.x - px), 0, imgW);
    const y = clamp(Math.floor(box.y - py), 0, imgH);
    const right = clamp(Math.ceil(box.x + box.width + px), x, imgW);
    const bottom = clamp(Math.ceil(box.y + box.height + py), y, imgH);
    return { x, y, width: right - x, height: bottom - y };
  }

  /** Natural rect -> CSS percentages of the drawn image (so the overlay needs no re-layout when it resizes). */
  function toPercent(box, imgW, imgH) {
    return {
      left: (box.x / imgW) * 100,
      top: (box.y / imgH) * 100,
      width: (box.width / imgW) * 100,
      height: (box.height / imgH) * 100,
    };
  }

  /** "1".."9" -> object index when that object exists, else -1. */
  function keyToIndex(key, count) {
    if (typeof key !== "string" || !/^[1-9]$/.test(key)) return -1;
    const i = Number(key) - 1;
    return i < count ? i : -1;
  }

  function colorFor(index) {
    return COLORS[((index % COLORS.length) + COLORS.length) % COLORS.length];
  }

  /** Status line after detection. */
  function foundMessage(count) {
    if (count === 0) {
      return "No object found. Put the object on a plain surface, or crop by hand, or classify the whole photo.";
    }
    if (count === 1) return "Found 1 object. Click it (or press 1) to classify it.";
    return "Found " + count + " objects. Click one (or press its number) to classify it.";
  }

  return { PAD_FRAC, MIN_PAD_PX, MAX_PICK, COLORS, scaleBoxes, paddedRect, toPercent, keyToIndex, colorFor, foundMessage };
});
