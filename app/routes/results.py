from typing import Literal
from urllib.parse import quote, urlencode, urlparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy import select

from app.db.models import Result, Session
from app.db.session import Db
from app.services.cards import cached_card
from app.services.events import log_event
from app.services.orders import paid_order, price_for
from app.services.results import percentile, vciom_line
from app.services.sessions import ensure_session, set_sid_cookie
from app.web import render

router = APIRouter()

CARD_CACHE_SECONDS = 86400


def _result_or_404(db: Db, public_id: str) -> Result:
    result = db.scalar(select(Result).where(Result.public_id == public_id))
    if result is None:
        raise HTTPException(404)
    return result


def share_links(base_url: str, result: Result) -> dict[str, str]:
    """Ссылки «Поделиться»: /r/{id}?ref={id} с UTM канала (SPEC §5)."""

    def url(medium: str) -> str:
        query = {"ref": result.public_id, "utm_source": "share", "utm_medium": medium}
        return f"{base_url}/r/{result.public_id}?{urlencode(query)}"

    text = f"Мой индекс счастья — {result.happiness_index}. А какой у тебя?"
    return {
        "vk": f"https://vk.com/share.php?url={quote(url('vk'), safe='')}",
        "tg": f"https://t.me/share/url?url={quote(url('tg'), safe='')}&text={quote(text, safe='')}",
        "copy": url("copy"),
        "card": f"/r/{result.public_id}/card.png",
    }


def result_context(request: Request, db: Db, result: Result, session: Session) -> dict:
    q = request.app.state.questionnaire
    app_config = request.app.state.app_config
    owner = session.id == result.session_id
    archetype = next(e for e in q.scoring.archetype.table if e.id == result.archetype_id)
    context = {
        "result": result,
        "owner": owner,
        "archetype_name": archetype.name,
        "archetype_text": q.texts.archetypes[archetype.id],
    }
    if not owner:
        return context
    # Флаг скрининга определяет блок только по данным из БД — параметры URL не влияют.
    context |= {
        "percentile": percentile(db, result, app_config.percentile.min_completed_tests),
        "vciom": vciom_line(app_config, result.vciom_answer),
        "leaks": [q.texts.domains[d] for d in result.leaks],
        "show_support": result.screening_flag,
        "show_paywall": not result.screening_flag,
        "share": share_links(request.app.state.settings.app_base_url.rstrip("/"), result),
    }
    if not result.screening_flag:
        context |= {
            "price": price_for(db, session, app_config.pricing.ab_variants_rub),
            "refund_days": app_config.pricing.refund_days,
            "paid": paid_order(db, session) is not None,
        }
    return context


@router.get("/r/{public_id}", response_class=HTMLResponse)
def result_page(public_id: str, request: Request, db: Db):
    result = _result_or_404(db, public_id)
    settings = request.app.state.settings
    # Гость по ссылке шеринга получает новую сессию с ref и UTM из URL.
    session, sid = ensure_session(db, request, settings)
    owner = session.id == result.session_id
    log_event(db, session, "result_view", mode="owner" if owner else "guest")
    if owner and result.screening_flag:
        log_event(db, session, "screening_flag_shown")
    response = render(request, "result.html", result_context(request, db, result, session))
    set_sid_cookie(response, sid, settings)
    return response


def _card(request: Request, db: Db, public_id: str, kind: Literal["card", "og"]) -> FileResponse:
    result = _result_or_404(db, public_id)
    q = request.app.state.questionnaire
    settings = request.app.state.settings
    archetype = next(e for e in q.scoring.archetype.table if e.id == result.archetype_id)
    path = cached_card(
        settings.cache_dir,
        result.public_id,
        kind,
        result.happiness_index,
        archetype.name,
        request.app.state.app_config.site_name,
        urlparse(settings.app_base_url).netloc,
    )
    headers = {"Cache-Control": f"public, max-age={CARD_CACHE_SECONDS}"}
    return FileResponse(path, media_type="image/png", headers=headers)


@router.get("/r/{public_id}/card.png")
def card_png(public_id: str, request: Request, db: Db) -> FileResponse:
    return _card(request, db, public_id, "card")


@router.get("/r/{public_id}/og.png")
def og_png(public_id: str, request: Request, db: Db) -> FileResponse:
    return _card(request, db, public_id, "og")
