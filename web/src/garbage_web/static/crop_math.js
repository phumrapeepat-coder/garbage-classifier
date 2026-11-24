"use strict";
/*
 * Pure crop geometry. No DOM, no globals: the browser loads it with a <script> tag (exposes `CropMath`)
 * and Node loads it with require() for tests. Units: "natural" = pixels of the full source image
 * (after EXIF rotation, as the browser decodes it); "display" = CSS pixels inside the <img> element box.
 * (Adapted from garbage-classifier-web/static/crop_math.js.)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CropMath = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MIN_CROP_PX = 32; // smaller crops are mostly noise once the model resizes them to 224x224

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const finite = (...vals) => vals.every((v) => typeof v === "number" && Number.isFinite(v));

  /** Smallest allowed crop side; never larger than the image itself (tiny images can still be used whole). */
  function minCropSize(imgW, imgH, min = MIN_CROP_PX) {
    return Math.max(1, Math.min(min, imgW, imgH));
  }

  function fullRect(imgW, imgH) {
    return { x: 0, y: 0, width: imgW, height: imgH };
  }

  function isFullImage(rect, imgW, imgH) {
    return rect.x === 0 && rect.y === 0 && rect.width === imgW && rect.height === imgH;
  }

  /**
   * Where `object-fit: contain` draws a natW x natH image inside a boxW x boxH element.
   * Returns the drawn area in box coordinates plus the natural->display scale, or null for bad sizes.
   */
  function containRect(boxW, boxH, natW, natH) {
    if (!finite(boxW, boxH, natW, natH) || boxW <= 0 || boxH <= 0 || natW <= 0 || natH <= 0) return null;
    const scale = Math.min(boxW / natW, boxH / natH);
    const width = natW * scale;
    const height = natH * scale;
    return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height, scale };
  }

  /** Box-relative display point -> natural pixel point. Points in the letterbox bars clamp to the image edge. */
  function displayToNatural(point, content, natW, natH) {
    return {
      x: clamp((point.x - content.x) / content.scale, 0, natW),
      y: clamp((point.y - content.y) / content.scale, 0, natH),
    };
  }

  /** Natural-pixel rect -> box-relative display rect (used to draw the selection after a resize). */
  function naturalToDisplay(rect, content) {
    return {
      x: content.x + rect.x * content.scale,
      y: content.y + rect.y * content.scale,
      width: rect.width * content.scale,
      height: rect.height * content.scale,
    };
  }

  /** Two corner points in any drag direction -> rect with positive width/height. */
  function normalizeRect(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  /** Force a rect fully inside the image with at least the minimum size. null if any number is not finite. */
  function clampRect(rect, imgW, imgH, min = MIN_CROP_PX) {
    if (!rect || !finite(rect.x, rect.y, rect.width, rect.height)) return null;
    const m = minCropSize(imgW, imgH, min);
    const width = clamp(rect.width, m, imgW);
    const height = clamp(rect.height, m, imgH);
    return {
      x: clamp(rect.x, 0, imgW - width),
      y: clamp(rect.y, 0, imgH - height),
      width,
      height,
    };
  }

  // One axis of a drag: keep [anchor, point] but grow it to `m`, away from the anchor, or back toward it at a border.
  function dragAxis(anchor, point, m, max) {
    const a = clamp(anchor, 0, max);
    let p = clamp(point, 0, max);
    if (Math.abs(p - a) < m) {
      const dir = p >= a ? 1 : -1;
      p = a + dir * m;
      if (p < 0 || p > max) p = a - dir * m; // no room that way: grow the other way (always fits since m <= max)
    }
    return [Math.min(a, p), Math.abs(p - a)];
  }

  /** Draw-to-select and corner resize: a fixed anchor corner and a moving pointer, both in natural pixels. */
  function rectFromDrag(anchor, point, imgW, imgH, min = MIN_CROP_PX) {
    const m = minCropSize(imgW, imgH, min);
    const [x, width] = dragAxis(anchor.x, point.x, m, imgW);
    const [y, height] = dragAxis(anchor.y, point.y, m, imgH);
    return { x, y, width, height };
  }

  /** Move (do not resize) a rect by dx/dy natural pixels; it stops at the image borders. */
  function moveRect(rect, dx, dy, imgW, imgH) {
    return {
      x: clamp(rect.x + dx, 0, imgW - rect.width),
      y: clamp(rect.y + dy, 0, imgH - rect.height),
      width: rect.width,
      height: rect.height,
    };
  }

  /** Numeric inputs (strings or numbers) -> clamped rect. null for blank, non-numeric or negative sizes. */
  function rectFromFields(fields, imgW, imgH, min = MIN_CROP_PX) {
    const num = (v) => {
      if (typeof v === "string") {
        if (v.trim() === "") return NaN;
        return Number(v);
      }
      return typeof v === "number" ? v : NaN;
    };
    const rect = { x: num(fields.x), y: num(fields.y), width: num(fields.width), height: num(fields.height) };
    if (!finite(rect.x, rect.y, rect.width, rect.height) || rect.width < 0 || rect.height < 0) return null;
    return clampRect(rect, imgW, imgH, min);
  }

  /** Whole-pixel rect that is guaranteed to stay inside the image (what the canvas will really copy). */
  function toIntRect(rect, imgW, imgH, min = MIN_CROP_PX) {
    const c = clampRect(rect, imgW, imgH, min);
    if (!c) return null;
    const x = clamp(Math.round(c.x), 0, imgW);
    const y = clamp(Math.round(c.y), 0, imgH);
    const right = clamp(Math.round(c.x + c.width), x, imgW);
    const bottom = clamp(Math.round(c.y + c.height), y, imgH);
    return { x, y, width: right - x, height: bottom - y };
  }

  /** Final gate before cutting pixels. Returns {ok, reason} with a user-readable reason when not ok. */
  function validateRect(rect, imgW, imgH, min = MIN_CROP_PX) {
    if (!rect || !finite(rect.x, rect.y, rect.width, rect.height)) {
      return { ok: false, reason: "The selection is not valid." };
    }
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: "The selection is empty. Drag over the photo to select an area." };
    const m = minCropSize(imgW, imgH, min);
    if (rect.width < m || rect.height < m) {
      return { ok: false, reason: "The selection is too small. Use at least " + m + " x " + m + " pixels." };
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > imgW || rect.y + rect.height > imgH) {
      return { ok: false, reason: "The selection reaches outside the photo." };
    }
    return { ok: true, reason: "" };
  }

  return {
    MIN_CROP_PX,
    minCropSize,
    fullRect,
    isFullImage,
    containRect,
    displayToNatural,
    naturalToDisplay,
    normalizeRect,
    clampRect,
    rectFromDrag,
    moveRect,
    rectFromFields,
    toIntRect,
    validateRect,
  };
});
