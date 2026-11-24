"use strict";
// Pure geometry tests. Run: node --test tests_js/   (Node built-ins only)
// Adapted from garbage-classifier-web/tests/js/crop_math.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const CM = require("../src/garbage_web/static/crop_math.js");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---- containRect: object-fit: contain letterboxing -------------------------------------------
test("containRect: wide image in a square box is letterboxed top/bottom", () => {
  const r = CM.containRect(400, 400, 800, 400);
  assert.deepEqual([r.x, r.y, r.width, r.height], [0, 100, 400, 200]);
  near(r.scale, 0.5);
});

test("containRect: tall image in a wide box is pillarboxed left/right", () => {
  const r = CM.containRect(600, 300, 100, 300);
  assert.deepEqual([r.x, r.y, r.width, r.height], [250, 0, 100, 300]);
  near(r.scale, 1);
});

test("containRect: exact-fit has no bars; invalid sizes give null", () => {
  assert.deepEqual(
    (({ x, y, width, height }) => [x, y, width, height])(CM.containRect(200, 100, 400, 200)),
    [0, 0, 200, 100],
  );
  assert.equal(CM.containRect(0, 100, 400, 200), null);
  assert.equal(CM.containRect(100, 100, 0, 200), null);
  assert.equal(CM.containRect(NaN, 100, 10, 10), null);
});

// ---- display <-> natural mapping --------------------------------------------------------------
test("displayToNatural maps through the letterbox offset and scale", () => {
  const c = CM.containRect(400, 400, 800, 400); // content at y=100, scale .5
  assert.deepEqual(CM.displayToNatural({ x: 200, y: 200 }, c, 800, 400), { x: 400, y: 200 });
  assert.deepEqual(CM.displayToNatural({ x: 0, y: 100 }, c, 800, 400), { x: 0, y: 0 });
  assert.deepEqual(CM.displayToNatural({ x: 400, y: 300 }, c, 800, 400), { x: 800, y: 400 });
});

test("displayToNatural clamps points in the letterbox bars to the image edge", () => {
  const c = CM.containRect(400, 400, 800, 400);
  assert.deepEqual(CM.displayToNatural({ x: -50, y: 0 }, c, 800, 400), { x: 0, y: 0 });
  assert.deepEqual(CM.displayToNatural({ x: 999, y: 999 }, c, 800, 400), { x: 800, y: 400 });
});

test("naturalToDisplay is the inverse of displayToNatural (resize safe)", () => {
  for (const [bw, bh] of [[400, 400], [333, 777], [1200, 200]]) {
    const c = CM.containRect(bw, bh, 1600, 1200);
    const rect = { x: 160, y: 120, width: 800, height: 600 };
    const d = CM.naturalToDisplay(rect, c, 1600, 1200);
    const back = CM.displayToNatural({ x: d.x, y: d.y }, c, 1600, 1200);
    near(back.x, rect.x, 1e-6);
    near(back.y, rect.y, 1e-6);
    near(d.width / c.scale, rect.width, 1e-6);
  }
});

// ---- normalizeRect: any drag direction --------------------------------------------------------
test("normalizeRect works for all four drag directions", () => {
  const want = { x: 10, y: 20, width: 30, height: 40 };
  assert.deepEqual(CM.normalizeRect({ x: 10, y: 20 }, { x: 40, y: 60 }), want); // down-right
  assert.deepEqual(CM.normalizeRect({ x: 40, y: 60 }, { x: 10, y: 20 }), want); // up-left
  assert.deepEqual(CM.normalizeRect({ x: 40, y: 20 }, { x: 10, y: 60 }), want); // down-left
  assert.deepEqual(CM.normalizeRect({ x: 10, y: 60 }, { x: 40, y: 20 }), want); // up-right
});

// ---- minimum size / clamping ------------------------------------------------------------------
test("minCropSize never exceeds the image itself", () => {
  assert.equal(CM.minCropSize(1000, 800), CM.MIN_CROP_PX);
  assert.equal(CM.minCropSize(20, 800), 20);
  assert.equal(CM.minCropSize(800, 10), 10);
});

test("clampRect pulls an out-of-bounds rect back inside without resizing when it fits", () => {
  assert.deepEqual(CM.clampRect({ x: -20, y: 950, width: 100, height: 100 }, 1000, 1000),
    { x: 0, y: 900, width: 100, height: 100 });
  assert.deepEqual(CM.clampRect({ x: 950, y: 0, width: 100, height: 100 }, 1000, 1000),
    { x: 900, y: 0, width: 100, height: 100 });
});

test("clampRect caps oversized rects to the image and raises too-small ones to the minimum", () => {
  assert.deepEqual(CM.clampRect({ x: 5, y: 5, width: 5000, height: 5000 }, 640, 480),
    { x: 0, y: 0, width: 640, height: 480 });
  const small = CM.clampRect({ x: 995, y: 995, width: 1, height: 0 }, 1000, 1000);
  assert.equal(small.width, CM.MIN_CROP_PX);
  assert.equal(small.height, CM.MIN_CROP_PX);
  assert.ok(small.x + small.width <= 1000 && small.y + small.height <= 1000);
});

test("clampRect rejects non-finite input", () => {
  assert.equal(CM.clampRect({ x: NaN, y: 0, width: 50, height: 50 }, 100, 100), null);
  assert.equal(CM.clampRect({ x: 0, y: 0, width: Infinity, height: 50 }, 100, 100), null);
});

// ---- rectFromDrag (draw-to-select and corner resize) -----------------------------------------
test("rectFromDrag clamps the pointer to the image and normalizes the direction", () => {
  const r = CM.rectFromDrag({ x: 500, y: 500 }, { x: -300, y: 2000 }, 1000, 800);
  assert.deepEqual(r, { x: 0, y: 500, width: 500, height: 300 });
});

test("rectFromDrag enforces the minimum size by growing away from the anchor", () => {
  const r = CM.rectFromDrag({ x: 100, y: 100 }, { x: 102, y: 90 }, 1000, 1000);
  assert.equal(r.width, CM.MIN_CROP_PX);
  assert.equal(r.height, CM.MIN_CROP_PX);
  assert.equal(r.x, 100); // dragged right slightly -> grows right
  assert.equal(r.y, 100 - CM.MIN_CROP_PX); // dragged up -> grows up
});

test("rectFromDrag flips the growth direction when the anchor sits on the border", () => {
  const r = CM.rectFromDrag({ x: 1000, y: 1000 }, { x: 1000, y: 1000 }, 1000, 1000);
  assert.deepEqual(r, { x: 1000 - CM.MIN_CROP_PX, y: 1000 - CM.MIN_CROP_PX, width: CM.MIN_CROP_PX, height: CM.MIN_CROP_PX });
});

// ---- moveRect ---------------------------------------------------------------------------------
test("moveRect shifts the rect but stops at every border", () => {
  const r = { x: 100, y: 100, width: 200, height: 100 };
  assert.deepEqual(CM.moveRect(r, 50, -20, 1000, 500), { x: 150, y: 80, width: 200, height: 100 });
  assert.deepEqual(CM.moveRect(r, -999, -999, 1000, 500), { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(CM.moveRect(r, 9999, 9999, 1000, 500), { x: 800, y: 400, width: 200, height: 100 });
});

// ---- rectFromFields (numeric / keyboard alternative) ------------------------------------------
test("rectFromFields accepts numeric strings and clamps them", () => {
  assert.deepEqual(CM.rectFromFields({ x: "10", y: "20", width: "300", height: "200" }, 1000, 800),
    { x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(CM.rectFromFields({ x: 900, y: 700, width: 500, height: 500 }, 1000, 800),
    { x: 500, y: 300, width: 500, height: 500 }); // pushed back inside: 500+500=1000, 300+500=800
});

test("rectFromFields returns null for blank, non-numeric or negative size input", () => {
  assert.equal(CM.rectFromFields({ x: "", y: "0", width: "50", height: "50" }, 1000, 800), null);
  assert.equal(CM.rectFromFields({ x: "abc", y: "0", width: "50", height: "50" }, 1000, 800), null);
  assert.equal(CM.rectFromFields({ x: "0", y: "0", width: "-5", height: "50" }, 1000, 800), null);
});

// ---- toIntRect / validateRect / isFullImage ---------------------------------------------------
test("toIntRect gives whole pixels that stay inside the image", () => {
  const r = CM.toIntRect({ x: 10.6, y: 0.2, width: 99.7, height: 50.4 }, 1000, 800);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.width) && Number.isInteger(r.height));
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1000 && r.y + r.height <= 800);
  const edge = CM.toIntRect({ x: 999.9, y: 799.9, width: 50, height: 50 }, 1000, 800);
  assert.ok(edge.x + edge.width <= 1000 && edge.y + edge.height <= 800);
});

test("validateRect: ok for a normal crop; reasons for zero, tiny and out-of-bounds", () => {
  assert.equal(CM.validateRect({ x: 10, y: 10, width: 100, height: 100 }, 1000, 800).ok, true);
  assert.equal(CM.validateRect({ x: 10, y: 10, width: 0, height: 100 }, 1000, 800).ok, false);
  assert.equal(CM.validateRect({ x: 10, y: 10, width: CM.MIN_CROP_PX - 1, height: 100 }, 1000, 800).ok, false);
  assert.equal(CM.validateRect({ x: -1, y: 0, width: 100, height: 100 }, 1000, 800).ok, false);
  assert.equal(CM.validateRect({ x: 950, y: 0, width: 100, height: 100 }, 1000, 800).ok, false);
  assert.equal(CM.validateRect({ x: 0, y: 0, width: NaN, height: 100 }, 1000, 800).ok, false);
  assert.equal(CM.validateRect(null, 1000, 800).ok, false);
  assert.ok(CM.validateRect({ x: 0, y: 0, width: 0, height: 0 }, 1000, 800).reason.length > 0);
});

test("validateRect on a tiny image uses the image size as the minimum", () => {
  assert.equal(CM.validateRect({ x: 0, y: 0, width: 20, height: 20 }, 20, 20).ok, true);
});

test("isFullImage and fullRect", () => {
  assert.deepEqual(CM.fullRect(640, 480), { x: 0, y: 0, width: 640, height: 480 });
  assert.equal(CM.isFullImage({ x: 0, y: 0, width: 640, height: 480 }, 640, 480), true);
  assert.equal(CM.isFullImage({ x: 1, y: 0, width: 639, height: 480 }, 640, 480), false);
});

// ---- repeated crop is always from the original -----------------------------------------------
test("a second crop uses ORIGINAL coordinates, not the first crop's", () => {
  const c = CM.containRect(500, 500, 1000, 1000);
  const second = CM.rectFromDrag(CM.displayToNatural({ x: 0, y: 0 }, c, 1000, 1000),
    CM.displayToNatural({ x: 500, y: 500 }, c, 1000, 1000), 1000, 1000);
  assert.deepEqual(second, CM.fullRect(1000, 1000));
});
