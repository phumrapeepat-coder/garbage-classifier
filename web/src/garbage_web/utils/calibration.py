"""Flip-TTA averaging, temperature scaling, ranking and the Unknown rule (pure numpy, no TF)."""
from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import numpy.typing as npt

from garbage_web.models import Decision, ScoredLabel

Probs = npt.NDArray[np.float64]

_EPS = 1e-7  # floor before log() so a probability of exactly 0 cannot become -inf


def average_tta(rows: Probs) -> Probs:
    """Mean of the softmax rows (original + mirrored) -> one probability vector.

    Done BEFORE temperature: the temperature was fitted on plain softmax probabilities, and the
    averaged vector plays that role. (T was fitted without TTA, so it is approximate; accepted.)
    """
    return np.asarray(rows, dtype=np.float64).mean(axis=0)


def apply_temperature(p: Probs, temperature: float) -> Probs:
    """p <- softmax(log(p) / T). Same formula as the training notebook's apply_temperature."""
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    z = np.log(np.clip(np.asarray(p, dtype=np.float64), _EPS, 1.0)) / temperature
    z = z - z.max()  # numerical stability; does not change the softmax
    e = np.exp(z)
    out: Probs = e / e.sum()
    return out


def rank(p: Probs, classes: Sequence[str]) -> tuple[ScoredLabel, ...]:
    """Every class, highest confidence first. Ties keep the model's class order (stable sort)."""
    if len(p) != len(classes):
        raise ValueError("probability count does not match the class count")
    order = sorted(range(len(classes)), key=lambda i: -float(p[i]))  # sorted() is stable
    return tuple(ScoredLabel(classes[i], float(p[i])) for i in order)


def decide(top: ScoredLabel, threshold: float) -> Decision:
    """Unknown iff the top confidence is below the threshold (equal counts as known)."""
    if top.confidence < threshold:
        return Decision(status="unknown", label=None)
    return Decision(status="known", label=top.label)
