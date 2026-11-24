"""Loads the Keras model once and runs forward passes under a lock."""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import numpy as np
import numpy.typing as npt

from garbage_web.models import ModelConfig

log = logging.getLogger(__name__)


class ModelUnavailableError(Exception):
    """The model could not be loaded (or failed its sanity check)."""


class Predictor(Protocol):
    """The slice of keras.Model we use; tests pass a fake with the same shape."""

    input_shape: tuple[int | None, ...]
    output_shape: tuple[int | None, ...]

    def predict(self, x: npt.NDArray[np.float32], verbose: int = ...) -> npt.NDArray[np.float32]: ...


Loader = Callable[[Path], Predictor]


def load_keras_model(path: Path) -> Predictor:
    """Real loader. Imported lazily so tests with a fake model never import TensorFlow."""
    import keras  # noqa: PLC0415

    # compile=False: inference only. safe_mode=True: refuse files that would run arbitrary code.
    model: Predictor = keras.models.load_model(path, compile=False, safe_mode=True)
    return model


class ModelService:
    def __init__(self, model_path: Path, config: ModelConfig, loader: Loader = load_keras_model) -> None:
        self.config = config
        self._path = model_path
        self._loader = loader
        self._model: Predictor | None = None
        self._failed = False  # a failed load is remembered: restart the app to retry
        self._load_lock = threading.Lock()
        self._predict_lock = threading.Lock()  # one forward pass at a time (Flask is threaded)

    def ensure_loaded(self) -> bool:
        with self._load_lock:
            if self._model is not None:
                return True
            if self._failed:
                return False
            try:
                model = self._loader(self._path)
                self._check(model)
            except Exception:  # noqa: BLE001 - any failure means "unavailable"; trace goes to the log
                log.exception("model failed to load from %s", self._path)
                self._failed = True
                return False
            self._model = model
            return True

    def _check(self, model: Predictor) -> None:
        """Fail fast if the model does not match config.json (wrong file swapped in, etc.)."""
        height, width = self.config.image_size
        if tuple(model.input_shape[1:3]) != (height, width):
            raise ValueError(f"model input {model.input_shape} does not match image_size {(height, width)}")
        n = len(self.config.classes)
        if model.output_shape[-1] != n:
            raise ValueError(f"model has {model.output_shape[-1]} outputs but config lists {n} classes")
        # Behavioural check that the outputs are softmax probabilities: finite and summing to 1.
        probe = np.zeros((1, height, width, 3), dtype=np.float32)
        out = np.asarray(model.predict(probe, verbose=0), dtype=np.float64)
        if out.shape != (1, n) or not np.all(np.isfinite(out)) or abs(float(out.sum()) - 1.0) > 1e-3:
            raise ValueError("model output is not a softmax probability vector")

    def predict_probs(self, batch: npt.NDArray[np.float32]) -> npt.NDArray[np.float64]:
        """(k, H, W, 3) float32 0..255 -> (k, n_classes) softmax rows."""
        if not self.ensure_loaded() or self._model is None:
            raise ModelUnavailableError("model unavailable")
        with self._predict_lock:
            out = np.asarray(self._model.predict(batch, verbose=0), dtype=np.float64)
        if out.ndim != 2 or out.shape[0] != batch.shape[0] or out.shape[1] != len(self.config.classes):
            raise ValueError(f"unexpected model output shape {out.shape}")
        return out
