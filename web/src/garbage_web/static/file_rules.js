"use strict";
/*
 * Pure upload checks (no DOM): the browser loads it with a <script> tag (exposes `FileRules`) and Node loads it
 * with require() for tests. These are a convenience so the user gets an instant message; the server stays the authority.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FileRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_BYTES = 8 * 1024 * 1024;
  const BROWSER_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const HEIC_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
  const EXT_TO_KIND = { jpg: "image", jpeg: "image", png: "image", webp: "image", heic: "heic", heif: "heic" };

  const UNSUPPORTED = "Please choose a JPEG, PNG, WebP or HEIC image.";

  function extensionOf(name) {
    if (typeof name !== "string") return "";
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  }

  /**
   * file: {size, type, name}. Returns {ok, reason, isHeic}.
   * HEIC is accepted (the server decodes it). Browsers often report an empty MIME type for .heic files,
   * so an empty/generic type falls back to the file extension.
   */
  function checkFile(file) {
    const f = file || {};
    if (!(typeof f.size === "number" && f.size > 0)) return { ok: false, reason: "That file is empty.", isHeic: false };
    if (f.size > MAX_BYTES) return { ok: false, reason: "That file is over 8 MB. Please choose a smaller one.", isHeic: false };
    const type = typeof f.type === "string" ? f.type.toLowerCase() : "";
    if (BROWSER_TYPES.includes(type)) return { ok: true, reason: "", isHeic: false };
    if (HEIC_TYPES.includes(type)) return { ok: true, reason: "", isHeic: true };
    if (type === "" || type === "application/octet-stream") {
      const kind = EXT_TO_KIND[extensionOf(f.name)];
      if (kind) return { ok: true, reason: "", isHeic: kind === "heic" };
    }
    return { ok: false, reason: UNSUPPORTED, isHeic: false };
  }

  return { MAX_BYTES, checkFile, extensionOf };
});
