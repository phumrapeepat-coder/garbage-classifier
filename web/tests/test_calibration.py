from __future__ import annotations

import numpy as np
import pytest

from garbage_web.models import ScoredLabel
from garbage_web.utils.calibration import apply_temperature, average_tta, decide, rank


def reference_temperature(p: np.ndarray, t: float) -> np.ndarray:
    """The training notebook's apply_temperature, restated."""
    z = np.log(np.clip(p, 1e-7, 1)) / t
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


P = np.array([0.6, 0.25, 0.1, 0.05])


def test_temperature_matches_reference_formula() -> None:
    np.testing.assert_allclose(apply_temperature(P, 0.675), reference_temperature(P, 0.675))


def test_temperature_sums_to_one_and_keeps_argmax() -> None:
    for t in (0.3, 0.675, 1.0, 2.5):
        out = apply_temperature(P, t)
        assert out.sum() == pytest.approx(1.0)
        assert int(out.argmax()) == int(P.argmax())


def test_temperature_below_one_sharpens() -> None:
    assert apply_temperature(P, 0.675)[0] > P[0]


def test_temperature_one_is_identity() -> None:
    np.testing.assert_allclose(apply_temperature(P, 1.0), P, atol=1e-9)


def test_zeros_do_not_produce_nan_or_inf() -> None:
    out = apply_temperature(np.array([1.0, 0.0, 0.0]), 0.675)
    assert np.all(np.isfinite(out))
    assert out.sum() == pytest.approx(1.0)
    assert int(out.argmax()) == 0


def test_temperature_must_be_positive() -> None:
    with pytest.raises(ValueError):
        apply_temperature(P, 0.0)


def test_tta_average_is_the_row_mean() -> None:
    rows = np.array([[0.8, 0.2], [0.4, 0.6]])
    np.testing.assert_allclose(average_tta(rows), [0.6, 0.4])
    assert average_tta(rows).sum() == pytest.approx(1.0)


def test_average_happens_before_temperature() -> None:
    # The two orders give different numbers; the app uses mean -> temperature.
    rows = np.array([[0.9, 0.1], [0.5, 0.5]])
    mean_first = apply_temperature(average_tta(rows), 0.675)
    temp_first = np.mean([apply_temperature(r, 0.675) for r in rows], axis=0)
    assert not np.allclose(mean_first, temp_first)


def test_decide_below_equal_above() -> None:
    top = ScoredLabel("glass", 0.69)
    assert decide(top, 0.70).status == "unknown"
    assert decide(top, 0.70).label is None
    assert decide(ScoredLabel("glass", 0.70), 0.70).status == "known"  # equal counts as known
    known = decide(ScoredLabel("glass", 0.93), 0.70)
    assert (known.status, known.label) == ("known", "glass")


def test_rank_is_descending_and_complete() -> None:
    classes = ["a", "b", "c", "d"]
    ranked = rank(np.array([0.1, 0.5, 0.3, 0.1]), classes)
    assert [r.label for r in ranked] == ["b", "c", "a", "d"]
    assert [r.confidence for r in ranked] == sorted((r.confidence for r in ranked), reverse=True)


def test_rank_ties_keep_class_order() -> None:
    ranked = rank(np.array([0.25, 0.25, 0.25, 0.25]), ["a", "b", "c", "d"])
    assert [r.label for r in ranked] == ["a", "b", "c", "d"]


def test_rank_checks_lengths() -> None:
    with pytest.raises(ValueError):
        rank(np.array([0.5, 0.5]), ["a", "b", "c"])
