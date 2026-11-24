"use strict";
/*
 * Pure helpers for choosing a camera and capturing a still photo. No DOM, no timers, no storage, no network:
 * the browser loads it with a <script> tag (exposes `CameraHelpers`) and Node loads it with require() for tests.
 * app.js does every browser call (enumerateDevices, getUserMedia, canvas); this file only decides WHAT to ask for
 * and HOW to word what came back, so those decisions can be unit-tested without a camera.
 * (Adapted from garbage-classifier-web/static/camera_helpers.js; only the wording of the hints changed.)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CameraHelpers = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const REQUEST_WIDTH = 1920; // a request, not a promise: the browser may give less and never upscales
  const REQUEST_HEIGHT = 1080;
  const CAPTURE_JPEG_QUALITY = 0.95; // >= 0.92 as required; still a JPEG well under the 8 MB upload limit in practice

  const PERMISSION_HINT =
    "Camera names are hidden until you allow camera access. Press Use camera once and allow it, " +
    "then press Refresh cameras to see the full list.";
  const NONE_LISTED_HINT =
    "The browser does not list any camera right now. Connect or wake the camera, then press Refresh cameras. " +
    "Press Use camera once if the browser still asks for permission.";
  const MISSING_SELECTED_HINT =
    "The selected camera is not available. Reconnect it, press Refresh cameras, or select another camera.";
  const SUPPORT_MESSAGE =
    "The camera needs a secure page (https:// or http://localhost) and a browser that supports it. " +
    "Upload an image instead.";

  const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

  /** Selected deviceId, or "" for Default. Anything that is not a non-empty string means Default. */
  const normaliseId = (deviceId) => (isNonEmptyString(deviceId) ? deviceId : "");

  /**
   * enumerateDevices() result -> options for the dropdown.
   * Only videoinput devices. Before permission browsers often return empty labels: we then use neutral
   * "Camera N" names (never a guessed product name) and return a hint explaining how to reveal the real names.
   * Entries without a deviceId cannot be selected, so they are skipped (but still count as "labels hidden").
   */
  function buildDeviceList(devices) {
    const inputs = Array.isArray(devices)
      ? devices.filter((d) => d && typeof d === "object" && d.kind === "videoinput")
      : [];
    const labelsHidden = inputs.some((d) => !isNonEmptyString(d.label));
    const options = [];
    inputs.forEach((d) => {
      if (!isNonEmptyString(d.deviceId)) return;
      options.push({
        deviceId: d.deviceId,
        label: isNonEmptyString(d.label) ? d.label : "Camera " + (options.length + 1),
      });
    });
    let hint = null;
    if (labelsHidden) hint = PERMISSION_HINT;
    else if (options.length === 0) hint = NONE_LISTED_HINT;
    return { options, labelsHidden, hint };
  }

  /** getUserMedia constraints. A chosen device is EXACT (never swapped silently); Default keeps facingMode. */
  function buildConstraints(deviceId) {
    const id = normaliseId(deviceId);
    const size = { width: { ideal: REQUEST_WIDTH }, height: { ideal: REQUEST_HEIGHT } };
    const video = id
      ? { deviceId: { exact: id }, ...size }
      : { ...size, facingMode: { ideal: "environment" } };
    return { video, audio: false }; // never the microphone
  }

  /** Same device, resolution request dropped. Used once after an OverconstrainedError about the size. */
  function buildFallbackConstraints(deviceId) {
    const id = normaliseId(deviceId);
    const video = id ? { deviceId: { exact: id } } : { facingMode: { ideal: "environment" } };
    return { video, audio: false };
  }

  /**
   * Should startCamera retry once with relaxed resolution?
   * Yes only for an OverconstrainedError that is not about the deviceId itself, and only once.
   * An error about the deviceId means the chosen camera is gone: retrying cannot help and must not pick another.
   */
  function shouldRelaxResolution(err, deviceId, alreadyRelaxed) {
    if (alreadyRelaxed || !err || err.name !== "OverconstrainedError") return false;
    return err.constraint !== "deviceId";
  }

  /** Words for a failed getUserMedia. `deviceId` tells us whether a specific camera was requested. */
  function cameraErrorMessage(err, deviceId) {
    const name = err && err.name;
    const selected = normaliseId(deviceId) !== "";
    switch (name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera permission was denied. Allow camera access in your browser, or upload an image instead.";
      case "NotFoundError":
      case "OverconstrainedError":
        return selected
          ? "The selected camera was not found. Reconnect it, press Refresh cameras, or select another camera."
          : "No camera was found on this device. You can upload an image instead.";
      case "NotReadableError":
        return "The camera is busy or unavailable (another app may be using it).";
      default:
        return "Could not start the camera. You can upload an image instead.";
    }
  }

  /** null when the page can ask for a camera, otherwise the message to show. */
  function supportMessage(env) {
    const e = env || {};
    if (e.isSecureContext !== true) return SUPPORT_MESSAGE;
    if (!e.mediaDevices || typeof e.mediaDevices.getUserMedia !== "function") return SUPPORT_MESSAGE;
    return null;
  }

  /** "HD" wording only when the ACTUAL frame supports it (orientation-independent). */
  function qualityTag(width, height) {
    if (!(width > 0 && height > 0)) return "";
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    if (long >= 1920 && short >= 1080) return "Full HD";
    if (long >= 1280 && short >= 720) return "HD";
    return "";
  }

  /** One line for the info area: source, ACTUAL size, and an honest note that the request is not a promise. */
  function formatResolution(info) {
    const i = info || {};
    const source = isNonEmptyString(i.sourceLabel) ? i.sourceLabel : "Default camera";
    const note = "Higher resolution requested; actual depends on device/browser.";
    if (!(i.width > 0 && i.height > 0)) return "Source: " + source + ". Resolution not known yet. " + note;
    const tag = qualityTag(i.width, i.height);
    return "Source: " + source + ". Actual: " + i.width + " x " + i.height + " px" + (tag ? " (" + tag + ")" : "") + ". " + note;
  }

  /** Canvas size for a capture = the video's native size. null while there is no frame. No scaling either way. */
  function captureSize(videoWidth, videoHeight) {
    const ok = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
    if (!ok(videoWidth) || !ok(videoHeight)) return null;
    return { width: videoWidth, height: videoHeight };
  }

  /** Vertical frame shape (width / height). 3:4 keeps more sensor pixels than 9:16 from a 16:9 feed. */
  const PORTRAIT_RATIO = 3 / 4;

  /** True when the OS names the source as an iPhone (Continuity Camera), e.g. "Phum's iPhone Camera". */
  function isIPhoneLabel(label) {
    return isNonEmptyString(label) && /iphone/i.test(label);
  }

  /**
   * Part of the video frame that Capture keeps, in video pixels.
   * Not vertical (or the feed is already at least as tall as the ratio): the whole frame.
   * Vertical: the full height and a centred slice whose width = height x ratio, matching the CSS
   * object-fit: cover preview (object-position is the default centre).
   */
  function frameRect(videoWidth, videoHeight, vertical, ratio = PORTRAIT_RATIO) {
    const size = captureSize(videoWidth, videoHeight);
    if (!size) return null;
    const { width: w, height: h } = size;
    if (!vertical || w / h <= ratio) return { x: 0, y: 0, width: w, height: h };
    const cw = Math.max(1, Math.round(h * ratio));
    return { x: Math.floor((w - cw) / 2), y: 0, width: cw, height: h };
  }

  /**
   * After a devicechange / refresh: rebuild the options and keep the user's choice honest.
   * A selected camera that vanished stays selected, marked "(unavailable)", with a hint. Nothing is retried
   * automatically (autoRetry is always false) and the selection never jumps to another camera.
   */
  function reconcileDevices(input) {
    const { devices, selectedId, selectedLabel } = input || {};
    const list = buildDeviceList(devices);
    const wanted = normaliseId(selectedId);
    const options = list.options.map((o) => ({ ...o, unavailable: false }));
    let selectedAvailable = true;
    let hint = list.hint;
    if (wanted && !options.some((o) => o.deviceId === wanted)) {
      selectedAvailable = false;
      const name = isNonEmptyString(selectedLabel) ? selectedLabel : "Selected camera";
      options.push({ deviceId: wanted, label: name + " (unavailable)", unavailable: true });
      hint = MISSING_SELECTED_HINT;
    }
    return { options, selectedId: wanted, selectedAvailable, hint, autoRetry: false };
  }

  return {
    REQUEST_WIDTH,
    REQUEST_HEIGHT,
    CAPTURE_JPEG_QUALITY,
    buildDeviceList,
    buildConstraints,
    buildFallbackConstraints,
    shouldRelaxResolution,
    cameraErrorMessage,
    supportMessage,
    qualityTag,
    formatResolution,
    captureSize,
    PORTRAIT_RATIO,
    isIPhoneLabel,
    frameRect,
    reconcileDevices,
  };
});
