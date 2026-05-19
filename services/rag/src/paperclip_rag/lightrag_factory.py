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


# Custom rag_response prompt overrides — A2 (suppresses LightRAG's stock
# "Document Title One/Two/Three" References hallucination by removing all
# References-section instructions from the system prompt). LightRAG uses
# `{context_data}` for KG modes and `{content_data}` for naive (sic, naming
# inconsistency upstream), so we define both.

_RAG_RESPONSE_PROMPT_BODY = """---Role---

You are an expert AI assistant specializing in synthesizing information from a \
provided knowledge base. Your primary function is to answer user queries accurately \
by ONLY using the information within the provided **Context**.

---Goal---

Generate a comprehensive, well-structured answer to the user query.
The answer must integrate relevant facts found in the **Context**.
Consider the conversation history if provided to maintain conversational flow and \
avoid repeating information.

---Instructions---

1. Step-by-Step Instruction:
  - Carefully determine the user's query intent in the context of the conversation \
history to fully understand the user's information need.
  - Scrutinize the **Context**. Identify and extract all pieces of information \
that are directly relevant to answering the user query.
  - Weave the extracted facts into a coherent and logical response. Your own \
knowledge must ONLY be used to formulate fluent sentences and connect ideas, NOT \
to introduce any external information.

2. Content & Grounding:
  - Strictly adhere to the provided context from the **Context**; do not invent, \
assume, or infer any information not explicitly stated.
  - If the answer cannot be found in the **Context**, state that you do not have \
enough information to answer. Do not attempt to guess.

3. Output Discipline:
  - 只输出答案正文；回答在最后一句结束；不要追加标题、尾注或来源列表。
  - Source attribution is handled by the application layer outside this prompt — \
do not embed it in the response body.

4. Formatting & Language:
  - The response MUST be in the same language as the user query.
  - The response MUST utilize Markdown formatting for enhanced clarity and structure \
(e.g., headings, bold text, bullet points).
  - The response should be presented in {response_type}.

5. Additional Instructions: {user_prompt}


---Context---

{CONTEXT_PLACEHOLDER}
"""

RAG_RESPONSE_PROMPT_KG = _RAG_RESPONSE_PROMPT_BODY.replace(
    "{CONTEXT_PLACEHOLDER}", "{context_data}"
)
RAG_RESPONSE_PROMPT_NAIVE = _RAG_RESPONSE_PROMPT_BODY.replace(
    "{CONTEXT_PLACEHOLDER}", "{content_data}"
)


def system_prompt_for(mode: str) -> str:
    """Return the appropriate response prompt for the LightRAG query mode.

    Modes local/global/hybrid/mix use the KG prompt (with `{context_data}`).
    Mode naive uses the naive prompt (with `{content_data}`).
    Mode bypass returns the KG prompt — bypass skips data retrieval, so the
    placeholder is never .format()'d; either prompt would work.
    """
    if mode == "naive":
        return RAG_RESPONSE_PROMPT_NAIVE
    return RAG_RESPONSE_PROMPT_KG


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
            enable_llm_cache=False,
        )
        # LightRAG >=1.3 requires async storage init before any insert/query.
        await rag.initialize_storages()
        from lightrag.kg.shared_storage import initialize_pipeline_status
        await initialize_pipeline_status()
        return rag


def query_param(mode: str, top_k: int) -> QueryParam:
    return QueryParam(mode=mode, top_k=top_k)
