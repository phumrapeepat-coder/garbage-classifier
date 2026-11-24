"""API behaviour with a fake model (no TensorFlow)."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from PIL import Image

from garbage_web import settings
from garbage_web.models import ThresholdRow

from .conftest import ClientMaker, FakeModel, encode, upload

TABLE = (ThresholdRow(0.0, 1.0, 0.8), ThresholdRow(0.7, 0.84, 0.92))


def jpeg(img: Image.Image) -> bytes:
    return encode(img, "JPEG")


def test_health_ready(make_client: ClientMaker) -> None:
    res = make_client().get("/api/health")
    assert res.status_code == 200
    body = res.get_json()
    assert body["ready"] is True
    assert len(body["classes"]) == 10
    assert body["image_size"] == [224, 224]


def test_health_503_when_model_missing(make_client: ClientMaker) -> None:
    res = make_client(broken=True).get("/api/health")
    assert res.status_code == 503
    assert res.get_json() == {"ready": False, "error": "model_unavailable"}


def test_config_payload(make_client: ClientMaker) -> None:
    body = make_client(table=TABLE).get("/api/config").get_json()
    assert body["tta"] == "hflip"
    assert body["default_threshold"] == 0.70
    assert body["temperature"] == pytest.approx(0.7)
    assert body["slider"] == {"min": 0.40, "max": 0.95, "step": 0.05}
    assert body["threshold_table"][1] == {"threshold": 0.7, "answered": 0.84, "accuracy": 0.92}
    assert len(body["classes"]) == 10


def test_config_empty_table(make_client: ClientMaker) -> None:
    assert make_client().get("/api/config").get_json()["threshold_table"] == []


def test_predict_ok(make_client: ClientMaker, fake_model: FakeModel, gradient_rgb: Image.Image) -> None:
    res = upload(make_client(), jpeg(gradient_rgb))
    assert res.status_code == 200
    body = res.get_json()
    probs = body["probabilities"]
    assert len(probs) == 10
    confidences = [p["confidence"] for p in probs]
    assert confidences == sorted(confidences, reverse=True)
    assert sum(confidences) == pytest.approx(1.0, abs=1e-4)
    assert probs[0]["label"] == "glass"
    assert body["decision"] == {"status": "known", "label": "glass"}
    assert body["threshold"] == 0.70
    assert isinstance(body["elapsed_ms"], int)
    # One forward pass over exactly two views (original + mirror).
    assert fake_model.batches[-1].shape == (2, 224, 224, 3)


def test_predict_low_confidence_is_unknown(make_client: ClientMaker, gradient_rgb: Image.Image) -> None:
    flat = FakeModel([0.1] * 10)  # calibrated top stays near 0.1: well under 0.70
    body = upload(make_client(model=flat), jpeg(gradient_rgb)).get_json()
    assert body["decision"] == {"status": "unknown", "label": None}
    assert len(body["probabilities"]) == 10  # the client still gets every class


def test_missing_image_field_is_400(make_client: ClientMaker) -> None:
    res = make_client().post("/api/predict", data={}, content_type="multipart/form-data")
    assert res.status_code == 400
    assert res.get_json()["error"] == "missing_image"


def test_wrong_field_name_is_400(make_client: ClientMaker, gradient_rgb: Image.Image) -> None:
    res = upload(make_client(), jpeg(gradient_rgb), field="file")
    assert res.status_code == 400


def test_empty_file_is_400(make_client: ClientMaker) -> None:
    res = upload(make_client(), b"")
    assert res.status_code == 400
    assert res.get_json()["error"] == "empty_image"


def test_garbage_is_400(make_client: ClientMaker) -> None:
    res = upload(make_client(), b"not an image" * 50)
    assert res.status_code == 400
    assert res.get_json()["error"] == "invalid_image"


def test_gif_is_415(make_client: ClientMaker, gradient_rgb: Image.Image) -> None:
    res = upload(make_client(), encode(gradient_rgb, "GIF"), name="x.gif")
    assert res.status_code == 415
    assert res.get_json()["error"] == "unsupported_format"


def test_just_over_8_mib_is_413(make_client: ClientMaker) -> None:
    res = upload(make_client(), b"\xff\xd8" + b"0" * settings.MAX_UPLOAD_BYTES)  # 8 MiB + 2 bytes
    assert res.status_code == 413
    assert res.get_json()["error"] == "file_too_large"


def test_far_over_the_limit_is_413_json(make_client: ClientMaker) -> None:
    res = upload(make_client(), b"0" * (settings.MAX_UPLOAD_BYTES + 200_000))
    assert res.status_code == 413
    assert res.get_json()["error"] == "file_too_large"


def test_model_crash_is_500_without_trace(make_client: ClientMaker, gradient_rgb: Image.Image) -> None:
    model = FakeModel()
    client = make_client(model=model)
    assert client.get("/api/health").status_code == 200  # load + sanity check pass first
    model.crash = True
    res = upload(client, jpeg(gradient_rgb))
    assert res.status_code == 500
    text = res.get_data(as_text=True)
    assert res.get_json()["error"] == "internal_error"
    assert "boom" not in text and "Traceback" not in text and "/secret" not in text


def test_predict_is_503_when_model_missing(make_client: ClientMaker, gradient_rgb: Image.Image) -> None:
    res = upload(make_client(broken=True), jpeg(gradient_rgb))
    assert res.status_code == 503
    assert res.get_json()["error"] == "model_unavailable"


def test_unknown_route_is_json_404(make_client: ClientMaker) -> None:
    res = make_client().get("/nope")
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"


def test_wrong_method_is_405(make_client: ClientMaker) -> None:
    assert make_client().get("/api/predict").status_code == 405


def test_security_headers(make_client: ClientMaker) -> None:
    res = make_client().get("/api/health")
    csp = res.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp
    assert "http://" not in csp and "https://" not in csp
    assert res.headers["X-Content-Type-Options"] == "nosniff"


def test_upload_creates_no_files(
    make_client: ClientMaker, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A >500 KB upload would be spooled to a temp file by stock Werkzeug; ours must stay in memory.
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    big = Image.effect_noise((900, 900), 80).convert("RGB")
    data = encode(big, "PNG")
    assert len(data) > 600_000
    client = make_client()
    before = set(os.listdir(tmp_path))
    res = upload(client, data)
    assert res.status_code == 200
    assert set(os.listdir(tmp_path)) == before


def test_index_page_served(make_client: ClientMaker) -> None:
    res = make_client().get("/")
    assert res.status_code == 200
    assert b"<html" in res.data
