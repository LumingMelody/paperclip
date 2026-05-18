"""FastAPI app factory for paperclip-rag."""
from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger

from .config import Settings, get_settings
from .lightrag_factory import LightRAGFactory, query_param
from .lm_studio import LMStudioClient, LMStudioUnavailable, ModelNotLoaded
from .query_translator import TranslationResult, resolve_query
from .schemas import (
    CollectionInfo,
    CollectionsResponse,
    ErrorBody,
    ErrorResponse,
    HealthzResponse,
    IndexRequest,
    IndexResponse,
    SearchMeta,
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
        from .logging_setup import configure_logging
        configure_logging(settings.log_dir)
        # Startup dim probe: refuse to start if embedding dim != settings.embedding_dim.
        # Soft-fail if LM Studio is unreachable (logs warning, lets dev workflows proceed).
        try:
            _probe_arr = await lm_client.embed(["probe"])
            actual_dim = int(_probe_arr.shape[1])
            if actual_dim != settings.embedding_dim:
                raise RuntimeError(
                    f"embedding dim mismatch: settings={settings.embedding_dim} "
                    f"but probe returned {actual_dim} (model={settings.embedding_model})"
                )
            logger.info("embedding dim probe passed: {}", actual_dim)
        except LMStudioUnavailable as e:
            logger.warning(
                "LM Studio unreachable at startup; skipping dim probe. /healthz will report. {}",
                e,
            )
        logger.info("paperclip-rag starting on {}:{}", settings.host, settings.port)
        yield
        logger.info("paperclip-rag shutting down")
        aclose = getattr(lm_client, "aclose", None)
        if aclose is not None and inspect.iscoroutinefunction(aclose):
            await aclose()

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
            tx: TranslationResult = await resolve_query(
                req.query,
                translate=req.translate,
                lm_client=lm_client,
                llm_model=settings.translation_llm_model,
            )
        except LMStudioUnavailable as e:
            raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})

        try:
            answer = await rag.aquery(
                tx.text, param=query_param(req.mode.value, req.top_k)
            )
        except LMStudioUnavailable as e:
            raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})

        meta = SearchMeta(
            translation=tx.status,
            original_query=tx.original if tx.status != "passthrough" else None,
            translated_query=tx.text if tx.status == "translated" else None,
            translate_ms=tx.translate_ms if tx.status != "passthrough" else None,
            fallback_reason=tx.fallback_reason,
        )
        logger.info(
            "search collection={} query_len={} cjk={} translation={} translate_ms={}",
            req.collection,
            len(req.query),
            tx.status != "passthrough" or tx.translate_ms > 0,  # cjk approx
            tx.status,
            tx.translate_ms,
        )
        return SearchResponse(answer=str(answer), meta=meta)

    @app.exception_handler(Exception)
    async def _catch_all(req: Request, exc: Exception):  # noqa: ARG001
        logger.exception("unhandled error")
        return _err("internal_error", str(exc), 500)

    return app


def create_app() -> FastAPI:
    """uvicorn entrypoint. Use with `uvicorn paperclip_rag.api:create_app --factory`."""
    return build_app()
