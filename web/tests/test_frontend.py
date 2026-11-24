"""Static checks on the page plus a run of the Node test suites."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from .conftest import ClientMaker

WEB_ROOT = Path(__file__).resolve().parents[1]
STATIC = WEB_ROOT / "src" / "garbage_web" / "static"
SCRIPTS = ["camera_helpers.js", "crop_math.js", "decision.js", "file_rules.js", "detect_math.js", "app.js"]


def test_node_suites_pass() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    # Explicit files: newer Node versions treat a bare directory argument as a module path.
    suites = sorted(str(p) for p in (WEB_ROOT / "tests_js").glob("*.test.js"))
    assert suites, "no Node test files found"
    done = subprocess.run(
        [node, "--test", *suites], cwd=WEB_ROOT, capture_output=True, text=True, timeout=120, check=False
    )
    assert done.returncode == 0, done.stdout[-3000:] + done.stderr[-2000:]


def test_index_has_no_external_urls(make_client: ClientMaker) -> None:
    html = make_client().get("/").get_data(as_text=True)
    for match in re.finditer(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", html):
        assert not match.group(1).lower().startswith(("http://", "https://", "//")), match.group(1)


def test_index_has_no_inline_script_or_style(make_client: ClientMaker) -> None:
    html = make_client().get("/").get_data(as_text=True)
    assert not re.search(r"<script(?![^>]*\bsrc=)", html)  # CSP forbids inline script
    assert "<style" not in html
    assert not re.search(r"\sstyle\s*=", html)


def test_scripts_load_in_order_before_app_js(make_client: ClientMaker) -> None:
    html = make_client().get("/").get_data(as_text=True)
    positions = [html.index(name) for name in SCRIPTS]
    assert positions == sorted(positions)


@pytest.mark.parametrize("name", [*SCRIPTS, "style.css"])
def test_static_files_are_served(make_client: ClientMaker, name: str) -> None:
    res = make_client().get(f"/static/{name}")
    assert res.status_code == 200
    assert len(res.data) > 100


def test_index_has_key_controls(make_client: ClientMaker) -> None:
    html = make_client().get("/").get_data(as_text=True)
    for element_id in (
        "file-input", "camera-btn", "camera-source", "refresh-cameras-btn", "capture-btn", "retake-btn",
        "crop-btn", "apply-crop-btn", "use-original-btn", "classify-btn", "threshold-slider",
        "threshold-hint", "result-card", "preview", "video",
        "detect-btn", "whole-btn", "det-overlay", "det-frame", "object-picker", "object-list",
    ):
        assert f'id="{element_id}"' in html, element_id
    assert 'min="0.4' in html and 'max="0.95"' in html and 'step="0.05"' in html
    assert ".heic" in html


def test_app_js_never_uses_innerhtml_or_storage() -> None:
    source = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "innerHTML" not in source
    assert "localStorage" not in source and "sessionStorage" not in source
