from pathlib import Path

import pytest

from paperclip_rag.config import Settings


def test_defaults(monkeypatch):
    for key in list(monkeypatch._setitem):  # paranoia
        pass
    # Clear any env overrides from the shell
    for k in list(__import__("os").environ):
        if k.startswith("PAPERCLIP_RAG_"):
            monkeypatch.delenv(k, raising=False)

    s = Settings()
    assert s.lm_studio_base_url == "http://127.0.0.1:1234/v1"
    assert s.llm_model == "qwen3-30b-a3b-instruct-2507"
    assert s.embedding_model == "text-embedding-bge-m3"
    assert s.embedding_dim == 1024
    assert s.chunk_token_size == 800
    assert s.chunk_overlap == 100
    assert s.llm_max_async == 16
    assert s.host == "127.0.0.1"
    assert s.port == 9001


def test_env_override(monkeypatch):
    monkeypatch.setenv("PAPERCLIP_RAG_PORT", "9999")
    monkeypatch.setenv("PAPERCLIP_RAG_LLM_MODEL", "custom-llm")
    s = Settings()
    assert s.port == 9999
    assert s.llm_model == "custom-llm"


def test_storage_root_expands_user(monkeypatch, tmp_path):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path / "store"))
    s = Settings()
    assert isinstance(s.storage_root, Path)
    assert s.storage_root.is_absolute()


def test_storage_root_expands_tilde(monkeypatch):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", "~/paperclip-rag-test-dir")
    s = Settings()
    assert "~" not in str(s.storage_root)
    assert str(s.storage_root).startswith(str(Path.home()))


def test_relative_log_dir_anchored_to_repo_root(monkeypatch):
    # Default log_dir is "_logs/rag" → repo_root/_logs/rag.
    # conftest pins PAPERCLIP_RAG_LOG_DIR to tmp; drop it here to exercise the
    # production default.
    monkeypatch.delenv("PAPERCLIP_RAG_LOG_DIR", raising=False)
    s = Settings()
    assert s.log_dir.is_absolute()
    assert s.log_dir.parts[-2:] == ("_logs", "rag")
    # Sanity: must be INSIDE repo root, not above it
    from paperclip_rag.config import _REPO_ROOT
    assert str(s.log_dir).startswith(str(_REPO_ROOT))


def test_collection_dir_creates(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    s = Settings()
    target = s.collection_dir("decisions")
    assert target == (tmp_path / "decisions").resolve()
    assert target.exists() and target.is_dir()


def test_translation_llm_model_defaults_to_none(monkeypatch):
    monkeypatch.delenv("PAPERCLIP_RAG_TRANSLATION_LLM_MODEL", raising=False)
    from paperclip_rag.config import Settings
    s = Settings()
    assert s.translation_llm_model is None


def test_translation_llm_model_reads_env(monkeypatch):
    monkeypatch.setenv("PAPERCLIP_RAG_TRANSLATION_LLM_MODEL", "qwen3-4b")
    from paperclip_rag.config import Settings
    s = Settings()
    assert s.translation_llm_model == "qwen3-4b"
