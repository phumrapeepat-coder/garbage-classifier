from __future__ import annotations

import os
from pathlib import Path

import pytest

from garbage_web import __main__ as entry
from garbage_web import settings

WEB_ROOT = Path(__file__).resolve().parents[1]


def test_settings_bind_loopback_on_5062() -> None:
    assert settings.HOST == "127.0.0.1"
    assert settings.PORT == 5062
    assert settings.MAX_UPLOAD_BYTES == 8 * 1024 * 1024
    assert settings.MAX_PIXELS == 50_000_000


def test_launcher_uses_the_project_port_and_loopback() -> None:
    launcher = WEB_ROOT / "Launch.command"
    text = launcher.read_text(encoding="utf-8")
    assert "127.0.0.1:5062" in text
    assert "iTCP:5062" in text
    assert "5057" not in text and "5058" not in text  # never touch the older apps' ports
    assert "api/health" in text
    assert os.access(launcher, os.X_OK), "Launch.command must be executable (chmod +x)"


def test_readme_mentions_port() -> None:
    assert "127.0.0.1:5062" in (WEB_ROOT / "README.md").read_text(encoding="utf-8")


def test_main_runs_flask_with_debug_off(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: dict[str, object] = {}

    class FakeApp:
        def run(self, **kwargs: object) -> None:
            calls.update(kwargs)

    class FakeService:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def ensure_loaded(self) -> bool:
            return True

    monkeypatch.setattr(entry, "ModelService", FakeService)
    monkeypatch.setattr(entry, "create_app", lambda service, table: FakeApp())
    entry.main()
    assert calls["host"] == "127.0.0.1"
    assert calls["port"] == 5062
    assert calls["debug"] is False
    assert calls["use_reloader"] is False
