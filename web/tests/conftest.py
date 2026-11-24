"""Shared fixtures: a fake model (no TensorFlow), an app client, and tiny in-memory test images."""
from __future__ import annotations

import io
from collections.abc import Callable
from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest
from flask import Flask
from flask.testing import FlaskClient
from PIL import Image
from werkzeug.test import TestResponse

from garbage_web.app import create_app
from garbage_web.models import ModelConfig, ThresholdRow
from garbage_web.services.model_service import ModelService
from garbage_web.utils.model_files import load_config

WEB_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def config() -> ModelConfig:
    """The real model/config.json (10 classes, 224x224, T=0.7)."""
    return load_config(WEB_ROOT / "model" / "config.json")


class FakeModel:
    """Looks like a keras model: returns the same probability row for every image in the batch."""

    input_shape: tuple[int | None, ...] = (None, 224, 224, 3)
    output_shape: tuple[int | None, ...] = (None, 10)

    def __init__(self, row: list[float] | None = None) -> None:
        self.row = np.array(row if row is not None else [0.02, 0.02, 0.02, 0.02, 0.8, 0.02, 0.02, 0.02, 0.03, 0.03])
        self.crash = False
        self.batches: list[npt.NDArray[np.float32]] = []

    def predict(self, x: npt.NDArray[np.float32], verbose: int = 0) -> npt.NDArray[np.float32]:
        if self.crash:
            raise RuntimeError("boom /secret/path/leak")
        self.batches.append(x)
        return np.tile(self.row, (len(x), 1)).astype(np.float32)


ClientMaker = Callable[..., FlaskClient]


@pytest.fixture
def fake_model() -> FakeModel:
    return FakeModel()


@pytest.fixture
def make_client(config: ModelConfig, fake_model: FakeModel) -> ClientMaker:
    def build(
        model: FakeModel | None = None,
        table: tuple[ThresholdRow, ...] = (),
        broken: bool = False,
    ) -> FlaskClient:
        used = model if model is not None else fake_model

        def loader(path: Path) -> FakeModel:
            if broken:
                raise OSError("cannot load")
            return used

        service = ModelService(Path("unused.keras"), config, loader=loader)
        app: Flask = create_app(service, table)
        app.config["TESTING"] = False  # keep the real error handlers (TESTING would re-raise exceptions)
        return app.test_client()

    return build


def encode(img: Image.Image, fmt: str, **kwargs: object) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, **kwargs)  # type: ignore[arg-type]
    return buf.getvalue()


@pytest.fixture
def gradient_rgb() -> Image.Image:
    """A 120x80 RGB image with distinct values everywhere (a flip or rotation would be visible)."""
    rng = np.random.default_rng(7)
    return Image.fromarray(rng.integers(0, 256, size=(80, 120, 3), dtype=np.uint8), "RGB")


def upload(client: FlaskClient, data: bytes, name: str = "photo.jpg", field: str = "image") -> TestResponse:
    return client.post(
        "/api/predict",
        data={field: (io.BytesIO(data), name)},
        content_type="multipart/form-data",
    )

