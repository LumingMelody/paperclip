from pathlib import Path

from loguru import logger

from paperclip_rag.logging_setup import configure_logging


def test_creates_log_files(tmp_path: Path):
    configure_logging(tmp_path)
    logger.info("hello from test")
    logger.complete()  # flush
    files = list(tmp_path.glob("*.log"))
    assert len(files) >= 1
    contents = files[0].read_text()
    assert "hello from test" in contents


def test_idempotent_multiple_calls(tmp_path: Path):
    configure_logging(tmp_path)
    configure_logging(tmp_path)  # second call must not crash
    logger.info("post-reconfigure")
    logger.complete()
    files = list(tmp_path.glob("*.log"))
    assert len(files) >= 1
