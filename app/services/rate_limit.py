"""Простая защита от ботов (SPEC §8): скользящее окно в памяти процесса, ключ — IP клиента.

Работает в пределах одного процесса uvicorn — так и запускаем MVP (docs/DEPLOY.md).
"""

import threading
import time
from collections import deque
from collections.abc import Callable

from fastapi import HTTPException, Request

WINDOW_SECONDS = 60.0
MAX_KEYS = 50_000  # при превышении чистим пустые окна, чтобы память не росла


class RateLimiter:
    def __init__(self, limits: dict[str, int], clock: Callable[[], float] = time.monotonic):
        self.limits = limits
        self._clock = clock
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, bucket: str, key: str) -> bool:
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault((bucket, key), deque())
            while hits and hits[0] <= now - WINDOW_SECONDS:
                hits.popleft()
            if len(hits) >= self.limits[bucket]:
                return False
            hits.append(now)
            if len(self._hits) > MAX_KEYS:
                self._purge(now)
            return True

    def _purge(self, now: float) -> None:
        stale = [k for k, v in self._hits.items() if not v or v[-1] <= now - WINDOW_SECONDS]
        for k in stale:
            del self._hits[k]


def rate_limit(bucket: str) -> Callable[[Request], None]:
    """FastAPI-зависимость: 429, если с этого IP больше лимита запросов в минуту."""

    def dependency(request: Request) -> None:
        limiter: RateLimiter = request.app.state.rate_limiter
        key = request.client.host if request.client else "unknown"
        if not limiter.allow(bucket, key):
            raise HTTPException(
                429,
                "Слишком много запросов. Попробуй через минуту.",
                headers={"Retry-After": str(int(WINDOW_SECONDS))},
            )

    return dependency
