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
