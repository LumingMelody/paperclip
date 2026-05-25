"""One-off: drain the pending/failed/processing docs in `refund_comments_v3`.

Runs LightRAG's pipeline in-process — no HTTP timeout. Use to salvage a
collection where /index POSTs were cancelled mid-pipeline (e.g. 4h client
timeout on a single big batch).
"""
from __future__ import annotations

import asyncio
import sys

from loguru import logger

from paperclip_rag.config import Settings
from paperclip_rag.lightrag_factory import LightRAGFactory
from paperclip_rag.lm_studio import LMStudioClient
async def main() -> int:
    settings = Settings()
    client = LMStudioClient(
        base_url=settings.lm_studio_base_url,
        llm_model=settings.llm_model,
        embedding_model=settings.embedding_model,
    )
    factory = LightRAGFactory(settings=settings, client=client)
    collection = "refund_comments_v3"

    logger.info("opening LightRAG for {} (this initializes storages)", collection)
    rag = await factory.get(collection)

    logger.info("draining pipeline (pending + failed + processing)…")
    await rag.apipeline_process_enqueue_documents()
    logger.info("drain complete")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
