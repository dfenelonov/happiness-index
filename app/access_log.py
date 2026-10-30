"""Access-лог без ПДн и секретов: без IP и query-строки, токены в пути замаскированы.

Встроенный access-лог uvicorn выключен (--no-access-log): он пишет IP и полный URL.
"""

import logging
import re
import time

from fastapi import FastAPI, Request

log = logging.getLogger("app.access")

# Секретные части пути: токен отчёта (ссылка из письма) и ссылка для команды.
SECRET_PATHS = (
    (re.compile(r"^/report/[^/]+?(\.pdf|/tracker)?$"), r"/report/***\1"),
    (re.compile(r"^/internal/.+$"), "/internal/***"),
)


def redact_path(path: str) -> str:
    for pattern, replacement in SECRET_PATHS:
        path, n = pattern.subn(replacement, path)
        if n:
            break
    return path


def install(app: FastAPI) -> None:
    @app.middleware("http")
    async def access_log(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        if request.url.path != "/healthz":
            log.info(
                "%s %s %d %.0fms",
                request.method,
                redact_path(request.url.path),
                response.status_code,
                (time.perf_counter() - started) * 1000,
            )
        return response
