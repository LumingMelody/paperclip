"""Configure loguru sinks for paperclip-rag.

Adds a daily-rotated file sink under `log_dir`. Keeps the default stderr sink
so uvicorn output still appears in the terminal.
"""
from __future__ import annotations

import sys
from pathlib import Path

from loguru import logger

_CONFIGURED_DIRS: set[Path] = set()


def configure_logging(log_dir: Path) -> None:
    """Idempotent. Safe to call multiple times during reload/dev."""
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    if log_dir in _CONFIGURED_DIRS:
        return
    logger.remove()
    logger.add(sys.stderr, level="INFO")
    logger.add(
        log_dir / "paperclip-rag-{time:YYYY-MM-DD}.log",
        level="INFO",
        rotation="00:00",
        retention="14 days",
        encoding="utf-8",
        enqueue=True,
    )
    _CONFIGURED_DIRS.add(log_dir)
