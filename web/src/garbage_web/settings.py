"""Constants in one place so the server, the API and the tests agree."""
from __future__ import annotations

import os
from pathlib import Path

HOST = "127.0.0.1"  # loopback only: nobody else on the network can reach the app
PORT = 5062  # 5059 = no-SK web app, so both can run side by side

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MULTIPART_SLACK_BYTES = 64 * 1024  # multipart framing adds a little to the body; exact file limit is checked later
# 50 megapixels: an iPhone 48 MP photo must pass, a "decompression bomb" must not.
MAX_PIXELS = 50_000_000

DEFAULT_THRESHOLD = 0.70
SLIDER_MIN = 0.40
SLIDER_MAX = 0.95
SLIDER_STEP = 0.05

# web/ (this file is web/src/garbage_web/settings.py)
WEB_ROOT = Path(__file__).resolve().parents[2]
# Swap the model by replacing the files in this folder, or point GARBAGE_MODEL_DIR somewhere else.
MODEL_DIR = Path(os.environ.get("GARBAGE_MODEL_DIR", str(WEB_ROOT / "model")))
MODEL_FILE = "garbage_cnn.keras"
CONFIG_FILE = "config.json"
THRESHOLD_TABLE_FILE = "confidence_threshold_table.csv"
