"use strict";
// Run: node --test tests_js/   (Node built-ins only)
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/garbage_web/static/decision.js");

const probs = (...pairs) => pairs.map(([label, confidence]) => ({ label, confidence }));
const SAMPLE = probs(["glass", 0.93], ["metal", 0.04], ["plastic", 0.02], ["paper", 0.01]);

const TABLE = [
  { threshold: 0.0, answered: 1.0, accuracy: 0.8274509803921568 },
  { threshold: 0.4, answered: 0.9686274509803922, accuracy: 0.8421052631578947 },
  { threshold: 0.5, answered: 0.9254901960784314, accuracy: 0.8728813559322034 },
  { threshold: 0.6, answered: 0.8862745098039215, accuracy: 0.8938053097345132 },
  { threshold: 0.7, answered: 0.8431372549019608, accuracy: 0.9209302325581395 },
  { threshold: 0.8, answered: 0.7803921568627451, accuracy: 0.9346733668341709 },
  { threshold: 0.9, answered: 0.7019607843137254, accuracy: 0.9553072625698324 },
];

// ---- decide -----------------------------------------------------------------------------------
test("decide: above threshold is known and shows the top 3", () => {
  const d = D.decide(SAMPLE, 0.7);
  assert.equal(d.status, "known");
  assert.equal(d.label, "glass");
  assert.deepEqual(d.shown.map((r) => r.label), ["glass", "metal", "plastic"]);
});

test("decide: below threshold is unknown, has no label and shows the top 2", () => {
  const d = D.decide(probs(["glass", 0.55], ["metal", 0.3], ["paper", 0.15]), 0.7);
  assert.equal(d.status, "unknown");
  assert.equal(d.label, null);
  assert.deepEqual(d.shown.map((r) => r.label), ["glass", "metal"]);
});

test("decide: equal to the threshold counts as known (same as the server)", () => {
  assert.equal(D.decide(probs(["glass", 0.7], ["metal", 0.3]), 0.7).status, "known");
  assert.equal(D.decide(probs(["glass", 0.69], ["metal", 0.31]), 0.7).status, "unknown");
});

test("decide: slider float noise does not flip the boundary", () => {
  assert.equal(D.decide(probs(["glass", 0.7], ["metal", 0.3]), "0.7000000000000001").status, "known");
  assert.equal(D.decide(probs(["glass", 0.7], ["metal", 0.3]), 0.6999999999999999).status, "known");
});

test("decide: the same cached numbers re-decide when the slider moves", () => {
  const p = probs(["glass", 0.75], ["metal", 0.25]);
  assert.equal(D.decide(p, 0.7).status, "known");
  assert.equal(D.decide(p, 0.8).status, "unknown");
  assert.equal(D.decide(p, 0.4).status, "known");
});

test("decide: sorts unsorted input and keeps ties stable", () => {
  const d = D.decide(probs(["a", 0.2], ["b", 0.5], ["c", 0.2], ["d", 0.1]), 0.4);
  assert.deepEqual(d.shown.map((r) => r.label), ["b", "a", "c"]);
});

test("decide: empty or invalid input is unknown with nothing to show", () => {
  for (const bad of [[], null, undefined, [{ label: 1, confidence: "x" }]]) {
    const d = D.decide(bad, 0.7);
    assert.equal(d.status, "unknown");
    assert.deepEqual(d.shown, []);
  }
});

// ---- normaliseThreshold / formatPercent ------------------------------------------------------
test("normaliseThreshold rounds to 2 decimals and survives junk", () => {
  assert.equal(D.normaliseThreshold("0.7000000000000001"), 0.7);
  assert.equal(D.normaliseThreshold(0.45000000000000007), 0.45);
  assert.equal(D.normaliseThreshold("abc"), D.DEFAULT_THRESHOLD);
  assert.equal(D.normaliseThreshold(undefined), 0.7);
  assert.equal(D.normaliseThreshold(NaN, 0.5), 0.5);
});

test("formatPercent shows one decimal", () => {
  assert.equal(D.formatPercent(0.931), "93.1%");
  assert.equal(D.formatPercent(1), "100.0%");
  assert.equal(D.formatPercent(NaN), "");
});

test("retake tips cover the five advice items", () => {
  assert.equal(D.RETAKE_TIPS.length, 5);
  const joined = D.RETAKE_TIPS.join(" ").toLowerCase();
  for (const word of ["closer", "one object", "light", "plain background", "crop"]) assert.ok(joined.includes(word), word);
});

// ---- hintFor ---------------------------------------------------------------------------------
test("hintFor: an exact table row is quoted with 'about'", () => {
  assert.equal(D.hintFor(0.7, TABLE), "At 0.70: answers about 84% of photos, about 92% correct on web test");
  assert.equal(D.hintFor(0.4, TABLE), "At 0.40: answers about 97% of photos, about 84% correct on web test");
});

test("hintFor: values between rows are linearly interpolated", () => {
  assert.equal(D.hintFor(0.75, TABLE), "At 0.75: answers about 81% of photos, about 93% correct on web test");
  const t45 = D.hintFor(0.45, TABLE); // halfway between 0.4 and 0.5
  assert.equal(t45, "At 0.45: answers about 95% of photos, about 86% correct on web test");
});

test("hintFor: slider float noise still finds the exact row", () => {
  assert.equal(D.hintFor("0.7000000000000001", TABLE), D.hintFor(0.7, TABLE));
});

test("hintFor: above the last row says there is no data and quotes the last row", () => {
  const h = D.hintFor(0.95, TABLE);
  assert.match(h, /^No web-test data above 0\.90/);
  assert.match(h, /at 0\.90: answers about 70% of photos, about 96% correct/);
  assert.equal(D.hintFor(0.9, TABLE), "At 0.90: answers about 70% of photos, about 96% correct on web test");
});

test("hintFor: below the first row also says there is no data", () => {
  const h = D.hintFor(0.3, [{ threshold: 0.4, answered: 0.9, accuracy: 0.8 }, { threshold: 0.5, answered: 0.8, accuracy: 0.85 }]);
  assert.match(h, /^No web-test data below 0\.40/);
});

test("hintFor: empty, missing or junk table gives null (hint hidden)", () => {
  assert.equal(D.hintFor(0.7, []), null);
  assert.equal(D.hintFor(0.7, null), null);
  assert.equal(D.hintFor(0.7, [{ threshold: "x" }]), null);
});

test("hintFor: a one-row table never throws", () => {
  const one = [{ threshold: 0.7, answered: 0.8, accuracy: 0.9 }];
  assert.equal(D.hintFor(0.7, one), "At 0.70: answers about 80% of photos, about 90% correct on web test");
  assert.match(D.hintFor(0.8, one), /^No web-test data above/);
});
