"""Flask app factory: routes, JSON errors, security headers. Uploads stay in memory.

/api/detect (object detection, added for the pick-an-object step) only finds boxes; it never touches the model.
"""
from __future__ import annotations

import io
import logging
import time
from typing import IO

import numpy as np
from flask import Flask, Request, Response, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from garbage_web import settings
from garbage_web.models import InputError, PredictionResult, ThresholdRow
from garbage_web.services.model_service import ModelService, ModelUnavailableError
from garbage_web.utils.calibration import apply_temperature, average_tta, decide, rank
from garbage_web.utils.detect import detect_objects
from garbage_web.utils.preprocess import decode_image, preprocess_bytes, to_rgb_like_training, tta_batch

log = logging.getLogger(__name__)

# Everything is served from this origin; blob:/mediastream: are needed for the photo preview and camera.
CSP = (
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: mediastream:; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)


class InMemoryRequest(Request):
    """Werkzeug spools uploads above 500 KB to a temp FILE; keep them in RAM so nothing is persisted."""

    def _get_file_stream(
        self,
        total_content_length: int | None,
        content_type: str | None,
        filename: str | None = None,
        content_length: int | None = None,
    ) -> IO[bytes]:
        return io.BytesIO()


def _error(status: int, code: str, message: str) -> tuple[Response, int]:
    return jsonify({"error": code, "message": message}), status


def _read_upload() -> bytes:
    """The 'image' form field, with the exact 8 MiB limit."""
    upload = request.files.get("image")
    if upload is None:
        raise InputError(400, "missing_image", "Please attach an image in the 'image' field.")
    data = upload.read()
    if len(data) > settings.MAX_UPLOAD_BYTES:
        raise InputError(413, "file_too_large", "That file is too large. The limit is 8 MB.")
    return data


def create_app(service: ModelService, threshold_table: tuple[ThresholdRow, ...] = ()) -> Flask:
    app = Flask(__name__)
    app.request_class = InMemoryRequest
    app.config["MAX_CONTENT_LENGTH"] = settings.MAX_UPLOAD_BYTES + settings.MULTIPART_SLACK_BYTES
    cfg = service.config

    config_payload: dict[str, object] = {
        "classes": list(cfg.classes),
        "image_size": list(cfg.image_size),
        "temperature": cfg.temperature,
        "tta": "hflip",
        "default_threshold": settings.DEFAULT_THRESHOLD,
        "slider": {"min": settings.SLIDER_MIN, "max": settings.SLIDER_MAX, "step": settings.SLIDER_STEP},
        "threshold_table": [
            {"threshold": r.threshold, "answered": r.answered, "accuracy": r.accuracy}
            for r in threshold_table
        ],
    }

    @app.get("/")
    def index() -> str:
        return render_template("index.html")

    @app.get("/api/health")
    def health() -> tuple[Response, int]:
        ready = service.ensure_loaded()
        if not ready:
            return jsonify({"ready": False, "error": "model_unavailable"}), 503
        return jsonify({"ready": True, "classes": list(cfg.classes), "image_size": list(cfg.image_size)}), 200

    @app.get("/api/config")
    def get_config() -> tuple[Response, int]:
        return jsonify(config_payload), 200

    @app.post("/api/predict")
    def predict() -> tuple[Response, int]:
        started = time.perf_counter()
        data = _read_upload()
        # Validate and preprocess BEFORE touching the model so bad input never waits for a load.
        batch = preprocess_bytes(data, cfg)
        rows = service.predict_probs(tta_batch(batch))
        calibrated = apply_temperature(average_tta(rows), cfg.temperature)
        ranked = rank(calibrated, cfg.classes)
        result = PredictionResult(
            probabilities=ranked,
            decision=decide(ranked[0], settings.DEFAULT_THRESHOLD),
            threshold=settings.DEFAULT_THRESHOLD,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )
        return jsonify(result.to_json()), 200

    @app.post("/api/detect")
    def detect() -> tuple[Response, int]:
        """Find objects on a plain surface. Boxes are in the pixels of the EXIF-rotated photo (what the page shows)."""
        started = time.perf_counter()
        data = _read_upload()
        rgb = np.asarray(to_rgb_like_training(decode_image(data)), dtype=np.uint8)
        found = detect_objects(rgb)
        return jsonify(
            {
                "width": found.width,
                "height": found.height,
                "objects": [b.to_json() for b in found.boxes],
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
            }
        ), 200

    @app.after_request
    def add_security_headers(response: Response) -> Response:
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.errorhandler(InputError)
    def on_input_error(exc: InputError) -> tuple[Response, int]:
        return _error(exc.status, exc.code, exc.message)

    @app.errorhandler(ModelUnavailableError)
    def on_unavailable(exc: ModelUnavailableError) -> tuple[Response, int]:
        return _error(503, "model_unavailable", "The model is not available right now.")

    @app.errorhandler(413)
    def on_too_big(exc: HTTPException) -> tuple[Response, int]:
        return _error(413, "file_too_large", "That file is too large. The limit is 8 MB.")

    @app.errorhandler(HTTPException)
    def on_http(exc: HTTPException) -> tuple[Response, int]:
        status = exc.code or 500
        return _error(status, (exc.name or "error").lower().replace(" ", "_"), "Request could not be handled.")

    @app.errorhandler(Exception)
    def on_crash(exc: Exception) -> tuple[Response, int]:
        log.exception("unhandled error")  # the trace stays in the server log, never in the response
        return _error(500, "internal_error", "Something went wrong on the server.")

    return app
