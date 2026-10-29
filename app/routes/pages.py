from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.db.session import Db
from app.services.events import log_event
from app.services.sessions import REF_PATTERN, UTM_KEYS, ensure_session, set_sid_cookie
from app.web import render

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


def _legal_page(slug: str, title: str):
    def page(request: Request):
        return render(request, "legal_stub.html", {"title": title, "slug": slug})

    page.__name__ = f"legal_{slug}"
    return page


for _slug, _title in LEGAL_PAGES.items():
    router.add_api_route(f"/{_slug}", _legal_page(_slug, _title), response_class=HTMLResponse)
