"use strict";
// Pure camera helper tests (SYNTHETIC device lists/errors, no real camera involved).
// Run: node --test tests_js/   (Node built-ins only). Adapted from garbage-classifier-web/tests/js.
const test = require("node:test");
const assert = require("node:assert/strict");
const CH = require("../src/garbage_web/static/camera_helpers.js");

const cam = (deviceId, label, kind = "videoinput") => ({ deviceId, label, kind });
const err = (name, extra = {}) => Object.assign(new Error(name), { name }, extra);

// ---- device list ---------------------------------------------------------------------------
test("buildDeviceList keeps only videoinput devices, with their OS labels", () => {
  const list = CH.buildDeviceList([
    cam("a", "FaceTime HD Camera"),
    cam("m", "Built-in Microphone", "audioinput"),
    cam("s", "Speakers", "audiooutput"),
    cam("b", "Desk View Camera"),
  ]);
  assert.deepEqual(list.options, [
    { deviceId: "a", label: "FaceTime HD Camera" },
    { deviceId: "b", label: "Desk View Camera" },
  ]);
  assert.equal(list.labelsHidden, false);
  assert.equal(list.hint, null);
});

test("buildDeviceList shows an iPhone entry only when the OS reports one", () => {
  const without = CH.buildDeviceList([cam("a", "FaceTime HD Camera")]);
  assert.ok(!without.options.some((o) => /iphone/i.test(o.label)));
  const withPhone = CH.buildDeviceList([cam("a", "FaceTime HD Camera"), cam("p", "My iPhone Camera")]);
  assert.ok(withPhone.options.some((o) => o.label === "My iPhone Camera"));
});

test("buildDeviceList: hidden labels give a permission hint and generic names, never a fake iPhone", () => {
  const list = CH.buildDeviceList([cam("a", ""), cam("b", "")]);
  assert.equal(list.labelsHidden, true);
  assert.deepEqual(list.options.map((o) => o.label), ["Camera 1", "Camera 2"]);
  assert.ok(!list.options.some((o) => /iphone/i.test(o.label)));
  assert.match(list.hint, /Use camera/);
  assert.match(list.hint, /allow/i);
  assert.ok(!/iphone/i.test(list.hint));
});

test("buildDeviceList: devices without an id cannot be selected, but still trigger the hint", () => {
  const list = CH.buildDeviceList([cam("", "")]);
  assert.deepEqual(list.options, []);
  assert.equal(list.labelsHidden, true);
  assert.ok(list.hint);
});

test("buildDeviceList: no cameras reported is worded as 'not listed', never 'definitely none'", () => {
  const list = CH.buildDeviceList([]);
  assert.deepEqual(list.options, []);
  assert.ok(list.hint);
  assert.ok(!/no camera exists|definitely/i.test(list.hint));
  assert.match(list.hint, /Refresh cameras/);
});

test("buildDeviceList tolerates garbage input", () => {
  assert.deepEqual(CH.buildDeviceList(null).options, []);
  assert.deepEqual(CH.buildDeviceList([null, {}, 5]).options, []);
});

// ---- constraints ---------------------------------------------------------------------------
test("buildConstraints: selected device -> exact deviceId + ideal 1920x1080, audio off", () => {
  assert.deepEqual(CH.buildConstraints("abc"), {
    video: { deviceId: { exact: "abc" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
});

test("buildConstraints: Default -> ideal resolution + facingMode environment", () => {
  const c = CH.buildConstraints("");
  assert.deepEqual(c, {
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: { ideal: "environment" } },
    audio: false,
  });
  assert.equal(c.video.deviceId, undefined);
  assert.deepEqual(CH.buildConstraints(null), c);
});

test("buildFallbackConstraints relaxes resolution but keeps the SAME exact deviceId", () => {
  const c = CH.buildFallbackConstraints("abc");
  assert.deepEqual(c, { video: { deviceId: { exact: "abc" } }, audio: false });
  assert.equal(c.video.width, undefined);
  assert.equal(c.video.height, undefined);
});

test("buildFallbackConstraints for Default keeps facingMode ideal environment, no resolution", () => {
  assert.deepEqual(CH.buildFallbackConstraints(""), { video: { facingMode: { ideal: "environment" } }, audio: false });
});

test("no constraint set ever asks for the microphone", () => {
  for (const id of ["", "x"]) {
    assert.equal(CH.buildConstraints(id).audio, false);
    assert.equal(CH.buildFallbackConstraints(id).audio, false);
  }
});

// ---- fallback decision ---------------------------------------------------------------------
test("shouldRelaxResolution: OverconstrainedError on width/height retries once, same device", () => {
  assert.equal(CH.shouldRelaxResolution(err("OverconstrainedError", { constraint: "width" }), "abc", false), true);
  assert.equal(CH.shouldRelaxResolution(err("OverconstrainedError"), "abc", false), true);
  assert.equal(CH.shouldRelaxResolution(err("OverconstrainedError"), "", false), true);
});

test("shouldRelaxResolution: never twice, never for a missing deviceId, never for other errors", () => {
  assert.equal(CH.shouldRelaxResolution(err("OverconstrainedError", { constraint: "width" }), "abc", true), false);
  assert.equal(CH.shouldRelaxResolution(err("OverconstrainedError", { constraint: "deviceId" }), "abc", false), false);
  assert.equal(CH.shouldRelaxResolution(err("NotAllowedError"), "abc", false), false);
  assert.equal(CH.shouldRelaxResolution(err("NotFoundError"), "abc", false), false);
  assert.equal(CH.shouldRelaxResolution(null, "abc", false), false);
});

// ---- error messages ------------------------------------------------------------------------
test("cameraErrorMessage: selected device missing -> reconnect / refresh / select another", () => {
  for (const e of [err("NotFoundError"), err("OverconstrainedError", { constraint: "deviceId" }), err("OverconstrainedError")]) {
    const m = CH.cameraErrorMessage(e, "abc");
    assert.match(m, /reconnect/i);
    assert.match(m, /Refresh cameras/);
    assert.match(m, /another/i);
  }
});

test("cameraErrorMessage: NotFound with the default camera", () => {
  assert.match(CH.cameraErrorMessage(err("NotFoundError"), ""), /No camera was found/);
});

test("cameraErrorMessage: permission, busy and unknown errors stay distinct and clear", () => {
  assert.match(CH.cameraErrorMessage(err("NotAllowedError"), "abc"), /permission was denied/i);
  assert.match(CH.cameraErrorMessage(err("SecurityError"), ""), /permission was denied/i);
  assert.match(CH.cameraErrorMessage(err("NotReadableError"), "abc"), /busy/i);
  assert.match(CH.cameraErrorMessage(err("AbortError"), ""), /Could not start the camera/);
  assert.match(CH.cameraErrorMessage(null, ""), /Could not start the camera/);
  const msgs = new Set(
    ["NotAllowedError", "NotFoundError", "NotReadableError", "WeirdError"].map((n) => CH.cameraErrorMessage(err(n), "")),
  );
  assert.equal(msgs.size, 4);
});

test("supportMessage: insecure context or missing API gives a clear message, otherwise null", () => {
  assert.match(CH.supportMessage({ isSecureContext: false, mediaDevices: { getUserMedia() {} } }), /localhost/);
  assert.match(CH.supportMessage({ isSecureContext: true, mediaDevices: undefined }), /secure page|not support/i);
  assert.match(CH.supportMessage({ isSecureContext: true, mediaDevices: {} }), /secure page|not support/i);
  assert.equal(CH.supportMessage({ isSecureContext: true, mediaDevices: { getUserMedia() {} } }), null);
});

// ---- resolution text -----------------------------------------------------------------------
test("qualityTag only names HD when the ACTUAL size supports it", () => {
  assert.equal(CH.qualityTag(1920, 1080), "Full HD");
  assert.equal(CH.qualityTag(1080, 1920), "Full HD"); // portrait phone stream
  assert.equal(CH.qualityTag(1280, 720), "HD");
  assert.equal(CH.qualityTag(640, 480), "");
  assert.equal(CH.qualityTag(1280, 480), "");
  assert.equal(CH.qualityTag(0, 0), "");
});

test("formatResolution shows actual size, source and the honest 'depends on device/browser' note", () => {
  const t = CH.formatResolution({ width: 640, height: 480, sourceLabel: "FaceTime HD Camera" });
  assert.match(t, /FaceTime HD Camera/);
  assert.match(t, /640 x 480 px/);
  assert.match(t, /higher resolution requested; actual depends on device\/browser/i);
  assert.ok(!/HD\)/.test(t)); // 640x480 is not HD (the camera name contains "HD" itself)
});

test("formatResolution names Full HD when 1920x1080 is real", () => {
  assert.match(CH.formatResolution({ width: 1920, height: 1080, sourceLabel: "X" }), /1920 x 1080 px \(Full HD\)/);
});

test("formatResolution without a frame size says it is not known yet", () => {
  const t = CH.formatResolution({ width: 0, height: 0, sourceLabel: "X" });
  assert.match(t, /not known yet/i);
  assert.ok(!/\d+ x \d+/.test(t)); // no invented numbers
});

test("formatResolution falls back to 'Default camera' when no label is known", () => {
  assert.match(CH.formatResolution({ width: 800, height: 600, sourceLabel: "" }), /Default camera/);
});

// ---- native capture sizing -----------------------------------------------------------------
test("captureSize uses the native video size: no downscale, no upscale", () => {
  assert.deepEqual(CH.captureSize(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(CH.captureSize(4032, 3024), { width: 4032, height: 3024 });
  assert.deepEqual(CH.captureSize(320, 240), { width: 320, height: 240 });
});

test("captureSize rejects a video with no frame yet", () => {
  assert.equal(CH.captureSize(0, 480), null);
  assert.equal(CH.captureSize(640, 0), null);
  assert.equal(CH.captureSize(NaN, 480), null);
  assert.equal(CH.captureSize(undefined, undefined), null);
});

test("JPEG capture quality is at least 0.92 and at most 1", () => {
  assert.ok(CH.CAPTURE_JPEG_QUALITY >= 0.92 && CH.CAPTURE_JPEG_QUALITY <= 1);
});

// ---- devicechange reconciliation -----------------------------------------------------------
test("reconcileDevices: selected device still present stays selected and available", () => {
  const r = CH.reconcileDevices({ devices: [cam("a", "A"), cam("b", "B")], selectedId: "b", selectedLabel: "B" });
  assert.equal(r.selectedId, "b");
  assert.equal(r.selectedAvailable, true);
  assert.equal(r.options.length, 2);
  assert.equal(r.hint, null);
  assert.ok(r.options.every((o) => !o.unavailable));
});

test("reconcileDevices: a selected device that disappeared stays selected but honestly unavailable", () => {
  const r = CH.reconcileDevices({ devices: [cam("a", "A")], selectedId: "p", selectedLabel: "My iPhone Camera" });
  assert.equal(r.selectedId, "p"); // not silently switched to another camera
  assert.equal(r.selectedAvailable, false);
  const ghost = r.options.find((o) => o.deviceId === "p");
  assert.ok(ghost);
  assert.equal(ghost.unavailable, true);
  assert.match(ghost.label, /unavailable/i);
  assert.match(ghost.label, /My iPhone Camera/);
  assert.match(r.hint, /reconnect/i);
  assert.equal(r.autoRetry, false); // never retries by itself
});

test("reconcileDevices: Default selection never becomes 'unavailable'", () => {
  const r = CH.reconcileDevices({ devices: [], selectedId: "", selectedLabel: "" });
  assert.equal(r.selectedId, "");
  assert.equal(r.selectedAvailable, true);
  assert.equal(r.autoRetry, false);
});

test("reconcileDevices: hidden labels keep the permission hint", () => {
  const r = CH.reconcileDevices({ devices: [cam("a", "")], selectedId: "", selectedLabel: "" });
  assert.match(r.hint, /Use camera/);
});

test("reconcileDevices: a device that comes back is available again (no stale 'unavailable')", () => {
  const r = CH.reconcileDevices({ devices: [cam("p", "My iPhone Camera")], selectedId: "p", selectedLabel: "old" });
  assert.equal(r.selectedAvailable, true);
  assert.equal(r.options.find((o) => o.deviceId === "p").label, "My iPhone Camera");
});

test("module exposes no localStorage/network helpers (pure)", () => {
  for (const name of Object.keys(CH)) assert.ok(!/storage|fetch|upload/i.test(name), name);
});

// ---- vertical frame (iPhone) ---------------------------------------------------------------
test("isIPhoneLabel spots Continuity Camera names only", () => {
  assert.equal(CH.isIPhoneLabel("Phum's iPhone Camera"), true);
  assert.equal(CH.isIPhoneLabel("IPHONE 15 PRO CAMERA"), true);
  assert.equal(CH.isIPhoneLabel("FaceTime HD Camera"), false);
  assert.equal(CH.isIPhoneLabel("Desk View Camera"), false);
  assert.equal(CH.isIPhoneLabel(""), false);
  assert.equal(CH.isIPhoneLabel(undefined), false);
});

test("frameRect keeps the whole frame when not vertical", () => {
  assert.deepEqual(CH.frameRect(1920, 1080, false), { x: 0, y: 0, width: 1920, height: 1080 });
});

test("frameRect cuts a centred 3:4 slice from a landscape feed", () => {
  const r = CH.frameRect(1920, 1080, true);
  assert.deepEqual(r, { x: 555, y: 0, width: 810, height: 1080 });
  assert.equal(r.x * 2 + r.width, 1920); // exactly centred
  assert.ok(Math.abs(r.width / r.height - 3 / 4) < 1e-9);
});

test("frameRect leaves an already-vertical feed alone and trims a square one", () => {
  assert.deepEqual(CH.frameRect(1080, 1920, true), { x: 0, y: 0, width: 1080, height: 1920 });
  assert.deepEqual(CH.frameRect(1000, 1000, true), { x: 125, y: 0, width: 750, height: 1000 });
});

test("frameRect returns null before the camera has a frame", () => {
  assert.equal(CH.frameRect(0, 0, true), null);
  assert.equal(CH.frameRect(NaN, 720, false), null);
});
