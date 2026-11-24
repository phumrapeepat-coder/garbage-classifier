"""Strict loaders for config.json and the threshold CSV. Bad files stop the server at startup."""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

from garbage_web.models import ModelConfig, ThresholdRow

EXPECTED_INPUT_RANGE = [0, 255]  # the model has Rescaling inside; we feed raw 0..255 floats


class ModelFileError(Exception):
    """A model file is missing, unreadable or does not match what the app expects."""


def load_config(path: Path) -> ModelConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ModelFileError(f"cannot read model config {path.name}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ModelFileError("config.json must be a JSON object")

    classes = raw.get("classes")
    if (
        not isinstance(classes, list)
        or len(classes) < 2
        or not all(isinstance(c, str) and c for c in classes)
        or len(set(classes)) != len(classes)
    ):
        raise ModelFileError("config.json: 'classes' must be a list of unique non-empty names")

    # label_to_id must agree with the list order, otherwise predictions would get the wrong names.
    mapping = raw.get("label_to_id")
    if mapping is not None and mapping != {name: i for i, name in enumerate(classes)}:
        raise ModelFileError("config.json: 'label_to_id' does not match the order of 'classes'")

    size = raw.get("image_size")
    if (
        not isinstance(size, list)
        or len(size) != 2
        or not all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in size)
    ):
        raise ModelFileError("config.json: 'image_size' must be [height, width] of positive integers")

    if raw.get("input_range") != EXPECTED_INPUT_RANGE:
        raise ModelFileError("config.json: 'input_range' must be [0, 255] (the model rescales itself)")

    temperature = raw.get("temperature")
    if (
        not isinstance(temperature, (int, float))
        or isinstance(temperature, bool)
        or not math.isfinite(temperature)
        or temperature <= 0
    ):
        raise ModelFileError("config.json: 'temperature' must be a positive number")

    return ModelConfig(
        classes=tuple(classes),
        image_size=(int(size[0]), int(size[1])),
        temperature=float(temperature),
    )


def load_threshold_table(path: Path) -> tuple[ThresholdRow, ...]:
    """Rows sorted by threshold. A missing file gives an empty table (the page then hides the hint)."""
    if not path.exists():
        return ()
    rows: list[ThresholdRow] = []
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for record in reader:
                rows.append(
                    ThresholdRow(
                        threshold=float(record["threshold"]),
                        answered=float(record["answered"]),
                        accuracy=float(record["accuracy_when_answered"]),
                    )
                )
    except (OSError, KeyError, ValueError, TypeError) as exc:
        raise ModelFileError(f"cannot parse {path.name}: {exc.__class__.__name__}: {exc}") from exc

    for row in rows:
        values = (row.threshold, row.answered, row.accuracy)
        if not all(math.isfinite(v) and 0.0 <= v <= 1.0 for v in values):
            raise ModelFileError(f"{path.name}: every value must be a number between 0 and 1")
    thresholds = [r.threshold for r in rows]
    if thresholds != sorted(set(thresholds)):
        raise ModelFileError(f"{path.name}: thresholds must be unique and ascending")
    return tuple(rows)
