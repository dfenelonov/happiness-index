import secrets
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse

from app.db.session import Db
from app.services.cards import cached_png, landing_og_path, render_landing_og
from app.services.events import log_event
from app.services.sessions import (
    REF_PATTERN,
    UTM_KEYS,
    ensure_session,
    mark_internal,
    set_internal_cookie,
    set_sid_cookie,
)
from app.web import redirect, render

router = APIRouter()

# Заглушки до финальных текстов владельца (SPEC §3.8, docs/LEGAL.md).
LEGAL_PAGES = {
    "offer": "Публичная оферта",
    "privacy": "Политика обработки персональных данных",
    "consent": "Согласие на обработку персональных данных",
    "cookies": "Политика использования cookie",
}


@router.get("/", response_class=HTMLResponse)
def landing(request: Request, db: Db):
    session, sid = ensure_session(db, request, request.app.state.settings)
    params = request.query_params
    ref = params.get("ref")
    utm = {k: params[k] for k in UTM_KEYS if params.get(k)}
    log_event(
        db, session, "landing_view", ref=ref if ref and REF_PATTERN.fullmatch(ref) else None, **utm
    )
    response = render(request, "landing.html")
    set_sid_cookie(response, sid, request.app.state.settings)
    return response


@router.get("/internal/{token}")
def internal_link(token: str, request: Request, db: Db):
    """Секретная ссылка для команды: браузер помечается как внутренний (cookie internal=1),
    его сессии не попадают в метрики админки по умолчанию."""
    settings = request.app.state.settings
    expected = settings.internal_link_token
    if not expected or not secrets.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(404)
    session, sid = ensure_session(db, request, settings)
    mark_internal(db, session)
    response = redirect(request, "/")
    set_sid_cookie(response, sid, settings)
    set_internal_cookie(response, settings)
    return response


@router.get("/og.png")
def landing_og(request: Request) -> FileResponse:
    app_config = request.app.state.app_config
    settings = request.app.state.settings
    texts = (
        app_config.headline,
        app_config.landing.subheadline,
        app_config.site_name,
        urlparse(settings.app_base_url).netloc,
    )
    path = cached_png(
        landing_og_path(settings.cache_dir, *texts), lambda: render_landing_og(*texts)
    )
    return FileResponse(
        path, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"}
    )


@router.get("/about-method", response_class=HTMLResponse)
def about_method(request: Request):
    """Авторы и источники шкал (docs/LEGAL.md, «Методики») — из questionnaire.yaml."""
    blocks = [b for b in request.app.state.questionnaire.blocks if b.source]
    return render(request, "about_method.html", {"blocks": blocks})


def _legal_page(slug: str, title: str):
    def page(request: Request):
        return render(request, "legal_stub.html", {"title": title, "slug": slug})

    page.__name__ = f"legal_{slug}"
    return page


for _slug, _title in LEGAL_PAGES.items():
    router.add_api_route(f"/{_slug}", _legal_page(_slug, _title), response_class=HTMLResponse)
