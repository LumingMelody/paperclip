"""Build & cache LightRAG instances per collection.

LightRAG keeps an entity graph + vector indices in `working_dir`. We construct
one LightRAG per collection (decisions, refund_comments, ...) so KGs stay
isolated. Instances are cached in-process to avoid reloading graphml on every
request.
"""
from __future__ import annotations

import asyncio
from typing import Any

from lightrag import LightRAG, QueryParam
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
        # LightRAG >=1.3 requires async storage init before any insert/query.
        await rag.initialize_storages()
        from lightrag.kg.shared_storage import initialize_pipeline_status
        await initialize_pipeline_status()
        return rag


def query_param(mode: str, top_k: int) -> QueryParam:
    return QueryParam(mode=mode, top_k=top_k)
