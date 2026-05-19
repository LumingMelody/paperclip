"""Pydantic request/response models for the RAG HTTP API."""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal

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
    translate: Literal["auto", "off"] = "auto"


class SearchChunk(BaseModel):
    id: str
    text: str
    score: float | None = None
    file_path: str | None = None
    reference_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class KGEntity(BaseModel):
    name: str
    type: str | None = None
    description: str | None = None
    source_id: str | None = None
    file_path: str | None = None
    reference_id: str | None = None


class KGRelation(BaseModel):
    src: str
    tgt: str
    description: str | None = None
    keywords: str | None = None
    weight: float | None = None
    source_id: str | None = None
    file_path: str | None = None
    reference_id: str | None = None


class SearchReference(BaseModel):
    reference_id: str
    file_path: str


class SearchMeta(BaseModel):
    translation: Literal["passthrough", "translated", "fallback"] | None = None
    original_query: str | None = None
    translated_query: str | None = None
    translate_ms: int | None = None
    fallback_reason: str | None = None


class SearchResponse(BaseModel):
    answer: str
    chunks: list[SearchChunk] = Field(default_factory=list)
    entities: list[KGEntity] = Field(default_factory=list)
    relations: list[KGRelation] = Field(default_factory=list)
    references: list[SearchReference] = Field(default_factory=list)
    meta: SearchMeta | None = None


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
