"""Общие помощники для HTML-ответов (Jinja2 + HTMX)."""

from typing import Any

from fastapi import Request
from fastapi.responses import RedirectResponse, Response
from fastapi.templating import Jinja2Templates

COOKIE_CHOICE = "cookie_consent"  # yes/no — выбор в баннере cookie, ставится из app.js


def is_htmx(request: Request) -> bool:
    return request.headers.get("HX-Request") == "true"


def render(request: Request, name: str, context: dict[str, Any] | None = None, status: int = 200):
    templates: Jinja2Templates = request.app.state.templates
    settings = request.app.state.settings
    base = {
        "app_config": request.app.state.app_config,
        "base_url": settings.app_base_url.rstrip("/"),
        "metrika_id": settings.yandex_metrika_id,
        "cookie_choice": request.cookies.get(COOKIE_CHOICE),
    }
    return templates.TemplateResponse(request, name, base | (context or {}), status_code=status)


def redirect(request: Request, url: str) -> Response:
    """Редирект, который понимает и обычный браузер, и HTMX (полная навигация)."""
    if is_htmx(request):
        return Response(status_code=200, headers={"HX-Redirect": url})
    return RedirectResponse(url, status_code=303)
