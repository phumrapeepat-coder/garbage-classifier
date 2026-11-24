"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const FR = require("../src/garbage_web/static/file_rules.js");

const MB = 1024 * 1024;

test("accepts JPEG, PNG and WebP by MIME type", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    const r = FR.checkFile({ size: 1000, type, name: "x" });
    assert.equal(r.ok, true, type);
    assert.equal(r.isHeic, false);
  }
});

test("accepts HEIC/HEIF by MIME type and flags it", () => {
  for (const type of ["image/heic", "image/heif"]) {
    const r = FR.checkFile({ size: 1000, type, name: "IMG_1.HEIC" });
    assert.equal(r.ok, true);
    assert.equal(r.isHeic, true);
  }
});

test("empty MIME type falls back to the extension (Chrome/Firefox report '' for .heic)", () => {
  assert.deepEqual(FR.checkFile({ size: 5, type: "", name: "IMG_0001.HEIC" }), { ok: true, reason: "", isHeic: true });
  assert.equal(FR.checkFile({ size: 5, type: "", name: "a.heif" }).isHeic, true);
  assert.equal(FR.checkFile({ size: 5, type: "", name: "a.JPG" }).ok, true);
  assert.equal(FR.checkFile({ size: 5, type: "application/octet-stream", name: "a.webp" }).ok, true);
  assert.equal(FR.checkFile({ size: 5, type: "", name: "a.JPEG" }).isHeic, false);
});

test("an unknown extension with an empty type is rejected", () => {
  const r = FR.checkFile({ size: 5, type: "", name: "notes.txt" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /JPEG, PNG, WebP or HEIC/);
  assert.equal(FR.checkFile({ size: 5, type: "", name: "noextension" }).ok, false);
});

test("a wrong MIME type is rejected even if the extension looks fine", () => {
  assert.equal(FR.checkFile({ size: 5, type: "image/gif", name: "a.jpg" }).ok, false);
  assert.equal(FR.checkFile({ size: 5, type: "text/plain", name: "a.png" }).ok, false);
});

test("size limit is exactly 8 MiB", () => {
  assert.equal(FR.MAX_BYTES, 8 * MB);
  assert.equal(FR.checkFile({ size: 8 * MB, type: "image/jpeg", name: "a.jpg" }).ok, true);
  const over = FR.checkFile({ size: 8 * MB + 1, type: "image/jpeg", name: "a.jpg" });
  assert.equal(over.ok, false);
  assert.match(over.reason, /8 MB/);
});

test("empty and malformed input is rejected without throwing", () => {
  assert.equal(FR.checkFile({ size: 0, type: "image/png", name: "a.png" }).ok, false);
  assert.equal(FR.checkFile(null).ok, false);
  assert.equal(FR.checkFile({}).ok, false);
  assert.equal(FR.checkFile({ size: 5, type: null, name: null }).ok, false);
});

test("extensionOf", () => {
  assert.equal(FR.extensionOf("a.b.HEIC"), "heic");
  assert.equal(FR.extensionOf("none"), "");
  assert.equal(FR.extensionOf(5), "");
});
