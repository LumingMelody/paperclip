import os

import pytest


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch, tmp_path):
    """Strip PAPERCLIP_RAG_* env AND chdir into tmp_path so production `.env`
    (relative to cwd) cannot leak into Settings() defaults under test. Pin
    log_dir into tmp so test lifespan logging doesn't pollute the repo or
    user home."""
    for k in list(os.environ):
        if k.startswith("PAPERCLIP_RAG_"):
            monkeypatch.delenv(k, raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PAPERCLIP_RAG_LOG_DIR", str(tmp_path / "_logs"))
