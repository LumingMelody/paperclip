import os

import pytest


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Strip PAPERCLIP_RAG_* env so tests get clean defaults unless they opt in."""
    for k in list(os.environ):
        if k.startswith("PAPERCLIP_RAG_"):
            monkeypatch.delenv(k, raising=False)
