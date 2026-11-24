"""`python -m garbage_web` (with PYTHONPATH=src): build the service, warm it up, serve on 127.0.0.1."""
from __future__ import annotations

import logging

from garbage_web import settings
from garbage_web.app import create_app
from garbage_web.services.model_service import ModelService
from garbage_web.utils.model_files import ModelFileError, load_config, load_threshold_table

log = logging.getLogger("garbage_web")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        config = load_config(settings.MODEL_DIR / settings.CONFIG_FILE)
        table = load_threshold_table(settings.MODEL_DIR / settings.THRESHOLD_TABLE_FILE)
    except ModelFileError:
        log.exception("invalid model files - refusing to start")
        raise
    service = ModelService(settings.MODEL_DIR / settings.MODEL_FILE, config)
    service.ensure_loaded()  # warm-up so the first click is fast; a failure is logged and /api/health says 503
    app = create_app(service, table)
    # debug off (the debugger would allow code execution); reloader off (it would load the model twice).
    app.run(host=settings.HOST, port=settings.PORT, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
