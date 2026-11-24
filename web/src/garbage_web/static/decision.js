"use strict";
/*
 * Pure threshold logic. No DOM: the browser loads it with a <script> tag (exposes `Decision`) and Node loads it
 * with require() for tests. The server already returns calibrated probabilities for every class; the slider only
 * re-applies the SAME rule the server uses ("unknown iff top confidence < threshold") on those cached numbers.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Decision = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT_THRESHOLD = 0.7;
  const EPS = 1e-9;

  const RETAKE_TIPS = [
    "Move closer so the item fills more of the photo.",
    "Photograph one object at a time.",
    "Use better, even light and hold the camera steady.",
    "Put the item on a plain background.",
    "Try the Crop button to cut away everything around the item.",
  ];

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  /** Slider values come in as strings with float noise (0.7000000001): round to 2 decimals. */
  function normaliseThreshold(value, fallback = DEFAULT_THRESHOLD) {
    const n = typeof value === "string" ? Number(value) : value;
    if (!isNum(n)) return fallback;
    return Math.round(n * 100) / 100;
  }

  /** 0.931 -> "93.1%". */
  function formatPercent(confidence) {
    if (!isNum(confidence)) return "";
    return (confidence * 100).toFixed(1) + "%";
  }

  /**
   * probs: [{label, confidence}] (any order). Returns what to show for this threshold:
   *  known   -> top label + top 3 rows;  unknown -> no label + top 2 rows.
   * Equal to the threshold counts as known (same as the server and the threshold table's ">=").
   */
  function decide(probs, threshold) {
    const t = normaliseThreshold(threshold);
    const rows = (Array.isArray(probs) ? probs : [])
      .filter((p) => p && typeof p.label === "string" && isNum(p.confidence))
      .map((p, i) => ({ label: p.label, confidence: p.confidence, i }))
      .sort((a, b) => b.confidence - a.confidence || a.i - b.i) // stable for ties
      .map(({ label, confidence }) => ({ label, confidence }));
    if (rows.length === 0) return { status: "unknown", label: null, confidence: 0, threshold: t, shown: [] };
    const top = rows[0];
    // Tiny tolerance so float noise (0.6999999999999 vs 0.7) cannot flip an exact-equal case to unknown.
    const known = top.confidence + EPS >= t;
    return {
      status: known ? "known" : "unknown",
      label: known ? top.label : null,
      confidence: top.confidence,
      threshold: t,
      shown: rows.slice(0, known ? 3 : 2),
    };
  }

  const pct = (x) => Math.round(x * 100) + "%";

  function describe(t, row) {
    return (
      "At " + t.toFixed(2) + ": answers about " + pct(row.answered) + " of photos, about " +
      pct(row.accuracy) + " correct on web test"
    );
  }

  /**
   * One line for the slider from the web-test threshold table (rows: {threshold, answered, accuracy}, ascending).
   * Between two rows the numbers are linearly interpolated (hence "about"). Outside the table there is no data.
   * Returns null when there is no usable table, so the page can hide the hint.
   */
  function hintFor(threshold, table) {
    const rows = (Array.isArray(table) ? table : []).filter(
      (r) => r && isNum(r.threshold) && isNum(r.answered) && isNum(r.accuracy),
    );
    if (rows.length === 0) return null;
    const t = normaliseThreshold(threshold);
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (t > last.threshold + EPS) {
      return "No web-test data above " + last.threshold.toFixed(2) + " (" + describe(last.threshold, last).replace("At", "at") + ")";
    }
    if (t < first.threshold - EPS) {
      return "No web-test data below " + first.threshold.toFixed(2) + " (" + describe(first.threshold, first).replace("At", "at") + ")";
    }
    const exact = rows.find((r) => Math.abs(r.threshold - t) < EPS);
    if (exact) return describe(t, exact);
    for (let i = 0; i < rows.length - 1; i++) {
      const lo = rows[i];
      const hi = rows[i + 1];
      if (t > lo.threshold && t < hi.threshold) {
        const f = (t - lo.threshold) / (hi.threshold - lo.threshold);
        return describe(t, {
          answered: lo.answered + f * (hi.answered - lo.answered),
          accuracy: lo.accuracy + f * (hi.accuracy - lo.accuracy),
        });
      }
    }
    return null; // unreachable for a sorted table; stay safe instead of throwing
  }

  return { DEFAULT_THRESHOLD, RETAKE_TIPS, normaliseThreshold, formatPercent, decide, hintFor };
});
