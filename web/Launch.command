#!/bin/bash
# Double-click launcher (macOS) or `bash Launch.command` (Linux).
# First run: creates .venv and installs requirements (needs internet, ~500 MB, a few minutes).
# Every run: starts the local server and opens http://127.0.0.1:5062 once the model is loaded.
cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  read -r -p "Press Enter to close..." _
  exit 1
}

# ---- first-run setup ------------------------------------------------------------------------
if [ ! -x ".venv/bin/python" ]; then
  PY=""
  # TensorFlow 2.21 supports Python 3.10-3.13 only.
  for cand in python3.12 python3.13 python3.11 python3.10 python3; do
    if command -v "$cand" >/dev/null 2>&1; then
      if "$cand" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
        PY="$cand"
        break
      fi
    fi
  done
  if [ -z "$PY" ]; then
    echo "ERROR: Python 3.10, 3.11, 3.12 or 3.13 is needed (TensorFlow does not support other versions)."
    echo "Install Python 3.12 from https://www.python.org/downloads/ and run this again."
    pause_and_exit
  fi
  echo "First run: setting up with $PY ($("$PY" --version 2>&1)). This downloads about 500 MB once."
  "$PY" -m venv .venv || { echo "ERROR: could not create .venv"; pause_and_exit; }
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  if ! .venv/bin/python -m pip install -r requirements.txt; then
    echo "ERROR: installing the requirements failed (see the messages above)."
    echo "Note: TensorFlow has no build for Intel Macs; it needs an Apple Silicon Mac, Windows or Linux."
    rm -rf .venv
    pause_and_exit
  fi
  echo "Setup done."
fi

# Already set up: install anything new in requirements.txt (e.g. OpenCV for object detection).
if ! .venv/bin/python -c "import cv2" >/dev/null 2>&1; then
  echo "Installing new requirements (OpenCV, about 40 MB)..."
  .venv/bin/python -m pip install -r requirements.txt || { echo "ERROR: installing the requirements failed."; pause_and_exit; }
fi

# ---- start ----------------------------------------------------------------------------------
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:5062 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: port 5062 is already in use by another program."
  echo "Stop that program (see: lsof -nP -iTCP:5062 -sTCP:LISTEN) and run this again."
  pause_and_exit
fi

OPENER="open"
command -v open >/dev/null 2>&1 || OPENER="xdg-open"

# Open the page only once /api/health answers 200 (model warm-up time varies); give up after ~90 s.
(
  for _ in $(seq 1 90); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5062/api/health)" = "200" ]; then
      "$OPENER" "http://127.0.0.1:5062" >/dev/null 2>&1
      exit 0
    fi
    sleep 1
  done
) &

echo "Starting... the page opens by itself. Keep this window open; close it to stop the app."
# src layout: no pip install of this project is needed, PYTHONPATH points at the package.
PYTHONPATH=src exec .venv/bin/python -m garbage_web
