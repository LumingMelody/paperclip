"""Async client for LM Studio OpenAI-compatible HTTP API."""
from __future__ import annotations

from typing import Any

import httpx
import numpy as np
from loguru import logger
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)


class LMStudioUnavailable(RuntimeError):
    """LM Studio HTTP endpoint cannot be reached."""


class ModelNotLoaded(RuntimeError):
    """A required model is not present in /v1/models."""


_TRANSPORT_ERRORS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.RemoteProtocolError,
)


def _should_retry(exc: BaseException) -> bool:
    """Retry on transport errors and 5xx HTTP responses."""
    if isinstance(exc, _TRANSPORT_ERRORS):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return 500 <= exc.response.status_code < 600
    return False


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
        retry=retry_if_exception(_should_retry),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def _embed_once(self, texts: list[str]) -> np.ndarray:
        r = await self._client.post(
            f"{self.base_url}/embeddings",
            json={"model": self.embedding_model, "input": texts},
        )
        r.raise_for_status()
        data = r.json()["data"]
        data_sorted = sorted(data, key=lambda d: d["index"])
        return np.array([d["embedding"] for d in data_sorted], dtype=np.float32)

    async def embed(self, texts: list[str]) -> np.ndarray:
        try:
            return await self._embed_once(texts)
        except _TRANSPORT_ERRORS as e:
            raise LMStudioUnavailable(str(e)) from e

    @retry(
        retry=retry_if_exception(_should_retry),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def _chat_once(
        self,
        prompt: str,
        system_prompt: str | None,
        history: list[dict[str, Any]] | None,
        temperature: float | None,
        max_tokens: int | None,
        model: str | None,
    ) -> str:
        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": prompt})

        payload: dict[str, Any] = {
            "model": model if model is not None else self.llm_model,
            "messages": messages,
            "stream": False,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        r = await self._client.post(
            f"{self.base_url}/chat/completions",
            json=payload,
        )
        r.raise_for_status()
        choices = r.json().get("choices", [])
        if not choices:
            raise LMStudioUnavailable("empty choices in chat completion response")
        return choices[0]["message"]["content"]

    async def chat(
        self,
        prompt: str,
        system_prompt: str | None = None,
        history: list[dict[str, Any]] | None = None,
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> str:
        try:
            return await self._chat_once(
                prompt, system_prompt, history,
                temperature=temperature, max_tokens=max_tokens, model=model,
            )
        except _TRANSPORT_ERRORS as e:
            raise LMStudioUnavailable(str(e)) from e

    async def probe_embedding_dim(self) -> int:
        """Return the dimensionality of a single-element embedding batch."""
        arr = await self.embed(["probe"])
        return int(arr.shape[1])

    async def aclose(self) -> None:
        await self._client.aclose()
