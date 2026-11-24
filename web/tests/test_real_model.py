"""Runs the REAL Keras model on a known photo (skipped if the model file is not there)."""
from __future__ import annotations

from pathlib import Path

import pytest

from garbage_web import settings
from garbage_web.app import create_app
from garbage_web.services.model_service import ModelService
from garbage_web.utils.model_files import load_config, load_threshold_table

WEB_ROOT = Path(__file__).resolve().parents[1]
MODEL = WEB_ROOT / "model" / "garbage_cnn.keras"
SMOKE_IMAGE = WEB_ROOT.parents[1] / "garbage-classifier-web" / "verification" / "glass_jar_smoke.jpg"

pytestmark = [
    pytest.mark.skipif(not MODEL.exists(), reason="model/garbage_cnn.keras is missing"),
    pytest.mark.skipif(not SMOKE_IMAGE.exists(), reason="glass_jar_smoke.jpg fixture is missing"),
]


def test_glass_jar_is_glass_and_known() -> None:
    config = load_config(WEB_ROOT / "model" / "config.json")
    table = load_threshold_table(WEB_ROOT / "model" / "confidence_threshold_table.csv")
    service = ModelService(MODEL, config)
    assert service.ensure_loaded(), "the real model failed to load"
    client = create_app(service, table).test_client()

    with SMOKE_IMAGE.open("rb") as handle:
        res = client.post("/api/predict", data={"image": (handle, "glass_jar_smoke.jpg")})
    assert res.status_code == 200
    body = res.get_json()
    top = body["probabilities"][0]
    assert top["label"] == "glass"
    assert top["confidence"] >= settings.DEFAULT_THRESHOLD
    assert body["decision"] == {"status": "known", "label": "glass"}
    assert sum(p["confidence"] for p in body["probabilities"]) == pytest.approx(1.0, abs=1e-4)
