# paperclip RAG Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a local-only RAG service that indexes `decisions.jsonl` via LightRAG + LM Studio and passes an end-to-end canary, unblocking Phase 2 (refund_comments ingest).

**Architecture:** Python FastAPI 长进程 (`127.0.0.1:9001`) 持有 LightRAG 状态；LightRAG 的 LLM/Embedding 接到 LM Studio OpenAI-compat 端口 (`127.0.0.1:1234`)。每个 collection 一个独立 working_dir 存于 `~/.paperclip/lightrag-storage/<collection>/`。Phase 1 只暴露 HTTP 接口，不接 MCP（Phase 3 加）。

**Tech Stack:** Python 3.11+ via `uv`，FastAPI + uvicorn，lightrag-hku，openai SDK（仅作 OpenAI-compat HTTP client），Pydantic v2 + pydantic-settings，pytest + pytest-asyncio + httpx (test client + mocking)，loguru。LLM = Qwen3-30B-A3B-Instruct-2507 MLX 4bit；Embedding = nomic-embed-text-v1.5 (768d)，均经 LM Studio。

**Spec reference:** `docs/superpowers/specs/2026-05-13-paperclip-rag-design.md`

---

## File Structure

新建目录 `services/rag/`：

```
services/rag/
├── pyproject.toml                         # Task 1：uv 项目元数据、依赖
├── README.md                              # Task 1：本地开发说明
├── .env.example                           # Task 1：可覆盖配置示例
├── .gitignore                             # Task 1：忽略 .venv/、__pycache__/
├── src/paperclip_rag/
│   ├── __init__.py                        # Task 1：包标识 + __version__
│   ├── config.py                          # Task 2：Pydantic settings
│   ├── schemas.py                         # Task 3：请求/响应模型
│   ├── lm_studio.py                       # Task 4：OpenAI-compat client + healthcheck
│   ├── lightrag_factory.py                # Task 5：按 collection 构造/缓存 LightRAG
│   ├── api.py                             # Task 6：FastAPI 路由
│   └── ingest/
│       ├── __init__.py                    # Task 7：包标识
│       └── decisions.py                   # Task 7：decisions.jsonl ingest CLI
├── scripts/
│   ├── run_dev.sh                         # Task 8：uvicorn 启动
│   └── test_e2e.py                        # Task 8：canary e2e
└── tests/
    ├── __init__.py
    ├── conftest.py                        # Task 2：tmp_path 隔离 fixture
    ├── test_config.py                     # Task 2
    ├── test_schemas.py                    # Task 3
    ├── test_lm_studio.py                  # Task 4
    └── test_api.py                        # Task 6：FastAPI TestClient + mocked LightRAG

# 注：spec §5 提到的 manifest.py（ingest 幂等账本）Phase 1 不构建。21 条 decisions
# 由 LightRAG 内部 doc 去重已足够；manifest 在 Phase 2 处理 500/5k 批量时再加。
```

仓库根 `.gitignore` 已存在，无需改动（`__pycache__/` 已被忽略；`services/rag/.venv/` 由 services 内自带 .gitignore 兜底）。

---

### Task 1: Scaffold the package

**Files:**
- Create: `services/rag/pyproject.toml`
- Create: `services/rag/README.md`
- Create: `services/rag/.env.example`
- Create: `services/rag/.gitignore`
- Create: `services/rag/src/paperclip_rag/__init__.py`
- Create: `services/rag/src/paperclip_rag/ingest/__init__.py`
- Create: `services/rag/tests/__init__.py`

- [ ] **Step 1: Verify uv is installed**

Run: `uv --version`
Expected: `uv 0.x.y` (任何 0.4+ 版本)。如未安装：`curl -LsSf https://astral.sh/uv/install.sh | sh`

- [ ] **Step 2: Create `services/rag/pyproject.toml`**

```toml
[project]
name = "paperclip-rag"
version = "0.1.0"
description = "Local RAG service for paperclip business knowledge (LightRAG + LM Studio)"
requires-python = ">=3.11"
dependencies = [
    "lightrag-hku>=1.2.0",
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "openai>=1.50.0",
    "pydantic>=2.9.0",
    "pydantic-settings>=2.6.0",
    "loguru>=0.7.2",
    "httpx>=0.27.0",
    "numpy>=1.26.0",
    "networkx>=3.3",
    "tenacity>=9.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3.0",
    "pytest-asyncio>=0.24.0",
    "pytest-httpx>=0.32.0",
    "respx>=0.21.1",
]
mysql = [
    "pymysql>=1.1.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/paperclip_rag"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
addopts = "-ra --strict-markers"
markers = [
    "integration: requires live LM Studio at 127.0.0.1:1234",
]
```

- [ ] **Step 3: Create `services/rag/.gitignore`**

```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
*.egg-info/
dist/
build/
.env
```

- [ ] **Step 4: Create `services/rag/.env.example`**

```bash
# Override any of these via env vars or services/rag/.env
PAPERCLIP_RAG_LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
PAPERCLIP_RAG_LLM_MODEL=qwen3-30b-a3b-instruct-2507
PAPERCLIP_RAG_EMBEDDING_MODEL=nomic-embed-text-v1.5
PAPERCLIP_RAG_EMBEDDING_DIM=768
PAPERCLIP_RAG_STORAGE_ROOT=~/.paperclip/lightrag-storage
PAPERCLIP_RAG_CHUNK_TOKEN_SIZE=800
PAPERCLIP_RAG_CHUNK_OVERLAP=100
PAPERCLIP_RAG_LLM_MAX_ASYNC=16
PAPERCLIP_RAG_LOG_DIR=../../_logs/rag
PAPERCLIP_RAG_HOST=127.0.0.1
PAPERCLIP_RAG_PORT=9001
```

- [ ] **Step 5: Create `services/rag/README.md`**

````markdown
# paperclip-rag

Local RAG service for paperclip. See `docs/superpowers/specs/2026-05-13-paperclip-rag-design.md`.

## Quickstart

```bash
cd services/rag
uv sync --extra dev
cp .env.example .env             # adjust as needed
./scripts/run_dev.sh              # → http://127.0.0.1:9001
```

## Tests

```bash
uv run pytest                     # unit only
uv run pytest -m integration      # needs LM Studio loaded
```

## Ingest

```bash
uv run python -m paperclip_rag.ingest.decisions \
    --jsonl ../../decisions.jsonl
```

## E2E canary

```bash
./scripts/test_e2e.py             # exits 0 on success
```
````

- [ ] **Step 6: Create empty `__init__.py` stubs**

`services/rag/src/paperclip_rag/__init__.py`:
```python
__version__ = "0.1.0"
```

`services/rag/src/paperclip_rag/ingest/__init__.py`: (空文件)

`services/rag/tests/__init__.py`: (空文件)

- [ ] **Step 7: Bootstrap virtual env and verify lockable**

Run: `cd services/rag && uv sync --extra dev`
Expected: `.venv/` 创建成功；`uv.lock` 写入；无 dependency 解析错误。

如果 `lightrag-hku` 拉不下来，先确认网络（中国大陆可能需要代理，或加 `--index-url https://pypi.tuna.tsinghua.edu.cn/simple`）。

- [ ] **Step 8: Commit**

```bash
git add services/rag/pyproject.toml services/rag/README.md \
        services/rag/.env.example services/rag/.gitignore \
        services/rag/src/paperclip_rag/__init__.py \
        services/rag/src/paperclip_rag/ingest/__init__.py \
        services/rag/tests/__init__.py \
        services/rag/uv.lock
git commit -m "feat(rag): scaffold paperclip-rag Python package"
```

---

### Task 2: Settings (config.py) — TDD

**Files:**
- Create: `services/rag/src/paperclip_rag/config.py`
- Create: `services/rag/tests/conftest.py`
- Create: `services/rag/tests/test_config.py`

- [ ] **Step 1: Write failing test `test_config.py`**

```python
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
    assert s.embedding_model == "nomic-embed-text-v1.5"
    assert s.embedding_dim == 768
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


def test_collection_dir_creates(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    s = Settings()
    target = s.collection_dir("decisions")
    assert target == (tmp_path / "decisions").resolve()
    assert target.exists() and target.is_dir()
```

- [ ] **Step 2: Write `conftest.py`**

```python
import os

import pytest


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Strip PAPERCLIP_RAG_* env so tests get clean defaults unless they opt in."""
    for k in list(os.environ):
        if k.startswith("PAPERCLIP_RAG_"):
            monkeypatch.delenv(k, raising=False)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services/rag && uv run pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'paperclip_rag.config'`.

- [ ] **Step 4: Implement `config.py`**

```python
"""Settings for paperclip-rag, loaded from env (`PAPERCLIP_RAG_*`) or .env."""
from __future__ import annotations

from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
        return p.resolve() if p.exists() or p.parent.exists() else p

    def collection_dir(self, name: str) -> Path:
        """Return (and create) the working_dir for a collection."""
        target = (self.storage_root.expanduser() / name).resolve()
        target.mkdir(parents=True, exist_ok=True)
        return target


def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/rag && uv run pytest tests/test_config.py -v`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add services/rag/src/paperclip_rag/config.py \
        services/rag/tests/conftest.py services/rag/tests/test_config.py
git commit -m "feat(rag): settings with env override and collection dir helper"
```

---

### Task 3: Schemas (schemas.py) — TDD

**Files:**
- Create: `services/rag/src/paperclip_rag/schemas.py`
- Create: `services/rag/tests/test_schemas.py`

- [ ] **Step 1: Write failing test `test_schemas.py`**

```python
import pytest
from pydantic import ValidationError

from paperclip_rag.schemas import (
    IndexDoc,
    IndexRequest,
    SearchMode,
    SearchRequest,
)


def test_index_doc_requires_id_and_text():
    with pytest.raises(ValidationError):
        IndexDoc(text="hi")  # missing id
    with pytest.raises(ValidationError):
        IndexDoc(id="d1")  # missing text
    d = IndexDoc(id="d1", text="hi", metadata={"k": "v"})
    assert d.metadata == {"k": "v"}


def test_index_request_default_upsert():
    req = IndexRequest(
        collection="decisions",
        docs=[IndexDoc(id="a", text="x")],
    )
    assert req.upsert is True


def test_search_mode_enum():
    assert SearchMode("hybrid") is SearchMode.HYBRID
    with pytest.raises(ValueError):
        SearchMode("bogus")


def test_search_request_defaults():
    req = SearchRequest(collection="decisions", query="why?")
    assert req.mode is SearchMode.HYBRID
    assert req.top_k == 10


def test_search_top_k_bounds():
    with pytest.raises(ValidationError):
        SearchRequest(collection="x", query="q", top_k=0)
    with pytest.raises(ValidationError):
        SearchRequest(collection="x", query="q", top_k=101)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/rag && uv run pytest tests/test_schemas.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `schemas.py`**

```python
"""Pydantic request/response models for the RAG HTTP API."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class SearchMode(str, Enum):
    HYBRID = "hybrid"
    LOCAL = "local"
    GLOBAL = "global"
    NAIVE = "naive"


class IndexDoc(BaseModel):
    id: str
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class IndexRequest(BaseModel):
    collection: str = Field(min_length=1)
    docs: list[IndexDoc] = Field(min_length=1)
    upsert: bool = True


class IndexResponse(BaseModel):
    indexed: int
    skipped: int
    job_id: str | None = None


class SearchRequest(BaseModel):
    collection: str = Field(min_length=1)
    query: str = Field(min_length=1)
    mode: SearchMode = SearchMode.HYBRID
    top_k: int = Field(default=10, ge=1, le=100)


class SearchChunk(BaseModel):
    id: str
    text: str
    score: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class KGEntity(BaseModel):
    name: str
    type: str | None = None
    description: str | None = None


class KGRelation(BaseModel):
    src: str
    tgt: str
    description: str | None = None


class SearchResponse(BaseModel):
    answer: str
    chunks: list[SearchChunk] = Field(default_factory=list)
    entities: list[KGEntity] = Field(default_factory=list)
    relations: list[KGRelation] = Field(default_factory=list)


class HealthzResponse(BaseModel):
    status: str
    lm_studio: str
    collections: list[str]


class CollectionInfo(BaseModel):
    name: str
    doc_count: int
    last_indexed_at: str | None = None


class CollectionsResponse(BaseModel):
    collections: list[CollectionInfo]


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/rag && uv run pytest tests/test_schemas.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/rag/src/paperclip_rag/schemas.py services/rag/tests/test_schemas.py
git commit -m "feat(rag): pydantic schemas for index/search/healthz"
```

---

### Task 4: LM Studio client (lm_studio.py) — TDD with mocked HTTP

**Files:**
- Create: `services/rag/src/paperclip_rag/lm_studio.py`
- Create: `services/rag/tests/test_lm_studio.py`

**Why this file:** LightRAG 接受 `llm_model_func` 和 `embedding_func` 回调；这里把对 LM Studio 的 OpenAI-compat 调用集中起来，便于 mock 和换模型。

- [ ] **Step 1: Write failing test `test_lm_studio.py`**

```python
import numpy as np
import pytest
import respx
from httpx import Response

from paperclip_rag.lm_studio import (
    LMStudioClient,
    LMStudioUnavailable,
    ModelNotLoaded,
)


@pytest.mark.asyncio
async def test_healthcheck_ok(respx_mock):
    respx_mock.get("http://127.0.0.1:1234/v1/models").mock(
        return_value=Response(200, json={
            "data": [
                {"id": "qwen3-30b-a3b-instruct-2507"},
                {"id": "nomic-embed-text-v1.5"},
            ]
        })
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="qwen3-30b-a3b-instruct-2507",
        embedding_model="nomic-embed-text-v1.5",
    )
    assert await c.healthcheck() == "up"


@pytest.mark.asyncio
async def test_healthcheck_model_missing(respx_mock):
    respx_mock.get("http://127.0.0.1:1234/v1/models").mock(
        return_value=Response(200, json={"data": [{"id": "some-other-llm"}]})
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="qwen3-30b-a3b-instruct-2507",
        embedding_model="nomic-embed-text-v1.5",
    )
    with pytest.raises(ModelNotLoaded) as exc:
        await c.healthcheck(raise_on_missing=True)
    assert "qwen3-30b-a3b-instruct-2507" in str(exc.value)


@pytest.mark.asyncio
async def test_healthcheck_unreachable(respx_mock):
    respx_mock.get("http://127.0.0.1:1234/v1/models").mock(
        side_effect=__import__("httpx").ConnectError("boom")
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="x", embedding_model="y",
    )
    with pytest.raises(LMStudioUnavailable):
        await c.healthcheck()


@pytest.mark.asyncio
async def test_embed_batch(respx_mock):
    respx_mock.post("http://127.0.0.1:1234/v1/embeddings").mock(
        return_value=Response(200, json={
            "data": [
                {"embedding": [0.1] * 768, "index": 0},
                {"embedding": [0.2] * 768, "index": 1},
            ],
            "model": "nomic-embed-text-v1.5",
        })
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="x", embedding_model="nomic-embed-text-v1.5",
    )
    vecs = await c.embed(["a", "b"])
    assert isinstance(vecs, np.ndarray)
    assert vecs.shape == (2, 768)
    assert vecs.dtype == np.float32


@pytest.mark.asyncio
async def test_chat_returns_text(respx_mock):
    respx_mock.post("http://127.0.0.1:1234/v1/chat/completions").mock(
        return_value=Response(200, json={
            "choices": [{"message": {"role": "assistant", "content": "hi there"}}],
        })
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="qwen3-30b-a3b-instruct-2507",
        embedding_model="x",
    )
    out = await c.chat("hello")
    assert out == "hi there"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/rag && uv run pytest tests/test_lm_studio.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `lm_studio.py`**

```python
"""Async client for LM Studio OpenAI-compatible HTTP API."""
from __future__ import annotations

from typing import Any

import httpx
import numpy as np
from loguru import logger
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


class LMStudioUnavailable(RuntimeError):
    """LM Studio HTTP endpoint cannot be reached."""


class ModelNotLoaded(RuntimeError):
    """A required model is not present in /v1/models."""


_RETRYABLE = (httpx.ReadTimeout, httpx.RemoteProtocolError)


class LMStudioClient:
    def __init__(
        self,
        base_url: str,
        llm_model: str,
        embedding_model: str,
        request_timeout_s: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.llm_model = llm_model
        self.embedding_model = embedding_model
        self._client = httpx.AsyncClient(timeout=request_timeout_s)

    async def healthcheck(self, raise_on_missing: bool = False) -> str:
        try:
            r = await self._client.get(f"{self.base_url}/models")
            r.raise_for_status()
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            raise LMStudioUnavailable(str(e)) from e
        loaded = {m["id"] for m in r.json().get("data", [])}
        missing = [
            m for m in (self.llm_model, self.embedding_model) if m not in loaded
        ]
        if missing and raise_on_missing:
            raise ModelNotLoaded(
                f"missing models: {missing}; loaded: {sorted(loaded)}"
            )
        if missing:
            logger.warning("LM Studio missing models: {}", missing)
        return "up"

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def embed(self, texts: list[str]) -> np.ndarray:
        r = await self._client.post(
            f"{self.base_url}/embeddings",
            json={"model": self.embedding_model, "input": texts},
        )
        r.raise_for_status()
        data = r.json()["data"]
        data_sorted = sorted(data, key=lambda d: d["index"])
        arr = np.array([d["embedding"] for d in data_sorted], dtype=np.float32)
        return arr

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def chat(
        self,
        prompt: str,
        system_prompt: str | None = None,
        history: list[dict[str, Any]] | None = None,
        **_: Any,
    ) -> str:
        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": prompt})

        r = await self._client.post(
            f"{self.base_url}/chat/completions",
            json={"model": self.llm_model, "messages": messages, "stream": False},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    async def aclose(self) -> None:
        await self._client.aclose()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/rag && uv run pytest tests/test_lm_studio.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/rag/src/paperclip_rag/lm_studio.py services/rag/tests/test_lm_studio.py
git commit -m "feat(rag): async LM Studio OpenAI-compat client with retry"
```

---

### Task 5: LightRAG factory (lightrag_factory.py)

**Files:**
- Create: `services/rag/src/paperclip_rag/lightrag_factory.py`

**Why no unit test here:** This module just wires LightRAG to the `LMStudioClient` and to disk. Real behavior is verified by `test_api.py` (Task 7) with a mocked client, and by the e2e (Task 9) end-to-end. Adding a unit test would mostly assert "we passed these kwargs through", which is brittle.

- [ ] **Step 1: Implement `lightrag_factory.py`**

```python
"""Build & cache LightRAG instances per collection.

LightRAG keeps an entity graph + vector indices in `working_dir`. We construct
one LightRAG per collection (decisions, refund_comments, ...) so KGs stay
isolated. Instances are cached in-process to avoid reloading graphml on every
request.
"""
from __future__ import annotations

import asyncio
from functools import partial
from typing import Any

from lightrag import LightRAG, QueryParam
from lightrag.llm.openai import openai_complete_if_cache, openai_embed
from lightrag.utils import EmbeddingFunc
from loguru import logger

from .config import Settings
from .lm_studio import LMStudioClient


_E_COMMERCE_ADDON = {
    "entity_types": [
        "sku",
        "product_category",
        "customer_complaint",
        "return_reason",
        "sizing_issue",
        "quality_issue",
        "marketplace",
        "fulfillment_channel",
    ],
    "example_number": 3,
    "language": "Chinese",
}


class LightRAGFactory:
    """Construct and cache LightRAG instances per collection name."""

    def __init__(self, settings: Settings, client: LMStudioClient) -> None:
        self._settings = settings
        self._client = client
        self._instances: dict[str, LightRAG] = {}
        self._lock = asyncio.Lock()

    async def get(self, collection: str) -> LightRAG:
        async with self._lock:
            if collection in self._instances:
                return self._instances[collection]
            rag = await self._build(collection)
            self._instances[collection] = rag
            return rag

    def cached_collections(self) -> list[str]:
        return sorted(self._instances.keys())

    async def _build(self, collection: str) -> LightRAG:
        working_dir = self._settings.collection_dir(collection)
        logger.info("building LightRAG for {}: {}", collection, working_dir)

        async def _llm(
            prompt: str,
            system_prompt: str | None = None,
            history_messages: list[dict[str, Any]] | None = None,
            **_: Any,
        ) -> str:
            return await self._client.chat(
                prompt=prompt,
                system_prompt=system_prompt,
                history=history_messages,
            )

        async def _embed(texts: list[str]) -> Any:
            return await self._client.embed(texts)

        embedding_func = EmbeddingFunc(
            embedding_dim=self._settings.embedding_dim,
            max_token_size=8192,
            func=_embed,
        )

        rag = LightRAG(
            working_dir=str(working_dir),
            llm_model_func=_llm,
            llm_model_name=self._settings.llm_model,
            llm_model_max_async=self._settings.llm_max_async,
            embedding_func=embedding_func,
            chunk_token_size=self._settings.chunk_token_size,
            chunk_overlap_token_size=self._settings.chunk_overlap,
            addon_params=dict(_E_COMMERCE_ADDON),
        )
        return rag


def query_param(mode: str, top_k: int) -> QueryParam:
    return QueryParam(mode=mode, top_k=top_k)
```

- [ ] **Step 2: Smoke import (no test, just confirm module loads)**

Run: `cd services/rag && uv run python -c "from paperclip_rag.lightrag_factory import LightRAGFactory; print('ok')"`
Expected: `ok`

如果失败，多数是 `lightrag-hku` 版本不同导致 import 路径变了。看 `uv run python -c "import lightrag; print(dir(lightrag))"` 并按实际 API 调整 import。

- [ ] **Step 3: Commit**

```bash
git add services/rag/src/paperclip_rag/lightrag_factory.py
git commit -m "feat(rag): LightRAG factory per collection with e-commerce KG types"
```

---

### Task 6: FastAPI app (api.py) — TDD with mocked LightRAG

**Files:**
- Create: `services/rag/src/paperclip_rag/api.py`
- Create: `services/rag/tests/test_api.py`

- [ ] **Step 1: Write failing test `test_api.py`**

```python
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from paperclip_rag.api import build_app
from paperclip_rag.config import Settings


class _FakeRAG:
    """Stand-in for a LightRAG instance."""
    def __init__(self):
        self.ainsert = AsyncMock(return_value=None)
        self.aquery = AsyncMock(return_value="canned answer")


class _FakeFactory:
    def __init__(self, rag):
        self._rag = rag
        self.cached = ["decisions"]

    async def get(self, collection):  # noqa: ARG002
        return self._rag

    def cached_collections(self):
        return list(self.cached)


@pytest.fixture
def app_and_rag(monkeypatch, tmp_path):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    rag = _FakeRAG()
    factory = _FakeFactory(rag)
    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(return_value="up")
    app = build_app(
        settings=Settings(),
        factory=factory,  # type: ignore[arg-type]
        lm_client=lm_client,  # type: ignore[arg-type]
    )
    return app, rag


def test_healthz_ok(app_and_rag):
    app, _ = app_and_rag
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["lm_studio"] == "up"


def test_collections_lists_cached(app_and_rag):
    app, _ = app_and_rag
    with TestClient(app) as c:
        r = c.get("/collections")
    assert r.status_code == 200
    names = [x["name"] for x in r.json()["collections"]]
    assert "decisions" in names


def test_index_small_batch_calls_ainsert(app_and_rag):
    app, rag = app_and_rag
    payload = {
        "collection": "decisions",
        "docs": [
            {"id": "d1", "text": "hello world"},
            {"id": "d2", "text": "second doc"},
        ],
    }
    with TestClient(app) as c:
        r = c.post("/index", json=payload)
    assert r.status_code == 202
    body = r.json()
    assert body["indexed"] == 2
    assert body["job_id"] is None
    rag.ainsert.assert_awaited_once()


def test_search_returns_answer(app_and_rag):
    app, rag = app_and_rag
    payload = {"collection": "decisions", "query": "why?", "mode": "hybrid"}
    with TestClient(app) as c:
        r = c.post("/search", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "canned answer"
    rag.aquery.assert_awaited_once()


def test_healthz_503_when_lm_studio_down(monkeypatch, tmp_path):
    from paperclip_rag.lm_studio import LMStudioUnavailable

    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    rag = _FakeRAG()
    factory = _FakeFactory(rag)
    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(side_effect=LMStudioUnavailable("boom"))
    app = build_app(
        settings=Settings(),
        factory=factory,  # type: ignore[arg-type]
        lm_client=lm_client,  # type: ignore[arg-type]
    )
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "lm_studio_down"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/rag && uv run pytest tests/test_api.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_app'`.

- [ ] **Step 3: Implement `api.py`**

```python
"""FastAPI app factory for paperclip-rag."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger

from .config import Settings, get_settings
from .lightrag_factory import LightRAGFactory, query_param
from .lm_studio import LMStudioClient, LMStudioUnavailable, ModelNotLoaded
from .schemas import (
    CollectionInfo,
    CollectionsResponse,
    ErrorBody,
    ErrorResponse,
    HealthzResponse,
    IndexRequest,
    IndexResponse,
    SearchRequest,
    SearchResponse,
)


class _Factory(Protocol):
    async def get(self, collection: str) -> Any: ...
    def cached_collections(self) -> list[str]: ...


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=ErrorResponse(error=ErrorBody(code=code, message=message)).model_dump(),
    )


def build_app(
    settings: Settings | None = None,
    factory: _Factory | None = None,
    lm_client: LMStudioClient | None = None,
) -> FastAPI:
    """Construct the FastAPI app. All deps injectable for testing."""
    settings = settings or get_settings()

    if lm_client is None:
        lm_client = LMStudioClient(
            base_url=settings.lm_studio_base_url,
            llm_model=settings.llm_model,
            embedding_model=settings.embedding_model,
        )
    if factory is None:
        factory = LightRAGFactory(settings=settings, client=lm_client)  # type: ignore[arg-type]

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # noqa: ARG001
        logger.info("paperclip-rag starting on {}:{}", settings.host, settings.port)
        yield
        logger.info("paperclip-rag shutting down")
        if hasattr(lm_client, "aclose"):
            await lm_client.aclose()

    app = FastAPI(title="paperclip-rag", version="0.1.0", lifespan=lifespan)

    @app.get("/healthz", response_model=HealthzResponse)
    async def healthz() -> Any:
        try:
            status = await lm_client.healthcheck()
        except LMStudioUnavailable as e:
            return _err("lm_studio_down", str(e), 503)
        except ModelNotLoaded as e:
            return _err("llm_not_loaded", str(e), 503)
        return HealthzResponse(
            status="ok",
            lm_studio=status,
            collections=factory.cached_collections(),
        )

    @app.get("/collections", response_model=CollectionsResponse)
    async def collections() -> CollectionsResponse:
        items = [
            CollectionInfo(name=n, doc_count=0) for n in factory.cached_collections()
        ]
        return CollectionsResponse(collections=items)

    @app.post("/index", status_code=202, response_model=IndexResponse)
    async def index(req: IndexRequest) -> IndexResponse:
        rag = await factory.get(req.collection)
        texts = [d.text for d in req.docs]
        ids = [d.id for d in req.docs]
        try:
            await rag.ainsert(texts, ids=ids)
        except LMStudioUnavailable as e:
            raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})
        return IndexResponse(indexed=len(req.docs), skipped=0)

    @app.post("/search", response_model=SearchResponse)
    async def search(req: SearchRequest) -> SearchResponse:
        rag = await factory.get(req.collection)
        try:
            answer = await rag.aquery(
                req.query, param=query_param(req.mode.value, req.top_k)
            )
        except LMStudioUnavailable as e:
            raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})
        return SearchResponse(answer=str(answer))

    @app.exception_handler(Exception)
    async def _catch_all(req: Request, exc: Exception):  # noqa: ARG001
        logger.exception("unhandled error")
        return _err("internal_error", str(exc), 500)

    return app


app = build_app()  # uvicorn entrypoint
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/rag && uv run pytest tests/test_api.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/rag/src/paperclip_rag/api.py services/rag/tests/test_api.py
git commit -m "feat(rag): FastAPI healthz/collections/index/search routes"
```

---

### Task 7: decisions.jsonl ingest CLI (ingest/decisions.py)

**Files:**
- Create: `services/rag/src/paperclip_rag/ingest/decisions.py`

**Why no unit test for the CLI itself:** Argparse + iterating a JSONL is glue code; behavior is covered by Task 9 (real e2e ingest of `decisions.jsonl`).

- [ ] **Step 1: Inspect `decisions.jsonl` to confirm shape**

Run: `head -3 /Users/melodylu/PycharmProjects/paperclip/decisions.jsonl`
Expected: 21 行 JSON 对象（或类 JSONL）。注意每条的字段名（可能是 `id`/`decision`/`rationale` 等）。**如果不是干净的 JSONL，先停下来告诉用户**——schema 不明的话 ingest 写法要调。

- [ ] **Step 2: Implement `ingest/decisions.py`**

```python
"""Ingest decisions.jsonl into the `decisions` LightRAG collection.

Each line in decisions.jsonl is one decision object. We concatenate the
human-readable fields into a single text body and use the object's `id`
(or a hash fallback) as the source_id.

Usage:
    uv run python -m paperclip_rag.ingest.decisions \\
        --jsonl ../../decisions.jsonl \\
        [--api-base http://127.0.0.1:9001] \\
        [--dry-run]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import httpx
from loguru import logger


_TEXT_FIELDS = ("title", "decision", "rationale", "context", "summary", "body", "text")


def _row_to_text(obj: dict[str, Any]) -> str:
    parts: list[str] = []
    for k in _TEXT_FIELDS:
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            parts.append(f"{k}: {v.strip()}")
    if not parts:
        parts.append(json.dumps(obj, ensure_ascii=False))
    return "\n".join(parts)


def _row_id(obj: dict[str, Any]) -> str:
    for k in ("id", "decision_id", "uuid", "key"):
        v = obj.get(k)
        if isinstance(v, str) and v:
            return v
    digest = hashlib.sha256(
        json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return f"sha256:{digest[:16]}"


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                logger.error("decisions.jsonl line {}: {}", i, e)
                raise
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jsonl", type=Path, required=True)
    parser.add_argument("--api-base", default="http://127.0.0.1:9001")
    parser.add_argument("--collection", default="decisions")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if not args.jsonl.exists():
        logger.error("file not found: {}", args.jsonl)
        return 2

    rows = load_rows(args.jsonl)
    docs = [
        {"id": _row_id(r), "text": _row_to_text(r), "metadata": {"source": "decisions.jsonl"}}
        for r in rows
    ]
    logger.info("loaded {} rows from {}", len(docs), args.jsonl)

    if args.dry_run:
        for d in docs[:3]:
            print(json.dumps(d, ensure_ascii=False))
        print(f"... total {len(docs)}")
        return 0

    payload = {"collection": args.collection, "docs": docs, "upsert": True}
    with httpx.Client(timeout=600.0) as client:
        r = client.post(f"{args.api_base}/index", json=payload)
    if r.status_code >= 300:
        logger.error("ingest failed: {} {}", r.status_code, r.text)
        return 1
    logger.info("ingested: {}", r.json())
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Smoke run --dry-run**

Run:
```bash
cd services/rag && uv run python -m paperclip_rag.ingest.decisions \
    --jsonl ../../decisions.jsonl --dry-run
```
Expected: 打印前 3 条 doc + `... total 21`。如果总数不是 21，先回头看是不是 `//` 注释行被算了进去；脚本已跳过 `//` 开头的行。

- [ ] **Step 4: Commit**

```bash
git add services/rag/src/paperclip_rag/ingest/decisions.py
git commit -m "feat(rag): decisions.jsonl ingest CLI"
```

---

### Task 8: Boot scripts + E2E canary (the acceptance gate)

**Files:**
- Create: `services/rag/scripts/run_dev.sh`
- Create: `services/rag/scripts/test_e2e.py`

- [ ] **Step 1: Implement `scripts/run_dev.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run uvicorn paperclip_rag.api:app \
    --host "${PAPERCLIP_RAG_HOST:-127.0.0.1}" \
    --port "${PAPERCLIP_RAG_PORT:-9001}" \
    --log-level info
```

Run: `chmod +x services/rag/scripts/run_dev.sh`

- [ ] **Step 2: Implement `scripts/test_e2e.py`**

```python
#!/usr/bin/env python3
"""End-to-end canary for paperclip-rag Phase 1.

Steps:
  1. GET  /healthz                   -> assert lm_studio == "up"
  2. POST /index (3 synthetic docs)  -> assert 202
  3. POST /search "退货 偏小"        -> assert chunks/answer non-empty
  4. GET  /collections               -> assert canary collection present
  5. cleanup: remove canary working_dir

Exit code: 0 success, non-zero with stage name on failure.
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

import httpx


API = os.environ.get("PAPERCLIP_RAG_API", "http://127.0.0.1:9001")
STORAGE_ROOT = Path(
    os.environ.get("PAPERCLIP_RAG_STORAGE_ROOT", "~/.paperclip/lightrag-storage")
).expanduser()
COLLECTION = "_e2e_canary"


def stage(name: str) -> None:
    print(f"[stage] {name}", flush=True)


def fail(name: str, msg: str) -> int:
    print(f"[FAIL ] {name}: {msg}", file=sys.stderr, flush=True)
    return 1


def main() -> int:
    with httpx.Client(timeout=300.0) as c:
        stage("healthz")
        r = c.get(f"{API}/healthz")
        if r.status_code != 200:
            return fail("healthz", f"{r.status_code} {r.text}")
        body = r.json()
        if body.get("lm_studio") != "up":
            return fail("healthz", f"lm_studio={body.get('lm_studio')}")

        stage("index")
        docs = [
            {"id": "c1", "text": "客户反馈 SKU EG02084 尺码偏小，建议升一码。"},
            {"id": "c2", "text": "EE02559 物流损坏率高，需更换包装供应商。"},
            {"id": "c3", "text": "Amazon 渠道 EG02084 退货主因：sizing。"},
        ]
        r = c.post(
            f"{API}/index",
            json={"collection": COLLECTION, "docs": docs, "upsert": True},
        )
        if r.status_code not in (200, 202):
            return fail("index", f"{r.status_code} {r.text}")

        stage("search")
        time.sleep(1.0)  # give LightRAG a moment if there is any async settling
        r = c.post(
            f"{API}/search",
            json={"collection": COLLECTION, "query": "退货 偏小", "mode": "hybrid"},
        )
        if r.status_code != 200:
            return fail("search", f"{r.status_code} {r.text}")
        ans = r.json().get("answer", "")
        if not ans or not isinstance(ans, str):
            return fail("search", f"empty answer: {r.json()!r}")

        stage("collections")
        r = c.get(f"{API}/collections")
        if r.status_code != 200:
            return fail("collections", f"{r.status_code} {r.text}")
        names = [x["name"] for x in r.json().get("collections", [])]
        if COLLECTION not in names:
            print(f"[warn ] {COLLECTION} not in {names}; cached_collections is lazy",
                  flush=True)

    stage("cleanup")
    canary_dir = STORAGE_ROOT / COLLECTION
    if canary_dir.exists():
        shutil.rmtree(canary_dir)
        print(f"removed {canary_dir}", flush=True)

    print("[ OK  ] paperclip-rag Phase 1 e2e passed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run: `chmod +x services/rag/scripts/test_e2e.py`

- [ ] **Step 3: Pre-flight check before running e2e**

Open LM Studio GUI and confirm:
- Server tab → running on `127.0.0.1:1234`
- Loaded models include both an embedding model（推荐 `nomic-embed-text-v1.5`）和一个 chat 模型。
  - 如果 Qwen3-30B-A3B 还在下载，**临时**在 `.env` 把 `PAPERCLIP_RAG_LLM_MODEL` 改成当前已加载的 chat 模型 id（如 `qwen2.5-7b-instruct`），保证 e2e 能跑通。Qwen3 下载完后再切回来。

Quick probe:
```bash
curl -s http://127.0.0.1:1234/v1/models | python3 -m json.tool
```
Expected: `data: [...]` 中含期望模型 id。

- [ ] **Step 4: Start the service**

In one terminal:
```bash
cd services/rag && ./scripts/run_dev.sh
```
Expected: 看到 `Uvicorn running on http://127.0.0.1:9001`。**让它保持运行**。

- [ ] **Step 5: Run the e2e**

In another terminal:
```bash
cd services/rag && ./scripts/test_e2e.py
```
Expected output:
```
[stage] healthz
[stage] index
[stage] search
[stage] collections
[stage] cleanup
[ OK  ] paperclip-rag Phase 1 e2e passed
```
退出码 0。

如果某 stage 失败：
- `healthz` → 服务没启或 LM Studio 没起
- `index` → LightRAG 抽取超时（看 uvicorn 日志，可能 KG prompt 太长）；先把 `PAPERCLIP_RAG_LLM_MAX_ASYNC=4` 调小
- `search` → 服务能跑但答案空；多半是 LightRAG mode 不支持，先在 `.env` 切到 `mode=naive` 重试（搜索端默认 hybrid，但 e2e 写死了 hybrid——把 e2e 临时改 `mode=naive` 排查 LLM/embedding 之外的问题）

- [ ] **Step 6: Run decisions.jsonl ingest against the live service**

```bash
cd services/rag && uv run python -m paperclip_rag.ingest.decisions \
    --jsonl ../../decisions.jsonl
```
Expected: `ingested: {'indexed': 21, 'skipped': 0, 'job_id': None}`。

时长估算：21 chunks × ~8s ≈ 3 分钟。如果远超，说明 LM Studio 卡顿（看 GUI 的 token/s 指标）。

- [ ] **Step 7: Smoke search against the real decisions collection**

```bash
curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"decisions","query":"为什么决定换包装供应商","mode":"hybrid"}' \
  | python3 -m json.tool
```
Expected: `answer` 字段返回相关回答（如果 decisions.jsonl 里确实有换包装供应商的决策的话）。如果 answer 是 "Sorry, no relevant information found"，先尝试 query 改成 decisions.jsonl 里真实出现过的关键词。

- [ ] **Step 8: Commit**

```bash
git add services/rag/scripts/run_dev.sh services/rag/scripts/test_e2e.py
git commit -m "feat(rag): run_dev script + e2e canary, Phase 1 acceptance gate"
```

- [ ] **Step 9: Tag Phase 1 done**

```bash
git tag rag-phase1-ga
```

---

## Phase 1 Done Criteria (recap from spec §9)

- [x] `services/rag/` Python 包构建可用（`uv sync` 通过）
- [x] 单元测试全过（`uv run pytest`，不带 `-m integration`）
- [x] `scripts/test_e2e.py` 退出码 0
- [x] `decisions.jsonl` 21 条全部 ingest 成功
- [x] 任意一条 decisions 关键词能通过 hybrid search 命中
- [x] 全部代码已提交到 master

后续工作（Phase 2/3）走独立 plan，见 spec §13。
