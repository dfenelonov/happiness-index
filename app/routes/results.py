from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import select

from app.db.models import Result
from app.db.session import Db
from app.services.results import percentile, vciom_line
from app.services.sessions import ensure_session, set_sid_cookie
from app.web import render

router = APIRouter()


@router.get("/r/{public_id}", response_class=HTMLResponse)
def result_page(public_id: str, request: Request, db: Db):
    result = db.scalar(select(Result).where(Result.public_id == public_id))
    if result is None:
        raise HTTPException(404)
    settings = request.app.state.settings
    q = request.app.state.questionnaire
    app_config = request.app.state.app_config

    # Гость по ссылке шеринга получает новую сессию с ref и UTM из URL.
    session, sid = ensure_session(db, request, settings)
    owner = session.id == result.session_id
    archetype = next(e for e in q.scoring.archetype.table if e.id == result.archetype_id)

    context = {
        "result": result,
        "owner": owner,
        "archetype_name": archetype.name,
        "archetype_text": q.texts.archetypes[archetype.id],
    }
    if owner:
        # Флаг скрининга определяет блок только по данным из БД — параметры URL не влияют.
        context |= {
            "percentile": percentile(db, result, app_config.percentile.min_completed_tests),
            "vciom": vciom_line(q, app_config, result.vciom_answer),
            "leaks": [q.texts.domains[d] for d in result.leaks],
            "show_support": result.screening_flag,
            "show_paywall": not result.screening_flag,
        }
    response = render(request, "result.html", context)
    set_sid_cookie(response, sid, settings)
    return response
