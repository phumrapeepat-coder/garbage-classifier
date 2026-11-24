from __future__ import annotations

import json
from pathlib import Path

import pytest

from garbage_web.utils.model_files import ModelFileError, load_config, load_threshold_table

WEB_ROOT = Path(__file__).resolve().parents[1]
GOOD = {
    "classes": ["a", "b", "c"],
    "label_to_id": {"a": 0, "b": 1, "c": 2},
    "image_size": [224, 224],
    "input_range": [0, 255],
    "temperature": 0.5,
}


def write_config(tmp_path: Path, **changes: object) -> Path:
    data = {**GOOD, **changes}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_real_config_loads() -> None:
    cfg = load_config(WEB_ROOT / "model" / "config.json")
    assert len(cfg.classes) == 10
    assert cfg.classes[0] == "battery" and cfg.classes[4] == "glass"
    assert cfg.image_size == (224, 224)
    assert cfg.resize_wh == (224, 224)
    assert cfg.temperature == pytest.approx(0.7)


def test_resize_wh_is_width_then_height(tmp_path: Path) -> None:
    cfg = load_config(write_config(tmp_path, image_size=[100, 200]))
    assert cfg.image_size == (100, 200)
    assert cfg.resize_wh == (200, 100)


@pytest.mark.parametrize(
    "changes",
    [
        {"label_to_id": {"a": 1, "b": 0, "c": 2}},  # order disagrees with the list
        {"classes": ["a", "a", "c"], "label_to_id": None},  # duplicate names
        {"classes": "abc"},
        {"image_size": [224]},
        {"image_size": [224, -1]},
        {"image_size": [224.0, 224.0]},
        {"input_range": [0, 1]},
        {"temperature": 0},
        {"temperature": -1.0},
        {"temperature": "hot"},
        {"temperature": True},
    ],
)
def test_config_rejects_bad_values(tmp_path: Path, changes: dict[str, object]) -> None:
    with pytest.raises(ModelFileError):
        load_config(write_config(tmp_path, **changes))


def test_config_rejects_missing_and_non_json(tmp_path: Path) -> None:
    with pytest.raises(ModelFileError):
        load_config(tmp_path / "nope.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(ModelFileError):
        load_config(bad)


def test_real_threshold_table_loads_sorted() -> None:
    table = load_threshold_table(WEB_ROOT / "model" / "confidence_threshold_table.csv")
    assert [r.threshold for r in table] == [0.0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    row = next(r for r in table if r.threshold == 0.7)
    assert row.answered == pytest.approx(0.807, abs=1e-3)
    assert row.accuracy == pytest.approx(0.951, abs=1e-3)


def test_missing_table_is_empty(tmp_path: Path) -> None:
    assert load_threshold_table(tmp_path / "missing.csv") == ()


@pytest.mark.parametrize(
    "body",
    [
        "threshold,answered,accuracy_when_answered\n0.5,abc,0.9\n",  # not a number
        "threshold,answered\n0.5,0.9\n",  # missing column
        "threshold,answered,accuracy_when_answered\n0.5,1.5,0.9\n",  # out of range
        "threshold,answered,accuracy_when_answered\n0.6,0.9,0.9\n0.5,0.9,0.9\n",  # not ascending
        "threshold,answered,accuracy_when_answered\n0.5,0.9,0.9\n0.5,0.8,0.9\n",  # duplicate threshold
        "threshold,answered,accuracy_when_answered\nnan,0.9,0.9\n",
    ],
)
def test_table_rejects_junk(tmp_path: Path, body: str) -> None:
    path = tmp_path / "t.csv"
    path.write_text(body, encoding="utf-8")
    with pytest.raises(ModelFileError):
        load_threshold_table(path)
