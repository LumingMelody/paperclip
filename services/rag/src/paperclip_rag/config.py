"""Settings for paperclip-rag, loaded from env (`PAPERCLIP_RAG_*`) or .env."""
from __future__ import annotations

from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# services/rag/src/paperclip_rag/config.py → parents[4] is the paperclip repo root.
_REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PAPERCLIP_RAG_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # LM Studio
    lm_studio_base_url: str = "http://127.0.0.1:1234/v1"
    llm_model: str = "qwen3-30b-a3b-instruct-2507"
    embedding_model: str = "nomic-embed-text-v1.5"
    embedding_dim: int = 768

    # LightRAG
    storage_root: Path = Field(default=Path("~/.paperclip/lightrag-storage"))
    chunk_token_size: int = 800
    chunk_overlap: int = 100
    llm_max_async: int = 16

    # HTTP server
    host: str = "127.0.0.1"
    port: int = 9001

    # Logging
    log_dir: Path = Field(default=Path("../../_logs/rag"))

    @field_validator("storage_root", "log_dir", mode="before")
    @classmethod
    def _expand_paths(cls, v: str | Path) -> Path:
        p = Path(v).expanduser()
        if not p.is_absolute():
            p = _REPO_ROOT / p
        return p.resolve()

    def collection_dir(self, name: str) -> Path:
        """Return (and create) the working_dir for a collection."""
        target = (self.storage_root.expanduser() / name).resolve()
        target.mkdir(parents=True, exist_ok=True)
        return target


def get_settings() -> Settings:
    return Settings()
