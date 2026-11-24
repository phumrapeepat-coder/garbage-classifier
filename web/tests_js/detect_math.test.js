"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const DM = require("../src/garbage_web/static/detect_math.js");

test("scaleBoxes keeps order, scales and drops junk", () => {
  const out = DM.scaleBoxes(
    [{ x: 10, y: 20, width: 30, height: 40 }, { x: "a" }, null, { x: 0, y: 0, width: 0, height: 5 }],
    100, 100, 200, 50,
  );
  assert.deepEqual(out, [{ x: 20, y: 10, width: 60, height: 20 }]);
  assert.deepEqual(DM.scaleBoxes("nope", 1, 1, 1, 1), []);
  assert.deepEqual(DM.scaleBoxes([], 0, 1, 1, 1), []);
});

test("scaleBoxes clamps to the image and caps at 9", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ x: i, y: 0, width: 5, height: 5 }));
  assert.equal(DM.scaleBoxes(many, 100, 100, 100, 100).length, DM.MAX_PICK);
  const [b] = DM.scaleBoxes([{ x: 90, y: -5, width: 50, height: 20 }], 100, 100, 100, 100);
  assert.deepEqual(b, { x: 90, y: 0, width: 10, height: 15 });
});

test("paddedRect adds a margin and stays inside", () => {
  assert.deepEqual(DM.paddedRect({ x: 100, y: 100, width: 100, height: 50 }, 1000, 1000), { x: 88, y: 92, width: 124, height: 66 });
  assert.deepEqual(DM.paddedRect({ x: 0, y: 0, width: 50, height: 50 }, 55, 60), { x: 0, y: 0, width: 55, height: 58 });
  assert.equal(DM.paddedRect(null, 10, 10), null);
});

test("toPercent", () => {
  assert.deepEqual(DM.toPercent({ x: 50, y: 25, width: 100, height: 50 }, 200, 100), { left: 25, top: 25, width: 50, height: 50 });
});

test("keyToIndex", () => {
  assert.equal(DM.keyToIndex("1", 3), 0);
  assert.equal(DM.keyToIndex("3", 3), 2);
  assert.equal(DM.keyToIndex("4", 3), -1);
  assert.equal(DM.keyToIndex("0", 3), -1);
  assert.equal(DM.keyToIndex("a", 3), -1);
  assert.equal(DM.keyToIndex("12", 20), -1);
});

test("colors and messages", () => {
  assert.equal(DM.colorFor(0), DM.colorFor(DM.COLORS.length));
  assert.match(DM.foundMessage(0), /No object/);
  assert.match(DM.foundMessage(1), /1 object.*press 1/);
  assert.match(DM.foundMessage(3), /3 objects/);
});
